'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn, execFile } = require('child_process');
const config = require('./lib/config');
const cinemeta = require('./lib/cinemeta');
const torrentio = require('./lib/torrentio');
const subtitles = require('./lib/subtitles');
const tmdb = require('./lib/tmdb');
const xtream = require('./lib/xtream');
const live = require('./lib/live');
const health = require('./lib/health');
const segments = require('./lib/segments');
const probecache = require('./lib/probecache');
const player = require('./lib/player');
const { selectStreams } = require('./lib/select');
const { LANGS, tagMatches, isUnknownTag, detectLanguages } = require('./lib/language');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const streamsByRef = new Map(); // ref -> parsed stream (so the browser never handles URLs/keys)
const offline = require('./lib/offline');
const nba = require('./lib/nba');
const resolved = new Map();     // ref -> { url, at }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function resolveFinal(ref) {
  const hit = resolved.get(ref);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.url;
  const s = streamsByRef.get(ref);
  if (!s) throw new HttpError(404, 'Stream expired, reload the stream list.');
  const url = await resolveDirect(s.url);
  resolved.set(ref, { url, at: Date.now() });
  return url;
}

async function resolveDirect(url) {
  try { // Torrentio's /resolve/ link 302s to the Real-Debrid direct link
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) url = new URL(loc, url).toString();
    r.body && r.body.cancel().catch(() => {});
  } catch { /* fall back to the original URL */ }
  return url;
}

function redacted(cfg) {
  const { realDebridKey, tmdbKey, xtreamPass, ...rest } = cfg;
  return { ...rest, hasXtreamPass: !!xtreamPass, hasRealDebridKey: !!realDebridKey, realDebridKeyHint: realDebridKey ? `…${realDebridKey.slice(-4)}` : '', hasTmdbKey: !!tmdbKey };
}

const rankOpts = (type) => ({ ffmpeg: player.available().ffmpeg, throughputKbps: health.throughput() || 0, runtimeMin: type === 'movie' ? 110 : 45 });
const publicStream = (s) => ({ notes: s.notes || [], bit10: s.bit10, audio: s.audio,
  ref: s.ref, name: s.name, filename: s.filename, resolution: s.resolution, size: s.size, seeders: s.seeders,
  provider: s.provider, audioLangs: s.audioLangs, langs: [...detectLanguages(s).codes].map((c) => LANGS[c]?.name || c), cached: s.cached, hdr: s.hdr, source: s.source, codec: s.codec, languageMatch: s.languageMatch,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function verifyAudio(picks, cfg, hidden) {
  const avail = player.available();
  if (!cfg.verifyAudio || !(avail.ffprobe || avail.ffmpeg)) return picks;
  // While something is playing, never compete with it for bandwidth: only use what we already know.
  const busy = health.active() > 0;
  const perRes = busy ? 1 : 3, workers = busy ? 2 : 8;
  const bad = new Set(), done = new Set();
  const check = async (s) => {
    if (done.has(s.ref)) return;
    try {
      if (busy && !probecache.get(s)) return;
      const raw = await probe(s.ref);
      if (raw.probed) {
        s.audioLangs = [...new Set(raw.audioTracks.map((t) => t.lang).filter((l) => !isUnknownTag(l)))];
        done.add(s.ref);
        if (lacksNativeAudio(raw, cfg.nativeLanguage)) bad.add(s.ref);
      }
    } catch { /* unverifiable: keep it */ }
  };
  const pool = async (items) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => { while (i < items.length) await check(items[i++]); }));
  };
  // The best few per resolution decide what gets picked, so those are the ones worth checking. Checking never delays the
  // page for long: whatever isn't finished within the budget keeps going in the background and is remembered for next time.
  await Promise.race([(async () => {
    await pool(picks.flatMap((p) => [p.stream, ...p.alternatives].slice(0, perRes)));
    const next = picks.flatMap((p) => { const left = [p.stream, ...p.alternatives].filter((s) => !bad.has(s.ref)); return left.length && !done.has(left[0].ref) ? left.slice(0, 3) : []; });
    await pool(next);   // every checked candidate was in the wrong language: look a little further down the list
  })(), sleep(4500)]);
  hidden.audio = bad.size;
  return picks.map((p) => {
    const list = [p.stream, ...p.alternatives].filter((s) => !bad.has(s.ref));
    return list.length ? { ...p, stream: list[0], alternatives: list.slice(1) } : null;
  }).filter(Boolean);
}

/** Titles saved before genres were recorded get them from Cinemeta once, then they're stored with the entry. */
async function backfillGenres(data) {
  const missing = data.library.filter((m) => !Array.isArray(m.genres));
  if (!missing.length) return;
  await Promise.all(missing.map(async (m) => {
    try { const meta = await cinemeta.meta(m.type, m.id); m.genres = (meta && meta.genres) || []; } catch { /* offline: try again next time */ }
  }));
  if (missing.some((m) => Array.isArray(m.genres))) config.saveData(data);
}

/** Continue watching: the latest unfinished item per title, plus titles the user pinned by hand. */
function continueList(data) {
  const items = new Map();
  const live = Object.entries(data.progress)
    .filter(([, p]) => p.meta && /^tt\d+$/.test(p.meta.id) && p.pos > 10 && !(p.dur && p.pos / p.dur > 0.9))
    .sort((a, b) => b[1].at - a[1].at);
  for (const [key, p] of live) if (!items.has(p.meta.id)) items.set(p.meta.id, { key, pos: p.pos, dur: p.dur, at: p.at, ...p.meta });
  for (const m of data.pinned || []) if (!items.has(m.id)) items.set(m.id, { key: null, pos: 0, dur: 0, ...m });
  return [...items.values()].sort((a, b) => b.at - a.at).slice(0, 24);
}

/** Aired episodes after the furthest one watched; shows never started have no badge. */
function newEpisodeCount(data, id, meta, now = Date.now()) {
  const eps = ((meta && meta.videos) || []).filter((v) => v.season > 0 && v.released && Date.parse(v.released) <= now);
  let last = null;
  for (const v of eps) if (data.watched[`series:${v.id}`] && (!last || v.season > last.season || (v.season === last.season && v.episode > last.episode))) last = v;
  if (!last) return 0;
  return eps.filter((v) => (v.season > last.season || (v.season === last.season && v.episode > last.episode)) && !data.watched[`series:${v.id}`]).length;
}

function resumePoint(p) {
  return { pos: p && p.dur && p.pos > 10 && p.pos / p.dur < 0.9 ? p.pos : 0 };
}

const probes = new Map();
const SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 25000, maxBuffer: 4e6 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

async function ffprobeInfo(url) {
  const { err, stdout } = await run('ffprobe', ['-v', 'error', '-rw_timeout', '10000000', '-analyzeduration', '2000000', '-probesize', '2000000', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', url]);
  if (err) return null;
  try {
    const j = JSON.parse(stdout);
    const v = (j.streams || []).find((x) => x.codec_type === 'video' && !x.disposition?.attached_pic);
    const audioTracks = (j.streams || []).filter((x) => x.codec_type === 'audio').map((x) => ({ codec: x.codec_name, lang: x.tags?.language || '' }));
    const chapters = (j.chapters || []).map((c) => ({ start: parseFloat(c.start_time), end: parseFloat(c.end_time), title: c.tags?.title || '' }));
    return { duration: parseFloat(j.format?.duration) || 0, video: v ? v.codec_name : '', height: v ? Number(v.height) || 0 : 0, audioTracks, eightBit: !v || !/10|12/.test(v.pix_fmt || ''), chapters };
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
  return { ...raw, audioIndex: idx, audio: track ? track.codec : '', mode: raw.ffmpeg && (needsConvert || (streamsByRef.get(ref) || {}).forceCompat) ? 'compat' : 'direct', segments: segments.fromChapters(raw.chapters, raw.duration) };
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
    const stream = streamsByRef.get(ref), remembered = probecache.get(stream);
    if (remembered) return { ...info, ...remembered, ffmpeg: info.ffmpeg };          // seen this exact release before: no network at all
    const url = await resolveFinal(ref);
    const found = avail.ffprobe ? await ffprobeInfo(url) : await ffmpegInfo(url);
    if (found) { Object.assign(info, found, { probed: true }); probecache.set(stream, { ...found, probed: true }); }
  }
  return info;
}

/** Remux (or transcode when needed) to fragmented MP4 so any stream plays in the app window. */
async function compatStream(req, res, ref, t, delay = 0, maxH = 1080) {
  const url = await resolveFinal(ref);
  const info = await probe(ref);
  const copyVideo = (info.video === 'h264' && info.eightBit !== false) || info.video === 'vp9' || info.video === 'av1';
  const copyAudio = info.audio === 'opus'; // Opus-in-MP4 decodes in every Chromium build, AAC needs proprietary codecs
  delay = Math.max(-10, Math.min(10, delay));
  // Stream-copied video can only start on a keyframe; -noaccurate_seek keeps audio and video in step there.
  const seekFlags = copyVideo ? ['-noaccurate_seek'] : [];
  const inputs = delay
    ? [...seekFlags, '-ss', String(t), '-i', url, '-itsoffset', String(delay), ...seekFlags, '-ss', String(t), '-i', url]
    : [...seekFlags, '-ss', String(t), '-i', url];
  const aIn = delay ? 1 : 0;
  const big = info.height > 1080 || maxH <= 480;
  const vf = info.height > maxH || !info.height ? ['-vf', `scale=-2:'min(${maxH},ih)'`] : [];
  const args = ['-v', 'error', '-nostats', '-progress', 'pipe:2', '-fflags', '+genpts', ...inputs, '-map', '0:v:0', '-map', `${aIn}:a:${info.audioIndex || 0}?`, '-sn',
    ...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', big ? 'ultrafast' : 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', ...vf]),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-strict', '-2', '-af', 'aresample=async=1:first_pts=0']),
    '-avoid_negative_ts', 'make_zero', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = health.track(`vod:${ref}`, { kind: 'vod', mode: copyVideo ? 'copy' : 'transcode' });
  health.watchFfmpeg(entry, ff);
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
      if (body.tmdbKey === '' && !body.clearTmdbKey) delete body.tmdbKey; // blank means keep the saved key
      if (body.xtreamUrl === '') body.xtreamPass = '';                          // removing the server clears the login too
      else if (body.xtreamPass === '') delete body.xtreamPass;                  // blank means keep the saved password
      delete body.keepKey; delete body.clearTmdbKey;
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
      meta.inContinue = continueList(data).some((c) => c.id === meta.imdb_id);
      meta.watched = data.watched;
      // Most recently touched episode of this series, so the page can reopen where the user left off.
      const last = Object.values(data.progress).filter((p) => p.meta && p.meta.id === meta.imdb_id && p.meta.videoId).sort((a, b) => b.at - a.at)[0];
      if (last) meta.lastWatched = { videoId: last.meta.videoId, finished: last.dur > 0 && last.pos / last.dur > 0.9 };
      return meta;
    },
    // Other films in the same franchise (needs a TMDB key); never an error page, just "nothing to show".
    async 'GET /api/collection'(req, q) {
      const key = config.loadConfig().tmdbKey;
      if (!key) return { needsKey: true };
      try { return (await tmdb.collectionFor(q.get('id'), key)) || { parts: [] }; }
      catch (e) { return { parts: [], error: e.message }; }
    },
    // ---- Live TV (Xtream Codes) ----
    async 'POST /api/live/test'(req) {
      const b = await readBody(req), cfg = config.loadConfig();
      try {
        return await new xtream.Xtream({ url: b.url, user: b.user, pass: b.pass || cfg.xtreamPass }).account();
      } catch (e) { throw new HttpError(400, e.message); }
    },
    async 'GET /api/live/browse'() {
      const cfg = config.loadConfig();
      if (!cfg.xtreamUrl || !cfg.xtreamUser || !cfg.xtreamPass) return { configured: false };
      try {
        const x = xtream.clientFor(cfg);
        const [categories, channels] = await Promise.all([x.categories(), x.channels()]);
        const d = config.loadData();
        return { configured: true, categories, channels, favorites: d.liveFavorites || [], hidden: d.liveHiddenCats || [] };
      } catch (e) { throw new HttpError(502, e.message); }
    },
    // What's on now/next for a batch of channels (the page asks for the ones on screen).
    async 'GET /api/live/epg'(req, q) {
      const cfg = config.loadConfig();
      const ids = [...new Set((q.get('ids') || '').split(',').map(Number).filter(Number.isInteger))].slice(0, 30);
      const limit = Math.min(20, Math.max(2, Number(q.get('limit')) || 4));
      const out = {};
      if (!cfg.xtreamUrl || !ids.length) return out;
      const x = xtream.clientFor(cfg);
      let next = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < ids.length) { const id = ids[next++]; try { out[id] = await x.epg(id, limit); } catch { out[id] = []; } }
      }));
      return out;
    },
    // Hide (or show again) categories the user doesn't want to see; with hundreds of them this is the main tidy-up.
    async 'POST /api/live/hide'(req) {
      const b = await readBody(req);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => /^\d+$/.test(x)).slice(0, 5000);
      const data = config.loadData();
      const hidden = new Set(data.liveHiddenCats || []);
      for (const id of ids) b.hide ? hidden.add(id) : hidden.delete(id);
      data.liveHiddenCats = [...hidden];
      config.saveData(data);
      return { hidden: data.liveHiddenCats };
    },
    // Is a running stream limited by the provider or by this computer? (see lib/health.js)
    async 'GET /api/health'(req, q) { return health.snapshot(q.get('key') || ''); },
    async 'GET /api/live/why'(req, q) { return { reason: live.why(q.get('id')) }; },
    async 'POST /api/live/favorite'(req) {
      const id = Number((await readBody(req)).id);
      if (!Number.isInteger(id)) throw new HttpError(400, 'bad channel');
      const data = config.loadData();
      const favs = new Set(data.liveFavorites || []);
      favs.has(id) ? favs.delete(id) : favs.add(id);
      data.liveFavorites = [...favs];
      config.saveData(data);
      return { favorites: data.liveFavorites };
    },
    async 'GET /api/streams'(req, q) {
      const cfg = config.loadConfig();
      const type = q.get('type'), id = q.get('id');
      if (!/^(movie|series)$/.test(type) || !/^tt\d+(:\d+:\d+)?$/.test(id || '')) throw new HttpError(400, 'bad type or id');
      const t0 = Date.now();
      let all;
      try { all = await torrentio.fetchStreams(cfg, type, id); } catch (e) { throw new HttpError(502, e.message); }
      const tFetch = Date.now() - t0;
      for (const s of all) streamsByRef.set(s.ref, s);
      let { picks, hidden } = selectStreams(all, cfg, rankOpts(type));
      const t1 = Date.now();
      let verified = await verifyAudio(picks, cfg, hidden);
      const tVerify = Date.now() - t1;
      // Nothing in the user's language: better to offer every available stream (labelled) than an empty page.
      let languageFallback = false;
      if (!verified.length && all.length) {
        const any = selectStreams(all, cfg, { ...rankOpts(type), ignoreLanguage: true });
        if (any.picks.length) { verified = any.picks; hidden = { ...any.hidden, language: 0 }; languageFallback = true; }
      }
      return {
        timings: { fetchMs: tFetch, verifyMs: tVerify, totalMs: Date.now() - t0 },
        languageFallback,
        total: all.length, hidden, language: LANGS[cfg.nativeLanguage]?.name || cfg.nativeLanguage,
        picks: verified.map((p) => ({ resolution: p.resolution, stream: publicStream(p.stream), alternatives: p.alternatives.map(publicStream) })),
      };
    },
    async 'GET /api/subtitles'(req, q) {
      const cfg = config.loadConfig();
      if (!cfg.subtitles) return [];
      try { return await subtitles.listSubtitles(q.get('type'), q.get('id'), cfg.nativeLanguage); } catch { return []; }
    },
    // What we've learned about a show's intro and credits from the user's own skipping and viewing.
    async 'GET /api/skips'(req, q) {
      const e = config.loadData().skips?.[q.get('id')] || {};
      return { intro: e.intro ? { start: e.intro.start.value, end: e.intro.end.value } : null, creditsFromEnd: e.credits ? e.credits.value : null };
    },
    async 'POST /api/skips'(req) {
      const b = await readBody(req);
      if (!/^tt\d+$/.test(b.id || '')) throw new HttpError(400, 'bad id');
      const data = config.loadData(), e = (data.skips = data.skips || {})[b.id] = data.skips[b.id] || {};
      if (b.kind === 'intro' && b.start >= 0 && b.end - b.start >= 15 && b.end - b.start <= 300 && b.start < 900) {
        e.intro = { start: segments.blend(e.intro?.start, b.start), end: segments.blend(e.intro?.end, b.end) };
        e.intro.start.n = e.intro.end.n = Math.max(e.intro.start.n, e.intro.end.n);
      } else if (b.kind === 'credits' && b.fromEnd >= 15 && b.fromEnd <= 900) {
        e.credits = segments.blend(e.credits, b.fromEnd);
      } else throw new HttpError(400, 'bad skip data');
      config.saveData(data);
      return { ok: true };
    },
    async 'GET /api/resume'(req, q) {
      const p = config.loadData().progress[q.get('key')];
      return { ...resumePoint(p), stream: (p && p.meta && p.meta.stream) || null };
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
    // Series in the library or Continue watching that have aired episodes after the last one the user watched.
    async 'GET /api/new-episodes'() {
      const data = config.loadData();
      const ids = new Map();
      for (const m of [...data.library, ...(data.pinned || [])]) if (m.type === 'series') ids.set(m.id, m);
      for (const p of Object.values(data.progress)) if (p.meta && p.meta.type === 'series') ids.set(p.meta.id, p.meta);
      const out = {};
      await Promise.all([...ids.keys()].slice(0, 60).map(async (id) => {
        try { const n = newEpisodeCount(data, id, await cinemeta.meta('series', id)); if (n) out[id] = n; } catch { /* offline: no badge */ }
      }));
      return out;
    },
    // ---- Calendar: episodes of series in the library + NBA games ----
    async 'GET /api/calendar'(req, q) {
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      const from = q.get('from'), to = q.get('to');
      if (!iso.test(from || '') || !iso.test(to || '') || to < from || Date.parse(to) - Date.parse(from) > 62 * 86400000) throw new HttpError(400, 'bad date range');
      const cfg = config.loadConfig(), data = config.loadData();
      const series = new Map();
      for (const m of [...data.library, ...(data.pinned || [])]) if (m.type === 'series') series.set(m.id, m);
      for (const p of Object.values(data.progress)) if (p.meta && p.meta.type === 'series' && /^tt\d+$/.test(p.meta.id) && !series.has(p.meta.id)) series.set(p.meta.id, p.meta);
      const episodes = [];
      await Promise.all([...series.values()].slice(0, 80).map(async (m) => {
        try {
          const meta = await cinemeta.meta('series', m.id);
          for (const v of (meta && meta.videos) || []) {
            const day = typeof v.released === 'string' ? v.released.slice(0, 10) : '';
            if (!(v.season > 0) || day < from || day > to) continue;
            episodes.push({ kind: 'ep', series: m.id, name: m.name || meta.name, poster: m.poster || meta.poster || '', season: v.season, episode: v.episode, title: v.name || v.title || `Episode ${v.episode}`, date: day, watched: !!data.watched[`series:${m.id}:${v.season}:${v.episode}`] });
          }
        } catch { /* one series failing doesn't hide the rest */ }
      }));
      episodes.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name) || a.season - b.season || a.episode - b.episode);
      let games = [], gamesError = '';
      if (cfg.calendarNba) {
        try { games = await nba.fetchRange(Date.parse(from) - 86400000, Date.parse(to) + 2 * 86400000); }
        catch (e) { gamesError = e.message; }
      }
      return { episodes, games, gamesError, nba: !!cfg.calendarNba, hasLive: !!cfg.xtreamUrl };
    },
    // One game with fresh score/status and the best channels to watch it on (needs Live TV).
    async 'GET /api/nba/game'(req, q) {
      const id = q.get('id'), start = Number(q.get('start'));
      if (!/^\d+$/.test(id || '') || !Number.isFinite(start)) throw new HttpError(400, 'bad game');
      let games;
      try { games = await nba.fetchRange(start - 86400000, start + 2 * 86400000); } catch (e) { throw new HttpError(502, e.message); }
      const game = games.find((g) => g.id === id);
      if (!game) throw new HttpError(404, 'That game isn\'t on the schedule any more.');
      const cfg = config.loadConfig();
      let streams = [];
      if (cfg.xtreamUrl && cfg.xtreamUser && cfg.xtreamPass && game.state !== 'final' && !game.postponed) {
        try {
          const x = xtream.clientFor(cfg);
          const cands = nba.matchChannels(game, await x.channels());
          streams = await nba.confirmWithGuide(game, cands, (cid) => x.epg(cid, 6));
        } catch { /* provider down: the card still shows the score */ }
      }
      return { game, streams: streams.slice(0, 8), hasLive: !!cfg.xtreamUrl, ends: game.start + nba.GAME_MS };
    },
    // ---- Downloads and DVR ----
    async 'GET /api/offline'() { return offline.list(); },
    async 'POST /api/offline/download'(req) {
      const { ref, title, subtitle, meta } = await readBody(req);
      const st = streamsByRef.get(ref);
      if (!st) throw new HttpError(404, 'Stream expired, reload the stream list.');
      if (typeof title !== 'string' || !title) throw new HttpError(400, 'bad title');
      return offline.addDownload({ title, subtitle: String(subtitle || ''), resolution: st.resolution, size: st.size, filename: st.filename, meta, src: st.url });
    },
    async 'POST /api/offline/pause'(req) { offline.pauseDownload(String((await readBody(req)).id)); return { ok: true }; },
    async 'POST /api/offline/resume'(req) { offline.resumeDownload(String((await readBody(req)).id)); return { ok: true }; },
    async 'POST /api/offline/remove'(req) { offline.remove(String((await readBody(req)).id)); return { ok: true }; },
    // Make a finished download/recording playable by the normal player; returns a stream the client can open.
    async 'GET /api/offline/play'(req, q) {
      const j = offline.find(q.get('id'));
      if (!j || j.status !== 'done' || !j.file) throw new HttpError(404, 'That file isn\'t ready.');
      const ref = crypto.createHash('sha1').update('offline:' + j.id).digest('hex').slice(0, 20);
      const isRec = !!j.channelId;
      const st = { ref, url: `http://${req.headers.host}/api/file/${j.id}`, name: j.title, filename: path.basename(j.file), resolution: isRec ? 'Recording' : j.resolution, size: j.bytes || j.total || 0, seeders: 0, provider: 'Offline', languageLine: '', cached: true, hdr: false, source: '', codec: '', forceCompat: isRec };
      streamsByRef.set(ref, st);
      resolved.delete(ref);
      return { stream: publicStream(st), meta: j.meta || {}, title: j.title, subtitle: j.subtitle || '', recording: isRec, id: j.id };
    },
    async 'POST /api/dvr/record'(req) {
      const b = await readBody(req), cfg = config.loadConfig();
      if (!cfg.xtreamUrl) throw new HttpError(400, 'Live TV isn\'t set up.');
      if (!/^\d+$/.test(String(b.channelId))) throw new HttpError(400, 'bad channel');
      const now = Date.now();
      const start = Number.isFinite(b.start) ? b.start : now;
      const end = Number.isFinite(b.end) ? b.end : start + (Number(b.minutes) || 60) * 60000;
      try {
        const rec = offline.schedule({ channelId: b.channelId, name: String(b.name || 'Recording').slice(0, 120), start, end, padded: !!b.padded });
        offline.tick({ liveUrlFor: (id) => xtream.clientFor(cfg).liveUrl(id) });   // starts right away when it's due now
        return { ...rec, status: rec.start <= Date.now() + 1000 ? 'recording' : rec.status };
      }
      catch (e) { throw new HttpError(e.status || 400, e.message); }
    },
    async 'POST /api/dvr/stop'(req) { offline.stopRecording(String((await readBody(req)).id)); return { ok: true }; },
    async 'GET /api/library'() {
      const data = config.loadData();
      const cont = continueList(data);
      await backfillGenres(data);
      return { library: data.library, continueWatching: cont, watched: data.watched };
    },
    // Idempotent add (the toggle above is for the details page); used by the "+" on cover art.
    async 'POST /api/library/add'(req) {
      const { id, type, name, poster, genres } = await readBody(req);
      if (!/^tt\d+$/.test(id || '') || !/^(movie|series)$/.test(type)) throw new HttpError(400, 'bad title');
      const data = config.loadData();
      if (!data.library.some((m) => m.id === id)) {
        const clean = Array.isArray(genres) ? genres.filter((g) => typeof g === 'string').slice(0, 8) : [];
        data.library.unshift({ id, type, name: String(name || ''), poster: String(poster || ''), genres: clean });
        config.saveData(data);
      }
      return { inLibrary: true };
    },
    async 'POST /api/library/remove'(req) {
      const { id } = await readBody(req);
      const data = config.loadData();
      data.library = data.library.filter((m) => m.id !== id);
      config.saveData(data);
      return { ok: true };
    },
    // "Continue watching" is derived from saved progress, so removing a title clears its progress entries.
    async 'POST /api/continue/add'(req) {
      const { id, type, name, poster } = await readBody(req);
      if (!/^tt\d+$/.test(id || '') || !/^(movie|series)$/.test(type)) throw new HttpError(400, 'bad title');
      const data = config.loadData();
      data.pinned = (data.pinned || []).filter((m) => m.id !== id);
      data.pinned.unshift({ id, type, name: String(name || ''), poster: String(poster || ''), at: Date.now() });
      config.saveData(data);
      return { ok: true };
    },
    async 'POST /api/continue/remove'(req) {
      const { id } = await readBody(req);
      const data = config.loadData();
      data.pinned = (data.pinned || []).filter((m) => m.id !== id);
      for (const [key, p] of Object.entries(data.progress)) if (p.meta && p.meta.id === id) delete data.progress[key];
      config.saveData(data);
      return { ok: true };
    },
    async 'POST /api/library'(req) {
      const { id, type, name, poster, genres } = await readBody(req);
      if (!/^tt\d+$/.test(id || '')) throw new HttpError(400, 'bad id');
      const data = config.loadData();
      const i = data.library.findIndex((m) => m.id === id);
      const clean = Array.isArray(genres) ? genres.filter((g) => typeof g === 'string').slice(0, 8) : [];
      if (i >= 0) data.library.splice(i, 1); else data.library.unshift({ id, type, name, poster, genres: clean });
      config.saveData(data);
      return { inLibrary: i < 0 };
    },
  };

  const server = http.createServer(async (req, res) => {
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
      if ((m = /^\/api\/file\/([0-9a-f]{16})$/.exec(url.pathname)) && req.method === 'GET') return offline.serveFile(req, res, m[1]);
      if ((m = /^\/api\/live\/stream\/(\d+)$/.exec(url.pathname)) && req.method === 'GET') {
        const cfg = config.loadConfig();
        if (!cfg.xtreamUrl || !player.available().ffmpeg) throw new HttpError(400, player.available().ffmpeg ? 'Live TV isn\'t set up.' : 'Live TV needs ffmpeg (sudo dnf/apt install ffmpeg).');
        return live.streamLive(res, xtream.clientFor(cfg).liveUrl(m[1]), m[1], parseInt(url.searchParams.get('a'), 10) || 0, [1080, 720, 480].includes(Number(url.searchParams.get('q'))) ? Number(url.searchParams.get('q')) : 1080);
      }
      if ((m = /^\/api\/compat\/([0-9a-f]{20})$/.exec(url.pathname)) && req.method === 'GET') return compatStream(req, res, m[1], parseFloat(url.searchParams.get('t')) || 0, parseFloat(url.searchParams.get('a')) || 0, [1080, 720, 480].includes(Number(url.searchParams.get('q'))) ? Number(url.searchParams.get('q')) : 1080);
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
  // Scheduled recordings start on time; downloads run only while nothing is streaming, so they can never cause buffering.
  const timer = setInterval(() => {
    try {
      const cfg = config.loadConfig();
      offline.tick({ liveUrlFor: (id) => (cfg.xtreamUrl ? xtream.clientFor(cfg).liveUrl(id) : null) });
      offline.pumpDownloads(resolveDirect, health.active() > 0);
    } catch { /* try again next tick */ }
  }, 4000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
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
  // measure what the provider is delivering, compared with what this file needs to play without pauses
  const key = `vod:${ref}`;
  let e = health.entry(key);
  if (!e) {
    const total = Number((/\/(\d+)$/.exec(out['content-range'] || '') || [])[1]) || Number(out['content-length']) || 0;
    const raw = probes.has(ref) ? await probes.get(ref).catch(() => null) : null;
    e = health.track(key, { kind: 'vod', mode: 'direct', needKbps: raw && raw.duration && total ? (total * 8) / raw.duration / 1000 : 0 });
    e.refs = 0;
  }
  e.refs++;
  res.on('close', () => { if (--e.refs <= 0) health.untrack(e); });
  const body = Readable.fromWeb(up.body);
  body.on('data', (c) => health.countIn(e, c.length)).on('error', () => res.destroy()).pipe(res);
}

module.exports = { createServer, newEpisodeCount };
