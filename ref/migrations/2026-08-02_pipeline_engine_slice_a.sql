-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-02 — Case Pipeline Engine, SLICE A: schema + dormant seed
--
-- WHY
--   Foundation for the Pipeline Engine: named, ordered stage sequences per
--   case type/subtype. Stages map to the existing cases.case_stage enum and
--   supply the human labels that will eventually WRITE cases.case_status
--   (stage labels become the status vocabulary) and suggest case_rec. This
--   slice is DATA ONLY — three new tables plus three seeded templates.
--
--   * pipeline_templates — one row per pipeline (Intake, BK Ch7, BK Ch13, …).
--                          role='intake' pipelines run pre-retention;
--                          role='case' pipelines run per case type/subtype.
--   * pipeline_stages    — ordered stages within a template. stage_key is
--                          stable machine id (unique per template);
--                          internal_label = staff-facing; client_label =
--                          portal-facing (client_visible gates it);
--                          case_stage = which coarse enum bucket the stage
--                          maps onto; default_rec = suggested next action.
--   * case_stage_log     — append-only history of stage entries per case.
--                          Written by nothing yet (Slice B adds the writer).
--                          entered_by = users.user (tinyint). template_id /
--                          stage_id nullable so imports/backfills of
--                          pre-pipeline history can log with stage_key only.
--
-- ── DORMANT BY DESIGN ────────────────────────────────────────────────────────
-- NO app code reads or writes these tables yet. No existing table or column
-- is touched. Running this changes zero behavior. Slice B ships the engine.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run whenever — nothing depends on it. (SQL-first is the inert direction.)
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS + seeds guarded by WHERE NOT EXISTS
-- (templates keyed by name; stage blocks skipped when the template already
-- has any stages). Safe to re-run; re-running never duplicates or touches data.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- utf8mb4_general_ci to match the dominant repo convention and, critically,
-- the cases table (case_stage_log.case_id will join cases.case_id — same
-- collation avoids join coercion). No FK constraints (repo convention:
-- FK-by-convention only). No reliance on STRICT_TRANS_TABLES.
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (ref/database.sql is auto-generated —
-- do not hand-edit it).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DROP TABLE case_stage_log, pipeline_stages, pipeline_templates;
-- ─────────────────────────────────────────────────────────────────────────────


-- ── DDL ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_templates (
  id            int unsigned NOT NULL AUTO_INCREMENT,
  name          varchar(100) NOT NULL,
  case_type     varchar(40)  NOT NULL DEFAULT '',
  case_subtype  varchar(40)  NOT NULL DEFAULT '',
  role          enum('intake','case') NOT NULL DEFAULT 'case',
  is_default    tinyint(1)   NOT NULL DEFAULT 0,
  description   text         NULL,
  active        tinyint(1)   NOT NULL DEFAULT 1,
  created_at    datetime     DEFAULT CURRENT_TIMESTAMP,
  updated_at    datetime     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_type_subtype (case_type, case_subtype),
  KEY idx_role_active  (role, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id             int unsigned NOT NULL AUTO_INCREMENT,
  template_id    int unsigned NOT NULL,
  stage_number   int          NOT NULL,
  stage_key      varchar(50)  NOT NULL,
  internal_label varchar(100) NOT NULL,
  client_label   varchar(100) NULL,
  case_stage     enum('Open','Pending','Filed','Concluded','Closed') NOT NULL,
  client_visible tinyint(1)   NOT NULL DEFAULT 1,
  is_terminal    tinyint(1)   NOT NULL DEFAULT 0,
  default_rec    varchar(128) NOT NULL DEFAULT '',
  config         json         NULL,
  active         tinyint(1)   NOT NULL DEFAULT 1,
  created_at     datetime     DEFAULT CURRENT_TIMESTAMP,
  updated_at     datetime     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_key (template_id, stage_key),
  KEY idx_template_order (template_id, stage_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS case_stage_log (
  id           bigint unsigned NOT NULL AUTO_INCREMENT,
  case_id      varchar(20)  NOT NULL,
  template_id  int unsigned NULL,
  stage_id     int unsigned NULL,
  stage_key    varchar(50)  NOT NULL,
  case_stage   enum('Open','Pending','Filed','Concluded','Closed') NOT NULL,
  status_label varchar(100) NOT NULL DEFAULT '',
  entered_at   datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  entered_by   tinyint      NULL,
  source       enum('manual','system','import') NOT NULL DEFAULT 'manual',
  note         varchar(255) NULL,
  PRIMARY KEY (id),
  KEY idx_case_time (case_id, entered_at),
  KEY idx_stage (stage_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ── SEED: templates (guarded by name — rerun is a no-op) ─────────────────────

INSERT INTO pipeline_templates (name, case_type, case_subtype, role, is_default, description, active)
SELECT 'Intake', '', '', 'intake', 0, NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM pipeline_templates WHERE name = 'Intake');

INSERT INTO pipeline_templates (name, case_type, case_subtype, role, is_default, description, active)
SELECT 'Bankruptcy — Chapter 7', 'Bankruptcy', 'Chapter 7', 'case', 0, NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM pipeline_templates WHERE name = 'Bankruptcy — Chapter 7');

INSERT INTO pipeline_templates (name, case_type, case_subtype, role, is_default, description, active)
SELECT 'Bankruptcy — Chapter 13', 'Bankruptcy', 'Chapter 13', 'case', 0, NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM pipeline_templates WHERE name = 'Bankruptcy — Chapter 13');

SET @tpl_intake = (SELECT id FROM pipeline_templates WHERE name = 'Intake'                  ORDER BY id LIMIT 1);
SET @tpl_ch7    = (SELECT id FROM pipeline_templates WHERE name = 'Bankruptcy — Chapter 7'  ORDER BY id LIMIT 1);
SET @tpl_ch13   = (SELECT id FROM pipeline_templates WHERE name = 'Bankruptcy — Chapter 13' ORDER BY id LIMIT 1);


-- ── SEED: Intake stages (4) ──────────────────────────────────────────────────
-- Block skipped entirely if the template already has any stages.

INSERT INTO pipeline_stages
  (template_id, stage_number, stage_key, internal_label, client_label, case_stage, client_visible, is_terminal, default_rec, config)
SELECT * FROM (
  SELECT @tpl_intake AS template_id, 1 AS stage_number, 'lead' AS stage_key,
         'Lead' AS internal_label, 'Inquiry received' AS client_label,
         'Open' AS case_stage, 1 AS client_visible, 0 AS is_terminal,
         'Book consultation' AS default_rec, NULL AS config
  UNION ALL
  SELECT @tpl_intake, 2, 'consult_booked', 'Consult Booked', 'Consultation scheduled',
         'Open', 1, 0, 'Hold consultation', NULL
  UNION ALL
  SELECT @tpl_intake, 3, 'consult_held', 'Consult Held', 'We''ve met with you',
         'Open', 1, 0, 'Send retainer', NULL
  UNION ALL
  SELECT @tpl_intake, 4, 'retained', 'Retained', 'You''ve retained us',
         'Pending', 1, 0, 'Assign chapter; collect documents', NULL
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE template_id = @tpl_intake);


-- ── SEED: Bankruptcy — Chapter 7 stages (5) ──────────────────────────────────

INSERT INTO pipeline_stages
  (template_id, stage_number, stage_key, internal_label, client_label, case_stage, client_visible, is_terminal, default_rec, config)
SELECT * FROM (
  SELECT @tpl_ch7 AS template_id, 1 AS stage_number, 'docs' AS stage_key,
         'Documents & Prep' AS internal_label, 'Preparing your case' AS client_label,
         'Pending' AS case_stage, 1 AS client_visible, 0 AS is_terminal,
         'Complete schedules & matrix' AS default_rec, NULL AS config
  UNION ALL
  SELECT @tpl_ch7, 2, 'filed', 'Filed', 'Your case is filed',
         'Filed', 1, 0, 'Sign post-petition contract (if appl.); 2nd course', NULL
  UNION ALL
  SELECT @tpl_ch7, 3, 'meeting_341', '341 Meeting', 'Meeting of creditors',
         'Filed', 1, 0, 'Attend 341; provide requested docs', NULL
  UNION ALL
  SELECT @tpl_ch7, 4, 'discharge', 'Discharge', 'Discharge entered',
         'Concluded', 1, 0, 'Await closing', NULL
  UNION ALL
  SELECT @tpl_ch7, 5, 'closed', 'Closed', 'Case closed',
         'Closed', 1, 1, '', NULL
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE template_id = @tpl_ch7);


-- ── SEED: Bankruptcy — Chapter 13 stages (7) ─────────────────────────────────

INSERT INTO pipeline_stages
  (template_id, stage_number, stage_key, internal_label, client_label, case_stage, client_visible, is_terminal, default_rec, config)
SELECT * FROM (
  SELECT @tpl_ch13 AS template_id, 1 AS stage_number, 'docs' AS stage_key,
         'Documents & Prep' AS internal_label, 'Preparing your case' AS client_label,
         'Pending' AS case_stage, 1 AS client_visible, 0 AS is_terminal,
         'Complete schedules & plan' AS default_rec, NULL AS config
  UNION ALL
  SELECT @tpl_ch13, 2, 'filed', 'Filed', 'Your case is filed',
         'Filed', 1, 0, 'Prepare for 341', NULL
  UNION ALL
  SELECT @tpl_ch13, 3, 'meeting_341', '341 Meeting', 'Meeting of creditors',
         'Filed', 1, 0, 'Attend 341; provide requested docs', NULL
  UNION ALL
  SELECT @tpl_ch13, 4, 'plan_confirmation', 'Plan Confirmation', 'Repayment plan confirmation',
         'Filed', 1, 0, 'Resolve objections; confirm plan', NULL
  UNION ALL
  SELECT @tpl_ch13, 5, 'plan_payments', 'Plan Payments', 'Making plan payments',
         'Filed', 1, 0, 'Continue payments; complete 2nd course', NULL
  UNION ALL
  SELECT @tpl_ch13, 6, 'discharge', 'Discharge', 'Discharge entered',
         'Concluded', 1, 0, 'Await closing', NULL
  UNION ALL
  SELECT @tpl_ch13, 7, 'closed', 'Closed', 'Case closed',
         'Closed', 1, 1, '', NULL
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE template_id = @tpl_ch13);
