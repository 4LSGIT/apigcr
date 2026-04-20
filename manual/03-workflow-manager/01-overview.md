# YisraHook — Design & Implementation Document
# v1.2.1 — Capture Mode (April 2026)

YisraHook is a configurable webhook receiver that normalizes, filters, transforms, and routes incoming events to multiple targets — replacing per-integration Express routes with per-hook configuration.

**Version history:**
- **v1.0** — initial release (HTTP-only targets, auth/filter/transform pipeline, retry queue)
- **v1.2** — internal automation targets: workflow, sequence, internal_function (HTTP targets unchanged)
- **v1.2.1** — capture mode for one-shot payload snapshotting; ID-only sequence target config (direct enrollment without cascade)

HTTP targets behave identically across all versions — migrations are additive.

---

## 1. ARCHITECTURE

### Position in YisraCase

YisraHook is a module within the existing Express app — not a separate service. It adds its own route file, service files, database tables, and management UI. It uses the existing `scheduled_jobs` infrastructure for delivery retries only.

### File Structure

```
services/hookService.js          — core engine: receive, filter, transform, deliver
services/hookTransforms.js       — transform function library (pure functions)
services/hookMapper.js           — mapper engine (path resolution, template expressions)
services/hookFilter.js           — condition evaluator (recursive AND/OR)
routes/api.hooks.js              — POST /hooks/:slug (receiver) + CRUD for management UI
public/automationManager.html    — primary config UI (Hooks tab alongside Workflows, Sequences, Jobs)
public/yisraHook.html            — standalone hook manager UI (parallel, same backend)
migrations/yisrahook_schema.sql            — initial 5 tables + scheduled_jobs enum
migrations/2026XX_hook_internal_targets.sql — v1.2: target_type + config columns
migrations/2026XX_hook_capture_mode.sql     — v1.2.1: capture_mode + captured_sample + captured_at
```

There are two UIs driving the same `/api/hooks/*` backend. The integrated tab inside `automationManager.html` is the primary path — hooks were merged into the automation manager alongside workflows and sequences so all automation configuration lives in one place. `yisraHook.html` remains as a standalone UI.

### Core Principle

Logic is configuration, not code. Each new integration is a database row, not a new route. The only route is `POST /hooks/:slug` (and management CRUD endpoints behind JWT).

---

## 2. PIPELINE

```
External event hits POST /hooks/:slug
  → Look up hook by slug (404 if not found or inactive)
  → Authenticate request (per-hook config: none / api_key / hmac)
  → Normalize into unified event shape
  → Return 200 immediately (async from here; see Capture Mode for exception)
  → Insert hook_execution row (status: 'received')
  → Run hook-level filter
      → If false: mark 'filtered', done
  → Run hook-level transform
  → For each active target (ordered by position):
      → Evaluate target conditions (skip if false)
      → Run target-level transform (if any, refines hook output)
      → Dispatch by target_type:
          • http              → fetch() with injected auth
          • workflow          → INSERT workflow_executions + fire-and-forget advance
          • sequence          → sequenceEngine.enrollContact() or enrollContactByTemplateId()
          • internal_function → internalFunctions[name](params, db)
      → Log delivery (HTTP and internal targets share hook_delivery_logs)
      → On failure: queue hook_retry job in scheduled_jobs
  → Update execution status based on results
```

### Execution Model

- **Processing (filter + transform):** Synchronous. Pure in-memory computation.
- **Delivery:** Synchronous on first attempt. Failed deliveries queue a `hook_retry` job in `scheduled_jobs` with existing retry/backoff logic (3 max attempts, 120s backoff).
- **Response:** Always 200 immediately — except in capture mode, which awaits the pipeline so it can respond with `{status: "captured", execution_id}`.
- **Payload guard:** Raw input truncated at 512KB before DB storage.
- **Rate limit:** 120 req/min per slug+IP on the receiver endpoint.

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

---

## 4. AUTHENTICATION (Inbound)

Per-hook `auth_type` and `auth_config`:

| Type | Config | Behavior |
|------|--------|----------|
| `none` | — | Open endpoint |
| `api_key` | `{ key, header }` | Checks header matches stored key |
| `hmac` | `{ secret, header, algorithm }` | Verifies HMAC signature of raw body. Strips `sha256=` / `v1=` prefixes. Constant-time comparison. |

HMAC requires `rawBody` middleware in server.js (captures raw bytes before JSON parsing).

---

## 5. FILTER ENGINE

Two modes via `filter_mode`:

### `none` — all events pass through

### `conditions` — declarative AND/OR groups
```json
{
  "operator": "and",
  "conditions": [
    { "path": "body.event", "op": "equals", "value": "invitee.created" },
    { "operator": "or", "conditions": [
      { "path": "body.payload.status", "op": "equals", "value": "active" },
      { "path": "body.payload.status", "op": "equals", "value": "pending" }
    ]}
  ]
}
```

Operators: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `exists`, `not_exists`, `in`, `not_in`, `matches` (regex).

### `code` — advanced escape hatch
```js
return input.body.event === 'invitee.created';
```

### Target-level conditions
Each target can have its own `conditions` field (same evaluator). Evaluated against the **hook-level transform output**, not raw input. Applies equally to HTTP and internal targets.

---

## 6. TRANSFORM ENGINE

Two modes via `transform_mode`:

### `passthrough` — no transformation

### `mapper` — declarative rules

Three source modes per rule (mutually exclusive):

**`from`** — single dot-path with transforms:
```json
{ "from": "body.payload.email", "to": "contact_email", "transforms": ["lowercase", "trim"] }
```

**`template`** — multi-path composition with inline pipes:
```json
{ "template": "{{body.payload.f_name|trim|capitalize}} {{body.payload.l_name|trim|uppercase}}", "to": "contact_name" }
```

**`value`** — static literal:
```json
{ "to": "source", "value": "calendly" }
```

**Nested output:** `to` supports dot notation — `"to": "contact.name"` produces `{ contact: { name: "..." } }`.

**Important:** Template transforms are explicit. `{{path|uppercase}}` applies only `uppercase`. If the source has leading spaces, add `|trim` explicitly — transforms are never implicit.

### `code` — advanced escape hatch
```js
const p = input.body.payload;
return { contact_name: p.name, contact_email: p.email };
```

### Target-level transforms
Each target can override with its own `transform_mode`/`transform_config`, refining the hook-level output for that specific target. Applies equally to HTTP and internal targets.

---

## 7. TRANSFORM FUNCTION LIBRARY

All transforms are pure functions: `(value, ...args) => newValue`

**Text:** `lowercase`, `uppercase`, `capitalize` (each word), `cap_first`, `trim`, `slug`

**Extraction:** `between:<start>:<end>`, `before:<delimiter>`, `after:<delimiter>`, `regex:<pattern>` (first capture group)

**Manipulation:** `split:<delim>:<index>`, `replace:<find>:<replace>`, `prefix:<str>`, `suffix:<str>`, `join:<delimiter>`, `at:<index>`

**Formatting:** `digits_only`, `phone`, `date:<format>` (luxon), `tz:<zone>`, `number`, `boolean`

**Fallbacks:** `default:<value>`, `required` (throws on null/empty)

Colon args can be escaped with backslash: `between:Name\\::;`

---

## 8. CREDENTIAL STORE & AUTH INJECTION (Outbound HTTP only)

Credentials apply only to HTTP targets. Internal targets run in-process and authenticate via the Node.js runtime itself.

### credentials table
Shared credential store. Designed to grow into a full auth manager.

| Type | Behavior |
|------|----------|
| `internal` | Auto-injects `x-api-key` with `process.env.INTERNAL_API_KEY`. No config needed. |
| `bearer` | Injects `Authorization: Bearer <token>` |
| `api_key` | Injects key into specified header |
| `basic` | Injects `Authorization: Basic <base64>` |

### URL Scoping
`allowed_urls` (JSON array) restricts which target URLs a credential can be injected into. Supports `*` wildcard. The `internal` type skips URL checking (always allowed for own server).

---

## 9. DELIVERY

### Target Types

Each target has a `target_type` that determines how it's delivered. The default is `http` — all existing targets created before v1.2 behave exactly as before.

| Type | Config fields | Engine | Sync? |
|------|---------------|--------|-------|
| `http` | `method`, `url`, `headers`, `credential_id`, `body_mode`, `body_template` | `fetch()` | Sync on first attempt |
| `workflow` | `config.workflow_id` | `workflow_engine.advanceWorkflow()` | Async (fire-and-forget after INSERT) |
| `sequence` | `config.template_type` **OR** `config.template_id`, `config.contact_id_field`, `config.trigger_data_fields`, `config.appt_type_filter`, `config.appt_with_filter` | `sequenceEngine.enrollContact()` / `enrollContactByTemplateId()` | Sync |
| `internal_function` | `config.function_name`, `config.params_mapping` | `internalFunctions[name]()` | Sync |

All four types share:
- The hook-level filter and transform pipeline (upstream)
- Target-level conditions and transform (per-target)
- `hook_delivery_logs` entries (synthetic URLs for internal targets)
- The `hook_retry` job queue on failure (see retry notes below)

**Dot-path config resolution.** `config.contact_id_field` and each entry in `config.trigger_data_fields` (on sequence targets), plus every source in `config.params_mapping` (on internal_function targets), are resolved via `getByPath` — so `"body.contactId"` works out of the box on a passthrough hook without a mapper. See Cookbook §5.28 for the pattern.

### HTTP Targets

Each HTTP target: `method`, `url`, `headers` (JSON), `credential_id` (FK), `body_mode`, `conditions`, `transform_mode`/`transform_config`.

**Body Modes**
- `transform_output` — sends full transform output as JSON
- `template` — resolves `{{path|transforms}}` against transform output: `{"text": "New lead: {{contact_name}}"}`

**`body_template` is only meaningful when `body_mode === 'template'`.** The column is persisted regardless of mode (so flipping modes doesn't destroy the user's draft), but the value is ignored on delivery in `transform_output` mode. The target editor (Slice 4.4) hides the textarea except in template mode and shows a placeholder example (`{"text": "New lead: {{contact_name}}"}`) when it's empty.

### Workflow Targets

Starts a workflow execution. The full transform output becomes both the `init_data` and the initial `variables`.

**Config:**
```json
{ "workflow_id": 4 }
```

**What happens on delivery:**
1. `INSERT INTO workflow_executions (workflow_id, contact_id, status='active', init_data, variables, current_step_number=1)`
2. `advanceWorkflow(executionId, db)` is called without `await` — delivery returns success as soon as the execution row exists
3. Any background failure during advance is logged but doesn't retry the hook delivery (the execution row itself will be marked `failed` by `markExecutionCompleted`)

**Contact-tying (Slice 4.3 Part B).** If the target workflow has `workflows.default_contact_id_from` set, `deliverWorkflow` reads that init_data key on the transform output and stamps `workflow_executions.contact_id`. Invalid values (non-integer, not positive) fall through to NULL silently. Explicit override is **not** supported on the hook path — shape the payload via the hook's mapper if the template expects a different key name. See Cookbook §3.12 for the full contact-tying pattern.

**Delivery log shape:**
- `request_url` = `internal://workflow/{workflow_id}/execution/{execution_id}`
- `request_method` = `INTERNAL`
- `request_body` = JSON of `init_data`
- `response_status` = `200` on successful INSERT, `500` on failure
- `response_body` = `{ "executionId": N, "workflowId": M, "contactId": N|null, "status": "started" }`

### Sequence Targets

Enrolls a contact in a sequence. Two mutually exclusive config modes:

**Cascade mode (by type):**
```json
{
  "template_type": "no_show",
  "contact_id_field": "contact_id",
  "trigger_data_fields": ["appt_id", "appt_time"],
  "appt_type_filter": "Strategy Session",
  "appt_with_filter": 2
}
```
Calls `sequenceEngine.enrollContact(db, contactId, templateType, triggerData, { appt_type, appt_with })` with the cascading match (see [03-sequences.md](../03-workflow-manager/03-sequences.md#cascading-template-match)).

**Direct mode (by ID):**
```json
{
  "template_id": 42,
  "contact_id_field": "contact_id",
  "trigger_data_fields": ["appt_id", "appt_time"]
}
```
Calls `sequenceEngine.enrollContactByTemplateId(db, contactId, templateId, triggerData)`. No cascade, no filters — target the exact template by ID. `appt_type_filter` / `appt_with_filter` are **rejected** in direct mode (validation returns 400 at save time).

**Validation at save (target CRUD):** Exactly one of `config.template_type` or `config.template_id` must be present. Both-set → 400. Neither-set → 400 on create. `template_id` must be a positive integer. Cascade filters alongside `template_id` → 400.

**Behavior (either mode):**
1. Reads `contact_id` from the field named by `contact_id_field` (default: `"contact_id"`), dot-path aware
2. Builds `trigger_data` by picking fields listed in `trigger_data_fields` (dot-path aware; nested paths get flattened to their last segment key — `body.appt_id` becomes `triggerData.appt_id`)
3. Calls the appropriate engine function

**Delivery log shape:**
- `request_url` = `internal://sequence/{template_type}` (cascade) or `internal://sequence/id/{template_id}` (direct)
- `request_method` = `INTERNAL`
- `request_body` = the full call payload (includes `contact_id`, `template_type` or `template_id`, `trigger_data`, and for cascade mode `appt_type` + `appt_with`)
- `response_status` = `200` / `500`
- `response_body` = `{ enrollmentId, templateName, totalSteps, firstJobScheduledAt }`

### Internal Function Targets

Calls a function from `lib/internal_functions.js` directly — the same registry used by workflows and sequences.

**Config:**
```json
{
  "function_name": "create_log",
  "params_mapping": {
    "contact_id": "contact_id",
    "log_type": "'SMS'",
    "subject": "'New lead received'",
    "content": "lead_summary"
  }
}
```

**`params_mapping` convention:**

| Source value | Meaning |
|--------------|---------|
| `"contact_id"` | Flat lookup — reads `transformOutput.contact_id` |
| `"contact.id"` | Dot-path lookup — reads `transformOutput.contact.id` |
| `"contact"` | Whole object — reads `transformOutput.contact` (pass nested object to function) |
| `"'SMS'"` | Literal string — quotes stripped, becomes `"SMS"` |
| `42`, `true`, `null` | Non-string value — passed through as-is |

Dot-paths use the same resolver as the hook-level transform (`from` and `{{template}}` expressions), so the whole pipeline is consistent. Missing segments resolve to `undefined` — there's no error on bad paths.

Array-index syntax (`"items[0].name"`) is NOT supported. If you need to pull array elements, flatten them via a transform rule or code transform first.

**Delivery log shape:**
- `request_url` = `internal://function/{function_name}`
- `request_method` = `INTERNAL`
- `request_body` = resolved params
- `response_status` = `200` / `500`
- `response_body` = JSON of function return value (truncated to 10KB)

### Retry on Failure

All target types queue a `hook_retry` job on failure (3 max attempts, 120s backoff). The retry calls `deliverToTarget(target, transformOutput, db)` — the same code path as the initial attempt.

**Idempotency notes by target type:**

- **`http`** — Idempotency depends on the endpoint. Same as v1.0.
- **`workflow`** — INSERT failures retry cleanly. Async advance failures do NOT trigger hook retries (delivery already returned success); the execution row is marked `failed` instead.
- **`sequence`** — `enrollContact` / `enrollContactByTemplateId` throw "already enrolled" on duplicates. If the first attempt actually enrolled but the log write failed, the retry will fail cleanly and hit max_attempts.
- **`internal_function`** — Functions with side effects (`create_task`, `send_sms`, `create_log`) are NOT inherently idempotent. Retries will invoke the function again. Design internal-function hooks to be safe-to-retry, or accept the small risk of duplicate actions on transient failures.

### Capture Mode (v1.2.1)

Capture mode is a one-shot intercept for snapshotting a real payload so you can iterate on filter/transform/targets against its actual shape — instead of hand-constructing sample JSON in the Test tab.

**Enabling.** Click **Capture next event** in the hook editor's General tab. The mode flips from `off` to `capturing` and the button pulses while waiting. The receiver-side state lives in three columns on `hooks`: `capture_mode` (enum `off|capturing`), `captured_sample` (JSON), `captured_at` (datetime).

**What happens on the next event.** The receiver stores the unified event (`{body, headers, query, method, meta}`) in `hooks.captured_sample`, flips `capture_mode` back to `off` atomically, and **halts the pipeline** — no filter evaluation, no transform, no target delivery. The sender receives `200 {status: "captured", execution_id}`. A `hook_executions` row is written with status `captured`.

**No TTL.** Capture mode stays armed indefinitely. If nothing arrives, the operator cancels with the same button (now labeled `Capturing…`).

**Sample preservation.** Arming or canceling capture does *not* clear `captured_sample`. Only a subsequent successful capture replaces it. The previous sample stays available under the button as `Captured sample from <time>` with **View** and **Use in Test tab** links.

**Race safety.** The mode flip uses a guarded `UPDATE … WHERE capture_mode = 'capturing'`. If two events arrive inside the same capture window, exactly one wins; the other falls through to the normal pipeline (filter/transform/deliver). There is no duplicate capture.

**Interaction with dry-run.** The Test tab's Dry Run path never triggers capture — the intercept is gated on `!dryRun`.

**Visibility.** Captured executions show up in the Logs tab with `status = captured`. They have no delivery logs (by design — the pipeline halted).

**Receiver response shapes.** The receiver's external response has two forms:
- Normal: `200 {"status": "received", "slug": "..."}`
- Capture hit: `200 {"status": "captured", "execution_id": N}` — returned only to the single request that wins the capture; concurrent losers receive the normal shape.

See Cookbook §3.14 for the pattern and §5.27 for why capture mode inverts the respond-first rule.

---

## 10. DATABASE SCHEMA

### `credentials`
`id`, `name`, `type` (enum: internal/bearer/api_key/basic), `config` (JSON), `allowed_urls` (JSON), `created_at`, `updated_at`

### `hooks` (v1.2.1)
`id`, `slug` (unique), `name`, `description`, `auth_type`, `auth_config` (JSON), `filter_mode`, `filter_config` (JSON), `transform_mode`, `transform_config` (JSON), `active`, `version` (auto-increments on update), `last_modified_by` (FK → users), `capture_mode` (enum `off|capturing`, default `off`, **new in v1.2.1**), `captured_sample` (JSON, **new in v1.2.1**), `captured_at` (datetime, **new in v1.2.1**), `created_at`, `updated_at`

### `hook_targets` (v1.2)
`id`, `hook_id` (FK CASCADE), `target_type` (enum: http/workflow/sequence/internal_function, default 'http'), `name`, `position`, `method`, `url` (nullable in v1.2), `headers` (JSON), `credential_id` (FK SET NULL), `body_mode`, `body_template`, `config` (JSON, **new in v1.2**), `conditions` (JSON), `transform_mode`, `transform_config` (JSON), `active`

**v1.2 migration** (`migrations/2026XX_hook_internal_targets.sql`):
- Adds `target_type` ENUM column with default `'http'` (existing rows get `'http'`)
- Adds `config` JSON column
- Makes `url` nullable (internal targets don't have URLs)

**v1.2.1 migration** (`migrations/2026XX_hook_capture_mode.sql`):
- Adds `capture_mode`, `captured_sample`, `captured_at` on `hooks`
- Adds `captured` to the `hook_executions.status` enum

### `hook_executions`
`id` (BIGINT), `hook_id`, `slug`, `raw_input` (JSON, max 512KB), `filter_passed`, `transform_output` (JSON), `status` (enum: received/filtered/processing/delivered/partial/failed/**captured** in v1.2.1), `error`, `created_at`

### `hook_delivery_logs`
`id` (BIGINT), `execution_id` (FK CASCADE), `target_id`, `request_url` (varchar 2048 — fits `internal://...` URLs), `request_method` (`INTERNAL` for internal targets), `request_body` (JSON), `response_status`, `response_body`, `status` (enum: success/failed), `error`, `attempts`, `created_at`

### `scheduled_jobs` expansion
Enum expanded to include `hook_retry` (v1.0). No further changes in v1.2 or v1.2.1.

---

## 11. EMAIL ADAPTER

### Current approach
Google Apps Script watches a Gmail label and POSTs parsed email data. For YisraHook email ingestion, a separate alias (e.g., `hooks@4lsg.com`) routes via `+` subaddressing:

- `hooks+calendly@4lsg.com` → `/hooks/calendly-email`
- `hooks+leads@4lsg.com` → `/hooks/lead-intake`

### Provider independence
The hook endpoint is provider-agnostic. Switching from Gmail to another provider only requires changing the adapter (Apps Script → new script or inbound parse webhook). Hooks, transforms, and targets don't change.

---

## 12. MANAGEMENT API

All behind `jwtOrApiKey` except the receiver.

```
POST   /hooks/:slug                  — public receiver (per-hook auth)
                                       responses: {status:"received"} normally,
                                                  {status:"captured",execution_id} on capture hit

GET    /api/hooks                    — list all hooks
GET    /api/hooks/:id                — get hook with targets
POST   /api/hooks                    — create hook
PUT    /api/hooks/:id                — update hook (auto-increments version)
DELETE /api/hooks/:id                — delete hook (cascades targets)
POST   /api/hooks/:id/capture/start  — arm capture mode (next event snapshots + halts pipeline)
POST   /api/hooks/:id/capture/stop   — cancel capture mode (does not clear the sample)

POST   /api/hooks/:id/targets        — create target (accepts target_type + config; per-type validation)
PUT    /api/hooks/targets/:id        — update target (per-type validation, lenient on partial updates)
DELETE /api/hooks/targets/:id        — delete target

POST   /api/hooks/:id/test           — dry run test (no delivery; preview for all types; skips capture)
GET    /api/hooks/:id/executions     — execution log (paginated)
GET    /api/hooks/executions/:id     — single execution with delivery logs
GET    /api/hooks/meta               — transforms, operators, target_types (for UI)

GET    /api/credentials              — list credentials (config masked)
POST   /api/credentials              — create credential
PUT    /api/credentials/:id          — update credential
DELETE /api/credentials/:id          — delete credential
```

### Target CRUD payload shape

**HTTP (unchanged since v1.0):**
```json
{
  "name": "Slack alert",
  "target_type": "http",
  "method": "POST",
  "url": "https://hooks.slack.com/...",
  "credential_id": 3,
  "body_mode": "template",
  "body_template": "{\"text\": \"{{contact_name}}\"}",
  "active": 1
}
```

**Workflow:**
```json
{
  "name": "Start intake workflow",
  "target_type": "workflow",
  "config": { "workflow_id": 4 },
  "active": 1
}
```

**Sequence — cascade (by type):**
```json
{
  "name": "Enroll in no-show sequence",
  "target_type": "sequence",
  "config": {
    "template_type": "no_show",
    "contact_id_field": "contact_id",
    "trigger_data_fields": ["appt_id", "appt_time"],
    "appt_type_filter": null,
    "appt_with_filter": null
  },
  "active": 1
}
```

**Sequence — direct (by ID, v1.2.1):**
```json
{
  "name": "Enroll in ad-hoc welcome sequence",
  "target_type": "sequence",
  "config": {
    "template_id": 42,
    "contact_id_field": "body.contactId",
    "trigger_data_fields": ["body.source"]
  },
  "active": 1
}
```

**Internal function:**
```json
{
  "name": "Log new lead",
  "target_type": "internal_function",
  "config": {
    "function_name": "create_log",
    "params_mapping": {
      "contact_id": "contact_id",
      "log_type": "'SMS'",
      "content": "message_summary"
    }
  },
  "active": 1
}
```

### Dry-run preview shape

The `/api/hooks/:id/test` endpoint returns a `would_send` preview for every target. For internal targets this is not an HTTP payload but a description of the internal call that would be made:

```json
{
  "target_id": 7,
  "name": "Start intake workflow",
  "target_type": "workflow",
  "conditions_passed": true,
  "transform_output": { "contact_id": 123, "source": "calendly" },
  "would_send": {
    "method": "INTERNAL",
    "url": "internal://workflow/4",
    "action": "start_workflow",
    "workflow_id": 4,
    "init_data": { "contact_id": 123, "source": "calendly" }
  }
}
```

For sequence direct mode the preview URL is `internal://sequence/id/{template_id}` and the action is `enroll_contact_by_id`.

---

## 13. MANAGEMENT UI

Two UIs drive the same `/api/hooks/*` backend:

- **`public/automationManager.html`** — primary UI. Hooks live here as one of four tabs alongside Workflows, Sequences, and Scheduled Jobs. All automation configuration in one place.
- **`public/yisraHook.html`** — standalone Hook Manager UI. Same features, different entry point.

### Layout

Two-panel: left sidebar (hook list + search), right side (tabbed editor).

**Tabs:** General (includes capture-mode controls), Auth (with key/secret generation), Filter (condition builder or code), Transform (mapper rule builder or code), Targets (SweetAlert2 modals for CRUD), Logs (execution table with drill-down), Test (dry run + live test).

**Top bar buttons:** Save, Delete, and New Hook. Save/Delete are context-sensitive — only visible when a hook is selected or being edited.

### Target editor

The target-edit modal starts with a Target Type selector. Based on the selection, the modal reveals one of four sections:

- **HTTP** — method, URL, credential, body mode, body template. The body-template textarea is conditionally visible on `body_mode === 'template'` (Slice 4.4); a placeholder shows an example.
- **Workflow** — workflow dropdown (fetched from `/workflows`).
- **Sequence** — mode selector (`type` / `id`); in type mode: template-type dropdown (fetched from `/sequences/templates`), `contact_id_field`, `trigger_data_fields` (comma-separated), `appt_type_filter`, `appt_with_filter`; in id mode: template dropdown by ID + same contact/trigger fields. Switching modes does not clear values.
- **Internal Function** — function dropdown (fetched from `/workflows/functions`), params mapping builder (key=value rows; wrap literal strings in single quotes).

The Hooks tab fetches workflows, sequence templates, and the internal function registry on first open. Each fetch is wrapped in its own try/catch — if one reference endpoint is unreachable, the other target types still work.

Target cards in the list show a type badge (HTTP / WORKFLOW / SEQUENCE / FUNCTION) and a human-readable summary of what the target will do (e.g., "Start workflow #4", "Enroll in sequence 'no_show'", "Enroll in template #42", "Call create_log()").

---

## 14. INTEGRATION POINTS

Three wiring steps from v1.0 remain unchanged. v1.2 and v1.2.1 add no new integration steps beyond running their migrations:

1. **server.js** — rawBody middleware for HMAC: `app.use('/hooks', express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }))`
2. **process_jobs.js** — `hook_retry` if-block (same pattern as `sequence_step`). Unchanged in v1.2 and v1.2.1; the existing `hookService.executeRetry(db, data)` call handles all four target types.
3. **Migrations (in order):**
    - `yisrahook_schema.sql` — v1.0 initial schema
    - `2026XX_hook_internal_targets.sql` — v1.2 target_type + config columns
    - `2026XX_hook_capture_mode.sql` — v1.2.1 capture columns on `hooks` + `captured` enum value on `hook_executions.status`

Route auto-loading handles `api.hooks.js`. Credential seeding creates one "YisraCase Internal" row.

---

## 15. TESTED & VALIDATED

### v1.0 — 13 test cases passed

| # | Test | Result |
|---|------|--------|
| 1 | Basic passthrough (no auth, no filter, no transform) | ✅ |
| 2 | Filter conditions — pass and reject | ✅ |
| 3 | Mapper transform (capitalize, lowercase, digits_only, template, static) | ✅ |
| 4 | Code transform (complex JS logic) | ✅ |
| 5 | API key auth (reject no key, wrong key, accept correct key) | ✅ |
| 6 | Multiple targets with per-target conditions + body template | ✅ |
| 7 | Internal credential injection (auto-injected API key) | ✅ |
| 8 | Nested output + extraction transforms (between, after, phone) | ✅ |
| 9 | OR filter groups | ✅ |
| 10 | Failed delivery + retry job queuing | ✅ |
| 11 | 404 for unknown slug | ✅ |
| 12 | Inactive hook invisibility | ✅ |
| 13 | CRUD + version increment + meta endpoint | ✅ |

### v1.2 — additional test plan

| # | Test | Expected |
|---|------|----------|
| 14 | HTTP target unchanged after migration | Existing hooks run without modification |
| 15 | Create workflow target via API | POST succeeds, config persisted, dry-run previews `internal://workflow/N` |
| 16 | Live workflow delivery | `workflow_executions` row created with status='active', advance called in background, delivery log shows status=success |
| 17 | Create sequence target via API (by type) | POST succeeds, config persisted, dry-run shows expected enrollment shape |
| 18 | Live sequence delivery | Enrollment row created, first step job scheduled, delivery log shows `enrollmentId` in response_body |
| 19 | Create internal_function target | POST succeeds, params_mapping persisted |
| 20 | Live internal_function delivery | Function invoked with resolved params, return value captured in response_body |
| 21 | params_mapping literal parsing | `"'SMS'"` becomes `"SMS"`, `"contact_id"` resolves to field value |
| 22 | Target validation errors | Missing `workflow_id` / `template_type` / `function_name` returns 400 with clear message |
| 23 | Retry after workflow INSERT failure | `hook_retry` job fires; second attempt succeeds if underlying issue resolved |
| 24 | Target-level transform on internal target | Transform applied before routing (workflow init_data reflects transform) |
| 25 | Target-level conditions on internal target | False condition skips internal target delivery |

### v1.2.1 — additional coverage

| # | Test | Expected |
|---|------|----------|
| 26 | Create sequence target by ID | POST succeeds; dry-run URL is `internal://sequence/id/N`; action `enroll_contact_by_id` |
| 27 | Reject sequence target with both type + id | 400 at save time with explicit "not both" message |
| 28 | Reject cascade filters alongside `template_id` | 400 at save time |
| 29 | Live sequence delivery — by ID | `enrollContactByTemplateId` called; enrollment row created against exact template |
| 30 | Capture mode arms and intercepts next event | `capture_mode` flips to `capturing`; first inbound event snapshots to `captured_sample`, responds `{status:"captured", execution_id}`, pipeline halts (no delivery logs) |
| 31 | Capture race safety | Concurrent events during capture: exactly one captures; others fall through to normal pipeline with `{status:"received"}` |
| 32 | Capture mode cancel preserves sample | `capture/stop` flips mode to `off` without clearing `captured_sample` or `captured_at` |
| 33 | Dry-run ignores capture mode | Test tab never triggers capture even when armed |
| 34 | Dot-path config on passthrough hook | `contact_id_field: "body.contactId"` resolves correctly without a mapper transform |

---

## 16. v1.3 ROADMAP

### Sync Response Mode (API Gateway Pattern)
Allow hooks to return the target's response to the caller instead of the default `{"status":"received"}`.

**Use case:** External partner needs read-only access to internal data. Hook authenticates with hook-specific API key, transforms the request, calls internal API with real credential, and returns a transformed response — scoped, controlled proxy.

**Schema additions:**
- `hooks.response_mode` ENUM('async','sync') DEFAULT 'async'
- `hook_targets.response_transform_mode` / `response_transform_config`

**Behavior:** In sync mode, pipeline runs in the request lifecycle. One target is designated primary (lowest position). Its HTTP response is piped back through an optional response transform before returning to the caller.

### Custom Static Response
For async mode, allow customizing the immediate response body/status. Two columns on `hooks`: `response_status` (INT DEFAULT 200), `response_body` (JSON DEFAULT NULL). Useful for providers that expect specific confirmation formats.

### Log Retention
Automated cleanup for `hook_executions` and `hook_delivery_logs`. Archive to separate tables or physical backup + purge via scheduled job. Part of a broader unified retention strategy for all YisraCase log tables.

### Auth Manager
Expand `credentials` table to support OAuth with refresh token management. Hook system unchanged — credential lookup returns a valid token regardless of type.

### Additional Transform Functions
As use cases emerge, add to the `hookTransforms.js` registry. Each is a pure function — easy to add without touching the engine.

### Per-target retry policy
Let individual targets opt out of retries via a `no_retry: true` flag on config, useful for non-idempotent internal_function calls where duplicate invocations are worse than a missed call.