'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('anime: catalog, dub/sub availability, per-kind stream picks, audio-track choice and embedded subtitles', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-anime-'));
  fs.writeFileSync(path.join(dir, 'eng.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello from the subtitles\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond line\n');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=d=5:s=160x90:r=24', '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-f', 'lavfi', '-i', 'sine=f=880:d=5', '-i', path.join(dir, 'eng.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=eng', path.join(dir, 'anime.mkv')]);
  assert.equal(gen.status, 0, String(gen.stderr));
  const mock = spawn('node', [path.join(__dirname, 'devmock.js'), '7961'], { env: { ...process.env, MOCK_VIDEO_DIR: dir }, stdio: 'ignore' });
  t.after(() => mock.kill());
  await new Promise((r) => setTimeout(r, 700));
  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-anime-home-'));
  for (const k of ['KITSU', 'KITSU_API', 'TORRENTIO', 'CINEMETA']) process.env[`STREAMSNAP_${k}_URL`] = 'http://127.0.0.1:7961';
  const { createServer } = require('../src/server');
  const app = createServer(7962);
  await new Promise((r) => app.listen(7962, '127.0.0.1', r));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = 'http://127.0.0.1:7962';
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const get = async (p) => (await fetch(base + p)).json();
  await post('/api/config', { realDebridKey: 'KEY', verifyAudio: false });

  // catalog
  const cat = await get('/api/anime/catalog?kind=trending');
  assert.equal(cat.length, 6); assert.ok(cat.every((m) => m.anime && /^kitsu:\d+$/.test(m.id)));
  assert.equal(cat.find((m) => m.id === 'kitsu:6').type, 'movie');
  assert.deepEqual((await get('/api/anime/catalog?q=Anime%203')).map((m) => m.id), ['kitsu:3']);
  assert.equal((await get('/api/anime/catalog?kind=airing')).length, 3);

  // which titles have a sub and/or a dub
  const audio = await get('/api/anime/audio?ids=kitsu:1,kitsu:2,kitsu:3,kitsu:4,kitsu:5,kitsu:6');
  assert.deepEqual(audio, { 'kitsu:1': { sub: true, dub: true }, 'kitsu:2': { sub: true, dub: false }, 'kitsu:3': { sub: false, dub: true }, 'kitsu:4': { sub: false, dub: false }, 'kitsu:5': { sub: true, dub: true }, 'kitsu:6': { sub: true, dub: true } });

  // seasons are one franchise: 1 -> 2 -> 3 (+ the film); 4 and 5 stand alone
  const groups = await get('/api/anime/groups?ids=kitsu:1,kitsu:2,kitsu:3,kitsu:4,kitsu:6');
  assert.deepEqual(['kitsu:1', 'kitsu:2', 'kitsu:3', 'kitsu:6'].map((id) => groups[id].root), ['kitsu:1', 'kitsu:1', 'kitsu:1', 'kitsu:1']);
  assert.equal(groups['kitsu:4'], null);
  assert.equal(groups['kitsu:2'].seasons, 3); assert.equal(groups['kitsu:2'].season, 2); assert.equal(groups['kitsu:2'].isRoot, false);
  assert.equal(groups['kitsu:1'].isRoot, true); assert.equal(groups['kitsu:3'].season, 3); assert.equal(groups['kitsu:6'].season, 0);
  assert.equal(groups['kitsu:3'].rootInfo.name, 'Mock Anime');
  const fr = await get('/api/anime/franchise?id=kitsu:3');
  assert.deepEqual(fr.members.map((m) => [m.id, m.season]), [['kitsu:1', 1], ['kitsu:2', 2], ['kitsu:3', 3], ['kitsu:6', 0]]);   // the film is related, not a season
  assert.equal(fr.current, 'kitsu:3');
  assert.deepEqual((await get('/api/anime/franchise?id=kitsu:5')).members, []);

  // meta
  const m1 = await get('/api/meta?type=series&id=kitsu:1');
  assert.equal(m1.type, 'series'); assert.equal(m1.videos.length, 4); assert.equal(m1.videos[1].id, 'kitsu:1:2');
  assert.equal((await get('/api/meta?type=series&id=kitsu:6')).type, 'movie');

  // streams per kind
  const sub = await get('/api/streams?type=series&id=kitsu:1:1');
  assert.equal(sub.anime.kind, 'sub'); assert.deepEqual(sub.anime.available, { sub: true, dub: true });
  assert.ok(sub.picks.every((p) => /SubsPlease/.test(p.stream.filename)));
  assert.ok(sub.anime.variants.dub.every((p) => /Dub/.test(p.stream.filename)));
  assert.equal((await get('/api/streams?type=series&id=kitsu:1:1&audio=dub')).anime.kind, 'dub');
  const only = await get('/api/streams?type=series&id=kitsu:3:1');                       // only a dub exists: fall back to it, and say so
  assert.equal(only.anime.kind, 'dub'); assert.equal(only.anime.fallback, true);
  const dual = await get('/api/streams?type=series&id=kitsu:5:1&audio=dub');
  assert.equal(dual.anime.kind, 'dub'); assert.equal(dual.picks[0].stream.ref, dual.anime.variants.sub[0].stream.ref);   // one file serves both
  assert.equal((await fetch(`${base}/api/streams?type=series&id=kitsu:xyz`)).status, 400);

  // a dual-audio file: Japanese track for sub, English for dub; embedded English subtitles
  const ref = dual.picks[0].stream.ref;
  const ja = await get(`/api/probe?ref=${ref}&al=ja`), en = await get(`/api/probe?ref=${ref}&al=en`);
  assert.equal(ja.audioIndex, 0); assert.equal(en.audioIndex, 1); assert.equal(en.mode, 'compat');
  assert.equal(ja.subTracks.length, 1); assert.equal(ja.subTracks[0].lang, 'eng');
  const vtt = await (await fetch(`${base}/api/embsub/${ref}/0.vtt`)).text();
  assert.ok(vtt.startsWith('WEBVTT') && vtt.includes('Hello from the subtitles'), vtt.slice(0, 80));

  // the library and watch history accept Kitsu ids
  assert.equal((await post('/api/library/add', { id: 'kitsu:1', type: 'series', name: 'Mock Anime 1', poster: '', genres: [] })).status, 200);
  assert.equal((await get('/api/library')).library[0].id, 'kitsu:1');
});
