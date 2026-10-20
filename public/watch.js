'use strict';
/* Playback health watcher, shared by the movie/show player and Live TV.
   The browser keeps picture and sound locked together, so "out of sync" in practice means the picture can't keep up:
   frames get dropped or playback keeps stalling. We watch for exactly that and report it to the player. */
function PlaybackWatch(video, opts) {
  const o = { warmupMs: 10000, windowMs: 6000, minFrames: 100, dropRatio: 0.08, stallCount: 3, stallSpanMs: 30000, ...opts };
  let startedAt = 0, last = null, stalls = [], strikes = 0, lastStrikeAt = 0, timer = null;

  const quality = () => {
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    return { dropped: q ? q.droppedVideoFrames : 0, total: q ? q.totalVideoFrames : 0, at: Date.now() };
  };
  const healthy = () => !video.paused && !video.ended && video.readyState >= 3;

  /** Call whenever a (re)connection starts, so the warm-up and the counters begin again. */
  function reset(fresh) {
    startedAt = Date.now(); stalls = []; last = quality();
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

  video.addEventListener('waiting', () => { if (video.currentTime > 0 && Date.now() - startedAt >= o.warmupMs) stalls.push(Date.now()); });
  timer = setInterval(check, 2000);
  reset(true);
  return { reset, check, stop: () => clearInterval(timer), get strikes() { return strikes; } };
}
