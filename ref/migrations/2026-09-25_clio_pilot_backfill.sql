-- ref/migrations/2026-09-25_clio_pilot_backfill.sql
--
-- Custom-fields arc S5-A — the PILOT MIGRATION: the two live Clio-ref columns
-- move into the custom bag (ref/CUSTOM_FIELDS_DESIGN.md §7 S5). This is the
-- arc's thesis on real data, and the template for every future surplus-column
-- retirement, so the recipe is spelled out rather than assumed:
--
--     1. create the def          (scripts/customFieldsS5Seed.js --apply)
--     2. reconcile → the VIRTUAL column exists   (same script, verified)
--     3. THIS FILE: copy old column → custom bag, verify by the virtual column
--     4. backend deploy: freeze the old column's writes, repoint reads
--     5. soak
--     6. S5-B: drop the column, drop the freeze
--
--   cases.clio_matter          → custom.$.cf_clio_matter   (240 / 1,091 filled)
--   contacts.contact_clio_id   → custom.$.cf_clio_id       (245 / 1,088 filled)
--   cases.case_clio_id         → nothing. 0 / 1,091 filled: dead on arrival,
--                                dropped in S5-B with no migration at all.
--
-- Counts verified live 2026-09-25. All three columns are varchar(20) NOT NULL
-- with no default, so the empty value is '' and there are no NULLs; the
-- longest live value in either live column is 10 characters, far under the
-- 255-character cap the text field_type imposes (design doc §2).
--
-- RUN ORDER IS ABSOLUTE. Steps 1–2 come FIRST: without the virtual columns
-- the verification below cannot run (ER_BAD_FIELD_ERROR) and nothing can
-- query the migrated values. Step 4 comes AFTER: the backend that ships the
-- write freeze also repoints lookup_contact onto `cf_clio_id`.
--
-- RAW SQL, BY DESIGN — and these are the consequences, stated rather than
-- discovered later:
--   - NO domain events. Nothing emits case.updated / contact.updated for
--     these 485 rows. Trigger rules do not see the migration, which is the
--     point: 485 envelopes would be noise, and any rule watching these
--     fields would fire on a bookkeeping move.
--   - NO log rows on the case side, and NO app-side contact log rows. The
--     `after_contact_update` DB trigger compares 17 NAMED columns; `custom`
--     is not one of them, so a bag-only UPDATE leaves it nothing to say and
--     it inserts nothing. (Proved on a real engine in S4.)
--   - NO `contact_updated` bump. That column has NO `ON UPDATE` clause —
--     EXTRA is empty, verified live 2026-09-25; every write path bumps it
--     explicitly, and this one does not. That matters: `contact_updated` is
--     what terminates the Google contacts drift sweep, so an UPDATE that
--     set it would hand gContactsService 245 contacts to re-push for a
--     change Google has no field for. (The report manifest calls the column
--     "auto-updating" — it is wrong; filed in scratch ns=docs.)
--   - The old columns are left ALONE. They still hold their values and still
--     read; S5-B drops them. Nothing is destroyed here, and the migration is
--     reversible by deleting the two JSON keys.
--
-- JSON_SET, NOT JSON_MERGE_PATCH: per-key set on a bag that is `{}` on every
-- row today, and per-key is the rule even when it is not (§3 — the bag is
-- never read-modify-written). The value lands as a JSON STRING, matching what
-- the chokepoint writes for a `text` field, so the virtual column
-- (JSON_VALUE(... RETURNING CHAR(255))) reads it identically either way.
--
-- WHERE <col> <> '' — only non-empty values migrate. An empty source must
-- leave the key ABSENT, not present-and-empty: absent is how "no value" is
-- spelled in this design (§3 — clearing a field is JSON_REMOVE, never a
-- stored null or empty), and it is what makes `cf_x IS NULL` mean what a
-- reader expects.
--
-- STANDALONE statements (the DB console runs each on its own pooled
-- connection). Non-strict sql_mode throughout — no behaviour here depends on
-- it, but do not add STRICT_TRANS_TABLES to "be safe" (CLAUDE.md).
--
-- After applying:  npm run db:ref:check   (must report NO drift — this
--                  migration changes DATA, not schema; the virtual columns
--                  came from step 2's reconciler and are already in
--                  ref/database.sql if that was regenerated then.)

-- ─────────────────────────────────────────────────────────────────────────
-- 1. cases.clio_matter → custom.$.cf_clio_matter
-- ─────────────────────────────────────────────────────────────────────────
UPDATE `cases`
   SET `custom` = JSON_SET(`custom`, '$.cf_clio_matter', `clio_matter`)
 WHERE `clio_matter` <> '';
-- expect: 240 rows affected

-- ─────────────────────────────────────────────────────────────────────────
-- 2. contacts.contact_clio_id → custom.$.cf_clio_id
-- ─────────────────────────────────────────────────────────────────────────
UPDATE `contacts`
   SET `custom` = JSON_SET(`custom`, '$.cf_clio_id', `contact_clio_id`)
 WHERE `contact_clio_id` <> '';
-- expect: 245 rows affected


-- ═════════════════════════════════════════════════════════════════════════
-- VERIFICATION — run all four. Every one must come back as stated.
--
-- These read the VIRTUAL COLUMN, not the JSON path. That is the whole point
-- of the S3 surface: the column is what every consumer will actually see, so
-- proving old-column == virtual-column proves the migration end to end —
-- storage, JSON type, JSON_VALUE extraction, width and collation in one go.
-- Comparing `custom->>'$.cf_x'` instead would prove something weaker AND
-- compare under utf8mb4_bin (design doc §2).
--
-- `<=>` is the NULL-safe equality: NULL <=> NULL is TRUE, so a row that is
-- empty on both sides passes rather than evaluating to NULL and vanishing
-- from a `NOT (...)` filter. NULLIF(old,'') maps the '' sentinel to NULL so
-- the two sides are comparable at all.
-- ═════════════════════════════════════════════════════════════════════════

-- V1 — cases: counts agree (240 = 240 = 240), and nothing else grew a key.
SELECT
  SUM(`clio_matter` <> '')            AS old_filled,      -- expect 240
  SUM(`cf_clio_matter` IS NOT NULL)   AS new_filled,      -- expect 240
  SUM(JSON_LENGTH(`custom`) > 0)      AS rows_with_bag,   -- expect 240
  SUM(JSON_LENGTH(`custom`) > 1)      AS rows_over_one_key -- expect 0
FROM `cases`;

-- V2 — cases: zero rows where the two disagree. THE gate.
SELECT COUNT(*) AS mismatches          -- expect 0
FROM `cases`
WHERE NOT (`cf_clio_matter` <=> NULLIF(`clio_matter`, ''));

-- V3 — contacts: counts agree (245 = 245 = 245).
SELECT
  SUM(`contact_clio_id` <> '')        AS old_filled,      -- expect 245
  SUM(`cf_clio_id` IS NOT NULL)       AS new_filled,      -- expect 245
  SUM(JSON_LENGTH(`custom`) > 0)      AS rows_with_bag,   -- expect 245
  SUM(JSON_LENGTH(`custom`) > 1)      AS rows_over_one_key -- expect 0
FROM `contacts`;

-- V4 — contacts: zero rows where the two disagree. THE gate.
SELECT COUNT(*) AS mismatches          -- expect 0
FROM `contacts`
WHERE NOT (`cf_clio_id` <=> NULLIF(`contact_clio_id`, ''));


-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (Phase A only — meaningless once S5-B has dropped the columns).
-- Removes the migrated keys and returns every bag to {}. The old columns were
-- never touched, so this restores the pre-migration state exactly.
-- ═════════════════════════════════════════════════════════════════════════
-- UPDATE `cases`    SET `custom` = JSON_REMOVE(`custom`, '$.cf_clio_matter')
--  WHERE JSON_CONTAINS_PATH(`custom`, 'one', '$.cf_clio_matter');
-- UPDATE `contacts` SET `custom` = JSON_REMOVE(`custom`, '$.cf_clio_id')
--  WHERE JSON_CONTAINS_PATH(`custom`, 'one', '$.cf_clio_id');
