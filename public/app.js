'use strict';
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
var APPINFO = { players: {}, languages: {} };

// Tiny DOM helper: h('div', {class:'x', onclick}, child|string...) — text is never parsed as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'style' && !k.startsWith('data-')) el[k] = v;
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
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

const fmtSize = (b) => (b ? (b / 1e9 >= 1 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB') : '');
const showErr = (e) => h('div', { class: 'err' }, e.message || String(e));
const resLabel = (r) => (r === '2160p' ? '4K' : r);
const RES_ORDER = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];

// ---------- cards ----------
function card(m, prog) {
  const id = m.id || m.imdb_id;
  const c = h('a', { class: 'card', href: `#/detail/${m.type}/${id}` },
    h('div', { class: 'img', style: m.poster ? `background-image:url("${encodeURI(m.poster)}")` : '' },
      m.imdbRating && h('span', { class: 'rate' }, '★ ' + m.imdbRating)),
    h('div', { class: 't' }, m.name, (m.releaseInfo || m.year || m.season) && h('small', {}, m.season ? `S${m.season} E${m.episode}` : m.releaseInfo || m.year)));
  if (prog && prog.dur) c.append(h('div', { class: 'prog' }, h('i', { style: `width:${Math.min(100, (prog.pos / prog.dur) * 100)}%` })));
  return c;
}
const scroller = (items, prog) => h('div', { class: 'scroller' }, items.map((m) => card(m, prog && prog(m))));
const skeletons = (n = 8) => h('div', { class: 'scroller' }, Array.from({ length: n }, () => h('div', { class: 'skel' })));
const section = (title, body) => [h('h2', { class: 'sec' }, title), body];

// ---------- views ----------
async function home() {
  view.replaceChildren(h('div', { style: 'height:360px' }), ...section('Popular movies', skeletons()));
  const [lib, movies, series, cfg] = await Promise.all([api('/library'), api('/catalog?type=movie'), api('/catalog?type=series'), api('/config')]);
  const out = [];
  const feat = movies.find((m) => m.background && m.description) || movies[0];
  if (feat) out.push(h('div', { class: 'hero', style: feat.background ? `background-image:url("${encodeURI(feat.background)}")` : '' },
    h('div', {}, h('h1', {}, feat.name),
      h('div', { class: 'meta' }, feat.imdbRating && h('span', { class: 'star' }, '★ ' + feat.imdbRating), feat.releaseInfo && h('span', { class: 'dot' }, feat.releaseInfo), (feat.genres || []).slice(0, 3).map((g) => h('span', { class: 'dot' }, g))),
      h('p', {}, feat.description || ''),
      h('a', { class: 'btn', href: `#/detail/movie/${feat.id}` }, '▶ Watch now'))));
  if (!cfg.hasRealDebridKey && !cfg.torrentioUrl) {
    out.push(h('div', { class: 'notice' }, 'Add your Real-Debrid API key in ', h('a', { href: '#/settings' }, 'Settings'), ' to start streaming.'));
  }
  if (lib.continueWatching.length) {
    const byId = new Map(lib.continueWatching.map((c) => [c.id, c]));
    out.push(...section('Continue watching', scroller(lib.continueWatching.map((c) => ({ ...c, name: c.name })), (m) => byId.get(m.id))));
  }
  out.push(...section('Popular movies', scroller(movies)), ...section('Popular series', scroller(series)));
  view.replaceChildren(...out);
}

async function discover(type) {
  let genre = '', skip = 0;
  const grid = h('div', { class: 'grid' });
  const more = h('button', { class: 'btn ghost', onclick: () => load() }, 'Load more');
  const genres = ['', 'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller'];
  const sel = h('select', { class: 'pill', onchange: () => { genre = sel.value; skip = 0; grid.replaceChildren(); load(); } },
    genres.map((g) => h('option', { value: g }, g || 'All genres')));
  async function load() {
    more.disabled = true;
    try {
      const items = await api(`/catalog?type=${type}&genre=${encodeURIComponent(genre)}&skip=${skip}`);
      skip += items.length; grid.append(...items.map((m) => card(m))); more.hidden = !items.length;
    } catch (e) { grid.after(showErr(e)); }
    more.disabled = false;
  }
  const seg = h('div', { class: 'seg' },
    h('button', { class: type === 'movie' ? 'on' : '', onclick: () => (location.hash = '#/discover/movie') }, 'Movies'),
    h('button', { class: type === 'series' ? 'on' : '', onclick: () => (location.hash = '#/discover/series') }, 'Series'));
  view.replaceChildren(h('div', { class: 'filters' }, seg, sel), grid, h('p', { style: 'text-align:center;margin-top:28px' }, more));
  load();
}

async function searchView(q) {
  view.replaceChildren(...section(`Results for “${q}”`, skeletons()));
  const [m, s] = await Promise.all([api(`/catalog?type=movie&q=${encodeURIComponent(q)}`), api(`/catalog?type=series&q=${encodeURIComponent(q)}`)]);
  view.replaceChildren(...section(`Movies for “${q}”`, m.length ? h('div', { class: 'grid' }, m.map((x) => card(x))) : h('div', { class: 'empty' }, 'No movies found.')),
    ...section('Series', s.length ? h('div', { class: 'grid' }, s.map((x) => card(x))) : h('div', { class: 'empty' }, 'No series found.')));
}

async function libraryView() {
  const lib = await api('/library');
  view.replaceChildren(...section('My library', lib.library.length ? h('div', { class: 'grid' }, lib.library.map((x) => card(x)))
    : h('div', { class: 'empty' }, 'Nothing saved yet. Open a title and press “Add to library”.')));
}

// ---------- detail ----------
/** Fetch streams + captions for one movie/episode and bundle everything the player needs. */
async function buildContext(base, vid, ep, episodes) {
  const q = `type=${base.type}&id=${vid}`;
  const [res, subs] = await Promise.all([api('/streams?' + q), api('/subtitles?' + q)]);
  const idx = ep ? episodes.findIndex((e) => e.vid === vid) : -1;
  const nxt = idx >= 0 ? episodes[idx + 1] : null;
  const label = (e) => `S${e.season} E${e.episode} · ${e.title}`;
  return {
    type: base.type, vid, title: base.name, subtitleLine: ep ? label(ep) : '', key: `${base.type}:${vid}`,
    meta: { type: base.type, id: base.id, name: base.name, poster: base.poster, videoId: vid, season: ep?.season, episode: ep?.episode },
    picks: res.picks, hidden: res.hidden, total: res.total, language: res.language, subs,
    series: ep ? { episodes, load: (e) => buildContext(base, e.vid, e, episodes) } : null,
    next: nxt ? { label: label(nxt), load: () => buildContext(base, nxt.vid, nxt, episodes) } : null,
  };
}

function bestPick(ctx, preferred) {
  const order = (r) => RES_ORDER.indexOf(r);
  const atOrBelow = ctx.picks.filter((p) => order(p.resolution) >= order(preferred));
  return (atOrBelow[0] || ctx.picks[ctx.picks.length - 1]).resolution;
}

function streamChips(s) {
  return h('div', { class: 'chips' },
    h('span', { class: 'chip ' + (s.cached ? 'ok' : 'warn') }, s.cached ? 'cached' : 'not cached'),
    s.size > 0 && h('span', { class: 'chip' }, fmtSize(s.size)), s.source && h('span', { class: 'chip' }, s.source),
    s.codec && h('span', { class: 'chip' }, s.codec), s.hdr && h('span', { class: 'chip' }, 'HDR'),
    s.audioLangs && s.audioLangs.length > 0 && h('span', { class: 'chip ok' }, '🔊 ' + s.audioLangs.join('/')),
    h('span', { class: 'chip' }, `👤 ${s.seeders}`), s.languageMatch === 'multi' && h('span', { class: 'chip' }, 'multi-audio'));
}

function renderStreams(box, ctx, cfg) {
  const hid = ctx.hidden;
  const note = `${ctx.total} found · ${ctx.language} audio only` + (hid.language ? ` · ${hid.language} other-language hidden` : '') + (hid.uncached ? ` · ${hid.uncached} uncached hidden` : '') + (hid.audio ? ` · ${hid.audio} with no ${ctx.language} audio track hidden` : '');
  if (!ctx.picks.length) {
    box.replaceChildren(h('div', { class: 'panel' }, h('h3', {}, 'Streams'), h('div', { class: 'empty' }, `No ${ctx.language} streams cached on Real-Debrid for this title.`), h('p', { class: 'subtle' }, note)));
    return;
  }
  const withAlt = (res, alt) => ({ ...ctx, picks: ctx.picks.map((p) => (p.resolution === res ? { ...p, stream: alt } : p)) });
  box.replaceChildren(h('div', { class: 'panel' },
    h('h3', {}, 'Auto-selected streams', h('span', { class: 'subtle' }, 'best per resolution')),
    h('div', { class: 'picks' }, ctx.picks.map((p) => h('div', { class: 'pick' },
      h('div', { class: 'q r' + p.resolution }, resLabel(p.resolution)),
      h('div', { class: 'fn' }, p.stream.filename), streamChips(p.stream),
      h('div', {}, h('button', { class: 'btn sm', onclick: () => Player.open(ctx, p.resolution) }, '▶ Play')),
      p.alternatives.length > 0 && h('details', { class: 'alts' }, h('summary', {}, `${p.alternatives.length} other options`),
        p.alternatives.map((a) => h('div', { class: 'alt' }, h('span', {}, `${fmtSize(a.size)} · ${a.source || '?'} ${a.codec} · 👤${a.seeders}`),
          h('button', { class: 'btn ghost sm', onclick: () => Player.open(withAlt(p.resolution, a), p.resolution) }, 'Play'))))))),
    h('p', { class: 'subtle', style: 'margin:12px 0 0' }, note)));
}

async function detail(type, id) {
  view.replaceChildren(h('div', { class: 'empty', style: 'margin-top:40px' }, 'Loading…'));
  const [meta, cfg, lib] = await Promise.all([api(`/meta?type=${type}&id=${id}`), api('/config'), api('/library')]);
  const base = { id, type, name: meta.name, poster: meta.poster };
  const streamsBox = h('div');
  const playBtn = h('button', { class: 'btn', disabled: true }, 'Finding streams…');
  const libBtn = h('button', { class: 'btn ghost' }, meta.inLibrary ? '✓ In library' : '+ Library');
  libBtn.onclick = async () => { const r = await api('/library', base); libBtn.textContent = r.inLibrary ? '✓ In library' : '+ Library'; };

  const metaLine = [meta.year || meta.releaseInfo, meta.runtime].filter(Boolean);
  const hero = h('div', { class: 'dhero', style: meta.background ? `background-image:url("${encodeURI(meta.background)}")` : '' },
    h('div', { class: 'dwrap' },
      meta.poster && h('img', { class: 'poster', src: meta.poster, alt: '' }),
      h('div', { class: 'dinfo' }, h('h1', {}, meta.name),
        h('div', { class: 'meta' }, meta.imdbRating && h('span', { class: 'star' }, '★ ' + meta.imdbRating), metaLine.map((c) => h('span', { class: 'dot' }, c))),
        h('div', { class: 'chips' }, (meta.genres || []).map((g) => h('span', { class: 'chip' }, g))),
        h('p', { class: 'desc' }, meta.description || ''),
        meta.cast && h('div', { class: 'subtle' }, 'Cast: ' + meta.cast.slice(0, 6).join(', ')),
        h('div', { class: 'actions' }, playBtn, libBtn))));

  function ready(ctx) {
    renderStreams(streamsBox, ctx, cfg);
    if (ctx.picks.length) {
      const res = bestPick(ctx, cfg.preferredResolution);
      playBtn.disabled = false; playBtn.textContent = `▶ Play ${resLabel(res)}`; playBtn.onclick = () => Player.open(ctx, res);
    } else { playBtn.disabled = true; playBtn.textContent = 'No streams'; }
  }
  const fail = (e) => { streamsBox.replaceChildren(showErr(e)); playBtn.textContent = 'Unavailable'; };

  if (type === 'movie') {
    view.replaceChildren(hero, h('div', { style: 'margin-top:24px' }, streamsBox));
    streamsBox.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'skel', style: 'aspect-ratio:auto;height:90px;flex:none' })));
    buildContext(base, id, null).then(ready, fail);
    return;
  }

  // Series: episode list on the left, streams for the selected episode on the right.
  const all = (meta.videos || []).filter((v) => v.season != null && v.episode != null);
  const regular = all.filter((v) => v.season > 0);
  const episodes = (regular.length ? regular : all)
    .map((v) => ({ vid: `${id}:${v.season}:${v.episode}`, season: v.season, episode: v.episode, title: v.name || v.title || `Episode ${v.episode}`, watched: !!meta.watched[`series:${id}:${v.season}:${v.episode}`] }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const seasons = [...new Set(episodes.map((e) => e.season))];
  const resume = lib.continueWatching.find((c) => c.id === id && c.videoId);
  const start = episodes.find((e) => resume && e.vid === resume.videoId) || episodes.find((e) => !e.watched) || episodes[0];

  const epBox = h('div', { class: 'eps' });
  const sSel = h('select', { class: 'pill', onchange: () => drawEps() }, seasons.map((s) => h('option', { value: s }, s === 0 ? 'Specials' : `Season ${s}`)));
  let selected = start;
  function pickEpisode(e) {
    selected = e; drawEps();
    playBtn.disabled = true; playBtn.textContent = 'Finding streams…';
    streamsBox.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'skel', style: 'aspect-ratio:auto;height:90px;flex:none' })));
    buildContext(base, e.vid, e, episodes).then((ctx) => { if (selected === e) ready(ctx); }, fail);
  }
  function drawEps() {
    const season = Number(sSel.value);
    epBox.replaceChildren(...episodes.filter((e) => e.season === season).map((e) => h('div', { class: 'ep' + (selected && e.vid === selected.vid ? ' on' : ''), onclick: () => pickEpisode(e) },
      h('span', { class: 'n' }, e.episode), h('span', { class: 'nm' }, e.title), e.watched && h('span', { class: 'w' }, '✓'))));
  }
  if (!episodes.length) { view.replaceChildren(hero, h('div', { class: 'empty' }, 'No episodes listed for this series.')); return; }
  sSel.value = start.season;
  view.replaceChildren(hero, h('div', { class: 'dlayout' },
    h('div', { class: 'panel' }, h('h3', {}, 'Episodes', sSel), epBox), streamsBox));
  pickEpisode(start);
  epBox.querySelector('.on')?.scrollIntoView({ block: 'center' });
}

// ---------- settings ----------
async function settings() {
  const [cfg, info] = await Promise.all([api('/config'), api('/info')]);
  const f = h('form', { class: 'settings' });
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint));
  const text = (name, type = 'text', ph = '') => h('input', { name, type, value: type === 'password' ? '' : cfg[name] || '', placeholder: ph, autocomplete: 'off' });
  const check = (name, label, hint) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: !!cfg[name] }), h('div', {}, h('div', {}, label), hint && h('small', { class: 'subtle' }, hint)));
  const select = (name, opts) => h('select', { name }, Object.entries(opts).map(([v, t]) => h('option', { value: v, selected: v === cfg[name] }, t)));
  const p = info.players;
  f.append(
    h('div', { class: 'card2' }, h('h2', {}, 'Accounts'),
      field(`Real-Debrid API key${cfg.hasRealDebridKey ? ` — saved (ends ${cfg.realDebridKeyHint})` : ''}`, text('realDebridKey', 'password', cfg.hasRealDebridKey ? 'Leave blank to keep the saved key' : 'real-debrid.com/apitoken'), 'Stored only on this computer.'),
      field('Torrentio config URL (optional)', text('torrentioUrl', 'text', 'https://torrentio.strem.fun/…/manifest.json'), 'Torrentio has no separate API key. Leave blank to use the defaults.')),
    h('div', { class: 'card2' }, h('h2', {}, 'Streams'),
      field('Native language', select('nativeLanguage', info.languages), 'Only streams with this audio are chosen.'),
      field('Starting quality', select('preferredResolution', { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': '480p' }), 'Used by the Play button. You can change it any time in the player.'),
      check('includeMultiAudio', 'Accept multi-audio releases that include my language'),
      check('assumeUntaggedNative', 'English: treat releases with no language tag as English'),
      check('verifyAudio', 'Verify audio language by inspecting the files', 'Uses ffmpeg to read each candidate’s audio tracks, so releases without your language are never picked. Slightly slower.'),
      check('allowUncached', 'Allow streams not cached on Real-Debrid', 'Slow: Real-Debrid has to download them first.'),
      field('HDR / Dolby Vision', select('hdrPolicy', { allow: 'Allow', avoid: 'Avoid when an SDR option exists', only: 'HDR only' })),
      check('subtitles', 'Fetch captions in my language', 'Captions are always off until you turn them on in the player.')),
    h('div', { class: 'card2' }, h('h2', {}, 'Playback'),
      field('Player', select('player', { browser: 'Built-in player (quality switching, captions, next episode)', auto: 'External: mpv → VLC', mpv: 'External: mpv', vlc: 'External: VLC' }),
        `Detected: ${[p.mpv && 'mpv', p.vlc && 'VLC', p.ffmpeg && 'ffmpeg'].filter(Boolean).join(', ') || 'nothing'}.` + (p.ffmpeg ? '' : ' Install ffmpeg (sudo apt install ffmpeg) so the built-in player can convert unsupported audio/video formats.'))),
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Save settings')));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { resolutions: cfg.resolutions };
    for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    if (!body.realDebridKey) body.keepKey = true;
    try { await api('/config', body); toast('Settings saved'); } catch (err) { toast(err.message); }
  };
  view.replaceChildren(f);
}

// ---------- router ----------
async function route() {
  const [, page, a, b] = location.hash.split('/');
  document.querySelectorAll('#top [data-nav]').forEach((n) => n.classList.toggle('on', n.dataset.nav === (page || 'home')));
  window.scrollTo(0, 0);
  try {
    if (!page) await home();
    else if (page === 'discover') await discover(a === 'series' ? 'series' : 'movie');
    else if (page === 'search') await searchView(decodeURIComponent(a));
    else if (page === 'library') await libraryView();
    else if (page === 'detail') await detail(a, b);
    else if (page === 'settings') await settings();
  } catch (e) { view.replaceChildren(showErr(e)); }
}
window.onPlayerClosed = () => { if (/^#?\/?$|detail/.test(location.hash.replace('#', '')) || !location.hash) route(); };
addEventListener('hashchange', route);
$('#search').onsubmit = (e) => { e.preventDefault(); const q = new FormData(e.target).get('q').trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); };
api('/info').then((i) => { APPINFO = i; }).catch(() => {}).finally(route);
