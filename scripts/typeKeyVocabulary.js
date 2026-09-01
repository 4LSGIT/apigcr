// scripts/typeKeyVocabulary.js
//
/**
 * FROZEN TYPE-KEY VOCABULARY — 2026-09-01  (Unified Events U3)
 * scripts/typeKeyVocabulary.js
 *
 * Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md Appendix A (the v1
 * vocabulary), §0.1 "E1 ↔ U-series alignment", §7 (U2, U3).
 *
 * ── FROZEN. SOURCE FOR THE U2 BACKFILL GENERATOR ONLY. ─────────────────────
 * ── NEVER IMPORTED BY A SERVICE. ───────────────────────────────────────────
 *
 * This is the read-time derivation E1 shipped, lifted VERBATIM out of
 * services/caseEventService.js at U3. It is history, not policy:
 *
 *   · The RUNTIME source of truth is the `type_key` COLUMN on `events` and
 *     `appts`, written by every write path since U2 and read by
 *     caseEventService since U3.
 *   · The WRITE-TIME source of truth is the `calendar_item_types` registry,
 *     served by services/calendarTypeService.js. New types are minted THERE.
 *   · This file is neither. It exists so scripts/genTypeKeyBackfill.js can
 *     regenerate U2's committed migration blocks and
 *     tests/genTypeKeyBackfill.test.js can byte-check them. That check is what
 *     proves the column was filled with exactly the keys E1 derived — the
 *     guarantee that made U3's swap a no-op on the data.
 *
 * DO NOT ADD TYPES HERE. Adding one would change the generated backfill for a
 * migration that has already run, breaking the byte-equality test for no gain:
 * the migration is applied, and a new type belongs in `calendar_item_types`
 * (and, until U2b ships the admin CRUD, in scripts/calendarTypeSeed.js).
 *
 * Two live rows already prove the point — both created 2026-09-01, after U2's
 * backend deploy, and both DIVERGING from this file:
 *
 *   event 156 'Mediation'      — absent here; the column holds type_key NULL
 *                                and kind 'other' (v0.5 §3.3, U2 ruling D7).
 *   appt 3966 'Potato Hunting' — absent here; the registry resolved it to
 *                                'test' through ingest_aliases at write time.
 *
 * The column is right in both cases and this file is stale in both cases. That
 * is the intended end state, which is why nothing reads it at runtime.
 *
 * Usage (generator and its tests only):
 *   const vocab = require('./typeKeyVocabulary');
 *   vocab.EVENT_TYPE_KEYS / vocab.APPT_TYPE_KEYS / vocab.EVENT_ROW_OVERRIDES
 */

'use strict';


// ─────────────────────────────────────────────────────────────────────────────
// THE VOCABULARY, VERBATIM AS E1 SHIPPED IT
//
// Everything below this line — including the comments, which record the
// reasoning and the live row counts as measured on 2026-08-30 — is byte-for-byte
// what stood in services/caseEventService.js between E1 and U3. It is quoted,
// not maintained. Read it in the past tense.
//
// Maps, not object literals: a plain object would resolve '__proto__',
// 'constructor' and 'toString' as if they were vocabulary entries. Free-text
// type columns can contain anything.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lookup normalization: trim + lowercase.
 *
 * NOT a nicety — it is the collation. `events.event_type` and `appts.appt_type`
 * are utf8mb4_general_ci, so MySQL considers 'Pre-filing Meeting' and
 * 'Pre-Filing Meeting' THE SAME VALUE. The v0.5 §3 vocabulary was itself
 * derived from a `GROUP BY appt_type` census run under that collation, so it
 * lists exactly ONE spelling per case-insensitive group — while the table
 * stores the variants. Measured live 2026-08-30 with CAST(... AS BINARY):
 *
 *     'Pre-filing Meeting'            316 rows   ← vocabulary says 'Pre-Filing Meeting'
 *     'Meeting'                       108 rows   ← vocabulary says 'meeting'
 *     'Pre-Filing Meeting'             15 rows
 *     'Schedules completion meeting'    1 row    ← vocabulary says 'Schedules Completion…'
 *
 * An exact-string lookup therefore misses 425 of 2,216 appts (19%) — including
 * the DOMINANT spelling of the second-most-common appointment type — and drops
 * every one of them to raw passthrough with a null kind. The tab would render
 * a fifth of all appointments unclassified.
 *
 * The decisive argument is not the miss rate, it is U2. That slice backfills
 * the `type_key` column with a SQL `UPDATE … WHERE appt_type = 'Pre-Filing
 * Meeting'`, which runs under general_ci and therefore matches all 331 rows.
 * If E1 matched case-sensitively, 425 rows would silently CHANGE key the day
 * the column landed — the exact drift this whole alignment exists to prevent
 * (v0.5 §0). Matching the column's own equality semantics is what keeps E1 and
 * U2 in agreement.
 *
 * Trim is defensive: no live value is padded (verified 0 rows on both tables),
 * but free text is free text. general_ci also folds accents; nothing in either
 * vocabulary is accented, so lower+trim is the honest approximation and the
 * guard below is what catches it if that ever stops being true.
 */
const _vkey = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Build a normalized vocabulary Map, refusing to build a lossy one.
 *
 * If two entries normalize to the same lookup key with DIFFERENT values, one
 * would silently shadow the other and a whole type would map wrong with no
 * symptom. That is a load-time throw, not a warning: the module is the single
 * mapping site, and a broken vocabulary must not reach production quietly.
 * Duplicate entries agreeing on their value are fine (the vocabulary
 * deliberately lists spelling variants that share a key).
 */
function _vocab(label, obj) {
  const m = new Map();
  for (const [raw, val] of Object.entries(obj)) {
    const k = _vkey(raw);
    const prior = m.get(k);
    if (prior && (prior[0] !== val[0] || prior[1] !== val[1])) {
      throw new Error(
        `caseEventService ${label} vocabulary: ${JSON.stringify(raw)} normalizes to ` +
        `${JSON.stringify(k)}, which already maps to [${prior}] — refusing to shadow it ` +
        `with [${val}]. Give the two entries distinct keys or reconcile their values.`
      );
    }
    m.set(k, val);
  }
  return m;
}

/** events.event_type → [type_key, kind_key]. v0.5 §3.1. */
const EVENT_TYPE_KEYS = _vocab('event', {
  'Confirmation Hearing':               ['confirmation_hearing', 'hearing'],
  'confirmation_hearing':               ['confirmation_hearing', 'hearing'],
  'Hearing':                            ['hearing', 'hearing'],
  'Show Cause':                         ['show_cause', 'hearing'],
  'Show Cause Hearing':                 ['show_cause', 'hearing'],
  'Trial':                              ['trial', 'hearing'],
  'Trial / Pre-Trial Hearing':          ['trial', 'hearing'],
  'Telephonic Status Conference':       ['status_conference', 'conference'],
  'Status Conference':                  ['status_conference', 'conference'],
  'Initial Scheduling Conference':      ['scheduling_conference', 'conference'],
  'Pre-trial Conference':               ['pretrial_conference', 'conference'],
  'Deposition':                         ['deposition', 'conference'],
  '341':                                ['meeting_341', 'meeting'],
  'dischargeability_due':               ['dischargeability_due', 'deadline'],
  'object_confirmation_due':            ['object_confirmation_due', 'deadline'],
  'poc_due':                            ['poc_due', 'deadline'],
  'poc_gov_due':                        ['poc_gov_due', 'deadline'],
  'Docs Deadline':                      ['docs_deadline', 'deadline'],
  'Schedules Deadline':                 ['schedules_deadline', 'deadline'],
  'Confirmation Certificate Deadline':  ['confirmation_certificate_deadline', 'deadline'],
  'Filing Fee Deadline':                ['filing_fee_deadline', 'deadline'],
  'Filing Fee Installment Deadline':    ['filing_fee_installment_deadline', 'deadline'],
  'Deadline':                           ['deadline', 'deadline'],
  'Order':                              ['order', 'other'],
  'Milestone':                          ['milestone', 'other'],
});

/** appts.appt_type → [type_key, kind_key]. v0.5 §3.2. */
const APPT_TYPE_KEYS = _vocab('appt', {
  'Initial Strategy Session':      ['iss', 'meeting'],
  'Intial Strategy Session':       ['iss', 'meeting'],          // live typo, deliberate
  'Strategy Session':              ['ss', 'meeting'],           // distinct from iss (Fred)
  'Strategy Session Follow Up':    ['ss_follow_up', 'meeting'],
  'Follow Up':                     ['ss_follow_up', 'meeting'],
  'Pre-Filing Meeting':            ['pre_filing', 'meeting'],
  'Pre-filing (30 min)':           ['pre_filing', 'meeting'],
  '341 Meeting':                   ['meeting_341', 'meeting'],  // same key as the events side
  'Schedules Completion Meeting':  ['schedules_meeting', 'meeting'],
  'Documents Completion Meeting':  ['docs_meeting', 'meeting'],
  'Matrix Completion Meeting':     ['matrix_meeting', 'meeting'],
  'meeting':                       ['meeting', 'meeting'],
  'None':                          ['meeting', 'meeting'],      // the literal string, not SQL NULL
  'to go over claims':             ['meeting', 'meeting'],
  'to go over objections to Chapt': ['meeting', 'meeting'],
  'Case Status Review':            ['meeting', 'meeting'],
  'Consultation':                  ['consultation', 'meeting'],
  'Pre-Lawsuit Meeting':           ['pre_lawsuit', 'meeting'],
  'Pre Lawsuit Meeting':           ['pre_lawsuit', 'meeting'],
  'Tax Consult':                   ['tax_consult', 'meeting'],
  'test':                          ['test', 'meeting'],
  'test appt':                     ['test', 'meeting'],
  'test2 appt':                    ['test', 'meeting'],
  'test3 appt':                    ['test', 'meeting'],
  'Test Appointment':              ['test', 'meeting'],
  'Pizza Party':                   ['test', 'meeting'],
  'bug hunting Session':           ['test', 'meeting'],
  'Repetitive Session':            ['test', 'meeting'],
});

/**
 * Per-ROW event overrides (`events_row_overrides` in the scratch vocabulary).
 * Four live rows whose `event_type` string does not describe what the row IS:
 *
 *   107  'Order'      → the row is "Order Extending Time to Pay Case Filing
 *                       Fee"; the date it carries IS the extended deadline.
 *   134  'Trial / Pre-Trial Hearing'
 *                     → "Order CANCELING Trial and Pre-Trial Hearing Dates".
 *   4    'Milestone'  → "Reminder smoke", unlinked, Canceled.
 *   6    'Deadline'   → test row on contact 1001, Canceled.
 *
 * These are here for the SAME reason the vocabulary is: U1/E0b writes exactly
 * these values into the columns, so applying them now is what keeps E1's output
 * stable across U2. Omitting them would make event 107's type_key change from
 * 'order' to 'filing_fee_deadline' the day the column landed — precisely the
 * drift this alignment exists to prevent.
 *
 * NOT APPLIED HERE: row 134's accompanying `event_status = 'Canceled'` fix.
 * That is a WRITE and belongs to U1; E1 is read-only. Until U1 runs, event 134
 * renders as a live scheduled trial on case-scope reads. Known and accepted —
 * flagged rather than silently patched at read time, because a read layer that
 * disagrees with the row it is reading is a worse bug than a stale row.
 */
const EVENT_ROW_OVERRIDES = new Map([
  [6,   ['test', 'other']],
  [4,   ['test', 'other']],
  [107, ['filing_fee_deadline', 'deadline']],
  [134, ['trial', 'hearing']],
]);


module.exports = {
  EVENT_TYPE_KEYS,
  APPT_TYPE_KEYS,
  EVENT_ROW_OVERRIDES,
  _vkey,
  _vocab,
};
