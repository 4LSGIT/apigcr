// services/ingestRuleChangeLog.js
//
/**
 * Ingest rules — the edit stamp, the append-only change log, and the
 * stale-edit precondition (A20 slice 1, Fred's go 2026-10-27). Shared by
 * services/emailIngestRuleService.js and services/phoneIngestRuleService.js,
 * whose CRUD is line-identical with the tables swapped.
 *
 * WHY: a rule edit is live on save, with no draft and no versioning (AI_CONTEXT
 * §26-28). `updated_at` cannot say "last edited": every MATCH bumps
 * match_count / last_matched_at with an UPDATE, and ON UPDATE CURRENT_TIMESTAMP
 * moves it — while an action write never touched the rule row at all. So:
 *
 *   definition_updated_at  the EDIT STAMP. Moved only here, by a real
 *                          definition change (the rule's own fields or any of
 *                          its action rows), inside the edit's transaction.
 *                          Never by the match bump. Strictly increasing per
 *                          rule: GREATEST(now, previous + 1 ms), so two edits
 *                          in one millisecond (or a clock step back) still
 *                          give the precondition two different values.
 *   <channel>_ingest_rule_changes
 *                          append-only: one row per real change — the rule AND
 *                          its action rows, before and after, with the actor.
 *                          The review diff and the manual revert path. The app
 *                          never UPDATEs or DELETEs it (tests/ingestRuleChangeLog
 *                          .test.js greps for one).
 *   expected_base          { definition_updated_at } — P11's shape
 *                          (routes/workflows.js checkExpectedBase). Optional
 *                          for native callers; checked under the rule's
 *                          FOR UPDATE lock, before anything is written; a
 *                          mismatch is a structured 409 and nothing is written.
 *
 * A save that changes nothing (the editor re-sending the stored values) moves
 * no stamp and writes no log row — the comparison is of the stored rows read
 * back from MySQL, before vs after, so JSON key order cannot fake a change.
 *
 * LOCK ORDER (every writer): the parent rule row FOR UPDATE first, then its
 * action rows. The match bump touches rule rows only; the readers do
 * non-locking reads. No cycle.
 *
 * SECRETS: a rule row holds none (email_ingest_sources — the live ingest keys —
 * is a different table and is never read here). An `http` action's URL and
 * literal header VALUES are secret-shaped (CLAUDE.md: webhook URLs are
 * secrets), so the LOG copy redacts them (host kept, header names kept) —
 * otherwise a rotated literal would live on in the log after the action row
 * moved on. The change comparison uses the unredacted rows.
 */

'use strict';

const crypto = require('crypto');

const CHANNELS = {
  email: { rules: 'email_ingest_rules', actions: 'email_ingest_rule_actions', changes: 'email_ingest_rule_changes' },
  phone: { rules: 'phone_ingest_rules', actions: 'phone_ingest_rule_actions', changes: 'phone_ingest_rule_changes' },
};

// The change_kind vocabulary. App-validated (sql_mode is relaxed, so an ENUM
// would silently store '' for a bad value rather than refuse it).
const KINDS = new Set([
  'create', 'update', 'activate', 'deactivate', 'delete', 'duplicate',
  'action_add', 'action_update', 'action_delete',
]);

// Per-side snapshot cap, in bytes of JSON text. The largest live rule body is
// ~12 KB (email transform_config, 2026-10-27); 256 KB is ~20x that. Over the
// cap the side is stored as a marker (size + sha256) and the edit still goes
// through — the log must never be the reason an edit fails.
const SNAPSHOT_CAP_BYTES = 256 * 1024;

// The rule fields that ARE the definition. match_count / last_matched_at /
// updated_at are pipeline noise; last_modified_by / created_at /
// definition_updated_at are carried in the snapshot but are not "a change".
const RULE_DEF_FIELDS = ['name', 'description', 'active', 'position', 'match_mode', 'match_config',
  'transform_mode', 'transform_config'];
const ACTION_FIELDS = ['id', 'name', 'position', 'active', 'action_type', 'config'];

class StaleDefinitionError extends Error {
  constructor(conflict) {
    super('stale_definition');
    this.name = 'StaleDefinitionError';
    this.conflict = conflict;
  }
}

// ─────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────

/**
 * Run fn(conn) in a transaction. The app pool carries withTransaction
 * (startup/db.js); a bare mysql2 pool (scripts, the gated real-engine suites)
 * goes through lib/withTransaction directly. Pure-DB span → the default one
 * retry on a transient pre-commit failure is safe (CLAUDE.md).
 */
function tx(db, fn) {
  if (typeof db.withTransaction === 'function') return db.withTransaction(fn);
  return require('../lib/withTransaction').withTransaction(db, fn);
}

// ─────────────────────────────────────────────────────────────
// Actor
// ─────────────────────────────────────────────────────────────

/**
 * Who made the change, from req.auth. A staff JWT → its user id + username
 * (a view-as token keeps the TARGET as the user, like every app-level
 * attribution, and names the real actor in the label). An API key → its key
 * id + label (the internal key has no id). Never throws.
 */
function actorFromAuth(auth) {
  const a = auth || {};
  if (a.type === 'jwt') {
    const uid = Number(a.userId);
    let label = typeof a.username === 'string' ? a.username : null;
    if (a.impersonator && a.impersonator.username) {
      label = `${label || `user ${a.userId}`} (view-as by ${a.impersonator.username})`;
    }
    return { user_id: Number.isInteger(uid) ? uid : null, key_id: null, label: label ? label.slice(0, 255) : null };
  }
  if (a.type === 'api_key') {
    const kid = Number(a.key_id);
    return {
      user_id: null,
      key_id: Number.isInteger(kid) ? kid : null,
      label: `api_key:${a.key_label || 'unknown'}`.slice(0, 255),
    };
  }
  return { user_id: null, key_id: null, label: null };
}

/** The actor for a service call: opts.actor if the route passed one, else the bare user id. */
function resolveActor(opts, userId) {
  if (opts && opts.actor) return opts.actor;
  const uid = Number(userId);
  return { user_id: userId != null && Number.isInteger(uid) ? uid : null, key_id: null, label: null };
}

// ─────────────────────────────────────────────────────────────
// expected_base (P11 shape)
// ─────────────────────────────────────────────────────────────

const EXPECTED_BASE_KEYS = new Set(['definition_updated_at']);
// A full ISO-8601 instant with an explicit zone — the shape GET returns. A
// zone-less string would be parsed in the server's local time.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** null when the shape is good; the 400 message when it is not. */
function expectedBaseShapeError(eb) {
  if (eb == null || typeof eb !== 'object' || Array.isArray(eb)) return 'expected_base must be a JSON object';
  const unknown = Object.keys(eb).filter((k) => !EXPECTED_BASE_KEYS.has(k));
  if (unknown.length) return `expected_base has unknown keys: ${unknown.join(', ')}`;
  const v = eb.definition_updated_at;
  if (typeof v !== 'string' || !ISO_INSTANT.test(v) || !Number.isFinite(Date.parse(v))) {
    return 'expected_base.definition_updated_at must be the rule\'s definition_updated_at as read (an ISO-8601 instant, e.g. 2026-10-27T14:05:00.123Z)';
  }
  return null;
}

function _iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(v);
}

/**
 * Throws StaleDefinitionError when `expectedBase` is present and the LOCKED
 * row's stamp differs. `locked` is the row lockRule returned (inside the
 * transaction, under FOR UPDATE — the stamp cannot move before the write).
 */
function assertExpectedBase(locked, expectedBase) {
  if (expectedBase === undefined) return;
  const actual = _iso(locked.definition_updated_at);
  const want = Date.parse(expectedBase.definition_updated_at);
  const have = locked.definition_updated_at == null ? NaN : new Date(locked.definition_updated_at).getTime();
  if (want !== have) {
    throw new StaleDefinitionError({
      changed: 'definition_updated_at',
      expected: expectedBase.definition_updated_at,
      actual,
    });
  }
}

/** The 409 body (mirrors routes/workflows.js checkExpectedBase). */
function conflictBody(err) {
  return {
    error: 'The ingest rule changed since this edit was prepared — re-read it and rebuild the change against the current rule',
    conflict: err.conflict,
  };
}

// ─────────────────────────────────────────────────────────────
// Reads on the transaction's connection
// ─────────────────────────────────────────────────────────────

/** Lock the rule row; returns { id, definition_updated_at } or null. */
async function lockRule(conn, t, ruleId) {
  const [[row]] = await conn.query(
    `SELECT id, definition_updated_at FROM ${t.rules} WHERE id = ? FOR UPDATE`,
    [ruleId]
  );
  return row || null;
}

/** Move the edit stamp. Never moves updated_at (assigned to itself). */
async function bumpStamp(conn, t, ruleId) {
  await conn.query(
    `UPDATE ${t.rules}
        SET definition_updated_at = GREATEST(CURRENT_TIMESTAMP(3), definition_updated_at + INTERVAL 1000 MICROSECOND),
            updated_at = updated_at
      WHERE id = ?`,
    [ruleId]
  );
}

// ─────────────────────────────────────────────────────────────
// Snapshots + comparison
// ─────────────────────────────────────────────────────────────

function _sortKeys(v) {
  if (Array.isArray(v)) return v.map(_sortKeys);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = _sortKeys(v[k]);
    return out;
  }
  return v;
}
const _canon = (v) => JSON.stringify(_sortKeys(v === undefined ? null : v));

/**
 * The definition snapshot of a getById-shaped rule (rule + actions), or null.
 * Pipeline columns are dropped; action rows are ordered by id so a pure
 * reorder still shows up as a position change, not as a reshuffle.
 */
function snapshotOf(rule) {
  if (!rule) return null;
  const r = {
    id: Number(rule.id),
    name: rule.name,
    description: rule.description ?? null,
    active: rule.active == null ? null : Number(rule.active),
    position: rule.position == null ? null : Number(rule.position),
    match_mode: rule.match_mode,
    match_config: rule.match_config ?? null,
    transform_mode: rule.transform_mode,
    transform_config: rule.transform_config ?? null,
    last_modified_by: rule.last_modified_by ?? null,
    created_at: _iso(rule.created_at),
    definition_updated_at: _iso(rule.definition_updated_at),
  };
  const actions = (rule.actions || [])
    .map((a) => ({
      id: Number(a.id),
      name: a.name ?? null,
      position: a.position == null ? null : Number(a.position),
      active: a.active == null ? null : Number(a.active),
      action_type: a.action_type,
      config: a.config ?? null,
    }))
    .sort((x, y) => x.id - y.id);
  return { rule: r, actions };
}

/** Did the DEFINITION change between two snapshots? (ignores stamp / actor / created_at) */
function definitionChanged(before, after) {
  const def = (s) => s && {
    rule: Object.fromEntries(RULE_DEF_FIELDS.map((k) => [k, s.rule[k]])),
    actions: s.actions.map((a) => Object.fromEntries(ACTION_FIELDS.map((k) => [k, a[k]]))),
  };
  return _canon(def(before)) !== _canon(def(after));
}

/** The rule kind for an update: activate / deactivate when `active` is ALL that changed. */
function updateKind(before, after) {
  const others = RULE_DEF_FIELDS.filter((k) => k !== 'active');
  const sameOthers = others.every((k) => _canon(before.rule[k]) === _canon(after.rule[k]))
    && _canon(before.actions) === _canon(after.actions);
  if (sameOthers && before.rule.active !== after.rule.active) {
    return after.rule.active ? 'activate' : 'deactivate';
  }
  return 'update';
}

function _redactUrl(url) {
  let host = null;
  try { host = new URL(String(url)).host || null; } catch (_) { host = null; }
  return host ? `[redacted — host ${host}]` : '[redacted]';
}

/** The LOG copy of a snapshot: http URL + literal header values redacted. */
function redactForLog(snap) {
  if (!snap) return null;
  const actions = snap.actions.map((a) => {
    if (a.action_type !== 'http' || !a.config || typeof a.config !== 'object' || Array.isArray(a.config)) return a;
    const cfg = { ...a.config };
    if (cfg.url != null) cfg.url = _redactUrl(cfg.url);
    if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
      cfg.headers = Object.fromEntries(Object.keys(cfg.headers).map((k) => [k, '[redacted]']));
    }
    return { ...a, config: cfg };
  });
  return { ...snap, actions };
}

/** JSON text for one side, capped. */
function sideJson(snap) {
  if (!snap) return null;
  const text = JSON.stringify(redactForLog(snap));
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= SNAPSHOT_CAP_BYTES) return text;
  return JSON.stringify({
    _omitted: 'snapshot_too_large',
    bytes,
    cap: SNAPSHOT_CAP_BYTES,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    rule: { id: snap.rule.id, name: snap.rule.name },
  });
}

/** Append one change row. */
async function insertChange(conn, t, { ruleId, kind, actionId = null, duplicatedFrom = null, actor, stamp, before, after }) {
  if (!KINDS.has(kind)) throw new Error(`ingestRuleChangeLog: unknown change kind '${kind}'`);
  const a = actor || { user_id: null, key_id: null, label: null };
  await conn.query(
    `INSERT INTO ${t.changes}
       (rule_id, change_kind, action_id, duplicated_from_rule_id, actor_user_id, actor_key_id, actor_label,
        definition_updated_at, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(ruleId), kind, actionId == null ? null : Number(actionId), duplicatedFrom == null ? null : Number(duplicatedFrom),
      a.user_id ?? null, a.key_id ?? null, a.label ?? null,
      stamp == null ? null : (stamp instanceof Date ? stamp : new Date(stamp)),
      sideJson(before), sideJson(after)]
  );
}

/**
 * After an edit's write, inside its transaction: when the definition really
 * changed, move the stamp and append the change row. `getRule(conn)` re-reads
 * the rule (getById shape) on the transaction's connection. Returns the
 * final getById row (with the new stamp), or `afterRow` unchanged when
 * nothing changed.
 *
 *   kind: a fixed kind, or 'update' (→ activate/deactivate when only `active`
 *         moved).
 *   stampAlready: true for create / duplicate — the INSERT's column default
 *         IS the stamp; no bump.
 */
async function recordChange(conn, t, { ruleId, kind, actionId = null, duplicatedFrom = null, actor, beforeRow, afterRow,
  getRule, stampAlready = false }) {
  const before = snapshotOf(beforeRow);
  const after0 = snapshotOf(afterRow);
  if (before && after0 && !definitionChanged(before, after0)) return afterRow;
  let finalRow = afterRow;
  if (afterRow && !stampAlready) {
    await bumpStamp(conn, t, ruleId);
    finalRow = await getRule(conn);
  }
  const after = snapshotOf(finalRow);
  const effectiveKind = (kind === 'update' && before && after) ? updateKind(before, after) : kind;
  await insertChange(conn, t, {
    ruleId, kind: effectiveKind, actionId, duplicatedFrom, actor,
    stamp: finalRow ? finalRow.definition_updated_at : null,
    before, after,
  });
  return finalRow;
}

module.exports = {
  CHANNELS,
  KINDS,
  SNAPSHOT_CAP_BYTES,
  StaleDefinitionError,
  tx,
  actorFromAuth,
  resolveActor,
  expectedBaseShapeError,
  assertExpectedBase,
  conflictBody,
  lockRule,
  bumpStamp,
  snapshotOf,
  definitionChanged,
  updateKind,
  redactForLog,
  sideJson,
  insertChange,
  recordChange,
};
