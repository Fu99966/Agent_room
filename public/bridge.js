#!/usr/bin/env node
// AI 协作空间 · 实时桥接：把网页上的对话直接接进 AI 的会话，AI 的回复和过程实时回到网页。
//
// claude：常驻一个 Claude Code 会话（stream-json 输入），网页消息随时注入，AI 做到一半也能收到。
// codex ：用 `codex exec resume <线程ID>` 续接同一个线程，每条消息是同一会话里的新一轮。
// 两者都会记住会话 ID，脚本重启后接着原来的对话。
//
// 用法（零依赖，Node 18+，在 AI 要工作的项目目录里运行）：
//   node bridge.js --space "<空间链接，可带 ?invite=>" --agent claude --name "Claude-Mac"
// 可选：--cwd <目录>  --model <模型>  --permission-mode acceptEdits|bypassPermissions
//       --allow "Bash(pytest:*) Bash(git:*)"   --new（丢弃旧会话，重新开始）
//       --autonomous（没有新消息时也按 /next 自动派活，不间断工作）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--')) ? true : process.argv[++i];
}
if (!args.space) { console.log('用法：node bridge.js --space "<空间链接>" --agent claude|codex [--name 名字] [--autonomous]'); process.exit(1); }

let base, spaceId;
if (/^https?:\/\//.test(args.space)) {
  const u = new URL(args.space);
  base = u.origin;
  spaceId = (u.pathname.match(/\/(?:s|api\/spaces)\/([a-f0-9]+)/) || [])[1];
  args.invite ||= u.searchParams.get('invite');
} else { base = args.base || 'http://localhost:4300'; spaceId = args.space; }
if (!spaceId) { console.error('无法从链接里识别空间 ID'); process.exit(1); }

const agent = args.agent || 'claude';
const cwd = path.resolve(args.cwd || process.cwd());
const stateFile = path.join(cwd, `.ai-space-${spaceId}.bridge.json`);
const tokenFile = path.join(cwd, `.ai-space-${spaceId}.token`);
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
if (args.new) delete state.session;
let token = args.token || state.token || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify({ ...state, token }, null, 1), { mode: 0o600 });
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, timeout = 70000) {
  const r = await fetch(`${base}/api/spaces/${spaceId}${p}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return data;
}
const quiet = p => p.catch(e => log('上报失败：', e.message));

// ---------- 上报 AI 会话过程（合并发送，避免刷屏） ----------
let outbox = [], flushTimer = null;
function report(kind, text, turn) {
  if (!text || !String(text).trim()) return;
  outbox.push({ kind, text: String(text).slice(0, 4000), turn });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}
function flush() { if (!outbox.length) return; const events = outbox; outbox = []; quiet(api('POST', '/stream', { events })); }
function setState(s) { quiet(api('POST', '/stream', { state: s, agent, session: state.session || '' })); }
async function say(text) {
  // AI 的最终回复发回协作频道（公开），其他成员和 AI 都能看到
  if (!text || !text.trim()) return;
  try { await api('POST', '/messages', { text: text.slice(0, 8000) }); } catch (e) { log('回复发送失败：', e.message); }
}

function preamble(me) {
  return `你已接入 AI 协作空间「${me.spaceName}」，身份：${me.name}（${me.roleLabel}）。
空间接口：${base}/api/spaces/${spaceId}，token：${token}
完整接入说明（务必先读）：curl -s '${base}/api/spaces/${spaceId}/guide?token=${token}'

这个会话已经和空间网页实时连通：
- 之后发给你的每条消息都来自空间网页，开头会标明是谁发的（管理员 / 监督者 / 其他 AI）。
- 你的每次回复会自动发到空间的协作频道，所以直接回答即可，不需要再用 curl 发消息。
- 任务、日志、验收仍然用 curl 调用空间接口完成。`;
}
const fmt = m => `【${m.fromName}${m.fromRole ? ` · ${m.fromRole}` : ''}${m.to ? ' · 私信你' : ' · 频道'}】\n${m.text || ''}${m.kind === 'file' ? `\n（发来了 ${(m.files || []).length} 个文件：${(m.files || []).join('、')}。要看图请下载预览再读取：curl -s '${base}/api/spaces/${spaceId}/files/<文件ID>/preview' -H 'authorization: Bearer ${token}' -o /tmp/<文件ID>.jpg ，视频用 /sheet 看 9 帧缩略图墙）` : ''}`;

// ---------- Claude：常驻会话 ----------
function claudeDriver(onFinal) {
  let child = null, busy = false, turn = 0;
  const start = () => {
    const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', args['permission-mode'] || 'acceptEdits',
      '--allowedTools', 'Bash(curl:*)', ...String(args.allow || '').split(' ').filter(Boolean)];
    if (args.model) argv.push('--model', args.model);
    if (state.session) argv.push('--resume', state.session);
    log(`▶ 启动 Claude 会话${state.session ? `（续接 ${state.session.slice(0, 8)}…）` : ''}`);
    child = spawn('claude', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    child.on('error', e => { log('✗ 无法启动 claude：', e.message); process.exit(1); });
    child.stderr.on('data', d => { const t = String(d).trim(); if (t && !/unrecognized_model/.test(t)) log('claude:', t.slice(0, 300)); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.session_id && e.session_id !== state.session) { state.session = e.session_id; saveState(); }
      if (e.type === 'assistant') {
        for (const c of e.message?.content || []) {
          if (c.type === 'text' && c.text.trim()) report('text', c.text, turn);
          if (c.type === 'tool_use') report('tool', `${c.name} ${JSON.stringify(c.input).slice(0, 300)}`, turn);
          if (c.type === 'thinking' && c.thinking) report('think', c.thinking.slice(0, 600), turn);
        }
      } else if (e.type === 'user') {
        for (const c of e.message?.content || []) if (c.type === 'tool_result') {
          const t = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : String(c.content || '');
          report('result', t.slice(0, 800), turn);
        }
      } else if (e.type === 'result') {
        busy = false; setState('idle'); flush();
        if (e.is_error || e.subtype !== 'success') report('error', `本轮结束：${e.subtype}`, turn);
        onFinal(e.result || '');
      }
    });
    child.on('close', code => {
      log(`■ Claude 会话退出 code=${code}，3 秒后重启并续接`);
      child = null; busy = false; setState('offline');
      setTimeout(start, 3000);
    });
  };
  start();
  return {
    send(text) {
      // stream-json 输入：AI 正在做事时也能收到，会在当前步骤后处理
      if (!child) return false;
      turn++; busy = true; setState('working');
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      return true;
    },
    get busy() { return busy; },
    stop() { child?.kill(); },
  };
}

// ---------- Codex：同一线程逐轮续接 ----------
function codexDriver(onFinal) {
  let busy = false, queue = [], turn = 0, current = null;
  const runOne = async () => {
    if (busy || !queue.length) return;
    busy = true; setState('working'); turn++;
    const text = queue.splice(0).join('\n\n---\n\n');
    // 可写工作目录 + 允许联网（要用 curl 调空间接口）；resume 子命令不接受 -s，统一用 -c 覆盖配置
    const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode=${args.sandbox || 'workspace-write'}`, '-c', 'sandbox_workspace_write.network_access=true'];
    if (args.model) common.push('-m', args.model);
    const argv = state.session ? ['exec', 'resume', state.session, ...common, text] : ['exec', ...common, text];
    log(`▶ Codex 第 ${turn} 轮${state.session ? `（线程 ${state.session.slice(0, 8)}…）` : ''}`);
    let final = '';
    await new Promise(resolve => {
      current = spawn('codex', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      current.on('error', e => { log('✗ 无法启动 codex：', e.message); resolve(); });
      readline.createInterface({ input: current.stdout }).on('line', line => {
        let e; try { e = JSON.parse(line); } catch { return; }
        if (e.thread_id && e.thread_id !== state.session) { state.session = e.thread_id; saveState(); }
        const it = e.item;
        if (e.type === 'item.completed' && it) {
          if (it.type === 'agent_message') { final = it.text; report('text', it.text, turn); }
          else if (it.type === 'reasoning' && it.text) report('think', it.text.slice(0, 600), turn);
          else if (it.type === 'command_execution') report('tool', `$ ${it.command}\n${String(it.aggregated_output || '').slice(0, 600)}`, turn);
          else if (it.type === 'file_change') report('tool', `改动文件：${(it.changes || []).map(c => c.path).join(', ')}`, turn);
          else if (it.type === 'error' && !/deprecated/.test(it.message || '')) report('error', it.message, turn);
        }
      });
      current.on('close', () => { current = null; resolve(); });
    });
    busy = false; setState('idle'); flush();
    onFinal(final);
    runOne();
  };
  return {
    send(text) { queue.push(text); runOne(); return true; },
    get busy() { return busy; },
    stop() { current?.kill(); },
  };
}

// ---------- 主循环 ----------
(async () => {
  if (!token || args.invite) {
    const r = await api('POST', '/join', { invite: args.invite, token: token || undefined, name: args.name || `${agent}-${os.hostname()}`, kind: 'ai', model: args.model || agent });
    token = r.token;
    log(r.rejoined ? '已恢复原身份' : `已加入空间，角色：${r.role}`);
  }
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  saveState();

  const st = await api('GET', '/state');
  const ROLE = { admin: '管理员', supervisor: '监督者', employee: '员工' };
  const me = { ...st.me, spaceName: st.space.name, roleLabel: ROLE[st.me.role] };
  let members = st.members;
  const who = async id => {
    let m = members.find(x => x.id === id);
    if (!m) { try { members = (await api('GET', '/state')).members; m = members.find(x => x.id === id); } catch { } }
    return m || {};
  };
  // 哪些消息要注入会话：人发的、私信我的、@我的、我任务的验收结果、（我是监督者时）提交验收。
  // 其他 AI 在频道里的普通发言不注入，避免两个 AI 互相回复停不下来。
  async function relevant(m) {
    const from = await who(m.from);
    if (m.to === me.id) return true;
    if (m.kind === 'chat') return from.kind === 'human' || m.text.includes('@' + me.name);
    if (m.kind === 'submit') return me.role !== 'employee';
    if (m.kind === 'file') return me.role !== 'employee' || from.kind === 'human';
    if (m.kind === 'approve' || m.kind === 'reject') { const st2 = await api('GET', '/state').catch(() => null); return !!st2?.tasks.find(t => t.id === m.taskId && t.assignee === me.id); }
    return false;
  }
  log(`已连接「${me.spaceName}」，身份 ${me.name}（${me.roleLabel}），工作目录 ${cwd}`);

  const driver = (agent === 'codex' ? codexDriver : claudeDriver)(text => say(text));
  if (!state.session) driver.send(preamble(me) + '\n\n请先读接入说明，然后在频道里简短报到（说明你是谁、能做什么）。');
  setState('idle');

  // 从上次处理到的消息之后开始；首次接入只处理接入之后的新消息
  let since = state.since || Date.now();
  let fails = 0;
  process.on('SIGINT', () => { log('退出桥接'); setState('offline'); flush(); driver.stop(); setTimeout(() => process.exit(0), 500); });

  while (true) {
    let r;
    const msgOnly = !(args.autonomous && !driver.busy);
    try { r = await api('GET', `/next?wait=50&since=${since}${msgOnly ? '&msgOnly=1' : ''}`); fails = 0; }
    catch (e) {
      if (e.status === 401 || e.status === 404) { log(`✗ ${e.message}，桥接退出`); process.exit(1); }
      fails++; await sleep(Math.min(60, 5 * fails) * 1000); continue;
    }
    if (r.stop) { log(`🎯 ${r.instruction}`); driver.send(`【系统】${r.instruction}请做最后的收尾和总结。`); await sleep(5000); break; }

    const all = (r.messages || []).filter(m => m.at > since);
    if (all.length) { since = Math.max(...all.map(m => m.at)); state.since = since; saveState(); }
    const fresh = [];
    for (const m of all) if (await relevant(m)) fresh.push(m);
    if (fresh.length) {
      const text = (await Promise.all(fresh.map(async m => fmt({ ...m, fromRole: ROLE[(await who(m.from)).role] || '' })))).join('\n\n');
      log(`✉ 注入 ${fresh.length} 条消息：${fresh.map(m => m.fromName).join('、')}`);
      driver.send(text);
      quiet(api('POST', '/delivered', { ids: fresh.map(m => m.id) }));
      continue;
    }
    if (all.length) continue;
    since = Math.max(since, r.now - 1);
    // 自主模式：空闲时按空间派的活继续干
    if (args.autonomous && !driver.busy && r.action !== 'wait' && r.action !== 'reply') {
      log(`→ 自主执行 ${r.action}`);
      driver.send(`【空间调度 · ${r.action}】${r.instruction}${r.task ? `\n任务（ID ${r.task.id}）：${r.task.title}\n${r.task.description || ''}` : ''}`);
      await sleep(3000);
    } else if (!msgOnly) await sleep(5000);
  }
  driver.stop(); setState('offline'); flush();
  setTimeout(() => process.exit(0), 800);
})().catch(e => { console.error(e); process.exit(1); });
