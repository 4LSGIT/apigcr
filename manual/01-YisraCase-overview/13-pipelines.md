# Part 13 — Pipelines

---

A **pipeline** is the ordered path a case travels and the checklist of work that gets it to the
next step. It answers two questions staff ask constantly — *where is this case?* and *what's
left to do?* — and it answers the same questions for the client in the portal.

Two things that are easy to confuse, stated up front:

- **Stages are positions.** A case is at exactly one stage at a time. Moving between stages is
  called *advancing*, and it is recorded permanently.
- **Requirements are work.** Each stage can carry a list of work items — sign the retainer,
  upload documents, attend the strategy session. They are **derived**: nobody ticks them off; the
  system looks at the actual signature, upload, or appointment and reports what happened.

Pipelines are case-type agnostic. Bankruptcy is the first and largest vertical, so the examples
here are bankruptcy-shaped, but the machinery knows nothing about bankruptcy — a Civil Litigation
pipeline runs on exactly the same engine with different stages.

---

## Vocabulary

| Term | Meaning | Where it lives |
|---|---|---|
| **Pipeline** (template) | An ordered set of stages for one kind of case. The firm has five: Intake, Chapter 7, Chapter 13, Adversary Proceeding, Civil Litigation. | Case Config → Pipelines |
| **Stage** | One position on a pipeline. Has a key (`consult_booked`), an internal label ("Consult booked"), a client label ("Consultation scheduled"), and a lane. | Case Config → Pipelines |
| **Lane** | `main` = the happy path; `offramp` = a side exit (no-show, not interested, dead lead, dismissed, appeal). Off-ramps never appear as "upcoming" for a case that isn't on one. | per stage |
| **Terminal** | A stage nothing follows (dead lead, closed). Independent of lane. | per stage |
| **Phase** | Which *kind* of pipeline a case is on: `intake` (funnel) or `case` (matter). Flips automatically at retention — see *The hand-off*. | `cases.pipeline_phase` (system-managed) |
| **Bucket** | The legacy five-value Case Stage field (Open / Pending / Filed / Concluded / Closed) described in [Matters](03-matters.md). Every pipeline stage maps to one bucket and sets it on advance. | `cases.case_stage` |
| **Requirement** | A derived work item attached to a stage. | Case Config → Pipelines → stage → Requirements |
| **Override** | A staff decision that overrides derivation for one case: "not applicable," or "done" for something the system can't see. | Steps panel on the case |
| **Projection** | For a lead, the *likely next* pipeline's stages shown greyed as "typical next steps," before the lead is retained. | portal and Steps panel |

---

## How a case moves

### Position

A case's position is the most recent entry in its **stage log** — an append-only history of
every stage it has entered, with when, by whom, and why. The log is never edited or deleted, so
"where is this case" and "how did it get here" are the same record.

### Advancing

Advancing writes one log entry and, from the stage entered, sets the case's bucket, status
text, and the default *rec* (next-action) note. That overwrite is deliberate: the stage is the
single source for those three fields when pipelines are in use. (The Matters chapter describes
Case Status as free text — it still is, but an advance replaces it.)

Three properties matter in practice:

- **Repeat advances are no-ops.** Advancing to the stage the case is already on writes nothing.
  Automations can fire the same advance twice safely.
- **Skipping is legal.** A case can jump straight from `consult_booked` to `retained`; the stages
  in between simply never appear in its history. Nothing is owed to skipped stages — the
  requirements on them show as *skipped* rather than outstanding.
- **Backwards is legal for people, guarded for machines.** A staff member can force a case to
  any stage, including an earlier one, from the Steps panel. Automations use *guards* (below) so
  that a late-arriving signal — an intake form submitted after the consultation already
  happened — cannot drag a case backwards.

### The hand-off (intake → matter)

Leads run on the **Intake** pipeline. When a lead is retained, the `retained` stage lives on the
*matter* pipelines (Chapter 7, Chapter 13, …), not on Intake. Advancing to `retained` therefore
resolves into the right matter pipeline for the case's type and subtype, and flips the case's
phase from `intake` to `case` in the same write. From then on the case reads and advances
against its matter pipeline; the Intake stages drop out of its forward view (they stay in
history).

> **The Intake pipeline carries an *inactive* `retained` stage. Do not activate it.** It reads
> like an oversight; it is load-bearing. Because resolution prefers the pipeline the case is
> currently on, an *active* `retained` on Intake would win, the phase would never flip, and
> every retention would strand on the Intake pipeline. Case Config refuses (with a 409) to
> activate any stage key that is active on both an intake and a matter pipeline — that refusal
> is this rule enforced. The inactive row is used, read-only, as the generic "typical next steps"
> tail for leads whose subtype isn't known yet.

### Which pipeline a case is on

Resolved fresh on every read, never stored:

1. Phase `intake` → the Intake pipeline (its role is `intake`).
2. Phase `case` → the matter pipeline whose `case_subtype` matches exactly (Chapter 7 → Chapter 7).
3. Otherwise → the matter pipeline marked *default* for the case's `case_type`. Civil Litigation
   has one. **Bankruptcy deliberately has none** — a bankruptcy case with no chapter set has no
   pipeline until the chapter is known, rather than guessing Chapter 7.

---

## Requirements — the work inside a stage

Each stage can carry requirements. They are unordered and parallel: a client can upload
documents before signing the retainer, and the system shows one done and the other active.

### What a requirement knows

| Field | Purpose |
|---|---|
| Key (`sign_retainer`) | Stable identifier. Overrides attach to the *key*, so editing a requirement's label never detaches a staff decision, and the same key on two pipelines is the same work item. |
| Internal label / client label | What staff see / what the client sees. A client-visible requirement with no client label is *not shown* to the client (never falls back to the internal label). |
| Client visible | Whether it appears in the portal at all. |
| Required | Counts toward "steps remaining"; optional ones don't. |
| Owner | `client`, `staff`, or `system`. Only client-owned steps can be the client's "Active now." |
| Kind | `task` (numbered step) or `event` (rendered with a calendar glyph, no number — e.g. the 341 meeting). |
| Hint / effort / group | Static subtitle ("Last 60 days · 4 files"), effort estimate ("~25 min"), and an optional staff-side group heading. |
| Detector + config | *How the system decides it's done* — see the table. |

### Statuses

Every requirement resolves, per case, to one of:

| Status | Meaning |
|---|---|
| **done** | The detector found it satisfied (with a date), or staff marked it done. |
| **active** | On the case's current stage, not done. |
| **upcoming** | On a later stage. |
| **skipped** | On an earlier stage and never satisfied — the case moved past it. Not owed. |
| **na** | Staff marked it not applicable for this case. |

Order of precedence, when they conflict: a staff override wins; then the detector; then position.
The consequence worth remembering: **a satisfied requirement is *done* even if its stage is
behind the case** — a filed case whose questionnaire was submitted in March shows it done, not
skipped. Once a case is on a matter pipeline, every Intake-stage requirement counts as behind.

### Detectors

| Detector | Satisfied when | Config example |
|---|---|---|
| `esign` | A signing request of this kind for the case reached signed/completed | `{ "kind": "retainer_prepetition" }` |
| `checklist` | The case's checklist with this tag is complete (unsatisfied shows progress, e.g. "4 of 7 received") | `{ "tag": "docs_needed" }` |
| `form` | A submission of this form exists for the case | `{ "form_key": "intake" }` |
| `event` | An appointment of one of these types has the wanted outcome. `want`: `held` / `scheduled` / `missed` / `any`; `which`: `latest` / `first` / `any`. Several type names may be listed — booking history spells things more than one way | `{ "source": "appt", "kind_or_type": ["Initial Strategy Session", "Strategy Session"], "want": "held", "which": "latest" }` |
| `case_field` | A whitelisted date column on the case is set (filed date, discharge date, 341 date, docs due, …) | `{ "field": "case_341_current" }` |
| `report` | A saved report (zero parameters, columns `case_id` + `satisfied_at`, optional `detail`/`progress`) returns a row for the case. The escape hatch for anything the others can't express; the report is run once at save time to prove it fits | `{ "report_key": "req_tax_returns" }` |
| `manual` | Never automatically — only a staff override completes it | `{}` |

Configs are validated when saved (a bad field name, a report with the wrong columns, or an
unsupported event source is refused at authoring time, not discovered later on a case page).
The `event` detector currently reads appointments only; court events arrive with the unified
calendar work.

### Overrides

From the Steps panel, staff can mark any requirement **N/A** or **done**, with a note, and clear
it again. Each change writes a status entry to the case's activity log. Overrides are the only
"marking" in the system — everything else is derived, so the panel is telling the truth even for
cases nobody has touched.

> **Practice note:** the *upload documents* requirement is derived from the docs checklist. That
> checklist is rarely completed in day-to-day use, so the requirement reads outstanding on nearly
> every case. It is hidden from clients for that reason until checklist practice changes.

---

## Where staff see it

### The Steps panel (case page)

The case page's pipeline panel shows one list: the pipeline's main-lane stages as sections, the
current one highlighted with its entered-on date, each stage's requirements inside it with
status icons, subtitles, owner badges, and override controls on hover. Off-ramps sit in a side
rail. Below, an **Earlier** block holds two collapsibles — *Intake steps* (for a case already on a
matter pipeline) and *Stage history* (every log entry, newest first, including repeats).

The **advance** control moves the case. It offers the resolved pipeline's stages; to force a case
onto a stage of a *different* pipeline (back to an Intake stage from a matter pipeline, say), use
the numeric stage-id form the control accepts — that is the documented route, not a bug.

### The board (Cases → Pipeline tab)

A Kanban view: one column per stage in pipeline order, a dashed divider, then the off-ramp
columns. Cases with no history yet sit in an *unstaged* bucket. Pick the pipeline at the top.

### Case Config → Pipelines (admin)

Create and edit pipelines and stages: order, keys, labels, bucket mapping, lane, terminal,
client visibility, the default rec text. Each stage expands to its requirements sub-editor
(the detector list is pulled from the running system, so new detectors appear automatically).

The admin refuses three things on purpose:

- activating a stage key that is active on both an intake and a matter pipeline (the hand-off
  rule above);
- renaming a requirement key once any case has an override on it (the override would silently
  detach — delete the overrides first, or leave the key);
- deleting a stage that still has requirements or log history (delete the requirements first;
  history is never deleted).

---

## What the client sees

The portal's case view leads with **Your next steps**: the client-visible requirements of the
current and upcoming stages, in order. Done steps show a check and the date; the first
outstanding step that is required *and* client-owned carries the single **Active now** chip;
staff-owned steps appear but are never "active" (their subtitle says who's handling it). Steps
of kind `event` get a calendar glyph instead of a number. Skipped and N/A steps are not shown.
The header counts remaining required steps.

Below it, the **Case Progress** timeline shows the stages entered so far and those still ahead.
For a lead, both surfaces end with greyed **typical next steps** — the matter pipeline the lead
is heading into if its chapter is known, or a single "Retained" placeholder if it isn't.

---

## Automation

### The `advance_stage` function

Available in workflows, sequences, and trigger rules. Parameters:

| Param | Meaning |
|---|---|
| `case_id` | The case. |
| `stage` | Target stage key (or a numeric stage id to bypass resolution). |
| `note` | Free text stored on the log entry. |
| `only_from` | Comma list of stage keys the case must currently be on; `none` means "has no history yet." Anything else → the advance is **skipped silently**. |
| `only_from_role` | Same, by pipeline role: `intake`, `case`, `none`. |
| `forward_only` | `true` → skip unless the target is strictly ahead: into an off-ramp is always allowed; off-ramp back to main, main to an earlier stage, or matter back to intake are all refused. Typos in the value are an error, never a silent disarm. |

A guard miss produces a *skip*, not an error, and writes nothing — that is what lets automations
react to signals in any order without ever moving a case backwards. All supplied guards must
pass. A repeat advance is a no-op even under `forward_only`.

### Events other automations can react to

| Event | Fires when | Notable fields |
|---|---|---|
| `case.stage_advanced` | Any real advance (not no-ops, not skips) | `data.stage_key`, `data.status_label`, `data.case_stage`, `data.case_type`, `data.case_subtype`, `extra.from_stage`, `extra.note` |
| `case.stage_aged` | Nightly, once per case per threshold, when a case has sat in a stage past a configured number of days | `data.stage_key`, `data.threshold_days`, `data.days_in_stage` |

### What moves cases today (September 2026)

Live rules and workflows — check the Triggers manager for the current list:

- Contract sent for signature → `contract_sent` (only from an intake position or no history).
- Intake form submitted → `intake_complete` (only from `lead` / no history).
- Retainer signed → `retained` (only from intake / no history) — the hand-off.
- Document request sent → `docs` (only from `retained`).
- Consultation booked / attended / no-show → `consult_booked` / `consult_held` / `no_show`
  (currently inside the appointment code rather than rules).
- Every advance is also written to the case's activity log by a rule.

---

## Merging cases

When two cases are merged, the loser's stage history moves to the survivor and interleaves by
date. Because "position" is the newest log entry, a lead's fresher history could otherwise
appear to demote the surviving matter; the merge prevents this by re-asserting the survivor's
own position as a new entry (noted `[merge <loser>] position re-asserted`) whenever the loser's
entries would lead. The dry-run preview shows the decision (`row` / `warn` / `none`) before you
confirm. Overrides move to the survivor too; where both cases had an override on the same key,
the survivor's is kept.

---

## Troubleshooting

| Symptom | Why | What to do |
|---|---|---|
| A lead's timeline shows nothing after "Agreement sent" | No matter pipeline resolves — the lead has no chapter/subtype yet | Set the subtype; until then the generic "Retained" placeholder is correct |
| Advance to an Intake stage fails with 400 on a retained case | The matter pipeline has no Intake keys; resolution is by the pipeline the case is on | Use the numeric stage id in the advance control |
| Case Config won't let you activate a stage | Its key is active on a pipeline of the other role (the hand-off rule) | Rename the key, or leave it inactive — never force it |
| A requirement never becomes done | Its detector's basis isn't happening (e.g. the checklist isn't being completed) | Change the detector, or override it per case; don't expect staff marking |
| Requirement key rename refused | A case has an override on that key | Clear the override(s) first |
| Status text changed by itself | An advance ran; the stage's status label overwrote it | Expected — set status via the stage, or accept the overwrite |
| A client sees "Active now" on the wrong step | Ordering is stage order, then requirement order, first required client-owned outstanding step | Reorder requirements in Case Config, or set the owner to `staff` |

---

## Developer reference

**Tables:** `pipeline_templates`, `pipeline_stages` (lane, is_terminal, client_visible,
case_stage bucket, default_rec), `case_stage_log` (append-only; the position oracle),
`pipeline_stage_requirements`, `case_requirement_overrides` (unique per case + key),
`case_stage_aged_emitted` (claim table for the nightly emitter).

**Services:** `services/pipelineService.js` (`getPipeline` — payload contract C1 is byte-stable
for matter-phase cases; `advanceStage` with `GET_LOCK` concurrency; template resolution;
projection), `services/pipelineAdminService.js` (CRUD + the invariants), `services/
requirementService.js` (batched resolver — a full resolve is a bounded number of queries per
detector *kind* across all cases, never per case), `services/requirementDetectors.js` (the
registry; each detector validates its config at save time, optionally against the DB),
`services/portalCaseService.js` (next-steps card, timeline), `lib/internal_functions/pipeline.js`.

**API:** `GET /api/cases/:id/pipeline` (`?requirements=1` attaches per-stage requirements;
`projected` present only on intake-phase payloads), `GET /api/cases/:id/pipeline/requirements`
(both applicable pipelines — the only surface where a matter case's Intake requirements are
visible), `POST /api/cases/:id/pipeline/advance`, `POST` / `DELETE
/api/cases/:id/pipeline/requirements/:key/override`, `GET /api/pipeline-board`, and the
`/api/pipeline-admin/*` CRUD (templates, stages, reorder, requirements, detectors, usage).

**Frozen contracts** (other arcs build on these): the resolved-requirement shape; the event
detector's selector shape `{source, kind_or_type, want, which}`; the `projected` payload key; the
default `getPipeline` payload. Values may change (type names becoming registry keys); shapes
don't.

**Tests:** `tests/pipelineService.test.js`, `pipelineAdminService.test.js`,
`requirementService.test.js`, `pipelineBoard*.test.js`, `caseUi.stepsPanel.test.js`,
`portalNextSteps.test.js`, `caseMergeShapes.test.js`, `pipelineInternalFn.guard.test.js`.
