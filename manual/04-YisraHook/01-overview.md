# YisraHook — Design & Implementation Document
# v1.0 Complete — April 2026

YisraHook is a configurable webhook receiver that normalizes, filters, transforms, and routes incoming events to multiple targets — replacing per-integration Express routes with per-hook configuration.

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
migrations/yisrahook_schema.sql  — 5 tables + scheduled_jobs enum expansion
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
  → Return 200 immediately (async from here)
  → Insert hook_execution row (status: 'received')
  → Run hook-level filter
      → If false: mark 'filtered', done
  → Run hook-level transform
  → For each active target (ordered by position):
      → Evaluate target conditions (skip if false)
      → Run target-level transform (if any, refines hook output)
      → Build delivery request (URL, method, headers, auth injection, body)
      → Attempt delivery synchronously
          → Success: log to hook_delivery_logs
          → Failure: log failure, queue hook_retry job in scheduled_jobs
  → Update execution status based on results
```

### Execution Model

- **Processing (filter + transform):** Synchronous. Pure in-memory computation.
- **Delivery:** Synchronous on first attempt. Failed deliveries queue a `hook_retry` job in `scheduled_jobs` with existing retry/backoff logic (3 max attempts, 120s backoff).
- **Response:** Always 200 immediately. Pipeline runs fire-and-forget after response.
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
Each target can have its own `conditions` field (same evaluator). Evaluated against the **hook-level transform output**, not raw input.

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
Each target can override with its own `transform_mode`/`transform_config`, refining the hook-level output for that specific target.

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

## 8. CREDENTIAL STORE & AUTH INJECTION (Outbound)

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

### Target Configuration
Each target: `method`, `url`, `headers` (JSON), `credential_id` (FK), `body_mode`, `conditions`, `transform_mode`/`transform_config`.

### Body Modes
- `transform_output` — sends full transform output as JSON
- `template` — resolves `{{path|transforms}}` against transform output: `{"text": "New lead: {{contact_name}}"}`

### Retry on Failure
Non-2xx or timeout → log failure → queue `hook_retry` job in `scheduled_jobs` (3 max attempts, 120s exponential backoff).

---

## 10. DATABASE SCHEMA

### `credentials`
`id`, `name`, `type` (enum: internal/bearer/api_key/basic), `config` (JSON), `allowed_urls` (JSON), `created_at`, `updated_at`

### `hooks`
`id`, `slug` (unique), `name`, `description`, `auth_type`, `auth_config` (JSON), `filter_mode`, `filter_config` (JSON), `transform_mode`, `transform_config` (JSON), `active`, `version` (auto-increments on update), `last_modified_by` (FK → users), `created_at`, `updated_at`

### `hook_targets`
`id`, `hook_id` (FK CASCADE), `name`, `position`, `method`, `url`, `headers` (JSON), `credential_id` (FK SET NULL), `body_mode`, `body_template`, `conditions` (JSON), `transform_mode`, `transform_config` (JSON), `active`

### `hook_executions`
`id` (BIGINT), `hook_id`, `slug`, `raw_input` (JSON, max 512KB), `filter_passed`, `transform_output` (JSON), `status` (enum: received/filtered/processing/delivered/partial/failed), `error`, `created_at`

### `hook_delivery_logs`
`id` (BIGINT), `execution_id` (FK CASCADE), `target_id`, `request_url`, `request_method`, `request_body` (JSON), `response_status`, `response_body`, `status` (enum: success/failed), `error`, `attempts`, `created_at`

### `scheduled_jobs` expansion
Enum expanded to include `hook_retry`.

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

GET    /api/hooks                    — list all hooks
GET    /api/hooks/:id                — get hook with targets
POST   /api/hooks                    — create hook
PUT    /api/hooks/:id                — update hook (auto-increments version)
DELETE /api/hooks/:id                — delete hook (cascades targets)

POST   /api/hooks/:id/targets        — create target
PUT    /api/hooks/targets/:id        — update target
DELETE /api/hooks/targets/:id        — delete target

POST   /api/hooks/:id/test           — dry run test (no delivery)
GET    /api/hooks/:id/executions     — execution log (paginated)
GET    /api/hooks/executions/:id     — single execution with delivery logs
GET    /api/hooks/meta               — available transforms + operators (for UI)

GET    /api/credentials              — list credentials (config masked)
POST   /api/credentials              — create credential
PUT    /api/credentials/:id          — update credential
DELETE /api/credentials/:id          — delete credential
```

---

## 13. MANAGEMENT UI

Two UIs drive the same `/api/hooks/*` backend:

- **`public/automationManager.html`** — primary UI. Hooks live here as one of four tabs alongside Workflows, Sequences, and Scheduled Jobs. All automation configuration in one place.
- **`public/yisraHook.html`** — standalone Hook Manager UI. Same features, different entry point.

### Layout

Two-panel: left sidebar (hook list + search), right side (tabbed editor).

**Tabs:** General, Auth (with key/secret generation), Filter (condition builder or code), Transform (mapper rule builder or code), Targets (SweetAlert2 modals for CRUD), Logs (execution table with drill-down), Test (dry run + live test).

**Top bar buttons:** Save, Delete, and New Hook. Save/Delete are context-sensitive — only visible when a hook is selected or being edited.

---

## 14. INTEGRATION POINTS

Three wiring steps required when deploying:

1. **server.js** — rawBody middleware for HMAC: `app.use('/hooks', express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }))`
2. **process_jobs.js** — add `hook_retry` if-block (same pattern as `sequence_step`)
3. **Migration** — run `yisrahook_schema.sql` (creates 5 tables + expands `scheduled_jobs.type` enum)

Route auto-loading handles `api.hooks.js`. Credential seeding creates one "YisraCase Internal" row.

---

## 15. TESTED & VALIDATED (v1.0)

All 13 test cases passed:

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

---

## 16. v1.1 ROADMAP

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