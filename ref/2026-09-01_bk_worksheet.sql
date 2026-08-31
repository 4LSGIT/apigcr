-- ============================================================================
-- 2026-09-01_bk_worksheet.sql
-- SS spreadsheet parity — "BK Worksheet" columns + view (W1).
--
-- WHY
--   SS runs the bankruptcy docket out of a Google Sheet ("Bankruptcy Case
--   List", one row per filed case per year, ~40 tracked columns). This slice
--   gives that sheet a home in YisraCase: a YisraView that mirrors the sheet's
--   columns, with per-row editing through an open_form modal (a YisraForm,
--   form_key 'bk_worksheet') — the first WRITE affordance reachable from a
--   view, though the view itself stays read-only: the write path is the
--   ordinary authed form → PATCH /api/cases/:id chain.
--
--   The sheet's cells are free text IN PRACTICE ("DUE 2/2 - Motion to 2/9",
--   "PAY IN FULL OR CASE DISMISSED", "84.50", "BFS"). Forcing them into enums
--   now would guarantee SS keeps the sheet. So: the columns below are
--   deliberately loose (varchar/text) except the four that are consistently
--   real dates. Tighten later, once he lives here. Where YC already has a
--   matching structured column with matching real-world usage (case_341_*,
--   docs_due, case_post_petition, matrix, schedules, case_1st/2nd_course,
--   case_objection, case_discharge_date), the view and form use THAT — the
--   bk_* columns cover only what had no home.
--
--   These land on `cases` directly, next to their legacy BK siblings. That is
--   a deliberate continuation of the legacy shape, not drift: onSubmit.patch
--   hits the case PATCH endpoint for free, and a sidecar table would need its
--   own load/save plumbing for zero user-visible gain today.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- RUN THIS WHOLE FILE FIRST (it is inert without the code), THEN deploy the
-- code (validator + customView), THEN install the 'bk_worksheet' form template
-- via the Form Builder (see bk_worksheet.definition.json). The view row seeded
-- below renders read-only immediately — the deployed customView drops the
-- unknown open_form action with a console warning until the new build ships,
-- and the modal 404s politely until the template exists.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Guarded ALTERs are not portable on this MySQL without a procedure, so the
-- ADD COLUMNs are plain — a re-run fails loudly on the first duplicate column,
-- which is the correct failure. The view seed is INSERT IGNORE (unique
-- report_key): re-running never clobbers an edited view.
--
-- ── sql_mode NOTE ───────────────────────────────────────────────────────────
-- All new columns are NULLable with no default — nothing here trips the
-- 41-implicit-default landmine, and blank-date→NULL is already handled by the
-- case PATCH path (lib/blankDateToNull.js).
-- ============================================================================

-- ── 1. Worksheet columns ────────────────────────────────────────────────────
-- Sheet column ↔ DB column (sheet order, gaps only — see file header):
--   Installment Fee Application            bk_fee_application
--   Upload Proposed Installment Order      bk_fee_order_proposed
--   Installment Fee Order Issued           bk_fee_order_issued
--   Payments $ Amounts                     bk_fee_amounts        (multi-line)
--   Dates Due                              bk_fee_dates_due      (multi-line)
--   Installment Fee Due                    bk_fee_due            (PAID / DUE …)
--   Funding Application To Finance Company bk_funding_app        (BFS / FSF)
--   Set Up Payment Schedule in Clio        bk_clio_pay_schedule
--   Reaffirmation Agreement Needed         bk_reaffirmation      (Yes/No/Undecided/…)
--   Chapter 13 Plan Filed                  bk_ch13_plan_filed
--   Upload Ch 13 Plan to COS + POS         bk_ch13_plan_cos
--   Dismissal Notice                       bk_dismissal_notice
--   Ch 13 Confirmation Hearing Date        bk_confirmation_hearing        DATE
--   Confirmation / Expected Discharge Date bk_confirmation_exp_discharge  DATE
--   Confirmation Certificate Filed         bk_confirmation_cert
--   2nd Course - Certificate Due Date      bk_2nd_course_due              DATE
--   Discharge (outcome cell)               bk_outcome            ("X"/"Dismissed 7/10/25")
--   Follow Up Email                        bk_followup_email
--   7 Steps Course                         bk_7steps_course

ALTER TABLE cases
  ADD COLUMN bk_fee_application            VARCHAR(100) NULL,
  ADD COLUMN bk_fee_order_proposed         VARCHAR(100) NULL,
  ADD COLUMN bk_fee_order_issued           VARCHAR(100) NULL,
  ADD COLUMN bk_fee_amounts                TEXT NULL,
  ADD COLUMN bk_fee_dates_due              TEXT NULL,
  ADD COLUMN bk_fee_due                    VARCHAR(100) NULL,
  ADD COLUMN bk_funding_app                VARCHAR(100) NULL,
  ADD COLUMN bk_clio_pay_schedule          VARCHAR(100) NULL,
  ADD COLUMN bk_reaffirmation              VARCHAR(100) NULL,
  ADD COLUMN bk_ch13_plan_filed            VARCHAR(100) NULL,
  ADD COLUMN bk_ch13_plan_cos              VARCHAR(100) NULL,
  ADD COLUMN bk_dismissal_notice           VARCHAR(255) NULL,
  ADD COLUMN bk_confirmation_hearing       DATE NULL,
  ADD COLUMN bk_confirmation_exp_discharge DATE NULL,
  ADD COLUMN bk_confirmation_cert          VARCHAR(100) NULL,
  ADD COLUMN bk_2nd_course_due             DATE NULL,
  ADD COLUMN bk_outcome                    VARCHAR(100) NULL,
  ADD COLUMN bk_followup_email             VARCHAR(100) NULL,
  ADD COLUMN bk_7steps_course              VARCHAR(100) NULL;

-- ── 2. The view ─────────────────────────────────────────────────────────────
-- Column order mirrors the sheet. First column is a literal '✎' carrying the
-- open_form action (edit modal); case_id / debtor carry the usual open
-- actions. Birth Date is deliberately ABSENT: contact_dob is on the report
-- engine's DENIED_COLUMNS list (PII wall) and this migration does not weaken
-- it — DOB is one click away on the contact.
--
-- Default filters ≈ "this year's tab": filed_from defaults to year_start
-- (resolved server-side each run — no annual maintenance), Bankruptcy only,
-- filed cases only.

INSERT IGNORE INTO report_definitions
  (report_key, title, description, category, kind, visibility,
   sql_text, params, columns_meta, viz, caveats,
   row_limit, is_active, created_by, updated_by, source, is_locked)
VALUES
  ('bk_worksheet',
   'BK Worksheet',
   'The bankruptcy case list, one row per filed case — the YisraCase edition of the spreadsheet. Click ✎ to edit a row''s worksheet fields; click the case or debtor to open them. Defaults to cases filed this year.',
   'Views', 'view', 'shared',
   'SELECT ''✎'' AS edit,
       c.case_id,
       c.case_file_date,
       ct.contact_name AS debtor,
       ct.contact_id,
       c.case_number,
       c.case_judge,
       c.case_chapter,
       c.case_trustee,
       c.case_source AS lead_source,
       c.bk_fee_application,
       c.bk_fee_order_proposed,
       c.bk_fee_order_issued,
       c.bk_fee_amounts,
       c.bk_fee_dates_due,
       c.case_post_petition AS second_contract,
       c.bk_funding_app,
       c.bk_clio_pay_schedule,
       TRIM(CONCAT_WS('' · '', NULLIF(c.matrix, ''''), DATE_FORMAT(COALESCE(c.matrix_date_proposed, c.matrix_date_original), ''%m/%d/%y''))) AS matrix_status,
       TRIM(CONCAT_WS('' · '', NULLIF(c.schedules, ''''), DATE_FORMAT(COALESCE(c.schedules_due_proposed, c.schedules_due_original), ''%m/%d/%y''))) AS schedules_status,
       c.case_1st_course AS ccc,
       c.bk_reaffirmation,
       c.bk_ch13_plan_filed,
       c.bk_dismissal_notice,
       c.bk_ch13_plan_cos,
       c.bk_fee_due,
       c.case_341_initial,
       c.case_341_current AS new_341,
       c.docs_due,
       c.docs AS docs_sent,
       c.`341_status` AS concluded_341,
       c.case_objection AS review_date,
       c.bk_confirmation_hearing,
       c.bk_confirmation_exp_discharge,
       c.bk_confirmation_cert,
       c.bk_2nd_course_due,
       c.case_2nd_course AS second_course,
       c.bk_outcome,
       c.case_discharge_date,
       c.bk_followup_email,
       c.bk_7steps_course,
       ct.contact_email AS email
FROM cases c
LEFT JOIN case_relate cr
  ON cr.case_relate_case_id = c.case_id AND cr.case_relate_type = ''Primary''
LEFT JOIN contacts ct ON ct.contact_id = cr.case_relate_client_id
WHERE c.case_type = ''Bankruptcy''
  AND c.case_file_date IS NOT NULL
  AND c.case_file_date >= COALESCE(?, c.case_file_date)
  AND c.case_file_date <= COALESCE(?, c.case_file_date)
  AND c.case_chapter <=> COALESCE(NULLIF(?, ''__all__''), c.case_chapter)
  AND c.case_trustee LIKE CONCAT(''%'', COALESCE(?, ''''), ''%'')
  AND ct.contact_name LIKE CONCAT(''%'', COALESCE(?, ''''), ''%'')
ORDER BY c.case_file_date ASC, c.case_id ASC',
   JSON_ARRAY(
     JSON_OBJECT('name','filed_from','type','date','label','Filed from','default','year_start','required',FALSE),
     JSON_OBJECT('name','filed_to','type','date','label','Filed to','default',NULL,'required',FALSE),
     JSON_OBJECT('name','chapter','type','string','label','Chapter','control','select','default',NULL,'required',FALSE,
       'options', JSON_ARRAY(
         JSON_OBJECT('label','All','value',NULL),
         JSON_OBJECT('label','7','value','7'),
         JSON_OBJECT('label','11','value','11'),
         JSON_OBJECT('label','12','value','12'),
         JSON_OBJECT('label','13','value','13'))),
     JSON_OBJECT('name','trustee','type','string','label','Trustee contains','default',NULL,'required',FALSE),
     JSON_OBJECT('name','debtor','type','string','label','Debtor contains','default',NULL,'required',FALSE)
   ),
   JSON_ARRAY(
     JSON_OBJECT('key','edit','label','✎','width',44,'align','center',
       'action', JSON_OBJECT('type','open_form','idKey','case_id','formKey','bk_worksheet','linkType','case')),
     JSON_OBJECT('key','case_id','label','Case','action', JSON_OBJECT('type','open_case','idKey','case_id')),
     JSON_OBJECT('key','case_file_date','label','Filed','format','date'),
     JSON_OBJECT('key','debtor','label','Debtor','action', JSON_OBJECT('type','open_contact','idKey','contact_id')),
     JSON_OBJECT('key','contact_id','hidden',TRUE),
     JSON_OBJECT('key','case_number','label','Case No.','action', JSON_OBJECT('type','copy')),
     JSON_OBJECT('key','case_judge','label','Judge'),
     JSON_OBJECT('key','case_chapter','label','Ch','width',44,'align','center'),
     JSON_OBJECT('key','case_trustee','label','Trustee'),
     JSON_OBJECT('key','lead_source','label','Lead Source'),
     JSON_OBJECT('key','bk_fee_application','label','Fee App'),
     JSON_OBJECT('key','bk_fee_order_proposed','label','Fee Order Proposed'),
     JSON_OBJECT('key','bk_fee_order_issued','label','Fee Order Issued'),
     JSON_OBJECT('key','bk_fee_amounts','label','Payments $','width',110),
     JSON_OBJECT('key','bk_fee_dates_due','label','Dates Due','width',110),
     JSON_OBJECT('key','second_contract','label','2nd Contract'),
     JSON_OBJECT('key','bk_funding_app','label','Funding App'),
     JSON_OBJECT('key','bk_clio_pay_schedule','label','Clio Sched'),
     JSON_OBJECT('key','matrix_status','label','Matrix'),
     JSON_OBJECT('key','schedules_status','label','Schedules/SOFA'),
     JSON_OBJECT('key','ccc','label','CCC'),
     JSON_OBJECT('key','bk_reaffirmation','label','Reaffirm'),
     JSON_OBJECT('key','bk_ch13_plan_filed','label','Ch13 Plan Filed'),
     JSON_OBJECT('key','bk_dismissal_notice','label','Dismissal Notice','width',160),
     JSON_OBJECT('key','bk_ch13_plan_cos','label','Ch13 Plan COS'),
     JSON_OBJECT('key','bk_fee_due','label','Fee Due'),
     JSON_OBJECT('key','case_341_initial','label','Initial 341','format','date'),
     JSON_OBJECT('key','new_341','label','New 341','format','date'),
     JSON_OBJECT('key','docs_due','label','Docs Due','format','date'),
     JSON_OBJECT('key','docs_sent','label','Docs Sent'),
     JSON_OBJECT('key','concluded_341','label','341 Concluded'),
     JSON_OBJECT('key','review_date','label','Review Date','format','date'),
     JSON_OBJECT('key','bk_confirmation_hearing','label','Ch13 Conf Hearing','format','date'),
     JSON_OBJECT('key','bk_confirmation_exp_discharge','label','Conf / Exp Discharge','format','date'),
     JSON_OBJECT('key','bk_confirmation_cert','label','Conf Cert'),
     JSON_OBJECT('key','bk_2nd_course_due','label','2nd Course Due','format','date'),
     JSON_OBJECT('key','second_course','label','2nd Course'),
     JSON_OBJECT('key','bk_outcome','label','Discharge/Outcome'),
     JSON_OBJECT('key','case_discharge_date','label','Discharge Date','format','date'),
     JSON_OBJECT('key','bk_followup_email','label','Follow Up'),
     JSON_OBJECT('key','bk_7steps_course','label','7 Steps'),
     JSON_OBJECT('key','email','label','Email','action', JSON_OBJECT('type','copy'))
   ),
   JSON_OBJECT('type','table'),
   JSON_ARRAY(
     'Shows the Primary contact only — joint filers appear as one row.',
     'Course, contract, matrix, schedules and docs columns are multi-value: a case can carry several tokens at once.',
     'Review Date is mapped to the objection deadline (case_objection) — flag it if that''s not what this column means on the sheet.',
     'Birth Date is intentionally omitted: DOB is walled off from the report engine as PII. It''s one click away on the contact.',
     'Filed this year by default — clear the Filed from box for full history.'
   ),
   2000, 1, NULL, NULL, 'manual', 1);
