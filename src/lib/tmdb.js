'use strict';
// Franchise ("collection") lookup. Cinemeta has no sequel data; TMDB groups films into collections and
// is free with an API key. Accepts either the v3 API key or the v4 read-access token.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const BASE = () => process.env.STREAMSNAP_TMDB_URL || 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const cache = new Map();
const DAY = 24 * 3600 * 1000;

async function call(path, key) {
  const bearer = key.length > 40; // v4 tokens are long JWTs, v3 keys are 32 hex characters
  const url = BASE() + path + (bearer ? '' : `${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`);
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

// ---------- a person's full filmography ----------
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const PROFILE = 'https://image.tmdb.org/t/p/w185';
const SKIP_GENRES = new Set([10763, 10767, 10764, 10766]);          // news, talk shows, reality, soaps: appearances, not work
const CREW_ROLES = { Director: 'Director', Writer: 'Writer', Screenplay: 'Writer', Story: 'Writer', Creator: 'Writer' };
const MAX_TITLES = 160;

// TMDB id -> IMDb id never changes, so it's remembered on disk: the second visit to anyone's page is nearly free.
let idMap = null, idTimer = null;
const idFile = () => path.join(config.dir, 'tmdb-ids.json');
function ids() {
  if (idMap) return idMap;
  idMap = new Map();
  try { for (const [k, v] of JSON.parse(fs.readFileSync(idFile(), 'utf8'))) idMap.set(k, v); } catch { /* first run */ }
  return idMap;
}
function saveIds() {
  clearTimeout(idTimer);
  idTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
      const tmp = idFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...ids().entries()].slice(-20000)), { mode: 0o600 });
      fs.renameSync(tmp, idFile());
    } catch { /* read-only home: just don't remember */ }
  }, 2000);
  if (idTimer.unref) idTimer.unref();
}
async function imdbOf(kind, id, key) {
  const k = `${kind}:${id}`, m = ids();
  if (m.has(k)) return m.get(k);
  try {
    const v = (await call(`/${kind}/${id}/external_ids`, key)).imdb_id || '';
    m.set(k, v); saveIds();
    return v;
  } catch { return null; }                  // couldn't ask: don't remember a "no"
}

/** The TMDB person id for `name`; when the title they were opened from is known, the credit on that title decides. */
async function personId(name, key, fromImdb) {
  const want = norm(name);
  if (/^tt\d+$/.test(fromImdb || '')) {
    try {
      const found = await call(`/find/${fromImdb}?external_source=imdb_id`, key);
      const mv = (found.movie_results || [])[0], tv = (found.tv_results || [])[0];
      const credits = mv ? await call(`/movie/${mv.id}/credits`, key) : tv ? await call(`/tv/${tv.id}/aggregate_credits`, key) : null;
      const hit = credits && [...(credits.cast || []), ...(credits.crew || [])].find((p) => norm(p.name) === want);
      if (hit) return hit.id;
    } catch (e) { if (/rejected the API key/.test(e.message)) throw e; /* fall through to a name search */ }
  }
  const res = (await call(`/search/person?query=${encodeURIComponent(name)}`, key)).results || [];
  const exact = res.filter((p) => norm(p.name) === want).sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  return (exact || res[0] || {}).id || null;
}

/**
 * Everything a person is credited on: acting, directing, writing and creating, as titles we can open (IMDb ids).
 * Returns { name, photo, department, bio, items: [{ id, type, name, year, date, poster, roles, character, popularity }] }.
 */
async function filmography(name, key, fromImdb) {
  const ck = `p:${norm(name)}:${fromImdb || ''}`, hit = cache.get(ck);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const pid = await personId(name, key, fromImdb);
  if (!pid) return { name, photo: '', department: '', bio: '', items: [] };
  const p = await call(`/person/${pid}?append_to_response=combined_credits`, key);
  const by = new Map();
  const add = (c, role, character) => {
    if (c.media_type !== 'movie' && c.media_type !== 'tv') return;
    if (c.media_type === 'tv' && (c.genre_ids || []).some((g) => SKIP_GENRES.has(g))) return;
    if (character && /\b(self|himself|herself|themselves|archive footage|uncredited)\b/i.test(character)) return;
    const date = c.release_date || c.first_air_date || '';
    if (!date) return;
    const k = `${c.media_type}:${c.id}`;
    if (!by.has(k)) by.set(k, { kind: c.media_type, tmdb: c.id, name: c.title || c.name || '', date, poster: c.poster_path ? IMG + c.poster_path : '', popularity: c.popularity || 0, votes: c.vote_count || 0, roles: new Set(), character: '' });
    const e = by.get(k); e.roles.add(role); if (character && !e.character) e.character = character;
  };
  for (const c of (p.combined_credits || {}).cast || []) add(c, 'Actor', c.character);
  for (const c of (p.combined_credits || {}).crew || []) if (CREW_ROLES[c.job]) add(c, CREW_ROLES[c.job], '');
  const picked = [...by.values()].sort((a, b) => b.votes - a.votes || b.popularity - a.popularity).slice(0, MAX_TITLES);
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(12, picked.length) }, async () => {
    while (i < picked.length) {
      const e = picked[i++], imdb = await imdbOf(e.kind, e.tmdb, key);
      if (imdb) out.push({ id: imdb, type: e.kind === 'tv' ? 'series' : 'movie', name: e.name, year: e.date.slice(0, 4), releaseInfo: e.date.slice(0, 4), date: e.date, poster: e.poster, roles: [...e.roles], character: e.character, popularity: e.popularity });
    }
  }));
  out.sort((a, b) => b.date.localeCompare(a.date));
  const value = { name: p.name || name, photo: p.profile_path ? PROFILE + p.profile_path : '', department: p.known_for_department || '', bio: (p.biography || '').slice(0, 600), born: p.birthday || '', items: out };
  cache.set(ck, { at: Date.now(), ttl: out.length ? DAY / 2 : 5 * 60 * 1000, value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { collectionFor, filmography, _cache: cache, _ids: () => ids() };
