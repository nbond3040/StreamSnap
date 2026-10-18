'use strict';
// Cinemeta is the same metadata addon Stremio ships with.
const BASE = process.env.STREAMSNAP_CINEMETA_URL || 'https://v3-cinemeta.strem.io';
const cache = new Map();
const TTL = 10 * 60 * 1000;
const RETRY_DELAYS = [400, 1200]; // up to 3 attempts; Cinemeta's gateway times out now and then (HTTP 502/503/504)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries on server/network errors; falls back to the last good copy (however old) if it still fails. */
async function get(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const value = await res.json();
        cache.set(path, { at: Date.now(), value });
        return value;
      }
      lastErr = new Error(`Cinemeta returned HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break; // 4xx won't improve by retrying
    } catch (e) {
      lastErr = new Error(`Couldn't reach Cinemeta (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
    if (attempt < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[attempt]);
  }
  if (hit) return hit.value; // stale beats an error page
  throw lastErr;
}

const TYPES = new Set(['movie', 'series']);
function checkType(type) { if (!TYPES.has(type)) throw new Error('type must be movie or series'); }

async function catalog(type, { search = '', genre = '', skip = 0 } = {}) {
  checkType(type);
  const extra = [];
  if (search) extra.push(`search=${encodeURIComponent(search)}`);
  else {
    if (genre) extra.push(`genre=${encodeURIComponent(genre)}`);
    if (skip) extra.push(`skip=${Number(skip) || 0}`);
  }
  const tail = extra.length ? `/${extra.join('&')}` : '';
  const body = await get(`/catalog/${type}/top${tail}.json`);
  return body.metas || [];
}

async function meta(type, id) {
  checkType(type);
  if (!/^tt\d+$/.test(id)) throw new Error('invalid id');
  const body = await get(`/meta/${type}/${id}.json`);
  return body.meta || null;
}

module.exports = { catalog, meta, _cache: cache };
