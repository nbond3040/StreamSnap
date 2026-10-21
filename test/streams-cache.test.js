'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('Torrentio lists are cached, shared between simultaneous callers, and survive a failing refresh', async (t) => {
  let hits = 0, fail = false;
  const srv = http.createServer((req, res) => {
    hits++;
    if (fail) { res.writeHead(500); return res.end(); }
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ streams: [{ name: '[RD+] Torrentio\n1080p', title: 'A.1080p\n👤 5 💾 2 GB ⚙️ X', url: 'http://x/resolve/a' }] })); }, 80);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const torrentio = require('../src/lib/torrentio');
  const cfg = { torrentioUrl: `http://127.0.0.1:${srv.address().port}/cfg`, realDebridKey: '' };
  const [a, b] = await Promise.all([torrentio.fetchStreams(cfg, 'movie', 'tt1'), torrentio.fetchStreams(cfg, 'movie', 'tt1')]);
  assert.equal(hits, 1, 'two simultaneous callers share one request');
  assert.equal(a.length, 1); assert.equal(b[0].resolution, '1080p');
  await torrentio.fetchStreams(cfg, 'movie', 'tt1');
  assert.equal(hits, 1, 'a repeat inside two minutes is served from memory');
  // age the entry past "fresh" and make the provider fail: the old list is better than an error
  for (const e of torrentio._cache.values()) e.at = Date.now() - 5 * 60 * 1000;
  fail = true;
  assert.equal((await torrentio.fetchStreams(cfg, 'movie', 'tt1')).length, 1);
  await assert.rejects(torrentio.fetchStreams(cfg, 'movie', 'tt-never-seen'), /HTTP 500/);
});

test('the release inspection cache remembers files across restarts', async () => {
  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-pc-'));
  for (const m of ['../src/lib/config', '../src/lib/probecache']) delete require.cache[require.resolve(m)];
  const pc = require('../src/lib/probecache');
  const s = { filename: 'Movie.2020.1080p.mkv', size: 8e9 };
  assert.equal(pc.get(s), null);
  pc.set(s, { probed: true, duration: 7200, audioTracks: [{ codec: 'ac3', lang: 'eng' }] });
  pc.set({ filename: 'unknown size', size: 0 }, { probed: true });          // no identity: not stored
  assert.equal(pc.get(s).duration, 7200);
  await new Promise((r) => setTimeout(r, 2300));                             // the write is debounced
  pc.reset();                                                                // a "restart"
  assert.deepEqual(pc.get(s).audioTracks, [{ codec: 'ac3', lang: 'eng' }]);
  assert.equal(pc.get({ filename: 'unknown size', size: 0 }), null);
  assert.equal(pc.get({ filename: 'Movie.2020.1080p.mkv', size: 7e9 }), null, 'a different size is a different release');
});
