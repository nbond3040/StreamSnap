'use strict';
// Local stand-ins for Cinemeta, Torrentio and the subtitles addon, for UI testing without network.
// Usage: MOCK_VIDEO_DIR=/dir/with/a.webm,b.mkv node test/devmock.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 7990);
const dir = process.env.MOCK_VIDEO_DIR || __dirname;
const self = `http://127.0.0.1:${port}`;
const flaky = {};
const BIG = Number(process.env.MOCK_CHANNELS || 0), BIGCATS = Number(process.env.MOCK_CATS || 400);
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

const LAT = Number(process.env.MOCK_LATENCY_MS || 0);
const realCreate = http.createServer;
http.createServer = (handler) => realCreate((req, res) => (LAT && /\/stream\/|\/resolve\/|\/video\//.test(req.url) ? setTimeout(() => handler(req, res), LAT) : handler(req, res)));
http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, self);
  let m;
  if (/^\/catalog\/movie\/.*boom/.test(u.pathname)) { res.writeHead(504); return res.end(); } // simulate a Cinemeta gateway timeout
  if (/^\/catalog\/(movie|series)\//.test(u.pathname)) {
    const type = u.pathname.split('/')[2], skip = Number((/skip=(\d+)/.exec(u.pathname) || [])[1] || 0);
    if (type === 'series' && skip === 80 && (flaky.n = (flaky.n || 0) + 1) <= 3) { res.writeHead(504); return res.end(); } // a few gateway timeouts, then fine
    if (skip >= 120) return json({ metas: [] });               // three pages of 40, then the end
    const base = type === 'movie' ? movie : series;
    return json({ metas: Array.from({ length: 40 }, (_, i) => ({ ...base, id: i === 0 && skip === 0 ? base.id : `tt9${String(skip + i).padStart(6, '0')}`, name: `${base.name} ${skip + i + 1}` })) });
  }
  // TMDB stand-in: tt0000001 belongs to a 3-film collection
  if (u.pathname.startsWith('/3/find/')) return json({ movie_results: u.pathname.endsWith('tt0000001') ? [{ id: 100 }] : [] });
  if (u.pathname === '/3/movie/100') return json({ belongs_to_collection: { id: 9, name: 'Mock Collection' } });
  if (u.pathname === '/3/collection/9') return json({ name: 'Mock Collection', parts: [{ id: 102, title: 'Mock Movie 3', release_date: '2026-05-01', poster_path: null }, { id: 100, title: 'Mock Movie', release_date: '2024-05-01', poster_path: null }, { id: 101, title: 'Mock Movie 2', release_date: '2025-05-01', poster_path: null }] });
  if ((m = /^\/3\/movie\/(\d+)\/external_ids$/.exec(u.pathname))) return json({ imdb_id: 'tt0000' + m[1] });
  // Xtream Codes stand-in (user "u", password "p")
  if (u.pathname === '/player_api.php') {
    const q = u.searchParams, act = q.get('action');
    if (q.get('username') !== 'u' || q.get('password') !== 'p') return json({ user_info: { auth: 0 } });
    if (!act) return json({ user_info: { auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400 * 30), max_connections: '2' } });
    if (BIG && act === 'get_live_categories') return json(Array.from({ length: BIGCATS }, (_, i) => ({ category_id: String(i + 1), category_name: `${['US', 'UK', 'CA', 'DE', 'FR', 'ES'][i % 6]}| CATEGORY NUMBER ${i + 1}` })));
    if (BIG && act === 'get_live_streams') return json(Array.from({ length: BIG }, (_, i) => ({ num: i + 1, name: `${['US', 'UK', 'CA', 'DE', 'FR', 'ES'][i % 6]}| CHANNEL NAME ${i + 1} HD`, stream_id: 100000 + i, stream_icon: `http://logos.example.com/images/channels/logo_${i + 1}.png`, category_id: String((i % BIGCATS) + 1) })));
    if (act === 'get_live_categories') return json([{ category_id: '1', category_name: 'US| NEWS NETWORK' }, { category_id: '2', category_name: 'US| SPORTS NETWORK' }, { category_id: '3', category_name: 'UK| MOVIES' }, { category_id: '4', category_name: 'WORLD LIVE SPORTS' }]);
    if (act === 'get_live_streams') {
      const names = ['News One', 'World News', 'Sports HD', 'Arena Sports', 'Movie Max', 'Cinema Classics', 'News Today', 'Sports Extra', 'Film Four', 'Kids Zone', 'Nature TV', 'Music Hits'];
      const list = names.map((n, i) => ({ num: i + 1, name: (i % 3 === 2 ? 'UK| ' : 'US| ') + n.toUpperCase(), stream_id: 101 + i, stream_icon: '', category_id: String(i % 3 + 1) }));
      list.push({ num: 15, name: 'US| PPV EVENT (NOT LIVE)', stream_id: 115, stream_icon: '', category_id: '4' }, { num: 16, name: 'US| MISSING', stream_id: 116, stream_icon: '', category_id: '4' }, { num: 17, name: 'US| SLOW PROVIDER', stream_id: 117, stream_icon: '', category_id: '4' }, { num: 13, name: '##### SPORTS #####', stream_id: 113, stream_icon: '', category_id: '2' }, { num: 14, name: 'World Cup Live', stream_id: 114, stream_icon: '', category_id: '4' });
      return json(list);
    }
    if (act === 'get_short_epg') {
      const b64 = (t) => Buffer.from(t).toString('base64'), now = Math.floor(Date.now() / 1000), id = q.get('stream_id');
      return json({ epg_listings: [[-1200, 2400, 'Morning Show'], [2400, 6000, 'Evening News'], [6000, 9600, 'Late Movie']].map(([a, z, t]) => ({ title: b64(`${t} ${id}`), description: b64(`About ${t}.`), start_timestamp: String(now + a), stop_timestamp: String(now + z) })) });
    }
  }
  if (u.pathname === '/live/u/p/117.ts') { // a provider that can't keep up: about 30 kB/s, far below the stream's own bitrate
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const buf = fs.readFileSync(path.join(dir, 'live.ts')); let pos = 0;
    const iv = setInterval(() => { if (pos >= buf.length) { clearInterval(iv); return res.end(); } res.write(buf.subarray(pos, pos + 3000)); pos += 3000; }, 100);
    res.on('close', () => clearInterval(iv)); return;
  }
  if (u.pathname === '/live/u/p/115.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return; } // off air: connects, then never sends anything
  if (u.pathname === '/live/u/p/116.ts') { res.writeHead(404); return res.end(); }
  if (/^\/live\/u\/p\/\d+\.ts$/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return fs.createReadStream(path.join(dir, 'live.ts')).pipe(res); }
  if ((m = /^\/meta\/(movie|series)\/(tt9\d+)\.json$/.exec(u.pathname))) return json({ meta: { ...(m[1] === 'movie' ? movie : series), id: m[2], imdb_id: m[2], name: `Generated ${m[2]}` } });
  if (u.pathname === '/meta/movie/tt0000001.json') return json({ meta: movie });
  if (u.pathname === '/meta/movie/tt0000003.json') return json({ meta: { ...movie, id: 'tt0000003', imdb_id: 'tt0000003', name: 'Only French' } });
  if (u.pathname === '/meta/series/tt0000002.json') return json({ meta: series });
  if (/\/stream\/movie\/tt0000003/.test(u.pathname)) return json({ streams: [stream('1080p', 'FRA1', 'a.webm', '\n🇫🇷'), stream('720p', 'FRA2', 'a.webm', '\n🇫🇷')] });
  { // episodes with special files: chapters (S1E3) and a black "credits" ending (S2E1)
    const sp = /\/stream\/series\/(tt0000002:\d:\d)/.exec(u.pathname);
    const special = sp && { 'tt0000002:1:3': 'ch.webm', 'tt0000002:2:1': 'dark.webm' }[sp[1]];
    if (special) return json({ streams: [stream('1080p', 'SPECIAL', special), stream('720p', 'SPECIAL720', special)] });
  }
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
