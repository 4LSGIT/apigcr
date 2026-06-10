// lib/courtCitation.js
//
// Shared citation check for the court-email pipeline. Extracted verbatim (same
// logic) from scripts/courtBacktest.js so the offline backtest harness and the
// live executor (services/courtExecutor.js) score citations identically.
//
// A court_extract action is { type, fields, citations }. citations[field] is a
// verbatim substring the model copied from the email supporting fields[field].
// We verify every CITABLE citation is a whitespace-normalized substring of the
// email text. Haystack = subject + body: the subject is trusted metadata shown
// to the model ({{subject}}) and reliably carries the docket + chapter, so a
// citation may legitimately come from it.
//
// Composed / constant / boolean fields (NON_CITABLE_FIELDS) can never be exact
// substrings, so they are exempt. An action with no citations object counts as
// a miss for the action itself.

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
 * Note: each miss carries `value` in addition to {action_index, field}. The
 * backtest report records the full miss objects, so keeping `value` preserves
 * its behavior exactly; the executor only reads action_index/field.
 */
function checkCitations(subject, body, actions) {
  const haystack = normWs(`${subject || ''} ${body || ''}`);
  const misses = [];
  const list = Array.isArray(actions) ? actions : [];
  for (let i = 0; i < list.length; i++) {
    const act = list[i] || {};
    const cites = act.citations;
    if (!cites || typeof cites !== 'object') {
      misses.push({ action_index: i, field: '<no_citations>', value: null });
      continue;
    }
    for (const [field, value] of Object.entries(cites)) {
      if (NON_CITABLE_FIELDS.has(field)) continue;
      const needle = normWs(value);
      if (!needle || !haystack.includes(needle)) {
        misses.push({ action_index: i, field, value: value == null ? null : String(value) });
      }
    }
  }
  return { pass: misses.length === 0, misses };
}

module.exports = { checkCitations, NON_CITABLE_FIELDS, normWs };