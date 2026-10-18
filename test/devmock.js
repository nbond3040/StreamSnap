'use strict';
// Local stand-ins for Cinemeta, Torrentio and the subtitles addon, for UI testing without network.
// Usage: MOCK_VIDEO_DIR=/dir/with/a.webm,b.mkv node test/devmock.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 7990);
const dir = process.env.MOCK_VIDEO_DIR || __dirname;
const self = `http://127.0.0.1:${port}`;
const posters = (n) => ({ poster: '', background: '', description: `Mock description for ${n}.`, imdbRating: '8.1', releaseInfo: '2024', genres: ['Drama'] });
const movie = { id: 'tt0000001', imdb_id: 'tt0000001', type: 'movie', name: 'Mock Movie', ...posters('movie'), genres: ['Action', 'Drama'], runtime: '30 s' };
const videos = [];
for (const [s, n] of [[1, 3], [2, 2]]) for (let e = 1; e <= n; e++) videos.push({ season: s, episode: e, name: `Episode ${s}.${e}` });
const series = { id: 'tt0000002', imdb_id: 'tt0000002', type: 'series', name: 'Mock Series', ...posters('series'), genres: ['Comedy'], videos };

const stream = (res, label, file, extra = '') => ({
  name: `[RD+] Torrentio\n${res}`,
  title: `Mock.${label}.${res}.WEB-DL.x264\n👤 100 💾 1 GB ⚙️ Mock${extra}`,
  url: `${self}/resolve/realdebrid/KEY/${label}/null/0/${file}`,
  behaviorHints: { filename: `Mock.${label}.${res}.WEB-DL.x264.mkv` },
});

http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, self);
  let m;
  if (/^\/catalog\/movie\/.*boom/.test(u.pathname)) { res.writeHead(504); return res.end(); } // simulate a Cinemeta gateway timeout
  if (/^\/catalog\/(movie|series)\//.test(u.pathname)) return json({ metas: [movie, series] });
  if (u.pathname === '/meta/movie/tt0000001.json') return json({ meta: movie });
  if (u.pathname === '/meta/series/tt0000002.json') return json({ meta: series });
  if (/\/stream\//.test(u.pathname)) {
    return json({ streams: [stream('1080p', 'AC3', 'b.mkv'), stream('720p', 'OPUS', 'a.webm'), stream('480p', 'OPUS2', 'a.webm'), stream('1080p', 'FR', 'a.webm', '\n🇫🇷'), stream('1080p', 'UNFLAGGEDFR', 'c.webm'), stream('2160p', 'DUALTRACK', 'd.mkv')] });
  }
  if (u.pathname.startsWith('/subtitles/')) return json({ subtitles: [{ id: '1', lang: 'eng', url: `${self}/sub.srt` }] });
  if (u.pathname === '/sub.srt') { res.writeHead(200); return res.end('1\n00:00:01,000 --> 00:00:04,000\nHello captions\n\n2\n00:00:10,000 --> 00:00:12,000\nSecond line\n'); }
  if ((m = /^\/resolve\/.*\/([^/]+)$/.exec(u.pathname))) { res.writeHead(302, { location: `/video/${m[1]}` }); return res.end(); }
  if ((m = /^\/video\/([\w.]+)$/.exec(u.pathname))) {
    const file = path.join(dir, m[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size, type = file.endsWith('.webm') ? 'video/webm' : 'video/x-matroska';
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      const a = +r[1], b = r[2] ? +r[2] : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
      return fs.createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log('mock on', self));
