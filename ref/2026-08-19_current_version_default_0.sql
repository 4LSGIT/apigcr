-- ref/2026-08-19_current_version_default_0.sql
--
-- Versioning fixpack (final review F2) — flip the fail-safe direction of
-- `current_version`'s column default from 1 to 0.
--
-- WHY: DEFAULT 1 was correct for exactly the S1→S2 deploy window (the S1
-- migration is explicit about this) — old code omitting the new column had to
-- land on the backfilled v1. That window closed when S2 deployed. Today every
-- application insert passes the value explicitly (creates pass 0), so the
-- default only ever fires for OUT-OF-BAND inserts: console SQL, a future
-- migration script, a worker session copying an old ref/ file. With DEFAULT 1
-- those produce a PUBLISHED entity with no version metadata row — the silent
-- F1 wedge (guards pass, every enrollment dies at fire time with
-- template_version_row_missing). With DEFAULT 0 the same mistake produces a
-- loud "never published" refusal at first dispatch instead.
--
-- Zero behavioural change to shipped code. Metadata-only in MySQL 8 —
-- instant, no rebuild. Each statement single & console-safe. Reversible with
-- SET DEFAULT 1.
--
-- Run each statement separately (house console convention):

ALTER TABLE workflows ALTER COLUMN current_version SET DEFAULT 0;

ALTER TABLE sequence_templates ALTER COLUMN current_version SET DEFAULT 0;
