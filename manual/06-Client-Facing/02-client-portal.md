# 2 — The Client Portal

## For operators

The portal is the one client-facing surface that requires a **login**. Everything
else in this section hands the client a link that *is* the credential — a manage
link, a document request, a booking page. The portal is different: the client
proves who they are, gets a session, and can then see everything the firm has
chosen to show them about their matter.

`portal.4lsg.com` (or wherever the portal host points), and there is no password.

### How a client gets in

1. They type a **phone number or email address**.
2. If it matches exactly one contact, we text or email them a **6-digit PIN**.
3. They enter the PIN and get a session.

That's it. No account to create, nothing to remember, nothing to reset.

**The screen says the same thing no matter what happened.** Match, no match,
two matches, portal access turned off, monthly SMS cap hit, send failed — the
client sees one identical "check your messages" response every time. This is
deliberate: anything else would let a stranger type addresses at the login page
and learn which ones belong to firm clients.

The practical consequence for you: **"I didn't get a PIN" is not
self-diagnosing.** Look at the Access tab rather than guessing.

### Why a client might not receive a PIN

| Cause | Where you see it |
|---|---|
| No contact matches that number/email | Access log — no row for a match |
| **Two or more contacts match** — we deliberately send nothing | Access log row `pin_multi_match` |
| Their `portal_enabled` is off | Portal Manager → Access tab |
| The firm's monthly portal-SMS cap is used up | `portal_sms_counter` vs `portal_sms_monthly_cap` |
| Send genuinely failed | Alert |

`pin_multi_match` is the one worth acting on: it means two contact records share
that phone or email, and auth will **never** guess between them. Merge the
duplicates and the client can log in.

### Turning access on and off

**More → Portal Manager → Access.** Every contact can log in by default —
`portal_enabled` is 1 unless somebody turns it off, which is exactly what that
tab is for. Two controls:

- **Enable / disable** — takes effect on the contact's very next request, not
  when some token expires.
- **Force logout** — bumps their session version and revokes every device at
  once. Use it when a phone is lost or a relationship ends badly.

With no search term, the tab lists **recent portal logins first** — "who is
actually using this" is the default view.

### What the client sees

- **Home** — a greeting and whatever home-placement cards you've configured.
  There is no case on this page, by design.
- **My Cases** — their matters.
- **A case** — the next steps from the [pipeline](../01-YisraCase-overview/13-pipelines.md),
  plus the case-placement cards.
- **Documents** — what they've sent and what's been shared back.

### Cards

Most of what a client sees is **cards**, and staff configure them without a
deploy: **More → Portal Manager → Cards**. A card is a title, a body with
placeholders, an optional link, and a condition deciding whether it shows at all.

Live today:

| Card | Where | Shows |
|---|---|---|
| Welcome | home | Greeting |
| My Cases | home | Their matters |
| Meeting of Creditors (341) | top of a case | When a 341 is scheduled and hasn't passed |
| Documents | case | Link into their documents |
| Need a call? | case | Request a callback |
| Payments | case | Payment link |

Three rules about cards that will save you time:

1. **A card whose condition fails is absent, not hidden.** It never reaches the
   client's browser, so there's nothing to find in the page source.
2. **A card that references a field it isn't allowed to is refused whole** — the
   entire card disappears rather than rendering with a blank. If a card vanished
   after an edit, that's the first thing to check; the editor warns you at save
   time.
3. **Preview renders through the real engine**, not a lookalike. What preview
   shows is what the client gets.

---

## Technical reference

### Files

```
routes/portal.auth.js          request-pin / verify-pin / logout
routes/portal.home.js          GET /api/portal/home — the case-less aggregate
routes/portal.cases.js         Case list and case view
routes/portal.docs.js          Client documents
routes/portal.branding.js      Logo / favicon for the login page
routes/portal.callback.js      "Need a call?" requests
routes/api.portalAccessAdmin.js  Staff: enable/disable, force logout
routes/api.portalCardsAdmin.js   Staff: card CRUD + preview
lib/portalCardEngine.js        The ONLY render path for cards
services/portalAuthService.js  PIN issue/verify, the no-oracle posture
services/portalCaseService.js  Next-steps card, timeline
services/portalDocsService.js  Document surface
public/portal/                 login, home, cases, case, docs, callback
public/portaladmin/            portalAccess, portalCards, portalSettings
```

### There is no accounts table

Portal access is **two columns on `contacts`**:

| Column | Meaning |
|---|---|
| `portal_enabled` | 1 = may log in and hold a session. **Defaults to 1.** |
| `portal_session_version` | Portal JWTs carry `ver`; a mismatch is rejected. `+1` revokes every device |

Both are re-checked by `requireAuth` on **every** portal request, which is why
admin writes take effect immediately rather than at token expiry.

### The auth invariants

These are security properties, not implementation details — don't relax one
without understanding what it buys:

- **No enumeration oracle.** `requestPin` resolves to the same `{ok:true}` for
  every internal branch, and the route returns one identical 200. External sends
  are fire-and-forget so *response timing* doesn't leak found-vs-not-found
  either. `verifyPin` returns one identical 401 for every failure mode.
- **Raw PINs are never stored, logged or returned.** Only
  `pin_hash = HMAC-SHA256(JWT_SECRET, pin)` persists. TTL 10 minutes, 5 attempts.
- **Multi-match sends nothing.** Auth must never guess which contact an
  identifier belongs to. (Booking's best-match behaviour is explicitly *not* the
  model here.) The `pin_multi_match` access-log row is the staff-visible signal.
- **No `SELECT contacts.*` anywhere** — `contact_ssn` lives on that table.
  Named columns only.
- **Portal JWTs carry exactly `{sub, aud:'contact', ver}`** plus `iat`/`exp` —
  never `user_auth`, the claim the two staff verify sites gate on. A portal token
  cannot be mistaken for a staff token.
- Rate limiters return **real 429s**. Rate limiting is not part of the
  no-oracle surface.

Identifier parsing is deliberately stricter than the rest of the app: a phone
must be exactly 10 digits after stripping non-digits and a leading `1`. The
usual "take the last 10" behaviour would let a mistyped number silently resolve
to *someone else's* contact.

### The card engine

`lib/portalCardEngine.js` is the only render path — the admin preview goes
through the same `previewCard → renderOneCard` calls, so a preview cannot drift
from what ships.

**The security model is ratified and is not the caller's to relax:**

1. **`PORTAL_FIELD_WHITELIST` is a code constant**, never a DB table, never
   staff-editable. Deny by default. `resolverService`'s own `ALLOWED_TABLES` is
   automation-grade and far too permissive for client-facing output; this
   whitelist layers on top and is much smaller.
2. **Refuse, never strip.** A body template referencing anything outside the
   whitelist refuses the *whole card* — hidden from the payload, plus an alert
   once per card key per boot. It is never silently sanitized. Save-time
   validation runs the same scan so staff learn on save instead of by cards
   vanishing, but **render-time refusal remains the enforcement of record**.
3. **Refs are pinned to the session.** Resolver refs and SQL params are built
   from exactly the authed `contactId` and the scope-confirmed `caseId`. Card
   config can never supply entity ids — rules mode has no id surface at all, and
   sql mode's `paramMap` values may only *name* the two pinned paths.
4. **Bodies are raw text, escaped by the client at insertion**, exactly like
   every other payload string. Templates are text with placeholders, never HTML;
   action links come from the structured `link_url` / `link_label` columns.
5. **Conditions gate, bodies leak.** Bodies are whitelisted because their values
   reach the client. Conditions may be more powerful — including a SQL escape
   hatch — because only one boolean escapes.
6. **Everything about condition evaluation fails closed.** Parse error, unknown
   operator, unknown field, query error, thrown anything → card hidden, never a
   portal error.

### Card conditions

`portal_cards.conditions`; `NULL` means always render.

**Rules mode** (the default):

```json
{ "mode": "rules", "match": "all",
  "rules": [ { "field": "cases.case_341_current", "op": "date_future" } ] }
```

Groups nest, depth-capped. Operators: `in`, `empty`, `not_empty`, `date_future`,
`date_past`, `date_within_days`, `contains`, `starts_with`.

> **Date semantics are parity-critical.** Date ops read the value's *naive*
> components and compare against firm-local today, as strings — matching how
> `case_341_current` is stored (firm-local wall time held as-if-UTC). Do not
> whitelist a real-UTC timestamp column for date rules without adding a
> conversion mode first; it would gate on the wrong day near midnight.
> `date_future` is `date >= today` — today still passes.

**SQL mode** is the escape hatch: `{ "mode": "sql", "condition": { query,
params, assert, assert_mode } }`, reusing `sequenceEngine.checkCondition`
verbatim — SELECT-only, fails closed on a missing or invalid query, no rows, or
a query error.

### Placements

`home`, `case`, `case_top`. **Home cards may reference the contacts side of the
whitelist only** — the home surface is case-less by contract, so `renderCards`
runs with `caseId` null. That's enforced at save time and backstopped at render
time. Coded cards are case-view renderers; a `coded_key` on a home card is
rejected at save *and* hidden at render.

### API

**Client-side** (portal session):

| Route | Method | Purpose |
|---|---|---|
| `/api/portal/request-pin` | POST | Always one identical 200 |
| `/api/portal/verify-pin` | POST | One identical 401 on any failure |
| `/api/portal/logout` | POST | Ends the session |
| `/api/portal/me` | GET | The authed contact |
| `/api/portal/home` | GET | `{ name, cards }` — case-less by contract |
| `/api/portal/branding` | GET | Logo / favicon for the login page |

**Staff-side** (`jwtOrApiKey`):

| Route | Method | Purpose |
|---|---|---|
| `/api/portal-access-admin/contacts` | GET | Search, or recent logins by default |
| `/api/portal-access-admin/contacts/:id` | PUT | `{ portal_enabled: 0\|1 }` |
| `/api/portal-access-admin/contacts/:id/force-logout` | POST | Bump session version |
| `/api/portal-cards-admin/cards` | GET, POST | Card list (active *and* inactive) / create |
| `/api/portal-cards-admin/cards/:id` | GET, PUT, DELETE | One card; PUT is a partial patch |
| `/api/portal-cards-admin/meta` | GET | Field whitelist (read-only), operators, placements |
| `/api/portal-cards-admin/preview` | POST | Renders through the real engine |

### Settings

| Key | What it does |
|---|---|
| `portal_live` | Master switch |
| `portal_logo_url`, `portal_logo_href`, `portal_favicon_url` | Login-page branding |
| `portal_email_from` | Sender for PIN emails |
| `portal_sms_monthly_cap` | Ceiling on PIN texts per month |
| `portal_sms_counter` | `{ym, count, alerted_ym}` — the running total |
| `portal_docs_notify_to`, `portal_docs_notify_from` | Who hears about a client upload |
| `portal_callback_task_to` | Who gets the task from "Need a call?" |

### Tables

| Table | What it holds |
|---|---|
| `portal_login_pins` | Issued PINs (hash only), attempts, `consumed_at` — `consumed_at` is what "logged in" means |
| `portal_access_log` | Every portal request, including auth outcomes like `pin_multi_match` |
| `portal_cards` | Card definitions: key, title, body template, link, conditions, placement, sort, active |

---

## Common pitfalls

1. **"The client says they got no PIN."** Check for duplicate contacts first —
   `pin_multi_match` in the access log means we deliberately sent nothing. Then
   check `portal_enabled`, then the SMS cap.
2. **A card vanished after an edit.** It almost certainly references a field
   outside the whitelist and is being refused whole. The editor warns at save
   time; the alert fires once per card key per boot.
3. **A home card that works as a case card.** Home is case-less. Anything
   reaching for `cases.*` is rejected on a home placement.
4. **Disabling access does not end the current session by itself** — it is
   re-checked per request, so it does take effect immediately, but if you want
   every device dropped *and* the reason recorded, use force-logout.
5. **Don't add a UTC timestamp column to the whitelist for date rules.** See the
   date-semantics note above.
