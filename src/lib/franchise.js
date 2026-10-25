'use strict';
// Anime seasons are separate entries in Kitsu ("Show", "Show 2nd Season", "Show Movie"...) joined by sequel/prequel links. This follows the
// links so a franchise can be shown as one title: its seasons in order, and its films, OVAs and specials as related.
const { createStore } = require('./jsonstore');

const API = () => process.env.STREAMSNAP_KITSU_API_URL || 'https://kitsu.io/api/edge';
const store = createStore('anime-franchise', { max: 6000, ttl: 7 * 24 * 3600 * 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIELDS = 'fields%5Banime%5D=canonicalTitle,titles,subtype,startDate,posterImage,episodeCount';

async function getJson(path) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API() + path, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/vnd.api+json' } });
      if (r.ok) return r.json();
      last = new Error(`Kitsu answered ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    if (i < 2) await sleep(400 * 2 ** i);
  }
  throw last;
}

function info(res) {
  const a = res.attributes || {};
  const t = a.titles || {};
  return {
    n: Number(res.id), id: `kitsu:${res.id}`, name: a.canonicalTitle || t.en || t.en_jp || `kitsu:${res.id}`, subtype: String(a.subtype || '').toLowerCase(),
    date: a.startDate || '', year: (a.startDate || '').slice(0, 4), episodes: a.episodeCount || 0,
    poster: (a.posterImage && (a.posterImage.medium || a.posterImage.small || a.posterImage.original)) || '',
  };
}

/** One title's own details. */
async function node(n) {
  const key = `n:${n}`, hit = store.get(key);
  if (hit) return hit;
  const j = await getJson(`/anime/${n}?${FIELDS}`);
  const v = info(j.data);
  store.set(key, v);
  return v;
}

/** The titles directly linked from `n`: [{ role, ...info }] (anime only: a manga adaptation isn't a season). */
async function relations(n) {
  const key = `r:${n}`, hit = store.get(key);
  if (hit) return hit;
  const j = await getJson(`/anime/${n}/media-relationships?include=destination&page%5Blimit%5D=20&fields%5BmediaRelationships%5D=role,destination&${FIELDS}`);
  const byId = new Map((j.included || []).filter((x) => x.type === 'anime').map((x) => [x.id, info(x)]));
  const out = [];
  for (const rel of j.data || []) {
    const d = rel.relationships && rel.relationships.destination && rel.relationships.destination.data;
    if (d && d.type === 'anime' && byId.has(d.id)) out.push({ role: (rel.attributes || {}).role, ...byId.get(d.id) });
  }
  store.set(key, out);
  return out;
}

const earliest = (a, b) => (a.date || '9999').localeCompare(b.date || '9999');
const isSeason = (m) => m.subtype === 'tv' || (m.subtype === 'ona' && m.episodes >= 6);

/**
 * The franchise `id` belongs to: { root, members: [{ id, name, year, date, subtype, episodes, poster, season }] } (season: 1, 2, ... or 0 for
 * films / OVAs / specials), oldest first; null when it stands alone or Kitsu can't be reached.
 */
async function groupOf(id) {
  const m = /^kitsu:(\d+)$/.exec(id);
  if (!m) return null;
  const memo = store.get(`g:${m[1]}`);
  if (memo !== undefined) return memo;
  let out = null;
  try {
    // back to the first entry: follow "prequel" links (the earliest one when there are several)
    let cur = Number(m[1]); const seen = new Set([cur]);
    for (let i = 0; i < 10; i++) {
      const prev = (await relations(cur)).filter((r) => r.role === 'prequel' && !seen.has(r.n)).sort(earliest)[0];
      if (!prev) break;
      seen.add(prev.n); cur = prev.n;
    }
    // ...and forward from it along "sequel" links
    const root = await node(cur), members = new Map([[root.n, root]]);
    const queue = [root.n];
    while (queue.length && members.size < 30) {
      const n = queue.shift();
      for (const r of await relations(n)) if (r.role === 'sequel' && !members.has(r.n)) { members.set(r.n, r); queue.push(r.n); }
    }
    if (members.size > 1) {
      let season = 0;
      const list = [...members.values()].sort(earliest).map((x) => ({ id: x.id, name: x.name, year: x.year, date: x.date, subtype: x.subtype, episodes: x.episodes, poster: x.poster, season: isSeason(x) ? ++season : 0 }));
      out = { root: root.id, members: list, seasons: season };
      for (const x of list) store.set(`g:${x.n || Number(x.id.slice(6))}`, out);
    }
  } catch { return undefined; }                           // couldn't look: don't remember "no franchise"
  if (!out) store.set(`g:${m[1]}`, null, 24 * 3600 * 1000);
  return out;
}

module.exports = { groupOf, relations, node, _store: store };
