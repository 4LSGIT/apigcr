// lib/uiConfigShape.js
//
/**
 * ui_config document validator — ui-customization arc S3.1
 * (local/ui-custom/PLAN.md §4.6, §6; the API is routes/api.uiConfig.js).
 *
 * PURE: no DB, no req/res. The tool-key grammar is borrowed from
 * routes/api.tools.js (TOOL_KEY_RE — requiring it loads that router module,
 * which has no side effects at require time) and the undeniable set from
 * services/entitlementService.js (UNDENIABLE), and the role vocabulary from
 * lib/capabilities.js (ROLE_MEMBERS) — one definition each.
 *
 *   validate(scope, configKey, config) → { ok, errors[], value }
 *     STRICT: an unknown top-level or per-entry key is an error, never
 *     silently dropped. value = the normalized document (null when !ok) —
 *     what gets stored and what the response carries.
 *   validateWrite(body) → { ok, errors[], value: { scope, config_key, config, base? } }
 *     the PUT body envelope: scope / config_key / config / role? / base? —
 *     role, when present, must be '' (reserved, PLAN §4.8); a body user_id is
 *     REJECTED (a user row is always the caller's own); any other key is
 *     rejected. base (ui-custom S3.2, optimistic concurrency): firm scope only;
 *     the newest firm version id the editor loaded, or null for "no firm row
 *     yet". OPTIONAL — absent means no check (the S3.1 contract stands);
 *     present, uiConfigService.write refuses a stale one with 409.
 *
 * Scopes: 'firm' and 'user' are writable; 'system' is reserved (the platform
 * tier is code) and refused, as is anything else.
 *
 * config_key whitelist (CONFIG_KEYS):
 *   firm  registry_overrides
 *         layout           the firm's default layout of every launcher surface
 *                          (S6c) — the base a user's own layout applies to;
 *                          versioned like registry_overrides (base / 409)
 *   user  shortcuts        the user's keyboard shortcuts (S4c: ycAll.js dispatches them)
 *         layout           the user's Home / sidebar / Home icon-row layout (S4a, S6c)
 *         prefs            the user's theme, which follows them across devices (S5d)
 *         items            the user's own buttons, "My buttons" (S5a)
 *
 * registry_overrides → normalized to these four keys, plus `retired` and
 * `visible_to` when they hold anything:
 *   hidden   [itemRef]           ≤ 100, de-duplicated, first-seen order.
 *                                 moreSettings / helpSupport / all (UNDENIABLE) refused:
 *                                 Settings, Help and the All surface stay reachable.
 *   locked   [itemRef]           ≤ 100, de-duplicated. A user's layout cannot
 *                                 remove a locked id (S4a, the shell's resolver).
 *   renames  { itemRef: { label } }  ≤ 100; label plain text, trimmed, 1–40.
 *                                 Not for 'custom' (its user owns its title) nor a
 *                                 firm item (edit its own label): both refused.
 *   items    [firm item]         ≤ 50, ids unique:
 *     { id: 'firm:<a-z0-9->{1,40}', label (1–40 plain), icon (ICON_RE:
 *       a Font Awesome name, ^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$ —
 *       a bare slug is solid, 'brands:github' / 'regular:star' name the
 *       family; public/js/ycIcon.js renders it), action } where action is
 *       exactly one of
 *       { type:'url',  href, present:'window' }
 *            href = https://… (absolute, no credentials) or a root-relative
 *            same-origin path ^/(?!/); never a backslash, whitespace or a
 *            control character (a browser reads "/\host" as "//host"). A
 *            root-relative href may not reach a SHELL-ONLY page — /tool/… or
 *            /customView[.html] — checked case-insensitively after the
 *            browser's own normalisation (dot segments, percent-decoding,
 *            repeated slashes): those pages need the parent shell, so they are
 *            tool / view items (modal), never a url item's bare window.
 *       { type:'tool', key (TOOL_KEY_RE), present:'modal', size? }  → /tool/<key>
 *       { type:'view', key (VIEW_KEY_RE), present:'modal', size? }  → /customView.html?key=<key>
 *            size = 'compact' | 'large' — the tool dialog's preset; optional
 *            (absent = 'large', and absent stays absent when normalized)
 *     present:'tab' is refused (a firm item is modal-only; a user's own tool /
 *     view may open as a tab, see items below); every other type —
 *     action (dropped 2026-10-15: firm actions are tool items), iframe, fn,
 *     tab, panel, … — is refused. No
 *     item may carry onclick / fn / script / html: unknown keys are errors.
 *   retired  [firm id]           ≤ RETIRED_MAX, de-duplicated; absent when empty
 *     (and absent stays absent). SERVER-MANAGED (S4a): the ids of firm items
 *     deleted from the document. An item whose id is in it is refused — user
 *     layouts and shortcut bindings refer to firm items by id, so a reused id
 *     would silently re-point them. uiConfigService.write strips whatever a
 *     client sends here and re-derives the list from the stored row (a
 *     restore may bring a retired item back: the very item, so its id leaves
 *     the list).
 *   visible_to  { itemRef: [role…] }  ≤ CAPS.visible_to; absent when empty (and
 *     absent stays absent, so documents saved before S3.4 normalize to
 *     themselves). ROLE SCOPING (ui-custom S3.4, Fred's rulings 2026-10-16): an
 *     item with an entry is HIDDEN, EXCEPT from users holding at least one
 *     listed role; su always sees it. An item with no entry is for everyone.
 *     The list is an ALLOW-list on purpose: a role nobody ticked (a new role
 *     included) is in no list, so it never sees a restricted item by default.
 *       - roles are ROLE_MEMBERS (lib/capabilities.js) minus su;
 *       - su is IMPLICIT and REFUSED in a list (one spelling per meaning:
 *         ['su'] would be a second way to write []);
 *       - [] is valid and means "only su" — different from an absent key;
 *       - duplicates are dropped and a list is stored in ROLE_MEMBERS order
 *         (it is a set: the canonical no-op check must not see tick order);
 *       - moreSettings / helpSupport / all (UNDENIABLE) are refused: Settings,
 *         Help and All must stay visible to everyone.
 *     Visibility only, never security: server routes keep their own gates.
 *     Per-user exceptions are entitlement_denies rows at scope user (A5), not
 *     this document; role / firm denies are not role scoping (a deny hits
 *     everyone holding the role, nobody bypasses it).
 *   itemRef = a registry-shaped id (^[A-Za-z][A-Za-z0-9]{0,63}$) or a firm id.
 *   Ids are NOT checked against the registry (it is client code; soft refs
 *   drop at render). A user item id (user:…) is NOT an itemRef here: the
 *   firm document never names one (a user's own buttons are theirs — firm
 *   hides, renames, locks and visible_to do not reach them).
 *
 * items (scope user, S5a) → { items: [user item] } plus `retired` when it holds anything:
 *   items    [user item]         ≤ 50, ids unique: the firm item grammar above
 *     (one function, cleanItems), with id 'user:<a-z0-9->{1,40}' — the same
 *     three action kinds, the same href rules (absolute https, or a
 *     root-relative path that is not a shell-only page), tool / view with
 *     the optional size. A user's tool / view may also have present:'tab'
 *     (ui-custom S5c-b: it opens in the shell's button tab, #tabUserItem),
 *     and then no size — size is the dialog's preset; a link with 'tab' is
 *     refused (a link always opens in a new window). Firm items stay
 *     modal-only.
 *     A user item may also be a DRAWER (ui-custom S5b; user items only — a
 *     firm item never is one):
 *       { type:'drawer', items: [userRef…] }   no present, no size
 *         items   ≤ CAPS.drawer (30), required (an empty drawer is valid),
 *                 no duplicates, each a userRef (below). One level deep: a
 *                 ref naming another DRAWER of the same document is refused
 *                 (a drawer never holds a drawer, itself included). Refs are
 *                 otherwise soft, as in a layout: an id missing from the
 *                 registry, the firm's items or this document is kept, and
 *                 the shell drops it when it draws the drawer.
 *   retired  [user id]           ≤ RETIRED_MAX, absent when empty —
 *     SERVER-MANAGED exactly as the firm document's (S4a): the ids of the
 *     user's deleted buttons, never reused by that user, because their own
 *     layout and shortcut bindings refer to them by id.
 *   userRef = an itemRef or a user item id: what a user's layout and
 *   shortcuts may name.
 *
 * layout (scope user AND, since S6c, scope firm) → normalized to
 * { placed: { <surface>?… }, removed: { <surface>?… } }. The SAME grammar and
 * merge rule at two tiers: the firm's document is applied to the shipped
 * DEFAULT_LAYOUTS, a user's to the result (shipped → firm → user; the shell's
 * ycLauncher.resolveLayout). Surfaces by scope (LAYOUT_SURFACES /
 * FIRM_LAYOUT_SURFACES):
 *   user  home, sidebar, homeIcons
 *   firm  home, sidebar, homeIcons, more, moreIcons, admin, adminIcons
 *         (More, Admin and their icon rows are firm-only: Fred's ruling)
 *   placed.home / .more / .admin  [entry] ≤ PLACED_MAX; entry = { item } | { break: true }
 *   placed.sidebar                [entry] ≤ PLACED_MAX; entry = { item } | { label: text }
 *                            (a section heading: plain text, trimmed, 1–40)
 *   placed.homeIcons / .moreIcons / .adminIcons  [entry] ≤ CAPS.icons (12):
 *                            { item } only — an icon row is one line of small buttons
 *     An entry is exactly ONE of those shapes (a break is for a grid, a label
 *     the sidebar only, an icon row takes items only); an item at most once
 *     per surface. item = an itemRef (a registry or firm id) in a FIRM
 *     document, a userRef (those plus the user's own user: ids) in a USER one.
 *     A surface left out stays absent — it follows the base layout. A placed
 *     list, even [], is that tier's ORDER, not the whole surface: it drops the
 *     base layout's own breaks and labels, but every base item that surface's
 *     removed list does not name still comes back, slotted next to its base
 *     neighbour (the merge rule in the shell's ycLauncher.resolveLayout). []
 *     does NOT clear a surface.
 *   removed.<surface>  [ref]  ≤ 100 each, de-duplicated: PER SURFACE (ui-custom
 *     S4a fix round, manager ruling SF1) — base placements this tier does not
 *     want on THAT surface; each surface reads only its own list, so hiding
 *     Billing from the sidebar leaves Home's tile, and resetting one surface
 *     (dropping placed.<sf> and removed.<sf>) leaves the other alone. An
 *     explicit placement on a surface still shows the item there; a
 *     firm-locked item ignores a USER's removal. A list left out stays absent.
 *     The flat array form (removed: [id…]) is refused, not coerced.
 *     GUARANTEED (S6c, Fred's ruling): `all` is always in Home's icon row —
 *     removed.homeIcons may not name it (refused, either scope), and the
 *     shell's resolver puts it back when a placed list leaves it out.
 *   pages  RESERVED (S6c-5: firm and user pages): a document carrying it is
 *     refused with "not available yet", never stored.
 *   Ids are soft refs, as everywhere here: one missing from the effective
 *   registry drops silently at render.
 *
 * shortcuts → { bindings: [ { combo: { ctrl, meta, alt, shift, key }, id } ] }
 *   ≤ 50; the four modifiers are required strict booleans; key = one printable
 *   character (letters stored lower-case) or a NAMED_KEYS name; id an itemRef.
 *   Two bindings with the same combo are refused. Two combo rules (S4c, while
 *   there were 0 rows; comboProblem below — public/js/ycAll.js holds the same
 *   function, and tests/launcherS4c.test.js runs both over one matrix):
 *     - at least one of ctrl / meta / alt: shift alone, or no modifier, would
 *       fire while the user types;
 *     - never the command palette's own combo: key k with exactly one of
 *       ctrl / meta and no alt (Ctrl-K, and Cmd-K on a Mac), shift either way.
 *   Browser- and OS-reserved combos (Cmd-T, Ctrl-W, …) are platform knowledge,
 *   refused by the editor (public/js/ycLayoutEditor.js), not here.
 *
 * prefs (scope user, S5d) → { theme?: { mode?, vars? } }: the theme follows
 *   the user. The account row is the truth; localStorage (yc-theme,
 *   yc-theme-vars) is its write-through cache, which the pre-paint script and
 *   public/themeSync.js read (public/index.html ycThemePrefs adopts the row at
 *   boot and writes every change through). A key left out stays out.
 *   mode   'light' | 'dark'
 *   vars   EXACTLY the yc-theme-vars blob public/themeCustom.html writes:
 *          { v: 1, preset, density, light: { token: value }, dark: { … } }
 *     v        required, 1.
 *     preset / density   that page's bookkeeping (which card is lit): a slug
 *              ^[a-z0-9-]{1,40}$ or null; absent → null.
 *     light / dark   ≤ THEME_VARS_MAX entries each (absent → {}), refused at
 *              the cap before an entry is looked at. A name must be
 *              --[a-zA-Z0-9-]{1,60} (themeSync.js's own check) and a value must
 *              pass themeValueProblem below. A well-formed name that is not a
 *              theme.css token (THEME_TOKENS) is DROPPED, not refused: token
 *              names are soft refs to theme.css, as item ids are to the
 *              registry — a token theme.css retires must not make every later
 *              save of an old store fail.
 *     Values reach style.setProperty in every frame, so they are untrusted:
 *     a value is ≤ THEME_VALUE_MAX characters, no leading / trailing space,
 *     and a sequence of: hex colours, rgb()/rgba()/hsl()/hsla() of numbers,
 *     var(--token), numbers and lengths, keywords / font names, quoted font
 *     names (letters, digits, space, _ and - only), separated by spaces,
 *     commas or slashes. No other function (url(, expression(, image-set(…),
 *     no ; { } < > \ ! @ * or quote inside a name: a value that is not those
 *     tokens is refused. public/index.html ycThemePrefs.valueOk is the client
 *     copy (themeCustom.html refuses what it refuses); tests/themePrefsS5d.test.js
 *     runs both over one matrix.
 *
 * Size: an array / object over its cap is refused at the cap check, before
 * its entries are looked at, and a result carries at most ERRORS_MAX messages
 * (plus a count of the rest) — an oversized body costs one length check, never
 * a pass over it (the JSON body limit is 10 MB).
 *
 * The client re-validates firm items before it acts on one (ycLauncher in
 * public/index.html); tests/uiConfigS31.test.js runs both over one fixture set.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { TOOL_KEY_RE } = require('../routes/api.tools');
const { UNDENIABLE } = require('../services/entitlementService');
const { ROLE_MEMBERS } = require('./capabilities');

const SCOPES = Object.freeze(['firm', 'user']);
const CONFIG_KEYS = Object.freeze({
  firm: Object.freeze(['registry_overrides', 'layout']),
  user: Object.freeze(['shortcuts', 'layout', 'prefs', 'items']),
});
// The layout surfaces each tier may arrange (S6c). A user's own layout covers
// Home, the sidebar and Home's icon row; the firm's default covers every
// launcher surface (More, Admin and their icon rows are firm-only).
const LAYOUT_SURFACES = Object.freeze(['home', 'sidebar', 'homeIcons']);
const FIRM_LAYOUT_SURFACES = Object.freeze(['home', 'sidebar', 'homeIcons', 'more', 'moreIcons', 'admin', 'adminIcons']);
const BREAK_SURFACES = Object.freeze(['home', 'more', 'admin']);          // grids: { break: true } allowed
const ICON_SURFACES = Object.freeze(['homeIcons', 'moreIcons', 'adminIcons']);   // { item } only, ≤ CAPS.icons
// Items a layout can never take off a surface (S6c, Fred's ruling: All is
// guaranteed in Home's icon row). The shell's resolver holds the same map.
const GUARANTEED = Object.freeze({ homeIcons: Object.freeze(['all']) });
const PAGES_NOT_YET = 'pages is not available yet (firm and user pages come later)';

const REGISTRY_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIRM_ID_RE = /^firm:[a-z0-9-]{1,40}$/;
const USER_ID_RE = /^user:[a-z0-9-]{1,40}$/;      // a user's own button (S5a)
// The stored icon value (ui-custom S6a) — public/js/ycIcon.js is the client
// helper and documents it: a bare slug means solid (every value stored before
// S6a), else solid: / regular: / brands: + the slug. routes/auth.customTab.js
// ICON_RE is the same grammar. Linear: anchored, one optional group, one class.
const ICON_RE = /^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$/;
// report_definitions.report_key — services/reportService.js REPORT_KEY_RE.
// Copied, not required: reportService opens the read-only pool at require
// time. tests/uiConfigS31.test.js pins this copy to that source.
const VIEW_KEY_RE = /^[a-z][a-z0-9_]{2,59}$/;
const LABEL_MAX = 40;
const HREF_MAX = 2000;
const CAPS = Object.freeze({ hidden: 100, locked: 100, renames: 100, items: 50, bindings: 50, retired: 1000, placed: 100, removed: 100,
  visible_to: 200, visible_roles: 20, drawer: 30, icons: 12 });
// visible_to's role vocabulary: every users.roles member but su, which is
// implicit (su sees everything) and refused in a list.
const VISIBLE_ROLES = Object.freeze(ROLE_MEMBERS.filter((r) => r !== 'su'));
const ERRORS_MAX = 20;          // messages returned; the rest are counted
const UNKNOWN_KEYS_MAX = 5;     // unknown fields reported per object

// tool / view items are modal-only: their pages boot from the PARENT shell's
// apiSend (customView.html: const P = window.parent + its waitForParent poll;
// toolManager.html: "opened directly … a tool has no parent shell, so every
// API call fails"), so a bare window would be a dead page. 'window' is for
// url items only (manager ruling, S3.1). A modal item may name the tool
// dialog's size preset (S3.3): OPTIONAL — absent means 'large', and an absent
// size stays absent in the normalized document (so documents saved before
// S3.3 normalize to themselves).
const ACTION_SHAPES = Object.freeze({
  url:  Object.freeze({ keys: ['type', 'href', 'present'], present: ['window'] }),
  tool: Object.freeze({ keys: ['type', 'key', 'present', 'size'], present: ['modal'] }),
  view: Object.freeze({ keys: ['type', 'key', 'present', 'size'], present: ['modal'] }),
});
// A user's own button may also be a drawer (S5b): a list of refs the shell
// opens as a small menu. User items only — the firm's shapes stay the three
// above (a firm drawer is out of scope).
// And a user's tool / view button may open as a TAB (S5c-b: the shell's
// #tabUserItem, at most 3 frames alive), with no size — the size is the
// dialog's preset. Firm items stay modal-only.
const USER_ACTION_SHAPES = Object.freeze({ ...ACTION_SHAPES,
  tool: Object.freeze({ keys: ['type', 'key', 'present', 'size'], present: ['modal', 'tab'] }),
  view: Object.freeze({ keys: ['type', 'key', 'present', 'size'], present: ['modal', 'tab'] }),
  drawer: Object.freeze({ keys: ['type', 'items'], present: [] }) });
// openToolDialog's presets (public/index.html ycToolDialogJs): no pixel sizes.
const SIZES = Object.freeze(['compact', 'large']);

const NAMED_KEYS = Object.freeze([
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// prefs.theme (S5d). The caps are themeSync.js's own: applyVars applies at
// most 200 names per mode and skips a value over 120 characters.
const THEME_VARS_MAX = 200;
const THEME_VALUE_MAX = 120;
const THEME_NAME_RE = /^--[a-zA-Z0-9-]{1,60}$/;
const THEME_SLUG_RE = /^[a-z0-9-]{1,40}$/;
const THEME_MODES = Object.freeze(['light', 'dark']);
// One value token, matched sticky from where the last one ended. A keyword
// may not be followed by "(" — the only functions are the colour ones and
// var(--token), so url( / expression( / attr( … match nothing. ycThemePrefs
// in public/index.html builds the same pattern from the same strings.
const THEME_NUM = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const THEME_ARG = '(?:' + THEME_NUM + '(?:%|deg)?|none)';
const THEME_VALUE_TOKEN = new RegExp([
  '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])',
  '(?:rgba?|hsla?)\\(\\s*' + THEME_ARG + '(?:(?:\\s*[,/]\\s*|\\s+)' + THEME_ARG + '){2,3}\\s*\\)',
  'var\\(\\s*--[a-zA-Z0-9-]{1,60}\\s*\\)',
  THEME_NUM + '(?:px|rem|em|%|vh|vw|dvh|ch|ex|pt|deg)?(?![0-9a-zA-Z.%(])',
  '"[A-Za-z0-9 _-]{1,40}"',
  "'[A-Za-z0-9 _-]{1,40}'",
  '-?[A-Za-z][A-Za-z0-9-]{0,40}(?![A-Za-z0-9_(-])',
  '\\s*[,/]\\s*',
  '\\s+',
].map((s) => '(?:' + s + ')').join('|'), 'y');

/** theme.css's tokens: the custom properties declared in its two token
 *  blocks, :root and the bare html[data-theme="dark"] — the set
 *  themeCustom.html edits (it walks the CSSOM for exactly those two
 *  selectors). Read once, from the file this same deploy serves, the way
 *  scripts/checkThemePresets.js cuts them out: each block from its
 *  line-anchored selector to the first line-leading "}", comments stripped. */
const THEME_TOKENS = (() => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme.css'), 'utf8');
  const names = new Set();
  for (const re of [/^:root\s*\{/m, /^html\[data-theme="dark"\]\s*\{/m]) {
    const m = re.exec(css);
    if (!m) throw new Error('uiConfigShape: theme.css token block not found: ' + re);
    const start = m.index + m[0].length;
    const text = css.slice(start, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const d of text.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)) names.add(d[1]);
  }
  return Object.freeze([...names].sort());
})();

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isItemRef(v) {
  return typeof v === 'string' && (REGISTRY_ID_RE.test(v) || FIRM_ID_RE.test(v));
}
/** What a USER document (layout, shortcuts) may name: an itemRef, or one of
 *  the user's own buttons (S5a). */
function isUserRef(v) {
  return isItemRef(v) || (typeof v === 'string' && USER_ID_RE.test(v));
}

function unknownKeys(obj, allowed, where, errors) {
  let n = 0;
  for (const k in obj) {
    if (!own(obj, k) || allowed.includes(k)) continue;
    if (++n > UNKNOWN_KEYS_MAX) { errors.push(`${where}: more unknown fields`); return; }
    errors.push(`${where}: unknown field "${k}"`);
  }
}

/** Plain-text label: string, trimmed, 1–40 chars, no control characters. */
function cleanLabel(v, where, errors) {
  if (typeof v !== 'string') { errors.push(`${where}: label must be a string`); return null; }
  const s = v.trim();
  // UTF-16 length first: more than 2 units per code point is impossible, so a
  // longer string is refused without spreading it (a 10 MB label costs O(1)).
  if (!s || s.length > LABEL_MAX * 2 || [...s].length > LABEL_MAX) { errors.push(`${where}: label must be 1-${LABEL_MAX} characters`); return null; }
  if (CONTROL_RE.test(s)) { errors.push(`${where}: label must be plain text (no control characters)`); return null; }
  return s;
}

/** A root-relative href that lands on a page needing the parent shell —
 *  /tool/<key> or /customView[.html] — once the browser has normalised it:
 *  dot segments resolved, percent-escapes decoded (up to 3 rounds), repeated
 *  slashes collapsed, case folded (Express routes case-insensitively). An
 *  href that will not parse counts as one. public/index.html's ycLauncher
 *  holds the same function (hrefOk). */
function shellOnlyPath(href) {
  const BASE = 'https://shell.invalid';
  let p;
  try { p = new URL(href, BASE).pathname; } catch (_) { return true; }
  for (let i = 0; i < 3; i++) {
    let d;
    try { d = decodeURIComponent(p); } catch (_) { return true; }
    d = d.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    try { d = new URL(d, BASE).pathname; } catch (_) { return true; }
    if (d === p) break;
    p = d;
  }
  p = p.toLowerCase();                       // the loop already collapsed repeated slashes
  return /^\/(tool(\/|$)|customview(\.html)?(\/|$))/.test(p);
}

/** url href: absolute https:// (no credentials) or a root-relative path. */
function hrefProblem(href) {
  if (typeof href !== 'string' || !href) return 'href is required';
  if (href.length > HREF_MAX) return `href is longer than ${HREF_MAX} characters`;
  if (/[\s\\]/.test(href) || CONTROL_RE.test(href)) return 'href must not contain whitespace, backslashes or control characters';
  if (href.charAt(0) === '/') {
    if (href.charAt(1) === '/') return 'href must not be protocol-relative (//host)';
    return shellOnlyPath(href) ? 'href must not open a shell-only page (/tool/…, /customView…): use a tool or view item' : null;
  }
  if (!/^https:\/\//i.test(href)) return 'href must be https://… or a root-relative /path';
  let u;
  try { u = new URL(href); } catch (_) { return 'href is not a valid URL'; }
  if (u.protocol !== 'https:' || !u.hostname) return 'href must be https://…';
  if (u.username || u.password) return 'href must not carry credentials';
  return null;
}

const TAB_NOT_YET = 'present "tab" is not available yet';
/** A drawer's refs (S5b) → the clean list, or null (errors pushed). drawers:
 *  the ids of this document's drawers — a ref to one is refused (depth 1). */
function drawerRefs(v, where, errors, drawers) {
  if (!Array.isArray(v)) { errors.push(`${where}: a drawer's items must be an array of item ids`); return null; }
  if (v.length > CAPS.drawer) { errors.push(`${where}: a drawer holds at most ${CAPS.drawer} items`); return null; }
  const n = errors.length, out = [];
  v.forEach((id, i) => {
    const at = `${where}.action.items[${i}]`;
    if (!isUserRef(id)) errors.push(`${at}: not an item id`);
    else if (out.includes(id)) errors.push(`${at}: ${id} is already in this drawer`);
    else if (drawers.has(id)) errors.push(`${at}: ${id} is a drawer — a drawer can't hold a drawer`);
    else out.push(id);
  });
  return errors.length === n ? out : null;
}
function cleanAction(a, where, errors, tabMsg = TAB_NOT_YET, shapes = ACTION_SHAPES, drawers = new Set()) {
  if (!isPlainObject(a)) { errors.push(`${where}: action must be an object`); return null; }
  const type = a.type;
  if (typeof type !== 'string' || !own(shapes, type)) {
    errors.push(`${where}: action.type must be one of ${Object.keys(shapes).join(', ')}` +
      (type === 'action' ? ' (there is no action kind: a firm action is a tool item)' : ''));
    return null;
  }
  const shape = shapes[type];
  const n = errors.length;
  if (type === 'drawer') {
    unknownKeys(a, shape.keys.concat('present', 'size'), `${where}.action`, errors);
    if (own(a, 'present') || own(a, 'size')) errors.push(`${where}: a drawer has no present or size (it opens its own list)`);
    const refs = drawerRefs(a.items, where, errors, drawers);
    return errors.length === n && refs ? { type, items: refs } : null;
  }
  unknownKeys(a, shape.keys, `${where}.action`, errors);
  if (a.present === 'tab' && !shape.present.includes('tab')) errors.push(`${where}: ${tabMsg}`);
  else if (!shape.present.includes(a.present)) {
    errors.push(`${where}: a ${type} item's present must be ${shape.present.map((p) => `"${p}"`).join(' or ')}`);
  }
  if (type === 'url') {
    const p = hrefProblem(a.href);
    if (p) errors.push(`${where}: ${p}`);
  } else {
    const re = type === 'tool' ? TOOL_KEY_RE : VIEW_KEY_RE;
    if (typeof a.key !== 'string' || !re.test(a.key)) errors.push(`${where}: ${type} key must match ${re}`);
    if (own(a, 'size') && !SIZES.includes(a.size)) {
      errors.push(`${where}: size must be ${SIZES.map((z) => `"${z}"`).join(' or ')}`);
    } else if (own(a, 'size') && a.present === 'tab' && shape.present.includes('tab')) {   // a firm item's tab already has its own refusal
      errors.push(`${where}: a tab has no size (size is the dialog's preset)`);
    }
  }
  if (errors.length !== n) return null;
  if (type === 'url') return { type, href: a.href, present: a.present };
  const out = { type, key: a.key, present: a.present };
  if (own(a, 'size')) out.size = a.size;
  return out;
}

// ids: 'item' (an itemRef), 'firm' (firm item ids only), 'user' (user item
// ids only) or 'userRef' (what a user document may name).
const REF_KINDS = Object.freeze({
  item:    { ok: isItemRef, what: 'an item id' },
  firm:    { ok: (id) => typeof id === 'string' && FIRM_ID_RE.test(id), what: 'a firm item id' },
  user:    { ok: (id) => typeof id === 'string' && USER_ID_RE.test(id), what: 'a user item id' },
  userRef: { ok: isUserRef, what: 'an item id' },
});
function cleanRefList(v, field, errors, { undeniable = false, ids = 'item', cap = CAPS[field] } = {}) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errors.push(`${field} must be an array`); return []; }
  if (v.length > cap) { errors.push(`${field}: at most ${cap} entries`); return []; }
  const out = [];
  const kind = REF_KINDS[ids];
  v.forEach((id, i) => {
    if (!kind.ok(id)) {
      errors.push(`${field}[${i}]: not ${kind.what}`);
      return;
    }
    if (undeniable && UNDENIABLE.includes(id)) { errors.push(`${field}[${i}]: ${id} cannot be hidden (always available)`); return; }
    if (!out.includes(id)) out.push(id);
  });
  return out;
}

/** visible_to → { itemRef: [role…] } (roles in ROLE_MEMBERS order), {} when absent. */
function visibleTo(v, errors) {
  const out = {};
  if (v === undefined) return out;
  if (!isPlainObject(v)) { errors.push('visible_to must be an object { itemId: [role…] }'); return out; }
  const keys = Object.keys(v);
  if (keys.length > CAPS.visible_to) { errors.push(`visible_to: at most ${CAPS.visible_to} entries`); return out; }
  for (const id of keys) {
    const where = `visible_to.${id}`;
    if (!isItemRef(id)) { errors.push(`${where}: not an item id`); continue; }
    if (UNDENIABLE.includes(id)) { errors.push(`${where}: ${id} is always visible to everyone`); continue; }
    const list = v[id];
    if (!Array.isArray(list)) { errors.push(`${where} must be an array of roles ([] = only su)`); continue; }
    if (list.length > CAPS.visible_roles) { errors.push(`${where}: at most ${CAPS.visible_roles} entries`); continue; }
    const n = errors.length, has = new Set();
    list.forEach((r, i) => {
      if (r === 'su') errors.push(`${where}[${i}]: su always sees every item — leave it out`);
      else if (typeof r !== 'string' || !VISIBLE_ROLES.includes(r)) errors.push(`${where}[${i}]: not a role (${VISIBLE_ROLES.join(', ')})`);
      else has.add(r);
    });
    if (errors.length === n) out[id] = VISIBLE_ROLES.filter((r) => has.has(r));
  }
  return out;
}

/** A launcher item list — the firm's items (registry_overrides) and a user's
 *  own buttons (user items, S5a) share it: { id, label, icon, action }, ≤
 *  CAPS.items, ids unique, matching idRe and never one in `retired`. tabMsg:
 *  what a present:'tab' refusal says. */
function cleanItems(v, errors, { idRe, retired, tabMsg, shapes, drawers }) {
  const items = [];
  if (v === undefined) return items;
  if (!Array.isArray(v)) { errors.push('items must be an array'); return items; }
  if (v.length > CAPS.items) errors.push(`items: at most ${CAPS.items} entries`);
  const seen = new Set();
  if (v.length <= CAPS.items) v.forEach((it, i) => {
    const where = `items[${i}]`;
    if (!isPlainObject(it)) { errors.push(`${where} must be an object`); return; }
    const n = errors.length;
    unknownKeys(it, ['id', 'label', 'icon', 'action'], where, errors);
    if (typeof it.id !== 'string' || !idRe.test(it.id)) errors.push(`${where}: id must match ${idRe}`);
    else if (seen.has(it.id)) errors.push(`${where}: duplicate id ${it.id}`);
    else if (retired.includes(it.id)) {
      errors.push(`${where}: ${it.id} belonged to a deleted item and is retired — a new item needs a new id`);
    } else seen.add(it.id);
    const label = cleanLabel(it.label, where, errors);
    if (typeof it.icon !== 'string' || !ICON_RE.test(it.icon)) errors.push(`${where}: icon must match ${ICON_RE}`);
    const action = cleanAction(it.action, where, errors, tabMsg, shapes, drawers);
    if (errors.length === n) items.push({ id: it.id, label, icon: it.icon, action });
  });
  return items;
}

/** A user's own buttons (S5a) → { items } (+ retired when it holds any).
 *  A button may be a drawer (S5b): USER_ACTION_SHAPES, and the ids of the
 *  document's drawers for the depth-1 rule (read off the raw list: a drawer
 *  with an error elsewhere is still a drawer). */
function userItems(c, errors) {
  unknownKeys(c, ['items', 'retired'], 'items', errors);
  const retired = cleanRefList(c.retired, 'retired', errors, { ids: 'user' });
  const drawers = new Set();
  if (Array.isArray(c.items) && c.items.length <= CAPS.items) {
    for (const it of c.items) {
      if (isPlainObject(it) && typeof it.id === 'string' && isPlainObject(it.action) && it.action.type === 'drawer') drawers.add(it.id);
    }
  }
  const items = cleanItems(c.items, errors, {
    idRe: USER_ID_RE, retired, shapes: USER_ACTION_SHAPES, drawers,
    tabMsg: 'present "tab" is for tools and saved views: a link always opens in a new window, never inside YisraCase',
  });
  const out = { items };
  if (retired.length) out.retired = retired;
  return out;
}

function registryOverrides(c, errors) {
  unknownKeys(c, ['hidden', 'locked', 'renames', 'items', 'retired', 'visible_to'], 'registry_overrides', errors);
  const hidden = cleanRefList(c.hidden, 'hidden', errors, { undeniable: true });
  const locked = cleanRefList(c.locked, 'locked', errors);
  const retired = cleanRefList(c.retired, 'retired', errors, { ids: 'firm' });

  const renames = {};
  if (c.renames !== undefined) {
    if (!isPlainObject(c.renames)) errors.push('renames must be an object');
    else {
      const keys = Object.keys(c.renames);
      if (keys.length > CAPS.renames) errors.push(`renames: at most ${CAPS.renames} entries`);
      else for (const id of keys) {
        const where = `renames.${id}`;
        if (!isItemRef(id)) { errors.push(`${where}: not an item id`); continue; }
        if (id === 'custom') { errors.push(`${where}: the custom tab is titled by its user, not renamed`); continue; }
        if (FIRM_ID_RE.test(id)) { errors.push(`${where}: a firm item is renamed by editing its own label`); continue; }
        const r = c.renames[id];
        if (!isPlainObject(r)) { errors.push(`${where} must be an object { label }`); continue; }
        unknownKeys(r, ['label'], where, errors);
        const label = cleanLabel(r.label, where, errors);
        if (label != null) renames[id] = { label };
      }
    }
  }

  const items = cleanItems(c.items, errors, { idRe: FIRM_ID_RE, retired });
  const visible = visibleTo(c.visible_to, errors);
  const out = { hidden, locked, renames, items };
  if (retired.length) out.retired = retired;
  if (Object.keys(visible).length) out.visible_to = visible;
  return out;
}

function comboKey(k) {
  if (typeof k !== 'string') return null;
  if (NAMED_KEYS.includes(k)) return k;
  const chars = [...k];
  if (chars.length !== 1 || /\s/.test(k) || CONTROL_RE.test(k)) return null;
  return k.toLowerCase();
}

/** A combo's problem under the S4c rules, or null. combo = normalized
 *  { ctrl, meta, alt, shift, key } (booleans checked, key lower-cased). */
function comboProblem(combo) {
  if (!combo.ctrl && !combo.meta && !combo.alt) {
    return 'needs ctrl, meta or alt (shift alone, or no modifier, would fire while typing)';
  }
  if (combo.key === 'k' && combo.ctrl !== combo.meta && !combo.alt) {
    return 'is the command palette\'s own (Ctrl-K / Cmd-K)';
  }
  return null;
}

function shortcuts(c, errors) {
  unknownKeys(c, ['bindings'], 'shortcuts', errors);
  const bindings = [];
  if (c.bindings === undefined) return { bindings };
  if (!Array.isArray(c.bindings)) { errors.push('bindings must be an array'); return { bindings }; }
  if (c.bindings.length > CAPS.bindings) { errors.push(`bindings: at most ${CAPS.bindings} entries`); return { bindings }; }
  const seen = new Map();
  c.bindings.forEach((b, i) => {
    const where = `bindings[${i}]`;
    if (!isPlainObject(b)) { errors.push(`${where} must be an object`); return; }
    const n = errors.length;
    unknownKeys(b, ['combo', 'id'], where, errors);
    if (!isUserRef(b.id)) errors.push(`${where}: id must be an item id`);
    const cb = b.combo;
    let combo = null;
    if (!isPlainObject(cb)) errors.push(`${where}: combo must be an object`);
    else {
      unknownKeys(cb, ['ctrl', 'meta', 'alt', 'shift', 'key'], `${where}.combo`, errors);
      for (const m of ['ctrl', 'meta', 'alt', 'shift']) {
        if (typeof cb[m] !== 'boolean') errors.push(`${where}.combo.${m} must be true or false`);
      }
      const key = comboKey(cb.key);
      if (key == null) errors.push(`${where}.combo.key must be one printable character or one of: ${NAMED_KEYS.join(', ')}`);
      combo = { ctrl: cb.ctrl, meta: cb.meta, alt: cb.alt, shift: cb.shift, key };
    }
    if (errors.length !== n) return;
    const p = comboProblem(combo);
    if (p) { errors.push(`${where}.combo ${p}`); return; }
    const sig = [combo.ctrl, combo.meta, combo.alt, combo.shift, combo.key].join('|');
    if (seen.has(sig)) { errors.push(`${where}: same combo as bindings[${seen.get(sig)}]`); return; }
    seen.set(sig, i);
    bindings.push({ combo, id: b.id });
  });
  return { bindings };
}

/** A placed list for surface sf of a scope's layout: ids = the ref kind the
 *  scope may name ('item' for the firm, 'userRef' for a user). */
function layoutEntries(v, sf, errors, ids) {
  const field = `placed.${sf}`;
  const icons = ICON_SURFACES.includes(sf);
  const cap = icons ? CAPS.icons : CAPS.placed;
  if (!Array.isArray(v)) { errors.push(`${field} must be an array`); return null; }
  if (v.length > cap) { errors.push(`${field}: at most ${cap} entries`); return null; }
  const out = [];
  const seen = new Map();
  const kind = REF_KINDS[ids];
  const shapes = icons ? '{ item }' : BREAK_SURFACES.includes(sf) ? '{ item } or { break: true }' : '{ item } or { label }';
  v.forEach((e, i) => {
    const where = `${field}[${i}]`;
    if (!isPlainObject(e)) { errors.push(`${where} must be an object`); return; }
    const keys = Object.keys(e);
    if (keys.length !== 1) { errors.push(`${where} must be exactly one of ${shapes}`); return; }
    const k = keys[0];
    if (k === 'item') {
      if (!kind.ok(e.item)) { errors.push(`${where}: not ${kind.what}`); return; }
      if (seen.has(e.item)) { errors.push(`${where}: ${e.item} is already placed at ${field}[${seen.get(e.item)}]`); return; }
      seen.set(e.item, i);
      out.push({ item: e.item });
    } else if (k === 'break' && BREAK_SURFACES.includes(sf)) {
      if (e.break !== true) { errors.push(`${where}: break must be true`); return; }
      out.push({ break: true });
    } else if (k === 'label' && sf === 'sidebar') {
      const label = cleanLabel(e.label, where, errors);
      if (label != null) out.push({ label });
    } else if (k === 'break' || k === 'label') {
      errors.push(`${where}: a ${k} is for ${k === 'break' ? 'a grid (home, more, admin)' : 'the sidebar'} only`);
    } else {
      errors.push(`${where}: unknown field "${k}" (an entry is ${shapes})`);
    }
  });
  return out;
}

/** The layout document of either scope (S6c): the firm's covers every
 *  surface and names registry / firm ids; a user's covers Home, the sidebar
 *  and Home's icon row and may name their own buttons too. */
function layout(c, errors, scope) {
  const firm = scope === 'firm';
  const surfaces = firm ? FIRM_LAYOUT_SURFACES : LAYOUT_SURFACES;
  const ids = firm ? 'item' : 'userRef';
  if (own(c, 'pages')) errors.push(PAGES_NOT_YET);
  unknownKeys(c, ['placed', 'removed', 'pages'], 'layout', errors);
  const placed = {};
  if (c.placed !== undefined) {
    if (!isPlainObject(c.placed)) errors.push('placed must be an object');
    else {
      unknownKeys(c.placed, surfaces, 'placed', errors);
      for (const sf of surfaces) {
        if (c.placed[sf] === undefined) continue;
        const list = layoutEntries(c.placed[sf], sf, errors, ids);
        if (list) placed[sf] = list;
      }
    }
  }
  const removed = {};
  if (c.removed !== undefined) {
    if (!isPlainObject(c.removed)) errors.push(`removed must be an object { ${surfaces.map((s) => s + '?').join(', ')} } — removals are per surface`);
    else {
      unknownKeys(c.removed, surfaces, 'removed', errors);
      for (const sf of surfaces) {
        if (c.removed[sf] === undefined) continue;
        removed[sf] = cleanRefList(c.removed[sf], `removed.${sf}`, errors, { ids, cap: CAPS.removed });
        for (const id of GUARANTEED[sf] || []) {
          if (removed[sf].includes(id)) errors.push(`removed.${sf}: ${id} is always in this row (it can't be removed)`);
        }
      }
    }
  }
  return { placed, removed };
}

/** A theme value's problem, or null — the grammar in the header. */
function themeValueProblem(v) {
  if (typeof v !== 'string' || !v) return 'must be a non-empty string';
  if (v.length > THEME_VALUE_MAX) return `is longer than ${THEME_VALUE_MAX} characters`;
  if (v !== v.trim()) return 'must not start or end with a space';
  const re = THEME_VALUE_TOKEN;
  re.lastIndex = 0;
  while (re.lastIndex < v.length) {
    const at = re.lastIndex;
    if (!re.exec(v) || re.lastIndex === at) return 'is not a colour, length, number or font name';
  }
  return null;
}

function themeModeVars(v, where, errors) {
  if (v === undefined) return {};
  if (!isPlainObject(v)) { errors.push(`${where} must be an object { token: value }`); return {}; }
  const names = Object.keys(v);
  if (names.length > THEME_VARS_MAX) { errors.push(`${where}: at most ${THEME_VARS_MAX} entries`); return {}; }
  const out = {};
  for (const n of names) {
    if (!THEME_NAME_RE.test(n)) { errors.push(`${where}: "${n.slice(0, 64)}" is not a token name`); continue; }
    const p = themeValueProblem(v[n]);
    if (p) { errors.push(`${where}.${n} ${p}`); continue; }
    if (THEME_TOKENS.includes(n)) out[n] = v[n];        // a non-token drops (soft ref)
  }
  return out;
}

function themeVars(v, errors) {
  if (!isPlainObject(v)) { errors.push('theme.vars must be an object { v, preset, density, light, dark }'); return null; }
  const n = errors.length;
  unknownKeys(v, ['v', 'preset', 'density', 'light', 'dark'], 'theme.vars', errors);
  if (v.v !== 1) errors.push('theme.vars.v must be 1');
  const slug = (k) => {
    const s = v[k];
    if (s === undefined || s === null) return null;
    if (typeof s !== 'string' || !THEME_SLUG_RE.test(s)) { errors.push(`theme.vars.${k} must be null or a name (${THEME_SLUG_RE})`); return null; }
    return s;
  };
  const out = { v: 1, preset: slug('preset'), density: slug('density') };
  for (const m of THEME_MODES) out[m] = themeModeVars(v[m], `theme.vars.${m}`, errors);
  return errors.length === n ? out : null;
}

function prefs(c, errors) {
  unknownKeys(c, ['theme'], 'prefs', errors);
  const out = {};
  if (c.theme === undefined) return out;
  const t = c.theme;
  if (!isPlainObject(t)) { errors.push('theme must be an object { mode?, vars? }'); return out; }
  unknownKeys(t, ['mode', 'vars'], 'theme', errors);
  const theme = {};
  if (t.mode !== undefined) {
    if (THEME_MODES.includes(t.mode)) theme.mode = t.mode;
    else errors.push('theme.mode must be "light" or "dark"');
  }
  if (t.vars !== undefined) {
    const vars = themeVars(t.vars, errors);
    if (vars) theme.vars = vars;
  }
  out.theme = theme;
  return out;
}

const DOCS = { registry_overrides: registryOverrides, shortcuts, layout, prefs, items: userItems };

function capErrors(errors) {
  return errors.length <= ERRORS_MAX ? errors
    : errors.slice(0, ERRORS_MAX).concat(`…and ${errors.length - ERRORS_MAX} more errors`);
}

function validate(scope, configKey, config) {
  const errors = [];
  if (scope === 'system') errors.push('scope "system" is reserved (the platform tier is code)');
  else if (!SCOPES.includes(scope)) errors.push(`scope must be one of: ${SCOPES.join(', ')}`);
  else if (!CONFIG_KEYS[scope].includes(configKey)) {
    errors.push(`config_key for scope ${scope} must be one of: ${CONFIG_KEYS[scope].join(', ')}`);
  }
  if (errors.length) return { ok: false, errors, value: null };
  if (!isPlainObject(config)) return { ok: false, errors: ['config must be an object'], value: null };
  const value = DOCS[configKey](config, errors, scope);
  return errors.length ? { ok: false, errors: capErrors(errors), value: null } : { ok: true, errors: [], value };
}

function validateWrite(body) {
  if (!isPlainObject(body)) return { ok: false, errors: ['body must be a JSON object'], value: null };
  const errors = [];
  if (own(body, 'user_id')) errors.push('user_id is not accepted: a user row is always your own');
  unknownKeys(body, ['scope', 'config_key', 'config', 'role', 'user_id', 'base'], 'body', errors);
  if (own(body, 'role') && body.role !== '') errors.push('role is reserved: only "" is accepted');
  if (own(body, 'base')) {
    if (body.scope !== 'firm') errors.push('base is for scope "firm" only (user rows are not versioned)');
    else if (body.base !== null && !(Number.isInteger(body.base) && body.base > 0 && body.base <= 4294967295)) {
      errors.push('base must be a version id or null');
    }
  }
  if (errors.length) return { ok: false, errors, value: null };
  const r = validate(body.scope, body.config_key, body.config);
  if (!r.ok) return r;
  const value = { scope: body.scope, config_key: body.config_key, config: r.value };
  if (own(body, 'base')) value.base = body.base;
  return { ok: true, errors: [], value };
}

/** JSON with object keys sorted at every level — for "is it unchanged?"
 *  (MySQL JSON re-orders keys on write; arrays keep their order). */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

module.exports = {
  validate, validateWrite, canonical,
  SCOPES, CONFIG_KEYS, CAPS, ERRORS_MAX, NAMED_KEYS, ACTION_SHAPES, USER_ACTION_SHAPES, SIZES, LAYOUT_SURFACES, FIRM_LAYOUT_SURFACES,
  ICON_SURFACES, BREAK_SURFACES, GUARANTEED, VISIBLE_ROLES, shellOnlyPath, comboProblem,
  themeValueProblem, THEME_TOKENS, THEME_VARS_MAX, THEME_VALUE_MAX,
  REGISTRY_ID_RE, FIRM_ID_RE, USER_ID_RE, ICON_RE, VIEW_KEY_RE, LABEL_MAX,
};
