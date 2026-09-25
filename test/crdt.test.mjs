// 收敛性测试：模拟 4 个标签页并发编辑、消息乱序、离线分区、删除/排序冲突。
// 运行：node test/crdt.test.mjs
import { Store, keyBetween, newTaskId } from '../js/crdt.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

// 模拟一个标签页：本地 Store + 待投递的出站 op 队列
class Tab {
  constructor(id) {
    this.id = id;
    this.store = new Store(id);
    this.log = [];      // 全部已知 op（等价于 Worker 中持久化的 op 日志）
    this.online = true;
  }
  local(op) {
    this.store.applyOp(op);
    this.log.push(op);
  }
  receive(op) {
    if (this.store.applyOp(op)) this.log.push(op);
  }
  add(title, col, order) { const id = newTaskId(this.id); this.local(this.store.opAdd(id, title, col, order)); return id; }
  set(id, field, value) { this.local(this.store.opSet(id, field, value)); }
  move(id, col, order) { this.local(this.store.opMove(id, col, order)); }
  del(id) { this.local(this.store.opDelete(id)); }
}

// 网络：反熵 gossip——每个在线 tab 把自己日志里对方没有的 op 乱序补发（等价于
// Worker 的 hello/have/need 协议：从持久化日志中按向量时钟差集发送）。
function syncAll(tabs, { shuffle = true, rounds = 2 } = {}) {
  for (let r = 0; r < rounds; r++) {
    const msgs = [];
    for (const t of tabs) {
      if (!t.online) continue;
      for (const op of t.log)
        for (const o of tabs)
          if (o !== t && o.online && !o.store.seen.has(op.opId)) msgs.push([o, op]);
    }
    if (shuffle) {
      for (let i = msgs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [msgs[i], msgs[j]] = [msgs[j], msgs[i]];
      }
    }
    for (const [tab, op] of msgs) tab.receive(op);
  }
}

function converged(tabs) {
  const s0 = tabs[0].store.serialize();
  return tabs.every((t) => t.store.serialize() === s0);
}

// ---------- 1. keyBetween 基本性质 ----------
console.log('1. 排序键');
{
  let prev = null;
  let ok = true;
  for (let i = 0; i < 5000; i++) {
    const k = keyBetween(prev, null);
    if (prev !== null && !(prev < k)) ok = false;
    prev = k;
  }
  check('5000 次末尾追加键严格递增', ok);
  const keys = new Set();
  let lo = null, hi = null;
  ok = true;
  for (let i = 0; i < 5000; i++) {
    const k = keyBetween(lo, hi);
    if (lo !== null && !(lo < k)) ok = false;
    if (hi !== null && !(k < hi)) ok = false;
    if (keys.has(k)) ok = false;
    keys.add(k);
    if (Math.random() < 0.5) lo = k; else hi = k;
  }
  check('5000 次随机区间插入键有序且唯一', ok);
}

// ---------- 2. 4 标签页并发编辑 + 完全乱序投递 → 收敛 ----------
console.log('2. 4 标签页并发 + 乱序');
{
  const tabs = [new Tab('tabA'), new Tab('tabB'), new Tab('tabC'), new Tab('tabD')];
  const cols = ['todo', 'doing', 'done'];
  const ids = [];
  // 并发添加（互不知道对方）
  for (let r = 0; r < 20; r++) {
    for (const t of tabs) {
      const col = cols[Math.floor(Math.random() * 3)];
      ids.push(t.add(`任务-${t.id}-${r}`, col, keyBetween(null, null)));
    }
  }
  // 并发移动/编辑/删除（基于各自本地视图，必然冲突）
  for (const t of tabs) {
    const visible = t.store.getVisible();
    for (let i = 0; i < 15; i++) {
      const victim = visible[Math.floor(Math.random() * visible.length)];
      if (!victim) continue;
      const kind = Math.floor(Math.random() * 3);
      if (kind === 0) t.set(victim.id, 'title', `改名by${t.id}`);
      else if (kind === 1) t.move(victim.id, cols[Math.floor(Math.random() * 3)], keyBetween(null, null));
      else t.del(victim.id);
    }
  }
  syncAll(tabs, { shuffle: true });
  check('并发+乱序后 4 个标签页状态一致', converged(tabs));
  // 再跑 5 轮“并发编辑 → 乱序同步”，模拟 5 分钟持续协作
  for (let round = 0; round < 5; round++) {
    for (const t of tabs) {
      const visible = t.store.getVisible();
      for (let i = 0; i < 10; i++) {
        const victim = visible[Math.floor(Math.random() * visible.length)];
        if (!victim) continue;
        const kind = Math.floor(Math.random() * 4);
        if (kind === 0) t.set(victim.id, 'title', `r${round}-by${t.id}`);
        else if (kind === 1) t.set(victim.id, 'due', '2026-10-01T10:00');
        else if (kind === 2) t.move(victim.id, cols[Math.floor(Math.random() * 3)], keyBetween(null, null));
        else t.del(victim.id);
      }
    }
    syncAll(tabs, { shuffle: true });
  }
  check('5 轮并发编辑后仍一致', converged(tabs));
  check('可见任务列表顺序一致',
    tabs.every((t) => JSON.stringify(t.store.getVisible()) === JSON.stringify(tabs[0].store.getVisible())));
}

// ---------- 3. 离线分区合并 ----------
console.log('3. 离线分区合并');
{
  const tabs = [new Tab('t1'), new Tab('t2'), new Tab('t3'), new Tab('t4')];
  const id = tabs[0].add('共同任务', 'todo', keyBetween(null, null));
  syncAll(tabs, { shuffle: false });
  // 分区：t1,t2 一组；t3,t4 一组；组间断网
  tabs[2].online = tabs[3].online = false; // 从 t1/t2 视角断网
  tabs[0].set(id, 'title', 'A组修改');
  tabs[1].move(id, 'done', keyBetween(null, null));
  syncAll(tabs); // 只有 t1,t2 互同步
  tabs[2].online = tabs[3].online = true;
  tabs[0].online = tabs[1].online = false;
  tabs[2].set(id, 'title', 'B组修改');
  tabs[3].del(id);
  tabs[3].add('B组新任务', 'doing', keyBetween(null, null));
  syncAll(tabs); // 只有 t3,t4 互同步
  tabs[0].online = tabs[1].online = true;
  // 恢复：全量反熵（等价于 hello/have 后互发缺失 op），乱序投递
  syncAll(tabs, { shuffle: true });
  check('分区恢复后 4 个标签页收敛', converged(tabs));
  const del = tabs[0].store.tasks.get(id).deleted;
  check('删除冲突按 LWW 确定性解决（各页一致）',
    tabs.every((t) => t.store.tasks.get(id).deleted.v === del.v));
}

// ---------- 4. 删除 vs 编辑冲突（同一任务，并发）----------
console.log('4. 删除 vs 编辑冲突');
{
  const run = (delFirst) => {
    const a = new Tab('a'), b = new Tab('b');
    const id = a.add('X', 'todo', keyBetween(null, null));
    syncAll([a, b], { shuffle: false });
    a.del(id);
    b.set(id, 'title', '并发编辑');
    const ops = [a.log[a.log.length - 1], b.log[b.log.length - 1]];
    if (!delFirst) ops.reverse();
    for (const op of ops) { a.store.applyOp(op); b.store.applyOp(op); }
    return { a, b, id };
  };
  const r1 = run(true), r2 = run(false);
  check('每种投递顺序下两页各自收敛',
    r1.a.store.serialize() === r1.b.store.serialize()
    && r2.a.store.serialize() === r2.b.store.serialize());
  check('两种投递顺序的最终结论一致（删除标记一致）',
    r1.a.store.tasks.get(r1.id).deleted.v === r2.a.store.tasks.get(r2.id).deleted.v
    && r1.a.store.tasks.get(r1.id).title.v === r2.a.store.tasks.get(r2.id).title.v);
}

// ---------- 5. 排序冲突：并发把不同任务插到同一位置 ----------
console.log('5. 排序冲突');
{
  const a = new Tab('a'), b = new Tab('b');
  const base = a.add('基准', 'todo', keyBetween(null, null));
  syncAll([a, b], { shuffle: false });
  const baseOrder = a.store.tasks.get(base).loc.v.order;
  // 双方同时在“基准”之后插入不同任务（用相同的邻键）
  const idA = a.add('A的任务', 'todo', keyBetween(baseOrder, null));
  const idB = b.add('B的任务', 'todo', keyBetween(baseOrder, null));
  syncAll([a, b], { shuffle: true });
  check('并发同位插入后收敛', converged([a, b]));
  const vis = a.store.getVisible().map((t) => t.id);
  check('两个任务都可见且顺序确定', vis.includes(idA) && vis.includes(idB) && vis.length === 3);
}

// ---------- 6. 移动冲突：同一任务被并发拖到不同列 ----------
console.log('6. 移动冲突');
{
  const a = new Tab('a'), b = new Tab('b');
  const id = a.add('被抢的任务', 'todo', keyBetween(null, null));
  syncAll([a, b], { shuffle: false });
  a.move(id, 'doing', keyBetween(null, null));
  b.move(id, 'done', keyBetween(null, null));
  const ops = [a.log[a.log.length - 1], b.log[b.log.length - 1]];
  for (const op of ops.reverse()) { a.store.applyOp(op); b.store.applyOp(op); } // 逆序投递
  check('并发移动后收敛', converged([a, b]));
  const col = a.store.tasks.get(id).loc.v.col;
  check('任务只出现在一个列', ['todo', 'doing', 'done'].includes(col)
    && a.store.getVisible().filter((t) => t.id === id).length === 1);
}

// ---------- 7. 重复投递幂等 ----------
console.log('7. 幂等');
{
  const a = new Tab('a'), b = new Tab('b');
  const id = a.add('重复', 'todo', keyBetween(null, null));
  a.set(id, 'title', '改');
  for (let i = 0; i < 3; i++) for (const op of a.log) b.receive(op); // 重复投递 3 遍
  check('重复投递不改变结果', b.store.serialize() === a.store.serialize());
}

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
