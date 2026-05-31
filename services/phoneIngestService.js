// services/phoneIngestService.js
//
/**
 * Phone Ingest Service
 * services/phoneIngestService.js
 *
 * Owns the phone-event ingest pipeline that previously lived inline in the
 * `phone_log` internal function (lib/internal_functions.js). The Layer-1/2 body
 * is a verbatim extraction of the previous phone_log pipeline; Layer-3 rule
 * evaluation + the phone_ingest_executions write were wired in afterward
 * (this slice), mirroring emailIngestService.ingestEmail.
 *
 * Current pipeline (per event):
 *   1. firmToFirm enrichment — stamp event.extra.firmToFirm = (other party is
 *      also a firm number). Persists into log_extra automatically since extra
 *      is the column logService stores. Queryable later; usable as a
 *      suppression match field (extra.firmToFirm).
 *   2. Write phone_event_log catch-all — ALWAYS, idempotent
 *      (INSERT ... ON DUPLICATE KEY UPDATE). Forensic; never gates logging.
 *   3. Layer 2 — evaluateSuppressions(db, event). Decides the structured LOG
 *      WRITE only; never halts the workflow.
 *   3b. Layer 3 — phoneIngestRuleService.evaluateRules(db, event). Runs ALWAYS,
 *      independent of suppression and of the downstream log-write outcome
 *      (layer-independence invariant — mirrors emailIngestService Slice 2.3.1,
 *      which hoisted Layer 3 above the log step). Matching rules' transforms
 *      run and their actions fire; outcomes land in executions.metadata.
 *   4. Conditional createLogEntry (skipped iff suppressed). On
 *      INVALID_LOG_LINK_ID it becomes an 'error' execution row that still
 *      carries Layer-3 outcomes in metadata; any other throw rethrows.
 *   5. Write exactly one phone_ingest_executions row per event
 *      (status logged | suppressed | error) before returning.
 *
 * Suppression governs the LOG WRITE only — it does NOT halt the workflow
 * (design call 1A). Downstream workflow steps run regardless; output.suppressed
 * is surfaced for observability/branching if ever wanted.
 *
 * Firm-to-firm is NOT a hardcoded skip — it is exposed as the extra.firmToFirm
 * match field so the operator can choose to suppress it (or not) via a normal
 * suppression rule, visible in the UI with metrics. (Hence phone has no
 * distinct `skipped_firm_to_firm` status, unlike email — it surfaces as
 * `suppressed` or `logged`.)
 *
 * Return shape (unchanged from phone_log's previous inline output — the
 * executions-row writes below are pure side effects):
 *   suppressed: { log_id:null, suppressed:true, matched_rule_ids:[...], firmToFirm }
 *   logged:     { ...createLogEntry result, suppressed:false, firmToFirm }
 *   error (INVALID_LOG_LINK_ID):
 *               { log_id:null, suppressed:false, error:<message>, firmToFirm }
 */

const phoneIngestSuppressionService = require('./phoneIngestSuppressionService');
const phoneIngestRuleService = require('./phoneIngestRuleService');

// NOTE on requires: logService is required lazily inside ingestPhoneEvent
// (matching internal_functions.js's circular-dep-safety convention for
// logService). phoneIngestSuppressionService and phoneIngestRuleService have no
// cycle back to here, so they are required at module scope.


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


// ─────────────────────────────────────────────────────────────
// Helpers — execution-row writes.
//
// Ported from emailIngestService._writeExecution / _buildMetadata. Phone
// diverges from email's column set: phone_ingest_executions has only
// (event_log_id, status, log_id, error, metadata, raw_input, created_at) —
// NO source_id, message_id, remote_ip, email_log_id. The generic column-mapper
// shape is preserved so callers pass only the columns they have.
//
// NOTE (divergence vs prompt): the prompt stated phone has no `raw_input` and
// _JSON_COLS should be {'metadata'} only. The ACTUAL table Worker A built
// (verified via SHOW CREATE TABLE) DOES have a nullable `raw_input` JSON
// column, and phoneIngestExecutionsService selects it in _EXEC_COLS and
// documents it in its header. Repo wins over the prompt: raw_input is a real
// column, so it stays in _JSON_COLS and the pipeline snapshots the event into
// it (forensic parity with email's raw_input). Flagged in the worker report.
// ─────────────────────────────────────────────────────────────

// JSON columns we explicitly stringify when the caller passes an object.
// (mysql2 will auto-encode, but being explicit keeps stored bytes predictable
// across mysql2 versions and avoids surprises if a future caller passes
// something unusual like a Date.) Mirrors email's _JSON_COLS, plus raw_input
// since phone_ingest_executions has that column too.
const _JSON_COLS = new Set(['metadata', 'raw_input']);

async function _writeExecution(db, fields) {
  const cols = [];
  const placeholders = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(k);
    placeholders.push('?');
    if (_JSON_COLS.has(k) && v != null && typeof v === 'object') {
      values.push(JSON.stringify(v));
    } else {
      values.push(v);
    }
  }
  const [r] = await db.query(
    `INSERT INTO phone_ingest_executions (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values
  );
  return r.insertId;
}

/**
 * Build the executions.metadata JSON payload from suppression + automation
 * results. Returns null when there's nothing to record (no suppressions
 * matched, no automation rules matched, no parse warnings) — keeping the
 * column NULL for the "nothing interesting" baseline.
 *
 * Ported verbatim from emailIngestService._buildMetadata.
 *
 * @param {{suppressed:boolean, matchedRuleIds:number[]}} suppression
 *        (from phoneIngestSuppressionService.evaluateSuppressions)
 * @param {{matchedRuleIds:number[], actionOutcomes:Array, parseWarnings:string[]}} automation
 *        (from phoneIngestRuleService.evaluateRules)
 */
function _buildMetadata(suppression, automation) {
  const m = {};
  if (suppression && suppression.matchedRuleIds && suppression.matchedRuleIds.length) {
    m.suppressed_by = suppression.matchedRuleIds;
  }
  if (automation && automation.matchedRuleIds && automation.matchedRuleIds.length) {
    m.matched_rules   = automation.matchedRuleIds;
    m.action_outcomes = automation.actionOutcomes;
  }
  if (automation && automation.parseWarnings && automation.parseWarnings.length) {
    m._parse_warnings = automation.parseWarnings;
  }
  return Object.keys(m).length ? m : null;
}


/**
 * Ingest one phone event. Layer-1/2 body is a verbatim extraction of the
 * previous phone_log pipeline; Layer-3 + executions writes added this slice.
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

  // raw_input forensic snapshot of the inbound event. The pipeline receives an
  // already-parsed create_log params object (no HTTP envelope to truncate),
  // so we store it as-is; _writeExecution stringifies it for the JSON column.
  const rawInputForLog = p;

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
  // Reconstruct the suppression object shape _buildMetadata expects. (The
  // existing code captured the two fields into locals and fails open on a
  // thrown evaluator — preserved here; the object just mirrors those locals.)
  const suppression = { suppressed, matchedRuleIds };

  // ---- 3b. Layer 3 — automation rules (ALWAYS runs) ---------------------
  //   >>> L3 SEAM (a). Hoisted ABOVE the suppression branch so the layer-
  //   independence invariant holds even when the event is suppressed OR when
  //   createLogEntry throws INVALID_LOG_LINK_ID below. evaluateRules is
  //   designed not to throw (per-action failures are captured in
  //   actionOutcomes); the try/catch covers a rule-loader/DB failure so we
  //   don't lose a successfully-logged event because automation eval blew up.
  //   Mirrors emailIngestService step 7c.
  let automation;
  try {
    automation = await phoneIngestRuleService.evaluateRules(db, p);
  } catch (autoErr) {
    console.error('[phone_log] Layer 3 evaluateRules threw:', autoErr.message);
    automation = {
      matchedRuleIds: [],
      actionOutcomes: [],
      parseWarnings: [`evaluateRules threw: ${autoErr.message}`],
    };
  }

  if (suppressed) {
    if (eventLogId) {
      db.query(
        `UPDATE phone_event_log SET suppressed = 1, suppressed_by = ? WHERE id = ?`,
        [JSON.stringify(matchedRuleIds), eventLogId]
      ).catch(err =>
        console.warn(`[phone_log] catch-all suppressed-flag update failed: ${err.message}`)
      );
    }

    // >>> L3 SEAM (b): executions row. status='suppressed', log_id=null.
    //   metadata via the shared builder — carries suppressed_by AND any
    //   matched_rules / action_outcomes from Layer 3 (which already ran above),
    //   proving automation still fired despite the log-write being suppressed.
    await _writeExecution(db, {
      event_log_id: eventLogId,
      status:       'suppressed',
      log_id:       null,
      metadata:     _buildMetadata(suppression, automation),
      raw_input:    rawInputForLog,
    });

    return { log_id: null, suppressed: true, matched_rule_ids: matchedRuleIds, firmToFirm };
  }

  // ---- 4. normal log write ----------------------------------------------
  //   >>> L3 SEAM (c) + INVALID_LOG_LINK_ID handling. Mirrors email step 7d:
  //   on INVALID_LOG_LINK_ID write an 'error' execution row (metadata still
  //   carries Layer-3 outcomes — automation already fired) and return an
  //   error-shaped output. Any other throw rethrows (route/skin maps to 500).
  let result;
  try {
    result = await logService.createLogEntry(db, p);
  } catch (logErr) {
    if (logErr && logErr.code === 'INVALID_LOG_LINK_ID') {
      await _writeExecution(db, {
        event_log_id: eventLogId,
        status:       'error',
        log_id:       null,
        error:        `createLogEntry INVALID_LOG_LINK_ID: ${logErr.message}`,
        metadata:     _buildMetadata(suppression, automation),
        raw_input:    rawInputForLog,
      });
      return { log_id: null, suppressed: false, error: logErr.message, firmToFirm };
    }
    // Any other error from logService — surface to the caller. Layer 3 has
    // already fired; its action_outcomes remain observable via the dispatched
    // workflows/sequences/hooks themselves. Matches email's rethrow.
    throw logErr;
  }

  if (eventLogId && result && result.log_id != null) {
    db.query(
      `UPDATE phone_event_log SET log_id = ? WHERE id = ?`,
      [result.log_id, eventLogId]
    ).catch(err =>
      console.warn(`[phone_log] catch-all log_id backfill failed: ${err.message}`)
    );
  }

  // >>> L3 SEAM (c): executions row. status='logged', log_id=result.log_id.
  //   metadata via the shared builder (matched_rules + action_outcomes when
  //   Layer 3 matched; null otherwise — no suppressed_by on this path since
  //   suppression.matchedRuleIds is empty when not suppressed).
  await _writeExecution(db, {
    event_log_id: eventLogId,
    status:       'logged',
    log_id:       result && result.log_id != null ? result.log_id : null,
    metadata:     _buildMetadata(suppression, automation),
    raw_input:    rawInputForLog,
  });

  return { ...result, suppressed: false, firmToFirm };
}


module.exports = {
  ingestPhoneEvent,
  resetFirmNumberCache,
  // Exported for testing / reuse
  _phoneLogNorm10,
  _getFirmNumbers,
  _writeExecution,
  _buildMetadata,
};