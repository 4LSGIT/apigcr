# Part 4 — Scheduled Job Scheduler

The scheduled job scheduler fires single actions at a specific time or on a recurring schedule. It has no contact context, no chaining, no condition checks — it is pure fire-and-forget scheduling.

---

## When to Use It

- Recurring tasks: daily digest email, CRM sync every 6 hours, health check ping
- One-time future actions not tied to a contact: webhook to an external system, cleanup job
- Appointment reminders when you just need a simple SMS at a fixed time (use sequences if you need condition gates)

If you need chaining, data flow, or conditions — use a workflow or sequence instead.

---

## Job Types (scheduling)

| Type | Description |
|------|-------------|
| `one_time` | Fires once, then `completed` or `failed` |
| `recurring` | Fires on a cron schedule, reschedules itself after each run |

## Job Types (execution)

| `job_type` | What it does |
|------------|-------------|
| `webhook` | HTTP request to any URL |
| `internal_function` | Runs a built-in function |
| `custom_code` | Runs a JS snippet in a sandbox |

---

## Creating a Job

### One-time webhook in 10 minutes
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

### One-time internal function at a specific time
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

### Recurring — weekdays at 9am
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

### Recurring with limits
```js
await apiSend("/scheduled-jobs", "POST", {
  type:            "recurring",
  job_type:        "webhook",
  name:            "Daily appointment report",
  scheduled_time:  "2026-03-18T04:00:00Z",
  recurrence_rule: "0 4 * * 0,1,2,3,4,5",  // every day except Saturday
  max_executions:  10,                        // stop after 10 runs
  expires_at:      "2026-06-30T23:59:00Z",   // or stop at end of June
  url:             "https://app.4lsg.com/workflows/5/start",
  method:          "POST",
  headers:         { "x-api-key": "YOUR_INTERNAL_API_KEY" }
});
```

---

## Scheduling Options

| Field | Description |
|-------|-------------|
| `delay` | Duration from now: `"30s"`, `"10m"`, `"2h"`, `"1d"` |
| `scheduled_time` | ISO datetime — takes priority over `delay` |
| `recurrence_rule` | Cron expression (recurring only) |
| `max_executions` | Stop after N successful runs (recurring only, optional) |
| `expires_at` | ISO datetime — stop scheduling after this date (recurring only, optional) |

If neither `delay` nor `scheduled_time` is provided, the job fires in ~5 seconds.

**Common cron expressions:**

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | 9:00am Monday–Friday |
| `0 */6 * * *` | Every 6 hours |
| `*/30 * * * *` | Every 30 minutes |
| `0 8 1 * *` | 8:00am on the 1st of every month |

---

## Execution Limits (Recurring Jobs)

Two optional fields control when a recurring job stops running automatically:

| Field | Type | Description |
|-------|------|-------------|
| `max_executions` | integer | Stop after this many successful executions. `null` = no limit. |
| `expires_at` | ISO datetime | Stop scheduling new runs after this datetime. `null` = no expiry. |

Both are checked **before** a job is claimed by `/process-jobs`:
- If `execution_count >= max_executions` → job is skipped and never picked up again
- If `expires_at <= NOW()` → same

When a recurring job hits its limit during rescheduling, it is marked `completed` rather than being rescheduled. The job row stays in the table for audit purposes.

Both fields can also be set on existing jobs via `PATCH /scheduled-jobs/:id`.

---

## Retry & Backoff

```
Delay before attempt N = backoff_seconds × 2^(attempt - 1)
```

With `max_attempts: 3` and `backoff_seconds: 60`:

| Attempt | Wait before |
|---------|-------------|
| 1 | — |
| 2 | 60s |
| 3 | 120s → final |

`one_time` jobs → `failed` after max attempts. `recurring` jobs → still rescheduled for next occurrence.

---

## Inspecting Jobs

```
GET /scheduled-jobs/:id
GET /scheduled-jobs/:id?history=true
```

Returns metadata, execution stats, latest result, and optionally the full attempt history with error messages and durations.

---

## Internal Job Types (system use)

The scheduler also handles internal job types that you should not create manually:

| Type | Created by | Purpose |
|------|-----------|---------|
| `workflow_resume` | `workflow_engine.js` | Resume a delayed workflow execution |
| `sequence_step` | `sequenceEngine.js` | Fire the next step of an enrollment |
| `task_due_reminder` | `taskService.scheduleDueReminder()` | Send email/SMS to assignee on task due date |
| `task_daily_digest` | Seeded as recurring job | Refresh task statuses + send digest emails per user schedule |
| `hook_retry` | `hookService.js` | Retry a failed webhook delivery target |
| `campaign_send` | `campaignService.createCampaign()` | Send one campaign message to one contact |

These appear in `scheduled_jobs` and are processed by `/process-jobs` alongside regular jobs. The jobs list API hides `workflow_resume` and `sequence_step` by default — pass `?internal=true` to include them.

---

## The Job Processor

`POST /process-jobs` (accepts any method) is the heartbeat. Call it every ~30 seconds via cron or an external trigger.

Each call:
1. Runs `recoverStuckJobs()` — resets stuck `running` jobs and stuck `processing` executions
2. Claims up to 10 pending jobs atomically (`FOR UPDATE SKIP LOCKED`)
3. Executes each job
4. Records results, reschedules recurring jobs, handles retries

```json
// Response
{
  "processed": 3,
  "results": [
    { "id": 7,  "status": "completed" },
    { "id": 8,  "status": "retry_scheduled", "attempt": 1, "error": "..." },
    { "id": 9,  "status": "completed", "note": "Resumed execution 42 at step 4" }
  ]
}
```