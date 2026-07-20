# Phase 2E deploy — PDF templates, one-time sends, stored sources, expressions
# (+ firm-identity fold-in)

## Order: SQL FIRST, then code (both migrations are inert to running code)

1. Apply `ref/2026-07-20_esign_phase2e.sql`
   - contract_templates.template_type (varchar, default 'html')
   - contract_template_pdfs (MEDIUMBLOB, PK template_id)
   - signing_request_sources (LONGBLOB, PK signing_request_id)
2. Apply `ref/2026-07-20_firm_identity.sql`
   - firm_name / firm_address (json_array) / firm_attorney_name app_settings
   - idempotent; re-runs never revert staff-edited values
3. Deploy code. No Dockerfile change, no memory change, no new deps
   (pdf-lib 1.17.1 + pdfjs-dist 3.11.174 CDN already in place).

## Smoke (in order, all test-mode safe)
- Templates admin → New template → type "Uploaded PDF" → save → upload a blank
  PDF → Open PDF & place fields → draw one signature + one amber Text box
  (key from the schema) → save → sendForm → pick it → prefills resolve →
  Preview (server fills via pdf-lib — no chromium) → send (test mode).
- Dashboard → New request → CasePicker → "Upload a PDF" source → place fields
  → Fill bound values from case → send.
- Any sent request → Details → "Sent document → Download (unsigned copy)".
- A bounced row → Re-send: file input reads "(optional)" and resends without
  re-attaching.
- Template with a firm.address-resolver field (mark it required): resolves
  from the new setting; clear the setting in Settings → Firm Identity and the
  send refuses with ESIGN_MISSING_PREFILL.

## Verify queries (after SQL)
  SHOW COLUMNS FROM contract_templates LIKE 'template_type';
  SHOW TABLES LIKE 'contract_template_pdfs';
  SHOW TABLES LIKE 'signing_request_sources';
  SELECT `key`,`value` FROM app_settings WHERE category='Firm Identity' ORDER BY sort_order;

## Suite: 35 suites / 1811 tests green (baseline was 33/1739).
