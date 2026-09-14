# YisraCase — AI Context Document
# Last updated: 2026-09-14 — September deltas folded as §0; NEW SECTIONS §26 Trigger System, §27 Email Ingest, §28 Phone/SMS Ingest (previously undocumented engines)

<!-- ================= CURRENCY ================= -->
<!-- Reviewed-through: 2026-09-14 delta pass (§0). Body sections below §0    -->
<!-- still reflect the August 2026 full review — §0 overrides them where     -->
<!-- they conflict.                                                          -->
<!-- Open doc debt lives in scratch ns=docs (SELECT k,v FROM rw_scratch      -->
<!-- WHERE ns='docs'). File new debt there the moment you find doc≠code.     -->
<!-- The weekly docs review (ref/DOCS_REVIEW.md) drains that queue, folds §0 -->
<!-- into home sections, and updates this block.                             -->
<!-- KNOWN MISSING SECTIONS (filed as debt 20260914_coverage_gaps): e-sign,  -->
<!-- portal, YisraForms/templates, reports, pipeline engine, document sync,  -->
<!-- booking landings. Until written, the manual/ chapters are authoritative -->
<!-- for those subsystems.                                                   -->
<!-- ============================================ -->

## 0. SEPTEMBER 2026 DELTAS — READ FIRST

*Catch-up block, 2026-09-14. Each entry is verified against the migration in
`ref/migrations/`, the current `ref/database.sql`, and code. Where an entry
conflicts with an older section below, THIS section wins. The weekly docs
review folds these into their home sections and deletes the entry.*

### 0.1 Domain-event dispatch is split-phase (2026-08-30)
`lib/domainEvents.emit()` no longer runs the trigger tree inline in a detached
async IIFE (post-response = CPU-throttled on Cloud Run, unbounded wall time).
It now INSERTs a row into `domain_event_queue` and rings a Cloud Tasks
doorbell; the tree is evaluated request-bound by `POST /process-domain-event/:id`,
with the 60s `/process-jobs` cron as fallback drain. The queue row is the
scheduling authority — the Cloud Task is only a doorbell. Trade: correctness
risk (tree aborted mid-flight) became a bounded latency risk (worst ~60s).

### 0.2 Unified Events tail (U6c, U8) (2026-09-02..03)
- **U6c:** `events.event_status` gains `'Rescheduled'` — status AND
  supersession pointer coexist, mirroring `appts` (`appt_status` +
  `rescheduled_from_appt_id`). Overrules v0.5 §3.4 ("supersession is the
  pointer, never a status"). Liveness queries ask "is this Scheduled?".
- **U8:** `calendar.approaching` reminders. `calendar_item_types.approaching_offsets`
  (JSON days-before array, e.g. `[7,1]`; NULL/[] = feature off for that type)
  + claim table `calendar_approaching_emitted`. Nightly internal function
  `emit_calendar_approaching` emits synthetic events; a TRIGGER RULE decides
  what the reminder does. Policy is data (Case Config), not code. Zero
  emissions at deploy — nothing seeded.

### 0.3 Capture-before-publish (YisraHook) (2026-09-03)
`hook_delivery_logs.status` gains `'captured'`. The init-data capture block
now runs BEFORE the never-published/inactive gate at all four
execution-creation sites: arming capture on a brand-new workflow stores the
payload as its `init_data` sample instead of losing it ("no sample → no
workflow → never captures" deadlock, delivery log 10672). sql_mode note: the
enum had to be widened BEFORE code deploy — non-strict mode coerces unknown
enum writes to `''` silently.

### 0.4 G2 — generate documents from templates (2026-09-01)
Non-esign twin of send-from-template. `contract_templates` gains
`purpose ENUM('esign','generate','both')` (decides which picker shows the
template) and `file_subfolder VARCHAR(64)` (where the generated file lands in
the case folder). `services/documentGenerateService.js` renders + files
without a signature ceremony. New internal function
`document_generate_from_template` (workflow-only, `lib/internal_functions/documents.js`)
— requires `template_id` + `linkable_id`, supports `on_missing:'task'`.

### 0.5 G4/G4.2 — Notice of Filing automation (2026-09-01..02)
Workflow 47 "Notice of Filing → client", fires when a case advances into the
`filed` stage; template JSON at `ref/templates/notice_of_bankruptcy_filing.json`.
v2 (current) pre-checks the raw columns it needs in its existing `query_db`
step and gates in a sandboxed `custom_code` step BEFORE rendering — html
renders go through chromium, which serializes on the 1GiB container, so a
render is the most expensive way to discover `case_judge` is blank.
`on_missing:'task'` stays on the generate step as backstop (pre-check reads
raw columns; resolvers can still resolve populated values to `''`). v1 not
retired — three executions reference it.

### 0.6 BK Worksheet (W1) (2026-09-01)
SS's Google-Sheet docket ("Bankruptcy Case List") mirrored as a YisraView +
per-row `open_form` modal (YisraForm `bk_worksheet`) → ordinary authed
`PATCH /api/cases/:id`. First write affordance reachable from a view; the
view itself stays read-only. ~20 deliberately LOOSE `bk_*` columns on `cases`
(free text in practice; only 4 are real dates) — where YC already had a
matching structured column (`case_341_*`, `docs_due`, `matrix`, `schedules`,
`case_discharge_date`, …) the view/form use THAT. Do not "tighten" bk_*
columns into enums.

### 0.7 DBKQ form cutover (2026-09-04..06)
The legacy debtor-questionnaire HTML became a YisraForm (definition v1.2,
pinned at `ref/2026-09-06_dbkq_definition.v1.2.json`, snapshot + converter
under `ref/` pinned files / `ref/archive/`). Treat as an ordinary form now.

### 0.8 FIL1 — trustee validation (2026-09-06)
Internal function `validate_case_trustee` (`lib/internal_functions/trustee.js`)
fired by an ACTIVE trigger rule on 341-notice ingest, gated by app_setting
`trustee_validation_live`: `'0'` (shipped default) = dry-run — summary email
to it@4lsg.com + `[DRY RUN]` task to user 6, writes nothing; `'1'` = live —
writes `cases.case_trustee` / `case_341_link`, alerts Rena. Arm via settings
UI, not deploy.

### 0.9 Manage-page self-service policy (2026-09-06)
`/m/<token>` manage links reach real clients (booking-view confirm SMS +
staff appt-dialog), but self-rescheduling is NOT approved. Three app_settings
bools read by `loadManageSettings` (`routes/manage.js`):
`manage_allow_reschedule`, `manage_allow_rebook`, `manage_allow_cancel` —
reschedule/rebook seeded `'0'` (closed). Invariant: `allow_rebook` must track
`allow_reschedule` (cancel-then-rebook = reschedule in two clicks).

### 0.10 SYNC-1 — document delete grace (2026-09-08)
`documents.pending_delete_at` (+ `idx_docs_pending_delete`,
`idx_docs_path_lower`). A Dropbox-delta `deleted` entry no longer flips
`status='deleted'` — it stamps `pending_delete_at`; the row stays active and
visible. Any provider re-add clears the stamp; a sweeper finalizes after the
grace window. Fixes the 2026-09-07 incident where a cursor persisted between
a delete page and its re-add page emptied 791 rows from a case view for ~12
minutes mid-business-hours.

### 0.11 Org-kind contacts (slices 1–3, 2026-09-08)
`contacts.contact_kind` varchar(12) `'person'|'org'` is the ENTITY axis;
`contact_type` remains a dirty free-text role label — never overload it.
Orgs live in `contacts`, no separate table. Name triggers branch on
`contact_kind='org'`: all three derived name columns = `contact_org_name`
verbatim (no comma flip; feeds Dropbox foldering via `contact_lfm_name`);
fname/mname/lname forced blank. `contact_pname` doubles as DBA and is never
blanked. EIN is stored in `contact_ssn` — inherits SSN masking AND the
resolver block, so templates cannot emit EIN by design. Intake route:
explicit `contact_kind='org'` skips value-matching entirely (orgs share
phone/email with their officers). New relation types: `officer_of`,
`member_of`, `authorized_signer`, `registered_agent`. Portal case visibility
still requires `case_relate_type IN ('Primary','Secondary')`.

### 0.12 Contact roles + judge/trustee twins (m4/m5, 2026-09-09; arc ongoing)
New tables `contact_role_types` (open vocabulary lookup, app-level validation
— sql_mode is non-strict) and `contact_roles`. `cases` gains twin columns
`case_judge_contact_id` / `case_trustee_contact_id`: free-text `case_judge` /
`case_trustee` STAY authoritative; twins fill on match and NULL on miss —
resolution never blocks a write. Judge resolution keys on the docket suffix
of `case_number_full` (`judges.judge_3`, e.g. `lsg` = Lisa S. Gretchko);
name-match is fallback only. Trustees seeded from the `fe-trustees` setting
(the `trustees` TABLE is dead — varchar(22) truncated names); `fe-trustees`
remains authoritative until slice 7. Arc state: 7A deployed; m6 + 7B pending
— check scratch/project memory before touching this area.

### 0.13 Trigger system + email/phone ingest — now documented (§26–28)
These engines shipped Jul–Aug 2026 but never got sections; §26–28 (end of
doc) now cover them. §1's "Three Engines" framing is outdated: the Trigger
System (§26) is a fourth engine, and YisraHook (§16), the ingest rule layers
(§27–28), and triggers all share one primitive set
(`hookFilter`/`hookMapper`/`lib/actionDispatchers`).

---

This document is the authoritative reference for the YisraCase system.
Load it as project knowledge before any conversation about this codebase.

---

## 1. SYSTEM OVERVIEW

YisraCase is a Node.js/Express + MySQL case-management platform built by and for 4LSG,
a small general-practice firm, hosted on Google Cloud Run. ~8 staff accounts.

YisraCase is CASE-TYPE AGNOSTIC BY DESIGN. `cases.case_type` / `case_subtype` drive
type-specific behaviour; the pipeline, trigger, form, workflow, document and event
subsystems are all type-neutral. Bankruptcy is the first and currently dominant vertical
(~92% of records), which is why ~20 BK-specific columns still sit directly on `cases`
(matrix, schedules, case_341_*, case_180, case_preference, filing_fee, case_trustee, …).
THAT IS LEGACY SHAPE, NOT ARCHITECTURE — those columns are slated to move to a type
extension. Do not describe YisraCase as bankruptcy software, and do not design as though
BK is the only case type.

### Framing invariants — read before asserting anything about this system

1. Not BK software. See above. Every prior AI session has gotten this wrong; the schema
   misleads, the intent does not.
2. 4LSG runs 42 practice areas in Clio. YisraCase currently covers one of them well.
3. Clio is the firm's billing and litigation-calendar system of record. YisraCase is the
   source of truth for cases, contacts and automation, and stores Clio ids for linkage.
4. Documents live in Dropbox (153k indexed). Clio holds ~236. Doc storage is not moving.
5. Human usage of YisraCase is low by design constraint, not by product failure — the
   firm has 2-3 active staff and intake volume fell ~90% in April 2026. Do not diagnose
   "nobody uses it" without checking headcount and demand for the same period.

The system has these major subsystems:
- **Three automation engines** — workflow, sequence, scheduled jobs — sharing infrastructure
- **YisraHook** — configurable webhook receiver
- **YisraForms** — internal form framework (replaces JotForm)
- **Campaign Manager** — bulk SMS/email with per-contact scheduled jobs
- **YisraVideo** — short personalized videos with a branded player page (see §24)

### The Three Engines

**Workflow Engine** (`lib/workflow_engine.js`)
Multi-step processes with data flow, branching, delays, and auditable execution history.
Use when: complex multi-step logic, branching, variable passing between steps.

**Sequence Engine** (`lib/sequenceEngine.js`)
Contact-specific drip sequences. Enrolled and cancelled from outside.
Checks conditions before every step — cancels itself if the reason no longer applies.
Use when: follow-up SMS/email series tied to a contact event, auto-cancellable.

**Scheduled Job Scheduler** (`routes/scheduled_jobs.js`)
Single actions at a specific time or recurring schedule. No contact context, no chaining.
Use when: recurring digests, one-time future actions, webhook triggers.

### Shared Infrastructure
- `scheduled_jobs` table — unified job queue for all subsystems
- `lib/internal_functions.js` — action library (SMS, email, task, DB queries)
- `services/resolverService.js` — universal `{{table.column}}` placeholder resolver
- `services/calendarService.js` — Jewish business calendar (Shabbos + Yom Tov aware)
- `services/smsService.js` — routes SMS via `phone_lines` table
- `services/emailService.js` — routes email via `email_credentials` table
- `services/settingsService.js` — `getSetting(db, key)`, `getSettings(db, keys[])`
- `services/timezoneService.js` — `localToUTC()`, `utcToLocal()`, `nowLocal()`, `formatLocal()`
- `services/pabblyService.js` — `send(db, service, data)` fire-and-forget bridge for Gmail/GCal/Dropbox

### How Jobs Flow
```
/process-jobs (polls every ~5 minutes via Cloud Scheduler — TODO: change to every minute)
  ├── workflow_resume      → advanceWorkflow()              in workflow_engine.js
  ├── sequence_step        → executeStep()                  in sequenceEngine.js
  ├── hook_retry           → hookService.executeRetry()     in hookService.js
  ├── campaign_send        → campaignService.executeSend()  in campaignService.js
  ├── task_due_reminder    → inline block                   in job_executor.js
  ├── task_daily_digest    → inline block                   in job_executor.js
  └── one_time/recurring   → executeJob() (webhook/internal_function/custom_code)
```

---

## 2. DATABASE

**Connection:** `mysql2` with `pool.promise()`. In routes, `req.db` is the pool.
Call `req.db.query(sql, params)` directly — never `req.db.getConnection()` for simple queries.

### Timezone Rule
"Human-entered times in firm timezone, machine-generated times in UTC."
- `appt_date` = firm local (America/Detroit), entered by staff
- `appt_date_utc` = real UTC, computed by `localToUTC()`
- `scheduled_jobs.scheduled_time` = UTC always
- `FIRM_TIMEZONE=America/Detroit` in .env

### Key Tables

#### `contacts`
PK: `contact_id` (int)
Key columns: `contact_fname`, `contact_lname`, `contact_name` (trigger-computed),
`contact_lfm_name` (trigger-computed), `contact_rname` (trigger-computed),
`contact_pname`, `contact_phone` (char 10), `contact_email`,
`contact_phone2`, `contact_email2`, `contact_type`, `contact_address`,
`contact_city`, `contact_state`, `contact_zip`, `contact_dob`,
`contact_marital_status`, `contact_tags`, `contact_notes`, `contact_created`,
`contact_sms_optout` (tinyint, default 0), `contact_email_optout` (tinyint, default 0)
Sensitive: `contact_ssn` — never expose via API list endpoints; single-contact fetch OK for staff
IMPORTANT: `contact_name`, `contact_lfm_name`, `contact_rname` are trigger-computed — never write directly
**MIRROR COLUMNS (post Slice 3):** `contact_phone`, `contact_email`, `contact_address`/
`contact_city`/`contact_state`/`contact_zip` are now server-maintained MIRRORS of
the primary-active row in `contact_phones` / `contact_emails` / `contact_addresses`.
Recomputed on every aggregate PATCH and every dedicated-route mutation via
`lib/contactMirror.js` (`recomputePrimaryPhone` / `recomputePrimaryEmail` /
`recomputePrimaryAddress` — idempotent). Direct PATCH of these scalar columns
still works (legacy code paths) and is propagated to children via
`_propagatePhone` / `_propagateEmail` / `_propagateAddress` in `contactService.js`.
The form UI no longer surfaces these scalars — they're authoritative reads only.
`contact_phone2` / `contact_email2` remain vestigial scalar-only (not mirrored,
not in form UI as of Slice 3 B.2; values for 1–2 affected contacts handled manually).

#### `cases`
PK: `case_id` (varchar 20, 8-char alphanumeric e.g. "uT7EU36v")
Key columns: `case_number`, `case_number_full`, `case_type`, `case_stage`
  (enum: 'Lead','Open','Pending','Filed','Concluded','Closed'),
`case_status`, `case_open_date`, `case_file_date`, `case_close_date`,
`case_judge` (varchar — stores judge name, join to judges.judge_name),
`case_trustee` (varchar — stores trustee name, join to trustees.trustee_full_name),
`case_notes`, `case_alerts`, `case_dropbox`, `case_341_current`, `case_341_form`
Note: case_judge and case_trustee are NOT FKs — join by name equality

#### `case_relate`
Links contacts to cases. PK: `case_relate_id`
Columns: `case_relate_case_id`, `case_relate_client_id`, `case_relate_type`
  (Primary/Secondary/Other/Bystander)

#### `contact_phones` (Slice 3 — multi-value phones)
PK: `id` (int auto-increment). FK: `contact_id` → contacts (ON DELETE CASCADE).
Columns: `phone` (char 10), `label` (enum: Mobile/Home/Work/Office/Fax/Other),
`is_primary` (tinyint), `sms_optout`, `mms_capable` (default 1), `verified`,
`start_date`, `end_date`, `end_reason` (enum: ended/replaced/transferred/moved/removed),
`notes`, `created_by`, `updated_by`, `created_at`, `updated_at`.
Generated virtual unique indexes:
- `uk_one_active_primary` — at most one primary-active row per contact
- `uk_phone_active` — at most one active row per phone value globally (cross-contact)
NOTE: `uc_contact_phone` was dropped in Slice 2 Stage 1 revision — same-contact
historical reclamation (ended rows with same value) is now allowed.

#### `contact_emails` (Slice 3 — multi-value emails)
Same shape as contact_phones with email-specific fields:
`email` (varchar 255), `label` (enum), `email_optout`, `verified`, lifecycle/audit columns.
`uk_email_active` is the global active-uniqueness constraint.

#### `contact_addresses` (Slice 3 — multi-value addresses)
PK: `id`. FK: `contact_id` → contacts (ON DELETE CASCADE).
Columns: `address1`, `address2`, `city`, `state`, `zip`, `country` (default 'US'),
`label` (enum: Home/Work/Mailing/Other), `is_primary`, `verified`, lifecycle/audit.
**No global active-uniqueness constraint** — households legitimately share addresses.
Only `uk_one_active_primary` (per-contact). Address VALUE changes are UPDATE-in-place
(not end-and-replace, unlike phones/emails) — the reconciler treats fields as mutable.

#### `contact_relation_types` (Slice 3 — relationships catalog)
PK: `type_code` (varchar, e.g. 'spouse', 'parent_child'). 17 seeded types covering
family, business, legal, and operational relationships. Each row defines
`directional` (boolean — does swapping a/b mean something different?) and
`reverse_label` (for directional types: the label viewed from b's side).

#### `contact_relations` (Slice 3 — relationships junction)
PK: `id`. Columns: `a_id`, `b_id` (both FK→contacts, ON DELETE RESTRICT),
`type_code` (FK→contact_relation_types), `active`, `status`, `start_date`,
`end_date`, `end_reason`, `notes`, audit.
Constraints: UNIQUE(a_id, b_id, type_code); CHECK chk_no_self (a_id ≠ b_id).
Surfaced via `tabRels` tab in `contact2.html` (inline div, NOT iframe — markup at
lines 446–488; script around line 1948+).

#### `appts`
PK: `appt_id` (int)
Key columns: `appt_client_id` (FK → contacts.contact_id),
`appt_case_id` (FK → cases.case_id), `appt_type`, `appt_length`,
`appt_status` (enum: 'Scheduled','Attended','No Show','Canceled','Rescheduled'),
`appt_date` (datetime — firm local), `appt_date_utc` (datetime — real UTC),
`appt_end` (GENERATED — never write directly),
`appt_gcal` (Google Calendar event ID),
`appt_platform`, `appt_with` (FK → users.user), `appt_note`,
`appt_workflow_execution_id` (FK → workflow_executions.id — reminder workflow)
IMPORTANT: Status values are Title Case with spaces — 'No Show' not 'no_show'

#### `users`
PK: `user` (tinyint — NOT user_id!)
Key columns: `username`, `user_name` (display), `user_fname`, `user_lname`,
`user_initials`, `user_auth`, `user_type` (boolean: true = real staff member, false = system/automation),
`does_appts` (boolean: true = appears in appt-with dropdowns; default 1 for back-compat),
`email`, `phone`, `allow_sms`, `task_remind_freq`,
`default_phone`, `default_email` (for sending form/communicate.html dropdown presets)
Sensitive: `password`, `password_hash`, `reset_token`, `reset_expires` — stripped from all
  resolver/query_db results and from `/api/firm-data`

**User 0 — Automation user.** Row with `user = 0`, `user_type = 0`, used as `task_from`
and `log_by` for actions performed by automation engines. Not a login account. Now
included in `/api/firm-data` users list — frontend filters it out where humans-only is
required (see Frontend section's role-based user-select filtering pattern).

**Role columns are additive.** Pattern for adding a new role: `ALTER TABLE users ADD
COLUMN does_X TINYINT(1) NOT NULL DEFAULT 1;` — `DEFAULT 1` keeps existing users
behaving as before; admins flip the bit per user via the profile form to opt out.

#### `tasks`
PK: `task_id` (int)
Key columns: `task_status`
  (enum: 'Pending','Due Today','Overdue','Completed','Deleted'),
`task_from` (user id — can be 0 for automation), `task_to` (user id — must be a real staff member, never 0),
`task_date`, `task_start`, `task_due`,
`task_link_type` (enum: 'contact','case','appt','bill'),
`task_link_id` (varchar 20),
`task_link` (legacy varchar — kept for backward compat),
`task_title`, `task_desc`, `task_notification`, `task_due_job_id`, `task_last_update`
IMPORTANT: 'Deleted' replaces old 'Canceled'. 'Incomplete' is a frontend filter only
  meaning IN ('Pending','Due Today','Overdue') — not a DB value.
New code uses `task_link_type` + `task_link_id`. `task_link` is legacy.

#### `log`
PK: `log_id` (int, MyISAM)
Key columns: `log_type`
  (enum: 'email','sms','call','other','form','status','note','court email','docs','appt','update','task'),
`log_date`, `log_link` (legacy varchar),
`log_link_type` (enum: 'contact','case','appt','bill','phone','email','task'),
`log_link_id` (varchar 255),
`log_by` (user id — can be 0 for automation), `log_data`, `log_from`, `log_to`, `log_subject`,
`log_message`, `log_direction` (enum: 'incoming','outgoing'),
`log_extra` (JSON — IT-facing details kept separate from user-facing log_data),
`log_form_id` (varchar 50), `log_form_sub` (varchar 50)
New code uses `log_link_type` + `log_link_id`. `log_link` is legacy.

For `log_link_type='phone'`/`'email'`, `log_link_id` carries the normalized phone/email value
itself (not a row id). Attribution to a contact happens at read time via date-windowed JOIN on
`contact_phones`/`contact_emails`. For court emails (`log_link_type IS NULL`, `log_type='email'`),
`log_link` carries the short-form case_number (e.g. `26-31193`, never `26-31193-jda`);
writer-side truncation lives in `logService._truncateDocketLink`.

#### `checklists`
PK: `id` (int)
Columns: `title` (varchar 255), `kind` (enum: 'checklist','note' NOT NULL DEFAULT 'checklist'),
`body` (TEXT NULL — a note's text; NULL/unused on checklists),
`status` (enum: 'incomplete','complete'), `created_by` (user id),
`link` (varchar 20 — entity ID),
`link_type` (enum: 'contact','case','bill','appt','task','user','event'),
`tag` (varchar 50), `created_date`, `updated_date`
ONE table, TWO row shapes — see §19:
- `kind='checklist'` → title + `checkitems`; `status` is **derived**, never written directly.
- `kind='note'` → title + `body`, zero checkitems; `status` is **manual** (a Done checkbox).
Indexes: `idx_link (link_type, link)`, `UNIQUE uq_link_kind_tag (link_type, link, kind, tag)`.
The unique key gained `kind` in S1 (was `uq_link_tag`), so a note and a checklist may share a
tag on the same entity. Every query that identifies a row by tag alone must therefore also
constrain `kind` — or join through `checkitems`, which excludes notes structurally.

#### `checkitems`
PK: `id` (int)
Columns: `checklist_id` (FK → checklists.id ON DELETE CASCADE),
`name` (varchar 255), `status` (enum: 'incomplete','complete'),
`position` (int), `tag` (varchar 50), `created_date`, `updated_date`

#### `sequence_enrollments`
Columns: `id`, `template_id`, `contact_id`, `trigger_data` (json),
`status` (enum: 'active','completed','cancelled'),
`current_step`, `total_steps`, `cancel_reason`,
`enrolled_at`, `completed_at`, `updated_at`

#### `scheduled_jobs`
Unified queue. Columns: `id`, `type`, `scheduled_time` (UTC), `status`,
`name`, `data` (json), `recurrence_rule`, `workflow_execution_id`,
`sequence_enrollment_id`, `attempts`, `max_attempts`, `backoff_seconds`,
`execution_count`, `max_executions`, `expires_at`, `idempotency_key`
Type enum: `one_time`, `recurring`, `workflow_resume`, `sequence_step`,
  `task_due_reminder`, `task_daily_digest`, `hook_retry`, `campaign_send`
Index on `(status, scheduled_time)`.

#### `campaigns`, `campaign_contacts`, `campaign_results`
**`campaigns`** — PK `campaign_id`. Columns: `type` (enum: 'sms','email'), `sender`,
`subject` (email), `body` (mediumtext), `attachment_url` (MMS/email attachment),
`status` (enum: 'draft','scheduled','sending','sent','failed','partial_fail','canceled'),
`scheduled_time`, `contact_count`, `created_by`, `created`, `updated_at`, `result_summary` (json).

**`campaign_contacts`** — Junction. UNIQUE on `(campaign_id, contact_id)`. Frozen at creation.

**`campaign_results`** — One row per contact per campaign. Status enum: 'sent','failed','skipped'.
**REQUIRED MIGRATION before deploy:** `ALTER TABLE campaign_results ADD UNIQUE KEY
  uq_campaign_contact (campaign_id, contact_id);` — required for the ON DUPLICATE KEY
  UPDATE in `recordResult()`. See `migrations/2026XX_campaign_results_uq.sql`.

#### `image_library`
Reusable images for campaigns. Columns: `id`, `url`, `filename`, `original_name`, `mime`,
`uploaded_by` (FK → users), `created_at`.

#### `phone_lines`
Active SMS numbers. Columns: `id`, `phone_number`, `display_name`, `provider`
(enum: 'ringcentral','quo','openphone'), `active`.

#### `email_credentials`
Columns: `id`, `email`, `from_name`, `provider` (enum includes 'smtp','pabbly'), auth fields.
SMTP and Pabbly/Gmail bridges coexist.

#### `credentials` (Connections — shared with YisraHook/YisraFlow)
Shared outbound auth store. Five types: `internal`/`bearer`/`api_key`/`basic`/`oauth2`.
Base columns: `id`, `name`, `type`, `config` (JSON), `allowed_urls` (JSON — URL scoping),
`created_at`, `updated_at`.
OAuth2-specific columns: `access_token` (encrypted), `refresh_token` (encrypted),
`access_token_expires_at`, `refresh_token_expires_at`, `last_refreshed_at`,
`oauth_status` (enum: pending_auth/connected/refresh_failed/revoked), `oauth_state`,
`oauth_pkce_verifier`, `oauth_last_error`, `oauth_last_error_at`,
`refresh_failure_count`, `verbose`. Encrypted fields use `ENCv1:` prefix wire format.
For oauth2 rows, `config.client_secret` is also encrypted within the JSON.

#### `hooks` (YisraHook)
Hook definitions. Columns: `id`, `slug` (unique), `name`, `description`, `auth_type`,
`auth_config` (JSON), `filter_mode`, `filter_config` (JSON), `transform_mode`,
`transform_config` (JSON), `active`, `version` (auto-increments on PUT),
`last_modified_by` (FK → users).

#### `hook_targets`
Delivery targets per hook. Columns: `id`, `hook_id` (FK CASCADE), `name`, `position`,
`method`, `url`, `headers` (JSON), `credential_id` (FK SET NULL), `body_mode`,
`body_template`, `conditions` (JSON), `transform_mode`, `transform_config` (JSON), `active`.

#### `hook_executions`
`id` (BIGINT), `hook_id`, `slug`, `raw_input` (JSON, capped at 512KB), `filter_passed`,
`transform_output` (JSON), `status` (enum: received/filtered/processing/delivered/partial/failed),
`error`, `created_at`.

#### `hook_delivery_logs`
`id` (BIGINT), `execution_id` (FK CASCADE), `target_id`, `request_url`, `request_method`,
`request_body` (JSON), `response_status`, `response_body`, `status` (enum: success/failed),
`error`, `attempts`, `created_at`.

#### `form_submissions`
YisraForms storage. Columns include `form_key`, `link_type`, `link_id`, `version`
(0 for drafts, 1+ for submissions), `schema_version`, `data` (JSON), `submitted_by`,
`submitted_at`, `updated_at`.

#### `app_settings`
Key/value. Common keys: `sms_default_from`, `sms_staff_from`, `email_default_from`,
`default_task_assignee`, `pabbly_internal_url`, `appt_reminder_workflow_id`
Do NOT expose in resolver or query_db.

#### Audit tables
`jwt_api_audit_log` — JWT auth events. Bearer tokens redacted at write time (pre-redaction
rows from before the fix need one-time cleanup).
`query_log` — legacy `/db` + `/unplacehold` audit. Password column intentionally empty.

---

## 3. AUTHENTICATION & PATTERNS


### Auth Middleware
`jwtOrApiKey` (`lib/auth.jwtOrApiKey.js`) checks in order:
1. `x-api-key` header against `process.env.INTERNAL_API_KEY`
2. `Authorization: Bearer <jwt>` header

`req.auth.userId` is the correct property (not `req.auth.sub`).
All routes except `GET /isWorkday`, `GET /api/public/docs/:caseId`, `POST /hooks/:slug`,
and `POST /api/public/get-upload-link` require this middleware.

**Rate limits:**
- `/login` — currently 100/15min for testing. **MUST tighten to 10/15min before prod launch.**
- `POST /hooks/:slug` — 120 req/min per (slug + IP)
- `GET /api/public/docs/:caseId` — 10/min

### JWT + Frontend
- `apiSend()` lives in the shell file (`a.html`, with the old `index.html` as legacy shadow).
  Iframes access it via `const P = window.parent; P.apiSend()`.
- Token stored in `localStorage.jwt`.
- `apiSend()` prompts re-login (`loginBlocking()`) when the JWT is missing/expired
  before the request, and retries once on a 401 after re-login.
- apiSend signature: `apiSend(endpoint, method = "GET", payload = null, extraHeaders = {})` — positional, no options object. Defined in the a.html shell, returns parsed JSON (204 → `null`). Iframes call it as `P.apiSend(...)` where `P = window.parent`. Older shells like index.html may use the same signature; new iframes should not implement a fallback path.
- **On non-2xx it throws a named `ApiError`** with `.message` (from `data.message || data.error`, else `HTTP <status>`), `.status`, `.statusText`, `.body` (parsed response object, or `{_raw}` for non-JSON), `.url`, `.method`. Callers reading only `.message` keep working; structured-4xx callers read `.body`/`.status` directly. (The earlier "discards 4xx body" wart is **resolved**.)

### Respond-First Pattern
All external actions (SMS, email, GCal, sequences) happen AFTER `res.json()`.
Never block the HTTP response waiting for external services.

### Service Layer
- `smsService.sendSms(db, from, to, message)` — **positional args, no object**
- `emailService.sendEmail(db, { from, to, subject, text?, html?, attachments?, attachment_urls? })`
- `ringcentralService.sendMms(db, from, to, text, country, buffer, filename, mimetype, url, rehost)`
- `pabblyService.send(db, service, data)` — fire-and-forget bridge
- `calendarService.isWorkday()`, `nextBusinessDay()`, `prevBusinessDay()`
- `resolverService.resolve({ db, text, refs, strict })` — returns `{status, text, unresolved, errors}`
- `taskService` — full CRUD + notifications + due reminders
- `apptService` — full appointment lifecycle
- `contactService`, `caseService`, `logService` — standard CRUD
- `campaignService` — campaign create/cancel/list/preview/executeSend
- `hookService` — hook CRUD + executeHook + executeRetry
- `formService` — form draft/submission storage

### Pabbly — Transient Bridge (retiring)
Pabbly was a stopgap from before the in-house auth/connections manager existed. Now that
Connections + native auth are built, Pabbly is being retired one workflow at a time as
native YisraFlow + Connections replacements ship. Currently still serves:
- Gmail (via `email_credentials` with `provider='pabbly'`)
- Google Calendar (`gcal_create`, `gcal_delete`)
- Dropbox (file operations — direct API integration planned)
- Court email ingest (planned absorption into the email_router overhaul)
Routes use `pabblyService.send(db, service, data)` — fire-and-forget, never blocks.
Status: low priority. Recreate each workflow natively when convenient.

---

## 4. REST API ROUTES

### Firm Data (unified lookup)
```
GET  /api/firm-data    → { currentUser, phoneLines, emailFrom, users }
```
Replaces the legacy triple: `/api/phone-lines` + `/api/email-from` + `/api/users/me` +
`/api/users` (filtered). The old routes still work — switch consumers at your own pace.
Sensitive user fields stripped (password, password_hash, reset_token, reset_expires).

**Users array shape** (post April-2026 update):
```js
{ user, user_name, user_fname, user_lname, user_initials, user_type, does_appts }
```
No `WHERE` filter — returns ALL users including user 0 (automation). Frontend
filters to humans-only (or appt-doers, etc.) via the `data-userlist-filter`
declarative pattern (see Section 12). Rationale: `task_from` and `log_by` filter
dropdowns legitimately need user 0 selectable, while `task_to` and `appt_with`
do not. One endpoint, multiple filtering use-cases.

### Contacts
```
GET    /api/contacts            ?q, type, tags, sort_by, sort_dir, limit, offset
GET    /api/contacts/:id        ?include=cases,appts,tasks,log,sequences,phones,emails,addresses
POST   /api/contacts            { fname, lname, ... }
PATCH  /api/contacts/:id        partial update — scalars AND/OR aggregate arrays;
                                ?force=true silently transfers cross-contact conflicts
GET    /api/contacts/:id/cases
GET    /api/contacts/:id/appts
GET    /api/contacts/:id/tasks
GET    /api/contacts/:id/log
GET    /api/contacts/:id/sequences
GET    /api/contacts/:id/phones    ?include_inactive=true (history modal)
GET    /api/contacts/:id/emails    ?include_inactive=true
GET    /api/contacts/:id/addresses ?include_inactive=true
```
Note: listContacts does NOT expose SSN. getContact (single) does — authenticated staff only.
**Aggregate PATCH semantics (Slice 3 Stage A):**
- Body may include `phones`/`emails`/`addresses` arrays alongside scalar `contact_*` fields.
- Each array is AUTHORITATIVE for its kind — omission of a current row means END that row
  (with `end_reason='ended'`). Same-contact `id` matched + phone/email value differs ⇒
  end-and-replace. Address value changes ⇒ UPDATE in place (no end-and-replace for addresses).
- `is_primary` rule: 0 incoming primaries = leave current primary unchanged.
  1 incoming primary = that row becomes primary (others demoted). 2+ = 400.
- Success response includes `contact: <getContact result>` (with phones/emails/addresses
  flattened) so the UI can rehydrate without a follow-up GET.
- Error shapes: 400 with `errors: {phones, emails, addresses, contact}` (per-kind, per-index);
  409 with flat `conflicts: [{kind, from_contact_id, from_contact_name, phone|email, ...}]`.
- Search expansion (Slice 3 Stage B.1): phone and email query branches now reach into
  `contact_phones` / `contact_emails` via EXISTS subqueries, **including ended rows**
  (orphan-log auto-link case). Legacy column LIKEs preserved.

### Contact Phones, Emails, Addresses (Slice 3 — dedicated CRUD)
```
POST   /api/contact-phones                  { contact_id, phone, label?, is_primary?, ... }
                                            ?force=true to transfer from another contact
PATCH  /api/contact-phones/:id              partial update — phone VALUE change is rejected
                                            (use aggregate PATCH on /api/contacts/:id)
DELETE /api/contact-phones/:id              hard delete; recomputes mirror

POST   /api/contact-emails                  parallel; PATCH allows label/flags/notes only
PATCH  /api/contact-emails/:id
DELETE /api/contact-emails/:id

POST   /api/contact-addresses               parallel; PATCH allows all address fields
PATCH  /api/contact-addresses/:id           (addresses ARE mutable in place)
DELETE /api/contact-addresses/:id
```
- Validation: per-row pure validators (`validatePhoneRow` / `validateEmailRow` /
  `validateAddressRow`) live in the respective services, exported, two-mode
  ('insert' / 'update'). Both the dedicated routes AND the aggregate reconcilers
  use them — single source of truth.
- Auto-promote: dedicated POST routes auto-promote a new row to is_primary=1 when
  the contact has ZERO rows (active + ended). Aggregate PATCH does NOT auto-promote —
  UI must enforce at-least-one-primary client-side.

### Contact Relations (Slice 3 — relationships)
```
GET    /api/contact-relations              ?contact_id, scope=active|all, type_code?
POST   /api/contact-relations              { a_id, b_id, type_code, ... }
PATCH  /api/contact-relations/:id          { active?, status?, end_date?, end_reason?, notes? }
DELETE /api/contact-relations/:id          hard delete
GET    /api/relation-types                 catalog (17 types)
```

### Cases
```
GET    /api/cases               ?q, type, stage, status, sort_by, sort_dir, limit, offset
GET    /api/cases/:id           ?include=contacts,appts,tasks,log  &log_limit=N
PATCH  /api/cases/:id           partial update
GET    /api/cases/:id/contacts
POST   /api/cases/:id/contacts  { contact_id, relate_type }
PATCH  /api/cases/:id/contacts/:contactId  { relate_type }
DELETE /api/cases/:id/contacts/:contactId
GET    /api/cases/:id/tasks
GET    /api/cases/:id/log
GET    /api/cases/:id/checklists
```
Note: `getCase` respects the `include` parameter (only returns requested sub-entities).
If `tasks` is requested without `contacts`, clients are fetched silently for task lookup
but not included in the response. `log_limit` defaults to 200.

### Appointments
```
GET    /api/appts               ?contact_id, case_id, status, type, exclude_type, from, to, limit, offset
GET    /api/appts/:id           (joins contacts, cases, users for full details)
PATCH  /api/appts/:id           { appt_note, appt_case_id, ... } (whitelisted fields)
POST   /api/appts               create
POST   /api/appts/:id/attended
POST   /api/appts/:id/no-show   { enroll: true|false }
POST   /api/appts/cancel        { appt, note, sms, email, confirm_message, create_task }
POST   /api/appts/reschedule    { appt, newDate, sms, email, msg } or { appt, rescheduleLater: true }
```
Date filters: `from`/`to` accept YYYY-MM-DD. `from` appends ` 00:00:00`, `to` uses `< DATE_ADD(?, INTERVAL 1 DAY)`.

### Tasks
```
GET    /api/tasks               ?q, status, assigned_to, assigned_by, link_type, link_id, limit, offset
GET    /api/tasks/:id
POST   /api/tasks               { to, title, desc, due, notify, link_type, link_id }
PATCH  /api/tasks/:id           { task_title, task_desc, task_to, task_due, task_notification, task_link_type, task_link_id }
PATCH  /api/tasks/:id/complete
PATCH  /api/tasks/:id/delete
PATCH  /api/tasks/:id/reopen
PATCH  /api/tasks/:id/transfer  { to }
```
Response shape: `{ data: [...], total }` (not `{ tasks, counter }`).
`status=Incomplete` → IN ('Pending','Due Today','Overdue'). Default when omitted.

### Log
```
GET    /api/log                 ?link_type, link_id, type, q, by, from_date, to_date,
                                  case_relate_filter, direction, limit, offset
GET    /api/log/:id
POST   /api/log                 { type, link_type, link_id, data, extra,
                                  from, to, subject, message, direction }
```
`type=Communication` maps to IN ('sms','email','call').
`type=Court Email` matches log_type='court email'.

Reader semantics (Slices 1–4, May 2026):
- `link_type='contact'` + `link_id`: contact-typed rows + NULL-typed legacy rows (matched
  on contact_id) + phone-typed rows whose phone the contact owned at `log_date` + email-typed
  rows (same date-window).
- `link_type='case'` + `link_id`: case-typed rows + NULL-typed legacy rows
  (case_id/case_number/case_number_full) + the contact-shaped expansion above applied to every
  related contact via `case_relate`. `case_relate_filter` controls which relate types are
  unioned in: `default` (Primary,Secondary,Other), `all`, or `none`.
- Helpers `logService._buildContactLogWhere(contactId)` and `_buildCaseLogWhere(db, caseId,
  {relateFilter})` are exported so `getContact`/`getCase` log blocks delegate to the same
  semantic. All log readers (global feed, contact view, case view, legacy `index.html`/
  `contact.html`/`case.html` post-Slice-3) produce identical results.

POST: `extra` is an optional JSON object stored in `log_extra`. Docket-style case_numbers
in `link_id` are truncated to short form at write time.

### Users / Lookups
```
GET    /api/users
GET    /api/users/:id
GET    /api/users/me           (legacy — prefer /api/firm-data)
GET    /api/judges
GET    /api/trustees
GET    /api/phone-lines        (legacy — prefer /api/firm-data)
GET    /api/email-from         (legacy — prefer /api/firm-data)
```

### Checklists
```
GET    /checklists              ?link_type, link [, kind, include=items, tag, status, facets]
GET    /checklists/:id          includes items
POST   /checklists              { title, kind, body, link, link_type, tag, items[] }
PATCH  /checklists/:id          { title, tag, body, status, link, link_type }
DELETE /checklists/:id
POST   /checklists/:id/items    { name, status, position, tag }
PATCH  /checkitems/:id          { name, status, position, tag }
DELETE /checkitems/:id
POST   /checklists/upsert-items { case_id, items: string[] }  — Docs Needed upsert
```
Note: item status changes auto-recompute parent checklist status via `computeAndSaveStatus()`.
Kind rules (400 on violation — see §19):
- `kind` omitted defaults to `'checklist'`; `?kind=` omitted on GET returns BOTH kinds.
- POST rejects `items` on a note and `body` on a checklist by **key presence, not contents** —
  `items: []` on a note is a 400. Pass `null` to mean "not supplied".
- PATCH rejects `kind` outright. Converting a row would strand its body or its items.
- PATCH accepts `status` only on a note; on a checklist it 400s and points at the derivation.
- `POST /checklists/:id/items` 400s when the parent is a note.

### Campaigns
```
GET    /api/campaigns                  ?status, page, limit
POST   /api/campaigns                  { type, sender, subject, body, contactIds, scheduledTime, attachmentUrl }
GET    /api/campaigns/:id              includes results summary
GET    /api/campaigns/:id/results      per-contact results
PATCH  /api/campaigns/:id              { status: "canceled" }  (only canceled supported)
GET    /api/campaigns/contacts         ?channel, tags, case_type, case_stage, case_open_after, case_open_before
POST   /api/campaigns/preview          { body, subject, contactId }
```
`contactIds` are frozen into `campaign_contacts` at creation — list does not re-evaluate.
`scheduledTime` is firm-local; converted to UTC internally. Omit or null = immediate.

### Image Library
```
POST   /api/upload                     multipart OR base64 JSON { image, filename, contentType, addToLibrary }
GET    /api/image-library
POST   /api/image-library              { url, original_name, mime }
DELETE /api/image-library/:id
```

### Forms
```
GET    /api/forms/latest               ?form_key, link_type, link_id  → { submitted?, draft? }
POST   /api/forms/submit               { form_key, link_type, link_id, schema_version, data }
POST   /api/forms/draft                { form_key, link_type, link_id, schema_version, data }
DELETE /api/forms/draft/:id
GET    /api/forms/:form_key/history    ?link_type, link_id
```

### Hooks (YisraHook)
```
POST   /hooks/:slug                    — PUBLIC receiver, per-hook auth, 120 req/min rate limit
GET    /api/hooks                      — list all hooks
GET    /api/hooks/:id                  — get hook with targets
POST   /api/hooks                      — create hook
PUT    /api/hooks/:id                  — update hook (auto-increments version)
DELETE /api/hooks/:id                  — delete hook (cascades targets)
POST   /api/hooks/:id/targets          — create target
PUT    /api/hooks/targets/:id          — update target
DELETE /api/hooks/targets/:id          — delete target
POST   /api/hooks/:id/test             — dry run (no delivery)
GET    /api/hooks/:id/executions       — execution log (paginated)
GET    /api/hooks/executions/:id       — single execution with delivery logs
GET    /api/hooks/meta                 — available transforms + operators
GET    /api/credentials                — list credentials (config masked, available to any auth user — for dropdowns)
POST   /api/credentials                — create credential (admin)
PUT    /api/credentials/:id            — update credential (admin, deep-merge config)
DELETE /api/credentials/:id            — delete credential (admin)
```

### Connections (admin credential management)
```
GET    /api/credentials/:id            — admin: full row (secrets stripped)
GET    /api/credentials/:id/reveal     — admin: decrypted secrets
POST   /api/credentials/:id/authorize  — admin: returns OAuth auth_url
GET    /auth/oauth/callback            — PUBLIC: OAuth provider redirect target (security via state)
POST   /api/credentials/:id/refresh    — admin: manual refresh
POST   /api/credentials/:id/revoke     — admin: revoke + clear tokens
GET    /api/email-credentials          — list email senders (smtp_pass scrubbed, any auth user)
GET    /api/email-credentials/:id      — admin: full row including smtp_pass
POST   /api/email-credentials          — admin: create
PUT    /api/email-credentials/:id      — admin: update
DELETE /api/email-credentials/:id      — admin: delete
POST   /api/email-credentials/:id/test — admin: send test email via emailService.sendEmail
```

### Manual
```
GET    /manual                          — list sections
GET    /manual/:section                 — list files in section
GET    /manual/:section/:file           — raw markdown (text/plain)
```

### Public (no auth)
```
GET    /api/public/docs/:caseId   rate-limited 10/min — returns { name, items[] } for docs page
POST   /api/public/get-upload-link    no auth — issues temporary Dropbox upload link for docReq.html
GET    /isWorkday?date=           no auth
GET    /r/:slug                  rate-limited 60/min — 302 redirect to a stored target URL (see Redirects)
```

### Redirects (short-link redirector)
Slug → target URL, with a management UI. Built for sending clients long signed
links (e.g. Clio payment links) as a short, branded `app.4lsg.com/r/<slug>`.

- `GET /r/:slug` — **public**, 302 to `target_url`. Slug match is case-insensitive
  (column collation `utf8mb4_general_ci`), so `/r/mySlug` and `/r/myslug` resolve the
  same row; original case is preserved for display. `hit_count` bumped fire-and-forget
  after responding (respond-first). Not-found / inactive / past-`expires_at` → branded
  404 "link unavailable" HTML page built fresh from `FIRM_LOGO`/`FIRM_PHONE`/`FIRM_EMAIL`
  env (with literal fallbacks).
- `GET/POST/PUT/DELETE /api/redirects[/:id]` — **JWT-gated** CRUD (not SU). Create/update
  enforce slug `^[a-zA-Z0-9_-]{1,64}$` and `https?://`-only targets (blocks
  `javascript:`/`data:`). `UNIQUE` slug → 409 on case-variant collision.
- Table `redirects` (slug, target_url, label, active, hit_count, expires_at, created_by).
  `expires_at` present but unused for now (Clio links don't expire) — insurance column.
- Files: `routes/api.redirects.js`, `public/redirects.html` (dark admin-tool style,
  copy-link button uses `window.location.origin`, randomize-slug button).

### Internal
```
POST   /internal/sms/send        { from, to, message }
POST   /internal/mms/send        { from, to, text, attachment_url }  — RingCentral only (singular attachment_url)
POST   /internal/email/send      { from, to, subject, text, html?, attachments?, attachment_urls? }
POST   /internal/gcal/create     { appt_id, appt_date, ... }
POST   /internal/gcal/delete     { appt_gcal, appt_id }
POST   /internal/sequence/enroll { contact_id, sequence_type, ... }  — legacy Pabbly bridge (deprecated)
```

### Communication (used by sending form / communicate.html)
```
POST   /api/compose-docs-message       server-side assembly of doc request message from checkbox selections
```

### Misc
```
POST   /resolve                  { text, refs, strict? }
GET    /resolve/tables
POST   /nextBusinessDay
POST   /prevBusinessDay
GET    /workflows/functions      returns { workflow: [...22], sequence: [...15 filtered] }
```

---

## 5. INTERNAL FUNCTIONS REFERENCE

22 functions total. All: `async (params, db) => { success, output? }`
Available via `GET /workflows/functions` (returns workflow + sequence-filtered lists).

### Control Flow (workflows only)
**`set_next`** — `{ value: 5 }` — jump to step or terminate (null = end, "cancel", "fail")
**`evaluate_condition`** — `{ variable, operator, value, then, else }` or multi-condition form
Operators: `==` `!=` `>` `<` `>=` `<=` `contains` `not_contains` `is_empty` `is_not_empty`

### Variable Manipulation
**`noop`** — does nothing, use with set_vars to set variables
**`set_var`** — `{ name, value }`
**`format_string`** — `{ template, output_var }`

### Timing (workflows only)
**`wait_for`** — `{ duration: "2h", nextStep: 5 }`
**`schedule_resume`** — `{ resumeAt: "2026-04-01T09:00:00Z", nextStep: 4 }`
  Note: skips silently when `resumeAt` is null (uses `skipToStep` param).
**`wait_until_time`** — `{ time: "09:00", timezone: "America/Detroit", nextStep: 6 }`
Duration formats: "30s", "5m", "2h", "1d" or ISO datetime or ms number

### Communication
**`send_sms`** — `{ from, to, message }`
from: must exist in phone_lines table. Staff default: `sms_staff_from` setting.
Client default: `sms_default_from` setting.

**`send_email`** — `{ from, to, subject, text?, html? }`
from: must match email_credentials table.

### Tasks
**`create_task`** — `{ title, description?, contact_id, assigned_to, link_type?, link_id?, due_date? }`
Returns: `{ task_id }` as output.

### Task Digest (dev/admin helper)
**`run_task_digest`** — `{ user?, force? }`
On-demand version of the `task_daily_digest` job. Identical behavior when called with no
params (same Shabbos gate, same remind-freq filter). `user` limits to one recipient,
`force` skips Shabbos/Yom Tov gate and day-of-week filter.

### Sequences
**`cancel_sequences`** — `{ contact_id, template_type?, reason }`
**`enroll_sequence`** — `{ contact_id, template_type, trigger_data?, appt_type?, appt_with? }`

### Log
**`create_log`** — `{ type, link_type, link_id, data?, from?, to?, subject?, direction? }`

### Contacts & Appointments
**`lookup_contact`** — `{ contact_id }` → returns full row as output
**`update_contact`** — `{ contact_id, fields: {} }` → updates allowed columns
**`create_appointment`** — `{ contact_id, appt_date, appt_type, appt_length, appt_platform, case_id?, appt_with?, note?, confirm_sms?, confirm_email?, confirm_message?, acting_user_id? }`
  Delegates to `apptService.createAppt()` — full side effects (log, 341 update, sequence cancel, GCal, reminder workflow). Returns: `{ appt_id, appt_date_utc, workflow_execution_id }`.
**`lookup_appointment`** — `{ appointment_id }` → returns full appts row as output
**`update_appointment`** — `{ appointment_id, fields: {} }` → updates allowed columns
Blocked columns: appt_id, appt_end (generated), appt_create_date, appt_workflow_execution_id

### Appointments Query
**`get_appointments`** — structured appointment query with formatting
```json
{
  "function_name": "get_appointments",
  "params": { "status": "Scheduled", "date": "today", "format": "html_rows" },
  "set_vars": {
    "apptRows":       "{{this.output.html}}",
    "apptCount":      "{{this.output.count}}",
    "todayFormatted": "{{this.output.date_formatted}}"
  }
}
```
date options: "today" | "tomorrow" | "YYYY-MM-DD"
format options: "raw" | "html_rows" | "count"

### General DB Query
**`query_db`** — safe parameterized SELECT from JSON descriptor
```json
{
  "function_name": "query_db",
  "params": {
    "select": ["cases.case_id", "j.judge_name"],
    "from": "cases",
    "join": [
      { "type": "left", "table": "judges", "alias": "j",
        "on": { "left": "cases.case_judge", "right": "j.judge_name" } }
    ],
    "where": [{ "column": "cases.case_id", "op": "=", "value": "{{caseId}}" }],
    "format": "first",
    "output_var": "caseDetails"
  }
}
```
Allowed WHERE ops: `=` `!=` `<>` `>` `<` `>=` `<=` `LIKE` `NOT LIKE` `IN` `NOT IN` `IS NULL` `IS NOT NULL`
Formats: "raw" | "first" | "count" | "html_rows"
Allowed tables: contacts, cases, appts, tasks, log, users, phone_lines, scheduled_jobs,
  workflows, workflow_executions, workflow_execution_steps,
  sequence_templates, sequence_steps, sequence_enrollments, sequence_step_log,
  case_relate, case_judge, case_trustee, judges, trustees,
  checkitems, checklists, job_results
Blocked: email_credentials, app_settings, jwt_api_audit_log, query_log, credentials, hooks*
Stripped from results: users.password, users.password_hash, contacts.contact_ssn (list only)

---

## 6. WORKFLOW ENGINE

### Starting a Workflow
```js
await apiSend('/workflows/5/start', 'POST', { contactId: 123 })
// Returns: { executionId, status: 'processing' }
```

### Execution Statuses
`active` → `processing` → `delayed` → `completed` | `completed_with_errors` | `failed` | `cancelled`

### Variable System
- `{{variableName}}` — workflow variable from init_data or set_vars
- `{{this.output.field}}` — output from the just-executed step
- `{{this.[0]}}` — array index access
- `{{env.now}}`, `{{env.executionId}}`, `{{env.stepNumber}}`

### Step Config Shape
```json
{
  "type": "internal_function",
  "config": {
    "function_name": "send_sms",
    "params": { "from": "2485592400", "to": "{{contactPhone}}", "message": "Hi {{name}}" },
    "set_vars": { "smsSentAt": "{{env.now}}" }
  },
  "error_policy": { "strategy": "retry_then_ignore", "max_retries": 2, "backoff_seconds": 30 }
}
```

### Control Flow Rules
- `evaluate_condition` and `set_next` are the only functions whose next_step is honored (isControlStep)
- `schedule_resume` is also an isControlStep — omitting this causes skipped blocks to fire immediately
- `delayed_until` from `wait_for`/`schedule_resume` schedules a `workflow_resume` job
- Max 20 steps per invocation, then self-schedules continuation
- `null` return from evaluate_condition else branch triggers `markExecutionCompleted`

### Error Policies
`ignore` (default) | `abort` | `retry_then_ignore` | `retry_then_abort`

---

## 7. SEQUENCE ENGINE

### Enrollment
```js
await apiSend('/sequences/enroll', 'POST', {
  contact_id:    456,
  template_type: 'no_show',
  trigger_data:  { appt_id: 123, appt_time: '2026-03-20T14:00:00Z', enrolled_by: 'appt_handler' }
})
```

### Cascading Template Match
Cascade structure is per-type: `sequence_template_types.priority_fields` declares an
ordered list of `trigger_data` keys, most-specific first. Templates carry a
`filters` JSON column whose keys must be a subset of `priority_fields`
(`validateTemplateFilters` enforces this on POST/PUT). Cascade fields are
flattened into `trigger_data` by the caller — there's no separate `filters`
arg to `enrollContact` anymore.
Scoring: position `i` in `priority_fields` contributes `2^(N-1-i)` when the
template's filter equals `triggerData[field]`. Wildcard filter (absent or
null in `filters`) scores 0 and never disqualifies; specific filter that
mismatches OR demands a field the trigger doesn't have disqualifies. Sort
qualified templates by `score DESC, id ASC`. The `no_show` type ships with
`priority_fields: ["appt_type", "appt_with"]` — equivalent to the prior
hardcoded cascade.
CRUD for type config: `/api/sequence-types` (GET list/detail any auth user;
POST/PUT/DELETE superuser, audited under `tool='sequence_types'`). Edited
in-page via the **Manage Types** button on the Sequences tab — no separate
sub-page. Full worked example in cookbook §3.5.

### Cancellation
```js
await apiSend('/sequences/cancel', 'POST', {
  contact_id:    456,
  template_type: 'no_show',  // omit to cancel ALL types
  reason:        'new_appointment_booked'
})
```
`cancelSequences` with `template_type='no_show'` also clears `appt_status='No Show'`
on the contact's appointments (temporary cutover fix — remove ~1 week after full deploy).

### The Check Chain (every step)
1. Enrollment still active? No → skip
2. Template condition passes? No → CANCEL ENROLLMENT
3. Fire guard passes? No → skip step, schedule next
4. Step condition passes? No → skip step, schedule next
5. Resolve placeholders → execute action → log → schedule next

### Timing Types
```json
{ "type": "immediate" }
{ "type": "delay", "value": 5, "unit": "minutes" }
{ "type": "next_business_day", "timeOfDay": "13:00", "randomizeMinutes": 30 }
{ "type": "business_days", "value": 2, "timeOfDay": "10:00" }
{ "type": "before_appt_fixed", "hoursBack": 2 }
{ "type": "before_appt", "hoursBack": 24, "timeOfDay": "10:00", "minHoursBefore": 4 }
```

### Condition Shape
```json
{
  "query": "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
  "params": { "appt_id": "trigger_data.appt_id" },
  "assert": { "appt_status": { "in": ["No Show", "Canceled"] } },
  "assert_mode": "all"
}
```

### Variable Resolution in Sequences
Refs auto-built from: `enrollment.contact_id` + `trigger_data.appt_id`, `case_id`, `task_id`
```
"message": "Hi {{contacts.contact_fname}}, your appt on {{appts.appt_date|date:dddd MMMM Do}}"
```

---

## 8. UNIVERSAL RESOLVER

```js
const { resolve } = require('../services/resolverService');
const result = await resolve({
  db,
  text: "Hi {{contacts.contact_fname}}, case {{cases.case_number_full}}",
  refs: { contacts: { contact_id: 1001 }, cases: { case_id: 'ABC123' } },
  strict: false
});
// result: { status, text, unresolved, errors }
```
status: "success" | "partial_success" | "failed"

### Strict mode — important nuance
- **`strict: true` does NOT throw on unresolved placeholders.** It returns
  `{ status: 'failed', unresolved: [...] }`. Callers must check `result.status`.
- **DB infrastructure errors DO throw.** The resolver now rethrows caught DB errors
  so the job system can retry (removed the old catch-and-return-'failed' pattern).
- Callers that need retry-on-DB-blip behavior (e.g. `campaignService.executeSend`) get
  it for free by letting throws propagate. Callers that wrap the whole thing in
  try/catch need to distinguish: `status: 'failed'` = permanent semantic failure,
  `throw` = transient infra failure.

HTTP route `POST /resolve` always returns HTTP 200. Check `result.status` and `result.errorType`.

### Placeholder Syntax
```
{{contacts.contact_fname}}
{{appts.appt_date|date:dddd MMMM Do, YYYY}}
{{contacts.contact_phone|phone}}
{{contacts.contact_name|upper}}
{{contacts.contact_email|default:{{contacts.contact_email2}}|default:no email}}
```

---

## 9. CALENDAR SERVICE

Jewish business calendar — Shabbos and Yom Tov aware. Hebcal API for holiday data.

### Restricted Days
Configuration constants (`services/calendarService.js`):
- `START_HOUR = 18` — Shabbos/Yom Tov begins at 6 PM the evening before
- `END_HOUR = 22` — ends at 10 PM on the day itself
- **Shabbos window:** Friday 6pm → Saturday 10pm (NOT Saturday 6pm as older docs may suggest)
- **Yom Tov:** Rosh Hashana, Yom Kippur, Sukkot I+II, Shmini Atzeret, Simchat Torah,
  Pesach I+II+VII+VIII, Shavuot I+II
- **Sunday:** treated as non-business day in `nextBusinessDay()`

Hebcal API fails open (returns `[]` on network failure) — never blocks scheduling.

### Routes
```
GET  /isWorkday?date=YYYY-MM-DDTHH:mm:ss   no auth
POST /nextBusinessDay  { fromDate, timeOfDay, randomizeMinutes, maxDaysAhead }
POST /prevBusinessDay  { anchorDate, attempts: [...], defaults: {} }
```
`timeOfDay` is interpreted in firm timezone (America/Detroit), returned as UTC.

---

## 10. SCHEDULED JOBS

### Create (one_time or recurring user jobs)
```js
await apiSend('/scheduled-jobs', 'POST', {
  type: 'recurring', job_type: 'webhook',
  name: 'Daily Report',
  scheduled_time: '2026-03-18T04:00:00Z',
  recurrence_rule: '0 4 * * 0,1,2,3,4,5',
  max_executions: 10,
  url: 'https://app.4lsg.com/workflows/5/start',
  method: 'POST',
  body: { source: 'scheduler' },
  headers: { 'x-api-key': 'YOUR_INTERNAL_API_KEY' }
})
```

### Execution Limits (recurring only)
`max_executions` — stop after N successful runs
`expires_at` — stop scheduling after this datetime

### All Job Types (full list)

**User-createable (scheduling type):**
- `one_time` — fires once, then `completed` or `failed`
- `recurring` — fires on cron schedule, reschedules itself

**User-createable (execution flavor, inside `data.type`):**
- `webhook` — HTTP request to any URL
- `internal_function` — runs a built-in function
- `custom_code` — runs a JS snippet in a sandbox (`vm` module, 5s timeout)

**Engine-internal (don't create manually):**
- `workflow_resume` — created by `workflow_engine.js` when a step defers
- `sequence_step` — created by `sequenceEngine.js` to fire next step

**App-managed (created by services, don't create manually):**
- `task_due_reminder` — one_time, fires at 8 AM firm time on due date.
  Created by `taskService.scheduleDueReminder()`. Job data: `{ type: 'task_due_reminder', task_id }`.
- `task_daily_digest` — recurring `0 13 * * *` (8 AM EST = 13:00 UTC).
  Seeded as a recurring job. Refreshes task statuses (Pending→Overdue/Due Today) always;
  sends digests only on workdays (Shabbos/Yom Tov gate).
- `hook_retry` — one_time, created by `hookService.queueRetryJob()` on failed delivery.
  Handled by `process_jobs.js` with dedicated if-block (not via `executeJob`).
  Job data: `{ execution_id, target_id }`. 3 attempts, 120s exponential backoff.
- `campaign_send` — one_time, one job per contact per campaign.
  Created in bulk by `campaignService.createCampaign()`. Handled inside `executeJob()`
  with attempt-aware retry (transient vs permanent classification).
  Job data: `{ type: 'campaign_send', campaign_id, contact_id }`.
  `backoff_seconds` effective minimum is bounded below by the Cloud Scheduler polling
  cadence (~5 min currently).

### Internal Jobs List Filter
The jobs list API hides `workflow_resume` and `sequence_step` by default —
pass `?internal=true` to include them.

---

## 11. APPOINTMENT LIFECYCLE

### createAppt side effects (in order)
1. INSERT appts (with appt_date_utc computed)
2. Log entry
3. If 341 Meeting: UPDATE cases.case_341_current
4. Cancel active no_show sequences for contact
5. Confirmation SMS/email if requested
6. GCal create via Pabbly (fire-and-forget)
7. Start reminder workflow → store execution_id on appt row

### markNoShow side effects
1. UPDATE appt_status = 'No Show'
2. Cancel reminder workflow (non-blocking)
3. Enroll in no_show sequence IF contact has no active no_show enrollment

### markAttended side effects
1. UPDATE appt_status = 'Attended'
2. Cancel reminder workflow
3. Cancel active no_show sequences for contact

### cancelAppt side effects
1. UPDATE appt_status = 'Canceled'
2. Cancel reminder workflow
3. Cancel no_show sequences for contact (also clears No Show appt status — temp)
4. Optional: create follow-up task
5. Log entry
6. Non-blocking: SMS/email confirmation, GCal delete

### rescheduleAppt side effects
1. Mark old as 'Rescheduled'
2. Cancel old reminder workflow
3. GCal delete for old appt (non-blocking)
4. Create new appointment (triggers full createAppt chain)
5. Log on old appt

### rescheduleLater side effects
1. Mark as 'Rescheduled'
2. Cancel reminder workflow
3. GCal delete (non-blocking)
4. Optional follow-up task
5. Log entry

---

## 12. FRONTEND ARCHITECTURE

### Shell file — a.html (new) / index.html (legacy)
`a.html` is the current shell file. It contains: JWT auth, `apiSend()`, `loadFirmData()`,
`addFile()`, `apptUpdate()`, `newTask()`, `updateTask()`, tab navigation, and all data
tab script blocks.

`apiSend()` MUST stay in the shell — iframes access it via `window.parent.apiSend()`.
Never move it to `scripts.js`.

`index.html` is the legacy shell and still exists. It uses the old pattern:
three separate calls (`/api/phone-lines` + `/api/email-from` + `/api/users/me`) instead
of the unified `/api/firm-data`. Migration to `a.html` is in progress for Phase 6.

### Firm-wide data — window.firmData
Loaded once after auth from `GET /api/firm-data`. Structure:
```js
window.firmData = {
  phoneLines:  [],   // { id, phone_number, display_name, provider }
  emailFrom:   [],   // { id, email, from_name, provider }
  currentUser: null, // full user row minus sensitive fields
  users:       []    // ALL users including user 0 (Automation), with role booleans:
                     // { user, user_name, user_fname, user_lname, user_initials,
                     //   user_type, does_appts }
};
```

`firmData.users` deliberately includes the automation user (`user = 0`,
`user_type = 0`). Filter dropdowns for `task_from` and `log_by` legitimately need
it; `task_to`, `appt_with`, and the assignee picker in `newTask` do not. Filtering
is the consumer's responsibility — see the role-based filter pattern below.

The boolean columns (`user_type`, `does_appts`) come back from MySQL as `1`/`0`
numbers, which work directly in JS truthy/falsy checks (`u.user_type`,
`u.does_appts`). No `CAST` needed.

Parent pages (`case2.html`, `contact2.html`) relay it to child iframes:
```js
window.apiSend  = P.apiSend;
window.firmData = P.firmData;
```

Child iframes (e.g. `sendingform.html`, `communicate.html`) read it directly:
```js
const firmData = P.firmData || {};
const phoneLines = firmData.phoneLines || [];
```

### Role-based user-select filtering (declarative)

The previous `P.populateUserSelect()` helper has been **removed**. It was unused
outside the parent shell and conflicted with iframe filter selects that wanted to
preserve a static `<option value="">All</option>`.

Current pattern: each `<select class="userslist">` opts into role-based filtering
via a `data-userlist-filter="<column>"` HTML attribute, naming a boolean column on
`firmData.users`. The populate loop reads the attribute and filters the user list
accordingly. Static options in the markup (e.g. "All") are preserved; users are
appended after.

```html
<!-- Filter select: includes All + appt-doers only (excludes user 0 + non-appt staff) -->
<select id="tabApptsWith" class="userslist" data-userlist-filter="does_appts">
  <option value="">All</option>
</select>

<!-- Filter select: includes All + real staff (excludes user 0) -->
<select id="tabTasksTo" class="userslist" data-userlist-filter="user_type">
  <option value="">All</option>
</select>

<!-- Filter select: no filter — includes All + ALL users (user 0 too, for "by automation") -->
<select id="tabTasksBy" class="userslist">
  <option value="">All</option>
</select>
```

Populate loop (lives in `loadUserContext()` in a.html, and after the
`window.firmData = P.firmData` relay in case2.html / contact2.html):

```js
document.querySelectorAll('select.userslist').forEach(sel => {
  const filterField = sel.dataset.userlistFilter;
  const list = filterField
    ? (window.firmData?.users || []).filter(u => u[filterField])
    : (window.firmData?.users || []);
  list.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.user;
    opt.textContent = u.user_name;
    sel.appendChild(opt);
  });
});
```

For `Swal.fire` popups (e.g. the assignee dropdown in `newTask`), there's no
`userslist` element to scan — build the option string inline with the same
filter logic. Use a disabled+hidden placeholder so it shows as a hint and can't
be re-selected after picking:

```js
const userOpts =
  '<option value="" disabled selected hidden>— select assignee —</option>' +
  (window.firmData?.users || [])
    .filter(u => u.user_type)
    .map(u => `<option value="${u.user}">${u.user_name}</option>`)
    .join('');
```

Adding a new role: `ALTER TABLE users ADD COLUMN does_X TINYINT(1) NOT NULL
DEFAULT 1;` → add it to the `routes/api.firmData.js` SELECT → reference it
in `data-userlist-filter="does_X"` on any select that should respect the role.
No JS infrastructure changes.

### Parent-as-Data-Source (entityData pattern)

Parent pages (`case2.html`, `contact2.html`) are the single source of truth for entity data.
They expose `window.entityData` which child form iframes read from instead of making
their own API calls.

**case2.html:**
```js
window.entityData = { case: null, clients: [], appts: [], tasks: [], log: [] }
```

**contact2.html:**
```js
window.entityData = { contact: null, cases: [], appts: [], tasks: [], log: [], sequences: [] }
```

**Structured loading procedure (both pages follow this pattern):**
```
loadEntityData()       → single API call, populates window.entityData
updateHeader()         → reads from entityData, updates DOM header/overview
loadIframes()          → sets iframe srcs (called once on initial load)
putAppts() / putCases() etc. → render functions, all read from entityData
```

**yc-forms.js integration:** On init (step 7), forms check `window.parent.entityData`
before calling the API. The form's existing `endpoints.load.path` (e.g. `'case'`,
`'contact'`) doubles as the lookup key in `parent.entityData`. No new config needed.

### iframe pattern
Contact and case files load as iframes via `addFile()`. Inside iframes:
```js
const P = window.parent;
// P.apiSend(), P.addFile(), P.Toast.fire(), P.apptUpdate(), P.updateTask()
// P.newTask(task, linkType, linkId, onSuccess)
// P.firmData, P.entityData (on case2/contact2 specifically)
```

### waitForParent boot pattern
Iframes that load before their parent's `apiSend` is defined must wait:
```js
(function waitForParent() {
  if (P.apiSend) return init();
  setTimeout(waitForParent, 100);
})();
```

**When to use it:** Any iframe sourced during parent-initialization where the parent's
`apiSend` may not yet be relayed.

**When to skip it:** Admin iframes that are lazy-loaded on-demand (e.g.
`automationManager.html`, `featureRequests.html`, `manuals.html`) — by the time the
user clicks to open them, the parent has already finished booting.

### Save → Refresh → Push flow

1. Form saves → **`yc-forms.js` (and only `yc-forms.js`)** sends
   `postMessage({ type: 'form-saved', form: formKey })`.
   **Rule:** Individual forms must NOT send their own `form-saved` postMessage.
   Doing so causes double `refreshEntityData` on the parent.
2. Parent listens → one centralized `message` listener calls `refreshEntityData(formKey)`
3. `refreshEntityData` does:
   - Re-fetch from API → update `window.entityData`
   - `updateHeader()` → refresh parent's own UI
   - Re-render tables (putAppts, putClients, etc.)
   - Scan ALL iframes for `ycForm` instances (auto-discovery, no hardcoded list)
     — wrap in try/catch: cross-origin iframes (e.g. Dropbox embeds) throw `SecurityError`,
     handle silently.
   - For each non-dirty form: push fresh `_liveData` + `_loadResult`, call
     `populate()` then re-run `onLoad()` for computed fields (debtor name, etc.)
   - Dirty forms are left untouched — user's unsaved edits preserved

**Key:** Parent always re-fetches from API on save (never trusts sent-back data from form).
The form's PATCH only has changed fields; the API response has computed fields,
timestamps, and side-effect results.

`window.ycForm = this` is set in the YCForm constructor. Scope is per-iframe (no
cross-iframe collision risk — each iframe has its own `window`). `_original` is
re-snapshotted after `onLoad` completes so onLoad-computed fields don't appear dirty
on load.

### Callback pattern
`apptUpdate(apptId, action, date, onSuccess)` — pass `refreshAppts` from the iframe
as the 4th arg so the iframe reloads its own appts when an action completes.
Same pattern for `updateTask(taskId, action, onSuccess)`.

### apiSend()
```js
async function apiSend(endpoint, method = "GET", payload = null, extraHeaders = {})
// Prompts loginBlocking() first if JWT missing/expired
// GET/HEAD → query params; POST/PATCH/etc → JSON body (string payloads passed through)
// 401 → loginBlocking() then retry once
// 204 → null; otherwise returns parsed JSON (falls back to raw text if unparseable)
// non-2xx → throws ApiError (see below)
```
**Error handling (extension landed):** on non-2xx `apiSend` throws a named
`ApiError` carrying the full response context:
- `.message` — `data.message || data.error`, else `HTTP <status> <statusText>`
- `.status`, `.statusText`
- `.body` — the parsed response object (or `{ _raw: <text> }` for non-JSON)
- `.url`, `.method`

Callers that read only `.message` are unaffected. Structured-4xx callers
(409 conflicts, 400 validation) read `.body` / `.status` directly off the
thrown error — no bypass needed anymore.

### Aggregate form save pattern (Slice 3 Stage B.2)
For forms whose underlying entity has aggregate (nested-array) save semantics —
currently only `contact-form.html` — the stock `yc-forms.js` save() flow needs
structured 4xx handling. With the `ApiError` extension landed, this no longer
requires bypassing `apiSend`; the historical workaround (below) can be retired.
Workaround as originally implemented:

1. `form.save = async function() { … }` — full override at the bottom of the form's
   bootstrap script. Mirrors yc-forms.js's save() body (validate → diff → PATCH →
   form_submissions → workflow → log → status → postMessage) with two changes:
   - PATCH goes through a **direct `fetch()`** helper (`doRawPatch`) that exposes
     `err.status` and `err.body` on 4xx
   - 409 → transfer modal → retry with `?force=true` (same payload)
   - 400 → validation modal listing per-kind / per-row errors

2. JWT for the direct fetch comes from a `findAuthWindow()` walk up the
   `window.parent` chain looking for `AUTH_STATE.jwt` (the shell's globals).
   Pattern lifted from `public/connections.html`.

3. **Risk:** the override duplicates ~50 LoC of yc-forms.js's save body. If
   yc-forms.js's save() materially changes (new audit step, etc.), the override
   must be re-ported. Marker comment at the top of the override block.

4. **Simplification now available:** drop `doRawPatch` + `findAuthWindow`, route
   the PATCH back through stock `apiSend`, and read `err.body` / `err.status`
   from the thrown `ApiError`, keeping the 409/400 branches. (Refactor not yet
   applied — `contact-form.html` still uses the bypass.)

### Repeater pattern in `yc-forms.js`
Built-in but minimal. The form declares:
```js
repeaters: {
  phones: {
    container: '#phonesRepeater',           // <div class="yc-repeater">
    template:  '#phoneRowTemplate',         // <template> containing one .yc-repeater-item
    fields:    { id, phone, label, is_primary, … }   // per-row schema
  },
  …
}
```
At init, yc-forms.js scans the form for `.yc-repeater-add[data-repeater="<key>"]`
buttons and binds their click → clone-template-append-to-container. Per-row remove
buttons (`.yc-repeater-remove`) are bound on each row at creation. `collect()`
returns repeater values as a flat array under the key; `populate()` does
teardown-and-rebuild on data refresh (all rows removed, then all rows added — same
microtask, fires MutationObserver once with mixed removed/added).
**Per-form glue you'll typically need on top of YF's built-in:**
- Mask binding on repeater inputs (`_setupMasks` only runs at init against
  `this.el.querySelectorAll('[data-yc-mask]')` — templates aren't in live DOM at
  that point, and cloned rows don't get masks bound automatically). Workaround:
  delegated `blur` handler in capture phase on the form element.
- Primary-checkbox exclusivity across rows (use checkboxes with same `name`, not
  radios — radios would need shared `name` but YF needs `is_primary` as the data
  field name in the row schema).
- Auto-promote: first row in empty repeater gets primary; removing the primary
  auto-promotes the first remaining row. MutationObserver on the container.
- Race-safe handling for `populate()`-triggered teardown-and-rebuild: check
  "did anyone come back as primary in the new state?" before auto-promoting on
  primary-row-removed observation.
- Save-time guard: prompt user if any kind has rows but no primary (server
  aggregate path does NOT auto-promote — UI is the gate).

### entityData flatten pattern (Slice 3 Stage B.2)
For forms whose iframe contains nested-array child collections (currently
`contact-form.html`'s phones/emails/addresses), the parent (`contact2.html`)
extends its `getContact` include list and flattens child arrays INTO
`entityData.contact`:
```js
ed.contact = data.contact;
ed.contact.phones    = data.phones    || [];
ed.contact.emails    = data.emails    || [];
ed.contact.addresses = data.addresses || [];
```
The form's `endpoints.load.path = 'contact'` then surfaces them naturally to the
repeater fields via `_resolveDataSource()` — no yc-forms.js apiMap extension needed.
On save, the form receives the aggregate PATCH response (which has the same
shape — `contact: {contact, phones, emails, addresses}`) and applies the same
flatten to its own `_liveData` AND the parent's `entityData.contact` before the
postMessage round-trip triggers `refreshEntityData` (which re-fetches and re-flattens).

### Iframe-resize pattern
Iframes with content-driven height (e.g. `contact-form.html` after the repeaters
grow) post `{type: 'iframe-resize', form: '<formKey>', height: <px>}` to the
parent. Parent listens and sets `iframe.style.height` on the matching iframe.
Form-side uses `ResizeObserver` on `document.body` with last-reported-height
dedupe to prevent feedback loops.

### Key iframe pages

**`case2.html`** (current) vs `case.html` (legacy):
- Uses entityData pattern, firmData relay
- Tabs: Overview, Case Info (iframe → `forms/casedetails.html`), Sending (iframe → `sendingform.html`),
  341 Notes (iframe → `forms/341notes.html`), ISSN (iframe → `forms/issn.html`),
  Detailed Questionnaire (iframe → `forms/det.html`)
- Checklists loaded on-demand (NOT part of entityData)

**`contact2.html`** (current) vs `contact.html` (legacy):
- Uses entityData pattern, firmData relay
- Tabs: Info (iframe → `forms/contact-form.html`), Communication (iframe → `communicate.html`),
  Sequences, Appointments, Cases, Bills, Log, Tasks
- Communication tab is now an iframe (previously inline SMS/email/call divs)

**`communicate.html`** (new, on contact2 tabSend):
- Three panels: SMS, Email (Quill editor), Log Call
- Reads contact + firmData from parent (`P.entityData.contact`, `P.firmData`)
- SMS supports MMS attachment (RingCentral only); email supports attachment and inline images
- "Log Without Sending" option on SMS and Email panels
- "Log Call" panel logs a call as a log entry without any send
- Posts to `/internal/sms/send`, `/internal/mms/send`, `/internal/email/send`, `/api/log`

**`sendingform.html`** (on case2 tabSend):
- Loaded as iframe, reads caseData + firmData from parent
- Modular action sections (Credit Counseling, SOS Title, IRS/ID.ME, Documents Needed,
  Allan Anchill, Questionnaire, Other)
- Server-side message assembly via `POST /api/compose-docs-message`
- Documents Needed action calls `/checklists/upsert-items` for tracked items

**`campaign.html`**:
- Iframe in the main app. Uses `P.apiSend()` and `P.Swal`.
- Three tabs: Select Contacts, Compose, View Campaigns
- Campaign system was rebuilt ground-up (not migrated) — per-contact `scheduled_jobs` pattern
  to work within Cloud Run's timeout constraint.

**`automationManager.html`** (supersedes `workflowManager.html`):
- Four tabs: Workflows, Sequences, Scheduled Jobs, **Hooks**
- Hooks UI is integrated here as a tab (the older standalone `public/yisraHook.html`
  also exists as a parallel UI — both drive the same `/api/hooks/*` backend)
- Dynamic function dropdowns via `GET /workflows/functions`
- Per-type cascade `filters` JSON in sequence template editor (Manage Types button drives `priority_fields`)
- Jobs tab filter covers all 8 types with internal toggle
- Collapsible left panel, resizable right editor panel
- Param-source datalists (`fdParamSourceDatalistHtml`) intentionally include user 0 —
  workflow steps may legitimately want to reference automation user as actor.

### Legacy files still using /db
Ongoing retirement — see PENDING/TODO section.

---

## 13. WORKFLOWS IN PRODUCTION

### Appointment Reminder Workflow
- 31-step workflow (ID stored in `app_settings.appt_reminder_workflow_id`)
- Starts automatically from `createAppt`, cancels from all status-change functions
- 341 vs non-341 branching
- Pattern: resume → re-fetch appt → re-check status → send
- Pre-computed UTC timestamps with past-time skip

### No-Show Sequence
- Template type: `no_show`
- 4 steps: immediate SMS, next biz day SMS, 2 biz days task, 5 biz days email
- Enrolled from `markNoShow`, cancelled from `createAppt`/`markAttended`
- Cascading template matching via `sequence_template_types.priority_fields = ["appt_type", "appt_with"]` (preserves prior hardcoded behavior under the new generalized model)

### Daily Appointment Report (Workflow 5)
- Recurring job: cron `0 4 * * 0,1,2,3,4,5`
- Morning email + SMS, afternoon refresh and second email/SMS

---

## 14. PENDING / TODO

### Pre-launch deploy gates (BLOCKING)
1. **Run UNIQUE constraint migration on `campaign_results` BEFORE deploying campaign code**
   — `ALTER TABLE campaign_results ADD UNIQUE KEY uq_campaign_contact (campaign_id, contact_id);`
   Without this, the ON DUPLICATE KEY UPDATE in `recordResult()` falls back to plain INSERT
   and creates duplicate rows on retry. Pre-migration: dedup any existing duplicates.
2. **Tighten login rate limit** — 100/15min → 10/15min. Currently loosened for testing.
3. **Audit existing `sequence_templates`/`sequence_steps` for duplicate `:placeholders`**
   — behavior change from the resolverService fix that now throws on DB errors.
4. **One-time cleanup of historical audit log rows** — pre-redaction rows in
   `jwt_api_audit_log` still contain Bearer tokens.
5. **Verify iframe filename casing** — Cloud Run's filesystem is case-sensitive;
   all iframe `src=` references must match exact casing.

### Immediate
- Kill `/db` and other legacy username/password endpoints after full deploy + testing
- Update Pabbly sending form workflow to call `/checklists/upsert-items` instead of Trello
- Update Cloud Scheduler `/process-jobs` cadence from every ~5 min to every 1 min
- Set up retention cron on `jwt_api_audit_log` and `query_log` — delete >30 days
- Wire `data-userlist-filter="does_appts"` into `newAppt` Swal in `case2.html` /
  `contact2.html` (currently commented-out drafts use `u.user_does_appts` — should be
  `u.does_appts`). Also add staff-member dropdown to the appt creation Swals.

### Security retirement roadmap (Bucket A / B / C — from Session 2 security audit)
Ordered retirement schedule for legacy code. Document separately as the master plan.
Key items: `/db` endpoint, `/unplacehold` route, inline username/password auth on
`campaign.html` (migrated), all non-JWT auth paths.

### Phase 6 — Architecture
- Move `index.html` data tabs to iframes (appts, tasks, cases, contacts) using
  the `waitForParent` boot pattern. (Log tab already converted to `/api/log` in Slice 3.)
- Finish migration from `index.html` to `a.html` as the primary shell

### Phase 7 — New features
- Direct Dropbox API integration (replaces JotForm uploader placeholder in `docReq.html`)
- Detailed Questionnaire (standalone project, NOT YisraForms — card/wizard UI paradigm)
- Checklist → task completion hook (seam already identified in `computeAndSaveStatus`)
- ISSN form: client testing + fixes, workflow (tax filing, Allan referral) when requirements clear

### YisraHook v1.1
- **Sync response mode** — return target's response to caller (API gateway pattern)
- **Custom static response** — configurable response body/status for async mode
- **Response transforms** — shape the target's response before returning to caller
- **Log retention** — automated cleanup for `hook_executions` / `hook_delivery_logs`
- **Auth manager** — OAuth support in credentials table

### Slice 3 B.2.b — polish backlog (deferred, not blocking)
- Rename row-level `name="notes"` in repeater templates to `note` or `row_notes`
  to kill the latent collision with the scalar `name="notes"` textarea. Currently
  dormant because yc-forms.js binds field references at init time (before any
  repeater rows exist in the DOM), but any future refactor of yc-forms.js to
  re-query would break it silently.
- Per-row error highlighting on 400: in `showValidationModal`, also stamp
  `data-ycp-error="<msg>"` on the matching `.yc-repeater-item`, plus a CSS rule
  `.yc-repeater-item[data-ycp-error] { border-color: red }`.
- Revive from history modal: add "Revive" button per ended row → POST to
  `/api/contact-phones` (or emails/addresses) with the original value +
  `?force=true` (value may have been claimed since).
- Last-row-removal warning: when user clicks × on the only row of a kind,
  Swal "This will leave the contact with no phones. Continue?" before save.
- Inline as-you-type validation in repeater fields (currently invalid phone/email
  only surfaces at save). Would require yc-forms.js validate() walking repeater rows.

### apiSend error-body extension (DONE)
Landed. `apiSend` now throws a named `ApiError` with `.status`, `.statusText`,
`.body`, `.url`, `.method`, and a `.message` derived from `data.message || data.error`.
Purely additive — callers reading only `err.message` are unaffected.
**Remaining follow-up:** refactor `contact-form.html` to drop `doRawPatch` +
`findAuthWindow` and read `err.body` from stock `apiSend` (see "Aggregate form
save pattern" §12). Not yet done.

### `contact_phone2` / `contact_email2` data cleanup (on Fred's plate)
1–2 contacts hold values in these vestigial columns that are not surfaced in
the post-B.2 form. Fred to manually migrate into `contact_phones` /
`contact_emails` as non-primary active rows, then the columns can be retired.

### Single biggest architectural enabler (Session 2 recommendation)
**Define `user_type` / role convention.** Once defined, it unlocks:
- SSN gating
- Internal route restrictions
- Admin-only workflow creation
- `custom_code` access control

(Note: per-role boolean columns on the `users` table are now the established pattern —
`user_type` as humans-vs-automation, `does_appts` as appt-doer flag. Add more as needed.)

### Completed (recently — this audit cycle)
- ✅ Forms system — Contact Info, 341 Notes, Case Details, ISSN, Sending Form, Appointment Form v2
- ✅ Parent-as-data-source architecture (`entityData` pattern on case2/contact2)
- ✅ `firmData` pattern — unified `/api/firm-data` endpoint + parent relay
- ✅ `communicate.html` iframe for contact2 tabSend — full SMS/email/call composer
- ✅ `sendingform.html` iframe for case2 tabSend — modular action framework
- ✅ Campaign system ground-up rebuild — per-contact scheduled jobs, opt-out, image library,
  attempt-aware retry (transient/permanent classification), UNIQUE constraint on
  `campaign_results`, Quill+HTML dual editor with custom EmailImage blot
- ✅ YisraHook v1.0 — full webhook processing engine with 13/13 test cases passed
- ✅ `automationManager.html` — redone with Hooks tab integrated; supersedes `workflowManager.html`
- ✅ `getCase` respects `include` parameter (mirrors `getContact` pattern)
- ✅ Configurable `logLimit` on both `getCase` and `getContact`
- ✅ `yc-forms.js` — parent data read, `window.ycForm`, `_original` re-snapshot after onLoad,
  centralized postMessage from framework (forms must not duplicate it)
- ✅ `PATCH /api/appts/:id` route with whitelist
- ✅ `GET /api/appts/:id` joins users table for `user_name`
- ✅ `/api/intake/contact` v2 — accepts firstName/lastName, optional phone, all contact fields
- ✅ `routes/sequences.js` — `appt_with_filter` in POST/PUT template handlers, cancel
  enrollment uses UPDATE (not DELETE) for audit trail
- ✅ `routes/workflows.js` — `GET /workflows/functions` returns categorized function list
- ✅ `process_jobs.js` — confirmed `executeJob(job, db)` passes `db` on all 4 execution paths
  (was listed as bug; was already fixed)
- ✅ `calendarService` `START_HOUR=18` — Shabbos window is Fri 6pm → Sat 10pm
- ✅ `resolverService` rethrows DB errors (removed catch-and-return-'failed' pattern)
- ✅ Task system — full backend (`taskService.js`, `routes/api.tasks.js`),
  statuses Pending/Due Today/Overdue/Completed/Deleted, 8 AM digest reminders, SMS digest
- ✅ Feature request system — DB schema, routes, frontend, email notifications
- ✅ **Role-based user-select filtering (April 2026)** — `/api/firm-data` now returns
  ALL users including user 0, with `user_type` and `does_appts` boolean columns.
  Frontend filter selects (`select.userslist`) opt into filtering via
  `data-userlist-filter="<column>"` attribute. Removed `populateUserSelect` helper.
  Pattern is additive: new role columns become available to filter by with one
  schema change + one SELECT update + one HTML attribute.
- ✅ **Slice 3 — Multi-value contact info + relationships (May 2026)**
  - Contact relationships system — `contact_relation_types` catalog (17 seeded
    types) + `contact_relations` junction with lifecycle, 5 dedicated REST endpoints,
    inline `tabRels` UI in `contact2.html` (NOT iframe — tabSeq-style)
  - `contact_phones` / `contact_emails` / `contact_addresses` tables with full
    lifecycle (start_date/end_date/end_reason) + per-type flags + audit columns
  - Generated virtual unique indexes (`uk_one_active_primary`, `uk_phone_active`,
    `uk_email_active`) replace global per-(contact,value) uniqueness; allows
    same-contact historical reclamation
  - Three per-type services (`contactPhoneService` / `contactEmailService` /
    `contactAddressService`) with full CRUD + dedicated routes; pure exported
    validators (`validatePhoneRow` etc., two-mode 'insert'/'update')
  - `updateContact` accepts aggregate `phones` / `emails` / `addresses` arrays
    alongside scalar fields — atomic transactional save via plan/apply
    reconcilers (`_planPhones` + `_applyPhonePlan`, etc.)
  - Cross-contact conflict UX: server returns 409 with structured `conflicts`
    array; UI presents transfer modal; `?force=true` opts into silent transfer
  - Per-row 400 errors aggregated across all kinds before throwing (lets the UI
    surface phone + email errors from one save together)
  - `listContacts` search expanded — phone/email branches EXISTS-reach into
    child tables INCLUDING ended rows (orphan-log auto-link case)
  - `contact-form.html` restructured with three native YF repeater sections;
    removed scalar phone/phone2/email/email2/address/city/state/zip fields
  - Full `form.save()` override with direct `fetch()` PATCH (workaround for
    `apiSend` discarding 4xx body); 409 transfer modal + 400 validation modal +
    history modal + iframe-resize via ResizeObserver
  - Mirror columns (`contact_phone`, etc.) now server-maintained reads;
    `recomputePrimary*` idempotent helpers in `lib/contactMirror.js`
  - `contact2.html` `entityData.contact` extended to flatten phones/emails/addresses
    so the form's `endpoints.load.path = 'contact'` surfaces them without
    yc-forms.js apiMap extension

---

## 15. COMMON PITFALLS

1. **`appt_status` values have spaces and are Title Case** — 'No Show' not 'no_show',
   'Canceled' with one L, 'Rescheduled' (one s, not 'Rescheduled')

2. **`users.user` is the PK** — not `users.user_id` or `users.id`.
   `req.auth.userId` is the correct property in routes (not `req.auth.sub`)

3. **`task_status` is 'Deleted' not 'Canceled'** in the new system.
   'Incomplete' is a frontend filter, not a DB value.

4. **`cases.case_id` is varchar** — 8-char alphanumeric like "uT7EU36v", not an int

5. **`cases.case_judge` and `cases.case_trustee` are names, not IDs**
   Join: `cases.case_judge = judges.judge_name`

6. **`appt_end` is a GENERATED column** — never write directly

7. **`contact_name` is trigger-computed** — never write directly

8. **`smsService.sendSms` takes positional args** — `sendSms(db, from, to, message)`
   NOT an object. `emailService.sendEmail` takes an object.

9. **`apiSend` is in the shell file (a.html / index.html), not scripts.js** —
   iframes use `P.apiSend()`

10. **Sequence cancellation uses `UPDATE` not `DELETE`** — cancelled jobs get
    `status='failed'` for audit trail

11. **`query_db` limit max is 1000** — passing higher silently clamps

12. **`resolverService` always returns HTTP 200** — check `result.status`.
    `strict: true` returns `status: 'failed'` but does NOT throw on unresolved placeholders.
    It DOES throw on DB infrastructure errors (changed behavior).

13. **`schedule_resume` must be in `isControlStep`** — omitting causes skipped
    blocks to fire immediately rather than being deferred

14. **Circular dependency resolution** — use deferred `require()` inside function
    bodies when circular imports arise (e.g. sequenceEngine ↔ internal_functions)

15. **Enum migration order** — always expand enum first (add new values), run data
    UPDATE second, then contract (remove old values). MySQL rejects out-of-order.

16. **`window.ycForm = this` is required** — YCForm constructor exposes the instance
    globally so parent pages can check `isDirty()` and push data during refresh.

17. **`onLoad` runs after `_original` snapshot** — `yc-forms.js` re-snapshots
    `_original` after `onLoad` completes. Without this, forms with onLoad callbacks
    appear dirty immediately on load, breaking autosave and refresh-push logic.

18. **`getCase` respects `include` param** — unlike the old version that returned
    everything regardless. Frontend callers must request what they need:
    `{ include: 'contacts,appts,tasks,log' }`. Deploy frontend include strings
    before or simultaneously with the backend change.

19. **postMessage responsibility rule** — `yc-forms.js` sends `form-saved` postMessage
    on save. Individual forms must NOT send their own `form-saved` postMessage.
    Doing so causes double `refreshEntityData` on the parent.

20. **Campaign `backoff_seconds` effective minimum** — bounded below by the Cloud
    Scheduler polling cadence (~5 min currently). A `backoff_seconds=60` retry will
    still wait for the next poll tick.

21. **Campaign `UNIQUE KEY uq_campaign_contact` is required** — without it,
    `recordResult()` falls back to plain INSERT and creates duplicate rows on retry.
    See PENDING #1.

22. **`/internal/mms/send` takes singular `attachment_url`** — not `attachment_urls`
    (plural is email-only). Signature: `{ from, to, text, attachment_url }`.

23. **`email_default_from` is the app_settings key** — not `email_from_default`.

24. **Cross-origin iframes in refresh loop** — scanning `document.querySelectorAll('iframe')`
    and touching `.contentWindow.ycForm` on cross-origin iframes (e.g. Dropbox embeds)
    throws `SecurityError`. Wrap in try/catch and handle silently.

25. **`dataMode: 'snapshot'` requires manual prefill in onLoad** — the framework does
    not auto-merge live entity data with submission data. Form builders must write the
    merge logic in `onLoad` explicitly.

26. **`fallback-to-API` is not a real scenario for internal forms** — if a form can't
    reach `window.parent.entityData`, it also can't reach `P.apiSend()`. The fallback
    path only applies to external-mode forms.

27. **`firmData.users` includes user 0 (Automation) by default** — frontend must
    filter by `user_type` for assignee/staff-only dropdowns, or by `does_appts` for
    appointment-related dropdowns. Use `data-userlist-filter="<column>"` on
    `select.userslist` elements, or inline `.filter(u => u.user_type)` for Swal popups.
    Forgetting the filter on a "Assign to" dropdown lets users pick the automation
    user, which the API will reject. Forgetting it on a filter dropdown for
    `task_from` is correct and intentional (selecting user 0 = "show automated tasks").

28. **Boolean columns from MySQL are `1`/`0`, not `true`/`false`** — `mysql2` returns
    `TINYINT(1)` as numeric `1`/`0`. JS truthiness handles them correctly
    (`u.user_type` is truthy for `1`, falsy for `0`). Don't compare with `=== true` —
    that fails. If a downstream consumer needs strict boolean, cast in the SELECT
    with `CAST(col AS UNSIGNED)`. The current `firmData` pipeline doesn't need it.

29. **Per-row validators preserve `is_primary: undefined` deliberately** — Slice 3's
    `validatePhoneRow` / `validateEmailRow` / `validateAddressRow` omit `is_primary`
    from the result object when the caller didn't supply it. This lets downstream
    code distinguish "user said no" (literal `false`) from "user didn't say"
    (auto-promote eligible). The dedicated POST route relies on this for the
    "auto-promote when contact has zero rows" behavior. The aggregate path treats
    absent OR false as "not primary" — never auto-promotes (UI is the gate).

30. **Aggregate reconciler — displacement-only primary demote** — when a row's
    `is_primary` semantics change in the aggregate PATCH, demote the existing
    primary only when the designated new primary's id is DIFFERENT from the
    existing primary's id. A blanket demote (per the original spec sketch) would
    silently zero a reaffirmed-primary noOp row (`{id: A, is_primary: true}`
    when A is already primary with no other changes). Same logic must apply to
    end-and-replace step E: when the row being end-and-replaced IS the displaced
    primary, force `is_primary=0` on the replacement insert (don't inherit from
    the pre-transaction snapshot, which still shows `is_primary=1`).

31. **Aggregate reconciler — `is_primary` step order** — step B (demote displaced
    existing primary) must run BEFORE step E (end-and-replace inserts) and step F
    (new inserts) when any of them sets `is_primary=1`, or `uk_one_active_primary`
    fires `ER_DUP_ENTRY`. Encoded in `_applyPhonePlan` step ordering A→B→C→D→E→F→G→H.

32. **YF repeater fields don't get `_setupMasks` binding** — `yc-forms.js`'s
    `_setupMasks()` runs once at init against `this.el.querySelectorAll('[data-yc-mask]')`.
    Template content is not in the live DOM at that point, and `_addRepeaterItemWithData`
    does not call `_applyMaskListeners` on cloned rows. Repeater inputs with
    `data-yc-mask="phone"` etc. get NO blur-formatting from YF. Per-form workaround:
    delegated capture-phase blur handler on the form element that re-formats values
    via the same mask logic. See `contact-form.html` `bindRepeaterMasks()`.

33. **YF repeater `collect()` doesn't strip masks** — line ~412 emits `input.value`
    as-is for repeater inputs (unlike scalar fields which go through `_stripMask`).
    Phone numbers reach the server formatted (e.g. `"(313) 555-9999"`). The server-side
    `normalizePhone` strips formatting on receipt so this is harmless, but worth
    knowing if writing a new repeater consumer that expects digit-only values.

34. **`apiSend` surfaces 4xx response bodies (extension landed)** — on non-2xx
    the shell's `apiSend` throws a named `ApiError` exposing `.status`, `.statusText`,
    `.body` (parsed response, or `{_raw}` for non-JSON), `.url`, `.method`, and a
    `.message` from `data.message || data.error`. Forms needing structured 4xx UX
    read `.body`/`.status` directly — no bypass required. `contact-form.html` still
    uses the legacy direct-`fetch` bypass (`findAuthWindow()`) pending refactor; see
    "Aggregate form save pattern" in Section 12.

35. **`entityData.contact` flatten in `contact2.html`** — Slice 3 B.2 mutates
    `ed.contact.phones/emails/addresses` from the `getContact` response so the form's
    `endpoints.load.path = 'contact'` surfaces them. Aggregate-form save flow
    optimistically updates `P.entityData.contact = flat` before the `form-saved`
    postMessage triggers re-fetch. Both should converge; the optimistic update is
    defensive against any transient state read between save and refresh.

---

## ═══════════════════════════════════════════════════════════════
## 16. YISRAHOOK — WEBHOOK RECEIVER & AUTOMATION ROUTER
## ═══════════════════════════════════════════════════════════════
 
**Status:** v1.2 production (internal automation targets added April 2026)
 
**Purpose:** Configurable webhook receiver. One route (`POST /hooks/:slug`)
replaces per-integration Express endpoints. Each hook is a DB row that
describes its own auth, filter, transform, and delivery targets.
 
### Pipeline
```
POST /hooks/:slug
  → lookup hook → authenticate → normalize → 200 immediately (async)
  → insert hook_execution
  → filter (none / conditions / code)
  → transform (passthrough / mapper / code)
  → for each active target (ordered by position):
      → evaluate target conditions
      → target-level transform
      → dispatch by target_type
  → update execution status
```
 
### Four target types (v1.2)
 
| target_type | Engine | Delivery |
|-------------|--------|----------|
| `http` (default) | `fetch()` | Sync, HTTP-only |
| `workflow` | `workflow_engine.advanceWorkflow()` | INSERT `workflow_executions`, fire-and-forget advance |
| `sequence` | `sequenceEngine.enrollContact()` | Sync |
| `internal_function` | `lib/internal_functions[name](params, db)` | Sync |
 
All four types share the filter, transform, condition, and retry pipeline.
HTTP targets created before v1.2 are unchanged (target_type defaults to 'http').
 
### Internal targets — config shapes
 
**Workflow:** `{ "workflow_id": 4 }` — transform output becomes `init_data` AND initial variables.
 
**Sequence:** `{ "template_type" OR "template_id", "contact_id_field" (default "contact_id"), "trigger_data_fields" [string array] }`. Cascade specificity comes from `trigger_data_fields` — fields named here flow into `trigger_data` and are matched against each candidate template's `filters` per the type's `priority_fields`. (No separate `appt_type_filter` / `appt_with_filter` config keys — that machinery is gone.)
 
**Internal function:** `{ "function_name", "params_mapping": { paramName: source } }`.
- `params_mapping` source syntax: `"'literal'"` → literal (quotes stripped), `"field_name"` → flat lookup on transform output, `"contact.id"` → dot-path lookup (same resolver as hookMapper). Array-index syntax not supported — flatten via transform layer if needed.
### Delivery log shape (internal targets)
- `request_url` = synthetic `internal://workflow/N`, `internal://sequence/<type>`, `internal://function/<name>`
- `request_method` = `'INTERNAL'`
- `response_status` = 200 success / 500 failure
- `response_body` = JSON.stringify of return value (truncated 10KB)
### Retry semantics (v1.2)
All failed target deliveries still queue a `hook_retry` job. Caveats by type:
 
- **workflow** — INSERT failure retries cleanly. Async `advanceWorkflow` failure does NOT trigger hook retry (delivery already succeeded at INSERT time); the execution row is marked 'failed' by `markExecutionCompleted`.
- **sequence** — `enrollContact` throws 'already enrolled' on duplicate. If first attempt enrolled but log write failed, retry fails fast and hits `max_attempts`.
- **internal_function** — NOT inherently idempotent. Functions with side effects (`create_task`, `send_sms`) will be invoked again on retry. Design hooks to be retry-safe or accept small risk of duplicates.
### Key files
- `services/hookService.js` — pipeline, dispatcher, deliverHttp/Workflow/Sequence/InternalFunction, buildDryRunPreview, CRUD
- `services/hookTransforms.js` — transform registry
- `services/hookMapper.js` — mapper engine + template resolver
- `services/hookFilter.js` — condition evaluator
- `routes/api.hooks.js` — receiver + management CRUD with per-type validation
- `public/automationManager.html` — primary UI (Hooks tab; target editor with type-selector + conditional sections)
- `public/yisraHook.html` — standalone UI
- `lib/auth.jwtOrApiKey.js` — management routes protection
### Database
- `hooks` — hook-level config
- `hook_targets` — per-target config
  - **v1.2:** `target_type` ENUM('http','workflow','sequence','internal_function') default 'http'
  - **v1.2:** `config` JSON column (internal-target routing params)
  - **v1.2:** `url` is now nullable
- `hook_executions` — per-invocation log (raw_input, transform_output, status)
- `hook_delivery_logs` — per-target delivery (request/response, attempts)
- `credentials` — shared auth store for HTTP targets only (internal/bearer/api_key/basic)
- `scheduled_jobs.type` enum includes `hook_retry` (from v1.0)
### API endpoints (behind jwtOrApiKey except receiver)
```
POST   /hooks/:slug
GET    /api/hooks
GET    /api/hooks/:id
POST   /api/hooks
PUT    /api/hooks/:id           ← auto-increments version
DELETE /api/hooks/:id           ← cascades targets
POST   /api/hooks/:id/targets   ← accepts target_type + config
PUT    /api/hooks/targets/:id
DELETE /api/hooks/targets/:id
POST   /api/hooks/:id/test      ← dry run with type-aware preview
GET    /api/hooks/:id/executions
GET    /api/hooks/executions/:id
GET    /api/hooks/meta          ← now includes target_types array
GET/POST/PUT/DELETE /api/credentials(/:id)
```
 
### Integration wiring
1. `server.js` — rawBody middleware on `/hooks` (for HMAC)
2. `process_jobs.js` — `hook_retry` handler calls `hookService.executeRetry(db, data)` (unchanged in v1.2 — dispatcher handles all four target types)
3. Migrations (in order):
   - `migrations/yisrahook_schema.sql` (v1.0)
   - `migrations/2026XX_hook_internal_targets.sql` (v1.2)
### Validated tests
- v1.0 — 13/13 passed (receiver, auth, filter, transform, mapper, HTTP delivery, retry, CRUD)
- v1.2 — 12 new test cases in manual (HTTP regression + 4 target types × create/dry-run/live delivery + validation + retry + target-level transform/conditions)
### v1.3 roadmap
- Sync response mode (API gateway pattern)
- Custom static response body
- Log retention automation
- OAuth-aware credential manager
- Per-target `no_retry` flag for non-idempotent internal_function calls

## 17. CAMPAIGN SYSTEM

### Overview
Bulk SMS and email to filtered contact groups. Per-contact scheduled jobs (one `campaign_send`
job per contact per campaign) — not a single long-running job. Works within Cloud Run's
timeout constraint.

### Data Flow
```
POST /api/campaigns
  → INSERT campaign
  → batch INSERT campaign_contacts   (UNIQUE on campaign_id + contact_id)
  → batch INSERT scheduled_jobs      (one per contact, type='campaign_send')
                                     idempotency_key = "campaign:{id}:{contactId}"
                                     name            = "campaign:{id}:send:{contactId}"

/process-jobs picks up campaign_send jobs (batches of 10, ~once per minute)
  → job_executor.js dispatches to campaignService.executeSend(db, campaignId, contactId, { attempt, maxAttempts })
    ├─ Load campaign → bail as 'skipped' if canceled or deleted
    ├─ Load contact → 'failed' if missing
    ├─ Check opt-out (contact_sms_optout / contact_email_optout) → 'skipped'
    ├─ Check channel info (phone/email present) → 'failed'
    ├─ Resolve placeholders (strict=true) → 'failed' if semantic failure
    ├─ Send via smsService / emailService / ringcentralService (MMS)
    └─ recordResult + checkCompletion

checkCompletion: when all contacts processed, finalize status based on results
  → all sent       → 'sent'
  → all failed     → 'failed'
  → mixed          → 'partial_fail'
```

### Error Classification (attempt-aware retry)
- **Skips** (campaign deleted/canceled, opted out, missing phone/email, resolver
  semantic failure) → record + return normally. Never retried.
- **Permanent send errors** (hard SMTP bounce, invalid number, auth failure) → record
  'failed' + return normally. Never retried.
- **Transient send/infra errors** (SMTP timeout, RC/Quo 5xx/429, DB blip, resolver
  DB throw) → THROW so the job system retries with backoff. On the FINAL attempt,
  transient is treated as permanent — record 'failed' and return normally so the
  `campaign_results` row exists and `checkCompletion` can finalize.

`isTransientError(err)` classifies by error code (ESOCKET, ETIMEDOUT, ECONNRESET, ...),
SMTP 4xx response codes, HTTP 429/5xx. Default for unrecognized errors: **PERMANENT**
(better to surface a one-attempt 'failed' than retry and cause duplicate sends).

### Cancellation
`PATCH /api/campaigns/:id` with `{ status: "canceled" }`:
1. Sets campaign status to `canceled`
2. Deletes pending jobs: `DELETE FROM scheduled_jobs WHERE name LIKE 'campaign:{id}:%' AND status = 'pending'`
3. Already-running jobs check campaign status at execution time and record as `skipped`

### Placeholders
Campaigns use `resolverService`. In campaign context, only `contacts` refs are available.
See Section 8 for full placeholder syntax. Preview endpoint resolves against a sample
contact for pre-send verification.

### Images (Email Only)
Quill image button offers three insertion methods: upload file (base64 → `/api/upload`),
enter URL, browse library. Images stored in GCS bucket; `image_library` table tracks them.
Custom `EmailImage` Quill blot preserves `width`, `style`, `alt` attributes for email-safe
rendering.

### Files
| File | Purpose |
|------|---------|
| `services/campaignService.js` | All business logic |
| `routes/campaign.js`          | Thin HTTP wrappers, JWT auth |
| `routes/upload.js`            | Image upload + library routes |
| `lib/job_executor.js`         | `campaign_send` job type dispatch |
| `public/campaign.html`        | Frontend (iframe) |

---

## 18. TASK SYSTEM

### Overview
Tasks are action items assigned to a user, linked to a contact/case/appt/bill. Full CRUD +
lifecycle notifications + automated due-date reminders + daily digest.

### Status Flow
```
Pending ─── becomes Due Today on the due date (at daily digest run)
  │           │
  │           ├── becomes Overdue the next day if not completed
  │           │     │
  └───────────┴─────┴──── Completed (terminal, but reversible via reopen)
                                  │
                                  ▼ Deleted (soft delete, reversible via reopen)
```

'Incomplete' is a frontend filter meaning `IN ('Pending', 'Due Today', 'Overdue')`.
Not a DB value.

### Status Transitions
- `completeTask(db, taskId, actingUserId)` — → Completed, cancels due reminder, notifies
  assigner if `notify=1` and actor ≠ completor
- `deleteTask(db, taskId, actingUserId)` — → Deleted, cancels due reminder
- `reopenTask(db, taskId, actingUserId)` — → computed from due date (Pending / Due Today /
  Overdue); re-schedules due reminder if due is today or future
- `transferTask(db, taskId, newUserId, actingUserId)` — reassigns, notifies new assignee
- `updateTask(db, taskId, fields, actingUserId)` — generic patch; if `task_due` changes,
  cancels old reminder and schedules new one

### Routes
See Section 4. Response shape: `{ data: [...], total }` (not `{ tasks, counter }`).

### Due Reminders
- `scheduleDueReminder(db, taskId, dueDate)` inserts a `one_time` job of type
  `task_due_reminder` at 8 AM firm time on the due date.
- Stores job ID in `tasks.task_due_job_id` for cancellation tracking.
- `cancelDueReminder` sets the job to `status='failed'` (audit-safe, not deleted).
- No-ops if due date is today or past.

### Daily Digest
- Recurring job `task_daily_digest`, cron `0 13 * * *` (8 AM EST).
- Step 0 (always): refresh task statuses — Pending→Overdue/Due Today based on `task_due`
- Step 1: Shabbos/Yom Tov gate — status refresh happens, but no digest sent
- Step 2+: for each user whose `task_remind_freq` includes today's day name:
  - Query Overdue / Due Today / Pending tasks assigned to them
  - Send digest email (table-based HTML, clickable APP_URL links to contact/case)
  - If `allow_sms=1`: short SMS summary (counts only, not contents)
  - Skip users with no active tasks

### Log Integration
Every task event writes a log entry:
- `action: 'created'` on create, with `assigned_to`
- `action: 'updated'` on patch, with `changed: [fieldKeys]`
- `action: 'completed'` on complete
- `action: 'deleted'` on delete, with `previous_status`
- `action: 'reopened'` on reopen, with `previous_status` and `new_status`
- `action: 'transferred'` on transfer, with `from_user_id/name` and `to_user_id/name`

Linked to the task's contact or case so it appears on that record's log.

### Files
| File | Purpose |
|------|---------|
| `services/taskService.js` | All business logic + email builders |
| `routes/api.tasks.js`     | Thin HTTP wrappers |
| `lib/job_executor.js`     | `task_due_reminder` + `task_daily_digest` inline blocks |
| `lib/internal_functions.js` | `create_task`, `run_task_digest` |

---

## 19. NOTES & LISTS SYSTEM

*(Renamed from "Checklist System". The table, route file and URL prefixes are still
`checklists` / `checkitems` / `/checklists` — those are consumed by `portalDocsService`,
`docReq.html`, `case.html` and the public unauthenticated portal routes. "Notes & Lists"
is UI copy only.)*

### Overview — one table, two row shapes

`checklists.kind` discriminates:

| | `kind='checklist'` | `kind='note'` |
|---|---|---|
| content | N `checkitems` rows | `body` TEXT, zero checkitems |
| `status` | **derived** from items | **manual** (a Done checkbox) |
| created by | "New List" | "New Note" |

Google Keep model: same card chrome (inline-editable title, tag badge, delete, the
personal-ownership gate, the browse index, the entity embed), only the card *interior*
differs. Building a parallel notes subsystem would have duplicated ~2,300 lines to change
one render branch.

Linkable to `contact | case | bill | appt | task | user | event`. Untagged rows are
unlimited per entity; tagged rows are one-per-`(link_type, link, kind, tag)`.

### Status: derived for lists, manual for notes

`computeAndSaveStatus(db, checklistId)` runs after every item create/update/delete:
- all items `complete` → checklist status `complete`
- otherwise (including zero items) → `incomplete`

**Never write `checklists.status` directly for a checklist** — it will be overwritten.

A note has zero items *by design*, so the rule would pin it to `incomplete` forever and
stomp its Done checkbox. The function therefore **early-returns
`{status: null, transitioned: false}` when `kind='note'`** — one guard covering all five
call sites, including `caseService.mergeCases`, which calls the lib directly with no route
in front of it. `checklist.completed` is gated to `kind='checklist'`; there is deliberately
no `note.completed` event (additive later, breaking to remove).

### Docs Needed — upsert-items pattern

`POST /checklists/upsert-items { case_id, items: string[] }`:
1. Find or create a `'Docs Needed'` checklist for the case (link_type='case', link=case_id).
2. For each input item: remove any existing item whose name's first 22 chars match, then
   insert fresh. Handles "Bank statements — Chase, Comerica" replacing prior
   "Bank statements — ..." entries without duplicating.
3. Recomputes checklist status.

Used by the sending form's Documents Needed action. The public docs page
(`GET /api/public/docs/:caseId`, used by `docReq.html`) returns only incomplete items.

**`FIND_DOCS_SQL` carries `AND kind = 'checklist'` and this is load-bearing.** Since
`uq_link_kind_tag`, a `docs_needed` *note* may sit beside the real list — and a staff note
merely *titled* "Docs Needed" needs no tag at all to match the title fallback. Selecting
one would write checkitems onto a note while `portalDocsService`, `docReq.html` and the
public GET keep reading the checklist: portal renders empty, no error anywhere.

The same hole existed in DB-stored config. Workflow 42 step 6 ("Docs checklist already
exists?") counted by tag alone; fixed in v3 (published 2026-08-20) by adding
`checklists.kind = 'checklist'` to its `query_db` where-clause. Swept and clean as of that
date: no `trigger_rules`, `trigger_rule_actions`, `report_definitions`, `form_templates` or
`portal_cards` reference checklists. Every other code-side `docs_needed` query drives
`FROM checkitems ci JOIN checklists cl`, which excludes notes structurally.

### `NATIVE_NOTES` — pinned virtual cards

Several entities carry a single freeform notes column predating this page. Rather than
migrate them, the notes board **synthesizes a pinned card that reads and writes the real
column**. It is a VIEW, not a migration: one store, no sync, no drift.

```
case    → cases.case_notes        /api/cases
contact → contacts.contact_notes  /api/contacts
appt    → appts.appt_note         /api/appts
event   → events.event_note       /api/events
```

Cards are `{ id: null, kind: 'note', native: {field, endpoint, entityId} }`; the client
branches on `native` and PATCHes the entity instead of `/checklists`. `NATIVE_ENVELOPE`
maps each endpoint's response shape (`{case:…}`, `{contact:…}`, `{data:…}` — they differ).
Native cards suppress delete, tag, Done and re-homing: there is no row to carry them.

**`cases.case_notes` cannot move.** It is read by `caseService.searchCases`
(`OR c.case_notes LIKE ?`, the hot picker path), report definition 10 (`lead_followups`,
active), three published form templates (ids 3/4/6, each mapping a field via `apiColumn`),
the merge concat, and `tabLeads.html`'s inline grid. Surfacing beats migrating.

**`cases.341_notes` is deliberately NOT in the map.** S5 pinned it; removed 2026-08-20 once
the reason for its emptiness surfaced — the column has never had a write path. Form
template 5 (`form_key='341_notes'`, "341 Meeting Notes", published, rendered by case.html's
341 tab) maps to `341_status` / `docs_missing` / `docs_due` / `case_trustee` /
`case_number_full` / `case_id`, **not** to `cases.341_notes`. 0 of 1,077 was structural, not
neglect. If 341 notes are wanted, the right shape is the docs_needed pattern: have the 341
form upsert a *tagged note*, so the card exists only where there is a 341 to write about.

**Known wart, documented not fixed:** `case_notes` is editable in two places — case.html's
Overview textarea and the pinned card. Last write wins; the other surface is stale until its
tab reloads. Different tabs, so collision needs one person editing both in a sitting.

### `lib/noteLimits.js` — one limit, enforced server-side

`NOTE_MAX_CHARS = 10000` across `case_notes`, `341_notes`, `contact_notes`, `appt_note` and
`checklists.body`.

**Why it exists:** the session sql_mode deliberately lacks `STRICT_TRANS_TABLES` (enabling
it breaks case creation — ~41 NOT-NULL columns rely on implicit defaults — and `listCases`'
GROUP BY). Under non-strict mode an over-length write is **truncated silently**. This was
not hypothetical: `appt_note` was `varchar(1000)` until 2026-08-20 and four rows sat at
exactly 1000 characters, each cut mid-sentence, never reported. `341_notes`,
`contact_notes` and `appt_note` were widened to TEXT that day; TEXT raises the ceiling to
65,535 **bytes** but does not remove the cliff, so the guard lives in code.

The cap is `String.length`, not bytes — the number a UI can show. Worst case is 3 bytes per
UTF-16 unit, so 10,000 can't exceed 30,000 bytes.

Enforced at six sites: `api.checklists.js` (POST + PATCH `body`), `caseService.updateCase`
(covers the route *and* `internal_functions/cases.js`), `contactService.updateContact`
(same), `routes/api.appts.js` PATCH **and** `internal_functions/appointments.js` (appts have
no shared service update path).

**Machine append paths are exempt by design:** `caseService`'s merge concat and
`apptService`'s five `appt_note` CONCAT sites (booking/reschedule/cancel audit trails —
almost certainly what grew those four rows). Failing a reschedule because an appointment has
been rescheduled often would be worse than a long note, and TEXT sits ~6× above the limit.

`assertNoteLengths` throws with `err.status = 400`; `api.cases.js` and `api.contacts.js`
status ladders check `err.status` before their legacy `err.message` substring matching.

**Remaining gap, accepted:** `checklists` is in `db.js`'s generic write map, so `update_db`
can write an oversized `body` past the route. `body` is left writable for future automations.
`cases`/`contacts`/`appts` are not in that map at all.

### UI surfaces

| File | Role |
|---|---|
| `public/checklistView.html` | the card renderer. Modes: `?id=` single · `?link_type=&link=` entity · neither = unlinked |
| `public/checklistsView.html` | the index. Scopes: Browse (its **own** row renderer) · Mine · Unlinked (both iframe checklistView) |

Embedded by: `case.html` tab, `contact.html` tab, `apptform2.html`, `eventform.html`, and
the shell's Notes & Lists panel. A tri-state **All / Notes / Lists** filter passes `?kind=`
server-side; native cards are filtered client-side (the route can't know about them).

**Case boards also show related contacts' cards** in separate labelled groups below the
case's own, with a distinct border tint and the contact's name + relation. Justification:
1,065 of 1,077 cases have exactly one related contact, so fan-out is ~1:1. Unlike the log
(which expands the same way) notes are *editable*, and 47 contacts sit on more than one
case — hence the labelling and the "also on N other cases" warning. Creation on a case board
always targets the case, never a contact.

### Frontend pitfalls — all of these have bitten

- **`render()` rebuilds the whole DOM** and every mutation handler calls it. A successful
  body save updates `cl.body` in memory and **must not re-render** — a textarea can't
  survive it and the caret dies mid-word.
- **`refocusAddInput` matches `lists.findIndex()` against `querySelectorAll('.ck-card')[idx]`.**
  A `display:none` card **still matches `.ck-card`**, so a filtered-out card must not be
  built at all rather than built and hidden.
- **`bodyDrafts`** is keyed by `draftKeyOf(l)`, not by id — native cards have `id: null` and
  need namespaced synthetic keys (`'native:case_notes'`, `'native:contact:456:contact_notes'`).
- **`load()` calls `flushBodies()` before its refetch** so a pending PATCH isn't clobbered by
  the GET response. Native and contact-scoped cards refetch from different endpoints.
- **A failed body save keeps the draft** and retries; it does not re-render and discard the
  text. A draft whose card leaves `lists` (filter change, not deletion) is kept while dirty —
  `shownBody()` restores it when the card returns. `beforeunload` warns on unsaved text.
- **Plain text only.** There is no HTML sanitizer anywhere in this repo, and note bodies are
  an obvious future sink for automated content. Never `innerHTML` a body.
- **`COUNT_SHOW_AT`** is a comment-toggle block (uncomment exactly one; two live `const`
  lines is a deliberate parse-time SyntaxError). Currently `1` — counter appears as soon as
  there is any text.

### Merge behaviour

`caseService`'s consolidation matches loser→survivor on `s.tag = l.tag AND s.kind = l.kind`.
Notes fold their **body** across (mirroring how `case_notes` is concatenated) rather than
folding items and losing it. Excluding notes from consolidation is not available:
consolidation is step 1b, *ahead* of the step-2 repoint, and skipping it would carry a
same-`(link_type, link, kind, tag)` note onto the survivor and violate `uq_link_kind_tag`,
rolling back the whole merge.

`lib/internal_functions/db.js` has `checklists: { block: ['kind'] }` — the generic surface
may not flip a row's kind (which would strand items or a body). Note this also blocks
`insert_db` creating a note generically; a generic insert gets the `'checklist'` default.
`checkitems` remains `insert: true` with no parent-kind check, so `insert_db` can still
attach items to a note — zero live workflows do, and the result is invisible orphan rows.

### Files

| File | Purpose |
|------|---------|
| `routes/api.checklists.js` | all routes; kind validation; `FIND_DOCS_SQL` |
| `lib/checklistStatus.js` | `computeAndSaveStatus` + the note guard |
| `lib/noteLimits.js` | `NOTE_MAX_CHARS`, `NOTE_COLUMNS`, `checkNoteLengths`, `assertNoteLengths` |
| `public/checklistView.html` | card renderer, `NATIVE_NOTES`, `NATIVE_ENVELOPE`, body autosave |
| `public/checklistsView.html` | browse index (independent row renderer) |
| `public/eventform.html` | event modal view, embeds the widget |

### Planned: checklist → task completion hook

Seam already identified in `computeAndSaveStatus`. When a checklist transitions
incomplete → complete, optionally mark a linked task complete. Not yet implemented.

---

## 20. COMMUNICATION UI (communicate.html)

### Overview
Per-contact messaging iframe hosted in `contact2.html` tabSend. Replaces the older inline
SMS/email/call divs with a unified Quill-based composer.

### Structure
Three panels, one visible at a time:
1. **SMS panel** — dropdown from, contact's phone(s) as to, character count, MMS attachment
2. **Email panel** — dropdown from, contact's email as to, Quill editor, attachment
3. **Log Call panel** — records a call entry (no send)

### Data Source
Reads from parent:
- `P.entityData.contact` — current contact
- `P.firmData.phoneLines` — SMS "From" dropdown options
- `P.firmData.emailFrom` — email "From" dropdown options
- `P.firmData.currentUser` — preselects `default_phone` and `default_email`

### Send / Log Actions
- **Send SMS / MMS** — posts to `/internal/sms/send` or `/internal/mms/send`.
  MMS only works with RingCentral `provider`; other providers show "(SMS only)" suffix
  and hide MMS attach button.
- **Send Email** — posts to `/internal/email/send` with Quill HTML. Supports file attachments
  (as `attachment_urls` for Pabbly/Gmail, `attachments` for SMTP).
- **Log Without Sending** (SMS + Email) — posts to `/api/log` only, no send.
- **Log Call** — posts to `/api/log` with `type='call'`.

### Parallel: sendingform.html (case2 tabSend)
Similar pattern but for case-level bulk actions. Modular action framework: each action
(Credit Counseling, SOS Title, IRS/ID.ME, Documents Needed, Allan Anchill, Questionnaire,
Other) is a checkbox section that can be mixed with recipient selection.
Server-side message assembly via `POST /api/compose-docs-message`. Documents Needed
action calls `/checklists/upsert-items` for tracked items.
## ═══════════════════════════════════════════════════════════════
## 21. CONNECTIONS — CREDENTIAL MANAGEMENT
## ═══════════════════════════════════════════════════════════════

### Overview
Firm-wide credentials managed by admins, used by outbound HTTP in YisraFlow
(hooks/workflows/sequences/scheduled-jobs) and by the admin API Tester.
Hosted at `/connections.html`, accessible from a.html SU section alongside dbConsole.
Admin-only; non-SU users get "Admin only" on load. See manual chapter
`03-YisraFlow/15-connections.md` for the full reference and
`03-YisraFlow/14-connections-live-test.md` for the end-to-end test playbook.

### Two tables, two UI tabs
- `credentials` — API auth (5 types, see DATABASE section). Tab: "API Credentials".
- `email_credentials` — SMTP senders + Pabbly routing. Tab: "Email Senders".
  `smtp_pass` is plaintext (deferred encryption — coordinated migration needed before
  changing this).

### Encryption
- `lib/credentialCrypto.js` — AES-256-GCM, wire format `ENCv1:` + base64(iv||tag||ct)
- `isEncrypted` is a literal prefix check on `ENCv1:` (not a heuristic)
- The earlier heuristic (base64 charset + length ≥ 28 bytes) produced false positives
  on alphanumeric provider secrets (typical Clio/Stripe shape), causing encrypt-on-write
  to silently skip and leave plaintext in the DB. Don't reintroduce heuristics.
- Encrypted fields:
  - `credentials.access_token` (oauth2)
  - `credentials.refresh_token` (oauth2)
  - `credentials.config.client_secret` (oauth2 — encrypted within the JSON)
  - `credentials.config.token` (bearer)
  - `credentials.config.key` (api_key)
  - `credentials.config.password` (basic)

### Outbound auth injection — critical sync/async asymmetry
`lib/credentialInjection.js` exports three things:
- `buildHeadersForCredential(db, credentialId, url)` — **async, handles all 5 types
  including oauth2**. Use this for ALL outbound HTTP in YisraFlow.
- `buildAuthHeaders(credential, url)` — **sync, skips oauth2** (returns `{}` for oauth2).
  Legacy. Do not use in new code.
- `checkUrlScope(credential, url)` — pre-flight scope check, returns reason on rejection.

**Pitfall (recurs in this codebase):** call sites that use the sync `buildAuthHeaders`
against an oauth2 credential silently break — request goes out with no Authorization
header, provider returns 401, UI shows misleading "restricted by allowed_urls" error.
All five outbound HTTP call sites have been migrated and verified working:
`services/hookService.js`, `lib/webhookExecutor.js` (workflows + scheduled jobs),
`lib/sequenceEngine.js` (via webhookExecutor), `routes/admin.apiTester.js`.

### OAuth2 service (`services/oauthService.js`)
Generic OAuth 2.0 client. Auth-code grant only. Exports:
- `buildAuthorizationUrl(db, credentialId, redirectUri)` — sets oauth_state + PKCE,
  returns auth URL string
- `exchangeCodeForTokens(db, state, code, redirectUri)` — looks up by state,
  exchanges, encrypts and stores tokens, sets `oauth_status='connected'`
- `refreshTokens(db, credentialId)` — handles failure tracking + 2-strike alert
- `revokeTokens(db, credentialId)` — calls provider revoke_url best-effort, clears local
- `getValidAccessToken(db, credentialId)` — returns fresh token, refreshes inline if
  within 120s of expiry

PKCE supported (S256). Client auth method per credential: `basic` (Authorization
header) or `body` (form fields). Refresh-token rotation handled (uses new token if
provider sends one, keeps existing if not).

### Refresh strategy — hybrid
- **Lazy:** every outbound use calls `getValidAccessToken`. If access token is within
  120 seconds of expiry, refreshes inline before returning the token.
- **Scheduled:** daily 03:00 Detroit (`0 7 * * *` UTC) via internal function
  `refresh_expiring_oauth_credentials`. Scans for credentials where
  `refresh_token_expires_at < NOW() + 48 HOUR` OR `access_token_expires_at < NOW() + 1 HOUR`.
  Iterates and calls `oauthService.refreshTokens` per credential.

Both paths use per-credential `GET_LOCK('oauth_refresh_<id>', 10)` MySQL mutex
(multi-instance safe). In-process Map dedupes concurrent refresh attempts to one
HTTP call per credential per process.

### Refresh failure handling
- Successful refresh: `refresh_failure_count = 0`, clears `oauth_last_error`, status
  back to `'connected'`.
- Failed refresh: increments count, stamps `oauth_last_error` + `oauth_last_error_at`,
  re-throws.
- At exactly count = 2: status flips to `'refresh_failed'`, one Pabbly alert fires
  (same alert URL pattern as `services/ringcentralService.js`). No further alerts
  from same failure run.
- Admin must re-authorize manually via "Re-authorize" button in UI.

### PUT semantics — deep merge (Slice 5 fix)
`PUT /api/credentials/:id` deep-merges `req.body.config` into existing config (one
level deep). Saving any single field preserves all others.

Exception: when `type` is changing, config is wholesale-replaced and all oauth-state
columns wiped (tokens, status, expiry, state, pkce_verifier, failure count).

`client_secret` follows merge: omit to preserve existing encrypted, supply to update.
Encryption-on-write is idempotent via `isEncrypted()`.

Pre-Slice-5, PUT replaced config wholesale, silently wiping all-but-the-supplied
field. Audit any pre-existing oauth2 rows with:
```sql
SELECT id, name, JSON_KEYS(config) FROM credentials
 WHERE type = 'oauth2'
   AND (JSON_EXTRACT(config, '$.client_id') IS NULL
        OR JSON_EXTRACT(config, '$.token_url') IS NULL
        OR JSON_EXTRACT(config, '$.auth_url') IS NULL);
```

### Access tiers
- Public: `GET /auth/oauth/callback` (security via unguessable state)
- Any auth user: `GET /api/credentials`, `GET /api/email-credentials` (scrubbed —
  for dropdowns when configuring hooks/sequences/workflows)
- Admin only via `superuserOnlyFor('connections')`: everything else. All admin
  routes audit success and failure to `admin_audit_log` with `tool='connections'`.

### UI (`public/connections.html`)
- Two tabs: API Credentials, Email Senders. Single page, no iframe nesting within.
- "Show" buttons on secret fields → call `/reveal`, display plaintext for 30s,
  re-mask. Does NOT keep plaintext in memory after mask.
- Connect button opens OAuth in popup. Popup posts message to window.opener:
  `{type: 'oauth_success'|'oauth_warning'|'oauth_error', credentialId, ...}`.
- Verbose toggle per oauth2 credential — logs token-exchange details (URLs, status,
  presence of tokens, prefixes/lengths). Never logs token values, client_secret,
  or auth code.
- PUT diff: only sends fields the user changed (avoids audit log noise).
- Hosted in a.html SU section as iframe (lazy-loaded via data-src), alongside dbConsole.

### Required env vars
- `CREDENTIALS_ENCRYPTION_KEY` — base64-encoded 32 bytes. Generate:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  App fails fast at boot if missing or wrong length.
- `APP_URL` — base URL (e.g. `https://app.4lsg.com`, no trailing slash). Used to
  build callback URL `${APP_URL}/auth/oauth/callback`. Must match exactly the
  redirect URI registered with each OAuth provider.

### Daily refresh job — manual setup
No auto-seeder pattern in this codebase. Set up once via Automation Manager →
Scheduled Jobs:
- Type: `recurring`
- Job type: `internal_function`
- Function: `refresh_expiring_oauth_credentials`
- Params: `{}`
- Cron: `0 7 * * *` (07:00 UTC = 03:00 Detroit)
- Max attempts: 2, Backoff: 300

### Files
- `lib/credentialCrypto.js` — encrypt/decrypt
- `lib/credentialInjection.js` — outbound auth header builder (3 exports)
- `services/oauthService.js` — OAuth lifecycle
- `routes/api.hooks.js` — credentials CRUD (deep-merge PUT, encryption-on-write)
- `routes/api.oauth.js` — authorize, callback, refresh, revoke, reveal
- `routes/api.emailCredentials.js` — email CRUD + test
- `public/connections.html` — admin UI
- Internal function `refresh_expiring_oauth_credentials` in `lib/internal_functions.js`
- Manual: `manual/03-YisraFlow/15-connections.md` (concept reference),
  `manual/03-YisraFlow/14-connections-live-test.md` (end-to-end test playbook)

### Lessons baked in (worth re-reading)
- **Sync vs async injection asymmetry.** `buildHeadersForCredential` for all outbound;
  the sync version skips oauth2 and breaks silently. This is a recurring trap.
- **Magic-prefix encryption format.** Heuristic `isEncrypted` produced false positives
  on plaintext provider secrets (alphanumeric ≥28 chars). Pure prefix check eliminates
  this class of bug.
- **Cloud Run 503 with no app log** can mean container crash on the request, not just
  IAP/load balancer interception. Always reproduce locally first.
- **Multi-instance refresh** requires per-credential MySQL `GET_LOCK` AND in-process
  dedup (Map). Both layers needed.
- **2-strike alert (not 1)** accommodates the 36-48hr daily-refresh window where token
  is still valid but refresh failed.
- **Redirect URI must match exactly** between provider's registered URI and
  `${APP_URL}/auth/oauth/callback`.
- **Initial OAuth exchange may not return a refresh_token.** Common with Google when
  `access_type=offline` + `prompt=consent` aren't in `extra_authorize_params`. UI
  shows a warning banner if this happens.

  ---

---

## 22. AI SESSION DB ACCESS (READONLY + SCRATCH)

Added 2026-05. Lets a Claude session query live DB state directly and persist small
notes between sessions without a human round-trip on every step. Two endpoints,
same header auth.

### Auth
- Header: `X-Readonly-Api-Key: ycro_<64 hex>`
- Keys managed at Admin tab → "Readonly Keys (SU)" button → Swal iframe
- SU-only create/revoke. Max TTL: `READONLY_KEY_MAX_TTL_DAYS` env (default 3 days).
- Plaintext key shown ONCE on create; never recoverable.
- The same key authorizes both endpoints below.

### `POST /api/readonly/sql` — read-only SQL
Body: `{ sql, params?, maxRows?, timeoutMs? }`
Response: `{ ok, rows, fields, rowCount, truncated, durationMs }`

**Allowed first keywords:** `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN`.
Leading block (`/* */`) and line (`--`, `#`) comments are stripped before the
keyword check. `WITH` is deliberately not allowed — MySQL 8 permits
`WITH … UPDATE`, which is a write.

**Defense layers** (top to bottom):
1. MySQL user has `GRANT SELECT ON <db>.*` only, no INSERT/UPDATE/DELETE/DDL/FILE.
   IP-bound to Cloud Run egress. On Cloud SQL post-migration this will tighten
   further to per-table grants if useful.
2. mysql2 `multipleStatements: false` — statement stacking blocked at parser.
3. First-keyword allowlist (see above).
4. `INTO OUTFILE` / `INTO DUMPFILE` explicit reject (belt-and-suspenders, since
   no FILE priv exists anyway).
5. `SET SESSION MAX_EXECUTION_TIME` per-query (default 30000, max 120000 ms).
6. Row cap (default 5000, max 20000) — payload truncation, not query truncation.

Every call — success and reject — logs to `readonly_query_log` with full SQL,
params, row count, duration, status, error.

### `PUT /api/scratch/:ns/:k` — upsert
### `DELETE /api/scratch/:ns/:k` — delete one
### `DELETE /api/scratch/:ns?confirm=1` — wipe namespace

Body for PUT: `{ v, meta? }`.

`v` is **string-only** (also accepts number / boolean / null, all coerce
cleanly). Objects and arrays are rejected with 400 — `JSON.stringify` them
yourself before sending so the storage shape is explicit at the call site.
Stored as MEDIUMTEXT (~16MB column ceiling, ~10MB practical via Express
body limit).

`meta` is optional JSON (objects/arrays fine here — stored in a JSON column).

`ns` and `k` must match `^[a-zA-Z0-9_\-]{1,64}$`.

**Reads go through `/api/readonly/sql`** — no dedicated read endpoint:
```sql
SELECT v, meta, updated_at FROM rw_scratch WHERE ns='slice3' AND k='findings';
SELECT k, updated_at FROM rw_scratch WHERE ns='ai_notes' ORDER BY updated_at DESC LIMIT 20;
```

**Table-escape protection:** the scratch route hardcodes the table name and
binds all dynamic input via `?` placeholders. No API path leads to other
tables. This is the primary guarantee (DB-grant-layer protection for scratch
deferred until Cloud SQL migration; SiteGround's UI doesn't expose per-table
grants).

### Recommended namespaces
Use whatever, but conventions help:
- `ai_findings` — DB audits, investigation outputs
- `ai_notes` — session-to-session reminders
- `slice<N>` — slice-specific working data
- `todo` — cross-session task list
- `scratch_<topic>` — anything else

### Curl shapes

```bash
KEY="ycro_…"
BASE="https://app.4lsg.com"

# Read live state
curl -s -X POST "$BASE/api/readonly/sql" \
  -H "X-Readonly-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT contact_id, contact_lname FROM contacts WHERE contact_id=1001"}'

# Save a finding (note: v is stringified — meta carries the structured side)
curl -s -X PUT "$BASE/api/scratch/slice3/findings_2026-05-24" \
  -H "X-Readonly-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"v":"diverged=0, partial-addr=10","meta":{"contacts":[1209,1358]}}'

# Save a structured object — JSON.stringify it into v
curl -s -X PUT "$BASE/api/scratch/slice3/audit_2026-05-24" \
  -H "X-Readonly-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"v":"{\"diverged\":0,\"partial_addr\":10,\"contacts\":[1209,1358]}"}'

# Read it back
curl -s -X POST "$BASE/api/readonly/sql" \
  -H "X-Readonly-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d "{\"sql\":\"SELECT v, meta FROM rw_scratch WHERE ns='slice3' AND k='findings_2026-05-24'\"}"

# Delete one
curl -s -X DELETE "$BASE/api/scratch/slice3/findings_2026-05-24" \
  -H "X-Readonly-Api-Key: $KEY"

# Wipe namespace
curl -s -X DELETE "$BASE/api/scratch/slice3?confirm=1" \
  -H "X-Readonly-Api-Key: $KEY"
```

### Operational notes
- All operations (read + write + reject) logged to `readonly_query_log` regardless
  of endpoint. Per-key log available at Admin → Readonly Keys → "log" button.
- Key auth failures (missing/unknown/revoked/expired) log to `admin_audit_log`
  under `tool='readonlyKeys'`.
- Use targeted queries (`WHERE id = …`) over table dumps — tokens and bandwidth.
- Removal instructions: see comment block at end of `startup/dbReadonly.js`.

### Files
- `startup/dbReadonly.js` — dedicated mysql2 pool (yc_readonly user)
- `lib/auth.readonly.js` — readonly key middleware + sha256 hashing
- `lib/sqlGuard.js` — `isReadOnlyQuery`, `hasFileExfilClause`
- `routes/api.readonly.js` — `POST /api/readonly/sql`
- `routes/api.readonlyKeys.js` — SU CRUD on the key table
- `routes/api.scratch.js` — PUT/DELETE on rw_scratch
- `public/readonlyKeys.html` — SU admin UI (Swal iframe inside b.html admin tab)
- `migrations/readonly_db.sql` — keys + query log tables, RO user grants
- `migrations/rw_scratch.sql` — scratch table

### Tables
- `readonly_api_keys` — keys (sha256-hashed), TTL, revocation, usage counters
- `readonly_query_log` — every call, full SQL and params, status, duration

## 23. EVENTS SUBSYSTEM

### Concept

`events` = first-class dated obligations/milestones (confirmation hearings, docs deadlines, internal due dates). Distinct from **appts** (meetings with an attendee + attendance lifecycle) and **tasks** (one user's to-do). An event links to ONE target — a case (by id), a docket (`'case_number'`, see below), a contact, or nothing (`event_link_type` NULL = internal/unlinked). Never two targets, unlike appts.

**`case_number` link type (docket linking):** court emails carry a docket, often before any internal case exists — deadlines must calendar regardless. `event_link_id` = docket VERBATIM (trimmed only; opaque, equality-only, NEVER parse shape). Resolution is QUERY-SIDE and self-healing: rows are never rewritten to `'case'`. Case-scoped listEvents expands `(link_type='case' AND id=?) OR (link_type='case_number' AND link_id IN (case_number, case_number_full of that case))` — so case2's tab shows docket events automatically once a matching case exists, zero frontend change. Resolution surfaced as `resolved_case_id` via a shared correlated subquery (`RESOLVED_CASE_SUBQUERY`, LIMIT 1 — never a JOIN, fan-out risk; both docket columns indexed, all utf8mb4_general_ci). `link_label` = the docket itself, resolved or not; clickability keys off `resolved_case_id` (shells addFile, digest ?case= link; unresolved = plain text). Event LOG rows for docket events write `log_link_type='case'` + docket in `log_link_id` — the log table's existing court-email overload convention (log has NO 'case_number' enum value; its reader already matches dockets). `_normalizeLink` (createEvent) throws on unknown link_type or type-without-id and trims all link ids (previously '' stored silently under relaxed sql_mode); updateEvent validates type but allows partial PATCH of either half. Dialog has a 'Case #' free-text option (no picker, no shape validation); entity pages never pass case_number (linkFixed only). `get_events` html linkCell renders plain docket for case_number rows. Enum is expand-only — `'bill'` etc. are one-line ALTERs when use cases exist. This design supersedes any docket→case_id resolver: automation links by docket directly. 341-in-court-email = a real appt (needs contact) — interim: land as event type '341 Meeting' docket-linked; convert question rides the court-email arc.

### Schema

```
events (utf8mb4_general_ci — explicitly converted; new tables MUST specify
        COLLATE utf8mb4_general_ci or 8.0 defaults to 0900_ai_ci and joins
        to cases.case_id blow up on mixed collation)
  event_id          INT UNSIGNED PK AI
  event_type        VARCHAR(60)  NULL    -- opaque; UI dropdown fed by fe-event_types
  event_link_type   ENUM('case','contact','case_number') NULL
  event_link_id     VARCHAR(20)  NULL    -- case_id (varchar) | contact_id (int as string) | docket verbatim (case_number)
  event_title       VARCHAR(200) NOT NULL
  event_date        DATE         NOT NULL  -- firm-local
  event_time        TIME         NULL      -- NULL when all-day
  event_all_day     TINYINT(1)   NOT NULL DEFAULT 0  -- authoritative flag
  event_length      INT          NULL      -- minutes; timed only
  event_location    VARCHAR(255) NULL
  event_link        VARCHAR(500) NULL      -- url (zoom/docket); rendered in gcal DESCRIPTION, not location
  event_note        TEXT         NULL
  event_status      ENUM('Scheduled','Completed','Canceled') DEFAULT 'Scheduled'
  event_gcal        VARCHAR(255) NULL      -- gcal event id (role of appt_gcal)
  event_calendar_id VARCHAR(255) NULL      -- per-event calendar; NULL=app_settings default; 'none'=skip gcal
  event_create_date / event_created_by (tinyint users.user; NULL=automation) / event_updated_at
```

INVARIANT: `event_all_day=1 ⇔ event_time IS NULL` (and length NULL). eventService enforces on every write.

Enum expansions (applied): `tasks.task_link_type` and `log.log_link_type` include `'event'`; `log.log_type` includes `'event'`.

### Service / routes

`services/eventService.js`: `createEvent / updateEvent / completeEvent / cancelEvent / getEvent / listEvents / getEventsForDigest / buildEventDigestEmail / sendEventDigest / _gcalTimes`.

- GCal: native `gcalService` (NOT the dead /internal/gcal routes). All-day → `{date}` start, end = date+1 (exclusive); timed → bare local ISO strings (gcalService applies FIRM_TZ), end = start + (event_length||60)min. Reschedule = **delete old + create new** (appt pattern), store new `event_gcal`. Complete keeps the gcal event; Cancel deletes it. Per-event `event_calendar_id` is passed to delete too (the event lives on that calendar). `'none'` suppresses gcal, including teardown-on-edit-to-'none'.
- Reminders = **tasks** (no sequence machinery): `reminder:{to,date,title?}` on create AND on PATCH (route threads it). Creates a task `task_link_type='event'`, `task_link_id=event_id`. Complete/cancel finds active tasks by that link and `deleteTask`s them (which cancels the due-reminder job). Multi-touch reminders = future automated path; if ever sequence-based, `sequence_enrollments` needs an `event_id` column like `appt_id`.
- Side effects post-commit, non-blocking (`.catch`, never throw out of create).
- Input normalization (create + update, throws on garbage — relaxed sql_mode would otherwise store `9/9/2024`→`0000-00-00`, `4:00 PM`→`04:00:00` [12h early], combined datetime→time silently dropped): `event_date` accepts ISO | `M/D/YYYY` (MIEB) | combined `'<date> <time>'`/`'<date>T<time>'` (populates event_time; time supplied both ways = error); `event_time` accepts 24h | `h:mm AM/PM` (12 AM/PM edge-correct); `reminder.date` same date rules, validated synchronously (spawnReminderTask is fire-and-forget so its throws only reach logs). TZ suffixes rejected (firm-local). Batch items with bad input fail per-item (`ok:false`) instead of silently orphaning.
- Logs: `logService.createLogEntry(db,{type:'event', link_type:event_link_type, link_id:event_link_id, by, data})` — direct mapping, NULLs when unlinked. Actions: created/updated/completed/canceled/reminder rescheduled|cleared.

`routes/api.events.js` (auto-mounts, jwtOrApiKey):
`GET /api/events` (link_type, link_id, status default 'Scheduled' / 'all', type, from, to, q, sort asc|desc, limit, offset → `{data,total}`; rows = e.* + link_label/contact_name/case_number_display), `GET/:id`, `POST`, `POST /api/events/batch` (≤50 items, sequential per-item createEvent so each gets log/gcal/reminder; top-level event_link_type/event_link_id as defaults, item wins; per-item `{ok,index,...}` results; all-fail→400 [retry-safe], partial→200 `status:'warning'` (Swal-safe, title 'Partial'); no idempotency, double-fire = duplicate set), `PATCH/:id` (whitelist; blocked-fields error; `reminder` key presence — even null — means act on reminder, absence means leave alone), `PATCH/:id/complete`, `PATCH/:id/cancel` ({delete_gcal}). All `:id` routes use `(\\d+)` so 'batch' can't be captured. Create/status envelope `{status,title,message,data}`. acting user = `req.auth?.userId`.

Internal functions: `create_event, update_event, complete_event, lookup_event, get_events` (get_events mirrors get_appointments incl. html + output_var/count_var + date shortcut), `run_event_digest` (force/from/to overrides).

### Daily digest

ONE implementation: `eventService.sendEventDigest` exposed via internal function `run_event_digest` — **no job_executor branch** (deliberately avoided duplicating the task_daily_digest copy-paste debt; recurring `internal_function` jobs are the proven pattern — see oauth refresh job). Seeded as scheduled_jobs id 687, recurring, cron `0 21 * * *` UTC (~4-5pm Detroit, DST drift accepted).

Behavior: send-gate on TODAY via `calendarService.isWorkday` (skips Shabbos/Yom Tov; `force` bypasses). Window = tomorrow → **next workday inclusive** (day-by-day isWorkday loop, guard 10) so the last open day before a closure covers the whole closure + reopening day. Recipients: app_settings `event_digest_recipients` (CSV of users.user) → `email_default_to` → `process.env.FIRM_EMAIL` → abort (never mails the from-address). Empty window → sent:0. From/SMS via taskService.getFromEmail/getSmsFrom.

### Frontend

- Shared (scripts.js, global fns like newApptDialog): `newEventDialog({linkFixed:{type,id,label}|linkPick, event, defaultDate, onSaved})` — single link picker (None/Case/Contact via ContactPicker/CasePicker), all-day toggle, type select with Other, reminder editable on create AND edit. `eventComplete(id,onDone)`, `eventCancel(id,onDone)`.
- Shell (a.html + b.html, lockstep): tabEvents (filters type/status/date-range/q/sort, eventsTable, tabEventsGet, renderEventsFooter pagination). 'event-updated' postMessage listener scans iframes for `refreshEvents()`; `eventsChanged()` broadcasts `{type:'event-updated'}`. Entity pages do NOT push to shell (mirrors appt flow).
- case2/contact2: Events tab, lazy first-open, `refreshEvents()` (window-global so shell broadcast reaches it) fetches `/api/events?link_type=…&link_id=…&status=all&sort=asc`, `putEvents()` renders, row actions Edit/Complete/Cancel (Scheduled-only for the latter two). linkFixed locked to the entity.
- List rows return RAW `event_date` (ISO datetime) and `event_time` (HH:MM:SS) — client formats (`slice(0,10)`, `slice(0,5)`, "All day").
- `taskService.shapeRow` has an `'event'` branch → `Event #<id>` (id-only, no join, like appt/bill).
- **Notes & Lists (§19):** `checklists.link_type` gained `'event'`, so an event holds its own
  notes and lists. `events.event_note` surfaces as the pinned native card. Notes attach to the
  EVENT, never to whatever it links upward to — 113 of 151 events link by `case_number`, a
  free-text docket, so event-scope is the only unambiguous anchor. `public/eventform.html` is
  the modal view (`showEvent(id)` in the shell, mirroring `showAppt`).

### fe-* settings pattern (introduced with events)

`api.firmData.js` returns `firmData.settings` = all app_settings rows keyed `fe-*` (prefix stripped, JSON-parsed, raw fallback). ONLY fe-* keys are exposed — secrets (rc_token, quo_api_key, clio_login_code, etc.) are non-fe and stay hidden. Adding a frontend-readable setting = INSERT an `fe-…` row, no backend change. First user: `fe-event_types` (JSON array feeding the event Type dropdowns via `getEventTypeOptions()`).

### Gotchas / learnings

- New-table collation: ALWAYS `COLLATE utf8mb4_general_ci` explicitly.
- contact join (`event_link_id` varchar = `contact_id` int) is implicit-cast, fine for small queries, no index use.
- Recurring jobs of `data.type='internal_function'` reschedule + dispatch fine (prod-proven).
- Reminder-task log rows aren't attributed to the case/contact (taskService logTaskEvent doesn't resolve event links); event-level log rows cover the timeline instead.
- Scratch todo #3: dedupe run_task_digest / task_daily_digest the same single-impl way (separate slice).
- Next arc unlocked: court-email parser → create_event (MIEB confirmation hearings, ALWAYS parse the explicit date, NEVER derive by formula) and 341 → docs_deadline via create_event + prevBusinessDay.
- `rw_scratch` — generic key-value with namespace (`ns + k` unique)

## ═══════════════════════════════════════════════════════════════
## 24. YISRAVIDEO — VIDEO ASSET PREP
## ═══════════════════════════════════════════════════════════════

Short personalized videos sent to clients via a branded player page. Player =
`views/v.html` (`/v/<slug>`, `routes/videoLanding.js`); CRUD + GCS asset upload
in `routes/api.videos.js` / `services/videoService.js`; insertion helpers in
`public/js/videoInsert.js`. End-user manual: `manual/.../11-YisraVideo.md`.
This section covers **preparing the assets** (the ffmpeg side).

### Player contract (`views/v.html`)

`<video controls preload="metadata" poster=… playsinline>`, 16:9, max-width 720px.
Because of `preload="metadata"`, the MP4 **must be faststart** (moov atom before
mdat) — otherwise iOS/Safari stall or refuse progressive playback until the whole
file downloads.

### Most common source defect: moov atom at end of file

Check with `ffprobe` atom order. If codecs are already H.264 + AAC at a sane
bitrate, **do not re-encode** — remux losslessly:
```
ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4
```
Only re-encode if the source isn't H.264/AAC, is absurdly large, or exceeds the
500 MB upload cap. Re-encoding a talking-head at ~800 kbps just softens it for no gain.

### Poster (optional, JPG preferred)

Native 1280×720 / 16:9. Also serves as the email preview and phone link-preview
image, so pick a clean frame — eyes open, mouth neutral. Talking-heads are mid-word
on nearly every frame; sample a contact sheet and pick the best, e.g.:
```
ffmpeg -ss <t> -i in.mp4 -frames:v 1 -q:v 2 poster.jpg
```

### GIF (optional, email/MMS)

480×270, ~12fps, ~3–4s, two-pass palette keeps it clean and small (~600 KB).
**Outlook freezes the GIF to its first frame**, so start the clip on a clean,
camera-facing frame:
```
ffmpeg -ss <t> -t 3.5 -i in.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,palettegen=stats_mode=diff" pal.png
ffmpeg -ss <t> -t 3.5 -i in.mp4 -i pal.png -lavfi "fps=12,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" preview.gif
```

### Uploader & send-side gating

Uploader accepts: video `video/mp4` ≤500 MB (duration auto-read); poster
`image/jpeg,png,webp`; GIF `image/gif`. Insertion variants in `videoInsert.js`
gate on `gcs_poster_url` / `gcs_gif_url` being present, so missing assets just
drop those send options (poster/GIF email + MMS variants).

---

## 25. SCHEMA REF AUTO-GENERATION (`ref/database.sql`)

Added 2026-08. **`ref/database.sql` regenerates itself.** Do not tell Fred to open the
DB console and click "Save to ref" — that manual path still exists but is no longer how
the file stays current.

### How it works
`.githooks/pre-commit` (enabled via `git config core.hooksPath .githooks`) fires
`scripts/dump-schema.js` in the background on every commit, then stages
`TRACKED_FILES.txt` as before. Because the dump runs detached, a schema change lands in
the NEXT commit — `git add .` picks it up. Commit latency is unaffected.

### Why it does not re-dump every time
A full dump costs one `SHOW CREATE TABLE` per table (118 today). Instead the script first
computes a **structural fingerprint** — 8 `information_schema` queries, flat cost — and
compares it to the `-- Fingerprint: sha256:…` line in the header of the existing
`ref/database.sql`. Match → exit, file untouched (this also prevents diff churn from the
moving `-- Generated:` timestamp). Mismatch → full dump, 8 tables in flight at a time.

The fingerprint deliberately excludes volatile fields (AUTO_INCREMENT high-water mark,
TABLE_ROWS, UPDATE_TIME, DATA_LENGTH) so it only moves on real DDL.

### Commands
```
npm run db:ref                          regenerate if the schema changed
npm run db:ref -- --force               regenerate unconditionally
npm run db:ref -- --check               report drift, write nothing (exit 1 if stale)
npm run db:ref -- --timing              per-phase + per-query ms breakdown
SKIP_SCHEMA_DUMP=1 git commit …         skip the schema step for one commit
SCHEMA_DUMP_SYNC=1 git commit …         run it inline so the ref lands in THIS commit
                                        (use right after applying a migration)
```
A DB failure warns and exits 0 — commits made offline still go through.

### Known: ~4s to open a DB connection
`skip_name_resolve = OFF` on the MySQL host (`giowm1139.siteground.biz`, SiteGround
shared, MySQL 8.4.6), so the server does a reverse-DNS lookup of the client IP on every
new connection. From a laptop on a residential IP with no PTR record that lookup runs to
timeout: TCP connects in ~13ms, the handshake greeting arrives ~4s later. Not fixable from
our side on shared hosting — hence the background hook.

**Cloud Run is unaffected** — GCP egress IPs have valid PTR records, so the lookup
resolves instantly (verified: `admin_audit_log` shows ~77ms avg over 1351 `db_console`
calls, with only ~0.3% of calls over 3.5s). Do not "fix" `startup/db.js`'s
`idleTimeout: 60_000` on account of this.

Re-diagnose with `node scripts/probe-db-connect.js` (splits TCP time from greeting time;
its header comment explains how to read the output).

### Files
- `lib/schemaDump.js` — `buildSchemaDump`, `schemaFingerprint`, `parseCreateTable`,
  `FINGERPRINT_RE`. Shared by the CLI and by `routes/admin.dbConsole.js`
  (`GET /admin/db/schema.sql`, `POST /admin/db/schema/save-to-ref`) — the dump logic
  lives here now, not in the route.
- `scripts/dump-schema.js` — CLI / hook entry point
- `scripts/probe-db-connect.js` — connection-latency diagnostic
- `.githooks/pre-commit` — tracked hook (schema refresh + TRACKED_FILES.txt)

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
