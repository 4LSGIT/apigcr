# AUDIT_TENANCY.md — YisraCase multi-tenancy readiness inventory (COMBINED v2)

**Scope:** read-only factual inventory for the tenancy arc (P0 DB chokepoint, P3/P4 scoping). No code, schema, or infra changed. Inventory, not design review.

**Provenance:** this document merges two independent audits of the same commit (audit-1 and audit-2). Every claim either survived cross-verification or was re-verified fresh on 2026-10-05; where the two audits disagreed, §5 records the discrepancy and the ruling. Line citations in this merged document were re-checked against the working tree.

- **Repo:** `4LSGIT/apigcr` @ `540a27bcbafa69e8ca5754e6033704af88690fbd` (shallow clone, `main`).
- **Live DB:** readonly key → schema `dbnwqdrfyz9vmq`, MySQL **8.4.6-6**. RO user `uilnnfwkvf7b3@35.227.91.145` holds `GRANT USAGE ON *.*` + `GRANT SELECT ON dbnwqdrfyz9vmq.*` **only** (live `SHOW GRANTS`) — see §E5 for what that makes unverifiable.
- **Sweep scope:** production code (`lib/ routes/ services/ startup/ scripts/ public/ views/ server.js`); `tests/` excluded except where noted.
- Target model assumed for classification: DB-per-tenant MySQL + `yc_master` registry, tenant by hostname (`tenant_hosts`), `app.4lsg.com` = tenant #1.

---

# A. Database access

**Search patterns used:** `createPool|createConnection` · `^(const|let|var) .*require\(.*(startup/db|dbReadonly)` and all-position `require(..startup/db..)` quote-forms · `req\.db` · `withTransaction\(|beginTransaction|START TRANSACTION|\.commit\(\)|\.rollback\(\)|\.getConnection\(` · `information_schema|DATABASE\(\)` · `` FROM/JOIN/INTO `?x`?\.`?y `` db-qualified SQL · module-scope `^(let|var)` and `^const .*= (new Map|new Set|{}|[])` state sweeps · `GET_LOCK|RELEASE_LOCK` · `setInterval\(`.

## A1. Pool / connection creation sites — 5 total

| file:line | what | notes |
|---|---|---|
| `startup/db.js:43` | `mysql.createPool({host: process.env.host, user, password, database, timezone:"Z", connectionLimit:10, maxIdle:8, idleTimeout:30s})` | **The** app pool. Promise-wrapped singleton exported at `:167`. Two decorations a tenant factory must reproduce: transient-retry wrappers on `query`/`execute` (`:129-151`, incl. the codeless `fatal:true` closed-state match `:119-123`) and `withTransaction` bound onto the pool (`:164-165`). No `port` read — main pool is always 3306. |
| `startup/dbReadonly.js:28` | RO pool (`user_ro`/`password_ro`, host/db fall back to main; `port_ro \|\| port \|\| 3306`), limit 3, `multipleStatements:false`, bigNumberStrings | `module.exports = promisePool` at `:85`. |
| `scripts/dump-schema.js:134` | one-off pool, main env creds (`dbConfig()` `:98-106`) | schema dump |
| `scripts/encrypt-smtp-passwords.js:35` | one-off pool (+ `DB_PORT` at `:40`) | migration script |
| `scripts/backfill-password-hashes.js:30` | one-off pool (+ `DB_PORT` at `:35`) | migration script |

## A2. How modules obtain a handle

**The architecture is already clean.** `server.js:171-174` attaches `req.db = db`; services take `db` as a positional parameter throughout. Fresh counts (re-verified): **136 route files** (`routes/**/*.js(x)`), **125 use `req.db`**; of the 11 that don't, **9 touch no DB directly** (`_errtest.js, alert-test.js, api.pdf.js, badge-ask-route.js, cal.js, functions.js, internal.js, manuals.js, pages.js`) and **2 capture the pool at module scope** (`db64.js`, `dbQuery.js`, below). `services/`: **zero** module-scope captures of the app pool (the only service-level capture is the **readonly** pool, `reportService.js:65`). The async machinery is parameter-passing, not capturing: `executeJob(job, db)` `lib/job_executor.js:52`, `executeWebhook(db, opts)` `lib/webhookExecutor.js:64`, `advanceWorkflow(executionId, db)` `lib/workflow_engine.js:147`, `enrollContact(db,…)` `lib/sequenceEngine.js:482`, every `domainEventDrain`/`hookService`/`alerting` entry.

### Module-load-time captures — the P0 list (7 boot sites + 1 lazy + 2 legacy + 2 RO)

| # | file:line | capture | why it matters |
|---|---|---|---|
| A2-1 | `server.js:10` | `const db = require("./startup/db")` | Root capture; feeds the six boot consumers below. |
| A2-2 | `server.js:67` | `appBuild.refreshMinBuild(db)` in the build-header middleware | Runs on **every** request incl. static; reads `app_settings.min_client_build` via the captured pool into a global cache (`lib/appBuild.js:117`). |
| A2-3 | `server.js:135` | `pageHostMiddleware(db)` closure (`routes/pageLanding.js:569`) | Mounted **before** `req.db`; sets `req.db = db` itself at `pageLanding.js:591, :657, :676`. **This is the host-resolving middleware — the natural tenant-resolver seat.** |
| A2-4 | `server.js:179` | `responseObserver(db)` | 5xx observer closure. |
| A2-5 | `server.js:188, :200` | `alert(db,…)` in `process.on("unhandledRejection"/"uncaughtException")` | Process-level: under tenancy every tenant's crashes land in one DB — needs a platform sink decision. |
| A2-6 | `server.js:224` | `errorMiddleware(db)` | Error middleware closure. |
| A2-7 | `server.js:226` | `init(db)` → `fieldDefReconciler.scheduleReconcile(db, {trigger:'boot'})` (`startup/init.js:32`) + `taskQueue.warmup()` (`:31`) | Boot-time per-instance DDL reconcile against **one** DB; needs a per-tenant loop. |
| lazy | `lib/firmConfig.js:105, :111` | `let dbRef = null; … dbRef = require('../startup/db')` on first `cfg()` — never released | Plus the flat un-keyed cache below. **The second P0-class blocker, independent of the pool.** |
| legacy | `routes/db64.js:5` | `const db = require("../startup/db")` (used for `query_log` inserts `:36`) | `trap("db64")`-wrapped for retirement (`lib/legacyTrap.js:5-6`). **Deleting beats refactoring.** |
| legacy | `routes/dbQuery.js:8` | identical | `trap("dbQuery")`. |
| RO | `routes/api.readonly.js:23` | `const roPool = require("../startup/dbReadonly")`; `getConnection` at `:99` (per-request `SET SESSION MAX_EXECUTION_TIME` `:100`) | |
| RO | `services/reportService.js:65` | same; report SQL deliberately pinned to the SELECT-only grant (`:399`) | |

`lib/firmConfig.js:106` — `let cache = {}` — is a flat, un-keyed map of all **18** REGISTRY values (count re-verified; see §5-2). `cfg()` is **synchronous by design** (`:160-173`) and the module is required by **39 files** (fresh `grep -rln` count), several reading at module scope. Threading a tenant through it is a signature change across the whole config surface — or an ambient tenant context (AsyncLocalStorage precedent already in-tree at `lib/domainEvents.js:99`). **This is the real P0, more than the pool.**

Scripts (10) require the pool at run time and need a tenant/env parameter: `scripts/backfillAppts.js:45`, `backfillCampaignContacts.js:79`, `backfillCaseRoleIds.js:150`, `seedRoleContacts.js:346`, `verifyTrusteeReadthrough.js:169`, `reviveScalarReplacedValues.js:152`, `customFieldsS5Seed.js:187`, `esign_e2e_check.js:62`, `esign_zoho_smoke.js:71`, `courtBacktest.js:29`.

## A3. Process-global caches holding tenant/firm data

Not pool captures, but they defeat per-tenant resolution just as completely — a cache keyed by `entity`/`table`/`key_hash` serves tenant A's value to tenant B on the same instance.

| file:line | cache | keyed by | what leaks across tenants |
|---|---|---|---|
| `lib/firmConfig.js:106` | `cache = {}` | *nothing* | all 18 firm-config values (incl. `internal_api_key` — auth-critical, §D3) |
| `lib/internal_functions/db.js:464` | `_schemaCache = new Map()` | `table` | **column whitelist for `update_db` writes** — with custom fields, tenant schemas genuinely diverge |
| `services/fieldDefService.js:207-208` | `_cache`, `_colCache` | `entity` | **tenant-defined field definitions** + writable-column sets (`_gen` at `:206`) |
| `lib/apiKeys.js:36-37` | `cache` (by `key_hash`), `touched` (by `id`) | no tenant axis | api_keys row; cached `rec.id` is per-tenant, replayed into `touchLastUsed(db, id)` against whatever DB is current — wrong-row stamping + cross-host auth bleed (§D3) |
| `lib/auth.superuser.js:133` | `hits = new Map()` (key `` `${tool}:${userId}` `` at `:167`) | bare userId | tenant A user 7 and tenant B user 7 share one rate bucket (`limitCache` at `:141` is the harmless per-tool limit memo) |
| `services/pageService.js:206-222` | `hostCache` Set, 60s TTL | host | vanity-host set from one DB's `pages` table — direct ancestor of the `tenant_hosts` lookup |
| `services/phoneIngestService.js:130` | `_firmNumberCache` | *nothing* | firm's active phone numbers; process-lifetime, manual invalidate (`:123-127`) |
| `services/calendarTypeService.js:145, :269` | `_cache`, `_optCache` | *nothing* | calendar-type registry |
| `services/emailIngestService.js:104` | `_domainsSet = new Set(['4lsg.com'])` | *nothing* | internal/external email classification; 4LSG-literal default |
| `routes/logs.js:86` | `_domainsParsed = ["@4lsg.com"]` | *nothing* | same, second copy |
| `services/formPdfService.js:467` | `_logoCache` | url | firm logo data-URI (keyed by URL — thrashes rather than corrupts) |
| `services/documentSyncService.js:2012` | `_inventoryCache` | *nothing* | Dropbox sync inventory |
| `services/availabilityService.js:505` | `_freeBusyCache = new Map()` | (see file) | GCal free/busy |
| `services/oauthService.js:51` | `inFlightRefreshes` | credential id | per-tenant credential ids collide |
| `services/fieldDefReconciler.js:527-528` | `_inFlight`, `_followUp` (holds a `db` ref) | *nothing* | **tenant A's reconcile suppresses tenant B's** — follow-ups collapse into one |
| `lib/appBuild.js:117` | `minCache` | *nothing* | `min_client_build` from a per-tenant table, cached globally |
| `lib/portalCardEngine.js:583` | `_alertedCardKeys` | card key | alert dedupe collides |
| `lib/errorMiddleware.js:35` | `stormState = new Map()` | routeKey | 5xx storm counters aggregate across tenants |
| `routes/videoLanding.js:74` | `TEMPLATE_CACHE` | *nothing* | `views/v.html` (carries hardcoded firm branding) |
| `routes/admin.dbConsole.js:74`, `routes/admin.apiTester.js:161` | `schemaReady` | *nothing* | bootstrap flag |
| `lib/auth.jwtOrApiKey.js:22` | `lastForcedRefreshAt` | *nothing* | yci refresh throttle (minor) |
| `services/videoService.js:277` | `_jsonOverlapsSupported` | *nothing* | per-**server** capability probe — safe only while all tenants share a MySQL version (live: 8.4.6 ≥ 8.0.17, supported) |
| `services/ringcentralService.js:20-23` | `tokenData`, `refreshPromise`, … | *nothing* | **the firm's RingCentral OAuth token in process memory** (legacy; retirement checklist `startup/init.js:38-56`) |
| `services/dropboxServiceLegacy.js:46-47` | `cachedToken`, `tokenExpiresAt` | *nothing* | **the firm's Dropbox access token** (legacy) |

Benign platform singletons checked and excluded: CloudTasksClient (`lib/taskQueue.js:135-137`), puppeteer (`services/pdfRenderService.js:68, :176-179`), esign test seams (`services/esignService.js:298, :427`), in-memory IP rate limiters (`lib/rateLimiter.js:34-41`, `routes/pageLanding.js:72`, express-rate-limit instances).

**Boot-frozen firm constants (not caches, same effect):** `FIRM_TZ`/`DEFAULT_TZ` = `process.env.FIRM_TIMEZONE || 'America/Detroit'` captured at module scope in **six independent files** — `services/timezoneService.js:44` (re-exported; **25 files** require timezoneService, fresh count), `services/calendarService.js:25`, `services/documentGenerateService.js:60`, `services/formPdfService.js:93`, `services/esignFilingService.js:82`, `routes/api.streak.js:86`. The exclusion is documented design: `lib/firmConfig.js:45-48` (*"a hot-reload would split one process across two zones mid-flight … It stays env-only; changing it is a migration event"*).

## A4. `withTransaction`

- Definition: `lib/withTransaction.js:58` — `withTransaction(db, fn, {retries=1})`; `getConnection`+`beginTransaction` at `:65-66`; own transient-retry set mirroring the pool wrapper (`:30-44`). Bound onto the pool at `startup/db.js:164-165`.
- **Call sites: 67** non-comment (fresh count; 54 in the bound `db.withTransaction(…)`/`req.db.withTransaction(…)` form) across 21 files: `lib/internal_functions/db.js`, `lib/workflow_engine.js`, `routes/{api.streak, process_jobs, sequences, workflows}.js`, `services/{apptService, campaignService, contactAddressService, contactEmailService, contactPhoneService, contactService, emailIngestRuleService, fieldDefService, hookService, phoneIngestRuleService, pipelineAdminService, pipelineService, triggerService, videoService}.js`. All take `db` from a parameter or `req.db`.
- **Transaction code NOT going through it — exactly one span:** `services/caseService.js:2186` `getConnection` → `:2188` `beginTransaction` → `:2379` `commit` / `:2381` `rollback` / `:2385` `release` (case-merge). Takes `db` as a parameter, so not a tenancy blocker — but it won't inherit future `withTransaction` changes. Divergence from the "everything goes through withTransaction" doctrine, §4-11.
- Direct `getConnection()` that is **not** a transaction (session-scoped, legitimate): `GET_LOCK` pinning `routes/booking.js:734`, `routes/manage.js:717`, `services/fieldDefReconciler.js:344`; single-connection multi-read `lib/unplacehold.js:178`; RO per-request session `routes/api.readonly.js:99`, `services/reportService.js:399`.
- Oddity: `routes/unplacehold.js:20` calls `db.getConnection((err,c)=>…)` **callback-style on the promise pool** — the promise pool ignores the callback, so this login-attempt logger appears **inert**. Pre-existing; noted.
- (`lib/schemaDump.js:265` emits literal `START TRANSACTION;` into dump output — not executed SQL.)

## A5. DB-qualified SQL — none

**Zero hits** for `FROM|JOIN|INTO <db>.<table>` across `routes/ services/ lib/` (two false positives in comment prose: `routes/api.esign.actions.js:17`, `routes/api.calendarRange.js:28`). Every `information_schema` query is connection-scoped via `TABLE_SCHEMA = DATABASE()`: `lib/internal_functions/db.js:471-472`, `lib/schemaDump.js:31, :56-101`, `routes/admin.dbConsole.js:351-381`, `services/esignTemplateService.js:790`, `services/fieldDefReconciler.js:286, :292`, `services/caseService.js:1695`, `services/fieldDefService.js:371, :1098`. The dump deliberately omits the DB identifier (`ref/database.sql:5`).

**This is the single best piece of news in the audit:** switching the pool's `database:` switches every query in the app with no SQL edits.

## A6. Readonly + scratch route connections

| route | pool | file:line |
|---|---|---|
| `POST /api/readonly/sql` — query execution | **RO pool** | `routes/api.readonly.js:23, :99` (per-query `MAX_EXECUTION_TIME` `:100`) |
| `POST /api/readonly/sql` — audit insert (`readonly_query_log`) | **`req.db`** (RW) | `routes/api.readonly.js:61` |
| `PUT/DELETE /api/scratch/:ns/:k` | **`req.db`** (RW — the RO pool physically cannot write) | `routes/api.scratch.js:55, :98, :143, :178` |
| report body SQL | **RO pool** | `services/reportService.js:399` |

`startup/dbScratch.js` is named in the teardown checklist (`startup/dbReadonly.js:102, :109`) but **does not exist** — scratch rides the main pool. Doc/code divergence, §4-9.

## A7. Named locks — `GET_LOCK` names are server-global, not schema-scoped

Under DB-per-tenant on a **shared MySQL server**, these five collide across tenants (three are built from per-tenant integer ids):

| file:line | lock key | collision shape |
|---|---|---|
| `services/fieldDefReconciler.js:88` | `'field_defs_reconcile'` | **total** — one tenant's reconcile blocks all |
| `services/ringcentralService.js:87` | `'rc_token_refresh'` | total (legacy) |
| `services/oauthService.js:437` | `` `oauth_refresh_${credentialId}` `` | credential id 8 in A ≡ id 8 in B |
| `services/pipelineService.js:865` | `` `pipeline_case_${caseId}` `` | case-id collision |
| `routes/booking.js:733` / `routes/manage.js:716` | `` `book:${providerId}` `` | provider (user) id collision |

Non-issue if each tenant gets its own MySQL instance; a correctness bug the day two share one.

## A8. Summary

| Fact | Value |
|---|---|
| Pool creation sites | 5 (2 app, 3 scripts) |
| App-pool module captures | 3 (`server.js:10`, `db64.js:5`, `dbQuery.js:8`) + 1 lazy (`firmConfig.js:111`) |
| Boot consumers of the captured pool | 6 (`server.js:67,135,179,188/200,224,226`) |
| RO-pool module captures | 2 |
| Route files / using `req.db` | 136 / 125 (9 of the rest touch no DB directly, 2 are the legacy captures) |
| Services capturing the app pool | **0** |
| `withTransaction` call sites (bound form) | 67 (54) |
| Transaction spans outside it | 1 (`caseService.js:2186-2385`) + 1 inert callback oddity (`routes/unplacehold.js:20`) |
| DB-qualified SQL / unscoped information_schema | **0 / 0** |
| Process-global caches holding tenant data | ~24 (table above) |
| Independent module-scope TZ captures / timezoneService importers | 6 / 25 |
| Server-global named locks | 5 |

---

# B. Firm assumptions (the flush-list)

**Search patterns used:** `4lsg` (case-insensitive — case-sensitive misses `DOCS@4LSG.COM`) · `app\.4lsg` · `metrodetroitbankruptcylaw|mdbl|legalsolutions\.group|yisracase\.com|metrodetroitlitigation` · `@4lsg|stuart|email_it|alert_*|sms_*from|IT_EMAIL|AUTO_EMAIL|FIRM_EMAIL|EMAIL_DOMAIN|noreply` · `2484179800|2485592400|2486213656|248[-. ]?\d{3}[-. ]?\d{4}|\+1248|FIRM_PHONE` · `FIRM_TZ|FIRM_TIMEZONE|America/Detroit|America/New_York|Detroit` · `Dropbox|Clio|gmail|gcal|RingCentral|Pabbly|Zoho|GCS_BUCKET|Twilio|hebcal` · `process\.env\.[A-Za-z_0-9]+` + bracket form · `getSetting|getSettings|app_settings WHERE` · `DEFAULT_CREDENTIAL|PINNED_CREDENTIAL|credential_id = \d` · `https?://` literal bucketing.

## B1. Architecture first

Firm state lives in three buckets; the middle one is the finding:

- **(a) registered** — `lib/firmConfig.js:54-103`: an **18-key** REGISTRY resolving `app_settings` row → env → legacy env → null, cached 60s, `cfg()` throws on unknown keys (`:162`). The env→settings migration here is complete: no live `process.env.IT_EMAIL / FIRM_EMAIL / AUTO_EMAIL / FIRM_PHONE` reads exist outside the registry (IT_EMAIL survives only in a comment, `lib/firmConfig.js:16`).
- **(b) unregistered** — `services/settingsService.js:22` `getSetting(db, key)` over `app_settings` with **no key registry**: ~48 firm keys reach the table as free-text literals across ~60 call sites; `routes/api.appSettings.js` validates by the row's own `type` column (`TYPE_VALIDATORS` `:68`). **No single place enumerates the settings surface — that is itself the finding.**
- **(c) hardcoded** — literals below.

## B2. Blast-radius ranking

### CRITICAL — fires external side effects on 4LSG accounts/recipients if a second tenant runs unscoped

| file:line | verbatim (trimmed) | system |
|---|---|---|
| `services/dropboxService.js:129, :219` | `DEFAULT_CREDENTIAL_ID = 8` fallback | **Dropbox** — tenant B's documents land in 4LSG's Dropbox |
| `routes/api.temp.dropbox.js:66` | `PINNED_CREDENTIAL_ID = 8` | Dropbox proxy |
| `services/documentGenerateService.js:72` | `DEFAULT_UNSORTED_PATH = '/  Law Office/   Cases/  Unsorted Generated Documents'` | Dropbox folder tree (double spaces load-bearing — `routes/api.appSettings.js:41-44`) |
| `services/uploadTargetService.js:74` | `'/  Law Office/   Cases/  Unsorted Client Uploads'` | Dropbox |
| `services/formPdfService.js:108` | `'/  Law Office/   Cases/  Unsorted Form Submissions'` | Dropbox |
| `services/esignFilingService.js:94` | `'/  Law Office/   Cases/  Unsorted E-Signed Documents'` | Dropbox |
| `services/dropboxServiceLegacy.js:30-34` | `DROPBOX_APP_KEY/_SECRET/_REFRESH_TOKEN` env; **throws at module load if unset** (`:34`) | Dropbox (legacy) |
| `services/gcalService.js:66-67` | `DEFAULT_CREDENTIAL_ID = 11` (*"Google Workspace - Stuart@4lsg.com"*), `DEFAULT_CALENDAR_ID = 'primary'` | **Google Calendar** — a named individual's calendar |
| `services/courtExecutor.js:164, :167, :171` | `TIMED_COURT_CALENDAR_ID = 'primary'` (*"Stuart's OWN Google calendar"*, `:158`), `COURT_EVENT_PROVIDER = 1`, `SHOW_CAUSE_TASK_FALLBACK_USER = 5` | GCal + **bare user ids 1 and 5** hard-bound to 4LSG staff |
| `services/gContactsService.js:54, :64` | `DEFAULT_CREDENTIAL_ID = 11`; `DEFAULT_EXCLUDE_DOMAINS = ['4lsg.com']` (const, never re-read) | **Google People** |
| `routes/api.temp.clio.js:60` / `api.temp.ringcentral.js:110` / `api.temp.zohosign.js:48` | `PINNED_CREDENTIAL_ID = 7 / 9 / 13` | Clio / RingCentral / Zoho Sign proxies (⚠️ TEMPORARY) |
| `services/aiService.js:67` | `ANTHROPIC_CREDENTIAL_ID = 12` | **Anthropic API billing** |
| `services/ringcentralService.js:13` | hardcoded Pabbly webhook URL (`connect.pabbly.com/workflow/sendwebhookdata/IjU3…_pc`) | **Pabbly workflow token in source** (legacy) |
| `services/ringcentralService.js:128, :419`; `routes/ringcentral.js:38-39` | `RINGCENTRAL_CLIENT_ID/SECRET`, `REDIRECT_URI`, inbound `RINGCENTRAL_API_KEY` (also accepted via **query string**) | RingCentral (legacy) — most tenant-hostile inbound auth in the app |
| `lib/internal_functions/court.js:639, :644-645` | from-fallback `automations@4lsg.com`; default recipients `` `stuart@4lsg.com, Rena@4lsg.com, ${itAddr}` `` (itAddr fallback `it@4lsg.com`) | **email — two named staff as default recipients** (actual sends) |
| `lib/internal_functions/trustee.js:85-86, :330-331` | `debug_email_to = 'it@4lsg.com'`, `debug_email_from = 'IT@metrodetroitbankruptcylaw.com'` — no `cfg()` path | email |
| `routes/api.sending.js:126, :132, :134, :143, :145, :156, :157` | `DOCS@4LSG.COM` in client SMS + email copy; portal link `` `https://app.4lsg.com/docReq?case=${case_id}` `` — no settings path | **client-facing comms** |
| `…@4lsg.com` from-address fallbacks firing exactly in the fresh-tenant (empty-config) case | `lib/internal_functions/connections.js:339-340`, `lib/internal_functions/reports.js:322`, `routes/api.issueReports.js:50-51`, `routes/api.featureRequests.js:26-27`, `routes/api.checklists.js:1352`, `routes/api.alertIt.js:199`, `routes/auth.password.js:37-38`, `services/portalDocsService.js:508`, `services/taskService.js:761-762` | email |
| `services/portalAuthService.js:137, :176` | `portal_sms_counter` — one shared `app_settings` row read+written | **tenants cross-charge each other's SMS quota**; 7 more watermark rows share the shape (§B4) |
| Shared `JWT_SECRET` | §D2 | cross-tenant auth — listed here because the blast is data access, not display |

### MODERATE — wrong timezone / display / links / classification

| file:line | fact |
|---|---|
| 6 module-scope TZ captures + 25 timezoneService importers (§A3) | tenants in different zones cannot share a process; `services/taskService.js:662, :694` compute reminder times in the one global zone; `services/triggerService.js:586` cron band assumes the Detroit offset |
| `lib/firmConfig.js:264` + 12 more `\|\| 'https://app.4lsg.com'` fallbacks | `routes/api.issueReports.js:52`, `routes/taskActions.js:65`, `routes/auth.password.js:39`, `services/eventService.js:2597`, `services/taskService.js:87`, `lib/internal_functions/db.js:124`, `lib/internal_functions/appointments.js:424`, `lib/internal_functions/events.js:413`, `lib/internal_functions/portalCallback.js:66`, `lib/job_executor.js:216, :281` (live SMS task links) — a tenant with a blank `app_url` sends 4LSG's host in its own client comms. (`routes/api.oauth.js:62` names it in error text only.) |
| `routes/manage.js:473` | `GET /api/manage-config` — **no credential of any kind**; serves one firm's branding to every tenant's clients |
| `services/emailIngestService.js:104` · `routes/logs.js:86` · `services/gContactsService.js:64` | firm-domain singletons driving internal/external classification |
| `routes/api.redirects.js:88, :94, :95` | logo fallback `https://iili.io/Jy2nXHv.md.png` (third-party host), phone fallback `'(248) 559-2400'`, email fallback `info@4lsg.com` |
| `services/firmBlocksService.js:54` | `HEBCAL_ZIP = '48075'` — firm ZIP drives candle-lighting blocks |
| `public/manage.html:260`, `public/book.html:346` | `var FIRM_TZ = 'America/New_York'; // matches the server's FIRM_TZ` — **the comment is false** (server is `America/Detroit`); latent today (identical offsets), breaks on the first non-Eastern tenant |
| `public/index.html:3998` (+ `:2468, :4007, :4241`), `public/tasks.html:429`, `public/forms/liveHost.html:168` | frontend `America/Detroit` defaults |
| `routes/api.jwt.js:25` (`GET /clio-code`) + `public/index.html:3005, :3063` | Clio 2FA-code relay — firm workflow baked into shell + route |
| `routes/renaReminder.jsx` (`:7` APP_URL, `:21` env `API_KEY`, `:33` route) | firm-staff-named surface |
| `landing_hosts`/`pages.host` machinery | per-tenant-correct via DB, but `pageService.hostCache` + firmConfig caches must tenant-key first |

### LOW — cosmetic / scripts / deploy-plane

- `legalsolutions.group` favicon/site links in **10 files** (9 `public/*.html`: `feedback, appt, index, docs, case, manage, docReq, survey, book` + `views/v.html:7-9, :237-238`).
- Bare `https://4lsg.com` in client-facing JS/HTML: `public/videoManager.html:644`, `public/js/videoInsert.js:84`, `public/scripts.js:1962, :2486`, `public/index.html:463, :2249, :2311`, `public/campaign.html:234, :285`, `public/bookingviewsmanager.html:434`, `public/sendingform-bk.html:426, :449, :1246`, `public/sendingform.html:257`.
- `public/bookingviewsmanager.html:437` `DEFAULT_FOOTER_HTML` with `tel:+12484179800` + `office@4lsg.com`; `public/docReq.html:121, :171, :173` (logo, `248-417-9800`, `mailto:office@4lsg.com`); firm GCS asset URLs `public/sendingform-bk.html:1180-1245`; `public/appt.html:586` logo hosted under Stuart's personal Jotform account; `public/forms/issn.html:576` Calendly embed prefilled `a2=Stuart%20Sandweiss`; `public/sendingform*.html` Zelle note to `stuart@metrodetroitlitigation.com` (a fourth firm domain); outside vendor name+phone in client copy `public/sendingform-bk.html:234, :1077, :1325`.
- `scripts/gen_signatures.js:22-70` — the firm's whole identity as consts: street address (`:22`), fax `248-971-1500` (`:23`), two-brand registry (`:30+`), staff directory with phones/emails (`:52-62`), `+1` hardcoded (`:87`).
- Deploy-plane identifiers: `Dockerfile:5`, `Dockerfile.base:31`, `cloudbuild.yaml:36-44`, `package.json:4`.
- Jurisdiction pinned in AI prompts: `lib/aiPrompts/courtExtract.js:25` (MIEB/MIWB), `lib/aiPrompts/reportBuild.js:67`; court filters `routes/courtPreview.js:60, :65, :70` (`from_email LIKE '%mieb%'`).
- Doc examples (`info@4lsg.com`, `stuart@4lsg.com`) in function metadata: `lib/internal_functions/communication.js:137, :162`, `forwarding.js:351-370`, `reports.js:380, :386`, `court.js:690-692`; `services/esignPrefillService.js:100` comment uses `2484179800` as a format example.
- Script endpoint pins (`https://app.4lsg.com`): `scripts/sweep_validate_live.js:26`, `verify_strictstring_live.js:19`, `courtSummaryTest.js:36`, `dbkq_v12_polish.js:204`, `test_email_ingest_crud.js:16`, `esign_e2e_check.js:68`, plus `APP_URL=` examples in two cleanup scripts.

**Explicit no-hits (both audits, reconciled):** `yisracase.com` — zero anywhere (the product name "YisraCase" appears in comments only); `2486213656` — zero in production code (4 hits in `tests/` fixtures only); Twilio — not used (Quo + RingCentral); `no-reply` — none; `process.env.FIRM_PHONE` — none (settings key is `fe-firm_phone`; `firm_phone` exists only as a response field name, `routes/manage.js:206`). The three alert/SMS numbers live in DB settings, not code (`sms_default_from`/`sms_staff_from`/`alert_critical_sms_to`; consumers `lib/alerting.js:146-150`, `routes/api.alertIt.js:220-225`, `routes/booking.js:817-823`, `lib/internal_functions/decisions.js:466`) — per-tenant DB makes them tenant-correct for free.

## B3. `process.env.*` — 73 distinct names (production + scripts)

**FIRM — differ per tenant (23):** `FIRM_TIMEZONE` (6 captures + `routes/api.firmData.js:125`) · `APP_URL` (`routes/renaReminder.jsx:7`; registry fallback) · `IT_EMAIL` (comment-only) · DB wiring `host/user/password/database` + `host_ro/user_ro/password_ro/database_ro/port_ro` (per-tenant **values**; the mechanism is the platform's — they move into the `yc_master` registry under tenancy) · `DROPBOX_APP_KEY/_SECRET/_REFRESH_TOKEN` · `RINGCENTRAL_CLIENT_ID/_SECRET/_REDIRECT_URI/_API_KEY` · `ANTHROPIC_API_KEY`/`GROQ_API_KEY`/`ELEVENLABS_API_KEY` (today firm-paid accounts; could be platform — needs the AI-spend ruling) · `CLOUD_TASKS_TARGET_URL` (`lib/taskQueue.js:148` — one global dispatch host defeats host-borne tenancy if set).

**PLATFORM (36):** `PORT, NODE_ENV, ENVIRONMENT, K_REVISION, APP_BUILD, APP_MIN_BUILD, JEST_WORKER_ID, DB_PORT` (scripts), `PUPPETEER_EXECUTABLE_PATH`, `CUSTOM_CODE_TIMEOUT_MS` (`lib/job_executor.js:40`), `TRIGGER_CODE_TIMEOUT_MS` (`services/triggerService.js:653`), `SU_STEPUP`, `SU_RATE_LIMIT_DEFAULT` (+ dynamic `SU_RATE_LIMIT_<TOOL>`, `lib/auth.superuser.js:136-137`), `READONLY_KEY_MAX_TTL_DAYS`, `CLOUD_TASKS_LOCATION/QUEUE`, `STT_PROVIDER`, `GROQ_STT_MODEL`, `ELEVEN_STT_MODEL`, `ANTHROPIC_MODEL`, the 5 `BADGE_*` display vars + `OLED_*` + `SEARCH_MAX_USES` (Fred-gadget), `AITEST_*`, `COURTEXEC_*`, `ERRTEST_*`, `STREAK_ADMIN_PASSWORD`, script-only `EI_*`/`YC_*`/`RO_KEY`/`READONLY_API_KEY`, `PDF_RENDER_*_TIMEOUT_MS` (dynamic, `services/pdfRenderService.js:116`).

**AMBIGUOUS — need a ruling before P0 (4 + 1):**

| name | file:line | the question |
|---|---|---|
| `JWT_SECRET` | 11 `process.env` reads: 3 sign + 5 verify sites + HMAC uses (§D2) | **Shared ⇒ a token minted for tenant A validates on tenant B.** |
| `JWT_VERSION` | `routes/auth.login.js:73`, checked `lib/auth.jwtOrApiKey.js:144` | global-logout lever — one bump logs out every tenant |
| `CREDENTIALS_ENCRYPTION_KEY` | `lib/credentialCrypto.js:39` (5 uses) | one key compromise decrypts every tenant's OAuth tokens |
| `INTERNAL_API_KEY` | `lib/firmConfig.js:85`, `routes/admin.apiKeys.js:87-96` | app-to-self auth; per-tenant keys need the dual-slot rotation per tenant |
| `API_KEY` | `routes/dropbox.js:66`, `routes/renaReminder.jsx:21` | legacy shared secret — retire |

## B4. `app_settings` keys — 72 distinct in code

**FIRM-CONFIG (48):** the 18 registry keys (`lib/firmConfig.js:54-103`: `email_it, email_automations, firm_email, email_domains, fe-firm_logo_url, fe-firm_phone, fe-firm_site_url, firm_name, firm_address, firm_attorney_name, app_url, gcs_bucket, landing_hosts, landing_redirect, internal_api_key, internal_api_key_prev, cloud_tasks_enabled, unified_singleton_enabled`) plus unregistered: `fe-trustees`, `alert_from_email`, `alert_recipients`, `alert_critical_sms_to`, `sms_default_from`, `sms_staff_from`, `email_default_from`, `email_default_to`, `office_alerts_to`, `billing_tasks_to` (`services/courtExecutor.js:742`), `event_digest_recipients` (`services/eventService.js:2837`), `portal_callback_task_to`, `portal_docs_notify_to`, `portal_email_from`, `portal_logo_url`, `portal_favicon_url`, `portal_logo_href`, `dropbox_credential_id` (`services/dropboxService.js:213`), `dropbox_case_folder_templates` (`services/caseService.js:1121`), `dropbox_unsorted_{generated,uploads,forms,esign}_path`, `gcal_credential_id`/`gcal_calendar_id` (`services/gcalService.js:89`), `gcontacts_credential_id`/`gcontacts_group` (`services/gContactsService.js:100, :442`)/`gcontacts_exclude_email_domains`, `esign_credential_id`, `esign_webhook_token`, `esign_webhook_secret`, `esign_reminder_seq_id`, `pabbly_internal_url` (`services/pabblyService.js:23`, `services/adapters/email/pabbly.js:56`), `quo_api_key` (`services/quoService.js:14`), `rc_token`/`rc_subscriptions` (legacy, deletion-slated `startup/init.js:60-61`), `clio_login_code` (`routes/api.jwt.js`), `shabbos_lead_min`, `shabbos_end_min`.

**PLATFORM-CONFIG (8):** `cloud_tasks_enabled`, `unified_singleton_enabled`, `min_client_build` (`lib/appBuild.js:150`), `alert_email_min_severity`, `alert_cooldown_hours`, `esign_test_mode`, `esign_webhook_hmac_mode`, `documents_sync_enabled`. (First two are also registry keys — per-tenant rows either way.)

**State/watermark rows in the config table (8) — a distinct hazard: shared mutable counters, not config:** `portal_sms_counter` (`services/portalAuthService.js:137, :176`), `alert_last_sweep_at` (`lib/alerting.js:1331`), `error_sweep_state` (`lib/alerting.js:1042`), `process_jobs_last_heartbeat_at` (`routes/process_jobs.js:20-23`), `documents_sweep_watermark` (`services/documentSyncService.js:1014`), `esign_webhook_last_seen_at` (`services/esignWebhookService.js:128`), `esign_credit_balance` / `esign_credit_alert_sent` (`services/esign/index.js:175, :177`).

**Uncertain (5):** `portal_live` (`lib/auth.requireAuth.js:55`), `court_ingest_live`, `trustee_validation_live` (`lib/internal_functions/trustee.js:301`), `esign_credit_alert_threshold`, `portal_sms_monthly_cap`.

Note `routes/api.firmData.js:87`: ``SELECT `key`,`value` FROM app_settings WHERE `key` LIKE 'fe-%'`` — **every `fe-` row ships wholesale to every staff browser** (prefix stripped `:106`). The tenancy boundary is enforced at that one query. Also: a legacy **`settings`** table exists in schema (`ref/database.sql:2896`) with **zero code readers** — all code reads `app_settings` (§4-10).

## B5. Summary

| Section | Count |
|---|---|
| `app_url` fallback sites (`\|\| 'https://app.4lsg.com'`) | 13 production (12 + publicUrl) |
| Pinned/default credential ids in code | 8 (Dropbox 8×2, GCal 11, People 11, Clio 7, RC 9, Zoho 13, Anthropic 12) |
| Hardcoded Dropbox folder paths | 4 |
| `process.env.*` | 73 distinct (23 FIRM / 36 PLATFORM / 5 ambiguous-ruling + dynamic forms) |
| `app_settings` keys | 72 (48 firm / 8 platform / 8 state-watermark / 5 uncertain) |
| Module singletons holding firm state | ~24 (§A3) + 6 TZ captures |
| Blast radius | **~27 CRITICAL · ~21 MODERATE · ~40 LOW** |

---

# C. Async entry points

**Search patterns used:** route inventory script over `routes/**` (method/path/first-middleware, 704 endpoints) · `cron|X-Cloudscheduler|x-appengine-cron` · `CloudTasksClient|createTask|taskPath|queuePath|CLOUD_TASKS` · `/hooks|/webhooks|authenticateRequest|auth_type|HMAC|timingSafeEqual` · `INSERT INTO scheduled_jobs|INSERT INTO domain_event_queue|FOR UPDATE SKIP LOCKED` · unawaited `.catch(`|`detached`|`fire-and-forget|post-commit`.

## C0. Headline

**Hostname-based tenancy is structurally unavailable to every async entry point today.** Only `routes/pageLanding.js` reads the request host (`:64`, `:335-336`; exhaustive check §E3). Every other entry resolves "the firm" through `startup/db.js` → `req.db` → `firmConfig`.

The good news: **no consumer captures a pool** — `executeJob(job, db)`, `executeWebhook(db, opts)`, `dispatch(db,…)` (`lib/actionDispatchers.js:580`), every drain/hook entry takes `db` as a parameter. **The hard problem is not plumbing `db`; it is deriving WHICH tenant at the moment an async entry fires.**

## C1. Cron / scheduler

No in-process cron; all scheduling is external (Cloud Scheduler → HTTP). **No scheduler-specific header check exists** (`X-Cloudscheduler`, `x-appengine-cron`: zero hits) — auth is the shared `x-api-key` (`yci_`) via `jwtOrApiKey`.

| route | file:line | tenant assumption |
|---|---|---|
| `ALL /process-jobs` | `routes/process_jobs.js:683` | **SEVERE** — claim query has no tenant predicate (`:297-305`: `FROM scheduled_jobs WHERE status='pending' AND active=1 AND scheduled_time <= NOW() … FOR UPDATE SKIP LOCKED`). One tick = one DB (the Host it was called on). External cron must fire once per tenant host, or a platform fan-out endpoint is added. `stampHeartbeat` (`:20-23`) writes one `app_settings` row; `routes/api.systemStatus.js` reads its age — per-tenant heartbeat question, §3-13. |
| `POST /process-job/:id` | `:702` | **CRITICAL** — `:id` is a bare `scheduled_jobs.id`, unique per DB; claim at `:283-292`. Job 867 exists in every tenant DB; the URL alone cannot disambiguate. Today tenant identity rides **implicitly** in the dispatch URL's host (`targetBase`, C2) — per-tenant `app_url` makes dispatch tenant-correct with zero payload change. |
| `POST /process-domain-event/:id` | `:735` | **CRITICAL** — same shape. |
| scheduled-jobs CRUD (6) | `routes/scheduled_jobs.js:83, :263, :429, :519, :635, :711` | request-bound — hostname **is** available here. |

## C2. Cloud Tasks

- Enqueue: `enqueueJobDispatch(jobId, scheduleTime)` (`lib/taskQueue.js:164`), `enqueueDomainEventDispatch(queueId)` (`:206`) → `_enqueue` (`:221`). Config `resolveConfig()` `:139-151`: `cloud_tasks_enabled` setting; `CLOUD_TASKS_LOCATION`/`QUEUE` env (queue default `yc-jobs`); **`targetBase = CLOUD_TASKS_TARGET_URL || cfg('app_url')`** (`:148`) — one global value serves all dispatch. URL built at `:259`.
- **The task carries NO body** (`:261-269`): identity travels only in the URL path (`/process-job/{id}` `:176`, `/process-domain-event/{id}` `:209`) + `headers: {'x-api-key': internal_api_key}` (`:267`). *A Cloud Task says "go look at row N" with no statement of which database.* **No OIDC** — explicitly deferred (`:78-84`: *"Cloud Run ingress is public (app-level auth), so no OIDC token is needed. If ingress is ever locked to IAM, add oidcToken…"*).
- **Task names collide across tenants:** `` `d-${jobId}-${Math.floor(dueMs)}` `` (`:175`), `` `de-${queueId}` `` (`:208`); completed names are retained ~1h (`:73-74` and the long block comment), so tenant A's job 867 would swallow tenant B's doorbell as `ALREADY_EXISTS` on a shared queue.
- **Three envelope candidates; one clean insertion point:** (1) the `httpRequest` itself — tenant in `path` or `headers`; **the correct seat** (the handler must know the tenant before opening a DB); (2) `scheduled_jobs.data` JSON — inert for routing, assertion-only; (3) `domain_event_queue.envelope` — built by one `return` literal (`lib/domainEvents.js:184-198`, schema `:24-37`; redaction denylist `:201-208` applies to `data/changes/extra`, not top-level keys) — clean single-site drop-in.
- **Neither queue table has a tenant column** (verified: `ref/database.sql:2654` scheduled_jobs, `:1435` domain_event_queue — zero tenant/firm columns). Idempotency keys also collide on any consolidated queue: `` `resume-${execId}-${nextStep}-${resumeAtMs}` `` (`lib/workflow_engine.js:919`), `` `seq-${enrollmentId}-step-${n}` `` (`lib/sequenceEngine.js:676`); `services/campaignService.js:331` cancels by `DELETE … WHERE name LIKE ?` — crosses tenants in a consolidated queue.
- Boot warmup `startup/init.js:31` / `lib/taskQueue.js:320+` (getQueue; IAM nuance documented in-file).

## C3. Inbound webhooks

### `/hooks/:slug` — one receiver (`routes/api.hooks.js:127`, `hookReceiveLimiter`)

Auth is per-hook, DB-configured — `hookService.authenticateRequest(hook, req)` (`routes/api.hooks.js:155` → `services/hookService.js:89`), four modes on `hooks.auth_type`: **none** (`:94`), **shared header secret** (`:100` — plain `!==`, **not timing-safe**), **HMAC** (`:200` → `timingSafeEqual` `:212`), **timestamped HMAC** (Calendly/Stripe-style; skew check `:177`, `:184-187`). A **deliberately unauthenticated catch-all** exists: `CATCHALL_SLUG = '_catchall'` (`:109`, fallback `:147`, design note `:104-106`). Raw-body capture for HMAC is wired in `server.js:76-101` (json/multipart/urlencoded/fallback; Jotform multipart note `:83-86`), `/webhooks` at `:111-129`. RingCentral `Validation-Token` echo pre-auth at `:129`.

**Tenant identity:** `hooks.slug` resolved against one DB (`services/hookService.js:60-64`). Slugs are unique per DB, not globally — two tenants can both own `lead-intake`; external senders (Zapier, Pabbly, Jotform, Calendly, RingCentral) hold a URL pasted into a third-party console, so the tenant must come from the **host** in that URL. Plus 19 `jwtOrApiKey` CRUD routes in the same file.

**Split-phase execution (corrected — see §5-10):** since the 2026-08-24 slice, `executeHook(…, {splitPhase:true})` runs **fast targets (`workflow`, `sequence`) request-bound** (`services/hookService.js:839` `FAST_TARGET_TYPES`, `:895-898`) and detaches only slow targets (`http`, `internal_function`) plus finalization (`:909-914`); the receiver responds after phase 1 (`routes/api.hooks.js:216-222`). The `lib/taskQueue.js:12-17` header comment still describing the hook path as fully detached is **stale on this point** (doc-debt). Consequence: workflow/sequence enqueues on the hook path run at full request CPU with `req.db` in hand.

### `/webhooks/esign/zoho` — the only `/webhooks` route

`routes/api.esign.js:112` (path const `:65`, limiter `:80-86`). Auth: query-token vs `app_settings.esign_webhook_token` (`:121` `verifyToken(db,…)`, 401 `:134`) + **conditionally enforcing** HMAC (`:158-167`, `if (hmac.mode === 'enforce' && !hmac.ok)`). Chicken-and-egg under tenancy: `verifyToken` needs a `db` first → host must resolve the tenant. Respond-then-work at `:211-222` (Zoho downloads + Dropbox uploads detached).

### Other inbound surfaces

| surface | file:line | auth | tenant source |
|---|---|---|---|
| `POST /api/email/ingest` | `routes/api.emailIngest.js:114` | `X-Email-Ingest-Key` → `emailIngestService.authenticate(db, key)` (timing-safe compare in service) + IP limiter `:100-108` | per-DB `email_ingest_sources` row → host |
| phone events | — | no standalone receiver — arrive via `/hooks/:slug`; workflow calls `phoneIngestService.ingestPhoneEvent` (`lib/internal_functions/log.js:460-463`) | host via /hooks |
| `GET /auth/oauth/callback` | `routes/api.oauth.js:238` | none as middleware; `state` is the credential (`:248-250`, per-DB `credentials.oauth_state`) | provider redirects to ONE fixed URI built off `app_url` — per-tenant redirect URIs or a shared platform callback (§3) |
| legacy: `/ringcentral/send-sms|send-mms` (`routes/ringcentral.js:83, :100` — env `RINGCENTRAL_API_KEY`, query-string accepted `:38-39`), `/dropbox/*` (`routes/dropbox.js:93-150` — env `API_KEY` **or plaintext `users.password` match** `:71-86`), `/logEmail` (`routes/logs.js:157`), `/unplacehold` (`routes/unplacehold.js:30`), `/auth/P_validate` (`routes/temp_auth_validate.js:7`), `/renaReminder` (`renaReminder.jsx:33`) | env shared secrets / per-request creds | retirement-tracked via `trap()` → `legacy_route_log` (`lib/legacyTrap.js` — logs creds in plaintext BY DESIGN for caller fingerprinting, `:8-10`); **flush, don't scope** |
| `api.temp.{clio,dropbox,ringcentral,zohosign}` proxies (8 routes) | `readonlyApiKeyAuth` | ⚠️ TEMPORARY outbound bridges, pinned credential ids (§B2) |
| `/api/ext/forms/:form_key` (4) | `routes/api.ext.forms.js:115, :229, :470, :530` | **none** — `case_id` query param is the bearer (`:127-128`); the file itself calls it *"a 40-bit bearer credential"* (`:77-95`) | **cross-tenant-leak-shaped**: low-entropy id resolving against whichever DB |
| `/api/public/docs/:caseId` | `routes/api.checklists.js:1092` | **rate limit only — bare caseId, no token**; returns client first name | same shape |
| `POST /api/public/get-upload-link` | `:1151` | rate limit only | **mints a Dropbox upload link** |
| `POST /api/public/upload-complete` | `:1235` | rate limit only | triggers team email |
| booking (5 public) | `routes/booking.js:354-858` | slug + honeypot + HMAC-signed ts (`:874`); `contact_token` lookup (`?c=`, header `:69`) | per-DB slug/token |
| manage (7 public) | `routes/manage.js:459-678` | `appt_manage_token` (`TOKEN_RE` gate `:311-313`); **`:473 /api/manage-config` takes nothing** | per-DB token |
| taskActions (4 public, **state-mutating**) | `routes/taskActions.js:264, :339, :386, :454` | `tasks.task_action_token` (`:125-132`) | per-DB token |
| decisionActions (3 public, **workflow-advancing**) | `routes/decisionActions.js:274, :329, :386` | decision token (`:279`) | per-DB token |
| `GET /tool/:key` | `routes/api.tools.js:392` | none by design (`:389`) | per-DB `tools.tool_key` |
| `GET /r/:slug` | `routes/api.redirects.js:313` | rate limit | per-DB slug |
| `/v/:slug` + 2 beacons | `routes/videoLanding.js:197, :391, :470` | none | per-DB slug |
| `GET /api/portal/branding` | `routes/portal.branding.js:140` | none | serves firm branding |
| `GET /internal/hello` | `routes/internal/dropbox.js:43` | none (other 11 `/internal/*` are `jwtOrApiKey`) | trivial |
| `/f/:form_key`, `/date`, `/myip`, `/parseName`, `/api/version`, `/badge/*`, `/api/streak/*` | various | none / limiter / own password | utility |

## C4. Workflow / sequence / outbox engines

**Two queue tables, zero tenant columns** (`ref/database.sql:2654`, `:1435`; the latter's COMMENT: *"Scheduling AUTHORITY for split-phase trigger dispatch; the Cloud Task is only a doorbell"*).

- **`scheduled_jobs` producers (9):** `lib/workflow_engine.js:932` (resume; dedupe `:922`, key `:919`) · `lib/sequenceEngine.js:691` (step; dedupe `:680`, key `:676`) · `services/hookService.js:939` (hook_retry) · `services/taskService.js:668, :700` (reminders — both compute times in `FIRM_TZ`, `:662, :694`) · `services/campaignService.js:281` (bulk; cancel-by-`name LIKE` `:331`) · `services/portalCallbackService.js:402` · `lib/internal_functions/decisions.js:496` · `routes/scheduled_jobs.js:211` (API create).
- **`domain_event_queue` producer (1):** `lib/domainEvents.js:272` from `emit(db, eventType, payload)` (`:232`). In-code invariant (`:264-270`): *"db is the autocommit pool at all 27 emit sites … if a future emit site ever passes a TRANSACTION connection, the task would fire against an invisible row."*
- **Claim loops (2):** `routes/process_jobs.js:279-308`; `lib/domainEventDrain.js:105-119` (`_claim`), `:245-252` (`drainBatch`), `:270` (`sweepStale`).
- All 7 engine modules take `db` as a parameter; **0 capture a pool**. One signature wart: `scheduleResume(execId, resumeAt, nextStep, db)` has `db` **last** (`lib/workflow_engine.js:975`).

## C5. Fire-and-forget post-commit side effects

Scale: the self-labeling comments (`fire-and-forget|post-commit`) mark **62 files**; audit-2's unawaited-`.catch(` sweep counted **157 sites, 45 touching an external system**; a conservative re-grep (excluding awaited/assigned forms) bounds it at **≥107**. Order-of-100 either way. Pattern is always bare promise + `.catch`, detached async IIFE, or a returned `detached` promise — no `setImmediate`/`process.nextTick`.

**The respond-then-work sites:** `routes/api.hooks.js:216-222` (phase-2 `detached`, built `services/hookService.js:909-914` — fast targets already ran request-bound); `routes/api.esign.js:211-222` (`Promise.resolve().then(() => handleZohoWebhook(db,…))`); `routes/pageLanding.js:171` (`executeHook(req.db, page.hook_slug, input).catch(…)` — *"Respond before the pipeline"*, `:169`; notably the one async producer that already knows the hostname).

**External systems reached from detached context — 10:** Google Calendar (`services/portalCallbackService.js:452-464`; `routes/portal.callback.js:71, :104`; `services/eventService.js:2213-2366`; `services/availabilityService.js:627`; `services/apptService.js` ~20 sites `:66-2341`) · Google People (`services/contactService.js:2429, :2847`) · GCS (`routes/api.videos.js:235`) · Dropbox (`services/intakeService.js:581-583`; `routes/portal.docs.js:136-137`; `services/documentSyncService.js:815`; `services/caseService.js:693-837`) · Zoho Sign (`routes/api.esign.js:215`; `services/esignWebhookService.js:745, :840, :896`) · RingCentral/SMS (`routes/booking.js:824-830`; `routes/manage.js:425`; `services/apptService.js:780-781`; `services/phoneService.js:119-123`) · Quo (`services/quoService.js:75, :86`) · Pabbly (`services/pabblyService.js:31-35`; `services/adapters/email/pabbly.js:79`) · SMTP/Gmail (`routes/booking.js:833-843`; `routes/auth.password.js:107, :115`; `routes/api.checklists.js:1356`; `routes/api.featureRequests.js:58`; `services/portalDocsService.js:516`; `services/taskService.js:1303`) · arbitrary HTTP (hook targets via `lib/actionDispatchers.js` deliverHttp).

**Process-level detached handlers:** `server.js:186-211` — both `alert(db,…)` calls use the boot-captured pool; under tenancy every tenant's crashes land in one DB → platform-sink decision (P0-4d).

## C6. Summary

| Fact | Value |
|---|---|
| Cron entry points (execution / CRUD) | 3 / 6 · scheduler header checks: **0** |
| Cloud Tasks: enqueue fns / handlers / OIDC / request bodies | 2 / 2 / **0** / **0** |
| Envelope insertion points | 3 candidates, 1 clean (`lib/domainEvents.js:184`); correct seat = task URL/headers |
| `/hooks` receivers (+CRUD) / `/webhooks` routes | 1 (+19) / 1 |
| Public or token-only inbound routes | 38+ |
| Files reading the hostname | **1** (`routes/pageLanding.js`) |
| Queue tables / tenant columns | 2 / **0** |
| `scheduled_jobs` producers / domain-event producers | 9 / 1 (27 emit sites per in-code comment) |
| Engine modules capturing a pool | **0 of 7** |
| Unawaited `.catch(` sites / external-touching | ~107–157 / 45 (audit-2 sweep) |

---

# D. Identity & auth surfaces

**Search patterns used:** `res\.cookie|Set-Cookie|cookie-parser|express-session|req\.cookies` · `jwt\.sign|jwt\.verify|JWT_SECRET|JWT_VERSION` · `ycp_|yci_|ycro_|yck_|generateKey|key_hash` · `action_token|task_action_token|appt_manage_token|contact_token|oauth_state|uploadTicket|createHmac` · `req\.auth|payload\.sub|isSuperuser|user_auth|SU_AUTH` · middleware column of the 704-endpoint route inventory.

## D1. Session mechanism — **there is none**

`res.cookie` / `Set-Cookie` / `cookie-parser` / `express-session` / `req.cookies`: **zero hits** in app code and `package.json`. Deliberate: `server.js:29-33` (*"this app has no auth cookies at all (Bearer JWT / x-api-key headers only)"*), `routes/api.streak.js:12` (*"No sessions, no cookies"*). CORS is `origin:"*"` (`server.js:15-19`). The only cookie code is `routes/freelook.js:49-53, :73, :88` — an **outbound** HTTP client keeping a court site's session.

**Addendum answer (session-issuing surfaces for a sessionless "pages" host role):** zero routes issue cookies; the equivalent list is the **token-minting** surfaces — deny exactly these and the verify consumers, and nothing else establishes identity:

| mint site | family | claims / shape | lifetime |
|---|---|---|---|
| `routes/auth.login.js:61` (`POST /login`, bcrypt vs `users.password_hash`, `:26-80`) | staff JWT | `{sub: users.user, username, user_type, user_auth, aud:'staff', roles[], ver}` | 24h |
| `services/portalAuthService.js:348-352` (`POST /api/portal/verify-pin`, `routes/portal.auth.js:91`; PIN request `:56`) | portal JWT | `{sub: contactId, aud:'contact', ver: portal_session_version}` | 12h / **90d** trustDevice (`:351`) |
| `lib/auth.superuser.js:55` (`POST /admin/elevate`, bcrypt re-check, `routes/admin.elevate.js:59-115`) | SU elevation JWT | `{sub, aud:'su-elev'}`, header `X-SU-Elevation`, sessionStorage | 15 min |
| `routes/api.readonlyKeys.js:63` (SU) | `ycro_` key | `"ycro_"+randomBytes(32).hex` → `readonly_api_keys.key_hash` | TTL-capped |
| `routes/admin.apiKeys.js:90` (SU rotate) | `yci_` key | `apiKeys.generateKey('yci_')` → `app_settings` dual slots | rotation |
| `lib/apiKeys.js:49` (admin UI) | `yck_` key | `prefix+randomBytes(32).hex` → `api_keys.key_hash` (sha256 `:39`) | revocable |

Password reset: `POST /auth/forgot-password` / `/auth/reset-password` (`routes/auth.password.js:21, :54, :129`, limiter; reset links off `app_url`).

## D2. The JWT/HMAC problem — the single largest tenancy hole in Map D

**All three token families are signed with one process-global `JWT_SECRET`**, and `sub` is a **bare per-tenant integer id**. `jwt.sign` sites: 3 (D1). `jwt.verify` sites: 5 — `lib/auth.jwtOrApiKey.js:127` · `lib/auth.requireAuth.js:115, :191` · `lib/auth.superuser.js:66` · `routes/temp_auth_validate.js:15`.

Under DB-per-tenant with a shared secret:
- **Staff:** a tenant-A token validates on tenant-B's host (`jwtOrApiKey:127-147` checks signature, `aud`, `user_auth` prefix, global `ver` — **nothing binds it to a DB**); `req.auth.userId = payload.sub` (`:151`) then names a *different person* in B's `users`. **Cross-tenant privilege escalation.**
- **Portal:** `requireAuth:115` verifies, `:120` audience, then looks up `contacts WHERE contact_id = payload.sub` in whatever DB `req.db` points at; the only incidental guard is `ver === portal_session_version` (`:131` area) and both tenants' counters commonly sit at the same low integer. **Client-data-leak shaped.**
- **SU elevation:** `lib/auth.superuser.js:68` compares bare id to bare id, same secret — compounds the staff hole.
- **`JWT_VERSION`** is process-global (`routes/auth.login.js:73`, checked `jwtOrApiKey:144`): one bump logs out every tenant.
- **The hazard extends past JWTs:** `JWT_SECRET` is the established key for app-minted **HMACs** — upload tickets (`lib/uploadTicket.js:74-82, :97`; header `:44-46` names the convention) and booking timestamp signatures (`routes/booking.js:874` `sigValid`) — so those MACs also verify cross-tenant until keyed or claimed per tenant.

## D3. API-key families — 3, not 4

| prefix | minted | validated | grants | storage |
|---|---|---|---|---|
| `yck_` | `lib/apiKeys.js:34, :49` | `jwtOrApiKey:89` → `apiKeys.lookup(req.db, key)` — **but the 60s cache (`:36`) is keyed by `key_hash` with no tenant axis**: a key resolved via tenant A's `req.db` is served from process cache for a request on tenant B's host, and the cached per-tenant `rec.id` is replayed into `touchLastUsed(db, id)` (`:85`) against whatever DB is current | full `jwtOrApiKey` surface, attributed by label | `api_keys.key_hash` |
| `yci_` | `routes/admin.apiKeys.js:87-96` | `jwtOrApiKey:79-86` vs `cfg('internal_api_key')`/`_prev` (+ refresh-on-miss `:96-114`) — the compare runs against the **un-keyed firmConfig cache**, so until firmConfig is tenant-keyed, any tenant's internal key is accepted on any host | same surface; the Cloud Tasks header credential (`taskQueue:267`) | `app_settings` is_secret rows |
| `ycro_` | `routes/api.readonlyKeys.js:63` (SU) | `lib/auth.readonly.js` via `req.db` | `/api/readonly/sql`, `/api/scratch/*`, `/api/admin/scratch` reads, `/api/alert/it`, `api.temp.*` proxies (13 endpoints) | `readonly_api_keys.key_hash` |

**`ycp_` does not exist** — zero hits; portal tokens are unprefixed JWTs with `aud:'contact'` (§4-2).

## D4. Non-JWT bearer-token flows

| token | column / check | lookup | mutating? |
|---|---|---|---|
| task action token | `tasks.task_action_token` (22-char url-safe, `services/taskService.js:135`; links minted off `publicUrl()` `:142`) | `routes/taskActions.js:125-132, :462` | **yes** — complete/cancel (`:339, :386`) |
| decision token | decisions table | `routes/decisionActions.js:279` | **yes** — workflow-advancing (`:386`) |
| appt manage token | `appts` manage token, `TOKEN_RE` shape gate | `routes/manage.js:311-313` | **yes** — cancel/reschedule |
| contact token | `contacts.contact_token` (booking `?c=`, `routes/booking.js:69-78`) | booking routes | read |
| form `case_id` | bare `cases.case_id` — the file calls it *"a 40-bit bearer credential"* (`routes/api.ext.forms.js:77-95`) | `:127-128` | read (3 fields) — **the realistic cross-tenant resolution risk**, with `api.checklists.js:1092/:1151/:1235` (bare caseId, rate-limit only) |
| `oauth_state` | `credentials.oauth_state` | `routes/api.oauth.js:248-250` | **yes** — binds a credential |
| upload ticket | HMAC over destination+context, keyed `JWT_SECRET` | `lib/uploadTicket.js:74-97` | **yes** — commit registers a file against a case |

## D5. Bare ids as global identifiers

| site | id | becomes under tenancy |
|---|---|---|
| `routes/auth.login.js:63` → `jwtOrApiKey:151` | `users.user` as JWT `sub` | `(tenant, user)` |
| `services/portalAuthService.js:348` | `contact_id` as `sub` | `(tenant, contact)` |
| `lib/auth.superuser.js:56, :68` | elevation `sub` | `(tenant, user)` |
| `lib/auth.superuser.js:133, :167` | rate bucket `${tool}:${userId}` | collision |
| `lib/apiKeys.js:36-37, :85` | `api_keys.id` | wrong-row stamping |
| `services/courtExecutor.js:167, :171` | hardcoded user ids 1 and 5 | hard-bound to 4LSG staff |
| audit tables (`admin_audit_log.user_id` via `auth.superuser:190-198`; `jwt_api_audit_log` via `jwtOrApiKey:24-70` with redaction; `portal_access_log.contact_id` via `requireAuth:71-87`; `query_log`, `legacy_route_log`, `readonly_query_log`; `tools.updated_by`/`tool_versions.saved_by` username-string convention `api.tools.js:44-47`) | bare per-tenant ids | **per-tenant tables, so unambiguous under DB-per-tenant** — only cross-DB aggregation would need tenant tags |

## D6. Superuser determination

`lib/auth.superuser.js:20-24`: `SU_AUTH = "authorized - SU"`; `isSuperuser(auth)` = JWT-only + exact string match on `users.user_auth` (provisional by its own admission, `:12-15`). API keys rejected by design (*"named, audited humans"*). On top: 15-min step-up elevation on every `superuserOnlyFor(tool)` chain (`:73-99`), kill switch `SU_STEPUP=0` (`:51`), per-tool in-memory rate limit (`:133+`). 47 `superuserOnlyFor*` endpoints in the route inventory (dbConsole, apiTester, apiKeys, users, systemAlerts, readonlyKeys, tools, adminScratch, elevate, credentials/connections).

## D7. Summary

| Fact | Value |
|---|---|
| Cookie/session auth | **0** — none exists |
| Token-minting surfaces | **6** (3 JWT + 3 key families) |
| `jwt.sign` / `jwt.verify` sites | 3 / 5 |
| JWT signing secrets | **1** (`JWT_SECRET`) — also keys upload-ticket + booking HMACs |
| Audiences | `staff`, `contact`, `su-elev` |
| Key prefixes | **3** (`yck_, yci_, ycro_`) — `ycp_` does not exist |
| Non-JWT bearer flows | 7 |
| Bare-id-as-identifier hazards | 6 live + per-tenant audit tables |
| SU | string match + elevation JWT |

---

# E. Serving & schema facts

**Search patterns used:** `sendFile|express\.static|app\.get\("/:page"` · `waitForParent|parent\.apiSend|P\.apiSend` over `public/**.{html,js}` · `req\.hostname|req\.headers\.host|x-forwarded-host|x-original-host|trust proxy|x-forwarded-` · live `information_schema` (TRIGGERS/VIEWS/ROUTINES/TABLES/COLUMNS), `SHOW GRANTS`, `@@GLOBAL.sql_mode`/`@@SESSION.sql_mode` · dump greps (`CREATE TRIGGER`, `DEFINER`) · `COLLATE` in code · `sql_mode` dependency sites.

## E1. Page serving and auth level

Middleware order (`server.js`): compression `:47` → build headers + `refreshMinBuild(db)` `:63-69` → `/hooks` + `/webhooks` raw-body parsers `:76-129` → global json/urlencoded `:130-131` → **`pageHostMiddleware(db)`** `:135` → `express.static` `:136-153` → single-segment `GET /:page` → `public/<page>.html` `:160-169` → **`req.db` attach `:171-174`** → `responseObserver` `:179` → auto-mount of all `routes/*.js` `:214-219` → `errorMiddleware` `:224`. `trust proxy = 1` `:20`.

**All page serving is unauthenticated** — auth lives at the API layer. And the **ordering matters for tenancy**: `express.static` and the `/:page` catch-all run **before** `req.db`, so page serving never touches the DB today; a tenant-aware serve either moves that boundary or sits where `pageHostMiddleware` already sits.

| what | how | file:line | auth |
|---|---|---|---|
| shell + 56 panes + assets | `express.static` + `/:page` catch-all | `server.js:136-169` | none |
| vanity-host pages (`pages` table) | `pageHostMiddleware` | `routes/pageLanding.js:569-700` (pinned host+path via `pageService.isKnownHost` Set cache `services/pageService.js:206-222`; landing canonicalization/allowlist/root-slug; dead-end → `fe-firm_site_url` redirect `:103-107`) | none (public) |
| `/p/:slug` GET/POST | router | `pageLanding.js:193, :209` (honeypot + 10/min/IP inline limiter `:69-91`, keyed `cf-connecting-ip \|\| req.ip` — the anti-pattern `lib/rateLimiter.js:12-15` documents) | none |
| **tools pages** | `GET /tool/:key` | `routes/api.tools.js:392-414` (live rows only; `no-cache`; `X-Robots-Tag: noindex`; deliberately OFF the landing allowlist `:12-15`) | none by design — ruled decision, inventoried |
| tools management (9 routes) | `/api/tools*` | `superuserOnlyFor('tools')` | SU + elevation |
| `/appt`, `/docs` | `sendFile` | `routes/pages.js:13, :17` | none |
| booking / manage shells | `sendFile` | `routes/booking.js:359`; `routes/manage.js:454` (`serveManageShell` on `/m`, `/m/:token` `:459-460`) | none |
| video landing / redirect dead-link | inline HTML | `routes/videoLanding.js:374`; `routes/api.redirects.js:134` | none |
| manuals | `GET /manual*` | `routes/manuals.js:170-199` | `jwtOrApiKey` (the one authed doc surface) |

**Addendum — tools audit + versioning: both yes.**
- **Audited:** `routes/api.tools.js:94-110` `audit(…)` → `auditAdminAction(req.db, {tool:'tools',…})` at `:218` create · `:249` update · `:272` delete · `:347` delete_version · `:380` restore; `superuserOnlyFor` audits rejections; reads not audited (`:52-56`).
- **Versioned:** `tool_versions` (FK-cascade on delete `:265`). Convention `:29-43`, insert `:168`: on any save where html differs, a row with the NEW html is appended — complete save history (v1 = creation html; newest row = `tools.html`); title/status-only PATCH appends nothing; restore appends unless no-op. Retrievable: `GET /api/tools/:id/versions` `:288`, `/:vid` `:306`; `version_count` on the list `:182`. Append is not transactional with the tools write (`:40-42`) — crash loses one history row, never the tool.

**"get-clio-code"-style landing page:** no such route exists in the repo. The in-repo Clio surfaces are `GET /clio-code` (`routes/api.jwt.js:25`, `jwtOrApiKey`, reads `app_settings.clio_login_code`; consumed by the shell `public/index.html:3005, :3063`) and the `api.temp.clio.js` proxy. If "get-clio-code" is a `tools` or `pages` **row**, it is DB content served by `GET /tool/:key` or the vanity middleware and invisible to a repo audit — §3-12.

## E2. Iframe parent reach-in (`P.apiSend` / `waitForParent`) — 63 files

59 HTML panes + 4 JS helpers (`public/js/assetpicker.js`, `public/js/videoInsert.js`, `public/js/yc-forms.js`, `public/scripts.js`):

`apiTester, apikeys, apptform2, assetManager, automationManager, availabilitymanager, bookingviewsmanager, calendar, campaign, case, caseConfigManager, checklistView, communicate, connections, contact, customView, dbConsole, featureRequests, formBuilder, formBuilderSimple, formInbox, issueReports, manuals, pageManager, portalManager, readonlyKeys, reports, scratchBrowser, sendingform, sendingform-bk, settings, systemAlerts, toolManager, users, videoManager` + `automation/{activity, automationsWidget, courtReview, emailIngest, hooks, phoneIngest, scheduledJobs, sequences, triggers, workflows}` + `caseconfig/{calendarTypes, fields, pipelines, types}` + `portaladmin/{portalAccess, portalCards, portalSettings}` + `forms/{341notes, contact-form, issn, liveHost, render, submissionsWidget}` + `esign/sendForm`.

Tools rows use the same runtime contract (`routes/api.tools.js:7-9`). Inventoried as context, not flagged — SU-authored HTML on the app origin is a ruled decision.

## E3. Proxy and host-header handling

`app.set('trust proxy', 1)` (`server.js:20`). **Every host read in the app — 3 lines, one file:** `routes/pageLanding.js:64` (`x-original-host || req.hostname`, port-stripped, lowercased — the comment at `:26` attributes `x-original-host` to *"the Cloudflare Worker / proxy in front of mapped domains"*) and the spoof-aware union at `:335-336` (`x-forwarded-host` first element, `req.headers.host`). The security reasoning at `:314-330` is worth carrying into the tenancy design verbatim: landing membership takes the **union** of candidates so *a spoofed header can only ever RESTRICT a request, never widen it* — a tenant resolver reading `x-original-host` alone would invert that property.

**`x-forwarded-for` — 20 sites, all client-IP extraction for logs/limiters, all taking the FIRST element** (`?.split(",").shift()`): `routes/{api.adminScratch:49, admin.users:74, api.phoneIngest:45, api.phoneLines:39, admin.dbConsole:47, api.readonly:33, sequenceTypes:52, api.oauth:39, admin.apiKeys:73, api.emailCredentials:111, api.alertIt:73, admin.systemAlerts:40, api.emailIngest:230, api.fieldDefs:66, admin.elevate:56, api.credentials:72, api.tools:92, api.readonlyKeys:28, admin.apiTester:75}`, `lib/auth.jwtOrApiKey.js:56`. `lib/rateLimiter.js:54-60` documents that only the **last** XFF element is GFE-appended — so these 20 audit sites log an attacker-suppliable IP. Pre-existing, not tenancy-specific, but it lives in the same plumbing a resolver touches.

## E4. Platform (non-tenant) routes

**No dedicated health check exists** (`/healthz`, `/health`, `/_ah/*`, `/ready`: nothing; nothing in Dockerfile/cloudbuild). De-facto platform routes: `GET /api/version` (`routes/api.version.js:25` — public by design, but `getMinBuild(req.db)` **reads the per-tenant `app_settings`**; the one that needs a decision), `GET /date`, `GET /myip` (fetches curlmyip.org), `POST /parseName` (`routes/functions.js:38-92`), env-gated test routes (`/_errtest /_aitest /courtexec`), Fred gadgets (`/badge/*`, `/api/streak/*`).

## E5. Schema facts

**Live-verified 2026-10-05** (readonly key; RO user `uilnnfwkvf7b3@35.227.91.145` = `GRANT USAGE ON *.*` + `GRANT SELECT ON dbnwqdrfyz9vmq.*` only, per `SHOW GRANTS`):

- Schema `dbnwqdrfyz9vmq`; MySQL **8.4.6-6**; **145 BASE TABLE, 0 views** (`information_schema.TABLES` — covered by the SELECT grant, trustworthy).
- **sql_mode:** `@@GLOBAL = NO_ZERO_IN_DATE, NO_ZERO_DATE, ERROR_FOR_DIVISION_BY_ZERO, NO_ENGINE_SUBSTITUTION`; `@@SESSION` adds `IGNORE_SPACE` (connector-added on the RO pool's session). No `STRICT_TRANS_TABLES`, no `ONLY_FULL_GROUP_BY`, no `NO_BACKSLASH_ESCAPES` — **the CLAUDE.md invariant holds.** MySQL 8.4 *defaults* include both strict mode and ONLY_FULL_GROUP_BY, so a tenant DB provisioned with server defaults **breaks `listCases` and `cases` inserts on day one** — the relaxed mode is a **provisioning requirement**, not a local quirk (§3-4).
- **Collation:** db default `utf8mb4`/`utf8mb4_general_ci`; all 145 tables at the default; **exactly two** column overrides in the whole schema — `documents.external_id` and `case_folder_cache.folder_external_id`, both `utf8mb4_bin` (case-sensitive Dropbox ids; confirmed). **The other half of the documented invariant is STALE:** `court_ai_log.message_id` and `email_log.message_id` are both `utf8mb4_general_ci` live (as is `email_ingest_executions.message_id`). The three `COLLATE utf8mb4_general_ci` clauses still in SQL are **no-ops** (`routes/courtReview.js:73`, `services/courtRerun.js:51`, `lib/internal_functions/court.js:599`), and the comments asserting `utf8mb4_unicode_ci` are wrong (`lib/internal_functions/court.js:590`, `services/courtRerun.js:42`). Doc-debt: retire or re-derive the invariant.
- **Triggers:** **15, across 7 tables** (dump-derived; fresh recount — see §5-1): `case_relate` ×2 (`ref/database.sql:466, :481`), `cases` ×2 (`:650, :668`), `checkitems1` ×2 (`:726, :744`), `contacts` ×3 (`:1008, :1127, :1152`), `seq_steps` ×2 (`:2699, :2711`), `tasks` ×2 (`:3076, :3084`), `test` ×2 (`:3161, :3191`).
- **Trigger DEFINERs: not determinable from either source.** Live `information_schema.TRIGGERS` returns 0 rows to the RO user — a **privilege artifact** (MySQL hides triggers without the TRIGGER privilege), not absence. And `lib/schemaDump.js:91-96` reconstructs `CREATE TRIGGER` from six columns that **never include DEFINER** (views likewise stripped by design, `:136-138`). This matters for cloning: a DEFINER names `user@host`; clone a tenant DB under a new MySQL user without rewriting DEFINERs and every write to the 7 triggered tables fails. §3-1; suggest adding DEFINER to the dump query regardless.
- **Routines:** none in the dump (never collected) and live-inconclusive (same privilege artifact). §3-2.
- **Code-visible sql_mode dependencies (known list confirmed; one addition):** relaxed GROUP BY in `listCases` (`services/caseService.js:149`, design note `:967`); non-strict insert/truncation reliance (`lib/noteLimits.js:7-22`, `lib/internal_functions/tasks.js:15`, `lib/internal_functions/appointments.js:262`, `lib/actionDispatchers.js:358`, `lib/sequenceEngine.js:1059-1081`); `lib/blankDateToNull.js` exists precisely because `NO_ZERO_DATE` is on while strict is off (`:6, :45-59` hand-mirrored DATE_COLUMNS list); LIKE-escape centralized at `services/documentService.js:179` `_escapeLike` (exported `:1787`; reused `services/documentSyncService.js:1896-1906`; callers `:688, :1573, :1694`) and `lib/sqlGuard.js`.
- `services/videoService.js:277-287` probes `JSON_OVERLAPS` once per process, cached globally — safe only while every tenant shares a MySQL version (8.4.6 ≥ 8.0.17 ✓).

## E6. Summary

| Fact | Value |
|---|---|
| Page-serving routes requiring auth | **0** (manuals is the authed exception, API-layer) |
| Pages using `P.apiSend` reach-in | **63** (59 html + 4 js) |
| Tool CRUD audited / content versioned | **yes / yes** (5 action types; full history + restore) |
| `trust proxy` | 1 |
| Files reading the request host | **1** (3 lines, `pageLanding.js`) |
| XFF read sites (all IP-logging, first-element) | 20 |
| Health check | none; `/api/version` is de-facto and reads tenant data |
| Tables / views / routines | 145 / 0 / inconclusive |
| Triggers / DEFINERs | **15 across 7 tables** / unobtainable (privilege + dump design) |
| Non-default collation columns | 2 (`utf8mb4_bin`) |
| sql_mode | relaxed, live-verified (GLOBAL + SESSION); provisioning requirement |

---

# 1. Chokepoint verdict + proposed P0 slice list

## Verdict: yes — one chokepoint, and the codebase is in unusually good shape for this.

1. **`server.js:171-174` is the single handle-attachment point**; 125/136 route files consume `req.db`, zero services capture the app pool, all engines parameter-pass.
2. **No SQL names a database** — switching the pool's `database:` switches the app.
3. **The resolver seat already exists**: `server.js:135` hosts a hostname-resolving middleware with a 60s host cache and a spoof-resistant host-candidate union.

**But the pool is not the only chokepoint.** Two things are harder than the pool: **`lib/firmConfig.js`** (flat un-keyed cache behind a synchronous `cfg()` required by 39 files — a signature change across the config surface, or an AsyncLocalStorage tenant ambient, precedent `lib/domainEvents.js:99`) and **`FIRM_TIMEZONE`** (6 independent module-scope captures, 25 timezoneService importers, boot-frozen by documented design). And **token tenancy (§D2) must land before tenant 2 exists** — the pool seam alone leaves cross-tenant auth open.

### Every file that changes for `getDb(tenant)`

- **Tier 1 — the handle (≈10 files):** `startup/db.js` (factory/registry, keeping retry wrappers + bound withTransaction) · `server.js` (7 capture sites) · `startup/init.js:32` (per-tenant reconcile loop) · `routes/pageLanding.js` (resolver seat; `req.db=db` at `:591/:657/:676`) · `lib/firmConfig.js` · `routes/db64.js` + `routes/dbQuery.js` (delete) · `startup/dbReadonly.js` + `routes/api.readonly.js:23` + `services/reportService.js:65`.
- **Tier 2 — the un-keyed caches (~24, §A3):** tenant-key or demote to per-request.
- **Tier 3 — async entry points (3):** `lib/taskQueue.js` (path/header + task name), `routes/process_jobs.js` (3 handlers), `lib/domainEvents.js:184` (envelope).
- **Tier 0 — nothing:** the other ~125 route files and every service.

## P0 slices (smallest independently-deployable steps, dependency order; each a no-behavior-change step for tenant #1)

| # | slice | deployable alone? | notes |
|---|---|---|---|
| **P0-0** | **Delete `routes/db64.js` + `routes/dbQuery.js`** (check `legacy_route_log` for live callers first) | yes | 2 of the 3 app-pool module captures gone; cheapest win |
| **P0-1** | `yc_master` + `tenant_hosts` schema; `tenantResolver` middleware ahead of `pageHostMiddleware` at `server.js:135`; sets `req.tenant`, nothing else; host-candidate **union** copied from `pageLanding.js:314-336` | yes | ship and watch before anything consumes it |
| **P0-2** | `getDb(tenant)` registry in `startup/db.js` (retry wrappers + bound withTransaction per pool); default tenant = today's pool byte-identically. Twin: `getRoDb(tenant)` in `startup/dbReadonly.js` | yes | pure addition |
| **P0-2b** | RO consumers through the registry: `routes/api.readonly.js:23`, `services/reportService.js:65`; per-tenant RO users/grants decision (§3-6) | after P0-2 | |
| **P0-3** | `server.js:172` → `req.db = getDb(req.tenant)` | yes | the flip; a no-op with one tenant |
| **P0-4a** | `server.js:67` + `lib/appBuild.js:117` — tenant-key `minCache` or move behind `req.db` | yes | runs on every request |
| **P0-4b** | `server.js:135` + `pageLanding.js` closure — take `db` from the resolver; fix the three `req.db = db` sites | yes | merges with P0-1 |
| **P0-4c** | `server.js:179, :224` — `responseObserver`/`errorMiddleware` → `req.db` (and tenant-key `stormState`, `lib/errorMiddleware.js:35`) | yes | |
| **P0-4d** | `server.js:188/:200` process guards — designated **platform** alert sink (no request context exists) | yes | decide where cross-tenant process errors land |
| **P0-4e** | `startup/init.js:32` → per-tenant reconcile loop; tenant-key `_inFlight`/`_followUp` (`fieldDefReconciler.js:527-528`); suffix `LOCK_NAME` (`:88`) per tenant | after P0-2 | the only boot-path slice |
| **P0-4f** | **firmConfig tenanting** — tenant-keyed cache + tenant-aware `cfg()` via AsyncLocalStorage ambient; carries `lib/appBuild.js` with it and closes the `yci_` cross-tenant acceptance (§D3) | after P0-2 | **the largest slice (39 consumer files); its own sub-arc** |
| **P0-5** | Tenant-key the remaining ~20 process-global caches (§A3), one module per slice; highest-risk first: `lib/apiKeys.js:36-37` (auth), `lib/internal_functions/db.js:464` + `services/fieldDefService.js:207-208` (write whitelists under custom fields), `services/pageService.js` hostCache | yes, one at a time | |
| **P0-6** | Suffix the 5 server-global `GET_LOCK` names with tenant (§A7) | yes | only needed on a shared MySQL server |
| **P0-7** | **Token tenancy** — tenant claim in staff/portal/elevation JWTs verified against the resolved tenant, or per-tenant `JWT_SECRET`; same ruling for `CREDENTIALS_ENCRYPTION_KEY`; include the uploadTicket/booking HMACs (§D2); `JWT_VERSION` scoping | yes | **must land before any second tenant exists** |
| **P0-8** | Cloud Tasks/cron tenanting — tenant in dispatch path or header (`taskQueue:176/:209/:267`), tenant-prefixed task names (`:175/:208`), tenant in domain-event envelope (`domainEvents.js:184`), the 3 `process_jobs` handlers, external-cron fan-out decision (§C1) | yes | single-tenant deploy carries `tenant=1` everywhere |
| **P0-9** | Scripts gain `--tenant`/env selection (the 10 in §A2) | yes | |

Deferred to P3/P4 proper: FIRM_TIMEZONE parameterization (6 captures + consumers), firm-fallback flush (§2), legacy-route retirement.

---

# 2. Flush-list, ranked by blast radius

### CRITICAL (~27) — external side effects land on 4LSG accounts
1. **Dropbox**: credential fallback 8 (×2) + 4 hardcoded folder paths + legacy env creds (§B2 rows 1-7).
2. **Google bound to one person**: GCal/People credential 11, `'primary'` calendar ×2, user ids 1 and 5 in courtExecutor (§B2).
3. **Pinned credential rows**: Clio 7, RC 9, Zoho 13, Anthropic 12 (temp proxies + aiService).
4. **Pabbly workflow token in source** (`ringcentralService.js:13`); RingCentral env creds + query-string inbound key.
5. **Named staff as default recipients** (`court.js:645`, `trustee.js:85-86`) + the 11 `…@4lsg.com` from-fallbacks that fire exactly on empty config.
6. **Client-comms hardcodes** `DOCS@4LSG.COM` / `app.4lsg.com/docReq` (7 lines, `api.sending.js`).
7. **Shared-counter settings rows** — `portal_sms_counter` + 7 watermark keys (§B4): per-tenant DB fixes them, but any consolidated design cross-charges quotas.
8. **Shared `JWT_SECRET`** (§D2) — listed here because the blast is cross-tenant data access.

### MODERATE (~21)
1. `FIRM_TIMEZONE`: 6 captures + 25 importers; `taskService` reminder times; trigger cron band; **frontend `America/New_York` with false parity comments** (`manage.html:260`, `book.html:346`) + `America/Detroit` frontend defaults.
2. The 13 `|| 'https://app.4lsg.com'` link-mint fallbacks (live SMS paths `job_executor:216/:281`).
3. Firm-domain classification singletons (`emailIngestService:104`, `logs.js:86`, `gContactsService:64`).
4. `GET /api/manage-config` credential-free branding (`manage.js:473`); `GET /api/portal/branding` same shape.
5. Phone/logo/email/ZIP fallbacks (`api.redirects.js:88/:94/:95`, `firmBlocksService:54`).
6. Clio-code relay + `/renaReminder` firm-workflow surfaces.

### LOW (~40)
`legalsolutions.group` in 10 files; bare `https://4lsg.com` in client JS/HTML (14 sites); Jotform-hosted logo; Calendly embed prefill; Zelle note (fourth domain); vendor name/phone in client copy; `gen_signatures.js` full firm identity; deploy-plane names; jurisdiction-pinned AI prompts + `%mieb%` filters; doc-example addresses; script endpoint pins. (§B2 LOW has the lines.)

---

# 3. Facts not determinable from the repo — questions for Fred

1. **Trigger DEFINERs** — unobtainable from both sources (§E5). 15 triggers on 7 tables. What `user@host` owns them, and does provisioning rewrite DEFINERs when cloning a tenant DB? (A DEFINER naming a nonexistent user fails every write to `cases/contacts/tasks/case_relate/checkitems1/seq_steps`.) Suggest adding DEFINER to `lib/schemaDump.js`'s trigger query regardless.
2. **Stored routines** — live-inconclusive (same privilege artifact). Any?
3. **Will tenants share a MySQL server?** Decides whether the 5 `GET_LOCK` names (§A7) and the global `JSON_OVERLAPS` probe are bugs or non-issues.
4. **`sql_mode` provenance** — relaxed mode is live-verified on SiteGround, but MySQL 8.4 defaults are strict + ONLY_FULL_GROUP_BY. SiteGround default or explicit setting? Either way it becomes an explicit per-tenant-DB provisioning requirement (else `listCases` + `cases` inserts break day one).
5. **Edge routing / `x-original-host`** — `pageLanding.js:26` attributes it to "the Cloudflare Worker / proxy in front of mapped domains." Which hostnames reach Cloud Run directly vs through that Worker, and does anything set `x-original-host` for `app.4lsg.com` itself? The resolver's host-candidate order depends on it.
6. **MySQL grants model** — per-tenant DB users (isolation) vs one app user granted on all schemas? App user's actual privileges (TRIGGER? CREATE?) not visible through the RO key. Also: per-tenant RO users for `/api/readonly/sql`, or one RO user with per-schema SELECT?
7. **What fires the 60s cron** — Cloud Scheduler job URL/cadence/key for `ALL /process-jobs`? (No scheduler header check exists in code; auth is the shared yci key.) And the fan-out ruling: one tick per tenant host vs a platform fan-out endpoint.
8. **Is `CLOUD_TASKS_TARGET_URL` set on the service?** If set, all dispatch pins to one host and defeats host-borne tenancy (`taskQueue:148`).
9. **Cloud Tasks queue topology** — one `yc-jobs` queue with tenant-prefixed names, or a queue per tenant (quota isolation; fixes the name-collision differently).
10. **`JWT_SECRET` / `CREDENTIALS_ENCRYPTION_KEY`: per-tenant or shared-with-claim?** Needs the ruling before tenant 2 (§D2); includes the uploadTicket/booking HMAC keying.
11. **Which env vars are actually set on Cloud Run** (esp. `APP_URL`, `LANDING_HOSTS`, `FIRM_TIMEZONE`, legacy `API_KEY`, `DROPBOX_*`, `RINGCENTRAL_*`) — decides how hot each fallback in §B is.
12. **"get-clio-code" landing page** — not in the repo. The in-repo Clio surfaces are `GET /clio-code` + the temp proxy; if "get-clio-code" is a `tools`/`pages` row it's DB content. Which is it?
13. **`process_jobs_last_heartbeat_at`** — `routes/api.systemStatus.js` reads its age to detect a dead scheduler. Per-tenant heartbeat key or platform-level? (Else a quiet tenant looks like an outage.)
14. **Provider-side webhook configs** — Pabbly zaps, Zoho Sign webhook, Jotform, Quo all hold `app.4lsg.com` URLs in their consoles (not in repo); inventory needed at migration time.
15. **GCS** — one `gcs_bucket` registry key today: per-tenant buckets or prefixes?
16. **Settings/config-split taxonomy doc** — not in this repo; §B4's firm/platform classification is by judgment. Confirm against the ratified split before freezing the per-key table.
17. **Health probing** — nothing in-repo probes the service; does anything external? (`/api/version` is the de-facto probe and reads tenant data.)

---

# 4. Divergences from the brief's assumptions (repo wins)

1. **There is no cookie session.** The brief asked for cookie name/attributes/domain/store. Zero cookie auth exists (`server.js:29-33`, `routes/api.streak.js:12`); the addendum's "session-issuing surfaces" list is the six token-minting surfaces in §D1.
2. **`ycp_` does not exist.** Portal tokens are unprefixed JWTs with `aud:'contact'` (`portalAuthService.js:348`). Three prefixes exist: `yck_`, `yci_`, `ycro_`.
3. **`tenant_hosts` and `yc_master` do not exist yet.** Closest analogue: `pages.host` + `pageService` cache + `pageLanding` middleware — treated as the prototype, not the thing.
4. **The landing-host mechanism is origin separation, not tenancy** — `landing_hosts`/`landing_redirect` split a public origin from the app origin for ONE firm, specifically so authored page JS can't reach `/login` and mint a stealable JWT (`pageLanding.js:318-323`). Shapes look alike; the security property is different.
5. **`/hooks` no longer "responds, THEN executes the pipeline."** Since the 2026-08-24 split-phase slice, workflow/sequence targets run request-bound (`hookService.js:839, :895-898`); only `http`/`internal_function` are detached (`:909-914`). The `lib/taskQueue.js:12-17` comment describing the hook path as fully detached is stale (doc-debt).
6. **`2486213656` appears nowhere in production code** (4 hits in `tests/` fixtures only). `2484179800` and `2485592400` do appear (§B2 LOW/MODERATE).
7. **The env var is `FIRM_TIMEZONE`, not `FIRM_TZ`** — `FIRM_TZ` is only a JS identifier. Grepping the brief's name alone misses all six captures.
8. **The settings key is `fe-firm_phone`, not `firm_phone`** (the latter exists only as a response field, `manage.js:206`).
9. **`startup/dbScratch.js` does not exist** though the teardown checklist names it (`dbReadonly.js:102, :109`); scratch writes ride the main pool.
10. **The literal `settings` table is dead** — schema has it (`ref/database.sql:2896`) with zero code readers; all code reads `app_settings` (`settingsService.js:24`, `firmConfig.js:138`).
11. **One transaction span bypasses `withTransaction`** (`caseService.js:2186-2385`) against the CLAUDE.md doctrine; plus an inert callback-style `getConnection` on the promise pool (`routes/unplacehold.js:20`).
12. **Half the documented collation invariant is stale** — `court_ai_log.message_id` vs `email_log.message_id` no longer differ (both `utf8mb4_general_ci` live); the three in-SQL `COLLATE` clauses are no-ops and two comments assert a collation (`utf8mb4_unicode_ci`) that isn't there. The `utf8mb4_bin` half **is** confirmed. Doc-debt.
13. **"Live query preferred" for DEFINERs is impossible with the ycro key** — the SELECT-only grant hides TRIGGERS/ROUTINES (0 rows = privilege artifact), and the dump never captured DEFINER. Both routes blocked → §3-1.
14. **"get-clio-code landing page"** — no such route; see §E1/§3-12.

---

# 5. Reconciliation of the two audits

Both audits ran against the same commit. Where they disagreed, the repo was re-checked on 2026-10-05; rulings below are fresh-verified. ("A1" = the first audit, "A2" = the second.)

| # | item | A1 said | A2 said | **ruling (re-verified)** |
|---|---|---|---|---|
| 1 | trigger count | 15 across 7 tables | headline "16 across 8" (its own detail table sums to 15/7) | **15 across 7** — `grep -c "^CREATE TRIGGER" ref/database.sql` = 15; `contacts` ×3 is the only 3-trigger table |
| 2 | firmConfig REGISTRY size | (no count stated) | "20-key" (§B1) and "16 registry keys" (§B4) — self-contradictory | **18 keys** (counted `lib/firmConfig.js:54-103`) |
| 3 | SU rate-limit map | cited `limitCache` `:141` | cited `hits` `:133` | **both exist**: `hits:133` is the per-user bucket map (key `` `${tool}:${userId}` `` at `:167`) — the tenancy hazard; `limitCache:141` is a harmless per-tool limit memo. A2's citation was the right one for the claim |
| 4 | withTransaction call sites | 66 | 69 (54 bound) | **67 non-comment call sites, 54 bound form** (fresh grep; A1 over-filtered one, A2 counted ≥2 comment/def references) |
| 5 | `pageLanding` `req.db = db` lines | :591/:657/:676 | :588/:656/:674 | **:591/:657/:676** |
| 6 | `P.apiSend` reach-in count | 59 (html only) | 62 | **63** = 59 html + 4 js (`assetpicker.js`, `videoInsert.js`, `yc-forms.js`, `scripts.js`) |
| 7 | routes `req.db` coverage | (not counted) | "124 of 128", exception list naming 9 files under a "4 that don't" header | **136 route files; 125 use `req.db`; 11 don't** — 9 touch no DB directly, 2 (`db64`, `dbQuery`) capture the pool at module scope |
| 8 | firmConfig consumers | ~40 files | ~25 files | **39 files** require it (`grep -rln`) |
| 9 | TZ spread | 22 `FIRM_TZ`-token files; 2 module captures found | 6 captures; "14 transitive importers" | **6 independent module-scope captures** (A2 right — A1 missed 4: documentGenerateService:60, formPdfService:93, esignFilingService:82, api.streak:86) + **25 files** require timezoneService (both counts were off) |
| 10 | hook split-phase | echoed the stale `taskQueue.js` header ("responds, THEN executes") | corrected: fast targets request-bound since 2026-08-24 | **A2 right** — `FAST_TARGET_TYPES = {workflow, sequence}` run in phase 1 before the response (`hookService.js:839, :895-898`); only `http`/`internal_function` + finalize detach (`:909-914`; `api.hooks.js:216-222`). `taskQueue.js:12-17` comment = doc-debt |
| 11 | `2486213656` | "settings-resident, not in backend code" | "appears nowhere" | **zero in production code; 4 hits in `tests/` fixtures** (A2 excluded tests/ by charter; both right within scope) |
| 12 | `legalsolutions.group` spread | (not swept — A1 skipped `public/`) | "18 HTML files" | **10 files** (9 `public/*.html` + `views/v.html`), case-insensitive `grep -rli` |
| 13 | `api.sending.js` 4LSG lines | :126, :132, :156 | :126, :132, :134, :143, :145, :157 | **union: :126, :132, :134, :143, :145, :156, :157** — A1's case-sensitive `4lsg` grep missed the uppercase-only lines; A2 missed :156 |
| 14 | unawaited `.catch` scale | "62 files" (comment-marker metric) | "157 sites / 45 external" | different metrics, both defensible; conservative re-grep bounds it **≥107 sites**. Kept as a range with A2's external-system classification |
| 15 | api.hooks authed CRUD routes | (not counted) | 19 | **19 confirmed** (20 `jwtOrApiKey` occurrences − the require) |
| 16 | live sql_mode | SESSION only | GLOBAL + SESSION | both re-verified live; GLOBAL lacks `IGNORE_SPACE`, SESSION adds it |
| 17 | RO grants | inferred privilege-blindness from 0-row TRIGGERS | explicit `SHOW GRANTS` | **confirmed live**: `GRANT USAGE ON *.*` + `GRANT SELECT ON dbnwqdrfyz9vmq.*` |

**Material content unique to A2, now merged (spot-verified):** Dropbox folder-path literals ×4 + the appSettings double-space warning; `courtExecutor` constants (calendar `'primary'`, user ids 1/5); pinned credential ids in all four temp proxies + `aiService` 12; `gcalService` DEFAULT_CALENDAR_ID; `HEBCAL_ZIP`; `api.redirects` phone fallback; `/api/manage-config` credential-free; `api.checklists` `:1092`/`:1235` public routes; `api.firmData` `fe-%` wholesale query + `FIRM_TIMEZONE` read; GET_LOCK server-global inventory (§A7); task-name collision + no-OIDC + no-body facts (§C2); queue tables' zero tenant columns + idempotency-key and `name LIKE` collisions; hook auth-mode detail (non-timing-safe `!==` on header secrets; `_catchall`); `fieldDefService`/`availabilityService`/`errorMiddleware`/`videoLanding` caches; frontend TZ drift (`America/New_York` false-parity comments); `settings`-table state/watermark key family; `freelook.js` outbound-cookie clarification; routes/pages.js + shell sendFile inventory; XFF first-element logging note; GLOBAL sql_mode + SHOW GRANTS; env sweep extended to scripts (`DB_PORT`, `EI_*`…); P0-0 delete-first slice; §3 questions 2-4, 9, 12-13.

**Material content unique to A1, retained:** `JWT_SECRET` also keys the **uploadTicket and booking HMACs** (`lib/uploadTicket.js:74-97`, `routes/booking.js:874`) — extends the §D2 blast radius beyond JWTs; the dead `settings` table (§4-10); the inert callback `getConnection` (`routes/unplacehold.js:20`) and the non-transaction `getConnection` site list; `GET /clio-code` as the in-repo Clio surface (merged with A2's §3 question); RO route's RW audit-log split + per-query `MAX_EXECUTION_TIME`; the schema name and first round of live checks; `services/caseService.js:2186` bypass (both found; A1 flagged first); scheduled-jobs CRUD line corrections (`:519/:635/:711`); §3 questions 7-8, 11, 14-17.

---

*Inventory only. No design recommendations beyond the §1 slicing, as scoped.*