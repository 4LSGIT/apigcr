# Part 8 — Error Policies

Error policies control what happens when a step fails. They apply to all three engines — workflow steps, sequence steps, and standalone scheduled jobs.

---

## The Four Strategies

```json
"error_policy": {
  "strategy":        "retry_then_abort",
  "max_retries":     2,
  "backoff_seconds": 5
}
```

| Strategy | What happens on failure |
|----------|------------------------|
| `ignore` | Log the failure, continue to the next step. **(Default)** |
| `abort` | Stop immediately. Workflow → `failed`. Sequence → enrollment cancelled. Job → `failed`. |
| `retry_then_ignore` | Retry up to `max_retries` times, then continue if still failing. |
| `retry_then_abort` | Retry up to `max_retries` times, then abort if still failing. |

---

## Retry Backoff

```
Delay before attempt N = backoff_seconds × 2^(attempt - 1)
```

With `backoff_seconds: 5` and `max_retries: 3`:

| Attempt | Wait before |
|---------|-------------|
| 1 (initial) | — |
| 2 (retry 1) | 5s |
| 3 (retry 2) | 10s |
| 4 (retry 3) | 20s → fail |

Retries happen within the same execution call. For workflows, this means the execution stays in `processing` during retries. For sequences, the step job stays executing. Keep `max_retries` and `backoff_seconds` reasonable — a step with 3 retries at 60s backoff ties up the invocation for 3+ minutes.

---

## Choosing the Right Strategy

| Step type | Recommended |
|-----------|------------|
| Welcome email (must send) | `retry_then_abort` |
| Follow-up SMS (nice to have) | `retry_then_ignore` |
| Contact lookup (required to continue) | `abort` |
| Internal notification | `ignore` |
| Analytics/logging webhook | `ignore` |

---

## Per-Engine Behavior

### Workflows
- `abort` / `retry_then_abort` → execution marked `failed`, stops
- `ignore` / `retry_then_ignore` → step recorded as `failed`, execution continues to next step
- Final status: `completed_with_errors` if any steps failed with `ignore` policy

### Sequences
- `abort` / `retry_then_abort` → enrollment marked `cancelled` with `cancel_reason = "step_N_failed"`
- `ignore` / `retry_then_ignore` → step logged as `failed`, next step is scheduled normally

### Scheduled Jobs
- After `max_attempts`: `one_time` → `failed`. `recurring` → still rescheduled for next occurrence.
- Strategy only applies to workflow and sequence steps when called via `job_executor.js`.

---

## If No Error Policy Is Set

All engines default to `{ "strategy": "ignore" }` — log the failure and continue. This is intentionally permissive so a misconfigured step doesn't silently block an entire sequence.

For production sequences, explicitly set the policy on each step rather than relying on the default.
