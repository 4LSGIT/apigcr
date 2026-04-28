# 8 — Error Policies

## For operators

When a step fails — the SMS provider returned a 500, the webhook timed out, the contact lookup found nothing — you have four options for what should happen next:

| Strategy | What it does |
|---|---|
| `ignore` *(default)* | Log the failure and continue to the next step. The workflow finishes as `completed_with_errors` instead of `completed`. |
| `retry_then_ignore` | Try again up to N times with backoff. If still failing, log and continue. |
| `abort` | Stop the whole workflow / cancel the whole sequence enrollment. |
| `retry_then_abort` | Retry first; if it's still failing, abort. |

Pick by asking: "if this step fails, does the rest still make sense?"
- "Send the welcome SMS" — not critical, the next step (tag the contact) still makes sense → `ignore` or `retry_then_ignore`
- "Charge the credit card" — the rest doesn't make sense without it → `retry_then_abort`
- "Look up the contact's email" — the next step depends on it → `retry_then_abort`

**Defaults if you don't set anything:** `ignore` strategy, `0` retries.

---

## Technical reference

### Policy shape

Stored in the step's `error_policy` JSON column (workflows: `workflow_steps.error_policy`; sequences: `sequence_steps.error_policy`). All fields optional.

```json
{
  "strategy":        "retry_then_abort",
  "max_retries":     2,
  "backoff_seconds": 30
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `strategy` | enum | `ignore` | One of: `ignore`, `retry_then_ignore`, `abort`, `retry_then_abort` |
| `max_retries` | integer | `0` | How many additional attempts after the first failure |
| `backoff_seconds` | integer | `5` (seq) / engine-specific (workflow) | Base delay between retries |

### Backoff math

Sequences and workflows both use **linear backoff** inside the in-process retry loop, not exponential. The wait before attempt N (1-indexed) is:

```
backoff_seconds × N
```

So `backoff_seconds: 30` with `max_retries: 2` waits 30s before retry #1, 60s before retry #2.

> Note this is **different** from the *job-level* retry backoff used by `scheduled_jobs` (which is exponential: `backoff × 2^(attempt-1)`). The `error_policy` retry loop is the in-step retry; the job-level retry kicks in only for jobs that fail at a higher level (network errors, executor crashes).

### Per-engine behavior

#### Workflow Engine

Retries happen **synchronously inside `advanceWorkflow`**. A step with `max_retries: 3` and `backoff_seconds: 60` ties up the invocation for up to 3+ minutes. Keep retry counts and backoffs reasonable.

| Strategy | After exhausted retries | Execution status |
|---|---|---|
| `ignore` | Log step `failed`, continue to next step | Final status: `completed_with_errors` if any step failed under ignore |
| `retry_then_ignore` | Same as `ignore` after retries | Same as `ignore` |
| `abort` | Mark execution `failed`, stop | `failed` (immediate, no retries even if max_retries set) |
| `retry_then_abort` | Mark execution `failed` after retries | `failed` |

Aborted executions get their `cancel_reason` set to a description of the failing step.

#### Sequence Engine

| Strategy | After exhausted retries | Enrollment status |
|---|---|---|
| `ignore` | Log step `failed` (skip_reason: `action_failed_ignored`), advance to next step | Continues — final status `completed` once last step finishes |
| `retry_then_ignore` | Same as `ignore` after retries | Same |
| `abort` | Cancel enrollment with `cancel_reason: 'step_N_failed'` | `cancelled` |
| `retry_then_abort` | Cancel enrollment after retries | `cancelled` |

Aborted enrollments mark any pending `scheduled_jobs` for the enrollment as `failed` (preserves audit trail rather than deleting).

#### Scheduled Jobs

Scheduled jobs don't use `error_policy` — they use the job-level fields directly on the row:

| Field | Description |
|---|---|
| `max_attempts` | How many total attempts before giving up. Default 3. |
| `backoff_seconds` | Base delay for exponential backoff. Default 300 (5 min). |

Wait before attempt N (1-indexed): `backoff_seconds × 2^(N - 1)`.

For one-time jobs: after `max_attempts` exhausted, status becomes `failed`.

For recurring jobs: after `max_attempts` exhausted on this cycle, the job is rescheduled to next occurrence (a new cycle gets a fresh attempt counter).

### Examples by use case

#### Critical lookup that the rest depends on
```json
{
  "strategy":        "retry_then_abort",
  "max_retries":     3,
  "backoff_seconds": 5
}
```

#### Best-effort notification
```json
{
  "strategy":        "retry_then_ignore",
  "max_retries":     2,
  "backoff_seconds": 60
}
```

#### Idempotent webhook to internal route
```json
{
  "strategy":        "retry_then_ignore",
  "max_retries":     5,
  "backoff_seconds": 30
}
```

#### Non-idempotent third-party webhook (charge a card, send a real letter)
```json
{
  "strategy":        "abort",
  "max_retries":     0
}
```

You don't want to retry these — a partial success on attempt 1 and a "real" success on attempt 2 means the user got billed twice.

### Why `ignore` is the default

For a 4-staff firm running real automations, the failure mode you want to avoid most is **silent breakage of an entire sequence because one optional step had a bad day**. The default of `ignore` means "log it, keep going, and we'll see it in the executions tab." Operators can audit failures via the step log without a single hiccup nuking a follow-up series.

If you have steps where this isn't the right call (charges, signed documents, anything irreversible), set `abort` or `retry_then_abort` explicitly.

### What counts as a "failure"

For both engines, a step is considered failed when:
- The action throws an exception
- For webhook steps: HTTP response is non-2xx
- For workflow steps: `executeJob` returned `success: false` (or threw)
- Resolver semantic errors (blocked column, unresolvable strict-mode placeholder) — propagated as throws

**Not** counted as a failure:
- A skipped step (sequence: `condition_failed`, `fire_guard_failed`, `step_condition_failed`) — this is a normal control-flow signal, not an error
- A step that returned no output but didn't throw — coerced to `{ success: true }` so it round-trips as valid JSON in `job_results`
- A `set_next` to `null` (workflow) — that's a normal end-of-workflow signal

### Inspecting failures

#### Workflow
```
GET /executions/:id?history=true
```
The history array shows `status: 'failed'`, `error_message`, `attempts`, and the resolved config that was attempted.

#### Sequence
```
GET /sequences/enrollments/:id
```
The `step_log` array shows the same shape: `status`, `error_message`, `attempts`, `action_config_resolved`.

#### Scheduled Job
```
GET /scheduled-jobs/:id?history=true
```
Returns the full `job_results` history for that job — every attempt, status, output_data, error_message, and duration.

### Common pitfalls

1. **Setting `abort` on a non-essential step** — turns a successful 9-step run into a `failed` execution because step 4 (a follow-up SMS) timed out. Use `ignore` unless the rest genuinely doesn't make sense without this step.
2. **Setting huge `backoff_seconds` on workflow steps** — synchronous retries block the invocation. A `backoff_seconds: 600` with `max_retries: 5` means a single failing step ties up the engine for up to half an hour. Use `wait_for` instead to detach and retry on a fresh invocation.
3. **Confusing in-step retry with job-level retry** — two different retry layers. In-step retries (`error_policy.max_retries`) handle transient failures within one invocation. Job-level retries handle whole-invocation crashes. Both can stack.
4. **Webhook with `retry_then_ignore` to a non-idempotent endpoint** — receiver might process the same event twice. Add an idempotency key to the request, or use `abort`/`retry_then_abort` so the operator knows something needs manual cleanup.
