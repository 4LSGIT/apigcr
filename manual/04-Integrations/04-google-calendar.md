# 4 — Google Calendar

## For operators

YisraCase can read and write Google Calendar events directly — create an event, look one up, change it, or delete it. This is the native replacement for the old Pabbly bridge (which forwarded `gcal_create` / `gcal_delete` to a Zap). Appointment calendar sync now runs through this integration directly; the Pabbly path for calendar has been retired.

There are two ways the firm uses it:

- **From automations** — a workflow, sequence, scheduled job, or hook target can call one of four built-in functions (`gcal_create_event`, `gcal_get_event`, `gcal_update_event`, `gcal_delete_event`) the same way it calls "send SMS" or "create task." You pick the function from the action dropdown and fill in the form.
- **From the API / other code** — the `/api/gcal/...` endpoints, used by other parts of the app and available for manual testing.

**Which Google account?** Calendar access rides on a single OAuth connection in **Connections** (chapter 15) — the Google Workspace credential that has been authorized with the calendar permission. Whatever calendars that account owns or has been given edit access to are the calendars YisraCase can write to.

**Which calendar?** By default, events go on that account's **primary** calendar. You can send any event to a different calendar — a shared "341 Hearings" calendar, an attorney's personal calendar, etc. — by giving its calendar ID. You can either set one firm-wide default calendar, or pick per event. See "Choosing a calendar" below.

**One-time setup gotcha.** The Google connection's allowed-URL list must permit the Calendar API host. If calendar actions fail with a message about being "out of allowed_urls scope," that's the cause — see the Setup section. This is a settings fix, not a code problem.

---

## Technical reference

### Files

| File | Role |
|---|---|
| `services/gcalService.js` | All logic. CRUD over the Google Calendar API v3 plus calendar discovery. |
| `routes/api.gcal.js` | Thin REST wrapper over the service. Auto-mounted by the routes loader. |
| `lib/internal_functions.js` | Four thin `gcal_*` functions (category `calendar`) wrapping the service. |
| `services/apptService.js` | Appointment lifecycle — calls `gcalService` on create / cancel / reschedule; owns the `appt_gcal` write-back and throttled IT failure alerts. |
| `lib/credentialInjection.js` | Supplies the OAuth Authorization header (`buildHeadersForCredential`). |
| `services/oauthService.js` | Token refresh behind the header builder. |

The service is the single source of truth; the route and the internal functions are both thin wrappers, consistent with the rest of the codebase.

### Auth model

Outbound requests authenticate with an **oauth2** credential row (Connections, chapter 15) whose scopes include `https://www.googleapis.com/auth/calendar`. Headers are built with the **async** `buildHeadersForCredential(db, credentialId, url)` — never the sync `buildAuthHeaders`, which returns `{}` for oauth2 and breaks silently (the recurring trap documented in chapter 15 and AI_CONTEXT §21).

The service computes the Calendar API URL, builds the header (refreshing the token inline if it is within 120s of expiry), and issues the request with a 15s timeout. A missing `Authorization` header — meaning the credential is not `connected`, or the URL failed the `allowed_urls` scope check — is surfaced as a thrown Error with a message that names the likely cause.

### Choosing the credential and calendar

Both are resolved **params-first, then `app_settings`, then a hard default**:

| | Resolution order | Hard default |
|---|---|---|
| Credential | call param `credentialId` → `app_settings.gcal_credential_id` → default | `11` (the Google Workspace connection) |
| Calendar | call param `calendarId` → `app_settings.gcal_calendar_id` → default | `'primary'` |

One `app_settings` read per call (skipped entirely if both are passed as params). To rebind the firm-wide default without a deploy:

```sql
-- Point all calendar actions at a specific credential / calendar by default
INSERT INTO app_settings (`key`,`value`) VALUES ('gcal_credential_id','11')
  ON DUPLICATE KEY UPDATE `value`=VALUES(`value`);
INSERT INTO app_settings (`key`,`value`) VALUES ('gcal_calendar_id','c_xxxxx@group.calendar.google.com')
  ON DUPLICATE KEY UPDATE `value`=VALUES(`value`);
```

**Finding a calendar's ID.** In Google Calendar → the calendar's *Settings* → *Integrate calendar* → **Calendar ID**. `'primary'` is a magic alias for the account's main calendar. A secondary/shared calendar's ID looks like `c_abc123...@group.calendar.google.com`. Or call `GET /api/gcal/calendars` (below), which returns every calendar the account can see along with its `id` and `accessRole`.

**Write access.** The bound credential must own the calendar or have it shared with "Make changes to events." The calendar scope alone does not grant cross-account access — sharing is configured on the Google side.

### Time semantics

`start` / `end` accept three shapes:

| Input | Sent to Google as | Meaning |
|---|---|---|
| `"2026-07-01T14:30:00"` (naive) | `{ dateTime, timeZone: FIRM_TZ }` | 2:30 PM firm-local |
| `"2026-07-01T14:30:00-04:00"` (zoned) | `{ dateTime, timeZone: FIRM_TZ }` | honors the explicit offset; `FIRM_TZ` is the display zone |
| `"2026-07-01"` (date only) | `{ date }` | all-day event |
| `{ dateTime, timeZone }` / `{ date }` (object) | passed through unchanged | full control |

`FIRM_TZ` comes from `services/timezoneService.js` (`FIRM_TIMEZONE` env, default `America/Detroit`). This mirrors how staff enter `appt_date` — naive local times — so passing an appointment's local datetime straight through produces a correctly-zoned calendar event.

### Service API — `services/gcalService.js`

All functions are `async (db, opts)` and **throw** on failure (Google 4xx/5xx, missing auth, bad input). Fire-and-forget callers wrap in `.catch()`.

| Function | Purpose | Returns |
|---|---|---|
| `listCalendars(db, opts)` | List calendars on the account (discover IDs). Account-scoped — ignores `calendarId`. | `{ items, nextPageToken? }` |
| `listEvents(db, opts)` | List events on a calendar. | `{ items, nextPageToken? }` |
| `getEvent(db, opts)` | Fetch one event by ID. | event resource |
| `createEvent(db, opts)` | Create an event. | created event (incl. `.id`, `.htmlLink`) |
| `updateEvent(db, opts)` | Partial-update (PATCH) an event. | updated event |
| `deleteEvent(db, opts)` | Delete an event. | `{ deleted: true, eventId }` |

Common `opts`: `credentialId`, `calendarId` (both optional overrides). Event-shaping opts on create/update: `summary`, `description`, `location`, `start`, `end`, `attendees` (array of email strings or `{email,...}` objects), `sendUpdates` (`'all'|'externalOnly'|'none'`, default `'none'`), and `event` (a pre-shaped Calendar resource; convenience fields layer on top and win). `getEvent`/`updateEvent`/`deleteEvent` require `eventId`. `listCalendars` takes `minAccessRole` (pass `'writer'` to list only writable calendars), `showHidden`, `pageToken`.

`createEvent` requires `start` and `end`. `updateEvent` requires `eventId` plus at least one field to change (PATCH is partial — unsent fields are untouched). `deleteEvent` of an already-gone event returns Google's `410 Gone`, surfaced as an error.

### REST API — `routes/api.gcal.js`

All routes are gated by `jwtOrApiKey`. Responses are `{ status: 'success', ... }` or `{ status: 'error', message }`. Google's 4xx codes pass through; upstream 5xx collapse to `502`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/gcal/calendars` | Discover calendars. Query: `minAccessRole`, `showHidden`, `pageToken`, `credentialId`. |
| GET | `/api/gcal/events` | List events. Query: `timeMin`, `timeMax`, `q`, `maxResults`, `singleEvents`, `orderBy`, `pageToken`, `credentialId`, `calendarId`. |
| GET | `/api/gcal/events/:id` | Get one event. Query: `credentialId`, `calendarId`. |
| POST | `/api/gcal/events` | Create. Body: `summary`, `description`, `location`, `start`, `end`, `attendees`, `event`, `sendUpdates`, `credentialId`, `calendarId`. |
| PATCH | `/api/gcal/events/:id` | Update (partial). Same body as POST; all fields optional. |
| DELETE | `/api/gcal/events/:id` | Delete. Query: `sendUpdates`, `credentialId`, `calendarId`. |

Smoke test from the browser console (after Setup is complete):

```js
const r = await apiSend("/api/gcal/calendars","GET");          // find calendar IDs
const ev = await apiSend("/api/gcal/events","POST",{
  summary:"YC test", start:"2026-07-01T14:00:00", end:"2026-07-01T14:15:00"
});
await apiSend("/api/gcal/events/"+ev.event.id,"GET");
await apiSend("/api/gcal/events/"+ev.event.id,"DELETE");
```

### Internal functions (automations)

Four functions, category `calendar`, available in workflows, sequences, scheduled jobs, and hook targets. Each is a thin wrapper over the service; `credential_id` / `calendar_id` are optional on all four and follow the resolution order above. (The internal-function param names are snake_case — `event_id`, `send_updates`, `credential_id`, `calendar_id` — while the service uses camelCase.)

#### `gcal_create_event`

Create an event. Capture the returned event ID for later edit/delete (e.g. into `appts.appt_gcal`).

| Param | Type | Required | Description |
|---|---|---|---|
| `summary` | string | optional (placeholderAllowed) | Event title. |
| `start` | string | yes (placeholderAllowed) | ISO datetime (firm-local if naive) or `"YYYY-MM-DD"` all-day. |
| `end` | string | yes (placeholderAllowed) | ISO datetime or `"YYYY-MM-DD"`. |
| `description` | string | optional (placeholderAllowed, multiline) | |
| `location` | string | optional (placeholderAllowed) | |
| `attendees` | array | optional | Email strings or `{email,...}` objects. |
| `send_updates` | enum | optional, default `none` | `all` \| `externalOnly` \| `none`. |
| `credential_id` | integer | optional | Override the bound credential. |
| `calendar_id` | string | optional | Override the bound calendar. |

```json
{
  "function_name": "gcal_create_event",
  "params": {
    "summary":  "341 Meeting — {{contact_name}}",
    "start":    "{{appt_date}}",
    "end":      "{{appt_end}}",
    "location": "Telephone",
    "attendees": ["{{contact_email}}"]
  },
  "set_vars": { "gcal_event_id": "{{this.output.id}}" }
}
```

#### `gcal_get_event`

| Param | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes (placeholderAllowed) | Calendar event ID (`appts.appt_gcal`). |
| `credential_id` | integer | optional | |
| `calendar_id` | string | optional | |

```json
{ "function_name": "gcal_get_event",
  "params": { "event_id": "{{gcal_event_id}}" },
  "set_vars": { "event_status": "{{this.output.status}}" } }
```

#### `gcal_update_event`

Partial update — only the fields you supply change. Requires `event_id` plus at least one of the editable fields.

| Param | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes (placeholderAllowed) | |
| `summary` | string | optional (placeholderAllowed) | |
| `start` | string | optional (placeholderAllowed) | ISO datetime or `"YYYY-MM-DD"`. |
| `end` | string | optional (placeholderAllowed) | ISO datetime or `"YYYY-MM-DD"`. |
| `description` | string | optional (placeholderAllowed, multiline) | |
| `location` | string | optional (placeholderAllowed) | |
| `attendees` | array | optional | |
| `send_updates` | enum | optional | `all` \| `externalOnly` \| `none`. |
| `credential_id` | integer | optional | |
| `calendar_id` | string | optional | |

```json
{ "function_name": "gcal_update_event",
  "params": { "event_id": "{{gcal_event_id}}", "start": "{{new_date}}", "end": "{{new_end}}" } }
```

#### `gcal_delete_event`

| Param | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes (placeholderAllowed) | |
| `send_updates` | enum | optional | `all` \| `externalOnly` \| `none`. |
| `credential_id` | integer | optional | |
| `calendar_id` | string | optional | |

```json
{ "function_name": "gcal_delete_event",
  "params": { "event_id": "{{gcal_event_id}}" } }
```

> The internal-functions chapter (5) count rises by four when these ship. `GET /workflows/functions` is the live source of truth for the registry, so regenerate any count-based docs from it rather than hard-coding the number.

### Setup

1. **Connection.** A Google Workspace oauth2 credential must exist in Connections, `connected`, with the `https://www.googleapis.com/auth/calendar` scope. (Credential `11`, "Google Workspace — Stuart@4lsg.com," is the current one.)

2. **allowed_urls — required, easy to miss.** The Calendar API lives at `https://www.googleapis.com/calendar/v3/*`. The credential's `allowed_urls` must contain a pattern that matches that host, or every call is rejected before it leaves the app (`buildHeadersForCredential` returns `{}`, surfaced as a thrown "out of allowed_urls scope" error). Add the googleapis host:

   ```sql
   UPDATE credentials
   SET allowed_urls = JSON_ARRAY(
     'https://gmail.googleapis.com/*',
     'https://oauth2.googleapis.com/*',
     'https://www.googleapis.com/*'
   )
   WHERE id = 11;
   ```

   (The broad `www.googleapis.com/*` also covers Drive, matching that scope on the same credential.) This can also be done from the Connections UI by editing the credential's allowed URLs.

3. **Optional default-calendar binding.** Set `app_settings.gcal_calendar_id` (and/or `gcal_credential_id`) if the firm-wide default should be something other than the account's primary calendar / credential `11`. See "Choosing the credential and calendar."

4. **Token refresh.** Handled by the existing Connections machinery — lazy refresh on every use plus the daily `refresh_expiring_oauth_credentials` job (chapter 15). No calendar-specific setup.

5. **Failure alerts (appointment sync).** When `apptService` fails to create or delete a calendar event, it emails IT — throttled to once per hour per failure type — using the `IT_EMAIL` (recipient) and `AUTO_EMAIL` (sender) env vars, the same pattern as the RingCentral legacy-route trap. If either var is unset the alert is skipped with a console warning; set both so silent calendar drift doesn't go unnoticed. The appointment record itself is never affected by a calendar failure — only the event doesn't sync.

### Relationship to appointments

Appointment calendar sync runs through this native service — the Pabbly bridge for `gcal_create` / `gcal_delete` has been retired. `apptService` calls `gcalService` directly:

- **createAppt** creates the event and writes the returned event ID into `appts.appt_gcal`. This happens **after** the HTTP response (fire-and-forget), so a slow or failed calendar call never blocks or rolls back the appointment write. Because the write-back lands after `createAppt`'s final re-fetch, the row returned to the caller does not yet include the new `appt_gcal` — read it back from the DB if you need it immediately.
- **cancelAppt**, **rescheduleAppt** (old event), **rescheduleLater**, and **341 supersession** delete the event by its `appt_gcal` ID. A Google `410 Gone` (event already deleted) is treated as success.

Two implementation facts worth knowing:

- **`appt_gcal` write-back is now owned by the app.** Under Pabbly the Zap wrote the event ID back out-of-band; natively, `apptService` does the `UPDATE appts SET appt_gcal = ?` itself.
- **`appt_end` is never written.** It is a `STORED GENERATED` column (`appt_date + appt_length`); MySQL computes it. App code must not write it — doing so throws (error 3105). The event's end time for the calendar is computed in `apptService` (firm-local, DST-aware via Luxon) but is **not** persisted to `appt_end`.

The old Pabbly-backed `POST /internal/gcal/create` and `/internal/gcal/delete` routes were **removed** — nothing called them once `apptService` moved to `gcalService`. All calendar access now goes through `gcalService` (server-side) or the `/api/gcal/...` REST routes (external/manual).

Pabbly still serves non-calendar bridges (Gmail send, sequence enroll, Dropbox, court email ingest) — those are separate retirements tracked in AI_CONTEXT §3.