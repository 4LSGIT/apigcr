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

**Response statuses:**
- `success` — all placeholders resolved
- `partial_success` — some unresolved (null values, bad IDs, unknown tables). Resolved placeholders are still returned.
- `failed` — strict mode and unresolved placeholders remain

**`GET /resolve/tables`** — returns the allowed table list.

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
