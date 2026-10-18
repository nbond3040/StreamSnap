'use strict';
const crypto = require('crypto');

const DEFAULT_BASE = process.env.STREAMSNAP_TORRENTIO_URL || 'https://torrentio.strem.fun';
const RES_RE = /\b(4k|2160p|1440p|1080p|720p|576p|480p|360p)\b/i;

/** Build `<base>/<config>` from settings. Throws a user-facing Error when unconfigured. */
function buildBase(cfg) {
  const key = encodeURIComponent(cfg.realDebridKey || '');
  if (cfg.torrentioUrl) {
    let u = cfg.torrentioUrl.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) throw new Error('Torrentio URL must start with http(s)://');
    if (key && !/realdebrid=/i.test(u)) {
      // A bare host has no config path yet; otherwise append to the existing options.
      u += /^https?:\/\/[^/]+$/.test(u) ? `/realdebrid=${key}` : `|realdebrid=${key}`;
    }
    return u;
  }
  if (!key) throw new Error('Add your Real-Debrid API key in Settings first.');
  const opts = ['qualityfilter=scr,cam'];
  if (!cfg.allowUncached) opts.push('debridoptions=nodownloadlinks');
  opts.push(`realdebrid=${key}`);
  return `${DEFAULT_BASE}/${opts.join('|')}`;
}

function parseStream(s) {
  if (!s || !s.url) return null; // magnet-only entries can't play without a debrid link
  const name = String(s.name || '');
  const lines = String(s.title || '').split('\n');
  let info = lines.findIndex((l) => /👤|💾|⚙️/.test(l));
  if (info < 0) info = lines.length;
  const infoLine = lines[info] || '';
  const hints = s.behaviorHints || {};
  const filename = hints.filename || lines.slice(0, info).join(' ').trim();
  const text = `${name} ${filename}`;
  const m = RES_RE.exec(name) || RES_RE.exec(filename);
  let resolution = m ? m[1].toLowerCase() : 'unknown';
  if (resolution === '4k') resolution = '2160p';
  const sizeMatch = /💾\s*([\d.,]+)\s*([KMGT]B)/i.exec(infoLine);
  const units = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  const size = hints.videoSize ||
    (sizeMatch ? parseFloat(sizeMatch[1].replace(',', '.')) * units[sizeMatch[2].toUpperCase()] : 0);
  const seeders = parseInt((/👤\s*(\d+)/.exec(infoLine) || [])[1] || '0', 10);
  const source = (/remux/i.test(text) && 'remux') || (/blu-?ray|bdrip|brrip/i.test(text) && 'bluray') ||
    (/web[-. ]?dl/i.test(text) && 'web-dl') || (/web[-. ]?rip|\bweb\b/i.test(text) && 'webrip') ||
    (/hdtv|pdtv/i.test(text) && 'hdtv') || (/dvd/i.test(text) && 'dvd') || '';
  const codec = (/av1/i.test(text) && 'av1') || (/x265|h\.?265|hevc/i.test(text) && 'hevc') ||
    (/x264|h\.?264|avc/i.test(text) && 'h264') || '';
  return {
    ref: crypto.createHash('sha1').update(s.url).digest('hex').slice(0, 20),
    url: s.url,
    name: name.replace(/\n/g, ' '),
    filename,
    resolution,
    size,
    seeders,
    provider: (/⚙️\s*(.+)/.exec(infoLine) || [])[1] || '',
    languageLine: lines.slice(info + 1).join(' '),
    cached: /\[RD\+\]/.test(name),
    hdr: /\b(hdr10\+?|hdr|dv|dolby[ .-]?vision)\b/i.test(text),
    cam: /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|scr|screener|hdtc)\b/i.test(text),
    source,
    codec,
  };
}

async function fetchStreams(cfg, type, id, signal) {
  const base = buildBase(cfg);
  const res = await fetch(`${base}/stream/${type}/${encodeURIComponent(id).replace(/%3A/g, ':')}.json`, {
    headers: { 'user-agent': 'StreamSnap/0.1' },
    signal: signal || AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Torrentio returned HTTP ${res.status}`);
  const body = await res.json();
  return (body.streams || []).map(parseStream).filter(Boolean);
}

module.exports = { buildBase, parseStream, fetchStreams };
