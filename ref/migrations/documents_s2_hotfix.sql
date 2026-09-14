-- ─────────────────────────────────────────────────────────────────────────
-- YisraCase — Documents S2 HOTFIX: the mode-flip bug
--
-- ⚠️ TURN THE ENGINE OFF FIRST, BEFORE ANYTHING ELSE:
--      UPDATE app_settings SET `value`='0' WHERE `key`='documents_sync_enabled';
--    Then apply this file, then deploy, then turn it back on.
--
-- WHAT WENT WRONG
--   Write policy was derived from sync_cursor presence. But a backfill stopped
--   by the page budget PERSISTS A CURSOR — so on the next tick a root that was
--   only a quarter of the way through its INITIAL listing looked "already
--   backfilled". It switched to per-row writes with emissions ON and kept
--   walking never-before-seen files, emitting document.created for each.
--
--   Measured: root 1 did 25 pages / 12,332 files in 37s (backfill), then
--   7 pages in 495s (incremental) — ~47x slower per page. Root 3 (Closed
--   Cases) was ~50,000 files from doing the same at scale.
--
-- THE FIX
--   Two questions, answered separately from now on:
--     WHICH API CALL?     sync_cursor presence  (list_folder vs .../continue)
--     WHICH WRITE POLICY? backfill_done         (bulk+silent vs per-row+events)
--   backfill_done flips exactly once, when a page reports has_more = false —
--   the only moment the initial listing is provably complete.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE document_sync_roots
  ADD COLUMN backfill_done TINYINT(1) NOT NULL DEFAULT 0 AFTER sync_cursor;

-- ── Repair existing state ───────────────────────────────────────────────
-- DEFAULT 0 is the safe landing for every root: worst case a root that really
-- had finished does one extra emissions-off pass, which costs a few silent
-- upserts and nothing else. So we only need to promote the roots that
-- PROVABLY completed their initial listing — the ones whose last recorded run
-- stopped with 'complete' while in backfill mode.
--
-- Roots still mid-listing (stop = 'page_cap' / 'budget' / 'time_cap') stay 0
-- and resume from their cursor with emissions off, which is the whole point.
--
-- Roots that hit path/not_found ('empty_root') also stay 0: the folder does
-- not exist yet, so there is no listing to have completed, and their first
-- real walk must be a backfill like any other.
UPDATE document_sync_roots
   SET backfill_done = 1
 WHERE sync_cursor IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(stats, '$.stop'))  = 'complete'
   AND JSON_UNQUOTE(JSON_EXTRACT(stats, '$.mode')) IN ('backfill', 'incremental');

-- ── Verify before deploying ─────────────────────────────────────────────
-- Expect: roots 2 and 4 -> backfill_done 1 (their backfills reported
-- 'complete'); roots 1 and 3 -> 0 (stopped on page_cap / budget); roots 5,6,7
-- -> 0 and sync_cursor NULL (empty).
--
-- SELECT id, SUBSTRING(path, 20, 32) AS p, backfill_done,
--        sync_cursor IS NOT NULL AS armed,
--        JSON_UNQUOTE(JSON_EXTRACT(stats,'$.mode')) AS mode,
--        JSON_UNQUOTE(JSON_EXTRACT(stats,'$.stop')) AS stop
--   FROM document_sync_roots ORDER BY id;
--
-- Any root showing backfill_done = 1 with a mode of 'backfill' and a stop of
-- anything other than 'complete' is WRONG — set it back to 0 by hand.

-- ── Then, and only then ─────────────────────────────────────────────────
-- UPDATE app_settings SET `value`='1' WHERE `key`='documents_sync_enabled';
