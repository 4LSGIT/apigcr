/* public/js/ycLayoutEditor.js — "Customize my launcher": each user's own Home
 * and sidebar layout editor (ui-custom S4b).
 *
 * Opened from the All tab's "Customize my launcher" button (#ycAllCustomize):
 * All is mandatory chrome, so the way to undo a layout is always there (PLAN
 * §4.3). A full-screen panel over the shell (#ycLayoutEditor, z-index 1045:
 * above the tool dialog (1040), below the Ctrl-K palette (1050) and
 * SweetAlert2 (1060), whose confirms it uses) — a card on a desktop, the whole
 * screen on a phone. Modal: Cancel, the close button, Esc and a click on the
 * backdrop are the ways out, and each asks first when there are unsaved
 * changes; so does a reload while it is open (beforeunload).
 *
 * What it edits: the user's ui_config `layout` document (scope user; grammar:
 * lib/uiConfigShape.js), as the S4a contract has it —
 *   { placed: { home?: [entry…], sidebar?: [entry…] },
 *     removed: { home?: [id…], sidebar?: [id…] } }
 * It never merges anything itself. Every list it shows is
 * ycLauncher.resolveLayout(surface, { base: DEFAULT_LAYOUTS[surface], user,
 * effective, locked }) over the surface's working state — the ONE merge the
 * renderer uses too — so what it shows is what Save will render.
 *
 * The rules it writes by (S4a review):
 *   - An edited surface is written as its FULL visible list: a partial
 *     placed list would pull base items back next to their neighbours.
 *   - Hiding a DEFAULT item (one in that surface's base layout) adds its id to
 *     removed[surface] and leaves it out of placed; a firm-locked one cannot
 *     be hidden (the resolver ignores the removal anyway). An item the user
 *     added, a break and a label are REMOVED: dropped from placed only.
 *   - Re-showing a hidden item (or adding it from the picker) drops it from
 *     removed. Nothing else ever drops a removed id: one the editor cannot
 *     show (not in this user's effective registry right now) is kept.
 *   - A placed item that is not effective right now (a firm item the firm
 *     hid for a while, a denied feature) is not shown, and is KEPT: an edit
 *     carries it into the new list after the visible item it followed.
 *   - Reset deletes BOTH placed[surface] and removed[surface] — that surface
 *     follows the default again; [] would not clear it.
 *   - A surface the user did not edit (or edited back to what it was) is
 *     written exactly as stored.
 * Dirty = the document Save would write differs from the stored one,
 * compared key-order-insensitively (MySQL JSON re-orders object keys).
 *
 * Open: GET /api/ui-config first — the editor starts from the layers as they
 * are now, not from this tab's login-time firmData.ui (which it refreshes,
 * re-running the launcher, when they differ); a failed read opens nothing and
 * says so beside the button.
 * Save: PUT /api/ui-config { scope:'user', config_key:'layout', config } →
 * firmData.ui.user.layout := the stored document from the response →
 * ycLauncher.applyAccess({ ui }), so this user's launcher changes at once
 * (no reload), then the panel closes. While the PUT is out the panel takes no
 * edits. A refusal shows the server's errors[]
 * inside the panel (per surface where the path names one) and keeps it open.
 * No live preview: nothing changes on screen until Save.
 *
 * Everything shown is set as text (labels, renames, firm item labels); icons
 * only from a validated slug. Styles: the #ycLayoutEditor block in index.html
 * (theme.css tokens; id-scoped, so it outranks style.css's global input and
 * dark-theme button rules on specificity, never on load order).
 *
 * Keyboard shortcuts (ui-custom S4c): the panel's second tab. The user's
 * ui_config `shortcuts` document, { bindings: [ { combo, id } ] } — a combo
 * captured by pressing it in the "Keys" box, bound to an item picked from the
 * effective registry (the same picker as Home / sidebar, firm items
 * included). The editor refuses what the server refuses (comboProblem, from
 * ycAll.keys), the browser- and OS-reserved combos (reservedProblem below —
 * platform knowledge, so here and not in the server), and a combo already
 * bound (naming its item); it WARNS on Ctrl+Alt (AltGr on non-US Windows
 * layouts types characters with it). A binding whose item is not in this
 * user's effective registry now is listed as unavailable, kept, removable.
 * The tabs share one Save: each dirty document is its own PUT (layout, then
 * shortcuts); a failure in either keeps both sets of edits open, says which
 * failed, and what did save becomes the new stored state. After a save the
 * shell's firmData.ui.user is updated and applyAccess re-run once, which also
 * rebuilds ycAll's shortcut map (its 'ycLauncherAccess' listener).
 *
 * window.ycLayoutEditor = { open, close, isOpen, isDirty, session, shortcutSession, reservedProblem }
 *   session(o) is the editor's pure core (no DOM; the panel drives one):
 *   o = { stored, effective, locked, base, registry, groups } — see session().
 *   shortcutSession(o) is the Keyboard shortcuts tab's: see there.
 *   open({ section: 'shortcuts' }) opens on that tab (default: the layout).
 */
(function () {
  'use strict';
  var L = window.ycLauncher;
  if (!L || typeof L.resolveLayout !== 'function') {
    if (typeof console !== 'undefined') console.error('[ycLayoutEditor] ycLauncher missing — load order');
    return;
  }

  var SURFACES = ['home', 'sidebar'];
  var NAME = { home: 'Home', sidebar: 'Sidebar' };
  var CAP = 100;          // lib/uiConfigShape.js CAPS.placed / CAPS.removed
  var LABEL_MAX = 40;     // lib/uiConfigShape.js LABEL_MAX
  var ICON_RE = /^[a-z0-9-]{1,40}$/;
  var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(o) { return o !== null && typeof o === 'object' && Object.prototype.toString.call(o) === '[object Object]'; }
  function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }

  /** JSON with object keys sorted at every level — lib/uiConfigShape.js
   *  canonical(), line for line: "is it unchanged?" whatever order MySQL
   *  hands the keys back in. */
  function canonical(v) {
    if (isArr(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  /** A section label's problem (the server's label rule), or null. */
  function labelProblem(t) {
    if (typeof t !== 'string') return 'A label is text';
    var s = t.trim();
    if (!s) return 'Type a label';
    if (Array.from(s).length > LABEL_MAX) return 'At most ' + LABEL_MAX + ' characters';
    if (CONTROL_RE.test(s)) return 'Plain text only';
    return null;
  }

  // The stored document, with anything malformed left out (the resolver
  // ignores the same things) — always { placed: {…}, removed: {…} }.
  function copyEntry(e, sf) {
    if (!isObj(e)) return null;
    if (typeof e.item === 'string' && e.item) return { item: e.item };
    if (e.break === true && sf === 'home') return { break: true };
    if (typeof e.label === 'string' && sf === 'sidebar') return { label: e.label };
    return null;
  }
  function normalize(doc) {
    var out = { placed: {}, removed: {} };
    if (!isObj(doc)) return out;
    SURFACES.forEach(function (sf) {
      if (isObj(doc.placed) && isArr(doc.placed[sf])) {
        out.placed[sf] = doc.placed[sf].map(function (e) { return copyEntry(e, sf); }).filter(Boolean);
      }
      if (isObj(doc.removed) && isArr(doc.removed[sf])) {
        out.removed[sf] = doc.removed[sf].filter(function (id) { return typeof id === 'string'; });
      }
    });
    return out;
  }
  function entryOf(r) {
    return r.kind === 'item' ? { item: r.id } : r.kind === 'break' ? { break: true } : { label: r.text };
  }
  function indexOfItem(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].item === id) return i;
    return -1;
  }

  /**
   * The editor's core — pure: no DOM, no network.
   *   o.stored     the user's stored layout document (or null)
   *   o.effective  this user's effective registry (ycLauncher.effectiveRegistry())
   *   o.locked     the firm's locked ids
   *   o.base       { home, sidebar } base layouts (DEFAULT_LAYOUTS)
   *   o.registry   FEATURE_REGISTRY (surface labels: Bills reads Billing on Home)
   *   o.groups     the All tab's group order (ycLauncher.groups())
   * Every edit returns true, or false when it is refused (nothing changes).
   */
  function session(o) {
    o = o || {};
    var stored = normalize(o.stored);
    var eff = isArr(o.effective) ? o.effective.filter(function (e) { return isObj(e) && typeof e.id === 'string'; }) : [];
    var byId = Object.create(null);
    eff.forEach(function (e) { byId[e.id] = e; });
    var locked = Object.create(null);
    (isArr(o.locked) ? o.locked : []).forEach(function (id) { if (typeof id === 'string') locked[id] = true; });
    var lockedList = Object.keys(locked);
    var base = isObj(o.base) ? o.base : {};
    var reg = isObj(o.registry) ? o.registry : {};
    var baseIds = {};
    SURFACES.forEach(function (sf) {
      baseIds[sf] = Object.create(null);
      (isArr(base[sf]) ? base[sf] : []).forEach(function (e) { if (e && typeof e.item === 'string') baseIds[sf][e.item] = true; });
    });

    // Working state per surface: mode 'stored' (write it as stored),
    // 'edited' (write placed + removed below) or 'reset' (delete both).
    function fresh(sf) {
      return {
        mode: 'stored',
        placed: hasOwn(stored.placed, sf) ? stored.placed[sf].slice() : null,
        removed: hasOwn(stored.removed, sf) ? stored.removed[sf].slice() : [],
      };
    }
    var S = {}, INIT = {};

    function resolved(sf, st) {
      st = st || S[sf];
      var user = { placed: {}, removed: {} };
      if (st.placed) user.placed[sf] = st.placed;
      user.removed[sf] = st.removed;
      return L.resolveLayout(sf, { base: isArr(base[sf]) ? base[sf] : [], user: user, effective: eff, locked: lockedList });
    }
    // What a surface looks like: its rows, and its removals as a set.
    function sig(sf) {
      return canonical({ rows: resolved(sf).map(entryOf), removed: S[sf].removed.slice().sort() });
    }
    SURFACES.forEach(function (sf) { S[sf] = fresh(sf); INIT[sf] = sig(sf); });

    // A surface edited back to what it was is the stored one again; a reset
    // of a surface that has nothing stored is no change.
    function settle(sf) {
      var st = S[sf];
      if (st.mode === 'edited' && sig(sf) === INIT[sf]) S[sf] = fresh(sf);
      else if (st.mode === 'reset' && !hasOwn(stored.placed, sf) && !hasOwn(stored.removed, sf)) S[sf] = fresh(sf);
    }

    // Placed items that are not effective now: re-inserted into next after
    // the nearest preceding EFFECTIVE item of old that next still holds (or
    // first); a run of them keeps its order. Never twice.
    function carry(old, next) {
      if (!old) return next;
      var out = next.slice(), prev = [], lastAt = -1, chain = false;
      old.forEach(function (e) {
        if (!e || typeof e.item !== 'string') return;
        if (e.item in byId) { prev.push(e.item); chain = false; return; }
        if (indexOfItem(out, e.item) >= 0) return;
        var at = 0;
        if (chain) at = lastAt + 1;
        else {
          for (var k = prev.length - 1; k >= 0; k--) {
            var i = indexOfItem(out, prev[k]);
            if (i >= 0) { at = i + 1; break; }
          }
        }
        out.splice(at, 0, { item: e.item });
        lastAt = at; chain = true;
      });
      return out;
    }
    function commit(sf, rows, removed) {
      var st = S[sf];
      S[sf] = { mode: 'edited', placed: carry(st.placed, rows.map(entryOf)), removed: removed };
      settle(sf);
      return true;
    }
    function without(list, id) { return list.filter(function (x) { return x !== id; }); }
    function displayLabel(sf, e) {
      var it = hasOwn(reg, e.id) && isObj(reg[e.id]) ? reg[e.id] : null;
      // a surface label (Bills → Billing on Home) only where the default
      // element shows it: a base item that the firm has not renamed
      if (it && isObj(it.surfaceLabels) && it.surfaceLabels[sf] != null && e.label === it.label && e.id in baseIds[sf]) {
        return String(it.surfaceLabels[sf]);
      }
      return String(e.label);
    }
    function entryView(sf, e) {
      return { id: e.id, label: displayLabel(sf, e), icon: typeof e.icon === 'string' && ICON_RE.test(e.icon) ? e.icon : 'circle-question', group: e.group };
    }
    function visibleIds(rows) {
      var s = Object.create(null);
      rows.forEach(function (r) { if (r.kind === 'item') s[r.id] = true; });
      return s;
    }
    // The size Save would write for sf after rows: placed (with carried
    // items) — the server caps a list at CAP.
    function sizeAfter(sf, rows) { return carry(S[sf].placed, rows.map(entryOf)).length; }

    var api = {
      /** The surface as the user sees it: { kind:'item', id, label, icon,
       *  base, locked, firm, act } | { kind:'break', act } | { kind:'label',
       *  text, act }. act: 'hide' (a default item), 'locked' (a default item
       *  the firm locked: no hide), 'remove' (anything the user added). */
      view: function (sf) {
        return resolved(sf).map(function (r) {
          if (r.kind !== 'item') return r.kind === 'label' ? { kind: 'label', text: r.text, act: 'remove' } : { kind: 'break', act: 'remove' };
          var v = entryView(sf, byId[r.id]);
          v.kind = 'item';
          v.base = r.id in baseIds[sf];
          v.locked = r.id in locked;
          v.firm = /^firm:/.test(r.id);
          v.act = v.base ? (v.locked ? 'locked' : 'hide') : 'remove';
          return v;
        });
      },
      /** Default items the user hid here (effective, not locked), base order. */
      hidden: function (sf) {
        var rm = Object.create(null), vis = visibleIds(resolved(sf)), out = [];
        S[sf].removed.forEach(function (id) { rm[id] = true; });
        (isArr(base[sf]) ? base[sf] : []).forEach(function (e) {
          var id = e && e.item;
          if (typeof id !== 'string' || !(id in rm) || !(id in byId) || id in locked || id in vis) return;
          if (out.some(function (x) { return x.id === id; })) return;
          out.push(entryView(sf, byId[id]));
        });
        return out;
      },
      /** The "Add a shortcut" picker: effective items not visible on sf.
       *  A query ranks them with the All tab's matcher (one flat group);
       *  without one they are grouped like All. → [{ group, items: [view] }] */
      candidates: function (sf, query) {
        var vis = visibleIds(resolved(sf));
        var list = eff.filter(function (e) { return !(e.id in vis); });
        if (String(query == null ? '' : query).replace(/\s+/g, '')) {
          return [{ group: null, items: L.rank(query, list).map(function (e) { return entryView(sf, e); }) }];
        }
        var order = isArr(o.groups) ? o.groups.slice() : [];
        list.forEach(function (e) { if (order.indexOf(e.group) < 0) order.push(e.group); });
        return order.map(function (g) {
          return { group: g, items: list.filter(function (e) { return e.group === g; }).map(function (e) { return entryView(sf, e); }) };
        }).filter(function (g) { return g.items.length; });
      },
      /** Room left on sf (entries Save could still add). */
      room: function (sf) { return CAP - sizeAfter(sf, resolved(sf)); },
      mode: function (sf) { return S[sf].mode; },

      move: function (sf, i, d) {
        var rows = resolved(sf), j = i + d;
        if (!(i >= 0 && i < rows.length && j >= 0 && j < rows.length) || (d !== 1 && d !== -1)) return false;
        var t = rows[i]; rows[i] = rows[j]; rows[j] = t;
        return commit(sf, rows, S[sf].removed.slice());
      },
      hide: function (sf, i) {
        var rows = resolved(sf), r = rows[i];
        if (!r || r.kind !== 'item' || !(r.id in baseIds[sf]) || r.id in locked) return false;
        var removed = S[sf].removed.slice();
        if (removed.indexOf(r.id) < 0) {
          if (removed.length >= CAP) return false;
          removed.push(r.id);
        }
        rows.splice(i, 1);
        return commit(sf, rows, removed);
      },
      remove: function (sf, i) {
        var rows = resolved(sf), r = rows[i];
        if (!r || (r.kind === 'item' && r.id in baseIds[sf])) return false;
        rows.splice(i, 1);
        return commit(sf, rows, S[sf].removed.slice());
      },
      show: function (sf, id) {
        if (!api.hidden(sf).some(function (h) { return h.id === id; })) return false;
        var removed = without(S[sf].removed, id);
        var rows = resolved(sf, { placed: S[sf].placed, removed: removed });   // the resolver slots it back
        if (sizeAfter(sf, rows) > CAP) return false;
        return commit(sf, rows, removed);
      },
      add: function (sf, id) {
        var rows = resolved(sf);
        if (!(id in byId) || visibleIds(rows)[id]) return false;
        rows.push({ kind: 'item', id: id });
        if (sizeAfter(sf, rows) > CAP) return false;
        return commit(sf, rows, without(S[sf].removed, id));
      },
      addBreak: function () {
        var rows = resolved('home');
        rows.push({ kind: 'break' });
        if (sizeAfter('home', rows) > CAP) return false;
        return commit('home', rows, S.home.removed.slice());
      },
      addLabel: function (text) {
        if (labelProblem(text)) return false;
        var rows = resolved('sidebar');
        rows.push({ kind: 'label', text: text.trim() });
        if (sizeAfter('sidebar', rows) > CAP) return false;
        return commit('sidebar', rows, S.sidebar.removed.slice());
      },
      setLabel: function (sf, i, text) {
        var rows = resolved(sf);
        if (!rows[i] || rows[i].kind !== 'label' || labelProblem(text)) return false;
        rows[i] = { kind: 'label', text: text.trim() };
        return commit(sf, rows, S[sf].removed.slice());
      },
      reset: function (sf) {
        if (!hasOwn(S, sf)) return false;
        S[sf] = { mode: 'reset', placed: null, removed: [] };
        settle(sf);
        return true;
      },

      /** The document Save writes. */
      doc: function () {
        var out = { placed: {}, removed: {} };
        SURFACES.forEach(function (sf) {
          var st = S[sf];
          if (st.mode === 'stored') {
            if (hasOwn(stored.placed, sf)) out.placed[sf] = stored.placed[sf].map(function (e) { return copyEntry(e, sf); });
            if (hasOwn(stored.removed, sf)) out.removed[sf] = stored.removed[sf].slice();
          } else if (st.mode === 'edited') {
            out.placed[sf] = st.placed.map(function (e) { return copyEntry(e, sf); });
            if (st.removed.length) out.removed[sf] = st.removed.slice();
          }
        });
        return out;
      },
      isDirty: function () { return canonical(api.doc()) !== canonical(stored); },
    };
    return api;
  }

  // ── Keyboard shortcuts (S4c) ────────────────────────────────────────────
  var SC_CAP = 50;          // lib/uiConfigShape.js CAPS.bindings
  var ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  var FKEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
  // Combos the browser or the operating system owns, beyond the broad rules
  // in reservedProblem. Exact ctrl / meta / alt; Shift either way. Kept
  // conservative: a combo missing here that the browser keeps simply never
  // reaches the page, but one that IS caught here can't be bound by mistake.
  var RESERVED = [
    { ctrl: true, meta: true, alt: false, keys: ['f'], why: '⌃⌘F is full screen on a Mac.' },
    { ctrl: true, meta: true, alt: false, keys: ['q'], why: '⌃⌘Q locks a Mac.' },
    { ctrl: true, meta: true, alt: false, keys: ['d'], why: '⌃⌘D looks up a word on a Mac.' },
    { ctrl: true, meta: true, alt: false, keys: ['Space'], why: '⌃⌘Space opens the Mac emoji picker.' },
    { ctrl: false, meta: true, alt: true, keys: ['i', 'j', 'c', 'u'], why: '⌘⌥I, J, C and U open the browser\'s developer tools and page source.' },
    { ctrl: false, meta: true, alt: true, keys: ['d', 'h', 'm', 'w', 'n'], why: 'macOS and the browser use ⌘⌥D, H, M, W and N (Dock, hide others, minimize all, close all, new window).' },
    { ctrl: false, meta: true, alt: true, keys: ARROWS, why: '⌘⌥ with an arrow switches browser tabs.' },
    { ctrl: true, meta: false, alt: true, keys: ['Delete', 'Backspace'], why: 'Ctrl+Alt+Delete belongs to Windows.' },
    { ctrl: true, meta: false, alt: true, keys: ARROWS, why: 'Ctrl+Alt with an arrow rotates the screen on some Windows computers.' },
    { ctrl: true, meta: false, alt: true, keys: FKEYS, why: 'Ctrl+Alt with F1–F12 switches screens on Linux.' },
  ];
  /** Why the editor refuses a combo the browser or the OS owns, or null.
   *  (The server's own rules — a modifier needed, not the palette's Ctrl-K /
   *  ⌘K — are comboProblem's, checked first.) mac: word it for a Mac. */
  function reservedProblem(c, mac) {
    if (c.key === 'Tab' || c.key === 'Escape') {
      return 'Tab and Esc move between fields and close dialogs, so they stay free.';
    }
    if (c.alt && !c.ctrl && !c.meta) {
      return (mac ? '⌥' : 'Alt') + ' on its own types characters on a Mac (⌥E makes é) and opens the browser\'s menus on Windows.';
    }
    if ((c.ctrl ? 1 : 0) + (c.meta ? 1 : 0) === 1 && !c.alt) {
      return (c.meta ? '⌘' : 'Ctrl') + ' with a single key belongs to the browser or to typing (new tab, close, reload, ' +
        'address bar, copy, paste, undo, find, print…), and some of those can\'t be taken over at all.';
    }
    for (var i = 0; i < RESERVED.length; i++) {
      var r = RESERVED[i];
      if (r.ctrl === c.ctrl && r.meta === c.meta && r.alt === c.alt && r.keys.indexOf(c.key) >= 0) return r.why;
    }
    return null;
  }

  /**
   * The Keyboard shortcuts tab's core — pure: no DOM, no network.
   *   o.stored     the user's stored shortcuts document (or null)
   *   o.effective  this user's effective registry
   *   o.registry   FEATURE_REGISTRY (a label for an unavailable binding)
   *   o.groups     the All tab's group order
   *   o.keys       ycAll.keys (comboProblem, cleanCombo, format, sig)
   *   o.mac, o.win the platform the combos are written for
   * Edits return true, or false when refused (nothing changes).
   */
  function shortcutSession(o) {
    o = o || {};
    var K = o.keys;
    var mac = !!o.mac, win = !!o.win;
    var eff = isArr(o.effective) ? o.effective.filter(function (e) { return isObj(e) && typeof e.id === 'string'; }) : [];
    var byId = Object.create(null);
    eff.forEach(function (e) { byId[e.id] = e; });
    var reg = isObj(o.registry) ? o.registry : {};
    function norm(doc) {
      var out = { bindings: [] };
      if (isObj(doc) && isArr(doc.bindings)) doc.bindings.forEach(function (b) {
        var c = isObj(b) && typeof b.id === 'string' && b.id ? K.cleanCombo(b.combo) : null;
        if (c) out.bindings.push({ combo: c, id: b.id });
      });
      return out;
    }
    function copy(b) { return { combo: { ctrl: b.combo.ctrl, meta: b.combo.meta, alt: b.combo.alt, shift: b.combo.shift, key: b.combo.key }, id: b.id }; }
    var stored = norm(o.stored);
    var B = stored.bindings.map(copy);
    function fmt(c) { return K.format(c, mac, win); }
    function labelOf(id) {
      if (id in byId) return String(byId[id].label);
      var it = hasOwn(reg, id) && isObj(reg[id]) ? reg[id] : null;
      return it && it.label != null ? String(it.label) : id;
    }
    function iconOf(id) {
      var e = id in byId ? byId[id] : hasOwn(reg, id) && isObj(reg[id]) ? reg[id] : null;
      return e && typeof e.icon === 'string' && ICON_RE.test(e.icon) ? e.icon : 'circle-question';
    }
    function view(e) { return { id: e.id, label: String(e.label), icon: typeof e.icon === 'string' && ICON_RE.test(e.icon) ? e.icon : 'circle-question', group: e.group }; }

    var api = {
      /** The bindings: [{ text, id, label, icon, available }], stored order. */
      list: function () {
        return B.map(function (b) {
          return { text: fmt(b.combo), combo: copy(b).combo, id: b.id, label: labelOf(b.id), icon: iconOf(b.id), available: b.id in byId };
        });
      },
      /** Items a shortcut can open: every effective item, grouped like All
       *  (one ranked group for a query). → [{ group, items: [view] }] */
      candidates: function (query) {
        if (String(query == null ? '' : query).replace(/\s+/g, '')) {
          return [{ group: null, items: L.rank(query, eff).map(view) }];
        }
        var order = isArr(o.groups) ? o.groups.slice() : [];
        eff.forEach(function (e) { if (order.indexOf(e.group) < 0) order.push(e.group); });
        return order.map(function (g) {
          return { group: g, items: eff.filter(function (e) { return e.group === g; }).map(view) };
        }).filter(function (g) { return g.items.length; });
      },
      /** What the editor says about a combo: { refuse } (can't be added),
       *  else { ok: true, warn? }. */
      check: function (c) {
        var p = K.comboProblem(c);
        if (p) {
          return { refuse: (c.ctrl || c.meta || c.alt)
            ? fmt(c) + ' opens the search palette (Ctrl+K, or ⌘K on a Mac), so it can\'t be a shortcut.'
            : 'A shortcut needs Ctrl, ' + (mac ? '⌘ or ⌥' : 'Alt or ⌘') + ': without one it would fire while you type.' };
        }
        var r = reservedProblem(c, mac);
        if (r) {
          var sug = mac ? { ctrl: true, meta: true, alt: false, shift: false, key: c.key } : { ctrl: true, meta: false, alt: true, shift: false, key: c.key };
          var free = !K.comboProblem(sug) && !reservedProblem(sug, mac) && !api.holder(sug);
          return { refuse: r + ' Try ' + (free ? fmt(sug) : (mac ? '⌃⌘' : 'Ctrl+Alt+') + ' with another key') + '.' };
        }
        var h = api.holder(c);
        if (h != null) return { refuse: fmt(c) + ' already opens ' + labelOf(h) + '.' };
        var out = { ok: true };
        if (c.ctrl && c.alt && !c.meta) {
          out.warn = 'On Windows keyboards with an AltGr key (most non-US layouts), Ctrl+Alt with a key can type a ' +
            'character such as € or @. If typing that character stops working, pick another combination.';
        }
        return out;
      },
      /** The id a combo is already bound to, or null. */
      holder: function (c) {
        var s = K.sig(c);
        for (var i = 0; i < B.length; i++) if (K.sig(B[i].combo) === s) return B[i].id;
        return null;
      },
      room: function () { return SC_CAP - B.length; },
      format: fmt,
      add: function (id, c) {
        var cc = K.cleanCombo(c);
        if (!cc || !(id in byId) || B.length >= SC_CAP || api.check(cc).refuse) return false;
        B.push({ combo: cc, id: id });
        return true;
      },
      remove: function (i) {
        if (!(i >= 0 && i < B.length)) return false;
        B.splice(i, 1);
        return true;
      },
      /** The document Save writes: the full bindings list. */
      doc: function () { return { bindings: B.map(copy) }; },
      isDirty: function () { return canonical(api.doc()) !== canonical(stored); },
    };
    return api;
  }

  // ── The panel ───────────────────────────────────────────────────────────
  if (typeof document === 'undefined') {
    window.ycLayoutEditor = {
      session: session, labelProblem: labelProblem, canonical: canonical,
      shortcutSession: shortcutSession, reservedProblem: reservedProblem,
    };
    return;
  }

  var root = null, sess = null, opener = null, saving = false;
  var labelErr = {};        // 'sf:i' → message, for label inputs holding a bad value
  var scs = null;           // the Keyboard shortcuts tab's session
  var sessOpts = null;      // what sess was built from (a partial save rebuilds it)
  var scAdd = null;         // the shortcut being added: { id, combo }
  var PANES = ['layout', 'shortcuts'];
  var KEYS = (window.ycAll && window.ycAll.keys) || null;
  function anyDirty() { return !!((sess && sess.isDirty()) || (scs && scs.isDirty())); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconEl(slug, extra) {
    return el('i', 'fa-solid fa-' + (ICON_RE.test(slug) ? slug : 'circle-question') + (extra ? ' ' + extra : ''));
  }
  function btn(cls, act, label, slug, text) {
    var b = el('button', 'yle-btn ' + cls);
    b.type = 'button';
    b.setAttribute('data-act', act);
    if (label) { b.setAttribute('aria-label', label); b.title = label; }
    if (slug) b.appendChild(iconEl(slug));
    if (text) b.appendChild(el('span', null, text));
    return b;
  }

  function build() {
    if (root) return;
    root = el('div');
    root.id = 'ycLayoutEditor';
    root.hidden = true;
    var box = el('div', 'yle-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'yleTitle');
    var head = el('div', 'yle-head');
    var h = el('h2');
    h.id = 'yleTitle';
    h.appendChild(iconEl('sliders'));
    h.appendChild(document.createTextNode(' Customize my launcher'));
    head.appendChild(h);
    head.appendChild(btn('yle-x', 'cancel', 'Close', 'xmark'));
    box.appendChild(head);

    // Two tabs (S4c): the Home + sidebar layout, and keyboard shortcuts. A
    // strip outside the scrolling body, so it stays in view; a dot marks a
    // tab with unsaved changes.
    var tabs = el('div', 'yle-tabs');
    tabs.setAttribute('role', 'tablist');
    [['layout', 'Home & sidebar', 'table-cells'], ['shortcuts', 'Keyboard shortcuts', 'keyboard']].forEach(function (t) {
      var b = btn('yle-tab', 'tab', null, t[2], t[1]);
      b.setAttribute('data-pane', t[0]);
      b.setAttribute('role', 'tab');
      b.id = 'yleTab_' + t[0];
      b.setAttribute('aria-controls', 'ylePane_' + t[0]);
      var dot = el('span', 'yle-tab-dot', '•');
      dot.setAttribute('aria-label', 'unsaved changes');
      dot.hidden = true;
      b.appendChild(dot);
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    var body = el('div', 'yle-body');
    var banner = el('div', 'yle-banner');
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    body.appendChild(banner);
    var lay = el('div', 'yle-pane');
    lay.id = 'ylePane_layout';
    lay.setAttribute('data-pane', 'layout');
    lay.setAttribute('role', 'tabpanel');
    lay.setAttribute('aria-labelledby', 'yleTab_layout');
    lay.appendChild(el('p', 'yc-hint yle-intro',
      'Arrange your own Home tiles and sidebar. Nothing changes until you Save. ' +
      'Hiding an item only takes its shortcut away: All and Ctrl+K still list every feature you have.'));
    SURFACES.forEach(function (sf) { lay.appendChild(buildSection(sf)); });
    body.appendChild(lay);
    var scp = el('div', 'yle-pane');
    scp.id = 'ylePane_shortcuts';
    scp.setAttribute('data-pane', 'shortcuts');
    scp.setAttribute('role', 'tabpanel');
    scp.setAttribute('aria-labelledby', 'yleTab_shortcuts');
    scp.hidden = true;
    scp.appendChild(buildShortcutSection());
    body.appendChild(scp);
    box.appendChild(body);

    var foot = el('div', 'yle-foot');
    var status = el('span', 'yc-hint yle-status');
    status.setAttribute('aria-live', 'polite');
    foot.appendChild(status);
    foot.appendChild(btn('yle-cancel', 'cancel', null, null, 'Cancel'));
    foot.appendChild(btn('yle-save yle-primary', 'save', null, 'check', 'Save'));
    box.appendChild(foot);
    root.appendChild(box);
    document.body.appendChild(root);

    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    // the Keys box reads the combo before anything else hears it
    root.addEventListener('keydown', onCaptureKey);
    root.addEventListener('keyup', onCaptureKeyUp);
    // Esc / Tab / Enter on the document, not the panel: a click on a
    // non-focusable spot in the card leaves focus on <body>.
    document.addEventListener('keydown', onKey);
    // a press that starts AND ends on the backdrop closes (not a text
    // selection dragged out of the card)
    var downOnBackdrop = false;
    root.addEventListener('mousedown', function (e) { downOnBackdrop = e.target === root; });
    root.addEventListener('click', function (e) { if (e.target === root && downOnBackdrop) requestClose(); });
  }

  function buildSection(sf) {
    var sec = el('section', 'yle-sec');
    sec.setAttribute('data-sf', sf);
    var head = el('div', 'yle-sec-head');
    head.appendChild(el('h3', null, NAME[sf]));
    head.appendChild(btn('yle-reset', 'reset', null, 'rotate-left', sf === 'home' ? 'Reset Home to default' : 'Reset sidebar to default'));
    sec.appendChild(head);
    var errs = el('ul', 'yle-errs');
    errs.setAttribute('role', 'alert');
    errs.hidden = true;
    sec.appendChild(errs);
    var rows = el('ol', 'yle-rows');
    rows.setAttribute('aria-label', NAME[sf] + ' layout');
    sec.appendChild(rows);

    var adds = el('div', 'yle-adds');
    adds.appendChild(btn('yle-add', 'pick', null, 'plus', 'Add a shortcut'));
    if (sf === 'home') adds.appendChild(btn('yle-add', 'add-break', null, 'grip-lines', 'Add a row break'));
    else adds.appendChild(btn('yle-add', 'label-open', null, 'heading', 'Add a section label'));
    adds.appendChild(el('span', 'yc-hint yle-room'));
    sec.appendChild(adds);

    if (sf === 'sidebar') {
      var la = el('div', 'yle-label-add');
      la.hidden = true;
      var lab = el('label', 'yc-flabel', 'Section label');
      lab.setAttribute('for', 'yleNewLabel');
      la.appendChild(lab);
      var row = el('div', 'yle-label-add-row');
      var inp = el('input', 'yle-input yle-new-label');
      inp.id = 'yleNewLabel';
      inp.type = 'text';
      inp.maxLength = 80;
      inp.autocomplete = 'off';
      row.appendChild(inp);
      row.appendChild(btn('yle-add-go', 'label-add', null, null, 'Add'));
      row.appendChild(btn('yle-add-cancel', 'label-cancel', null, null, 'Cancel'));
      la.appendChild(row);
      la.appendChild(el('div', 'yle-field-err'));
      sec.appendChild(la);
    }

    sec.appendChild(buildPicker(sf, 'Add a shortcut to ' + (sf === 'home' ? 'Home' : 'the sidebar')));

    var hw = el('div', 'yle-hidden-wrap');
    hw.appendChild(el('h4', null, 'Hidden on this surface'));
    hw.appendChild(el('ul', 'yle-hidden'));
    hw.appendChild(el('div', 'yc-hint yle-hidden-none', 'Nothing hidden.'));
    sec.appendChild(hw);
    return sec;
  }

  // The "find a feature" picker: Home's, the sidebar's and the shortcut
  // tab's (S4c) are the same markup, filled by renderPicker.
  function buildPicker(sf, title) {
    var pk = el('div', 'yle-picker');
    pk.hidden = true;
    var pl = el('label', 'yc-flabel', title);
    pl.setAttribute('for', 'ylePick_' + sf);
    pk.appendChild(pl);
    var prow = el('div', 'yle-pick-row');
    var q = el('input', 'yle-input yle-pick-q');
    q.id = 'ylePick_' + sf;
    q.type = 'search';
    q.placeholder = 'Find a feature…';
    q.autocomplete = 'off';
    prow.appendChild(q);
    prow.appendChild(btn('yle-add-cancel', 'pick-close', null, null, 'Done'));
    pk.appendChild(prow);
    pk.appendChild(el('div', 'yle-pick-list'));
    return pk;
  }

  function buildShortcutSection() {
    var sec = el('section', 'yle-sec ysc-sec');
    sec.setAttribute('data-sf', 'shortcuts');
    var head = el('div', 'yle-sec-head');
    head.appendChild(el('h3', null, 'Keyboard shortcuts'));
    sec.appendChild(head);
    sec.appendChild(el('p', 'yc-hint ysc-intro',
      'Press a key combination anywhere in YisraCase to open a feature. Shortcuts need a keyboard: on a phone ' +
      'you can see and remove them here, but not press them. They are saved to your account, so they follow you ' +
      'to every computer you sign in on.'));
    var errs = el('ul', 'yle-errs');
    errs.setAttribute('role', 'alert');
    errs.hidden = true;
    sec.appendChild(errs);
    var rows = el('ol', 'ysc-rows');
    rows.setAttribute('aria-label', 'Your keyboard shortcuts');
    sec.appendChild(rows);
    sec.appendChild(el('div', 'yc-hint ysc-none', 'No keyboard shortcuts yet.'));
    var adds = el('div', 'yle-adds');
    adds.appendChild(btn('yle-add', 'sc-open', null, 'plus', 'Add a keyboard shortcut'));
    adds.appendChild(el('span', 'yc-hint yle-room'));
    sec.appendChild(adds);

    var add = el('div', 'ysc-add');
    add.hidden = true;
    var fl = el('div', 'yc-flabel ysc-step', '1. The feature it opens');
    add.appendChild(fl);
    var chosen = el('div', 'ysc-chosen');
    chosen.hidden = true;
    chosen.appendChild(el('span', 'ysc-chosen-name'));
    chosen.appendChild(btn('yle-add-cancel', 'sc-change', null, null, 'Change'));
    add.appendChild(chosen);
    add.appendChild(buildPicker('shortcuts', 'Find the feature'));
    var kl = el('label', 'yc-flabel ysc-step', '2. The keys');
    kl.setAttribute('for', 'yscCapture');
    add.appendChild(kl);
    var cap = el('input', 'yle-input ysc-capture');
    cap.id = 'yscCapture';
    cap.type = 'text';
    cap.readOnly = true;
    cap.autocomplete = 'off';
    cap.placeholder = 'Click here, then press the keys';
    cap.setAttribute('aria-describedby', 'yscMsg');
    add.appendChild(cap);
    var msg = el('div', 'ysc-msg');
    msg.id = 'yscMsg';
    msg.setAttribute('aria-live', 'polite');
    add.appendChild(msg);
    var row = el('div', 'ysc-add-row');
    row.appendChild(btn('yle-add-go yle-primary', 'sc-add', null, 'check', 'Add shortcut'));
    row.appendChild(btn('yle-add-cancel', 'sc-cancel', null, null, 'Cancel'));
    add.appendChild(row);
    sec.appendChild(add);
    return sec;
  }

  function secOf(sf) { return root.querySelector('.yle-sec[data-sf="' + sf + '"]'); }

  function renderRows(sf) {
    var ol = secOf(sf).querySelector('.yle-rows');
    ol.textContent = '';
    var view = sess.view(sf);
    view.forEach(function (r, i) {
      var li = el('li', 'yle-row yle-row-' + r.kind);
      li.setAttribute('data-i', String(i));
      var name = r.kind === 'item' ? r.label : r.kind === 'break' ? 'Row break' : r.text;
      if (r.kind === 'item') {
        li.appendChild(iconEl(r.icon, 'yle-ic'));
        // name + tag wrap together: on a narrow row the tag drops under the
        // name rather than squeezing it into a mid-word break
        var main = el('span', 'yle-main');
        main.appendChild(el('span', 'yle-name', r.label));
        if (r.locked) {
          var tag = el('span', 'yle-tag');
          tag.appendChild(iconEl('lock'));
          tag.appendChild(document.createTextNode(' Locked'));
          main.appendChild(tag);
        } else if (r.firm) main.appendChild(el('span', 'yle-tag', 'Firm'));
        else if (!r.base) main.appendChild(el('span', 'yle-tag', 'Added'));
        li.appendChild(main);
      } else if (r.kind === 'break') {
        li.appendChild(iconEl('grip-lines', 'yle-ic'));
        li.appendChild(el('span', 'yle-name yle-break', 'Row break'));
      } else {
        li.appendChild(iconEl('heading', 'yle-ic'));
        var wrap = el('span', 'yle-name yle-label-wrap');
        var inp = el('input', 'yle-input yle-label-in');
        inp.type = 'text';
        inp.value = r.text;
        inp.maxLength = 80;
        inp.setAttribute('aria-label', 'Section label');
        inp.setAttribute('data-i', String(i));
        wrap.appendChild(inp);
        var fe = el('span', 'yle-field-err');
        var bad = labelErr[sf + ':' + i];
        if (bad) { fe.textContent = bad.msg; inp.value = bad.value; inp.setAttribute('aria-invalid', 'true'); }
        wrap.appendChild(fe);
        li.appendChild(wrap);
      }
      var acts = el('span', 'yle-acts');
      var up = btn('yle-up', 'up', 'Move ' + name + ' up', 'arrow-up');
      var dn = btn('yle-down', 'down', 'Move ' + name + ' down', 'arrow-down');
      up.disabled = i === 0;
      dn.disabled = i === view.length - 1;
      acts.appendChild(up);
      acts.appendChild(dn);
      if (r.act === 'hide') acts.appendChild(btn('yle-hide', 'hide', 'Hide ' + name + ' here', 'eye-slash'));
      else if (r.act === 'locked') {
        var lk = btn('yle-hide yle-locked', 'hide', 'Locked by your firm — it stays on this surface', 'lock');
        lk.disabled = true;
        acts.appendChild(lk);
      } else acts.appendChild(btn('yle-remove', 'remove', 'Remove ' + name, 'xmark'));
      li.appendChild(acts);
      ol.appendChild(li);
    });
  }

  function renderHidden(sf) {
    var sec = secOf(sf), ul = sec.querySelector('.yle-hidden');
    ul.textContent = '';
    var hid = sess.hidden(sf);
    hid.forEach(function (h) {
      var li = el('li', 'yle-row yle-hidden-row');
      li.setAttribute('data-id', h.id);
      li.appendChild(iconEl(h.icon, 'yle-ic'));
      li.appendChild(el('span', 'yle-name', h.label));
      var acts = el('span', 'yle-acts');
      var b = btn('yle-show', 'show', 'Show ' + h.label + ' again', 'eye', 'Show');
      acts.appendChild(b);
      li.appendChild(acts);
      ul.appendChild(li);
    });
    sec.querySelector('.yle-hidden-none').hidden = hid.length > 0;
  }

  function renderPicker(sf) {
    var sec = secOf(sf), pk = sec.querySelector('.yle-picker');
    if (pk.hidden) return;
    var list = pk.querySelector('.yle-pick-list');
    list.textContent = '';
    var q = pk.querySelector('.yle-pick-q').value;
    var groups = sf === 'shortcuts' ? scs.candidates(q) : sess.candidates(sf, q);
    if (!groups.length || (groups.length === 1 && !groups[0].items.length)) {
      list.appendChild(el('div', 'yc-hint yle-pick-empty', sf === 'shortcuts'
        ? 'Nothing matches.' : 'Nothing to add: everything that matches is already here.'));
      return;
    }
    groups.forEach(function (g) {
      var box = el('div', 'yle-pick-group');
      if (g.group) box.appendChild(el('h4', null, g.group));
      var items = el('div', 'yle-pick-items');
      g.items.forEach(function (it) {
        var b = btn('yle-pick-item', 'pick-add', null, null, null);
        b.setAttribute('data-id', it.id);
        b.appendChild(iconEl(it.icon));
        b.appendChild(el('span', null, it.label));
        items.appendChild(b);
      });
      box.appendChild(items);
      list.appendChild(box);
    });
  }

  function renderSection(sf) {
    renderRows(sf);
    renderHidden(sf);
    renderPicker(sf);
    var sec = secOf(sf), room = sess.room(sf);
    sec.querySelector('.yle-room').textContent = room <= 0 ? 'This surface is full (' + CAP + ' entries).' : '';
    sec.querySelectorAll('.yle-adds [data-act]').forEach(function (b) { b.disabled = room <= 0; });
  }
  // ── The Keyboard shortcuts tab ──
  function scSec() { return secOf('shortcuts'); }
  function renderShortcuts() {
    var sec = scSec(), ol = sec.querySelector('.ysc-rows');
    ol.textContent = '';
    var list = scs.list();
    list.forEach(function (b, i) {
      var li = el('li', 'yle-row ysc-row' + (b.available ? '' : ' ysc-unavailable'));
      li.setAttribute('data-i', String(i));
      li.appendChild(el('kbd', 'ysc-kbd', b.text));
      li.appendChild(iconEl(b.icon, 'yle-ic'));
      var main = el('span', 'yle-main');
      main.appendChild(el('span', 'yle-name', b.label));
      if (!b.available) {
        var tag = el('span', 'yle-tag', 'Unavailable');
        tag.title = 'Not available to you right now: pressing it does nothing. It is kept until you remove it.';
        main.appendChild(tag);
      }
      li.appendChild(main);
      var acts = el('span', 'yle-acts');
      acts.appendChild(btn('yle-remove', 'sc-remove', 'Remove the shortcut ' + b.text + ' (' + b.label + ')', 'xmark'));
      li.appendChild(acts);
      ol.appendChild(li);
    });
    sec.querySelector('.ysc-none').hidden = list.length > 0;
    var room = scs.room();
    sec.querySelector('.yle-room').textContent = room <= 0 ? 'You have the most shortcuts there can be (' + SC_CAP + ').' : '';
    sec.querySelector('[data-act="sc-open"]').disabled = room <= 0;
    renderScAdd();
  }
  // The add box: the chosen item, the captured combo, and what the editor
  // says about it (refused / a warning / free).
  function renderScAdd() {
    var sec = scSec(), add = sec.querySelector('.ysc-add');
    if (add.hidden || !scAdd) return;
    var chosen = add.querySelector('.ysc-chosen'), name = add.querySelector('.ysc-chosen-name');
    name.textContent = '';
    var ent = null;
    if (scAdd.id != null) {
      scs.candidates('').forEach(function (g) { g.items.forEach(function (it) { if (it.id === scAdd.id) ent = it; }); });
    }
    chosen.hidden = !ent;
    if (ent) { name.appendChild(iconEl(ent.icon, 'yle-ic')); name.appendChild(el('span', null, ent.label)); }
    var cap = add.querySelector('.ysc-capture'), msg = add.querySelector('.ysc-msg');
    cap.value = scAdd.combo ? fmtCombo(scAdd.combo) : (scAdd.live || '');
    msg.textContent = '';
    msg.className = 'ysc-msg';
    var ok = false;
    if (scAdd.combo) {
      var r = scs.check(scAdd.combo);
      if (r.refuse) { msg.textContent = r.refuse; msg.className = 'ysc-msg ysc-refuse'; cap.setAttribute('aria-invalid', 'true'); }
      else {
        cap.removeAttribute('aria-invalid');
        ok = true;
        msg.textContent = r.warn ? r.warn : 'Free to use.';
        msg.className = 'ysc-msg ' + (r.warn ? 'ysc-warn' : 'ysc-ok');
      }
    } else {
      cap.removeAttribute('aria-invalid');
      msg.textContent = 'For example ' + fmtCombo(isMacNow()
        ? { ctrl: true, meta: true, alt: false, shift: false, key: 't' }
        : { ctrl: true, meta: false, alt: true, shift: false, key: 't' }) + '.';
    }
    add.querySelector('[data-act="sc-add"]').disabled = !(ok && ent);
  }
  function isMacNow() { return !!(KEYS && KEYS.isMac()); }
  function fmtCombo(c) { return scs ? scs.format(c) : ''; }
  function openScAdd() {
    var sec = scSec(), add = sec.querySelector('.ysc-add');
    scAdd = { id: null, combo: null, live: '' };
    add.hidden = false;
    var pk = add.querySelector('.yle-picker');
    pk.hidden = false;
    pk.querySelector('.yle-pick-q').value = '';
    renderPicker('shortcuts');
    renderScAdd();
    pk.querySelector('.yle-pick-q').focus();
  }
  function closeScAdd(focus) {
    var sec = scSec();
    sec.querySelector('.ysc-add').hidden = true;
    scAdd = null;
    if (focus) sec.querySelector('[data-act="sc-open"]').focus();
  }
  function addShortcutFromForm() {
    if (saving || !scAdd) return;
    var sec = scSec();
    if (scAdd.id == null) { sec.querySelector('.ysc-add .yle-pick-q').focus(); return; }
    if (!scAdd.combo) { sec.querySelector('.ysc-capture').focus(); return; }
    if (!scs.add(scAdd.id, scAdd.combo)) { renderScAdd(); sec.querySelector('.ysc-capture').focus(); return; }
    closeScAdd(false);
    renderShortcuts();
    renderStatus();
    sec.querySelector('[data-act="sc-open"]').focus();
  }

  function showPane(name) {
    if (PANES.indexOf(name) < 0) name = 'layout';
    root.querySelectorAll('.yle-pane').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
    root.querySelectorAll('.yle-tab').forEach(function (t) {
      var on = t.getAttribute('data-pane') === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('active', on);
    });
    root.querySelector('.yle-body').scrollTop = 0;
  }
  function paneShown() {
    var t = root.querySelector('.yle-tab.active');
    return t ? t.getAttribute('data-pane') : 'layout';
  }

  function renderStatus() {
    var dirty = anyDirty();
    root.querySelector('.yle-status').textContent = dirty ? 'Unsaved changes' : 'No changes';
    // a held bad label keeps Save clickable: the click says what to fix
    root.querySelector('.yle-save').disabled = (!dirty && !Object.keys(labelErr).length) || saving;
    var dots = { layout: !!(sess && sess.isDirty()), shortcuts: !!(scs && scs.isDirty()) };
    root.querySelectorAll('.yle-tab').forEach(function (t) {
      t.querySelector('.yle-tab-dot').hidden = !dots[t.getAttribute('data-pane')];
    });
  }
  function render() {
    SURFACES.forEach(renderSection);
    renderShortcuts();
    renderStatus();
  }

  // reveal: scroll the panel back to the top so the message is in view (a
  // phone user saving from the sidebar section would not see it otherwise)
  function banner(msg, reveal) {
    var b = root.querySelector('.yle-banner');
    b.textContent = msg || '';
    b.hidden = !msg;
    if (msg && reveal) root.querySelector('.yle-body').scrollTop = 0;
  }
  function clearErrors() {
    banner('');
    SURFACES.concat('shortcuts').forEach(function (sf) {
      var u = secOf(sf).querySelector('.yle-errs');
      u.textContent = '';
      u.hidden = true;
    });
  }
  /** A refused save's errors[] inside the panel. The layout document's go
   *  under the surface their path names (placed.home[3]…, removed.sidebar…);
   *  the shortcuts document's all go under Keyboard shortcuts. → the rest
   *  (for the banner). */
  function placeErrors(key, errors) {
    var general = [];
    errors.forEach(function (m) {
      var hit = key === 'layout' ? /^(?:placed|removed)\.(home|sidebar)\b/.exec(String(m)) : [null, 'shortcuts'];
      if (hit) {
        var u = secOf(hit[1]).querySelector('.yle-errs');
        u.appendChild(el('li', null, String(m)));
        u.hidden = false;
      } else general.push(String(m));
    });
    return general;
  }

  // Focus the control `sel` on row i of sf after a re-render (or the nearest
  // row), so the keyboard stays where the user was.
  function focusRow(sf, i, sel) {
    var rows = secOf(sf).querySelectorAll('.yle-rows > .yle-row');
    if (!rows.length) { var a = secOf(sf).querySelector('.yle-adds [data-act]'); if (a) a.focus(); return; }
    var r = rows[Math.max(0, Math.min(i, rows.length - 1))];
    var t = (sel && r.querySelector(sel + ':not(:disabled)')) || r.querySelector('button:not(:disabled), input');
    if (t) t.focus();
  }

  function ask(text, ok, cancel) {
    var S = window.Swal;
    if (S && typeof S.fire === 'function') {
      return S.fire({ text: text, icon: 'warning', showCancelButton: true, confirmButtonText: ok, cancelButtonText: cancel, focusCancel: true })
        .then(function (r) { return !!(r && r.isConfirmed); }, function () { return false; });
    }
    return Promise.resolve(window.confirm(text));
  }
  function swalOpen() {
    try {
      var S = window.Swal;
      if (!(S && S.isVisible && S.isVisible())) return false;
      var p = S.getPopup && S.getPopup();
      return !(p && p.classList.contains('swal2-toast'));
    } catch (_) { return false; }
  }

  function edited(sf) {
    labelErr = Object.keys(labelErr).reduce(function (o, k) { if (k.indexOf(sf + ':') !== 0) o[k] = labelErr[k]; return o; }, {});
    renderSection(sf);
    renderStatus();
  }

  function onClick(e) {
    if (saving) return;   // the document is on its way: an edit now would be lost
    var b = e.target.closest('[data-act]');
    if (!b || !root.contains(b) || b.disabled) return;
    var act = b.getAttribute('data-act');
    var sec = b.closest('.yle-sec'), sf = sec && sec.getAttribute('data-sf');
    var row = b.closest('.yle-rows > .yle-row'), i = row ? Number(row.getAttribute('data-i')) : -1;
    switch (act) {
      case 'cancel': requestClose(); return;
      case 'save': save(); return;
      case 'tab': showPane(b.getAttribute('data-pane')); return;
      case 'sc-open': openScAdd(); return;
      case 'sc-cancel': closeScAdd(true); return;
      case 'sc-add': addShortcutFromForm(); return;
      case 'sc-change': {
        var cpk = scSec().querySelector('.ysc-add .yle-picker');
        cpk.hidden = false;
        cpk.querySelector('.yle-pick-q').value = '';
        renderPicker('shortcuts');
        cpk.querySelector('.yle-pick-q').focus();
        return;
      }
      case 'sc-remove': {
        var ri = Number(b.closest('.ysc-row').getAttribute('data-i'));
        if (scs.remove(ri)) {
          renderShortcuts();
          renderStatus();
          var left = scSec().querySelectorAll('.ysc-row [data-act="sc-remove"]');
          (left[Math.min(ri, left.length - 1)] || scSec().querySelector('[data-act="sc-open"]')).focus();
        }
        return;
      }
      case 'up': case 'down': {
        var d = act === 'up' ? -1 : 1;
        if (sess.move(sf, i, d)) { edited(sf); focusRow(sf, i + d, '.yle-' + act); }
        return;
      }
      case 'hide':
        if (sess.hide(sf, i)) { edited(sf); focusRow(sf, i, '.yle-hide'); }
        return;
      case 'remove':
        if (sess.remove(sf, i)) { edited(sf); focusRow(sf, i, '.yle-remove'); }
        return;
      case 'show': {
        var id = b.closest('.yle-hidden-row').getAttribute('data-id');
        if (sess.show(sf, id)) {
          edited(sf);
          var at = sess.view(sf).map(function (r) { return r.id; }).indexOf(id);
          focusRow(sf, at, '.yle-hide');
        }
        return;
      }
      case 'reset':
        ask(sf === 'home'
          ? 'Reset Home to the standard layout? Your Home arrangement is replaced when you Save.'
          : 'Reset the sidebar to the standard layout? Your sidebar arrangement is replaced when you Save.',
        'Reset', 'Keep mine').then(function (yes) {
          if (!yes || !sess) return;
          sess.reset(sf);
          edited(sf);
          var r = secOf(sf).querySelector('.yle-reset');
          if (r) r.focus();
        });
        return;
      case 'add-break':
        if (sess.addBreak()) { edited('home'); focusRow('home', sess.view('home').length - 1, '.yle-remove'); }
        return;
      case 'label-open': {
        var la = sec.querySelector('.yle-label-add');
        la.hidden = false;
        la.querySelector('.yle-field-err').textContent = '';
        la.querySelector('input').value = '';
        la.querySelector('input').focus();
        return;
      }
      case 'label-cancel':
        sec.querySelector('.yle-label-add').hidden = true;
        sec.querySelector('[data-act="label-open"]').focus();
        return;
      case 'label-add': addLabelFromInput(sec); return;
      case 'pick': {
        var pk = sec.querySelector('.yle-picker');
        pk.hidden = false;
        pk.querySelector('.yle-pick-q').value = '';
        renderPicker(sf);
        pk.querySelector('.yle-pick-q').focus();
        return;
      }
      case 'pick-close':
        sec.querySelector('.yle-picker').hidden = true;
        if (sf === 'shortcuts') {
          if (scAdd && scAdd.id != null) sec.querySelector('.ysc-capture').focus();
          else closeScAdd(true);
          return;
        }
        sec.querySelector('[data-act="pick"]').focus();
        return;
      case 'pick-add': {
        var pid = b.getAttribute('data-id');
        if (sf === 'shortcuts') {         // step 1 of a shortcut: the item, then the keys
          if (!scAdd) return;
          scAdd.id = pid;
          sec.querySelector('.yle-picker').hidden = true;
          renderScAdd();
          sec.querySelector('.ysc-capture').focus();
          return;
        }
        if (sess.add(sf, pid)) {
          sec.querySelector('.yle-picker').hidden = true;
          edited(sf);
          focusRow(sf, sess.view(sf).length - 1, '.yle-up');
        }
        return;
      }
    }
  }

  function addLabelFromInput(sec) {
    if (saving) return;
    var la = sec.querySelector('.yle-label-add'), inp = la.querySelector('input');
    var p = labelProblem(inp.value);
    if (p) { la.querySelector('.yle-field-err').textContent = p; inp.setAttribute('aria-invalid', 'true'); inp.focus(); return; }
    if (sess.addLabel(inp.value)) {
      inp.removeAttribute('aria-invalid');
      la.hidden = true;
      edited('sidebar');
      focusRow('sidebar', sess.view('sidebar').length - 1, '.yle-remove');
    }
  }

  function onInput(e) {
    if (saving) return;
    var t = e.target;
    if (t.classList.contains('yle-pick-q')) { renderPicker(t.closest('.yle-sec').getAttribute('data-sf')); return; }
    if (t.classList.contains('yle-new-label')) {
      t.closest('.yle-label-add').querySelector('.yle-field-err').textContent = '';
      t.removeAttribute('aria-invalid');
      return;
    }
    if (t.classList.contains('yle-label-in')) {
      // Typed in place: the list is not re-drawn (focus stays in the box).
      // A bad value is held in the box with its message and blocks Save; the
      // document keeps the last good one.
      var sf = t.closest('.yle-sec').getAttribute('data-sf'), i = Number(t.getAttribute('data-i'));
      var key = sf + ':' + i, p = labelProblem(t.value), fe = t.parentNode.querySelector('.yle-field-err');
      if (p) {
        labelErr[key] = { msg: p, value: t.value };
        fe.textContent = p;
        t.setAttribute('aria-invalid', 'true');
      } else {
        delete labelErr[key];
        fe.textContent = '';
        t.removeAttribute('aria-invalid');
        sess.setLabel(sf, i, t.value);
      }
      renderStatus();
    }
  }

  function focusables() {
    return Array.prototype.filter.call(root.querySelectorAll('button, input'), function (n) {
      return !n.disabled && n.offsetParent !== null;
    });
  }
  function onKey(e) {
    if (!isOpen() || swalOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      var sca = e.target.closest && e.target.closest('.ysc-add');
      if (sca && !sca.hidden) { closeScAdd(true); return; }
      var pk = e.target.closest && e.target.closest('.yle-picker, .yle-label-add');
      if (pk && !pk.hidden) {
        pk.hidden = true;
        var sec = pk.closest('.yle-sec');
        sec.querySelector(pk.classList.contains('yle-picker') ? '[data-act="pick"]' : '[data-act="label-open"]').focus();
        return;
      }
      requestClose();
    } else if (e.key === 'Enter') {
      var t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('yle-new-label')) { e.preventDefault(); addLabelFromInput(t.closest('.yle-sec')); }
      else if (t.classList.contains('ysc-capture')) { e.preventDefault(); addShortcutFromForm(); }
      else if (t.classList.contains('yle-pick-q')) {
        e.preventDefault();
        var first = t.closest('.yle-picker').querySelector('.yle-pick-item');
        if (first) first.click();
      }
    } else if (e.key === 'Tab') {
      // modal: focus cycles inside the panel
      var f = focusables();
      if (!f.length) return;
      if (!root.contains(document.activeElement)) { e.preventDefault(); f[0].focus(); }
      else if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }

  // The Keys box. Plain Tab / Shift+Tab move on, plain Esc closes the add
  // box and plain Enter adds (the panel's onKey does those); plain Backspace
  // or Delete clears. Anything else is captured — preventDefault, and no one
  // else hears it (the panel's keys, the browser's where it lets a page) —
  // and checked live. A bare modifier press shows the modifiers held.
  function plainKey(e, k) { return e.key === k && !e.ctrlKey && !e.metaKey && !e.altKey; }
  function onCaptureKey(e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('ysc-capture')) return;
    if (plainKey(e, 'Tab') || (plainKey(e, 'Escape') && !e.shiftKey) || (plainKey(e, 'Enter') && !e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    if (saving || !scAdd || !KEYS) return;
    if ((plainKey(e, 'Backspace') || plainKey(e, 'Delete')) && !e.shiftKey) { scAdd.combo = null; scAdd.live = ''; renderScAdd(); return; }
    var c = KEYS.comboOf(e);
    if (!c) {
      scAdd.combo = null;
      scAdd.live = fmtCombo({ ctrl: !!e.ctrlKey, meta: !!e.metaKey, alt: !!e.altKey, shift: !!e.shiftKey, key: '' }) + '…';
      renderScAdd();
      return;
    }
    scAdd.combo = c;
    scAdd.live = '';
    renderScAdd();
  }
  function onCaptureKeyUp(e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('ysc-capture') || !scAdd || scAdd.combo) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && scAdd.live) { scAdd.live = ''; renderScAdd(); }
  }

  function onBeforeUnload(e) {
    if (anyDirty()) { e.preventDefault(); e.returnValue = ''; return ''; }
  }

  function storedOf(ui) {
    return isObj(ui) && isObj(ui.user) && isObj(ui.user.layout) ? ui.user.layout : null;
  }
  function shortcutsOf(ui) {
    return isObj(ui) && isObj(ui.user) && isObj(ui.user.shortcuts) ? ui.user.shortcuts : null;
  }
  function newShortcutSession(stored) {
    return shortcutSession({
      stored: stored, effective: L.effectiveRegistry(), registry: window.FEATURE_REGISTRY || {}, groups: L.groups(),
      keys: KEYS, mac: !!(KEYS && KEYS.isMac()), win: !!(KEYS && KEYS.isWindows()),
    });
  }
  function lockedOf(ui) {
    var ro = isObj(ui) && isObj(ui.firm) && isObj(ui.firm.registry_overrides) ? ui.firm.registry_overrides : null;
    return ro && isArr(ro.locked) ? ro.locked : [];
  }

  /** Open the editor over the shell. false before login. */
  // The editor starts from the layers as they are NOW, read fresh from
  // GET /api/ui-config (the same uiConfigService.readFor that built
  // /api/firm-data's ui at login), never from this tab's login-time copy: a
  // save from another tab or computer since then, or a login whose ui read
  // failed soft ({ firm: {}, user: {} }), would otherwise be written back over
  // the surface the user did not touch. When the fresh layers differ from
  // firmData.ui, the shell's copy is replaced and the launcher re-run, so the
  // launcher shows what the editor shows. A failed read opens nothing.
  var LOAD_FAIL = 'Couldn\u2019t load your current layout; try again.';
  var loading = null;
  /** Open the editor over the shell. → Promise<opened?> (false before login,
   *  or when the current layout could not be read). */
  function open(opts) {
    if (!L.isReady()) return Promise.resolve(false);
    if (!KEYS) KEYS = (window.ycAll && window.ycAll.keys) || null;
    if (!KEYS) { console.error('[ycLayoutEditor] ycAll.keys missing — load order'); return Promise.resolve(false); }
    build();
    var section = opts && opts.section;
    if (isOpen()) { if (section) showPane(section); return Promise.resolve(true); }
    if (loading) return loading;
    if (typeof window.apiSend !== 'function') { notice(LOAD_FAIL); return Promise.resolve(false); }
    var from = document.activeElement;
    notice('');
    busy(true);
    loading = Promise.resolve()
      .then(function () { return window.apiSend('/api/ui-config', 'GET'); })
      .then(function (r) {
        if (!isObj(r)) throw new Error('no layers in the response');
        var fresh = { firm: isObj(r.firm) ? r.firm : {}, user: isObj(r.user) ? r.user : {} };
        syncShell(fresh);
        show(fresh, from, section);
        return true;
      })
      .catch(function (e) {
        if (typeof console !== 'undefined') console.warn('[ycLayoutEditor] layout read failed — not opened:', e && e.message);
        notice(LOAD_FAIL);
        return false;
      })
      .then(function (ok) { loading = null; busy(false); return ok; });
    return loading;
  }
  // The All button: busy while the read is out; a failure message beside it
  // (or a toast when the editor was opened from elsewhere).
  function busy(on) {
    var b = document.getElementById('ycAllCustomize');
    if (!b) return;
    b.disabled = !!on;
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  }
  function notice(msg) {
    var b = document.getElementById('ycAllCustomize');
    var m = document.getElementById('ycAllCustomizeMsg');
    if (!m && b && msg) {
      m = el('span', 'yc-all-msg');
      m.id = 'ycAllCustomizeMsg';
      m.setAttribute('role', 'alert');
      b.parentNode.insertBefore(m, b);
    }
    if (m) { m.textContent = msg || ''; m.hidden = !msg; return; }
    if (msg) toast('error', msg);
  }
  function syncShell(fresh) {
    var fd = window.firmData;
    if (!fd) return;
    var ui = isObj(fd.ui) ? fd.ui : {};
    var cur = { firm: isObj(ui.firm) ? ui.firm : {}, user: isObj(ui.user) ? ui.user : {} };
    if (canonical(cur) === canonical(fresh)) return;
    var next = {};
    for (var k in ui) if (hasOwn(ui, k)) next[k] = ui[k];
    next.firm = fresh.firm;
    next.user = fresh.user;
    fd.ui = next;
    L.applyAccess({ ui: fd.ui });
  }
  function show(ui, from, section) {
    sessOpts = {
      stored: storedOf(ui), effective: L.effectiveRegistry(), locked: lockedOf(ui),
      base: window.DEFAULT_LAYOUTS || {}, registry: window.FEATURE_REGISTRY || {}, groups: L.groups(),
    };
    sess = session(sessOpts);
    scs = newShortcutSession(shortcutsOf(ui));
    scAdd = null;
    root.querySelector('.ysc-add').hidden = true;
    labelErr = {};
    saving = false;
    clearErrors();
    root.querySelectorAll('.yle-picker, .yle-label-add').forEach(function (n) { n.hidden = true; });
    freeze(false);
    render();
    opener = from && from !== document.body ? from : document.getElementById('ycAllCustomize');
    root.hidden = false;
    showPane(section);
    window.addEventListener('beforeunload', onBeforeUnload);
    var first = paneShown() === 'shortcuts'
      ? root.querySelector('.ysc-sec [data-act="sc-open"]:not(:disabled)')
      : root.querySelector('.yle-rows button:not(:disabled)');
    first = first || root.querySelector('.yle-cancel');
    if (first) first.focus();
  }
  function closeNow() {
    if (!root) return;
    root.hidden = true;
    sess = null;
    scs = null;
    scAdd = null;
    labelErr = {};
    window.removeEventListener('beforeunload', onBeforeUnload);
    try { if (opener && opener.focus && opener.isConnected) opener.focus(); } catch (_) { /* gone */ }
    opener = null;
  }
  /** Close; asks first when there are unsaved changes. → Promise<closed?> */
  function requestClose() {
    if (!isOpen()) return Promise.resolve(true);
    if (saving) return Promise.resolve(false);
    if (!anyDirty() && !Object.keys(labelErr).length) { closeNow(); return Promise.resolve(true); }
    return ask('Discard your unsaved launcher changes?', 'Discard', 'Keep editing').then(function (yes) {
      if (yes) closeNow();
      return yes;
    });
  }
  function isOpen() { return !!(root && !root.hidden); }
  function isDirty() { return !!(isOpen() && anyDirty()); }

  // The shell's copy of the user layer — saved = { layout?, shortcuts? }, the
  // stored documents — then the launcher re-run with it, once (which also
  // rebuilds ycAll's shortcut map).
  function applyToShell(saved) {
    var fd = window.firmData;
    if (!fd) return false;
    var ui = isObj(fd.ui) ? fd.ui : { firm: {}, user: {} };
    var user = {};
    if (isObj(ui.user)) for (var k in ui.user) if (hasOwn(ui.user, k)) user[k] = ui.user[k];
    for (var s in saved) if (hasOwn(saved, s)) user[s] = saved[s];
    var next = {};
    for (var j in ui) if (hasOwn(ui, j)) next[j] = ui[j];
    next.user = user;
    fd.ui = next;
    L.applyAccess({ ui: fd.ui });
    return true;
  }

  function toast(icon, title) {
    try { if (window.Toast && typeof window.Toast.fire === 'function') window.Toast.fire({ icon: icon, title: title }); } catch (_) { /* no toast */ }
  }

  // While a save is out: the panel's text boxes read-only (its clicks are
  // ignored in onClick), so nothing is typed that the PUT would not carry.
  function freeze(on) {
    root.querySelectorAll('input').forEach(function (n) { if (!n.classList.contains('ysc-capture')) n.readOnly = !!on; });
  }
  // Save: each dirty document is its own PUT — layout, then shortcuts; the
  // second is sent whatever became of the first. All saved: the shell takes
  // them, the panel closes. Anything refused: the panel stays open with
  // every edit, what DID save becomes the new stored state (its tab is
  // clean), and the banner says which part failed.
  var PART_NAME = { layout: 'launcher layout', shortcuts: 'keyboard shortcuts' };
  function save() {
    if (!isOpen() || saving) return Promise.resolve(false);
    clearErrors();
    if (Object.keys(labelErr).length) {
      showPane('layout');
      banner('Fix the highlighted section label first.');
      var bad = root.querySelector('.yle-label-in[aria-invalid="true"]');
      if (bad) bad.focus();
      return Promise.resolve(false);
    }
    if (!anyDirty()) { closeNow(); return Promise.resolve(true); }
    if (typeof window.apiSend !== 'function') { banner('Saving is not available on this page.', true); return Promise.resolve(false); }
    var parts = [];
    if (sess.isDirty()) parts.push({ key: 'layout', doc: sess.doc() });
    if (scs.isDirty()) parts.push({ key: 'shortcuts', doc: scs.doc() });
    saving = true;
    freeze(true);
    renderStatus();
    root.querySelector('.yle-status').textContent = 'Saving…';
    var res = {};
    var chain = Promise.resolve();
    parts.forEach(function (p) {
      chain = chain
        .then(function () { return window.apiSend('/api/ui-config', 'PUT', { scope: 'user', config_key: p.key, config: p.doc }); })
        .then(function (r) { res[p.key] = { ok: true, config: r && isObj(r.config) ? r.config : p.doc }; },
          function (e) { res[p.key] = { ok: false, e: e }; });
    });
    return chain.then(function () {
      saving = false;
      var saved = {}, failed = [], said = [];
      parts.forEach(function (p) { if (res[p.key].ok) saved[p.key] = res[p.key].config; else failed.push(p.key); });
      if (Object.keys(saved).length) applyToShell(saved);
      if (!failed.length) {
        closeNow();
        toast('success', 'Saved — your launcher is updated');
        return true;
      }
      freeze(false);
      if (!isOpen()) return false;
      if (hasOwn(saved, 'layout')) { sessOpts.stored = saved.layout; sessOpts.effective = L.effectiveRegistry(); sess = session(sessOpts); }
      if (hasOwn(saved, 'shortcuts')) scs = newShortcutSession(saved.shortcuts);
      if (Object.keys(saved).length) render(); else renderStatus();
      var both = parts.length > 1;
      parts.forEach(function (p) {
        if (res[p.key].ok) { said.push('Your ' + PART_NAME[p.key] + (p.key === 'layout' ? ' was' : ' were') + ' saved.'); return; }
        var e = res[p.key].e;
        if (e && e.status === 400 && e.body && isArr(e.body.errors) && e.body.errors.length) {
          var general = placeErrors(p.key, e.body.errors);
          said.push((both ? 'The server refused your ' + PART_NAME[p.key] + '.' : 'The server refused the save.') +
            (general.length ? ' ' + general.join(' · ')
              : ' See the messages under ' + (p.key === 'layout' ? 'each section.' : 'Keyboard shortcuts.')));
        } else {
          var why = (e && e.message) || 'request failed';
          said.push(both ? 'Your ' + PART_NAME[p.key] + ' did not save: ' + why + '.' : 'Save failed: ' + why + '.');
        }
      });
      said.push('Your changes are still here.');
      if (failed.indexOf(paneShown()) < 0) showPane(failed[0]);
      banner(said.join(' '), true);
      return false;
    });
  }

  var cust = document.getElementById('ycAllCustomize');
  if (cust) cust.addEventListener('click', function () { open(); });

  window.ycLayoutEditor = {
    open: open, close: requestClose, isOpen: isOpen, isDirty: isDirty,
    session: session, labelProblem: labelProblem, canonical: canonical,
    shortcutSession: shortcutSession, reservedProblem: reservedProblem,
  };
})();
