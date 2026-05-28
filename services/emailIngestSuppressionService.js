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


module.exports = {
  listActiveSuppressions,
  evaluateSuppressions,
  // Exported for testing
  _evaluateRule,
  _bumpMetrics,
};