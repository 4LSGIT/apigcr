-- 2026-10-14 — Comms archive S0 evaluation (lane D): the sample, the reviewers' scores, who may review
--
-- Spec: local/s0_eval_rubric.md (the pre-registered rubric, private) and
-- ref/COMMS_ARCHIVE_DESIGN.md §12 S0. Code: services/commsEvalService.js,
-- routes/api.commsEval.js, services/commsArchiveAdmin.js (isEvalReviewer),
-- the review page scripts/commsArchive/eval/review-tool.html (an Admin → Tools page).
--
-- Run BEFORE the backend deploy. Re-runnable: CREATE TABLE IF NOT EXISTS, and
-- the setting never clobbers an edited value. No session variables.

-- ── 1. The sample: one row per sampled recording ────────────────────────────
-- The single list both the review page and S2's sample mode work from.
-- Inserted only through POST /api/comms-eval/sample (SU, validated, audited).
CREATE TABLE IF NOT EXISTS comms_eval_items (
  media_id  BIGINT UNSIGNED NOT NULL COMMENT 'comms_media.id (kind call_recording) in the S0 evaluation sample',
  stratum   VARCHAR(4)  NOT NULL COMMENT 'S1..S7 — the rubric §1 stratum it was drawn for',
  seed      VARCHAR(32) NOT NULL COMMENT 'the selection seed (ORDER BY SHA2(id + seed)); fixed before the draw',
  audio_s   INT UNSIGNED NULL COMMENT 'ESTIMATED audio length at draw time, seconds: comms_media.bytes ÷ the provider byte rate (rubric amendment A1) — the review windows are drawn inside it',
  added_by  TINYINT NOT NULL COMMENT 'users.user (SU) who inserted it',
  added_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (media_id)
) ENGINE=InnoDB COMMENT='Comms archive S0 evaluation sample (lane D). Ids only — never call content';

-- ── 2. Reviewers' scores ────────────────────────────────────────────────────
-- One row per reviewer, item and stage. `scores` holds ONLY numbers, booleans
-- and fixed tags, enforced by services/commsEvalService.validateScores (any
-- other key or any free string is refused), so no call content is ever stored.
CREATE TABLE IF NOT EXISTS comms_eval_reviews (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reviewer_id TINYINT NOT NULL COMMENT 'users.user',
  media_id    BIGINT UNSIGNED NOT NULL COMMENT 'comms_eval_items.media_id',
  stage       VARCHAR(16) NOT NULL COMMENT 'transcript | transcript_alt | summary — app-validated',
  scores      JSON NOT NULL COMMENT 'validated: numbers, booleans, enum tags only (commsEvalService.validateScores)',
  transcript_seen_at DATETIME NULL COMMENT 'UTC; first time this reviewer was served the transcript — the noise tag is frozen from then on (blind rule)',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_comms_eval_reviews (reviewer_id, media_id, stage),
  KEY idx_comms_eval_reviews_media (media_id)
) ENGINE=InnoDB COMMENT='Comms archive S0 evaluation scores (lane D). Never call content';

-- ── 3. Who may review besides SU ────────────────────────────────────────────
-- CSV of users.user ids; read uncached on every request; digits only (other
-- tokens ignored and logged); missing / empty / garbage = SU only. Separate
-- from comms_archive_admins (who may purge). is_editable 0: SU db console only.
-- Seeded with user 1 (SS). A reviewer can open ONLY the sampled items.
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES (
  'comms_eval_reviewers', '1', 0, 0, 'Automations', 'Comms Evaluation Reviewers',
  'Comma-separated users.user ids who may listen to, read and score the S0 evaluation sample, besides SU. Digits only; anything else is ignored. Empty = SU only. Changed from the SU db console only.',
  'string', 42
)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SHOW CREATE TABLE comms_eval_items;  SHOW CREATE TABLE comms_eval_reviews;
-- SELECT `key`, `value`, is_editable FROM app_settings WHERE `key` = 'comms_eval_reviewers';
