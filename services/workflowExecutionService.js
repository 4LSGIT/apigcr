// services/workflowExecutionService.js
//
/**
 * Workflow execution lifecycle operations that more than one surface needs.
 *
 * cancelWorkflowExecution — extracted from POST /executions/:id/cancel
 * (routes/workflows.js) for the CTA arc (ref/CTA_DESIGN.md §4, R7), so the
 * route and the cancel_workflow_execution internal function share ONE
 * implementation. Same transaction span, same cascade, same post-commit
 * task dismissal as the route had inline.
 *
 * One deliberate behavior change vs the inline route (R7): the status UPDATE
 * is now GUARDED on the cancellable set. The route's existence check is a
 * plain SELECT (no FOR UPDATE), so an execution that completed between that
 * SELECT and the UPDATE used to be overwritten 'completed' → 'cancelled'.
 * Now that race reports "not cancellable" (the route's existing 400), and
 * nothing else in the cascade runs.
 */

'use strict';

/** Statuses a cancel may act on. Mirrors the route's original SELECT. */
const CANCELLABLE_STATUSES = Object.freeze(['active', 'processing', 'delayed', 'held']);
const REASON_MIN = 3;
const REASON_MAX = 500;   // workflow_executions.cancel_reason is varchar(500)

/**
 * Normalize a cancel reason exactly as the route always has: must be a
 * string, ≥3 chars after trim; truncated (not refused) to the 500-char
 * column. Returns { reason } or { error }.
 */
function normalizeCancelReason(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length < REASON_MIN) {
    return { error: `reason is required and must be at least ${REASON_MIN} characters after trim` };
  }
  return { reason: s.length > REASON_MAX ? s.slice(0, REASON_MAX) : s };
}

/**
 * Cancel a workflow execution.
 *
 * @param {object} db           promise pool (needs .withTransaction)
 * @param {number} executionId  positive integer (caller validates)
 * @param {string} reason       already normalized (normalizeCancelReason)
 * @param {object} [opts]
 * @param {string} [opts.by='user']  log label only
 * @returns {Promise<{cancelled:false} |
 *   {cancelled:true, executionId:number, cancel_reason:string, decisionsCancelled:number}>}
 *
 * Side effects (in one transaction):
 *   - workflow_executions: status → 'cancelled', cancel_reason, updated_at +
 *     completed_at = NOW() — guarded on CANCELLABLE_STATUSES
 *   - scheduled_jobs: pending/running 'workflow_resume' rows for the
 *     execution are DELETED (legacy behavior; cancelled resumes have no
 *     audit value)
 *   - decision_requests: pending rows → 'cancelled'
 * Post-commit, best-effort: paired decision tasks dismissed via
 * taskService.deleteTask (it writes its own log rows + side effects — kept
 * off the transaction).
 */
async function cancelWorkflowExecution(db, executionId, reason, { by = 'user' } = {}) {
  const outcome = await db.withTransaction(async (connection) => {

    // Verify execution exists and is still cancellable.
    const [execRows] = await connection.query(
      `
      SELECT status
      FROM workflow_executions
      WHERE id = ?
        AND status IN ('active', 'processing', 'delayed', 'held')
      `,
      [executionId]
    );

    if (execRows.length === 0) {
      return { cancelled: false };
    }

    // Mark as cancelled (with reason). Status-guarded (R7): a run that
    // finished after the SELECT above must not be overwritten.
    const [upd] = await connection.query(
      `
      UPDATE workflow_executions
      SET status        = 'cancelled',
          cancel_reason = ?,
          updated_at    = NOW(),
          completed_at  = NOW()
      WHERE id = ?
        AND status IN ('active', 'processing', 'delayed', 'held')
      `,
      [reason, executionId]
    );
    if (!upd || !upd.affectedRows) {
      return { cancelled: false };
    }

    // Delete any pending resume jobs for this execution.
    await connection.query(
      `
      DELETE FROM scheduled_jobs
      WHERE type = 'workflow_resume'
        AND workflow_execution_id = ?
        AND status IN ('pending', 'running')
      `,
      [executionId]
    );

    // Decision cascade (HITL slice): close any pending decision_requests so
    // their links render "no longer needed" instead of resuming a cancelled
    // execution. Paired tasks are dismissed post-commit (taskService writes
    // its own log rows + side effects — keep those off this transaction).
    const [pendingDecisions] = await connection.query(
      `SELECT id, paired_task_id FROM decision_requests
        WHERE workflow_execution_id = ? AND status = 'pending'`,
      [executionId]
    );
    if (pendingDecisions.length > 0) {
      await connection.query(
        `UPDATE decision_requests SET status = 'cancelled', updated_at = NOW()
          WHERE workflow_execution_id = ? AND status = 'pending'`,
        [executionId]
      );
    }

    return { cancelled: true, pendingDecisions };
  });

  if (!outcome.cancelled) return { cancelled: false };

  // Post-commit, best-effort: dismiss paired tasks for cancelled decisions.
  for (const d of (outcome.pendingDecisions || [])) {
    if (!d.paired_task_id) continue;
    try {
      await require('./taskService').deleteTask(
        db, d.paired_task_id, 0, { via: 'workflow_cancelled' }
      );
    } catch (taskErr) {
      // Already completed/deleted races are fine.
      console.warn(`[CANCEL] Could not dismiss decision task ${d.paired_task_id}:`, taskErr.message);
    }
  }

  console.log(`[CANCEL] Execution ${executionId} cancelled by ${by} — reason: ${reason}`);

  return {
    cancelled: true,
    executionId,
    cancel_reason: reason,
    decisionsCancelled: outcome.pendingDecisions.length,
  };
}

module.exports = {
  cancelWorkflowExecution,
  normalizeCancelReason,
  CANCELLABLE_STATUSES,
};
