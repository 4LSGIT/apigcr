# Part 7 — Scheduled Jobs

The scheduled jobs system is a standalone job scheduler built into the 4LSG API. It can be used entirely independently of the workflow engine — you can schedule one-time or recurring jobs to call webhooks, run internal functions, or execute custom code, without any workflow involved.

The workflow engine itself uses scheduled jobs under the hood (for `workflow_resume` jobs), but that is invisible to you as a user of either system.

---

## Concepts

### Job Types (scheduling dimension)

| Type | Description |
|------|-------------|
| `one_time` | Runs once at the scheduled time, then marked `completed` or `failed` |
| `recurring` | Runs on a cron schedule — after each run, automatically rescheduled for the next occurrence |

### Job Types (execution dimension)

| `job_type` | What it does |
|------------|-------------|
| `webhook` | Makes an HTTP request to an external URL |
| `internal_function` | Runs a built-in function from `internal_functions.js` |
| `custom_code` | Executes a small JavaScript snippet in a sandbox |

These two dimensions are independent — a recurring job can be any of the three execution types.

---

## Creating a Job

### `POST /scheduled-jobs`

**Minimum viable body — webhook firing in 10 minutes:**
```json
{
  "type": "one_time",
  "job_type": "webhook",
  "delay": "10m",
  "url": "https://your-endpoint.com/hook",
  "method": "POST",
  "body": { "message": "Hello from the scheduler" }
}
```

**Full field reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✓ | `"one_time"` or `"recurring"` |
| `job_type` | ✓ | `"webhook"`, `"internal_function"`, or `"custom_code"` |
| `name` | — | Human-readable label. Defaults to `"{job_type} job"` |
| `delay` | — | Duration from now: `"30s"`, `"10m"`, `"2h"`, `"1d"` |
| `scheduled_time` | — | ISO datetime — takes priority over `delay` |
| `recurrence_rule` | recurring only | Cron expression (see below) |
| `max_attempts` | — | Max attempts per execution. Default `3` |
| `backoff_seconds` | — | Base for exponential backoff. Default `300` |

If neither `delay` nor `scheduled_time` is provided, the job runs in ~5 seconds.

**Returns:**
```json
{
  "id": 42,
  "message": "Job created",
  "scheduled_time": "2026-03-14T15:30:00.000Z",
  "type": "one_time",
  "job_type": "webhook"
}
```

---

## Scheduling Options

### Delay (from now)

```json
{ "delay": "30s" }   // 30 seconds from now
{ "delay": "10m" }   // 10 minutes
{ "delay": "2h" }    // 2 hours
{ "delay": "1d" }    // 1 day
```

### Exact datetime

```json
{ "scheduled_time": "2026-03-15T09:00:00Z" }
```

`scheduled_time` takes priority over `delay` if both are provided.

### Cron (recurring only)

```json
{
  "type": "recurring",
  "recurrence_rule": "0 9 * * 1-5"
}
```

Cron format: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | 9:00am Monday–Friday |
| `0 */6 * * *` | Every 6 hours |
| `*/30 * * * *` | Every 30 minutes |
| `0 8 1 * *` | 8:00am on the 1st of every month |
| `0 0 * * 0` | Midnight every Sunday |

> **Note:** Cron times are interpreted relative to `scheduled_time` — the engine uses that as the base for computing the next occurrence after each run. This means the first run happens at `scheduled_time`, and subsequent runs follow the cron from there.

---

## Job Types — Full Examples

### Webhook

Calls an external HTTP endpoint. Supports any method, custom headers, and a JSON body.

```json
{
  "type": "one_time",
  "job_type": "webhook",
  "name": "Notify Zapier",
  "delay": "5m",
  "url": "https://hooks.zapier.com/hooks/catch/abc/xyz/",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": { "contactId": 123, "event": "intake_complete" },
  "max_attempts": 3,
  "backoff_seconds": 60
}
```

The response must return HTTP 2xx — anything else is treated as a failure and triggers retry/backoff logic.

---

### Internal Function

Runs any function from `internal_functions.js`. Useful for scheduling communications, lookups, or data changes at a specific time without building a full workflow.

```json
{
  "type": "one_time",
  "job_type": "internal_function",
  "name": "Send appointment reminder SMS",
  "scheduled_time": "2026-03-15T08:30:00Z",
  "function_name": "send_sms",
  "params": {
    "from": "2485592400",
    "to": "3135551234",
    "message": "Reminder: your appointment is today at 2pm. Reply STOP to unsubscribe."
  },
  "max_attempts": 2,
  "backoff_seconds": 30
}
```

**Recurring internal function — daily morning digest:**
```json
{
  "type": "recurring",
  "job_type": "internal_function",
  "name": "Daily digest email",
  "scheduled_time": "2026-03-15T09:00:00Z",
  "recurrence_rule": "0 9 * * 1-5",
  "function_name": "send_email",
  "params": {
    "from": "stuart@4lsg.com",
    "to": "team@4lsg.com",
    "subject": "Daily digest",
    "text": "Good morning. Here is your daily summary."
  }
}
```

> **Available functions:** All functions in `internal_functions.js` are available. Note that functions requiring workflow variables (like `evaluate_condition` which needs `_variables`) are less useful here since there is no variable system in standalone jobs — params are static at creation time.

---

### Custom Code

Runs a JavaScript snippet in a sandboxed VM. Useful for one-off transformations or logic that doesn't fit a function.

```json
{
  "type": "one_time",
  "job_type": "custom_code",
  "name": "Compute something",
  "delay": "1m",
  "code": "const result = input.values.reduce((a, b) => a + b, 0); result;",
  "input": { "values": [1, 2, 3, 4, 5] }
}
```

- `input` is available inside the sandbox as the `input` variable
- `console.log` works and outputs to the server log with the job ID
- Execution is limited to **5 seconds** — longer code will time out
- No network access, no `require` — purely computational

---

## Retry & Backoff

Standalone jobs use the same exponential backoff as workflow steps:

```
Delay before attempt N = backoff_seconds × 2^(attempt - 1)
```

With `max_attempts: 3` and `backoff_seconds: 60`:

| Attempt | Wait before |
|---------|-------------|
| 1 | — (immediate) |
| 2 | 60s |
| 3 | 120s → final |

After `max_attempts` failures:
- `one_time` jobs → status set to `failed`
- `recurring` jobs → still rescheduled for the next occurrence (the individual execution is marked failed but the job continues)

---

## Job Statuses

| Status | Meaning |
|--------|---------|
| `pending` | Waiting to be picked up by the job processor |
| `running` | Currently being executed |
| `completed` | Ran successfully |
| `failed` | Exhausted all attempts without success |

Recurring jobs cycle between `pending` → `running` → `pending` indefinitely (the `execution_count` and `scheduled_time` are updated after each run).

---

## Inspecting Jobs

### `GET /scheduled-jobs/:id`

Returns full job metadata, execution stats, and the latest result.

```json
{
  "id": 42,
  "name": "Send appointment reminder SMS",
  "type": "one_time",
  "status": "completed",
  "scheduled_time": "2026-03-15T08:30:00.000Z",
  "recurrence_rule": null,
  "attempts": 1,
  "max_attempts": 2,
  "backoff_seconds": 30,
  "execution_count": 1,
  "data": {
    "type": "internal_function",
    "function_name": "send_sms",
    "params": { "from": "2485592400", "to": "3135551234", "message": "..." }
  },
  "stats": {
    "total_runs": 1,
    "total_failures": 0
  },
  "latest_execution": {
    "execution_number": 1,
    "attempt": 1,
    "status": "success",
    "output_data": { ... },
    "duration_ms": 312
  }
}
```

### With full history

```
GET /scheduled-jobs/42?history=true
```

Adds a `history` array — every execution attempt in descending order, including failed retries with their error messages and durations.

---

## How It Differs From Workflow Steps

Scheduled jobs and workflow steps both execute the same underlying job types (webhook, internal_function, custom_code) but they serve different purposes:

| | Scheduled Job | Workflow Step |
|--|---------------|---------------|
| **Variable system** | ❌ None — params are static | ✓ Full `{{variable}}` templating |
| **Chaining** | ❌ Single action | ✓ Steps flow into each other |
| **Delays** | ✓ Via `delay` / `scheduled_time` | ✓ Via `wait_for` / `schedule_resume` |
| **Recurring** | ✓ Via cron | ❌ Not applicable |
| **Branching** | ❌ | ✓ Via `evaluate_condition` / `set_next` |
| **Result capture** | In `job_results` table | In `workflow_execution_steps` table |
| **Best for** | Time-based triggers, recurring tasks | Multi-step processes with data flow |

**Rule of thumb:** If it's a single action that needs to happen at a specific time or on a schedule, use a scheduled job. If it's a sequence of actions that depend on each other or share data, use a workflow.

---

## Common Patterns

### Appointment reminder (one-time, scheduled at booking time)

```js
await apiSend("/scheduled-jobs", "POST", {
  type: "one_time",
  job_type: "internal_function",
  name: `Reminder SMS — appt ${apptId}`,
  scheduled_time: reminderTime.toISOString(),  // e.g. 1 hour before appt
  function_name: "send_sms",
  params: {
    from: "2485592400",
    to: contactPhone,
    message: `Reminder: your appointment is at ${apptTimeFormatted}. Reply STOP to opt out.`
  },
  max_attempts: 2,
  backoff_seconds: 30
});
```

### Daily recurring webhook ping

```json
{
  "type": "recurring",
  "job_type": "webhook",
  "name": "Daily CRM sync",
  "scheduled_time": "2026-03-15T06:00:00Z",
  "recurrence_rule": "0 6 * * *",
  "url": "https://internal.4lsg.com/sync/crm",
  "method": "POST",
  "max_attempts": 3,
  "backoff_seconds": 120
}
```

### Health check every 30 minutes

```json
{
  "type": "recurring",
  "job_type": "webhook",
  "name": "Health check",
  "delay": "30m",
  "recurrence_rule": "*/30 * * * *",
  "url": "https://your-api.com/health",
  "method": "GET",
  "max_attempts": 1,
  "backoff_seconds": 0
}
```
