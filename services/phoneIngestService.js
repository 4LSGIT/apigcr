// services/phoneIngestService.js
//
/**
 * Phone Ingest Service
 * services/phoneIngestService.js
 *
 * Owns the phone-event ingest pipeline that previously lived inline in the
 * `phone_log` internal function (lib/internal_functions.js). This is a PURE
 * EXTRACTION — the body below is the verbatim phone_log pipeline; behavior is
 * unchanged. `phone_log` is now a thin skin that delegates here.
 *
 * Current pipeline (per event):
 *   1. firmToFirm enrichment — stamp event.extra.firmToFirm = (other party is
 *      also a firm number). Persists into log_extra automatically since extra
 *      is the column logService stores. Queryable later; usable as a
 *      suppression match field (extra.firmToFirm).
 *   2. Write phone_event_log catch-all — ALWAYS, idempotent
 *      (INSERT ... ON DUPLICATE KEY UPDATE). Forensic; never gates logging.
 *   3. Layer 2 — evaluateSuppressions(db, event). If suppressed: mark the
 *      catch-all row, SKIP createLogEntry, return output.log_id = null.
 *   4. Else createLogEntry, backfill catch-all.log_id, return result.
 *
 * Suppression governs the LOG WRITE only — it does NOT halt the workflow
 * (design call 1A). Downstream workflow steps run regardless; output.suppressed
 * is surfaced for observability/branching if ever wanted.
 *
 * Firm-to-firm is NOT a hardcoded skip — it is exposed as the extra.firmToFirm
 * match field so the operator can choose to suppress it (or not) via a normal
 * suppression rule, visible in the UI with metrics.
 *
 * Return shape (unchanged from phone_log's previous inline output):
 *   suppressed: { log_id:null, suppressed:true, matched_rule_ids:[...], firmToFirm }
 *   logged:     { ...createLogEntry result, suppressed:false, firmToFirm }
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LAYER 3 SEAM (next worker — Phone Ingest L3 dispatch + executions write) │
 * │                                                                           │
 * │ Layer 3 (services/phoneIngestRuleService.evaluateRules) and the          │
 * │ phone_ingest_executions write are NOT wired in this file yet. The next   │
 * │ worker adds, mirroring emailIngestService.ingestEmail:                    │
 * │   - call phoneIngestRuleService.evaluateRules(db, event) ALWAYS (it runs │
 * │     independently of suppression — see LAYER INDEPENDENCE in the rule    │
 * │     service header),                                                      │
 * │   - write one phone_ingest_executions row via a _writeExecution helper   │
 * │     with status = the logging-layer outcome (logged | suppressed |       │
 * │     error), event_log_id = the catch-all row id, log_id = the structured │
 * │     row id (or null), and metadata = { matched_rules, suppressed_by,      │
 * │     action_outcomes }.                                                    │
 * │ The exact insertion points are marked `// >>> L3 SEAM` below.            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const phoneIngestSuppressionService = require('./phoneIngestSuppressionService');

// NOTE on requires: logService is required lazily inside ingestPhoneEvent
// (matching internal_functions.js's circular-dep-safety convention for
// logService). phoneIngestSuppressionService has no cycle back to here, so it
// is required at module scope.


/**
 * Normalize a phone value to bare 10 digits (drops a leading US '1').
 * Local copy — logService._normalizePhone is not exported. Same logic the
 * codebase elsewhere calls norm10(). Returns '' for falsy/garbage.
 *
 * (Moved verbatim from lib/internal_functions.js, where it was used only by
 * the phone_log pipeline.)
 */
function _phoneLogNorm10(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * Firm number set, loaded once per process from phone_lines (active rows),
 * normalized to 10 digits. Mirrors emailIngestService's process-lifetime
 * FIRM_DOMAINS load: firm lines change ~never, and a deploy reloads. If a line
 * is added without a deploy, call resetFirmNumberCache() or just redeploy —
 * staleness only affects the firmToFirm flag, never logging correctness.
 *
 * (Moved verbatim from lib/internal_functions.js.)
 */
let _firmNumberCache = null;
async function _getFirmNumbers(db) {
  if (_firmNumberCache) return _firmNumberCache;
  const [rows] = await db.query(
    `SELECT phone_number FROM phone_lines WHERE active = 1`
  );
  const set = new Set();
  for (const r of rows) {
    const n = _phoneLogNorm10(r.phone_number);
    if (n) set.add(n);
  }
  _firmNumberCache = set;
  return set;
}
function resetFirmNumberCache() { _firmNumberCache = null; }


/**
 * Ingest one phone event. Verbatim extraction of the previous phone_log body.
 *
 * @param {object} db
 * @param {object} event  - the create_log params object (top level)
 * @returns {Promise<object>}  the `output` block (NOT wrapped in {success,...};
 *                             the phone_log skin wraps it).
 */
async function ingestPhoneEvent(db, event) {
  const logService = require('./logService');

  const p = event || {};
  const eventType = p.type === 'call' ? 'call' : 'sms';

  // ---- 1. firmToFirm enrichment -----------------------------------------
  const otherParty = _phoneLogNorm10(p.link_id || p.to || p.from);
  let firmToFirm = false;
  try {
    const firmSet = await _getFirmNumbers(db);
    firmToFirm = !!otherParty && firmSet.has(otherParty);
  } catch (err) {
    console.warn(`[phone_log] firm-set load failed: ${err.message}`);
  }
  p.extra = { ...(p.extra && typeof p.extra === 'object' ? p.extra : {}), firmToFirm };

  // ---- pull dedup ref (sms→message_id, call→call_id) --------------------
  const ex = p.extra;
  const providerRef = eventType === 'call'
    ? (ex.provider_call_id ?? null)
    : (ex.provider_message_id ?? null);

  // ---- 2. catch-all write (idempotent, always) --------------------------
  let eventLogId = null;
  try {
    const [r] = await db.query(
      `INSERT INTO phone_event_log
         (provider, provider_ref, provider_event_id, event_type, direction,
          from_number, to_number, other_party, body, raw_extra, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [
        ex.provider ?? null,
        providerRef,
        ex.provider_event_id ?? null,
        eventType,
        p.direction ?? null,
        p.from ?? null,
        p.to ?? null,
        otherParty || null,
        p.message ?? null,
        JSON.stringify(ex),
      ]
    );
    eventLogId = r.insertId || null;
  } catch (err) {
    console.warn(`[phone_log] phone_event_log write failed: ${err.message}`);
  }

  // ---- 3. suppression (Layer 2) -----------------------------------------
  let suppressed = false;
  let matchedRuleIds = [];
  try {
    const sup = await phoneIngestSuppressionService.evaluateSuppressions(db, p);
    suppressed = sup.suppressed;
    matchedRuleIds = sup.matchedRuleIds;
  } catch (err) {
    console.warn(`[phone_log] suppression eval failed: ${err.message}`);
  }

  // >>> L3 SEAM (a): the next worker calls
  //     phoneIngestRuleService.evaluateRules(db, p) HERE — it runs ALWAYS,
  //     independent of `suppressed`. Capture { matchedRuleIds, actionOutcomes,
  //     parseWarnings } for the executions metadata block.

  if (suppressed) {
    if (eventLogId) {
      db.query(
        `UPDATE phone_event_log SET suppressed = 1, suppressed_by = ? WHERE id = ?`,
        [JSON.stringify(matchedRuleIds), eventLogId]
      ).catch(err =>
        console.warn(`[phone_log] catch-all suppressed-flag update failed: ${err.message}`)
      );
    }

    // >>> L3 SEAM (b): write a phone_ingest_executions row with
    //     status = 'suppressed', event_log_id = eventLogId, log_id = null,
    //     metadata = { matched_rules: <L3 matched>, suppressed_by:
    //     matchedRuleIds, action_outcomes: <L3 outcomes> }. (Firm-to-firm is
    //     just a suppression input — no distinct status.)

    return { log_id: null, suppressed: true, matched_rule_ids: matchedRuleIds, firmToFirm };
  }

  // ---- 4. normal log write ----------------------------------------------
  const result = await logService.createLogEntry(db, p);

  if (eventLogId && result && result.log_id != null) {
    db.query(
      `UPDATE phone_event_log SET log_id = ? WHERE id = ?`,
      [result.log_id, eventLogId]
    ).catch(err =>
      console.warn(`[phone_log] catch-all log_id backfill failed: ${err.message}`)
    );
  }

  // >>> L3 SEAM (c): write a phone_ingest_executions row with
  //     status = 'logged', event_log_id = eventLogId, log_id = result.log_id,
  //     metadata = { matched_rules, action_outcomes } (no suppressed_by).

  return { ...result, suppressed: false, firmToFirm };
}


module.exports = {
  ingestPhoneEvent,
  resetFirmNumberCache,
  // Exported for testing / reuse
  _phoneLogNorm10,
  _getFirmNumbers,
};