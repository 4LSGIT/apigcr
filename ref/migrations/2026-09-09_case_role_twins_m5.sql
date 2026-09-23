-- ref/migrations/2026-09-09_case_role_twins_m5.sql
--
-- Contact-roles arc m5 — resolved-twin columns on cases: case_judge_contact_id
-- and case_trustee_contact_id, resolved from the free-text case_judge /
-- case_trustee names by lib/caseRoleResolver (fill on match, NULL on miss;
-- resolution never blocks a write — the varchar names stay AUTHORITATIVE).
-- BACKFILLED 2026-09-23; APPLIED LIVE 2026-09-09/10. Reconstructed after the
-- fact from ref/database.sql; committed so the arc's schema history lives in
-- the repo.
--
-- The historical backfill of the twin values on existing cases was run by
-- scripts/backfillCaseRoleIds.js, not by SQL here.
--
-- Every statement is STANDALONE (DB console runs each on its own pooled
-- connection).

ALTER TABLE `cases`
  ADD COLUMN `case_judge_contact_id` int unsigned DEFAULT NULL AFTER `case_judge`;

ALTER TABLE `cases`
  ADD COLUMN `case_trustee_contact_id` int unsigned DEFAULT NULL AFTER `case_trustee`;

ALTER TABLE `cases`
  ADD KEY `idx_cases_judge_contact` (`case_judge_contact_id`);

ALTER TABLE `cases`
  ADD KEY `idx_cases_trustee_contact` (`case_trustee_contact_id`);

-- The COMMENTs now on cases.case_judge / cases.case_trustee (see
-- ref/database.sql) were also set during this arc; the exact MODIFY
-- statements/dates were not preserved, so they are not reproduced here.
