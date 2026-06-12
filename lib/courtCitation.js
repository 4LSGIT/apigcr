// lib/courtCitation.js
//
// Shared citation check for the court-email pipeline. Extracted (same substring
// logic) from scripts/courtBacktest.js so the offline backtest harness and the
// live executor (services/courtExecutor.js) score citations identically.
//
// A court_extract action is { type, fields, citations }. citations[field] is a
// verbatim substring the model copied from the email supporting fields[field].
// Haystack = subject + body: the subject is trusted metadata shown to the model
// ({{subject}}) and reliably carries the docket + chapter, so a citation may
// legitimately come from it.
//
// ── INVARIANT (Slice 4b harden #2 — STRICTER) ─────────────────────────────
// Citation coverage is now MANDATORY, not just validated-if-present:
//   For every action, EVERY field in `fields` that is NOT in NON_CITABLE_FIELDS
//   MUST have a citations[field] entry, and that entry MUST be a
//   whitespace-normalized substring of the haystack.
// Failure modes, each pushed as a miss { action_index, field, value }:
//   (a) a citable field present in `fields` with NO citations key  → value:null
//       (a missing/required citation)
//   (b) a citation that DOES exist but is NOT a substring           → value:<quote>
//       (the original fabricated-quote check, retained)
// NON_CITABLE_FIELDS (composed labels / constants / booleans) are exempt: they
// can never be exact substrings. An action whose only fields are non-citable
// therefore needs no citations and passes. citations present for fields NOT in
// `fields` are still substring-checked (fabricated-quote defense).
//
// NULL/BLANK EXEMPTION: a field present in `fields` whose value is null or an
// empty/whitespace string requires NO citation — there is nothing to verify
// (e.g. a hearing notice that states no location → location:null). This keeps
// legitimately-incomplete events from being forced into the review queue.

/**
 * Model-COMPOSED labels / constants / booleans, not values extracted verbatim
 * from the email — exempt from the substring check. event_type / event_title
 * are concise labels the model writes; appt_type is the constant "341 Meeting";
 * all_day is a boolean.
 */
const NON_CITABLE_FIELDS = new Set(['event_type', 'event_title', 'appt_type', 'all_day']);

/** Collapse all whitespace runs to single spaces, trim. */
function normWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} subject   trusted email subject
 * @param {string} body      raw email body
 * @param {Array}  actions   court_extract `actions` array
 * @returns {{ pass:boolean, misses:Array<{action_index:number, field:string, value:(string|null)}> }}
 *
 * Each miss carries `value` in addition to {action_index, field}: a required-but-
 * absent citation reports value:null; a present-but-fabricated citation reports
 * the offending quote. The backtest report records the full miss objects; the
 * executor only reads action_index/field.
 */
function checkCitations(subject, body, actions) {
  const haystack = normWs(`${subject || ''} ${body || ''}`);
  const misses = [];
  const list = Array.isArray(actions) ? actions : [];

  for (let i = 0; i < list.length; i++) {
    const act = list[i] || {};
    const fields = (act.fields && typeof act.fields === 'object') ? act.fields : {};
    const cites = (act.citations && typeof act.citations === 'object') ? act.citations : {};

    // Union of the field keys and any extra citation keys: every citable field
    // in `fields` is REQUIRED to have a valid citation; any extra citation that
    // exists is still substring-checked (fabricated-quote defense).
    const names = new Set([...Object.keys(fields), ...Object.keys(cites)]);

    for (const field of names) {
      if (NON_CITABLE_FIELDS.has(field)) continue;

      // A field DECLARED in `fields` with a null/blank value carries nothing to
      // verify — you can't cite the absence of a value (e.g. location:null when
      // the email states no courtroom; a hearing notice with no location must
      // not be forced to queue). Skip it. Fields with a real value still require
      // a citation, and citation keys for fields NOT in `fields` still fall
      // through to the substring check below (fabricated-quote defense).
      if (Object.prototype.hasOwnProperty.call(fields, field)) {
        const fv = fields[field];
        if (fv == null || (typeof fv === 'string' && fv.trim() === '')) continue;
      }

      const hasCite = Object.prototype.hasOwnProperty.call(cites, field);
      if (!hasCite) {
        // citable field declared in `fields` with no citation key → required miss
        misses.push({ action_index: i, field, value: null });
        continue;
      }

      const value = cites[field];
      const needle = normWs(value);
      if (!needle || !haystack.includes(needle)) {
        misses.push({ action_index: i, field, value: value == null ? null : String(value) });
      }
    }
  }

  return { pass: misses.length === 0, misses };
}

module.exports = { checkCitations, NON_CITABLE_FIELDS, normWs };