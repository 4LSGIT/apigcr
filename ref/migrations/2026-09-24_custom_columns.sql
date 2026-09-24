-- ref/migrations/2026-09-24_custom_columns.sql
--
-- Custom-fields arc S2 — the value storage (ref/CUSTOM_FIELDS_DESIGN.md §2–§3,
-- §7 S2 row). One JSON bag per entity row: `cases.custom`, `contacts.custom`,
-- keyed by `field_defs.field_key` (cf_*). S2 creates the columns and the write
-- path ONLY: no virtual columns (S3), no renderers/consumers (S4), no pilot
-- data (S5). After this runs every row holds `{}` and the only writer is the
-- chokepoint in caseService.updateCase / contactService.updateContact
-- (services/fieldDefService.js: splitCustomFields + customAssignment).
--
-- DEPLOY ORDER: run this BEFORE the backend that ships the S2 chokepoint
-- (SQL → backend → frontend). That backend composes `custom = JSON_SET(custom,
-- …)` into every cf_ write, and the def PATCH path probes `custom` for the
-- post-data locks — without the column both fail with ER_BAD_FIELD_ERROR.
-- The OLD backend is unaffected by the column (it never names it; SELECT *
-- simply returns one more key, `custom: {}`).
--
-- WHY NOT NULL DEFAULT (JSON_OBJECT()): JSON_SET(NULL, …) is NULL, so a NULL
-- bag would silently swallow the first write; and `->>` on a stored JSON null
-- returns the STRING 'null'. Every row therefore starts as `{}` and a cleared
-- field is a JSON_REMOVEd key, never a JSON null.
--
-- ONLINE DDL — THIS IS A TABLE REBUILD (ALGORITHM=COPY), NOT INSTANT.
-- Measured 2026-09-24 on MySQL 9.6.0 at prod sql_mode: any column with an
-- EXPRESSION default — even `varchar DEFAULT ('x')` — refuses both INSTANT
-- and INPLACE (ERROR 1845 "Try ALGORITHM=COPY"); `JSON NULL` and a literal
-- default are INSTANT. The expression default is not negotiable (a NOT NULL
-- JSON column without one fills existing rows and default-less INSERTs with
-- NULL), so COPY it is, spelled out so the statement behaves the same on
-- prod's 8.4.6 whatever 8.4 would pick. What that means here:
--   - both tables are ~1.1k rows: the copy is sub-second. Reads continue
--     (COPY's default LOCK=SHARED); writes to the table wait for it.
--   - it needs the table's metadata lock: a long-open transaction on
--     cases/contacts makes it wait (and queues writes behind it). Run it in a
--     quiet minute; SHOW PROCESSLIST if it hangs.
--   - a rebuild RESETS the table's instant-DDL row-version counter (64 max)
--     to 0 — it spends none, the opposite of an INSTANT add. (S3's virtual
--     columns are INSTANT and spend none either — design doc §3.)
--   - triggers (after_contact_update, contact_name_*, trg_cases_ct_compat_*)
--     and the child tables' FKs into contacts survive the rebuild (verified
--     locally with an FK child + AFTER UPDATE trigger).
--
-- COLUMN COMMENTs carry the invariants (they flow into ref/database.sql and
-- are what the next reader of the schema sees):
--   - keys are cf_* per field_defs; one per def, the def's field_key
--   - NEVER read or compare `custom->>'$.k'` in SQL — case-sensitive compare,
--     and a functional index can flip results (design doc §2). S3's named,
--     collated VIRTUAL column is the only comparison surface.
--     tests/customFields.s2.test.js greps lib/ services/ routes/ for it.
--   - never store JSON null; clear = JSON_REMOVE
--   - never read-modify-write the bag in JS; per-key JSON_SET inside the same
--     UPDATE as the core columns
--   - excluded BY NAME from domainEvents envelopes, resolver placeholders and
--     reports — the bag never travels whole
--
-- JSON columns carry no collation (utf8mb4_bin internally) — nothing to
-- declare per ref/SCHEMA_CONVENTIONS.md. `custom` is appended as the table's
-- LAST column (no AFTER clause).
--
-- STANDALONE statements (the DB console runs each on its own pooled connection).
--
-- After applying:  npm run db:ref   (regenerates ref/database.sql)
--                  npm run db:ref:check   (must report no drift)

ALTER TABLE `cases`
  ADD COLUMN `custom` JSON NOT NULL DEFAULT (JSON_OBJECT())
  COMMENT 'Custom-field values (ref/CUSTOM_FIELDS_DESIGN.md). Keys are field_defs.field_key (cf_*, entity=case). Written ONLY by caseService.updateCase: per-key JSON_SET/JSON_REMOVE in the same UPDATE as core columns, never read-modify-write. NEVER read or compare custom->>''$.k'' in SQL (the S3 virtual column is the only comparison surface). Never store JSON null (clear = JSON_REMOVE). Excluded by name from event envelopes, resolver and reports.',
  ALGORITHM=COPY;

ALTER TABLE `contacts`
  ADD COLUMN `custom` JSON NOT NULL DEFAULT (JSON_OBJECT())
  COMMENT 'Custom-field values (ref/CUSTOM_FIELDS_DESIGN.md). Keys are field_defs.field_key (cf_*, entity=contact). Written ONLY by contactService.updateContact: per-key JSON_SET/JSON_REMOVE in the same UPDATE as core columns, never read-modify-write. NEVER read or compare custom->>''$.k'' in SQL (the S3 virtual column is the only comparison surface). Never store JSON null (clear = JSON_REMOVE). Excluded by name from event envelopes, resolver and reports.',
  ALGORITHM=COPY;
