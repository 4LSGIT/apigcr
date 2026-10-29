-- 2026-10-29 — lead-list merge arc, Fred's ruling #8: drop the stalled Phil Tirone import table.
--
-- APPLIED BY scripts/leadListPtTableDrop.js --apply, never by hand: on one session it sets
-- lock_wait_timeout = 5, asserts the table is the bare phpMyAdmin CSV import (21 varchar columns
-- `COL 1`…`COL 21`, no index), that scripts/leadListImport.js has run, and that nothing names the
-- table (schema objects, grants, stored definitions, code), then drops it and re-verifies.
--
-- What it held: the Phil Tirone lead list (2,060 leads + the CSV header row stored as data) — the
-- "Phil Tirone" tab of SS's lead workbook, which stays the copy of record. Its people are YC
-- contacts tagged 'phil tirone' (the earlier import, plus scripts/leadListImport.js).
--
-- No ROLLBACK: re-import that workbook tab if the raw rows are ever needed.

DROP TABLE `master_contacts___leads_list___phil_tirone`;
