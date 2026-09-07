# 4 — System Alerts (SU)

## For operators

The red banner across the top of the app is counting **open system alerts**.
This screen is where you clear it: **More → System Alerts (SU)**.

### Why it doesn't clear itself

The sweep only ever auto-resolves **OAuth** alerts. Everything else —
`uncaught_exception`, `action_failed`, `route_500` — stays open forever and
keeps the banner up until a human deals with it.

That is deliberate. An uncaught exception that resolved itself on a timer would
be an uncaught exception nobody ever looked at. Before this screen existed, the
only way to clear one was manual SQL.

### Three states

| State | Means | Banner |
|---|---|---|
| **open** | Nobody has looked | **Counted** |
| **acked** | Someone has seen it and is on it | Not counted |
| **resolved** | Dealt with | Not counted |

Ack when you've seen it and it needs work. Resolve when it's actually handled.
Reopen puts it back to fully open if you were wrong.

### Filters

Status (default open), severity (`critical` / `error` / `warning`), source, and
a substring search across title, message and kind.

### How alerts get raised

Alerts are grouped by a **group key**, so a hundred repeats of the same failure
are one row with an occurrence count rather than a hundred rows.

- **Critical** attempts immediate, throttled delivery.
- **Everything else** waits for the sweep, which emails one grouped digest.

### The two delivery channels fail independently — on purpose

- **Email** uses plain SMTP and must **not** depend on the Connections/OAuth
  system.
- **SMS fallback** rides RingCentral, which *does* use Connections.

So an OAuth outage can still page you by email, and an SMTP outage can still
page you by SMS. If both are quiet, suspect something broader than either.

---

## Technical reference

### Files

```
lib/alerting.js                  alert() + runErrorSweep()
routes/admin.systemAlerts.js     This screen's API
routes/api.systemStatus.js       The banner's counts
public/systemAlerts.html         UI (iframed in the Admin tab)
```

### `alert(db, opts)` never throws

Fire-and-forget. Callers use it bare in error paths — including
`unhandledRejection` and `uncaughtException` handlers in `server.js` — so it
must never be the thing that fails.

### The sweep

`runErrorSweep(db, p)` runs every 15 minutes as the "Error Alert Sweep"
recurring job, and is exposed as the `run_error_sweep`
[internal function](../03-YisraFlow/05-internal-functions.md):

- **Phase A** scans the automation failure tables — watermarked — into
  `system_alerts`.
- **Phase B** emails **one** grouped digest of undigested rows.

### Status semantics

Mirrored exactly by `routes/api.systemStatus.js`, so the banner and this screen
can never disagree:

```sql
open     = resolved_at IS NULL AND acked_at IS NULL   -- what the banner counts
acked    = acked_at IS NOT NULL AND resolved_at IS NULL
resolved = resolved_at IS NOT NULL
```

### API

`superuserOnlyFor("system_alerts")` — JWT-authed SU humans only, rate-limited,
rejections audited. Every write is audited to `admin_audit_log` with
`tool='system_alerts'`.

| Route | Method | Purpose |
|---|---|---|
| `/admin/system-alerts` | GET | List + filter + summary counts. `status`, `severity`, `source`, `q`, `limit` (1–500, default 100), `offset` |
| `/admin/system-alerts/ack` | POST | `{ids:[…]}` → sets `acked_at` / `acked_by` |
| `/admin/system-alerts/resolve` | POST | `{ids:[…]}` → sets `resolved_at`, acking first if needed |
| `/admin/system-alerts/reopen` | POST | `{ids:[…]}` → clears ack and resolve |

### Tables

| Table | Holds |
|---|---|
| `system_alerts` | The rows |
| `alert_state` | Per-`group_key` first/last seen, `last_alerted_at` throttle, lifetime `occurrence_count` |
