# 10 — Email Router

## For operators

The Email Router is a **routing layer in front of YisraHook**. The firm's email adapter (Apps Script / SiteGround PHP / SES inbound parse) POSTs every inbound email to `/email-router`, and the router decides which hook to dispatch it to based on rules you configure.

It exists because it's cleaner to have **one URL for all incoming email** and let the router fan out to the right hook than to give each integration its own slug and adapter config.

A typical setup:

| If the email matches… | Route it to hook slug |
|---|---|
| Subject contains "intake form submitted" | `intake-form-inbound` |
| From `noreply@calendly.com` | `calendly-event-inbound` |
| From `*@court.gov` and subject contains "Order" | `court-order-inbound` |
| (catch-all) | `unrouted-inbound-debug` |

Each rule is a **route** — a name, a slug to dispatch to, and a match config. The router walks rules in order and uses the **first match** (lowest `position`).

You'd reach for the Email Router when:
- You want one inbound URL and per-rule fan-out
- The number of inbound email integrations is growing and giving each its own adapter config is fragile
- You want operator-friendly routing rules in the UI rather than code

You wouldn't reach for it when:
- A single hook is enough — point the adapter directly at that hook's slug
- The inbound source isn't email (use the hook directly)

**In `automationManager.html` → Email Router tab**, you'll see the singleton config (auth setup, capture-mode controls), the list of routes, and an executions log showing recent inbound emails and how they routed.

When something doesn't fire when you expected:
1. **Executions log** — was the email even received? Status `unrouted` means no rule matched.
2. **Route Match Test** — paste the email payload (or fetch the captured sample) and see which routes match. First match wins.
3. **Hook delivery logs** — once routed, it's the hook's responsibility. Open the resolved hook's Logs tab.

---

## Technical reference

### Files

```
services/emailRouter.js           Pipeline + route CRUD + capture mode
routes/api.email_router.js        HTTP endpoints
```

Database tables:

```
email_router_config       Singleton (id=1): auth_type, auth_config, capture_mode, captured_sample
email_routes              Route rules: name, slug, match_mode, match_config, position, active
email_router_executions   Per-event log: raw_input, matched_route_id, resolved_slug, hook_execution_id
```

### Pipeline

```
POST /email-router (adapter-side)
        │
        ▼
  Rate limit (60 req/min/IP)
        │
        ▼
  authenticateRequest(config, req) — 401 on fail
        │
        ▼
  Build unified event envelope { body, headers, query, method, meta }
        │
        ▼
  routeAndDispatch(db, input, { config })
        │
        ├─ CAPTURE-MODE INTERCEPT (atomic guarded UPDATE; halts pipeline on win)
        │
        ├─ findMatches(db, input) — iterate active routes by ascending position
        │
        ├─ no match? INSERT email_router_executions (status='unrouted'), return
        │
        └─ match? bump match counters, INSERT email_router_executions (status='routed'),
                  dispatch via hookService.executeHook(db, slug, input)
                  → on success: UPDATE email_router_executions.hook_execution_id
                  → on hook not_found: UPDATE status='error'
                  → on dispatch throw: UPDATE status='error'
        │
        ▼
  Always 200 to sender (even on internal failures — receiver convention).
  Fire-and-forget alert hooks (router-unrouted-alert, router-error-alert) on failure paths.
```

### Receiver

```
POST /email-router
```

Public endpoint, no `jwtOrApiKey`. Auth is configured on the singleton config row. **Always returns 200** to the sender (even on internal errors — the adapter shouldn't retry on our failures).

**Response shapes:**

```json
{ "status": "routed",   "execution_id": 1234, "slug": "calendly-inbound" }
{ "status": "unrouted", "execution_id": 1235 }
{ "status": "captured", "execution_id": 1236 }
{ "status": "error",    "message": "Internal error" }      // 200 with error status
{ "status": "error",    "message": "Invalid api key" }     // 401
```

**Rate limit:** 60 req/min/IP via `express-rate-limit`. Lower than hooks' 120/min/(slug+IP) because there's only one route here and the adapter has full bandwidth to it. Acts as a runaway-loop guardrail rather than per-sender throttling.

### Authentication

Configured on `email_router_config` (singleton row id=1):

| `auth_type` | `auth_config` shape | Notes |
|---|---|---|
| `none` | — | Anyone can POST. Don't use in production. |
| `api_key` | `{ "header": "x-router-key", "key": "..." }` | Default header `x-router-key`. Constant-time compare via `crypto.timingSafeEqual`. |

API key value is masked on read — `GET /api/email-router/config` returns `{ key_set: true, header: "x-router-key" }` rather than the raw key. The key is write-only after creation.

### Routes (rules)

Stored in `email_routes`:

```sql
id              int
name            varchar(120)         -- human-readable name
description     text                 -- optional
slug            varchar(100)         -- target hook slug
match_mode      enum('conditions','code')
match_config    json                 -- depends on match_mode
position        int      default 100 -- ordering; lower fires first
active          tinyint(1)
last_matched_at datetime
match_count     int                  -- bumped on every match (before dispatch)
last_modified_by int
created_at, updated_at
```

#### `match_mode: 'conditions'`

Same condition tree shape as YisraHook filters — handled by `hookFilter.evaluateConditions`.

```json
{
  "match": "all",
  "conditions": [
    { "field": "body.from.email",  "op": "==",       "value": "noreply@calendly.com" },
    { "field": "body.subject",     "op": "contains", "value": "scheduled" }
  ]
}
```

Field paths address the unified event envelope:
- `body.*` — the email JSON the adapter posts
- `headers.*` — request headers (lowercase keys)
- `query.*` — query string
- `meta.*` — `{ source, received_at, remote_ip }`

Operators: `==`, `!=`, `contains`, `not_contains`, `in`, `not_in`, `is_empty`, `is_not_empty`, `regex`, `>`, `<`, `>=`, `<=`.

#### `match_mode: 'code'`

```json
{ "code": "return input.body.subject?.toLowerCase().includes('intake');" }
```

Run as `new Function('input', code)`. Truthy return = match.

### First-match wins

`findMatches` iterates active routes by ascending `position` (then by `id`). The **first match** is dispatched. The function also returns the full match list for `match-test` — the live behavior is still first-wins, but the operator can see every overlapping rule when authoring routes.

To force a route to win over others, give it a lower `position`. Default is `100`. Conventional: catch-all routes at `1000`+, specific routes at `10`–`100`.

### Match counters

When a route matches, **before dispatch**:

```sql
UPDATE email_routes
   SET last_matched_at = NOW(),
       match_count     = match_count + 1
 WHERE id = ?
```

Once a route is "decided," it counts as a match even if downstream dispatch fails. This makes the counters useful for "is this rule still being hit" without confusing them with delivery success.

### Dispatch to hook

The matched route's `slug` is passed to `hookService.executeHook(db, slug, input)`. The full unified event envelope (`{body, headers, query, method, meta}`) becomes the hook's input — exactly the same shape it would see if posted directly to `/hooks/:slug`.

The router then updates `email_router_executions.hook_execution_id` with the hook's execution ID — joining the two logs. `GET /api/email-router/executions/:id` returns the router execution row plus the linked hook execution and delivery logs.

**Failure cases:**

| Hook returned | Router status |
|---|---|
| `{ executionId: N, ... }` (any non-error) | `routed` (router-side); hook execution status reflects pipeline result |
| `{ status: 'not_found' }` | `error` — slug doesn't exist or hook is inactive |
| Throws | `error` — caught and logged; alert hook fired |

### Internal alert hooks

When the router can't deliver — no route matched, slug not found, dispatch threw — it fires one of two well-known hook slugs *if those hooks exist*. If they don't, executeHook returns `{ status: 'not_found' }` and the router silently no-ops.

| Slug | Fires when |
|---|---|
| `router-unrouted-alert` | An email matched no active route |
| `router-error-alert` | The resolved slug isn't an active hook, OR dispatch rejected, OR receiver threw |

To opt in, create a hook with one of these slugs and configure its targets (e.g. SMS Stuart, Slack a channel, append to a Google Doc).

#### Per-sender throttling

To prevent alert storms from misconfigured senders, each alert is throttled per `(slug, sender_email)` pair. Sender key falls through:
1. `body.from.email` (when from is `{ email, name }`)
2. `body.envelope.sender`
3. `(unknown)` (junk gets one bucket, not infinite buckets)

**Default window:** 1 hour. Override with `ROUTER_ALERT_THROTTLE_MS` env (in milliseconds).

```
ROUTER_ALERT_THROTTLE_MS=1800000   # 30 min
ROUTER_ALERT_THROTTLE_MS=14400000  # 4 hours
```

#### Cloud Run multi-instance caveat

The throttle map is in-process — each Cloud Run instance has its own copy. Under concurrent load, the same sender may alert N times within one window (once per instance). This is a deliberate trade-off; the alternative is a DB-backed throttle that adds query latency to every event in the alert path. For the firm's volume, in-process is fine. Revisit if alert noise becomes a real problem in production.

### Capture mode

Same shape as hooks — atomic guarded UPDATE on the singleton config row. One-shot capture, sample preserved across capture cycles.

```
POST /api/email-router/capture/start         → capture_mode='capturing'
POST /api/email-router/capture/stop          → capture_mode='off' (preserves captured_sample)
GET  /api/email-router/captured-sample       → returns the stored sample
```

When armed, the next inbound event:
1. Wins the atomic UPDATE that stores `captured_sample`, sets `captured_at`, and flips `capture_mode='off'`
2. Inserts an `email_router_executions` row with `status='captured'`
3. Halts — no route matching, no dispatch

Use the captured sample to author routes against real data. The match-test endpoint can pull from it directly.

### Match-test

Match-only preview. Doesn't dispatch, doesn't log to `email_router_executions`.

```
POST /api/email-router/match-test
{ "use_captured_sample": true }

OR

POST /api/email-router/match-test
{ "input": { "body": { ... } } }   // raw email JSON OR full envelope (auto-unwrap)
```

Returns:

```json
{
  "status":  "success",
  "matched": true,
  "first_match": { "id": 5, "name": "Calendly", "slug": "calendly-inbound", "position": 50 },
  "all_matches": [
    { "id": 5,  "name": "Calendly",  "slug": "calendly-inbound", "position": 50 },
    { "id": 99, "name": "Catch-all", "slug": "unrouted-debug",   "position": 1000 }
  ]
}
```

`first_match` is what the live receiver would dispatch. `all_matches` is for the operator — useful when reordering rules or finding overlapping conditions.

### Full preview (match + hook dry-run)

```
POST /api/email-router/preview
{ "use_captured_sample": true }
```

Same as match-test, plus runs the matched hook's dry-run pipeline and returns the would-be transform output and per-target previews. Useful for checking the entire route → hook chain against a captured sample before going live.

### Smart-unwrap helper

Both `preview` and `match-test` accept either:
- The unified envelope `{ body, headers, query, method, meta }` — passed through unchanged
- Raw email JSON — wrapped automatically as `{ body: <raw>, headers: {}, query: {}, method: 'POST', meta: { source: 'email', received_at: NOW } }`

Detected by presence of the `meta` key. Lets the UI pass either a captured sample (already wrapped) or a pasted raw payload without juggling envelopes.

### Truncation

`raw_input` stored in `email_router_executions` is capped at 512 KB. If exceeded:
- The stored row gets the first 512 KB
- The `error` field shows `raw_input truncated (>512KB)`
- Pipeline still proceeds (no block)

### Routes (full list in chapter 11)

| Route | Auth | Purpose |
|---|---|---|
| `POST /email-router` | api_key (router config) | Public receiver |
| `GET /api/email-router/routes` | jwt | List route rules |
| `GET /api/email-router/routes/:id` | jwt | Single rule |
| `POST /api/email-router/routes` | jwt | Create rule |
| `PUT /api/email-router/routes/:id` | jwt | Update |
| `DELETE /api/email-router/routes/:id` | jwt | Delete |
| `GET /api/email-router/config` | jwt | Singleton config (api_key masked) |
| `PUT /api/email-router/config` | jwt | Update auth config |
| `POST /api/email-router/capture/start` | jwt | Arm capture mode |
| `POST /api/email-router/capture/stop` | jwt | Cancel (preserves sample) |
| `GET /api/email-router/captured-sample` | jwt | Last captured payload |
| `POST /api/email-router/preview` | jwt | Match + hook dry-run |
| `POST /api/email-router/match-test` | jwt | Match-only preview, all matches |
| `GET /api/email-router/executions` | jwt | Paginated log |
| `GET /api/email-router/executions/:id` | jwt | Single execution + linked hook execution + delivery logs |
