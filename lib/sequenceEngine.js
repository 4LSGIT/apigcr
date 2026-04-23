// lib/sequenceEngine.js
//
// Sequence Engine — enrollment, step execution, cancellation.
//
// Public API:
//   enrollContact(db, contactId, templateType, triggerData)
//     → { enrollmentId, templateName, totalSteps, firstJobScheduledAt }
//
//   executeStep(db, enrollmentId, stepId)
//     → { status: 'sent'|'skipped'|'failed', reason? }
//
//   cancelSequences(db, contactId, templateType, reason)
//     → { cancelled: number }
//
// Internal helpers (exported for testing):
//   checkCondition(db, condition, triggerData)
//   checkFireGuard(fireGuard, triggerData)
//   calculateStepTime(timing, triggerData, fromDate)
//   buildRefsForStep(triggerData, contactId)

const { resolve }          = require('../services/resolverService');
const { executeJob }       = require('./job_executor');
const calendar             = require('../services/calendarService');

// ─────────────────────────────────────────────────────────────
// Condition checker
// Used for both template-level (cancel enrollment) and
// step-level (skip step) conditions.
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a condition object against the DB.
 *
 * Condition shape:
 * {
 *   query:       "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
 *   params:      { "appt_id": "trigger_data.appt_id" },
 *   assert:      { "appt_status": { "in": ["no_show","cancelled"] } },
 *   assert_mode: "all" | "any"   (default "all")
 * }
 *
 * Assert operators per field:
 *   scalar         → strict equality
 *   { in: [...] }  → value in array
 *   { is_null: true/false } → null / not-null check
 *
 * @returns {boolean} true = condition passes (proceed), false = condition fails (skip/cancel)
 */
async function checkCondition(db, condition, triggerData) {
  if (!condition) return true; // no condition = always passes

  const { query, params: paramMap = {}, assert = {}, assert_mode = 'all' } = condition;

  if (!query || typeof query !== 'string') {
    console.error('[sequenceEngine] Invalid condition: missing query');
    return false;
  }

  // Only SELECT allowed
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    console.error('[sequenceEngine] Condition query must be a SELECT');
    return false;
  }

  // Resolve :param placeholders from trigger_data using dot-path.
  //
  // Single-pass tokenization: scan the query for :name tokens in order of
  // appearance and push positional params in the SAME order. This fixes three
  // bugs in the previous per-key loop (which called .replace(':name', '?')):
  //   (1) .replace with a string pattern only replaces the FIRST occurrence,
  //       so queries using the same placeholder twice (e.g.
  //         "... WHERE appt_id = :appt_id OR ref_appt_id = :appt_id")
  //       left the second token unreplaced → MySQL parse error → silent false.
  //   (2) Params were pushed in paramMap iteration order, but MySQL ? params
  //       bind by position in the query. If the JSON author wrote the paramMap
  //       keys in a different order than placeholders appear in the query,
  //       values were silently misaligned.
  //   (3) .replace(':foo', '?') also matches the prefix of :foo_bar. Greedy
  //       \w+ here treats each :name as a whole token, so :foo and :foo_bar
  //       don't collide.
  const resolvedParams      = [];
  const unknownPlaceholders = [];

  let resolvedQuery = query.replace(/:(\w+)/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(paramMap, name)) {
      unknownPlaceholders.push(name);
      return `:${name}`; // leave as-is; surface below
    }
    const sourcePath = paramMap[name];
    const value = getNestedValue(triggerData, sourcePath.replace('trigger_data.', ''));
    if (value === undefined || value === null) {
      console.warn(`[sequenceEngine] Condition param :${name} resolved to null (path: ${sourcePath})`);
    }
    resolvedParams.push(value ?? null);
    return '?';
  });

  if (unknownPlaceholders.length) {
    console.error(
      `[sequenceEngine] Condition query has unknown placeholders: ${unknownPlaceholders.map(n => ':' + n).join(', ')} — paramMap keys: ${Object.keys(paramMap).join(', ') || '(none)'}`
    );
    return false;
  }

  // Add LIMIT 1 if not already present
  if (!/LIMIT\s+\d+/i.test(resolvedQuery)) {
    resolvedQuery += ' LIMIT 1';
  }

  let row;
  try {
    const [rows] = await db.query(resolvedQuery, resolvedParams);
    row = rows[0] || null;
  } catch (err) {
    console.error('[sequenceEngine] Condition query failed:', err.message, resolvedQuery);
    return false;
  }

  if (!row) {
    console.warn('[sequenceEngine] Condition query returned no rows — treating as failed');
    return false;
  }

  // Evaluate assertions
  const assertEntries = Object.entries(assert);
  const results = assertEntries.map(([field, expected]) => {
    const actual = row[field];
    return evaluateAssertion(actual, expected);
  });

  if (assert_mode === 'any') return results.some(Boolean);
  return results.every(Boolean);
}

function evaluateAssertion(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual == null;
  }
  if (typeof expected === 'object') {
    if ('in' in expected) {
      return expected.in.includes(actual);
    }
    if ('is_null' in expected) {
      const isEmpty = actual === null || actual === undefined || actual === '';
      return expected.is_null ? isEmpty : !isEmpty;
    }
  }
  // Scalar: loose equality (handles "1" == 1 etc.)
  // eslint-disable-next-line eqeqeq
  return actual == expected;
}

// ─────────────────────────────────────────────────────────────
// Fire guard checker
// Lightweight time-based check — no DB query.
// ─────────────────────────────────────────────────────────────

/**
 * Check time-based guards against trigger_data.
 * Returns true = ok to fire, false = skip this step.
 */
function checkFireGuard(fireGuard, triggerData) {
  if (!fireGuard) return true;

  const { min_hours_before_appt } = fireGuard;

  if (min_hours_before_appt != null) {
    const apptTime = triggerData?.appt_time;
    if (!apptTime) {
      console.warn('[sequenceEngine] fire_guard.min_hours_before_appt set but trigger_data.appt_time missing');
      return true; // fail open — don't block if we can't check
    }
    const hoursUntilAppt = (new Date(apptTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilAppt < min_hours_before_appt) {
      console.log(`[sequenceEngine] Fire guard: ${hoursUntilAppt.toFixed(1)}h until appt < ${min_hours_before_appt}h minimum — skipping`);
      return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Timing calculator
// ─────────────────────────────────────────────────────────────

/**
 * Calculate the datetime a step should fire.
 *
 * @param {object} timing     — the step's timing JSON
 * @param {object} triggerData — enrollment trigger_data
 * @param {Date}   fromDate   — reference point (enrollment time for step 1, prev execution for step 2+)
 * @returns {Date}
 */
async function calculateStepTime(timing, triggerData, fromDate) {
  const from = fromDate ? new Date(fromDate) : new Date();

  if (!timing || timing.type === 'immediate') {
    return new Date(from.getTime() + 5000); // 5 seconds from now
  }

  if (timing.type === 'delay') {
    const ms = durationToMs(timing.value, timing.unit);
    return new Date(from.getTime() + ms);
  }

  if (timing.type === 'next_business_day') {
    return calendar.nextBusinessDay(from, {
      timeOfDay:        timing.timeOfDay        || '09:00',
      randomizeMinutes: timing.randomizeMinutes || 0,
      maxDaysAhead:     timing.maxDaysAhead     || 30,
      timezone:         timing.timezone,  // undefined = calendarService uses DEFAULT_TZ
    });
  }

  if (timing.type === 'business_days') {
    // N business days from now — walk forward N times
    let current = from;
    for (let i = 0; i < (timing.value || 1); i++) {
      current = await calendar.nextBusinessDay(current, {
        timeOfDay:        timing.timeOfDay        || '09:00',
        randomizeMinutes: timing.randomizeMinutes || 0,
        timezone:         timing.timezone,
      });
    }
    return current;
  }

  if (timing.type === 'before_appt_fixed') {
    const apptTime = triggerData?.appt_time;
    if (!apptTime) throw new Error('before_appt_fixed requires trigger_data.appt_time');
    const hoursMs = durationToMs(timing.hoursBack, 'hours');
    return new Date(new Date(apptTime).getTime() - hoursMs);
  }

  if (timing.type === 'before_appt') {
    const apptTime = triggerData?.appt_time;
    if (!apptTime) throw new Error('before_appt requires trigger_data.appt_time');

    const attempts = [{
      hoursBack:        timing.hoursBack,
      sameTimeAsAnchor: timing.sameTimeAsAnchor || false,
      timeOfDay:        timing.timeOfDay,
      randomizeMinutes: timing.randomizeMinutes || 0,
      minHoursBefore:   timing.minHoursBefore   || 1,
    }];

    // NOTE: `minHoursBefore` lives on the attempt rule above — not in the
    // outer defaults. `prevBusinessDay` resolves per-attempt first
    // (attemptMin ?? defaults.minHoursBefore), and since we always set the
    // attempt value here, passing it as a default too would be dead config.
    const result = await calendar.prevBusinessDay(new Date(apptTime), attempts, {
      maxDaysBack:    timing.maxDaysBack     || 14,
      timezone:       timing.timezone,
    });

    if (!result) throw new Error(`No valid business day slot found for before_appt timing (hoursBack: ${timing.hoursBack})`);
    return result.scheduledAt;
  }

  throw new Error(`Unknown timing type: "${timing.type}"`);
}

function durationToMs(value, unit) {
  const v = Number(value) || 0;
  switch (unit) {
    case 'seconds': return v * 1000;
    case 'minutes': return v * 60 * 1000;
    case 'hours':   return v * 60 * 60 * 1000;
    case 'days':    return v * 24 * 60 * 60 * 1000;
    default:        return v * 60 * 1000; // default: minutes
  }
}

// ─────────────────────────────────────────────────────────────
// Refs builder for resolver
// ─────────────────────────────────────────────────────────────

/**
 * Build the refs object for resolverService.resolve()
 * based on what IDs are available in trigger_data.
 *
 * `trigger_data` itself is also passed through as a pseudo-table, so that
 * action_config placeholders like {{trigger_data.amount}} or
 * {{trigger_data.missed_date|date:dddd}} resolve directly from the enrollment
 * payload without needing a column on a real table.
 */
function buildRefsForStep(triggerData, contactId) {
  const refs = {
    contacts:     { contact_id: contactId },
    trigger_data: triggerData || {},
  };

  if (triggerData?.appt_id)  refs.appts = { appt_id: triggerData.appt_id };
  if (triggerData?.case_id)  refs.cases = { case_id: triggerData.case_id };
  if (triggerData?.task_id)  refs.tasks = { task_id: triggerData.task_id };

  return refs;
}

/**
 * UPDATED enrollContact — cascading template priority matching
 *
 * Changes from original:
 *   - New optional params: appt_type, appt_with
 *   - Template lookup now uses priority ordering:
 *     1. type match + appt_type match + appt_with match (most specific)
 *     2. type match + appt_type match + appt_with NULL
 *     3. type match + appt_type NULL  + appt_with match
 *     4. type match + appt_type NULL  + appt_with NULL  (generic fallback)
 *
 * To apply:
 *   Replace the enrollContact function in lib/sequenceEngine.js.
 *   The function signature changes — callers that pass appt_type/appt_with
 *   get specific matching; callers that don't get the same behavior as before
 *   (falls through to the generic template).
 */
 
/**
 * Enroll a contact in a sequence.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} templateType   — e.g. 'no_show', 'lead_drip'
 * @param {object} triggerData    — context: { appt_id, appt_time, case_id, enrolled_by, ... }
 * @param {object} [filters]      — optional filter matching
 * @param {string} [filters.appt_type]  — match against template.appt_type_filter
 * @param {number} [filters.appt_with]  — match against template.appt_with_filter
 * @returns {{ enrollmentId, templateName, totalSteps, firstJobScheduledAt }}
 */
async function enrollContact(db, contactId, templateType, triggerData = {}, filters = {}) {
  // Belt-and-suspenders guard matching the route-level check in POST /sequences/enroll.
  // Without this, a null/empty templateType silently produces zero cascade matches
  // (MySQL `WHERE type = NULL` is always false), then throws "No active template
  // found for type: null" which is confusing. Reject early with a clearer message
  // that tells the caller which function to use for ID-based enrollment.
  if (!templateType || !String(templateType).trim()) {
    throw new Error(
      'enrollContact requires a non-empty templateType; use enrollContactByTemplateId for ID-based enrollment'
    );
  }
  const { appt_type = null, appt_with = null } = filters;
  // ── Find best-matching template using cascading priority ──
  const [templates] = await db.query(
    `SELECT * FROM sequence_templates
     WHERE type = ? AND active = 1
       AND (appt_type_filter = ? OR appt_type_filter IS NULL)
       AND (appt_with_filter = ? OR appt_with_filter IS NULL)
     ORDER BY
       (appt_type_filter IS NOT NULL) DESC,
       (appt_with_filter IS NOT NULL) DESC
     LIMIT 1`,
    [templateType, appt_type, appt_with]
  );
  if (!templates.length) {
    throw new Error(`No active sequence template found for type: ${templateType}`);
  }
  const template = templates[0];
  console.log(`[sequence] Template match for type="${templateType}" appt_type="${appt_type}" appt_with=${appt_with} → "${template.name}" (id: ${template.id}, type_filter: ${template.appt_type_filter}, with_filter: ${template.appt_with_filter})`);
  return _enrollWithTemplate(db, contactId, template, triggerData);
}

// ─────────────────────────────────────────────────────────────
// scheduleStepJob — insert into scheduled_jobs
// ─────────────────────────────────────────────────────────────

async function scheduleStepJob(db, enrollmentId, step, scheduledAt) {
  const idempotencyKey = `seq-${enrollmentId}-step-${step.step_number}`;

  // Prevent duplicate jobs for same enrollment+step
  const [existing] = await db.query(
    `SELECT id FROM scheduled_jobs
     WHERE idempotency_key = ? AND status IN ('pending','running') LIMIT 1`,
    [idempotencyKey]
  );

  if (existing.length) {
    console.log(`[sequence] Skipping duplicate job for ${idempotencyKey}`);
    return;
  }

  await db.query(
    `INSERT INTO scheduled_jobs
     (type, scheduled_time, status, name, data, sequence_enrollment_id, idempotency_key)
     VALUES ('sequence_step', ?, 'pending', ?, ?, ?, ?)`,
    [
      scheduledAt,
      `Seq enrollment ${enrollmentId} step ${step.step_number}`,
      JSON.stringify({ enrollmentId, stepId: step.id, stepNumber: step.step_number }),
      enrollmentId,
      idempotencyKey,
    ]
  );

  console.log(`[sequence] Scheduled step ${step.step_number} for enrollment ${enrollmentId} at ${scheduledAt.toISOString()}`);
}

// ─────────────────────────────────────────────────────────────
// Webhook action (sequence step type 'webhook')  — Slice 3.3
//
// NOT retry-idempotent — duplicate delivery on retry is acceptable; the
// receiver must tolerate duplicates (same caveat as internal-function hook
// targets, Cookbook §5.18). Shares credential injection with YisraHook HTTP
// targets via lib/credentialInjection.
// ─────────────────────────────────────────────────────────────

/**
 * Execute a 'webhook' sequence step.
 *
 * @param {object} db
 * @param {object} resolvedConfig — action_config with placeholders already resolved.
 *                                  Expected shape: { method, url, credential_id,
 *                                  headers, body, timeout_ms }
 * @returns {Promise<object>} { status_code, response_body_truncated }
 * @throws on HTTP non-2xx or fetch error — caller's retry policy handles it.
 */
async function executeWebhookAction(db, resolvedConfig) {
  const fetch = require('node-fetch');
  const { buildHeadersForCredential } = require('./credentialInjection');

  const method = (resolvedConfig.method || 'POST').toUpperCase();
  const url = resolvedConfig.url;
  if (!url || typeof url !== 'string') {
    throw new Error('webhook step: url is required');
  }

  const staticHeaders = (resolvedConfig.headers && typeof resolvedConfig.headers === 'object' && !Array.isArray(resolvedConfig.headers))
    ? resolvedConfig.headers
    : {};
  const authHeaders = await buildHeadersForCredential(db, resolvedConfig.credential_id, url);
  const headers = {
    'Content-Type': 'application/json',
    ...staticHeaders,
    ...authHeaders,
  };

  const rawTimeout = Number(resolvedConfig.timeout_ms);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(rawTimeout, 120000)
    : 30000;

  const fetchOptions = { method, headers, timeout: timeoutMs };
  if (!['GET', 'DELETE'].includes(method)) {
    // Body resolution: resolved at the action_config level by the caller.
    // Non-object bodies default to {} rather than serializing `null`/undefined
    // unpredictably.
    const b = resolvedConfig.body;
    const bodyObj = (b && typeof b === 'object') ? b : {};
    fetchOptions.body = JSON.stringify(bodyObj);
  }

  const response = await fetch(url, fetchOptions);
  const responseText = await response.text();

  if (!response.ok) {
    const err = new Error(`webhook HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    err.status_code = response.status;
    throw err;
  }

  return {
    status_code: response.status,
    response_body_truncated: responseText.slice(0, 10000),
  };
}

// ─────────────────────────────────────────────────────────────
// Start-workflow action (sequence step type 'start_workflow')  — Slice 3.3
//
// Fourth INSERT site for workflow_executions (see Cookbook §5.21, now stale —
// the three-site claim needs to be updated to four). The other three are:
//   - routes/workflows.js         POST /workflows/:id/start
//   - services/apptService.js     createAppt (appt-reminder workflow)
//   - services/hookService.js     deliverWorkflow (hook → workflow target)
// A future slice should consolidate all four into a shared
// createWorkflowExecution() helper.
// ─────────────────────────────────────────────────────────────

/**
 * Execute a 'start_workflow' sequence step. Retry-safe via a check on
 * sequence_step_log.output_data — if this (enrollment, step_number) already
 * produced a workflow_execution_id and that execution still exists, reuse it
 * instead of creating a duplicate.
 *
 * @param {object} db
 * @param {number} enrollmentId
 * @param {object} step            — sequence_steps row (parsed)
 * @param {object} enrollment      — sequence_enrollments row (parsed)
 * @param {object} resolvedConfig  — { workflow_id, init_data, tie_to_contact,
 *                                     contact_id_override } with placeholders resolved
 * @returns {Promise<object>} { workflow_execution_id, contact_id, reused? }
 */
async function executeStartWorkflowAction(db, enrollmentId, step, enrollment, resolvedConfig) {
  const { resolveExecutionContactId, advanceWorkflow } = require('./workflow_engine');

  const workflowIdNum = Number(resolvedConfig.workflow_id);
  if (!Number.isInteger(workflowIdNum) || workflowIdNum <= 0) {
    throw new Error(`start_workflow step: workflow_id is required and must be a positive integer (got ${JSON.stringify(resolvedConfig.workflow_id)})`);
  }

  // Retry-safety short-circuit (see D5 comment at findPriorStartWorkflowResult).
  const prior = await findPriorStartWorkflowResult(db, enrollmentId, step.step_number);
  if (prior) {
    // Confirm the execution row still exists. If retention or manual cleanup
    // removed it, log a warning and fire a new one rather than blocking.
    const [[exists]] = await db.query(
      `SELECT id FROM workflow_executions WHERE id = ? LIMIT 1`,
      [prior.workflow_execution_id]
    );
    if (exists) {
      console.log(`[sequence] start_workflow enrollment ${enrollmentId} step ${step.step_number}: reusing prior execution ${prior.workflow_execution_id} (retry-safe skip)`);
      return {
        workflow_execution_id: prior.workflow_execution_id,
        contact_id: prior.contact_id ?? null,
        reused: true,
      };
    }
    console.warn(`[sequence] start_workflow enrollment ${enrollmentId} step ${step.step_number}: prior execution ${prior.workflow_execution_id} no longer exists — creating a new one`);
  }

  // Contact-id precedence:
  //   1. tie_to_contact: true (default)   → enrollment.contact_id (explicit override)
  //   2. tie_to_contact: false + non-empty contact_id_override → resolve override
  //   3. tie_to_contact: false + empty override                → rely on template default
  const tieToContact = resolvedConfig.tie_to_contact !== false; // default true
  let explicitContactId;

  if (tieToContact) {
    explicitContactId = enrollment.contact_id;
  } else {
    const override = resolvedConfig.contact_id_override;
    if (override !== undefined && override !== null && String(override).trim() !== '') {
      // Override may be a literal int (or numeric string); the resolver already
      // substituted any {{ }} placeholders before we got here.
      const n = Number(override);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`start_workflow step: contact_id_override must resolve to a positive integer (got ${JSON.stringify(override)})`);
      }
      explicitContactId = n;
    } else {
      explicitContactId = undefined; // fall through to template default
    }
  }

  // Load template default for fallback.
  const [[wfRow]] = await db.query(
    `SELECT id, default_contact_id_from FROM workflows WHERE id = ?`,
    [workflowIdNum]
  );
  if (!wfRow) {
    throw new Error(`start_workflow step: workflow #${workflowIdNum} not found`);
  }

  const initData = (resolvedConfig.init_data && typeof resolvedConfig.init_data === 'object' && !Array.isArray(resolvedConfig.init_data))
    ? resolvedConfig.init_data
    : {};

  const contactId = resolveExecutionContactId({
    explicitContactId,
    initData,
    defaultKey: wfRow.default_contact_id_from,
  });

  // INSERT — fourth workflow_executions creation site (Cookbook §5.21).
  const [result] = await db.query(
    `INSERT INTO workflow_executions
     (workflow_id, contact_id, status, init_data, variables, current_step_number)
     VALUES (?, ?, 'active', ?, ?, 1)`,
    [workflowIdNum, contactId, JSON.stringify(initData), JSON.stringify(initData)]
  );
  const executionId = result.insertId;

  // Fire-and-forget advance — mirrors apptService.createAppt and
  // hookService.deliverWorkflow. A background failure in advanceWorkflow
  // does NOT re-fire this sequence step; the execution row will be marked
  // 'failed' by markExecutionCompleted.
  (async () => {
    try {
      await advanceWorkflow(executionId, db);
    } catch (err) {
      console.error(`[sequence→WF] advanceWorkflow failed for execution ${executionId}:`, err.message);
    }
  })();

  return {
    workflow_execution_id: executionId,
    contact_id: contactId,
  };
}

/**
 * Look up a prior 'sent' sequence_step_log row for this (enrollment, step_number)
 * carrying a workflow_execution_id in output_data. Used by start_workflow
 * retry-safety.
 *
 * D5 (known gap, intentionally accepted): this check covers process_jobs-level
 * retries — the log row exists by the time a later job claim re-invokes
 * executeStep. It does NOT cover in-loop retries within a single executeStep
 * invocation, because the retry loop runs BEFORE logStep writes. In practice
 * the only work in executeStartWorkflowAction is INSERT + fire-and-forget
 * advance, so a successful INSERT breaks the loop and no in-loop retry can
 * happen; a failed INSERT means no execution row was created, so a retry is
 * safe.
 *
 * @returns {Promise<{workflow_execution_id: number, contact_id: number|null}|null>}
 */
async function findPriorStartWorkflowResult(db, enrollmentId, stepNumber) {
  const [rows] = await db.query(
    `SELECT output_data FROM sequence_step_log
     WHERE enrollment_id = ? AND step_number = ? AND status = 'sent'
     ORDER BY id DESC LIMIT 1`,
    [enrollmentId, stepNumber]
  );
  if (!rows.length) return null;

  let out = rows[0].output_data;
  if (typeof out === 'string') {
    try { out = JSON.parse(out); } catch { return null; }
  }
  if (!out || typeof out !== 'object') return null;
  if (!out.workflow_execution_id) return null;

  return {
    workflow_execution_id: Number(out.workflow_execution_id),
    contact_id: out.contact_id ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// executeStep — called by process_jobs when a sequence_step fires
// ─────────────────────────────────────────────────────────────

/**
 * Execute one sequence step.
 * Handles: enrollment check, template condition, fire guard, step condition,
 *          placeholder resolution, action execution, logging, scheduling next step.
 *
 * @param {object} db
 * @param {number} enrollmentId
 * @param {number} stepId
 * @returns {{ status: 'sent'|'skipped'|'failed', reason?, nextScheduledAt? }}
 */
async function executeStep(db, enrollmentId, stepId) {
  const startTime = Date.now();

  // ── Load enrollment ──
  const [enrollments] = await db.query(
    `SELECT e.*, t.\`condition\` AS template_condition, t.name AS template_name, t.type AS template_type
     FROM sequence_enrollments e
     JOIN sequence_templates t ON t.id = e.template_id
     WHERE e.id = ?`,
    [enrollmentId]
  );

  if (!enrollments.length) {
    return { status: 'skipped', reason: 'enrollment_not_found' };
  }

  const enrollment = enrollments[0];

  // Parse JSON fields
  const triggerData = typeof enrollment.trigger_data === 'string'
    ? JSON.parse(enrollment.trigger_data)
    : (enrollment.trigger_data || {});

  const templateCondition = typeof enrollment.template_condition === 'string'
    ? JSON.parse(enrollment.template_condition)
    : enrollment.template_condition;

  // ── Guard 1: enrollment must be active ──
  if (enrollment.status !== 'active') {
    await logStep(db, enrollmentId, stepId, null, 'skipped', 'enrollment_not_active', null, null, null, Date.now() - startTime);
    return { status: 'skipped', reason: 'enrollment_not_active' };
  }

  // ── Load step ──
  const [steps] = await db.query(
    `SELECT * FROM sequence_steps WHERE id = ?`,
    [stepId]
  );

  if (!steps.length) {
    return { status: 'failed', reason: 'step_not_found' };
  }

  const step = steps[0];

  // Parse step JSON fields
  if (typeof step.timing        === 'string') step.timing        = JSON.parse(step.timing);
  if (typeof step.action_config === 'string') step.action_config = JSON.parse(step.action_config);
  if (typeof step.condition     === 'string') step.condition     = JSON.parse(step.condition);
  if (typeof step.fire_guard    === 'string') step.fire_guard    = JSON.parse(step.fire_guard);
  if (typeof step.error_policy  === 'string') step.error_policy  = JSON.parse(step.error_policy);

  const scheduledAt = await getJobScheduledAt(db, enrollmentId, step.step_number);

  // ── Guard 2: template-level condition (cancel enrollment if fails) ──
  if (templateCondition) {
    const conditionPasses = await checkCondition(db, templateCondition, triggerData);
    if (!conditionPasses) {
      console.log(`[sequence] Template condition failed for enrollment ${enrollmentId} — cancelling`);
      await cancelEnrollment(db, enrollmentId, 'condition_failed');
      await logStep(db, enrollmentId, stepId, step.step_number, 'skipped', 'condition_failed', null, null, scheduledAt, Date.now() - startTime);
      return { status: 'skipped', reason: 'condition_failed' };
    }
  }

  // ── Guard 3: fire guard (time-based, skip only) ──
  if (!checkFireGuard(step.fire_guard, triggerData)) {
    await logStep(db, enrollmentId, stepId, step.step_number, 'skipped', 'fire_guard_failed', null, null, scheduledAt, Date.now() - startTime);
    await advanceToNextStep(db, enrollment, step, triggerData, startTime);
    return { status: 'skipped', reason: 'fire_guard_failed' };
  }

  // ── Guard 4: step-level condition (skip only, don't cancel) ──
  if (step.condition) {
    const stepConditionPasses = await checkCondition(db, step.condition, triggerData);
    if (!stepConditionPasses) {
      console.log(`[sequence] Step condition failed for step ${step.step_number} — skipping`);
      await logStep(db, enrollmentId, stepId, step.step_number, 'skipped', 'step_condition_failed', null, null, scheduledAt, Date.now() - startTime);
      await advanceToNextStep(db, enrollment, step, triggerData, startTime);
      return { status: 'skipped', reason: 'step_condition_failed' };
    }
  }

  // ── Resolve placeholders in action_config ──
  const refs            = buildRefsForStep(triggerData, enrollment.contact_id);
  let   resolvedConfig  = step.action_config;

  try {
    const configStr    = JSON.stringify(step.action_config);
    const resolveResult = await resolve({ db, text: configStr, refs, strict: false });
    resolvedConfig     = JSON.parse(resolveResult.text);

    if (resolveResult.unresolved.length) {
      console.warn(`[sequence] Step ${step.step_number}: unresolved placeholders:`, resolveResult.unresolved);
    }
  } catch (err) {
    console.error(`[sequence] Placeholder resolution failed for step ${step.step_number}:`, err.message);
    // Continue with unresolved config rather than failing the step
  }

  // ── Execute action ──
  const policy     = step.error_policy || { strategy: 'ignore' };
  const strategy   = policy.strategy   || 'ignore';
  const maxRetries = Number(policy.max_retries)    || 0;
  const backoffSec = Number(policy.backoff_seconds) || 5;

  let   rawResult;
  let   actionError;
  let   attempt = 1;

  while (true) {
    try {
      if (step.action_type === 'webhook') {
        // Slice 3.3 — first-class webhook. Uses shared credential injection
        // (lib/credentialInjection) — NOT executeJob's webhook path, which
        // has no cred injection and a hardcoded 10s timeout.
        rawResult = await executeWebhookAction(db, resolvedConfig);
      } else if (step.action_type === 'start_workflow') {
        // Slice 3.3 — first-class workflow start. Retry-safe via
        // findPriorStartWorkflowResult.
        rawResult = await executeStartWorkflowAction(db, enrollmentId, step, enrollment, resolvedConfig);
      } else {
        // sms / email / task / internal_function — all routed through
        // executeJob as internal_function. (The old fossil 'webhook' and
        // 'custom_code' dispatch branches here were unreachable: the
        // sequence_steps.action_type enum did not include those values.
        // Removed in Slice 3.3 — 'webhook' is now handled above with the
        // credential-injecting path, and 'custom_code' was never wired in
        // at any layer.)
        const jobData = {
          type: 'internal_function',
          ...resolvedConfig
        };
        rawResult = await executeJob({ data: jobData }, db);
      }
      break;
    } catch (err) {
      actionError = err.message;
      if (attempt > maxRetries) break;
      await new Promise(r => setTimeout(r, backoffSec * 1000 * attempt));
      attempt++;
    }
  }

  const duration = Date.now() - startTime;

  if (actionError && attempt > maxRetries) {
    const shouldAbort = strategy === 'abort' || strategy === 'retry_then_abort';

    await logStep(db, enrollmentId, stepId, step.step_number, 'failed', null, resolvedConfig, null, scheduledAt, duration, actionError);

    if (shouldAbort) {
      await cancelEnrollment(db, enrollmentId, `step_${step.step_number}_failed`);
      return { status: 'failed', reason: 'action_failed_abort' };
    }

    // ignore / retry_then_ignore → log and continue
    console.log(`[sequence] Step ${step.step_number} failed (ignored), advancing`);
    await advanceToNextStep(db, enrollment, step, triggerData, startTime);
    return { status: 'failed', reason: 'action_failed_ignored' };
  }

  // ── Success ──
  await logStep(db, enrollmentId, stepId, step.step_number, 'sent', null, resolvedConfig, rawResult, scheduledAt, duration);

  const nextScheduledAt = await advanceToNextStep(db, enrollment, step, triggerData, startTime);

  return {
    status:         'sent',
    nextScheduledAt: nextScheduledAt?.toISOString() || null,
  };
}

// ─────────────────────────────────────────────────────────────
// advanceToNextStep — load next step and schedule it
// ─────────────────────────────────────────────────────────────

async function advanceToNextStep(db, enrollment, completedStep, triggerData) {
  const [nextSteps] = await db.query(
    `SELECT * FROM sequence_steps
     WHERE template_id = ? AND step_number = ?`,
    [enrollment.template_id, completedStep.step_number + 1]
  );

  if (!nextSteps.length) {
    // No more steps — complete enrollment (don't advance current_step beyond last)
    await db.query(
      `UPDATE sequence_enrollments
       SET status = 'completed', current_step = ?, completed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [completedStep.step_number, enrollment.id]
    );
    console.log(`[sequence] Enrollment ${enrollment.id} completed`);
    return null;
  }

  // Update current_step to the next step (only now that we know it exists)
  await db.query(
    `UPDATE sequence_enrollments SET current_step = ?, updated_at = NOW() WHERE id = ?`,
    [completedStep.step_number + 1, enrollment.id]
  );

  const nextStep = nextSteps[0];
  if (typeof nextStep.timing === 'string') nextStep.timing = JSON.parse(nextStep.timing);

  const scheduledAt = await calculateStepTime(nextStep.timing, triggerData, new Date());
  await scheduleStepJob(db, enrollment.id, nextStep, scheduledAt);
  return scheduledAt;
}

// ─────────────────────────────────────────────────────────────
// cancelSequences
// ─────────────────────────────────────────────────────────────

/**
 * Cancel all active enrollments of a given type for a contact.
 * Also deletes any pending scheduled_jobs for those enrollments.
 *
 * Call this from: new appointment booked, appointment attended,
 *                 incoming SMS/email, manual override.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} templateType   — e.g. 'no_show'. Pass null to cancel ALL types.
 * @param {string} reason         — logged in cancel_reason column
 * @returns {{ cancelled: number }}
 */
async function cancelSequences(db, contactId, templateType, reason = 'manual') {
  // Find active enrollments
  let query  = `SELECT e.id FROM sequence_enrollments e
                JOIN sequence_templates t ON t.id = e.template_id
                WHERE e.contact_id = ? AND e.status = 'active'`;
  const params = [contactId];

  if (templateType) {
    query += ` AND t.type = ?`;
    params.push(templateType);
  }

  const [enrollments] = await db.query(query, params);
  if (!enrollments.length) return { cancelled: 0 };

  const ids = enrollments.map(e => e.id);

  // Cancel enrollments
  await db.query(
    `UPDATE sequence_enrollments
     SET status = 'cancelled', cancel_reason = ?, updated_at = NOW()
     WHERE id IN (?)`,
    [reason, ids]
  );

  // TODO: remove ~1 week after cutover once old-system no-shows are cleared
  if (templateType === 'no_show') {
    await db.query(
      `UPDATE appts SET appt_status = 'Canceled'
       WHERE appt_client_id = ? AND appt_status = 'No Show'`,
      [contactId]
    );
  }
  
  // Cancel pending/running scheduled jobs for these enrollments.
  // Mark as 'failed' rather than deleting — preserves audit trail.
  // Running jobs are mid-execution; they will check enrollment.status on completion
  // and exit cleanly since status is now 'cancelled'.
  const [cancelResult] = await db.query(
    `UPDATE scheduled_jobs
     SET status = 'failed', updated_at = NOW()
     WHERE sequence_enrollment_id IN (?)
       AND status IN ('pending', 'running')`,
    [ids]
  );

  console.log(`[sequence] Cancelled ${ids.length} enrollment(s) for contact ${contactId} (type: ${templateType || 'all'}, reason: ${reason}). Cancelled ${cancelResult.affectedRows} pending jobs.`);

  return { cancelled: ids.length };
}

// ─────────────────────────────────────────────────────────────
// cancelEnrollment — cancel a single enrollment
// ─────────────────────────────────────────────────────────────

async function cancelEnrollment(db, enrollmentId, reason) {
  await db.query(
    `UPDATE sequence_enrollments
     SET status = 'cancelled', cancel_reason = ?, updated_at = NOW()
     WHERE id = ?`,
    [reason, enrollmentId]
  );

  await db.query(
    `UPDATE scheduled_jobs
     SET status = 'failed', updated_at = NOW()
     WHERE sequence_enrollment_id = ? AND status IN ('pending', 'running')`,
    [enrollmentId]
  );

  console.log(`[sequence] Enrollment ${enrollmentId} cancelled: ${reason}`);
}

// ─────────────────────────────────────────────────────────────
// logStep
// ─────────────────────────────────────────────────────────────

async function logStep(db, enrollmentId, stepId, stepNumber, status, skipReason, resolvedConfig, outputData, scheduledAt, durationMs, errorMessage) {
  try {
    await db.query(
      `INSERT INTO sequence_step_log
       (enrollment_id, step_id, step_number, status, skip_reason,
        action_config_resolved, output_data, error_message,
        duration_ms, scheduled_at, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        enrollmentId,
        stepId,
        stepNumber,
        status,
        skipReason || null,
        resolvedConfig ? JSON.stringify(resolvedConfig) : null,
        outputData    ? JSON.stringify(outputData)      : null,
        errorMessage  || null,
        durationMs    || 0,
        scheduledAt   || null,
      ]
    );
  } catch (err) {
    // Log failure should never crash the step — just warn
    console.error(`[sequence] Failed to write step log for enrollment ${enrollmentId}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Shared helper: given a loaded template row, load steps, guard against
 * duplicates, create the enrollment row, and schedule the first step.
 *
 * Used by both enrollContact (type-cascade) and enrollContactByTemplateId
 * (direct-by-id). Template lookup and active-check are the callers' job —
 * this helper assumes `template` is the one we intend to enroll in.
 *
 * @private
 */
async function _enrollWithTemplate(db, contactId, template, triggerData) {
  // ── Load steps ──
  const [steps] = await db.query(
    `SELECT * FROM sequence_steps WHERE template_id = ?
     ORDER BY step_number ASC`,
    [template.id]
  );

  if (!steps.length) {
    throw new Error(`Sequence template "${template.name}" has no steps`);
  }

  // Parse JSON columns
  steps.forEach(s => {
    if (typeof s.timing       === 'string') s.timing       = JSON.parse(s.timing);
    if (typeof s.action_config=== 'string') s.action_config= JSON.parse(s.action_config);
    if (typeof s.condition    === 'string') s.condition    = JSON.parse(s.condition);
    if (typeof s.fire_guard   === 'string') s.fire_guard   = JSON.parse(s.fire_guard);
    if (typeof s.error_policy === 'string') s.error_policy = JSON.parse(s.error_policy);
  });

  // ── Guard: prevent duplicate active enrollments for same contact + template ──
  const [existing] = await db.query(
    `SELECT id FROM sequence_enrollments
     WHERE contact_id = ? AND template_id = ? AND status = 'active' LIMIT 1`,
    [contactId, template.id]
  );
  if (existing.length) {
    console.log(`[sequence] Contact ${contactId} already has active enrollment in "${template.name}" (id: ${existing[0].id}) — skipping duplicate`);
    throw new Error(`Contact ${contactId} is already enrolled in sequence "${template.name}"`);
  }

  // ── Create enrollment ──
  const [result] = await db.query(
    `INSERT INTO sequence_enrollments
     (template_id, contact_id, trigger_data, status, current_step, total_steps)
     VALUES (?, ?, ?, 'active', 1, ?)`,
    [template.id, contactId, JSON.stringify(triggerData), steps.length]
  );

  const enrollmentId = result.insertId;
  console.log(`[sequence] Enrolled contact ${contactId} in "${template.name}" (enrollment #${enrollmentId})`);

  // ── Schedule first step ──
  const firstStep   = steps[0];
  const scheduledAt = await calculateStepTime(firstStep.timing, triggerData, new Date());
  await scheduleStepJob(db, enrollmentId, firstStep, scheduledAt);

  return {
    enrollmentId,
    templateName:        template.name,
    totalSteps:          steps.length,
    firstJobScheduledAt: scheduledAt.toISOString(),
  };
}

/**
 * Enroll a contact in a sequence by explicit template ID.
 *
 * Unlike enrollContact, this bypasses type-cascade matching entirely —
 * the caller names the exact template. Useful for hook targets that
 * reference a specific ad-hoc template without needing a unique type.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {number} templateId
 * @param {object} triggerData   — context: { appt_id, appt_time, case_id, enrolled_by, ... }
 * @returns {{ enrollmentId, templateName, totalSteps, firstJobScheduledAt }}
 * @throws if template doesn't exist, is inactive, or has no steps
 */
async function enrollContactByTemplateId(db, contactId, templateId, triggerData = {}) {
  const [templates] = await db.query(
    `SELECT * FROM sequence_templates WHERE id = ? LIMIT 1`,
    [templateId]
  );

  if (!templates.length) {
    throw new Error(`Sequence template #${templateId} not found`);
  }

  const template = templates[0];

  if (!template.active) {
    throw new Error(`Sequence template #${templateId} is inactive`);
  }

  console.log(`[sequence] Enrolling by template ID → "${template.name}" (id: ${template.id})`);

  return _enrollWithTemplate(db, contactId, template, triggerData);
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

async function getJobScheduledAt(db, enrollmentId, stepNumber) {
  try {
    const [rows] = await db.query(
      `SELECT scheduled_time FROM scheduled_jobs
       WHERE sequence_enrollment_id = ?
         AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.stepNumber')) = ?
       ORDER BY id DESC LIMIT 1`,
      [enrollmentId, String(stepNumber)]
    );
    return rows[0]?.scheduled_time || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  enrollContact,
  enrollContactByTemplateId,
  executeStep,
  cancelSequences,
  // Exported for testing
  checkCondition,
  checkFireGuard,
  calculateStepTime,
  buildRefsForStep,
};