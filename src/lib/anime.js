'use strict';
// Anime releases say what they are in their names: "[SubsPlease] Show - 05 (1080p)" is Japanese audio with subtitles, "Show (English Dub)"
// is dubbed, "Show [Dual Audio]" carries both audio tracks (so it can play either way). These helpers read that and filter by it.
const DUAL = /\bdual[ ._-]?audio\b|\bdual\b|\bmulti[ ._-]?audio\b|\bmulti[ ._-]?dub\b/i;
const DUB = /\b(dubbed|dub|dubs|english[ ._-]?dub|eng[ ._-]?dub)\b/i;
const JAPANESE_AUDIO = /\b(jpn|jap|japanese)[ ._-]?(audio|dub)?\b|\bsubbed\b|\bsubs?\b/i;
const SUB = /\b(subs?|subbed|multi[ ._-]?subs?|eng[ ._-]?subs?|softsubs?|hardsubs?)\b/i;
const RAW = /\braws?\b/i;

const textOf = (s) => `${s.name || ''} ${s.filename || ''} ${s.languageLine || ''}`;

/** What a release offers: { dual, canDub, canSub, kind: 'dual'|'dub'|'sub' }. */
function classify(s) {
  const t = textOf(s);
  const dual = DUAL.test(t);
  const dubWord = DUB.test(t);
  const subWord = SUB.test(t);
  const dubOnly = dubWord && !dual && !/\b(jpn|japanese)\b/i.test(t) && !(subWord && /\bsubbed\b/i.test(t));
  const canDub = dual || dubWord;
  const canSub = !dubOnly && !(RAW.test(t) && !subWord);
  return { dual, canDub, canSub, kind: dual ? 'dual' : dubOnly ? 'dub' : 'sub' };
}

/** Releases that can be played as `kind` ('sub' = Japanese audio with subtitles, 'dub' = dubbed audio). */
function forKind(streams, kind) {
  return streams.filter((s) => { const c = classify(s); return kind === 'dub' ? c.canDub : c.canSub; });
}

/** { sub: boolean, dub: boolean } for a whole release list. */
function availability(streams) {
  let sub = false, dub = false;
  for (const s of streams) { const c = classify(s); sub = sub || c.canSub; dub = dub || c.canDub; if (sub && dub) break; }
  return { sub, dub };
}

const isKitsuId = (id) => /^kitsu:\d+(:\d+)?$/.test(id || '');

module.exports = { classify, forKind, availability, isKitsuId };
