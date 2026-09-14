# Automation Versioning — Whole-Repo Query-Site Audit (S1)
Generated 2026-08-18 from grep over `routes/ lib/ services/ scripts/` (whole repo per
review finding M2), against main **after S0** (the sequences reorder route relocation —
routes/sequences.js line numbers below are post-S0).

Regenerate command:
```
grep -rn "workflow_steps\|sequence_steps" --include="*.js" routes/ lib/ services/ scripts/ \
  | grep -v "workflow_execution_steps\|sequence_step_log"
```
Site count at generation: **68 lines** → 61 code sites + 7 comment/doc lines. Zero
unclassified (the S2 gate).

## Classifications
- **DRAFT-CRUD** — editor write path. S2: version predicate bound to `current_version`
  (resolved once per route via `resolveEditTargetVersion`). S3/S4: same call site swaps to
  `ensureDraft`.
- **PINNED-READ** — engine/execution path; must use the execution's/enrollment's stamped
  version.
- **CURRENT-READ** — resolves against the published `current_version` (new
  runs/enrollments, duplicate source, step counts).
- **EDITOR-READ** — what the editor/preview shows. S2: current. S3/S4: draft-else-current.
- **ID-JOIN** — joins by step row **id**; per-version rows make row ids version-specific,
  so these are version-correct with no change.
- **CONTEXT-CONSTRUCTION** — object literals / explicit column lists feeding
  version-scoped functions (review finding D6). Each must carry the version key.
- **SWEEP** — release-gate sweep scripts; intentionally scan ALL versions (drafts get
  validated before they can be published — desirable). Comment added in-file (M3).
- **ALL-VERSIONS** — deliberate unversioned write (whole-entity delete).
- **EXEMPT** — cannot or should not be version-filtered; reason given.
- **COMMENT** — documentation text only.

## routes/workflows.js (workflow_steps)
| Line | What | Class | S2 action |
|---|---|---|---|
| 53, 895 | comments | COMMENT | — |
| 115, 207 | `remapBranchTargets` select/update | DRAFT-CRUD | fn gains `version` param; `AND version = ?` on both |
| 630 | exec history `LEFT JOIN workflow_steps ws ON ws.id = h.step_id` | ID-JOIN | none |
| 811, 890 | list step_count subqueries | CURRENT-READ | `AND version = w.current_version` |
| 918 | GET /:id steps | EDITOR-READ | `AND version = ?` (current in S2) |
| 1060 | insert-at MAX(step_number) | DRAFT-CRUD | `AND version = ?` |
| 1072, 1078, 1094 | insert-at park/shift/insert | DRAFT-CRUD | predicate + INSERT stamps version |
| 1229 | POST step insert | DRAFT-CRUD | INSERT stamps version |
| 1287 | DELETE workflow → delete steps | ALL-VERSIONS | none (whole entity); comment added |
| 1346, 1355, 1364 | DELETE step verify/delete/renumber | DRAFT-CRUD | `AND version = ?` |
| 1452–1531 | reorder park/shift/place (6 stmts) | DRAFT-CRUD | `AND version = ?` on all |
| 1710, 1735 | PUT step verify/update | DRAFT-CRUD | `AND version = ?` |
| 1799, 1861 | PATCH step verify/update | DRAFT-CRUD | `AND version = ?` (incl. dynamic-SET stmt) |
| 1936, 1956 | duplicate select/insert | CURRENT-READ src | select `AND version = ?` (source current, fallback draft if never published — S3); insert version 1 into new wf |
| 2199 | resume-mode step-existence check | **PINNED-READ** (M5) | `AND version = ?` bound to `execution.workflow_version` |

Execution-insert (workflow_version stamp): routes/workflows.js:468 — route's existing
workflow SELECT gains `current_version`; INSERT stamps it (read-once-bind, per D3's
corrected rationale — no subquery form anywhere).

## lib/workflow_engine.js
| Line | What | Class | S2 action |
|---|---|---|---|
| 403 | `loadWorkflowStep` | PINNED-READ | signature → `(workflowId, stepNumber, version, db)`; `AND version = ?`; throws on missing version |
| 244 | caller (advance loop) | CONTEXT | passes `execution.workflow_version` (real row) |
| 859 | caller (`executeSingleStep`) — M4 | CONTEXT | passes `execution.workflow_version` (real row; reachable via resume `mode:'single_step'`) |
| 442 | comment | COMMENT | — |

## routes/sequences.js (sequence_steps; post-S0 lines)
| Line | What | Class | S2 action |
|---|---|---|---|
| 81 | comment | COMMENT | — |
| 318 | list step_count subquery | CURRENT-READ | `AND version = t.current_version` |
| 346 | GET template steps | EDITOR-READ | `AND version = ?` |
| 603, 622 | duplicate select/insert | CURRENT-READ src | select versioned; insert version 1 into new template |
| 683–699 | POST step MAX/park/shift/insert | DRAFT-CRUD | predicates + INSERT stamps version |
| 744, 749 | PUT step verify/update | DRAFT-CRUD | `AND version = ?` |
| 828–879 | reorder park/shift/place (6 stmts) | DRAFT-CRUD | `AND version = ?` on all |
| 930, 949 | PATCH step verify/update (dynamic SET) | DRAFT-CRUD | `AND version = ?` |
| 968, 973, 976 | DELETE step verify/delete/renumber | DRAFT-CRUD | `AND version = ?` |
| 1428, 1491, 1522 | step-log joins `ON s.id = l.step_id` | ID-JOIN | none |
| 1787 | recover-route timing loader | PINNED-READ | `AND version = ?` bound to `enrollment.template_version` |

## lib/sequenceEngine.js
| Line | What | Class | S2 action |
|---|---|---|---|
| 1024 | `executeStep` step load `WHERE id = ?` | ID-JOIN | none (scheduled jobs carry version-specific stepId) |
| 1198 | `scheduleFromStep` loader | PINNED-READ | `AND version = ?`; **fail-loud guard** — throws if `enrollment.template_version` is not a positive int (D6; guard chosen over signature change: identical loudness, 5 fewer churned call sites — divergence from review prescription, reasoned) |
| 1468 | `_enrollWithTemplate` steps load | CURRENT-READ | `const version = template.current_version` read once; `AND version = ?`; INSERT :1525 stamps `template_version`; `enrollmentCtx` :1539 gains `template_version` (D3/D6) |
| 1705 | `previewEnrollmentSteps` steps load | EDITOR-READ | template select :1691 gains `current_version`; loader versioned (S4: draft-else-current) |
| 775, 1114, 1701 | comments | COMMENT | — |

Mid-flight `sequence_templates` reads: `executeStep` join :993–:996 reads live
`condition` — **stays live through S2/S3** and converts to the pinned
`sequence_template_versions.template_condition` join **in S4, in the same deploy as the
versioned condition write path** (avoids the stale-condition window; plan-v2 §S4 invariant).
`cancelSequences` :1282 joins template for `type` — live/operational, correct.
`enrollContact` :518 matching on live `type/active/filters` — live per ruling O3.

## Other insert sites (workflow_version stamp; read-once-bind)
| Site | Existing workflow SELECT to extend |
|---|---|
| lib/actionDispatchers.js:274 | :238 `SELECT active, default_contact_id_from, capture_mode` → + `current_version` |
| lib/internal_functions/composition.js:123 | :74 same shape → + `current_version` |
| lib/sequenceEngine.js:871 (`start_workflow` step) | its workflow lookup → + `current_version` |
| routes/workflows.js:468 | route's workflow SELECT → + `current_version` |

`INSERT INTO sequence_enrollments` exists at exactly **one** site
(lib/sequenceEngine.js:1525; both public enroll paths funnel through
`_enrollWithTemplate` — review V1).

## CONTEXT-CONSTRUCTION registry (D6)
| Site | Object | Must carry |
|---|---|---|
| lib/sequenceEngine.js:1539 | `enrollmentCtx` | `template_version` |
| routes/sequences.js recover route (~:1739) | explicit column list `SELECT id, template_id, status, current_step` | + `template_version` |
| lib/workflow_engine.js:244, :859 | `execution` (real rows, `SELECT *`) | carries `workflow_version` post-migration |
| lib/sequenceEngine.js executeStep :994 | `e.*` join | carries `template_version` post-migration |

Enforced by `tests/versionPredicateCoverage.test.js` (SQL-literal scan + these
context-site assertions).

## services/, scripts/, misc (M2/M3)
| Site | Reads | Class |
|---|---|---|
| services/emailIngestValidator.js:371,:381; services/esignTemplateService.js:602,:649; services/emailIngestMetaService.js:207; services/phoneIngestMetaService.js:220; services/caseService.js:985; services/contactService.js:1882,:2608; services/apptService.js:1286; lib/alerting.js:392 | `sequence_templates` / `workflows` header fields (`id/name/type/active/slug`) only | EXEMPT — live operational fields, unversioned by design (§1.5) |
| scripts/sweep_validate_live.js:73; scripts/verify_strictstring_live.js:49 | `workflow_steps` unfiltered | SWEEP — intentionally all versions (drafts validated pre-publish); in-file comment added in S2 |
| lib/internal_functions/db.js:11 | `query_db` table allowlist | EXEMPT — user-authored SQL; authored steps that query step tables see all versions unless they filter themselves. Live check 2026-08-18: **zero** existing workflow/sequence steps use `query_db` against `workflow_steps`/`sequence_steps` |
| decision_requests.resume_step (routes/workflows.js:80–:88) | frozen step-number copy | EXEMPT — **correct-by-construction post-versioning** (M6): pinned versions never renumber, so the documented strand-on-renumber exposure disappears |
| lib/internal_functions/index.js:354 | comment | COMMENT |

## Deploy invariants (M7)
1. Migration (`ref/2026-08-18_automation_versioning.sql`) completes immediately before the
   S2 deploy.
2. S2 ships **every** conversion in this table in one deploy — no partial read conversion.
3. Nothing may create a version > 1 until S3/S4: `ensureDraft` and the publish endpoints
   do not exist until then, and S2 contains no other writer of `version <> 1`.
4. S4 converts the sequence condition **read** (executeStep join) and **write**
   (PUT template → draft) in the same deploy.
