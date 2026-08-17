// lib/blankDateToNull.js
//
// Blank-date guard for the generic column-update paths.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The session sql_mode is:
//   IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,
//   NO_ENGINE_SUBSTITUTION
// — note the ABSENCE of STRICT_TRANS_TABLES. Without strict mode NO_ZERO_DATE
// only raises a WARNING, so
//   UPDATE cases SET docs_due = ''
// silently stores '0000-00-00' rather than erroring.
//
// That value is not merely ugly, it is UNRECOVERABLE once read back. mysql2
// (pool configured timezone:'Z') parses a DATE '0000-00-00' as:
//   new Date(Date.UTC(0, -1, 0))      -> 1899-11-30T00:00:00.000Z
// which is BIT-IDENTICAL to a genuine DATE of '1899-11-30':
//   new Date(Date.UTC(1899, 10, 30))  -> same epoch ms (-2211753600000).
// No downstream consumer — form renderer, report, export, Google sync — can
// distinguish a corrupted cell from a real 19th-century date. contacts.
// contact_dob had two such rows, indistinguishable from real birthdays.
// The only point where the distinction still exists is BEFORE the write.
// Hence: here.
//
// ── THE BUG THIS FIXED ──────────────────────────────────────────────────────
// A zero date is non-empty, so it permanently suppressed the form renderer's
// `derive` rules, which are fill-when-empty by design (render.html "derive
// fill (2.5B B2) — ONLY when the target is empty"). cases.docs_due sat at
// 11/30/1899 and never recomputed from case_341_current. Introduced by
// clearing a date field on a form: 341notes.html's _buildPatchPayload maps
// docs_due_by -> docs_due verbatim, so an emptied input sent ''.
//
// ── SCOPE — DELIBERATELY NARROW ─────────────────────────────────────────────
// Blank ('' / whitespace) and the explicit zero-date literals become NULL, for
// KNOWN date columns only. Everything else is untouched:
//   * real dates pass through verbatim
//   * null / undefined pass through (already correct)
//   * non-date columns are never inspected ('' is legitimate for varchar)
//   * malformed-but-non-empty input stays MySQL's problem
// This is not a date parser and must not grow into one. Services that already
// validate their own dates (eventService._normalizeEventDate throws on any
// non-real calendar date) do not need it.
//
// ── MAINTENANCE ─────────────────────────────────────────────────────────────
// DATE_COLUMNS mirrors information_schema. If you ADD a date/datetime column
// to one of these tables, add it here too. An unlisted column is not a crash,
// it is a silent re-opening of this bug — which is why the sets are complete
// rather than limited to the columns forms happen to touch today.

'use strict';

/**
 * Every DATE / DATETIME / TIMESTAMP column on the tables whose update paths
 * write caller-supplied values straight into an UPDATE (caseService.updateCase,
 * contactService.updateContact, taskService.updateTask).
 *
 * Generated from:
 *   SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 *    WHERE TABLE_SCHEMA = DATABASE()
 *      AND TABLE_NAME IN ('cases','contacts','tasks')
 *      AND DATA_TYPE IN ('date','datetime','timestamp');
 */
const DATE_COLUMNS = {
  cases: new Set([
    'case_open_date',
    'case_file_date',
    'case_close_date',
    'case_discharge_date',
    'matrix_date_original',
    'matrix_date_proposed',
    'schedules_due_original',
    'schedules_due_proposed',
    'final_installment',
    'show_cause',
    'filing_fee_extended_deadline',
    'docs_due',
    'case_341_current',
    'case_341_initial',
    'case_objection',
    'case_180',
    'case_preference',
  ]),
  contacts: new Set([
    'contact_dob',
    'contact_google_synced_at',
    'contact_created',
    'contact_updated',
  ]),
  tasks: new Set([
    'task_date',
    'task_start',
    'task_due',
    'task_last_update',
  ]),
};

// Explicit zero-date literals a caller might pass through by hand. Matched
// case-insensitively after trimming; anything else non-empty is left alone.
const ZERO_LITERALS = new Set([
  '0000-00-00',
  '0000-00-00 00:00:00',
  '0000-00-00t00:00:00',
]);

/**
 * True when `value` is a blank/zero date that must not reach a DATE column.
 * Date objects, numbers and real strings are never blank.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isBlankDate(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s === '' || ZERO_LITERALS.has(s.toLowerCase());
}

/**
 * Return a shallow copy of `fields` with blank values on known date columns
 * converted to null.
 *
 * @param {string} table    'cases' | 'contacts' | 'tasks'
 * @param {object} fields   column -> value map destined for an UPDATE
 * @returns {object}        new object; `fields` is never mutated
 */
function blankDatesToNull(table, fields) {
  const cols = DATE_COLUMNS[table];
  if (!cols || !fields) return { ...fields };

  const out = { ...fields };
  for (const key of Object.keys(out)) {
    if (cols.has(key) && isBlankDate(out[key])) out[key] = null;
  }
  return out;
}

module.exports = { blankDatesToNull, isBlankDate, DATE_COLUMNS };