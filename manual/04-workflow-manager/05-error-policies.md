# Part 5 — Error Policies & Retry Logic

Every step can have an `error_policy` that controls what happens when that step fails. If no policy is specified, the default is `ignore` — log the failure and continue to the next step.

---

## The Four Strategies

```json
"error_policy": {
  "strategy": "retry_then_abort",
  "max_retries": 3,
  "backoff_seconds": 5
}
```

| Strategy | What It Does |
|----------|-------------|
| `ignore` | Log the failure, mark step as failed, continue to the next step. **(Default)** |
| `abort` | Stop the entire workflow immediately. Execution is marked `failed`. |
| `retry_then_ignore` | Retry up to `max_retries` times with exponential backoff. If still failing after all retries, log and continue. |
| `retry_then_abort` | Retry up to `max_retries` times with exponential backoff. If still failing after all retries, abort the entire workflow. |

---

## Retry Backoff

Retries use **exponential backoff** based on `backoff_seconds`:

```
Delay = backoff_seconds × 2^(attempt - 1)
```

So with `backoff_seconds: 5` and `max_retries: 3`:

| Attempt | Wait Before |
|---------|-------------|
| 1 (initial) | — |
| 2 (retry 1) | 5s |
| 3 (retry 2) | 10s |
| 4 (retry 3) | 20s → fail |

Retries happen **within the same `advanceWorkflow` call** — the execution stays in `processing` status during retries. This means long retry chains (many retries with large backoff) will tie up the invocation. For steps that could take a long time to retry, prefer using `wait_for` + a separate retry step instead.

---

## Choosing the Right Strategy

| Situation | Recommended Strategy |
|-----------|---------------------|
| Non-critical step (e.g. internal notification) | `retry_then_ignore` |
| Critical step that must succeed (e.g. welcome email) | `retry_then_abort` |
| Lookup that must find a record to continue | `abort` |
| Best-effort action (log, analytics ping) | `ignore` |
| SMS (often flaky, shouldn't block workflow) | `retry_then_ignore` |

---

## Effect on `status_summary`

When a workflow completes, its `status_summary` reflects whether any steps failed:

- `completed` — all steps succeeded
- `completed_with_errors` — one or more steps failed but were ignored (via `ignore` or `retry_then_ignore`)

A workflow that `abort`s or `retry_then_abort`s ends with `status = "failed"`, not a `completed_*` status.

---

## Per-Step vs Workflow-Level Failure

Error policies are **per step**. A single workflow can have:
- Step 2: `retry_then_abort` (must send the welcome email)
- Step 4: `retry_then_ignore` (SMS failure acceptable)
- Step 5: `ignore` (internal notification, best-effort)

This lets you be strict where it matters and lenient where it doesn't.

---

## Example Step with Error Policy

```json
{
  "stepNumber": 2,
  "type": "internal_function",
  "config": {
    "function_name": "send_email",
    "params": {
      "from": "stuart@4lsg.com",
      "to": "{{contact_email}}",
      "subject": "Your appointment is confirmed",
      "text": "Hi {{contact_fname}}, we look forward to seeing you."
    }
  },
  "error_policy": {
    "strategy": "retry_then_abort",
    "max_retries": 2,
    "backoff_seconds": 5
  }
}
```

This will try to send the email up to 3 times total (1 initial + 2 retries), waiting 5s then 10s between attempts. If all three fail, the entire workflow is marked `failed` and stops.
