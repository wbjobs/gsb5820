// main.js — 主线程：解锁界面、看板渲染、Pointer Events 拖拽、编辑/删除/截止时间。
// 所有数据操作都转成 op 发给 Worker；Worker 回推全量有序状态，这里做保守渲染。
import { keyBetween, newTaskId, COLUMNS } from './crdt.js';

const COL_NAMES = { todo: '待办', doing: '进行中', done: '已完成' };

const worker = new Worker('./js/worker.js', { type: 'module' });

let lastTasks = [];        // 最近一次 Worker 推送的有序任务
let deferredState = null;  // 拖拽/编辑期间暂缓的渲染
let dragging = null;       // 当前拖拽会话
let editingId = null;      // 正在内联编辑标题的任务 id

const $ = (sel) => document.querySelector(sel);

// ---------- Worker 消息 ----------
worker.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'boot':
      $('#unlock-title').textContent = msg.hasVault ? '输入主密码解锁' : '首次使用：设置主密码';
      $('#unlock-hint').textContent = msg.hasVault
        ? '任务数据使用主密码派生的密钥加密存储。'
        : '将用该密码派生 AES-256 密钥（PBKDF2，25 万次迭代），请务必牢记。';
      break;
    case 'unlock-ok':
      $('#unlock-view').hidden = true;
      $('#board-view').hidden = false;
      break;
    case 'unlock-fail':
      $('#unlock-error').textContent = '主密码错误，无法解密数据，请重试。';
      $('#password').select();
      break;
    case 'state':
      lastTasks = msg.tasks;
      $('#offline-badge').hidden = !msg.offline;
      if (msg.decryptErrors > 0) {
        $('#key-warning').hidden = false;
        $('#key-warning').textContent =
          `⚠ 收到 ${msg.decryptErrors} 条无法解密的同步消息——可能有其他标签页使用了不同的主密码。`;
      }
      requestRender();
      break;
    case 'decrypt-error':
      $('#key-warning').hidden = false;
      $('#key-warning').textContent =
        `⚠ 收到 ${msg.count} 条无法解密的同步消息——可能有其他标签页使用了不同的主密码。`;
      break;
    case 'error':
      console.error('worker error:', msg.message);
      break;
  }
};

function requestRender() {
  if (dragging || editingId || boardHasFocus()) {
    deferredState = lastTasks;
    return;
  }
  render(lastTasks);
}
function flushDeferred() {
  if (deferredState) {
    deferredState = null;
    render(lastTasks);
  }
}
function boardHasFocus() {
  const el = document.activeElement;
  return !!(el && $('#board').contains(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
}
// 看板内输入框失焦后，应用暂缓的远程更新
document.addEventListener('focusout', (ev) => {
  if ($('#board') && $('#board').contains(ev.target)) setTimeout(flushDeferred, 0);
});

// ---------- 渲染 ----------
function render(tasks) {
  const board = $('#board');
  board.innerHTML = '';
  for (const col of COLUMNS) {
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.col = col;
    const list = tasks.filter((t) => t.col === col);
    colEl.innerHTML = `
      <header><h2>${COL_NAMES[col]}</h2><span class="count">${list.length}</span></header>
      <div class="cards" data-col="${col}"></div>
      <form class="add-form" data-col="${col}">
        <input type="text" placeholder="+ 添加任务" maxlength="200" autocomplete="off">
      </form>`;
    const cardsEl = colEl.querySelector('.cards');
    for (const task of list) cardsEl.appendChild(renderCard(task));
    board.appendChild(colEl);
  }
}

function renderCard(task) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = task.id;
  card.dataset.order = task.order;
  const overdue = task.due && new Date(task.due).getTime() < Date.now();
  card.innerHTML = `
    <div class="card-top">
      <span class="title" title="双击编辑"></span>
      <button class="del" title="删除任务" aria-label="删除">×</button>
    </div>
    <label class="due ${overdue ? 'overdue' : ''}">
      ⏰ <input type="datetime-local">
    </label>`;
  card.querySelector('.title').textContent = task.title;
  card.querySelector('.due input').value = typeof task.due === 'string' ? task.due : '';
  return card;
}

// ---------- op 发送 ----------
const sendOp = (op) => worker.postMessage({ t: 'op', op });

function visibleInCol(col) {
  return lastTasks.filter((t) => t.col === col); // 已有序
}

// 在 col 列的 index 位置插入/移动时，计算分数排序键
function orderAt(col, index, excludeId = null) {
  const list = visibleInCol(col).filter((t) => t.id !== excludeId);
  const before = index > 0 ? list[index - 1] : null;
  const after = index < list.length ? list[index] : null;
  // 并发同位插入可能产生相同键，向两侧跳过相等键
  let b = before ? before.order : null;
  let a = after ? after.order : null;
  if (b && a && b === a) a = null;
  return keyBetween(b, a);
}

// ---------- 事件：添加 ----------
document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('.add-form');
  if (!form) return;
  ev.preventDefault();
  const input = form.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  const col = form.dataset.col;
  const id = newTaskId(String(Math.random()).slice(2, 8));
  sendOp({ __local: true, kind: 'add', id, title, col, order: orderAt(col, visibleInCol(col).length), due: null });
  input.value = '';
});

// ---------- 事件：删除 / 编辑 / 截止时间 ----------
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.del');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  sendOp({ __local: true, kind: 'del', id });
});

document.addEventListener('dblclick', (ev) => {
  const titleEl = ev.target.closest('.card .title');
  if (!titleEl) return;
  const card = titleEl.closest('.card');
  const id = card.dataset.id;
  const task = lastTasks.find((t) => t.id === id);
  if (!task) return;
  editingId = id;
  const input = document.createElement('input');
  input.className = 'edit-title';
  input.value = task.title;
  input.maxLength = 200;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    editingId = null;
    if (v && v !== task.title) sendOp({ __local: true, kind: 'set', id, field: 'title', value: v });
    flushDeferred();
    requestRender();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = task.title; input.blur(); }
  });
});

document.addEventListener('change', (ev) => {
  const input = ev.target.closest('.due input');
  if (!input) return;
  const id = input.closest('.card').dataset.id;
  sendOp({ __local: true, kind: 'set', id, field: 'due', value: input.value || null });
});

// ---------- Pointer Events 拖拽 ----------
document.addEventListener('pointerdown', (ev) => {
  const card = ev.target.closest('.card');
  if (!card || ev.target.closest('input,button,.edit-title')) return;
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  const startX = ev.clientX, startY = ev.clientY;
  const id = card.dataset.id;
  let active = false;
  let ghost = null;
  let placeholder = null;

  const onMove = (e) => {
    if (!active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      active = true;
      const rect = card.getBoundingClientRect();
      placeholder = document.createElement('div');
      placeholder.className = 'placeholder';
      placeholder.style.height = `${rect.height}px`;
      card.after(placeholder);
      ghost = card;
      ghost.classList.add('dragging');
      ghost.style.width = `${rect.width}px`;
      document.body.appendChild(ghost);
      dragging = { id, offsetX: startX - rect.left, offsetY: startY - rect.top, placeholder };
    }
    ghost.style.left = `${e.clientX - dragging.offsetX}px`;
    ghost.style.top = `${e.clientY - dragging.offsetY}px`;
    movePlaceholder(e.clientX, e.clientY, placeholder, id);
  };

  const onUp = (e) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    if (!active) return;
    const ph = dragging.placeholder;
    const cardsEl = ph.parentElement;
    const col = cardsEl.dataset.col;
    // 占位符前面（不含被拖卡片）的卡片数即插入下标
    let idx = 0;
    for (const el of cardsEl.children) {
      if (el === ph) break;
      if (el.classList && el.classList.contains('card') && !el.classList.contains('dragging')) idx += 1;
    }
    const order = orderAt(col, idx, id);
    const task = lastTasks.find((t) => t.id === id);
    ghost.classList.remove('dragging');
    ghost.style.left = ghost.style.top = ghost.style.width = '';
    ph.replaceWith(ghost);
    // 位置没变（同列且下标相同）则不发 op
    const curIdx = task ? visibleInCol(task.col).findIndex((t) => t.id === id) : -1;
    const moved = !!task && (task.col !== col || idx !== curIdx);
    dragging = null;
    if (moved) sendOp({ __local: true, kind: 'move', id, col, order });
    flushDeferred();
    requestRender();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
});

function movePlaceholder(x, y, placeholder, dragId) {
  const cols = [...document.querySelectorAll('.cards')];
  let targetCol = null;
  for (const c of cols) {
    const r = c.getBoundingClientRect();
    if (x >= r.left - 20 && x <= r.right + 20 && y >= r.top - 40 && y <= r.bottom + 40) { targetCol = c; break; }
  }
  if (!targetCol) targetCol = placeholder.parentElement;
  const cards = [...targetCol.querySelectorAll('.card:not(.dragging)')];
  let inserted = false;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      targetCol.insertBefore(placeholder, c);
      inserted = true;
      break;
    }
  }
  if (!inserted) targetCol.appendChild(placeholder);
}

// ---------- 解锁表单 ----------
$('#unlock-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const pw = $('#password').value;
  if (!pw) return;
  $('#unlock-error').textContent = '';
  $('#unlock-btn').disabled = true;
  $('#unlock-btn').textContent = '派生密钥中…';
  worker.postMessage({ t: 'unlock', password: pw });
  setTimeout(() => { $('#unlock-btn').disabled = false; $('#unlock-btn').textContent = '解锁'; }, 800);
});

// ---------- 离线开关 ----------
$('#offline-toggle').addEventListener('change', (ev) => {
  worker.postMessage({ t: 'set-offline', offline: ev.target.checked });
  $('#net-status').textContent = ev.target.checked ? '离线（操作将本地排队）' : '在线';
});

// ---------- 标签页关闭 ----------
window.addEventListener('pagehide', () => worker.postMessage({ t: 'page-hide' }));

worker.postMessage({ t: 'init' });
