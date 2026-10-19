'use strict';
/* Live TV: a category list on the left, channels on the right (logo, name, what's on now), click to watch.
   Uses h()/api()/toast()/setIcon() from app.js at call time. */
const Live = (() => {
  const $ = (s) => document.querySelector(s);
  const PAGE = 60; // rows rendered at a time
  let data = null, fav = new Set(), epg = new Map(); // epg: channel id -> { at, list }
  const state = { cat: 'all', q: '' };
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

  // ---------- the page ----------
  async function view() {
    const root = $('#view');
    root.replaceChildren(h('div', { class: 'empty', style: 'margin-top:40px' }, 'Loading channels…'));
    try { data = await api('/live/browse'); }
    catch (e) { return root.replaceChildren(h('div', { class: 'live-empty' }, h('h2', {}, 'Couldn’t load Live TV'), h('p', { class: 'subtle' }, e.message), h('div', { class: 'row2', style: 'justify-content:center' }, h('button', { class: 'btn', onclick: view }, 'Try again'), h('a', { class: 'btn ghost', href: '#/settings' }, 'Settings')))); }
    if (!data.configured) {
      return root.replaceChildren(h('div', { class: 'live-empty' }, h('h2', {}, 'Live TV isn’t set up yet'),
        h('p', { class: 'subtle' }, 'Add your Xtream server, username and password in Settings to watch live channels.'), h('a', { class: 'btn', href: '#/settings' }, 'Open Settings')));
    }
    fav = new Set(data.favorites);
    draw(root);
  }

  const inCat = (c) => (state.cat === 'all' ? true : state.cat === 'fav' ? fav.has(c.id) : c.cat === state.cat);
  const visible = () => {
    const q = state.q.trim().toLowerCase();
    return data.channels.filter((c) => inCat(c) && (!q || c.name.toLowerCase().includes(q) || String(c.num) === q));
  };

  function draw(root) {
    const rail = h('div', { class: 'live-rail' });
    const list = h('div', { class: 'live-list' });
    const search = h('input', { type: 'search', placeholder: 'Search channels', value: state.q, autocomplete: 'off', oninput: () => { state.q = search.value; drawList(); } });

    function drawRail() {
      const count = (f) => data.channels.filter(f).length;
      const item = (id, label, n) => h('button', { class: 'cat' + (state.cat === id ? ' on' : ''), onclick: () => { state.cat = id; drawRail(); drawList(); } }, h('span', {}, label), h('small', {}, n));
      rail.replaceChildren(h('div', { class: 'live-search' }, search),
        h('div', { class: 'cats' }, item('all', 'All channels', data.channels.length), item('fav', '★ Favorites', fav.size),
          ...data.categories.map((c) => ({ c, n: count((ch) => ch.cat === c.id) })).filter((x) => x.n).map(({ c, n }) => item(c.id, c.name, n))));
    }

    let rows = [], shown = 0, obs;
    function drawList() {
      obs && obs.disconnect();
      rows = visible(); shown = 0;
      const title = state.cat === 'all' ? 'All channels' : state.cat === 'fav' ? 'Favorites' : (data.categories.find((c) => c.id === state.cat) || {}).name || '';
      const body = h('div', { class: 'rows' });
      list.replaceChildren(h('div', { class: 'live-head' }, h('h2', {}, title), h('span', { class: 'count' }, rows.length)), body);
      if (!rows.length) { body.append(h('div', { class: 'empty' }, state.cat === 'fav' ? 'No favorites yet. Tap ☆ on a channel to add it.' : 'No channels found.')); return; }
      // lazily fill in "what's on" for rows as they scroll into view, and add more rows near the bottom
      const pending = new Set(); let timer;
      obs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target.classList.contains('sentinel')) { more(); continue; }
          pending.add(Number(e.target.dataset.id)); obs.unobserve(e.target);
        }
        clearTimeout(timer);
        timer = setTimeout(async () => { const ids = [...pending]; pending.clear(); await fetchEpg(ids); ids.forEach(paint); }, 150);
      }, { rootMargin: '300px' });
      const sentinel = h('div', { class: 'sentinel' });
      function more() {
        sentinel.remove();
        for (const ch of rows.slice(shown, shown + PAGE)) { const r = row(ch); body.append(r); obs.observe(r); }
        shown += PAGE;
        if (shown < rows.length) { body.append(sentinel); obs.observe(sentinel); }
      }
      more();
    }

    function row(ch) {
      const logo = h('span', { class: 'logo' }, ch.logo ? h('img', { src: ch.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(initials(ch.name)) }) : initials(ch.name));
      const star = h('button', { class: 'star' + (fav.has(ch.id) ? ' on' : ''), title: 'Favorite', onclick: (e) => { e.stopPropagation(); toggleFav(ch.id); } });
      setIcon(star, fav.has(ch.id) ? 'starFill' : 'star');
      const el = h('div', { class: 'ch', tabindex: 0, 'data-id': ch.id, onclick: () => play(ch, rows), onkeydown: (e) => { if (e.key === 'Enter') play(ch, rows); } },
        h('span', { class: 'num' }, ch.num), logo,
        h('span', { class: 'info' }, h('b', { class: 'name' }, ch.name), h('span', { class: 'now' }), h('i', { class: 'bar' }, h('u'))), star);
      paintRow(el, ch.id);
      return el;
    }
    function paintRow(el, id) {
      const p = nowOf((epg.get(id) || {}).list);
      el.querySelector('.now').textContent = p ? `${p.title} · until ${clock(p.end)}` : '';
      el.querySelector('.bar u').style.width = p ? `${Math.min(100, ((Date.now() - p.start) / (p.end - p.start)) * 100)}%` : '0';
      el.querySelector('.bar').style.visibility = p ? 'visible' : 'hidden';
    }
    const paint = (id) => { const el = list.querySelector(`.ch[data-id="${id}"]`); if (el) paintRow(el, id); };

    async function toggleFav(id) {
      try { fav = new Set((await api('/live/favorite', { id })).favorites); } catch (e) { return toast(e.message); }
      drawRail();
      if (state.cat === 'fav') drawList();
      else list.querySelectorAll(`.ch[data-id="${id}"] .star`).forEach((b) => { b.classList.toggle('on', fav.has(id)); setIcon(b, fav.has(id) ? 'starFill' : 'star'); });
    }
    Live.toggleFav = toggleFav;

    drawRail(); drawList();
    root.replaceChildren(h('div', { class: 'live' }, rail, list));
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
    const el = $('#lpStatus');
    if (!kind) { el.hidden = true; return; }
    el.hidden = false; el.className = kind === 'err' ? 'err2' : '';
    el.replaceChildren(h('div', {}, kind === 'spin' && h('div', { class: 'spinner' }), h('div', {}, msg),
      retry && h('button', { class: 'btn', style: 'margin-top:14px', onclick: retry }, 'Try again')));
  }

  function tune() {
    current = playlist[idx];
    if (!current) return;
    $('#lpName').textContent = `${current.num} · ${current.name}`;
    $('#lpNow').textContent = '';
    setFavIcon();
    status('spin', `Tuning to ${current.name}…`);
    video.src = `/api/live/stream/${current.id}`;   // switching src drops the old request, which stops the old ffmpeg
    video.play().catch(() => {});
    clearTimeout(startTimer);
    startTimer = setTimeout(() => { if (video.readyState < 2) status('err', 'This channel is taking a long time to start. The provider may be busy or you may be at your connection limit.', tune); }, 30000);
    const mine = current;
    fetchEpg([current.id]).then(() => { if (current === mine) info(); });
    info(); wake(true);
  }

  function info() {
    const list = (epg.get(current.id) || {}).list, now = nowOf(list), next = nextOf(list);
    $('#lpNow').textContent = now ? now.title : '';
    $('#lpInfo').replaceChildren(
      h('div', { class: 'lp-ch' }, `${current.num} · ${current.name}`),
      now ? h('div', {}, h('div', { class: 'lp-title' }, now.title), h('div', { class: 'lp-time' }, `${clock(now.start)} – ${clock(now.end)}`),
        h('i', { class: 'bar' }, h('u', { style: `width:${Math.min(100, ((Date.now() - now.start) / (now.end - now.start)) * 100)}%` })),
        now.desc && h('div', { class: 'lp-desc' }, now.desc)) : h('div', { class: 'lp-time' }, 'No programme information'),
      next && h('div', { class: 'lp-next' }, `Next · ${clock(next.start)}  ${next.title}`));
  }

  const setFavIcon = () => { const b = $('#lpFav'); b.classList.toggle('on', fav.has(current.id)); setIcon(b.firstElementChild, fav.has(current.id) ? 'starFill' : 'star'); };
  const zap = (d) => { if (playlist.length > 1) { idx = (idx + d + playlist.length) % playlist.length; tune(); } };

  video.addEventListener('playing', () => { clearTimeout(startTimer); status(null); });
  video.addEventListener('waiting', () => status('spin', 'Buffering…'));
  video.addEventListener('error', () => { if (video.getAttribute('src')) status('err', 'Couldn’t play this channel. Try another one, or try again in a moment.', tune); });
  video.addEventListener('click', () => wake(true));
  video.addEventListener('dblclick', () => fullscreen());

  function wake(showInfo) {
    const root = $('#livePlayer');
    root.classList.remove('idle'); root.classList.toggle('show-info', !!showInfo);
    clearTimeout(idle); idle = setTimeout(() => root.classList.add('idle'), 4000);
  }
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : $('#livePlayer').requestFullscreen().catch(() => {}));

  function close() {
    if ($('#livePlayer').hidden) return;
    clearTimeout(startTimer); video.pause(); video.removeAttribute('src'); video.load();
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
    wake(true);
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); zap(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); zap(1); }
    else if (e.key.toLowerCase() === 'f') fullscreen();
    else if (e.key.toLowerCase() === 'm') $('#lpMute').click();
    else if (e.key === 'Escape' && !document.fullscreenElement) close();
  });
  addEventListener('hashchange', close);

  return { view, toggleFav: null };
})();
