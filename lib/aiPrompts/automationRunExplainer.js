'use strict';
// A17.1 — the run-explainer rules the answer stage gets ONLY when the
// investigation read automation evidence (appended by assistantService's
// answer call; zero token cost on every other question).
//
// Each reading rule is measured in lib/workflow_engine.js, not taken from the
// manual (two manual claims were false and are corrected in the same slice —
// manual/03-YisraFlow/08-error-policies.md). The causes catalog is curated
// guidance: the model cites the stored row, it never invents a diagnosis.

const AUTOMATION_RUN_EXPLAINER = `
AUTOMATION RUN READING RULES (server-verified engine behavior; these override any manual text that disagrees):
1. A history row's status "success" means only that the step DID NOT THROW. Several registry functions return
   {"success":false,...} without throwing, and such a row records as SUCCESS with the failure visible only in
   output_verdict. Always read output_verdict before calling a step successful.
2. Retries run for EVERY strategy while attempts remain; the strategy (ignore/abort/retry_then_*) is consulted only
   after the last attempt fails. "abort" with max_retries 2 really does retry twice before aborting.
3. The attempts value in step history is never written (always 0): retry counts cannot be read from history.
4. A failed row's output_verdict is null by design (the engine stores no output on failure), and resolved payloads
   are withheld from you entirely — diagnose from error_message, status, duration_ms and the definition.
5. An unresolved {{placeholder}} resolves to an EMPTY STRING silently, and workflow templating has no modifiers —
   {{x|default:y}} is not syntax and resolves to ''. A blank where the config expected a value is the single most
   likely cause of a "ran but did nothing" report.
6. Execution status completed_with_errors means at least one history row failed — INCLUDING rows from before a
   resume. It does not mean the final pass failed.
USUAL CAUSES, curated — cite the specific stored row and never invent a diagnosis: a missing required param (the
validator's error names it); webhook 401/403 (expired or wrong credential on that step); a provider timeout
(transient — a single one usually self-heals); a Dropbox 409 conflict (the folder or file already exists); an unknown
column named inside a code step's input; a sequence step skipped as already-enrolled or by its condition
(skip_reason says so — a normal guard, not an error).
OUTPUT CONTRACT for a run explanation: say what ran in order, where control actually went, what diverged from the
author's apparent intent, the likely cause grounded in the cited rows, and the fix AS INSTRUCTIONS TO THE HUMAN —
which step to open, what to change, and whether re-running is safe. Do not propose an action card for workflow or
sequence edits; authoring them is not available.`;

module.exports = { AUTOMATION_RUN_EXPLAINER };
