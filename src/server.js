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
const people = require('./lib/people');
const kitsu = require('./lib/kitsu');
const animeaudio = require('./lib/animeaudio');
const anime = require('./lib/anime');
const franchise = require('./lib/franchise');
const TITLE_ID = /^(tt\d+|kitsu:\d+)$/;                          // a movie, show or anime: IMDb or Kitsu id
const EPISODE_ID = /^(tt\d+(:\d+:\d+)?|kitsu:\d+(:\d+)?)$/;   // ...or one of its episodes
const langName = (tag) => { const k = String(tag || '').toLowerCase(); return (Object.values(LANGS).find((l) => l.iso3 === k) || LANGS[k] || {}).name || ''; };
const metaFor = (type, id) => (anime.isKitsuId(id) ? kitsu.meta(id) : cinemeta.meta(type, id));
const personCache = new Map();   // name -> { at, out }
const resolved = new Map();     // ref -> { url, at }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function resolveFinal(ref, { fresh = false } = {}) {
  const hit = fresh ? null : resolved.get(ref);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.url;
  const s = streamsByRef.get(ref);
  if (!s) throw new HttpError(404, 'Stream expired, reload the stream list.');
  const url = await resolveDirect(s.url);
  resolved.set(ref, { url, at: Date.now() });
  return url;
}

// Torrentio answers a resolve request with a redirect to the Real-Debrid file, or, when something is wrong, with a redirect to one
// of its own placeholder videos (or an error page). Treating those as the stream is what makes a title "load" and then never play.
const PLACEHOLDER_REASONS = [
  [/download(ing)?/i, 'Real-Debrid is still downloading this file. Try again in a minute.'],
  [/access/i, 'Real-Debrid refused access. Check your API key and account status in Settings.'],
  [/rar|archive/i, 'This release is packed in an archive that can’t be streamed. Pick another one.'],
  [/no_download|no_links|unavailable/i, 'Real-Debrid has no download link for this file. Pick another release.'],
  [/ban|limit|traffic/i, 'Real-Debrid is limiting this account right now (too many requests or traffic). Wait a bit and try again.'],
];
const reasonFor = (name) => (PLACEHOLDER_REASONS.find(([re]) => re.test(name)) || [0, `Real-Debrid couldn’t provide this file (${name}). Pick another release.`])[1];

/** The direct URL for a stream, re-checked when it was resolved a while ago (Real-Debrid links expire; a dead one fails silently). */
async function checkedUrl(ref) {
  const hit = resolved.get(ref);
  const url = await resolveFinal(ref);
  if (hit && Date.now() - hit.at > 60 * 1000) {
    try {
      const r = await fetch(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(10000) });
      r.body && r.body.cancel().catch(() => {});
      if (r.status >= 400) { resolved.delete(ref); return resolveFinal(ref, { fresh: true }); }
    } catch { /* unreachable now: let the caller's own request report it */ }
  }
  return url;
}

async function resolveDirect(url, attempts = 3) {
  let last = 'Real-Debrid didn’t answer';
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(500 * 2 ** (i - 1));
    try { // Torrentio's /resolve/ link 302s to the Real-Debrid direct link
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const loc = r.headers.get('location');
      const type = r.headers.get('content-type') || '';
      r.body && r.body.cancel().catch(() => {});
      if (r.status >= 300 && r.status < 400 && loc) {
        const to = new URL(loc, url);
        if (/^\/videos\//.test(to.pathname) && to.host === new URL(url).host) throw Object.assign(new Error(reasonFor(to.pathname.split('/').pop())), { final: true });
        return to.toString();
      }
      if (r.ok && /^(video|application\/octet-stream)/i.test(type)) return url;           // served directly, no redirect
      last = r.status === 429 ? 'Real-Debrid / Torrentio is rate limiting requests. Wait a moment and try again.' : `The stream service answered ${r.status} instead of a video.`;
    } catch (e) {
      if (e.final) throw new HttpError(502, e.message);
      last = `Couldn’t reach the stream service (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`;
    }
  }
  throw new HttpError(502, last);
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
    try { const meta = await metaFor(m.type, m.id); m.genres = (meta && meta.genres) || []; } catch { /* offline: try again next time */ }
  }));
  if (missing.some((m) => Array.isArray(m.genres))) config.saveData(data);
}

/** Continue watching: the latest unfinished item per title, plus titles the user pinned by hand. */
function continueList(data) {
  const items = new Map();
  const live = Object.entries(data.progress)
    .filter(([, p]) => p.meta && TITLE_ID.test(p.meta.id) && p.pos > 10 && !(p.dur && p.pos / p.dur > 0.9))
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
    const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
    const subTracks = (j.streams || []).filter((x) => x.codec_type === 'subtitle').map((x, n) => ({ n, codec: x.codec_name, lang: x.tags?.language || '', title: x.tags?.title || '', forced: !!x.disposition?.forced, default: !!x.disposition?.default }))
      .filter((t) => TEXT_SUBS.has(t.codec));
    const chapters = (j.chapters || []).map((c) => ({ start: parseFloat(c.start_time), end: parseFloat(c.end_time), title: c.tags?.title || '' }));
    return { duration: parseFloat(j.format?.duration) || 0, video: v ? v.codec_name : '', height: v ? Number(v.height) || 0 : 0, audioTracks, subTracks, eightBit: !v || !/10|12/.test(v.pix_fmt || ''), chapters };
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
async function probe(ref, lang) {
  if (!probes.has(ref)) probes.set(ref, rawProbe(ref));
  const raw = await probes.get(ref);
  const cfg = config.loadConfig();
  const idx = nativeAudioIndex(raw.audioTracks, lang || cfg.nativeLanguage);   // `lang`: anime asks for Japanese (sub) or the dub language
  const track = raw.audioTracks[idx] || null;
  const videoOk = !raw.video || (SAFE_VIDEO.has(raw.video) && (raw.video !== 'h264' || raw.eightBit));
  const audioOk = !track || SAFE_AUDIO.has(track.codec);
  const needsConvert = !videoOk || !audioOk || idx > 0;
  return { ...raw, audioIndex: idx, audio: track ? track.codec : '', copyVideo: copiesVideo(raw), subTracks: (raw.subTracks || []).map((t) => ({ ...t, native: tagMatches(cfg.nativeLanguage, t.lang), langName: langName(t.lang) })), mode: raw.ffmpeg && (needsConvert || (streamsByRef.get(ref) || {}).forceCompat) ? 'compat' : 'direct', segments: segments.fromChapters(raw.chapters, raw.duration) };
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

const copiesVideo = (info) => (info.video === 'h264' && info.eightBit !== false) || info.video === 'vp9' || info.video === 'av1';

/**
 * ffmpeg arguments that remux (or transcode when needed) one file to fragmented MP4 from `t` seconds on.
 * Copied video can only start on a keyframe, so it starts a little before `t` and the audio must start at that same moment:
 * trimming the audio to start at `t` instead (aresample first_pts=0) leaves the sound running seconds ahead of the picture.
 * The client asks /api/keyframe first and passes the keyframe's own time as `t`, so the two agree on where the stream starts.
 */
function compatArgs(url, info, { t = 0, delay = 0, maxH = 1080 } = {}) {
  const copyVideo = copiesVideo(info);
  const copyAudio = info.audio === 'opus'; // Opus-in-MP4 decodes in every Chromium build, AAC needs proprietary codecs
  delay = Math.max(-10, Math.min(10, delay));
  const seekFlags = copyVideo ? ['-noaccurate_seek'] : [];
  const inputs = delay
    ? [...seekFlags, '-ss', String(t), '-i', url, '-itsoffset', String(delay), ...seekFlags, '-ss', String(t), '-i', url]
    : [...seekFlags, '-ss', String(t), '-i', url];
  const aIn = delay ? 1 : 0;
  const big = info.height > 1080 || maxH <= 480;
  const vf = info.height > maxH || !info.height ? ['-vf', `scale=-2:'min(${maxH},ih)'`] : [];
  return { copyVideo, args: ['-v', 'error', '-nostats', '-progress', 'pipe:2', '-fflags', '+genpts', ...inputs, '-map', '0:v:0', '-map', `${aIn}:a:${info.audioIndex || 0}?`, '-sn',
    ...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', big ? 'ultrafast' : 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', ...vf]),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-strict', '-2', '-af', 'aresample=async=1']),
    '-avoid_negative_ts', 'make_zero', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'] };
}

/** Start time of the keyframe a copy-mode stream beginning at `t` would actually start on (null when it can't be found). */
const keyframeCache = new Map();
async function keyframeBefore(ref, t) {
  const key = `${ref}|${Math.round(t * 10)}`;
  if (keyframeCache.has(key)) return keyframeCache.get(key);
  const url = await checkedUrl(ref);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${t}%+#1`, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', url]);
  const k = parseFloat(String(stdout).split('\n')[0]);
  const out = Number.isFinite(k) && k <= t + 0.05 && t - k < 60 ? k : null;
  if (out != null) { keyframeCache.set(key, out); if (keyframeCache.size > 300) keyframeCache.delete(keyframeCache.keys().next().value); }
  return out;
}

/** Remux (or transcode when needed) to fragmented MP4 so any stream plays in the app window. */
async function compatStream(req, res, ref, t, delay = 0, maxH = 1080, lang) {
  const url = await checkedUrl(ref);
  const info = await probe(ref, lang);
  const { copyVideo, args } = compatArgs(url, info, { t, delay, maxH });
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

// ---------- anime ----------
/** Releases for a Kitsu id: Torrentio's anime providers, asked as "anime" first and as "series" if that has nothing. */
async function animeStreamList(cfg, ids) {
  let lastErr = null, asked = false;
  for (const sid of ids) for (const t of ['anime', 'series']) {
    try { const l = await torrentio.fetchStreams(cfg, t, sid); asked = true; if (l.length) return l; } catch (e) { lastErr = e; }
  }
  if (!asked && lastErr) throw lastErr;
  return [];
}

/** The stream list for an anime episode or film, as picks for subbed and for dubbed viewing. */
async function animeStreams(cfg, id, wanted) {
  const t0 = Date.now();
  const all = await animeStreamList(cfg, /^kitsu:\d+$/.test(id) ? [id, `${id}:1`] : [id]);
  for (const s of all) streamsByRef.set(s.ref, s);
  const by = {};
  for (const kind of ['sub', 'dub']) {
    const sel = selectStreams(anime.forKind(all, kind), cfg, { ...rankOpts('series'), ignoreLanguage: true });   // anime audio isn't about the native-language flag
    by[kind] = { picks: kind === 'dub' ? await verifyAudio(sel.picks, cfg, sel.hidden) : sel.picks, hidden: sel.hidden };
  }
  const pub = (picks) => picks.map((p) => ({ resolution: p.resolution, stream: publicStream(p.stream), alternatives: p.alternatives.map(publicStream) }));
  const want = wanted === 'dub' || wanted === 'sub' ? wanted : cfg.animeAudio === 'dub' ? 'dub' : 'sub';
  const other = want === 'sub' ? 'dub' : 'sub';
  const kind = by[want].picks.length || !by[other].picks.length ? want : other;
  return {
    timings: { totalMs: Date.now() - t0 }, languageFallback: false, total: all.length, hidden: by[kind].hidden, language: LANGS[cfg.nativeLanguage]?.name || cfg.nativeLanguage,
    picks: pub(by[kind].picks),
    anime: { kind, fallback: kind !== want, wanted: want, audioLang: { sub: 'ja', dub: cfg.nativeLanguage }, available: { sub: by.sub.picks.length > 0, dub: by.dub.picks.length > 0 }, variants: { sub: pub(by.sub.picks), dub: pub(by.dub.picks) } },
  };
}

// Embedded text subtitles (anime releases carry theirs inside the file) extracted to WebVTT. It has to read the whole file, so it runs
// once per file, in the background, and the result is kept.
const embeddedSubs = new Map();   // "ref:n" -> Promise<string>
function embeddedVtt(ref, n) {
  const key = `${ref}:${n}`;
  if (embeddedSubs.has(key)) return embeddedSubs.get(key);
  const job = (async () => {
    const url = await checkedUrl(ref);
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', url, '-map', `0:s:${n}`, '-f', 'webvtt', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0;
      const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('Extracting the subtitles took too long.')); }, 5 * 60 * 1000);
      ff.stdout.on('data', (c) => { size += c.length; if (size > 25e6) ff.kill('SIGKILL'); else chunks.push(c); });
      ff.on('error', (e) => { clearTimeout(timer); reject(e); });
      ff.on('close', (code) => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (code === 0 && text.startsWith('WEBVTT')) resolve(text); else reject(new Error('Couldn’t read the subtitles in this file.'));
      });
    });
  })();
  embeddedSubs.set(key, job);
  job.catch(() => embeddedSubs.delete(key));
  while (embeddedSubs.size > 30) embeddedSubs.delete(embeddedSubs.keys().next().value);
  return job;
}

let guarded = false;
function createServer(port) {
  // A failure in one request (a dead link, a dropped connection) must never take the whole app down.
  if (!guarded) { guarded = true; process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message ? e.message : e)); }
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
      const meta = await metaFor(q.get('type'), q.get('id'));
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
    // Everything a person is credited on. With a TMDB key it's their full filmography; without one (or if TMDB is down)
    // it falls back to Cinemeta's search, checked against each title's credits, which only finds the best-known work.
    async 'GET /api/person'(req, q) {
      const name = String(q.get('name') || '').trim(), from = q.get('from') || '';
      if (name.length < 2 || name.length > 80) throw new HttpError(400, 'bad name');
      const tmdbKey = config.loadConfig().tmdbKey;
      const key = `${people.norm(name)}|${from}|${tmdbKey ? 1 : 0}`, hit = personCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.out;
      let out, notice = '';
      if (tmdbKey) {
        try {
          const f = await tmdb.filmography(name, tmdbKey, from);
          if (f.items.length) out = { ...f, other: [], source: 'tmdb' };
        } catch (e) { notice = e.message; }
      }
      if (!out) out = { ...(await people.find(name, { catalog: cinemeta.catalog, meta: cinemeta.meta })), source: 'cinemeta', needsKey: !tmdbKey, notice };
      if (out.items.length) { personCache.set(key, { at: Date.now(), out }); if (personCache.size > 100) personCache.delete(personCache.keys().next().value); }
      return out;
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
      if (!/^(movie|series)$/.test(type) || !EPISODE_ID.test(id || '')) throw new HttpError(400, 'bad type or id');
      if (anime.isKitsuId(id)) { try { return await animeStreams(cfg, id, q.get('audio')); } catch (e) { throw new HttpError(502, e.message); } }
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
      if (!TITLE_ID.test(b.id || '')) throw new HttpError(400, 'bad id');
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
      const al = q.get('al');
      return probe(ref, /^[a-z]{2,3}$/.test(al || '') ? al : undefined);
    },
    // Where a converted stream starting at t really starts (the keyframe at or before it), so the player can show the right time.
    async 'GET /api/keyframe'(req, q) {
      const ref = q.get('ref'), t = parseFloat(q.get('t'));
      if (!/^[0-9a-f]{20}$/.test(ref || '') || !Number.isFinite(t) || t < 0) throw new HttpError(400, 'bad request');
      if (!player.available().ffprobe) return { start: null };
      return { start: await keyframeBefore(ref, t).catch(() => null) };
    },
    // Why won't this stream play? Re-resolves it from scratch and asks the provider for its first bytes.
    async 'GET /api/stream-check'(req, q) {
      const ref = q.get('ref');
      if (!/^[0-9a-f]{20}$/.test(ref || '')) throw new HttpError(400, 'bad ref');
      resolved.delete(ref);
      try {
        const url = await resolveFinal(ref, { fresh: true });
        const r = await fetch(url, { headers: { range: 'bytes=0-1' }, signal: AbortSignal.timeout(20000) });
        r.body && r.body.cancel().catch(() => {});
        if (r.status >= 400) return { ok: false, reason: `The provider answered ${r.status} for this file. It may have been removed; pick another release.` };
        const type = r.headers.get('content-type') || '';
        if (/^(text\/html|application\/json)/i.test(type)) return { ok: false, reason: 'The provider returned a web page instead of the video. Pick another release.' };
        return { ok: true };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
    // Hand a stream to an external player (mpv / VLC).
    async 'POST /api/play'(req) {
      const { ref, key, title, meta, subs = [] } = await readBody(req);
      const cfg = config.loadConfig();
      let choice = player.pickPlayer(cfg.player);
      if (choice === 'browser') choice = player.pickPlayer('auto');
      if (choice === 'browser') throw new HttpError(400, 'Neither mpv nor VLC is installed.');
      const url = await checkedUrl(ref);
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
        try { const n = newEpisodeCount(data, id, await metaFor('series', id)); if (n) out[id] = n; } catch { /* offline: no badge */ }
      }));
      return out;
    },
    // ---- Anime (Kitsu catalog; Torrentio's anime providers for the files) ----
    async 'GET /api/anime/catalog'(req, q) {
      const kind = ['trending', 'popular', 'airing', 'rating'].includes(q.get('kind')) ? q.get('kind') : 'trending';
      try { return await kitsu.catalog({ kind, genre: q.get('genre') || '', q: (q.get('q') || '').slice(0, 80), skip: q.get('skip') || 0 }); }
      catch (e) { throw new HttpError(502, e.message); }
    },
    // Seasons of one show are separate entries in Kitsu. For each id: the franchise's first entry and how many seasons it has, so the
    // list can show it once; null when the title stands alone. Ids Kitsu couldn't be asked about are left out (shown as they are).
    async 'GET /api/anime/groups'(req, q) {
      const ids = [...new Set((q.get('ids') || '').split(',').filter((x) => /^kitsu:\d+$/.test(x)))].slice(0, 40);
      const out = {};
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < ids.length) {
          const id = ids[i++], g = await franchise.groupOf(id);
          if (g === undefined) continue;
          if (g === null) { out[id] = null; continue; }
          const rootInfo = g.members.find((m) => m.id === g.root) || {};
          out[id] = { root: g.root, isRoot: g.root === id, seasons: g.seasons, season: (g.members.find((m) => m.id === id) || {}).season || 0,
            rootInfo: { id: g.root, type: 'series', anime: true, name: rootInfo.name || g.root, poster: rootInfo.poster || '', releaseInfo: rootInfo.year || '' } };
        }
      }));
      return out;
    },
    // The whole franchise for a title's page: seasons in order, then films and specials.
    async 'GET /api/anime/franchise'(req, q) {
      const id = q.get('id');
      if (!/^kitsu:\d+$/.test(id || '')) throw new HttpError(400, 'bad id');
      const g = await franchise.groupOf(id);
      return g ? { ...g, current: id } : { root: id, members: [], seasons: 0, current: id };
    },
    // Which of these titles can be watched subbed / dubbed (looked up from the releases that exist; remembered for a day).
    async 'GET /api/anime/audio'(req, q) {
      const ids = [...new Set((q.get('ids') || '').split(',').filter((x) => /^kitsu:\d+$/.test(x)))].slice(0, 30);
      const cfg = config.loadConfig(), out = {};
      let i = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (i < ids.length) {
          const id = ids[i++], hit = animeaudio.get(id);
          if (hit) { out[id] = hit; continue; }
          try {
            const list = (await animeStreamList(cfg, [`${id}:1`, id])).filter((x) => x.cached || cfg.allowUncached);
            const a = anime.availability(list);
            animeaudio.set(id, a); out[id] = a;
          } catch { out[id] = null; }           // couldn't look: leave it unmarked and try again next time
        }
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
      for (const p of Object.values(data.progress)) if (p.meta && p.meta.type === 'series' && TITLE_ID.test(p.meta.id) && !series.has(p.meta.id)) series.set(p.meta.id, p.meta);
      const episodes = [];
      await Promise.all([...series.values()].slice(0, 80).map(async (m) => {
        try {
          const meta = await metaFor('series', m.id);
          for (const v of (meta && meta.videos) || []) {
            const day = typeof v.released === 'string' ? v.released.slice(0, 10) : '';
            if (!(v.season > 0) || day < from || day > to) continue;
            episodes.push({ kind: 'ep', series: m.id, name: m.name || meta.name, poster: m.poster || meta.poster || '', season: v.season, episode: v.episode, title: v.name || v.title || `Episode ${v.episode}`, date: day, watched: !!data.watched[`series:${v.id}`] });
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
      let j = offline.find(q.get('id'));
      if (j && j.channelId && j.status === 'done' && /\.ts$/i.test(j.file || '')) { await offline.remux(j.id); j = offline.find(j.id); }   // fix the timeline first, or seeking breaks
      if (!j || j.status !== 'done' || !j.file) throw new HttpError(404, 'That file isn\'t ready.');
      const ref = crypto.createHash('sha1').update('offline:' + j.id + ':' + path.basename(j.file)).digest('hex').slice(0, 20);
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
      if (!TITLE_ID.test(id || '') || !/^(movie|series)$/.test(type)) throw new HttpError(400, 'bad title');
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
      if (!TITLE_ID.test(id || '') || !/^(movie|series)$/.test(type)) throw new HttpError(400, 'bad title');
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
      if (!TITLE_ID.test(id || '')) throw new HttpError(400, 'bad id');
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
      if ((m = /^\/api\/stream\/([0-9a-f]{20})$/.exec(url.pathname)) && req.method === 'GET') return await proxyStream(req, res, m[1]);
      if ((m = /^\/api\/file\/([0-9a-f]{16})$/.exec(url.pathname)) && req.method === 'GET') return offline.serveFile(req, res, m[1]);
      if ((m = /^\/api\/live\/stream\/(\d+)$/.exec(url.pathname)) && req.method === 'GET') {
        const cfg = config.loadConfig();
        if (!cfg.xtreamUrl || !player.available().ffmpeg) throw new HttpError(400, player.available().ffmpeg ? 'Live TV isn\'t set up.' : 'Live TV needs ffmpeg (sudo dnf/apt install ffmpeg).');
        return await live.streamLive(res, xtream.clientFor(cfg).liveUrl(m[1]), m[1], parseInt(url.searchParams.get('a'), 10) || 0, [1080, 720, 480].includes(Number(url.searchParams.get('q'))) ? Number(url.searchParams.get('q')) : 1080);
      }
      if ((m = /^\/api\/compat\/([0-9a-f]{20})$/.exec(url.pathname)) && req.method === 'GET') return await compatStream(req, res, m[1], parseFloat(url.searchParams.get('t')) || 0, parseFloat(url.searchParams.get('a')) || 0, [1080, 720, 480].includes(Number(url.searchParams.get('q'))) ? Number(url.searchParams.get('q')) : 1080, /^[a-z]{2,3}$/.test(url.searchParams.get('al') || '') ? url.searchParams.get('al') : undefined);
      if ((m = /^\/api\/embsub\/([0-9a-f]{20})\/(\d{1,2})\.vtt$/.exec(url.pathname)) && req.method === 'GET') {
        let vtt; try { vtt = await embeddedVtt(m[1], Number(m[2])); } catch (e) { throw new HttpError(502, e.message); }
        res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(vtt);
      }
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
  let url = await resolveFinal(ref);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  const bad = (r) => r.status >= 400 || /^(text\/html|application\/json)/i.test(r.headers.get('content-type') || '');
  let up = await fetch(url, { headers, signal: ac.signal });
  if (bad(up)) {   // the link we remembered has gone stale (or never was one): ask for a fresh one once before giving up
    up.body && up.body.cancel().catch(() => {});
    resolved.delete(ref);
    url = await resolveFinal(ref, { fresh: true });
    up = await fetch(url, { headers, signal: ac.signal });
    if (bad(up)) { up.body && up.body.cancel().catch(() => {}); resolved.delete(ref); throw new HttpError(502, `The provider answered ${up.status} for this file.`); }
  }
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

module.exports = { createServer, newEpisodeCount, compatArgs };
