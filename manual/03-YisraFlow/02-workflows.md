# 2 — Workflow Engine

## For operators

A **workflow** is a multi-step recipe. Step 1 happens, then step 2, then maybe step 5 if step 3 says so, then a 24-hour wait, then step 6. Each step can read from the previous one. Each step can be a webhook call, a built-in action (send SMS, create task, look up contact), or a snippet of custom code.

You'd reach for a workflow when:
- You need branching: "if 341 meeting, do A; otherwise do B."
- You need a delay in the middle: "send the reminder, then wait 24h, then check if they confirmed."
- You need to pass data between steps: "look up the contact, then use their email in the next step."

You wouldn't reach for one when a simple sequence (drip with auto-cancel) or a one-time scheduled job would do.

**In `automationManager.html` → Workflows tab**, you'll see the list of workflow templates on the left. Click one to see its steps. Each step is a row with a type (`webhook`, `internal_function`, `custom_code`), a config, and an error policy. Edit, save, test from the Test tab against sample input.

A **workflow execution** is one specific *run* of a workflow. The template is the recipe; the execution is the meal you cooked. Each execution has its own variable store, its own step history, and its own status (`active`, `delayed`, `completed`, `failed`, etc.).

When something goes wrong:
- Look at the execution's history: which step failed, what was the error?
- Check the variables: was the data what you expected?
- If a step is in `delayed`, look in **Scheduled Jobs** for the `workflow_resume` job that's queued.

---

## Technical reference

### Core concepts

**Workflow template** — the definition. Stored in `workflows` and `workflow_steps`. Reusable — you can start the same workflow many times with different `init_data`.

**Execution** — one run. Stored in `workflow_executions`. Each execution has its own variable store and step history.

**Variables** — key/value pairs in `workflow_executions.variables`. Set from `init_data` at start, updated by steps via `set_vars` written into the step's config.

**Steps** — individual actions. Stored in `workflow_steps`. Three types: `webhook`, `internal_function`, `custom_code`. Each step can read variables via `{{placeholders}}`, write new ones via `set_vars`, and control what happens next via `next_step` (set by `set_next` / `evaluate_condition` / `wait_for` / `schedule_resume`).

### Starting a workflow

`POST /workflows/:id/start` accepts two body shapes.

**Wrapped (recommended for new code):**
```json
{
  "init_data": { "contactId": 123, "source": "web_form" },
  "contact_id": 123
}
```
- `init_data` becomes the execution's initial variables.
- `contact_id` at the top level is an **explicit override** for `workflow_executions.contact_id` and only works on wrapped bodies (see *Contact-tying* below).

**Flat (legacy / convenience):**
```json
{ "contactId": 123, "contactName": "Fred Smith", "source": "web_form" }
```
The entire body becomes `init_data`. Flat bodies cannot pass an explicit `contact_id` — extracting it from a flat body would silently strip it from `init_data` for callers that already use `contact_id` as a regular variable name.

**Response: 202 Accepted**
```json
{
  "success": true,
  "executionId": 1234,
  "workflowId": 1,
  "contactId": 123,
  "status": "processing",
  "message": "Workflow execution started and is now processing"
}
```

Background `advanceWorkflow()` runs immediately after the response is sent.

### Execution lifecycle

```
POST /workflows/:id/start
        │
        ▼
  Resolve contact_id (explicit override → template default → NULL)
  INSERT execution (status='active', current_step_number=1, variables=init_data)
  Commit, respond 202 with executionId
        │
        ▼ (background)
  advanceWorkflow(executionId)
        │
        ├─ PHASE 1: SELECT … FOR UPDATE → mark 'processing' → commit
        │           (soft lock — recoverStuckJobs unsticks if we crash)
        │
        └─ PHASE 2: Step loop, up to 20 steps per invocation
              │
              ├─ load step → resolve placeholders → execute
              ├─ merge set_vars into variables
              ├─ insert workflow_execution_steps row (success or failed)
              │
              ├─ delayed_until set?
              │     → schedule workflow_resume job → status='delayed' → return
              │
              ├─ 20 steps reached?
              │     → schedule self-continue → status='active' → return
              │
              └─ no more steps?
                    → markCompleted → status='completed' (or 'completed_with_errors'
                      if any step failed under 'ignore' policy)
```

### Execution statuses

| Status | Meaning |
|---|---|
| `pending` | Created but not yet picked up (rare; the start route immediately fires advanceWorkflow) |
| `active` | Running or ready to run (the next tick picks it up) |
| `processing` | Being advanced right now (soft lock; reset by `recoverStuckJobs` after 15 min) |
| `delayed` | Waiting for a `workflow_resume` scheduled job to fire |
| `completed` | All steps finished, none failed |
| `completed_with_errors` | Finished, but one or more steps failed with `ignore` policy |
| `failed` | Stopped by `abort` / `retry_then_abort` policy, or top-level `advanceWorkflow` exception |
| `cancelled` | Cancelled via `POST /executions/:id/cancel` (requires non-empty `cancel_reason`) |

### Step types

#### `webhook`
HTTP request to any URL. Response body becomes `{{this}}` for `set_vars`.

```json
{
  "url": "https://hooks.zapier.com/...",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": { "contactId": "{{contactId}}", "event": "intake_complete" },
  "set_vars": { "zapierResult": "{{this.[0].id}}" }
}
```

#### `internal_function`
Runs a built-in function. See [05-internal-functions.md](05-internal-functions.md) for the full list.

```json
{
  "function_name": "send_sms",
  "params": {
    "from": "2485592400",
    "to": "{{contact_phone}}",
    "message": "Hi {{contact_fname}}, your appointment is confirmed."
  },
  "set_vars": { "smsId": "{{this.output.id}}" }
}
```

#### `custom_code`
JS snippet in a sandboxed VM. **No network access. No DB access. 5-second timeout. No retry safety.** The "nuclear option" — prefer extending `internal_functions.js` instead, but it's there for one-off data shaping.

```json
{
  "code": "const total = input.values.reduce((a, b) => a + b, 0); total;",
  "input": { "values": [1, 2, 3] }
}
```

The last expression evaluated is returned as `{{this}}`.

### Control flow

#### Branching — `evaluate_condition`
```json
{
  "function_name": "evaluate_condition",
  "params": {
    "variable": "appt_status",
    "operator": "==",
    "value":    "confirmed",
    "then":     5,
    "else":     8
  }
}
```

Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `not_contains`, `is_empty`, `is_not_empty`.

Extended form (multiple conditions):
```json
{
  "function_name": "evaluate_condition",
  "params": {
    "conditions": [
      { "variable": "appt_status",  "operator": "==", "value": "confirmed" },
      { "variable": "contact_type", "operator": "!=", "value": "vip" }
    ],
    "match": "all",
    "then":  5,
    "else":  8
  }
}
```

Workflow-only — sequences don't support `evaluate_condition`.

#### Jumping — `set_next`
```json
{ "function_name": "set_next", "params": { "value": 8 } }
```

`value` accepts:
- A step number (positive integer) → jump to that step
- `null` → end the workflow normally (status `completed`)
- `"cancel"` → mark the execution `cancelled`
- `"fail"` → mark the execution `failed`

Workflow-only.

#### Delays — `wait_for` / `schedule_resume`
```json
{ "function_name": "wait_for", "params": { "duration": "24h", "nextStep": 5 } }
```

Pauses the execution. A `workflow_resume` scheduled job is queued for the right time, the execution status becomes `delayed`, and the next call to `/process-jobs` after that time will resume from `nextStep`.

`schedule_resume` is the same thing with `resumeAt` instead of `duration` (accepts an ISO datetime, a duration string, or a milliseconds number). `wait_for` is a thin wrapper.

Workflow-only.

#### Time-of-day delays — `wait_until_time`
```json
{ "function_name": "wait_until_time", "params": { "time": "09:00", "timezone": "America/Detroit", "nextStep": 6 } }
```

Resume at the next occurrence of the given time.

### Contact-tying a workflow execution

A workflow execution can optionally be tied to a contact via `workflow_executions.contact_id`. Contact-tied executions show up on the contact's Automations tab in `contact2.html`; untied ones don't appear on any contact page (this is the historical default).

**Two ways to set `contact_id`:**

1. **Template-level default.** Set `workflows.default_contact_id_from` to the name of an `init_data` key:
   ```sql
   UPDATE workflows
      SET default_contact_id_from = 'contact_id'
    WHERE id = 5;
   ```
   On every start, the engine reads `init_data['contact_id']`. If it's a positive integer, it stamps it; otherwise NULL.

2. **Execution-level override** (wrapped body only):
   ```json
   {
     "init_data": { "campaignId": 42, "message": "..." },
     "contact_id": 123
   }
   ```
   The explicit `contact_id` wins over the template default for this one execution.

**Precedence:** explicit body `contact_id` > template default > NULL.

**NULL is legitimate.** Workflows that operate on a case, a campaign, or nothing in particular leave `contact_id` NULL. The Automations tab simply doesn't surface them, which is the intended behaviour.

### Recovery

`/process-jobs` runs `recoverStuckJobs()` on every call:
- Resets `scheduled_jobs.status='running'` rows older than 15 min back to `pending`
- Resets `workflow_executions.status='processing'` rows older than 15 min back to `active`

This handles container crashes mid-execution. The trade-off is that a job that legitimately runs longer than 15 minutes will be re-claimed and double-executed; the worst-case for current job types is ~5 min (a batch of 10 ~30s jobs sequentially), so 15 min is ~3× safety margin. If you add a job type that can legitimately run longer, either shorten its batches or implement a heartbeat that refreshes `updated_at` periodically.

### Retry semantics

Workflow steps retry within `advanceWorkflow` itself based on the step's `error_policy` (see [08-error-policies.md](08-error-policies.md)). Retries happen synchronously inside the step loop — a step with `max_retries: 3` and `backoff_seconds: 60` ties up the invocation for up to 3+ minutes. Keep retry counts and backoffs reasonable.

### Monitoring

```
GET  /workflows                         list templates
GET  /workflows/:id                     template + steps
GET  /workflows/:id/executions          executions for one workflow
GET  /executions                        list all executions (filterable by status, workflow_id, search)
GET  /executions/:id                    current state + variables
GET  /executions/:id?history=true       full step-by-step history
POST /executions/:id/cancel             emergency cancel; requires { cancel_reason } (≥3 chars)
```

For contact-tied executions, also:
```
GET /api/contacts/:id/workflows         executions tied to one contact
                                        ?scope=active (default) | all
                                        ?status=<enum>          (overrides scope)
                                        ?limit, ?offset
```
