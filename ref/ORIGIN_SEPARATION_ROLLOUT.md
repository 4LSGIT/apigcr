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

- **/book, /m, /b on the landing host** — repo code, zero JWT exposure; URL
  aesthetics only. Chartered as a follow-up (allowlist entries + two
  app_settings template edits + optional redirects), keeping THIS slice's
  public surface exactly the staff-authorable set + dependencies.
- **CSP on the landing origin** — the charter's warning-banner model stands;
  a landing CSP hardening (e.g. blocking third-party pixels by policy) is a
  clean later slice now that the origin exists to hang it on.
- **301s, robots.txt, favicon file** — see decisions above; favicon simply
  404s on the landing host (allowlisted so it never redirects a browser's
  icon probe to the firm site).
- **go.4lsg.com reclaim / short.io retirement** — drain-window coupled.
- **app_url setting** unchanged (`https://app.4lsg.com`) — it feeds
  staff-facing/manage links, which correctly stay on the app host.
