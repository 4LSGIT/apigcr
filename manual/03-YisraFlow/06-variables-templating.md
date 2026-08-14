# 6 — Variables & Templating

## For operators

Anywhere you write text in the system — an SMS message, an email subject, a webhook URL, a workflow step config — you can drop in **placeholders** that get filled in with real data when the action fires.

Two flavors:

```
{{contacts.contact_fname}}              ← from a database table (universal)
{{contactName}}                         ← from a workflow's variable store (workflow only)
```

The first works everywhere — sequences, hooks, scheduled jobs, campaigns, anywhere. The second only works inside a workflow.

You can also format the value — **but only for `{{table.column}}` placeholders**:

```
{{contacts.contact_phone|phone}}        → (313) 555-1234
{{appts.appt_date|date:dddd MMMM Do}}   → Friday March 20th
{{contacts.contact_email|email_mask}}   → s***@example.com
{{trigger_data.missing|default:N/A}}    → N/A   (when missing field is empty)
```

**Modifiers do not work on workflow variables.** `{{myVar|default:Hello}}` inside a workflow step does **not** fall back to "Hello" — it produces an **empty string**, silently. There is no `|default:` in the workflow engine; the whole thing including the `|` is read as one variable name, which never matches. If you need a fallback in a workflow, set the variable earlier (a `set_vars` on a previous step, or `initData` on the trigger) so it is never missing. See "Two systems, one syntax" below — this trap has cost real production bugs.

When a `{{table.column}}` placeholder doesn't resolve (the contact doesn't exist, the field is empty, you typed the column wrong), it stays in the text as `{{contacts.contact_fname}}` so you can see what went wrong. A **workflow variable** that doesn't resolve behaves the opposite way: it disappears, leaving an empty string.

---

## Technical reference

### Two systems, one syntax

| Layer | Implemented in | Applies to | Modifiers | Unresolved token |
|---|---|---|---|---|
| **Workflow variables** | `lib/workflow_engine.js` `resolveSingle` | workflow step configs, and nothing else | **none** | becomes `''` |
| **Universal resolver** | `services/resolverService.js` | sequences, hooks, scheduled jobs, campaigns, portal cards, e-sign templates, appts, booking | `default:`, `date:`, `phone`, `upper`, … | left visible as `{{table.column}}` |

**A workflow step's config is NOT run through both.** `lib/workflow_engine.js` never requires `resolverService` — verify with a grep before believing otherwise. A workflow step config gets exactly one pass, the variable pass, and that pass **consumes every `{{…}}` token it sees**: anything it can't resolve is replaced with an empty string. So a `{{table.column|modifier}}` written into a workflow step is not "left for the universal resolver later" — it is destroyed on the way past.

Practical consequences for workflow step configs:

- `{{contacts.contact_fname}}` in a workflow step resolves to `''`, not to a name. Workflows reach contact data through the variables the engine loads — `{{contactName}}`, `{{contactData.contact_fname}}` — not through table placeholders.
- `{{anything|default:X}}` resolves to `''`. Always. The `|default:` is part of the variable name being looked up.
- Both failures are **silent**: an empty subject, an empty SMS field, a dropped email attachment. Nothing logs, nothing throws.

> **This has already bitten production.** wf40 (the shared form-notify workflow) carried
> `"subject": "{{log_subject|default:Form submission received}}"` from 2026-08-13 to
> 2026-08-14. Every form log written in that window got an empty subject. The fix was the
> plain `{{log_subject}}` — the value was always in `initData`; only the modifier was
> imaginary. When you want a fallback in a workflow, guarantee the variable instead.

The distinction is not cosmetic: the two resolvers were built for different jobs. The universal resolver fetches live DB rows and is deliberately soft-fail and visible, because it renders text a human will read and a broken token should be obvious. The workflow resolver walks an in-memory variable store, is used on machine config (URLs, ids, JSON bodies) as well as prose, and blanks unknowns so a half-resolved URL doesn't get called.

### Universal resolver — `{{table.column|modifier|...}}`

The resolver is `services/resolverService.js`, called as `resolve({ db, text, refs, strict })`.

**Inputs:**
- `text` — string with placeholders
- `refs` — single-anchor objects per table: `{ contacts: { contact_id: 123 }, cases: { case_id: "abc12345" } }`
- `strict` — if true, unresolved placeholders return `status: 'failed'`. Default false.

**How it works:**
1. **Scan** the text for every `{{table.column}}` placeholder
2. **Validate** the table is on the whitelist; the column isn't blocked
3. **Build SQL** — first table is the FROM, rest are LEFT JOINs (so a missing anchor in one table nulls just that table's columns, not the whole row)
4. **Execute** one query, get one row (`LIMIT 1`)
5. **Substitute** each placeholder with `row[table__column]`, applying any modifiers
6. **Return** the resolved text + a list of any placeholders it couldn't resolve

DB errors **propagate** — they don't become `status: 'failed'` (that would mask infrastructure failures as semantic ones).

### Allowed tables (12)

```
contacts                  cases                   appts
tasks                     log                     users
phone_lines               scheduled_jobs          workflows
workflow_executions       sequence_enrollments    sequence_templates
```

Anything else is "soft unresolved" — placeholder stays as-is, doesn't error.

### Blocked columns

| Table | Column | Reason |
|---|---|---|
| `contacts` | `contact_ssn` | Sensitive |
| `users` | `password` | Sensitive |
| `users` | `password_hash` | Sensitive |

A reference to a blocked column **hard-fails** with `errorType: 'security'`. Different from unknown tables.

### Modifiers

Pipe one or more modifiers after the field reference:

| Modifier | Example | Result |
|---|---|---|
| `date:FORMAT` | `{{appts.appt_date\|date:MM/DD/YYYY}}` | `03/20/2026` |
| `time:FORMAT` | `{{appts.appt_date\|time:h:mma}}` | `2:00pm` |
| `phone` | `{{contacts.contact_phone\|phone}}` | `(313) 555-1234` |
| `email_mask` | `{{contacts.contact_email\|email_mask}}` | `s***@example.com` |
| `upper` | `{{contacts.contact_fname\|upper}}` | `STUART` |
| `lower` | `{{contacts.contact_fname\|lower}}` | `stuart` |
| `cap` | `{{contacts.contact_fname\|cap}}` | `Stuart` |
| `default:VALUE` | `{{contacts.contact_pname\|default:Sir/Madam}}` | `Sir/Madam` |

**Date format tokens** (moment.js style):
- `YYYY` 4-digit year, `YY` 2-digit
- `MMMM` January, `MMM` Jan, `MM` 01, `M` 1
- `DD` 02, `D` 2, `Do` 2nd
- `dddd` Monday, `ddd` Mon
- `HH` 24h hour, `hh` 12h hour, `mm` minutes, `a` am/pm

**`default:` chaining** — the default value can itself be a placeholder. Resolver recurses up to depth 20:
```
{{trigger_data.amount|default:{{contacts.contact_billing_default}}}}
```

### `trigger_data` — the pseudo-table

`trigger_data` looks like a table in placeholder syntax but is **not a SQL table** — it's a free-form object passed in `refs.trigger_data`. The resolver walks dot-paths into the object instead of querying.

```js
await apiSend("/resolve", "POST", {
  text: "Amount ${{trigger_data.amount}}, missed {{trigger_data.missed_date|date:dddd}}.",
  refs: {
    trigger_data: { amount: 250.50, missed_date: "2026-03-20T14:00:00Z" }
  }
});
// → "Amount $250.5, missed Friday."
```

**Differences from real-table refs:**
- `refs.trigger_data` accepts arbitrary keys — not the single-anchor-key `{ contact_id: 123 }` shape that real tables require
- Supports nested objects: `{{trigger_data.payment.last_four}}` walks `refs.trigger_data.payment.last_four`
- Auto-populated by the sequence engine from `sequence_enrollments.trigger_data`
- Cannot be queried via `GET /resolve/tables` (it's not a real table)

### How sequences auto-build refs

You don't pass `refs` directly when authoring sequences — `sequenceEngine.buildRefsForStep()` builds them from `enrollment.contact_id` and `trigger_data`:

```js
{
  contacts:     { contact_id: enrollment.contact_id },  // always
  trigger_data: enrollment.trigger_data || {},          // always
  appts:        { appt_id: trigger_data.appt_id }      // if trigger_data has appt_id
  cases:        { case_id: trigger_data.case_id },     // if trigger_data has case_id
  tasks:        { task_id: trigger_data.task_id }      // if trigger_data has task_id
}
```

So in a sequence step:

```
"Hi {{contacts.contact_fname}}, you missed your appointment on {{appts.appt_date|date:dddd}}.
{{trigger_data.note|default:Reach out when you can.}}"
```

…all four references resolve from refs the engine built without you naming them.

### Workflow variables — `{{variableName}}`

Workflow executions carry a flat key/value `variables` JSON column. Set from `init_data` at start, updated by steps via `set_vars` written into the step's config.

#### Reading
- `{{contactId}}` — top-level variable
- `{{this.output.id}}` — output of the just-executed step (workflow-only)
- `{{this}}` — the entire output of the just-executed step (for webhooks: response body directly)
- `{{env.executionId}}` — the current execution ID
- `{{env.stepNumber}}` — the current step number

#### Writing — `set_vars`
After a step runs, `set_vars` keys/values are merged into the execution's `variables` JSON. Values support full placeholder syntax:

```json
{
  "function_name": "lookup_contact",
  "params": { "contact_id": "{{contactId}}" },
  "set_vars": {
    "contactName":  "{{this.output.contact_name}}",
    "contactEmail": "{{this.output.contact_email}}",
    "primaryPhone": "{{this.output.contact_phone|phone}}"
  }
}
```

Subsequent steps can read `{{contactName}}` etc.

#### Variable name rules
- Must be a valid JS identifier (letters, digits, `_`, no spaces)
- Reserved names: `this`, `env` (these are special readers, not writable)
- Names are case-sensitive

#### Order of resolution

For workflow steps, placeholders resolve in this order:

```
1. {{this.x}}      → output of the just-executed step
2. {{env.x}}       → executionId, stepNumber
3. {{varName}}     → workflow variables (init_data + accumulated set_vars)
4. {{table.col}}   → universal resolver (DB query)
```

This means a workflow variable named `contactId` shadows the `contacts.contact_id` placeholder if you wrote `{{contactId}}` — the engine substitutes the variable first and the resolver never sees a placeholder by that name.

### Using the resolver via API

```
POST /resolve
{
  "text": "Hi {{contacts.contact_fname}}, your case is {{cases.case_number_full}}.",
  "refs": {
    "contacts": { "contact_id": 1001 },
    "cases":    { "case_id": "AB123456" }
  }
}

→ {
  "status": "success",
  "text":   "Hi Fred, your case is 23-51404.",
  "unresolved": []
}
```

**Statuses:**
- `success` — every placeholder resolved
- `partial_success` — some placeholders left in the text (in `unresolved` array)
- `failed` (with `errorType`) — `security` (blocked column), `missing_refs` (ref needed for referenced table), `query_error`

**`GET /resolve/tables`** — returns the list of allowed real tables. Doesn't include `trigger_data` (which isn't queryable).

### Strict mode

`strict: true` (used internally by Campaign Manager and a few critical paths) flips `partial_success` to `failed`. Use when an unresolved placeholder represents a permanent error you'd rather catch up front than silently ship to a recipient.
