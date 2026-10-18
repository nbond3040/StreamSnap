'use strict';
/* In-app video player: quality switching (swaps the underlying stream), captions (off by default),
   next-episode button and episode sidebar. Uses h()/api()/toast() from app.js at call time. */
const Player = (() => {
  const $ = (s) => document.querySelector(s);
  const root = $('#player'), video = $('#video'), seek = $('#pSeek');
  let ctx, pick, stream, mode, offset = 0, duration = 0, info = {}, fellBack = false;
  let lastSave = 0, nextPromise = null, subTracks = [], activeSub = -1, idleTimer, token = 0;

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
    ctx = c; nextPromise = null; activeSub = -1; $('#pNext').hidden = true;
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
    stream = s; fellBack = false;
    status('spin', 'Loading ' + resLabel(s.resolution) + '…');
    info = await api('/probe?ref=' + s.ref).catch(() => ({ mode: 'direct' }));
    if (my !== token) return;
    duration = info.duration || 0;
    mode = info.mode === 'compat' ? 'compat' : 'direct';
    setSource(at);
    if (autoplay) video.play().catch(() => {});
    updateQuality();
  }

  function setSource(at) {
    at = Math.max(0, at || 0);
    if (mode === 'compat') { offset = at; video.src = `/api/compat/${stream.ref}?t=${at}`; }
    else {
      offset = 0; video.src = `/api/stream/${stream.ref}`;
      video.addEventListener('loadedmetadata', () => { if (at) video.currentTime = at; }, { once: true });
    }
    status('spin', mode === 'compat' ? 'Preparing stream (compatibility mode)…' : 'Buffering…');
    shiftCues();
  }

  function status(kind, msg, extra) {
    const el = $('#pStatus');
    if (!kind) { el.hidden = true; return; }
    el.hidden = false; el.className = kind === 'err' ? 'err2' : '';
    el.replaceChildren(h('div', {}, kind === 'spin' && h('div', { class: 'spinner' }), h('div', {}, msg), extra || null));
  }

  video.addEventListener('playing', () => status(null));
  video.addEventListener('waiting', () => status('spin', 'Buffering…'));
  video.addEventListener('canplay', () => status(null));
  video.addEventListener('error', () => {
    if (!stream || !video.getAttribute('src')) return;
    if (mode === 'direct' && !fellBack && info.ffmpeg !== false && (window.APPINFO || {}).players?.ffmpeg) {
      fellBack = true; mode = 'compat'; setSource(cur()); video.play().catch(() => {}); return;
    }
    const hints = [h('div', { class: 'subtle', style: 'margin:8px 0 14px' }, (APPINFO.players.ffmpeg ? 'Try another quality from the menu.' : 'Install ffmpeg for automatic format conversion, or try another quality.'))];
    if (APPINFO.players.mpv || APPINFO.players.vlc) hints.push(h('button', { class: 'btn', onclick: openExternal }, 'Open in mpv / VLC'));
    status('err', 'This stream can’t be played in the app window.', h('div', {}, hints));
  });
  video.addEventListener('ended', () => { markProgress(true); });

  // Chromium can't decode AC3/E-AC3/DTS and plays those files silently without raising an error.
  // If nothing has been decoded a few seconds into playback, switch to the converting stream.
  setInterval(() => {
    if (root.hidden || video.paused || video.muted || video.currentTime < 3 || mode === 'compat' || fellBack) return;
    if (video.webkitAudioDecodedByteCount === 0) {
      if ((window.APPINFO || {}).players?.ffmpeg) { fellBack = true; mode = 'compat'; toast('Converting audio for playback…'); setSource(cur()); video.play().catch(() => {}); }
      else if (!Player.warned) { Player.warned = true; status('err', 'This stream’s audio format isn’t supported by the app window.', h('div', { class: 'subtle', style: 'margin-top:8px' }, 'Install ffmpeg (sudo apt install ffmpeg) to fix this automatically, or pick another quality.')); }
    }
  }, 1500);

  // ---------- controls ----------
  function toggle() { video.paused ? video.play().catch(() => {}) : video.pause(); }
  function seekTo(t) {
    t = Math.min(Math.max(0, t), Math.max(0, total() - 1));
    if (mode === 'compat') {
      const rel = t - offset, b = video.buffered;
      if (rel >= 0 && b.length && rel < b.end(b.length - 1) - 1) video.currentTime = rel;
      else { setSource(t); video.play().catch(() => {}); }
    } else video.currentTime = t;
  }
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', fullscreen);
  $('#pPlay').onclick = toggle;
  video.addEventListener('play', () => ($('#pPlay').textContent = '⏸'));
  video.addEventListener('pause', () => { $('#pPlay').textContent = '▶'; markProgress(); });
  $('#pMute').onclick = () => { video.muted = !video.muted; };
  $('#pVol').oninput = (e) => { video.volume = +e.target.value; video.muted = false; };
  video.addEventListener('volumechange', () => {
    $('#pMute').textContent = video.muted || !video.volume ? '🔇' : '🔊';
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
  seek.addEventListener('pointerup', (e) => { if (dragging) { dragging = false; seekTo(frac(e) * total()); } });
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
    nextEpisodeCheck(t);
  });
  video.addEventListener('durationchange', () => { if (!duration) paintSeek(cur()); });

  function markProgress(ended) {
    lastSave = Date.now();
    const d = total(); if (!ctx || !d) return;
    const pos = ended ? d : cur();
    api('/progress', { key: ctx.key, pos, dur: d, meta: ctx.meta }).catch(() => {});
  }

  // ---------- quality ----------
  function buildMenus() {
    const q = $('#pQMenu');
    q.replaceChildren(h('div', { class: 'mh' }, 'Quality'), ...ctx.picks.map((p) => h('button', {
      'data-res': p.resolution, class: p.resolution === pick.resolution ? 'on' : '',
      onclick: () => switchQuality(p.resolution),
    }, h('span', {}, resLabel(p.resolution)), h('small', {}, [p.stream.size && fmtSize(p.stream.size), p.stream.codec].filter(Boolean).join(' · ')))));
    updateQuality();
  }
  function updateQuality() {
    $('#pQ').textContent = pick ? resLabel(pick.resolution) : 'Quality';
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
  function nextEpisodeCheck(t) {
    if (!ctx || !ctx.next || !total()) return;
    const remaining = total() - t;
    if (remaining <= 240 && !nextPromise) nextPromise = ctx.next.load().catch(() => null); // prefetch streams
    const btn = $('#pNext'), show = remaining <= 75 && remaining > -1;
    if (show && btn.hidden) {
      btn.querySelector('small').textContent = ctx.next.label;
      btn.hidden = false;
    } else if (!show && !btn.hidden && remaining > 100) btn.hidden = true;
  }
  $('#pNext').onclick = async () => {
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
      return h('div', { class: 'ep' + (here ? ' on' : ''), onclick: () => !here && playEpisode(e) },
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
    markProgress(); token++;
    video.pause(); video.removeAttribute('src'); video.load();
    for (const t of subTracks) t.track.mode = 'disabled';
    root.hidden = true; document.body.style.overflow = '';
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
    else if (k === 'arrowup') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); }
    else if (k === 'arrowdown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); }
    else if (k === 'f') fullscreen();
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'c') cycleCaptions();
    else if (k === 'e' && ctx.series) $('#pSide').hidden ? openSide() : closeSide();
    else if (k === 'escape') { if (!document.fullscreenElement) close(); }
  });
  addEventListener('beforeunload', () => { if (!root.hidden) markProgress(); });

  return { open, close };
})();
