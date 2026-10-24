'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PadNav = require('../public/padnav.js');

const box = (left, top, w = 100, h = 60) => ({ left, top, right: left + w, bottom: top + h });

test('d-pad moves along rows and columns of a grid', () => {
  // 3 columns x 2 rows of covers, plus a header button above the first column
  const rects = [box(0, 0, 80, 30), box(0, 100), box(120, 100), box(240, 100), box(0, 200), box(120, 200), box(240, 200)];
  assert.equal(PadNav.pick(rects, 1, 'right'), 2);
  assert.equal(PadNav.pick(rects, 2, 'right'), 3);
  assert.equal(PadNav.pick(rects, 3, 'right'), -1);          // edge of the row: nothing further
  assert.equal(PadNav.pick(rects, 2, 'down'), 5);            // straight down, not the diagonal
  assert.equal(PadNav.pick(rects, 5, 'up'), 2);
  assert.equal(PadNav.pick(rects, 1, 'up'), 0);              // up from the first row reaches the header
  assert.equal(PadNav.pick(rects, 0, 'down'), 1);
  assert.equal(PadNav.pick(rects, 4, 'left'), -1);
});

test('a ragged layout still finds the nearest control in each direction', () => {
  // a wide search box over two uneven rows
  const rects = [box(0, 0, 600, 40), box(0, 100, 150), box(200, 100, 90), box(310, 100, 250), box(40, 200, 400)];
  assert.equal(PadNav.pick(rects, 4, 'up'), 2);              // the control directly above the centre, not the wider one to its left
  assert.equal(PadNav.pick(rects, 3, 'up'), 0);
  assert.equal(PadNav.pick(rects, 1, 'up'), 0);
  assert.equal(PadNav.pick(rects, 2, 'down'), 4);
  assert.equal(PadNav.pick(rects, 0, 'down'), 2);               // from a wide control, the nearest to its centre
  assert.equal(PadNav.pick([box(0, 0)], 0, 'down'), -1);     // nothing else to go to
  assert.equal(PadNav.pick([], 0, 'down'), -1);
});

test('the keyboard edits text at the cursor', () => {
  let s = { value: '', pos: 0 };
  for (const c of 'dune') s = PadNav.edit(s, { ins: c });
  assert.deepEqual(s, { value: 'dune', pos: 4 });
  s = PadNav.edit(s, { left: true }); s = PadNav.edit(s, { left: true });
  s = PadNav.edit(s, { ins: 'x' });
  assert.deepEqual(s, { value: 'duxne', pos: 3 });
  s = PadNav.edit(s, { back: true });
  assert.deepEqual(s, { value: 'dune', pos: 2 });
  assert.deepEqual(PadNav.edit({ value: 'a', pos: 0 }, { back: true }), { value: 'a', pos: 0 });   // nothing before the cursor
  assert.deepEqual(PadNav.edit({ value: 'ab', pos: 2 }, { right: true }), { value: 'ab', pos: 2 });
  assert.deepEqual(PadNav.edit(s, { clear: true }), { value: '', pos: 0 });
});

test('every keyboard layer has the same action row and a way to finish', () => {
  for (const name of ['lower', 'upper', 'symbols']) {
    const rows = PadNav.LAYERS[name]('Search');
    assert.equal(rows.length, 5);
    const acts = rows.flat().filter((k) => k && k.act).map((k) => k.act);
    assert.ok(acts.includes('done') && acts.includes('space') && acts.includes('back'), name);
  }
  const letters = PadNav.LAYERS.lower('Go').flat().filter((k) => typeof k === 'string').join('');
  assert.ok([...'abcdefghijklmnopqrstuvwxyz'].every((c) => letters.includes(c)));
});
