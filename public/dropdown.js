'use strict';
/* Themed dropdowns. Every <select> is enhanced automatically: the native element stays in the DOM (hidden) as the
   source of truth, so .value, onchange and form submission keep working; this draws the button and the list. */
(() => {
  const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const CHECK = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CHEV = '<svg class="chev" viewBox="0 0 12 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1.5 6 6.5l5-5"/></svg>';
  let openDd = null;

  function enhance(sel) {
    if (sel.dataset.dd) return;
    sel.dataset.dd = '1';
    const pill = sel.classList.contains('pill');
    const wrap = document.createElement('div');
    wrap.className = 'dd';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'dd-btn' + (pill ? ' pill' : '');
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); label.className = 'dd-label';
    btn.append(label); btn.insertAdjacentHTML('beforeend', CHEV);
    const menu = document.createElement('div');
    menu.className = 'dd-menu'; menu.setAttribute('role', 'listbox'); menu.hidden = true;
    sel.before(wrap); wrap.append(btn, menu, sel); sel.classList.add('dd-native');
    wrap.hidden = sel.hidden;

    const sync = () => { label.textContent = sel.options[sel.selectedIndex]?.textContent || ''; wrap.hidden = sel.hidden; };
    // programmatic `select.value = x` (used by the app) has no event, so keep the button in step
    Object.defineProperty(sel, 'value', { get() { return valueProp.get.call(sel); }, set(v) { valueProp.set.call(sel, v); sync(); }, configurable: true });
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'selected'] });
    sync();

    const items = () => [...menu.querySelectorAll('.dd-item')];
    function choose(i) {
      sel.selectedIndex = i; sync(); close();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      btn.focus();
    }
    function close() {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); wrap.classList.remove('open', 'up', 'right');
      if (openDd === close) openDd = null;
    }
    function open() {
      if (openDd) openDd();
      menu.replaceChildren(...[...sel.options].map((o, i) => {
        const it = document.createElement('button');
        it.type = 'button'; it.className = 'dd-item' + (i === sel.selectedIndex ? ' on' : ''); it.setAttribute('role', 'option');
        it.setAttribute('aria-selected', i === sel.selectedIndex);
        const t = document.createElement('span'); t.textContent = o.textContent; it.append(t); it.insertAdjacentHTML('beforeend', CHECK);
        it.onclick = () => choose(i);
        return it;
      }));
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); wrap.classList.add('open');
      const r = btn.getBoundingClientRect(), mh = menu.offsetHeight, mw = menu.offsetWidth;
      if (r.bottom + mh + 12 > innerHeight && r.top > mh + 12) wrap.classList.add('up');
      if (r.left + mw > innerWidth - 12) wrap.classList.add('right');
      (menu.querySelector('.on') || items()[0])?.scrollIntoView({ block: 'nearest' });
      openDd = close;
    }
    btn.onclick = () => (menu.hidden ? open() : close());
    wrap.addEventListener('keydown', (e) => {
      const list = items(), at = list.indexOf(document.activeElement);
      if (menu.hidden) {
        if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); (menu.querySelector('.on') || items()[0])?.focus(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[Math.min(list.length - 1, at + 1)]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[Math.max(0, at - 1)]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
      else if (e.key === 'Tab') close();
      else if (e.key.length === 1 && /\S/.test(e.key)) { // type-ahead
        const k = e.key.toLowerCase(); const from = at < 0 ? 0 : at + 1;
        const hit = [...list.slice(from), ...list.slice(0, from)].find((x) => x.textContent.trim().toLowerCase().startsWith(k));
        hit?.focus();
      }
    });
  }

  const scan = () => document.querySelectorAll('select:not([data-dd])').forEach(enhance);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('mousedown', (e) => { if (openDd && !e.target.closest('.dd')) openDd(); });
  addEventListener('blur', () => openDd && openDd());
  addEventListener('hashchange', () => openDd && openDd());
  scan();
})();
