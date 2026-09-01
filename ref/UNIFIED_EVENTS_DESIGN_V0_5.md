# UNIFIED EVENTS DESIGN — appts / events / deadlines / tasks

**v0.5 — GOVERNING.** Supersedes and absorbs v0.4 (frozen post review round 3), which was
committed as `ref/UNIFIED_EVENTS_DESIGN_V0_4.md` in `4d13cbf` and removed once this file carried
all of it — `git show 4d13cbf:ref/UNIFIED_EVENTS_DESIGN_V0_4.md` for the text E0a and E1 were
built against. v0.4's section numbers are preserved here, so its cites still resolve.

**Status: RATIFIED 2026-09-01; U1 and U2 shipped the same day (§7).** Every gate in the
2026-08-30 draft is ruled (§8.1); the remaining open items in §8.2 are work to schedule, not
decisions to make. The registry is live: `calendar_item_types` (34 seeded rows) and `type_key` on
both `appts` and `events`, backfilled and verified 2026-09-01.

**Authors:** PIPE (pipeline-arc manager, Fable) — v0.1–v0.4. CAL (unified-events manager, Fable) —
v0.5, reconciled with PIPE via scratch `fred/unified_events_coord` 2026-08-30. Figures verified
live 2026-08-26 (v0.4) and re-verified / extended 2026-08-28..30 (v0.5) by one or both.

**Changelog v0.5-draft → v0.5 (ratification pass, 2026-09-01):** Fred's rulings applied (§8.1) —
A3 ruled **yes**, Option B confirmed, `consultation` gets its own key, hand-fixes approved;
Appendix A.2 regenerated from a **BINARY census** (E1 finding — the ci `GROUP BY` had collapsed
spelling variants covering 19% of appts); **E1 landed** and PIPE's calendar role closed (§0.1);
U1 becomes a SQL-only migration with the picker moved to U2 (§7); the Jest baseline becomes a
verify-don't-trust figure (§7.1 rule 6).

**Since ratification (2026-09-01, same day).** U1 applied and verified; U2 deployed and verified
(§7). Three things the slices settled are folded back into the design text above: the registry
`kind` enum ships in the COLUMN's order (§3.3, U2 ruling D1); an unmapped non-blank type resolves
to `type_key` NULL **and `kind='other'`**, not `kind` NULL (§3.3, U2 ruling D7); and any backfill
touching `events` must self-assign `event_updated_at` (§7.1 rule 9 — U1 and U2 did not, and bumped
every pre-existing row).

**Changelog v0.4→v0.5.** Amendment ids A1–A8 are kept in the section headings so the coordination
scratch and the drafted slice prompts still resolve:

| id | change | lands in | replaces |
|---|---|---|---|
| — | Option B ownership, hold list, E1 carve-out | §0.1 | new |
| A1 | item-type registry TABLE + `type_key` COLUMN on both tables | §3.3 | v0.4 §3.3 read-time derivation |
| A2 | no user initials in schema | §3.3.1 | `court_item_policy.attendance/blocks` |
| A3 | 341 lives in `appts`, always; event type `341` retired (**ruled yes** 2026-09-01) | §3.4.1, §5 | v0.4's "defer to SS worksheet" |
| A4 | `singleton` is registry policy, not code | §3.4.2 | `createAppt`'s `'341 Meeting'` block |
| A5 | `calendar.*` domain events from both services | §3.5 | new |
| A6 | reminders = `calendar.approaching` + trigger rules | §3.2 | v0.4 §3.2 task-spawner |
| A7 | deadline resolution vocabulary + `missed` sweep | §3.7 | extends v0.4 §3.1 `status_norm` |
| A8 | attendees: read/write contract now, storage later | §3.6 | new |
| — | storage rule: `kind='meeting'` → `appts`, else `events` | §3.3.2 | v0.4 §5 per-type `storage` routing |
| — | type-key vocabulary v1 (the E1 + U2 map) | Appendix A | v0.4's "E0b mapping table TBD" |
| — | consumer bindings after cutover | §6.1 | new |
| — | slice plan E1 + U0–U10, live-safety rules | §7 | v0.4 §7 E0b–E3 |

### Reading older cites — amendments numbering → this document

E1, its tests, `case.html` and the U1 migration were written against the standalone amendments
file, whose sections this fold renumbered. **A cite of the form "v0.5 §N" uses the left column.**
The overlap is genuinely confusing — old §3.1 is the events vocabulary, new §3.1 is the read
layer — so check here before following one.

| cite in code (amendments) | here |
|---|---|
| §0 ownership / hold list | §0.1 |
| §1 A1 registry · A2 initials · A3 341 · A4 singleton | §3.3 · §3.3.1 · §3.4.1 · §3.4.2 |
| §1 A5 domain events · A6 reminders · A7 resolution · A8 attendees | §3.5 · §3.2 · §3.7 · §3.6 |
| §2 rulings log | §8.1 |
| §3 vocabulary · §3.1 events side · §3.2 appts side | Appendix A · A.1 · A.2 |
| §3.3 consumer bindings | §6.1 |
| §4 storage rule | §3.3.2 |
| §5 status / resolution model | §3.7 |
| §6 slice plan | §7 |
| §7 live-safety rules | §7.1 |
| §8 open items | §8.2, §8.3 |

New cites should use this document's numbering. The v0.4-era cites in the same files (`v0.4 §0`,
`§3.1`, `§3.4`) still resolve as written — v0.4's numbers were deliberately preserved here.

## 0. Purpose and constraint

One coherent model for every date-bearing thing a case has — hearings, deadlines, meetings,
appointments, reminders — so that: (a) court pipeline v2 s2–4 land on a settled substrate; (b)
pipeline R2's `event(selector)` binding has a stable contract; (c) staff and portal get one case
timeline; (d) reminders stop being three unrelated mechanisms. Glade's post-filing panel
(Hearing | Deadline | Conference; When / Trustee / Location / "Synced from PACER") is the reference
rendering. **Consolidation, not greenfield**: three date stores are live; this doc decides
ownership and evolution.

### 0.1 Ownership and coordination

**Option B, endorsed by both managers, confirmed by Fred 2026-09-01.** CAL owns the calendar
substrate: everything in v0.4 §7 from E0b onward (here: §7's U-series), plus every amendment in
this file. PIPE keeps pipeline / portal / merge and consumes the §3.1 read contract as a frozen
API.

**E1 landed 2026-09-01** (the PIPE carve-out; reviewed and approved; suite 161 / 5,382 / 1 at
landing): `services/caseEventService.js`, `routes/api.caseEvents.js`, `case.html` tabTimeline,
tests. **E1b** added the one hold-list edit made so far, with a coord entry first:
`eventService.listEvents` gained a read-only pseudo-filter `link_type:'none'` — deliberately
absent from `EVENT_LINK_TYPES`, so it can never reach the enum column. **PIPE's calendar role is
closed**; from here PIPE writes no calendar prompts and touches nothing on the hold list.

**E1's link audit is three-way, not "orphans":** `broken` (dead `case_id` — genuinely wrong),
`pending` (docket with no case yet — self-healing), `unlinked` (legitimate: firm-wide events like
office-closed or a CLE). Live **0 / 0 / 1**. The same split applies to appts once A3a lands, and
U9's unified list carries the `unlinked` filter.

**U3 handoff site:** `caseEventService._deriveKeys` — one site, exporting `_EVENT_TYPE_KEYS`,
`_APPT_TYPE_KEYS` and `_EVENT_ROW_OVERRIDES` for U2's backfill assertions. E1 normalizes lookups
trim+lowercase to mirror the column collation, and throws at load if two vocabulary entries
collide with different values. U3 swaps derivation → column there, deletes the row-override map,
and extends `status_norm` per §3.7.

**Hold list — nobody edits these without an entry in `fred/unified_events_coord` first:**
`events` DDL, `appts` DDL, `services/eventService.js`, `services/apptService.js`,
`services/courtExecutor.js`. PIPE has frozen on all five permanently. All future DDL on
`events`/`appts` is CAL's.

**E1 ↔ U-series alignment (held at U2):** E1 derives `type_key` / `kind_key` from the Appendix A
vocabulary; U2's backfill is GENERATED from E1's own maps by `scripts/genTypeKeyBackfill.js`, and
`tests/genTypeKeyBackfill.test.js` asserts the committed SQL equals a fresh regeneration. No row
changed key the day the column landed, and the migration cannot drift from E1's derivation — which
is what makes U3's swap (derivation → column) a no-op on the data.

Scratch keys: `fred/unified_events_coord` (handshake, append-only) ·
`fred/unified_events_handover` (PIPE's verified figures) · `fred/e0b_type_mapping_draft` (PIPE's
judgment table) · `fred/unified_events_v05_design` (CAL's running note) ·
`fred/calendar_type_keys_v1` (Appendix A, machine-readable).

## 1. Consumers

Court ingest (v2 s2–4, `ai_match_types` verbs) · appointments (bookable staff time) ·
tasks/reminders (8AM jobs, digest, Shabbos/YT) · pipeline R2 `event(selector)`. Secondary:
`court_item_policy` blocking/calendar (now the registry — §3.3), staff case timeline, portal / R3
client card. Added by v0.5: trigger rules and sequence templates bind `type_key` directly (§6.1).

## 2. Verified inventory (live, 2026-08-26; deltas 2026-08-28..30 and 2026-09-01)

| store | shape | live usage | notes |
|---|---|---|---|
| `events` | event_type (free varchar), link ∈ {case, contact, **case_number**, NULL}, date, time, all_day, length, location, URL, note, status ∈ Scheduled/Completed/Canceled, gcal, with | **152 rows: 100 Scheduled, 52 Canceled** (155 at the 2026-09-01 U1 census) (of which **31 are July-cleanup dedup artifacts with a live Scheduled twin** — see §3.4). Link split **114 case_number / 36 case / 1 contact / 1 NULL** | Already the court occurrence store. Vocabulary: **25 distinct types** with live variants (`Confirmation Hearing`/`confirmation_hearing`, `Show Cause`/`Show Cause Hearing`, `Trial`/`Pre-Trial Hearing`/`Pre-trial Conference`, bare `Deadline` beside five `* Deadline`s) — mapped in Appendix A. `event_length` populated 11/152, none court-written (write-path gap, column fine). **No TZ columns** (date+time+all_day). |
| `appts` | appt_type, client+case, status ∈ Attended/No Show/Rescheduled/Canceled/Scheduled, `appt_date` (firm-local) **and** `appt_date_utc` (**2,106/2,213 rows differ**), platform, booking machinery, gcal | **2,216 rows** (BINARY census 2026-09-01; 2,213 at the 08-26 pass); **6 rows blank status** (ids in `fred/unified_events_handover`); `appt_with≠1` on 5 of 403 appts this year | E0a added `rescheduled_from_appt_id`; before it, succession lived only in `rescheduleAppt`'s write-time logic and trigger payloads, not as data. **`appt_type` is `utf8mb4_general_ci`** — a ci `GROUP BY` collapses spelling variants covering **19% of appts**; every census over it must be BINARY (Appendix A.2). |
| `tasks` | assignee, due, computed lifecycle, `task_link_type ENUM(...,'event')` already, 8AM one_time reminders, digest | daily use | Reminder/digest engine exists; under A6 tasks are a reminder *outcome*, produced by trigger rules. |
| `cases` date columns | 17; ~13 occurrence-shaped incl. `case_341_current` (datetime) + `case_341_initial` (date) + `_form`/`_link`, `docs_due`, `schedules_due_*`, `show_cause`, `case_objection`, `case_180`, `case_preference`, `filing_fee_extended_deadline`, matrix ×2; 4 lifecycle facts. **341 columns: 149/130 populated vs 16 event rows (~10×).** | staff forms + court executor `set_column` | **Staff editability is DB-defined, not HTML**: internal form templates `case_details` and `341_notes` carry these columns in `definition` AND `draft_definition` — `case_341_current` has THREE live writers today (two forms + set_column). |
| `court_item_policy` / `court_item_reminders` | storage ∈ appt/event/none, attendance, blocks, calendar; lead_days, assignee, title_template | **both EMPTY** | **Folded into the registry (A1/A2) and A6 respectively** — `storage` becomes derived (§3.3.2), `attendance`/`blocks` become registry columns, `court_item_reminders` becomes a `trigger_rules` seeder or is dropped. |
| `ai_match_types` | item_type, verb, collapse_same_date, workflow_id | seeded (court_nef) | Stays the **inbound recognition** registry (what a court email *is*). `item_type` becomes an FK-by-value to `calendar_item_types.type_key`. |
| `calendar_item_types` | *(new — U2)* | — | The registry of what a calendar item *is* (§3.3). |

**341 duplication, live 2026-08-30:** 12 Scheduled `341` events; 11 duplicate a Scheduled 341-type
appt on the same case, often with different dates; 26-46639 has two Scheduled 341 events a day
apart, unchained; 26-48181 has 08-25 and 09-02 both Scheduled. This is the evidence for A3.

Writers of `events` (complete): `eventService.js` (INSERT/PATCH/gcal) ← court executor
`create_event`/`update_event` + events internal fns + `public/eventform.html` (staff form,
free-text type — the source of the Title Case variants; U1 replaces it with a picker) +
`caseService.js` (case-renumber repoint — table-driven list, line drifts between bases). Writers of
the occurrence COLUMNS: the two internal form templates + court executor `set_column` (+
`checklistView.html`'s `docs_due` input).

## 3. Architecture: three records + one read layer

Not merging appts into events (booking machinery would leak into every deadline row); not turning
tasks into events (workload-shaped, not calendar-shaped). Seams:

### 3.1 `case_event` read layer — a service, NOT a SQL view (frozen contract)

`caseEventService.listForCase(db, caseId, opts)` + batched `listForCases`, returning
`{ source: 'event'|'appt', source_id, case_id, kind_key, type_key, title, starts_at, ends_at,
all_day, status_norm, location }`.

`opts.includeSuperseded` (default `false`): when `true`, superseded event rows AND
`Rescheduled` appt tombstones are returned, flagged `superseded: true`; event-source rows then
additionally carry `superseded_by_event_id` + `supersede_reason` (appt tombstones carry neither —
no such data exists; §3.4 asymmetry). Default-shape rows omit all three fields, keeping the frozen
R2 contract untouched. This is the §3.4 "chain on demand" mechanism — history views set the flag;
detectors never do.

- **Not a SQL VIEW** (MySQL temptable-materializes UNION views; R2's detector reads this
  per-case inside portal list loops). Per-source parameterized queries, unioned in JS, batched per
  detector kind across cases.
- **Link resolution (all four states):** `case` → direct. `case_number` → equality join on
  `cases.case_number OR cases.case_number_full` (the two existing log-feed indexes; same fragility
  note, re-check above 5–10k cases). `contact` → excluded from case-scoped reads. `NULL` (1 row) →
  excluded. Appts gain the same anchor shape at U6 (§3.4.1).
- **Link audit is three-way, not "orphans"** (shipped in E1; live 0 / 0 / 1): `broken`
  (`dead_case_id`), `pending` (`unresolved_case_number` — self-healing when the case appears),
  `unlinked` (legitimate — firm-wide events like office-closed or a CLE). Only `broken` is a
  defect. Widened to appts at U3, surfaced as a filter at U9.
- **`starts_at` representation (defined):** firm-local naive datetime, America/Detroit. Appt side
  sources **`appt_date` only — never `appt_date_utc`** (they differ on 2,106/2,213 rows; using the
  wrong one is a silent offset bug). Event side composes `event_date` + `event_time`
  (`all_day` → date at 00:00 + flag). No TZ conversion anywhere in this arc.
- **Keys:** E1 derives `type_key` / `kind_key` from Appendix A at exactly one site,
  `caseEventService._deriveKeys` (exports `_EVENT_TYPE_KEYS`, `_APPT_TYPE_KEYS`,
  `_EVENT_ROW_OVERRIDES` for U2's backfill assertions). Lookups normalize trim+lowercase to mirror
  the column collation; a vocabulary collision throws at load. **U3 swaps the derivation for the
  U2 columns there** — same output, one source of truth.
- **Unmapped and NULL types pass through honestly:** an unrecognized `event_type` / `appt_type` is
  returned raw with `kind_key` NULL and a warning — never a guessed kind. `appt_type IS NULL`
  (8 rows) yields `type_key` NULL. A guessed `meeting` would route the row to the wrong TABLE
  under §3.3.2, so guessing is not a cosmetic error (Fred, ruled).
- **Status:** `status_norm` per §3.7, which *extends* this section rather than forking it.
- **Opt-in fields:** `includeSuperseded` (above) and `attendees` (§3.6). The default row shape is
  frozen; new information arrives as opt-ins, never as new default keys.

### 3.2 Reminders = `calendar.approaching` + trigger rules (A6 — replaces v0.4 §3.2)

v0.4's dedicated reminder spawner is withdrawn. Synthetic emitter, same pattern as
`case.stage_aged`: claim table `calendar_approaching_emitted (source, source_id, offset_days,
emitted_at)`, daily job, emits `calendar.approaching` with `offset_days` in the envelope for each
live item whose `starts_at - offset` has passed and is unclaimed.

- Offsets configured per type (registry `approaching_offsets JSON`, e.g. `[7,1]`) — **or** per
  rule if that proves simpler; decide in U8.
- Reminder *outcomes* (task with dedup key, client SMS, staff email) are trigger rules, not
  bespoke code. A task outcome inherits the existing engine's assignability, digest and
  Shabbos/YT handling for free; `task_link_type='event'` already exists for provenance.
- `court_item_reminders` (empty) becomes a seeder into `trigger_rules`, or is dropped.
- Per-event `event_reminder` field stays for one release (§7 rule 4).
- **Assignee is a fixed user id** — there is no case→user assignment anywhere in the schema to
  role-resolve against. Role resolution ("the case's attorney") requires the case-roles concept —
  see Backlog. PIPE on this amendment: "prefer over my own §3.2".

### 3.3 One type registry — a TABLE, not a derivation (A1 — replaces v0.4 §3.3)

New table `calendar_item_types` is the registry of what a calendar item *is*, for court-sourced and
staff-sourced items alike, appts and events alike. `type_key VARCHAR(40)` is added to **both**
`appts` and `events`, backfilled once from Appendix A, written by every write path from U2 onward.
Consumers (trigger rules, sequence template filters, requirement detectors, booking views, court
executor) match on `type_key` only — never on the free-text label.

```
calendar_item_types
  type_key        VARCHAR(40)  PK                       -- 'iss', 'meeting_341', 'confirmation_hearing'
  label           VARCHAR(80)  NOT NULL
  kind            ENUM('hearing','meeting','deadline','conference','other') NOT NULL  -- byte-identical to events.kind (E0a column order; U2 ruling D1)
  singleton       TINYINT(1)   NOT NULL DEFAULT 0       -- one live per (anchor, type_key); new supersedes old  (§3.4.2)
  blocks_default  ENUM('attendee','firm','none') NOT NULL DEFAULT 'attendee'   -- was court_item_policy.blocks
  client_attends  TINYINT(1)   NOT NULL DEFAULT 0       -- default attendance; drives notify/portal
  default_length  SMALLINT     NULL                     -- minutes; court_v2 schema_gaps 'duration' lands here
  ingest_aliases  JSON         NULL                     -- inbound free text -> this key, WRITE TIME ONLY
  case_types      JSON         NULL                     -- picker scoping (Bankruptcy, Civil, ...); NULL = all
  active          TINYINT(1)   NOT NULL DEFAULT 1
  sort_order      INT          NOT NULL DEFAULT 0
  approaching_offsets JSON     NULL                     -- §3.2, if per-type wins at U8 — NOT in the U2 table; U8 adds it if that route wins
  created_at / updated_at
```

**As shipped at U2:** PK `type_key`, `KEY idx_cit_kind_active (kind, active)`, 34 seeded rows
(`scripts/calendarTypeSeed.js`, fixture `tests/fixtures/calendar_item_types.seed.json`), served by
`services/calendarTypeService.js`. `type_key` on both tables carries **no FK** — an unknown key must
be storable (raw passthrough) and the registry is data staff will edit, so integrity is asserted by
the migration's VERIFY 4 and by `tests/aiMatchTypes.registry.test.js`, not by the engine (`events` /
`appts` carry zero FKs — E0a convention). `singleton`, `blocks_default` and `client_attends` are
**data only** until U6 reads them; `active` gates pickers only — an inactive type still resolves.

**Why a table.** v0.4 derived keys at read time from 25 event strings and left appt types as free
text. Every write path keeps minting strings; every consumer keeps matching them. F1's alias-list
workaround (detector accepts an array of strings) is the symptom. Fred's ruling that ISS, Strategy
Session and "meeting" are **three distinct types** makes consumer-side *key lists* necessary, which
only works if keys exist as data.

**Relationship to the court sidecar.** `ai_match_types` stays the *inbound recognition* registry
(what a court email is); its `item_type VARCHAR(60)` already names the item type an email produces
and becomes an FK-by-value to `calendar_item_types.type_key`. `court_item_policy` (empty) folds in:
`storage` is derived (§3.3.2); `attendance`/`blocks`/`calendar` become
`client_attends`/`blocks_default` (§3.3.1). `court_item_reminders` (empty) is handled by A6.

**Aliases are not matching.** `ingest_aliases` is consulted only when an inbound writer supplies
free text (court extraction emits both `confirmation_hearing` and `Confirmation Hearing`; the
booking source writes `meeting`; API callers pass strings). **Readers never consult it.**

**Labels.** `appt_type` / `event_type` keep being written (registry label) for one release as the
raw display label; pre-cutover rows keep their historical string. After U5 proves every consumer is
on `type_key`, the string columns are dropped in a later slice. Two columns for one concept is
transitional, not permanent.

**Registry scope:** firm-specific seed (Fred). Non-BK case types are real (§Appendix A: civil
deadlines, depositions, pre-lawsuit, tax consults); multi-tenant later if ever.

**Picker (shipped at U2).** `eventform.html` renders a registry-fed picker — `GET
/api/calendar-types?kind=…&active=1` (`routes/api.calendarTypes.js`), option value = `type_key` —
and falls back to the existing `fe-event_types` setting list if that fetch fails or returns no
rows; `apptform2.html` shows the resolved key beside the label. (The draft put the picker in U1;
U1 went SQL-only, so it shipped with the table it reads.) `ingest_aliases` is applied at the two
INSERT sites in `apptService` / `eventService` and in their PATCH allowlists. **Still free text:**
`booking_views.appt_type` — U5 adds the key column and its picker (§8.3).

**Unmapped input is never guessed.** A string absent from the registry and from `ingest_aliases`
is stored raw with `type_key` NULL and a warning; `appt_type IS NULL` (8 rows) stays NULL. Under
§3.3.2 a guessed `kind` picks the wrong TABLE, so the failure mode of guessing is structural, not
cosmetic (Fred, ruled). **U2 ruling D7** settled the events half: a *non-blank* unmapped type is
stored `type_key` NULL **and `kind='other'`**; only a blank type leaves `kind` NULL. There is
deliberately **no `other` registry key** — NULL is the honest "no key" and cannot be bound by a
consumer by accident, while `WHERE type_key IS NULL AND kind='other'` is U9's worklist for minting
real types. That split is what makes the §7.1 rule 8 straggler gate readable: `kind='other'` is an
honest unmapped type, `kind` NULL on a freshly created row is a real straggler.

#### 3.3.1 No user initials in schema (A2)

`court_item_policy.attendance ENUM('none','ss','ss_client','client','staff')` and
`blocks ENUM('none','ss','firm')` hardcode one attorney's initials. The table is empty; fix it
before a row exists. Replaced by registry `client_attends` + `blocks_default` and, per row, the
existing `appt_with` / `event_with` (user id; `event_with` NULL = firm, 0 = nobody — already live
semantics in `availabilityService`). Role-resolved attendance ("the case's attorney") waits on the
case-roles design (Backlog; now four consumers deep).

#### 3.3.2 Storage rule (replaces v0.4 §5's per-type routing)

`kind='meeting'` → **`appts`**. `hearing | deadline | conference | other` → **`events`**. One rule,
no per-type surprises; `court_item_policy.storage` is therefore derived, not configured. The E0a
`events.kind` enum keeps `'meeting'` only for the interim 341 rows (U1 sets it; U7 empties it).

### 3.4 Multiplicity & supersession

The 341 question is cardinality, not vocabulary: one mutated row vs N rows with supersession.
`case_341_initial`/`case_341_current` is a hand-built two-slot adjournment history; mutate-in-place
loses information beyond two adjournments; `collapse_same_date` and the court-v2 S1
adjournment-identity blocker are the same question.

**Decision: supersession chains on `events`.** `events.superseded_by_event_id INT NULL` +
`events.supersede_reason ENUM('rescheduled','duplicate') NULL` (shipped in E0a — the reason column
is what keeps the two meanings from corrupting each other: chain queries — adjournment count,
first-of-chain, the court-v2 S1 identity question — filter `supersede_reason='rescheduled'`, while
the read-layer exclusion ignores reason entirely). Reschedule = create successor + stamp
predecessor with `'rescheduled'`. **E0a backfilled the 31 July-cleanup Canceled rows** with a
pointer to their (verified exactly-one) live twin and reason `'duplicate'`, so no phantom twins
render on day one of E1 and dedup artifacts can never inflate an adjournment chain. Those 31 rows
correctly KEEP `event_status='Canceled'` in the data (their GCal entries and reminder tasks are
already gone; nothing to un-cancel) — "`Canceled` means court-canceled only" is a statement about
**the read layer**, not the raw table; raw queries must filter the superseded check themselves.
**Supersession is the pointer, never a status** (E0a rule, kept).

**Stated asymmetry (not a bug, a boundary):** events get a chain; appts get a tombstone.
`appt_status='Rescheduled'` marks a dead row; `rescheduled_from_appt_id` (E0a) records the
predecessor going forward, but historic reschedules are permanently unrecoverable as structured
data. The read layer excludes dead appts and does not build appt chains (Backlog).

**`case_341_initial` stays a column** (v0.2's "becomes derived" is withdrawn — it contradicted
forward-only: 130 populated initials vs 16 event rows means most chains will never exist). It is
mirrored under §4's single-writer rule like every other occurrence column, and is additionally
reconstructible from the chain for post-s2 cases only.

#### 3.4.1 341 lives in `appts`, always (A3) — **ruled yes, Fred 2026-09-01**

A 341 is `kind='meeting'` → stored in `appts` (§3.3.2). Court-v2 resolves docket → case → primary
contact at write time and writes the appt through the U6 API; the registry's `singleton=1`
supersedes the prior live 341 (`rescheduled_from_appt_id`). If the docket does not resolve, the
appt is written **docket-anchored and client-less** and gains its client when the case appears.
`events.event_type='341'` stops being written at U7; the 12 live rows are migrated/deduped in U7.

**A3a — appts gain the event anchor shape.** `appt_link_type ENUM('case','contact','case_number')`
+ `appt_link_id VARCHAR(20)`, backfilled `case` when `appt_case_id<>''` else `contact`; docket
resolution query-side via the same join E1 uses. `appt_client_id` becomes "the client attendee"
(already nullable). `apptService` tolerates no client: skips confirmations and `pre_appt`
enrollment, logs it, still blocks the provider's calendar. `appt_case_id` keeps being written when
`link_type='case'` so nothing downstream breaks.

**Why.** The live duplication in §2 — v0.4 deferred 341 routing to the SS worksheet; the data has
answered it. Cross-table supersession (an event superseding an appt) would need a polymorphic
pointer — avoided entirely by one table per kind.

**U7's dedupe census runs by singleton identity, not by date** (PIPE, verified): the cross-form
duplicates are date-divergent — 26-46639's 45/85 differ by a day, likewise 50/86 and 46/51, and
same-date cross-form pairs number **0** — so `collapse_same_date` cannot catch them. Only
`(anchor, type_key)` can.

**Unaffected:** R2 requirement seeds bind 341 via `case_field(case_341_current)`; cutover to
`event(selector)` is optional at U5.

#### 3.4.2 `singleton` is registry policy, not code (A4)

`createAppt`'s `appt_type === '341 Meeting'` block (apptService ~992) and the court executor's
per-type reconcile become one rule in the U6 write API: if `type.singleton`, a new live row for
`(anchor, type_key)` supersedes the prior live row with `supersede_reason='rescheduled'` (events) /
`rescheduled_from_appt_id` (appts). Identity for court-v2's "which existing item": singleton →
`(anchor, type_key)`; else `(anchor, type_key, date)`. **This is the adjournment-identity answer
from the SS worksheet.** `ai_match_types.collapse_same_date` stays as the pre-create dedup rule
("same date ⇒ same item") applied before create-vs-supersede. Ships behind
`app_settings.unified_singleton_enabled` (default off) until verified live.

### 3.5 Domain events from both services (A5)

`calendar.scheduled` / `calendar.rescheduled` / `calendar.cancelled` / `calendar.resolved`, emitted
by `eventService` and `apptService`. Envelope carries `source ('appt'|'event')`, `source_id`,
`case_id`, `contact_id`, `type_key`, `kind`, `starts_at` (firm-local), `resolution`, and — for one
release — the legacy `appt_type` / `event_type` string. Existing `appt.*` names keep firing
unchanged (**aliases, not replacements**). Registered in `EVENT_TYPES` + coverage test per house
rule. `eventService` emits nothing today; `taskService` emits nothing today (unchanged).

### 3.6 Attendees: contract now, storage later (A8)

Read-layer rows may carry `attendees: [{party:'user'|'contact'|'external', id, label,
role:'host'|'attendee', blocks, notify}]` as an **opt-in field** (like `includeSuperseded`), derived
from `appt_with` / `appt_client_id` / `event_with` + registry `client_attends`. The U6 write API
accepts `attendees[]` and today validates exactly one `user` host and ≤1 `contact`. **No child
table** until a real multi-attendee case exists (12 of 1,078 cases have Primary+Secondary;
`appt_with≠1` on 5 of 403 appts this year). Default §3.1 row shape unchanged.

### 3.7 Status / resolution model (A7)

No existing enum changes. `appt_status` (Scheduled / Attended / No Show / Rescheduled / Canceled)
and `event_status` (Scheduled / Completed / Canceled) stay. One addition:
`events.event_resolution ENUM('held','met','missed','moot','cancelled') NULL`. Allowed values per
*kind*, fixed in code: meeting → attended/no_show/cancelled (appts encode these in `appt_status`
already); hearing/conference → held/cancelled; deadline → met/missed/moot. A daily sweep sets
`missed` on deadlines still `Scheduled` at date+1 (Fred: ok).

The read layer maps both tables to `state ∈ {live, resolved, cancelled, superseded}` +
`resolution`; §3.1's `status_norm` is **extended, not forked**, in the U3 alignment pass:

| source | raw | `state` | `resolution` | `status_norm` (R2 projection) |
|---|---|---|---|---|
| appt | Scheduled | live | — | `scheduled` |
| appt | Attended | resolved | attended | `held` |
| appt | No Show | resolved | no_show | `missed` |
| appt | Canceled | cancelled | cancelled | `canceled` |
| appt | Rescheduled | superseded (excluded by default) | — | excluded |
| appt | blank (6 rows) | live | — | null |
| event | Scheduled | live | — | `scheduled` |
| event | Completed | resolved | `event_resolution` ?? (deadline → met, else held) | `held` |
| event | Canceled + `event_resolution='moot'` | cancelled | moot | `canceled` |
| event | Canceled, no resolution | cancelled | cancelled | `canceled` |
| event | `superseded_by_event_id` set | superseded (excluded by default) | — | excluded |
| event | deadline, Scheduled, date+1 passed (sweep) | resolved | missed | `missed` |

v0.4's `status_norm` (`scheduled/held/missed/canceled`) remains the R2-facing projection of this;
`missed` gains the deadline sweep as a second source.

## 4. `cases` date-column disposition

Rule: **facts stay columns; occurrences move to events; every mirrored column has exactly one
writer — the event write path.** (`case_status`'s dual-writer disease — 733 blanks + legacy junk —
is the cautionary tale.)

- **Lifecycle facts** (`case_open`, `case_file_date`, `case_close`, `case_discharge`): columns,
  forever.
- **Writer census (finding A — method matters):** the census runs **once, up front**, and its
  primary source is **`form_templates.definition` AND `draft_definition`** — staff editability is
  DB-defined; an HTML grep finds `checklistView.html`'s `docs_due` input and misses the other
  nine. Known today: `case_details` exposes effectively ALL occurrence columns; `341_notes`
  exposes `case_341_current` + `docs_due`.
- **U10 (was E3) is therefore a form-definition migration, not ten column flips**: remove or make
  read-only the occurrence fields across the two internal templates via the forms draft→publish
  versioning, in one coordinated pass, then flip columns to event-owned mirrors per the court-v2
  rollout.
- **341 is a real migration** (columns 10× the event data). **Decided: forward-only** — no backfill
  of pre-s2 chains; columns stay authoritative for pre-s2 history; the mirror keeps them truthful
  after. Under A3 the mirror's source is the **appt**, not the event.
- **Ambiguous** (`case_180`, `case_preference`, matrix dates): SS worksheet — and per finding A,
  **lead the worksheet with the `case_details` form itself**, the firm's own statement of which
  dates staff considers theirs to edit.

## 5. Court v2 lands on this

- **Storage** is the §3.3.2 rule (`kind='meeting'` → appts, else events), not per-type policy.
- **Types** come from `ai_match_types.item_type` → `calendar_item_types.type_key`; the executor's
  `isShowCauseType` / `_normType` string sniffing becomes a registry lookup (U7).
- Verbs: scheduled → create (`scheduled`); rescheduled → **supersede** (§3.4); cancelled →
  `canceled`; occurred → `held` / `event_resolution`; status_changed → note/status.
  `collapse_same_date` = per-type "same date ⇒ same item" dedup applied **before**
  create-vs-supersede (§3.4.2).
- 341 writes go to `appts` via the U6 API (§3.4.1), docket-anchored and client-less when the
  docket doesn't resolve. U7's dedupe of the 12 live rows keys on `(anchor, type_key)`, not date.
- `court_v2 schema_gaps`: `block_minutes` → registry `default_length`; `blocks_whole_day` →
  `blocks_default`; both land at U7.
- **Gate: court v2 s2's prerequisite is this design AGREED (+ SS worksheet), not E1 shipped.** The
  schema atoms s2 needs shipped in E0a — so s2 never carries its own migration and no two slices
  race to alter `events`. E1 and s2 are order-independent. **U7 additionally requires U6**, and by
  both managers' agreement *the owner of U6 owns U7*.

## 6. Pipeline R2 contract (frozen)

`event(selector)`: `{ source: 'appt'|'event'|'any', kind_or_type: <string|array>,
want: 'held'|'scheduled'|'missed'|'any', which: 'latest'|'first'|'any' }` against §3.1's normalized
rows (superseded and appt-tombstones excluded; canceled only under `want:'any'`). Defaults
`which:'latest'`; match `type_key` first, then `kind_key`. R2 v1 ships `source:'appt'` only;
widening to `'event'|'any'` is adapter work, folded into U5.

**The selector *shape* does not change.** U5 migrates its *values* from strings to keys.

### 6.1 Consumer bindings after U5 (semantics preserved, no data lie)

| consumer | today | after |
|---|---|---|
| trigger rule 1 (consult booked) / 2 (consult attended) | `data.appt_type in [ISS, Strategy Session, Consultation, Intial]` | `data.type_key in ['iss','ss','consultation']` |
| trigger rule 3 (341 attended) | `data.appt_type == '341 Meeting'` | `data.type_key == 'meeting_341'` |
| sequence template 19 (pre_appt 341) / 20 (pre_appt ISS) | `filters.appt_type` string | `filters.type_key` |
| sequence templates 23/24 (no_show BK pre-file) | `"Initial Strategy Session\|Strategy Session\|Strategy Session Follow Up\|Pre-Filing Meeting"` | `['iss','ss','ss_follow_up','pre_filing']` |
| requirement 3 (`iss_held`) detector | `kind_or_type: [strings]` | `kind_or_type: ['iss','ss']` (shape unchanged) |
| `createAppt` 341 block | `=== '341 Meeting'` | registry `singleton` (U6) |
| courtExecutor `isShowCauseType` / `_normType` | string sniffing | registry lookup via `ai_match_types.item_type` (U7) |

## 7. Sequencing

**Shipped:** **E0a** — `events.kind`, `events.superseded_by_event_id`, `events.supersede_reason`,
`appts.rescheduled_from_appt_id` + the `rescheduleAppt` write, and the 31-row dedup
reclassification backfill (`reason='duplicate'`; every artifact has exactly one live twin,
verified). SQL: `ref/2026-08-27_unified_events_e0a.sql`. **E1** — `caseEventService`,
`routes/api.caseEvents.js`, `case.html` tabTimeline, three-way link audit; **E1b** — the
`link_type:'none'` read filter on `eventService.listEvents`. Landed 2026-09-01.
**U1** — `ref/2026-09-01_unified_events_e0b.sql`: `events.kind` by type plus the four hand-fixes;
applied and verified 2026-09-01. **U2** — `ref/2026-09-01_unified_events_u2.sql` + backend +
frontend: the registry, `type_key` on both tables, the generated backfill, `calendarTypeService`,
`GET /api/calendar-types` and the eventform picker; deployed and verified the same day.

Model column is CAL's recommendation for the *executing* worker when CAL writes the prompt.

| # | Slice | Model | Depends | Notes |
|---|---|---|---|---|
| E1 | `caseEventService` per §3.1 + case timeline + link audit (+E1b `link_type:'none'` filter) | PIPE's worker | — | **landed 2026-09-01** |
| U0 | this document; commit v0.4 + v0.5 to `ref/`; `fred/calendar_type_keys_v1` | CAL | — | **done** |
| U1 | **was E0b**: `ref/2026-09-01_unified_events_e0b.sql` — `events.kind` by type per Appendix A + the 4 hand-fixes, with a PRE-FLIGHT (unmapped types, must be 0 rows) and a VERIFY block. **SQL only; no picker** | **CAL-authored; Fred applied** | — | **applied + verified 2026-09-01.** Pre-flight returned 0 unmapped; the four hand-fixes executed; U2 re-ran the bulk statements for rows created in between |
| U2 | `calendar_item_types` (34 rows) + `type_key` on both tables + GENERATED backfill (`scripts/genTypeKeyBackfill.js`, byte-checked against E1); `calendarTypeService`; write paths (`createEvent` sets `kind`+`type_key`, `createAppt` sets `type_key`, PATCH allowlists, `err.status` convention); `GET /api/calendar-types`; eventform picker with setting fallback | **Fable** | U1 | **deployed + verified 2026-09-01** (168 / 5,466 / 1). Deferred out of the slice: labels not canonicalized (U5), `court_item_policy` untouched (U7), `booking_views` untouched (U5), registry admin CRUD → U2b (§8.2) |
| U3 | Alignment pass on E1 at `_deriveKeys`: column replaces derivation; vocabulary moves to `scripts/typeKeyVocabulary.js` (frozen, generator-only); delete `_EVENT_ROW_OVERRIDES`; `events.event_resolution` column (no writer until U6); `state`/`resolution` per §3.7; opt-in `attendees[]`; widen link audit to appts | **Opus** | E1, U2 | small; **prompt issued 2026-09-01** |
| U4 | `calendar.*` domain events from both services; dual-carry envelope; `EVENT_TYPES` + coverage test; no rules bound | **Opus** | U2 | zero behaviour change |
| U5 | Consumer cutover to keys (§6.1): rules 1–3, templates 19/20/23/24, requirement 3, detector `source:'event'\|'any'` (E1.5 folded in), booking views | **Opus** | U2, U3 | scripted; before/after live counts in the prompt |
| U6 | Write API `schedule/reschedule/cancel/resolve`; `singleton` behind `unified_singleton_enabled`; A3a docket anchor + client-less; `event_resolution` writes; `missed` sweep | **Fable** | U2 | the live-risk slice |
| U7 | Court-v2 s2 on U6: resolve/reconcile executor; 341 → appts; retire event `341`; dedupe the 12 **by singleton identity, not date**; CHECK constraint with strict-mode proof; `court_v2 schema_gaps` | **Fable** | U6 + SS worksheet | owner of U6 owns U7 (both managers) |
| U8 | `calendar.approaching` claim table + emitter; reminder rules seeded; `court_item_reminders` → seeder or drop | **Opus** | U4 | pattern exists (`case.stage_aged`) |
| U9 | Shell unified list (kind / attendee / anchor / range / **unlinked** filters) beside the three tabs; tabs removed one release later | **Opus** | U3 | UI only |
| U10 | **was E3** per §4: writer census (form_templates first), form-definition migration, mirror flips, 341 last / forward-only | **Fable** | U6, U7 | live staff forms |
| later | attendees table · appt chains · case roles · drop `appt_type`/`event_type` strings | — | — | |

**Timezone:** all times firm-local (America/Detroit); appt reads use `appt_date`, never
`appt_date_utc`. Single-district assumption is **unmonitored** — `cases` has no district/court
column (only judge/trustee), so nothing in the data would flag a violation. Accepted risk; revisit
if the firm files outside EDT. R3 renders times with an explicit zone label.

**Non-goals:** merging appts into events; appt succession chains; portal calendar; PACER pull;
multi-tenant registry.

### 7.1 Live-safety rules (every slice prompt carries these verbatim)

1. Additive DDL only. Nothing is dropped, renamed, or narrowed until the successor slice has
   proven the replacement live.
2. Backfills are idempotent (`WHERE type_key IS NULL`), standalone SQL, no session state, and end
   with VERIFY SELECTs whose expected counts are in the prompt.
3. New behaviour that changes what staff or clients see ships behind an `app_settings` flag,
   default off, with a one-line rollback (flip the flag).
4. Envelopes, filters and payloads dual-carry old and new fields for one release.
5. Deploy order: SQL → backend → frontend. Schema ref regenerated via
   `POST /admin/db/schema/save-to-ref` after every migration.
6. Full Jest suite before and after. **The baseline drifts continuously** (other arcs merge), so
   every prompt says verify-don't-trust and the worker reports the figure it actually measured.
   Last known: **168 suites / 5,466 tests / 1 skip**, measured at U2 landing 2026-09-01 (E1 landed
   at 161 / 5,382 / 1 earlier the same day). New services registered in `moduleLoad.smoke`; new
   domain events in `EVENT_TYPES` + coverage test.
7. Every prompt has a Rollback section and a "does not touch" list; workers stop and report on any
   divergence between prompt claims and repo/DB.
8. Post-deploy gates are readonly-SQL queries Fred runs, listed in the prompt with expected
   results. The standing straggler gate reads **rows, not a count**:
   `SELECT event_id, event_type, kind, type_key FROM events WHERE type_key IS NULL AND event_create_date > '<deploy ts>'`
   — `kind='other'` is an honest unmapped type (§3.3 D7; U9's worklist), `kind` NULL is a real
   straggler.
9. Any UPDATE backfill on `events` carries `event_updated_at = event_updated_at` in its SET.
   The column is `ON UPDATE CURRENT_TIMESTAMP`; U1 and U2 omitted this and bumped it on every
   pre-existing row (2026-09-01 ~10:47), so that timestamp is **not** staff activity. `appts` has
   no equivalent column.

## 8. Rulings and open items

### 8.1 Rulings log (Fred, 2026-08-30 and 2026-09-01)

| Question | Ruling |
|---|---|
| ISS vs Strategy Session vs "meeting" | **Three distinct types**: `iss`, `ss`, `meeting` |
| `Strategy Session Follow Up` | own key `ss_follow_up` (both managers concur; 173 rows + 1 stray `Follow Up`) |
| Storage rule `kind='meeting'` → `appts`, else `events` | ok |
| Deadline vocab `met/missed/moot`, sweep sets `missed` | ok |
| Attendees table | defer; contract only |
| Registry scope | firm-specific seed; non-BK case types exist; multi-tenant later if ever |
| Ambiguous `cases` columns | SS worksheet, led by the `case_details` form (answered R2 review) |
| Reminder assignee | fixed user id — nothing exists to role-resolve against |
| 341 backfill | forward-only; `case_341_initial` stays a mirrored column ("derived" withdrawn) |
| Court-email 341 supersedes/creates the 341 appt; event `341` retired (A3) | **yes** (2026-09-01) |
| Ownership | **B**, confirmed (2026-09-01); E1 carve-out completed |
| `Consultation` (7) | own key `consultation` |
| Hand-fixes ids 134 → Canceled, 107 → `filing_fee_deadline`, 4/6 → `test` | approved; executed in U1 |
| `appt_type IS NULL` (8 rows) | `type_key` NULL (honest passthrough; matches E1) — **not** `meeting` |
| Unmapped strings | raw passthrough, `kind_key` NULL, warn — never a guessed kind (a guessed `meeting` would route to the wrong TABLE under §3.3.2) |

### 8.2 Open — needs Fred

1. **Case roles is unowned** (PIPE handed it back): reminder assignee (§3.2), R3 team card, portal
   triage owner, A2 role-resolved attendance (§3.3.1). Four consumers, no manager — Fred to assign
   one.
2. **U2b — registry admin CRUD**, deferred out of U2. Until it exists, minting a type is a hand
   INSERT into `calendar_item_types`. It gates no slice, but U9's unmapped worklist (§3.3) assumes
   someone can act on what it surfaces — Fred to schedule it.

### 8.3 Open — design, not blocking

- **U8:** approaching offsets per type (registry column) vs per rule.
- **Supersession sign-off** was carried from v0.4 §8 Q2 and never explicitly ruled. E0a shipped
  the chain and E1 reads it, so it is settled in practice; §3.4's asymmetry (events chain, appts
  tombstone) stands unless Fred says otherwise.
- **SS worksheet** (still gates U7): adjournment identity is answered by §3.4.2; remaining items
  are chapter-conversion supersession and the ambiguous `cases` columns (`case_180`,
  `case_preference`, matrix ×2).
- **Deposition** — revisit `conference` if depositions want client reminders (would move to
  `meeting` → `appts`).

Reported by U2, recorded rather than worked around:

- **`ai_match_types.item_type` vs the registry:** the commented example row in
  `ref/2026-08-10_ai_match_registry.sql` uses `item_type '341_meeting'`; the registry key is
  `meeting_341`. U2's guard test (`tests/aiMatchTypes.registry.test.js` — every non-NULL
  `item_type` exists in the registry) fails if that row is uncommented as-is. Fix the comment when
  U7 touches the file.
- **Internal functions cannot carry an HTTP status.** `update_appointment` throws with
  `err.status = 400` on an unknown `type_key`, but only the message reaches
  `workflow_execution_steps.error_message`. Not hacked around in U2.
- **`booking_views.appt_type`** holds `Tax Consultation` and `Potato Hunting`, which resolve only
  through `ingest_aliases`. U5 adds a `type_key` column and a picker to the views manager.
- **Labels are not canonicalized.** U2 wrote keys but left `appt_type` / `event_type` as they
  stand, so the 30 appt spellings of Appendix A.2 are still in the rows. U5 decides whether the
  label follows the key or stays historical until the string columns drop.

## Appendix A. Type-key vocabulary v1

The E1 derivation map and the U2 backfill map. Machine-readable copy:
`fred/calendar_type_keys_v1`. Keys are lowercase snake, ≤40 chars, never start with a digit. One
vocabulary for both tables: `meeting_341` is the same key whether the row is a court-written event
today or an appt after U7.

### A.1 Events side (PIPE's E0b table, red-penned by CAL against the live rows)

25 BINARY-distinct = 25 ci-distinct — the events vocabulary is collation-clean.

| live `event_type` (n) | `type_key` | `kind` | note |
|---|---|---|---|
| Confirmation Hearing, confirmation_hearing | `confirmation_hearing` | hearing | merged spelling |
| Hearing | `hearing` | hearing | generic catch-all |
| Show Cause, Show Cause Hearing | `show_cause` | hearing | kind=hearing confirmed; `blocks_default='none'` |
| Trial | `trial` | hearing | |
| Trial / Pre-Trial Hearing (×1, id 134) | `trial` | hearing | row is "Order **Canceling** Trial and Pre-Trial Hearing Dates" stored as Scheduled → **hand-fix: set `event_status='Canceled'`**, key `trial` |
| Telephonic Status Conference, Status Conference | `status_conference` | conference | telephonic = attribute, not type |
| Initial Scheduling Conference | `scheduling_conference` | conference | |
| Pre-trial Conference | `pretrial_conference` | conference | |
| Deposition (×1, civil) | `deposition` | **conference** | stays in `events`; no client machinery; revisit if depositions want reminders |
| 341 | `meeting_341` | meeting | retired from events at U7 (§3.4.1) |
| dischargeability_due | `dischargeability_due` | deadline | |
| object_confirmation_due | `object_confirmation_due` | deadline | |
| poc_due | `poc_due` | deadline | |
| poc_gov_due | `poc_gov_due` | deadline | |
| Docs Deadline | `docs_deadline` | deadline | |
| Schedules Deadline | `schedules_deadline` | deadline | |
| Confirmation Certificate Deadline | `confirmation_certificate_deadline` | deadline | |
| Filing Fee Deadline | `filing_fee_deadline` | deadline | |
| Filing Fee Installment Deadline | `filing_fee_installment_deadline` | deadline | distinct, not merged |
| Deadline (×3) | `deadline` | deadline | **keep generic**: ids 63, 64 are civil-litigation deadlines (discovery close, response due) — non-BK types are real; id 6 is a test row on contact 1001, Canceled → `test` |
| Order (×1, id 107) | `filing_fee_deadline` | deadline | "Order Extending Time to Pay Case Filing Fee" all-day Scheduled — the date is the extended deadline; **hand-reclass** |
| Milestone (×1, id 4) | `test` | other | "Reminder smoke", no link, Canceled |

Registry rows seeded beyond the live set (so the picker is complete): `order` (other),
`milestone` (other), `test` (other, inactive).

### A.2 Appts side (BINARY census 2026-09-01: 30 distinct spellings + NULL, 2,216 rows)

**Regenerated for the ratified version.** `appt_type` is `utf8mb4_general_ci`, and the draft's ci
`GROUP BY` had collapsed spelling variants covering **19% of appts** — the dominant `Pre-filing
Meeting` (316) and `Meeting` (108) were both hidden behind their minority spellings. Every
spelling is listed below so a case-sensitive reader cannot miss one. E1 normalizes trim+lowercase;
U2's SQL backfill runs under general_ci; both hit every variant.

| live `appt_type` (n, exact) | `type_key` | `kind` | note |
|---|---|---|---|
| Initial Strategy Session (924), Intial Strategy Session (1) | `iss` | meeting | |
| Strategy Session (276) | `ss` | meeting | **distinct from `iss`** (Fred) |
| Strategy Session Follow Up (173), Follow Up (1) | `ss_follow_up` | meeting | |
| **Pre-filing Meeting (316)**, Pre-Filing Meeting (15), Pre-filing (30 min) (1) | `pre_filing` | meeting | the dominant spelling is lower-case f |
| 341 Meeting (241) | `meeting_341` | meeting | same key as events side |
| Schedules Completion Meeting (121), Schedules completion meeting (1) | `schedules_meeting` | meeting | |
| Documents Completion Meeting (1) | `docs_meeting` | meeting | |
| Matrix Completion Meeting (1) | `matrix_meeting` | meeting | |
| **Meeting (108)**, meeting (5), to go over claims (1), to go over objections to Chapt (1), Case Status Review (1) | `meeting` | meeting | generic (Fred) |
| NULL (8) | NULL | meeting (by table) | honest passthrough; not backfilled (§8.1) |
| Consultation (7; 4 from `test-consult` source, Rena, June 2026) | `consultation` | meeting | own key (Fred); rule 2 binds `['iss','ss','consultation']` |
| Pre-Lawsuit Meeting (2), Pre Lawsuit Meeting (1) | `pre_lawsuit` | meeting | non-BK |
| Tax Consult (2) | `tax_consult` | meeting | non-BK |
| test (2), test appt, test2 appt, test3 appt, Test Appointment, Pizza Party, bug hunting Session, Repetitive Session (1 each) | `test` | meeting | inactive in picker |

## Backlog (named here, owned elsewhere)

- **Case roles** (attorney/paralegal/owner per case): shared prerequisite for **four** consumers —
  reminder assignee (§3.2), R3's "Your team" panel, portal triage owner (portal messaging S4's
  blocker), and role-resolved attendance (§3.3.1). Deserves one design, not four ad-hoc solutions.
  **Unowned** — PIPE handed it back; awaiting a manager (§8.2).
- Appt succession CHAINS in the read layer (the pointer shipped in E0a; chain-building is the
  deferred part).
- Attendees child table (§3.6) — when a real multi-attendee case exists.
- Contact-scoped timeline (the 1 contact-linked event + contact appts).
- Drop `appt_type` / `event_type` strings once U5 proves every consumer is on `type_key`.
