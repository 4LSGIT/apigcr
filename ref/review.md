# V1 → V2 Cutover Review

Generated: 2026-04-22. Scope: full read-only audit ahead of deleting `index.html` and replacing it with `a.html`.

Source documents:
- [files.md](files.md) — inventory (now annotated with classifications)
- This file — findings, blockers, and migration plan

Status legend used here and in `files.md`:

| Status | Meaning |
| ------ | ------- |
| `V2` | Authenticated via JWT/API-key and fits the V2 architecture. Inline `db.query` is fine — services exist only where the logic needs to be reusable |
| `V2-ok` | Same as V2, the inventory just hadn't caught up. Relabel only |
| `needs-migration` | Actively used V1 code with no V2 replacement yet |
| `legacy-keep` | Standalone tool or tied to a still-live integration — cannot delete |
| `legacy-remove` | Only referenced from `index.html` / V1 pages; safe to delete at cutover |
| `standalone` | Self-contained page served by `GET /:page` (JotForm embed, marketing page, one-off tool) — independent of V1 or V2 |
| `safe` | Dev/test utility, not security-sensitive |
| `unknown` | Defined but no callers found — verify intent before acting |

---

## 1. Cutover blocker (singular)

**The only thing actually blocking `a.html` from becoming the sole entry point is the admin "mySQL Query" tab.**

- `a.html:1583` calls `apiSend('/db-jwt', 'GET', { query })` — the only DB-shaped route `a.html` uses
- Because the admin tab exists, `AUTH_STATE` caches the plaintext password in memory (and silently re-logs-in on 401). Two TODO comments already flag this: [a.html](../public/a.html) ~line 1460 and ~line 1845
- Remove the admin tab (button + panel at lines 1572–1583) and move the admin's mySQL query needs into `dbConsole.html` (which is already V2 and uses `/admin/db/query`)
- Once the admin tab is gone, drop the plaintext-password cache and the silent-relogin path; switch to refresh-token flow

After that, nothing in the a.html tree depends on V1 routes or pages. Verified:
- a.html does **not** call `/create-case`, `/db`, `/db64`, `/unplacehold`, `/dropbox/*`, or `/logEmail`
- Every endpoint a.html or its sub-pages hit is on the V2 route list and auth-gated (152+ endpoints, all verified)
- `public/calendar.html`, loaded as an iframe, uses `parent.window.apiSend('/api/events')` and inherits JWT from the parent — V2-compatible in practice

---

## 2. V2 route auth — clean

All 33 V2 route files correctly enforce `jwtOrApiKey`. Three patterns in use, all sound:

1. Per-route: `router.get('/api/x', jwtOrApiKey, handler)` — majority
2. Superuser wrapper: `[...superuserOnly]` array (includes `jwtOrApiKey`) — `admin.dbConsole.js`
3. `/internal/*` routes mount `jwtOrApiKey` individually per endpoint — all verified

[lib/auth.jwtOrApiKey.js](../lib/auth.jwtOrApiKey.js) itself:
- Rejects missing/malformed `Authorization` header with 401
- Validates JWT signature + expiry (`jwt.verify`)
- Checks `payload.user_auth` starts with `"authorized"`
- Enforces global `JWT_VERSION` bump (global logout)
- Supports `x-api-key` via `process.env.INTERNAL_API_KEY`
- Audit-logs without leaking secrets (strips `authorization`, `x-api-key`, `cookie`, password fields)
- No bypass or debug mode

**No auth concerns in V2 route code.**

---

## 3. Legacy routes with security issues (independent of cutover)

These are *not* a.html blockers — a.html never calls them — but they're live, externally reachable, and use patterns we'd want gone regardless of the V1/V2 story. Each has an external integration we need to identify before deleting.

| # | Route | Risk | V2 replacement |
|---|-------|------|----------------|
| L1 | `POST /create-case` | Plaintext username+password in body + SQL string interpolation (**injection**) | `POST /api/intake/case` exists |
| L2 | `GET /db64` | Arbitrary SQL via plaintext creds (base64-wrapped) | `POST /admin/db/query` (superuser) |
| L3 | `GET /db` ([routes/dbQuery.js](../routes/dbQuery.js)) | Arbitrary SQL via plaintext creds | same as L2, or `/db-jwt` for read queries |
| L4 | `POST /unplacehold` | Plaintext creds | `POST /resolve` exists |
| L5 | `POST /dropbox/*` (create-folder, delete, rename, move) | Plaintext creds or shared `api_key` | `/internal/dropbox/*` is already V2 for create-folder; others need internal equivalents |
| L6 | `_ALL /ringcentral/send-sms`, `POST /ringcentral/send-mms` | `x-api-key` only | Defensible if truly internal-only; otherwise layer on `jwtOrApiKey` |
| L7 | `GET /isWorkday` | No auth | Add `jwtOrApiKey` |
| L8 | `GET /test-alert`, `GET /test-alert-bom` | No auth | Gate to `ENVIRONMENT === 'development'` |

Path to retire each: identify external callers (Pabbly, scripts, zaps, integrations), migrate them to the V2 replacement, then delete the route. `lib/unplacehold.js` dies with L4.

---

## 4. Public (no-auth) routes — verdict

From the route table in [files.md](files.md), these routes have no `jwtOrApiKey`. Each was checked.

**Intentionally public — no action:** `GET /:page` (static loader); `POST /hooks/:slug` (external webhook, HMAC-verified per-hook); `GET /api/public/docs/:caseId`, `POST /api/public/get-upload-link`, `POST /api/public/upload-complete` (public doc portal, rate-limited); `POST /login`, `POST /auth/forgot-password`, `POST /auth/reset-password` (pre-auth); `GET /date`, `GET /myip`, `GET /parseName` (utilities); `GET /internal/hello` (liveness); `GET /api`, `GET /newpath` (info); `POST /auth/P_validate` (Pabbly bridge, rate-limited); `GET /ringcentral/authorize`, `GET /ringcentral/callback` (OAuth); `POST /logEmail` (email-relay webhook intake).

**Action items:** L7 (`/isWorkday`), L8 (`/test-alert*`), L1–L5 above.

---

## 5. Blank-status file classifications

Non-obvious calls explained. Full list lives in [files.md](files.md).

### lib
- `logMeta.js` → **unknown**. No importers found. Either dead or planned; decide.
- `parseName.js` → **V2-ok**. Used by [routes/api.intake.js](../routes/api.intake.js):34.
- `unplacehold.js` → **legacy-keep**. Powers `POST /unplacehold` (L4). Delete with that route.

### services
- `dropboxService.js` → **legacy-keep**. Clean service; its route wrapper is the problem (L5).
- `resolverService.js` → **V2-ok**. Powers `POST /resolve`. Also used by `campaignService`, `lib/sequenceEngine`.
- `ringcentralService.js` → **V2-ok**. Used by `smsService` (V2) and `campaignService` (V2).
- `settingsService.js` → **V2**. Imported by `apptService.js:14` and `taskService.js:27`. *(Earlier classification as "no importers" was wrong.)*

### public (top level)
Split into three buckets:

**V1-only (tied to `index.html` flow) → legacy-remove at cutover:**
- `index.html` (V1 entry)
- `case.html`, `contact.html` (superseded by `case2.html`, `contact2.html`)
- `appt.html`, `apptform.html` (superseded by `apptform2.html`; served at `/appt` via `routes/pages.js`)
- `contactform.html` (only called from `contact.html` and `index.html`)

**Standalone utilities/landing pages — served via `GET /:page`, keep:**
- `caltest.html` — Michigan Tax Prep marketing/offer page
- `feedback.html`, `survey.html` — JotForm client-satisfaction iframes (shared as external links)
- `rating.html` — IT-call rating form (shared as external link, hardcoded Tailwind + funny responses)
- `mms.html`, `send-sms.html` — standalone RingCentral SMS/MMS tools (call `/ringcentral/send-*` with API key)
- `uploader.html` — standalone file-upload tool
- `caseerror.html` — case-error display
- `docs.html` — served at `/docs`
- `styleOpts.html` — 2.7 MB design-system exploration file. Verify it's not stale experiment data before keeping

**Audit for V1-isms before cutover:**
- `scripts.js` — loaded by BOTH `a.html` and V1 pages. Generic helpers (`E`, `copy`, `Toast`, …). Audit for V1-only code, but don't delete
- `calendar.html` → **V2-ok** (iframe, inherits parent auth)

**Safety check for the standalones (need verification):**
- `send-sms.html` / `mms.html` — do these currently work for anyone who can open the URL? `/ringcentral/send-sms` gates on `x-api-key`. If the page has the key baked in, that's a problem. If it prompts the user, that's fine. Verify.
- `uploader.html` — what route does it POST to? If `/api/upload` (V2 jwtOrApiKey) then auth-gated; if something else, verify.
- `caltest.html` — purely static marketing, no backend calls? If so, no concern.
- `rating.html` — what endpoint does it submit to? If no auth is needed (public rating form) that's acceptable; verify it doesn't POST to a protected route expecting silent auth.

### tests
- `test-cron.js`, `test_classifier.js` → **safe**. Ad-hoc scripts.

### scripts
- All three backfill scripts → **safe**. One-shot migrations, completed.

### routes
- `create-case.js` → **needs-migration** (L1).
- `db.jwt.js` → **V2-ok**. Powers the admin "legacy mySQL query" panel (the one a.html uses; see §1).
- `db64.js` → **legacy-remove** (L2).
- `dbQuery.js` → **legacy-keep** until L3 callers move.
- `dropbox.js` → **legacy-keep** (L5).
- `functions.js` → **legacy-keep**. `/date`, `/myip`, `/parseName` utilities.
- `logs.js` → **legacy-keep**. `POST /logEmail` email-relay webhook intake.
- `pages.js` → **legacy-keep**. Trivial static routes (`/appt`, `/docs`). Prune individually if unused.
- `resolver.js` → **V2-ok**.
- `ringcentral.js` → **legacy-keep** (L6).
- `temp_auth_validate.js` → **legacy-keep**. Pabbly bridge; sunset with the rest of the plaintext-password exposure.
- `unplacehold.js` → **legacy-keep** (L4).
- `upload.js` → **V2-ok**.

### also on disk, not in inventory
- `public/css/yc-forms.css` → **V2**. Form stylesheet. Added to inventory.

---

## 6. Recommended order

**To unblock cutover (minimal):**
1. Remove the admin "mySQL Query (legacy)" tab from a.html — button at ~line 1540, function + iframe at ~lines 1572–1583. Use `dbConsole.html` (already V2) for admin query needs.
2. Drop the plaintext-password cache from `AUTH_STATE` + the silent-relogin path. Replace with refresh-token flow.
3. Relabel the V2-ok items in `files.md` (inventory hygiene only, no code change).
4. Delete `index.html` and the V1-only pages (`case.html`, `contact.html`, `appt.html`, `apptform.html`, `contactform.html`). Watch logs for 404s on `/case`, `/contact`, `/appt` for ~a week.

**Security cleanup (independent track, any time):**
5. Retire L1–L5 in order: `/create-case`, `/db64`, `/db`, `/unplacehold`, `/dropbox/*`. Each = identify callers → migrate to V2 replacement → delete the route.
6. Add `jwtOrApiKey` to `/isWorkday` (L7), gate `/test-alert*` to dev (L8), decide on `/ringcentral/*` auth (L6).
7. Sunset `routes/temp_auth_validate.js` once Pabbly no longer needs it.

**Inventory housekeeping:**
8. Delete the dead `testSwalPage()` admin button (a.html:1540 + function at :1473) — the target `public/testswalpage.html` doesn't exist.
9. Decide on `lib/logMeta.js` — adopt or delete.
10. Audit `public/scripts.js` for V1-only functions; prune if any.
11. Verify the standalone pages (`send-sms.html`, `mms.html`, `uploader.html`, `rating.html`, `caltest.html`) don't bake in secrets or POST to protected routes expecting silent auth.
