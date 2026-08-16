# YisraCase — public-surface origin separation + SU step-up

You are the manager AND the worker for this. Fred has delegated the decision
details, not just the implementation. **Decide, then build.** Come back with
decisions, reasoning, and code — not questions this prompt already answers.

## Ground rules

- **The repo is the source of truth. This prompt is hearsay.** Two prior
  sessions on this program each led with a confidently wrong claim (recorded
  in `ref/EXTERNAL_CODE_CSS_DECISION.md` — read it FIRST; it is the charter
  for this slice). Verify every claim below against live files before
  relying on it, and report divergences instead of force-fitting.
- Repo: `4LSGIT/apigcr`, main. Fetch fresh:
  `https://codeload.github.com/4LSGIT/apigcr/tar.gz/refs/heads/main`
  (never raw.githubusercontent — stale). `TRACKED_FILES.txt` is canonical.
- **Prerequisite check:** HEAD must contain `lib/auth.formDev.js`, an
  `external_executes` publish notice in `services/formTemplateService.js`,
  and `code`/`css`/`hooks` in `services/extFormService.js` TOP_KEYS (the
  2026-08-16 form_dev + reversal patch). If absent, STOP and tell Fred —
  this slice builds on it.
- Live DB, read-only: `POST https://app.4lsg.com/api/readonly/sql`, body
  `{sql, params?}`, header `X-Readonly-Api-Key: ycro_<…>`. **Ask Fred for a
  key** (session-scoped). `WITH` CTEs blocked; use subqueries.
- Deploy order: SQL/app_settings → backend → frontend → (this slice adds)
  DNS/domain-mapping steps Fred performs in Cloud Run + the registrar.
- Full-suite pass counts before and after (`npx jest`). Baseline at time of
  writing: **3204 passed, 1 skipped, 84 of 85 suites** — plus ONE known
  flaky suite, `tests/courtexecutor.eventlog.test.js`, which fails only in
  the 00:00–04:00 UTC window (Detroit-vs-UTC "today" clamp; pre-existing,
  not yours to fix unless trivial).
- Nothing ships without Fred's explicit go. This touches every public link
  the firm sends; a wrong redirect strands live SMS intake links.

## Why this slice exists (context, verified 2026-08-16)

Staff-authorable content now executes on `app.4lsg.com` in front of the
public AND in staff browsers: landing pages (`routes/api.pages.js` — plain
jwtOrApiKey CRUD over raw HTML, served verbatim by `routes/pageLanding.js`
at `/p/:slug`; Fred has ruled pages stay UNGATED) and, since the reversal,
external form templates carrying `code`/`css`/`hooks`/embed (authoring
form_dev-gated; serving open). The staff JWT lives in localStorage on
`app.4lsg.com` (`public/index.html`). Consequence: any staff-authored page
or external form script on the app origin can read any logged-in staffer's
JWT — including the SU's — the moment they open the page.

**localStorage is origin-scoped.** Serve everything
staff-authorable-and-public from a DIFFERENT origin and that entire class
dies structurally: page JS there cannot read the app-origin JWT, cannot call
app APIs as the viewer, ever. That is this slice. The SU step-up rider
shrinks what a stolen token is worth in the meantime and after.

## Decisions already made — do not relitigate

- Pages stay ungated; external code/css/hooks/embed stay allowed; the
  warnings shipped in the previous patch stay. This slice is INFRASTRUCTURE,
  not policy.
- Both riders ship or the slice isn't done: (A) origin separation,
  (B) SU step-up.
- Step-up must be SIMPLE. Fred's words: "it has to be a simple move or I
  will want to rip it out." Env kill switch mandatory.

## Rider A — origin separation

### A1. Host choice (your decision, with Fred's constraints)

Fred rejected `lp.4lsg.com` ("weird"). His candidates: `pages.4lsg.com`,
`form.4lsg.com`, or **plain apex `4lsg.com`**. His real constraint is
salability: "the big boss" won't accept uglier URLs for an invisible risk.

**Recommended: the apex, `4lsg.com`** — because it flips the pitch from a
trade-off into an upgrade: `4lsg.com/f/intake?case_id=X` is SHORTER than
`app.4lsg.com/f/intake?...` (SMS character savings on every intake link),
and `4lsg.com/mypage` is a cleaner marketing URL than `app.4lsg.com/p/mypage`.
The boss pitch writes itself: *"your links get shorter and prettier"* — the
security is invisible, which is exactly how Fred wants to sell it. Also
consider serving landing pages at ROOT paths on the new origin
(`4lsg.com/mypage` — a host-scoped catch-all replacing the `/p/` prefix
there) since prefix-free URLs are the whole pitch; keep `/p/:slug` working
on the new host too for compatibility.

Verify before committing to the apex:
1. What answers on `4lsg.com` apex TODAY (fetch it; is it parked, redirecting
   to legalsolutions.group, or dead?). `go.4lsg.com` exists (legacy intake
   links), so the zone is controllable — ask Fred where DNS is hosted.
2. Cloud Run domain mapping supports apex only via A/AAAA records (or a load
   balancer); some registrars can't do ALIAS at apex. If the apex is
   infeasible or Fred's boss objects, fall back to `forms.4lsg.com` (forms)
   — and decide whether pages ride the same host (recommended: ONE landing
   host for both; two hosts is more moving parts for zero gain).
3. **Security check that must hold whatever you pick:** the landing host must
   be a DIFFERENT ORIGIN from `app.4lsg.com` (any other host string is —
   apex vs subdomain included), and no cookie anywhere may be set with
   `Domain=.4lsg.com` (host-only cookies everywhere; audit for any).

### A2. Host-routing middleware (the actual boundary)

Same Cloud Run service, one deploy. Early middleware keyed on the Host
header (config via env or app_setting, e.g. `landing_hosts` CSV):

- On a LANDING host, allow ONLY the public allowlist:
  `GET/POST /p/:slug` (+ root-path page serving if you adopt it),
  `GET /f/:form_key`, `GET /forms/render.html`, `GET/POST /api/ext/*`,
  and the static assets those pages actually load — inventory them from the
  files, at minimum `/css/yc-forms.css`, `/js/yc-forms.js`,
  `/forms/hooks/*.js`, favicon. Everything else on that host → the existing
  deadPage treatment (redirect to the firm site) or 404. **`/login`, the
  shell, and every staff/API route must NOT respond on the landing host** —
  if a JWT can be minted or used there, the origin boundary is decorative.
- On the APP host: `/p/*`, `/f/*`, and ext-mode render 301/302 to the
  landing host, **preserving the full query string** (case_id credentials in
  live SMS links). Decide 301 vs 302 (302 until Fred confirms stability).
  `routes/pageLanding.js` already contains vanity-host middleware — read it
  first; generalize it rather than building a parallel mechanism.

### A3. Hardcoded-host inventory (bundle these; ask Fred to run)

```sql
SELECT id, slug, host, path, status FROM pages ORDER BY id;
SELECT id, slug FROM pages WHERE html LIKE '%app.4lsg.com%';
-- sequence/SMS templates that carry form links (find the real table names
-- in the repo first — sequences, workflow step configs, scheduled jobs):
--   ... LIKE '%app.4lsg.com/f/%' OR LIKE '%go.4lsg.com%' OR LIKE '%/p/form%'
SELECT `key`, `value` FROM app_settings WHERE `value` LIKE '%app.4lsg.com%';
```

Known hardcodes from the repo copy of the form-host page
(`ref/pages/form.html`, and therefore probably the DB row): `FORM_BASE =
'https://app.4lsg.com/f/'` — the DB page HTML needs a one-line edit at
cutover. **Interaction with Phase D:** the staged SMS-cutover SQL
(`ref/2026-08-13_phase_d_sms_cutover.sql`) targets `app.4lsg.com/p/form` —
retarget it to the new host or explicitly defer; say which.

### A4. Things that will bite

- The `/:page` catch-all and route mount order (grep the comments in
  `routes/booking.js` / `routes/manage.js` — this concern is documented).
- `lib/rateLimiter` `getClientIp` behind the mapping — verify the
  X-Forwarded-For chain is unchanged on a mapped domain (same service, same
  Cloud Run ingress; confirm, don't assume).
- `/api/ext` CORS: the F1 hardening REMOVED the ACAO header — landing pages
  fetch it same-origin on the new host, so nothing needed; verify no
  regression and re-read the F1 arithmetic note before touching anything.
- Cert provisioning on a new domain mapping takes time — sequence DNS steps
  in the rollout note so Fred can do them ahead of the deploy.
- render.html and form.html fetch RELATIVE URLs — they work on any host;
  the absolute-URL problems are all in DB content (A3).
- `meta referrer no-referrer` + `robots noindex` on form.html must survive
  any page edits; landing host responses should send
  `X-Robots-Tag: noindex` for `/f/*` and ext render (credentialed URLs out
  of indexes) — decide and justify.

## Rider B — SU step-up (small, rippable)

Goal: a stolen/leaked staff JWT alone can no longer run the SU tools.
Password re-prompt with a short elevation window. Fred's UX requirement:
the prompt must be a REAL form input that password managers prefill —
`<form>` + `<input type="password" autocomplete="current-password">`
(a bare SweetAlert input often doesn't trigger managers; verify and use a
form-in-modal).

Shape (adjust to the repo, keep the diff small):

1. `POST /admin/elevate` (jwtOrApiKey, JWT-only): body `{password}`;
   bcrypt-verify against the CALLER's own `users.password_hash`; on success
   return a short elevation token — a JWT `{sub: userId, aud: 'su-elev',
   exp: now+15m}` signed with the existing `JWT_SECRET`. Rate-limit it
   (reuse the superuser rate-limit machinery, tool `elevate`). Audit both
   outcomes via `auditAdminAction`.
2. `lib/auth.superuser.js`: after the SU check, when `SU_STEPUP !== '0'`
   (env; default ON), require header `X-SU-Elevation` carrying a valid,
   unexpired token whose `sub` matches the caller. Missing/expired → 401
   `{error, code: 'elevation_required'}` (distinct code so the client can
   react; audit as `rejected_no_elevation`).
3. Shell (`public/index.html`) `apiSend`: on `code === 'elevation_required'`,
   open the password modal, POST /admin/elevate, stash the token in
   `sessionStorage` (tab-scoped, dies with the tab — deliberately NOT
   localStorage), set the header on retries and on all subsequent calls
   while unexpired, retry the original request once.
4. Kill switch: `SU_STEPUP=0` restores exact pre-slice behavior — the
   rip-out valve Fred demanded. Document it first in the rollout note.

Scope: every `superuserOnlyFor` tool (db_console, api_tester, users,
apiKeys, connections, systemAlerts, readonly-keys — enumerate from the
repo). One middleware, one route, one client interceptor — if you find
yourself touching more than ~4 files for rider B, stop and rescope.

## Deliverables

1. **Decisions**: chosen host + fallback, with the boss pitch written out
   (2–3 sentences Fred can forward verbatim); page URL shape on the new
   host; redirect codes; Phase D interaction; robots decision.
2. **The implementation** — `git apply`-ready patch, terminal instructions,
   full-suite counts before/after.
3. **Rollout note**: exact DNS records + Cloud Run domain-mapping steps for
   Fred; the DB content edits (A3) as paste-ready SQL; ordering; revert
   path for every piece (redirects off, `SU_STEPUP=0`, mapping removal).
4. **Update `ref/EXTERNAL_CODE_CSS_DECISION.md`** residual #1 → resolved by
   this slice (keep the history).
5. **Anything you decided NOT to do**, with reasons.

## Self-tests to include

- Landing host serves EXACTLY the allowlist (drive the express app
  in-process with a spoofed Host header): /p page renders, /f redirects to
  render, /api/ext GET+submit work; `/login`, `/api/firm-data`,
  `/api/form-templates`, the shell → 404/redirect. App host redirects
  `/p/*` and `/f/*` to the landing host WITH the query string intact.
- A page whose HTML contains `<script>` still serves verbatim on the
  landing host (pages stay ungated — lock it so nobody "fixes" it later).
- Step-up: SU route without elevation → 401 `elevation_required`; elevate
  with wrong password → 401 + audit; right password → token; retried call
  succeeds; expired token → 401 again; `SU_STEPUP=0` → old behavior;
  non-SU user cannot elevate into SU (elevation never substitutes for the
  SU check — it ADDS to it).
- No cookie in the codebase is domain-scoped to `.4lsg.com`.
- Full suite green (modulo the documented courtexecutor midnight flake).

## Escape hatches

- If apex mapping is infeasible at the registrar, present the subdomain
  fallback with the revised pitch and proceed — do not stall on DNS.
- If the DB inventory (A3) surfaces many hardcoded hosts in sequences,
  deliver the code slice with redirects (which keep old links working) and
  hand Fred the content-edit SQL as a separate, non-blocking list.
- If rider B fights the shell's apiSend structure, deliver rider A complete
  and rider B as a scoped plan — A is the structural fix; B must not sink it.
- If you find something worse than what is described here, lead with that.
