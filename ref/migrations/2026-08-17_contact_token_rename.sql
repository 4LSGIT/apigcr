-- ============================================================================
-- contacts.booking_token → contacts.contact_token (2026-08-17)
--
-- Companion to the code rename in: routes/booking.js, services/contactService.js,
-- lib/domainEvents.js, lib/reportSchema/manifest.js, public/campaign.html,
-- routes/pageLanding.js (comments), tests/triggerService.test.js.
--
-- WHY: the column is a per-contact 32-hex bearer. It was named for the only
-- thing that used it. It now also identifies the contact on video landing
-- pages (?ct=), so "booking_token" had become a lie about its scope. Nothing
-- about the VALUES changes — same tokens, same contacts, same semantics.
--
-- ZERO BEHAVIOR CHANGE. This migration and its code commit are a pure rename.
-- The video ?ct= work rides on top as a separate commit.
--
-- SAFETY NOTES
--   * MySQL 8.4: RENAME COLUMN is an INSTANT, metadata-only operation and
--     carries the existing index (idx on booking_token) automatically. No
--     table copy, no lock of consequence, no reindex.
--   * The column's charset/collation are preserved by a rename — this does
--     NOT interact with ref/SCHEMA_CONVENTIONS.md's collation rule, which
--     governs CREATE TABLE only.
--   * ref/database.sql must be regenerated after this runs:  npm run db:ref
--     (tests/schemaConventions.test.js lints that dump in CI.)
--
-- SWEEP RESULTS (verified live 2026-08-17 — re-run § 0 before shipping):
--   sequence_steps / workflow_steps / app_settings / pages  referencing
--     {{contacts.booking_token}}                                    → 0 rows
--   trigger_rules.match_config / transform_config,
--     trigger_rule_actions.config  (10 live rules)                  → 0 rows
--   report_definitions.sql_text / columns_meta / params             → 0 rows
--   campaigns.body                                                  → 1 row,
--     status='sent' (history; nothing re-sends from it)
--   contacts holding a token                             → 1036 of 1041
-- So there is NO authored content to rewrite. The only live consumer of the
-- name is code, which the companion commit changes in the same deploy.
--
-- DEPLOY ORDER IS UNUSUAL FOR THIS ONE — see § 2.
-- ============================================================================


-- ── 0. Verify BEFORE ────────────────────────────────────────────────────────
-- Column exists under the old name, new name does not:
SELECT column_name, column_type, is_nullable, collation_name
  FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'contacts'
   AND column_name IN ('booking_token', 'contact_token');
-- Expect: exactly one row, 'booking_token'.

-- Index inventory (so you can confirm it survives in § 3):
SELECT index_name, seq_in_index, column_name
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'contacts'
   AND column_name = 'booking_token';
-- Expect: 1 row (verified 2026-08-17).

-- Re-run the authored-content sweep — new rows may exist since 2026-08-17:
SELECT id FROM sequence_steps  WHERE action_config    LIKE '%booking_token%';  -- expect 0
SELECT id FROM workflow_steps  WHERE config           LIKE '%booking_token%';  -- expect 0
SELECT `key` FROM app_settings WHERE `value`          LIKE '%booking_token%';  -- expect 0
SELECT id FROM pages           WHERE html             LIKE '%booking_token%';  -- expect 0
SELECT id FROM trigger_rules   WHERE match_config     LIKE '%booking_token%'
                                  OR transform_config LIKE '%booking_token%';  -- expect 0
SELECT id FROM trigger_rule_actions WHERE config      LIKE '%booking_token%';  -- expect 0
SELECT id FROM report_definitions   WHERE sql_text    LIKE '%booking_token%'
                                       OR columns_meta LIKE '%booking_token%'
                                       OR params      LIKE '%booking_token%';  -- expect 0
SELECT campaign_id, status FROM campaigns WHERE body  LIKE '%booking_token%';
-- Expect: only already-'sent' rows. A DRAFT or SCHEDULED row here is a STOP —
-- its placeholder would fail to resolve at send time after the rename (the
-- resolver builds SQL from the column name and validates against
-- information_schema, so it fails loudly rather than sending a broken link).
-- Fix such a row by editing the placeholder to {{contacts.contact_token}}
-- BEFORE running § 1.


-- ── 1. The rename ───────────────────────────────────────────────────────────
-- Both statements are INSTANT metadata operations. RENAME COLUMN carries the
-- index automatically but KEEPS ITS OLD NAME, so the index is renamed too —
-- otherwise the schema is left with `uq_contacts_booking_token` indexing a
-- column called contact_token, which is exactly the kind of stale breadcrumb
-- that costs someone an hour in six months.
ALTER TABLE contacts RENAME COLUMN booking_token TO contact_token;
ALTER TABLE contacts RENAME INDEX uq_contacts_booking_token TO uq_contacts_contact_token;

-- Widen the comment to match the column's real scope (optional, cosmetic —
-- but the old one said "link-prefill", which now undersells it):
ALTER TABLE contacts MODIFY COLUMN contact_token char(32)
  COLLATE utf8mb4_general_ci DEFAULT NULL
  COMMENT 'opaque per-contact bearer: booking prefill + video attribution';


-- ── 2. Deploy order ─────────────────────────────────────────────────────────
-- NOTE: this is the one case where SQL-then-code is NOT a free choice — the
-- old code queries `booking_token` by name, so between § 1 and the code
-- deploy, booking-link mint/lookup (routes/booking.js) throws. Options:
--   (a) run § 1 immediately before the backend deploy — a seconds-long window,
--       and the affected surface is booking-link minting, not booking itself;
--   (b) if even that is unacceptable, add a generated-column shim first:
--         ALTER TABLE contacts ADD COLUMN booking_token VARCHAR(64)
--           GENERATED ALWAYS AS (contact_token) VIRTUAL;
--       deploy code, then drop the shim. Reads work through it; the UPDATE in
--       routes/booking.js's mint path does NOT (generated columns are not
--       writable), so (b) only helps if you deploy code promptly after.
-- (a) is the recommendation at this firm's scale and traffic.


-- ── 3. Verify AFTER ─────────────────────────────────────────────────────────
SELECT column_name, column_type, is_nullable, collation_name
  FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'contacts'
   AND column_name IN ('booking_token', 'contact_token');
-- Expect: exactly one row, 'contact_token', SAME column_type and
-- collation_name as the § 0 output.

SELECT index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'contacts'
   AND column_name = 'contact_token';
-- Expect: 1 row — index_name 'uq_contacts_contact_token', non_unique = 0.
-- If index_name still reads 'uq_contacts_booking_token', the second ALTER in
-- § 1 did not run. Harmless to behavior, but re-run it.

SELECT COUNT(*) AS contacts_with_token
  FROM contacts WHERE contact_token IS NOT NULL AND contact_token <> '';
-- Expect: 1036 (or higher — contacts created since). NOT zero.

-- Then: npm run db:ref   (regenerates ref/database.sql; CI lints it)


-- ── 4. Inverse revert ───────────────────────────────────────────────────────
-- Revert the code commit and run:
-- ALTER TABLE contacts RENAME COLUMN contact_token TO booking_token;
-- ALTER TABLE contacts RENAME INDEX uq_contacts_contact_token TO uq_contacts_booking_token;
-- Values are untouched by either direction, so this is lossless both ways.
