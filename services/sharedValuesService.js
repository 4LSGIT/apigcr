// services/sharedValuesService.js
//
/**
 * Shared values — staff-created namespaces of staff-written key/value pairs
 * (settings-access arc, 2026-10-28; Fred's rulings in scratch
 * fred/settings_access_state). NOT configuration: app_settings is config with
 * one editor per key; this is runtime data several staff write — an office
 * high score, a "who is on call" note, a counter a tool keeps.
 *
 * Tables (scripts/sharedValuesMigrate.js; ref/migrations/2026-10-28_shared_values.sql):
 *   shared_namespaces (ns PK, description, write_mode, max_value_bytes,
 *                      max_keys, created_by, …)
 *   shared_values     (ns, k PK; v, rev, updated_by, updated_act, …;
 *                      FK ns → shared_namespaces ON DELETE CASCADE)
 *
 * RULES
 *   - Any staff member creates a namespace; its creator and firm.settings
 *     holders manage it (PATCH description / write_mode / limits, DELETE).
 *   - write_mode decides who writes values:
 *       staff    any staff member (the default)
 *       creator  the creator, or a firm.settings holder
 *       own_key  each user only the key equal to their users.user (as a
 *                decimal string); a firm.settings holder any key
 *     Anything else (relaxed sql_mode stores an unknown enum as '') refuses
 *     every write — fail closed.
 *   - Every value write is COMPARE-AND-SET on rev: a create names rev null and
 *     fails if the key exists; an update names the rev it read and fails if
 *     it moved. Both failures are 409 carrying the current row, so a client
 *     re-reads and retries — and a retried write that finds its own value
 *     knows it landed. There is no blind overwrite (two writers never lose an
 *     update silently, unlike app_settings / scratch).
 *     The `current` a failure reports is read FOR SHARE: under REPEATABLE READ
 *     a plain read returns the transaction's snapshot (fixed by its first
 *     read), not the row the failed locking UPDATE / DELETE just saw — a
 *     racing writer would be told rev 1 while the row is at rev 2, and a
 *     delete that lost a race to another delete would read 409, not 404.
 *   - A namespace page is held to PAGE_BYTES: its row count is at most
 *     floor(PAGE_BYTES / max_value_bytes), so 1000 rows of 1 MB values never
 *     reach one response (`trimmed: true` says the page was cut).
 *   - The server stamps updated_by (the JWT's user) and updated_act (the
 *     human behind a live View-as; read-only View-as writes never get here —
 *     lib/auth.impersonation refuses them in the auth middleware).
 *   - Sizes are refused HERE, before SQL: sql_mode is relaxed, so MySQL would
 *     truncate an over-long value silently. max_keys is enforced on create
 *     under a lock on the namespace row.
 *   - Names (ns, k) match NAME_RE — lowercase only: the columns are
 *     utf8mb4_bin, and lowercase-only keeps two spellings from ever naming
 *     "the same" key to a person.
 *   - Values are UNTRUSTED text written by any staff member. Consumers render
 *     them with textContent, never innerHTML: a tool page runs on the app
 *     origin as whoever opens it.
 *   - Not reachable from automation: neither table is in update_db /
 *     insert_db's WRITE_POLICY nor query_db's allowlist
 *     (lib/internal_functions/db.js, DELIBERATELY EXCLUDED).
 *
 * Errors are thrown as SharedError { httpStatus, code?, current? }; the route
 * maps them. Every function takes the promise pool (req.db).
 */

'use strict';

const { can } = require('../lib/capabilities');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WRITE_MODES = Object.freeze(['staff', 'creator', 'own_key']);
const LIMITS = Object.freeze({
  max_value_bytes: Object.freeze({ min: 1, max: 1048576, def: 65536 }),
  max_keys:        Object.freeze({ min: 1, max: 10000,   def: 1000 }),
});
const MAX_DESCRIPTION = 500;
const LIST_DEFAULT = 200;
const LIST_MAX = 1000;
const PAGE_BYTES = 8 * 1024 * 1024;   // worst-case value bytes in one GET /api/shared/:ns page
const MANAGE_CAP = 'firm.settings';

class SharedError extends Error {
  constructor(httpStatus, message, extra = {}) {
    super(message);
    this.httpStatus = httpStatus;
    Object.assign(this, extra);
  }
}

// ── identity ────────────────────────────────────────────────────────────────

/** users.user of a staff JWT as an integer (tinyint range), else null. */
function userIdOf(auth) {
  if (!auth || auth.type !== 'jwt') return null;
  const n = Number(auth.userId);
  return auth.userId != null && auth.userId !== '' && Number.isInteger(n) && n >= -128 && n <= 127 ? n : null;
}

/** The human behind a live View-as session, else null. */
function actIdOf(auth) {
  const a = auth && auth.impersonator;
  const n = a ? Number(a.userId) : NaN;
  return Number.isInteger(n) && n >= -128 && n <= 127 ? n : null;
}

const isManager = (auth) => can(auth, MANAGE_CAP);
const isCreator = (nsRow, uid) => uid != null && Number(nsRow.created_by) === uid;

/** May this caller manage (PATCH / DELETE) the namespace? */
function mayManage(nsRow, auth) {
  return isManager(auth) || isCreator(nsRow, userIdOf(auth));
}

/** May this caller write key k? → null, or the refusal sentence. */
function writeRefusal(nsRow, k, auth) {
  const uid = userIdOf(auth);
  if (uid == null) return 'Writing a shared value needs a signed-in staff user';
  switch (nsRow.write_mode) {
    case 'staff':
      return null;
    case 'creator':
      return isManager(auth) || isCreator(nsRow, uid) ? null
        : `Only the creator of "${nsRow.ns}" (or an admin) may write its values`;
    case 'own_key':
      return isManager(auth) || k === String(uid) ? null
        : `In "${nsRow.ns}" each user writes only the key "${uid}" (their own)`;
    default:
      return `"${nsRow.ns}" has no valid write mode — an admin must set one`;
  }
}

// ── validation ──────────────────────────────────────────────────────────────

function checkName(what, s) {
  if (typeof s !== 'string' || !NAME_RE.test(s)) {
    throw new SharedError(400, `${what} must be 1-64 characters: lowercase letters, digits, _ or -, starting with a letter or digit`);
  }
  return s;
}

function checkLimit(name, v) {
  const L = LIMITS[name];
  if (!Number.isInteger(v) || v < L.min || v > L.max) {
    throw new SharedError(400, `${name} must be an integer from ${L.min} to ${L.max}`);
  }
  return v;
}

function checkDescription(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new SharedError(400, 'description must be a string');
  if (v.length > MAX_DESCRIPTION) throw new SharedError(400, `description exceeds ${MAX_DESCRIPTION} characters`);
  return v;
}

function checkWriteMode(v) {
  if (!WRITE_MODES.includes(v)) throw new SharedError(400, `write_mode must be one of: ${WRITE_MODES.join(', ')}`);
  return v;
}

/** rev from a body: null (create-only) or a positive integer. undefined is refused — no blind writes. */
function checkRev(rev, { optional = false } = {}) {
  if (rev === undefined) {
    if (optional) return undefined;
    throw new SharedError(400, 'rev is required: null to create a new key, or the rev you read to change it');
  }
  if (rev === null) return null;
  if (!Number.isInteger(rev) || rev < 1 || rev > 4294967295) {
    throw new SharedError(400, 'rev must be null or a positive integer');
  }
  return rev;
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const NS_COLS = 'ns, description, write_mode, max_value_bytes, max_keys, created_by, created_at, updated_at';
const V_COLS = 'ns, k, v, rev, updated_by, updated_act, created_at, updated_at';

const nsOut = (r) => ({
  ns: r.ns, description: r.description, write_mode: r.write_mode,
  max_value_bytes: Number(r.max_value_bytes), max_keys: Number(r.max_keys),
  created_by: Number(r.created_by), created_at: r.created_at, updated_at: r.updated_at,
  ...(r.key_count !== undefined ? { key_count: Number(r.key_count) } : {}),
});
const vOut = (r) => ({
  ns: r.ns, k: r.k, v: r.v, rev: Number(r.rev), updated_by: Number(r.updated_by),
  updated_act: r.updated_act == null ? null : Number(r.updated_act),
  created_at: r.created_at, updated_at: r.updated_at,
});

async function loadNs(q, ns, { lock = false } = {}) {
  const [[row]] = await q.query(`SELECT ${NS_COLS} FROM shared_namespaces WHERE ns = ?${lock ? ' FOR UPDATE' : ''}`, [ns]);
  if (!row) throw new SharedError(404, `No shared namespace "${ns}" — create it first`);
  return row;
}

async function loadValue(q, ns, k) {
  const [[row]] = await q.query(`SELECT ${V_COLS} FROM shared_values WHERE ns = ? AND k = ?`, [ns, k]);
  return row || null;
}

/** The latest committed row, not the transaction's snapshot — for the 409 / 404 decisions (header). */
async function loadValueLatest(q, ns, k) {
  const [[row]] = await q.query(`SELECT ${V_COLS} FROM shared_values WHERE ns = ? AND k = ? FOR SHARE`, [ns, k]);
  return row || null;
}

// ── namespaces ──────────────────────────────────────────────────────────────

async function listNamespaces(db) {
  const [rows] = await db.query(
    `SELECT ${NS_COLS.split(', ').map((c) => 'n.' + c).join(', ')},
            (SELECT COUNT(*) FROM shared_values v WHERE v.ns = n.ns) AS key_count
       FROM shared_namespaces n ORDER BY n.ns`);
  return rows.map(nsOut);
}

async function getNamespace(db, ns) {
  checkName('ns', ns);
  return nsOut(await loadNs(db, ns));
}

async function createNamespace(db, body, auth) {
  const b = body || {};
  const ns = checkName('ns', b.ns);
  const description = checkDescription(b.description);
  const writeMode = b.write_mode == null ? 'staff' : checkWriteMode(b.write_mode);
  const maxValueBytes = b.max_value_bytes == null ? LIMITS.max_value_bytes.def : checkLimit('max_value_bytes', b.max_value_bytes);
  const maxKeys = b.max_keys == null ? LIMITS.max_keys.def : checkLimit('max_keys', b.max_keys);
  const uid = userIdOf(auth);
  if (uid == null) throw new SharedError(403, 'Creating a namespace needs a signed-in staff user');
  try {
    await db.query(
      'INSERT INTO shared_namespaces (ns, description, write_mode, max_value_bytes, max_keys, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [ns, description, writeMode, maxValueBytes, maxKeys, uid]);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') throw new SharedError(409, `Namespace "${ns}" already exists`, { code: 'exists' });
    throw err;
  }
  return nsOut(await loadNs(db, ns));
}

async function updateNamespace(db, ns, body, auth) {
  checkName('ns', ns);
  const b = body || {};
  const sets = [];
  const params = [];
  if (b.description !== undefined) { sets.push('description = ?'); params.push(checkDescription(b.description)); }
  if (b.write_mode !== undefined) { sets.push('write_mode = ?'); params.push(checkWriteMode(b.write_mode)); }
  for (const name of ['max_value_bytes', 'max_keys']) {
    if (b[name] !== undefined) { sets.push(`${name} = ?`); params.push(checkLimit(name, b[name])); }
  }
  if (!sets.length) throw new SharedError(400, 'Nothing to change: send description, write_mode, max_value_bytes or max_keys');
  const row = await loadNs(db, ns);
  if (!mayManage(row, auth)) throw new SharedError(403, `Only the creator of "${ns}" (or an admin) may change it`);
  await db.query(`UPDATE shared_namespaces SET ${sets.join(', ')} WHERE ns = ?`, [...params, ns]);
  return nsOut(await loadNs(db, ns));
}

async function deleteNamespace(db, ns, auth) {
  checkName('ns', ns);
  return db.withTransaction(async (conn) => {
    const row = await loadNs(conn, ns, { lock: true });
    if (!mayManage(row, auth)) throw new SharedError(403, `Only the creator of "${ns}" (or an admin) may delete it`);
    // The FK cascades; deleting the values first keeps the count honest
    // without relying on it.
    const [dv] = await conn.query('DELETE FROM shared_values WHERE ns = ?', [ns]);
    await conn.query('DELETE FROM shared_namespaces WHERE ns = ?', [ns]);
    return { ns, values_deleted: dv.affectedRows };
  }, { retries: 1 });
}

// ── values ──────────────────────────────────────────────────────────────────

async function listValues(db, ns, { limit, after } = {}) {
  checkName('ns', ns);
  let n = LIST_DEFAULT;
  if (limit !== undefined) {
    const s = String(limit);
    if (!/^[0-9]{1,4}$/.test(s) || Number(s) < 1 || Number(s) > LIST_MAX) {
      throw new SharedError(400, `limit must be an integer from 1 to ${LIST_MAX}`);
    }
    n = Number(s);
  }
  if (after !== undefined) checkName('after', after);
  const nsRow = await loadNs(db, ns);
  // The byte budget: at most PAGE_BYTES of values, whatever the limit asked.
  const fit = Math.max(1, Math.floor(PAGE_BYTES / Math.max(1, Number(nsRow.max_value_bytes))));
  const size = Math.min(n, fit);
  const [rows] = await db.query(
    `SELECT ${V_COLS} FROM shared_values WHERE ns = ?${after !== undefined ? ' AND k > ?' : ''} ORDER BY k LIMIT ${size + 1}`,
    after !== undefined ? [ns, after] : [ns]);
  const more = rows.length > size;
  const values = rows.slice(0, size).map(vOut);
  return { namespace: nsOut(nsRow), values, next: more ? values[values.length - 1].k : null, limit: size, trimmed: size < n };
}

async function getValue(db, ns, k) {
  checkName('ns', ns);
  checkName('k', k);
  await loadNs(db, ns);
  const row = await loadValue(db, ns, k);
  if (!row) throw new SharedError(404, `No key "${k}" in "${ns}"`);
  return vOut(row);
}

/**
 * Compare-and-set write.
 *   rev null → create; 409 { code:'exists', current } when the key exists.
 *   rev n    → update when the stored rev is n; 409 { code:'rev_conflict',
 *              current } when it moved (current null: the key is gone).
 */
async function putValue(db, ns, k, body, auth) {
  checkName('ns', ns);
  checkName('k', k);
  const b = body || {};
  if (typeof b.v !== 'string') throw new SharedError(400, 'v must be a string (JSON-stringify structured values client-side)');
  const rev = checkRev(b.rev);
  const uid = userIdOf(auth);
  const act = actIdOf(auth);

  return db.withTransaction(async (conn) => {
    // A create locks the namespace row: max_keys is counted and enforced
    // under it, so two creators cannot both take the last slot.
    const nsRow = await loadNs(conn, ns, { lock: rev === null });
    const refusal = writeRefusal(nsRow, k, auth);
    if (refusal) throw new SharedError(403, refusal);
    const bytes = Buffer.byteLength(b.v, 'utf8');
    if (bytes > Number(nsRow.max_value_bytes)) {
      throw new SharedError(413, `The value is ${bytes} bytes; "${ns}" allows at most ${nsRow.max_value_bytes}`);
    }

    if (rev === null) {
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM shared_values WHERE ns = ?', [ns]);
      if (Number(n) >= Number(nsRow.max_keys)) {
        // An existing key is a conflict, not "full": say which.
        const cur = await loadValueLatest(conn, ns, k);
        if (cur) throw new SharedError(409, `"${k}" already exists in "${ns}"`, { code: 'exists', current: vOut(cur) });
        throw new SharedError(409, `"${ns}" is full (${nsRow.max_keys} keys)`, { code: 'full' });
      }
      try {
        await conn.query(
          'INSERT INTO shared_values (ns, k, v, rev, updated_by, updated_act) VALUES (?, ?, ?, 1, ?, ?)',
          [ns, k, b.v, uid, act]);
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
          const cur = await loadValueLatest(conn, ns, k);
          throw new SharedError(409, `"${k}" already exists in "${ns}"`, { code: 'exists', current: cur ? vOut(cur) : null });
        }
        throw err;
      }
    } else {
      const [r] = await conn.query(
        'UPDATE shared_values SET v = ?, rev = rev + 1, updated_by = ?, updated_act = ? WHERE ns = ? AND k = ? AND rev = ?',
        [b.v, uid, act, ns, k, rev]);
      if (r.affectedRows !== 1) {
        const cur = await loadValueLatest(conn, ns, k);
        throw new SharedError(409, cur
          ? `"${k}" changed since you read it (rev ${cur.rev}, you sent ${rev}) — re-read and try again`
          : `"${k}" no longer exists in "${ns}" — create it again with rev null`,
        { code: 'rev_conflict', current: cur ? vOut(cur) : null });
      }
    }
    return vOut(await loadValue(conn, ns, k));
  }, { retries: 1 });
}

/** Delete one key — the write rule applies; rev (optional) makes it compare-and-delete. */
async function deleteValue(db, ns, k, rawRev, auth) {
  checkName('ns', ns);
  checkName('k', k);
  let rev;
  if (rawRev !== undefined) {
    const s = String(rawRev);
    if (!/^[1-9][0-9]{0,9}$/.test(s)) throw new SharedError(400, 'rev must be a positive integer');
    rev = checkRev(Number(s));
  }
  return db.withTransaction(async (conn) => {
    const nsRow = await loadNs(conn, ns);
    const refusal = writeRefusal(nsRow, k, auth);
    if (refusal) throw new SharedError(403, refusal);
    const [r] = await conn.query(
      `DELETE FROM shared_values WHERE ns = ? AND k = ?${rev !== undefined ? ' AND rev = ?' : ''}`,
      rev !== undefined ? [ns, k, rev] : [ns, k]);
    if (r.affectedRows === 1) return { ns, k, deleted: true };
    const cur = await loadValueLatest(conn, ns, k);
    if (!cur) throw new SharedError(404, `No key "${k}" in "${ns}"`);
    throw new SharedError(409, `"${k}" changed since you read it (rev ${cur.rev}, you sent ${rev})`,
      { code: 'rev_conflict', current: vOut(cur) });
  }, { retries: 1 });
}

module.exports = {
  NAME_RE, WRITE_MODES, LIMITS, LIST_MAX, PAGE_BYTES, SharedError,
  userIdOf, actIdOf, mayManage, writeRefusal,
  listNamespaces, getNamespace, createNamespace, updateNamespace, deleteNamespace,
  listValues, getValue, putValue, deleteValue,
};
