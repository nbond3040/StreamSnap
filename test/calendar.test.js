'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

test('calendar API: library episodes, NBA games and the best channel for a game', async (t) => {
  const mock = spawn('node', [path.join(__dirname, 'devmock.js'), '7993'], { env: { ...process.env, MOCK_VIDEO_DIR: os.tmpdir() }, stdio: 'ignore' });
  t.after(() => mock.kill());
  await new Promise((r) => setTimeout(r, 700));
  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cal-'));
  process.env.STREAMSNAP_CINEMETA_URL = 'http://127.0.0.1:7993';
  process.env.STREAMSNAP_NBA_URL = 'http://127.0.0.1:7993/nba';
  const { createServer } = require('../src/server');
  const app = createServer(7994);
  await new Promise((r) => app.listen(7994, '127.0.0.1', r));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = 'http://127.0.0.1:7994';
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const get = async (p) => (await fetch(base + p)).json();
  const day = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);

  assert.equal((await fetch(`${base}/api/calendar?from=bad&to=x`)).status, 400);
  assert.equal((await fetch(`${base}/api/calendar?from=2026-01-01&to=2027-01-01`)).status, 400);   // too wide a range

  await post('/api/library/add', { id: 'tt0000002', type: 'series', name: 'Mock Series', poster: '', genres: [] });
  let cal = await get(`/api/calendar?from=${day(-3)}&to=${day(7)}`);
  assert.ok(cal.episodes.length >= 4 && cal.episodes.every((e) => e.series === 'tt0000002' && e.date >= day(-3) && e.date <= day(7)));
  assert.ok(cal.games.length >= 20 && cal.games.some((g) => g.state === 'final') && cal.games.some((g) => g.state === 'scheduled'));

  const off = await post('/api/config', { calendarNba: false });
  assert.equal((await off.json()).calendarNba, false);
  cal = await get(`/api/calendar?from=${day(-3)}&to=${day(7)}`);
  assert.deepEqual(cal.games, []); assert.equal(cal.nba, false);
  await post('/api/config', { calendarNba: true });
  cal = await get(`/api/calendar?from=${day(-3)}&to=${day(7)}`);
  const final = cal.games.find((g) => g.state === 'final'), next = cal.games.find((g) => g.state === 'scheduled' && g.home.abbr === 'BOS');

  // no Live TV yet: the card still has the game, just nothing to watch it on
  let info = await get(`/api/nba/game?id=${next.id}&start=${next.start}`);
  assert.equal(info.game.id, next.id); assert.deepEqual(info.streams, []); assert.equal(info.hasLive, false);

  await post('/api/config', { xtreamUrl: '127.0.0.1:7993', xtreamUser: 'u', xtreamPass: 'p' });
  info = await get(`/api/nba/game?id=${next.id}&start=${next.start}`);
  assert.equal(info.hasLive, true);
  assert.ok(info.streams.length >= 2);
  assert.ok(info.streams.every((s) => !/ESPN2/.test(s.name)), 'ESPN2 does not carry this game');
  assert.match(info.streams[0].name, /Lakers vs Celtics/);   // the per-game channel is the surest match
  const espn = info.streams.filter((s) => /ESPN/.test(s.name));
  assert.deepEqual(espn.map((s) => s.quality), ['4K', 'HD']);  // higher quality first

  info = await get(`/api/nba/game?id=${final.id}&start=${final.start}`);
  assert.deepEqual(info.streams, []);                           // finished games have nothing to watch live
  assert.equal((await fetch(`${base}/api/nba/game?id=999&start=${final.start}`)).status, 404);
});
