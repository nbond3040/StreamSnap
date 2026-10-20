'use strict';
/* Live TV: a category list on the left, channels on the right (logo, name, what's on now), click to watch.
   Uses h()/api()/toast()/setIcon() from app.js at call time. */
const Live = (() => {
  const $ = (s) => document.querySelector(s);
  const PAGE = 60; // rows rendered at a time
  let data = null, fav = new Set(), epg = new Map(); // epg: channel id -> { at, list }
  let playlist = [], idx = -1, current = null;

  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const nowOf = (list, t = Date.now()) => (list || []).find((p) => p.start <= t && p.end > t);
  const nextOf = (list, t = Date.now()) => (list || []).find((p) => p.start > t);
  const initials = (n) => n.replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'TV';

  async function fetchEpg(ids) {
    const need = ids.filter((id) => !epg.has(id) || Date.now() - epg.get(id).at > 3 * 60 * 1000);
    for (let i = 0; i < need.length; i += 30) {
      try {
        const out = await api('/live/epg?ids=' + need.slice(i, i + 30).join(','));
        for (const [id, list] of Object.entries(out)) epg.set(Number(id), { at: Date.now(), list });
      } catch { /* the list still works without programme info */ }
    }
  }

  // ---------- data helpers ----------
  let cfg = { liveLayout: 'grouped', liveTextSize: 'large', liveTidyNames: true };
  let cats = [], catById = new Map(), hidden = new Set();
  const state = { sel: { type: 'fav' }, q: '', catQ: '' };
  const store = (k, v) => { try { v === undefined ? JSON.parse(localStorage.getItem(k)) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* optional */ } };
  const recall = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const n = (x) => x.toLocaleString();

  const isSep = (name) => /^[#=*~_\-\s]{2,}.*[#=*~_\-\s]{2,}$/.test(name) && /[A-Za-z0-9]/.test(name);
  const cleanLabel = (name) => name.replace(/^[#=*~_\-\s]+|[#=*~_\-\s]+$/g, '').trim();
  /** "US| ESPN HD" -> "ESPN HD" (the country is already shown by the category) */
  const disp = (ch) => (cfg.liveTidyNames ? cleanLabel(ch.name.replace(/^\s*[A-Za-z0-9+]{1,5}\s*\|\s*/, '')) : cleanLabel(ch.name)) || ch.name;

  function prepare() {
    hidden = new Set(data.hidden || []);
    const counts = new Map();
    for (const c of data.channels) counts.set(c.cat, (counts.get(c.cat) || 0) + 1);
    cats = data.categories.map((c) => {
      const m = /^\s*([^|]{1,12}?)\s*\|\s*(.+)$/.exec(c.name);
      return { id: c.id, name: c.name, region: m ? m[1].trim().toUpperCase() : 'Other', label: m ? m[2].trim() : c.name, count: counts.get(c.id) || 0 };
    }).filter((c) => c.count > 0);
    catById = new Map(cats.map((c) => [c.id, c]));
  }
  const shownCats = () => cats.filter((c) => !hidden.has(c.id));
  function regions() {
    const map = new Map();
    for (const c of shownCats()) { if (!map.has(c.region)) map.set(c.region, { name: c.region, cats: [], count: 0 }); const r = map.get(c.region); r.cats.push(c); r.count += c.count; }
    return [...map.values()].sort((a, b) => (a.name === 'Other') - (b.name === 'Other') || b.count - a.count);
  }

  /** The channels for the current selection, or global search results when something is typed. */
  function pool() {
    const q = state.q.trim().toLowerCase(), s = state.sel;
    const shown = new Set(shownCats().map((c) => c.id));
    if (q) return data.channels.filter((c) => shown.has(c.cat) && !isSep(c.name) && (c.name.toLowerCase().includes(q) || String(c.num) === q));
    if (s.type === 'fav') return data.channels.filter((c) => fav.has(c.id));
    if (s.type === 'cat') return data.channels.filter((c) => c.cat === s.id);
    if (s.type === 'region') return data.channels.filter((c) => shown.has(c.cat) && catById.get(c.cat).region === s.id);
    return data.channels.filter((c) => shown.has(c.cat)); // all
  }
  function title() {
    const s = state.sel;
    if (state.q.trim()) return `Results for “${state.q.trim()}”`;
    if (s.type === 'fav') return 'Favorites';
    if (s.type === 'region') return s.id;
    if (s.type === 'cat') { const c = catById.get(s.id); return c ? `${c.region === 'Other' ? '' : c.region + ' · '}${c.label}` : 'Channels'; }
    return 'All channels';
  }
  function choose(sel) { state.sel = sel; state.q = ''; store('ss.liveSel', sel); draw(); }

  // ---------- the page ----------
  async function view() {
    const root = $('#view');
    root.replaceChildren(h('div', { class: 'empty', style: 'margin-top:40px' }, 'Loading channels…'));
    try { [data, cfg] = await Promise.all([api('/live/browse'), api('/config')]); }
    catch (e) { return root.replaceChildren(h('div', { class: 'live-empty' }, h('h2', {}, 'Couldn’t load Live TV'), h('p', { class: 'subtle' }, e.message), h('div', { class: 'row2', style: 'justify-content:center' }, h('button', { class: 'btn', onclick: view }, 'Try again'), h('a', { class: 'btn ghost', href: '#/settings' }, 'Settings')))); }
    if (!data.configured) {
      return root.replaceChildren(h('div', { class: 'live-empty' }, h('h2', {}, 'Live TV isn’t set up yet'),
        h('p', { class: 'subtle' }, 'Add your Xtream server, username and password in Settings to watch live channels.'), h('a', { class: 'btn', href: '#/settings' }, 'Open Settings')));
    }
    document.documentElement.dataset.livesize = cfg.liveTextSize || 'large';
    fav = new Set(data.favorites);
    prepare();
    const saved = recall('ss.liveSel', null);
    const valid = saved && (saved.type === 'all' || saved.type === 'fav' || saved.type === 'home' || (saved.type === 'cat' && catById.has(saved.id) && !hidden.has(saved.id)) || (saved.type === 'region' && regions().some((r) => r.name === saved.id)));
    state.sel = valid ? saved : fav.size ? { type: 'fav' } : { type: 'home' };
    state.q = ''; state.catQ = '';
    draw();
  }

  let listBox, rowsObs;
  function draw() {
    const root = $('#view'), layout = cfg.liveLayout;
    if (layout !== 'drilldown' && state.sel.type === 'home') state.sel = fav.size ? { type: 'fav' } : { type: 'all' };
    listBox = h('div', { class: 'live-list' });
    const search = h('input', { type: 'search', placeholder: 'Search all channels', value: state.q, autocomplete: 'off' });
    let t; search.oninput = () => { state.q = search.value; clearTimeout(t); t = setTimeout(() => { drawBreadcrumb(); fillList(); }, 160); };
    const manage = h('button', { class: 'btn ghost sm', onclick: manageCategories }, 'Manage categories');
    const crumb = h('div', { class: 'crumb' });
    function drawBreadcrumb() { if (layout === 'drilldown') drawCrumb(crumb); }

    if (layout === 'dropdowns') root.replaceChildren(h('div', { class: 'live live-col' }, toolbar(search, manage), listBox));
    else if (layout === 'drilldown') root.replaceChildren(h('div', { class: 'live live-col' }, h('div', { class: 'live-bar' }, crumb, search, manage), listBox));
    else root.replaceChildren(h('div', { class: 'live' }, rail(search, manage), listBox));
    drawBreadcrumb(); fillList();
  }

  // --- layout 1: grouped sidebar (regions you can expand) ---
  const open = new Set(recall('ss.liveOpen', []));
  function rail(search, manage) {
    const el = h('div', { class: 'live-rail' });
    const catSearch = h('input', { type: 'search', placeholder: 'Find a category', value: state.catQ, autocomplete: 'off', oninput: () => { state.catQ = catSearch.value; paint(); catSearch.focus(); } });
    const item = (label, count, on, click, cls = '') => h('button', { class: `cat ${cls}` + (on ? ' on' : ''), onclick: click }, h('span', {}, label), h('small', {}, n(count)));
    function paint() {
      const q = state.catQ.trim().toLowerCase(), s = state.sel;
      const total = shownCats().reduce((a, c) => a + c.count, 0);
      const groups = regions().map((r) => {
        const hit = q ? r.cats.filter((c) => (r.name + ' ' + c.label).toLowerCase().includes(q)) : r.cats;
        return { r, hit };
      }).filter((g) => g.hit.length);
      el.replaceChildren(h('div', { class: 'live-search' }, search), h('div', { class: 'live-search' }, catSearch),
        h('div', { class: 'cats' },
          item('All channels', total, s.type === 'all' && !state.q, () => choose({ type: 'all' })),
          item('★ Favorites', fav.size, s.type === 'fav' && !state.q, () => choose({ type: 'fav' })),
          ...groups.flatMap(({ r, hit }) => {
            const isOpen = open.has(r.name) || !!q || (s.type === 'cat' && catById.get(s.id)?.region === r.name) || (s.type === 'region' && s.id === r.name);
            const head = h('button', { class: 'region' + (isOpen ? ' open' : ''), onclick: () => { open.has(r.name) ? open.delete(r.name) : open.add(r.name); store('ss.liveOpen', [...open]); paint(); } },
              h('span', { class: 'chev' }), h('span', {}, r.name), h('small', {}, n(r.count)));
            return [head, ...(isOpen ? [item(`All ${r.name}`, r.count, s.type === 'region' && s.id === r.name && !state.q, () => choose({ type: 'region', id: r.name }), 'sub all'),
              ...hit.map((c) => item(c.label, c.count, s.type === 'cat' && s.id === c.id && !state.q, () => choose({ type: 'cat', id: c.id }), 'sub'))] : [])];
          }),
          !groups.length && h('div', { class: 'subtle', style: 'padding:10px 12px' }, 'No matching categories')),
        manage);
    }
    paint();
    return el;
  }

  // --- layout 2: dropdowns above the list ---
  function toolbar(search, manage) {
    const rs = regions(), s = state.sel;
    const regionOf = s.type === 'region' ? s.id : s.type === 'cat' ? catById.get(s.id)?.region : null;
    const total = shownCats().reduce((a, c) => a + c.count, 0);
    const regSel = h('select', { onchange: () => { const v = regSel.value; choose(v === 'fav' ? { type: 'fav' } : v === 'all' ? { type: 'all' } : { type: 'region', id: v }); } },
      h('option', { value: 'fav' }, `★ Favorites (${n(fav.size)})`), h('option', { value: 'all' }, `All channels (${n(total)})`),
      ...rs.map((r) => h('option', { value: r.name }, `${r.name} (${n(r.count)})`)));
    regSel.value = s.type === 'fav' ? 'fav' : s.type === 'all' ? 'all' : regionOf || 'all';
    const catSel = regionOf ? h('select', { onchange: () => choose(catSel.value === '*' ? { type: 'region', id: regionOf } : { type: 'cat', id: catSel.value }) },
      h('option', { value: '*' }, `All ${regionOf}`), ...(rs.find((r) => r.name === regionOf)?.cats || []).map((c) => h('option', { value: c.id }, `${c.label} (${n(c.count)})`))) : null;
    if (catSel) catSel.value = s.type === 'cat' ? s.id : '*';
    return h('div', { class: 'live-bar' }, regSel, catSel, search, manage);
  }

  // --- layout 3: drill down through big tiles ---
  function drawCrumb(el) {
    const s = state.sel, parts = [h('button', { onclick: () => choose({ type: 'home' }) }, 'Live TV')];
    if (s.type === 'fav') parts.push(h('span', {}, 'Favorites'));
    else if (s.type === 'all') parts.push(h('span', {}, 'All channels'));
    else if (s.type === 'region') parts.push(s.list ? h('span', {}, s.id) : h('span', {}, s.id));
    else if (s.type === 'cat') { const c = catById.get(s.id); if (c && c.region !== 'Other') parts.push(h('button', { onclick: () => choose({ type: 'region', id: c.region }) }, c.region)); parts.push(h('span', {}, c ? c.label : '')); }
    el.replaceChildren(...parts.flatMap((p, i) => (i ? [h('i', { class: 'sepc' }, '›'), p] : [p])));
  }
  function tiles() {
    const s = state.sel, tile = (label, count, click, cls = '') => h('button', { class: 'tile ' + cls, onclick: click }, h('b', {}, label), h('small', {}, `${n(count)} channels`));
    if (s.type === 'home') {
      const total = shownCats().reduce((a, c) => a + c.count, 0);
      return h('div', { class: 'tiles' }, tile('★ Favorites', fav.size, () => choose({ type: 'fav' }), 'accent'), tile('All channels', total, () => choose({ type: 'all' })), ...regions().map((r) => tile(r.name, r.count, () => choose({ type: 'region', id: r.name }))));
    }
    const r = regions().find((x) => x.name === s.id);
    return h('div', { class: 'tiles' }, tile(`All ${s.id}`, r ? r.count : 0, () => choose({ type: 'region', id: s.id, list: true }), 'accent'), ...(r ? r.cats : []).map((c) => tile(c.label, c.count, () => choose({ type: 'cat', id: c.id }))));
  }

  // --- the channel list (shared) ---
  function fillList() {
    rowsObs && rowsObs.disconnect();
    const s = state.sel;
    if (cfg.liveLayout === 'drilldown' && !state.q.trim() && (s.type === 'home' || (s.type === 'region' && !s.list))) { listBox.replaceChildren(tiles()); return; }
    const rows = pool();
    const body = h('div', { class: 'rows' });
    listBox.replaceChildren(h('div', { class: 'live-head' }, h('h2', {}, title()), h('span', { class: 'count' }, n(rows.length))),
      h('div', { class: 'live-cols' }, h('span', { class: 'c-ch' }, 'Channel'), h('span', { class: 'c-now' }, 'On now'), h('span', { class: 'c-next' }, 'Up next')), body);
    if (!rows.length) { body.append(h('div', { class: 'empty' }, state.q.trim() ? 'No channels match your search.' : s.type === 'fav' ? 'No favorites yet. Tap ☆ on a channel to add it.' : 'No channels here.')); return; }
    const playable = rows.filter((c) => !isSep(c.name));
    let shown = 0; const pending = new Set(); let timer;
    rowsObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.target.classList.contains('sentinel')) { more(); continue; }
        pending.add(Number(e.target.dataset.id)); rowsObs.unobserve(e.target);
      }
      clearTimeout(timer);
      timer = setTimeout(async () => { const ids = [...pending]; pending.clear(); if (!ids.length) return; await fetchEpg(ids); ids.forEach(paint); }, 150);
    }, { rootMargin: '300px' });
    const sentinel = h('div', { class: 'sentinel' });
    function more() {
      sentinel.remove();
      for (const ch of rows.slice(shown, shown + PAGE)) {
        if (isSep(ch.name)) { body.append(h('div', { class: 'chsep' }, cleanLabel(ch.name))); continue; }
        const r = row(ch, playable); body.append(r); rowsObs.observe(r);
      }
      shown += PAGE;
      if (shown < rows.length) { body.append(sentinel); rowsObs.observe(sentinel); }
    }
    more();
  }

  function row(ch, playable) {
    const name = disp(ch);
    const logo = h('span', { class: 'logo' }, ch.logo ? h('img', { src: ch.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(initials(name)) }) : initials(name));
    const star = h('button', { class: 'star' + (fav.has(ch.id) ? ' on' : ''), title: 'Favorite', onclick: (e) => { e.stopPropagation(); toggleFav(ch.id); } });
    setIcon(star, fav.has(ch.id) ? 'starFill' : 'star');
    const el = h('div', { class: 'ch', tabindex: 0, 'data-id': ch.id, title: ch.name, onclick: () => play(ch, playable), onkeydown: (e) => { if (e.key === 'Enter') play(ch, playable); } },
      h('span', { class: 'num' }, ch.num), logo, h('b', { class: 'name' }, name),
      h('span', { class: 'gnow' }, h('span', { class: 't' }), h('span', { class: 'tm' }), h('i', { class: 'bar' }, h('u'))),
      h('span', { class: 'gnext' }, h('span', { class: 't' }), h('span', { class: 'tm' })), star);
    paintRow(el, ch.id);
    return el;
  }
  function paintRow(el, id) {
    const list = (epg.get(id) || {}).list, p = nowOf(list), nx = nextOf(list);
    const left = p ? Math.max(1, Math.round((p.end - Date.now()) / 60000)) : 0;
    el.querySelector('.gnow .t').textContent = p ? p.title : '';
    el.querySelector('.gnow .tm').textContent = p ? `${clock(p.start)} – ${clock(p.end)} · ${left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left} min`} left` : (list ? 'No programme info' : '');
    el.querySelector('.gnow .bar u').style.width = p ? `${Math.min(100, ((Date.now() - p.start) / (p.end - p.start)) * 100)}%` : '0';
    el.querySelector('.gnow .bar').style.visibility = p ? 'visible' : 'hidden';
    el.querySelector('.gnext .t').textContent = nx ? nx.title : '';
    el.querySelector('.gnext .tm').textContent = nx ? clock(nx.start) : '';
  }
  const paint = (id) => { const el = listBox && listBox.querySelector(`.ch[data-id="${id}"]`); if (el) paintRow(el, id); };

  async function toggleFav(id) {
    try { fav = new Set((await api('/live/favorite', { id })).favorites); } catch (e) { return toast(e.message); }
    if (state.sel.type === 'fav' && !state.q.trim()) draw();
    else document.querySelectorAll(`.ch[data-id="${id}"] .star`).forEach((b) => { b.classList.toggle('on', fav.has(id)); setIcon(b, fav.has(id) ? 'starFill' : 'star'); });
    if (cfg.liveLayout === 'grouped') { const f = [...document.querySelectorAll('.live-rail .cat')].find((b) => /Favorites/.test(b.textContent)); if (f) f.querySelector('small').textContent = n(fav.size); }
  }

  // --- hide the categories you never watch (there can be hundreds) ---
  function manageCategories() {
    const q = h('input', { type: 'search', placeholder: 'Find a category', autocomplete: 'off' });
    const list = h('div', { class: 'mc-list' });
    const modal = h('div', { class: 'modal', onclick: (e) => { if (e.target === modal) done(); } },
      h('div', { class: 'modal-card' },
        h('div', { class: 'mc-head' }, h('h2', {}, 'Manage categories'), h('button', { class: 'btn sm', onclick: done }, 'Done')),
        h('p', { class: 'subtle', style: 'margin:0 0 10px' }, 'Untick the categories you don’t want. Hidden ones disappear from the list and from search.'), q, list));
    async function setHidden(ids, hide) {
      try { hidden = new Set((await api('/live/hide', { ids, hide })).hidden); } catch (e) { toast(e.message); }
      paintList();
    }
    function paintList() {
      const term = q.value.trim().toLowerCase(), byRegion = new Map();
      for (const c of cats) { if (term && !(c.region + ' ' + c.label).toLowerCase().includes(term)) continue; if (!byRegion.has(c.region)) byRegion.set(c.region, []); byRegion.get(c.region).push(c); }
      const groups = [...byRegion.entries()].sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || a[0].localeCompare(b[0]));
      list.replaceChildren(...groups.flatMap(([region, items]) => {
        const allShown = items.every((c) => !hidden.has(c.id));
        return [h('div', { class: 'mc-region' }, h('b', {}, region), h('small', {}, `${items.length}`), h('span', { class: 'grow' }),
          h('button', { class: 'btn ghost sm', onclick: () => setHidden(items.map((c) => c.id), allShown) }, allShown ? 'Hide all' : 'Show all')),
          ...items.map((c) => h('label', { class: 'mc-item' }, h('input', { type: 'checkbox', checked: !hidden.has(c.id), onchange: (e) => setHidden([c.id], !e.target.checked) }), h('span', {}, c.label), h('small', {}, n(c.count))))];
      }));
      if (!groups.length) list.append(h('div', { class: 'subtle' }, 'No matching categories.'));
    }
    q.oninput = paintList;
    function done() { modal.remove(); const s = state.sel; if (s.type === 'cat' && hidden.has(s.id)) state.sel = { type: 'all' }; draw(); }
    document.body.append(modal); paintList(); q.focus();
  }

  // ---------- the player ----------
  const video = $('#liveVideo');
  let idle, infoTimer, startTimer;

  function play(ch, list) {
    if (!(window.APPINFO || {}).players?.ffmpeg) return toast('Live TV needs ffmpeg installed (sudo dnf install ffmpeg, or apt install ffmpeg).');
    playlist = list.length ? list : [ch];
    idx = Math.max(0, playlist.findIndex((c) => c.id === ch.id));
    $('#livePlayer').hidden = false; document.body.style.overflow = 'hidden';
    tune();
  }

  function status(kind, msg, retry) {
    const el = $('#lpStatus'), root = $('#livePlayer');
    if (!kind) { el.hidden = true; return; }
    el.hidden = false; el.className = kind === 'err' ? 'err2' : '';
    root.classList.remove('idle'); // never hide the controls while something is wrong or loading
    el.replaceChildren(h('div', {}, kind === 'spin' && h('div', { class: 'spinner' }), h('div', { class: 'lp-msg' }, msg),
      kind === 'err' && h('div', { class: 'btns' },
        retry && h('button', { class: 'btn', onclick: retry }, 'Try again'),
        playlist.length > 1 && h('button', { class: 'btn ghost', onclick: () => zap(1) }, 'Next channel ↓'),
        h('button', { class: 'btn ghost', onclick: close }, 'Back to channels'))));
  }

  function tune() {
    current = playlist[idx];
    if (!current) return;
    $('#lpName').textContent = `${current.num} · ${disp(current)}`;
    $('#lpNow').textContent = '';
    setFavIcon();
    status('spin', `Tuning to ${disp(current)}…`);
    video.src = `/api/live/stream/${current.id}`;   // switching src drops the old request, which stops the old ffmpeg
    video.play().catch(() => {});
    watchdog(35000);
    const mine = current;
    fetchEpg([current.id]).then(() => { if (current === mine) info(); });
    info(); wake(true);
  }

  function info() {
    const list = (epg.get(current.id) || {}).list, now = nowOf(list), next = nextOf(list);
    $('#lpNow').textContent = now ? now.title : '';
    $('#lpInfo').replaceChildren(...[
      h('div', { class: 'lp-ch' }, `${current.num} · ${disp(current)}`),
      now ? h('div', {}, h('div', { class: 'lp-title' }, now.title), h('div', { class: 'lp-time' }, `${clock(now.start)} – ${clock(now.end)}`),
        h('i', { class: 'bar' }, h('u', { style: `width:${Math.min(100, ((Date.now() - now.start) / (now.end - now.start)) * 100)}%` })),
        now.desc && h('div', { class: 'lp-desc' }, now.desc)) : h('div', { class: 'lp-time' }, 'No programme information'),
      next && h('div', { class: 'lp-next' }, `Next · ${clock(next.start)}  ${next.title}`),
      h('div', { class: 'lp-hint' }, 'Channel guide ▸')].filter(Boolean));
  }

  // ---------- channel guide overlay (click the channel info, or press G) ----------
  const guideEl = $('#lpGuide');
  let gSel = 0, gObs, gTimer, gStart = 0;
  const sched = new Map(); // channel id -> { at, list } with a longer schedule than the list rows need
  const guideOpen = () => !guideEl.hidden;

  function openGuide() {
    if (!current) return;
    guideEl.hidden = false; $('#livePlayer').classList.remove('idle');
    gSel = idx; gStart = Math.max(0, idx - 8);
    drawGuide(); selectGuide(gSel, true);
  }
  function closeGuide() { guideEl.hidden = true; gObs && gObs.disconnect(); wake(false); }

  function guideRow(i) {
    const ch = playlist[i], name = disp(ch);
    const logo = h('span', { class: 'logo' }, ch.logo ? h('img', { src: ch.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(initials(name)) }) : initials(name));
    const el = h('div', { class: 'lg-row' + (i === idx ? ' live-now' : ''), 'data-i': i, onclick: () => tuneTo(i), onmouseenter: () => selectGuide(i) },
      h('span', { class: 'num' }, ch.num), logo, h('span', { class: 'who' }, h('b', {}, name), h('span', { class: 'now' }), h('i', { class: 'bar' }, h('u'))), h('span', { class: 'nx' }));
    paintGuideRow(el, ch.id);
    return el;
  }
  function paintGuideRow(el, id) {
    const list = (epg.get(id) || {}).list, p = nowOf(list), nx = nextOf(list);
    el.querySelector('.now').textContent = p ? `${p.title} · until ${clock(p.end)}` : '';
    el.querySelector('.bar u').style.width = p ? `${Math.min(100, ((Date.now() - p.start) / (p.end - p.start)) * 100)}%` : '0';
    el.querySelector('.bar').style.visibility = p ? 'visible' : 'hidden';
    el.querySelector('.nx').textContent = nx ? `Next ${clock(nx.start)} · ${nx.title}` : '';
  }
  function drawGuide() {
    gObs && gObs.disconnect();
    const box = $('#lgList'); box.replaceChildren();
    const pending = new Set(); let timer, end = gStart;
    gObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.target.classList.contains('lg-more-bottom')) { addRows(); continue; }
        pending.add(Number(playlist[Number(e.target.dataset.i)].id)); gObs.unobserve(e.target);
      }
      clearTimeout(timer);
      timer = setTimeout(async () => { const ids = [...pending]; pending.clear(); if (!ids.length) return; await fetchEpg(ids); ids.forEach((id) => { const r = box.querySelector(`.lg-row[data-i="${playlist.findIndex((c) => c.id === id)}"]`); if (r) paintGuideRow(r, id); }); }, 120);
    }, { root: box, rootMargin: '200px' });
    const bottom = h('div', { class: 'lg-more-bottom' });
    function addRows() {
      bottom.remove();
      for (let i = end; i < Math.min(playlist.length, end + 40); i++) { const r = guideRow(i); box.append(r); gObs.observe(r); }
      end = Math.min(playlist.length, end + 40);
      if (end < playlist.length) { box.append(bottom); gObs.observe(bottom); }
    }
    if (gStart > 0) box.append(h('button', { class: 'btn ghost sm lg-earlier', onclick: () => { const keep = gSel; gStart = Math.max(0, gStart - 40); drawGuide(); selectGuide(keep, true); } }, 'Earlier channels'));
    addRows();
    // make sure the highlighted row exists even if it is far down
    while (end <= gSel && end < playlist.length) addRows();
  }

  function selectGuide(i, scroll) {
    gSel = i;
    $('#lgList').querySelectorAll('.lg-row.sel').forEach((r) => r.classList.remove('sel'));
    const row = $('#lgList').querySelector(`.lg-row[data-i="${i}"]`);
    if (row) { row.classList.add('sel'); if (scroll) row.scrollIntoView({ block: 'center' }); }
    clearTimeout(gTimer); gTimer = setTimeout(() => showSchedule(playlist[i]), scroll ? 0 : 140);
  }

  async function showSchedule(ch) {
    if (!ch) return;
    const box = $('#lgSched'), name = disp(ch);
    box.replaceChildren(h('div', { class: 'sc-title' }, h('b', {}, `${ch.num} · ${name}`), ch.id === (current || {}).id && h('span', { class: 'sc-badge' }, 'Watching')), h('div', { class: 'subtle' }, 'Loading schedule…'));
    let list = (sched.get(ch.id) || {}).list;
    if (!list || Date.now() - sched.get(ch.id).at > 3 * 60 * 1000) {
      try { list = (await api(`/live/epg?ids=${ch.id}&limit=12`))[ch.id] || []; sched.set(ch.id, { at: Date.now(), list }); } catch { list = []; }
    }
    if (playlist[gSel] !== ch) return; // the highlight moved on
    const now = Date.now();
    const items = list.filter((p) => p.end > now);
    box.replaceChildren(
      h('div', { class: 'sc-title' }, h('b', {}, `${ch.num} · ${name}`), ch.id === (current || {}).id && h('span', { class: 'sc-badge' }, 'Watching')),
      ...(items.length ? items.map((p, i) => h('div', { class: 'sc-item' + (p.start <= now ? ' now' : '') },
        h('div', { class: 'sc-time' }, p.start <= now ? `Now · until ${clock(p.end)}` : `${clock(p.start)} – ${clock(p.end)}`),
        h('div', { class: 'sc-name' }, p.title), i < 3 && p.desc && h('div', { class: 'sc-desc' }, p.desc)))
        : [h('div', { class: 'subtle', style: 'margin-top:1em' }, 'No programme information for this channel.')]),
      h('button', { class: 'btn', style: 'margin-top:1.2em', onclick: () => tuneTo(gSel) }, ch.id === (current || {}).id ? 'Keep watching' : 'Watch this channel'));
  }
  function tuneTo(i) { if (i === idx) { closeGuide(); return; } idx = i; closeGuide(); tune(); }

  $('#lgClose').onclick = closeGuide;
  $('#lpInfo').addEventListener('click', openGuide);
  $('#lpName').parentElement.addEventListener('click', openGuide);
  $('#lpInfo').style.cursor = 'pointer'; $('#lpName').parentElement.style.cursor = 'pointer';

  const setFavIcon = () => { const b = $('#lpFav'); b.classList.toggle('on', fav.has(current.id)); setIcon(b.firstElementChild, fav.has(current.id) ? 'starFill' : 'star'); };
  const zap = (d) => { if (playlist.length > 1) { idx = (idx + d + playlist.length) % playlist.length; tune(); } };

  /** Give up on a channel that never starts or stalls for too long, and free the provider connection. */
  function watchdog(ms) {
    clearTimeout(startTimer);
    startTimer = setTimeout(() => giveUp('This channel isn’t responding. The provider may be busy, or you may be at your connection limit.'), ms);
  }
  function giveUp(msg) {
    clearTimeout(startTimer);
    video.removeAttribute('src'); video.load();
    status('err', msg, tune);
  }
  video.addEventListener('playing', () => { clearTimeout(startTimer); status(null); });
  video.addEventListener('waiting', () => { status('spin', 'Buffering…'); watchdog(25000); });
  video.addEventListener('error', async () => {
    if (!video.getAttribute('src') || !current) return;
    const id = current.id;
    const r = await api('/live/why?id=' + id).catch(() => null);
    if (current && current.id === id) giveUp((r && r.reason) || 'Couldn’t play this channel.');
  });
  video.addEventListener('click', () => wake(true));
  video.addEventListener('dblclick', () => fullscreen());

  function wake(showInfo) {
    const root = $('#livePlayer');
    root.classList.remove('idle'); root.classList.toggle('show-info', !!showInfo);
    clearTimeout(idle); idle = setTimeout(() => { if ($('#lpStatus').hidden && guideEl.hidden) root.classList.add('idle'); }, 4000);
  }
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : $('#livePlayer').requestFullscreen().catch(() => {}));

  function close() {
    if ($('#livePlayer').hidden) return;
    clearTimeout(startTimer); video.pause(); video.removeAttribute('src'); video.load(); guideEl.hidden = true;
    $('#livePlayer').hidden = true; document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen();
  }

  $('#lpBack').onclick = close;
  $('#lpPrev').onclick = () => zap(-1);
  $('#lpNext').onclick = () => zap(1);
  $('#lpFull').onclick = fullscreen;
  $('#lpMute').onclick = () => { video.muted = !video.muted; setIcon($('#lpMute span'), video.muted ? 'mute' : 'volume'); };
  $('#lpFav').onclick = () => Live.toggleFav && current && Live.toggleFav(current.id).then(setFavIcon);
  $('#livePlayer').addEventListener('mousemove', () => wake(false));
  setInterval(() => { if (!$('#livePlayer').hidden && current) info(); }, 30000); // progress bar and "now" roll over
  addEventListener('keydown', (e) => {
    if ($('#livePlayer').hidden) return;
    if (guideOpen()) {
      const k = e.key;
      if (k === 'Escape' || k.toLowerCase() === 'g') { e.preventDefault(); e.stopPropagation(); closeGuide(); }
      else if (k === 'ArrowDown') { e.preventDefault(); selectGuide(Math.min(playlist.length - 1, gSel + 1), true); }
      else if (k === 'ArrowUp') { e.preventDefault(); selectGuide(Math.max(0, gSel - 1), true); }
      else if (k === 'Enter') { e.preventDefault(); tuneTo(gSel); }
      return;
    }
    wake(true);
    if (e.key.toLowerCase() === 'g') openGuide();
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); zap(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); zap(1); }
    else if (e.key.toLowerCase() === 'f') fullscreen();
    else if (e.key.toLowerCase() === 'm') $('#lpMute').click();
    else if (e.key === 'Escape' && !document.fullscreenElement) close();
  });
  addEventListener('hashchange', close);

  return { view, toggleFav };
})();
