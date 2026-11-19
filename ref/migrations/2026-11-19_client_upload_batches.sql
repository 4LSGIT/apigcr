-- ref/migrations/2026-11-19_client_upload_batches.sql
--
-- Docs intake S3 — per-file reporting + lost-batch recovery for the two
-- upload pages (public/docReq.html, public/portal/docs.html).
--
-- WHY: both pages PUT each file straight to Dropbox, then send ONE
-- upload-complete naming the files that made it. A tab or phone closed
-- mid-batch sent nothing: no notice, no `docs` log row, staff never heard
-- (Turner, 2026-07-28 — four files incl. the 2025 tax return sat in
-- Client Uploads/ unreported until a Dropbox listing in November).
--
-- THE MODEL: the page mints a batch key per upload run and reports each file
-- as it lands (POST …/upload-landed, fetch keepalive) — one row per run here,
-- the files appended. The server owns closure:
--   · the page's final upload-complete (with the key) closes it: its list is
--     merged with the landed list, the shared completion phase runs once
--     (services/clientUploadCompletionService), notified_at is stamped;
--   · a row nobody closed goes quiet — the /process-jobs tick's housekeeping
--     (services/clientUploadBatchService.sweepLostBatches) notices it ~10 min
--     after its last file and runs the same completion on what landed, the
--     notice saying the page closed early. The same sweep retries a row the
--     page closed whose completion never finished (instance died after the 200).
--   Exactly one completion per row: claimed_at is the claim (stale after
--   15 min), notified_at the done-stamp; both paths lock the row.
--
-- No FK to cases on purpose (a case can be merged or deleted; the batch row
-- is history) — same reasoning as mail_attachment_filings.
-- All DATETIMEs are UTC, written with UTC_TIMESTAMP() (never a session-zone
-- default).
--
-- Deploy order: this file (SU DB console, allowWrite; one statement, no
-- session setting; idempotent) → the code. The landed route needs the table.
-- Old page builds in the wild keep working: `batch` is optional everywhere.
--
-- After it runs: regenerate ref/database.sql (POST /admin/db/schema/save-to-ref
-- or the pre-commit hook), THEN add ['client_upload_batches', 'batch_key'] to
-- tests/schemaCollationBin.test.js BIN_COLUMNS (it lints the dump, which has no
-- such column until then).

CREATE TABLE IF NOT EXISTS client_upload_batches (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_key       VARCHAR(40)     CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'minted by the upload page once per run, ^[A-Za-z0-9_-]{16,40}$. utf8mb4_bin ON PURPOSE (case-sensitive key, the lib/token convention). Not a capability: source + case_id + contact_id must match on every call',
  source          ENUM('docreq','portal') NOT NULL COMMENT 'docreq = public/docReq.html; portal = public/portal/docs.html. App-validated (sql_mode is not strict)',
  case_id         VARCHAR(20)     NOT NULL COMMENT 'cases.case_id, canonical (no FK on purpose: a merged/deleted case keeps its batch history)',
  contact_id      INT UNSIGNED    DEFAULT NULL COMMENT 'portal: the authenticated uploader (contacts.contact_id); docreq: NULL (the public page does not know who)',
  comment         TEXT            COMMENT 'the last non-blank client note seen for the batch (landed calls and the final upload-complete)',
  files           MEDIUMTEXT      NOT NULL COMMENT 'JSON array [{name, item_id, item_name, landed_at}], one entry per landed call, capped at 200 (file_count keeps counting). The page''s close rewrites it as the merged list (landed first, then names only the page reported)',
  file_count      INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'files reported for the batch — keeps counting past the files cap',
  opened_at       DATETIME        NOT NULL COMMENT 'UTC. First landed call (or the close, when every landed call was lost)',
  last_landed_at  DATETIME        NOT NULL COMMENT 'UTC. The quiet clock: an unclosed row quiet for 10 min is swept as lost',
  closed_at       DATETIME        DEFAULT NULL COMMENT 'UTC. Set by the page''s upload-complete, or by the sweep when it claims a lost row. A closed row refuses further landed calls (the page mints a new key per run)',
  closed_by       ENUM('client','sweep') DEFAULT NULL COMMENT 'client = the page finished (its upload-complete arrived); sweep = the page never finished — the notice says so',
  claimed_at      DATETIME        DEFAULT NULL COMMENT 'UTC. The completion claim (page close or sweep); older than 15 min without notified_at = the claimer died, re-claimable by the sweep',
  notified_at     DATETIME        DEFAULT NULL COMMENT 'UTC. The completion phase ran (notice + `docs` log row) — the exactly-once guard',
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_upload_batch_key (batch_key),
  KEY idx_client_upload_batch_sweep (notified_at, closed_at, last_landed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Upload-page batches (docs intake S3): files reported as they land, closed by the page or swept as lost after 10 quiet minutes — one completion (notice + docs log row) per row. services/clientUploadBatchService';
