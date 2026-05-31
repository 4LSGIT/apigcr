// services/phoneIngestSuppressionService.js
//
/**
 * Phone Ingest — Layer 2 Logging Suppression Service
 * services/phoneIngestSuppressionService.js
 *
 * Stage 1 (phone_log quick win). Port of emailIngestSuppressionService.js.
 *
 * Evaluates active rows in `phone_log_suppressions` against the phone event
 * (the params object create_log/phone_log receives from the workflow step).
 * If ANY rule matches, the default user-facing `log` row is suppressed —
 * phone_log skips createLogEntry. The forensic `phone_event_log` row is still
 * written by phone_log and is NOT affected by this layer.
 *
 * Pipeline position (set by lib/internal_functions.js → phone_log):
 *   write phone_event_log → evaluateSuppressions(db, event) → createLogEntry
 *
 * Unlike email (where suppression sits inside one ingest method before any
 * side effects), phone suppression runs mid-workflow: the workflow's
 * downstream steps (find_contact / cancel_sequences) run regardless of the
 * suppression result. Suppression governs the LOG WRITE only — it does not
 * halt the workflow. (Design call 1A.) phone_log surfaces `suppressed` in its
 * output for observability; nothing downstream gates on it today.
 *
 * Match grammar
 *   - 'conditions' mode reuses services/hookFilter.evaluateConditions.
 *   - 'code' mode evaluates the rule's code body in
 *     `new Function('input', code)(event)` — mirrors hookService.runFilter.
 *   - Throwing rules log a warning and count as non-match. Fail-safe:
 *     errors never suppress.
 *
 * Match input shape
 *   The create_log params object at the TOP LEVEL. Paths in match_config are
 *   the verified union across the 5 phone workflows, e.g.:
 *     'link_id'                  (canonical 10-digit other-party number)
 *     'type'                     ('sms' | 'call')
 *     'direction'                ('incoming' | 'outgoing')
 *     'from', 'to'
 *     'extra.provider'           ('ringcentral' | 'quo')
 *     'extra.conversation_id'
 *     'extra.line'
 *     'extra.provider_status'    (call only)
 *     'message'                  (sms only)
 *   evaluateConditions resolves dotted paths, so 'extra.provider' works.
 *
 * Semantics
 *   Boolean OR — any match wins. No ordering, no cascade.
 *
 * Metrics
 *   Matched rules get fire-and-forget UPDATEs to match_count and
 *   last_matched_at. Failures here are logged but never block the caller.
 *
 * Layer 3 (rule-driven automation) is NOT part of Stage 1 — phone already has
 * per-event workflows, so the automation layer already exists. This service is
 * suppression only.
 */

const { evaluateConditions } = require('./hookFilter');


// ─────────────────────────────────────────────────────────────
// LOADER
//
// No caching — call hits DB every event. Live rule changes propagate
// immediately. ~100s of events/day × <10 rules = trivial overhead.
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @returns {Promise<Array<{id:number,name:string,match_mode:string,match_config:any}>>}
 */
async function listActiveSuppressions(db) {
  const [rows] = await db.query(
    `SELECT id, name, match_mode, match_config
       FROM phone_log_suppressions
      WHERE active = 1`
  );
  return rows;
}


// ─────────────────────────────────────────────────────────────
// PER-RULE EVALUATION
//
// Returns true if the rule matches (i.e., the event should be suppressed by
// this rule), false otherwise. Throwing rules are caught and converted to
// non-match with a warning.
// ─────────────────────────────────────────────────────────────

function _evaluateRule(rule, event) {
  // Parse config defensively. mysql2 returns JSON columns as objects already,
  // but a pre-stringified value can sneak in (e.g., if a rule was inserted
  // with the JSON wrapped in JSON_QUOTE() or via a tool that stringifies
  // before INSERT).
  let config = rule.match_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      console.warn(
        `[phoneIngestSuppression] rule ${rule.id} (${rule.name}): ` +
        `match_config is not parseable JSON — treating as non-match`
      );
      return false;
    }
  }

  if (rule.match_mode === 'conditions') {
    // NOTE: hookFilter.evaluateConditions(null, input) returns TRUE
    // (its semantics: "no filter = pass all"). For an INCLUSION filter that's
    // correct; for a SUPPRESSION rule it's a destructive footgun (silently
    // suppress every event). We treat a NULL match_config as a no-op rather
    // than match-all. The validator forbids null config on conditions mode at
    // the API boundary; this is the defense in depth for raw-SQL inserts.
    if (config == null) {
      console.warn(
        `[phoneIngestSuppression] rule ${rule.id} (${rule.name}): ` +
        `NULL match_config on conditions mode — treating as non-match. ` +
        `If you intended match-all, set match_config to an explicit ` +
        `always-true shape (e.g., {operator:'and', conditions:[]}).`
      );
      return false;
    }
    try {
      return !!evaluateConditions(config, event);
    } catch (err) {
      console.warn(
        `[phoneIngestSuppression] rule ${rule.id} (${rule.name}) ` +
        `conditions error: ${err.message}`
      );
      return false;
    }
  }

  if (rule.match_mode === 'code') {
    // Mirror hookService.runFilter: config can be a string body OR an object
    // with .code. Empty code → non-match.
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      console.warn(
        `[phoneIngestSuppression] rule ${rule.id} (${rule.name}): ` +
        `empty code on code mode — treating as non-match`
      );
      return false;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      return !!fn(event);
    } catch (err) {
      console.warn(
        `[phoneIngestSuppression] rule ${rule.id} (${rule.name}) ` +
        `code error: ${err.message}`
      );
      return false;
    }
  }

  console.warn(
    `[phoneIngestSuppression] rule ${rule.id} (${rule.name}): ` +
    `unknown match_mode '${rule.match_mode}' — treating as non-match`
  );
  return false;
}


// ─────────────────────────────────────────────────────────────
// METRICS BUMP (fire-and-forget)
// ─────────────────────────────────────────────────────────────

/**
 * Bump match_count and last_matched_at for the given rule IDs.
 * Caller does NOT await; treat exceptions as benign.
 *
 * @param {object}   db
 * @param {number[]} ruleIds
 * @returns {Promise<void>}
 */
async function _bumpMetrics(db, ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const placeholders = ruleIds.map(() => '?').join(',');
  await db.query(
    `UPDATE phone_log_suppressions
        SET match_count     = match_count + 1,
            last_matched_at = NOW()
      WHERE id IN (${placeholders})`,
    ruleIds
  );
}


// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate all active suppression rules against the phone event.
 *
 * @param {object} db
 * @param {object} event    - the create_log params object (top level)
 * @returns {Promise<{suppressed: boolean, matchedRuleIds: number[]}>}
 */
async function evaluateSuppressions(db, event) {
  const rules = await listActiveSuppressions(db);

  const matchedRuleIds = [];
  for (const rule of rules) {
    if (_evaluateRule(rule, event)) matchedRuleIds.push(rule.id);
  }

  if (matchedRuleIds.length) {
    // Fire-and-forget. Do NOT await; do NOT block the caller.
    _bumpMetrics(db, matchedRuleIds).catch(err =>
      console.warn(
        `[phoneIngestSuppression] match-count bump failed for ` +
        `[${matchedRuleIds.join(',')}]: ${err.message}`
      )
    );
  }

  return {
    suppressed:     matchedRuleIds.length > 0,
    matchedRuleIds,
  };
}


// ─────────────────────────────────────────────────────────────
// CRUD (Stage 1 — management API)
//
// Writes set last_modified_by from the caller-supplied userId. match_count
// and last_matched_at are NEVER accepted from the client — they're owned by
// the pipeline (_bumpMetrics). match_config is a json column; we stringify on
// the way in (mysql2 would otherwise key-expand a plain object passed to a
// `?` placeholder).
//
// Validation reuses services/emailIngestValidator.validateSuppression — it is
// table-agnostic (validates name / match_mode / match_config / active shape
// only, no email coupling). Single source of suppression-shape truth.
// ─────────────────────────────────────────────────────────────

const validator = require('./emailIngestValidator');

class ValidationError extends Error {
  constructor(errors) {
    super('validation_failed');
    this.name = 'ValidationError';
    this.validationErrors = errors;
  }
}

function _toJsonColumn(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * All suppressions, active and inactive, newest first.
 * @returns {Promise<Array>}
 */
async function listAll(db) {
  const [rows] = await db.query(
    `SELECT id, name, description, active, match_mode, match_config,
            match_count, last_matched_at, last_modified_by,
            created_at, updated_at
       FROM phone_log_suppressions
      ORDER BY id DESC`
  );
  return rows;
}

/**
 * Single suppression by id, or null.
 */
async function getById(db, id) {
  const [[row]] = await db.query(
    `SELECT id, name, description, active, match_mode, match_config,
            match_count, last_matched_at, last_modified_by,
            created_at, updated_at
       FROM phone_log_suppressions
      WHERE id = ?`,
    [id]
  );
  return row || null;
}

/**
 * Validate + INSERT. Returns the created row.
 * @throws {ValidationError}
 */
async function create(db, payload, userId) {
  const { errors } = validator.validateSuppression(payload, true);
  if (errors.length) throw new ValidationError(errors);

  const [r] = await db.query(
    `INSERT INTO phone_log_suppressions
       (name, description, active, match_mode, match_config, last_modified_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      payload.name,
      payload.description ?? null,
      payload.active !== undefined ? (payload.active ? 1 : 0) : 1,
      payload.match_mode,
      _toJsonColumn(payload.match_config),
      userId ?? null,
    ]
  );
  return getById(db, r.insertId);
}

/**
 * Partial update (PATCH-style). Validates the MERGED record so a config-only
 * change is checked against the row's existing match_mode (and vice versa).
 * Returns the updated row, or null if the id doesn't exist.
 * @throws {ValidationError}
 */
async function update(db, id, payload, userId) {
  const existing = await getById(db, id);
  if (!existing) return null;

  // Merge present fields over the existing row, then validate the result as a
  // full record. This closes the "PUT match_config without match_mode" gap the
  // stateless validator can't see.
  const merged = {
    name:         payload.name         !== undefined ? payload.name         : existing.name,
    description:  payload.description  !== undefined ? payload.description  : existing.description,
    active:       payload.active        !== undefined ? payload.active       : existing.active,
    match_mode:   payload.match_mode    !== undefined ? payload.match_mode   : existing.match_mode,
    match_config: payload.match_config !== undefined ? payload.match_config : existing.match_config,
  };
  const { errors } = validator.validateSuppression(merged, true);
  if (errors.length) throw new ValidationError(errors);

  const sets = [];
  const vals = [];
  if (payload.name        !== undefined) { sets.push('name = ?');         vals.push(payload.name); }
  if (payload.description !== undefined) { sets.push('description = ?');  vals.push(payload.description ?? null); }
  if (payload.active      !== undefined) { sets.push('active = ?');       vals.push(payload.active ? 1 : 0); }
  if (payload.match_mode  !== undefined) { sets.push('match_mode = ?');   vals.push(payload.match_mode); }
  if (payload.match_config !== undefined){ sets.push('match_config = ?'); vals.push(_toJsonColumn(payload.match_config)); }
  sets.push('last_modified_by = ?'); vals.push(userId ?? null);

  vals.push(id);
  await db.query(
    `UPDATE phone_log_suppressions SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  return getById(db, id);
}

/**
 * Hard delete. Returns true if a row was removed.
 */
async function remove(db, id) {
  const [r] = await db.query(
    `DELETE FROM phone_log_suppressions WHERE id = ?`,
    [id]
  );
  return r.affectedRows > 0;
}


module.exports = {
  listActiveSuppressions,
  evaluateSuppressions,
  // CRUD
  listAll,
  getById,
  create,
  update,
  remove,
  ValidationError,
  // Exported for testing
  _evaluateRule,
  _bumpMetrics,
};