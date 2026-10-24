'use strict';
/* In-app video player: quality switching (swaps the underlying stream), captions (off by default),
   next-episode button and episode sidebar. Uses h()/api()/toast() from app.js at call time. */
const Player = (() => {
  const $ = (s) => document.querySelector(s);
  const root = $('#player'), video = $('#video'), seek = $('#pSeek');
  let ctx, pick, stream, mode, offset = 0, duration = 0, info = {}, fellBack = false;
  let maxH = 1080;   // ceiling for converted (re-encoded) playback; steps down if this computer can't keep up
  let segs = {}, learned = { intro: null, creditsFromEnd: null }, creditsDetectedAt = null, darkRun = 0;
  let audioDelay = Number(localStorage.getItem('ss.audioDelay') || 0), lastSave = 0, nextPromise = null, subTracks = [], activeSub = -1, idleTimer, token = 0;

  const fmt = (t) => {
    t = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + `:${String(s).padStart(2, '0')}`;
  };
  const cur = () => offset + (video.currentTime || 0);
  const total = () => duration || video.duration || 0;
  const resLabel = (r) => (r === '2160p' ? '4K' : r);

  // ---------- opening / loading ----------
  async function open(c, resolution, startAt) {
    cancelAutoplay(); ctx = c; nextPromise = null; activeSub = -1; $('#pNext').hidden = true; $('#pWarn').hidden = true; $('#pSkip').hidden = true; watch.reset(true);
    maxH = 1080; segs = {}; learned = { intro: null, creditsFromEnd: null }; creditsDetectedAt = null; darkRun = 0;
    if (ctx.type === 'series') api('/skips?id=' + ctx.meta.id).then((r) => { learned = { intro: r.intro, creditsFromEnd: r.creditsFromEnd }; }).catch(() => {});
    pick = ctx.picks.find((p) => p.resolution === resolution) || ctx.picks[0];
    $('#pTitle').textContent = ctx.title;
    $('#pSub').textContent = ctx.subtitleLine || '';
    root.hidden = false; document.body.style.overflow = 'hidden';
    buildSubs(); buildMenus();
    $('#pEps').hidden = !ctx.series;
    $('#pExt').hidden = !(window.APPINFO && (APPINFO.players.mpv || APPINFO.players.vlc));
    if (!ctx.series) closeSide(); else if (!$('#pSide').hidden) renderSide();
    if (startAt == null) startAt = (await api('/resume?key=' + encodeURIComponent(ctx.key)).catch(() => ({ pos: 0 }))).pos;
    wake();
    await load(pick.stream, startAt, true);
  }

  async function load(s, at, autoplay) {
    const my = ++token;
    watch.reset(false);
    stream = s; fellBack = false;
    status('spin', 'Loading ' + resLabel(s.resolution) + '…');
    info = await api('/probe?ref=' + s.ref).catch(() => ({ mode: 'direct' }));
    if (my !== token) return;
    duration = info.duration || 0;
    segs = info.segments || {};
    mode = info.mode === 'compat' || (audioDelay !== 0 && info.ffmpeg) ? 'compat' : 'direct';
    setSource(at, autoplay);
    updateQuality();
  }

  let srcSeq = 0, pendingSeek = 0;
  /**
   * Point the video at the stream, starting at `at`. A converted stream is not seekable in the browser (it has no length or index),
   * so every jump re-opens it. One that copies the video can only begin on a keyframe, up to several seconds before `at`: ask where it
   * will really begin, start it there (picture and sound together, clock correct), then play through the lead-in at high speed
   * (muted by the browser at that speed) so it arrives at `at` within a moment.
   */
  async function setSource(at, play) {
    at = Math.max(0, at || 0);
    const seq = ++srcSeq;
    pendingSeek = 0; video.defaultPlaybackRate = 1;
    status('spin', mode === 'compat' ? 'Preparing stream (compatibility mode)…' : 'Buffering…');
    if (mode === 'compat') {
      let start = at;
      if (info.copyVideo && at > 1) {
        const k = await api(`/keyframe?ref=${stream.ref}&t=${at}`).catch(() => null);
        if (seq !== srcSeq) return;
        if (k && Number.isFinite(k.start)) start = k.start;
      }
      offset = start;
      if (play && at - start > 0.7 && at - start < 30) { pendingSeek = at - start; video.defaultPlaybackRate = 8; watchLeadIn(); }
      video.src = `/api/compat/${stream.ref}?t=${start}&a=${audioDelay / 1000}` + (maxH < 1080 ? `&q=${maxH}` : '');
    } else {
      offset = 0; video.src = `/api/stream/${stream.ref}`;
      video.addEventListener('loadedmetadata', () => { if (at) video.currentTime = at; }, { once: true });
    }
    shiftCues();
    if (play) video.play().catch(() => {});
  }
  function finishLeadIn() {
    if (!pendingSeek) return;
    if (video.currentTime >= pendingSeek - 0.05 || video.ended) { pendingSeek = 0; video.defaultPlaybackRate = 1; video.playbackRate = 1; }
  }
  video.addEventListener('timeupdate', finishLeadIn);
  function watchLeadIn() {   // checked on every displayed frame, so the fast part stops within a fraction of a second of the target
    if (!video.requestVideoFrameCallback) return;
    const tick = () => { finishLeadIn(); if (pendingSeek) video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  }
  video.addEventListener('pause', () => { if (pendingSeek && video.readyState >= 1) { pendingSeek = 0; video.defaultPlaybackRate = 1; video.playbackRate = 1; } });

  function status(kind, msg, extra) {
    const el = $('#pStatus');
    if (!kind) { el.hidden = true; return; }
    el.hidden = false; el.className = kind === 'err' ? 'err2' : '';
    el.replaceChildren(h('div', {}, kind === 'spin' && h('div', { class: 'spinner' }), h('div', {}, msg), extra || null));
  }

  /** While buffering: say whether the provider or this computer is the bottleneck (and ease the quality down if it's us). */
  let localStrikes = 0;
  function bufferNote(text) {
    const el = $('#pStatus');
    if (el.hidden || el.classList.contains('err2')) return;
    let n = el.querySelector('.p-note');
    if (!n) { n = h('div', { class: 'p-note' }); el.firstElementChild.append(n); }
    n.textContent = text;
  }
  const watchBuffering = () => BufferInfo.start(() => stream && `vod:${stream.ref}`, (r) => {
    if (r.verdict === 'provider') bufferNote(r.text);
    else if (r.verdict === 'local' && mode === 'compat' && ++localStrikes >= 2 && maxH > 480) {
      maxH = maxH > 720 ? 720 : 480; localStrikes = 0;
      toast(`Lowered the converted quality to ${maxH}p because this computer couldn’t keep up.`);
      setSource(cur(), true);
    } else if (r.verdict === 'local') bufferNote(r.text);
  });
  video.addEventListener('playing', () => { BufferInfo.stop(); localStrikes = 0; status(null); });
  video.addEventListener('waiting', () => { status('spin', 'Buffering…'); watchBuffering(); });
  video.addEventListener('canplay', () => status(null));
  let retriedFresh = null;   // stream ref we've already retried with a freshly resolved link
  video.addEventListener('error', async () => {
    if (!stream || !video.getAttribute('src')) return;
    const my = token, bad = stream;
    if (mode === 'direct' && !fellBack && info.ffmpeg !== false && (window.APPINFO || {}).players?.ffmpeg) {
      fellBack = true; mode = 'compat'; setSource(cur(), true); return;
    }
    // Find out why before giving up: a stale link is fixed by asking the provider again, and anything else gets a real reason.
    const check = await api('/stream-check?ref=' + bad.ref).catch(() => null);
    if (my !== token || stream !== bad) return;
    if (check && check.ok && retriedFresh !== bad.ref) { retriedFresh = bad.ref; fellBack = false; setSource(cur(), true); return; }
    const actions = [h('button', { class: 'btn', onclick: () => { retriedFresh = null; load(bad, cur(), true); } }, 'Try again')];
    const lower = ctx.picks[ctx.picks.findIndex((x) => x === pick) + 1];
    if (lower) actions.push(h('button', { class: 'btn ghost', onclick: () => switchQuality(lower.resolution) }, `Try ${resLabel(lower.resolution)}`));
    if (APPINFO.players.mpv || APPINFO.players.vlc) actions.push(h('button', { class: 'btn ghost', onclick: openExternal }, 'Open in mpv / VLC'));
    const why = check && !check.ok ? check.reason : (APPINFO.players.ffmpeg ? 'The file loads but its format can’t be played. Try another quality.' : 'Install ffmpeg for automatic format conversion, or try another quality.');
    status('err', 'This stream can’t be played.', h('div', {}, h('div', { class: 'subtle', style: 'margin:8px 0 14px;max-width:46ch' }, why), h('div', { class: 'row', style: 'justify-content:center' }, actions)));
  });
  video.addEventListener('ended', () => { markProgress(true); autoplayCountdown(); });
  // When an episode finishes and Autoplay next is on, count down on the Next button, then start it. Any other action cancels.
  let autoTimer = null;
  function cancelAutoplay() { clearInterval(autoTimer); autoTimer = null; $('#pNext').classList.remove('counting'); }
  async function autoplayCountdown() {
    if (!ctx || !ctx.next) return;
    const cfg = await api('/config').catch(() => ({}));
    if (!cfg.autoplayNext) return;
    const btn = $('#pNext'); btn.querySelector('small').textContent = ctx.next.label; btn.hidden = false;
    nextPromise = nextPromise || ctx.next.load().catch(() => null);
    let n = 8; btn.dataset.count = n; btn.classList.add('counting');
    autoTimer = setInterval(() => { btn.dataset.count = --n; if (n <= 0) { cancelAutoplay(); btn.click(); } }, 1000);
  }
  video.addEventListener('play', cancelAutoplay);
  video.addEventListener('seeking', cancelAutoplay);
  addEventListener('keydown', (e) => { if (autoTimer && e.key === 'Escape') { e.stopImmediatePropagation(); cancelAutoplay(); } }, true);

  // Chromium can't decode AC3/E-AC3/DTS and plays those files silently without raising an error.
  // If nothing has been decoded a few seconds into playback, switch to the converting stream.
  setInterval(() => {
    if (root.hidden || video.paused || video.muted || video.currentTime < 3 || mode === 'compat' || fellBack) return;
    if (video.webkitAudioDecodedByteCount === 0) {
      if ((window.APPINFO || {}).players?.ffmpeg) { fellBack = true; mode = 'compat'; toast('Converting audio for playback…'); setSource(cur(), true); }
      else if (!Player.warned) { Player.warned = true; status('err', 'This stream’s audio format isn’t supported by the app window.', h('div', { class: 'subtle', style: 'margin-top:8px' }, 'Install ffmpeg (sudo apt install ffmpeg) to fix this automatically, or pick another quality.')); }
    }
  }, 1500);

  // ---------- playback health: restart once on its own, then suggest a lower quality ----------
  const warn = $('#pWarn');
  function showWarn(msg, ...actions) {
    warn.replaceChildren(h('span', {}, msg), ...actions, h('button', { class: 'btn ghost sm', onclick: () => (warn.hidden = true) }, 'Dismiss'));
    warn.hidden = false;
  }
  const watch = PlaybackWatch(video, { onBehind: (reason, n) => {
    if (root.hidden || !ctx || !stream) return;
    if (n === 1) { toast('Playback was falling behind, so the stream was restarted.'); const t = cur(), paused = video.paused; load(stream, t, !paused); return; }
    const lower = ctx.picks[ctx.picks.findIndex((x) => x === pick) + 1];
    showWarn(`Playback keeps ${reason === 'dropped' ? 'dropping frames' : 'stalling'} at ${resLabel(pick.resolution)}; your computer may be struggling with it.`,
      lower && h('button', { class: 'btn sm', onclick: () => { warn.hidden = true; switchQuality(lower.resolution); } }, `Switch to ${resLabel(lower.resolution)}`));
  }, onDrift: (ms, n) => {
    // the picture is lagging the clock (typically right after a skip): flush the decoder, then restart the stream here, then suggest a lighter quality
    if (root.hidden || !ctx || !stream || video.paused) return;
    if (n === 1) { const t = video.currentTime; video.currentTime = Math.max(0, t - 0.05); return; }
    if (n === 2) { toast('Re-syncing picture and sound…'); load(stream, cur(), true); return; }
    const lower = ctx.picks[ctx.picks.findIndex((x) => x === pick) + 1];
    showWarn(`The picture keeps falling ${Math.round(ms)} ms behind the sound at ${resLabel(pick.resolution)}; your computer may be struggling with it.`,
      h('button', { class: 'btn sm', onclick: () => { warn.hidden = true; load(stream, cur(), true); } }, 'Re-sync'),
      lower && h('button', { class: 'btn sm', onclick: () => { warn.hidden = true; switchQuality(lower.resolution); } }, `Switch to ${resLabel(lower.resolution)}`));
  } });

  // ---------- controls ----------
  function toggle() { video.paused ? video.play().catch(() => {}) : video.pause(); }
  function seekTo(t) {
    t = Math.min(Math.max(0, t), Math.max(0, total() - 1));
    if (mode === 'compat') setSource(t, true);          // a converted stream can't be seeked inside the browser: re-open it there
    else video.currentTime = t;
  }
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', fullscreen);
  $('#pPlay').onclick = toggle;
  video.addEventListener('play', () => (setIcon($('#pPlay span'), 'pause')));
  video.addEventListener('pause', () => { setIcon($('#pPlay span'), 'play'); markProgress(); });
  $('#pMute').onclick = () => { video.muted = !video.muted; };
  $('#pVol').oninput = (e) => { video.volume = +e.target.value; video.muted = false; };
  video.addEventListener('volumechange', () => {
    setIcon($('#pMute span'), video.muted || !video.volume ? 'mute' : video.volume < 0.5 ? 'volumeLow' : 'volume');
    $('#pVol').value = video.muted ? 0 : video.volume;
  });
  function fullscreen() { document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen().catch(() => {}); }
  $('#pFull').onclick = fullscreen;
  $('#pBack').onclick = close;

  function frac(e) { const r = seek.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
  let dragging = false;
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); paintSeek(frac(e) * total()); });
  seek.addEventListener('pointermove', (e) => {
    const tip = seek.querySelector('.tip'); tip.hidden = false;
    tip.style.left = frac(e) * 100 + '%'; tip.textContent = fmt(frac(e) * total());
    if (dragging) paintSeek(frac(e) * total());
  });
  seek.addEventListener('pointerup', (e) => { if (dragging) { dragging = false; const to = frac(e) * total(), from = cur(); if (to - from >= 20 && from < 480) learnIntro(from, to); seekTo(to); } });
  seek.addEventListener('pointerleave', () => { seek.querySelector('.tip').hidden = true; });

  function paintSeek(t) {
    const d = total() || 1;
    seek.querySelector('.fill').style.width = (t / d) * 100 + '%';
    seek.querySelector('.thumb').style.left = (t / d) * 100 + '%';
    $('#pTime').textContent = `${fmt(t)} / ${fmt(total())}`;
  }

  video.addEventListener('timeupdate', () => {
    const t = cur();
    if (!dragging) paintSeek(t);
    const b = video.buffered;
    seek.querySelector('.buf').style.width = b.length && total() ? ((offset + b.end(b.length - 1)) / total()) * 100 + '%' : '0';
    if (Date.now() - lastSave > 10000) markProgress();
    nextEpisodeCheck(t); updateSkip(t);
  });
  video.addEventListener('durationchange', () => { if (!duration) paintSeek(cur()); });

  function markProgress(ended) {
    lastSave = Date.now();
    const d = total(); if (!ctx || !d) return;
    const pos = ended ? d : cur();
    // Remember which stream this was so Continue watching can reopen the same one.
    const meta = { ...ctx.meta, stream: { filename: stream.filename, resolution: pick.resolution } };
    api('/progress', { key: ctx.key, pos, dur: d, meta }).catch(() => {});
  }

  // ---------- quality ----------
  function buildMenus() {
    const q = $('#pQMenu');
    const out = h('output', {}, '');
    const showDelay = () => { out.textContent = (audioDelay > 0 ? '+' : '') + audioDelay + ' ms'; };
    let t;
    const nudge = (d) => {
      audioDelay = Math.max(-5000, Math.min(5000, audioDelay + d)); showDelay();
      localStorage.setItem('ss.audioDelay', audioDelay);
      clearTimeout(t); t = setTimeout(applySync, 700);
    };
    showDelay();
    q.replaceChildren(h('div', { class: 'mh' }, 'Quality'), ...ctx.picks.map((p) => h('button', {
      'data-res': p.resolution, class: p.resolution === pick.resolution ? 'on' : '',
      onclick: () => switchQuality(p.resolution),
    }, h('span', {}, resLabel(p.resolution)), h('small', {}, [p.stream.size && fmtSize(p.stream.size), p.stream.codec].filter(Boolean).join(' · ')))),
      h('div', { class: 'mh' }, 'Audio sync'),
      h('div', { class: 'sync' }, h('span', {}, 'Audio delay'), h('span', { class: 'st' },
        h('button', { class: 'pbtn', title: 'Audio earlier', onclick: () => nudge(-100) }, '−'), out,
        h('button', { class: 'pbtn', title: 'Audio later', onclick: () => nudge(100) }, '+'))),
      h('button', { class: 'resync', onclick: () => { $('#pQMenu').hidden = true; toast('Re-syncing picture and sound…'); load(stream, cur(), video.paused ? false : true); } }, h('span', {}, 'Re-sync picture and sound'), h('small', {}, 'Y')),
      h('div', { class: 'info', id: 'pInfo' }, ''));
    updateQuality();
  }
  /** Re-open the converted stream at the current position so the new audio delay takes effect. */
  function applySync() {
    if (!stream) return;
    if (!(window.APPINFO || {}).players?.ffmpeg) return toast('Install ffmpeg to adjust audio sync');
    const wasPaused = video.paused, t = cur();
    mode = 'compat'; setSource(t, !wasPaused); updateQuality();
  }
  function updateQuality() {
    const i = $('#pInfo');
    if (i && stream) i.textContent = `${mode === 'compat' ? 'Converted' : 'Direct play'} · ${info.video || '?'} / ${info.audio || '?'}${info.duration ? '' : ''}`;
    $('#pQLabel').textContent = pick ? resLabel(pick.resolution) : 'Auto';
    $('#pQMenu').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.res === pick.resolution));
  }
  function switchQuality(res) {
    $('#pQMenu').hidden = true;
    const p = ctx.picks.find((x) => x.resolution === res);
    if (!p || p === pick) return;
    const t = cur(), wasPaused = video.paused;
    pick = p; updateQuality();
    load(p.stream, t, !wasPaused).then(() => { if (wasPaused) video.pause(); });
    toast(`Switched to ${resLabel(res)}`);
  }

  // ---------- captions (off by default) ----------
  function parseVtt(text) {
    const cues = [];
    const ts = (s) => { const p = s.replace(',', '.').split(':').map(parseFloat); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n'); const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->').map((x) => x.trim().split(' ')[0]);
      const txt = lines.slice(i + 1).join('\n').trim();
      if (txt) cues.push({ start: ts(a), end: ts(b), text: txt });
    }
    return cues;
  }
  function buildSubs() {
    for (const t of subTracks) { t.track.mode = 'disabled'; }
    subTracks = ctx.subs.map((s) => ({ sub: s, track: video.addTextTrack('subtitles', s.label, s.lang), cues: null }));
    const m = $('#pCCMenu');
    m.replaceChildren(h('div', { class: 'mh' }, 'Captions'),
      h('button', { class: 'on', 'data-i': -1, onclick: () => setSub(-1) }, 'Off'),
      ...ctx.subs.map((s, i) => h('button', { 'data-i': i, onclick: () => setSub(i) }, s.label)));
    if (!ctx.subs.length) m.append(h('div', { class: 'mh' }, 'No captions found'));
    $('#pCC').classList.remove('on');
  }
  async function setSub(i) {
    $('#pCCMenu').hidden = true;
    activeSub = i;
    subTracks.forEach((t, j) => { t.track.mode = j === i ? 'showing' : 'disabled'; });
    $('#pCCMenu').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
    $('#pCC').classList.toggle('on', i >= 0);
    const t = subTracks[i];
    if (t && !t.cues) {
      try { t.cues = parseVtt(await (await fetch(`/api/sub/${t.sub.ref}.vtt`)).text()); } catch { t.cues = []; toast('Couldn’t load captions'); }
      shiftCues();
    }
  }
  /** Cue times are absolute; in compatibility mode the video restarts at `offset`, so re-add shifted cues. */
  function shiftCues() {
    for (const t of subTracks) {
      if (!t.cues) continue;
      for (const c of [...(t.track.cues || [])]) t.track.removeCue(c);
      for (const c of t.cues) if (c.end - offset > 0) t.track.addCue(new VTTCue(Math.max(0, c.start - offset), c.end - offset, c.text));
    }
  }
  $('#pCC').onclick = () => toggleMenu('#pCCMenu');
  $('#pQ').onclick = () => toggleMenu('#pQMenu');
  function toggleMenu(sel) {
    const m = $(sel), show = m.hidden;
    document.querySelectorAll('.menu').forEach((x) => (x.hidden = true));
    m.hidden = !show;
  }
  function cycleCaptions() { if (ctx.subs.length) setSub(activeSub >= 0 ? -1 : 0); else toast('No captions found'); }

  // ---------- next episode + episode sidebar ----------
  const nextAt = () => Skip.nextAt({ segments: segs, detectedAt: creditsDetectedAt, creditsFromEnd: learned.creditsFromEnd, duration: total() });
  function nextEpisodeCheck(t) {
    if (!ctx || !ctx.next || !total()) return;
    const at = nextAt(), remaining = total() - t;
    if (t >= at - 150 && !nextPromise) nextPromise = ctx.next.load().catch(() => null); // fetch the next episode's streams ahead of time
    const btn = $('#pNext'), show = t >= at && remaining > -1;
    if (show && btn.hidden) { btn.querySelector('small').textContent = ctx.next.label; btn.hidden = false; }
    else if (!show && !btn.hidden && t < at - 20) btn.hidden = true;
  }

  // ---------- skip intro / recap ----------
  const skipNow = () => Skip.skipAt(cur(), { segments: segs, learnedIntro: learned.intro, isSeries: ctx && ctx.type === 'series' });
  function updateSkip(t) {
    const btn = $('#pSkip'), k = ctx && skipNow();
    if (k && !$('#pNext').hidden) return;
    if (!k) { btn.hidden = true; return; }
    btn.dataset.kind = k.kind;
    if (btn.hidden || btn.dataset.label !== k.label) { btn.querySelector('span').textContent = k.label + ' ⏭'; btn.dataset.label = k.label; }
    btn.hidden = false;
  }
  $('#pSkip').onclick = () => {
    const k = skipNow(); if (!k) return;
    if (k.kind === 'manual') learnIntro(k.from, k.to);
    seekTo(k.to); $('#pSkip').hidden = true;
  };
  /** Remember where this show's intro runs, from a skip the user made, so later episodes get a proper Skip intro button. */
  function learnIntro(start, end) {
    if (!ctx || ctx.type !== 'series' || segs.intro || end - start < 15 || end - start > 300 || start > 900) return;
    api('/skips', { id: ctx.meta.id, kind: 'intro', start, end }).then(() => api('/skips?id=' + ctx.meta.id)).then((r) => { learned = { intro: r.intro, creditsFromEnd: r.creditsFromEnd }; }).catch(() => {});
  }

  // ---------- credits: noticed from the picture while it plays (no extra download) ----------
  const probeCanvas = document.createElement('canvas'); probeCanvas.width = 32; probeCanvas.height = 18;
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
  setInterval(() => {
    if (root.hidden || video.paused || !ctx || !ctx.next || !total() || creditsDetectedAt) return;
    const remaining = total() - cur();
    if (remaining > 420 || remaining < 8) { darkRun = 0; return; }
    try {
      probeCtx.drawImage(video, 0, 0, 32, 18);
      darkRun = Skip.frameIsCreditsLike(probeCtx.getImageData(0, 0, 32, 18).data) ? darkRun + 1 : Math.max(0, darkRun - 2);
    } catch { return; }
    if (darkRun >= 6) { // six seconds of mostly black: the credits have started
      creditsDetectedAt = cur() - 6;
      if (!segs.credits) api('/skips', { id: ctx.meta.id, kind: 'credits', fromEnd: total() - creditsDetectedAt }).then(() => api('/skips?id=' + ctx.meta.id)).then((r) => { learned.creditsFromEnd = r.creditsFromEnd; }).catch(() => {});
    }
  }, 1000);
  $('#pNext').onclick = async () => {
    cancelAutoplay();
    const next = await (nextPromise || ctx.next.load());
    if (!next || !next.picks.length) return toast('No streams available for the next episode');
    markProgress(true);
    open(next, pick.resolution, 0);
  };

  function renderSide() {
    const s = ctx.series, seasons = [...new Set(s.episodes.map((e) => e.season))];
    const sel = $('#pSeason'), curSeason = ctx.meta.season;
    sel.replaceChildren(...seasons.map((n) => h('option', { value: n, selected: n === curSeason }, `Season ${n}`)));
    const draw = () => $('#pEpList').replaceChildren(...s.episodes.filter((e) => e.season === +sel.value).map((e) => {
      const here = e.vid === ctx.vid;
      return h('div', { class: 'ep' + (here ? ' on' : ''), tabindex: 0, onclick: () => !here && playEpisode(e) },
        h('span', { class: 'n' }, e.episode), h('span', { class: 'nm' }, e.title), e.watched && h('span', { class: 'w' }, '✓'));
    }));
    sel.onchange = draw; draw();
    $('#pEpList').querySelector('.on')?.scrollIntoView({ block: 'center' });
  }
  async function playEpisode(e) {
    status('spin', `Finding streams for ${e.title}…`);
    try {
      const next = await ctx.series.load(e);
      if (!next.picks.length) { status(null); return toast('No streams available for that episode'); }
      markProgress(); open(next, pick.resolution);
    } catch (err) { status(null); toast(err.message); }
  }
  function openSide() { $('#pSide').hidden = false; renderSide(); }
  function closeSide() { $('#pSide').hidden = true; }
  $('#pEps').onclick = () => ($('#pSide').hidden ? openSide() : closeSide());
  $('#pSideClose').onclick = closeSide;

  async function openExternal() {
    try {
      const subs = ctx.subs.map((s) => s.ref);
      const r = await api('/play', { ref: stream.ref, key: ctx.key, title: ctx.title, meta: ctx.meta, subs });
      video.pause(); toast(`Opened in ${r.player}`);
    } catch (e) { toast(e.message); }
  }
  $('#pExt').onclick = openExternal;

  // ---------- chrome: idle hiding, keys, closing ----------
  function wake() {
    root.classList.remove('idle'); clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const busy = [...document.querySelectorAll('.menu')].some((m) => !m.hidden);
      if (!video.paused && !busy) root.classList.add('idle');
    }, 3000);
  }
  root.addEventListener('mousemove', wake);
  root.addEventListener('click', (e) => { wake(); if (!e.target.closest('.menuwrap')) document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)); });

  function close() {
    if (root.hidden) return;
    markProgress(); token++; cancelAutoplay();
    video.pause(); video.removeAttribute('src'); video.load();
    for (const t of subTracks) t.track.mode = 'disabled';
    root.hidden = true; $('#pWarn').hidden = true; document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen();
    if (window.onPlayerClosed) onPlayerClosed();
  }
  addEventListener('keydown', (e) => {
    if (root.hidden || e.target.matches('input[type=text],select')) return;
    wake();
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'arrowright') seekTo(cur() + 10);
    else if (k === 'arrowleft') seekTo(cur() - 10);
    else if (k === 'l') seekTo(cur() + 30);
    else if (k === 'j') seekTo(cur() - 30);
    else if (k === 'arrowup') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); }
    else if (k === 'arrowdown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); }
    else if (k === 'f') fullscreen();
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'c') cycleCaptions();
    else if (k === 'y') { toast('Re-syncing picture and sound…'); load(stream, cur(), !video.paused); }
    else if (k === 'e' && ctx.series) $('#pSide').hidden ? openSide() : closeSide();
    else if (k === 'escape') { if (!document.fullscreenElement) close(); }
  });
  addEventListener('beforeunload', () => { if (!root.hidden) markProgress(); });

  return { open, close };
})();
