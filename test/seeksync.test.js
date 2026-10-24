'use strict';
// Skipping or resuming in a converted (remuxed) stream must keep picture and sound together. The source has a keyframe only every
// 10 s and a different tone in every second, so any offset between what is heard and what is shown shows up as a number of seconds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compatArgs } = require('../src/server');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('after a seek the sound and the picture start at the same place', { skip: !haveFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-seek-'));
  const src = path.join(dir, 'src.mkv'), out = path.join(dir, 'out.mp4');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=24', '-f', 'lavfi', '-i',
    "aevalsrc='sin(2*PI*(500+150*mod(floor(t),20))*t)*lt(mod(t,1),0.2)':s=48000:c=stereo", '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240', '-bf', '3',
    '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k', '-f', 'matroska', src]);
  assert.equal(gen.status, 0);
  const keyframes = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', src]).stdout.toString()
    .split('\n').filter((l) => /K/.test(l)).map((l) => +l.split(',')[0]);
  const info = { video: 'h264', eightBit: true, audio: 'ac3', audioIndex: 0, height: 90 };

  // how many seconds the sound is ahead of the picture at the start of the output, from the tones and the first picture timestamp
  const measure = (t) => {
    const { args } = compatArgs(src, info, { t });
    args.splice(args.indexOf('-f'), 0, '-t', '14');          // enough to hear a beep
    args[args.length - 1] = out;
    assert.equal(spawnSync('ffmpeg', ['-y', ...args]).status, 0);
    const vs = +spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', out]).stdout.toString().split('\n')[0];
    const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-vn', '-t', '14', '-f', 'f32le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1e8 }).stdout;
    const f = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length >> 2);
    let s = f.findIndex((v) => Math.abs(v) > 0.1);
    assert.ok(s >= 0, 'sound present');
    let z = 0; const n = 960;
    for (let i = s + 200; i < s + 200 + n; i++) if ((f[i - 1] < 0) !== (f[i] < 0)) z++;
    const sec = (((Math.round((z / 2 / (n / 8000) - 500) / 150)) % 20) + 20) % 20, K = [...keyframes].reverse().find((x) => x <= t);
    let beepAt = Math.round((t - sec) / 20) * 20 + sec; while (beepAt < K - 1) beepAt += 20; while (beepAt > K + 14) beepAt -= 20;
    const heard = beepAt, shown = K + (s / 8000 - vs);
    return heard - shown;
  };
  for (const t of [37.3, 62.9, 14.2]) assert.ok(Math.abs(measure(t)) < 0.35, `at ${t}s the sound is ${measure(t).toFixed(2)} s from the picture`);
});

test('compat arguments: copied video starts on a keyframe without trimming the audio, transcoded video is cut exactly', () => {
  const copy = compatArgs('u', { video: 'h264', eightBit: true, audio: 'ac3' }, { t: 30 });
  assert.equal(copy.copyVideo, true);
  assert.ok(copy.args.includes('-noaccurate_seek'));
  assert.ok(!copy.args.join(' ').includes('first_pts'), 'trimming the audio to start at t desynchronises it from the keyframe-aligned video');
  const hevc = compatArgs('u', { video: 'hevc', audio: 'ac3', height: 2160 }, { t: 30 });
  assert.equal(hevc.copyVideo, false);
  assert.ok(!hevc.args.includes('-noaccurate_seek'));
  assert.ok(hevc.args.join(' ').includes('libx264'));
});
