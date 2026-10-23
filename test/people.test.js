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
  const { createServer } = require('../src/server');
  const app = createServer(7996);
  await new Promise((r) => app.listen(7996, '127.0.0.1', r));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const get = (p) => fetch('http://127.0.0.1:7996' + p);
  assert.equal((await get('/api/person?name=x')).status, 400);
  const jane = await (await get('/api/person?name=' + encodeURIComponent('Jane Actor'))).json();
  assert.deepEqual(jane.items.map((m) => [m.id, m.roles]), [['tt0000001', ['Actor']], ['tt0000002', ['Actor']]]);   // "The Actor Story" is not hers
  const dan = await (await get('/api/person?name=' + encodeURIComponent('Dan Director'))).json();
  assert.deepEqual(dan.items.map((m) => [m.id, m.roles]), [['tt0000001', ['Director']]]);
});
