'use strict';
/* Controller support (PS5 DualSense and any "standard" gamepad) through the browser's Gamepad API.
     Menus     d-pad / left stick move between controls, ✕ select, ○ back, △ play the focused cover, □ search,
               L1/R1 switch tabs, L2/R2 page up/down, right stick scrolls, Options toggles fullscreen
     Player    ✕ play/pause, d-pad seek and volume, L1/R1 ±30 s, △ skip intro / next episode / episodes,
               □ captions, Create quality menu, Options fullscreen, ○ back
     Live TV   d-pad up/down or L1/R1 change channel, ✕ / △ channel guide, □ mute, Create record menu, R3 favorite
   Pressing ✕ on a text field opens an on-screen keyboard. Uses PadNav (padnav.js) and toast()/goBack() from app.js. */
(() => {
  const $ = (s) => document.querySelector(s);
  const B = { X: 0, O: 1, SQ: 2, TRI: 3, L1: 4, R1: 5, L2: 6, R2: 7, CREATE: 8, OPT: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const DIRS = { [B.UP]: 'up', [B.DOWN]: 'down', [B.LEFT]: 'left', [B.RIGHT]: 'right' };
  const TEXT_TYPES = /^(text|search|password|email|url|tel|number)$/;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]):not([type=range]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  let pad = null, lastPad = 0;
  const held = new Map();           // button/dir -> { since, last }
  let osk = null;                   // { el, value, pos, layer, sticky }

  // ---------- small helpers ----------
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
  };
  const key = (k, target) => (target || document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const click = (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; if (el && !el.hidden) { el.click(); return true; } return false; };
  const shown = (sel) => { const el = $(sel); return !!el && !el.hidden && el.getClientRects().length > 0; };
  const toastMsg = (m) => { try { toast(m); } catch { /* app not ready */ } };

  function mode() {
    if (osk) return 'osk';
    if (shown('#livePlayer')) return 'live';
    if (shown('#player')) return 'player';
    return 'menu';
  }

  /** An open popup that should capture navigation: everything else is out of reach until it's closed. */
  function trap() {
    const open = ['.osk', '.gm-back .gm-card', '.team-panel:not([hidden])', '.dd-menu:not([hidden])', '#pQMenu:not([hidden])', '#pCCMenu:not([hidden])',
      '#lpRecMenu:not([hidden])', '#pSide:not([hidden])'];
    for (const s of open) { const el = $(s); if (el && el.getClientRects().length) return el; }
    return null;
  }

  // ---------- spatial navigation ----------
  function candidates(root) {
    const scope = root || document;
    return [...scope.querySelectorAll(FOCUSABLE)].filter((el) => {
      if (el.closest('[hidden], .dd-native')) return false;
      if (el.closest('.card') && el !== el.closest('.card')) return false;        // a cover is one stop; △ plays it
      if (!root && (el.closest('#player') || el.closest('#livePlayer')) && mode() === 'menu') return false;
      return visible(el);
    });
  }

  function focusEl(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function move(dir) {
    const root = trap();
    const list = candidates(root);
    if (!list.length) return;
    let at = list.indexOf(document.activeElement);
    if (at < 0 && document.activeElement && document.activeElement !== document.body) at = list.findIndex((el) => el.contains(document.activeElement));
    if (at < 0) {                                           // nothing focused yet: start with the first control on screen
      const top = root ? 0 : ($('#top') ? $('#top').getBoundingClientRect().bottom : 0);
      const first = list.find((el) => { const r = el.getBoundingClientRect(); return r.top >= top - 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.left < innerWidth; }) || list[0];
      return focusEl(first);
    }
    const to = PadNav.pick(list.map((el) => el.getBoundingClientRect()), at, dir);
    if (to >= 0) focusEl(list[to]);
    else if (dir === 'down' || dir === 'up') scrollBy({ top: dir === 'down' ? 240 : -240, behavior: 'smooth' });   // nothing further: reveal more of the page
  }

  // ---------- activating / going back ----------
  function activate() {
    const el = document.activeElement;
    if (!el || el === document.body) return move('down');
    if ((el.matches('input') && TEXT_TYPES.test(el.type)) || el.matches('textarea')) return openOsk(el);
    el.click();
    setTimeout(enterTrap, 60);
  }

  /** A menu or dialog just opened: put the cursor inside it, on the current choice when it has one. */
  function enterTrap() {
    const t = trap();
    if (!t || t.contains(document.activeElement)) return;
    const first = t.querySelector('.on') || candidates(t)[0];
    if (first) focusEl(first);
  }

  function back() {
    if (osk) return closeOsk();
    const dd = $('.dd-menu:not([hidden])');
    if (dd) return key('Escape', dd.querySelector('button') || document.activeElement);
    const gm = $('.gm-back');
    if (gm) return click('.gm-close');
    if ($('.team-panel:not([hidden])')) return document.body.click();
    if (shown('#pQMenu')) return click('#pQ');
    if (shown('#pCCMenu')) return click('#pCC');
    if (shown('#lpRecMenu')) return click('#lpRec');
    if (shown('#pSide')) return click('#pSideClose');
    if (mode() === 'live' || mode() === 'player') {
      if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
      return key('Escape', document.body);
    }
    if (typeof goBack === 'function') goBack(); else history.back();
  }

  // ---------- on-screen keyboard ----------
  function openOsk(el) {
    const value = el.value || '', pos = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
    osk = { el, value, pos: Math.min(pos, value.length), layer: 'lower', sticky: false, at: [1, 0] };
    const box = document.createElement('div');
    box.className = 'osk'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'On-screen keyboard');
    osk.box = box; document.body.append(box);
    renderOsk();
  }

  function renderOsk() {
    const st = osk, done = st.el.type === 'search' || st.el.closest('#search') ? 'Search' : 'Done';
    const label = (st.el.getAttribute('aria-label') || st.el.placeholder || st.el.name || '').slice(0, 40);
    const text = st.el.type === 'password' ? '•'.repeat(st.value.length) : st.value;
    const rows = PadNav.LAYERS[st.layer](done);
    const keyEl = (k) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'osk-key';
      const o = typeof k === 'string' ? { k, ch: k } : k;
      b.textContent = o.k; b.style.flex = String(o.w || 1);
      if (o.act === 'done') b.classList.add('go');
      if (o.act === 'shift' && st.layer === 'upper') b.classList.add('on');
      b.onclick = () => press(o);
      return b;
    };
    const prev = document.createElement('div'); prev.className = 'osk-preview';
    const lab = document.createElement('span'); lab.className = 'osk-label'; lab.textContent = label;
    const tx = document.createElement('span'); tx.className = 'osk-text';
    tx.append(text.slice(0, st.pos), Object.assign(document.createElement('i'), { className: 'osk-caret' }), text.slice(st.pos));
    prev.append(lab, tx);
    const grid = document.createElement('div'); grid.className = 'osk-rows';
    for (const r of rows) { const row = document.createElement('div'); row.className = 'osk-row'; r.forEach((k) => row.append(keyEl(k))); grid.append(row); }
    const hint = document.createElement('div'); hint.className = 'osk-hint';
    hint.textContent = `✕ Type · □ Backspace · △ Space · L2 Shift · L1/R1 Move cursor · Options ${done} · ○ Close`;
    st.box.replaceChildren(prev, grid, hint);
    const [r, c] = st.at, rowEls = grid.children, row = rowEls[Math.min(r, rowEls.length - 1)];
    row.children[Math.min(c, row.children.length - 1)].focus({ preventScroll: true });
  }

  function writeBack() {
    const st = osk, el = st.el;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, st.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try { el.setSelectionRange(st.pos, st.pos); } catch { /* number/email inputs have no cursor */ }
  }

  function press(o) {
    const st = osk;
    if (!st) return;
    const where = () => { const row = document.activeElement && document.activeElement.parentElement; const rows = [...st.box.querySelectorAll('.osk-row')]; st.at = [Math.max(0, rows.indexOf(row)), row ? [...row.children].indexOf(document.activeElement) : 0]; };
    where();
    const apply = (op) => { Object.assign(st, PadNav.edit({ value: st.value, pos: st.pos }, op)); writeBack(); };
    const act = o.act;
    if (!act) {
      apply({ ins: o.ch });
      if (st.layer === 'upper' && !st.sticky) st.layer = 'lower';
    } else if (act === 'space') apply({ ins: ' ' });
    else if (act === 'back') apply({ back: true });
    else if (act === 'left') apply({ left: true });
    else if (act === 'right') apply({ right: true });
    else if (act === 'clear') apply({ clear: true });
    else if (act === 'shift') { st.layer = st.layer === 'upper' ? 'lower' : 'upper'; st.sticky = false; }
    else if (act === 'symbols') st.layer = 'symbols';
    else if (act === 'letters') st.layer = 'lower';
    else if (act === 'done') return finishOsk();
    renderOsk();
  }

  function finishOsk() {
    const el = osk.el;
    closeOsk();
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (el.form) { try { el.form.requestSubmit(); } catch { el.form.dispatchEvent(new Event('submit', { cancelable: true })); } }
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  function closeOsk() {
    if (!osk) return;
    const el = osk.el;
    osk.box.remove(); osk = null;
    if (document.contains(el)) el.focus({ preventScroll: true });
  }

  // ---------- reacting to buttons ----------
  function onPress(b) {
    const m = mode();
    if (m === 'osk') return oskPress(b);
    if (m === 'live') return livePress(b);
    if (m === 'player') return playerPress(b);
    return menuPress(b);
  }

  function oskPress(b) {
    const active = document.activeElement;
    if (DIRS[b]) return move(DIRS[b]);
    if (b === B.X) return active && active.classList.contains('osk-key') ? active.click() : null;
    if (b === B.O) return closeOsk();
    if (b === B.SQ) return press({ act: 'back' });
    if (b === B.TRI) return press({ act: 'space' });
    if (b === B.L1) return press({ act: 'left' });
    if (b === B.R1) return press({ act: 'right' });
    if (b === B.L2) return press({ act: 'shift' });
    if (b === B.OPT) return press({ act: 'done' });
  }

  function menuPress(b) {
    if (DIRS[b]) return move(DIRS[b]);
    if (b === B.X) return activate();
    if (b === B.O) return back();
    if (b === B.TRI) { const c = document.activeElement && document.activeElement.closest && document.activeElement.closest('.card'); return c && click(c.querySelector('.playbtn')); }
    if (b === B.SQ) { const s = $('#search input'); if (s) { s.focus({ preventScroll: true }); openOsk(s); } return; }
    if (b === B.L1 || b === B.R1) return cycleTab(b === B.R1 ? 1 : -1);
    if (b === B.L2) return scrollBy({ top: -innerHeight * 0.8, behavior: 'smooth' });
    if (b === B.R2) return scrollBy({ top: innerHeight * 0.8, behavior: 'smooth' });
    if (b === B.OPT) return click('#appFull');
  }

  function cycleTab(d) {
    const tabs = [...document.querySelectorAll('#top nav a')];
    const i = tabs.findIndex((a) => a.classList.contains('on'));
    const to = tabs[(Math.max(0, i) + d + tabs.length) % tabs.length];
    if (to) { to.click(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }
  }

  function playerPress(b) {
    if (trap()) {                                           // quality / captions menus, episode list: navigate them like a menu
      if (DIRS[b]) return move(DIRS[b]);
      if (b === B.X) return activate();
      if (b === B.O) return back();
      return;
    }
    if (b === B.X) return key(' ', document.body);
    if (b === B.O) return back();
    if (DIRS[b] && (b === B.UP || b === B.DOWN)) return key(b === B.UP ? 'ArrowUp' : 'ArrowDown', document.body);
    if (b === B.LEFT) return key('ArrowLeft', document.body);
    if (b === B.RIGHT) return key('ArrowRight', document.body);
    if (b === B.L1) return key('j', document.body);
    if (b === B.R1) return key('l', document.body);
    if (b === B.SQ) return key('c', document.body);
    if (b === B.OPT) return key('f', document.body);
    if (b === B.L3) return key('m', document.body);
    if (b === B.CREATE) { click('#pQ'); return setTimeout(enterTrap, 80); }
    if (b === B.TRI || b === B.R2) { if (click('#pSkip') || click('#pNext')) return; if (b === B.TRI) { key('e', document.body); setTimeout(enterTrap, 80); } }
  }

  function livePress(b) {
    if (trap()) {
      if (DIRS[b]) return move(DIRS[b]);
      if (b === B.X) return activate();
      if (b === B.O) return back();
      return;
    }
    const guide = $('#lpGuide') && !$('#lpGuide').hidden;
    if (guide) {
      if (b === B.UP) return key('ArrowUp', document.body);
      if (b === B.DOWN) return key('ArrowDown', document.body);
      if (b === B.X) return key('Enter', document.body);
      if (b === B.O || b === B.TRI) return key('Escape', document.body);
      return;
    }
    if (b === B.O) return back();
    if (b === B.UP || b === B.L1) return key('ArrowUp', document.body);
    if (b === B.DOWN || b === B.R1) return key('ArrowDown', document.body);
    if (b === B.X || b === B.TRI) return key('g', document.body);
    if (b === B.SQ) return key('m', document.body);
    if (b === B.OPT) return key('f', document.body);
    if (b === B.L3) return key('r', document.body);
    if (b === B.R3) return click('#lpFav');
    if (b === B.CREATE) { click('#lpRec'); return setTimeout(enterTrap, 80); }
  }

  // ---------- polling ----------
  const isDown = (p, i) => !!p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
  function dirsDown(p) {
    const d = new Set();
    for (const [btn, name] of Object.entries(DIRS)) if (isDown(p, +btn)) d.add(+btn);
    const x = p.axes[0] || 0, y = p.axes[1] || 0;
    if (y < -0.6) d.add(B.UP); if (y > 0.6) d.add(B.DOWN); if (x < -0.6) d.add(B.LEFT); if (x > 0.6) d.add(B.RIGHT);
    return d;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    pad = [...pads].find((p) => p && p.connected) || null;
    if (!pad) { held.clear(); return; }
    if (!document.hasFocus()) return;

    const down = dirsDown(pad);
    for (const b of Object.keys(B).map((k) => B[k])) {
      const isDir = DIRS[b] != null;
      const on = isDir ? down.has(b) : isDown(pad, b);
      const h = held.get(b);
      if (!on) { held.delete(b); continue; }
      let fire = false;
      if (!h) { held.set(b, { since: now, last: now }); fire = true; }
      else if (isDir || b === B.L1 || b === B.R1) {
        const m = mode(), seeking = m === 'player' && (b === B.LEFT || b === B.RIGHT || b === B.UP || b === B.DOWN);
        const first = seeking ? 350 : 420, every = seeking ? 130 : 120;
        if (now - h.since > first && now - h.last > every && (isDir || m !== 'menu')) { h.last = now; fire = true; }
      }
      if (fire) { activity(); onPress(b); }
    }
    // right stick scrolls menus
    const ry = pad.axes[3] || 0;
    if (Math.abs(ry) > 0.2 && mode() === 'menu' && !trap()) { activity(); scrollBy(0, ry * 22); }
  }

  // ---------- pad mode: focus ring and legend only while the controller is in use ----------
  let legendTimer;
  function activity() {
    lastPad = Date.now();
    if (!document.body.classList.contains('gp-on')) document.body.classList.add('gp-on');
    legend(true);
  }
  function legend(show) {
    let el = $('#gpLegend');
    if (!el) {
      el = document.createElement('div'); el.id = 'gpLegend';
      el.innerHTML = '<span><b>✕</b> Select</span><span><b>○</b> Back</span><span><b>△</b> Play</span><span><b>□</b> Search</span><span><b>L1</b>/<b>R1</b> Tabs</span><span><b>L2</b>/<b>R2</b> Page</span>';
      document.body.append(el);
    }
    el.classList.toggle('show', show && mode() === 'menu');
    clearTimeout(legendTimer);
    legendTimer = setTimeout(() => el.classList.remove('show'), 7000);
  }
  addEventListener('mousemove', () => { if (Date.now() - lastPad > 300) document.body.classList.remove('gp-on'); legend(false); }, { passive: true });

  addEventListener('gamepadconnected', (e) => {
    const g = e.gamepad || {};
    const name = (g.id || 'Controller').replace(/\s*\(.*$/, '').replace(/Vendor.*$/i, '').trim() || 'Controller';
    toastMsg(`Controller connected: ${name}` + (g.mapping === 'standard' || !g.id ? '' : ' (non-standard layout, some buttons may differ)'));
    activity();
  });
  addEventListener('gamepaddisconnected', () => { if (osk) closeOsk(); document.body.classList.remove('gp-on'); });
  addEventListener('hashchange', () => { if (osk) closeOsk(); });
  requestAnimationFrame(frame);

  window.PadControl = { mode, move, back, openOsk };   // for tests
})();
