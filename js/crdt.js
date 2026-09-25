// crdt.js — 纯逻辑模块：分数索引排序键 + LWW-Register 任务存储 + 操作(op)模型。
// 同时被 Web Worker (import) 和 Node 测试 (import) 使用，无任何浏览器依赖。

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;

// 在 a 与 b 之间生成一个字符串排序键（null 表示负/正无穷）。
// 键按字典序比较即得顺序。永远不会生成恰好等于 '0' 或 'z' 的键，
// 因此任意两个键之间总能继续插入。
function kb(a, b) {
  const ca = a ? ALPHABET.indexOf(a[0]) : -1;
  const cb = b ? ALPHABET.indexOf(b[0]) : BASE;
  if (cb - ca > 1) {
    let mid = ca + Math.floor((cb - ca) / 2);
    if (mid <= 0) {
      // 会生成边界键 '0'，改为向下深化：'0' + (< b 后缀)
      return ALPHABET[0] + kb(null, b ? b.slice(1) : null);
    }
    if (mid >= BASE - 1) {
      // 会生成边界键 'z'，改为沿用 a 的首字符并深化
      return ALPHABET[ca] + kb(a.slice(1), null);
    }
    return ALPHABET[mid];
  }
  // 间隙 <= 1，需要深化
  if (ca >= 0) {
    const upper = cb === ca ? (b ? b.slice(1) : null) : null;
    return ALPHABET[ca] + kb(a.slice(1), upper);
  }
  // a 为空（-inf），b 的首字符是 '0' 或 '1'
  const upper = cb === 0 ? (b ? b.slice(1) : null) : null;
  return ALPHABET[0] + kb(null, upper);
}

export function keyBetween(a, b) {
  if (a != null && b != null && !(a < b)) {
    throw new Error(`keyBetween: 需要 a < b，收到 ${a} , ${b}`);
  }
  return kb(a || null, b || null);
}

// ---- LWW 时钟比较：(lamport, tabId) 字典序 ----
export function compareClock(l1, t1, l2, t2) {
  if (l1 !== l2) return l1 - l2;
  return t1 < t2 ? -1 : t1 > t2 ? 1 : 0;
}

export const COLUMNS = ['todo', 'doing', 'done'];

function emptyTask(id) {
  return {
    id,
    title: { v: '', l: -1, t: '' },
    due: { v: null, l: -1, t: '' },
    loc: { v: { col: 'todo', order: '' }, l: -1, t: '' },
    deleted: { v: false, l: -1, t: '' },
  };
}

let idCounter = 0;
export function newTaskId(tabId) {
  idCounter = (idCounter + 1) % 0xffff;
  return `${tabId}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

// Store：任务集合的 CRDT（LWW-Map + 墓碑删除 + 分数索引排序）。
// 所有 op 满足交换律、结合律、幂等，因此乱序/重复/离线合并均收敛。
export class Store {
  constructor(tabId) {
    this.tabId = tabId;
    this.lamport = 0; // Lamport 时钟：仅用于 LWW 比较
    this.seq = 0;     // 本标签页连续序号：用于缺口检测与向量时钟
    this.tasks = new Map(); // id -> task record
    this.seen = new Set();  // 已应用的 opId
  }

  nextStamp() {
    this.lamport += 1;
    this.seq += 1;
    return { l: this.lamport, seq: this.seq };
  }

  // ---- 本地操作：生成 op（调用方负责 applyOp + 持久化 + 广播）----
  opAdd(id, title, col, order, due = null) {
    const { l, seq } = this.nextStamp();
    return { opId: `${this.tabId}:${seq}`, tab: this.tabId, l, seq, kind: 'add', id, title, col, order, due };
  }
  opSet(id, field, value) {
    const { l, seq } = this.nextStamp();
    return { opId: `${this.tabId}:${seq}`, tab: this.tabId, l, seq, kind: 'set', id, field, value };
  }
  opMove(id, col, order) {
    const { l, seq } = this.nextStamp();
    return { opId: `${this.tabId}:${seq}`, tab: this.tabId, l, seq, kind: 'move', id, col, order };
  }
  opDelete(id) {
    const { l, seq } = this.nextStamp();
    return { opId: `${this.tabId}:${seq}`, tab: this.tabId, l, seq, kind: 'del', id };
  }

  // ---- 应用任意来源的 op：幂等、可交换 ----
  applyOp(op) {
    if (this.seen.has(op.opId)) return false;
    this.seen.add(op.opId);
    if (op.l > this.lamport) this.lamport = op.l;
    let task = this.tasks.get(op.id);
    if (!task) {
      task = emptyTask(op.id);
      this.tasks.set(op.id, task);
    }
    const newer = (reg) => compareClock(op.l, op.tab, reg.l, reg.t) > 0;
    switch (op.kind) {
      case 'add':
        if (newer(task.title)) task.title = { v: op.title, l: op.l, t: op.tab };
        if (newer(task.due)) task.due = { v: op.due ?? null, l: op.l, t: op.tab };
        if (newer(task.loc)) task.loc = { v: { col: op.col, order: op.order }, l: op.l, t: op.tab };
        break;
      case 'set':
        if (op.field === 'title' && newer(task.title)) task.title = { v: op.value, l: op.l, t: op.tab };
        if (op.field === 'due' && newer(task.due)) task.due = { v: op.value ?? null, l: op.l, t: op.tab };
        break;
      case 'move':
        if (newer(task.loc)) task.loc = { v: { col: op.col, order: op.order }, l: op.l, t: op.tab };
        break;
      case 'del':
        if (newer(task.deleted)) task.deleted = { v: true, l: op.l, t: op.tab };
        break;
    }
    return true;
  }

  // 可见任务（未删除），按 (order, id) 排序——order 相同（并发同位插入）时按 id 确定性决胜
  getVisible() {
    const out = [];
    for (const t of this.tasks.values()) {
      if (t.deleted.v) continue;
      out.push({
        id: t.id,
        title: t.title.v,
        due: t.due.v,
        col: t.loc.v.col,
        order: t.loc.v.order,
      });
    }
    out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  // 确定性序列化，用于测试收敛性比较
  serialize() {
    const rows = [...this.tasks.values()].map((t) => ({
      id: t.id,
      title: t.title,
      due: t.due,
      loc: t.loc,
      deleted: t.deleted,
    }));
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    return JSON.stringify(rows);
  }
}
