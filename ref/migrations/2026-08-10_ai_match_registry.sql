-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-10 — Court Email Pipeline v2, SLICE 0: AI match registry + ignore seed
--
-- WHY
--   v1's court extraction asks the model to INVENT free-text labels
--   (25 distinct event_type values over ~135 rows) and hardcodes every
--   behavioural twist in courtExecutor.js. v2 inverts it: the model only ever
--   SELECTS a key from a closed, DB-stored list; everything behavioural is a
--   registry column. See ref/COURT_PIPELINE_V2_DESIGN.md.
--
--   The registry is GENERIC (Q1 decision: option A). The extraction machinery
--   — prompt generation, shape validation, citation verification — is
--   set-agnostic; court-only policy lives in a sidecar:
--
--   * ai_match_sets      — one row per consumer ("match set"). court_nef is
--                          the first; "client email actions" would be a second.
--                          `version` is bumped on any type edit and stamped
--                          into the generated prompt + ai_calls consumer_ref.
--   * ai_match_types     — one row per recognisable thing. `type_key` is the
--                          ONLY string the model ever emits — supplied as a
--                          closed list, validated on the way out, so casing
--                          cannot drift. `item_type` + `verb` power stage-6
--                          reconciliation (a cancellation finds the scheduled
--                          item it acts on) without the model typing either.
--                          `subject_match` = literal doc-name patterns for the
--                          future deterministic pre-filter (data only in this
--                          slice; no matcher code ships yet).
--                          `fields` = per-key declared slots:
--                            [{"name","required","type":"date|time|text",
--                              "citable":true,"maps_to":null}, ...]
--   * court_item_policy  — court-only columns from SS's worksheet (storage /
--                          attendance / blocks / calendar). Created EMPTY —
--                          Fred is collecting the answers separately.
--   * court_item_reminders — 0..n reminder tasks per type (replaces the single
--                          hardcoded show-cause task). Created EMPTY.
--
-- SUBJECT_MATCH CONTRACT (for the later pre-filter slice — documented here so
-- the seeded data is unambiguous):
--   MIEB subjects are `<docket> "<doc-name>" Ch <n?>`. Strip the leading
--   docket token and trailing `Ch …`, extract the quoted doc-name (or the
--   remainder verbatim when unquoted). Each subject_match entry then matches
--   (a) EXACTLY against that doc-name, or (b) as a PREFIX when the entry is
--   written `@prefix:<literal>`. Case-sensitive. First matching type wins;
--   two types matching one subject is a seed bug.
--
-- ── DORMANT BY DESIGN ────────────────────────────────────────────────────────
-- NO app code reads or writes these tables yet (the ai_match internal function
-- ships in the same deploy but is only invoked by workflows that don't exist
-- yet). The live court_extract path is untouched. Running this changes zero
-- behavior.
--
-- ── SEED ─────────────────────────────────────────────────────────────────────
-- 42 disposition='ignore' rows covering the recognised-noise doc-names in the
-- court_emails2 corpus: 2,036 of 3,492 historical emails (58.3%). Measured, not
-- estimated. Act rows are NOT seeded — they are gated on SS's policy worksheet.
-- A commented template shows the intended act-row shape.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS + seeds guarded by NOT EXISTS on (set, type_key).
-- Safe to re-run.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS court_item_reminders;
--   DROP TABLE IF EXISTS court_item_policy;
--   DROP TABLE IF EXISTS ai_match_types;
--   DROP TABLE IF EXISTS ai_match_sets;
-- (Order matters: children first. Nothing else references these tables.)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_match_sets (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  set_key     VARCHAR(60)  NOT NULL,
  label       VARCHAR(120) NULL,
  description TEXT NULL,
  -- Set-level context prepended to the generated prompt (e.g. "These are
  -- CM/ECF Notices of Electronic Filing from a U.S. Bankruptcy Court…").
  prompt_preamble TEXT NULL,
  -- Bumped on ANY type change under this set; stamped into the generated
  -- prompt and the ai_calls consumer_ref so extractions are attributable to a
  -- registry state.
  version     INT UNSIGNED NOT NULL DEFAULT 1,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_set_key (set_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ai_match_types (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  set_id      INT UNSIGNED NOT NULL,
  -- THE closed vocabulary. The only string the model emits; validated against
  -- this column on the way out of every extraction.
  type_key    VARCHAR(60)  NOT NULL,
  label       VARCHAR(120) NULL,
  disposition ENUM('act','ignore','out_of_scope') NOT NULL DEFAULT 'ignore',
  -- Reconciliation axes (stage 6). Never typed by the model — looked up from
  -- the matched key. item_type: what prior-item matching keys on
  -- ('show_cause_hearing'); verb: what this key DOES to it.
  item_type   VARCHAR(60)  NULL,
  verb        ENUM('scheduled','rescheduled','cancelled','occurred','status_changed') NULL,
  -- Deterministic pre-filter literals (see SUBJECT_MATCH CONTRACT above).
  -- JSON array of strings. Data-only in this slice.
  subject_match     JSON NULL,
  -- Free-text hints fed to the GENERATED PROMPT ("Order to Show Cause
  -- Dissolved", "Disposition: Fee Paid"). Prompt-facing, not matcher-facing.
  recognition_hints JSON NULL,
  -- Declared field slots for 'act' keys:
  --   [{"name":"date","required":true,"type":"date","citable":true,
  --     "maps_to":"event.event_date"}, ...]
  -- type ∈ date|time|text. citable defaults true; false exempts the field
  -- from citation verification (composed labels/constants).
  fields      JSON NULL,
  -- 7 deadlines sharing one date → one item (Notice of Missing Documents).
  collapse_same_date TINYINT(1) NOT NULL DEFAULT 0,
  -- Routing target for stage 7. NULL = no route yet (logged, not dispatched).
  workflow_id INT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  notes       TEXT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_set_type (set_id, type_key),
  KEY idx_set_disposition (set_id, disposition),
  CONSTRAINT fk_amt_set FOREIGN KEY (set_id) REFERENCES ai_match_sets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Court-only policy sidecar (SS worksheet). 1:1 with an ai_match_types row.
-- Created EMPTY — do not populate in this slice.
CREATE TABLE IF NOT EXISTS court_item_policy (
  type_id    INT UNSIGNED NOT NULL,
  storage    ENUM('appt','event','none') NULL,
  attendance ENUM('none','ss','ss_client','client','staff') NULL,
  blocks     ENUM('none','ss','firm') NULL,
  calendar   ENUM('ss','firm','none') NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (type_id),
  CONSTRAINT fk_cip_type FOREIGN KEY (type_id) REFERENCES ai_match_types (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 0..n reminder tasks per type (replaces the single hardcoded show-cause
-- task). Created EMPTY — do not populate in this slice.
CREATE TABLE IF NOT EXISTS court_item_reminders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type_id        INT UNSIGNED NOT NULL,
  -- users.user id; NULL = resolve via app_settings at run time (the
  -- billing_tasks_to pattern the show-cause task uses today).
  assignee       INT NULL,
  lead_days      INT NOT NULL DEFAULT 7,
  title_template VARCHAR(255) NULL,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_cir_type (type_id),
  CONSTRAINT fk_cir_type FOREIGN KEY (type_id) REFERENCES ai_match_types (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ── SEED: the court_nef set ─────────────────────────────────────────────────
INSERT INTO ai_match_sets (set_key, label, description, prompt_preamble)
SELECT 'court_nef', 'MIEB/MIWB court NEF emails',
       'CM/ECF Notices of Electronic Filing from the U.S. Bankruptcy Courts for the Eastern and Western Districts of Michigan. One email per docket event; the operative content is the Docket Text block.',
       'Each email is a CM/ECF Notice of Electronic Filing (NEF) from a U.S. Bankruptcy Court (Eastern or Western District of Michigan). Emails may concern main bankruptcy cases OR adversary proceedings (captioned "Plaintiff v. Defendant"). The operative content is the "Docket Text:" block; the NEF header''s "entered on" / "filed on" date is the filing date of THAT document, not the case.'
 WHERE NOT EXISTS (SELECT 1 FROM ai_match_sets WHERE set_key='court_nef');

-- ── SEED: act-row TEMPLATE (commented — DO NOT run; gated on SS worksheet) ──
-- INSERT INTO ai_match_types
--   (set_id, type_key, label, disposition, item_type, verb, subject_match,
--    recognition_hints, fields, collapse_same_date, workflow_id, notes)
-- SELECT id, '341_scheduled_ch7', 'Ch7 §341 meeting scheduled', 'act',
--        '341_meeting', 'scheduled',
--        '["Meeting (Chapter 7)"]',
--        '["Notice of Chapter 7 Bankruptcy Case, Meeting of Creditors","341(a) meeting to be held on"]',
--        '[{"name":"date","required":true,"type":"date"},
--          {"name":"time","required":true,"type":"time"},
--          {"name":"trustee","required":false,"type":"text"},
--          {"name":"platform","required":false,"type":"text"},
--          {"name":"connection_info","required":false,"type":"text"},
--          {"name":"objection_deadline","required":false,"type":"date","maps_to":"cases.case_objection"}]',
--        0, NULL, 'Fields land per maps_to; appt creation policy comes from court_item_policy.'
--   FROM ai_match_sets WHERE set_key='court_nef';

-- ── SEED: 42 disposition='ignore' rows (measured: silences 2,036/3,492) ─────
INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'bnc_certificate_of_mailing', 'BNC certificate of mailing', 'ignore', '["BNC Certificate of Mailing", "BNC Certificate of Mailing - Meeting of Creditors", "BNC Certificate of Mailing - Order of Discharge", "BNC Certificate of Mailing - Notice of Hearing", "BNC Certificate of Mailing - Notice of Adjourned Hearing"]', '["BNC Certificate of Mailing", "BNC Certificate of Mailing - Meeting of Creditors", "BNC Certificate of Mailing - Order of Discharge", "BNC Certificate of Mailing - Notice of Hearing", "BNC Certificate of Mailing - Notice of Adjourned Hearing"]', 'Bankruptcy Noticing Center mailing receipts. Pure service artifacts; the underlying order/notice arrives as its own NEF.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='bnc_certificate_of_mailing');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'proof_of_claim_prefix', 'Proof-of-claim docket activity', 'ignore', '["@prefix:of Claim ", "@prefix:Proof of Claim"]', '["of Claim ", "Proof of Claim"]', 'Claims register traffic (filed/amended claims). No firm deadline.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='proof_of_claim_prefix');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'proof_of_claim_activity', 'Claim withdrawals / transfers', 'ignore', '["Withdrawal of Claim", "Notice of Claim Filed", "Transfer of Claim", "Satisfaction of Claim", "Notice of Withdrawal of Objection to Claim"]', '["Withdrawal of Claim", "Notice of Claim Filed", "Transfer of Claim", "Satisfaction of Claim", "Notice of Withdrawal of Objection to Claim"]', 'Claims register housekeeping.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='proof_of_claim_activity');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'certificate_of_service', 'Certificate of service', 'ignore', '["Certificate of Service", "Certificate of Service (batch)", "Certificate of No Response(batch)"]', '["Certificate of Service", "Certificate of Service (batch)", "Certificate of No Response(batch)"]', 'Service certificates, incl. batch. No action.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='certificate_of_service');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'credit_counseling_certificate', 'Credit counseling certificate', 'ignore', '["Certificate of Budget and Credit Counseling Course"]', '["Certificate of Budget and Credit Counseling Course"]', 'Our own pre-filing certificate landing on the docket.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='credit_counseling_certificate');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'bankruptcy_cover_sheet', 'Cover sheets', 'ignore', '["Bankruptcy Cover Sheet", "Bankruptcy Matter Civil Cover Sheet"]', '["Bankruptcy Cover Sheet", "Bankruptcy Matter Civil Cover Sheet"]', 'Filing cover sheets.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='bankruptcy_cover_sheet');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'summary_assets_liabilities', 'Summary of assets & liabilities', 'ignore', '["Summary of Assets and Liabilities"]', '["Summary of Assets and Liabilities"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='summary_assets_liabilities');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'ssn_statement', 'SSN statement', 'ignore', '["Statement About Your Social Security Numbers"]', '["Statement About Your Social Security Numbers"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='ssn_statement');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'flags_set_casechecked', 'CASECHECKED flag', 'ignore', '["Flags Set CASECHECKED"]', '["Flags Set CASECHECKED"]', 'Clerk workflow flag; administrative only.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='flags_set_casechecked');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'statement_financial_affairs', 'Statement of financial affairs', 'ignore', '["Statement of Financial Affairs"]', '["Statement of Financial Affairs"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='statement_financial_affairs');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'fee_installment_application', 'Fee installment application (filed)', 'ignore', '["Application for Individuals to Pay the Filing Fee in Installments"]', '["Application for Individuals to Pay the Filing Fee in Installments"]', 'Our own application. The ORDER on it is NOT seeded — it can carry installment deadlines.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='fee_installment_application');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'schedules_aj_filed', 'Schedules A-J (filed)', 'ignore', '["Schedules A-J"]', '["Schedules A-J"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='schedules_aj_filed');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'attorney_statement_2016b', '2016(b) attorney statement', 'ignore', '["Statement of Attorney for Debtor(s) Pursuant to F.R.Bankr.P.2016(b)"]', '["Statement of Attorney for Debtor(s) Pursuant to F.R.Bankr.P.2016(b)"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='attorney_statement_2016b');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'blank_docket_text', 'Blank docket-event name', 'ignore', '[""]', '[]', 'NEFs whose quoted docket-event name is empty. Historically all noise.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='blank_docket_text');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'trustee_services_330e', 'Trustee 330(e) services/payment', 'ignore', '["Trustee Services Rendered Pursuant to 330(e)", "Trustee Payment Under 11 U.S.C. 330(e) Processed"]', '["Trustee Services Rendered Pursuant to 330(e)", "Trustee Payment Under 11 U.S.C. 330(e) Processed"]', 'Trustee compensation plumbing.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='trustee_services_330e');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'debtor_schedules_declaration', 'Debtor schedules declaration', 'ignore', '["Declaration About an Individual Debtor(s) Schedules"]', '["Declaration About an Individual Debtor(s) Schedules"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='debtor_schedules_declaration');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'financial_mgmt_certificate', 'Financial management certificate', 'ignore', '["Personal Financial Management Course Certificate"]', '["Personal Financial Management Course Certificate"]', 'Debtor-education certificate (filed). The NOTICE of the requirement is NOT seeded.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='financial_mgmt_certificate');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'certification_non_response', 'Certification of non-response', 'ignore', '["Certification of Non-Response"]', '["Certification of Non-Response"]', 'Procedural certification.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='certification_non_response');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'ch7_means_test_statements', 'Ch7 means-test statements', 'ignore', '["Chapter 7 Statements - Monthly Income (122A-1) / Exemption Presumption of Abuse (122A-1Supp)"]', '["Chapter 7 Statements - Monthly Income (122A-1) / Exemption Presumption of Abuse (122A-1Supp)"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='ch7_means_test_statements');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'final_installment_certificate', 'Final installment certificate', 'ignore', '["Certificate of Final Installment/Fees Paid/Bar Debtor (virtual)"]', '["Certificate of Final Installment/Fees Paid/Bar Debtor (virtual)"]', 'Clerk fee-ledger artifact.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='final_installment_certificate');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'statement_of_intention', 'Statement of intention', 'ignore', '["Statement of Intention for Individuals Filing Under Chapter 7"]', '["Statement of Intention for Individuals Filing Under Chapter 7"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='statement_of_intention');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'response_filed', 'Response (generic)', 'ignore', '["Response"]', '["Response"]', 'Party responses; informational for us.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='response_filed');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'creditor_request_notice', 'Creditor request for notice', 'ignore', '["Creditor Request for Notice"]', '["Creditor Request for Notice"]', 'Mailing-matrix housekeeping.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='creditor_request_notice');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'notice_of_appearance', 'Notice of appearance', 'ignore', '["Notice of Appearance"]', '["Notice of Appearance"]', 'Counsel appearance; informational.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='notice_of_appearance');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'order_striking_document', 'Order striking document', 'ignore', '["Order Striking Document (text)", "Order Striking Document - Closed Case (text)", "Order Striking Document - Initial Documents (7 Days) - text"]', '["Order Striking Document (text)", "Order Striking Document - Closed Case (text)", "Order Striking Document - Initial Documents (7 Days) - text"]', 'Strikes a docket entry. The struck entry, if ours, surfaces through Deficiency/Missing-Docs notices which ARE act keys.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='order_striking_document');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'amendment_cover_sheet', 'Amendment cover sheet', 'ignore', '["Cover Sheet for Amendments to Schedules and or Statements"]', '["Cover Sheet for Amendments to Schedules and or Statements"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='amendment_cover_sheet');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'transcript_activity', 'Transcript activity', 'ignore', '["Transcript Request", "Transcript", "Acknowledgement of Request for Transcript of Testimony", "Update Transcript Deadlines"]', '["Transcript Request", "Transcript", "Acknowledgement of Request for Transcript of Testimony", "Update Transcript Deadlines"]', 'Court-reporter plumbing.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='transcript_activity');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'filing_fee_paid_full', 'Filing fee paid in full', 'ignore', '["Chapter 7 Final Installment Payment/Filing Fee Paid in Full", "Chapter 13 Final Installment Payment/Filing Fee Paid in Full", "Receipt of Installment Filing Fee (OTC auto)"]', '["Chapter 7 Final Installment Payment/Filing Fee Paid in Full", "Chapter 13 Final Installment Payment/Filing Fee Paid in Full", "Receipt of Installment Filing Fee (OTC auto)"]', 'Fee ledger receipts. A pending OSC is dissolved by its own Minute Entry, which is an act key.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='filing_fee_paid_full');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'exhibit_filed', 'Exhibit filed', 'ignore', '["Exhibit", "Exhibit List"]', '["Exhibit", "Exhibit List"]', 'Attachments to other filings.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='exhibit_filed');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'notice_of_withdrawal', 'Notice of withdrawal (generic)', 'ignore', '["Notice of Withdrawal"]', '["Notice of Withdrawal"]', 'Withdraws a prior filing; no dated obligation observed in corpus.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='notice_of_withdrawal');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'stipulation_batch', 'Stipulation (batch)', 'ignore', '["Stipulation(batch)"]', '["Stipulation(batch)"]', 'Trustee batch stipulations. Plain "Stipulation" is NOT seeded — it can adjourn hearings.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='stipulation_batch');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'objection_confirmation_service_batch', 'Objection to confirmation w/COS (batch)', 'ignore', '["Objection to Confirmation of Plan w/Cert of Service(batch)", "Obj to Confirmation of Plan w/Cert of Service(batch)"]', '["Objection to Confirmation of Plan w/Cert of Service(batch)", "Obj to Confirmation of Plan w/Cert of Service(batch)"]', 'Trustee batch objections; the confirmation hearing itself is tracked from its own notices.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='objection_confirmation_service_batch');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'reply_motions', 'Reply (motions)', 'ignore', '["Reply - motions"]', '["Reply - motions"]', 'Briefing traffic.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='reply_motions');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'corporate_ownership_statement', 'Corporate ownership statement', 'ignore', '["Statement of Corporate Ownership"]', '["Statement of Corporate Ownership"]', 'Rule 7007.1 statement.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='corporate_ownership_statement');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'ch13_income_forms', 'Ch13 income forms', 'ignore', '["Chapter 13 Statement of Your Current Monthly Income Form 122C-1", "Chapter 13 Calculation of Your Disposable Income Form 122C-2"]', '["Chapter 13 Statement of Your Current Monthly Income Form 122C-1", "Chapter 13 Calculation of Your Disposable Income Form 122C-2"]', 'Our own filing echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='ch13_income_forms');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'ch13_plan_filed', 'Ch13 plan (filed)', 'ignore', '["Chapter 13 Plan", "Amended Chapter 13 Plan - Pre Confirmation"]', '["Chapter 13 Plan", "Amended Chapter 13 Plan - Pre Confirmation"]', 'Our own plan filings echoed back.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='ch13_plan_filed');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'meeting_of_creditors_held', '341 held (status)', 'ignore', '["Meeting of Creditors Held"]', '["Meeting of Creditors Held"]', 'The scheduled 341 occurred; no new date. ("Meeting of Creditors Not Held" is NOT seeded — it needs a watch flag.)'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='meeting_of_creditors_held');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'mortgage_payment_change', 'Mortgage payment change notices', 'ignore', '["Notice of Mortgage Payment Change", "Notice of Postpetition Mortgage Fees, Expenses, and Charges"]', '["Notice of Mortgage Payment Change", "Notice of Postpetition Mortgage Fees, Expenses, and Charges"]', 'Rule 3002.1 servicer notices; trustee-facing.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='mortgage_payment_change');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'paygov_fees', 'Pay.gov fee receipts', 'ignore', '["Fees"]', '["Fees"]', 'Payment receipts.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='paygov_fees');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'substitution_of_attorney', 'Substitution of attorney', 'ignore', '["Substitution of Attorney"]', '["Substitution of Attorney"]', 'Counsel changes on other parties.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='substitution_of_attorney');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'memorandum_filed', 'Memorandum', 'ignore', '["Memorandum"]', '["Memorandum"]', 'Briefing traffic.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='memorandum_filed');

INSERT INTO ai_match_types (set_id, type_key, label, disposition, subject_match, recognition_hints, notes)
SELECT id, 'docket_admin_activity', 'Docket administrative activity', 'ignore', '["@prefix:Docket Entry ", "@prefix:A relationship has been created", "@prefix:Deleted Party ", "@prefix:Updated Case Information", "@prefix:Modified Debtor ", "of ECF Activity"]', '["Docket Entry ", "A relationship has been created", "Deleted Party ", "Updated Case Information", "Modified Debtor ", "of ECF Activity"]', 'Clerk edits to the docket/case record: entry updates, party add/delete, case-info updates, daily ECF summaries.'
  FROM ai_match_sets WHERE set_key='court_nef'
   AND NOT EXISTS (SELECT 1 FROM ai_match_types t JOIN ai_match_sets s2 ON s2.id=t.set_id WHERE s2.set_key='court_nef' AND t.type_key='docket_admin_activity');