// AI 协作空间前端
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = { admin: '管理员', supervisor: '监督者', employee: '员工' };
const STATUS = [
  ['todo', '待开始'], ['doing', '进行中'], ['blocked', '受阻'], ['rejected', '退回修改'], ['submitted', '待验收'], ['approved', '已通过'],
];
const STATUS_LABEL = Object.fromEntries(STATUS);
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : new Date(t).toLocaleDateString(); };

// 本机保存：每个空间一个 token。不同浏览器/设备各自加入，互不影响
const store = {
  all: () => JSON.parse(localStorage.getItem('aiws') || '{}'),
  get: sid => store.all()[sid],
  set: (sid, v) => { const a = store.all(); a[sid] = v; localStorage.setItem('aiws', JSON.stringify(a)); },
  del: sid => { const a = store.all(); delete a[sid]; localStorage.setItem('aiws', JSON.stringify(a)); },
};

let S = null; // 当前状态
let sid = null, tok = null;

document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog')?.close(); });
document.addEventListener('input', e => { if (e.target.id === 'dProg' && e.target.nextElementSibling) e.target.nextElementSibling.textContent = e.target.value + '%'; });
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400); }
async function call(method, url, body, extra) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(extra || {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  if (method !== 'GET' && S && Date.now() - lastEvent > 40000) setTimeout(refresh, 100);
  return data;
}
const show = id => ['home', 'join', 'app'].forEach(x => $('#' + x).classList.toggle('hidden', x !== id));

// ---------- 路由 ----------
function route() {
  const m = location.pathname.match(/^\/s\/([a-f0-9]+)/);
  if (!m) return home();
  sid = m[1];
  const invite = new URLSearchParams(location.search).get('invite');
  // 登录链接：/s/<id>#key=<token>。token 放在 # 后面，不会发给服务器或记进日志
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (key) {
    store.set(sid, { token: key });
    history.replaceState(null, '', `/s/${sid}`);
  }
  const saved = store.get(sid);
  if (saved) { tok = saved.token; return enter(); }
  if (invite) return joinPage(invite);
  show('home'); toast('这个浏览器还没登录这个空间：请用你的「登录链接」打开，或用邀请链接加入');
}

function home() {
  show('home');
  fetch('/api/host').then(r => r.json()).then(h => {
    if (h.canCreate) return;
    const f = $('#createForm');
    if (h.hostKey) { if (!f.hostKey) f.insertAdjacentHTML('afterbegin', '<label>主机口令<input name="hostKey" type="password" required autocomplete="off" /></label>'); }
    else { f.querySelectorAll('input,button').forEach(x => x.disabled = true); f.insertAdjacentHTML('beforebegin', '<p class="rcpt warn">只能在运行 Agent_room 的那台电脑上新建空间。别的设备请用邀请链接或登录链接进入已有空间。</p>'); }
  }).catch(() => {});
  const list = Object.entries(store.all());
  $('#mySpaces').innerHTML = list.length ? `<h3>本设备已加入的空间</h3>${list.map(([id, v]) => `<a class="space-link" href="/s/${id}">${esc(v.name || id)}<span>${ROLE[v.role] || ''}</span></a>`).join('')}` : '';
}
$('#createForm').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const r = await call('POST', '/api/spaces', f, f.hostKey ? { 'x-host-key': f.hostKey } : undefined);
    store.set(r.spaceId, { token: r.token, name: f.name, role: 'admin' });
    history.pushState(null, '', `/s/${r.spaceId}`);
    route();
    setTimeout(openInvite, 600);
  } catch (err) { toast(err.message); }
};

function joinPage(invite) {
  show('join');
  $('#joinGuideUrl').textContent = `${location.origin}/api/spaces/${sid}/guide?invite=${invite}`;
  $('#joinForm').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await call('POST', `/api/spaces/${sid}/join`, { ...f, invite });
      tok = r.token;
      store.set(sid, { token: r.token, role: 'employee' });
      history.replaceState(null, '', `/s/${sid}`);
      enter();
    } catch (err) { toast(err.message); }
  };
}

// ---------- 实时连接 ----------
let es = null, poll = null, lastEvent = 0;
function applyState(st) {
  const roleChanged = S && S.me.role !== st.me.role;
  S = st;
  store.set(sid, { token: tok, name: S.space.name, role: S.me.role });
  if (roleChanged) toast(`你的角色变为：${ROLE[S.me.role]}`);
  renderAll();
}
async function refresh() {
  try { applyState(await call('GET', `/api/spaces/${sid}/state`)); }
  catch (err) {
    if (/身份无效|空间不存在/.test(err.message)) { es?.close(); clearInterval(poll); store.del(sid); toast(err.message); setTimeout(() => location.href = '/', 1500); }
    else { $('#conn').textContent = '○ 连接中断，重试中…'; $('#conn').className = 'conn'; }
  }
}
// 先用普通请求拉取完整状态；实时流（SSE）可用就秒级推送，被代理缓冲时自动退回每 3 秒轮询
async function enter() {
  show('app');
  await refresh();
  es?.close(); clearInterval(poll);
  es = new EventSource(`/api/spaces/${sid}/events?token=${encodeURIComponent(tok)}`);
  const on = (type, fn) => es.addEventListener(type, e => { lastEvent = Date.now(); $('#conn').textContent = '● 实时同步中'; $('#conn').className = 'conn ok'; if (S) fn(JSON.parse(e.data)); });
  on('hello', applyState);
  on('ping', () => {});
  on('members', ms => {
    const me = ms.find(m => m.id === S.me.id);
    if (!me) { es.close(); clearInterval(poll); store.del(sid); toast('你已被移出空间'); return setTimeout(() => location.href = '/', 1500); }
    if (me.role !== S.me.role) return refresh(); // 角色变化：重新拉取（邀请码可见性也会变）
    S.members = ms; S.me = me; renderMembers(); renderBoard(); renderHeader();
  });
  on('task', t => { const i = S.tasks.findIndex(x => x.id === t.id); i < 0 ? S.tasks.push(t) : (S.tasks[i] = t); renderBoard(); if ($('#detailDlg').open && $('#detailDlg').dataset.id === t.id) openDetail(t.id); });
  on('public', ({ url }) => { S.publicUrl = url; if (url) toast('公网地址已更新，邀请链接和接入命令已换成新地址'); });
  on('knocks', () => { refreshInbox(); });
  on('goal', g => { S.goal = g; renderGoal(); if (g.status === 'achieved') toast('🎯 空间目标已达成'); });
  on('tasks', ts => { S.tasks = ts; renderBoard(); });
  on('taskDeleted', ({ id }) => { S.tasks = S.tasks.filter(t => t.id !== id); renderBoard(); });
  on('log', l => { S.logs ||= []; if (!S.logs.some(x => x.id === l.id)) { S.logs.push(l); renderLogs(); if ($('#logPane').classList.contains('hidden')) { unread++; badge(); } if ($('#detailDlg').open && $('#detailDlg').dataset.id === l.taskId) openDetail(l.taskId); } });
  on('stream', e => { S.streams ||= {}; (S.streams[e.member] ||= []).push(e); renderLive(); if ($('#livePane').classList.contains('hidden')) { liveUnread++; $('#liveBadge').textContent = liveUnread; } });
  on('read', ({ id, member: mid }) => { const m = S.messages.find(x => x.id === id); if (m) { (m.readBy ||= []).includes(mid) || m.readBy.push(mid); renderMsgs(); } });
  on('delivered', ({ id, member: mid }) => { const m = S.messages.find(x => x.id === id); if (m) { (m.deliveredTo ||= []).includes(mid) || m.deliveredTo.push(mid); renderMsgs(); } });
  on('file', f => { S.files ||= []; const i = S.files.findIndex(x => x.id === f.id); i < 0 ? S.files.push(f) : (S.files[i] = f); renderMsgs(); if ($('#detailDlg').open && $('#detailDlg').dataset.id === f.taskId) openDetail(f.taskId); });
  on('fileDeleted', ({ id }) => { S.files = (S.files || []).filter(f => f.id !== id); renderMsgs(); });
  on('message', m => { if (!S.messages.some(x => x.id === m.id)) { S.messages.push(m); renderMsgs(); } });
  poll = setInterval(() => {
    if (Date.now() - lastEvent < 40000) return; // 实时流正常（服务端每 25 秒发 ping 事件）
    $('#conn').textContent = '● 同步中（轮询）'; $('#conn').className = 'conn ok';
    if (!document.querySelector('dialog[open]')) refresh();
  }, 3000);
}

// 给别的设备 / 别的 AI 用的地址：有公网地址就用公网地址（在本机 localhost 打开时尤其重要）
const ORIGIN = () => (S && S.publicUrl) || location.origin;
const lead = () => S && (S.me.role === 'admin' || S.me.role === 'supervisor');
// 验收权：监督者；空间里还没有监督者时由管理员兜底（与服务端一致）
const canReview = () => S && (S.me.role === 'supervisor' || (S.me.role === 'admin' && !S.members.some(m => m.role === 'supervisor')));

// 轻量 Markdown：先整体转义再加格式，只生成固定标签，不会注入脚本
function md(src) {
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const lines = esc(src).split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 表格：| a | b | 且下一行是 |---|---|
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^#{1,4}\s/.test(l)) out.push(`<h5>${inline(l.replace(/^#+\s/, ''))}</h5>`);
    else if (/^\s*[-*]\s/.test(l)) out.push(`<p class="li">• ${inline(l.replace(/^\s*[-*]\s/, ''))}</p>`);
    else if (!l.trim()) out.push('<p class="gap"></p>');
    else out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}
const member = id => S.members.find(m => m.id === id);

function renderAll() { renderHeader(); renderInbox(); renderGoal(); renderLive(); renderMembers(); renderBoard(); renderMsgs(); renderLogs(); }

// ---------- 老板收件箱：只列需要你处理的事 ----------
const seenInbox = new Set(JSON.parse(localStorage.getItem('aiws-inbox-seen') || '[]'));
let ibCollapsed = localStorage.getItem('aiws-inbox-collapsed') === '1';
const wakeText = () => `空间「${S.space.name}」里有发给你的新消息和任务。请调用 ai-space 的 next 工具（没有 MCP 就按接入说明调用 /next）读取并处理派给你的任务，做完一项再调用 next 取下一项，直到返回 stop=true。高风险操作先问我。`;
function renderInbox() {
  const bar = $('#inboxBar');
  const items = S.inbox || [];
  bar.classList.toggle('hidden', S.me.role !== 'admin' || !items.length);
  if (!items.length) return;
  $('#ibCount').textContent = `${items.length} 项`;
  $('#ibToggle').textContent = ibCollapsed ? '展开' : '收起';
  $('#ibList').classList.toggle('hidden', ibCollapsed);
  const btn = i => ({ wake: '复制唤醒语', task: '打开任务', goal: '设置目标', members: '去设置' })[i.action?.type] || '';
  const knockBtns = i => `<span class="kb"><button type="button" class="primary" data-approve="${esc(i.action.ticket)}">批准为员工</button><button type="button" data-approve="${esc(i.action.ticket)}" data-role="supervisor">批准为监督者</button><button type="button" class="danger-ghost" data-reject="${esc(i.action.ticket)}">拒绝</button></span>`;
  $('#ibList').innerHTML = items.map(i => `<div class="ib-item ${i.level}"><div><b>${esc(i.title)}</b><small>${esc(i.detail)}</small></div>${i.action?.type === 'knock' ? knockBtns(i) : btn(i) ? `<button type="button" data-ib="${esc(i.key)}">${btn(i)}</button>` : ''}</div>`).join('');
  $('#ibNotify').classList.toggle('hidden', !('Notification' in window) || Notification.permission !== 'default');
  // 新出现的事项：桌面提醒（只提醒一次）
  const fresh = items.filter(i => !seenInbox.has(i.key + '|' + i.title));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted' && document.hidden)
    new Notification(`Agent_room · ${S.space.name}`, { body: fresh.map(i => i.title).join('\n'), tag: 'aiws-inbox' });
  for (const i of items) seenInbox.add(i.key + '|' + i.title);
  localStorage.setItem('aiws-inbox-seen', JSON.stringify([...seenInbox].slice(-200)));
  document.title = `(${items.length}) ${S.space.name} · AI 协作空间`;
}
$('#ibToggle').onclick = () => { ibCollapsed = !ibCollapsed; localStorage.setItem('aiws-inbox-collapsed', ibCollapsed ? '1' : '0'); renderInbox(); };
$('#ibNotify').onclick = async () => { await Notification.requestPermission(); renderInbox(); if (Notification.permission === 'granted') toast('已开启：页面在后台时，有新的待处理事项会弹出提醒'); };
$('#ibList').onclick = async e => {
  const ap = e.target.closest('[data-approve]'), rj = e.target.closest('[data-reject]');
  if (ap || rj) {
    try {
      await call('POST', `/api/spaces/${sid}/knocks/${(ap || rj).dataset[ap ? 'approve' : 'reject']}/${ap ? 'approve' : 'reject'}`, ap ? { role: ap.dataset.role || 'employee' } : {});
      toast(ap ? '已批准，它马上就会进来' : '已拒绝'); refreshInbox();
    } catch (err) { toast(err.message); }
    return;
  }
  const b = e.target.closest('[data-ib]'); if (!b) return;
  const i = (S.inbox || []).find(x => x.key === b.dataset.ib); if (!i) return;
  const act = i.action || {};
  if (act.type === 'task') openDetail(act.task);
  else if (act.type === 'goal') $('#goalEdit').click();
  else if (act.type === 'members') $('#memberList').scrollIntoView({ behavior: 'smooth' });
  else if (act.type === 'wake') { await navigator.clipboard.writeText(wakeText()).catch(() => prompt('复制这句话：', wakeText())); toast(`已复制唤醒语，去 ${member(act.member)?.name || '它'} 的对话框里粘贴发送`); }
};
// 收件箱每分钟刷新一次（“已停多久”这类事项要靠时间推移才会出现）
async function refreshInbox() { if (S && S.me.role === 'admin') { try { const r = await call('GET', `/api/spaces/${sid}/inbox?boss=1`); S.inbox = r.items; renderInbox(); } catch { } } }
setInterval(refreshInbox, 60000);

// ---------- 空间目标 ----------
function renderGoal() {
  const g = S.goal || { text: '', status: 'active' };
  $('#goalText').textContent = g.text || '还没有设置目标。设置后 AI 会围绕它持续工作，直到监督者确认达成。';
  $('#goalText').classList.toggle('muted', !g.text);
  const done = g.status === 'achieved';
  $('#goalState').textContent = done ? `已达成 · ${g.achievedByName || ''}确认` : (g.text || g.docName) ? '进行中，AI 持续工作' : '';
  $('#goalState').className = 'g-state ' + (done ? 'done' : '');
  $('#goalEdit').classList.toggle('hidden', !lead());
  $('#goalDocBtn').classList.toggle('hidden', !g.docName);
  $('#goalDocBtn').textContent = `📄 ${g.docName || ''}`;
  if (!g.text && g.docName) { $('#goalText').textContent = `见目标文档「${g.docName}」`; $('#goalText').classList.remove('muted'); }
  $('#goalDone').classList.toggle('hidden', !canReview() || done || !(g.text || g.docName));
  $('#goalReopen').classList.toggle('hidden', !canReview() || !done);
}
// 目标：一句话 + 可选文档（拖拽 / 选择 / 粘贴）
let pendingDoc = null, removeDoc = false;
// 读成 base64 交给服务端：文本直接用，Word / PDF 由服务端转成文字
const readFile = f => new Promise((ok, no) => {
  if (f.size > 10 * 1024 * 1024) return no(new Error('文件超过 10MB'));
  const r = new FileReader();
  r.onload = () => ok({ name: f.name, base64: String(r.result).split(',')[1] || '' });
  r.onerror = () => no(new Error('读取文件失败'));
  r.readAsDataURL(f);
});
async function pickGoalFile(f) {
  try { pendingDoc = await readFile(f); removeDoc = false; $('#goalFileInfo').textContent = `已选择：${f.name}（${(f.size / 1024).toFixed(1)} KB）`; $('#goalPaste').value = ''; }
  catch (err) { toast(err.message); }
}
$('#goalEdit').onclick = () => {
  const f = $('#goalForm'); f.reset(); pendingDoc = null; removeDoc = false;
  f.text.value = S.goal?.text || '';
  $('#goalFileInfo').textContent = S.goal?.docName ? `当前文档：${S.goal.docName}（${(S.goal.docSize / 1024).toFixed(1)} KB，${S.goal.docBy} 上传）。重新上传会替换它。` : '';
  $('#goalRemoveDoc').classList.toggle('hidden', !S.goal?.docName);
  $('#goalDlg').showModal();
};
$('#dropZone').onclick = () => $('#goalFile').click();
$('#goalFile').onchange = e => e.target.files[0] && pickGoalFile(e.target.files[0]);
$('#dropZone').ondragover = e => { e.preventDefault(); e.currentTarget.classList.add('over'); };
$('#dropZone').ondragleave = e => e.currentTarget.classList.remove('over');
$('#dropZone').ondrop = e => { e.preventDefault(); e.currentTarget.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) pickGoalFile(f); };
$('#goalRemoveDoc').onclick = () => { removeDoc = true; pendingDoc = null; $('#goalFileInfo').textContent = '保存后将移除现有文档'; };
$('#goalForm').onsubmit = async e => {
  e.preventDefault();
  const text = e.target.text.value.trim(), paste = $('#goalPaste').value.trim();
  const doc = pendingDoc || (paste ? { name: 'README.md', content: paste } : null);
  if (!text && !doc && !S.goal?.docName) return toast('请写一句话目标，或上传目标文档');
  const btn = e.target.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = '上传中…';
  try {
    S.goal = await call('POST', `/api/spaces/${sid}/goal`, { text, doc: doc || undefined, removeDoc: removeDoc || undefined });
    docCache = null; btn.disabled = false; btn.textContent = '保存目标'; renderGoal(); $('#goalDlg').close(); toast(S.goal.docConverted ? `已上传，${S.goal.docConverted.toUpperCase()} 已转成文字供 AI 阅读` : '目标已更新，AI 会按它持续工作');
  } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = '保存目标'; }
};
let docCache = null;
async function showText(title, url) {
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error('读取失败');
    const t = await r.text();
    $('#docBody').innerHTML = `<h2>${esc(title)}</h2>` + md(t);
    $('#docDlg').showModal();
  } catch (err) { toast(err.message); }
}
$('#goalDocBtn').onclick = () => showText(S.goal.docName, `/api/spaces/${sid}/goal/doc`);
$('#goalDone').onclick = async () => {
  const summary = prompt('确认目标已达成？所有 AI 收到后会停止工作。\n写一句达成总结：', '');
  if (summary === null) return;
  try { S.goal = await call('POST', `/api/spaces/${sid}/goal/achieve`, { summary }); renderGoal(); } catch (err) { toast(err.message); }
};
$('#goalReopen').onclick = async () => {
  try { S.goal = await call('POST', `/api/spaces/${sid}/goal/reopen`); renderGoal(); toast('已重新开启，AI 会继续工作'); } catch (err) { toast(err.message); }
};
$('#runnerBtn').onclick = () => {
  if (S.me.role !== 'admin') return toast('只有管理员能查看接入命令');
  const ais = S.members.filter(m => m.kind === 'ai');
  $('#pickList').innerHTML = ais.length ? ais.map(m => `<button class="pick" data-pick="${m.id}"><b>${esc(m.name)}</b><span>${ROLE[m.role]}${m.model ? ' · ' + esc(m.model) : ''}${m.active ? ' · 在线' : ''}</span></button>`).join('')
    : '<p class="muted">还没有 AI 成员。<a href="#" data-addfirst>先添加一个</a></p>';
  $('#runnerDlg').showModal();
};
$('#runnerDlg').onclick = async e => {
  const p = e.target.closest('[data-pick]');
  if (p) { try { const info = await call('GET', `/api/spaces/${sid}/members/${p.dataset.pick}/connect`); $('#runnerDlg').close(); openConnect(info, member(p.dataset.pick)?.name || '', 'online', p.dataset.pick); } catch (err) { toast(err.message); } return; }
  if (e.target.closest('[data-addfirst]')) { e.preventDefault(); $('#runnerDlg').close(); $('#addMemberBtn').click(); }
};

// ---------- AI 实时会话 ----------
let liveUnread = 0;
const LIVE_KIND = { text: '回复', tool: '执行', result: '结果', think: '思考', error: '错误' };
function renderLive() {
  if (!S) return;
  const streamsBy = S.streams || {};
  const ids = Object.keys(streamsBy).filter(id => member(id));
  const f = $('#liveFilter'), cur = f.value;
  f.innerHTML = ids.length ? ids.map(id => { const m = member(id); return `<option value="${id}">${esc(m.name)}${m.bridge ? ` · ${({ working: '工作中', idle: '待命', offline: '离线' })[m.bridge.state] || ''}` : ''}</option>`; }).join('') : '<option value="">还没有 AI 接入桥接</option>';
  f.value = ids.includes(cur) ? cur : (ids[0] || '');
  const box = $('#liveList'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const list = (streamsBy[f.value] || []).slice(-200);
  box.innerHTML = list.map(e => `<div class="lv ${e.kind}"><span class="lk">${LIVE_KIND[e.kind] || e.kind}</span><small>${ago(e.at)}</small>${e.kind === 'text' ? `<div class="md">${md(e.text)}</div>` : `<pre>${esc(e.text)}</pre>`}</div>`).join('') || '<div class="empty">接入桥接后，AI 的实时过程会显示在这里</div>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}
$('#liveFilter').onchange = renderLive;
$('#liveHowto').onclick = e => { e.preventDefault(); $('#runnerBtn').click(); };

// ---------- 工作日志 ----------
let unread = 0;
const badge = () => { $('#logBadge').textContent = unread ? unread : ''; };
const SRC = { task: '任务更新', chat: '频道发言', note: '任务备注', submit: '提交', file: '日志文件', manual: '' };
const logHTML = l => `<div class="log ${l.problem ? 'has-problem' : ''} ${l.auto ? 'auto' : ''}">
  <div class="who"><b>${esc(l.memberName)}</b>${l.taskTitle ? `<span class="log-task">「${esc(l.taskTitle)}」</span>` : ''}${l.auto && SRC[l.source] ? `<span class="src">自动 · ${SRC[l.source]}</span>` : ''}<small>${ago(l.at)}</small></div>
  <div class="log-body"><div class="md">${md(l.done)}</div>${l.file ? `<button class="file-chip" data-logfile="${l.id}" data-name="${esc(l.file.name)}">📄 ${esc(l.file.name)}</button>` : ''}${l.problem ? `<p class="prob"><em>问题</em>${esc(l.problem)}</p>` : ''}${l.next ? `<p><em>下一步</em>${esc(l.next)}</p>` : ''}</div></div>`;
function renderLogs() {
  if (!S) return;
  const logs = S.logs || [];
  const f = $('#logFilter'), cur = f.value;
  f.innerHTML = '<option value="">全部成员</option>' + S.members.map(m => `<option value="${m.id}">${esc(m.name)}（${logs.filter(l => l.member === m.id).length} 条）</option>`).join('');
  f.value = S.members.some(m => m.id === cur) ? cur : '';
  const lt = $('#logTask'), curT = lt.value;
  lt.innerHTML = '<option value="">不关联任务</option>' + S.tasks.filter(t => t.status !== 'approved' && (lead() || t.assignee === S.me.id || !t.assignee)).map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  lt.value = curT;
  const box = $('#logList'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const list = logs.filter(l => !f.value || l.member === f.value).slice(-300);
  box.innerHTML = list.map(logHTML).join('') || '<div class="empty">还没有日志。AI 每做完一步都会在这里记录做了什么、遇到什么问题。</div>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}
$('#logFilter').onchange = renderLogs;
$('#logList').onclick = e => { const b = e.target.closest('[data-logfile]'); if (b) showText(b.dataset.name, `/api/spaces/${sid}/logfile/${b.dataset.logfile}`); };
let pendingLogFile = null;
$('#logFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { pendingLogFile = await readFile(f); $('#logDone').placeholder = `已附加 ${f.name}，可再写一句说明`; toast(`已附加 ${f.name}`); } catch (err) { toast(err.message); }
  e.target.value = '';
};
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  $('#chatPane').classList.toggle('hidden', b.dataset.tab !== 'chat');
  $('#logPane').classList.toggle('hidden', b.dataset.tab !== 'logs');
  $('#livePane').classList.toggle('hidden', b.dataset.tab !== 'live');
  if (b.dataset.tab === 'live') { liveUnread = 0; $('#liveBadge').textContent = ''; renderLive(); const lb = $('#liveList'); lb.scrollTop = lb.scrollHeight; }
  if (b.dataset.tab === 'logs') { unread = 0; badge(); const box = $('#logList'); box.scrollTop = box.scrollHeight; }
});
$('#logForm').onsubmit = async e => {
  e.preventDefault();
  const done = $('#logDone').value.trim(); if (!done && !pendingLogFile) return toast('请填写这一步做了什么，或上传日志文件');
  try {
    await call('POST', `/api/spaces/${sid}/logs`, { done, problem: $('#logProblem').value.trim(), taskId: $('#logTask').value || undefined, file: pendingLogFile || undefined });
    $('#logDone').value = ''; $('#logProblem').value = ''; pendingLogFile = null; $('#logDone').placeholder = '这一步做了什么（必填）'; toast('已写入日志');
  } catch (err) { toast(err.message); }
};
function renderHeader() {
  $('#spaceName').textContent = S.space.name;
  $('#meLine').textContent = `我：${S.me.name} · ${ROLE[S.me.role]}`;
  $('#inviteBtn').classList.toggle('hidden', !lead());
  $('#addMemberBtn').classList.toggle('hidden', S.me.role !== 'admin');
  $('#inviteAiBtn').classList.toggle('hidden', S.me.role !== 'admin');
  $('#loginLinkBtn').onclick = async () => {
    const link = `${ORIGIN()}/s/${sid}#key=${tok}`;
    await navigator.clipboard.writeText(link).catch(() => prompt('复制你的登录链接（别发给别人）：', link));
    toast('已复制登录链接。换浏览器、换设备或地址变了，用它就能以你的身份回来。别发给别人；万一泄露，在接入弹窗里给自己换令牌');
  };
  $('#newTaskBtn').classList.toggle('hidden', !lead());
  if (!(S.inbox || []).length) document.title = `${S.space.name} · AI 协作空间`;
}

function renderMembers() {
  const order = { admin: 0, supervisor: 1, employee: 2 };
  const list = [...S.members].sort((a, b) => order[a.role] - order[b.role] || b.online - a.online);
  $('#memberCount').textContent = list.length;
  $('#memberList').innerHTML = list.map(m => `
    <div class="member ${m.id === S.me.id ? 'me' : ''}">
      <div class="avatar ${m.kind}">${m.kind === 'ai' ? '✦' : '☺'}<i class="${m.online ? 'on' : ''}"></i></div>
      <div class="info">
        <b>${esc(m.name)}${m.id === S.me.id ? '（我）' : ''}</b>
        <span><em class="role ${m.role}">${ROLE[m.role]}</em>${esc(m.model)}</span>
        ${m.status ? `<small>${esc(m.status)}</small>` : ''}
        ${m.kind === 'ai' && !m.active && m.lastSeen ? `<small class="stopped">⏸ 已停止 · 最后活动 ${ago(Math.max(m.lastNextAt || 0, m.lastSeen || 0))} · <a href="#" data-wake="${m.id}">复制唤醒语</a></small>` : ''}
        ${m.bridge && m.bridge.state !== 'offline' && Date.now() - m.bridge.at < 2 * 60000 ? `<small class="bridge ${m.bridge.state}">⚡ 实时连接 · ${({ working: '正在工作', idle: '待命' })[m.bridge.state] || ''}</small>` : ''}
        ${m.device?.host || m.device?.ip ? `<small class="dev">🖥 ${esc(m.device.host || '')}${m.device.ip ? ` · ${esc(m.device.ip)}` : ''}${m.device.tool ? ` · ${esc(m.device.tool)}` : ''}</small>` : ''}
        <small class="loglink" data-logs="${m.id}">${m.lastLogAt ? `最后日志 ${ago(m.lastLogAt)}` : '暂无日志'} · 查看</small>
      </div>
      ${S.me.role === 'admin' && m.role !== 'admin' ? `
        <div class="m-actions">
          ${m.kind === 'ai' ? `<button data-connect="${m.id}" title="查看/重新复制接入命令">接入</button>` : ''}
          <button data-role="${m.id}" data-to="${m.role === 'supervisor' ? 'employee' : 'supervisor'}">${m.role === 'supervisor' ? '设为员工' : '设为监督者'}</button>
          <button class="x" data-kick="${m.id}" title="移出空间">✕</button>
        </div>` : ''}
    </div>`).join('');
  const sel = $('#msgTo'), cur = sel.value;
  sel.innerHTML = `<option value="">发给所有人</option>` + S.members.filter(m => m.id !== S.me.id).map(m => `<option value="${m.id}">私信 ${esc(m.name)}</option>`).join('');
  sel.value = cur;
}
$('#memberList').onclick = async e => {
  const wk = e.target.closest('[data-wake]');
  if (wk) { e.preventDefault(); const t = member(wk.dataset.wake); const text = `空间「${S.space.name}」里有发给你的新消息和任务。请调用 ai-space 的 next 工具（没有 MCP 就按接入说明调用 /next）读取并处理派给你的任务，做完一项再调用 next 取下一项，直到返回 stop=true。高风险操作先问我。`; await navigator.clipboard.writeText(text).catch(() => prompt('复制这句话：', text)); return toast(`已复制唤醒语，去 ${t.name} 的对话框里粘贴发送`); }
  const lg = e.target.closest('[data-logs]');
  if (lg) { document.querySelector('[data-tab=logs]').click(); $('#logFilter').value = lg.dataset.logs; return renderLogs(); }
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.connect) { try { openConnect(await call('GET', `/api/spaces/${sid}/members/${b.dataset.connect}/connect`), member(b.dataset.connect)?.name || '', 'plain', b.dataset.connect); } catch (err) { toast(err.message); } return; }
  try {
    if (b.dataset.role) await call('POST', `/api/spaces/${sid}/members/${b.dataset.role}/role`, { role: b.dataset.to });
    if (b.dataset.kick && confirm(`确定把 ${member(b.dataset.kick)?.name} 移出空间？它的 token 会立即失效。`)) await call('DELETE', `/api/spaces/${sid}/members/${b.dataset.kick}`);
  } catch (err) { toast(err.message); }
};

function renderBoard() {
  const cols = [['todo', '待开始', ['todo']], ['doing', '进行中', ['doing', 'blocked', 'rejected']], ['submitted', '待验收', ['submitted']], ['approved', '已完成', ['approved']]];
  $('#columns').innerHTML = cols.map(([k, name, sts]) => {
    const ts = S.tasks.filter(t => sts.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    return `<div class="col"><div class="col-head">${name}<em>${ts.length}</em></div>${ts.map(t => {
      const a = member(t.assignee);
      return `<div class="task ${t.status}" data-task="${t.id}">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-meta"><span class="st ${t.status}">${STATUS_LABEL[t.status]}</span>${a ? esc(a.name) : '<i>待认领</i>'}</div>
        ${t.progress ? `<div class="bar"><i style="width:${t.progress}%"></i></div>` : ''}
      </div>`;
    }).join('') || '<div class="empty">暂无</div>'}</div>`;
  }).join('');
}
$('#columns').onclick = e => { const t = e.target.closest('[data-task]'); if (t) openDetail(t.dataset.task); };

function openDetail(taskId) {
  const t = S.tasks.find(x => x.id === taskId); if (!t) return;
  const dlg = $('#detailDlg'); dlg.dataset.id = t.id;
  const mine = t.assignee === S.me.id || !t.assignee;
  const canWork = !lead() && mine && t.status !== 'approved';
  $('#detailBody').innerHTML = `
    <h2>${esc(t.title)}</h2>
    <p class="t-meta"><span class="st ${t.status}">${STATUS_LABEL[t.status]}</span>执行人：${esc(member(t.assignee)?.name || '待认领')} · 验收人：${esc((member(t.reviewer) || member(t.creator)?.role === 'supervisor' && member(t.creator) || S.members.find(m => m.role === 'supervisor'))?.name || '未设置监督者')}${t.reviewedByName ? ` · ${esc(t.reviewedByName)} ${t.status === 'approved' ? '已验收' : '已退回'}` : ''} · 进度 ${t.progress}% · ${ago(t.updatedAt)}更新</p>
    ${t.description ? `<div class="block"><h4>描述</h4><pre>${esc(t.description)}</pre></div>` : ''}
    ${t.result ? `<div class="block"><h4>交付报告</h4><div class="md boxed">${md(t.result)}</div></div>` : ''}
    <div class="block"><h4>截图 / 视频 / 附件（${(S.files || []).filter(f => f.taskId === t.id).length}）<label class="file-btn inline-up">＋ 上传<input type="file" id="taskFile" multiple hidden /></label></h4><div class="fgrid">${(S.files || []).filter(f => f.taskId === t.id).map(fileHTML).join('') || '<span class="muted small">还没有。交付有画面的任务时，截图和录屏放这里，监督者能直接看。</span>'}</div></div>
    ${(S.logs || []).some(l => l.taskId === t.id) ? `<div class="block"><h4>工作日志</h4><div class="task-logs">${S.logs.filter(l => l.taskId === t.id).slice(-50).map(logHTML).join('')}</div></div>` : ''}
    ${t.notes.length ? `<div class="block"><h4>记录</h4>${t.notes.map(n => `<p class="note"><b>${esc(n.byName)}</b> ${esc(n.text)} <small>${ago(n.at)}</small></p>`).join('')}</div>` : ''}
    <textarea id="dNote" rows="3" placeholder="${canReview() ? '验收意见（退回时必填）' : lead() ? '备注' : '进度说明；提交验收时写完整报告，支持 Markdown 表格'}"></textarea>
    ${canWork ? `<label class="inline">进度 <input id="dProg" type="range" min="0" max="100" value="${t.progress}"><span>${t.progress}%</span></label>` : ''}
    ${lead() ? `<label class="inline">改派给 <select id="dAssignee"><option value="">待认领</option>${S.members.filter(m => m.role === 'employee').map(m => `<option value="${m.id}" ${m.id === t.assignee ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : ''}
    <div class="dlg-foot">
      ${lead() ? `<button class="danger-ghost" data-act="delete">删除</button><button data-act="reassign">保存执行人</button>` : ''}
      ${canReview() && t.status === 'submitted' ? `<button data-act="rejected">退回修改</button><button class="primary" data-act="approved">验收通过</button>` : ''}
      ${canWork ? `<button data-act="doing">开始 / 更新进度</button><button data-act="blocked">遇到阻碍</button><button class="primary" data-act="submitted">提交验收</button>` : ''}
      <button data-act="close">关闭</button>
    </div>`;
  const tf = $('#taskFile'); if (tf) tf.onchange = async e => { await uploadMany([...e.target.files], { taskId: t.id }); e.target.value = ''; };
  if (!dlg.open) dlg.showModal();
}
$('#detailDlg').onclick = async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const dlg = $('#detailDlg'), act = b.dataset.act, url = `/api/spaces/${sid}/tasks/${dlg.dataset.id}`;
  if (act === 'close') return dlg.close();
  const note = $('#dNote')?.value.trim();
  const t0 = () => S.tasks.find(x => x.id === dlg.dataset.id) || {};
  try {
    if (act === 'delete') { if (confirm('删除这个任务？')) { await call('DELETE', url); dlg.close(); } return; }
    if (act === 'reassign') { await call('PATCH', url, { assignee: $('#dAssignee').value || null }); return toast('已改派'); }
    const body = { status: act };
    if (note) body.note = note;
    if ($('#dProg')) body.progress = act === 'submitted' ? 100 : Number($('#dProg').value);
    if (act === 'submitted') { if (!note && !t0().result) return toast('请在输入框里写完整的交付报告'); if (note) body.result = note; }
    if (act === 'rejected' && !note) return toast('请填写需要修改的地方');
    await call('PATCH', url, body);
    toast('已更新');
  } catch (err) { toast(err.message); }
};

// 私信回执：已读 / 未读；对方 AI 不在线时提示并给出唤醒语
function receipt(m) {
  const got = new Set([...(m.readBy || []), ...(m.deliveredTo || [])]);
  if (m.to) {
    const t = member(m.to);
    if (!t) return '';
    if (got.has(t.id)) return `<div class="rcpt">✓ ${esc(t.name)} 已收到</div>`;
    if (t.kind === 'ai' && !t.active) return `<div class="rcpt warn">⚠ 未送达：${esc(t.name)} 已停止工作（最后活动 ${ago(Math.max(t.lastNextAt || 0, t.lastSeen || 0))}）。空间没法主动叫醒它，<a href="#" data-wake="${t.id}">复制唤醒语</a>发到它的对话框里。</div>`;
    return `<div class="rcpt wait">⏳ 等待 ${esc(t.name)} 读取</div>`;
  }
  if (got.size) return `<div class="rcpt">✓ ${[...got].map(id => esc(member(id)?.name || '')).filter(Boolean).join('、')} 已收到</div>`;
  return '';
}
// ---------- 文件：截图 / 视频 / 附件 ----------
const fileUrl = (f, sub = '') => `/api/spaces/${sid}/files/${f.id}${sub ? '/' + sub : ''}?token=${encodeURIComponent(tok)}`;
const fileById = id => (S.files || []).find(f => f.id === id);
const sizeLabel = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
function fileHTML(f) {
  if (!f) return '<div class="fcard gone">文件已删除</div>';
  const busy = f.status === 'processing';
  if (f.type === 'image') return `<div class="fcard img" data-media="${f.id}"><img loading="lazy" src="${fileUrl(f, 'preview')}" alt="${esc(f.name)}" /><span>${esc(f.name)}</span></div>`;
  if (f.type === 'video') return `<div class="fcard vid" data-media="${f.id}">${busy ? '<div class="fproc">视频处理中…</div>' : f.poster !== undefined ? `<img loading="lazy" src="${fileUrl(f, 'poster')}" alt="${esc(f.name)}" /><b class="play">▶</b>` : '<div class="fproc">视频</div>'}<span>${esc(f.name)} · ${f.duration ? f.duration.toFixed(0) + ' 秒 · ' : ''}${sizeLabel(f.size)}</span></div>`;
  return `<a class="fcard file" href="${fileUrl(f)}&download=1" target="_blank">📄 ${esc(f.name)} <small>${sizeLabel(f.size)}</small></a>`;
}
function openMedia(id) {
  const f = fileById(id); if (!f) return;
  const head = `<h2>${esc(f.name)}</h2><p class="muted small">${esc(f.byName)} 上传 · ${ago(f.at)}${f.taskTitle ? ` · 任务「${esc(f.taskTitle)}」` : ''}${f.width ? ` · ${f.width}×${f.height}` : ''}${f.duration ? ` · ${f.duration.toFixed(1)} 秒` : ''}</p>${f.caption ? `<p>${esc(f.caption)}</p>` : ''}`;
  let body = '';
  if (f.type === 'image') body = `<img class="media-full" src="${fileUrl(f)}" alt="${esc(f.name)}" />`;
  else if (f.type === 'video') body = `<video class="media-full" src="${fileUrl(f)}" controls autoplay playsinline ${f.poster !== undefined ? `poster="${fileUrl(f, 'poster')}"` : ''}></video>` + (f.sheet ? `<p class="muted small">AI 看到的是这张 9 帧缩略图墙（AI 不能直接看视频）：</p><img class="media-full" src="${fileUrl(f, 'sheet')}" alt="缩略图墙" />` : f.note ? `<p class="muted small">${esc(f.note)}</p>` : '');
  $('#mediaBody').innerHTML = head + body;
  $('#mediaDl').href = fileUrl(f) + '&download=1';
  $('#mediaDlg').showModal();
}
$('#mediaDlg').addEventListener('close', () => $('#mediaBody').querySelector('video')?.pause());
// 上传：原始文件直接流式上传，带进度
function uploadFile(file, opts = {}) {
  return new Promise((ok, no) => {
    const qs = new URLSearchParams({ name: file.name });
    if (opts.taskId) qs.set('taskId', opts.taskId);
    if (opts.to) qs.set('to', opts.to);
    if (opts.text) qs.set('text', opts.text);
    const x = new XMLHttpRequest();
    x.open('POST', `/api/spaces/${sid}/files?${qs}`);
    x.setRequestHeader('authorization', `Bearer ${tok}`);
    if (file.type) x.setRequestHeader('content-type', file.type);
    x.upload.onprogress = e => { if (e.lengthComputable) $('#upProg').textContent = `上传 ${file.name} ${Math.round(e.loaded / e.total * 100)}%`; };
    x.onload = () => { $('#upProg').textContent = ''; let d = {}; try { d = JSON.parse(x.responseText); } catch { } x.status < 300 ? ok(d) : no(new Error(d.error || `上传失败 ${x.status}`)); };
    x.onerror = () => { $('#upProg').textContent = ''; no(new Error('网络中断，上传失败')); };
    x.send(file);
  });
}
// 大文件分块上传：每块一个请求，公网隧道不会因为单个请求太久被掐断；失败的块自动重试
async function uploadChunked(file, opts = {}) {
  const h = { authorization: `Bearer ${tok}`, 'x-file-name': encodeURIComponent(file.name), 'x-file-type': file.type || '' };
  if (opts.taskId) h['x-task-id'] = opts.taskId;
  if (opts.to) h['x-to'] = opts.to;
  if (opts.text) h['x-file-text'] = encodeURIComponent(opts.text);
  const start = await fetch(`/api/spaces/${sid}/files/uploads`, { method: 'POST', headers: h }).then(r => r.json());
  if (!start.uploadId) throw new Error(start.error || '无法开始上传');
  const size = start.chunkSize || 2 * 1024 * 1024, n = Math.ceil(file.size / size);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      for (let t = 1; ; t++) {
        const r = await fetch(`/api/spaces/${sid}/files/uploads/${start.uploadId}/${i}`, { method: 'PUT', headers: { authorization: `Bearer ${tok}` }, body: file.slice(i * size, (i + 1) * size) }).catch(() => null);
        if (r && r.ok) break;
        if (t >= 5) throw new Error(`第 ${i} 块上传失败，请重试`);
        await new Promise(res => setTimeout(res, t * 2000));
      }
      done++; $('#upProg').textContent = `上传 ${file.name} ${Math.round(done / n * 100)}%（${done}/${n} 块）`;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const r = await fetch(`/api/spaces/${sid}/files/uploads/${start.uploadId}/complete`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
  $('#upProg').textContent = '';
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || '合并失败');
  return d;
}
async function uploadMany(list, opts) {
  for (const f of list) {
    try { await (f.size > 4 * 1024 * 1024 ? uploadChunked(f, opts) : uploadFile(f, opts)); } catch (err) { $('#upProg').textContent = ''; toast(err.message); }
  }
}
$('#chatFile').onchange = async e => { const text = $('#msgText').value.trim(); await uploadMany([...e.target.files], { to: $('#msgTo').value || undefined, text }); if (text) $('#msgText').value = ''; e.target.value = ''; };
$('#chatPane').addEventListener('dragover', e => { e.preventDefault(); $('#chatPane').classList.add('drop-on'); });
$('#chatPane').addEventListener('dragleave', e => { if (!e.currentTarget.contains(e.relatedTarget)) $('#chatPane').classList.remove('drop-on'); });
$('#chatPane').addEventListener('drop', e => { e.preventDefault(); $('#chatPane').classList.remove('drop-on'); if (e.dataTransfer.files.length) uploadMany([...e.dataTransfer.files], { to: $('#msgTo').value || undefined }); });
document.addEventListener('click', e => { const m = e.target.closest('[data-media]'); if (m) openMedia(m.dataset.media); });

function renderMsgs() {
  const box = $('#msgList'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = S.messages.slice(-300).map(m => {
    if (m.kind === 'system') return `<div class="sys">${esc(m.text)} · ${ago(m.at)}</div>`;
    if (m.kind === 'file') {
      const from = member(m.from), mine = m.from === S.me.id, t = m.taskId && S.tasks.find(x => x.id === m.taskId);
      const to = m.to ? ` → ${esc(member(m.to)?.name || '已离开')}` : '';
      return `<div class="msg ${mine ? 'mine' : ''} ${m.to ? 'dm' : ''}">
        <div class="who"><b>${esc(m.fromName)}</b>${from ? `<em class="role ${from.role}">${ROLE[from.role]}</em>` : ''}${to}${t ? `<span class="r-task" data-open-task="${t.id}">「${esc(t.title)}」</span>` : ''}<small>${ago(m.at)}</small></div>
        ${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}<div class="fgrid">${(m.files || []).map(id => fileHTML(fileById(id))).join('')}</div>${mine ? receipt(m) : ''}</div>`;
    }
    if (['submit', 'approve', 'reject'].includes(m.kind)) {
      const t = S.tasks.find(x => x.id === m.taskId), from = member(m.from);
      const head = { submit: '📋 提交验收', approve: '✅ 验收通过', reject: '↩️ 退回修改' }[m.kind];
      const reviewer = t && member(t.reviewer);
      const pending = m.kind === 'submit' && t && t.status === 'submitted';
      return `<div class="report ${m.kind}">
        <div class="r-head"><b>${head}</b><span class="r-task" data-open-task="${m.taskId}">「${esc(t ? t.title : '已删除的任务')}」</span><small>${ago(m.at)}</small></div>
        <div class="who"><b>${esc(m.fromName)}</b>${from ? `<em class="role ${from.role}">${ROLE[from.role]}</em>` : ''}${m.kind === 'submit' && reviewer ? `<span>→ 验收人 ${esc(reviewer.name)}</span>` : ''}</div>
        <div class="md">${md(m.text)}</div>
        ${m.kind === 'submit' && (S.files || []).some(f => f.taskId === m.taskId) ? `<div class="fgrid">${S.files.filter(f => f.taskId === m.taskId && f.at <= m.at + 60000).slice(-6).map(fileHTML).join('')}</div>` : ''}
        ${pending && canReview() ? `<div class="r-actions"><button data-open-task="${m.taskId}">退回修改</button><button class="primary" data-quick-approve="${m.taskId}">验收通过</button></div>` : ''}
        ${pending && !canReview() ? `<div class="r-wait">等待 ${esc(reviewer ? reviewer.name : '监督者')} 验收</div>` : ''}
      </div>`;
    }
    const from = member(m.from), mine = m.from === S.me.id;
    const to = m.to ? ` → ${esc(member(m.to)?.name || '已离开')}` : '';
    return `<div class="msg ${mine ? 'mine' : ''} ${m.to ? 'dm' : ''}">
      <div class="who"><b>${esc(m.fromName)}</b>${from ? `<em class="role ${from.role}">${ROLE[from.role]}</em>` : ''}${to}<small>${ago(m.at)}</small></div>
      <div class="bubble">${from && from.kind === 'ai' ? md(m.text) : esc(m.text)}</div>${mine ? receipt(m) : ''}</div>`;
  }).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}
$('#msgList').addEventListener('click', async e => {
  const w = e.target.closest('[data-wake]'); if (!w) return;
  e.preventDefault();
  const t = member(w.dataset.wake);
  const text = `空间「${S.space.name}」里有发给你的新消息和任务。请调用 ai-space 的 next 工具（没有 MCP 就按接入说明调用 /next）读取并处理派给你的任务，做完一项再调用 next 取下一项，直到返回 stop=true。高风险操作先问我。`;
  await navigator.clipboard.writeText(text).catch(() => prompt('复制这句话，发到 ' + t.name + ' 的对话框：', text));
  toast(`已复制唤醒语，去 ${t.name} 所在的 Cursor / Claude 里粘贴发送`);
});
$('#msgList').onclick = async e => {
  const o = e.target.closest('[data-open-task]'); if (o) return openDetail(o.dataset.openTask);
  const q = e.target.closest('[data-quick-approve]');
  if (q) { try { await call('PATCH', `/api/spaces/${sid}/tasks/${q.dataset.quickApprove}`, { status: 'approved' }); toast('已验收通过'); } catch (err) { toast(err.message); } }
};
$('#msgText').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#msgForm').requestSubmit(); } };
$('#msgForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('#msgText').value.trim(); if (!text) return;
  try { await call('POST', `/api/spaces/${sid}/messages`, { text, to: $('#msgTo').value || undefined }); $('#msgText').value = ''; } catch (err) { toast(err.message); }
};

// ---------- 一句话拉 AI 进来（局域网） ----------
$('#inviteAiBtn').onclick = () => {
  const lan = S.lan || { mdns: location.origin, ips: [] };
  const pub = /^https:\/\//.test(S.publicUrl || '') ? S.publicUrl : '';
  const sentence = () => `请加入我自己搭的 AI 团队看板 Agent_room：用 curl 读 ${lan.mdns} 的接口说明（打不开就用 ${[lan.ips[0], pub].filter(Boolean).join('，再不行用 ') || lan.mdns}），按说明敲门，介绍里写上你的名字、hostname、模型和所在工具。我在网页上批准后，保存令牌，然后处理派给你的任务，做完一项接着取下一项。${$('#withRules').checked ? '另外，我同意你按说明里的约定，把这个房间记进本项目的规则文件，以后开新对话先去看有没有派给你的任务。' : ''}${$('#withGraph').checked ? '我也同意你按说明里「省上下文」一节，装 Graphify 给你工作的代码仓库建一张代码知识图（只解析代码、本机离线），以后查代码先用 graphify query。' : ''}删除大量文件、强制推送、发布上线、动用密钥前先问我。`;
  $('#oneLine').value = sentence();
  $('#withRules').onchange = $('#withGraph').onchange = () => { $('#oneLine').value = sentence(); };
  $('#lanHint').innerHTML = `首选地址 <code class="ic">${esc(lan.mdns)}</code> 是这台电脑的局域网名字，IP 变了也能用。备用：${lan.ips.map(x => `<code class="ic">${esc(x)}</code>`).join(' ') || '无'}。${pub ? `<br>公网地址 <code class="ic">${esc(pub)}</code>：不在同一个网络里的 AI 也能用它敲门，仍然要你批准才能进来。` : '<br>不在同一个网络里的 AI 打不开，这是故意的。想让外网的 AI 也能进来：在终端运行 <code class="ic">node cli.js domain room.你的域名.com</code>。'}`;
  $('#inviteAiDlg').showModal();
};
$('#inviteAiDlg').onclick = async e => { const c = e.target.dataset.copy; if (c) { const el = $('#' + c); el.select(); await navigator.clipboard.writeText(el.value).catch(() => document.execCommand('copy')); toast('已复制，发给任意一个 AI 就行'); } };

// ---------- 添加 AI 成员 / 接入方式 ----------
let conn = null, connName = '';
const copyBox = (id, label, value, rows) => `<p class="muted small">${label}</p><div class="copy-row"><textarea id="${id}" rows="${rows}" readonly>${esc(value)}</textarea><button type="button" data-copy="${id}">复制</button></div>`;
function renderConnect(c) {
  document.querySelectorAll('.ctab').forEach(b => b.classList.toggle('active', b.dataset.c === c));
  const k = conn;
  const body = {
    plain: copyBox('pl1', '粘贴到这个 AI 的对话框发送（Claude Code、Codex、Cursor 里的 Grok 都行，只要它能执行命令或联网）：', k.plain, 6)
      + '<p class="muted small">不用运行任何命令。缺点：AI 的对话一结束它就停了，要你再去发一句；成员列表里有「复制唤醒语」。</p>',
    online: '<p class="muted small">在这个 AI 平时工作的那台电脑上，进到项目目录，运行下面这一行（需要 Node.js 18+，以及已登录的 claude 或 codex 命令行）：</p>'
      + copyBox('on1', '', k.online, 3)
      + '<label class="inline small"><input type="checkbox" id="fullAuto" /> 允许它运行常用开发命令（git、npm、python、pytest 等，不用再逐条确认；rm -rf、sudo、强制推送等危险命令始终禁止）</label>'
      + '<p class="muted small">之后你在网页上发给它的消息会直接进入它的会话；它空闲时会自动接下一项任务，停了自动续上。窗口关掉就断开，再运行同一行命令接着来。<br>勾选后，监督者派的活它可以在这台电脑上直接跑测试、提交代码。只在你信任空间里所有成员时勾选。<br>Cursor 聊天窗口里的 Grok 没有可接管的会话，请用「一句话接入」。</p>',
    cline: '<p class="muted small">适用于 VS Code / Cursor 里的 Cline 插件（用你自己的第三方 API Key，不需要 Cursor 会员）。</p>'
      + copyBox('cl0', '① 在装了 Cline 的那台电脑上打开终端，运行这一段（会自动找到 Cline 的配置文件，先备份，保留你已有的其他服务）：', k.clineCmd, 6)
      + '<p class="muted small">② 回到 Cline 面板，点顶部的 MCP Servers 图标，在已安装列表里看到 <b>ai-space</b> 变绿、能展开看到 next、update_task 等工具就好了。没出现的话，重启一下编辑器。</p>'
      + copyBox('cl2', '③ 在 Cline 的对话框里发这句话（模式选 Act）：', k.prompt, 4)
      + '<details><summary>不想用命令？手动粘贴配置</summary><p class="muted small">Cline 面板 → MCP Servers 图标 →「Manage MCP Servers」或齿轮 →「Configure MCP Servers」，打开 JSON 文件，把下面 <code class="ic">"ai-space"</code> 这一项合并进 <code class="ic">mcpServers</code>，保存。<code class="ic">"type": "streamableHttp"</code> 不能删。</p>' + copyBox('cl1', '', k.cline, 12) + '</details>'
      + '<p class="muted small">Cline 的对话一结束它就停了，有新任务时在成员列表里点「复制唤醒语」发给它。</p>',
    mcp: '<p class="muted small">让 AI 每次打开都自动连上空间（可选，一般不需要）。</p>'
      + '<details><summary>Claude Code</summary>' + copyBox('cc1', '终端运行一次：', k.claude, 2) + copyBox('cc2', '然后在 Claude Code 里发：', k.prompt, 4) + '</details>'
      + '<details><summary>Codex</summary>' + copyBox('cx1', '终端运行一次（会先备份 ~/.codex/config.toml）：', k.codex, 7) + copyBox('cx2', '然后在 Codex 里发：', k.prompt, 4) + '</details>'
      + '<details><summary>Cursor（含 Grok）</summary>' + copyBox('cu0', '终端运行一次（保留已有配置，先备份 ~/.cursor/mcp.json），然后重启 Cursor：', k.cursorCmd, 6) + copyBox('cu2', '在 Cursor 的 Agent 模式里发：', k.prompt, 4) + '</details>',
  }[c];
  $('#connectBody').innerHTML = body;
  const fa = $('#fullAuto');
  if (fa) fa.onchange = () => { $('#on1').value = k.online + (fa.checked ? ' --full-auto' : ''); };
}
let connId = '';
async function rotateToken() {
  if (!connId || !confirm(`给「${connName}」换一个新令牌？旧的一句话、接入命令、MCP 配置会立即失效，需要把新的重新发给它。`)) return;
  try { const r = await call('POST', `/api/spaces/${sid}/members/${connId}/rotate`); if (r.connect) { conn = r.connect; renderConnect(document.querySelector('.ctab.active')?.dataset.c || 'plain'); } toast('已换新令牌，旧的已失效'); } catch (err) { toast(err.message); }
}
function openConnect(info, name, tab = 'plain', id = '') {
  connId = id;
  conn = info; connName = name;
  $('#connectTitle').textContent = `「${name}」的接入方式`;
  renderConnect(tab);
  $('#rotateBtn').classList.toggle('hidden', !connId);
  $('#connectDlg').showModal();
}
document.querySelectorAll('.ctab').forEach(b => b.onclick = () => renderConnect(b.dataset.c));
$('#rotateBtn').onclick = rotateToken;
$('#connectDlg').onclick = async e => { const c = e.target.dataset.copy; if (c) { const el = $('#' + c); el.select(); await navigator.clipboard.writeText(el.value).catch(() => document.execCommand('copy')); toast('已复制'); } };
$('#addMemberBtn').onclick = () => { $('#addForm').reset(); $('#addDlg').showModal(); };
$('#addForm').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const r = await call('POST', `/api/spaces/${sid}/members`, { ...f, kind: 'ai' });
    $('#addDlg').close();
    openConnect(r.connect, r.member.name, 'plain', r.member.id);
  } catch (err) { toast(err.message); }
};

// ---------- 邀请 ----------
function openInvite() {
  if (!S?.inviteCode) return toast('只有管理员或监督者能查看邀请链接');
  const link = `${ORIGIN()}/s/${sid}?invite=${S.inviteCode}`;
  const guide = `${ORIGIN()}/api/spaces/${sid}/guide?invite=${S.inviteCode}`;
  $('#humanLink').value = link;
  $('#aiPrompt').value = `你被邀请加入一个多 AI 协作空间「${S.space.name}」。\n请先读取这个地址获取接入说明，然后按说明加入并开始工作：\n${guide}\n\n加入后请定期轮询收件箱，执行派给你的任务，完成后提交验收。\n重要：每做完一步，都要调用日志接口记录「做了什么、遇到什么问题、下一步」，不要攒到最后。\n最重要：不要做完一项就停。按说明里的「工作循环」反复调用 /next，直到返回 stop=true。`;
  $('#resetInvite').classList.toggle('hidden', S.me.role !== 'admin');
  if (/localhost|127\.0\.0\.1/.test(new URL(ORIGIN()).hostname)) toast('提示：现在没有公网地址，这些链接只能在本机用。用 npm start 启动会自动生成公网地址');
  $('#inviteDlg').showModal();
}
$('#inviteBtn').onclick = openInvite;
$('#inviteDlg').onclick = async e => {
  const c = e.target.dataset.copy;
  if (c) { const el = $('#' + c); el.select(); await navigator.clipboard.writeText(el.value).catch(() => document.execCommand('copy')); toast('已复制'); }
};
$('#resetInvite').onclick = async () => {
  if (!confirm('重置后旧的邀请链接立即失效，已加入的成员不受影响。继续？')) return;
  try { const r = await call('POST', `/api/spaces/${sid}/reset-invite`); S.inviteCode = r.inviteCode; $('#inviteDlg').close(); openInvite(); } catch (err) { toast(err.message); }
};

// ---------- 派发任务 ----------
$('#newTaskBtn').onclick = () => {
  const f = $('#taskForm'); f.reset();
  f.assignee.innerHTML = `<option value="">待认领（任何员工可接）</option>` + S.members.filter(m => m.role === 'employee').map(m => `<option value="${m.id}">${esc(m.name)}${m.online ? ' · 在线' : ''}</option>`).join('');
  $('#taskDlg').showModal();
};
$('#taskForm').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try { await call('POST', `/api/spaces/${sid}/tasks`, { ...f, assignee: f.assignee || null }); $('#taskDlg').close(); toast('任务已派发'); } catch (err) { toast(err.message); }
};

setInterval(() => S && renderMembers(), 30000);
window.onpopstate = route;
route();
