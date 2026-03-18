# Part 5 — Internal Functions Reference

Internal functions are the built-in action library. They are available to all three engines — workflow steps, sequence steps, and standalone scheduled jobs.

Called with `"type": "internal_function"` and a config specifying which function to run.

---

## Config Structure

```json
{
  "function_name": "send_email",
  "params": {
    "from":    "stuart@4lsg.com",
    "to":      "{{contacts.contact_email}}",
    "subject": "Your appointment is confirmed",
    "text":    "Hi {{contacts.contact_fname}}, we look forward to seeing you."
  },
  "set_vars": {
    "emailSentAt": "{{env.now}}"
  }
}
```

- `function_name` — which function to run
- `params` — arguments passed to the function. `{{placeholders}}` are resolved before the function runs.
- `set_vars` — maps function output into variables using `{{this.output.field}}` syntax. Optional for all functions — the function itself decides what to return as `output`.

---

## Control Flow

### `set_next`
Jump to a specific step or terminate the workflow.

**Params:** `value` — step number, `null` (end normally), `"cancel"`, or `"fail"`

```json
{ "function_name": "set_next", "params": { "value": 8 } }
```

> Only works in **workflows**. `set_next` is the only function whose `next_step` output is honored by the workflow engine's control flow logic.

---

### `evaluate_condition`
Branch to different steps based on a variable comparison.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `variable` | string | Workflow variable name |
| `operator` | string | `==` `!=` `>` `<` `>=` `<=` `contains` `not_contains` `is_empty` `is_not_empty` |
| `value` | any | Comparison value |
| `then` | number | Step if true |
| `else` | number\|null | Step if false (null = next sequential) |

```json
{
  "function_name": "evaluate_condition",
  "params": { "variable": "appt_status", "operator": "==", "value": "confirmed", "then": 5, "else": 8 }
}
```

Extended form (multiple conditions):
```json
{
  "function_name": "evaluate_condition",
  "params": {
    "conditions": [
      { "variable": "appt_status", "operator": "==",  "value": "confirmed" },
      { "variable": "contact_type","operator": "!=",  "value": "vip" }
    ],
    "match": "all",
    "then": 5, "else": 8
  }
}
```

> Only works in **workflows**. Requires `_variables` injection by the engine (done automatically).

---

## Variable Manipulation

### `noop`
Does nothing. Use with `set_vars` in config to set variables without calling anything.

```json
{ "function_name": "noop", "params": {}, "set_vars": { "stage": "intake", "startedAt": "{{env.now}}" } }
```

### `set_var`
Set one workflow variable to a value.

```json
{ "function_name": "set_var", "params": { "name": "stage", "value": "follow_up" } }
```

### `format_string`
Build a string from a template and store it. The engine resolves `{{placeholders}}` before this runs — the function just stores the result.

```json
{
  "function_name": "format_string",
  "params": { "template": "{{contact_fname}} {{contact_lname}}", "output_var": "fullName" }
}
```

---

## Time / Scheduling

### `schedule_resume`
Pause a **workflow** execution and resume at a future time.

**Params:** `resumeAt` (ISO, duration string, or ms), `nextStep` (number)

```json
{ "function_name": "schedule_resume", "params": { "resumeAt": "24h", "nextStep": 5 } }
```

### `wait_for`
Convenience alias for `schedule_resume`. Pause for a duration.

```json
{ "function_name": "wait_for", "params": { "duration": "5m", "nextStep": 4 } }
```

### `wait_until_time`
Resume at the next occurrence of a specific time of day.

```json
{ "function_name": "wait_until_time", "params": { "time": "09:00", "timezone": "America/Detroit", "nextStep": 6 } }
```

> These three timing functions are for **workflows** only. **Sequences** use the `timing` column on `sequence_steps` instead.

---

## Communication

### `send_sms`
Send an SMS from an internal phone line. Routes to the correct provider (Quo/RingCentral) via `phone_lines` table.

**Params:** `from` (10-digit, must exist in `phone_lines`), `to`, `message`

**Returns:** provider result as `output`.

```json
{
  "function_name": "send_sms",
  "params": {
    "from":    "2485592400",
    "to":      "{{contacts.contact_phone}}",
    "message": "Hi {{contacts.contact_fname}}, your appointment is confirmed for {{appts.appt_date|date:dddd MMMM Do}}."
  }
}
```

### `send_email`
Send an email via the configured provider (SMTP or Pabbly) for the `from` address.

At least one of `text` or `html` is required. If only one is provided, the other is auto-generated.

**Params:** `from` (must match `email_credentials`), `to`, `subject`, `text?`, `html?`

**Returns:** provider result as `output` (includes `messageId`).

```json
{
  "function_name": "send_email",
  "params": {
    "from":    "stuart@4lsg.com",
    "to":      "{{contacts.contact_email}}",
    "subject": "We received your inquiry",
    "text":    "Hi {{contacts.contact_fname}},\n\nThank you for reaching out."
  }
}
```

---

## Tasks

### `create_task`
Insert a task row.

**Params:** `title`, `description?`, `contact_id`, `assigned_to` (user ID), `link_type?`, `link_id?`, `due_date?`

**Returns:** `{ task_id }` as `output`. Use `set_vars` to capture it.

```json
{
  "function_name": "create_task",
  "params": {
    "title":       "Follow up call",
    "contact_id":  "{{contactId}}",
    "assigned_to": 2,
    "due_date":    "{{followUpDate}}"
  },
  "set_vars": { "newTaskId": "{{this.output.task_id}}" }
}
```

---

## Contacts

### `lookup_contact`
Fetch a contact row. Returns the entire row as `output`. Use `set_vars` to map fields into variables.

**Params:** `contact_id`

```json
{
  "function_name": "lookup_contact",
  "params": { "contact_id": "{{contactId}}" },
  "set_vars": {
    "contact_fname": "{{this.output.contact_fname}}",
    "contact_email": "{{this.output.contact_email}}",
    "contact_phone": "{{this.output.contact_phone}}"
  }
}
```

> In **sequences**, prefer using `{{contacts.contact_fname}}` directly in message params — the resolver fetches it automatically. `lookup_contact` is more useful in **workflows** where you need to store fields as variables for later steps.

### `update_contact`
Update one or more fields on a contact.

**Params:** `contact_id`, `fields` (object of column → value pairs)

```json
{
  "function_name": "update_contact",
  "params": { "contact_id": "{{contactId}}", "fields": { "contact_tags": "intake-complete" } }
}
```

---

## Appointments

### `lookup_appointment`
Fetch an appointment row. Same pattern as `lookup_contact`.

**Params:** `appointment_id`

```json
{
  "function_name": "lookup_appointment",
  "params": { "appointment_id": "{{apptId}}" },
  "set_vars": {
    "appt_status": "{{this.output.appt_status}}",
    "appt_date":   "{{this.output.appt_date}}"
  }
}
```

### `update_appointment`
Update one or more fields on an appointment.

**Params:** `appointment_id`, `fields`

```json
{
  "function_name": "update_appointment",
  "params": { "appointment_id": "{{apptId}}", "fields": { "appt_status": "confirmed" } }
}
```

---

---

## Appointments

### `get_appointments`
Query the appointments table with optional filters. Returns results formatted for email, variable storage, or counting.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by `appt_status` e.g. `'Scheduled'`, `'No Show'` |
| `date` | string | `'today'`, `'tomorrow'`, or `'YYYY-MM-DD'` |
| `from` | string | ISO datetime lower bound |
| `to` | string | ISO datetime upper bound |
| `contact_id` | number | Filter by contact |
| `case_id` | string | Filter by case |
| `appt_type` | string | Filter by appointment type |
| `limit` | number | Max rows (default 200) |
| `format` | string | `'raw'` (array), `'html_rows'` (`<tr>` rows for email), `'count'` (number only) |
| `base_url` | string | Base URL for links in `html_rows` (default `'https://app.4lsg.com'`) |

**Returns:** `{ success, output: { rows, count, html, date_formatted, has_appointments }, set_vars }`

- `output.rows` — array of appointment objects with joined contact, case, and user data
- `output.html` — ready-to-paste `<tr>` rows when `format: 'html_rows'`, includes inline styles and clickable links
- `output.date_formatted` — e.g. `"Wednesday, March 18, 2026"` — for email headers
- `output.has_appointments` — boolean convenience field

```json
{
  "function_name": "get_appointments",
  "params": {
    "status": "Scheduled",
    "date":   "today",
    "format": "html_rows"
  },
  "set_vars": {
    "apptRows":         "{{this.output.html}}",
    "apptCount":        "{{this.output.count}}",
    "todayFormatted":   "{{this.output.date_formatted}}",
    "morningApptCount": "{{this.output.count}}"
  }
}
```

> Use `morningApptCount` as a second variable when you need to preserve the morning count across a workflow that later re-queries appointments at midday. Step 7 overwrites `apptCount` — `morningApptCount` is only set once and stays.

---

## General Query

### `query_db`
Build and execute a safe parameterized SELECT query from a JSON descriptor. No raw SQL strings accepted — the query is constructed entirely from validated, whitelisted identifiers with fully parameterized WHERE values.

This is the go-to function for anything the resolver can't handle: multi-table JOINs through junction tables (judge, trustee), aggregates via dedicated functions, or any query where you need the results as workflow variables for logic rather than just message text.

**When to use `query_db` vs the resolver:**

| Need | Use |
|------|-----|
| Insert `{{contacts.contact_fname}}` into an SMS | Resolver (`{{table.column}}` syntax) |
| Fetch judge name through `case_judge` junction | `query_db` |
| Count appointments for a condition check | `query_db` with `format: "count"` |
| Build HTML table rows for an email | `query_db` with `format: "html_rows"` |
| Look up a single record for branching logic | `query_db` with `format: "first"` |

---

**Params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `select` | string[] | required | Columns to fetch. Use `"*"` for all from the FROM table. |
| `from` | string | required | Primary table name. |
| `join` | object[] | `[]` | JOIN clauses — see shape below. |
| `where` | object[] | `[]` | WHERE conditions — see shape below. |
| `where_mode` | `"and"` \| `"or"` | `"and"` | How to combine WHERE clauses. |
| `order_by` | object[] | `[]` | `[{ column, dir: "asc"\|"desc" }]` |
| `limit` | number | `100` | Max rows. Hard ceiling of 1000. |
| `format` | string | `"raw"` | Output format — see below. |
| `output_var` | string | — | Store result in this workflow variable. |
| `count_var` | string | — | Store row count in this variable. |
| `base_url` | string | `"https://app.4lsg.com"` | Base URL for links in `html_rows`. |
| `html_columns` | object[] | — | Column display config for `html_rows` — see below. |

---

**Output formats:**

| `format` | `output` value |
|----------|---------------|
| `"raw"` | Array of row objects |
| `"first"` | First row object, or `null` if no results |
| `"count"` | Integer count only |
| `"html_rows"` | `<tr>` rows ready to paste into an email `<tbody>` |

**Returns:** `{ success, output, count, set_vars }`

---

**JOIN shape:**
```json
{
  "type":  "left",
  "table": "judges",
  "alias": "j",
  "on": { "left": "cj.judge_id", "right": "j.judge_id" }
}
```
`type` options: `"left"`, `"inner"`, `"right"`. Default: `"left"`.
`alias` is optional but required when joining the same table twice or when referencing the joined table in SELECT/WHERE.

---

**WHERE shape:**
```json
{ "column": "appts.appt_status", "op": "=",        "value": "Scheduled" }
{ "column": "appts.appt_date",   "op": ">=",       "value": "{{fromDate}}" }
{ "column": "appts.appt_id",     "op": "IN",       "value": [1, 2, 3] }
{ "column": "contacts.contact_dob", "op": "IS NULL" }
```

Supported operators: `=` `!=` `<>` `>` `<` `>=` `<=` `LIKE` `NOT LIKE` `IN` `NOT IN` `IS NULL` `IS NOT NULL`

`value` is not required for `IS NULL` / `IS NOT NULL`.
`value` must be an array for `IN` / `NOT IN`.
`value` can be a `{{variable}}` placeholder — it will be resolved before the function runs.

---

**HTML_COLUMNS shape (for `format: "html_rows"`):**
```json
[
  { "column": "appts.appt_id",          "label": "ID" },
  { "column": "appts.appt_type",        "label": "Type" },
  { "column": "contacts.contact_name",  "label": "Client",
    "link_base": "/?contact=", "link_id": "contacts.contact_id" },
  { "column": "cases.case_number_full", "label": "Case",
    "link_base": "/?case=",    "link_id": "cases.case_id" }
]
```
If `html_columns` is omitted, all selected columns are rendered as plain text cells in order.

---

**Allowed tables:**

```
contacts, cases, appts, tasks, log, users, phone_lines,
scheduled_jobs, workflows, workflow_executions, workflow_execution_steps,
sequence_templates, sequence_steps, sequence_enrollments, sequence_step_log,
case_judge, case_relate, case_trustee, judges, trustees,
checkitems, checklists, job_results
```

**Blocked columns (stripped from all results regardless of query):**
- `users.password`
- `users.password_hash`

---

**Example 1 — Fetch judge and trustee for a case:**
```json
{
  "function_name": "query_db",
  "params": {
    "select": ["j.judge_name", "j.judge_court", "t.trustee_name"],
    "from": "cases",
    "join": [
      { "type": "left", "table": "case_judge",   "alias": "cj",
        "on": { "left": "cases.case_id", "right": "cj.case_id" } },
      { "type": "left", "table": "judges",        "alias": "j",
        "on": { "left": "cj.judge_id",   "right": "j.judge_id" } },
      { "type": "left", "table": "case_trustee",  "alias": "ct",
        "on": { "left": "cases.case_id", "right": "ct.case_id" } },
      { "type": "left", "table": "trustees",      "alias": "t",
        "on": { "left": "ct.trustee_id", "right": "t.trustee_id" } }
    ],
    "where": [{ "column": "cases.case_id", "op": "=", "value": "{{caseId}}" }],
    "format": "first",
    "output_var": "caseDetails"
  }
}
```
After this step: `{{caseDetails.judge_name}}`, `{{caseDetails.trustee_name}}` are available via `set_vars`.

---

**Example 2 — Count overdue tasks for a contact:**
```json
{
  "function_name": "query_db",
  "params": {
    "select": ["tasks.task_id"],
    "from": "tasks",
    "where": [
      { "column": "tasks.task_link",   "op": "=",       "value": "{{contactId}}" },
      { "column": "tasks.task_status", "op": "IN",      "value": ["Overdue", "Due Today"] }
    ],
    "format": "count",
    "count_var": "overdueTasks"
  }
}
```

---

**Example 3 — HTML table of today's scheduled appointments with links:**
```json
{
  "function_name": "query_db",
  "params": {
    "select": ["appts.appt_id", "appts.appt_type", "appts.appt_date",
               "contacts.contact_name", "contacts.contact_id",
               "cases.case_number_full", "cases.case_id"],
    "from": "appts",
    "join": [
      { "type": "left", "table": "contacts",
        "on": { "left": "appts.appt_client_id", "right": "contacts.contact_id" } },
      { "type": "left", "table": "cases",
        "on": { "left": "appts.appt_case_id", "right": "cases.case_id" } }
    ],
    "where": [
      { "column": "appts.appt_status", "op": "=",    "value": "Scheduled" },
      { "column": "appts.appt_date",   "op": ">=",   "value": "{{todayStart}}" },
      { "column": "appts.appt_date",   "op": "<",    "value": "{{tomorrowStart}}" }
    ],
    "order_by": [{ "column": "appts.appt_date", "dir": "asc" }],
    "format": "html_rows",
    "html_columns": [
      { "column": "appts.appt_id",          "label": "ID" },
      { "column": "appts.appt_type",        "label": "Type" },
      { "column": "appts.appt_date",        "label": "Date & Time" },
      { "column": "contacts.contact_name",  "label": "Client",
        "link_base": "/?contact=", "link_id": "contacts.contact_id" },
      { "column": "cases.case_number_full", "label": "Case",
        "link_base": "/?case=",    "link_id": "cases.case_id" }
    ],
    "output_var": "apptRows",
    "count_var":  "apptCount"
  }
}
```

> Note: for appointment reports, prefer `get_appointments` — it handles date shortcuts (`"today"`, `"tomorrow"`), pre-formats date strings, and is simpler to configure. Use `query_db` when you need custom JOINs, non-standard filters, or data from tables `get_appointments` doesn't cover.

---

**Security model:**
- JSON structure makes SQL injection impossible — no raw SQL strings ever reach the DB
- All identifiers validated as word characters only (`[\w.]+`)
- All WHERE values are fully parameterized (`?` placeholders)
- Table whitelist enforced — unlisted tables throw a clear error
- Blocked columns stripped from results server-side — callers cannot access them even if selected

---

## General Query

### `query_db`
Build and execute a safe parameterized SELECT from a JSON descriptor. No raw SQL accepted — the query is constructed entirely from validated, whitelisted identifiers with fully parameterized WHERE values.

This is the right function when:
- You need data from tables not covered by `get_appointments` or `lookup_contact`
- You need a JOIN across multiple tables (e.g. judge via `case_judge → judges`)
- You need computed counts, filtered lists, or data for logic branching

Use `get_appointments` for appointment-specific queries — it has richer output formatting. Use `query_db` for everything else.

#### Security model
- Only tables in the **allowed list** can be queried. Sensitive tables (`email_credentials`, `app_settings`, `jwt_api_audit_log`) are excluded entirely.
- `users.password` and `users.password_hash` are stripped from all results even if selected.
- All column and table names are validated as word characters only — no injection possible via identifiers.
- All WHERE values are fully parameterized — no injection possible via values.

#### Allowed tables
`contacts`, `cases`, `appts`, `tasks`, `log`, `users`, `phone_lines`, `scheduled_jobs`, `workflows`, `workflow_executions`, `workflow_execution_steps`, `sequence_templates`, `sequence_steps`, `sequence_enrollments`, `sequence_step_log`, `case_judge`, `case_relate`, `case_trustee`, `judges`, `trustees`, `checkitems`, `checklists`, `job_results`

---

#### Params

| Param | Type | Description |
|-------|------|-------------|
| `select` | string[] | Columns to select. Use `"table.column"` notation. `"*"` selects all from the FROM table. |
| `from` | string | Primary table name |
| `join` | object[] | Optional JOIN clauses — see below |
| `where` | object[] | Optional WHERE conditions — see below |
| `where_mode` | string | `"and"` (default) or `"or"` — how to combine WHERE clauses |
| `order_by` | object[] | Optional — `[{ "column": "table.col", "dir": "asc"\|"desc" }]` |
| `limit` | number | Max rows returned. Default 100, max 1000. |
| `format` | string | `"raw"` \| `"html_rows"` \| `"count"` \| `"first"` — see formats below |
| `output_var` | string | Store formatted result in this workflow variable |
| `count_var` | string | Store row count in this workflow variable |
| `base_url` | string | Base URL for links in `html_rows` (default `https://app.4lsg.com`) |
| `html_columns` | object[] | Column display config for `html_rows` — see below |

#### JOIN shape
```json
{
  "type":  "left",
  "table": "judges",
  "alias": "j",
  "on": {
    "left":  "cj.judge_id",
    "right": "j.judge_id"
  }
}
```
`type` options: `"inner"`, `"left"`, `"right"`. Default `"left"`.
`alias` is optional but required when joining the same table twice or to use a short name in SELECT/WHERE.

#### WHERE shape
```json
{ "column": "appts.appt_status", "op": "=",        "value": "Scheduled" }
{ "column": "appts.appt_date",   "op": ">=",       "value": "{{fromDate}}" }
{ "column": "appts.appt_id",     "op": "IN",       "value": [1, 2, 3] }
{ "column": "contacts.contact_dob", "op": "IS NULL" }
```

Supported operators: `=` `!=` `<>` `>` `<` `>=` `<=` `LIKE` `NOT LIKE` `IN` `NOT IN` `IS NULL` `IS NOT NULL`

`IN` / `NOT IN` require `value` to be a non-empty array.
`IS NULL` / `IS NOT NULL` require no `value`.

#### Formats

| Format | Returns | Use for |
|--------|---------|---------|
| `"raw"` | Array of row objects | Logic, variable storage, further processing |
| `"first"` | Single row object or `null` | Single-record lookups |
| `"count"` | Number | Counting rows for branching |
| `"html_rows"` | `<tr>` HTML string | Email tables |

#### HTML_COLUMNS shape (for `format: "html_rows"`)
```json
[
  { "column": "appts.appt_id",          "label": "ID" },
  { "column": "appts.appt_type",         "label": "Type" },
  { "column": "contacts.contact_name",   "label": "Client",
    "link_base": "/?contact=", "link_id": "contacts.contact_id" }
]
```
If `html_columns` is omitted, all selected columns are rendered as plain text cells.
`link_base` + `link_id` produce `<a href="{base_url}{link_base}{link_id_value}">` links.

---

#### Example 1 — Fetch judge and trustee for a case
`cases.case_judge` and `cases.case_trustee` are varchar columns that store names directly.
Join on name equality rather than an ID.

```json
{
  "function_name": "query_db",
  "params": {
    "select": ["cases.case_id", "cases.case_number_full",
               "j.judge_name", "t.trustee_full_name"],
    "from": "cases",
    "join": [
      { "type": "left", "table": "judges",   "alias": "j",
        "on": { "left": "cases.case_judge",   "right": "j.judge_name" } },
      { "type": "left", "table": "trustees",  "alias": "t",
        "on": { "left": "cases.case_trustee", "right": "t.trustee_full_name" } }
    ],
    "where":  [{ "column": "cases.case_id", "op": "=", "value": "{{caseId}}" }],
    "format": "first",
    "output_var": "caseDetails"
  },
  "set_vars": {
    "judgeName":   "{{this.output.judge_name}}",
    "trusteeName": "{{this.output.trustee_full_name}}"
  }
}
```

#### Example 2 — Count today's no-shows for branching
```json
{
  "function_name": "query_db",
  "params": {
    "select": ["appts.appt_id"],
    "from":   "appts",
    "where": [
      { "column": "appts.appt_status", "op": "=",  "value": "No Show" },
      { "column": "appts.appt_date",   "op": ">=", "value": "{{todayStart}}" },
      { "column": "appts.appt_date",   "op": "<",  "value": "{{tomorrowStart}}" }
    ],
    "format":    "count",
    "count_var": "noShowCount"
  }
}
```
Then use `evaluate_condition` on `noShowCount` to branch.

#### Example 3 — HTML table for email with links
```json
{
  "function_name": "query_db",
  "params": {
    "select": ["appts.appt_id", "appts.appt_type", "contacts.contact_name", "contacts.contact_id"],
    "from":   "appts",
    "join": [{
      "type": "left", "table": "contacts",
      "on": { "left": "appts.appt_client_id", "right": "contacts.contact_id" }
    }],
    "where":    [{ "column": "appts.appt_status", "op": "=", "value": "Scheduled" }],
    "order_by": [{ "column": "appts.appt_date", "dir": "asc" }],
    "limit":    50,
    "format":   "html_rows",
    "html_columns": [
      { "column": "appts.appt_id",        "label": "ID" },
      { "column": "appts.appt_type",       "label": "Type" },
      { "column": "contacts.contact_name", "label": "Client",
        "link_base": "/?contact=", "link_id": "contacts.contact_id" }
    ],
    "output_var": "apptTableRows"
  }
}
```

#### What `query_db` cannot do
If you need aggregates (`COUNT(*)`, `SUM`, `AVG`), `GROUP BY`, `HAVING`, subqueries, or `UNION` — write a dedicated `internal_function` instead. These are intentionally excluded to keep the security model simple and the query structure predictable.

## Dev / Testing

### `set_test_var`
Sets `testKey = "hello"`. Used to verify the engine works end to end. Remove or restrict in production.