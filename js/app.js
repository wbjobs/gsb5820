import { Board, keyBetween } from './crdt.js';
import { CryptoClient } from './crypto.js';
import { openDb, getMeta, putMeta, getAllOps, versionVector } from './store.js';
import { Sync } from './sync.js';

const COLUMNS = [
  { id: 'todo', title: '待办' },
  { id: 'doing', title: '进行中' },
  { id: 'done', title: '已完成' },
];
const VERIFIER_PLAINTEXT = 'gsb-kanban-verifier-v1';

const tabId = crypto.randomUUID();
const board = new Board(tabId);
const cryptoClient = new CryptoClient();
let db = null;
let sync = null;
let renderQueued = false;

const $ = (sel) => document.querySelector(sel);

// ---------- Boot / unlock ----------

async function boot() {
  db = await openDb();
  const salt = await getMeta(db, 'salt');
  if (salt) {
    $('#unlock-title').textContent = '输入主密码解锁看板';
    $('#unlock-confirm').style.display = 'none';
  } else {
    $('#unlock-title').textContent = '创建主密码（用于派生加密密钥）';
    $('#unlock-confirm').style.display = '';
  }
  $('#unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#unlock-password').value;
    if (!pw) return;
    $('#unlock-error').textContent = '';
    $('#unlock-submit').disabled = true;
    try {
      if (salt) {
        await unlockExisting(pw, salt);
      } else {
        await createNew(pw);
      }
    } catch (err) {
      $('#unlock-error').textContent = err.message || String(err);
    } finally {
      $('#unlock-submit').disabled = false;
    }
  });
}

async function unlockExisting(pw, salt) {
  await cryptoClient.derive(pw, salt);
  const verifier = await getMeta(db, 'verifier');
  try {
    const plain = await cryptoClient.decryptObj(verifier);
    if (plain !== VERIFIER_PLAINTEXT) throw new Error('bad verifier');
  } catch {
    throw new Error('主密码错误，无法解密数据，请重试');
  }
  await startBoard();
}

async function createNew(pw) {
  const confirm = $('#unlock-confirm').value;
  if (pw !== confirm) throw new Error('两次输入的密码不一致');
  const salt = await cryptoClient.genSalt();
  await cryptoClient.derive(pw, salt);
  const verifier = await cryptoClient.encryptObj(VERIFIER_PLAINTEXT);
  await putMeta(db, 'salt', salt);
  await putMeta(db, 'verifier', verifier);
  await startBoard();
}

async function startBoard() {
  // Replay the encrypted op log (offline merge: ops written by other tabs
  // while this one was closed are already in the shared IndexedDB).
  const rows = await getAllOps(db);
  let cryptoErrors = 0;
  for (const row of rows) {
    try {
      const op = await cryptoClient.decryptObj({ iv: row.iv, data: row.data });
      board.applyOp(op);
    } catch {
      cryptoErrors++;
    }
  }
  if (cryptoErrors > 0) showBanner(`有 ${cryptoErrors} 条数据无法用当前密钥解密（密钥错误？）`);

  sync = new Sync(tabId, db, cryptoClient, {
    onOp: (op) => {
      if (board.applyOp(op)) scheduleRender();
    },
    onCryptoError: () => showBanner('密钥错误：无法解密来自其他标签页的数据'),
    onPeers: (n) => { $('#peer-count').textContent = `在线标签页：${n}`; },
  });
  sync.start(versionVector(rows));

  $('#unlock-overlay').style.display = 'none';
  $('#board').style.display = '';
  buildColumns();
  scheduleRender();
}

function showBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.style.display = '';
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => { b.style.display = 'none'; }, 6000);
}

// ---------- Local mutations ----------

function commit(op) {
  scheduleRender();
  sync.send(op); // persist + broadcast, async
}

function addTask(col) {
  const input = $(`.add-input[data-col="${col}"]`);
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  const tasks = board.column(col);
  const pos = keyBetween(tasks.length ? tasks[tasks.length - 1].pos : null, null);
  const { op } = board.create({ title, desc: '', due: '', col, pos });
  commit(op);
}

function moveTask(id, col, pos) {
  commit(board.put(id, { col, pos }));
}

function saveEdit(id, fields) {
  commit(board.put(id, fields));
}

function deleteTask(id) {
  commit(board.del(id));
}

// ---------- Rendering (batched via rAF to keep the main thread smooth) ----------

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function buildColumns() {
  const wrap = $('#columns');
  wrap.innerHTML = '';
  for (const col of COLUMNS) {
    const el = document.createElement('section');
    el.className = 'column';
    el.dataset.col = col.id;
    el.innerHTML = `
      <h2>${col.title}<span class="count" data-col="${col.id}"></span></h2>
      <div class="cards" data-col="${col.id}"></div>
      <form class="add-form" data-col="${col.id}">
        <input class="add-input" data-col="${col.id}" placeholder="添加任务…" maxlength="200">
        <button type="submit">＋</button>
      </form>`;
    el.querySelector('.add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      addTask(col.id);
    });
    wrap.appendChild(el);
  }
}

function render() {
  for (const col of COLUMNS) {
    const tasks = board.column(col.id);
    const list = $(`.cards[data-col="${col.id}"]`);
    list.innerHTML = '';
    for (const t of tasks) list.appendChild(renderCard(t));
    $(`.count[data-col="${col.id}"]`).textContent = tasks.length ? ` (${tasks.length})` : '';
  }
}

function renderCard(t) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = t.id;
  const due = t.due ? new Date(t.due) : null;
  const overdue = due && due.getTime() < Date.now();
  el.innerHTML = `
    <div class="card-title"></div>
    ${t.desc ? '<div class="card-desc"></div>' : ''}
    <div class="card-meta">
      ${due ? `<span class="due ${overdue ? 'overdue' : ''}">⏰ ${formatDue(due)}</span>` : ''}
      <span class="card-actions">
        <button class="edit-btn" title="编辑">✎</button>
        <button class="del-btn" title="删除">🗑</button>
      </span>
    </div>`;
  el.querySelector('.card-title').textContent = t.title;
  if (t.desc) el.querySelector('.card-desc').textContent = t.desc;
  el.querySelector('.edit-btn').addEventListener('click', () => openEdit(t.id));
  el.querySelector('.del-btn').addEventListener('click', () => {
    if (confirm('删除该任务？')) deleteTask(t.id);
  });
  attachDrag(el, t.id);
  return el;
}

function formatDue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Edit modal ----------

function openEdit(id) {
  const t = board.get(id);
  if (!t) return;
  $('#edit-id').value = id;
  $('#edit-title').value = t.title || '';
  $('#edit-desc').value = t.desc || '';
  $('#edit-due').value = t.due || '';
  $('#edit-modal').style.display = '';
  $('#edit-title').focus();
}

function closeEdit() {
  $('#edit-modal').style.display = 'none';
}

$('#edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#edit-id').value;
  saveEdit(id, {
    title: $('#edit-title').value.trim() || '(无标题)',
    desc: $('#edit-desc').value.trim(),
    due: $('#edit-due').value,
  });
  closeEdit();
});
$('#edit-cancel').addEventListener('click', closeEdit);

// ---------- Drag & drop with Pointer Events ----------

const DRAG_THRESHOLD = 6;
let drag = null; // { id, el, startX, startY, offsetX, offsetY, active, placeholder }

function attachDrag(el, id) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const rect = el.getBoundingClientRect();
    drag = {
      id, el,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      width: rect.width, height: rect.height,
      active: false, placeholder: null,
    };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || drag.el !== el) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      beginDrag(e);
    }
    moveDrag(e);
  });
  const finish = (e, cancel) => {
    if (!drag || drag.el !== el) return;
    if (drag.active && !cancel) commitDrag();
    cleanupDrag();
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
}

function beginDrag(e) {
  drag.active = true;
  const el = drag.el;
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.style.height = drag.height + 'px';
  drag.placeholder = ph;
  el.parentNode.insertBefore(ph, el);
  document.body.appendChild(el);
  el.classList.add('dragging');
  el.style.width = drag.width + 'px';
  positionDragEl(e);
}

function positionDragEl(e) {
  drag.el.style.left = (e.clientX - drag.offsetX) + 'px';
  drag.el.style.top = (e.clientY - drag.offsetY) + 'px';
}

function moveDrag(e) {
  positionDragEl(e);
  // Find target column under the pointer.
  let targetList = null;
  for (const list of document.querySelectorAll('.cards')) {
    const r = list.getBoundingClientRect();
    if (e.clientX >= r.left - 12 && e.clientX <= r.right + 12 &&
        e.clientY >= r.top - 40 && e.clientY <= r.bottom + 40) {
      targetList = list;
      break;
    }
  }
  if (!targetList) return;
  const ph = drag.placeholder;
  if (ph.parentNode !== targetList) targetList.appendChild(ph);
  // Insert placeholder before the first card whose midpoint is below the pointer.
  for (const card of targetList.querySelectorAll('.card:not(.dragging)')) {
    const r = card.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      targetList.insertBefore(ph, card);
      return;
    }
  }
  targetList.appendChild(ph);
}

function commitDrag() {
  const ph = drag.placeholder;
  const col = ph.parentNode.dataset.col;
  // Neighbors in the CURRENT crdt order, excluding the dragged task.
  const tasks = board.column(col).filter((t) => t.id !== drag.id);
  const domIds = [...ph.parentNode.querySelectorAll('.card:not(.dragging), .placeholder')]
    .map((n) => (n.classList.contains('placeholder') ? '@ph' : n.dataset.id));
  const idx = domIds.indexOf('@ph');
  const prevId = idx > 0 ? domIds[idx - 1] : null;
  const nextId = idx < domIds.length - 1 ? domIds[idx + 1] : null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const prev = prevId && byId.get(prevId) ? byId.get(prevId).pos : null;
  const next = nextId && byId.get(nextId) ? byId.get(nextId).pos : null;
  moveTask(drag.id, col, keyBetween(prev, next));
}

function cleanupDrag() {
  if (!drag) return;
  if (drag.active) {
    drag.el.classList.remove('dragging');
    drag.el.style.width = '';
    drag.el.style.left = '';
    drag.el.style.top = '';
    if (drag.placeholder && drag.placeholder.parentNode) {
      drag.placeholder.parentNode.removeChild(drag.placeholder);
    }
    scheduleRender(); // snap back / re-render from crdt state
  }
  drag = null;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (drag && drag.active) cleanupDrag();
    closeEdit();
  }
});

boot();
