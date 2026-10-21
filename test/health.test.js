'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../src/lib/health');

const entry = (o) => ({ key: 'k', kind: 'live', mode: 'transcode', needKbps: 0, startedAt: Date.now() - 10000, speed: 1.2, cpuPct: 40, inBytes: 0, samples: [], errors: '', ...o });

test('verdict: slow copy streams are the provider; slow transcodes are local only when the CPU is the limit', () => {
  assert.equal(health.verdict(entry({ startedAt: Date.now() }), 4, 0.1), 'unknown', 'too early to judge');
  assert.equal(health.verdict(entry({ mode: 'copy', speed: 0.6 }), 4, 0.2), 'provider');
  assert.equal(health.verdict(entry({ mode: 'copy', speed: 1.0 }), 4, 0.2), 'ok');
  assert.equal(health.verdict(entry({ speed: 0.7, cpuPct: 350 }), 4, 1), 'local');
  assert.equal(health.verdict(entry({ speed: 0.7, cpuPct: 20 }), 4, 0.3), 'provider', 'ffmpeg idle and still slow: it is waiting for input');
  assert.equal(health.verdict(entry({ speed: 0.7, cpuPct: 30 }), 4, 3.8), 'local', 'machine is overloaded');
  assert.equal(health.verdict(entry({ speed: 1.5, cpuPct: 390 }), 4, 3.9), 'ok', 'busy but keeping up is fine');
});

test('direct streams are judged on throughput versus the file bitrate', () => {
  const e = entry({ mode: 'direct', needKbps: 8000 });
  e.samples = [[1000, 0], [5000, 1_000_000]];                 // 2000 kbit/s over 4 s
  assert.equal(Math.round(health.inKbps(e)), 2000);
  assert.equal(health.verdict(e), 'provider');
  e.samples = [[1000, 0], [5000, 6_000_000]];                 // 12000 kbit/s
  assert.equal(health.verdict(e), 'ok');
});

test('track/snapshot/untrack', () => {
  const e = health.track('live:1', { kind: 'live', mode: 'copy' });
  assert.equal(health.snapshot('live:1').active, true);
  health.untrack(e);
  assert.equal(health.snapshot('live:1').active, false);
});
