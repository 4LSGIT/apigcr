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
 * The document's third surface, homeIcons (Home's icon row, ui-custom S6c),
 * has no section here yet (S6c-3): its placed / removed lists ride through a
 * save untouched (PASS below), so saving Home never drops them.
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
 * only through /js/ycIcon.js (a value that fails the grammar draws
 * circle-question). Styles: the #ycLayoutEditor block in index.html
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
 * The tabs share one Save: each dirty document is its own PUT (items, then
 * layout, then shortcuts); a failure in any keeps every set of edits open,
 * says which failed, and what did save becomes the new stored state. After a save the
 * shell's firmData.ui.user is updated and applyAccess re-run once, which also
 * rebuilds ycAll's shortcut map (its 'ycLauncherAccess' listener).
 *
 *
 * My buttons (ui-custom S5a): the panel's third tab. The user's ui_config
 * `items` document, { items: [ { id, label, icon, action } ] } — their own
 * buttons, the firm item grammar with user:<slug> ids (lib/uiConfigShape.js):
 * a saved view or a tool (opening in the tool dialog, Large or Compact, or —
 * S5c-b — as a tab) or a link (always a new window). Its icon is chosen in the shell's icon picker
 * (/js/ycIconPicker.js: any free Font Awesome icon, solid / regular /
 * brands — ui-custom S6a), never typed. A list (icon, name, what it opens, where it is
 * placed and bound; move, edit, delete, "Add to Home" / "Add to sidebar") and
 * one add / edit form; the tool and view lists come from GET
 * /api/ui-config/pickers, read the first time the tab shows. Ids come from the
 * name (user:<slug>), unique against every button, the ids the user's layout
 * and shortcuts name, and the server's retired list; a saved button's id never
 * changes. While the panel is open the other two tabs work from an effective
 * registry with the EDITED buttons in it (editorEffective), so a new button
 * can be placed and bound before it is saved; deleting a button drops its
 * placements and bindings in the same session (it asks first when it has
 * any). Save sends up to three documents, items first; see save().
 *
 * Drawers (ui-custom S5b): a button may be a DRAWER — { type:'drawer', items:
 * [id…] }, a menu of up to 30 other items the shell opens beside the tile /
 * row that opened it. It is one more kind in the same form ("A drawer"), and
 * its contents are an ordered list there: add (the "find a feature" picker
 * over the editor's effective registry, minus drawers — one level deep — and
 * minus what the drawer already holds), remove, ↑ / ↓. A drawer is placed and
 * bound like any button. A button inside a drawer can't become a drawer, and
 * its id is frozen once a drawer holds it (as when placed or bound). Deleting
 * a button drops it from every drawer too, in the same session (the delete
 * prompt names them), so the items document never names a deleted button.
 *
 * Tabs (ui-custom S5c-b): a tool or saved view button "Opens in" a dialog
 * (large / compact) or A TAB — present:'tab', the shell's button tab
 * (window.ycButtonTabs, up to 3 pages kept open). The legacy custom tab
 * (users.user_custom_tab, Settings → My Custom Tab) is read here too: when it
 * shows a tool or a saved view, the tab offers "Make my custom tab a button" —
 * one click adds a tab button for the same page (or reuses one an earlier
 * conversion made) where the custom tab is on Home and the sidebar, and Save
 * then clears the old tab through its own route, after the buttons and layout
 * saved. Any other custom tab stays as it is, and the tab says why
 * (legacyTab).
 *
 * window.ycLayoutEditor = { open, close, isOpen, isDirty, session, shortcutSession, reservedProblem,
 *                           itemSession, makeUserId, buttonProblems, legacyTab }
 *   session(o) is the editor's pure core (no DOM; the panel drives one):
 *   o = { stored, effective, locked, base, registry, groups } — see session().
 *   shortcutSession(o) is the Keyboard shortcuts tab's, itemSession(o) My
 *   buttons': see there.
 *   open({ section: 'shortcuts' | 'buttons' }) opens on that tab (default: the layout).
 */
(function () {
  'use strict';
  var L = window.ycLauncher;
  if (!L || typeof L.resolveLayout !== 'function') {
    if (typeof console !== 'undefined') console.error('[ycLayoutEditor] ycLauncher missing — load order');
    return;
  }
  var YI = window.ycIcon;     // the stored icon value → classes (/js/ycIcon.js, ui-custom S6a)
  if (!YI) {
    if (typeof console !== 'undefined') console.error('[ycLayoutEditor] ycIcon missing — load order');
    return;
  }

  var SURFACES = ['home', 'sidebar'];
  // Surfaces of the user layout this editor does not show yet (ui-custom S6c:
  // Home's icon row — its editor is S6c-3): their lists are written back as
  // stored, so a save never drops them. { item } entries only, as the server has it.
  var PASS = ['homeIcons'];
  var NAME = { home: 'Home', sidebar: 'Sidebar' };
  var CAP = 100;          // lib/uiConfigShape.js CAPS.placed / CAPS.removed
  var LABEL_MAX = 40;     // lib/uiConfigShape.js LABEL_MAX
  var ICON_RE = YI.RE;    // bare slug = solid, or solid: / regular: / brands: + slug (lib/uiConfigShape.js ICON_RE)
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
    SURFACES.concat(PASS).forEach(function (sf) {
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
    // eff / byId / groups: the items the editor can show. retarget() replaces
    // them while the panel is open — the My buttons tab (S5a) adds, renames
    // and deletes the user's own buttons before they are saved.
    var eff, byId, groups;
    function setEffective(list, g) {
      eff = isArr(list) ? list.filter(function (e) { return isObj(e) && typeof e.id === 'string'; }) : [];
      byId = Object.create(null);
      eff.forEach(function (e) { byId[e.id] = e; });
      groups = isArr(g) ? g.slice() : [];
    }
    setEffective(o.effective, o.groups);
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
    // of a surface that has nothing stored is no change. Never back to a
    // stored surface that names a dropped id (a deleted button, S5a): that
    // would write the reference dropId took out.
    var dropped = Object.create(null);
    var swapped = Object.create(null);   // newId → the oldId it replaced (replace, S5c-b)
    function storedNames(sf, id) {
      return (hasOwn(stored.placed, sf) && indexOfItem(stored.placed[sf], id) >= 0)
        || (hasOwn(stored.removed, sf) && stored.removed[sf].indexOf(id) >= 0);
    }
    function settle(sf) {
      var st = S[sf];
      for (var d in dropped) if (storedNames(sf, d)) return;
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
        if (USER_ID_RE.test(e.item)) return;   // a button that is gone (deleted / retired): never carried (review N1)
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
        var order = groups.slice();
        list.forEach(function (e) { if (order.indexOf(e.group) < 0) order.push(e.group); });
        return order.map(function (g) {
          return { group: g, items: list.filter(function (e) { return e.group === g; }).map(function (e) { return entryView(sf, e); }) };
        }).filter(function (g) { return g.items.length; });
      },
      /** The surfaces an id is visible on: ['home'?, 'sidebar'?]. */
      where: function (id) {
        return SURFACES.filter(function (sf) { return !!visibleIds(resolved(sf))[id]; });
      },
      /** A new effective registry (and group order) — the panel's own
       *  buttons changed (S5a). Nothing stored or edited changes. */
      // …and a surface edited back to what it was becomes the stored one again
      // under the new registry (S5c-b review N1: a conversion cancelled by
      // deleting its button was settled while `custom` was out of it).
      retarget: function (list, g) { setEffective(list, g); SURFACES.forEach(settle); return true; },
      /** A button the user deleted (S5a): drop every placement and removal
       *  of id on both surfaces — a surface that held it becomes edited —
       *  so no dangling reference is written. → whether anything changed. */
      dropId: function (id) {
        var any = false;
        if (typeof id !== 'string') return false;
        dropped[id] = true;
        SURFACES.forEach(function (sf) {
          var st = S[sf];
          var placed = st.mode === 'stored' ? (hasOwn(stored.placed, sf) ? stored.placed[sf] : null) : st.placed;
          var removed = st.mode === 'stored' ? (hasOwn(stored.removed, sf) ? stored.removed[sf] : []) : st.removed;
          var inPlaced = !!placed && indexOfItem(placed, id) >= 0, inRemoved = removed.indexOf(id) >= 0;
          if (!inPlaced && !inRemoved) return;
          any = true;
          // a button that took another item's place (replace, S5c-b) gives
          // the place back: the item returns to that very slot, so a
          // cancelled conversion leaves the surface as it was (review N1)
          var back = swapped[id];
          S[sf] = {
            mode: 'edited',
            placed: placed ? placed.map(function (e) { return e.item === id ? (back ? { item: back } : null) : copyEntry(e, sf); }).filter(Boolean) : null,
            removed: without(removed, id),
          };
          settle(sf);
        });
        return any;
      },
      /** The legacy custom tab became a button (S5c-b): on each surface
       *  where oldId shows, newId takes its place — unless newId already
       *  shows there. oldId leaves that surface's placed list (it is in this
       *  session's registry right now, so carry() never puts it back); while
       *  it is still effective the resolver would slot it back in as a base
       *  item, so the panel retargets without it (editorEffective). → the
       *  surfaces changed. */
      replace: function (oldId, newId) {
        var out = [];
        if (typeof newId !== 'string' || !(newId in byId)) return out;
        SURFACES.forEach(function (sf) {
          var rows = resolved(sf), at = -1;
          for (var i = 0; i < rows.length; i++) if (rows[i].kind === 'item' && rows[i].id === oldId) at = i;
          if (at < 0 || visibleIds(rows)[newId]) return;
          rows[at] = { kind: 'item', id: newId };
          if (sizeAfter(sf, rows) > CAP) return;
          commit(sf, rows, without(S[sf].removed, newId));
          swapped[newId] = oldId;
          out.push(sf);
        });
        return out;
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
            // placed is null only when dropId emptied a removal on a surface
            // that follows the base layout: that surface keeps no placed list
            if (st.placed) out.placed[sf] = st.placed.map(function (e) { return copyEntry(e, sf); });
            if (st.removed.length) out.removed[sf] = st.removed.slice();
          }
        });
        // the surfaces this editor does not show (S6c): exactly as stored
        PASS.forEach(function (sf) {
          if (hasOwn(stored.placed, sf)) out.placed[sf] = stored.placed[sf].map(function (e) { return copyEntry(e, sf); });
          if (hasOwn(stored.removed, sf)) out.removed[sf] = stored.removed[sf].slice();
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
    var eff, byId, groups;                // retarget() replaces them (S5a)
    function setEffective(list, g) {
      eff = isArr(list) ? list.filter(function (e) { return isObj(e) && typeof e.id === 'string'; }) : [];
      byId = Object.create(null);
      eff.forEach(function (e) { byId[e.id] = e; });
      groups = isArr(g) ? g.slice() : [];
    }
    setEffective(o.effective, o.groups);
    var reg = isObj(o.registry) ? o.registry : {};
    function norm(doc) {
      var out = { bindings: [] };
      if (isObj(doc) && isArr(doc.bindings)) doc.bindings.forEach(function (b) {
        var c = isObj(b) && typeof b.id === 'string' && b.id ? K.cleanCombo(b.combo) : null;
        if (c && USER_ID_RE.test(b.id) && !(b.id in byId)) c = null;   // a button that is gone (review N1)
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
        var order = groups.slice();
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
      /** The combos bound to id, written for this platform. */
      combosOf: function (id) {
        return B.filter(function (b) { return b.id === id; }).map(function (b) { return fmt(b.combo); });
      },
      /** A new effective registry (and group order): the panel's own buttons
       *  changed (S5a). */
      retarget: function (list, g) { setEffective(list, g); return true; },
      /** A button the user deleted (S5a): drop its bindings. → how many. */
      dropId: function (id) {
        var n = B.length;
        B = B.filter(function (b) { return b.id !== id; });
        return n - B.length;
      },
      /** The document Save writes: the full bindings list. */
      doc: function () { return { bindings: B.map(copy) }; },
      isDirty: function () { return canonical(api.doc()) !== canonical(stored); },
    };
    return api;
  }

  // ── My buttons (S5a) ────────────────────────────────────────────────────
  var MB_CAP = 50;                                // lib/uiConfigShape.js CAPS.items
  var HREF_MAX = 2000;                            // lib/uiConfigShape.js HREF_MAX
  var USER_ID_RE = /^user:[a-z0-9-]{1,40}$/;      // lib/uiConfigShape.js USER_ID_RE
  var TOOL_KEY_RE = /^[a-z0-9-]{1,80}$/;          // routes/api.tools.js TOOL_KEY_RE
  var VIEW_KEY_RE = /^[a-z][a-z0-9_]{2,59}$/;     // lib/uiConfigShape.js VIEW_KEY_RE
  var MB_KINDS = ['view', 'tool', 'url', 'drawer'];
  var DRAWER_CAP = 30;                            // lib/uiConfigShape.js CAPS.drawer
  var TAB_KEEP = 3;                               // index.html ycButtonTabs MAX: pages kept open
  var MINE = 'Mine';                              // ycLauncher's group for them
  var ADMIN = 'Admin';                            // ycLauncher's GRID_GROUP.admin

  /** label → 'user:<slug>' that no id in `taken` holds (public/caseconfig/
   *  firm.html makeId, with the user: prefix). */
  function slugOf(label) {
    return String(label == null ? '' : label).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function makeUserId(label, taken) {
    var base = slugOf(label).slice(0, 40).replace(/-+$/, '') || 'button';
    var id = 'user:' + base;
    for (var n = 2; taken[id]; n++) {
      var suf = '-' + n;
      id = 'user:' + (base.slice(0, 40 - suf.length).replace(/-+$/, '') || 'button') + suf;
    }
    return id;
  }
  /** Every user: id anywhere in v (a layout or shortcuts document). */
  function userIdsIn(v, out) {
    out = out || Object.create(null);
    if (typeof v === 'string') { if (USER_ID_RE.test(v)) out[v] = true; return out; }
    if (isArr(v)) v.forEach(function (x) { userIdsIn(x, out); });
    else if (isObj(v)) for (var k in v) if (hasOwn(v, k)) userIdsIn(v[k], out);
    return out;
  }
  // ── The legacy custom tab (users.user_custom_tab, ui-custom S5c-b) ──────
  // Read both, write new: the old tab keeps working until its user turns it
  // into a button (My buttons: "Make my custom tab a button"). Only a tab
  // showing a tool or a saved view can be one — the two pages a button opens
  // as a tab; any other page (an app page, an SU-set outside site) stays as it
  // is, and the tab says why. So does a tab with an IT-set loadFunc (an extra
  // step on opening, which a button can't carry).
  var LEGACY_TOOL_RE = /^\/tool\/([a-z0-9-]{1,80})$/;                  // TOOL_KEY_RE
  var LEGACY_VIEW_RE = /^\/customView\.html\?key=([a-z][a-z0-9_]{2,59})$/;   // VIEW_KEY_RE
  /** A user_custom_tab value → null (no custom tab) |
   *    { ok: true, title, button: { label, icon, type, key, size: 'tab' } } |
   *    { ok: false, title, why }   (why: a sentence, shown as text) */
  function legacyTab(ct) {
    if (typeof ct === 'string') { try { ct = JSON.parse(ct); } catch (_) { ct = null; } }
    if (!isObj(ct) || typeof ct.src !== 'string' || !ct.src.trim()) return null;
    var t = typeof ct.title === 'string' ? ct.title.trim() : '';
    var title = !t || labelProblem(t) ? 'Custom Tab' : t;     // applyCustomTab's own fallback
    var src = ct.src.trim(), m;
    var kind = (m = LEGACY_TOOL_RE.exec(src)) ? 'tool' : (m = LEGACY_VIEW_RE.exec(src)) ? 'view' : null;
    if (!kind) {
      return { ok: false, title: title, why: /^[a-z][a-z0-9+.-]*:/i.test(src)
        ? 'It shows another website, and a button never shows another website inside YisraCase.'
        : 'It shows a page that is not a tool or a saved view, and only those can be a button that opens as a tab.' };
    }
    if (ct.loadFunc && !(typeof ct.loadFunc === 'string' && !ct.loadFunc.trim())) {   // applyCustomTab runs any truthy value
      return { ok: false, title: title, why: 'It runs an extra step when it opens, set up for you by IT, and a button can\u2019t do that.' };
    }
    var icon = typeof ct.icon === 'string' && ICON_RE.test(ct.icon) ? ct.icon : 'bug';   // no icon: the bug applyCustomTab draws
    return { ok: true, title: title, button: { label: title, icon: icon, type: kind, key: m[1], size: 'tab' } };
  }

  /** The field problems of a button form: { label?, icon?, key?, href? }. */
  function buttonProblems(f) {
    var p = {};
    var lp = labelProblem(f.label);
    if (lp) p.label = lp === 'Type a label' ? 'Give it a name' : lp;
    if (!ICON_RE.test(String(f.icon == null ? '' : f.icon).trim())) p.icon = 'Choose an icon';
    if (f.type === 'url') {
      var h = String(f.href == null ? '' : f.href).trim();
      if (!h) p.href = 'Type the address';
      else if (h.length > HREF_MAX) p.href = 'At most ' + HREF_MAX + ' characters';
      else if (/[\s\\]/.test(h) || CONTROL_RE.test(h)) p.href = 'No spaces, backslashes or control characters';
      else if (h.charAt(0) === '/') { if (h.charAt(1) === '/') p.href = 'Use https://… for another website'; }
      else if (!/^https:\/\/[^/]/i.test(h)) p.href = 'Start it with https:// (a secure website address)';
    } else if (f.type === 'tool' || f.type === 'view') {
      var k = String(f.key == null ? '' : f.key);
      if (!(f.type === 'tool' ? TOOL_KEY_RE : VIEW_KEY_RE).test(k)) p.key = f.type === 'tool' ? 'Choose a tool' : 'Choose a saved view';
    } else if (f.type === 'drawer') {
      var refs = isArr(f.refs) ? f.refs : [];
      if (refs.length > DRAWER_CAP) p.refs = 'A drawer holds at most ' + DRAWER_CAP + ' items';
      else if (refs.some(function (r, i) { return typeof r !== 'string' || refs.indexOf(r) !== i; })) p.refs = 'Each item can be in the drawer once';
    } else p.type = 'Choose what it opens';
    return p;
  }

  /**
   * The My buttons tab's core — pure: no DOM, no network.
   *   o.stored   the user's stored items document { items, retired? } (or null)
   *   o.pickers  { tools: [{ key, title }], views: [{ key, title }] } or null
   *              (the lists could not be read)
   *   o.clean    the shell's client grammar for a button (ycLauncher.cleanUserItem)
   *   o.refs     () → ids the user's layout and shortcuts name now (stored and
   *              edited): a NEW button never takes one, and a new button
   *              already placed or bound keeps its id
   * A row: { id, saved, kept, label, icon, type, key, href, size, present, refs, orig }
   * (refs: a drawer's contents, S5b; present: 'modal' | 'tab' for a tool /
   * view, S5c-b — the form's size field carries 'tab' for it). A
   * stored button the client grammar refuses is KEPT as it is (shown, never
   * edited, removable). Ids: from the label (user:<slug>), unique against
   * every button, every stored id, the server's retired list and o.refs();
   * a new button's id follows its label until it is placed, bound or saved;
   * a saved one never changes.
   */
  function itemSession(o) {
    o = o || {};
    var clean = typeof o.clean === 'function' ? o.clean : function () { return null; };
    var refs = typeof o.refs === 'function' ? o.refs : function () { return {}; };
    var pk = isObj(o.pickers) ? o.pickers : null;
    var sd = isObj(o.stored) ? o.stored : {};
    var storedItems = isArr(sd.items) ? sd.items.filter(isObj) : [];
    var retired = isArr(sd.retired) ? sd.retired.filter(function (id) { return typeof id === 'string'; }) : [];
    function rowOf(it) {
      var c = clean(it);
      if (!c) return { kept: true, saved: true, id: typeof it.id === 'string' ? it.id : '', orig: it };
      var a = c.action;
      return {
        kept: false, saved: true, orig: c, id: c.id, label: c.label, icon: c.icon, type: a.type,
        key: a.type === 'url' || a.type === 'drawer' ? '' : a.key, href: a.type === 'url' ? a.href : '',
        size: a.type === 'tool' || a.type === 'view' ? (a.size === 'compact' ? 'compact' : 'large') : 'large',
        present: (a.type === 'tool' || a.type === 'view') && a.present === 'tab' ? 'tab' : 'modal',
        refs: a.type === 'drawer' ? a.items.slice() : [],
      };
    }
    var R = storedItems.map(rowOf);
    var storedIds = Object.create(null);
    storedItems.forEach(function (it) { if (typeof it.id === 'string') storedIds[it.id] = true; });

    function itemOf(r) {
      if (r.kept) return r.orig;
      if (r.type === 'drawer') {
        return { id: r.id, label: String(r.label).trim(), icon: String(r.icon).trim(), action: { type: 'drawer', items: (r.refs || []).slice() } };
      }
      var oa = r.orig && isObj(r.orig.action) && r.orig.action.type === r.type ? r.orig.action : null;
      var tab = r.type !== 'url' && r.present === 'tab';
      var action = r.type === 'url'
        ? { type: 'url', href: String(r.href).trim(), present: 'window' }
        : { type: r.type, key: r.key, present: tab ? 'tab' : 'modal' };
      // the dialog size (S3.3): compact written; large stays ABSENT unless
      // the stored action named a size (as the Firm tab does). A tab (S5c-b)
      // has no size.
      if (r.type !== 'url' && !tab) {
        if (r.size === 'compact') action.size = 'compact';
        else if (oa && hasOwn(oa, 'size')) action.size = 'large';
      }
      return { id: r.id, label: String(r.label).trim(), icon: String(r.icon).trim(), action: action };
    }
    function taken(except) {
      var t = Object.create(null), ext = refs() || {};
      for (var k in ext) t[k] = true;
      for (var s in storedIds) t[s] = true;
      retired.forEach(function (id) { t[id] = true; });
      R.forEach(function (r) { if (r !== except && r.id) t[r.id] = true; });
      // the ids drawers name (S5b), stored or as edited: a new button never
      // takes one — it would land in that drawer
      storedItems.concat(R.map(function (r) { return r.kept ? null : { action: { type: r.type, items: r.refs } }; })).forEach(function (it) {
        var a = it && isObj(it.action) ? it.action : null;
        if (a && a.type === 'drawer' && isArr(a.items)) a.items.forEach(function (id) { if (typeof id === 'string' && USER_ID_RE.test(id)) t[id] = true; });
      });
      return t;
    }
    /** The drawers (rows) holding id, in order. */
    function holders(id) {
      return R.filter(function (r) { return !r.kept && r.type === 'drawer' && (r.refs || []).indexOf(id) >= 0; });
    }
    function titleOf(type, key) {
      var list = pk ? (type === 'tool' ? pk.tools : pk.views) : null;
      var hit = isArr(list) ? list.filter(function (x) { return isObj(x) && x.key === key; })[0] : null;
      if (hit) return String(hit.title == null || hit.title === '' ? key : hit.title);
      return pk ? key + (type === 'tool' ? ' (not live)' : ' (not found)') : key;
    }
    function summary(r) {
      if (r.kept) return 'Can’t be edited here (it breaks today’s rules); it is kept as it is';
      if (r.type === 'drawer') {
        var n = (r.refs || []).length;
        return 'Drawer · ' + (n ? n + (n === 1 ? ' item' : ' items') : 'empty');
      }
      if (r.type === 'url') {
        var h = String(r.href).trim();
        if (h.charAt(0) === '/') return 'Link · ' + h + ' (new window)';
        try { return 'Link · ' + new URL(h).hostname + ' (new window)'; } catch (_) { return 'Link (new window)'; }
      }
      return (r.type === 'tool' ? 'Tool' : 'Saved view') + ' · ' + titleOf(r.type, r.key) +
        (r.present === 'tab' ? ' (opens as a tab)' : r.size === 'compact' ? ' (compact)' : '');
    }
    // r: the row being edited (null for a new one)
    function fieldsOk(f, r) {
      var p = buttonProblems(f);
      if (f.type === 'drawer' && !p.refs && isArr(f.refs)) {
        // one level deep: no drawer inside a drawer, and a button a drawer
        // holds can't become one
        var drawerIds = Object.create(null);
        R.forEach(function (x) { if (x !== r && !x.kept && x.type === 'drawer') drawerIds[x.id] = true; });
        if (r && f.refs.indexOf(r.id) >= 0) p.refs = 'A drawer can’t hold itself';
        else if (f.refs.some(function (id) { return id in drawerIds; })) p.refs = 'A drawer can’t hold another drawer';
        var inside = r ? holders(r.id).filter(function (x) { return x !== r; }) : [];
        if (inside.length) p.type = 'It is inside the drawer “' + inside[0].label + '”: a drawer can’t go inside a drawer. Take it out of that drawer first.';
      }
      if (Object.keys(p).length) return p;
      // the shell's own grammar has the last word (a root-relative link to a
      // page that needs the shell, /tool/… or /customView…, is refused there)
      var pr = { id: 'user:probe', kept: false, orig: null };
      apply(pr, { label: f.label, icon: f.icon, type: f.type, key: f.key || '', href: f.href || '', size: f.size, refs: f.refs });
      var probe = itemOf(pr);
      if (!clean(probe)) {
        return f.type === 'url'
          ? { href: String(f.href).trim().charAt(0) === '/'
            ? 'That page only works inside YisraCase: make a Tool or Saved view button for it instead'
            : 'That isn’t a usable https:// address' }
          : f.type === 'drawer' ? { refs: 'Those items can’t be in a drawer' } : { key: 'That choice can’t be used' };
      }
      return null;
    }
    function apply(r, f) {
      r.label = String(f.label).trim();
      r.icon = String(f.icon).trim();
      r.type = f.type;
      r.key = f.type === 'tool' || f.type === 'view' ? String(f.key) : '';
      r.href = f.type === 'url' ? String(f.href).trim() : '';
      r.size = (f.type === 'tool' || f.type === 'view') && f.size === 'compact' ? 'compact' : 'large';
      // the form's "Opens in" (S5c-b): 'large' | 'compact' (the dialog) | 'tab'
      r.present = (f.type === 'tool' || f.type === 'view') && f.size === 'tab' ? 'tab' : 'modal';
      r.refs = f.type === 'drawer' && isArr(f.refs) ? f.refs.slice() : [];
    }

    var api = {
      /** The rows as shown: [{ id, label, icon, type, summary, kept, saved,
       *  inDrawers: [drawer label…] }]. */
      list: function () {
        return R.map(function (r) {
          return {
            id: r.id, label: r.kept ? String(isObj(r.orig) && typeof r.orig.label === 'string' ? r.orig.label : r.id) : r.label,
            icon: !r.kept && ICON_RE.test(r.icon) ? r.icon : 'circle-question', type: r.kept ? null : r.type,
            summary: summary(r), kept: r.kept, saved: r.saved,
            inDrawers: holders(r.id).map(function (x) { return x.label; }),
          };
        });
      },
      /** A row's form values (null for a kept row). */
      fields: function (i) {
        var r = R[i];
        return r && !r.kept ? { label: r.label, icon: r.icon, type: r.type, key: r.key, href: r.href,
          size: r.present === 'tab' ? 'tab' : r.size, refs: (r.refs || []).slice() } : null;
      },
      /** i: the row being edited (omit for a new one). */
      problems: function (f, i) { return fieldsOk(f, i >= 0 ? R[i] || null : null) || {}; },
      /** The id a NEW button with this label would get. */
      previewId: function (label) { return makeUserId(label, taken(null)); },
      /** Add a button. → { ok: true, id, i } | { ok: false, problems }. */
      add: function (f) {
        if (R.length >= MB_CAP) return { ok: false, problems: { label: 'You have the most buttons there can be (' + MB_CAP + ')' } };
        var p = fieldsOk(f, null);
        if (p) return { ok: false, problems: p };
        var r = { kept: false, saved: false, orig: null };
        apply(r, f);
        r.id = makeUserId(r.label, taken(null));
        R.push(r);
        return { ok: true, id: r.id, i: R.length - 1 };
      },
      /** Change button i. A new one's id follows its label unless the
       *  layout or shortcuts already name it. → as add. */
      update: function (i, f) {
        var r = R[i];
        if (!r || r.kept) return { ok: false, problems: { label: 'That button can’t be edited here' } };
        var p = fieldsOk(f, r);
        if (p) return { ok: false, problems: p };
        apply(r, f);
        if (!r.saved && !(refs() || {})[r.id] && !holders(r.id).length) r.id = makeUserId(r.label, taken(r));
        return { ok: true, id: r.id, i: i };
      },
      /** Delete button i. → its id, or null. */
      remove: function (i) {
        var r = R[i];
        if (!r) return null;
        R.splice(i, 1);
        return r.id;
      },
      move: function (i, d) {
        var j = i + d;
        if (!(i >= 0 && i < R.length && j >= 0 && j < R.length) || (d !== 1 && d !== -1)) return false;
        var t = R[i]; R[i] = R[j]; R[j] = t;
        return true;
      },
      /** A button deleted (S5b): drop id from every drawer. → how many held it. */
      dropRef: function (id) {
        var n = 0;
        R.forEach(function (r) {
          if (r.kept || r.type !== 'drawer') return;
          var k = (r.refs || []).indexOf(id);
          if (k >= 0) { r.refs.splice(k, 1); n++; }
        });
        return n;
      },
      /** The drawers' ids (one level deep: none of them can go in a drawer). */
      drawerIds: function () { return R.filter(function (r) { return !r.kept && r.type === 'drawer'; }).map(function (r) { return r.id; }); },
      /** What a drawer can take: the entries of `effective` (an effective
       *  registry) that are not drawers and not in `refs`, grouped like All
       *  (`groups` order) — or one ranked group for a query (rank: the All
       *  tab's matcher). → [{ group, items: [{ id, label, icon, group }] }] */
      drawerCandidates: function (effective, groups, refsNow, query, rank) {
        var no = Object.create(null);
        api.drawerIds().forEach(function (id) { no[id] = true; });
        (isArr(refsNow) ? refsNow : []).forEach(function (id) { no[id] = true; });
        var list = (isArr(effective) ? effective : []).filter(function (e) { return isObj(e) && typeof e.id === 'string' && !(e.id in no); });
        var view = function (e) { return { id: e.id, label: String(e.label), icon: typeof e.icon === 'string' && ICON_RE.test(e.icon) ? e.icon : 'circle-question', group: e.group }; };
        if (String(query == null ? '' : query).replace(/\s+/g, '') && typeof rank === 'function') return [{ group: null, items: rank(query, list).map(view) }];
        var order = isArr(groups) ? groups.slice() : [];
        list.forEach(function (e) { if (order.indexOf(e.group) < 0) order.push(e.group); });
        return order.map(function (g) {
          return { group: g, items: list.filter(function (e) { return e.group === g; }).map(view) };
        }).filter(function (g) { return g.items.length; });
      },
      room: function () { return MB_CAP - R.length; },
      /** The row of a button that opens this tool / view as a TAB (S5c-b),
       *  or -1: converting the custom tab again reuses it. */
      findTab: function (type, key) {
        for (var i = 0; i < R.length; i++) {
          var r = R[i];
          if (!r.kept && r.type === type && r.key === key && r.present === 'tab') return i;
        }
        return -1;
      },
      /** The tool / view lists arrived (or failed: null) — summaries follow. */
      setPickers: function (p) { pk = isObj(p) ? p : null; return true; },
      ids: function () { return R.map(function (r) { return r.id; }); },
      storedIds: function () { return Object.keys(storedIds); },
      retired: function () { return retired.slice(); },
      /** Effective-registry entries for the buttons the shell would list —
       *  group Mine, in order (a kept one is listed by nobody). */
      entries: function () {
        return R.filter(function (r) { return !r.kept; }).map(function (r) {
          return { id: r.id, group: MINE, label: r.label, labels: [r.label], icon: r.icon };
        });
      },
      /** The document Save writes: { items } (`retired` is the server's). */
      doc: function () { return { items: R.map(itemOf) }; },
      isDirty: function () { return canonical(api.doc().items) !== canonical(storedItems); },
    };
    return api;
  }

  // ── The panel ───────────────────────────────────────────────────────────
  if (typeof document === 'undefined') {
    window.ycLayoutEditor = {
      session: session, labelProblem: labelProblem, canonical: canonical,
      shortcutSession: shortcutSession, reservedProblem: reservedProblem,
      itemSession: itemSession, makeUserId: makeUserId, buttonProblems: buttonProblems, legacyTab: legacyTab,
    };
    return;
  }

  var root = null, sess = null, opener = null, saving = false;
  var labelErr = {};        // 'sf:i' → message, for label inputs holding a bad value
  var scs = null;           // the Keyboard shortcuts tab's session
  var sessOpts = null;      // what sess was built from (a partial save rebuilds it)
  var scAdd = null;         // the shortcut being added: { id, combo }
  var its = null;           // the My buttons tab's session (S5a)
  var convert = null;       // the custom tab being made a button (S5c-b): { id } — cleared at Save
  var pickers = null;       // GET /api/ui-config/pickers, read the first time My buttons shows
  var pickersState = 'idle';   // 'idle' | 'loading' | 'ok' | 'failed' — per opening
  var opening = 0;          // bumps on every show(): a late picker reply for an old opening is dropped
  var mbForm = null;        // the button form while it is open: { i } (-1 = a new one)
  var PANES = ['layout', 'shortcuts', 'buttons'];
  var KEYS = (window.ycAll && window.ycAll.keys) || null;
  function anyDirty() { return !!((sess && sess.isDirty()) || (scs && scs.isDirty()) || (its && its.isDirty()) || clearPending()); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconEl(value, extra) {
    return el('i', YI.cls(value, extra));     // a value that fails the grammar → circle-question
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
    [['layout', 'Home & sidebar', 'table-cells'], ['shortcuts', 'Keyboard shortcuts', 'keyboard'], ['buttons', 'My buttons', 'star']].forEach(function (t) {
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
    var mbp = el('div', 'yle-pane');
    mbp.id = 'ylePane_buttons';
    mbp.setAttribute('data-pane', 'buttons');
    mbp.setAttribute('role', 'tabpanel');
    mbp.setAttribute('aria-labelledby', 'yleTab_buttons');
    mbp.hidden = true;
    mbp.appendChild(buildButtonsSection());
    body.appendChild(mbp);
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
    root.addEventListener('change', onChange);
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

  // My buttons (S5a): the list, then the add / edit form (one form, hidden
  // until "Add a button" or a row's edit button opens it).
  var MB_TYPES = { view: 'A saved view', tool: 'A tool', url: 'A link to a website', drawer: 'A drawer (a menu of other items)' };
  var PICKERS_FAIL = 'Couldn’t load the lists of tools and saved views. Link buttons still work; for the others, close and open the editor again later.';
  // The tool / view lists (GET /api/ui-config/pickers — keys and titles
  // only), read once per opening, the first time My buttons is shown: the
  // other tabs never need them. A failure is said in the tab; links still work.
  function loadPickers() {
    if (pickersState !== 'idle' || typeof window.apiSend !== 'function') return;
    pickersState = 'loading';
    var mine = opening;
    var done = function (p) {
      if (mine !== opening || !its) return;
      pickers = p;
      pickersState = p ? 'ok' : 'failed';
      its.setPickers(p);
      renderButtons();
      if (mbForm && fval('type') !== 'url') fillKeys(fval('type'), fval('key'));
    };
    Promise.resolve()
      .then(function () { return window.apiSend('/api/ui-config/pickers', 'GET'); })
      .then(function (r) {
        done(isObj(r) && isArr(r.tools) && isArr(r.views) ? { tools: r.tools, views: r.views } : null);
      }, function () { done(null); });
    if (its) renderButtons();
  }
  function field(form, id, label, input, hint) {
    var w = el('div', 'ymb-field');
    w.setAttribute('data-field', id);
    var l = el('label', 'yc-flabel', label);
    l.setAttribute('for', 'ymb_' + id);
    w.appendChild(l);
    input.id = 'ymb_' + id;
    w.appendChild(input);
    if (hint) w.appendChild(el('div', 'yc-hint', hint));
    var fe = el('div', 'yle-field-err');
    fe.setAttribute('data-err', id);
    w.appendChild(fe);
    form.appendChild(w);
    return w;
  }
  function textInput(max, placeholder) {
    var i = el('input', 'yle-input');
    i.type = 'text';
    i.maxLength = max;
    i.autocomplete = 'off';
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function buildButtonsSection() {
    var sec = el('section', 'yle-sec ymb-sec');
    sec.setAttribute('data-sf', 'buttons');
    var head = el('div', 'yle-sec-head');
    head.appendChild(el('h3', null, 'My buttons'));
    sec.appendChild(head);
    sec.appendChild(el('p', 'yc-hint ymb-intro',
      'Your own buttons: a saved view, a tool, or a link to another website. Only you see them. They are listed in All ' +
      'and Ctrl+K under Mine; put them on your Home or sidebar, or give them a keyboard shortcut. A link always opens ' +
      'in a new window, never inside YisraCase.'));
    // the legacy custom tab (S5c-b): what My buttons can do with it
    var lg = el('div', 'ymb-legacy');
    lg.hidden = true;
    lg.appendChild(el('p', 'yc-hint ymb-legacy-text'));
    lg.appendChild(btn('yle-add', 'mb-legacy', null, 'arrow-right-arrow-left', 'Make my custom tab a button'));
    sec.appendChild(lg);
    var errs = el('ul', 'yle-errs');
    errs.setAttribute('role', 'alert');
    errs.hidden = true;
    sec.appendChild(errs);
    var pe = el('div', 'yc-hint ymb-pickers-err', PICKERS_FAIL);
    pe.setAttribute('role', 'status');
    pe.hidden = true;
    sec.appendChild(pe);
    var rows = el('ol', 'ymb-rows');
    rows.setAttribute('aria-label', 'Your buttons');
    sec.appendChild(rows);
    sec.appendChild(el('div', 'yc-hint ymb-none', 'No buttons yet.'));
    var adds = el('div', 'yle-adds');
    adds.appendChild(btn('yle-add', 'mb-open', null, 'plus', 'Add a button'));
    adds.appendChild(el('span', 'yc-hint yle-room'));
    sec.appendChild(adds);

    var form = el('div', 'ymb-form');
    form.hidden = true;
    form.appendChild(el('h4', 'ymb-form-title'));
    field(form, 'label', 'Name', textInput(80, 'e.g. My open leads'));
    // The icon is CHOSEN, never typed (ui-custom S6a): the value rides in a
    // hidden input; Choose… opens the shell's icon picker (/js/ycIconPicker.js).
    var iconIn = el('input');
    iconIn.type = 'hidden';
    var iw = field(form, 'icon', 'Icon', iconIn, 'Any free Font Awesome icon: solid, regular or a brand.');
    var irow = el('div', 'ymb-icon-row');
    var prev = el('span', 'ymb-icon-prev');
    prev.setAttribute('aria-hidden', 'true');
    prev.appendChild(iconEl(''));
    var iname = el('span', 'yle-name ymb-icon-name');
    var ipick = btn('ymb-icon-pick', 'mb-icon-pick', null, null, 'Choose…');
    ipick.id = 'ymb_icon_pick';
    iw.querySelector('label').setAttribute('for', 'ymb_icon_pick');
    iw.insertBefore(irow, iconIn);
    irow.appendChild(prev);
    irow.appendChild(iname);
    irow.appendChild(ipick);
    var typeSel = el('select', 'yle-input ymb-select');
    MB_KINDS.forEach(function (k) { var op = el('option', null, MB_TYPES[k]); op.value = k; typeSel.appendChild(op); });
    field(form, 'type', 'Opens', typeSel);
    field(form, 'key', 'Saved view', el('select', 'yle-input ymb-select'));
    field(form, 'href', 'Address', textInput(HREF_MAX, 'https://…'),
      'Opens in a new window: another website never opens inside YisraCase.');
    // "Opens in" (S3.3 size; S5c-b tab): the dialog, Large or Compact, or a tab
    var sizeSel = el('select', 'yle-input ymb-select');
    [['large', 'A dialog, large'], ['compact', 'A dialog, compact'], ['tab', 'A tab']].forEach(function (z) {
      var op = el('option', null, z[1]); op.value = z[0]; sizeSel.appendChild(op);
    });
    field(form, 'size', 'Opens in', sizeSel, 'A dialog opens over the app: large for a working page, compact for something small. ' +
      'A tab opens like the app\u2019s own tabs; up to ' + TAB_KEEP + ' stay open at once, so switching back keeps your place.');
    // a drawer's contents (S5b): an ordered list, the picker to add to it
    var rw = el('div', 'ymb-field ymb-refs-field');
    rw.setAttribute('data-field', 'refs');
    rw.appendChild(el('div', 'yc-flabel', 'In the drawer'));
    var rl = el('ol', 'ymb-refs');
    rl.setAttribute('aria-label', 'In the drawer');
    rw.appendChild(rl);
    rw.appendChild(el('div', 'yc-hint ymb-refs-none', 'Nothing in it yet.'));
    var ra = el('div', 'yle-adds');
    var rp = btn('yle-add', 'mb-ref-pick', null, 'plus', 'Add to the drawer');
    rp.id = 'ymb_refs';
    ra.appendChild(rp);
    ra.appendChild(el('span', 'yc-hint yle-room ymb-refs-room'));
    rw.appendChild(ra);
    rw.appendChild(el('div', 'yc-hint', 'Up to ' + DRAWER_CAP + ' items: features, your firm\u2019s items or your other buttons (not another drawer). It opens as a small menu beside its tile.'));
    var rfe = el('div', 'yle-field-err');
    rfe.setAttribute('data-err', 'refs');
    rw.appendChild(rfe);
    rw.appendChild(buildPicker('drawer', 'Add to this drawer'));
    form.appendChild(rw);
    form.appendChild(el('div', 'yc-hint ymb-id-line'));
    var frow = el('div', 'ysc-add-row');
    frow.appendChild(btn('yle-add-go yle-primary ymb-commit', 'mb-commit', null, 'check', 'Add button'));
    frow.appendChild(btn('yle-add-cancel', 'mb-cancel', null, null, 'Cancel'));
    form.appendChild(frow);
    sec.appendChild(form);
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
    // the drawer picker (S5b, in the My buttons form): the editor's registry
    // minus drawers, what the drawer already holds and the button being edited
    var held = !mbForm ? [] : mbForm.i >= 0 ? mbForm.refs.concat(its.ids()[mbForm.i]) : mbForm.refs;
    var groups = sf === 'shortcuts' ? scs.candidates(q)
      : sf === 'buttons' ? its.drawerCandidates(editorEffective(), editorGroups(), held, q, L.rank)
        : sess.candidates(sf, q);
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

  // ── The My buttons tab (S5a) ──
  // The effective registry the layout and shortcut tabs work from while the
  // panel is open: the shell's, with its stored buttons swapped for the ones
  // being edited here (group Mine, after Firm, before Admin) — so a new
  // button can be placed or bound before it is saved, and a deleted one
  // can't.
  function editorEffective() {
    // while the custom tab is being made a button (S5c-b), the panel shows
    // what Save leaves: the button in its place, the custom tab gone
    var pending = clearPending();
    var base = L.effectiveRegistry().filter(function (e) { return !USER_ID_RE.test(e.id) && !(pending && e.id === 'custom'); });
    var mine = its ? its.entries() : [];
    var at = base.length;
    for (var i = 0; i < base.length; i++) if (base[i].group === ADMIN) { at = i; break; }
    return base.slice(0, at).concat(mine, base.slice(at));
  }
  function editorGroups() {
    var g = L.groups().filter(function (x) { return x !== MINE; });
    if (its && its.entries().length) { var a = g.indexOf(ADMIN); g.splice(a < 0 ? g.length : a, 0, MINE); }
    return g;
  }
  function retargetAll() {
    var eff = editorEffective(), g = editorGroups();
    if (sess) sess.retarget(eff, g);
    if (scs) scs.retarget(eff, g);
  }
  // The ids the user's layout and shortcuts name — stored (as read at open)
  // and as edited now: a new button never takes one.
  var storedRefs = null;
  function refsNow() {
    var r = Object.create(null), k;
    for (k in storedRefs || {}) r[k] = true;
    if (sess) userIdsIn(sess.doc(), r);
    if (scs) userIdsIn(scs.doc(), r);
    return r;
  }
  function newItemSession(stored) {
    return itemSession({ stored: stored, pickers: pickers, clean: L.cleanUserItem, refs: refsNow });
  }
  function mbSec() { return secOf('buttons'); }
  function renderButtons() {
    var sec = mbSec(), ol = sec.querySelector('.ymb-rows');
    ol.textContent = '';
    var list = its.list();
    list.forEach(function (b, i) {
      var li = el('li', 'yle-row ymb-row' + (b.kept ? ' ymb-kept' : ''));
      li.setAttribute('data-i', String(i));
      li.setAttribute('data-id', b.id);
      li.appendChild(iconEl(b.icon, 'yle-ic'));
      var main = el('span', 'yle-main ymb-main');
      main.appendChild(el('span', 'yle-name', b.label));
      if (!b.saved) main.appendChild(el('span', 'yle-tag', 'New'));
      main.appendChild(el('span', 'yc-hint ymb-sum', b.summary));
      var on = b.kept ? [] : sess.where(b.id), combos = scs.combosOf(b.id);
      if (on.length || combos.length || b.inDrawers.length) {
        var wh = el('span', 'ymb-where');
        on.forEach(function (sf) { wh.appendChild(el('span', 'yle-tag', sf === 'home' ? 'On Home' : 'On sidebar')); });
        b.inDrawers.forEach(function (n) { wh.appendChild(el('span', 'yle-tag', 'In \u201c' + n + '\u201d')); });
        combos.forEach(function (t) { wh.appendChild(el('kbd', 'ysc-kbd', t)); });
        main.appendChild(wh);
      }
      li.appendChild(main);
      var acts = el('span', 'yle-acts');
      var up = btn('yle-up', 'mb-up', 'Move ' + b.label + ' up', 'arrow-up');
      var dn = btn('yle-down', 'mb-down', 'Move ' + b.label + ' down', 'arrow-down');
      up.disabled = i === 0;
      dn.disabled = i === list.length - 1;
      acts.appendChild(up);
      acts.appendChild(dn);
      if (!b.kept) acts.appendChild(btn('ymb-edit', 'mb-edit', 'Edit ' + b.label, 'pen'));
      acts.appendChild(btn('yle-remove', 'mb-del', 'Delete ' + b.label, 'trash'));
      li.appendChild(acts);
      if (!b.kept && on.length < 2) {
        var place = el('div', 'ymb-place');
        if (on.indexOf('home') < 0) place.appendChild(btn('yle-add-cancel', 'mb-home', 'Add ' + b.label + ' to your Home', 'plus', 'Add to Home'));
        if (on.indexOf('sidebar') < 0) place.appendChild(btn('yle-add-cancel', 'mb-sidebar', 'Add ' + b.label + ' to your sidebar', 'plus', 'Add to sidebar'));
        li.appendChild(place);
      }
      ol.appendChild(li);
    });
    sec.querySelector('.ymb-none').hidden = list.length > 0;
    var pe = sec.querySelector('.ymb-pickers-err');
    pe.hidden = pickersState !== 'failed' && pickersState !== 'loading';
    pe.textContent = pickersState === 'loading' ? 'Loading the lists of tools and saved views…' : PICKERS_FAIL;
    var room = its.room();
    sec.querySelector('.yle-room').textContent = room <= 0 ? 'You have the most buttons there can be (' + MB_CAP + ').' : '';
    sec.querySelector('[data-act="mb-open"]').disabled = room <= 0 || !!mbForm;
    renderLegacy();
  }
  // ── The legacy custom tab → a button (S5c-b) ──
  // The shell's copy of users.user_custom_tab (settings.html keeps it current).
  function legacyNow() {
    var u = (window.firmData && isObj(window.firmData.currentUser) && window.firmData.currentUser) || (isObj(window.user) && window.user) || {};
    return legacyTab(u.user_custom_tab);
  }
  // A conversion waiting for Save: its button is still in the list.
  function clearPending() { return !!(convert && its && its.ids().indexOf(convert.id) >= 0); }
  function renderLegacy() {
    var box = mbSec().querySelector('.ymb-legacy'), lt = legacyNow();
    if (convert && !clearPending()) convert = null;              // its button was deleted: nothing to do at Save
    box.hidden = !lt;
    if (!lt) return;
    var text = box.querySelector('.ymb-legacy-text'), go = box.querySelector('[data-act="mb-legacy"]');
    go.hidden = !lt.ok || !!convert;
    go.disabled = !!mbForm || its.room() <= 0;
    if (convert) {
      var ci = its.ids().indexOf(convert.id), b = its.list()[ci], bf = its.fields(ci);
      // the button as it is now: the user may have edited it to a dialog (review N2)
      text.textContent = 'When you save, your custom tab \u201c' + lt.title + '\u201d becomes your button \u201c' + (b ? b.label : convert.id) +
        '\u201d: it opens ' + (bf && bf.size !== 'tab' ? 'in a dialog' : 'as a tab') + ', where the custom tab was. ' + LEGACY_REFS;
    } else if (lt.ok) {
      text.textContent = 'You have a custom tab, \u201c' + lt.title + '\u201d (Settings \u2192 My Custom Tab). Make it one of your buttons: ' +
        'it keeps opening as a tab, in the same places on your Home and sidebar. ' + LEGACY_REFS +
        (its.room() <= 0 ? ' You have the most buttons there can be: delete one first.' : '');
    } else {
      text.textContent = 'Your custom tab, \u201c' + lt.title + '\u201d, stays as it is: ' + lt.why.charAt(0).toLowerCase() + lt.why.slice(1) +
        ' Settings \u2192 My Custom Tab still changes it.';
    }
  }
  // What the conversion does NOT move (review S1, ruled): a keyboard shortcut or
  // a drawer entry naming `custom` stops working once the old tab is cleared.
  var LEGACY_REFS = 'A keyboard shortcut or drawer entry that opened the custom tab stops working: point it at the new button.';
  // One click: a button that opens the same tool / view as a tab (or the one
  // an earlier conversion already made — idempotent), placed where the custom
  // tab is on Home and the sidebar. The old tab is cleared at Save, after the
  // buttons and the layout saved.
  function convertLegacy() {
    if (saving || mbForm || convert) return;
    var lt = legacyNow();
    if (!lt || !lt.ok) return;
    var at = its.findTab(lt.button.type, lt.button.key), id;
    if (at >= 0) id = its.ids()[at];
    else {
      var r = its.add(lt.button);
      if (!r.ok) {
        var p = r.problems || {};
        banner('Your custom tab could not be made a button: ' + (p.label || p.key || p.icon || p.type || 'it breaks the button rules') + '.', true);
        return;
      }
      id = r.id;
    }
    retargetAll();
    sess.replace('custom', id);
    convert = { id: id };
    buttonsChanged();       // retargets without the custom tab (editorEffective)
    var row = mbSec().querySelector('.ymb-row[data-id="' + id + '"] [data-act="mb-edit"]');
    if (row) row.focus();
  }
  // The old tab is gone (Save cleared it): the shell's copies, then the shell.
  function legacyCleared() {
    try {
      if (window.firmData && isObj(window.firmData.currentUser)) window.firmData.currentUser.user_custom_tab = null;
      if (isObj(window.user)) window.user.user_custom_tab = null;
    } catch (_) { /* not ours to fix */ }
    if (typeof window.applyCustomTab === 'function') window.applyCustomTab(null);
  }
  function formEl() { return mbSec().querySelector('.ymb-form'); }
  function fval(id) { return mbSec().querySelector('#ymb_' + id).value; }
  // The key picker for the chosen kind: the live tools / active saved views
  // (titles), plus the stored key when the lists don't have it.
  function fillKeys(type, key) {
    var sel = mbSec().querySelector('#ymb_key');
    sel.textContent = '';
    var none = el('option', null, 'Choose…');
    none.value = '';
    sel.appendChild(none);
    var list = pickers ? (type === 'tool' ? pickers.tools : pickers.views) : null;
    (isArr(list) ? list : []).forEach(function (x) {
      if (!isObj(x) || typeof x.key !== 'string') return;
      var op = el('option', null, String(x.title == null || x.title === '' ? x.key : x.title));
      op.value = x.key;
      sel.appendChild(op);
    });
    if (key && !Array.prototype.some.call(sel.options, function (op) { return op.value === key; })) {
      var keep = el('option', null, key + (pickers ? (type === 'tool' ? ' (not live)' : ' (not found)') : ''));
      keep.value = key;
      sel.appendChild(keep);
    }
    sel.value = key || '';
    var lab = mbSec().querySelector('[data-field="key"] label');
    lab.textContent = type === 'tool' ? 'Tool' : 'Saved view';
  }
  function showKind(type) {
    var f = formEl();
    var modal = type === 'tool' || type === 'view';
    f.querySelector('[data-field="key"]').hidden = !modal;
    f.querySelector('[data-field="size"]').hidden = !modal;
    f.querySelector('[data-field="href"]').hidden = type !== 'url';
    f.querySelector('[data-field="refs"]').hidden = type !== 'drawer';
    if (type !== 'drawer') f.querySelector('[data-field="refs"] .yle-picker').hidden = true;
  }
  // The drawer's contents in the open form (S5b): mbForm.refs, each with its
  // label from the editor's registry — else the feature's own name, else the
  // id, tagged Unavailable (kept; the drawer simply doesn't show it).
  function refView(id) {
    var eff = editorEffective();
    for (var i = 0; i < eff.length; i++) if (eff[i].id === id) return { label: String(eff[i].label), icon: eff[i].icon, ok: true };
    var reg = window.FEATURE_REGISTRY || {}, it = hasOwn(reg, id) && isObj(reg[id]) ? reg[id] : null;
    return { label: it && it.label != null ? String(it.label) : id, icon: it ? it.icon : null, ok: false };
  }
  function renderRefs() {
    var f = formEl(), ol = f.querySelector('.ymb-refs');
    ol.textContent = '';
    var refs = mbForm ? mbForm.refs : [];
    refs.forEach(function (id, i) {
      var v = refView(id);
      var li = el('li', 'yle-row ymb-ref' + (v.ok ? '' : ' ysc-unavailable'));
      li.setAttribute('data-ri', String(i));
      li.setAttribute('data-id', id);
      li.appendChild(iconEl(typeof v.icon === 'string' ? v.icon : '', 'yle-ic'));
      var main = el('span', 'yle-main');
      main.appendChild(el('span', 'yle-name', v.label));
      if (!v.ok) {
        var tag = el('span', 'yle-tag', 'Unavailable');
        tag.title = 'Not available to you right now: the drawer leaves it out. It is kept until you remove it.';
        main.appendChild(tag);
      }
      li.appendChild(main);
      var acts = el('span', 'yle-acts');
      var up = btn('yle-up', 'mb-ref-up', 'Move ' + v.label + ' up', 'arrow-up');
      var dn = btn('yle-down', 'mb-ref-down', 'Move ' + v.label + ' down', 'arrow-down');
      up.disabled = i === 0;
      dn.disabled = i === refs.length - 1;
      acts.appendChild(up);
      acts.appendChild(dn);
      acts.appendChild(btn('yle-remove', 'mb-ref-del', 'Take ' + v.label + ' out of the drawer', 'xmark'));
      li.appendChild(acts);
      ol.appendChild(li);
    });
    f.querySelector('.ymb-refs-none').hidden = refs.length > 0;
    var full = refs.length >= DRAWER_CAP;
    f.querySelector('.ymb-refs-room').textContent = full ? 'The drawer is full (' + DRAWER_CAP + ' items).' : '';
    f.querySelector('[data-act="mb-ref-pick"]').disabled = full;
    if (full) f.querySelector('[data-field="refs"] .yle-picker').hidden = true;
    renderPicker('buttons');
  }
  function refEdited(focusSel, i) {
    var fe = formEl().querySelector('[data-err="refs"]');
    if (fe) fe.textContent = '';
    renderRefs();
    var rows = formEl().querySelectorAll('.ymb-ref');
    var r = rows.length ? rows[Math.max(0, Math.min(i, rows.length - 1))] : null;
    var t = (r && focusSel && r.querySelector(focusSel + ':not(:disabled)')) || (r && r.querySelector('button:not(:disabled)'))
      || formEl().querySelector('[data-act="mb-ref-pick"]:not(:disabled)') || formEl().querySelector('#ymb_type');
    if (t) t.focus();
  }
  function iconPreview() {
    var v = String(fval('icon')).trim();
    var prev = formEl().querySelector('.ymb-icon-prev');
    prev.textContent = '';
    prev.appendChild(iconEl(v));
    var p = YI.parse(v);
    formEl().querySelector('.ymb-icon-name').textContent = p
      ? p.name + ' · ' + p.family.charAt(0).toUpperCase() + p.family.slice(1)
      : (v ? 'Not a valid icon: choose another' : 'None chosen yet');
  }
  /** Choose… — the shell's picker; the choice lands in the hidden input as
   *  if typed (same error clearing and preview), unless the form moved on. */
  function pickIcon(b) {
    var P = window.ycIconPicker;
    if (!mbForm || !P || typeof P.open !== 'function') return;
    var form = mbForm, label = String(fval('label')).trim();
    P.open({ value: String(fval('icon')).trim(), title: label ? 'Icon for “' + label.slice(0, 40) + '”' : 'Choose an icon', from: b })
      .then(function (v) {
        if (typeof v !== 'string' || !v || mbForm !== form || saving) return;
        var inp = mbSec().querySelector('#ymb_icon');
        inp.value = v;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      });
  }
  function idLine() {
    var line = formEl().querySelector('.ymb-id-line');
    if (!mbForm) { line.textContent = ''; return; }
    var r = mbForm.i >= 0 ? its.list()[mbForm.i] : null;
    if (r && r.saved) { line.textContent = 'Its id is ' + r.id + ' (permanent).'; return; }
    var label = fval('label');
    line.textContent = labelProblem(label) ? '' : 'Its id will be ' + (r ? r.id : its.previewId(label)) + ', set from the name.';
  }
  function formErrors(p) {
    formEl().querySelectorAll('[data-err]').forEach(function (n) {
      var m = p && p[n.getAttribute('data-err')];
      n.textContent = m || '';
      var inp = mbSec().querySelector('#ymb_' + n.getAttribute('data-err'));
      if (inp) { if (m) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
    });
  }
  function openForm(i) {
    var f = its.fields(i) || { label: '', icon: '', type: 'view', key: '', href: '', size: 'large', refs: [] };
    mbForm = { i: i, refs: (f.refs || []).slice() };
    var form = formEl();
    form.hidden = false;
    form.querySelector('.ymb-form-title').textContent = i >= 0 ? 'Edit a button' : 'New button';
    form.querySelector('.ymb-commit span').textContent = i >= 0 ? 'Apply' : 'Add button';
    mbSec().querySelector('#ymb_label').value = f.label;
    mbSec().querySelector('#ymb_icon').value = f.icon;
    mbSec().querySelector('#ymb_type').value = f.type;
    mbSec().querySelector('#ymb_href').value = f.href;
    mbSec().querySelector('#ymb_size').value = f.size;
    fillKeys(f.type, f.key);
    showKind(f.type);
    form.querySelector('[data-field="refs"] .yle-picker').hidden = true;
    renderRefs();
    iconPreview();
    formErrors(null);
    idLine();
    renderButtons();
    renderStatus();
    form.scrollIntoView && form.scrollIntoView({ block: 'nearest' });
    mbSec().querySelector('#ymb_label').focus();
  }
  function closeForm(focus) {
    var was = mbForm;
    mbForm = null;
    formEl().hidden = true;
    renderButtons();
    renderStatus();
    if (!focus) return;
    var row = was && was.i >= 0 ? mbSec().querySelector('.ymb-row[data-i="' + was.i + '"] [data-act="mb-edit"]') : null;
    (row || mbSec().querySelector('[data-act="mb-open"]')).focus();
  }
  function formFields() {
    return { label: fval('label'), icon: fval('icon'), type: fval('type'), key: fval('key'), href: fval('href'), size: fval('size'),
      refs: mbForm ? mbForm.refs.slice() : [] };
  }
  function buttonsChanged() {
    retargetAll();
    SURFACES.forEach(renderSection);
    renderShortcuts();
    renderButtons();
    renderStatus();
  }
  function commitForm() {
    if (saving || !mbForm) return;
    var f = formFields();
    var r = mbForm.i >= 0 ? its.update(mbForm.i, f) : its.add(f);
    if (!r.ok) {
      formErrors(r.problems);
      var first = formEl().querySelector('[aria-invalid="true"]');
      if (first && first.id === 'ymb_icon') first = formEl().querySelector('#ymb_icon_pick');   // the value is hidden: its Choose…
      if (first) first.focus();
      return;
    }
    mbForm = null;
    formEl().hidden = true;
    formEl().querySelector('[data-field="refs"] .yle-picker').hidden = true;
    buttonsChanged();
    var b = mbSec().querySelector('.ymb-row[data-i="' + r.i + '"] [data-act="mb-edit"]');
    if (b) b.focus();
  }
  function deleteButton(i) {
    var b = its.list()[i];
    if (!b) return;
    var on = b.kept ? [] : sess.where(b.id), combos = scs.combosOf(b.id), drawers = b.inDrawers;
    var go = function () {
      if (!its || its.list()[i] == null || its.list()[i].id !== b.id) return;
      var id = its.remove(i);
      if (id == null) return;
      sess.dropId(id);
      scs.dropId(id);
      its.dropRef(id);                 // out of every drawer too (S5b)
      if (mbForm) {
        // the open form follows its own row (or closes with it), and a drawer
        // being edited lets go of the deleted button
        if (mbForm.i === i) { mbForm = null; formEl().hidden = true; }
        else {
          if (mbForm.i > i) mbForm.i--;
          mbForm.refs = mbForm.refs.filter(function (x) { return x !== id; });
          renderRefs();
        }
      }
      buttonsChanged();
      var left = mbSec().querySelectorAll('.ymb-row [data-act="mb-del"]');
      (left[Math.min(i, left.length - 1)] || mbSec().querySelector('[data-act="mb-open"]')).focus();
    };
    if (!on.length && !combos.length && !drawers.length) { go(); return; }
    var where = [];
    if (on.length) where.push('it’s on your ' + on.map(function (sf) { return sf === 'home' ? 'Home' : 'sidebar'; }).join(' and '));
    if (drawers.length) where.push((on.length ? '' : 'it’s ') + 'in your drawer' + (drawers.length > 1 ? 's ' : ' ') + drawers.map(function (n) { return '“' + n + '”'; }).join(', '));
    if (combos.length) where.push((on.length || drawers.length ? '' : 'it’s ') + 'bound to ' + combos.join(', '));
    ask('Delete “' + b.label + '”? Note: ' + where.join(' and ') + '. Deleting it takes it off there too.', 'Delete', 'Keep it')
      .then(function (yes) { if (yes && !saving) go(); });
  }
  function placeButton(i, sf) {
    var b = its.list()[i];
    if (!b || !sess.add(sf, b.id)) return;
    edited(sf);
    renderButtons();
    var r = mbSec().querySelector('.ymb-row[data-i="' + i + '"] [data-act="mb-edit"]');
    if (r) r.focus();
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
    if (name === 'buttons') loadPickers();
  }
  function paneShown() {
    var t = root.querySelector('.yle-tab.active');
    return t ? t.getAttribute('data-pane') : 'layout';
  }

  function renderStatus() {
    var dirty = anyDirty();
    root.querySelector('.yle-status').textContent = dirty ? 'Unsaved changes' : 'No changes';
    // a held bad label, or an open button form, keeps Save clickable: the
    // click says what to finish
    root.querySelector('.yle-save').disabled = (!dirty && !Object.keys(labelErr).length && !mbForm) || saving;
    var dots = { layout: !!(sess && sess.isDirty()), shortcuts: !!(scs && scs.isDirty()), buttons: !!(its && its.isDirty()) || clearPending() };
    root.querySelectorAll('.yle-tab').forEach(function (t) {
      t.querySelector('.yle-tab-dot').hidden = !dots[t.getAttribute('data-pane')];
    });
  }
  function render() {
    SURFACES.forEach(renderSection);
    renderShortcuts();
    renderButtons();
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
    SURFACES.concat('shortcuts', 'buttons').forEach(function (sf) {
      var u = secOf(sf).querySelector('.yle-errs');
      u.textContent = '';
      u.hidden = true;
    });
  }
  /** A refused save's errors[] inside the panel. The layout document's go
   *  under the surface their path names (placed.home[3]…, removed.sidebar…);
   *  the shortcuts document's all go under Keyboard shortcuts, the items
   *  document's (S5a) under My buttons. → the rest (for the banner). */
  function placeErrors(key, errors) {
    var general = [];
    errors.forEach(function (m) {
      var hit = key === 'layout' ? /^(?:placed|removed)\.(home|sidebar)\b/.exec(String(m)) : [null, PANE_OF[key]];
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
      case 'mb-open': openForm(-1); return;
      case 'mb-cancel': closeForm(true); return;
      case 'mb-icon-pick': pickIcon(b); return;
      case 'mb-commit': commitForm(); return;
      case 'mb-legacy': convertLegacy(); return;
      case 'mb-edit': case 'mb-del': case 'mb-up': case 'mb-down': case 'mb-home': case 'mb-sidebar': {
        var mi = Number(b.closest('.ymb-row').getAttribute('data-i'));
        if (act === 'mb-edit') openForm(mi);
        else if (act === 'mb-del') deleteButton(mi);
        else if (act === 'mb-home' || act === 'mb-sidebar') placeButton(mi, act === 'mb-home' ? 'home' : 'sidebar');
        else if (its.move(mi, act === 'mb-up' ? -1 : 1)) {
          var mj = mi + (act === 'mb-up' ? -1 : 1);
          if (mbForm && mbForm.i === mi) mbForm.i = mj;          // the open form follows its row
          else if (mbForm && mbForm.i === mj) mbForm.i = mi;
          buttonsChanged();
          var mv = mbSec().querySelector('.ymb-row[data-i="' + (mi + (act === 'mb-up' ? -1 : 1)) + '"] .yle-' + (act === 'mb-up' ? 'up' : 'down') + ':not(:disabled)');
          (mv || mbSec().querySelector('.ymb-row[data-i="' + (mi + (act === 'mb-up' ? -1 : 1)) + '"] [data-act="mb-edit"]') || mbSec().querySelector('[data-act="mb-open"]')).focus();
        }
        return;
      }
      case 'mb-ref-pick': {
        if (!mbForm) return;
        var dpk = formEl().querySelector('[data-field="refs"] .yle-picker');
        dpk.hidden = false;
        dpk.querySelector('.yle-pick-q').value = '';
        renderPicker('buttons');
        dpk.querySelector('.yle-pick-q').focus();
        return;
      }
      case 'mb-ref-up': case 'mb-ref-down': case 'mb-ref-del': {
        if (!mbForm) return;
        var ri = Number(b.closest('.ymb-ref').getAttribute('data-ri')), rr = mbForm.refs;
        if (!(ri >= 0 && ri < rr.length)) return;
        if (act === 'mb-ref-del') { rr.splice(ri, 1); refEdited('.yle-remove', ri); return; }
        var rj = ri + (act === 'mb-ref-up' ? -1 : 1);
        if (rj < 0 || rj >= rr.length) return;
        var tmp = rr[ri]; rr[ri] = rr[rj]; rr[rj] = tmp;
        refEdited(act === 'mb-ref-up' ? '.yle-up' : '.yle-down', rj);
        return;
      }
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
        if (sf === 'buttons') { formEl().querySelector('[data-act="mb-ref-pick"]').focus(); return; }
        if (sf === 'shortcuts') {
          if (scAdd && scAdd.id != null) sec.querySelector('.ysc-capture').focus();
          else closeScAdd(true);
          return;
        }
        sec.querySelector('[data-act="pick"]').focus();
        return;
      case 'pick-add': {
        var pid = b.getAttribute('data-id');
        if (sf === 'buttons') {           // into the drawer being edited (S5b); the picker stays open for more
          if (!mbForm || mbForm.refs.length >= DRAWER_CAP || mbForm.refs.indexOf(pid) >= 0) return;
          mbForm.refs.push(pid);
          var rfe = formEl().querySelector('[data-err="refs"]');
          if (rfe) rfe.textContent = '';
          renderRefs();
          var q2 = formEl().querySelector('[data-field="refs"] .yle-picker:not([hidden]) .yle-pick-q');
          (q2 || formEl().querySelector('[data-act="mb-ref-pick"]:not(:disabled)') || formEl().querySelector('#ymb_type')).focus();
          return;
        }
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
    if (t.id && t.id.indexOf('ymb_') === 0) {
      var fe = formEl().querySelector('[data-err="' + t.id.slice(4) + '"]');
      if (fe) fe.textContent = '';
      t.removeAttribute('aria-invalid');
      if (t.id === 'ymb_icon') iconPreview();
      if (t.id === 'ymb_label') idLine();
      return;
    }
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

  // The button form's selects: a new kind shows its own fields.
  function onChange(e) {
    if (saving || !mbForm) return;
    var t = e.target;
    if (t.id === 'ymb_type') {
      fillKeys(t.value, '');
      showKind(t.value);
      if (t.value === 'drawer') renderRefs();
      formErrors(null);
    } else if (t.id === 'ymb_key') {
      var fe = formEl().querySelector('[data-err="key"]');
      if (fe) fe.textContent = '';
      t.removeAttribute('aria-invalid');
    }
  }

  function focusables() {
    return Array.prototype.filter.call(root.querySelectorAll('button, input, select'), function (n) {
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
      var dpk = e.target.closest && e.target.closest('.ymb-form .yle-picker');
      if (dpk && !dpk.hidden) {           // the drawer picker (S5b) closes before the form
        dpk.hidden = true;
        formEl().querySelector('[data-act="mb-ref-pick"]').focus();
        return;
      }
      var mbf = e.target.closest && e.target.closest('.ymb-form');
      if (mbf && !mbf.hidden) { closeForm(true); return; }
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
      } else if (t.tagName === 'INPUT' && t.closest('.ymb-form')) { e.preventDefault(); commitForm(); }
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
  function itemsOf(ui) {
    return isObj(ui) && isObj(ui.user) && isObj(ui.user.items) ? ui.user.items : null;
  }
  function newShortcutSession(stored) {
    return shortcutSession({
      stored: stored, effective: editorEffective(), registry: window.FEATURE_REGISTRY || {}, groups: editorGroups(),
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
    opening++;
    convert = null;
    pickers = null;
    pickersState = 'idle';
    mbForm = null;
    sess = null;
    scs = null;
    storedRefs = userIdsIn([storedOf(ui), shortcutsOf(ui)]);
    its = newItemSession(itemsOf(ui));
    sessOpts = {
      stored: storedOf(ui), effective: editorEffective(), locked: lockedOf(ui),
      base: window.DEFAULT_LAYOUTS || {}, registry: window.FEATURE_REGISTRY || {}, groups: editorGroups(),
    };
    sess = session(sessOpts);
    scs = newShortcutSession(shortcutsOf(ui));
    scAdd = null;
    root.querySelector('.ymb-form').hidden = true;
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
    its = null;
    convert = null;
    mbForm = null;
    opening++;
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
    if (!anyDirty() && !Object.keys(labelErr).length && !mbForm) { closeNow(); return Promise.resolve(true); }
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
    root.querySelectorAll('select').forEach(function (n) { n.disabled = !!on; });
  }
  // Save: each dirty document is its own PUT, in this order — items (My
  // buttons, S5a), layout, shortcuts — so a new button exists before the
  // layout or a shortcut names it. Each is sent whatever became of the one
  // before, with one exception: when the buttons were refused, a layout or
  // shortcuts document that names a button the server does not hold (a new,
  // unsaved one) is HELD — not sent — so no reference to it is written. All
  // saved: the shell takes them, the panel closes. Anything refused or held:
  // the panel stays open with every edit, what DID save becomes the new
  // stored state (its tab is clean), and the banner says which part failed.
  // Last, when the custom tab was made a button (S5c-b), the old tab is
  // cleared (POST /api/auth/update-custom-tab { clear: true }) — only once the
  // buttons and the layout that replace it saved (or had nothing to save), so
  // a failure never leaves the user with neither; a failed clear keeps the
  // conversion pending, and the next Save retries just that.
  var PART_NAME = { items: 'buttons', layout: 'launcher layout', shortcuts: 'keyboard shortcuts' };
  var PANE_OF = { items: 'buttons', layout: 'layout', shortcuts: 'shortcuts', customTab: 'buttons' };
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
    if (mbForm) {
      showPane('buttons');
      banner('Finish the button you are editing first: press ' + (mbForm.i >= 0 ? 'Apply' : 'Add button') + ', or Cancel.');
      mbSec().querySelector('#ymb_label').focus();
      return Promise.resolve(false);
    }
    if (!anyDirty()) { closeNow(); return Promise.resolve(true); }
    if (typeof window.apiSend !== 'function') { banner('Saving is not available on this page.', true); return Promise.resolve(false); }
    var parts = [];
    if (its.isDirty()) parts.push({ key: 'items', doc: its.doc() });
    if (sess.isDirty()) parts.push({ key: 'layout', doc: sess.doc() });
    if (scs.isDirty()) parts.push({ key: 'shortcuts', doc: scs.doc() });
    var clearTab = clearPending();
    var heldIds = Object.create(null);     // the buttons the server holds before this save
    its.storedIds().concat(its.retired()).forEach(function (id) { heldIds[id] = true; });   // retired: not new (review N2)
    saving = true;
    freeze(true);
    renderStatus();
    root.querySelector('.yle-status').textContent = 'Saving\u2026';
    var res = {};
    var chain = Promise.resolve();
    parts.forEach(function (p) {
      chain = chain.then(function () {
        if (p.key !== 'items' && res.items && !res.items.ok) {
          var names = userIdsIn(p.doc);
          for (var id in names) if (!heldIds[id]) { res[p.key] = { ok: false, held: true }; return null; }
        }
        return Promise.resolve()
          .then(function () { return window.apiSend('/api/ui-config', 'PUT', { scope: 'user', config_key: p.key, config: p.doc }); })
          .then(function (r) { res[p.key] = { ok: true, config: r && isObj(r.config) ? r.config : p.doc }; },
            function (e) { res[p.key] = { ok: false, e: e }; });
      });
    });
    if (clearTab) {
      chain = chain.then(function () {
        if ((res.items && !res.items.ok) || (res.layout && !res.layout.ok)) { res.customTab = { ok: false, held: true }; return null; }
        return Promise.resolve()
          .then(function () { return window.apiSend('/api/auth/update-custom-tab', 'POST', { clear: true }); })
          .then(function () { res.customTab = { ok: true }; }, function (e) { res.customTab = { ok: false, e: e }; });
      });
    }
    return chain.then(function () {
      saving = false;
      var saved = {}, failed = [], said = [];
      parts.forEach(function (p) { if (res[p.key].ok) saved[p.key] = res[p.key].config; else failed.push(p.key); });
      if (Object.keys(saved).length) applyToShell(saved);
      if (clearTab && res.customTab.ok) { convert = null; legacyCleared(); }
      else if (clearTab) failed.push('customTab');
      if (!failed.length) {
        closeNow();
        toast('success', 'Saved \u2014 your launcher is updated');
        return true;
      }
      freeze(false);
      if (!isOpen()) return false;
      // what saved is the new stored state: the buttons first (the other
      // tabs' item list follows them), then the layout and shortcuts
      if (hasOwn(saved, 'items')) its = newItemSession(saved.items);
      if (hasOwn(saved, 'layout')) { sessOpts.stored = saved.layout; sessOpts.effective = editorEffective(); sessOpts.groups = editorGroups(); sess = session(sessOpts); }
      if (hasOwn(saved, 'shortcuts')) scs = newShortcutSession(saved.shortcuts);
      if (hasOwn(saved, 'layout')) storedRefs = userIdsIn([saved.layout, storedRefs ? Object.keys(storedRefs) : []]);
      if (hasOwn(saved, 'shortcuts')) storedRefs = userIdsIn([saved.shortcuts, storedRefs ? Object.keys(storedRefs) : []]);
      retargetAll();
      if (Object.keys(saved).length) render(); else renderStatus();
      var multi = parts.length > 1;
      parts.forEach(function (p) {
        var name = PART_NAME[p.key], plural = p.key !== 'layout';
        if (res[p.key].ok) { said.push('Your ' + name + (plural ? ' were' : ' was') + ' saved.'); return; }
        if (res[p.key].held) {
          said.push('Your ' + name + (plural ? ' were' : ' was') + ' not sent: ' + (plural ? 'they use' : 'it uses') + ' a button that did not save.');
          return;
        }
        var e = res[p.key].e;
        if (e && e.status === 400 && e.body && isArr(e.body.errors) && e.body.errors.length) {
          var general = placeErrors(p.key, e.body.errors);
          said.push((multi ? 'The server refused your ' + name + '.' : 'The server refused the save.') +
            (general.length ? ' ' + general.join(' \u00b7 ')
              : ' See the messages under ' + (p.key === 'layout' ? 'each section.' : p.key === 'items' ? 'My buttons.' : 'Keyboard shortcuts.')));
        } else {
          var why = (e && e.message) || 'request failed';
          said.push(multi ? 'Your ' + name + ' did not save: ' + why + '.' : 'Save failed: ' + why + '.');
        }
      });
      if (clearTab) {
        var ct = res.customTab, why = ct.e && ct.e.message ? ct.e.message : 'request failed';
        said.push(ct.ok ? 'Your old custom tab was removed.'
          : ct.held ? 'Your old custom tab was not removed: the button that replaces it did not save.'
          : 'Your old custom tab could not be removed (' + why + '): press Save to try again.');
      }
      said.push('Your changes are still here.');
      if (failed.map(function (k) { return PANE_OF[k]; }).indexOf(paneShown()) < 0) showPane(PANE_OF[failed[0]]);
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
    itemSession: itemSession, makeUserId: makeUserId, buttonProblems: buttonProblems, legacyTab: legacyTab,
  };
})();
