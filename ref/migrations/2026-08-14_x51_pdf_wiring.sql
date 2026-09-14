-- ref/2026-08-14_x51_pdf_wiring.sql
--
-- X5.1 — wire render_submission_pdf into wf40 (the shared form-notify
-- workflow), give form PDFs their own unsorted Dropbox bin, and fix a live
-- regression found while verifying.
--
-- RUN ORDER: this file, top to bottom, THEN deploy the code. (The code is
-- backwards-compatible with the un-migrated DB — a missing settings row falls
-- back to the hardcoded path, and the new wf40 steps are inert until the code
-- ships because `render_submission_pdf` already exists as of X5. Running the
-- SQL first therefore cannot break anything, and it means the very first
-- submission after deploy already has the steps.)
--
-- EACH STATEMENT IS SELF-CONTAINED. The DB console runs every statement on a
-- separate pooled connection, so nothing here relies on session state.
--
-- wf40 IS LIVE. Executions finish in seconds, so the renumber window is
-- effectively nil, but run it when a submission is not mid-flight if you can.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The form-PDF unsorted bin. Not strictly required (formPdfService falls
--    back to this exact default), but the row makes it visible and editable
--    in admin alongside the esign and client-upload bins.
--    Leading spaces are the firm's Dropbox sort convention — do not trim.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES ('dropbox_unsorted_forms_path', '/  Law Office/   Cases/  Unsorted Form Submissions',
        0, 1, 'dropbox', 'Unsorted form submissions path',
        'Where form-submission PDFs go when they have no case folder to file into (no case, or the case folder is unreachable).',
        'text', NULL)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Make room for two new steps at positions 2 and 3.
--    ORDER BY … DESC is load-bearing: uk_workflow_step is UNIQUE on
--    (workflow_id, step_number), so an ascending update collides mid-flight.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE workflow_steps
   SET step_number = step_number + 2
 WHERE workflow_id = 40 AND step_number >= 2
 ORDER BY step_number DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Re-point the jump targets the renumber invalidated. Addressed by id, not
--    step_number, so this is unambiguous after step 2 ran.
--      id 450 "Linked?"      then 4 → 6 (RG alert), else 6 → 8 (Case log)
--      id 459 "Intake form?" then 8 → 10 (Mark intake complete)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE workflow_steps
   SET config = JSON_SET(config, '$.params.then', 6, '$.params.else', 8)
 WHERE id = 450;

UPDATE workflow_steps
   SET config = JSON_SET(config, '$.params.then', 10)
 WHERE id = 459;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The two new steps.
--    2 = gate. `make_pdf` arrives in init_data from BOTH dispatchers (the
--        external submit route and yc-forms save()), always defined, from the
--        published definition's onSubmit.pdf. A workflow started any other way
--        has no make_pdf → undefined == true → false → skips to 4. Safe default.
--    3 = the render. error_policy 'ignore' is explicit and deliberate: a PDF
--        failure must never cost the office its notification email. The email
--        then simply has no attachment (an empty {{pdf.temp_link}} resolves to
--        '' and the gmail adapter drops a url-less attachment silently).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO workflow_steps (workflow_id, step_number, type, label, note, config, error_policy)
VALUES
  (40, 2, 'internal_function', 'PDF wanted?',
   'Gates on make_pdf, which both form dispatchers inject from the published definition''s onSubmit.pdf.',
   '{"function_name":"evaluate_condition","params":{"variable":"make_pdf","operator":"==","value":true,"then":3,"else":4}}',
   NULL),
  (40, 3, 'internal_function', 'Render submission PDF',
   'Files the PDF to the case Dropbox folder (or the unsorted form-submissions bin) and exposes {{pdf.temp_link}} / {{pdf.file_name}} to the notify step. Failures are ignored on purpose so the notification still sends.',
   '{"function_name":"render_submission_pdf","params":{"submission_id":"{{submission_id}}","output_var":"pdf"}}',
   '{"strategy":"ignore"}');

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Attach it to the notify email (id 449, now step 4).
--    When no PDF was rendered, {{pdf.temp_link}} resolves to '' and
--    urlToMailcomposerAttachment returns null → the attachment is dropped and
--    the email sends unchanged. That IS the empty fallback; no filter syntax
--    is involved (there is none — see statement 6).
--    The gmail adapter fetches the URL into the MIME body server-side, so the
--    recipient gets real bytes, not a link that expires in ~4 hours.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE workflow_steps
   SET config = JSON_SET(
         config,
         '$.params.attachment_urls',
         JSON_ARRAY(JSON_OBJECT('url', '{{pdf.temp_link}}', 'name', '{{pdf.file_name}}'))
       )
 WHERE id = 449;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. REGRESSION FIX (unrelated to X5 — found while verifying).
--    id 453 "Case log" has carried subject "{{log_subject|default:Form
--    submission received}}" since 2026-08-13 10:19:43. There is NO filter or
--    default syntax in the placeholder resolver (lib/workflow_engine.js
--    resolveSingle): the whole string is looked up as one variable name,
--    misses, and resolves to ''. Every form log written since that edit has an
--    empty subject (log 64784, submission 288). intake's initData supplies
--    log_subject, so the plain placeholder is all that was ever needed.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE workflow_steps
   SET config = JSON_SET(config, '$.params.subject', '{{log_subject}}')
 WHERE id = 453;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. VERIFY — expect 10 rows numbered 1-10 in this order:
--    1 Format answers | 2 PDF wanted? | 3 Render submission PDF |
--    4 Notify office (config now carries attachment_urls) |
--    5 Linked? (then 6 / else 8) | 6 RG alert | 7 End |
--    8 Case log (subject {{log_subject}}) | 9 Intake form? (then 10) |
--    10 Mark intake complete
-- ─────────────────────────────────────────────────────────────────────────────
SELECT step_number, id, label,
       JSON_UNQUOTE(JSON_EXTRACT(config, '$.function_name')) AS fn,
       JSON_EXTRACT(config, '$.params.then')  AS then_step,
       JSON_EXTRACT(config, '$.params.else')  AS else_step,
       JSON_EXTRACT(config, '$.params.attachment_urls') AS attachments,
       JSON_UNQUOTE(JSON_EXTRACT(config, '$.params.subject')) AS log_subject
  FROM workflow_steps
 WHERE workflow_id = 40
 ORDER BY step_number;
