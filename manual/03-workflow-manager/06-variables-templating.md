# Part 6 — Variables & Templating

The system has two distinct variable/placeholder systems that work differently depending on which engine you are using.

---

## The Two Systems

### 1. Workflow Variables — `{{variableName}}`

Used in **workflows only**. Variables are key/value pairs stored in `workflow_executions.variables`. They are set from `init_data` at start and updated by steps via `set_vars`.

```
Start: { contactId: 123, source: "web" }
Step 1 lookup_contact sets: { contact_fname: "Fred", contact_email: "fred@..." }
Step 2 uses: "Hi {{contact_fname}}, ..."
```

Resolution is done by `resolvePlaceholders()` in `workflow_engine.js` before each step executes.

### 2. Universal Resolver — `{{table.column|modifier}}`

Used in **sequences** and available to **workflows** and **standalone jobs**. Resolves directly against live DB data using a single JOIN query. No variables need to be set in advance — the resolver fetches whatever is needed at resolution time.

```
"Hi {{contacts.contact_fname}}, your appt on {{appts.appt_date|date:dddd MMMM Do}}"
refs: { contacts: { contact_id: 1001 }, appts: { appt_id: 456 } }
→ "Hi Fred, your appt on Thursday October 16th"
```

Resolution is done by `services/resolverService.js`.

The resolver also supports a **pseudo-table** named `trigger_data` — placeholders like `{{trigger_data.amount}}` resolve from an in-memory object passed via `refs.trigger_data` rather than via SQL. See [Pseudo-table: `trigger_data`](#pseudo-table-trigger_data) below.

---

## Universal Resolver — Syntax

### Basic
```
{{table.column}}
{{contacts.contact_fname}}
{{appts.appt_date}}
{{users.user_name}}
```

### With modifier
```
{{contacts.contact_phone|phone}}
{{appts.appt_date|date:dddd MMMM Do}}
{{contacts.contact_name|upper}}
{{contacts.contact_email|email_mask}}
```

### With default fallback
```
{{contacts.contact_email|default:no email on file}}
{{contacts.contact_email|default:{{contacts.contact_email2}}|default:no email}}
```

Defaults are resolved left-to-right and can be chained. Nested `{{...}}` defaults are fully supported.

### Pseudo-table: `trigger_data`

`trigger_data` isn't a real database table — it's an **in-memory object** passed to the resolver through `refs.trigger_data`. Placeholders that reference it resolve directly from that object; no SQL is issued for them.

```
{{trigger_data.amount}}
{{trigger_data.missed_date|date:dddd MMMM Do}}
{{trigger_data.user.email}}                   (nested dot-path)
{{trigger_data.amount|default:TBD}}
{{trigger_data.preferred_name|default:{{contacts.contact_fname}}}}
```

**Dot-path.** Everything after the first dot is treated as a dot-path walk over `refs.trigger_data` — the same semantics as `getNestedValue` in `sequenceEngine.checkCondition`. `{{trigger_data.a.b.c}}` reads `refs.trigger_data.a.b.c`.

**All modifiers work.** `|date:`, `|phone`, `|email_mask`, `|upper`, `|cap`, `|default:`, etc. behave identically to real-table values.

**Soft-fail for missing keys.** If the key isn't present (or `refs.trigger_data` isn't passed at all), the placeholder is left unresolved (literal `{{trigger_data.x}}` stays in the output) and `result.status` becomes `partial_success`. With `strict: true`, status becomes `failed`. This matches how missing columns behave for real tables.

**Nested defaults still do SQL.** A default branch like `|default:{{contacts.contact_fname}}` is resolved via the normal contacts refs — the resolver recurses into defaults during its scan, so a single resolve call can mix trigger_data and real-table lookups in one expression.

**Security.** Unlike real tables, `trigger_data` bypasses `ALLOWED_TABLES` and `BLOCKED_COLUMNS`. That's fine — the caller controls what's in the object, and nothing in it came from SQL. Don't stuff sensitive columns from DB rows into `refs.trigger_data` expecting them to be filtered; they won't be.

**Available in:** sequence `action_config` (auto-provided from `enrollment.trigger_data`), and any direct `resolverService.resolve()` call where the caller passes `refs.trigger_data`. **Not currently wired** into campaign bodies (campaigns pass only `refs.contacts`) or hook body templates.

---

## Modifiers

Applied left-to-right after the value is fetched. Multiple modifiers can be chained with `|`.

### Date/Time
Format a date or datetime value.

```
{{appts.appt_date|date:dddd MMMM Do, YYYY}}   → "Thursday October 16th, 2026"
{{appts.appt_time|time:h:mm A}}               → "2:00 PM"
```

**Format tokens:**

| Token | Output | Example |
|-------|--------|---------|
| `YYYY` | 4-digit year | 2026 |
| `MM` | 2-digit month | 03 |
| `MMMM` | Full month name | March |
| `MMM` | Short month | Mar |
| `DD` | 2-digit day | 08 |
| `D` | Day number | 8 |
| `Do` | Ordinal day | 8th |
| `DoW` | Ordinal word | Eighth |
| `dddd` | Full weekday | Thursday |
| `ddd` | Short weekday | Thurs |
| `HH` | 24h hour | 14 |
| `hh` | 12h hour padded | 02 |
| `h` | 12h hour unpadded | 2 |
| `mm` | Minutes | 00 |
| `ss` | Seconds | 00 |
| `A` | AM/PM | PM |

### Phone
```
{{contacts.contact_phone|phone}}   → "(313) 555-1234"
```

### Email mask
```
{{contacts.contact_email|email_mask}}   → "f***@e*****.com"
```

### Text transform
```
{{contacts.contact_name|upper}}      → "FRED SMITH"
{{contacts.contact_name|lower}}      → "fred smith"
{{contacts.contact_name|cap}}        → "Fred Smith"
```

`upper` / `uppercase`, `lower` / `lowercase`, `cap` / `capitalize` are all accepted.

---

## Allowed Tables

The resolver will only query these tables. Attempting any other table returns an error.

```
contacts, cases, appts, tasks, log, users,
phone_lines, scheduled_jobs, workflows,
workflow_executions, sequence_enrollments, sequence_templates
```

**Blocked columns** (never returned regardless of table):
- `contacts.contact_ssn`
- `users.password`, `users.password_hash`

`trigger_data` is **not** on this list because it isn't a SQL table — it's the pseudo-table described above. `GET /resolve/tables` returns only real tables; it doesn't advertise `trigger_data`.

---

## Using the Resolver via API

```js
await apiSend("/resolve", "POST", {
  text: "Hi {{contacts.contact_fname}}, your case {{cases.case_number_full}} was assigned to {{users.user_name}}.",
  refs: {
    contacts: { contact_id: 1001 },
    cases:    { case_id: "AB123456" },
    users:    { user: 2 }
  }
});
// → { status: "success", text: "Hi Fred, your case 23-51404 was assigned to Stuart Sandweiss.", unresolved: [] }
```

**With `trigger_data`:**
```js
await apiSend("/resolve", "POST", {
  text: "Amount owed: ${{trigger_data.amount}}, due {{trigger_data.due_date|date:dddd MMMM Do}}.",
  refs: {
    trigger_data: { amount: 250.50, due_date: "2026-05-01T00:00:00Z" }
  }
});
// → { status: "success", text: "Amount owed: $250.5, due Friday May 1st", unresolved: [] }
```

Refs under real-table names must still be a single-anchor-key object (`{ contact_id: 1001 }`). `refs.trigger_data` is exempt from that rule — pass it as a free-form object with any number of keys, including nested objects for dot-path access.

**Response statuses:**
- `success` — all placeholders resolved
- `partial_success` — some unresolved (null values, bad IDs, unknown tables, missing trigger_data keys). Resolved placeholders are still returned.
- `failed` — strict mode and unresolved placeholders remain

**`GET /resolve/tables`** — returns the allowed table list (real tables only — `trigger_data` is not included because it isn't a SQL-queryable table).

---

## Workflow Variables — `{{this}}` and `{{env}}`

These are only available within the **workflow engine**, not the universal resolver.

### `{{this}}` — current step output

After a step executes, its raw output is available as `{{this}}` when resolving `set_vars`.

**Webhooks** — `this` is the response body directly:
```json
"set_vars": { "randomNumber": "{{this.[0]}}" }
```

**Internal functions** — `this` is `{ success, output, ... }`, so fields are under `this.output`:
```json
"set_vars": { "contact_fname": "{{this.output.contact_fname}}" }
```

### `{{env}}` — engine-provided helpers

| Variable | Value |
|----------|-------|
| `{{env.now}}` | Current UTC datetime as ISO string |
| `{{env.executionId}}` | Current workflow execution ID |
| `{{env.stepNumber}}` | Current step number |

---

## In Sequences — How Placeholders Work

In sequence step `action_config`, use the universal resolver syntax directly:

```json
{
  "function_name": "send_sms",
  "params": {
    "from":    "2485592400",
    "to":      "{{contacts.contact_phone}}",
    "message": "Hi {{contacts.contact_fname}}, your appointment is on {{appts.appt_date|date:dddd}}."
  }
}
```

The engine builds `refs` automatically from `enrollment.contact_id` and `trigger_data` (appt_id, case_id etc.), then calls `resolverService.resolve()` on the config JSON before executing the step. You do not need to set variables in advance.

**Refs auto-built in sequence steps:**

| Ref | Always present? | Source |
|---|---|---|
| `contacts` | Yes | `{ contact_id: enrollment.contact_id }` |
| `appts` | If `trigger_data.appt_id` exists | `{ appt_id: trigger_data.appt_id }` |
| `cases` | If `trigger_data.case_id` exists | `{ case_id: trigger_data.case_id }` |
| `tasks` | If `trigger_data.task_id` exists | `{ task_id: trigger_data.task_id }` |
| `trigger_data` | Always (pseudo-table) | The full `enrollment.trigger_data` object |

The `trigger_data` pseudo-table is what lets you inject values that don't live on any indexed table — amounts, missed dates, day-of-week strings, arbitrary labels — directly into message bodies:

```json
{
  "function_name": "send_email",
  "params": {
    "to":      "{{contacts.contact_email}}",
    "subject": "Your balance of ${{trigger_data.amount}} is due",
    "text":    "Hi {{contacts.contact_fname}},<br>Your missed payment from {{trigger_data.missed_date|date:dddd, MMMM Do}} is ${{trigger_data.amount}}."
  }
}
```

Enrolled with:

```js
await apiSend("/sequences/enroll", "POST", {
  contact_id:   1001,
  template_id:  14,
  trigger_data: { amount: 250.50, missed_date: "2026-04-20T00:00:00Z" }
});
```