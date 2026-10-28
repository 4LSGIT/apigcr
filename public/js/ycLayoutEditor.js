/* public/js/ycLayoutEditor.js — "Customize my launcher": each user's own Home
 * and sidebar layout editor (ui-custom S4b; Home and Sidebar are two tabs
 * since launcher-nits L1).
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
 *   { placed: { home?: [entry…], homeIcons?: [entry…], sidebar?: [entry…] },
 *     removed: { home?: [id…], homeIcons?: [id…], sidebar?: [id…] } }
 * homeIcons is Home's icon row (ui-custom S6c): the Home tab's "Home's small
 * buttons" section (launcher-nits L1), up to 12, All always in it
 * (GUARANTEED: it moves, it can't be hidden).
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
 * Keyboard shortcuts (ui-custom S4c): the tab after Home and Sidebar. The user's
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
 * My buttons (ui-custom S5a): the panel's last tab. The user's ui_config
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
 * changes. While the panel is open the other tabs work from an effective
 * registry with the EDITED buttons in it (editorEffective), so a new button
 * can be placed and bound before it is saved; deleting a button drops its
 * placements and bindings in the same session (it asks first when it has
 * any). Save sends up to three documents, items first; see save().
 * Since launcher-nits L2 the tab saves ITSELF as it goes (saveButtons): an
 * add, an edit, a move or a delete PUTs the items document at once and the
 * panel stays open; placing a button stays under Save, like any arranging.
 *
 * Drawers (ui-custom S5b; called a LIST in every string the user reads since
 * S6c-5 — the stored type stays `drawer`, ids and types being API surface): a
 * button may be a DRAWER — { type:'drawer', items: [id…] }, a menu of up to
 * 30 other items the shell opens beside the tile / row that opened it. It is
 * one more kind in the same form ("A list"), and its contents are an ordered
 * list there: add (the "find a feature" picker over the editor's effective
 * registry, minus drawers — one level deep — and minus what the drawer
 * already holds), remove, ↑ / ↓. A drawer is placed and bound like any
 * button. A button inside a drawer can't become a drawer, and its id is
 * frozen once a drawer holds it (as when placed or bound). Deleting a button
 * drops it from every drawer too, in the same session (the delete prompt
 * names them), so the items document never names a deleted button.
 *
 * Pages (ui-custom S6c-5): a button may be a PAGE — { type:'page' } — a tab
 * of tiles like More Features. The kind is one more in the form ("A page";
 * name and icon only); the row's "Arrange…" opens the page's two lists under
 * the buttons — Tiles (the grid grammar: items and row breaks, ≤100) and
 * Small buttons (≤12) — built with buildSection over the pseudo-surfaces
 * pageSf(id, 'tiles') / pageSf(id, 'icons') and driven by the same handlers
 * as Home's; the lists live in the user's `layout.pages[id]` (session():
 * o.pages), saved with the layout document (items first, so the page exists
 * before its entry). A page never holds itself; a button on a page is tagged
 * "On “<page>”"; deleting a button takes it off every page, deleting a page
 * drops its entry (dropId's cascade), and the prompt says so. The dots: a
 * page's tiles are arranged under My buttons, so they light that tab.
 *
 * Tabs (ui-custom S5c-b): a tool or saved view button "Opens in" a dialog
 * (large / compact) or A TAB — present:'tab', the shell's button tab
 * (window.ycButtonTabs, up to 3 pages kept open).
 *
 * The firm's starting point (ui-custom S6c-3): every list above is the user
 * step over the FIRM's default (ui_config firm `layout`) — resolveLayout(sf,
 * { base, firm, user, … }), the renderer's own two-tier merge — so a Home
 * the firm arranged is what this editor starts from, a "standard" item is
 * one the firm's default puts there (hidden, not removed), and Reset follows
 * the firm's default again.
 *
 * FIRM MODE (ui-custom S6c-3): open({ scope: 'firm' }) — launched from the
 * Config shell's Firm tab (public/caseconfig/firm.html, Launcher section,
 * "Arrange pages and defaults…"), drawn here in the top document like the
 * icon picker. It edits the firm's `layout` document (scope firm, one
 * versioned document): the firm default of Home + its icon row and the
 * sidebar, the More Features and Admin pages + their icon rows (firm-only
 * surfaces, Fred's ruling), and — S6c-5 — the firm's own PAGES (the Firm
 * pages tab: one block per firm item of kind page, from the catalogue, with
 * its Tiles and Small buttons sections over `layout.pages['firm:…']`;
 * open({ scope:'firm', section:'pages', page }) lands on one block, which is
 * firm.html's "Arrange its tiles…" on a saved Page item) — five tabs
 * (FIRM_PANES: Home, Sidebar, More Features, Admin, Firm pages). Same session core and rules as above, with the firm's document as
 * the edited layer over the shipped DEFAULT_LAYOUTS; nothing is locked
 * against the firm itself, except All in Home's icon row (GUARANTEED). The
 * catalogue: the shell's computeEffective as a superuser sees it with the
 * firm's own overlay (hides, renames, firm items — what the shell renders),
 * no user buttons. The More list starts from what More shows: while the firm
 * has no placed.more, the firm row (a break, then every firm item) closes it
 * (o.seed), so the first save keeps Get Clio Code where it was. Open: a
 * fresh GET /api/ui-config (can_edit_firm, else nothing opens; its
 * firm_versions.layout is the base). Save: ONE PUT { scope:'firm',
 * config_key:'layout', config, base } → firmData.ui.firm.layout := the
 * stored document → applyAccess({ ui }): the shell repaints without a
 * reload. A 409 (someone saved since this opened) keeps every edit and offers
 * a Reload, which discards them for the firm's current arrangement. Who:
 * firm.settings holders (the server re-checks every write); the admin role
 * arranges the Admin page too (ruling 1).
 *
 * window.ycLayoutEditor = { open, close, isOpen, isDirty, session, shortcutSession, reservedProblem,
 *                           itemSession, makeUserId, buttonProblems, firmCatalog,
 *                           FIRM_SURFACES, GUARANTEED, pageSf, PAGE_PARTS }
 *   session(o) is the editor's pure core (no DOM; the panel drives one):
 *   o = { stored, effective, locked, base, registry, groups, firm?, surfaces?,
 *   pass?, seed?, pages? } — see session().
 *   shortcutSession(o) is the Keyboard shortcuts tab's, itemSession(o) My
 *   buttons': see there.
 *   open({ section: 'home' | 'sidebar' | 'shortcuts' | 'buttons' }) opens on that tab (default:
 *   Home — so does any other name, 'layout', the tab's name before L1, included);
 *   open({ scope: 'firm', section?: 'home' | 'sidebar' | 'more' | 'admin' | 'pages', page?, from? }) the firm mode.
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

  var SURFACES = ['home', 'homeIcons', 'sidebar'];   // lib/uiConfigShape.js LAYOUT_SURFACES
  // Surfaces of the user layout this editor does not show: their lists are
  // written back as stored, so a save never drops them. None since
  // launcher-nits L1 gave Home's icon row its section.
  var PASS = [];
  // The firm's layout (S6c-3): every surface (lib/uiConfigShape.js FIRM_LAYOUT_SURFACES).
  var FIRM_SURFACES = ['home', 'sidebar', 'homeIcons', 'more', 'moreIcons', 'admin', 'adminIcons'];
  var BREAK_SF = { home: true, more: true, admin: true };              // lib/uiConfigShape.js BREAK_SURFACES
  var ICON_SF = { homeIcons: true, moreIcons: true, adminIcons: true }; // lib/uiConfigShape.js ICON_SURFACES
  var GUARANTEED = { homeIcons: ['all'] };                             // lib/uiConfigShape.js GUARANTEED
  var NAME = { home: 'Home', sidebar: 'Sidebar', homeIcons: 'Home’s small buttons', more: 'More Features',
    moreIcons: 'More Features’ small buttons', admin: 'Admin', adminIcons: 'Admin’s small buttons' };
  var CAP = 100;          // lib/uiConfigShape.js CAPS.placed / CAPS.removed
  var ICON_CAP = 12;      // lib/uiConfigShape.js CAPS.icons (an icon row's placed list)
  function capOf(sf) { var pg = pageOf(sf); return (pg ? pg.part === 'icons' : ICON_SF[gram(sf)]) ? ICON_CAP : CAP; }
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
  // ignores the same things) — always { placed: {…}, removed: {…} }, plus
  // `pages` when stored (ui-custom S6c-5): { <pageId>: { tiles?, icons? } },
  // a page's tiles with the grid grammar, its icons with an icon row's
  // (lib/uiConfigShape.js PAGE_PARTS). A page is a pseudo-surface pair here,
  // pageSf(id, part) = 'page:<id>:tiles' | 'page:<id>:icons'.
  function copyEntry(e, sf) {
    if (!isObj(e)) return null;
    if (typeof e.item === 'string' && e.item) return { item: e.item };
    if (e.break === true && BREAK_SF[gram(sf)]) return { break: true };
    if (typeof e.label === 'string' && sf === 'sidebar') return { label: e.label };
    return null;
  }
  var PAGE_PARTS = { tiles: 'more', icons: 'moreIcons' };   // lib/uiConfigShape.js PAGE_PARTS: the grammar each list borrows
  var PAGE_SF_RE = /^page:(.+):(tiles|icons)$/;
  function pageSf(id, part) { return 'page:' + id + ':' + part; }
  /** 'page:<id>:<part>' → { id, part }, else null. */
  function pageOf(sf) {
    var m = typeof sf === 'string' ? PAGE_SF_RE.exec(sf) : null;
    return m ? { id: m[1], part: m[2] } : null;
  }
  // The user's OVERLAY on a firm page (launcher-nits L4b1): each part is one
  // more surface of the session, 'over:<firm id>:<part>', with the firm's
  // page list as its base — move / hide / show / add / remove / reset like
  // Home, firm locks holding. Stored nested, in the layout's `overlays`
  // ({ <id>: { placed?: { tiles?, icons? }, removed?: { tiles?, icons? } } }):
  // session() flattens it to these surfaces, doc() nests it back.
  var OVER_SF_RE = /^over:(firm:[a-z0-9-]{1,40}):(tiles|icons)$/;   // the id: lib/uiConfigShape.js FIRM_ID_RE
  function overSf(id, part) { return 'over:' + id + ':' + part; }
  /** 'over:<firm id>:<part>' → { id, part }, else null. */
  function overOf(sf) {
    var m = typeof sf === 'string' ? OVER_SF_RE.exec(sf) : null;
    return m ? { id: m[1], part: m[2] } : null;
  }
  /** The grammar a surface's lists follow: an overlay part borrows its page part's. */
  function gram(sf) { var ov = overOf(sf); return ov ? PAGE_PARTS[ov.part] : sf; }
  function copyOverlay(o) {
    var out = {};
    ['placed', 'removed'].forEach(function (half) {
      if (!isObj(o[half])) return;
      var lists = {}, any = false;
      for (var part in PAGE_PARTS) {
        if (!isArr(o[half][part])) continue;
        lists[part] = half === 'placed'
          ? o[half][part].map(function (e) { return copyEntry(e, PAGE_PARTS[part]); }).filter(Boolean)
          : o[half][part].filter(function (id) { return typeof id === 'string'; });
        any = true;
      }
      if (any) out[half] = lists;
    });
    return out;
  }
  function copyPage(p) {
    var out = {};
    if (!isObj(p)) return out;
    for (var part in PAGE_PARTS) {
      if (isArr(p[part])) out[part] = p[part].map(function (e) { return copyEntry(e, PAGE_PARTS[part]); }).filter(Boolean);
    }
    return out;
  }
  function normalize(doc, surfaces) {
    var out = { placed: {}, removed: {} };
    if (!isObj(doc)) return out;
    (surfaces || SURFACES.concat(PASS)).forEach(function (sf) {
      if (isObj(doc.placed) && isArr(doc.placed[sf])) {
        out.placed[sf] = doc.placed[sf].map(function (e) { return copyEntry(e, sf); }).filter(Boolean);
      }
      if (isObj(doc.removed) && isArr(doc.removed[sf])) {
        out.removed[sf] = doc.removed[sf].filter(function (id) { return typeof id === 'string'; });
      }
    });
    if (isObj(doc.pages)) {
      out.pages = {};
      for (var id in doc.pages) if (hasOwn(doc.pages, id) && isObj(doc.pages[id])) out.pages[id] = copyPage(doc.pages[id]);
    }
    if (isObj(doc.overlays)) {
      out.overlays = {};
      for (var oid in doc.overlays) {
        if (!hasOwn(doc.overlays, oid) || !OVER_SF_RE.test(overSf(oid, 'tiles')) || !isObj(doc.overlays[oid])) continue;
        var ov = copyOverlay(doc.overlays[oid]);
        if (Object.keys(ov).length) out.overlays[oid] = ov;
      }
    }
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
   *   o.lockedForUsers  ids to label "Locked for users" without locking this
   *                     session's controls (firm mode)
   *   o.base       { home, sidebar } base layouts (DEFAULT_LAYOUTS)
   *   o.registry   FEATURE_REGISTRY (surface labels: Bills reads Billing on Home)
   *   o.groups     the All tab's group order (ycLauncher.groups())
   *   o.firm       the firm's layout document (or null): the edited layer
   *                sits on the firm step, as the renderer stacks them (S6c-3)
   *   o.surfaces   the surfaces edited (default Home and the sidebar; the
   *                firm mode: FIRM_SURFACES)
   *   o.pass       the surfaces written back as stored (default PASS; the
   *                firm mode: none)
   *   o.seed       { surface: [id…] } — what the shell draws after a
   *                surface while its working state has no placed list (the
   *                More firm row, S6c-3): a break, then those of the ids that
   *                are effective and not shown yet, closing the list. An
   *                edit writes them as placed entries, where they then are.
   *   o.pages      [id…] — this tier's PAGE items (ui-custom S6c-5: the
   *                firm's firm:… pages, or the user's own user:… ones). Each
   *                is two pseudo-surfaces, pageSf(id, 'tiles') and
   *                pageSf(id, 'icons'), edited with the same calls as a
   *                surface (view / candidates / move / remove / add /
   *                addBreak / room / mode) over the stored `pages[id]`: a
   *                page has NO base, so its lists ARE the page (no hide, no
   *                reset — every row is 'remove'); items not effective are
   *                kept unseen (carry); a page can't hold itself. A stored
   *                page whose item is not in o.pages rides through as stored.
   *                retarget(list, g, pages) replaces the set (a page button
   *                added or deleted before Save); dropId(id) drops the page's
   *                own entry AND the id from every other page (the cascade).
   * Every edit returns true, or false when it is refused (nothing changes).
   */
  function session(o) {
    o = o || {};
    var SFS = isArr(o.surfaces) ? o.surfaces.slice() : SURFACES.slice();
    var PS = isArr(o.pass) ? o.pass.slice() : PASS.slice();
    var stored = normalize(o.stored, SFS.concat(PS));
    // what isDirty compares with: the stored document as it is (overlays nested)
    var storedDoc = JSON.parse(JSON.stringify(stored));
    // the user's overlays on firm pages (L4b1) become surfaces here: an
    // overlay part this session doesn't edit (a page gone, not shown) rides
    // through as stored, like PS
    if (stored.overlays) {
      Object.keys(stored.overlays).forEach(function (oid) {
        ['tiles', 'icons'].forEach(function (part) {
          var sf = overSf(oid, part), ov = stored.overlays[oid];
          if (isObj(ov.placed) && isArr(ov.placed[part])) stored.placed[sf] = ov.placed[part];
          if (isObj(ov.removed) && isArr(ov.removed[part])) stored.removed[sf] = ov.removed[part];
          if (SFS.indexOf(sf) < 0 && PS.indexOf(sf) < 0 && (hasOwn(stored.placed, sf) || hasOwn(stored.removed, sf))) PS.push(sf);
        });
      });
      delete stored.overlays;
    }
    var firmDoc = isObj(o.firm) ? o.firm : null;
    var seed = isObj(o.seed) ? o.seed : {};
    var pageIds = isArr(o.pages) ? o.pages.filter(function (id) { return typeof id === 'string'; }) : [];
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
    var lockedForUsers = Object.create(null);
    (isArr(o.lockedForUsers) ? o.lockedForUsers : []).forEach(function (id) { if (typeof id === 'string') lockedForUsers[id] = true; });
    var base = isObj(o.base) ? o.base : {};
    var reg = isObj(o.registry) ? o.registry : {};
    // defaultIds: the shipped layout's items (a surface label shows only on
    // the default element); baseRows / baseIds: what the edited layer
    // inherits — the shipped layout under the firm's step (S6c-3), so an item
    // the firm's default puts on a surface is a "standard" one there (hidden,
    // never removed). Read live: the effective registry changes (retarget).
    var defaultIds = {}, guaranteed = {};
    SFS.forEach(function (sf) {
      defaultIds[sf] = Object.create(null);
      (isArr(base[sf]) ? base[sf] : []).forEach(function (e) { if (e && typeof e.item === 'string') defaultIds[sf][e.item] = true; });
      guaranteed[sf] = Object.create(null);
      (GUARANTEED[sf] || []).forEach(function (id) { guaranteed[sf][id] = true; });
    });
    // an overlay's base IS the firm's list: no firm step on top of it
    function baseRows(sf) {
      return L.resolveLayout(gram(sf), { base: isArr(base[sf]) ? base[sf] : [], firm: overOf(sf) ? null : firmDoc, user: null, effective: eff, locked: [] });
    }
    function baseIdsOf(sf) {
      var s = Object.create(null);
      baseRows(sf).forEach(function (r) { if (r.kind === 'item') s[r.id] = true; });
      return s;
    }

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
      var g = gram(sf), user = { placed: {}, removed: {} };
      if (st.placed) user.placed[g] = st.placed;
      user.removed[g] = st.removed;
      var rows = L.resolveLayout(g, { base: isArr(base[sf]) ? base[sf] : [], firm: overOf(sf) ? null : firmDoc, user: user, effective: eff, locked: lockedList });
      // the seed (the More firm row): only while nothing is placed here
      if (!st.placed && isArr(seed[sf])) {
        var vis = visibleIds(rows), more = [];
        seed[sf].forEach(function (id) {
          if (typeof id === 'string' && id in byId && !vis[id]) { vis[id] = true; more.push({ kind: 'item', id: id }); }
        });
        if (more.length) rows = rows.concat(BREAK_SF[g] ? [{ kind: 'break' }] : [], more);
      }
      return rows;
    }
    // What a surface looks like: its rows, and its removals as a set.
    function sig(sf) {
      return canonical({ rows: resolved(sf).map(entryOf), removed: S[sf].removed.slice().sort() });
    }
    SFS.forEach(function (sf) { S[sf] = fresh(sf); INIT[sf] = sig(sf); });

    // A surface edited back to what it was is the stored one again; a reset
    // of a surface that has nothing stored is no change. Never back to a
    // stored surface that names a dropped id (a deleted button, S5a): that
    // would write the reference dropId took out.
    var dropped = Object.create(null);
    var swapped = Object.create(null);   // newId → the oldId it replaced (replace)
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

    // ── Pages (S6c-5) ── working state per page id: mode 'stored' (written as
    // stored), 'edited' (the lists below), 'dropped' (its item was deleted:
    // left out); a list is null when absent (an empty page shows nothing).
    var PG = {};
    var storedPages = isObj(stored.pages) ? stored.pages : {};
    function freshPage(id) {
      var sp = hasOwn(storedPages, id) ? storedPages[id] : {};
      return { mode: 'stored', tiles: isArr(sp.tiles) ? sp.tiles.slice() : null, icons: isArr(sp.icons) ? sp.icons.slice() : null };
    }
    function pageState(id) { return PG[id] || (PG[id] = freshPage(id)); }
    function pageCap(part) { return part === 'icons' ? ICON_CAP : CAP; }
    // the list as the shell draws it: effective items once, breaks on the tiles
    function pageRows(id, part) {
      var list = pageState(id)[part], out = [], seen = Object.create(null);
      (isArr(list) ? list : []).forEach(function (e) {
        if (!isObj(e)) return;
        if (typeof e.item === 'string') {
          if (e.item in seen || !(e.item in byId)) return;
          seen[e.item] = true;
          out.push({ kind: 'item', id: e.item });
        } else if (e.break === true && part === 'tiles') out.push({ kind: 'break' });
      });
      return out;
    }
    function pageSig(id) {
      var st = pageState(id);
      return canonical({ tiles: st.tiles, icons: st.icons });
    }
    function storedPageSig(id) {
      var sp = hasOwn(storedPages, id) ? storedPages[id] : {};
      return canonical({ tiles: isArr(sp.tiles) ? sp.tiles : null, icons: isArr(sp.icons) ? sp.icons : null });
    }
    // edited back to what is stored → stored again (never while a dropped id is named there)
    function settlePage(id) {
      var st = PG[id];
      if (!st || st.mode !== 'edited') return;
      for (var d in dropped) if (pageNames(id, d)) return;
      if (pageSig(id) === storedPageSig(id)) PG[id] = freshPage(id);
    }
    function pageNames(id, ref) {
      var st = pageState(id);
      return ['tiles', 'icons'].some(function (part) { return isArr(st[part]) && indexOfItem(st[part], ref) >= 0; });
    }
    function commitPage(id, part, rows) {
      var st = pageState(id), next = {};
      next.mode = 'edited';
      next.tiles = st.tiles; next.icons = st.icons;
      next[part] = carry(st[part], rows.map(entryOf));
      PG[id] = next;
      settlePage(id);
      return true;
    }
    function pageSizeAfter(id, part, rows) { return carry(pageState(id)[part], rows.map(entryOf)).length; }
    /** The page ids this session edits, in order; dropped ones out. */
    function livePages() { return pageIds.filter(function (id) { return !(PG[id] && PG[id].mode === 'dropped'); }); }
    var pageApi = {
      view: function (pg) {
        return pageRows(pg.id, pg.part).map(function (r) {
          if (r.kind !== 'item') return { kind: 'break', act: 'remove' };
          var v = entryView(pg.part === 'tiles' ? 'more' : 'moreIcons', byId[r.id]);
          v.kind = 'item'; v.base = false; v.locked = false; v.lockedForUsers = r.id in lockedForUsers; v.always = false; v.firm = /^firm:/.test(r.id); v.act = 'remove';
          return v;
        });
      },
      candidates: function (pg, query) {
        var vis = visibleIds(pageRows(pg.id, pg.part));
        var list = eff.filter(function (e) { return !(e.id in vis) && e.id !== pg.id; });   // a page never holds itself
        if (String(query == null ? '' : query).replace(/\s+/g, '')) {
          return [{ group: null, items: L.rank(query, list).map(function (e) { return entryView('more', e); }) }];
        }
        var order = groups.slice();
        list.forEach(function (e) { if (order.indexOf(e.group) < 0) order.push(e.group); });
        return order.map(function (g) {
          return { group: g, items: list.filter(function (e) { return e.group === g; }).map(function (e) { return entryView('more', e); }) };
        }).filter(function (g) { return g.items.length; });
      },
      room: function (pg) { return pageCap(pg.part) - pageSizeAfter(pg.id, pg.part, pageRows(pg.id, pg.part)); },
      move: function (pg, i, d) {
        var rows = pageRows(pg.id, pg.part), j = i + d;
        if (!(i >= 0 && i < rows.length && j >= 0 && j < rows.length) || (d !== 1 && d !== -1)) return false;
        var t = rows[i]; rows[i] = rows[j]; rows[j] = t;
        return commitPage(pg.id, pg.part, rows);
      },
      remove: function (pg, i) {
        var rows = pageRows(pg.id, pg.part);
        if (!rows[i]) return false;
        rows.splice(i, 1);
        return commitPage(pg.id, pg.part, rows);
      },
      add: function (pg, id) {
        var rows = pageRows(pg.id, pg.part);
        if (!(id in byId) || id === pg.id || visibleIds(rows)[id]) return false;
        rows.push({ kind: 'item', id: id });
        if (pageSizeAfter(pg.id, pg.part, rows) > pageCap(pg.part)) return false;
        return commitPage(pg.id, pg.part, rows);
      },
      addBreak: function (pg) {
        if (pg.part !== 'tiles') return false;
        var rows = pageRows(pg.id, 'tiles');
        rows.push({ kind: 'break' });
        if (pageSizeAfter(pg.id, 'tiles', rows) > CAP) return false;
        return commitPage(pg.id, 'tiles', rows);
      },
    };
    function without(list, id) { return list.filter(function (x) { return x !== id; }); }
    function displayLabel(sf, e) {
      var it = hasOwn(reg, e.id) && isObj(reg[e.id]) ? reg[e.id] : null;
      // a surface label (Bills → Billing on Home) only where the default
      // element shows it: a base item that the firm has not renamed
      if (it && isObj(it.surfaceLabels) && it.surfaceLabels[sf] != null && e.label === it.label && defaultIds[sf] && e.id in defaultIds[sf]) {
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
    // items) — the server caps a list at capOf(sf).
    function sizeAfter(sf, rows) { return carry(S[sf].placed, rows.map(entryOf)).length; }

    var api = {
      /** The surface as the user sees it: { kind:'item', id, label, icon,
       *  base, locked, lockedForUsers, always, firm, act } | { kind:'break', act } | { kind:'label',
       *  text, act }. act: 'hide' (a default item), 'locked' (a default item
       *  the firm locked, or one always on this surface — All in Home's icon
       *  row: no hide), 'remove' (anything the user added). */
      view: function (sf) {
        var pg = pageOf(sf);
        if (pg) return pageApi.view(pg);
        var baseIds = baseIdsOf(sf);
        return resolved(sf).map(function (r) {
          if (r.kind !== 'item') return r.kind === 'label' ? { kind: 'label', text: r.text, act: 'remove' } : { kind: 'break', act: 'remove' };
          var v = entryView(sf, byId[r.id]);
          v.kind = 'item';
          v.base = r.id in baseIds;
          v.locked = r.id in locked;
          v.lockedForUsers = r.id in lockedForUsers;
          v.always = r.id in guaranteed[sf];
          v.firm = /^firm:/.test(r.id);
          v.act = v.always ? 'locked' : v.base ? (v.locked ? 'locked' : 'hide') : 'remove';
          return v;
        });
      },
      /** Default items the user hid here (effective, not locked), base order
       *  (the base the edited layer inherits: the firm's step, S6c-3). */
      hidden: function (sf) {
        if (pageOf(sf)) return [];   // a page has no base: nothing is ever hidden on it
        var rm = Object.create(null), vis = visibleIds(resolved(sf)), out = [];
        S[sf].removed.forEach(function (id) { rm[id] = true; });
        baseRows(sf).forEach(function (e) {
          var id = e.kind === 'item' ? e.id : null;
          if (typeof id !== 'string' || !(id in rm) || !(id in byId) || id in locked || id in guaranteed[sf] || id in vis) return;
          if (out.some(function (x) { return x.id === id; })) return;
          out.push(entryView(sf, byId[id]));
        });
        return out;
      },
      /** The "Add a shortcut" picker: effective items not visible on sf.
       *  A query ranks them with the All tab's matcher (one flat group);
       *  without one they are grouped like All. → [{ group, items: [view] }] */
      candidates: function (sf, query) {
        var pg = pageOf(sf);
        if (pg) return pageApi.candidates(pg, query);
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
      /** The surfaces an id is visible on: ['home'?, 'homeIcons'?, 'sidebar'?]
       *  (the session's surfaces, in order). */
      where: function (id) {
        return SFS.filter(function (sf) { return !!visibleIds(resolved(sf))[id]; });
      },
      /** The pages (ids, this session's order) whose tiles or icons show id (S6c-5). */
      pagesHolding: function (id) {
        return livePages().filter(function (p) { return !!visibleIds(pageRows(p, 'tiles'))[id] || !!visibleIds(pageRows(p, 'icons'))[id]; });
      },
      /** This tier's pages as edited now: [id…] (dropped ones out). */
      pages: function () { return livePages(); },
      /** What is dirty: the surfaces (Home / sidebar…), the pages — the panel's tab dots. */
      dirtyParts: function () {
        var surfaces = SFS.some(function (sf) { return S[sf].mode !== 'stored'; });
        var pages = Object.keys(PG).some(function (id) { return PG[id].mode !== 'stored'; });
        return { surfaces: surfaces, pages: pages };
      },
      /** A new effective registry (and group order) — the panel's own
       *  buttons changed (S5a). Nothing stored or edited changes. */
      // …and a surface edited back to what it was becomes the stored one again
      // under the new registry (S5c-b review N1: a replace() undone by
      // deleting the new button, settled while the old id was out of it).
      retarget: function (list, g, pages) {
        setEffective(list, g);
        if (isArr(pages)) pageIds = pages.filter(function (id) { return typeof id === 'string'; });
        SFS.forEach(settle);
        Object.keys(PG).forEach(settlePage);
        return true;
      },
      /** A button the user deleted (S5a): drop every placement and removal
       *  of id on both surfaces — a surface that held it becomes edited —
       *  so no dangling reference is written. → whether anything changed. */
      dropId: function (id) {
        var any = false;
        if (typeof id !== 'string') return false;
        dropped[id] = true;
        // the cascade (S6c-5): the page's own entry goes, and the id leaves every other page
        if (hasOwn(storedPages, id) || hasOwn(PG, id)) { pageState(id); PG[id].mode = 'dropped'; any = true; }
        pageIds.concat(Object.keys(storedPages)).forEach(function (p) {
          if (p === id || (PG[p] && PG[p].mode === 'dropped') || !pageNames(p, id)) return;
          var st = pageState(p), next = { mode: 'edited', tiles: st.tiles, icons: st.icons };
          ['tiles', 'icons'].forEach(function (part) {
            if (isArr(st[part])) next[part] = st[part].filter(function (e) { return e.item !== id; });
          });
          PG[p] = next;
          any = true;
        });
        SFS.forEach(function (sf) {
          var st = S[sf];
          var placed = st.mode === 'stored' ? (hasOwn(stored.placed, sf) ? stored.placed[sf] : null) : st.placed;
          var removed = st.mode === 'stored' ? (hasOwn(stored.removed, sf) ? stored.removed[sf] : []) : st.removed;
          var inPlaced = !!placed && indexOfItem(placed, id) >= 0, inRemoved = removed.indexOf(id) >= 0;
          if (!inPlaced && !inRemoved) return;
          any = true;
          // a button that took another item's place (replace) gives the
          // place back: the item returns to that very slot, so a cancelled
          // swap leaves the surface as it was (S5c-b review N1)
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
      /** On each surface where oldId shows, newId takes its place — unless
       *  newId already shows there (S5c-b; the panel's custom-tab conversion
       *  used it until S5e retired the custom tab — scripts/
       *  uiCustomS5eCustomTabsToButtons.js still does). oldId leaves that
       *  surface's placed list (it is in this session's registry right now,
       *  so carry() never puts it back); while it is still effective the
       *  resolver would slot it back in as a base item, so the caller
       *  retargets without it. → the surfaces changed. */
      replace: function (oldId, newId) {
        var out = [];
        if (typeof newId !== 'string' || !(newId in byId)) return out;
        SFS.forEach(function (sf) {
          var rows = resolved(sf), at = -1;
          for (var i = 0; i < rows.length; i++) if (rows[i].kind === 'item' && rows[i].id === oldId) at = i;
          if (at < 0 || visibleIds(rows)[newId]) return;
          rows[at] = { kind: 'item', id: newId };
          if (sizeAfter(sf, rows) > capOf(sf)) return;
          commit(sf, rows, without(S[sf].removed, newId));
          swapped[newId] = oldId;
          out.push(sf);
        });
        return out;
      },
      /** Room left on sf (entries Save could still add). */
      room: function (sf) { var pg = pageOf(sf); return pg ? pageApi.room(pg) : capOf(sf) - sizeAfter(sf, resolved(sf)); },
      mode: function (sf) { var pg = pageOf(sf); return pg ? pageState(pg.id).mode : S[sf].mode; },

      move: function (sf, i, d) {
        var pg = pageOf(sf);
        if (pg) return pageApi.move(pg, i, d);
        var rows = resolved(sf), j = i + d;
        if (!(i >= 0 && i < rows.length && j >= 0 && j < rows.length) || (d !== 1 && d !== -1)) return false;
        var t = rows[i]; rows[i] = rows[j]; rows[j] = t;
        return commit(sf, rows, S[sf].removed.slice());
      },
      hide: function (sf, i) {
        if (pageOf(sf)) return false;
        var rows = resolved(sf), r = rows[i];
        if (!r || r.kind !== 'item' || !(r.id in baseIdsOf(sf)) || r.id in locked || r.id in guaranteed[sf]) return false;
        var removed = S[sf].removed.slice();
        if (removed.indexOf(r.id) < 0) {
          if (removed.length >= CAP) return false;
          removed.push(r.id);
        }
        rows.splice(i, 1);
        return commit(sf, rows, removed);
      },
      remove: function (sf, i) {
        var pg = pageOf(sf);
        if (pg) return pageApi.remove(pg, i);
        var rows = resolved(sf), r = rows[i];
        if (!r || (r.kind === 'item' && (r.id in baseIdsOf(sf) || r.id in guaranteed[sf]))) return false;
        rows.splice(i, 1);
        return commit(sf, rows, S[sf].removed.slice());
      },
      show: function (sf, id) {
        if (!api.hidden(sf).some(function (h) { return h.id === id; })) return false;
        var removed = without(S[sf].removed, id);
        var rows = resolved(sf, { placed: S[sf].placed, removed: removed });   // the resolver slots it back
        if (sizeAfter(sf, rows) > capOf(sf)) return false;
        return commit(sf, rows, removed);
      },
      add: function (sf, id) {
        var pg = pageOf(sf);
        if (pg) return pageApi.add(pg, id);
        var rows = resolved(sf);
        if (!(id in byId) || visibleIds(rows)[id]) return false;
        rows.push({ kind: 'item', id: id });
        if (sizeAfter(sf, rows) > capOf(sf)) return false;
        return commit(sf, rows, without(S[sf].removed, id));
      },
      /** A row break at the end of sf (default Home; a grid only). */
      addBreak: function (sf) {
        sf = sf == null ? 'home' : sf;
        var pg = pageOf(sf);
        if (pg) return pageApi.addBreak(pg);
        if (!BREAK_SF[gram(sf)] || !hasOwn(S, sf)) return false;
        var rows = resolved(sf);
        rows.push({ kind: 'break' });
        if (sizeAfter(sf, rows) > capOf(sf)) return false;
        return commit(sf, rows, S[sf].removed.slice());
      },
      addLabel: function (text) {
        if (labelProblem(text) || !hasOwn(S, 'sidebar')) return false;
        var rows = resolved('sidebar');
        rows.push({ kind: 'label', text: text.trim() });
        if (sizeAfter('sidebar', rows) > CAP) return false;
        return commit('sidebar', rows, S.sidebar.removed.slice());
      },
      setLabel: function (sf, i, text) {
        if (pageOf(sf)) return false;
        var rows = resolved(sf);
        if (!rows[i] || rows[i].kind !== 'label' || labelProblem(text)) return false;
        rows[i] = { kind: 'label', text: text.trim() };
        return commit(sf, rows, S[sf].removed.slice());
      },
      reset: function (sf) {
        if (pageOf(sf) || !hasOwn(S, sf)) return false;
        S[sf] = { mode: 'reset', placed: null, removed: [] };
        settle(sf);
        return true;
      },

      /** The document Save writes. */
      doc: function () {
        var out = { placed: {}, removed: {} };
        SFS.forEach(function (sf) {
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
        PS.forEach(function (sf) {
          if (hasOwn(stored.placed, sf)) out.placed[sf] = stored.placed[sf].map(function (e) { return copyEntry(e, sf); });
          if (hasOwn(stored.removed, sf)) out.removed[sf] = stored.removed[sf].slice();
        });
        // the pages (S6c-5): a stored page as stored or as edited, a dropped
        // one left out, a page edited into being written; a page whose two
        // lists are absent is written as {} (an empty page). The key stays
        // whenever it was stored, so an untouched document round-trips.
        var pages = {}, anyPage = false;
        var ids = Object.keys(storedPages);
        pageIds.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
        ids.forEach(function (id) {
          var st = PG[id];
          if (st && st.mode === 'dropped') return;
          var src = st && st.mode === 'edited' ? st : (hasOwn(storedPages, id) ? { tiles: isArr(storedPages[id].tiles) ? storedPages[id].tiles : null, icons: isArr(storedPages[id].icons) ? storedPages[id].icons : null } : null);
          if (!src) return;   // a page item with nothing stored and nothing edited: no entry
          var pgOut = {};
          ['tiles', 'icons'].forEach(function (part) {
            if (isArr(src[part])) pgOut[part] = src[part].map(function (e) { return copyEntry(e, PAGE_PARTS[part]); }).filter(Boolean);
          });
          pages[id] = pgOut;
          anyPage = true;
        });
        if (anyPage || stored.pages) out.pages = pages;
        // the overlay surfaces (L4b1) nest back into `overlays`
        var overlays = {}, anyOv = false;
        Object.keys(out.placed).concat(Object.keys(out.removed)).forEach(function (sf) {
          var ov = overOf(sf);
          if (!ov) return;
          var o = overlays[ov.id] || (overlays[ov.id] = {});
          if (hasOwn(out.placed, sf)) { (o.placed || (o.placed = {}))[ov.part] = out.placed[sf]; delete out.placed[sf]; }
          if (hasOwn(out.removed, sf)) { (o.removed || (o.removed = {}))[ov.part] = out.removed[sf]; delete out.removed[sf]; }
          anyOv = true;
        });
        if (anyOv || storedDoc.overlays) out.overlays = overlays;
        return out;
      },
      isDirty: function () { return canonical(api.doc()) !== canonical(storedDoc); },
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
  var MB_KINDS = ['view', 'tool', 'url', 'drawer', 'page'];   // 'drawer' reads "List" everywhere the user sees it (S6c-5); 'page' is a page of tiles
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
  /** Every user: id anywhere in v (a layout or shortcuts document) — values
   *  and object KEYS (a layout's pages map is keyed by page id, S6c-5). */
  function userIdsIn(v, out) {
    out = out || Object.create(null);
    if (typeof v === 'string') { if (USER_ID_RE.test(v)) out[v] = true; return out; }
    if (isArr(v)) v.forEach(function (x) { userIdsIn(x, out); });
    else if (isObj(v)) for (var k in v) if (hasOwn(v, k)) { if (USER_ID_RE.test(k)) out[k] = true; userIdsIn(v[k], out); }
    return out;
  }
  /** The field problems of a button form: { label?, icon?, key?, href? }. */
  function buttonProblems(f) {
    var p = {};
    var lp = labelProblem(f.label);
    if (lp) p.label = lp === 'Type a label' ? 'Give it a name' : lp;
    if (!ICON_RE.test(String(f.icon == null ? '' : f.icon).trim())) p.icon = 'Choose an icon';
    if (f.type === 'page') { /* a page: name and icon only; its tiles are arranged on its row (S6c-5) */ }
    else if (f.type === 'url') {
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
      if (refs.length > DRAWER_CAP) p.refs = 'A list holds at most ' + DRAWER_CAP + ' items';
      else if (refs.some(function (r, i) { return typeof r !== 'string' || refs.indexOf(r) !== i; })) p.refs = 'Each item can be in the list once';
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
      if (r.type === 'page') return { id: r.id, label: String(r.label).trim(), icon: String(r.icon).trim(), action: { type: 'page' } };
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
      if (r.type === 'page') return 'Page · a tab of tiles';
      if (r.type === 'drawer') {
        var n = (r.refs || []).length;
        return 'List · ' + (n ? n + (n === 1 ? ' item' : ' items') : 'empty');
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
        if (r && f.refs.indexOf(r.id) >= 0) p.refs = 'A list can’t hold itself';
        else if (f.refs.some(function (id) { return id in drawerIds; })) p.refs = 'A list can’t hold another list';
        var inside = r ? holders(r.id).filter(function (x) { return x !== r; }) : [];
        if (inside.length) p.type = 'It is inside the list “' + inside[0].label + '”: a list can’t go inside a list. Take it out of that list first.';
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
          : f.type === 'drawer' ? { refs: 'Those items can’t be in a list' } : f.type === 'page' ? { label: 'That page can’t be made' } : { key: 'That choice can’t be used' };
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
       *  inDrawers: [list label…] }]. */
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
      /** A button deleted (S5b): drop id from every list (drawer). → how many held it. */
      dropRef: function (id) {
        var n = 0;
        R.forEach(function (r) {
          if (r.kept || r.type !== 'drawer') return;
          var k = (r.refs || []).indexOf(id);
          if (k >= 0) { r.refs.splice(k, 1); n++; }
        });
        return n;
      },
      /** The lists' (drawers') ids (one level deep: none of them can go in a list). */
      drawerIds: function () { return R.filter(function (r) { return !r.kept && r.type === 'drawer'; }).map(function (r) { return r.id; }); },
      /** What a list (drawer) can take: the entries of `effective` (an effective
       *  registry) that are not lists and not in `refs`, grouped like All
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
      /** The tool / view lists arrived (or failed: null) — summaries follow. */
      setPickers: function (p) { pk = isObj(p) ? p : null; return true; },
      ids: function () { return R.map(function (r) { return r.id; }); },
      storedIds: function () { return Object.keys(storedIds); },
      retired: function () { return retired.slice(); },
      /** Effective-registry entries for the buttons the shell would list —
       *  group Mine, in order (a kept one is listed by nobody); a page says so. */
      entries: function () {
        return R.filter(function (r) { return !r.kept; }).map(function (r) {
          var e = { id: r.id, group: MINE, label: r.label, labels: [r.label], icon: r.icon };
          if (r.type === 'page') e.page = true;
          return e;
        });
      },
      /** The ids of the buttons that are pages (S6c-5), in order. */
      pageIds: function () { return R.filter(function (r) { return !r.kept && r.type === 'page'; }).map(function (r) { return r.id; }); },
      /** The document Save writes: { items } (`retired` is the server's). */
      doc: function () { return { items: R.map(itemOf) }; },
      isDirty: function () { return canonical(api.doc().items) !== canonical(storedItems); },
    };
    return api;
  }

  // ── The firm mode's catalogue (S6c-3) ──────────────────────────────────
  /** Every item the firm can arrange: the shell's own computeEffective as a
   *  superuser sees it under the firm's overlay — its hides (a hidden item is
   *  drawn nowhere, so it isn't offered; a placement of one is carried), its
   *  renames and its firm items — with no user buttons and no denies: what
   *  the launcher draws. seed: the firm items in order — the
   *  More grid's firm row, which closes the More list while the firm has no
   *  placed.more. ui = { firm: { registry_overrides? } }.
   *  → { entries: [{ id, group, label, labels, icon }], groups, seed } */
  function firmCatalog(ui) {
    var ro = isObj(ui) && isObj(ui.firm) && isObj(ui.firm.registry_overrides) ? ui.firm.registry_overrides : {};
    var list = L.computeEffective({ isAdmin: true, roles: ['su'], denied: [], ui: { firm: { registry_overrides: ro } } });
    var mine = list.filter(function (e) { return !USER_ID_RE.test(e.id); });
    var isPg = function (e) { return !!(e.action && e.action.type === 'page'); };
    return {
      entries: mine.map(function (e) {
        var o = { id: e.id, group: e.group, label: e.label, labels: e.labels.slice(), icon: e.icon };
        if (isPg(e)) o.page = true;
        return o;
      }),
      groups: (list.groups || []).filter(function (g) { return mine.some(function (e) { return e.group === g; }); }),
      seed: mine.filter(function (e) { return !!e.action; }).map(function (e) { return e.id; }),
      pages: mine.filter(isPg).map(function (e) { return e.id; }),   // the firm's pages (S6c-5), in order
    };
  }

  // ── The panel ───────────────────────────────────────────────────────────
  if (typeof document === 'undefined') {
    window.ycLayoutEditor = {
      session: session, labelProblem: labelProblem, canonical: canonical,
      shortcutSession: shortcutSession, reservedProblem: reservedProblem,
      itemSession: itemSession, makeUserId: makeUserId, buttonProblems: buttonProblems,
      firmCatalog: firmCatalog, FIRM_SURFACES: FIRM_SURFACES, GUARANTEED: GUARANTEED, pageSf: pageSf, PAGE_PARTS: PAGE_PARTS,
    };
    return;
  }

  var root = null, sess = null, opener = null, saving = false;
  var labelErr = {};        // 'sf:i' → message, for label inputs holding a bad value
  var scs = null;           // the Keyboard shortcuts tab's session
  var sessOpts = null;      // what sess was built from (a partial save rebuilds it)
  var scAdd = null;         // the shortcut being added: { id, combo }
  var its = null;           // the My buttons tab's session (S5a)
  var pickers = null;       // GET /api/ui-config/pickers, read the first time My buttons shows
  var pickersState = 'idle';   // 'idle' | 'loading' | 'ok' | 'failed' — per opening
  var opening = 0;          // bumps on every show(): a late picker reply for an old opening is dropped
  var mbForm = null;        // the button form while it is open: { i } (-1 = a new one)
  var PANES = ['home', 'sidebar', 'pages', 'shortcuts', 'buttons'];
  var USER_PANE_OF = { home: 'home', homeIcons: 'home', sidebar: 'sidebar' };   // a surface's tab
  var KEYS = (window.ycAll && window.ycAll.keys) || null;
  // The firm mode (S6c-3): the panel is built for ONE scope at a time —
  // 'user' (Customize my launcher) or 'firm' — and rebuilt when the other
  // one opens (never while it is open: one modal at a time).
  var scope = 'user';
  var firmBase;             // the firm mode's base: firm_versions.layout at open (null = no row; undefined = not told → none sent)
  var firmFrom = null;      // what opened the firm mode (a reload keeps it)
  var FIRM_PANES = [
    { id: 'home', label: 'Home', icon: 'house', surfaces: ['home', 'homeIcons'],
      intro: 'What everyone\u2019s Home starts from. Someone who has arranged their own keeps their arrangement; ' +
        'what you add here is added for them too, next to its neighbour.' },
    { id: 'sidebar', label: 'Sidebar', icon: 'bars', surfaces: ['sidebar'],
      intro: 'What everyone\u2019s sidebar starts from. Someone who has arranged their own keeps their arrangement; ' +
        'what you add here is added for them too, next to its neighbour.' },
    { id: 'more', label: 'More Features', icon: 'grip', surfaces: ['more', 'moreIcons'],
      intro: 'The More Features page for everyone: the tiles left to right, a row break starts a new row. Your firm\u2019s own items go wherever you put them.' },
    { id: 'admin', label: 'Admin', icon: 'mug-hot', surfaces: ['admin', 'adminIcons'],
      intro: 'The Admin page for everyone who sees it. Each person still sees only the tiles they are allowed to open.' },
    // the firm's pages (S6c-5): one block per firm page item, built by buildFirmPages
    { id: 'pages', label: 'Firm pages', icon: 'layer-group', surfaces: [],
      intro: 'Your firm\u2019s own pages: each is a tab of tiles like More Features, for everyone who sees it. ' +
        'A page\u2019s name, icon and who sees it are set in the Firm tab (Firm items, Who sees what); here you arrange what is on it.' },
  ];
  var NO_FIRM_PAGES = 'No firm pages yet. Add one in the Firm tab\u2019s Firm items (kind Page), save there, then arrange its tiles here.';
  var PAGE_PART_NAME = { tiles: 'Tiles', icons: 'Small buttons' };
  var PAGE_PART_HINT = {
    tiles: 'The page\u2019s big tiles, left to right; a row break starts a new row. A panel opens on the page itself; anything else opens where it always does.',
    icons: 'The small round buttons under the tiles (up to 12).',
  };
  var ON_NAME = { home: 'Home', homeIcons: 'Home\u2019s small buttons', sidebar: 'sidebar' };   // where a button is (My buttons' tags, the delete prompt)
  var USER_RESET = { home: 'Reset Home to default', homeIcons: 'Reset small buttons to default', sidebar: 'Reset sidebar to default' };
  var USER_RESET_ASK = {
    home: 'Reset Home to the standard layout? Your Home arrangement is replaced when you Save.',
    homeIcons: 'Reset Home\u2019s small buttons to the standard ones? Your arrangement of them is replaced when you Save.',
    sidebar: 'Reset the sidebar to the standard layout? Your sidebar arrangement is replaced when you Save.',
  };
  var USER_PICK = { home: 'Add a shortcut to Home', homeIcons: 'Add a small button to Home', sidebar: 'Add a shortcut to the sidebar' };
  var OVER_HINT = {
    tiles: 'The page\u2019s tiles, left to right; a row break starts a new row.',
    icons: 'The small round buttons under the tiles (up to 12).',
  };
  var USER_HINT = { homeIcons: 'The small round buttons under your Home tiles (up to 12). All always stays here: you can move it, not hide it.' };
  var FIRM_HINT = {
    homeIcons: 'The small round buttons under the Home tiles. All always stays here.',
    moreIcons: 'The small round buttons under the More Features tiles (Casey\u2019s paw).',
    adminIcons: 'The small round buttons under the Admin tiles (none as shipped).',
  };
  var SESSION_MSG = 'Your session predates a permissions change \u2014 sign out and back in.';   // firm.html SESSION_MSG
  var CONFLICT_MSG = 'Someone else saved the firm\u2019s arrangement since you opened this, so nothing was saved. ' +
    'Reload to see theirs: your changes here are discarded.';
  var FIRM_DENIED = 'Arranging the firm\u2019s pages needs the firm-settings permission.';
  function panes() { return scope === 'firm' ? FIRM_PANES.map(function (p) { return p.id; }) : PANES; }
  function liveSurfaces() { return scope === 'firm' ? FIRM_SURFACES : SURFACES; }
  /** Every layout section the panel holds right now: the surfaces plus the
   *  page pseudo-surfaces built for this opening (S6c-5). */
  function builtSurfaces() {
    if (!root) return [];
    return Array.prototype.map.call(root.querySelectorAll('.yle-sec[data-sf]'), function (n) { return n.getAttribute('data-sf'); })
      .filter(function (sf) { return sf !== 'shortcuts' && sf !== 'buttons'; });
  }
  function paneOf(sf) {
    if (pageOf(sf)) return scope === 'firm' ? 'pages' : 'buttons';
    if (overOf(sf)) return 'pages';
    if (scope !== 'firm') return PANE_OF[sf] || USER_PANE_OF[sf] || sf;
    for (var i = 0; i < FIRM_PANES.length; i++) if (FIRM_PANES[i].surfaces.indexOf(sf) >= 0) return FIRM_PANES[i].id;
    return FIRM_PANES[0].id;
  }
  /** A section's title: a surface's NAME, a page part's PAGE_PART_NAME. */
  function sfName(sf) {
    var pg = pageOf(sf) || overOf(sf);
    return pg ? PAGE_PART_NAME[pg.part] : NAME[sf];
  }
  /** The firm pages this user sees (L4b1): [{ id, label, icon }], All's order. */
  function firmPagesNow() {
    return L.effectiveRegistry().filter(function (e) { return e.page && /^firm:/.test(e.id); })
      .map(function (e) { return { id: e.id, label: String(e.label), icon: e.icon }; });
  }
  var overLabels = {};   // firm page id → its label, for this opening (onName, the reset question)
  /** Where a button is, in words: Home, Home's small buttons, sidebar, or a firm page. */
  function onName(sf) {
    var ov = overOf(sf);
    return ov ? 'firm page \u201c' + (overLabels[ov.id] || ov.id) + '\u201d' : ON_NAME[sf];
  }
  /** The overlay sections built for this opening. */
  function overSurfaces() { return builtSurfaces().filter(function (sf) { return !!overOf(sf); }); }
  function anyDirty() { return !!((sess && sess.isDirty()) || (scs && scs.isDirty()) || (its && its.isDirty())); }

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

  function build(sc) {
    sc = sc === 'firm' ? 'firm' : 'user';
    if (root && scope === sc) return;
    if (root) { root.parentNode && root.parentNode.removeChild(root); root = null; }
    scope = sc;
    var firm = sc === 'firm';
    root = el('div');
    root.id = 'ycLayoutEditor';
    root.setAttribute('data-scope', sc);
    root.hidden = true;
    var box = el('div', 'yle-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'yleTitle');
    var head = el('div', 'yle-head');
    var h = el('h2');
    h.id = 'yleTitle';
    h.appendChild(iconEl(firm ? 'building' : 'sliders'));
    h.appendChild(document.createTextNode(firm ? ' Arrange pages and defaults for everyone' : ' Customize my launcher'));
    head.appendChild(h);
    head.appendChild(btn('yle-x', 'cancel', 'Close', 'xmark'));
    box.appendChild(head);

    // The tabs (S4c; the firm mode's, S6c-3): a strip outside the scrolling
    // body, so it stays in view; a dot marks a tab with unsaved changes.
    var tabs = el('div', 'yle-tabs');
    tabs.setAttribute('role', 'tablist');
    var tabList = firm ? FIRM_PANES.map(function (p) { return [p.id, p.label, p.icon]; })
      : [['home', 'Home', 'house'], ['sidebar', 'Sidebar', 'bars'], ['pages', 'Firm pages', 'layer-group'], ['shortcuts', 'Keyboard shortcuts', 'keyboard'], ['buttons', 'My buttons', 'star']];
    tabList.forEach(function (t) {
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
    var pane = function (id) {
      var p = el('div', 'yle-pane');
      p.id = 'ylePane_' + id;
      p.setAttribute('data-pane', id);
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', 'yleTab_' + id);
      return p;
    };
    if (firm) {
      // a 409's way out (S6c-3): reload the firm's arrangement as it is now
      var cf = el('div', 'yle-conflict');
      cf.hidden = true;
      cf.appendChild(btn('yle-add', 'reload', null, 'rotate', 'Reload the firm’s arrangement'));
      body.appendChild(cf);
      FIRM_PANES.forEach(function (fp, i) {
        var p = pane(fp.id);
        p.hidden = i > 0;
        p.appendChild(el('p', 'yc-hint yle-intro', fp.intro + ' Nothing changes until you Save.'));
        fp.surfaces.forEach(function (sf) { p.appendChild(buildSection(sf)); });
        if (fp.id === 'pages') p.appendChild(el('div', 'yle-firm-pages'));   // filled per opening (buildFirmPages)
        body.appendChild(p);
      });
    } else {
      [['home', 'Arrange your own Home tiles and the small buttons under them.'],
        ['sidebar', 'Arrange your own sidebar.']].forEach(function (u, i) {
        var lay = pane(u[0]);
        lay.hidden = i > 0;
        lay.appendChild(el('p', 'yc-hint yle-intro', u[1] + ' Nothing changes until you Save. ' +
          'Hiding an item only takes its shortcut away: All and Ctrl+K still list every feature you have.'));
        SURFACES.forEach(function (sf) { if (USER_PANE_OF[sf] === u[0]) lay.appendChild(buildSection(sf)); });
        body.appendChild(lay);
      });
      // your firm's pages (L4b1): one block per page, built per opening (buildUserFirmPages)
      var fpp = pane('pages');
      fpp.hidden = true;
      fpp.appendChild(el('p', 'yc-hint yle-intro', 'Your firm\u2019s pages, as you see them. Move, hide or add tiles on each: ' +
        'your arrangement is yours, and Reset puts the firm\u2019s back. Nothing changes until you Save.'));
      fpp.appendChild(el('div', 'yle-user-pages'));
      body.appendChild(fpp);
      var scp = pane('shortcuts');
      scp.hidden = true;
      scp.appendChild(buildShortcutSection());
      body.appendChild(scp);
      var mbp = pane('buttons');
      mbp.hidden = true;
      mbp.appendChild(buildButtonsSection());
      body.appendChild(mbp);
    }
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
    // non-focusable spot in the card leaves focus on <body>. (The same
    // function each build: added once.)
    document.addEventListener('keydown', onKey);
    // a press that starts AND ends on the backdrop closes (not a text
    // selection dragged out of the card)
    var downOnBackdrop = false;
    root.addEventListener('mousedown', function (e) { downOnBackdrop = e.target === root; });
    root.addEventListener('click', function (e) { if (e.target === root && downOnBackdrop) requestClose(); });
  }

  // A page's two sections (S6c-5, sf = pageSf(id, part)) take the same markup
  // with no Reset and no "Hidden on this surface" (a page has no base).
  function buildSection(sf) {
    var pg = pageOf(sf), ov = overOf(sf), icons = pg ? pg.part === 'icons' : !!ICON_SF[gram(sf)];
    var sec = el('section', 'yle-sec' + (pg ? ' yle-page-sec' : ''));
    sec.setAttribute('data-sf', sf);
    var head = el('div', 'yle-sec-head');
    head.appendChild(el('h3', null, sfName(sf)));
    if (!pg) {
      head.appendChild(btn('yle-reset', 'reset', null, 'rotate-left', scope === 'firm' ? 'Reset to standard'
        : ov ? 'Reset to the firm\u2019s' : USER_RESET[sf]));
    }
    sec.appendChild(head);
    if (pg) sec.appendChild(el('p', 'yc-hint yle-sec-hint', PAGE_PART_HINT[pg.part]));
    else if (scope === 'firm' && FIRM_HINT[sf]) sec.appendChild(el('p', 'yc-hint yle-sec-hint', FIRM_HINT[sf]));
    else if (ov) sec.appendChild(el('p', 'yc-hint yle-sec-hint', OVER_HINT[ov.part]));
    else if (scope !== 'firm' && USER_HINT[sf]) sec.appendChild(el('p', 'yc-hint yle-sec-hint', USER_HINT[sf]));
    var errs = el('ul', 'yle-errs');
    errs.setAttribute('role', 'alert');
    errs.hidden = true;
    sec.appendChild(errs);
    var rows = el('ol', 'yle-rows');
    rows.setAttribute('aria-label', sfName(sf) + ' layout');
    sec.appendChild(rows);

    var adds = el('div', 'yle-adds');
    adds.appendChild(btn('yle-add', 'pick', null, 'plus', icons ? 'Add a small button' : pg || ov ? 'Add a tile' : 'Add a shortcut'));
    if (BREAK_SF[gram(sf)] || (pg && pg.part === 'tiles')) adds.appendChild(btn('yle-add', 'add-break', null, 'grip-lines', 'Add a row break'));
    else if (sf === 'sidebar') adds.appendChild(btn('yle-add', 'label-open', null, 'heading', 'Add a section label'));
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

    sec.appendChild(buildPicker(sf, pg || ov ? 'Add to the page' : scope === 'firm' ? 'Add to ' + NAME[sf]
      : USER_PICK[sf]));

    if (!pg) {
      var hw = el('div', 'yle-hidden-wrap');
      hw.appendChild(el('h4', null, 'Hidden on this surface'));
      hw.appendChild(el('ul', 'yle-hidden'));
      hw.appendChild(el('div', 'yc-hint yle-hidden-none', 'Nothing hidden.'));
      sec.appendChild(hw);
    }
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
  var MB_TYPES = { view: 'A saved view', tool: 'A tool', url: 'A link to a website', drawer: 'A list (a menu of other items)', page: 'A page (a tab of tiles, like More Features)' };
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
      'Your own buttons: a saved view, a tool, a link to another website, a list (a small menu of other items) or a page ' +
      '(a tab of tiles, like More Features). Only you see them. They are listed in All and Ctrl+K under Mine; put them on ' +
      'your Home or sidebar, or give them a keyboard shortcut. A link always opens in a new window, never inside YisraCase.'));
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
    // a page (S6c-5): nothing more in the form — its tiles are arranged from its row
    var pw = el('div', 'ymb-field ymb-page-field');
    pw.setAttribute('data-field', 'page');
    pw.appendChild(el('div', 'yc-hint', 'A tab of your own, like More Features, with its own tiles and small buttons. ' +
      'Add it, then press Arrange\u2026 on its row to choose what is on it. Reloading the page while you are on it brings you back to Home.'));
    form.appendChild(pw);
    // a list's (drawer's) contents (S5b): an ordered list, the picker to add to it
    var rw = el('div', 'ymb-field ymb-refs-field');
    rw.setAttribute('data-field', 'refs');
    rw.appendChild(el('div', 'yc-flabel', 'In the list'));
    var rl = el('ol', 'ymb-refs');
    rl.setAttribute('aria-label', 'In the list');
    rw.appendChild(rl);
    rw.appendChild(el('div', 'yc-hint ymb-refs-none', 'Nothing in it yet.'));
    var ra = el('div', 'yle-adds');
    var rp = btn('yle-add', 'mb-ref-pick', null, 'plus', 'Add to the list');
    rp.id = 'ymb_refs';
    ra.appendChild(rp);
    ra.appendChild(el('span', 'yc-hint yle-room ymb-refs-room'));
    rw.appendChild(ra);
    rw.appendChild(el('div', 'yc-hint', 'Up to ' + DRAWER_CAP + ' items: features, your firm\u2019s items or your other buttons (not another list). It opens as a small menu beside its tile.'));
    var rfe = el('div', 'yle-field-err');
    rfe.setAttribute('data-err', 'refs');
    rw.appendChild(rfe);
    rw.appendChild(buildPicker('drawer', 'Add to this list'));
    form.appendChild(rw);
    form.appendChild(el('div', 'yc-hint ymb-id-line'));
    var frow = el('div', 'ysc-add-row');
    frow.appendChild(btn('yle-add-go yle-primary ymb-commit', 'mb-commit', null, 'check', 'Add button'));
    frow.appendChild(btn('yle-add-cancel', 'mb-cancel', null, null, 'Cancel'));
    form.appendChild(frow);
    sec.appendChild(form);
    // a page's tiles and small buttons (S6c-5): opened by Arrange… on its row,
    // one page at a time; its two sections are built per page (openArrange)
    var ar = el('div', 'ymb-arrange');
    ar.hidden = true;
    var ah = el('div', 'yle-sec-head');
    ah.appendChild(el('h4', 'ymb-arrange-title'));
    ah.appendChild(btn('yle-add-cancel', 'mb-arrange-done', null, null, 'Done'));
    ar.appendChild(ah);
    ar.appendChild(el('p', 'yc-hint ymb-arrange-hint', 'What this page shows. Nothing changes until you Save.'));
    ar.appendChild(el('div', 'ymb-arrange-secs'));
    sec.appendChild(ar);
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
        if (r.always) main.appendChild(el('span', 'yle-tag', 'Always here'));
        else if (r.locked) {
          var tag = el('span', 'yle-tag');
          tag.appendChild(iconEl('lock'));
          tag.appendChild(document.createTextNode(' Locked'));
          main.appendChild(tag);
        } else if (r.lockedForUsers) {
          var userTag = el('span', 'yle-tag');
          userTag.appendChild(iconEl('lock'));
          userTag.appendChild(document.createTextNode(' Locked for users'));
          main.appendChild(userTag);
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
        var lk = btn('yle-hide yle-locked', 'hide', r.always ? name + ' always stays here: it can move, not leave'
          : 'Locked by your firm — it stays on this surface', 'lock');
        lk.disabled = true;
        acts.appendChild(lk);
      } else acts.appendChild(btn('yle-remove', 'remove', 'Remove ' + name, 'xmark'));
      li.appendChild(acts);
      ol.appendChild(li);
    });
  }

  function renderHidden(sf) {
    var sec = secOf(sf), ul = sec.querySelector('.yle-hidden');
    if (!ul) return;   // a page's section (S6c-5): nothing is ever hidden on a page
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
    // the list (drawer) picker (S5b, in the My buttons form): the editor's registry
    // minus lists, what the list already holds and the button being edited
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
    sec.querySelector('.yle-room').textContent = room <= 0 ? (pageOf(sf) ? 'This page is full (' : 'This surface is full (') + capOf(sf) + ' entries).' : '';
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
    var base = L.effectiveRegistry().filter(function (e) { return !USER_ID_RE.test(e.id); });
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
    if (sess) sess.retarget(eff, g, its ? its.pageIds() : []);
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
      var on = b.kept ? [] : sess.where(b.id), combos = scs.combosOf(b.id), onPages = b.kept ? [] : sess.pagesHolding(b.id);
      if (on.length || combos.length || b.inDrawers.length || onPages.length) {
        var wh = el('span', 'ymb-where');
        on.map(onName).filter(function (n, k, a) { return a.indexOf(n) === k; }).forEach(function (n) { wh.appendChild(el('span', 'yle-tag', 'On ' + n)); });
        onPages.forEach(function (pid) { wh.appendChild(el('span', 'yle-tag', 'On \u201c' + pageLabel(pid) + '\u201d')); });
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
      if (!b.kept && b.type === 'page') {   // a page's tiles (S6c-5)
        var arr = btn('ymb-arrange-btn', 'mb-arrange', 'Arrange the tiles of ' + b.label, 'table-cells-large', 'Arrange\u2026');
        arr.disabled = !!(mbArrange && mbArrange.id === b.id);
        acts.appendChild(arr);
      }
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
    renderArrange();
  }
  // ── A page's tiles (S6c-5) ── the arrange box under the buttons list: the
  // page's two sections (pageSf(id, 'tiles') / 'icons'), driven by the same
  // handlers as Home's. One page at a time; a deleted page closes it.
  var mbArrange = null;      // { id } while a page is being arranged
  function pageLabel(id) {
    var eff = editorEffective();
    for (var i = 0; i < eff.length; i++) if (eff[i].id === id) return String(eff[i].label);
    return id;
  }
  function arrangeEl() { return mbSec().querySelector('.ymb-arrange'); }
  function openArrange(id) {
    var box = arrangeEl(), secs = box.querySelector('.ymb-arrange-secs');
    mbArrange = { id: id };
    secs.textContent = '';
    ['tiles', 'icons'].forEach(function (part) { secs.appendChild(buildSection(pageSf(id, part))); });
    box.hidden = false;
    renderArrange();
    renderButtons();
    box.scrollIntoView && box.scrollIntoView({ block: 'nearest' });
    var first = secs.querySelector('.yle-rows button:not(:disabled)') || secs.querySelector('[data-act="pick"]');
    if (first) first.focus();
  }
  function closeArrange(focus) {
    var was = mbArrange, box = arrangeEl();
    mbArrange = null;
    if (box) { box.hidden = true; box.querySelector('.ymb-arrange-secs').textContent = ''; }
    renderButtons();
    if (focus && was) {
      var b = mbSec().querySelector('.ymb-row[data-id="' + was.id + '"] [data-act="mb-arrange"]');
      (b || mbSec().querySelector('[data-act="mb-open"]')).focus();
    }
  }
  function renderArrange() {
    var box = arrangeEl();
    if (!box) return;
    if (mbArrange && (!its || its.pageIds().indexOf(mbArrange.id) < 0)) { closeArrange(false); return; }   // the page is gone
    if (!mbArrange) { box.hidden = true; return; }
    box.querySelector('.ymb-arrange-title').textContent = 'Arrange \u201c' + pageLabel(mbArrange.id) + '\u201d';
    ['tiles', 'icons'].forEach(function (part) { if (secOf(pageSf(mbArrange.id, part))) renderSection(pageSf(mbArrange.id, part)); });
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
    f.querySelector('[data-field="page"]').hidden = type !== 'page';
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
        tag.title = 'Not available to you right now: the list leaves it out. It is kept until you remove it.';
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
      acts.appendChild(btn('yle-remove', 'mb-ref-del', 'Take ' + v.label + ' out of the list', 'xmark'));
      li.appendChild(acts);
      ol.appendChild(li);
    });
    f.querySelector('.ymb-refs-none').hidden = refs.length > 0;
    var full = refs.length >= DRAWER_CAP;
    f.querySelector('.ymb-refs-room').textContent = full ? 'The list is full (' + DRAWER_CAP + ' items).' : '';
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
    SURFACES.concat(overSurfaces()).forEach(renderSection);
    renderShortcuts();
    renderButtons();   // renders the open arrange box too
    renderStatus();
  }
  // My buttons saves as it goes (launcher-nits L2): an add, an edit, a move
  // or a delete PUTs the items document at once, without Save and without
  // closing the panel. extra: the other documents to send with it — a
  // delete's own cascade (its placements, bindings) where that document had
  // no unsaved edit before it; one that had waits for Save, so nothing the
  // user did not ask to save is saved. A refusal keeps the edit, says so,
  // and Save tries again. focusId: the button to put focus back on.
  function saveButtons(extra, toastText, focusId, sel) {
    var parts = its.isDirty() ? [{ key: 'items', doc: its.doc() }] : [];
    (extra || []).forEach(function (k) { parts.push({ key: k, doc: k === 'layout' ? sess.doc() : scs.doc() }); });
    if (!parts.length) return Promise.resolve(true);
    clearErrors();
    return persist(parts, {
      toast: toastText,
      focus: function () {
        var i = focusId == null ? -1 : its.ids().indexOf(focusId);
        return (i >= 0 && (mbSec().querySelector('.ymb-row[data-i="' + i + '"] ' + (sel || '[data-act="mb-edit"]'))
          || mbSec().querySelector('.ymb-row[data-i="' + i + '"] [data-act="mb-edit"]')))
          || mbSec().querySelector('[data-act="mb-open"]');
      },
    });
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
    var editing = mbForm.i >= 0;
    mbForm = null;
    formEl().hidden = true;
    formEl().querySelector('[data-field="refs"] .yle-picker').hidden = true;
    buttonsChanged();
    var b = mbSec().querySelector('.ymb-row[data-i="' + r.i + '"] [data-act="mb-edit"]');
    if (b) b.focus();
    var saved = its.list()[r.i];
    saveButtons([], (editing ? 'Saved \u201c' : 'Added \u201c') + saved.label + '\u201d', saved.id);
  }
  function deleteButton(i) {
    var b = its.list()[i];
    if (!b) return;
    var on = b.kept ? [] : sess.where(b.id), combos = scs.combosOf(b.id), drawers = b.inDrawers;
    var onPages = b.kept ? [] : sess.pagesHolding(b.id);
    var go = function () {
      if (!its || its.list()[i] == null || its.list()[i].id !== b.id) return;
      var clean = { layout: !sess.isDirty(), shortcuts: !scs.isDirty() };
      var id = its.remove(i);
      if (id == null) return;
      sess.dropId(id);                 // its placements, its own page entry, and off every other page (S6c-5)
      scs.dropId(id);
      its.dropRef(id);                 // out of every list too (S5b)
      if (mbArrange && mbArrange.id === id) closeArrange(false);
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
      var next = its.list()[Math.min(i, its.list().length - 1)];
      saveButtons(['layout', 'shortcuts'].filter(function (k) { return clean[k] && (k === 'layout' ? sess : scs).isDirty(); }),
        'Deleted \u201c' + b.label + '\u201d', next ? next.id : null, '[data-act="mb-del"]');
    };
    var isPg = b.type === 'page';
    if (!on.length && !combos.length && !drawers.length && !onPages.length && !isPg) { go(); return; }
    var where = [];
    if (on.length) where.push('it’s on your ' + on.map(onName).filter(function (n, k, a) { return a.indexOf(n) === k; }).join(' and '));
    if (onPages.length) where.push((on.length ? '' : 'it’s ') + 'on your page' + (onPages.length > 1 ? 's ' : ' ') + onPages.map(function (p) { return '“' + pageLabel(p) + '”'; }).join(', '));
    if (drawers.length) where.push((on.length || onPages.length ? '' : 'it’s ') + 'in your list' + (drawers.length > 1 ? 's ' : ' ') + drawers.map(function (n) { return '“' + n + '”'; }).join(', '));
    if (combos.length) where.push((on.length || drawers.length || onPages.length ? '' : 'it’s ') + 'bound to ' + combos.join(', '));
    var note = where.length ? ' Note: ' + where.join(' and ') + '. Deleting it takes it off there too.' : '';
    ask('Delete “' + b.label + '”?' + note + (isPg ? ' The page’s own tiles go with it.' : ''), 'Delete', 'Keep it')
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
    if (panes().indexOf(name) < 0) name = panes()[0];
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
    return t ? t.getAttribute('data-pane') : panes()[0];
  }

  function renderStatus() {
    var dirty = anyDirty();
    root.querySelector('.yle-status').textContent = dirty ? 'Unsaved changes' : 'No changes';
    // a held bad label, or an open button form, keeps Save clickable: the
    // click says what to finish
    root.querySelector('.yle-save').disabled = (!dirty && !Object.keys(labelErr).length && !mbForm) || saving;
    var parts = sess ? sess.dirtyParts() : { surfaces: false, pages: false };
    // a page's tiles are arranged under My buttons (S6c-5): their dot sits there
    var dots = { shortcuts: !!(scs && scs.isDirty()), buttons: !!(its && its.isDirty()) || parts.pages };
    SURFACES.concat(overSurfaces()).forEach(function (sf) { if (sess && sess.mode(sf) !== 'stored') dots[paneOf(sf)] = true; });
    if (scope === 'firm') {
      // a firm tab's dot: one of its surfaces differs from what is stored
      dots = {};
      FIRM_PANES.forEach(function (fp) {
        dots[fp.id] = fp.id === 'pages' ? parts.pages : !!sess && fp.surfaces.some(function (sf) { return sess.mode(sf) !== 'stored'; });
      });
    }
    root.querySelectorAll('.yle-tab').forEach(function (t) {
      t.querySelector('.yle-tab-dot').hidden = !dots[t.getAttribute('data-pane')];
    });
  }
  function render() {
    builtSurfaces().forEach(renderSection);
    if (scope !== 'firm') {
      renderShortcuts();
      renderButtons();
    }
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
    var cf = root.querySelector('.yle-conflict');
    if (cf) cf.hidden = true;
    builtSurfaces().concat(scope === 'firm' ? [] : ['shortcuts', 'buttons']).forEach(function (sf) {
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
      // (\b: placed.home never matches placed.homeIcons — I is a word character)
      var hit = key === 'layout' ? /^(?:placed|removed)\.(home|sidebar|homeIcons|more|moreIcons|admin|adminIcons)\b/.exec(String(m))
        : [null, PANE_OF[key]];
      // a page's list (S6c-5): under that page's section when it is built (an open arrange box / the Firm pages pane)
      var pm = key === 'layout' && !hit ? /^pages\.([^.\s]+)\.(tiles|icons)\b/.exec(String(m)) : null;
      if (pm) hit = [null, pageSf(pm[1], pm[2])];
      // an overlay on a firm page (L4b1): under that page's part
      var om = key === 'layout' && !hit ? /^overlays\.(firm:[a-z0-9-]+)\.(?:placed|removed)\.(tiles|icons)\b/.exec(String(m)) : null;
      if (om) hit = [null, overSf(om[1], om[2])];
      if (hit && !secOf(hit[1])) hit = null;   // a surface this panel doesn't show: the banner
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
    // a page's part under My buttons (S6c-5): the rows' "On “page”" tags follow, so the whole tab redraws (its arrange box included)
    if (pageOf(sf) && scope !== 'firm') renderButtons(); else renderSection(sf);
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
      case 'save': if (scope === 'firm') saveFirm(); else save(); return;
      case 'reload': reloadFirm(); return;
      case 'tab': showPane(b.getAttribute('data-pane')); return;
      case 'mb-open': openForm(-1); return;
      case 'mb-cancel': closeForm(true); return;
      case 'mb-icon-pick': pickIcon(b); return;
      case 'mb-commit': commitForm(); return;
      case 'mb-arrange': openArrange(b.closest('.ymb-row').getAttribute('data-id')); return;
      case 'mb-arrange-done': closeArrange(true); return;
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
          saveButtons([], 'Order saved', its.ids()[mj], '.yle-' + (act === 'mb-up' ? 'up' : 'down') + ':not(:disabled)');
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
        ask(scope === 'firm'
          ? 'Reset ' + NAME[sf] + ' to the app\u2019s standard layout? The firm\u2019s arrangement of it is replaced when you Save.'
          : overOf(sf) ? 'Put \u201c' + (overLabels[overOf(sf).id] || overOf(sf).id) + '\u201d back the way your firm arranged it? Your arrangement of it is replaced when you Save.'
          : USER_RESET_ASK[sf],
        'Reset', scope === 'firm' ? 'Keep it' : 'Keep mine').then(function (yes) {
          if (!yes || !sess) return;
          sess.reset(sf);
          edited(sf);
          var r = secOf(sf).querySelector('.yle-reset');
          if (r) r.focus();
        });
        return;
      case 'add-break':
        if (sess.addBreak(sf)) { edited(sf); focusRow(sf, sess.view(sf).length - 1, '.yle-remove'); }
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
    if (opts && opts.scope === 'firm') return openFirm(opts);
    if (isOpen() && scope !== 'user') return Promise.resolve(false);   // the firm mode is open: one at a time
    if (loading) return loading;
    if (!KEYS) KEYS = (window.ycAll && window.ycAll.keys) || null;
    if (!KEYS) { console.error('[ycLayoutEditor] ycAll.keys missing — load order'); return Promise.resolve(false); }
    build('user');
    var section = opts && opts.section;
    if (isOpen()) { if (section) showPane(section); return Promise.resolve(true); }
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
    if (scope === 'firm') return;                       // not All's button: the Firm tab's own
    var b = document.getElementById('ycAllCustomize');
    if (!b) return;
    b.disabled = !!on;
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  }
  function notice(msg) {
    if (scope === 'firm') { if (msg) toast('error', msg); return; }
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
    pickers = null;
    pickersState = 'idle';
    mbForm = null;
    sess = null;
    scs = null;
    mbArrange = null;
    storedRefs = userIdsIn([storedOf(ui), shortcutsOf(ui)]);
    its = newItemSession(itemsOf(ui));
    // the firm's pages this user sees (L4b1): two overlay surfaces each, the
    // firm's lists as their base
    var fps = firmPagesNow(), flay = firmLayoutOf(ui), fpages = isObj(flay) && isObj(flay.pages) ? flay.pages : {};
    var obase = {}, osf = [], dl = window.DEFAULT_LAYOUTS || {};
    for (var dk in dl) if (hasOwn(dl, dk)) obase[dk] = dl[dk];
    overLabels = {};
    fps.forEach(function (p) {
      overLabels[p.id] = p.label;
      var pd = hasOwn(fpages, p.id) && isObj(fpages[p.id]) ? fpages[p.id] : {};
      ['tiles', 'icons'].forEach(function (part) { var sf = overSf(p.id, part); osf.push(sf); obase[sf] = isArr(pd[part]) ? pd[part] : []; });
    });
    buildUserFirmPages(fps);
    sessOpts = {
      stored: storedOf(ui), effective: editorEffective(), locked: lockedOf(ui), firm: flay,
      base: obase, registry: window.FEATURE_REGISTRY || {}, groups: editorGroups(),
      pages: its.pageIds(), surfaces: SURFACES.concat(osf),
    };
    sess = session(sessOpts);
    scs = newShortcutSession(shortcutsOf(ui));
    scAdd = null;
    root.querySelector('.ymb-form').hidden = true;
    root.querySelector('.ysc-add').hidden = true;
    var ab = arrangeEl();
    if (ab) { ab.hidden = true; ab.querySelector('.ymb-arrange-secs').textContent = ''; }
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
    firmFrom = null;
    sess = null;
    scs = null;
    its = null;
    mbForm = null;
    mbArrange = null;
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
    return ask(scope === 'firm' ? 'Discard your unsaved changes to the firm\u2019s arrangement?' : 'Discard your unsaved launcher changes?',
      'Discard', 'Keep editing').then(function (yes) {
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
  var PART_NAME = { items: 'buttons', layout: 'launcher layout', shortcuts: 'keyboard shortcuts' };
  var PANE_OF = { items: 'buttons', layout: 'home', shortcuts: 'shortcuts' };   // layout: Home, or the tab its first error is under (save)
  function save() {
    if (!isOpen() || saving) return Promise.resolve(false);
    clearErrors();
    if (Object.keys(labelErr).length) {
      showPane('sidebar');
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
    var parts = [];
    if (its.isDirty()) parts.push({ key: 'items', doc: its.doc() });
    if (sess.isDirty()) parts.push({ key: 'layout', doc: sess.doc() });
    if (scs.isDirty()) parts.push({ key: 'shortcuts', doc: scs.doc() });
    return persist(parts, null);
  }
  /** PUT parts in order (see save()). opts null: Save — all saved closes the
   *  panel. opts { stay, toast, focus }: My buttons' own save (launcher-nits
   *  L2) — all saved keeps the panel open, makes what saved the stored state,
   *  toasts opts.toast and focuses opts.focus() (an element or null). */
  function persist(parts, opts) {
    if (typeof window.apiSend !== 'function') { banner('Saving is not available on this page.', true); return Promise.resolve(false); }
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
    return chain.then(function () {
      saving = false;
      var saved = {}, failed = [], said = [];
      parts.forEach(function (p) { if (res[p.key].ok) saved[p.key] = res[p.key].config; else failed.push(p.key); });
      if (Object.keys(saved).length) applyToShell(saved);
      if (!failed.length && !opts) {
        closeNow();
        toast('success', 'Saved \u2014 your launcher is updated');
        return true;
      }
      freeze(false);
      if (!isOpen()) return false;
      // what saved is the new stored state: the buttons first (the other
      // tabs' item list follows them), then the layout and shortcuts
      if (hasOwn(saved, 'items')) its = newItemSession(saved.items);
      if (hasOwn(saved, 'layout')) { sessOpts.stored = saved.layout; sessOpts.effective = editorEffective(); sessOpts.groups = editorGroups(); sessOpts.pages = its.pageIds(); sess = session(sessOpts); }
      if (hasOwn(saved, 'shortcuts')) scs = newShortcutSession(saved.shortcuts);
      if (hasOwn(saved, 'layout')) storedRefs = userIdsIn([saved.layout, storedRefs ? Object.keys(storedRefs) : []]);
      if (hasOwn(saved, 'shortcuts')) storedRefs = userIdsIn([saved.shortcuts, storedRefs ? Object.keys(storedRefs) : []]);
      retargetAll();
      if (Object.keys(saved).length) render(); else renderStatus();
      if (!failed.length) {
        toast('success', opts.toast);
        var f = opts.focus && opts.focus();
        if (f) f.focus();
        return true;
      }
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
      said.push('Your changes are still here.');
      // a failed layout is on Home or Sidebar: the tab its first message landed
      // under, else the first one with unsaved changes
      var failedPanes = failed.map(function (k) { return PANE_OF[k]; });
      if (failed.indexOf('layout') >= 0) {
        var errAt = root.querySelector('.yle-sec:not([data-sf="shortcuts"]):not([data-sf="buttons"]) > .yle-errs:not([hidden])');
        var dirtySf = SURFACES.concat(overSurfaces()).filter(function (sf) { return sess.mode(sf) !== 'stored'; })[0];
        failedPanes[failed.indexOf('layout')] = errAt ? errAt.closest('.yle-pane').getAttribute('data-pane')
          : dirtySf ? paneOf(dirtySf) : PANE_OF.layout;
      }
      if (failedPanes.indexOf(paneShown()) < 0) showPane(failedPanes[0]);
      banner(said.join(' '), true);
      return false;
    });
  }

  // ── The firm mode (S6c-3) ──────────────────────────────────────────────
  // open({ scope: 'firm', section?, from? }): a fresh GET /api/ui-config (the
  // shell catches up to it, as the personal editor's open does); nothing
  // opens without can_edit_firm (the server refuses the save anyway) or when
  // the read fails — a toast says which. The personal editor's panel, if
  // built, is rebuilt for the firm (never while either is open).
  function openFirm(opts) {
    if (isOpen()) {
      if (scope === 'firm' && opts.section) { showPane(opts.section); if (opts.page) showFirmPage(opts.page); }
      return Promise.resolve(scope === 'firm');
    }
    if (loading) return loading;
    if (typeof window.apiSend !== 'function') { toast('error', LOAD_FIRM_FAIL); return Promise.resolve(false); }
    var from = opts.from && opts.from.nodeType === 1 ? opts.from : document.activeElement;
    loading = Promise.resolve()
      .then(function () { return window.apiSend('/api/ui-config', 'GET'); })
      .then(function (r) {
        if (!isObj(r)) throw new Error('no layers in the response');
        if (r.can_edit_firm !== true) { toast('error', FIRM_DENIED); return false; }
        var fresh = { firm: isObj(r.firm) ? r.firm : {}, user: isObj(r.user) ? r.user : {} };
        syncShell(fresh);
        var fv = isObj(r.firm_versions) ? r.firm_versions : null;
        build('firm');
        showFirm(fresh, fv && hasOwn(fv, 'layout') ? fv.layout : undefined, from, opts.section);
        if (opts.page) showFirmPage(opts.page);
        return true;
      })
      .catch(function (e) {
        if (typeof console !== 'undefined') console.warn('[ycLayoutEditor] firm layout read failed — not opened:', e && e.message);
        toast('error', LOAD_FIRM_FAIL);
        return false;
      })
      .then(function (ok) { loading = null; return ok; });
    return loading;
  }
  var LOAD_FIRM_FAIL = 'Couldn\u2019t load the firm\u2019s arrangement; try again.';
  function firmLayoutOf(ui) {
    return isObj(ui) && isObj(ui.firm) && isObj(ui.firm.layout) ? ui.firm.layout : null;
  }
  function showFirm(ui, base, from, section) {
    opening++;
    saving = false;
    labelErr = {};
    sess = null; scs = null; its = null; mbForm = null; scAdd = null;   // the personal editor's parts: none here
    firmBase = base;
    var cat = firmCatalog(ui);
    sessOpts = {
      stored: firmLayoutOf(ui), effective: cat.entries, locked: [], lockedForUsers: lockedOf(ui), base: window.DEFAULT_LAYOUTS || {},
      registry: window.FEATURE_REGISTRY || {}, groups: cat.groups, surfaces: FIRM_SURFACES, pass: [], seed: { more: cat.seed },
      pages: cat.pages,
    };
    sess = session(sessOpts);
    buildFirmPages(cat);
    clearErrors();
    root.querySelectorAll('.yle-picker, .yle-label-add').forEach(function (n) { n.hidden = true; });
    freeze(false);
    render();
    if (from && from !== document.body) firmFrom = from;
    opener = firmFrom;
    root.hidden = false;
    showPane(section);
    window.addEventListener('beforeunload', onBeforeUnload);
    var first = root.querySelector('.yle-pane:not([hidden]) .yle-rows button:not(:disabled)') || root.querySelector('.yle-cancel');
    if (first) first.focus();
  }
  // The Firm pages pane (S6c-5): one block per firm page (the catalogue's
  // pages, in order) — its icon and name, a note on where its identity is
  // set, then its two sections. Built per opening; the sections are driven
  // by the same handlers as every other.
  function buildFirmPages(cat) {
    var host = root.querySelector('.yle-firm-pages');
    if (!host) return;
    host.textContent = '';
    if (!cat.pages.length) { host.appendChild(el('div', 'yc-hint yle-no-pages', NO_FIRM_PAGES)); return; }
    cat.pages.forEach(function (id) {
      var e = null;
      for (var i = 0; i < cat.entries.length; i++) if (cat.entries[i].id === id) e = cat.entries[i];
      var blk = el('section', 'yle-page-block');
      blk.setAttribute('data-page', id);
      var h = el('h3', 'yle-page-title');
      h.appendChild(iconEl(e ? e.icon : ''));
      h.appendChild(document.createTextNode(' ' + (e ? String(e.label) : id)));
      blk.appendChild(h);
      ['tiles', 'icons'].forEach(function (part) { blk.appendChild(buildSection(pageSf(id, part))); });
      host.appendChild(blk);
    });
  }
  /** The personal editor's Firm pages tab (L4b1): one block per firm page this
   *  user sees, its Tiles and Small buttons over the overlay surfaces; the tab
   *  is hidden when the firm has no page for them. */
  function buildUserFirmPages(fps) {
    var host = root.querySelector('.yle-user-pages');
    if (!host) return;
    host.textContent = '';
    var tab = root.querySelector('.yle-tab[data-pane="pages"]');
    if (tab) tab.hidden = !fps.length;
    fps.forEach(function (p) {
      var blk = el('section', 'yle-page-block');
      blk.setAttribute('data-page', p.id);
      var h = el('h3', 'yle-page-title');
      h.appendChild(iconEl(p.icon));
      h.appendChild(document.createTextNode(' ' + p.label));
      blk.appendChild(h);
      ['tiles', 'icons'].forEach(function (part) { blk.appendChild(buildSection(overSf(p.id, part))); });
      host.appendChild(blk);
    });
  }
  /** Scroll the Firm pages pane to one page's block and focus its first control. */
  function showFirmPage(id) {
    var blk = root.querySelector('.yle-page-block[data-page="' + String(id).replace(/"/g, '') + '"]');
    if (!blk) return false;
    blk.scrollIntoView && blk.scrollIntoView({ block: 'start' });
    var first = blk.querySelector('.yle-rows button:not(:disabled)') || blk.querySelector('[data-act="pick"]');
    if (first) first.focus();
    return true;
  }
  // After a 409: the firm's arrangement as it is now, every edit here dropped
  // (the button says so). A failed read keeps the panel as it was.
  function reloadFirm() {
    if (saving || scope !== 'firm' || typeof window.apiSend !== 'function') return Promise.resolve(false);
    var keep = paneShown(), from = firmFrom;
    saving = true;
    freeze(true);
    renderStatus();
    return Promise.resolve()
      .then(function () { return window.apiSend('/api/ui-config', 'GET'); })
      .then(function (r) {
        if (!isObj(r) || r.can_edit_firm !== true) throw new Error(isObj(r) ? FIRM_DENIED : 'no layers in the response');
        var fresh = { firm: isObj(r.firm) ? r.firm : {}, user: isObj(r.user) ? r.user : {} };
        syncShell(fresh);
        var fv = isObj(r.firm_versions) ? r.firm_versions : null;
        showFirm(fresh, fv && hasOwn(fv, 'layout') ? fv.layout : undefined, from, keep);
        toast('success', 'Reloaded: this is the firm\u2019s arrangement as saved now');
        return true;
      }, function (e) {
        saving = false;
        freeze(false);
        renderStatus();
        banner('Couldn\u2019t reload: ' + ((e && e.message) || 'request failed') + '.', true);
        return false;
      });
  }
  // The shell's copy of the firm layer, then the launcher re-run: every
  // surface repaints in place, the More firm row included (S6c-2).
  function applyFirmToShell(config) {
    var fd = window.firmData;
    if (!fd) return false;
    var ui = isObj(fd.ui) ? fd.ui : { firm: {}, user: {} };
    var firm = {};
    if (isObj(ui.firm)) for (var k in ui.firm) if (hasOwn(ui.firm, k)) firm[k] = ui.firm[k];
    firm.layout = config;
    var next = {};
    for (var j in ui) if (hasOwn(ui, j)) next[j] = ui[j];
    next.firm = firm;
    fd.ui = next;
    L.applyAccess({ ui: fd.ui });
    return true;
  }
  // Save: ONE PUT of the firm's layout with its base. 200 → the shell takes
  // it and the panel closes; 409 → nothing saved, the edits stay, Reload is
  // offered; 400 → the server's errors under their surfaces; 403 → the
  // session message (firm.html's).
  function saveFirm() {
    if (!isOpen() || saving || scope !== 'firm') return Promise.resolve(false);
    clearErrors();
    if (Object.keys(labelErr).length) {
      showPane(paneOf('sidebar'));
      banner('Fix the highlighted section label first.');
      var bad = root.querySelector('.yle-label-in[aria-invalid="true"]');
      if (bad) bad.focus();
      return Promise.resolve(false);
    }
    if (!sess.isDirty()) { closeNow(); return Promise.resolve(true); }
    if (typeof window.apiSend !== 'function') { banner('Saving is not available on this page.', true); return Promise.resolve(false); }
    var body = { scope: 'firm', config_key: 'layout', config: sess.doc() };
    if (firmBase !== undefined) body.base = firmBase;        // stale → 409, never an overwrite
    saving = true;
    freeze(true);
    renderStatus();
    root.querySelector('.yle-status').textContent = 'Saving\u2026';
    return Promise.resolve()
      .then(function () { return window.apiSend('/api/ui-config', 'PUT', body); })
      .then(function (r) {
        saving = false;
        applyFirmToShell(r && isObj(r.config) ? r.config : body.config);
        closeNow();
        toast('success', r && r.changed === false ? 'Nothing changed' : 'Saved \u2014 everyone gets the new arrangement as they load YisraCase');
        return true;
      }, function (e) {
        saving = false;
        freeze(false);
        renderStatus();
        if (!isOpen()) return false;
        if (e && e.status === 409) {
          banner(CONFLICT_MSG, true);
          root.querySelector('.yle-conflict').hidden = false;
          return false;
        }
        if (e && e.status === 403) { banner(SESSION_MSG, true); return false; }
        if (e && e.status === 400 && e.body && isArr(e.body.errors) && e.body.errors.length) {
          var general = placeErrors('layout', e.body.errors);
          var first = root.querySelector('.yle-errs:not([hidden])');
          if (first) showPane(first.closest('.yle-pane').getAttribute('data-pane'));
          banner('The server refused the save.' + (general.length ? ' ' + general.join(' \u00b7 ') : ' See the messages under each section.') +
            ' Your changes are still here.', true);
          return false;
        }
        banner('Save failed: ' + ((e && e.message) || 'request failed') + '. Your changes are still here.', true);
        return false;
      });
  }

  var cust = document.getElementById('ycAllCustomize');
  if (cust) cust.addEventListener('click', function () { open(); });

  window.ycLayoutEditor = {
    open: open, close: requestClose, isOpen: isOpen, isDirty: isDirty,
    session: session, labelProblem: labelProblem, canonical: canonical,
    shortcutSession: shortcutSession, reservedProblem: reservedProblem,
    itemSession: itemSession, makeUserId: makeUserId, buttonProblems: buttonProblems,
    firmCatalog: firmCatalog, FIRM_SURFACES: FIRM_SURFACES, GUARANTEED: GUARANTEED, pageSf: pageSf, PAGE_PARTS: PAGE_PARTS,
    scope: function () { return scope; },
  };
})();
