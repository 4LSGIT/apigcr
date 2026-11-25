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

The Booking Manager's **Link**, **Embed** and **Mint** buttons always copy the
public short form, `4lsg.com/b/<slug>`, even though you are working in
`app.4lsg.com`.

### After booking: thank-you, then an optional thank-you page

The visitor always sees the view's **thank-you message** first. Then:

- **On the booking page itself** (a link to `4lsg.com/b/<slug>`) — if the view
  has a **Redirect after booking** (Thank-you section of the editor, `https://`
  only), the visitor goes there after a short pause; otherwise they stay on the
  thank-you message.
- **Embedded on a website** — the website's embed code (from **Embed help**)
  sends the visitor to the page in its `THANK_YOU` line. Left empty, the view's
  **Redirect after booking** applies. A website without the embed code's script
  keeps the visitor on the thank-you message.

A link cannot name its own thank-you page. That would let a scammer send a
genuine `4lsg.com` booking link that ends on a fake "pay your deposit" page. For
a different thank-you page, make a generic thank-you page in Landing Pages and
point the view at it, or make a separate booking view for each site.

### Putting a booking page on another website

**Embed help** (next to **+ New View**) opens a popup for one view with three
things to copy:

- **Embed code** — the booking box plus a short script. Paste both where the
  form should appear and fill in `THANK_YOU` (a relative address such as
  `/thank-you.html` is fine). The script listens only to its own booking box,
  so it names no domain and works on any website. One embed per view per page.
  The box **follows the form's height**: the `height:700px` in the code is
  only the size before the form has loaded; after that the script grows and
  shrinks the box with each step, so the list of times never scrolls inside a
  fixed frame, and when a step changes while the top of the box has scrolled
  off the screen (a long list of times, then the short details form) it
  scrolls the box back into view. An older embed without this script keeps
  its fixed box and still books.
- **Link instead** — the booking page's address; after booking it follows the
  view's **Redirect after booking**.
- **Instructions for an AI assistant** — both, as plain instructions, for when
  an AI builds the page.

### Telling websites apart: `?src=<tag>`

One view can sit on several websites. To know which site a booking came from,
add `?src=<tag>` to the box's address (or to a link):
`https://4lsg.com/b/bk-consult?src=ditchurdebt`. The booking then lands with
`appts.appt_source` = `<the view's source tag, or its slug>:<tag>` — here
`bk-consult:ditchurdebt`; a view with the source tag `test-consult` would give
`test-consult:ditchurdebt`. Without a tag, `appt_source` is the view's source
tag, or empty, exactly as before.

A tag is letters, digits, `-` and `_`, up to 30 characters, starting with a
letter or digit; case and surrounding spaces are ignored (`DitchUrDebt` →
`ditchurdebt`). Anything else is **ignored**: the booking goes through,
untagged, and nothing is shown to the visitor. The value is cut to the
column's 60 characters from the view's end, never the tag's. A tag changes
nothing but that one column: not the thank-you, not the redirect, not the
branding, and it is never a redirect itself. Automations that read
`{{appts.appt_source}}` see the tagged value.

### Counting bookings per page

Every appointment booked through a view records which view it came from
(`appts.appt_view_id`), whatever the slug is later renamed to. That is the
column to count by. `appts.appt_source` holds the view's **source tag** (empty
when the view has none), with `:<tag>` appended when the embed or link carried
a `?src=<tag>` — the one way to tell which website the visitor was on. Page
visits are not counted. A client's own reschedule or rebook through the manage
link creates a new appointment that carries both the view (`appt_view_id`) and
`appt_source`, so the count follows the booking (successors created before
2026-11-25 have no `appt_source`; `rescheduled_from_appt_id` links them back to
the original row).

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
| `source_tag` | Written to `appts.appt_source` — alone, or as `<source_tag or slug>:<tag>` when the booking carried a valid `?src=<tag>` (below) |
| `hook_id` | Fires a YisraHook on booking |
| `confirm_sms`, `confirm_email`, `confirm_template` | Confirmations |
| `title`, `subtitle`, `accent_color`, `logo_url`, `logo_link_url`, `thankyou_html`, `footer_html` | Branding |
| `redirect_url` | Optional `https://` page after the thank-you: the booking page's own target, and an embed's when its `THANK_YOU` is empty (NULL = stay) |

Appointments booked through a view carry `appt_view_id`, which is how you tell
self-booked appointments from staff-entered ones, and how bookings are counted
per view.

### Redirect after booking

`POST /api/book/:slug` answers every success, real or the anti-abuse fake,
through one function, `successBody` in `routes/booking.js`:
`{ success, thankyou_html, redirect_url }`. `redirect_url` is the view's
default, https-validated on save (`routes/api.bookingViews.js`, refused past
500 characters, never truncated) and again here, so a hand-edited row cannot
hand the widget an `http:` or `javascript:` target.

`public/book.html` `afterBooked` runs once the thank-you is on screen:

- **Framed:** posts `{ type: 'yc-booking', event: 'booked', slug, redirect_url }`
  to `window.parent` (target `'*'`, no personal data) and does nothing else.
  The widget never navigates the host page; the host decides.
- **Top level:** `location.assign(redirect_url)` after `REDIRECT_BEAT_MS`,
  when the view has one. Nothing in the URL can choose the target: a `?ty=`
  parameter makes a `4lsg.com/b/…` link an open redirect, and a "came from"
  (referrer) rule still lets a redirector such as X's `t.co` through, because
  the redirector becomes the referrer (review + Fred, 2026-11-19).

The host-page half is the script the Booking Manager's Embed help hands out
(`embedListenerScript`): wrapped in its own function, it accepts a message only
when `e.source` is its own iframe's `contentWindow` (the iframe carries
`id="yc-booking-<slug>"`), then goes to its `THANK_YOU`, else to an `https://`
`redirect_url`. It also requires `e.origin` to equal the origin of the
iframe's own `src`: a link inside the box can navigate it to another site, and
`contentWindow` survives that navigation. Both are read from the iframe at run
time, so the script names no domain and works on any vanity domain. One embed
per view per page (the id is per slug). An iframe whose `src` redirects never
matches (its messages come from the address it ended on): an embed code copied
before a change of the firm's public host (`landing_hosts`) stops redirecting,
and its visitors stay on the thank-you message until the code is re-copied.

`book.html` sets `<meta name="referrer" content="strict-origin">`: a prefill
link's URL carries the contact's bearer token (`?c=`), and a redirect to a
`4lsg.com` page would otherwise send that full URL as the Referer.

### Attribution: `?src=<tag>`

A query parameter, never a path segment (`book.html` takes the slug as the
last path segment, and the `/b/` matcher would break on a path tag). The
widget reads `src` from its own query string and sends it as `src` in the
`POST /api/book/:slug` body, beside a prefill `c`; an old widget sends none,
and an old server ignores the unknown field (the POST reads its body fields by
name). `routes/booking.js` `normalizeSrcTag` trims and lower-cases it and
requires `^[a-z0-9][a-z0-9_-]{0,29}$`; anything else — including a non-string
— is ignored and the booking proceeds untagged (attribution never 400s).
`composeApptSource` then writes `appt_source`: untagged → exactly
`view.source_tag || null`; tagged → `<base>:<tag>`, `base = view.source_tag ||
view.slug`, the base cut so the whole value fits `varchar(60)` (`SLUG_RE`
allows 100 characters and the relaxed `sql_mode` would truncate silently; the
real-engine twin `tests/bookingSrcTag.mysql.test.js` shows the cut). The tag
reaches nothing else: not `successBody`, the redirect, the branding or the
`fakeSuccess` paths. The view hook's payload keeps its `source` field, now the
row's `appt_source` when the caller has it and the view's `source_tag` when it
does not (a successor created before 2026-11-25, or a row whose channel was
cleared by staff), so a tagged booking's hook reports the tag. A reschedule or
rebook successor carries the original's `appt_source`.
Readers of the column: `services/triggerService.js` offers `data.appt_source`
as a condition path on `appt.created`; sequence template 20's step
(`sequence_steps` 120 / 200) posts `{{appts.appt_source|default:YisraCase}}`
to Clio Grow as the lead's `from_source`, so a tagged booking's lead reads
`bk-consult:ditchurdebt` there; workflow 33 writes `calendly`.

### Auto-resize

Framed (`window.parent !== window`), `book.html` posts
`{ type: 'yc-booking', event: 'resize', slug, height, step }` to its parent
(`'*'`, no personal data): on boot, on every step change, on the thank-you
and whenever the content wrapper changes size (a `ResizeObserver` on `.wrap`,
coalesced on one animation frame, changes under 2 px skipped, no timers).
`height` is the CONTENT's height — `.wrap`'s bottom edge plus `scrollY`,
rounded up — never `documentElement.scrollHeight`, which inside an iframe is
at least the frame's own height and could never let the frame shrink. `step`
is `1 | 2 | 3 | 'done'`. The embed script (`embedListenerScript`) applies the
same two guards as `booked`, then sets the iframe's height to the rounded value
clamped to 300–4000 px (non-finite or ≤ 0 ignored) and, when `step` differs
from the previous message's (never on the first) while the frame's top is above
the viewport, calls `scrollIntoView({ block: 'start' })`. The snippet's
`height:700px` is the size until the first message. The `booked` message and
`afterBooked` are unchanged. ditchurdebt.com's `script.js` v1.1 is a host
implementation of the same contract.

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
