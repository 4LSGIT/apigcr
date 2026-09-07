# 4 — Booking & Scheduling

## For operators

A **booking page** is a public URL a client can open to pick a time and book it
themselves. No login, no back-and-forth.

```
4lsg.com/book/<slug>      the full URL
4lsg.com/b/<slug>         a permanent short alias — same page, not a redirect
```

Both work forever; neither is deprecated. The short one exists because an SMS
tap shouldn't pay for an extra round trip, and because the address bar keeps the
short link the client was actually sent.

Three things combine to decide what a visitor sees:

| Piece | Managed at | Answers |
|---|---|---|
| **Booking view** | More → Booking Manager | What is being booked — length, type, who can host, how the page looks |
| **Working hours** | More → Availability Manager | When each staff member normally takes appointments |
| **Blocks** | Availability Manager | One-off unavailability — a person's, or the whole firm's |

Free time is then computed from *five* sources at once: working hours, personal
blocks, firm-wide blocks, existing appointments, and events. Anything on any of
them removes the slot.

### Setting up a booking page

1. **Availability Manager** — give each host their weekly working hours. Without
   these, nothing is ever bookable.
2. **Booking Manager → new view** — pick the slug, the appointment type and
   length, and who can host.
3. Choose a **provider mode**:
   - `fixed_one` — one named person.
   - `client_choice` — the visitor picks from a list.
   - `any_auto` — we pick for them.
4. Set the **guard rails**: `min_notice_min` (how soon is too soon),
   `horizon_days` (how far ahead), `granularity_min` (slot spacing),
   `buffer_min` (padding around existing appointments).
5. Brand it — title, subtitle, accent colour, logo, thank-you HTML, footer.
6. Decide what happens after: confirmation SMS and/or email, an optional
   YisraHook, and a `source_tag` that lands on the appointment.

### Two ways a visitor is identified

- **`public`** — anyone can book; the page collects name and contact details.
- **`prefill`** — the link carries a per-contact token (`?c=…`) so we already
  know who they are and the form comes pre-filled. Mint one from a contact with
  **Booking link**.

### Deleting a view doesn't delete it

Booking views **soft-delete** (`active = 0`), unlike pages and redirects which
hard-delete. Views get embedded as iframes on third-party sites, so a hard
delete would break somebody else's page with no way to notice. Deactivating
takes the page out of service and leaves the row.

### Why a slot you expected isn't offered

Work down this list — it's ordered by how often each one is the answer:

1. **The host has no working hours** for that weekday.
2. **`min_notice_min`** rules it out as too soon.
3. **`horizon_days`** puts it beyond the bookable window.
4. **`buffer_min`** — an existing appointment pads outwards on both sides.
5. A **block** (personal or firm-wide) covers it.
6. An **event** — not just appointments — occupies it.
7. The slot doesn't land on a **`granularity_min`** boundary.

### Anti-abuse, and the one symptom it causes

The public endpoint is defended against bots, and one of those defences will
occasionally confuse a real person:

- **Rate limits** — 5 posts / 10 min / IP; 30 config-or-slot reads / min.
- **Honeypot** — a hidden field a human never fills.
- **Minimum fill time** — the page is stamped when it loads; a submission
  arriving in under 3 seconds is treated as a bot.

Bot-flagged submissions get a **silent fake success**: the normal thank-you
page, nothing booked. A bot can't tell the difference — but neither can a
person, so *"they say they booked and there's no appointment"* has this as one
possible cause.

The recoverable case is different and does say so: a page left open **more than
two hours** returns `stale_form`, and refreshing fixes it.

### Double-booking

Can't happen. Booking takes a per-host lock, re-derives the slot inside it, and
only then writes. If the slot went while the visitor was typing they get a clear
"that time was just taken" (409) rather than a second appointment.

---

## Technical reference

### Files

```
routes/booking.js                    Public: GET /book/:slug, /b/:slug, config, slots, POST
routes/api.bookingViews.js           Staff CRUD for booking_views
routes/api.availability.js           GET /api/availability — the internal slots face
routes/availabilityAdmin.js          user_availability, availability_blocks, firm_blocks CRUD
services/availabilityService.js      getSlots() — the definition of "free"
public/book.html                     The widget
public/bookingviewsmanager.html      Booking Manager
public/availabilitymanager.html      Availability Manager
```

### `getSlots()` is the definition of "free"

Both the public widget and the internal availability API call the same function,
so there is exactly one answer to "is this time open."

**Everything is firm-local wall time.** All five sources store firm-local, so no
UTC conversion happens anywhere in the module, and datetimes are fetched as
formatted strings so mysql2's `timezone:'Z'` fake-UTC wrapping never enters the
picture.

| Source | Storage | Note |
|---|---|---|
| `user_availability` | weekday + TIME | Inherently firm-local |
| `availability_blocks` | naive DATETIME | Per-person one-offs |
| `firm_blocks` | naive DATETIME | Firm-wide; written as FIRM_TZ wall time |
| `events` | DATE + TIME | Timezone suffixes are rejected on write |
| `appts.appt_date` | naive DATETIME | **Firm-local, not UTC.** `appt_date_utc` is the UTC twin but is NULL on legacy rows — never read it here |

**Buffer semantics (binding).** `buffer_min` pads each busy *appointment*
interval on both sides. A slot fits if `[start, start + appt_length)` lies fully
inside a free window. Buffer is **not** added to the fit test — that would
double-count — and it pads appointments only, not events, not blocks, not the
edges of the working window. The visible consequence: a slot may end exactly
where an appointment's front pad begins.

### Server-authoritative config

Everything that matters — length, buffer, granularity, min notice, horizon,
provider set — is re-derived from the `booking_views` row on **every** request.
The client never sends scheduling parameters. Provider is the single
client-influenced knob, and only in `client_choice` mode.

The config endpoint deliberately never exposes `buffer_min`, `min_notice_min`,
`source_tag`, `hook_id`, `confirm_template`, or (outside `client_choice`)
`provider_ids`.

### Anti-abuse mechanics

`GET /api/book/:slug/config` hands out `{ ts, sig }` where
`sig = HMAC-SHA256(JWT_SECRET, String(ts))`. The POST requires a valid pair with
`3s ≤ now − ts ≤ 2h`:

| Condition | Response |
|---|---|
| Faster than 3s | Silent fake success |
| Bad signature | `400 invalid_request` (tampered) |
| Older than 2h | `400 stale_form` (recoverable — refresh) |
| Honeypot `website` non-empty | Silent fake success |
| POST rate limit exceeded | Silent fake success |
| Read rate limit exceeded | Real `429` |

Client IP is the **last** `X-Forwarded-For` element (the GFE-appended peer), not
`cf-connecting-ip` — `app.4lsg.com` is direct Cloud Run, so that header is
client-suppliable and keying on it gave every request its own bucket.

### Concurrency

A per-provider MySQL named lock `book:<provider>`, held on a **dedicated pool
connection** — `GET_LOCK`, critical section and `RELEASE_LOCK` all on the same
session. Named locks are session-scoped, so a pool-level `db.query()` can
acquire on one session and "release" on another, leaking the lock. Inside the
lock the requested slot is re-derived through `getSlots` and only then does
`createAppt` run. Slot gone → `409 slot_taken`.

### Identity resolution on POST

In priority order: the `c` contact token (32 hex) resolves the contact; an
invalid token falls through to the public path if public-identity fields were
also sent. The token lives in `contacts.contact_token` — renamed from
`booking_token` in 2026-08-17 because the same per-contact bearer now also
identifies contacts on video landing pages. The route path
(`POST /api/contacts/:id/booking-link`) is unchanged.

### `booking_views`

| Column | Purpose |
|---|---|
| `slug`, `active` | URL and the soft-delete flag |
| `provider_mode`, `provider_ids` | `fixed_one` / `client_choice` / `any_auto` |
| `appt_type`, `type_key`, `appt_length`, `platform` | What gets booked — `type_key` comes from the [calendar type registry](../05-Subsystems/11-calendar-types.md) |
| `buffer_min`, `min_notice_min`, `horizon_days`, `granularity_min` | The guard rails |
| `identity_mode` | `public` or `prefill` |
| `page_windows` | Optional per-page bookable windows; validated on read, alerting on bad config |
| `source_tag` | Written to `appts.appt_source` |
| `hook_id` | Fires a YisraHook on booking |
| `confirm_sms`, `confirm_email`, `confirm_template` | Confirmations |
| `title`, `subtitle`, `accent_color`, `logo_url`, `logo_link_url`, `thankyou_html`, `footer_html` | Branding |

Appointments booked through a view carry `appt_view_id`, which is how you tell
self-booked appointments from staff-entered ones.

### API

**Public** (no auth):

| Route | Method | Purpose |
|---|---|---|
| `/book/:slug`, `/b/:slug` | GET | The widget shell |
| `/api/book/:slug/config` | GET | Public config + the `{ts, sig}` pair |
| `/api/book/:slug/slots` | GET | Open slots |
| `/api/book/:slug/contact` | GET | Prefill lookup by contact token |
| `/api/book/:slug` | POST | Book it |

**Staff** (`jwtOrApiKey`, not admin-gated):

| Route | Method | Purpose |
|---|---|---|
| `/api/booking-views` | GET, POST | List (incl. inactive) / create |
| `/api/booking-views/:id` | GET, PATCH, DELETE | DELETE is a soft delete |
| `/api/booking-views/providers` | GET | Users with `does_appts=1` |
| `/api/user-availability` | GET, POST, PATCH, DELETE | Weekly working hours |
| `/api/availability-blocks` | GET, POST, PATCH, DELETE | Per-person blocks |
| `/api/firm-blocks` | GET, POST, PATCH, DELETE | Firm-wide blocks |
| `/api/availability` | GET | Internal slots face — same `getSlots()` |
| `/api/contacts/:id/booking-link` | POST | Mint or return `contact_token` |

---

## Related

- **[Client self-service](03-self-service-links.md)** — the manage link that
  lets a client move an appointment they already have. A cancellation can offer
  a booking page as its fallback URL.
- **[Calendar types](../05-Subsystems/11-calendar-types.md)** — where `type_key`
  and its lengths come from.
- **[Appointments](../01-YisraCase-overview/04-appointments.md)** — what the
  firm sees once a booking lands.
