-- ref/2026-09-01_g2_document_generate.sql
--
-- G2 — "generate a document from a template", the non-esign twin of
-- send-from-template. Two columns on contract_templates and one settings row.
--
-- RUN ORDER: this file, top to bottom, THEN deploy the backend. The OLD code
-- tolerates the new columns (esignTemplateService.getTemplate is SELECT *, and
-- listTemplates names its columns explicitly), so running the SQL early cannot
-- break anything. The NEW code REQUIRES them — documentGenerateService reads
-- template.purpose and template.file_subfolder on every call — so the reverse
-- order would ship a feature that reads undefined.
--
-- EACH STATEMENT IS SELF-CONTAINED. The DB console runs every statement on a
-- separate pooled connection, so nothing here relies on session state (no
-- SET @var, no LAST_INSERT_ID).
--
-- CHARSET + COLLATE ARE SPELLED OUT on both columns. See
-- ref/SCHEMA_CONVENTIONS.md: writing CHARACTER SET utf8mb4 without a COLLATE
-- silently lands on utf8mb4_0900_ai_ci on MySQL 8, which can never be compared
-- column-to-column against the general_ci core tables.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. purpose + file_subfolder.
--
--    purpose decides which PICKER a template appears in. The default 'esign'
--    is what makes this migration safe on live data: all 7 existing templates
--    are signature templates and stay exactly where they are, invisible to the
--    generate path until someone deliberately flips one.
--
--    file_subfolder is where a GENERATED (non-esign) document lands under the
--    case folder — the generate-path equivalent of formPdfService's hardcoded
--    'Forms'. Per-template rather than global because a fee agreement and a
--    court notice do not belong in the same drawer. NOT NULL with a default so
--    the non-strict sql_mode cannot leave it empty (an empty subfolder would
--    silently file into the case folder ROOT).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE contract_templates
  ADD COLUMN purpose ENUM('esign','generate','both')
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'esign'
    COMMENT 'esign = Send-for-Signature picker only; generate = Generate-document picker only; both = both'
    AFTER template_type,
  ADD COLUMN file_subfolder VARCHAR(64)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Generated Documents'
    COMMENT 'Subfolder under the case Dropbox folder where generated (non-esign) output files'
    AFTER purpose;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The generated-documents unsorted bin.
--
--    Its OWN bin, for the same reason X5.1 gave form PDFs one: a client upload
--    is a document the firm must chase, a form PDF is a machine archive, and a
--    generated document is a thing staff produced on purpose. Mixing them makes
--    every bin a work queue nobody can trust to be empty.
--
--    Not strictly required (documentGenerateService falls back to this exact
--    path), but the row makes it visible and editable in admin next to the
--    esign / forms / uploads bins.
--
--    LEADING SPACES ARE LOAD-BEARING — they are the firm's Dropbox sort
--    convention. Do not trim them.
--
--    category 'Dropbox' (Title-Case) and type 'text' match the three live
--    sibling rows; every category in app_settings is Title-Case. sort_order 6
--    puts it immediately after dropbox_unsorted_forms_path (5).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES ('dropbox_unsorted_generated_path', '/  Law Office/   Cases/  Unsorted Generated Documents',
        0, 1, 'Dropbox', 'Unsorted generated documents path',
        'Where documents generated from a template go when they have no case folder to file into (no case, or the case folder is unreachable).',
        'text', 6)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. VERIFY — expect 7 template rows, every one purpose='esign' with
--    file_subfolder='Generated Documents', and one settings row whose value
--    still carries its two leading spaces after "/".
-- ─────────────────────────────────────────────────────────────────────────────
SELECT id, name, template_type, purpose, file_subfolder, active
  FROM contract_templates
 ORDER BY id;

SELECT `key`, CONCAT('[', `value`, ']') AS value_bracketed, category, type, sort_order
  FROM app_settings
 WHERE `key` LIKE 'dropbox_unsorted%'
 ORDER BY sort_order;
