/* public/js/ycIconPicker.js — the icon picker (ui-custom S6a): every FREE
 * Font Awesome 6.5.0 icon, solid / regular / brands.
 *
 *   window.ycIconPicker.open({ value, title, allowEmpty, from }) → Promise
 *     value       the field's current stored value (highlighted when listed)
 *     title       the dialog heading (plain text; default "Choose an icon")
 *     allowEmpty  true → a "No icon" button, which resolves ''. Only for a
 *                 field that may be empty — none of today's callers.
 *     from        the element to give focus back to on close (the caller's
 *                 Choose… button), from any same-origin frame
 *   resolves the chosen value (the stored grammar, public/js/ycIcon.js:
 *   solid BARE, 'regular:star', 'brands:github'), '' for No icon, or null
 *   when cancelled (Esc, ×, Cancel, the backdrop, or another open()).
 *   ycIconPicker.isOpen() → boolean; ycIconPicker.close() cancels.
 *
 * ONE implementation, hosted by the shell (index.html loads this file after
 * ycIcon.js). Panes in same-origin iframes (caseconfig/firm.html,
 * settings.html) call window.top.ycIconPicker.open(...): the dialog is drawn
 * in the TOP document — full-bleed at phone width, never boxed inside a
 * frame — and the promise resolves into the caller's realm as usual.
 *
 * The catalog (/js/faIcons-<version>.json, built by
 * scripts/buildFaIconCatalog.js from FA's own metadata — names, the families
 * each is free in, search terms) is fetched the FIRST time a picker opens,
 * once per page load (a failed load can be retried). A plain static GET: no
 * token, no apiSend.
 *
 * Rendering: the grid draws in chunks (CHUNK tiles, more as it scrolls or as
 * the keyboard moves past the end), so ~2,000 icons stay quick on a phone.
 * Names are text (textContent / setAttribute); every class string comes from
 * ycIcon.cls() of a value ycIcon.value() built from a catalog name and a known
 * family — never from the query or any other free text. The search is plain
 * substring matching (indexOf), no regex built from input.
 *
 * Keyboard: typing searches; ↓ (or Tab) moves into the grid; arrows, Home /
 * End and Page Up / Down move inside it (↑ from the top row returns to the
 * search box); Enter or Space picks; Enter in the search box picks the
 * highlighted icon (the first match once you type); Esc cancels. Tab cycles
 * inside the dialog. While it is open no key reaches anything behind it (the
 * layout editor's Esc, the Ctrl-K palette, shortcuts): its root stops every
 * keydown it sees, and a CAPTURE-phase guard on the document — added on open,
 * removed on close — catches any key whose target is outside it (focus fallen
 * to <body>: Esc cancels, anything else puts focus back in the search box).
 * The box takes focus on a click, a press on the backdrop never blurs, and Try
 * again moves focus to the search box before it rebuilds its message.
 *
 * z-index 1055: above the tool dialog (1040), the layout editor (1045), a
 * drawer (1046) and the palette (1050); below SweetAlert2 (1060).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var CATALOG_URL = '/js/faIcons-6.5.0.json';
  var CHUNK = 120;
  var Q_MAX = 60;
  var COLS_FALLBACK = 8;          // no layout (a test DOM): arrows move by this
  var LETTER = { s: 'solid', r: 'regular', b: 'brands' };
  var FAM_LABEL = { solid: 'Solid', regular: 'Regular', brands: 'Brands' };
  var CHIPS = [['', 'All'], ['solid', 'Solid'], ['regular', 'Regular'], ['brands', 'Brands']];

  var catalogP = null;            // the one fetch (null again after a failure)
  var TILES = null;               // [{ name, family, value, hay }] name order, then s / r / b
  var D = null;                   // the dialog's elements, built on first open
  var S = null;                   // the open session

  function I() { return window.ycIcon; }

  // ── catalog ──────────────────────────────────────────────────────────
  function buildTiles(cat) {
    if (!cat || !Array.isArray(cat.icons)) throw new Error('icon catalog: no icons');
    var out = [];
    cat.icons.forEach(function (row) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') return;
      var name = row[0], terms = typeof row[2] === 'string' ? row[2].toLowerCase() : '';
      for (var k = 0; k < row[1].length; k++) {
        var family = LETTER[row[1].charAt(k)];
        var v = family ? I().value(family, name) : null;     // grammar-checked, or skipped
        if (v === null) continue;
        out.push({ name: name, family: family, value: v, hay: name + ' ' + terms });
      }
    });
    if (!out.length) throw new Error('icon catalog: empty');
    return out;
  }
  function loadCatalog() {
    if (!catalogP) {
      catalogP = fetch(CATALOG_URL, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (cat) { TILES = buildTiles(cat); return TILES; })
        .catch(function (e) { catalogP = null; throw e; });
    }
    return catalogP;
  }

  // ── search ───────────────────────────────────────────────────────────
  /** The tiles for a query and a family ('' = all): every word of the query
   *  must occur in the name or the terms. Order: the exact name, names
   *  starting with the first word, names containing it, then term matches —
   *  catalog order within each. */
  function filter(tiles, query, family) {
    var q = String(query == null ? '' : query).slice(0, Q_MAX).toLowerCase().trim();
    var words = q ? q.split(' ').filter(Boolean) : [];
    var buckets = [[], [], [], []];
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (family && t.family !== family) continue;
      var ok = true;
      for (var w = 0; w < words.length && ok; w++) ok = t.hay.indexOf(words[w]) >= 0;
      if (!ok) continue;
      if (!words.length) { buckets[0].push(t); continue; }
      var first = words[0];
      buckets[t.name === q ? 0 : t.name.indexOf(first) === 0 ? 1 : t.name.indexOf(first) >= 0 ? 2 : 3].push(t);
    }
    return buckets[0].concat(buckets[1], buckets[2], buckets[3]);
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  var CSS = [
    '#ycIconPicker { position: fixed; inset: 0; z-index: 1055; display: flex; align-items: center; justify-content: center;',
    '  padding: 16px; box-sizing: border-box; }',
    '#ycIconPicker[hidden] { display: none; }',
    '#ycIconPicker .yip-back { position: absolute; inset: 0; background: var(--backdrop); }',
    '#ycIconPicker .yip-box { position: relative; display: flex; flex-direction: column; width: 720px; max-width: 100%;',
    '  height: 640px; max-height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; text-align: left;',
    '  font-family: var(--ui); background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);',
    '  border-radius: var(--radius); box-shadow: var(--shadow-drawer); outline: none; }',
    '#ycIconPicker .yip-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0;',
    '  padding: 6px 6px 6px 16px; border-bottom: 1px solid var(--border); }',
    '#ycIconPicker .yip-head h2 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--fs-lg); font-weight: 600;',
    '  color: var(--text); overflow-wrap: anywhere; }',
    '#ycIconPicker .yip-x { flex: 0 0 auto; width: var(--ctl-h); height: var(--ctl-h); min-width: 0; margin: 0; padding: 0;',
    '  cursor: pointer; font-size: var(--fs); background: transparent; color: var(--text-muted); border: 0;',
    '  border-radius: var(--radius-sm); }',
    '#ycIconPicker .yip-tools { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;',
    '  padding: 10px 16px 6px; min-width: 0; }',
    '#ycIconPicker .yip-q { flex: 1 1 200px; width: auto; min-width: 0; height: var(--ctl-h); margin: 0; padding: 0 10px;',
    '  box-sizing: border-box; font-size: var(--fs); background: var(--surface); color: var(--text);',
    '  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }',
    '#ycIconPicker .yip-q:focus { border-color: var(--accent); outline: 2px solid var(--accent-soft); }',
    '#ycIconPicker .yip-chips { flex: 0 1 auto; display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }',
    '#ycIconPicker .yip-chip { height: var(--ctl-h); min-width: 0; margin: 0; padding: 0 12px; cursor: pointer;',
    '  font-size: var(--fs-sm); background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);',
    '  border-radius: 999px; }',
    '#ycIconPicker .yip-chip[aria-checked="true"] { background: var(--accent-soft); color: var(--accent-on-soft);',
    '  border-color: var(--accent); font-weight: 600; }',
    '#ycIconPicker .yip-cur { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0;',
    '  padding: 0 16px 6px; font-size: var(--fs-sm); color: var(--text-muted); }',
    '#ycIconPicker .yip-cur i { flex: 0 0 auto; width: 1.4em; text-align: center; font-size: var(--fs-lg); color: var(--text); }',
    '#ycIconPicker .yip-cur span { min-width: 0; overflow-wrap: anywhere; }',
    '#ycIconPicker .yip-grid { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; display: grid;',
    '  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); grid-auto-rows: 52px; gap: 4px;',
    '  align-content: start; padding: 4px 16px 8px; border-top: 1px solid var(--border); }',
    '#ycIconPicker .yip-tile { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;',
    '  min-width: 0; margin: 0; padding: 0; cursor: pointer; font-size: 20px; background: transparent; color: var(--text);',
    '  border: 1px solid transparent; border-radius: var(--radius-sm); }',
    '#ycIconPicker .yip-tile:hover { background: var(--hover); }',
    '#ycIconPicker .yip-tile.is-current { background: var(--accent-soft); color: var(--accent-on-soft); border-color: var(--accent); }',
    '#ycIconPicker .yip-tile:focus { outline: 2px solid var(--accent); outline-offset: -2px; }',
    '#ycIconPicker .yip-x:hover, #ycIconPicker .yip-x:focus-visible, #ycIconPicker .yip-chip:hover,',
    '#ycIconPicker .yip-btn:hover { background: var(--hover); color: var(--text); }',
    '#ycIconPicker .yip-chip:focus-visible, #ycIconPicker .yip-btn:focus-visible, #ycIconPicker .yip-x:focus-visible {',
    '  outline: 2px solid var(--accent); outline-offset: -2px; }',
    '#ycIconPicker .yip-msg { flex: 0 0 auto; padding: 8px 16px; font-size: var(--fs-sm); color: var(--text-muted);',
    '  overflow-wrap: anywhere; }',
    '#ycIconPicker .yip-msg:empty { display: none; }',
    '#ycIconPicker .yip-foot { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;',
    '  padding: 8px 16px; border-top: 1px solid var(--border); }',
    '#ycIconPicker .yip-hover { flex: 1 1 160px; min-width: 0; font-size: var(--fs-sm); color: var(--text-muted);',
    '  overflow-wrap: anywhere; }',
    '#ycIconPicker .yip-btn { height: var(--ctl-h); min-width: 0; margin: 0; padding: 0 14px; cursor: pointer;',
    '  font-size: var(--fs-sm); background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);',
    '  border-radius: var(--radius-sm); }',
    '#ycIconPicker .yip-btn[hidden] { display: none; }',
    '@media (max-width: 768px) {',
    '  #ycIconPicker { padding: 0; }',
    '  #ycIconPicker .yip-box { width: 100%; height: 100%; max-width: none; max-height: none; border: 0; border-radius: 0;',
    '    padding-bottom: env(safe-area-inset-bottom); }',
    '  #ycIconPicker .yip-tools { padding: 8px 12px 6px; }',
    '  #ycIconPicker .yip-cur { padding: 0 12px 6px; }',
    '  #ycIconPicker .yip-grid { padding: 4px 12px 8px; grid-template-columns: repeat(auto-fill, minmax(46px, 1fr));',
    '    grid-auto-rows: 46px; }',
    '  #ycIconPicker .yip-msg, #ycIconPicker .yip-foot { padding-left: 12px; padding-right: 12px; }',
    '}',
  ].join('\n');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text) {
    var b = el('button', cls, text);
    b.type = 'button';
    return b;
  }

  function ensureDom() {
    if (D && D.root.isConnected) return D;
    if (!document.getElementById('ycIconPickerCss')) {
      var st = el('style');
      st.id = 'ycIconPickerCss';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var root = el('div');
    root.id = 'ycIconPicker';
    root.hidden = true;
    var back = el('div', 'yip-back');
    var box = el('div', 'yip-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'yipTitle');
    box.tabIndex = -1;                        // a click on bare card takes focus here, not <body>
    var head = el('div', 'yip-head');
    var h = el('h2', null, 'Choose an icon');
    h.id = 'yipTitle';
    var x = button('yip-x');
    x.setAttribute('aria-label', 'Close');
    x.setAttribute('data-yip', 'cancel');
    x.appendChild(el('i', 'fa-solid fa-xmark'));
    head.appendChild(h);
    head.appendChild(x);
    var tools = el('div', 'yip-tools');
    var q = el('input', 'yip-q');
    q.type = 'text';
    q.maxLength = Q_MAX;
    q.placeholder = 'Search icons (e.g. calendar, github)';
    q.setAttribute('aria-label', 'Search icons');
    q.setAttribute('autocomplete', 'off');
    q.setAttribute('spellcheck', 'false');
    var chips = el('div', 'yip-chips');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', 'Family');
    CHIPS.forEach(function (c) {
      var b = button('yip-chip', c[1]);
      b.setAttribute('role', 'radio');
      b.setAttribute('data-fam', c[0]);
      chips.appendChild(b);
    });
    tools.appendChild(q);
    tools.appendChild(chips);
    var cur = el('div', 'yip-cur');
    var grid = el('div', 'yip-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', 'Icons');
    var msg = el('div', 'yip-msg');
    msg.setAttribute('aria-live', 'polite');
    var foot = el('div', 'yip-foot');
    var hover = el('span', 'yip-hover');
    var none = button('yip-btn yip-none', 'No icon');
    none.setAttribute('data-yip', 'none');
    var cancel = button('yip-btn yip-cancel', 'Cancel');
    cancel.setAttribute('data-yip', 'cancel');
    foot.appendChild(hover);
    foot.appendChild(none);
    foot.appendChild(cancel);
    box.appendChild(head);
    box.appendChild(tools);
    box.appendChild(cur);
    box.appendChild(grid);
    box.appendChild(msg);
    box.appendChild(foot);
    root.appendChild(back);
    root.appendChild(box);
    document.body.appendChild(root);

    root.addEventListener('keydown', onKey);
    root.addEventListener('click', onClick);
    root.addEventListener('mouseover', onHover);
    root.addEventListener('focusin', onHover);
    q.addEventListener('input', function () { if (S) { S.query = q.value; refilter(); } });
    grid.addEventListener('scroll', function () { if (S && nearEnd()) renderMore(); });
    // a press that starts AND ends on the backdrop cancels (not a selection dragged out)
    var downOnBack = false;
    root.addEventListener('mousedown', function (e) {
      downOnBack = e.target === back;
      if (downOnBack) e.preventDefault();     // a press on the backdrop never blurs (focus would fall to <body>)
    });
    back.addEventListener('click', function () { if (downOnBack) finish(null); });
    D = { root: root, box: box, title: h, q: q, chips: chips, cur: cur, grid: grid, msg: msg, hover: hover, none: none, x: x, cancel: cancel };
    return D;
  }

  // ── the session ──────────────────────────────────────────────────────
  function open(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    if (S) finish(null);                     // a second open cancels the first
    ensureDom();
    var value = typeof opts.value === 'string' ? opts.value : '';
    var resolve;
    var p = new Promise(function (r) { resolve = r; });
    S = {
      resolve: resolve, value: value, from: opts.from || null, allowEmpty: opts.allowEmpty === true,
      query: '', family: '', list: [], shown: 0, act: -1,
    };
    D.title.textContent = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim().slice(0, 80) : 'Choose an icon';
    D.q.value = '';
    D.none.hidden = !S.allowEmpty;
    delete D.hover.dataset.hovering;
    D.hover.textContent = '';
    setChips();
    drawCurrent();
    D.grid.textContent = '';
    D.root.hidden = false;
    document.addEventListener('keydown', onGuardKey, true);
    D.q.focus();
    if (TILES) refilter(true);
    else {
      setMsg('Loading icons…');
      var mine = S;
      loadCatalog().then(function () {
        if (S === mine) { setMsg(''); refilter(true); }
      }, function () {
        if (S !== mine) return;
        D.msg.textContent = 'The icon list could not be loaded. ';
        var retry = button('yip-btn', 'Try again');
        retry.setAttribute('data-yip', 'retry');
        D.msg.appendChild(retry);
      });
    }
    return p;
  }

  function finish(result) {
    if (!S) return;
    var s = S;
    S = null;
    document.removeEventListener('keydown', onGuardKey, true);
    D.root.hidden = true;
    D.grid.textContent = '';
    try {
      if (s.from && s.from.isConnected && typeof s.from.focus === 'function') s.from.focus();
    } catch (_) { /* a frame gone away */ }
    s.resolve(result);
  }

  function setMsg(t) { D.msg.textContent = t; }

  function setChips() {
    var b = D.chips.querySelectorAll('.yip-chip');
    for (var i = 0; i < b.length; i++) {
      var on = b[i].getAttribute('data-fam') === S.family;
      b[i].setAttribute('aria-checked', on ? 'true' : 'false');
      b[i].tabIndex = on ? 0 : -1;
    }
  }

  function describe(family, name) { return name + ' · ' + FAM_LABEL[family]; }

  function drawCurrent() {
    D.cur.textContent = '';
    var p = I().parse(S.value);
    if (!S.value) { D.cur.appendChild(el('span', null, 'Current: no icon')); return; }
    D.cur.appendChild(el('span', null, 'Current:'));
    D.cur.appendChild(el('i', I().cls(S.value)));
    D.cur.appendChild(el('span', null, p ? describe(p.family, p.name) : 'not a valid icon name'));
  }

  /** Re-runs the search. first: the dialog just opened — the current value's
   *  tile is the active one (drawn, and scrolled to). */
  function refilter(first) {
    S.list = filter(TILES, S.query, S.family);
    delete D.hover.dataset.hovering;           // the footer shows the count again
    S.shown = 0;
    S.act = -1;
    D.grid.textContent = '';
    var at = -1;
    if (first && S.value) {
      for (var i = 0; i < S.list.length; i++) if (I().same(S.list[i].value, S.value)) { at = i; break; }
    }
    renderUpTo(Math.max(at, 0));
    if (S.list.length) setActive(at >= 0 ? at : 0, false);
    if (first && at < 0 && S.value && I().valid(S.value)) {
      D.cur.lastChild.textContent += ' (not in the list)';
    }
    setMsg(S.list.length ? '' : (S.query.trim() ? 'No icons match “' + S.query.trim().slice(0, Q_MAX) + '”.' : 'No icons.'));
    countLine();
    if (at >= 0) scrollTo(at, 'center');
  }

  function countLine() {
    var n = S.list.length;
    if (!D.hover.dataset.hovering) D.hover.textContent = n === 1 ? '1 icon' : n.toLocaleString('en-US') + ' icons';
  }

  function tileEl(t, i) {
    var b = button('yip-tile');
    b.setAttribute('role', 'option');
    b.setAttribute('data-i', String(i));
    b.setAttribute('data-v', t.value);
    b.setAttribute('title', t.name + ' (' + FAM_LABEL[t.family] + ')');
    b.setAttribute('aria-label', t.name + ', ' + FAM_LABEL[t.family]);
    var cur = !!S.value && I().same(t.value, S.value);
    b.setAttribute('aria-selected', cur ? 'true' : 'false');
    if (cur) b.classList.add('is-current');
    b.tabIndex = -1;
    b.appendChild(el('i', I().cls(t.value)));
    return b;
  }

  function renderMore() {
    if (!S || S.shown >= S.list.length) return;
    var frag = document.createDocumentFragment();
    var end = Math.min(S.list.length, S.shown + CHUNK);
    for (var i = S.shown; i < end; i++) frag.appendChild(tileEl(S.list[i], i));
    D.grid.appendChild(frag);
    S.shown = end;
    // a tall grid on a big screen: keep going until it can scroll (needs layout)
    if (D.grid.clientHeight > 0 && D.grid.scrollHeight <= D.grid.clientHeight && S.shown < S.list.length) renderMore();
  }
  function renderUpTo(i) {
    while (S.shown <= i && S.shown < S.list.length) renderMore();
  }
  function nearEnd() {
    var g = D.grid;
    return g.scrollTop + g.clientHeight >= g.scrollHeight - 200;
  }
  function tileAt(i) { return D.grid.querySelector('.yip-tile[data-i="' + i + '"]'); }
  function scrollTo(i, block) {
    var t = tileAt(i);
    if (t && typeof t.scrollIntoView === 'function') t.scrollIntoView({ block: block || 'nearest' });
  }

  /** The roving tab stop: only the active tile is tabbable. */
  function setActive(i, focus) {
    if (!S.list.length) { S.act = -1; return; }
    i = Math.max(0, Math.min(S.list.length - 1, i));
    renderUpTo(i);
    var old = S.act >= 0 ? tileAt(S.act) : null;
    if (old) old.tabIndex = -1;
    S.act = i;
    var t = tileAt(i);
    if (!t) return;
    t.tabIndex = 0;
    if (focus) { t.focus(); scrollTo(i); }
  }

  function cols() {
    var tiles = D.grid.querySelectorAll('.yip-tile');
    if (!tiles.length || !tiles[0].offsetWidth) return COLS_FALLBACK;
    var top = tiles[0].offsetTop, n = 0;
    while (n < tiles.length && tiles[n].offsetTop === top) n++;
    return Math.max(1, n);
  }

  function pick(i) {
    var t = S && S.list[i];
    if (t) finish(t.value);
  }

  function focusables() {
    var list = [D.x, D.q];
    var chip = D.chips.querySelector('.yip-chip[tabindex="0"]');
    if (chip) list.push(chip);
    var t = S && S.act >= 0 ? tileAt(S.act) : null;
    if (t) list.push(t);
    if (!D.none.hidden) list.push(D.none);
    list.push(D.cancel);
    var retry = D.msg.querySelector('button');
    if (retry) list.splice(list.indexOf(D.cancel), 0, retry);
    return list;
  }

  // ── events ───────────────────────────────────────────────────────────
  /** The document's capture-phase guard, present only while a session is
   *  open: a key aimed OUTSIDE the dialog (focus on <body> or anywhere behind
   *  it) never reaches the page — Esc cancels, any other key puts focus back
   *  in the search box. Keys inside the dialog go on to onKey. */
  function onGuardKey(e) {
    if (D.root.contains(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(null); return; }
    if (e.key === 'Tab') e.preventDefault();
    D.q.focus();
  }

  function onKey(e) {
    // modal: nothing behind the dialog hears a key while it is open
    e.stopPropagation();
    if (!S) return;
    var k = e.key, t = e.target;
    if (k === 'Escape') { e.preventDefault(); finish(null); return; }
    if (k === 'Tab') {
      var f = focusables(), at = f.indexOf(document.activeElement);
      e.preventDefault();
      var next = at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + f.length) % f.length;
      f[next].focus();
      return;
    }
    if (t === D.q) {
      if (k === 'ArrowDown' && S.list.length) { e.preventDefault(); setActive(Math.max(S.act, 0), true); }
      else if (k === 'Enter') { e.preventDefault(); if (S.act >= 0) pick(S.act); }
      return;
    }
    if (t && t.classList && t.classList.contains('yip-chip')) {
      if (k === 'ArrowRight' || k === 'ArrowLeft') {
        e.preventDefault();
        var cs = Array.prototype.slice.call(D.chips.querySelectorAll('.yip-chip'));
        var j = (cs.indexOf(t) + (k === 'ArrowRight' ? 1 : -1) + cs.length) % cs.length;
        chooseFamily(cs[j].getAttribute('data-fam'));
        cs[j].focus();
      }
      return;
    }
    if (t && t.classList && t.classList.contains('yip-tile')) {
      var i = Number(t.getAttribute('data-i')), c = cols(), n = S.list.length;
      var to = null;
      if (k === 'ArrowRight') to = i + 1;
      else if (k === 'ArrowLeft') to = i - 1;
      else if (k === 'ArrowDown') to = i + c;
      else if (k === 'ArrowUp') { if (i - c < 0) { e.preventDefault(); D.q.focus(); return; } to = i - c; }
      else if (k === 'Home') to = 0;
      else if (k === 'End') to = n - 1;
      else if (k === 'PageDown') to = i + c * 4;
      else if (k === 'PageUp') to = i - c * 4;
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(i); return; }
      if (to !== null) { e.preventDefault(); setActive(Math.max(0, Math.min(n - 1, to)), true); }
    }
  }

  function chooseFamily(fam) {
    if (!S || S.family === fam) return;
    S.family = fam;
    setChips();
    if (TILES) refilter(false);
  }

  function onClick(e) {
    if (!S) return;
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !D.root.contains(t)) return;
    if (t.classList.contains('yip-tile')) { pick(Number(t.getAttribute('data-i'))); return; }
    if (t.classList.contains('yip-chip')) { chooseFamily(t.getAttribute('data-fam')); return; }
    var act = t.getAttribute('data-yip');
    if (act === 'cancel') finish(null);
    else if (act === 'none' && S.allowEmpty) finish('');
    else if (act === 'retry') {
      D.q.focus();                           // before the button it is on goes away
      setMsg('Loading icons…');
      var mine = S;
      loadCatalog().then(function () { if (S === mine) { setMsg(''); refilter(true); } },
        function () { if (S === mine) setMsg('The icon list could not be loaded. Close this and try again later.'); });
    }
  }

  function onHover(e) {
    if (!S) return;
    var t = e.target.closest ? e.target.closest('.yip-tile') : null;
    if (!t) return;
    var tile = S.list[Number(t.getAttribute('data-i'))];
    if (!tile) return;
    D.hover.dataset.hovering = '1';
    D.hover.textContent = describe(tile.family, tile.name);
  }

  window.ycIconPicker = Object.freeze({
    open: open,
    isOpen: function () { return !!S; },
    close: function () { finish(null); },
    CATALOG_URL: CATALOG_URL,
  });
})();
