// services/caseEventService.js
//
/**
 * Case Event Service — THE UNIFIED CALENDAR READ LAYER  (Unified Events E1)
 * services/caseEventService.js
 *
 * Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.1 / §3.4 / §7-E1,
 * extended by U3 per §3.6 (A8 attendees) and §3.7 (A7 state/resolution).
 *
 * CITE NOTE (U3): E1's header cited a standalone
 * `ref/UNIFIED_EVENTS_DESIGN_V0_5_AMENDMENTS.md`. That file was folded into
 * v0.5 and does not exist in the repo; v0.5 carries the translation table at
 * its "Reading older cites" heading. The amendments-era cites this file used to
 * carry map: §0 → §0.1, §3 vocabulary → Appendix A, §4 storage → §3.3.2,
 * §5 status → §3.7, A7 → §3.7, A8 → §3.6.
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
 *
 *     // added by U3 (v0.5 §3.7) — see _deriveState
 *     state:       'live'|'resolved'|'cancelled'|'superseded',
 *     resolution:  'attended'|'no_show'|'held'|'met'|'missed'|'moot'|'cancelled'|null,
 *   }
 *
 * `status_norm` is UNCHANGED and stays the R2-facing projection of the richer
 * pair (v0.5 §3.7: "extended, not forked"). R2's detector binds status_norm and
 * must keep seeing exactly the values it saw at E1; state/resolution are for
 * consumers that need to tell a mooted deadline from a cancelled one.
 *
 * Under `includeAttendees: true` ONLY, every row additionally carries
 * `attendees[]`, and EVENT rows carry `client_expected` (§3.6). Default-shape
 * rows omit both, exactly like the superseded trio below.
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
 * `from`/`to`/`includeSuperseded` add ZERO queries (they are WHERE clauses on
 * the same three). `listForCase` is also 3: it derives its 404 from query 1's
 * result rather than paying a separate existence probe. Empty input, or input
 * where no id resolves to a real case, short-circuits at 1 query (or 0 for a
 * literally empty list). Asserted in tests/caseEventService.test.js.
 *
 * ONE EXCEPTION, added at U3: `includeAttendees` costs a 4th query — the type
 * registry, for `client_attends` — ONCE per call and only on a cold
 * calendarTypeService cache (TTL 60s, in-process). It is issued after queries
 * 2 and 3 so the three positional indices above never move, and a call that
 * short-circuits on an unknown case never pays it. The staff timeline and R2's
 * detector do not set the flag and are still 3.
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
 *   auditEventLinks(db, opts)       → Promise<{counts, items}>  (events AND appts)
 *   (+ _-prefixed test helpers — repo pattern)
 *
 * Usage:
 *   const caseEventService = require('../services/caseEventService');
 *   const rows = await caseEventService.listForCase(db, 'TYL6KJN8');
 */

'use strict';

const { DateTime } = require('luxon');
const { FIRM_TZ }  = require('./timezoneService');
// The registry, for `client_attends` under includeAttendees ONLY (v0.5 §3.6).
// This is a READ of a cached lookup table, not a dependency on write-time
// resolution: nothing here resolves a string to a key. eventService and
// apptService are still untouched and unimported (v0.5 §0.1 hold list).
const calendarTypeService = require('./calendarTypeService');


// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE MAPPING SITE — NOW A COLUMN READ  (v0.5 §0.1 "U3 handoff site")
//
// E1 derived type_key / kind_key from a hard-coded vocabulary. U2 filled the
// `type_key` column on both tables from THAT VERY VOCABULARY — the backfill was
// GENERATED from E1's exports and byte-checked against a regeneration
// (scripts/genTypeKeyBackfill.js, tests/genTypeKeyBackfill.test.js) — so this
// swap is a no-op on the data. That was the entire point of the alignment.
//
// The vocabulary itself did not die; it moved to scripts/typeKeyVocabulary.js,
// frozen, where the generator and its byte-equality test still need it. THIS
// FILE IMPORTS NOTHING FROM IT, and tests/typeKeyVocabulary.test.js asserts that
// no service does. A read layer that consulted a frozen 2026-08-30 word list
// beside a live column would be two sources of truth wearing one name.
//
// ── WHAT MOVED, AND WHY IT IS THE SAME ─────────────────────────────────────
//
//   E1                                   U3
//   ──────────────────────────────────   ──────────────────────────────────
//   trim+lowercase lookup in a Map       the column, written under the same
//                                        general_ci semantics the Map mirrored
//   EVENT_ROW_OVERRIDES (4 rows)         the column: U1 hand-fixed those exact
//                                        four ids, U2's generated backfill
//                                        re-asserted them unguarded
//   unmapped → raw passthrough, warn     the column: NULL. The raw passthrough
//                                        is KEPT here (below) so the label
//                                        still reaches R2 selectors and U9's
//                                        worklist; the warning is not, because
//                                        the write path already warned when it
//                                        failed to resolve the string
//                                        (calendarTypeService), and warning
//                                        again on every read of the same row
//                                        would be one line per page per row.
//
// ── THE ONE DELIBERATE CHANGE ──────────────────────────────────────────────
//
// `kind_key` now comes from `events.kind` rather than from the vocabulary's
// second slot. For every mapped type those agree by construction (U1 wrote kind
// from the same table U2 wrote type_key from). They differ on exactly one live
// shape: an UNMAPPED non-blank event type, which U2 ruling D7 stores as
// `type_key NULL` + `kind 'other'` where E1 returned `kind_key null`.
//
// Live 2026-09-01 that is event 156 ('Mediation', unlinked, Canceled): E1 said
// {'Mediation', null}, this says {'Mediation', 'other'}. The 'other' is more
// honest — the row IS classified, as "none of the four real kinds" — and it is
// what makes v0.5 §7.1 rule 8's straggler gate readable: kind 'other' with a
// NULL key is an unmapped type to mint, kind NULL is a write-path bug.
//
// A SECOND live row moved, and it moved because the column is BETTER informed
// than the frozen vocabulary ever was: appt 3966 ('Potato Hunting', created
// 2026-09-01 11:09) carries type_key 'test', resolved at write time through the
// registry's ingest_aliases. E1 would have passed 'Potato Hunting' through raw
// with a null kind. Both rows are asserted by name in the parity gate
// (tests/caseEventService.test.js) so neither can drift unnoticed.
// ─────────────────────────────────────────────────────────────────────────────

/** Trimmed non-empty string test — a NULL/blank type is absent data, not a type. */
const _nonBlank = (v) => v != null && String(v).trim() !== '';

/**
 * THE derivation. Reads the columns U2 wrote; falls back to the raw type string
 * ONLY as a display label when the column is NULL.
 *
 * The raw passthrough is not a guess and never becomes a key a consumer can
 * bind: a caller matching `type_key === 'meeting_341'` will never match
 * 'Mediation'. It exists so an unmapped row still renders with its label and
 * still shows up in U9's "mint me a real type" worklist, instead of rendering
 * as an untitled blank the way a bare NULL would.
 *
 * APPT kind_key is 'meeting' BY TABLE, not from the registry (v0.5 §3.3.2: the
 * storage rule is kind='meeting' → appts, so every appt is a meeting by
 * construction). Reading the registry here would be a lookup that can only ever
 * return 'meeting' or disagree with the table it just read — and it would
 * demote the 9 'test' appts (registry kind 'other') to a kind their own table
 * contradicts. E1 derived 'meeting' for them; so does this.
 *
 * @param {'event'|'appt'} source
 * @param {object} row  the raw DB row (needs type_key + kind / appt_type)
 * @returns {{ type_key: string|null, kind_key: string|null }}
 */
function _deriveKeys(source, row) {
  if (source === 'event') {
    const tk = row.type_key != null ? String(row.type_key)
             : (_nonBlank(row.event_type) ? String(row.event_type) : null);
    return { type_key: tk, kind_key: row.kind == null ? null : String(row.kind) };
  }
  const tk = row.type_key != null ? String(row.type_key)
           : (_nonBlank(row.appt_type) ? String(row.appt_type) : null);
  return { type_key: tk, kind_key: tk ? 'meeting' : null };
}


// ─────────────────────────────────────────────────────────────────────────────
// STATUS NORMALIZATION  (v0.4 §3.1; v0.5 §3.7 confirms the blank-appt row)
//
// FROZEN. `status_norm` is R2's contract and U3 does not touch a value of it.
// v0.5 §3.7 extends it with a { state, resolution } pair — "extended, not
// forked" — which _deriveState below computes ALONGSIDE this, never instead of
// it. If a future slice ever finds itself wanting to change what status_norm
// returns, that is a new field, not an edit here.
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
// STATE / RESOLUTION  (v0.5 §3.7, A7 — the U3 addition)
//
// Two questions the single `status_norm` string cannot answer at once:
//
//   state       is this row still live?      live | resolved | cancelled | superseded
//   resolution  how did it end?              attended | no_show | held | met |
//                                            missed | moot | cancelled | null
//
// The pair matters most on deadlines. `status_norm 'canceled'` cannot tell a
// deadline that was CANCELLED (the obligation was withdrawn) from one that
// became MOOT (the case converted, the motion was resolved, the date stopped
// applying). Both are Canceled rows; only `event_resolution` distinguishes them,
// and only for rows a human or U6 actually stamped.
//
// ── WHY THE FALLBACK IS A FALLBACK AND NOT A BACKFILL ──────────────────────
//
// `events.event_resolution` is NULL on all 156 live rows and has no writer until
// U6. Rather than invent history in SQL, the read layer derives the obvious
// answer from status + kind and lets a real value override it:
//
//   Completed, kind 'deadline'  → 'met'        (a deadline you completed, you met)
//   Completed, anything else    → 'held'       (a hearing you completed, you held)
//   Canceled                    → 'cancelled'  unless the column says 'moot'
//
// So today's output is fully determined, and the day U6 stamps a real value the
// row starts reporting it with no migration. The asymmetry — 'moot' overrides,
// 'cancelled' is merely the default — is because 'moot' is the only Canceled
// resolution that carries information the status does not already carry.
//
// ── SUPERSEDED WINS ────────────────────────────────────────────────────────
//
// A superseded row is superseded whatever its status says. The 31 E0a dedup
// tombstones are genuinely `event_status='Canceled'` and would otherwise report
// state 'cancelled', which is a claim about the COURT's action; they were
// cancelled by a July cleanup script, not by a judge. `superseded_by_event_id`
// is the pointer that marks a row dead (E0a rule: supersession is never a
// status), so it decides `state` outright. Same for a Rescheduled appt.
//
// These rows are excluded from default reads entirely; the branch only fires
// under includeSuperseded.
// ─────────────────────────────────────────────────────────────────────────────

/** appt_status → [state, resolution]. Blank/unknown falls through to live/null. */
const APPT_STATE = new Map(Object.entries({
  'Scheduled': ['live',      null],
  'Attended':  ['resolved',  'attended'],
  'No Show':   ['resolved',  'no_show'],
  'Canceled':  ['cancelled', 'cancelled'],
  // 'Rescheduled' is absent for the same reason it is absent from
  // APPT_STATUS_NORM: it is a tombstone. Handled by the superseded branch.
}));

/**
 * @param {'event'|'appt'} source
 * @param {object} row      raw DB row
 * @param {string|null} kindKey  the already-derived kind (decides met vs held)
 * @param {boolean} isDead  superseded event / Rescheduled appt
 * @returns {{ state: string, resolution: string|null }}
 */
function _deriveState(source, row, kindKey, isDead) {
  if (isDead) return { state: 'superseded', resolution: null };

  if (source === 'appt') {
    // The 6 blank-enum rows (and any unknown value) are LIVE with no resolution:
    // an appointment whose outcome nobody recorded is not thereby cancelled.
    // Same ruling as _normStatus — never launder unknown into a real value.
    const hit = APPT_STATE.get(String(row.appt_status == null ? '' : row.appt_status));
    return hit ? { state: hit[0], resolution: hit[1] } : { state: 'live', resolution: null };
  }

  const stored = row.event_resolution == null ? null : String(row.event_resolution);
  switch (String(row.event_status == null ? '' : row.event_status)) {
    case 'Completed':
      return { state: 'resolved', resolution: stored || (kindKey === 'deadline' ? 'met' : 'held') };
    case 'Canceled':
      return { state: 'cancelled', resolution: stored === 'moot' ? 'moot' : 'cancelled' };
    case 'Scheduled':
      return { state: 'live', resolution: null };
    default:
      // event_status is NOT NULL DEFAULT 'Scheduled' and the enum has three
      // values, so this is unreachable on live data. Defensive: a '' from a
      // non-strict-mode write reads as live-with-nothing-recorded, matching the
      // appt side rather than inventing a cancellation.
      return { state: 'live', resolution: null };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// ATTENDEES  (v0.5 §3.6, A8 — contract now, storage later)
//
// OPT-IN. `includeAttendees` is off by default and the default row shape is
// unchanged, exactly like includeSuperseded. §3.1 froze the row shape; new
// information arrives as opt-ins, never as new default keys.
//
// NO CHILD TABLE, NO JOINS. Everything below comes from columns the two queries
// already select. §3.6 defers the attendees table until a real multi-attendee
// case exists (12 of 1,078 cases have Primary+Secondary; appt_with≠1 on 6 of
// 2,218 appts). What ships is the SHAPE, so U6's write API and the portal can
// bind it before the storage question is answered.
//
// ── `blocks` IS THE LIVE availabilityService SEMANTIC, NOT AN INVENTION ────
//
// services/availabilityService.js normalizeBusyForProvider (~line 293):
//
//   · all-day events NEVER block, whatever event_with says  → `if (all_day) continue`
//   · event_with NULL blocks EVERY provider (firm-wide)     → `if (with != null && with !== pid) continue`
//   · event_with = N blocks only provider N
//   · event_with = 0 blocks nobody (0 !== any real user id) — v0.5 §3.3.1's
//     "NULL = firm, 0 = nobody". No live row carries 0 (102 NULL / 54 = 1,
//     verified 2026-09-01); the branch is defensive.
//
// That is why a NULL event_with becomes `{party:'firm'}` and not a missing
// attendee: "nobody in particular" and "the whole firm" are opposite facts about
// the calendar, and the availability engine already treats them as such.
//
// ── `party:'firm'` RATHER THAN §3.6's 'external' ───────────────────────────
//
// §3.6 lists `'user'|'contact'|'external'` and a `label`. Neither fits this
// slice. 'external' means an outside party (opposing counsel, a trustee) and
// nothing in either table records one — using it for the firm-wide case would
// name the concept wrong on day one. `label` would need a users/contacts join
// this slice explicitly forbids; the id is enough for a caller that has the
// people loaded, which every caller does. Flagged for CAL to reconcile in the
// doc rather than silently followed. (Fred, 2026-09-01: implementer's call.)
//
// ── `notify` ──────────────────────────────────────────────────────────────
//
// Appts have a notification machinery (confirmations, pre_appt sequences), so
// their attendees are notify:true. Events have none — eventService sends no
// client mail — so events are notify:false throughout this slice. U6/U8 decide
// whether a court date ever notifies a client; asserting `true` here would be a
// promise no code keeps.
//
// ── NO CONTACT ON EVENTS ──────────────────────────────────────────────────
//
// An event carries no client column. Resolving "the client" for a case-linked
// event means joining case→contacts and picking a Primary, which is a JOIN this
// layer refuses (the log-feed lesson in the header) and a case-ROLES question
// that is unowned (v0.5 §8.2). `client_expected` answers the useful half —
// SHOULD a client be there, per the registry — without asserting WHO.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {'event'|'appt'} source
 * @param {object} row
 * @param {boolean} allDay  all-day rows never block, whatever event_with says
 * @returns {object[]}
 */
function _deriveAttendees(source, row, allDay) {
  const out = [];

  if (source === 'appt') {
    // appt_with is NOT NULL in practice (default 1; 0 live NULLs) but is a
    // nullable column, so a null is treated as "no host recorded" rather than
    // as the firm — appts have no firm-wide semantic, unlike events.
    if (row.appt_with != null && Number(row.appt_with) > 0) {
      out.push({ party: 'user', id: Number(row.appt_with), role: 'host', blocks: true, notify: true });
    }
    if (row.appt_client_id != null) {
      out.push({ party: 'contact', id: Number(row.appt_client_id), role: 'attendee', blocks: false, notify: true });
    }
    return out;
  }

  const w = row.event_with;
  if (w == null) {
    out.push({ party: 'firm', id: null, role: 'host', blocks: !allDay, notify: false });
  } else if (Number(w) > 0) {
    out.push({ party: 'user', id: Number(w), role: 'host', blocks: !allDay, notify: false });
  }
  // event_with === 0 → nobody. No attendee row at all: emitting one with
  // blocks:false would claim a person is expected who explicitly is not.
  return out;
}

/**
 * Registry `client_attends` for a type_key. FAIL-SOFT: an absent key, an
 * unmapped row, or a registry that failed to load all yield false. A missing
 * registry must never make a timeline read fail — same ruling as
 * calendarTypeService's own load path (U2 R1.2).
 *
 * @param {Map<string,object>|null} registry  from calendarTypeService.loadRegistry
 */
function _clientExpected(registry, typeKey) {
  if (!registry || !typeKey) return false;
  const row = registry.get(String(typeKey));
  return !!(row && row.client_attends);
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

function _mapEvent(row, caseId, { includeSuperseded, includeAttendees, registry }) {
  const allDay = row.event_all_day === 1 || row.event_all_day === '1' || row.event_all_day === true;
  const startsAt = _composeStart(row.event_date, allDay ? null : row.event_time);
  const keys = _deriveKeys('event', row);
  const isDead = row.superseded_by_event_id != null;
  const st = _deriveState('event', row, keys.kind_key, isDead);

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
    state:       st.state,
    resolution:  st.resolution,
  };

  if (includeAttendees) {
    out.attendees       = _deriveAttendees('event', row, allDay);
    out.client_expected = _clientExpected(registry, keys.type_key);
  }

  // Superseded events KEEP their real status. E0a's 31 tombstones are genuinely
  // event_status='Canceled' in the data and their calendar entries are already
  // torn down; the pointer is what marks them dead, never the status. `state`
  // says 'superseded' for the same reason — see _deriveState.
  if (includeSuperseded && isDead) {
    out.superseded             = true;
    out.superseded_by_event_id = Number(row.superseded_by_event_id);
    out.supersede_reason       = row.supersede_reason == null ? null : String(row.supersede_reason);
  }
  return out;
}

function _mapAppt(row, caseId, { includeSuperseded, includeAttendees, registry }) {
  const startsAt   = _naiveDateTime(row.appt_date);
  const isTombstone = String(row.appt_status) === 'Rescheduled';
  const keys = _deriveKeys('appt', row);
  const st = _deriveState('appt', row, keys.kind_key, isTombstone);

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
    state:       st.state,
    resolution:  st.resolution,
  };

  // U6b: a docket-bucketed appt says so — the consumer needs to know this row
  // reached the case through its docket, exactly as event rows do. CONDITIONAL
  // (case/contact/NULL-linked rows keep the frozen default shape); the
  // events-side mapper carries its link unconditionally — a deliberate
  // asymmetry until U9 revisits the row contract.
  if (String(row.appt_link_type || '') === 'case_number') {
    out.link_type = 'case_number';
    out.docket    = row.appt_link_id == null ? null : String(row.appt_link_id);
  }

  // `client_expected` is EVENTS-ONLY (v0.5 §3.6). An appt already carries the
  // fact as data: appt_client_id is either there or it is not, and the attendee
  // list above says so directly. A registry OPINION about whether a client
  // should attend would sit beside the row's own answer and disagree with it on
  // the 58 client-less appts — two sources of truth for one question.
  if (includeAttendees) out.attendees = _deriveAttendees('appt', row, false);

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
async function _listForCases(db, caseIds, {
  includeSuperseded = false, includeAttendees = false, from = null, to = null,
} = {}) {
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
  // therefore excluded — they are not broken (auditEventLinks covers link
  // health separately),
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
            e.event_resolution, e.event_link_type, e.event_link_id,
            e.kind, e.type_key, e.event_with,
            e.superseded_by_event_id, e.supersede_reason
       FROM events e
      WHERE ${evFilters.join(' AND ')}`,
    evParams
  );

  // ── QUERY 3 — appts ────────────────────────────────────────────────────────
  //
  // U6b (v0.5 A3a): appts anchor like events now. The case branch matches
  // appt_case_id; the docket branch matches docket-anchored rows
  // (appt_link_type='case_number') against the SAME docket IN-list the events
  // query built from query 1 — a court-created 341 written before the case
  // existed surfaces here the moment the case does, with no adoption pass.
  const apWhere  = [`a.appt_case_id IN (${canonicalIds.map(() => '?').join(',')})`];
  const apParams = [...canonicalIds];
  if (numbers.length) {
    apWhere.push(
      `(a.appt_link_type = 'case_number' AND a.appt_link_id IN (${numbers.map(() => '?').join(',')}))`
    );
    apParams.push(...numbers);
  }
  const apFilters = [`(${apWhere.join(' OR ')})`];
  if (!includeSuperseded) apFilters.push(`a.appt_status <> 'Rescheduled'`);
  // appt_date is a DATETIME. Keep the COLUMN bare so it stays index-eligible:
  // the interval is applied to the bound parameter, never to appt_date. `to` is
  // inclusive of the whole day, hence < to+1day rather than <= to.
  if (from) { apFilters.push('a.appt_date >= ?'); apParams.push(String(from).slice(0, 10)); }
  if (to)   { apFilters.push('a.appt_date < (? + INTERVAL 1 DAY)'); apParams.push(String(to).slice(0, 10)); }

  const [apptRows] = await db.query(
    `SELECT a.appt_id, a.appt_case_id, a.appt_client_id, a.appt_type, a.type_key,
            a.appt_status, a.appt_date, a.appt_end, a.appt_length, a.appt_platform,
            a.appt_with, a.appt_link_type, a.appt_link_id
       FROM appts a
      WHERE ${apFilters.join(' AND ')}`,
    apParams
  );

  // ── QUERY 4, CONDITIONALLY — the type registry, for client_expected ────────
  //
  // The ONLY thing that can add a query to this layer, and only under
  // includeAttendees. It is:
  //
  //   · loaded ONCE per call regardless of N cases or N rows — the budget above
  //     still holds its shape;
  //   · cached in-process for 60s by calendarTypeService, so a portal loop pays
  //     for it at most once a minute across every case it reads;
  //   · loaded HERE, after queries 2 and 3, rather than at the top — so a call
  //     that short-circuits on an unknown case pays nothing, and so the three
  //     positional queries every test in the suite asserts against keep their
  //     indices;
  //   · fail-soft twice over: loadRegistry never throws (U2 R1.2), and the
  //     catch below is belt-and-braces for a caller passing a db shape it
  //     rejects. A registry that will not load means client_expected is false
  //     everywhere, never a 500 on the case timeline.
  let registry = null;
  if (includeAttendees) {
    try {
      registry = await calendarTypeService.loadRegistry(db);
    } catch (_) {
      registry = null;
    }
  }

  const mapOpts = { includeSuperseded, includeAttendees, registry };

  // ── Bucket ─────────────────────────────────────────────────────────────────
  for (const r of eventRows) {
    const targets = String(r.event_link_type) === 'case'
      ? [caseIdByKey.get(_key(r.event_link_id))].filter(Boolean)
      : (numberToCases.get(_key(r.event_link_id)) || []);
    for (const cid of targets) {
      byCase.get(cid).push(_mapEvent(r, cid, mapOpts));
    }
  }

  for (const r of apptRows) {
    // U6b: docket-anchored rows bucket through the docket map — a shared
    // docket fans out to BOTH cases, same rule (and same reason) as events.
    // Everything else buckets on appt_case_id as it always has.
    const targets = String(r.appt_link_type) === 'case_number'
      ? (numberToCases.get(_key(r.appt_link_id)) || [])
      : [caseIdByKey.get(_key(r.appt_case_id))].filter(Boolean);
    for (const cid of targets) {
      byCase.get(cid).push(_mapAppt(r, cid, mapOpts));
    }
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
 * @param {boolean} [opts.includeAttendees=false] add `attendees[]` to every row
 *        and `client_expected` to event rows (v0.5 §3.6). Costs at most ONE
 *        extra query per call (the registry, cached 60s), and only the first
 *        time in that window.
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
// EVENT LINK AUDIT
//
// NOT an "orphan audit", though that is what v0.4 §3.1 called it and what E1
// shipped as. The word was wrong and it mattered: it lumped a supported state
// in with two broken ones.
//
// AN EVENT IS ALLOWED TO BE ATTACHED TO NOTHING. That is not a gap in the
// model, it is the model, at three layers:
//
//   · schema      — event_link_type and event_link_id are both nullable.
//   · write path  — eventService._normalizeLink documents
//                   "no/empty link_type → { type:null, id:null }" and returns
//                   cleanly. It throws only on a HALF link (a type with no id).
//   · read paths  — listEvents defaults link_type=null (no filter), so unlinked
//                   events appear in the general list; eventform.html renders
//                   '—' for them; calendar.html's link block is an if/else-if
//                   chain with no else, so they render on the calendar without
//                   a "Case:" line.
//
// Three surfaces that all anticipated it. A firm-wide event — office closed, a
// CLE seminar, a staff meeting — is exactly this shape.
//
// The reason it read as garbage is an accident of today's data: the single live
// unlinked row is event 4, "Reminder smoke", Canceled — a test row. Calling the
// state an orphan on that evidence would have had someone "cleaning up" a
// perfectly good firm-wide event the first time staff created one.
//
// So this reports three DIFFERENT conditions and says which is which:
//
//   severity   reason                  meaning
//   ────────   ─────────────────────   ──────────────────────────────────────
//   broken     dead_case_id            link_type='case' pointing at a case_id
//                                      that does not exist. A pointer to
//                                      nothing. Genuinely wrong; needs a human.
//   pending    unresolved_case_number  a docket matching neither case_number
//                                      nor case_number_full. SELF-HEALING —
//                                      it resolves the moment the case is
//                                      created with that number. A worklist,
//                                      not a fault.
//   unlinked   unlinked                attached to nothing. Legitimate. Listed
//                                      so it can be FOUND — some will be
//                                      deliberate, some will be a staffer who
//                                      meant to attach a case and didn't. The
//                                      audit does not presume which.
//
// `contact`-linked events are absent entirely: they resolve, to a contact. They
// are merely out of scope for CASE reads (v0.4 §3.1) and get their own surface
// in the backlog's contact-scoped timeline.
//
// ── U3: THE SAME THREE WORDS, NOW OVER APPTS TOO (v0.5 §0.1, §3.1) ─────────
//
// E1 audited events only, because appts had no docket anchor to be unresolved
// against. U6b (A3a) gave them one — `appt_link_type`/`appt_link_id` — so all
// three conditions apply now. Live figures at U3 (2026-09-01): 20 rows:
//
//   broken    (8)  appt_case_id names a case that does not exist (5 rows, all
//                  the literal '<TEST>'), OR appt_client_id names a contact that
//                  does not exist (3 rows: 1786, 2477, 2908). Either pointer
//                  being dead is the same defect as a dead event link.
//   unlinked (12)  no anchors at all: appt_case_id = '' AND appt_client_id IS
//                  NULL AND not docket-anchored. Attached to nothing, and
//                  legitimate for the same reason an unlinked event is: a held
//                  slot, a blocked hour. Listed so it can be FOUND.
//   pending   (0 at cutover)  appt_link_type='case_number' with a docket
//                  matching neither case_number column. SELF-HEALING, exactly
//                  as on the events side — U7's court writer is what will
//                  populate this.
//
// NOT unlinked: the 46 appts with a blank case_id and a LIVE client. Those are
// consultations booked before a case exists — the single commonest shape in the
// booking flow — and calling them a link fault would put a fifth of this year's
// intake on a cleanup list.
//
// `counts` keeps `broken`/`pending`/`unlinked`/`total` as the EVENTS figures and
// adds the appts block under `counts.appts`. Additive, so any consumer bound to
// the E1 shape keeps reading events and cannot silently start counting appts.
//
// Read-only diagnostics. Nothing here blocks, validates or changes a write.
// ─────────────────────────────────────────────────────────────────────────────

/** severity → the reason it corresponds to. Also the filter vocabulary. */
const LINK_SEVERITIES = new Map([
  ['broken',   'dead_case_id'],
  ['pending',  'unresolved_case_number'],
  ['unlinked', 'unlinked'],
]);

/**
 * Audit event→case links.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string[]|null} [opts.severity] restrict to these severities
 *        ('broken' | 'pending' | 'unlinked'). Null/empty = all three.
 *        Filtering happens in SQL so the UI's "unlinked only" view does not
 *        pull the broken rows over the wire to discard them.
 * @returns {Promise<{counts: object, items: object[]}>} counts is keyed by
 *          severity plus `total` — the EVENTS figures, unchanged from E1 — plus
 *          `counts.appts` with the same four keys for the appt side. All keys
 *          are ALWAYS present even when filtered: a zero you asked to hide is
 *          still a zero worth seeing. `items` rows carry `source:'event'|'appt'`.
 */
async function auditEventLinks(db, { severity = null } = {}) {
  const want = Array.isArray(severity) && severity.length
    ? severity.filter((s) => LINK_SEVERITIES.has(s))
    : [...LINK_SEVERITIES.keys()];

  const counts = {
    broken: 0, pending: 0, unlinked: 0, total: 0,
    appts: { broken: 0, pending: 0, unlinked: 0, total: 0 },
  };
  if (!want.length) return { counts, items: [] };

  const NO_LINK = `(e.event_link_type IS NULL
                    OR e.event_link_id IS NULL
                    OR TRIM(e.event_link_id) = '')`;
  const DEAD_CASE = `(e.event_link_type = 'case'
                      AND NOT EXISTS (SELECT 1 FROM cases c
                                       WHERE c.case_id = e.event_link_id))`;
  const UNRESOLVED = `(e.event_link_type = 'case_number'
                       AND NOT EXISTS (SELECT 1 FROM cases c
                                        WHERE c.case_number = e.event_link_id
                                           OR c.case_number_full = e.event_link_id))`;

  // NO_LINK is tested first in the CASE so that a half-written row (a type with
  // a blank id) reports as unlinked rather than as a dead pointer — a blank id
  // points at nothing in particular, which is not the same claim as pointing at
  // a case that was deleted.
  const branches = { unlinked: NO_LINK, broken: DEAD_CASE, pending: UNRESOLVED };
  const where = want.map((s) => branches[s]).join('\n         OR ');

  const [rows] = await db.query(
    `SELECT e.event_id, e.event_type, e.event_title, e.event_date, e.event_time,
            e.event_all_day, e.event_status, e.event_location,
            e.event_link_type, e.event_link_id,
            e.superseded_by_event_id, e.supersede_reason,
            CASE
              WHEN ${NO_LINK}                        THEN 'unlinked'
              WHEN e.event_link_type = 'case_number' THEN 'unresolved_case_number'
              ELSE 'dead_case_id'
            END AS reason
       FROM events e
      WHERE ${where}
      ORDER BY e.event_date DESC, e.event_id DESC`
  );

  const severityOf = { unlinked: 'unlinked', unresolved_case_number: 'pending',
                       dead_case_id: 'broken' };

  const items = rows.map((r) => {
    const reason = String(r.reason);
    counts[severityOf[reason]] += 1;
    counts.total += 1;
    return {
      source:      'event',
      event_id:    Number(r.event_id),
      severity:    severityOf[reason],
      reason,
      event_type:  r.event_type == null ? null : String(r.event_type),
      event_title: r.event_title == null ? null : String(r.event_title),
      event_date:  _dateOnly(r.event_date),
      event_time:  _timeOnly(r.event_time),
      all_day:     r.event_all_day === 1 || r.event_all_day === '1' || r.event_all_day === true,
      event_status: r.event_status == null ? null : String(r.event_status),
      location:    _s(r.event_location),
      link_type:   r.event_link_type == null ? null : String(r.event_link_type),
      link_id:     r.event_link_id == null ? null : String(r.event_link_id),
      superseded_by_event_id: r.superseded_by_event_id == null ? null : Number(r.superseded_by_event_id),
      supersede_reason:       r.supersede_reason == null ? null : String(r.supersede_reason),
    };
  });

  // ── The appt half ─────────────────────────────────────────────────────────
  //
  // A SECOND query, not a UNION: the two tables share no column names, so a
  // union would mean aliasing eleven columns twice to produce rows that then
  // need a `source` discriminator anyway. Two shaped queries read as what they
  // are, and each keeps its own index eligibility.
  //
  // U6b (A3a): the pending branch is REAL now — a docket-anchored appt whose
  // docket matches neither case_number column is exactly as pending (and
  // exactly as self-healing) as its event counterpart. All three severities
  // query appts.
  const wantAppt = want;
  if (wantAppt.length) {
    // Unlinked = no anchors AT ALL: blank case, no client, and not
    // docket-anchored. (Post-backfill the third condition is implied by the
    // first two — the migration only leaves the pair NULL on exactly those
    // rows — but a docket-anchored, client-less row must never read as
    // unlinked, so the predicate says so rather than relying on it.)
    const AP_NO_LINK = `(TRIM(a.appt_case_id) = '' AND a.appt_client_id IS NULL
                         AND NOT (a.appt_link_type = 'case_number'
                                  AND TRIM(COALESCE(a.appt_link_id, '')) <> ''))`;
    // Either dead pointer is broken. Written as one OR rather than two
    // severities because the caller's question is "is this row's anchor real",
    // and a row with both dead is one broken row, not two.
    const AP_DEAD = `((TRIM(a.appt_case_id) <> ''
                       AND NOT EXISTS (SELECT 1 FROM cases c
                                        WHERE c.case_id = a.appt_case_id))
                      OR (a.appt_client_id IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM contacts ct
                                           WHERE ct.contact_id = a.appt_client_id)))`;
    // Same predicate the events side uses, over the appt anchor pair.
    const AP_UNRESOLVED = `(a.appt_link_type = 'case_number'
                            AND NOT EXISTS (SELECT 1 FROM cases c
                                             WHERE c.case_number = a.appt_link_id
                                                OR c.case_number_full = a.appt_link_id))`;
    const apBranches = { unlinked: AP_NO_LINK, broken: AP_DEAD, pending: AP_UNRESOLVED };
    const apWhere = wantAppt.map((sv) => apBranches[sv]).join('\n         OR ');

    // NO_LINK first in the CASE, for the same reason as the events side: a row
    // with no anchors at all is unlinked, not a dead pointer. The pending test
    // is the FULL predicate (not just the link_type) so a docket-anchored row
    // matched here for a dead CLIENT pointer still reports broken when its
    // docket resolves.
    const [apRows] = await db.query(
      `SELECT a.appt_id, a.appt_type, a.type_key, a.appt_date, a.appt_status,
              a.appt_platform, a.appt_case_id, a.appt_client_id,
              a.appt_link_type, a.appt_link_id,
              CASE WHEN ${AP_NO_LINK} THEN 'unlinked'
                   WHEN ${AP_UNRESOLVED} THEN 'unresolved_case_number'
                   ELSE 'dead_anchor' END AS reason
         FROM appts a
        WHERE ${apWhere}
        ORDER BY a.appt_date DESC, a.appt_id DESC`
    );

    for (const r of apRows) {
      const reason = String(r.reason);
      const sev = reason === 'unlinked' ? 'unlinked'
        : reason === 'unresolved_case_number' ? 'pending'
        : 'broken';
      counts.appts[sev] += 1;
      counts.appts.total += 1;
      items.push({
        source:       'appt',
        appt_id:      Number(r.appt_id),
        severity:     sev,
        reason,
        appt_type:    r.appt_type == null ? null : String(r.appt_type),
        type_key:     r.type_key == null ? null : String(r.type_key),
        // An appt is always a timed slot: date and time come off the one
        // DATETIME column, and all_day is structurally false. Reported anyway
        // so an appt item and an event item can be rendered by one template.
        event_date:   _dateOnly(r.appt_date),
        event_time:   _timeOnly(_naiveDateTime(r.appt_date)),
        all_day:      false,
        appt_status:  r.appt_status == null ? null : String(r.appt_status),
        location:     _s(r.appt_platform),
        case_id:      _s(r.appt_case_id),
        client_id:    r.appt_client_id == null ? null : Number(r.appt_client_id),
        // U6b — the anchor pair, so a pending item shows WHICH docket it is
        // waiting on. NULL/NULL on pre-A3a shapes.
        link_type:    r.appt_link_type == null ? null : String(r.appt_link_type),
        link_id:      r.appt_link_id == null ? null : String(r.appt_link_id),
      });
    }
  }

  return { counts, items };
}

module.exports = {
  listForCase,
  listForCases,
  auditEventLinks,

  // Test helpers (repo `_`-prefix convention).
  //
  // The three vocabulary exports E1 carried — _EVENT_TYPE_KEYS, _APPT_TYPE_KEYS,
  // _EVENT_ROW_OVERRIDES — are GONE at U3. They existed so U2's backfill
  // generator could emit SQL from the same maps this service derived from; the
  // column is now the source of truth here and the maps live, frozen, in
  // scripts/typeKeyVocabulary.js for the generator alone. Anything that wants
  // them should require that file and should almost certainly not.
  _deriveKeys,
  _deriveState,
  _deriveAttendees,
  _clientExpected,
  _normStatus,
  _byStart,
  _LINK_SEVERITIES: LINK_SEVERITIES,
};
