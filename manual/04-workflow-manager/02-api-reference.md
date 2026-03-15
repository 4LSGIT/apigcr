# Part 2 — API Reference

All endpoints require authentication via JWT or API key (`jwtOrApiKey` middleware).

---

## Workflows

### `POST /workflows`
Create a new empty workflow.

**Body:**
```json
{ "name": "My Workflow", "description": "Optional description" }
```

**Returns:** `{ workflowId, name, description }`

---

### `POST /workflows/bulk`
Create a workflow and all its steps in a single transaction. Preferred for setup.

**Body:**
```json
{
  "name": "Contact Intake Sequence",
  "description": "...",
  "steps": [
    {
      "stepNumber": 1,
      "type": "internal_function",
      "config": { "function_name": "lookup_contact", "params": { "contact_id": "{{contactId}}" } },
      "error_policy": { "strategy": "abort" }
    },
    {
      "stepNumber": 2,
      "type": "webhook",
      "config": { "url": "https://...", "method": "POST", "body": { "name": "{{contact_fname}}" } }
    }
  ]
}
```

`stepNumber` is optional — defaults to position in array (1-based). Must be unique within the workflow.
`error_policy` is optional — defaults to `{ strategy: "ignore" }`.

**Returns:** `{ workflowId, name, stepCount }`

**Validation errors return 400.** Server errors return 500.

---

### `GET /workflows`
List all workflow templates.

**Query params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `limit` | number | 20 | Max 100 |
| `search` | string | — | Filter by name or description |
| `sort` | string | `created_at:desc` | `name:asc`, `name:desc`, `created_at:asc`, `created_at:desc` |

**Returns:** `{ workflows: [...], pagination: { page, limit, total, totalPages, hasNext, hasPrev } }`

---

### `GET /workflows/:id`
Get a single workflow with its steps.

**Query params:**
| Param | Default | Description |
|-------|---------|-------------|
| `includeSteps` | `true` | Set to `false` to skip step list |

**Returns:** `{ workflow: { id, name, description, step_count, ... }, steps: [...] }`

---

### `PUT /workflows/:id`
Update workflow name and/or description. Partial updates supported.

**Body:** `{ "name": "New Name" }` or `{ "description": "..." }` or both.

---

### `DELETE /workflows/:id`
Delete a workflow and all its steps. Existing execution records are preserved for history.

---

### `POST /workflows/:id/duplicate`
Duplicate a workflow and all its steps.

**Body (optional):** `{ "name": "Copy of My Workflow" }` — defaults to `"Copy of <original name>"`.

**Returns:** `{ newWorkflowId, newName, stepCount }`

---

### `POST /workflows/:id/start`
Start a new execution of a workflow.

**Body:** Any JSON object — all fields become workflow variables available as `{{key}}` in every step.

```js
await apiSend("/workflows/1/start", "POST", {
  contactId: 123,
  source: "web"
});
```

**Returns immediately** with `{ executionId, workflowId, status: "processing" }`. The workflow advances in the background.

---

## Workflow Steps

### `POST /workflows/:id/steps`
Add a single step. If `stepNumber` is provided and already exists, existing steps shift up.

**Body:**
```json
{
  "stepNumber": 3,
  "type": "internal_function",
  "config": { ... },
  "error_policy": { ... }
}
```

---

### `PUT /workflows/:id/steps/:stepNumber`
Fully replace a step (type + config + error_policy).

---

### `PATCH /workflows/:id/steps/:stepNumber`
Partially update a step. Only send the fields you want to change.

```json
{ "error_policy": { "strategy": "retry_then_abort", "max_retries": 3 } }
```

---

### `DELETE /workflows/:id/steps/:stepNumber`
Delete a step and renumber all subsequent steps down by 1.

---

### `PATCH /workflows/:id/steps/reorder`
Reorder steps. Two formats:

**Simple move** (move one step to a new position, others shift automatically):
```json
{ "fromStep": 5, "toStep": 2 }
```

**Full reorder** (provide the complete new order — must include every existing step number):
```json
{ "order": [3, 1, 4, 2, 5] }
```

---

## Executions

### `GET /executions`
List all executions across all workflows.

**Query params:**
| Param | Description |
|-------|-------------|
| `status` | Filter by status (`active`, `delayed`, `completed`, `failed`, etc.) |
| `workflow_id` | Filter by workflow |
| `search` | Search by workflow name or variable content |
| `page` / `limit` | Pagination |

---

### `GET /executions/:id`
Get a single execution's current state.

**Query params:**
| Param | Default | Description |
|-------|---------|-------------|
| `history` | `false` | Include full step-by-step history |

**Returns:**
```json
{
  "execution": {
    "id": 42,
    "workflow_id": 1,
    "workflow_name": "Contact Intake Sequence",
    "status": "delayed",
    "current_step_number": 4,
    "steps_executed_count": 3,
    "variables": { "contactId": 123, "contact_email": "fred@example.com" },
    "created_at": "...",
    "completed_at": null
  },
  "history": [ ... ]   // if ?history=true
}
```

---

### `GET /workflows/:id/executions`
List all executions for a specific workflow.

**Query params:** `page`, `limit`, `status`, `sort` (`created_at:asc` or `created_at:desc`)

**Returns** each execution with a `status_summary` field:
- `completed` — finished with no failed steps
- `completed_with_errors` — finished but one or more steps failed (with `ignore` policy)
- For non-completed executions: mirrors the `status` field directly

---

### `POST /executions/:id/cancel`
Cancel an active, delayed, or processing execution. Also deletes any pending resume jobs for that execution.

Only works if execution is in `active`, `delayed`, or `processing` status.

---

## Scheduled Jobs

### `POST /scheduled-jobs`
Create a standalone scheduled job (independent of workflows).

**Body:**
```json
{
  "type": "one_time",
  "job_type": "webhook",
  "name": "My job",
  "delay": "10m",
  "url": "https://...",
  "method": "POST",
  "body": { "key": "value" },
  "max_attempts": 3,
  "backoff_seconds": 300
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✓ | `one_time` or `recurring` |
| `job_type` | ✓ | `webhook`, `internal_function`, or `custom_code` |
| `delay` | — | Duration from now: `"10m"`, `"2h"`, `"1d"` |
| `scheduled_time` | — | ISO datetime — takes priority over `delay` |
| `recurrence_rule` | recurring only | Cron expression |
| `max_attempts` | — | Default 3 |
| `backoff_seconds` | — | Default 300 |

If neither `delay` nor `scheduled_time` is provided, the job runs in ~5 seconds.

---

### `GET /scheduled-jobs/:id`
Get a job's metadata, stats, and latest execution result.

**Query params:**
| Param | Default | Description |
|-------|---------|-------------|
| `history` | `false` | Include full execution history |

---

## Job Processor

### `POST /process-jobs` (or `GET`)
Claim and execute a batch of pending scheduled jobs. Should be called on a polling interval (e.g. every 30 seconds via cron or external trigger).

- Claims up to 10 jobs atomically using `FOR UPDATE SKIP LOCKED`
- Runs each job, records results, reschedules recurring jobs
- Handles `workflow_resume` jobs (resumes delayed executions)
- Automatically recovers stuck `running` jobs older than 10 minutes
- Automatically recovers stuck `processing` workflow executions older than 10 minutes

**Returns:**
```json
{
  "processed": 3,
  "results": [
    { "id": 7, "status": "completed" },
    { "id": 8, "status": "retry_scheduled", "attempt": 1, "error": "..." },
    { "id": 9, "status": "completed", "note": "Resumed execution 42 at step 4" }
  ]
}
```

**Job result statuses:**
| Status | Meaning |
|--------|---------|
| `completed` | Job succeeded |
| `advanced` | Recurring job succeeded and rescheduled |
| `retry_scheduled` | Failed, will retry |
| `failed` | Failed, no more retries |
| `advanced_after_failure` | Recurring job failed but still rescheduled |
