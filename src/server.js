'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { spawn, execFile } = require('child_process');
const config = require('./lib/config');
const cinemeta = require('./lib/cinemeta');
const torrentio = require('./lib/torrentio');
const subtitles = require('./lib/subtitles');
const player = require('./lib/player');
const { selectStreams } = require('./lib/select');
const { LANGS, tagMatches, isUnknownTag } = require('./lib/language');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const streamsByRef = new Map(); // ref -> parsed stream (so the browser never handles URLs/keys)
const resolved = new Map();     // ref -> { url, at }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function resolveFinal(ref) {
  const hit = resolved.get(ref);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.url;
  const s = streamsByRef.get(ref);
  if (!s) throw new HttpError(404, 'Stream expired, reload the stream list.');
  let url = s.url;
  try { // Torrentio's /resolve/ link 302s to the Real-Debrid direct link
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) url = new URL(loc, url).toString();
    r.body && r.body.cancel().catch(() => {});
  } catch { /* fall back to the original URL */ }
  resolved.set(ref, { url, at: Date.now() });
  return url;
}

function redacted(cfg) {
  const { realDebridKey, ...rest } = cfg;
  return { ...rest, hasRealDebridKey: !!realDebridKey, realDebridKeyHint: realDebridKey ? `…${realDebridKey.slice(-4)}` : '' };
}

const publicStream = (s) => ({
  ref: s.ref, name: s.name, filename: s.filename, resolution: s.resolution, size: s.size, seeders: s.seeders,
  provider: s.provider, audioLangs: s.audioLangs, cached: s.cached, hdr: s.hdr, source: s.source, codec: s.codec, languageMatch: s.languageMatch,
});

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

/**
 * Torrentio's language flags are only hints. Open each candidate with ffprobe and drop the ones whose
 * audio tracks are all in another language, then re-pick the best remaining stream per resolution.
 */
async function verifyAudio(picks, cfg, hidden) {
  const avail = player.available();
  if (!cfg.verifyAudio || !(avail.ffprobe || avail.ffmpeg)) return picks;
  const queue = picks.flatMap((p) => [p.stream, ...p.alternatives]);
  let next = 0;
  const bad = new Set();
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (next < queue.length) {
      const s = queue[next++];
      try {
        const raw = await probe(s.ref);
        if (raw.probed) {
          s.audioLangs = [...new Set(raw.audioTracks.map((t) => t.lang).filter((l) => !isUnknownTag(l)))];
          if (lacksNativeAudio(raw, cfg.nativeLanguage)) bad.add(s.ref);
        }
      } catch { /* unverifiable: keep it */ }
    }
  }));
  hidden.audio = bad.size;
  return picks.map((p) => {
    const list = [p.stream, ...p.alternatives].filter((s) => !bad.has(s.ref));
    return list.length ? { ...p, stream: list[0], alternatives: list.slice(1) } : null;
  }).filter(Boolean);
}

function resumePoint(p) {
  return { pos: p && p.dur && p.pos > 30 && p.pos / p.dur < 0.9 ? p.pos : 0 };
}

const probes = new Map();
const SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 25000, maxBuffer: 4e6 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

async function ffprobeInfo(url) {
  const { err, stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url]);
  if (err) return null;
  try {
    const j = JSON.parse(stdout);
    const v = (j.streams || []).find((x) => x.codec_type === 'video' && !x.disposition?.attached_pic);
    const audioTracks = (j.streams || []).filter((x) => x.codec_type === 'audio').map((x) => ({ codec: x.codec_name, lang: x.tags?.language || '' }));
    return { duration: parseFloat(j.format?.duration) || 0, video: v ? v.codec_name : '', audioTracks, eightBit: !v || !/10|12/.test(v.pix_fmt || '') };
  } catch { return null; }
}

/** Same facts from `ffmpeg -i` output, for machines that have ffmpeg but no ffprobe. */
async function ffmpegInfo(url) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', url]); // exits non-zero by design (no output file)
  const text = String(stderr || '');
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  const v = /Stream #[^\n]*Video:\s*(\w+)[^\n]*/.exec(text);
  const audioTracks = [...text.matchAll(/Stream #\d+:\d+(?:\((\w+)\))?[^\n]*Audio:\s*(\w+)/g)].map((m) => ({ codec: m[2].toLowerCase(), lang: m[1] || '' }));
  if (!v && !audioTracks.length) return null;
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0,
    video: v ? v[1].toLowerCase() : '', audioTracks,
    eightBit: !v || !/10le|10be|p10|12le/.test(v[0]),
  };
}

/** Ask ffprobe what's inside the file so we know whether Chromium can play it directly. */
async function probe(ref) {
  if (!probes.has(ref)) probes.set(ref, rawProbe(ref));
  const raw = await probes.get(ref);
  const cfg = config.loadConfig();
  const idx = nativeAudioIndex(raw.audioTracks, cfg.nativeLanguage);
  const track = raw.audioTracks[idx] || null;
  const videoOk = !raw.video || (SAFE_VIDEO.has(raw.video) && (raw.video !== 'h264' || raw.eightBit));
  const audioOk = !track || SAFE_AUDIO.has(track.codec);
  const needsConvert = !videoOk || !audioOk || idx > 0;
  return { ...raw, audioIndex: idx, audio: track ? track.codec : '', mode: raw.ffmpeg && needsConvert ? 'compat' : 'direct' };
}

/** Index of the audio track in the user's language (first track if none is tagged). */
function nativeAudioIndex(tracks, native) {
  const i = tracks.findIndex((t) => tagMatches(native, t.lang));
  return i >= 0 ? i : 0;
}

/** True when the file has language-tagged audio and none of it is the user's language. */
function lacksNativeAudio(raw, native) {
  const known = raw.audioTracks.filter((t) => !isUnknownTag(t.lang));
  return known.length > 0 && !known.some((t) => tagMatches(native, t.lang));
}

async function rawProbe(ref) {
  const info = { duration: 0, video: '', eightBit: true, audioTracks: [], ffmpeg: player.available().ffmpeg, probed: false };
  const avail = player.available();
  if (avail.ffprobe || avail.ffmpeg) {
    const url = await resolveFinal(ref);
    const found = avail.ffprobe ? await ffprobeInfo(url) : await ffmpegInfo(url);
    if (found) Object.assign(info, found, { probed: true });
  }
  return info;
}

/** Remux (or transcode when needed) to fragmented MP4 so any stream plays in the app window. */
async function compatStream(req, res, ref, t) {
  const url = await resolveFinal(ref);
  const info = await probe(ref);
  const copyVideo = (info.video === 'h264' && info.eightBit !== false) || info.video === 'vp9' || info.video === 'av1';
  const copyAudio = info.audio === 'opus'; // Opus-in-MP4 decodes in every Chromium build, AAC needs proprietary codecs
  const audioMap = `0:a:${info.audioIndex || 0}?`;
  const args = ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', url, '-map', '0:v:0', '-map', audioMap, '-sn',
    ...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-strict', '-2']),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
  ff.stdout.pipe(res);
  const stop = () => ff.kill('SIGKILL');
  res.on('close', stop);
  ff.on('error', () => res.destroy());
}

function recordProgress(key, pos, dur, meta) {
  const data = config.loadData();
  const prev = data.progress[key] || {};
  data.progress[key] = { ...prev, pos, dur, at: Date.now(), meta: meta || prev.meta };
  if (dur > 0 && pos / dur > 0.9) data.watched[key] = true;
  config.saveData(data);
}

function createServer(port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const routes = {
    async 'GET /api/config'() { return redacted(config.loadConfig()); },
    async 'POST /api/config'(req) {
      const body = await readBody(req);
      if (body.realDebridKey === '' && body.keepKey) delete body.realDebridKey;
      delete body.keepKey;
      return redacted(config.saveConfig(body));
    },
    async 'GET /api/info'() {
      return { players: player.available(), languages: Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [k, v.name])) };
    },
    async 'GET /api/catalog'(req, q) {
      return cinemeta.catalog(q.get('type'), { search: q.get('q') || '', genre: q.get('genre') || '', skip: q.get('skip') || 0 });
    },
    async 'GET /api/meta'(req, q) {
      const meta = await cinemeta.meta(q.get('type'), q.get('id'));
      if (!meta) throw new HttpError(404, 'Not found');
      const data = config.loadData();
      meta.inLibrary = data.library.some((m) => m.id === meta.imdb_id);
      meta.watched = data.watched;
      return meta;
    },
    async 'GET /api/streams'(req, q) {
      const cfg = config.loadConfig();
      const type = q.get('type'), id = q.get('id');
      if (!/^(movie|series)$/.test(type) || !/^tt\d+(:\d+:\d+)?$/.test(id || '')) throw new HttpError(400, 'bad type or id');
      let all;
      try { all = await torrentio.fetchStreams(cfg, type, id); } catch (e) { throw new HttpError(502, e.message); }
      for (const s of all) streamsByRef.set(s.ref, s);
      const { picks, hidden } = selectStreams(all, cfg);
      const verified = await verifyAudio(picks, cfg, hidden);
      return {
        total: all.length, hidden, language: LANGS[cfg.nativeLanguage]?.name || cfg.nativeLanguage,
        picks: verified.map((p) => ({ resolution: p.resolution, stream: publicStream(p.stream), alternatives: p.alternatives.map(publicStream) })),
      };
    },
    async 'GET /api/subtitles'(req, q) {
      const cfg = config.loadConfig();
      if (!cfg.subtitles) return [];
      try { return await subtitles.listSubtitles(q.get('type'), q.get('id'), cfg.nativeLanguage); } catch { return []; }
    },
    async 'GET /api/resume'(req, q) {
      return resumePoint(config.loadData().progress[q.get('key')]);
    },
    async 'GET /api/probe'(req, q) {
      const ref = q.get('ref');
      if (!/^[0-9a-f]{20}$/.test(ref || '')) throw new HttpError(400, 'bad ref');
      return probe(ref);
    },
    // Hand a stream to an external player (mpv / VLC).
    async 'POST /api/play'(req) {
      const { ref, key, title, meta, subs = [] } = await readBody(req);
      const cfg = config.loadConfig();
      let choice = player.pickPlayer(cfg.player);
      if (choice === 'browser') choice = player.pickPlayer('auto');
      if (choice === 'browser') throw new HttpError(400, 'Neither mpv nor VLC is installed.');
      const url = await resolveFinal(ref);
      const files = [];
      for (const r of subs) { try { files.push(await subtitles.fetchToFile(r)); } catch { /* subtitle is optional */ } }
      const { pos } = resumePoint(config.loadData().progress[key]);
      player.launch(choice, { url, title: String(title || 'StreamSnap'), subs: files, start: pos, onProgress: (p, d) => recordProgress(key, p, d, meta) });
      return { player: choice, start: pos };
    },
    async 'POST /api/progress'(req) {
      const { key, pos, dur, meta } = await readBody(req);
      if (typeof key === 'string' && Number.isFinite(pos) && Number.isFinite(dur)) recordProgress(key, pos, dur, meta);
      return { ok: true };
    },
    async 'GET /api/library'() {
      const data = config.loadData();
      const cont = Object.entries(data.progress)
        .filter(([k, p]) => p.meta && p.pos > 10 && !(p.dur && p.pos / p.dur > 0.9))
        .sort((a, b) => b[1].at - a[1].at).slice(0, 20)
        .map(([key, p]) => ({ key, pos: p.pos, dur: p.dur, ...p.meta }));
      return { library: data.library, continueWatching: cont, watched: data.watched };
    },
    async 'POST /api/library'(req) {
      const { id, type, name, poster } = await readBody(req);
      if (!/^tt\d+$/.test(id || '')) throw new HttpError(400, 'bad id');
      const data = config.loadData();
      const i = data.library.findIndex((m) => m.id === id);
      if (i >= 0) data.library.splice(i, 1); else data.library.unshift({ id, type, name, poster });
      config.saveData(data);
      return { inLibrary: i < 0 };
    },
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // Guard against DNS rebinding and cross-site requests to this local API.
      if (!hosts.has(req.headers.host)) throw new HttpError(403, 'bad host');
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !hosts.has(new URL(origin).host)) throw new HttpError(403, 'bad origin');
        if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON only');
      }
      let m;
      if ((m = /^\/api\/stream\/([0-9a-f]{20})$/.exec(url.pathname)) && req.method === 'GET') return proxyStream(req, res, m[1]);
      if ((m = /^\/api\/compat\/([0-9a-f]{20})$/.exec(url.pathname)) && req.method === 'GET') return compatStream(req, res, m[1], parseFloat(url.searchParams.get('t')) || 0);
      if ((m = /^\/api\/sub\/([0-9a-f]{20})\.vtt$/.exec(url.pathname)) && req.method === 'GET') {
        const vtt = await subtitles.fetchVtt(m[1]);
        res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
        return res.end(vtt);
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        const out = await handler(req, url.searchParams);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out));
      }
      if (req.method === 'GET') return serveStatic(url.pathname, res);
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function proxyStream(req, res, ref) {
  const url = await resolveFinal(ref);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  const up = await fetch(url, { headers, signal: ac.signal });
  const out = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h); if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

module.exports = { createServer };
