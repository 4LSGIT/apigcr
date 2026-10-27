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

**Who can manage hooks:** creating, editing, deleting, testing and reading a hook's logs needs the **automations.manage** capability (admin / IT / SU). Every staff user can still read the hook list (other pages' pickers use it), minus the authentication, filter and transform configs and the captured sample, and the Automation Activity feed. A hook's API key or HMAC secret is stored encrypted and shown decrypted only to holders.

When something doesn't fire when you expected:
1. Open the hook's **Logs** tab. Did the event arrive? What status?
2. `received` → queued for the drain or still running; normal for a second or two. Stuck longer than a minute → the `/process-jobs` sweep is not running (Scheduled Jobs heartbeat). A `received` row whose `error` says "re-queued for the next drain" found the code sandbox busy and will run again.
3. `filtered` → the filter rejected it. Look at `error` for why.
4. `partial` or `failed` → look at delivery logs for which target broke. A `failed` row with no delivery logs and an empty transform output means the transform itself failed — or the code filter could not run (`[GUEST_CODE_BUSY]`) — read `error`.
5. `captured` → the hook is in capture mode; see Capture Mode below.

---

## Technical reference

### Slug-based receiver

```
POST /hooks/:slug
```

Public endpoint, no `jwtOrApiKey` middleware. Auth is per-hook (configured on the hook row). Lives behind the `rawBody` middleware in `server.js` so HMAC validation can see the unmodified body.

**Response shapes** (what the sender sees):

```json
200 { "status": "received", "slug": "my-hook" }          // every normal path, incl. a duplicate delivery and an unknown slug routed to _catchall
200 { "status": "captured", "execution_id": 1234 }       // capture mode, this event was the capture (note snake_case)
200 (empty body, Validation-Token header echoed)          // RingCentral subscription handshake
401 { "status": "error", "message": "…" }                // per-hook auth failed (no execution row)
404 { "status": "error", "message": "Hook not found" }   // unknown slug and no _catchall hook
503 { "status": "error", "message": "…" } + Retry-After: 60   // maintenance, event could not be spooled
```

The outcome of the run — `delivered` / `partial` / `failed` / `filtered` / `captured` / `not_found`, with `executionId` — is `executeHook`'s **result**, not the HTTP response: Live Test and other in-process callers see it; a sender never does. Read it on the execution row in the Logs tab.

The receiver answers 200 **before anything runs** — see *Ack first, work after* below — so a dispatch error can never reach the sender; it should retry only on a non-200, which means our auth rejection or the slug not existing. One exception answers `503` + `Retry-After: 60`: maintenance mode when an event cannot be stored — see [During maintenance](#during-maintenance-write-freeze) below.

### Ack first, work after

Since 2026-10-27 the receiver does three things and answers: it writes the event to `hook_executions` (status `received` — **queued**), rings a Cloud Tasks doorbell for that row, and returns `{"status":"received"}` — about a tenth of a second, with no filter, transform or code body of ours in the way (the doorbell call itself gives up after 1.5 s if Google is slow; the sweep then runs the row). A moment later the doorbell lands on `POST /process-hook-execution/:id`, which **claims** the row and runs the whole pipeline (filter → transform → every target) inside its own request, at full CPU. If the doorbell never lands (Cloud Tasks off or down), the once-a-minute `/process-jobs` sweep finds the row (after a 20 s grace for a doorbell still in flight) and runs it — a doorbell that fails costs up to about 80 seconds, never the event.

Why: RingCentral requires the 200 within **3 seconds** and, after about 10 minutes of late or non-200 answers, **blacklists** the subscription silently (every RingCentral event lost until it is deleted and re-created — `manual/04-Integrations/03-rc-subscription-bootstrap.md`, Failure mode 4). Before this, a hook body that ran slowly (up to 15 s) or a saturated code sandbox made every RingCentral answer late for as long as it lasted. Now nothing a hook does can make the answer late.

What changes for you:

- In the **Logs** tab a fresh row reads `received` for a second or two, then flips to `filtered` / `delivered` / `failed` as usual. A row that stays `received` for more than a minute means the sweep is not running — check Scheduled Jobs' heartbeat.
- A workflow started by a hook begins one to two seconds later than before (the extra hop).
- **A busy code sandbox is no longer a failure.** A code filter or transform that gets no sandbox slot puts the row **back in the queue** (`received`, error tagged `[GUEST_CODE_BUSY]` and "re-queued for the next drain (attempt N of 3)") and the sweep runs it again a minute later, up to three attempts. No sender is asked to redeliver anything (the 2026-10-27 Quo `503` is gone).
- The claim is one conditional update, so a doorbell delivered twice, or racing the sweep, runs the event **once**. Test fires, Live Test and the maintenance replay run their row synchronously and mark it claimed at insert, so the sweep never touches them.
- If the server dies mid-run: a row claimed but still `received` (the filter never finished) is re-queued after 15 minutes (three times, then `failed`); a row in `processing` (the transform was written — targets may have fired) is marked `failed` and is **never re-run automatically** — its delivery logs say what ran; replay it by hand if needed. Both outcomes raise an error alert naming the rows.
- **Duplicate detection** (Filter tab → *Duplicate detection*): give the hook the path of the provider's event id — RingCentral `body.uuid`, Quo `body.id` — and a second delivery of the same event is answered 200 and **not recorded** (no row, nothing runs). Quo does redeliver (a handful of times a week, usually within seconds); RingCentral has not been seen to. Leave it blank to record every delivery. Live Test and a maintenance replay are never treated as duplicates — a replay is you asking for a re-run. **Treat the field as dangerous:** only ever a true per-event id. A path at a value that repeats across events (an event type, a line number) makes every later event a "duplicate" — answered 200, never recorded, no Logs-tab trace, and no time limit; the only evidence is a `duplicate delivery` warning in the Cloud Run log. If a hook with a path goes quiet, check that log line first.
- Rollback switch (Settings → platform): `hook_async_ack` = `0` restores the previous receiver, which ran the filter, transform and workflow start before answering (with the old 1 s sandbox wait per code body, whatever the lane's budget is). Use it only to roll back; it reintroduces the RingCentral exposure.

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
  INSERT hook_executions (status='received', claimed_at NULL)  ── queued
        │
        ▼
  ring the Cloud Tasks doorbell (he-{id}) ─► answer 200 {"status":"received"}
        ┆
        ┆  POST /process-hook-execution/:id (or the 60 s /process-jobs sweep)
        ▼
  CLAIM: UPDATE … SET claimed_at = NOW(3), attempts + 1
         WHERE id = ? AND status='received' AND claimed_at IS NULL   (0 rows → done, someone has it)
        │
        ▼
  runFilter(hook, input)
        │ false → UPDATE status='filtered', completed_at, return
        │ BUSY  → re-queue (status='received', claimed_at NULL) while attempts < 3, else failed
        ▼
  runTransform(mode, config, input)
        │ failed → UPDATE status='failed', error, transform_output=NULL, completed_at, return
        │ BUSY   → re-queue, as above
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
  UPDATE hook_executions status (+ completed_at):
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
| `code` | `{ "code": "return input.body.event === 'invoice.paid';" }` | A function body over `input`, run in the isolated code engine (below). Truthy return = pass; a throw or timeout = filtered (the body's own answer). If the filter could not run at all — "code sandbox busy" — the execution **fails** instead (below). |

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
  meta:    { source, received_at, remote_ip }   // optional, present on ingest-routed events
}
```

### Transform (`transform_mode`, `transform_config`)

| Mode | `transform_config` shape | Output |
|---|---|---|
| `passthrough` | — | The full input event, unchanged |
| `mapper` | Array of rules | A new object built from the rules |
| `code` | `{ "code": "return { ... };" }` | The object the function returns. A throw, a timeout, a "code sandbox busy" error, or a return that is not an object (`null`, nothing, a string) **fails the transform** — see below. `return {}` is an object and is delivered. |

**A failed transform delivers nothing.** Targets never receive an empty or half-built object in place of the real data:

- **Hook-level transform fails** → the execution is `failed`, its `error` says why, *Transform Output* is empty, and **no target runs**. The sender had its 200 long before.
- **A target's own transform fails** → that target is skipped and logged as a failed delivery (error `target transform failed (nothing delivered): …`) and ONE retry runs about 60 s later, re-running the transform. If the retry fails too, the delivery stays `failed` — there is no third attempt (see *Retry job* below). The other targets deliver as normal, so the execution reads `partial` (or `failed` if nothing delivered).
- **Mapper** → if every rule errors and nothing is mapped, that counts as failed. If some rules work, the partial result is delivered and the broken rules are listed in the execution's `error`.
- **Dry-run test** → shows the same outcome: `"status": "failed", "dry_run": true` with the error, or a target marked `"skip_reason": "target transform failed"` with its `transform_errors`.

To re-run a failed event once the cause is fixed (or the server is no longer busy): open the execution in the **Logs** tab, copy its *Raw Input* into the **Test** tab and click **Live Test**. That runs the whole pipeline again and delivers for real.

**Code filters and transforms** (hook- and target-level) run in an isolated JavaScript engine (QuickJS) in a separate, throwaway process — never inside the server. No `process`, `require`, `fetch`, timers, network or database, and **no `Intl`** (`toLocaleString` ignores `timeZone` silently — compute local times from UTC). `console.log` / `console.warn` reach the server log. 15 s and 64 MB per call (`GUEST_CODE_TIMEOUT_MS`). Hooks have a reserved share of sandboxes that triggers, ingest and editor tests cannot take, and vice versa. The dry-run test and the transform tester run the same engine as live deliveries.

**When the code sandbox is busy.** Each code filter or transform waits up to **10 s** for a free sandbox when the server is saturated (`GUEST_CODE_QUEUE_WAIT_MS_HOOKS`) — nobody is waiting on it, the sender was answered at receipt. Past that it fails closed with a "code sandbox busy" error and the body does not run; the row goes **back in the queue** and the sweep runs it again a minute later, up to three attempts (see *Ack first, work after*). The filter never counts as `filtered` for a busy sandbox, because no decision was made. On the last attempt the execution is `failed` (error tagged `[GUEST_CODE_BUSY]`, nothing delivered), stays in the execution history for a replay, and the alert sweep reports it as a warning (the sandbox's own saturation alert escalates). **A body that is slow to run** (up to 15 s) delays its own event and nothing else.

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

Synchronous INSERT, then step 1 is queued as a `workflow_resume` job (due now, with a Cloud Tasks push) — the run itself happens a moment later in its own request. The delivery log reads `queued` once the INSERT and the queueing succeed; a later failure inside the run does NOT trigger a hook retry — the execution row gets marked `'failed'` instead.

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

Call any of the built-in functions directly (see chapter 5).

```json
{
  "target_type": "internal_function",
  "name": "Create intake task",
  "config": {
    "function_name": "create_task",
    "params_mapping": {
      "assigned_to": 22,
      "title":       "task_title",
      "source":      "'intake'",
      "link_type":   "'contact'",
      "link_id":     "contact_id"
    }
  }
}
```

`params_mapping` builds the function's params from the transform output
(resolver: `resolveParamsMapping` in lib/actionDispatchers.js, mirrored in
services/hookService.js — same rules on every params_mapping surface):
- `'quoted'` string → literal (exactly one outer single-quote pair stripped)
- the exact string `$` → the whole transform output object
- any other string → dot-path into transform output (`contact.id`)
- any non-string JSON value (number, boolean, object, array) → passed through
  as-is — this is how numeric params like `assigned_to` are written

There is NO template form. A composed string ("New lead from …") is built in
the transform (mapper `template` rule, or code) and referenced by dot-path.

A bare-scalar STRING (`"22"`, `"true"`, `"null"`) is a dot-path lookup of a
key literally named that — undefined in every real config — and is rejected
at save time since 2026-09-22 (`__validateParamsMapping`; the trigger-rule-19
postmortem: a lossy editor round trip had turned stored numbers into strings,
silently breaking `create_task` while sibling actions kept succeeding).

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
2. Re-runs `deliverToTarget` against the stored `transform_output` (the target's own transform runs again)
3. Updates that target's latest `hook_delivery_logs` row in place (`attempts + 1`; the first attempt's response/error are overwritten), or inserts one with `attempts = 2` if none exists
4. On success, flips the parent `hook_executions.status` from failed/partial to `delivered` (or `partial` while another delivery is still failed)

**There is exactly ONE retry.** `executeRetry` records a failed attempt and returns normally, so the job is marked completed and nothing queues another; the `max_attempts: 3` / `backoff_seconds` above are never consulted for this job type. A delivery that fails its retry stays `failed`, and recovery is a replay of the execution (above).

**Retry safety per target type:**

| Target | Retry behavior |
|---|---|
| `http` | Each retry fires a fresh HTTP request — receiver must tolerate duplicates |
| `workflow` | INSERT-then-queue pattern. Retry re-INSERTs (creates a new execution). Failures inside the queued run do NOT trigger retries. Receivers may see duplicate workflow executions on retry. |
| `sequence` | `enrollContact` is guarded against duplicate active enrollments. A retry after a previously-successful enrollment throws "already enrolled" and is captured as a failure (the one retry, above). |
| `internal_function` | Not inherently idempotent. Side-effect functions will be invoked again. Design accordingly. |

There is no `no_retry: true` flag yet (planned for v1.3). Every failed delivery gets its one retry, and a job's `max_attempts` would not prevent it (above), so skipping the retry for a non-idempotent target needs a code change in `queueRetryJob`.

### Capture mode

Capture mode lets you record one real incoming event without dispatching anything — useful for setting up filter/transform rules against actual data.

**Lifecycle:**
1. Operator clicks **Arm capture** on the hook → `hooks.capture_mode = 'capturing'`
2. The next event that arrives at `/hooks/:slug`:
   - Wins the atomic UPDATE that flips `capture_mode = 'off'` and stores `captured_sample`
   - Inserts a `hook_executions` row with `status = 'captured'` (no filter/transform/delivery runs)
   - Returns `{ status: 'captured', execution_id, truncated }`
3. The captured sample stays in `hooks.captured_sample` until the operator overwrites it (with another capture) or manually clears.
   There is no dedicated endpoint to read it back — it comes down with `GET /api/hooks/:id` like any other column.
4. Future events fall through to the normal pipeline.

**Race safety:** the UPDATE is guarded — `WHERE id = ? AND capture_mode = 'capturing'`. If two events arrive in the same poll window, exactly one wins; the other falls through to normal routing (no double-capture, no double-pipeline).

**Dry-run never triggers capture.** The `!dryRun` guard is explicit.

**Truncation (known defect):** raw input is nominally capped at 512 KB, but the cap slices the JSON *string* at 512 KB — no longer valid JSON — and `raw_input` / `captured_sample` are JSON columns, so the INSERT/UPDATE fails (ERROR 3140). The receiver catches it and still answers 200: an event over 512 KB is **dropped silently, with no execution row**. Never hit in production (max observed `raw_input` is ~24 KB over 31k rows, 2026-10-12), but don't trust the old "stores the first 512 KB" behavior — it never happens. Fix options are queued in `ref/plans.md`.

### During maintenance (write freeze)

When the app runs with `MAINTENANCE_MODE=1` (a database move — `ref/INFRA_GCP.md` §9) every other route answers 503, but `POST /hooks/:slug` stays open so webhooks are not lost. It does **not** run the pipeline:

1. The hook is looked up and the sender authenticated exactly as usual (a bad key is still a 401; an unknown slug with no catch-all is still a 404).
2. The event — the same `{body, headers, query, method, meta}` object the pipeline would have received — is stored as a task on the paused Cloud Tasks queue `yc-hook-spool`. The sender gets the usual `200 {"status":"received"}`.
3. If the event could **not** be stored, the sender gets `503` + `Retry-After: 60`: there is nowhere else to put the event. This is the only time the receiver asks a sender to retry on our failure.

Nothing is written to the database during the window: no `hook_executions` row, no capture-mode flip (an armed hook stays armed), no deliveries.

After the window the queue is resumed and each stored event is POSTed to `/internal/hook-replay` (internal key only), which runs the normal pipeline. In the Logs tab a replayed execution is told apart by its raw input: `meta.spooled: true`, `meta.spool_id`, `meta.replayed_at`, and `meta.received_at` holding the **original** arrival time (the row's `created_at` is the replay time). Each event runs once — a redelivered task finds its `spool_id` already present and does nothing.

Things to expect after a window: workflows and sequences started by replayed events start at replay time, in roughly arrival order; anything that reads "now" inside a target sees the replay time, not the arrival time.

### Dry-run

`POST /api/hooks/:id/test` (with `{ "dryRun": true, "input": { ... } }`) runs the full pipeline against an arbitrary input without inserting `hook_executions`, without writing `hook_delivery_logs`, and without firing any side effects. Returns the would-be transform output and would-be delivery preview for each target.

Useful for testing hook config against captured samples — the UI's "Use captured sample" button feeds `hooks.captured_sample` into this endpoint.

### Internal alert convention

The removed Email Router used two well-known slugs — `router-unrouted-alert` and
`router-error-alert` — for operator alerts, opt-in by simply creating a hook with
that slug. The convention still holds for anything that wants it: if the hook
doesn't exist, `executeHook` returns `{ status: 'not_found' }` and the caller
silently no-ops, so an alert hook costs nothing until you create it.

Ingest does not use this pattern — its failures land in
`{email,phone}_ingest_executions` with a status, which is queryable and doesn't
need a throttle. See [chapter 10](10-ingest.md).

### Two parallel UIs (caveat)

Two pages drive the same backend:
- `automationManager.html` → Hooks tab — primary, integrated
- `yisraHook.html` — older standalone, redundant

Both edit the same `hooks` / `hook_targets` / `credentials` rows. The standalone is slated for removal; prefer `automationManager.html`.

### Routes (full list in chapter 11)

| Route | Purpose |
|---|---|
| `POST /hooks/:slug` | Public receiver |
| `POST /internal/hook-replay` | Cloud Tasks push target — replays one event captured during maintenance (internal key only) |
| `GET /api/hooks` | List hooks |
| `GET /api/hooks/:id` | Hook + targets |
| `POST /api/hooks` | Create |
| `PUT /api/hooks/:id` | Update (auto-bumps `version`) |
| `DELETE /api/hooks/:id` | Soft delete (hooks cascade their targets via FK) |
| `POST /api/hooks/:id/targets` | Add target |
| `PUT /api/hooks/targets/:id` | Update target — note the path is target-first, not nested under the hook |
| `DELETE /api/hooks/targets/:id` | Delete target |
| `POST /api/hooks/:id/test` | Dry-run with arbitrary input |
| `POST /api/hooks/:id/capture/start` | Arm capture mode |
| `POST /api/hooks/:id/capture/stop` | Cancel capture (preserves sample) |
| `GET /api/hooks/:id/executions` | Paginated execution log |
| `GET /api/hooks/executions/:id` | Single execution + delivery logs |
| `GET /api/credentials` etc. | Credential CRUD (shared with sequence webhook steps) |
