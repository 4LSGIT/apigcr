-- 2026-10-07 — CTA (Call To Action) substrate — CTA arc, slice S1
--
-- Spec: ref/CTA_DESIGN.md §3 (tables), §6 (claim semantics), §2.10 (sweep).
-- Code: services/ctaService.js, lib/internal_functions/cta.js
--       (cta_expiry_sweep).
--
-- Order: apply BEFORE the S1 backend deploy (SQL → backend → frontend).
-- The S1 backend only references these tables from the sweep and the
-- service (no routes until S2), and the sweep job row below names a
-- function that exists only after the backend deploys — if the job fires
-- first it fails with "Unknown internal function" and simply reschedules
-- (max_attempts 1, recurring). Harmless either way; the order is the
-- convention.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS, INSERT IGNORE for the settings
-- (an edited value is never clobbered), and the job seed is guarded by
-- NOT EXISTS on its idempotency_key. No session variables anywhere (the
-- console runner uses separate connections).
--
-- After applying: npm run db:ref (or let the pre-commit hook do it). Then
-- add ['cta_links', 'token'] to BIN_COLUMNS in
-- tests/schemaCollationBin.test.js — it lints the regenerated dump.
--
-- Standing rule (R3): cta_links / cta_executions NEVER enter
-- QUERY_DB_ALLOWED_TABLES or WRITE_POLICY. Tokens are plaintext bearers and
-- plan_result carries raw function output.

-- ── A. cta_links ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cta_links (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token         VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
                COMMENT 'CTA bearer (/c/<t>); 22-char base62 via lib/token; _bin: case-sensitive',
  name          VARCHAR(120) NOT NULL
                COMMENT 'internal label (SU list); never shown publicly',
  prompt        TEXT NOT NULL
                COMMENT 'shown to the recipient; ESCAPED text — context_html is the only raw-HTML slot',
  context_html  MEDIUMTEXT NULL
                COMMENT 'TRUSTED HTML, same contract as decision_requests.context_html',
  options       JSON NOT NULL
                COMMENT '[{value,label,plan:[{fn,params}],confirm_text?,result_template?}] 1-10; value "respond" reserved; params frozen literals (no {{...}}, no _-prefixed keys)',
  mode          ENUM('once','repeatable') NOT NULL DEFAULT 'once'
                COMMENT 'app-validated too (relaxed sql_mode)',
  max_uses      INT UNSIGNED NULL
                COMMENT 'repeatable only; NULL = until expiry',
  uses_count    INT UNSIGNED NOT NULL DEFAULT 0
                COMMENT 'once: 0|1 (the claim sets 1); repeatable: guarded increment; reset to 0 by re-enable from used (else the timeout claim is dead)',
  expires_at    DATETIME NOT NULL
                COMMENT 'UTC; always set, <=365d out. expired is DERIVED from this, never stored in status',
  timeout_option VARCHAR(64) NULL
                COMMENT 'once only: option value auto-run at expiry if unused (cta_expiry_sweep claims first)',
  protection    ENUM('none','password') NOT NULL DEFAULT 'none',
  password_hash VARCHAR(100) NULL
                COMMENT 'bcrypt, BCRYPT_ROUNDS=12; never a user password',
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0
                COMMENT 'cumulative wrong passwords; alerts at 20 (warning) / 100 (error); never auto-disables',
  return_plan_result TINYINT NOT NULL DEFAULT 0
                COMMENT 'JSON respond surface may include raw plan_result (agent mints)',
  attributed_user_id INT NULL
                COMMENT 'log attribution for link/password responses (assertion by mint, not authentication); never used by timeout executions',
  status        ENUM('active','used','disabled','cancelled') NOT NULL DEFAULT 'active'
                COMMENT 'used = once claimed; disabled = PATCH, reversible; cancelled = permanent (R8). expired/exhausted are derived, never stored',
  mint_source   ENUM('su','workflow') NOT NULL DEFAULT 'su'
                COMMENT 'su: click-time check that minted_by is still an active SU (B1); workflow: no SU check',
  source_execution_id BIGINT UNSIGNED NULL
                COMMENT 'workflow mints: the minting execution',
  minted_by     INT NOT NULL
                COMMENT 'users.user of the minting SU; 0 for workflow mints',
  link_type     VARCHAR(20) NULL
                COMMENT 'logService ABOUT_TYPES value set (log_link_type family), app-validated',
  link_id       VARCHAR(255) NULL
                COMMENT 'normalized like log about-links (phone 10 digits, email lowercased)',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cta_token (token),
  KEY idx_cta_status_expires (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='CTA links (ref/CTA_DESIGN.md). Never add to QUERY_DB_ALLOWED_TABLES / WRITE_POLICY (R3)';

-- ── B. cta_executions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cta_executions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cta_id        BIGINT UNSIGNED NOT NULL,
  option_value  VARCHAR(64) NOT NULL,
  status        ENUM('running','success','failed') NOT NULL DEFAULT 'running'
                COMMENT 'inserted running (same transaction as the claim) BEFORE step 1; running older than 15 min = crashed plan (sweep warns)',
  plan_result   JSON NULL
                COMMENT 'per-step [{fn, ok, output|error, ms}], outputs truncated ~2k/step; readable via RO keys - redact accordingly',
  responded_via ENUM('link','app','api','timeout') NOT NULL,
  responder_user_id INT NULL,
  responder_ip  VARCHAR(45) NULL,
  executed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ctaexec_cta (cta_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='One row per CTA plan run. Never add to QUERY_DB_ALLOWED_TABLES / WRITE_POLICY (R3)';

-- ── C. Default-expiry settings ──────────────────────────────────────────────
-- Read by ctaService at mint when neither expires_at nor timeout is given.
-- ms() durations; an unparseable value falls back to the shipped default.
INSERT IGNORE INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES
  ('cta_default_timeout_once', '3d', 0, 1, 'Automations',
   'CTA default expiry (single-use)',
   'Expiry for a single-use (mode=once) CTA link minted without an explicit expiry. Duration like 30m, 12h, 3d, 2w. Max 365d.',
   'string', 70),
  ('cta_default_timeout_repeatable', '30d', 0, 1, 'Automations',
   'CTA default expiry (repeatable)',
   'Expiry for a repeatable CTA link minted without an explicit expiry. Duration like 12h, 30d, 26w. Max 365d.',
   'string', 71);

-- ── D. Recurring expiry sweep ───────────────────────────────────────────────
-- Shape copied from the live "Error Alert Sweep" row (id 867): internal
-- function data, max_attempts 1 (an idempotent sweep re-runs next tick —
-- no retry ladder), backoff 300. Every 5 min. Claims due timeout_option
-- rows before running their plan; warns on running executions > 15 min.
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'CTA Expiry Sweep',
       'Runs timeout_option plans of expired single-use CTA links (claim-first, so overlapping runs are benign) and warns on CTA executions stuck in running > 15 min. ref/CTA_DESIGN.md §6.',
       '{"type": "internal_function", "params": {}, "function_name": "cta_expiry_sweep"}',
       '*/5 * * * *', 1, 300, 'cta_expiry_sweep'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'cta_expiry_sweep');
