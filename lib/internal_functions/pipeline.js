// lib/internal_functions/pipeline.js
//
// Pipeline Engine functions (Slice B). New file → auto-registered by
// index.js's directory scan (no registration step). __meta.category is
// 'cases' so these group with the other case functions in the pickers
// (README: category follows UI grouping, file placement follows cohesion).

const fns = {};

/**
 * advance_stage
 * Advance a case to a pipeline stage via services/pipelineService.
 *
 * Thin wrapper: entered_by = null, source = 'system' — this is the automation
 * entry point (workflows / sequences / hooks / ingest dispatchers). Appends a
 * case_stage_log row and overwrites cases.case_stage / case_status / case_rec
 * from the stage. Repeating the case's current stage is a safe no-op
 * (output.noop = true). Skipping stages is legal by design.
 *
 * params:
 *   case_id {string|number} — required
 *   stage   {string|number} — required. stage_key (resolved within the case's
 *                             pipeline template) or numeric pipeline_stages id
 *                             (escape hatch — any template).
 *   note    {string}        — optional log note (truncated to 255)
 *   only_from      {string} — optional CSV guard (stage_keys); see _csvGuard
 *   only_from_role {string} — optional CSV guard (template roles)
 *   forward_only   {string} — optional boolean guard: advance, never regress.
 *                             See _boolGuard. All supplied guards must pass.
 *
 * example config:
 *   {
 *     "function_name": "advance_stage",
 *     "params": {
 *       "case_id": "{{cases.case_id}}",
 *       "stage":   "filed",
 *       "note":    "Auto-advanced on petition filing"
 *     }
 *   }
 */
/**
 * Comma-separated guard string → advanceStage guard array.
 *   blank / null / undefined → undefined (guard absent — deliberate: a
 *     {{placeholder}} that resolved to '' must degrade to an UNGUARDED call's
 *     validation-free absence, not a 400)
 *   'a, b'                   → ['a', 'b']
 *   token 'none' (ci)        → null member ("case has no log rows yet")
 *   ',,,' (all-empty)        → throws — a literal authoring error, not a
 *     blanked placeholder
 *   any quote character      → throws — see QUOTE REJECTION below
 *
 * QUOTE REJECTION (Aug 2026, rule 12 postmortem)
 * ----------------------------------------------
 * params_mapping's literal rule (lib/actionDispatchers.resolveParamsMapping,
 * mirrored in services/hookService) strips exactly ONE surrounding pair of
 * single quotes. It does NOT parse a list of literals. So the plausible-looking
 * authoring form
 *
 *     "only_from": "'lead','none'"
 *
 * resolves to the string  lead','none  and splits into ["lead'", "'none"] —
 * tokens that can never equal a stage_key, and where "'none'" never reaches the
 * lowercase 'none' sentinel test, so it does not become the null member either.
 * The result is a guard that skips 100% of the time while the rule reads as
 * healthy in the executions view (status 'matched', action status 'success',
 * reason 'guard' — indistinguishable from a legitimately-guarded miss).
 *
 * No stage_key (varchar(50), snake_case by convention) or pipeline template
 * role ('intake' | 'case') contains a quote, so a quote surviving into the
 * resolved value is ALWAYS an authoring mistake. Fail loudly: an action error
 * is visible (trigger_rules.error_count / last_error_at, workflow step
 * failure), a permanently-skipping guard is not.
 *
 * Correct form is ONE literal holding the whole list:  "'lead,none'"
 */
const _GUARD_QUOTE_RE = /['"]/;

/**
 * Boolean-ish guard string → true / undefined (guard absent).
 *   blank / null / undefined → undefined (SAME degrade contract as _csvGuard:
 *     a {{placeholder}} that resolved to '' must behave like an unguarded
 *     call, not error)
 *   'true' | '1' | 'yes' (ci, trimmed), or a real boolean/number → true
 *   'false' | '0' | 'no' (ci, trimmed), or false/0 → undefined (absent; the
 *     option's own default is false, so absent and false are the same call)
 *   anything else → THROWS
 *
 * ── WHY THIS THROWS WHERE events.js's _bool FALLS BACK ─────────────────────
 * lib/internal_functions/events.js:20 is the house boolean-param parser and
 * its token set is copied verbatim here. Its garbage branch is different: it
 * returns the caller's default, reasoning that "a typo must not silently
 * disarm a safety guard". That reasoning is correct THERE because its guard,
 * `dedupe`, DEFAULTS TRUE — falling back lands on the armed side.
 *
 * forward_only defaults FALSE. Identical mechanics, inverted outcome: a
 * fallback would land on the DISARMED side, and a typo'd forward_only would
 * silently permit exactly the backward advances the author wrote it to
 * prevent — with no error, no skip, and a rule that reads as healthy in the
 * executions view. That is the rule-12 postmortem's failure shape, and this
 * file already answers it once (see QUOTE REJECTION above). Same answer here:
 * an action error is visible, a disarmed guard is not.
 *
 * An author who wants the guard off writes nothing, or writes 'false' — both
 * accepted, neither an error.
 */
function _boolGuard(raw, name) {
  if (raw == null || String(raw).trim() === '') return undefined;
  if (raw === true  || raw === 1) return true;
  if (raw === false || raw === 0) return undefined;

  const s = String(raw).trim().toLowerCase();
  if (s === 'true'  || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no')  return undefined;

  throw new Error(
    `advance_stage: ${name} must be true/1/yes or false/0/no ` +
    `(received ${JSON.stringify(String(raw))}). Blank or absent means the guard ` +
    `is off. An unrecognized value is rejected rather than treated as "off", ` +
    `because a disarmed guard writes backward advances silently — there would ` +
    `be no error and no skip to notice.`
  );
}

function _csvGuard(raw, name) {
  if (raw == null || String(raw).trim() === '') return undefined;

  const str = String(raw);

  if (_GUARD_QUOTE_RE.test(str)) {
    throw new Error(
      `advance_stage: ${name} contains a quote character (received ${JSON.stringify(str)}). ` +
      `Pass ONE quoted literal holding the whole comma-separated list — "'lead,none'" — ` +
      `not a list of quoted literals — "'lead','none'". params_mapping strips only the ` +
      `outer quote pair, so the latter yields an unmatchable guard that silently skips ` +
      `every time.`
    );
  }

  const arr = str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => (s.toLowerCase() === 'none' ? null : s));
  if (!arr.length) {
    throw new Error(`advance_stage: ${name} must contain at least one entry when provided`);
  }
  return arr;
}

fns.advance_stage = async (params, db) => {
  const { case_id, stage, note, only_from, only_from_role, forward_only } = params;
  if (!case_id) throw new Error('advance_stage requires case_id');
  if (stage === undefined || stage === null || String(stage).trim() === '') {
    throw new Error('advance_stage requires stage (stage_key or numeric stage_id)');
  }

  const onlyFrom     = _csvGuard(only_from, 'only_from');
  const onlyFromRole = _csvGuard(only_from_role, 'only_from_role');
  // undefined when absent/blank/'false' — advanceStage's own default is
  // false, so absent and off are the same call. Never a string: the service
  // 400s on a non-boolean rather than silently reading it as "off".
  const forwardOnly  = _boolGuard(forward_only, 'forward_only');

  const pipelineService = require('../../services/pipelineService'); // lazy require (convention)

  const result = await pipelineService.advanceStage(db, String(case_id), stage, {
    userId: null,
    note: note == null ? null : note,
    source: 'system',
    onlyFrom,
    onlyFromRole,
    forwardOnly,
  });

  console.log(
    `[ADVANCE_STAGE] case=${case_id} stage=${stage} noop=${result.noop} ` +
    `skipped=${result.skipped === true}` +
    (result.skipped === true ? ` reason=${result.reason}` : '')
  );

  // DELIBERATE branch on skipped BEFORE touching result.current: the skipped
  // shape is bare {skipped, noop, from, reason} — there is no .current on it
  // (see advanceStage's RETURN IS POLYMORPHIC contract). Both output shapes
  // carry the same key set so set_vars captures resolve either way.
  if (result.skipped === true) {
    return {
      success: true,
      output: {
        case_id: String(case_id),
        noop: false,
        skipped: true,
        reason: result.reason || 'guard',
        from: result.from == null ? null : result.from,
        stage_key: null,
        case_stage: null,
        status_label: null,
      },
    };
  }

  return {
    success: true,
    output: {
      case_id: String(case_id),
      noop: result.noop,
      skipped: false,
      reason: null,
      from: null,
      stage_key:    result.current ? result.current.stage_key : null,
      case_stage:   result.current ? result.current.case_stage : null,
      status_label: result.current ? result.current.status_label : null,
    },
  };
};
fns.advance_stage.__meta = {
  category: 'cases',
  description: 'Advance a case to a pipeline stage (Pipeline Engine). Appends a case_stage_log row and overwrites cases.case_stage / case_status / case_rec from the stage. Repeating the current stage is a safe no-op (output.noop=true); skipping stages is legal. Optional guards make the advance conditional, and ALL supplied guards must pass: only_from (comma-separated stage_keys the case must currently be at), only_from_role (comma-separated pipeline template roles — intake/case — of the stage the case is currently at, judged by its latest log row, NOT the currently-resolved template), and forward_only (advance but never regress, without listing from-states). The token "none" in only_from / only_from_role means "case has no pipeline history yet". A guard miss — or a guarded stage_key that does not exist in the case\'s current template — SKIPS quietly (output.skipped=true, nothing written, no error). Output carries noop, skipped, reason (guard|unresolved|backward when skipped), from (stage_key skipped from, when skipped), stage_key, case_stage, status_label — capture via set_vars if needed. reason "backward" means forward_only refused a regression; "unresolved" means a stage_key could not be matched.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{caseId}}' },
    { name: 'stage', type: 'string', required: true, placeholderAllowed: true,
      description: 'stage_key (e.g. "filed") resolved within the case\'s pipeline template, or a numeric pipeline_stages id (escape hatch — any template).',
      example: 'filed' },
    { name: 'note', type: 'string', required: false, placeholderAllowed: true,
      description: 'Optional log note (truncated to 255 chars).' },
    // type:'string' DELIBERATE for both guards — number-typed workflow inputs
    // silently blank non-numeric placeholder values (send_sms/assigned_to
    // precedent), and these are comma-separated lists anyway.
    { name: 'only_from', type: 'string', required: false, placeholderAllowed: true, csvList: true,
      description: 'Guard: comma-separated stage_keys — advance ONLY if the case\'s latest log row carries one of them. Token "none" = case has no log rows yet. Miss → output.skipped=true, nothing written. Blank/absent = unguarded. In a params_mapping this is ONE quoted literal holding the whole list — \'lead,none\' — NOT a list of literals (\'lead\',\'none\'), which resolves to an unmatchable guard and now errors.',
      example: 'retained' },
    { name: 'only_from_role', type: 'string', required: false, placeholderAllowed: true, csvList: true,
      description: 'Guard: comma-separated pipeline template roles (intake, case) — advance ONLY if the case\'s latest log row belongs to a template with one of these roles (judged by the LOG ROW\'s template, not the currently-resolved one — a case whose subtype was just written still counts as coming from intake). Token "none" = case has no log rows yet. Miss → output.skipped=true. Combines with only_from (both must pass). Blank/absent = unguarded. In a params_mapping this is ONE quoted literal holding the whole list — \'intake,none\' — NOT a list of literals.',
      example: 'intake,none' },
    // type:'string' for the SAME reason as the two CSV guards above —
    // boolean-typed workflow inputs mangle non-boolean placeholder values,
    // and a {{placeholder}} resolves to a string either way.
    { name: 'forward_only', type: 'string', required: false, placeholderAllowed: true,
      description: 'Guard: advance but NEVER regress, without having to list every legal from-state. Accepts true/1/yes (armed) or false/0/no (off); blank or absent = off. An unrecognized value is an ERROR, not "off" — a silently disarmed guard would write backward advances with nothing to notice. When armed: entering a later stage of the same template passes; entering an OFF-RAMP (lane=offramp: no_show, dead_lead, dismissed, appeal, …) passes from anywhere, including from another off-ramp; moving to an earlier stage, or from an off-ramp back onto the main path, SKIPS with reason "backward". Across templates only intake→case (the retention bootstrap) and same-role matter changes pass — stage numbers are per-template and are not compared. Repeating the current stage stays a plain no-op, never "backward". Combines with only_from / only_from_role (all must pass).',
      example: 'true' },
  ],
  example: { case_id: '{{caseId}}', stage: 'filed', note: 'Auto-advanced on petition filing' },
};

module.exports = fns;