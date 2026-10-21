'use strict';
// Stream health: tells apart "the provider isn't sending data fast enough" from "this computer can't keep up".
//  - copy / direct streams are limited only by the provider (nothing here is slower than the network)
//  - transcode streams are limited by whichever is slower: the provider or the CPU running ffmpeg
const fs = require('fs');
const os = require('os');

const streams = new Map();            // key -> entry, for streams that are running right now
const TICK = 100;                     // Linux clock ticks per second (USER_HZ)
const PROGRESS = /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time(_us|_ms)?|dup_frames|drop_frames|speed|progress)=/;

function cpuTicks(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);   // utime + stime
  } catch { return null; }
}

/** Start tracking a stream. mode: 'copy' | 'transcode' | 'direct'. */
function track(key, { kind, mode, needKbps = 0 }) {
  const e = { key, kind, mode, needKbps, startedAt: Date.now(), speed: null, cpuPct: null, inBytes: 0, samples: [], errors: '', stop: null };
  streams.set(key, e);
  return e;
}

function untrack(e) { if (streams.get(e.key) === e) streams.delete(e.key); if (e.stop) e.stop(); }

/** Watch an ffmpeg child: parse -progress lines from stderr (keeping real errors apart) and sample its CPU use. */
function watchFfmpeg(e, ff) {
  let buf = '';
  ff.stderr.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const m = /^speed=\s*([\d.]+)x/.exec(line);
      if (m) e.speed = parseFloat(m[1]);
      else if (line && !PROGRESS.test(line)) e.errors = (e.errors + line + '\n').slice(-800);
    }
  });
  let prev = null;
  const timer = setInterval(() => {
    const t = cpuTicks(ff.pid), now = Date.now();
    if (t != null && prev) e.cpuPct = ((t - prev.t) / TICK) / ((now - prev.at) / 1000) * 100;
    if (t != null) prev = { t, at: now };
  }, 2000);
  e.stop = () => clearInterval(timer);
  ff.on('close', () => untrack(e));
}

/** Count bytes arriving from the provider on a direct (proxied) stream. */
function countIn(e, n) {
  const now = Date.now();
  e.inBytes += n;
  e.samples.push([now, e.inBytes]);
  while (e.samples.length > 2 && now - e.samples[0][0] > 8000) e.samples.shift();
}
function inKbps(e) {
  if (e.samples.length < 2) return null;
  const [t0, b0] = e.samples[0], [t1, b1] = e.samples[e.samples.length - 1];
  return t1 > t0 ? ((b1 - b0) * 8) / (t1 - t0) : null;   // bytes*8 / ms == kbit/s
}

/** 'ok' | 'provider' | 'local' | 'unknown' */
function verdict(e, cores = os.cpus().length, load = os.loadavg()[0]) {
  if (Date.now() - e.startedAt < 5000) return 'unknown';
  if (e.mode === 'direct') {
    const k = inKbps(e);
    return e.needKbps && k != null && k < e.needKbps * 1.1 ? 'provider' : 'ok';
  }
  if (e.speed == null || e.speed >= 0.97) return 'ok';
  if (e.mode === 'copy') return 'provider';           // nothing to compute, so slow output means slow input
  const busy = (e.cpuPct || 0) >= Math.min(160, cores * 60) || load / cores > 0.9;
  return busy ? 'local' : 'provider';
}

const TEXT = {
  ok: '',
  unknown: '',
  provider: 'Your provider isn’t sending this stream fast enough right now. Nothing in StreamSnap or on your computer is slowing it down.',
  local: 'Your computer is too busy converting this stream. StreamSnap will lower the quality automatically.',
};

function snapshot(key) {
  const e = streams.get(key);
  if (!e) return { active: false, verdict: 'unknown', text: '' };
  const v = verdict(e);
  return { active: true, mode: e.mode, kind: e.kind, speed: e.speed, cpuPct: e.cpuPct == null ? null : Math.round(e.cpuPct), inKbps: inKbps(e) == null ? null : Math.round(inKbps(e)), needKbps: e.needKbps || null, verdict: v, text: TEXT[v] };
}

const active = () => streams.size;
const entry = (key) => streams.get(key) || null;

module.exports = { track, untrack, entry, watchFfmpeg, countIn, inKbps, verdict, snapshot, active, PROGRESS };
