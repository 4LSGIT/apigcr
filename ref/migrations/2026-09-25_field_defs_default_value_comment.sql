-- ref/migrations/2026-09-25_field_defs_default_value_comment.sql
--
-- Custom-fields arc S6-B — the `default_value` COMMENT follows the case-side
-- extraction. COMMENT ONLY; no data, no type, no nullability change.
--
-- WHY: 2026-09-25_field_defs_default_value.sql (applied earlier the same day)
-- named the case-side stamp sites as "intakeService.intakeCase and the petition
-- route", which was true when it was written — the case side had no create
-- chokepoint, so S6 stamped at two independent INSERT sites. Fred ruled the
-- extraction the same day: `caseService.createCase` is now the only
-- `INSERT INTO cases` in the codebase (guarded by a test), and both of those
-- callers go through it. The COMMENT is the durable schema documentation — it
-- flows into ref/database.sql — so it must name the chokepoint, not its
-- callers, or the next reader goes looking for a stamp site that no longer
-- composes an INSERT.
--
-- ONLINE DDL: a comment-only MODIFY is metadata-only — ALGORITHM=INSTANT.
-- Spelled out so the engine errors rather than silently rebuilding the table.
-- Costs no instant-DDL row version (only the ADD did, 0 -> 1).
--
-- DEPLOY ORDER: independent of any code (it is a comment). Apply whenever,
-- then regenerate ref/database.sql (the pre-commit hook does).
--
-- ROLLBACK: none needed — re-running the previous migration's COMMENT text
-- would restore the older wording, which is the less accurate one.

ALTER TABLE `field_defs`
  MODIFY `default_value` json DEFAULT NULL
    COMMENT 'Optional value stamped into <entity>.custom ONCE, at record creation, by the two create chokepoints: contactService.createContact and caseService.createCase (the only INSERT INTO contacts / INTO cases in the codebase) — ref/CUSTOM_FIELDS_DESIGN.md §3. NEVER retroactive (a def gaining or changing a default affects future creates only; backfilling existing records is a deliberate one-off UPDATE). Stamped regardless of show_when (data, not display). NULL = no default; there is no "default to clear". Validated at def save through validateValue against the merged def, so a stored default always satisfies its own field; select/multiselect defaults must name an ACTIVE option at save time, though a later-retired option keeps working (writes accept retired). Holds the JSON value itself — JSON string for text/date/select, number, boolean, or ARRAY for multiselect.',
  ALGORITHM=INSTANT;
