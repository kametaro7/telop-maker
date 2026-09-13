import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { buildSrt } from './lib/ass.mjs';
import { APP_DIR, EXPORT_DIR, HOST, PORT, tools } from './lib/config.mjs';
import { safeBaseName, uniqueExportPath } from './lib/exporter.mjs';
import * as jobs from './lib/jobs.mjs';
import { checkFfmpeg } from './lib/media.mjs';
import { getSettings, saveSettings } from './lib/settings.mjs';
import * as store from './lib/store.mjs';
import { newCaptionId } from './lib/transcribe.mjs';
import { DEFAULT_STYLE, normalizeStyle } from './public/shared/fonts.mjs';

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.srt': 'application/x-subrip; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ffmpegHealth = checkFfmpeg();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'データが大きすぎます');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'データを読み取れませんでした');
  }
}

// 動画のシークに必要な Range リクエストにも対応する
async function sendFile(req, res, file, { type, download } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'ファイルが見つかりません');
  }
  if (!stat.isFile()) throw new HttpError(404, 'ファイルが見つかりません');

  const headers = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    } else {
      start = Math.max(0, stat.size - Number(m[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !stat.size) {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

function decodeHeader(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return '';
  }
}

async function mustGet(id) {
  const project = await store.get(id);
  if (!project) throw new HttpError(404, 'プロジェクトが見つかりません');
  return project;
}

function sanitizeCaptions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'テロップの形式が正しくありません');
  return list
    .slice(0, 20000)
    .map(c => ({
      id: typeof c?.id === 'string' && /^c_[a-z0-9]{1,40}$/i.test(c.id) ? c.id : newCaptionId(),
      start: Math.max(0, Number(c?.start)),
      end: Number(c?.end),
      text: String(c?.text ?? '').slice(0, 2000),
      low: !!c?.low,
    }))
    .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
}

// 書き出し用: 画面側で行分けまで済ませたテロップ
function sanitizeExportCaptions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'テロップの形式が正しくありません');
  return list
    .slice(0, 20000)
    .map(c => ({
      start: Number(c?.start),
      end: Number(c?.end),
      lines: Array.isArray(c?.lines) ? c.lines.slice(0, 20).map(l => String(l).slice(0, 500)) : [],
    }))
    .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
}

function exportFile(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base.startsWith('.')) throw new HttpError(400, 'ファイル名が正しくありません');
  return path.join(EXPORT_DIR, base);
}

function summary(p, size) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    duration: p.video?.duration || 0,
    width: p.video?.width || 0,
    height: p.video?.height || 0,
    captionCount: p.captions?.length || 0,
    size,
    error: p.error?.message || null,
    processing: !!jobs.publicRuntime(p.id).processing,
  };
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
const ID = '/api/projects/(?<id>p_[a-z0-9]+)';

route('GET', '/api/health', async (req, res) => {
  const ff = await ffmpegHealth;
  sendJson(res, 200, {
    ffmpeg: ff.ffmpeg && ff.ffprobe,
    ass: ff.ass,
    whisper: !!tools.whisper,
    model: !!tools.model,
    vad: !!(tools.vadTool && tools.vadModel),
    exportDir: EXPORT_DIR,
  });
});

route('GET', '/api/settings', async (req, res) => sendJson(res, 200, await getSettings()));
route('PUT', '/api/settings', async (req, res) => sendJson(res, 200, await saveSettings(await readJson(req))));

route('GET', '/api/projects', async (req, res) => {
  const projects = await store.list();
  sendJson(res, 200, await Promise.all(projects.map(async p => summary(p, await store.dirSize(p.id)))));
});

// 動画のアップロード（本文がそのままファイルの中身）
route('POST', '/api/projects', async (req, res) => {
  const original = decodeHeader(req.headers['x-filename']) || 'video.mp4';
  const ext = /^\.[a-z0-9]{1,8}$/i.test(path.extname(original)) ? path.extname(original).toLowerCase() : '';
  const project = await store.create({
    name: safeBaseName(path.basename(original, path.extname(original))),
    originalName: original,
    sourceFile: `source${ext}`,
    status: 'uploading',
    captions: [],
    style: normalizeStyle(DEFAULT_STYLE),
    video: null,
    error: null,
    notice: null,
  });
  const target = store.projectFile(project.id, project.sourceFile);
  try {
    await pipeline(req, fs.createWriteStream(target));
  } catch {
    await store.remove(project.id).catch(() => {});
    if (!res.headersSent && !res.destroyed) sendJson(res, 400, { error: 'アップロードが途中で止まりました' });
    return;
  }
  const { size } = await fsp.stat(target);
  if (!size) {
    await store.remove(project.id);
    throw new HttpError(400, 'ファイルが空です');
  }
  await store.update(project.id, p => {
    p.status = 'processing';
    p.sourceSize = size;
  });
  jobs.processProject(project.id);
  sendJson(res, 201, { id: project.id });
});

route('GET', ID, async (req, res, { id }) => {
  const project = await mustGet(id);
  sendJson(res, 200, { ...project, runtime: jobs.publicRuntime(id) });
});

route('PUT', ID, async (req, res, { id }) => {
  await mustGet(id);
  const body = await readJson(req);
  const saved = await store.update(id, p => {
    if (typeof body.name === 'string' && body.name.trim()) p.name = safeBaseName(body.name.trim()).slice(0, 100);
    if (body.captions !== undefined) p.captions = sanitizeCaptions(body.captions);
    if (body.style !== undefined) p.style = normalizeStyle(body.style);
    if (body.notice === null) p.notice = null;
  });
  sendJson(res, 200, { ok: true, updatedAt: saved.updatedAt });
});

route('DELETE', ID, async (req, res, { id }) => {
  await mustGet(id);
  await jobs.stopAll(id);
  await store.remove(id);
  sendJson(res, 200, { ok: true });
});

route('GET', `${ID}/media/(?<file>preview\\.mp4|thumb\\.webp|peaks\\.json)`, async (req, res, { id, file }) => {
  await mustGet(id);
  await sendFile(req, res, store.projectFile(id, file));
});

route('POST', `${ID}/reprocess`, async (req, res, { id }) => {
  const project = await mustGet(id);
  if (project.status === 'processing' || project.status === 'uploading' || jobs.publicRuntime(id).processing) throw new HttpError(409, 'いま処理中です');
  try {
    await fsp.access(store.projectFile(id, project.sourceFile));
  } catch {
    throw new HttpError(410, '元の動画ファイルが見つかりません');
  }
  await store.update(id, p => {
    p.status = 'processing';
    p.error = null;
    p.notice = null;
  });
  jobs.processProject(id);
  sendJson(res, 202, { ok: true });
});

route('POST', `${ID}/retranscribe`, async (req, res, { id }) => {
  const project = await mustGet(id);
  if (project.status !== 'ready') throw new HttpError(409, 'まだ準備ができていません');
  jobs.retranscribe(id);
  sendJson(res, 202, { ok: true });
});

route('POST', `${ID}/frame`, async (req, res, { id }) => {
  const project = await mustGet(id);
  if (!project.video) throw new HttpError(409, 'まだ準備ができていません');
  const body = await readJson(req);
  const png = await jobs.previewFrame(id, {
    captions: sanitizeExportCaptions(body.captions),
    style: normalizeStyle(body.style),
    time: Math.max(0, Number(body.time) || 0),
  });
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
  res.end(png);
});

route('POST', `${ID}/export`, async (req, res, { id }) => {
  const project = await mustGet(id);
  if (project.status !== 'ready') throw new HttpError(409, 'まだ準備ができていません');
  if (!(await ffmpegHealth).ass) throw new HttpError(500, 'テロップを描ける ffmpeg（ffmpeg-full）が見つかりません');
  const body = await readJson(req);
  jobs.startExport(id, {
    captions: sanitizeExportCaptions(body.captions),
    style: normalizeStyle(body.style),
    resolution: ['source', '2160', '1440', '1080', '720'].includes(String(body.resolution)) ? String(body.resolution) : 'source',
    quality: body.quality === 'high' ? 'high' : 'standard',
    hdrMode: body.hdrMode === 'sdr' ? 'sdr' : 'keep',
  });
  sendJson(res, 202, jobs.publicRuntime(id).export);
});

route('GET', `${ID}/export`, async (req, res, { id }) => {
  await mustGet(id);
  sendJson(res, 200, jobs.publicRuntime(id).export);
});

route('POST', `${ID}/export/cancel`, async (req, res, { id }) => {
  await mustGet(id);
  jobs.cancelExport(id);
  sendJson(res, 200, { ok: true });
});

route('POST', `${ID}/srt`, async (req, res, { id }) => {
  const project = await mustGet(id);
  const body = await readJson(req);
  const file = await uniqueExportPath(`${project.name}_テロップ`, '.srt');
  await fsp.writeFile(file, buildSrt(sanitizeExportCaptions(body.captions)));
  sendJson(res, 200, { file: path.basename(file) });
});

route('GET', '/api/exports/(?<name>[^/]+)', async (req, res, { name }) => {
  const file = exportFile(decodeHeader(name));
  await sendFile(req, res, file, { download: path.basename(file) });
});

route('POST', '/api/reveal', async (req, res) => {
  const body = await readJson(req);
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  execFile('open', body.file ? ['-R', exportFile(body.file)] : [EXPORT_DIR], () => {});
  sendJson(res, 200, { ok: true });
});

async function serveStatic(req, res, pathname) {
  const rel = decodeHeader(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'アクセスできません');
  await sendFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  try {
    // 他のサイトからこのアプリを操作されないよう、ホスト名を確認する
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) throw new HttpError(403, 'アクセスできません');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (m) return await r.handler(req, res, m.groups || {});
      }
      throw new HttpError(404, '見つかりません');
    }
    if (method !== 'GET') throw new HttpError(405, 'この操作はできません');
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || (err.userMessage ? 409 : 500);
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.userMessage || err.message || 'エラーが発生しました' });
    else res.destroy();
  }
});

await store.init();
await jobs.recoverInterrupted();

server.requestTimeout = 0; // 大きな動画のアップロードで切れないように
server.headersTimeout = 60_000;
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} はすでに使われています。テロップメーカーがもう起動しているかもしれません: http://${HOST}:${PORT}/`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`テロップメーカーを起動しました: http://${HOST}:${PORT}/`);
  console.log('このウィンドウを閉じるとアプリは終了します。');
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    jobs.shutdown();
    setTimeout(() => process.exit(0), 300);
  });
}
