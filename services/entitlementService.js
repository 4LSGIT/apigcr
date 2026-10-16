// services/entitlementService.js
//
/**
 * Launcher entitlements — DENIES (access-control A5,
 * ref/ACCESS_CONTROL_DESIGN.md §2.6, contract §3.4–5).
 *
 * Table entitlement_denies (scripts/accessA5Entitlements.js): deny-only rows
 * at three scopes —
 *   firm  scope_ref ''          (sentinel; same spelling as ui_config's role column)
 *   role  scope_ref <role>      (a users.roles SET member — lib/capabilities ROLE_MEMBERS)
 *   user  scope_ref <users.user as digits>
 * "Deny wins" and "default allow" fall out of the shape: an item is denied to
 * a user iff ANY row names it at the firm, at one of their roles, or at them.
 *
 *   deniedFor(db, userId) → sorted item_key[]  — ONE query over all three
 *     scopes (the user's roles are read from users in the same statement:
 *     DB-fresh, never the 24h JWT claim). Shipped to the shell as
 *     /api/firm-data `denied`; ui-custom's launcher consumes it.
 *
 * VISIBILITY-ONLY in v2: nothing here gates a route. The v3 seam (design
 * §2.6) maps a denied item to a 403 on its route family.
 *
 * UNDENIABLE = moreSettings + helpSupport (§2.6) + all (ui-custom S6c: the All
 * tab is a registry item now, guaranteed in Home's icon row and in Ctrl-K —
 * Fred's ruling 2026-10-16): refused at WRITE and stripped at RESOLVE — a row
 * that reached the table some other way (DB console) still never hides them.
 *
 * item_key vocabulary = the keys of public/js/featureRegistry.js (ui-custom
 * S1). That file is browser data (it assigns window.FEATURE_REGISTRY), so it
 * is evaluated in an empty vm context — the same way tests/helpers/shellHtml.js
 * loads it — never required. A write naming any other key is refused (a typo
 * must not mint a dead deny); if the registry cannot be loaded at all, writes
 * fail loud while resolution carries on. A firm item id (firm:<slug>,
 * lib/uiConfigShape FIRM_ID_RE) is accepted too (ui-custom S3.4).
 *
 * Registry-external chrome (§2.6): the shell header greeting (index.html
 * .hdr-greeting) opens tabSettings directly — it is not a registry item, so
 * no deny could hide it. It is the one launcher route outside the registry,
 * and irrelevant while Settings is undeniable.
 *
 * Error contract: input errors carry err.status = 400, a duplicate deny 409,
 * an unknown id 404.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROLE_MEMBERS } = require('../lib/capabilities');

const UNDENIABLE = Object.freeze(['moreSettings', 'helpSupport', 'all']);
const SCOPES = Object.freeze(['firm', 'role', 'user']);
const REGISTRY_FILE = path.join(__dirname, '..', 'public', 'js', 'featureRegistry.js');

let registryKeys = null;   // Set, loaded on first write

/** The launcher registry's item keys. Throws if the file can't be evaluated. */
function loadRegistryKeys() {
  if (registryKeys) return registryKeys;
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(REGISTRY_FILE, 'utf8'), ctx, { filename: REGISTRY_FILE, timeout: 1000 });
  const reg = ctx.window.FEATURE_REGISTRY;
  if (!reg || typeof reg !== 'object' || !Object.keys(reg).length) {
    throw new Error('entitlements: public/js/featureRegistry.js defined no FEATURE_REGISTRY');
  }
  registryKeys = new Set(Object.keys(reg));
  return registryKeys;
}

// Read lazily: lib/uiConfigShape requires this module (UNDENIABLE), so a
// load-time require here would be a cycle.
const isFirmItemId = (k) => require('../lib/uiConfigShape').FIRM_ID_RE.test(k);

function inputError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// One statement over the three scopes. LEFT JOIN so firm denies still apply
// when the caller has no users row (an x-api-key firm-data caller). user-scope
// refs compare numerically — writes store digits only — so no collation meets
// a CAST.
const DENIED_SQL =
  'SELECT DISTINCT d.item_key FROM entitlement_denies d ' +
  'LEFT JOIN users u ON u.`user` = ? ' +
  "WHERE d.scope = 'firm' " +
  "OR (d.scope = 'role' AND u.`user` IS NOT NULL AND FIND_IN_SET(d.scope_ref, u.roles) > 0) " +
  "OR (d.scope = 'user' AND u.`user` IS NOT NULL AND CAST(d.scope_ref AS UNSIGNED) = u.`user`)";

/** Item keys denied to this user (sorted), undeniables stripped. */
async function deniedFor(db, userId) {
  const n = Number(userId);
  const id = Number.isInteger(n) ? n : null;
  const [rows] = await db.query(DENIED_SQL, [id]);
  return [...new Set(rows.map(r => r.item_key))]
    .filter(k => !UNDENIABLE.includes(k))
    .sort();
}

/**
 * Validate + normalize one deny. Accepts scope_ref null/undefined for firm
 * (normalized to ''); a user ref may be a number or a digit string.
 * Returns { scope, scope_ref, item_key }; throws status 400.
 */
function normalizeDeny(body) {
  const b = body || {};
  const scope = b.scope;
  if (!SCOPES.includes(scope)) throw inputError(`scope must be one of: ${SCOPES.join(', ')}`);

  const item = b.item_key;
  if (typeof item !== 'string' || !item) throw inputError('item_key is required');
  if (UNDENIABLE.includes(item)) throw inputError(`${item} cannot be denied (always available)`);
  if (!loadRegistryKeys().has(item) && !isFirmItemId(item)) throw inputError(`unknown item_key "${item}" (not in public/js/featureRegistry.js, nor a firm:<slug> id)`);

  let ref = b.scope_ref;
  if (scope === 'firm') {
    if (ref != null && ref !== '') throw inputError('scope_ref must be empty for a firm deny');
    ref = '';
  } else if (scope === 'role') {
    if (!ROLE_MEMBERS.includes(ref)) throw inputError(`scope_ref must be a role: ${ROLE_MEMBERS.join(', ')}`);
  } else {
    const s = typeof ref === 'number' ? String(ref) : ref;
    if (typeof s !== 'string' || !/^\d{1,3}$/.test(s)) throw inputError('scope_ref must be a users.user id');
    ref = String(Number(s));                 // '06' → '6': one spelling per user
  }
  return { scope, scope_ref: ref, item_key: item };
}

async function listDenies(db) {
  const [rows] = await db.query(
    'SELECT id, scope, scope_ref, item_key, created_by, created_at FROM entitlement_denies ' +
    'ORDER BY scope, scope_ref, item_key'
  );
  return rows;
}

async function createDeny(db, body, createdBy) {
  const d = normalizeDeny(body);
  if (d.scope === 'user') {
    const [[u]] = await db.query('SELECT `user` FROM users WHERE `user` = ? LIMIT 1', [Number(d.scope_ref)]);
    if (!u) throw inputError(`no user ${d.scope_ref}`);
  }
  try {
    const [r] = await db.query(
      'INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES (?, ?, ?, ?)',
      [d.scope, d.scope_ref, d.item_key, Number(createdBy) || 0]
    );
    return { id: r.insertId, ...d };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') throw inputError('that deny already exists', 409);
    throw err;
  }
}

async function deleteDeny(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw inputError('invalid id');
  const [r] = await db.query('DELETE FROM entitlement_denies WHERE id = ?', [n]);
  if (!r.affectedRows) throw inputError('deny not found', 404);
  return { id: n };
}

module.exports = {
  UNDENIABLE, SCOPES, DENIED_SQL,
  deniedFor, normalizeDeny, listDenies, createDeny, deleteDeny,
  loadRegistryKeys,
  _resetRegistry: () => { registryKeys = null; },   // tests
};
