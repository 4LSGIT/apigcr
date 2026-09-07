# 5 — Internal Functions

## For operators

The system has **91 built-in functions** that workflows, sequences, scheduled jobs, hook targets and the email/phone ingest rules can call. Things like "send an SMS," "look up a contact," "create a task," "query the database," "branch to step 7."

You don't usually pick a function by hand from a list — when you build a workflow step or a sequence step, you select **internal_function** as the action type and the UI shows you the available ones in a categorized dropdown with a form field for each parameter. Six are hidden from the pickers (internal plumbing), so a workflow offers **85** and a sequence **74** — sequences don't get the eleven that need workflow machinery.

The eleven that only work in workflows are the ones that need workflow-specific machinery: branching (`set_next`, `evaluate_condition`, `foreach`), delays (`wait_for`, `schedule_resume`, `wait_until_time`), variable formatting (`format_string`), pausing for a human (`request_decision`), starting another workflow (`start_workflow`), and the two document renderers that write back to the execution (`document_generate_from_template`, `render_submission_pdf`).

Everything else works the same way in any engine that calls it.

When something doesn't fire when you expected:
1. Open the workflow execution or sequence step log — the resolved params are saved there. Look at what was actually passed in.
2. If the placeholder `{{contacts.contact_fname}}` came through unresolved, the resolver couldn't find it — see chapter 6.
3. If the function threw, the error is in `error_message`.

---

## Technical reference

### Module: `lib/internal_functions/`

A **directory**, one module per category (`contacts.js`, `timing.js`, `court.js`, …), auto-scanned at boot by `index.js` — there is no registration step, and duplicate names across files throw at startup. It replaced the old single-file `lib/internal_functions.js`; `require('../lib/internal_functions')` still resolves here, so no caller changed. `lib/internal_functions/README.md` carries the module convention (the `__meta` block, category-vs-file placement, picker ordering) and is the place to look before adding one.

The registry exports an object whose keys are function names. Each function has the signature:

```js
async (params, db) => { success: boolean, output?: any, set_vars?: object, next_step?: number|null|'end'|'cancel'|'fail', delayed_until?: Date }
```

Functions can return:
- `output` — captured as `{{this.output.X}}` in the next step
- `set_vars` — merged into workflow `variables` (workflow only — sequences ignore this)
- `next_step` — workflow-only control flow (only honored on `set_next`, `evaluate_condition`, `schedule_resume`)
- `delayed_until` — workflow-only delay (only honored on `wait_for`, `schedule_resume`, `wait_until_time`)

Each function carries a `__meta` block — a JSON description of its params (name, type, required, etc.) that drives the form-driven UI. The reference below pulls directly from those `__meta` blocks; if a future change adds or renames a param, `GET /workflows/functions` is the live source of truth.

### The function registry

**91 callable functions**, grouped by `__meta` category. Counts in this chapter go stale the moment somebody adds a file, so treat `GET /workflows/functions` as the live source of truth — it serves the registry's own metadata. The meta test (`tests/internal_functions.meta.test.js`) derives its coverage from the registry itself, so a new function without a `__meta` block fails the build rather than appearing here silently.

Of the 91: **6** are `uiHidden` (internal plumbing — `court_extract`, `decision_timeout_cleanup`, `set_test_var`, `forward_as_email`, `forward_as_sms`, `portal_callback_reminder`), leaving 85 in the pickers; **11** of those 85 are `workflowOnly`.

| Category | Functions |
|---|---|
| control (workflow only) | `set_next`, `evaluate_condition` |
| variables | `noop`, `set_var`, `format_string` |
| timing (workflow only) | `schedule_resume`, `wait_for`, `wait_until_time` |
| communication | `send_sms`, `send_email`, `send_mms` |
| tasks | `create_task`, `run_task_digest` |
| contacts | `lookup_contact`, `find_contact`, `update_contact` |
| users | `lookup_user`, `list_users` |
| cases | `update_case` |
| appointments | `create_appointment`, `lookup_appointment`, `update_appointment`, `get_appointments` |
| events | `create_event`, `update_event`, `complete_event`, `lookup_event`, `get_events`, `run_event_digest`, `sweep_calendar_missed`, `emit_calendar_approaching` |
| calendar | `gcal_create_event`, `gcal_get_event`, `gcal_update_event`, `gcal_delete_event` |
| dropbox | `dropbox_create_folder`, `dropbox_get_shared_link`, `dropbox_list_folder`, `dropbox_move`, `dropbox_rename`, `dropbox_delete`, `dropbox_save_url`, `dropbox_ensure_case_folder` |
| log | `create_log`, `phone_log` |
| sequences | `cancel_sequences`, `enroll_sequence` |
| connections | `refresh_expiring_oauth_credentials`, `rc_renew_subscriptions`, `gcontacts_sync_pending` |
| system | `run_error_sweep`, `court_review_retry`, `court_activity_summary`, `generate_firm_blocks` |
| general | `query_db` |
| ai | `query_ai` |
| dev | `set_test_var` |
| *(no meta — pipeline-only)* | `court_extract` — intentionally carries no `__meta`; its params are envelope dot-paths that only exist in the email-ingest pipeline, so it must never appear in the step editors. Documented at its definition and exempted by name in the meta test. |


### The recurring-jobs roster

Sixteen of these functions run on a schedule, unattended. When one fails
overnight this is the table you want — what it does, when it runs, and where its
entry is. Cron times are UTC.

| Function | Cron (UTC) | What it does |
|---|---|---|
| `documents_sync` | `*/10 * * * *` | One bounded increment of the Dropbox→documents sync |
| `run_error_sweep` | `*/15 * * * *` | Retries and ages out failed jobs |
| `documents_refresh_case_cache` | `0 */4 * * *` | Rebuilds the case-folder cache |
| `refresh_expiring_oauth_credentials` | `0 7 * * *` | Renews OAuth credentials before they lapse |
| `sweep_trigger_executions` | `0 7 * * *` | Trigger-execution retention |
| `rc_renew_subscriptions` | `30 7 * * *` | Renews RingCentral webhook subscriptions |
| `sweep_calendar_missed` | `0 8 * * *` | Marks passed deadlines `missed`, emitting `calendar.resolved` |
| `gcontacts_sync_pending` | `0 9 * * *` | Pushes pending contacts to Google Contacts |
| `emit_calendar_approaching` | `0 9 * * *` | Emits `calendar.approaching` for configured offsets |
| `esign_reconcile` | `0 11 * * *` | Re-checks outstanding envelopes; catches missed webhooks |
| `court_activity_summary` | `0 13 * * *` | Daily court-activity digest |
| `court_review_retry` | `0 13 * * *` | Re-runs queued court items |
| `emit_stage_aged` | `0 13 * * *` | Emits `case.stage_aged` for cases sitting too long |
| `run_task_digest` | `0 13 * * *` | The daily task digest |
| `run_event_digest` | `0 21 * * *` | The daily event digest |
| `generate_firm_blocks` | `45 7 1 * *` | Monthly — regenerates firm identity blocks |

Two of these are expected to look idle. `emit_calendar_approaching` emits
nothing until a calendar type has offsets configured, and `sweep_calendar_missed`
only fires when a deadline actually passed unresolved. A zero is not a fault.

Schedules live in `scheduled_jobs` rows, not in a deploy — see
[chapter 4](04-scheduled-jobs.md) to change one.

### Workflow-only vs both engines

**The split is meta-driven — there is no hardcoded exclusion list.** A function
is kept out of sequences by declaring `workflowOnly: true` on its own `__meta`;
`GET /workflows/functions` filters on that. Functions without meta default to
sequence-eligible. (An older `SEQUENCE_EXCLUDED` set in `routes/workflows.js`
was removed — don't go looking for it.)

Why these are workflow-only: they need machinery a sequence doesn't have — the
step graph, the execution's variable bag, or the ability to suspend and resume.

- **Workflow only (13, of which 11 appear in the picker):** `set_next`,
  `evaluate_condition`, `foreach`, `request_decision`, `start_workflow`,
  `schedule_resume`, `wait_for`, `wait_until_time`, `format_string`,
  `document_generate_from_template`, `render_submission_pdf`, plus the hidden
  `decision_timeout_cleanup` and `set_test_var`.
- **Both engines (74 in the picker):** everything else.

Sequences have their own timing model, which is why the `wait_*` family is
excluded rather than reimplemented.

`GET /workflows/functions` returns both lists for the UI and is the live source
of truth if these counts have drifted.

---

## Function reference, by category

### Control flow (workflow only)

#### `set_next`

Jump to a specific step number, or terminate the execution.

| Param | Type | Required | Description |
|---|---|---|---|
| `value` | string | yes (placeholderAllowed) | Step number, `"end"`, `"cancel"`, or `"fail"`. Blank/null also ends normally. |

Sentinels — resolved in ONE place, `workflow_engine.normalizeNextStep()`. Trimmed and case-insensitive:

| Value | Result |
|---|---|
| positive integer, or a digit string (`5` / `"5"`) | jump to that step |
| `"end"` | end with the workflow's final status (`completed` / `completed_with_errors`) |
| `null`, omitted-but-present, or blank `""` | same as `"end"` |
| `"cancel"` | mark execution `cancelled` |
| `"fail"` | mark execution `failed` |
| **anything else** | **the step is recorded FAILED and the execution is marked `failed`** |

`"end"` is the preferred authoring form. It exists because the sentinel family was `cancel`/`fail` plus a bare null, which left "end normally" as the only terminal outcome with no word — so it could not be produced by a **computed** target (`set_next { value: "{{jump_to}}" }` could resolve to a step number, `"cancel"` or `"fail"`, but never "stop"), and in the form editor it could only be authored by leaving a required field blank, which reads as an unfinished step.

The string `"null"` is also accepted, as a deprecated alias for pre-2026-08 configs. Don't write new ones.

**Unusable values are fatal, deliberately.** A typo (`"stpe 5"`, `"done"`, `0`) used to fall through to the step pointer, which is an `INT` column — with no `STRICT_TRANS_TABLES` that stored `0`, the engine then failed to load step 0, hit the missing-step branch, and completed the execution as though nothing were wrong. Same contract applies to `foreach.end_step`, `evaluate_condition`'s `then`/`else`/`branches[].then`, `request_decision.nextStep`, and the `wait_for`/`schedule_resume` skip targets — they all funnel through the same normalizer.

Example:
```json
{ "function_name": "set_next", "params": { "value": 5 } }
{ "function_name": "set_next", "params": { "value": "end" } }
```

#### `evaluate_condition`

Branch to a different step based on a variable comparison.

**Simple form** (single condition):

| Param | Type | Required | Description |
|---|---|---|---|
| `variable` | string | yes (placeholderAllowed, modeGroup `single`) | Workflow variable name (no `{{}}`). |
| `operator` | enum | yes (modeGroup `single`) | `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `not_contains`, `is_empty`, `is_not_empty` |
| `value` | string | conditional (placeholderAllowed, modeGroup `single`) | RHS for the comparison. Ignored for `is_empty` / `is_not_empty`. |
| `then` | integer | yes | Step number to jump to when condition is true. |
| `else` | integer | optional | Step to jump to when false. Omit/null = end the workflow (see cookbook §5.16). |

**Multi-condition form:**

| Param | Type | Required | Description |
|---|---|---|---|
| `conditions` | array | yes (modeGroup `multi`) | Array of `{ variable, operator, value }` |
| `match` | enum | optional, default `"all"` (modeGroup `multi`) | `"all"` (AND) or `"any"` (OR) |
| `then`, `else` | as above | | |

`exclusiveOneOf: [['variable', 'conditions']]` — exactly one form per step.

**Sentinel values for `then` / `else`.** The runtime returns whatever you put there as `next_step`, and `advanceWorkflow` normalizes it through the same `normalizeNextStep()` as `set_next`: integer = jump, `null`/omitted = end, `"end"` = end, `"cancel"` = mark cancelled, `"fail"` = mark failed. But the `__meta` declares `then`/`else` as `integer`, so the save-time validator **rejects the word forms here** — that's deliberate, since a non-numeric main branch target is far more often a typo than an intent. To terminate from a branch, point `then`/`else` at a step whose `set_next.value` is `"end"` / `"cancel"` / `"fail"`.

#### `foreach` *(workflow only)*

Loop over a list: exposes one item per pass into item_var and falls into the body (the following steps); the last body step must set_next back to this step. When exhausted, jumps to end_step. Cursor persists in workflow variables, so loops safely span self-continue invocations. Hard-bounded at 500 items.

| Param | Type | Required | Description |
|---|---|---|---|
| `list` | array | yes (placeholderAllowed) | The list to iterate — usually a single {{placeholder}} resolving to an array. |
| `item_var` | string | yes | Variable name that receives the current item. |
| `index_var` | string | optional | Optional variable name that receives the 0-based index. |
| `end_step` | string | yes (placeholderAllowed) | Where to go when the list is exhausted: step number, "end" (end the workflow), "cancel", or "fail". Blank/null also ends the workflow. |
| `state_var` | string | optional | Variable holding the loop cursor. Default: __foreach_<item_var>. |
| `max_items` | integer | optional | Per-loop item cap (default 100, hard ceiling 500). Exceeding it fails the step. |

Example:
```json
{
  "list": "{{matches}}",
  "item_var": "match",
  "end_step": 12
}
```

#### `request_decision` *(workflow only)*

Human-in-the-loop gate: pause the workflow, email/SMS a person clickable options, and resume when they respond (or at the timeout with timeout_value). The chosen value lands in the variable named by result_var — branch on it with evaluate_condition at the next step. Staff recipients also get a paired task that auto-closes with the decision. Message templates support [[decision_url]], [[respond_url:VALUE]], [[question]], [[options_html]], [[options_text]], [[expires_at]] (square brackets — resolved after the normal {{variable}} pass).

| Param | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes (placeholderAllowed, multiline) | The question shown on the decision page, in the default email, and in the outcome log. Max 2000 chars. |
| `options` | array | yes | JSON array of 1–10 {"label","value"} objects. label ≤100 chars; value url-safe [a-zA-Z0-9_-]{1,64}, unique. The chosen value is written to result_var. |
| `result_var` | string | yes | Workflow variable that receives the chosen value (or timeout_value). |
| `timeout` | duration | yes (placeholderAllowed) | How long to wait — "2h", "3d", "30m", or milliseconds. Max 365d. |
| `timeout_value` | string | yes (placeholderAllowed) | Written to result_var when nobody responds in time. Need not be one of the option values — branch on it like any other. |
| `nextStep` | integer | optional | Step the workflow resumes at after response OR timeout. Default: the step after this one. Typically an evaluate_condition on result_var. |
| `recipient_kind` | enum | yes | 'user' = staff (users table, gets a paired task), 'contact' = client, 'raw' = explicit email/phone. |
| `recipient_id` | integer | optional (placeholderAllowed) | User id or contact id (required for kind user/contact). Accepts a {{placeholder}}. |
| `recipient_email` | string | optional (placeholderAllowed) | Email address for recipient_kind=raw. |
| `recipient_phone` | string | optional (placeholderAllowed) | Phone for recipient_kind=raw. |
| `send_email` | boolean | optional, default true | Send the decision email. Omitting email_html sends a styled default with one button per option. |
| `send_sms` | boolean | optional, default false | Send an SMS carrying the decision link. |
| `email_from` | string | optional | Sender address (email_credentials row). Default: the email_automations setting. |
| `email_subject` | string | optional (placeholderAllowed) | Default: "Decision needed: <question>". [[...]] tokens work here too. |
| `email_html` | string | optional (placeholderAllowed, multiline) | Custom HTML body. Use [[options_html]] or per-option [[respond_url:VALUE]] links. Omit for the styled default email. |
| `sms_from` | string | optional | Sending line (phone_lines.phone_number). Default: sms_staff_from / sms_default_from setting. |
| `sms_text` | string | optional (placeholderAllowed, multiline) | Custom SMS body — include [[decision_url]]. Default: question + link. |
| `create_task` | boolean | optional, default true | Staff recipients only: create a paired task (source=decision_request, no assignment email) that auto-completes on response and is dismissed on timeout/cancel. |
| `task_title` | string | optional (placeholderAllowed) | Paired task title. Default: "Decision: <question>". |

Example:
```json
{
  "question": "Approve $500 refund for {{contactName}}?",
  "options": [
    {
      "label": "Approve",
      "value": "approve"
    },
    {
      "label": "Deny",
      "value": "deny"
    }
  ],
  "result_var": "refund_decision",
  "timeout": "3d",
  "timeout_value": "no_response",
  "recipient_kind": "user",
  "recipient_id": 1
}
```

Chapter 14 covers the whole pause/resume lifecycle — the decision page, the
paired staff task, deadline defaults and what resuming actually does. Use it
rather than this table when you are building one.

---

### Variable manipulation

#### `noop`

Does nothing. Useful as a config-driven step that only sets variables via `set_vars` in the step config.

No params.

#### `set_var`

Explicitly set one variable to a value. Available in both engines (sequences ignore the result).

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Variable name. |
| `value` | string | optional (placeholderAllowed) | Value to assign. |

In practice, the `set_vars` map on a step's config is the more common way to do this — `set_var` is for cases where the value is computed from logic rather than a placeholder.

#### `format_string` *(workflow only)*

Store a (resolved) template string as a variable. Placeholders in `template` are resolved by the engine **before** this runs — the function just stores the resulting string.

| Param | Type | Required | Description |
|---|---|---|---|
| `template` | string | yes (placeholderAllowed, multiline) | Template string. `{{placeholders}}` resolved by the engine before this runs. |
| `output_var` | string | yes | Variable name to store the result in. |

Sequences should use the universal resolver via `action_config` (placeholders are resolved automatically before the action runs).

---

### Timing (workflow only)

#### `wait_for`

Pause for a duration **or** until a specific time, then continue. Inserts a `workflow_resume` scheduled job and marks the execution `delayed`.

| Param | Type | Required | Mode | Description |
|---|---|---|---|---|
| `duration` | duration | one-of (placeholderAllowed) | `relative` | `"30s"`, `"5m"`, `"2h"`, `"1d"`, or millisecond number. |
| `at` | iso_datetime | one-of (placeholderAllowed) | `absolute` | Absolute datetime; naive forms use FIRM_TZ. Null/empty triggers skip-block path. |
| `nextStep` | integer | yes | | Step to resume at. |
| `skipToStep` | integer | optional | | Step to jump to when `at` resolves to null/empty. Defaults to `nextStep`. |
| `randomizeMinutes` | integer | optional, max 1440 | | ±N minute jitter applied to resume time. |

`exclusiveOneOf: [['duration', 'at']]` — exactly one of the two.

#### `schedule_resume`

Same as `wait_for` but with one combined slot for the resume target.

| Param | Type | Required | Description |
|---|---|---|---|
| `resumeAt` | iso_datetime | yes (placeholderAllowed, `nullishSkipsBlock`) | ISO datetime, duration string (`"2h"`), milliseconds-from-now, or null/empty (jumps to `skipToStep`). |
| `nextStep` | integer | yes | Step to resume at. |
| `skipToStep` | integer | optional | Step to jump to when `resumeAt` is null/empty. Defaults to `nextStep`. |
| `randomizeMinutes` | integer | optional, max 1440 | ±N minute jitter. |

The `nullishSkipsBlock` flag is what enables the pre-computed-timestamp pattern (cookbook §3.1, §5.2): pre-compute the resume timestamp at workflow start, pass `null` if it's already past, and the engine silently jumps to `skipToStep` rather than blowing up.

#### `wait_until_time`

Resume at the next occurrence of a clock time.

| Param | Type | Required | Description |
|---|---|---|---|
| `time` | string | yes | `"HH:MM"` 24h. |
| `timezone` | string | optional | IANA TZ; defaults to `FIRM_TIMEZONE` (America/Detroit). |
| `nextStep` | integer | yes | Step to resume at. |

---

### Communication (both engines)

#### `send_sms`

Send a single SMS via the firm's phone lines.

| Param | Type | Required | Widget | Description |
|---|---|---|---|---|
| `from` | string | yes | `phone_line` | 10-digit number matching `phone_lines.phone_number`. |
| `to` | string | yes (placeholderAllowed) | — | Recipient phone (any common format). |
| `message` | string | yes (placeholderAllowed, multiline) | — | Message body. |

Uses `smsService.sendSms(db, from, to, message)` (positional args). MMS only works with RingCentral provider.

#### `send_email`

Send a single email via the configured provider (smtp or pabbly).

| Param | Type | Required | Widget | Description |
|---|---|---|---|---|
| `from` | string | yes | `email_from` | Must match a row in `email_credentials`. |
| `to` | string | yes (placeholderAllowed) | — | Recipient address. |
| `subject` | string | yes (placeholderAllowed) | — | |
| `text` | string | conditional (placeholderAllowed, multiline) | — | Plain text body. |
| `html` | string | conditional (placeholderAllowed, multiline) | — | HTML body. |
| `attachment_urls` | array | optional | — | JSON array. Either URL strings or `{url, name}` objects. Single `{url, name}` also accepted at runtime but rejected by the workflow editor (must be wrapped in an array there — see pitfall #7). |
| `attachment_names` | array | optional | — | Parallel array of display names. Usually unnecessary — names are inferred from URL or the `{name}` field. |

`requiredWith: [['text', 'html']]` — at least one of `text` / `html` required.

**Attachment shapes** — `attachment_urls` accepts:

```json
["https://storage.googleapis.com/.../intake.pdf"]
[{"url": "https://...", "name": "Fee Agreement.pdf"}]
[{"url": "https://...", "name": "Doc 1.pdf"}, "https://.../doc2.pdf"]
```

Placeholders work inside URL strings: `["{{contacts.contact_doc_url}}"]` resolves at send time. Files are fetched at send time — they must be publicly reachable (Pabbly fetches the URL itself; SMTP uses nodemailer's remote-`path:` mode).

**Provider behavior at the `emailService` layer** — both routes are wired:
- **SMTP**: `attachment_urls` are converted to nodemailer `{filename, path}` entries on send.
- **Pabbly**: `attachment_urls` and `attachment_names` are flattened to comma-separated strings on the outbound payload.

**`attachments`** (raw nodemailer format, SMTP-only) is supported by `emailService.sendEmail` directly, but `send_email` does not pass it through — the runtime destructure pulls only `attachment_urls` and `attachment_names`. If you genuinely need raw nodemailer `attachments` from a workflow/sequence step, edit the `send_email` body to add it to the destructure. In practice `attachment_urls` covers all use cases and survives provider swaps, so this hasn't been needed.

#### `send_mms`

Send an MMS from an MMS-capable phone line. URL-attachment only (single attachment per RingCentral API limits).

| Param | Type | Required | Widget | Description |
|---|---|---|---|---|
| `from` | string | yes | `phone_line_mms` | 10-digit number matching `phone_lines.phone_number` where `mms_capable=1`. |
| `to` | string | yes (placeholderAllowed) | — | Recipient phone (any common format). |
| `text` | string | optional (placeholderAllowed, multiline) | — | Optional message body (≤1000 chars per RingCentral limits). |
| `attachment_url` | string | yes (placeholderAllowed) | — | Publicly fetchable URL. RingCentral fetches the file at send time and caps it at 1.5MB. **See media-type notes below.** |

Lazy-requires `ringcentralService` and calls `ringcentralService.sendMms(db, from, to, text, 'US', null, null, null, attachment_url, false)` — same shape as `routes/internal/mms.js`. Performs a capability check against `phone_lines.mms_capable` (not `provider`) so future MMS-capable providers can opt in via a row update without code changes here.

**Media types.** RingCentral's published spec lists images (JPEG, PNG, GIF, BMP, TIFF) and standard audio/video as supported. **PDFs are not on the published list but work in practice for this account today** — tested-good, but best-effort: an RC API change could break PDF support without notice, and there's no contractual guarantee. Prefer the spec-supported types when reliability matters. For documents you need delivered guaranteed (especially across providers or RC API changes), use `send_email` — `attachment_urls` handles PDFs cleanly.

**Content-Type gotcha.** `ringcentralService.sendMms` strips Content-Type parameters before forwarding to RC because RC's parser doesn't normalize them. A source URL that returns `application/pdf; qs=0.001` (some W3C-hosted files do this as a content-negotiation hint) gets rejected as `MSG-348 "Unsupported attachment media type"` if the parameter isn't stripped. Hosting attachments on GCS, your own server, or any provider that returns a clean `Content-Type` avoids the issue entirely — and the parameter strip is in place defensively for the rest.

**MMS today is RingCentral-only.** Quo and OpenPhone don't support MMS; their lines have `mms_capable=0` and won't appear in the editor's `phone_line_mms` dropdown. If you need cross-provider parity, send a link via `send_sms` instead.

The `phone_line_mms` widget filters the dropdown to MMS-capable lines only. In the workflow editor this is automatic. In the sequence editor, MMS works only via `action_type='internal_function'` + `function_name='send_mms'` (JSON params textarea) — there's no first-class `'mms'` `action_type` and consequently no widget filtering. Operators picking the line by hand will get a clear runtime error from `send_mms`'s capability check if they choose a non-MMS line.

---

### Tasks (both engines)

#### `create_task`

Insert a task row linked to a contact, case, appointment, or bill. Returns `{ task_id }` as output.

| Param | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes (placeholderAllowed) | Task title. |
| `description` | string | optional (placeholderAllowed, multiline) | |
| `contact_id` | string | yes (placeholderAllowed) | FK to contacts table. |
| `assigned_to` | integer | yes | User ID to assign to. |
| `assigned_by` | integer | optional | User ID who created it. Defaults to `assigned_to`. |
| `link_type` | enum | optional, default `contact` | `contact`, `case`, `appt`, `bill` |
| `link_id` | string | optional (placeholderAllowed) | ID for the link. Defaults to `contact_id`. |
| `due_date` | iso_datetime | optional (placeholderAllowed) | ISO date or datetime. |

Schedules a due-date reminder via `taskService` if `due_date` is set.

#### `run_task_digest`

Send the daily task digest on demand. Updates Pending → Due Today → Overdue based on `task_due`, sends email + optional SMS digest per user.

| Param | Type | Required | Description |
|---|---|---|---|
| `user` | string | optional (placeholderAllowed) | User ID to target. Omit for all users with `task_remind_freq`. |
| `force` | boolean | optional, default false | Skip Shabbos/Yom Tov gate and ignore `task_remind_freq` day filter. |

Normally fired by a recurring scheduled job seeded at deploy time. The `force` flag is the manual-trigger escape hatch.

---

### Sequences (both engines)

#### `cancel_sequences`

Cancel all active sequence enrollments of a given type for a contact.

| Param | Type | Required | Description |
|---|---|---|---|
| `contact_id` | string | yes (placeholderAllowed) | e.g. `"{{contactId}}"` |
| `template_type` | string | optional | e.g. `"no_show"`. Omit/null to cancel **all** types. |
| `reason` | string | optional, default `"internal_function"` | Logged in `cancel_reason`. |

Example:
```json
{ "contact_id": "{{contactId}}", "template_type": "no_show", "reason": "new_appointment_booked" }
```

#### `enroll_sequence`

Enroll a contact in a sequence. Two mutually exclusive modes via `modeGroup` `by_type` vs `by_id`.

| Param | Type | Required | Mode | Description |
|---|---|---|---|---|
| `contact_id` | string | yes (placeholderAllowed) | — | `"{{contactId}}"` |
| `template_type` | string | one of {type, id} | by_type | Sequence type for cascade match. |
| `appt_type` | string | optional | by_type | Cascade filter (type-mode only). |
| `appt_with` | integer | optional | by_type | Cascade filter (type-mode only). |
| `template_id` | integer | one of {type, id} | by_id | Specific template ID for direct enrollment. |
| `trigger_data` | object | optional | both | Context (`appt_id`, `case_id`, etc.) |

`exclusiveOneOf: [['template_type', 'template_id']]` — exactly one of the two must be set.

---

### Log (both engines)

#### `create_log`

Insert a log entry. Used to record events from automations.

| Param | Type | Required | Description |
|---|---|---|---|
| `type` | enum | yes | One of: `email`, `sms`, `call`, `other`, `form`, `status`, `note`, `court email`, `docs`, `appt`, `update` |
| `link_type` | enum | optional | `contact`, `case`, `appt`, `bill` |
| `link_id` | string | optional (placeholderAllowed) | |
| `by` | integer | optional, default 0 | User ID (0 for system/automation) |
| `data` | string | optional, multiline | `log_data` content. JSON string or plain text. Objects stringified at runtime. |
| `from`, `to`, `subject` | string | optional (all placeholderAllowed) | |
| `message` | string | optional, placeholderAllowed, multiline | `log_message` (legacy but still written). |
| `direction` | enum | optional | `incoming`, `outgoing` |

#### `update_log`

Re-link an existing log entry to a different entity. Updates log_link_type / log_link_id / log_link only — never the log content, and never unlinks (both link_type and link_id are required).

| Param | Type | Required | Description |
|---|---|---|---|
| `log_id` | integer | yes (placeholderAllowed) | The log row to re-link. Must already exist — a missing row throws LOG_NOT_FOUND rather than creating one. |
| `link_type` | enum | yes | For 'phone'/'email', link_id is the VALUE itself (normalized to 10 digits / lowercased+trimmed) and the legacy log_link mirror is forced to '' — identical semantics to create_log, sharing the same helpers. The DB column also accepts 'task' and 'event'; those are deliberately excluded here because such rows are machine-written and are not user re-link targets. Widening this list later is additive. |
| `link_id` | string | yes (placeholderAllowed) | Entity ID for contact/case/appt/bill, OR the phone (any format, normalized to 10 digits) / email (lowercased+trimmed) VALUE when link_type is phone/email. Must be non-blank — there is no unlink path. |

Example:
```json
{
  "log_id": "{{logId}}",
  "link_type": "contact",
  "link_id": "{{contactId}}"
}
```

#### `set_log_about`

Set or clear the SECONDARY "what it's about" attribution (log_about_type / log_about_id) on an existing log entry. Never touches the primary identity link (update_log does that) or the log content. about_type 'none' clears the about-link.

| Param | Type | Required | Description |
|---|---|---|---|
| `log_id` | integer | yes (placeholderAllowed) | The log row. Must already exist — a missing row throws LOG_NOT_FOUND rather than creating one. |
| `about_type` | enum | yes (placeholderAllowed) | Full log_link_type enum (wider than update_log's link_type — about=task/event are legitimate topical annotations), plus 'none' to clear the about-link. Accepts a {{placeholder}}. |
| `about_id` | string | optional (placeholderAllowed) | Entity ID for contact/case/appt/bill/task/event, OR the phone (normalized to 10 digits) / email (lowercased+trimmed) VALUE when about_type is phone/email. Required unless about_type is 'none' (then ignored). Target existence is not validated. |

Example:
```json
{
  "log_id": "{{logId}}",
  "about_type": "case",
  "about_id": "{{caseId}}"
}
```

#### `phone_log`

Phone-event log write with forensic catch-all (phone_event_log) + Layer-2 suppression (phone_log_suppressions). Drop-in for create_log in the phone workflows. Same params + same return shape ({success, output:{log_id}}). Stamps extra.firmToFirm (other party is a firm number). Suppression skips the user-facing log only; it does not halt the workflow.

| Param | Type | Required | Description |
|---|---|---|---|
| `type` | enum | yes |  |
| `link_type` | enum | optional (placeholderAllowed) |  |
| `link_id` | string | optional (placeholderAllowed) | Canonical other-party phone (any format, normalized to 10 digits) when link_type=phone. |
| `about_type` | enum | optional (placeholderAllowed) | Optional SECONDARY "what it's about" attribution (log_about_type), independent of the primary identity link. Full log_link_type enum (incl. task/event — wider than update_log link_type; see set_log_about). Omit for no about-link ('none' is NOT accepted here — it is set_log_about's clearing sentinel; on create, omitting the param is the null state). Accepts a {{placeholder}}. |
| `about_id` | string | optional (placeholderAllowed) | Required non-blank when about_type is set. Entity ID for contact/case/appt/bill/task/event, OR the phone (normalized to 10 digits) / email (lowercased+trimmed) VALUE when about_type is phone/email. Target existence is not validated (IDs are opaque). |
| `by` | integer | optional, default `0` |  |
| `data` | string | optional (multiline) | log_data content. Plain text, a JSON string, or an object literal — logService.createLogEntry dual-accepts and stringifies. {{placeholders}} inside an object literal's VALUES resolve normally. |
| `from` | string | optional (placeholderAllowed) |  |
| `to` | string | optional (placeholderAllowed) |  |
| `subject` | string | optional (placeholderAllowed) |  |
| `message` | string | optional (placeholderAllowed, multiline) |  |
| `direction` | enum | optional (placeholderAllowed) |  |
| `extra` | object | optional | log_extra JSON — IT-facing forensic fields (source, message_id, attachments, auth, provider ids, …) kept out of the user-facing log_data render. Pass an object literal; {{placeholders}} inside its VALUES resolve normally. The params_mapping path (unvalidated) may also supply a JSON-string-of-object — logService.createLogEntry parses either form and writes SQL NULL for anything that is not a plain object. |

Example:
```json
{
  "type": "sms",
  "link_type": "phone",
  "link_id": "{{their_number}}",
  "by": 0,
  "direction": "incoming",
  "from": "{{from}}",
  "to": "{{to}}",
  "message": "{{body}}"
}
```

The phone-side ingest pipeline was extracted out of this function — see
[chapter 10](10-ingest.md). This remains the way to write a phone log row
from a workflow.

---

### Contacts (both engines)

#### `lookup_contact`

Fetch a contact by ID. Returns the row as `output`.

| Param | Type | Required | Description |
|---|---|---|---|
| `contact_id` | string | yes (placeholderAllowed) | |

Output shape: a `contacts` row with all non-blocked columns. `contact_ssn` is excluded (blocked column).

#### `update_contact`

Update one or more fields on a contact row. Whitelisted columns only.

| Param | Type | Required | Description |
|---|---|---|---|
| `contact_id` | string | yes (placeholderAllowed) | |
| `fields` | object | yes | Column → value pairs |

**Allowed columns:**
```
contact_type, contact_fname, contact_mname, contact_lname, contact_pname,
contact_phone, contact_email, contact_address, contact_city, contact_state,
contact_zip, contact_dob, contact_marital_status, contact_ssn,
contact_tags, contact_notes, contact_clio_id, contact_phone2, contact_email2
```

**Blocked columns** (auto-managed or sensitive):
- `contact_id` (PK, immutable)
- `contact_name`, `contact_lfm_name`, `contact_rname` (trigger-computed from fname/mname/lname)
- `contact_created` (set once at insert)
- `contact_updated` (auto-managed)

Note: `contact_ssn` *is* in the writable allowlist — contradicting the resolver's blocklist. The resolver blocks reading SSN; this function allows writing it. Intentional asymmetry: automations might need to ingest an SSN from a form submission, but no automation should be allowed to read one back out.

DB triggers `contact_name_update` (recomputes derived names) and `after_contact_update` (auto-logs to `log` table) fire automatically — no need to log manually from the function.

Returns:
```json
{ "success": true, "output": { "contact_id": <id>, "updated_fields": ["contact_tags", "contact_type"] } }
```

#### `find_contact`

Find contacts by phone and/or email value. Returns ALL matches; caller decides on ambiguity.

| Param | Type | Required | Description |
|---|---|---|---|
| `phone` | string | optional (placeholderAllowed) | Phone value (any format). Normalized to 10 digits before search. |
| `email` | string | optional (placeholderAllowed) | Email value (any case/spacing). Trimmed + lowercased before search. |
| `include_ended` | boolean | optional, default true | Include ended child-table rows (orphan-log auto-re-adopt). Default true. |
| `include_legacy_secondary` | boolean | optional, default true | Also check contact_phone2 / contact_email2. Default true. |

Example:
```json
{
  "phone": "{{trigger.from_phone}}"
}
```

---

### Users (both engines)

#### `lookup_user`

Resolve **one** staff user (the `users` table — firm staff, not clients) from a single free-text box and return their record. Fills the gap that previously forced a hand-written `query_db` step whenever a workflow held a `tasks.task_to` / `appts.appt_with` / `log.log_by` id and needed a name, email or phone.

| Param | Type | Required | Description |
|---|---|---|---|
| `user` | string | yes (placeholderAllowed) | The one box: user id, username, initials, display/first/last name, email, or phone. `0` is a valid id (Automations). |
| `match` | enum | optional, default `auto` | `auto`, `id`, `username`, `initials`, `name`, `email`, `phone`. Pins the interpretation. |
| `fields` | string | optional (placeholderAllowed, strictString) | Comma-separated subset to return. Default: all. Unknown names throw. |
| `missing_ok` | boolean | optional, default `false` | `true` → no match returns `found: false` instead of throwing. |
| `output_var` | string | optional | Also stash the whole map in this variable (`{{assignee.email}}`). |

**Auto-detect order.** `auto` walks tiers and stops at the **first tier that produces a hit** — it does not OR them together, which is what stops `SS` (initials) from colliding with `Sandweiss` (surname):

`id` → `email` → `phone` → `username` → `initials` → exact `name` → fuzzy `name`

- `id` — 1–3 digits only. `users.user` is a `tinyint`, so an id and a 10-digit phone can never be confused.
- `email` — matches `email` **or** `default_email`, case-insensitive.
- `phone` — matches `phone` **or** `default_phone`, normalized to 10 digits (`+1`, dashes, parens all fine).
- `name` (exact) — `user_name`, `user_real_name`, `"First Last"`, `user_fname`, `user_lname`.
- `name` (fuzzy) — substring over the same set plus `username`. Requires ≥ 2 characters.

**Output** is flat, so `{{this.email}}` works exactly like `lookup_contact`:

| Key | Notes |
|---|---|
| `found` | boolean; always present, ignores `fields` |
| `matched_by` | which tier hit (`id`, `email`, `phone`, `username`, `initials`, `name`, `name_fuzzy`) or `null` |
| `user`, `username`, `user_name`, `user_real_name`, `user_fname`, `user_lname`, `user_initials` | identity |
| `user_type`, `user_auth`, `roles` | privilege |
| `email`, `default_email`, `phone`, `default_phone` | see the pairing note below |
| `allow_sms`, `does_appts`, `ringcentral`, `task_remind_freq`, `user_gcal_id`, `freebusy_calendar_ids` | capability / config |
| `phone_formatted`, `default_phone_formatted` | derived — `(248) 555-0100` |
| `roles_list` | derived — `roles` csv as an array, so `foreach` can walk it |

**`email`/`phone` vs `default_email`/`default_phone` are not duplicates.** `email` and `phone` are the staffer's **contact** addresses — what `job_executor.js`, `portalCallbackService.js` and `run_task_digest` notify. `default_email` and `default_phone` are their preferred **sending** identity (the Settings picker default; see `routes/auth.profile.js`). Automation that notifies a user wants the first pair; automation that sends *as* a user wants the second. They are returned separately rather than collapsed into one "best" field, because collapsing them picks the wrong semantic half the time.

**Blocked columns** — never SELECTed, never addressable via `fields`:
- `password`, `password_hash`, `reset_token`, `reset_expires` (credential material)
- `user_custom_tab` (per-user UI state blob, no automation value)

The SELECT is an explicit whitelist rather than `SELECT *` (which `lookup_appointment` uses on `appts`) precisely because `users` carries credential columns — a sensitive column added to the table later cannot auto-leak into workflow output, it has to be opted into `RETURNED_COLUMNS`.

**Ambiguity always throws**, even under `missing_ok`, and names the candidates:

```
lookup_user: "Sandweiss" matched 2 users by name
(#1 Stuart Sandweiss (Ssandweiss), #2 Valerie Sandweiss (VS)).
Use a more specific value, or set match to pin the lookup type.
```

Same typo-protection philosophy as `get_settings`' all-or-nothing: a silently-wrong user id causes subtler downstream bugs (an SMS to the wrong staffer) than a failed step. `missing_ok` softens **not-found** only.

Example:

```json
{
  "function_name": "lookup_user",
  "params": { "user": "{{task_to}}" },
  "set_vars": {
    "assigneeName":  "{{this.user_name}}",
    "assigneeEmail": "{{this.email}}",
    "assigneePhone": "{{this.phone}}"
  }
}
```

`lookup_user` deliberately does **not** filter on `user_auth` — it answers "who is id 4?", and the honest answer for a disabled ex-employee is their row plus `user_auth: 'disabled'`, not "not found". Branch on `{{this.user_auth}}` if the caller must not act on a disabled user. (`list_users`, below, filters them out by default — different question, different answer.)

#### `list_users`

The fan-out companion: return **every** user matching a filter, as an array built to feed straight into `foreach`. Covers "notify every attorney", "round-robin across whoever does appointments", "SMS everyone who opted in".

| Param | Type | Required | Description |
|---|---|---|---|
| `role` | string | optional (placeholderAllowed, strictString) | csv of roles: `it`, `admin`, `staff`, `attorney`, `automation`. Unknown names throw. |
| `role_match` | enum | optional, default `any` | `any` = has at least one listed role. `all` = has every one. |
| `does_appts` | boolean | optional | Tri-state — omit for no filter. |
| `allow_sms` | boolean | optional | Tri-state. Who opted in to SMS. |
| `ringcentral` | boolean | optional | Tri-state. |
| `has_email` | boolean | optional | Non-empty `email` (the **contact** column, not `default_email`). |
| `has_phone` | boolean | optional | `phone` normalizes to 10 digits (contact column, not `default_phone`). |
| `ids` | string | optional (placeholderAllowed) | csv of user ids to restrict to. Bare number works for one id. |
| `exclude` | string | optional (placeholderAllowed) | csv of user ids to drop. |
| `active_only` | boolean | optional, **default `true`** | Drops `user_auth = 'disabled'`. |
| `include_automation` | boolean | optional, **default `false`** | Drops user 0 (`user_type = 0`). |
| `sort` | enum | optional, default `user_name` | `user_name`, `user_lname`, `user_initials`, `user`. Ties break on id. |
| `fields` | string | optional (placeholderAllowed, strictString) | csv subset per user. Default: all. |
| `require_any` | boolean | optional, default `false` | `true` throws when nothing matched. |
| `output_var` | string | optional | Stores the users **array** — feed straight to `foreach`. |
| `count_var` | string | optional | Stores the count. |

**The two defaults that matter.** There is no `DELETE` for users — `routes/admin.users.js` is explicit that *"removing" a user means disabling them*, and `routes/auth.login.js` gates login on `user_auth.startsWith('authorized')`. A `list_users` that didn't filter on that by default would have every "email all staff" workflow quietly mailing ex-employees forever. Likewise user 0 is the `automations` pseudo-user (`user_type = 0`, `admin@4lsg.com`), which `public/index.html`'s task-assignee picker already filters out with `.filter(u => u.user_type)`.

**One implication, deliberately asymmetric.** Naming `automation` in `role` turns `include_automation` on — that filter is otherwise guaranteed empty, and a hand-written role filter is unambiguously on purpose. `ids` gets **no** such implication: those lists are usually machine-generated (`SELECT DISTINCT log_by`, etc.) and user 0 appears in them constantly, so auto-including it there would reintroduce the exact "notify everyone who touched this case → emails admin@4lsg.com" bug the default exists to prevent. An explicit `include_automation` always wins over the implication.

**Output:**

| Key | Notes |
|---|---|
| `users` | array of per-user maps (same field set as `lookup_user`, honoring `fields`) — the `foreach` target |
| `count` | number |
| `has_users` | boolean — branch on this instead of setting `require_any` |
| `ids` | `number[]` |
| `emails` | `string[]` — non-empty `email` values, deduped, in sort order |
| `emails_csv` | the above joined with `", "` |
| `phones` | `string[]` — `phone` normalized to 10 digits |

`ids` / `emails` / `phones` are built from the **full** rows, so they stay populated even when `fields` narrows the per-user maps to something that excludes those columns.

`emails_csv` is a single multi-recipient `send_email.to` on the smtp and gmail adapters (both hand `to` to nodemailer/MailComposer verbatim). The pabbly adapter posts to an opaque webhook, so its multi-recipient behavior is not guaranteed — and looping is what you want anyway whenever the body is personalized.

Fan out over attorneys:

```json
// step 3
{
  "function_name": "list_users",
  "params": { "role": "attorney", "has_email": true },
  "set_vars": { "attorneys": "{{this.users}}" }
}
// step 4
{
  "function_name": "foreach",
  "params": { "list": "{{attorneys}}", "item_var": "atty", "end_step": 7 }
}
// step 5 — send_email to "{{atty.email}}"
// step 6 — set_next back to 4
```

Or in one shot, no loop:

```json
{
  "function_name": "list_users",
  "params": { "role": "staff", "has_email": true },
  "set_vars": { "staffEmails": "{{this.emails_csv}}" }
}
```

---

### Appointments (both engines)

#### `create_appointment`

Create a new appointment with full side effects (log, 341 update, sequence cancel, GCal, reminder workflow). Delegates to `apptService.createAppt`.

| Param | Type | Required | Description |
|---|---|---|---|
| `contact_id` | string | yes (placeholderAllowed) | Primary contact. |
| `case_id` | string | optional (placeholderAllowed) | Usually provided. |
| `appt_date` | iso_datetime | yes (placeholderAllowed) | Datetime in firm local time. |
| `appt_type` | string | yes | `"341 Meeting"`, `"Strategy Session"`, etc. |
| `appt_length` | integer | yes | Length in minutes. |
| `appt_platform` | enum | yes | `Telephone`, `Zoom`, `In-person` |
| `appt_with` | integer | optional, default 1 | User ID. |
| `note` | string | optional, multiline | |
| `confirm_sms` | boolean | optional, default false | |
| `confirm_email` | boolean | optional, default false | |
| `confirm_message` | string | optional (placeholderAllowed, multiline) | Required if either confirm flag is true. |
| `acting_user_id` | integer | optional, default 0 | User ID for log entry; 0 = system. |

#### `lookup_appointment`

Fetch a single appointment by ID. Returns the row as `output`.

| Param | Type | Required |
|---|---|---|
| `appointment_id` | string | yes (placeholderAllowed) |

#### `update_appointment`

Update fields on an appointment row.

| Param | Type | Required | Description |
|---|---|---|---|
| `appointment_id` | string | yes (placeholderAllowed) | Target `appt_id`. |
| `fields` | object | yes | Column → value pairs. |

**Allowed columns:**
```
appt_client_id, appt_case_id, appt_type, appt_length,
appt_form, appt_status, appt_date, appt_gcal,
appt_ref_id, appt_note, appt_platform, appt_with
```

**Blocked columns:**
- `appt_id` (PK)
- `appt_end` (GENERATED ALWAYS AS `appt_date + interval appt_length minute`)
- `appt_create_date` (set once)

Reminder: `appt_status` is Title Case with spaces — `Scheduled`, `Attended`, `No Show`, `Canceled` (one L), `Rescheduled`. Setting it to `no_show` will silently fail to match anywhere downstream.

Returns:
```json
{ "success": true, "output": { "appointment_id": <id>, "updated_fields": [...] } }
```

#### `get_appointments`

Query the `appts` table with optional filters. Returns matching rows in a format suitable for email/SMS/variable storage.

| Param | Type | Required | Description |
|---|---|---|---|
| `status` | string | optional | `appt_status` filter (e.g. `"Scheduled"`, `"No Show"`). Omit for all. |
| `date` | string | optional (placeholderAllowed) | `"today"`, `"tomorrow"`, or ISO date `"YYYY-MM-DD"`. |
| `from` | iso_datetime | optional (placeholderAllowed) | Lower bound on `appt_date`. |
| `to` | iso_datetime | optional (placeholderAllowed) | Upper bound on `appt_date`. |
| `contact_id` | string | optional (placeholderAllowed) | |
| `case_id` | string | optional (placeholderAllowed) | |
| `appt_type` | string | optional | |
| `limit` | integer | optional, default 200, max 1000 | |
| `format` | enum | optional, default `raw` | `raw`, `html_rows`, `count` |
| `output_var` | string | optional | Workflow variable name to store results under. |
| `count_var` | string | optional | Workflow variable name to store row count. |
| `date_var` | string | optional | Workflow variable name to store formatted date string (`"Wednesday, March 18, 2026"`). |
| `base_url` | string | optional | Base URL for links in `html_rows` output. |

Note `date` is a single-day filter that takes precedence over `from`/`to`. There is no `appt_with` filter — query through `query_db` if you need that.

#### `cancel_case_appointments`

Cancel every future Scheduled appointment on a case (terminal-stage cascade: dismissed/closed). ALWAYS silent — no client SMS/email, by construction. Each cancel runs apptService.cancelAppt's full side-effect chain (automation cancel, no_show sequence cancel, GCal delete, log row). Per-appt failures are isolated and reported in output, never thrown. "Future" = appt_date >= firm-local now unless `from` overrides it.

| Param | Type | Required | Description |
|---|---|---|---|
| `case_id` | string | yes (placeholderAllowed) |  |
| `from` | string | optional (placeholderAllowed) | Firm-local lower bound on appt_date, "YYYY-MM-DD[ HH:mm[:ss]]". Default: now. Pass a past date to sweep stale already-elapsed Scheduled rows (backfill use). |
| `appt_type` | string | optional | CSV of appt_type values to limit the sweep, e.g. "341 Meeting". Omit for all types. |
| `note` | string | optional (multiline) | Appended to each canceled appt's note and log row. |
| `acting_user_id` | integer | optional, default `0` (placeholderAllowed) | User ID for log entries. Defaults to 0 (system). |
| `source` | enum | optional, default `system` | Appt log source. Defaults to "system". |

Example:
```json
{
  "case_id": "{{case_id}}",
  "note": "Auto-canceled: case dismissed (court)"
}
```

#### `find_live_calendar_item`

Find live (Scheduled) calendar rows — events AND appts — matching a singleton identity: registry type_key + an anchor (case_id, docket, or contact_id). Read-only. Returns { items: [{ source, id, starts_at }], count }.

| Param | Type | Required | Description |
|---|---|---|---|
| `type_key` | string | yes | calendar_item_types.type_key, e.g. meeting_341. |
| `case_id` | string | optional (placeholderAllowed) | Case anchor. Wins over docket/contact when present. |
| `docket` | string | optional (placeholderAllowed) | Docket anchor (either case_number form). Resolved to its case when one exists. |
| `contact_id` | string | optional (placeholderAllowed) | Contact anchor (events only — appts have no contact singleton identity). |

Example:
```json
{
  "type_key": "meeting_341",
  "docket": "{{court_case_number}}"
}
```

---

### General-purpose (both engines)

#### `query_db`

JSON-descriptor SQL query against a whitelisted set of tables. Replaces the unsafe `custom_code` + raw SQL pattern.

| Param | Type | Required | Description |
|---|---|---|---|
| `select` | array | yes | Columns to select. `["*"]` for all from `from`. e.g. `["contacts.contact_name", "appts.appt_date"]` |
| `from` | string | yes | Base table name (whitelisted). |
| `join` | array | optional | JOIN clauses: `{ type, table, alias?, on: {left, right} }` |
| `where` | array | optional | Each: `{ column, op, value? }`. Placeholders OK in `value`. |
| `where_mode` | enum | optional, default `and` | `and` or `or` |
| `order_by` | array | optional | Each: `{ column, dir: "asc"\|"desc" }` |
| `limit` | integer | optional, default 100, max 1000 | |
| `format` | enum | optional, default `raw` | `raw`, `html_rows`, `count`, `first` |
| `output_var` | string | optional | Workflow variable to store results. |
| `count_var` | string | optional | Workflow variable to store row count. |
| `base_url` | string | optional | For `html_rows` link generation. |
| `html_columns` | array | optional | Per-column display config: `{ column, label, link_base?, link_id? }` |

The whitelist of allowed tables matches the resolver's whitelist — see chapter 6.

#### `insert_db`

Parameterized single-row INSERT from a JSON descriptor — no raw SQL. Whitelisted tables with insert:true only (rw_scratch, checkitems, checklists, case_relate, contact_phones, contact_emails, contact_addresses, judges, trustees). app_settings is update-only (create keys in the DB console); tasks is update-only (use create_task). PK / auto_increment / generated / timestamp columns are never settable. Duplicate-key collisions throw.

| Param | Type | Required | Description |
|---|---|---|---|
| `table` | string | yes (placeholderAllowed) | Writable table with insert:true (see description). _wdbValidateTable rejects a non-string identifier. |
| `values` | object | yes | { column: value, ... }. Scalars or null only — JSON.stringify structured values. |
| `output_var` | string | optional | Store the new row id in this workflow variable. |

Example:
```json
{
  "table": "checkitems",
  "values": {
    "checklist_id": "{{listId}}",
    "name": "Send 341 reminder",
    "status": "incomplete"
  },
  "output_var": "newItemId"
}
```

#### `update_db`

Parameterized UPDATE from a JSON descriptor — no raw SQL. Whitelisted tables only (app_settings, rw_scratch, tasks, checkitems, checklists, case_relate, contact_phones, contact_emails, contact_addresses, judges, trustees). WHERE is mandatory, restricted to identity columns, and LIKE is excluded. max_rows defaults to 1 — the UPDATE is REFUSED if the where clause matches more rows than that. PK / auto_increment / generated / created_at / updated_at columns are never settable. From ingest-rule actions and hook targets use the flat set_column/set_value + where_column/where_value form — their params_mapping does not recurse into nested objects.

| Param | Type | Required | Description |
|---|---|---|---|
| `table` | string | yes (placeholderAllowed) | Writable table (see description). _wdbValidateTable rejects a non-string identifier. |
| `set` | object | optional | Rich form: { column: value, ... }. Workflow/scheduled-job steps only — placeholders resolve at any depth there. Mutually exclusive with set_column. |
| `where` | array | optional | Rich form: [{ column, op?, value }]. Columns limited to the table policy. Mutually exclusive with where_column. |
| `set_column` | string | optional (placeholderAllowed) | Flat form: the single column to set. Use from ingest actions / hook targets. |
| `set_value` | string | optional (placeholderAllowed, multiline) | Flat form: the value for set_column. Scalar or null. |
| `where_column` | string | optional (placeholderAllowed) | Flat form: identity column to match (op is always "="). |
| `where_value` | string | optional (placeholderAllowed) | Flat form: the value for where_column. |
| `max_rows` | integer | optional, default `1` | Refuse the UPDATE if the where clause matches more rows than this. |
| `output_var` | string | optional | Store affected_rows in this workflow variable. |

Example:
```json
{
  "table": "checkitems",
  "set": {
    "status": "complete"
  },
  "where": [
    {
      "column": "id",
      "op": "=",
      "value": "{{itemId}}"
    }
  ]
}
```

Two call shapes on purpose. The **rich** form (`set` / `where`) is for
workflow and scheduled-job steps, where placeholders resolve at any depth.
The **flat** form (`set_column` / `set_value` / `where_column` /
`where_value`) exists for ingest actions and hook targets, whose param
mapping is one level deep. Pick one; mixing them is rejected.

`max_rows` is the guard rail worth setting on anything that isn't keyed by
a primary key — the UPDATE is refused if the where clause matches more rows
than that.

---

### AI (both engines)

#### `query_ai`

Send a prompt (plus optional untrusted input text) to Claude and use the response. Thin wrapper over `services/aiService.js`: credential id 12, per-attempt `ai_calls` logging (tokens / cost / latency, `consumer_ref='query_ai'`), `<untrusted_user_input>` wrapping, and JSON parse with one strict retry all live in the service.

| Param | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | Instructions (the system prompt). `{{placeholders}}` resolve before sending. **Never paste foreign text here — use `input`.** |
| `input` | string | optional | The data to analyze (email body, inbound message, a `query_db` result). Wrapped in `<untrusted_user_input>` tags with a never-obey guard. Non-string values (e.g. an object via the engine's single-placeholder fast path) are `JSON.stringify`'d. |
| `model` | enum | optional, default `claude-sonnet-4-6` | `claude-sonnet-4-6` (smarter) or `claude-haiku-4-5-20251001` (cheaper/faster for simple parses). Adding a model = add to the `__meta` enum **and** `aiService` `MODEL_PRICING` (unknown models log `cost_cents = null`). |
| `output_type` | enum | optional, default `text` | `json`: response is fence-stripped and parsed (one strict retry on garbage); the step's output is the parsed **object**. `text`: raw text. |
| `max_tokens` | integer | optional, default 1024, max 8192 | Response length cap. |
| `timeout_ms` | integer | optional, default 20000, clamped 1000–60000 | Per-attempt API timeout. Long compositions at high `max_tokens` may need more than the 20s default. |
| `output_var` | string | optional | Also copy the output into a named workflow variable for later steps (same convention as `query_db`). |

Output access: in the **same step's** `set_vars`, use `{{this.output}}` (text) or `{{this.output.field}}` (json object). Later steps must use `output_var` — the next step's `this` is reset.

Failure (`api_error`, `timeout`, `no_auth`, or `json_parse` after the retry) throws, so the step's `error_policy` applies. **Every attempt is billed and logged as its own `ai_calls` row** — `error_policy` retries re-bill, and a json call that needs the strict retry costs two calls. Prompts that demand raw-JSON-only output ("no prose, no code fences") usually parse on the first attempt.

Prompt-injection boundary: the engine resolves `{{placeholders}}` in **all** params before the function runs, so nothing technically stops `{{trigger.email_body}}` inside `prompt` — but only `input` gets the untrusted-content guard. Instructions go in `prompt`; foreign text goes in `input`.

```json
{
  "function_name": "query_ai",
  "params": {
    "prompt": "Extract the caller's callback phone number from the email. Respond with raw JSON only — no prose, no code fences: {\"phone\": string|null}",
    "input": "{{trigger.email_body}}",
    "output_type": "json",
    "output_var": "parsed"
  },
  "set_vars": { "callbackPhone": "{{this.output.phone}}" }
}
```

#### `ai_match`

Match text (e.g. an email) against a registry match set (ai_match_sets/ai_match_types) and extract each matched type's declared fields with verbatim citations. The prompt is generated from the registry; the model can only emit keys from the closed list; citations are verified per field (required-field failure flags the match, optional-field failure drops the field). Foreign text always rides inside the injection guard and every attempt is logged to ai_calls. Returns {matches, act_matches, flags, unmatched_candidates}; route matches downstream with foreach + evaluate_condition/start_workflow — this step never dispatches anything itself.

| Param | Type | Required | Description |
|---|---|---|---|
| `set_key` | string | yes (placeholderAllowed) | ai_match_sets.set_key to match against (e.g. "court_nef"). |
| `subject` | string | optional (placeholderAllowed) | Untrusted subject line. Rides inside the injection guard; part of the citation haystack. |
| `from_email` | string | optional (placeholderAllowed) | Untrusted sender. Rides inside the injection guard. |
| `body` | string | optional (placeholderAllowed) | Untrusted body text. Rides inside the injection guard; part of the citation haystack. |
| `source_ref` | string | optional (placeholderAllowed) | Our own reference id (e.g. message_id) — the only trusted metadata shown to the model; also stamped into ai_calls consumer_ref. |
| `output_var` | string | optional | Also copy the full result into this named variable for later steps (foreach over {{var.matches}}). |
| `model` | string | optional | Model override. Default claude-sonnet-4-6. |
| `max_tokens` | integer | optional | Response token cap. Default 2000. |

Example:
```json
{
  "set_key": "court_nef",
  "subject": "{{subject}}",
  "from_email": "{{from_email}}",
  "body": "{{body}}",
  "source_ref": "{{message_id}}",
  "output_var": "court"
}
```


Part of **court parser v2** — the registry-driven extraction layer. See
[The court email pipeline](../05-Subsystems/10-court-pipeline.md#parser-v2--the-extraction-layer-being-rebuilt)
for the match-set registry, the citation contract and the stage map.

---

### PDF

#### `parse_pdf` (both engines)

Extract text from a PDF (by URL, Dropbox path, or Dropbox file shared link) for use in later steps — e.g. feed `{{this.output.text}}` or an `output_var` into `query_ai`'s `input`. **Text-layer extraction only, no OCR** — scanned/image-only PDFs return empty text; for scans use `query_ai` with a file attachment instead. 25MB cap; page selection (`"2-4,6"`), `from_text`/`to_text` anchors, `max_length` truncation. Provide exactly one of `url` / `dropbox_path` / `dropbox_link`. Full param detail in `lib/internal_functions/pdf.js` `__meta`.

#### `render_submission_pdf` (workflow only) — X5

Render one **submitted** form submission (`form_submissions.id`) to an archival PDF — the layout the submitter saw (version-matched definition, `showWhen` honored against the submitted answers, option labels, masks, Yes/No checkboxes, "—" blanks; `hidden`/`embed` fields omitted) — and file it to Dropbox. Wraps `services/formPdfService.js`.

| Param | Type | Required | Description |
|---|---|---|---|
| `submission_id` | integer | yes | `form_submissions.id` of a **submitted** submission. onSubmit workflows receive it in `init_data` as `{{submission_id}}`. Drafts are refused. |
| `filename` | string | optional | Replaces the `{date} {form title} (#id)` filename core. Sanitized; `.pdf` enforced; unsorted identity prefixes still apply. |
| `output_var` | string | optional | Also copy the output object into a named workflow variable (`query_db`/`query_ai` convention). |

**Placement ladder** (Fred's 2026-08-14 ruling — non-case submissions file, they don't error):

- **case-linked** → `<case folder>/Forms/`. No linked folder → `ensureCaseDropboxFolder` auto-creates + links one and raises a staff task (source `form_pdf`). Dead link / failure → the unsorted client-uploads bin, in the same per-case subfolder the client-upload ladder uses, plus a move-task raised **after** the upload lands.
- **contact / appt / unlinked** → the unsorted bin as a loose file with an identity prefix (`contact 12 - Jane Doe - …`, `appt 45 - …`, `submission 288 - Bob - …`). **No task** — the Form Inbox already surfaces unlinked submissions.
- Everything failed → throws; the step's `error_policy` applies. A retry after a mid-flight failure may file a second copy (Dropbox autorename) — never lose one.

**Output** (same step: `{{this.output.…}}`; later steps: `output_var`): `path` (the path **Dropbox returned** — autorename-authoritative), `file_name`, `placement` (`case`|`unsorted`), `placement_note`, `temp_link`, `temp_link_expires_note`, `warnings`, `submission_id`, `form_key`, `link_type`, `link_id`.

`temp_link` is a Dropbox **temporary download link (~4h expiry, no permanent ACL)** for `send_email`'s `attachment_urls` — and it is **best-effort**: the filing never fails over the link, so it may be `null` with a warning explaining why. Guard email steps accordingly.

Chromium renders are serialized on the container — treat this as a heavyweight step, not a loop body. Workflow-only (`__meta.workflowOnly`); the filename date is the submission's **created_at** in firm time (adopt bumps `updated_at`, so it stops meaning "submitted").

**How it's wired in practice (X5.1).** Forms opt in with `onSubmit.pdf: true`, which both form dispatchers inject into the workflow's `init_data` as **`make_pdf`** (always defined, always from the published definition). wf 40 — the shared form-notify workflow — gates on it:

```
2  PDF wanted?            evaluate_condition  make_pdf == true  → 3, else 4
3  Render submission PDF  webhook → POST {app_url}/api/forms/submissions/
                            {{submission_id}}/pdf/file, credential 1
                            (YisraCase Internal), set_vars {"pdf": "{{this}}"}
                                                              [error_policy: ignore]
4  Notify office          send_email  attachment_urls:
                            [{ "url": "{{pdf.temp_link}}", "name": "{{pdf.file_name}}" }]
```

**Why step 3 is a webhook to our own URL rather than this function in-process** (2026-08-14): workflow steps run **detached, after the HTTP response is sent**, and under Cloud Run's default billing setting an instance only gets CPU while it is processing a request. Chromium cannot start on the sliver left over. Measured on identical code: the Form Inbox PDF button (in-request) always worked, while a form submission on an idle instance failed — first on a 30 s browser-launch timeout, then on a 15 s navigation timeout, the moving failure point being the signature of starvation rather than a broken browser. Calling the app's own route turns the render back into a real request, which Cloud Run serves with a full vCPU; because CPU is allocated per *instance*, the background step awaiting the response speeds up alongside it. The alternative — instance-based billing (`--no-cpu-throttling`), which would fix every background step — priced out at ~$47/month for this service's 1 vCPU / 1 GiB, since the 5-minute scheduler ping keeps an instance alive 24/7. Rejected: the only thing actually *broken* was chromium; everything else is merely slower.

Note the placeholder is `{{this}}`, **not** `{{this.output}}` — for a webhook step, `this` is the parsed response body (see 06 — Variables & Templating). Because the route returns the same verdict object the function does, step 4 needs no change.

The `ignore` policy is deliberate: a PDF failure must never cost the office its notification. When no PDF was rendered, `{{pdf.temp_link}}` resolves to `''` and the mail adapters drop a url-less attachment silently, so the email sends unchanged — **that is the empty fallback, and it needs no filter syntax** (there is none in the workflow resolver; see 06 — Variables & Templating). The gmail adapter fetches the URL into the MIME body server-side, so recipients get real bytes and the ~4-hour link expiry never reaches a mailbox.

Staff can also render on demand, outside any workflow: `GET /api/forms/submissions/:id/pdf` (bytes, no filing) and `POST /api/forms/submissions/:id/pdf/file` (files on the same ladder), wired to the **PDF** and **File** buttons in the Form Inbox and on each case's Form Submissions tab.

```json
{
  "function_name": "render_submission_pdf",
  "params": { "submission_id": "{{submission_id}}", "output_var": "intake_pdf" }
}
```
…then:
```json
{
  "function_name": "send_email",
  "params": {
    "to": "…", "subject": "New intake form",
    "body": "Attached. Filed to {{intake_pdf.path}}",
    "attachment_urls": [{ "url": "{{intake_pdf.temp_link}}", "name": "{{intake_pdf.file_name}}" }]
  }
}
```

---

### Dev / testing

#### `set_test_var`

Sets `testKey = "hello"`. **Dev/testing only.** Listed in `SEQUENCE_EXCLUDED` so it doesn't appear in sequence dropdowns, but is callable in workflows in production. Worth gating behind `NODE_ENV !== 'production'` or a superuser check (logged separately as a backlog item).

```js
set_test_var: async () => {
  console.log('[SET_TEST_VAR] Setting testKey = "hello"');
  return { success: true, set_vars: { testKey: 'hello' } };
}
```

No params. Returns `{ success, set_vars: { testKey: 'hello' } }`.

---

### Cases and pipeline (both engines)

Stage movement is guarded, not free-form — see [Pipelines](../01-YisraCase-overview/13-pipelines.md) for what the stages mean.

#### `advance_stage`

Advance a case to a pipeline stage. Appends a `case_stage_log` row and
overwrites `cases.case_stage` / `case_status` / `case_rec` from the stage.
Repeating the current stage is a safe no-op (`output.noop=true`); skipping
stages is legal.

**Guards.** Three optional params make the advance conditional, and **all
supplied guards must pass**. A guard miss — or a guarded `stage_key` that
doesn't exist in the case's current template — **skips quietly**:
`output.skipped=true`, nothing written, no error.

- `only_from` — the stage_keys the case must currently be at.
- `only_from_role` — the *role* (intake / case) of the template the case's
  latest log row belongs to. Judged by the log row's template, not the
  currently-resolved one, so a case whose subtype was just written still
  counts as coming from intake.
- `forward_only` — advance but never regress, without listing from-states.

The token `"none"` in `only_from` / `only_from_role` means "case has no
pipeline history yet."

**Output** carries `noop`, `skipped`, `reason`, `from`, `stage_key`,
`case_stage`, `status_label` — capture via `set_vars` if you need to branch.
`reason: "backward"` means `forward_only` refused a regression;
`"unresolved"` means a stage_key couldn't be matched.

| Param | Type | Required | Description |
|---|---|---|---|
| `case_id` | string | yes (placeholderAllowed) |  |
| `stage` | string | yes (placeholderAllowed) | stage_key (e.g. "filed") resolved within the case's pipeline template, or a numeric pipeline_stages id (escape hatch — any template). |
| `note` | string | optional (placeholderAllowed) | Optional log note (truncated to 255 chars). |
| `only_from` | string | optional (placeholderAllowed) | Guard: comma-separated stage_keys — advance ONLY if the case's latest log row carries one of them. Token "none" = case has no log rows yet. Miss → output.skipped=true, nothing written. Blank/absent = unguarded. In a params_mapping this is ONE quoted literal holding the whole list — 'lead,none' — NOT a list of literals ('lead','none'), which resolves to an unmatchable guard and now errors. |
| `only_from_role` | string | optional (placeholderAllowed) | Guard: comma-separated pipeline template roles (intake, case) — advance ONLY if the case's latest log row belongs to a template with one of these roles (judged by the LOG ROW's template, not the currently-resolved one — a case whose subtype was just written still counts as coming from intake). Token "none" = case has no log rows yet. Miss → output.skipped=true. Combines with only_from (both must pass). Blank/absent = unguarded. In a params_mapping this is ONE quoted literal holding the whole list — 'intake,none' — NOT a list of literals. |
| `forward_only` | string | optional (placeholderAllowed) | Guard: advance but NEVER regress, without having to list every legal from-state. Accepts true/1/yes (armed) or false/0/no (off); blank or absent = off. An unrecognized value is an ERROR, not "off" — a silently disarmed guard would write backward advances with nothing to notice. When armed: entering a later stage of the same template passes; entering an OFF-RAMP (lane=offramp: no_show, dead_lead, dismissed, appeal, …) passes from anywhere, including from another off-ramp; moving to an earlier stage, or from an off-ramp back onto the main path, SKIPS with reason "backward". Across templates only intake→case (the retention bootstrap) and same-role matter changes pass — stage numbers are per-template and are not compared. Repeating the current stage stays a plain no-op, never "backward". Combines with only_from / only_from_role (all must pass). |

Example:
```json
{
  "case_id": "{{caseId}}",
  "stage": "filed",
  "note": "Auto-advanced on petition filing"
}
```

**The guards are the point.** `forward_only` is the one to reach for by
default: it lets automation push a case along without ever dragging it
backwards, and it saves you from enumerating every legal from-state in
`only_from`. Repeating the current stage is a safe no-op, so a rule that
fires twice does not double-log.

#### `update_case`

Update one or more fields on a case row. Whitelisted columns only — non-whitelisted columns are rejected at runtime with the blocked names (see ALLOWED in update_case: docket, dates, stage/status/chapter, 341 fields, docs/forms, judge/trustee, clio, notes). case_number / case_number_full are opaque strings — no shape validation.

| Param | Type | Required | Description |
|---|---|---|---|
| `case_id` | string | yes (placeholderAllowed) |  |
| `fields` | object | yes | Column → value pairs. Whitelist enforced at runtime. |

Example:
```json
{
  "case_id": "{{caseId}}",
  "fields": {
    "case_stage": "Filed"
  }
}
```

### Events (both engines)

Events are dated obligations — hearings, deadlines, milestones — distinct from appointments. See [Events](../01-YisraCase-overview/08-events.md).

#### `create_event`

Create a first-class dated obligation (hearing, deadline, milestone) with log + GCal create + optional reminder task. Deduplicates by default. Delegates to eventService.createEvent.

| Param | Type | Required | Description |
|---|---|---|---|
| `event_title` | string | yes (placeholderAllowed) |  |
| `event_date` | string | yes (placeholderAllowed) | Obligation date "YYYY-MM-DD" (firm-local). |
| `event_type` | string | optional | Opaque category, e.g. "Confirmation Hearing", "Docs Deadline". |
| `event_link_type` | enum | optional | Omit for an internal/unlinked event. "case_number" links by docket string (e.g. when no internal case exists yet); resolution to a case is query-side and self-healing. |
| `event_link_id` | string | optional (placeholderAllowed) | case_id, contact_id, or the docket string verbatim for case_number (opaque — never shape-validated). |
| `event_time` | string | optional (placeholderAllowed) | "HH:MM[:SS]" firm-local. Omit/null for an all-day event. |
| `event_all_day` | boolean | optional | Authoritative all-day flag. If omitted, inferred from event_time. |
| `event_length` | integer | optional | Minutes; timed events only (ignored for all-day). |
| `event_location` | string | optional (placeholderAllowed) |  |
| `event_link` | string | optional (placeholderAllowed) | Zoom / dial-in / docket URL. |
| `event_note` | string | optional (placeholderAllowed, multiline) |  |
| `event_calendar_id` | string | optional | Per-event calendar override. Literal "none" skips GCal entirely. |
| `event_with` | integer | optional (placeholderAllowed) | users.user (does_appts=1). Scopes which provider's booking availability a timed event blocks: omit/null = blocks ALL providers (firm-wide); an id = blocks only that provider; 0 = blocks NOBODY. |
| `acting_user_id` | integer | optional, default `0` (placeholderAllowed) | users.user for the log entry. 0/omit = automation. Accepts a {{placeholder}} — the runtime parseInt()s whatever it resolves to. |
| `reminder` | object | optional | Optional single reminder task: { to:<userId>, date:"YYYY-MM-DD", title? }. A reminder whose date is already past is refused (warned + skipped) rather than created Overdue. |
| `dedupe` | boolean | optional, default true | DEFAULT TRUE. Skips the create entirely when a Scheduled event for the same case already sits in the same slot — matched by exact natural key, OR same normalized event_type at the same date+time, OR a loosely-matching title at the same date+time. Sees ACROSS pipelines (an event wf24 created as "confirmation_hearing" and one the court executor would create as "Confirmation Hearing" are the same event). On a hit NOTHING is written — no event row, no log entry, no calendar event, no reminder task — and the EXISTING event is returned in output.event with output.deduped=true. Set false ONLY if you are intentionally creating a same-slot duplicate. |

Example:
```json
{
  "event_type": "Confirmation Hearing",
  "event_link_type": "case",
  "event_link_id": "{{caseId}}",
  "event_title": "Confirmation Hearing \u2013 {{case_number}}",
  "event_date": "{{hearing_date}}",
  "event_time": "10:00:00"
}
```

**`dedupe` defaults to TRUE**, which is why re-running a workflow that
creates a hearing doesn't produce two of them. Turn it off deliberately or
not at all.

`event_calendar_id: "none"` is the escape hatch for an event that must not
reach Google Calendar at all.

#### `update_event`

Update fields on an event (whitelisted columns) and/or swap its reminder task. Re-syncs the calendar event if a gcal-affecting field changed. Delegates to eventService.updateEvent.

| Param | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes (placeholderAllowed) |  |
| `fields` | object | optional | Column → value pairs. Allowed: event_type, type_key, event_title, event_date, event_time, event_all_day, event_length, event_location, event_link, event_note, event_status, event_resolution, event_calendar_id, event_with. event_resolution (U6a): validated against the event's kind and its post-update status — a Scheduled event cannot carry one; setting event_status to Completed/Canceled without one writes the default (deadline → met, else held; cancel → cancelled). NOT allowed: event_link_type / event_link_id — an event's entity is set at CREATION and is not updatable (a relink would invalidate the duplicate guard's natural key). To move an event to a different case/contact, cancel it and create it on the right entity. event_with: null = blocks all providers' availability; a does_appts user id = blocks only that provider; 0 = blocks nobody. At least one of fields or reminder is required. |
| `reminder` | object | optional | Omit to leave reminders alone. Object { to:<userId>, date:"YYYY-MM-DD", title? } cancels existing active reminder task(s) and spawns a new one (a past-dated reminder is refused, not created Overdue). null cancels existing reminder task(s) and spawns none. |
| `acting_user_id` | integer | optional, default `0` (placeholderAllowed) | users.user for the log entry. 0/omit = automation. Accepts a {{placeholder}}. |

Example:
```json
{
  "event_id": "{{eventId}}",
  "fields": {
    "event_date": "{{new_date}}"
  },
  "reminder": {
    "to": 3,
    "date": "{{new_reminder_date}}"
  }
}
```

#### `complete_event`

Mark an event Completed and cancel any reminder task(s). Leaves the calendar entry in place. Writes event_resolution (deadline → met, else held) unless `resolution` says otherwise.

| Param | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes (placeholderAllowed) |  |
| `resolution` | string | optional (placeholderAllowed) | Outcome to record (v0.5 §3.7). Hearings/conferences/other: 'held'. Deadlines: 'met' \| 'missed' \| 'moot'. Omit for the default. Invalid for the event's kind → the step fails. |
| `acting_user_id` | integer | optional, default `0` (placeholderAllowed) | users.user for the log entry. 0/omit = automation. Accepts a {{placeholder}}. |

Example:
```json
{
  "event_id": "{{eventId}}"
}
```

#### `lookup_event`

Fetch an event row (with resolved link label) and return it as output.

| Param | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes (placeholderAllowed) |  |

Example:
```json
{
  "event_id": "{{eventId}}"
}
```

#### `get_events`

Query the events table with optional filters and return results suitable for email, SMS, or variable storage.

| Param | Type | Required | Description |
|---|---|---|---|
| `link_type` | enum | optional | case_number filters by docket string equality in link_id. |
| `link_id` | string | optional (placeholderAllowed) |  |
| `status` | string | optional | event_status filter (Scheduled \| Completed \| Canceled \| Rescheduled). Omit or "all" for all statuses. Defaults to "Scheduled". "Rescheduled" (U6c) is a tombstone — a row superseded by a successor event; it is hidden from every other status filter and only returned when asked for by name or under "all". |
| `type` | string | optional | event_type filter. |
| `from` | string | optional (placeholderAllowed) | Lower bound on event_date (YYYY-MM-DD). |
| `to` | string | optional (placeholderAllowed) | Upper bound on event_date (YYYY-MM-DD). |
| `date` | string | optional (placeholderAllowed) | "today", "tomorrow", or "YYYY-MM-DD" for an exact day. |
| `limit` | integer | optional, default `200` |  |
| `format` | enum | optional, default `raw` |  |
| `output_var` | string | optional |  |
| `count_var` | string | optional |  |
| `base_url` | string | optional | Base URL for links in html_rows output. |
| `include_superseded` | boolean | optional, default false | Include rows superseded by a reschedule (superseded_by_event_id set) even when they still read Scheduled. Default hides them. |

Example:
```json
{
  "status": "Scheduled",
  "date": "tomorrow",
  "format": "html_rows",
  "output_var": "eventRows"
}
```

#### `run_event_digest`

Send the upcoming-events digest on demand (default window: tomorrow through the next workday).

| Param | Type | Required | Description |
|---|---|---|---|
| `force` | boolean | optional, default false | Skip the Shabbos/Yom Tov send-gate. |
| `from` | string | optional (placeholderAllowed) | Window start (YYYY-MM-DD). Overrides the default (tomorrow); used verbatim with "to". |
| `to` | string | optional (placeholderAllowed) | Window end (YYYY-MM-DD). Overrides the default (next workday); used verbatim with "from". |

#### `sweep_calendar_missed`

Nightly deadline sweep (Unified Events U6a). Every kind='deadline' event still Scheduled whose date is before firm-local today AND on/after `since` is Completed with event_resolution='missed' through eventService.completeEvent — so each emits calendar.resolved (resolution 'missed'), logs, and clears its reminder task. `since` is required and has no default: older past-dated deadlines are UNKNOWN, not missed, and stay Scheduled until a human resolves them. Idempotent; superseded rows skipped.

| Param | Type | Required | Description |
|---|---|---|---|
| `since` | string | yes (placeholderAllowed) | Floor on event_date, inclusive (YYYY-MM-DD). Set by Fred in the scheduled job's params; proposed 2026-09-01. |
| `max_rows` | integer | optional, default `200` | Per-run cap on rows scanned (oldest first). The remainder is picked up next run. |
| `max_runtime_ms` | integer | optional, default `20000` | Wall-clock bound; stops before the next row when exceeded. |
| `dry_run` | boolean | optional, default false | List would-mark rows (up to max_rows) without writing or emitting. |

Example:
```json
{
  "since": "2026-09-01",
  "dry_run": true
}
```

#### `emit_calendar_approaching`

Nightly emitter for the calendar.approaching synthetic trigger event (Unified Events U8, v0.5 §3.2/A6). For every live appt and event whose type carries approaching_offsets, claims (source, source_id, offset_days, item_date) in calendar_approaching_emitted and emits calendar.approaching once per rung whose day has arrived (days_until <= offset_days). The reminder's OUTCOME — a task, an SMS, a staff email — is a trigger rule, not this function. With no type configured it scans nothing. item_date is part of the claim key, so moving an item's date re-arms every rung for the new date. Exactly-once per (item, rung, date); 'today' is firm-local, never CURDATE().

| Param | Type | Required | Description |
|---|---|---|---|
| `max_emits` | integer | optional, default `200` | Per-run emission cap. Stops before claiming, so the remainder retries on the next run; hitting it raises an alert. |
| `max_runtime_ms` | integer | optional, default `20000` | Wall-clock bound; stops before the next claim when exceeded. Same retry semantics as the cap. |
| `dry_run` | boolean | optional, default false | List would_emit rungs (uncapped) without claiming or emitting. Reads the claim ledger, so rungs already emitted count as duplicates rather than appearing as pending — the counters mean the same thing they mean on a real run. The gate to run after setting offsets for the first time. |

Example:
```json
{
  "dry_run": true
}
```

**Every calendar type ships with no offsets**, so this job emits nothing
until somebody sets them — a run that reports zero is not a fault. Create
the trigger rules *first*, then set the offsets. See
[chapter 15](15-triggers.md).

### Documents

The Dropbox→case document pipeline. See [Documents](../05-Subsystems/06-documents.md) for the registry itself.

#### `documents_sync`

One bounded increment of the Dropbox → documents sync. Walks enabled sync roots under a shared page budget (oldest-synced first), registering files and linking them to cases by folder path, then runs the reconcile sweep. A root with no cursor runs in BACKFILL mode (bulk writes, NO domain events); a root with a cursor runs INCREMENTAL (per-row writes, document.created / document.updated / document.linked emitted). The cursor is persisted after every page, so the ~150k-file backfill completes across successive runs. Fail-closed on app_settings documents_sync_enabled != "1".

| Param | Type | Required | Description |
|---|---|---|---|
| `root_id` | integer | optional | Sync only this document_sync_roots id. Explicit override — runs even if the root is disabled. Omit for the normal all-roots rotation. |
| `max_pages` | integer | optional, default `25` | Page budget (2000 entries/page) shared across all roots for this invocation. The whole estate is roughly 80 pages. |
| `sweep` | boolean | optional, default true | Run the reconcile sweep (silently links documents whose case folder was not cached at ingest time). Defaults on for a full run, off for a targeted root_id run. |

#### `documents_refresh_case_cache`

Resolve cases.case_dropbox shared links into case_folder_cache (folder path + Dropbox id), oldest-first, so the sync engine can attribute documents to cases by path. A failed resolution records resolve_error and LEAVES THE PRIOR PATH INTACT — a revoked link must not unfile a case. Returns out_of_root: cases whose folder sits under no enabled sync root, whose documents would therefore never be registered. Bounded by BOTH a case count and a wall clock; hitting either is a normal outcome (timed_out in the output), and the next run resumes at the unreached tail. Fail-closed on app_settings documents_sync_enabled != "1".

| Param | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | optional, default `300` | Cases to resolve this run, oldest-resolved first (never-resolved counts as oldest). Sequential, measured at ~1s per case in production — so 300 is roughly a five-minute call and the wall-clock bound below usually binds first. |
| `max_runtime_ms` | integer | optional, default `240000` | Wall-clock bound (default 4 min — safely inside the job runner's 15-min stuck-job recovery). Checked before each Dropbox call, so it never overshoots by a round trip. Stopping early loses nothing: oldest-first ordering means the next run resumes at the unreached tail. |

#### `documents_attribution_report`

READ-ONLY diagnostic. Lists cases whose Dropbox folder resolved cleanly but hold ZERO attributed documents — the signature of a stale cases.case_dropbox left pointing at the intake folder after a case was filed and its contents moved elsewhere. For each, counts registered documents still under the cached path, split into deleted / active-linked-to-another-case / active-unlinked. Returns a verdict on whether the one-folder-per-case model holds. Writes nothing and emits nothing. Scans the whole documents table, so run it deliberately rather than on a schedule. Fail-closed on documents_sync_enabled != "1".

| Param | Type | Required | Description |
|---|---|---|---|
| `sample` | integer | optional, default `50` | How many affected cases to list individually in the output, worst-residue first. Max 500. Counts are always over the full set regardless. |
| `max_runtime_ms` | integer | optional, default `180000` | Wall-clock bound (default 3 min). Hitting it yields verdict "incomplete_scan" — the counts are then a lower bound, not an answer. |

#### `document_generate_from_template` *(workflow only)*

Generate a PDF from a contract template for a case or contact and file it to Dropbox. No signature, no envelope, no credits — the non-esign twin of esign_send_from_template. Resolver-backed prefill keys (debtor1.*, case.*, firm.*, expressions) fill automatically; pass `values` for the rest. The template's purpose must be generate or both. Files to <case folder>/<the template's file_subfolder>, auto-creating and linking a case folder with a staff task if none exists; failures degrade to the unsorted generated-documents bin plus a move-task. Output carries the Dropbox path and a ~4-hour temporary download link for send_email attachment_urls; the link is best-effort (may be null — check warnings). Required values still empty stop the step, or raise a staff task if on_missing is "task"; optional blanks render as blanks. Renders are heavyweight and serialized — do not loop this.

| Param | Type | Required | Description |
|---|---|---|---|
| `template_id` | integer | yes (placeholderAllowed) | contract_templates.id — pick from the template admin list, or a {{placeholder}} for a dynamic template. Its purpose must be generate or both. |
| `linkable_type` | enum | yes | What the document belongs to — and therefore whose Dropbox folder it files into. |
| `linkable_id` | string | yes (placeholderAllowed) | The case or contact id — usually a placeholder. |
| `values` | object | optional | Prefill values for keys not covered by resolvers: {"fee": "1500"}. Placeholders resolve inside. |
| `document_name` | string | optional (placeholderAllowed) | Override the document name (default: template name + debtor surname). The filename is "{YYYY-MM-DD} {document name}.pdf". |
| `on_missing` | enum | optional | 'fail' (default): throw if required prefill values are empty. 'task': raise a staff task linked to the case, skip the generation, and report success with generated:false. |
| `output_var` | string | optional (placeholderAllowed) | Also copy the output object into this named workflow variable for later steps. Attach it in a later send_email via attachment_urls: [{"url": "{{notice.temp_link}}", "name": "{{notice.file_name}}"}]. |

Example:
```json
{
  "template_id": 8,
  "linkable_type": "case",
  "linkable_id": "{{trigger_data.case_id}}",
  "on_missing": "task",
  "output_var": "notice"
}
```

### E-signature

Driving an envelope from automation. The subsystem itself is [07-ESign](../07-ESign/). (`esign_remind` and `esign_reconcile` carry `category: 'system'` in their meta but belong here for reading.)

#### `esign_send_from_template`

Send a contract template for e-signature, linked to a case or contact. Resolver-backed prefill keys (debtor1.*, case.*, firm.*, expressions) fill automatically; pass `values` for the rest. Recipients come from an explicit array OR from recipient_contact_ids (comma-separated, list order = signing order). If required values are still missing, on_missing decides: fail the step (default) or raise a staff task and skip. Reminders, filing and alerts behave exactly as for a staff-sent document. Returns signing_request_id / tracking_id for downstream steps.

| Param | Type | Required | Description |
|---|---|---|---|
| `template_id` | integer | yes (placeholderAllowed) | contract_templates.id — pick from the template admin list, or a {{placeholder}} for a dynamic template (fields then can't be pre-loaded in the editor). |
| `linkable_type` | enum | yes | What the request is linked to. |
| `linkable_id` | string | yes (placeholderAllowed) | The case or contact id — usually a placeholder. |
| `recipients` | array | optional | Explicit recipients: [{"name":"…","email":"…"}, …]. Placeholders resolve inside. Use this OR recipient_contact_ids, not both. |
| `recipient_contact_ids` | string | optional (placeholderAllowed) | Comma-separated contact ids; name/email looked up, list order = signing order. Use this OR recipients, not both. |
| `values` | object | optional | Prefill values for keys not covered by resolvers: {"fee": "1500"}. Placeholders resolve inside. |
| `document_name` | string | optional (placeholderAllowed) | Override the document name (default: template name + case/contact). |
| `expiration_days` | integer | optional | Override the template's expiration window (1–90 days). |
| `on_missing` | enum | optional | 'fail' (default): throw if required prefill values are empty. 'task': raise a staff task, skip the send, and report success with sent:false. |
| `on_signed` | object | optional | Completion trigger override: {"type": "workflow"\|"sequence", "id": N} — started when the request is signed (or satisfied externally). Omit to use the template's own trigger; pass null to clear it for this send. |
| `on_declined` | object | optional | Completion trigger override: {"type": "workflow"\|"sequence", "id": N} — started when the request is declined. Omit to use the template's; null clears. |

Example:
```json
{
  "template_id": 3,
  "linkable_type": "case",
  "linkable_id": "{{trigger_data.case_id}}",
  "recipient_contact_ids": "{{trigger_data.contact_id}}",
  "on_missing": "task"
}
```

#### `esign_get_status`

Read an e-signature request's status for branching. Returns status plus is_signed / is_terminal booleans, timestamps and days_pending — map them with set_vars, then evaluate_condition. With live:true the provider is consulted first and any missed webhook is applied through the normal status pipeline (filing and alerts included) before answering; throws if the live check cannot complete rather than answering stale.

| Param | Type | Required | Description |
|---|---|---|---|
| `signing_request_id` | string | yes (placeholderAllowed) | signing_requests.id — typically {{vars.signing_request_id}} captured from an earlier esign_send_from_template step. |
| `live` | boolean | optional, default false | Verify against the provider before answering. Use true whenever the answer gates a decision. |

Example:
```json
{
  "signing_request_id": "{{vars.signing_request_id}}",
  "live": true
}
```

#### `esign_remind`

Send one reminder for one e-signature request — the step body for reminder sequences. Verifies LIVE provider status before nudging: a request the provider reports as signed/declined/recalled/expired is never reminded, the missed webhook is applied through the normal status pipeline (filing, alerts, reminder cancellation included), and the occurrence is skipped. Draft, bounced and terminal rows skip quietly. Throws if the live status cannot be verified — it will not remind on stale local state.

| Param | Type | Required | Description |
|---|---|---|---|
| `signing_request_id` | string | yes (placeholderAllowed) | signing_requests.id — in a sequence step, pass {{trigger_data.signing_request_id}}. |

Example:
```json
{
  "signing_request_id": "{{trigger_data.signing_request_id}}"
}
```

#### `esign_recall`

Recall an outstanding e-signature request — same pipeline as the staff recall (provider recall, audit event, client notification with the reason). Tolerant by design: a request that is already signed/declined/expired/recalled skips as a success (recalled:false, skipped:"terminal"), so a cleanup workflow can recall whatever is outstanding without erroring on the ones that resolved themselves. The reason reaches the client verbatim.

| Param | Type | Required | Description |
|---|---|---|---|
| `signing_request_id` | string | yes (placeholderAllowed) | signing_requests.id |
| `reason` | string | optional (placeholderAllowed, multiline) | Sent to the client in the recall notice. Default: a generic "withdrawn by the firm" message. |

Example:
```json
{
  "signing_request_id": "{{vars.signing_request_id}}"
}
```

#### `esign_reconcile`

Reconcile e-signature requests against the provider. Pass A re-checks every outstanding request (sent/viewed/bounced) and applies any status the webhook missed, filing signed documents to Dropbox through the same path the webhook uses. Pass B retries filing for requests that are signed but have no stored PDF path. Safe to run repeatedly — every step is idempotent. Normally runs nightly as a recurring scheduled job.

| Param | Type | Required | Description |
|---|---|---|---|
| `max_rows` | integer | optional | Cap on rows examined per pass. Default 200. |
| `dry_run` | boolean | optional, default false | Report what would change without changing anything. Skips pass B entirely. |

Example:
```json
{
  "dry_run": true
}
```

Runs nightly as a scheduled job. Pass A re-checks every outstanding
request and applies any status the webhook missed — it is the safety net
for a dropped callback, so a signed envelope still files itself.
`dry_run: true` reports what would change without touching anything.

### Composition (workflow only)

#### `start_workflow` *(workflow only)*

Start another workflow from this one. init_data becomes the child's init_data (and seeds its variables). Fails if the target workflow is missing or inactive. Output: workflow_execution_id.

| Param | Type | Required | Description |
|---|---|---|---|
| `workflow_id` | string | yes (placeholderAllowed) | Target workflow ID (number, or a {{placeholder}} resolved at runtime). Existence is verified at save time for literal IDs. |
| `init_data` | object | optional | JSON object passed to the child as init_data (also seeds its variables). Check the target's test_input for the expected keys. |
| `contact_id_override` | string | optional (placeholderAllowed) | Explicit contact to tie the child execution to. Overrides the target's default_contact_id_from resolution. |

Example:
```json
{
  "workflow_id": "12",
  "init_data": {
    "contactId": "{{contactId}}",
    "reason": "parent workflow escalation"
  }
}
```

### Court

The court-mail pipeline's automation surface. Docket extraction itself runs off an ingest rule — see [chapter 10](10-ingest.md).

#### `validate_case_trustee`

Validate cases.case_trustee against the fe-trustees roster (app_settings). On a match: canonicalize the stored trustee to the exact roster spelling and set cases.case_341_link from the roster Zoom link. On no-match/ambiguous/chapter-mismatch: create a deduped alert task (never guesses). Gated by app_settings trustee_validation_live — absent/'0' forces dry-run (no case writes; alert routed to dry_run_alert_to; summary email sent).

| Param | Type | Required | Description |
|---|---|---|---|
| `case_id` | string | yes (placeholderAllowed) | The case to validate. |
| `dry_run` | boolean | optional, default false | Force a dry run even when trustee_validation_live='1'. |
| `alert_to` | integer | optional, default `22` | users.user who receives the live no-match alert task. |
| `dry_run_alert_to` | integer | optional, default `6` | users.user who receives the alert task on DRY runs. |
| `debug_email_to` | string | optional, default `it@4lsg.com` |  |
| `debug_email_from` | string | optional, default `IT@metrodetroitbankruptcylaw.com` |  |

Example:
```json
{
  "case_id": "{{case_id}}"
}
```

#### `court_activity_summary`

Coverage-review digest of court_ai_log over a rolling window. Emails a 4-section HTML summary (Actioned / Covered Elsewhere / Needs Review / Ignored–No Action); the Ignored section lists every no-action subject in full so a human can catch a type we should be actioning but aren't. No AI call; read-only over court_ai_log. Sends per-recipient via emailService.

| Param | Type | Required | Description |
|---|---|---|---|
| `days` | number | optional, default `7` | Window size in days (created_at >= NOW() - INTERVAL N DAY). Floored at 1, capped at 90. 7 = weekly; 1 = daily. |
| `to` | string | optional | Comma-separated recipient override. Default: stuart@4lsg.com, Rena@4lsg.com, <email_it>. One send per address. |
| `from` | string | optional | Sender override (must exist in email_credentials). Default: setting email_automations → AUTO_EMAIL → automations@4lsg.com. |
| `skip_if_empty` | boolean | optional, default false | If true and the window has 0 rows, send nothing (returns sent:false). Default false — a "0 processed" email confirms liveness. |

Example:
```json
{
  "days": 7
}
```

#### `court_review_retry`

Re-run court review-queue rows (case_not_found) whose docket now resolves. No AI call; honors court_ingest_live.

| Param | Type | Required | Description |
|---|---|---|---|
| `limit` | number | optional, default `100` | Max open case_not_found rows to scan per run (capped at 500). |
| `dry_run` | boolean | optional, default false | Plan only — scan + resolve but do not execute. Distinct from court_ingest_live. |

### Connections and sync jobs

All three run as recurring jobs. See [Connections](../04-Integrations/01-connections.md) for the credential store and [the RingCentral bootstrap](../04-Integrations/03-rc-subscription-bootstrap.md) for what happens when a renewal is missed.

#### `refresh_expiring_oauth_credentials`

Refresh oauth2 credentials with tokens expiring soon. Refresh-token cutoff: 48h. Access-token cutoff: 1h (catches stale connections that webhooks haven't exercised). Skips non-connected credentials. The 2-strike alert + status flip is handled inside oauthService.refreshTokens — this function just iterates and reports counts.

#### `rc_renew_subscriptions`

Daily idempotent renewal pass over RC webhook subscriptions tracked in app_settings.rc_subscriptions. Per-entry: skip if >48h to expiry, else PUT subscription/<id> with empty body. 404 → remove + alert IT. Other errors are logged and left for the next daily pass. The app_settings row is only rewritten if something changed. Inert until Slice 6 seeds app_settings.rc_subscriptions — empty/missing array short-circuits with skipped=true. Returns { count, results: [...] } on success.

#### `gcontacts_sync_pending`

Nightly drift sweep: pushes YisraCase contacts whose row changed since last sync (contact_updated > contact_google_synced_at) or were never synced, to Google Contacts. Names authoritative; phones/emails union-merged (no deletes); firm-internal domains skipped. Bounded by limit (default 1000, capped 2000). Returns { pushed, created, updated, skipped, errors }.

| Param | Type | Required | Description |
|---|---|---|---|
| `limit` | number | optional, default `1000` | Max changed contacts to push per run (capped at 2000). |

### Settings

Reading and writing `app_settings`. Secret rows are refused — `get_setting` throws on an `is_secret` key rather than returning it.

#### `get_setting`

Read app_settings.value for a non-secret key. Throws on unknown key or is_secret row. Optionally stores the value in a workflow variable via output_var.

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes (placeholderAllowed) | app_settings.key. Must exist and must not be is_secret. Runtime rejects a non-string key. |
| `output_var` | string | optional | Store the value in this workflow variable. |

Example:
```json
{
  "key": "court_ingest_live",
  "output_var": "courtIngestLive"
}
```

#### `get_settings`

Read multiple non-secret app_settings in one call; returns a {key: value} map. ALL-OR-NOTHING: throws (listing every offender) if any requested key is unknown or is_secret. With output_var, individual values are reachable via {{var.key_name}}.

| Param | Type | Required | Description |
|---|---|---|---|
| `keys` | string | yes (placeholderAllowed) | Comma-separated app_settings keys. Every key must exist and must not be is_secret. A placeholder resolving to an array also works at runtime. |
| `output_var` | string | optional | Store the whole {key: value} map in this workflow variable. |

Example:
```json
{
  "keys": "court_ingest_live, esign_test_mode",
  "output_var": "settings"
}
```

#### `set_setting`

Write app_settings.value for an EXISTING, non-secret key. Value stored verbatim (no trimming). Refuses is_secret rows and unknown keys. Ignores is_editable — that flag governs the human settings.html editor, not automation.

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes (placeholderAllowed) | app_settings.key. Must already exist and must not be is_secret. Runtime rejects a non-string key. |
| `value` | string | yes (placeholderAllowed, multiline) | New value, stored VERBATIM. Numbers/booleans are stringified; objects/arrays are rejected — JSON.stringify them first. |

Example:
```json
{
  "key": "clio_login_code",
  "value": "{{clio_code}}"
}
```

### System maintenance

Housekeeping, all of it scheduled rather than called by hand.

#### `run_error_sweep`

Scan automation failure tables and email a grouped alert digest.

| Param | Type | Required | Description |
|---|---|---|---|
| `dry_run` | boolean | optional, default false | Scan and build the digest without sending, writing, or advancing watermarks. |

#### `sweep_trigger_executions`

Retention sweep for trigger_executions: no_match/no_rules rows kept keep_days (default 30), matched/error rows kept keep_matched_days (default 90). Also sweeps terminal (done/error) domain_event_queue rows kept keep_queue_days (default 14) — pending/running rows are live work and are never deleted. Batched deletes. Also alerts on executions stranded mid-dispatch for over an hour (suspended post-response work).

| Param | Type | Required | Description |
|---|---|---|---|
| `keep_days` | integer | optional, default `30` | Days to keep no_match / no_rules rows. |
| `keep_matched_days` | integer | optional, default `90` | Days to keep matched / error / depth_capped rows. |
| `keep_queue_days` | integer | optional, default `14` | Days to keep done / error domain_event_queue rows. Pending and running rows are never swept. |

#### `emit_stage_aged`

Nightly emitter for the case.stage_aged synthetic trigger event. For each piped case's CURRENT pipeline stage, claims (stage_log_id, threshold) in case_stage_aged_emitted and emits case.stage_aged for every ladder rung whose crossing is RECENT (days_in_stage >= threshold and < threshold + grace_days). Exactly-once per stage entry per threshold; re-entering a stage re-arms its rungs. Forward-looking only — already-stale backfilled cases never fire. Terminal stages and Closed/Concluded cases skipped. Emissions awaited; each is its own root event. Days are whole 24-hour periods.

| Param | Type | Required | Description |
|---|---|---|---|
| `thresholds` | string | optional, default `3,7,14,30,60` | Comma-separated day rungs (an array also works at runtime). Deduped, sorted, must all be integers > 0. |
| `grace_days` | integer | optional, default `7` | Fire only when the crossing happened within this many days. Absorbs job outages; blocks backfill stampedes. |
| `max_emissions` | integer | optional, default `200` | Per-run emission cap. Hitting it alerts once and stops before claiming, so the remainder retries next run while in-window. |
| `max_runtime_ms` | integer | optional, default `480000` | Wall-clock bound (default 8 min — safely inside the job runner's 15-min stuck-job recovery). Stops before claiming, same retry semantics as the cap. |
| `dry_run` | boolean | optional, default false | List would-emit crossings (uncapped) without claiming or emitting. |

`grace_days` is what stops a job outage from producing a stampede of
back-dated nudges when it comes back. `dry_run: true` lists the crossings
it would claim — run it that way first.

#### `generate_firm_blocks`

Materialize Shabbos/Yom Tov closed intervals from Hebcal into firm_blocks over a rolling horizon (default 12 months). Upserts on (source, generated_for); never deletes; manual rows untouched. Hebcal failure throws (job retry); a zero-block result for a ≥1-month window fires a firm_blocks_generation_empty alert.

| Param | Type | Required | Description |
|---|---|---|---|
| `horizon_months` | number | optional, default `12` | Window length in months from today. |

#### `report_email`

Run a saved report (by report_key) and email it. format: chart = email-safe bar chart / stat cards + data table; table = data table only; text = plain aligned columns. All report guards apply (allowlist, denylist, query-plan gate) and the run is logged to report_runs as user 0 (Automations). Caveats travel with the number.

| Param | Type | Required | Description |
|---|---|---|---|
| `report_key` | string | yes (placeholderAllowed) | The report_definitions.report_key of a saved, active report (e.g. cases_by_stage). |
| `to` | string | yes (placeholderAllowed) | Comma-separated recipients. Required — no default audience. One send per address. |
| `format` | enum | optional, default `chart` | 'chart' (bars/stat cards + table), 'table', or 'text' (plain aligned columns). |
| `report_params` | object | optional | Values for the report's declared parameters, e.g. {"start":"-30d","end":"today"}. Omitted params use the report's defaults; relative date tokens resolve at send time, so "-30d" always means the last 30 days. |
| `from` | string | optional | Sender override (must exist in email_credentials). Default: setting email_automations → automations@4lsg.com. |
| `subject` | string | optional | Subject override. Default: "<report title> — <date>". |
| `skip_if_empty` | boolean | optional, default false | If true and the report returns 0 rows, send nothing (returns sent:false). |

Example:
```json
{
  "report_key": "appointment_no_show_trend",
  "to": "stuart@4lsg.com",
  "format": "chart",
  "report_params": {
    "start": "-30d"
  }
}
```

### Dropbox

Eight functions — `dropbox_ensure_case_folder`, `dropbox_create_folder`,
`dropbox_save_url`, `dropbox_get_shared_link`, `dropbox_list_folder`,
`dropbox_move`, `dropbox_rename`, `dropbox_delete` — all in
`lib/internal_functions/dropbox.js`, all chainable via `{{this.output.*}}`.

They are documented with the service that backs them, including the stage-aware
case-folder logic and the naming-convention templates:
**[Integrations → Dropbox](../04-Integrations/05-dropbox.md)**.

### Google Calendar

Four thin wrappers — `gcal_create_event`, `gcal_update_event`, `gcal_get_event`,
`gcal_delete_event` — documented with the integration, including credential and
calendar selection: **[Integrations → Google Calendar](../04-Integrations/04-google-calendar.md)**.

---

## Metadata registry — `__meta`

Each function carries a `__meta` block:

```js
internalFunctions.send_sms.__meta = {
  category: 'communication',
  description: 'Send an SMS from an internal phone line.',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'phone_line' },
    { name: 'to',   type: 'string', required: true, placeholderAllowed: true },
    { name: 'message', type: 'string', required: true, multiline: true, placeholderAllowed: true }
  ],
  example: { from: '2485559999', to: '{{contactPhone}}', message: 'Hi {{firstName}}!' }
};
```

### Meta param types

```
string, placeholder_string, number, integer, boolean,
enum, iso_datetime, duration, object, array
```

### Meta param flags

| Flag | Description |
|---|---|
| `required` | true/false |
| `placeholderAllowed` | If true, `{{}}` placeholders bypass type validation |
| `multiline` | UI hint for textarea |
| `nullishSkipsBlock` | If true, a null/empty value skips downstream type checks for this field (used by `wait_for.at` / `schedule_resume.resumeAt`) |
| `widget` | UI widget hint (`phone_line`, `email_from`) for special pickers |
| `enum` | Required if `type === 'enum'`; allowed values |
| `default` | Default value if not provided |
| `min`, `max` | Numeric bounds |
| `description`, `example` | Doc strings |
| `modeGroup` | Group name for mutually-exclusive modes (e.g. `by_id` / `by_type`, `relative` / `absolute`, `single` / `multi`) |

### Meta function-level fields

| Field | Description |
|---|---|
| `category` | Grouping for the UI dropdown |
| `description` | Function description |
| `params` | Array of param specs (above) |
| `example` | Sample full-config example |
| `exclusiveOneOf` | Array of arrays: each inner array is a group where exactly one must be set |
| `requiredWith` | Array of arrays: each inner array is a co-required group (at least one must be present) |
| `workflowOnly` | If true, function is excluded from sequence dropdowns |
| `controlFlow` | If true, function's `next_step` return is honored by the engine |

### Helpers

```js
internalFunctions.__getMeta(name)           // → meta block for one function, or null
internalFunctions.__getAllMeta()            // → { funcName: meta, ... } for all
internalFunctions.__validateParamsAgainstMeta(name, params)   // → null on success, { error: '...' } on fail
```

`GET /workflows/functions` returns `{ workflow: [...], sequence: [...], meta: __getAllMeta() }` for the form-driven UI.

---

## Common pitfalls

1. **`set_test_var` is callable in production.** It's not a real function but it's not gated. Don't put it in production workflow templates.
2. **`format_string` is workflow-only and stores into `output_var`.** Sequences should use the universal resolver via the action_config (placeholders are resolved automatically before the action runs). If you need string formatting in a sequence, build it into the message text directly.
3. **`update_contact` and `update_appointment` blocklists differ from the resolver blocklist.** The resolver blocks *reading* SSN; `update_contact` allows *writing* it. The intent is automations can ingest sensitive data from forms but can't read it back out.
4. **`{{}}` placeholders work everywhere `placeholderAllowed: true` is set on the param.** Where it's not set, the value is taken literally — useful for `function_name` selectors, enum fields, etc.
5. **`get_appointments` and `query_db` both have a `format` param** — use `count` to just get the row count, `first` (query_db only) for a single row, `html_rows` for an HTML-formatted block ready for an email.
6. **`evaluate_condition` `else: null` ends the workflow** — same as `set_next` with `null`. Useful for "if condition fails, we're done."
7. **`send_email` `attachment_urls` must be a JSON array in the editor.** `emailService.sendEmail` accepts a single `{url, name}` object or a comma-separated string at runtime, but the workflow editor's metadata-driven validator declares `type: 'array'` and rejects non-array shapes at save time. Sequence editor enforces the same. **Wrap single attachments as `[{...}]`.** Also: the URL must be publicly reachable at send time (Pabbly fetches it itself; nodemailer's `path:` for SMTP does the same) — private/signed GCS URLs without anonymous access won't work.
8. **`query_ai` output lives at `{{this.output.field}}`, not `{{this.field}}`** — `this` is the full function return `{success, output, set_vars, usage, call_id}`. This applies to every internal function's same-step `set_vars` (some older docstrings in the registry claim `{{this.column_name}}`; they're wrong — the code and chapter 6 are authoritative). And every `query_ai` attempt bills the API: `error_policy` retries and the json strict retry each write their own `ai_calls` row.
8. **Workflow variables shadow resolver placeholders.** A workflow variable named `contact_fname` (set via `set_vars`) makes `{{contact_fname}}` resolve to the variable, not to `contacts.contact_fname`. Pick variable names that don't collide with resolver column names.