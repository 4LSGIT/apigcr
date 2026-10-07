// lib/internal_functions/composition.js

// NOTE: workflow_engine is NOT required here — circular dependency:
// internal_functions → workflow_engine → job_executor → internal_functions.
// Instead, require it lazily inside start_workflow (same pattern as
// sequences.js → sequenceEngine).

const fns = {};

// ─────────────────────────────────────────────────────────────
// COMPOSITION (Slice 6R) — workflow → workflow
//
// Completes the composition matrix: hooks→wf/seq (actionDispatchers),
// seq→wf (sequenceEngine.executeStartWorkflowAction), wf→seq
// (enroll_sequence). This function is the wf→wf edge.
// ─────────────────────────────────────────────────────────────

/**
 * start_workflow
 * Start another workflow execution from a workflow step.
 *
 * Mirrors the sequence 'start_workflow' step's param semantics
 * (lib/sequenceEngine.js executeStartWorkflowAction) with one deliberate
 * divergence: the target's `active` flag IS checked (matching
 * actionDispatchers.deliverWorkflow's hook-side behavior) and an inactive
 * target throws. A workflow step pointing at an inactive workflow is a
 * misconfiguration and should fail loudly per the step's error_policy
 * rather than silently starting a workflow the operator turned off.
 *
 * params:
 *   workflow_id          {number|string}  — required. Target workflow ID.
 *   init_data            {object}         — optional. Becomes the child
 *                                           execution's init_data AND seeds
 *                                           its variables (same dual-write
 *                                           as every other creation site).
 *   contact_id_override  {number|string}  — optional. Explicit contact tie.
 *                                           Precedence (via
 *                                           resolveExecutionContactId):
 *                                           override > init_data[target's
 *                                           default_contact_id_from] > NULL.
 *
 * returns (step output — {{this.output.workflow_execution_id}} etc.):
 *   { success: true,
 *     output: { workflow_execution_id, contact_id, workflow_id } }
 *
 * Known accepted gap — no retry-safety: unlike the sequence step (which
 * consults sequence_step_log for a prior execution id), workflow steps have
 * no per-step log to check BEFORE execution, so an error_policy retry that
 * fires after a successful INSERT would double-start the child. In practice
 * the only throw-window after the INSERT is the scheduleResume enqueue that
 * follows it (a failure there fails THIS step loudly rather than stranding
 * the child), so the exposure is negligible.
 *
 * Known accepted gap — no recursion guard: functions receive (params, db)
 * only; there is no execution context to compare the target against, so a
 * workflow can start itself (A→A) or a cycle (A→B→A). Each hop is a fresh
 * execution row advanced via a queued workflow_resume job (background-CPU
 * slice, 2026-08), so a cycle won't blow the stack — and the once-a-minute
 * heartbeat now rate-limits each hop to one per tick. It will, however,
 * mint execution rows until someone notices. Author responsibly.
 */
fns.start_workflow = async (params, db) => {
    // ← lazy require (breaks internal_functions → workflow_engine →
    //   job_executor → internal_functions cycle)
    const { scheduleResume, resolveExecutionContactId, captureWorkflowInput, captureRefusedStart } = require('../workflow_engine');

    // workflow_id — required positive integer (numeric string OK; any
    // {{placeholder}} was resolved by the engine before we got here).
    const workflowIdNum = Number(params.workflow_id);
    if (!Number.isInteger(workflowIdNum) || workflowIdNum <= 0) {
      throw new Error(`start_workflow: workflow_id is required and must be a positive integer (got ${JSON.stringify(params.workflow_id)})`);
    }

    const [[wfRow]] = await db.query(
      `SELECT id, active, default_contact_id_from, capture_mode, current_version FROM workflows WHERE id = ?`,
      [workflowIdNum]
    );
    if (!wfRow) {
      throw new Error(`start_workflow: workflow #${workflowIdNum} not found`);
    }
    // Refusals — thrown below, AFTER init_data is parsed, so an armed capture
    // can still bank the payload (capture-before-publish). A payload that will
    // never reach a step is exactly the sample the target workflow needs in
    // order to become publishable.
    //
    // Versioning (S3, review D4a): never-published targets are refused loudly —
    // pre-versioning this silently completed a zero-step child execution.
    // The inactive check is a deliberate divergence from the sequence step
    // (which historically skipped it) — matches the hook dispatcher.
    const refusal = !wfRow.current_version
      ? `start_workflow: workflow #${workflowIdNum} has never been published — publish it before targeting it`
      : !wfRow.active
        ? `start_workflow: workflow #${workflowIdNum} is inactive`
        : null;

    // init_data — optional plain object; default {}.
    let initData = {};
    if (params.init_data !== undefined && params.init_data !== null && params.init_data !== '') {
      if (typeof params.init_data !== 'object' || Array.isArray(params.init_data)) {
        throw new Error('start_workflow: init_data must be a JSON object');
      }
      initData = params.init_data;
    }

    if (refusal) {
      const captured = await captureRefusedStart(db, workflowIdNum, initData);
      throw new Error(captured
        ? `${refusal} (the init_data was captured as that workflow's sample)`
        : refusal);
    }

    // contact_id_override — optional positive integer.
    let explicitContactId;
    const override = params.contact_id_override;
    if (override !== undefined && override !== null && String(override).trim() !== '') {
      const n = Number(override);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`start_workflow: contact_id_override must be a positive integer (got ${JSON.stringify(override)})`);
      }
      explicitContactId = n;
    }

    // Precedence: explicit override > init_data[default_contact_id_from] > NULL.
    const contactId = resolveExecutionContactId({
      explicitContactId,
      initData,
      defaultKey: wfRow.default_contact_id_from,
    });

    // Capture slice — one-shot init_data capture when armed. 'intercept' is
    // left armed for the step-0 hold in advanceWorkflow.
    if (wfRow.capture_mode === 'capturing') {
      await captureWorkflowInput(db, workflowIdNum, initData);
    }

    // INSERT — fourth workflow_executions creation site (Cookbook §5.21).
    // The other three: routes/workflows.js POST /workflows/:id/start,
    // actionDispatchers.deliverWorkflow (hook→wf),
    // sequenceEngine.executeStartWorkflowAction (seq→wf).
    const [result] = await db.query(
      `INSERT INTO workflow_executions
       (workflow_id, contact_id, status, init_data, variables, current_step_number, workflow_version)
       VALUES (?, ?, 'active', ?, ?, 1, ?)`,
      [workflowIdNum, contactId, JSON.stringify(initData), JSON.stringify(initData),
       // Read-once-bind (review D3): stamped from the wfRow SELECT above.
       wfRow.current_version]
    );
    const executionId = result.insertId;

    console.log(`[WF→WF] start_workflow: started workflow #${workflowIdNum} execution ${executionId} (contact ${contactId ?? 'none'})`);

    // Queued start (background-CPU slice, 2026-08) — mirrors the seq→wf step
    // and the hook dispatcher. Previously a detached advanceWorkflow that ran
    // CPU-throttled once no request was in flight; now the child is handed to
    // the job queue and the next /process-jobs heartbeat (≤60s) advances it
    // request-bound at full CPU. The parent does NOT wait for the child (same
    // semantics as before — it gets the execution id and moves on); queueing
    // rather than inline-awaiting also keeps deep WF→WF chains from nesting
    // inside one request. A scheduling failure throws into this step's own
    // error handling instead of silently stranding the child at 'active'.
    await scheduleResume(executionId, new Date(), 1, db);

    return {
      success: true,
      output: {
        workflow_execution_id: executionId,
        contact_id: contactId,
        workflow_id: workflowIdNum,
      },
    };
  };

fns.start_workflow.__meta = {
  category: 'composition',
  // Sequences have a native 'start_workflow' step type (Slice 3.3) —
  // exposing this function there would duplicate it in the picker.
  workflowOnly: true,
  description: 'Start another workflow from this one. init_data becomes the child\'s init_data (and seeds its variables). Fails if the target workflow is missing or inactive. Output: workflow_execution_id.',
  params: [
    // Typed 'string' (not 'integer') so the form renders a TEXT input —
    // a number input silently blanks {{placeholder}} values on render,
    // which would clobber them on save. Same convention as contact_id /
    // case_id elsewhere in the registry. Numeric shape is enforced at
    // save time by routes/workflows.js validateStartWorkflowConfig and at
    // runtime by the function itself.
    { name: 'workflow_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'Target workflow ID (number, or a {{placeholder}} resolved at runtime). Existence is verified at save time for literal IDs.',
      example: '12' },
    { name: 'init_data', type: 'object', required: false,
      description: 'JSON object passed to the child as init_data (also seeds its variables). Check the target\'s test_input for the expected keys.',
      example: { contactId: '{{contactId}}', caseId: '{{caseId}}' } },
    { name: 'contact_id_override', type: 'string', required: false, placeholderAllowed: true,
      description: 'Explicit contact to tie the child execution to. Overrides the target\'s default_contact_id_from resolution.',
      example: '{{contactId}}' },
  ],
  example: {
    workflow_id: '12',
    init_data: { contactId: '{{contactId}}', reason: 'parent workflow escalation' },
  },
};

/**
 * cancel_workflow_execution
 * Cancel another workflow execution — the registry twin of
 * POST /executions/:id/cancel (CTA arc S1, ref/CTA_DESIGN.md §4 / R7). Both
 * run services/workflowExecutionService.cancelWorkflowExecution: one
 * transaction (guarded status write, pending workflow_resume jobs deleted,
 * pending decisions cancelled), paired decision tasks dismissed post-commit.
 *
 * params:
 *   execution_id  {number|string}  — required. Target workflow_executions.id.
 *   reason        {string}         — required, ≥3 chars after trim; stored in
 *                                    cancel_reason (truncated to 500).
 *
 * Idempotent: a target that is missing or already finished is NOT an error —
 * { success: true, output: { skipped: 'status was completed' } } — so a CTA
 * button clicked after the run ended, or a retried step, succeeds quietly.
 *
 * Self-cancel is refused (target == the calling execution): the cancel would
 * land mid-step on the very run executing it. End a workflow from inside
 * with set_next 'cancel' instead.
 */
fns.cancel_workflow_execution = async (params, db) => {
  // lazy require (convention)
  const { cancelWorkflowExecution, normalizeCancelReason } = require('../../services/workflowExecutionService');

  const target = Number(params.execution_id);
  if (!Number.isInteger(target) || target <= 0) {
    throw new Error(`cancel_workflow_execution: execution_id must be a positive integer (got ${JSON.stringify(params.execution_id)})`);
  }
  const self = Number(params._execution_id);
  if (Number.isInteger(self) && self > 0 && self === target) {
    throw new Error("cancel_workflow_execution: a workflow cannot cancel its own execution — end it with set_next 'cancel' instead");
  }
  const norm = normalizeCancelReason(params.reason == null ? '' : String(params.reason));
  if (norm.error) throw new Error(`cancel_workflow_execution: ${norm.error}`);

  const outcome = await cancelWorkflowExecution(db, target, norm.reason, { by: 'automation' });
  if (!outcome.cancelled) {
    const [[row]] = await db.query('SELECT status FROM workflow_executions WHERE id = ?', [target]);
    return {
      success: true,
      output: {
        execution_id: target,
        cancelled: false,
        skipped: row ? `status was ${row.status}` : 'execution not found',
      },
    };
  }
  return {
    success: true,
    output: {
      execution_id: target,
      cancelled: true,
      cancel_reason: outcome.cancel_reason,
      decisions_cancelled: outcome.decisionsCancelled,
    },
  };
};

fns.cancel_workflow_execution.__meta = {
  category: 'composition',
  description:
    'Cancel another workflow execution (same as the Cancel button: pending resume jobs removed, pending ' +
    'decisions closed, paired tasks dismissed). Already-finished or missing targets succeed with ' +
    'output.skipped. A workflow cannot cancel itself — use set_next "cancel".',
  params: [
    // 'string' (not 'integer') for the same reason as start_workflow.workflow_id:
    // a number input blanks {{placeholder}} values on render.
    { name: 'execution_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'Target workflow_executions.id (number, or a {{placeholder}} resolved at runtime).',
      example: '{{childExecutionId}}' },
    { name: 'reason', type: 'string', required: true, placeholderAllowed: true,
      description: 'Why — stored as the execution\'s cancel_reason. At least 3 characters.',
      example: 'Superseded by a newer intake' },
  ],
  example: { execution_id: '{{childExecutionId}}', reason: 'Superseded by a newer intake' },
};

module.exports = fns;