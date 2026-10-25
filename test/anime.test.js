'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, forKind, availability, isKitsuId } = require('../src/lib/anime');

const rel = (filename, languageLine = '') => ({ name: '[RD+] Torrentio 1080p', filename, languageLine });

test('releases are read as sub, dub or dual audio from their names', () => {
  assert.equal(classify(rel('[SubsPlease] Frieren - 05 (1080p) [ABC123].mkv')).kind, 'sub');
  assert.equal(classify(rel('[Erai-raws] Frieren - 05 [1080p][Multiple Subtitle].mkv', 'Multi Subs')).kind, 'sub');
  assert.equal(classify(rel('Frieren.S01E05.1080p.WEB.English.Dub.mkv')).kind, 'dub');
  assert.equal(classify(rel('Frieren - 05 (BD 1080p Dual Audio) [Judas].mkv')).kind, 'dual');
  assert.equal(classify(rel('[Group] Show - 03 (Dubbed) [720p].mkv')).kind, 'dub');
  assert.deepEqual([classify(rel('Show Dual-Audio 1080p.mkv')).canSub, classify(rel('Show Dual-Audio 1080p.mkv')).canDub], [true, true]);
  assert.equal(classify(rel('[Raws] Show - 05 [1080p].mkv')).canSub, false);          // no subtitles
  assert.equal(classify(rel('[Raws] Show - 05 [1080p] eng subs.mkv')).canSub, true);
});

test('filtering by kind keeps what can be played that way', () => {
  const list = [rel('[SubsPlease] A - 01.mkv'), rel('A (English Dub) 01.mkv'), rel('A Dual Audio 01.mkv')];
  assert.deepEqual(forKind(list, 'sub').map((s) => s.filename), ['[SubsPlease] A - 01.mkv', 'A Dual Audio 01.mkv']);
  assert.deepEqual(forKind(list, 'dub').map((s) => s.filename), ['A (English Dub) 01.mkv', 'A Dual Audio 01.mkv']);
  assert.deepEqual(availability(list.slice(0, 1)), { sub: true, dub: false });
  assert.deepEqual(availability(list.slice(1, 2)), { sub: false, dub: true });
  assert.deepEqual(availability([]), { sub: false, dub: false });
});

test('Kitsu ids', () => {
  assert.ok(isKitsuId('kitsu:1234') && isKitsuId('kitsu:1234:7'));
  assert.ok(!isKitsuId('tt0000001') && !isKitsuId('kitsu:') && !isKitsuId('kitsu:12:x') && !isKitsuId(undefined));
});
