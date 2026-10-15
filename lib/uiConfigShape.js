// lib/uiConfigShape.js
//
/**
 * ui_config document validator — ui-customization arc S3.1
 * (local/ui-custom/PLAN.md §4.6, §6; the API is routes/api.uiConfig.js).
 *
 * PURE: no DB, no req/res. The tool-key grammar is borrowed from
 * routes/api.tools.js (TOOL_KEY_RE — requiring it loads that router module,
 * which has no side effects at require time) and the undeniable set from
 * services/entitlementService.js (UNDENIABLE) — one definition each.
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
 *   user  shortcuts        (storage only until S4's dispatcher)
 *
 * registry_overrides → normalized to exactly these four keys:
 *   hidden   [itemRef]           ≤ 100, de-duplicated, first-seen order.
 *                                 moreSettings / helpSupport (UNDENIABLE) refused:
 *                                 the All surface and Settings stay reachable.
 *   locked   [itemRef]           ≤ 100, de-duplicated. Stored and delivered; INERT
 *                                 until S4's user layer.
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
 *       { type:'tool', key (TOOL_KEY_RE), present:'modal' }  → /tool/<key>
 *       { type:'view', key (VIEW_KEY_RE), present:'modal' }  → /customView.html?key=<key>
 *     present:'tab' is refused (N dynamic tabs are S5); every other type —
 *     action (DEFERRED by ruling), iframe, fn, tab, panel, … — is refused. No
 *     item may carry onclick / fn / script / html: unknown keys are errors.
 *   itemRef = a registry-shaped id (^[A-Za-z][A-Za-z0-9]{0,63}$) or a firm id.
 *   Ids are NOT checked against the registry (it is client code; soft refs
 *   drop at render).
 *
 * shortcuts → { bindings: [ { combo: { ctrl, meta, alt, shift, key }, id } ] }
 *   ≤ 50; the four modifiers are required strict booleans; key = one printable
 *   character (letters stored lower-case) or a NAMED_KEYS name; id an itemRef.
 *   Two bindings with the same combo are refused. No reserved-combo policing
 *   (S4's editor owns that UX).
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

const SCOPES = Object.freeze(['firm', 'user']);
const CONFIG_KEYS = Object.freeze({
  firm: Object.freeze(['registry_overrides']),
  user: Object.freeze(['shortcuts']),
});

const REGISTRY_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIRM_ID_RE = /^firm:[a-z0-9-]{1,40}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;              // routes/auth.customTab.js's icon charset
// report_definitions.report_key — services/reportService.js REPORT_KEY_RE.
// Copied, not required: reportService opens the read-only pool at require
// time. tests/uiConfigS31.test.js pins this copy to that source.
const VIEW_KEY_RE = /^[a-z][a-z0-9_]{2,59}$/;
const LABEL_MAX = 40;
const HREF_MAX = 2000;
const CAPS = Object.freeze({ hidden: 100, locked: 100, renames: 100, items: 50, bindings: 50 });
const ERRORS_MAX = 20;          // messages returned; the rest are counted
const UNKNOWN_KEYS_MAX = 5;     // unknown fields reported per object

// tool / view items are modal-only: their pages boot from the PARENT shell's
// apiSend (customView.html: const P = window.parent + its waitForParent poll;
// toolManager.html: "opened directly … a tool has no parent shell, so every
// API call fails"), so a bare window would be a dead page. 'window' is for
// url items only (manager ruling, S3.1).
const ACTION_SHAPES = Object.freeze({
  url:  Object.freeze({ keys: ['type', 'href', 'present'], present: ['window'] }),
  tool: Object.freeze({ keys: ['type', 'key', 'present'], present: ['modal'] }),
  view: Object.freeze({ keys: ['type', 'key', 'present'], present: ['modal'] }),
});

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
      (type === 'action' ? ' (the action kind is deferred)' : ''));
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
  }
  if (errors.length !== n) return null;
  return type === 'url'
    ? { type, href: a.href, present: a.present }
    : { type, key: a.key, present: a.present };
}

function cleanRefList(v, field, errors, { undeniable = false } = {}) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errors.push(`${field} must be an array`); return []; }
  if (v.length > CAPS[field]) { errors.push(`${field}: at most ${CAPS[field]} entries`); return []; }
  const out = [];
  v.forEach((id, i) => {
    if (!isItemRef(id)) { errors.push(`${field}[${i}]: not an item id`); return; }
    if (undeniable && UNDENIABLE.includes(id)) { errors.push(`${field}[${i}]: ${id} cannot be hidden (always available)`); return; }
    if (!out.includes(id)) out.push(id);
  });
  return out;
}

function registryOverrides(c, errors) {
  unknownKeys(c, ['hidden', 'locked', 'renames', 'items'], 'registry_overrides', errors);
  const hidden = cleanRefList(c.hidden, 'hidden', errors, { undeniable: true });
  const locked = cleanRefList(c.locked, 'locked', errors);

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
        else seen.add(it.id);
        const label = cleanLabel(it.label, where, errors);
        if (typeof it.icon !== 'string' || !ICON_RE.test(it.icon)) errors.push(`${where}: icon must match ${ICON_RE}`);
        const action = cleanAction(it.action, where, errors);
        if (errors.length === n) items.push({ id: it.id, label, icon: it.icon, action });
      });
    }
  }
  return { hidden, locked, renames, items };
}

function comboKey(k) {
  if (typeof k !== 'string') return null;
  if (NAMED_KEYS.includes(k)) return k;
  const chars = [...k];
  if (chars.length !== 1 || /\s/.test(k) || CONTROL_RE.test(k)) return null;
  return k.toLowerCase();
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
    const sig = [combo.ctrl, combo.meta, combo.alt, combo.shift, combo.key].join('|');
    if (seen.has(sig)) { errors.push(`${where}: same combo as bindings[${seen.get(sig)}]`); return; }
    seen.set(sig, i);
    bindings.push({ combo, id: b.id });
  });
  return { bindings };
}

const DOCS = { registry_overrides: registryOverrides, shortcuts };

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
  SCOPES, CONFIG_KEYS, CAPS, ERRORS_MAX, NAMED_KEYS, ACTION_SHAPES, shellOnlyPath,
  REGISTRY_ID_RE, FIRM_ID_RE, ICON_RE, VIEW_KEY_RE, LABEL_MAX,
};
