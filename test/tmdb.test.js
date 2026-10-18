'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

test('TMDB collection lookup maps parts to IMDb ids, sorted by release date', async (t) => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/3/find/tt1') return json({ movie_results: [{ id: 10 }] });
    if (u.pathname === '/3/find/tt9') return json({ movie_results: [{ id: 99 }] });
    if (u.pathname === '/3/movie/10') return json({ belongs_to_collection: { id: 5, name: 'Saga' } });
    if (u.pathname === '/3/movie/99') return json({ belongs_to_collection: null });
    if (u.pathname === '/3/collection/5') return json({ name: 'Saga', parts: [{ id: 12, title: 'Three', release_date: '2020-01-01' }, { id: 10, title: 'One', release_date: '2010-01-01', poster_path: '/p.jpg' }, { id: 11, title: 'Two', release_date: '2015-01-01' }, { id: 13, title: 'No IMDb', release_date: '2021-01-01' }] });
    const ext = /^\/3\/movie\/(\d+)\/external_ids$/.exec(u.pathname);
    if (ext) return ext[1] === '13' ? json({ imdb_id: null }) : json({ imdb_id: 'tt' + ext[1] });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.STREAMSNAP_TMDB_URL = `http://127.0.0.1:${srv.address().port}/3`;
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const { collectionFor } = require('../src/lib/tmdb');

  const c = await collectionFor('tt1', 'a'.repeat(32));
  assert.equal(c.name, 'Saga');
  assert.deepEqual(c.parts.map((p) => p.name), ['One', 'Two', 'Three']);       // dated order, unlinkable part dropped
  assert.deepEqual(c.parts.map((p) => p.id), ['tt1', 'tt11', 'tt12']);
  assert.equal(c.parts[0].poster, 'https://image.tmdb.org/t/p/w342/p.jpg');
  assert.ok(seen.every((u) => u.includes('api_key=')), 'v3 keys go in the query string');

  assert.equal(await collectionFor('tt9', 'a'.repeat(32)), null);               // standalone film
  await assert.rejects(collectionFor('bad', 'k'), /invalid id/);
});
