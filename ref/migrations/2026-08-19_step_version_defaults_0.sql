-- ref/2026-08-19_step_version_defaults_0.sql
--
-- Versioning fixpack (review IV.F3) — the last two version columns the
-- 08-19 default fixpacks skipped: the STEP-ROW version columns.
--
-- WHY: workflow_steps.version and sequence_steps.version still DEFAULT 1.
-- Application code never relies on it (every INSERT binds version
-- explicitly, and versionPredicateCoverage scans for it) — the default only
-- fires for OUT-OF-BAND inserts. With DEFAULT 1 such an insert lands INSIDE
-- the published v1 definition on most live entities: it silently mutates
-- immutable published history, breaks per-version numbering contiguity, and
-- can fire a phantom step on live runs. With DEFAULT 0 the same mistake
-- lands on version 0, which nothing reads for a published entity —
-- silently ABSENT beats silently OVERWRITING history.
--
-- Honest caveat (per the review): unlike the pin columns, 0 here does not
-- produce a throw — a v0 row is simply invisible (and on a never-published
-- template it would be copied into the first draft, where the publish gate's
-- contiguity check catches any numbering damage). Weaker guarantee than the
-- pin-column fixpack's loud failure, still the safer direction.
--
-- Zero behavioural change to shipped code. Metadata-only in MySQL 8 —
-- instant, no rebuild. Reversible with SET DEFAULT 1. ref/database.sql was
-- hand-updated in the same commit.
--
-- Run each statement separately (house console convention):

ALTER TABLE workflow_steps ALTER COLUMN version SET DEFAULT 0;

ALTER TABLE sequence_steps ALTER COLUMN version SET DEFAULT 0;
