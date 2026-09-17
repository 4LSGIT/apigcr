-- 2026-09-17 — decision_requests.context_html (website-lead routing arc)
--
-- Optional HTML block request_decision stores and the /d/:token pages render
-- under the question, so the responder sees what they are deciding about.
-- Trust contract = email_html: workflow-config-authored HTML; producers
-- pre-escape untrusted values. NULL for every pre-existing row and for any
-- decision that does not pass context_html — all existing behavior unchanged.
--
-- Apply BEFORE deploying the decisions.js/decisionActions.js code that reads
-- and writes it (the INSERT names the column; deploying code first would 500
-- every new request_decision).

ALTER TABLE decision_requests
  ADD COLUMN context_html MEDIUMTEXT NULL AFTER question;
