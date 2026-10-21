'use strict';
const { matchesNative } = require('./language');

const ORDER = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];
const MAX_GB = { '2160p': 60, '1440p': 30, '1080p': 25, '720p': 10, '576p': 5, '480p': 4, '360p': 2 };
const SOURCE_SCORE = { bluray: 12, 'web-dl': 12, remux: 9, webrip: 9, hdtv: 6, dvd: 3, '': 4 };
const CODEC_SCORE = { h264: 6, hevc: 4, av1: 2, '': 0 };
const LANG_SCORE = { tagged: 15, multi: 5, untagged: 0 };

// What it costs to actually play this release here. Browsers decode h264/aac natively; anything else needs ffmpeg to
// transcode, which is slower to start and can be CPU-bound. Larger frames cost more to transcode.
const PIXELS = { '2160p': 4, '1440p': 2.2, '1080p': 1, '720p': 0.45, '576p': 0.3, '480p': 0.25, '360p': 0.15 };
const NATIVE_AUDIO = new Set(['', 'aac', 'opus']);
function playability(s, opts) {
  let pen = 0; const notes = [];
  const px = PIXELS[s.resolution] || 1;
  if (s.codec === 'hevc' || s.codec === 'av1') { pen += 6 * px + (s.bit10 ? 3 * px : 0); notes.push('transcode'); }
  else if (s.bit10) { pen += 4 * px; notes.push('transcode'); }
  if (!NATIVE_AUDIO.has(s.audio)) {
    if (opts.ffmpeg === false) { pen += 40; notes.push('no-audio'); } else { pen += 2; notes.push('audio-convert'); }
  }
  if (opts.throughputKbps && opts.runtimeMin && s.size) {
    const need = (s.size * 8) / 1000 / (opts.runtimeMin * 60); // average kbit/s the file needs
    if (need > opts.throughputKbps * 0.8) { pen += 20 + Math.min(30, (need / opts.throughputKbps) * 10); notes.push('too-fast-for-link'); }
  }
  return { pen, notes };
}

function score(s, cfg, reason, opts = {}) {
  let v = Math.log2(1 + s.seeders) * 4 + (SOURCE_SCORE[s.source] ?? 4) + (CODEC_SCORE[s.codec] ?? 0);
  v += LANG_SCORE[reason] ?? 0;
  if (s.cached) v += 100; // cached beats everything; only matters when uncached are allowed
  if (s.hdr && cfg.hdrPolicy === 'avoid') v -= 30;
  const gb = s.size / 1e9;
  const cap = MAX_GB[s.resolution] || 25;
  if (gb > cap) v -= (gb - cap) * 1.5; // huge files buffer badly
  const p = playability(s, opts);
  s.notes = p.notes;
  return v - p.pen;
}

/**
 * Filter streams to the user's language/quality rules and pick the best one per resolution.
 * Returns { picks: [{resolution, stream, alternatives}], hidden: {language, uncached, quality, hdr} }.
 */
function selectStreams(streams, cfg, opts = {}) {
  const hidden = { language: 0, uncached: 0, quality: 0, hdr: 0 };
  const byRes = new Map();
  for (const s of streams) {
    if (s.cam) { hidden.quality++; continue; }
    if (!s.cached && !cfg.allowUncached) { hidden.uncached++; continue; }
    if (cfg.hdrPolicy === 'only' && !s.hdr) { hidden.hdr++; continue; }
    const lang = opts.ignoreLanguage ? { ok: true, reason: 'any' } : matchesNative(s, cfg); // 'any': no native-language stream existed
    if (!lang.ok) { hidden.language++; continue; }
    if (!cfg.resolutions.includes(s.resolution)) { hidden.quality++; continue; }
    const entry = { ...s, languageMatch: lang.reason, score: 0 };
    entry.score = score(entry, cfg, lang.reason, opts);
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
