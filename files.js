// 文件区：截图 / 视频 / 任意附件。原文件存在硬盘，元数据存在 space.files。
// 图片自动生成缩小的预览图（给 AI 看）；视频用 ffmpeg 抽 9 帧并拼成一张缩略图墙（AI 不能直接看视频）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_UPLOAD = Number(process.env.AIWS_MAX_UPLOAD_MB || 95) * 1024 * 1024; // 单个请求上限；走隧道时大文件请分块（隧道单请求约 100 秒超时）
const FRAMES = 9;
const MAX_CHUNK = 8 * 1024 * 1024;       // 分块上传：每块一个请求，避开隧道约 100 秒的单请求超时
const MAX_TOTAL = Number(process.env.AIWS_MAX_FILE_MB || 2048) * 1024 * 1024;
const uploads = new Map();                 // uploadId -> { space, me, name, mime, ..., dir, at }
// 这些类型可以在浏览器里直接打开；其他一律以附件下载，避免上传的 HTML/SVG 在本站执行脚本
const INLINE = /^(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|quicktime)|application\/pdf|text\/plain)$/;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', log: 'text/plain',
  usd: 'application/octet-stream', usda: 'text/plain', usdc: 'application/octet-stream', zip: 'application/zip',
};

function run(cmd, args, timeout = 120000) {
  return new Promise((ok, no) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => e ? no(new Error(String(err || e.message).trim().split('\n').pop().slice(0, 300))) : ok(out)));
}
const which = bin => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(d => path.join(d, bin)).find(p => fs.existsSync(p));
const FFMPEG = which('ffmpeg'), FFPROBE = which('ffprobe'), SIPS = which('sips');

module.exports = function files(ctx) {
  const { db, save, send, broadcast, addMessage, baseUrl, id, now, clip, FILES_DIR } = ctx;
  const dirOf = sid => path.join(FILES_DIR, sid);
  const pathOf = (sid, f, suffix = '') => path.join(dirOf(sid), f.id + suffix);
  const meta = f => { const { to, ...m } = f; return { ...m, to: to || null }; };
  const canSee = (space, me, f) => !f.to || f.to === me.id || f.by === me.id || me.role === 'admin';

  // 预览：图片缩到长边 1568px 的 JPEG（Claude 推荐的尺寸）；视频抽帧 + 拼图 + 封面
  async function processFile(space, f) {
    const src = pathOf(space.id, f, '.orig');
    try {
      if (f.type === 'image') {
        const out = pathOf(space.id, f, '.preview.jpg');
        if (SIPS) await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '1568', src, '--out', out]);
        else if (FFMPEG) await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-vf', "scale='min(1568,iw)':-2", '-frames:v', '1', out]);
        if (fs.existsSync(out)) f.preview = true;
        if (SIPS) {
          const info = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', src]).catch(() => '');
          f.width = Number((info.match(/pixelWidth: (\d+)/) || [])[1]) || undefined;
          f.height = Number((info.match(/pixelHeight: (\d+)/) || [])[1]) || undefined;
        }
      } else if (f.type === 'video') {
        if (!FFMPEG || !FFPROBE) throw new Error('这台电脑没有 ffmpeg，视频只保存原文件，无法抽帧');
        const probe = JSON.parse(await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', src]));
        f.duration = Number(probe.format?.duration) || 0;
        f.width = probe.streams?.[0]?.width; f.height = probe.streams?.[0]?.height;
        const n = f.duration > 1 ? FRAMES : 1;
        f.frames = [];
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? 0 : f.duration * (0.04 + 0.92 * i / (n - 1));
          const out = pathOf(space.id, f, `.f${i}.jpg`);
          await run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', out]);
          if (fs.existsSync(out)) f.frames.push({ i, t: Math.round(t * 10) / 10 });
        }
        // 3×3 缩略图墙：AI 一次看全片
        if (f.frames.length > 1) {
          const inputs = f.frames.flatMap(x => ['-i', pathOf(space.id, f, `.f${x.i}.jpg`)]);
          const k = f.frames.length, cols = 3;
          const scaled = f.frames.map((_, j) => `[${j}:v]scale=512:-2,setsar=1,drawtext=text='${f.frames[j].t}s':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55[v${j}]`).join(';');
          // 所有帧来自同一视频、缩放到同宽，尺寸一致：第 j 格位于 (列×w0, 行×h0)
          const off = (n, unit) => n ? Array(n).fill(unit).join('+') : '0';
          const layout = f.frames.map((_, j) => `${off(j % cols, 'w0')}_${off(Math.floor(j / cols), 'h0')}`).join('|');
          const filter = `${scaled};${f.frames.map((_, j) => `[v${j}]`).join('')}xstack=inputs=${k}:layout=${layout}:fill=black[out]`;
          const sheet = pathOf(space.id, f, '.sheet.jpg');
          await run(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-q:v', '3', sheet]).catch(async () => {
            // 部分 ffmpeg 没编译 drawtext：去掉时间标签再试
            const plain = filter.replace(/,drawtext=[^\[]+?(\[v\d+\])/g, '$1');
            await run(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', plain, '-map', '[out]', '-frames:v', '1', '-q:v', '3', sheet]);
          });
          if (fs.existsSync(sheet)) f.sheet = true;
        }
        if (f.frames.length) f.poster = f.frames[Math.floor(f.frames.length / 2)].i;
      }
      f.status = 'ready';
    } catch (e) {
      f.status = 'ready';
      f.note = e.message;
    }
    save();
    broadcast(space.id, 'file', meta(f));
  }

  function serveFile(req, res, file, type, inline) {
    const st = fs.statSync(file);
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' };
    if (!inline) headers['content-disposition'] = 'attachment';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  }

  // 给 AI 看的图片内容（MCP image content）：图片给预览；视频给缩略图墙 + 指定帧
  function imagesFor(space, f, frame) {
    const read = p => fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : null;
    const out = [];
    if (f.type === 'image') {
      const b = read(pathOf(space.id, f, '.preview.jpg'));
      if (b) out.push({ type: 'image', data: b, mimeType: 'image/jpeg' });
      else if (f.size < 3.5 * 1024 * 1024 && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)) out.push({ type: 'image', data: read(pathOf(space.id, f, '.orig')), mimeType: f.mime });
    } else if (f.type === 'video') {
      if (frame !== undefined && f.frames?.some(x => x.i === frame)) {
        const b = read(pathOf(space.id, f, `.f${frame}.jpg`)); if (b) out.push({ type: 'image', data: b, mimeType: 'image/jpeg' });
      } else {
        const b = read(pathOf(space.id, f, '.sheet.jpg')) || (f.poster !== undefined && read(pathOf(space.id, f, `.f${f.poster}.jpg`)));
        if (b) out.push({ type: 'image', data: b, mimeType: 'image/jpeg' });
      }
    }
    return out;
  }
  function describe(f) {
    const kb = f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.round(f.size / 1024)} KB`;
    let s = `文件「${f.name}」（${f.type === 'video' ? '视频' : f.type === 'image' ? '图片' : '附件'}，${kb}${f.width ? `，${f.width}×${f.height}` : ''}${f.duration ? `，${f.duration.toFixed(1)} 秒` : ''}），${f.byName} 上传${f.taskTitle ? `，属于任务「${f.taskTitle}」` : ''}。`;
    if (f.caption) s += `\n说明：${f.caption}`;
    if (f.type === 'video') s += f.frames?.length ? `\n下面是均匀抽取的 ${f.frames.length} 帧拼成的缩略图墙（左上角是时间）。要看某一帧的大图，用 view_file 并传 frame=0..${f.frames.length - 1}（对应时间：${f.frames.map(x => `${x.i}=${x.t}s`).join('，')}）。` : `\n${f.note || '视频没有抽出帧'}`;
    if (f.note && f.type !== 'video') s += `\n注意：${f.note}`;
    return s;
  }

  function register(req, res, space, me, f) {
    if (f.type === 'file') f.status = 'ready';
    space.files.push(f);
    const msg = addMessage(space, me, f.caption, { kind: 'file', taskId: f.taskId, to: f.to, files: [f.id] });
    save();
    broadcast(space.id, 'file', meta(f));
    if (f.status === 'processing') processFile(space, f); // 抽帧在后台做，先返回
    return send(res, 201, { file: meta(f), messageId: msg.id, view: `${baseUrl(req)}/api/spaces/${space.id}/files/${f.id}/preview` });
  }
  function newFile(req, url, space, me) {
    const hdr = k => { const v = req.headers[k]; if (!v) return ''; const u = Buffer.from(String(v), 'latin1').toString('utf8'); try { return decodeURIComponent(u); } catch { return u; } };
    const qp = k => url.searchParams.get(k) || '';
    const name = clip(hdr('x-file-name') || qp('name'), 160) || 'file';
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    let mime = String(req.headers['x-file-type'] || req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime || mime === 'application/octet-stream' || mime === 'application/x-www-form-urlencoded' || mime === 'application/json') mime = MIME[ext] || 'application/octet-stream';
    const taskId = hdr('x-task-id') || qp('taskId') || qp('task') || null;
    const task = taskId ? space.tasks.find(t => t.id === taskId) : null;
    if (taskId && !task) throw Object.assign(new Error('任务不存在'), { code: 400 });
    const to = hdr('x-to') || qp('to') || null;
    if (to && !space.members[to]) throw Object.assign(new Error('私发对象不存在'), { code: 400 });
    return { id: id(8), name, mime, ext, type: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file', size: 0, by: me.id, byName: me.name, taskId: task?.id || null, taskTitle: task?.title || '', to, caption: clip(hdr('x-file-text') || qp('text') || qp('caption'), 2000), status: 'processing', at: now() };
  }
  const streamTo = (req, dest, limit) => new Promise(resolve => {
    const ws = fs.createWriteStream(dest);
    let size = 0, bad = false;
    req.on('data', c => { size += c.length; if (size > limit && !bad) { bad = true; ws.destroy(); req.destroy(); resolve(-1); } });
    req.pipe(ws);
    ws.on('finish', () => resolve(bad ? -1 : size));
    ws.on('error', () => resolve(-1));
    req.on('aborted', () => resolve(-1));
  });

  async function handle(req, res, url, space, me, p) {
    const method = req.method, fid = p[4], sub = p[5];
    space.files ||= [];

    if (method === 'POST' && !fid) {
      // 中文文件名 / 说明放在 URL 里必须先编码，AI 用 curl 常常忘记；所以也接受请求头 x-file-name / x-file-text（可直接写中文）
      const len = Number(req.headers['content-length'] || 0);
      if (len > MAX_UPLOAD) return send(res, 413, { error: `单次上传最大 ${MAX_UPLOAD / 1048576}MB，大文件请用分块上传：curl -fsSLO ${baseUrl(req)}/upload.sh && bash upload.sh <文件> ` });
      let f; try { f = newFile(req, url, space, me); } catch (e) { return send(res, e.code || 400, { error: e.message }); }
      fs.mkdirSync(dirOf(space.id), { recursive: true });
      const dest = pathOf(space.id, f, '.orig');
      f.size = await streamTo(req, dest, MAX_UPLOAD);
      if (f.size <= 0) { fs.rmSync(dest, { force: true }); return res.headersSent || res.destroyed ? undefined : send(res, 400, { error: f.size ? '上传中断' : '文件是空的' }); }
      return register(req, res, space, me, f);
    }

    // 分块上传：POST /files/uploads 开始 → PUT /files/uploads/<id>/<序号> 逐块上传 → POST /files/uploads/<id>/complete 合并
    if (fid === 'uploads') {
      const uid = p[5], part = p[6];
      if (method === 'POST' && !uid) {
        let f; try { f = newFile(req, url, space, me); } catch (e) { return send(res, e.code || 400, { error: e.message }); }
        const dir = path.join(dirOf(space.id), '.up-' + f.id);
        fs.mkdirSync(dir, { recursive: true });
        uploads.set(f.id, { f, dir, space: space.id, by: me.id, at: now() });
        return send(res, 201, { uploadId: f.id, chunkSize: 2 * 1024 * 1024, maxChunk: MAX_CHUNK });
      }
      const u = uploads.get(uid);
      if (!u || u.space !== space.id || u.by !== me.id) return send(res, 404, { error: '上传会话不存在或已过期，请重新开始' });
      u.at = now();
      if (method === 'PUT' && /^\d+$/.test(part || '')) {
        const tmp = path.join(u.dir, `${part}.part.tmp`);
        const n = await streamTo(req, tmp, MAX_CHUNK);
        if (n <= 0) { fs.rmSync(tmp, { force: true }); return res.headersSent || res.destroyed ? undefined : send(res, 400, { error: '这一块上传中断，请重试' }); }
        fs.renameSync(tmp, path.join(u.dir, `${part}.part`)); // 重传同一块会覆盖，可安全重试
        return send(res, 200, { ok: true, part: Number(part), size: n });
      }
      if (method === 'POST' && part === 'complete') {
        const parts = fs.readdirSync(u.dir).filter(x => /^\d+\.part$/.test(x)).map(x => Number(x.split('.')[0])).sort((a, b) => a - b);
        if (!parts.length) return send(res, 400, { error: '还没有上传任何分块' });
        const missing = parts.map((n, i) => n === i ? null : i).filter(x => x !== null);
        if (missing.length) return send(res, 400, { error: `缺少第 ${missing[0]} 块` });
        const total = parts.reduce((s2, n) => s2 + fs.statSync(path.join(u.dir, `${n}.part`)).size, 0);
        if (total > MAX_TOTAL) return send(res, 413, { error: '文件太大' });
        const dest = pathOf(space.id, u.f, '.orig');
        const out = fs.openSync(dest, 'w');
        for (const n of parts) fs.writeSync(out, fs.readFileSync(path.join(u.dir, `${n}.part`)));
        fs.closeSync(out);
        fs.rmSync(u.dir, { recursive: true, force: true });
        uploads.delete(uid);
        u.f.size = total; u.f.at = now();
        return register(req, res, space, me, u.f);
      }
      return send(res, 404, { error: '接口不存在' });
    }

    if (method === 'GET' && !fid) {
      const taskId = url.searchParams.get('task');
      const list = space.files.filter(f => canSee(space, me, f) && (!taskId || f.taskId === taskId)).map(meta);
      return send(res, 200, { files: list });
    }

    const f = space.files.find(x => x.id === fid);
    if (!f || !canSee(space, me, f)) return send(res, 404, { error: '文件不存在' });

    if (method === 'DELETE' && !sub) {
      if (me.role !== 'admin' && me.id !== f.by) return send(res, 403, { error: '只有上传者或管理员可以删除' });
      space.files = space.files.filter(x => x !== f);
      for (const e of fs.readdirSync(dirOf(space.id))) if (e.startsWith(f.id + '.')) fs.rmSync(path.join(dirOf(space.id), e), { force: true });
      save();
      broadcast(space.id, 'fileDeleted', { id: f.id });
      return send(res, 200, { ok: true });
    }
    if (method !== 'GET') return send(res, 405, { error: '不支持' });

    if (!sub || sub === 'raw') {
      const fp = pathOf(space.id, f, '.orig');
      if (!fs.existsSync(fp)) return send(res, 404, { error: '原文件已丢失' });
      if (url.searchParams.get('download')) res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      return serveFile(req, res, fp, f.mime, INLINE.test(f.mime));
    }
    if (sub === 'meta') return send(res, 200, { file: meta(f), description: describe(f) });
    // 预览：图片 → 缩小的 JPEG；视频 → 缩略图墙（没有就用封面帧）
    if (sub === 'preview' || sub === 'sheet' || sub === 'poster') {
      const cand = f.type === 'image' ? ['.preview.jpg'] : sub === 'poster' ? [`.f${f.poster}.jpg`, '.sheet.jpg'] : ['.sheet.jpg', `.f${f.poster}.jpg`];
      const fp = cand.map(c => pathOf(space.id, f, c)).find(x => fs.existsSync(x));
      if (fp) return serveFile(req, res, fp, 'image/jpeg', true);
      if (f.type === 'image' && INLINE.test(f.mime)) return serveFile(req, res, pathOf(space.id, f, '.orig'), f.mime, true);
      return send(res, f.status === 'processing' ? 202 : 404, { error: f.status === 'processing' ? '还在处理，稍后再试' : (f.note || '没有预览') });
    }
    if (sub === 'frame') {
      const n = Number(p[6]);
      const fp = pathOf(space.id, f, `.f${n}.jpg`);
      if (!f.frames?.some(x => x.i === n) || !fs.existsSync(fp)) return send(res, 404, { error: `没有第 ${p[6]} 帧，可用 0..${(f.frames?.length || 1) - 1}` });
      return serveFile(req, res, fp, 'image/jpeg', true);
    }
    return send(res, 404, { error: '接口不存在' });
  }

  // MCP 用：等文件处理完再取图（最多 30 秒）
  async function viewForAI(space, me, fileId, frame) {
    const f = (space.files || []).find(x => x.id === fileId);
    if (!f || !canSee(space, me, f)) return { error: '文件不存在' };
    for (let i = 0; i < 60 && f.status === 'processing'; i++) await new Promise(r => setTimeout(r, 500));
    return { text: describe(f), images: imagesFor(space, f, frame) };
  }

  setInterval(() => { for (const [k, u] of uploads) if (now() - u.at > 6 * 3600 * 1000) { fs.rmSync(u.dir, { recursive: true, force: true }); uploads.delete(k); } }, 600000).unref();

  return { handle, viewForAI, meta, canSee, MAX_UPLOAD, hasFfmpeg: !!FFMPEG };
};
