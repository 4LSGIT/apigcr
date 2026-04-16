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
  "assert":      { "appt_status": { "in": ["no_show", "cancelled"] } },
  "assert_mode": "all"
}
```

**Param paths** are dot-notation into `trigger_data`. `:appt_id` resolves to `trigger_data.appt_id`.

**Assert operators:**

| Operator | Example |
|----------|---------|
| Scalar (equality) | `"appt_status": "no_show"` |
| In array | `"appt_status": { "in": ["no_show", "cancelled"] }` |
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
    "assert": { "appt_status": { "in": ["no_show", "cancelled"] } }
  }
}
```

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