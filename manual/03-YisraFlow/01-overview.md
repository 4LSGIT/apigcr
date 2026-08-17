# 1 — Overview

## For operators

YisraFlow has **six subsystems** that handle different shapes of automation. Five of them share one underlying job queue, so anything they schedule is processed by the same heartbeat as everything else; the sixth, the Trigger System, runs inline off database mutations rather than off the queue.

Use this chart to pick one:

| You want to… | Use this |
|---|---|
| Send a single SMS or email at a specific time in the future | **Scheduled Jobs** (one-time) |
| Run something every day / every Monday / on a cron | **Scheduled Jobs** (recurring) |
| Drip a 5-step follow-up to one client that auto-stops if they reply | **Sequence** |
| Run a multi-step intake flow with branching ("if 341, do this; else, do that") | **Workflow** |
| Have Calendly / JotForm / a payment processor trigger something in YisraCase | **YisraHook** |
| Have inbound email trigger something based on sender or subject | **Email Router** (which then routes to a Hook) |
| React to something that happened *inside* YisraCase — an appointment attended, a docket filled in, a checklist finished | **Trigger System** |

Everything is configured through `automationManager.html`. Tabs across the top — one per subsystem, plus the email/phone ingest, court review, and activity surfaces.

When something doesn't fire when you expected, the order of places to look is:
1. **Logs / Executions tab** of the relevant subsystem (did it fire? why did it skip?)
2. **Scheduled Jobs tab** filtered to "Pending" (is it queued for the future?)
3. The relevant template / workflow / hook config (is it active? are the conditions right?)

---

## Technical reference

### The six subsystems and where they live

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

lib/domainEvents.js             Trigger System — emit(), envelope builder, ALS loop guard
services/triggerService.js      Trigger engine — registry, match, transform, dispatch
routes/api.triggers.js          Trigger rules CRUD + executions + dry run / replay

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

### Trigger System (chapter 15)

The other five subsystems all wait to be told to run. The Trigger System watches YisraCase itself: services announce domain events at their post-commit choke points (`domainEvents.emit`), and `trigger_rules` for that event type are matched, transformed, and dispatched through the same `hookFilter` / `hookMapper` / `actionDispatchers` primitives YisraHook and the ingest rules use — it is the third consumer of those shared parts, not a parallel implementation. Emission is fire-and-forget and never throws, so a broken rule can never fail the mutation that announced it. Two loop guards bound recursion (chain depth 4, and a 50-dispatch budget per root event) because a rule's actions can cause mutations that announce further events.

See **[15-triggers.md](15-triggers.md)** for the event catalog, the match/transform fail-safe rulings, the action types, and the testing and replay tools.

---

### Shared infrastructure

**`scheduled_jobs` table** is the unified queue. The five queue-driven subsystems insert rows here; `POST /process-jobs` claims them in batches of 10. The Trigger System is the exception — it evaluates rules inline at the emitting service's post-commit point, so a trigger fires within the same request rather than on the next heartbeat. Its *actions* can of course queue jobs (a workflow start, a sequence enrollment).

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

**`calendarService`** answers "is this datetime a workday?" with Jewish business calendar awareness (Shabbos Friday 6pm – Saturday 10pm, plus the eleven strict Yom Tov holidays). `nextBusinessDay()` and `prevBusinessDay()` walk to find a valid slot, optionally with random jitter. `nextFriendlyTime()` is a lighter helper: offset N ms from now, roll to Monday 9am if the result lands Friday-evening or weekend.

### Background steps run on throttled CPU (Cloud Run)

**Workflow and sequence steps execute AFTER the HTTP response is sent.** Both `POST /workflows/:id/start` and the `start_workflow` internal function advance the execution fire-and-forget — nothing holds a request open while steps run.

That matters because this service uses Cloud Run's **default (request-based) billing**, where an instance is allocated CPU only while it is processing a request. Between requests it is throttled hard. Consequences to design around:

- **Everything background is slow, variably.** The same pure-JS step (wf40's formatter) has been measured at 137 ms on a busy instance and 3 800 ms on an idle one — a 27× spread with no code change.
- **CPU-heavy work fails outright.** Chromium cannot complete its startup handshake on the CPU left over; PDF renders timed out in a workflow step while the identical render through an in-request route succeeded every time (2026-08-14).
- **I/O-bound work still completes.** DB queries, HTTP calls, and email sends limp along, which is why this went unnoticed for months.

If a step needs real CPU, do not do the work in-process. Have the step call the app's own HTTP route (a `webhook` step with the `YisraCase Internal` credential, id 1) so Cloud Run serves it as a genuine request with a full vCPU — CPU is allocated per *instance*, so the waiting background step speeds up too. wf40 step 3 is the worked example.

The blunt alternative is instance-based billing (`--no-cpu-throttling`), which allocates CPU for the instance's whole lifetime and fixes every background step at once. Priced 2026-08-14 for this service (1 vCPU / 1 GiB, us-east1): **~$47/month**, because the 5-minute scheduler ping keeps an instance alive around the clock. Declined at that price while only one workload was actually broken — but it is the right lever if background CPU work becomes common.

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