'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const nba = require('../src/lib/nba');

const ev = (id, date, state, hs, as, extra = {}) => ({
  id, date, status: { type: { state, shortDetail: state === 'post' ? 'Final' : state === 'in' ? 'Q3 4:12' : '7:30 PM ET', description: extra.desc || '' } },
  competitions: [{ venue: { fullName: 'TD Garden' }, broadcasts: [{ names: ['ESPN', 'NBA TV'] }], competitors: [
    { homeAway: 'home', score: String(hs), winner: hs > as, team: { id: '2', abbreviation: 'BOS', displayName: 'Boston Celtics', shortDisplayName: 'Celtics', logo: 'https://x/bos.png' }, records: [{ summary: '5-1' }] },
    { homeAway: 'away', score: String(as), team: { id: '13', abbreviation: 'LAL', displayName: 'Los Angeles Lakers', shortDisplayName: 'Lakers', logo: 'https://x/lal.png' }, records: [{ summary: '4-2' }] }] }],
});

test('ESPN events are normalised', () => {
  const g = nba.normalize(ev('401', '2026-10-22T23:30Z', 'in', 55, 50));
  assert.equal(g.state, 'live');
  assert.equal(g.home.abbr, 'BOS'); assert.equal(g.away.score, 50); assert.equal(g.detail, 'Q3 4:12');
  assert.deepEqual(g.broadcasts, ['ESPN', 'NBA TV']);
  assert.equal(nba.normalize({ id: 'x' }), null);
  assert.equal(nba.normalize(ev('1', '2026-10-22T23:30Z', 'post', 100, 90)).state, 'final');
  assert.equal(nba.normalize(ev('1', '2026-10-22T23:30Z', 'pre', 0, 0, { desc: 'Postponed' })).postponed, true);
});

test('the schedule is fetched once per range and cached', async () => {
  let hits = 0, url = '';
  const srv = http.createServer((req, res) => { hits++; url = req.url; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ events: [ev('2', '2026-10-23T00:00Z', 'pre', 0, 0), ev('1', '2026-10-22T23:30Z', 'post', 100, 90)] })); }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  process.env.STREAMSNAP_NBA_URL = `http://127.0.0.1:${srv.address().port}`;
  nba._cache.clear();
  const a = await nba.fetchRange(Date.UTC(2026, 9, 22), Date.UTC(2026, 9, 30));
  const b = await nba.fetchRange(Date.UTC(2026, 9, 22), Date.UTC(2026, 9, 30));
  assert.equal(hits, 1); assert.equal(a, b);
  assert.deepEqual(a.map((g) => g.id), ['1', '2']);   // sorted by tip-off
  assert.match(url, /dates=20261022-20261030/);
  srv.close(); delete process.env.STREAMSNAP_NBA_URL;
});

const game = nba.normalize(ev('401', '2026-10-22T23:30Z', 'pre', 0, 0));
const ch = (id, name) => ({ id, num: id, name, logo: '' });

test('the highest-quality channel carrying the game ranks first', () => {
  const list = [ch(1, 'US| ESPN HD'), ch(2, 'US| ESPN FHD'), ch(3, 'US| ESPN 4K'), ch(4, 'US| ESPN SD'), ch(5, 'US| ESPN2 FHD'), ch(6, 'US| CNN HD'), ch(7, 'ES| ESPN Deportes FHD'), ch(8, 'US| TNT HD')];
  const r = nba.matchChannels(game, list);
  assert.deepEqual(r.map((c) => c.id).slice(0, 4), [3, 2, 1, 4]);
  assert.ok(!r.some((c) => c.id === 5 || c.id === 6 || c.id === 8), 'ESPN2, CNN and TNT do not carry this game');
  assert.equal(r[0].quality, '4K');
  assert.match(r[0].why, /ESPN/);
});

test('a per-game channel named after the teams beats a network channel', () => {
  const r = nba.matchChannels(game, [ch(1, 'US| ESPN 4K'), ch(2, 'NBA 03 | Lakers vs Celtics HD'), ch(3, 'NBA LEAGUE PASS 1 FHD')]);
  assert.equal(r[0].id, 2);
  assert.equal(r[0].why, 'Channel for this game');
  assert.ok(r.some((c) => c.id === 3));
});

test('the programme guide confirms and promotes a channel', async () => {
  const cands = nba.matchChannels(game, [ch(1, 'US| ESPN 4K'), ch(2, 'US| NBA TV HD')]);
  const out = await nba.confirmWithGuide(game, cands, async (id) => (id === 2 ? [{ title: 'NBA: Lakers at Celtics', start: game.start - 60000, end: game.start + 3 * 3600000 }] : []));
  assert.equal(out[0].id, 2);
  assert.equal(out[0].why, 'Guide lists this game');
});
