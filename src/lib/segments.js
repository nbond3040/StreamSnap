'use strict';
// Turn a file's chapter markers into skippable segments (intro / recap / credits).
const PREVIEW = /\b(preview|next time|trailer|coming up)\b/i;
const RECAP = /\b(recap|previously|last time|story so far)\b/i;
const INTRO = /^(op|opening|intro|introduction|title( sequence| card)?|main title|theme( song)?)\b|\b(intro|opening( credits| theme| sequence)?|title sequence)\b/i;
const CREDITS = /^(ed|ending|outro|credits?|end credits?|closing credits?)\b|\b(end credits?|closing credits?|outro|ending)\b|^credits?$/i;

/**
 * @param chapters [{ start, end, title }] in seconds
 * @returns { intro?, recap?, credits? } each { start, end }
 */
function fromChapters(chapters, duration) {
  const out = {};
  for (const c of chapters || []) {
    const title = String(c.title || '').trim();
    if (!title || !(c.end > c.start)) continue;
    const len = c.end - c.start, seg = { start: c.start, end: c.end };
    if (PREVIEW.test(title)) continue;
    if (RECAP.test(title)) { if (len >= 5 && len <= 240 && !out.recap) out.recap = seg; }
    else if (INTRO.test(title)) { if (len >= 8 && len <= 300 && (!duration || c.start < duration * 0.4) && !out.intro) out.intro = seg; }
    else if (CREDITS.test(title)) { if (len >= 5 && (!duration || c.start > duration * 0.55) && !out.credits) out.credits = seg; }
  }
  return out;
}

/** Blend a new observation into a remembered value: a running average over (at most) the last 5 observations. */
function blend(old, value, cap = 5) {
  if (!old) return { value, n: 1 };
  const n = Math.min(old.n, cap - 1);
  return { value: (old.value * n + value) / (n + 1), n: n + 1 };
}

module.exports = { fromChapters, blend };
