# 13 — Cookbook

## For operators

This chapter is the patterns-and-pitfalls catalog for YisraFlow. Chapters 1–12 explain *what* each engine is and *how* it works; this one is *what to reach for when* and *what trips people up*.

You probably won't read it cover to cover. Use it the way you'd use a recipe book: scan the table of contents, find the pattern that matches what you're trying to do, copy the shape.

If something here disagrees with the rest of the manual, the code wins (see the footer). The cookbook moves a little ahead of the formal chapters and occasionally lags them.

> **Pruning note.** Sections 1 and 2 of this chapter substantially overlap with chapters 1, 5, 6, 7, and 8. The cookbook was written first and grew its own framing. A future cleanup pass should trim §1 / §2 to short cross-references and let chapters 3–6 carry the unique value (patterns / step-by-step / pitfalls / templates). Until then, the duplication stands and is reasonably consistent.

---

## Technical reference

Practical, pattern-first reference for building automations in YisraCase. Every example is copy-pasteable and matches what's actually in the codebase — no aspirational APIs.

> **Scope:** Workflow Engine, Sequence Engine, Scheduled Jobs, YisraHook. Email Router patterns are covered briefly at the end of §3; chapter 10 has the full picture.
> **Audience:** you, six months from now, trying to remember why `schedule_resume` needs to be in `isControlStep`.

---

## Table of Contents

1. [Architecture & Engine Selection](#1-architecture--engine-selection)
2. [Building Blocks](#2-building-blocks)
3. [Core Patterns](#3-core-patterns)
4. [Step-by-Step Guide: Building a New Automation](#4-step-by-step-guide-building-a-new-automation)
5. [Pitfalls Catalog](#5-pitfalls-catalog)
6. [Template Examples](#6-template-examples)

---

## 1. Architecture & Engine Selection

YisraFlow has five subsystems (see chapter 1). Four share the `scheduled_jobs` queue and `/process-jobs` polling heartbeat directly; the fifth (Email Router) sits in front of YisraHook as a routing layer. The decision tree below walks the four core engines — see §3.16 for when to add an Email Router rule on top.

```
                      ┌─────────────────────────┐
                      │   /process-jobs (cron)  │  ~5 min cadence (→ 1 min)
                      └──────────┬──────────────┘
                                 │ claims up to 10 pending jobs
                                 │ (FOR UPDATE SKIP LOCKED)
            ┌────────────────────┼────────────────────┐
            │                    │                    │
            ▼                    ▼                    ▼
  ┌───────────────────┐ ┌──────────────────┐ ┌────────────────────┐
  │ workflow_resume   │ │ sequence_step    │ │ hook_retry         │
  │ → advanceWorkflow │ │ → executeStep    │ │ → executeRetry     │
  └───────────────────┘ └──────────────────┘ └────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
  ┌───────────────────┐ ┌──────────────────┐ ┌────────────────────┐
  │ campaign_send     │ │ task_due_reminder│ │ task_daily_digest  │
  │ → executeSend     │ │ (inline block)   │ │ (inline block)     │
  └───────────────────┘ └──────────────────┘ └────────────────────┘
            │
            ▼
  ┌─────────────────────────────────────────┐
  │ one_time / recurring → executeJob()     │
  │   - webhook                              │
  │   - internal_function                    │
  │   - custom_code (vm sandbox, 5s timeout) │
  └─────────────────────────────────────────┘
```

### Decision Tree — which engine do I need?

Ask these in order. The first "yes" wins.

**Q1. Is this a recurring schedule (cron) or a single fire-and-forget action at a fixed future time?**
→ **Scheduled Job** (`one_time` or `recurring`, job_type `webhook` | `internal_function` | `custom_code`).

**Q2. Is it tied to a specific contact AND does it need to auto-cancel when an external event changes state?**
→ **Sequence**. The enroll/cancel-from-outside pattern plus per-step condition gates is exactly what sequences are built for. No-show follow-up, intake drip, cancellation follow-up — all sequences.

**Q3. Does it have branching logic (if/else), variable passing between steps, or more than ~3 delays?**
→ **Workflow**. You get `evaluate_condition`, `set_next`, `schedule_resume`, audit trail per step, and the `resume → re-fetch → re-check → send` pattern.

**Q4. Is it a webhook delivery from outside (Calendly, email adapter, form intake, Stripe)?**
→ **YisraHook**. Configure the hook (filter + transform + targets) via the UI; receiver handles everything. Targets can be HTTP (out to another service) OR internal (directly start a workflow, enroll in a sequence, or call an internal function — no HTTP round-trip needed).

**Q5. None of the above — just a single action at a fixed time?**
→ **Scheduled Job** (`one_time`).

### Edge cases

| Situation | Answer |
|---|---|
| "I want this to run every day at 9 AM, but some days it should skip" | Recurring scheduled job → hits an `internal_function` with its own gate logic (cf. `task_daily_digest` + Shabbos gate). Don't try to make cron itself skip. |
| "Multi-step with delays, but no branching and not contact-tied" | Workflow. Sequences require a `contact_id`. |
| "Contact-tied, but I want it to run to completion regardless of state changes" | Sequence with no template-level condition and no step conditions — but if you genuinely don't need auto-cancel, a workflow that takes `contactId` in `init_data` is simpler. |
| "Two automations that need to trigger each other" | One fires → `enroll_sequence` / `start workflow via webhook job` / `POST /hooks/:slug`. Use internal functions or the receiver endpoint; don't wire in-process callbacks. |
| "User-configurable trigger from an external service" | YisraHook. Configuration in DB > custom routes. |

---

## 2. Building Blocks

### 2.1 Internal Functions (23 total)

Available in `lib/internal_functions.js`, callable by all three engines. Signature: `async (params, db) => { success, output? }`. See chapter 5 for the full reference.

| Category | Function | Used in |
|---|---|---|
| Control flow (workflow only) | `set_next`, `evaluate_condition` | workflow |
| Timing (workflow only) | `wait_for`, `schedule_resume`, `wait_until_time` | workflow |
| Variable manipulation | `noop`, `set_var`, `format_string` | workflow |
| Communication | `send_sms`, `send_email` | all |
| Tasks | `create_task`, `run_task_digest` | all |
| Sequences | `enroll_sequence`, `cancel_sequences` | all |
| Log | `create_log` | all |
| Contact | `lookup_contact`, `update_contact` | all |
| Appointment | `create_appointment`, `lookup_appointment`, `update_appointment`, `get_appointments` | all |
| General | `query_db` | all |

**Key signatures:**

```js
// positional args — no object
smsService.sendSms(db, from, to, message)

// object arg
emailService.sendEmail(db, { from, to, subject, text?, html?, attachments?, attachment_urls? })

// fire-and-forget bridge
pabblyService.send(db, service, data)
```

### 2.2 Step Types

```json
// Workflow / sequence step
{
  "type": "internal_function",
  "config": { "function_name": "...", "params": {...}, "set_vars": {...} },
  "error_policy": { "strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30 }
}

// Scheduled job (one_time / recurring) execution flavors
{ "type": "webhook", "url": "...", "method": "POST", "headers": {...}, "body": {...} }
{ "type": "internal_function", "function_name": "...", "params": {...} }
{ "type": "custom_code", "code": "...", "input": {...} }  // vm sandbox, 5s timeout
```

`custom_code` is the nuclear option — no logging, no retry safety, no access to `db`. Use it only for one-off data shaping where you really can't extend `internal_functions.js`.

**Sequence step action types:** `sms`, `email`, `task`, `internal_function`,
`webhook`, `start_workflow`. The last two are first-class alternatives to
wrapping an HTTP call or workflow start inside an `internal_function` —
see §3.15 for the pattern.

### 2.3 Variables & Placeholder Syntax

**Workflow variables** — flat key/value store on the execution, merged across steps.

```
{{variableName}}          — workflow variable from init_data or set_vars
{{this.output.field}}     — output from the just-executed step
{{this.[0]}}              — array index access
{{env.now}}               — current datetime at step runtime
{{env.executionId}}
{{env.stepNumber}}
```

**Universal resolver** (in sequences, send_email/sms params, campaign bodies, hook templates):

```
{{contacts.contact_fname}}
{{appts.appt_date|date:dddd MMMM Do, YYYY}}
{{contacts.contact_phone|phone}}
{{contacts.contact_name|upper}}
{{contacts.contact_email|default:{{contacts.contact_email2}}|default:no email}}
```

**Pseudo-table `trigger_data`** — resolves from an in-memory object passed via `refs.trigger_data`, no SQL. Dot-paths supported (`{{trigger_data.user.email}}`). All modifiers work. Missing keys soft-fail to unresolved.

```
{{trigger_data.amount}}
{{trigger_data.missed_date|date:dddd MMMM Do}}
{{trigger_data.preferred_name|default:{{contacts.contact_fname}}}}
```

**Refs auto-built in sequences** from `enrollment.contact_id` + `trigger_data.{appt_id, case_id, task_id}`, plus `trigger_data` itself is passed through as the pseudo-table so any key on the enrollment's `trigger_data` object is reachable via `{{trigger_data.X}}`.

**Not auto-wired into** campaign bodies (`campaignService.executeSend` only passes `refs.contacts`) or hook body templates — those call sites would need updating separately if you want trigger_data placeholders there.

**In workflows** you resolve via direct `{{variable}}` references against the workflow's variables map. To pull DB values, use `lookup_contact` / `lookup_appointment` / `query_db` and `set_vars` the fields you need.

### 2.4 Conditions

**Sequence template condition** (cancel enrollment if fails):
```json
{
  "query":       "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
  "params":      { "appt_id": "trigger_data.appt_id" },
  "assert":      { "appt_status": { "in": ["No Show", "Canceled"] } },
  "assert_mode": "all"
}
```

**Assert operators** (per field):
- scalar → strict equality
- `{ "in": ["a","b"] }` → value-in-array
- `{ "is_null": true }` / `{ "is_null": false }`

**`assert_mode`:** `"all"` (AND, default) or `"any"` (OR).

**Sequence step condition** — same shape. Failing → skip step, schedule next.

**Sequence fire guard** — no DB, purely trigger-data driven:
```json
{ "min_hours_before_appt": 24 }
```
Requires `trigger_data.appt_time`.

**Workflow branching** via `evaluate_condition`:
```json
{
  "function_name": "evaluate_condition",
  "params": {
    "conditions": [
      { "variable": "appt_status", "operator": "==", "value": "Scheduled" },
      { "variable": "case_tab",    "operator": "!=", "value": "" }
    ],
    "match": "all",
    "then": 5,
    "else": 8
  }
}
```

Operators: `==` `!=` `>` `<` `>=` `<=` `contains` `not_contains` `is_empty` `is_not_empty`.

### 2.5 Timing

**Sequences** (per step):
```json
{ "type": "immediate" }

// Relative delay (existing)
{ "type": "delay", "value": 5, "unit": "minutes" }   // "seconds" | "minutes" | "hours" | "days"
{ "type": "delay", "value": 1, "unit": "hours", "randomizeMinutes": 5 }

// Absolute delay — fires at a specific datetime
{ "type": "delay", "at": "2026-05-01T14:30:00Z" }                    // explicit UTC
{ "type": "delay", "at": "2026-05-01T14:30:00-04:00" }               // explicit offset
{ "type": "delay", "at": "2026-05-01T14:30:00" }                     // FIRM_TZ
{ "type": "delay", "at": "2026-05-01 14:30:00" }                     // FIRM_TZ (SQL form)
{ "type": "delay", "at": "2026-05-01" }                              // FIRM_TZ midnight
{ "type": "delay", "at": "{{trigger_data.target_iso}}", "randomizeMinutes": 30 }

{ "type": "next_business_day", "timeOfDay": "13:00", "randomizeMinutes": 30 }
{ "type": "business_days", "value": 2, "timeOfDay": "10:00" }
{ "type": "before_appt_fixed", "hoursBack": 2 }
{ "type": "before_appt", "hoursBack": 24, "timeOfDay": "10:00", "minHoursBefore": 4 }
```

**`delay` field-presence rules.** Exactly one of `at` (absolute) or `value`+`unit` (relative). Mixing both → save-time 400. `randomizeMinutes` (symmetric ±N integer minutes, max 1440) is optional and works for either mode. Past `at` times are returned as-is — the next `/process-jobs` tick fires them. `at` is the only timing field that supports `{{trigger_data.X}}` placeholders today; they are resolved at fire time, not save time. `at` resolving to an empty string at fire time **throws** (let the step's `error_policy` decide the outcome).

**Workflows** — use control-flow steps:
```json
// Relative wait_for (existing)
{ "function_name": "wait_for", "params": { "duration": "2h", "nextStep": 5 } }

// Absolute wait_for
{ "function_name": "wait_for",
  "params": { "at": "2026-05-01T14:30:00", "nextStep": 5,
              "randomizeMinutes": 10, "skipToStep": 7 } }

// schedule_resume — accepts ISO (any of the same shapes as `at`), duration string, ms number, or null
{ "function_name": "schedule_resume",
  "params": { "resumeAt": "{{resume_24h}}", "nextStep": 4,
              "skipToStep": 6, "randomizeMinutes": 15 } }

{ "function_name": "wait_until_time",
  "params": { "time": "09:00", "timezone": "America/Detroit", "nextStep": 6 } }
```

**`wait_for` field-presence rules.** Exactly one of `duration` or `at`. `randomizeMinutes` and `skipToStep` are optional. `at` resolving to null/empty at runtime → jump to `skipToStep` (or `nextStep` if not set), parity with `schedule_resume`.

**`schedule_resume` parsing dispatch.** Strings starting with `YYYY-MM-DD` go through the timezone-aware datetime parser (FIRM_TZ default for naive forms). Other strings go through `ms()` for relative-duration parsing (`"2h"`, `"10m"`, etc.).

**Naive (no offset) datetime strings default to `FIRM_TIMEZONE`** (America/Detroit by default). Cloud Run's process timezone is UTC, so `new Date("2026-05-01T14:30:00")` would otherwise interpret as UTC — cookbook §5.1. We route through `services/timezoneService.parseUserDateTime` to avoid that trap.

Duration formats accepted by `wait_for.duration` and `schedule_resume.resumeAt` (relative path): `"30s"`, `"5m"`, `"2h"`, `"1d"`, or a millisecond number.

**Scheduled jobs** — cron for recurring; `scheduled_time` (ISO UTC) or `delay` for one_time:
```json
{ "type": "recurring", "recurrence_rule": "0 13 * * *" }
{ "type": "one_time",  "delay": "10m" }
{ "type": "one_time",  "scheduled_time": "2026-06-01T14:00:00Z" }
```

### 2.6 Error Policies

Four strategies — default `ignore`:

| Strategy | On failure |
|---|---|
| `ignore` | Log, continue to next step |
| `abort` | Workflow → `failed`; sequence → enrollment cancelled; job → `failed` |
| `retry_then_ignore` | Retry N times, then continue |
| `retry_then_abort` | Retry N times, then abort |

Backoff: `delay_before_attempt_N = backoff_seconds × 2^(N-1)`.

Retries run within a single invocation. `max_retries: 3` + `backoff_seconds: 60` ties up the call for 3+ minutes. Keep it reasonable.

### 2.7 Test Input

Workflows and sequence templates each carry an optional `test_input` JSON column that serves two purposes:

1. **Authorial documentation** — the template author writes down what shape of payload this automation expects. Newcomers opening the editor can see the expected keys without reading the step configs.
2. **Test tab pre-population** — the Workflow editor's Test Step tab seeds its variable rows from `test_input` on first open per step, so testing doesn't require re-typing the sample every time.

**Which columns:**

| Column | Documents | Validated at runtime? |
|---|---|---|
| `workflows.test_input` | `init_data` shape | No |
| `sequence_templates.test_input` | `trigger_data` shape | No |

Both are nullable, default NULL. **There is no runtime validation** — if a live caller supplies a payload that doesn't match `test_input`, nothing blocks it. The column is advisory, not a contract.

**Shape rule at save time:** must be `null`, absent, or a plain JSON object. Arrays and primitives are rejected with 400. Beyond shape, no field-level schema is enforced.

**Best practice:** use keys that match what your actual starter (hook target, direct API call, sequence enrollment) passes. That way the Test tab seeds meaningful values.

**Workflow example:**

```json
{
  "contact_id": 123,
  "source": "calendly",
  "appt_time": "2026-05-01T10:00:00Z"
}
```

A workflow started from a hook target with these three fields in its transform output gets a Test tab pre-filled with those three variable rows. The author can run the step test immediately.

**Sequence example:**

```json
{
  "appt_id": 42,
  "contact_id": 123,
  "appt_time": "2026-05-01T10:00:00Z",
  "enrolled_by": "system"
}
```

The sequence editor doesn't currently have a Test tab, so the value is documentation-only there — still worth filling in so the next author knows what `trigger_data` this template expects at enrollment.

**Not covered by this field:**

- Hooks — dry-run already has a paste-sample-JSON flow; capture mode persists a real payload.
- Scheduled jobs — `action_config` IS the contract; no additional field needed.

**Template duplication** copies `test_input` verbatim to the duplicate (both engines).

---

## 3. Core Patterns

### 3.1 Resume-Refetch-Recheck-Send

**The foundational workflow pattern** for any scheduled communication tied to an entity whose state can change. Used by the appointment reminder workflow at every touchpoint.

The principle: between the time a step is scheduled and the time it fires, the world may have changed. *Don't trust frozen data.*

```
Step N:   schedule_resume { resumeAt: "{{resume_24h}}", nextStep: N+1 }
Step N+1: lookup_appointment { appointment_id: "{{appt_id}}" }
          set_vars: { appt_status: "{{this.output.appt_status}}" }
Step N+2: evaluate_condition { variable: "appt_status", operator: "==", value: "Scheduled",
                                then: N+3, else: N+5 }    ← skip the send if no longer scheduled
Step N+3: send_sms { ... }
Step N+4: set_next { value: N+6 }                          ← jump past the skip
Step N+5: noop { set_vars: { skipped_at_24h: "{{env.now}}" } }
Step N+6: (next touchpoint)
```

**Why pre-compute resume timestamps at workflow start** (in `init_data`) rather than computing them during `schedule_resume`:
- Source of truth is the appt creation moment, not the step runtime
- Past timestamps → `null` → `schedule_resume` silently skips (via `skipToStep` param)
- Business-day-aware lookups (`prevBusinessDay`) can fail, and you don't want that to break a step mid-flight

See `services/apptService.js` `createAppt()` section 7 for the canonical example.

### 3.2 Enroll / Cancel Pair

**The foundational sequence pattern.** Every sequence should have at least one enroll point and at least one cancel point (usually many).

```
State change A  →  enrollContact(db, contactId, 'type', triggerData)
State change B  →  cancelSequences(db, contactId, 'type', 'reason_string')
State change C  →  cancelSequences(db, contactId, 'type', 'other_reason')
```

**Enroll checklist:**
- [ ] Guard against double-enrollment: query `sequence_enrollments` for `active` rows of this type before enrolling (see `markNoShow()` in `apptService.js`)
- [ ] Put everything the sequence needs into `trigger_data` — enrollment is immutable once created
- [ ] Pass `appt_type` / `appt_with` in `filters` if you need cascading template match

**Cancel checklist:**
- [ ] Every state change that renders the sequence pointless should cancel it
- [ ] Cancellation marks enrollments `cancelled` (not deleted) and pending jobs `failed` (not deleted) — audit trail preserved
- [ ] For appointment-driven sequences: `createAppt`, `markAttended`, `cancelAppt` all cancel `no_show`

**Template-level condition** is a third line of defense: if cancel point was missed, the sequence cancels itself on the next step.

### 3.3 One-Job-Per-Entity (Campaign Pattern)

**Use when:** a batch operation needs to process N items, but Cloud Run will time out on a single long-running request.

Instead of:
```
POST /send-all  →  loop over 500 contacts sending SMS  →  TIMEOUT
```

Do:
```
POST /send-all  →  INSERT 500 scheduled_jobs (one per contact)  →  return immediately
/process-jobs (10 at a time, polled)  →  executeSend(campaignId, contactId)
                                      →  checkCompletion rolls up when last one finishes
```

Each job is retryable independently. Each job carries just enough context (IDs) to reconstitute state at execution time.

**Required scaffolding:**
- `idempotency_key` per job: `"campaign:{campaignId}:{contactId}"`
- `name` per job: `"campaign:{id}:send:{contactId}"` (makes cancellation query simple)
- A completion check that fires when the last job finishes (`checkCompletion` in `campaignService`)
- A per-execution result row with a `UNIQUE(campaign_id, contact_id)` constraint (enables idempotent retry via `ON DUPLICATE KEY UPDATE`)

**Attempt-aware retry** (see `campaignService.executeSend`):
```js
// job.attempts is PRIOR attempts (0 on first run, 1 after first retry)
const attempt     = (job.attempts || 0) + 1;
const maxAttempts = job.max_attempts || 1;

// Transient infra/send error + not final attempt → throw, let job system retry
// Transient + final attempt → record failed, return normally
// Permanent error → record failed, return normally
// Skip (opted out, canceled, missing channel) → record skipped, return normally
```

### 3.4 Recurring Cron

**Use when:** an action must run on a clock, regardless of entity state.

```js
await apiSend('/scheduled-jobs', 'POST', {
  type:            'recurring',
  job_type:        'webhook',                     // or 'internal_function'
  name:            'Daily Appointment Report',
  scheduled_time:  '2026-03-18T04:00:00Z',        // first run
  recurrence_rule: '0 4 * * 0,1,2,3,4,5',         // every day except Saturday
  max_executions:  null,                           // optional cap
  expires_at:      null,                           // optional end date
  url:             'https://app.4lsg.com/workflows/5/start',
  method:          'POST',
  headers:         { 'x-api-key': 'YOUR_INTERNAL_API_KEY' }
});
```

**If the action must skip on Shabbos/Yom Tov:** run it daily from cron, but gate it inside the job target. Don't try to express the gate in the cron expression — Jewish holidays are not cron-friendly.

```js
// Inside the internal_function or workflow:
const { workday } = await calendarService.isWorkday(new Date().toISOString());
if (!workday) return { skipped: 'non-workday' };
```

### 3.5 Cascade-Skip (Sequence Cascading Template Match)

**Use when:** you want different content per `appt_type` or `appt_with`, but also want a generic fallback.

Create multiple templates with the same `type` but different filters:

| Template | type | appt_type_filter | appt_with_filter | Specificity |
|---|---|---|---|---|
| "No-show — 341, Fred" | no_show | 341 Meeting | 2 | 1 (most specific) |
| "No-show — 341" | no_show | 341 Meeting | NULL | 2 |
| "No-show — Fred" | no_show | NULL | 2 | 3 |
| "No-show — default" | no_show | NULL | NULL | 4 (fallback) |

Enrollment picks the first match from this ordered list. Pass `appt_type` + `appt_with` in the `filters` arg:

```js
await sequenceEngine.enrollContact(db, contactId, 'no_show', triggerData, {
  appt_type: appt.appt_type,
  appt_with: appt.appt_with
});
```

### 3.6 Branching via `evaluate_condition` + `set_next`

**Canonical workflow branching:**

```
Step 3: evaluate_condition { variable: "appt_type", operator: "==", value: "341 Meeting",
                              then: 10, else: 4 }
Step 4: (non-341 path starts here)
...
Step 9: set_next { value: 20 }     ← skip the 341 block
Step 10: (341 path starts here)
...
Step 19: (last step of 341 path — falls through to 20)
Step 20: (common cleanup)
```

**Rules:**
- `evaluate_condition` and `set_next` are the only functions whose `next_step` is honored by `isControlStep`
- `schedule_resume` is also `isControlStep` (was a bug: omitting caused skipped blocks to fire immediately)
- `null` from `evaluate_condition`'s `else` branch → `markExecutionCompleted`

### 3.7 Hook Intake → Action

**Use when:** an external service needs to trigger internal automation.

YisraHook has four target types. Pick based on what the external event should trigger:

| target_type | Triggers | When to use |
|---|---|---|
| `http` | A URL (internal or external) | Out-to-third-party notifications, or routing to an internal route you control |
| `workflow` | Workflow execution | Multi-step logic with branching / variable passing — e.g. new-lead intake orchestration |
| `sequence` | Sequence enrollment | Contact-tied drip with auto-cancel — e.g. external "appt booked" → welcome sequence |
| `internal_function` | One function from `internal_functions.js` | Single atomic action — log, SMS, task, DB update |

**The pipeline, same for all four types:**

```
External → POST /hooks/:slug
          ↓
        Auth (none / api_key / HMAC)
          ↓
        200 returned immediately (async from here)
          ↓
        Hook-level FILTER (conditions / code) — drop events we don't care about
          ↓
        Hook-level TRANSFORM (mapper / code) — normalize to internal shape
          ↓
        For each active target (ordered by position):
          ↓
          Target-level CONDITIONS — skip this target if not applicable
          ↓
          Target-level TRANSFORM — further reshape for this target
          ↓
          Dispatch by target_type:
            • http              → fetch() with injected credential
            • workflow          → INSERT workflow_executions + fire-and-forget advance
            • sequence          → sequenceEngine.enrollContact()
            • internal_function → internalFunctions[name](params, db)
          ↓
          Log to hook_delivery_logs (synthetic URL for internal types)
          ↓
          On failure: queue hook_retry job
```

All four types share the same filter/transform/condition/retry pipeline. The difference is purely *how the transformed output gets delivered*.

#### When HTTP vs internal target?

Use **HTTP target** when:
- The action belongs to an existing internal route (you've already written `/internal/something` — keep using it)
- Multiple hooks call the same endpoint (DRY — logic lives in the route, not duplicated across hook configs)
- The target is a third-party service (Slack, external CRM)

Use **internal target** when:
- The action is "start a workflow / enroll / call function X" and nothing more
- You'd otherwise create a single-purpose internal route that just re-parses JSON and calls one function
- You want the Cloud Run request to skip the re-entrant HTTP round-trip (faster, no loopback networking)

Both approaches are fine. Internal targets are a shortcut, not a replacement for routes with real business logic.

#### Composition example — "Calendly invitee.created" routed three ways

One hook, three targets, each firing in parallel:

```
Calendly → POST /hooks/calendly-booking
              ↓
            filter: body.event == "invitee.created"
            transform → { contact_email, contact_name, appt_start_utc, appt_type }
              ↓
              ├─ TARGET 1 (internal_function): create_log
              │     params: { contact_id: "contact_lookup_id",
              │                log_type: "'WEBHOOK'",
              │                subject: "'Calendly booking received'" }
              │
              ├─ TARGET 2 (workflow): start workflow #12 "new lead intake"
              │     init_data: full transform output
              │     → workflow handles: find-or-create contact, create appt,
              │       send welcome SMS, create intake task, notify attorney
              │
              └─ TARGET 3 (http): POST to Slack webhook
                    body_template: { "text": "New booking: {{contact_name}}" }
```

This is the pattern to reach for when external data needs to fan out to multiple internal reactions. Each target has its own conditions — e.g. Target 3 could be conditional on `appt_type == "Strategy Session"` only.

#### `params_mapping` for `internal_function` targets

Internal-function targets need per-param mapping from the transform output to the function's argument shape:

```json
{
  "function_name": "create_log",
  "params_mapping": {
    "contact_id":  "contact_id",            // → transformOutput.contact_id
    "contact_id2": "contact.id",            // → transformOutput.contact.id  (dot-path)
    "log_type":    "'SMS'",                 // → literal string "SMS"
    "urgent":      true,                    // → literal boolean (passthrough)
    "timeout_ms":  5000                     // → literal number (passthrough)
  }
}
```

| Source syntax | Meaning |
|---|---|
| `"field"` | Flat lookup on transform output |
| `"a.b.c"` | Dot-path lookup (same resolver as hookMapper `from` rules) |
| `"'literal'"` | Literal string — quotes stripped |
| Non-string (`42`, `true`, `null`, `{...}`) | Passthrough as-is |

Array-index syntax (`items[0]`) is not supported — if you need array access, flatten via a transform rule first.

**Retry idempotency:** `http` depends on the endpoint, `workflow` INSERT is retry-safe, `sequence` guards against duplicate active enrollments, but `internal_function` is NOT inherently idempotent. If a transient failure happens after `create_log` succeeded but before the delivery log wrote, the retry will create a second log row. Design internal-function hooks to be retry-safe — or accept the small duplicate risk for non-critical actions.

### 3.8 Full-System Picture — How the Four Subsystems Compose

YisraHook is the **entry point for external data**. The three engines (workflow / sequence / scheduled job) are the **execution substrate**. Internal functions are the **action vocabulary** shared by all of them.

```
          ┌────────────────────────────────────────────────────┐
          │                 EXTERNAL WORLD                      │
          │  Calendly • email adapter • JotForm • Stripe •      │
          │  Dropbox • GCal • inbound SMS gateway • etc.        │
          └─────────────────────────┬──────────────────────────┘
                                    │  POST /hooks/:slug
                                    ▼
          ┌────────────────────────────────────────────────────┐
          │                    YisraHook                         │
          │  slug → auth → filter → transform → targets[]       │
          └─────────┬─────────┬─────────┬─────────┬────────────┘
                    │         │         │         │
         target_type= http  workflow  sequence  internal_function
                    │         │         │         │
                    ▼         ▼         ▼         ▼
          ┌─────────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐
          │  external   │ │Workflow │ │Sequence │ │internal_functions│
          │  services   │ │ Engine  │ │ Engine  │ │     (23 total)   │
          │ or internal │ │         │ │         │ │                  │
          │   routes    │ │         │ │         │ │                  │
          └─────────────┘ └────┬────┘ └────┬────┘ └────────┬─────────┘
                               │           │                │
                               ▼           ▼                ▼
                        scheduled_jobs  scheduled_jobs   (direct call,
                         (workflow_      (sequence_       synchronous)
                          resume)          step)
                               │           │
                               └─────┬─────┘
                                     ▼
                               /process-jobs
                                     ▼
                              (back into engines)
                                     ▼
                          internal_functions registry
                                     ▼
                     send_sms • send_email • create_task •
                     create_log • enroll_sequence •
                     create_appointment • query_db • etc.
```

**Key insight:** everything converges on the internal_functions registry. An external webhook hitting an `internal_function` target is structurally identical to a workflow step that calls `internal_function`, which is structurally identical to a scheduled job of type `internal_function`. The only difference is *what triggered the call*.

**Common composition patterns:**

| External trigger | Hook target type | What happens next |
|---|---|---|
| Calendly booking | `workflow` | Workflow: find-or-create contact → create appt → which starts the **appt reminder workflow** → which fires scheduled `workflow_resume` jobs → which eventually call `send_sms` |
| Client uploads bank statement via Dropbox | `internal_function` → `cancel_sequences` | Kills the `missing_statements` sequence in one shot |
| JotForm intake submission | `sequence` → enrollment in `new_intake_drip` | Sequence runs N steps over N business days, each gated by "has the client responded?" |
| Stripe payment received | `http` → internal `/internal/payments/record` route | The route does FK updates, ledger entries, invoice PDF generation — too much logic for a single internal function |
| External CRM syncs a contact | `internal_function` → `update_contact` | Direct DB update, no orchestration needed |

**When a hook triggers a workflow or sequence, the engines take over:**

- The workflow's `scheduled_jobs` are queued from within `advanceWorkflow` — hook delivery is already complete by then
- Sequence first-step jobs are queued from within `enrollContact` — same
- Subsequent steps (scheduled resumes, next sequence steps) fire via `/process-jobs` on the normal polling cadence
- Internal functions called by those later steps run with the same DB connection pattern and same error policies — no special casing for "hook-triggered" vs "user-triggered" execution paths

This is why adding a new external integration is usually just a hook-config change, not code. The engines already know how to do the work.

### 3.9 Cross-Engine List Endpoint Envelope Parity

Cross-engine list endpoints — executions, enrollments, hook deliveries — share the same envelope shape, so frontend components can render a contact's automation timeline without per-engine switch logic.

**Envelope:**
```json
{ "success": true, "<collection>": [...rows], "total": N }
```

Dual-count UIs (active vs all) extend with `active_total`:
```json
{ "success": true, "executions": [...], "total": 47, "active_total": 3 }
```

**Endpoints using this shape:**
- `GET /workflows/:id/executions`
- `GET /sequences/templates/:id/enrollments`
- `GET /api/hooks/:id/executions`
- `GET /api/contacts/:id/workflows`
- `GET /api/contacts/:id/sequences`

**Row shapes diverge intentionally.** Each engine carries engine-specific fields (`workflow_name` on executions, `template_name` + `step_count` on enrollments, `target_count` on deliveries). Don't force-common the row shape — it bloats with NULLs on one side or loses information on the other. Envelope is common; row is native.

### 3.10 Tab-Visibility Pattern (contact2)

Each tab on `contact2.html` is self-contained: the tab's module owns its load function, polling callbacks, and stop function. The global `openTab()` only toggles `display`; it doesn't know what each tab does.

```
openTab(tabId)
  → stop any previously-active tab's polling (via its registered stop fn)
  → show new tab
  → call new tab's load fn (if registered)

Each tab module exposes:
  loadXTab()   — starts its polling / fetches
  stopXTab()   — clears timers / aborts in-flight
```

**Belt-and-suspenders.** Poll callbacks re-check `tabEl.style.display !== 'none'` before running a tick. The in-tick self-check protects against a stop call racing with an in-flight tick — the tick returns instead of rendering stale data over a different tab.

An earlier design considered a `MutationObserver` on tab visibility; the simpler pattern (explicit start/stop hooks + in-tick check) won.

### 3.11 Polling Pattern for Live UI

For UI surfaces showing automation state in near-real-time (execution lists, enrollment progress, delivery logs), the pattern is:

- **Interval:** 5s
- **Self-contained per feature** — no central polling registry
- **Three stop triggers:**
  1. Visible list reaches all-terminal status (every row `completed` / `failed` / `cancelled`)
  2. User leaves the surface (tab switch, page navigation)
  3. The resource being polled changes (user picks a different hook / template / contact)

**Race guard for rapid navigation.** The polling loop AND any outstanding tick callbacks must check `targetResourceId === currentResourceId` before acting on a response:

```js
const myResourceId = currentContactId;
const res = await P.apiSend(`/api/contacts/${myResourceId}/workflows`, 'GET');
if (myResourceId !== currentContactId) return;   // user moved on — drop it
renderRows(res.workflows);
```

Without this, a slow response for Contact 1 can clobber the UI already showing Contact 2.

**Race-free intent flips** (e.g. user flips a mode during a polling window) use a guarded atomic `UPDATE` — see §3.14.

### 3.12 Contact-Tying a Workflow

Workflow executions optionally tie to a contact via `workflow_executions.contact_id`. Tied executions show up on the contact's Automations tab; untied stay hidden. NULL is the legitimate default for workflows operating on a case, a campaign, or nothing in particular.

**Precedence, highest first:**

1. **Explicit override (wrapped body only).** `POST /workflows/:id/start` with
   ```json
   { "init_data": {...}, "contact_id": 123 }
   ```
   wins over the template default. **Wrapped-only** — flat bodies are left alone so that `contact_id` inside init_data isn't silently stripped for legacy callers.

2. **Template-level default.** `workflows.default_contact_id_from` names the init_data key to copy:
   ```sql
   UPDATE workflows SET default_contact_id_from = 'contact_id' WHERE id = 5;
   ```
   Reads `init_data['contact_id']`; positive integer → stamped, other values → NULL silently.

3. **NULL** if neither applies.

**Shared helper.** All four INSERT sites (§5.21) go through `resolveExecutionContactId()` in `lib/workflow_engine.js`:

```js
const { resolveExecutionContactId, InvalidContactIdError } = require('../lib/workflow_engine');
const contactId = resolveExecutionContactId({ explicitContactId, initData, defaultKey });
```

`InvalidContactIdError` throws only for **explicit** overrides (explicit contract → loud failure → HTTP 400). Template-default misses fall through to NULL silently — a bad init_data shouldn't blow up a hook delivery or appt-reminder workflow start.

### 3.13 ID-Only Sequence Templates

`sequence_templates.type` is nullable. **NULL type = "not cascade-matchable, reachable only by `template_id`."** Use for one-off sequences where cascading template selection doesn't fit (e.g. a drip keyed directly to a specific hook or route).

**UI convention:**
- List / title display: em-dash (`—`) for null type
- Create/edit form: "ID-only" checkbox that hides the type input when checked
- "Enroll in this sequence" dropdowns filter to **active, typed** templates — ID-only templates should not appear in a generic type picker

**Delivery-side match.** Hook sequence targets accept **either** `template_type` (cascade) **or** `template_id` (direct) — both set is rejected at save time (`api.hooks.validateTargetPayload`); both unset is a delivery-time failure.

### 3.14 Capture Mode (Intercept Pattern)

When a sender needs to know "this event was captured for special handling — don't retry, don't run the normal pipeline" and the response shape carries that outcome, use the intercept pattern.

**Shape:**
1. Sender posts event as usual.
2. Receiver checks a mode flag via a guarded atomic `UPDATE`.
3. If the mode was "capture": halt the pipeline, snapshot the payload, return a distinct response:
   ```json
   { "status": "captured" }
   ```
4. The flip is atomic: **first event wins**; subsequent events during the same window fall through to the normal pipeline.

**Why atomic guarded UPDATE.** Without the guard, two events arriving in the same tick both see "capture mode ON", both capture, you get duplicate captures.

```sql
UPDATE hooks
   SET capture_mode = 'off', captured_sample = ?, captured_at = NOW()
 WHERE id = ? AND capture_mode = 'capturing'
```

Row count = 1 → you won the race and should capture. Row count = 0 → fall through.

**Respond-first exception.** This inverts §5.4 by design — the receiver must await the pipeline because the response shape is part of the feature. See §5.27.

**Keep the primitive simple.** No TTL unless the lifecycle genuinely requires one; a manual off-switch plus atomic first-writer-wins is usually enough. Don't add timer complexity you don't need.

### 3.15 Sequence webhook and start_workflow Steps

Sequence steps can fire HTTP requests directly (`webhook`) and start workflow
executions directly (`start_workflow`) without wrapping them in an
`internal_function`. Both are thin wrappers over infrastructure that already
exists elsewhere — they exist because first-class typed steps have clearer
config shapes, validation, and UI than a generic `internal_function` call.

**When to reach for each:**

| Shape | Use |
|---|---|
| One-off HTTP POST to an external endpoint | `webhook` |
| One-off HTTP call to an internal route | Prefer `internal_function` (one fewer hop) — see §3.8 |
| Kick off a branching workflow from inside a drip | `start_workflow` |
| Cancel sequences on an external event | `internal_function: cancel_sequences` |

**Webhook step config:**

```json
{
  "method": "POST",
  "url": "https://hooks.example.com/endpoint",
  "credential_id": 5,
  "headers": {},
  "body": {
    "contact_id": "{{trigger_data.contact_id}}",
    "event": "check_in"
  },
  "timeout_ms": 30000
}
```

`url`, `headers`, and `body` values go through the universal resolver before
dispatch. Credentials live in the shared `credentials` table (same rows
YisraHook HTTP targets use) via `lib/credentialInjection`, which handles
`internal` / `bearer` / `api_key` / `basic` types and enforces
`allowed_urls` scope checks.

**Webhook step is NOT retry-idempotent** — same caveat as internal-function
hook targets (§5.18). Receiver must tolerate duplicate delivery on retry.

**start_workflow step config:**

```json
{
  "workflow_id": 12,
  "init_data": {
    "contact_id": "{{trigger_data.contact_id}}",
    "case_id":    "{{trigger_data.case_id}}"
  },
  "tie_to_contact": true,
  "contact_id_override": null
}
```

`init_data` is run through the resolver, then persisted as both `init_data`
and initial `variables` on the new execution row (parity with the three
other creation paths — see §5.21, updated to four sites).

**Contact-tying precedence (see §3.12 for the full pattern):**

1. `tie_to_contact: true` (default) → `enrollment.contact_id` is the explicit
   override.
2. `tie_to_contact: false` + non-empty `contact_id_override` → resolver runs,
   must produce a positive integer (or the step fails).
3. `tie_to_contact: false` + empty `contact_id_override` → no explicit override,
   workflow template's `default_contact_id_from` applies (may yield NULL).

**start_workflow IS retry-safe** (§5.26). Before firing, the step checks
`sequence_step_log.output_data` for a prior `workflow_execution_id` on this
(enrollment, step_number). If one exists and the execution row is still
present, the step reuses it rather than creating a duplicate. If the prior
execution row has been deleted (retention, manual cleanup), a warning is
logged and a new execution is created — we don't block the sequence on a
missing row.

**Fourth workflow_executions INSERT site.** This step is now the fourth
place a `workflow_executions` row is created (§5.21). Adding a column to
that table means touching four files. A future cleanup candidate: a shared
`createWorkflowExecution()` helper in `lib/workflow_engine`.

**Cross-refs:** §3.12 (contact-tying precedence), §5.18 (webhook idempotency),
§5.21 (workflow_executions INSERT sites — now four), §5.26 (replay-safety).

### 3.16 Email Router — front-end for inbound email

**Use when:** the firm has many inbound email integrations (Apps Script forwarder, SiteGround PHP, SES inbound parse, etc.) and you don't want each one configured against its own hook slug. The router takes one URL — `POST /email-router` — and dispatches to the right hook based on rules you configure in `automationManager.html` → Email Router tab.

Full pipeline and config is in [chapter 10](10-email-router.md). The cookbook-relevant patterns:

**Routes are first-match-wins, ordered by `position`.** Lower position fires first. Conventional layout:

| `position` | Use |
|---|---|
| `10`–`50` | Specific senders / subjects (Calendly, JotForm, court email domain) |
| `100` | Default for new rules |
| `1000`+ | Catch-all routes that fan out to a debug hook |

If two routes both match an event, only the first dispatches. The `match-test` endpoint (`POST /api/email-router/match-test`) returns *all* matching routes so the operator can spot overlap when authoring rules.

**Use the same condition shape as hook filters.** `email_routes.match_config` is evaluated by `hookFilter.evaluateConditions` — the same operator vocabulary (`==`, `contains`, `regex`, etc.). Field paths address the unified envelope: `body.*` (the email JSON the adapter posts), `headers.*`, `query.*`, `meta.*`.

**Internal alert hooks.** Two well-known slugs the router fires on edge cases:

| Slug | Fires when |
|---|---|
| `router-unrouted-alert` | Inbound email matched no active route |
| `router-error-alert` | Slug from a matched route doesn't resolve, or dispatch threw |

These are throttled per `(slug, sender_email)` with a default 1-hour window (env: `ROUTER_ALERT_THROTTLE_MS`). If the hook doesn't exist, `executeHook` returns `not_found` and the router silently no-ops — there's no harm in leaving these unconfigured. To opt in, just create a hook with one of those slugs and configure its targets (e.g. SMS the on-call attorney, append to a Slack channel).

**Capture mode at the router level.** Same shape as hook capture mode (§3.14) — atomic guarded UPDATE on the singleton `email_router_config` row. The sample is preserved across capture cycles and reusable in `match-test` and `preview` to author routes against real data.

**Why not skip the router and let each adapter post to its own hook?** You can. The router is purely an organizational layer for when the inbound-email count grows past two or three. For a single inbound source, point the adapter directly at `/hooks/<slug>` and skip this entirely.

---

## 4. Step-by-Step Guide: Building a New Automation

Worked example: a **"missing bank statement" follow-up sequence** that fires 3 days after a 341 meeting if the client hasn't uploaded bank statements.

### Step 1: Pick the engine

- Contact-tied? **Yes** — one client.
- Auto-cancel when condition no longer applies? **Yes** — if statements uploaded, stop.
- Drip cadence with condition gates? **Yes**.

→ **Sequence**.

### Step 2: Enumerate triggers & cancellation events

| Event | Action |
|---|---|
| `markAttended` fires on a 341 Meeting | enroll in `missing_statements` |
| Client uploads bank statement (via Dropbox webhook) | cancel `missing_statements` |
| Staff marks checklist item "Bank statements" as complete | cancel `missing_statements` |
| Case closes | cancel all sequences for contact (existing behavior) |

### Step 3: Define the template condition

The sequence should self-cancel if the state no longer warrants follow-up.

```json
{
  "query":  "SELECT status FROM checklists WHERE link_type='case' AND link=:case_id AND title='Docs Needed'",
  "params": { "case_id": "trigger_data.case_id" },
  "assert": { "status": { "in": ["incomplete"] } }
}
```

Translation: "Proceed only if the Docs Needed checklist for this case is still incomplete."

### Step 4: Write the steps

| # | Timing | Step condition | Action |
|---|---|---|---|
| 1 | delay 3 days, 10:00 | (none) | send_sms — "Hi {{contacts.contact_fname}}, we still need your bank statements — upload here: {{case_upload_url}}" |
| 2 | delay 2 biz days, 10:00 | (none) | send_email — follow-up with upload link |
| 3 | delay 3 biz days, 09:00 | (none) | create_task — "Call client about missing statements" assigned to `{{case_attorney_id}}` |

### Step 5: Write the SQL to create the template

See §6.1 for full SQL.

### Step 6: Wire the enrollment hook

Edit `services/apptService.js` `markAttended()`:

```js
if (appt.appt_type === '341 Meeting') {
  try {
    const seq = getSequenceEngine();
    await seq.enrollContact(db, appt.appt_client_id, 'missing_statements', {
      appt_id:     appt_id,
      case_id:     appt.appt_case_id,
      enrolled_by: 'markAttended_341'
    });
  } catch (err) {
    console.error('[APPT SERVICE] enroll missing_statements failed:', err.message);
    // Don't rethrow — don't block markAttended on enrollment failure
  }
}
```

**Key practice:** enrollment failures never block the core action. Wrap in try/catch, log, continue.

### Step 7: Wire the cancellation hooks

**Checklist item completion** — in `routes/api.checklists.js` inside `computeAndSaveStatus`, after the status transitions incomplete → complete:

```js
if (newStatus === 'complete' && oldStatus === 'incomplete' && checklist.title === 'Docs Needed') {
  const caseId = checklist.link;
  const [[c]] = await db.query('SELECT case_relate_client_id FROM case_relate WHERE case_relate_case_id = ? AND case_relate_type = "Primary"', [caseId]);
  if (c) {
    const seq = require('../lib/sequenceEngine');
    seq.cancelSequences(db, c.case_relate_client_id, 'missing_statements', 'docs_complete')
      .catch(err => console.error('[CHECKLIST] cancel missing_statements failed:', err.message));
  }
}
```

**Dropbox upload webhook** — configure a hook (via YisraHook) that on an upload event calls an internal route that issues `cancelSequences`.

### Step 8: Test

**Layer-by-layer test plan:**

1. **DB-level:** manually INSERT an enrollment row, manually INSERT the step_job, POST `/process-jobs`, confirm the first step fires.
2. **Engine-level:** call `POST /sequences/enroll` with JWT and watch `sequence_enrollments` + `scheduled_jobs`.
3. **Integration-level:** mark a test 341 appt Attended, confirm enrollment is created. Then cancel via checklist completion and confirm enrollment is `cancelled` and jobs are `failed`.
4. **Template condition:** mark checklist complete *before* step 1 fires; trigger `/process-jobs`; confirm enrollment auto-cancels with `cancel_reason: condition_failed` (or whatever the engine sets).
5. **Fire guard / timing:** set appt time to 2h from now, confirm step 1 is scheduled for now + 3 days at 10 AM firm time.
6. **Copy of real data (stage row):** pick a real closed case, shadow-enroll, check resolved message text for placeholder correctness.

### Step 9: Document

Update `manual/03-YisraFlow-automation/` (or wherever) with:
- Template name + purpose
- Enrollment trigger point (file + function)
- Cancellation trigger points (all of them)
- Template condition explanation
- Step-by-step summary

Without this, the next person (or you in six months) won't know why the sequence is firing — or not firing.

---

## 5. Pitfalls Catalog

### 5.1 Timezone

**Rule:** human-entered times in firm timezone (`America/Detroit`), machine-generated times in UTC.

- `appt_date` — firm local, stored as "fake UTC" by mysql2 (no TZ conversion on write)
- `appt_date_utc` — real UTC, computed by `localToUTC()`
- `scheduled_jobs.scheduled_time` — UTC always
- `env.now` in workflow variables — current server time (UTC)

**Common mistake:** passing `appt_date` directly as a `scheduled_time` in UTC. Use `appt_date_utc` or precompute via `localToUTC()`.

**Luxon pattern** for building firm-local times from local-stored datetimes:
```js
const apptLocal = DateTime.fromISO(
  new Date(appt_date).toISOString().slice(0, 19),
  { zone: FIRM_TZ }
);
// Now apptLocal knows it's firm-local; .toUTC() gives real UTC
```

### 5.2 Null Guards on Timing

**Pre-computed resume timestamps may be null** if the moment is already past. `schedule_resume` with a null `resumeAt` skips silently (via `skipToStep`). This is the design — honor it:

```js
// ✗ WRONG — blows up if past
const resume_2h = new Date(utcMs - 2 * 3600000).toISOString();

// ✓ RIGHT
const resume_2h = (utcMs - 2 * 3600000) > Date.now()
  ? new Date(utcMs - 2 * 3600000).toISOString()
  : null;
```

**Past-but-non-null absolute times fire on the next tick.** This pattern is for *pre-computed* timestamps that you don't want to fire at all if they're behind you (e.g. the 24h reminder for an appointment booked 2 hours from now). For sequence `delay.at` and workflow `wait_for.at` / `schedule_resume.resumeAt` with literal past times, the engine returns the past Date as-is and `/process-jobs` picks it up immediately on its next tick — no skip, no throw. If you need skip-on-past, pre-compute and pass `null`.

**Empty `at` resolution throws.** Sequence-side `delay.at` resolving to `""` after `{{trigger_data.X}}` lookup throws (let `error_policy` decide). Workflow-side `wait_for.at` and `schedule_resume.resumeAt` resolving to empty/null follow the skip-block path via `skipToStep` (or `nextStep` if not set) — same contract `apptService.createAppt` already relies on.

### 5.3 Circular Dependencies

`sequenceEngine` ↔ `internal_functions` (because `enroll_sequence` / `cancel_sequences` live in internal functions and call back into sequence engine). Break with **deferred require inside function bodies:**

```js
// ✗ TOP of file
const sequenceEngine = require('./sequenceEngine');

// ✓ INSIDE function
enroll_sequence: async (params, db) => {
  const sequenceEngine = require('./sequenceEngine');  // ← lazy
  // ...
}
```

### 5.4 Cloud Run Timeouts

- HTTP response must arrive within the instance timeout. Don't block the response on external calls.
- **Pattern:** `respond first, act after`. See `apptService.createAppt` — returns immediately, fires SMS/GCal/workflow start as non-blocking promises.
- **Respond-first is the default, not an absolute.** Capture mode (§3.14) inverts this by design — the receiver awaits the pipeline because the response shape carries the outcome. See §5.27.
- **Long batch operations** must be decomposed into per-entity scheduled jobs (§3.3).
- **Retry backoff is bounded below by polling cadence** — current poll is every ~5 min, so `backoff_seconds: 60` still waits ~5 min in practice.

### 5.5 `isControlStep` Matters

Only three function names are treated as control steps by the workflow engine:

```js
function isControlStep(step) {
  return (
    step.type === 'internal_function' &&
    ['set_next', 'evaluate_condition', 'schedule_resume'].includes(step.config?.function_name)
  );
}
```

**Consequences:**
- A regular step's `next_step` output is **ignored** — the engine always advances sequentially.
- Only `set_next` can make a workflow jump to a non-adjacent step.
- **Omitting `schedule_resume` from the list** (a past bug) caused skipped blocks to fire immediately rather than deferring. If you invent a new control-ish function, **add it to this list.**

### 5.6 SMS / Email Argument Patterns

These have tripped you up before. They're different on purpose:

```js
// SMS — POSITIONAL
await smsService.sendSms(db, from, to, message);

// Email — OBJECT
await emailService.sendEmail(db, { from, to, subject, text, html, attachments, attachment_urls });

// MMS — POSITIONAL (RC only)
await ringcentralService.sendMms(db, from, to, text, country, buffer, filename, mimetype, url, rehost);
```

**`/internal/mms/send`** takes `attachment_url` (singular). **Email** takes `attachment_urls` (plural).

**MMS capability is now a column, not an inferred property.** `phone_lines.mms_capable` (`TINYINT(1)`) is the source of truth — backfilled to `1` for ringcentral lines, `0` for everyone else. The `send_mms` internal function and `/internal/mms/send` route both read this flag rather than checking `provider === 'ringcentral'`. New providers that gain MMS support opt in with a row update, no code change.

**Internal-function path is also wired.** `send_mms` is a first-class internal function (workflows + sequences via `action_type='internal_function'`). The workflow editor's metadata-driven form filters its "From" dropdown to MMS-capable lines via `widget: 'phone_line_mms'`; the sequence editor uses a JSON params textarea so operators type the number, but `send_mms`'s runtime check rejects non-MMS-capable lines clearly.

### 5.7 Resolver Strict Mode Semantics

**Behavior that bit you in the campaign rewrite:**

- `strict: true` does **NOT** throw on unresolved placeholders. Returns `{ status: 'failed', unresolved: [...] }`. **Callers must check `result.status`.**
- **DB infrastructure errors DO throw** (this is new). Before, they were caught and returned `'failed'`. Now they propagate so the job system can retry.
- `POST /resolve` always returns HTTP 200. Check `result.status` and `result.errorType`.

```js
let resolved;
try {
  resolved = await resolve({ db, text, refs, strict: true });
} catch (err) {
  // DB infra failure — retry appropriate
  throw err;  // job system will retry
}

if (resolved.status === 'failed') {
  // Permanent semantic failure (unresolved placeholders) — don't retry
  return recordFailure(resolved.unresolved);
}
```

### 5.8 Enum Migration Order

**Always:** expand → migrate data → contract. MySQL rejects out-of-order.

```sql
-- 1. Expand (add new value alongside old)
ALTER TABLE scheduled_jobs MODIFY type ENUM(
  'one_time','recurring','workflow_resume','sequence_step',
  'task_due_reminder','task_daily_digest','hook_retry','campaign_send',
  'new_type'  -- ← added
);

-- 2. Migrate data
UPDATE scheduled_jobs SET type = 'new_type' WHERE /* condition */;

-- 3. Contract (remove old values) — optional, often skipped
ALTER TABLE scheduled_jobs MODIFY type ENUM( ...without old... );
```

### 5.9 Sequence Cancellation Does `UPDATE`, Not `DELETE`

Enrollments → `status='cancelled'`, `cancel_reason=?`.
Pending jobs → `status='failed'`.

**Preserves audit trail.** When debugging why a sequence didn't fire, you can still see it was cancelled and why.

### 5.10 `task_status` Is `'Deleted'`, Not `'Canceled'`

In the new task system. `'Incomplete'` is a frontend filter meaning `IN ('Pending','Due Today','Overdue')` — **not a DB value**.

### 5.11 Cancelled Campaigns Delete Pending Jobs

Campaigns are the exception to "UPDATE not DELETE". `cancelCampaign()` runs:

```sql
DELETE FROM scheduled_jobs WHERE name LIKE 'campaign:{id}:%' AND status = 'pending';
```

because there's no audit value in keeping 500 pending rows that will never fire. Already-running jobs check campaign status at execution time and record as `'skipped'`.

### 5.12 `UNIQUE(campaign_id, contact_id)` Is Mandatory

Without `uq_campaign_contact`, `recordResult()`'s `ON DUPLICATE KEY UPDATE` falls back to plain INSERT → duplicate rows on retry → `checkCompletion` miscounts. **Run the migration before deploying.**

### 5.13 `scheduled_jobs.data` Is JSON But Stored as Text

`mysql2` returns it as a string sometimes, object other times depending on column type / client version. **Always defensively parse:**

```js
const jobData = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
```

See `executeJob` in `lib/job_executor.js`.

**Write-side companion.** The same round-trip issue bites on INSERT when you clone rows between tables. `SELECT` returns JSON columns as parsed JS objects (client-version dependent); passing a parsed object to a `?` placeholder triggers mysql2's object-argument → `SET col = val` expansion, which corrupts the VALUES list (`ER_WRONG_VALUE_COUNT_ON_ROW` and friends).

**Fix:** normalize to a JSON string via a `toJson` helper before INSERT:
```js
const toJson = (v) =>
  v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);

await db.query(
  `INSERT INTO target (..., data) VALUES (..., ?)`,
  [..., toJson(sourceRow.data)]
);
```

Always route `SELECT`-sourced JSON columns through `toJson()` before feeding them as positional params. Read-side (parse) and write-side (stringify) are two halves of the same bug.

### 5.14 Workflow Variable Shallow Merge

`mergeVariables()` does `{ ...currentVars, ...setVars }` — **last writer wins, no deep merge.**

If Step 2 sets `nested: { a: 1 }` and Step 5 sets `nested: { b: 2 }`, `nested.a` is lost. Either use flat keys (`nested_a`, `nested_b`) or set the full object every time.

### 5.15 Workflow Max 20 Steps Per Invocation

The workflow engine self-schedules continuation via `scheduleSelfContinue()` after 20 executed steps in a single invocation. This prevents any one workflow from starving the `/process-jobs` batch.

Practical effect: a 50-step workflow runs in 3 poll cycles. With the current ~5 min cadence that's ~15 min of wall clock even if every step is fast. **Not a problem for normal workflows;** just be aware.

### 5.16 Workflow `null` from `evaluate_condition` `else` Completes the Workflow

```json
{ "else": null }    // ← workflow terminates here
{ "else": 0 }       // ← next sequential step
```

`null` (JSON null, not the string) is a sentinel that calls `markExecutionCompleted`. Easy to leave in a template and wonder why the workflow ends mid-flow.

### 5.17 Hook Execution Log Growth

`hook_executions` + `hook_delivery_logs` grow unbounded. `raw_input` can be up to 512 KB each. No retention policy is wired yet (v1.3 roadmap). **Manual cleanup script needed** until then — or skip high-volume hooks until retention is in place.

**`scheduled_jobs` is also not pruned today** — sequence-step history (joined via `sequence_step_log.scheduled_job_id`) survives indefinitely. Campaign cancellation does a scoped `DELETE` (§5.11); no other pruning exists. A cross-table retention policy is deferred work — anticipate unbounded growth for any high-volume hook or sequence until then.

### 5.18 Internal-Function Hook Targets Are NOT Idempotent By Default

Hook delivery retries on failure (3 attempts, 120s backoff). For the four target types:

| target_type | Retry-safe? |
|---|---|
| `http` | Depends on endpoint (make your internal routes idempotent) |
| `workflow` | Yes — INSERT of `workflow_executions` is clean |
| `sequence` | Yes — `enrollContact` guards against duplicate active enrollments |
| `internal_function` | **NO** — function is invoked again; side effects can duplicate |

A failure in the delivery-log write after `create_log` / `send_sms` succeeded will trigger a retry, which will call the function a second time. For non-critical logs this is fine; for `send_sms` it means the client might get the message twice.

**Mitigations:**
- Design internal-function hooks to be naturally idempotent (upsert patterns, dedup keys)
- Use `workflow` target type instead, and put the side-effectful call inside the workflow (then a retry just re-runs the workflow lookup / duplicate-guard)
- Accept the small risk for non-critical actions

**Sequence webhook steps share the same caveat.** `executeWebhookAction`
in `lib/sequenceEngine.js` retries on HTTP non-2xx or fetch error per the
step's `error_policy` — each retry fires a fresh HTTP request. Receivers
must tolerate duplicates. `start_workflow` steps are the exception in the
other direction: they check prior `sequence_step_log.output_data` for a
previously-created `workflow_execution_id` and reuse it on retry
(§3.15, §5.26).

### 5.19 Hook Target Conditions Are Evaluated Independently Per Target

All targets for a hook see the **same hook-level transform output**. A target cannot read another target's output or side effects. Fan-out is parallel-independent, not pipelined.

If you need "Target 2 uses the result of Target 1," the answer is: use a workflow target. Workflows have variable passing and branching; hook targets don't.

See §6.4 Target 3 annotation for a concrete example where this tripped up the naive design.

### 5.20 `params_mapping` Single Quotes Are Mandatory for Literals

```json
{ "log_type": "SMS" }        // ← looks up transformOutput.SMS  (usually undefined!)
{ "log_type": "'SMS'" }      // ← literal string "SMS"
```

Bare strings are ALWAYS field lookups. If you want a literal, wrap in single quotes. For numbers and booleans, just use the native JSON type (`"count": 5`, `"active": true`).

Dot-paths (`"contact.id"`) ARE supported — same resolver as hookMapper's `from` rules. Array-index syntax (`items[0]`) is not — flatten via a transform rule first.

### 5.21 `workflow_executions` Has Four INSERT Sites

A new execution row is created in four places:

| # | File | Function | Retry-safe? |
|---|---|---|---|
| 1 | `routes/workflows.js` | `POST /workflows/:id/start` | N/A (caller handles) |
| 2 | `services/apptService.js` | `createAppt()` (appt reminder) | Appt lifecycle guards |
| 3 | `services/hookService.js` | `deliverWorkflow()` (hook → workflow target) | INSERT retries cleanly; async advance doesn't retry (§5.18) |
| 4 | `lib/sequenceEngine.js` | `executeStartWorkflowAction()` (sequence start_workflow step) | **Yes** — checks prior sequence_step_log.output_data for a reusable execution (§3.15) |

**Consequence.** Adding a column to `workflow_executions`, or any new rule
at execution-row creation time, means touching all four. Contact-tying was
partly consolidated via `resolveExecutionContactId()` in
`lib/workflow_engine.js` (§3.12) — a future cleanup could lift the whole
INSERT into a shared `createWorkflowExecution()` helper. Until then, grep
for `INSERT INTO workflow_executions` before adding columns.

### 5.22 Three Tab-Body Idioms Coexist in `automationManager.html`

When adding a new tab to any editor in `automationManager.html`, **read and mirror the editor's existing idiom** — don't pick one globally.

| Editor | Tab-body idiom |
|---|---|
| Hook | Parallel panes — each tab has its own DOM subtree, `display:none` toggled |
| Workflow | `wfSwitchEditorTab` hides/shows a sibling body |
| Sequence | `seqRenderActiveTab` rewrites a single body |

Three idioms coexist because the editors evolved separately. Unifying them is a separate cleanup. For now: open the editor's existing tab-switch code, read how it renders, do the same thing. Pattern-mirror-before-pick.

### 5.23 `scheduled_jobs` Doesn't Write `job_results` for `sequence_step` Rows

The generic `job_results` table only receives rows for `one_time`, `recurring`, and the `task_*` job types. Sequence-step error details live in `sequence_step_log`, not `job_results`.

**UI consequence.** A visibility surface asking "why did this sequence step fail?" must join to `sequence_step_log` for the error text — `job_results` is empty for that step. The join predicate is typically `sequence_step_log.scheduled_job_id = scheduled_jobs.id`.

### 5.24 Two Status Fields Per Sequence-Step History Row

Each executed sequence step has both:

- `scheduled_jobs.status` — `pending | running | completed | failed` (job-level outcome)
- `sequence_step_log.status` — `sent | skipped | failed` (logical outcome)

They answer different questions. `scheduled_jobs.status = failed` can mean "infra error, retried"; `sequence_step_log.status = skipped` means "condition didn't pass, intentionally suppressed". A row can have a job_status but no log row (scheduled-but-never-executed).

**Display rule (shipped).** Primary badge = log_status when a log row exists, else job_status. Secondary job_status badge surfaces when different — retry-audit context without hiding the logical outcome. Row rendered muted when no log row.

### 5.25 Low-Use UI Surfaces Drift Silently

Old `putSeq` / `abortSeq` on `contact2.html` read `s.enrollment_id`, but the service returned `se.id` unaliased. Every cancel button POST'd to `/sequences/enrollments/undefined/cancel` for who knows how long — no-one noticed because the tab wasn't exercised.

**Pattern.** If you're adding something that "feels like it should already exist," **grep first.** The existing one might be broken, and shipping a parallel new version without noticing — or worse, calling the broken one — is how drift compounds.

### 5.26 `workflow_execution_steps` Is Not Replay-Safe

Stores `step_id` (soft ref to `workflow_steps.id`) but **no snapshot of the step's config at execution time.** Function names and params shown in execution history reflect **current** config, not as-run.

**Contrast:** `sequence_step_log.action_config_resolved` IS replay-safe — it snapshots the resolved action config for the actual execution.

If workflow audit-ability becomes a requirement (compliance, dispute resolution), snapshot the full step config into `workflow_execution_steps` at execution time. Until then, edits to `workflow_steps` retroactively rewrite the history view.

### 5.27 Respond-First Has Exceptions — Capture Mode

§5.4's "respond first, act after" is the default, not an absolute. Capture mode (§3.14) inverts it by design: the receiver awaits the pipeline because the response shape (`{status: "captured"}`) **is** the feature — the sender uses it to distinguish outcomes.

**Rule of thumb.** Respond-first is default; await-and-respond is acceptable when the sender relies on the response to distinguish outcomes. Don't apply respond-first blindly.

### 5.28 Hook Target Config Resolution Uses `getByPath`

`deliverSequence` and `deliverInternalFunction` both resolve config sources via `getByPath`, so dot-path references work out of the box:

```json
{
  "contact_id_field":    "body.contactId",
  "trigger_data_fields": ["body.appt_id", "body.appt_time"]
}
```

This makes passthrough hooks (no mapper configured) usable directly — users don't need a separate transform step just to flatten `body.*` into top-level keys.

**When adding a new target type** that reads from transform output: use `getByPath(targetOutput, fieldName)`, NOT `targetOutput[fieldName]`. The bare lookup silently returns `undefined` on any dot-path source. (Found during a live passthrough-hook bug — the existing `targetOutput[contactIdField]` call failed silently on `"body.contactId"`.)

### 5.29 Unused Enum Values on Workflow Status Columns

Schema allows values the engine never writes:

- `workflow_executions.status` allows `pending` — engine writes `active`, `processing`, `delayed`, `completed`, `completed_with_errors`, `failed`, `cancelled`.
- `workflow_execution_steps.status` allows `skipped` and `delayed` — engine writes only `success` and `failed`.

**UI rule.** Defensive badges exist for all enum values — don't rely on the engine's current narrow write set. A future change might start writing `skipped` (e.g. condition-gated steps), and dead UI paths are a hazard waiting to surface.

### 5.30 `POST /workflows/:id/start` Body Shape — Wrapped vs Flat

The endpoint accepts two shapes, and the difference matters for contact-tying:

```js
// Wrapped — top-level contact_id is an explicit override
{ init_data: { foo: 'bar' }, contact_id: 123 }

// Flat — the entire body becomes init_data
{ contactId: 123, foo: 'bar' }
// → init_data = { contactId: 123, foo: 'bar' },  contact_id NOT extracted
```

**The pitfall.** A starter that sets `contact_id` at the top level of a *flat* body does NOT get an explicit override. The key gets absorbed into `init_data` and the template's `default_contact_id_from` mechanism (if configured) is what decides the outcome.

**The rule.** Explicit `contact_id` override only works from wrapped bodies — wrapped-only by design, so flat legacy callers don't have their `contact_id` silently stripped. If you want the template default, flat is fine. If you want an explicit override, wrap.

**Cross-ref:** §3.12 (contact-tying precedence — full precedence ladder).

---

## 6. Template Examples

### 6.1 Sequence — Full SQL for a New Template

```sql
-- ─────────────────────────────────────────────────────────────
-- missing_statements — follow-up when 341 attended but docs missing
-- ─────────────────────────────────────────────────────────────

INSERT INTO sequence_templates
  (name, type, appt_type_filter, appt_with_filter, active, condition, description)
VALUES
  (
    'Missing Bank Statements Follow-Up',
    'missing_statements',
    NULL,
    NULL,
    1,
    JSON_OBJECT(
      'query',  'SELECT status FROM checklists WHERE link_type=''case'' AND link=:case_id AND title=''Docs Needed''',
      'params', JSON_OBJECT('case_id', 'trigger_data.case_id'),
      'assert', JSON_OBJECT('status', JSON_OBJECT('in', JSON_ARRAY('incomplete')))
    ),
    'Enrolled after 341 Meeting attended. Cancels when Docs Needed checklist goes complete.'
  );

SET @tid = LAST_INSERT_ID();

-- Step 1: SMS 3 days later at 10 AM
INSERT INTO sequence_steps
  (template_id, step_number, timing, action_type, action_config, condition, fire_guard, error_policy)
VALUES (
  @tid, 1,
  JSON_OBJECT('type', 'business_days', 'value', 3, 'timeOfDay', '10:00'),
  'internal_function',
  JSON_OBJECT(
    'function_name', 'send_sms',
    'params', JSON_OBJECT(
      'from',    (SELECT value FROM app_settings WHERE `key` = 'sms_default_from'),
      'to',      '{{contacts.contact_phone}}',
      'message', 'Hi {{contacts.contact_fname}}, we still need your bank statements to proceed with your case. Please upload them at your earliest convenience.'
    )
  ),
  NULL, NULL,
  JSON_OBJECT('strategy', 'retry_then_ignore', 'max_retries', 2, 'backoff_seconds', 60)
);

-- Step 2: Email 2 business days later
INSERT INTO sequence_steps
  (template_id, step_number, timing, action_type, action_config, condition, fire_guard, error_policy)
VALUES (
  @tid, 2,
  JSON_OBJECT('type', 'business_days', 'value', 2, 'timeOfDay', '10:00'),
  'internal_function',
  JSON_OBJECT(
    'function_name', 'send_email',
    'params', JSON_OBJECT(
      'from',    (SELECT value FROM app_settings WHERE `key` = 'email_default_from'),
      'to',      '{{contacts.contact_email}}',
      'subject', 'Reminder: Bank Statements Needed',
      'html',    '<p>Hi {{contacts.contact_fname}},</p><p>We still need your bank statements. Please reply to this email with them attached, or upload at the link we sent previously.</p>'
    )
  ),
  NULL, NULL,
  JSON_OBJECT('strategy', 'retry_then_ignore', 'max_retries', 2, 'backoff_seconds', 60)
);

-- Step 3: Task for the assigned attorney, 3 business days later at 9 AM
INSERT INTO sequence_steps
  (template_id, step_number, timing, action_type, action_config, condition, fire_guard, error_policy)
VALUES (
  @tid, 3,
  JSON_OBJECT('type', 'business_days', 'value', 3, 'timeOfDay', '09:00'),
  'internal_function',
  JSON_OBJECT(
    'function_name', 'create_task',
    'params', JSON_OBJECT(
      'title',       'Call client re: missing bank statements',
      'description', 'Client has not responded to SMS or email. Call to follow up.',
      'contact_id',  '{{trigger_data.contact_id}}',
      'assigned_to', 1,
      'link_type',   'case',
      'link_id',     '{{trigger_data.case_id}}'
    )
  ),
  NULL, NULL,
  JSON_OBJECT('strategy', 'abort')
);
```

### 6.2 Scheduled Job — Recurring with Calendar Gate

```js
// Create the recurring job once (from the UI or a setup script)
await apiSend('/scheduled-jobs', 'POST', {
  type:            'recurring',
  job_type:        'internal_function',
  name:            'Weekly Case Stage Review Email',
  scheduled_time:  '2026-05-04T13:00:00Z',       // first Monday 9 AM ET
  recurrence_rule: '0 13 * * 1',                  // every Monday 9 AM ET
  function_name:   'run_case_stage_review',       // you'd add this to internal_functions.js
  params:          { recipient_user_id: 1 }
});
```

Inside the internal function:
```js
run_case_stage_review: async ({ recipient_user_id }, db) => {
  // Gate on workday
  const { workday } = await calendarService.isWorkday(new Date().toISOString());
  if (!workday) return { skipped: 'non-workday' };

  // ...fetch cases by stage, build email, send...

  return { success: true, output: { cases_reviewed: N } };
}
```

### 6.3 Workflow — Branching With Resume-Refetch-Recheck Pattern

This is a compact version of the appointment reminder workflow pattern. Adapt freely.

```js
// init_data shape (passed in by apiSend('/workflows/X/start', 'POST', { init_data: {...} }))
const initData = {
  appt_id:           apptId,
  appt_type:         '341 Meeting',
  case_id:           caseId,
  sms_client_from:   smsDefaultFrom,
  appt_time_display: '2:30 PM',
  // Pre-computed UTC resume timestamps (null if already past)
  resume_day_before: '2026-05-01T22:00:00Z',
  resume_2h:         '2026-05-02T18:30:00Z',
  resume_10m:        '2026-05-02T20:20:00Z'
};
```

**Steps (stored in `workflow_steps` table):**

```
Step 1: lookup_contact { contact_id: "{{trigger_data.contact_id}}" }
        set_vars: {
          contact_phone: "{{this.output.contact_phone}}",
          contact_fname: "{{this.output.contact_fname}}"
        }

Step 2: evaluate_condition { variable: "appt_type", operator: "==", value: "341 Meeting",
                              then: 3, else: 8 }

--- 341 branch ---
Step 3: schedule_resume { resumeAt: "{{resume_day_before}}", nextStep: 4 }

Step 4: lookup_appointment { appointment_id: "{{appt_id}}" }
        set_vars: { appt_status: "{{this.output.appt_status}}" }

Step 5: evaluate_condition { variable: "appt_status", operator: "==", value: "Scheduled",
                              then: 6, else: null }
                              ← null terminates the workflow if appt no longer scheduled

Step 6: send_sms {
          from:    "{{sms_client_from}}",
          to:      "{{contact_phone}}",
          message: "Hi {{contact_fname}}, reminder: your 341 meeting is tomorrow at {{appt_time_display}}."
        }

Step 7: set_next { value: 13 }   ← jump to common cleanup / next touchpoint

--- non-341 branch ---
Step 8: schedule_resume { resumeAt: "{{resume_2h}}", nextStep: 9 }
Step 9: lookup_appointment { appointment_id: "{{appt_id}}" }
        set_vars: { appt_status: "{{this.output.appt_status}}" }
Step 10: evaluate_condition { ... same pattern ... then: 11, else: null }
Step 11: send_sms { ... }
Step 12: set_next { value: 13 }

--- common ---
Step 13: (next touchpoint, e.g. 10-min-before reminder — same pattern)
```

### 6.4 Hook — Full Configuration (One Hook, Four Target Types)

Real-world example: a Calendly webhook fans out to four different internal reactions, each demonstrating a different target_type.

**The hook (`INSERT INTO hooks`):**
```json
{
  "slug":             "calendly-booking",
  "name":             "Calendly: New Booking",
  "description":      "Receives Calendly invitee.created events and fans out to multiple internal reactions",
  "auth_type":        "hmac",
  "auth_config":      { "secret": "env:CALENDLY_WEBHOOK_SECRET", "header": "calendly-webhook-signature" },
  "filter_mode":      "conditions",
  "filter_config":    {
    "operator": "and",
    "conditions": [
      { "path": "body.event", "op": "equals", "value": "invitee.created" }
    ]
  },
  "transform_mode":   "mapper",
  "transform_config": {
    "rules": [
      { "from": "body.payload.invitee.name",                  "to": "contact_name",   "transforms": ["trim"] },
      { "from": "body.payload.invitee.email",                 "to": "contact_email",  "transforms": ["lowercase", "trim"] },
      { "from": "body.payload.invitee.text_reminder_number",  "to": "contact_phone",  "transforms": ["digits_only"] },
      { "from": "body.payload.event.start_time",              "to": "appt_start_utc" },
      { "from": "body.payload.event_type.name",               "to": "appt_type", "transforms": ["trim"] },
      { "from": "body.payload.tracking.utm_source",           "to": "utm_source" }
    ]
  },
  "active":           1
}
```

After the transform, every target receives the same normalized object:
```json
{
  "contact_name":   "Alice Chen",
  "contact_email":  "alice@example.com",
  "contact_phone":  "3135551234",
  "appt_start_utc": "2026-05-10T18:00:00.000Z",
  "appt_type":      "Strategy Session",
  "utm_source":     "google"
}
```

#### Target 1 — `internal_function` (log the receipt)

Fire-and-forget audit log. One call, one row.

```json
{
  "hook_id":     123,
  "name":        "Log booking receipt",
  "position":    1,
  "target_type": "internal_function",
  "config": {
    "function_name": "create_log",
    "params_mapping": {
      "contact_email": "contact_email",
      "log_type":      "'WEBHOOK'",
      "subject":       "'Calendly booking received'",
      "content":       "appt_type"
    }
  },
  "active": 1
}
```

Resolved call: `create_log({ contact_email: "alice@example.com", log_type: "WEBHOOK", subject: "Calendly booking received", content: "Strategy Session" }, db)`.

#### Target 2 — `http` (internal route for lookup-or-create + appt creation)

Complex business logic stays in a route — multiple hooks can call it, and the full YisraCase auth/user-context stack applies.

```json
{
  "hook_id":       123,
  "name":          "Create contact + appt via internal route",
  "position":      2,
  "target_type":   "http",
  "method":        "POST",
  "url":           "https://app.4lsg.com/internal/calendly/intake",
  "credential_id": 5,
  "body_mode":     "transform_output",
  "active":        1
}
```

Credential #5 is type `internal` — auto-injects `INTERNAL_API_KEY` as `x-api-key`. The route does find-or-create contact, `apptService.createAppt()` (which fires the **appointment reminder workflow** as a side effect — see §3.8).

#### Target 3 — `sequence` (enroll in a welcome drip)

Contact-tied, multi-step, auto-cancels if the appt gets cancelled.

```json
{
  "hook_id":     123,
  "name":        "Enroll in welcome drip",
  "position":    3,
  "target_type": "sequence",
  "config": {
    "template_type":       "new_lead_welcome",
    "contact_id_field":    "contact_id",
    "trigger_data_fields": ["appt_start_utc", "appt_type", "utm_source"],
    "appt_type_filter":    null,
    "appt_with_filter":    null
  },
  "conditions": {
    "operator": "and",
    "conditions": [
      { "path": "contact_id", "op": "exists" }
    ]
  },
  "active": 1
}
```

Condition note: Target 3 only fires if `contact_id` is present in the transform output. That depends on Target 2 having already run and stored the contact ID back into the transform output — which it can't, because each target gets a fresh copy of the hook-level transform output. **Lesson:** if one target's output depends on another's side effect, use a workflow as the downstream target (Target 4 below) and orchestrate there. Keep hook targets independent.

For this hook the better pattern is to have Target 2's internal route do the enrollment itself after creating the contact — OR to use a pre-existing contact-lookup transform rule that checks by email before fan-out.

#### Target 4 — `workflow` (complex intake orchestration)

When the reaction involves branching, variable passing, or multiple delayed steps, use a workflow.

```json
{
  "hook_id":     123,
  "name":        "Start intake orchestration workflow",
  "position":    4,
  "target_type": "workflow",
  "config":      { "workflow_id": 12 },
  "conditions": {
    "operator": "and",
    "conditions": [
      { "path": "appt_type", "op": "equals", "value": "Strategy Session" }
    ]
  },
  "active": 1
}
```

Only fires for Strategy Session bookings. Workflow #12 receives the full transform output as `init_data`, then:
1. Looks up or creates the contact
2. Evaluates whether they've been a past client (branch)
3. Creates a prep task for the assigned attorney
4. Schedules a 24h-before reminder via `schedule_resume`
5. On resume, re-fetches the appt, re-checks status, sends reminder if still scheduled

This is the **Resume-Refetch-Recheck-Send pattern (§3.1)**, kicked off by an external webhook, with zero custom code beyond the hook config and the workflow definition.

---

**Why this composition shape:**
- The hook does normalization only — one consistent shape feeds all four targets.
- Target-level conditions keep each target's scope clear.
- Internal targets skip the HTTP re-entry overhead for atomic actions.
- HTTP targets remain the right choice when business logic already lives in a route.
- All four targets share the same retry path (`hook_retry` job) and the same dry-run test UI.

---

## Appendix: Files to know

| File | What it owns |
|---|---|
| `lib/workflow_engine.js` | `advanceWorkflow`, `scheduleResume`, `mergeVariables`, `isControlStep`, `getWorkflowFinalStatus` |
| `lib/sequenceEngine.js` | `enrollContact`, `executeStep`, `cancelSequences`, `cancelEnrollment`, `checkCondition`, `calculateStepTime` |
| `lib/internal_functions.js` | All 23 built-in functions |
| `lib/job_executor.js` | `executeJob`, inline blocks for `task_due_reminder` / `task_daily_digest` / `campaign_send` |
| `routes/process_jobs.js` | Heartbeat: claim jobs, dispatch, record results, reschedule recurring |
| `routes/scheduled_jobs.js` | CRUD on `scheduled_jobs` |
| `routes/workflows.js` | Workflow + step CRUD, `GET /workflows/functions` |
| `routes/sequences.js` | Template + enrollment CRUD |
| `services/campaignService.js` | `createCampaign`, `executeSend`, `cancelCampaign`, `checkCompletion` |
| `services/hookService.js` | `executeHook`, `executeRetry`, `queueRetryJob`, `deliverToTarget` (dispatcher), `deliverHttp`/`deliverWorkflow`/`deliverSequence`/`deliverInternalFunction`, `buildDryRunPreview`, `resolveParamsMapping`, `getByPath` |
| `services/apptService.js` | `createAppt`, `markAttended`, `markNoShow`, `cancelAppt`, `rescheduleAppt`, `cancelApptWorkflow` |
| `services/taskService.js` | `createTask`, `completeTask`, `scheduleDueReminder`, `cancelDueReminder` + email builders |
| `services/calendarService.js` | `isWorkday`, `nextBusinessDay`, `prevBusinessDay` |
| `services/resolverService.js` | `resolve({ db, text, refs, strict })` |
| `services/timezoneService.js` | `localToUTC`, `utcToLocal`, `nowLocal`, `formatLocal` |

---

*Originally maintained as a standalone cookbook; now chapter 13 of this manual. Last meaningful update: April 2026. Covers YisraHook v1.2.1 (internal automation targets + capture mode), plus cross-engine list envelope, contact-tying, ID-only sequences, and monitoring-UI patterns. **If the code diverges from this cookbook, the code is right.***