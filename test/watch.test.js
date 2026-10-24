'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackWatch } = require('../public/watch.js');

function fakeVideo() {
  const v = new EventTarget();
  Object.assign(v, { paused: false, seeking: false, ended: false, readyState: 4, currentTime: 100, frameCb: null,
    requestVideoFrameCallback(cb) { v.frameCb = cb; }, getVideoPlaybackQuality: () => ({ droppedVideoFrames: 0, totalVideoFrames: 0 }) });
  // a displayed frame whose own timestamp is `behindMs` older than the playback clock
  v.frame = (behindMs, n = 1) => { for (let i = 0; i < n; i++) v.frameCb(0, { mediaTime: v.currentTime - behindMs / 1000 }); };
  return v;
}
const make = (video, calls) => PlaybackWatch(video, { settleMs: 0, driftSamples: 6, warmupMs: 0, onBehind() {}, onDrift: (ms, n) => calls.push([Math.round(ms), n]) });
const open = (w) => { w._drift.settleUntil = 0; };

test('a picture lagging the clock is reported, with the strike count rising each time', () => {
  const v = fakeVideo(), calls = [], w = make(v, calls);
  v.frame(300, 8); open(w);
  assert.equal(Math.round(w.driftCheck()), 300);
  assert.deepEqual(calls, [[300, 1]]);
  v.frame(320, 8); open(w); w.driftCheck();
  assert.deepEqual(calls.map((c) => c[1]), [1, 2]);          // still behind after the first fix: escalate
  w.stop();
});

test('a picture in sync is left alone, and earlier strikes are forgotten once it stays in sync', () => {
  const v = fakeVideo(), calls = [], w = make(v, calls);
  v.frame(-12, 8); open(w); w.driftCheck();
  assert.deepEqual(calls, []);
  v.frame(400, 8); open(w); w.driftCheck();
  assert.equal(w._drift.strikes, 1);
  w._drift.lastFixAt -= 30000;                                 // calm for a long stretch...
  v.frame(5, 8); open(w); w.driftCheck();
  assert.equal(w._drift.strikes, 0);                           // ...so the next problem starts again at the gentle fix
  w.stop();
});

test('nothing is judged while seeking, paused, or before enough frames have been seen', () => {
  const v = fakeVideo(), calls = [], w = make(v, calls);
  v.frame(500, 3); open(w);
  assert.equal(w.driftCheck(), null);                          // too few samples
  v.frame(500, 8);
  v.paused = true; assert.equal(w.driftCheck(), null);         // paused
  v.paused = false; v.seeking = true; v.frame(800, 20);       // frames shown mid-seek are not counted
  v.seeking = false; assert.equal(w._drift.samples.length, 11);
  w._drift.settleUntil = Date.now() + 5000; assert.equal(w.driftCheck(), null);   // just after a skip: let it settle
  assert.deepEqual(calls, []);
  w.stop();
});

test('every skip starts a fresh measurement, and loops or jumps are not mistaken for drift', () => {
  const v = fakeVideo(), calls = [], w = make(v, calls);
  v.frame(300, 8);
  v.dispatchEvent(new Event('seeking'));
  assert.equal(w._drift.samples.length, 0);                    // samples from before the skip are thrown away
  v.currentTime = 2; v.frame(30000, 5);                        // a loop wrap reads as a huge difference
  assert.equal(w._drift.samples.length, 0);
  w.stop();
});
