'use strict';
/* Pure logic for controller navigation, kept free of the DOM so it can be unit tested:
   - pick(): which control to move to when the stick/d-pad is pushed in a direction (spatial navigation)
   - edit(): text editing for the on-screen keyboard
   - LAYERS: the keyboard layouts */
const PadNav = (() => {
  const mid = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

  /**
   * rects: [{ left, top, right, bottom }]; from: index of the current control (or -1); dir: 'up'|'down'|'left'|'right'.
   * Returns the index of the best control in that direction, or -1. Moving along an axis is cheap, drifting off it
   * is expensive, so d-pad presses stay in a row/column of a grid but can still step diagonally when nothing lines up.
   */
  function pick(rects, from, dir) {
    const c = rects[from];
    if (!c) return -1;
    const cm = mid(c);
    let best = -1, bestScore = Infinity;
    rects.forEach((r, i) => {
      if (i === from) return;
      const m = mid(r);
      const dx = m.x - cm.x, dy = m.y - cm.y;
      let along, across, edge;
      if (dir === 'right') { along = dx; across = Math.abs(dy); edge = r.left - c.right; }
      else if (dir === 'left') { along = -dx; across = Math.abs(dy); edge = c.left - r.right; }
      else if (dir === 'down') { along = dy; across = Math.abs(dx); edge = r.top - c.bottom; }
      else { along = -dy; across = Math.abs(dx); edge = c.top - r.bottom; }
      if (along <= 1) return;                              // not in that direction
      if (across > along * 3 && edge < 0) return;           // overlapping and mostly sideways
      const overlapBonus = dir === 'left' || dir === 'right'
        ? (Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0 ? 0.35 : 1)
        : (Math.min(r.right, c.right) - Math.max(r.left, c.left) > 0 ? 0.35 : 1);
      const score = along + across * 3 * overlapBonus;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  /** state: { value, pos }. Returns a new state; `op` is { ins: 'text' } | { back: true } | { left: true } | { right: true } | { clear: true }. */
  function edit(state, op) {
    const { value, pos } = state;
    if (op.ins != null) return { value: value.slice(0, pos) + op.ins + value.slice(pos), pos: pos + op.ins.length };
    if (op.back) return pos > 0 ? { value: value.slice(0, pos - 1) + value.slice(pos), pos: pos - 1 } : state;
    if (op.left) return { value, pos: Math.max(0, pos - 1) };
    if (op.right) return { value, pos: Math.min(value.length, pos + 1) };
    if (op.clear) return { value: '', pos: 0 };
    return state;
  }

  // Each key: a string (types itself) or { k: label, act } for actions. The last row of every layer has the same actions.
  const ACTIONS = (done) => [{ k: '?123', act: 'symbols' }, { k: 'space', act: 'space', w: 4 }, { k: '←', act: 'left' }, { k: '→', act: 'right' }, { k: 'Clear', act: 'clear' }, { k: done, act: 'done', w: 2 }];
  const LAYERS = {
    lower: (done) => [[...'1234567890'], [...'qwertyuiop'], [...'asdfghjkl\''], [{ k: '⇧', act: 'shift' }, ...'zxcvbnm', { k: '⌫', act: 'back' }], ACTIONS(done)],
    upper: (done) => [[...'1234567890'], [...'QWERTYUIOP'], [...'ASDFGHJKL"'], [{ k: '⇧', act: 'shift' }, ...'ZXCVBNM', { k: '⌫', act: 'back' }], ACTIONS(done)],
    symbols: (done) => [[...'1234567890'], [...'@#$%&*()-_'], [...'!?:;/\\+=~^'], [...'.,[]{}<>|"', { k: '⌫', act: 'back' }], [{ k: 'ABC', act: 'letters' }, ...ACTIONS(done).slice(1)]],
  };

  return { pick, edit, LAYERS };
})();
if (typeof module !== 'undefined') module.exports = PadNav;
