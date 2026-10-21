'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selectStreams } = require('../src/lib/select');

const { DEFAULTS } = require('../src/lib/config');
const cfg = { ...DEFAULTS, nativeLanguage: 'en', resolutions: ['1080p'], allowUncached: true };
const mk = (o) => ({ ref: o.ref, resolution: '1080p', size: 4e9, seeders: 50, cached: true, source: 'web-dl', codec: 'h264', audio: 'aac', languageLine: '🇬🇧', name: 'x', filename: 'x', ...o });

test('prefers a stream that plays natively over an HEVC/DTS one', () => {
  const { picks } = selectStreams([mk({ ref: 'a', codec: 'hevc', bit10: true, audio: 'dts', seeders: 80 }), mk({ ref: 'b' })], cfg, { ffmpeg: true });
  assert.equal(picks[0].stream.ref, 'b');
  assert.ok(picks[0].alternatives[0].notes.includes('transcode'));
});

test('without ffmpeg, un-decodable audio is heavily penalised', () => {
  const { picks } = selectStreams([mk({ ref: 'a', audio: 'truehd', seeders: 500 }), mk({ ref: 'b', seeders: 5 })], cfg, { ffmpeg: false });
  assert.equal(picks[0].stream.ref, 'b');
});

test('releases whose bitrate exceeds the measured link rate lose to lighter ones', () => {
  const big = mk({ ref: 'big', size: 20e9 }), small = mk({ ref: 'small', size: 3e9, seeders: 10 });
  const { picks } = selectStreams([big, small], cfg, { ffmpeg: true, throughputKbps: 15000, runtimeMin: 110 });
  assert.equal(picks[0].stream.ref, 'small');
});
