'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

test('stream links: one resolver hiccup is retried, bad placeholders are reported, stale links are refreshed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-res-'));
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=d=2:s=160x90:r=10', '-c:v', 'libvpx', '-b:v', '100k', path.join(dir, 'a.webm')]);
  const mock = spawn('node', [path.join(__dirname, 'devmock.js'), '7998'], { env: { ...process.env, MOCK_VIDEO_DIR: dir }, stdio: 'ignore' });
  t.after(() => mock.kill());
  await new Promise((r) => setTimeout(r, 700));
  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-res-home-'));
  process.env.STREAMSNAP_TORRENTIO_URL = 'http://127.0.0.1:7998';
  process.env.STREAMSNAP_CINEMETA_URL = 'http://127.0.0.1:7998';
  const { createServer } = require('../src/server');
  const app = createServer(7999);
  await new Promise((r) => app.listen(7999, '127.0.0.1', r));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = 'http://127.0.0.1:7999';
  await fetch(base + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ realDebridKey: 'KEY', verifyAudio: false, resolutions: ['1080p', '720p', '480p'] }) });
  const list = await (await fetch(`${base}/api/streams?type=movie&id=tt0000008`)).json();
  const ref = (res) => list.picks.find((p) => p.resolution === res).stream.ref;

  // 1) the resolver answers with a web page the first time: retried, then plays
  const flaky = await fetch(`${base}/api/stream/${ref('1080p')}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(flaky.status, 206); assert.equal((await flaky.arrayBuffer()).byteLength, 10);

  // 2) Torrentio's "failed" placeholder is never mistaken for the video, and the reason is readable
  const ph = await fetch(`${base}/api/stream/${ref('720p')}`);
  assert.equal(ph.status, 502);
  assert.match((await ph.json()).error, /Real-Debrid refused access/);
  const check = await (await fetch(`${base}/api/stream-check?ref=${ref('720p')}`)).json();
  assert.equal(check.ok, false); assert.match(check.reason, /refused access/);

  // 3) the first link is already expired (403): a fresh one is requested and the file plays
  const stale = await fetch(`${base}/api/stream/${ref('480p')}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(stale.status, 206); assert.equal((await stale.arrayBuffer()).byteLength, 10);
  assert.deepEqual(await (await fetch(`${base}/api/stream-check?ref=${ref('480p')}`)).json(), { ok: true });
});
