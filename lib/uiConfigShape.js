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
 *   user  shortcuts        the user's keyboard shortcuts (S4c: ycAll.js dispatches them)
 *         layout           the user's Home / sidebar layout (S4a)
 *   (A firm-wide default `layout` is not here yet: later, it would be the
 *   base the user layer applies to.)
 *
 * registry_overrides → normalized to these four keys, plus `retired` and
 * `visible_to` when they hold anything:
 *   hidden   [itemRef]           ≤ 100, de-duplicated, first-seen order.
 *                                 moreSettings / helpSupport (UNDENIABLE) refused:
 *                                 the All surface and Settings stay reachable.
 *   locked   [itemRef]           ≤ 100, de-duplicated. A user's layout cannot
 *                                 remove a locked id (S4a, the shell's resolver).
 *   renames  { itemRef: { label } }  ≤ 100; label plain text, trimmed, 1–40.
 *                                 Not for 'custom' (its user owns its title) nor a
 *                                 firm item (edit its own label): both refused.
 *   items    [firm item]         ≤ 50, ids unique:
 *     { id: 'firm:<a-z0-9->{1,40}', label (1–40 plain), icon (FA slug
 *       ^[a-z0-9-]{1,40}$), action } where action is exactly one of
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
 *     present:'tab' is refused (N dynamic tabs are S5); every other type —
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
 *       - moreSettings / helpSupport (UNDENIABLE) are refused: Settings and
 *         Help must stay visible to everyone.
 *     Visibility only, never security: server routes keep their own gates.
 *     Per-user exceptions are entitlement_denies rows at scope user (A5), not
 *     this document; role / firm denies are not role scoping (a deny hits
 *     everyone holding the role, nobody bypasses it).
 *   itemRef = a registry-shaped id (^[A-Za-z][A-Za-z0-9]{0,63}$) or a firm id.
 *   Ids are NOT checked against the registry (it is client code; soft refs
 *   drop at render).
 *
 * layout (scope user) → normalized to { placed: { home?, sidebar? }, removed: { home?, sidebar? } }:
 *   placed.home     [entry]  ≤ PLACED_MAX; entry = { item: itemRef } | { break: true }
 *   placed.sidebar  [entry]  ≤ PLACED_MAX; entry = { item: itemRef } | { label: text }
 *                            (a section heading: plain text, trimmed, 1–40)
 *     An entry is exactly ONE of those shapes (a break is Home only, a label
 *     the sidebar only); an item at most once per surface. A surface left out
 *     stays absent — it follows the base layout. A placed list, even [], is
 *     the user's ORDER, not the whole surface: it drops the base layout's own
 *     breaks and labels, but every base item that surface's removed list does
 *     not name still comes back, slotted next to its base neighbour (the merge
 *     rule in the shell's ycLauncher.resolveLayout). [] does NOT clear a surface.
 *   removed.home     [itemRef]  ≤ 100 each, de-duplicated: PER SURFACE (ui-custom
 *   removed.sidebar  [itemRef]  S4a fix round, manager ruling SF1) — base
 *     placements the user does not want on THAT surface; each surface reads
 *     only its own list, so hiding Billing from the sidebar leaves Home's tile,
 *     and resetting one surface (dropping placed.<sf> and removed.<sf>) leaves
 *     the other alone. An explicit placement on a surface still shows the item
 *     there; a firm-locked item ignores removal. A list left out stays absent.
 *     The flat array form (removed: [id…]) is refused, not coerced.
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
 * Size: an array / object over its cap is refused at the cap check, before
 * its entries are looked at, and a result carries at most ERRORS_MAX messages
 * (plus a count of the rest) — an oversized body costs one length check, never
 * a pass over it (the JSON body limit is 10 MB).
 *
 * The client re-validates firm items before it acts on one (ycLauncher in
 * public/index.html); tests/uiConfigS31.test.js runs both over one fixture set.
 */

'use strict';

const { TOOL_KEY_RE } = require('../routes/api.tools');
const { UNDENIABLE } = require('../services/entitlementService');
const { ROLE_MEMBERS } = require('./capabilities');

const SCOPES = Object.freeze(['firm', 'user']);
const CONFIG_KEYS = Object.freeze({
  firm: Object.freeze(['registry_overrides']),
  user: Object.freeze(['shortcuts', 'layout']),
});
const LAYOUT_SURFACES = Object.freeze(['home', 'sidebar']);

const REGISTRY_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIRM_ID_RE = /^firm:[a-z0-9-]{1,40}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;              // routes/auth.customTab.js's icon charset
// report_definitions.report_key — services/reportService.js REPORT_KEY_RE.
// Copied, not required: reportService opens the read-only pool at require
// time. tests/uiConfigS31.test.js pins this copy to that source.
const VIEW_KEY_RE = /^[a-z][a-z0-9_]{2,59}$/;
const LABEL_MAX = 40;
const HREF_MAX = 2000;
const CAPS = Object.freeze({ hidden: 100, locked: 100, renames: 100, items: 50, bindings: 50, retired: 1000, placed: 100, removed: 100,
  visible_to: 200, visible_roles: 20 });
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
// openToolDialog's presets (public/index.html ycToolDialogJs): no pixel sizes.
const SIZES = Object.freeze(['compact', 'large']);

const NAMED_KEYS = Object.freeze([
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isItemRef(v) {
  return typeof v === 'string' && (REGISTRY_ID_RE.test(v) || FIRM_ID_RE.test(v));
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
  if (!s || [...s].length > LABEL_MAX) { errors.push(`${where}: label must be 1-${LABEL_MAX} characters`); return null; }
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

function cleanAction(a, where, errors) {
  if (!isPlainObject(a)) { errors.push(`${where}: action must be an object`); return null; }
  const type = a.type;
  if (typeof type !== 'string' || !own(ACTION_SHAPES, type)) {
    errors.push(`${where}: action.type must be one of ${Object.keys(ACTION_SHAPES).join(', ')}` +
      (type === 'action' ? ' (there is no action kind: a firm action is a tool item)' : ''));
    return null;
  }
  const shape = ACTION_SHAPES[type];
  const n = errors.length;
  unknownKeys(a, shape.keys, `${where}.action`, errors);
  if (a.present === 'tab') errors.push(`${where}: present "tab" is not available yet`);
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
    }
  }
  if (errors.length !== n) return null;
  if (type === 'url') return { type, href: a.href, present: a.present };
  const out = { type, key: a.key, present: a.present };
  if (own(a, 'size')) out.size = a.size;
  return out;
}

function cleanRefList(v, field, errors, { undeniable = false, firmOnly = false, cap = CAPS[field] } = {}) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errors.push(`${field} must be an array`); return []; }
  if (v.length > cap) { errors.push(`${field}: at most ${cap} entries`); return []; }
  const out = [];
  v.forEach((id, i) => {
    if (firmOnly ? !(typeof id === 'string' && FIRM_ID_RE.test(id)) : !isItemRef(id)) {
      errors.push(`${field}[${i}]: not ${firmOnly ? 'a firm item id' : 'an item id'}`);
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

function registryOverrides(c, errors) {
  unknownKeys(c, ['hidden', 'locked', 'renames', 'items', 'retired', 'visible_to'], 'registry_overrides', errors);
  const hidden = cleanRefList(c.hidden, 'hidden', errors, { undeniable: true });
  const locked = cleanRefList(c.locked, 'locked', errors);
  const retired = cleanRefList(c.retired, 'retired', errors, { firmOnly: true });

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

  const items = [];
  if (c.items !== undefined) {
    if (!Array.isArray(c.items)) errors.push('items must be an array');
    else {
      if (c.items.length > CAPS.items) errors.push(`items: at most ${CAPS.items} entries`);
      const seen = new Set();
      if (c.items.length <= CAPS.items) c.items.forEach((it, i) => {
        const where = `items[${i}]`;
        if (!isPlainObject(it)) { errors.push(`${where} must be an object`); return; }
        const n = errors.length;
        unknownKeys(it, ['id', 'label', 'icon', 'action'], where, errors);
        if (typeof it.id !== 'string' || !FIRM_ID_RE.test(it.id)) errors.push(`${where}: id must match ${FIRM_ID_RE}`);
        else if (seen.has(it.id)) errors.push(`${where}: duplicate id ${it.id}`);
        else if (retired.includes(it.id)) {
          errors.push(`${where}: ${it.id} belonged to a deleted item and is retired — a new item needs a new id`);
        } else seen.add(it.id);
        const label = cleanLabel(it.label, where, errors);
        if (typeof it.icon !== 'string' || !ICON_RE.test(it.icon)) errors.push(`${where}: icon must match ${ICON_RE}`);
        const action = cleanAction(it.action, where, errors);
        if (errors.length === n) items.push({ id: it.id, label, icon: it.icon, action });
      });
    }
  }
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
    if (!isItemRef(b.id)) errors.push(`${where}: id must be an item id`);
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

function layoutEntries(v, sf, errors) {
  const field = `placed.${sf}`;
  if (!Array.isArray(v)) { errors.push(`${field} must be an array`); return null; }
  if (v.length > CAPS.placed) { errors.push(`${field}: at most ${CAPS.placed} entries`); return null; }
  const out = [];
  const seen = new Map();
  const shapes = sf === 'home' ? '{ item } or { break: true }' : '{ item } or { label }';
  v.forEach((e, i) => {
    const where = `${field}[${i}]`;
    if (!isPlainObject(e)) { errors.push(`${where} must be an object`); return; }
    const keys = Object.keys(e);
    if (keys.length !== 1) { errors.push(`${where} must be exactly one of ${shapes}`); return; }
    const k = keys[0];
    if (k === 'item') {
      if (!isItemRef(e.item)) { errors.push(`${where}: not an item id`); return; }
      if (seen.has(e.item)) { errors.push(`${where}: ${e.item} is already placed at ${field}[${seen.get(e.item)}]`); return; }
      seen.set(e.item, i);
      out.push({ item: e.item });
    } else if (k === 'break' && sf === 'home') {
      if (e.break !== true) { errors.push(`${where}: break must be true`); return; }
      out.push({ break: true });
    } else if (k === 'label' && sf === 'sidebar') {
      const label = cleanLabel(e.label, where, errors);
      if (label != null) out.push({ label });
    } else if (k === 'break' || k === 'label') {
      errors.push(`${where}: a ${k} is for the ${k === 'break' ? 'Home grid' : 'sidebar'} only`);
    } else {
      errors.push(`${where}: unknown field "${k}" (an entry is ${shapes})`);
    }
  });
  return out;
}

function layout(c, errors) {
  unknownKeys(c, ['placed', 'removed'], 'layout', errors);
  const placed = {};
  if (c.placed !== undefined) {
    if (!isPlainObject(c.placed)) errors.push('placed must be an object');
    else {
      unknownKeys(c.placed, LAYOUT_SURFACES, 'placed', errors);
      for (const sf of LAYOUT_SURFACES) {
        if (c.placed[sf] === undefined) continue;
        const list = layoutEntries(c.placed[sf], sf, errors);
        if (list) placed[sf] = list;
      }
    }
  }
  const removed = {};
  if (c.removed !== undefined) {
    if (!isPlainObject(c.removed)) errors.push('removed must be an object { home?, sidebar? } — removals are per surface');
    else {
      unknownKeys(c.removed, LAYOUT_SURFACES, 'removed', errors);
      for (const sf of LAYOUT_SURFACES) {
        if (c.removed[sf] !== undefined) removed[sf] = cleanRefList(c.removed[sf], `removed.${sf}`, errors, { cap: CAPS.removed });
      }
    }
  }
  return { placed, removed };
}

const DOCS = { registry_overrides: registryOverrides, shortcuts, layout };

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
  const value = DOCS[configKey](config, errors);
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
  SCOPES, CONFIG_KEYS, CAPS, ERRORS_MAX, NAMED_KEYS, ACTION_SHAPES, SIZES, LAYOUT_SURFACES, VISIBLE_ROLES, shellOnlyPath, comboProblem,
  REGISTRY_ID_RE, FIRM_ID_RE, ICON_RE, VIEW_KEY_RE, LABEL_MAX,
};
