# 1 — Overview

## For operators

YisraFlow has **five subsystems** that handle different shapes of automation. They all share one underlying job queue, so anything one engine schedules is processed by the same heartbeat as everything else.

Use this chart to pick one:

| You want to… | Use this |
|---|---|
| Send a single SMS or email at a specific time in the future | **Scheduled Jobs** (one-time) |
| Run something every day / every Monday / on a cron | **Scheduled Jobs** (recurring) |
| Drip a 5-step follow-up to one client that auto-stops if they reply | **Sequence** |
| Run a multi-step intake flow with branching ("if 341, do this; else, do that") | **Workflow** |
| Have Calendly / JotForm / a payment processor trigger something in YisraCase | **YisraHook** |
| Have inbound email trigger something based on sender or subject | **Email Router** (which then routes to a Hook) |

Everything is configured through `automationManager.html`. Five tabs across the top — one per subsystem.

When something doesn't fire when you expected, the order of places to look is:
1. **Logs / Executions tab** of the relevant subsystem (did it fire? why did it skip?)
2. **Scheduled Jobs tab** filtered to "Pending" (is it queued for the future?)
3. The relevant template / workflow / hook config (is it active? are the conditions right?)

---

## Technical reference

### The five subsystems and where they live

```
lib/workflow_engine.js          Workflow Engine
lib/sequenceEngine.js           Sequence Engine
routes/scheduled_jobs.js        Scheduled Jobs (CRUD)
routes/process_jobs.js          The heartbeat — claims and dispatches all jobs
lib/job_executor.js             Executes one_time/recurring jobs (webhook, internal_function, custom_code, campaign_send, task_due_reminder, task_daily_digest)
lib/internal_functions.js       The 23-function action library shared by all engines

services/hookService.js         YisraHook receiver + delivery dispatcher
services/hookFilter.js          Hook condition evaluator (AND/OR groups)
services/hookMapper.js          Hook mapper transform engine
services/hookTransforms.js      Hook transform function library
routes/api.hooks.js             POST /hooks/:slug + management CRUD

services/emailRouter.js         Email Router — match incoming emails to hooks
routes/api.email_router.js      POST /email-router + management CRUD

services/resolverService.js     Universal {{table.column|modifier}} resolver
services/calendarService.js     Jewish business calendar (Shabbos + Yom Tov)
services/timezoneService.js     localToUTC / utcToLocal / parseUserDateTime
```

### Choosing the right engine

| Question | Workflow | Sequence | Scheduled Job |
|----------|----------|----------|---------------|
| Tied to a specific contact? | Optional (via `contact_id`) | ✓ Always | ✗ |
| Auto-cancels from outside? | ✗ (use a workflow_resume + re-check pattern) | ✓ Built-in via `cancelSequences()` | ✗ |
| Each step re-checks conditions? | Manual (`evaluate_condition`) | ✓ Built-in (template + step + fire_guard) | ✗ |
| Needs branching logic? | ✓ | Limited (skip/cancel only) | ✗ |
| Needs data flow between steps? | ✓ via `set_vars` | ✓ via the universal resolver | ✗ |
| Recurring on a schedule? | ✗ | ✗ | ✓ |
| Single action at a future time? | Overkill | Overkill | ✓ |
| Triggered by external system? | Via YisraHook | Via YisraHook | Via YisraHook |

### Shared infrastructure

**`scheduled_jobs` table** is the unified queue. All five subsystems insert rows here; `POST /process-jobs` claims them in batches of 10.

The `scheduled_jobs.type` enum has five values:
- `one_time` — fires once at `scheduled_time`, then `completed` or `failed`
- `recurring` — fires on `recurrence_rule` (cron), reschedules itself after each run
- `workflow_resume` — resumes a delayed workflow execution (created by `wait_for` / `schedule_resume`)
- `sequence_step` — fires the next step of a sequence enrollment
- `hook_retry` — retries a failed YisraHook delivery to one target

For `one_time` and `recurring` jobs, the actual *execution flavor* is stored in the `data` JSON column under `data.type`. Possible values: `webhook`, `internal_function`, `custom_code`, `campaign_send`, `task_due_reminder`, `task_daily_digest`. Some of those are seeded by the system (campaign sends, task reminders, daily digest) and not normally created by hand.

**`/process-jobs` heartbeat** runs `recoverStuckJobs()`, then claims up to 10 pending jobs with `FOR UPDATE SKIP LOCKED` and dispatches each. It's called periodically by Cloud Scheduler.

**`internal_functions.js`** is the action library. 23 functions covering SMS, email, contact CRUD, appointment CRUD, task creation, sequence control, log writing, DB queries, and workflow-only control flow (branching, delays). Workflows and sequences both call into it; scheduled jobs call into it via `data.type='internal_function'`.

**`resolverService.resolve()`** is the universal placeholder engine. `{{contacts.contact_fname}}`, `{{appts.appt_date|date:dddd}}`, `{{trigger_data.amount}}`. Used by sequences automatically and by workflows via the `set_vars`/template path. Restricted to a whitelist of 12 tables.

**`calendarService`** answers "is this datetime a workday?" with Jewish business calendar awareness (Shabbos Friday 6pm – Saturday 10pm, plus the eleven strict Yom Tov holidays). `nextBusinessDay()` and `prevBusinessDay()` walk to find a valid slot, optionally with random jitter.

### How a job flows through the system

```
                        ┌─────────────────────────┐
                        │  POST /process-jobs     │
                        │  (Cloud Scheduler)      │
                        └────────────┬────────────┘
                                     │
                                     ▼
                          recoverStuckJobs()
                  resets stuck 'running' jobs (>15min)
                  resets stuck 'processing' executions (>15min)
                                     │
                                     ▼
                  Claim up to 10 pending jobs
                  WHERE status='pending' AND scheduled_time<=NOW()
                  AND (expires_at IS NULL OR expires_at>NOW())
                  AND (max_executions IS NULL OR execution_count<max_executions)
                  FOR UPDATE SKIP LOCKED
                                     │
                                     │ mark each 'running'
                                     ▼
                          Dispatch each job by type
                                     │
            ┌────────────┬───────────┼────────────┬─────────────┐
            ▼            ▼           ▼            ▼             ▼
      workflow_resume sequence_step hook_retry  one_time    recurring
            │            │           │            │             │
            ▼            ▼           ▼            └──────┬──────┘
       advance        executeStep  executeRetry         │
       Workflow                                          ▼
                                                    executeJob()
                                          (dispatches by data.type:
                                           webhook, internal_function,
                                           custom_code, campaign_send,
                                           task_due_reminder,
                                           task_daily_digest)
```

The four "special" types (`workflow_resume`, `sequence_step`, `hook_retry`) detach the executor — the receiver returns `dispatched` immediately and a background async block does the real work, marking `completed` or `failed` when done. If the container crashes mid-execution, the job stays `running` until `recoverStuckJobs()` resets it on the next tick.

### Quick-start examples

**Start a workflow:**
```js
await apiSend("/workflows/1/start", "POST", {
  init_data: { contactId: 123, source: "web_form" },
  contact_id: 123   // optional explicit override; see workflows chapter
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

**Cancel all no-show sequences for a contact (e.g. they booked again):**
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
  params:        { from: "2485592400", to: "3135551234", message: "Reminder." }
});
```

**Receive a webhook (set up the hook in the UI first):**
```
POST https://app.4lsg.com/hooks/calendly-new-lead
Content-Type: application/json
x-hook-key: <key set on the hook>

{ "event": "invitee.created", "payload": { ... } }
```
