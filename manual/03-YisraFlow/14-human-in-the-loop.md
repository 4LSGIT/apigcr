# 14 — Human-in-the-Loop Decisions (`request_decision`)

A workflow can pause and ask a person to choose between options — approve/deny a
refund, pick a follow-up path, confirm before an irreversible send — then resume
with their answer in a variable. If nobody answers by the deadline, the workflow
resumes automatically with a configurable default.

Workflows only. Sequences cannot pause on a step result; a sequence that needs a
decision gate uses a `start_workflow` step to spawn a workflow carrying the gate.

## How it works

1. A `request_decision` step mints a token, writes a `decision_requests` row,
   sends the recipient an email and/or SMS with links to the public decision
   pages (`/d/<token>`), and — for staff recipients — creates a paired task.
2. The execution parks as `delayed` until `timeout` elapses, exactly like
   `schedule_resume`. The timeout default is **pre-written**: `result_var` is
   set to `timeout_value` at pause time.
3. If the recipient responds, the response endpoint overwrites `result_var`
   with the chosen value, cancels the pending timeout resume, and resumes the
   workflow immediately at `nextStep`.
4. If the timeout fires first, the ordinary delayed-resume path continues the
   workflow at `nextStep` with `result_var` still holding `timeout_value`, and
   a cleanup job marks the request `timed_out` and dismisses the paired task.
5. Either way, the step after the gate is typically an `evaluate_condition`
   branching on `result_var`. An outcome log row (`note`) is written on
   response and on timeout, linked to the execution's contact when it has one.

Responses and timeouts cannot both win: the response claim requires
`expires_at > NOW()` while the timeout job fires only at `NOW() >= expires_at`,
arbitrated by an atomic status flip on the `decision_requests` row. Repeat
clicks render "already answered"; links for cancelled executions render "no
longer needed" (execution cancel cascades onto pending decisions and their
paired tasks).

## Example

```json
[
  { "step": 3, "type": "internal_function",
    "config": { "function_name": "request_decision", "params": {
      "question": "Approve $500 refund for {{contactName}}?",
      "options": [ { "label": "Approve", "value": "approve" },
                   { "label": "Deny",    "value": "deny" } ],
      "result_var": "refund_decision",
      "timeout": "3d",
      "timeout_value": "no_response",
      "recipient_kind": "user",
      "recipient_id": 1
    } } },
  { "step": 4, "type": "internal_function",
    "config": { "function_name": "evaluate_condition", "params": {
      "branches": [
        { "variable": "refund_decision", "operator": "equals", "value": "approve", "then": 5 },
        { "variable": "refund_decision", "operator": "equals", "value": "deny",    "then": 8 }
      ],
      "else": 10
    } } }
]
```

Step 5 runs on approval, step 8 on denial, step 10 when the 3 days lapse with
no answer.

## Parameters

| param | req | notes |
|---|---|---|
| `question` | ✓ | Shown on the decision pages, default email, and log. ≤2000 chars. `{{variables}}` work. |
| `options` | ✓ | 1–10 of `{"label","value"}`. `value` is url-safe `[a-zA-Z0-9_-]{1,64}`, unique; it's what lands in `result_var`. |
| `result_var` | ✓ | Variable receiving the chosen value (or `timeout_value`). |
| `timeout` | ✓ | `"2h"`, `"3d"`, `"30m"`, or ms. Max 365d. |
| `timeout_value` | ✓ | Written to `result_var` on no-response. Doesn't have to be an option value. |
| `nextStep` | | Resume target after response OR timeout. Default: the following step. Remapped on step renumbering like other branch targets. |
| `recipient_kind` | ✓ | `user` (staff — gets a paired task), `contact`, or `raw`. |
| `recipient_id` | | User or contact id for kinds `user`/`contact`. Placeholder OK. |
| `recipient_email` / `recipient_phone` | | For `raw`. |
| `send_email` | | Default `true`. Omitting `email_html` sends a styled default with one button per option. |
| `send_sms` | | Default `false`. Default text = question + decision link. |
| `email_from` / `sms_from` | | Defaults: `email_automations` setting / `sms_staff_from`→`sms_default_from` settings. |
| `email_subject` / `email_html` / `sms_text` | | Custom templates — see tokens below. |
| `create_task` | | Default `true` (user recipients only). Paired task: `source=decision_request`, no assignment email, auto-completes on response, dismissed on timeout/cancel. |
| `task_title` | | Default `"Decision: <question>"`. |

At least one delivery surface must exist (a working email, a working SMS, or a
paired task), or the step fails and the request row is closed.

## Template tokens

Custom `email_subject` / `email_html` / `sms_text` use **square-bracket** tokens
(the decision URLs don't exist until the step runs, after the engine's normal
`{{...}}` pass):

- `[[decision_url]]` — landing page with all options
- `[[respond_url:VALUE]]` — pre-selected confirm page for one option (unknown
  `VALUE` fails the step loudly)
- `[[question]]` — the question (HTML-escaped inside `email_html`)
- `[[options_html]]` — styled button block (email only)
- `[[options_text]]` — `Label: url` lines (SMS / plain text)
- `[[expires_at]]` — deadline in firm time

Normal `{{variables}}` still resolve first via the engine pipeline, so both can
appear in the same template.

## Link behavior & security

Every emailed link is a GET that never mutates (mail scanners prefetch GETs —
same rule as task action links). The email's per-option buttons open a
confirmation page; the actual response is a form POST. The token authorizes the
response and is attributed to the stored recipient with `responded_via='link'` —
the same trust model as `/t/:token` task links.

## Step output

`{{this.output}}` from the step: `decision_request_id`, `token`, `decision_url`,
`expires_at`, `delivered` (channels that sent), `failures`, `paired_task_id`.
Capture with `set_vars` as usual.

## Operational notes

- **Cancelling an execution** with a pending decision cancels the request and
  dismisses its paired task (`POST /executions/:id/cancel` cascade).
- **Renumbering steps** while an execution is already paused on a decision does
  not rewrite that execution's frozen `resume_step` — the same exposure any
  delayed execution has via its scheduled resume job.
- **Operator resume/redo tools** ignore pending decisions; a stale request
  simply expires via its cleanup job and its links render "expired".
- Tables/rows involved: `decision_requests` (state), one `workflow_resume`
  job (the timeout resume, deleted on early response), one `one_time` job
  (`decision_timeout_cleanup` — never cancelled, no-ops if answered).
