'use strict';

/* ============================================================
 * 课时工资记录 —— 前端（与本地 Python 服务 + SQLite 通信）
 * 数据保存在服务端的 data.db（真实 SQLite 文件）。
 * 登录（密码）= 解锁编辑；未登录只能预览。
 * ============================================================ */

/* ---------- 常量 ---------- */
const COURSES = {
  cpp:    { label: 'C++',    mode: 'perHead', defaultRate: 30 },
  python: { label: 'Python', mode: 'perHead', defaultRate: 25 },
  school: { label: '入校',   mode: 'perVisit' },
};
const COURSE_ORDER = ['cpp', 'python', 'school'];

/* ---------- 工具 ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthOf(s) { return (s || '').slice(0, 7); }
function curMonth() { return todayStr().slice(0, 7); }
function stepMonth(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad2(m)}`;
}
function monthLabel(ym) { const [y, m] = ym.split('-'); return `${y}年${Number(m)}月`; }
function fmtMoney(n) { n = Math.round((Number(n) || 0) * 100) / 100; return '¥' + n.toLocaleString('zh-CN'); }
function weekdayCN(s) {
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  try { return '周' + wd[new Date(s + 'T00:00:00').getDay()]; } catch (e) { return ''; }
}
function fmtDateCN(s) {
  if (!s) return '';
  const w = weekdayCN(s);
  return s + (w ? ' ' + w : '');
}
function fmtClock(t) { return t ? String(t).slice(0, 5) : ''; }  // HH:MM
function nowLocalDatetime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function csvCell(v) {
  v = String(v == null ? '' : v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function uid() { return 'tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

/* ---------- 后端 API ---------- */
async function api(path, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const headers = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth) {
    const t = sessionStorage.getItem('pt_token');
    if (t) headers['Authorization'] = 'Bearer ' + t;
  }
  let res;
  try {
    res = await fetch('/api' + path, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    const err = new Error('无法连接本地服务'); err.network = true; throw err;
  }
  if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
  if (opts.raw) return res;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res;
}

/* ---------- 图片压缩（前端，压缩后再上传） ---------- */
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
  } catch (e) { /* 回退原图 */ }
  return { blob: file, w: 0, h: 0 };
}
function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

/* ---------- 状态 ---------- */
const state = {
  view: 'sessions',
  edit: false,
  hasPassword: false,
  settings: { rates: { cpp: 30, python: 25 }, schoolMin: 100 },
  students: [],
  sessions: [],
  detailId: null,
  editor: null,
  salaryMonth: curMonth(),
  tableCourse: 'all',
  tableMonth: 'all',
};

/* ---------- 计算 ---------- */
function sessionHeads(s) { return (s.attendees ? s.attendees.length : 0) + (Number(s.extra) || 0); }
function sessionPay(s) {
  if (s.courseType === 'school') return Number(s.amount) || 0;
  const rate = state.settings.rates[s.courseType] ?? COURSES[s.courseType].defaultRate;
  return sessionHeads(s) * rate;
}
function computeMonth(ym) {
  const list = state.sessions.filter((s) => monthOf(s.date) === ym);
  const r = state.settings.rates;
  const acc = {
    cpp: { count: 0, heads: 0, pay: 0 }, python: { count: 0, heads: 0, pay: 0 },
    school: { count: 0, pay: 0 }, total: 0,
  };
  for (const s of list) {
    if (s.courseType === 'school') {
      const p = Number(s.amount) || 0; acc.school.count++; acc.school.pay += p; acc.total += p;
    } else {
      const heads = sessionHeads(s);
      const rate = r[s.courseType] ?? COURSES[s.courseType].defaultRate;
      const p = heads * rate;
      acc[s.courseType].count++; acc[s.courseType].heads += heads; acc[s.courseType].pay += p; acc.total += p;
    }
  }
  return { list, acc };
}
function allTimeTotal() { return state.sessions.reduce((sum, s) => sum + sessionPay(s), 0); }

/* ---------- 启动 ---------- */
async function boot() {
  cleanupServiceWorker();
  let st;
  try { st = await api('/state'); }
  catch (e) { document.getElementById('app').innerHTML = bootError(); return; }
  state.hasPassword = !!st.hasPassword;
  state.edit = !state.hasPassword;
  if (state.hasPassword && sessionStorage.getItem('pt_token')) {
    try { await api('/auth/check', { auth: true }); state.edit = true; }
    catch (e) { sessionStorage.removeItem('pt_token'); state.edit = false; }
  }
  try { await reloadData(); }
  catch (e) { document.getElementById('app').innerHTML = bootError(); return; }
  renderApp();
}
function bootError() {
  return `<div class="boot">
    <div style="font-size:40px;margin-bottom:8px">🔌</div>
    <p style="font-size:16px;color:#0f172a;font-weight:700">未连接到本地服务</p>
    <p>请在项目文件夹里运行下面这条命令，再刷新本页：</p>
    <p style="font-family:ui-monospace,Menlo,monospace;background:#f1f5f9;padding:10px 14px;border-radius:8px;display:inline-block;color:#0f172a">python3 server.py</p>
    <p class="muted" style="margin-top:12px">（Mac 也可双击项目里的 <strong>start.command</strong>）</p>
  </div>`;
}
async function reloadData() {
  const [students, sessions, settings] = await Promise.all([
    api('/students'), api('/sessions'), api('/settings'),
  ]);
  state.students = students.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  state.sessions = sessions;
  state.settings = {
    rates: Object.assign({ cpp: 30, python: 25 }, (settings && settings.rates) || {}),
    schoolMin: (settings && settings.schoolMin) ?? 100,
  };
}
function cleanupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }
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
  const titles = {
    sessions: '课时记录', table: '记录表格', students: '学员', salary: '工资统计', settings: '设置',
    sessionDetail: '课程详情', sessionEdit: state.editor && state.editor.id ? '编辑记录' : '新增记录',
  };
  const showBack = ['sessionDetail', 'sessionEdit'].includes(state.view);
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-ico">📋</span><span class="brand-name">课时工资</span></div>
        <nav class="nav">
          ${navItem('sessions', '📋', '记录')}
          ${navItem('table', '📊', '表格')}
          ${navItem('students', '👥', '学员')}
          ${navItem('salary', '💰', '工资')}
          ${navItem('settings', '⚙️', '设置')}
        </nav>
      </aside>
      <div class="main-col">
        <header class="app-header">
          <div class="hdr-l">${showBack
            ? '<button class="hdr-back" data-back>‹ 返回</button>'
            : `<span class="hdr-title">${titles[state.view] || ''}</span>`}</div>
          <div class="hdr-r">${lockControlHtml()}</div>
        </header>
        <main class="view view-${state.view}" id="view"></main>
      </div>
    </div>`;
  if (showBack) $('[data-back]').onclick = onBack;
  const lb = $('[data-lock]'); if (lb) lb.onclick = onLockClick;
  $all('.nav-item').forEach((t) => { t.onclick = () => go(t.dataset.view); });
  renderView();
}
function navItem(view, ico, label) {
  const active = tabGroup() === view ? ' active' : '';
  return `<button class="nav-item${active}" data-view="${view}"><span class="ico">${ico}</span><span class="lbl">${label}</span></button>`;
}
function lockControlHtml() {
  if (!state.hasPassword) return '<span class="lock-tag">编辑模式（未设密码）</span>';
  return state.edit
    ? '<button class="lock-btn unlocked" data-lock>🔓 管理员</button>'
    : '<button class="lock-btn locked" data-lock>🔒 管理员登录</button>';
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
    state.edit = false; sessionStorage.removeItem('pt_token');
    toast('已锁定，进入预览模式'); renderApp();
  } else { openLoginModal(); }
}
function renderView() {
  const v = document.getElementById('view');
  if (!v) return;
  switch (state.view) {
    case 'sessions': v.innerHTML = viewSessions(); bindSessions(v); break;
    case 'table': v.innerHTML = viewTable(); bindTable(v); break;
    case 'sessionDetail': v.innerHTML = viewSessionDetail(); bindSessionDetail(v); break;
    case 'sessionEdit': v.innerHTML = viewSessionEdit(); bindSessionEdit(v); break;
    case 'students': v.innerHTML = viewStudents(); bindStudents(v); break;
    case 'salary': v.innerHTML = viewSalary(); bindSalary(v); break;
    case 'settings': v.innerHTML = viewSettings(); bindSettings(v); break;
  }
}

/* ============================================================ 记录列表 */
function viewSessions() {
  const { acc } = computeMonth(curMonth());
  let html = `
    <div class="stat-hero">
      <div class="label">本月预计工资（${monthLabel(curMonth())}）</div>
      <div class="value">${fmtMoney(acc.total)}</div>
      <div class="sub">C++ ${acc.cpp.heads}人次 · Python ${acc.python.heads}人次 · 入校 ${acc.school.count}次</div>
    </div>
    <div class="section-head"><h2>全部记录</h2>${state.edit ? '<button class="btn btn-primary btn-sm btn-add" data-add>＋ 新增记录</button>' : ''}</div>`;
  if (state.sessions.length === 0) {
    html += `<div class="empty"><div class="big">📋</div><div>还没有上课记录</div>${state.edit ? '<div class="muted" style="margin-top:6px">点右上角「新增记录」开始，或先载入演示数据看看效果</div><button class="btn btn-ghost" style="margin-top:14px" data-demo>🎬 载入演示数据</button>' : ''}</div>`;
    return html;
  }
  const groups = {};
  for (const s of state.sessions) { const ym = monthOf(s.date) || '未知'; (groups[ym] = groups[ym] || []).push(s); }
  for (const ym of Object.keys(groups).sort((a, b) => b.localeCompare(a))) {
    const items = groups[ym];
    const sum = items.reduce((t, s) => t + sessionPay(s), 0);
    html += `<div class="month-group">
      <div class="month-bar"><span class="m-name">${monthLabel(ym)}</span><span><span class="m-sum">${fmtMoney(sum)}</span> <span class="m-cnt">· ${items.length}节</span></span></div>
      ${items.map(sessionCard).join('')}</div>`;
  }
  return html;
}
function sessionCard(s) {
  const c = COURSES[s.courseType];
  let meta;
  if (s.courseType === 'school') meta = `入校 · ${fmtMoney(s.amount)}`;
  else { const rate = state.settings.rates[s.courseType] ?? c.defaultRate; meta = `${sessionHeads(s)} 人 × ¥${rate}`; }
  const photo = (s.photoIds && s.photoIds.length) ? `<span class="sc-photo">📷 ${s.photoIds.length}</span>` : '';
  return `<div class="session-card" data-id="${s.id}">
    <div class="sc-main">
      <div class="sc-top"><span class="sc-date">${fmtDateCN(s.date)}${s.time ? ' ' + fmtClock(s.time) : ''}</span><span class="badge ${s.courseType}">${c.label}</span></div>
      <div class="sc-meta">${meta} ${photo}</div>
    </div>
    <div class="sc-pay">${fmtMoney(sessionPay(s))}</div>
    <span class="chevron">›</span>
  </div>`;
}
function bindSessions(v) {
  const add = $('[data-add]', v); if (add) add.onclick = () => startEditor(null);
  const dm = $('[data-demo]', v); if (dm) dm.onclick = loadDemo;
  $all('.session-card', v).forEach((el) => { el.onclick = () => { state.detailId = el.dataset.id; go('sessionDetail'); }; });
}

/* ============================================================ 课程详情 */
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
    const names = named
      ? `<div class="name-chips">${s.attendees.map((a) => `<span class="name-chip">${escapeHtml(a.name)}</span>`).join('')}</div>`
      : '<div class="muted" style="margin-top:6px">未记名</div>';
    breakdown += `<div style="padding-top:10px"><div class="muted" style="font-size:13px">学员（${named}）</div>${names}</div>`;
  }
  const ids = s.photoIds || [];
  const photosHtml = ids.length
    ? `<div class="photo-grid view">${ids.map((id) => `<div class="photo-thumb" data-full="/api/photos/${id}"><img src="/api/photos/${id}" loading="lazy" alt="上课照片"></div>`).join('')}</div>`
    : '<div class="muted">无照片</div>';
  return `
    <div class="card">
      <div class="row-between" style="margin-bottom:10px">
        <span class="badge ${s.courseType}">${c.label}</span><span class="muted">${fmtDateCN(s.date)}${s.time ? ' ' + s.time : ''}</span>
      </div>
      <div class="detail-pay">${fmtMoney(sessionPay(s))}</div>
    </div>
    <div class="card">${breakdown}</div>
    <div class="card"><p class="card-title">上课照片</p>${photosHtml}</div>
    ${s.note ? `<div class="card"><p class="card-title">备注</p><div class="note-box">${escapeHtml(s.note)}</div></div>` : ''}
    ${state.edit ? `<div class="form-actions"><button class="btn btn-ghost" data-edit>编辑</button><button class="btn btn-danger" data-del>删除</button></div>` : ''}`;
}
function bindSessionDetail(v) {
  const s = state.sessions.find((x) => x.id === state.detailId);
  if (!s) return;
  $all('.photo-thumb', v).forEach((t) => { t.onclick = () => openLightbox(t.dataset.full); });
  const ed = $('[data-edit]', v); if (ed) ed.onclick = () => startEditor(s);
  const del = $('[data-del]', v); if (del) del.onclick = () => deleteSession(s);
}
async function deleteSession(s) {
  if (!(await confirmDialog('删除这条记录？', '照片也会一并删除，无法恢复。'))) return;
  try {
    await api('/sessions/' + s.id, { method: 'DELETE', auth: true });
    await reloadData();
    state.detailId = null; go('sessions'); toast('已删除');
  } catch (e) { handleErr(e, '删除失败'); }
}

/* ============================================================ 新增/编辑 */
function startEditor(session) {
  const selected = new Map();
  if (session && session.attendees) for (const a of session.attendees) selected.set(a.id, a.name);
  const rosterIds = new Set(state.students.map((s) => s.id));
  const rosterExtra = [];
  if (session && session.attendees) for (const a of session.attendees) if (!rosterIds.has(a.id)) rosterExtra.push({ id: a.id, name: a.name });
  const photos = session && session.photoIds
    ? session.photoIds.map((id) => ({ id, existing: true, url: '/api/photos/' + id }))
    : [];
  state.editor = {
    id: session ? session.id : null,
    dt: session ? (session.date + 'T' + (session.time || nowLocalDatetime().slice(11))) : nowLocalDatetime(),
    courseType: session ? session.courseType : 'cpp',
    selected, rosterExtra,
    extra: session ? (session.extra || 0) : 0,
    amount: session ? (session.amount ?? state.settings.schoolMin) : state.settings.schoolMin,
    note: session ? (session.note || '') : '',
    photos,
    removed: [],
  };
  go('sessionEdit');
}
function cleanupEditor() {
  if (state.editor) state.editor.photos.forEach((p) => { if (!p.existing && p.url) { try { URL.revokeObjectURL(p.url); } catch (e) {} } });
}
function viewSessionEdit() {
  const e = state.editor;
  const isSchool = e.courseType === 'school';
  return `
    <form class="form" id="sessForm">
      <label class="field"><span class="field-label">日期与时间</span><input type="datetime-local" name="dt" step="1" value="${e.dt}" required></label>
      <div class="field"><span class="field-label">课程类型</span>
        <div class="seg" id="segCourse">${COURSE_ORDER.map((k) => `<button type="button" data-c="${k}" class="${e.courseType === k ? 'active' : ''}">${COURSES[k].label}</button>`).join('')}</div>
      </div>
      <div class="field" id="attendBlock">
        <span class="field-label">出勤学员 <span class="muted" id="attendCount"></span></span>
        <div class="chip-wrap" id="chips"></div>
        <div class="quick-add"><input type="text" id="qaName" placeholder="临时添加学员姓名" autocomplete="off"><button type="button" class="btn btn-sm" id="qaBtn">添加</button></div>
        <label class="field" id="extraField" style="margin-top:4px"><span class="field-label">其他不记名人数（可选，计入人头）</span><input type="number" name="extra" min="0" step="1" value="${e.extra || 0}"></label>
      </div>
      <label class="field" id="amountBlock" style="display:${isSchool ? 'flex' : 'none'}">
        <span class="field-label">入校金额（学校支付，一般 ≥ ${state.settings.schoolMin} 元）</span>
        <input type="number" name="amount" min="0" step="1" value="${e.amount}"><span class="hint" id="amountHint"></span>
      </label>
      <label class="field"><span class="field-label">备注（可选）</span><textarea name="note" rows="2" placeholder="教学内容、班级、学校名称等">${escapeHtml(e.note)}</textarea></label>
      <div class="field"><span class="field-label">上课照片 <span class="muted">（可截图后 ⌘/Ctrl+V 直接粘贴）</span></span><div class="photo-grid" id="photoGrid"></div>
        <label class="btn btn-ghost photo-add">＋ 添加照片 / 粘贴<input type="file" id="photoInput" accept="image/*" multiple hidden></label></div>
      <div class="pay-preview" id="payPreview"></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-back>取消</button><button type="submit" class="btn btn-primary" id="saveBtn">保存</button></div>
    </form>`;
}
function bindSessionEdit(v) {
  const e = state.editor;
  $('[data-back]', v).onclick = onBack;
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
  renderChips(v);
  const qaAdd = async () => {
    const inp = $('#qaName', v);
    const name = inp.value.trim();
    if (!name) return;
    try {
      const r = await api('/students', { method: 'POST', body: { name }, auth: true });
      state.students.push({ id: r.id, name, note: '', active: true });
      state.students.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
      e.selected.set(r.id, name);
      inp.value = ''; renderChips(v); updatePreview(v);
    } catch (err) { handleErr(err, '添加失败'); }
  };
  $('#qaBtn', v).onclick = qaAdd;
  $('#qaName', v).onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); qaAdd(); } };
  $('[name="extra"]', v).oninput = () => updatePreview(v);
  $('[name="amount"]', v).oninput = () => updatePreview(v);
  $('#photoInput', v).onchange = (ev) => onPhotoPick(ev.target.files, v);
  renderPhotoGrid(v);
  updatePreview(v);
  $('#sessForm', v).onsubmit = (ev) => { ev.preventDefault(); saveSession(v); };
}
function rosterForPicker() {
  const e = state.editor;
  const map = new Map();
  for (const s of state.students) if (s.active !== false || e.selected.has(s.id)) map.set(s.id, s.name);
  for (const a of e.rosterExtra) if (!map.has(a.id)) map.set(a.id, a.name);
  for (const [id, name] of e.selected) if (!map.has(id)) map.set(id, name);
  return Array.from(map, ([id, name]) => ({ id, name }));
}
function renderChips(v) {
  const e = state.editor;
  const box = $('#chips', v);
  const list = rosterForPicker();
  if (!list.length) { box.innerHTML = '<span class="chip empty-hint">还没有学员，在下方输入姓名添加</span>'; return; }
  box.innerHTML = list.map((s) =>
    `<button type="button" class="chip ${e.selected.has(s.id) ? 'selected' : ''}" data-sid="${s.id}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`).join('');
  $all('.chip[data-sid]', box).forEach((chip) => {
    chip.onclick = () => {
      const id = chip.dataset.sid;
      if (e.selected.has(id)) e.selected.delete(id); else e.selected.set(id, chip.dataset.name);
      chip.classList.toggle('selected'); updatePreview(v);
    };
  });
}
function updatePreview(v) {
  const e = state.editor;
  const cnt = $('#attendCount', v);
  const prev = $('#payPreview', v);
  if (e.courseType === 'school') {
    const a = Number($('[name="amount"]', v).value) || 0;
    prev.textContent = `应得 ${fmtMoney(a)}`;
    const hint = $('#amountHint', v);
    const low = a > 0 && a < state.settings.schoolMin;
    hint.textContent = low ? `提示：低于常见标准（${state.settings.schoolMin} 元）` : '';
    hint.className = low ? 'hint warn' : 'hint';
    if (cnt) cnt.textContent = `已选 ${e.selected.size} 人`;
  } else {
    const extra = Number($('[name="extra"]', v).value) || 0;
    const heads = e.selected.size + extra;
    const rate = state.settings.rates[e.courseType] ?? COURSES[e.courseType].defaultRate;
    if (cnt) cnt.textContent = `已选 ${e.selected.size} 人`;
    prev.textContent = `${e.selected.size}人${extra ? ' ＋ ' + extra + '人' : ''} × ¥${rate} = ${fmtMoney(heads * rate)}`;
  }
}
async function onPhotoPick(files, v) {
  const e = state.editor;
  const label = $('.photo-add', v);
  const orig = label.innerHTML;
  label.innerHTML = '<span class="spin"></span> 处理中…';
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) continue;
    const { blob, w, h } = await compressImage(f);
    e.photos.push({ id: uid(), blob, w, h, url: URL.createObjectURL(blob), existing: false });
  }
  label.innerHTML = orig;
  const input = $('#photoInput', v);
  input.value = '';
  input.onchange = (ev) => onPhotoPick(ev.target.files, v);
  renderPhotoGrid(v);
}
function renderPhotoGrid(v) {
  const e = state.editor;
  const grid = $('#photoGrid', v);
  if (!grid) return;
  if (!e.photos.length) { grid.innerHTML = '<div class="muted" style="grid-column:1/-1">未添加照片</div>'; return; }
  grid.innerHTML = e.photos.map((p) =>
    `<div class="photo-thumb"><img src="${p.url}" alt=""><button type="button" class="rm" data-pid="${p.id}">✕</button></div>`).join('');
  $all('.rm', grid).forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.pid;
      const idx = e.photos.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const p = e.photos[idx];
      if (p.existing) e.removed.push(p.id);
      else { try { URL.revokeObjectURL(p.url); } catch (er) {} }
      e.photos.splice(idx, 1);
      renderPhotoGrid(v);
    };
  });
}
async function saveSession(v) {
  const e = state.editor;
  const btn = $('#saveBtn', v);
  const dt = $('[name="dt"]', v).value;
  if (!dt) { toast('请选择日期与时间'); return; }
  const date = dt.slice(0, 10);
  let time = dt.length > 10 ? dt.slice(11) : '';
  if (time.length === 5) time += ':00';  // HH:MM -> HH:MM:SS
  const note = $('[name="note"]', v).value.trim();
  const attendees = Array.from(e.selected, ([id, name]) => ({ id, name }));
  const payload = { date, time, courseType: e.courseType, note, attendees };
  if (e.courseType === 'school') {
    const amount = Number($('[name="amount"]', v).value) || 0;
    if (amount <= 0) { toast('请填写入校金额'); return; }
    payload.amount = amount; payload.extra = 0;
  } else {
    payload.extra = Number($('[name="extra"]', v).value) || 0;
    if (attendees.length === 0 && payload.extra === 0) {
      if (!(await confirmDialog('出勤人数为 0？', '这节课工资将记为 ¥0，确定保存吗？'))) return;
    }
  }
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    let id = e.id;
    if (id) await api('/sessions/' + id, { method: 'PUT', body: payload, auth: true });
    else { const r = await api('/sessions', { method: 'POST', body: payload, auth: true }); id = r.id; }
    for (const p of e.photos) {
      if (!p.existing) {
        const dataUrl = await blobToDataUrl(p.blob);
        await api('/sessions/' + id + '/photos', { method: 'POST', body: { dataUrl, w: p.w, h: p.h }, auth: true });
      }
    }
    for (const rid of e.removed) await api('/photos/' + rid, { method: 'DELETE', auth: true });
    await reloadData();
    cleanupEditor(); state.editor = null;
    state.detailId = id; go('sessionDetail'); toast('已保存');
  } catch (err) {
    btn.disabled = false; btn.textContent = '保存';
    handleErr(err, '保存失败');
  }
}

/* ============================================================ 学员 */
function studentStats(id) {
  let count = 0;
  for (const s of state.sessions) if (s.attendees && s.attendees.some((a) => a.id === id)) count++;
  return count;
}
function viewStudents() {
  let html = `<div class="section-head"><h2>学员库（${state.students.length}）</h2>${state.edit ? '<button class="btn btn-primary btn-sm" data-addst>＋ 添加学员</button>' : ''}</div>`;
  if (!state.students.length) {
    html += `<div class="empty"><div class="big">👥</div><div>还没有学员</div>${state.edit ? '<div class="muted" style="margin-top:6px">添加后，记录出勤时可直接勾选</div>' : ''}</div>`;
    return html;
  }
  html += '<div class="card">' + state.students.map((s) => {
    const inactive = s.active === false;
    return `<div class="student-row ${inactive ? 'inactive' : ''}">
      <div class="avatar">${escapeHtml((s.name || '?').slice(0, 1))}</div>
      <div class="s-main"><div class="s-name">${escapeHtml(s.name)} ${inactive ? '<span class="muted">（已停用）</span>' : ''}</div>
        <div class="s-sub">出勤 ${studentStats(s.id)} 次${s.note ? ' · ' + escapeHtml(s.note) : ''}</div></div>
      ${state.edit ? `<div class="s-act"><button class="icon-btn" data-edit="${s.id}">✎</button><button class="icon-btn" data-del="${s.id}">🗑</button></div>` : ''}
    </div>`;
  }).join('') + '</div>';
  return html;
}
function bindStudents(v) {
  const add = $('[data-addst]', v); if (add) add.onclick = () => openStudentModal(null);
  $all('[data-edit]', v).forEach((b) => { b.onclick = () => openStudentModal(state.students.find((s) => s.id === b.dataset.edit)); });
  $all('[data-del]', v).forEach((b) => { b.onclick = () => deleteStudent(state.students.find((s) => s.id === b.dataset.del)); });
}
function openStudentModal(student) {
  const editing = !!student;
  const body = `<div class="form">
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
      try {
        if (editing) await api('/students/' + student.id, { method: 'PUT', body: { name, note, active }, auth: true });
        else await api('/students', { method: 'POST', body: { name, note }, auth: true });
        await reloadData(); renderApp(); toast('已保存');
      } catch (e) { handleErr(e, '保存失败'); return false; }
    } },
  ]);
}
async function deleteStudent(s) {
  if (!s) return;
  const att = studentStats(s.id);
  const msg = att > 0 ? `该学员已出现在 ${att} 条记录中。删除后这些记录里仍保留姓名，但学员库中会移除。` : '从学员库中移除该学员。';
  if (!(await confirmDialog(`删除「${s.name}」？`, msg))) return;
  try { await api('/students/' + s.id, { method: 'DELETE', auth: true }); await reloadData(); renderApp(); toast('已删除'); }
  catch (e) { handleErr(e, '删除失败'); }
}

/* ============================================================ 工资统计 */
function viewSalary() {
  const ym = state.salaryMonth;
  const { list, acc } = computeMonth(ym);
  const rates = state.settings.rates;
  const rows = `
    <div class="breakdown-row"><div><span class="badge cpp">C++</span></div><div class="bk-info">${acc.cpp.count}节 · ${acc.cpp.heads}人次 × ¥${rates.cpp}</div><div class="bk-pay">${fmtMoney(acc.cpp.pay)}</div></div>
    <div class="breakdown-row"><div><span class="badge python">Python</span></div><div class="bk-info">${acc.python.count}节 · ${acc.python.heads}人次 × ¥${rates.python}</div><div class="bk-pay">${fmtMoney(acc.python.pay)}</div></div>
    <div class="breakdown-row"><div><span class="badge school">入校</span></div><div class="bk-info">${acc.school.count}次</div><div class="bk-pay">${fmtMoney(acc.school.pay)}</div></div>
    <div class="total-row"><span class="t-label">本月合计</span><span class="t-val">${fmtMoney(acc.total)}</span></div>`;
  let miniList;
  if (list.length) {
    miniList = `<div class="card"><p class="card-title">本月明细（${list.length}）</p><div class="list-mini">` +
      list.map((s) => {
        const c = COURSES[s.courseType];
        const sub = s.courseType === 'school' ? '入校' : `${sessionHeads(s)}人`;
        return `<div class="mini-row" data-id="${s.id}"><div class="mr-l"><span class="mr-date">${fmtDateCN(s.date)}</span><span class="badge ${s.courseType}">${c.label}</span><span class="muted">${sub}</span></div><div class="bk-pay">${fmtMoney(sessionPay(s))}</div></div>`;
      }).join('') + '</div></div>';
  } else { miniList = '<div class="empty"><div>本月暂无记录</div></div>'; }
  return `
    <div class="card">
      <div class="month-nav"><button data-prev>‹</button><span class="cur">${monthLabel(ym)}</span><button data-next>›</button></div>
      ${rows}
    </div>
    ${miniList}
    <div class="card"><div class="row-between"><span class="muted">所有记录累计工资</span><strong style="font-size:18px">${fmtMoney(allTimeTotal())}</strong></div></div>`;
}
function bindSalary(v) {
  $('[data-prev]', v).onclick = () => { state.salaryMonth = stepMonth(state.salaryMonth, -1); renderApp(); };
  $('[data-next]', v).onclick = () => { state.salaryMonth = stepMonth(state.salaryMonth, 1); renderApp(); };
  $all('.mini-row', v).forEach((el) => { el.onclick = () => { state.detailId = el.dataset.id; go('sessionDetail'); }; });
}

/* ============================================================ 记录表格（类 Excel） */
function filteredTableRows() {
  return state.sessions.filter((s) =>
    (state.tableCourse === 'all' || s.courseType === state.tableCourse) &&
    (state.tableMonth === 'all' || monthOf(s.date) === state.tableMonth));
}
function viewTable() {
  const rows = filteredTableRows();
  const months = Array.from(new Set(state.sessions.map((s) => monthOf(s.date)).filter(Boolean))).sort((a, b) => b.localeCompare(a));
  const filters = [['all', '全部'], ['cpp', 'C++'], ['python', 'Python'], ['school', '入校']];
  const toolbar = `
    <div class="toolbar">
      <div class="seg seg-sm" id="tblCourse">
        ${filters.map(([k, l]) => `<button type="button" data-c="${k}" class="${state.tableCourse === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="toolbar-right">
        <select id="tblMonth" class="sel-sm">
          <option value="all" ${state.tableMonth === 'all' ? 'selected' : ''}>全部月份</option>
          ${months.map((m) => `<option value="${m}" ${state.tableMonth === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-export-csv>⬇️ 导出 Excel</button>
      </div>
    </div>`;
  if (!rows.length) {
    return toolbar + '<div class="empty"><div class="big">📊</div><div>没有符合条件的记录</div></div>';
  }
  let totHeads = 0, totPay = 0, totPhotos = 0;
  const body = rows.map((s) => {
    const c = COURSES[s.courseType];
    const isSchool = s.courseType === 'school';
    if (!isSchool) totHeads += sessionHeads(s);
    totPay += sessionPay(s);
    const np = (s.photoIds || []).length;
    totPhotos += np;
    const rate = isSchool ? '<span class="muted">按次</span>' : ('¥' + (state.settings.rates[s.courseType] ?? c.defaultRate));
    const names = (s.attendees || []).map((a) => a.name).join('、');
    return `<tr data-id="${s.id}">
      <td class="nowrap">${s.date}<span class="wd">${weekdayCN(s.date)}${s.time ? ' ' + fmtClock(s.time) : ''}</span></td>
      <td><span class="badge ${s.courseType}">${c.label}</span></td>
      <td class="num">${isSchool ? '<span class="muted">—</span>' : sessionHeads(s)}</td>
      <td><span class="ell" title="${escapeHtml(names)}">${names ? escapeHtml(names) : '<span class="muted">—</span>'}</span></td>
      <td class="num">${rate}</td>
      <td class="num pay">${fmtMoney(sessionPay(s))}</td>
      <td class="num">${np || ''}</td>
      <td><span class="ell" title="${escapeHtml(s.note || '')}">${escapeHtml(s.note || '')}</span></td>
    </tr>`;
  }).join('');
  return toolbar + `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>日期</th><th>课程</th><th class="num">出勤</th><th>学员</th><th class="num">单价</th><th class="num">金额</th><th class="num">照片</th><th>备注</th>
        </tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr class="tfoot">
          <td colspan="2">合计 ${rows.length} 节</td>
          <td class="num">${totHeads}</td>
          <td></td><td></td>
          <td class="num pay">${fmtMoney(totPay)}</td>
          <td class="num">${totPhotos || ''}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>`;
}
function bindTable(v) {
  $all('#tblCourse button', v).forEach((b) => { b.onclick = () => { state.tableCourse = b.dataset.c; renderApp(); }; });
  const ms = $('#tblMonth', v); if (ms) ms.onchange = () => { state.tableMonth = ms.value; renderApp(); };
  const ex = $('[data-export-csv]', v); if (ex) ex.onclick = exportCsv;
  $all('tbody tr[data-id]', v).forEach((tr) => { tr.onclick = () => { state.detailId = tr.dataset.id; go('sessionDetail'); }; });
}
function exportCsv() {
  const rows = filteredTableRows();
  if (!rows.length) { toast('没有可导出的记录'); return; }
  const header = ['日期', '时间', '星期', '课程', '出勤人数', '学员', '单价(元)', '金额(元)', '照片数', '备注'];
  const data = [header];
  let totHeads = 0, totPay = 0;
  for (const s of rows) {
    const c = COURSES[s.courseType];
    const isSchool = s.courseType === 'school';
    if (!isSchool) totHeads += sessionHeads(s);
    totPay += sessionPay(s);
    data.push([
      s.date, s.time || '', weekdayCN(s.date), c.label,
      isSchool ? '' : sessionHeads(s),
      (s.attendees || []).map((a) => a.name).join(' '),
      isSchool ? '按次' : (state.settings.rates[s.courseType] ?? c.defaultRate),
      sessionPay(s), (s.photoIds || []).length, s.note || '',
    ]);
  }
  data.push(['合计', '', '', '', totHeads, '', '', totPay, '', '']);
  const csv = data.map((r) => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `课时记录-${todayStr()}.csv`);
  toast('已导出 ' + rows.length + ' 条记录');
}

/* ============================================================ 设置 */
function viewSettings() {
  const s = state.settings;
  let lockCard;
  if (!state.hasPassword) {
    lockCard = `<div class="card"><p class="card-title">管理员密码</p>
      <div class="banner">尚未设置管理员密码，当前任何人打开都能编辑。设置后，未登录只能查看，需管理员登录才能编辑。</div>
      <div class="form">
        <label class="field"><span class="field-label">设置管理员密码</span><input type="password" id="pw1" placeholder="输入密码" autocomplete="new-password"></label>
        <label class="field"><span class="field-label">确认密码</span><input type="password" id="pw2" placeholder="再次输入" autocomplete="new-password"></label>
        <button class="btn btn-primary" data-setpw>启用管理员登录</button>
      </div></div>`;
  } else {
    lockCard = `<div class="card"><p class="card-title">管理员密码</p>
      <div class="muted" style="margin-bottom:12px">已启用。未登录只能查看，点右上角「管理员登录」输入密码后可编辑。</div>
      ${state.edit ? `<div class="form">
        <label class="field"><span class="field-label">当前密码</span><input type="password" id="pwOld" autocomplete="current-password"></label>
        <label class="field"><span class="field-label">新密码（留空 = 取消密码锁）</span><input type="password" id="pwNew" autocomplete="new-password"></label>
        <button class="btn" data-chpw>更新密码</button>
      </div>` : '<div class="muted">登录后可修改密码。</div>'}</div>`;
  }
  const ratesCard = `<div class="card"><p class="card-title">课时单价</p><div class="form">
    <label class="field"><span class="field-label">C++（元 / 人）</span><input type="number" id="rateCpp" min="0" step="1" value="${s.rates.cpp}" ${state.edit ? '' : 'disabled'}></label>
    <label class="field"><span class="field-label">Python（元 / 人）</span><input type="number" id="ratePy" min="0" step="1" value="${s.rates.python}" ${state.edit ? '' : 'disabled'}></label>
    <label class="field"><span class="field-label">入校提示金额（低于此值时提醒）</span><input type="number" id="schoolMin" min="0" step="1" value="${s.schoolMin}" ${state.edit ? '' : 'disabled'}></label>
    ${state.edit ? '<button class="btn btn-primary" data-saverates>保存单价</button>' : '<div class="muted">登录后可修改单价。</div>'}
  </div></div>`;
  const backupCard = `<div class="card"><p class="card-title">备份</p>
    <div class="muted" style="margin-bottom:12px">数据保存在服务端的 <strong>data.db</strong>（真实 SQLite 文件）。直接复制该文件即可备份；也可点下方按钮下载一份。</div>
    <div class="form"><button class="btn" data-export>⬇️ 下载数据库（.db）</button></div></div>`;
  const demoCard = state.edit ? `<div class="card"><p class="card-title">演示数据</p>
    <div class="muted" style="margin-bottom:12px">载入一组示例学员与课程记录（含照片）以便体验功能；会覆盖当前数据。</div>
    <button class="btn" data-demo>🎬 载入演示数据</button></div>` : '';
  const dangerCard = state.edit ? `<div class="card"><p class="card-title">危险操作</p><button class="btn btn-danger btn-block" data-clear>清空所有记录与学员</button></div>` : '';
  const aboutCard = `<div class="card about"><p class="card-title">关于</p>
    <p><strong>数据存储：</strong>由本机运行的 Python 服务保存在 <strong>data.db</strong>（SQLite 文件）。清浏览器缓存不会丢，可用任意 SQLite 工具打开。</p>
    <p><strong>使用范围：</strong>需先启动本地服务（<span style="font-family:monospace">python3 server.py</span> 或双击 start.command），仅本机访问；手机不能直接打开。</p>
    <p><strong>编辑锁：</strong>密码用 PBKDF2 加盐保存在服务端，登录后用于区分预览/编辑。</p>
    <p class="muted" style="margin-top:8px">课时工资记录 · 本地 SQLite 版</p></div>`;
  return lockCard + ratesCard + backupCard + demoCard + dangerCard + aboutCard;
}
function bindSettings(v) {
  const setpw = $('[data-setpw]', v);
  if (setpw) setpw.onclick = async () => {
    const a = $('#pw1', v).value, b = $('#pw2', v).value;
    if (!a) { toast('请输入密码'); return; }
    if (a !== b) { toast('两次输入不一致'); return; }
    try {
      const r = await api('/password', { method: 'POST', body: { newPassword: a } });
      sessionStorage.setItem('pt_token', r.token);
      state.hasPassword = true; state.edit = true; renderApp(); toast('已启用编辑锁');
    } catch (e) { handleErr(e, '设置失败'); }
  };
  const chpw = $('[data-chpw]', v);
  if (chpw) chpw.onclick = async () => {
    const oldPw = $('#pwOld', v).value, newPw = $('#pwNew', v).value;
    if (!newPw && !(await confirmDialog('取消密码锁？', '取消后任何人打开都能编辑。'))) return;
    try {
      const r = await api('/password', { method: 'POST', body: { current: oldPw, newPassword: newPw }, auth: true });
      if (r.hasPassword) { sessionStorage.setItem('pt_token', r.token); state.hasPassword = true; toast('密码已更新'); }
      else { sessionStorage.removeItem('pt_token'); state.hasPassword = false; state.edit = true; toast('已取消密码锁'); }
      renderApp();
    } catch (e) { toast(e.status === 400 ? '当前密码不正确' : '操作失败'); }
  };
  const sr = $('[data-saverates]', v);
  if (sr) sr.onclick = async () => {
    const cpp = Math.max(0, Number($('#rateCpp', v).value) || 0);
    const py = Math.max(0, Number($('#ratePy', v).value) || 0);
    const sm = Math.max(0, Number($('#schoolMin', v).value) || 0);
    try {
      const r = await api('/settings', { method: 'PUT', body: { rates: { cpp, python: py }, schoolMin: sm }, auth: true });
      state.settings = { rates: { cpp: r.rates.cpp, python: r.rates.python }, schoolMin: r.schoolMin };
      renderApp(); toast('单价已保存');
    } catch (e) { handleErr(e, '保存失败'); }
  };
  const exp = $('[data-export]', v); if (exp) exp.onclick = downloadDb;
  const dm = $('[data-demo]', v); if (dm) dm.onclick = loadDemo;
  const clr = $('[data-clear]', v);
  if (clr) clr.onclick = async () => {
    if (!(await confirmDialog('清空所有数据？', '将删除全部记录、学员和照片（不含密码与单价），无法恢复。建议先下载数据库备份。'))) return;
    if (!(await confirmDialog('再次确认', '真的要清空吗？此操作不可撤销。'))) return;
    try { await api('/reset', { method: 'POST', auth: true }); await reloadData(); state.view = 'sessions'; renderApp(); toast('已清空'); }
    catch (e) { handleErr(e, '操作失败'); }
  };
}
async function downloadDb() {
  toast('正在导出…');
  try {
    const res = await api('/db', { auth: true, raw: true });
    const blob = await res.blob();
    downloadBlob(blob, 'course-data.db');
  } catch (e) { handleErr(e, '导出失败'); }
}
async function loadDemo() {
  if (!(await confirmDialog('载入演示数据？', '会清空当前数据并写入一组示例（学员、课程、照片），仅供体验。之后可在「设置 → 清空所有数据」清掉。'))) return;
  try {
    await api('/demo', { method: 'POST', auth: true });
    await reloadData();
    state.view = 'sessions';
    renderApp();
    toast('已载入演示数据');
  } catch (e) { handleErr(e, '载入失败'); }
}

/* ============================================================ 通用组件 */
function handleErr(e, fallback) {
  if (e && e.network) { toast('连接不上本地服务，请确认 server.py 在运行'); return; }
  if (e && e.status === 401) { toast('请先登录编辑'); openLoginModal(); return; }
  toast(fallback || '操作失败');
}
function openModal(title, bodyHtml, actions) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal"><h3>${escapeHtml(title)}</h3><div class="modal-body">${bodyHtml}</div>
    <div class="form-actions" style="margin-top:18px">${actions.map((a, i) => `<button class="btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}" data-act="${i}">${escapeHtml(a.label)}</button>`).join('')}</div></div>`;
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
      { label: '取消', kind: 'ghost', onClick: () => resolve(false) },
      { label: '确定', kind: 'danger', onClick: () => resolve(true) },
    ]);
  });
}
function openLoginModal() {
  openModal('管理员登录', `<div class="form"><label class="field"><span class="field-label">请输入管理员密码</span><input type="password" id="loginPw" autocomplete="current-password"></label></div>`, [
    { label: '取消', kind: 'ghost', close: true },
    { label: '登录', kind: 'primary', onClick: async (m) => {
      const pw = $('#loginPw', m).value;
      try {
        const r = await api('/login', { method: 'POST', body: { password: pw } });
        sessionStorage.setItem('pt_token', r.token);
        state.edit = true; renderApp(); toast('已解锁编辑');
      } catch (e) { toast(e.status === 401 ? '密码不正确' : '登录失败'); return false; }
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
  toastTimer = setTimeout(() => t.remove(), 2200);
}

/* ---------- 全局粘贴上传（编辑记录时，⌘/Ctrl+V 粘贴截图） ---------- */
function onGlobalPaste(e) {
  if (state.view !== 'sessionEdit' || !state.editor) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const files = [];
  for (const it of items) {
    if (it.type && it.type.indexOf('image/') === 0) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    const view = document.getElementById('view');
    if (view) { onPhotoPick(files, view); toast('已粘贴 ' + files.length + ' 张图片'); }
  }
}
document.addEventListener('paste', onGlobalPaste);

/* ---------- 启动 ---------- */
boot();
