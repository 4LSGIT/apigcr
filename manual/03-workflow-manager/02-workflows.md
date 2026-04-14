# Part 2 — Workflow Engine

Workflows are multi-step automated processes where data flows between steps. They support branching, delays, variable storage, and a full step-by-step execution history.

---

## Core Concepts

**Workflow template** — the definition. Stored in `workflows` and `workflow_steps`. Reusable — you can start the same workflow many times with different init data.

**Execution** — one run of a workflow. Stored in `workflow_executions`. Each execution has its own variable store and step history.

**Variables** — key/value pairs that persist across all steps of an execution. Set from `init_data` at start, updated by steps via `set_vars`.

**Steps** — individual actions. Three types: `webhook`, `internal_function`, `custom_code`. Each step can read variables via `{{placeholders}}`, write new variables via `set_vars`, and control what happens next via `next_step`.

---

## Starting a Workflow

```js
await apiSend("/workflows/1/start", "POST", {
  contactId:    123,
  contactName:  "Fred Smith",
  source:       "web"
});
```

Everything in the body becomes a workflow variable. The workflow starts immediately in the background and the API responds with `{ executionId, status: "processing" }`.

---

## Execution Lifecycle

```
POST /workflows/:id/start
        │
        ▼
  Create execution (status: active, current_step: 1)
  Respond immediately with executionId
        │
        ▼ (background)
  advanceWorkflow()
        │
        ├── Phase 1: FOR UPDATE lock → mark 'processing' → commit
        │
        └── Phase 2: Step loop (up to 20 steps per invocation)
              │
              ├─ load step → resolve placeholders → execute
              ├─ merge set_vars into variables
              ├─ record step result
              │
              ├─ delayed_until set? → schedule workflow_resume job → status: 'delayed'
              ├─ 20 steps reached? → schedule self-continue → status: 'active'
              └─ no more steps? → markCompleted → status: 'completed'
```

### Execution Statuses

| Status | Meaning |
|--------|---------|
| `active` | Running or ready to run |
| `processing` | Being advanced right now (soft lock) |
| `delayed` | Waiting for a resume job to fire |
| `completed` | All steps finished, none failed |
| `completed_with_errors` | Finished, but one or more steps failed with `ignore` policy |
| `failed` | Stopped by `abort` / `retry_then_abort` policy |
| `cancelled` | Manually cancelled |

---

## Step Types

### Webhook
Calls an external HTTP endpoint.
```json
{
  "url": "https://hooks.zapier.com/...",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": { "contactId": "{{contactId}}", "event": "intake_complete" },
  "set_vars": { "zapierResult": "{{this.[0].id}}" }
}
```

### Internal Function
Runs a built-in function. See [05-internal-functions.md](05-internal-functions.md) for the full list.
```json
{
  "function_name": "send_sms",
  "params": {
    "from": "2485592400",
    "to": "{{contact_phone}}",
    "message": "Hi {{contact_fname}}, your appointment is confirmed."
  }
}
```

### Custom Code
Runs a JS snippet in a sandboxed VM. No network access. 5-second timeout.
```json
{
  "code": "const total = input.values.reduce((a, b) => a + b, 0); total;",
  "input": { "values": [1, 2, 3] }
}
```

---

## Control Flow

### Branching — `evaluate_condition`
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

### Jumping — `set_next`
```json
{
  "function_name": "set_next",
  "params": { "value": 8 }
}
```
`value` can be a step number, `null` (end normally), `"cancel"` (mark cancelled), or `"fail"` (mark failed).

### Delays — `wait_for`
```json
{
  "function_name": "wait_for",
  "params": { "duration": "24h", "nextStep": 5 }
}
```
Pauses the execution. A `workflow_resume` scheduled job fires when the time comes and resumes from `nextStep`.

---

## Recovery

`/process-jobs` runs `recoverStuckJobs()` on every call, which:
- Resets `scheduled_jobs` stuck in `running` > 10 min back to `pending`
- Resets `workflow_executions` stuck in `processing` > 10 min back to `active`

This handles server crashes mid-execution cleanly.

---

## Monitoring

```
GET /executions                    list all (filterable by status, workflow_id, search)
GET /executions/:id                current state + variables
GET /executions/:id?history=true   full step-by-step history
GET /workflows/:id/executions      all executions for one workflow
POST /executions/:id/cancel        emergency cancel
```
