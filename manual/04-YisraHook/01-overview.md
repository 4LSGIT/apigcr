# YisraHook — Complete Design Document

## One-line Definition

YisraHook is a configurable webhook receiver that normalizes, filters, transforms, and routes incoming events to multiple targets — replacing per-integration Express routes with per-hook configuration.

---

## 1. ARCHITECTURE

### Position in YisraCase

YisraHook is a module within the existing Express app — not a separate service. It adds its own route file, service files, database tables, and management UI. It uses the existing `scheduled_jobs` infrastructure for delivery retries only.

### File Structure

```
services/hookService.js        — core engine: receive, filter, transform, deliver
services/hookTransforms.js     — transform function library (pure functions)
services/hookMapper.js         — mapper engine (path resolution, template expressions)
services/hookFilter.js         — condition evaluator (recursive AND/OR)
routes/api.hooks.js            — POST /hooks/:slug (receiver) + CRUD for management UI
public/hookManager.html        — config UI
```

### Core Principle

Logic is configuration, not code. Each new integration is a database row, not a new route. The only route is `POST /hooks/:slug` (and management CRUD endpoints behind JWT).

---

## 2. PIPELINE

```
External event hits POST /hooks/:slug
  → Look up hook by slug (404 if not found or inactive)
  → Authenticate request (per-hook config: none / api_key / hmac)
  → Normalize into unified event shape
  → Insert hook_execution row (status: 'received')
  → Run hook-level filter
      → If false: mark 'filtered', return 200, done
  → Run hook-level transform
  → For each active target (ordered by position):
      → Evaluate target conditions (skip if false)
      → Run target-level transform (if any, refines hook output)
      → Build delivery request (URL, method, headers, auth injection, body)
      → Attempt delivery synchronously
          → Success: log to hook_delivery_logs
          → Failure: log failure, queue retry job in scheduled_jobs
  → Update execution status based on results
  → Return 200 (always — webhook senders just need acknowledgment)
```

### Execution Model

- **Processing (filter + transform):** Always synchronous. Pure in-memory computation.
- **Delivery:** Synchronous on first attempt. Failed deliveries queue a `hook_retry` job in `scheduled_jobs` with existing retry/backoff logic.
- **Response:** Always 200. The webhook sender's retry logic should not be triggered by our downstream failures.

---

## 3. UNIFIED EVENT SHAPE

All inputs are normalized before processing:

```json
{
  "body": {},
  "headers": {},
  "query": {},
  "method": "POST",
  "meta": {
    "source": "http",
    "received_at": "2026-04-14T12:00:00.000Z",
    "slug": "calendly-new-lead",
    "remote_ip": "..."
  }
}
```

For email-sourced events (arriving via Apps Script or other adapter), `meta.source` is `"email"` and the body contains the parsed email fields. The hook itself is agnostic to source — it processes the same unified shape regardless.

---

## 4. AUTHENTICATION (Inbound)

Per-hook `auth_type` and `auth_config`:

### None
No authentication. Open endpoint. Use for sources that don't support signing.

### API Key
```json
{ "auth_type": "api_key", "auth_config": { "key": "abc123", "header": "x-hook-key" } }
```
Checks that the specified header matches the stored key.

### HMAC
```json
{ "auth_type": "hmac", "auth_config": { "secret": "...", "header": "x-signature", "algorithm": "sha256" } }
```
Verifies HMAC signature of the raw request body. Used by services like GitHub, Stripe, Calendly.

---

## 5. FILTER ENGINE

Two modes, selected per hook via `filter_mode`:

### Mode: `none`
All events pass through. No filtering.

### Mode: `conditions`
Declarative AND/OR condition groups:

```json
{
  "operator": "and",
  "conditions": [
    { "path": "body.event", "op": "equals", "value": "invitee.created" },
    {
      "operator": "or",
      "conditions": [
        { "path": "body.payload.status", "op": "equals", "value": "active" },
        { "path": "body.payload.status", "op": "equals", "value": "pending" }
      ]
    }
  ]
}
```

Condition operators:
- Equality: `equals`, `not_equals`
- String: `contains`, `not_contains`, `starts_with`, `ends_with`, `matches` (regex)
- Numeric: `gt`, `gte`, `lt`, `lte`
- Existence: `exists`, `not_exists`
- Set: `in` (value is array), `not_in`

Groups nest arbitrarily. The evaluator is a recursive function.

### Mode: `code`
Advanced escape hatch. User-written JavaScript:

```js
return input.body.event === 'invitee.created' && input.body.payload.guests.length > 0;
```

Executed via `new Function('input', code)` in a try/catch. Trusted-user context only.

### Target-Level Conditions
Each target can also have its own `conditions` field (same structure as hook-level filter). If null/absent, the target always fires when the hook-level filter passes. If present, evaluated against the **hook-level transform output** (not raw input).

---

## 6. TRANSFORM ENGINE

Two modes, selected per hook (and optionally per target) via `transform_mode`:

### Mode: `passthrough`
No transformation. The unified event input passes directly to delivery.

### Mode: `mapper`
Declarative mapping rules. Each rule has one of three source modes:

#### Source: `from` (single path)
```json
{ "from": "body.payload.email", "to": "contact_email", "transforms": ["lowercase", "trim"] }
```
Resolves a dot-notation path from the input, applies transforms in order.

#### Source: `template` (multi-path composition)
```json
{ "template": "{{body.payload.f_name|capitalize}} {{body.payload.l_name|uppercase}}", "to": "contact_name" }
```
Resolves `{{path}}` or `{{path|transform|transform}}` tokens. Each token is resolved and transformed independently. The full string is the output value.

#### Source: `value` (static literal)
```json
{ "to": "source", "value": "calendly" }
```
Injects a hardcoded value. No resolution needed.

### Nested Output
The `to` field supports dot notation for building nested objects:
```json
{ "from": "body.payload.name", "to": "contact.name" }
{ "from": "body.payload.email", "to": "contact.email" }
```
Produces: `{ "contact": { "name": "...", "email": "..." } }`

Numeric path segments create arrays: `"to": "phones.0"` → `{ "phones": ["..."] }`

### Mode: `code`
Advanced escape hatch:
```js
const p = input.body.payload;
return {
  contact_name: p.name,
  contact_email: p.email,
  appt_date: p.start_time,
  source: 'calendly'
};
```

### Target-Level Transforms
Each target can have its own `transform_mode` / `transform_config`. If `passthrough`, it receives the hook-level transform output as-is. If mapper/code, it further refines the hook output for that specific target's needs.

Pipeline: `raw input → hook transform → target transform → delivery body`

---

## 7. TRANSFORM FUNCTION LIBRARY

All transforms are pure functions: `(value, ...args) => newValue`

### Text
| Function | Description | Example |
|----------|-------------|---------|
| `lowercase` | Lowercase entire string | `"HELLO"` → `"hello"` |
| `uppercase` | Uppercase entire string | `"hello"` → `"HELLO"` |
| `capitalize` | Capitalize each word | `"john doe"` → `"John Doe"` |
| `cap_first` | Capitalize first word only | `"hello world"` → `"Hello world"` |
| `trim` | Trim whitespace | `" hi "` → `"hi"` |
| `slug` | Kebab-case | `"Hello World"` → `"hello-world"` |

### Extraction
| Function | Description | Example |
|----------|-------------|---------|
| `between:<start>:<end>` | Substring between delimiters | `"Name: John; Age: 30"` with `between:Name\\::;` → `" John"` |
| `before:<delimiter>` | Everything before first occurrence | `"user@email.com"` with `before:@` → `"user"` |
| `after:<delimiter>` | Everything after first occurrence | `"user@email.com"` with `after:@` → `"email.com"` |
| `regex:<pattern>` | First capture group match | `"ID-12345-X"` with `regex:ID-(\\d+)` → `"12345"` |

### Manipulation
| Function | Description | Example |
|----------|-------------|---------|
| `split:<delim>:<index>` | Split and take nth element | `"a,b,c"` with `split:,:1` → `"b"` |
| `replace:<find>:<replace>` | String replacement | |
| `prefix:<str>` | Prepend string | |
| `suffix:<str>` | Append string | |
| `join:<delimiter>` | Join array to string | `["a","b"]` with `join:, ` → `"a, b"` |
| `at:<index>` | Array index access | `["a","b","c"]` with `at:1` → `"b"` |

### Formatting
| Function | Description | Example |
|----------|-------------|---------|
| `digits_only` | Strip non-digits | `"(248) 555-1234"` → `"2485551234"` |
| `phone` | Format as phone | `"2485551234"` → `"(248) 555-1234"` |
| `date:<format>` | Reformat date string | Uses luxon format tokens |
| `tz:<zone>` | Timezone conversion | `tz:America/Detroit` (use before `date`) |
| `number` | Parse to number | `"42.5"` → `42.5` |
| `boolean` | Parse to boolean | `"true"` → `true` |

### Fallbacks
| Function | Description | Example |
|----------|-------------|---------|
| `default:<value>` | Use if null/undefined/empty | `null` with `default:unknown` → `"unknown"` |
| `required` | Fail transform if missing | Throws error, marks execution failed |

---

## 8. CREDENTIAL STORE & AUTH INJECTION (Outbound)

### credentials Table
Shared credential store for delivery target authentication. Designed to grow into a full auth manager.

```
id, name, type, config (JSON), allowed_urls (JSON array), created_at, updated_at
```

### Credential Types

#### `internal`
Auto-injects `x-api-key` header with `process.env.INTERNAL_API_KEY`. No config needed — the system knows the key. `allowed_urls` defaults to the app's own domain.

#### `bearer`
```json
{ "config": { "token": "..." }, "allowed_urls": ["https://api.calendly.com/*"] }
```
Injects `Authorization: Bearer <token>` header.

#### `api_key`
```json
{ "config": { "key": "...", "header": "x-api-key" }, "allowed_urls": ["https://api.example.com/*"] }
```
Injects the key into the specified header.

#### `basic`
```json
{ "config": { "username": "...", "password": "..." }, "allowed_urls": ["https://api.example.com/*"] }
```
Injects `Authorization: Basic <base64>` header.

### URL Scoping
The delivery layer checks that the target URL matches at least one pattern in `allowed_urls` before injecting credentials. Prevents credential leakage to unintended destinations. Patterns support `*` wildcard for path matching.

### Future: OAuth
The `type` enum can expand to include `'oauth'` with refresh token logic. The hook system doesn't change — it just looks up the credential and gets a valid token.

---

## 9. DELIVERY

### Target Configuration

Each target defines:
- `method`: GET / POST / PUT / PATCH / DELETE
- `url`: The delivery endpoint
- `headers`: Additional static headers (JSON object)
- `credential_id`: FK to credentials table (nullable)
- `body_mode`: How to construct the request body
- `conditions`: Per-target filter (nullable, same evaluator as hook filter)
- `transform_mode` / `transform_config`: Per-target transform (optional refinement)

### Body Modes

#### `transform_output`
Sends the full transform output (or target-level transform output if configured) as JSON body.

#### `template`
Uses a template string with `{{path|transforms}}` syntax, resolved against the transform output:
```json
{ "text": "New lead: {{contact_name}} from {{source|uppercase}}" }
```
Same template engine as the mapper — one implementation, two uses.

### Retry on Failure
If delivery returns a non-2xx status or times out:
1. Log the failure in `hook_delivery_logs`
2. Queue a `hook_retry` job in `scheduled_jobs` with `{ execution_id, target_id }`
3. Uses existing retry/backoff logic from `scheduled_jobs`

---

## 10. DATABASE SCHEMA

```sql
-- Shared credential store
CREATE TABLE credentials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type ENUM('internal','bearer','api_key','basic') DEFAULT 'internal',
  config JSON,
  allowed_urls JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Hook definitions
CREATE TABLE hooks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  auth_type ENUM('none','api_key','hmac') DEFAULT 'none',
  auth_config JSON,
  filter_mode ENUM('none','conditions','code') DEFAULT 'none',
  filter_config JSON,
  transform_mode ENUM('passthrough','mapper','code') DEFAULT 'passthrough',
  transform_config JSON,
  active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Delivery targets (multiple per hook)
CREATE TABLE hook_targets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  hook_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  position INT DEFAULT 0,
  method ENUM('GET','POST','PUT','PATCH','DELETE') DEFAULT 'POST',
  url VARCHAR(2048) NOT NULL,
  headers JSON,
  credential_id INT,
  body_mode ENUM('transform_output','template') DEFAULT 'transform_output',
  body_template TEXT,
  conditions JSON,
  transform_mode ENUM('passthrough','mapper','code') DEFAULT 'passthrough',
  transform_config JSON,
  active TINYINT(1) DEFAULT 1,
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL
);

-- Execution log
CREATE TABLE hook_executions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  hook_id INT NOT NULL,
  slug VARCHAR(100),
  raw_input JSON,
  filter_passed TINYINT(1),
  transform_output JSON,
  status ENUM('received','filtered','processing','delivered','partial','failed') DEFAULT 'received',
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hook_created (hook_id, created_at),
  INDEX idx_status (status)
);

-- Per-target delivery results
CREATE TABLE hook_delivery_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  execution_id INT NOT NULL,
  target_id INT NOT NULL,
  request_url VARCHAR(2048),
  request_method VARCHAR(10),
  request_body JSON,
  response_status INT,
  response_body TEXT,
  status ENUM('success','failed') DEFAULT 'failed',
  error TEXT,
  attempts INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (execution_id) REFERENCES hook_executions(id) ON DELETE CASCADE,
  INDEX idx_exec (execution_id)
);
```

---

## 11. EMAIL ADAPTER

### Current State
A Google Apps Script watches a Gmail label and POSTs parsed email data to `/logEmail`. This is proven infrastructure.

### YisraHook Integration
A separate email alias (e.g., `hooks@4lsg.com` or `yisrahook@4lsg.com`) receives emails intended for hook processing. The Apps Script (or a small addition to the existing one) watches this alias and POSTs to `/hooks/:slug`.

**Routing via subaddressing:** Gmail supports `+` subaddressing natively.
- `hooks+calendly@4lsg.com` → `/hooks/calendly-email`
- `hooks+leads@4lsg.com` → `/hooks/lead-intake`

The script extracts the slug from the `+` portion:
```js
if (payload.to.startsWith('hooks+')) {
  var slug = payload.to.split('+')[1].split('@')[0];
  sendToWebhook('https://your-domain/hooks/' + slug, payload);
}
```

### Payload Shape (Email)
```json
{
  "from": "sender@example.com",
  "from_raw": "Sender Name <sender@example.com>",
  "to": "hooks+leads@4lsg.com",
  "to_raw": "hooks+leads@4lsg.com",
  "subject": "New Lead: John Doe",
  "date": "2026-04-14T12:00:00.000Z",
  "body_plain": "...",
  "body_html": "...",
  "attachments": [{ "name": "file.pdf", "type": "application/pdf", "size": 12345 }],
  "message_id": "...",
  "thread_id": "...",
  "thread_count": 1,
  "labels": ["hooks"]
}
```

### Existing email logging stays untouched
The existing `/logEmail` endpoint and its Apps Script continue handling firm-wide email logging. YisraHook email is a separate, opt-in path.

### Provider Independence
The hook endpoint receives a normalized payload. If the firm switches from Gmail to another provider:
- If the new provider offers inbound parse webhooks: point directly at `/hooks/:slug`, update the hook's mapper to match the new field names
- If the new provider uses IMAP: build an adapter (future) or use Pabbly as a bridge
- The hooks, transforms, and targets don't change — only the adapter layer

---

## 12. TESTING

### Dry Run (UI)
Endpoint: `POST /api/hooks/:id/test` (JWT-protected, by internal ID)

Accepts sample JSON input. Runs the full pipeline without delivery. Returns:
```json
{
  "filter": { "passed": true, "mode": "conditions" },
  "transform": { "output": { "contact_name": "John Doe", "..." }, "mode": "mapper" },
  "targets": [
    {
      "id": 1, "name": "Create Contact",
      "conditions_passed": true,
      "transform_output": { "..." },
      "would_send": { "method": "POST", "url": "/api/contacts", "headers": {}, "body": {} }
    },
    {
      "id": 2, "name": "Slack Notification",
      "conditions_passed": false,
      "skip_reason": "condition not met"
    }
  ]
}
```

### Live Test
The UI's test panel can also fire a real POST to `/hooks/:slug` with the sample data. The execution appears in the logs tab with real delivery results.

### Sample Data Sources
- Paste raw JSON manually
- Load from a previous execution in `hook_executions`
- Some webhook providers publish sample payloads in their docs

---

## 13. MANAGEMENT UI (hookManager.html)

### Layout
Left sidebar: list of hooks (name, slug, active status)
Main area: tabbed editor for selected hook

### Tabs
1. **General** — name, slug, description, active toggle
2. **Authentication** — auth_type selector, config fields
3. **Filter** — mode selector (none/conditions/code), condition builder or code editor
4. **Transform** — mode selector (passthrough/mapper/code), mapping rule builder or code editor
5. **Targets** — list of targets with inline editing, each expandable to show conditions/transform/delivery config
6. **Logs** — execution history with expandable delivery details
7. **Test** — sample input textarea, dry run / live test buttons, result preview

---

## 14. MANAGEMENT API ROUTES

All behind `jwtOrApiKey` middleware.

```
GET    /api/hooks                    — list all hooks
GET    /api/hooks/:id                — get hook with targets
POST   /api/hooks                    — create hook
PUT    /api/hooks/:id                — update hook
DELETE /api/hooks/:id                — delete hook (cascades targets)

GET    /api/hooks/:id/targets        — list targets for hook
POST   /api/hooks/:id/targets        — create target
PUT    /api/hooks/targets/:id        — update target
DELETE /api/hooks/targets/:id        — delete target

POST   /api/hooks/:id/test           — dry run test

GET    /api/hooks/:id/executions     — execution log (paginated)
GET    /api/hooks/executions/:id     — single execution with delivery logs

GET    /api/credentials              — list credentials (config values masked)
POST   /api/credentials              — create credential
PUT    /api/credentials/:id          — update credential
DELETE /api/credentials/:id          — delete credential
```

---

## 15. EXAMPLE: CALENDLY LEAD INTAKE

### Hook
```
slug: calendly-new-lead
auth_type: hmac
auth_config: { secret: "calendly-signing-secret", header: "Calendly-Webhook-Signature", algorithm: "sha256" }
filter_mode: conditions
filter_config: { operator: "and", conditions: [{ path: "body.event", op: "equals", value: "invitee.created" }] }
transform_mode: mapper
transform_config: [
  { "from": "body.payload.name", "to": "contact_name", "transforms": ["capitalize", "trim"] },
  { "from": "body.payload.email", "to": "contact_email", "transforms": ["lowercase", "trim"] },
  { "from": "body.payload.questions_and_answers", "to": "contact_phone", "transforms": ["at:0", "default:"] },
  { "from": "body.payload.event.start_time", "to": "appt_date", "transforms": ["tz:America/Detroit", "date:yyyy-MM-dd HH:mm:ss"] },
  { "to": "source", "value": "calendly" }
]
```

### Target: Create Contact
```
name: Create Contact
method: POST
url: https://your-domain/api/contacts
credential_id: 1 (internal)
body_mode: transform_output
```

### Target: Slack Notification
```
name: Slack Alert
method: POST
url: https://hooks.slack.com/services/...
body_mode: template
body_template: { "text": "New Calendly lead: {{contact_name}} ({{contact_email}})" }
```

---

## 16. LOG RETENTION (Future)

`hook_executions` and `hook_delivery_logs` will grow. Future retention strategy:
- Archive to a `hook_executions_archive` / `hook_delivery_logs_archive` table after N days
- Or physical backup + purge via scheduled job
- Not urgent at current scale but needs addressing as volume grows
- Applies to all YisraCase log tables (log, email_log, job_results, etc.) — should be a unified retention strategy

---

## 17. BUILD ORDER

Bottom-up, matching established YisraCase patterns:

1. **Schema** — migrations for all 5 tables
2. **hookTransforms.js** — pure transform function library, individually testable
3. **hookMapper.js** — path resolution, template expressions, nested output builder
4. **hookFilter.js** — recursive condition evaluator
5. **hookService.js** — core engine wiring filter → transform → deliver
6. **routes/api.hooks.js** — receiver endpoint + management CRUD
7. **hookManager.html** — config UI
8. **Apps Script update** — add hooks@4lsg.com routing