# 16 — Definition Versioning (Draft → Publish)

*Shipped 2026-08-18 (slices S0–S6 + fixpacks). Applies to workflow definitions and sequence templates. Migration file: `ref/2026-08-18_automation_versioning.sql`; condition re-sync: `ref/2026-08-18_s4_condition_resync.sql`.*

## For operators

- Editing a workflow or sequence **no longer changes what runs**. Your edits land on a **draft**; the live system keeps running the last published version until you press **Publish**.
- The amber strip above the canvas tells you what you're looking at: *"Unpublished draft (v4). Live runs still use v3."* No strip = you're viewing the published version and there are no pending changes.
- **Publish** shows you exactly what changed before anything goes live. If the change is wording-only ("content-only"), you can optionally tick a box to move in-flight runs/enrollments onto the new version too. If the change is structural (steps added/removed/reordered, timing or branching changed), in-flight runs finish on the version they started on — the modal explains why.
- **Discard** throws the draft away; the published version was never touched.
- **New / duplicated / imported** workflows and templates are born *unpublished*. Nothing can run or enroll them until the first Publish. The editor Run button on workflows runs the **draft** (that's the point — test before publishing).
- Renumbering steps is safe for everything running on a **published** version — published versions are immutable and every run is pinned, which is why the old "N executions in flight" warning is gone. The one exception: a **draft test-run** parked at a wait/decision step. Drafts are edited in place, so renumbering the draft it's pinned to can move its resume target (the editor warns you in exactly that case).

## Technical reference

### The model

Per-row `version` on the step tables + a thin metadata table per definition type:

| | Workflows | Sequences |
|---|---|---|
| Parent pointer columns | `workflows.current_version`, `workflows.draft_version` | `sequence_templates.current_version`, `sequence_templates.draft_version` |
| Step rows | `workflow_steps.version` | `sequence_steps.version` |
| Version metadata | `workflow_versions` | `sequence_template_versions` |
| Runtime pin | `workflow_executions.workflow_version` | `sequence_enrollments.template_version` |

- `current_version = 0` is the first-class **never-published** state. Every dispatch site refuses it loudly (hook dispatcher, wf→wf `start_workflow`, seq→wf step, manual start, enroll funnel); cascade template matching filters it out silently so a published sibling can still win.
- `draft_version IS NULL` means no pending changes. Drafts are created **lazily**: the first step (or versioned-field) edit after a publish forks the published rows into `MAX(version)+1` (`ensureDraft`, one per router). Published versions are immutable **by construction** — no code path writes to a version once `current_version` has pointed at it.
- Discard **retires in place**: `retired_at` is stamped, rows are kept (draft test-run history stays resolvable), and the number is burned — the next draft is numbered past it.
- Executions/enrollments **pin** the version at creation (read-once-bind: the version is read once and bound as a literal into both the step load and the INSERT, so a concurrent publish can't split them).
- The **sequence template condition is versioned** (`sequence_template_versions.template_condition`); it gates per-run execution, so it publishes like a step. Everything else on the template (name/type/filters/active/description/test_input) is live — those steer enroll-time matching where latest-wins is correct. `sequence_templates.condition` is **legacy, never a source of truth**: written at create (and copied onto a duplicate's row), read only as a v0 fallback — by `ensureDraft`, the duplicate route, the template-PUT's no-op guard, and both GET overlays (list and single) — and never updated after a template's first draft fork. Don't trust it for anything else.

### Concurrency contract

Every **lifecycle** transaction — `ensureDraft`, publish, discard, on both routers — locks the **parent row first** (`SELECT … FOR UPDATE` on `workflows` / `sequence_templates` is statement #1 in all six). Run-creation paths deliberately take no parent lock: they are read-once-bind and touch no version table. That shared lock ordering is the only deadlock defense — `withTransaction` deliberately has no deadlock retry. If you add a new lifecycle operation, lock the parent first or you've reintroduced the deadlock.

`ensureDraft` requires a **connection inside a transaction**. On the bare pool, `FOR UPDATE` on autocommit serializes nothing (this was review finding D1; all step-mutating routes are now wrapped).

### The classifier (content-only vs structural)

`lib/versionDiff.js`. Fail-closed positive whitelist: it enumerates what counts as *content*; everything it can't positively account for is *structural*. A misclassification toward structural costs a disabled checkbox; toward content it silently corrupts live runs.

- **Workflows** — content = `label`, `note`, and config leaves that are **not branch targets**. Structural: step count/numbering, `type`, `function_name`, `error_policy`, any branch-target param (flat per `BRANCH_TARGET_PARAMS` **and** `evaluate_condition.branches[].then`), and any change to a `custom_code` step's **config** — its code can carry control flow no whitelist can vouch for (a label/note-only edit on a custom_code step is still content). Predicate *inputs* at any nesting depth — `variable` / `operator` / `value` / `conditions` / `match`, flat or inside `branches[]` — are **content**. One conditional exception: `set_vars` is content **only while the workflow has no runtime-resolved branch target**; the moment either version carries a non-literal target (e.g. `{{jump_to}}`), any `set_vars` change is structural, because `set_vars` populates the variables that target reads at dispatch. Only branch *targets* are structural: everything in `BRANCH_TARGET_PARAMS` plus `branches[].then`. Migrating a content-only publish that changed a predicate means in-flight runs evaluate the new condition when they reach that step — which is the intent (pinned by `tests/versionDiff.test.js`).
- **Sequences** — deliberately stricter: content = `action_config` changes **only** when the action_type is an unchanged `sms` / `email` / `task`. Structural: `action_type`, `timing`, step `condition`, `fire_guard`, `error_policy`, `webhook` / `start_workflow` / `internal_function` config, count/numbering, and the template-level condition. (Contrast: a workflow webhook URL change is content; a sequence webhook config change is not. Both follow the accepted review whitelists — the sequence control surface lives in columns, not config.)

The **server re-runs the classifier inside the publish transaction** and 409s a structural `migrate_in_flight` request. The UI checkbox is convenience, never the gate.

### Publish validation

- Workflows (`validateWorkflowDraft`): draft non-empty, contiguous 1..N numbering, literal branch targets in range, `foreach.end_step` strictly greater than its own step. Non-literal targets **warn but don't block** — `{{jump_to}}`-style dynamic targets are live production usage (wf41). `custom_code` mentioning `next_step` is informational.
- Sequences (`_validateSequenceDraft`): shape checks plus the editor's own `validateTiming` + `validateStepConfig` re-run across the **whole** draft.

### Migration (the opt-in checkbox)

Content-only publishes may repoint in-flight work to the new version:

- **Workflows**: one UPDATE over executions on the superseded version with status `active`/`delayed`/`held`. Runs stranded on *older* versions are reported (`stranded_versions` in `/draft-diff`) but never migrated — each hop back would need its own content-only proof.
- **Sequences**: one UPDATE repointing `active` enrollments. **That's the whole migration** — queued jobs are *not* rewritten. `executeStep` resolves the step by **identity**: `(template_id, pinned version, step_number)` from the job payload, falling back to `stepId` (still version-scoped) for legacy payloads. Content-only publishes preserve numbering by construction, so every queued step — pending *or already claimed `running`* — lands on the new version's row at fire time. (The earlier `JSON_SET` stepId remap only covered `status='pending'` and left claimed jobs holding dead stepIds; it was deleted in S4.1.) A resolution miss writes a `step_not_found` row to `sequence_step_log` — wedges are diagnosable. The recover route un-wedges by **advancing past** the missing step (`last logged step_number + 1`), the only sane move for a genuinely absent row — know that it skips rather than retries.
- The status-set asymmetry (workflows migrate `active`/`delayed`/`held`; sequences only `active`) is deliberate — enrollments have no equivalent parked states.

### Editor behavior

- `GET /workflows/:id` and `GET /sequences/templates/:id` return **draft-else-current** steps plus `editing_version` / `has_draft`; the sequences GET (and the **list** GET) overlay the versioned `template_condition` onto `template.condition` so the edit modal round-trips against the right value.
- Workflow editor Run sends `?use_draft=1` when a draft exists; sequence Preview previews draft-else-current (condition from the same version row as the steps).
- List `step_count` counts the editing version (`COALESCE(draft_version, current_version)`).

### API

Symmetric lifecycle endpoints on both routers (see chapter 11): `GET :id/versions`, `GET :id/draft-diff`, `POST :id/publish` (`{ migrate_in_flight? }`), `POST :id/discard-draft`.

### Footguns

1. **Manual SQL against step tables must carry a `version` predicate.** `UPDATE workflow_steps … WHERE workflow_id = X AND step_number = Y` now hits published, draft, *and retired* rows at once (older migration files in `ref/` predate this and are not templates to copy). Almost always you want `AND version = (SELECT current_version FROM workflows WHERE id = X)` — or better, edit the draft through the API and publish. `tests/versionPredicateCoverage.test.js` enforces this for application code; nothing enforces it for console SQL except you.
2. **Retired drafts accumulate step rows.** No reaper, no cap, nothing surfaces the count. Negligible today (a few hundred step rows total); revisit if version churn gets heavy.
3. **Publishing an identical draft is allowed** and burns a version number. Harmless, unguarded.
4. **`sequence_templates.condition` is legacy** (see above). The versioned truth is `sequence_template_versions.template_condition`.
5. **wf2 ("Test Workflow") is genuinely broken** (single step, `set_next → 3`) and will be blocked by publish validation on its first edit — that's the gate working, not a bug.
