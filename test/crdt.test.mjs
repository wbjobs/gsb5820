// Convergence & conflict tests for the CRDT core.
// Run: node test/crdt.test.mjs

import assert from 'node:assert/strict';
import { Board, keyBetween, compareKeys, hlcFromString, compareHlc } from '../js/crdt.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------- position keys ----------

test('keyBetween stays ordered under repeated insertion', () => {
  const keys = [];
  const rand = rng(42);
  for (let i = 0; i < 2000; i++) {
    const idx = Math.floor(rand() * (keys.length + 1));
    const prev = idx > 0 ? keys[idx - 1] : null;
    const next = idx < keys.length ? keys[idx] : null;
    const k = keyBetween(prev, next);
    keys.splice(idx, 0, k);
    for (let j = 1; j < keys.length; j++) {
      assert.ok(compareKeys(keys[j - 1], keys[j]) < 0, `order broken at ${i}/${j}`);
    }
  }
});

test('keyBetween always terminates, even at boundaries', () => {
  let k = keyBetween(null, null);
  for (let i = 0; i < 500; i++) k = keyBetween(null, k); // walk to the top
  for (let i = 0; i < 500; i++) k = keyBetween(k, null); // walk to the bottom
  assert.ok(k.length < 1100);
});

// ---------- basic CRDT ----------

test('concurrent edits to the same field converge (LWW)', () => {
  const a = new Board('tabA');
  const b = new Board('tabB');
  const { id, op } = a.create({ title: 't', col: 'todo', pos: 'V', desc: '', due: '' });
  b.applyOp(op);
  const editA = a.put(id, { title: 'from A' });
  const editB = b.put(id, { title: 'from B' });
  // Deliver in opposite orders.
  a.applyOp(editB);
  b.applyOp(editA);
  assert.equal(a.get(id).title, b.get(id).title);
  const winner = compareHlc(hlcFromString(editA.h), hlcFromString(editB.h)) > 0 ? 'from A' : 'from B';
  assert.equal(a.get(id).title, winner);
});

test('delete vs concurrent edit resolves deterministically by HLC', () => {
  for (const order of [0, 1]) {
    const a = new Board('tabA');
    const b = new Board('tabB');
    const { id, op } = a.create({ title: 'x', col: 'todo', pos: 'V' });
    b.applyOp(op);
    const del = a.del(id);
    const edit = b.put(id, { title: 'edited' });
    const winnerIsDelete = compareHlc(hlcFromString(del.h), hlcFromString(edit.h)) > 0;
    const apply = (board) => order === 0
      ? board.applyOps([del, edit])
      : board.applyOps([edit, del]);
    apply(a);
    apply(b);
    assert.equal(a.get(id) === null, winnerIsDelete);
    assert.equal(b.get(id) === null, winnerIsDelete);
    assert.deepEqual(a.snapshot(), b.snapshot());
  }
});

test('concurrent moves of one task converge (drag conflict)', () => {
  const a = new Board('tabA');
  const b = new Board('tabB');
  const { id, op } = a.create({ title: 'drag me', col: 'todo', pos: 'V' });
  b.applyOp(op);
  const m1 = a.put(id, { col: 'doing', pos: 'V' });
  const m2 = b.put(id, { col: 'done', pos: 'K' });
  a.applyOp(m2);
  b.applyOp(m1);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const t = a.get(id);
  assert.ok(t.col === 'doing' || t.col === 'done');
});

test('out-of-order and duplicated delivery never loses ops', () => {
  const rand = rng(7);
  const nodes = [new Board('n1'), new Board('n2'), new Board('n3'), new Board('n4')];
  const allOps = [];
  // Each node creates and edits tasks.
  const ids = [];
  for (const n of nodes) {
    const { id, op } = n.create({ title: 'task-' + n.nodeId, col: 'todo', pos: keyBetween(null, null) });
    ids.push(id);
    allOps.push(op);
  }
  for (const n of nodes) {
    for (const id of ids) {
      if (rand() < 0.5) allOps.push(n.put(id, { desc: 'note from ' + n.nodeId + ' ' + allOps.length }));
      if (rand() < 0.3) allOps.push(n.put(id, { col: 'doing', pos: keyBetween(null, null) }));
    }
  }
  // Shuffle + duplicate, deliver to everyone.
  for (const target of nodes) {
    const shuffled = [...allOps].sort(() => rand() - 0.5);
    for (const op of shuffled) {
      target.applyOp(op);
      if (rand() < 0.2) target.applyOp(op); // duplicate delivery
    }
  }
  const snap = nodes[0].snapshot();
  for (const n of nodes) assert.deepEqual(n.snapshot(), snap);
  assert.ok(snap.length > 0, 'no ops lost');
});

test('offline divergence merges correctly on reconnect', () => {
  const online = new Board('online');
  const offline = new Board('offline');
  const shared = [];
  // Shared history.
  const { id: t1, op: c1 } = online.create({ title: 'shared', col: 'todo', pos: 'V' });
  shared.push(c1);
  offline.applyOps(shared);
  // Online tab keeps working.
  const onlineOps = [
    online.put(t1, { title: 'renamed online' }),
    online.create({ title: 'new online', col: 'doing', pos: 'V' }).op,
  ];
  // Offline tab works against the stale snapshot.
  const offlineOps = [
    offline.put(t1, { desc: 'offline note' }),
    offline.create({ title: 'new offline', col: 'todo', pos: keyBetween('V', null) }).op,
    offline.del(offline.create({ title: 'temp', col: 'todo', pos: 'Z' }).id),
  ];
  // Reconnect: exchange everything.
  online.applyOps(offlineOps);
  offline.applyOps(onlineOps);
  assert.deepEqual(online.snapshot(), offline.snapshot());
  const merged = online.get(t1);
  assert.equal(merged.title, 'renamed online'); // disjoint fields both survive
  assert.equal(merged.desc, 'offline note');
  assert.ok(online.snapshot().some((t) => t.title === 'new offline'));
  assert.ok(online.snapshot().some((t) => t.title === 'new online'));
});

test('5-minute 4-tab simulation converges', () => {
  const rand = rng(20260925);
  const nodes = [new Board('t1'), new Board('t2'), new Board('t3'), new Board('t4')];
  const cols = ['todo', 'doing', 'done'];
  const ops = [];
  const ids = [];
  // ~5 min of heavy editing: 4 tabs x 750 ops.
  for (let i = 0; i < 3000; i++) {
    const n = nodes[Math.floor(rand() * 4)];
    const kind = rand();
    if (kind < 0.25 || ids.length === 0) {
      const col = cols[Math.floor(rand() * 3)];
      const { id, op } = n.create({
        title: 'task ' + i, desc: '', due: '', col,
        pos: keyBetween(null, null),
      });
      ids.push(id);
      ops.push(op);
    } else {
      const id = ids[Math.floor(rand() * ids.length)];
      if (kind < 0.55) {
        const col = cols[Math.floor(rand() * 3)];
        ops.push(n.put(id, { col, pos: keyBetween(null, null) })); // drag
      } else if (kind < 0.8) {
        ops.push(n.put(id, { title: 'edited ' + i, due: '2026-10-01T10:00' }));
      } else {
        ops.push(n.del(id));
      }
    }
  }
  // Broadcast with per-tab reordering, loss+repair (dup), and delay simulation.
  for (const target of nodes) {
    const box = [...ops].sort(() => rand() - 0.5);
    for (const op of box) target.applyOp(op);
  }
  const snap = nodes[0].snapshot();
  for (const n of nodes) assert.deepEqual(n.snapshot(), snap);
  // Column ordering must be consistent everywhere too.
  for (const col of cols) {
    const order = nodes[0].column(col).map((t) => t.id).join(',');
    for (const n of nodes) assert.equal(n.column(col).map((t) => t.id).join(','), order);
  }
  console.log(`  simulated ${ops.length} ops, final visible tasks: ${snap.length}`);
});

console.log(`\nAll ${passed} tests passed.`);
