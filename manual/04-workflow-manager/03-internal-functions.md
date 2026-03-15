# Part 3 — Internal Functions Reference

Internal functions are built-in actions that run inside the workflow engine. They are used as steps with `"type": "internal_function"` and a `config` that specifies which function to call and what parameters to pass.

---

## How a Step Config Is Structured

```json
{
  "stepNumber": 2,
  "type": "internal_function",
  "config": {
    "function_name": "send_email",
    "params": {
      "from": "stuart@4lsg.com",
      "to": "{{contact_email}}",
      "subject": "Hello {{contact_fname}}",
      "text": "We received your inquiry."
    },
    "set_vars": {
      "emailSentAt": "{{env.now}}"
    }
  },
  "error_policy": { "strategy": "retry_then_abort", "max_retries": 2 }
}
```

- `function_name` — which function to call (listed below)
- `params` — passed directly to the function; `{{variables}}` are resolved before the function runs
- `set_vars` — maps function output fields into workflow variables using `{{this.output.field}}` syntax (see [04-variables-templating.md](04-variables-templating.md))
- `error_policy` — what to do on failure (see [05-error-policies.md](05-error-policies.md))

---

## Control Flow

### `set_next`
Jump to a specific step number, or terminate the workflow.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `value` | number \| `"cancel"` \| `"fail"` \| `null` | Step to jump to. `null` ends normally. `"cancel"` marks as cancelled. `"fail"` marks as failed. |

**Example — skip to step 8:**
```json
{
  "function_name": "set_next",
  "params": { "value": 8 }
}
```

**Example — end workflow normally:**
```json
{ "function_name": "set_next", "params": { "value": null } }
```

> Note: `set_next` is the only function whose `next_step` output is honored by the engine. Other functions can return `next_step` but it will be ignored unless the engine specifically supports it (currently only `set_next` and `schedule_resume`/`wait_for`/`wait_until_time`).

---

### `evaluate_condition`
Branch to different steps based on a variable comparison.

**Params (simple form):**
| Param | Type | Description |
|-------|------|-------------|
| `variable` | string | Workflow variable name to test |
| `operator` | string | See operators table below |
| `value` | any | Value to compare against |
| `then` | number | Step to go to if condition is true |
| `else` | number \| null | Step to go to if false. `null` = continue sequentially |

**Operators:**
| Operator | Description |
|----------|-------------|
| `==` | Equal (loose — `"5" == 5` is true) |
| `!=` | Not equal |
| `>` `<` `>=` `<=` | Numeric comparison |
| `contains` | String contains value |
| `not_contains` | String does not contain value |
| `is_empty` | Variable is null or `""` |
| `is_not_empty` | Variable is not null and not `""` |

**Example:**
```json
{
  "function_name": "evaluate_condition",
  "params": {
    "variable": "appt_status",
    "operator": "==",
    "value": "confirmed",
    "then": 5,
    "else": 8
  }
}
```

**Params (array form — multiple conditions):**
```json
{
  "function_name": "evaluate_condition",
  "params": {
    "conditions": [
      { "variable": "appt_status", "operator": "==", "value": "confirmed" },
      { "variable": "contact_type", "operator": "!=", "value": "vip" }
    ],
    "match": "all",
    "then": 5,
    "else": 8
  }
}
```

`match` is `"all"` (AND) or `"any"` (OR). Default is `"all"`.

---

## Variable Manipulation

### `noop`
Does nothing. Used when you only want to set variables via the step config's `set_vars`.

**Params:** none

**Example — set a stage variable without calling anything:**
```json
{
  "function_name": "noop",
  "params": {},
  "set_vars": {
    "stage": "intake",
    "startedAt": "{{env.now}}"
  }
}
```

---

### `set_var`
Set a single workflow variable to a value.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Variable name |
| `value` | any | Value to assign |

**Example:**
```json
{ "function_name": "set_var", "params": { "name": "stage", "value": "follow_up" } }
```

---

### `format_string`
Build a string from a template and store it as a variable. The engine resolves `{{placeholders}}` before this runs, so by the time the function executes, the template is already fully interpolated — the function just stores the result.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `template` | string | Template string with `{{variables}}` |
| `output_var` | string | Variable name to store the result in |

**Example:**
```json
{
  "function_name": "format_string",
  "params": {
    "template": "{{contact_fname}} {{contact_lname}}",
    "output_var": "fullName"
  }
}
```

---

## Time / Scheduling

### `schedule_resume`
Pause the workflow and resume at a specific future time. The execution status becomes `delayed` and a `workflow_resume` scheduled job is created automatically.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `resumeAt` | string \| number | ISO datetime, duration string (`"10m"`, `"2h"`, `"1d"`), or milliseconds from now |
| `nextStep` | number | Step number to resume at |

**Example:**
```json
{ "function_name": "schedule_resume", "params": { "resumeAt": "24h", "nextStep": 5 } }
```

---

### `wait_for`
Convenience alias for `schedule_resume`. Pauses for a duration and resumes at the next step.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `duration` | string \| number | Duration string (`"5m"`, `"2h"`, `"3d"`) or milliseconds |
| `nextStep` | number | Step to resume at |

**Example:**
```json
{ "function_name": "wait_for", "params": { "duration": "5m", "nextStep": 4 } }
```

---

### `wait_until_time`
Pause until the next occurrence of a specific time of day in a given timezone. If that time has already passed today, resumes tomorrow.

**Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `time` | string | — | `"HH:MM"` in 24-hour format |
| `timezone` | string | `"UTC"` | IANA timezone name |
| `nextStep` | number | — | Step to resume at |

**Example — resume at 9am Detroit time:**
```json
{
  "function_name": "wait_until_time",
  "params": { "time": "09:00", "timezone": "America/Detroit", "nextStep": 6 }
}
```

---

## Communication

### `send_sms`
Send an SMS from an internal phone line. The `from` number must exist in the `phone_lines` table. Routes to the correct provider (Quo/RingCentral) automatically.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `from` | string | 10-digit number matching `phone_lines.phone_number` |
| `to` | string | Recipient number (any common format, non-digits stripped automatically) |
| `message` | string | Message body (`{{variables}}` resolved before call) |

**Returns:** Provider result as `output`.

**Example:**
```json
{
  "function_name": "send_sms",
  "params": {
    "from": "2485592400",
    "to": "{{contact_phone}}",
    "message": "Hi {{contact_fname}}, this is Stuart from 4LSG. We'll be in touch soon."
  }
}
```

---

### `send_email`
Send an email via the configured provider (SMTP or Pabbly) for the `from` address. Credentials are looked up automatically from `email_credentials`.

At least one of `text` or `html` is required. If only one is provided, the other is auto-generated:
- HTML only → plain text is generated by stripping tags
- Text only → HTML is generated by wrapping in `<p>` tags

**Params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | ✓ | Must match a row in `email_credentials` |
| `to` | string | ✓ | Recipient address |
| `subject` | string | ✓ | Email subject |
| `text` | string | either | Plain text body |
| `html` | string | either | HTML body |

**Returns:** Provider result as `output` (includes `messageId`).

**Example (text only):**
```json
{
  "function_name": "send_email",
  "params": {
    "from": "stuart@4lsg.com",
    "to": "{{contact_email}}",
    "subject": "We received your inquiry",
    "text": "Hi {{contact_fname}},\n\nThank you for reaching out. We will be in touch shortly."
  }
}
```

---

## Tasks

### `create_task`
Insert a task row linked to a contact.

**Params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✓ | Task title |
| `description` | string | — | Optional description |
| `contact_id` | number \| string | ✓ | FK to contacts |
| `assigned_to` | number | ✓ | User ID to assign to |
| `due_date` | string | — | ISO date or datetime |

**Returns:** `{ task_id }` as `output`.

**Example:**
```json
{
  "function_name": "create_task",
  "params": {
    "title": "Follow up call",
    "contact_id": "{{contactId}}",
    "assigned_to": 2,
    "due_date": "{{followUpDate}}"
  },
  "set_vars": { "newTaskId": "{{this.output.task_id}}" }
}
```

---

## Contacts

### `lookup_contact`
Fetch a full contact row by ID. Returns the entire row as `output` — use `set_vars` in the step config to map fields into workflow variables.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `contact_id` | number \| string | Can be a `{{variable}}` |

**Returns:** Full contact row as `output` (excludes SSN).

**Available output fields** (from `contacts` table):
`contact_id`, `contact_fname`, `contact_lname`, `contact_name`, `contact_pname`,
`contact_phone`, `contact_phone2`, `contact_email`, `contact_email2`,
`contact_type`, `contact_address`, `contact_city`, `contact_state`, `contact_zip`,
`contact_dob`, `contact_marital_status`, `contact_tags`, `contact_notes`,
`contact_clio_id`, `contact_created`

**Example:**
```json
{
  "function_name": "lookup_contact",
  "params": { "contact_id": "{{contactId}}" },
  "set_vars": {
    "contact_fname":  "{{this.output.contact_fname}}",
    "contact_lname":  "{{this.output.contact_lname}}",
    "contact_email":  "{{this.output.contact_email}}",
    "contact_phone":  "{{this.output.contact_phone}}",
    "contact_name":   "{{this.output.contact_name}}"
  }
}
```

---

### `update_contact`
Update one or more fields on a contact row.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `contact_id` | number \| string | Target contact |
| `fields` | object | Key/value pairs matching column names |

**Returns:** `{ contact_id }` as `output`.

**Example:**
```json
{
  "function_name": "update_contact",
  "params": {
    "contact_id": "{{contactId}}",
    "fields": { "contact_tags": "intake-complete" }
  }
}
```

---

## Appointments

### `lookup_appointment`
Fetch a full appointment row by ID. Same pattern as `lookup_contact`.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `appointment_id` | number \| string | Can be a `{{variable}}` |

**Returns:** Full appointment row as `output`.

**Example:**
```json
{
  "function_name": "lookup_appointment",
  "params": { "appointment_id": "{{apptId}}" },
  "set_vars": {
    "appt_status": "{{this.output.status}}",
    "appt_date":   "{{this.output.appointment_date}}"
  }
}
```

---

### `update_appointment`
Update one or more fields on an appointment row.

**Params:**
| Param | Type | Description |
|-------|------|-------------|
| `appointment_id` | number \| string | Target appointment |
| `fields` | object | Key/value pairs matching column names |

**Example:**
```json
{
  "function_name": "update_appointment",
  "params": {
    "appointment_id": "{{apptId}}",
    "fields": { "status": "confirmed" }
  }
}
```

---

## Dev / Testing

### `set_test_var`
Sets `testKey = "hello"` in workflow variables. Used to verify the engine is working end-to-end. Remove or restrict in production.

**Params:** none
