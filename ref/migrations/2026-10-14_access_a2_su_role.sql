-- Access-control A2, stage 1 — the `su` role member.
-- Applied via scripts/accessA2SuRole.js (one connection, session
-- lock_wait_timeout=5 before the ALTER; CHECK + --apply, resumable).
-- ref/ACCESS_CONTROL_DESIGN.md §2.4. Stage 3 (user_auth collapse) is
-- slice A2b and is NOT here.

-- Append-only SET change (never reorder/remove members); INPLACE/LOCK=NONE
-- so it refuses rather than copy the table.
ALTER TABLE `users` MODIFY `roles`
  SET('it','admin','staff','attorney','automation','form_dev','su')
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ALGORITHM=INPLACE, LOCK=NONE;

-- Grant `su` to the legacy-marker holder(s) — exactly one live 2026-10-14
-- (user 6, IT). Idempotent.
UPDATE users
   SET roles = CONCAT_WS(',', NULLIF(roles,''), 'su')
 WHERE user_auth = 'authorized - SU'
   AND NOT FIND_IN_SET('su', roles);
