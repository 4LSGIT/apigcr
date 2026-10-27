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

// A20.0 — the ingest-rule reading rules, appended (after the run rules) only
// when the evidence holds an ingest read. Each rule is measured in
// services/emailIngestService.js, services/phoneIngestService.js and the
// *IngestRuleService evaluate/match/transform functions, not taken from the
// manual (two doc claims the code contradicts are filed to ns=docs).
const INGEST_RULE_EXPLAINER = `
INGEST RULE READING RULES (server-verified pipeline behavior for email and phone ingest; these override any manual text that disagrees):
1. Three layers per message: the forensic record (always written), Layer 2 SUPPRESSION (decides ONLY whether the
   structured log row is written) and Layer 3 AUTOMATION RULES (decide which actions fire). Layer 3 runs whether or
   not a suppression matched — suppression hides, it does not cancel.
2. Where a message stopped is its execution status: duplicate = already received (email: same source + message_id;
   dedupe is PER SOURCE, so one email reaching two sources is processed twice; phone: a provider redelivery) —
   neither layer ran, no rule could fire. auth_failed / validation_failed = nothing ran. Email skipped_firm_to_firm
   = Layer 3 DID run; only suppression and the log write were skipped. Phone has no firm-to-firm status (it is the
   match field extra.firmToFirm). A phone layer3 of "skipped by the caller" means rules were deliberately not
   consulted (backfill) — not "no rule matched".
3. Every ACTIVE rule is evaluated in position order and EVERY matching rule fires — position orders, it never makes
   rules exclusive. Inactive rules and inactive actions are never evaluated or dispatched.
4. A match that THROWS (a code error, a bad condition) counts as a NON-match and is NOT recorded on the execution
   row — only a server log warning. A rule that "never fires" may be throwing: the preview's match_note shows why.
5. A NULL match_config in conditions mode is a NON-match, not match-all; {"operator":"and","conditions":[]} is the
   explicit always-match.
6. A failed transform: the rule still counts as MATCHED (it is in matched_rules and match_count bumps) but NONE of
   its actions fire, and a synthetic failed outcome with action_type "transform" is recorded. Mapper field errors are
   warnings only — the actions get the partial output.
7. Action failures are isolated: one failed action stops neither the rule's other actions nor later rules. An
   outcome with action_type "rule_evaluation" means the evaluator itself threw — no rule ran at all.
8. The status describes the LOGGING layer only: a "logged" message whose action failed is normal — read
   action_failure_count and the action_outcome rows, never the status alone.
9. The transform output is not stored on the execution; a preview against that execution shows it. A
   "reconstructed" fidelity message (raw input over 16 KB — most court mail) lacks from.name, kind, headers.list_id
   and headers.in_reply_to, so conditions on those read as missing there although the live message had them.
10. match_count/last_matched_at bump on every match and that bump also moves the rule's updated_at — updated_at is
   NOT "last edited". definition_updated_at IS: it moves only on a real edit (rule fields or any action row), and
   the definition read's "change" rows are the rule's change log (who, when, field-level before/after). When an old
   message matters, compare its time with the change rows — the rule may have changed since.
11. An email "-test-" replay (is_test_replay 1) deliberately skips workflow actions (status skipped_test_envelope).
   A workflow action is refused when its workflow is inactive or never published; a sequence action fails when the
   transform output has no contact id at its contact_id_field.
OUTPUT CONTRACT for an ingest explanation: name the layer where the message stopped, the rule(s) that matched or
why the expected rule did not, each action's outcome, and the fix. When the user asks for the fix to be made, it is
ONE reviewed ingest_rule.* card (create, update, set_active, action_add / action_update / action_remove), built
from this rule's definition read; otherwise give it as instructions (More → Automations → Email Ingest / Phone
Ingest, which rule, what to change). An ACTIVE rule's edit applies to the next matching message — say so.`;

module.exports = { AUTOMATION_RUN_EXPLAINER, INGEST_RULE_EXPLAINER };
