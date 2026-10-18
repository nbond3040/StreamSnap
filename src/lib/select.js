'use strict';
const { matchesNative } = require('./language');

const ORDER = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];
const MAX_GB = { '2160p': 60, '1440p': 30, '1080p': 25, '720p': 10, '576p': 5, '480p': 4, '360p': 2 };
const SOURCE_SCORE = { bluray: 12, 'web-dl': 12, remux: 9, webrip: 9, hdtv: 6, dvd: 3, '': 4 };
const CODEC_SCORE = { h264: 6, hevc: 4, av1: 2, '': 0 };
const LANG_SCORE = { tagged: 15, multi: 5, untagged: 0 };

function score(s, cfg, reason) {
  let v = Math.log2(1 + s.seeders) * 4 + (SOURCE_SCORE[s.source] ?? 4) + (CODEC_SCORE[s.codec] ?? 0);
  v += LANG_SCORE[reason] ?? 0;
  if (s.cached) v += 100; // cached beats everything; only matters when uncached are allowed
  if (s.hdr && cfg.hdrPolicy === 'avoid') v -= 30;
  const gb = s.size / 1e9;
  const cap = MAX_GB[s.resolution] || 25;
  if (gb > cap) v -= (gb - cap) * 1.5; // huge files buffer badly
  return v;
}

/**
 * Filter streams to the user's language/quality rules and pick the best one per resolution.
 * Returns { picks: [{resolution, stream, alternatives}], hidden: {language, uncached, quality, hdr} }.
 */
function selectStreams(streams, cfg) {
  const hidden = { language: 0, uncached: 0, quality: 0, hdr: 0 };
  const byRes = new Map();
  for (const s of streams) {
    if (s.cam) { hidden.quality++; continue; }
    if (!s.cached && !cfg.allowUncached) { hidden.uncached++; continue; }
    if (cfg.hdrPolicy === 'only' && !s.hdr) { hidden.hdr++; continue; }
    const lang = matchesNative(s, cfg);
    if (!lang.ok) { hidden.language++; continue; }
    if (!cfg.resolutions.includes(s.resolution)) { hidden.quality++; continue; }
    const entry = { ...s, languageMatch: lang.reason, score: score(s, cfg, lang.reason) };
    if (!byRes.has(s.resolution)) byRes.set(s.resolution, []);
    byRes.get(s.resolution).push(entry);
  }
  const picks = [...byRes.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([resolution, list]) => {
      list.sort((a, b) => b.score - a.score);
      return { resolution, stream: list[0], alternatives: list.slice(1, 6) };
    });
  return { picks, hidden };
}

module.exports = { selectStreams };
