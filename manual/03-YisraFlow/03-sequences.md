# 3 — Sequence Engine

## For operators

A **sequence** is a follow-up series tied to a single contact. It has steps that fire over time — usually messages, sometimes tasks — and each step **checks first** whether it still makes sense to fire.

Example: the no-show sequence. Client misses a 341 meeting. The sequence enrolls them and queues:
1. Immediate SMS — "we missed you today"
2. Next business day — SMS — "let's reschedule"
3. Two business days later — task on Stuart's queue
4. Five business days later — final email

If the client books a new appointment between steps 2 and 3, **the sequence cancels itself** because it knows the reason it started no longer applies.

You'd reach for a sequence when:
- The follow-up is tied to one specific person and one specific event (a missed appointment, an unsigned form, an unpaid invoice).
- Different conditions could happen mid-series that should stop it (the email arrives, the form gets signed, the appointment gets rebooked).
- The same series should pick a different template based on appointment type or assigned attorney.

You wouldn't reach for one when:
- It's not contact-specific (use a workflow or a recurring scheduled job).
- It's a single message with no chaining (use a one-time scheduled job).
- It needs branching logic ("if A do this, else do that") — sequences only support skip-or-continue, not branching. Use a workflow.

**In `automationManager.html` → Sequences tab**, you'll see a list of templates on the left. Each template has a `type` (like `no_show`), optional filters (`appt_type_filter`, `appt_with_filter`), an optional template-level condition that cancels the whole enrollment if it stops being true, and an ordered list of steps. Each step has its own action, timing, and optional condition / fire guard.

When something doesn't fire when you expected:
1. Find the enrollment in the template's Enrollments tab. Status `cancelled` and `cancel_reason` will tell you why.
2. If the enrollment is `active`, look at its step log — which step ran last, what was the result?
3. If a step skipped, the `skip_reason` says which guard it failed (`condition_failed`, `fire_guard_failed`, `step_condition_failed`).

---

## Technical reference

### Core concepts

**Template** (`sequence_templates`) — the definition. `name`, `type` (string identifier like `no_show`), optional `appt_type_filter` and `appt_with_filter` for cascading match, optional template-level `condition`, and a list of steps in `sequence_steps`.

**Enrollment** (`sequence_enrollments`) — one specific contact's run through a template. Stores `contact_id`, `trigger_data` (the event context), `current_step`, and `status` (`active` / `completed` / `cancelled`).

**Steps** (`sequence_steps`) — `step_number`, `action_type` (six kinds, see below), `action_config`, `timing`, optional `condition`, optional `fire_guard`, optional `error_policy`.

**Step log** (`sequence_step_log`) — append-only log of every step execution. Captures `status` (`sent` / `skipped` / `failed`), `skip_reason`, the resolved `action_config_resolved`, output, error, scheduled-at vs executed-at.

### Six action types

| Action type | Use |
|---|---|
| `sms` | Send a text message via the firm's phone lines |
| `email` | Send an email via configured providers |
| `task` | Create a task assigned to a user |
| `internal_function` | Call any of the 23 built-in functions |
| `webhook` | First-class HTTP call with credential injection (≠ `internal_function: webhook` — see below) |
| `start_workflow` | Kick off a workflow execution from inside a sequence |

Behind the scenes, `sms`/`email`/`task`/`internal_function` all run through `executeJob()` as `internal_function` calls under the hood. `webhook` and `start_workflow` are handled directly by the sequence engine (they have their own `executeWebhookAction` and `executeStartWorkflowAction` paths).

### Six timing types

| Type | Description | Example |
|---|---|---|
| `immediate` | Fire in ~5 seconds | First message after no-show |
| `delay` (relative) | Fixed duration after previous step | `{ "type": "delay", "value": 2, "unit": "hours" }` |
| `delay` (absolute) | Fixed datetime, optionally from `trigger_data` | `{ "type": "delay", "at": "{{trigger_data.target_iso}}" }` |
| `next_business_day` | Next non-restricted business day at a target time | `{ "type": "next_business_day", "timeOfDay": "13:00", "randomizeMinutes": 30 }` |
| `business_days` | N business days from now | `{ "type": "business_days", "value": 2, "timeOfDay": "10:00" }` |
| `before_appt_fixed` | N hours before `trigger_data.appt_time` | `{ "type": "before_appt_fixed", "hoursBack": 2 }` |
| `before_appt` | Business-day-aware slot before appt | `{ "type": "before_appt", "hoursBack": 24, "timeOfDay": "10:00" }` |

**Absolute `delay`** — the `at` field accepts:
- `2026-05-01T14:30:00Z` — explicit UTC
- `2026-05-01T14:30:00-04:00` — explicit offset
- `2026-05-01T14:30:00` or `2026-05-01 14:30:00` — naive ISO, interpreted in firm timezone
- `2026-05-01` — date-only, interpreted as midnight firm-local
- `{{trigger_data.field_name}}` — placeholder resolved at fire time (only `trigger_data.X` placeholders, not real-table refs)

Past times are returned as-is — the next `/process-jobs` tick fires them. If a placeholder resolves to empty, the step throws and `error_policy` decides.

**Random jitter** — every timing type accepts an optional `randomizeMinutes` field. ±N minute symmetric jitter on the computed time. Capped at 1440 (24h). Useful when you don't want a hundred no-show enrollments all firing at exactly 9:00:00 on the same morning.

`next_business_day` and `before_appt` also call `calendarService` and respect Shabbos + Yom Tov — see [07-calendar-service.md](07-calendar-service.md).

### The check chain — every step

```
scheduled_jobs fires { type: 'sequence_step', enrollmentId, stepId }
        │
        ├─ 1. Enrollment still active?              No → skip (enrollment_not_active)
        ├─ 2. Template condition passes?            No → CANCEL ENROLLMENT, stop
        ├─ 3. Fire guard passes?                    No → skip step, schedule next
        ├─ 4. Step condition passes?                No → skip step, schedule next
        ├─ 5. Resolve placeholders in action_config (universal resolver)
        ├─ 6. Execute action (with retry per error_policy)
        ├─ 7. Log result to sequence_step_log
        └─ 8. Schedule next step (or complete enrollment if no more)
```

Steps 3 and 4 *skip* and continue. Step 2 *cancels* and stops. The distinction is intentional — the template condition is "does this enrollment still make sense at all," while step conditions and fire guards are "does this *one step* make sense right now."

### Condition syntax

Used in both `sequence_templates.condition` (cancel-level) and `sequence_steps.condition` (skip-level).

```json
{
  "query":       "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
  "params":      { "appt_id": "trigger_data.appt_id" },
  "assert":      { "appt_status": { "in": ["No Show", "Canceled"] } },
  "assert_mode": "all"
}
```

**Param paths** are dot-notation into `trigger_data`. `:appt_id` resolves to `trigger_data.appt_id`. The same placeholder can be reused multiple times in one query — the engine resolves each `:name` token positionally.

**Assert values must match the actual DB values.** `appt_status` is a Title Case enum with spaces — valid values are `Scheduled`, `Attended`, `No Show`, `Canceled` (single L), `Rescheduled`. Using `no_show` or `cancelled` will never match a real row.

**Assert operators:**

| Operator | Example |
|---|---|
| Scalar (equality) | `"appt_status": "No Show"` |
| In array | `"appt_status": { "in": ["No Show", "Canceled"] }` |
| Is null | `"case_intake": { "is_null": true }` |
| Is not null | `"case_intake": { "is_null": false }` |

**`assert_mode`:** `"all"` (AND, default) or `"any"` (OR).

**Only `SELECT` is allowed.** Anything else returns false (treats condition as failed).

**No row found = condition fails.** If your `WHERE` matches zero rows, the condition is treated as false — the step is skipped (or for a template condition, the enrollment is cancelled).

### Fire guard syntax

Time-based, no DB query. Currently only one guard:

```json
{ "min_hours_before_appt": 24 }
```

Skip the step if `trigger_data.appt_time` is fewer than N hours away. Use this on later steps of a pre-appointment sequence — "don't send the 24h reminder if we're already inside 24h."

If `trigger_data.appt_time` is missing, the guard fails open (returns true) and the step fires.

### Error policies

```json
{ "strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30 }
```

- `ignore` (default) — log and continue
- `retry_then_ignore` — retry up to `max_retries`, then continue if still failing
- `abort` — cancel the enrollment immediately
- `retry_then_abort` — retry, then cancel if still failing

`abort` and `retry_then_abort` set `cancel_reason = "step_N_failed"` on the enrollment.

See [08-error-policies.md](08-error-policies.md) for full details.

### Cascading template match

When enrolling via `POST /sequences/enroll` with `template_type`, the engine picks the most specific matching template using `appt_type_filter` and `appt_with_filter`:

1. type + `appt_type_filter` matches + `appt_with_filter` matches (most specific)
2. type + `appt_type_filter` matches + `appt_with_filter` NULL
3. type + `appt_type_filter` NULL + `appt_with_filter` matches
4. type + both filters NULL (generic fallback)

Pass `appt_type` and `appt_with` in the enroll body or the `filters` arg of `enrollContact()`:

```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:    456,
  template_type: "pre_appt",
  trigger_data:  { appt_id: 123, appt_time: "2026-03-20T14:00:00Z" },
  appt_type:     "Strategy Session",
  appt_with:     2
});
```

This lets you have multiple templates with the same `type` but different content per appointment type or assigned staff member, with a generic fallback.

### Direct enrollment by template ID

For ad-hoc templates that don't fit the type-cascade pattern, you can enroll by exact template ID:

```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:   123,
  template_id:  42,
  trigger_data: { source: "import" }
});
```

This bypasses cascade matching entirely. The `template_type`, `appt_type`, and `appt_with` fields are not allowed in this mode (400 if you include them).

**Validation rule:** exactly one of `template_type` or `template_id` must be provided. Empty strings, whitespace-only strings, and both-set all return 400.

### Cancellation hooks

Call `cancelSequences()` (or `POST /sequences/cancel`) from any event that means "the reason this sequence started no longer applies":

| Event | Template type to cancel | Reason |
|---|---|---|
| New appointment booked | `no_show` | `new_appointment_booked` |
| Appointment attended | `no_show` | `appointment_attended` |
| Incoming SMS from contact | `no_show` | `incoming_sms` |
| Incoming email from contact | `no_show` | `incoming_email` |
| Contact manually resolved | any | `manual` |

Cancellation marks the enrollment `cancelled`, sets `cancel_reason`, and marks any pending/running `scheduled_jobs` for that enrollment as `failed` (preserves audit trail rather than deleting). Running jobs that finish after cancellation will see `enrollment.status = 'cancelled'` on their next check and exit cleanly.

```js
await apiSend("/sequences/cancel", "POST", {
  contact_id:    123,
  template_type: "no_show",
  reason:        "new_appointment_booked"
});
```

Omit `template_type` to cancel **all** active sequences for the contact.

### `webhook` step (first-class HTTP)

For sending an HTTP request out from within a sequence, prefer the dedicated `webhook` action type over wrapping a fetch in `custom_code`. It supports credential injection from the shared `credentials` table, validation at save time, and clearer config shape than a generic `internal_function` call.

```json
{
  "step_number": 3,
  "action_type": "webhook",
  "action_config": {
    "method": "POST",
    "url": "https://hooks.zapier.com/hooks/catch/123/abc/",
    "credential_id": 5,
    "headers": {},
    "body": {
      "contact_id":    "{{trigger_data.contact_id}}",
      "template_name": "{{trigger_data.template_name}}",
      "step": 3
    },
    "timeout_ms": 15000
  },
  "timing": { "type": "business_days", "value": 2, "timeOfDay": "10:00" },
  "error_policy": { "strategy": "retry_then_ignore", "max_retries": 2, "backoff_seconds": 60 }
}
```

Placeholders in `url`, `headers`, and `body` go through the universal resolver before dispatch. `credential_id` references the shared `credentials` table; the same rows YisraHook HTTP targets use.

**Save-time validation:**
- `url` required, parse-checked if literal (no `{{}}`)
- `method` optional, one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Default `POST`.
- `credential_id` optional; positive integer, FK-checked
- `headers` optional; JSON object
- `body` optional; JSON object
- `timeout_ms` optional; positive integer ≤ 120000. Default 30000.

**Not retry-idempotent.** Each retry fires a fresh HTTP request. Receivers must tolerate duplicate delivery on retry. There is no `no_retry: true` flag yet.

### `start_workflow` step (first-class workflow start)

For escalating a sequence into a multi-step branching workflow:

```json
{
  "step_number": 4,
  "action_type": "start_workflow",
  "action_config": {
    "workflow_id": 12,
    "init_data": {
      "contact_id": "{{trigger_data.contact_id}}",
      "case_id":    "{{trigger_data.case_id}}",
      "source":     "sequence:no_show_followup:step_4"
    },
    "tie_to_contact": true
  },
  "timing": { "type": "business_days", "value": 3, "timeOfDay": "09:00" },
  "error_policy": { "strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30 }
}
```

With `tie_to_contact: true` (default), the started workflow's `contact_id` column is stamped with `enrollment.contact_id`, so the workflow appears on that contact's Automations tab even if the workflow template has no `default_contact_id_from`.

To untie (e.g. fire a workflow about the spouse rather than the enrolled contact):
```json
{
  "tie_to_contact": false,
  "contact_id_override": "{{trigger_data.spouse_contact_id}}"
}
```

Leave `contact_id_override` empty to fall through to the workflow template's own `default_contact_id_from` setting.

**Save-time validation:**
- `workflow_id` required, positive integer, FK-checked
- `init_data` optional; JSON object
- `tie_to_contact` optional; boolean. Default `true`.
- `contact_id_override` optional; string, number, or null

**Retry semantics — retry-safe.** If the step fires, the INSERT succeeds, but then the job is retried (process-jobs claim fails afterward and the job goes back to `pending`), the retry checks `sequence_step_log.output_data` for a prior `workflow_execution_id` on this `(enrollment, step_number)`. If found and the execution still exists, it reuses it — no duplicate execution row.

### Example: no-show sequence template

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

| # | Timing | Action | Notes |
|---|---|---|---|
| 1 | `immediate` | SMS — "We missed you today..." | |
| 2 | `delay 2h` | SMS — "We'd love to reschedule..." | |
| 3 | `next_business_day 13:00 ±30min` | SMS — "Reaching out one more time..." | Random jitter so all enrolees don't fire at exactly 1:00pm |
| 4 | `next_business_day 10:00` | Email — follow-up with intake link | |
| 5 | `next_business_day 09:00` | Task — manual follow-up call | |

**Enrolled when an appt is marked No Show:**
```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:    456,
  template_type: "no_show",
  trigger_data:  { appt_id: 123, appt_time: "2026-03-20T14:00:00Z", enrolled_by: "appt_handler" }
});
```

**Cancelled when a new appt is booked, the contact replies, or someone marks them resolved.**

### Example: pre-appointment intake sequence

Uses `before_appt` timing and `is_null` conditions. Steps fire backward from the appointment time.

| # | Timing | Condition | Action |
|---|---|---|---|
| 1 | `immediate` | none | SMS — confirmation + intake link |
| 2 | `delay 10m` | none | SMS — "please fill out intake form" |
| 3 | `delay 24h` | `case_intake is_null: true` + fire_guard `min_hours_before_appt: 24` | SMS — intake reminder |
| 4 | `delay 24h` after step 3 | `case_intake is_null: true` + fire_guard `min_hours_before_appt: 24` | SMS — second intake reminder |
| 5 | `before_appt_fixed 2h` | `case_intake is_null: false` | SMS — "you're all set, see you soon!" |
| 6 | `before_appt_fixed 30m` | `case_intake is_null: true` | SMS — "please bring ID and fill out intake on arrival" |

Steps 5 and 6 fire at the same time but on opposite conditions — exactly one of them fires, depending on whether the intake form is in by then.
