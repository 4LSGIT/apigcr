-- Access-control A2b, stage 3 — the user_auth collapse.
-- Applied via scripts/accessA2bCollapse.js (one connection; CHECK + --apply,
-- resumable; asserts the base state first: user_auth values known, an
-- enabled su-role holder exists, exactly one legacy row = user 6 holding su).
-- ref/ACCESS_CONTROL_DESIGN.md §2.4. Runs AFTER the A2b deploy (the pre-A2b
-- frontend gates SU pages on the string). Stage 1 is
-- 2026-10-14_access_a2_su_role.sql.

UPDATE users
   SET user_auth = 'authorized'
 WHERE `user` = 6
   AND user_auth = 'authorized - SU'
   AND FIND_IN_SET('su', roles);
