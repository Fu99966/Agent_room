// 端到端测试：启动独立端口的服务，走完 创建→加入→设监督者→派活→提交→验收 全流程
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 4399, B = `http://localhost:${PORT}`;
// 测试用独立数据目录，绝不碰正式数据
const DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aiws-test-'));

async function req(method, url, body, tok) {
  const r = await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
}

let empTok2;
(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, AIWS_PORT: PORT, AIWS_DATA: DATA } });
  let errOut = ''; srv.stderr.on('data', d => errOut += d);
  await new Promise((r, j) => { srv.stdout.once('data', r); srv.once('exit', c => j(new Error(`服务启动失败（code=${c}）：\n${errOut}`))); }).catch(e => { console.error('✗', e.message); process.exit(1); });
  try {
    const c = await req('POST', '/api/spaces', { name: '测试空间', ownerName: '老板' });
    assert.equal(c.status, 201);
    const { spaceId: S, token: admin, inviteCode } = c.data;

    assert.equal((await req('POST', `/api/spaces/${S}/join`, { invite: 'wrong', name: 'x' })).status, 403);
    const g = await req('GET', `/api/spaces/${S}/guide?invite=${inviteCode}`);
    assert.ok(g.data.includes('/join'), '接入说明应包含 join 指令');

    const a = (await req('POST', `/api/spaces/${S}/join`, { invite: inviteCode, name: 'Claude-笔记本', model: 'Claude' })).data;
    const b = (await req('POST', `/api/spaces/${S}/join`, { invite: inviteCode, name: 'GPT-台式机', model: 'GPT-5' })).data;
    assert.equal(a.role, 'employee');

    // 员工不能派活、不能设角色
    assert.equal((await req('POST', `/api/spaces/${S}/tasks`, { title: 'x' }, b.token)).status, 403);
    assert.equal((await req('POST', `/api/spaces/${S}/members/${b.memberId}/role`, { role: 'supervisor' }, a.token)).status, 403);

    // 管理员指定 A 为监督者
    assert.equal((await req('POST', `/api/spaces/${S}/members/${a.memberId}/role`, { role: 'supervisor' }, admin)).data.role, 'supervisor');

    // 监督者派活给 B
    const task = (await req('POST', `/api/spaces/${S}/tasks`, { title: '写登录页', description: '需要表单校验', assignee: b.memberId }, a.token)).data;
    assert.equal(task.status, 'todo');

    // B 收件箱能看到任务
    const inbox = (await req('GET', `/api/spaces/${S}/inbox?since=0`, null, b.token)).data;
    assert.equal(inbox.myTasks.length, 1);

    // 员工不能自己验收
    assert.equal((await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'approved' }, b.token)).status, 403);
    await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'doing', progress: 40 }, b.token);
    // 提交必须带报告
    assert.equal((await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'submitted' }, b.token)).status, 400);
    const report = 'A 做完了。本地提交 `e393460`\n\n| 帧 | 腕 | 掌 |\n|---|---|---|\n| 40 | -0.5 | -1.2 |';
    const sub = (await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'submitted', result: report }, b.token)).data;
    assert.equal(sub.reviewer, a.memberId, '验收人应是派活的监督者');
    // 完整报告原样进入频道
    const chat = (await req('GET', `/api/spaces/${S}/state`, null, a.token)).data.messages;
    assert.ok(chat.some(m => m.kind === 'submit' && m.text === report && m.taskId === task.id));
    // 已有监督者时，管理员不能验收
    const adminTry = await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'approved' }, admin);
    assert.equal(adminTry.status, 403); assert.ok(adminTry.data.error.includes('Claude-笔记本'));
    // 退回必须写原因
    assert.equal((await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'rejected' }, a.token)).status, 400);

    // 工作日志：员工写，监督者按成员/任务查看
    assert.equal((await req('POST', `/api/spaces/${S}/logs`, { done: '' }, b.token)).status, 400);
    await req('POST', `/api/spaces/${S}/logs`, { taskId: task.id, done: '读完需求，开始写表单' }, b.token);
    const lg = (await req('POST', `/api/spaces/${S}/logs`, { taskId: task.id, done: '写完校验', problem: '缺少设计稿', next: '先用默认样式' }, b.token)).data;
    assert.equal(lg.memberName, 'GPT-台式机');
    const byMember = (await req('GET', `/api/spaces/${S}/logs?member=${b.memberId}`, null, a.token)).data.logs;
    assert.equal(byMember.filter(l => !l.auto).length, 2); assert.ok(byMember.some(l => l.auto && l.done.includes("进行中")), "改状态应自动记日志");
    assert.equal((await req('GET', `/api/spaces/${S}/logs?task=${task.id}`, null, admin)).data.logs.filter(l => !l.auto).length, 2);
    const st = (await req('GET', `/api/spaces/${S}/state`, null, a.token)).data;
    assert.equal(st.logs.filter(l => !l.auto).length, 2);
    assert.ok(st.members.find(m => m.id === b.memberId).lastLogAt, '成员应记录最后日志时间');
    assert.ok((await req('GET', `/api/spaces/${S}/guide?token=${b.token}`)).data.includes('工作日志'));

    const sup = (await req('GET', `/api/spaces/${S}/inbox`, null, a.token)).data;
    assert.equal(sup.reviewQueue.length, 1);
    const rej = (await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'rejected', note: '缺少错误提示' }, a.token)).data;
    assert.equal(rej.notes.length, 1);
    await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'submitted', result: '已补错误提示' }, b.token);
    const ok = (await req('PATCH', `/api/spaces/${S}/tasks/${task.id}`, { status: 'approved', note: '数据齐全' }, a.token)).data;
    assert.equal(ok.progress, 100); assert.equal(ok.reviewedBy, a.memberId);

    // 带旧 token 重新 join：恢复原身份，不产生重复成员
    const before = (await req('GET', `/api/spaces/${S}/state`, null, admin)).data.members.length;
    const re = (await req('POST', `/api/spaces/${S}/join`, { invite: inviteCode, name: 'GPT-台式机', token: b.token })).data;
    assert.equal(re.memberId, b.memberId); assert.ok(re.rejoined);
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, admin)).data.members.length, before);

    // 目标文档上传：员工能读，next 里给链接；快照不带全文
    const readme = '# 目标\n\n- 精度过门\n- Isaac 回放';
    assert.equal((await req('POST', `/api/spaces/${S}/goal`, { text: 'x', doc: { name: 'README.md', content: readme } }, b.token)).status, 403);
    const gm = (await req('POST', `/api/spaces/${S}/goal`, { text: '按 README 交付', doc: { name: 'README.md', content: readme } }, a.token)).data;
    assert.equal(gm.docName, 'README.md'); assert.equal(gm.doc, undefined);
    assert.equal((await req('GET', `/api/spaces/${S}/goal/doc`, null, b.token)).data, readme);
    assert.ok((await req('GET', `/api/spaces/${S}/next?wait=0`, null, b.token)).data.goal.docUrl.endsWith('/goal/doc'));
    // 只改一句话目标时保留文档
    assert.equal((await req('POST', `/api/spaces/${S}/goal`, { text: '新目标' }, a.token)).data.docName, 'README.md');
    // 日志文件上传 + 自动日志
    const lf = (await req('POST', `/api/spaces/${S}/logs`, { file: { name: 'WORKLOG.md', content: '## 第一步\n跑完测试' } }, b.token)).data;
    assert.ok(lf.done.includes('WORKLOG.md')); assert.equal(lf.file.content, undefined);
    assert.equal((await req('GET', `/api/spaces/${S}/logfile/${lf.id}`, null, a.token)).data, '## 第一步\n跑完测试');
    await req('POST', `/api/spaces/${S}/messages`, { text: 'B 门通过，开始 C' }, b.token);
    const auto = (await req('GET', `/api/spaces/${S}/logs?member=${b.memberId}`, null, a.token)).data.logs;
    assert.ok(auto.some(l => l.auto && l.source === 'task' && l.done.includes('提交验收')), '任务提交应自动进日志');
    assert.ok(auto.some(l => l.auto && l.source === 'chat' && l.done === 'B 门通过，开始 C'), 'AI 公开发言应自动进日志');

    // 目标 + /next 循环
    await req('POST', `/api/spaces/${S}/goal`, { text: '登录页上线' }, a.token);
    const t2 = (await req('POST', `/api/spaces/${S}/tasks`, { title: '写注册页', assignee: b.memberId }, a.token)).data;
    let n = (await req('GET', `/api/spaces/${S}/next?wait=0`, null, b.token)).data;
    assert.equal(n.action, 'work'); assert.equal(n.task.id, t2.id); assert.ok(n.instruction.includes('/next'));
    await req('PATCH', `/api/spaces/${S}/tasks/${t2.id}`, { status: 'submitted', result: '注册页完成' }, b.token);
    n = (await req('GET', `/api/spaces/${S}/next?wait=0`, null, a.token)).data;
    assert.equal(n.action, 'review'); assert.equal(n.task.id, t2.id);
    // 员工没活时长轮询挂起，监督者一派活立刻被唤醒
    const t0 = Date.now();
    const pending = req('GET', `/api/spaces/${S}/next?wait=20`, null, b.token);
    setTimeout(() => req('POST', `/api/spaces/${S}/tasks`, { title: '写找回密码', assignee: b.memberId }, a.token), 600);
    n = (await pending).data;
    assert.equal(n.action, 'work'); assert.ok(Date.now() - t0 < 5000, '应被立即唤醒');
    // 只有监督者能确认达成；达成后所有人 stop
    assert.equal((await req('POST', `/api/spaces/${S}/goal/achieve`, {}, b.token)).status, 403);
    await req('POST', `/api/spaces/${S}/goal/achieve`, { summary: '上线了' }, a.token);
    assert.ok((await req('GET', `/api/spaces/${S}/next?wait=0`, null, b.token)).data.stop);
    // 守护脚本：用假 agent 跑，目标达成后应自动退出
    await req('POST', `/api/spaces/${S}/goal/reopen`, null, a.token);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aiws-'));
    const fake = path.join(tmp, 'fake.sh');
    fs.writeFileSync(fake, `#!/bin/bash\necho run >> ${tmp}/runs.txt\ncurl -s -X POST ${B}/api/spaces/${S}/goal/achieve -H "authorization: Bearer ${a.token}" -H 'content-type: application/json' -d '{}' >/dev/null\n`, { mode: 0o755 });
    const out = await new Promise((resolve, reject) => {
      const p = spawn('node', [path.join(__dirname, 'public/runner.js'), '--space', `${B}/s/${S}`, '--token', b.token, '--cwd', tmp, '--cmd', `${fake} {prompt}`], { cwd: tmp });
      let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
      const k = setTimeout(() => { p.kill(); reject(new Error('runner 未退出: ' + o)); }, 20000);
      p.on('close', () => { clearTimeout(k); resolve(o); });
    });
    assert.ok(out.includes('🎯'), out);
    assert.equal(fs.readFileSync(path.join(tmp, 'runs.txt'), 'utf8').trim(), 'run');
    assert.ok(fs.existsSync(path.join(tmp, `.ai-space-${S}.token`)));
    fs.rmSync(tmp, { recursive: true, force: true });

    // 管理员预建成员 + MCP
    const pre = (await req('POST', `/api/spaces/${S}/members`, { name: 'Grok-预建', role: 'supervisor' }, admin)).data;
    assert.equal(pre.member.role, 'supervisor'); assert.ok(pre.connect.claude.includes('/mcp/' + S));
    assert.equal((await req('POST', `/api/spaces/${S}/members`, { name: 'x' }, b.token)).status, 403);
    const pt = pre.connect.claude.match(/Bearer ([^"]+)/)[1];
    const rpc = async (body, tk = pt) => (await fetch(`${B}/mcp/${S}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk }, body: JSON.stringify(body) }));
    assert.equal((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()).result.serverInfo.name, 'ai-space');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tl = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools.map(x => x.name);
    assert.ok(tl.includes('next') && tl.includes('update_task') && tl.includes('write_log'));
    const sm = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { text: 'MCP 报到' } } })).json()).result;
    assert.ok(!sm.isError);
    // MCP 走同一套权限：员工不能派活
    const bt = (await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'x' } } }, b.token)).json()).result;
    assert.ok(bt.isError && bt.content[0].text.includes('只有监督者'));
    assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, 'bad')).status, 401);

    // 已读回执：对方通过 next 取到私信后才标记已读
    const dm = (await req('POST', `/api/spaces/${S}/messages`, { text: '做任务 X', to: a.memberId }, admin)).data;
    let seen = (await req('GET', `/api/spaces/${S}/state`, null, admin)).data.messages.find(m => m.id === dm.id);
    assert.ok(!seen.readBy?.includes(a.memberId), '对方还没取，不应已读');
    await req('GET', `/api/spaces/${S}/next?wait=0&since=${dm.at - 1}`, null, a.token);
    seen = (await req('GET', `/api/spaces/${S}/state`, null, admin)).data.messages.find(m => m.id === dm.id);
    assert.ok(seen.readBy.includes(a.memberId), '对方 next 取到后应标记已读');

    // 文件区：图片 / 视频上传、预览、抽帧、Range、MCP 直接返回图片
    const { execFileSync, execSync } = require('child_process');
    const ff = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => fs.existsSync(p));
    const png = path.join(DATA, 't.png'), mp4 = path.join(DATA, 't.mp4');
    if (ff) {
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360', '-frames:v', '1', png]);
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=10', '-pix_fmt', 'yuv420p', mp4]);
    }
    const up = async (file, qs, tk) => { const r = await fetch(`${B}/api/spaces/${S}/files?${qs}`, { method: 'POST', headers: { authorization: 'Bearer ' + tk }, body: fs.readFileSync(file) }); return { status: r.status, data: await r.json() }; };
    if (ff) {
      const im = await up(png, `name=shot.png&taskId=${t2.id}&text=第一张`, b.token);
      assert.equal(im.status, 201); assert.equal(im.data.file.type, 'image');
      const vd = await up(mp4, `name=run.mp4&taskId=${t2.id}`, b.token);
      assert.equal(vd.data.file.type, 'video');
      let vf; for (let i = 0; i < 60; i++) { vf = (await req('GET', `/api/spaces/${S}/files?task=${t2.id}`, null, a.token)).data.files.find(f => f.id === vd.data.file.id); if (vf.status === 'ready') break; await new Promise(r => setTimeout(r, 300)); }
      assert.equal(vf.frames.length, 9, '视频应抽 9 帧'); assert.ok(vf.sheet, '应生成缩略图墙'); assert.ok(Math.abs(vf.duration - 4) < 0.5);
      const prev = await fetch(`${B}/api/spaces/${S}/files/${im.data.file.id}/preview?token=${a.token}`);
      assert.equal(prev.headers.get('content-type'), 'image/jpeg');
      const rg = await fetch(`${B}/api/spaces/${S}/files/${vd.data.file.id}`, { headers: { authorization: 'Bearer ' + a.token, range: 'bytes=0-99' } });
      assert.equal(rg.status, 206); assert.equal((await rg.arrayBuffer()).byteLength, 100);
      // 频道里出现文件消息；MCP view_file 返回真实图片
      assert.ok((await req('GET', `/api/spaces/${S}/state`, null, a.token)).data.messages.some(m => m.kind === 'file' && m.files.includes(im.data.file.id)));
      const at = (await req('GET', `/api/spaces/${S}/members/${a.memberId}/connect`, null, admin)).data.claude.match(/Bearer ([^"]+)/)[1];
      const call = async (name, args) => (await (await fetch(`${B}/mcp/${S}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + at }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
      const vi = await call('view_file', { file_id: im.data.file.id });
      assert.equal(vi.content[1].type, 'image'); assert.equal(vi.content[1].mimeType, 'image/jpeg');
      const vv = await call('view_file', { file_id: vd.data.file.id });
      assert.ok(vv.content[0].text.includes('缩略图墙') && vv.content[1].type === 'image');
      assert.equal((await call('view_file', { file_id: vd.data.file.id, frame: 4 })).content[1].type, 'image');
            const upTxt = (await call('upload_file', { path: '/home/u/a b.png', task_id: t2.id, caption: "它's 第二轮" })).content[0].text;
      assert.ok(upTxt.includes("bash /tmp/ai-space-upload.sh '/home/u/a b.png' --task '" + t2.id + "'"), upTxt);
      // 分块上传脚本：真实执行，3 块以上、带中文说明、挂到任务
      const big = path.join(DATA, 'big.mp4');
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=1280x720:rate=30', '-b:v', '8M', '-pix_fmt', 'yuv420p', big]);
      const outSh = execSync(`AI_SPACE_URL=${B}/s/${S} AI_SPACE_TOKEN=${b.token} bash ${path.join(__dirname, 'public/upload.sh')} ${big} --task ${t2.id} --text '分块测试' --no-compress`).toString();
      const bigId = outSh.match(/文件 ID：(\S+)/)[1];
      let bf; for (let i = 0; i < 60; i++) { bf = (await req('GET', `/api/spaces/${S}/files`, null, a.token)).data.files.find(f => f.id === bigId); if (bf.status === 'ready') break; await new Promise(r => setTimeout(r, 300)); }
      assert.equal(bf.size, fs.statSync(big).size, '合并后大小应与原文件一致');
      assert.equal(bf.taskId, t2.id); assert.equal(bf.caption, '分块测试'); assert.equal(bf.frames.length, 9);
      const back = Buffer.from(await (await fetch(`${B}/api/spaces/${S}/files/${bigId}?token=${a.token}`)).arrayBuffer());
      assert.ok(back.equals(fs.readFileSync(big)), '下载回来的内容应与原文件逐字节一致');
      // 别人不能往我的上传会话里塞块
      const st = (await req('POST', `/api/spaces/${S}/files/uploads`, null, b.token)).data;
      assert.equal((await fetch(`${B}/api/spaces/${S}/files/uploads/${st.uploadId}/0`, { method: 'PUT', headers: { authorization: 'Bearer ' + a.token }, body: 'x' })).status, 404);
      // 用 curl 原样写中文请求头上传（AI 最常见的写法）
      const cn = JSON.parse(execSync(`curl -sS -X POST '${B}/api/spaces/${S}/files' -H 'authorization: Bearer ${b.token}' -H 'x-file-name: 验收截图.png' -H 'x-file-text: 第二轮外观，地面是棋盘格' --data-binary @${png}`).toString());
      assert.equal(cn.file.name, '验收截图.png'); assert.equal(cn.file.caption, '第二轮外观，地面是棋盘格');
      // 别人不能删；私发文件第三人看不到
      assert.equal((await req('DELETE', `/api/spaces/${S}/files/${im.data.file.id}`, null, a.token)).status, 403);
      const pv = await up(png, `name=secret.png&to=${a.memberId}`, b.token);
      const thirdTok = (await req('POST', `/api/spaces/${S}/members`, { name: '第三人' }, admin)).data.connect.claude.match(/Bearer ([^"]+)/)[1];
      assert.equal((await fetch(`${B}/api/spaces/${S}/files/${pv.data.file.id}/preview?token=${thirdTok}`)).status, 404);
    } else console.log('（没有 ffmpeg，跳过文件区测试）');

    // 退回后原样重交会被拦下，并返回退回意见；改过的报告可以正常提交
    const dupT = (await req('POST', `/api/spaces/${S}/tasks`, { title: '重复提交测试', assignee: b.memberId }, a.token)).data;
    const rep1 = '## 交付\ngrasp 时刻 42605500，三联图已上传，画面和 live 一致。\n| 项 | 值 |\n|---|---|\n| grasp | 42605500 |';
    await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'submitted', result: rep1 }, b.token);
    await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'rejected', note: 'grasp 换成 23.0 s，加 ViewCamera' }, a.token);
    const dup = await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'submitted', result: rep1 + ' ' }, b.token);
    assert.equal(dup.status, 409, '原样重交应被拦下'); assert.ok(dup.data.error.includes('23.0 s'), '应返回退回意见');
    const fixed = await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'submitted', result: '## 交付\n1. grasp 改为 23.0 s，附原视频截图 video-23s.png\n2. 新建 /World/ViewCamera，手占画面 46%\n3. 完整导出 212 MB，未解析 0，非 ASCII 0\n4. 影子分开' }, b.token);
    assert.equal(fixed.status, 200, '改过的报告应能提交');

    // 老板收件箱：只有管理员能看；退回 3 次的任务会出现
    for (let i = 0; i < 2; i++) {
      await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'rejected', note: '第' + i + '次退回：继续改' }, a.token);
      await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'submitted', result: '## 交付 第' + i + '版\n' + 'x'.repeat(i * 50) + '\n新附件 v' + i + '.png' }, b.token);
    }
    await req('PATCH', `/api/spaces/${S}/tasks/${dupT.id}`, { status: 'rejected', note: '第三次退回' }, a.token);
    assert.equal((await req('GET', `/api/spaces/${S}/inbox?boss=1`, null, b.token)).status, 403, '员工不能看老板收件箱');
    const bossItems = (await req('GET', `/api/spaces/${S}/inbox?boss=1`, null, admin)).data.items;
    assert.ok(bossItems.some(i => i.key === 'loop:' + dupT.id), '退回 3 次的任务应进收件箱');
    assert.ok((await req('GET', `/api/spaces/${S}/state`, null, admin)).data.inbox, '管理员的 state 里带收件箱');
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, b.token)).data.inbox, undefined, '员工的 state 里不带');

    // ---------- 安全 ----------
    // 经隧道来的公网访客不能新建空间；本机可以
    const viaTunnel = await fetch(`${B}/api/spaces`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(viaTunnel.status, 403, '公网访客不应能新建空间');
    assert.equal((await (await fetch(`${B}/api/host`)).json()).canCreate, true);
    assert.equal((await fetch(`${B}/api/host`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 403, '局域网模式下公网隧道来的请求一律拒绝');
    // 换令牌：旧令牌立即失效，新令牌可用；员工不能换别人的
    const victim = (await req('POST', `/api/spaces/${S}/members`, { name: '泄露者' }, admin)).data;
    const oldTok = victim.connect.claude.match(/Bearer ([^"]+)/)[1];
    assert.equal((await req('POST', `/api/spaces/${S}/members/${victim.member.id}/rotate`, null, b.token)).status, 403);
    const rot = (await req('POST', `/api/spaces/${S}/members/${victim.member.id}/rotate`, null, admin)).data;
    assert.notEqual(rot.token, oldTok);
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, oldTok)).status, 401, '旧令牌应失效');
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, rot.token)).status, 200);
    assert.ok(rot.connect.plain.includes(rot.token) && !rot.connect.plain.includes(oldTok), '新的接入一句话应使用新令牌');
    // 页面安全头
    const page = await fetch(`${B}/s/${S}`);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.ok(!/\son[a-z]+=/i.test(await page.text()), '页面里不应有内联事件（CSP 会拦掉）');

    // 私信只对相关人可见
    await req('POST', `/api/spaces/${S}/messages`, { text: '私下说', to: a.memberId }, b.token);
    const adminView = (await req('GET', `/api/spaces/${S}/state`, null, admin)).data;
    assert.ok(!adminView.messages.some(m => m.text === '私下说'));
    assert.equal(adminView.members.find(m => m.id === a.memberId).token, undefined, '不应泄露他人 token');
    const supView = (await req('GET', `/api/spaces/${S}/state`, null, a.token)).data;
    assert.ok(supView.messages.some(m => m.text === '私下说'));
    // 员工看不到邀请码
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, b.token)).data.inviteCode, undefined);

    // 重置邀请码后旧码失效；移除成员后 token 失效
    await req('POST', `/api/spaces/${S}/reset-invite`, null, admin);
    assert.equal((await req('POST', `/api/spaces/${S}/join`, { invite: inviteCode, name: 'x' })).status, 403);
    await req('DELETE', `/api/spaces/${S}/members/${b.memberId}`, null, admin);
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, b.token)).status, 401);

    // 前端路由
    assert.equal((await fetch(`${B}/s/${S}`)).status, 200);
    // 简报：比完整状态小，带我的任务和最新退回意见；单个任务全文接口
    const brT = (await req('POST', `/api/spaces/${S}/tasks`, { title: '简报测试', description: 'x'.repeat(5000), assignee: empTok2 = (await req('POST', `/api/spaces/${S}/members`, { name: '简报员工' }, admin)).data.member.id }, a.token)).data;
    const bTok = (await req('GET', `/api/spaces/${S}/members/${empTok2}/connect`, null, admin)).data.claude.match(/Bearer ([^"]+)/)[1];
    await req('PATCH', `/api/spaces/${S}/tasks/${brT.id}`, { status: 'submitted', result: '第一版' }, bTok);
    await req('PATCH', `/api/spaces/${S}/tasks/${brT.id}`, { status: 'rejected', note: '把 grasp 换成 23.0 s' }, a.token);
    const brief1 = (await req('GET', `/api/spaces/${S}/brief`, null, bTok)).data;
    const brMine = brief1.myTasks.find(x => x.id === brT.id);
    assert.ok(brMine && brMine.lastRejectNote.includes('23.0 s'), '简报里应带最新退回意见');
    assert.ok(brMine.description.length < 1700, '长描述在简报里要截断');
    const fullState = JSON.stringify((await req('GET', `/api/spaces/${S}/state`, null, bTok)).data).length;
    assert.ok(JSON.stringify(brief1).length < fullState, '简报应比完整状态小');
    const brOne = (await req('GET', `/api/spaces/${S}/tasks/${brT.id}`, null, bTok)).data;
    assert.equal(brOne.description.length, 5000, '单个任务接口给全文'); assert.ok(brOne.reviews.some(r => r.kind === 'reject'));
    assert.ok((await req('GET', `/api/spaces/${S}/guide?token=${bTok}`)).data.includes('/brief'), '接入说明应推荐 /brief');

    // ---------- 门厅：一句话进房间 ----------
    // curl 打开根路径得到门厅说明，浏览器得到网页
    const lobbyTxt = await (await fetch(`${B}/`)).text();
    assert.ok(lobbyTxt.includes('/knock') && lobbyTxt.includes('敲门'), 'curl 打开根路径应得到门厅说明');
    assert.ok((await (await fetch(`${B}/`, { headers: { accept: 'text/html' } })).text()).includes('<!doctype html>'), '浏览器打开根路径应得到网页');
    assert.ok(!lobbyTxt.includes(admin) && !/token=[A-Za-z0-9_-]{20,}/.test(lobbyTxt), '门厅说明里不能有任何令牌');
    const card = await (await fetch(`${B}/.well-known/agent-card.json`)).json();
    assert.ok(card.join.knock.endsWith('/knock'), 'A2A 名片应给出敲门地址');
    // 敲门 → 等待 → 管理员批准 → 拿到令牌
    const kn = await (await fetch(`${B}/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Grok-Ubuntu', host: 'ubuntu-edy', model: 'grok-4', tool: 'Cline' }) })).json();
    assert.ok(kn.ticket);
    const kn2 = await (await fetch(`${B}/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Grok-Ubuntu', host: 'ubuntu-edy' }) })).json();
    assert.equal(kn2.ticket, kn.ticket, '同一台机器重复敲门复用同一张取件码');
    assert.equal((await fetch(`${B}/knock/${kn.ticket}?wait=0`)).status, 202, '未批准时是 pending');
    const empTok = (await req('POST', `/api/spaces/${S}/members`, { name: '普通员工' }, admin)).data.connect.claude.match(/Bearer ([^"]+)/)[1];
    assert.equal((await req('GET', `/api/spaces/${S}/knocks`, null, empTok)).status, 403, '员工不能处理敲门');
    assert.ok((await req('GET', `/api/spaces/${S}/inbox?boss=1`, null, admin)).data.items.some(i => i.key === 'knock:' + kn.ticket), '敲门应出现在老板收件箱');
    const waiting = fetch(`${B}/knock/${kn.ticket}?wait=20`);
    setTimeout(() => req('POST', `/api/spaces/${S}/knocks/${kn.ticket}/approve`, { role: 'employee' }, admin), 500);
    const t0k = Date.now(); const gotRes = await waiting; const got = await gotRes.json();
    assert.equal(got.status, 'approved'); assert.ok(Date.now() - t0k < 5000, '批准后应立刻返回');
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, got.token)).status, 200, '拿到的令牌能用');
    const mem = (await req('GET', `/api/spaces/${S}/state`, null, admin)).data.members.find(m => m.id === got.memberId);
    assert.equal(mem.device.host, 'ubuntu-edy'); assert.equal(mem.device.tool, 'Cline');
    assert.equal(mem.token, undefined, '成员列表里不能带令牌');
    assert.equal((await fetch(`${B}/knock/${kn.ticket}?wait=0`)).status, 404, '令牌只交付一次');
    // 老成员回来敲门：认出来，沿用原来的成员（任务和日志都在），换新令牌
    const back = await (await fetch(`${B}/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Grok-Ubuntu', host: 'ubuntu-edy' }) })).json();
    await req('POST', `/api/spaces/${S}/knocks/${back.ticket}/approve`, {}, admin);
    const got2 = await (await fetch(`${B}/knock/${back.ticket}?wait=0`)).json();
    assert.equal(got2.memberId, got.memberId, '同一台机器同名的 AI 回来应认作同一个成员');
    assert.equal((await req('GET', `/api/spaces/${S}/state`, null, got.token)).status, 401, '旧令牌失效');
    // 拒绝
    const kr = await (await fetch(`${B}/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '陌生人' }) })).json();
    await req('POST', `/api/spaces/${S}/knocks/${kr.ticket}/reject`, {}, admin);
    assert.equal((await fetch(`${B}/knock/${kr.ticket}?wait=0`)).status, 403);
    // 公网隧道来的敲门被拒
    assert.equal((await fetch(`${B}/knock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: '{}' })).status, 403);
    // 本机打开时生成的接入地址是局域网地址，不是 localhost
    assert.ok(!(await req('GET', `/api/spaces/${S}/members/${got.memberId}/connect`, null, admin)).data.mcpUrl.includes('localhost'));
    await publicModeTest('');
    await publicModeTest('/room');
    console.log('✓ 全部测试通过');
  } catch (e) {
    console.error('✗ 测试失败', e); process.exitCode = 1;
  } finally {
    srv.kill();
    await new Promise(r => setTimeout(r, 400));
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})();

// 绑定自有域名（公网模式）：经 Cloudflare 隧道进来的 AI 拿到的是 https 域名地址；建空间仍只限本机；同一来源敲门有上限
// base 非空时模拟部署在子路径（https://room.example.com/room）
async function publicModeTest(base) {
  const P = 4398, D = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aiws-test-pub-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, AIWS_PORT: P, AIWS_DATA: D, AIWS_PUBLIC: '1', AIWS_BASE: base } });
  try {
    await new Promise(r => srv.stdout.once('data', r));
    const U = `http://localhost:${P}`, cfh = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'room.example.com' };
    const viaCf = (u, o = {}) => fetch(U + base + u, { ...o, redirect: 'manual', headers: { ...cfh, ...(o.headers || {}) } });
    assert.equal((await viaCf('/api/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status, 403, '公网访客不能建空间');
    assert.equal((await fetch(`${U}/api/spaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"公网测试"}' })).status, 201);
    const txt = await (await viaCf('/')).text();
    assert.ok(txt.includes(`https://room.example.com${base}/knock`) && !txt.includes('.local:'), '从域名进来的门厅说明应只给域名地址');
    if (base) {
      const html = await (await viaCf('/s/abc', { headers: { accept: 'text/html' } })).text();
      assert.ok(html.includes(`src="${base}/app.js`) && html.includes(`content="${base}"`), '子路径部署时网页资源要带前缀');
      assert.equal((await viaCf('/app.js')).status, 200);
      const root = await fetch(U + '/', { redirect: 'manual', headers: cfh });
      assert.equal(root.status, 302, '域名根路径跳到子路径'); assert.equal(root.headers.get('location'), base + '/');
      assert.equal((await fetch(U + '/api/host', { headers: cfh })).status, 404, '子路径外的公网请求不处理');
      assert.equal((await fetch(U + '/api/host')).status, 200, '局域网/本机不带前缀照常可用');
    }
    for (let i = 0; i < 3; i++) assert.equal((await viaCf('/knock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bot' + i }) })).status, 201);
    assert.equal((await viaCf('/knock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"bot9"}' })).status, 429, '同一来源敲门有上限');
    const other = await viaCf('/knock', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.2' }, body: '{"name":"x"}' });
    assert.equal(other.status, 201, '别的来源不受影响');
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 300)); fs.rmSync(D, { recursive: true, force: true }); }
}
