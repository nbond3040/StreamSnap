'use strict';
// A small remembered-on-disk map with an expiry per entry, for lookups that rarely change (relations between anime, availability...).
const fs = require('fs');
const path = require('path');
const config = require('./config');

function createStore(name, { max = 3000, ttl = 24 * 3600 * 1000 } = {}) {
  let map = null, timer = null;
  const file = () => path.join(config.dir, `${name}.json`);
  const load = () => {
    if (map) return map;
    map = new Map();
    try { for (const [k, v] of JSON.parse(fs.readFileSync(file(), 'utf8'))) map.set(k, v); } catch { /* first run */ }
    return map;
  };
  const save = () => {
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
  };
  return {
    get(k) { const v = load().get(k); return v && Date.now() - v.at < (v.ttl || ttl) ? v.value : undefined; },
    set(k, value, customTtl) { const m = load(); m.delete(k); m.set(k, { value, at: Date.now(), ttl: customTtl }); while (m.size > max) m.delete(m.keys().next().value); save(); },
    reset() { map = null; clearTimeout(timer); },
  };
}
module.exports = { createStore };
