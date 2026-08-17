# 15 — Trigger System

## For operators

Every other subsystem in YisraFlow waits to be *told* to run: a hook receives a webhook, a scheduled job hits its time, someone starts a workflow. The Trigger System is the one that watches YisraCase itself. When an appointment is marked attended, a contact's phone number changes, a checklist finishes, an e-sign comes back signed — the system announces it, and any rule you've written for that announcement fires.

That announcement is called an **event**. A **rule** says "when *this* event happens, and *these* things are true about it, do *that*."

A rule has four parts:

1. **Event** — which announcement to listen for (`appt.attended`, `case.updated`, …)
2. **Match** — should this particular one count? (only Consultations; only when the docket changed)
3. **Transform** — reshape the event into what the actions need (usually: leave it alone)
4. **Actions** — what to do, in order (advance a stage, start a workflow, enroll a sequence, call a hook)

You'd reach for a trigger rule when something *inside* the system should cause something else inside the system, and you want it visible and editable rather than buried in code. The four seeded rules are exactly this shape — "consult booked → move the case to consult_booked" used to be the kind of thing that lived in a service file.

You wouldn't reach for one when:
- The cause is external — that's a **Hook** (chapter 9)
- The cause is a clock — that's a **Scheduled Job** (chapter 4)
- You need several steps with branching — write a **Workflow** and have the rule start it

**In `automationManager.html` → Triggers tab**, rules are listed on the left grouped by event. Each shows its action count, how many times it has matched, and — in red — how many times it has errored. Click one to edit it. The **Executions** tab is the log: every event the system processed, whether any rule matched, and what happened.

When a rule doesn't fire when you expected:

1. Open the **Executions** tab and filter to the event type. Is the event there at all? If not, the mutation that should have announced it may be one of the ones that bypasses the announcement (see *What bypasses each event* below).
2. Found the event with status `no_match`? Your conditions didn't match this one. Open it, press **Test / dry run**, and you'll see each active rule and whether it matched.
3. Status `no_match` with a `skipped_cooldown` warning in the outcomes? The rule matched but was inside its **Min interval** window.
4. Status `partial` or `error`? The rule matched and an action failed. The outcomes JSON names which one and why.
5. Rule never appears at all? Check it's **Active**, and that its event is the one actually firing.

Two things worth knowing before you write your first rule:

- **A rule with no conditions matches everything.** That's a real, supported choice (one of the seeded rules uses it), so the editor makes you confirm it out loud when you save.
- **"Run live" on the Executions tab really runs.** It replays a recorded event through the engine and fires real actions — real SMS, real stage moves. The dry run next to it is the safe one.

---

## Technical reference

### Files

```
lib/domainEvents.js                 emit() + envelope builder + ALS loop guard
services/triggerService.js          Engine: registry, match, transform, dispatch, CRUD
routes/api.triggers.js              REST surface
public/automation/triggers.html     UI (iframed tab in automationManager.html)
public/automation/matchBuilder.js   Shared condition-tree builder (also used by the ingest pages)
lib/internal_functions/system.js    sweep_trigger_executions — retention; emit_stage_aged — nightly case.stage_aged emitter
```

Emission sites live in the services that own each mutation — `apptService`, `contactService`, `caseService`, `pipelineService`, `formService`, `esignWebhookService`, and `routes/api.checklists.js`.

### The envelope

Every event is normalized into one shape before any rule sees it. Rule conditions, transforms, and action params all address it by dot-path.

```js
{
  event:      'appt.attended',     // dot-namespaced type
  ts:         '2026-08-17T14:22:05.331Z',
  depth:      0,                   // trigger-chain depth (see Loop guard)
  chain:      [],                  // trigger_rules.id path that led here
  source:     'manual',            // 'manual'|'system'|'client'|'booking'|'automation'|… or null
  actor:      { user_id: 6 },      // or null when the writer doesn't know who
  contact_id: 412,                 // promoted to the top level for uniform paths
  case_id:    '7XK4MQ2R',          //   (both are also trigger_executions columns)
  data:       { …row snapshot AFTER the mutation… },
  changes:    { case_number: { from: '', to: '24-31852' } },   // update-class events only
  extra:      { prior_status: 'Scheduled' }                     // per-event specifics
}
```

Notes that matter when authoring:

- **`changes` only appears on update-class events** (`contact.updated`, `case.updated`). `changes.<column>` existing at all means that column changed — `{ "path": "changes.case_number", "op": "exists" }` is the idiomatic "did the docket change" rule. `.from` / `.to` carry the values.
- **Any column works in `changes`,** not just the ones in the field picker. The picker is a discovery aid; use **Custom path…** for anything else.
- **`case_id` is a string** (opaque 8 chars), and `''` normalizes to `null` so `exists` behaves.
- **Dates are ISO strings.** The pool hands back `Date` objects; the envelope serializes them so that what you match against and what you see in a sample are the same text.
- **Secrets are stripped.** `contact_ssn`, `contact_token`, `portal_session_version`, plus any key ending `_token` / `_secret` / `_password` / `_pin` / `pin_hash` / `api_key`. Envelopes persist for 30–90 days and are readable by any staff token — they must not replicate credentials.
- **`actor` is `null`, not `{user_id: 0}`, when the writer didn't pass one.** "The system did it" (user 0, the automation pseudo-user) and "we don't know who did it" are deliberately distinguishable. Filter defensively.

### Event catalog

The authoritative list is `EVENT_TYPES` in `services/triggerService.js` — it carries each event's field catalog and feeds both the UI picker and create-rule validation. Adding an event = an `emit()` call in a service + a registry entry. Both are code, one deploy.

| Event | Fires from | What bypasses it |
|---|---|---|
| `appt.created` | `apptService.createAppt` — every caller (API, booking, workflows, reschedule successors) | direct `appts` INSERTs |
| `appt.attended` | `apptService.markAttended` | direct status writes |
| `appt.no_show` | `apptService.markNoShow` | — (note: the no_show pipeline advance is hardcoded *inside* markNoShow; don't duplicate it as a rule) |
| `appt.cancelled` | `apptService.cancelAppt` | — |
| `appt.rescheduled` | `apptService.rescheduleAppt`, for the OLD appt | the successor separately fires `appt.created` with `extra.hook_event='rescheduled'` |
| `appt.reschedule_later` | `apptService.rescheduleLater` | — |
| `contact.created` | `contactService.createContact` — intake, orphan-adopt, API | direct `contacts` INSERTs |
| `contact.updated` | `contactService.updateContact`, only when something actually changed | **any direct SQL writer that bypasses updateContact** |
| `case.created` | the intake case-create route and the petition-filing branch (the two case INSERT sites); `source` distinguishes `intake` / `petition` | — |
| `case.updated` | `caseService.updateCase` — detail form, docket adopt, court-review adopt, and the `update_case` internal function | **court executor field writes, the 341 pointer, the dropbox path** — deliberate |
| `case.stage_advanced` | `pipelineService.advanceStage`, every REAL advance | guard-skips and same-stage no-ops don't fire |
| `case.contact_linked` | `caseService.addCaseContact` | the intake/petition routes' direct `case_relate` INSERTs at creation (`case.created` covers those) |
| `case.contact_unlinked` | `caseService.removeCaseContact`, when a row was actually removed | — |
| `form.submitted` | `formService.submitForm`; `extra.surface` = `internal` \| `external` | — |
| `esign.status_changed` | `esignWebhookService.processStatusChange`, on real transitions (webhook or reconciliation — `source` distinguishes) | — |
| `checkitem.completed` | `PATCH /checkitems/:id` on a transition to complete | idempotent re-saves don't fire |
| `checklist.completed` | item status change or item deletion that completes the list | — |
| `case.stage_aged` | **synthetic** — the nightly `emit_stage_aged` job (13:00 UTC / 9am Detroit), not a mutation | already-stale-at-import cases (grace window); terminal stages; `Closed`/`Concluded` cases |

**The bypass column is the important one.** `case.updated` not firing for court-executor writes is a design decision, not a gap: those writes are high-volume and machine-driven, and routing them through the event system would have made every docket sync a potential trigger storm. If you need to react to one of them, react to the thing that caused it instead.

`esign.status_changed` uses the **internal** status vocabulary — `sent`, `viewed`, `signed`, `declined`, `bounced`, `recalled`, `expired`, `reminded`. Filter `data.status equals "signed"` for completion; `data.provider_status` carries the raw provider string.

### Match modes

`conditions` (the builder) or `code`. Three rulings here are load-safety, carried verbatim from the email-ingest rule engine — do not soften them:

- **A broken rule never matches.** Unparseable JSON, a condition evaluator that throws, code that throws or times out — all log a warning and count as NON-match. A rule that is broken does nothing; it does not do something arbitrary.
- **NULL `match_config` on conditions mode is NON-match, not match-all.** The underlying `evaluateConditions(null, …)` returns true, which for an automation rule would silently fire on every event of that type.
- **An explicit empty condition list IS match-all**: `{"operator":"and","conditions":[]}`. That's the supported way to say "every one of these events," and the editor confirms before saving an active one.

Code mode runs in `node:vm` with a bare context (no `process`, `require`, `fetch`, `console`, timers) and a 200 ms timeout. The timeout is real protection against `while(true)` parking the event loop; the bare context is defence-in-depth, **not** a security boundary against a determined author.

### Transform modes

`passthrough` (default — actions receive the envelope unchanged), `mapper`, or `code`.

Mapper config is an array of mapping rules, each:

```json
{ "to": "output.key", "from": "envelope.dot.path", "transforms": ["lowercase"] }
{ "to": "note",       "template": "Stage: {{data.stage_key}}" }
{ "to": "type",       "value": "status" }
```

`from` / `template` / `value` are alternatives — one per rule. `transforms` is optional and applies the shared hook-transform library.

**A failed transform means the rule still counts as MATCHED but its actions do NOT fire.** Actions are never fed garbage. The failure lands in the execution row's warnings and counts as a failure in the row's final status. A mapper where *every* rule errored and nothing mapped is treated as a broken transform, not a partial one — a divergence from the ingest copy, which only warns.

### Action types

`workflow`, `sequence`, `internal_function`, `http`, and `hook`. All five dispatch through the same `lib/actionDispatchers.js` the hook and ingest systems use, except `hook`, which re-enters the YisraHook pipeline with the transformed envelope wrapped as `body` (so hook filter/transform paths work by their normal convention).

**Params-mapping conventions** (the `internal_function` grid, and anywhere else params are mapped):

| You write | You get |
|---|---|
| `case_id` | dot-path lookup into the transformed envelope |
| `data.appt_type` | nested dot-path |
| `'consult_booked'` | single quotes = **literal string** |
| `$` | the whole transformed object |

Required config is validated at **write** time, not dispatch time — a rule that can only fail after a live event fired is a booby trap. `workflow_id`, `template_id`, `slug`, `function_name`, `url` are each checked when you save.

Action failures are isolated: one action failing does not abort the rest of that rule's actions, or any later rule.

### Testing a rule

Three tools, in increasing order of consequence:

- **Recent envelopes / test** (in the editor) — pulls real recorded envelopes for the event and evaluates your CURRENT unsaved editor state against one. Nothing dispatches, nothing is written. Click a field in the sample panel to insert it as a condition.
- **Test / dry run** (Executions tab) — evaluates all *saved active* rules against a recorded envelope. Reports match + transform per rule and what *would* fire. Nothing dispatches.
- **Run live** (Executions tab, red) — **replays the envelope through the full engine. Real actions fire. A new execution row is written.** Use it to re-drive a rule you just fixed against an event that already happened; be aware it will send whatever the actions send. Enter is bound to Cancel in that dialog on purpose.

Replay accepts an `execution_id` only. Raw envelopes were removed: they let any staff token synthesize e.g. a `case.stage_advanced` for an arbitrary case and drive its rules, bypassing the real route's authorization. A recorded envelope can't be forged. Replay resets chain scope (depth 0, empty chain) — it's a fresh manual invocation — and tags `extra.replayed_from` / `replayed_at`.

### Loop guard and dispatch budget

A rule action can cause a mutation, which announces an event, which matches a rule. Two independent limits bound that:

**Depth (`MAX_DEPTH = 4`)** bounds chain *length*. Every action dispatch runs inside an AsyncLocalStorage scope carrying `depth + 1` and the rule id appended to `chain`. An event arriving at depth ≥ 4 is dropped with a `depth_capped` execution row and an alert.

**Dispatch budget (50 per root event)** bounds total *work*. Depth alone doesn't stop fan-out: two rules with three re-emitting actions each can reach ~3⁴ dispatches from a single mutation without ever exceeding depth 4. The counter is shared by reference across the whole tree of one root event; actions past the budget return `skipped` and raise one grouped alert.

**Known limitation:** workflow steps deferred through `scheduled_jobs` (waits) resume on the job executor with a fresh ALS context, so depth resets to 0 for anything they mutate. Acceptable — deferred steps are throttled by the executor cadence and can't form a tight loop — but if you're building something recursive, gate on `source` or `chain` explicitly rather than trusting depth.

### Per-rule cooldown (`min_interval_s`)

Set **Min interval (seconds)** on a rule and it is suppressed when it matched within that window. `0` (default) = no throttle.

A cooldown-suppressed rule is **NOT matched**: no `match_count` bump, no `last_matched_at` refresh, no actions, no error metrics. It records a `skipped_cooldown` warning naming the rule, and the execution row lands as `no_match` if nothing else matched.

The "not matched" ruling matters for more than bookkeeping: if suppression re-armed the window, a rule under sustained event load would push its own cooldown forward on every event and could never fire again.

Suppression is a **skip, not a queue** — the event is gone; the rule does not fire late.

### `case.stage_aged` — the synthetic aging event

Every other event is a *mutation*. Absence — "docs still incomplete 7 days after intake" — is inexpressible by mutations, so a nightly job (**Stage Aged Emitter**, 13:00 UTC / 9am Detroit — deliberately in the human/outbound job band, not the overnight system band, because rules on this event send client-facing nudges; `emit_stage_aged` internal function) turns stage *age* into an event. No new engine concepts: rules on `case.stage_aged` match, transform, and dispatch like any other.

How to author against it:

- **Filter `data.threshold_days` `equals` N — never `>=`.** The ladder (default `3,7,14,30,60`, editable in the job's params) fires each rung **exactly once per stage entry**. A case that leaves a stage and comes back re-arms that stage's rungs (each entry is its own `case_stage_log` row, and the dedup keys on the row id).
- **It is forward-looking only.** A crossing fires only within a **grace window** (default 7 days) of happening. A case backfilled with a historical `entered_at` at 240 days in stage fires *nothing* — by design, or gradual backfill would deliver an indefinite trickle of nudge stampedes. Already-stale-at-import is a one-time triage report's job, not this event's.
- **Coverage = cases with pipeline history.** Today that's a handful; it grows on its own as intake-pipeline advances accrue. Terminal stages (`closed`, `dead_lead`) and `Closed`/`Concluded` cases never fire.
- **Days are whole 24-hour periods** (`TIMESTAMPDIFF(DAY, …)` in SQL), so "3 days" means ≥ 72 hours at the 13:00 run, not "3 calendar days." A daily job also means a crossing is caught up to ~24 hours late — in practice a "3-day" nudge lands 3–4 days after stage entry.
- **The ladder is sparse, not continuous.** With defaults (`3,7,14,30,60` + 7-day window) there is no rung in-window on days 21–29, 37–59, or 67+ — a case sitting in `docs` at day 45 is generating no signal, by design. Widen the ladder in the job's params if a gap matters.
- `source` is `system`, `actor.user_id` is `0`. `extra.stage_log_id` carries the dedup key. `data` carries `stage_key`, `days_in_stage`, `threshold_days`, `template_id`, `case_type`/`subtype`, `status_label`, `entered_at`.

Operational notes: the claim table is `case_stage_aged_emitted` (`INSERT IGNORE` on `(stage_log_id, threshold_days)` — atomic, safe under overlap or manual re-runs). Emissions are awaited inside the job and each is its own **root** event with its own 50-dispatch budget; the job's own bounds — `max_emissions` (default 200) and `max_runtime_ms` (default 8 min, kept inside the job runner's 15-minute stuck-job recovery) — stop the run before claiming, alert when hit, and leave the remainder unclaimed to retry the next night while still in-window. `emit_stage_aged` also takes `dry_run: true` (via apiTester) to list would-emit crossings without claiming or emitting. After a rung passes its grace window unfired (job dead > 7 days), that nudge is permanently skipped — the job-failure alerting is the backstop.

A sibling event keyed on *activity* rather than stage age — `case.idle`, full coverage across all open cases today — is designed but not built; it needs a rolling-watermark dedup rather than a one-shot claim.

### Execution statuses

| Status | Meaning |
|---|---|
| `matched` | ≥1 rule matched, everything that ran succeeded |
| `partial` | ≥1 rule matched; some actions succeeded, some failed |
| `error` | ≥1 rule matched and **nothing** succeeded (all actions failed, or transforms failed) |
| `no_match` | rules exist for this event; none matched |
| `no_rules` | no active rules for this event type — kept only as sample stock, capped at 20 per event type per 7 days |
| `depth_capped` | dropped at the loop guard |

`partial` and `error` exist because a rule whose every action failed must not read as a green `matched` row. A failed transform counts as a failure: the rule was supposed to do something and did nothing.

The execution row is written **before** actions dispatch and finalized after. If the process dies or Cloud Run throttles mid-dispatch, the event was still recorded as seen.

### Per-rule history

Each matched rule of each execution also writes a `trigger_execution_rules` row — the **Recent runs** card in the rule editor reads these. `rule_name` is denormalized so the history survives the rule being deleted, and there is deliberately no FK to `trigger_rules` for the same reason. The FK to `trigger_executions` is `ON DELETE CASCADE`, so retention needs no separate pass.

Cooldown-skipped and non-matching events produce no history row — they were not runs. Look in the Executions tab for those.

### Retention

`sweep_trigger_executions` (internal function, driven by the daily **Trigger Executions Sweep** recurring job at 07:00 UTC):

- `no_match` / `no_rules` rows: kept **30** days (`keep_days`)
- everything else: kept **90** days (`keep_matched_days`)

Batched deletes, 5k per batch, 20 batches max per run, so a backlog drains across runs without a long-held lock. `trigger_execution_rules` rides the FK cascade.

### The seeded rules, as worked examples

**1. `appt.created` → "Consult booked → consult_booked"** — conditions mode: `case_id exists` AND `data.appt_type in [Initial Strategy Session, Strategy Session, Consultation, Intial Strategy Session]` (the misspelling is in the live data on purpose). Passthrough transform. One `advance_stage` action with `stage: 'consult_booked'` and `only_from: 'lead,no_show,not_eligible_yet,not_interested,dead_lead,none'` — the `only_from` guard is what stops the rule dragging a mid-pipeline case backwards.

**2. `appt.attended` → "Consult attended → consult_held"** — same shape, different target stage and `only_from` list.

**3. `appt.attended` → "341 attended → meeting_341"** — same event as rule 2, distinguished by `data.appt_type equals '341 Meeting'` and gated `only_from: 'filed'`. Two rules on one event, ordered by position (10, 20); both are evaluated, so ordering is about action sequence, not exclusivity.

**4. `case.stage_advanced` → "Stage change → case log"** — the match-all example: `{"operator":"and","conditions":[]}`, deliberately every advance. Code transform composes the log text from `extra.from_stage`, `data.stage_key`, `data.status_label`, and `extra.note`, then a `create_log` action writes a `type='status'` row on the case. This is the one to read if you want to see the code-transform → params-mapping handoff end to end.

### Routes (full list in chapter 11)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/triggers/events` | jwt/api_key | Event registry + field catalogs |
| `GET /api/triggers/meta` | jwt/api_key | Registry + operators + action types + live target lists (one payload for the UI) |
| `GET /api/triggers/rules` | jwt/api_key | List rules (`?event_type`), actions nested |
| `GET /api/triggers/rules/:id` | jwt/api_key | One rule |
| `GET /api/triggers/rules/:id/history` | jwt/api_key | Recent runs of this rule (`?limit`, default 20, max 100) |
| `POST /api/triggers/rules` | jwt/api_key | Create (optional `actions` array) |
| `PUT /api/triggers/rules/:id` | jwt/api_key | Partial update; `actions` if present REPLACES the set |
| `DELETE /api/triggers/rules/:id` | jwt/api_key | Delete rule + actions (history survives) |
| `GET /api/triggers/executions` | jwt/api_key | Log (`?event_type&status&case_id&contact_id&limit&before_id`) |
| `GET /api/triggers/executions/:id` | jwt/api_key | Full row — envelope + outcomes |
| `GET /api/triggers/samples/:event_type` | jwt/api_key | Recent envelopes for the field-discovery panel |
| `POST /api/triggers/test` | jwt/api_key | Dry run vs saved rules — nothing dispatches |
| `POST /api/triggers/test-draft` | jwt/api_key | Evaluate an UNSAVED config vs one envelope — nothing dispatches |
| `POST /api/triggers/replay` | jwt/api_key | **LIVE** re-processing of a recorded envelope (`execution_id` only) |