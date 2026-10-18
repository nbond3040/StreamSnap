'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raw = require('./fixtures');

test('end to end against mock Torrentio/Cinemeta', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  process.env.STREAMSNAP_HOME = home;
  const mock = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/torrentio/') && !req.url.includes('/resolve/')) {
      assert.match(req.url, /^\/torrentio\/qualityfilter=scr,cam\|debridoptions=nodownloadlinks\|realdebrid=SECRET\/stream\/movie\/tt0000001\.json$/);
      return send({ streams: raw.map((s) => ({ ...s, url: s.url && s.url.replace('https://torrentio.test', `http://127.0.0.1:${mock.address().port}/torrentio`) })) });
    }
    if (req.url.includes('/resolve/')) { res.writeHead(302, { location: `http://127.0.0.1:${mock.address().port}/video.mp4` }); return res.end(); }
    if (req.url === '/video.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end('VIDEODATA'); }
    if (req.url.startsWith('/catalog/movie/top')) return send({ metas: [{ id: 'tt0000001', type: 'movie', name: 'Mock' }] });
    if (req.url.startsWith('/meta/movie/tt0000001')) return send({ meta: { imdb_id: 'tt0000001', name: 'Mock' } });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  process.env.STREAMSNAP_CINEMETA_URL = `http://127.0.0.1:${mp}`;
  process.env.STREAMSNAP_TORRENTIO_URL = `http://127.0.0.1:${mp}/torrentio`;
  const { createServer } = require('../src/server');
  const app = createServer(0);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const port = app.address().port;
  // host allow-list is port-specific, so rebuild with the real port
  app.close();
  const real = createServer(port);
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  t.after(() => { real.closeAllConnections(); real.close(); mock.closeAllConnections(); mock.close(); });
  const base = `http://127.0.0.1:${port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  let r = await fetch(base + '/api/streams?type=movie&id=tt0000001');
  assert.equal(r.status, 502); // no key yet
  r = await post('/api/config', { realDebridKey: 'SECRET', nativeLanguage: 'en', player: 'browser' });
  const cfg = await r.json();
  assert.equal(cfg.realDebridKey, undefined);
  assert.equal(cfg.hasRealDebridKey, true);
  assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);

  const res = await (await fetch(base + '/api/streams?type=movie&id=tt0000001')).json();
  assert.deepEqual(res.picks.map((p) => p.resolution), ['2160p', '1080p', '720p']);
  assert.ok(!JSON.stringify(res).includes('SECRET'));

  const ref = res.picks[0].stream.ref;
  const vid = await fetch(`${base}/api/stream/${ref}`);
  assert.equal(await vid.text(), 'VIDEODATA'); // followed Torrentio's 302 through the proxy

  await post('/api/progress', { key: 'movie:tt0000001', pos: 100, dur: 1000, meta: { type: 'movie', id: 'tt0000001', name: 'Mock' } });
  const lib = await (await fetch(base + '/api/library')).json();
  assert.equal(lib.continueWatching.length, 1);
  assert.deepEqual(await (await fetch(base + '/api/resume?key=movie:tt0000001')).json(), { pos: 100, stream: null });

  // security: bad Host and cross-origin POST are rejected
  const evil = await fetch(base + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);
  assert.equal((await fetch(base + '/')).status, 200);
});
