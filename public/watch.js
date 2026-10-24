'use strict';
/* Playback health watcher, shared by the movie/show player and Live TV.
   The browser keeps picture and sound locked together, so "out of sync" in practice means the picture can't keep up:
   frames get dropped, playback keeps stalling, or the picture shown lags behind the playback clock (the usual result of a
   seek that left the decoder behind). We watch for all three and report them to the player.
   Drift is measured per displayed frame: playback clock minus the frame's own timestamp. In sync that sits within a few
   tens of milliseconds either side of zero; a lagging picture shows up as a steady positive number. */
function PlaybackWatch(video, opts) {
  const o = { warmupMs: 10000, windowMs: 6000, minFrames: 100, dropRatio: 0.08, stallCount: 3, stallSpanMs: 30000, driftMs: 150, driftSamples: 24, settleMs: 1200, ...opts };
  let startedAt = 0, last = null, stalls = [], strikes = 0, lastStrikeAt = 0, timer = null;

  const quality = () => {
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    return { dropped: q ? q.droppedVideoFrames : 0, total: q ? q.totalVideoFrames : 0, at: Date.now() };
  };
  const healthy = () => !video.paused && !video.ended && video.readyState >= 3;

  /** Call whenever a (re)connection starts, so the warm-up and the counters begin again. */
  function reset(fresh) {
    startedAt = Date.now(); stalls = []; last = quality(); if (typeof driftReset === 'function') driftReset(o.settleMs);
    if (fresh) strikes = 0;
  }

  function report(reason) {
    // forget old problems after a long calm stretch, so one bad minute an hour ago doesn't escalate today
    if (Date.now() - lastStrikeAt > 5 * 60 * 1000) strikes = 0;
    strikes++; lastStrikeAt = Date.now();
    reset(false);
    o.onBehind(reason, strikes);
  }

  /** One evaluation; runs on a timer, and is callable directly (the tests do). */
  function check() {
    if (!healthy() || Date.now() - startedAt < o.warmupMs) { last = quality(); return; }
    const now = quality();
    if (now.at - last.at >= o.windowMs) {
      const frames = now.total - last.total, dropped = now.dropped - last.dropped;
      last = now;
      if (frames >= o.minFrames && dropped / frames > o.dropRatio) return report('dropped');
    }
    stalls = stalls.filter((t) => Date.now() - t < o.stallSpanMs);
    if (stalls.length >= o.stallCount) return report('stalls');
  }

  // ---- picture vs clock drift: checked after every seek and every few seconds while playing ----
  const drift = { samples: [], settleUntil: 0, strikes: 0, lastFixAt: 0 };
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  function driftReset(settleMs) { drift.samples = []; drift.settleUntil = Date.now() + settleMs; }
  /** One evaluation of the drift samples; callable directly (the tests do). Returns the median drift in ms, or null if undecided. */
  function driftCheck() {
    if (!o.onDrift || !healthy() || Date.now() < drift.settleUntil || drift.samples.length < o.driftSamples) return null;
    const m = median(drift.samples);
    drift.samples = drift.samples.slice(-Math.floor(o.driftSamples / 2));
    if (m < o.driftMs) { if (Date.now() - drift.lastFixAt > 20000) drift.strikes = 0; return m; }   // in sync (and stayed that way): forget earlier fixes
    drift.strikes++; drift.lastFixAt = Date.now();
    driftReset(o.settleMs + 1500);                                  // give the fix time to take effect before judging again
    o.onDrift(m, drift.strikes);
    return m;
  }
  if (video.requestVideoFrameCallback) {
    const onFrame = (now, md) => {
      if (!video.paused && !video.seeking && md && Number.isFinite(md.mediaTime)) {
        const d = (video.currentTime - md.mediaTime) * 1000;
        if (Math.abs(d) < 5000) { drift.samples.push(d); if (drift.samples.length > 90) drift.samples.shift(); }   // a loop or a jump isn't drift
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
  video.addEventListener('seeking', () => driftReset(o.settleMs));
  video.addEventListener('seeked', () => { driftReset(o.settleMs); setTimeout(driftCheck, o.settleMs + 1200); });   // every skip gets its own check, soon after it settles
  video.addEventListener('playing', () => driftReset(o.settleMs));

  video.addEventListener('waiting', () => { if (video.currentTime > 0 && Date.now() - startedAt >= o.warmupMs) stalls.push(Date.now()); });
  timer = setInterval(() => { check(); driftCheck(); }, 2000);
  reset(true);
  return { reset, check, driftCheck, _drift: drift, stop: () => clearInterval(timer), get strikes() { return strikes; } };
}

/* While a player is buffering, ask the server who is holding the stream up (the provider, or this computer's re-encoding)
   and report it. start() polls every 3 s until stop(); onResult gets { verdict, text, ... }. */
const BufferInfo = (() => {
  let timer = null, delay = null;
  const stop = () => { clearTimeout(delay); clearInterval(timer); delay = timer = null; };
  function start(getKey, onResult) {
    if (timer || delay) return;                       // already watching this stall
    delay = setTimeout(() => {                        // brief hiccups aren't worth a message
      delay = null;
      const poll = async () => {
        const key = getKey();
        if (!key) return;
        try { onResult(await (await fetch('/api/health?key=' + encodeURIComponent(key))).json()); } catch { /* ignore */ }
      };
      poll(); timer = setInterval(poll, 3000);
    }, 3000);
  }
  return { start, stop };
})();
if (typeof module !== 'undefined') module.exports = { PlaybackWatch, BufferInfo };
