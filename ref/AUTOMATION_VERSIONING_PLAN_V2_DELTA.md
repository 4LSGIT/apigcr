# Automation Versioning — Plan v2 Delta (post independent review)
2026-08-18. Reads together with `AUTOMATION_VERSIONING_PLAN.md` (v1) and the independent
review of the same date. Review verdict was NO-GO with "fix D1–D3 → GO-WITH-CHANGES";
every blocker was independently re-verified against the tarball before acceptance. Fred
delegated the review's open questions; rulings below. One ruling reverses an earlier
answer of Fred's and is flagged as such.

## Rulings on the review's open questions
1. **D4 (never-published entities run zero steps silently)** → **option (a)**:
   `POST /workflows` and `POST /sequences/templates` create with `current_version = 0`;
   all four dispatch sites + enrollment matching refuse `current_version = 0` with a clear
   "never published" error. Ships in **S3/S4 together with the publish endpoints** (refusal
   without a publish path would brick creation). S2 keeps creates at the schema default 1
   and seeds the v1 metadata row, so the "every published version has a metadata row"
   invariant holds through the window.
2. **O1 (in-flight migration)** → **accepted** (Fred: "not convinced" by full deferral —
   aligned). Amended decision 5: *default leave-in-flight; per-publish opt-in offered only
   for content-only diffs, enforced by a fail-closed positive-whitelist classifier;
   structural diffs cannot migrate (control disabled with reason); semantic step matching
   permanently rejected.* Classifier rules exactly as the review specifies: reuse
   `BRANCH_TARGET_PARAMS` + walk `branches[].then`; `custom_code` always structural;
   sequences content = leaves of `action_config` for `sms/email/task` only; any
   `timing/condition/fire_guard/error_policy/action_type`, step-count, numbering, or
   template-`condition` change = structural. Migration mechanics: workflows = single
   `UPDATE workflow_executions … status IN ('active','delayed','held')`; sequences =
   enrollment UPDATE + guarded `JSON_SET` of the pending job's `data.stepId` (payload
   already carries `stepNumber` — lib/sequenceEngine.js:692); `affectedRows = 0` on the
   job rewrite = benign one-step lag (documented, accepted). Lands in S3/S4 with the
   draft-diff endpoint. The classifier gets first-class scrutiny in the final review.
3. **O2 (discard orphans draft-run history)** → **retire-in-place**. Discard sets
   `retired_at` on the version row, clears `draft_version`, keeps step rows. Migration
   already carries `retired_at` on both version tables. `ensureDraft` therefore computes
   the next draft as `MAX(version) + 1` (retired versions occupy numbers), not
   `current_version + 1`.
4. **O3 (version `filters`?)** → **`condition` only; `filters` stays live.**
   ⚠ *This reverses Fred's earlier "yes" to plan-v1 Q1* (Fred subsequently delegated the
   review's restatement of the same question). Reasoning: `type`/`name`/`active` are live
   anyway, so the publish gate never covered matching topology — versioning `filters`
   buys inconsistency, drags `routes/sequenceTypes.js:270` (M1) into scope, and leaves
   the live-column fate unresolved, all for zero in-flight benefit (filters are
   enroll-time only). If overruled later, it is an additive change. M1 is moot under this
   ruling.
5. **D5 (dead reorder route)** → standalone **S0**, shipped first (live production bug,
   zero coupling to versioning).
6. **D2 (reserved word)** → renamed **`template_condition`** in
   `sequence_template_versions`.

## Blocker dispositions
- **D1** — S4 explicit deliverable: wrap `POST /sequences/templates`,
  `PUT /sequences/templates/:id`, `PUT …/steps/:stepNumber`, `PATCH …/steps/:stepNumber`
  in `db.withTransaction`, hoisting `validateTiming`/`validateStepConfig`/
  `validateTemplateFilters` outside the tx body and converting inline error returns to
  the `{ respond }` outcome pattern. S2 marks this in the sequences
  `resolveEditTargetVersion` helper comment so S4 cannot miss it.
- **D3** — enrollment stamping is **read-once-bind** (`template.current_version` into a
  JS variable, bound to both the step load and the INSERT). The subquery-in-insert form
  is banned everywhere; all four `workflow_executions` sites also read-once-bind off
  their existing workflow SELECTs, for uniformity and to avoid resting on the (corrected)
  locking rationale. Deadlock posture: `withTransaction`'s TRANSIENT set stays unchanged;
  instead the **lock-ordering invariant** — every transaction touching version tables
  locks the parent (`workflows`/`sequence_templates`) row `FOR UPDATE` first — is the
  S3/S4 rule (some tx callbacks in this repo are not retry-safe, so adding
  `ER_LOCK_DEADLOCK` to the global retry set is the riskier fix).
- **D6** — `loadWorkflowStep(workflowId, stepNumber, version, db)` signature change +
  throw guard; `scheduleFromStep` keeps its signature but **throws** when
  `enrollment.template_version` is not a positive integer (same runtime loudness, five
  fewer churned call sites — deliberate, documented divergence from the review's
  signature-change prescription). CONTEXT-CONSTRUCTION is a first-class audit class;
  `tests/versionPredicateCoverage.test.js` asserts the guard, the ctx keys, and the
  recover route's explicit column list.
- **D7** — new key names `uk_workflow_version_step` / `uk_template_version_step`; drop
  and add as separate statements; no `AFTER` clause.

## Other accepted findings
- **V1–V3** — audit regenerated from whole-repo grep (68 lines, zero unclassified);
  wrong line attributions corrected; `previewEnrollmentSteps` classified and converted.
- **M2** — audit scope = whole repo; `services/*` sites classified EXEMPT (live header
  fields only).
- **M3** — sweeps intentionally cover ALL versions (drafts validated pre-publish);
  in-file comments added to both scripts.
- **M4/M5** — `executeSingleStep` and the resume-validation check are PINNED-READ; both
  converted in S2.
- **M6** — `decision_requests.resume_step` recorded as exempt, correct-by-construction
  post-versioning.
- **M7** — deploy invariants written into the audit: migration → S2 same window; S2 ships
  every read conversion; nothing creates version > 1 until S3/S4; S4 converts the
  sequence `condition` read (executeStep's live join) and write in the same deploy — the
  condition read deliberately stays LIVE through S2/S3 to avoid a stale-condition window
  (v1's backfilled snapshot would otherwise shadow live edits between S2 and S4).
- **O5** — publish validation (S3/S4) extended: `foreach.end_step` strictly greater than
  its own step; walk `evaluate_condition.branches[].then`; remap warnings become publish
  blockers; `custom_code` `next_step` mention surfaced informationally; sequences re-run
  `validateTiming`/`validateStepConfig` across the whole draft at publish.

## Amendment to plan-v1 decision 7 (duplicate), consequential from D4a
Duplicate copies the **content** of the source's published `current_version` (fallback:
its draft, if never published) — but the duplicate itself lands **unpublished**
(`current_version = 0`, content as draft v1) once S3/S4 ship, because publishing
implicitly on duplicate would bypass the review boundary. In the S2 window (no publish
endpoint yet) duplicates land as published v1 with a seeded metadata row, preserving
current behavior.

## Slice status
- **S0** ✅ shipped in this bundle — reorder route relocated above `:stepNumber`
  (routes/sequences.js), + `tests/sequences.routeOrder.test.js` (verified: fails on
  pristine main, passes on fixed).
- **S1** ✅ — `ref/2026-08-18_automation_versioning.sql`,
  `ref/AUTOMATION_VERSIONING_AUDIT.md`.
- **S2** ✅ — all read/write conversions per the audit; full jest suite green (3529
  pass; one pre-existing skip); `tests/esignReminders.test.js` positional assertions
  updated for the new enrollment column order.
- **S3** — workflows draft/publish: `ensureDraft` (replaces `resolveEditTargetVersion`
  body), publish/discard(retire)/draft-diff endpoints, content-only classifier + migrate
  checkbox, v0-at-create + dispatch refusal, O5 validation.
- **S4** — sequences ditto + D1 transaction wrapping + versioned-condition read/write
  swap + PUT-template versioned fields to draft.
- **S5/S6** — editors (workflows.html / sequences.html): version badge, publish modal
  with diff + migrate checkbox, discard, draft-run cue.
- **S7** — docs, cookbook, final-product independent review prompt.

## Deploy order for this bundle
1. **S0 now** (independent): deploy `routes/sequences.js` + new route-order test. No
   migration needed.
2. **Migration** `ref/2026-08-18_automation_versioning.sql`, run to completion in the
   console, immediately followed by —
3. **S2 deploy** (all remaining files in this bundle).
Nothing in S2 changes behavior at version 1; rollback = revert deploy (columns/tables
are additive and inert to the old code).
