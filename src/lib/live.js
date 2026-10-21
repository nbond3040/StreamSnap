'use strict';
// IPTV gives MPEG-TS, which browsers can't play. ffmpeg remuxes it to fragmented MP4 on the fly: video is copied when
// it's already H.264 (transcoded otherwise), audio goes to Opus, which every Chromium build can decode.
const { spawn, execFile } = require('child_process');
const player = require('./player');
const health = require('./health');

const probes = new Map();   // channel -> { at, info } so a channel we've seen before starts without waiting to inspect it
const COPYABLE = new Set(['h264', 'vp9', 'av1']);
const FIRST_BYTE_MS = () => Number(process.env.STREAMSNAP_LIVE_DEADLINE) || 10000;   // how long a channel may stay silent before we call it off air

/** Work out the video/audio codec from the first bytes of the stream itself (no second connection to the provider). */
function probeBuffer(buf) {
  return new Promise((resolve) => {
    const info = { video: '', audio: '', interlaced: false, height: 0 };
    if (!player.available().ffprobe) return resolve(info);
    const ps = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; const timer = setTimeout(() => ps.kill('SIGKILL'), 8000);
    ps.stdout.on('data', (d) => { out += d; });
    ps.stdin.on('error', () => {}); ps.stdin.end(buf);
    ps.on('close', () => {
      clearTimeout(timer);
      try {
        const st = JSON.parse(out || '{}').streams || [];
        const v = st.find((x) => x.codec_type === 'video'), a = st.find((x) => x.codec_type === 'audio');
        info.video = v ? v.codec_name : ''; info.audio = a ? a.codec_name : '';
        info.interlaced = !!v && !!v.field_order && !/progressive|unknown/.test(v.field_order);
        info.height = (v && Number(v.height)) || 0;
      } catch { /* unknown codec: transcode to be safe */ }
      resolve(info);
    });
  });
}

/**
 * @param {number} delayMs  audio offset: positive plays the sound later, negative earlier (user's A/V sync setting)
 */
function ffmpegArgs(url, info, delayMs = 0, maxH = 1080) {
  // Re-encoding is a live job, so it must run faster than real time or the picture falls behind the sound:
  // cap at 1080p and use the lightest preset for 4K/8K sources.
  const big = info.height > 1080 || maxH <= 480;
  const filters = [...(info.interlaced || !info.video ? ['yadif=0:-1:1'] : []), ...(info.height > maxH || !info.height ? [`scale=-2:'min(${maxH},ih)'`] : [])];
  const video = COPYABLE.has(info.video)
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', big ? 'ultrafast' : 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', ...(filters.length ? ['-vf', filters.join(',')] : [])];
  // keep the sound locked to the stream's timestamps (fills gaps, trims overlaps), then apply the user's offset
  const d = Math.max(-5000, Math.min(5000, Math.round(delayMs) || 0));
  const afilters = ['aresample=async=1000:first_pts=0', ...(d > 0 ? [`adelay=${d}:all=1`] : d < 0 ? [`atrim=start=${(-d / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS'] : [])];
  const audio = info.audio === 'opus' && !d ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-strict', '-2', '-af', afilters.join(',')];
  const input = /^https?:/.test(url)
    ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4', '-rw_timeout', '15000000', '-user_agent', 'StreamSnap/0.1', '-i', url]
    : ['-probesize', '500000', '-analyzeduration', '1000000', '-f', 'mpegts', '-i', url];   // the server feeds the stream in itself (url is 'pipe:0')
  return ['-v', 'error', '-nostats', '-progress', 'pipe:2', '-fflags', '+genpts+discardcorrupt', ...input, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', ...video, ...audio,
    '-avoid_negative_ts', 'make_zero', '-flush_packets', '1', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1'];
}

const failures = new Map(); // channel id -> why the last attempt failed (the page asks, since a <video> can't read error bodies)

function reasonFrom(text) {
  if (/\b404\b|Not Found/i.test(text)) return "The provider says this channel isn't available right now.";
  if (/\b40[13]\b|\b429\b|Forbidden|Unauthorized|Too Many/i.test(text)) return 'The provider refused the stream. Check your subscription, or whether you\'re at your connection limit.';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|Connection refused|timed out|Network is unreachable|Could not resolve|fetch failed/i.test(text)) return "Couldn't reach the provider.";
  return "This channel isn't broadcasting right now. Event and pay-per-view channels only work while the event is on.";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pipe one channel to the response.
 * The server downloads the stream itself and feeds ffmpeg, so it knows exactly what the provider is sending: a channel
 * that sends nothing is off air (reported within seconds), one that sends slowly is the provider's problem (and measured
 * as such), and the whole thing uses a single connection to the provider. Closing the response ends everything.
 */
async function streamLive(res, url, key, delayMs = 0, maxH = 1080) {
  failures.delete(key);
  const ac = new AbortController();
  let ff = null, over = false, gotData = false;
  const entry = health.track(`live:${key}`, { kind: 'live', mode: 'copy' });
  const errText = () => entry.errors;
  const fail = (code, reason) => {
    if (over) return; over = true;
    failures.set(key, { reason, at: Date.now() });
    ac.abort(); if (ff) ff.kill('SIGKILL'); health.untrack(entry);
    if (!res.headersSent) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: reason })); } else res.end();
  };
  res.on('close', () => { over = true; ac.abort(); if (ff) ff.kill('SIGKILL'); health.untrack(entry); });

  let silent = false;   // true when we gave up because the provider said nothing at all
  const connect = async () => {
    const timer = setTimeout(() => { silent = true; ac.abort(); }, FIRST_BYTE_MS());
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'StreamSnap/0.1' } });
      clearTimeout(timer);
      return r;
    } catch (e) { clearTimeout(timer); throw e; }
  };

  let resp;
  try { resp = await connect(); }
  catch (e) { return silent ? fail(504, reasonFrom('')) : fail(502, over ? '' : reasonFrom(String(e.cause?.code || e.message))); }
  if (!resp.ok) return fail(502, reasonFrom(String(resp.status)));

  // 1) read the opening bytes: enough to see what's inside, but never wait long on a slow provider
  let reader = resp.body.getReader();
  const head = []; let size = 0; const t0 = Date.now(); const cached = probes.get(key);
  const known = cached && Date.now() - cached.at < 10 * 60 * 1000;
  const readOne = async () => {
    const r = await Promise.race([reader.read(), sleep(FIRST_BYTE_MS()).then(() => ({ timeout: true }))]);
    if (r.timeout) throw new Error('silent');
    return r;
  };
  try {
    while (!over) {
      const r = await readOne();
      if (r.done) break;
      head.push(Buffer.from(r.value)); size += r.value.length; health.countIn(entry, r.value.length);
      const waited = Date.now() - t0;
      if (known || size >= 1_200_000 || (waited >= 3500 && size >= 64_000) || waited >= 12_000) break;
    }
  } catch { return fail(504, "This channel isn't broadcasting right now. Event and pay-per-view channels only work while the event is on."); }
  if (over) return;
  if (!size) return fail(504, reasonFrom(''));

  const info = known ? cached.info : await probeBuffer(Buffer.concat(head));
  if (over) return;
  if (!known && (info.video || info.audio)) probes.set(key, { at: Date.now(), info });
  entry.mode = COPYABLE.has(info.video) ? 'copy' : 'transcode';

  // 2) hand everything to ffmpeg, then keep feeding it as the provider delivers
  ff = spawn('ffmpeg', ffmpegArgs('pipe:0', info, delayMs, maxH), { stdio: ['pipe', 'pipe', 'pipe'] });
  health.watchFfmpeg(entry, ff);
  ff.stdin.on('error', () => {});
  const deadline = setTimeout(() => { if (!gotData) fail(504, "This channel's video couldn't be read. It may use a format StreamSnap can't convert."); }, 25000);
  ff.stdout.once('data', (first) => {
    if (over) return;
    gotData = true; clearTimeout(deadline);
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.write(first); ff.stdout.pipe(res);
  });
  ff.on('close', () => { clearTimeout(deadline); if (!gotData) fail(502, reasonFrom(errText())); else if (!res.writableEnded) res.end(); });
  ff.on('error', () => fail(500, "Couldn't start ffmpeg."));

  const write = async (buf) => { if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r)); };
  (async () => {
    try {
      for (const c of head) await write(c);
      let retries = 0;
      while (!over) {
        let r;
        try { r = await reader.read(); } catch { r = { done: true, error: true }; }
        if (r.done) {                      // the provider closed or dropped the connection: reconnect a few times
          if (over || ++retries > 3) break;
          await sleep(800 * retries);
          try { resp = await connect(); if (!resp.ok) break; reader = resp.body.getReader(); } catch { break; }
          continue;
        }
        retries = 0;
        health.countIn(entry, r.value.length);
        await write(Buffer.from(r.value));
      }
    } catch { /* ffmpeg went away */ }
    try { ff.stdin.end(); } catch { /* already closed */ }
  })();
}

const why = (key) => (failures.get(String(key)) || {}).reason || null;

module.exports = { streamLive, ffmpegArgs, why };
