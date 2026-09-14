-- ref/2026-09-01_unified_events_u5.sql
--
-- UNIFIED EVENTS U5 — consumer cutover: type strings → type_key
-- Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §1 A1, §3.3, §6.1, §7.
--
-- ── DEPLOY ORDER IS INVERTED FOR THIS SLICE ────────────────────────────────
-- §7.1 rule 5 says SQL → backend → frontend. U5 says BACKEND → SQL → frontend,
-- and says so in its own prompt (the rule's escape clause). Reason: 1.2 points
-- four sequence templates at `filters.type_key`, and sequenceEngine
-- DISQUALIFIES a template whose specific filter has no corresponding value in
-- trigger_data. Until apptService flattens `type_key` into the pre_appt and
-- no_show trigger_data, running this file first would silently drop every
-- ISS/341 reminder and every BK no-show sequence onto the generic fallback.
-- Run this ONLY after the backend revision carrying the apptService change is
-- live.
--
-- ── PROPERTIES ─────────────────────────────────────────────────────────────
-- Standalone statements (the SQL runner uses a fresh connection per statement,
-- so NO session variables — §7.1 / the migration ground rule). Idempotent: every
-- UPDATE is guarded on the pre-cutover value, so a re-run is a no-op and a
-- hand-edited row is never clobbered. No `events` rows are touched, so §7.1
-- rule 9's `event_updated_at = event_updated_at` clause does not apply here.
--
-- Additive DDL only: one nullable column on booking_views. Nothing is dropped;
-- `appt_type` survives on every consumer for one release.
--
-- Rollback statements are at the bottom, commented.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1.1  sequence_template_types.priority_fields — type_key AHEAD OF appt_type
--
-- Order IS the cascade weight (2^(N-1-i)), so type_key must lead: it is the
-- more specific of the two, and a template matching on it must outrank any
-- combination of the fields after it.
--
-- appt_type STAYS for one release. After 1.2 no active template carries an
-- appt_type filter, so it is a wildcard on every candidate — it contributes 0
-- and disqualifies nothing. Keeping it means a template hand-authored against
-- the old field still validates (validateTemplateFilters checks keys against
-- this list) while the cutover settles.
--
-- The three test types (no_show_test, test, test_sql_fix) also carry
-- appt_type in priority_fields and are DELIBERATELY untouched — none of their
-- templates has an appt_type filter, so there is nothing to cut over.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE sequence_template_types
   SET priority_fields = CAST('["type_key","appt_type","appt_with"]' AS JSON)
 WHERE type = 'pre_appt'
   AND JSON_SEARCH(priority_fields, 'one', 'type_key') IS NULL;

UPDATE sequence_template_types
   SET priority_fields = CAST('["type_key","appt_type","appt_with","case_type"]' AS JSON)
 WHERE type = 'no_show'
   AND JSON_SEARCH(priority_fields, 'one', 'type_key') IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1.2  sequence_templates.filters — keys replace label strings
--
-- `filters` is a LIVE (unversioned) template field: routes/sequences.js splits
-- `condition` (versioned, forks a draft) from name/type/filters/active/
-- description/test_input (live, "latest wins"), and lib/versionDiff classifies
-- STEPS only. A raw UPDATE here is therefore the same write the PUT route
-- performs — it does not bypass a version gate, because there is none.
--
-- appt_type is REMOVED from these four rather than left beside the new key:
-- the type_key filter is strictly more specific than the label list it
-- replaces, so carrying both would mean two filters that must BOTH match, and
-- the label half would disqualify exactly the rows the alias registry exists
-- to rescue (an 'Intial Strategy Session' row carries type_key 'iss' but the
-- typo'd label — it would pass the key filter and fail the label one).
--
-- Guarded on the exact pre-cutover appt_type value, so this is a no-op on
-- re-run and leaves a hand-edited template alone.
-- ─────────────────────────────────────────────────────────────────────────────

-- 19 — pre_appt, 341
UPDATE sequence_templates
   SET filters = JSON_REMOVE(JSON_SET(filters, '$.type_key', 'meeting_341'), '$.appt_type')
 WHERE id = 19
   AND JSON_UNQUOTE(JSON_EXTRACT(filters, '$.appt_type')) = '341 Meeting';

-- 20 — pre_appt, ISS
UPDATE sequence_templates
   SET filters = JSON_REMOVE(JSON_SET(filters, '$.type_key', 'iss'), '$.appt_type')
 WHERE id = 20
   AND JSON_UNQUOTE(JSON_EXTRACT(filters, '$.appt_type')) = 'Initial Strategy Session';

-- 23 — no_show, BK pre-file (generic). The four labels are four keys; the
-- pipe-delimited multi-value form is what sequenceEngine already parses.
UPDATE sequence_templates
   SET filters = JSON_REMOVE(JSON_SET(filters, '$.type_key', 'iss|ss|ss_follow_up|pre_filing'), '$.appt_type')
 WHERE id = 23
   AND JSON_UNQUOTE(JSON_EXTRACT(filters, '$.appt_type'))
       = 'Initial Strategy Session|Strategy Session|Strategy Session Follow Up|Pre-Filing Meeting';

-- 24 — no_show, BK pre-file (SS). Same list; appt_with / case_type untouched.
UPDATE sequence_templates
   SET filters = JSON_REMOVE(JSON_SET(filters, '$.type_key', 'iss|ss|ss_follow_up|pre_filing'), '$.appt_type')
 WHERE id = 24
   AND JSON_UNQUOTE(JSON_EXTRACT(filters, '$.appt_type'))
       = 'Initial Strategy Session|Strategy Session|Strategy Session Follow Up|Pre-Filing Meeting';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1.3  trigger_rules 1–3 — path and values
--
-- Each rule's match_config is {"operator":"and","conditions":[ {exists case_id},
-- {the type test} ]} — the type test is conditions[1], verified live
-- 2026-09-01. JSON_SET writes that index specifically and is guarded on the
-- current path, so it is a no-op on re-run and refuses to fire if a rule was
-- re-ordered in the editor in the meantime (the VERIFY block catches that as a
-- non-zero `data.appt_type` count).
--
-- Rules stay bound to `appt.*`. Moving them to the calendar.* family is a
-- LATER slice (§8.3, after U7) — this file changes what they match on, not
-- what they listen to.
--
-- 'Intial Strategy Session' disappears from the value list because it is not a
-- separate activity: since U2 the registry carries it as an ingest_alias of
-- `iss`, so those rows already write type_key 'iss'.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE trigger_rules
   SET match_config = JSON_SET(
         match_config,
         '$.conditions[1].path',  'data.type_key',
         '$.conditions[1].value', CAST('["iss","ss","consultation"]' AS JSON))
 WHERE id = 1
   AND JSON_UNQUOTE(JSON_EXTRACT(match_config, '$.conditions[1].path')) = 'data.appt_type';

UPDATE trigger_rules
   SET match_config = JSON_SET(
         match_config,
         '$.conditions[1].path',  'data.type_key',
         '$.conditions[1].value', CAST('["iss","ss","consultation"]' AS JSON))
 WHERE id = 2
   AND JSON_UNQUOTE(JSON_EXTRACT(match_config, '$.conditions[1].path')) = 'data.appt_type';

UPDATE trigger_rules
   SET match_config = JSON_SET(
         match_config,
         '$.conditions[1].path',  'data.type_key',
         '$.conditions[1].value', 'meeting_341')
 WHERE id = 3
   AND JSON_UNQUOTE(JSON_EXTRACT(match_config, '$.conditions[1].path')) = 'data.appt_type';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1.4  pipeline_stage_requirements 3 (iss_held) — the only `event` detector row
--
-- Selector SHAPE unchanged (source / want / which as-is); only the
-- kind_or_type VALUES move from labels to keys. 'Intial Strategy Session'
-- collapses into 'iss' for the same alias reason as 1.3.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE pipeline_stage_requirements
   SET detector_config = JSON_SET(
         detector_config,
         '$.kind_or_type', CAST('["iss","ss","consultation"]' AS JSON))
 WHERE id = 3
   AND detector = 'event'
   AND JSON_CONTAINS(detector_config, '"Initial Strategy Session"', '$.kind_or_type');


-- ─────────────────────────────────────────────────────────────────────────────
-- 1.5  booking_views.type_key
--
-- utf8mb4 / utf8mb4_general_ci spelled out: writing `DEFAULT CHARSET=utf8mb4`
-- (or letting the column inherit on MySQL 8) silently produces 0900_ai_ci and
-- breaks joins against the general_ci registry (SCHEMA_CONVENTIONS).
--
-- NULLABLE, no FK — same call as `appts.type_key` / `events.type_key` at U2: an
-- unknown key must be storable, the registry is data staff edit, and a NULL is
-- the honest "this view predates the picker". routes/booking.js passes NULL
-- straight through to createAppt, which falls back to label resolution.
--
-- The backfill maps the three live labels through the registry the same way
-- ingest_aliases already resolves them at write time ('Tax Consultation' →
-- tax_consult, 'Potato Hunting' → test). appt_type is NOT rewritten from the
-- registry label: the confirmation template interpolates {{appts.appt_type}}
-- and staff wrote those strings.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE booking_views
  ADD COLUMN type_key VARCHAR(40)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER appt_type;

UPDATE booking_views SET type_key = 'consultation' WHERE type_key IS NULL AND appt_type = 'Consultation';
UPDATE booking_views SET type_key = 'tax_consult'  WHERE type_key IS NULL AND appt_type = 'Tax Consultation';
UPDATE booking_views SET type_key = 'test'         WHERE type_key IS NULL AND appt_type = 'Potato Hunting';


-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY  — run every block; expected results are stated inline.
-- ═════════════════════════════════════════════════════════════════════════════

-- V1 — priority_fields, type_key first. Expect exactly 2 rows:
--      pre_appt ["type_key","appt_type","appt_with"]
--      no_show  ["type_key","appt_type","appt_with","case_type"]
SELECT type, CAST(priority_fields AS CHAR) AS priority_fields
  FROM sequence_template_types
 WHERE type IN ('pre_appt','no_show')
 ORDER BY type;

-- V2 — template filters. Expect 4 rows, no appt_type key on any of them:
--      19 {"type_key":"meeting_341"}
--      20 {"type_key":"iss"}
--      23 {"case_type":"Bankruptcy","type_key":"iss|ss|ss_follow_up|pre_filing"}
--      24 {"appt_with":1,"case_type":"Bankruptcy","type_key":"iss|ss|ss_follow_up|pre_filing"}
SELECT id, name, CAST(filters AS CHAR) AS filters
  FROM sequence_templates
 WHERE id IN (19,20,23,24)
 ORDER BY id;

-- V3 — NO active template still filters on the label. Expect 0.
SELECT COUNT(*) AS templates_still_on_appt_type
  FROM sequence_templates
 WHERE active = 1 AND JSON_EXTRACT(filters, '$.appt_type') IS NOT NULL;

-- V4 — trigger rules. Expect 3 rows, all with path 'data.type_key':
--      1 ["iss","ss","consultation"]
--      2 ["iss","ss","consultation"]
--      3 "meeting_341"
SELECT id, name, event_type,
       JSON_UNQUOTE(JSON_EXTRACT(match_config, '$.conditions[1].path')) AS type_path,
       CAST(JSON_EXTRACT(match_config, '$.conditions[1].value') AS CHAR) AS type_value
  FROM trigger_rules
 WHERE id IN (1,2,3)
 ORDER BY id;

-- V5 — NO rule anywhere still reads the label path. Expect 0.
SELECT COUNT(*) AS rules_still_on_appt_type
  FROM trigger_rules
 WHERE CAST(match_config AS CHAR) LIKE '%data.appt_type%';

-- V6 — requirement 3. Expect kind_or_type ["iss","ss","consultation"],
--      source 'appt', want 'held', which 'latest'.
SELECT id, requirement_key, CAST(detector_config AS CHAR) AS detector_config
  FROM pipeline_stage_requirements
 WHERE detector = 'event'
 ORDER BY id;

-- V7 — every booking view carries a key. Expect 0.
SELECT COUNT(*) AS views_without_type_key FROM booking_views WHERE type_key IS NULL;

-- V8 — and every one of those keys exists in the registry. Expect 0.
SELECT COUNT(*) AS views_with_unknown_type_key
  FROM booking_views bv
  LEFT JOIN calendar_item_types t ON t.type_key = bv.type_key
 WHERE bv.type_key IS NOT NULL AND t.type_key IS NULL;

-- V9 — the six views, for eyeballing label vs key.
SELECT id, slug, active, appt_type, type_key FROM booking_views ORDER BY id;

-- V10 — PRE-FLIGHT-AS-POSTFLIGHT: any OTHER active pre_appt/no_show template
--       that still carries an appt_type filter is a divergence from the U5
--       prompt's inventory. Expect 0 rows. (If this returns anything, STOP and
--       report before deploying the frontend.)
SELECT id, name, type, CAST(filters AS CHAR) AS filters
  FROM sequence_templates
 WHERE type IN ('pre_appt','no_show')
   AND active = 1
   AND JSON_EXTRACT(filters, '$.appt_type') IS NOT NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK  (data only; the backend rolls back by redeploying the previous
-- revision. The backend is FORWARD-COMPATIBLE with the pre-U5 data — it
-- dual-carries appt_type in trigger_data and the detector's stale-label configs
-- simply resolve unsatisfied — so a data-only rollback is safe on its own.)
--
-- The ALTER is deliberately NOT reversed: §7.1 rule 1, additive DDL only. A
-- NULL/unused type_key column costs nothing; dropping it would.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- UPDATE sequence_template_types SET priority_fields = CAST('["appt_type","appt_with"]' AS JSON)
--  WHERE type = 'pre_appt';
-- UPDATE sequence_template_types SET priority_fields = CAST('["appt_type","appt_with","case_type"]' AS JSON)
--  WHERE type = 'no_show';
--
-- UPDATE sequence_templates
--    SET filters = JSON_REMOVE(JSON_SET(filters, '$.appt_type', '341 Meeting'), '$.type_key')
--  WHERE id = 19;
-- UPDATE sequence_templates
--    SET filters = JSON_REMOVE(JSON_SET(filters, '$.appt_type', 'Initial Strategy Session'), '$.type_key')
--  WHERE id = 20;
-- UPDATE sequence_templates
--    SET filters = JSON_REMOVE(JSON_SET(filters, '$.appt_type',
--          'Initial Strategy Session|Strategy Session|Strategy Session Follow Up|Pre-Filing Meeting'), '$.type_key')
--  WHERE id IN (23,24);
--
-- UPDATE trigger_rules
--    SET match_config = JSON_SET(match_config, '$.conditions[1].path', 'data.appt_type',
--          '$.conditions[1].value', CAST('["Initial Strategy Session","Strategy Session","Consultation","Intial Strategy Session"]' AS JSON))
--  WHERE id IN (1,2);
-- UPDATE trigger_rules
--    SET match_config = JSON_SET(match_config, '$.conditions[1].path', 'data.appt_type',
--          '$.conditions[1].value', '341 Meeting')
--  WHERE id = 3;
--
-- UPDATE pipeline_stage_requirements
--    SET detector_config = JSON_SET(detector_config, '$.kind_or_type',
--          CAST('["Initial Strategy Session","Strategy Session","Consultation","Intial Strategy Session"]' AS JSON))
--  WHERE id = 3;
--
-- UPDATE booking_views SET type_key = NULL;
