# Part 6 — Execution Lifecycle

This section covers how an execution moves through its lifecycle from start to finish, including delays, the job processor, and recovery from failures.

---

## Execution Statuses

| Status | Meaning |
|--------|---------|
| `active` | Running or ready to run |
| `processing` | Currently being advanced by the engine (soft lock) |
| `delayed` | Paused — waiting for a `workflow_resume` scheduled job to fire |
| `completed` | Finished successfully, no failed steps |
| `completed_with_errors` | Finished, but one or more steps failed with `ignore` policy |
| `failed` | Stopped due to `abort` or `retry_then_abort` policy |
| `cancelled` | Manually cancelled via `POST /executions/:id/cancel` |

---

## Phase 1 — Start

When `POST /workflows/:id/start` is called:

1. A `workflow_executions` row is created with `status = 'active'`, `current_step_number = 1`, and all init data stored in `variables`.
2. The API responds immediately with `{ executionId, status: "processing" }`.
3. `advanceWorkflow` is called in the background (fire-and-forget).

---

## Phase 2 — Advancing

`advanceWorkflow` uses a **two-phase locking** pattern:

**Phase 1 (claim):**
- Opens a transaction
- `SELECT ... FOR UPDATE` on the execution row — blocks any concurrent attempt on the same row
- If status is not `active` or `delayed`, returns `skipped` immediately
- Sets status to `processing` and commits — releases the lock but marks the row as in-progress

**Phase 2 (execute):**
- No lock held — long-running steps are safe
- Loops through steps up to `MAX_STEPS_PER_INVOCATION = 20`
- For each step: loads config, resolves placeholders, executes, records result, merges variables, determines next step

---

## The Step Loop

For each iteration:

```
1. Load step config from workflow_steps (parses JSON fields)
2. Reload variables from DB (always fresh)
3. Resolve {{placeholders}} in config
4. Execute the step (with retry logic per error_policy)
5. Merge set_vars into variables (if success)
6. Record step result in workflow_execution_steps
7. Increment steps_executed_count
8. Determine next step number
9. Check for delay → if delayed_until is set, schedule resume and return
10. Check safety limit → if 20 steps executed, schedule self-continue and return
11. Advance to next step
```

If no step is found at the current step number, the workflow is considered finished and `getWorkflowFinalStatus` determines `completed` or `completed_with_errors`.

---

## Delays

When a step returns `delayed_until` (via `schedule_resume`, `wait_for`, or `wait_until_time`):

1. A `workflow_resume` row is inserted into `scheduled_jobs` with the target datetime and step number
2. An idempotency key (`resume-{executionId}-{stepNumber}`) prevents duplicate resume jobs
3. Execution status is set to `delayed`
4. `advanceWorkflow` returns — nothing more happens until the job fires

When `/process-jobs` runs and picks up the `workflow_resume` job:
1. Updates the execution: `status = 'active'`, `current_step_number = nextStep`
2. Marks the scheduled job as `completed`
3. Calls `advanceWorkflow` in the background for that execution

---

## Safety Limit (MAX_STEPS_PER_INVOCATION)

To prevent runaway workflows from tying up the process indefinitely, the engine stops after 20 steps per invocation and schedules a self-continuation:

- Inserts a `workflow_resume` job with a 1-second delay
- Sets execution status back to `active`
- Returns `{ status: "continued_later" }`

The next `/process-jobs` poll picks it up and continues from where it left off.

---

## Job Processor

The job processor (`POST /process-jobs`) is the heartbeat of the system. It should be called on a regular polling interval — every 30 seconds is typical.

**Each call:**
1. Runs `recoverStuckJobs` — resets stuck `running` scheduled jobs and stuck `processing` executions older than 10 minutes back to `active`/`pending`
2. Claims up to 10 pending jobs atomically (`FOR UPDATE SKIP LOCKED`)
3. Marks them as `running`
4. Executes each job:
   - `workflow_resume` → updates execution, calls `advanceWorkflow` in background
   - `webhook` / `internal_function` / `custom_code` → executes directly
5. Records results, reschedules recurring jobs, handles retries

**Recovery** handles two failure scenarios:
- **Server crash mid-job**: `running` scheduled job stuck > 10 min → reset to `pending`
- **Server crash mid-execution**: `processing` execution stuck > 10 min → reset to `active`, picked up on next resume

---

## Stuck Execution Recovery

| Stuck state | Recovery mechanism | Time window |
|-------------|-------------------|-------------|
| `scheduled_jobs.status = 'running'` | Reset to `pending` on next `/process-jobs` call | > 10 min |
| `workflow_executions.status = 'processing'` | Reset to `active` on next `/process-jobs` call | > 10 min |
| `workflow_executions.status = 'delayed'` | Resume job fires at scheduled time — no special recovery needed | — |

---

## Cancellation

`POST /executions/:id/cancel`:
- Only works if status is `active`, `processing`, or `delayed`
- Sets status to `cancelled`, sets `completed_at`
- Deletes any pending `workflow_resume` scheduled jobs for that execution

If the execution is currently in `processing` (actively running steps), it will finish its current step before the cancellation takes effect on the next loop iteration. For immediate cancellation of a running execution, manual DB intervention is required.

---

## Execution Data Model

```
workflow_executions
  id
  workflow_id
  status                  — see status table above
  current_step_number     — NULL when completed
  steps_executed_count    — total steps run (including retries)
  init_data               — original start payload (JSON)
  variables               — live variable store (JSON, updated as workflow runs)
  created_at
  updated_at
  completed_at            — NULL until terminal status

workflow_execution_steps  — immutable record of each step run
  id
  workflow_execution_id
  step_number
  step_id                 — FK to workflow_steps
  status                  — 'success' | 'failed'
  output_data             — JSON output on success
  error_message           — error string on failure
  duration_ms
  executed_at
```

---

## Architecture Diagram

```
POST /workflows/:id/start
        │
        ▼
  Create execution row (status: active)
        │
        ▼
  advanceWorkflow() ──────────────────────────────────────────┐
        │                                                      │
        ▼                                                      │
  Phase 1: FOR UPDATE → mark 'processing' → commit/release    │
        │                                                      │
        ▼                                                      │
  Phase 2: Step loop (up to 20 steps)                         │
        │                                                      │
        ├─ step has delayed_until ──► schedule_resume job      │
        │                             status = 'delayed'       │
        │                             return                   │
        │                                                      │
        ├─ 20 steps reached ──────────► self-continue job (1s) │
        │                               status = 'active'      │
        │                               return                 │
        │                                                      │
        └─ no more steps ────────────► markExecutionCompleted  │
                                        return                 │
                                                               │
POST /process-jobs (every ~30s) ───────────────────────────────┘
        │
        ▼
  recoverStuckJobs()
        │
        ▼
  Claim pending jobs (FOR UPDATE SKIP LOCKED)
        │
        ▼
  For each job:
    workflow_resume → update execution → advanceWorkflow() (background)
    webhook/function/code → execute → record result → reschedule if recurring
```
