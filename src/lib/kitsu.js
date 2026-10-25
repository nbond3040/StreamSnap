'use strict';
// Anime catalog and episode lists from the Stremio Kitsu addon (Kitsu is the largest open anime database; its ids, "kitsu:123" for a show and
// "kitsu:123:5" for episode 5, are what Torrentio's anime providers (Nyaa, TokyoTosho, AniDex) are searched with).
const BASE = () => process.env.STREAMSNAP_KITSU_URL || 'https://anime-kitsu.strem.fun';
const cache = new Map();
const TTL = 10 * 60 * 1000, MANIFEST_TTL = 6 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, ttl = TTL) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(BASE() + path, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
      if (res.ok) {
        const value = await res.json();
        if ((value.metas && value.metas.length) || value.meta || value.catalogs) cache.set(path, { at: Date.now(), value });
        return value;
      }
      lastErr = Object.assign(new Error(`The anime catalog returned HTTP ${res.status}`), { status: res.status });
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { lastErr = new Error(`Couldn’t reach the anime catalog (${e.name === 'TimeoutError' ? 'timed out' : e.message})`); }
    if (i < 2) await sleep(400 * 2 ** i);
  }
  if (hit) return hit.value;           // stale beats an error page
  throw lastErr;
}

// What the addon offers: catalogs for trending / popular / airing / top rated, and a searchable list with genres.
const FALLBACK = [
  { type: 'anime', id: 'kitsu-anime-trending' }, { type: 'anime', id: 'kitsu-anime-popular' }, { type: 'anime', id: 'kitsu-anime-airing' },
  { type: 'anime', id: 'kitsu-anime-rating' }, { type: 'anime', id: 'kitsu-anime-list', extra: [{ name: 'search' }, { name: 'genre' }] },
];
async function catalogs() {
  try {
    const m = await get('/manifest.json', MANIFEST_TTL);
    const list = (m.catalogs || []).filter((c) => c && c.id);
    if (list.length) return list;
  } catch { /* the built-in names usually still work */ }
  return FALLBACK;
}
const takes = (c, name) => (c.extra || []).some((e) => (typeof e === 'string' ? e : e.name) === name) || (c.extraSupported || []).includes(name);

/** Cover/list item in the same shape as Cinemeta's, plus anime: true. */
function item(m) {
  const id = m.id || (m.kitsu_id ? `kitsu:${m.kitsu_id}` : '');
  if (!/^kitsu:\d+$/.test(id)) return null;
  return {
    id, type: m.type === 'movie' || m.subtype === 'movie' ? 'movie' : 'series', anime: true, name: m.name || m.title || id,
    poster: m.poster || '', background: m.background || '', description: m.description || '', genres: m.genres || [],
    releaseInfo: m.releaseInfo || m.year || '', imdbRating: m.imdbRating || '', runtime: m.runtime || '',
  };
}

/** kind: trending | popular | airing | rating. `q` searches, `genre` filters (both use the addon's searchable list). */
async function catalog({ kind = 'trending', genre = '', q = '', skip = 0 } = {}) {
  const all = await catalogs();
  const list = all.find((c) => takes(c, 'search')) || all.find((c) => /list/.test(c.id));
  const byKind = all.find((c) => new RegExp(kind, 'i').test(c.id)) || all[0];
  const extra = [];
  let cat = byKind;
  if (q) { cat = list || byKind; extra.push(`search=${encodeURIComponent(q)}`); }
  else if (genre && list) { cat = list; extra.push(`genre=${encodeURIComponent(genre)}`); }
  if (!q && Number(skip)) extra.push(`skip=${Number(skip) || 0}`);
  if (!cat) throw new Error('The anime catalog has no lists');
  const tail = extra.length ? `/${extra.join('&')}` : '';
  const body = await get(`/catalog/${cat.type || 'anime'}/${encodeURIComponent(cat.id)}${tail}.json`);
  return (body.metas || []).map(item).filter(Boolean);
}

/** A show or film with its episode list ([{ id: 'kitsu:1:5', season: 1, episode: 5, title, released }]). */
async function meta(id) {
  if (!/^kitsu:\d+$/.test(id)) throw new Error('invalid id');
  let body;
  try { body = await get(`/meta/anime/${id}.json`); }
  catch (e) { if (e.status !== 404) throw e; body = await get(`/meta/series/${id}.json`); }
  const m = body.meta;
  if (!m) return null;
  const base = item({ ...m, id }) || {};
  const videos = (m.videos || []).map((v, i) => {
    const episode = Number.isFinite(+v.episode) && +v.episode > 0 ? +v.episode : Number.isFinite(+v.number) && +v.number > 0 ? +v.number : i + 1;
    return { id: v.id && /^kitsu:\d+:\d+$/.test(v.id) ? v.id : `${id}:${episode}`, season: 1, episode, name: v.title || v.name || `Episode ${episode}`, released: v.released || '', thumbnail: v.thumbnail || '' };
  });
  const isMovie = m.type === 'movie' || m.subtype === 'movie' || videos.length <= 1;
  return { ...m, ...base, id, imdb_id: id, type: isMovie ? 'movie' : 'series', anime: true, videos: isMovie ? [] : videos, episodeCount: videos.length };
}

module.exports = { catalog, meta, catalogs, _cache: cache };
