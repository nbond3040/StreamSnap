'use strict';
// Cinemeta is the same metadata addon Stremio ships with.
const BASE = process.env.STREAMSNAP_CINEMETA_URL || 'https://v3-cinemeta.strem.io';
const cache = new Map();
const TTL = 10 * 60 * 1000;

async function get(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Cinemeta returned HTTP ${res.status}`);
  const value = await res.json();
  cache.set(path, { at: Date.now(), value });
  return value;
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

module.exports = { catalog, meta };
