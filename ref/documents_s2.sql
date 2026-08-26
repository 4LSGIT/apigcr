-- ─────────────────────────────────────────────────────────────────────────
-- YisraCase — Documents feature, Slice S2 (sync engine + attribution)
-- Apply BEFORE deploying the backend. Deploy order: SQL → backend → (no FE
-- beyond one ordering array in public/automation/fnPicker.js, which ships
-- with the backend deploy).
--
-- SAFE TO APPLY BEFORE THE DEPLOY: nothing running today reads these columns
-- or this table, and the kill switch below ships OFF, so applying this on a
-- pre-S2 build changes no behavior at all.
--
-- After applying, regenerate the committed schema dump:
--     npm run db:ref
-- tests/schemaConventions.test.js lints ref/database.sql for collation drift
-- and is only as current as that dump.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. case_folder_cache ────────────────────────────────────────────────
--
-- case → Dropbox folder, resolved from the shared link in cases.case_dropbox
-- (1009 of 1077 cases have one). This is the attribution table: a document
-- whose path sits under a case's folder belongs to that case.
--
-- Why cached rather than resolved on demand: each row costs a
-- sharing/get_shared_link_metadata API call. Resolving 1009 of them per sync
-- tick is not an option, and the answer changes rarely — and when it does
-- change (a folder moves), the sync's own folder-delta handling heals the
-- row for free, with no API call.
--
-- COLLATE is EXPLICIT on purpose. `DEFAULT CHARSET=utf8mb4` with no COLLATE
-- does NOT inherit the schema default on MySQL 8 — it falls back to
-- utf8mb4_0900_ai_ci, and case_id would then refuse to join `cases`
-- (ER_CANT_AGGREGATE_2COLLATIONS). Latent for months, because a bound
-- literal never errors; only column-to-column joins do.
--
-- path_lower / path_display are TEXT, NOT VARCHAR, for the same reason
-- documents.path is: a deep case folder path passes 512 chars routinely, and
-- this schema has no STRICT_TRANS_TABLES, so an over-length VARCHAR write
-- would TRUNCATE SILENTLY — producing a path prefix that still matches
-- files, just the wrong ones.
CREATE TABLE case_folder_cache (
  case_id VARCHAR(20) NOT NULL,
  folder_external_id VARCHAR(191) NULL,
  path_lower TEXT NULL,
  path_display TEXT NULL,
  resolve_error VARCHAR(255) NULL,
  resolved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (case_id),
  KEY idx_cfc_ext (folder_external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ── 2. document_sync_roots: claim + observability ───────────────────────
--
-- syncing_since — the concurrency claim. Poll ticks overlap and
--   documents_sync is hand-callable, so syncRoot takes a root with a
--   conditional UPDATE (syncing_since IS NULL OR older than 15 min) before
--   touching it. A claim older than the window is treated as abandoned.
-- stats — the last run's counters as JSON {mode,pages,files,linked,deleted,
--   folder_heals,stop,ms}. This is how you watch an 80-page backfill
--   progress across ticks without reading logs.
ALTER TABLE document_sync_roots
  ADD COLUMN syncing_since DATETIME NULL AFTER enabled,
  ADD COLUMN stats JSON NULL AFTER last_error;

-- ── 3. Kill switch ──────────────────────────────────────────────────────
--
-- FAIL-CLOSED: absent, blank, or anything other than the exact string '1'
-- means the engine does not run. Ships as '0' so the deploy is inert and the
-- switch is flipped deliberately, after the cache smoke (see the runbook).
--
-- Read through services/settingsService.getSetting — an UNCACHED read, per
-- invocation, NOT through lib/firmConfig like cloud_tasks_enabled. firmConfig
-- caches for 60s, which would mean writing '0' to stop a runaway backfill
-- keeps syncing for up to a minute per Cloud Run instance. Consequence for
-- you: unlike cloud_tasks_enabled, blank does NOT fall through to an env var
-- here — blank simply means off, and there is no DOCUMENTS_SYNC_ENABLED env.
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES (
  'documents_sync_enabled', '0', 0, 1, 'Dropbox', 'Documents Sync Engine',
  '1 = the Dropbox → documents sync runs (backfill, incremental delta, and case attribution). Anything else, including blank or a missing row, = OFF. Takes effect on the next job tick — this key is read uncached, unlike the Cloud Tasks switch. Turning it off mid-backfill is safe: the cursor stays where it is and the walk resumes when you turn it back on.',
  'bool', 30
)
ON DUPLICATE KEY UPDATE `key` = `key`;   -- never clobber an existing value

-- ── 4. Recurring jobs ───────────────────────────────────────────────────
--
-- Column set and data shape derived from the LIVE row for job 3555 ("Stage
-- Aged Emitter"), not from the prompt:
--   type='recurring', status='pending', active=1,
--   data={"type":"internal_function","function_name":"...","params":{}},
--   recurrence_rule = 5-field cron, max_attempts=3, backoff_seconds=300.
-- scheduled_time is the CRON ANCHOR — routes/process_jobs.js parses the rule
-- with currentDate = scheduled_time and takes .next(). NOW() therefore means
-- "due immediately", which is harmless: with the kill switch at '0' both
-- functions return {skipped:true} and touch nothing.
--
-- Both are idempotent by name; re-running this block would create duplicates,
-- so check first:
--   SELECT id, name FROM scheduled_jobs WHERE name LIKE 'Documents %';

INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds)
VALUES (
  'recurring', NOW(), 'pending', 1,
  'Documents Sync',
  'One bounded increment of the Dropbox → documents sync. Walks enabled sync roots under a shared 25-page budget (oldest-synced first), registers files, links them to cases by folder path, then runs the reconcile sweep. Roots with no cursor run in BACKFILL mode (bulk writes, NO domain events); roots with a cursor run INCREMENTAL (per-row, events on). The ~150k-file backfill completes across successive runs. Gated on app_settings documents_sync_enabled. Params editable in data.params: max_pages, sweep, root_id.',
  '{"type":"internal_function","function_name":"documents_sync","params":{}}',
  '*/10 * * * *', 3, 300
);

INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds)
VALUES (
  'recurring', NOW(), 'pending', 1,
  'Documents Case Folder Cache',
  'Resolves cases.case_dropbox shared links into case_folder_cache so the sync can attribute documents to cases by path. 300 cases per run, oldest-resolved first. Runs on a slow schedule because each row is a Dropbox API call and case folders move rarely — and the sync heals moved folders for free from the delta feed. job_results carries out_of_root: cases whose folder sits under no enabled sync root, whose documents would therefore never register. Gated on app_settings documents_sync_enabled. Params editable in data.params: limit.',
  '{"type":"internal_function","function_name":"documents_refresh_case_cache","params":{}}',
  '0 */4 * * *', 3, 300
);

-- ── Verify ──────────────────────────────────────────────────────────────
-- SELECT id, name, recurrence_rule, scheduled_time, active,
--        JSON_UNQUOTE(JSON_EXTRACT(data,'$.function_name')) AS fn
--   FROM scheduled_jobs WHERE name LIKE 'Documents %';
-- SHOW COLUMNS FROM document_sync_roots LIKE 'sync%';
-- SELECT `key`, `value` FROM app_settings WHERE `key` = 'documents_sync_enabled';
