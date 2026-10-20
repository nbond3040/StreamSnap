'use strict';
// IPTV gives MPEG-TS, which browsers can't play. ffmpeg remuxes it to fragmented MP4 on the fly: video is copied when
// it's already H.264 (transcoded otherwise), audio goes to Opus, which every Chromium build can decode.
const { spawn, execFile } = require('child_process');
const player = require('./player');

const probes = new Map();
const COPYABLE = new Set(['h264', 'vp9', 'av1']);

/** Video codec of a live URL (cached), to choose between copying and transcoding. */
function probeVideo(url, key) {
  const hit = probes.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.info);
  return new Promise((resolve) => {
    const info = { video: '', audio: '', interlaced: false, height: 0 };
    const done = () => { if (info.video || info.audio) probes.set(key, { at: Date.now(), info }); resolve(info); };
    if (!player.available().ffprobe) return done();
    execFile('ffprobe', ['-v', 'error', '-rw_timeout', '6000000', '-analyzeduration', '3000000', '-probesize', '3000000', '-print_format', 'json', '-show_streams', url],
      { timeout: 8000, maxBuffer: 2e6 }, (err, stdout) => {
        try {
          const s = JSON.parse(stdout || '{}').streams || [];
          const v = s.find((x) => x.codec_type === 'video'), a = s.find((x) => x.codec_type === 'audio');
          info.video = v ? v.codec_name : ''; info.audio = a ? a.codec_name : '';
          info.interlaced = !!v && !!v.field_order && !/progressive|unknown/.test(v.field_order);
          info.height = (v && Number(v.height)) || 0;
        } catch { /* unknown codec: transcode to be safe */ }
        done();
      });
  });
}

/**
 * @param {number} delayMs  audio offset: positive plays the sound later, negative earlier (user's A/V sync setting)
 */
function ffmpegArgs(url, info, delayMs = 0) {
  // Re-encoding is a live job, so it must run faster than real time or the picture falls behind the sound:
  // cap at 1080p and use the lightest preset for 4K/8K sources.
  const big = info.height > 1080;
  const filters = [...(info.interlaced || !info.video ? ['yadif=0:-1:1'] : []), ...(big || !info.height ? ["scale=-2:'min(1080,ih)'"] : [])];
  const video = COPYABLE.has(info.video)
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', big ? 'ultrafast' : 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', ...(filters.length ? ['-vf', filters.join(',')] : [])];
  // keep the sound locked to the stream's timestamps (fills gaps, trims overlaps), then apply the user's offset
  const d = Math.max(-5000, Math.min(5000, Math.round(delayMs) || 0));
  const afilters = ['aresample=async=1000:first_pts=0', ...(d > 0 ? [`adelay=${d}:all=1`] : d < 0 ? [`atrim=start=${(-d / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS'] : [])];
  const audio = info.audio === 'opus' && !d ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-strict', '-2', '-af', afilters.join(',')];
  return ['-v', 'error', '-fflags', '+genpts+discardcorrupt', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
    '-rw_timeout', '15000000', '-user_agent', 'StreamSnap/0.1', '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', ...video, ...audio,
    '-avoid_negative_ts', 'make_zero', '-flush_packets', '1', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1'];
}

const failures = new Map(); // channel id -> why the last attempt failed (the page asks, since a <video> can't read error bodies)
const DEADLINE = Number(process.env.STREAMSNAP_LIVE_DEADLINE) || 25000;

function reasonFrom(stderr) {
  if (/\b404\b|Not Found/i.test(stderr)) return "The provider says this channel isn't available right now.";
  if (/\b40[13]\b|Forbidden|Unauthorized/i.test(stderr)) return 'The provider refused the stream. Check your subscription, or whether you\'re at your connection limit.';
  if (/Connection refused|timed out|Network is unreachable|Name or service|Could not resolve/i.test(stderr)) return "Couldn't reach the provider.";
  return "This channel isn't broadcasting right now. Event and pay-per-view channels only work while the event is on.";
}

/**
 * Pipe one channel to the response. Nothing is sent until ffmpeg produces data, so a channel that isn't live fails with a
 * clear error within seconds instead of buffering forever. Closing the response kills ffmpeg, freeing the provider connection.
 */
async function streamLive(res, url, key, delayMs = 0) {
  const started = Date.now();
  failures.delete(key);
  let ff = null, over = false, gotData = false, stderr = '';
  const fail = (code, reason) => {
    if (over) return; over = true;
    failures.set(key, { reason, at: Date.now() });
    if (ff) ff.kill('SIGKILL');
    if (!res.headersSent) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: reason })); } else res.end();
  };
  res.on('close', () => { over = true; if (ff) ff.kill('SIGKILL'); });

  // a probe that finds nothing, or never finishes, means the channel is off air: don't make the viewer wait for it
  const info = await Promise.race([probeVideo(url, key), new Promise((r) => setTimeout(() => r(null), DEADLINE))]);
  if (over) return;
  if (!info) return fail(504, reasonFrom(''));

  ff = spawn('ffmpeg', ffmpegArgs(url, info, delayMs), { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-800); });
  const wait = info.video || !player.available().ffprobe ? DEADLINE : Math.min(DEADLINE, 12000);
  const deadline = setTimeout(() => { if (!gotData) fail(504, reasonFrom(stderr)); }, Math.max(2500, wait - (Date.now() - started)));
  ff.stdout.once('data', (first) => {
    if (over) return;
    gotData = true; clearTimeout(deadline);
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.write(first); ff.stdout.pipe(res);
  });
  ff.on('close', () => { clearTimeout(deadline); if (!gotData) fail(502, reasonFrom(stderr)); else if (!res.writableEnded) res.end(); });
  ff.on('error', () => fail(500, "Couldn't start ffmpeg."));
  res.on('close', () => clearTimeout(deadline));
}

const why = (key) => (failures.get(String(key)) || {}).reason || null;

module.exports = { streamLive, ffmpegArgs, why };
