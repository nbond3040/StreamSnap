'use strict';
// "What else has this person made?" Cinemeta's search also matches cast and crew, so searching a name returns titles
// they're credited on, but it also returns titles that merely have that word in the name. Each hit's own credits are
// checked so the list is only titles the person is really in, tagged with their role.

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const year = (m) => parseInt(String(m.releaseInfo || m.year || '').slice(0, 4), 10) || 0;

function roleIn(meta, key) {
  const has = (list) => (Array.isArray(list) ? list : []).some((n) => norm(n) === key);
  const roles = [];
  if (has(meta.director)) roles.push('Director');
  if (has(meta.cast)) roles.push('Actor');
  if (has(meta.writer)) roles.push('Writer');
  return roles;
}

/** deps: { catalog(type, {search}), meta(type, id) }. `budgetMs` caps the credit checks. */
async function find(name, deps, { perType = 24, workers = 10, budgetMs = 7000 } = {}) {
  const key = norm(name);
  if (key.length < 2) return { name, items: [], other: [] };
  const lists = await Promise.all(['movie', 'series'].map((type) =>
    deps.catalog(type, { search: name }).then((l) => l.slice(0, perType).map((m) => ({ ...m, type }))).catch(() => [])));
  const hits = lists.flat();
  const verified = new Map(), failed = new Set();
  const deadline = Date.now() + budgetMs;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(workers, hits.length) }, async () => {
    while (i < hits.length && Date.now() < deadline) {
      const m = hits[i++], id = m.id || m.imdb_id;
      try { const roles = roleIn((await deps.meta(m.type, id)) || {}, key); if (roles.length) verified.set(id, roles); }
      catch { failed.add(id); }
    }
  }));
  const done = new Set(hits.slice(0, i).map((m) => m.id || m.imdb_id));
  const items = [], other = [];
  for (const m of hits) {
    const id = m.id || m.imdb_id;
    if (verified.has(id)) items.push({ ...m, roles: verified.get(id) });
    else if (!done.has(id) || failed.has(id)) other.push(m);          // couldn't be checked in time: shown separately, not dropped
  }
  const newest = (a, b) => year(b) - year(a);
  return { name, items: items.sort(newest), other: other.sort(newest) };
}

module.exports = { find, norm };
