// lib/workflow_engine.js
const processJobs = require('../routes/process_jobs');
const executeJob = processJobs.executeJob;
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
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // ────────────────────────────────────────────────
    // PHASE 1: Claim & lock the execution row
    // ────────────────────────────────────────────────
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
      await connection.commit();
      return { status: 'skipped', message: 'Execution not found or not advanceable' };
    }

    const execution = rows[0];

    // Quick exit if already being processed
    if (execution.status === 'processing') {
      await connection.commit();
      return { status: 'skipped', message: 'Already being processed' };
    }

    // Mark as processing (soft lock)
    await connection.query(
      `UPDATE workflow_executions 
       SET status = 'processing', updated_at = NOW()
       WHERE id = ?`,
      [executionId]
    );

    await connection.commit();
    connection.release();
    connection = null;

    // ────────────────────────────────────────────────
    // PHASE 2: Safe to run long-lived logic now
    // ────────────────────────────────────────────────

    let currentStepNumber = execution.current_step_number;
    let executedThisInvocation = 0;
    const MAX_STEPS_PER_INVOCATION = 20;

    while (executedThisInvocation < MAX_STEPS_PER_INVOCATION) {
      // Load current step config
      const step = await loadWorkflowStep(execution.workflow_id, currentStepNumber, db);
      if (!step) {
        await markExecutionCompleted(executionId, 'completed', db);
        return { status: 'completed' };
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
        //console.log(`[STEP ${currentStepNumber}] Raw stepResult:`, JSON.stringify(stepResult, null, 2));
      } catch (err) {
        stepResult = { success: false, error: err.message };
      }

      if (stepResult.set_vars && stepResult.success) {
        await mergeVariables(executionId, stepResult.set_vars, db);
      }

      // Record immutable step result
      await recordStepResult(executionId, currentStepNumber, step.id, stepResult, startTime, db);

      // Determine next step
      let nextStep = currentStepNumber + 1;

      // Check for control function output (only if it's a whitelisted control step)
      if (isControlStep(step) && stepResult.next_step !== undefined) {
        nextStep = stepResult.next_step;

        // Special cases
        if (nextStep === null || nextStep === undefined) {
          await markExecutionCompleted(executionId, 'completed', db);
          return { status: 'completed' };
        }
        if (['cancel', 'fail'].includes(nextStep)) {
          await markExecutionCompleted(executionId, nextStep, db);
          return { status: nextStep };
        }
      }

      // Handle delay
      if (stepResult.delayed_until) {
        await scheduleResume(executionId, stepResult.delayed_until, nextStep, db);
        await updateExecutionStatus(executionId, 'delayed', db);
        return { status: 'delayed' };
      }

      // Advance
      currentStepNumber = nextStep;
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
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error(`advanceWorkflow failed for execution ${executionId}:`, err);
    // Optional: mark failed or alert
    return { status: 'error', error: err.message };
  }
}

// ────────────────────────────────────────────────
// Helper stubs (to be filled next)
// ────────────────────────────────────────────────

async function loadWorkflowStep(workflowId, stepNumber, db) {
  const [rows] = await db.query(
    `SELECT * FROM workflow_steps 
     WHERE workflow_id = ? AND step_number = ?`,
    [workflowId, stepNumber]
  );
  return rows[0] || null;
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

  console.log(`[EXECUTE STEP ${stepId}] Starting execution | Type: ${step.type}`);

  // Build jobData in the shape executeJob expects
  const jobData = {
    type: step.type,
    ...resolvedConfig  // url/method/headers/body or function_name/params or code/input
  };

  let rawResult;
  try {
    // This is your real execution (webhook / internal / custom_code)
    rawResult = await executeJob({ data: jobData });
    console.log(`[EXECUTE STEP ${stepId}] Raw execution success:`, JSON.stringify(rawResult, null, 2));
  } catch (err) {
    console.error(`[EXECUTE STEP ${stepId}] Execution failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
      output: null,
      set_vars: {},
      next_step: null,
      delayed_until: null
    };
  }

  // Update context.this with the real output (for {{this.0}} / {{this.status}} etc.)
  context.this = rawResult;

  // ────────────────────────────────────────────────
  // Resolve static set_vars from step.config.set_vars (now with real 'this')
  // ────────────────────────────────────────────────
  let staticSetVars = {};
  if (step.config?.set_vars) {
    staticSetVars = resolvePlaceholders(step.config.set_vars, context);
    console.log(`[EXECUTE STEP ${stepId}] Resolved static set_vars:`, JSON.stringify(staticSetVars, null, 2));
  }

  // ────────────────────────────────────────────────
  // Combine static + dynamic set_vars (dynamic from output takes precedence)
  // ────────────────────────────────────────────────
  const combinedSetVars = {
    ...staticSetVars,
    ...(rawResult?.set_vars || {})
  };

  // ────────────────────────────────────────────────
  // Build standardized result for the workflow loop
  // ────────────────────────────────────────────────
  const result = {
    success: true,
    output: rawResult,          // real response / function return value
    set_vars: combinedSetVars,
    next_step: null,
    delayed_until: null
  };

  // Detect control output (only from set_next)
  if (isControlStep(step)) {
    const next = rawResult?.next_step;
    if (next !== undefined) {
      result.next_step = next;
      console.log(`[EXECUTE STEP ${stepId}] Detected control: next_step = ${next}`);
    }
  }

  // Detect delay (from schedule_resume or direct output)
  if (rawResult?.delayed_until) {
    const dt = new Date(rawResult.delayed_until);
    if (!isNaN(dt.getTime())) {
      result.delayed_until = rawResult.delayed_until;
      console.log(`[EXECUTE STEP ${stepId}] Detected delay until ${result.delayed_until}`);
    }
  }

  return result;
}



async function recordStepResult(execId, stepNum, stepId, result, startTime, db) {
  const duration = Date.now() - startTime;
  await db.query(
    `
    INSERT INTO workflow_execution_steps
    (workflow_execution_id, step_number, step_id, status, output_data, error_message, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      execId,
      stepNum,
      stepId,
      result.success ? 'success' : 'failed',
      result.success ? JSON.stringify(result.output || {}) : null,
      result.success ? null : (result.error || 'Unknown error'),
      duration
    ]
  );
  console.log(`[RECORD] Step ${stepNum} for execution ${execId} recorded as ${result.success ? 'success' : 'failed'}`);
}


async function mergeVariables(execId, setVars, db) {
  if (Object.keys(setVars).length === 0) return;

  const [rows] = await db.query(
    `SELECT variables FROM workflow_executions WHERE id = ? FOR UPDATE`,
    [execId]
  );

  if (rows.length === 0) return;

  let currentVars = rows[0].variables || {};
  if (typeof currentVars === 'string') currentVars = JSON.parse(currentVars);

  // Shallow merge - last writer wins
  const newVars = { ...currentVars, ...setVars };

  await db.query(
    `UPDATE workflow_executions SET variables = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(newVars), execId]
  );

  console.log(`[MERGE VARS] Updated variables for execution ${execId}`);
}


function isControlStep(step) {
  return (
    step.type === 'internal_function' &&
    step.config?.function_name === 'set_next'
  );
}

async function scheduleResume(execId, resumeAt, nextStep, db) {
  await db.query(
    `
    INSERT INTO scheduled_jobs
    (type, scheduled_time, status, name, data, workflow_execution_id, idempotency_key)
    VALUES ('workflow_resume', ?, 'pending', ?, ?, ?, ?)
    `,
    [
      resumeAt,
      `Resume execution ${execId} at step ${nextStep}`,
      JSON.stringify({ nextStep }),
      execId,
      `${execId}-${Date.now()}` // simple idempotency key
    ]
  );
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
     SET status = ?, completed_at = NOW(), updated_at = NOW() 
     WHERE id = ?`,
    [finalStatus, execId]
  );
}

async function scheduleSelfContinue(execId, nextStep, db) {
  // Insert a workflow_resume job with very short delay (e.g. 1 second)
  const soon = new Date(Date.now() + 1000);
  await scheduleResume(execId, soon, nextStep, db);
}

module.exports = { advanceWorkflow, resolvePlaceholders };