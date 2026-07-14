// lib/internal_functions/log.js

// NOTE: phoneIngestService is lazy-required INSIDE phone_log, matching this
// file's circular-dep-safety convention for logService / sequenceEngine /
// apptService. phoneIngestService owns the phone-event pipeline (extracted
// from the old inline phone_log body) plus the firm-number cache. Do NOT add
// a module-scope require for it.
//
// The firm-number cache (formerly _firmNumberCache / _getFirmNumbers /
// _phoneLogNorm10 / _resetFirmNumberCache here) moved to
// services/phoneIngestService.js with the pipeline. The public
// internalFunctions.__resetFirmNumberCache handle is preserved at the bottom
// of this file, re-pointed at phoneIngestService.resetFirmNumberCache.

// Direction normalization (Slice 4-C) was lifted to services/logService.js
// in Phase 2 so REST callers via /api/log get the same normalization that
// workflow/sequence create_log calls have always had. The semantics are
// unchanged: caller's input retains its raw value (e.g. "Outbound") for
// evaluate_condition branches; only the DB write conforms to the enum.

const fns = {};

// ─────────────────────────────────────────────────────────────
// SHARED ENUMS
//
// Both mirror the live `log` table columns exactly (verified against the
// production schema, params-mapping Slice):
//   log_type      enum('email','sms','call','other','form','status','note',
//                      'court email','docs','appt','update','task','event')
//   log_link_type enum('contact','case','appt','bill','phone','email',
//                      'task','event')
//
// LOG_TYPES was one value short of the column ('event' was missing) even
// though runtime already writes 'event' rows; declaring it here closes the
// drift. Enum EXPANSION is always safe — the validator only ever rejects
// values NOT in the list, so adding one can't newly reject an existing config.
//
// LINK_TYPES stops at the six ENTITY-ish types on purpose. The column also
// accepts 'task' and 'event', but those rows are machine-written and are not
// user re-link targets; see update_log's link_type description. Expanding the
// list later is additive.
// ─────────────────────────────────────────────────────────────

const LOG_TYPES = [
  'email', 'sms', 'call', 'other', 'form', 'status', 'note',
  'court email', 'docs', 'appt', 'update', 'task', 'event',
];

const LINK_TYPES = ['contact', 'case', 'appt', 'bill', 'phone', 'email'];

// `extra` → the log_extra JSON column. Declared on BOTH create_log and
// phone_log (phone_log is documented as a drop-in accepting the same params,
// and both funnel into logService.createLogEntry / the same column, so their
// metas stay in lockstep).
//
// TYPE IS 'object', NOT 'string' — this is the load-bearing decision:
//
//   - The only path that VALIDATES params is the workflow / scheduled-job
//     save path (routes/workflows.js:837/969/1442/1555 and
//     routes/scheduled_jobs.js:161/488, all via
//     internalFunctions.__validateFunctionParams). Every live caller on that
//     path passes `extra` as an OBJECT literal — 7/7 steps: wf15 s8 and wf16 s7
//     (create_log), wf17–21 (phone_log). `_validateType` with type:'string'
//     rejects an object outright ("must be a string"), so declaring string
//     would edit-lock all of them.
//
//   - The params_mapping path — the one that CAN yield a JSON string, e.g. the
//     live email-ingest rule 15 action mapping `extra` → a dot-path — is never
//     validated at all: lib/actionDispatchers.deliverInternalFunction resolves
//     the mapping and calls fn(params, db) directly. So the string form never
//     meets the validator, and object-vs-string costs it nothing.
//     logService.createLogEntry dual-accepts either form regardless.
//
//   - workflows.html agrees: its field renderer sends an object-typed param to
//     a JSON textarea and JSON.parses it back on gather, so `extra` round-trips
//     through the form AS an object. Under type:'string' the form's auto-promote
//     path would hand back an object the validator then rejects — form and
//     validator disagreeing is the smell that flagged this.
//
// (The `data` param below is declared type:'string' and is ALSO passed as an
// object by those same steps — that is a real, pre-existing edit-lock, tracked
// separately. It is NOT the precedent to copy.)
const EXTRA_PARAM = {
  name: 'extra',
  type: 'object',
  required: false,
  description:
    'log_extra JSON — IT-facing forensic fields (source, message_id, ' +
    'attachments, auth, provider ids, …) kept out of the user-facing log_data ' +
    'render. Pass an object literal; {{placeholders}} inside its VALUES resolve ' +
    'normally. The params_mapping path (unvalidated) may also supply a ' +
    'JSON-string-of-object — logService.createLogEntry parses either form and ' +
    'writes SQL NULL for anything that is not a plain object.',
};


// ─────────────────────────────────────────────────────────────
// LOG (Phase 0.7)
// ─────────────────────────────────────────────────────────────

/**
 * create_log
 * Insert a log entry. Used by workflows/sequences to record events.
 *
 * Phase 2: thin shim over services/logService.createLogEntry. The
 * heavy lifting — phone/email link_id normalization (Track A.1
 * Phase A), direction normalization (Slice 4-C), and log_data
 * enrichment from typed display params (Phase 2) — all lives in
 * logService now so REST callers via /api/log get the same shape.
 *
 * params:
 *   type         {string}         — log_type enum: 'email','sms','call','other','form',
 *                                   'status','note','court email','docs','appt','update',
 *                                   'task','event'
 *   link_type    {string|null}    — 'contact','case','appt','bill','phone','email' (optional)
 *   link_id      {string|number}  — the ID for the link (optional)
 *   by           {number}         — user ID (0 for system/automation)
 *   data         {string|object}  — log_data content (JSON string or object)
 *   extra        {object|string}  — log_extra JSON (forensic / IT-facing fields)
 *   from         {string|null}    — log_from + folded into log_data.from
 *   to           {string|null}    — log_to + folded into log_data.to
 *   subject      {string|null}    — log_subject + folded into log_data.subject
 *   message      {string|null}    — log_message + folded into log_data.message
 *   direction    {string|null}    — 'incoming' or 'outgoing' (normalized
 *                                   from 'Inbound'/'Outbound') — column only
 *
 * example config:
 *   {
 *     "function_name": "create_log",
 *     "params": {
 *       "type": "note",
 *       "link_type": "contact",
 *       "link_id": "{{contactId}}",
 *       "by": 0,
 *       "data": "{\"source\": \"workflow\", \"note\": \"Auto follow-up sent\"}"
 *     },
 *     "set_vars": { "logId": "{{this.output.log_id}}" }
 *   }
 */

fns.create_log = async (params, db) => {
    const logService = require('../../services/logService');
    const result = await logService.createLogEntry(db, params);
    return { success: true, output: result };
  };

fns.create_log.__meta = {
  category: 'log',
  description: 'Insert a log entry. Used by workflows/sequences to record events.',
  params: [
    { name: 'type', type: 'enum', required: true, enum: LOG_TYPES },
    { name: 'link_type', type: 'enum', required: false,
      enum: LINK_TYPES,
      description:
        "For 'phone'/'email', link_id is the value itself (logService " +
        "normalizes phone to 10 digits and email to lowercased+trimmed). " +
        "Use these when the log isn't attached to a specific entity ID — " +
        "inbound comms, automation traces, pre-contact pipeline activity." },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description:
        'Entity ID for contact/case/appt/bill, OR the phone (any format, ' +
        'normalized to 10 digits) / email (lowercased+trimmed) VALUE when ' +
        'link_type is phone/email.' },
    { name: 'by', type: 'integer', required: false, default: 0,
      description: 'User ID (0 for system/automation).' },
    { name: 'data', type: 'string', required: false, multiline: true,
      description: 'log_data content. JSON string or plain text. Objects are stringified at runtime.' },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true },
    { name: 'message', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'log_message — legacy but still written.' },
    { name: 'direction', type: 'enum', required: false, enum: ['incoming', 'outgoing'] },
    EXTRA_PARAM,
  ],
  example: { type: 'note', link_type: 'contact', link_id: '{{contactId}}', by: 0,
             data: 'Auto follow-up sent' }
};

/**
 * update_log
 * Re-link an existing log entry to a different entity.
 *
 * Thin shim over services/logService.updateLogLink. RE-LINK ONLY — it touches
 * log_link_type / log_link_id / log_link and nothing else. There is no unlink
 * path (link_type and link_id are both required) and no content edit path
 * (type/data/extra/from/to/subject/message/direction are not accepted); a log
 * row's CONTENT is a historical record, and rewriting it is not something an
 * automation should be able to do by accident.
 *
 * link_id follows create_log's semantics exactly, via the same helpers:
 *   phone → normalized to 10 digits, legacy log_link mirror forced to ''
 *   email → trimmed + lowercased,    legacy log_link mirror forced to ''
 *   contact/case/appt/bill → stored as-is, mirrored into log_link
 * An unusable phone/email value throws with err.code = 'INVALID_LOG_LINK_ID',
 * and a missing row throws with err.code = 'LOG_NOT_FOUND'.
 *
 * params:
 *   log_id     {number|string} — the log row to re-link (must exist)
 *   link_type  {string}        — 'contact','case','appt','bill','phone','email'
 *   link_id    {string|number} — entity ID, or the phone/email VALUE
 *
 * example config:
 *   {
 *     "function_name": "update_log",
 *     "params": {
 *       "log_id": "{{logId}}",
 *       "link_type": "contact",
 *       "link_id": "{{contactId}}"
 *     }
 *   }
 */

fns.update_log = async (params, db) => {
    const logService = require('../../services/logService');
    const result = await logService.updateLogLink(db, params);
    return { success: true, output: result };
  };

fns.update_log.__meta = {
  category: 'log',
  description:
    'Re-link an existing log entry to a different entity. Updates ' +
    'log_link_type / log_link_id / log_link only — never the log content, and ' +
    'never unlinks (both link_type and link_id are required).',
  params: [
    // placeholderAllowed is REQUIRED here even though the type is integer: the
    // canonical caller is a workflow doing create_log → set_vars logId →
    // update_log { log_id: "{{logId}}" }, and the validator's placeholder bypass
    // is checked BEFORE the type check, so it works on any type. Omitting it
    // (as create_appointment.appt_with does) would 400 that step at save.
    { name: 'log_id', type: 'integer', required: true, placeholderAllowed: true,
      description:
        'The log row to re-link. Must already exist — a missing row throws ' +
        "LOG_NOT_FOUND rather than creating one." },
    { name: 'link_type', type: 'enum', required: true, enum: LINK_TYPES,
      description:
        "For 'phone'/'email', link_id is the VALUE itself (normalized to 10 " +
        "digits / lowercased+trimmed) and the legacy log_link mirror is forced " +
        "to '' — identical semantics to create_log, sharing the same helpers. " +
        "The DB column also accepts 'task' and 'event'; those are deliberately " +
        "excluded here because such rows are machine-written and are not user " +
        "re-link targets. Widening this list later is additive." },
    { name: 'link_id', type: 'string', required: true, placeholderAllowed: true,
      description:
        'Entity ID for contact/case/appt/bill, OR the phone (any format, ' +
        'normalized to 10 digits) / email (lowercased+trimmed) VALUE when ' +
        'link_type is phone/email. Must be non-blank — there is no unlink path.' },
  ],
  example: { log_id: '{{logId}}', link_type: 'contact', link_id: '{{contactId}}' },
};

/**
 * phone_log
 * Phone-event log write with forensic catch-all + Layer-2 suppression.
 * Drop-in replacement for create_log in the 5 phone workflows
 * (wf17 s1, wf18 s1, wf19 s4, wf20 s4, wf21 s1). Accepts the SAME params
 * create_log accepts and returns the SAME shape ({ success, output:{log_id} })
 * so downstream steps (find_contact / cancel_sequences) read
 * {{this.output.log_id}} unchanged.
 *
 * Pipeline (per event):
 *   1. firmToFirm enrichment — stamp params.extra.firmToFirm = (other party
 *      is also a firm number). Persists into log_extra automatically since
 *      extra is the column logService stores. Queryable later; usable as a
 *      suppression match field (extra.firmToFirm).
 *   2. Write phone_event_log catch-all — ALWAYS, idempotent
 *      (INSERT ... ON DUPLICATE KEY UPDATE). Forensic; never gates logging.
 *   3. evaluateSuppressions(db, params). If suppressed: mark the catch-all
 *      row, SKIP createLogEntry, return output.log_id = null.
 *   4. Else createLogEntry, backfill catch-all.log_id, return result.
 *
 * Suppression governs the LOG WRITE only — it does NOT halt the workflow
 * (design call 1A). Downstream steps run regardless; output.suppressed is
 * surfaced for observability/branching if ever wanted.
 *
 * Firm-to-firm is NOT a hardcoded skip here — it is exposed as the
 * extra.firmToFirm match field so the operator can choose to suppress it
 * (or not) via a normal suppression rule, visible in the UI with metrics.
 */

fns.phone_log = async (params, db) => {
    // Thin skin. The full pipeline (firmToFirm enrich → phone_event_log
    // catch-all → Layer-2 suppression → Layer-3 rules → createLogEntry, plus
    // the phone_ingest_executions write and the suppressed/backfill branches)
    // lives in services/phoneIngestService.ingestPhoneEvent.
    // Lazy-required for the same circular-dep safety as logService.
    const phoneIngestService = require('../../services/phoneIngestService');
    const output = await phoneIngestService.ingestPhoneEvent(db, params || {});
    return { success: true, output };
  };

fns.phone_log.__meta = {
  category: 'log',
  description:
    'Phone-event log write with forensic catch-all (phone_event_log) + Layer-2 ' +
    'suppression (phone_log_suppressions). Drop-in for create_log in the phone ' +
    'workflows. Same params + same return shape ({success, output:{log_id}}). ' +
    'Stamps extra.firmToFirm (other party is a firm number). Suppression skips ' +
    'the user-facing log only; it does not halt the workflow.',
  params: [
    { name: 'type', type: 'enum', required: true, enum: LOG_TYPES },
    { name: 'link_type', type: 'enum', required: false, enum: LINK_TYPES },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Canonical other-party phone (any format, normalized to 10 digits) when link_type=phone.' },
    { name: 'by', type: 'integer', required: false, default: 0 },
    { name: 'data', type: 'string', required: false, multiline: true },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true },
    { name: 'message', type: 'string', required: false, placeholderAllowed: true, multiline: true },
    { name: 'direction', type: 'enum', required: false, enum: ['incoming', 'outgoing'] },
    // Declared for the same reason as on create_log — and doubly so here: the
    // pipeline itself WRITES params.extra.firmToFirm, so `extra` is part of
    // phone_log's contract, not an incidental passthrough. All 5 live phone
    // workflows pass it as an object literal.
    EXTRA_PARAM,
  ],
  example: { type: 'sms', link_type: 'phone', link_id: '{{their_number}}', by: 0,
             direction: 'incoming', from: '{{from}}', to: '{{to}}', message: '{{body}}' },
};

module.exports = fns;