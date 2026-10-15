// services/uiConfigService.js
//
/**
 * ui_config — read + write (ui-customization arc S3.1; PLAN §6–§8).
 * Table DDL + landmines: ref/migrations/2026-10-16_ui_custom_s31_ui_config.sql
 * (the column COMMENTs). Document grammar: lib/uiConfigShape.js.
 *
 *   readFor(db, userId) → { firm: { <config_key>: config }, user: { … } }
 *     ONE query. user is {} unless userId is an integer (a staff JWT user).
 *     Used by GET /api/ui-config AND /api/firm-data's `ui` (the boot path,
 *     where the caller makes it fail-soft). A stored config that is not a
 *     JSON object is skipped (the client re-validates what it acts on).
 *
 *   write(db, body, auth) → { scope, config_key, config, changed, versioned
 *                             [, version_id — firm scope: the newest version id after the write] }
 *     body = the PUT body (validated + normalized by validateWrite; 400 on any
 *     error, err.errors listing them). auth = the caller's req.auth (a staff
 *     JWT). The row is the firm row (user_id 0) or the CALLER's row
 *     (user_id = auth.userId) — never anyone else's.
 *     Firm writes are re-checked HERE against the VALIDATED scope with the
 *     same lib/capabilities can() requireAuth uses (403 without
 *     firm.settings) — defence in depth behind the route's gateByScope, which
 *     picks its gate from the RAW body.scope. The two must never disagree, and
 *     the scope column folds case and trailing spaces ('FIRM', 'firm ' are
 *     stored as 'firm'), so a validator that ever got lenient about scope
 *     must still not let a plain staff caller reach the firm row.
 *     One withTransaction(retries:1) span — pure DB:
 *       SELECT … FOR UPDATE the current row
 *       unchanged (key-order-insensitive: lib/uiConfigShape canonical) → no write
 *       else INSERT … ON DUPLICATE KEY UPDATE by uq_ui_config_scope
 *            + (scope firm) append ui_config_versions with the NEW document.
 *     A first-ever save racing another for the same row can deadlock on the
 *     gap locks; that attempt is retried once (still pure DB).
 *     OPTIMISTIC CONCURRENCY (S3.2): a firm body may carry `base` — the
 *     newest version id its editor loaded (null: no firm row then). Inside
 *     the FOR UPDATE span it is compared with the row's newest version id;
 *     a mismatch is a 409 (CONFLICT_MSG) and nothing is written — two admins
 *     never silently overwrite each other. `base` is optional: absent, there
 *     is no check (the S3.1 PUT contract is unchanged). User rows carry none.
 *
 * Firm editor reads (ui-custom S3.2 — the Firm tab, public/caseconfig/firm.html).
 * The ROUTES gate all of these on firm.settings; restoreVersion is also
 * re-checked by write() itself.
 *
 *   listVersions(db, configKey) → [{ id, saved_by, saved_by_name, saved_at,
 *       size, is_current }] newest first (≤ VERSIONS_MAX), for the FIRM row of
 *     configKey only. size = characters of the stored JSON. is_current = the
 *     version's document equals the current row's (MySQL JSON equality —
 *     key-order-insensitive), mapped to a boolean.
 *   getVersion(db, id) → { id, config_key, config, saved_by, saved_by_name,
 *       saved_at } or null — a version of a FIRM row only.
 *   firmVersionIds(db) → { <firm config_key>: newest version id | null } — the
 *     `base` an editor sends back (GET /api/ui-config, firm.settings holders).
 *   restoreVersion(db, id, auth, base) → write()'s result + { restored_from: id }.
 *     base as for a PUT (optional; a stale one → 409). The document goes back
 *     into the version's PARENT row's config_key; a version row whose own
 *     config_key disagrees with its parent's is refused (400).
 *     The version's document goes back through write() — the SAME path as a
 *     PUT: validation, the firm.settings re-check, the unchanged test (a
 *     restore of the current document appends no version row) and the
 *     version append. A version the validator now refuses (the rules
 *     tightened after it was saved) is a 400 listing the errors; nothing is
 *     written. 404 when the version is not a firm row's.
 *   pickers(db) → { tools: [{ key, title }], views: [{ key, title }] }
 *     tools = LIVE rows of `tools` (keys and titles only — never html);
 *     views = active report_definitions of kind 'view' by report_key. Keys the
 *     firm-item grammar would refuse are left out. Firm admins are not SU, so
 *     GET /api/tools (SU + step-up) is closed to them: this is the lean read.
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');
const shape = require('../lib/uiConfigShape');
const { can } = require('../lib/capabilities');
const { TOOL_KEY_RE } = require('../routes/api.tools');   // reused, never copied

const READ_SQL =
  'SELECT scope, config_key, config FROM ui_config ' +
  "WHERE role = '' AND ((scope = 'firm' AND user_id = 0) OR (scope = 'user' AND user_id = ?))";

function parseConfig(v) {
  let x = v;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch (_) { return null; }
  }
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x : null;
}

function userIdOf(userId) {
  const n = Number(userId);
  return userId != null && userId !== '' && Number.isInteger(n) && n >= -128 && n <= 127 ? n : null;
}

async function readFor(db, userId) {
  const uid = userIdOf(userId);
  // No user → the user branch matches nothing (NULL never equals a column).
  const [rows] = await db.query(READ_SQL, [uid]);
  const out = { firm: {}, user: {} };
  for (const r of rows) {
    const c = parseConfig(r.config);
    if (c && (r.scope === 'firm' || r.scope === 'user')) out[r.scope][r.config_key] = c;
  }
  return out;
}

function inputError(message, errors, status = 400) {
  const e = new Error(message);
  e.status = status;
  if (errors) e.errors = errors;
  return e;
}

const CONFLICT_MSG = 'The firm launcher was changed since you loaded it — reload to see the change';

async function write(db, body, auth) {
  const r = shape.validateWrite(body);
  if (!r.ok) throw inputError(r.errors[0], r.errors);
  const { scope, config_key: key, config, base } = r.value;
  const actor = auth && auth.type === 'jwt' ? userIdOf(auth.userId) : null;
  if (actor == null) throw inputError('a ui_config write needs a staff user', null, 403);
  if (scope === 'firm' && !can(auth, 'firm.settings')) throw inputError('Forbidden', null, 403);
  const rowUser = scope === 'firm' ? 0 : actor;

  const span = () => withTransaction(db, async (conn) => {
    const [[cur]] = await conn.query(
      "SELECT id, config FROM ui_config WHERE scope = ? AND user_id = ? AND role = '' AND config_key = ? FOR UPDATE",
      [scope, rowUser, key]);
    let head = null;                         // the firm row's newest version id (under its lock)
    if (scope === 'firm' && cur) {
      const [[h]] = await conn.query('SELECT MAX(id) AS id FROM ui_config_versions WHERE ui_config_id = ?', [cur.id]);
      head = h && h.id != null ? Number(h.id) : null;
    }
    if (scope === 'firm' && base !== undefined && base !== head) throw inputError(CONFLICT_MSG, null, 409);
    if (cur && shape.canonical(parseConfig(cur.config)) === shape.canonical(config)) {
      return scope === 'firm' ? { changed: false, versioned: false, version_id: head } : { changed: false, versioned: false };
    }
    const json = JSON.stringify(config);
    const [ins] = await conn.query(
      "INSERT INTO ui_config (scope, user_id, role, config_key, config, updated_by) VALUES (?, ?, '', ?, ?, ?) AS n " +
      'ON DUPLICATE KEY UPDATE config = n.config, updated_by = n.updated_by, id = LAST_INSERT_ID(ui_config.id)',
      [scope, rowUser, key, json, actor]);
    if (scope !== 'firm') return { changed: true, versioned: false };
    const [vins] = await conn.query(
      'INSERT INTO ui_config_versions (ui_config_id, config_key, config, saved_by) VALUES (?, ?, ?, ?)',
      [ins.insertId, key, json, actor]);
    return { changed: true, versioned: true, version_id: vins.insertId };
  }, { retries: 1 });

  let res;
  try {
    res = await span();
  } catch (err) {
    if (!err || err.code !== 'ER_LOCK_DEADLOCK') throw err;
    res = await span();
  }
  return { scope, config_key: key, config, ...res };
}

// ── Firm editor reads (S3.2) ────────────────────────────────────────────────
const VERSIONS_MAX = 200;
// The firm row of a config_key: the only rows that are ever versioned.
const FIRM_ROW = "c.scope = 'firm' AND c.user_id = 0 AND c.role = ''";

function versionIdOf(id) {
  const s = String(id == null ? '' : id);
  if (!/^[1-9][0-9]{0,9}$/.test(s) || Number(s) > 4294967295) throw inputError('version id must be a positive integer');
  return Number(s);
}

async function listVersions(db, configKey) {
  if (!shape.CONFIG_KEYS.firm.includes(configKey)) {
    throw inputError(`config_key must be one of: ${shape.CONFIG_KEYS.firm.join(', ')}`);
  }
  const [rows] = await db.query(
    'SELECT v.id, v.saved_by, u.user_name AS saved_by_name, v.saved_at, ' +
    'CHAR_LENGTH(CAST(v.config AS CHAR)) AS size, (v.config = c.config) AS is_current ' +
    'FROM ui_config_versions v JOIN ui_config c ON c.id = v.ui_config_id ' +
    'LEFT JOIN users u ON u.user = v.saved_by ' +
    `WHERE ${FIRM_ROW} AND c.config_key = ? ORDER BY v.id DESC LIMIT ${VERSIONS_MAX}`,
    [configKey]);
  // (x = y) reaches JS from mysql2 as 1/0 — never compare it to false.
  return rows.map((r) => ({
    id: r.id, saved_by: r.saved_by, saved_by_name: r.saved_by_name == null ? null : r.saved_by_name,
    saved_at: r.saved_at, size: Number(r.size), is_current: !!Number(r.is_current),
  }));
}

async function getVersion(db, id) {
  const vid = versionIdOf(id);
  const [[r]] = await db.query(
    'SELECT v.id, v.config_key, c.config_key AS row_config_key, v.config, v.saved_by, u.user_name AS saved_by_name, v.saved_at ' +
    'FROM ui_config_versions v JOIN ui_config c ON c.id = v.ui_config_id ' +
    'LEFT JOIN users u ON u.user = v.saved_by ' +
    `WHERE v.id = ? AND ${FIRM_ROW}`,
    [vid]);
  if (!r) return null;
  return {
    id: r.id, config_key: r.config_key, row_config_key: r.row_config_key, config: parseConfig(r.config), saved_by: r.saved_by,
    saved_by_name: r.saved_by_name == null ? null : r.saved_by_name, saved_at: r.saved_at,
  };
}

async function restoreVersion(db, id, auth, base) {
  const v = await getVersion(db, id);
  if (!v) throw inputError('Version not found', null, 404);
  if (!v.config) throw inputError(`version ${v.id} holds no readable document`, null, 400);
  // Bound to its row: the document goes back into the PARENT row's key.
  if (v.config_key !== v.row_config_key) throw inputError(`version ${v.id} does not match its row's config_key`, null, 400);
  // The document against today's rules first, so its refusal says so; any
  // other 400 (a bad base) comes from write() as it is.
  const doc = shape.validate('firm', v.row_config_key, v.config);
  if (!doc.ok) throw inputError(`version ${v.id} no longer passes today's rules, so it was not restored`, doc.errors);
  const body = { scope: 'firm', config_key: v.row_config_key, config: v.config };
  if (base !== undefined) body.base = base;
  return { ...(await write(db, body, auth)), restored_from: v.id };
}

async function firmVersionIds(db) {
  const [rows] = await db.query(
    'SELECT c.config_key, (SELECT MAX(v.id) FROM ui_config_versions v WHERE v.ui_config_id = c.id) AS version_id ' +
    `FROM ui_config c WHERE ${FIRM_ROW}`);
  const out = {};
  for (const k of shape.CONFIG_KEYS.firm) out[k] = null;
  for (const r of rows) {
    if (shape.CONFIG_KEYS.firm.includes(r.config_key) && r.version_id != null) out[r.config_key] = Number(r.version_id);
  }
  return out;
}

async function pickers(db) {
  const [tools] = await db.query(
    "SELECT tool_key, title FROM tools WHERE status = 'live' ORDER BY COALESCE(NULLIF(TRIM(title), ''), tool_key), tool_key");
  const [views] = await db.query(
    "SELECT report_key, title FROM report_definitions WHERE kind = 'view' AND is_active = 1 ORDER BY COALESCE(NULLIF(TRIM(title), ''), report_key), report_key");
  const title = (t, k) => (typeof t === 'string' && t.trim() ? t.trim() : k);
  return {
    tools: tools.filter((t) => typeof t.tool_key === 'string' && TOOL_KEY_RE.test(t.tool_key))
      .map((t) => ({ key: t.tool_key, title: title(t.title, t.tool_key) })),
    views: views.filter((v) => typeof v.report_key === 'string' && shape.VIEW_KEY_RE.test(v.report_key))
      .map((v) => ({ key: v.report_key, title: title(v.title, v.report_key) })),
  };
}

module.exports = { readFor, write, READ_SQL, listVersions, getVersion, restoreVersion, firmVersionIds, pickers, VERSIONS_MAX, CONFLICT_MSG };
