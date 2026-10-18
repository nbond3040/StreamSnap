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
/** Inline error with a Retry button, so one failed lookup doesn't take the whole page down. */
const retryBox = (e, retry) => h('div', { class: 'err retry' }, h('span', {}, (e && e.message) || 'Something went wrong.'), h('button', { class: 'btn sm ghost', onclick: retry }, 'Retry'));
const settled = (results, i) => (results[i].status === 'fulfilled' ? { value: results[i].value } : { error: results[i].reason });
const libraryIds = new Set(); // titles in the user's library, so cover art can offer "+" only where it makes sense

// Colour palettes (swatch previews mirror the :root[data-color] rules in style.css). Any colour works in dark or light.
const COLORS = {
  violet: { name: 'Violet', h: 240, sat: 18, ah: 252 },
  blue: { name: 'Blue', h: 222, sat: 24, ah: 216 },
  ocean: { name: 'Ocean', h: 196, sat: 26, ah: 194 },
  green: { name: 'Green', h: 150, sat: 20, ah: 148 },
  orange: { name: 'Orange', h: 24, sat: 22, ah: 24 },
  rose: { name: 'Rose', h: 336, sat: 22, ah: 338 },
  graphite: { name: 'Graphite', h: 240, sat: 4, ah: 222 },
};
let appearance = { color: 'violet', mode: 'dark', black: false, dd: 'floating' };
const lightQuery = matchMedia('(prefers-color-scheme: light)');
function applyAppearance(next) {
  appearance = { ...appearance, ...next };
  if (!COLORS[appearance.color]) appearance.color = 'violet';
  const d = document.documentElement.dataset;
  d.color = appearance.color;
  d.black = appearance.black ? '1' : '0';
  d.dd = ['floating', 'compact', 'chips'].includes(appearance.dd) ? appearance.dd : 'floating';
  d.mode = appearance.mode === 'system' ? (lightQuery.matches ? 'light' : 'dark') : appearance.mode === 'light' ? 'light' : 'dark';
  try { localStorage.setItem('ss.appearance', JSON.stringify(appearance)); } catch { /* optional */ }
}
lightQuery.addEventListener('change', () => { if (appearance.mode === 'system') applyAppearance({}); });

const resLabel = (r) => (r === '2160p' ? '4K' : r);
const RES_ORDER = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];

// ---------- cards ----------
function card(m, prog, onRemove, onOpen) {
  const id = m.id || m.imdb_id;
  const play = h('button', { class: 'playbtn', title: 'Play', 'aria-label': `Play ${m.name}`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); (onOpen || quickPlay)(m); } });
  setIcon(play, 'play');
  const c = h('a', { class: 'card', href: `#/detail/${m.type}/${id}` },
    h('div', { class: 'img', style: m.poster ? `background-image:url("${encodeURI(m.poster)}")` : '' },
      m.imdbRating && h('span', { class: 'rate' }, '★ ' + m.imdbRating), play),
    h('div', { class: 't' }, m.name, (m.releaseInfo || m.year || m.season) && h('small', {}, m.season ? `S${m.season} E${m.episode}` : m.releaseInfo || m.year)));
  if (!onRemove && !libraryIds.has(id) && /^tt\d+$/.test(id)) {
    const a = h('button', { class: 'rm add', title: 'Add to library', 'aria-label': 'Add to library', onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        await api('/library/add', { id, type: m.type, name: m.name, poster: m.poster, genres: m.genres || [] });
        libraryIds.add(id); a.remove(); toast('Added to library');
      } catch (err) { toast(err.message); }
    } });
    setIcon(a, 'plus'); c.append(a);
  }
  if (onRemove) {
    const x = h('button', { class: 'rm', title: 'Remove', 'aria-label': 'Remove', onclick: (e) => { e.preventDefault(); e.stopPropagation(); onRemove(c); } });
    setIcon(x, 'close'); c.append(x);
  }
  if (onOpen) {
    c.addEventListener('click', (e) => { e.preventDefault(); onOpen(m); });
    const i = h('a', { class: 'rm info', title: 'Details', 'aria-label': 'Details', href: `#/detail/${m.type}/${id}`, onclick: (e) => e.stopPropagation() });
    setIcon(i, 'info'); c.append(i);
  }
  if (prog && prog.dur) c.append(h('div', { class: 'prog' }, h('i', { style: `width:${Math.min(100, (prog.pos / prog.dur) * 100)}%` })));
  return c;
}
const scroller = (items, prog, onRemove, onOpen) => h('div', { class: 'scroller' }, items.map((m) => card(m, prog && prog(m), onRemove, onOpen)));
const skeletons = (n = 8) => h('div', { class: 'scroller' }, Array.from({ length: n }, () => h('div', { class: 'skel' })));
const section = (title, body) => [h('h2', { class: 'sec' }, title), body];

// ---------- views ----------
async function home() {
  view.replaceChildren(h('div', { style: 'height:360px' }), ...section('Popular movies', skeletons()));
  const [libR, moviesR, seriesR, cfgR] = await Promise.allSettled([api('/library'), api('/catalog?type=movie'), api('/catalog?type=series'), api('/config')]);
  const lib = libR.status === 'fulfilled' ? libR.value : { continueWatching: [] };
  if (lib.library) { libraryIds.clear(); lib.library.forEach((m) => libraryIds.add(m.id)); }
  const cfg = cfgR.status === 'fulfilled' ? cfgR.value : { hasRealDebridKey: true };
  const movies = moviesR.status === 'fulfilled' ? moviesR.value : [];
  const series = seriesR.status === 'fulfilled' ? seriesR.value : [];
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
    const remove = async (el) => { await api('/continue/remove', { id: el.dataset.id }); const row = el.parentElement; el.remove(); if (!row.children.length) { row.previousElementSibling.remove(); row.remove(); } };
    const list = scroller(lib.continueWatching.map((c) => ({ ...c, name: c.name })), (m) => byId.get(m.id), remove, resumeWatching);
    [...list.children].forEach((el, i) => { el.dataset.id = lib.continueWatching[i].id; });
    out.push(...section('Continue watching', list));
  }
  const moreTile = (type) => {
    const t = h('a', { class: 'card more', href: `#/discover/${type}` }, h('span', { 'data-icon': 'arrowRight' }), 'Load more');
    setIcon(t.firstChild, 'arrowRight'); return t;
  };
  const row = (title, r, items, type) => {
    if (r.status !== 'fulfilled') return section(title, retryBox(r.reason, () => home()));
    const list = scroller(items); list.append(moreTile(type));
    return section(title, list);
  };
  out.push(...row('Popular movies', moviesR, movies, 'movie'), ...row('Popular series', seriesR, series, 'series'));
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
  const results = await Promise.allSettled([api(`/catalog?type=movie&q=${encodeURIComponent(q)}`), api(`/catalog?type=series&q=${encodeURIComponent(q)}`)]);
  const part = (title, r, noun) => section(title, r.error ? retryBox(r.error, () => searchView(q))
    : r.value.length ? h('div', { class: 'grid' }, r.value.map((x) => card(x))) : h('div', { class: 'empty' }, `No ${noun} found.`));
  view.replaceChildren(...part(`Movies for “${q}”`, settled(results, 0), 'movies'), ...part('Series', settled(results, 1), 'series'));
}

async function libraryView() {
  const { library } = await api('/library');
  const saved = (() => { try { return JSON.parse(localStorage.getItem('ss.libraryFilter')) || {}; } catch { return {}; } })();
  let type = ['movie', 'series'].includes(saved.type) ? saved.type : 'all', genre = saved.genre || '';
  const items = [...library];
  const body = h('div');
  const genresFor = (t) => [...new Set(items.filter((m) => t === 'all' || m.type === t).flatMap((m) => m.genres || []))].sort();
  const seg = h('div', { class: 'seg' });
  const sel = h('select', { class: 'pill', onchange: () => { genre = sel.value; render(); } });

  async function remove(el) {
    await api('/library/remove', { id: el.dataset.id });
    libraryIds.delete(el.dataset.id);
    items.splice(items.findIndex((m) => m.id === el.dataset.id), 1);
    render();
  }
  const gridOf = (list) => h('div', { class: 'grid' }, list.map((x) => { const c = card(x, null, remove); c.dataset.id = x.id; return c; }));

  function render() {
    try { localStorage.setItem('ss.libraryFilter', JSON.stringify({ type, genre })); } catch { /* optional */ }
    seg.replaceChildren(...[['all', 'All'], ['movie', 'Movies'], ['series', 'Series']].map(([v, label]) =>
      h('button', { class: type === v ? 'on' : '', onclick: () => { type = v; render(); } }, label)));
    const genres = genresFor(type);
    if (genre && !genres.includes(genre)) genre = '';
    sel.replaceChildren(h('option', { value: '' }, 'All genres'), ...genres.map((g) => h('option', { value: g, selected: g === genre }, g)));
    sel.hidden = !genres.length;

    const byName = (a, b) => a.name.localeCompare(b.name);
    const out = [];
    // Sorted by type first (movies, then series), then by genre.
    for (const t of type === 'all' ? ['movie', 'series'] : [type]) {
      const list = items.filter((m) => m.type === t && (!genre || (m.genres || []).includes(genre))).sort(byName);
      if (!list.length) continue;
      if (type === 'all') out.push(h('h2', { class: 'sec' }, t === 'movie' ? 'Movies' : 'Series', h('span', { class: 'count' }, list.length)));
      if (genre) { out.push(gridOf(list)); continue; }
      const groups = new Map();
      for (const m of list) { const g = (m.genres || [])[0] || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m); }
      const names = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
      for (const g of names) {
        if (names.length > 1) out.push(h('h3', { class: 'grp' }, g, h('span', { class: 'count' }, groups.get(g).length)));
        out.push(gridOf(groups.get(g)));
      }
    }
    body.replaceChildren(...(out.length ? out : [h('div', { class: 'empty' }, items.length ? 'Nothing matches those filters.' : 'Nothing saved yet. Open a title and press “+ Library”.')]));
  }
  view.replaceChildren(h('h2', { class: 'sec' }, 'My library'), h('div', { class: 'filters' }, seg, sel), body);
  render();
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
    picks: res.picks, hidden: res.hidden, languageFallback: !!res.languageFallback, total: res.total, language: res.language, subs,
    series: ep ? { episodes, load: (e) => buildContext(base, e.vid, e, episodes) } : null,
    next: nxt ? { label: label(nxt), load: () => buildContext(base, nxt.vid, nxt, episodes) } : null,
  };
}

function bestPick(ctx, preferred) {
  const order = (r) => RES_ORDER.indexOf(r);
  const atOrBelow = ctx.picks.filter((p) => order(p.resolution) >= order(preferred));
  return (atOrBelow[0] || ctx.picks[ctx.picks.length - 1]).resolution;
}

function streamChips(s, showLangs) {
  return h('div', { class: 'chips' },
    h('span', { class: 'chip ' + (s.cached ? 'ok' : 'warn') }, s.cached ? 'cached' : 'not cached'),
    s.size > 0 && h('span', { class: 'chip' }, fmtSize(s.size)), s.source && h('span', { class: 'chip' }, s.source),
    s.codec && h('span', { class: 'chip' }, s.codec), s.hdr && h('span', { class: 'chip' }, 'HDR'),
    s.audioLangs && s.audioLangs.length > 0 && h('span', { class: 'chip ok' }, '🔊 ' + s.audioLangs.join('/')),
    showLangs && h('span', { class: 'chip warn' }, '🔊 ' + (s.langs && s.langs.length ? s.langs.join(' / ') : 'language unknown')),
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
    ctx.languageFallback && h('div', { class: 'notice warn' }, `No ${ctx.language} streams were found for this title, so every available stream is shown. Check each one's audio language.`),
    h('div', { class: 'picks' }, ctx.picks.map((p) => h('div', { class: 'pick' },
      h('div', { class: 'q r' + p.resolution }, resLabel(p.resolution)),
      h('div', { class: 'fn' }, p.stream.filename), streamChips(p.stream, ctx.languageFallback),
      h('div', {}, h('button', { class: 'btn sm', onclick: () => Player.open(ctx, p.resolution) }, '▶ Play')),
      p.alternatives.length > 0 && h('details', { class: 'alts' }, h('summary', {}, `${p.alternatives.length} other options`),
        p.alternatives.map((a) => h('div', { class: 'alt' }, h('span', {}, `${fmtSize(a.size)} · ${a.source || '?'} ${a.codec} · 👤${a.seeders}`),
          h('button', { class: 'btn ghost sm', onclick: () => Player.open(withAlt(p.resolution, a), p.resolution) }, 'Play'))))))),
    h('p', { class: 'subtle', style: 'margin:12px 0 0' }, note)));
}

/** Regular episodes (specials only if there is nothing else), sorted, with watched flags. */
function buildEpisodes(meta, id) {
  const all = (meta.videos || []).filter((v) => v.season != null && v.episode != null);
  const regular = all.filter((v) => v.season > 0);
  return (regular.length ? regular : all)
    .map((v) => ({ vid: `${id}:${v.season}:${v.episode}`, season: v.season, episode: v.episode, title: v.name || v.title || `Episode ${v.episode}`, watched: !!meta.watched[`series:${id}:${v.season}:${v.episode}`] }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Where to pick a series up: the episode in progress, else the one after the last finished, else the first unwatched. */
function startEpisode(meta, episodes) {
  const last = meta.lastWatched, li = last ? episodes.findIndex((e) => e.vid === last.videoId) : -1;
  if (li >= 0) return last.finished ? episodes[li + 1] || episodes[li] : episodes[li];
  return episodes.find((e) => !e.watched) || episodes[0];
}

/** Play button on a cover: straight into playback with no detail page (best stream, or where you left off). */
const quickPlay = (m) => resumeWatching({ id: m.id || m.imdb_id, type: m.type, name: m.name, poster: m.poster });

/** Continue watching: reopen the same stream (or the closest match) at the saved position. */
async function resumeWatching(item) {
  const detailHash = `#/detail/${item.type}/${item.id}`;
  const base = { id: item.id, type: item.type, name: item.name, poster: item.poster };
  toast(item.pos ? 'Resuming…' : 'Finding the best stream…');
  try {
    const cfg = await api('/config');
    let ctx;
    if (item.type === 'series') {
      // Pinned series have no saved episode yet, so work out where to start from the watch history.
      const meta = await api(`/meta?type=series&id=${item.id}`);
      const episodes = buildEpisodes(meta, item.id);
      const ep = (item.videoId && episodes.find((e) => e.vid === item.videoId)) || startEpisode(meta, episodes);
      if (!ep) throw new Error('No episodes listed for this series');
      ctx = await buildContext(base, ep.vid, ep, episodes);
    } else ctx = await buildContext(base, item.id, null);
    if (!ctx.picks.length) { toast('No streams available right now'); location.hash = detailHash; return; }
    const saved = item.stream || (await api('/resume?key=' + encodeURIComponent(ctx.key)).catch(() => ({}))).stream || {};
    let res = ctx.picks.some((p) => p.resolution === saved.resolution) ? saved.resolution : bestPick(ctx, cfg.preferredResolution);
    for (const p of ctx.picks) { // prefer the exact release that was playing
      const hit = [p.stream, ...p.alternatives].find((s) => saved.filename && s.filename === saved.filename);
      if (hit) { ctx = { ...ctx, picks: ctx.picks.map((q) => (q === p ? { ...q, stream: hit } : q)) }; res = p.resolution; break; }
    }
    Player.open(ctx, res);
  } catch (e) { toast(e.message); location.hash = detailHash; }
}

/** "More in this collection": sequels, prequels and spin-offs from TMDB's franchise data (needs a TMDB key). */
async function loadCollection(box, id) {
  try {
    const c = await api('/collection?id=' + id);
    if (!c.parts || c.parts.length < 2) return;
    const here = c.parts.findIndex((p) => p.id === id);
    const cards = c.parts.map((p, i) => {
      const el = card({ id: p.id, type: 'movie', name: p.name, poster: p.poster, releaseInfo: [p.year, i === here + 1 && 'Next'].filter(Boolean).join(' · ') });
      if (p.id === id) { el.classList.add('current'); el.removeAttribute('href'); el.title = 'You are here'; el.querySelector('.playbtn')?.remove(); el.querySelector('.add')?.remove(); }
      return el;
    });
    box.replaceChildren(h('h2', { class: 'sec' }, c.name, h('span', { class: 'count' }, `${c.parts.length} films`)), h('div', { class: 'scroller' }, cards));
  } catch { /* the collection row is a bonus; stay quiet on failure */ }
}

async function detail(type, id) {
  view.replaceChildren(h('div', { class: 'empty', style: 'margin-top:40px' }, 'Loading…'));
  const [meta, cfg] = await Promise.all([api(`/meta?type=${type}&id=${id}`), api('/config')]);
  const base = { id, type, name: meta.name, poster: meta.poster, genres: meta.genres || [] };
  const streamsBox = h('div');
  const playBtn = h('button', { class: 'btn', disabled: true }, 'Finding streams…');
  const libBtn = h('button', { class: 'btn ghost' }, meta.inLibrary ? '✓ In library' : '+ Library');
  libBtn.onclick = async () => { const r = await api('/library', base); r.inLibrary ? libraryIds.add(id) : libraryIds.delete(id); libBtn.textContent = r.inLibrary ? '✓ In library' : '+ Library'; };
  let inContinue = !!meta.inContinue;
  const keepLabel = () => (inContinue ? '✓ Keep watching' : '+ Keep watching');
  const keepBtn = h('button', { class: 'btn ghost', title: 'Show this title in Continue watching on the home page' }, keepLabel());
  keepBtn.onclick = async () => {
    await api(inContinue ? '/continue/remove' : '/continue/add', base);
    inContinue = !inContinue; keepBtn.textContent = keepLabel();
    toast(inContinue ? 'Added to Continue watching' : 'Removed from Continue watching');
  };

  const metaLine = [meta.year || meta.releaseInfo, meta.runtime].filter(Boolean);
  const backIcon = h('span', { style: 'display:inline-flex' });
  setIcon(backIcon, 'back');
  const backBtn = h('button', { class: 'btn ghost sm back', onclick: goBack }, backIcon, 'Back');
  const hero = h('div', { class: 'dhero', style: meta.background ? `background-image:url("${encodeURI(meta.background)}")` : '' },
    h('div', { class: 'backbar' }, backBtn),
    h('div', { class: 'dwrap' },
      meta.poster && h('img', { class: 'poster', src: meta.poster, alt: '' }),
      h('div', { class: 'dinfo' }, h('h1', {}, meta.name),
        h('div', { class: 'meta' }, meta.imdbRating && h('span', { class: 'star' }, '★ ' + meta.imdbRating), metaLine.map((c) => h('span', { class: 'dot' }, c))),
        h('div', { class: 'chips' }, (meta.genres || []).map((g) => h('span', { class: 'chip' }, g))),
        h('p', { class: 'desc' }, meta.description || ''),
        meta.cast && h('div', { class: 'subtle' }, 'Cast: ' + meta.cast.slice(0, 6).join(', ')),
        h('div', { class: 'actions' }, playBtn, keepBtn, libBtn))));

  function ready(ctx) {
    renderStreams(streamsBox, ctx, cfg);
    if (ctx.picks.length) {
      const res = bestPick(ctx, cfg.preferredResolution);
      playBtn.disabled = false; playBtn.textContent = `▶ Play ${resLabel(res)}`; playBtn.onclick = () => Player.open(ctx, res);
    } else { playBtn.disabled = true; playBtn.textContent = 'No streams'; }
  }
  const fail = (e) => { streamsBox.replaceChildren(showErr(e)); playBtn.textContent = 'Unavailable'; };

  if (type === 'movie') {
    const collBox = h('div');
    view.replaceChildren(hero, h('div', { style: 'margin-top:24px' }, streamsBox), collBox);
    loadCollection(collBox, id);
    streamsBox.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'skel', style: 'aspect-ratio:auto;height:90px;flex:none' })));
    buildContext(base, id, null).then(ready, fail);
    return;
  }

  // Series: episode list on the left, streams for the selected episode on the right.
  const episodes = buildEpisodes(meta, id);
  const seasons = [...new Set(episodes.map((e) => e.season))];
  // Reopen where the user left off: the episode in progress, or the one after the last one they finished.
  const start = startEpisode(meta, episodes);

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
  const save = (patch) => api('/config', patch).catch((e) => toast(e.message));
  const modeSeg = h('div', { class: 'seg' });
  const swatches = h('div', { class: 'themes' });
  const ddSeg = h('div', { class: 'seg' });
  const blackBox = h('input', { type: 'checkbox', checked: appearance.black, onchange: () => { applyAppearance({ black: blackBox.checked }); save({ pureBlack: blackBox.checked }); drawAppearance(); } });
  const blackRow = h('label', { class: 'check' }, blackBox, h('div', {}, h('div', {}, 'True black background'), h('small', { class: 'subtle' }, 'Dark mode only. Saves power on OLED screens.')));
  function drawAppearance() {
    const dark = document.documentElement.dataset.mode === 'dark';
    modeSeg.replaceChildren(...[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']].map(([m, label]) =>
      h('button', { type: 'button', class: appearance.mode === m ? 'on' : '', onclick: () => { applyAppearance({ mode: m }); save({ themeMode: m }); drawAppearance(); } }, label)));
    ddSeg.replaceChildren(...[['floating', 'Floating'], ['compact', 'Compact'], ['chips', 'Chips']].map(([v, label]) =>
      h('button', { type: 'button', class: appearance.dd === v ? 'on' : '', onclick: () => { applyAppearance({ dd: v }); save({ dropdownStyle: v }); drawAppearance(); } }, label)));
    blackRow.hidden = !dark;
    swatches.replaceChildren(...Object.entries(COLORS).map(([id, c]) => {
      const bg = dark ? (appearance.black ? '#000' : `hsl(${c.h} ${c.sat}% 5.5%)`) : `hsl(${c.h} ${c.sat * 1.5}% 96%)`;
      const bar = dark ? `hsl(${c.h} ${c.sat}% ${appearance.black ? 12 : 18.5}%)` : `hsl(${c.h} ${c.sat * 1.2}% 88%)`;
      const accent = dark ? `hsl(${c.ah} 100% 68%)` : `hsl(${c.ah} 78% 54%)`;
      return h('button', { type: 'button', class: 'theme' + (appearance.color === id ? ' on' : ''), onclick: () => { applyAppearance({ color: id }); save({ themeColor: id }); drawAppearance(); } },
        h('span', { class: 'sw', style: `background:${bg}` }, h('i', { style: `top:10px;right:28px;background:${bar}` }), h('i', { style: `top:24px;right:50px;background:${bar}` }), h('b', { style: `background:${accent}` })), h('span', {}, c.name));
    }));
  }
  drawAppearance();
  f.append(
    h('div', { class: 'card2' }, h('h2', {}, 'Appearance'),
      h('div', { class: 'row2' }, h('span', {}, 'Mode'), modeSeg), blackRow,
      h('div', { class: 'field' }, h('span', {}, 'Color'), swatches),
      h('div', { class: 'row2' }, h('span', {}, 'Dropdown style'), ddSeg)),
    h('div', { class: 'card2' }, h('h2', {}, 'Accounts'),
      field(`Real-Debrid API key${cfg.hasRealDebridKey ? ` — saved (ends ${cfg.realDebridKeyHint})` : ''}`, text('realDebridKey', 'password', cfg.hasRealDebridKey ? 'Leave blank to keep the saved key' : 'real-debrid.com/apitoken'), 'Stored only on this computer.'),
      field(`TMDB API key (optional)${cfg.hasTmdbKey ? ' — saved' : ''}`, text('tmdbKey', 'password', cfg.hasTmdbKey ? 'Leave blank to keep the saved key' : 'themoviedb.org/settings/api'),
        'Adds a "collection" row to movie pages linking sequels, prequels and spin-offs. A free TMDB account gives you a key.'),
      cfg.hasTmdbKey && check('clearTmdbKey', 'Remove the saved TMDB key'),
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
// In-app history: lets the Back button return to the previous page and restore where you had scrolled to.
const nav = { stack: [], scroll: new Map() };
const goBack = () => (nav.stack.length > 1 ? history.back() : (location.hash = '#/'));

async function route() {
  const hash = location.hash || '#/';
  const [, page, a, b] = hash.split('/');
  const here = nav.stack[nav.stack.length - 1];
  if (here !== undefined) nav.scroll.set(here, window.scrollY); // where the page we're leaving was scrolled to
  let restore = 0;
  if (here === hash) restore = window.scrollY;                                   // re-render of the same page (e.g. player closed)
  else if (nav.stack[nav.stack.length - 2] === hash) { nav.stack.pop(); restore = nav.scroll.get(hash) || 0; } // going back
  else nav.stack.push(hash);
  document.querySelectorAll('#top [data-nav]').forEach((n) => n.classList.toggle('on', n.dataset.nav === (page || 'home')));
  try {
    if (!page) await home();
    else if (page === 'discover') await discover(a === 'series' ? 'series' : 'movie');
    else if (page === 'search') await searchView(decodeURIComponent(a));
    else if (page === 'library') await libraryView();
    else if (page === 'detail') await detail(a, b);
    else if (page === 'settings') await settings();
  } catch (e) { view.replaceChildren(showErr(e)); }
  window.scrollTo(0, restore);
}
window.onPlayerClosed = () => { if (/^#?\/?$|detail/.test(location.hash.replace('#', '')) || !location.hash) route(); };
addEventListener('hashchange', route);
$('#search').onsubmit = (e) => {
  e.preventDefault();
  const input = e.target.elements.q, q = input.value.trim();
  if (q) location.hash = '#/search/' + encodeURIComponent(q);
  input.value = ''; input.blur(); // the box is for the next search; the results page shows what was searched
};

// Over a horizontally scrolling row the wheel scrolls that row, not the page.
view.addEventListener('wheel', (e) => {
  const row = e.target.closest && e.target.closest('.scroller');
  if (!row || row.scrollWidth <= row.clientWidth || e.ctrlKey) return;
  if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) { e.preventDefault(); row.scrollLeft += e.deltaY; }
}, { passive: false });
Promise.allSettled([api('/info'), api('/library'), api('/config')]).then(([info, lib, cfg]) => {
  if (info.status === 'fulfilled') APPINFO = info.value;
  if (lib.status === 'fulfilled') lib.value.library.forEach((m) => libraryIds.add(m.id));
  if (cfg.status === 'fulfilled') applyAppearance({ color: cfg.value.themeColor, mode: cfg.value.themeMode, black: cfg.value.pureBlack, dd: cfg.value.dropdownStyle });
}).finally(route);
