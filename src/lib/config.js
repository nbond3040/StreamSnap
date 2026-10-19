'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = process.env.STREAMSNAP_HOME ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'streamsnap');
const configFile = path.join(dir, 'config.json');
const dataFile = path.join(dir, 'data.json');

function systemLanguage() {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || 'en';
  const code = raw.split(/[_.:@-]/)[0].toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : 'en';
}

const DEFAULTS = {
  realDebridKey: '',
  xtreamUrl: '',               // Live TV (Xtream Codes) server, e.g. http://host:8080
  xtreamUser: '',
  xtreamPass: '',
  tmdbKey: '',                 // optional: enables "More in this collection" (sequels) on movie pages
  torrentioUrl: '',            // optional: a full Torrentio manifest/config URL
  nativeLanguage: systemLanguage(),
  includeMultiAudio: true,     // accept releases tagged multi/dual audio
  assumeUntaggedNative: true,  // English only: untagged Torrentio releases are English
  verifyAudio: true,           // inspect the real audio tracks with ffprobe/ffmpeg (needs ffmpeg installed)
  allowUncached: false,        // only Real-Debrid-cached streams play instantly
  hdrPolicy: 'allow',          // allow | avoid | only
  player: 'browser',           // browser (in-app player) | mpv | vlc
  preferredResolution: '1080p',// quality the Play button starts with
  resolutions: ['2160p', '1080p', '720p', '480p'],
  subtitles: true,
  themeColor: 'violet',        // see COLORS in public/app.js
  themeMode: 'dark',           // dark | light | system
  pureBlack: false,            // true-black backgrounds in dark mode
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadConfig() {
  return { ...DEFAULTS, ...readJson(configFile, {}) };
}

function saveConfig(patch) {
  const next = { ...loadConfig() };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (typeof v !== typeof DEFAULTS[key]) continue;
    if (Array.isArray(DEFAULTS[key]) && !Array.isArray(v)) continue;
    next[key] = typeof v === 'string' ? v.trim() : v;
  }
  writeJson(configFile, next);
  return next;
}

const DATA_DEFAULTS = { library: [], progress: {}, watched: {}, pinned: [], liveFavorites: [] };
function loadData() { return { ...DATA_DEFAULTS, ...readJson(dataFile, {}) }; }
function saveData(data) { writeJson(dataFile, data); }

module.exports = { DEFAULTS, loadConfig, saveConfig, loadData, saveData, dir };
