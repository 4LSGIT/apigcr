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
 *                                   'status','note','court email','docs','appt','update'
 *   link_type    {string|null}    — 'contact','case','appt','bill','phone','email' (optional)
 *   link_id      {string|number}  — the ID for the link (optional)
 *   by           {number}         — user ID (0 for system/automation)
 *   data         {string|object}  — log_data content (JSON string or object)
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
    { name: 'type', type: 'enum', required: true,
      enum: ['email','sms','call','other','form','status','note','court email','docs','appt','update','task'] },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill','phone','email'],
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
  ],
  example: { type: 'note', link_type: 'contact', link_id: '{{contactId}}', by: 0,
             data: 'Auto follow-up sent' }
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
    // Thin skin. The pipeline (firmToFirm enrich → phone_event_log catch-all →
    // Layer-2 suppression → createLogEntry, with the suppressed/backfill
    // branches) lives in services/phoneIngestService.ingestPhoneEvent. Layer 3
    // (rules + executions) will be wired inside that service by a later worker.
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
    { name: 'type', type: 'enum', required: true,
      enum: ['email','sms','call','other','form','status','note','court email','docs','appt','update','task'] },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill','phone','email'] },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Canonical other-party phone (any format, normalized to 10 digits) when link_type=phone.' },
    { name: 'by', type: 'integer', required: false, default: 0 },
    { name: 'data', type: 'string', required: false, multiline: true },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true },
    { name: 'message', type: 'string', required: false, placeholderAllowed: true, multiline: true },
    { name: 'direction', type: 'enum', required: false, enum: ['incoming', 'outgoing'] },
  ],
  example: { type: 'sms', link_type: 'phone', link_id: '{{their_number}}', by: 0,
             direction: 'incoming', from: '{{from}}', to: '{{to}}', message: '{{body}}' },
};

module.exports = fns;
