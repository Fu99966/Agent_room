#!/usr/bin/env node
// Agent_room 一键启动：服务 + 公网隧道 + 防睡眠 + 自动打开管理员页面，一条命令全部搞定。
//
//   npm start                         （在项目目录里）
//   npx github:Fu99966/Agent_room     （不用先下载代码）
//
// 可选参数：--local 只在本机用，不开公网隧道；--port 4300；--no-open 不自动打开浏览器；--no-beacon 不写 GitHub 地址牌
// 公网隧道用 Cloudflare 的免费临时隧道；本机没有 cloudflared 时会自动下载到 ~/.agent-room/bin。
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HOME = process.env.AGENT_ROOM_HOME || path.join(os.homedir(), '.agent-room');
// 从克隆的项目目录运行：数据放项目的 data/；通过 npx 运行（代码在 npm 缓存里）：数据放 ~/.agent-room/data
const DATA = path.resolve(process.env.AIWS_DATA || (ROOT.includes(`${path.sep}_npx${path.sep}`) ? path.join(HOME, 'data') : path.join(ROOT, 'data')));
const PUBLIC_FILE = path.join(DATA, 'public-url');
const LOCAL = flag('--local');
let PORT = Number(opt('--port', process.env.AIWS_PORT || 4300));
let stopping = false, ownServer = false, publicUrl = '', awake = false, opened = false;
const kids = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function child(cmd, args, o = {}) {
  const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...o });
  kids.add(c);
  c.on('exit', () => kids.delete(c));
  c.on('error', () => kids.delete(c));
  return c;
}
async function probe(url, ms = 5000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.text() : null; } catch { return null; }
}
function which(bin) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const d of dirs) for (const n of process.platform === 'win32' ? [bin + '.exe'] : [bin]) {
    const p = path.join(d, n);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { }
  }
  return null;
}
const portFree = p => new Promise(r => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p); });

// ---------- 服务 ----------
async function ensureServer() {
  const html = await probe(`http://localhost:${PORT}/`, 2000);
  if (html && html.includes('AI 协作空间')) { log(`· 发现 ${PORT} 端口上已经在运行 Agent_room，直接使用`); return; }
  if (!(await portFree(PORT))) {
    const busy = PORT;
    while (!(await portFree(++PORT)));
    log(`· ${busy} 端口被别的程序占用，改用 ${PORT}`);
  }
  ownServer = true;
  const start = () => {
    fs.mkdirSync(DATA, { recursive: true });
    const out = fs.openSync(path.join(DATA, 'server.log'), 'a');
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, AIWS_PORT: String(PORT), AIWS_DATA: DATA }, stdio: ['ignore', out, out] });
    kids.add(c);
    c.on('exit', code => { kids.delete(c); if (!stopping) { log(`⚠ 服务意外退出（code=${code}），3 秒后自动重启。日志：${path.join(DATA, 'server.log')}`); setTimeout(start, 3000); } });
  };
  start();
  for (let i = 0; i < 50; i++) { if (await probe(`http://localhost:${PORT}/`, 1000)) return; await sleep(200); }
  throw new Error(`服务没能启动，请看日志 ${path.join(DATA, 'server.log')}`);
}

// ---------- 防睡眠：电脑睡着了，别的设备就连不上 ----------
function keepAwake() {
  if (process.platform === 'darwin' && which('caffeinate')) { child('caffeinate', ['-dimsu', '-w', String(process.pid)]); awake = true; }
  else if (process.platform === 'linux' && which('systemd-inhibit')) { child('systemd-inhibit', ['--what=sleep:idle', '--who=Agent_room', '--why=保持协作空间在线', 'sleep', 'infinity']); awake = true; }
}

// ---------- 公网隧道 ----------
async function getCloudflared() {
  const want = process.env.AIWS_CLOUDFLARED;
  if (want && want !== 'download') return want;
  const local = path.join(HOME, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (want !== 'download') { const p = which('cloudflared'); if (p) return p; if (fs.existsSync(local)) return local; }
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  const asset = process.platform === 'darwin' ? `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`
    : process.platform === 'linux' && arch ? `cloudflared-linux-${arch}`
      : process.platform === 'win32' ? `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe` : null;
  if (!asset) throw new Error(`没有适合 ${process.platform}-${process.arch} 的 cloudflared`);
  log('· 首次使用：正在下载公网隧道工具 cloudflared（约 20MB，只需一次）……');
  const r = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`下载 cloudflared 失败（HTTP ${r.status}）`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  if (asset.endsWith('.tgz')) {
    const tgz = local + '.tgz';
    fs.writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', path.dirname(local)]);
    fs.rmSync(tgz, { force: true });
  } else fs.writeFileSync(local, buf);
  fs.chmodSync(local, 0o755);
  return local;
}

// 一直守着隧道：进程退出、隧道被 Cloudflare 回收、或连续访问不通，就重新开一条（新地址会自动同步到网页里）
async function tunnelLoop(bin) {
  while (!stopping) {
    const c = child(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
    const exited = new Promise(r => c.once('exit', r));
    let dead = 0;
    const url = await new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 60000);
      const onData = d => {
        const s = String(d);
        if (/Tunnel not found|failed to request quick Tunnel/i.test(s) && ++dead >= 3) c.kill();
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { clearTimeout(t); resolve(m[0]); }
      };
      c.stdout.on('data', onData); c.stderr.on('data', onData);
      exited.then(() => { clearTimeout(t); resolve(null); });
    });
    if (url) {
      // 新隧道要几秒才能真正连通；本机网络访问不了 trycloudflare 时也照样用，只是不做健康检查
      let verified = false;
      for (let i = 0; i < 20 && !stopping && c.exitCode === null; i++) { if (await probe(url + '/', 8000)) { verified = true; break; } await sleep(2000); }
      setPublic(url);
      let fails = 0;
      while (!stopping) {
        const r = await Promise.race([sleep(60000).then(() => 'tick'), exited.then(() => 'exit')]);
        if (r === 'exit' || dead >= 3) break;
        if (verified) { fails = (await probe(url + '/', 20000)) ? 0 : fails + 1; if (fails >= 3) break; }
      }
      if (!stopping) log('\n⚠ 公网隧道断开了，正在重新连接（地址会变，网页里的链接会自动更新）……');
    } else if (!stopping) log('⚠ 公网隧道没连上，10 秒后重试……');
    c.kill();
    if (!stopping) await sleep(url ? 2000 : 10000);
  }
}

// ---------- 固定「地址牌」：把当前公网地址写进一个固定的 GitHub secret gist ----------
// 隧道换了新地址，AI 连不上时去读这个 gist 就能拿到新地址，不用人去逐个通知。
// 用这台电脑已经登录的 gh（GitHub CLI）；没有 gh 或没登录就跳过，不影响其他功能。
const BEACON_FILE = path.join(DATA, 'beacon.json');
let beacon = null;
function gh(args, input) {
  try { return execFileSync(which('gh') || 'gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000 }).trim(); } catch { return null; }
}
function publishBeacon(url) {
  if (flag('--no-beacon') || !which('gh')) return;
  try { beacon = JSON.parse(fs.readFileSync(BEACON_FILE, 'utf8')); } catch { beacon = null; }
  const body = JSON.stringify({ files: { 'agent-room-url.txt': { content: url + '\n' } } });
  if (beacon?.id && gh(['api', `gists/${beacon.id}`, '-X', 'PATCH', '--input', '-'], body)) return;
  const login = gh(['api', 'user', '--jq', '.login']);
  if (!login) return; // gh 没登录
  const r = gh(['api', 'gists', '-X', 'POST', '--input', '-'], JSON.stringify({ description: 'Agent_room 当前公网地址（自动更新，勿删）', public: false, files: { 'agent-room-url.txt': { content: url + '\n' } } }));
  try {
    const id = JSON.parse(r).id;
    beacon = { id, login, url: `https://api.github.com/gists/${id}` };
    fs.writeFileSync(BEACON_FILE, JSON.stringify(beacon, null, 1));
    log(`· 已创建固定地址牌（GitHub secret gist）。以后隧道地址变了，AI 会自动从这里拿新地址。`);
  } catch { }
}

function setPublic(url) {
  const changed = publicUrl && publicUrl !== url;
  publicUrl = url;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PUBLIC_FILE, url);
  publishBeacon(url);
  banner(changed);
  openBrowser();
}

// ---------- 管理员入口 / 提示 ----------
function adminLink(base) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA, 'spaces.json'), 'utf8'));
    const last = s => Math.max(s.createdAt || 0, ...(s.messages || []).slice(-1).map(m => m.at || 0));
    const sp = Object.values(d.spaces || {}).sort((a, b) => last(b) - last(a))[0];
    const adm = sp && Object.values(sp.members || {}).find(m => m.role === 'admin');
    return adm ? { name: sp.name, url: `${base}/s/${sp.id}#key=${adm.token}` } : null;
  } catch { return null; }
}
function openBrowser() {
  if (opened || flag('--no-open')) return;
  opened = true;
  const a = adminLink(`http://localhost:${PORT}`);
  const url = a ? a.url : `http://localhost:${PORT}/`;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { }
}
function banner(changed) {
  const a = adminLink(publicUrl || `http://localhost:${PORT}`);
  const line = '─'.repeat(60);
  log(`\n${line}`);
  log(changed ? ' ⚠ 公网地址变了（网页里的邀请链接、接入命令已自动换成新地址）' : ' ✅ Agent_room 已启动');
  log(`   本机地址：http://localhost:${PORT}`);
  if (publicUrl) log(`   公网地址：${publicUrl}   ← 其他设备、其他 AI 用这个`);
  else log(`   公网地址：${LOCAL ? '未开启（--local 模式，只能本机访问）' : '暂时没有（隧道连不上，只能本机访问）'}`);
  if (a) log(`   管理员入口「${a.name}」：${opened || flag('--no-open') ? '' : '已在浏览器打开；'}换设备时用下面这个链接（等于管理员钥匙，别外传）\n   ${a.url}`);
  else log('   第一次使用：在打开的网页里创建空间，再点「＋ 添加 AI 成员」');
  if (changed) log('   已经接入的 AI 还记着旧地址：在成员列表里点它的「接入」，把新的一句话发给它。');
  log(`   数据目录：${DATA}`);
  log(`   ${awake ? '已阻止电脑睡眠。' : ''}保持这个窗口开着；按 Ctrl+C 停止。`);
  log(line);
}

function stop() {
  if (stopping) return;
  stopping = true;
  log('\n正在停止……');
  for (const c of kids) { try { c.kill(); } catch { } }
  try { if (fs.readFileSync(PUBLIC_FILE, 'utf8').trim() === publicUrl) fs.rmSync(PUBLIC_FILE, { force: true }); } catch { }
  if (!ownServer) log('（服务不是这次启动的，保留运行）');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

(async () => {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) { console.error(`需要 Node.js 18 或更高版本（当前 ${process.versions.node}）`); process.exit(1); }
  await ensureServer();
  keepAwake();
  if (LOCAL) { banner(false); openBrowser(); return; }
  let bin;
  try { bin = await getCloudflared(); }
  catch (e) { log(`⚠ ${e.message}。先以本机模式运行；手动安装 cloudflared 后重新启动即可生成公网地址。`); banner(false); openBrowser(); return; }
  setTimeout(openBrowser, 25000); // 隧道迟迟连不上时，先打开本机页面
  tunnelLoop(bin);
})().catch(e => { console.error('启动失败：', e.message); stop(); process.exitCode = 1; });
