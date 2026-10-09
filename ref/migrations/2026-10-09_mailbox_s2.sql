-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-09 — Mailbox system S2 (comms hub): mailboxes.color
--   A. mailboxes.color — one stored colour per mailbox
--   B. backfill: every existing mailbox gets a distinct default colour
--
-- WHY
--   The comms hub combines several mailboxes in one list (SB: shoshana@ +
--   billing@), so each row needs a quick-glance cue for which box it came
--   from. The colour is assigned when the box is added — the admin's pick, or
--   a random default from the shared palette (public/js/mailboxColor.js
--   PALETTE: an unused one first) — and editable afterwards by an SU or the
--   box's managers (Admin → Mailboxes), exactly like display_name. Everyone
--   sees the same colour for the same box. It is cosmetic only: never an
--   access or routing input.
--   Code: public/js/mailboxColor.js (palette, validation, per-theme legible
--   drawing values), services/mailboxService.js (projections, validation,
--   random default on create), public/comms.html + public/mailboxAdmin.html.
--
--   A. '#rrggbb' lowercase, app-validated (sql_mode is non-strict). NULL =
--      none chosen: the hub draws a neutral dot. The stored value is drawn as
--      is wherever it clears 3:1 against the theme's surfaces, else a lighter
--      or darker shade of the same hue — the row is never rewritten for it.
--   B. ELT over the first entries of PALETTE by id (id 1 → blue, 2 → orange,
--      …), so today's boxes come out distinct; re-pick any in the admin pane.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend. The S2 backend SELECTs m.color in every mailbox
-- projection — including the S0 admin pane's GET /api/mailboxes and the grant
-- resolution's listReadable: a backend deployed before this file breaks the
-- Mailboxes admin pane and the hub (ER_BAD_FIELD_ERROR) until it runs. The
-- current backend never names the column, so running this first is safe.
-- Run it BEFORE `git go` too: the pre-commit hook regenerates ref/database.sql
-- from the live schema, and that is how the column reaches the dump.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A guarded on information_schema (MySQL has no ADD COLUMN IF NOT EXISTS) —
-- the SET/PREPARE/EXECUTE/DEALLOCATE group must run on ONE connection, i.e.
-- from a mysql client session. The SU DB console CANNOT guarantee that (its
-- pool runs each statement separately, so @sql may not survive to PREPARE):
-- from the console run the plain fallback quoted under A instead (verified
-- 2026-10-09: the column does not exist live; a re-run fails harmlessly with
-- ER_DUP_FIELDNAME). B touches only rows still NULL — a re-run is a no-op.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No FKs. The new VARCHAR inherits the table's utf8mb4_general_ci
-- (ref/SCHEMA_CONVENTIONS.md). B is the one data step: two rows today.
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (or `npm run db:ref`, or just commit —
-- the pre-commit hook does it). ref/database.sql is auto-generated — do not
-- hand-edit it.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Roll the backend back first (it SELECTs the column), then:
--   ALTER TABLE mailboxes DROP COLUMN color;
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A. mailboxes.color ───────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mailboxes'
      AND COLUMN_NAME  = 'color') > 0,
  'SELECT ''mailboxes.color already present — skipped'' AS note',
  'ALTER TABLE mailboxes
     ADD COLUMN color VARCHAR(7) NULL
     COMMENT ''comms hub colour (S2): #rrggbb lowercase, app-validated; NULL = none chosen (neutral). Set at create (pick, else a random unused public/js/mailboxColor.js PALETTE entry) and editable by SU or the box''''s can_manage holders. Cosmetic only - drawn as given where it clears 3:1 on the theme, else a lighter/darker shade of the same hue''
     AFTER display_name');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mailboxes
--     ADD COLUMN color VARCHAR(7) NULL
--     COMMENT 'comms hub colour (S2): #rrggbb lowercase, app-validated; NULL = none chosen (neutral). Set at create (pick, else a random unused public/js/mailboxColor.js PALETTE entry) and editable by SU or the box''s can_manage holders. Cosmetic only - drawn as given where it clears 3:1 on the theme, else a lighter/darker shade of the same hue'
--     AFTER display_name;


-- ── B. backfill: distinct defaults for the boxes that exist today ───────────
-- The ten literals are public/js/mailboxColor.js PALETTE, in order.
UPDATE mailboxes
   SET color = ELT(MOD(id - 1, 10) + 1,
                   '#2f6fd1', '#d9480f', '#2b8a3e', '#9c36b5', '#0b7f86',
                   '#c2255c', '#9a6b00', '#5f6ad1', '#c92a2a', '#5c940d')
 WHERE color IS NULL;


-- VERIFY 1 — the column. Expect color varchar(7) YES utf8mb4_general_ci:
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mailboxes' AND COLUMN_NAME = 'color';
--
-- VERIFY 2 — every box coloured. Expect (today) 1 → #2f6fd1, 2 → #d9480f:
--   SELECT id, address, color FROM mailboxes ORDER BY id;
-- ─────────────────────────────────────────────────────────────────────────────
