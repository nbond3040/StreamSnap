'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LANGS } = require('./language');

const BASE = process.env.STREAMSNAP_SUBS_URL || 'https://opensubtitles-v3.strem.io';
const refs = new Map(); // ref -> upstream url (the browser never supplies a URL)

async function listSubtitles(type, id, lang) {
  const iso3 = (LANGS[lang] || LANGS.en).iso3;
  const res = await fetch(`${BASE}/subtitles/${type}/${encodeURIComponent(id).replace(/%3A/g, ':')}.json`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const body = await res.json();
  return (body.subtitles || [])
    .filter((s) => s.url && (s.lang === iso3 || s.lang === lang))
    .slice(0, 5)
    .map((s, i) => {
      const ref = crypto.createHash('sha1').update(s.url).digest('hex').slice(0, 20);
      refs.set(ref, s.url);
      return { ref, url: s.url, label: `${LANGS[lang]?.name || lang} ${i + 1}`, lang };
    });
}

function srtToVtt(srt) {
  const body = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

async function fetchText(ref) {
  const url = refs.get(ref);
  if (!url) throw new Error('unknown subtitle');
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text = buf.toString('utf8');
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  return text;
}

const fetchVtt = async (ref) => srtToVtt(await fetchText(ref));

/** External players need a local file: VLC treats --sub-file values as paths, not URLs. */
async function fetchToFile(ref) {
  const dir = path.join(os.tmpdir(), 'streamsnap-subs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ref}.srt`);
  fs.writeFileSync(file, await fetchText(ref));
  return file;
}

module.exports = { listSubtitles, fetchVtt, fetchToFile, srtToVtt };
