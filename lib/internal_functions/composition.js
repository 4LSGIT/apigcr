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
 * the only throw-window after the INSERT is the synchronous tail of this
 * function (the advance is fire-and-forget and its failure never re-fires
 * the step), so the exposure is negligible.
 *
 * Known accepted gap — no recursion guard: functions receive (params, db)
 * only; there is no execution context to compare the target against, so a
 * workflow can start itself (A→A) or a cycle (A→B→A). Each hop is a fresh
 * execution row and the chain advances via detached advanceWorkflow calls,
 * so a cycle won't blow the stack — it will, however, mint execution rows
 * until someone notices. Author responsibly.
 */
fns.start_workflow = async (params, db) => {
    // ← lazy require (breaks internal_functions → workflow_engine →
    //   job_executor → internal_functions cycle)
    const { advanceWorkflow, resolveExecutionContactId } = require('../workflow_engine');

    // workflow_id — required positive integer (numeric string OK; any
    // {{placeholder}} was resolved by the engine before we got here).
    const workflowIdNum = Number(params.workflow_id);
    if (!Number.isInteger(workflowIdNum) || workflowIdNum <= 0) {
      throw new Error(`start_workflow: workflow_id is required and must be a positive integer (got ${JSON.stringify(params.workflow_id)})`);
    }

    const [[wfRow]] = await db.query(
      `SELECT id, active, default_contact_id_from FROM workflows WHERE id = ?`,
      [workflowIdNum]
    );
    if (!wfRow) {
      throw new Error(`start_workflow: workflow #${workflowIdNum} not found`);
    }
    if (!wfRow.active) {
      // Deliberate divergence from the sequence step (which historically
      // skipped this check) — matches the hook dispatcher's inactive→fail.
      throw new Error(`start_workflow: workflow #${workflowIdNum} is inactive`);
    }

    // init_data — optional plain object; default {}.
    let initData = {};
    if (params.init_data !== undefined && params.init_data !== null && params.init_data !== '') {
      if (typeof params.init_data !== 'object' || Array.isArray(params.init_data)) {
        throw new Error('start_workflow: init_data must be a JSON object');
      }
      initData = params.init_data;
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

    // INSERT — fourth workflow_executions creation site (Cookbook §5.21).
    // The other three: routes/workflows.js POST /workflows/:id/start,
    // actionDispatchers.deliverWorkflow (hook→wf),
    // sequenceEngine.executeStartWorkflowAction (seq→wf).
    const [result] = await db.query(
      `INSERT INTO workflow_executions
       (workflow_id, contact_id, status, init_data, variables, current_step_number)
       VALUES (?, ?, 'active', ?, ?, 1)`,
      [workflowIdNum, contactId, JSON.stringify(initData), JSON.stringify(initData)]
    );
    const executionId = result.insertId;

    console.log(`[WF→WF] start_workflow: started workflow #${workflowIdNum} execution ${executionId} (contact ${contactId ?? 'none'})`);

    // Fire-and-forget advance — mirrors the seq→wf step and the hook
    // dispatcher. A background failure in advanceWorkflow does NOT re-fire
    // this step; the child execution row gets marked 'failed' by
    // markExecutionCompleted.
    (async () => {
      try {
        await advanceWorkflow(executionId, db);
      } catch (err) {
        console.error(`[WF→WF] advanceWorkflow failed for execution ${executionId}:`, err.message);
      }
    })();

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

module.exports = fns;