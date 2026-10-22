'use strict';
// NBA schedule, scores and "where can I watch this" for the calendar.
// Games come from ESPN's public scoreboard (no key). Streams are channels from the user's own Live TV provider:
// a channel is a candidate when its name carries one of the game's broadcasters (ESPN, TNT, NBA TV, ...) or the
// teams themselves (many IPTV services have per-game "NBA 03 | Lakers vs Celtics" channels), and the best candidate
// is the highest-quality one (4K > FHD > HD > SD) among those that fit.

const BASE = () => process.env.STREAMSNAP_NBA_URL || 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const FRESH_MS = 5 * 60 * 1000, LIVE_MS = 30 * 1000, STALE_MS = 6 * 3600 * 1000;
const GAME_MS = 3 * 3600 * 1000;   // an NBA game takes about 2.5 h; the guide window we look in

const cache = new Map();           // "from-to" -> { at, games, live }

const ymd = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };

function team(c) {
  const t = c.team || {};
  return {
    id: String(t.id || ''), abbr: t.abbreviation || '', name: t.displayName || '', nick: t.shortDisplayName || t.name || '',
    logo: typeof t.logo === 'string' && /^https?:\/\//.test(t.logo) ? t.logo : '',
    score: c.score != null && c.score !== '' ? Number(c.score) : null, record: ((c.records || [])[0] || {}).summary || '',
    winner: !!c.winner,
  };
}

/** One ESPN event -> the small shape the calendar uses. */
function normalize(ev) {
  const comp = (ev.competitions || [])[0];
  if (!comp) return null;
  const home = (comp.competitors || []).find((c) => c.homeAway === 'home'), away = (comp.competitors || []).find((c) => c.homeAway === 'away');
  const start = Date.parse(ev.date);
  if (!home || !away || !Number.isFinite(start)) return null;
  const st = (ev.status || {}).type || {};
  const state = st.state === 'in' ? 'live' : st.state === 'post' ? 'final' : 'scheduled';
  const names = new Set();
  for (const b of comp.broadcasts || []) for (const n of b.names || []) names.add(String(n));
  for (const g of comp.geoBroadcasts || []) { const n = g.media && g.media.shortName; if (n) names.add(String(n)); }
  return {
    id: String(ev.id), start, state, detail: st.shortDetail || st.description || '', postponed: /postponed|canceled|cancelled/i.test(st.description || st.detail || ''),
    home: team(home), away: team(away), broadcasts: [...names], venue: ((comp.venue || {}).fullName) || '',
  };
}

async function getEvents(key) {
  const url = `${BASE()}/scoreboard?dates=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    throw Object.assign(new Error(`The NBA schedule service answered ${r.status} for dates=${key}${body ? ` (${body})` : ''}`), { status: r.status });
  }
  return ((await r.json()).events || []);
}

// Requests are made per week (Sunday-aligned, so neighbouring months share them) or, when the service accepts it,
// as one range. Which one works is learned once and remembered, so a refusing service isn't asked twice.
let mode = 'range';                          // 'range' -> 'week' -> 'day' (only ever steps down)
const chunkCache = new Map();                // "dates" key -> { at, events }
const WEEK = 7 * 86400000;
const startOfWeek = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()); };

async function cachedChunk(key, now) {
  const hit = chunkCache.get(key);
  if (hit && now - hit.at < (hit.live ? LIVE_MS : FRESH_MS)) return hit.events;
  try {
    const events = await getEvents(key);
    chunkCache.set(key, { at: now, events, live: events.some((e) => (((e.status || {}).type || {}).state) === 'in') });
    if (chunkCache.size > 400) chunkCache.delete(chunkCache.keys().next().value);
    return events;
  } catch (e) { if (hit && now - hit.at < STALE_MS) return hit.events; throw e; }
}

async function inBatches(keys, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, keys.length) }, async () => { while (i < keys.length) { const k = keys[i++]; out.push(await fn(k)); } }));
  return out;
}

async function eventsFor(fromMs, toMs, now) {
  if (mode === 'range') {
    try { return await cachedChunk(`${ymd(fromMs)}-${ymd(toMs)}`, now); }
    catch (e) { if (e.status !== 400 && e.status !== 404 && e.status !== 422) throw e; mode = 'week'; }
  }
  const keys = [];
  if (mode === 'week') for (let t = startOfWeek(fromMs); t <= toMs; t += WEEK) keys.push(`${ymd(t)}-${ymd(t + 6 * 86400000)}`);
  else for (let t = fromMs; t <= toMs; t += 86400000) keys.push(ymd(t));
  const out = new Map(); let lastErr = null, ok = 0, refused = 0;
  await inBatches(keys, 6, async (k) => {
    try { for (const ev of await cachedChunk(k, now)) out.set(String(ev.id), ev); ok++; }
    catch (e) { lastErr = e; if (e.status === 400 || e.status === 404 || e.status === 422) refused++; }
  });
  if (!ok && mode === 'week' && refused) { mode = 'day'; return eventsFor(fromMs, toMs, now); }   // weeks refused too: single days
  if (!ok) throw lastErr || new Error('The NBA schedule service refused the request');
  return [...out.values()];
}

async function fetchRange(fromMs, toMs, now = Date.now()) {
  const key = `${ymd(fromMs)}-${ymd(toMs)}`;
  const hit = cache.get(key);
  const ttl = hit && hit.live ? LIVE_MS : FRESH_MS;
  if (hit && now - hit.at < ttl) return hit.games;
  try {
    const games = (await eventsFor(fromMs, toMs, now)).map(normalize).filter(Boolean).sort((a, b) => a.start - b.start);
    cache.set(key, { at: now, games, live: games.some((g) => g.state === 'live') });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return games;
  } catch (e) {
    if (hit && now - hit.at < STALE_MS) return hit.games;   // stale schedule beats an error page
    throw e;
  }
}

// ---------- matching channels to a game ----------
const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Quality implied by the channel's name, as [points, label]. */
function qualityOf(name) {
  const w = new Set(words(name));
  const has = (...x) => x.some((t) => w.has(t));
  let q;
  if (has('4k', 'uhd', '2160p')) q = [40, '4K'];
  else if (has('fhd', '1080', '1080p', '1080i')) q = [30, 'FHD'];
  else if (has('hd', 'hevc')) q = [20, 'HD'];
  else if (has('720', '720p')) q = [18, '720p'];
  else if (has('sd', '480', '480p', '360p', 'lq')) q = [0, 'SD'];
  else q = [10, ''];
  if (has('60fps', '50fps') || /\b60\s?fps\b/i.test(name)) q = [q[0] + 4, q[1]];
  return q;
}

// Broadcaster names ESPN prints -> the words a provider puts in channel names
const NETWORK_ALIASES = { 'amazon prime video': ['prime'], 'prime video': ['prime'], 'nbc sports': ['nbc'], 'espn+': ['espn'], 'abc': ['abc'], 'nba tv': ['nba', 'tv'], 'peacock': ['peacock'] };

function networkWords(b) {
  const k = String(b).toLowerCase().trim();
  return NETWORK_ALIASES[k] || words(b);
}

function containsRun(hay, needle) {
  if (!needle.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return true; }
  return false;
}

/**
 * Rank the provider's channels for one game. `channels` is the Xtream list ({id,num,name,logo}).
 * Returns up to `limit` candidates, best first: { id, num, name, logo, quality, score, why }.
 */
function matchChannels(game, channels, limit = 12) {
  const homeNick = words(game.home.nick), awayNick = words(game.away.nick);
  const homeCity = words(game.home.name.replace(game.home.nick, '')), awayCity = words(game.away.name.replace(game.away.nick, ''));
  const nets = game.broadcasts.map((b) => ({ b, w: networkWords(b) })).filter((n) => n.w.length);
  const out = [];
  for (const ch of channels) {
    const w = words(ch.name);
    if (w.length === 0 || /\b(vod|movie|series)\b/i.test(ch.name)) continue;
    let pts = 0, why = '';
    const hNick = containsRun(w, homeNick), aNick = containsRun(w, awayNick);
    const hCity = homeCity.length && containsRun(w, homeCity), aCity = awayCity.length && containsRun(w, awayCity);
    if ((hNick || hCity) && (aNick || aCity)) { pts = 140; why = 'Channel for this game'; }
    else if (hNick || aNick) { pts = 45; why = 'Team channel'; }
    const nbaWord = w.includes('nba');
    // "ESPN" must not light up "ESPN2" or "ESPN Deportes": whole words only, so the extra word makes a different channel
    for (const n of nets) if (pts < 70 && containsRun(w, n.w)) { pts = 70; why = `Carries ${n.b}`; }
    if (!pts && nbaWord) { pts = 35; why = 'NBA channel'; }
    if (!pts) continue;
    if (w.some((t) => ['es', 'esp', 'deportes', 'latino', 'fr', 'de', 'it', 'pt', 'br', 'ar', 'radio'].includes(t))) pts -= 40;   // other-language/audio-only feeds rank lower
    const [qp, ql] = qualityOf(ch.name);
    out.push({ id: ch.id, num: ch.num, name: ch.name, logo: ch.logo || '', quality: ql, match: pts, score: pts + qp, why });
  }
  return out.sort((a, b) => b.score - a.score || a.num - b.num).slice(0, limit);
}

/** Boost channels whose programme guide says this game is on right now / at tip-off. */
async function confirmWithGuide(game, cands, epgFor, top = 10) {
  const from = game.start - 30 * 60 * 1000, to = game.start + GAME_MS;
  const nicks = [game.home.nick, game.away.nick].map((n) => n.toLowerCase());
  await Promise.all(cands.slice(0, top).map(async (c) => {
    try {
      const list = await epgFor(c.id);
      const hit = (list || []).find((p) => p.start < to && p.end > from && (nicks.some((n) => p.title.toLowerCase().includes(n)) || /\bnba\b/i.test(p.title) || /\bbasketball\b/i.test(p.title)));
      if (hit) { c.score += 90; c.guide = hit.title; c.why = 'Guide lists this game'; }
    } catch { /* no guide data: keep the name match */ }
  }));
  return cands.sort((a, b) => b.score - a.score || a.num - b.num);
}

module.exports = { fetchRange, normalize, matchChannels, confirmWithGuide, qualityOf, _cache: cache, _reset() { cache.clear(); chunkCache.clear(); mode = 'range'; }, GAME_MS };
