'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { decodeText, normalizeBase } = require('../src/lib/xtream');

test('Xtream helpers', () => {
  assert.equal(normalizeBase('host:8080/'), 'http://host:8080');
  assert.equal(normalizeBase('https://h.example/player_api.php?username=a'), 'https://h.example');
  assert.throws(() => normalizeBase(''), /server URL/);
  assert.equal(decodeText(Buffer.from('Évening News').toString('base64')), 'Évening News');
  assert.equal(decodeText('News'), 'News'); // plain text that happens to look like base64
  assert.equal(decodeText('Plain title with spaces'), 'Plain title with spaces');
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('Live TV end to end against a mock Xtream server', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-live-'));
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=d=6:s=320x180:r=25', '-f', 'lavfi', '-i', 'sine=f=500:d=6', '-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'mpegts', path.join(dir, 'live.ts')]);
  const mock = spawn('node', [path.join(__dirname, 'devmock.js'), '7991'], { env: { ...process.env, MOCK_VIDEO_DIR: dir }, stdio: 'ignore' });
  process.env.STREAMSNAP_LIVE_DEADLINE = '4000';
  t.after(() => mock.kill());
  await new Promise((r) => setTimeout(r, 700));

  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-home-'));
  const { createServer } = require('../src/server');
  const port = 7992, app = createServer(port);
  await new Promise((r) => app.listen(port, '127.0.0.1', r));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  assert.deepEqual(await (await fetch(base + '/api/live/browse')).json(), { configured: false });
  assert.equal((await post('/api/live/test', { url: '127.0.0.1:7991', user: 'u', pass: 'wrong' })).status, 400);
  const ok = await (await post('/api/live/test', { url: '127.0.0.1:7991', user: 'u', pass: 'p' })).json();
  assert.equal(ok.status, 'Active'); assert.equal(ok.maxConnections, 2);

  const cfg = await (await post('/api/config', { xtreamUrl: '127.0.0.1:7991', xtreamUser: 'u', xtreamPass: 'p' })).json();
  assert.equal(cfg.xtreamPass, undefined); assert.equal(cfg.hasXtreamPass, true);   // the password never leaves the server
  await post('/api/config', { xtreamPass: '' });                                    // blank keeps it
  assert.equal((await (await fetch(base + '/api/config')).json()).hasXtreamPass, true);

  const b = await (await fetch(base + '/api/live/browse')).json();
  assert.equal(b.channels.length, 16); assert.deepEqual(b.categories.map((c) => c.name), ['US| NEWS NETWORK', 'US| SPORTS NETWORK', 'UK| MOVIES', 'WORLD LIVE SPORTS']);
  assert.deepEqual((await (await post('/api/live/hide', { ids: ['4', 'x'], hide: true })).json()).hidden, ['4']);
  assert.deepEqual((await (await fetch(base + '/api/live/browse')).json()).hidden, ['4']);
  assert.deepEqual((await (await post('/api/live/hide', { ids: ['4'], hide: false })).json()).hidden, []);
  const epg = await (await fetch(base + '/api/live/epg?ids=101,102')).json();
  assert.equal(epg[101][0].title, 'Morning Show 101'); assert.equal(epg[102].length, 3);
  assert.ok(epg[101][0].start < Date.now() && epg[101][0].end > Date.now(), 'first programme is on now');

  assert.deepEqual((await (await post('/api/live/favorite', { id: 103 })).json()).favorites, [103]);
  assert.deepEqual((await (await post('/api/live/favorite', { id: 103 })).json()).favorites, []);

  // a channel that isn't live fails with a clear message instead of buffering forever
  const gone = await fetch(base + '/api/live/stream/116');
  assert.equal(gone.status, 502); assert.match((await gone.json()).error, /isn't available/);
  const quiet = await fetch(base + '/api/live/stream/115');         // connects but never sends data
  assert.equal(quiet.status, 504); assert.match((await quiet.json()).error, /isn't broadcasting/);
  assert.match((await (await fetch(base + '/api/live/why?id=115')).json()).reason, /isn't broadcasting/);

  // the stream: MPEG-2/MP2 in, browser-playable fragmented MP4 (H.264 + Opus) out
  const res = await fetch(base + '/api/live/stream/101');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const chunks = []; let size = 0;
  for await (const c of res.body) { chunks.push(c); size += c.length; if (size > 150000) break; }
  const out = path.join(dir, 'out.mp4'); fs.writeFileSync(out, Buffer.concat(chunks));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).stdout.toString();
  assert.match(probe, /h264/); assert.match(probe, /opus/);
});
