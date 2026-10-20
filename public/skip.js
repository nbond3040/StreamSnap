'use strict';
/* Pure helpers for intro/credits skipping (no DOM), shared with the tests. */
const Skip = (() => {
  /** A 32x18 RGBA frame that is mostly black with at most sparse bright text: the look of end credits. */
  function frameIsCreditsLike(rgba) {
    const n = rgba.length / 4;
    let sum = 0, bright = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      sum += l; if (l > 120) bright++;
    }
    return sum / n < 24 && bright / n < 0.08;
  }

  /**
   * The skip button that applies at time t, or null.
   * chapters/learned come from the file and from the user's earlier skips; with neither, a series offers a manual "skip ahead".
   */
  function skipAt(t, { segments = {}, learnedIntro = null, isSeries = false }) {
    for (const [key, label] of [['recap', 'Skip recap'], ['intro', 'Skip intro']]) {
      const g = segments[key];
      if (g && t >= g.start - 1 && t < g.end - 1.5) return { label, to: g.end, kind: 'chapter' };
    }
    if (!segments.intro && learnedIntro && t >= learnedIntro.start - 3 && t < learnedIntro.end - 3) return { label: 'Skip intro', to: learnedIntro.end, kind: 'learned' };
    if (isSeries && !segments.intro && !learnedIntro && t >= 4 && t < 300) return { label: 'Skip ahead 85 s', to: t + 85, kind: 'manual', from: t };
    return null;
  }

  /** When the "next episode" button should appear: credits start if we know it, else shortly before the end. */
  function nextAt({ segments = {}, detectedAt = null, creditsFromEnd = null, duration }) {
    if (!duration) return Infinity;
    if (segments.credits) return segments.credits.start;
    if (detectedAt) return detectedAt;
    if (creditsFromEnd) return Math.max(duration * 0.6, duration - creditsFromEnd);
    return duration - 75;
  }

  return { frameIsCreditsLike, skipAt, nextAt };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Skip;
