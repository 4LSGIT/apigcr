# UNIFIED EVENTS DESIGN — appts / events / deadlines / tasks
**v0.4 — FROZEN (post review round 3). All figures verified live 2026-08-26.**
**Changelog v0.3→v0.4:** `supersede_reason` added so dedup artifacts can't pollute adjournment
chains (r3-1); §3.1 gains `includeSuperseded` and defines the extended row shape (r3-2);
`appts.rescheduled_from_appt_id` promoted from backlog to E0a — reschedule lineage is currently
lossy, nothing persists it (r3-3); E0 split into E0a (zero-judgment, ships now) / E0b (Fred-gated
mapping), deleting §5's ride-along contingency (r3-4); "Canceled means court-canceled" scoped to
the read layer; line-cites de-precisioned.

## 0. Purpose and constraint

One coherent model for every date-bearing thing a case has — hearings, deadlines, meetings,
appointments, reminders — so that: (a) court pipeline v2 s2–4 land on a settled substrate; (b)
pipeline R2's `event(selector)` binding has a stable contract; (c) staff and portal get one case
timeline; (d) reminders stop being three unrelated mechanisms. Glade's post-filing panel
(Hearing | Deadline | Conference; When / Trustee / Location / "Synced from PACER") is the reference
rendering. **Consolidation, not greenfield**: three date stores are live; this doc decides
ownership and evolution.

## 1. Consumers

Court ingest (v2 s2–4, `ai_match_types` verbs) · appointments (bookable staff time) ·
tasks/reminders (8AM jobs, digest, Shabbos/YT) · pipeline R2 `event(selector)`. Secondary:
`court_item_policy` blocking/calendar, staff case timeline, portal / R3 client card.

## 2. Verified inventory (live, 2026-08-26)

| store | shape | live usage | notes |
|---|---|---|---|
| `events` | event_type (free varchar), link ∈ {case, contact, **case_number**, NULL}, date, time, all_day, length, location, URL, note, status ∈ Scheduled/Completed/Canceled, gcal, with | **152 rows: 100 Scheduled, 52 Canceled** (of which **31 are July-cleanup dedup artifacts with a live Scheduled twin** — see §3.4). Link split **114 case_number / 36 case / 1 contact / 1 NULL** | Already the court occurrence store. Vocabulary: **25 distinct types** with live variants (`Confirmation Hearing`/`confirmation_hearing`, `Show Cause`/`Show Cause Hearing`, `Trial`/`Pre-Trial Hearing`/`Pre-trial Conference`, bare `Deadline` beside five `* Deadline`s) — E0 is a judgment-call mapping. `event_length` populated 11/152, none court-written (write-path gap, column fine). **No TZ columns** (date+time+all_day). |
| `appts` | appt_type, client+case, status ∈ Attended/No Show/Rescheduled/Canceled/Scheduled, `appt_date` (firm-local) **and** `appt_date_utc` (**2,106/2,213 rows differ**), platform, booking machinery, gcal | 2,213 rows | **No successor/superseded pointer of any kind** — succession lives in `rescheduleAppt`'s write-time logic and trigger payloads (`extra.rescheduled_from`, `apptService.js` ~1092), not as data. |
| `tasks` | assignee, due, computed lifecycle, `task_link_type ENUM(...,'event')` already, 8AM one_time reminders, digest | daily use | Reminder/digest engine exists; provenance needs only a dedup key. |
| `cases` date columns | 17; ~13 occurrence-shaped incl. `case_341_current` (datetime) + `case_341_initial` (date) + `_form`/`_link`, `docs_due`, `schedules_due_*`, `show_cause`, `case_objection`, `case_180`, `case_preference`, `filing_fee_extended_deadline`, matrix ×2; 4 lifecycle facts. **341 columns: 149/130 populated vs 16 event rows (~10×).** | staff forms + court executor `set_column` | **Staff editability is DB-defined, not HTML**: internal form templates `case_details` and `341_notes` carry these columns in `definition` AND `draft_definition` — `case_341_current` has THREE live writers today (two forms + set_column). |
| `court_item_policy` / `court_item_reminders` | storage ∈ appt/event/none, attendance, blocks, calendar; lead_days, assignee, title_template | **both EMPTY** — SS worksheet gate | `storage='event'` anticipates `events`. |
| `ai_match_types` | item_type, verb, collapse_same_date, workflow_id | seeded (court_nef) | Type registry for court-sourced items. |

Writers of `events` (complete): `eventService.js` (INSERT/PATCH/gcal) ← court executor
`create_event`/`update_event` + events internal fns + `public/eventform.html` (staff form,
free-text type — likely source of Title Case variants) + `caseService.js` (case-renumber repoint —
table-driven list, line drifts between bases). Writers of the occurrence COLUMNS: the two internal form templates + court executor
`set_column` (+ `checklistView.html`'s `docs_due` input).

## 3. Architecture: three records + one read layer

Not merging appts into events (booking machinery would leak into every deadline row); not turning
tasks into events (workload-shaped, not calendar-shaped). Four seams:

### 3.1 `case_event` read layer — a service, NOT a SQL view

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
  excluded; orphan-audit query ships with E1.
- **`starts_at` representation (defined):** firm-local naive datetime, America/Detroit. Appt side
  sources **`appt_date` only — never `appt_date_utc`** (they differ on 2,106/2,213 rows; using the
  wrong one is a silent offset bug). Event side composes `event_date` + `event_time`
  (`all_day` → date at 00:00 + flag). No TZ conversion anywhere in this arc.
- **Status normalization:** events Scheduled→`scheduled`, Completed→`held`, Canceled→`canceled`;
  appts Scheduled→`scheduled`, Attended→`held`, No Show→`missed`, Canceled→`canceled`,
  **Rescheduled→excluded (tombstone — see §3.4 asymmetry)**. Superseded event rows excluded by
  default everywhere. Canceled included, greyed in timelines, excluded from detectors unless
  `want:'any'`.

### 3.2 One reminder engine: reminders spawn tasks

Event/appt reminders create tasks (assignable, digest-integrated, Shabbos-aware).
`court_item_reminders` (lead_days / assignee / title_template) is task-spawner config. Provenance:
`task_link_type='event'` exists already; dedup key (event_id, reminder_id). **Assignee is a fixed
user id** — there is no case→user assignment anywhere in the schema to role-resolve against (§8 Q3,
answered). Role resolution ("case's attorney") requires the case-roles concept — see backlog.

### 3.3 One type registry

Add `events.kind ENUM('hearing','meeting','deadline','conference','other')`. Court types from
`ai_match_types.item_type`; staff types from a controlled picker **in eventform.html** (E0 — that
form mints the variants today). The 25→canonical mapping table ships in E0 with the judgment calls
listed for Fred.

### 3.4 Multiplicity & supersession

The 341 question is cardinality, not vocabulary: one mutated row vs N rows with supersession.
`case_341_initial`/`case_341_current` is a hand-built two-slot adjournment history; mutate-in-place
loses information beyond two adjournments; `collapse_same_date` and the court-v2 S1
adjournment-identity blocker are the same question.

**Decision: supersession chains on `events`.** `events.superseded_by_event_id INT NULL` +
`events.supersede_reason ENUM('rescheduled','duplicate') NULL` (E0a — the reason column is what
keeps the two meanings from corrupting each other: chain queries — adjournment count,
first-of-chain, the court-v2 S1 identity question — filter `supersede_reason='rescheduled'`, while
the read-layer exclusion ignores reason entirely). Reschedule = create successor + stamp
predecessor with `'rescheduled'`. **E0a backfills the 31 July-cleanup Canceled rows** with a
pointer to their (verified exactly-one) live twin and reason `'duplicate'`, so no phantom twins
render on day one of E1 and dedup artifacts can never inflate an adjournment chain. Those 31 rows
correctly KEEP `event_status='Canceled'` in the data (their GCal entries and reminder tasks are
already gone; nothing to un-cancel) — "`Canceled` means court-canceled only" is a statement about
**the read layer**, not the raw table; raw queries must filter the superseded check themselves.

**Stated asymmetry (not a bug, a boundary):** events get a chain; appts get a tombstone.
`appt_status='Rescheduled'` marks a dead row, but no successor pointer exists in appt data —
`rescheduled_from` lives only in the transient trigger payload (`apptService.js` ~1092); nothing
persists it (`domainEvents.js` is dispatch-only, no table). The read layer excludes dead appts but
cannot build appt chains. **E0a therefore adds `appts.rescheduled_from_appt_id INT NULL` and
`rescheduleAppt` populates it** — not to serve chains now (tombstone semantics stand for E1/R2),
but because every reschedule before that column exists is permanently unrecoverable as structured
data. Stop the bleeding; build appt chains later only if wanted.

**`case_341_initial` stays a column** (v0.2's "becomes derived" is withdrawn — it contradicted
forward-only: 130 populated initials vs 16 event rows means most chains will never exist). It is
mirrored under §4's single-writer rule like every other occurrence column, and is additionally
reconstructible from the chain for post-s2 cases only.

## 4. `cases` date-column disposition

Rule: **facts stay columns; occurrences move to events; every mirrored column has exactly one
writer — the event write path.** (`case_status`'s dual-writer disease — 733 blanks + legacy junk —
is the cautionary tale.)

- **Lifecycle facts** (`case_open`, `case_file_date`, `case_close`, `case_discharge`): columns,
  forever.
- **Writer census (finding A — method matters):** the census runs **once, up front**, and its
  primary source is **`form_templates.definition` AND `draft_definition`** — staff editability is
  DB-defined; an HTML grep finds `checklistView.html`'s `docs_due` input and misses the other
  nine. Known today: `case_details` exposes effectively ALL occurrence columns;
  `341_notes` exposes `case_341_current` + `docs_due`.
- **E3 is therefore a form-definition migration, not ten column flips**: remove or make read-only
  the occurrence fields across the two internal templates via the forms draft→publish versioning,
  in one coordinated pass, then flip columns to event-owned mirrors per the court-v2 rollout.
- **341 is a real migration** (columns 10× the event data). **Decided: forward-only** — no
  backfill of pre-s2 chains; columns stay authoritative for pre-s2 history; the mirror keeps them
  truthful after.
- **Ambiguous** (`case_180`, `case_preference`, matrix dates): SS worksheet — and per finding A,
  **lead the worksheet with the `case_details` form itself**, the firm's own statement of which
  dates staff considers theirs to edit.

## 5. Court v2 lands on this

- `court_item_policy.storage` routes per type: appt / event / none. Policy stays the court sidecar.
- Verbs: scheduled → create (`scheduled`); rescheduled → **supersede** (§3.4); cancelled →
  `canceled`; occurred → `held`; status_changed → note/status. `collapse_same_date` = per-type
  "same date ⇒ same item" dedup rule applied before create-vs-supersede.
- `court_item_reminders` seeds §3.2. Still gated on the SS worksheet.
- **Gate: court v2 s2's prerequisite is this design AGREED (+ worksheet), not E1 shipped.** The
  schema atoms s2 needs all live in **E0a, which has zero judgment content and ships immediately**
  — so s2 never carries its own migration and no two slices race to alter `events`. E1 and s2 are
  order-independent.

## 6. Pipeline R2 contract (frozen)

`event(selector)`: `{ source: 'appt'|'event'|'any', kind_or_type: <string>,
want: 'held'|'scheduled'|'missed'|'any', which: 'latest'|'first'|'any' }` against §3.1's normalized
rows (superseded and appt-tombstones excluded; canceled only under `want:'any'`). Defaults
`which:'latest'`; match `type_key` first, then `kind_key`. R2 v1 ships `source:'appt'` only;
widening later is adapter work.

## 7. Sequencing

- **E0a** (zero judgment, ships now) — `events.kind`, `events.superseded_by_event_id`,
  `events.supersede_reason`, `appts.rescheduled_from_appt_id` + the `rescheduleAppt` write, and the
  **31-row dedup reclassification backfill** (`reason='duplicate'`; every artifact has exactly one
  live twin, verified).
- **E0b** (gated on Fred) — the 25→canonical type mapping (judgment table) + controlled type
  picker in eventform.html.
- **E1** — `caseEventService` + staff case timeline + orphan audit. Read-only.
- **E2** — reminders spawn tasks; dedup key; `court_item_reminders` seed format finalized.
- **E3** — the up-front writer census (form_templates-first), the **form-definition migration**
  (one coordinated draft→publish pass over `case_details` + `341_notes`), then per-column mirror
  flips; 341 last, forward-only.
- Court v2 s2–4: gated on design-agreed + SS worksheet only. s4 independent.
- **Timezone:** all times firm-local (America/Detroit); appt reads use `appt_date`, never
  `appt_date_utc`. Single-district assumption is **unmonitored** — `cases` has no district/court
  column (only judge/trustee), so nothing in the data would flag a violation. Accepted risk;
  revisit if the firm files outside EDT. R3 renders times with an explicit zone label.
- Non-goals: merging appts into events; appt succession chains; generalizing court_item_policy;
  portal calendar; PACER pull.

## 8. Open questions & answers

1. ~~Ambiguous columns~~ → **SS worksheet, led by the `case_details` form** (answered R2 review).
2. **Supersession — Fred sign-off pending**, with §3.4's asymmetry attached: events chain, appts
   tombstone; appt chains would be a later second column, not a free consequence.
3. ~~Reminder assignee~~ → **fixed user id** (answered: nothing exists to role-resolve against).
4. ~~341 backfill~~ → **forward-only**; `case_341_initial` stays a mirrored column ("derived"
   withdrawn).

## Backlog (named here, owned elsewhere)

- **Case roles** (attorney/paralegal/owner per case): shared prerequisite for TWO arcs — R3's
  "Your team" panel and role-resolved reminder assignees — plus plausible future triage owners
  (portal messaging S4's blocker). Deserves one design, not three ad-hoc solutions.
- Appt succession CHAINS in the read layer (the pointer itself ships in E0a; chain-building is
  the deferred part).
- Contact-scoped timeline (the 1 contact-linked event + contact appts).