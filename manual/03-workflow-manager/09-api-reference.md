# Part 9 — API Reference

All endpoints require JWT or API key authentication unless noted. Authentication is handled by `jwtOrApiKey` middleware.

---

## Workflow Engine

### Workflow Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/workflows` | List all workflows |
| `GET` | `/workflows/functions` | List available internal functions (categorized) |
| `GET` | `/workflows/:id` | Get workflow + steps |
| `POST` | `/workflows` | Create workflow |
| `POST` | `/workflows/bulk` | Create workflow + all steps in one call |
| `PUT` | `/workflows/:id` | Update name/description |
| `DELETE` | `/workflows/:id` | Delete workflow + steps |
| `POST` | `/workflows/:id/duplicate` | Duplicate workflow + steps |

**`GET /workflows/functions` response:**
```json
{
  "workflow": ["set_next", "evaluate_condition", "noop", "...all 22"],
  "sequence": ["send_sms", "send_email", "...15 (excludes workflow-only)"]
}
```
Sequence list excludes: `set_next`, `evaluate_condition`, `schedule_resume`, `wait_for`, `wait_until_time`, `format_string`, `set_test_var`.

### Workflow Steps

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workflows/:id/steps` | Add a step (inserts at stepNumber, shifts others up) |
| `PUT` | `/workflows/:id/steps/:stepNumber` | Full replace |
| `PATCH` | `/workflows/:id/steps/:stepNumber` | Partial update |
| `DELETE` | `/workflows/:id/steps/:stepNumber` | Delete + renumber |
| `PATCH` | `/workflows/:id/steps/reorder` | Reorder steps |

**Reorder formats:**
```json
{ "fromStep": 5, "toStep": 2 }
{ "order": [3, 1, 4, 2, 5] }
```

### Contact-tying executions (Slice 4.3 Part B)

Workflow executions can carry an optional `contact_id`, populated at start time. Contact-tied executions surface on `contact2.html`'s Automations tab; untied ones (NULL) don't appear on any contact page.

**Two mechanisms:**

1. **Template-level default** — set `workflows.default_contact_id_from` to the name of an init_data key (e.g. `'contact_id'`). On every start of that workflow, the engine reads `init_data[that_key]`; if it's a positive integer, it stamps `workflow_executions.contact_id`.

2. **Execution-level override** — on `POST /workflows/:id/start`, pass a top-level `contact_id` in a **wrapped** body: `{ init_data: {...}, contact_id: 123 }`. This overrides the template default for this one execution. Wrapped-only by design — extracting `contact_id` from flat bodies would silently strip it from init_data for legacy callers.

**Precedence:** explicit body `contact_id` > template default > NULL.

Both mechanisms call the same shared helper (`resolveExecutionContactId` in `lib/workflow_engine.js`), which is also invoked by the two direct-INSERT creation sites (`services/apptService.js` and `services/hookService.js`'s `deliverWorkflow`). `apptService` populates the column directly since it already knows the value; `hookService` uses the template-default mechanism (no explicit override on the hook path).

**Cancel reason.** `POST /executions/:id/cancel` requires `{ reason: string }` (min 3 chars after trim). No existing callers — `contact2.html` Part B is the first — so this is a hard 400 with no back-compat shim.

### Workflow Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workflows/:id/start` | Start an execution. **Body accepts two shapes** — see below. Returns `202 Accepted` with `{ success, executionId, workflowId, contactId, status: "processing", message }`. Execution advances in the background. |
| `GET` | `/executions` | List all executions (legacy envelope — see note). Query: `?page`, `?limit` (max 100, default 20), `?status`, `?workflow_id`, `?search`. Response: `{ success, executions, pagination: { page, limit, total, totalPages } }`. |
| `GET` | `/executions/:id` | Single execution. Response: `{ success, execution }` — `execution` is the full `workflow_executions` row plus `workflow_name` from LEFT JOIN. |
| `GET` | `/executions/:id?history=true` | Execution + step history. Response: `{ success, execution, history }` — `history` is an array of `workflow_execution_steps` rows (ordered by `executed_at ASC`) with `output_data` JSON-parsed. |
| `GET` | `/workflows/:id/executions` | Paginated executions for one workflow. Query: `?limit` (default 50, max 200), `?offset` (default 0; **wins if both `offset` and `page` are present**), `?page` (legacy), `?status`, `?sort=created_at:asc\|desc` (default desc). Response: `{ success, executions, total }` — flat envelope. Row shape below. |
| `POST` | `/executions/:id/cancel` | Cancel a running execution. **Body required**: `{ reason: string }` (min 3 chars after trim, max 500 — longer reasons are silently truncated rather than rejected). 400 on missing/short. Reason stored in `workflow_executions.cancel_reason`. Sets status=cancelled and deletes pending `workflow_resume` jobs for the execution. **Breaking change from pre-Slice-4.3B:** route previously accepted no body. |

**`POST /workflows/:id/start` — two body shapes.** Wrapped and flat. Both are supported by design; older callers use flat.

*Wrapped* — opt-in contact_id override:
```json
{
  "init_data": { "campaignId": 42, "message": "..." },
  "contact_id": 123
}
```

*Flat* — whole body becomes init_data (back-compat):
```json
{ "contactId": 123, "contactName": "Fred", "source": "web" }
```

Wrapping is detected by the presence of `init_data` or `initData` at the top level. Only wrapped bodies produce an explicit `contact_id` override; flat callers rely on the workflow's `default_contact_id_from` instead. See the "Contact-tying executions" section above for precedence.

Response (202):
```json
{
  "success": true,
  "executionId": 789,
  "workflowId": 5,
  "contactId": 123,
  "status": "processing",
  "message": "Workflow execution started and is now processing"
}
```
`contactId` is echoed so callers can verify the resolved value (may be null if neither mechanism produced one).

**`GET /workflows/:id/executions` row shape:**

| Field | Source |
|-------|--------|
| `id` | `workflow_executions.id` |
| `status` | `workflow_executions.status` |
| `status_summary` | Computed: `completed_with_errors` if status starts with `completed` and any step failed, else `completed`, else the raw status |
| `current_step_number` | `workflow_executions.current_step_number` |
| `steps_executed_count` | `workflow_executions.steps_executed_count` |
| `created_at` / `updated_at` / `completed_at` | `workflow_executions.*` |
| `variable_count` | `JSON_LENGTH(e.variables)` |
| `failed_steps` | Count of `workflow_execution_steps` rows with `status='failed'` |

> **Note:** prior versions of this doc mentioned a `started_at` column — it does not exist. Creation time is `created_at`.

> **Legacy envelope.** `GET /executions` still returns the nested `{ success, executions, pagination }` shape. `GET /workflows/:id/executions` uses the flat `{ success, executions, total }` shape adopted across Slice 1. Consolidation is a deferred doc-agnostic cleanup; both shapes are currently live.

### Contact-Scoped Automation Views

Paginated executions/enrollments tied to a specific contact. Envelope parity with each other and with hook execution lists (see Cookbook §3.9).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/contacts/:id/workflows` | Slice 4.3 Part B. Paginated workflow executions tied to a contact via `workflow_executions.contact_id`. Query: `?limit` (default 50, max 200), `?offset` (default 0), `?status` (full workflow enum — 400 on invalid), `?scope` (`active` default → non-terminal: `active\|processing\|delayed`; `all` → no status filter; ignored when `?status` is set). Response: `{ success, workflows, total, active_total }`. 404 if contact not found. |
| `GET` | `/api/contacts/:id/sequences` | Slice 4.3 Part A. Paginated sequence enrollments for a contact. Query: `?limit` (default 50, max 200), `?offset` (default 0), `?status=active\|completed\|cancelled`, `?scope=active\|all` (default `active`; ignored when `?status` is set). Response: `{ success, sequences, total, active_total }`. 404 if contact not found. |

**`active_total`** on both endpoints is always the unfiltered count of `status='active'` (sequences) or non-terminal status (workflows) for this contact, regardless of the current filter — lets the UI render "N active of M total" when `?scope=all`.

**Row shape — `/workflows`:**
`execution_id` (aliased from `we.id`), `workflow_id`, `workflow_name` (from LEFT JOIN), `status`, `current_step_number`, `steps_executed_count`, `cancel_reason`, `created_at`, `updated_at`, `completed_at`. `init_data` and `variables` intentionally excluded — drill down via `GET /executions/:id?history=true`.

**Row shape — `/sequences`:**
`enrollment_id` (aliased from `se.id`), `template_id`, `template_name` (from JOIN), `template_type` (from JOIN), `status`, `current_step`, `total_steps`, `cancel_reason`, `enrolled_at`, `completed_at`, `updated_at`.

### Test

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workflows/test-step` | Dry-run a single step without writing to DB |

```json
// POST /workflows/test-step body
{
  "step":      { "type": "internal_function", "config": { ... } },
  "variables": { "contactId": 123, "appt_status": "confirmed" }
}
```

---

## Sequence Engine

### Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sequences/templates` | List templates (query: `type`, `active`) |
| `GET` | `/sequences/templates/:id` | Template + steps |
| `POST` | `/sequences/templates` | Create template. `type` is **optional/nullable** — templates with a NULL type cannot be cascade-matched and are reachable only via `template_id` (direct enrollment). |
| `PUT` | `/sequences/templates/:id` | Update template |
| `DELETE` | `/sequences/templates/:id` | Delete (blocked if active enrollments) |
| `POST` | `/sequences/templates/:id/duplicate` | Slice 3.1. Duplicate template + all steps. Copy is created **inactive** with a suffixed name (mirrors `duplicateWorkflow`). |

### Template Steps

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sequences/templates/:id/steps` | Add step |
| `PUT` | `/sequences/templates/:id/steps/:stepNumber` | Full replace |
| `PATCH` | `/sequences/templates/:id/steps/:stepNumber` | Partial update |
| `DELETE` | `/sequences/templates/:id/steps/:stepNumber` | Delete + renumber |
| `PATCH` | `/sequences/templates/:id/steps/reorder` | Swap two steps |

**Reorder body:**
```json
{ "fromStep": 2, "toStep": 4 }
```

Swap-only — unlike `/workflows/:id/steps/reorder`, the sequence variant does not accept a full `order` array. It's a two-step swap via a temp number.

### Sequence Step `action_type` and `action_config`

`action_type`: one of `sms`, `email`, `task`, `internal_function`,
`webhook`, `start_workflow`. The last two were added in Slice 3.3.

#### `sms`, `email`, `task`, `internal_function`
Wrapped `internal_function` call. `action_config` shape:
```json
{
  "function_name": "send_sms",
  "params": { "from": "...", "to": "...", "message": "..." }
}
```

#### `webhook` (Slice 3.3)
First-class HTTP request. Shares credential injection with YisraHook HTTP
targets via the `credentials` table.

```json
{
  "method": "POST",
  "url": "https://example.com/api/endpoint",
  "credential_id": 5,
  "headers": { "X-Custom": "value" },
  "body": {
    "contact_id": "{{trigger_data.contact_id}}",
    "event": "sequence_step_fired"
  },
  "timeout_ms": 30000
}
```

**Validation at save** (400 on any failure):
- `url` required, non-empty string. Parse-checked if no `{{...}}` placeholders; otherwise syntax check deferred to execution.
- `method` optional, one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Default `POST`.
- `credential_id` optional; positive integer; FK checked against `credentials` table.
- `headers` optional; JSON object or null.
- `body` optional; JSON object or null.
- `timeout_ms` optional; positive integer ≤ 120000. Default 30000.

**Not retry-idempotent.** Each retry fires a fresh HTTP request. Receiver must tolerate duplicates.

#### `start_workflow` (Slice 3.3)
First-class workflow start. Fourth `workflow_executions` INSERT site (Cookbook §5.21).

```json
{
  "workflow_id": 12,
  "init_data": {
    "contact_id": "{{trigger_data.contact_id}}",
    "case_id":    "{{trigger_data.case_id}}"
  },
  "tie_to_contact": true,
  "contact_id_override": null
}
```

**Validation at save** (400 on any failure):
- `workflow_id` required, positive integer, FK checked against `workflows` table.
- `init_data` optional; JSON object (may be empty). Placeholder syntax not checked at save time — resolver handles runtime errors.
- `tie_to_contact` optional; boolean. Default `true`.
- `contact_id_override` optional; string, number, or null. Only meaningful when `tie_to_contact: false`. A string may be a `{{placeholder}}` or a literal integer.

**Runtime contact_id precedence:**
1. `tie_to_contact: true` → `enrollment.contact_id`.
2. `tie_to_contact: false` + non-empty `contact_id_override` → resolved, must be positive integer.
3. `tie_to_contact: false` + empty override → `workflows.default_contact_id_from` applies.

**Retry-safe.** Before firing, checks `sequence_step_log.output_data` for a
prior `workflow_execution_id` on this (enrollment, step_number). If found
and the execution row still exists, reuses it — no duplicate execution.

### Enrollments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sequences/enroll` | Enroll a contact. Two variants — see bodies below. |
| `POST` | `/sequences/cancel` | Cancel sequences for a contact. Body: `{ contact_id, template_type?, reason? }`. Omit `template_type` to cancel all active sequences for this contact. Default reason is `'manual'`. |
| `GET` | `/sequences/enrollments` | **Legacy** — list enrollments across all templates. Query: `?contact_id`, `?template_type`, `?status`, `?page` (default 1), `?limit` (default 20, max 100). Response: `{ success, enrollments, pagination: { page, limit, total, totalPages } }` — nested envelope retained for back-compat. Candidate for consolidation with the per-template list. |
| `GET` | `/sequences/enrollments/:id` | Single enrollment + step log. Default on `?log=true`; pass `?log=false` to skip. Response: `{ success, enrollment, log }`. Add `?history=true` for the scheduled-jobs-derived step history — see next row. |
| `GET` | `/sequences/enrollments/:id?history=true` | Adds a scheduled_jobs-derived step history joined with `sequence_step_log`. Response: `{ success, enrollment, log, history }`. Row shape below. |
| `GET` | `/sequences/templates/:id/enrollments` | Slice 1.1 Slice 2. Paginated enrollments for one template. Query: `?limit` (default 50, max 200), `?offset` (default 0), `?status=active\|completed\|cancelled` (400 on invalid). Response: `{ success, enrollments, total }`. 404 if template not found. Row shape below. |
| `POST` | `/sequences/enrollments/:id/cancel` | Cancel one enrollment. Body: `{ reason? }` (default `'manual'`). |

**`POST /sequences/enroll` — two variants.** Exactly one of `template_type` or `template_id` must be provided. Validation is strict — empty strings, whitespace-only strings, and both-set all return 400.

*Cascade mode* — matches template by type with optional filters (see [Cascading Template Match](03-sequences.md#cascading-template-match)):
```json
{
  "contact_id":    123,
  "template_type": "no_show",
  "trigger_data":  { "appt_id": 456, "appt_time": "2026-03-20T14:00:00Z" },
  "appt_type":     "Strategy Session",
  "appt_with":     2
}
```

*Direct mode* — targets a specific template by ID, skips cascade:
```json
{
  "contact_id":   123,
  "template_id":  42,
  "trigger_data": { "appt_id": 456 }
}
```

**400 cases:**
- Both `template_type` and `template_id` set
- Neither set
- `template_type` present but null / empty / whitespace-only
- `template_id` set alongside `appt_type` or `appt_with` (cascade filters are cascade-mode only)
- `template_id` not a positive integer

The `enroll_sequence` internal function accepts the **same two variants** with the same validation — direct callers and workflow/sequence steps share one code path into `sequenceEngine.enrollContact` / `enrollContactByTemplateId`.

**`POST /sequences/cancel` body:**
```json
{
  "contact_id":    123,
  "template_type": "no_show",
  "reason":        "new_appointment_booked"
}
```
Omit `template_type` to cancel all active sequences for the contact.

**`GET /sequences/templates/:id/enrollments` row shape:**
`id`, `template_id`, `contact_id`, `status`, `current_step`, `total_steps`, `enrolled_at`, `completed_at`, `updated_at`, `cancel_reason`, `contact_name` (from LEFT JOIN `contacts`, TRIMmed concat of fname + lname). `trigger_data` intentionally excluded from list rows — drill down via `GET /sequences/enrollments/:id`.

**`GET /sequences/enrollments/:id?history=true` derived row shape.** One row per `scheduled_jobs` entry for the enrollment, LEFT JOINed with `sequence_step_log` on `(enrollment_id, step_number)`, ordered by `scheduled_time ASC, id ASC`. `step_number` is extracted from `sj.data` JSON — there's no dedicated column on `scheduled_jobs`. Log fields are NULL for rows that never executed (pending, or cancelled-before-fire).

| Field | Source |
|-------|--------|
| `job_id` | `scheduled_jobs.id` |
| `scheduled_time` | `scheduled_jobs.scheduled_time` |
| `job_status` | `scheduled_jobs.status` |
| `attempts` / `max_attempts` | `scheduled_jobs.*` |
| `job_updated_at` | `scheduled_jobs.updated_at` |
| `job_data` | `scheduled_jobs.data`, JSON-parsed |
| `step_number` | `CAST(JSON_EXTRACT(sj.data, '$.stepNumber') AS UNSIGNED)` |
| `log_id` | `sequence_step_log.id` (NULL if never executed) |
| `log_status` | `sequence_step_log.status` |
| `skip_reason` | `sequence_step_log.skip_reason` |
| `error_message` | `sequence_step_log.error_message` |
| `duration_ms` | `sequence_step_log.duration_ms` |
| `executed_at` | `sequence_step_log.executed_at` |
| `action_config_resolved` | `sequence_step_log.action_config_resolved`, JSON-parsed |
| `output_data` | `sequence_step_log.output_data`, JSON-parsed |
| `log_step_id` | `sequence_step_log.step_id` |
| `action_type` | `sequence_steps.action_type` (via LEFT JOIN on `log_step_id`) |

Rows where `log_id IS NULL` are scheduled-but-never-executed (pending, failed-before-fire, or cancelled). See Cookbook §5.24 for the display rule (log_status primary, job_status fallback).

### Credentials (shared with YisraHook)

Credentials in the `credentials` table are shared between YisraHook HTTP
targets and sequence webhook steps (Slice 3.3). The same `credential_id`
can be referenced from either side. See the Hooks management routes for
CRUD (`GET/POST/PUT/DELETE /api/credentials`).

---

## Scheduled Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/scheduled-jobs` | Create a job |
| `GET` | `/scheduled-jobs` | List jobs (query: `status`, `type`, `search`, `internal`) |
| `GET` | `/scheduled-jobs/:id` | Job metadata + latest result |
| `GET` | `/scheduled-jobs/:id?history=true` | Full attempt history |
| `PATCH` | `/scheduled-jobs/:id` | Edit a pending or failed job |
| `DELETE` | `/scheduled-jobs/:id` | Delete pending job or mark non-pending as failed |
| `POST` (or any) | `/process-jobs` | Claim and execute pending jobs |

**Create/edit fields for recurring limits:**
```json
{
  "max_executions": 10,
  "expires_at": "2026-06-30T23:59:00Z"
}
```

`GET /scheduled-jobs` hides internal `workflow_resume` and `sequence_step` jobs by default. Pass `?internal=true` to include them.

---

## Calendar Service

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/isWorkday?date=...` | None | Check if datetime is a workday |
| `POST` | `/nextBusinessDay` | ✓ | Next available business day at target time |
| `POST` | `/prevBusinessDay` | ✓ | Best slot before an appointment date |

---

## Universal Resolver

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/resolve` | Resolve `{{table.column}}` placeholders |
| `GET` | `/resolve/tables` | List allowed tables |

**POST /resolve body:**
```json
{
  "text":   "Hi {{contacts.contact_fname}}, your appt is {{appts.appt_date|date:dddd MMMM Do}}.",
  "refs":   { "contacts": { "contact_id": 1001 }, "appts": { "appt_id": 456 } },
  "strict": false
}
```

**Response statuses (always HTTP 200 for content issues):**

| Status | Meaning | HTTP |
|--------|---------|------|
| `success` | All resolved | 200 |
| `partial_success` | Some unresolved | 200 |
| `failed` + `errorType: security` | Blocked column | 200 |
| `failed` + `errorType: missing_refs` | Ref missing for referenced table | 200 |
| `failed` + `errorType: query_error` | DB query failed | 200 |
| Malformed body | — | 400 |
| Server crash | — | 500 |

Checking the result:
```js
const result = await apiSend("/resolve", "POST", { text, refs });
if (result.errorType === 'security')     { /* blocked column */ }
if (result.errorType === 'missing_refs') { /* fix your refs */ }
if (result.status === 'partial_success') { /* use result.text, check result.unresolved */ }
if (result.status === 'success')         { /* result.text is fully resolved */ }
```