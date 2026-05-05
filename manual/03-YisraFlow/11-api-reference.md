# 11 — API Reference

## For operators

This is a compact reference of every endpoint across YisraFlow. For each endpoint, see the chapter listed in the **Chapter** column for full request/response details and examples.

All routes require JWT or API-key auth via the `jwtOrApiKey` middleware **except** the four public-receiver routes:

| Public route | Auth | Notes |
|---|---|---|
| `POST /hooks/:slug` | per-hook (none/api_key/hmac) | YisraHook receiver |
| `POST /email-router` | router api_key | Email Router receiver |
| `GET /isWorkday` | none | Used by other internal systems |
| `POST /process-jobs` | jwt | Heartbeat (called by Cloud Scheduler) |

Standard auth headers: `Authorization: Bearer <jwt>` or `x-api-key: <key>`. The audit log captures both forms.

---

## Technical reference

### Workflows — chapter 2

| Route | Method | Purpose |
|---|---|---|
| `/workflows` | GET | List all workflow templates (paginated) |
| `/workflows/:id` | GET | Template + ordered steps |
| `/workflows` | POST | Create template |
| `/workflows/:id` | PUT | Update template |
| `/workflows/:id` | DELETE | Delete template (cascades to steps via FK) |
| `/workflows/:id/duplicate` | POST | Clone a template |
| `/workflows/bulk` | POST | Bulk-create / bulk-update workflows + steps in one transaction |
| `/workflows/:id/steps` | POST | Add a step |
| `/workflows/:id/steps/:stepNumber` | PUT | Replace a step |
| `/workflows/:id/steps/:stepNumber` | PATCH | Partial update |
| `/workflows/:id/steps/:stepNumber` | DELETE | Delete a step |
| `/workflows/:id/steps/reorder` | PATCH | Reorder steps in one shot |
| `/workflows/:id/start` | POST | Start an execution. **Returns 202**. |
| `/workflows/:id/executions` | GET | Executions of one workflow |
| `/workflows/test-step` | POST | Test a single step config against arbitrary input |
| `/workflows/functions` | GET | List of internal functions, metadata, and which work in workflows vs sequences |
| `/executions` | GET | All executions (filterable by status, workflow_id, search) |
| `/executions/:id` | GET | Current state + variables (`?history=true` for full step log) |
| `/executions/:id/cancel` | POST | Cancel execution. Requires non-empty `cancel_reason` (≥3 chars). |
| `/api/contacts/:id/workflows` | GET | Executions tied to one contact (`?scope=active\|all`, `?status=...`) |

#### `POST /workflows/:id/start` body shapes

**Wrapped (recommended):**
```json
{ "init_data": { "contactId": 123, ... }, "contact_id": 123 }
```

**Flat:**
```json
{ "contactId": 123, "anyOtherField": "..." }     // entire body becomes init_data
```

Returns **202** with `{ success, executionId, workflowId, contactId, status: "processing", message }`.

---

### Sequences — chapter 3

| Route | Method | Purpose |
|---|---|---|
| `/sequences/templates` | GET | List templates |
| `/sequences/templates/:id` | GET | Template + ordered steps |
| `/sequences/templates` | POST | Create template |
| `/sequences/templates/:id` | PUT | Update |
| `/sequences/templates/:id` | DELETE | Delete (cascades to steps) |
| `/sequences/templates/:id/duplicate` | POST | Clone |
| `/sequences/templates/:id/steps` | POST | Add step |
| `/sequences/templates/:id/steps/:stepNumber` | PUT | Replace step |
| `/sequences/templates/:id/steps/:stepNumber` | PATCH | Partial update |
| `/sequences/templates/:id/steps/:stepNumber` | DELETE | Delete step |
| `/sequences/templates/:id/steps/reorder` | PATCH | Reorder steps |
| `/sequences/enroll` | POST | Enroll a contact (cascade by type or direct by id) |
| `/sequences/cancel` | POST | Cancel by `(contact_id, template_type)`; omit type for all |
| `/sequences/templates/:id/enrollments` | GET | Enrollments of one template |
| `/sequences/enrollments` | GET | All enrollments (filterable by status, contact_id, template_id) |
| `/sequences/enrollments/:id` | GET | Enrollment + step log |
| `/sequences/enrollments/:id/cancel` | POST | Cancel one enrollment |

#### `POST /sequences/enroll` — exactly one of these

**Cascade by type** (cascading template match — see chapter 3):
```json
{
  "contact_id":    123,
  "template_type": "pre_appt",
  "trigger_data":  {
    "appt_id":   456,
    "appt_time": "2026-03-20T14:00:00Z",
    "appt_type": "341 Meeting",
    "appt_with": 2
  }
}
```

Cascade fields (the keys named in the type's `priority_fields`) live **inside** `trigger_data` — there are no top-level `appt_type` / `appt_with` body fields anymore. The engine reads them straight from `trigger_data` and ranks every active template of `template_type` against them.

**Direct by id** (no cascade):
```json
{
  "contact_id":   123,
  "template_id":  42,
  "trigger_data": { ... }
}
```

400 on: both/neither of `template_type`/`template_id` set, empty `template_type`, invalid `template_id`, missing `contact_id`, template inactive.

#### Sequence Types — `/api/sequence-types`

Cascade configuration per sequence type. `priority_fields` declares the ordered list of `trigger_data` keys that drive cascade scoring (see chapter 3 / cookbook §3.5). Edited in-page via the **Manage Types** button on the Sequences tab — no separate sub-page.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/sequence-types` | GET | jwt | List all types (active + inactive), `ORDER BY type ASC` |
| `/api/sequence-types/:type` | GET | jwt | Single type |
| `/api/sequence-types` | POST | superuser | Create |
| `/api/sequence-types/:type` | PUT | superuser | Partial update (any subset of `priority_fields`, `description`, `active`) |
| `/api/sequence-types/:type` | DELETE | superuser | Delete |

Write operations are SU-gated and audited under `tool='sequence_types'`. Reads use the standard `jwtOrApiKey` middleware.

**Validation:**
- `type` — `/^[a-z][a-z0-9_]*$/`, ≤50 chars; immutable PK (no rename via PUT)
- `priority_fields` — JSON array of unique strings, each matching the `type` regex and ≤50 chars; **empty array allowed** (a type with no cascade — every template scores 0, lowest id wins)

**Response shapes:**
```json
// GET /api/sequence-types
{ "success": true, "types": [
  { "type": "no_show", "priority_fields": ["appt_type", "appt_with"],
    "description": "...", "active": true,
    "created_at": "...", "updated_at": "..." },
  ...
]}

// GET /api/sequence-types/:type, POST 201, PUT 200
{ "success": true, "type": { ...row... } }
// (POST/PUT may return just `{ "success": true, "type": "no_show" }` — string, not object)

// DELETE 200
{ "success": true, "message": "Sequence type \"...\" deleted" }
```

**409 conflict shapes:**

| Operation | Cause | Body |
|---|---|---|
| POST | Type already exists | `{ "error": "Sequence type \"...\" already exists" }` |
| PUT | Removing a `priority_fields` key still referenced by some template's `filters` | `{ "error": "...", "removed_keys": ["..."], "offenders": [{ "id": 4, "name": "..." }, ...] }` |
| DELETE | Type still has templates referencing it (active or inactive) | `{ "error": "...", "template_count": 3 }` |

The shrinkage check is the only place a PUT can 409 — adding fields, reordering, toggling `active`, and editing `description` are unconstrained.

#### Template `filters` validation

`POST /sequences/templates` and `PUT /sequences/templates/:id` reject `filters` JSON keys that aren't in the type's `priority_fields` (`validateTemplateFilters` in `lib/sequenceEngine.js`). Type-less (ID-only) templates can't have non-empty filters at all.

---

### Scheduled Jobs — chapter 4

| Route | Method | Purpose |
|---|---|---|
| `/scheduled-jobs` | GET | List (filter: `status`, `type`, `internal`, `search`, `page`, `limit`) |
| `/scheduled-jobs/:id` | GET | Single job + stats + latest exec (`?history=true` for full attempt history) |
| `/scheduled-jobs` | POST | Create one-time or recurring |
| `/scheduled-jobs/:id` | PATCH | Edit (only `pending`/`failed` jobs) |
| `/scheduled-jobs/:id` | DELETE | Delete |
| `/process-jobs` | ALL | Heartbeat — claim batch, dispatch, record (called by Cloud Scheduler) |

`POST /scheduled-jobs` body — see chapter 4 for full shapes. Key fields:
- `type` — `one_time` or `recurring`
- `job_type` — `webhook`, `internal_function`, `custom_code` (translates to `data.type`)
- Either `delay` (`"30s"`, `"10m"`, `"2h"`, `"1d"`) or `scheduled_time` (ISO)
- For `recurring`: `recurrence_rule`, optional `max_executions`, `expires_at`

---

### Internal Functions — chapter 5

| Route | Method | Purpose |
|---|---|---|
| `/workflows/functions` | GET | Returns `{ workflow: [...], sequence: [...], meta: {...} }` |

`workflow` lists all 23 callable functions. `sequence` filters out the 7 workflow-only functions (`set_next`, `evaluate_condition`, `schedule_resume`, `wait_for`, `wait_until_time`, `format_string`, `set_test_var`). `meta` is the per-function metadata registry — drives the form-driven param editor in the UI.

Internal functions are **not directly callable via HTTP** — they're invoked through workflow steps, sequence steps, scheduled jobs, hook targets, or the `internal_function` job_type. There's no `POST /internal_functions/:name/run` endpoint.

---

### Resolver — chapter 6

| Route | Method | Purpose |
|---|---|---|
| `/resolve` | POST | Resolve placeholders in arbitrary text against `refs` |
| `/resolve/tables` | GET | Allowed table whitelist (12 tables, `trigger_data` excluded) |

`POST /resolve` body:
```json
{
  "text": "Hi {{contacts.contact_fname}}...",
  "refs": { "contacts": { "contact_id": 123 } },
  "strict": false
}
```

Always 200 for content issues — check `status` (`success` / `partial_success` / `failed`) and `errorType` (`security` / `missing_refs` / `query_error`) on the response body.

---

### Calendar — chapter 7

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/isWorkday` | GET | none | `?date=ISO` — is this datetime in business hours? |
| `/nextBusinessDay` | POST | jwt | Test next-business-day picker |
| `/prevBusinessDay` | POST | jwt | Test prev-business-day picker (used by `before_appt` timing) |

---

### YisraHook — chapter 9

#### Receiver

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/hooks/:slug` | POST | per-hook | Public receiver |

Auth per hook: `none` / `api_key` (default header `x-hook-key`) / `hmac` (default header `x-hook-signature`). Always 200 for processing outcomes. 401 on auth fail.

#### Management

| Route | Method | Purpose |
|---|---|---|
| `/api/hooks` | GET | List hooks |
| `/api/hooks/:id` | GET | Hook + targets |
| `/api/hooks` | POST | Create |
| `/api/hooks/:id` | PUT | Update (auto-bumps `version`) |
| `/api/hooks/:id` | DELETE | Soft delete (cascades targets) |
| `/api/hooks/:id/targets` | POST | Add target |
| `/api/hooks/:id/targets/:targetId` | PUT | Update target |
| `/api/hooks/:id/targets/:targetId` | DELETE | Delete target |
| `/api/hooks/:id/test` | POST | Dry-run with arbitrary input |
| `/api/hooks/:id/capture/start` | POST | Arm capture mode |
| `/api/hooks/:id/capture/stop` | POST | Cancel (preserves sample) |
| `/api/hooks/:id/captured-sample` | GET | Last captured payload |
| `/api/hooks/:id/executions` | GET | Paginated executions |
| `/api/hooks/executions/:id` | GET | Single execution + delivery logs |

#### Credentials (shared with sequence webhook steps)

| Route | Method | Purpose |
|---|---|---|
| `/api/credentials` | GET | List |
| `/api/credentials/:id` | GET | Single |
| `/api/credentials` | POST | Create |
| `/api/credentials/:id` | PUT | Update |
| `/api/credentials/:id` | DELETE | Delete |

`type` enum: `internal`, `bearer`, `api_key`, `basic`. URL scoping via `allowed_urls` (JSON array of allowed URL prefixes).

---

### Email Router — chapter 10

#### Receiver

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/email-router` | POST | router api_key | Public receiver — adapter-side. Always 200. Rate limit 60/min/IP. |

#### Management

| Route | Method | Purpose |
|---|---|---|
| `/api/email-router/routes` | GET | List rules |
| `/api/email-router/routes/:id` | GET | Single rule |
| `/api/email-router/routes` | POST | Create rule |
| `/api/email-router/routes/:id` | PUT | Update |
| `/api/email-router/routes/:id` | DELETE | Delete |
| `/api/email-router/config` | GET | Singleton config (api_key masked) |
| `/api/email-router/config` | PUT | Update auth config |
| `/api/email-router/capture/start` | POST | Arm capture mode |
| `/api/email-router/capture/stop` | POST | Cancel (preserves sample) |
| `/api/email-router/captured-sample` | GET | Last captured payload |
| `/api/email-router/preview` | POST | Match + hook dry-run preview |
| `/api/email-router/match-test` | POST | Match-only preview, returns all matches |
| `/api/email-router/executions` | GET | Paginated execution log |
| `/api/email-router/executions/:id` | GET | Single execution + linked hook execution + delivery logs |

---

## Common patterns

### Always-200 receivers

Both `POST /hooks/:slug` and `POST /email-router` return 200 even on internal failures. The convention: senders should retry only on **non-200**, which we reserve for auth rejection (401) and slug-not-found.

This means a misconfigured hook target failing to deliver is *our* problem, surfaced in the executions log — the sender doesn't get a retry signal.

### Explicit-then-default contact-tying

Workflow `POST /workflows/:id/start` accepts an explicit `contact_id` (wrapped body only) that overrides the workflow template's `default_contact_id_from`. Sequence `POST /sequences/enroll` always requires explicit `contact_id`. Hook workflow targets resolve via the workflow's template default only.

### Pagination

List endpoints accept `?page=N` and `?limit=N` (default usually 30, max 100 or 200). Response includes `total` for client-side pagination math.

### Filterable list endpoints

`/scheduled-jobs`, `/executions`, `/sequences/enrollments` all accept search and status filters via query string. Combine freely.

### Audit log

Every authenticated request is logged in `jwt_api_audit_log` with the user/api-key, route, method, status, and a sanitized snapshot of body/query (Bearer tokens are redacted in the snapshot). Useful for "who did what" debugging.