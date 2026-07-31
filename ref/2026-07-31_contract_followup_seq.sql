-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-07-31 — "Contract Follow-up" sequence (fee-agreement e-sign chasing)
--
-- A contract-specific reminder chain for the three Low Money Down fee
-- agreements. The firm default (template 26, esign_reminder_seq_id) stays
-- UNTOUCHED — this sequence is wired per-template: after running this, set
-- reminder_seq_id = <the id this script prints> on each of the three contract
-- templates in templateAdmin.
--
-- Shape (all business days, cancellation on signed/declined/etc. is automatic
-- via esignService.applyStatus — a signed client is never nudged or tasked):
--   step 1  +2 bd 10:00  esign_remind   (client nudge ~day 2)
--   step 2  +3 bd 10:00  esign_remind   (~day 5 — "ignored for a week" begins)
--   step 3  +2 bd 10:00  esign_remind   (~day 7, final automated nudge)
--   step 4  +1 bd 09:00  create_task    (~day 8 → Rena, user 22: call client)
-- Zoho's own 14-calendar-day expiry closes out anything still unsigned after
-- that; expiry cancels the enrollment like every other terminal status.
--
-- esign_remind verifies LIVE provider status before nudging (race guard), so
-- a webhook that never arrived cannot cause a signed client to be reminded.
-- create_task has no such guard — if the client signed moments before step 4
-- and the cancellation hasn't landed, the task fires spuriously. Accepted:
-- webhooks are enforce-mode and reconcile runs nightly; the window is minutes.
--
-- link_id note: contract sends from sendingform-bk are always case-linked, so
-- {{trigger_data.case_id}} always resolves (8-char case id, fits the
-- varchar(20) task_link_id). A contact-linked send would resolve it to '' —
-- harmless but linkless; not a path the fee agreements use.
--
-- Idempotence: guarded by name — rerunning is a no-op that still prints the id.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO sequence_templates (name, type, active, description)
SELECT 'Contract Follow-up', 'esign_reminder', 1,
       'Chases unsigned fee agreements: three client reminders over ~7 business days, then a follow-up-call task to staff. Wire via reminder_seq_id on each contract template. Cancels automatically the moment the request goes terminal (signed/declined/expired/recalled).'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM sequence_templates WHERE name = 'Contract Follow-up' AND type = 'esign_reminder'
);

SET @contract_seq_id = (
  SELECT id FROM sequence_templates
  WHERE name = 'Contract Follow-up' AND type = 'esign_reminder'
  ORDER BY id LIMIT 1
);

INSERT INTO sequence_steps (template_id, step_number, action_type, action_config, timing, error_policy)
SELECT * FROM (
  SELECT @contract_seq_id AS template_id, 1 AS step_number, 'internal_function' AS action_type,
         '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}' AS action_config,
         '{"type":"business_days","value":2,"timeOfDay":"10:00"}' AS timing,
         '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}' AS error_policy
  UNION ALL
  SELECT @contract_seq_id, 2, 'internal_function',
         '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}',
         '{"type":"business_days","value":3,"timeOfDay":"10:00"}',
         '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}'
  UNION ALL
  SELECT @contract_seq_id, 3, 'internal_function',
         '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}',
         '{"type":"business_days","value":2,"timeOfDay":"10:00"}',
         '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}'
  UNION ALL
  SELECT @contract_seq_id, 4, 'internal_function',
         '{"function_name":"create_task","params":{"title":"Unsigned contract: {{trigger_data.document_name}}","description":"Client {{contacts.contact_name}} has not signed \\"{{trigger_data.document_name}}\\" (case {{trigger_data.case_id}}) after three automated reminders. Please call to follow up. The Zoho signing link expires 14 days after send; if it lapses, resend from the case Signatures tab.","assigned_to":22,"assigned_by":0,"source":"esign_followup","link_type":"case","link_id":"{{trigger_data.case_id}}"}}',
         '{"type":"business_days","value":1,"timeOfDay":"09:00"}',
         '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}'
) AS steps
WHERE NOT EXISTS (
  SELECT 1 FROM sequence_steps s WHERE s.template_id = @contract_seq_id
);

-- ── verify ──────────────────────────────────────────────────────────────────
SELECT @contract_seq_id AS contract_followup_seq_id;  -- ← set this as reminder_seq_id on the 3 contract templates
SELECT step_number, action_type,
       JSON_UNQUOTE(JSON_EXTRACT(action_config, '$.function_name')) AS fn,
       timing
FROM sequence_steps WHERE template_id = @contract_seq_id ORDER BY step_number;
