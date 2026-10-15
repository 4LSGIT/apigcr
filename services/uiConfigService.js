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
 *   write(db, body, auth) → { scope, config_key, config, changed, versioned }
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
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');
const shape = require('../lib/uiConfigShape');
const { can } = require('../lib/capabilities');

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

async function write(db, body, auth) {
  const r = shape.validateWrite(body);
  if (!r.ok) throw inputError(r.errors[0], r.errors);
  const { scope, config_key: key, config } = r.value;
  const actor = auth && auth.type === 'jwt' ? userIdOf(auth.userId) : null;
  if (actor == null) throw inputError('a ui_config write needs a staff user', null, 403);
  if (scope === 'firm' && !can(auth, 'firm.settings')) throw inputError('Forbidden', null, 403);
  const rowUser = scope === 'firm' ? 0 : actor;

  const span = () => withTransaction(db, async (conn) => {
    const [[cur]] = await conn.query(
      "SELECT id, config FROM ui_config WHERE scope = ? AND user_id = ? AND role = '' AND config_key = ? FOR UPDATE",
      [scope, rowUser, key]);
    if (cur && shape.canonical(parseConfig(cur.config)) === shape.canonical(config)) {
      return { changed: false, versioned: false };
    }
    const json = JSON.stringify(config);
    const [ins] = await conn.query(
      "INSERT INTO ui_config (scope, user_id, role, config_key, config, updated_by) VALUES (?, ?, '', ?, ?, ?) AS n " +
      'ON DUPLICATE KEY UPDATE config = n.config, updated_by = n.updated_by, id = LAST_INSERT_ID(ui_config.id)',
      [scope, rowUser, key, json, actor]);
    if (scope !== 'firm') return { changed: true, versioned: false };
    await conn.query(
      'INSERT INTO ui_config_versions (ui_config_id, config_key, config, saved_by) VALUES (?, ?, ?, ?)',
      [ins.insertId, key, json, actor]);
    return { changed: true, versioned: true };
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

module.exports = { readFor, write, READ_SQL };
