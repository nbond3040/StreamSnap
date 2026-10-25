'use strict';
/* Anime: its own Discover tab (Kitsu catalog), a SUB / DUB mark on every cover, a Subbed / Dubbed filter, and the viewing preference
   the player's SUB / DUB switch updates. Uses h()/api()/card()/toast()/view from app.js at call time. */
const Anime = (() => {
  const recall = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* optional */ } };

  // ---------- what's available as sub / dub (per title, looked up from the releases that exist) ----------
  const info = new Map();        // id -> { sub, dub } | null (couldn't look it up)
  const waiting = new Set(), listeners = new Set();

  async function lookup(ids) {
    const need = [...new Set(ids)].filter((id) => !info.has(id) && !waiting.has(id));
    need.forEach((id) => waiting.add(id));
    for (let i = 0; i < need.length; i += 12) {
      const chunk = need.slice(i, i + 12);
      let out = {};
      try { out = await api('/anime/audio?ids=' + chunk.join(',')); } catch { /* try again next time */ }
      for (const id of chunk) { waiting.delete(id); if (id in out) info.set(id, out[id]); }
      listeners.forEach((fn) => fn());
    }
  }

  /** The SUB / DUB marks on a cover. A title with neither playable gets none. */
  function mark(cardEl, a) {
    cardEl.querySelector('.abadges')?.remove();
    if (!a || (!a.sub && !a.dub)) return;
    const box = h('div', { class: 'abadges', title: a.sub && a.dub ? 'Available subbed and dubbed' : a.dub ? 'Dubbed only' : 'Subbed only' },
      a.sub && h('span', { class: 'abadge sub' }, 'SUB'), a.dub && h('span', { class: 'abadge dub' }, 'DUB'));
    const img = cardEl.querySelector('.img');
    if (img) img.append(box);
  }

  /** Mark every anime cover under `root` (Home, Library, search, the Anime tab). Never blocks the page. */
  function badges(root) {
    const cards = [...(root || document).querySelectorAll('.card[data-anime]')];
    if (!cards.length) return;
    const apply = () => cards.forEach((c) => { if (info.has(c.dataset.anime)) mark(c, info.get(c.dataset.anime)); });
    apply();
    lookup(cards.map((c) => c.dataset.anime)).then(apply);
  }

  // ---------- the player's choice, remembered ----------
  const pref = () => { const v = recall('ss.animeAudio', ''); return v === 'sub' || v === 'dub' ? v : ''; };
  const setPref = (k) => store('ss.animeAudio', k);

  // ---------- Discover > Anime ----------
  const KINDS = [['trending', 'Trending'], ['popular', 'Popular'], ['airing', 'Airing now'], ['rating', 'Top rated']];
  const GENRES = ['', 'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
  const state = { kind: recall('ss.anime.kind', 'trending'), audio: recall('ss.anime.audio', 'all'), genre: '', q: '' };
  const lists = new Map();       // "kind|genre|q" -> { items, skip, done }

  async function discover() {
    const grid = h('div', { class: 'grid' });
    const more = h('button', { class: 'btn ghost', onclick: () => load() }, 'Load more');
    const status = h('p', { class: 'subtle', style: 'text-align:center;margin-top:16px' });
    let token = 0, autoPages = 0;
    const key = () => `${state.kind}|${state.genre}|${state.q}`;
    const entry = () => { if (!lists.has(key())) lists.set(key(), { items: [], skip: 0, done: false }); return lists.get(key()); };
    const cardFor = new Map();   // id -> card element in the grid

    const passes = (id) => {
      if (state.audio === 'all') return true;
      if (!info.has(id)) return false;                           // not looked up yet: shown as soon as it is known
      const a = info.get(id);
      return a === null ? true : !!a[state.audio];               // lookup failed: can't tell, so don't hide it
    };

    function paint() {
      const e = entry();
      let shown = 0, pending = 0;
      for (const m of e.items) {
        const el = cardFor.get(m.id); if (!el) continue;
        if (info.has(m.id)) mark(el, info.get(m.id));
        else if (state.audio !== 'all') pending++;
        const ok = passes(m.id);
        el.hidden = !ok; if (ok) shown++;
      }
      more.hidden = e.done;
      status.textContent = pending ? `Checking which of these have a ${state.audio === 'dub' ? 'dub' : 'sub'}… (${pending})`
        : e.done ? (shown ? 'You’ve reached the end of the list.' : 'Nothing found.') : state.audio !== 'all' && shown < 8 && !e.done && autoPages >= 4 ? 'Few matches so far. Load more to keep looking.' : '';
      // a filter hides many covers: keep fetching pages (a few at a time) until there is something to look at
      if (state.audio !== 'all' && !pending && shown < 12 && !e.done && autoPages < 4 && !more.disabled) { autoPages++; load(); }
    }

    async function load(attempt = 0) {
      const e = entry(), mine = token;
      more.disabled = true;
      try {
        const q = `/anime/catalog?kind=${state.kind}&genre=${encodeURIComponent(state.genre)}&q=${encodeURIComponent(state.q)}&skip=${e.skip}`;
        let items = await api(q);
        e.skip += items.length;
        const seen = new Set(e.items.map((m) => m.id));
        items = items.filter((m) => !seen.has(m.id));
        e.items.push(...items);
        e.done = !items.length || !!state.q;                     // a search is one page
        if (mine !== token) return;
        for (const m of items) { const c = card(m); cardFor.set(m.id, c); grid.append(c); }
        lookup(items.map((m) => m.id)).then(() => mine === token && paint());
      } catch (err) {
        if (mine === token) status.replaceChildren(retryBox(err, () => load(attempt + 1)));
        more.disabled = false; return;
      }
      more.disabled = false;
      if (mine === token) paint();
    }
    const onInfo = () => { if (document.body.contains(grid)) paint(); else listeners.delete(onInfo); };
    listeners.add(onInfo);

    function show() {
      token++; autoPages = 0;
      cardFor.clear();
      const e = entry();
      status.textContent = ''; more.disabled = false;
      grid.replaceChildren(...e.items.map((m) => { const c = card(m); cardFor.set(m.id, c); return c; }));
      paint();
      if (!e.items.length) load();
      else lookup(e.items.map((m) => m.id)).then(() => paint());
      drawFilters();
    }

    const filters = h('div', { class: 'filters anime-filters' });
    const search = h('input', { type: 'search', placeholder: 'Search anime', value: state.q, autocomplete: 'off', 'aria-label': 'Search anime',
      onkeydown: (e) => { if (e.key === 'Enter') { state.q = search.value.trim(); show(); } },
      onsearch: () => { if (!search.value && state.q) { state.q = ''; show(); } } });
    function drawFilters() {
      const chips = (pairs, cur, set) => h('div', { class: 'seg' }, pairs.map(([v, label]) => h('button', { class: cur === v ? 'on' : '', onclick: () => { set(v); show(); } }, label)));
      const genre = h('select', { class: 'pill', 'aria-label': 'Genre', onchange: (e) => { state.genre = e.target.value; show(); } }, GENRES.map((g) => h('option', { value: g, selected: g === state.genre }, g || 'All genres')));
      filters.replaceChildren(
        h('div', { class: 'seg' },
          h('button', { onclick: () => (location.hash = '#/discover/movie') }, 'Movies'),
          h('button', { onclick: () => (location.hash = '#/discover/series') }, 'Series'),
          h('button', { class: 'on' }, 'Anime')),
        chips([['all', 'All'], ['sub', 'Subbed'], ['dub', 'Dubbed']], state.audio, (v) => { state.audio = v; store('ss.anime.audio', v); }),
        genre, search);
      sortRow.replaceChildren(chips(KINDS, state.kind, (v) => { state.kind = v; state.q = ''; search.value = ''; store('ss.anime.kind', v); }));
    }
    const sortRow = h('div', { class: 'filters anime-sort' });
    view.replaceChildren(filters, sortRow, grid, status, h('p', { style: 'text-align:center;margin-top:28px' }, more));
    show();
  }

  return { discover, badges, pref, setPref, mark, info };
})();
