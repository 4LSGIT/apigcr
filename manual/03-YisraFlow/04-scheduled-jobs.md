# 4 — Scheduled Jobs

## For operators

A **scheduled job** is a single fire-and-forget action set for a specific time, or a recurring action on a cron schedule. There's no chaining, no contact context, no "if this then that" — just one thing happens at one time.

You'd reach for a scheduled job when:
- "Send the daily appointment report at 8am every weekday."
- "Ping this URL once an hour."
- "Run this cleanup task on the 1st of every month."
- "Send this one-off SMS to a specific number tomorrow at 2pm."

You wouldn't reach for one when:
- The action is tied to a contact and might need to be cancelled (use a **sequence**).
- The action has multiple steps with branching (use a **workflow**).
- The trigger is an external event (use a **YisraHook**).

**In `automationManager.html` → Scheduled Jobs tab**, you'll see a list of jobs filtered by status (pending, running, completed, failed) and type. Each job card shows the next scheduled time, the type, and any execution stats. Click a job to see history and full payload.

The list hides system-internal jobs (`workflow_resume`, `sequence_step`) by default — those are scheduled by other engines. Tick the **Internal** checkbox to see them.

When a job doesn't fire when you expected:
1. Status `pending` and `scheduled_time` is in the past — the heartbeat will pick it up next tick (within ~5 minutes; soon to be 1 minute).
2. Status `pending` and `scheduled_time` is in the future — wait until then.
3. Status `failed` — open the job and see the latest result for the error.
4. For `recurring` jobs, also check `max_executions` and `expires_at` — once either limit is hit, the job is marked `completed` and won't run again.

---

## Technical reference

### Job types — two layers

There's a subtle naming overlap. The `scheduled_jobs.type` enum has **5 values**:

| Type | Description |
|---|---|
| `one_time` | Fires once at `scheduled_time`, then `completed` or `failed` |
| `recurring` | Fires on a cron schedule, reschedules itself |
| `workflow_resume` | Resumes a delayed workflow execution (system-created) |
| `sequence_step` | Fires the next step of a sequence (system-created) |
| `hook_retry` | Retries a failed hook target delivery (system-created) |

For `one_time` and `recurring` jobs, the *actual execution flavor* is stored in the `data` JSON column under `data.type`:

| `data.type` | What it does |
|---|---|
| `webhook` | HTTP request to any URL |
| `internal_function` | Calls a built-in function from `internal_functions.js` |
| `custom_code` | Runs a JS snippet in a sandboxed VM (5s timeout, no DB, no network) |
| `campaign_send` | Sends one campaign message to one contact (system-created via Campaign Manager) |
| `task_due_reminder` | Sends a single task due-date reminder (system-created via taskService) |
| `task_daily_digest` | Runs the morning task digest for one user (system-created) |

When you create a job via `POST /scheduled-jobs`, you pass the **scheduling type** as `type` and the **execution flavor** as `job_type` — the route translates `job_type` into `data.type` for you. (Confusingly, the API parameter name is `job_type` even though it ends up in `data.type` in the row.)

### Creating a job

#### One-time webhook in 10 minutes
```js
await apiSend("/scheduled-jobs", "POST", {
  type:     "one_time",
  job_type: "webhook",
  name:     "Notify Zapier",
  delay:    "10m",
  url:      "https://hooks.zapier.com/...",
  method:   "POST",
  body:     { contactId: 123, event: "intake_complete" }
});
```

#### One-time internal function at a specific time
```js
await apiSend("/scheduled-jobs", "POST", {
  type:           "one_time",
  job_type:       "internal_function",
  name:           "Appointment reminder SMS",
  scheduled_time: "2026-03-20T08:30:00Z",
  function_name:  "send_sms",
  params: {
    from:    "2485592400",
    to:      "3135551234",
    message: "Reminder: your appointment is today at 2pm."
  },
  max_attempts:    2,
  backoff_seconds: 30
});
```

#### Recurring — weekdays at 9am
```js
await apiSend("/scheduled-jobs", "POST", {
  type:            "recurring",
  job_type:        "webhook",
  name:            "Daily digest",
  scheduled_time:  "2026-03-17T09:00:00Z",
  recurrence_rule: "0 9 * * 1-5",
  url:             "https://internal.4lsg.com/digest",
  method:          "POST"
});
```

#### Recurring with limits
```js
await apiSend("/scheduled-jobs", "POST", {
  type:            "recurring",
  job_type:        "webhook",
  name:            "Daily appointment report",
  scheduled_time:  "2026-03-18T04:00:00Z",
  recurrence_rule: "0 4 * * 0,1,2,3,4,5",  // every day except Saturday
  max_executions:  10,                      // stop after 10 runs
  expires_at:      "2026-06-30T23:59:00Z",  // or stop at end of June
  url:             "https://app.4lsg.com/workflows/5/start",
  method:          "POST",
  headers:         { "x-api-key": "YOUR_INTERNAL_API_KEY" }
});
```

### Scheduling options

| Field | Description |
|---|---|
| `delay` | Duration from now: `"30s"`, `"10m"`, `"2h"`, `"1d"` |
| `scheduled_time` | ISO datetime — takes priority over `delay` |
| `timezone` | IANA TZ for `scheduled_time` if it lacks an offset (e.g. `America/Detroit`) |
| `recurrence_rule` | Cron expression (`recurring` only) |
| `max_executions` | Stop after N successful runs (`recurring` only, optional) |
| `expires_at` | Stop scheduling after this datetime (`recurring` only, optional) |

If neither `delay` nor `scheduled_time` is provided, the job fires in ~5 seconds.

**Common cron expressions:**

| Expression | Meaning |
|---|---|
| `0 9 * * 1-5` | 9:00am Monday–Friday |
| `0 */6 * * *` | Every 6 hours |
| `*/30 * * * *` | Every 30 minutes |
| `0 8 1 * *` | 8:00am on the 1st of every month |

### Execution limits (recurring only)

Two optional fields stop a recurring job automatically:

| Field | Type | Description |
|---|---|---|
| `max_executions` | integer | Stop after this many successful executions. NULL = no limit. |
| `expires_at` | datetime | Stop scheduling new runs after this datetime. NULL = no expiry. |

Both are checked **before** a job is claimed by `/process-jobs` (in the `WHERE` clause of the claim query). They're also re-checked during reschedule:
- If `execution_count >= max_executions` → mark `completed`, don't reschedule.
- If next computed `scheduled_time > expires_at` → mark `completed`, don't reschedule.

The job row stays in the table for audit. Both fields can also be set on existing jobs via `PATCH /scheduled-jobs/:id`.

### Retry & backoff

```
delay before attempt N = backoff_seconds × 2^(attempt - 1)
```

With `max_attempts: 3` and `backoff_seconds: 60`:

| Attempt | Wait before |
|---|---|
| 1 | — |
| 2 | 60s |
| 3 | 120s → if still failing: `failed` (one-time) or rescheduled to next occurrence (recurring) |

`one_time` jobs → status `failed` after `max_attempts`.
`recurring` jobs → still rescheduled for next occurrence even if all attempts on this cycle failed.

### Inspecting jobs

```
GET /scheduled-jobs                       list all (filterable)
    ?status=pending|running|completed|failed
    ?type=one_time|recurring|...   (use ?internal=true to include workflow_resume/sequence_step)
    ?search=<name fragment>
    ?page=<n>  ?limit=<n>           (default 30, max 100)

GET /scheduled-jobs/:id                   single job + stats + latest execution
GET /scheduled-jobs/:id?history=true      adds full attempt history from job_results

PATCH  /scheduled-jobs/:id                edit (only pending/failed)
DELETE /scheduled-jobs/:id                delete
```

The list endpoint hides `workflow_resume` and `sequence_step` by default. Pass `?internal=true` to include them.

### The job processor heartbeat

`POST /process-jobs` (accepts any method) is the heartbeat. Currently invoked every ~5 minutes by Cloud Scheduler. Each call:

1. Runs `recoverStuckJobs()` — resets `running` jobs >15 min old back to `pending`, resets `processing` workflow executions >15 min old back to `active`.
2. Atomically claims up to 10 pending jobs (`FOR UPDATE SKIP LOCKED`).
3. Marks each `running`.
4. For each job:
   - Special-case dispatch for `workflow_resume` / `sequence_step` / `hook_retry` (detached background executor — job stays `running` until the executor finishes).
   - All other types go through `executeJob()` synchronously.
5. Records results to `job_results`, reschedules recurring jobs, handles retries.

```json
// Response
{
  "processed": 3,
  "results": [
    { "id": 7,  "status": "completed" },
    { "id": 8,  "status": "retry_scheduled", "attempt": 1, "error": "..." },
    { "id": 9,  "status": "dispatched", "note": "Resuming execution 42 at step 4" }
  ]
}
```

Result statuses:
- `completed` — one-time job finished successfully
- `advanced` — recurring job ran successfully, rescheduled to next occurrence
- `retry_scheduled` — job failed, will retry; includes `attempt` and `error`
- `failed` — one-time job out of attempts, marked `failed`
- `advanced_after_failure` — recurring job out of attempts on this cycle, but still rescheduled to next occurrence
- `dispatched` — special-case (`workflow_resume`/`sequence_step`/`hook_retry`); the executor is running in the background and will mark the job `completed` or `failed` when done

### Internal job types — system use only

These are scheduled by other engines and you generally don't create them by hand:

| Type | Created by | Purpose |
|---|---|---|
| `workflow_resume` | `workflow_engine.js` (via `wait_for` / `schedule_resume`) | Resume a delayed workflow execution |
| `sequence_step` | `sequenceEngine.js` (via `scheduleStepJob`) | Fire the next step of a sequence enrollment |
| `hook_retry` | `hookService.js` (after a failed delivery) | Retry one failed hook target |
| `data.type='task_due_reminder'` | `taskService.scheduleDueReminder()` | Send email/SMS to assignee on task due date |
| `data.type='task_daily_digest'` | Seeded as recurring | Refresh task statuses + send digest emails per user schedule |
| `data.type='campaign_send'` | `campaignService.createCampaign()` | Send one campaign message to one contact |

These appear in `scheduled_jobs` and are processed by `/process-jobs` alongside everything else. The Scheduled Jobs UI hides `workflow_resume` and `sequence_step` by default.

### Idempotency

Some job creators use `idempotency_key` to prevent duplicates:
- Sequences: `seq-{enrollmentId}-step-{stepNumber}`
- Campaigns: `campaign:{campaignId}:{contactId}`

If a duplicate `(idempotency_key, status='pending'|'running')` is detected at insert time, the second insert is silently skipped.
