'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromChapters, blend } = require('../src/lib/segments');

test('chapter titles become intro / recap / credits segments', () => {
  const ch = [
    { start: 0, end: 60, title: 'Recap' }, { start: 60, end: 150, title: 'Opening' }, { start: 150, end: 1300, title: 'Chapter 3' },
    { start: 1300, end: 1390, title: 'End Credits' }, { start: 1390, end: 1420, title: 'Next Time Preview' },
  ];
  const s = fromChapters(ch, 1420);
  assert.deepEqual(s.recap, { start: 0, end: 60 }); assert.deepEqual(s.intro, { start: 60, end: 150 }); assert.deepEqual(s.credits, { start: 1300, end: 1390 });
  assert.equal(fromChapters([{ start: 0, end: 1, title: 'Chapter 1' }], 100).intro, undefined);
  assert.deepEqual(fromChapters([{ start: 5, end: 95, title: 'Intro' }], 2600).intro, { start: 5, end: 95 });
  assert.equal(fromChapters([{ start: 2000, end: 2090, title: 'Intro' }], 2600).intro, undefined, 'an "intro" chapter late in the file is not a title sequence');
  assert.equal(fromChapters([{ start: 600, end: 700, title: 'Credits' }], 2600).credits, undefined, 'a credits chapter early in the file is not the end credits');
  assert.deepEqual(fromChapters([{ start: 0, end: 80, title: 'Opening Credits' }, { start: 2500, end: 2600, title: 'Ending' }], 2600), { intro: { start: 0, end: 80 }, credits: { start: 2500, end: 2600 } });
});

test('blend keeps a running average of the last few observations', () => {
  let v = blend(undefined, 100); assert.deepEqual(v, { value: 100, n: 1 });
  v = blend(v, 110); assert.equal(v.value, 105);
  for (let i = 0; i < 20; i++) v = blend(v, 200);
  assert.ok(v.value > 150 && v.n === 5, 'old values fade out'); // capped, so new observations keep influencing it
});
