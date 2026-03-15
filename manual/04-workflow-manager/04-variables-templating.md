# Part 4 — Variables & Templating

The workflow engine has a variable system that lets data flow between steps. Any value stored in a variable can be injected into step configs, message bodies, webhook URLs, and function params using `{{double-brace}}` syntax.

---

## Where Variables Come From

There are three sources of variables, resolved in this order of priority:

### 1. Init Data (from workflow start)

Everything passed in the body of `POST /workflows/:id/start` becomes a variable automatically:

```js
await apiSend("/workflows/1/start", "POST", {
  contactId: 123,
  contactName: "Fred Smith",
  source: "web"
});
```

Now `{{contactId}}`, `{{contactName}}`, and `{{source}}` are available in every step.

### 2. Variables Set by Steps (via `set_vars`)

Steps can write values into the variable store two ways:

**A — In the function return value** (functions like `set_var`, `format_string`, `set_test_var`)
The function itself returns `{ set_vars: { key: value } }` and the engine merges it in.

**B — In the step config's `set_vars` object** (works for all step types)
After a step executes, the engine resolves any `set_vars` in the config and merges those in too.

```json
{
  "function_name": "lookup_contact",
  "params": { "contact_id": "{{contactId}}" },
  "set_vars": {
    "contact_email": "{{this.output.contact_email}}",
    "contact_fname": "{{this.output.contact_fname}}"
  }
}
```

Both sources are merged — config `set_vars` can override function `set_vars` if the same key appears in both (config wins via spread order).

### 3. Engine Environment (`env`)

The engine provides a small set of read-only helpers:

| Variable | Value |
|----------|-------|
| `{{env.now}}` | Current UTC datetime as ISO string |
| `{{env.executionId}}` | The current execution's ID |
| `{{env.stepNumber}}` | The current step number |

---

## `{{this}}` — Current Step Output

After a step executes, its raw output is available as `{{this}}` when resolving `set_vars`. This is how you capture data from a webhook response or function return value.

**For webhooks:** `this` is the response body directly.
```json
// Webhook returns: [42, 17, 95]
"set_vars": { "randomNumber": "{{this.[0]}}" }   // → 42
```

**For internal functions:** `this` is the full return object `{ success, output }`.
```json
// lookup_contact returns: { success: true, output: { contact_fname: "Fred", ... } }
"set_vars": { "contact_fname": "{{this.output.contact_fname}}" }
```

> This is the key difference — webhooks return data directly, internal functions wrap it in `{ output }`.

---

## Placeholder Syntax

### Simple variable
```
{{contactId}}
{{contact_email}}
{{stage}}
```

### Nested object
```
{{contactData.first_name}}
{{address.city}}
```

### Array index
```
{{this.[0]}}          → first element of an array
{{results.[2].name}}  → name field of the third result
```

### This and env
```
{{this.output.contact_email}}   → output field from current step
{{this.[0]}}                    → first element of webhook response array
{{env.now}}                     → current UTC datetime
{{env.executionId}}             → current execution ID
{{env.stepNumber}}              → current step number
```

---

## Resolution Order

When a placeholder is resolved, the engine looks for it in this order:

1. **Variables** (top-level key match) — e.g. `{{contactId}}`
2. **Nested variable access** (dot notation) — e.g. `{{contactData.phone}}`
3. **`this`** (current step output) — e.g. `{{this.output.field}}`
4. **`env`** helpers — e.g. `{{env.now}}`

If a placeholder is not found, it resolves to an empty string `""` — no error is thrown.

---

## Where Placeholders Are Resolved

Placeholders are resolved in the step **config** before the step executes. This means:

- `params` values are resolved — so function arguments receive the actual values
- `set_vars` keys in config are resolved **after** execution (so `{{this}}` is available)
- URL strings in webhook configs are resolved
- Body objects in webhook configs are deeply resolved (all nested strings)
- Headers in webhook configs are resolved

`set_vars` within the function return value are **not** re-resolved — the function is responsible for returning final values.

---

## Variable Persistence

All variables are stored as a JSON object in the `workflow_executions.variables` column. They persist across delays and resumptions — so a variable set in step 2 is still available after a 24-hour `wait_for` in step 3.

Variables are always reloaded fresh from the DB at the start of each step, so changes from one step are visible to the next even within the same invocation.

---

## Worked Example

**Workflow start:**
```js
await apiSend("/workflows/1/start", "POST", { contactId: 456 });
// Variables: { contactId: 456 }
```

**Step 1 — lookup_contact:**
```json
{
  "function_name": "lookup_contact",
  "params": { "contact_id": "{{contactId}}" },
  "set_vars": {
    "contact_fname": "{{this.output.contact_fname}}",
    "contact_email": "{{this.output.contact_email}}"
  }
}
// Variables after: { contactId: 456, contact_fname: "Fred", contact_email: "fred@example.com" }
```

**Step 2 — send_email:**
```json
{
  "function_name": "send_email",
  "params": {
    "from": "stuart@4lsg.com",
    "to": "{{contact_email}}",
    "subject": "Hello {{contact_fname}}",
    "text": "Hi {{contact_fname}}, this is your confirmation. Execution: {{env.executionId}}"
  }
}
// Resolved before call:
//   to      → "fred@example.com"
//   subject → "Hello Fred"
//   text    → "Hi Fred, this is your confirmation. Execution: 42"
```
