// CRDT core: per-field last-writer-wins map with hybrid logical clocks,
// tombstone deletes, and dense fractional position keys.
// Pure ESM — runs in the browser and in Node (for convergence tests).

// ---------- Hybrid Logical Clock ----------

export function compareHlc(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.n === b.n) return 0;
  return a.n < b.n ? -1 : 1;
}

export function hlcToString(h) {
  return h.t.toString(36) + '.' + h.c.toString(36) + '.' + h.n;
}

export function hlcFromString(s) {
  const dot1 = s.indexOf('.');
  const dot2 = s.indexOf('.', dot1 + 1);
  return {
    t: parseInt(s.slice(0, dot1), 36),
    c: parseInt(s.slice(dot1 + 1, dot2), 36),
    n: s.slice(dot2 + 1),
  };
}

export class Clock {
  constructor(node) {
    this.node = node;
    this.t = 0;
    this.c = 0;
  }
  now() {
    const pt = Date.now();
    if (pt > this.t) {
      this.t = pt;
      this.c = 0;
    } else {
      this.c += 1;
    }
    return { t: this.t, c: this.c, n: this.node };
  }
  receive(h) {
    const pt = Date.now();
    const mt = Math.max(this.t, h.t, pt);
    if (mt === this.t && mt === h.t) this.c = Math.max(this.c, h.c) + 1;
    else if (mt === this.t) this.c += 1;
    else if (mt === h.t) this.c = h.c + 1;
    else this.c = 0;
    this.t = mt;
  }
}

// ---------- Dense fractional position keys ----------
// Keys are base-62 strings compared digit-by-digit with MID padding,
// so between any two keys there is always another key.

const ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MID = 31;
const MAXD = 61;

function digitAt(s, i) {
  return i < s.length ? ALPH.indexOf(s[i]) : MID;
}

export function compareKeys(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = digitAt(a, i) - digitAt(b, i);
    if (d !== 0) return d;
  }
  return 0;
}

// Returns a key k with a < k < b (either bound may be null = open ended).
export function keyBetween(a, b) {
  let res = '';
  let upperOpen = b === null;
  for (let i = 0; ; i++) {
    const lo = a === null ? 0 : digitAt(a, i);
    const hi = upperOpen ? MAXD : digitAt(b, i);
    if (hi - lo >= 2) return res + ALPH[(lo + hi) >> 1];
    res += ALPH[lo];
    if (hi - lo === 1) upperOpen = true; // tail only constrained below
  }
}

// ---------- Board CRDT ----------
// Task record: { id, del: hlcStr|null, fields: { name: { v, h: hlcStr } } }
// Op (serializable):
//   { k: 'put', id, f: { field: value }, h: hlcStr }
//   { k: 'del', id, h: hlcStr }
// Merge rule per field / tombstone: higher HLC wins. Applying the same op
// set in any order, any number of times, converges to the same state.

export class Board {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.clock = new Clock(nodeId);
    this.tasks = new Map();
  }

  _get(id) {
    let t = this.tasks.get(id);
    if (!t) {
      t = { id, del: null, fields: {} };
      this.tasks.set(id, t);
    }
    return t;
  }

  // Apply a remote or local op. Returns true if visible state changed.
  applyOp(op) {
    const h = hlcFromString(op.h);
    this.clock.receive(h);
    let changed = false;
    if (op.k === 'put') {
      const t = this._get(op.id);
      for (const name of Object.keys(op.f)) {
        const cur = t.fields[name];
        if (!cur || compareHlc(h, hlcFromString(cur.h)) > 0) {
          t.fields[name] = { v: op.f[name], h: op.h };
          changed = true;
        }
      }
    } else if (op.k === 'del') {
      const t = this._get(op.id);
      if (!t.del || compareHlc(h, hlcFromString(t.del)) > 0) {
        t.del = op.h;
        changed = true;
      }
    }
    return changed;
  }

  applyOps(ops) {
    let changed = false;
    for (const op of ops) changed = this.applyOp(op) || changed;
    return changed;
  }

  _bump() {
    return hlcToString(this.clock.now());
  }

  put(id, fields) {
    const op = { k: 'put', id, f: fields, h: this._bump() };
    this.applyOp(op);
    return op;
  }

  create(fields) {
    const id = this.nodeId + ':' + hlcToString(this.clock.now()) + ':' +
      Math.random().toString(36).slice(2, 8);
    return { id, op: this.put(id, fields) };
  }

  del(id) {
    const op = { k: 'del', id, h: this._bump() };
    this.applyOp(op);
    return op;
  }

  isVisible(t) {
    let maxH = null;
    for (const name of Object.keys(t.fields)) {
      const h = t.fields[name].h;
      if (!maxH || compareHlc(hlcFromString(h), hlcFromString(maxH)) > 0) maxH = h;
    }
    if (!maxH) return false;
    if (!t.del) return true;
    return compareHlc(hlcFromString(maxH), hlcFromString(t.del)) > 0;
  }

  get(id) {
    const t = this.tasks.get(id);
    if (!t || !this.isVisible(t)) return null;
    const out = { id: t.id };
    for (const name of Object.keys(t.fields)) out[name] = t.fields[name].v;
    return out;
  }

  // Visible tasks of a column, ordered by (position key, id) — the id
  // tiebreak makes concurrent inserts at the same position deterministic.
  column(col) {
    const out = [];
    for (const t of this.tasks.values()) {
      if (!this.isVisible(t)) continue;
      if (!t.fields.col || t.fields.col.v !== col) continue;
      const task = { id: t.id };
      for (const name of Object.keys(t.fields)) task[name] = t.fields[name].v;
      out.push(task);
    }
    out.sort((x, y) => compareKeys(x.pos || '', y.pos || '') || (x.id < y.id ? -1 : 1));
    return out;
  }

  // Deterministic snapshot of visible state (for tests / debugging).
  snapshot() {
    const rows = [];
    for (const t of this.tasks.values()) {
      if (!this.isVisible(t)) continue;
      const row = { id: t.id };
      for (const name of Object.keys(t.fields)) row[name] = t.fields[name].v;
      rows.push(row);
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    return rows;
  }
}
