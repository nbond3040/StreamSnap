'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-off-'));
process.env.STREAMSNAP_HOME = home;
const config = require('../src/lib/config');
const offline = require('../src/lib/offline');
config.saveConfig({ downloadDir: path.join(home, 'media') });

const FILE = Buffer.alloc(2_000_000, 7);
let mock, base, hits = 0;
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };

test.before(async () => {
  mock = http.createServer((req, res) => {
    if (req.url === '/live') { // endless MPEG-TS stand-in
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      const iv = setInterval(() => res.write(Buffer.alloc(60000, 1)), 50);
      return res.on('close', () => clearInterval(iv));
    }
    hits++;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? +m[1] : 0;
    res.writeHead(m ? 206 : 200, { 'content-length': FILE.length - from, ...(m ? { 'content-range': `bytes ${from}-${FILE.length - 1}/${FILE.length}` } : {}) });
    res.end(FILE.subarray(from));
  }).listen(0);
  await new Promise((r) => mock.once('listening', r));
  base = `http://127.0.0.1:${mock.address().port}`;
});
test.after(() => mock.close());

test('a download is saved, listed and served with Range', async () => {
  const j = offline.addDownload({ title: 'Test: Movie', resolution: '1080p', size: FILE.length, filename: 'x.mkv', src: base + '/f' });
  offline.pumpDownloads(async (u) => u, false);
  await until(() => offline.list().downloads[0].status === 'done');
  const job = offline.find(j.id);
  assert.equal(fs.statSync(job.file).size, FILE.length);
  assert.ok(!/[:*?]/.test(path.basename(job.file)));
  const got = await new Promise((resolve) => {
    const req = { headers: { range: 'bytes=10-19' } };
    const chunks = []; let head;
    const res = Object.assign(new (require('stream').Writable)({ write(c, e, cb) { chunks.push(c); cb(); } }), { writeHead(s, h) { head = [s, h]; } });
    res.on('finish', () => resolve({ head, body: Buffer.concat(chunks) }));
    offline.serveFile(req, res, j.id);
  });
  assert.equal(got.head[0], 206);
  assert.equal(got.body.length, 10);
  offline.remove(j.id);
  assert.equal(offline.list().downloads.length, 0);
  assert.ok(!fs.existsSync(job.file));
});

test('downloads wait while something is streaming', async () => {
  const j = offline.addDownload({ title: 'Wait', resolution: '720p', size: FILE.length, filename: 'w.mp4', src: base + '/f' });
  const before = hits;
  offline.pumpDownloads(async (u) => u, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits, before);
  assert.equal(offline.list().downloads[0].status, 'queued');
  offline.pumpDownloads(async (u) => u, false);
  await until(() => offline.list().downloads[0].status === 'done');
  offline.remove(j.id);
});

test('a scheduled recording starts, records and stops on time', async () => {
  const now = Date.now();
  const r = offline.schedule({ channelId: '5', name: 'News', start: now + 300, end: now + 1800 });
  assert.equal(r.status, 'scheduled');
  const deps = { liveUrlFor: () => base + '/live' };
  offline.tick(deps);
  assert.equal(offline.list().recordings[0].status, 'scheduled');   // not due yet
  await new Promise((rr) => setTimeout(rr, 400));
  offline.tick(deps);
  await until(() => offline.list().recordings[0].status === 'recording');
  await until(() => offline.list().recordings[0].status === 'done', 6000);
  const rec = offline.list().recordings[0];
  assert.ok(rec.bytes > 1e5, 'bytes ' + rec.bytes);
  offline.remove(r.id);
});

test('recordings that were missed or too long are rejected sensibly', () => {
  assert.throws(() => offline.schedule({ channelId: '5', name: 'x', start: Date.now(), end: Date.now() + 13 * 3600 * 1000 }), /isn't valid/);
});

const { spawnSync } = require('child_process');
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('a recording with a timestamp jump is remuxed to a seekable file with the true duration', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = path.join(home, 'rm'); fs.mkdirSync(dir, { recursive: true });
  const mk = (name, extra) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=d=6:s=160x90:r=25', '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', ...extra, '-f', 'mpegts', path.join(dir, name)]);
  mk('a.ts', []); mk('b.ts', ['-output_ts_offset', '5000']);
  const ts = path.join(dir, 'rec.ts');
  fs.writeFileSync(ts, Buffer.concat([fs.readFileSync(path.join(dir, 'a.ts')), fs.readFileSync(path.join(dir, 'b.ts'))]));
  const dur = (f) => parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());
  assert.ok(dur(ts) > 1000, 'the raw recording claims a huge duration');
  const rec = offline.schedule({ channelId: '9', name: 'Jump', start: Date.now(), end: Date.now() + 60000 });
  config.saveData({ ...config.loadData(), recordings: config.loadData().recordings.map((r) => (r.id === rec.id ? { ...r, status: 'done', file: ts, bytes: fs.statSync(ts).size } : r)) });
  assert.equal(await offline.remux(rec.id), true);
  const after = offline.find(rec.id);
  assert.match(after.file, /\.mkv$/); assert.ok(!fs.existsSync(ts));
  assert.ok(Math.abs(dur(after.file) - 12) < 1.5, 'duration ' + dur(after.file));
  offline.remove(rec.id);
});
