'use strict';
// Downloads (a stream saved to disk for offline viewing) and DVR (live channels recorded now or on a schedule).
// Both are listed in data.json and play back through the normal player: a finished file is registered as a stream
// that points at /api/file/:id on this server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('./config');

const PAD_BEFORE = 30 * 1000, PAD_AFTER = 2 * 60 * 1000;   // programme recordings start a little early and end a little late
const MAX_CONCURRENT_DOWNLOADS = 2;

const active = new Map();   // job id -> { abort(), kind }
const rates = new Map();    // job id -> [[t, bytes], ...]
const listeners = new Set();

function rootDir() {
  const d = config.loadConfig().downloadDir;
  return d && path.isAbsolute(d) ? d : path.join(os.homedir(), 'Videos', 'StreamSnap');
}
const sub = (name) => { const d = path.join(rootDir(), name); fs.mkdirSync(d, { recursive: true }); return d; };

const safeName = (s) => String(s || 'untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'untitled';
const newId = () => crypto.randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() { const d = config.loadData(); return { downloads: d.downloads || [], recordings: d.recordings || [] }; }
function mutate(fn) {
  const d = config.loadData();
  d.downloads = d.downloads || []; d.recordings = d.recordings || [];
  const out = fn(d);
  config.saveData(d);
  return out;
}
function patch(list, id, fields) {
  mutate((d) => { const j = d[list].find((x) => x.id === id); if (j) Object.assign(j, fields); });
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

// ---------- shared: what the browser sees ----------
function publicJob(j, kind) {
  const { src, file, ...rest } = j;
  const live = rates.get(j.id);
  let kbps = 0;
  if (live && live.length > 1) { const [t0, b0] = live[0], [t1, b1] = live[live.length - 1]; if (t1 > t0) kbps = Math.round(((b1 - b0) * 8) / (t1 - t0)); }
  let size = j.bytes || 0;
  if (live && live.length) size = live[live.length - 1][1];
  if (kind === 'rec' && j.status === 'recording' && file) { try { size = fs.statSync(file).size; } catch { /* not created yet */ } }
  return { ...rest, kind, kbps: j.status === 'downloading' ? kbps : 0, bytes: size, playable: j.status === 'done' };
}

function list() {
  const { downloads, recordings } = load();
  return {
    downloads: downloads.map((j) => publicJob(j, 'dl')),
    recordings: recordings.map((j) => publicJob(j, 'rec')),
    dir: (fs.mkdirSync(rootDir(), { recursive: true }), rootDir()), freeBytes: Number.isFinite(freeBytes(rootDir())) ? freeBytes(rootDir()) : null,
  };
}

function find(id) {
  const { downloads, recordings } = load();
  return downloads.find((j) => j.id === id) || recordings.find((j) => j.id === id) || null;
}

// ---------- downloads ----------
/** Queue a download. `src` is the stream's URL on the provider; `resolve(src)` turns it into the direct link when needed. */
function addDownload({ title, subtitle, resolution, size, meta, src, filename }) {
  const id = newId();
  const ext = (/\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i.exec(filename || '') || [, 'mkv'])[1].toLowerCase();
  const base = safeName(subtitle ? `${title} - ${subtitle}` : title);
  const file = path.join(sub('Downloads'), `${base} [${resolution}] ${id.slice(0, 4)}.${ext}`);
  const job = { id, title, subtitle: subtitle || '', resolution, total: size || 0, bytes: 0, meta: meta || {}, src, file, status: 'queued', error: '', at: Date.now() };
  mutate((d) => { d.downloads.unshift(job); });
  return publicJob(job, 'dl');
}

async function downloadOne(job, resolve) {
  const ac = new AbortController();
  active.set(job.id, { abort: () => ac.abort(), kind: 'dl' });
  patch('downloads', job.id, { status: 'downloading', error: '' });
  const part = job.file + '.part';
  try {
    let attempt = 0;
    for (;;) {
      let have = 0;
      try { have = fs.statSync(part).size; } catch { /* fresh */ }
      try {
        const url = await resolve(job.src);
        const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: ac.signal });
        if (!r.ok || !r.body) throw new Error(`The provider answered ${r.status}`);
        if (have && r.status !== 206) have = 0;                                        // server ignored Range: start over
        const total = r.status === 206 ? Number((/\/(\d+)$/.exec(r.headers.get('content-range') || '') || [])[1]) || 0 : Number(r.headers.get('content-length')) || 0;
        if (total && total !== job.total) { job.total = total; patch('downloads', job.id, { total }); }
        if (job.total && freeBytes(path.dirname(job.file)) < job.total - have + 512 * 1e6) throw Object.assign(new Error('Not enough free disk space.'), { fatal: true });
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        let got = have; rates.set(job.id, [[Date.now(), got]]);
        const body = Readable.fromWeb(r.body);
        body.on('data', (c) => {
          got += c.length; job.bytes = got;
          const s = rates.get(job.id); if (s) { const now = Date.now(); s.push([now, got]); while (s.length > 2 && now - s[0][0] > 6000) s.shift(); }
        });
        await new Promise((ok, bad) => { body.on('error', bad); out.on('error', bad); out.on('finish', ok); body.pipe(out); });
        if (job.total && got < job.total) throw new Error('The connection dropped before the file finished.');
        fs.renameSync(part, job.file);
        patch('downloads', job.id, { status: 'done', bytes: got, total: job.total || got, error: '' });
        return;
      } catch (e) {
        if (ac.signal.aborted || e.fatal || ++attempt > 4) throw e;
        await sleep(1000 * 2 ** attempt);                                             // flaky link: resume from the bytes we have
      }
    }
  } catch (e) {
    if (ac.signal.aborted) return;                                                    // paused or cancelled: whoever aborted set the state
    patch('downloads', job.id, { status: 'error', error: e.message || String(e), bytes: job.bytes || 0 });
  } finally { active.delete(job.id); rates.delete(job.id); }
}

/** Start queued downloads (never while something is streaming, so a download can't cause buffering). */
function pumpDownloads(resolve, busy) {
  const { downloads } = load();
  if (busy) {
    for (const j of downloads) if (j.status === 'downloading' && active.has(j.id)) { active.get(j.id).abort(); patch('downloads', j.id, { status: 'queued', error: '', waiting: true }); }
    return;
  }
  for (const j of downloads) if (j.status === 'downloading' && !active.has(j.id)) patch('downloads', j.id, { status: 'paused' }); // left over from a previous run
  let running = downloads.filter((j) => j.status === 'downloading' && active.has(j.id)).length;
  for (const j of downloads.slice().reverse()) {
    if (running >= MAX_CONCURRENT_DOWNLOADS) break;
    if (j.status === 'queued') { running++; downloadOne(j, resolve); }
  }
}

function pauseDownload(id) {
  const a = active.get(id); if (a) a.abort();
  patch('downloads', id, { status: 'paused', waiting: false });
}
function resumeDownload(id) { patch('downloads', id, { status: 'queued', error: '', waiting: false }); }

// ---------- DVR ----------
function schedule({ channelId, name, start, end, padded }) {
  const now = Date.now();
  if (padded) { start -= PAD_BEFORE; end += PAD_AFTER; }
  start = Math.max(start, now);
  if (!(end > start) || end - start > 12 * 3600 * 1000) throw Object.assign(new Error('That time range isn\'t valid (up to 12 hours).'), { status: 400 });
  const id = newId();
  const rec = { id, channelId: String(channelId), title: name, start, end, status: start <= now + 1000 ? 'scheduled' : 'scheduled', bytes: 0, error: '', at: now, file: '' };
  mutate((d) => { d.recordings.unshift(rec); });
  return publicJob(rec, 'rec');
}

async function recordOne(rec, liveUrl) {
  const ac = new AbortController();
  active.set(rec.id, { abort: () => ac.abort(), kind: 'rec' });
  const file = path.join(sub('Recordings'), `${safeName(rec.title)} ${new Date(Date.now()).toISOString().slice(0, 16).replace(/[T:]/g, '-')} ${rec.id.slice(0, 4)}.ts`);
  patch('recordings', rec.id, { status: 'recording', file, error: '' });
  rec.file = file;
  const out = fs.createWriteStream(file, { flags: 'a' });
  let bytes = 0, lastErr = '';
  const stopAt = setTimeout(() => ac.abort(), Math.max(1000, rec.end - Date.now()));
  try {
    while (!ac.signal.aborted && Date.now() < rec.end) {
      if (freeBytes(path.dirname(file)) < 300 * 1e6) { lastErr = 'The disk is nearly full.'; break; }
      try {
        const r = await fetch(liveUrl, { signal: ac.signal, headers: { 'user-agent': 'StreamSnap' } });
        if (!r.ok || !r.body) throw new Error(`The provider answered ${r.status}`);
        for await (const chunk of Readable.fromWeb(r.body)) { bytes += chunk.length; if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok)); }
      } catch (e) { if (!ac.signal.aborted) lastErr = e.message; }
      if (!ac.signal.aborted && Date.now() < rec.end) await sleep(2000);                // the provider dropped us: reconnect and keep appending
    }
  } finally {
    clearTimeout(stopAt);
    await new Promise((ok) => out.end(ok));
    active.delete(rec.id);
    const size = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
    const cur = (load().recordings.find((x) => x.id === rec.id) || {}).status;
    if (cur === 'cancelled') { try { fs.unlinkSync(file); } catch { /* gone */ } }
    else if (size > 1e5) patch('recordings', rec.id, { status: 'done', bytes: size, error: '', end: Math.min(rec.end, Date.now()) });
    else patch('recordings', rec.id, { status: 'error', bytes: size, error: lastErr || 'Nothing was received from the channel.' });
  }
}

/** Start whatever is due. Called every few seconds. */
function tick({ liveUrlFor }) {
  const now = Date.now();
  for (const r of load().recordings) {
    if (r.status === 'recording' && !active.has(r.id)) patch('recordings', r.id, { status: 'done' });   // the app restarted mid-recording: keep what was saved
    if (r.status !== 'scheduled') continue;
    if (r.end <= now) { patch('recordings', r.id, { status: 'error', error: 'StreamSnap wasn\'t running at the scheduled time.' }); continue; }
    if (r.start > now) continue;
    const url = liveUrlFor(r.channelId);
    if (!url) { patch('recordings', r.id, { status: 'error', error: 'Live TV isn\'t set up.' }); continue; }
    recordOne(r, url);
  }
}

function stopRecording(id) {
  patch('recordings', id, { status: 'done' });
  const a = active.get(id); if (a) a.abort();
}

// ---------- removal ----------
function remove(id) {
  const a = active.get(id); if (a) a.abort();
  const j = find(id); if (!j) return;
  const isRec = load().recordings.some((x) => x.id === id);
  if (isRec && j.status === 'recording') patch('recordings', id, { status: 'cancelled' });
  for (const f of [j.file, j.file && j.file + '.part']) { if (f) try { fs.unlinkSync(f); } catch { /* already gone */ } }
  mutate((d) => { d.downloads = d.downloads.filter((x) => x.id !== id); d.recordings = d.recordings.filter((x) => x.id !== id); });
}

/** Serve a finished file with Range support. */
function serveFile(req, res, id) {
  const j = find(id);
  const file = j && j.file && (j.status === 'done' || j.status === 'recording') ? j.file : null;
  if (!file) { res.writeHead(404); return res.end('{}'); }
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('{}'); }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, status = 200;
  if (m) {
    if (m[1] !== '') { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], end); } else if (m[2] !== '') start = Math.max(0, st.size - +m[2]);
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    status = 206;
  }
  const type = /\.mp4|\.m4v$/i.test(file) ? 'video/mp4' : /\.webm$/i.test(file) ? 'video/webm' : /\.ts$/i.test(file) ? 'video/mp2t' : 'application/octet-stream';
  const h = { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
  if (status === 206) h['content-range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(status, h);
  const rs = fs.createReadStream(file, { start, end });
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

module.exports = { list, find, addDownload, pumpDownloads, pauseDownload, resumeDownload, schedule, tick, stopRecording, remove, serveFile, rootDir, active };
