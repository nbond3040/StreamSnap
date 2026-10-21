'use strict';
// What we've learned about a release file (duration, codecs, audio languages, chapters) outlives the session: the same
// release shows up for the same title again and again, and re-inspecting it over the network is the slowest part of a lookup.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const MAX = 4000;
let map = null, timer = null;
const file = () => path.join(config.dir, 'probe-cache.json');

function load() {
  if (map) return map;
  map = new Map();
  try { for (const [k, v] of JSON.parse(fs.readFileSync(file(), 'utf8'))) map.set(k, v); } catch { /* first run */ }
  return map;
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...map.entries()]), { mode: 0o600 });
      fs.renameSync(tmp, file());
    } catch { /* a read-only home is fine: we just won't remember */ }
  }, 2000);
  if (timer.unref) timer.unref();
}

/** A release is identified by its file name and size, which are stable across sessions (unlike the signed URL). */
const keyOf = (s) => (s && s.filename && s.size ? `${s.filename}|${s.size}` : null);

function get(s) {
  const k = keyOf(s);
  if (!k) return null;
  const m = load(), v = m.get(k);
  if (v) { m.delete(k); m.set(k, v); }    // most recently used goes last
  return v || null;
}
function set(s, info) {
  const k = keyOf(s);
  if (!k || !info.probed) return;
  const m = load();
  m.delete(k); m.set(k, info);
  while (m.size > MAX) m.delete(m.keys().next().value);
  save();
}
/** For tests: forget the in-memory copy so the next call re-reads the file. */
const reset = () => { map = null; clearTimeout(timer); };

module.exports = { get, set, keyOf, reset };
