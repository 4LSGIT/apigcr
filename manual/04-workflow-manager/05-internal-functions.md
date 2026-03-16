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

## Dev / Testing

### `set_test_var`
Sets `testKey = "hello"`. Used to verify the engine works end to end. Remove or restrict in production.
