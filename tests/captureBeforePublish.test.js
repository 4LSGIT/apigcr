/**
 * tests/captureBeforePublish.test.js
 *
 * Capture-before-publish slice (2026-09-03).
 *
 * The bug this locks shut: every workflow-execution creation site refused a
 * never-published (current_version = 0) or inactive target BEFORE running the
 * capture block, so arming capture on a brand-new workflow recorded nothing.
 * That is a deadlock, not an inconvenience — you arm capture precisely because
 * you don't yet know the payload's shape, and you can't publish a workflow you
 * can't author. Live evidence: hook_delivery_logs 10672 (target 40 → wf48)
 * logged "workflow #48 has never been published" while wf48 sat armed
 * 'intercept' with captured_input NULL.
 *
 * WHAT IS LOCKED SHUT
 *   1. A refused start captures FIRST, for both armed modes — 'intercept'
 *      degrades to a tap because a refused start creates no execution to hold.
 *   2. A refused start does NOT create an execution (the refusal still holds).
 *   3. The hook dispatcher logs the refused-but-captured delivery as
 *      'captured' (log_status), NOT 'failed', and reports control-flow
 *      'success' so hookService does not queue a retry ladder against a
 *      workflow that cannot run until someone publishes it.
 *   4. A refused start with capture DISARMED still fails exactly as before.
 *   5. On a RUNNING start, ingress capture stays 'capturing'-only —
 *      'intercept' must survive to the step-0 hold in advanceWorkflow.
 *   6. The captured sample seeds test_input only when the workflow is
 *      unpublished AND test_input is still NULL.
 *
 * Run: npx jest tests/captureBeforePublish.test.js
 */

'use strict';

const { captureRefusedStart, captureWorkflowInput } = require('../lib/workflow_engine');
const { dispatchWorkflow } = require('../lib/actionDispatchers');

// Matcher-based recording stub: each rule is [regex, handler]. Unmatched
// queries throw, so a new query in the path under test fails loudly here
// instead of silently returning undefined.
function makeDb(rules) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [re, handler] of rules) {
        if (re.test(sql)) return handler(params, sql);
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 120)}`);
    },
  };
}

const WF_ID = 48;

// The workflow row the dispatcher reads before deciding anything.
function wfRow({ active = 1, capture_mode = 'off', current_version = 0 } = {}) {
  return { active, capture_mode, current_version, default_contact_id_from: null };
}

// Standard rule set: SELECT returns `row`, the guarded capture UPDATE reports
// whether it won, the test_input seed reports whether it applied, and any
// INSERT is recorded (its presence is itself a failure in the refused cases).
function rulesFor(row, { captureWins = true, seedWins = true } = {}) {
  return [
    [/SELECT .*FROM workflows/i, () => [[row]]],
    [/UPDATE workflows[\s\S]*captured_input/i, () => [{ affectedRows: captureWins ? 1 : 0 }]],
    [/UPDATE workflows[\s\S]*test_input/i, () => [{ affectedRows: seedWins ? 1 : 0 }]],
    [/INSERT INTO workflow_executions/i, () => [{ insertId: 1 }]],
    [/INSERT INTO scheduled_jobs|INSERT INTO jobs/i, () => [{ insertId: 2 }]],
  ];
}

const target = { id: 40, name: 'Jotform → wf48' };
const INIT = { form_id: 'abc', answers: { name: 'Ada' } };

describe('captureRefusedStart', () => {
  test('answers to BOTH armed modes (intercept degrades to a tap)', async () => {
    const db = makeDb(rulesFor(wfRow()));
    const won = await captureRefusedStart(db, WF_ID, INIT);

    expect(won).toBe(true);
    const cap = db.queries.find((q) => /captured_input/.test(q.sql));
    expect(cap).toBeDefined();
    // The guard must accept 'capturing' AND 'intercept' — the whole point.
    expect(cap.params[2]).toEqual(['capturing', 'intercept']);
    expect(JSON.parse(cap.params[0])).toEqual(INIT);
  });

  test('seeds test_input, guarded to unpublished + still-NULL', async () => {
    const db = makeDb(rulesFor(wfRow()));
    await captureRefusedStart(db, WF_ID, INIT);

    const seed = db.queries.find((q) => /SET\s+test_input/.test(q.sql));
    expect(seed).toBeDefined();
    expect(JSON.parse(seed.params[0])).toEqual(INIT);
    expect(seed.sql).toMatch(/test_input IS NULL/);
    expect(seed.sql).toMatch(/current_version = 0/);
  });

  test('losing the arm-once race skips the seed entirely', async () => {
    const db = makeDb(rulesFor(wfRow(), { captureWins: false }));
    const won = await captureRefusedStart(db, WF_ID, INIT);

    expect(won).toBe(false);
    expect(db.queries.some((q) => /SET\s+test_input/.test(q.sql))).toBe(false);
  });

  test('a capture failure never propagates', async () => {
    const db = {
      async query(sql) {
        if (/captured_input/.test(sql)) throw new Error('deadlock');
        return [[{}]];
      },
    };
    await expect(captureRefusedStart(db, WF_ID, INIT)).resolves.toBe(false);
  });
});

describe('captureWorkflowInput on the RUNNING path', () => {
  test("defaults to 'capturing' only, so intercept survives to step 0", async () => {
    const db = makeDb(rulesFor(wfRow()));
    await captureWorkflowInput(db, WF_ID, INIT);

    const cap = db.queries.find((q) => /captured_input/.test(q.sql));
    expect(cap.params[2]).toEqual(['capturing']);
  });
});

describe('hook → workflow delivery against an unpublishable target', () => {
  test('captures, does not start, and logs "captured" rather than "failed"', async () => {
    const db = makeDb(rulesFor(wfRow({ capture_mode: 'intercept' })));
    const log = await dispatchWorkflow(target, { workflow_id: WF_ID }, INIT, db);

    // Captured...
    const cap = db.queries.find((q) => /captured_input/.test(q.sql));
    expect(cap).toBeDefined();
    expect(JSON.parse(cap.params[0])).toEqual(INIT);

    // ...but emphatically not started.
    expect(db.queries.some((q) => /INSERT INTO workflow_executions/i.test(q.sql))).toBe(false);

    // Logged as the authoring step it is; 'success' keeps the retry ladder off.
    expect(log.log_status).toBe('captured');
    expect(log.status).toBe('success');
    expect(log.response_status).toBe(202);
    expect(log.error).toBeUndefined();
    expect(log.response_body).toMatch(/never been published/);
  });

  test('inactive targets capture too', async () => {
    const db = makeDb(rulesFor(wfRow({ active: 0, current_version: 3, capture_mode: 'capturing' })));
    const log = await dispatchWorkflow(target, { workflow_id: WF_ID }, INIT, db);

    expect(db.queries.some((q) => /captured_input/.test(q.sql))).toBe(true);
    expect(log.log_status).toBe('captured');
    expect(log.response_body).toMatch(/is inactive/);
  });

  test('with capture disarmed the refusal is unchanged', async () => {
    const db = makeDb(rulesFor(wfRow({ capture_mode: 'off' }), { captureWins: false }));
    const log = await dispatchWorkflow(target, { workflow_id: WF_ID }, INIT, db);

    expect(log.status).toBe('failed');
    expect(log.response_status).toBe(409);
    expect(log.error).toBe(`workflow #${WF_ID} has never been published`);
    expect(log.log_status).toBeUndefined();
    expect(db.queries.some((q) => /INSERT INTO workflow_executions/i.test(q.sql))).toBe(false);
  });
});
