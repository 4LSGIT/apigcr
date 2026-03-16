# Part 1 — Overview

The YisraCase automation system has three interconnected engines that share common infrastructure but serve different purposes. Understanding which to use — and why — is the starting point for everything else.

---

## The Three Engines

### Workflow Engine
Multi-step processes where data flows between steps. Best for complex automation that needs branching logic, variable passing, and an auditable step-by-step history. Not contact-specific by default — you provide context in `init_data` when you start it.

**Use when:** You need a sequence of actions that depend on each other, share data, or need conditional branching. Example: when a new consultation is scheduled, look up the contact, send a welcome email, create an intake task, notify the assigned attorney, and update the case status — all in one coordinated flow.

### Sequence Engine
Contact-specific drip sequences with condition gates at every step. Designed to be enrolled from outside, cancelled from outside, and automatically skip or abort when conditions change. Built around the idea that the *reason you started* may no longer apply by the time a step fires.

**Use when:** You need a series of communications or tasks tied to a specific contact and a specific trigger event, where each step should check "is this still relevant?" before acting. Example: no-show follow-up — send SMS after 5 minutes, again after 2 hours, then next business day — but cancel automatically if the contact books a new appointment.

### Scheduled Job Scheduler
Single actions fired at a specific time or on a recurring schedule. No contact context, no chaining, no conditions. Pure fire-and-forget scheduling.

**Use when:** You need one thing to happen at one time, or on a repeating schedule. Example: daily digest email every weekday at 9am, or a webhook ping to sync with an external CRM every 6 hours.

---

## Choosing the Right Engine

| Question | Workflow | Sequence | Scheduled Job |
|----------|----------|----------|---------------|
| Is it tied to a specific contact? | Optional | ✓ Always | ✗ |
| Does it need to auto-cancel from outside? | ✗ | ✓ | ✗ |
| Does each step re-check conditions? | Manual | ✓ Built-in | ✗ |
| Does it need branching logic? | ✓ | Limited | ✗ |
| Does it need data flow between steps? | ✓ | Via resolver | ✗ |
| Is it recurring on a schedule? | ✗ | ✗ | ✓ |
| Is it a single action at a future time? | Overkill | Overkill | ✓ |

---

## Shared Infrastructure

All three engines run on the same foundation:

**`scheduled_jobs` table** — the unified job queue. All three engines insert rows here; `/process-jobs` picks them up on a polling interval. Job types: `one_time`, `recurring`, `workflow_resume`, `sequence_step`.

**`internal_functions.js`** — the built-in action library. Send SMS, send email, create task, lookup/update contact or appointment, wait, branch, evaluate conditions. All three engines call the same functions.

**`services/resolverService.js`** — the universal placeholder resolver. Resolves `{{contacts.contact_fname}}`, `{{appts.appt_date|date:dddd MMMM Do}}`, etc. against live DB data in a single JOIN query. Used by workflows (via `resolvePlaceholders`) and sequences (via `resolve()`).

**`services/calendarService.js`** — Jewish business calendar. Shabbos and Yom Tov aware. Used by sequence timing (`next_business_day`, `before_appt`) and the `/isWorkday`, `/nextBusinessDay`, `/prevBusinessDay` routes.

---

## How They Connect

```
                        ┌─────────────────────────────┐
                        │      /process-jobs           │
                        │  (polls every ~30 seconds)   │
                        └──────────────┬──────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
   workflow_resume job       sequence_step job          one_time/recurring
              │                        │                        │
              ▼                        ▼                        ▼
   advanceWorkflow()          executeStep()             executeJob()
   workflow_engine.js         sequenceEngine.js         job_executor.js
              │                        │                        │
              └────────────────────────┴────────────────────────┘
                                       │
                              internal_functions.js
                              resolverService.js
                              calendarService.js
```

---

## Quick Start Examples

**Start a workflow:**
```js
await apiSend("/workflows/1/start", "POST", {
  contactId: 123,
  source: "web_form"
});
```

**Enroll a contact in a sequence:**
```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:    123,
  template_type: "no_show",
  trigger_data:  { appt_id: 456, appt_time: "2026-03-20T14:00:00Z" }
});
```

**Cancel all no-show sequences for a contact:**
```js
await apiSend("/sequences/cancel", "POST", {
  contact_id:    123,
  template_type: "no_show",
  reason:        "new_appointment_booked"
});
```

**Schedule a one-time job:**
```js
await apiSend("/scheduled-jobs", "POST", {
  type:          "one_time",
  job_type:      "internal_function",
  delay:         "10m",
  function_name: "send_sms",
  params:        { from: "2485592400", to: "3135551234", message: "Your reminder." }
});
```
