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

**Cancel reason.** `POST /executions/:id/cancel` now requires `{ reason: string }` (min 3 chars). No existing callers — `contact2.html` Part B is the first — so this is a hard 400 with no back-compat shim.

### Workflow Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workflows/:id/start` | Start an execution. Body: `{ init_data?, contact_id? }` — `contact_id` is an optional positive integer honored **only** when the body is wrapped (`{ init_data: {...}, contact_id: N }`). Flat-body callers (`{ anyField: val }`) are backward-compatible and rely on the template's `default_contact_id_from` instead. Precedence: explicit body `contact_id` > `workflows.default_contact_id_from` init_data lookup > NULL. |
| `GET` | `/executions` | List all executions |
| `GET` | `/executions/:id` | Single execution |
| `GET` | `/executions/:id?history=true` | Execution + step history |
| `GET` | `/workflows/:id/executions` | Paginated executions for a workflow. Query: `?limit` (default 50, max 200), `?offset` (default 0), `?status`. Response: `{ success, executions, total }`. |
| `POST` | `/executions/:id/cancel` | Cancel a running execution. **Body required**: `{ reason: string }` (min 3 chars after trim, max 500; rejected with 400 otherwise). Reason is stored in `workflow_executions.cancel_reason`. Sets status=cancelled and deletes pending `workflow_resume` jobs for the execution. |
| `GET` | `/api/contacts/:id/workflows` | Slice 4.3 Part B. Paginated workflow executions tied to a contact via `workflow_executions.contact_id`. Query: `?limit` (default 50, max 200), `?offset` (default 0), `?status` (full workflow enum), `?scope` (`active` default — returns non-terminal: active/processing/delayed — or `all`). Response: `{ success, workflows, total, active_total }`. 404 if contact not found. |

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
| `POST` | `/sequences/templates` | Create template |
| `PUT` | `/sequences/templates/:id` | Update template |
| `DELETE` | `/sequences/templates/:id` | Delete (blocked if active enrollments) |
| `POST` | `/sequences/templates/:id/duplicate` | Duplicate template + steps (created inactive) |
> **Note:** `type` is optional. Templates without a type cannot be cascade-matched via `POST /sequences/enroll` with `template_type` — they are reachable only by `template_id` (direct enrollment).

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

### Enrollments

### Enrollments
 
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sequences/enroll` | Enroll a contact |
| `POST` | `/sequences/cancel` | Cancel sequences for a contact |
| `GET` | `/sequences/enrollments` | List enrollments (query: `contact_id`, `template_type`, `status`) |
| `GET` | `/sequences/enrollments/:id` | Single enrollment + step log. Add `?history=true` for a scheduled_jobs-derived step history joined with `sequence_step_log`. |
| `GET` | `/sequences/templates/:id/enrollments` | Paginated enrollments for a template. Query: `?limit` (default 50, max 200), `?offset` (default 0), `?status`. Response: `{ success, enrollments, total }`. |
| `POST` | `/sequences/enrollments/:id/cancel` | Cancel one enrollment |

**Enroll body:**
```json
{
  "contact_id":    123,
  "template_type": "no_show",
  "trigger_data":  { "appt_id": 456, "appt_time": "2026-03-20T14:00:00Z" }
}
```

Alternative — target a specific template directly by ID (skips type-cascade matching; `appt_type` / `appt_with` are not accepted in this mode):

```json
{
  "contact_id":  123,
  "template_id": 42,
  "trigger_data": { "appt_id": 456 }
}
```

Exactly one of `template_type` or `template_id` must be provided.

**Cancel body:**
```json
{
  "contact_id":    123,
  "template_type": "no_show",
  "reason":        "new_appointment_booked"
}
```
Omit `template_type` to cancel all active sequences for the contact.

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

###this doesnt belong here, but has no home!
| Method | Path | Query | Response |
|---|---|---|---|
| `GET` | `/api/contacts/:id/sequences` | `?limit` (default 50, max 200), `?offset`, `?status=active\|completed\|cancelled`, `?scope=active\|all` (default `active`; ignored when `?status` is set) | `{ success, sequences, total, active_total }` — row shape: `enrollment_id, template_id, template_name, template_type, status, current_step, total_steps, cancel_reason, enrolled_at, completed_at, updated_at`. `active_total` is always the unfiltered count of `status='active'` for this contact, so the UI can render "N active of M total" when `?scope=all`. |