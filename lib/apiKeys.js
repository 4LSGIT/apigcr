// lib/apiKeys.js
//
/**
 * External API keys — per-source inbound credentials.
 *
 * Complements the single internal_api_key (app-to-self, see firmConfig +
 * auth.jwtOrApiKey): each external caller (Pabbly, webhooks, ...) gets its
 * own named key so it can be revoked independently, attributed in
 * jwt_api_audit_log, and observed via last_used_at (e.g. "is anything still
 * calling us with the Pabbly key" during its retirement).
 *
 * SECURITY MODEL
 *   - Plaintext keys are shown ONCE at creation and never stored; the DB
 *     holds only SHA-256(key). key_prefix (first 12 chars) is for humans
 *     matching a row to a key they hold.
 *   - Revocation = revoked_at set; rows are never deleted (audit trail).
 *   - Expiry (access-control B6) = expires_at passed. NULL = non-expiring
 *     (every key minted before B6, and infrastructure keys by choice). An
 *     expired key is refused exactly like a revoked one: lookup → null, the
 *     caller falls through to the JWT check and is logged the same way.
 *
 * EDITS (access-control D2): setScopes() and setExpiry() change a live key's
 *   scopes / expiry after mint, with the mint's own validators
 *   (machineKeyScopes / machineKeyExpiry). Revocation is TERMINAL — a revoked
 *   key is a 409 for both (.status), never un-revoked. A key is never set back
 *   to NULL scopes; a legacy NULL key may be given scopes (the retrofit).
 *
 * CACHING
 *   lookup() memoizes hash → row (including misses and revoked → null) for
 *   TTL_MS, so per-request auth costs one SELECT per distinct key per minute,
 *   not per call. invalidateCache() is called by the admin create / revoke /
 *   scope-edit / expiry endpoints; other Cloud Run instances converge within
 *   TTL_MS — meaning, on an instance that did NOT serve the admin call:
 *     - a freshly created key may 401 for up to 60s;
 *     - a revoked key may keep working for up to 60s;
 *     - an edited key keeps its OLD scopes for up to 60s (narrowing included);
 *     - the cached entry carries the OLD expiry: a key whose expiry is pushed
 *       out after it lapsed may stay refused for up to 60s, and one whose
 *       expiry is pulled IN keeps working until the old one, at most 60s more.
 *   Acceptable for this use; do not use this module for anything needing
 *   instant revocation. A key's OWN expiry has no lag: every hit re-checks
 *   the cached expires_at (B6).
 *
 * last_used_at is written at most once per TOUCH_MS per key (fire-and-forget).
 */

const crypto = require('crypto');
const { scopesFromColumn, normalizeKeyScopes, KEY_SCOPES } = require('./capabilities');

const TTL_MS   = 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const KEY_PREFIX_STR = 'yck_';

const cache   = new Map(); // key_hash → { rec: row|null, exp: ms|null, at: ms }
const touched = new Map(); // id → ms of last last_used_at write

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Key bodies (access-control B3, ref/ACCESS_CONTROL_DESIGN.md §5.3): 22
// characters of base62 — 62^22 ≈ 2^131 — replacing 64 hex. Keys minted
// before B3 keep working forever: auth hashes whatever string was minted.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_BODY_LEN = 22;

/**
 * n characters drawn UNIFORMLY from [0-9A-Za-z]. Rejection sampling: a
 * random byte is used only when it is < 248 (= 4 × 62), so `byte % 62` hits
 * every symbol exactly 4 ways — no modulo bias. ~3% of bytes are discarded.
 */
function randomBase62(n) {
  let out = '';
  while (out.length < n) {
    const buf = crypto.randomBytes(n * 2);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      if (buf[i] < 248) out += BASE62[buf[i] % 62];
    }
  }
  return out;
}

/**
 * New random key: <prefix> + 22 base62 chars (~131 bits).
 * Default prefix yck_ = external keys; the internal rotate endpoint passes
 * 'yci_' so leaked key material is instantly classifiable in logs.
 */
function generateKey(prefix = KEY_PREFIX_STR) {
  return prefix + randomBase62(KEY_BODY_LEN);
}

// Machine-key expiry at mint (B6): `ttlMinutes`, the session-key mint's input
// shape. Absent / null / '' = never. Otherwise a positive whole number of
// minutes up to MAX_TTL_MINUTES (5 years) — anything else is a 400, never a
// silent "never" (a typo must not mint an immortal key).
const MAX_TTL_MINUTES = 5 * 365 * 24 * 60;

/** → null (non-expiring) or the expiry Date. Throws with .status = 400. */
function machineKeyExpiry(ttlMinutes, now = Date.now()) {
  if (ttlMinutes === undefined || ttlMinutes === null || ttlMinutes === '') return null;
  const n = typeof ttlMinutes === 'string' && /^\d+$/.test(ttlMinutes.trim()) ? Number(ttlMinutes.trim()) : ttlMinutes;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_TTL_MINUTES) {
    const e = new Error(`ttlMinutes must be a whole number of minutes from 1 to ${MAX_TTL_MINUTES} (5 years), or omitted for a key that never expires`);
    e.status = 400;
    throw e;
  }
  return new Date(now + n * 60_000);
}

/**
 * Resolve a presented raw key to an active api_keys row, or null. The record
 * carries `scopes` (null = legacy full surface — access-control B1; cached
 * with the rest, so a scopes change converges within TTL_MS like a revoke).
 * B1 only ATTACHES them (jwtOrApiKey → req.auth.scopes); B2 enforces.
 * Cached (positive + negative). Never throws — auth must fail closed on
 * lookup errors, not 500.
 * EXPIRY (B6): a row whose expires_at has passed resolves to null, like a
 * revoked one. The cache keeps the row's expiry and re-checks it on EVERY hit
 * (free — the row is in hand), so a key never outlives its expires_at by the
 * cache TTL; only revocation keeps the ≤TTL_MS cross-instance lag.
 * @returns {Promise<{id:number,label:string,scopes:string[]|null}|null>}
 */
async function lookup(db, rawKey) {
  if (!db || !rawKey) return null;
  const h = hashKey(rawKey);
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.rec && hit.exp != null && hit.exp <= Date.now()) return null;   // expired since cached
    if (hit.rec) touchLastUsed(db, hit.rec.id);
    return hit.rec;
  }
  let rec = null;
  let exp = null;
  try {
    const [[row]] = await db.query(
      'SELECT id, label, revoked_at, expires_at, scopes FROM api_keys WHERE key_hash = ? LIMIT 1',
      [h]
    );
    exp = row && row.expires_at != null ? new Date(row.expires_at).getTime() : null;
    const live = row && !row.revoked_at && (exp == null || exp > Date.now());
    rec = live ? { id: row.id, label: row.label, scopes: scopesFromColumn(row.scopes) } : null;
  } catch (err) {
    console.error('[apiKeys] lookup failed:', err.message);
    return null; // fail closed, uncached — retry next request
  }
  cache.set(h, { rec, exp, at: Date.now() });
  if (rec) touchLastUsed(db, rec.id);
  return rec;
}

/** Throttled fire-and-forget last_used_at bump. */
function touchLastUsed(db, id) {
  const last = touched.get(id) || 0;
  if (Date.now() - last < TOUCH_MS) return;
  touched.set(id, Date.now());
  db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [id])
    .catch((err) => console.error('[apiKeys] touch failed:', err.message));
}

/**
 * Validate a machine key's scopes (access-control B2). undefined/null → null
 * (the legacy full surface). Otherwise a non-empty list of `route:/<path>` and
 * capability names (lib/capabilities normalizeKeyScopes); session-key SURFACE
 * scopes (sql.ro, scratch, …) are refused — no yck_ route checks them, so they
 * would read as a grant and do nothing. Throws with .status = 400.
 */
function machineKeyScopes(scopes) {
  if (scopes === undefined || scopes === null) return null;
  let list;
  try { list = normalizeKeyScopes(scopes); }
  catch (err) { err.status = 400; throw err; }
  const surface = list.filter((s) => Object.prototype.hasOwnProperty.call(KEY_SCOPES, s));
  if (surface.length) {
    const e = new Error(`session-key scope(s) on a machine key: ${surface.join(', ')} — use route:/<path> or a capability name`);
    e.status = 400;
    throw e;
  }
  return list;
}

/**
 * Create a named key. Returns { raw, id, label, key_prefix, scopes, expires_at }
 * — the ONLY time raw is ever available. Caller (admin route) shows it once.
 * `scopes` optional (machineKeyScopes); omitted = NULL = legacy full surface.
 * `ttlMinutes` optional (machineKeyExpiry, B6); omitted = NULL = never expires.
 * Both are validated before anything is written.
 */
async function createKey(db, label, createdBy = null, scopes, ttlMinutes) {
  const list = machineKeyScopes(scopes);
  const expiresAt = machineKeyExpiry(ttlMinutes);
  const raw = generateKey();
  const [res] = await db.query(
    'INSERT INTO api_keys (label, key_hash, key_prefix, created_by, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [label, hashKey(raw), raw.slice(0, 12), createdBy, list == null ? null : JSON.stringify(list), expiresAt]
  );
  invalidateCache();
  return { raw, id: res.insertId, label, key_prefix: raw.slice(0, 12), scopes: list, expires_at: expiresAt };
}

function refusal(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** The row an edit acts on: 404 if missing, 409 if revoked (terminal). */
async function liveRowForEdit(db, id) {
  const [[row]] = await db.query('SELECT id, revoked_at, expires_at, scopes FROM api_keys WHERE id = ?', [id]);
  if (!row) throw refusal(404, 'key not found');
  if (row.revoked_at) throw refusal(409, 'revoked keys stay revoked — mint a new one');
  return row;
}

/**
 * Replace a machine key's scopes (D2). A full list, validated exactly as at
 * mint; undefined / null is a 400 — a key never goes back to NULL (the
 * legacy full surface). → { before, after }. Throws with .status.
 */
async function setScopes(db, id, scopes) {
  if (scopes === undefined || scopes === null) {
    throw refusal(400, 'scopes is required — the full new list; a key is never set back to NULL (the legacy full surface)');
  }
  const list = machineKeyScopes(scopes);
  const row = await liveRowForEdit(db, id);
  const [res] = await db.query('UPDATE api_keys SET scopes = ? WHERE id = ? AND revoked_at IS NULL', [JSON.stringify(list), id]);
  if (!res.affectedRows) throw refusal(409, 'revoked keys stay revoked — mint a new one');
  invalidateCache();
  return { before: scopesFromColumn(row.scopes), after: list };
}

/**
 * Set a machine key's expiry (D2): { ttlMinutes } → now + ttl (machineKeyExpiry,
 * the B6 mint rule: 1 min – 5 years), or { never: true } → NULL. Exactly one;
 * an omitted ttl is a 400 here, never a silent "never". Works on an expired,
 * unrevoked key. → { before, after } (Date | null). Throws with .status.
 */
async function setExpiry(db, id, { ttlMinutes, never } = {}) {
  const hasTtl = !(ttlMinutes === undefined || ttlMinutes === null || ttlMinutes === '');
  if (never !== undefined && typeof never !== 'boolean') throw refusal(400, 'never must be true or false');
  if (never === true && hasTtl) throw refusal(400, 'send ttlMinutes or never:true, not both');
  if (never !== true && !hasTtl) throw refusal(400, 'ttlMinutes is required (or never:true for a key that never expires)');
  const expiresAt = never === true ? null : machineKeyExpiry(ttlMinutes);
  const row = await liveRowForEdit(db, id);
  const [res] = await db.query('UPDATE api_keys SET expires_at = ? WHERE id = ? AND revoked_at IS NULL', [expiresAt, id]);
  if (!res.affectedRows) throw refusal(409, 'revoked keys stay revoked — mint a new one');
  invalidateCache();
  return { before: row.expires_at == null ? null : new Date(row.expires_at), after: expiresAt };
}

/** Revoke by id. Idempotent (re-revoking keeps the original timestamp). */
async function revokeKey(db, id) {
  await db.query(
    'UPDATE api_keys SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = ?',
    [id]
  );
  invalidateCache();
}

/** All keys, newest first — for the admin list. Never includes hashes. */
async function listKeys(db) {
  const [rows] = await db.query(
    `SELECT id, label, key_prefix, created_by, created_at, last_used_at, revoked_at, expires_at, scopes
     FROM api_keys ORDER BY id DESC`
  );
  return rows;
}

function invalidateCache() {
  cache.clear();
}

module.exports = {
  hashKey,
  generateKey,
  randomBase62,
  KEY_BODY_LEN,
  lookup,
  createKey,
  machineKeyScopes,
  machineKeyExpiry,
  MAX_TTL_MINUTES,
  revokeKey,
  setScopes,
  setExpiry,
  listKeys,
  invalidateCache,
  _touchedForTests: touched,
};