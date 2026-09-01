-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-01 — Unified Events U6b: appts gain the event anchor shape (A3a)
-- ref/2026-09-01_unified_events_u6b.sql
--
-- Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.4.1 (A3/A3a), §3.6,
-- §7 (U6b), §7.1 (live-safety rules). Worker: Fable. Slice owner: CAL.
-- Depends on U6a (deployed 2026-09-01, flag off).
--
-- WHY
--   Events anchor through (event_link_type, event_link_id) — 'case', 'contact'
--   or 'case_number' (an unresolved docket that resolves query-side the moment
--   the case exists). Appts anchor through two hard columns: appt_case_id
--   (varchar(8), '' when none) and appt_client_id. Court-v2 (U7) writes 341s
--   into appts (A3, ruled yes 2026-09-01) and a court email can arrive before
--   the case does — so appts need the same third form: docket-anchored,
--   client-less, resolving query-side forever exactly as events do. No
--   adoption hook; the docket is the anchor.
--
--   appt_case_id KEEPS being written when the link is 'case' (nothing
--   downstream breaks); appt_client_id becomes "the client attendee" (§3.6),
--   already nullable. The new pair is DERIVED on every write path
--   (createAppt anchor rules; PATCH surfaces rewrite it when appt_case_id /
--   appt_client_id change; direct PATCH of the pair itself is rejected).
--
-- COLLATION (SCHEMA_CONVENTIONS / 2026-08-17 normalization): house collation
--   utf8mb4_general_ci, stated EXPLICITLY — a bare CHARSET on MySQL 8 silently
--   yields 0900_ai_ci and breaks joins. Dockets are case-insensitive
--   identifiers (matches events.event_link_id and cases.case_number), NOT
--   Dropbox-style case-sensitive ids, so _bin is wrong here.
--
-- VARCHAR(20): matches events.event_link_id-shaped payloads this column will
--   actually hold — a case_id (8), a contact id (int-as-char), or a docket
--   ('26-46639-mar' = 12; full-form max observed 13). events.event_link_id is
--   wider for historical reasons; 20 is deliberate head-room without inviting
--   free text.
--
-- Additive only (§7.1 rule 1). No FK (appts carries none, by convention).
-- No session variables. Idempotent backfill (WHERE appt_link_type IS NULL).
--
-- DEPLOY ORDER: this SQL → backend (§7.1 rule 5). The columns are unread and
-- unwritten by the previous revision, so the window between the two is inert.
-- After applying: POST /admin/db/schema/save-to-ref to regenerate
-- ref/database.sql.
--
-- ROLLBACK (after backend rollback only — the new backend writes the pair):
--   ALTER TABLE appts DROP COLUMN appt_link_id, DROP COLUMN appt_link_type;
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Columns + index -----------------------------------------------------------

ALTER TABLE appts
  ADD COLUMN appt_link_type ENUM('case','contact','case_number')
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL
    COMMENT 'A3a anchor form. Derived by apptService (create + PATCH rewrites); NULL = unlinked (held slot) or pre-backfill. case_number = docket-anchored, resolves query-side.'
    AFTER appt_case_id,
  ADD COLUMN appt_link_id VARCHAR(20)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL
    COMMENT 'Anchor id for appt_link_type: case_id | contact_id | docket (either form). Derived, never PATCHed directly.'
    AFTER appt_link_type;

ALTER TABLE appts
  ADD KEY idx_appts_link (appt_link_type, appt_link_id);

-- 2) Backfill (idempotent) -----------------------------------------------------
--
--   appt_case_id <> ''            → ('case', appt_case_id)
--   else appt_client_id NOT NULL  → ('contact', appt_client_id)
--   else                          → NULL (the audit's `unlinked` shape — a held
--                                   slot / blocked hour; 12 rows, legitimate)
--
-- TRIM note: live census 2026-09-01 shows 0 rows where TRIM(appt_case_id) <>
-- appt_case_id, so the bare <> '' test is exact. Stated so a future
-- whitespace row is caught by the VERIFY below, not silently mislinked.

UPDATE appts
   SET appt_link_type = 'case',
       appt_link_id   = appt_case_id
 WHERE appt_link_type IS NULL
   AND appt_case_id <> '';

UPDATE appts
   SET appt_link_type = 'contact',
       appt_link_id   = CAST(appt_client_id AS CHAR)
 WHERE appt_link_type IS NULL
   AND appt_client_id IS NOT NULL;

-- 3) VERIFY --------------------------------------------------------------------
-- Live census 2026-09-01 (re-derive at apply time; the table moves daily):
--   total 2,220 · case 2,162 · contact 46 · NULL (unlinked) 12
-- Expectations, independent of drift between census and apply:
--   a) NULL count == rows with appt_case_id='' AND appt_client_id IS NULL
--      (must equal the U3 audit's appts `unlinked` figure — 12 as of census)
--   b) ('case', x) count == rows with appt_case_id <> ''
--   c) zero rows where the pair is half-written
--   d) zero 'case' rows whose link_id disagrees with appt_case_id

SELECT appt_link_type, COUNT(*) AS n
  FROM appts
 GROUP BY appt_link_type
 ORDER BY appt_link_type;

SELECT
  (SELECT COUNT(*) FROM appts WHERE appt_link_type IS NULL)                          AS still_null,
  (SELECT COUNT(*) FROM appts WHERE appt_case_id = '' AND appt_client_id IS NULL)    AS expect_null,
  (SELECT COUNT(*) FROM appts WHERE appt_link_type = 'case')                         AS linked_case,
  (SELECT COUNT(*) FROM appts WHERE appt_case_id <> '')                              AS expect_case,
  (SELECT COUNT(*) FROM appts
    WHERE (appt_link_type IS NULL) <> (appt_link_id IS NULL))                        AS half_written,
  (SELECT COUNT(*) FROM appts
    WHERE appt_link_type = 'case' AND appt_link_id <> appt_case_id)                  AS case_mismatch;
-- Expect: still_null = expect_null (12 at census), linked_case = expect_case
--         (2,162 at census), half_written = 0, case_mismatch = 0.
