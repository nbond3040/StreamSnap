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
    const info = { video: '', audio: '', interlaced: false };
    const done = () => { probes.set(key, { at: Date.now(), info }); resolve(info); };
    if (!player.available().ffprobe) return done();
    execFile('ffprobe', ['-v', 'error', '-analyzeduration', '4000000', '-probesize', '4000000', '-print_format', 'json', '-show_streams', url],
      { timeout: 18000, maxBuffer: 2e6 }, (err, stdout) => {
        try {
          const s = JSON.parse(stdout || '{}').streams || [];
          const v = s.find((x) => x.codec_type === 'video'), a = s.find((x) => x.codec_type === 'audio');
          info.video = v ? v.codec_name : ''; info.audio = a ? a.codec_name : '';
          info.interlaced = !!v && !!v.field_order && !/progressive|unknown/.test(v.field_order);
        } catch { /* unknown codec: transcode to be safe */ }
        done();
      });
  });
}

function ffmpegArgs(url, info) {
  const video = COPYABLE.has(info.video)
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', ...(info.interlaced || !info.video ? ['-vf', 'yadif=0:-1:1'] : [])];
  const audio = info.audio === 'opus' ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-strict', '-2'];
  return ['-v', 'error', '-fflags', '+genpts+discardcorrupt', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
    '-rw_timeout', '15000000', '-user_agent', 'StreamSnap/0.1', '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', ...video, ...audio,
    '-flush_packets', '1', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1'];
}

/** Pipe one channel to the response. Closing the response kills ffmpeg, which frees the provider connection. */
async function streamLive(res, url, key) {
  const info = await probeVideo(url, key);
  const ff = spawn('ffmpeg', ffmpegArgs(url, info), { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
  ff.on('close', () => { if (!res.writableEnded) res.end(); });
  ff.on('error', () => res.destroy());
}

module.exports = { streamLive, ffmpegArgs };
