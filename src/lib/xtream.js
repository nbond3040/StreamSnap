'use strict';
// Minimal Xtream Codes client. Credentials stay on the server; the browser only sees channel ids.
const clients = new Map();
const LIST_TTL = 10 * 60 * 1000, EPG_TTL = 3 * 60 * 1000;

/** "host:8080" or "http://host/player_api.php?x=1" -> "http://host:8080" */
function normalizeBase(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('Enter your Xtream server URL.');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/(player_api|get|xmltv|panel_api)\.php.*$/i, '').replace(/\/+$/, '');
  try { if (!new URL(u).hostname) throw 0; } catch { throw new Error("That server URL isn't valid."); }
  return u;
}

/** EPG text is base64 on most panels and plain on a few. */
function decodeText(s) {
  if (typeof s !== 'string' || !s) return '';
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) {
    const d = Buffer.from(s, 'base64').toString('utf8');
    if (!/[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(d)) return d;
  }
  return s;
}

class Xtream {
  constructor({ url, user, pass }) {
    this.base = normalizeBase(url);
    this.user = String(user || '').trim();
    this.pass = String(pass || '');
    if (!this.user || !this.pass) throw new Error('Enter your username and password.');
    this.cache = new Map();
  }

  async api(action, params = {}) {
    const qs = new URLSearchParams({ username: this.user, password: this.pass, ...(action ? { action } : {}), ...params });
    let res;
    try { res = await fetch(`${this.base}/player_api.php?${qs}`, { headers: { 'user-agent': 'StreamSnap/0.1' }, signal: AbortSignal.timeout(25000) }); }
    catch (e) { throw new Error(`Couldn't reach the server (${e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message}).`); }
    if (res.status === 401 || res.status === 403) throw new Error('The server rejected the username or password.');
    if (!res.ok) throw new Error(`The server returned HTTP ${res.status}.`);
    try { return JSON.parse(await res.text()); } catch { throw new Error("The server didn't return Xtream data. Check the URL."); }
  }

  async cached(name, ttl, load) {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    try { const value = await load(); this.cache.set(name, { at: Date.now(), value }); return value; }
    catch (e) { if (hit) return hit.value; throw e; }
  }

  async account() {
    const u = (await this.api('')).user_info;
    if (!u || Number(u.auth) !== 1) throw new Error('The server rejected the username or password.');
    return { status: u.status || 'Active', expires: Number(u.exp_date) > 0 ? Number(u.exp_date) * 1000 : null, maxConnections: Number(u.max_connections) || null };
  }

  categories() {
    return this.cached('cats', LIST_TTL, async () => {
      const j = await this.api('get_live_categories');
      return (Array.isArray(j) ? j : []).map((c) => ({ id: String(c.category_id), name: String(c.category_name || 'Other') }));
    });
  }

  channels() {
    return this.cached('channels', LIST_TTL, async () => {
      const j = await this.api('get_live_streams');
      return (Array.isArray(j) ? j : Object.values(j || {})).filter((c) => c && c.stream_id != null).map((c, i) => ({
        id: Number(c.stream_id), num: Number(c.num) || i + 1, name: String(c.name || `Channel ${c.stream_id}`).trim(),
        logo: typeof c.stream_icon === 'string' && /^https?:\/\//i.test(c.stream_icon) ? c.stream_icon : '', cat: String(c.category_id ?? ''),
      })).sort((a, b) => a.num - b.num);
    });
  }

  /** Current and upcoming programmes: [{ title, desc, start, end }] with epoch-ms times. */
  epg(id) {
    return this.cached(`epg:${id}`, EPG_TTL, async () => {
      const j = await this.api('get_short_epg', { stream_id: String(id), limit: '4' });
      const time = (stamp, text) => (Number(stamp) ? Number(stamp) * 1000 : Date.parse(String(text).replace(' ', 'T') + 'Z'));
      return (j.epg_listings || []).map((l) => ({ title: decodeText(l.title) || 'No title', desc: decodeText(l.description), start: time(l.start_timestamp, l.start), end: time(l.stop_timestamp, l.end) }))
        .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end)).sort((a, b) => a.start - b.start);
    });
  }

  liveUrl(id) { return `${this.base}/live/${encodeURIComponent(this.user)}/${encodeURIComponent(this.pass)}/${Number(id)}.ts`; }
}

/** One client per credential set so the caches survive between requests. */
function clientFor(cfg) {
  const key = `${cfg.xtreamUrl}|${cfg.xtreamUser}|${cfg.xtreamPass}`;
  if (!clients.has(key)) { clients.clear(); clients.set(key, new Xtream({ url: cfg.xtreamUrl, user: cfg.xtreamUser, pass: cfg.xtreamPass })); }
  return clients.get(key);
}

module.exports = { Xtream, clientFor, normalizeBase, decodeText };
