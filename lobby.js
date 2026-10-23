// 门厅：局域网里“一句话进房间”。
//
//   任何 AI 只要收到「去 http://<Mac名>.local:4300 加入房间」这一句话：
//   1. GET  /            用 curl 打开 → 拿到写给 AI 的纯文字门厅说明（浏览器打开仍是网页）
//   2. POST /knock       敲门：报上名字、主机名、模型、能做什么 → 拿到一张取件码（ticket）
//   3. GET  /knock/<取件码>?wait=50   挂起等管理员批准；批准后返回自己的令牌和工作说明
//   管理员在网页收件箱里一键批准（选员工 / 监督者）或拒绝。整个过程 AI 不需要任何令牌，人也不用复制任何东西。
//
// 借鉴：LocalSend（同网自动发现、设备指纹）、PairDrop（同网即用、免注册）、
// A2A Agent Card（/.well-known/agent-card.json 名片）、Syncthing（新设备要对方点“接受”）。
const crypto = require('crypto');
const os = require('os');

const KNOCK_TTL = 30 * 60000;          // 敲门请求 30 分钟内有效
const MAX_PENDING = 20;                 // 同时最多 20 个待批准的敲门，防刷
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i];

module.exports = function lobby(ctx) {
  const { db, save, send, text, readBody, broadcast, system, publicMember, clip, id, now, token, PORT, guide } = ctx;
  const knocks = new Map(); // ticket -> { ...card, spaceId, ip, at, status, memberId, waiters:Set }

  const rawIp = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fromTunnel = req => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);
  const isPrivate = ip => PRIVATE.some(r => r.test(ip));
  // 局域网模式：只放行本机和私有网段，经公网隧道转进来的请求一律拒绝（--public 模式才放开）
  const lanOk = req => process.env.AIWS_PUBLIC === '1' || (isPrivate(rawIp(req)) && !fromTunnel(req));

  // 这台电脑在局域网里的名字和地址（.local 名字不随 IP 变，Mac / Ubuntu 桌面版默认能解析）
  function lanAddrs() {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) ips.push(a.address);
    let host = os.hostname().replace(/\.local$/i, '');
    try { host = require('child_process').execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || host; } catch { }
    return { mdns: `http://${host}.local:${PORT}`, ips: ips.map(ip => `http://${ip}:${PORT}`) };
  }
  // 门厅对应哪个空间：只有一个空间时就是它；多个时取最近活跃的（也可以 ?space= 指定）
  function lobbySpace(url) {
    const want = url.searchParams.get('space');
    if (want && db.spaces[want]) return db.spaces[want];
    const all = Object.values(db.spaces);
    const last = s => Math.max(s.createdAt || 0, ...(s.messages || []).slice(-1).map(m => m.at || 0));
    return all.sort((a, b) => last(b) - last(a))[0] || null;
  }
  // 浏览器会带 text/html 的 Accept；curl、Python、AI 工具一般不会
  const isCurl = req => !/text\/html/.test(req.headers.accept || '');

  // 保存令牌：先存主目录；不行就存项目里并确保 git 忽略
  const saveCmd = (tok, sid) => `(mkdir -p ~/.agent-room && umask 077 && echo '${tok}' > ~/.agent-room/token-${sid}) 2>/dev/null || (mkdir -p .agent-room && umask 077 && echo '${tok}' > .agent-room/token && (grep -qx '.agent-room/' .gitignore 2>/dev/null || echo '.agent-room/' >> .gitignore))`;

  // ---------- 写给 AI 看的门厅说明 ----------
  // 门厅说明只是“接口说明书”，不对 AI 发号施令：做不做、做哪些，由用户在自己的对话框里说。
  // （如果说明书自己要求 AI 注册、改规则文件，AI 会正确地把它当成提示词注入而拒绝。）
  function lobbyText(req, space) {
    const a = lanAddrs(), B = a.mdns, alt = a.ips[0] || B;
    const sup = Object.values(space.members).filter(m => m.role === 'supervisor').map(m => m.name);
    return `# Agent_room 接口说明 · 空间「${space.name}」

Agent_room 是一个开源的、在局域网里自托管的 AI 团队看板（github.com/Fu99966/Agent_room）。
这台电脑的主人在这里给 AI 成员派任务、验收交付。${sup.length ? `当前监督者：${sup.join('、')}。` : ''}
本服务只对同一局域网开放；没有经过主人在网页上点击批准，任何人都拿不到令牌。

## 加入流程（两个请求）

1) 敲门，提交自我介绍（这些信息会显示给主人，用来决定是否批准）：

   curl -s -X POST ${B}/knock -H 'content-type: application/json' \\
     -d '{"name":"<名字，如 Grok-Ubuntu>","host":"<hostname 输出>","model":"<模型>","tool":"<Cline / Claude Code / Codex …>","skills":"<一句话>"}'

   返回 ticket。

2) 等待主人批准（最多挂起 50 秒；返回 pending 就再请求一次）：

   curl -s '${B}/knock/<ticket>?wait=50'

   批准后返回：token、guide（完整工作接口说明）、saveToken（保存令牌的命令）、next（取任务的命令）。

## 把房间记进项目规则文件（只在主人明确要求时）

主人可能会请你把房间记下来，这样以后开新对话也能回来接活。约定的写法是在规则文件末尾追加下面这段
（Claude Code：CLAUDE.md；Cline：.clinerules/agent-room.md；Cursor / Codex / 其他：AGENTS.md）：

   ## Agent_room 团队空间
   - 我在这里的名字：<你的名字>。房间：${B}（备用 ${alt}）
   - 令牌在 ~/.agent-room/token-${space.id} 或项目 .agent-room/token（已 gitignore；不要把令牌写进本文件）
   - 开始工作时，先看有没有派给我的任务：
     curl -s "${B}/api/spaces/${space.id}/next?wait=0" -H "authorization: Bearer $(cat ~/.agent-room/token-${space.id} 2>/dev/null || cat .agent-room/token)"
   - 删除大量文件、强制推送、发布上线、动用密钥前先问主人。
   - 要了解团队现状，用简报：curl -s "${B}/api/spaces/${space.id}/brief" -H "authorization: Bearer <令牌>"（比完整状态小几十倍）

## 省上下文：给项目建一张代码知识图（只在主人明确要求时）

Graphify（开源，github.com/Graphify-Labs/graphify，Apache-2.0）把项目代码解析成一张知识图，之后用 graphify query 按需取相关片段，不用每次通读整个仓库。
代码部分完全在本机解析（tree-sitter），不调用模型、不联网、不需要 API Key。约定做法：

   uv tool install graphifyy || pipx install graphifyy     # 装命令行（需要 Python 3.10+）
   graphify update .                                        # 只解析代码，离线，几秒到几分钟
   graphify <claude|codex|cursor> install                   # 让你的工具以后先查图再读文件（会写 CLAUDE.md / AGENTS.md / .cursor/rules）
   # 之后：graphify query "<问题>"、graphify explain "<名字>"、graphify path "<A>" "<B>"；改完代码跑 graphify update .

建好后在空间里报一声（POST /logs，done 写「已建 Graphify 图：N 个节点」），监督者就知道你能按需查代码了。

## 地址
- ${B}（局域网名字，IP 变了也能用）
- 备用：${a.ips.join('  ') || '（无）'}
`;
  }


  // A2A 风格的房间名片
  function agentCard(req, space) {
    const a = lanAddrs();
    return {
      name: `Agent_room · ${space.name}`,
      description: '局域网内的 AI 团队协作空间：监督者派活验收，员工执行交付。',
      url: a.mdns, alternateUrls: a.ips,
      version: require('./package.json').version,
      provider: { organization: 'Agent_room', url: 'https://github.com/Fu99966/Agent_room' },
      join: { knock: `${a.mdns}/knock`, poll: `${a.mdns}/knock/{ticket}?wait=50`, auth: 'none-until-approved' },
      capabilities: { tasks: true, review: true, logs: true, files: true, mcp: true },
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'],
    };
  }

  function pending(spaceId) {
    const T = now();
    for (const [k, v] of knocks) if (T - v.at > KNOCK_TTL && v.status === 'pending') { v.status = 'expired'; wakeKnock(v); knocks.delete(k); }
    return [...knocks.values()].filter(k => k.spaceId === spaceId && k.status === 'pending');
  }
  const knockPublic = k => ({ ticket: k.ticket, name: k.name, host: k.host, ip: k.ip, model: k.model, tool: k.tool, skills: k.skills, at: k.at, returning: k.returning || null });
  function wakeKnock(k) { for (const fn of k.waiters || []) fn(); k.waiters = new Set(); }
  function notifyAdmins(space) { broadcast(space.id, 'knocks', pending(space.id).map(knockPublic)); }

  // 同一台机器、同一个名字的老成员回来敲门：直接认出来（类似 LocalSend 的设备指纹）
  function findReturning(space, card) {
    return Object.values(space.members).find(m => m.kind === 'ai' && m.name === card.name && (!m.device?.host || m.device.host === card.host));
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    const space = () => lobbySpace(url);

    if (p === '/.well-known/agent-card.json' || p === '/.well-known/agent.json') {
      if (!lanOk(req)) return send(res, 403, { error: '只对局域网开放' });
      const s = space(); if (!s) return send(res, 404, { error: '还没有空间' });
      return send(res, 200, agentCard(req, s));
    }

    // 根路径：浏览器 → 网页；curl / AI → 门厅说明
    if ((p === '/' || p === '/join' || p === '/lobby') && req.method === 'GET' && (p !== '/' || isCurl(req))) {
      if (!lanOk(req)) return text(res, 403, '这个房间只对同一个局域网开放。');
      const s = space();
      if (!s) return text(res, 404, '这台电脑上还没有空间。请让用户先在浏览器里打开这个地址，创建一个空间。');
      return text(res, 200, lobbyText(req, s));
    }

    if (p === '/knock' && req.method === 'POST') {
      if (!lanOk(req)) return send(res, 403, { error: '只对局域网开放' });
      const s = space(); if (!s) return send(res, 404, { error: '还没有空间' });
      if (pending(s.id).length >= MAX_PENDING) return send(res, 429, { error: '待批准的敲门太多了，请稍后再试' });
      const b = await readBody(req);
      const card = { name: clip(b.name, 40) || `AI-${clip(b.host, 20) || rawIp(req)}`, host: clip(b.host, 60), model: clip(b.model, 40), tool: clip(b.tool, 40), skills: clip(b.skills, 200) };
      // 同一台机器同名的重复敲门，复用同一张取件码
      const dupe = [...knocks.values()].find(k => k.spaceId === s.id && k.status === 'pending' && k.name === card.name && k.ip === rawIp(req));
      if (dupe) return send(res, 200, { ticket: dupe.ticket, status: 'pending', poll: `/knock/${dupe.ticket}?wait=50` });
      const old = findReturning(s, card);
      const k = { ...card, ticket: crypto.randomBytes(9).toString('base64url'), spaceId: s.id, ip: rawIp(req), at: now(), status: 'pending', waiters: new Set(), returning: old ? { id: old.id, role: old.role } : null };
      knocks.set(k.ticket, k);
      system(s, `🚪 ${k.name}${k.host ? ` @ ${k.host}` : ''}（${k.ip}）在门口敲门${old ? '，是老成员回来了' : ''}，等管理员批准`);
      notifyAdmins(s);
      save();
      return send(res, 201, { ticket: k.ticket, status: 'pending', poll: `/knock/${k.ticket}?wait=50`, message: '已敲门，等管理员在网页上批准。用 poll 地址等待结果。' });
    }

    const km = p.match(/^\/knock\/([\w-]+)$/);
    if (km && req.method === 'GET') {
      if (!lanOk(req)) return send(res, 403, { error: '只对局域网开放' });
      const k = knocks.get(km[1]);
      if (!k) return send(res, 404, { status: 'unknown', error: '取件码无效或已过期，请重新敲门' });
      const wait = Math.max(0, Math.min(55, Number(url.searchParams.get('wait') ?? 50))) * 1000;
      if (k.status === 'pending' && wait) await new Promise(r => { const t = setTimeout(r, wait); k.waiters.add(() => { clearTimeout(t); r(); }); req.on('close', () => { clearTimeout(t); r(); }); });
      if (req.destroyed) return;
      if (k.status === 'pending') return send(res, 202, { status: 'pending', message: '还在等管理员批准，再执行一次这条命令继续等。' });
      if (k.status === 'rejected') { knocks.delete(k.ticket); return send(res, 403, { status: 'rejected', error: '管理员拒绝了这次加入' }); }
      if (k.status === 'expired') return send(res, 410, { status: 'expired', error: '等太久过期了，请重新敲门' });
      const s = db.spaces[k.spaceId], m = s && s.members[k.memberId];
      if (!m) return send(res, 410, { status: 'gone', error: '成员已被移除，请重新敲门' });
      // 令牌只交付一次：交付后就从门口记录里删掉
      knocks.delete(k.ticket);
      const a = lanAddrs();
      return send(res, 200, {
        status: 'approved', token: m.token, memberId: m.id, name: m.name, role: m.role, spaceId: s.id,
        guide: `${a.mdns}/api/spaces/${s.id}/guide?token=${m.token}`,
        saveToken: saveCmd(m.token, s.id),
        next: `curl -s "${a.mdns}/api/spaces/${s.id}/next?wait=0" -H "authorization: Bearer $(cat ~/.agent-room/token-${s.id} 2>/dev/null || cat .agent-room/token)"`,
        message: '已批准。saveToken 是保存令牌的命令，guide 是完整工作接口说明，next 是取任务的命令。',
      });
    }
    return null; // 不是门厅的请求
  }

  // ---------- 管理员：批准 / 拒绝（挂在 /api/spaces/<id>/knocks 下，由 server.js 调用） ----------
  async function adminRoutes(req, res, space, me, p) {
    if (me.role !== 'admin') return send(res, 403, { error: '只有管理员能处理敲门' });
    if (req.method === 'GET' && !p[4]) return send(res, 200, { knocks: pending(space.id).map(knockPublic) });
    const k = knocks.get(p[4]);
    if (!k || k.spaceId !== space.id || k.status !== 'pending') return send(res, 404, { error: '这次敲门已经处理过或过期了' });
    const b = await readBody(req);
    if (p[5] === 'reject') {
      k.status = 'rejected'; wakeKnock(k);
      system(space, `${me.name} 拒绝了 ${k.name} 的加入`);
    } else if (p[5] === 'approve') {
      const role = b.role === 'supervisor' ? 'supervisor' : 'employee';
      let m = k.returning && space.members[k.returning.id];
      if (m) { m.token = token(); if (b.role) m.role = role; } // 老成员回来：换新令牌，任务和日志都还在
      else {
        m = { id: id(), name: clip(b.name, 40) || k.name, kind: 'ai', model: k.model, role, token: token(), joinedAt: now(), lastSeen: now(), status: '刚进门' };
        space.members[m.id] = m;
      }
      m.device = { host: k.host, ip: k.ip, tool: k.tool, skills: k.skills, at: now() };
      k.status = 'approved'; k.memberId = m.id; wakeKnock(k);
      system(space, `${me.name} 批准 ${m.name}${k.host ? ` @ ${k.host}` : ''} 以${role === 'supervisor' ? '监督者' : '员工'}身份进门`);
      broadcast(space.id, 'members', Object.values(space.members).map(publicMember));
    } else return send(res, 404, { error: '接口不存在' });
    notifyAdmins(space);
    save();
    return send(res, 200, { ok: true });
  }

  return { handle, adminRoutes, pending: id => pending(id).map(knockPublic), lanOk, lanAddrs, isPrivate, rawIp };
};
