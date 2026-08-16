# Origin separation + SU step-up — rollout note (2026-08-16)

Charter: `ref/EXTERNAL_CODE_CSS_DECISION.md` (residual #1 → resolved here).
Code: `routes/pageLanding.js` (host router), `lib/firmConfig.js` (keys),
`lib/auth.superuser.js` + `routes/admin.elevate.js` + `public/index.html`
(step-up). SQL: `ref/2026-08-16_origin_separation.sql`,
`ref/2026-08-16_phase_d_sms_cutover_v2.sql` (gated).
Tests: `tests/pageLanding.originsep.test.js`, `tests/su.stepup.test.js`.

## Decisions (ratified with Fred 2026-08-16)

- **Landing origin: the apex, `4lsg.com`.** Fallback if the apex ever
  misbehaves: `forms.4lsg.com` (one host for pages AND forms — never two).
  Verified before committing: DNS is **Namecheap BasicDNS** (not SiteGround —
  only the MySQL server lives there); the apex today is a Namecheap URL
  Forward (HTTP 302 → legalsolutions.group) and **HTTPS on the apex is
  currently dead** (no cert), so the mapping is a strict upgrade.
- **You cannot "leave 4lsg.com doing its thing and take the subpages."**
  DNS routes by HOSTNAME, not path — once the apex A/AAAA records point at
  Cloud Run, every path arrives at the app. Instead the app REPLICATES the
  thing: `GET /` on the landing host 302s to the firm site
  (`fe-firm_site_url` setting), so `4lsg.com` still lands people on
  legalsolutions.group — same observable behavior, now with working HTTPS.
  The one honest trade-off: that redirect now depends on Cloud Run being up
  (and eats a cold start when scaled to zero). Namecheap's forwarder was
  infrastructure-independent. Accepted: apex traffic is tiny and the firm
  site is what's actually marketed.
- **URL shapes on the landing host** — Fred's prefix scheme, both forms live:
  - `/p/:slug` pages, `/f/:key` forms, `/r/:slug` redirects — the canonical
    system-link shapes (Phase D v2 targets `/p/form?…`).
  - Root slugs ALSO serve (`4lsg.com/free-consult`) — the pretty marketing
    URL; costs nothing, allowlist wins any collision. Rip-out if unwanted:
    delete step 3 of the landing branch in pageLanding.js (one block).
  - `/book`, `/m` (booking/manage) NOT moved this slice — repo code, no
    origin-separation need; adding them later is allowlist entries + the two
    `manage_*` app_settings template edits. `/b` alias rides that slice.
- **Redirect code: 302**, upgrade to 301 only after weeks of stability
  (301s get cached; 302 keeps `landing_redirect='0'` an instant revert).
- **Robots: `X-Robots-Tag: noindex, nofollow`** on `/f/*`, ext render, and
  `/api/ext/*` on the landing host (credentialed URLs stay out of indexes).
  Pages deliberately stay indexable (marketing surface). No robots.txt — it
  would advertise the paths while blocking nothing a header doesn't.
- **`go.4lsg.com` reclaim**: deferred, coupled to the legacy-chain drain
  window after Phase D v2 (short.io `intake` slug must keep working for
  already-sent SMS). Future slice: map `go` to Cloud Run, add to
  `landing_hosts`, and optionally teach the redirects system a root-slug
  mode there. Retires short.io.

## Order of operations

**Step 0 — deploy the code (inert).** `landing_hosts` is unset →
behavior is byte-identical to pre-slice EXCEPT rider B: SU tools start
demanding step-up immediately after this deploy. If that must wait, set
`SU_STEPUP=0` on the Cloud Run revision and remove it later.

**Step 1 — SQL, part 1** (`ref/2026-08-16_origin_separation.sql`): settings
rows (`landing_hosts='4lsg.com'`, `landing_redirect='0'`) + the two page
content edits. Redirects stay OFF; the landing gate is armed but the domain
doesn't resolve to us yet.

**Step 2 — Cloud Run mapping.** Console → Cloud Run → Manage custom domains
→ Add mapping → service (the YisraCase service) → domain `4lsg.com`.
Domain verification should already pass (the `google-site-verification` TXT
at `@` exists); if prompted, verify via Search Console with that TXT. The
console then displays the records to create — for an apex, four A and four
AAAA (expect the `216.239.32/34/36/38.21` set and their IPv6 twins; use
EXACTLY what the console shows).

**Step 3 — Namecheap DNS** (Domain List → 4lsg.com → Advanced DNS):
1. DELETE the `URL Redirect Record` with Host `@` (→ legalsolutions.group).
2. ADD the four `A` records, Host `@`, values from step 2, TTL Automatic.
3. ADD the four `AAAA` records, Host `@`, same.
4. TOUCH NOTHING ELSE. Explicitly keep: all `MX` on `@` (Gmail), the SPF and
   DKIM `TXT` rows, the `google-site-verification` TXT, the `*` wildcard URL
   Redirect (still catches random subdomains), and every existing CNAME
   (`app`, `go`, `email`, `mta`, `uploads`, `mlsend2._domainkey`) and the
   `bk` A record and `it` NS set. Mail is untouched by design: MX/TXT are
   separate record types from the `@` A/AAAA swap.

**Step 4 — wait for the managed cert** (15 min–24 h after DNS propagates;
the mapping page shows status). Nothing user-visible changes while waiting
except `http://4lsg.com` may briefly stop redirecting between the Namecheap
delete and cert issuance — during that window the firm-site hop is degraded,
which is why this runs at a quiet hour.

**Step 5 — verify the landing host** (all should hold BEFORE any link moves):
- `https://4lsg.com/` → 302 `https://legalsolutions.group` (or whatever
  `fe-firm_site_url` holds)
- `https://4lsg.com/p/free-consult` renders; `https://4lsg.com/free-consult`
  renders the same page (root slug)
- `https://4lsg.com/f/intake?case_id=<real case_id>` → renderer loads,
  prefill works, submit works; response carries `X-Robots-Tag`
- `https://4lsg.com/p/form?f=intake&case_id=<real>` → wrapper + grow mode
  (needs the page-4 FORM_BASE edit from step 1)
- `https://4lsg.com/login`, `/api/firm-data`, `/settings` → all 302 to the
  firm site. **This is the boundary — if any of these answers, STOP.**
- Rate-limit sanity (the XFF chain question): hit
  `https://4lsg.com/f/bad-key!` from two different networks (office + phone
  LTE) a few times each; both should keep getting the generic 404, and
  `jwt_api_audit_log`-style IPs aren't involved here — instead confirm in
  logs that `[api.ext.forms]` limiter isn't tripping globally. Both domains
  ride the same ghs Google Front End, so XFF behavior is expected identical
  to app.4lsg.com; this check just proves it.

**Step 6 — cutover:** DB console →
`UPDATE app_settings SET value='1' WHERE \`key\`='landing_redirect';`
(≤60 s to take effect on all instances via the firmConfig cache). Verify:
`https://app.4lsg.com/f/intake?case_id=X` → 302
`https://4lsg.com/f/intake?case_id=X` with the query intact; internal
render (`/forms/render.html` without `ext=1`) still serves on the app host;
`POST /p/...` still answers on the app host.

**Step 7 (later, separately gated) — Phase D v2**
(`ref/2026-08-16_phase_d_sms_cutover_v2.sql`): supermanager approval, then
run. Old go.4lsg.com links keep working through the short.io chain until its
separate retirement.

## Rider B — SU step-up (independent of DNS)

Live from the step-0 deploy. Every `superuserOnlyFor` tool (db_console,
api_tester, users, api_keys, connections, phone_lines, email_credentials,
system_alerts, readonlyKeys, sequence types) 401s with
`code:'elevation_required'` until the shell's password modal mints a 15-min
elevation token (`POST /admin/elevate`, bcrypt vs the caller's own
`users.password_hash`, rate-limited 10/min, all outcomes audited in
`admin_audit_log` tool `elevate`). Token lives in sessionStorage (tab-scoped),
rides as `X-SU-Elevation`. The modal is a real `<form>` with
`autocomplete="current-password"` + a readonly username field — password
managers fill it.

## Adding `www.4lsg.com` (2026-08-16, after step 6)

Symptom that triggered this: `https://www.4lsg.com` fails in a browser while
the apex works. Cause: `www` resolves via the Namecheap `*` wildcard URL
Redirect record to their forwarder (192.64.119.254), which serves HTTP only
and has no certificate for that name. `www` was ALWAYS broken over HTTPS —
the apex used to fail identically and only appeared to work because browsers
silently fell back to HTTP. Once the apex got a real Google-managed cert the
asymmetry became visible. No HSTS is involved.

**ORDER IS CRITICAL — `landing_hosts` BEFORE the mapping.** A host that
resolves to Cloud Run but is NOT in `landing_hosts` serves the FULL APP
(same hazard as the revert note below). Arm the gate first.

1. **Deploy** the canonical-redirect patch (`pageHostMiddleware` step 0).
   Inert until a second landing host exists.
2. **DB console:**
   `UPDATE app_settings SET \`value\` = '4lsg.com,www.4lsg.com' WHERE \`key\` = 'landing_hosts';`
   The apex MUST stay FIRST — entry [0] is the canonical redirect target.
   Effective within 60s (firmConfig cache). Still inert: nothing resolves
   `www` to Cloud Run yet.
3. **Cloud Run** → Manage custom domains → Add mapping → same service →
   `www.4lsg.com`. Being a subdomain it takes a plain CNAME, not the apex
   A/AAAA set.
4. **Namecheap** → Advanced DNS → ADD `CNAME Record`, Host `www`, Value
   `ghs.googlehosted.com.`, TTL Automatic. Change nothing else — in
   particular KEEP the `*` URL Redirect record; an explicit `www` record
   takes DNS precedence over a wildcard, so the forwarder simply stops
   answering for `www` while still covering other subdomains.
5. **Wait for the managed cert** (mapping page shows status).
6. **Verify:**
   - `https://www.4lsg.com/` → 302 `https://4lsg.com/` → 302 firm site
   - `https://www.4lsg.com/f/intake?case_id=X` → 302
     `https://4lsg.com/f/intake?case_id=X` (query intact)
   - `https://www.4lsg.com/login` → 302 to the apex, and gated on arrival —
     never serves the shell. **If it serves anything app-like, STOP** and
     revert step 2 last (see below).

Revert: remove the Namecheap CNAME and the Cloud Run mapping FIRST, then
drop `www.4lsg.com` from `landing_hosts`. Never the other order.

## Reverts (each piece independently)

- **Redirects off:** `landing_redirect='0'` (DB console; ≤60 s). Old links
  serve on the app host again; the landing host keeps working in parallel.
- **Step-up off:** Cloud Run env `SU_STEPUP=0` (new revision) — exact
  pre-slice SU behavior. `/admin/elevate` stays mounted but unneeded.
- **Landing host off:** FIRST restore Namecheap (`@` URL Redirect back to
  `http://legalsolutions.group`, delete the eight A/AAAA), remove the Cloud
  Run mapping, and only THEN blank `landing_hosts`. Never blank it while the
  mapping stands — an unlisted-but-mapped host serves the FULL app.
- **Page content:** inverse REPLACEs in `ref/2026-08-16_origin_separation.sql`.
- **Phase D v2:** inverse REPLACEs in its own file.

## Deliberately not done (with reasons)

- ~~**/book, /m, /b on the landing host**~~ — **DONE**, see the follow-up
  slice section below (2026-08-16). Original reasoning kept for the record:
  repo code, zero JWT exposure, URL aesthetics only.
- **CSP on the landing origin** — the charter's warning-banner model stands;
  a landing CSP hardening (e.g. blocking third-party pixels by policy) is a
  clean later slice now that the origin exists to hang it on.
- **301s, robots.txt, favicon file** — see decisions above; favicon simply
  404s on the landing host (allowlisted so it never redirects a browser's
  icon probe to the firm site).
- **go.4lsg.com reclaim / short.io retirement** — drain-window coupled.
- **app_url setting** unchanged (`https://app.4lsg.com`) — it feeds
  staff-facing/manage links, which correctly stay on the app host.

---

# Follow-up slice — booking + manage on the landing host (2026-08-16)

Code: `routes/pageLanding.js` (allowlist, `isMigratedPath`, `isCredentialedPath`),
`routes/booking.js` (`/b/:slug` alias + docs), `routes/manage.js` (docs),
`lib/rateLimiter.js` (stale-comment correction),
`public/{index.html,scripts.js,campaign.html,bookingviewsmanager.html}`
(hard-coded default link hosts).
SQL: `ref/2026-08-16_booking_landing.sql`.
Tests: `tests/pageLanding.originsep.test.js` (extended, not forked).

## Why — stated at its real size

This is **coherence and URL aesthetics**, not a security fix. `booking.js` /
`manage.js` are repo code, not staff-authored, so they never carried the
JWT-snatch exposure that motivated origin separation. What this buys:

1. Every public link the firm sends lives on one public host. Staff never have
   to remember which surface lives where.
2. `app.4lsg.com` converges on "staff only" — which makes a future app-origin
   lockdown cheaper, because the set of paths that must stay publicly
   reachable there shrinks.

Do not let anyone re-tell this as a vulnerability fix.

## Decisions

- **`/b/:slug` is a route ALIAS, not a redirect** (`routes/booking.js`, one
  line: `router.get(['/book/:slug', '/b/:slug'], …)`). A 302 would show the
  visitor a URL different from the one they tapped and would cost an extra
  round trip on a cold-start Cloud Run instance — paid on every SMS tap, which
  is the exact traffic `/b` exists for. Duplicate-content, the one real
  argument for the 302 shape, is moot because both paths carry
  `X-Robots-Tag: noindex`. **`/book/:slug` keeps working forever**; neither is
  deprecated, and a bookmark of either survives any later rename.
- **Link-shape convention**: `/b/` for anything that lands in an SMS body,
  `/book/` for anything rendered as a link or button in a browser. Applied to
  the frontend defaults and the SQL.
- **Precedence: the allowlist beats root-slug pages.** The allowlist is a
  fixed repo-defined set; root slugs are an unbounded staff-authored set. If a
  page named `m` could shadow `/m/:token`, every appointment-management SMS
  the firm has ever sent would break **silently**. The reverse — a repo route
  shadowing a page — is loud and recoverable (`/p/m` still serves it, and it
  can be renamed). This is the existing "allowlist wins on collision" rule,
  not a new one: one ordering comment plus test locks, no new mechanism.
  - Corollary: **bare `/book` and `/b` are NOT allowlisted** — only the
    two-segment `/book/:slug` and `/b/:slug`. A marketing page slugged `book`
    keeps `4lsg.com/book` and collides with nothing. Test-locked both ways.
- **`X-Robots-Tag: noindex, nofollow` on the whole booking/manage set**,
  decided per path:
  - `/m`, `/m/:token`, `/api/m/*` — `appt_manage_token` is a 32-hex bearer
    token **in the path**. Same class as `/f/:key`; not arguable. Bare `/m` is
    tokenless but is only ever the branded invalid-link fallback, so indexing
    it is pure noise.
  - `/book/:slug`, `/b/:slug`, `/api/book/*` — credentialed only in the `?c=`
    (`contacts.booking_token`) variant, and `isCredentialedPath` is path-only
    by design (making it query-dependent would invert the discipline the
    allowlist runs on). The tie-breaker is that indexing costs nothing to
    lose: the booking widget is a slot picker with no marketing copy, designed
    to be **iframed into a `pages` landing page** (row 2 does exactly this).
    Indexing the widget instead of the page that embeds it is a net negative
    even ignoring the token.
  - `/api/manage-config` — **deliberately excluded.** Firm-public config only
    (booking CTA + office phone, both already on the firm website), no token in
    any variant. Uniformity is not a reason to widen a rule whose stated basis
    is "carries a credential".
- **The HTML entry points migrate; their XHR endpoints do NOT.** Same split as
  `/f/:key` (migrated) vs `/api/ext/*` (not). `book.html` / `manage.html` build
  every API URL relative — verified — so a shell talks to whichever host served
  it. Redirecting `/api/book/*` or `/api/m/*` would buy an extra round trip per
  call and nothing else, and `POST /api/book/:slug` must never meet a 302 (it
  would become a GET and drop the body). Test-locked.
- **The allowlist entries are ENUMERATED, not prefixed.** `/api/book/` as a
  prefix would auto-admit any future route added under it, and `booking.js`
  already contains a `jwtOrApiKey` route. `POST /api/contacts/:id/booking-link`
  staying dead on the landing host is test-locked.
- **`app_url` untouched** (`https://app.4lsg.com`). Verified before believing
  the charter: `lib/credentialInjection.js` uses it to decide whether an
  outbound workflow/webhook call is self-targeted, and eventService /
  taskService / job_executor build **staff-facing** links from it. It is not a
  display setting. Never repoint it to move a public link.

## Interaction with the `www.4lsg.com` canonicalization slice

Canonicalization (`pageHostMiddleware` step 0) runs BEFORE the allowlist, so a
booking or manage GET arriving on a secondary landing host is 302'd to
`landing_hosts[0]` and gated again on arrival — links never fragment across two
origins. Their POSTs skip step 0 by design and are served in place, which is
required: an in-flight booking or cancel from a page loaded on `www` has to
complete rather than be dead-ended. Test-locked.

## Order of operations

1. **SQL is optional and can run any time** — including never. The app-host
   302s keep every unmigrated link working, so a missed row degrades to one
   extra hop, not a break. Ship the code first if you prefer.
2. **Backend deploy.** Inert unless `landing_hosts` is set; today it is
   (`4lsg.com`, `landing_redirect='1'`), so this takes effect immediately:
   `app.4lsg.com/book/*` and `/m/*` start 302ing to `4lsg.com`.
3. **Frontend deploy.** The four `public/` files only change *default* copy
   offered to staff — nothing already sent or already saved changes.
4. **`ref/2026-08-16_booking_landing.sql`** — read the verify-BEFORE block
   first. All three settings rows are `is_editable = 1`, so a human may have
   edited them since; a `REPLACE()` whose source string is gone is a silent
   no-op, which is safe but means you must confirm the after-state.

## Verify

- `https://4lsg.com/book/consult` renders the widget; picking a slot works
  (the `/api/book/*` calls resolve on `4lsg.com`), response carries
  `X-Robots-Tag`
- `https://4lsg.com/b/consult` renders the same thing at the same URL — no
  redirect in the address bar
- `https://4lsg.com/m/<real appt_manage_token>` loads, cancel/reschedule work
- `https://4lsg.com/m` shows the branded invalid-link fallback
- `https://app.4lsg.com/book/consult?c=X` → 302 to `https://4lsg.com/book/consult?c=X`
- `https://4lsg.com/api/contacts/1/booking-link` (POST) → firm-site redirect.
  **This is the boundary — if it answers, STOP.**
- Page 2: `https://4lsg.com/mich-tax-prep` — the booking iframe loads with no
  redirect hop after the SQL

## Reverts

- **Code:** `landing_redirect='0'` (≤60 s) — the app host stops 302ing `/book`
  and `/m`; the landing host keeps serving them in parallel, so nothing
  breaks in either direction. This is the safe first move.
- **Content:** inverse `REPLACE`s in
  `ref/2026-08-16_booking_landing.sql` § 4, plus reverting the four `public/`
  files. **Order matters on a full teardown:** content edits point at
  `4lsg.com`, so revert them BEFORE unmapping DNS — the mirror of the existing
  "never blank `landing_hosts` while the mapping stands" rule.
- **`/b` alias:** removable on its own (drop `'/b/:slug'` from the array in
  `routes/booking.js` and the two `BOOK_ROUTE_RE` alternates in
  `routes/pageLanding.js`). Any `/b/` link already sent would then 404, so do
  the content revert first.

## Deliberately not done in the follow-up slice

- **Rate-limiter keying.** The charter for this slice claimed `booking.js` and
  `manage.js` each carry a private limiter keyed on `cf-connecting-ip ||
  req.ip`. **That is stale** — both already import `makeLimiter` +
  `getClientIp` from `lib/rateLimiter.js` and key on the last XFF element.
  Nothing to fix. Two real notes, neither caused by this slice:
  - `routes/pageLanding.js` still has an inline copy keyed on
    `cf-connecting-ip || req.ip` for the landing-page POST limiter — the exact
    anti-pattern `getClientIp()` argues against. Pre-existing, unrelated to
    routing; **chartered, not fixed here** (a ~10-line swap, but it changes
    live anti-spam behavior on a surface this slice does not touch).
  - `getClientIp`'s doc warns the last-XFF rule breaks if a host is ever
    fronted by a CDN. Checked: every landing host is a **direct Cloud Run
    domain mapping** (apex A/AAAA to Google IPs; `www` a CNAME to
    `ghs.googlehosted.com`), same GFE as `app.4lsg.com`. The keying is
    therefore identical on every host and the move introduces no regression.
    Revisit only if a CDN ever fronts one of them.
  - `lib/rateLimiter.js`'s own header comment was corrected in this slice — it
    still claimed booking/manage kept local copies.
- **`/book`→`/b` swap in already-sent links.** Nothing rewrites history; both
  shapes are permanent.
- **`X-Robots-Tag` on the app host.** `/book/*` and `/m/*` there now 302, so
  there is no body to index. With `landing_redirect='0'` they serve
  unheadered exactly as before — unchanged behavior, and the app host was
  never the public host.
- **Extracting the duplicated provider-lock helper** shared by `booking.js`
  and `manage.js` (`lib/providerLock.js`) — still the safe follow-up
  `manage.js`'s header calls it, still not worth touching the live booking
  pipeline for in a routing slice.
