# Part 9 — API Reference

All endpoints require JWT or API key authentication unless noted. Authentication is handled by `jwtOrApiKey` middleware.

---

## Workflow Engine

### Workflow Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/workflows` | List all workflows |
| `GET` | `/workflows/:id` | Get workflow + steps |
| `POST` | `/workflows` | Create workflow |
| `POST` | `/workflows/bulk` | Create workflow + all steps in one call |
| `PUT` | `/workflows/:id` | Update name/description |
| `DELETE` | `/workflows/:id` | Delete workflow + steps |
| `POST` | `/workflows/:id/duplicate` | Duplicate workflow + steps |

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

### Workflow Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workflows/:id/start` | Start an execution |
| `GET` | `/executions` | List all executions |
| `GET` | `/executions/:id` | Single execution |
| `GET` | `/executions/:id?history=true` | Execution + step history |
| `GET` | `/workflows/:id/executions` | All executions for a workflow |
| `POST` | `/executions/:id/cancel` | Cancel a running execution |

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

### Template Steps

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sequences/templates/:id/steps` | Add step |
| `PUT` | `/sequences/templates/:id/steps/:stepNumber` | Full replace |
| `PATCH` | `/sequences/templates/:id/steps/:stepNumber` | Partial update |
| `DELETE` | `/sequences/templates/:id/steps/:stepNumber` | Delete + renumber |

### Enrollments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sequences/enroll` | Enroll a contact |
| `POST` | `/sequences/cancel` | Cancel sequences for a contact |
| `GET` | `/sequences/enrollments` | List enrollments (query: `contact_id`, `template_type`, `status`) |
| `GET` | `/sequences/enrollments/:id` | Single enrollment + step log |
| `POST` | `/sequences/enrollments/:id/cancel` | Cancel one enrollment |

**Enroll body:**
```json
{
  "contact_id":    123,
  "template_type": "no_show",
  "trigger_data":  { "appt_id": 456, "appt_time": "2026-03-20T14:00:00Z" }
}
```

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