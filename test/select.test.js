'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStream, buildBase } = require('../src/lib/torrentio');
const { selectStreams } = require('../src/lib/select');
const { DEFAULTS } = require('../src/lib/config');
const raw = require('./fixtures');

const parsed = raw.map(parseStream).filter(Boolean);
const cfg = (o) => ({ ...DEFAULTS, nativeLanguage: 'en', ...o });

test('parseStream drops magnet-only entries and reads fields', () => {
  assert.equal(parsed.length, raw.length - 1);
  const p = parsed[0];
  assert.equal(p.resolution, '1080p');
  assert.equal(p.seeders, 120);
  assert.equal(p.cached, true);
  assert.equal(Math.round(p.size / 1e9 * 10), 82);
  assert.equal(p.source, 'bluray');
  assert.equal(p.codec, 'h264');
  assert.equal(parsed[6].resolution, '2160p');
  assert.equal(parsed[6].hdr, true);
});

test('English: one pick per resolution, no foreign/uncached/cam streams', () => {
  const { picks, hidden } = selectStreams(parsed, cfg());
  assert.deepEqual(picks.map((p) => p.resolution), ['2160p', '1080p', '720p']);
  for (const p of picks) for (const s of [p.stream, ...p.alternatives]) {
    assert.ok(!/FRENCH|GERMAN|HDCAM/.test(s.filename), s.filename);
    assert.ok(s.cached);
  }
  assert.equal(hidden.language, 2);
  assert.equal(hidden.uncached, 1);
  assert.equal(hidden.quality, 1);
  // 480p only had a German release => resolution absent entirely
  assert.ok(!picks.some((p) => p.resolution === '480p'));
});

test('multi-audio is accepted only when enabled', () => {
  const on = selectStreams(parsed, cfg()).picks.find((p) => p.resolution === '1080p');
  const all = [on.stream, ...on.alternatives].map((s) => s.filename);
  assert.ok(all.some((f) => f.includes('MULTi')));
  const off = selectStreams(parsed, cfg({ includeMultiAudio: false })).picks.find((p) => p.resolution === '1080p');
  assert.ok(![off.stream, ...off.alternatives].some((s) => s.filename.includes('MULTi')));
});

test('non-English native language picks only that language', () => {
  const { picks } = selectStreams(parsed, cfg({ nativeLanguage: 'fr', includeMultiAudio: false }));
  assert.equal(picks.length, 1);
  assert.equal(picks[0].stream.filename, 'Movie.2020.FRENCH.1080p.BluRay.x264');
  const de = selectStreams(parsed, cfg({ nativeLanguage: 'de' }));
  assert.deepEqual(de.picks.map((p) => p.resolution), ['1080p', '480p']); // 1080p via multi
});

test('HDR policy', () => {
  assert.equal(selectStreams(parsed, cfg({ hdrPolicy: 'only' })).picks.length, 1);
  assert.ok(!selectStreams(parsed, cfg({ resolutions: ['1080p'] })).picks.some((p) => p.resolution === '2160p'));
});

test('uncached streams only with allowUncached', () => {
  const { picks } = selectStreams(parsed, cfg({ allowUncached: true }));
  const p = picks.find((x) => x.resolution === '1080p');
  assert.equal(p.stream.cached, true); // cached still preferred
});

test('buildBase', () => {
  assert.throws(() => buildBase(cfg({ realDebridKey: '' })), /Real-Debrid/);
  assert.match(buildBase(cfg({ realDebridKey: 'K' })), /torrentio\.strem\.fun\/qualityfilter=scr,cam\|debridoptions=nodownloadlinks\|realdebrid=K$/);
  assert.equal(buildBase(cfg({ torrentioUrl: 'https://t.example/sort=size|realdebrid=Z/manifest.json' })), 'https://t.example/sort=size|realdebrid=Z');
  assert.equal(buildBase(cfg({ torrentioUrl: 'https://t.example', realDebridKey: 'K' })), 'https://t.example/realdebrid=K');
});
