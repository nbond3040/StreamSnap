'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const people = require('../src/lib/people');

test('only titles the person is credited on are listed, tagged by role, newest first', async () => {
  const metas = {
    a: { cast: ['Zoë Saldaña'], director: [], writer: [] }, b: { cast: ['Someone'], director: ['Zoe Saldana'], writer: [] },
    c: { cast: ['Nobody'], director: [], writer: [] },
  };
  const deps = {
    catalog: async (type) => (type === 'movie' ? [{ id: 'a', releaseInfo: '2009' }, { id: 'c', releaseInfo: '2020' }] : [{ id: 'b', releaseInfo: '2022–' }]),
    meta: async (type, id) => metas[id],
  };
  const out = await people.find('zoe saldana', deps);
  assert.deepEqual(out.items.map((m) => [m.id, m.type, m.roles]), [['b', 'series', ['Director']], ['a', 'movie', ['Actor']]]);   // accents and case don't matter; "c" only shares words
  assert.deepEqual(out.other, []);
});

test('titles whose credits can\'t be checked are kept, separately', async () => {
  const deps = { catalog: async (type) => (type === 'movie' ? [{ id: 'a' }, { id: 'x' }] : []), meta: async (t, id) => { if (id === 'x') throw new Error('down'); return { cast: ['Jo Bloggs'] }; } };
  const out = await people.find('Jo Bloggs', deps);
  assert.deepEqual(out.items.map((m) => m.id), ['a']); assert.deepEqual(out.other.map((m) => m.id), ['x']);
});

test('person API through the server', async (t) => {
  const mock = spawn('node', [path.join(__dirname, 'devmock.js'), '7995'], { env: { ...process.env, MOCK_VIDEO_DIR: os.tmpdir() }, stdio: 'ignore' });
  t.after(() => mock.kill());
  await new Promise((r) => setTimeout(r, 700));
  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-person-'));
  process.env.STREAMSNAP_CINEMETA_URL = 'http://127.0.0.1:7995';
  process.env.STREAMSNAP_TMDB_URL = 'http://127.0.0.1:7995/3';
  const { createServer } = require('../src/server');
  const app = createServer(7996);
  await new Promise((r) => app.listen(7996, '127.0.0.1', r));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const get = (p) => fetch('http://127.0.0.1:7996' + p);
  assert.equal((await get('/api/person?name=x')).status, 400);
  const jane = await (await get('/api/person?name=' + encodeURIComponent('Jane Actor'))).json();
  assert.equal(jane.source, 'cinemeta'); assert.equal(jane.needsKey, true);
  assert.deepEqual(jane.items.map((m) => [m.id, m.roles]), [['tt0000001', ['Actor']], ['tt0000002', ['Actor']]]);   // "The Actor Story" is not hers
  const dan = await (await get('/api/person?name=' + encodeURIComponent('Dan Director'))).json();
  assert.deepEqual(dan.items.map((m) => [m.id, m.roles]), [['tt0000001', ['Director']]]);
  // add a TMDB key: the same URL now answers from the full filmography
  await fetch('http://127.0.0.1:7996/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tmdbKey: 'b'.repeat(32) }) });
  const full = await (await get('/api/person?name=' + encodeURIComponent('Jane Actor') + '&from=tt0000001')).json();
  assert.equal(full.source, 'tmdb'); assert.equal(full.items.length, 3); assert.equal(full.needsKey, undefined);
});

test('with a TMDB key the full filmography is used', async (t) => {
  const mock = spawn('node', [path.join(__dirname, 'devmock.js'), '7997'], { env: { ...process.env, MOCK_VIDEO_DIR: os.tmpdir() }, stdio: 'ignore' });
  t.after(() => mock.kill());
  await new Promise((r) => setTimeout(r, 700));
  const tmdb = require('../src/lib/tmdb');
  process.env.STREAMSNAP_TMDB_URL = 'http://127.0.0.1:7997/3';
  const key = 'a'.repeat(32);
  // opened from a title: the credit on that title picks the right Jane Actor, not the more obvious-looking search hit
  const jane = await tmdb.filmography('Jane Actor', key, 'tt0000001');
  assert.equal(jane.photo, 'https://image.tmdb.org/t/p/w185/jane.jpg'); assert.equal(jane.department, 'Acting');
  assert.deepEqual(jane.items.map((m) => m.name), ['Mock Movie 2', 'Mock Movie', 'Mock Show']);   // newest first; talk show, "Herself" and undated entries are left out
  assert.deepEqual(jane.items.map((m) => m.type), ['movie', 'movie', 'series']);
  assert.equal(jane.items[2].id, 'tt0000200'); assert.equal(jane.items[1].character, 'Lead');
  assert.deepEqual(jane.items.find((m) => m.name === 'Mock Movie 2').roles, ['Actor']);   // executive-producer credits don't count
  // by name only: the exact-name match wins over a more popular-sounding lookalike
  tmdb._cache.clear();
  assert.equal((await tmdb.filmography('Jane Actor', key)).items.length, 3);
  const dan = await tmdb.filmography('Dan Director', key, 'tt0000001');
  assert.deepEqual(dan.items.map((m) => [m.name, m.roles]), [['Mock Movie', ['Director']], ['Dan Short', ['Writer']]]);
  assert.ok(tmdb._ids().has('movie:100'), 'ids are remembered');
});
