'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const config = require('./lib/config');
const cinemeta = require('./lib/cinemeta');
const torrentio = require('./lib/torrentio');
const subtitles = require('./lib/subtitles');
const player = require('./lib/player');
const { selectStreams } = require('./lib/select');
const { LANGS } = require('./lib/language');

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
  provider: s.provider, cached: s.cached, hdr: s.hdr, source: s.source, codec: s.codec, languageMatch: s.languageMatch,
});

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function episodeKey(type, id) { return `${type}:${id}`; }

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
      return {
        total: all.length, hidden, language: LANGS[cfg.nativeLanguage]?.name || cfg.nativeLanguage,
        picks: picks.map((p) => ({ resolution: p.resolution, stream: publicStream(p.stream), alternatives: p.alternatives.map(publicStream) })),
      };
    },
    async 'GET /api/subtitles'(req, q) {
      const cfg = config.loadConfig();
      if (!cfg.subtitles) return [];
      try { return await subtitles.listSubtitles(q.get('type'), q.get('id'), cfg.nativeLanguage); } catch { return []; }
    },
    async 'POST /api/play'(req) {
      const { ref, key, title, meta, subs = [], browser } = await readBody(req);
      const cfg = config.loadConfig();
      const choice = browser ? 'browser' : player.pickPlayer(cfg.player);
      const prog = config.loadData().progress[key];
      const start = prog && prog.dur && prog.pos / prog.dur < 0.9 && prog.pos > 30 ? prog.pos : 0;
      if (choice === 'browser') return { player: 'browser', start };
      const url = await resolveFinal(ref);
      const subUrls = subs.map((r) => subtitles.subtitleUrl(r)).filter(Boolean);
      player.launch(choice, { url, title: String(title || 'StreamSnap'), subs: subUrls, start, onProgress: (pos, dur) => recordProgress(key, pos, dur, meta) });
      recordProgress(key, prog?.pos || 0, prog?.dur || 0, meta);
      return { player: choice, start };
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
