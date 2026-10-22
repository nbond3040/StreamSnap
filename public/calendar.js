'use strict';
/* Calendar: episodes of series in your library and NBA games, by month. Clicking a game opens a card with the
   tip-off time, live score and the best channel in your Live TV list to watch it on.
   Uses h()/api()/toast()/setIcon() from app.js and Live.watchChannel at call time. */
const Calendar = (() => {
  const view = () => document.querySelector('#view');
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const store = (k, v) => { try { v === undefined ? 0 : localStorage.setItem(k, JSON.stringify(v)); } catch { /* optional */ } };
  const recall = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

  const st = { y: 0, m: 0, eps: recall('ss.cal.eps', true), nba: recall('ss.cal.nba', true), team: recall('ss.cal.team', ''), data: null, open: null };
  const cache = new Map();   // "from|to" -> { at, data }
  let token = 0, refreshTimer = null;

  async function load() {
    const first = new Date(st.y, st.m, 1), start = new Date(first); start.setDate(1 - first.getDay());
    const end = new Date(start); end.setDate(start.getDate() + 41);
    const from = dayKey(start), to = dayKey(end), key = from + '|' + to, hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60 * 1000) return { from, to, start, data: hit.data };
    const data = await api(`/calendar?from=${from}&to=${to}`);
    cache.set(key, { at: Date.now(), data });
    return { from, to, start, data };
  }

  function gameLabel(g) {
    if (g.state === 'scheduled') return [`${g.away.abbr} @ ${g.home.abbr}`, g.postponed ? 'Postponed' : timeOf(g.start)];
    return [`${g.away.abbr} ${g.away.score ?? ''}  ${g.home.abbr} ${g.home.score ?? ''}`, g.state === 'live' ? g.detail || 'Live' : 'Final'];
  }

  async function draw() {
    const my = ++token, root = view();
    const first = new Date(st.y, st.m, 1);
    let res;
    try { res = await load(); } catch (e) { if (my === token) root.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
    if (my !== token) return;
    const { data, start } = res;
    st.data = data;
    const teams = new Map();
    for (const g of data.games) { teams.set(g.home.abbr, g.home.name); teams.set(g.away.abbr, g.away.name); }
    if (st.team && !teams.has(st.team) && teams.size) st.team = '';

    const byDay = new Map();
    const add = (k, item) => { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(item); };
    if (st.eps) for (const e of data.episodes) add(e.date, { t: 'ep', e });
    if (st.nba && data.nba) for (const g of data.games) {
      if (st.team && g.home.abbr !== st.team && g.away.abbr !== st.team) continue;
      add(dayKey(new Date(g.start)), { t: 'game', g });
    }

    const todayKey = dayKey(new Date());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = dayKey(d), items = (byDay.get(k) || []).sort((a, b) => (a.t === b.t ? (a.t === 'game' ? a.g.start - b.g.start : 0) : a.t === 'game' ? -1 : 1));
      const open = st.open === k, shown = open ? items : items.slice(0, 3);
      cells.push(h('div', { class: 'cal-cell' + (d.getMonth() !== st.m ? ' other' : '') + (k === todayKey ? ' today' : '') + (open ? ' open' : '') },
        h('div', { class: 'cal-day' }, String(d.getDate())),
        ...shown.map((it) => (it.t === 'ep' ? epChip(it.e) : gameChip(it.g))),
        items.length > 3 && h('button', { class: 'cal-more', onclick: () => { st.open = open ? null : k; draw(); } }, open ? 'Show less' : `+${items.length - 3} more`)));
    }

    const nav = (dm) => () => { const d = new Date(st.y, st.m + dm, 1); st.y = d.getFullYear(); st.m = d.getMonth(); st.open = null; draw(); };
    const toggle = (label, key, on) => h('button', { class: 'chipbtn' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => { st[key] = !st[key]; store('ss.cal.' + key, st[key]); draw(); } }, label);
    const teamSel = teams.size && st.nba ? h('select', { class: 'pill', 'aria-label': 'Team', onchange: (e) => { st.team = e.target.value; store('ss.cal.team', st.team); draw(); } },
      h('option', { value: '' }, 'All teams'), [...teams.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([abbr, name]) => h('option', { value: abbr, selected: abbr === st.team }, name))) : null;

    const notes = [];
    if (data.nba && data.gamesError) notes.push(h('div', { class: 'notice warn' }, 'Couldn’t load the NBA schedule: ' + data.gamesError));
    if (!data.episodes.length && st.eps && !st.nba) notes.push(h('div', { class: 'subtle', style: 'margin-bottom:10px' }, 'No episodes airing this month for series in your library.'));

    root.replaceChildren(
      h('div', { class: 'cal-head' },
        h('div', { class: 'cal-nav' },
          h('button', { class: 'btn ghost sm', 'aria-label': 'Previous month', onclick: nav(-1) }, '‹'),
          h('h2', {}, first.toLocaleDateString([], { month: 'long', year: 'numeric' })),
          h('button', { class: 'btn ghost sm', 'aria-label': 'Next month', onclick: nav(1) }, '›'),
          h('button', { class: 'btn ghost sm', onclick: () => { const n = new Date(); st.y = n.getFullYear(); st.m = n.getMonth(); st.open = null; draw(); } }, 'Today')),
        h('div', { class: 'cal-filters' }, toggle('Episodes', 'eps', st.eps), data.nba && toggle('NBA', 'nba', st.nba), teamSel)),
      ...notes,
      h('div', { class: 'cal-grid' },
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n) => h('div', { class: 'cal-dow' }, n)), cells),
      ...(data.nba ? [] : [h('p', { class: 'subtle', style: 'margin-top:14px' }, 'NBA games are turned off. Turn them on in ', h('a', { href: '#/settings' }, 'Settings'), '.')]));
  }

  function epChip(e) {
    return h('a', { class: 'cal-item ep' + (e.watched ? ' done' : ''), href: `#/detail/series/${e.series}`, title: `${e.name} · S${e.season} E${e.episode} · ${e.title}` },
      h('b', {}, e.name), h('span', {}, `S${e.season} E${e.episode}`));
  }
  function gameChip(g) {
    const [a, b] = gameLabel(g);
    return h('button', { class: 'cal-item game ' + g.state, onclick: () => openGame(g), title: `${g.away.name} at ${g.home.name}` },
      g.state === 'live' && h('i', { class: 'livedot' }), h('b', {}, a), h('span', {}, b));
  }

  // ---------- the game card ----------
  let modal = null;
  function closeModal() { clearInterval(refreshTimer); refreshTimer = null; if (modal) { modal.remove(); modal = null; } document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } }

  const until = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'any moment now';
    if (m < 60) return `in ${m} min`;
    if (m < 48 * 60) return `in ${Math.floor(m / 60)} h ${m % 60} min`;
    return `in ${Math.round(m / 1440)} days`;
  };

  function teamRow(t, g) {
    const lead = g.state !== 'scheduled' && t.score != null;
    return h('div', { class: 'gm-team' + (g.state === 'final' && t.winner ? ' win' : '') },
      t.logo ? h('img', { src: t.logo, alt: '', loading: 'lazy' }) : h('span', { class: 'gm-logo' }, t.abbr),
      h('div', { class: 'gm-name' }, h('b', {}, t.name), t.record && h('small', {}, t.record)),
      lead && h('div', { class: 'gm-score' }, String(t.score)));
  }

  async function openGame(g0) {
    closeModal();
    const body = h('div', { class: 'gm-body' });
    const card = h('div', { class: 'gm-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${g0.away.name} at ${g0.home.name}` },
      h('button', { class: 'gm-close pbtn', 'aria-label': 'Close', onclick: closeModal }, '✕'), body);
    modal = h('div', { class: 'gm-back', onclick: (e) => { if (e.target === modal) closeModal(); } }, card);
    document.body.append(modal);
    document.addEventListener('keydown', onKey, true);

    let info = null;
    const render = () => {
      const g = info ? info.game : g0;
      const status = g.postponed ? 'Postponed' : g.state === 'live' ? h('span', { class: 'gm-live' }, h('i', { class: 'livedot' }), g.detail || 'Live')
        : g.state === 'final' ? (g.detail || 'Final') : `${new Date(g.start).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · ${timeOf(g.start)}`;
      const out = [h('div', { class: 'gm-status' }, status, g.state === 'scheduled' && !g.postponed && h('small', {}, ' · tip-off ' + until(g.start - Date.now()))),
        h('div', { class: 'gm-teams' }, teamRow(g.away, g), teamRow(g.home, g)),
        h('div', { class: 'subtle gm-meta' }, [g.venue, g.broadcasts.length && 'On ' + g.broadcasts.join(', ')].filter(Boolean).join(' · '))];
      out.push(streamsBlock(g));
      body.replaceChildren(...out);
    };
    function streamsBlock(g) {
      if (g.state === 'final') return h('div', { class: 'gm-streams' }, h('div', { class: 'subtle' }, 'This game has finished. Live TV can’t replay it.'));
      if (g.postponed) return h('div', { class: 'gm-streams' });
      if (!info) return h('div', { class: 'gm-streams' }, h('div', { class: 'subtle' }, 'Finding the best channel…'));
      if (!info.hasLive) return h('div', { class: 'gm-streams' }, h('div', { class: 'subtle' }, 'Add your Live TV provider in '), h('a', { class: 'btn', href: '#/settings', onclick: closeModal }, 'Settings'));
      if (!info.streams.length) return h('div', { class: 'gm-streams' }, h('div', { class: 'subtle' }, `No channel in your Live TV list looks like it carries this game${g.broadcasts.length ? ' (' + g.broadcasts.join(', ') + ')' : ''}.`));
      const [best, ...rest] = info.streams;
      const watch = (c) => () => { closeModal(); Live.watchChannel({ id: c.id, num: c.num, name: c.name, logo: c.logo }); };
      const rec = (c) => async () => {
        try { await api('/dvr/record', { channelId: c.id, name: `${g.away.abbr} @ ${g.home.abbr}`, start: g.start, end: info.ends, padded: true }); toast('Recording scheduled — see Downloads'); }
        catch (e) { toast(e.message); }
      };
      const row = (c, primary) => h('div', { class: 'gm-ch' + (primary ? ' best' : '') },
        c.logo ? h('img', { src: c.logo, alt: '', loading: 'lazy' }) : h('span', { class: 'gm-logo' }, 'TV'),
        h('div', { class: 'gm-chname' }, h('b', {}, c.name.replace(/^\s*[A-Za-z0-9+]{1,5}\s*\|\s*/, '')), h('small', {}, [c.quality, c.guide || c.why].filter(Boolean).join(' · '))),
        h('div', { class: 'row' }, h('button', { class: primary ? 'btn' : 'btn ghost sm', onclick: watch(c) }, g.state === 'live' ? '▶ Watch' : '▶ Open'),
          h('button', { class: 'btn ghost sm', title: 'Record this game', 'aria-label': 'Record this game', onclick: rec(c) }, (() => { const s = h('span'); setIcon(s, 'record'); return s; })())));
      return h('div', { class: 'gm-streams' }, h('div', { class: 'gm-h' }, g.state === 'live' ? 'Watch now' : 'Where to watch', best.quality && h('span', { class: 'chip' }, 'best: ' + best.quality)),
        row(best, true), rest.length > 0 && h('details', { class: 'alts' }, h('summary', {}, `${rest.length} other channel${rest.length > 1 ? 's' : ''}`), rest.map((c) => row(c, false))));
    }
    render();
    const fetchInfo = async () => {
      try { info = await api(`/nba/game?id=${g0.id}&start=${g0.start}`); render(); }
      catch (e) { if (!info) { info = { game: g0, streams: [], hasLive: true }; body.replaceChildren(h('div', { class: 'subtle' }, e.message)); } }
    };
    await fetchInfo();
    if (modal && info && info.game.state !== 'final') refreshTimer = setInterval(() => { if (modal && document.body.contains(modal)) fetchInfo(); else closeModal(); }, 30000);
  }

  async function open() {
    const n = new Date();
    if (!st.y) { st.y = n.getFullYear(); st.m = n.getMonth(); }
    view().replaceChildren(h('div', { class: 'empty', style: 'margin-top:40px' }, 'Loading calendar…'));
    await draw();
  }
  addEventListener('hashchange', closeModal);

  return { view: open };
})();
