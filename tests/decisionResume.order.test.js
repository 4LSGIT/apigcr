/**
 * tests/decisionResume.order.test.js
 *
 * Decision-response ↔ engine-park ordering (2026-09-22, wf27 incident
 * review). The engine parks a pausing run atomically
 * (workflow_engine.parkWithResume: status='delayed' + resume-job INSERT in
 * one transaction, row lock held throughout). The decision response route
 * must therefore:
 *
 *   1. FLIP FIRST (UPDATE workflow_executions ... WHERE status='delayed') —
 *      it blocks on the park transaction's row lock, so by the time it
 *      returns the park is committed and its timeout-resume job is visible.
 *   2. DELETE the pending workflow_resume rows ONLY after winning the flip —
 *      with the old order (delete → flip), a response landing inside the
 *      park window deleted nothing, then won the flip after commit and left
 *      the timeout job alive to fire later and re-run the post-decision
 *      path. And an UNGATED delete on a lost flip could eat the
 *      self-continue job of a run that had already resumed, stranding it.
 *
 * Source-pinning test (same technique as versionPredicateCoverage.test.js):
 * the route is HTTP plumbing around three statements, and what matters — and
 * what a refactor would silently revert — is their ORDER and GATING.
 *
 * Run: npx jest tests/decisionResume.order.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'decisionActions.js'), 'utf8'
);

// The three statements, located by their distinctive fragments.
const flipIdx = src.indexOf(`WHERE id = ? AND status = 'delayed'`);
const deleteIdx = src.indexOf(`DELETE FROM scheduled_jobs`);
const gateIdx = src.indexOf(`flip.affectedRows === 1`);

describe('decision response resume ordering', () => {
  test('all three statements exist exactly once', () => {
    expect(flipIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(src.indexOf(`DELETE FROM scheduled_jobs`, deleteIdx + 1)).toBe(-1);
    expect(src.indexOf(`WHERE id = ? AND status = 'delayed'`, flipIdx + 1)).toBe(-1);
  });

  test('the guarded flip comes BEFORE the resume-job delete', () => {
    expect(flipIdx).toBeLessThan(deleteIdx);
  });

  test('the delete is gated on winning the flip', () => {
    // The affectedRows gate sits between the flip and the delete, and the
    // delete precedes the gated block's detached advanceWorkflow call.
    expect(gateIdx).toBeGreaterThan(flipIdx);
    expect(gateIdx).toBeLessThan(deleteIdx);
    const advanceIdx = src.indexOf('advanceWorkflow(row.workflow_execution_id', gateIdx);
    expect(advanceIdx).toBeGreaterThan(deleteIdx);
  });

  test('the value merge still precedes the flip (timeout boundary race branches on it)', () => {
    const mergeIdx = src.indexOf('mergeVariables(row.workflow_execution_id');
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeLessThan(flipIdx);
  });
});
