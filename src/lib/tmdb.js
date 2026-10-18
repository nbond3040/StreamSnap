'use strict';
// Franchise ("collection") lookup. Cinemeta has no sequel data; TMDB groups films into collections and
// is free with an API key. Accepts either the v3 API key or the v4 read-access token.
const BASE = process.env.STREAMSNAP_TMDB_URL || 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const cache = new Map();
const DAY = 24 * 3600 * 1000;

async function call(path, key) {
  const bearer = key.length > 40; // v4 tokens are long JWTs, v3 keys are 32 hex characters
  const url = BASE + path + (bearer ? '' : `${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`);
  const res = await fetch(url, { headers: bearer ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(12000) });
  if (res.status === 401) throw new Error('TMDB rejected the API key. Check it in Settings.');
  if (!res.ok) throw new Error(`TMDB returned HTTP ${res.status}`);
  return res.json();
}

/** The films in the same collection as an IMDb title, oldest first. Returns null when it isn't part of one. */
async function collectionFor(imdbId, key) {
  if (!/^tt\d+$/.test(imdbId)) throw new Error('invalid id');
  const hit = cache.get(imdbId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  let value = null;
  const found = await call(`/find/${imdbId}?external_source=imdb_id`, key);
  const movie = (found.movie_results || [])[0];
  const detail = movie && (await call(`/movie/${movie.id}`, key));
  const col = detail && detail.belongs_to_collection;
  if (col) {
    const c = await call(`/collection/${col.id}`, key);
    const parts = await Promise.all((c.parts || []).map(async (p) => {
      let imdb = p.id === movie.id ? imdbId : null;
      if (!imdb) { try { imdb = (await call(`/movie/${p.id}/external_ids`, key)).imdb_id; } catch { /* skip parts we can't link */ } }
      return imdb && { id: imdb, type: 'movie', name: p.title, year: (p.release_date || '').slice(0, 4), date: p.release_date || '', poster: p.poster_path ? IMG + p.poster_path : '' };
    }));
    const list = parts.filter(Boolean).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    if (list.length > 1) value = { name: c.name || col.name, parts: list };
  }
  cache.set(imdbId, { at: Date.now(), ttl: value ? DAY : DAY / 4, value });
  return value;
}

module.exports = { collectionFor, _cache: cache };
