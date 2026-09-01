// services/caseEventService.js
//
/**
 * Case Event Service — THE UNIFIED CALENDAR READ LAYER  (Unified Events E1)
 * services/caseEventService.js
 *
 * Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_4.md §3.1 / §3.4 / §7-E1,
 * as amended by ref/UNIFIED_EVENTS_DESIGN_V0_5_AMENDMENTS.md (§0 carve-out,
 * §3 vocabulary, §5 status model). Where the two conflict, v0.5 wins.
 *
 * ONE question, answered once: "what dated things does this case have?"
 * Today that answer lives in two tables with two vocabularies, two status
 * enums, two link shapes and two notions of a dead row. Every consumer that
 * wants a case timeline — the staff tab this slice ships, the R2 event
 * detector, the portal, court v2 — otherwise re-derives all of that, and any
 * two of them derive it differently. This service is the single derivation.
 *
 * READ-ONLY. No writes, no DDL, no side effects, no domain events. It does not
 * touch eventService or apptService (both on the v0.5 §0 hold list) — it reads
 * their tables directly and owns none of them.
 *
 * ── THE FROZEN ROW SHAPE (v0.4 §3.1) ────────────────────────────────────────
 *
 *   {
 *     source:      'event' | 'appt',
 *     source_id:   number,              // events.event_id | appts.appt_id
 *     case_id:     string,              // the case this row was bucketed to
 *     kind_key:    string | null,       // 'hearing'|'meeting'|'deadline'|'conference'|'other'
 *     type_key:    string | null,       // v0.5 §3 vocabulary key
 *     title:       string | null,
 *     starts_at:   string | null,       // 'YYYY-MM-DD HH:MM:SS' firm-local NAIVE
 *     ends_at:     string | null,       // same shape, or null
 *     all_day:     boolean,
 *     status_norm: 'scheduled'|'held'|'missed'|'canceled'|null,
 *     location:    string | null,
 *   }
 *
 * Under `includeSuperseded: true` ONLY, dead rows are returned too and carry
 * `superseded: true`. EVENT-source dead rows additionally carry
 * `superseded_by_event_id` and `supersede_reason`; APPT tombstones carry
 * neither, because no such data exists — v0.4 §3.4's stated asymmetry (events
 * chain, appts tombstone). Default-shape rows omit all three keys entirely, so
 * the frozen R2 contract sees exactly the shape above and nothing more.
 *
 * ── WHY A SERVICE AND NOT A SQL VIEW (v0.4 §3.1, load-bearing) ──────────────
 *
 * MySQL temptable-materializes a UNION view. R2's event detector reads this
 * per case inside portal/list loops, so a view would materialize a temp table
 * per case per loop iteration. Per-source parameterized queries unioned and
 * sorted in JS keep the cost linear and the plan inspectable. Do not "simplify"
 * this into a VIEW or a single UNION query.
 *
 * ── QUERY BUDGET: EXACTLY 3, REGARDLESS OF N CASES ─────────────────────────
 *
 *   1. cases          — the ids' canonical casing + both docket columns
 *   2. events         — one query covering every id AND every docket
 *   3. appts          — one query covering every id
 *
 * `opts` adds ZERO queries (from/to and includeSuperseded are WHERE clauses on
 * the same three). `listForCase` is also 3: it derives its 404 from query 1's
 * result rather than paying a separate existence probe. Empty input, or input
 * where no id resolves to a real case, short-circuits at 1 query (or 0 for a
 * literally empty list). Asserted in tests/caseEventService.test.js.
 *
 * ── WHY THE DOCKET JOIN IS NOT THE LOG-FEED LANDMINE ───────────────────────
 *
 * The global log feed's `cases` join plans as "Range checked for each record"
 * — a per-ROW runtime range decision, fast at ~1k cases and degrading
 * non-linearly as `cases` grows (scratch fred/log_feed_cases_index_health).
 * That shape needs the driving side to be the large table with `cases` probed
 * per row.
 *
 * This layer inverts it. `cases` is touched ONCE, by primary key, for the N ids
 * the caller named — N is 1 for the staff tab and bounded by the page size for
 * a list loop, never by the size of `cases`. The dockets then travel as a
 * literal IN list of bound parameters into the events query, where the driving
 * table is `events` on `idx_events_link (event_link_type, event_link_id)`. The
 * planner sees constants, not a correlated subquery, so growth in `cases`
 * cannot change the events plan. The two docket indexes
 * (`idx_cases_case_number`, `idx_cases_case_number_full`) are not even on this
 * path — they serve the reverse direction, which this service never walks.
 *
 * ── TIMEZONE: NAIVE FIRM-LOCAL, NO CONVERSION ANYWHERE ─────────────────────
 *
 * Every datetime this service emits is a naive firm-local wall time formatted
 * 'YYYY-MM-DD HH:MM:SS'. That literal shape is chosen so it can never be
 * mistaken for a UTC instant: there is no 'T' and no 'Z', it is exactly a MySQL
 * DATETIME literal, and consumers slice it as a string rather than feeding it
 * to `new Date()`.
 *
 * The appt side reads `appt_date` and NEVER `appt_date_utc`. They differ on
 * 2,109 of 2,216 rows (95.2%, live 2026-08-30); picking the wrong one is a
 * silent five-hour offset that no test would catch by inspection. Pinned by
 * test, not by comment alone.
 *
 * ── EXPORTS ────────────────────────────────────────────────────────────────
 *
 *   listForCase(db, caseId, opts)   → Promise<row[]>       (404s on unknown case)
 *   listForCases(db, caseIds, opts) → Promise<Map<caseId, row[]>>  (silent absence)
 *   auditOrphans(db)                → Promise<orphanRow[]>
 *   (+ _-prefixed test helpers — repo pattern)
 *
 * Usage:
 *   const caseEventService = require('../services/caseEventService');
 *   const rows = await caseEventService.listForCase(db, 'TYL6KJN8');
 */

'use strict';

const { DateTime } = require('luxon');
const { FIRM_TZ }  = require('./timezoneService');


// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE MAPPING SITE  (v0.5 §0: "E1 ↔ U-series alignment")
//
// type_key / kind_key are derived HERE and nowhere else. The vocabulary below
// mirrors scratch `fred/calendar_type_keys_v1`, which is the machine-readable
// form of v0.5 §3 and is also what U2's backfill writes into the `type_key`
// column. Deriving from the same table the column will be filled from is the
// whole point: E1's output does not change when U2 lands — only its SOURCING
// swaps, at this one site, in the U3 alignment pass.
//
// That is why this is NOT an ad-hoc map. An ad-hoc map would have produced keys
// that silently changed the day the column arrived.
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

/**
 * Unmapped free text is passed through RAW with a null kind and one warning
 * (Fred's ruling, 2026-08-30): honest passthrough, never an invented key.
 *
 * This deliberately overrides the scratch vocabulary's `unmapped_fallback`
 * (`['meeting','meeting']`). That fallback would have laundered an unknown
 * string into a real key and, worse, into a `kind` that decides STORAGE under
 * v0.5 §4 ('meeting' → appts). A wrong key that looks right is unrecoverable
 * once consumers bind to it; a raw passthrough with a null kind is visibly
 * unclassified and self-reports in the log. CAL should drop `unmapped_fallback`
 * from the scratch key at U0.
 *
 * A NULL or blank type is not "an unrecognized string" — it is absent data, so
 * it yields nulls without a warning (8 live appts have appt_type NULL).
 *
 * Warnings are deduped per (source, raw) for the life of the process: this runs
 * inside list loops and an undeduped warn would flood the log with one line per
 * row per page.
 */
const _warnedTypes = new Set();

function _warnUnmapped(source, raw) {
  const k = `${source}\u0000${raw}`;
  if (_warnedTypes.has(k)) return;
  _warnedTypes.add(k);
  console.warn(
    `[caseEventService] ${source} type not in calendar_type_keys_v1: ` +
    `${JSON.stringify(raw)} — passing through raw with kind_key null. ` +
    `Add it to the vocabulary (v0.5 §3 / scratch fred/calendar_type_keys_v1) ` +
    `if it is a real type.`
  );
}

/**
 * THE derivation. Row override → vocabulary → raw passthrough.
 *
 * @param {'event'|'appt'} source
 * @param {*} rawType   events.event_type | appts.appt_type
 * @param {number} sourceId
 * @returns {{ type_key: string|null, kind_key: string|null }}
 */
function _deriveKeys(source, rawType, sourceId) {
  if (source === 'event') {
    const ov = EVENT_ROW_OVERRIDES.get(Number(sourceId));
    if (ov) return { type_key: ov[0], kind_key: ov[1] };
  }

  const raw = rawType == null ? '' : String(rawType);
  if (raw.trim() === '') return { type_key: null, kind_key: null };

  const hit = (source === 'event' ? EVENT_TYPE_KEYS : APPT_TYPE_KEYS).get(_vkey(raw));
  if (hit) return { type_key: hit[0], kind_key: hit[1] };

  _warnUnmapped(source, raw);
  return { type_key: raw, kind_key: null };
}


// ─────────────────────────────────────────────────────────────────────────────
// STATUS NORMALIZATION  (v0.4 §3.1; v0.5 §5 confirms the blank-appt row)
//
// v0.5 §5 extends this to a { state, resolution } pair — that extension is U3's
// alignment pass, explicitly NOT this slice. What ships here is v0.4's
// status_norm, which v0.5 keeps as "the R2-facing projection" of the richer
// model. Do not add `state` here; add it in U3 alongside events.event_resolution.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_STATUS_NORM = new Map(Object.entries({
  'Scheduled': 'scheduled',
  'Completed': 'held',
  'Canceled':  'canceled',
}));

const APPT_STATUS_NORM = new Map(Object.entries({
  'Scheduled': 'scheduled',
  'Attended':  'held',
  'No Show':   'missed',
  'Canceled':  'canceled',
  // 'Rescheduled' is deliberately ABSENT: it is a tombstone, not a status.
  // Excluded from default reads entirely; under includeSuperseded it surfaces
  // with status_norm null and superseded:true. See _mapAppt.
}));

/**
 * Six live appts (ids 1795, 1796, 1807, 1808, 1811, 1819 — all 2024) carry
 * `appt_status = ''`: the classic silent-blank enum write from a session
 * without STRICT_TRANS_TABLES. They are real appointments (Strategy Session,
 * Pre-Filing Meeting) whose outcome nobody recorded.
 *
 * They normalize to NULL, not to 'held' and not to 'scheduled'. Ruling (Fred,
 * 2026-08-30): never launder unknown into a real value — the same principle as
 * E0a's honest-NULL decision on un-backfilled reschedule lineage. The UI
 * renders a null status neutrally.
 */
function _normStatus(source, raw) {
  const m = source === 'event' ? EVENT_STATUS_NORM : APPT_STATUS_NORM;
  return m.get(String(raw == null ? '' : raw)) || null;
}


// ─────────────────────────────────────────────────────────────────────────────
// NAIVE FIRM-LOCAL DATETIME HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 'YYYY-MM-DD' from a DATE/DATETIME column value.
 *
 * The pool runs `timezone: 'Z'` (startup/db.js), so mysql2 hands back a JS Date
 * whose UTC fields ARE the stored naive wall-clock components. Slicing the ISO
 * form therefore preserves the calendar date exactly as stored — the same read
 * eventService._dateOnly and lib/portalCardEngine perform.
 */
function _dateOnly(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** 'HH:MM:SS' from a TIME column value ('HH:MM' tolerated). */
function _timeOnly(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/(\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  return m[1].length === 5 ? `${m[1]}:00` : m[1];
}

/**
 * 'YYYY-MM-DD HH:MM:SS' from a DATETIME column value — the canonical shape this
 * service emits. Space-separated on purpose (see the header): a 'T' form would
 * invite `new Date()` and a UTC misreading.
 */
function _naiveDateTime(v) {
  if (v == null || v === '') return null;
  const s = v instanceof Date
    ? v.toISOString().slice(0, 19)
    : String(v).replace('T', ' ').slice(0, 19);
  return s.replace('T', ' ');
}

/** Compose a date + optional time into the canonical naive shape. */
function _composeStart(dateVal, timeVal) {
  const d = _dateOnly(dateVal);
  if (!d) return null;
  return `${d} ${_timeOnly(timeVal) || '00:00:00'}`;
}

/**
 * start + N minutes, in firm-local wall time.
 *
 * Routed through luxon in FIRM_TZ rather than naive minute arithmetic, matching
 * apptService.computeApptEndLocal — so an event crossing a DST boundary gets
 * the same end its Google Calendar entry has.
 *
 * NOTE the deliberate asymmetry with the appt side, which does NOT come through
 * here: `appts.appt_end` is a STORED GENERATED column
 * (`appt_date + INTERVAL appt_length MINUTE`), i.e. naive arithmetic decided by
 * MySQL. Each side reports the end its own writer actually produced; inventing
 * a different one here would make this layer disagree with the row it reads.
 */
function _addMinutes(startNaive, minutes) {
  const n = Number(minutes);
  if (!startNaive || !Number.isFinite(n) || n <= 0) return null;
  const dt = DateTime.fromISO(startNaive.replace(' ', 'T'), { zone: FIRM_TZ });
  if (!dt.isValid) return null;
  return dt.plus({ minutes: n }).toFormat('yyyy-MM-dd HH:mm:ss');
}

/** Trimmed non-empty string, else null. */
function _s(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Bucketing key. `cases.case_id` and both docket columns are
 * utf8mb4_general_ci, so SQL matched them case-insensitively; JS bucketing must
 * do the same or a caller passing 'sutcdspn' would get rows from SQL and then
 * lose every one of them on an exact-string compare.
 */
const _key = (v) => String(v == null ? '' : v).trim().toLowerCase();


// ─────────────────────────────────────────────────────────────────────────────
// ROW MAPPERS
// ─────────────────────────────────────────────────────────────────────────────

function _mapEvent(row, caseId, includeSuperseded) {
  const allDay = row.event_all_day === 1 || row.event_all_day === '1' || row.event_all_day === true;
  const startsAt = _composeStart(row.event_date, allDay ? null : row.event_time);
  const keys = _deriveKeys('event', row.event_type, row.event_id);

  const out = {
    source:      'event',
    source_id:   Number(row.event_id),
    case_id:     caseId,
    kind_key:    keys.kind_key,
    type_key:    keys.type_key,
    // TITLE SOURCE (the one-line revert point).
    //
    // v0.4 §3.1 froze the ROW SHAPE, not this column choice; the E1 prompt's
    // "title = type_key" rule was written from that shape without re-checking
    // that `events` has a title column. It does: event_title is
    // varchar(200) NOT NULL and carries real authored content — "Hearing on
    // Motion to Dismiss Adversary Proceeding", "Dischargeability Deadline —
    // Denise A Herig (26-48953)". Under type_key three consecutive rows would
    // read "hearing", beside a tab that already shows the real titles.
    //
    // Reading a stored column is not the "prettification" the rule forbids —
    // there is no lookup table and no E0b dependency. Ruled 2026-08-30.
    // To revert to the literal prompt rule, this line becomes `keys.type_key`.
    title:       _s(row.event_title) || _s(row.event_type),
    starts_at:   startsAt,
    ends_at:     allDay ? null : _addMinutes(startsAt, row.event_length),
    all_day:     allDay,
    status_norm: _normStatus('event', row.event_status),
    location:    _s(row.event_location),
  };

  // Superseded events KEEP their real status. E0a's 31 tombstones are genuinely
  // event_status='Canceled' in the data and their calendar entries are already
  // torn down; the pointer is what marks them dead, never the status.
  if (includeSuperseded && row.superseded_by_event_id != null) {
    out.superseded             = true;
    out.superseded_by_event_id = Number(row.superseded_by_event_id);
    out.supersede_reason       = row.supersede_reason == null ? null : String(row.supersede_reason);
  }
  return out;
}

function _mapAppt(row, caseId, includeSuperseded) {
  const startsAt   = _naiveDateTime(row.appt_date);
  const isTombstone = String(row.appt_status) === 'Rescheduled';
  const keys = _deriveKeys('appt', row.appt_type, row.appt_id);

  const out = {
    source:      'appt',
    source_id:   Number(row.appt_id),
    case_id:     caseId,
    kind_key:    keys.kind_key,
    type_key:    keys.type_key,
    // Appts have no title column — appt_type is the only human label there is.
    title:       _s(row.appt_type),
    starts_at:   startsAt,
    // appt_end is STORED GENERATED from appt_date + appt_length; NULL when
    // appt_length is NULL. Read, never computed. Never appt_date_utc.
    ends_at:     _naiveDateTime(row.appt_end),
    all_day:     false,                       // appts are always timed slots
    status_norm: isTombstone ? null : _normStatus('appt', row.appt_status),
    // appts carry no location/address column — appt_platform
    // ENUM('telephone','Zoom','in-person') is the closest honest field, and it
    // IS where the meeting happens. Passed through verbatim rather than
    // re-capitalized: the stored value is the truth. NOT NULL, so always set.
    location:    _s(row.appt_platform),
  };

  // v0.4 §3.4's asymmetry, made concrete: an appt tombstone gets the flag and
  // NOTHING ELSE. There is no successor pointer to report — appts.
  // rescheduled_from_appt_id points BACKWARD from the successor and is NULL on
  // every pre-2026-08-27 row. Emitting a null superseded_by_event_id here would
  // claim the field exists and is empty; omitting it says there is no such fact.
  if (includeSuperseded && isTombstone) out.superseded = true;

  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// SORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * starts_at ascending, fully deterministic.
 *
 * Array.prototype.sort is stable (spec-guaranteed, ES2019+), but "stable" only
 * preserves the order rows happened to arrive in, which is the order MySQL
 * happened to return them in — not a contract. Two items at the same instant
 * therefore break ties on (source, source_id), so the same data always produces
 * the same list no matter which query returned first.
 *
 * Null starts_at sorts last: a row with no date cannot claim a position on a
 * timeline. (event_date is NOT NULL and appt_date is NOT NULL, so this is
 * defensive, not a live path.)
 */
function _byStart(a, b) {
  if (a.starts_at !== b.starts_at) {
    if (a.starts_at == null) return 1;
    if (b.starts_at == null) return -1;
    return a.starts_at < b.starts_at ? -1 : 1;
  }
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.source_id - b.source_id;
}


// ─────────────────────────────────────────────────────────────────────────────
// THE BATCHED READ
// ─────────────────────────────────────────────────────────────────────────────

/** 404-carrying error, matching requirementService's httpError convention. */
function _notFound(msg) {
  const e = new Error(msg);
  e.status = 404;
  return e;
}

/**
 * Internal batch. Returns the bucketed map AND the set of ids that resolved to
 * a real case, so the single-case surface can derive its 404 from query 1
 * instead of paying a separate existence probe.
 *
 * @returns {Promise<{ byCase: Map<string, object[]>, known: Map<string, string> }>}
 *          `known` maps lowercased input id → canonical cases.case_id.
 */
async function _listForCases(db, caseIds, { includeSuperseded = false, from = null, to = null } = {}) {
  const byCase = new Map();
  const known  = new Map();

  const ids = [...new Set((caseIds || []).map((v) => String(v == null ? '' : v)))]
    .filter((s) => s.trim() !== '');
  if (!ids.length) return { byCase, known };           // 0 queries

  // ── QUERY 1 — canonical ids + both docket columns ──────────────────────────
  const [caseRows] = await db.query(
    `SELECT case_id, case_number, case_number_full
       FROM cases
      WHERE case_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  if (!caseRows.length) return { byCase, known };      // 1 query — nothing to read

  // Canonical casing comes from the DB, exactly as requirementService does it.
  const caseIdByKey = new Map();     // lowercased case_id → canonical case_id
  const numberToCases = new Map();   // lowercased docket  → [canonical case_id, …]
  const numbers = [];                // distinct dockets, original casing, for the IN list

  for (const c of caseRows) {
    const canonical = String(c.case_id);
    byCase.set(canonical, []);
    caseIdByKey.set(_key(canonical), canonical);

    for (const v of [c.case_number, c.case_number_full]) {
      const s = _s(v);
      if (!s) continue;
      const k = _key(s);
      if (!numberToCases.has(k)) {
        numberToCases.set(k, []);
        numbers.push(s);
      }
      // A docket shared by two cases buckets its events to BOTH. No live
      // collision exists (verified 2026-08-30: zero dockets map to more than
      // one case_id across both columns) and case_number carries no unique
      // constraint, so this is the honest behaviour rather than an arbitrary
      // LIMIT 1 winner. eventService's own resolver takes the LIMIT 1 route
      // because a JOIN there would fan out ROWS; here the fan-out is the point.
      const list = numberToCases.get(k);
      if (!list.includes(canonical)) list.push(canonical);
    }
  }

  for (const raw of ids) {
    const canonical = caseIdByKey.get(_key(raw));
    if (canonical) known.set(_key(raw), canonical);
  }

  const canonicalIds = [...byCase.keys()];

  // ── QUERY 2 — events ───────────────────────────────────────────────────────
  //
  // ONE query covering every case id AND every docket. Both branches ride
  // idx_events_link (event_link_type, event_link_id) with bound constants.
  // 'contact'-linked and NULL-linked rows match neither branch and are
  // therefore excluded — they are not orphans (auditOrphans covers those),
  // they simply are not case-scoped.
  const evWhere = [
    `(e.event_link_type = 'case' AND e.event_link_id IN (${canonicalIds.map(() => '?').join(',')}))`,
  ];
  const evParams = [...canonicalIds];
  if (numbers.length) {
    evWhere.push(
      `(e.event_link_type = 'case_number' AND e.event_link_id IN (${numbers.map(() => '?').join(',')}))`
    );
    evParams.push(...numbers);
  }

  const evFilters = [`(${evWhere.join(' OR ')})`];
  // Superseded rows are excluded in SQL, not in JS: a case with a long
  // adjournment chain should not ship the whole chain over the wire to have it
  // dropped in the mapper.
  if (!includeSuperseded) evFilters.push('e.superseded_by_event_id IS NULL');
  // from/to are date-granular and inclusive. event_date is a DATE column, so
  // plain comparison against 'YYYY-MM-DD' is exact on both ends.
  if (from) { evFilters.push('e.event_date >= ?'); evParams.push(String(from).slice(0, 10)); }
  if (to)   { evFilters.push('e.event_date <= ?'); evParams.push(String(to).slice(0, 10)); }

  const [eventRows] = await db.query(
    `SELECT e.event_id, e.event_type, e.event_title, e.event_date, e.event_time,
            e.event_all_day, e.event_length, e.event_location, e.event_status,
            e.event_link_type, e.event_link_id, e.kind,
            e.superseded_by_event_id, e.supersede_reason
       FROM events e
      WHERE ${evFilters.join(' AND ')}`,
    evParams
  );

  // ── QUERY 3 — appts ────────────────────────────────────────────────────────
  //
  // Appts anchor ONLY on appt_case_id (the case id). They have no docket anchor
  // today — v0.5 A3a adds appt_link_type/appt_link_id at U2, at which point this
  // query grows the same two branches the events query already has.
  const apFilters = [`a.appt_case_id IN (${canonicalIds.map(() => '?').join(',')})`];
  const apParams  = [...canonicalIds];
  if (!includeSuperseded) apFilters.push(`a.appt_status <> 'Rescheduled'`);
  // appt_date is a DATETIME. Keep the COLUMN bare so it stays index-eligible:
  // the interval is applied to the bound parameter, never to appt_date. `to` is
  // inclusive of the whole day, hence < to+1day rather than <= to.
  if (from) { apFilters.push('a.appt_date >= ?'); apParams.push(String(from).slice(0, 10)); }
  if (to)   { apFilters.push('a.appt_date < (? + INTERVAL 1 DAY)'); apParams.push(String(to).slice(0, 10)); }

  const [apptRows] = await db.query(
    `SELECT a.appt_id, a.appt_case_id, a.appt_type, a.appt_status,
            a.appt_date, a.appt_end, a.appt_length, a.appt_platform
       FROM appts a
      WHERE ${apFilters.join(' AND ')}`,
    apParams
  );

  // ── Bucket ─────────────────────────────────────────────────────────────────
  for (const r of eventRows) {
    const targets = String(r.event_link_type) === 'case'
      ? [caseIdByKey.get(_key(r.event_link_id))].filter(Boolean)
      : (numberToCases.get(_key(r.event_link_id)) || []);
    for (const cid of targets) {
      byCase.get(cid).push(_mapEvent(r, cid, includeSuperseded));
    }
  }

  for (const r of apptRows) {
    const cid = caseIdByKey.get(_key(r.appt_case_id));
    if (!cid) continue;                       // defensive: SQL matched, map did not
    byCase.get(cid).push(_mapAppt(r, cid, includeSuperseded));
  }

  for (const rows of byCase.values()) rows.sort(_byStart);

  return { byCase, known };
}

/**
 * Batched unified timeline for many cases.
 *
 * Batch semantics: an unknown case id is simply ABSENT from the returned map —
 * it is not an error and not an empty entry. This mirrors
 * requirementService.resolveRequirements exactly, and for the same reason: a
 * batch caller iterating a page of cases must not have one stale id abort the
 * page. The single-case HTTP surface is where "unknown" becomes a 404.
 *
 * @param {object} db mysql2 pool or transaction connection
 * @param {string[]} caseIds
 * @param {object} [opts]
 * @param {boolean} [opts.includeSuperseded=false] include superseded events and
 *        Rescheduled appt tombstones, flagged `superseded: true`
 * @param {string|null} [opts.from] inclusive lower bound on starts_at, 'YYYY-MM-DD'
 * @param {string|null} [opts.to]   inclusive upper bound on starts_at, 'YYYY-MM-DD'
 * @returns {Promise<Map<string, object[]>>} canonical case_id → rows, starts_at asc
 */
async function listForCases(db, caseIds, opts = {}) {
  const { byCase } = await _listForCases(db, caseIds, opts);
  return byCase;
}

/**
 * Unified timeline for ONE case — the HTTP surface's read.
 *
 * @throws {Error} `.status = 404` when the case does not exist. An existing
 *         case with nothing on its calendar returns `[]`; the two are different
 *         answers and must not collapse into one. The existence fact is taken
 *         from the batch's own `cases` query, so this still costs 3 queries.
 * @returns {Promise<object[]>}
 */
async function listForCase(db, caseId, opts = {}) {
  const raw = String(caseId == null ? '' : caseId);
  const { byCase, known } = await _listForCases(db, [raw], opts);
  const canonical = known.get(_key(raw));
  if (!canonical) throw _notFound(`Case ${raw} not found`);
  return byCase.get(canonical) || [];
}


// ─────────────────────────────────────────────────────────────────────────────
// ORPHAN AUDIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every event that resolves to NO case. Diagnostics for the E1 deploy gate and
 * for whoever inherits the docket-linking model — not a UI surface.
 *
 * Three ways an event can be case-orphaned, reported as `reason`:
 *
 *   no_link                 event_link_type IS NULL, or the id is null/blank.
 *                           One live row (the E0a migration's excluded-by-NULL
 *                           join row).
 *   unresolved_case_number  a docket that matches neither cases.case_number nor
 *                           cases.case_number_full. Self-healing by design —
 *                           these resolve the moment the case is created with
 *                           that number — so a nonzero count is a WORKLIST, not
 *                           necessarily a fault.
 *   dead_case_id            link_type='case' pointing at a case_id that no
 *                           longer exists.
 *
 * `contact`-linked events are NOT orphans. They resolve — to a contact. They
 * are merely out of scope for case reads (v0.4 §3.1) and get their own surface
 * in the backlog's contact-scoped timeline.
 *
 * Superseded rows are included and carry their pointer: a tombstone that
 * resolves to nothing is still a fact worth seeing in an audit.
 *
 * @returns {Promise<object[]>} newest first
 */
async function auditOrphans(db) {
  const [rows] = await db.query(
    `SELECT e.event_id, e.event_type, e.event_title, e.event_date, e.event_time,
            e.event_all_day, e.event_status,
            e.event_link_type, e.event_link_id,
            e.superseded_by_event_id, e.supersede_reason,
            CASE
              WHEN e.event_link_type IS NULL
                OR e.event_link_id IS NULL
                OR TRIM(e.event_link_id) = ''         THEN 'no_link'
              WHEN e.event_link_type = 'case_number'  THEN 'unresolved_case_number'
              ELSE 'dead_case_id'
            END AS reason
       FROM events e
      WHERE (e.event_link_type IS NULL
             OR e.event_link_id IS NULL
             OR TRIM(e.event_link_id) = '')
         OR (e.event_link_type = 'case_number'
             AND NOT EXISTS (SELECT 1 FROM cases c
                              WHERE c.case_number = e.event_link_id
                                 OR c.case_number_full = e.event_link_id))
         OR (e.event_link_type = 'case'
             AND NOT EXISTS (SELECT 1 FROM cases c
                              WHERE c.case_id = e.event_link_id))
      ORDER BY e.event_date DESC, e.event_id DESC`
  );

  return rows.map((r) => ({
    event_id:    Number(r.event_id),
    reason:      String(r.reason),
    event_type:  r.event_type == null ? null : String(r.event_type),
    event_title: r.event_title == null ? null : String(r.event_title),
    event_date:  _dateOnly(r.event_date),
    event_time:  _timeOnly(r.event_time),
    all_day:     r.event_all_day === 1 || r.event_all_day === '1' || r.event_all_day === true,
    event_status: r.event_status == null ? null : String(r.event_status),
    link_type:   r.event_link_type == null ? null : String(r.event_link_type),
    link_id:     r.event_link_id == null ? null : String(r.event_link_id),
    superseded_by_event_id: r.superseded_by_event_id == null ? null : Number(r.superseded_by_event_id),
    supersede_reason:       r.supersede_reason == null ? null : String(r.supersede_reason),
  }));
}


module.exports = {
  listForCase,
  listForCases,
  auditOrphans,

  // Test helpers (repo `_`-prefix convention). Exported so the U2 backfill and
  // the U3 alignment pass can assert against the SAME vocabulary this derives
  // from rather than re-typing it.
  _deriveKeys,
  _normStatus,
  _byStart,
  _EVENT_TYPE_KEYS: EVENT_TYPE_KEYS,
  _APPT_TYPE_KEYS: APPT_TYPE_KEYS,
  _EVENT_ROW_OVERRIDES: EVENT_ROW_OVERRIDES,
};
