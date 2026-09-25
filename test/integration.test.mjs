// 集成测试：在 Node 中驱动真实的 js/worker.js（4 个后端实例 = 4 个标签页）。
// 共享内存版 IndexedDB（模拟同源共享存储）+ 随机延迟的 BroadcastChannel（制造乱序）。
// 运行：node test/integration.test.mjs
import { createBackend } from '../js/worker.js';
import { keyBetween } from '../js/crdt.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 内存版 IndexedDB（单例 = 同源共享） ----------
function reqOf(fn) {
  const req = {};
  setTimeout(() => {
    try { req.result = fn(); req.onsuccess && req.onsuccess(); }
    catch (e) { req.error = e; req.onerror && req.onerror(); }
  }, 0);
  return req;
}
class FakeIDB {
  constructor() { this.stores = new Map(); }
  open() {
    const req = {};
    const stores = this.stores;
    const db = {
      createObjectStore: (n) => { if (!stores.has(n)) stores.set(n, new Map()); },
      transaction: (sn) => ({
        objectStore: () => ({
          get: (k) => reqOf(() => stores.get(sn).get(k)),
          put: (v, k) => reqOf(() => { stores.get(sn).set(k, v); }),
          getAll: () => reqOf(() => [...stores.get(sn).values()]),
        }),
      }),
    };
    req.result = db;
    setTimeout(() => { req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); }, 0);
    return req;
  }
}
const sharedIDB = new FakeIDB();

// ---------- 随机延迟 0~40ms 的 BroadcastChannel（制造消息乱序） ----------
class ShuffleBC {
  static all = new Set();
  constructor(name) { this.name = name; this.onmessage = null; ShuffleBC.all.add(this); }
  postMessage(msg) {
    for (const other of ShuffleBC.all) {
      if (other === this || other.name !== this.name) continue;
      const m = structuredClone(msg);
      setTimeout(() => other.onmessage && other.onmessage({ data: m }), Math.random() * 40);
    }
  }
  close() { ShuffleBC.all.delete(this); }
}

// ---------- 标签页模拟 ----------
const intervals = [];
class TabPage {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.lastState = null;
    this.backend = createBackend({
      postMessage: (m) => { this.inbox.push(m); if (m.t === 'state') this.lastState = m; },
      indexedDB: sharedIDB,
      crypto: globalThis.crypto,
      BroadcastChannel: ShuffleBC,
      setIntervalFn: (fn, ms) => { const id = setInterval(fn, ms); intervals.push(id); return id; },
    });
  }
  send(msg) { return this.backend.handleMessage(msg); }
  async op(op) { await this.send({ t: 'op', op }); }
  async waitFor(pred, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(20);
    }
    return false;
  }
}

const PW = '正确的密码 horse battery staple';

console.log('A. 初始化与解锁');
const tabs = [new TabPage('T1'), new TabPage('T2'), new TabPage('T3'), new TabPage('T4')];
for (const t of tabs) await t.send({ t: 'init' });
await sleep(50);

// 错误密码 → unlock-fail（此时还没有保险库，先建一个错误密码的临时页验证不了，先正确建库）
await tabs[0].send({ t: 'unlock', password: PW });
check('首个标签页解锁成功', await tabs[0].waitFor(() => tabs[0].inbox.some((m) => m.t === 'unlock-ok')));

const wrongTab = new TabPage('T-wrong');
await wrongTab.send({ t: 'init' });
await sleep(30);
await wrongTab.send({ t: 'unlock', password: '错误密码' });
check('错误主密码被拒绝并提示', await wrongTab.waitFor(() => wrongTab.inbox.some((m) => m.t === 'unlock-fail')));

for (const t of tabs.slice(1)) await t.send({ t: 'unlock', password: PW });
for (const t of tabs) check(`${t.name} 解锁`, await t.waitFor(() => t.inbox.some((m) => m.t === 'unlock-ok')));
await sleep(200);

console.log('B. 并发编辑 + 乱序同步（模拟 5 分钟协作的压缩版）');
const cols = ['todo', 'doing', 'done'];
const mkOrder = () => keyBetween(null, null);
const t0 = Date.now();
let latencySamples = [];
for (let round = 0; round < 12; round++) {
  await Promise.all(tabs.map(async (tab, ti) => {
    for (let i = 0; i < 6; i++) {
      const kind = (round + i + ti) % 5;
      const vis = tab.lastState ? tab.lastState.tasks : [];
      const victim = vis[Math.floor(Math.random() * vis.length)];
      const mark = `r${round}-${tab.name}-${i}`;
      if (kind === 0 || !victim) {
        await tab.op({ kind: 'add', id: `task-${mark}`, title: `任务 ${mark}`, col: cols[(round + i) % 3], order: mkOrder(), due: null });
      } else if (kind === 1) {
        await tab.op({ kind: 'set', id: victim.id, field: 'title', value: `改名 ${mark}` });
      } else if (kind === 2) {
        await tab.op({ kind: 'set', id: victim.id, field: 'due', value: '2026-10-01T09:00' });
      } else if (kind === 3) {
        await tab.op({ kind: 'move', id: victim.id, col: cols[(round + ti) % 3], order: mkOrder() });
      } else {
        await tab.op({ kind: 'del', id: victim.id });
      }
    }
  }));
  await sleep(60);
}
// 测量同步延迟：T1 发一个 op，等 T4 状态里出现
{
  const before = Date.now();
  await tabs[0].op({ kind: 'add', id: 'latency-probe', title: '延迟探针', col: 'todo', order: mkOrder(), due: null });
  const ok = await tabs[3].waitFor(() => tabs[3].lastState && tabs[3].lastState.tasks.some((x) => x.id === 'latency-probe'), 2000);
  const lat = Date.now() - before;
  latencySamples.push(lat);
  check(`同步延迟 ${lat}ms < 200ms`, ok && lat < 200);
}
const settled = await tabs[0].waitFor(() => {
  const sig = JSON.stringify(tabs[0].lastState?.tasks);
  return tabs.every((t) => JSON.stringify(t.lastState?.tasks) === sig);
}, 8000);
check('12 轮并发编辑后 4 个标签页任务一致', settled,
  settled ? '' : tabs.map((t) => `${t.name}:${t.lastState?.tasks?.length}`).join(' '));

console.log('C. 离线操作 → 恢复后自动合并');
await tabs[2].send({ t: 'set-offline', offline: true });
await tabs[3].send({ t: 'set-offline', offline: true });
await sleep(50);
// 离线两页各自操作
await tabs[2].op({ kind: 'add', id: 'offline-t3', title: 'T3离线新增', col: 'doing', order: mkOrder(), due: null });
await tabs[3].op({ kind: 'add', id: 'offline-t4', title: 'T4离线新增', col: 'done', order: mkOrder(), due: null });
await tabs[3].op({ kind: 'set', id: 'latency-probe', field: 'title', value: '离线改名' });
// 在线页同时操作（冲突：删同一个任务）
await tabs[0].op({ kind: 'del', id: 'latency-probe' });
await tabs[1].op({ kind: 'add', id: 'online-t1', title: 'T1在线新增', col: 'todo', order: mkOrder(), due: null });
await sleep(200);
const onlineSig = JSON.stringify(tabs[0].lastState.tasks);
check('分区期间在线两页一致', JSON.stringify(tabs[1].lastState.tasks) === onlineSig);
check('离线页看不到在线新增', !tabs[2].lastState.tasks.some((x) => x.id === 'online-t1'));
// 恢复
await tabs[2].send({ t: 'set-offline', offline: false });
await tabs[3].send({ t: 'set-offline', offline: false });
const merged = await tabs[0].waitFor(() => {
  const sig = JSON.stringify(tabs[0].lastState?.tasks);
  return tabs.every((t) => JSON.stringify(t.lastState?.tasks) === sig)
    && tabs[0].lastState.tasks.some((x) => x.id === 'offline-t3')
    && tabs[0].lastState.tasks.some((x) => x.id === 'offline-t4')
    && tabs[0].lastState.tasks.some((x) => x.id === 'online-t1');
}, 8000);
check('恢复后自动合并，四方一致且包含双方操作', merged);
const probe = tabs[0].lastState.tasks.find((x) => x.id === 'latency-probe');
check('删除 vs 离线改名冲突按 LWW 确定性解决（四方一致）',
  tabs.every((t) => JSON.stringify(t.lastState.tasks.find((x) => x.id === 'latency-probe') ?? null)
    === JSON.stringify(probe ?? null)));

console.log('D. 加密持久化 + 刷新后可解');
const rawOps = [...sharedIDB.stores.get('ops').values()];
check('IDB 中的 op 全部为密文信封（iv+ct）',
  rawOps.length > 0 && rawOps.every((e) => typeof e.iv === 'string' && typeof e.ct === 'string'));
const rawText = JSON.stringify(rawOps);
check('密文中不含明文任务标题', !rawText.includes('T3离线新增') && !rawText.includes('延迟探针'));
// 模拟刷新：新建页面（同库）用正确密码解锁
const reload = new TabPage('T-reload');
await reload.send({ t: 'init' });
await sleep(30);
await reload.send({ t: 'unlock', password: PW });
const reloadOk = await reload.waitFor(() => reload.lastState && reload.lastState.tasks.length > 0, 5000);
check('刷新后凭主密码可解密并恢复全部任务', reloadOk
  && JSON.stringify(reload.lastState.tasks) === JSON.stringify(tabs[0].lastState.tasks));

console.log('E. 标签页关闭');
await tabs[1].send({ t: 'page-hide' });
check('关闭通知不报错', true);

intervals.forEach(clearInterval);
console.log(failures === 0 ? '\n集成测试全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
