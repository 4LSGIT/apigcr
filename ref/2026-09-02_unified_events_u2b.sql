-- ref/2026-09-02_unified_events_u2b.sql
--
-- UNIFIED EVENTS U2b — picker OPTIONS for the item-type registry
-- Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.3.2 (A1), §7.
-- Ruling (Fred, 2026-09-02): identity and presentation are two tables.
--
--   calendar_item_types    what an appointment IS — type_key is the identity
--                          the cascade, singleton policy, court and booking
--                          all reference. case_types scoping lives here
--                          (a Schedules meeting is BK regardless of surface).
--   calendar_type_options  what a staff PICKER OFFERS — one row per
--                          (type, length): the presented length, an optional
--                          label override, and the surfaces it appears on.
--                          Nothing references an option row; appts store
--                          type_key + appt_length, which is exactly the pair.
--                          Options exist for kind=meeting types only.
--
-- RULE: a meeting type with NO option rows is offered in NO staff appointment
-- picker. It still resolves, still books through booking views / court /
-- the API. Explicit-only — no implicit default option — so the seed below
-- reproduces the two dialog lists exactly and nothing appears by accident.
--
-- SURFACES (closed vocabulary; services/calendarTypeService.SURFACES):
--   new_client   the new-client dialog's inline first-appt picker
--                (scripts.js newContact → #NCApptTypeSel)
--   follow_up    the shared newApptDialog() — case / contact / calendar /
--                the shell Appointments tab
--
-- DEPLOY ORDER: SQL → backend → frontend (§7.1 rule 5). The frontend
-- pickers fall back to their pre-U2b hardcoded lists on any fetch failure,
-- so no backend/frontend ordering hazard exists.
--
-- PROPERTIES: standalone statements (fresh connection per statement — no
-- session variables). Idempotent: CREATE TABLE IF NOT EXISTS; every seed
-- INSERT is INSERT IGNORE against UNIQUE (type_key, length), so a re-run
-- never clobbers a row edited in Case Config. Collation is explicit
-- (utf8mb4_general_ci, the house collation) — type_key must join
-- calendar_item_types.type_key without a coercion.
--
-- Rollback at the bottom, commented.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1  DDL
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_type_options (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type_key    VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
              COMMENT 'FK-by-convention → calendar_item_types.type_key (no FK constraints, repo convention). Meeting types only.',
  label       VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL
              COMMENT 'picker text override; NULL = the type''s label. Display only — appt_type is always the TYPE label.',
  length      SMALLINT UNSIGNED NOT NULL COMMENT 'minutes offered by this option (1..1440)',
  surfaces    JSON NOT NULL COMMENT 'non-empty subset of the closed surface vocabulary',
  sort_order  INT NOT NULL DEFAULT 0 COMMENT 'within the type; types order by calendar_item_types.sort_order first',
  active      TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'inactive options are not offered; the type''s own active flag also gates',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cto_type_length (type_key, length),
  KEY idx_cto_type_active (type_key, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='U2b: staff-picker options per calendar item type (length × surfaces). Presentation, not identity.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2  SEED
--
-- Verified 2026-09-02 against public/scripts.js:
--   #NCApptTypeSel (new client):  ISS 15, SS 15, SS Follow Up 15 + 30,
--                                 Pre-filing 30, Schedules 45, Documents 30,
--                                 Matrix 15, Other
--   newApptDialog():              SS 15, SS Follow Up 15 + 30, Pre-filing 30,
--                                 Schedules 45, Documents 30, Matrix 15,
--                                 Schedules 20, Other
--
-- Ruling "seed all, it's tiny": every ACTIVE meeting type gets an option
-- except meeting_341 (court is source of truth; singleton — never hand-booked
-- from a dialog). consultation / pre_lawsuit / tax_consult go on BOTH
-- surfaces (a consult is a plausible first appointment; pre_lawsuit is
-- Civil-Litigation-scoped by calendar_item_types.case_types now that the
-- pickers pass case_type); the generic `meeting` goes on follow_up only (a
-- first appointment should be typed). `test` is inactive — no option.
--
-- sort_order within a type: 10, 20 … so a second length slots in without
-- renumbering. Types themselves order by calendar_item_types.sort_order.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('iss',               NULL, 15, CAST('["new_client"]' AS JSON),             10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('ss',                NULL, 15, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('ss_follow_up',      NULL, 15, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('ss_follow_up',      NULL, 30, CAST('["new_client","follow_up"]' AS JSON), 20);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('consultation',      NULL, 30, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('pre_filing',        NULL, 30, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('schedules_meeting', NULL, 45, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('schedules_meeting', NULL, 20, CAST('["follow_up"]' AS JSON),              20);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('docs_meeting',      NULL, 30, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('matrix_meeting',    NULL, 15, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('pre_lawsuit',       NULL, 30, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('tax_consult',       NULL, 30, CAST('["new_client","follow_up"]' AS JSON), 10);
INSERT IGNORE INTO calendar_type_options (type_key, label, length, surfaces, sort_order) VALUES
  ('meeting',           NULL, 15, CAST('["follow_up"]' AS JSON),              10);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3  DEFAULT LENGTH PARITY (divergence found while verifying)
--
-- The registry seeded matrix_meeting at 30 minutes; both dialogs offered it
-- at 15 and the one live appt on that key is a 15. default_length is now the
-- API / court / booking fallback when no option is chosen, so it should say
-- what the dialogs said. Guarded on the seed value.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE calendar_item_types SET default_length = 15
 WHERE type_key = 'matrix_meeting' AND default_length = 30;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT o.type_key, o.length, o.surfaces, t.kind, t.active
--   FROM calendar_type_options o JOIN calendar_item_types t USING (type_key)
--  ORDER BY t.sort_order, o.sort_order;                       → 13 rows, all kind='meeting'
-- SELECT COUNT(*) FROM calendar_type_options o
--   LEFT JOIN calendar_item_types t USING (type_key) WHERE t.type_key IS NULL;  → 0 (no orphans)
-- SELECT default_length FROM calendar_item_types WHERE type_key='matrix_meeting';  → 15


-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (after rolling the backend revision back — the pickers then
-- render their hardcoded fallback lists)
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE calendar_item_types SET default_length = 30
--  WHERE type_key = 'matrix_meeting' AND default_length = 15;
-- DROP TABLE calendar_type_options;
