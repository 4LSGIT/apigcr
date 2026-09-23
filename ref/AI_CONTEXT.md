# YisraCase — AI Context Document
# Last updated: 2026-09-14 — compressed to skeleton form (~900 lines from ~3,100); §0 deltas folded into body; per-column facts moved to schema COMMENTs in ref/database.sql

<!-- ================= CURRENCY ================= -->
<!-- Reviewed-through: 8f6f5c3 (docs review #1, 2026-09-14). This doc is a   -->
<!-- SKELETON: what each subsystem is + the non-guessable invariants +       -->
<!-- pointers. Depth lives in manual/, schema truth in ref/database.sql      -->
<!-- (read its COMMENTs), route truth in ref/routes.md, working rules in     -->
<!-- CLAUDE.md, deferred work in ref/plans.md.                               -->
<!-- KNOWN MISSING SECTIONS (debt: docs/20260914_coverage_gaps): e-sign,     -->
<!-- portal, YisraForms/templates, reports, pipeline engine, document sync,  -->
<!-- booking landings. manual/ is authoritative for those meanwhile.        -->
<!-- CONSCIOUS DEFERRALS (review #1): the seven sections above --            -->
<!-- large, one arc of their own. Tools (29) is fully filed.                 -->
<!-- Doc-debt queue: scratch ns=docs. File doc≠code divergences there at    -->
<!-- discovery; the weekly docs review (DOCS_REVIEW.md) drains it and       -->
<!-- updates this block.                                                     -->
<!-- ============================================ -->

## 0. RECENT DELTAS AWAITING A SECTION HOME

*Entries live here only until their subsystem section exists (see coverage
gaps above); everything else from the September delta pass is folded into the
body. Governing migrations in `ref/migrations/`.*

- **G2 document generation (09-01):** `contract_templates.purpose`
  ('esign'|'generate'|'both') + `file_subfolder`;
  `services/documentGenerateService.js`; internal fn
  `document_generate_from_template` (workflow-only, needs `template_id` +
  `linkable_id`, `on_missing:'task'`). Non-esign twin of send-from-template.
- **G4/G4.2 Notice of Filing (09-01..02):** workflow 47 v2 fires on stage →
  `filed`; pre-checks raw columns in `query_db` + `custom_code` BEFORE
  rendering (chromium renders serialize on the 1GiB container). v1 not
  retired (3 executions reference it).
- **BK Worksheet W1 (09-01):** SS's sheet as a YisraView + per-row
  `open_form` (form `bk_worksheet`) → normal `PATCH /api/cases/:id`. First
  write affordance from a view; the view stays read-only.
- **DBKQ (09-04..06):** legacy debtor questionnaire is now a YisraForm
  (definition v1.2, pinned at ref/ root). Treat as an ordinary form.
- **FIL1 trustee validation (09-06):** internal fn `validate_case_trustee`
  (`lib/internal_functions/trustee.js`) on 341-notice ingest, gated by
  app_setting `trustee_validation_live` ('0' = dry-run, writes nothing).
- **Manage self-service policy (09-06):** `/m/<token>` links reach clients;
  `manage_allow_reschedule` / `manage_allow_rebook` / `manage_allow_cancel`
  app_settings read by `loadManageSettings` (routes/manage.js). Reschedule +
  rebook seeded closed; rebook must track reschedule.
- **SYNC-1 delete grace (09-08):** `documents.pending_delete_at` — provider
  delete stamps instead of flipping status; re-add clears; sweeper finalizes
  after grace. Fixes the 09-07 vanish-and-refill incident.
- **UDS density presets (09-23):** the `yc-theme-vars` localStorage store is
  two-axis — `preset` (palette) and `density` (compact/comfortable), density
  values written into BOTH mode sets. Axis membership is the ONE regex
  `/^--(fs|ctl-h|pad|gap)/` in `themeCustom.html`; `applyPreset`/`applyDensity`
  each rebuild only their own axis's keys. A token theme.css does NOT restate
  under `[data-theme="dark"]` is mode-shared (`isShared`): writers put it in
  both sets and `resetMode` sweeps it from both — it emptied one set only
  until 2026-09-23, so the page reported a state the app was not in.
  `scripts/checkThemePresets.js` lifts `PRESETS` only — density values must
  stay out of it. In `style.css`,
  `body` and `.logTable` carry `font-size: var(--fs)` (the table restatement
  is load-bearing: `case.html`/`contact.html` are quirks-mode, no doctype,
  and quirks tables don't inherit font-size — flip filed in `ref/plans.md`);
  `.tab-row` caps at `max(850px, 53.125em)`. Depth: `ref/THEME-CHEATSHEET.md`;
  mode stays per-device, server-side roaming parked for ui_config (S5).

## 1. SYSTEM OVERVIEW

Node.js/Express + MySQL case management, built by and for 4LSG (small
general-practice firm), Google Cloud Run, ~8 staff accounts.

### Framing invariants — read before asserting anything
1. **Not BK software.** `cases.case_type`/`case_subtype` drive behavior; the
   pipeline/trigger/form/workflow/document/event subsystems are type-neutral.
   Bankruptcy is the dominant vertical (~92%), so ~20 BK columns still sit on
   `cases` — legacy shape, not architecture. Every prior AI session got this
   wrong.
2. 4LSG runs 42 practice areas in Clio; YisraCase covers one well.
3. Clio = billing + litigation-calendar system of record. YisraCase = source
   of truth for cases, contacts, automation; stores Clio ids for linkage.
4. Documents live in Dropbox (153k indexed). Doc storage is not moving.
5. Human usage is low by design constraint (2–3 active staff, intake fell
   ~90% Apr 2026). Don't diagnose "nobody uses it" without that context.

### The engines (the old "Three Engines" framing is outdated)
- **Workflow** (`lib/workflow_engine.js`) — multi-step, branching, variables,
  audited executions.
- **Sequence** (`lib/sequenceEngine.js`) — contact-tied drip series that
  cancel themselves when the reason no longer applies.
- **Scheduled jobs** (`routes/scheduled_jobs.js`) — one-time/cron actions, no
  contact context.
- **Trigger system** (§26) — rules on internal domain events.
- Plus the rule layers that share the same primitives
  (`hookFilter`/`hookMapper`/`lib/actionDispatchers`): YisraHook (§16) and
  email/phone ingest (§27–28).

Shared: `scheduled_jobs` unified queue; `lib/internal_functions/` registry;
`resolverService` ({{table.column}}); `calendarService` (Jewish business
calendar); `smsService`/`emailService` (routed via `phone_lines` /
`email_credentials`); `settingsService`; `timezoneService`; `pabblyService`
(retiring bridge). All job types drain through `/process-jobs` (Cloud
Scheduler ~5 min) → per-type handlers in `job_executor.js` / engine modules.

## 2. DATABASE — CONCEPTUAL MODEL

Schema truth: `ref/database.sql` (auto-generated; **read the COMMENTs** — 
landmines are annotated in-schema). Style: `ref/SCHEMA_CONVENTIONS.md`.
Connection: mysql2 pool as `req.db`; `req.db.query(sql, params)` directly.

**Timezone:** human-entered times firm-local (America/Detroit), machine times
UTC. `appt_date` firm-local naive + `appt_date_utc` computed;
`scheduled_jobs.scheduled_time` UTC.

**Identifiers:** `cases.case_id` = 8-char alphanumeric varchar. `users.user`
is the PK (tinyint; NOT user_id); user 0 = automation actor (`task_from`,
`log_by`); `req.auth.userId` in routes. Role columns on users are additive
booleans (`user_type` = human, `does_appts`, …) — add with DEFAULT 1.

**Contacts:** `contact_kind` ('person'|'org') is the entity axis; orgs live
in the same table (no org table); org name triggers copy `contact_org_name`
into all three derived name columns; EIN in `contact_ssn` by design.
`contact_name`/`contact_lfm_name`/`contact_rname` are trigger-computed —
never write. Scalar `contact_phone`/`contact_email`/address fields are
server-maintained MIRRORS of the primary-active row in `contact_phones` /
`contact_emails` / `contact_addresses` (`lib/contactMirror.js`); children
carry lifecycle (`start_date` NULL = since forever, `end_date`,
`end_reason`) + generated-column uniqueness: one active primary per contact,
one active row per phone/email VALUE globally (addresses exempt — households
share; address edits are UPDATE-in-place, phones/emails end-and-replace).
Relationships: `contact_relations` + `contact_relation_types` catalog
(directional flag + reverse_label). Roles: `contact_roles` +
`contact_role_types` (open vocab, app-validated).

**Cases:** `case_number`/`case_number_full` opaque free text (docket parsing
client-only). `case_judge`/`case_trustee` free text AUTHORITATIVE with
`*_contact_id` twins (fill on match, NULL on miss, never block a write).
Judge resolution keys on docket suffix → the judge role's `judge_3` attr; trustee
vocab = the contact roster (`contact_roles` role rows via `lib/trusteeRoster`;
`fe-trustees` setting and `judges`/`trustees` tables removed 2026-09-24). `bk_*` columns deliberately
loose (sheet parity) — don't tighten. `case_relate` links contacts
(Primary/Secondary/Other/Bystander); portal visibility requires
Primary|Secondary.

**Linkable pattern:** `*_link_type` + `*_link_id` on tasks/log/checklists/
events; bare `*_link` columns are legacy. For log `link_type` 'phone'/'email',
`link_id` carries the normalized VALUE — contact attribution happens at read
time via date-windowed join on the child tables. Court emails: `log_link`
carries the SHORT docket (writer truncates via
`logService._truncateDocketLink`).

**Checklists:** one table, two shapes via `kind` ('checklist'|'note') — see
§19. Tag-identifying queries MUST also constrain `kind`
(`uq_link_kind_tag`).

**Credentials:** shared outbound-auth store, 5 types
(internal/bearer/api_key/basic/oauth2), `ENCv1:`-prefixed encrypted fields —
see §21.

**sql_mode is relaxed** (no STRICT_TRANS_TABLES / ONLY_FULL_GROUP_BY /
NO_BACKSLASH_ESCAPES): over-length writes truncate silently, unknown enum
values coerce to '', NOT-NULL columns take implicit defaults. Never enable
strict mode (case creation + listCases depend on relaxed). Widen enums BEFORE
deploying code that writes new values.

## 3. AUTH & CODE PATTERNS

`jwtOrApiKey` (lib/auth.jwtOrApiKey.js): `x-api-key` vs INTERNAL_API_KEY,
then Bearer JWT. Everything requires it except the public surface:
`GET /isWorkday`, `GET /api/public/docs/:caseId` (10/min),
`POST /api/public/get-upload-link`, `POST /hooks/:slug` (120/min per
slug+IP), `GET /r/:slug` (60/min), `GET /auth/oauth/callback`, external
forms, portal routes. Login limiter still 100/15min (tighten to 10 —
ref/plans.md).

**Respond-first:** external actions (SMS, email, GCal, sequences) run AFTER
`res.json()` — never block the response. Consequence: the UI can report
success while a post-commit side effect fails; verify via DB, not UI.

**Signature quirks:** `smsService.sendSms(db, from, to, message)` positional;
`emailService.sendEmail(db, {from,to,subject,text?,html?,attachments?})`
object. `/internal/mms/send` takes singular `attachment_url`.

**Pabbly** is a retiring bridge (`pabblyService.send`, fire-and-forget):
still carries Gmail sends, GCal for appts, some Dropbox ops. Replace
natively when convenient; never build new dependencies on it.

## 4. REST API — CONVENTIONS

Full inventory: `ref/routes.md` (auto-generated — middleware + handler per
route). Conventions:
- `GET /api/firm-data` → `{currentUser, phoneLines, emailFrom, users}`.
  `users` includes user 0 — filtering is the CONSUMER's job (§12 pattern).
- List endpoints: `?q, limit, offset, sort_by, sort_dir` → `{data, total}`.
  Detail endpoints take `?include=` and return only what's requested.
- **Contacts aggregate PATCH:** body may carry `phones`/`emails`/`addresses`
  arrays — each array is AUTHORITATIVE for its kind (omitting a current row
  ENDS it). Primary rules: 0 incoming primaries = keep current; 1 = switch;
  2+ = 400. 409 returns structured `conflicts` (cross-contact ownership);
  `?force=true` transfers silently. Response embeds the fresh contact.
  Dedicated child CRUD routes exist too; phone/email VALUE change is
  aggregate-only.
- **Log reader semantics:** contact scope = contact rows + legacy NULL-typed
  + phone/email-typed rows the contact owned at log_date (date-windowed);
  case scope = case rows + that expansion over `case_relate` contacts
  (`case_relate_filter=default|all|none`). Exported
  `_buildContactLogWhere`/`_buildCaseLogWhere` are the single source — all
  readers must produce identical results.
- **Checklist API kind rules:** rejects `items` on a note / `body` on a
  checklist by KEY PRESENCE (`items: []` is a 400 — pass null for "not
  supplied"); PATCH rejects `kind`; `status` writable on notes only.
- Date filters `from`/`to` = YYYY-MM-DD; `to` is inclusive via
  `< DATE_ADD(?, INTERVAL 1 DAY)`.

## 5. INTERNAL FUNCTIONS

Registry: `lib/internal_functions/` — `index.js` auto-loads sibling files, so
new function files need no consumer edits. Contract:
`async (params, db) => { success, output? }`; workflow steps consume output
via `{{this.output.*}}` and `set_vars`. Catalog: `GET /workflows/functions`
(workflow + sequence-filtered lists) or `manual/03-YisraFlow/05`.
`query_db` is the guarded generic read: JSON descriptor, allowlisted tables,
parameterized ops only, sensitive tables/columns blocked, limit clamps at
1000 silently. `update_db`/`insert_db` (db.js) carry per-table
allow/block maps (e.g. checklists blocks `kind`).

## 6. WORKFLOW ENGINE

Executions: `active → processing → delayed → completed |
completed_with_errors | failed | cancelled`. Start:
`POST /workflows/:id/start` → `{executionId}`.
Variables: `{{name}}` (init_data/set_vars), `{{this.output.field}}`,
`{{this.[0]}}`, `{{env.now|executionId|stepNumber}}`.
Steps: `{type, config:{function_name, params, set_vars}, error_policy}`;
policies `ignore` (default) | `abort` | `retry_then_ignore` |
`retry_then_abort`.
**isControlStep rule:** a function's next_step is honored only when its
`__meta.controlFlow` is true (evaluate_condition, set_next, foreach,
request_decision, schedule_resume, wait_for) — pinned with
`BRANCH_TARGET_PARAMS` by tests/control.flow.test.js. Max 20 steps per
invocation, then self-schedules continuation. Deferred steps become
`workflow_resume` jobs. In-loop status writes are guarded on
`status='processing'` — a cancel halts a running invocation at the next step
boundary. **Loops:** every pass must pause (wait ≥1 min / request_decision)
or loop back onto a foreach. Publish rejects other cycles (versionDiff
`findPauseFreeCycles`); at runtime the 21st back-jump without a pause, or
foreach pass 1,001, fails the run + critical alert (manual/03-YisraFlow/02
§ Loop protection). Versioning (draft/publish) per
`manual/03-YisraFlow/16` — workflows + sequences only, NOT trigger rules.

## 7. SEQUENCE ENGINE

Enroll: `POST /sequences/enroll {contact_id, template_type, trigger_data}`.
**Cascade match:** `sequence_template_types.priority_fields` (ordered,
most-specific first) scores template `filters` against trigger_data —
position i contributes 2^(N-1-i); wildcard never disqualifies; specific
mismatch or missing demanded field disqualifies; best score wins (id ASC
tiebreak). Manage Types UI edits `priority_fields`.
**Check chain per step:** enrollment active? → template condition (fail =
CANCEL enrollment) → fire guard → step condition (fail = skip step) →
resolve → act → log → schedule next.
Timing types: immediate / delay / next_business_day / business_days /
before_appt_fixed / before_appt (all calendar-aware, firm-TZ timeOfDay).
Conditions: parameterized SELECT + `assert` map against the row.
Cancellation is UPDATE (status trail), never DELETE.

## 8. UNIVERSAL RESOLVER

`resolverService.resolve({db, text, refs, strict})` →
`{status, text, unresolved, errors}`.
- `strict:true` does NOT throw on unresolved — returns `status:'failed'`;
  callers must check.
- DB infrastructure errors DO throw (so job retries work). `throw` =
  transient infra; `status:'failed'` = permanent semantic.
- `POST /resolve` always HTTP 200 — check body.
Filters: `|date:fmt`, `|phone`, `|upper`, chained `|default:`.

## 9. CALENDAR SERVICE

Jewish business calendar (Hebcal). Shabbos window Fri 18:00 → Sat 22:00;
Yom Tov days similarly 18:00-eve → 22:00; Sunday non-business in
`nextBusinessDay()`. Hebcal fails OPEN (returns []) — never blocks
scheduling. Routes: `GET /isWorkday` (no auth), `POST /nextBusinessDay`,
`POST /prevBusinessDay` (attempts ladder).

## 10. SCHEDULED JOBS

Unified `scheduled_jobs` queue, index (status, scheduled_time), drained by
`/process-jobs`. Scheduling types: `one_time`, `recurring` (cron,
`max_executions`/`expires_at`); execution flavors in `data.type`: `webhook`,
`internal_function`, `custom_code` (vm sandbox, 5s). Engine-internal:
`workflow_resume`, `sequence_step` (hidden from list unless
`?internal=true`). App-managed: `task_due_reminder`, `task_daily_digest`,
`hook_retry` (3 attempts, 120s backoff), `campaign_send`. Effective retry
backoff floor = the poll cadence (~5 min). Recurring `internal_function`
jobs are the house pattern for daily services (oauth refresh, event digest).

## 11. APPOINTMENT LIFECYCLE

All through `apptService`; every mutation follows the same shape — status
UPDATE → cancel reminder workflow → sequence effects → optional
comms/task → log → non-blocking GCal:
- `createAppt`: insert (+utc) → log → 341 Meeting updates
  `cases.case_341_current` → cancel no_show sequences → confirm SMS/email →
  GCal (fire-and-forget) → start reminder workflow (execution id stored on
  the appt).
- `markNoShow`: enroll no_show sequence unless already enrolled.
- `markAttended` / `cancelAppt` / `rescheduleAppt` (old → 'Rescheduled',
  new appt runs full createAppt chain) / `rescheduleLater`.
Status values are Title Case with spaces ('No Show', 'Canceled' one L).
`appt_end` is GENERATED.

## 12. FRONTEND ARCHITECTURE

**Shell:** `public/index.html` is the ONLY top-level shell (the other 55
HTML files are panes it loads in iframes; some, like `case.html` /
`contact.html`, nest their own). It owns JWT auth + `apiSend()` — apiSend
MUST stay in the shell; iframes use `const P = window.parent; P.apiSend(...)`.
`apiSend(endpoint, method='GET', payload=null, extraHeaders={})` → parsed
JSON (204 → null); re-login + one retry on 401; **non-2xx throws `ApiError`**
(`.message .status .statusText .body .url .method`) — structured 4xx callers
read `.body` directly. (`contact-form.html` still uses the pre-ApiError
direct-fetch bypass — refactor pending, plans.md.)

**firmData:** loaded once from `/api/firm-data`, relayed to iframes
(`window.firmData = P.firmData`). Includes user 0 by design. Role filtering
is declarative: `<select class="userslist" data-userlist-filter="does_appts">`
— the populate loop filters by that boolean column; no attribute = all users
(intentional for task_from/log_by filters). Swal-built dropdowns inline the
same `.filter(u => u.user_type)`. MySQL booleans arrive as 1/0 — truthy
checks fine, never `=== true`.

**entityData (parent-as-data-source):** `case2.html`/`contact2.html` load
the entity once into `window.entityData`; child form iframes read it (a
form's `endpoints.load.path` doubles as the lookup key) instead of
fetching. contact2 flattens phones/emails/addresses INTO
`entityData.contact` for the repeaters.

**Save → refresh → push:** ONLY `yc-forms.js` sends the `form-saved`
postMessage (forms sending their own = double refresh). Parent
`refreshEntityData`: re-fetch from API (never trust form-sent data) →
update header/tables → scan iframes for `ycForm` (try/catch — cross-origin
iframes throw SecurityError) → push fresh data into non-dirty forms
(`populate()` + re-run `onLoad`); dirty forms untouched. `_original`
re-snapshots after `onLoad` so computed fields don't look dirty.

**Boot:** iframes sourced during parent init use the `waitForParent` poll
(`if (P.apiSend) return init()`); lazy-loaded admin iframes skip it.
Content-height iframes post `{type:'iframe-resize'}`; parent sets height
(ResizeObserver + last-height dedupe on the form side).

**Repeaters (yc-forms.js)** are minimal — per-form glue that's always
needed: masks don't bind on cloned rows (`_setupMasks` runs once at init —
use a delegated capture-phase blur handler); `collect()` does NOT strip
masks on repeater inputs (server normalizes); primary-checkbox exclusivity
+ auto-promote logic is form-side; save-time "no primary" guard is the UI's
job (server aggregate path never auto-promotes).

**Key pages:** case2/contact2 (tabs of iframes: forms/*, sendingform,
communicate), `automationManager.html` (Workflows/Sequences/Jobs/Hooks
tabs), `campaign.html`, `checklistView(s).html` (§19), `eventform.html`,
`connections.html` (§21). Swal popups render in the PARENT DOM — inline
`onclick=` in Swal html resolves against parent scope and breaks for
iframe-defined functions; bind in `didOpen` instead.

## 13. WORKFLOWS IN PRODUCTION — retired section
Query the live `workflows` / `sequence_templates` tables; a static list here
was stale by definition.

## 14. PENDING / TODO — retired section
Deferred work lives in `ref/plans.md` (still-live items merged 2026-09-14).

## 15. QUIRKS THAT BITE

Cross-cutting invariants live in CLAUDE.md; schema-level ones are COMMENTs
in ref/database.sql. The rest:
1. Title-Case-with-spaces status enums; 'Canceled' one L.
2. `task_status` 'Deleted' (not 'Canceled'); 'Incomplete' is a frontend
   filter = IN (Pending, Due Today, Overdue).
3. Sequence/job cancellation = UPDATE to a terminal status, never DELETE.
4. Enum migrations: expand → data UPDATE → contract. Never out of order,
   and always BEFORE code that writes new values (relaxed sql_mode coerces
   unknown enum writes to '' silently).
5. `query_db` limit silently clamps at 1000.
6. Campaign retry backoff floor = poll cadence (~5 min).
7. `email_default_from` is the app_settings key (not email_from_default).
8. Deferred `require()` inside function bodies for circular imports
   (sequenceEngine ↔ internal_functions).
9. Per-row validators keep `is_primary: undefined` distinct from `false`
   ("didn't say" = auto-promote eligible on dedicated POST; aggregate path
   never auto-promotes). Reconciler demotes the displaced primary only when
   the new primary is a DIFFERENT row, and demote runs before inserts or
   `uk_one_active_primary` fires.
10. Cloud Run filesystem is case-sensitive — iframe `src=` casing matters.

## 16. YISRAHOOK — WEBHOOK RECEIVER & AUTOMATION ROUTER

One route `POST /hooks/:slug` replaces per-integration endpoints; each hook
is a DB row describing auth → filter → transform → ordered delivery
targets. 200 returns immediately; processing is async with per-execution +
per-delivery logs. Depth: `manual/03-YisraFlow/09-yisrahook.md`.

Target types: `http` (default) | `workflow` (transform output = init_data;
INSERT retries cleanly but async advance failure does NOT re-trigger
delivery retry) | `sequence` (enrollContact; duplicate enrolls throw) |
`internal_function` (`params_mapping` with literal/'flat'/dot-path sources;
NOT inherently idempotent — retried side effects can duplicate). All share
filter/transform/conditions/retry (`hook_retry` jobs). Internal deliveries
log synthetic `internal://…` URLs.

**Capture-before-publish (09-03):** the init-data capture block runs BEFORE
the never-published/inactive gate at all four execution-creation sites;
`hook_delivery_logs.status` includes 'captured'. Arming capture on a new
workflow stores the payload as its sample instead of losing it.

Tables: `hooks`, `hook_targets`, `hook_executions` (raw_input capped 512KB),
`hook_delivery_logs`, shared `credentials`. Files: `services/hookService.js`
(+ hookTransforms/hookMapper/hookFilter), `routes/api.hooks.js`. UI:
automationManager Hooks tab. `server.js` mounts rawBody on `/hooks` for
HMAC.

## 17. CAMPAIGN SYSTEM

Bulk SMS/email as ONE `campaign_send` job per contact (Cloud Run timeout
constraint), idempotency_key `campaign:{id}:{contactId}`, UNIQUE
(campaign_id, contact_id) on `campaign_results` backs recordResult's
upsert. executeSend: bail-as-skipped if canceled → opt-out check → channel
check → strict resolve → send → recordResult + checkCompletion (finalizes
sent/failed/partial_fail).
**Error classification:** skips + permanent errors record and return;
transient (socket/timeouts, SMTP 4xx, HTTP 429/5xx, DB blips, resolver
throws) THROW for job retry — except on the final attempt, where transient
is recorded as failed so completion can finalize. Unrecognized errors
default PERMANENT (duplicate sends are worse than one-attempt failures).
Cancellation deletes pending jobs by name prefix; in-flight jobs re-check
status and record 'skipped'. Contact refs only in resolver context.

## 18. TASK SYSTEM

`taskService` + `routes/api.tasks.js`; response `{data, total}`.
Flow: Pending → Due Today (digest run, on due date) → Overdue → Completed /
Deleted, both reversible via reopen (status recomputed from due date).
Transitions cancel/reschedule the `task_due_reminder` job
(`tasks.task_due_job_id`); reminder fires 8 AM firm time. Daily digest
(cron 13:00 UTC): ALWAYS refreshes statuses, sends only on workdays, per
`task_remind_freq`, optional SMS counts. Every event writes a linked log
row (created/updated/completed/deleted/reopened/transferred). Depth:
`manual/` task chapter + `TASK_SYSTEM_REFERENCE.md`.

## 19. NOTES & LISTS (checklists tables)

One table, two shapes via `checklists.kind`: 'checklist' (N `checkitems`,
`status` DERIVED by `computeAndSaveStatus` — never write it) | 'note'
(`body` text, zero items, `status` manual). The compute fn early-returns on
notes — one guard covering all five call sites including
`caseService.mergeCases`. Tagged rows unique per
(link_type, link, kind, tag) — **every tag-identifying query must also
constrain `kind`** (a note titled/tagged "Docs Needed" beside the real list
otherwise gets checkitems written onto it while the portal reads the
checklist — renders empty, no error). `FIND_DOCS_SQL` carries the kind
predicate; workflow 42 v3 fixed the same hole in DB-stored config.

**Docs Needed upsert** (`POST /checklists/upsert-items`): find-or-create the
case's checklist; each item replaces prior items matching on first 22 name
chars; public docs page returns incomplete items only.

**NATIVE_NOTES:** pinned virtual cards that read/write the legacy notes
COLUMNS (cases.case_notes, contacts.contact_notes, appts.appt_note,
events.event_note) — a VIEW, not a migration; client PATCHes the entity.
`cases.case_notes` cannot move (searchCases hot path, report 10, 3 form
templates, merge, tabLeads). `341_notes` deliberately unmapped (no write
path exists; form template 5 maps elsewhere). Known wart: case_notes
editable in two surfaces, last write wins.

**noteLimits:** `NOTE_MAX_CHARS=10000` (String.length) enforced in code at
six sites because relaxed sql_mode truncates silently (four appt_notes were
found cut mid-sentence at exactly 1000). Machine append paths (merge
concat, appt audit CONCATs) exempt by design. `update_db` can still bypass
for `checklists.body` — accepted gap.

**Frontend (all have bitten):** body save must NOT re-render (caret dies);
filtered-out cards must not be built-and-hidden (index matching); native
cards need synthetic draft keys (id is null); `flushBodies()` before
refetch; failed saves keep the draft; plain text only — never innerHTML a
body (no sanitizer exists in this repo).

**Merge:** loser→survivor consolidation matches on tag AND kind; notes fold
body across. Generic `update_db` blocks flipping `kind`.

## 20. COMMUNICATION UI

`communicate.html` (contact2 tabSend iframe): SMS / Email (Quill) / Log
Call panels; log-without-sending options; posts to `/internal/sms|mms|email/
send` + `/api/log`. `sendingform.html` (case2): modular doc-request actions,
server-side assembly via `POST /api/compose-docs-message`, Docs Needed →
`/checklists/upsert-items`.

## 21. CONNECTIONS — CREDENTIAL MANAGEMENT

Admin-only UI `connections.html`; manual chapters 14/15 in 03-YisraFlow.
Two tables: `credentials` (5 types) and `email_credentials` (smtp_pass
still plaintext — migration planned, plans.md).

**Encryption:** AES-256-GCM, wire format `ENCv1:` + base64(iv||tag||ct);
`isEncrypted` is a literal prefix check — the old length/charset heuristic
false-positived on provider secrets and silently left plaintext; never
reintroduce heuristics. Encrypted: oauth2 access/refresh tokens +
config.client_secret; bearer token; api_key key; basic password.
`CREDENTIALS_ENCRYPTION_KEY` env (32B base64) — boot fails fast without it.

**Injection (recurring trap):** `buildHeadersForCredential(db, id, url)` —
async, all 5 types — for ALL outbound HTTP. Sync `buildAuthHeaders` returns
`{}` for oauth2: request goes out unauthenticated, provider 401s, UI blames
allowed_urls. `checkUrlScope` pre-flights URL scoping.

**OAuth2** (`services/oauthService.js`): auth-code + PKCE(S256), state
lookup, refresh-token rotation handled. Refresh is hybrid: lazy
(`getValidAccessToken`, refreshes within 120s of expiry) + daily 03:00
Detroit internal-function job scanning expiring tokens. Both paths take
per-credential `GET_LOCK` + in-process dedupe (both layers required).
Failures: 2-strike before status flips to refresh_failed + one alert
(accommodates the daily-refresh window); admin re-authorizes in UI.
Initial exchange may lack a refresh_token (Google needs
access_type=offline + prompt=consent in extra_authorize_params) — UI warns.

**PUT is deep-merge** (one level) — single-field saves preserve the rest;
changing `type` wholesale-replaces config and wipes oauth state. Redirect
URI must exactly match `${APP_URL}/auth/oauth/callback`.

## 22. AI SESSION DB ACCESS (READONLY + SCRATCH)

Header `X-Readonly-Api-Key: ycro_<64hex>` (SU-managed, max TTL 3 days,
shown once) authorizes both endpoints. Every call logs to
`readonly_query_log` (full SQL + params).

**`POST /api/readonly/sql`** `{sql, params?, maxRows?, timeoutMs?}` →
`{ok, rows, fields, rowCount, truncated, durationMs}`. First keyword must
be SELECT/SHOW/DESCRIBE/DESC/EXPLAIN (comments stripped first). `WITH`
rejected deliberately (MySQL 8 allows WITH…UPDATE) — use subqueries.
Defense stack: SELECT-only DB grant, no multi-statements, keyword
allowlist, OUTFILE reject, per-query MAX_EXECUTION_TIME (default 30s / max
120s), row cap (default 5000 / max 20000, payload-truncating).

**Scratch:** `PUT /api/scratch/:ns/:k` `{v, meta?}` — `v` STRING-ONLY
(JSON.stringify objects yourself; meta may be JSON), MEDIUMTEXT ceiling.
`DELETE /api/scratch/:ns/:k`; `DELETE /api/scratch/:ns?confirm=1` wipes.
`ns`/`k` match `^[a-zA-Z0-9_\-]{1,64}$`. Reads go through the SQL endpoint
against `rw_scratch`. Live namespaces: `fred` (manager session state),
`docs` (doc-debt queue — see currency header).

Targeted queries over table dumps — tokens cost. Files:
`routes/api.readonly.js`, `routes/api.scratch.js`, `lib/sqlGuard.js`,
`startup/dbReadonly.js`.

## 23. EVENTS SUBSYSTEM

`events` = dated obligations/milestones — distinct from appts (attendee +
attendance lifecycle) and tasks (a user's to-do). ONE link target:
'case' | 'contact' | **'case_number'** | NULL. Schema + column semantics:
ref/database.sql.

**Docket linking (case_number):** court deadlines must calendar before an
internal case exists. `event_link_id` = docket VERBATIM (trim only; never
parse). Resolution is QUERY-SIDE and self-healing — rows never rewritten:
case-scoped listEvents ORs in case_number rows matching either docket
column; `resolved_case_id` comes from a shared correlated subquery (LIMIT
1, never a JOIN — fan-out). Clickability keys off resolved_case_id. Event
LOG rows write `log_link_type='case'` + docket in link_id (the log table's
existing court-email convention). Enum is expand-only.

**Invariant:** `event_all_day=1 ⇔ event_time IS NULL` (service-enforced).
**Input normalization throws on garbage** (relaxed sql_mode would store
`9/9/2024` → 0000-00-00 and `4:00 PM` → 04:00:00): accepts ISO, M/D/YYYY,
combined date+time, 12h AM/PM; TZ suffixes rejected (firm-local).

Service (`eventService`): GCal via native `gcalService` (NOT the dead
/internal/gcal) — all-day `{date}` + exclusive end, timed local-ISO;
reschedule = delete + create (appt pattern); per-event `event_calendar_id`
(NULL = default calendar, 'none' = skip incl. teardown). Reminders are
TASKS (`task_link_type='event'`), created on create/PATCH (reminder key
PRESENCE — even null — means act); complete/cancel deletes them. Side
effects post-commit, non-blocking. Batch create: ≤50, sequential per-item
results, no idempotency (double-fire duplicates), all-fail → 400,
partial → 200 'warning'.

**Statuses:** Scheduled | Completed | Canceled | **Rescheduled** (U6c —
status AND supersession pointer coexist, mirroring appts; liveness queries
ask "is this Scheduled?"). **Approaching (U8):**
`calendar_item_types.approaching_offsets` (JSON days-before; NULL/[] =
off) + claim table `calendar_approaching_emitted`; nightly
`emit_calendar_approaching` emits `calendar.approaching` events; a trigger
RULE decides what a reminder does — policy is data, zero emissions until
configured.

**Digest:** single implementation `run_event_digest` internal fn as a
recurring job (deliberately no job_executor branch). Sends on workdays;
window = tomorrow → next workday INCLUSIVE (covers closures). Recipients:
`event_digest_recipients` → `email_default_to` → FIRM_EMAIL → abort.

**fe-\* settings pattern:** firmData exposes app_settings keyed `fe-*` only
(prefix stripped, JSON-parsed) — frontend-readable settings without
backend changes; secrets stay non-fe. First user: `fe-event_types`.

Frontend: shell tabEvents + `event-updated` broadcast; entity tabs lazy
`refreshEvents()`; `newEventDialog` shared; rows return raw date/time,
client formats. Events hold their own notes/lists (event-scope is the only
unambiguous anchor for docket-linked rows).

## 24. YISRAVIDEO — ASSET PREP

Player `views/v.html` (`/v/<slug>`): `preload="metadata"`, so MP4 MUST be
faststart (moov before mdat) or iOS stalls. If already H.264+AAC, remux
losslessly (`-c copy -movflags +faststart`) — don't re-encode. Poster
1280×720 JPG (doubles as link preview — pick a clean frame). GIF 480×270
~12fps ~3.5s two-pass palette; Outlook freezes GIFs to frame 1, so start
on a camera-facing frame. Uploader gates: mp4 ≤500MB; insertion variants
auto-drop when poster/GIF absent. Depth: manual 11-YisraVideo.

## 25. SCHEMA REF AUTO-GENERATION

`ref/database.sql` regenerates itself: the pre-commit hook runs
`scripts/dump-schema.js` SYNCHRONOUSLY by default (~4s per commit; the
schema change lands in the SAME commit — the old detached default missed
`court_item_*` by 14 seconds). `SCHEMA_DUMP_ASYNC=1` backgrounds it for one
commit; `SKIP_SCHEMA_DUMP=1` skips it (`SCHEMA_DUMP_SYNC=1` still forces
sync — a no-op unless the hook default is flipped back). A structural
fingerprint (7 information_schema queries + a `database()` probe, volatile
fields excluded) gates the full dump — no diff churn. Commands:
`npm run db:ref` (`--force`, `--check`, `--timing`). DB failure warns and
exits 0. The hook does NOT touch `ref/routes.md` — regenerate that by hand
(`node scripts/updateRoutes.js`). Known: ~4s connection open from
residential IPs (SiteGround reverse-DNS) — Cloud Run unaffected; don't
"fix" pool timeouts for it. **Schema COMMENTs are the annotation channel**
— landmine notes go into the live DB via migration and flow into the dump
(see 2026-09-14_schema_comment_backfill.sql).

## ═══════════════════════════════════════════════════════════════
## 26. TRIGGER SYSTEM — DOMAIN EVENTS
## ═══════════════════════════════════════════════════════════════

*The fourth engine — §1's "Three Engines" framing predates it. Rules that
fire on INTERNAL domain events; third consumer of the shared automation
primitives (`hookFilter` / `hookMapper` / `lib/actionDispatchers`) after
YisraHook (§16) and the ingest rule layers (§27–28). Operator docs:
`manual/03-YisraFlow/15-triggers.md`; every table/column:
`manual/03-YisraFlow/12-database-schema.md`.*

### emit() contract (`lib/domainEvents.js`)
Fire-and-forget, NEVER throws/rejects — call it bare from service
post-commit zones, no `.catch()`. Engine failures are console.error'd and
alerted (`trigger_engine_error`); the caller's flow is never affected.

### Envelope
`{ event, ts, depth, chain, source ('manual'|'system'|'client'|'booking'|null),
actor:{user_id}|null, contact_id, case_id, data (row AFTER mutation),
changes ({field:{from,to}} — update-class events only), extra }`.
`contact_ssn` is stripped from `data` unconditionally — envelopes persist
into `trigger_executions.envelope`.

### Split-phase dispatch (2026-08-30)
`emit()` only INSERTs into `domain_event_queue` and rings a Cloud Tasks
doorbell. `lib/domainEventDrain.js` evaluates the tree request-bound
(`POST /process-domain-event/:id`; 60s `/process-jobs` cron fallback) at
full CPU. The queue row is the scheduling authority; the task is a doorbell.
(Before: detached post-response tail = CPU-throttled, unbounded wall time.)

### Tables
- `trigger_rules` — per `event_type`; `match_mode` `conditions|code`,
  `transform_mode` `passthrough|mapper|code`, `min_interval_s` throttle,
  `match_count`/`error_count` metrics. Live SQL edits propagate — no cache.
  NOT covered by automation versioning (that is workflows + sequences only).
- `trigger_rule_actions` — ordered; `action_type`
  `workflow|sequence|internal_function|http|hook` (`hook` re-enters the
  YisraHook pipeline). **The UI DELETE+REINSERTs these rows on every save —
  never patch by action `id` (§15 pitfalls / CLAUDE.md).**
- `trigger_executions` — exactly ONE row per processed event
  (`matched|partial|no_match|no_rules|depth_capped|error`), carrying the
  envelope. `no_match`/`no_rules` rows are kept ON PURPOSE — they are the
  sample-envelope source for the trigger UI's field-discovery panel.
- `trigger_execution_rules` — per-rule outcome detail.

### Hard semantics (carried from the ingest rule engine — do not soften)
- A THROWING match counts as NON-match (fail-safe), and is RECORDED —
  warning on the execution row + `error_count` bump + `trigger_match_failed`
  alert. Fail-safe, not fail-quiet.
- `NULL match_config` in conditions mode = NON-match, NOT match-all.
  Explicit always-match is `{operator:'and', conditions:[]}`.
- A failed transform → rule counts as MATCHED (metrics) but its actions do
  NOT fire. Never feed garbage to actions.
- Action failures are isolated — one failure aborts neither the rule's
  remaining actions nor later rules.

### Loop guard
Actions run inside `runAsAction(ruleId, fn)` (AsyncLocalStorage): re-emitted
events carry `depth+1` and the rule id on `chain`; events at
`depth >= MAX_DEPTH` are dropped with a `depth_capped` row + alert. Known
limitation: workflow steps deferred through `scheduled_jobs` resume with a
fresh ALS scope (depth resets) — acceptable, executor cadence throttles them.

### Replay
`POST /api/triggers/replay` is execution_id-ONLY (review item S10): it
re-dispatches a RECORDED envelope — real actions, new execution row. Raw
envelopes are not accepted.

### Event vocabulary (live in code, 2026-09-14)
`appt.created/attended/no_show/cancelled/rescheduled/reschedule_later`,
`calendar.scheduled/rescheduled/cancelled/resolved/approaching`,
`case.updated/stage_advanced/stage_aged/contact_linked/contact_unlinked/
court_processed/trustee_validated`, `contact.created/updated`,
`document.created/updated/linked`, `esign.sent/status_changed`,
`form.submitted`. Nightly synthetic emitters follow one house pattern
(`emit_stage_aged`, `emit_calendar_approaching`; catalog in the manual).

## ═══════════════════════════════════════════════════════════════
## 27. EMAIL INGEST
## ═══════════════════════════════════════════════════════════════

*The front door for inbound (and outbound-copy) email. Operator docs:
`manual/03-YisraFlow/10-ingest.md`.*

### Entry
`POST /api/email/ingest` (`routes/api.emailIngest.js`, rate-limited),
api-key auth against `email_ingest_sources`. Adapters normalize and push:
SiteGround PHP (domain mailboxes) and Google Apps Script for the Gmail firm
account — the deployed GAS source is tracked at `ref/gas.js` and code
comments reference it BY LINE NUMBER (don't move it).

### Three layers — and the independence invariant
1. **Forensic** — `email_log` row for EVERY ingest, including firm-to-firm
   and duplicates: the byte-level record. Dedup is a pre-check on
   `(source, message_id)` + race-safe `INSERT IGNORE`.
2. **Suppression (Layer 2)** — decides the structured LOG WRITE only.
3. **Automation (Layer 3)** — ALWAYS runs, regardless of suppression AND of
   the downstream log-write outcome (Slice 2.3.1 hoisted it above the log
   step precisely so this holds on error branches). Matching rules'
   transforms run; actions fire via `lib/actionDispatchers` + hookService.

Then conditional `logService.createLogEntry` (skipped iff suppressed;
`INVALID_LOG_LINK_ID` → `error` execution row that still carries Layer-3
outcomes in metadata). One `email_ingest_executions` row on EVERY path,
including auth failures (written by the route).

### Direction & firm-to-firm
`from.email` domain ∈ `EMAIL_DOMAINS` → `outgoing`, else `incoming`.
All addresses on firm domains → firm-to-firm: forensic row yes, structured
log no.

### Tables
`email_log`, `email_ingest_sources`, `email_ingest_rules`,
`email_ingest_rule_actions`, `email_ingest_log_suppressions`,
`email_ingest_executions`. The `email_router_*` tables are DEAD (tear-out
pending). Collation landmine: `court_ai_log.message_id` joins against
`email_log.message_id` need explicit `COLLATE` (§15 / CLAUDE.md).

## ═══════════════════════════════════════════════════════════════
## 28. PHONE / SMS INGEST
## ═══════════════════════════════════════════════════════════════

*Calls, SMS, and other provider phone events. Operator docs:
`manual/03-YisraFlow/10-ingest.md`.*

### Entry chain
RingCentral webhook → YisraHook receiver (§16) → workflow → `phone_log`
internal function (`lib/internal_functions/log.js`) →
`services/phoneIngestService.js`. The pipeline body is a verbatim extraction
of the old inline `phone_log` implementation; Layer 3 was wired in after,
mirroring email.

### Pipeline (per event)
1. **firmToFirm enrichment** — stamped as `extra.firmToFirm`, a MATCH FIELD,
   not a hardcoded skip: suppressing firm-to-firm traffic is an operator
   choice via a normal suppression rule. (Hence no `skipped_firm_to_firm`
   status on phone — it surfaces as `suppressed` or `logged`.)
2. **MTH-2 dedup pre-check** — SELECT on the unique `(provider,
   provider_ref)` key BEFORE Layers 2/3. A TRUE redelivery of an
   already-TERMINAL event returns a `duplicate` execution row that ECHOES
   the original outcome, and Layers 2/3 do NOT re-run — redelivery can
   never re-fire automation. `log_id` alone is NOT the terminal test (the
   suppressed path never writes a log). Skipped when either key half NULL.
3. **`phone_event_log` forensic catch-all** — ALWAYS, idempotent upsert.
4. **Layer 2 suppression** — LOG WRITE only (design call 1A); never halts
   the surrounding workflow. `output.suppressed` surfaced for branching.
5. **Layer 3 rules** — ALWAYS, independent of suppression and log outcome.
6. Conditional `createLogEntry`; exactly one `phone_ingest_executions` row
   (`logged|suppressed|error|duplicate`).

### Tables
`phone_event_log`, `phone_ingest_rules`, `phone_ingest_rule_actions`,
`phone_log_suppressions`, `phone_ingest_executions`. The firm-number cache
has a reset hook (`resetFirmNumberCache`) re-exported through the internal
function registry for tests.

## ═══════════════════════════════════════════════════════════════
## 29. TOOLS — SU-AUTHORED, DB-STORED PAGES
## ═══════════════════════════════════════════════════════════════

Internal HTML utilities stored in the DB and served on the app origin. An SU
authors a page in the manager; it is served at `/tool/<key>` and runs as an
iframe child of the shell on the parent's `apiSend` — the same runtime
contract as `public/customView.html`.

Code: `routes/api.tools.js` — **its header block is the contract; read it
before changing anything here.** UI `public/toolManager.html` (Admin tab →
Tools (SU)). Manual `manual/08-Admin-Tools/06-tools.md`. Tests
`tests/apiTools.routes.test.js`.

### Tables
- `tools` — `tool_key` varchar(80) UNIQUE (`/^[a-z0-9-]{1,80}$/`), `title`,
  `status` enum('draft','live'), `html` mediumtext, `updated_by` varchar(100).
- `tool_versions` — save history, FK → `tools` ON DELETE CASCADE.

No migration is filed for either table: plain DDL, wholly captured by
`ref/database.sql` (retention rule in `ref/README.md`). Absence of a file in
`ref/migrations/` is not evidence the change never happened.

### Invariants — do not soften
1. **Same-origin is deliberate.** A tool is authored code, not user content.
   The boundary is *who may write the table*, not what the HTML may do. Never
   reason about a tool body as if it were untrusted input, and never "fix"
   this by sandboxing the output.
2. **`/tool/*` and `/api/tools/*` stay OFF the `routes/pageLanding.js`
   allowlist**, so they dead-end on the landing host. Locked by test. Nothing
   in this subsystem touches the `pages` table or the landing-host system.
3. **Write path is SU-only with step-up.** Every `/api/tools/*` route carries
   `superuserOnlyFor('tools')` — JWT-only + SU + `X-SU-Elevation` + per-tool
   rate limit; API keys are refused 403. `superuserOnlyFor` audits only
   REJECTIONS, so each successful create/update/delete/restore audits itself
   via `auditAdminAction` (same pattern as `admin.systemAlerts.js`). Reads
   are not audited.
4. **Serve path is public and unauthenticated.** `GET /tool/:key` is gated
   only by `status='live'` — a draft 404s. Treat a live tool's body as
   readable by anyone holding the URL. 404 is plain text, deliberately not
   the `deadPage` firm-site redirect: an internal utility URL is not
   marketing surface.
5. **Versioning (single source of truth).** On any save where `html` is
   provided AND differs from stored, a `tool_versions` row is appended with
   the NEW html — so the newest row always equals `tools.html` and restore is
   literally "copy row N back". A title/status-only PATCH appends nothing; a
   no-op restore appends nothing; deleting the newest version row is a 400.
   The append is non-transactional by house style — a crash between the two
   statements loses one history row, never the tool.
