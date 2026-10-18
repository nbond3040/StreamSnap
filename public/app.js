'use strict';
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');

// Tiny DOM helper: h('div', {class:'x', onclick}, child|string...) — text is never parsed as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'style') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

async function api(path, body) {
  const res = await fetch('/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000);
}

const fmtSize = (b) => (b ? (b / 1e9 >= 1 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB') : '');
const showErr = (e) => h('div', { class: 'err' }, e.message || String(e));

function poster(m) { return m.poster || ''; }
function card(m, extra) {
  const href = `#/detail/${m.type}/${m.id || m.imdb_id}`;
  const c = h('a', { class: 'card', href },
    h('img', { src: poster(m), alt: '', loading: 'lazy' }), h('div', { class: 't' }, m.name));
  if (extra && extra.dur) c.append(h('div', { class: 'bar', style: `width:${Math.min(100, (extra.pos / extra.dur) * 100)}%` }));
  return c;
}
const rowOf = (items, extra) => h('div', { class: 'row' }, items.map((m) => card(m, extra ? extra(m) : null)));
const loading = () => h('div', { class: 'spin' }, 'Loading…');

// ---------- views ----------
async function home() {
  view.replaceChildren(loading());
  const [lib, movies, series, cfg] = await Promise.all([api('/library'), api('/catalog?type=movie'), api('/catalog?type=series'), api('/config')]);
  const out = [];
  if (!cfg.hasRealDebridKey && !cfg.torrentioUrl) {
    out.push(h('div', { class: 'err' }, 'Add your Real-Debrid API key in ', h('a', { href: '#/settings', style: 'text-decoration:underline' }, 'Settings'), ' to start streaming.'));
  }
  if (lib.continueWatching.length) {
    out.push(h('h2', {}, 'Continue watching'));
    out.push(h('div', { class: 'row' }, lib.continueWatching.map((c) => {
      const el = card({ ...c, id: c.id }, c);
      el.href = `#/detail/${c.type}/${c.id}`;
      return el;
    })));
  }
  out.push(h('h2', {}, 'Popular movies'), rowOf(movies), h('h2', {}, 'Popular series'), rowOf(series));
  view.replaceChildren(...out);
}

async function discover(type) {
  let genre = '', skip = 0;
  const grid = h('div', { class: 'row' });
  const more = h('button', { class: 'sec', onclick: () => load() }, 'Load more');
  const genres = ['', 'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller'];
  const sel = h('select', { onchange: () => { genre = sel.value; skip = 0; grid.replaceChildren(); load(); } },
    genres.map((g) => h('option', { value: g }, g || 'All genres')));
  async function load() {
    more.disabled = true;
    try { const items = await api(`/catalog?type=${type}&genre=${encodeURIComponent(genre)}&skip=${skip}`); skip += items.length; grid.append(...items.map((m) => card(m))); more.hidden = !items.length; }
    catch (e) { grid.after(showErr(e)); }
    more.disabled = false;
  }
  view.replaceChildren(
    h('div', { class: 'filters' },
      h('button', { class: type === 'movie' ? 'on' : '', onclick: () => (location.hash = '#/discover/movie') }, 'Movies'),
      h('button', { class: type === 'series' ? 'on' : '', onclick: () => (location.hash = '#/discover/series') }, 'Series'), sel),
    grid, h('p', {}, more));
  load();
}

async function searchView(q) {
  view.replaceChildren(h('h2', {}, `Results for “${q}”`), loading());
  const [m, s] = await Promise.all([api(`/catalog?type=movie&q=${encodeURIComponent(q)}`), api(`/catalog?type=series&q=${encodeURIComponent(q)}`)]);
  view.replaceChildren(h('h2', {}, `Movies for “${q}”`), m.length ? rowOf(m) : h('p', { class: 'dim' }, 'No movies found.'),
    h('h2', {}, 'Series'), s.length ? rowOf(s) : h('p', { class: 'dim' }, 'No series found.'));
}

async function libraryView() {
  const lib = await api('/library');
  view.replaceChildren(h('h2', {}, 'My library'), lib.library.length ? rowOf(lib.library) : h('p', { class: 'dim' }, 'Nothing saved yet. Open a title and press “Add to library”.'));
}

async function detail(type, id) {
  view.replaceChildren(loading());
  const [meta, cfg] = await Promise.all([api(`/meta?type=${type}&id=${id}`), api('/config')]);
  const streamsBox = h('div');
  const base = { id, type, name: meta.name, poster: meta.poster };
  const libBtn = h('button', { class: 'sec' }, meta.inLibrary ? '✓ In library' : '+ Add to library');
  libBtn.onclick = async () => { const r = await api('/library', base); libBtn.textContent = r.inLibrary ? '✓ In library' : '+ Add to library'; };

  const info = h('div', { class: 'info' },
    h('h1', {}, meta.name),
    h('div', { class: 'chips' }, [meta.year || meta.releaseInfo, meta.runtime, meta.imdbRating && `★ ${meta.imdbRating}`, ...(meta.genres || [])].filter(Boolean).map((c) => h('span', { class: 'chip' }, c))),
    h('p', {}, meta.description || ''),
    meta.cast && h('p', { class: 'dim' }, 'Cast: ' + meta.cast.slice(0, 6).join(', ')),
    h('p', {}, libBtn), streamsBox);
  view.replaceChildren(h('div', { class: 'detail' }, h('img', { class: 'poster', src: meta.poster || '', alt: '' }), info));

  if (type === 'movie') return loadStreams(streamsBox, 'movie', id, meta.name, { ...base, key: `movie:${id}` });

  const videos = (meta.videos || []).filter((v) => v.season > 0 || (meta.videos || []).every((x) => !x.season));
  const seasons = [...new Set(videos.map((v) => v.season))].sort((a, b) => a - b);
  const epBox = h('div', { class: 'episodes' });
  const sSel = h('select', { onchange: () => drawEps() }, seasons.map((s) => h('option', { value: s }, s === 0 ? 'Specials' : `Season ${s}`)));
  const first = seasons.find((s) => s > 0) ?? seasons[0];
  sSel.value = first;
  function drawEps() {
    const season = Number(sSel.value);
    epBox.replaceChildren(...videos.filter((v) => v.season === season).sort((a, b) => a.episode - b.episode).map((v) => {
      const vid = `${id}:${v.season}:${v.episode}`;
      const row = h('div', { class: 'ep', onclick: () => {
        epBox.querySelectorAll('.on').forEach((e) => e.classList.remove('on')); row.classList.add('on');
        loadStreams(streamsBox, 'series', vid, `${meta.name} S${v.season}E${v.episode}`, { ...base, key: `series:${vid}`, videoId: vid, season: v.season, episode: v.episode });
      } }, h('span', { class: 'n' }, v.episode), h('span', {}, v.name || v.title || `Episode ${v.episode}`),
      meta.watched[`series:${vid}`] && h('span', { class: 'w' }, '✓'));
      return row;
    }));
  }
  info.insertBefore(h('div', {}, sSel, epBox), streamsBox);
  drawEps();
  streamsBox.replaceChildren(h('p', { class: 'dim' }, 'Pick an episode to find streams.'));
}

async function loadStreams(box, type, vid, title, meta) {
  box.replaceChildren(h('h2', {}, 'Streams'), loading());
  let res, subs = [];
  try { [res, subs] = await Promise.all([api(`/streams?type=${type}&id=${vid}`), api(`/subtitles?type=${type}&id=${vid}`)]); }
  catch (e) { box.replaceChildren(h('h2', {}, 'Streams'), showErr(e)); return; }
  const h_ = res.hidden;
  const note = `${res.total} found · showing ${res.language} audio only` +
    (h_.language ? ` · ${h_.language} other-language hidden` : '') + (h_.uncached ? ` · ${h_.uncached} uncached hidden` : '');
  const out = [h('h2', {}, 'Auto-selected streams'), h('p', { class: 'dim' }, note)];
  if (!res.picks.length) out.push(h('p', { class: 'err' }, `No ${res.language} streams are available (cached on Real-Debrid) for this title.`));
  const play = (s, inBrowser) => playStream(s, inBrowser, title, meta, subs);
  out.push(h('div', { class: 'picks' }, res.picks.map((p) => {
    const s = p.stream;
    return h('div', { class: 'pick' },
      h('h3', {}, p.resolution === '2160p' ? '4K' : p.resolution), h('div', { class: 'fn' }, s.filename),
      chips(s),
      h('div', { class: 'actions' }, h('button', { onclick: () => play(s, false) }, '▶ Play'), h('button', { class: 'sec', onclick: () => play(s, true) }, 'In browser')),
      p.alternatives.length && h('details', {}, h('summary', {}, `${p.alternatives.length} other options`),
        p.alternatives.map((a) => h('div', { class: 'alt' }, h('span', { title: a.filename }, `${fmtSize(a.size)} · ${a.source || '?'} ${a.codec} · 👤${a.seeders}`),
          h('button', { class: 'sec', onclick: () => play(a, false) }, 'Play')))));
  })));
  box.replaceChildren(...out);
}

function chips(s) {
  return h('div', { class: 'chips' },
    s.cached && h('span', { class: 'chip ok' }, 'cached'), !s.cached && h('span', { class: 'chip warn' }, 'not cached'),
    s.size && h('span', { class: 'chip' }, fmtSize(s.size)), s.source && h('span', { class: 'chip' }, s.source),
    s.codec && h('span', { class: 'chip' }, s.codec), s.hdr && h('span', { class: 'chip' }, 'HDR'),
    h('span', { class: 'chip' }, `👤 ${s.seeders}`), s.languageMatch === 'multi' && h('span', { class: 'chip' }, 'multi-audio'));
}

async function playStream(s, forceBrowser, title, meta, subs) {
  const body = { ref: s.ref, key: meta.key, title, meta: { type: meta.type, id: meta.id, name: meta.name, poster: meta.poster, videoId: meta.videoId, season: meta.season, episode: meta.episode }, subs: subs.map((x) => x.ref) };
  try {
    const r = await api('/play', { ...body, browser: forceBrowser });
    if (r.player === 'browser') openBrowserPlayer(s, title, meta, subs, r.start);
    else toast(`Opened in ${r.player}`);
  } catch (e) { toast(e.message); }
}

function openBrowserPlayer(s, title, meta, subs, start) {
  const box = $('#player'), v = $('#video');
  $('#playerTitle').textContent = title;
  $('#playerMsg').textContent = 'If it won’t play (MKV/HEVC), use mpv or VLC from Settings.';
  v.replaceChildren(...subs.map((x, i) => h('track', { kind: 'subtitles', src: `/api/sub/${x.ref}.vtt`, label: x.label, srclang: x.lang, default: i === 0 })));
  v.src = `/api/stream/${s.ref}`;
  v.onloadedmetadata = () => { if (start) v.currentTime = start; };
  let last = 0;
  v.ontimeupdate = () => {
    if (Date.now() - last < 10000) return; last = Date.now();
    api('/progress', { key: meta.key, pos: v.currentTime, dur: v.duration || 0, meta: { type: meta.type, id: meta.id, name: meta.name, poster: meta.poster, videoId: meta.videoId } }).catch(() => {});
  };
  box.hidden = false;
}
$('#closePlayer').onclick = closePlayer;
function closePlayer() { const v = $('#video'); v.pause(); v.removeAttribute('src'); v.load(); $('#player').hidden = true; }
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#player').hidden) closePlayer(); });

async function settings() {
  const [cfg, info] = await Promise.all([api('/config'), api('/info')]);
  const f = h('form', { class: 'settings' });
  const text = (name, label, type = 'text', ph = '') => h('label', {}, label, h('input', { name, type, value: type === 'password' ? '' : cfg[name] || '', placeholder: ph }));
  const check = (name, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: !!cfg[name] }), label);
  const select = (name, label, opts) => h('label', {}, label, h('select', { name }, Object.entries(opts).map(([v, t]) => h('option', { value: v, selected: v === cfg[name] }, t))));
  f.append(
    h('h2', {}, 'Accounts'),
    text('realDebridKey', `Real-Debrid API key ${cfg.hasRealDebridKey ? `(saved, ends ${cfg.realDebridKeyHint}; leave blank to keep)` : ''}`, 'password', 'from real-debrid.com/apitoken'),
    text('torrentioUrl', 'Torrentio config URL (optional)', 'text', 'https://torrentio.strem.fun/…/manifest.json — leave blank to use defaults'),
    h('h2', {}, 'Streams'),
    select('nativeLanguage', 'Native language (only streams with this audio are chosen)', info.languages),
    check('includeMultiAudio', 'Accept multi-audio / dual-audio releases that include my language'),
    check('assumeUntaggedNative', 'English: treat releases with no language tag as English'),
    check('allowUncached', 'Allow streams not yet cached on Real-Debrid (slow, must download first)'),
    select('hdrPolicy', 'HDR / Dolby Vision', { allow: 'Allow', avoid: 'Avoid when an SDR option exists', only: 'HDR only' }),
    check('subtitles', 'Fetch subtitles in my language'),
    h('h2', {}, 'Playback'),
    select('player', `Player (found: ${[info.players.mpv && 'mpv', info.players.vlc && 'VLC'].filter(Boolean).join(', ') || 'none — browser only'})`,
      { auto: 'Automatic (mpv → VLC → browser)', mpv: 'mpv', vlc: 'VLC', browser: 'In this window' }),
    h('button', { type: 'submit' }, 'Save'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f), body = { resolutions: cfg.resolutions };
    for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    if (!fd.get('realDebridKey')) body.keepKey = true;
    try { await api('/config', body); toast('Saved'); } catch (err) { toast(err.message); }
  };
  view.replaceChildren(f);
}

// ---------- router ----------
async function route() {
  const [, page, a, b] = location.hash.split('/');
  document.querySelectorAll('nav a').forEach((n) => n.classList.toggle('on', n.dataset.nav === (page || 'home')));
  try {
    if (!page) await home();
    else if (page === 'discover') await discover(a === 'series' ? 'series' : 'movie');
    else if (page === 'search') await searchView(decodeURIComponent(a));
    else if (page === 'library') await libraryView();
    else if (page === 'detail') await detail(a, b);
    else if (page === 'settings') await settings();
  } catch (e) { view.replaceChildren(showErr(e)); }
}
addEventListener('hashchange', route);
$('#search').onsubmit = (e) => { e.preventDefault(); const q = new FormData(e.target).get('q').trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); };
route();
