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
## Contact-tying a workflow (optional)

A workflow execution can optionally be tied to a contact via the `workflow_executions.contact_id` column. Contact-tied executions show up on the contact's Automations tab in `contact2.html`; untied executions don't appear on any contact page (this is the default and historical behaviour).

There are two ways to set `contact_id` on a new execution:

### 1. Template-level default

Set `workflows.default_contact_id_from` to an init_data key name:

```sql
UPDATE workflows
   SET default_contact_id_from = 'contact_id'
 WHERE id = 5;  -- your workflow id
```

From then on, every start of that workflow reads `init_data['contact_id']`. If it's a positive integer, the engine stamps it onto the new `workflow_executions.contact_id`. Non-integer / missing values fall through to NULL silently — the template author owns the type contract for the init_data key they picked.

This is the right default for workflows that are *conceptually* per-contact (appt reminders, onboarding drips, intake follow-ups). Once set, every caller — the `/start` route, hook → workflow targets, direct-INSERT code paths that update to use the new INSERT shape — produces contact-tied executions automatically.

### 2. Execution-level override

On `POST /workflows/:id/start`, callers can pass a top-level `contact_id` in a **wrapped** body:

```json
{
  "init_data": { "campaignId": 42, "message": "..." },
  "contact_id": 123
}
```

Precedence: this explicit `contact_id` wins over the template default for this one execution.

**Only wrapped bodies count.** The start route also accepts flat-body payloads (`{ anyField: value }`) where the entire body is treated as init_data — those have existed since before Part B. Extracting `contact_id` from flat bodies would silently strip it from init_data for legacy callers, so the override is wrapped-only. Flat callers can still contact-tie via the template default.

### NULL is the legitimate default

Not every workflow is contact-tied. Workflows that operate on a case, a campaign, or nothing in particular leave `contact_id` NULL — and that's correct. The Automations tab simply doesn't surface them, which is the intended behaviour.

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
