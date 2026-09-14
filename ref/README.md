# ref/

Reference material that lives next to the code. Three tiers:

## Root — living documents only
- `database.sql` — auto-generated schema dump (`npm run db:ref`, pre-commit
  hook). **Never hand-edit.**
- `routes.md` — auto-generated route inventory (`node scripts/updateRoutes.js`).
- `SCHEMA_CONVENTIONS.md`, `plans.md`, `SETUP_cloud_tasks.md` — living reference.
- `AI_CONTEXT.md` — deep context for AI sessions. Read its CURRENCY header
  first: §0 carries the newest deltas and OVERRIDES the body sections where
  they conflict, so a section found by grep alone can be out of date.
- `DOCS_REVIEW.md` — the weekly procedure that keeps `AI_CONTEXT.md` and
  `manual/` honest. Its input is the doc-debt queue in scratch `ns=docs`.
- Design contracts still canonical for shipped subsystems:
  `FORM_TEMPLATE_SCHEMA_V1.md`, `EXTERNAL_FORMS_DESIGN.md`,
  `EXTERNAL_CODE_CSS_DECISION.md`, `UNIFIED_EVENTS_DESIGN_V0_5.md`,
  `YISRACASE_STORE_AND_BUS_DESIGN_V2.md`, `THEME-CHEATSHEET.md`,
  `THEME-HANDOFF-v2.md`, `TOKEN-MAP.md`.
- `gas.js` — deployed Apps Script source; code comments reference it by line
  number (`services/emailIngestService.js` cites `ref/gas.js:784`), so adding or
  removing lines invalidates those citations.
- `artifact-registry-cleanup-policy.json` — GCP artifact-registry retention
  policy, applied out-of-band.
- **dbkq script I/O** — a captured source page, the definitions the converter
  generates from it, and the coverage report. Dated like migrations and easy to
  mistake for them, but nothing here was ever applied to the DB:

  | File | Used by |
  |---|---|
  | `2026-09-04_dbkq_coverage.md`, `2026-09-04_dbkq_definition.v1.json`, `dbkq_source_2026-09-04.html` | `scripts/dbkq_convert.js`, `scripts/dbkq_verify.js` |
  | `2026-09-06_dbkq_definition.v1.2.json`, `dbkq_live_definition_2026-09-06.json` | `scripts/dbkq_v12_polish.js`, `tests/dbkqV12Polish.test.js` |

  This is the only dated material left at root, and the rule that put it here
  is KIND, not who reads it. Applied migrations go to `migrations/` even when a
  test loads one — `genTypeKeyBackfill.js` reaches them through a `MIG()`
  helper, and the U2b, U8 and r15_rules suites spell out `ref/migrations/` in
  their `path.join`. Test fixtures go to `tests/fixtures/` and are not
  reference material at all. If a new file is neither, it lands here; if it is
  one of the two, move it and fix the reader.

  Corollary: never derive one file's path from another's by string surgery.
  `genTypeKeyBackfill.js` used to build the E0a path by replacing the E0b
  filename inside `E0B_PATH`; the moment the two sat in different directories
  the suite stopped loading. Each path gets its own constant.

## migrations/ — applied, historical
Dated `.sql` and definition-JSON payloads already applied to the live DB and
worth keeping. The filename date is the applied date. These are records, not
templates — several predate automation versioning and are unsafe to copy
(see `manual/03-YisraFlow/16-versioning.md`). Current schema truth is
`database.sql`.

**Not every applied migration is kept, and not every one needs to be.** Keep it
when it records something `database.sql` cannot: a one-time data backfill or
transform, a definition payload, a rationale worth re-reading, or a file a test
or script loads. Plain DDL whose entire result is visible in the schema dump —
add a column, add an index, widen a varchar — has already been captured by the
dump and can be dropped once applied. The corollary: the absence of a file here
is not evidence a change never happened; `database.sql` is, and git history
holds the rest. When unsure, keep it — deleting one a guard walks breaks tests.

New migrations: land here as `YYYY-MM-DD_name.sql` once applied, if kept.

Two guards walk this directory rather than a fixed path, so seeds stay covered
wherever they sit: `tests/aiMatchTypes.registry.test.js` recurses all of
`ref/**/*.sql` looking for `INSERT INTO ai_match_types`, and
`tests/schemaConventions.test.js` cites the collation migration.

## archive/ — dead working documents
Worker prompts, arc charters, one-off audits, superseded plans, source
snapshots. Kept for archaeology; nothing here is current. When an arc closes,
its working docs move here.

Archived does not mean unreferenced: `ORIGIN_SEPARATION_ROLLOUT.md` is still
cited from `lib/auth.superuser.js`, `lib/firmConfig.js`,
`lib/internal_functions/decisions.js`, `routes/pageLanding.js` and
`services/taskService.js` as the rationale for the public/app origin split, and
`AUTOMATION_VERSIONING_AUDIT.md` from `tests/versionPredicateCoverage.test.js`.
Those are provenance citations, not live reads — but keep the paths honest when
files move.

## Subdirectories
- `manual/` — deploy runbooks staged alongside the served `manual/` chapters,
  not yet folded into one. Currently just the FIL-1 trustee-validation runbook.
- `pages/` — external-form page templates (`form.html`, `submitted.html`);
  read by `tests/sendingformBk.dbkqLink.test.js`.
- `templates/` — e-sign template artifacts; read by
  `tests/esignPrefill.notice.test.js`.

## Known dangling references
One file this tree is expected to contain does not exist and has no git
history — it is cited but was never committed:

- `streak-schema.sql` — the external Streak schema `gas.js` feeds. Cited from
  `routes/api.streak.js`.

Restore it here or drop the citation; right now the trail dead-ends.

`AI_CONTEXT.md` was on this list until 2026-09-14, when it landed at
`ref/AI_CONTEXT.md` and every citation to it was repointed: the "AI_CONTEXT §N"
form in `services/gcalService.js`, `services/dropboxService.js`,
`services/esign/zohoSignProvider.js` and `routes/api.temp.zohosign.js`, and the
old `YISRACASE_AI_CONTEXT.md` filename in `ref/plans.md`,
`startup/dbReadonly.js` and `manual/03-YisraFlow/README.md`.
