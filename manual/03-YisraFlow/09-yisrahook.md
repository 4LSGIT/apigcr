# 9 — YisraHook

## For operators

YisraHook is the firm's built-in webhook receiver. When an external service — Calendly, JotForm, a payment processor, a Pabbly bridge — needs to *trigger* something inside YisraCase, you build a hook for it.

A hook is a recipe with four parts:

1. **Auth** — how do we verify the caller is who they say they are
2. **Filter** — should we even process this event, or ignore it
3. **Transform** — reshape the incoming payload into a canonical shape we control
4. **Targets** — what to do with the result (one or many)

Each hook has a unique slug. The receiver URL is `/hooks/<slug>`.

You'd reach for a hook when:
- An outside service should kick off internal automation
- You want to centralize one shape per integration so Calendly, JotForm, and Pabbly all feed clean data into the same workflow
- You need a stable URL you can configure once and forget

You wouldn't reach for one when:
- The trigger is internal (use `/scheduled-jobs`, `/workflows/:id/start`, or `/sequences/enroll` directly)
- You don't control the source's payload shape and you don't want to do any reshaping (then a passthrough hook is *fine* — just be aware your downstream targets see the raw data)

**In `automationManager.html` → Hooks tab**, you'll see the list of hooks on the left. Click one to see auth/filter/transform/targets. Each hook has a Logs tab showing recent executions — every received event, what filter said, the transform output, and per-target delivery results.

When something doesn't fire when you expected:
1. Open the hook's **Logs** tab. Did the event arrive? What status?
2. `received` → still processing or stuck. Check Scheduled Jobs for `hook_retry`.
3. `filtered` → the filter rejected it. Look at `error` for why.
4. `partial` or `failed` → look at delivery logs for which target broke.
5. `captured` → the hook is in capture mode; see Capture Mode below.

---

## Technical reference

### Slug-based receiver

```
POST /hooks/:slug
```

Public endpoint, no `jwtOrApiKey` middleware. Auth is per-hook (configured on the hook row). Lives behind the `rawBody` middleware in `server.js` so HMAC validation can see the unmodified body.

**Response shapes:**

```json
{ "status": "delivered", "executionId": 1234 }     // all active targets succeeded
{ "status": "partial",   "executionId": 1234 }     // some succeeded, some queued for retry
{ "status": "failed",    "executionId": 1234 }     // all active targets failed
{ "status": "filtered",  "executionId": 1234 }     // event matched no filter conditions
{ "status": "captured",  "execution_id": 1234 }    // capture mode hit (note snake_case)
{ "status": "not_found" }                          // no hook with that slug, or inactive
```

The receiver always returns 200 even on dispatch errors — the sender shouldn't retry on our internal failures (they should retry only on a non-200, which means our auth rejection or the slug not existing).

### Pipeline

```
POST /hooks/:slug
        │
        ▼
  getHookBySlug(slug) — load hook + active targets
        │
        ▼
  CAPTURE-MODE INTERCEPT — atomic guarded UPDATE; halts pipeline on win
        │
        ▼
  authenticateRequest(hook, req) — 401 on fail
        │
        ▼
  INSERT hook_executions (status='received')
        │
        ▼
  runFilter(hook, input)
        │ failed → UPDATE status='filtered', return
        ▼
  runTransform(mode, config, input)
        │
        ▼  UPDATE status='processing', transform_output=...
        │
        ▼
  for each target ordered by position:
        ├─ evaluate target-level conditions (against transform output, not raw input)
        ├─ deliverToTarget(target, transformOutput, db)
        │     → http               (deliverHttp)
        │     → workflow           (deliverWorkflow)
        │     → sequence           (deliverSequence)
        │     → internal_function  (deliverInternalFunction)
        ├─ INSERT hook_delivery_logs
        └─ on failure: queueRetryJob (hook_retry scheduled job)
        │
        ▼
  UPDATE hook_executions status:
        delivered | partial | failed | filtered | captured
```

### Authentication (`auth_type`, `auth_config`)

Three modes:

| Mode | `auth_config` shape | What it checks |
|---|---|---|
| `none` | `null` | Anyone can POST. Use only for staging or internal-only slugs. |
| `api_key` | `{ "header": "x-hook-key", "key": "..." }` | Constant-time compare against the named header. Default header `x-hook-key`. |
| `hmac` | `{ "header": "x-hook-signature", "algo": "sha256", "secret": "...", "encoding": "hex"\|"base64" }` | HMAC of the raw body using the secret; constant-time compare. Requires `rawBody` middleware (already in `server.js`). |

API key mismatch returns 401. HMAC mismatch returns 401. Both write to the audit log via the standard auth middleware.

### Filter (`filter_mode`, `filter_config`)

| Mode | `filter_config` shape | Behavior |
|---|---|---|
| `none` | — | All events pass |
| `conditions` | AND/OR group tree (see below) | Evaluated by `hookFilter.evaluateConditions` |
| `code` | `{ "code": "return input.body.event === 'invoice.paid';" }` | Run as a `new Function(input)`. Truthy return = pass. |

#### Conditions tree

```json
{
  "match": "all",                      // "all" (AND) or "any" (OR)
  "conditions": [
    { "field": "body.event_type", "op": "==", "value": "invitee.created" },
    { "field": "body.payload.invitee.email", "op": "is_not_empty" }
  ]
}
```

Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `not_contains`, `in`, `not_in`, `is_empty`, `is_not_empty`, `regex`.

Nested groups supported — a `condition` can itself be another `{ match, conditions }` block.

**`field`** uses dot-paths into the input event. The input event has shape:

```js
{
  body:    { /* parsed JSON body */ },
  headers: { /* lowercased keys */ },
  query:   { /* query string */ },
  method:  "POST",
  meta:    { source, received_at, remote_ip }   // optional, present for email-router-routed events
}
```

### Transform (`transform_mode`, `transform_config`)

| Mode | `transform_config` shape | Output |
|---|---|---|
| `passthrough` | — | The full input event, unchanged |
| `mapper` | Array of rules | A new object built from the rules |
| `code` | `{ "code": "return { ... };" }` | Whatever the function returns |

#### Mapper rules

Three rule types:

```json
[
  { "to": "contact_email", "from": "body.payload.invitee.email" },
  { "to": "contact_phone", "from": "body.payload.invitee.questions[0].answer", "default": "" },
  { "to": "case_id",       "value": 123 },
  { "to": "subject",       "template": "Lead from {{body.payload.event_type}}" }
]
```

| Rule type | Field | Meaning |
|---|---|---|
| `from` | dot-path (with array indexing) | Pull the value from this path in the input |
| `value` | literal | Hardcoded constant — string, number, bool, null, object, array |
| `template` | string with `{{body.x}}` placeholders | Build a string from input paths |

`default:` on any rule provides a fallback when the source resolves to undefined or null.

### Targets — four types

Stored in `hook_targets`. Multiple targets per hook, ordered by `position`. Each target has its own optional `conditions` (evaluated against the *transform output*, not the raw input).

#### `target_type: 'http'`

The original behavior. Fetch a URL.

```json
{
  "target_type": "http",
  "name": "Notify Slack",
  "method": "POST",
  "url": "https://hooks.slack.com/services/...",
  "credential_id": null,
  "headers": { "X-Source": "yisracase" },
  "body_mode": "transform_output",         // or "template"
  "body_template": null
}
```

`body_mode: "transform_output"` sends the transform output as JSON.
`body_mode: "template"` sends the resolved `body_template` string (the template can use `{{body.x}}` style placeholders against the transform output).

**Credential injection** — set `credential_id` to a row in `credentials`. The credential's auth headers are merged in at delivery time. URL scoping via `credentials.allowed_urls` blocks delivery if the target URL doesn't match the scope.

#### `target_type: 'workflow'`

Start a workflow execution.

```json
{
  "target_type": "workflow",
  "name": "Start intake workflow",
  "config": { "workflow_id": 12 }
}
```

The transform output becomes `init_data`. `workflow_executions.contact_id` is resolved from the workflow template's `default_contact_id_from` setting against the transform output. No explicit override on this path — if you need that flexibility, use the workflow's `default_contact_id_from` to point at a known field (e.g. `"contact_id"` or `"contactId"`).

Synchronous INSERT, fire-and-forget `advanceWorkflow()`. Hook delivery is logged as success once the INSERT succeeds; a background failure in `advanceWorkflow` does NOT trigger a hook retry — the execution row gets marked `'failed'` instead.

#### `target_type: 'sequence'`

Enroll a contact in a sequence.

```json
{
  "target_type": "sequence",
  "name": "Enroll in lead drip",
  "config": {
    "template_type": "lead_drip",
    "appt_type_filter": null,
    "appt_with_filter": null,
    "contact_id_field": "contact_id",
    "trigger_data_fields": ["case_id", "appt_id", "source"]
  }
}
```

Two modes (mutually exclusive — validation rejects both at save time):
- `template_type` set → `enrollContact` (cascade match by type, with optional appt_type/appt_with filters)
- `template_id` set → `enrollContactByTemplateId` (direct, no cascade)

`contact_id_field` is a dot-path into the transform output (default `"contact_id"`). `trigger_data_fields` is an array of dot-paths to extract into the enrollment's `trigger_data`. Both are dot-path-aware — `"body.contactId"` works on a passthrough hook without needing a mapper.

If `contact_id` resolves to null/missing, delivery fails (logged with error `sequence target: missing contact_id from transform field "..."`).

#### `target_type: 'internal_function'`

Call any of the 23 functions directly.

```json
{
  "target_type": "internal_function",
  "name": "Create intake task",
  "config": {
    "function_name": "create_task",
    "params_mapping": {
      "task_to":      "user_id",
      "task_about":   { "template": "New lead from {{body.source}}" },
      "task_link_id": "contact_id"
    }
  }
}
```

`params_mapping` builds the function's params from the transform output:
- String value → dot-path into transform output
- `{ "template": "..." }` → resolved template string
- `{ "value": ... }` → literal

**Not inherently idempotent.** Functions with side effects (`create_task`, `send_sms`, `create_appointment`) will be invoked again on retry. Make hooks targeting these functions safe-to-retry, or accept that transient failures may cause duplicate actions. See *Retry semantics* below.

### Target-level conditions

Each target has an optional `conditions` JSON column that's evaluated against the **transform output** (not raw input). Same shape as the hook's filter.

Use this to fan out one event into different targets based on payload content:

```json
// Target 1: only fire workflow target if event_type == "invitee.created"
{ "match": "all", "conditions": [{ "field": "event_type", "op": "==", "value": "invitee.created" }] }

// Target 2: only fire sequence enrollment if appt_type == "Strategy Session"
{ "match": "all", "conditions": [{ "field": "appt_type", "op": "==", "value": "Strategy Session" }] }
```

A target whose conditions don't pass is logged as skipped and contributes neither success nor failure to the execution status.

### Retry job (`hook_retry`)

When a target's delivery fails, the service queues a `hook_retry` scheduled job:

```js
type:            'hook_retry'
scheduled_time:  NOW() + 60 seconds
max_attempts:    3
backoff_seconds: 120
data:            { execution_id, target_id }
```

`/process-jobs` picks it up, calls `hookService.executeRetry(db, data)`, which:
1. Loads the original execution and target
2. Re-runs `deliverToTarget` against the stored `transform_output`
3. Inserts a fresh `hook_delivery_logs` row
4. If still failing and attempts remaining → another `hook_retry` queued
5. Updates the parent `hook_executions.status` (delivered/partial/failed) based on the latest state

**Retry safety per target type:**

| Target | Retry behavior |
|---|---|
| `http` | Each retry fires a fresh HTTP request — receiver must tolerate duplicates |
| `workflow` | INSERT-then-advance pattern. Retry re-INSERTs (creates a new execution). Async advance failures do NOT trigger retries. Receivers may see duplicate workflow executions on retry. |
| `sequence` | `enrollContact` is guarded against duplicate active enrollments. A retry after a previously-successful enrollment throws "already enrolled" and is captured as a failure (bounded by `max_attempts`). |
| `internal_function` | Not inherently idempotent. Side-effect functions will be invoked again. Design accordingly. |

There is no `no_retry: true` flag yet (planned for v1.3). For now, if you have a non-idempotent target, set `max_attempts: 1` on the retry queueing path — though that's currently hardcoded in `queueRetryJob` and would need a code change.

### Capture mode

Capture mode lets you record one real incoming event without dispatching anything — useful for setting up filter/transform rules against actual data.

**Lifecycle:**
1. Operator clicks **Arm capture** on the hook → `hooks.capture_mode = 'capturing'`
2. The next event that arrives at `/hooks/:slug`:
   - Wins the atomic UPDATE that flips `capture_mode = 'off'` and stores `captured_sample`
   - Inserts a `hook_executions` row with `status = 'captured'` (no filter/transform/delivery runs)
   - Returns `{ status: 'captured', execution_id, truncated }`
3. The captured sample stays in `hooks.captured_sample` until the operator overwrites it (with another capture) or manually clears.
4. Future events fall through to the normal pipeline.

**Race safety:** the UPDATE is guarded — `WHERE id = ? AND capture_mode = 'capturing'`. If two events arrive in the same poll window, exactly one wins; the other falls through to normal routing (no double-capture, no double-pipeline).

**Dry-run never triggers capture.** The `!dryRun` guard is explicit.

**Truncation:** raw input is capped at 512 KB. If exceeded, the truncation flag is returned and the captured row's `raw_input` field shows the first 512 KB. The pipeline does not block on oversized payloads; it just stores a truncated copy.

### Dry-run

`POST /api/hooks/:id/test` (with `{ "dryRun": true, "input": { ... } }`) runs the full pipeline against an arbitrary input without inserting `hook_executions`, without writing `hook_delivery_logs`, and without firing any side effects. Returns the would-be transform output and would-be delivery preview for each target.

Useful for testing hook config against captured samples — the UI's "Use captured sample" button feeds `hooks.captured_sample` into this endpoint.

### Internal alert convention

Two well-known slugs are used by the Email Router (chapter 10) for operator alerts:

| Slug | Fires when | Throttled |
|---|---|---|
| `router-unrouted-alert` | An inbound email matched no route | Per-sender, default 1h |
| `router-error-alert` | Receiver threw, hook lookup failed, dispatch rejected | Per-sender, default 1h |

If the hook doesn't exist, `executeHook` returns `{ status: 'not_found' }` and the router silently no-ops. To opt in, just create a hook with one of those slugs.

### Two parallel UIs (caveat)

Two pages drive the same backend:
- `automationManager.html` → Hooks tab — primary, integrated
- `yisraHook.html` — older standalone, redundant

Both edit the same `hooks` / `hook_targets` / `credentials` rows. The standalone is slated for removal; prefer `automationManager.html`.

### Routes (full list in chapter 11)

| Route | Purpose |
|---|---|
| `POST /hooks/:slug` | Public receiver |
| `GET /api/hooks` | List hooks |
| `GET /api/hooks/:id` | Hook + targets |
| `POST /api/hooks` | Create |
| `PUT /api/hooks/:id` | Update (auto-bumps `version`) |
| `DELETE /api/hooks/:id` | Soft delete (hooks cascade their targets via FK) |
| `POST /api/hooks/:id/targets` | Add target |
| `PUT /api/hooks/:id/targets/:targetId` | Update target |
| `DELETE /api/hooks/:id/targets/:targetId` | Delete target |
| `POST /api/hooks/:id/test` | Dry-run with arbitrary input |
| `POST /api/hooks/:id/capture/start` | Arm capture mode |
| `POST /api/hooks/:id/capture/stop` | Cancel capture (preserves sample) |
| `GET /api/hooks/:id/captured-sample` | Last captured payload |
| `GET /api/hooks/:id/executions` | Paginated execution log |
| `GET /api/hooks/executions/:id` | Single execution + delivery logs |
| `GET /api/credentials` etc. | Credential CRUD (shared with sequence webhook steps) |
