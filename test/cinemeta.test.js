'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

test('Cinemeta retries gateway errors, then serves stale data, then reports a clear error', async (t) => {
  let hits = 0, mode = 'flaky';
  const srv = http.createServer((req, res) => {
    hits++;
    if (mode === 'down' || (mode === 'flaky' && hits <= 2)) { res.writeHead(504); return res.end(); }
    if (mode === 'missing') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ metas: [{ id: 'tt1', name: 'Found' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.STREAMSNAP_CINEMETA_URL = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const cinemeta = require('../src/lib/cinemeta');

  // two 504s, then success on the third attempt
  assert.equal((await cinemeta.catalog('movie', { search: 'x' }))[0].name, 'Found');
  assert.equal(hits, 3);

  // expire the cache entry and take the server down: the old copy is served instead of an error
  for (const e of cinemeta._cache.values()) e.at = 0;
  mode = 'down';
  assert.equal((await cinemeta.catalog('movie', { search: 'x' }))[0].name, 'Found');

  // nothing cached and the server is down: a readable error
  await assert.rejects(cinemeta.catalog('movie', { search: 'never-seen' }), /Cinemeta returned HTTP 504/);

  // 404s aren't retried
  mode = 'missing'; hits = 0;
  await assert.rejects(cinemeta.catalog('series', { search: 'gone' }), /HTTP 404/);
  assert.equal(hits, 1);
});

test('Cinemeta never caches an empty catalog page', async (t) => {
  let empty = true, hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ metas: empty ? [] : [{ id: 'tt1', name: 'Back' }] })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.STREAMSNAP_CINEMETA_URL = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  delete require.cache[require.resolve('../src/lib/cinemeta')];
  const cinemeta = require('../src/lib/cinemeta');
  assert.deepEqual(await cinemeta.catalog('series', { skip: 100 }), []);   // a transient empty answer...
  empty = false;
  assert.equal((await cinemeta.catalog('series', { skip: 100 }))[0].name, 'Back'); // ...is not remembered
  assert.equal(hits, 2);
});
