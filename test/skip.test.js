'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Skip = require('../public/skip');

const frame = (fn) => { const a = new Uint8ClampedArray(32 * 18 * 4); for (let i = 0; i < 32 * 18; i++) { const [r, g, b] = fn(i); a.set([r, g, b, 255], i * 4); } return a; };

test('credits-like frames: black with sparse text yes; dark scenes and normal pictures no', () => {
  assert.equal(Skip.frameIsCreditsLike(frame(() => [0, 0, 0])), true);
  assert.equal(Skip.frameIsCreditsLike(frame((i) => (i % 40 === 0 ? [255, 255, 255] : [2, 2, 2]))), true);   // a few white text pixels
  assert.equal(Skip.frameIsCreditsLike(frame(() => [60, 60, 70])), false);                                    // a dim scene, not black
  assert.equal(Skip.frameIsCreditsLike(frame((i) => (i % 2 ? [200, 200, 200] : [10, 10, 10]))), false);      // busy picture
});

test('skipAt: chapters beat learned values beat the manual fallback', () => {
  const segments = { intro: { start: 60, end: 150 }, recap: { start: 0, end: 50 } };
  assert.deepEqual(Skip.skipAt(10, { segments, isSeries: true }), { label: 'Skip recap', to: 50, kind: 'chapter' });
  assert.deepEqual(Skip.skipAt(70, { segments, isSeries: true }), { label: 'Skip intro', to: 150, kind: 'chapter' });
  assert.equal(Skip.skipAt(200, { segments, isSeries: true }), null);
  const learnedIntro = { start: 30, end: 120 };
  assert.equal(Skip.skipAt(40, { learnedIntro, isSeries: true }).kind, 'learned');
  assert.equal(Skip.skipAt(125, { learnedIntro, isSeries: true }), null);
  assert.equal(Skip.skipAt(100, { isSeries: true }).kind, 'manual');
  assert.equal(Skip.skipAt(100, { isSeries: false }), null, 'movies get no guessed skip');
  assert.equal(Skip.skipAt(400, { isSeries: true }), null);
});

test('nextAt: credits start when known, otherwise near the end', () => {
  assert.equal(Skip.nextAt({ duration: 1500 }), 1425);
  assert.equal(Skip.nextAt({ duration: 1500, creditsFromEnd: 120 }), 1380);
  assert.equal(Skip.nextAt({ duration: 1500, creditsFromEnd: 1400 }), 900, 'never earlier than 60% of the episode');
  assert.equal(Skip.nextAt({ duration: 1500, detectedAt: 1350, creditsFromEnd: 120 }), 1350);
  assert.equal(Skip.nextAt({ duration: 1500, segments: { credits: { start: 1300, end: 1500 } }, detectedAt: 1350 }), 1300);
});

test('/api/skips stores and blends what the player learns', async () => {
  process.env.STREAMSNAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-skips-'));
  const { createServer } = require('../src/server');
  const port = 7993, app = createServer(port);
  await new Promise((r) => app.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const post = (b) => fetch(base + '/api/skips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const get = async () => (await fetch(base + '/api/skips?id=tt1234567')).json();
    assert.deepEqual(await get(), { intro: null, creditsFromEnd: null });
    assert.equal((await post({ id: 'tt1234567', kind: 'intro', start: 40, end: 130 })).status, 200);
    assert.deepEqual(await get(), { intro: { start: 40, end: 130 }, creditsFromEnd: null });
    await post({ id: 'tt1234567', kind: 'intro', start: 50, end: 140 });
    assert.deepEqual((await get()).intro, { start: 45, end: 135 });                        // averaged with the earlier one
    await post({ id: 'tt1234567', kind: 'credits', fromEnd: 100 });
    assert.equal((await get()).creditsFromEnd, 100);
    assert.equal((await post({ id: 'tt1234567', kind: 'intro', start: 40, end: 45 })).status, 400, 'too short to be an intro');
    assert.equal((await post({ id: 'bad', kind: 'intro', start: 1, end: 100 })).status, 400);
  } finally { app.closeAllConnections(); app.close(); }
});
