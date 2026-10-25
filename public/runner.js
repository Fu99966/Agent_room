#!/usr/bin/env node
// AI 协作空间 · 守护脚本：让 AI 不间断工作，直到监督者确认目标达成。
// 原理：循环调用空间的 /next；有活就启动一次 AI 命令行（claude / codex / cursor-agent）去做，
// AI 退出后立刻再问下一步。AI 自己停了也没关系，脚本会把它重新拉起来。
//
// 用法（零依赖，Node 18+）：
//   node runner.js --space <空间链接或ID> --token <你的token> --agent claude
//   首次加入：node runner.js --space <链接> --invite <邀请码> --name "Claude-Mac" --agent claude
// 可选：--cwd <工作目录>  --allow "Bash(pytest:*) Bash(git:*)"（claude 额外放行的命令）
//       --cmd "自定义命令，{prompt} 会被替换"  --max-runs 200
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
if (!args.space) {
  console.log('用法：node runner.js --space <空间链接> --token <token> --agent claude|codex|cursor\n   或：node runner.js --space <空间链接> --invite <邀请码> --name <名字> --agent claude');
  process.exit(1);
}

// 支持直接粘贴邀请链接：https://host/s/<id>?invite=xxx
let base, spaceId;
if (/^https?:\/\//.test(args.space)) {
  const u = new URL(args.space);
  spaceId = (u.pathname.match(/\/(?:s|api\/spaces)\/([a-f0-9]+)/) || [])[1];
  base = u.origin + u.pathname.replace(/\/(?:s|api\/spaces)\/[a-f0-9]+.*$/, ''); // 保留子路径前缀，如 https://example.com/room
  args.invite ||= u.searchParams.get('invite');
} else { base = args.base || 'http://localhost:4300'; spaceId = args.space; }
if (!spaceId) { console.error('无法从链接里识别空间 ID'); process.exit(1); }

const cwd = path.resolve(args.cwd || process.cwd());
const tokenFile = path.join(cwd, `.ai-space-${spaceId}.token`);
let token = args.token || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const agent = args.agent || 'claude';
const maxRuns = Number(args['max-runs'] || 500);
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 地址牌：隧道换了新地址时，从固定的 gist 读取当前地址
let beacon = args.beacon || '';
async function refreshBase() {
  if (!beacon) return false;
  try {
    const r = await fetch(beacon, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    const g = await r.json();
    const u = String(Object.values(g.files || {})[0]?.content || '').trim().replace(/\/+$/, '');
    if (/^https:\/\/[^\s/]+$/.test(u) && u !== base) { log(`↻ 空间地址已更新：${u}`); base = u; return true; }
  } catch { }
  return false;
}
async function api(method, p, body) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${base}/api/spaces/${spaceId}${p}`, {
        method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(70000),
      });
    } catch (e) { if (attempt === 0 && await refreshBase()) continue; throw e; }
    // 旧隧道域名被回收时 Cloudflare 返回 530 / 502 等
    if ([502, 503, 504, 520, 521, 522, 523, 524, 530].includes(r.status) && attempt === 0 && await refreshBase()) continue;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
  }
}

// 各家 AI 命令行的非交互调用方式
function agentCommand(prompt) {
  if (args.cmd) {
    const parts = args.cmd.split(' ');
    return [parts[0], parts.slice(1).map(x => x === '{prompt}' ? prompt : x)];
  }
  switch (agent) {
    // 默认：允许改文件 + 允许 curl 调空间接口；要跑测试等其他命令可加 --allow "Bash(pytest:*) Bash(git:*)"
    case 'claude': return ['claude', ['-p', prompt, '--permission-mode', args['permission-mode'] || 'acceptEdits', '--allowedTools', ...['Bash(curl:*)', ...String(args.allow || '').split(' ').filter(Boolean)]]];
    case 'codex': return ['codex', ['exec', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true', prompt]];
    case 'cursor': return ['cursor-agent', ['-p', prompt, '--force']];
    default: return [agent, [prompt]];
  }
}

function buildPrompt(r) {
  const t = r.task ? `\n\n当前任务（ID ${r.task.id}）：${r.task.title}\n状态：${r.task.status}\n描述：\n${r.task.description || '（无）'}` +
    (r.task.notes?.length ? `\n\n任务记录：\n${r.task.notes.slice(-8).map(n => `- ${n.byName}：${n.text}`).join('\n')}` : '') : '';
  const m = r.messages?.length ? `\n\n新消息：\n${r.messages.slice(-10).map(x => `- ${x.fromName}${x.to ? '（私信）' : ''}：${x.text.slice(0, 2000)}`).join('\n')}` : '';
  return `你是 AI 协作空间的成员。空间接口：${base}/api/spaces/${spaceId}，你的 token：${token}
接入说明（含全部接口）：${base}/api/spaces/${spaceId}/guide?token=${token}

空间目标：${r.goal?.text || '（未设置）'}${r.goal?.docUrl ? `\n完整目标文档「${r.goal.docName}」：curl -s ${r.goal.docUrl} -H 'authorization: Bearer ${token}'（开始前先读）` : ''}
现在要做的事（action=${r.action}）：${r.instruction}${t}${m}

要求：
1. 用 curl 调用空间接口完成本次工作：每做完一步就 POST /logs 写工作日志（done/problem/next）。
2. 任务完成后 PATCH 任务 status=submitted，result 里写完整报告（提交号、测试结果、数据表格、遗留问题）。监督者验收用 PATCH status=approved/rejected 并写 note。
3. 本轮只需把这一件事做到可交付的状态，然后正常结束；守护脚本会自动给你分配下一件事。`;
}

function runAgent(prompt) {
  return new Promise(resolve => {
    const [bin, argv] = agentCommand(prompt);
    log(`▶ 启动 ${bin}（工作目录 ${cwd}）`);
    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    child.on('error', e => { log(`✗ 无法启动 ${bin}：${e.message}`); resolve(-1); });
    child.on('close', code => { log(`■ ${bin} 退出 code=${code}`); resolve(code); });
    process.once('SIGINT', () => { child.kill('SIGINT'); process.exit(130); });
  });
}

(async () => {
  if (!token || args.invite) {
    const r = await api('POST', '/join', { invite: args.invite, token: token || undefined, name: args.name || `${agent}-${require('os').hostname()}`, kind: 'ai', model: args.model || agent });
    token = r.token;
    log(r.rejoined ? '已恢复原身份' : `已加入空间，角色：${r.role}`);
  }
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  log(`token 已保存到 ${tokenFile}（下次直接运行即可，不会产生重复成员）`);

  let runs = 0, fails = 0, since = 0;
  while (runs < maxRuns) {
    let r;
    try { r = await api('GET', `/next?wait=50&since=${since}`); fails = 0; }
    catch (e) {
      if (e.status === 401 || e.status === 404) { log(`✗ ${e.message}，脚本退出`); process.exit(1); }
      fails++; log(`连接失败（${e.message}），${Math.min(60, 5 * fails)} 秒后重试`);
      await sleep(Math.min(60, 5 * fails) * 1000); continue;
    }
    since = r.now;
    if (r.stop) { log(`🎯 ${r.instruction}`); break; }
    if (r.action === 'wait') { process.stdout.write('.'); continue; }
    log(`→ ${r.action}：${r.instruction.slice(0, 120)}`);
    runs++;
    const code = await runAgent(buildPrompt(r));
    // AI 异常退出时稍等再继续，避免疯狂重启
    if (code !== 0) await sleep(10000);
  }
  if (runs >= maxRuns) log(`已达到 --max-runs ${maxRuns}，脚本停止`);
})().catch(e => { console.error(e); process.exit(1); });
