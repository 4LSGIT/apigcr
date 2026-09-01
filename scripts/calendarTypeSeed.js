// scripts/calendarTypeSeed.js
//
/**
 * calendar_item_types SEED — the one source (Unified Events U2, A.2).
 *
 * Governing: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.3 + Appendix A; the U2 prompt
 * table with CAL's defaults; Fred's rulings 2026-09-01:
 *   D1  kind enum order is the COLUMN's order ('hearing','meeting','deadline',
 *       'conference','other'), not the doc's — see services/calendarTypeService.KINDS.
 *   D5  ingest_aliases never contains the row's own label under general_ci.
 *       Dropped from the prompt table: 'Pre-filing Meeting' (== 'Pre-Filing
 *       Meeting'), 'Schedules completion meeting' (== 'Schedules Completion
 *       Meeting'). Resolution is unaffected — the label matches by itself.
 *
 * Consumed by:
 *   scripts/genTypeKeyBackfill.js   → the migration's generated seed block +
 *                                      tests/fixtures/calendar_item_types.seed.json
 *   tests/calendarTypeService.test.js → parity against caseEventService (E1)
 *
 * `singleton`, `blocks_default`, `client_attends` are DATA ONLY in U2 —
 * nothing enforces them until U6. Fred adjusts values in the table, not here;
 * this file is the day-one seed and the ON DUPLICATE KEY UPDATE only touches
 * `label`, so a re-run never overwrites a live edit to the other columns.
 *
 * Column order here == the INSERT column order the generator emits.
 */

'use strict';

// [type_key, label, kind, singleton, blocks_default, client_attends, default_length, ingest_aliases, case_types, active, sort_order]
const BK  = ['Bankruptcy'];
const CIV = ['Civil Litigation'];

const SEED = [
  // ── meetings (kind=meeting → appts under §3.3.2) ──────────────────────────
  ['iss',                 'Initial Strategy Session',    'meeting', 0, 'attendee', 1, 15,  ['Intial Strategy Session'],                                             null, 1, 10],
  ['ss',                  'Strategy Session',            'meeting', 0, 'attendee', 1, 15,  [],                                                                      null, 1, 20],
  ['ss_follow_up',        'Strategy Session Follow Up',  'meeting', 0, 'attendee', 1, 15,  ['Follow Up'],                                                           null, 1, 30],
  ['consultation',        'Consultation',                'meeting', 0, 'attendee', 1, 30,  [],                                                                      null, 1, 40],
  ['pre_filing',          'Pre-Filing Meeting',          'meeting', 0, 'attendee', 1, 30,  ['Pre-filing (30 min)'],                                                 BK,   1, 50],
  ['meeting_341',         '341 Meeting',                 'meeting', 1, 'attendee', 1, 10,  ['341'],                                                                 BK,   1, 60],
  ['schedules_meeting',   'Schedules Completion Meeting','meeting', 0, 'attendee', 1, 45,  [],                                                                      BK,   1, 70],
  ['docs_meeting',        'Documents Completion Meeting','meeting', 0, 'attendee', 1, 30,  [],                                                                      BK,   1, 80],
  ['matrix_meeting',      'Matrix Completion Meeting',   'meeting', 0, 'attendee', 1, 30,  [],                                                                      BK,   1, 90],
  ['pre_lawsuit',         'Pre-Lawsuit Meeting',         'meeting', 0, 'attendee', 1, 30,  ['Pre Lawsuit Meeting'],                                                 CIV,  1, 100],
  ['tax_consult',         'Tax Consult',                 'meeting', 0, 'attendee', 1, 30,  ['Tax Consultation'],                                                    null, 1, 110],
  ['meeting',             'Meeting',                     'meeting', 0, 'attendee', 1, 15,  ['to go over claims', 'to go over objections to Chapt', 'Case Status Review'], null, 1, 120],

  // ── hearings ──────────────────────────────────────────────────────────────
  ['confirmation_hearing','Confirmation Hearing',        'hearing', 1, 'attendee', 0, 30,  [],                                                                      BK,   1, 200],
  ['show_cause',          'Show Cause Hearing',          'hearing', 1, 'none',     0, 30,  ['Show Cause'],                                                          BK,   1, 210],
  ['hearing',             'Hearing',                     'hearing', 0, 'attendee', 0, 30,  ['Court Date'],                                                          null, 1, 220],
  ['trial',               'Trial',                       'hearing', 0, 'attendee', 0, null,['Trial / Pre-Trial Hearing'],                                           null, 1, 230],

  // ── conferences ───────────────────────────────────────────────────────────
  ['status_conference',   'Status Conference',           'conference', 0, 'attendee', 0, 30, ['Telephonic Status Conference'],                                      null, 1, 300],
  ['scheduling_conference','Initial Scheduling Conference','conference',0,'attendee', 0, 30, [],                                                                    null, 1, 310],
  ['pretrial_conference', 'Pre-trial Conference',        'conference', 0, 'attendee', 0, 30, [],                                                                    null, 1, 320],
  ['deposition',          'Deposition',                  'conference', 0, 'attendee', 1, 240,[],                                                                    null, 1, 330],

  // ── deadlines ─────────────────────────────────────────────────────────────
  ['docs_deadline',                     'Docs Deadline',                        'deadline', 1, 'none', 0, null, [], BK,   1, 400],
  ['schedules_deadline',                'Schedules Deadline',                   'deadline', 1, 'none', 0, null, [], BK,   1, 410],
  ['dischargeability_due',              'Dischargeability Deadline',            'deadline', 1, 'none', 0, null, [], BK,   1, 420],
  ['object_confirmation_due',           'Objection to Confirmation Deadline',   'deadline', 1, 'none', 0, null, [], BK,   1, 430],
  ['poc_due',                           'Proof of Claim Deadline',              'deadline', 1, 'none', 0, null, [], BK,   1, 440],
  ['poc_gov_due',                       'Governmental Proof of Claim Deadline', 'deadline', 1, 'none', 0, null, [], BK,   1, 450],
  ['confirmation_certificate_deadline', 'Confirmation Certificate Deadline',    'deadline', 1, 'none', 0, null, [], BK,   1, 460],
  ['filing_fee_deadline',               'Filing Fee Deadline',                  'deadline', 1, 'none', 0, null, [], BK,   1, 470],
  ['filing_fee_installment_deadline',   'Filing Fee Installment Deadline',      'deadline', 0, 'none', 0, null, [], BK,   1, 480],
  ['deadline',                          'Deadline',                             'deadline', 0, 'none', 0, null, [], null, 1, 490],

  // ── other ─────────────────────────────────────────────────────────────────
  ['order',     'Order',     'other', 0, 'none', 0, null, [],   null, 1, 500],
  ['milestone', 'Milestone', 'other', 0, 'none', 0, null, [],   null, 1, 510],
  ['internal',  'Internal',  'other', 0, 'firm', 0, null, [],   null, 1, 520],
  ['test',      'Test',      'other', 0, 'none', 0, null,
    ['test appt', 'test2 appt', 'test3 appt', 'Test Appointment', 'Pizza Party', 'bug hunting Session', 'Repetitive Session', 'Potato Hunting'],
    null, 0, 999],
];

const COLUMNS = ['type_key', 'label', 'kind', 'singleton', 'blocks_default', 'client_attends',
                 'default_length', 'ingest_aliases', 'case_types', 'active', 'sort_order'];

/** SEED as an array of plain objects keyed by COLUMNS (the fixture shape). */
function seedRows() {
  return SEED.map((arr) => {
    const o = {};
    COLUMNS.forEach((c, i) => { o[c] = arr[i]; });
    return o;
  });
}

module.exports = { SEED, COLUMNS, seedRows };
