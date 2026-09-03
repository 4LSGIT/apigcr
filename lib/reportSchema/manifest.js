// lib/reportSchema/manifest.js
//
// THE CURATED REPORTING SCHEMA.
//
// This file is the single source of truth for what the reports engine — and,
// in Slice 3, the AI report author — is allowed to see and touch. It exists
// because the raw schema is actively misleading:
//
//   * 110 tables, of which ~25 are business-meaningful. The rest is telemetry
//     (jwt_api_audit_log 103k rows, query_log 35k, workflow_execution_steps
//     20k), backups (phase_c_backup_20260526, email_credentials_backup_*),
//     stalled imports (master_contacts___leads_list___phil_tirone2,
//     temp_contacts) and junk (mytable, test, `default`, checkitems1,
//     checklists1, seq_steps, seq_types, temp_seq, tempusers). Handed the
//     full dump, a model will eventually count a backup table and report a
//     confident wrong number.
//
//   * The semantics are not in the DDL. `case_source`'s top value is
//     'https://api.calendly' — a booking channel, not a lead source.
//     `case_type` contains 'potato hunting'. `case_chapter` is blank on 83%
//     of rows. No amount of schema introspection recovers any of that.
//
// So: tables are opt-IN, columns are opt-OUT, and both carry hand-written
// notes. Two consumers:
//   1. lib/reportSchema/validator.js — allowlist/denylist enforcement on
//      every save AND every run.
//   2. Slice 3's AI author — renders to a compact prompt context via
//      toPromptContext().
//
// ── MAINTENANCE ─────────────────────────────────────────────────────────────
// When a table gains a reporting-relevant column, add it here with a note or
// it stays invisible to reports. When you learn something surprising about a
// column (a fill rate, a sentinel value, a naming lie), write it in `note` —
// that is what stops the next wrong report. Notes are prose for a reader, not
// a schema language; be specific and be honest.
//
// FILL-RATE FIGURES were measured against live data on 2026-07-28 (all tables)
// and re-measured 2026-08-08 for the `cases` table (n=1074) when its remaining
// columns were added for YisraView. They will drift. They are indicative, not
// contractual — they exist to warn, not to compute with.

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL NOTES — always sent to the AI author, always worth reading.
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_NOTES = [
  "MySQL 8.4. The reporting connection runs sql_mode = IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION.",

  "Date columns are clean. The legacy '0000-00-00' values were purged 2026-07-29, and every write path now normalises a blank date to NULL (lib/blankDateToNull.js on cases/contacts/tasks; eventService rejects non-real dates outright). `WHERE col IS NOT NULL` is therefore a correct emptiness test — do NOT add defensive `CAST(col AS CHAR) <> '0000-00-00'` filters, they match nothing and only obscure the query. Never compare a DATE column to that literal either: under NO_ZERO_DATE it is a hard error (ER_WRONG_VALUE), not a no-op.",

  "Stage history is only PARTIAL. `case_stage_log` exists (pipeline engine, 2026-08) but covers ~72 of ~1,077 cases — the pipeline-enrolled ones only. Anything phrased as time-in-stage, stage transitions, funnel conversion between stages, or 'as of date X' is UNANSWERABLE ACROSS ALL CASES: either scope the answer explicitly to case_stage_log coverage and say so, or decline. Do NOT approximate it from the current stage. The date columns usable as progression signals are case_open_date / case_file_date / case_discharge_date / case_close_date; case_file_date is populated on only ~16% of cases and case_discharge_date on ~13% (139 rows, backfilled from EDMI notices 2026-08-19).",

  "Person names live on `contacts`, staff names on `users`. They are unrelated tables. `users.user` (TINYINT) is the staff id used by every *_by / *_with / *_to / *_from column across the schema — NOT `users.username`. user 0 is the 'Automations' pseudo-user and represents system activity, not a person; decide explicitly whether to include or exclude it and state which in the report description.",

  "Money: there is no billing or payments table in the reporting set. Revenue, fees collected, and AR questions cannot be answered.",

  "Prefer COUNT(*) over COUNT(col) unless you specifically mean 'rows where col is non-null'. Several columns here are NOT NULL but empty-string, so COUNT(col) and COUNT(*) agree while both overcount meaningfully-populated rows. Use NULLIF(col,'') when you mean 'actually filled in'.",

  "Empty string is used as 'no value' far more often than NULL in this schema, because the legacy tables are largely NOT NULL with '' defaults. COALESCE(NULLIF(col,''),'(blank)') is the idiomatic grouping expression here.",

  "MULTI-VALUE SET COLUMNS: several progress-tracking columns on `cases` are MySQL SET types (case_1st_course, case_2nd_course, case_pre_petition, case_post_petition, case_garnish, case_issues_bk_vehicle, case_issues_bk_other, matrix, schedules, filing_fee, docs). They read back as COMMA-SEPARATED strings — a row's value is 'Sent Info,Received', not 'Received' — so single-token EQUALITY silently returns ZERO rows: WHERE case_1st_course = 'Received' matches nothing. Test membership with FIND_IN_SET('Received', col). For an optional filter bound to one '?' placeholder where NULL means 'no filter', use: COALESCE(FIND_IN_SET(?, col), 1). '' means no tokens selected. Do NOT use LIKE '%token%' — tokens can be substrings of other tokens.",
];

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN DENYLIST — never selectable, never referenced, in any report.
//
// Enforced by the validator as a substring/identifier scan over the SQL, so
// these are blocked even via alias, subquery or SELECT *. Two categories:
// personally sensitive (PII a report should never surface) and secret
// (credential material). Bankruptcy clients hand over SSN and DOB; those
// belong behind the case detail page, not in an artifact designed to be
// exported to CSV and emailed.
// ─────────────────────────────────────────────────────────────────────────────

const DENIED_COLUMNS = [
  // Client PII
  "contact_ssn",
  "contact_dob",
  // Staff credentials / session material
  "password",
  "password_hash",
  "reset_token",
  "reset_expires",
  // Tokens that grant access if leaked
  "contact_token",           // renamed from booking_token 2026-08-17
  "appt_manage_token",
  "task_action_token",
  "draft_key",
];

// Tables that are wholly off-limits regardless of the allowlist. Belt and
// braces: none of these are in TABLES below, so this is a second barrier
// against a careless future edit.
const DENIED_TABLES = [
  "credentials",
  "email_credentials",
  "email_credentials_backup_20260513",
  "api_keys",
  "readonly_api_keys",
  "readonly_query_log",
  "users_password",
  "jwt_api_audit_log",
  "admin_audit_log",
  "phase_c_backup_20260526",
];

// ─────────────────────────────────────────────────────────────────────────────
// TABLES — the allowlist. Anything absent is invisible AND rejected.
// ─────────────────────────────────────────────────────────────────────────────

const TABLES = {
  // ── Cases ────────────────────────────────────────────────────────────────
  cases: {
    note:
      "One row per matter. ~1,070 rows. The firm is a bankruptcy practice, so " +
      "case_type is 'Bankruptcy' on ~92% of rows and is a weak grouping " +
      "dimension. PK is case_id, a VARCHAR — not an integer.",
    columns: {
      case_id: { type: "varchar(20)", note: "PK. VARCHAR, not an int. Join target for case_relate.case_relate_case_id and (as text) appts.appt_case_id." },
      case_number: { type: "varchar(20)", note: "Short-form docket. Opaque free text — never parse its shape." },
      case_number_full: { type: "varchar(20)", note: "Full-form docket, e.g. '24-48734-mlo'. Court email log rows carry THIS form in log.log_link_id." },
      case_type: { type: "varchar(40)", note: "~92% 'Bankruptcy'. Also contains 'Other', 'Litigation', '' and at least one junk value ('potato hunting'). Low signal." },
      case_subtype: { type: "varchar(40)" },
      case_stage: {
        type: "enum('Open','Pending','Filed','Concluded','Closed')",
        note:
          "CURRENT stage only — cases.case_stage itself carries no history. " +
          "Live distribution (2026-08-19, after the discharge backfill): " +
          "Open 695, Closed 324, Filed 32, Concluded 13, Pending 13. " +
          "'Concluded' means discharge entered but no Final Decree yet — it " +
          "was a zero-row enum value until 2026-08-19 and is still small, so " +
          "do not treat it as a major bucket.",
      },
      case_status: { type: "varchar(50)", note: "Free-text status line, not a controlled vocabulary. Poor grouping dimension; expect long-tail near-duplicates." },
      case_chapter: { type: "char(2)", note: "'7' or '13'. EMPTY STRING on ~83% of rows (888 of 1068) — chapter is only recorded once a case is actually filed. Any chapter breakdown must state that it covers filed cases only." },
      case_open_date: { type: "date", note: "Populated on ~79% of cases. The most reliable date on this table." },
      case_file_date: { type: "date", note: "Petition filing date. Populated on only ~16% of cases (169 rows; the 5 former zero-date rows are now NULL). One case has a file date EARLIER than its open date, so a naive MIN(DATEDIFF(...)) over this pair returns a negative number — mention that in caveats or filter it out explicitly." },
      case_discharge_date: { type: "date", note: "Date the court entered the discharge order. Populated on 139 rows (~13%) as of 2026-08-19, backfilled from EDMI 'Order Discharging Debtor(s)' notices. DISTINCT from case_close_date, which is the Final Decree — discharge precedes closing, typically by a few days, and a case can be discharged with no close date yet. Absent does NOT mean not discharged for pre-2026-08 rows outside the backfilled set." },
      case_close_date: { type: "date", note: "Final Decree / case closed. Populated on ~27% of cases. Not a discharge date — see case_discharge_date; a case can be closed WITHOUT discharge (EDMI 'Case Closed Without Discharge and Final Decree')." },
      case_source: {
        type: "varchar(40)",
        note:
          "MARKETING LEAD SOURCE, staff-entered on the case Overview tab as of " +
          "2026-08. Free text suggested from the 'fe-lead_sources' vocabulary " +
          "(Google, Referral - Client, Referral - Attorney, Past Client, Radio, " +
          "TV, Social Media, Direct Mail, Walk-in, Other) — the column is NOT " +
          "constrained to it. LEGACY CAVEAT: rows written before 2026-08 carry " +
          "intake-channel junk from the old booking flow — 'https://api.calendly' " +
          "(~567 rows), 'Acuity' (~67) — and ~436 rows are NULL. Those values are " +
          "NOT lead sources and must be excluded from any lead-source or " +
          "attribution report: filter to the vocabulary list, or restrict by " +
          "case_open_date >= '2026-08-01'. Coverage will stay thin for months; " +
          "state the window and the exclusion in every such report.",
      },
      case_source_ref: { type: "varchar(100)" },
      case_primary_reason: { type: "varchar(100)", note: "Free text reason for filing. Sparse." },
      case_judge: { type: "varchar(100)", note: "Judge NAME as text, not a FK to judges.judge_id. Join by name if at all." },
      case_trustee: { type: "varchar(100)", note: "Trustee NAME as text, not a FK to trustees.trustee_id. Populated on ~16% of rows." },
      case_341_current: { type: "datetime", note: "Current scheduled 341 meeting datetime." },
      case_341_initial: { type: "date" },
      "341_status": { type: "enum('Continued','Completed')", note: "DEAD COLUMN — 'Continued' on 100% of 1074 rows (2026-08-08). It is a column default carrying ZERO signal; any '341 status breakdown' built on it is a single bar. Do not group, filter, or report on it. Column name starts with a digit — backtick-quote if referenced: `341_status`. Same for `341_appt_id`." },
      "341_appt_id": { type: "int", note: "Backtick-quote required. Links to appts.appt_id for the 341 hearing." },
      case_objection: { type: "date" },
      case_180: { type: "date" },
      case_preference: { type: "date" },
      docs_due: { type: "date" },
      matrix_date_original: { type: "date" },
      schedules_due_original: { type: "date" },

      // ── Remainder added 2026-08-08 for YisraView (work-list views). ──────
      // Fill rates measured live that day against n=1074. The SET columns
      // below are all subject to the MULTI-VALUE SET COLUMNS global note:
      // equality against one token matches nothing; use FIND_IN_SET.
      case_1st_course: {
        type: "set('Sent Info','Received','Filed')",
        note:
          "First credit-counseling course progress. SET column — see global " +
          "note. Non-empty on 191/1074 (18%). Observed values: '' 883, " +
          "'Sent Info,Received' 150, 'Filed' 37, 'Sent Info,Received,Filed' 2, " +
          "'Received,Filed' 2. WHERE case_1st_course = 'Received' returns " +
          "ZERO rows — use FIND_IN_SET('Received', case_1st_course). Tokens " +
          "are independent flags, not a cumulative ladder: most 'Filed' rows " +
          "carry neither 'Sent Info' nor 'Received'.",
      },
      case_2nd_course: {
        type: "set('Sent Info','Received','Filed')",
        note:
          "Second course (debtor education). SET column — see global note. " +
          "Non-empty on 108/1074 (10%): 'Sent Info,Received' 91, 'Filed' 16, " +
          "all three 1.",
      },
      case_pre_petition: {
        type: "set('Sent','Signed')",
        note:
          "Pre-petition contract progress. SET column — see global note. " +
          "Non-empty on 131/1074 (12%): 'Sent,Signed' 96, 'Signed' 35. Note " +
          "'Sent' alone never occurs live — a 'sent but not signed' filter is " +
          "FIND_IN_SET('Sent', col) AND NOT FIND_IN_SET('Signed', col) and " +
          "currently matches zero rows; say so rather than shipping an " +
          "always-empty view.",
      },
      case_post_petition: {
        type: "set('Sent','Signed','N/A')",
        note:
          "Post-petition contract progress. SET column — see global note. " +
          "Non-empty on 128/1074 (12%): 'Sent,Signed' 94, 'Signed' 31, " +
          "'Sent' 1, 'N/A' 2.",
      },
      case_garnish: {
        type: "set('Pre-Petition','Post-Petition')",
        note:
          "Garnishment flag. SET column. Non-empty on 223/1074 (21%): " +
          "'Pre-Petition' 222, 'Post-Petition' 1.",
      },
      case_issues_bk_vehicle: {
        type: "set('Reaffirmation','Redemption','Replacement')",
        note: "Effectively unused — 2/1074 rows non-empty.",
      },
      case_issues_bk_other: {
        type: "set('Automatic Stay Violation','Student Loans','Confirmation Objections','Other')",
        note: "Effectively unused — 2/1074 rows non-empty.",
      },
      matrix: {
        type: "set('Extension Motion','Uploaded')",
        note: "Creditor-matrix progress. SET column. Non-empty on 34/1074 (3%).",
      },
      matrix_date_proposed: { type: "date", note: "4/1074 rows. Proposed extension date for the matrix; matrix_date_original is the court's original deadline." },
      schedules: {
        type: "set('Extension Motion','Filed')",
        note: "Schedules progress. SET column. Non-empty on 32/1074 (3%).",
      },
      schedules_due_proposed: { type: "date", note: "3/1074 rows. Proposed extension date for schedules." },
      filing_fee: {
        type: "set('Order Uploaded','Order Issued','Show Cause','Deadline Extended','Fee Paid','Fee Waived')",
        note:
          "Installment filing-fee progress. SET column — see global note. " +
          "Non-empty on 21/1074 (2%): 'Fee Paid' 7, 'Order Uploaded' 5, " +
          "'Show Cause' 5, 'Deadline Extended' 3, 'Show Cause,Deadline " +
          "Extended' 1. Sparse because it only applies to installment-fee " +
          "cases.",
      },
      final_installment: { type: "date", note: "Final filing-fee installment due date. 129/1074 (12%)." },
      show_cause: { type: "datetime", note: "Order-to-show-cause hearing datetime, written by the court-email pipeline. 5/1074 rows — only live OSCs; it is cleared when the OSC is dissolved, so it is a CURRENT-state flag, not history." },
      filing_fee_extended_deadline: { type: "date", note: "5/1074 rows." },
      docs: {
        type: "set('Uploaded','Missing')",
        note: "Client-documents progress. SET column. Non-empty on 26/1074 (2%).",
      },
      docs_missing: { type: "text", note: "Free text listing which documents are missing. 20/1074 (2%). Partly staff shorthand; display, don't parse." },
      case_notes: {
        type: "text",
        note:
          "Free-text case notes. Non-empty on 423/1074 (39%). PARTLY " +
          "CLIENT-WRITTEN through intake forms — treat as untrusted display " +
          "text, and remember the author never sees result rows for exactly " +
          "this reason. Useful as a display column on work-list views; " +
          "useless for grouping.",
      },
      case_caption: { type: "varchar(150)", note: "Effectively unused — 7/1074 rows non-empty." },
      case_our_role: { type: "varchar(40)", note: "Effectively unused — 7/1074 rows non-empty." },
      case_rec: { type: "varchar(128)", note: "Attorney recommendation text. Effectively unused — 5/1074 rows, mostly test junk." },
      clio_matter: { type: "varchar(20)", note: "Clio matter number as displayed to staff. 130/1074 (12%). This — not the dead case_clio_id — is the Clio reference people mean." },
      case_dropbox: { type: "varchar(512)", note: "URL of the case's Dropbox folder. 1006/1074 (94%). A link column for views, not a grouping dimension. Widened from 255 in the S3.3 re-link slice; longest live value is 125." },
      case_341_link: { type: "varchar(255)", note: "Virtual 341-hearing URL (phone/video details). 168/1074 (16%)." },
      case_intake_form: { type: "varchar(20)", note: "Internal pointer to a form_submissions record, not a display value. 466/1074 (43%). Its main reporting use is EXISTENCE: NULLIF(case_intake_form,'') IS NOT NULL means an intake form was submitted." },
      case_detailed_form: { type: "varchar(20)", note: "Form-submission pointer, same semantics as case_intake_form. 126/1074 (12%)." },
      case_detailed_link: { type: "varchar(255)", note: "URL for the detailed form. 55/1074 (5%)." },
      case_ISSN_form: { type: "varchar(20)", note: "Form-submission pointer (income/SSN form). 483/1074 (45%)." },
      case_341_form: { type: "varchar(20)", note: "Form-submission pointer (341 prep form). 40/1074 (4%)." },
      // DELIBERATELY OMITTED dead columns (zero non-empty rows on 2026-08-08):
      // case_form, case_clio_id, `341_docs`, `341_amend`, `341_notes`,
      // case_alerts (1 row). They exist on the table and remain hand-selectable
      // (columns are opt-OUT), but listing them would only invite the author to
      // build on nothing. If one comes alive, add it back WITH its fill rate.
    },
  },

  case_relate: {
    note:
      "Join table between cases and contacts. This — not any column on cases — " +
      "is how you get from a case to its client. ~812 rows.",
    columns: {
      case_relate_id: { type: "int unsigned", note: "PK." },
      case_relate_case_id: { type: "varchar(8)", note: "→ cases.case_id." },
      case_relate_client_id: { type: "int unsigned", note: "→ contacts.contact_id." },
      case_relate_type: { type: "enum('Primary','Secondary','Other','Bystander')", note: "Filter to 'Primary' when you want one row per case; otherwise a joint filing yields two rows and doubles your counts." },
    },
  },

  // ── Contacts ─────────────────────────────────────────────────────────────
  contacts: {
    note:
      "People — clients, leads, and other parties. ~973 rows. contact_ssn and " +
      "contact_dob exist on this table but are DENIED; do not reference them.",
    columns: {
      contact_id: { type: "int unsigned", note: "PK." },
      contact_type: { type: "varchar(20)", note: "Free text classification. Inconsistent; inspect distinct values before grouping on it." },
      contact_name: { type: "varchar(50)", note: "Display name. contact_fname / contact_lname hold the parts." },
      contact_fname: { type: "varchar(20)" },
      contact_lname: { type: "varchar(30)" },
      contact_city: { type: "varchar(20)", note: "Denormalised legacy address on the contact row. contact_addresses is the current source of truth and the two can disagree." },
      contact_state: { type: "char(2)", note: "Legacy denormalised. See contact_addresses." },
      contact_zip: { type: "char(5)", note: "Legacy denormalised. See contact_addresses." },
      contact_marital_status: { type: "enum('Single','Married','Separated','Divorced','Widowed')" },
      contact_tags: { type: "varchar(255)", note: "COMMA-SEPARATED string, not a relation. Grouping on it directly gives you tag-combinations, not tags. Use FIND_IN_SET(...) to test membership." },
      contact_created: { type: "datetime", note: "Best available 'when did this person enter the system' signal." },
      contact_updated: { type: "timestamp", note: "Auto-updating. Useless as a business date — it changes on any write, including bulk syncs." },
      contact_sms_optout: { type: "tinyint(1)" },
      contact_email_optout: { type: "tinyint(1)" },
    },
  },

  contact_phones: {
    note:
      "Current phone numbers, one row per number. Effective-dated: a row is " +
      "CURRENT when end_date IS NULL. Forgetting that predicate silently " +
      "double-counts people who changed numbers.",
    columns: {
      id: { type: "int unsigned" },
      contact_id: { type: "int unsigned", note: "→ contacts.contact_id." },
      phone: { type: "char(10)", note: "10 digits, no formatting, no country code." },
      label: { type: "enum('Mobile','Home','Work','Office','Fax','Other')" },
      is_primary: { type: "tinyint(1)" },
      sms_optout: { type: "tinyint(1)" },
      end_date: { type: "date", note: "NULL = still current. ALWAYS filter `end_date IS NULL` unless you deliberately want history." },
      created_at: { type: "datetime" },
    },
  },

  contact_emails: {
    note: "Current email addresses. Same effective-dating rule as contact_phones — filter end_date IS NULL.",
    columns: {
      id: { type: "int unsigned" },
      contact_id: { type: "int unsigned", note: "→ contacts.contact_id." },
      email: { type: "varchar(100)" },
      label: { type: "enum('Personal','Work','Other')" },
      is_primary: { type: "tinyint(1)" },
      email_optout: { type: "tinyint(1)" },
      end_date: { type: "date", note: "NULL = still current. Always filter." },
      created_at: { type: "datetime" },
    },
  },

  contact_addresses: {
    note: "Current addresses; the source of truth over the denormalised contact_* address columns. Same effective-dating rule — filter end_date IS NULL.",
    columns: {
      id: { type: "int unsigned" },
      contact_id: { type: "int unsigned", note: "→ contacts.contact_id." },
      city: { type: "varchar(50)" },
      state: { type: "char(2)" },
      zip: { type: "varchar(10)" },
      label: { type: "enum('Home','Work','Mailing','Other')" },
      is_primary: { type: "tinyint(1)" },
      end_date: { type: "date", note: "NULL = still current. Always filter." },
      created_at: { type: "datetime" },
    },
  },

  // ── Appointments & calendar ──────────────────────────────────────────────
  appts: {
    note:
      "Appointments. ~2,150 rows and the richest behavioural dataset in the " +
      "system. One row per appointment, NOT per client — reschedules create " +
      "additional rows, so counts here are event counts.",
    columns: {
      appt_id: { type: "int", note: "PK." },
      appt_client_id: { type: "int", note: "→ contacts.contact_id." },
      appt_case_id: { type: "varchar(8)", note: "→ cases.case_id. Often empty for pre-engagement consults." },
      appt_type: { type: "varchar(60)", note: "Free text appointment type. Inspect distinct values before grouping." },
      appt_status: {
        type: "enum('Attended','No Show','Rescheduled','Canceled','Scheduled')",
        note:
          "Live distribution: Scheduled ~744, Attended ~646, Canceled ~280, " +
          "No Show ~264, Rescheduled ~253, plus 6 rows with an empty value. " +
          "'Scheduled' includes PAST appointments never reconciled, so a raw " +
          "show-rate over all time is misleading — bound it to a past window " +
          "and say so.",
      },
      appt_date: { type: "datetime", note: "Local-time appointment start. This is the column to filter and group on." },
      appt_date_utc: { type: "datetime", note: "UTC twin of appt_date. Do not mix the two in one comparison." },
      appt_end: { type: "datetime" },
      appt_length: { type: "tinyint", note: "Minutes." },
      appt_platform: { type: "enum('telephone','Zoom','in-person')" },
      appt_with: { type: "tinyint", note: "→ users.user — the staff member taking the appointment." },
      appt_source: { type: "varchar(60)", note: "Booking channel." },
      appt_create_date: { type: "datetime", note: "When it was booked. appt_date minus this gives booking lead time." },
    },
  },

  events: {
    note: "Calendar events — court dates, deadlines, and other dated items. ~131 rows. Distinct from appts.",
    columns: {
      event_id: { type: "int unsigned" },
      event_type: { type: "varchar(60)" },
      event_link_type: { type: "enum('case','contact','case_number')", note: "Discriminator for event_link_id — always pair the two in a join predicate." },
      event_link_id: { type: "varchar(20)", note: "Meaning depends on event_link_type." },
      event_title: { type: "varchar(200)" },
      event_date: { type: "date" },
      event_time: { type: "time" },
      event_status: { type: "enum('Scheduled','Completed','Canceled','Rescheduled')",
        note: "U6c: 'Rescheduled' means the row was superseded by a successor "
            + "event (paired with superseded_by_event_id). It is a TOMBSTONE — exclude it "
            + "from any 'what is on the calendar' report exactly as you would exclude "
            + "appt_status='Rescheduled'. 'Canceled' means the court cancelled it." },
      event_with: { type: "tinyint", note: "→ users.user." },
      event_created_by: { type: "tinyint", note: "→ users.user." },
      event_create_date: { type: "datetime" },
    },
  },

  firm_blocks: {
    note: "Blocked-out firm time (Shabbos, Yom Tov, manual blocks) driving availability. ~111 rows. Useful for capacity context, not client reporting.",
    columns: {
      block_id: { type: "int unsigned" },
      block_start: { type: "datetime" },
      block_end: { type: "datetime" },
      label: { type: "varchar(120)" },
      source: { type: "enum('shabbos','yom_tov','manual')" },
      active: { type: "tinyint(1)" },
    },
  },

  // ── Tasks & checklists ───────────────────────────────────────────────────
  tasks: {
    note:
      "Internal task list. Only ~55 rows live — the firm does not use this " +
      "heavily, so task-based productivity reports will look sparse and " +
      "should not be read as a measure of actual work done.",
    columns: {
      task_id: { type: "int unsigned" },
      task_status: { type: "enum('Pending','Due Today','Overdue','Completed','Canceled','Deleted')", note: "'Deleted' is a soft-delete state — exclude it from almost every report. Note the live data has more Deleted (19) than Completed (6)." },
      task_from: { type: "tinyint unsigned", note: "→ users.user, the assigner." },
      task_to: { type: "tinyint unsigned", note: "→ users.user, the assignee." },
      task_date: { type: "datetime", note: "Created." },
      task_due: { type: "date" },
      task_link_type: { type: "enum('contact','case','appt','bill','event')", note: "Discriminator for task_link_id." },
      task_link_id: { type: "varchar(20)" },
      task_title: { type: "varchar(100)" },
      task_last_update: { type: "datetime", note: "There is no explicit completed_at; this is the closest proxy for completion time on a Completed row." },
    },
  },

  checklists: {
    note: "Per-case/contact checklists. ~236 lists with ~1,742 items.",
    columns: {
      id: { type: "int" },
      title: { type: "varchar(255)" },
      status: { type: "enum('incomplete','complete')" },
      link_type: { type: "enum('contact','case','bill','appt','task','user')", note: "Discriminator for `link`." },
      link: { type: "varchar(20)", note: "The linked id; meaning depends on link_type." },
      tag: { type: "varchar(50)" },
      created_by: { type: "tinyint", note: "→ users.user." },
      created_date: { type: "datetime" },
      updated_date: { type: "datetime" },
    },
  },

  checkitems: {
    note: "Individual checklist items. ~1,742 rows.",
    columns: {
      id: { type: "int" },
      checklist_id: { type: "int", note: "→ checklists.id." },
      name: { type: "varchar(255)" },
      status: { type: "enum('incomplete','complete')" },
      position: { type: "int" },
      tag: { type: "varchar(50)" },
      created_date: { type: "datetime" },
      updated_date: { type: "datetime", note: "Closest proxy for 'when completed' on a complete row; there is no dedicated timestamp." },
    },
  },

  // ── Activity & communications ────────────────────────────────────────────
  log: {
    note:
      "THE activity log — ~50,000 rows and the largest reporting table. One " +
      "row per logged communication or event. Volume is dominated by SMS " +
      "(~32k) and email (~12.6k), so an ungrouped chart will be flattened by " +
      "those two. Always bound queries by log_date; an unbounded scan here is " +
      "the most likely source of a slow report.",
    columns: {
      log_id: { type: "int", note: "PK." },
      log_type: {
        type: "enum",
        note:
          "Values: email, sms, call, other, form, status, note, 'court email', " +
          "docs, appt, update, task, event, esign — plus a few empty strings. " +
          "Note 'court email' contains a SPACE.",
      },
      log_date: { type: "datetime", note: "Always filter on this. Indexed usage assumed." },
      log_link_type: { type: "enum('contact','case','appt','bill','phone','email','task','event')", note: "Discriminator for log_link_id. Pair them in every join." },
      log_link_id: { type: "varchar(255)", note: "For case rows this holds the FULL-form docket (e.g. '24-48734-mlo'), matching cases.case_number_full — NOT case_id." },
      log_by: { type: "tinyint unsigned", note: "→ users.user. 0 = Automations, i.e. system-generated, not a person." },
      log_direction: { type: "enum('incoming','outgoing')", note: "Only meaningful for communication types. NULL/empty on note/status/update rows." },
      log_from: { type: "varchar(100)" },
      log_to: { type: "varchar(100)" },
      log_subject: { type: "varchar(1000)" },
      log_data: { type: "text", note: "Free-text body of the log entry. Long and unstructured — good for spot-checking a row, useless as a grouping dimension." },
    },
  },

  email_log: {
    note:
      "Raw inbound email capture from the ingest pipeline (~21,700 rows). " +
      "This is plumbing, not the user-facing activity feed — `log` is what " +
      "staff see. Use email_log only for ingest-pipeline questions.",
    columns: {
      id: { type: "int" },
      source: { type: "varchar(64)", note: "Which ingest source delivered it." },
      from_email: { type: "varchar(255)" },
      to_email: { type: "varchar(255)" },
      subject: { type: "text" },
      processed_at: { type: "datetime", note: "Filter on this." },
    },
  },

  // ── Forms, signatures, campaigns, sequences ──────────────────────────────
  form_submissions: {
    note: "YisraForm submissions (~140 rows). `data` is a JSON blob whose shape varies per form_key; extract with JSON_EXTRACT / ->> and expect nulls.",
    columns: {
      id: { type: "bigint unsigned" },
      form_key: { type: "varchar(50)", note: "Which form. Group by this before touching `data`." },
      link_type: { type: "varchar(20)", note: "Discriminator for link_id." },
      link_id: { type: "varchar(20)" },
      status: { type: "enum('draft','submitted')", note: "Filter to 'submitted' for anything reported as a real submission." },
      schema_version: { type: "int unsigned" },
      submitted_by: { type: "int unsigned" },
      created_at: { type: "datetime" },
      updated_at: { type: "datetime" },
    },
  },

  signing_requests: {
    note: "E-signature requests via Zoho Sign (~31 rows — the integration is new, so volumes are small and trends are not yet meaningful).",
    columns: {
      id: { type: "int unsigned" },
      provider: { type: "varchar(32)" },
      linkable_type: { type: "varchar(64)", note: "Discriminator for linkable_id." },
      linkable_id: { type: "varchar(64)" },
      kind: { type: "varchar(64)" },
      status: { type: "varchar(32)", note: "Free-text-ish status from the provider, not a DB enum." },
      document_name: { type: "varchar(255)" },
      sent_at: { type: "datetime" },
      completed_at: { type: "datetime", note: "completed_at minus sent_at gives turnaround time." },
      expires_at: { type: "datetime" },
      created_by: { type: "int unsigned", note: "→ users.user." },
      created_at: { type: "datetime" },
    },
  },

  campaigns: {
    note: "Bulk SMS/email campaigns (~102 rows).",
    columns: {
      campaign_id: { type: "int" },
      type: { type: "enum('sms','email')" },
      subject: { type: "text" },
      status: { type: "enum('draft','scheduled','sending','sent','failed','partial_fail','canceled')" },
      scheduled_time: { type: "datetime" },
      contact_count: { type: "int unsigned", note: "Denormalised recipient count; campaign_results is the authoritative per-recipient record." },
      created_by: { type: "tinyint unsigned", note: "→ users.user." },
      created: { type: "timestamp" },
    },
  },

  campaign_results: {
    note: "Per-recipient campaign outcome (~203 rows). UNIQUE on (campaign_id, contact_id), so one row per recipient per campaign.",
    columns: {
      result_id: { type: "int" },
      campaign_id: { type: "int", note: "→ campaigns.campaign_id." },
      contact_id: { type: "int", note: "→ contacts.contact_id." },
      status: { type: "enum('sent','failed','skipped')" },
      sent_at: { type: "datetime" },
    },
  },

  campaign_contacts: {
    note: "Campaign recipient list (~144 rows) — who was targeted, as opposed to campaign_results' what happened.",
    columns: {
      id: { type: "int unsigned" },
      campaign_id: { type: "int", note: "→ campaigns.campaign_id." },
      contact_id: { type: "int unsigned", note: "→ contacts.contact_id." },
    },
  },

  sequence_enrollments: {
    note: "Automation sequence enrollments (~86 rows).",
    columns: {
      id: { type: "bigint unsigned" },
      template_id: { type: "int unsigned" },
      contact_id: { type: "int unsigned", note: "→ contacts.contact_id." },
      status: { type: "enum('active','completed','cancelled')" },
      current_step: { type: "int unsigned" },
      total_steps: { type: "int unsigned" },
      cancel_reason: { type: "varchar(200)" },
      enrolled_at: { type: "datetime" },
      completed_at: { type: "datetime" },
    },
  },

  // ── Reference ────────────────────────────────────────────────────────────
  users: {
    note:
      "Staff (9 rows). Join target for every *_by / *_with / *_to / *_from " +
      "column via `user` (TINYINT), NOT `username`. user 0 = 'Automations' " +
      "(system, not a person). Password and reset columns are DENIED.",
    columns: {
      user: { type: "tinyint", note: "THE staff id. Join on this." },
      user_name: { type: "varchar(20)", note: "Display name, e.g. 'Stuart Sandweiss'." },
      user_initials: { type: "varchar(3)" },
      user_auth: { type: "varchar(20)", note: "'authorized' or 'authorized - SU'. Only a coarse role signal." },
      does_appts: { type: "tinyint(1)", note: "Whether this user takes appointments." },
    },
  },

  trustees: {
    note: "Bankruptcy trustee reference list (22 rows). cases.case_trustee stores a NAME, not trustee_id, so joining requires a name match and may miss.",
    columns: {
      trustee_id: { type: "int" },
      trustee_full_name: { type: "varchar(22)" },
      trustee_lname: { type: "varchar(11)" },
      trustee_city: { type: "varchar(16)" },
      trustee_state: { type: "varchar(2)" },
    },
  },

  judges: {
    note: "Judge reference list (7 rows). cases.case_judge stores a NAME, not judge_id.",
    columns: {
      judge_id: { type: "tinyint unsigned" },
      judge_3: { type: "char(3)", note: "Three-letter code appearing as the suffix of full-form dockets, e.g. the 'mlo' in '24-48734-mlo'." },
      judge_name: { type: "varchar(50)" },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Derived lookups + helpers
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_TABLES = new Set(Object.keys(TABLES));
const DENIED_TABLE_SET = new Set(DENIED_TABLES.map((t) => t.toLowerCase()));
const DENIED_COLUMN_SET = new Set(DENIED_COLUMNS.map((c) => c.toLowerCase()));

/** Is this table name reportable? */
function isAllowedTable(name) {
  return ALLOWED_TABLES.has(String(name || "").toLowerCase());
}

/** Is this an explicitly forbidden table? */
function isDeniedTable(name) {
  return DENIED_TABLE_SET.has(String(name || "").toLowerCase());
}

/** Is this an explicitly forbidden column, anywhere? */
function isDeniedColumn(name) {
  return DENIED_COLUMN_SET.has(String(name || "").toLowerCase());
}

/**
 * Render the manifest as compact prompt context for the Slice 3 AI author.
 * Kept here (not in the prompt file) so there is exactly one place where
 * reporting schema knowledge lives.
 *
 * @returns {string}
 */
function toPromptContext() {
  const lines = [];

  lines.push("## Global rules");
  for (const n of GLOBAL_NOTES) lines.push(`- ${n}`);
  lines.push("");
  lines.push(
    `## Forbidden columns (never reference, in any form): ${DENIED_COLUMNS.join(", ")}`
  );
  lines.push("");
  lines.push("## Tables (ONLY these exist for reporting purposes)");

  for (const [table, def] of Object.entries(TABLES)) {
    lines.push("");
    lines.push(`### ${table}`);
    if (def.note) lines.push(def.note);
    for (const [col, meta] of Object.entries(def.columns || {})) {
      const bits = [`  - ${col} (${meta.type || "?"})`];
      if (meta.note) bits.push(`— ${meta.note}`);
      lines.push(bits.join(" "));
    }
  }

  return lines.join("\n");
}

/** Small summary for the UI's "what can I ask about?" panel. */
function summary() {
  return Object.entries(TABLES).map(([table, def]) => ({
    table,
    note: def.note || null,
    columnCount: Object.keys(def.columns || {}).length,
  }));
}

module.exports = {
  TABLES,
  GLOBAL_NOTES,
  DENIED_COLUMNS,
  DENIED_TABLES,
  ALLOWED_TABLES,
  isAllowedTable,
  isDeniedTable,
  isDeniedColumn,
  toPromptContext,
  summary,
};