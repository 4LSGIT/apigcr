// lib/workflow_engine.js
//const processJobs = require('../routes/process_jobs');
const { executeJob } = require("./job_executor");
/*
 * Resolves all {{placeholders}} in an object (or string).
 * Supports nested access and env helpers.
 *
 * @param {any} template - string, object, or array to resolve
 * @param {object} context - { variables, this: currentStepOutput, env }
 * @returns {any} resolved value (same shape as input)
 */
function resolvePlaceholders(template, context) {
  if (typeof template === 'string') {
    // Single-placeholder fast path: when the entire string is exactly one
    // placeholder, preserve non-primitive resolutions (arrays, objects) that
    // would otherwise be destroyed by String.prototype.replace coercion —
    // an array of MMS attachments becomes "[object Object],[object Object]"
    // under .toString(). Primitives (numbers, booleans, strings) and null
    // intentionally fall through to the regex replace path below to keep
    // their historical string-coerced behavior, preserving type stability
    // for IDs and other scalar values that downstream consumers expect as
    // strings.
    const singleMatch = template.match(/^\s*{{([^}]+)}}\s*$/);
    if (singleMatch) {
      const resolved = resolveSingle(singleMatch[1].trim(), context);
      if (resolved && typeof resolved === 'object') {
        return resolved;
      }
      // primitives/null: fall through to replace path
    }
    return template.replace(/{{([^}]+)}}/g, (_, key) => {
      return resolveSingle(key.trim(), context) ?? '';
    });
  }

  if (Array.isArray(template)) {
    return template.map(item => resolvePlaceholders(item, context));
  }

  if (template && typeof template === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(template)) {
      result[k] = resolvePlaceholders(v, context);
    }
    return result;
  }

  return template; // primitive
}

/**
 * Resolve a single placeholder key (e.g. "contactPhone", "contactData.first_name", "env.now")
 */
function resolveSingle(key, context) {
  const { variables = {}, this: thisOutput = {}, env = {} } = context;

  // 1. variables (highest priority)
  if (key in variables) {
    return variables[key];
  }

  // 2. Nested access (dot or bracket notation)
  if (key.includes('.')) {
    const nested = getNested(variables, key);
    if (nested !== undefined) return nested;
  }

  // 3. current step output ("this")
  if (key.startsWith('this.')) {
    const thisKey = key.slice(5); // e.g. "0" or "[0]"
    const nested = getNested(thisOutput, thisKey);
    if (nested !== undefined) return nested;
  }
  if (key === 'this') {
    return thisOutput;
  }

  // 4. env helpers
  if (key.startsWith('env.')) {
    const envKey = key.slice(4);
    switch (envKey) {
      case 'now':
        return new Date().toISOString();
      case 'executionId':
        return env.executionId;
      case 'stepNumber':
        return env.stepNumber;
      default:
        return null;
    }
  }

  // Not found
  return null;
}


/*
 * Safe nested access with full support for array indices:
 * - "this.0" → array[0]
 * - "this.[0]" → array[0]
 * - "a.b.1.c" → obj.a.b[1].c
 */
function getNested(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;

  let current = obj;

  // Split path, but normalize [n] to .n
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');

  for (let part of parts) {
    if (part === '') continue; // skip empty

    // Try as numeric array index
    const index = parseInt(part, 10);
    if (!isNaN(index) && Array.isArray(current)) {
      current = current[index];
      continue;
    }

    // Normal object property
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }

  return current;
}



/**
 * Advances a workflow execution one or more steps.
 * Called from:
 * - POST /workflows/:id/start (initial kickoff)
 * - /process-jobs when a workflow_resume job fires
 *
 * @param {number} executionId
 * @param {object} db - req.db or connection pool
 * @returns {Promise<{status: string, message?: string}>}
 */
async function advanceWorkflow(executionId, db) {
  try {
    // ────────────────────────────────────────────────
    // PHASE 1: Claim & lock the execution row
    // ────────────────────────────────────────────────
    // Short claim-lock transaction: SELECT ... FOR UPDATE + soft-lock UPDATE,
    // committed and released BEFORE the long-lived PHASE 2 work runs. The span
    // is pure-DB (no external sends — those live in PHASE 2 on the pool), so the
    // helper's default single transient retry is safe. Returns the locked
    // execution row, or null when there is nothing advanceable.
    const execution = await db.withTransaction(async (connection) => {
      const [rows] = await connection.query(
        `
        SELECT *
        FROM workflow_executions
        WHERE id = ?
          AND status IN ('active', 'delayed')
        FOR UPDATE
        `,
        [executionId]
      );

      if (rows.length === 0) {
        // No-write transaction: committing here (the helper commits on normal
        // return) is equivalent to the prior explicit commit on this path —
        // nothing was written.
        return null;
      }

      // Mark as processing (soft lock)
      await connection.query(
        `UPDATE workflow_executions 
         SET status = 'processing', updated_at = NOW()
         WHERE id = ?`,
        [executionId]
      );

      return rows[0];
    });

    if (execution === null) {
      return { status: 'skipped', message: 'Execution not found or not advanceable' };
    }

    // ────────────────────────────────────────────────
    // PHASE 2: Safe to run long-lived logic now
    // ────────────────────────────────────────────────

    // ── Step-0 intercept (capture slice) ──
    // A FRESH execution (nothing executed yet, pointed at step 1) whose
    // workflow is armed 'intercept' parks as 'held' before step 1: the
    // init_data is captured, the arm disarms (guarded one-shot), and the
    // execution waits for a manual resume (POST /executions/:id/resume,
    // optionally with replaced variables). Parents at all four creation
    // sites already hold a real execution id, so nothing upstream lies —
    // the child exists, it just hasn't run.
    //
    // The guarded UPDATE is the race arbiter: two near-simultaneous fresh
    // executions → one held, the loser falls through and runs normally.
    //
    // Known, accepted quirk: a held execution RESUMED while intercept has
    // been re-armed looks fresh again (steps_executed_count still 0) and
    // will be re-held — deterministic and visible in the capture modal.
    if (execution.steps_executed_count === 0 && execution.current_step_number === 1) {
      const [[wfCap]] = await db.query(
        `SELECT capture_mode FROM workflows WHERE id = ?`,
        [execution.workflow_id]
      );
      if (wfCap && wfCap.capture_mode === 'intercept') {
        // Normalize init_data (mysql2 may hand back string or object).
        let initObj = execution.init_data;
        if (typeof initObj === 'string') {
          try { initObj = initObj ? JSON.parse(initObj) : {}; } catch { initObj = {}; }
        }
        const [upd] = await db.query(
          `UPDATE workflows
              SET captured_input = ?,
                  captured_at    = NOW(),
                  capture_mode   = 'off'
            WHERE id = ? AND capture_mode = 'intercept'`,
          [JSON.stringify(initObj ?? {}), execution.workflow_id]
        );
        if (upd.affectedRows > 0) {
          await updateExecutionStatus(executionId, 'held', db);
          console.log(`[WF CAPTURE] Intercepted execution ${executionId} (workflow ${execution.workflow_id}) — held before step 1`);
          return { status: 'held' };
        }
        // Lost the race — proceed as a normal run.
      }
    }

    let currentStepNumber = execution.current_step_number;
    let executedThisInvocation = 0;
    const MAX_STEPS_PER_INVOCATION = 20;

    while (executedThisInvocation < MAX_STEPS_PER_INVOCATION) {
      // Load current step config
      const step = await loadWorkflowStep(execution.workflow_id, currentStepNumber, db);
      if (!step) {
        const finalStatus = await getWorkflowFinalStatus(executionId, db);
        await markExecutionCompleted(executionId, finalStatus, db);
        return { status: finalStatus };
      }

      // Build context for templating
      const context = await buildTemplateContext(executionId, currentStepNumber, execution, db);

      // Resolve placeholders in step config (usually config.params or config.body)
      const resolvedConfig = resolvePlaceholders(step.config, context);

      // Execute the step with resolved config
      const startTime = Date.now();
      let stepResult;
      try {
        stepResult = await executeStep(step, resolvedConfig, context, db);

        // TERMINAL FAILURE CHECK — abort whole workflow
        if (!stepResult.success && stepResult.terminalFailure) {
          console.log(`[ABORT] Terminal failure in step ${currentStepNumber}: ${stepResult.error}`);
          // Record the aborting step BEFORE marking failed — previously this
          // returned without recording, so the step that killed the execution
          // was the one step missing from history.
          await recordStepResult(executionId, currentStepNumber, step.id, stepResult, startTime, db, resolvedConfig);
          await db.query(
            `UPDATE workflow_executions SET steps_executed_count = steps_executed_count + 1, updated_at = NOW() WHERE id = ?`,
            [executionId]
          );
          await markExecutionCompleted(executionId, 'failed', db);
          return { status: 'failed', message: `Terminal failure in step ${currentStepNumber}` };
        }

      } catch (err) {
        stepResult = { success: false, error: err.message };
      }

      if (stepResult.set_vars && stepResult.success) {
        await mergeVariables(executionId, stepResult.set_vars, db);
      }

      // Record immutable step result and update progress counter
      await recordStepResult(executionId, currentStepNumber, step.id, stepResult, startTime, db, resolvedConfig);
      await db.query(
        `UPDATE workflow_executions SET steps_executed_count = steps_executed_count + 1, updated_at = NOW() WHERE id = ?`,
        [executionId]
      );
      // Determine next step
      let nextStep = currentStepNumber + 1;

      // Check for control function output (only if it's a whitelisted control step)
      if (isControlStep(step) && stepResult.next_step !== undefined) {
        nextStep = stepResult.next_step;

        // Special cases
        if (nextStep === null || nextStep === undefined) {
          const finalStatus = await getWorkflowFinalStatus(executionId, db);
          await markExecutionCompleted(executionId, finalStatus, db);
          return { status: finalStatus };
        }
        if (['cancel', 'fail'].includes(nextStep)) {
          const statusMap = { cancel: 'cancelled', fail: 'failed' };
          const normalizedStatus = statusMap[nextStep] ?? nextStep;
          await markExecutionCompleted(executionId, normalizedStatus, db);
          //await markExecutionCompleted(executionId, nextStep, db);
          return { status: normalizedStatus };
        }
      }

      // Handle delay
      if (stepResult.delayed_until) {
        const resumeStep = stepResult.next_step ?? nextStep;
        await scheduleResume(executionId, stepResult.delayed_until, resumeStep, db);
        await updateExecutionStatus(executionId, 'delayed', db);
        return { status: 'delayed' };
      }

      // Advance — persist the step pointer so a crash after this point is
      // resumable from the RIGHT step. Before 2026-08, current_step_number was
      // only written on the delayed-resume path (routes/process_jobs.js) and
      // NULLed on completion, so straight-through runs carried a stale pointer
      // of 1 the whole way; any resume after a mid-run death would have
      // re-fired every step from the top. recoverStuckJobs now schedules a
      // resume at this pointer when it recovers a stuck 'processing' row.
      // At-least-once window: a death BETWEEN a step's external side effect
      // and this write re-runs at most that one step — inherent, accepted.
      currentStepNumber = nextStep;
      await db.query(
        `UPDATE workflow_executions
            SET current_step_number = ?, updated_at = NOW()
          WHERE id = ?`,
        [currentStepNumber, executionId]
      );
      executedThisInvocation++;

      // Safety limit
      if (executedThisInvocation >= MAX_STEPS_PER_INVOCATION) {
        await scheduleSelfContinue(executionId, nextStep, db);
        await updateExecutionStatus(executionId, 'active', db);
        return { status: 'continued_later' };
      }
    }

    // If we exit loop normally → still active
    await updateExecutionStatus(executionId, 'active', db);
    return { status: 'advanced', steps: executedThisInvocation };

  } catch (err) {
    console.error(`advanceWorkflow failed for execution ${executionId}:`, err);
    // Best-effort: mark the execution as failed so it doesn't stay stuck as 'processing'.
    // Wrapped in its own try/catch because the DB may be the reason we're here.
    try {
      await markExecutionCompleted(executionId, 'failed', db);
    } catch (markErr) {
      console.error(`[ADVANCE] Could not mark execution ${executionId} as failed:`, markErr);
      // Execution remains stuck as 'processing' — will need manual recovery
    }
    return { status: 'error', error: err.message };
  }
}

// ────────────────────────────────────────────────
// Helper stubs (to be filled next)
// ────────────────────────────────────────────────

async function loadWorkflowStep(workflowId, stepNumber, db) {
  const [rows] = await db.query(
    `SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
    [workflowId, stepNumber]
  );
  if (!rows[0]) return null;
  const step = rows[0];
  if (typeof step.config === 'string')       step.config = JSON.parse(step.config);
  if (typeof step.error_policy === 'string') step.error_policy = JSON.parse(step.error_policy);
  return step;
}


async function buildTemplateContext(executionId, stepNumber, execution, db) {
  // ALWAYS reload the latest variables from DB (critical for same-invocation chaining)
  const [rows] = await db.query(
    `SELECT variables FROM workflow_executions WHERE id = ?`,
    [executionId]
  );

  let variables = rows[0]?.variables || {};
  if (typeof variables === 'string') {
    variables = JSON.parse(variables);
  }

  // Current step output placeholder (will be filled after executeStep)
  const thisOutput = {};

  const env = {
    executionId,
    stepNumber,
  };

  return { variables, this: thisOutput, env };
}


/**
 * Executes a single workflow step using the resolved config.
 * Reuses existing executeJob logic + adds control/delay detection + set_vars merging.
 *
 * @param {object} step - row from workflow_steps
 * @param {object} resolvedConfig - already templated params/body/etc.
 * @param {object} context - { variables, this: currentStepOutput (updated after exec), env }
 * @param {object} db - connection pool
 * @returns {Promise<object>} { success, output, next_step?, delayed_until?, set_vars? }
 */
async function executeStep(step, resolvedConfig, context, db) {
  const stepId = step.id;

  console.log(`[EXECUTE STEP ${stepId}] Starting | Type: ${step.type}`);

  const jobData = {
    type: step.type,
    ...resolvedConfig
  };

  // Inject _variables so evaluate_condition (and any future function that needs
  // runtime variable access) can read the current execution state.
  // _step_number rides along for foreach, whose body entry point is its own
  // step number + 1 (control steps have no sequential fall-through, so the
  // function must return an explicit next_step). Additive and harmless:
  // undeclared incoming params are never rejected and other functions ignore it.
  // _execution_id added for request_decision (decisions.js), which must bind
  // its decision_requests row to the execution. Same additive story as the
  // other underscore params.
  if (step.type === 'internal_function' && jobData.params) {
    jobData.params = {
      ...jobData.params,
      _variables: context.variables,
      _step_number: context.env?.stepNumber,
      _execution_id: context.env?.executionId,
    };
  }

  let rawResult;
  let attempt = 1;

  // Load policy (default: ignore = continue on failure)
  const policy = step.error_policy || { strategy: "ignore" };
  const strategy = policy.strategy || "ignore";
  const maxRetries = Number(policy.max_retries) || 0;
  const backoffSec = Number(policy.backoff_seconds) || 5;

  while (true) {
    try {
      rawResult = await executeJob({ data: jobData }, db);
      console.log(`[EXECUTE STEP ${stepId}] Success on attempt ${attempt}`);
      break; // success → exit retry loop
    } catch (err) {
      console.error(`[EXECUTE STEP ${stepId}] Attempt ${attempt} failed: ${err.message}`);

      if (attempt > maxRetries) {
        // No more retries — decide based on strategy
        if (strategy === "abort" || strategy === "retry_then_abort") {
          return { 
            success: false, 
            error: err.message, 
            output: null,
            set_vars: {},
            next_step: null,
            delayed_until: null,
            terminalFailure: true   // ← tells loop to abort whole workflow
          };
        }
        // ignore or retry_then_ignore → continue with failure
        return {
          success: false,
          error: err.message,
          output: null,
          set_vars: {},
          next_step: null,
          delayed_until: null
        };
      }

      // Retry with backoff
      await new Promise(r => setTimeout(r, backoffSec * 1000 * attempt));
      attempt++;
    }
  }

  // Success path
  context.this = rawResult; // update for {{this}} in set_vars

  // Resolve static set_vars from config AFTER execution
  let staticSetVars = {};
  if (step.config?.set_vars) {
    staticSetVars = resolvePlaceholders(step.config.set_vars, context);
    console.log(`[EXECUTE STEP ${stepId}] Resolved static set_vars:`, JSON.stringify(staticSetVars));
  }

  const combinedSetVars = {
    ...staticSetVars,
    ...(rawResult?.set_vars || {})
  };

  const result = {
    success: true,
    output: rawResult,
    set_vars: combinedSetVars,
    next_step: null,
    delayed_until: null
  };

  // Control flow detection
  if (isControlStep(step)) {
    const next = rawResult?.next_step;
    if (next !== undefined) result.next_step = next;
  }

  if (rawResult?.delayed_until) {
    const dt = new Date(rawResult.delayed_until);
    if (!isNaN(dt.getTime())) {
      result.delayed_until = rawResult.delayed_until;
      // Also capture the intended resume step (normalize camelCase fallback for safety)
      const resumeStep = rawResult.next_step ?? rawResult.nextStep;
      if (resumeStep != null) result.next_step = resumeStep;
    }
  }

  return result;
}


// resolvedConfig: the step config as resolved PRE-execution (the object passed
// to executeStep). Note: set_vars entries referencing {{this.*}} are resolved
// AFTER execution against the step output, so they appear blanked/unresolved
// here — that's expected and by design (Slice 3 stores the as-run input config,
// not the post-execution set_vars resolution).
async function recordStepResult(execId, stepNum, stepId, result, startTime, db, resolvedConfig) {
  const duration = Date.now() - startTime;
  await db.query(
    `
    INSERT INTO workflow_execution_steps
    (workflow_execution_id, step_number, step_id, status, output_data, error_message, duration_ms, resolved_config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      execId,
      stepNum,
      stepId,
      result.success ? 'success' : 'failed',
      result.success ? JSON.stringify(result.output || {}) : null,
      result.success ? null : (result.error || 'Unknown error'),
      duration,
      // SQL NULL when nullish — NOT JSON.stringify(null) === the string "null"
      resolvedConfig == null ? null : JSON.stringify(resolvedConfig)
    ]
  );
  console.log(`[RECORD] Step ${stepNum} for execution ${execId} recorded as ${result.success ? 'success' : 'failed'}`);
}


async function mergeVariables(execId, setVars, db) {
  if (Object.keys(setVars).length === 0) return;

  // Pure-DB transaction (SELECT ... FOR UPDATE + UPDATE), so the helper's
  // default single transient retry is safe. The empty-rows guard returns early;
  // the only statement before it is the SELECT ... FOR UPDATE (no writes), so
  // the helper committing a no-write transaction is equivalent to the prior
  // explicit rollback on that path.
  const merged = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT variables FROM workflow_executions WHERE id = ? FOR UPDATE`,
      [execId]
    );

    if (rows.length === 0) {
      return false; // nothing to update — no writes preceded this point
    }

    let currentVars = rows[0].variables || {};
    if (typeof currentVars === 'string') currentVars = JSON.parse(currentVars);

    // Shallow merge - last writer wins
    const newVars = { ...currentVars, ...setVars };

    await conn.query(
      `UPDATE workflow_executions SET variables = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(newVars), execId]
    );

    return true;
  });

  // Preserve the original post-commit, write-path-only log line.
  if (merged) {
    console.log(`[MERGE VARS] Updated variables for execution ${execId}`);
  }
}


/**
 * Capture slice — one-shot capture of a workflow's incoming init_data,
 * mirroring hooks (services/hookService.js) and the email router.
 *
 * The guarded UPDATE (WHERE capture_mode='capturing') is the race-free
 * arm-once mechanism: whichever of the four execution-creation sites
 * (Cookbook §5.21 — manual start route, hook dispatcher, sequence
 * start_workflow step, wf→wf start_workflow function) fires first wins;
 * everyone else no-ops. capture_mode flips itself back to 'off'.
 *
 * `db` may be a pool or an in-transaction connection — both expose .query.
 * Failures are swallowed: capture must never break a workflow start.
 */
async function captureWorkflowInput(db, workflowId, initData) {
  try {
    await db.query(
      `UPDATE workflows
          SET captured_input = ?,
              captured_at    = NOW(),
              capture_mode   = 'off'
        WHERE id = ? AND capture_mode = 'capturing'`,
      [JSON.stringify(initData ?? {}), workflowId]
    );
  } catch (err) {
    console.warn(`[WF CAPTURE] capture failed for workflow ${workflowId}:`, err.message);
  }
}

function isControlStep(step) {
  // wait_for added 2026-08: its skip-block path (at=null → next_step WITHOUT
  // delayed_until) claims "parity with schedule_resume" in timing.js, but was
  // never honored here — the skip silently fell through to sequential
  // advance. No live config uses wait_for's `at`/skipToStep today (verified
  // against prod 2026-08-04), so this is a zero-behavior-change fix.
  // wait_until_time stays out: it always returns delayed_until, which the
  // delay path already honors.
  // foreach added 2026-08 (court pipeline v2 slice): loop-cursor control step;
  // its next_step output (body entry / end_step exit) must be honored.
  return (
    step.type === 'internal_function' &&
    ['set_next', 'evaluate_condition', 'schedule_resume', 'wait_for', 'foreach'].includes(step.config?.function_name)
  );
}

async function scheduleResume(execId, resumeAt, nextStep, db) {
  // Idempotency key: including the resume timestamp (as epoch ms) means
  //   - same (execId, nextStep, resumeAt) → dedupes (e.g. spurious double-call
  //     from engine retry while a resume is already pending)
  //   - same (execId, nextStep) but different resumeAt → NO dedupe, so workflow
  //     patterns that legitimately branch back to the same step later (polling
  //     loops, retry loops via set_next + schedule_resume, or scheduleSelfContinue
  //     following a prior pause) schedule correctly rather than hanging.
  const resumeAtMs = new Date(resumeAt).getTime();
  const idempotencyKey = `resume-${execId}-${nextStep}-${resumeAtMs}`;
  // Prevent duplicate resumes (simple check)
  const [existing] = await db.query(
    `SELECT id FROM scheduled_jobs 
     WHERE idempotency_key = ? AND status IN ('pending', 'running') LIMIT 1`,
    [idempotencyKey]
  );
  if (existing.length > 0) {
    console.log(`[SCHEDULE RESUME] Skipping duplicate for ${idempotencyKey}`);
    return;
  }
  await db.query(
    `
    INSERT INTO scheduled_jobs
    (type, scheduled_time, status, name, data, workflow_execution_id, idempotency_key)
    VALUES ('workflow_resume', ?, 'pending', ?, ?, ?, ?)
    `,
    [
      resumeAt,
      `Resume execution ${execId} at step ${nextStep}`,
      JSON.stringify({ nextStep, executionId: execId }),
      execId,
      idempotencyKey
    ]
  );
  console.log(`[SCHEDULE RESUME] Scheduled resume for execution ${execId} at ${resumeAt} (step ${nextStep})`);
}

async function updateExecutionStatus(execId, status, db) {
  await db.query(
    `UPDATE workflow_executions SET status = ?, updated_at = NOW() WHERE id = ?`,
    [status, execId]
  );
}

async function markExecutionCompleted(execId, finalStatus, db) {
  await db.query(
    `UPDATE workflow_executions 
     SET status = ?, completed_at = NOW(), updated_at = NOW(), current_step_number = NULL 
     WHERE id = ?`,
    [finalStatus, execId]
  );
  console.log(`[COMPLETED] Execution ${execId} marked as ${finalStatus}`);
}

async function scheduleSelfContinue(execId, nextStep, db) {
  // Insert a workflow_resume job with very short delay (e.g. 1 second)
  const soon = new Date(Date.now() + 1000);
  await scheduleResume(execId, soon.toISOString(), nextStep, db);
}

/**
 * Determines the final status of a workflow execution based on step results.
 * - completed: no failed steps
 * - completed_with_errors: at least one failed step, but execution finished
 */
async function getWorkflowFinalStatus(executionId, db) {
  const [rows] = await db.query(
    `
    SELECT COUNT(*) as total, 
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM workflow_execution_steps
    WHERE workflow_execution_id = ?
    `,
    [executionId]
  );

  const { total, failed } = rows[0] || { total: 0, failed: 0 };

  if (total == 0) return 'completed'; // empty workflow (edge case)
  if (failed == 0) return 'completed';
  return 'completed_with_errors';
}

// ─────────────────────────────────────────────────────────────
// Slice 4 — executeSingleStep: manual single-step redo.
//
// Executes exactly one step of an execution — resolves placeholders against
// the execution's CURRENT variables, runs the step, merges set_vars, and
// records an honest history row. It deliberately does NOT navigate: control
// signals (next_step, terminalFailure) are ignored, and it never touches
// status / current_step_number / completed_at. The operator decides what
// happens next (nothing, or a separate resume).
//
// No status constraint on the execution load — single-step redo is legal on
// any terminal execution (failed, cancelled, completed, completed_with_errors).
// The route layer owns the live-status guard.
// ─────────────────────────────────────────────────────────────
async function executeSingleStep(executionId, stepNumber, db) {
  // Load execution — any status.
  const [execRows] = await db.query(
    `SELECT * FROM workflow_executions WHERE id = ?`,
    [executionId]
  );
  if (execRows.length === 0) {
    return { success: false, error: 'Execution not found' };
  }
  const execution = execRows[0];

  const step = await loadWorkflowStep(execution.workflow_id, stepNumber, db);
  if (!step) {
    return { success: false, error: 'Step not found' };
  }

  const context = await buildTemplateContext(executionId, stepNumber, execution, db);
  const resolvedConfig = resolvePlaceholders(step.config, context);

  const startTime = Date.now();
  let stepResult;
  try {
    // executeStep honors the step's error_policy retries synchronously
    // (with real backoff sleeps) — deliberate: a manual redo should behave
    // exactly like production, not like the tester's retries_skipped mode.
    stepResult = await executeStep(step, resolvedConfig, context, db);
  } catch (err) {
    // Mirrors the main loop's inner catch: unexpected throw → failed result,
    // still recorded below.
    stepResult = { success: false, error: err.message };
  }

  // Same merge condition as the main loop (merge BEFORE record, like the loop).
  if (stepResult.set_vars && stepResult.success) {
    await mergeVariables(executionId, stepResult.set_vars, db);
  }

  await recordStepResult(executionId, stepNumber, step.id, stepResult, startTime, db, resolvedConfig);
  await db.query(
    `UPDATE workflow_executions SET steps_executed_count = steps_executed_count + 1, updated_at = NOW() WHERE id = ?`,
    [executionId]
  );

  // Ignore control signals: single-step mode records, it doesn't navigate
  // or abort. next_step / terminalFailure / delayed_until are dropped here.
  return {
    success: stepResult.success,
    error: stepResult.success ? undefined : (stepResult.error || 'Unknown error'),
    output: stepResult.output ?? null,
    duration_ms: Date.now() - startTime,
  };
}

// ─────────────────────────────────────────────────────────────
// Slice 4.3 Part B — shared helper for populating contact_id on new
// workflow_executions rows. Called from all three creation paths:
//   - routes/workflows.js          POST /workflows/:id/start
//   - services/apptService.js      createAppt (appt-reminder workflow)
//   - services/hookService.js      deliverWorkflow (hook → workflow target)
//
// Precedence:
//   1. Explicit override (route body.contact_id on wrapped requests)
//   2. Template default: workflow.default_contact_id_from names an init_data
//      key; we read init_data[that_key] if it's a positive integer
//   3. null (execution isn't contact-tied — default for legacy starters)
//
// Error handling:
//   - Explicit override that isn't a positive integer throws
//     InvalidContactIdError — the route catches it and returns 400.
//   - Template-default lookups silently return null if the init_data value
//     at that key isn't a positive integer. We deliberately don't block
//     legitimate workflows just because a non-numeric string happens to sit
//     under a field name that collides with the template's default key —
//     the template author owns the type contract for their init_data.
// ─────────────────────────────────────────────────────────────

class InvalidContactIdError extends Error {
  constructor(value) {
    super(`Invalid contact_id: ${JSON.stringify(value)} (must be a positive integer)`);
    this.name = 'InvalidContactIdError';
  }
}

/**
 * Resolve the contact_id column value for a new workflow_executions row.
 *
 * @param {object} opts
 * @param {*} [opts.explicitContactId]  undefined/null → skip; otherwise must be
 *                                      a positive integer (or a numeric string
 *                                      that parses to one) — else throws.
 * @param {object} [opts.initData]      the init_data that will be persisted
 * @param {string|null} [opts.defaultKey]  workflow.default_contact_id_from, or null
 * @returns {number|null}  integer contact_id, or null if nothing resolved
 * @throws {InvalidContactIdError}  if explicitContactId is non-null and not a positive int
 */
function resolveExecutionContactId({ explicitContactId, initData, defaultKey } = {}) {
  // Explicit override — only honored when the caller distinguishes the value
  // from init_data content. The route does this by checking for a wrapped body
  // ({ init_data: {...}, contact_id: N }).
  if (explicitContactId !== undefined && explicitContactId !== null && explicitContactId !== '') {
    const n = Number(explicitContactId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new InvalidContactIdError(explicitContactId);
    }
    return n;
  }

  // Template default: init_data[defaultKey]. Silent skip if the value isn't
  // a positive integer — see rationale in the JSDoc above.
  if (defaultKey && initData && typeof initData === 'object') {
    const raw = initData[defaultKey];
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }

  return null;
}

module.exports = {
  advanceWorkflow,
  executeSingleStep,
  resolvePlaceholders,
  resolveSingle,
  getWorkflowFinalStatus,
  resolveExecutionContactId,
  InvalidContactIdError,
  captureWorkflowInput,
  scheduleResume,
  // Exported for routes/decisionActions.js — the decision response endpoint
  // writes the chosen value into execution variables before resuming.
  mergeVariables,
};