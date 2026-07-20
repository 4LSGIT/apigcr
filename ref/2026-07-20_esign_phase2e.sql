-- 2026-07-20  E-Sign Phase 2E — PDF templates + stored send sources
--
-- Deploy order: SQL FIRST, then code. Everything here is inert to the running
-- code: a new defaulted column and two new tables nothing reads yet.
--
-- Collations pinned to utf8mb4_general_ci (DB default) — repo rule for
-- anything joined/compared to existing tables.

-- 1. Template type discriminator. varchar not ENUM (repo enum-migration rule:
--    expanding an enum safely is a three-step dance; varchar is one step and
--    signing_requests.status set the precedent).
ALTER TABLE `contract_templates`
  ADD COLUMN `template_type` varchar(16)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
    NOT NULL DEFAULT 'html'
    COMMENT 'html = body rendered to PDF; pdf = stored source PDF filled via pdf-lib'
  AFTER `kind`;

-- 2. Template source PDFs (pdf-type templates only). 1:1 with the template —
--    template_id IS the primary key. Separate table so contract_templates'
--    hot rows (list/picker queries) never drag megabytes along. MEDIUMBLOB
--    (16MB): these are the firm's blank forms; a cap on accidental bloat is a
--    feature, and live max_allowed_packet (32MB, checked 2026-07-20) clears it.
CREATE TABLE `contract_template_pdfs` (
  `template_id`   int unsigned NOT NULL,
  `pdf`           mediumblob   NOT NULL,
  `size`          int unsigned NOT NULL COMMENT 'byte length of pdf; listable without touching the blob',
  `original_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. Per-send unsigned source PDFs — the exact bytes handed to the send
--    pipeline (UNSTAMPED: both resend branches re-stamp, so storing stamped
--    bytes would double-stamp). Enables bounced/terminal resend without
--    re-attaching, and is the audit copy of what went out (minus the
--    deterministic footer). LONGBLOB not MEDIUMBLOB: Zoho's per-document cap
--    is 25MB — a large Ch13 packet fits Zoho but would overflow MEDIUMBLOB's
--    16MB and silently break resend for exactly the documents that are the
--    most painful to reproduce.
CREATE TABLE `signing_request_sources` (
  `signing_request_id` int unsigned NOT NULL,
  `pdf`                longblob     NOT NULL,
  `size`               int unsigned NOT NULL COMMENT 'byte length of pdf',
  `created_at`         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`signing_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
