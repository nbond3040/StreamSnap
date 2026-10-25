'use strict';
// Which anime titles can be watched dubbed and/or subbed, learned by looking at what releases exist and remembered on disk for a day.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const TTL = 24 * 3600 * 1000, MAX = 3000;
let map = null, timer = null;
const file = () => path.join(config.dir, 'anime-audio.json');

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
      fs.writeFileSync(tmp, JSON.stringify([...load().entries()]), { mode: 0o600 });
      fs.renameSync(tmp, file());
    } catch { /* a read-only home: just don't remember */ }
  }, 2000);
  if (timer.unref) timer.unref();
}

/** { sub, dub } or null when unknown / too old. */
function get(id) {
  const v = load().get(id);
  return v && Date.now() - v.at < TTL ? { sub: v.sub, dub: v.dub } : null;
}
function set(id, a) {
  const m = load();
  m.delete(id); m.set(id, { sub: !!a.sub, dub: !!a.dub, at: Date.now() });
  while (m.size > MAX) m.delete(m.keys().next().value);
  save();
}
const reset = () => { map = null; clearTimeout(timer); };

module.exports = { get, set, reset };
