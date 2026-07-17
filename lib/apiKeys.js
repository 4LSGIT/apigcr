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
 *
 * CACHING
 *   lookup() memoizes hash → row (including misses and revoked → null) for
 *   TTL_MS, so per-request auth costs one SELECT per distinct key per minute,
 *   not per call. invalidateCache() is called by the admin create/revoke
 *   endpoints; other Cloud Run instances converge within TTL_MS — meaning a
 *   freshly created key may 401 on other instances for up to 60s, and a
 *   revoked key may keep working there for up to 60s. Acceptable for this
 *   use; do not use this module for anything needing instant revocation.
 *
 * last_used_at is written at most once per TOUCH_MS per key (fire-and-forget).
 */

const crypto = require('crypto');

const TTL_MS   = 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const KEY_PREFIX_STR = 'yck_';

const cache   = new Map(); // key_hash → { rec: row|null, at: ms }
const touched = new Map(); // id → ms of last last_used_at write

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * New random key: <prefix> + 64 hex chars (32 bytes entropy).
 * Default prefix yck_ = external keys; the internal rotate endpoint passes
 * 'yci_' so leaked key material is instantly classifiable in logs.
 */
function generateKey(prefix = KEY_PREFIX_STR) {
  return prefix + crypto.randomBytes(32).toString('hex');
}

/**
 * Resolve a presented raw key to an active api_keys row, or null.
 * Cached (positive + negative). Never throws — auth must fail closed on
 * lookup errors, not 500.
 * @returns {Promise<{id:number,label:string}|null>}
 */
async function lookup(db, rawKey) {
  if (!db || !rawKey) return null;
  const h = hashKey(rawKey);
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.rec) touchLastUsed(db, hit.rec.id);
    return hit.rec;
  }
  let rec = null;
  try {
    const [[row]] = await db.query(
      'SELECT id, label, revoked_at FROM api_keys WHERE key_hash = ? LIMIT 1',
      [h]
    );
    rec = row && !row.revoked_at ? { id: row.id, label: row.label } : null;
  } catch (err) {
    console.error('[apiKeys] lookup failed:', err.message);
    return null; // fail closed, uncached — retry next request
  }
  cache.set(h, { rec, at: Date.now() });
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
 * Create a named key. Returns { raw, id, label, key_prefix } — the ONLY
 * time raw is ever available. Caller (admin route) shows it once.
 */
async function createKey(db, label, createdBy = null) {
  const raw = generateKey();
  const [res] = await db.query(
    'INSERT INTO api_keys (label, key_hash, key_prefix, created_by) VALUES (?, ?, ?, ?)',
    [label, hashKey(raw), raw.slice(0, 12), createdBy]
  );
  invalidateCache();
  return { raw, id: res.insertId, label, key_prefix: raw.slice(0, 12) };
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
    `SELECT id, label, key_prefix, created_by, created_at, last_used_at, revoked_at
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
  lookup,
  createKey,
  revokeKey,
  listKeys,
  invalidateCache,
  _touchedForTests: touched,
};