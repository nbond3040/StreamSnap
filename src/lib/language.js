'use strict';
// Language table: ISO 639-1 code -> display name, ISO 639-2 (OpenSubtitles),
// flag emoji(s) Torrentio prints, and release-name tokens as a fallback.
const LANGS = {
  en: { name: 'English', iso3: 'eng', flags: ['🇬🇧', '🇺🇸'], tokens: ['english'] },
  es: { name: 'Spanish', iso3: 'spa', flags: ['🇪🇸', '🇲🇽'], tokens: ['spanish', 'castellano', 'latino'] },
  fr: { name: 'French', iso3: 'fre', flags: ['🇫🇷'], tokens: ['french', 'truefrench', 'vff', 'vfq'] },
  de: { name: 'German', iso3: 'ger', flags: ['🇩🇪'], tokens: ['german', 'deutsch'] },
  it: { name: 'Italian', iso3: 'ita', flags: ['🇮🇹'], tokens: ['italian', 'ita'] },
  pt: { name: 'Portuguese', iso3: 'por', flags: ['🇵🇹', '🇧🇷'], tokens: ['portuguese', 'dublado'] },
  ru: { name: 'Russian', iso3: 'rus', flags: ['🇷🇺'], tokens: ['russian', 'rus'] },
  ja: { name: 'Japanese', iso3: 'jpn', flags: ['🇯🇵'], tokens: ['japanese'] },
  ko: { name: 'Korean', iso3: 'kor', flags: ['🇰🇷'], tokens: ['korean'] },
  zh: { name: 'Chinese', iso3: 'chi', flags: ['🇨🇳', '🇹🇼', '🇭🇰'], tokens: ['chinese', 'mandarin', 'cantonese'] },
  nl: { name: 'Dutch', iso3: 'dut', flags: ['🇳🇱'], tokens: ['dutch'] },
  pl: { name: 'Polish', iso3: 'pol', flags: ['🇵🇱'], tokens: ['polish', 'lektor'] },
  cs: { name: 'Czech', iso3: 'cze', flags: ['🇨🇿'], tokens: ['czech'] },
  hu: { name: 'Hungarian', iso3: 'hun', flags: ['🇭🇺'], tokens: ['hungarian'] },
  ro: { name: 'Romanian', iso3: 'rum', flags: ['🇷🇴'], tokens: ['romanian'] },
  uk: { name: 'Ukrainian', iso3: 'ukr', flags: ['🇺🇦'], tokens: ['ukrainian'] },
  el: { name: 'Greek', iso3: 'ell', flags: ['🇬🇷'], tokens: ['greek'] },
  da: { name: 'Danish', iso3: 'dan', flags: ['🇩🇰'], tokens: ['danish'] },
  fi: { name: 'Finnish', iso3: 'fin', flags: ['🇫🇮'], tokens: ['finnish'] },
  sv: { name: 'Swedish', iso3: 'swe', flags: ['🇸🇪'], tokens: ['swedish'] },
  no: { name: 'Norwegian', iso3: 'nor', flags: ['🇳🇴'], tokens: ['norwegian'] },
  tr: { name: 'Turkish', iso3: 'tur', flags: ['🇹🇷'], tokens: ['turkish'] },
  ar: { name: 'Arabic', iso3: 'ara', flags: ['🇸🇦'], tokens: ['arabic'] },
  he: { name: 'Hebrew', iso3: 'heb', flags: ['🇮🇱'], tokens: ['hebrew'] },
  hi: { name: 'Hindi', iso3: 'hin', flags: ['🇮🇳'], tokens: ['hindi'] },
  th: { name: 'Thai', iso3: 'tha', flags: ['🇹🇭'], tokens: ['thai'] },
  vi: { name: 'Vietnamese', iso3: 'vie', flags: ['🇻🇳'], tokens: ['vietnamese'] },
  id: { name: 'Indonesian', iso3: 'ind', flags: ['🇮🇩'], tokens: ['indonesian'] },
};

const FLAG_TO_CODE = {};
for (const [code, l] of Object.entries(LANGS)) for (const f of l.flags) FLAG_TO_CODE[f] = code;

const FLAG_RE = /\p{Regional_Indicator}{2}/gu;
const MULTI_RE = /multi[\s-]*audio|dual[\s-]*audio|🌎|\bmulti\b(?![\s-]*sub)/i;

/**
 * Work out which audio languages a parsed Torrentio stream claims.
 * Torrentio prints language flags on the last line of the stream title; releases with
 * no flag are English/original-language releases.
 */
function detectLanguages(stream) {
  const codes = new Set();
  for (const flag of stream.languageLine.match(FLAG_RE) || []) {
    if (FLAG_TO_CODE[flag]) codes.add(FLAG_TO_CODE[flag]);
  }
  const multi = MULTI_RE.test(stream.languageLine);
  if (!codes.size && !multi) {
    // No tag from Torrentio: fall back to words in the release name.
    const name = stream.filename.toLowerCase();
    for (const [code, l] of Object.entries(LANGS)) {
      if (code === 'en') continue;
      if (l.tokens.some((t) => new RegExp(`(^|[^a-z])${t}([^a-z]|$)`).test(name))) codes.add(code);
    }
  }
  return { codes, multi, tagged: codes.size > 0 || multi };
}

/** Does this stream have audio in `native`? Returns {ok, reason}. */
function matchesNative(stream, cfg) {
  const native = cfg.nativeLanguage;
  const d = detectLanguages(stream);
  if (d.codes.has(native)) return { ok: true, reason: 'tagged' };
  if (d.multi && cfg.includeMultiAudio) return { ok: true, reason: 'multi' };
  if (!d.tagged && native === 'en' && cfg.assumeUntaggedNative) return { ok: true, reason: 'untagged' };
  return { ok: false, reason: 'language' };
}

module.exports = { LANGS, detectLanguages, matchesNative };
