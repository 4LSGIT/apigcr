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

  // Resolve :param placeholders from trigger_data using dot-path
  const resolvedParams = [];
  let resolvedQuery    = query;

  for (const [placeholder, sourcePath] of Object.entries(paramMap)) {
    const value = getNestedValue(triggerData, sourcePath.replace('trigger_data.', ''));
    if (value === undefined || value === null) {
      console.warn(`[sequenceEngine] Condition param :${placeholder} resolved to null (path: ${sourcePath})`);
    }
    // Replace :placeholder with ? and push value
    resolvedQuery = resolvedQuery.replace(`:${placeholder}`, '?');
    resolvedParams.push(value ?? null);
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
    });
  }

  if (timing.type === 'business_days') {
    // N business days from now — walk forward N times
    let current = from;
    for (let i = 0; i < (timing.value || 1); i++) {
      current = await calendar.nextBusinessDay(current, {
        timeOfDay:        timing.timeOfDay        || '09:00',
        randomizeMinutes: timing.randomizeMinutes || 0,
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

    const result = await calendar.prevBusinessDay(new Date(apptTime), attempts, {
      minHoursBefore: timing.minHoursBefore || 1,
      maxDaysBack:    timing.maxDaysBack     || 14,
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
 */
function buildRefsForStep(triggerData, contactId) {
  const refs = {
    contacts: { contact_id: contactId }
  };

  if (triggerData?.appt_id)  refs.appts = { appt_id: triggerData.appt_id };
  if (triggerData?.case_id)  refs.cases = { case_id: triggerData.case_id };
  if (triggerData?.task_id)  refs.tasks = { task_id: triggerData.task_id };

  return refs;
}

// ─────────────────────────────────────────────────────────────
// enrollContact
// ─────────────────────────────────────────────────────────────

/**
 * Enroll a contact in a sequence.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} templateType   — e.g. 'no_show', 'lead_drip'
 * @param {object} triggerData    — context: { appt_id, appt_time, case_id, enrolled_by, ... }
 * @returns {{ enrollmentId, templateName, totalSteps, firstJobScheduledAt }}
 */
async function enrollContact(db, contactId, templateType, triggerData = {}) {
  // Load template
  const [templates] = await db.query(
    `SELECT * FROM sequence_templates WHERE type = ? AND active = 1 LIMIT 1`,
    [templateType]
  );

  if (!templates.length) {
    throw new Error(`No active sequence template found for type: ${templateType}`);
  }

  const template = templates[0];

  // Load steps
  const [steps] = await db.query(
    `SELECT * FROM sequence_steps WHERE template_id = ? ORDER BY step_number ASC`,
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

  // Create enrollment
  const [result] = await db.query(
    `INSERT INTO sequence_enrollments
     (template_id, contact_id, trigger_data, status, current_step, total_steps)
     VALUES (?, ?, ?, 'active', 1, ?)`,
    [template.id, contactId, JSON.stringify(triggerData), steps.length]
  );

  const enrollmentId = result.insertId;
  console.log(`[sequence] Enrolled contact ${contactId} in "${template.name}" (enrollment #${enrollmentId})`);

  // Schedule first step
  const firstStep         = steps[0];
  const scheduledAt       = await calculateStepTime(firstStep.timing, triggerData, new Date());
  await scheduleStepJob(db, enrollmentId, firstStep, scheduledAt);

  return {
    enrollmentId,
    templateName:         template.name,
    totalSteps:           steps.length,
    firstJobScheduledAt:  scheduledAt.toISOString(),
  };
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
      rawResult = await executeJob({ data: resolvedConfig }, db);
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

  // Update enrollment current_step
  await db.query(
    `UPDATE sequence_enrollments SET current_step = ?, updated_at = NOW() WHERE id = ?`,
    [completedStep.step_number + 1, enrollment.id]
  );

  if (!nextSteps.length) {
    // No more steps — complete enrollment
    await db.query(
      `UPDATE sequence_enrollments
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [enrollment.id]
    );
    console.log(`[sequence] Enrollment ${enrollment.id} completed`);
    return null;
  }

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

  // Delete pending scheduled jobs for these enrollments
  const [deleteResult] = await db.query(
    `DELETE FROM scheduled_jobs
     WHERE sequence_enrollment_id IN (?)
       AND status IN ('pending', 'running')`,
    [ids]
  );

  console.log(`[sequence] Cancelled ${ids.length} enrollment(s) for contact ${contactId} (type: ${templateType || 'all'}, reason: ${reason}). Deleted ${deleteResult.affectedRows} pending jobs.`);

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
    `DELETE FROM scheduled_jobs
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
  executeStep,
  cancelSequences,
  // Exported for testing
  checkCondition,
  checkFireGuard,
  calculateStepTime,
  buildRefsForStep,
};