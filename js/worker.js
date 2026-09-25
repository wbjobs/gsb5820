// worker.js — 同步后端：密钥派生、AES-GCM 加解密、IndexedDB 持久化、
// BroadcastChannel 同步、反熵修复、乱序缓冲。主线程只做渲染。
// 以工厂形式导出，浏览器中作为 module worker 运行，测试中可在 Node 里多实例驱动。
import { Store } from './crdt.js';

const DB_NAME = 'kanban-enc-v1';
const CH_NAME = 'kanban-sync-v1';
const MAGIC = 'kanban-verify-v1';
const PBKDF2_ITER = 250000;
const HEARTBEAT_MS = 4000;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createBackend(env) {
  const { postMessage, indexedDB, crypto, BroadcastChannel, setIntervalFn } = env;

  let db = null;
  let bc = null;
  let store = null;
  let cryptoKey = null;
  let tabId = null;
  let unlocked = false;
  let offline = false;
  let expected = {};        // tab -> 已连续应用的 seq
  let pending = new Map();  // tab -> Map(seq -> op) 乱序缓冲
  let knownOps = new Map(); // opId -> op（内存明文日志，避免反熵时反复解密 IDB）
  let decryptErrors = 0;
  let stateTimer = null;

  // ---------- IndexedDB ----------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta');
        req.result.createObjectStore('ops'); // key = opId, value = 加密信封
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const idbGet = (storeName, key) =>
    new Promise((res, rej) => {
      const r = db.transaction(storeName).objectStore(storeName).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const idbPut = (storeName, key, val) =>
    new Promise((res, rej) => {
      const r = db.transaction(storeName, 'readwrite').objectStore(storeName).put(val, key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  const idbAll = (storeName) =>
    new Promise((res, rej) => {
      const r = db.transaction(storeName).objectStore(storeName).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });

  // ---------- 加解密 ----------
  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function encryptObj(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decryptObj(env_) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env_.iv) }, cryptoKey, unb64(env_.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---------- 状态推送（合并到下一帧，避免刷屏） ----------
  function scheduleState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      postMessage({ t: 'state', tasks: store.getVisible(), offline, decryptErrors });
    }, 16);
  }

  // ---------- op 处理 ----------
  async function persistOp(op) {
    const env_ = await encryptObj(op);
    await idbPut('ops', op.opId, env_);
  }

  function noteContiguous(op) {
    const from = op.tab;
    if (expected[from] === undefined) expected[from] = 0;
    if (op.seq === expected[from] + 1) {
      expected[from] = op.seq;
      const buf = pending.get(from);
      if (buf) {
        let next = expected[from] + 1;
        while (buf.has(next)) {
          const buffered = buf.get(next);
          buf.delete(next);
          store.applyOp(buffered);
          expected[from] = next;
          next += 1;
        }
        if (buf.size === 0) pending.delete(from);
      }
      return true;
    }
    return false;
  }

  async function handleIncomingOp(op, { persist = true } = {}) {
    // 用 knownOps 去重（含乱序缓冲中的 op），否则重复的缓冲 op 会反复触发 need 请求
    if (knownOps.has(op.opId)) return;
    knownOps.set(op.opId, op);
    if (persist) await persistOp(op); // 先持久化，乱序缓冲的 op 也不能因刷新丢失
    const from = op.tab;
    const exp = expected[from] ?? 0;
    if (op.seq > exp + 1) {
      // 乱序/缺漏：先缓冲，并请求缺失的 op
      if (!pending.has(from)) pending.set(from, new Map());
      pending.get(from).set(op.seq, op);
      requestMissing(from, exp + 1);
      return;
    }
    store.applyOp(op);
    noteContiguous(op);
    scheduleState();
  }

  function requestMissing(tab, fromLamport) {
    if (offline || !bc) return;
    bc.postMessage({ v: 1, t: 'need', tab, from: fromLamport, want: tabId });
  }

  async function broadcastOp(op) {
    if (offline || !bc) return;
    const env_ = await encryptObj(op);
    bc.postMessage({ v: 1, t: 'op', env: env_ });
  }

  function buildOp(intent) {
    switch (intent.kind) {
      case 'add': return store.opAdd(intent.id, intent.title, intent.col, intent.order, intent.due ?? null);
      case 'set': return store.opSet(intent.id, intent.field, intent.value);
      case 'move': return store.opMove(intent.id, intent.col, intent.order);
      case 'del': return store.opDelete(intent.id);
    }
    throw new Error(`未知操作: ${intent.kind}`);
  }

  async function localOp(intent) {
    const op = buildOp(intent);
    store.applyOp(op);
    knownOps.set(op.opId, op);
    noteContiguous(op);
    await persistOp(op);
    await broadcastOp(op);
    scheduleState();
  }

  // ---------- 反熵：hello / have / need / ops ----------
  function vectorClock() {
    return { ...expected };
  }
  function broadcastHave(kind) {
    if (offline || !bc) return;
    bc.postMessage({ v: 1, t: kind, from: tabId, vc: vectorClock() });
  }
  async function sendOpsTo(tab, fromLamport) {
    const batch = [...knownOps.values()].filter((op) => op.tab === tab && op.seq >= fromLamport);
    if (batch.length && !offline && bc) {
      bc.postMessage({ v: 1, t: 'ops', env: await encryptObj(batch) });
    }
  }
  async function sendMissingFor(theirVc) {
    const batch = [...knownOps.values()].filter((op) => op.seq > (theirVc[op.tab] ?? 0));
    if (batch.length && !offline && bc) {
      bc.postMessage({ v: 1, t: 'ops', env: await encryptObj(batch) });
    }
  }

  async function onChannelMessage(ev) {
    const msg = ev.data;
    if (!msg || msg.v !== 1 || !unlocked) return;
    if (offline) return; // 离线模式：丢弃即模拟网络分区，恢复后靠反熵补齐
    try {
      switch (msg.t) {
        case 'op': {
          const op = await decryptObj(msg.env);
          await handleIncomingOp(op);
          break;
        }
        case 'ops': {
          const batch = await decryptObj(msg.env);
          for (const op of batch) await handleIncomingOp(op);
          break;
        }
        case 'hello':
        case 'have': {
          if (msg.from === tabId) return;
          // 双向反熵：把对方缺的发过去，同时请求自己缺的
          await sendMissingFor(msg.vc || {});
          for (const [tab, l] of Object.entries(msg.vc || {})) {
            const mine = expected[tab] ?? 0;
            if (l > mine) requestMissing(tab, mine + 1);
          }
          break;
        }
        case 'need': {
          await sendOpsTo(msg.tab, msg.from);
          break;
        }
      }
    } catch (err) {
      reportDecryptError();
    }
  }

  let lastDecryptReport = 0;
  function reportDecryptError() {
    decryptErrors += 1;
    const now = Date.now();
    if (now - lastDecryptReport > 1000) {
      lastDecryptReport = now;
      postMessage({ t: 'decrypt-error', count: decryptErrors });
    }
  }

  // ---------- 解锁 / 初始化 ----------
  async function init() {
    db = await openDb();
    tabId = crypto.randomUUID();
    bc = new BroadcastChannel(CH_NAME);
    bc.onmessage = onChannelMessage;
    const salt = await idbGet('meta', 'salt');
    postMessage({ t: 'boot', hasVault: !!salt });
  }

  async function unlock(password) {
    let salt = await idbGet('meta', 'salt');
    let firstRun = false;
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16));
      await idbPut('meta', 'salt', b64(salt));
      firstRun = true;
    } else {
      salt = unb64(salt);
    }
    cryptoKey = await deriveKey(password, salt);
    if (firstRun) {
      const verify = await encryptObj({ magic: MAGIC });
      await idbPut('meta', 'verify', verify);
    } else {
      const verify = await idbGet('meta', 'verify');
      try {
        const obj = await decryptObj(verify);
        if (obj.magic !== MAGIC) throw new Error('bad magic');
      } catch {
        cryptoKey = null;
        postMessage({ t: 'unlock-fail' });
        return;
      }
    }
    // 重放本地持久化的 op 日志（离线期间的操作也在这里）
    store = new Store(tabId);
    expected = {};
    knownOps = new Map();
    const all = await idbAll('ops');
    const ops = [];
    for (const env_ of all) {
      try {
        ops.push(await decryptObj(env_));
      } catch { /* 跳过损坏条目 */ }
    }
    ops.sort((a, b) => (a.seq - b.seq) || (a.tab < b.tab ? -1 : 1));
    for (const op of ops) {
      store.applyOp(op);
      knownOps.set(op.opId, op);
      const exp = expected[op.tab] ?? 0;
      if (op.seq === exp + 1) expected[op.tab] = op.seq;
      else if (op.seq > exp + 1) {
        if (!pending.has(op.tab)) pending.set(op.tab, new Map());
        pending.get(op.tab).set(op.seq, op);
      }
    }
    unlocked = true;
    postMessage({ t: 'unlock-ok' });
    scheduleState();
    broadcastHave('hello');
    setIntervalFn(() => broadcastHave('have'), HEARTBEAT_MS);
  }

  async function handleMessage(msg) {
    try {
      switch (msg.t) {
        case 'init': await init(); break;
        case 'unlock': await unlock(msg.password); break;
        case 'op': if (unlocked) await localOp(msg.op); break;
        case 'set-offline':
          offline = msg.offline;
          if (!offline && unlocked) broadcastHave('hello'); // 恢复上线：触发双向补齐
          scheduleState();
          break;
        case 'page-hide':
          if (unlocked && bc) bc.postMessage({ v: 1, t: 'have', from: tabId, vc: vectorClock() });
          break;
      }
    } catch (err) {
      postMessage({ t: 'error', message: String((err && err.message) || err) });
    }
  }

  return { handleMessage };
}

// ---------- 浏览器 module worker 入口 ----------
if (typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope) {
  const backend = createBackend({
    postMessage: (m) => self.postMessage(m),
    indexedDB: self.indexedDB,
    crypto: self.crypto,
    BroadcastChannel: self.BroadcastChannel,
    setIntervalFn: setInterval,
  });
  self.onmessage = (ev) => backend.handleMessage(ev.data);
}
