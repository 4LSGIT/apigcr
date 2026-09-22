// lib/workflow_engine.js
//const processJobs = require('../routes/process_jobs');
const { executeJob } = require("./job_executor");
// Registry handle for isControlStep()'s meta lookup. Not destructured: the
// property is read at call time, so a future load-order cycle degrades to a
// runtime error rather than silently binding undefined. job_executor already
// pulls this module in at line 3, so it is fully loaded by the time we get here.
const internalFunctions = require("./internal_functions");
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
          if (!(await updateExecutionStatus(executionId, 'held', db))) {
            return haltedExternally(executionId, 1, db);
          }
          console.log(`[WF CAPTURE] Intercepted execution ${executionId} (workflow ${execution.workflow_id}) — held before step 1`);
          return { status: 'held' };
        }
        // Lost the race — proceed as a normal run.
      }
    }

    let currentStepNumber = execution.current_step_number;
    let executedThisInvocation = 0;
    const MAX_STEPS_PER_INVOCATION = 20;

    // Terminal write + truthful return: if the row already left 'processing'
    // (cancelled meanwhile), report 'halted' rather than the status we did
    // NOT write.
    const complete = async (finalStatus, message) =>
      (await markExecutionCompleted(executionId, finalStatus, db))
        ? { status: finalStatus, ...(message ? { message } : {}) }
        : haltedExternally(executionId, currentStepNumber, db);

    while (executedThisInvocation < MAX_STEPS_PER_INVOCATION) {
      // Load current step config
      const step = await loadWorkflowStep(execution.workflow_id, currentStepNumber, execution.workflow_version, db);
      if (!step) {
        return complete(await getWorkflowFinalStatus(executionId, db));
      }

      // Build context for templating
      const context = await buildTemplateContext(executionId, currentStepNumber, execution, db);

      // Same read carries the row's status: a cancel that landed between the
      // previous step's pointer write and here stops the run BEFORE this step
      // fires (the pointer guard below covers a cancel during the step).
      if (context.execStatus !== 'processing') {
        return haltedExternally(executionId, currentStepNumber, db);
      }

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
          return complete('failed', `Terminal failure in step ${currentStepNumber}`);
        }

      } catch (err) {
        stepResult = { success: false, error: err.message };
      }

      // CONTROL TARGET NORMALIZATION — runs BEFORE the set_vars merge and the
      // step record, so an unusable target lands in workflow_execution_steps as
      // a FAILED step carrying a readable message (rather than a success row
      // followed by an unexplained 'failed' execution), and so a doomed step's
      // set_vars are not merged on the way out. See normalizeNextStep().
      let controlTarget = null;
      if (stepResult.success && isControlStep(step) && stepResult.next_step !== undefined) {
        controlTarget = normalizeNextStep(stepResult.next_step);
        if (controlTarget.kind === 'invalid') {
          stepResult = {
            ...stepResult,
            success: false,
            error: `unusable next_step ${JSON.stringify(controlTarget.raw)} — expected a positive step number, "end", "cancel", "fail", or null`
          };
        }
      }

      // RUNAWAY-LOOP GUARD — see LOOP_GUARD_MAX_BACKJUMPS. Same shape as the
      // invalid-target case above: a tripped guard lands in history as a
      // FAILED step carrying the reason, and its set_vars are dropped. Guard
      // state rides the step's own set_vars merge.
      if (stepResult.success) {
        const pauseMs = stepResult.delayed_until
          ? new Date(stepResult.delayed_until).getTime() - Date.now()
          : null;
        if (pauseMs !== null && pauseMs >= LOOP_GUARD_MIN_PAUSE_MS) {
          // A real pause ends the stretch the guard measures.
          if (context.variables?.[LOOP_GUARD_VAR] != null) {
            stepResult.set_vars = { ...(stepResult.set_vars || {}), [LOOP_GUARD_VAR]: null };
          }
        } else {
          // Where this step sends the run: its control target, or — for a
          // delay too short to count as a pause (seconds, or already past) —
          // its resume target.
          const dest = stepResult.delayed_until
            ? normalizeNextStep(stepResult.next_step ?? currentStepNumber + 1)
            : controlTarget;
          if (dest && dest.kind === 'step' && dest.step <= currentStepNumber) {
            const guard = await checkLoopGuard(execution, dest.step, context.variables, db);
            if (guard.tripped) {
              stepResult = { ...stepResult, success: false, error: guard.error };
              controlTarget = { kind: 'runaway', step: dest.step };
            } else {
              stepResult.set_vars = { ...(stepResult.set_vars || {}), [LOOP_GUARD_VAR]: guard.state };
            }
          } else if (isFreshForeachStart(step, stepResult)) {
            // Open this loop's record at the CURRENT count, so every item —
            // the first included — gets the same per-item allowance.
            const g = readLoopGuard(context.variables?.[LOOP_GUARD_VAR]);
            g.fe[String(currentStepNumber)] = { i: 0, base: g.n };
            stepResult.set_vars = { ...(stepResult.set_vars || {}), [LOOP_GUARD_VAR]: g };
          }
        }
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

      // Control function output (only for steps carrying __meta.controlFlow).
      // controlTarget was normalized above; every terminal case returns here
      // BEFORE the current_step_number write below, which is what keeps a
      // sentinel out of that INT column.
      if (controlTarget) {
        if (controlTarget.kind === 'invalid') {
          console.error(`[ADVANCE] Execution ${executionId} step ${currentStepNumber}: ${stepResult.error}`);
          return complete('failed', `Step ${currentStepNumber}: ${stepResult.error}`);
        }
        if (controlTarget.kind === 'runaway') {
          console.error(`[LOOP GUARD] Execution ${executionId} step ${currentStepNumber}: ${stepResult.error}`);
          // Clear the counter so an operator resume (after fixing the
          // workflow) starts with a fresh budget instead of re-tripping.
          await mergeVariables(executionId, { [LOOP_GUARD_VAR]: null }, db);
          const out = await complete('failed', `Step ${currentStepNumber}: ${stepResult.error}`);
          // Alert only when WE stopped it — a run someone already cancelled
          // needs no page.
          if (out.status === 'failed') {
            await raiseRunawayAlert(execution, currentStepNumber, controlTarget.step, stepResult.error, db);
          }
          return out;
        }
        if (controlTarget.kind === 'end') {
          return complete(await getWorkflowFinalStatus(executionId, db));
        }
        if (controlTarget.kind === 'cancel' || controlTarget.kind === 'fail') {
          return complete(controlTarget.kind === 'cancel' ? 'cancelled' : 'failed');
        }
        nextStep = controlTarget.step;
      }

      // Handle delay. A delay MUST resume at a real step — normalize so a
      // sentinel or garbage target can never reach scheduled_jobs.payload
      // (or the resume idempotency key). wait_until_time is not a control
      // step, so its target is only seen here.
      if (stepResult.delayed_until) {
        const rawResume  = stepResult.next_step ?? nextStep;
        const normResume = normalizeNextStep(rawResume);
        if (normResume.kind !== 'step') {
          const msg = `unusable resume step ${JSON.stringify(rawResume)} on a delayed step — expected a positive step number`;
          console.error(`[ADVANCE] Execution ${executionId} step ${currentStepNumber}: ${msg}`);
          return complete('failed', `Step ${currentStepNumber}: ${msg}`);
        }
        if (!(await parkWithResume(executionId, 'delayed', stepResult.delayed_until, normResume.step, db))) {
          return haltedExternally(executionId, currentStepNumber, db);
        }
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
      //
      // Guarded on status = 'processing' (our PHASE 1 soft lock): if anything
      // moved the row out of 'processing' while the step ran — the cancel
      // route, above all — stop HERE, at the step boundary. Before
      // 2026-09-22 nothing in this loop re-read status, so a cancel landing
      // mid-invocation let up to 20 more steps fire their side effects and
      // was then undone by the unconditional 'active'/'delayed' write below
      // (WF 27 v6 runaway: execution 12416 kept creating tasks after the
      // first cancel pass and only stayed cancelled on a later pass).
      currentStepNumber = nextStep;
      const [ptr] = await db.query(
        `UPDATE workflow_executions
            SET current_step_number = ?, updated_at = NOW()
          WHERE id = ? AND status = 'processing'`,
        [currentStepNumber, executionId]
      );
      if (ptr.affectedRows === 0) {
        return haltedExternally(executionId, currentStepNumber, db);
      }
      executedThisInvocation++;

      // Safety limit
      if (executedThisInvocation >= MAX_STEPS_PER_INVOCATION) {
        if (!(await scheduleSelfContinue(executionId, nextStep, db))) {
          return haltedExternally(executionId, currentStepNumber, db);
        }
        return { status: 'continued_later' };
      }
    }

    // If we exit loop normally → still active
    if (!(await updateExecutionStatus(executionId, 'active', db))) {
      return haltedExternally(executionId, currentStepNumber, db);
    }
    return { status: 'advanced', steps: executedThisInvocation };

  } catch (err) {
    console.error(`advanceWorkflow failed for execution ${executionId}:`, err);
    // Best-effort: mark the execution as failed so it doesn't stay stuck as 'processing'.
    // Wrapped in its own try/catch because the DB may be the reason we're here.
    try {
      // Wider guard than the in-loop writes: the throw may have come from the
      // PHASE 1 claim itself (row still 'active'/'delayed' — historical
      // behavior marks it failed), but a cancelled/held/terminal row is
      // never overwritten.
      await markExecutionCompleted(executionId, 'failed', db, { from: ['processing', 'active', 'delayed'] });
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

async function loadWorkflowStep(workflowId, stepNumber, version, db) {
  // Versioning (2026-08): every execution is pinned to the definition version
  // it started on (workflow_executions.workflow_version). Published versions
  // are immutable, so this read can never see a renumber or config edit made
  // after the execution started. The guard is fail-loud on purpose: a caller
  // that forgets the version would otherwise silently bind undefined and load
  // nothing (audit class CONTEXT-CONSTRUCTION, review D6).
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`loadWorkflowStep: version must be a positive integer (got ${JSON.stringify(version)}) — pass execution.workflow_version`);
  }
  const [rows] = await db.query(
    `SELECT * FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = ?`,
    [workflowId, version, stepNumber]
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
    `SELECT variables, status FROM workflow_executions WHERE id = ?`,
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

  // execStatus is engine-only (advanceWorkflow's halt check); resolveSingle
  // reads variables / this / env only, so it is not reachable from templates.
  return { variables, this: thisOutput, env, execStatus: rows[0]?.status };
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
 * The guarded UPDATE (WHERE capture_mode IN (...)) is the race-free
 * arm-once mechanism: whichever of the four execution-creation sites
 * (Cookbook §5.21 — manual start route, hook dispatcher, sequence
 * start_workflow step, wf→wf start_workflow function) fires first wins;
 * everyone else no-ops. capture_mode flips itself back to 'off'.
 *
 * `modes` is the armed set this call answers to. It stays ['capturing'] on
 * every running-start path: 'intercept' must survive ingress so the step-0
 * block in advanceWorkflow can park the execution 'held'. Only the refused
 * start widens it — see captureRefusedStart below.
 *
 * `db` may be a pool or an in-transaction connection — both expose .query.
 * Failures are swallowed: capture must never break a workflow start. Returns
 * true when this call won the race.
 */
async function captureWorkflowInput(db, workflowId, initData, { modes = ['capturing'] } = {}) {
  try {
    const [r] = await db.query(
      `UPDATE workflows
          SET captured_input = ?,
              captured_at    = NOW(),
              capture_mode   = 'off'
        WHERE id = ? AND capture_mode IN (?)`,
      [JSON.stringify(initData ?? {}), workflowId, modes]
    );
    return r.affectedRows > 0;
  } catch (err) {
    console.warn(`[WF CAPTURE] capture failed for workflow ${workflowId}:`, err.message);
    return false;
  }
}


/**
 * Pre-publish capture (capture-before-publish slice) — the refusal-path twin
 * of captureWorkflowInput.
 *
 * All four creation sites refuse to start a workflow that is inactive or has
 * never been published (current_version = 0). That refusal used to run BEFORE
 * the capture block, which made the arm useless in the one situation authors
 * most need it: a brand-new workflow whose shape they are trying to learn FROM
 * a real payload. The hook fired, the delivery logged
 * "workflow #N has never been published", and the payload was never recorded —
 * so the workflow could not be authored, so it could not be published, so it
 * could never capture. Capture now runs FIRST at every site and this helper
 * handles the refused case.
 *
 * Two differences from the running-start capture:
 *
 *   1. 'intercept' also counts as armed. Intercept normally records at "step 0"
 *      inside advanceWorkflow so the execution can park 'held' — but a refused
 *      start creates no execution, so nothing would ever reach that block. With
 *      the run refused there is nothing to hold, so intercept degrades to a
 *      plain tap at ingress. (For a runnable workflow, ingress capture stays
 *      'capturing'-only — capturing here would disarm the step-0 hold and let
 *      the run through, which is the opposite of what intercept promises.)
 *
 *   2. On a win it seeds test_input, but only when the workflow has never been
 *      published AND test_input is still NULL. That is the whole point of the
 *      exercise — the captured payload becomes the authoring contract the step
 *      tester and the target-contract warnings read from. Guarded so it can
 *      never overwrite an author's hand-written test_input, and never touches a
 *      workflow that is live.
 *
 * Returns true when THIS call won the arm-once race (for callers that want to
 * say so in their error text). Never throws.
 */
async function captureRefusedStart(db, workflowId, initData) {
  const captured = await captureWorkflowInput(db, workflowId, initData, {
    modes: ['capturing', 'intercept'],
  });
  if (!captured) return false;

  try {
    const [r] = await db.query(
      `UPDATE workflows
          SET test_input = ?
        WHERE id = ? AND test_input IS NULL AND current_version = 0`,
      [JSON.stringify(initData ?? {}), workflowId]
    );
    if (r.affectedRows > 0) {
      console.log(`[WF CAPTURE] Workflow ${workflowId}: seeded test_input from the pre-publish capture`);
    }
  } catch (err) {
    // Seeding is a convenience; the sample is already safe in captured_input.
    console.warn(`[WF CAPTURE] test_input seed failed for workflow ${workflowId}:`, err.message);
  }
  return true;
}

// Derived from the function's own __meta.controlFlow flag — NOT a hardcoded
// list. This used to be a literal whitelist maintained by hand alongside the
// meta flag, and the two drifted in both directions: wait_for was whitelisted
// but unflagged, request_decision flagged but not whitelisted. The failure mode
// is silent (the control function's next_step is ignored and the engine
// sequential-advances), which is how wait_for's skip-block path stayed broken
// from its introduction until 2026-08. One source of truth, asserted by
// tests/control.flow.test.js.
//
// wait_until_time is deliberately unflagged: it always returns delayed_until,
// which the delay path honors without consulting this predicate.
// custom_code likewise stays out — it has no meta, so a next_step it returns is
// still ignored (routes/workflows.js warns authors about that).
//
// No new require cycle: workflow_engine → job_executor → internal_functions is
// pre-existing, and composition.js's require back into this module is lazy.
function isControlStep(step) {
  if (step.type !== 'internal_function') return false;
  return internalFunctions.__getMeta(step.config?.function_name)?.controlFlow === true;
}

// ─────────────────────────────────────────────────────────────
// next_step normalization — the SINGLE choke point for every producer.
//
// Every function that can redirect the engine funnels through
// stepResult.next_step: set_next.value, evaluate_condition's then / else /
// branches[].then, foreach.end_step, request_decision.nextStep, and the
// wait_for / schedule_resume skip targets. Normalizing here rather than in
// each function means one contract, one place to change it.
//
// TERMINAL SENTINELS (trimmed, case-insensitive):
//   null | undefined | ''   → end   (the historical forms)
//   'end'                   → end   (the WORD form — added 2026-08)
//   'null'                  → end   (DEPRECATED alias; see below)
//   'cancel' / 'fail'       → terminate with that status
//   positive int / digits   → jump to that step
//   anything else           → INVALID (the caller fails the execution)
//
// Why 'end' exists at all: the sentinel family was 'cancel' and 'fail' plus a
// bare null, so "end normally" was the one terminal outcome with no word form.
// That made it unreachable from a COMPUTED target — set_next {value:
// "{{jump_to}}"} could resolve to a step number, "cancel" or "fail", but never
// "end" — and in the form editor it could only be authored by leaving a
// required field blank, which reads as an unfinished step.
//
// Why 'null' (the string) is accepted: wf41 s5/s7 shipped with
// {"value":"null"} typed into the form field. Do NOT document it and do NOT
// add further spellings — it is the one sentinel that collides with a JSON
// literal, and every other check in the codebase (the editor's gather,
// _wfNextRef in the Explain view, the roundtrip test) matches `=== null`.
//
// Why INVALID is fatal rather than ignored: before this existed, an unusable
// target fell through to `currentStepNumber = <garbage>` and was written to
// workflow_executions.current_step_number, which is INT — with no
// STRICT_TRANS_TABLES that silently stored 0. The execution then failed to
// load step 0, hit the missing-step branch, and completed as though nothing
// were wrong, so a typo'd jump target was indistinguishable from success.
// Worse, a crash in the window between that write and completion left the row
// at 'processing' with current_step_number = 0, and recoverStuckJobs computes
// `resumeStep = ex.current_step_number || 1` — 0 is falsy, so recovery
// restarted the workflow at STEP 1 and re-fired every side effect. Its
// staleFirstStepShape gate tests `=== 1` and so never caught the 0.
//
// '' stays terminal deliberately: an unresolved {{placeholder}} resolves to ''
// (resolvePlaceholders' `?? ''`), and that already ended the execution. Only
// genuinely unusable text changes behavior.
//
// @returns {{kind:'end'|'cancel'|'fail'|'step'|'invalid', step?:number, raw?:any}}
function normalizeNextStep(v) {
  if (v === null || v === undefined) return { kind: 'end' };

  if (typeof v === 'number') {
    return (Number.isInteger(v) && v > 0) ? { kind: 'step', step: v } : { kind: 'invalid', raw: v };
  }

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'end' || s === 'null') return { kind: 'end' };
    if (s === 'cancel') return { kind: 'cancel' };
    if (s === 'fail')   return { kind: 'fail' };
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      return n > 0 ? { kind: 'step', step: n } : { kind: 'invalid', raw: v };
    }
  }

  return { kind: 'invalid', raw: v };
}

// Insert (or dedupe) a workflow_resume row on `conn` — the pool, or an
// in-transaction connection (parkWithResume). Returns { jobId, resumeAtMs };
// jobId is null when an identical resume was already pending.
async function insertResumeJob(conn, execId, resumeAt, nextStep) {
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
  const [existing] = await conn.query(
    `SELECT id FROM scheduled_jobs 
     WHERE idempotency_key = ? AND status IN ('pending', 'running') LIMIT 1`,
    [idempotencyKey]
  );
  if (existing.length > 0) {
    console.log(`[SCHEDULE RESUME] Skipping duplicate for ${idempotencyKey}`);
    return { jobId: null, resumeAtMs };
  }
  const [insertResult] = await conn.query(
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
  return { jobId: insertResult.insertId, resumeAtMs };
}

async function enqueueResumeDispatch(jobId, resumeAtMs) {
  // Cloud Tasks accelerator (P1, 2026-08): a NEAR-IMMEDIATE resume also gets a
  // push dispatch (POST /process-job/:id) so step 1 doesn't wait for the 60s
  // cron tick — measured pre-slice: mean ~35s queue wait, 76% of immediate
  // resumes over 20s, on a path carrying inbound SMS (Clio 2FA), call logging
  // and lead intake. Far-future resumes are NOT enqueued: the scheduled_jobs
  // row stays the single cancellable scheduling authority for long delays.
  // All latency-relevant callers pass new Date() or now+1s, so the 90s window
  // covers the whole measured problem. AWAITED, deliberately (review
  // 2026-08-23): the never-rejects contract is test-enforced, so awaiting
  // cannot break scheduling — it can only delay it, bounded ≤15s by the RPC
  // deadline, in contexts where nothing user-visible is waiting on this
  // return. What awaiting buys is determinism: the enqueue (and its warn
  // line on failure) completes before the caller moves on, instead of
  // floating as an unreferenced promise in the detached post-response tail.
  // What it does NOT buy is CPU — the RPC runs in the same throttled
  // context either way; startup/init.js's warmup() is the mitigation for
  // that. Worst case on any failure: the job rides the cron exactly as it
  // does today. An unparseable resumeAt yields NaN, fails the <= check, and
  // skips the enqueue (cron-only). A deduped insert enqueues nothing — the
  // pending resume already has its task.
  const { enqueueJobDispatch, ACCEL_WINDOW_MS } = require('./taskQueue');
  if (Number.isFinite(resumeAtMs) && resumeAtMs <= Date.now() + ACCEL_WINDOW_MS) {
    await enqueueJobDispatch(jobId, resumeAtMs);
  }
}

async function scheduleResume(execId, resumeAt, nextStep, db) {
  const { jobId, resumeAtMs } = await insertResumeJob(db, execId, resumeAt, nextStep);
  if (jobId != null) await enqueueResumeDispatch(jobId, resumeAtMs);
}

// advanceWorkflow's hand-off: park the row ('delayed' / 'active') AND queue
// its resume in ONE transaction, guarded on our 'processing' soft lock, and
// ring the Cloud Tasks doorbell only after commit. Returns false (nothing
// written) when the row already left 'processing' — cancelled mid-step.
//
// Why atomic, and why this order: the resume job is the only thing that can
// start another advance. Queued BEFORE the park (the pre-2026-09-22 order),
// a second advance could claim the still-'processing' row in the gap; this
// invocation's guarded park then passed against the OTHER claimant's
// 'processing' and stranded the run 'active' with no job. With the row
// UPDATE first inside the transaction, the job is never visible while this
// invocation still holds the soft lock, and a racing cancel / decision flip
// serializes on the row lock. No cleanup DELETE is needed, so nothing can
// delete another invocation's job.
async function parkWithResume(execId, status, resumeAt, nextStep, db) {
  const job = await db.withTransaction(async (conn) => {
    const [r] = await conn.query(
      `UPDATE workflow_executions SET status = ?, updated_at = NOW()
        WHERE id = ? AND status = 'processing'`,
      [status, execId]
    );
    if (r.affectedRows === 0) return null;
    return insertResumeJob(conn, execId, resumeAt, nextStep);
  });
  if (job === null) return false;
  if (job.jobId != null) await enqueueResumeDispatch(job.jobId, job.resumeAtMs);
  return true;
}

// Status writes below are GUARDED on the soft lock advanceWorkflow took in
// PHASE 1 (status = 'processing'). Both are only ever called from inside
// advanceWorkflow. A row that left 'processing' while a step ran — cancelled
// via POST /executions/:id/cancel, or flipped by exec recovery — is never
// overwritten; the callers treat `false` as "stop now" (haltedExternally).
// Note the guard detects a status CHANGE, not ownership: a second claimant
// that re-set 'processing' passes it. That double-advance window is the
// pre-existing, accepted at-least-once exposure (see recoverStuckJobs).
async function updateExecutionStatus(execId, status, db) {
  const [r] = await db.query(
    `UPDATE workflow_executions SET status = ?, updated_at = NOW()
      WHERE id = ? AND status = 'processing'`,
    [status, execId]
  );
  return r.affectedRows > 0;
}

async function markExecutionCompleted(execId, finalStatus, db, { from = ['processing'] } = {}) {
  if (!Array.isArray(from) || from.length === 0) throw new Error('markExecutionCompleted: `from` must list at least one status');
  const [r] = await db.query(
    `UPDATE workflow_executions 
     SET status = ?, completed_at = NOW(), updated_at = NOW(), current_step_number = NULL 
     WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`,
    [finalStatus, execId, ...from]
  );
  if (r.affectedRows > 0) {
    console.log(`[COMPLETED] Execution ${execId} marked as ${finalStatus}`);
    return true;
  }
  console.warn(`[COMPLETED] Execution ${execId} NOT marked ${finalStatus} — status is no longer ${from.join('/')} (changed externally, e.g. cancelled)`);
  return false;
}

async function haltedExternally(execId, stepNumber, db) {
  let now = 'unknown';
  try {
    const [[row]] = await db.query(`SELECT status FROM workflow_executions WHERE id = ?`, [execId]);
    now = row ? row.status : 'missing';
  } catch (_) { /* diagnostic only */ }
  console.warn(`[ADVANCE] Execution ${execId} left 'processing' externally (now '${now}') — halted at the step ${stepNumber} boundary`);
  return { status: 'halted', message: `execution status changed externally to '${now}'` };
}

// ─────────────────────────────────────────────────────────────
// Runaway-loop guard (2026-09-22). Incident: WF 27 v6 carried a duplicated
// 8-step block whose branch targets pointed back into the original, so step
// 43 jumped to 36 → 39 (create_task) → 40…43 → 36 with no pause in the cycle.
// MAX_STEPS_PER_INVOCATION only reschedules, so two executions ran ~1,470
// steps each and created 480 tasks + assignment emails in 9½ minutes until a
// manual cancel. Fall-through only ever moves forward, so EVERY cycle in a
// step graph contains a backward (or self) jump — counting those between
// pauses catches any pause-free loop, whatever its length.
//
//   counted  a jump to a step number <= the jumping step's own: a control
//            target, or the resume target of a delay too short to be a pause
//   reset    by a PAUSE — a step whose delayed_until is at least
//            LOOP_GUARD_MIN_PAUSE_MS out. A seconds-long or past-dated wait
//            resumes almost at once (Cloud Tasks doorbell), so a loop around
//            one is as fast as the incident's; it does not reset.
//   foreach  a loop-back onto a foreach whose cursor ADVANCED since its last
//            loop-back is a real iteration: not counted, and the count drops
//            back to its value when the loop started (recorded when the
//            foreach runs fresh), so each item — the first included — may
//            detour and jump back within itself. Forgiven loop-backs are
//            budgeted separately (LOOP_GUARD_MAX_FOREACH_PASSES) so an outer
//            loop that keeps restarting a foreach is bounded by passes, not
//            by restarts × list length. A loop-back whose cursor did NOT
//            move is a failing foreach (a throw under the default 'ignore'
//            policy falls into the body — see the manual's foreach gotchas)
//            and is counted like any other jump.
//
// State persists in the execution's variables (LOOP_GUARD_VAR, same
// reserved-__ convention as foreach's cursor) because loops span
// self-continue invocations: { n, f, fe: { <foreachStep>: { i, base } } }.
// Tripping fails the execution and raises a critical IT alert.
// Publish-time counterpart: versionDiff.findPauseFreeCycles, which blocks
// the static cases before they ever run; this layer also covers dynamic
// ({{jump_to}}) targets, short waits, failing foreach loops, and versions
// published before the gate existed.
const LOOP_GUARD_VAR = '__loop_guard';
const LOOP_GUARD_MAX_BACKJUMPS = 20;
const LOOP_GUARD_MAX_FOREACH_PASSES = 1000;
const LOOP_GUARD_MIN_PAUSE_MS = 60 * 1000;

function readLoopGuard(v) {
  if (v && typeof v === 'object' && Number.isInteger(v.n)) {
    return {
      n: v.n,
      f: Number.isInteger(v.f) ? v.f : 0,
      fe: v.fe && typeof v.fe === 'object' ? { ...v.fe } : {},
    };
  }
  return { n: 0, f: 0, fe: {} };
}

// A foreach that just exposed its FIRST item (fresh cursor → index 0).
function isFreshForeachStart(step, stepResult) {
  const out = stepResult.output?.output;
  return step.type === 'internal_function' && step.config?.function_name === 'foreach'
    && out != null && out.done === false && out.index === 0;
}

const LOOP_FIX_HINT = 'A loop must pause on every pass (wait_for / schedule_resume of at least a minute, ' +
  'or request_decision) or loop back onto a foreach step.';

async function checkLoopGuard(execution, targetStep, variables, db) {
  const g = readLoopGuard(variables?.[LOOP_GUARD_VAR]);
  const target = await loadWorkflowStep(execution.workflow_id, targetStep, execution.workflow_version, db);
  const cfg = target && target.type === 'internal_function' ? target.config : null;
  if (cfg?.function_name === 'foreach') {
    const p = cfg.params || {};
    const cursor = variables?.[(p.state_var && String(p.state_var)) || `__foreach_${p.item_var}`];
    const key = String(targetStep);
    const rec = g.fe[key];
    if (cursor && typeof cursor === 'object' && Number.isInteger(cursor.i)) {
      let advanced = false;
      if (!rec) {                                    // record lost to a pause mid-loop
        g.fe[key] = { i: cursor.i, base: g.n };
        advanced = true;
      } else if (cursor.i > rec.i) {                 // cursor advanced — a real iteration
        g.fe[key] = { i: cursor.i, base: rec.base };
        g.n = rec.base;
        advanced = true;
      }
      if (advanced) {
        g.f += 1;
        if (g.f > LOOP_GUARD_MAX_FOREACH_PASSES) {
          return {
            tripped: true,
            error: `runaway-loop guard: ${g.f} foreach passes with no pause in between ` +
                   `(limit ${LOOP_GUARD_MAX_FOREACH_PASSES}) — last jump → step ${targetStep}. ` +
                   `Pause-free foreach work (nested loops included) is capped; put a wait in the outer loop.`,
          };
        }
        return { tripped: false, state: g };
      }
      // cursor did not move: the foreach step is failing — count it
    } else {
      delete g.fe[key];                              // no live cursor — nothing bounds this loop
    }
  }

  g.n += 1;
  if (g.n > LOOP_GUARD_MAX_BACKJUMPS) {
    return {
      tripped: true,
      error: `runaway-loop guard: ${g.n} backward jumps with no pause in between ` +
             `(limit ${LOOP_GUARD_MAX_BACKJUMPS}; advancing foreach loop-backs excluded) — last jump → step ${targetStep}. ` +
             LOOP_FIX_HINT,
    };
  }
  return { tripped: false, state: g };
}

async function raiseRunawayAlert(execution, stepNumber, jumpTarget, error, db) {
  const { alert } = require('./alerting'); // lazy, like every other engine-side caller
  await alert(db, {
    source: 'workflow',
    kind: 'runaway_loop',
    // Own group: workflow:<id> is shared with the step_failed stream, and a
    // critical in a shared group can be hour-throttled behind unrelated noise.
    group_key: `workflow_runaway:${execution.workflow_id}`,
    severity: 'critical',
    title: `Workflow ${execution.workflow_id} execution ${execution.id} stopped by the runaway-loop guard`,
    message: error,
    context: {
      workflow_id: execution.workflow_id,
      workflow_version: execution.workflow_version,
      execution_id: execution.id,
      step_number: stepNumber,
      jump_target: jumpTarget,
    },
    ref_table: 'workflow_executions',
    ref_id: execution.id,
    dedup_key: `wf_runaway:${execution.id}`,
  });
}

async function scheduleSelfContinue(execId, nextStep, db) {
  // Park 'active' + a workflow_resume job 1s out, atomically (parkWithResume).
  // false → the row left 'processing' (cancelled); nothing was written.
  const soon = new Date(Date.now() + 1000);
  return parkWithResume(execId, 'active', soon.toISOString(), nextStep, db);
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

  const step = await loadWorkflowStep(execution.workflow_id, stepNumber, execution.workflow_version, db);
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
  // Exported for tests/workflowEngine.cancelAndLoopGuard.test.js.
  LOOP_GUARD_VAR,
  LOOP_GUARD_MAX_BACKJUMPS,
  LOOP_GUARD_MAX_FOREACH_PASSES,
  LOOP_GUARD_MIN_PAUSE_MS,
  executeSingleStep,
  resolvePlaceholders,
  resolveSingle,
  getWorkflowFinalStatus,
  resolveExecutionContactId,
  InvalidContactIdError,
  captureWorkflowInput,
  captureRefusedStart,
  scheduleResume,
  // Exported for routes/decisionActions.js — the decision response endpoint
  // writes the chosen value into execution variables before resuming.
  mergeVariables,
  // Exported for tests/control.flow.test.js — asserts the control-step set is
  // derived from __meta.controlFlow and stays in step with BRANCH_TARGET_PARAMS.
  isControlStep,
  // Exported for tests/control.flow.test.js — the next_step sentinel contract.
  normalizeNextStep,
};