# Part 3 — Sequence Engine

Sequences are contact-specific drip campaigns with condition gates at every step. Unlike workflows, they are designed to be enrolled and cancelled from outside — the sequence engine automatically checks at each step whether the reason it was started still applies.

---

## Core Concepts

**Template** — defines what a sequence does: its steps, timing, and the condition that must remain true throughout. Stored in `sequence_templates` + `sequence_steps`. Reusable — many contacts can be enrolled in the same template simultaneously.

**Enrollment** — one contact's run through a template. Stored in `sequence_enrollments`. Tracks status, current step, and the `trigger_data` that caused enrollment.

**Trigger data** — context captured at enrollment time (e.g. `{ appt_id: 123, appt_time: "..." }`). Used to resolve placeholders in step messages and to evaluate conditions at each step.

**Template condition** — checked before every step. If it fails → the entire enrollment is cancelled. Use this for "the reason we enrolled is no longer true."

**Step condition** — checked before that specific step only. If it fails → skip that step, continue the sequence. Use this for "only send this message if X is still true."

**Fire guard** — a lightweight time-based check with no DB query. If it fails → skip the step, continue. Use this for "only send this if the appointment is still > 24 hours away."

---

## Step Action Types

Sequence steps dispatch through `sequenceEngine.executeStep` based on
`action_type`. Six action types are supported:

| action_type | What it does | Retry-safe? |
|---|---|---|
| `sms` | Sends SMS via `send_sms` internal function | Provider-dependent |
| `email` | Sends email via `send_email` internal function | Provider-dependent |
| `task` | Creates a task via `create_task` internal function | No — duplicates possible |
| `internal_function` | Calls any registered internal function | Depends on function |
| `webhook` | First-class HTTP request with credential injection | **No** — receiver must tolerate duplicates |
| `start_workflow` | Starts a workflow execution, optionally tied to the enrollment's contact | **Yes** — checks prior log output for reusable execution |

`webhook` and `start_workflow` were added in Slice 3.3. See Cookbook §3.15
for the pattern, §5.18 for the webhook idempotency caveat, and §5.21 for
the (now four) `workflow_executions` INSERT sites.

---

## The Check Chain (Every Step)

```
scheduled_jobs fires { type: 'sequence_step', enrollmentId, stepId }
        │
        ├─ 1. Enrollment still active?           No → skip (enrollment_not_active)
        ├─ 2. Template condition passes?          No → CANCEL ENROLLMENT, stop
        ├─ 3. Fire guard passes?                 No → skip step, schedule next
        ├─ 4. Step condition passes?             No → skip step, schedule next
        ├─ 5. Resolve placeholders in config
        ├─ 6. Execute action
        ├─ 7. Log result
        └─ 8. Schedule next step (or complete enrollment)
```

Steps 3 and 4 skip but continue. Step 2 cancels and stops. This distinction is intentional.

---

## Timing Types

Each step defines when it fires relative to enrollment time (step 1) or the previous step's execution (step 2+).

| Type | Description | Example |
|------|-------------|---------|
| `immediate` | Fire in ~5 seconds | First message after no-show |
| `delay` | Fixed duration after previous | `{ "type": "delay", "value": 2, "unit": "hours" }` |
| `next_business_day` | Next non-restricted business day at a target time | `{ "type": "next_business_day", "timeOfDay": "13:00", "randomizeMinutes": 30 }` |
| `business_days` | N business days from now | `{ "type": "business_days", "value": 2, "timeOfDay": "10:00" }` |
| `before_appt_fixed` | N hours before `trigger_data.appt_time` | `{ "type": "before_appt_fixed", "hoursBack": 2 }` |
| `before_appt` | Business-day-aware slot before appt | `{ "type": "before_appt", "hoursBack": 24, "timeOfDay": "10:00" }` |

`next_business_day` and `before_appt` both call `calendarService` and respect Shabbos + Yom Tov. See [07-calendar-service.md](07-calendar-service.md).

---

## Condition Syntax

Used in both `sequence_templates.condition` (cancel-level) and `sequence_steps.condition` (skip-level).

```json
{
  "query":       "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
  "params":      { "appt_id": "trigger_data.appt_id" },
  "assert":      { "appt_status": { "in": ["No Show", "Canceled"] } },
  "assert_mode": "all"
}
```

**Param paths** are dot-notation into `trigger_data`. `:appt_id` resolves to `trigger_data.appt_id`.

**Assert values must match the actual DB values.** `appt_status` is a Title Case enum with spaces — valid values are `Scheduled`, `Attended`, `No Show`, `Canceled` (single L), `Rescheduled`. Using `no_show` or `cancelled` will never match a real row.

**Assert operators:**

| Operator | Example |
|----------|---------|
| Scalar (equality) | `"appt_status": "No Show"` |
| In array | `"appt_status": { "in": ["No Show", "Canceled"] }` |
| Is null | `"case_intake": { "is_null": true }` |
| Is not null | `"case_intake": { "is_null": false }` |

**`assert_mode`:** `"all"` (AND, default) or `"any"` (OR).

---

## Fire Guard Syntax

No DB query — evaluated purely from `trigger_data`.

```json
{ "min_hours_before_appt": 24 }
```

Requires `trigger_data.appt_time`. Skips the step if the appointment is fewer than 24 hours away.

---

## Example — No-Show Sequence Template

**Template:**
```json
{
  "name": "No-Show Follow-Up",
  "type": "no_show",
  "condition": {
    "query":  "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
    "params": { "appt_id": "trigger_data.appt_id" },
    "assert": { "appt_status": { "in": ["No Show", "Canceled"] } }
  }
}
```

The `type` column (`no_show`) is the template identifier used for enrollment lookup — that's an internal string, not a DB value. The `appt_status` values inside the condition's `assert` clause are real DB values, so they must match the exact enum casing and spelling.

**Steps:**

| # | Timing | Action | Guards |
|---|--------|--------|--------|
| 1 | `immediate` | SMS — "We missed you today..." | None |
| 2 | `delay 2h` | SMS — "We'd love to reschedule..." | None |
| 3 | `next_business_day 13:00 ±30min` | SMS — "Reaching out one more time..." | None |
| 4 | `next_business_day 10:00` | Email — follow-up with intake link | None |
| 5 | `next_business_day 09:00` | Task — manual follow-up call | None |

**Enrollment (when appt marked no-show):**
```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:    456,
  template_type: "no_show",
  trigger_data:  { appt_id: 123, appt_time: "2026-03-20T14:00:00Z", enrolled_by: "appt_handler" }
});
```

**Cancellation (when new appt booked):**
```js
await apiSend("/sequences/cancel", "POST", {
  contact_id:    456,
  template_type: "no_show",
  reason:        "new_appointment_booked"
});
```

---

## Example — Pre-Appointment Intake Sequence

Uses `before_appt` timing and `is_null` conditions. Steps fire backward from the appointment time.

| # | Timing | Condition | Action |
|---|--------|-----------|--------|
| 1 | `immediate` | None | SMS — confirmation + intake link |
| 2 | `delay 10m` | None | SMS — "Please fill out intake form" |
| 3 | `delay 24h` | `case_intake is_null: true` + fire_guard `min_hours_before_appt: 24` | SMS — intake reminder |
| 4 | `delay 24h` after step 3 | `case_intake is_null: true` + fire_guard `min_hours_before_appt: 24` | SMS — second intake reminder |
| 5 | `before_appt_fixed 2h` | `case_intake is_null: false` | SMS — "You're all set, see you soon!" |
| 6 | `before_appt_fixed 30m` | `case_intake is_null: true` | SMS — "Please bring ID and fill out intake on arrival" |

Steps 5 and 6 fire at the same time window but on opposite conditions — exactly one of them fires.

---

### Example: webhook step — notify Zapier when a drip fires

```json
{
  "step_number": 3,
  "action_type": "webhook",
  "action_config": {
    "method": "POST",
    "url": "https://hooks.zapier.com/hooks/catch/123/abc/",
    "credential_id": 5,
    "body": {
      "contact_id": "{{trigger_data.contact_id}}",
      "template_name": "{{trigger_data.template_name}}",
      "step": 3
    },
    "timeout_ms": 15000
  },
  "timing": { "type": "business_days", "value": 2, "timeOfDay": "10:00" },
  "error_policy": { "strategy": "retry_then_ignore", "max_retries": 2, "backoff_seconds": 60 }
}
```

Placeholders in `url`, `headers`, and `body` resolve against the sequence
context (enrollment + trigger_data + pulled refs) at execution time. Credential
`5` must exist in the `credentials` table and its `allowed_urls` (if set) must
match the `url`.

---

### Example: start_workflow step — escalate to branching workflow

```json
{
  "step_number": 4,
  "action_type": "start_workflow",
  "action_config": {
    "workflow_id": 12,
    "init_data": {
      "contact_id":  "{{trigger_data.contact_id}}",
      "case_id":     "{{trigger_data.case_id}}",
      "source":      "sequence:no_show_followup:step_4"
    },
    "tie_to_contact": true
  },
  "timing": { "type": "business_days", "value": 3, "timeOfDay": "09:00" },
  "error_policy": { "strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30 }
}
```

With `tie_to_contact: true` (the default), the started workflow's `contact_id`
column is stamped with `enrollment.contact_id`, so the workflow appears on that
contact's Automations tab even if the workflow template has no
`default_contact_id_from` configured.

To untie (e.g. fire a workflow that concerns the spouse rather than the
enrolled contact):

```json
{
  "tie_to_contact": false,
  "contact_id_override": "{{trigger_data.spouse_contact_id}}"
}
```

Leave `contact_id_override` empty to fall through to the workflow template's
own `default_contact_id_from` setting.

**Retry semantics:** if the step fires, the INSERT succeeds, but then the job
is retried (e.g. process_jobs claim fails afterward and the job goes back to
`pending`), the retry will find the prior `workflow_execution_id` in
`sequence_step_log.output_data` and reuse it — no duplicate execution row is
created.

---

## Enrollment API

```
POST /sequences/enroll
  body: { contact_id, template_type, trigger_data }

POST /sequences/cancel
  body: { contact_id, template_type?, reason }
  template_type omitted → cancel ALL active sequences for this contact

GET  /sequences/enrollments
  query: contact_id?, template_type?, status?, page?, limit?

GET  /sequences/enrollments/:id?log=true
  Returns enrollment + full step log

POST /sequences/enrollments/:id/cancel
  body: { reason }
```

---

## Template Management API

```
GET    /sequences/templates
GET    /sequences/templates/:id          (includes steps)
POST   /sequences/templates              { name, type, appt_type_filter?, appt_with_filter?, condition?, description? }
PUT    /sequences/templates/:id          (same fields, all optional)
DELETE /sequences/templates/:id          (blocked if active enrollments exist)

POST   /sequences/templates/:id/steps
PUT    /sequences/templates/:id/steps/:stepNumber
PATCH  /sequences/templates/:id/steps/:stepNumber
DELETE /sequences/templates/:id/steps/:stepNumber  (renumbers subsequent steps)
PATCH  /sequences/templates/:id/steps/reorder      { fromStep, toStep } — atomic swap
```

### Template Filter Fields

`appt_type_filter` (varchar 50) — when set, this template only matches enrollments where the appointment type matches (e.g. `"Strategy Session"`). NULL matches all appointment types.

`appt_with_filter` (tinyint) — when set, this template only matches enrollments where the staff member matches (`users.user` ID). NULL matches all staff. Used for cascading template selection — see [Cascading Template Match](#cascading-template-match) below.

---

## Cascading Template Match

When enrolling via `POST /sequences/enroll`, the engine finds the most specific matching template using `appt_type_filter` and `appt_with_filter`:

1. type + `appt_type_filter` match + `appt_with_filter` match (most specific)
2. type + `appt_type_filter` match + `appt_with_filter` NULL
3. type + `appt_type_filter` NULL + `appt_with_filter` match
4. type + both filters NULL (generic fallback)

Pass `appt_type` and `appt_with` in the enroll body or in the `filters` param of `enrollContact()`:

```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:    456,
  template_type: "pre_appt",
  trigger_data:  { appt_id: 123, appt_time: "2026-03-20T14:00:00Z" },
  appt_type:     "Strategy Session",
  appt_with:     2
});
```

This allows multiple templates of the same `type` with different behaviors per appointment type or staff member.

---

## Cancellation Hooks

Call `cancelSequences()` or `POST /sequences/cancel` from these events:

| Event | Template type to cancel | Reason |
|-------|------------------------|--------|
| New appointment booked | `no_show` | `new_appointment_booked` |
| Appointment attended | `no_show` | `appointment_attended` |
| Incoming SMS from contact | `no_show` | `incoming_sms` |
| Incoming email from contact | `no_show` | `incoming_email` |
| Contact manually resolved | any | `manual` |