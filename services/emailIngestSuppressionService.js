// services/emailIngestSuppressionService.js
//
/**
 * Email Ingest — Layer 2 Logging Suppression Service
 * services/emailIngestSuppressionService.js
 *
 * Phase 2 Slice 2.1.
 *
 * Evaluates active rows in `email_ingest_log_suppressions` against the
 * canonical envelope. If ANY rule matches, the default user-facing log
 * row is suppressed. The forensic `email_log` row is still written by
 * emailIngestService and is NOT affected by this layer.
 *
 * Pipeline position (set by emailIngestService.ingestEmail):
 *   ...firm-to-firm check → evaluateSuppressions(db, envelope) → createLogEntry
 *
 * Duplicates and firm-to-firm hits short-circuit BEFORE suppression runs,
 * so we never evaluate rules for emails we're already not logging.
 *
 * Match grammar
 *   - 'conditions' mode reuses services/hookFilter.evaluateConditions.
 *   - 'code' mode evaluates the rule's code body in
 *     `new Function('input', code)(envelope)` — mirrors hookService.runFilter.
 *   - Throwing rules log a warning and count as non-match. Fail-safe:
 *     errors never suppress.
 *
 * Match input shape
 *   The canonical envelope at the TOP LEVEL. Paths in match_config are
 *   'from.email', 'subject', 'headers.message_id', 'to[0].email', etc.
 *   No 'body.' prefix — the ingest endpoint accepts the envelope directly,
 *   unlike the YisraHook receiver which wraps inbound as
 *   { body, headers, query, method, meta }.
 *
 * Semantics
 *   Boolean OR — any match wins. No ordering, no cascade.
 *
 * Metrics
 *   Matched rules get fire-and-forget UPDATEs to match_count and
 *   last_matched_at. Failures here are logged but never block the
 *   caller's response.
 *
 * Layer 3 (`email_ingest_rules` + `email_ingest_rule_actions`) is NOT
 * evaluated here. That arrives in Slice 2.3.
 */

const { evaluateConditions } = require('./hookFilter');


// ─────────────────────────────────────────────────────────────
// LOADER
//
// No caching — call hits DB every ingest. Live rule changes propagate
// immediately. ~100 emails/day × <10 rules forever = trivial overhead.
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @returns {Promise<Array<{id:number,name:string,match_mode:string,match_config:any}>>}
 */
async function listActiveSuppressions(db) {
  const [rows] = await db.query(
    `SELECT id, name, match_mode, match_config
       FROM email_ingest_log_suppressions
      WHERE active = 1`
  );
  return rows;
}


// ─────────────────────────────────────────────────────────────
// PER-RULE EVALUATION
//
// Returns true if the rule matches (i.e., envelope should be suppressed
// by this rule), false otherwise. Throwing rules are caught and converted
// to non-match with a warning.
// ─────────────────────────────────────────────────────────────

function _evaluateRule(rule, envelope) {
  // Parse config defensively. mysql2 returns JSON columns as objects
  // already, but a pre-stringified value can sneak in (e.g., if a rule
  // was inserted with the JSON wrapped in JSON_QUOTE() or via a tool
  // that stringifies before INSERT).
  let config = rule.match_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      console.warn(
        `[emailIngestSuppression] rule ${rule.id} (${rule.name}): ` +
        `match_config is not parseable JSON — treating as non-match`
      );
      return false;
    }
  }

  if (rule.match_mode === 'conditions') {
    // NOTE: hookFilter.evaluateConditions(null, input) returns TRUE
    // (its semantics: "no filter = pass all"). For an INCLUSION filter
    // that's correct; for a SUPPRESSION rule it's a destructive footgun
    // (silently suppress every email). Until Phase 3's UI validates
    // input, we treat a NULL match_config as a no-op rather than as
    // a match-all. Deviation from "reuse hookFilter as-is" — flagged
    // in worker report.
    if (config == null) {
      console.warn(
        `[emailIngestSuppression] rule ${rule.id} (${rule.name}): ` +
        `NULL match_config on conditions mode — treating as non-match. ` +
        `If you intended match-all, set match_config to an explicit ` +
        `always-true shape (e.g., {operator:'and', conditions:[]}).`
      );
      return false;
    }
    try {
      return !!evaluateConditions(config, envelope);
    } catch (err) {
      console.warn(
        `[emailIngestSuppression] rule ${rule.id} (${rule.name}) ` +
        `conditions error: ${err.message}`
      );
      return false;
    }
  }

  if (rule.match_mode === 'code') {
    // Mirror hookService.runFilter: config can be a string body OR an
    // object with .code. Empty code → non-match.
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      console.warn(
        `[emailIngestSuppression] rule ${rule.id} (${rule.name}): ` +
        `empty code on code mode — treating as non-match`
      );
      return false;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      return !!fn(envelope);
    } catch (err) {
      console.warn(
        `[emailIngestSuppression] rule ${rule.id} (${rule.name}) ` +
        `code error: ${err.message}`
      );
      return false;
    }
  }

  console.warn(
    `[emailIngestSuppression] rule ${rule.id} (${rule.name}): ` +
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
    `UPDATE email_ingest_log_suppressions
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
 * Evaluate all active suppression rules against the envelope.
 *
 * @param {object} db
 * @param {object} envelope    - the canonical envelope (top level)
 * @returns {Promise<{suppressed: boolean, matchedRuleIds: number[]}>}
 */
async function evaluateSuppressions(db, envelope) {
  const rules = await listActiveSuppressions(db);

  // Catalog parity (same derivation as emailIngestRuleService.evaluateRules):
  // MATCH_FIELDS offers `body`, but the canonical envelope carries text/html
  // only — body is derived at ingest for the email_log row (emailIngestService:
  // envelope.text || envelope.html || '') and was never put on the envelope, so
  // body conditions could never match. Derive it here with the identical
  // expression. Non-mutating spread — the caller's envelope object is untouched.
  envelope = { ...envelope, body: (envelope.text || envelope.html || '') };

  const matchedRuleIds = [];
  for (const rule of rules) {
    if (_evaluateRule(rule, envelope)) matchedRuleIds.push(rule.id);
  }

  if (matchedRuleIds.length) {
    // Fire-and-forget. Do NOT await; do NOT block the caller's response.
    _bumpMetrics(db, matchedRuleIds).catch(err =>
      console.warn(
        `[emailIngestSuppression] match-count bump failed for ` +
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
// CRUD (Phase 3 Slice 3.1 — management API)
//
// Writes set last_modified_by from the caller-supplied userId. match_count
// and last_matched_at are NEVER accepted from the client — they're owned by
// the pipeline (_bumpMetrics). match_config is a json column; we stringify
// on the way in (mysql2 would otherwise key-expand a plain object passed to
// a `?` placeholder).
//
// Validation lives in services/emailIngestValidator.js. create()/update()
// run it and throw a ValidationError the route translates to a 400. The
// route could validate first instead, but keeping it in the service means
// raw SQL callers (tests, future internal callers) get the same guard.
// ─────────────────────────────────────────────────────────────

// CIRCULAR-DEPENDENCY NOTE: emailIngestValidator requires
// ../lib/internal_functions, and the phone-log pipeline lives inside
// internal_functions and pulls in the phone ingest services. Today nothing in
// that load graph requires this service back, so a top-level
// `const validator = require('./emailIngestValidator')` happens to work — but
// any future edge from the internal_functions graph into the email ingest
// services would turn it into a partial-exports capture (the default empty {}
// mid-load), with validator.* coming back undefined at runtime. Resolve it
// lazily, matching phoneIngestMetaService / phoneIngestRuleService /
// phoneIngestSuppressionService, so the email and phone sides carry the same
// convention and the landmine class is closed.
function _validator() {
  // Lazy require — see CIRCULAR-DEPENDENCY NOTE above. Node caches the module,
  // so this is a cheap registry lookup after first load, not a re-parse.
  return require('./emailIngestValidator');
}

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
       FROM email_ingest_log_suppressions
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
       FROM email_ingest_log_suppressions
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
  const { errors } = _validator().validateSuppression(payload, true);
  if (errors.length) throw new ValidationError(errors);

  const [r] = await db.query(
    `INSERT INTO email_ingest_log_suppressions
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

  // Merge present fields over the existing row, then validate the result as
  // a full record. This closes the "PUT match_config without match_mode"
  // gap the stateless validator can't see.
  const merged = {
    name:         payload.name         !== undefined ? payload.name         : existing.name,
    description:  payload.description  !== undefined ? payload.description  : existing.description,
    active:       payload.active        !== undefined ? payload.active       : existing.active,
    match_mode:   payload.match_mode    !== undefined ? payload.match_mode   : existing.match_mode,
    match_config: payload.match_config !== undefined ? payload.match_config : existing.match_config,
  };
  const { errors } = _validator().validateSuppression(merged, true);
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
    `UPDATE email_ingest_log_suppressions SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  return getById(db, id);
}

/**
 * Hard delete. Returns true if a row was removed.
 */
async function remove(db, id) {
  const [r] = await db.query(
    `DELETE FROM email_ingest_log_suppressions WHERE id = ?`,
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