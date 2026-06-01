'use strict';

/* ============================================================
 * 课时工资记录 —— 纯前端单页应用
 * 数据（含照片）全部保存在本机浏览器的 IndexedDB 中。
 * 登录（密码）= 解锁编辑；未登录只能预览。
 * ============================================================ */

/* ---------- 常量 ---------- */
const COURSES = {
  cpp:    { label: 'C++',    mode: 'perHead', defaultRate: 30 },
  python: { label: 'Python', mode: 'perHead', defaultRate: 25 },
  school: { label: '入校',   mode: 'perVisit' },
};
const COURSE_ORDER = ['cpp', 'python', 'school'];
const DB_NAME = 'pt-class-system';
const DB_VERSION = 1;

/* ---------- 工具函数 ---------- */
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (e) { /* fallthrough */ }
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthOf(dateStr) { return (dateStr || '').slice(0, 7); }
function curMonth() { return todayStr().slice(0, 7); }
function stepMonth(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad2(m)}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${y}年${Number(m)}月`;
}
function fmtMoney(n) {
  n = Math.round((Number(n) || 0) * 100) / 100;
  return '¥' + n.toLocaleString('zh-CN');
}
function fmtDateCN(dateStr) {
  if (!dateStr) return '';
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  let w = '';
  try { w = ' 周' + wd[new Date(dateStr + 'T00:00:00').getDay()]; } catch (e) { /* ignore */ }
  return dateStr + w;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* ---------- 密码哈希（软锁，非加密级安全） ---------- */
async function hashPassword(pw) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
      const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return 's256:' + hex;
    } catch (e) { /* fallthrough */ }
  }
  let h = 5381;
  for (let i = 0; i < pw.length; i++) h = (((h << 5) + h) ^ pw.charCodeAt(i)) >>> 0;
  return 'simple:' + h.toString(16);
}
async function verifyPassword(pw, stored) {
  if (!stored) return false;
  return (await reHash(pw, stored.split(':')[0])) === stored;
}
async function reHash(pw, algo) {
  if (algo === 's256' && typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
      return 's256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* fallthrough */ }
  }
  let h = 5381;
  for (let i = 0; i < pw.length; i++) h = (((h << 5) + h) ^ pw.charCodeAt(i)) >>> 0;
  return 'simple:' + h.toString(16);
}

/* ---------- IndexedDB ---------- */
let _db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('students')) {
        db.createObjectStore('students', { keyPath: 'id' }).createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' }).createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function store(name, mode) { return _db.transaction(name, mode).objectStore(name); }
async function dbGetAll(name) { await openDB(); return reqP(store(name, 'readonly').getAll()); }
async function dbGet(name, key) { await openDB(); return reqP(store(name, 'readonly').get(key)); }
async function dbPut(name, val) { await openDB(); return reqP(store(name, 'readwrite').put(val)); }
async function dbDelete(name, key) { await openDB(); return reqP(store(name, 'readwrite').delete(key)); }
async function dbGetByIndex(name, idx, val) { await openDB(); return reqP(store(name, 'readonly').index(idx).getAll(val)); }
async function dbClear(name) { await openDB(); return reqP(store(name, 'readwrite').clear()); }

async function getSettings() {
  const m = await dbGet('meta', 'settings');
  const def = { rates: { cpp: 30, python: 25 }, schoolMin: 100 };
  if (!m || !m.value) return def;
  return { rates: Object.assign({}, def.rates, m.value.rates), schoolMin: m.value.schoolMin ?? def.schoolMin };
}
async function saveSettings(s) { return dbPut('meta', { key: 'settings', value: s }); }
async function getAuthHash() { const m = await dbGet('meta', 'auth'); return m ? m.value : null; }
async function setAuthHash(h) { return dbPut('meta', { key: 'auth', value: h }); }

/* ---------- 图片压缩 ---------- */
function readAsDataUrl(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
}
function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
async function compressImage(file, maxDim = 1600, quality = 0.82) {
  try {
    const img = await loadImage(await readAsDataUrl(file));
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob) return { blob, w, h };
  } catch (e) { /* 回退为原图 */ }
  return { blob: file, w: 0, h: 0 };
}
function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}
async function dataUrlToBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }

/* ---------- 全局状态 ---------- */
const state = {
  view: 'sessions',     // sessions | sessionDetail | sessionEdit | students | salary | settings
  edit: false,
  hasPassword: false,
  settings: null,
  students: [],
  sessions: [],
  detailId: null,
  editor: null,
  salaryMonth: curMonth(),
};
let viewUrls = [];           // 当前视图创建的 objectURL，切换时回收
function trackUrl(u) { viewUrls.push(u); return u; }
function revokeViewUrls() { viewUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} }); viewUrls = []; }

/* ---------- 业务计算 ---------- */
function sessionHeads(s) { return (s.attendees ? s.attendees.length : 0) + (Number(s.extra) || 0); }
function sessionPay(s) {
  if (s.courseType === 'school') return Number(s.amount) || 0;
  const rate = (state.settings.rates[s.courseType] ?? COURSES[s.courseType].defaultRate);
  return sessionHeads(s) * rate;
}
function computeMonth(ym) {
  const list = state.sessions.filter((s) => monthOf(s.date) === ym);
  const r = state.settings.rates;
  const acc = {
    cpp: { count: 0, heads: 0, pay: 0 },
    python: { count: 0, heads: 0, pay: 0 },
    school: { count: 0, pay: 0 },
    total: 0,
  };
  for (const s of list) {
    if (s.courseType === 'school') {
      const p = Number(s.amount) || 0;
      acc.school.count++; acc.school.pay += p; acc.total += p;
    } else {
      const heads = sessionHeads(s);
      const rate = r[s.courseType] ?? COURSES[s.courseType].defaultRate;
      const p = heads * rate;
      acc[s.courseType].count++; acc[s.courseType].heads += heads; acc[s.courseType].pay += p; acc.total += p;
    }
  }
  return { list, acc };
}
function allTimeTotal() {
  return state.sessions.reduce((sum, s) => sum + sessionPay(s), 0);
}

/* ---------- 启动 ---------- */
async function boot() {
  try { await openDB(); } catch (e) {
    document.getElementById('app').innerHTML = '<div class="boot">无法打开本地数据库。<br>请使用 Safari/Chrome 等现代浏览器，且不要在「无痕模式」下使用。</div>';
    return;
  }
  state.settings = await getSettings();
  state.hasPassword = !!(await getAuthHash());
  state.edit = state.hasPassword ? (sessionStorage.getItem('pt_edit') === '1') : true;
  await reloadData();
  renderApp();
  registerSW();
}
async function reloadData() {
  state.students = (await dbGetAll('students')).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  state.sessions = (await dbGetAll('sessions')).sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}
function registerSW() {
  const ok = 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  if (ok) navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------- 导航 ---------- */
function tabGroup() {
  if (['sessions', 'sessionDetail', 'sessionEdit'].includes(state.view)) return 'sessions';
  return state.view;
}
function go(view) { state.view = view; window.scrollTo(0, 0); renderApp(); }

/* ---------- 顶层渲染 ---------- */
function renderApp() {
  const app = document.getElementById('app');
  const titles = { sessions: '课时记录', students: '学员', salary: '工资统计', settings: '设置', sessionDetail: '课程详情', sessionEdit: state.editor && state.editor.id ? '编辑记录' : '新增记录' };
  const showBack = ['sessionDetail', 'sessionEdit'].includes(state.view);

  app.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="hdr-l">${showBack
          ? '<button class="hdr-back" data-back>‹ 返回</button>'
          : `<span class="hdr-title">${titles[state.view] || ''}</span>`}</div>
        <div class="hdr-r">${lockControlHtml()}</div>
      </header>
      <main class="view" id="view"></main>
      <nav class="tabbar">
        ${tabBtn('sessions', '📋', '记录')}
        ${tabBtn('students', '👥', '学员')}
        ${tabBtn('salary', '💰', '工资')}
        ${tabBtn('settings', '⚙️', '设置')}
      </nav>
    </div>`;

  if (showBack) $('[data-back]').onclick = onBack;
  const lb = $('[data-lock]'); if (lb) lb.onclick = onLockClick;
  $all('.tab').forEach((t) => { t.onclick = () => go(t.dataset.view); });

  renderView();
}
function tabBtn(view, ico, label) {
  const active = tabGroup() === view ? ' active' : '';
  return `<button class="tab${active}" data-view="${view}"><span class="ico">${ico}</span><span>${label}</span></button>`;
}
function lockControlHtml() {
  if (!state.hasPassword) return '<span class="lock-tag">编辑模式</span>';
  return state.edit
    ? '<button class="lock-btn unlocked" data-lock>🔓 编辑中</button>'
    : '<button class="lock-btn locked" data-lock>🔒 登录编辑</button>';
}
function onBack() {
  let target = 'sessions';
  if (state.view === 'sessionEdit') {
    const hadId = !!(state.editor && state.editor.id);
    cleanupEditor();
    state.editor = null;
    if (hadId && state.detailId) target = 'sessionDetail';
  }
  if (target === 'sessionDetail' && !state.sessions.find((s) => s.id === state.detailId)) target = 'sessions';
  state.view = target;
  window.scrollTo(0, 0);
  renderApp();
}
function onLockClick() {
  if (state.edit) {
    state.edit = false; sessionStorage.removeItem('pt_edit');
    toast('已锁定，进入预览模式'); renderApp();
  } else {
    openLoginModal();
  }
}

function renderView() {
  revokeViewUrls();
  const v = document.getElementById('view');
  if (!v) return;
  switch (state.view) {
    case 'sessions': v.innerHTML = viewSessions(); bindSessions(v); break;
    case 'sessionDetail': v.innerHTML = viewSessionDetail(); bindSessionDetail(v); break;
    case 'sessionEdit': v.innerHTML = viewSessionEdit(); bindSessionEdit(v); break;
    case 'students': v.innerHTML = viewStudents(); bindStudents(v); break;
    case 'salary': v.innerHTML = viewSalary(); bindSalary(v); break;
    case 'settings': v.innerHTML = viewSettings(); bindSettings(v); break;
  }
}

/* ============================================================
 * 视图：记录列表
 * ============================================================ */
function viewSessions() {
  const { acc } = computeMonth(curMonth());
  let html = `
    <div class="stat-hero">
      <div class="label">本月预计工资（${monthLabel(curMonth())}）</div>
      <div class="value">${fmtMoney(acc.total)}</div>
      <div class="sub">C++ ${acc.cpp.heads}人次 · Python ${acc.python.heads}人次 · 入校 ${acc.school.count}次</div>
    </div>`;

  if (state.edit) {
    html += `<div class="section-head"><h2>全部记录</h2><button class="btn btn-primary btn-sm btn-add" data-add>＋ 新增记录</button></div>`;
  } else {
    html += `<div class="section-head"><h2>全部记录</h2></div>`;
  }

  if (state.sessions.length === 0) {
    html += `<div class="empty"><div class="big">📋</div><div>还没有上课记录</div>${state.edit ? '<div class="muted" style="margin-top:6px">点右上角「新增记录」开始</div>' : ''}</div>`;
    return html;
  }

  // 按月分组
  const groups = {};
  for (const s of state.sessions) {
    const ym = monthOf(s.date) || '未知';
    (groups[ym] = groups[ym] || []).push(s);
  }
  for (const ym of Object.keys(groups).sort((a, b) => b.localeCompare(a))) {
    const items = groups[ym];
    const sum = items.reduce((t, s) => t + sessionPay(s), 0);
    html += `<div class="month-group">
      <div class="month-bar"><span class="m-name">${monthLabel(ym)}</span><span><span class="m-sum">${fmtMoney(sum)}</span> <span class="m-cnt">· ${items.length}节</span></span></div>
      ${items.map(sessionCard).join('')}
    </div>`;
  }
  return html;
}
function sessionCard(s) {
  const c = COURSES[s.courseType];
  let meta;
  if (s.courseType === 'school') {
    meta = `入校 · ${fmtMoney(s.amount)}`;
  } else {
    const rate = state.settings.rates[s.courseType] ?? c.defaultRate;
    meta = `${sessionHeads(s)} 人 × ¥${rate}`;
  }
  const photo = (s.photoIds && s.photoIds.length) ? `<span class="sc-photo">📷 ${s.photoIds.length}</span>` : '';
  return `<div class="session-card" data-id="${s.id}">
    <div class="sc-main">
      <div class="sc-top"><span class="sc-date">${fmtDateCN(s.date)}</span><span class="badge ${s.courseType}">${c.label}</span></div>
      <div class="sc-meta">${meta} ${photo}</div>
    </div>
    <div class="sc-pay">${fmtMoney(sessionPay(s))}</div>
    <span class="chevron">›</span>
  </div>`;
}
function bindSessions(v) {
  const add = $('[data-add]', v); if (add) add.onclick = () => startEditor(null);
  $all('.session-card', v).forEach((el) => {
    el.onclick = () => { state.detailId = el.dataset.id; go('sessionDetail'); };
  });
}

/* ============================================================
 * 视图：课程详情
 * ============================================================ */
function viewSessionDetail() {
  const s = state.sessions.find((x) => x.id === state.detailId);
  if (!s) return '<div class="empty"><div>记录不存在</div></div>';
  const c = COURSES[s.courseType];

  let breakdown = '';
  if (s.courseType === 'school') {
    breakdown = `<div class="detail-line"><span class="k">入校金额（学校支付）</span><span class="v">${fmtMoney(s.amount)}</span></div>`;
  } else {
    const rate = state.settings.rates[s.courseType] ?? c.defaultRate;
    const named = s.attendees ? s.attendees.length : 0;
    breakdown = `<div class="detail-line"><span class="k">出勤人数</span><span class="v">${sessionHeads(s)} 人</span></div>
      <div class="detail-line"><span class="k">单价</span><span class="v">¥${rate} / 人</span></div>`;
    if (s.extra) breakdown += `<div class="detail-line"><span class="k">其中不记名</span><span class="v">${s.extra} 人</span></div>`;
    let names = '';
    if (named) names = `<div class="name-chips">${s.attendees.map((a) => `<span class="name-chip">${escapeHtml(a.name)}</span>`).join('')}</div>`;
    else names = '<div class="muted" style="margin-top:6px">未记名</div>';
    breakdown += `<div style="padding-top:10px"><div class="muted" style="font-size:13px">学员（${named}）</div>${names}</div>`;
  }

  return `
    <div class="card">
      <div class="row-between" style="margin-bottom:10px">
        <span class="badge ${s.courseType}">${c.label}</span>
        <span class="muted">${fmtDateCN(s.date)}</span>
      </div>
      <div class="detail-pay">${fmtMoney(sessionPay(s))}</div>
    </div>
    <div class="card">${breakdown}</div>
    <div class="card"><p class="card-title">上课照片</p><div id="detail-photos"><div class="photo-loading">加载中…</div></div></div>
    ${s.note ? `<div class="card"><p class="card-title">备注</p><div class="note-box">${escapeHtml(s.note)}</div></div>` : ''}
    ${state.edit ? `<div class="form-actions"><button class="btn btn-ghost" data-edit>编辑</button><button class="btn btn-danger" data-del>删除</button></div>` : ''}
  `;
}
async function bindSessionDetail(v) {
  const s = state.sessions.find((x) => x.id === state.detailId);
  if (!s) return;
  const box = $('#detail-photos', v);
  const photos = await dbGetByIndex('photos', 'sessionId', s.id);
  if (!photos.length) { box.innerHTML = '<div class="muted">无照片</div>'; }
  else {
    box.className = 'photo-grid view';
    box.innerHTML = photos.map((p) => {
      const url = trackUrl(URL.createObjectURL(p.blob));
      return `<div class="photo-thumb" data-full="${url}"><img src="${url}" alt="上课照片"></div>`;
    }).join('');
    $all('.photo-thumb', box).forEach((t) => { t.onclick = () => openLightbox(t.dataset.full); });
  }
  const ed = $('[data-edit]', v); if (ed) ed.onclick = () => startEditor(s);
  const del = $('[data-del]', v); if (del) del.onclick = () => deleteSession(s);
}
async function deleteSession(s) {
  if (!(await confirmDialog('删除这条记录？', '照片也会一并删除，无法恢复。'))) return;
  const photos = await dbGetByIndex('photos', 'sessionId', s.id);
  for (const p of photos) await dbDelete('photos', p.id);
  await dbDelete('sessions', s.id);
  await reloadData();
  state.detailId = null;
  go('sessions');
  toast('已删除');
}

/* ============================================================
 * 视图：新增 / 编辑记录
 * ============================================================ */
function startEditor(session) {
  const selected = new Map();
  const rosterIds = new Set(state.students.map((s) => s.id));
  const rosterExtra = [];
  if (session && session.attendees) {
    for (const a of session.attendees) {
      selected.set(a.id, a.name);
      if (!rosterIds.has(a.id)) rosterExtra.push({ id: a.id, name: a.name });
    }
  }
  state.editor = {
    id: session ? session.id : null,
    createdAt: session ? session.createdAt : null,
    date: session ? session.date : todayStr(),
    courseType: session ? session.courseType : 'cpp',
    selected,
    rosterExtra,
    extra: session ? (session.extra || 0) : 0,
    amount: session ? (session.amount ?? state.settings.schoolMin) : state.settings.schoolMin,
    note: session ? (session.note || '') : '',
    photos: [],       // {id, blob, w, h, url, existing}
    removed: [],      // 被删除的已有照片 id
    loadFor: session ? session.id : null,
  };
  go('sessionEdit');
}
function cleanupEditor() {
  if (state.editor) state.editor.photos.forEach((p) => { try { URL.revokeObjectURL(p.url); } catch (e) {} });
}
function viewSessionEdit() {
  const e = state.editor;
  const isSchool = e.courseType === 'school';
  return `
    <form class="form" id="sessForm">
      <label class="field">
        <span class="field-label">日期</span>
        <input type="date" name="date" value="${e.date}" required>
      </label>

      <div class="field">
        <span class="field-label">课程类型</span>
        <div class="seg" id="segCourse">
          ${COURSE_ORDER.map((k) => `<button type="button" data-c="${k}" class="${e.courseType === k ? 'active' : ''}">${COURSES[k].label}</button>`).join('')}
        </div>
      </div>

      <div class="field" id="attendBlock">
        <span class="field-label">出勤学员 <span class="muted" id="attendCount"></span></span>
        <div class="chip-wrap" id="chips"></div>
        <div class="quick-add">
          <input type="text" id="qaName" placeholder="临时添加学员姓名" autocomplete="off">
          <button type="button" class="btn btn-sm" id="qaBtn">添加</button>
        </div>
        <label class="field" id="extraField" style="margin-top:4px">
          <span class="field-label">其他不记名人数（可选，计入人头）</span>
          <input type="number" name="extra" min="0" step="1" value="${e.extra || 0}">
        </label>
      </div>

      <label class="field" id="amountBlock" style="display:${isSchool ? 'flex' : 'none'}">
        <span class="field-label">入校金额（学校支付，一般 ≥ ${state.settings.schoolMin} 元）</span>
        <input type="number" name="amount" min="0" step="1" value="${e.amount}">
        <span class="hint" id="amountHint"></span>
      </label>

      <label class="field">
        <span class="field-label">备注（可选）</span>
        <textarea name="note" rows="2" placeholder="教学内容、班级、学校名称等">${escapeHtml(e.note)}</textarea>
      </label>

      <div class="field">
        <span class="field-label">上课照片</span>
        <div class="photo-grid" id="photoGrid"></div>
        <label class="btn btn-ghost photo-add">＋ 添加照片<input type="file" id="photoInput" accept="image/*" multiple hidden></label>
      </div>

      <div class="pay-preview" id="payPreview"></div>

      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-back>取消</button>
        <button type="submit" class="btn btn-primary" id="saveBtn">保存</button>
      </div>
    </form>`;
}
function bindSessionEdit(v) {
  const e = state.editor;
  $('[data-back]', v).onclick = onBack;

  // 课程类型切换
  $all('#segCourse button', v).forEach((btn) => {
    btn.onclick = () => {
      e.courseType = btn.dataset.c;
      $all('#segCourse button', v).forEach((b) => b.classList.toggle('active', b.dataset.c === e.courseType));
      const isSchool = e.courseType === 'school';
      $('#amountBlock', v).style.display = isSchool ? 'flex' : 'none';
      $('#extraField', v).style.display = isSchool ? 'none' : 'flex';
      updatePreview(v);
    };
  });

  // 学员 chips
  renderChips(v);

  // 快速添加学员
  const qaAdd = async () => {
    const inp = $('#qaName', v);
    const name = inp.value.trim();
    if (!name) return;
    const st = { id: uid(), name, note: '', active: true, createdAt: Date.now() };
    await dbPut('students', st);
    state.students.push(st);
    state.students.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    e.selected.set(st.id, st.name);
    inp.value = '';
    renderChips(v);
    updatePreview(v);
  };
  $('#qaBtn', v).onclick = qaAdd;
  $('#qaName', v).onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); qaAdd(); } };

  // 数值变化
  $('[name="extra"]', v).oninput = () => updatePreview(v);
  $('[name="amount"]', v).oninput = () => updatePreview(v);

  // 照片
  $('#photoInput', v).onchange = (ev) => onPhotoPick(ev.target.files, v);
  renderPhotoGrid(v);
  if (e.loadFor) loadExistingPhotos(v);

  updatePreview(v);

  // 保存
  $('#sessForm', v).onsubmit = (ev) => { ev.preventDefault(); saveSession(v); };
}
function rosterForPicker() {
  const e = state.editor;
  const map = new Map();
  for (const s of state.students) if (s.active !== false || e.selected.has(s.id)) map.set(s.id, s.name);
  for (const a of e.rosterExtra) if (!map.has(a.id)) map.set(a.id, a.name);
  // 已选但不在以上集合（极端情况）也补上
  for (const [id, name] of e.selected) if (!map.has(id)) map.set(id, name);
  return Array.from(map, ([id, name]) => ({ id, name }));
}
function renderChips(v) {
  const e = state.editor;
  const box = $('#chips', v);
  const list = rosterForPicker();
  if (!list.length) {
    box.innerHTML = '<span class="chip empty-hint">还没有学员，在下方输入姓名添加</span>';
  } else {
    box.innerHTML = list.map((s) =>
      `<button type="button" class="chip ${e.selected.has(s.id) ? 'selected' : ''}" data-sid="${s.id}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`
    ).join('');
    $all('.chip[data-sid]', box).forEach((chip) => {
      chip.onclick = () => {
        const id = chip.dataset.sid;
        if (e.selected.has(id)) e.selected.delete(id);
        else e.selected.set(id, chip.dataset.name);
        chip.classList.toggle('selected');
        updatePreview(v);
      };
    });
  }
}
function updatePreview(v) {
  const e = state.editor;
  const cnt = $('#attendCount', v);
  const prev = $('#payPreview', v);
  if (e.courseType === 'school') {
    const a = Number($('[name="amount"]', v).value) || 0;
    prev.textContent = `应得 ${fmtMoney(a)}`;
    const hint = $('#amountHint', v);
    hint.textContent = a > 0 && a < state.settings.schoolMin ? `提示：低于常见标准（${state.settings.schoolMin} 元）` : '';
    hint.className = a > 0 && a < state.settings.schoolMin ? 'hint warn' : 'hint';
    if (cnt) cnt.textContent = `已选 ${e.selected.size} 人`;
  } else {
    const extra = Number($('[name="extra"]', v).value) || 0;
    const heads = e.selected.size + extra;
    const rate = state.settings.rates[e.courseType] ?? COURSES[e.courseType].defaultRate;
    if (cnt) cnt.textContent = `已选 ${e.selected.size} 人`;
    const extraTxt = extra ? ` ＋ ${extra}人` : '';
    prev.textContent = `${e.selected.size}人${extraTxt} × ¥${rate} = ${fmtMoney(heads * rate)}`;
  }
}
async function loadExistingPhotos(v) {
  const e = state.editor;
  const photos = await dbGetByIndex('photos', 'sessionId', e.loadFor);
  for (const p of photos) {
    const url = URL.createObjectURL(p.blob);
    e.photos.push({ id: p.id, blob: p.blob, w: p.w, h: p.h, url, existing: true });
  }
  e.loadFor = null;
  renderPhotoGrid(v);
}
async function onPhotoPick(files, v) {
  const e = state.editor;
  const label = $('.photo-add', v);
  const orig = label.innerHTML;
  label.innerHTML = '<span class="spin"></span> 处理中…';
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) continue;
    const { blob, w, h } = await compressImage(f);
    const url = URL.createObjectURL(blob);
    e.photos.push({ id: uid(), blob, w, h, url, existing: false });
  }
  label.innerHTML = orig;
  $('#photoInput', v).value = '';
  $('#photoInput', v).onchange = (ev) => onPhotoPick(ev.target.files, v);
  renderPhotoGrid(v);
}
function renderPhotoGrid(v) {
  const e = state.editor;
  const grid = $('#photoGrid', v);
  if (!grid) return;
  if (!e.photos.length) { grid.innerHTML = '<div class="muted" style="grid-column:1/-1">未添加照片</div>'; return; }
  grid.innerHTML = e.photos.map((p) =>
    `<div class="photo-thumb"><img src="${p.url}" alt=""><button type="button" class="rm" data-pid="${p.id}">✕</button></div>`
  ).join('');
  $all('.rm', grid).forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.pid;
      const idx = e.photos.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const p = e.photos[idx];
      if (p.existing) e.removed.push(p.id);
      try { URL.revokeObjectURL(p.url); } catch (er) {}
      e.photos.splice(idx, 1);
      renderPhotoGrid(v);
    };
  });
}
async function saveSession(v) {
  const e = state.editor;
  const btn = $('#saveBtn', v);
  const date = $('[name="date"]', v).value;
  if (!date) { toast('请选择日期'); return; }
  const note = $('[name="note"]', v).value.trim();
  const id = e.id || uid();

  let payload = { id, date, courseType: e.courseType, note, photoIds: e.photos.map((p) => p.id), createdAt: e.createdAt || Date.now(), updatedAt: Date.now() };

  if (e.courseType === 'school') {
    const amount = Number($('[name="amount"]', v).value) || 0;
    if (amount <= 0) { toast('请填写入校金额'); return; }
    payload.amount = amount;
    payload.attendees = Array.from(e.selected, ([sid, name]) => ({ id: sid, name }));
    payload.extra = 0;
  } else {
    payload.attendees = Array.from(e.selected, ([sid, name]) => ({ id: sid, name }));
    payload.extra = Number($('[name="extra"]', v).value) || 0;
    if (payload.attendees.length === 0 && payload.extra === 0) {
      if (!(await confirmDialog('出勤人数为 0？', '这节课工资将记为 ¥0，确定保存吗？'))) return;
    }
  }

  btn.disabled = true; btn.textContent = '保存中…';
  try {
    for (const p of e.photos) if (!p.existing) await dbPut('photos', { id: p.id, sessionId: id, blob: p.blob, w: p.w, h: p.h, createdAt: Date.now() });
    for (const rid of e.removed) await dbDelete('photos', rid);
    await dbPut('sessions', payload);
    await reloadData();
    cleanupEditor();
    state.editor = null;
    state.detailId = id;
    go('sessionDetail');
    toast('已保存');
  } catch (err) {
    btn.disabled = false; btn.textContent = '保存';
    toast('保存失败：' + (err && err.message ? err.message : '存储空间可能已满'));
  }
}

/* ============================================================
 * 视图：学员
 * ============================================================ */
function studentStats(id) {
  let count = 0;
  for (const s of state.sessions) if (s.attendees && s.attendees.some((a) => a.id === id)) count++;
  return count;
}
function viewStudents() {
  let html = '';
  if (state.edit) html += `<div class="section-head"><h2>学员库（${state.students.length}）</h2><button class="btn btn-primary btn-sm" data-addst>＋ 添加学员</button></div>`;
  else html += `<div class="section-head"><h2>学员库（${state.students.length}）</h2></div>`;

  if (!state.students.length) {
    html += `<div class="empty"><div class="big">👥</div><div>还没有学员</div>${state.edit ? '<div class="muted" style="margin-top:6px">添加后，记录出勤时可直接勾选</div>' : ''}</div>`;
    return html;
  }
  html += '<div class="card">';
  html += state.students.map((s) => {
    const inactive = s.active === false;
    return `<div class="student-row ${inactive ? 'inactive' : ''}">
      <div class="avatar">${escapeHtml((s.name || '?').slice(0, 1))}</div>
      <div class="s-main">
        <div class="s-name">${escapeHtml(s.name)} ${inactive ? '<span class="muted">（已停用）</span>' : ''}</div>
        <div class="s-sub">出勤 ${studentStats(s.id)} 次${s.note ? ' · ' + escapeHtml(s.note) : ''}</div>
      </div>
      ${state.edit ? `<div class="s-act">
        <button class="icon-btn" data-edit="${s.id}">✎</button>
        <button class="icon-btn" data-del="${s.id}">🗑</button>
      </div>` : ''}
    </div>`;
  }).join('');
  html += '</div>';
  return html;
}
function bindStudents(v) {
  const add = $('[data-addst]', v); if (add) add.onclick = () => openStudentModal(null);
  $all('[data-edit]', v).forEach((b) => { b.onclick = () => openStudentModal(state.students.find((s) => s.id === b.dataset.edit)); });
  $all('[data-del]', v).forEach((b) => { b.onclick = () => deleteStudent(state.students.find((s) => s.id === b.dataset.del)); });
}
function openStudentModal(student) {
  const editing = !!student;
  const body = `
    <div class="form">
      <label class="field"><span class="field-label">姓名</span><input type="text" id="stName" value="${editing ? escapeHtml(student.name) : ''}" placeholder="学员姓名" autocomplete="off"></label>
      <label class="field"><span class="field-label">备注（可选）</span><input type="text" id="stNote" value="${editing ? escapeHtml(student.note || '') : ''}" placeholder="班级、年级等"></label>
      ${editing ? `<label class="field" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="stActive" ${student.active === false ? '' : 'checked'} style="width:auto"><span>启用（取消勾选则在记录出勤时隐藏）</span></label>` : ''}
    </div>`;
  openModal(editing ? '编辑学员' : '添加学员', body, [
    { label: '取消', kind: 'ghost', close: true },
    { label: '保存', kind: 'primary', onClick: async (m) => {
      const name = $('#stName', m).value.trim();
      if (!name) { toast('请输入姓名'); return false; }
      const note = $('#stNote', m).value.trim();
      const active = editing ? $('#stActive', m).checked : true;
      const obj = editing
        ? Object.assign({}, student, { name, note, active })
        : { id: uid(), name, note, active: true, createdAt: Date.now() };
      await dbPut('students', obj);
      await reloadData();
      renderApp();
      toast('已保存');
    } },
  ]);
}
async function deleteStudent(s) {
  if (!s) return;
  const att = studentStats(s.id);
  const msg = att > 0 ? `该学员已出现在 ${att} 条记录中。删除后这些记录里仍会保留姓名，但学员库中会移除。` : '从学员库中移除该学员。';
  if (!(await confirmDialog(`删除「${s.name}」？`, msg))) return;
  await dbDelete('students', s.id);
  await reloadData();
  renderApp();
  toast('已删除');
}

/* ============================================================
 * 视图：工资统计
 * ============================================================ */
function viewSalary() {
  const ym = state.salaryMonth;
  const { list, acc } = computeMonth(ym);
  const rates = state.settings.rates;

  let rows = `
    <div class="breakdown-row"><div><span class="badge cpp">C++</span></div><div class="bk-info">${acc.cpp.count}节 · ${acc.cpp.heads}人次 × ¥${rates.cpp}</div><div class="bk-pay">${fmtMoney(acc.cpp.pay)}</div></div>
    <div class="breakdown-row"><div><span class="badge python">Python</span></div><div class="bk-info">${acc.python.count}节 · ${acc.python.heads}人次 × ¥${rates.python}</div><div class="bk-pay">${fmtMoney(acc.python.pay)}</div></div>
    <div class="breakdown-row"><div><span class="badge school">入校</span></div><div class="bk-info">${acc.school.count}次</div><div class="bk-pay">${fmtMoney(acc.school.pay)}</div></div>
    <div class="total-row"><span class="t-label">本月合计</span><span class="t-val">${fmtMoney(acc.total)}</span></div>`;

  let miniList = '';
  if (list.length) {
    miniList = `<div class="card"><p class="card-title">本月明细（${list.length}）</p><div class="list-mini">` +
      list.map((s) => {
        const c = COURSES[s.courseType];
        const sub = s.courseType === 'school' ? '入校' : `${sessionHeads(s)}人`;
        return `<div class="mini-row" data-id="${s.id}"><div class="mr-l"><span class="mr-date">${fmtDateCN(s.date)}</span><span class="badge ${s.courseType}">${c.label}</span><span class="muted">${sub}</span></div><div class="bk-pay">${fmtMoney(sessionPay(s))}</div></div>`;
      }).join('') + '</div></div>';
  } else {
    miniList = '<div class="empty"><div>本月暂无记录</div></div>';
  }

  return `
    <div class="card">
      <div class="month-nav">
        <button data-prev>‹</button>
        <span class="cur">${monthLabel(ym)}</span>
        <button data-next>›</button>
      </div>
      ${rows}
    </div>
    ${miniList}
    <div class="card">
      <div class="row-between"><span class="muted">所有记录累计工资</span><strong style="font-size:18px">${fmtMoney(allTimeTotal())}</strong></div>
    </div>`;
}
function bindSalary(v) {
  $('[data-prev]', v).onclick = () => { state.salaryMonth = stepMonth(state.salaryMonth, -1); renderApp(); };
  $('[data-next]', v).onclick = () => { state.salaryMonth = stepMonth(state.salaryMonth, 1); renderApp(); };
  $all('.mini-row', v).forEach((el) => { el.onclick = () => { state.detailId = el.dataset.id; go('sessionDetail'); }; });
}

/* ============================================================
 * 视图：设置
 * ============================================================ */
function viewSettings() {
  const s = state.settings;
  let lockCard;
  if (!state.hasPassword) {
    lockCard = `
      <div class="card">
        <p class="card-title">编辑密码</p>
        <div class="banner">尚未设置密码，当前任何人打开都能编辑。设置密码后，应用默认进入「预览」模式，需登录才能修改。</div>
        <div class="form">
          <label class="field"><span class="field-label">设置密码</span><input type="password" id="pw1" placeholder="输入密码" autocomplete="new-password"></label>
          <label class="field"><span class="field-label">确认密码</span><input type="password" id="pw2" placeholder="再次输入" autocomplete="new-password"></label>
          <button class="btn btn-primary" data-setpw>启用编辑锁</button>
        </div>
      </div>`;
  } else {
    lockCard = `
      <div class="card">
        <p class="card-title">编辑密码</p>
        <div class="muted" style="margin-bottom:12px">已启用编辑锁。打开应用默认为预览模式，点右上角「登录编辑」输入密码后可修改。</div>
        ${state.edit ? `<div class="form">
          <label class="field"><span class="field-label">当前密码</span><input type="password" id="pwOld" autocomplete="current-password"></label>
          <label class="field"><span class="field-label">新密码（留空 = 取消密码锁）</span><input type="password" id="pwNew" autocomplete="new-password"></label>
          <button class="btn" data-chpw>更新密码</button>
        </div>` : '<div class="muted">登录后可修改密码。</div>'}
      </div>`;
  }

  const ratesCard = `
    <div class="card">
      <p class="card-title">课时单价</p>
      <div class="form">
        <label class="field"><span class="field-label">C++（元 / 人）</span><input type="number" id="rateCpp" min="0" step="1" value="${s.rates.cpp}" ${state.edit ? '' : 'disabled'}></label>
        <label class="field"><span class="field-label">Python（元 / 人）</span><input type="number" id="ratePy" min="0" step="1" value="${s.rates.python}" ${state.edit ? '' : 'disabled'}></label>
        <label class="field"><span class="field-label">入校提示金额（低于此值时提醒）</span><input type="number" id="schoolMin" min="0" step="1" value="${s.schoolMin}" ${state.edit ? '' : 'disabled'}></label>
        ${state.edit ? '<button class="btn btn-primary" data-saverates>保存单价</button>' : '<div class="muted">登录后可修改单价。</div>'}
      </div>
    </div>`;

  const backupCard = `
    <div class="card">
      <p class="card-title">备份与迁移</p>
      <div class="muted" style="margin-bottom:12px">数据只存在本机。换设备、清理浏览器前请先导出备份；在新设备打开本应用后导入即可。</div>
      <div class="form">
        <button class="btn" data-export>⬇️ 导出备份（含照片）</button>
        ${state.edit ? `<label class="btn btn-ghost">⬆️ 导入备份<input type="file" id="importFile" accept="application/json,.json" hidden></label>` : '<div class="muted">登录后可导入备份。</div>'}
      </div>
    </div>`;

  const dangerCard = state.edit ? `
    <div class="card">
      <p class="card-title">危险操作</p>
      <button class="btn btn-danger btn-block" data-clear>清空所有记录与学员</button>
    </div>` : '';

  const aboutCard = `
    <div class="card about">
      <p class="card-title">关于</p>
      <p><strong>数据存储：</strong>全部保存在这台设备的浏览器本地（IndexedDB），不上传任何服务器，离线可用。</p>
      <p><strong>多设备：</strong>本机版各设备数据独立，请用「导出/导入备份」搬运。若以后想多端自动同步、并把预览链接发给机构核对，可升级到云端账号版。</p>
      <p><strong>编辑锁说明：</strong>本地密码用于防止误改、区分预览与编辑，并非加密级安全。</p>
      <p class="muted" style="margin-top:8px">课时工资记录 · 本地版</p>
    </div>`;

  return lockCard + ratesCard + backupCard + dangerCard + aboutCard;
}
function bindSettings(v) {
  const setpw = $('[data-setpw]', v);
  if (setpw) setpw.onclick = async () => {
    const a = $('#pw1', v).value, b = $('#pw2', v).value;
    if (!a) { toast('请输入密码'); return; }
    if (a !== b) { toast('两次输入不一致'); return; }
    await setAuthHash(await hashPassword(a));
    state.hasPassword = true; state.edit = true; sessionStorage.setItem('pt_edit', '1');
    renderApp(); toast('已启用编辑锁');
  };

  const chpw = $('[data-chpw]', v);
  if (chpw) chpw.onclick = async () => {
    const oldPw = $('#pwOld', v).value, newPw = $('#pwNew', v).value;
    if (!(await verifyPassword(oldPw, await getAuthHash()))) { toast('当前密码不正确'); return; }
    if (!newPw) {
      if (!(await confirmDialog('取消密码锁？', '取消后任何人打开都能编辑。'))) return;
      await dbDelete('meta', 'auth');
      state.hasPassword = false; state.edit = true;
      renderApp(); toast('已取消密码锁'); return;
    }
    await setAuthHash(await hashPassword(newPw));
    renderApp(); toast('密码已更新');
  };

  const sr = $('[data-saverates]', v);
  if (sr) sr.onclick = async () => {
    const cpp = Math.max(0, Number($('#rateCpp', v).value) || 0);
    const py = Math.max(0, Number($('#ratePy', v).value) || 0);
    const sm = Math.max(0, Number($('#schoolMin', v).value) || 0);
    state.settings = { rates: { cpp, python: py }, schoolMin: sm };
    await saveSettings(state.settings);
    renderApp(); toast('单价已保存');
  };

  const exp = $('[data-export]', v); if (exp) exp.onclick = exportBackup;
  const imp = $('#importFile', v); if (imp) imp.onchange = (ev) => importBackup(ev.target.files[0]);

  const clr = $('[data-clear]', v);
  if (clr) clr.onclick = async () => {
    if (!(await confirmDialog('清空所有数据？', '将删除全部记录、学员和照片（不含密码与单价设置），无法恢复。建议先导出备份。'))) return;
    if (!(await confirmDialog('再次确认', '真的要清空吗？此操作不可撤销。'))) return;
    await dbClear('sessions'); await dbClear('photos'); await dbClear('students');
    await reloadData();
    state.view = 'sessions';
    renderApp(); toast('已清空');
  };
}

async function exportBackup() {
  toast('正在导出…');
  const students = await dbGetAll('students');
  const sessions = await dbGetAll('sessions');
  const photosRaw = await dbGetAll('photos');
  const settings = await getSettings();
  const photos = [];
  for (const p of photosRaw) photos.push({ id: p.id, sessionId: p.sessionId, w: p.w, h: p.h, createdAt: p.createdAt, dataUrl: await blobToDataUrl(p.blob) });
  const data = { app: 'pt-class-system', version: 1, exportedAt: new Date().toISOString(), students, sessions, settings, photos };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `课时记录备份-${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importBackup(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('文件格式错误'); return; }
  if (!data || data.app !== 'pt-class-system') { toast('不是有效的备份文件'); return; }
  const n = (data.sessions || []).length;
  if (!(await confirmDialog('导入备份？', `将用备份覆盖当前数据（含 ${n} 条记录）。当前未备份的数据会丢失。`))) return;
  try {
    await dbClear('students'); await dbClear('sessions'); await dbClear('photos');
    for (const s of data.students || []) await dbPut('students', s);
    for (const s of data.sessions || []) await dbPut('sessions', s);
    for (const p of data.photos || []) {
      const blob = await dataUrlToBlob(p.dataUrl);
      await dbPut('photos', { id: p.id, sessionId: p.sessionId, w: p.w, h: p.h, createdAt: p.createdAt, blob });
    }
    if (data.settings) { await saveSettings(data.settings); state.settings = await getSettings(); }
    await reloadData();
    state.view = 'sessions';
    renderApp(); toast('导入成功');
  } catch (e) {
    toast('导入失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

/* ============================================================
 * 通用组件：模态框 / 确认 / 登录 / 大图 / Toast
 * ============================================================ */
function openModal(title, bodyHtml, actions) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal"><h3>${escapeHtml(title)}</h3><div class="modal-body">${bodyHtml}</div>
    <div class="form-actions" style="margin-top:18px">${actions.map((a, i) => `<button class="btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}" data-act="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>
  </div>`;
  document.body.appendChild(back);
  const modal = $('.modal', back);
  back.onclick = (e) => { if (e.target === back) closeModal(); };
  actions.forEach((a, i) => {
    $(`[data-act="${i}"]`, back).onclick = async (ev) => {
      ev.preventDefault();
      if (a.onClick) { const r = await a.onClick(modal); if (r === false) return; }
      if (a.close || a.onClick) closeModal();
    };
  });
  const first = $('input', modal); if (first) setTimeout(() => first.focus(), 50);
  return modal;
}
function closeModal() { const b = $('.modal-backdrop'); if (b) b.remove(); }
function confirmDialog(title, msg) {
  return new Promise((resolve) => {
    openModal(title, `<p style="margin:0;color:#475569">${escapeHtml(msg || '')}</p>`, [
      { label: '取消', kind: 'ghost', onClick: () => { resolve(false); } },
      { label: '确定', kind: 'danger', onClick: () => { resolve(true); } },
    ]);
  });
}
function openLoginModal() {
  openModal('登录编辑', `<div class="form"><label class="field"><span class="field-label">请输入编辑密码</span><input type="password" id="loginPw" autocomplete="current-password"></label></div>`, [
    { label: '取消', kind: 'ghost', close: true },
    { label: '登录', kind: 'primary', onClick: async (m) => {
      const pw = $('#loginPw', m).value;
      if (!(await verifyPassword(pw, await getAuthHash()))) { toast('密码不正确'); return false; }
      state.edit = true; sessionStorage.setItem('pt_edit', '1');
      renderApp(); toast('已解锁编辑');
    } },
  ]);
  const inp = $('#loginPw');
  if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { const b = $('.modal-backdrop [data-act="1"]'); if (b) b.click(); } };
}
function openLightbox(url) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${url}" alt="">`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
}
let toastTimer = null;
function toast(msg) {
  const old = $('.toast'); if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.remove(); }, 2200);
}

/* ---------- go ---------- */
boot();
