/* public/js/ycAll.js — the All tab and the Ctrl-K / ⌘K command palette
 * (ui-custom S2).
 *
 * Two views over ONE list, ycLauncher.effectiveRegistry() — every launcher
 * item this user has (admin-gated and entitlement-denied items already out),
 * in All order — and ONE way to act on an entry, ycLauncher.exec(id), which
 * clicks the item's real launcher element. Neither view re-implements what a
 * launcher button does, and neither draws a copy of one: the entries here are
 * neutral buttons carrying data-yc-item, NEVER data-target /
 * data-exclusive-group (the drill-in machinery in index.html queries those
 * page-wide, and a second node per panel would corrupt it).
 *
 *   All tab   #tabAll in index.html. Grouped by origin (ycLauncher.groups()
 *             order); a search box above it ranks with the palette's matcher
 *             (ycLauncher.rank) — the phone's way in. Enter runs the top hit.
 *   Palette   Ctrl-K / ⌘K from anywhere once signed in, focused inputs and
 *             same-origin pane iframes included — except an editor that binds
 *             Ctrl-K itself (Quill's insert-link). Arrows + Enter run, Esc (or
 *             a click outside) closes and gives focus back. Stands down while a
 *             SweetAlert dialog (not a toast) is open, while the "Customize my
 *             launcher" editor is open (ycLayoutEditor.js), and before login.
 *
 *   Shortcuts the user's own keyboard shortcuts (ui-custom S4c): ui_config
 *             user `shortcuts`, { bindings: [ { combo: { ctrl, meta, alt,
 *             shift, key }, id } ] }, read from firmData.ui.user.shortcuts.
 *             ONE keydown dispatcher serves them and the palette (onKey below),
 *             with the palette's rules: it defers to e.defaultPrevented, stands
 *             down while a SweetAlert dialog or the layout editor is open, and
 *             before login; it hears same-origin pane iframes too. It also
 *             stands down while AltGr is held (getModifierState('AltGraph'):
 *             a character is being typed, not a shortcut) and during IME
 *             composition (isComposing, key "Process"). A matched binding is
 *             preventDefault-ed and runs ycLauncher.exec(id) — only when the
 *             id is in this user's effective registry right now: a binding to
 *             anything else (denied, firm-hidden, role-restricted, unknown)
 *             does nothing at all, silently, and the key goes through
 *             untouched (the page / browser keeps it). The palette's rows show
 *             the combos bound to them (platform form: ⌃⌘T on a Mac,
 *             Ctrl+Alt+T elsewhere). The editor is the "Keyboard shortcuts" tab
 *             of "Customize my launcher" (ycLayoutEditor.js), which uses the
 *             pure helpers exported here as ycAll.keys.
 *
 *             Matching (keyOf): a combo's key is the validator's grammar
 *             (lib/uiConfigShape.js — a letter lower-case, a digit, another
 *             printable character, or a NAMED_KEYS name), read from the event:
 *               space    " " (or e.code Space) → Space
 *               ascii    e.key when it is ONE printable ASCII character —
 *                        letter (lower-cased), digit or punctuation — exactly
 *                        as typed: AZERTY's and Dvorak's keycaps, and Dvorak's
 *                        "." on the physical E key stays "." (never "e").
 *                        Shift+1 is therefore "!" (with shift).
 *               named    e.key in NAMED_KEYS
 *               code     only when e.key is NOT printable ASCII: e.code
 *                        KeyA–KeyZ → the letter, Digit0–9 → the digit
 *                        (Option on a Mac types å, Cyrillic layouts ф, AltGr €)
 *               other    any other single printable e.key, lower-cased
 *             The four modifiers must match exactly: ⌃⌘T never fires on ⌃⌘⇧T.
 *             Holding a bound combo down runs it once (auto-repeat is
 *             swallowed). The lookup map is rebuilt only when the bindings
 *             change (checked on every 'ycLauncherAccess').
 *
 * Re-renders on the 'ycLauncherAccess' window event, which
 * ycLauncher.applyAccess() fires after login, when the custom tab changes and
 * after an editor save.
 * Styles: the #tabAll / #ycPalette block in index.html (theme.css tokens).
 */
(function () {
  'use strict';

  // ── Shortcut keys: pure helpers (no DOM) — also ycAll.keys ───────────
  var NAMED_KEYS = [                                   // lib/uiConfigShape.js NAMED_KEYS
    'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ];
  var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  var MODS = ['ctrl', 'meta', 'alt', 'shift'];

  function platformOf(nav) {
    nav = nav || (typeof navigator !== 'undefined' ? navigator : {});
    return String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '');
  }
  function isMac(nav) { return /mac|iphone|ipad|ipod/i.test(platformOf(nav)); }
  function isWindows(nav) { return /win/i.test(platformOf(nav)); }

  /** The validator-grammar key a keydown names, or null (a bare modifier,
   *  a dead key, …). See "Matching" above. */
  function keyOf(e) {
    var k = e && typeof e.key === 'string' ? e.key : '';
    var code = e && typeof e.code === 'string' ? e.code : '';
    var m;
    if (k === ' ' || k === 'Spacebar' || code === 'Space') return 'Space';
    if (/^[\x21-\x7e]$/.test(k)) return k.toLowerCase();       // one printable ASCII character: as typed
    if (NAMED_KEYS.indexOf(k) >= 0) return k;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    var chars = Array.from(k);
    if (chars.length === 1 && !/\s/.test(k) && !CONTROL_RE.test(k)) return k.toLowerCase();
    return null;
  }
  /** { ctrl, meta, alt, shift, key } for a keydown, or null. */
  function comboOf(e) {
    var key = keyOf(e);
    if (key == null) return null;
    return { ctrl: !!e.ctrlKey, meta: !!e.metaKey, alt: !!e.altKey, shift: !!e.shiftKey, key: key };
  }
  function sig(c) { return [c.ctrl, c.meta, c.alt, c.shift, c.key].join('|'); }
  /** A stored combo re-validated by the server's grammar (normalized), or null. */
  function cleanCombo(cb) {
    if (!cb || typeof cb !== 'object') return null;
    for (var i = 0; i < MODS.length; i++) if (typeof cb[MODS[i]] !== 'boolean') return null;
    var k = cb.key;
    if (typeof k !== 'string') return null;
    if (NAMED_KEYS.indexOf(k) < 0) {
      if (Array.from(k).length !== 1 || /\s/.test(k) || CONTROL_RE.test(k)) return null;
      k = k.toLowerCase();
    }
    return { ctrl: cb.ctrl, meta: cb.meta, alt: cb.alt, shift: cb.shift, key: k };
  }
  /** The server's combo rules (lib/uiConfigShape.js comboProblem, same
   *  wording; tests/launcherS4c.test.js runs both over one matrix). */
  function comboProblem(c) {
    if (!c.ctrl && !c.meta && !c.alt) return 'needs ctrl, meta or alt (shift alone, or no modifier, would fire while typing)';
    if (c.key === 'k' && c.ctrl !== c.meta && !c.alt) return 'is the command palette\'s own (Ctrl-K / Cmd-K)';
    return null;
  }
  /** The palette's own combo: Ctrl-K, or ⌘K — exactly one of the two, no
   *  Alt, no Shift. (⌃⌘K and the Alt / Shift variants are not the palette.) */
  function isPaletteCombo(c) { return !!c && c.key === 'k' && c.ctrl !== c.meta && !c.alt && !c.shift; }

  var KEY_TEXT = {
    mac: { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↩', Escape: 'Esc', Tab: '⇥',
      Backspace: '⌫', Delete: '⌦', PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins' },
    other: { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc',
      PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins' },
  };
  function keyText(k, mac) {
    var t = KEY_TEXT[mac ? 'mac' : 'other'];
    if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
    return k.length === 1 ? k.toUpperCase() : k;
  }
  /** A combo the way this platform writes one: ⌃⌥⇧⌘T on a Mac (Apple's
   *  order), Ctrl+Alt+Shift+Win+T elsewhere (Meta off Windows). mac / win
   *  default to this browser's platform. */
  function format(c, mac, win) {
    if (mac == null) mac = isMac();
    if (win == null) win = isWindows();
    var k = keyText(c.key, mac);
    if (mac) return (c.ctrl ? '⌃' : '') + (c.alt ? '⌥' : '') + (c.shift ? '⇧' : '') + (c.meta ? '⌘' : '') + k;
    var parts = [];
    if (c.ctrl) parts.push('Ctrl');
    if (c.alt) parts.push('Alt');
    if (c.shift) parts.push('Shift');
    if (c.meta) parts.push(win ? 'Win' : 'Meta');
    parts.push(k);
    return parts.join('+');
  }

  var KEYS = {
    NAMED_KEYS: NAMED_KEYS, keyOf: keyOf, comboOf: comboOf, sig: sig, cleanCombo: cleanCombo,
    comboProblem: comboProblem, isPaletteCombo: isPaletteCombo, format: format, isMac: isMac, isWindows: isWindows,
  };
  if (typeof document === 'undefined') { window.ycAll = { keys: KEYS }; return; }

  var L = window.ycLauncher;
  if (!L) { console.error('[ycAll] ycLauncher missing — load order'); window.ycAll = { keys: KEYS }; return; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function iconHtml(e) { return '<i class="fa-solid fa-' + esc(e.icon) + '"></i>'; }

  // ── All tab ──────────────────────────────────────────────────────────
  function allItem(e) {
    return '<button type="button" class="yc-all-item" data-yc-item="' + esc(e.id) + '" title="' + esc(e.label) + '">' +
      iconHtml(e) + '<span>' + esc(e.label) + '</span></button>';
  }

  function renderAll() {
    var list = document.getElementById('ycAllList');
    if (!list) return;
    var input = document.getElementById('ycAllSearch');
    var q = input ? input.value : '';
    var eff = L.effectiveRegistry();
    if (q.replace(/\s+/g, '')) {
      var hits = L.rank(q, eff);
      list.innerHTML = hits.length
        ? '<div class="yc-all-items">' + hits.map(allItem).join('') + '</div>'
        : '<div class="yc-all-empty">Nothing matches “' + esc(q.trim()) + '”.</div>';
      return;
    }
    list.innerHTML = L.groups().map(function (g) {
      var items = eff.filter(function (e) { return e.group === g; });
      return items.length
        ? '<section class="yc-all-group"><h2>' + esc(g) + '</h2><div class="yc-all-items">' + items.map(allItem).join('') + '</div></section>'
        : '';
    }).join('');
  }

  function wireAll() {
    var list = document.getElementById('ycAllList');
    var input = document.getElementById('ycAllSearch');
    if (list) list.addEventListener('click', function (e) {
      var b = e.target.closest('.yc-all-item');
      if (b) L.exec(b.getAttribute('data-yc-item'));
    });
    if (input) {
      input.addEventListener('input', renderAll);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var first = input.value.replace(/\s+/g, '') && list && list.querySelector('.yc-all-item');
          if (first) { e.preventDefault(); L.exec(first.getAttribute('data-yc-item')); }
        } else if (e.key === 'Escape' && input.value) {
          input.value = ''; renderAll();
        }
      });
    }
  }

  // ── Palette ──────────────────────────────────────────────────────────
  var pal = null, input = null, listEl = null, hits = [], active = 0, restoreTo = null;

  function buildPalette() {
    if (pal) return;
    pal = document.createElement('div');
    pal.id = 'ycPalette';
    pal.hidden = true;
    pal.innerHTML =
      '<div class="yc-pal" role="dialog" aria-modal="true" aria-label="Go to a feature">' +
        '<input class="yc-pal-input" type="text" placeholder="Go to…" autocomplete="off" spellcheck="false"' +
          ' role="combobox" aria-expanded="true" aria-controls="ycPalList" aria-autocomplete="list">' +
        '<div class="yc-pal-list" id="ycPalList" role="listbox"></div>' +
        '<div class="yc-pal-foot">↑ ↓ to choose · Enter to open · Esc to close</div>' +
      '</div>';
    document.body.appendChild(pal);
    input = pal.querySelector('.yc-pal-input');
    listEl = pal.querySelector('.yc-pal-list');

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e) {
      var n = hits.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) setActive((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      } else if (e.key === 'Enter') {
        e.preventDefault(); run(active);
      } else if (e.key === 'Escape') {
        e.preventDefault(); closePalette(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();   // the palette is modal: focus stays in its input
      } else {
        return;
      }
      e.stopPropagation();
    });
    // A click on the backdrop (outside the box) closes.
    pal.addEventListener('mousedown', function (e) { if (e.target === pal) closePalette(true); });
    // Keep focus in the input while choosing with the pointer.
    listEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
    listEl.addEventListener('mousemove', function (e) {
      var b = e.target.closest('.yc-pal-item');
      if (b && Number(b.getAttribute('data-i')) !== active) setActive(Number(b.getAttribute('data-i')));
    });
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('.yc-pal-item');
      if (b) run(Number(b.getAttribute('data-i')));
    });
  }

  function refresh() {
    hits = L.rank(input.value, L.effectiveRegistry());
    active = 0;
    listEl.innerHTML = hits.length
      ? hits.map(function (e, i) {
          return '<button type="button" class="yc-pal-item" role="option" id="ycPalOpt' + i + '" data-i="' + i + '" tabindex="-1">' +
            iconHtml(e) + '<span>' + esc(e.label) + '</span>' + combosHtml(e.id) +
            '<span class="yc-pal-group">' + esc(e.group) + '</span></button>';
        }).join('')
      : '<div class="yc-pal-empty">No match</div>';
    setActive(0);
  }

  // The combos bound to an item, as <kbd>s (none: nothing).
  function combosHtml(id) {
    var list = combosFor(id);
    return list.length ? '<span class="yc-pal-keys">' + list.map(function (t) { return '<kbd>' + esc(t) + '</kbd>'; }).join('') + '</span>' : '';
  }

  function setActive(i) {
    active = i;
    var items = listEl.querySelectorAll('.yc-pal-item');
    for (var k = 0; k < items.length; k++) {
      items[k].classList.toggle('active', k === i);
      items[k].setAttribute('aria-selected', k === i ? 'true' : 'false');
    }
    var cur = items[i];
    if (cur) {
      input.setAttribute('aria-activedescendant', cur.id);
      // Scroll the list only (scrollIntoView would also scroll the page).
      if (cur.offsetTop < listEl.scrollTop) listEl.scrollTop = cur.offsetTop;
      else if (cur.offsetTop + cur.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
        listEl.scrollTop = cur.offsetTop + cur.offsetHeight - listEl.clientHeight;
      }
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function run(i) {
    var e = hits[i];
    if (!e) return;
    closePalette(false);   // the item takes focus from here (a tab, a dialog)
    L.exec(e.id);
  }

  function isOpen() { return !!(pal && !pal.hidden); }

  /** Open the palette. srcDoc: the document the shortcut came from (a pane
   *  iframe's, or this one) — whose focused element Esc gives focus back to. */
  function openPalette(srcDoc) {
    if (!L.isReady()) return false;
    buildPalette();
    if (isOpen()) return true;
    restoreTo = {
      el: document.activeElement,
      inner: srcDoc && srcDoc !== document ? srcDoc.activeElement : null,
    };
    input.value = '';
    refresh();
    pal.hidden = false;
    input.focus();
    return true;
  }

  function closePalette(restore) {
    if (!isOpen()) return;
    pal.hidden = true;
    var r = restoreTo;
    restoreTo = null;
    if (!restore || !r) return;
    try {
      if (r.el && r.el.focus) r.el.focus();
      if (r.inner && r.inner.focus) r.inner.focus();
    } catch (_) { /* the element went away */ }
  }

  // ── The shortcut ─────────────────────────────────────────────────────
  // A modal SweetAlert is up. A toast (window.Toast is a Swal mixin, and
  // Swal.isVisible() is true for one) is not a dialog and does not count.
  function swalOpen(w) {
    try {
      if (!(w && w.Swal && w.Swal.isVisible && w.Swal.isVisible())) return false;
      var p = w.Swal.getPopup && w.Swal.getPopup();
      return !(p && p.classList.contains('swal2-toast'));
    } catch (_) { return false; }
  }

  // ── The user's shortcuts: the lookup map ─────────────────────────────
  // sig(combo) → id, and id → [combo…] for the palette's rows. Built from
  // firmData.ui.user.shortcuts, each binding re-checked by the server's
  // grammar and combo rules (a bad one is skipped, never fires); the first of
  // two equal combos wins. Rebuilt only when the bindings change.
  var SC = { key: null, map: Object.create(null), byId: Object.create(null), version: 0 };
  function storedBindings() {
    try {
      var u = window.firmData && window.firmData.ui && window.firmData.ui.user;
      var s = u && u.shortcuts;
      return s && Array.isArray(s.bindings) ? s.bindings : [];
    } catch (_) { return []; }
  }
  function loadShortcuts() {
    var clean = [];
    storedBindings().forEach(function (b) {
      if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id) return;
      var c = cleanCombo(b.combo);
      if (c && !comboProblem(c)) clean.push({ combo: c, id: b.id });
    });
    var key = clean.map(function (b) { return sig(b.combo) + '>' + b.id; }).join('\n');
    if (key === SC.key) return false;
    var map = Object.create(null), byId = Object.create(null);
    clean.forEach(function (b) {
      var s = sig(b.combo);
      if (s in map) return;
      map[s] = b.id;
      (byId[b.id] = byId[b.id] || []).push(b.combo);
    });
    SC = { key: key, map: map, byId: byId, version: SC.version + 1 };
    return true;
  }
  function combosFor(id) {
    return (SC.byId[id] || []).map(function (c) { return format(c); });
  }
  function isEffective(id) {
    var eff = L.effectiveRegistry();
    for (var i = 0; i < eff.length; i++) if (eff[i].id === id) return true;
    return false;
  }

  // ONE dispatcher for the palette and the user's shortcuts.
  function onKey(e) {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) return;   // the palette and every binding hold one
    if (e.isComposing || e.key === 'Process') return;      // an IME is composing: not a shortcut
    // AltGr (reported as Ctrl+Alt on Windows) types a character: never ours
    if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return;
    // An editor that owns the combo handled it first: Quill's snow theme binds
    // Ctrl-K to "insert link" (the Campaigns and communicate.html composers).
    if (e.defaultPrevented) return;
    var c = comboOf(e);
    if (!c) return;                                       // a bare modifier press
    var palette = isPaletteCombo(c);
    var id = palette ? null : SC.map[sig(c)];
    if (!palette && id == null) return;                   // not ours: the browser / page keeps it
    if (!L.isReady()) return;   // before login: not ours (the browser keeps its own Ctrl-K)
    // The layout editor (ycLayoutEditor.js, S4b) is modal: an item run from
    // the palette would open behind it, and the next Esc would go to it. Its
    // shortcut capture box reads keys too.
    if (window.ycLayoutEditor && typeof window.ycLayoutEditor.isOpen === 'function' && window.ycLayoutEditor.isOpen()) return;
    var doc = (e.target && e.target.ownerDocument) || (e.target && e.target.nodeType === 9 ? e.target : document);
    if (swalOpen(window) || swalOpen(doc.defaultView)) return;
    // not available to this user now: nothing at all — the key goes through
    if (!palette && !isEffective(id)) return;
    e.preventDefault();
    e.stopPropagation();
    if (palette) {
      if (isOpen()) closePalette(true);
      else openPalette(doc);
      return;
    }
    if (e.repeat) return;                                 // held down: once
    if (isOpen()) closePalette(false);
    L.exec(id);
  }

  // Bubble phase, so an editor's own Ctrl-K binding wins (it calls
  // preventDefault; onKey then stands aside) while a plain focused input,
  // which has none, still opens the palette. Same-origin pane iframes (and
  // their nested frames) get the same listener as they load: a key pressed
  // inside a frame never reaches this document. Cross-origin frames throw on
  // contentDocument and are skipped.
  function hookDoc(doc) {
    try {
      if (!doc || doc.__ycAllHooked) return;
      doc.__ycAllHooked = true;
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('load', onLoad, true);   // iframe load doesn't bubble; capture sees it
      var frames = doc.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) hookFrame(frames[i]);
    } catch (_) { /* cross-origin */ }
  }
  function hookFrame(f) {
    try { hookDoc(f.contentDocument); } catch (_) { /* cross-origin */ }
  }
  function onLoad(e) {
    if (e.target && e.target.tagName === 'IFRAME') hookFrame(e.target);
  }

  hookDoc(document);
  wireAll();
  window.addEventListener('ycLauncherAccess', function () {
    loadShortcuts();
    renderAll();
    if (isOpen()) refresh();
  });
  if (L.isReady()) { loadShortcuts(); renderAll(); }

  window.ycAll = {
    render: renderAll, open: openPalette, close: closePalette, isOpen: isOpen, keys: KEYS,
    /** The bound id for a combo, or null; the formatted combos bound to an id. */
    lookup: function (c) { var id = c && SC.map[sig(c)]; return id == null ? null : id; },
    combosFor: combosFor,
    /** Bumps each time the lookup map is rebuilt. */
    shortcutsVersion: function () { return SC.version; },
  };
})();
