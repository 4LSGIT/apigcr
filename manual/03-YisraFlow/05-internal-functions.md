# 5 — Internal Functions

## For operators

The system has **23 built-in functions** that workflows, sequences, scheduled jobs, and hook targets can call. Things like "send an SMS," "look up a contact," "create a task," "query the database," "branch to step 7."

You don't usually pick a function by hand from a list — when you build a workflow step or a sequence step, you select **internal_function** as the action type and the UI shows you all 23 (or 16, in sequences) in a categorized dropdown with a form field for each parameter.

The seven that only work in workflows are the ones that need workflow-specific machinery: branching (`set_next`, `evaluate_condition`), delays (`wait_for`, `schedule_resume`, `wait_until_time`), variable formatting (`format_string`), and a dev-only helper (`set_test_var`).

Everything else works the same way in any engine that calls it.

When something doesn't fire when you expected:
1. Open the workflow execution or sequence step log — the resolved params are saved there. Look at what was actually passed in.
2. If the placeholder `{{contacts.contact_fname}}` came through unresolved, the resolver couldn't find it — see chapter 6.
3. If the function threw, the error is in `error_message`.

---

## Technical reference

### Module: `lib/internal_functions.js`

Exports an object whose keys are function names. Each function has the signature:

```js
async (params, db) => { success: boolean, output?: any, set_vars?: object, next_step?: number|null|'cancel'|'fail', delayed_until?: Date }
```

Functions can return:
- `output` — captured as `{{this.output.X}}` in the next step
- `set_vars` — merged into workflow `variables` (workflow only — sequences ignore this)
- `next_step` — workflow-only control flow (only honored on `set_next`, `evaluate_condition`, `schedule_resume`)
- `delayed_until` — workflow-only delay (only honored on `wait_for`, `schedule_resume`, `wait_until_time`)

Each function carries a `__meta` block — a JSON description of its params (name, type, required, etc.) that drives the form-driven UI. The reference below pulls directly from those `__meta` blocks; if a future change adds or renames a param, `GET /workflows/functions` is the live source of truth.

### The 23 functions

Confirmed by `tests/internal_functions.meta.test.js`:

```
cancel_sequences, create_appointment, create_log, create_task,
enroll_sequence, evaluate_condition, format_string, get_appointments,
lookup_appointment, lookup_contact, noop, query_db,
run_task_digest, schedule_resume, send_email, send_sms,
set_next, set_test_var, set_var, update_appointment,
update_contact, wait_for, wait_until_time
```

### Workflow-only vs both engines

`SEQUENCE_EXCLUDED` in `routes/workflows.js`:

```js
const SEQUENCE_EXCLUDED = new Set([
  'set_next', 'evaluate_condition',                      // control flow
  'schedule_resume', 'wait_for', 'wait_until_time',      // timing (sequences have own)
  'format_string',                                       // variable manipulation
  'set_test_var'                                         // dev only
]);
```

So:
- **Workflow only (7):** `set_next`, `evaluate_condition`, `schedule_resume`, `wait_for`, `wait_until_time`, `format_string`, `set_test_var`
- **Both engines (16):** everything else

`GET /workflows/functions` returns both lists (filtered) for the UI.

---

## Function reference, by category

### Control flow (workflow only)

#### `set_next`

Jump to a specific step number, or terminate the execution.

| Param | Type | Required | Description |
|---|---|---|---|
| `value` | string | yes (placeholderAllowed) | Step number, `"cancel"`, `"fail"`, or null/empty to end normally. |

Sentinels (handled by `workflow_engine.advanceWorkflow`):
- Positive integer → jump to that step
- `null` / empty → end with the workflow's final status (`completed` or `completed_with_errors`)
- `"cancel"` → mark execution `cancelled`
- `"fail"` → mark execution `failed`

Example:
```json
{ "function_name": "set_next", "params": { "value": 5 } }
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

**Sentinel values for `then` / `else`.** The runtime returns whatever you put there as `next_step` and `advanceWorkflow` honors the same sentinels as `set_next`: integer = jump, `null`/omitted = end, `"cancel"` = mark cancelled, `"fail"` = mark failed. The `__meta` declares them as `integer` so the save-time validator may reject `"cancel"` / `"fail"`; if you need that, use `evaluate_condition` to set a step number that points at a `set_next: "cancel"` step.

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

`requiredWith: [['text', 'html']]` — at least one of `text` / `html` required.

**No attachments support today.** The runtime only forwards `from/to/subject/text/html` to `emailService.sendEmail` — `attachments` and `attachment_urls` are silently dropped if you pass them. The underlying service supports both, so this is just a matter of extending the `__meta` and the function body if you need it. For now, attachments need to go through a webhook step that hits an internal route which calls `emailService` directly.

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
- `appt_workflow_execution_id` (managed by `apptService`)

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
7. **`send_email` does not pass attachments today.** `attachments` / `attachment_urls` would be silently dropped — see the function's note above.
8. **Workflow variables shadow resolver placeholders.** A workflow variable named `contact_fname` (set via `set_vars`) makes `{{contact_fname}}` resolve to the variable, not to `contacts.contact_fname`. Pick variable names that don't collide with resolver column names.
