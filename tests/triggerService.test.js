// tests/triggerService.test.js
//
// Trigger System engine assertions (Review M6): the semantics the module
// headers claim, exercised against STUB mysql2 pools (pattern from
// tests/pipelineService.test.js) — no database needed.
//
// Covers:
//   - ALS loop-guard mechanics: runAsAction depth/chain nesting, counter
//     sharing, scope reset outside — and an END-TO-END two-rule loop
//     (hook actions re-emitting through a mocked hookService) that runs
//     until the depth cap and records a depth_capped row. This is the
//     guard's first executable evidence.
//   - _evaluateMatch fail-safe rulings via evaluateDraft (pure):
//     NULL match_config on conditions mode → NON-match (the regression that
//     would silently fire every rule on every event); throwing code → false.
//   - Transform failure → matched but actions skipped (status derivation
//     folds it in as a failure).
//   - vm code sandbox: while(true) is killed by the timeout (M7).
//   - Per-action failure isolation + M3 status derivation
//     (partial / error) + S12 early-insert-then-finalize ordering.
//   - buildEnvelope redaction (M2): contact_ssn / contact_token / *_token
//     pattern keys absent; '' case_id → null; Date → ISO.
//   - buildChanges date normalization.
//
// Run:
//   npx jest tests/triggerService.test.js

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

// Mocked hook engine: lets 'hook' actions succeed/fail/RE-EMIT without
// loading the real delivery machinery. Re-emission through here is how the
// end-to-end loop test drives the depth guard.
jest.mock('../services/hookService', () => ({
  executeHook: jest.fn(async () => ({ status: 'delivered', executionId: 1 })),
}));

const hookService    = require('../services/hookService');
const domainEvents   = require('../lib/domainEvents');
const triggerService = require('../services/triggerService');

// ─────────────────────────────────────────────────────────────
// Stub pool
// ─────────────────────────────────────────────────────────────
//
// Serves trigger_rules / trigger_rule_actions from a per-test fixture and
// records every trigger_executions INSERT/UPDATE (with a monotonically
// increasing insertId). Unknown SQL throws — the engine's alerting and
// metrics paths swallow their own failures, which this deliberately proves.

function makeDb(rulesByEvent) {
  const calls = [];
  let nextId = 100;
  // Split-phase dispatch (2026-08-30): emit() no longer runs the tree, it
  // writes a domain_event_queue row. The stub keeps those rows in memory so
  // a test can drain them and drive the engine exactly as production does.
  const queue = new Map();
  let nextQueueId = 1;
  const db = {
    calls,
    queue,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO domain_event_queue/.test(sql)) {
        const id = nextQueueId++;
        const [event_type, root_id, envelope] = params;
        queue.set(id, {
          id, event_type, root_id, envelope,
          status: 'pending', attempts: 0, dispatches: 0,
        });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /status = 'running'/.test(sql)) {
        const row = queue.get(params[0]);
        if (!row || row.status !== 'pending') return [{ affectedRows: 0 }];
        row.status = 'running';
        row.attempts++;
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /dispatches = dispatches \+/.test(sql)) {
        const row = queue.get(params[1]);
        if (row) row.dispatches += params[0];
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/UPDATE domain_event_queue/.test(sql)) {
        const row = queue.get(params[params.length - 1]);
        if (row) row.status = /'error'/.test(sql) ? 'error' : 'done';
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/SELECT dispatches FROM domain_event_queue/.test(sql)) {
        const row = queue.get(params[0]);
        return [row ? [{ dispatches: row.dispatches }] : []];
      }
      if (/FROM domain_event_queue/.test(sql) && /status = 'pending'/.test(sql)) {
        return [[...queue.values()].filter(r => r.status === 'pending').map(r => ({ id: r.id }))];
      }
      if (/FROM domain_event_queue/.test(sql)) {
        const row = queue.get(params[0]);
        return [row ? [{ ...row }] : []];
      }
      if (/FROM trigger_rules/.test(sql)) {
        return [(rulesByEvent[params[0]] || []).map(r => ({ ...r }))];
      }
      if (/FROM trigger_rule_actions/.test(sql)) {
        const rows = [];
        for (const ev of Object.keys(rulesByEvent)) {
          for (const r of rulesByEvent[ev]) {
            if (params.includes(r.id)) rows.push(...(r._actions || []));
          }
        }
        return [rows];
      }
      if (/INSERT INTO trigger_executions/.test(sql)) {
        return [{ insertId: nextId++, affectedRows: 1 }];
      }
      if (/INSERT INTO trigger_execution_rules/.test(sql)) {
        return [{ insertId: nextId++, affectedRows: 1 }];
      }
      if (/UPDATE trigger_executions/.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE trigger_rules/.test(sql)) {
        return [{ affectedRows: params.length }];
      }
      throw new Error('stub: unscripted SQL: ' + sql.slice(0, 60));
    },
  };
  return db;
}

/**
 * Drain the stub queue until it is empty, mirroring what the Cloud Tasks
 * doorbell + cron do in production. Bounded so a genuine runaway loop fails
 * the test loudly instead of hanging the suite.
 */
async function drainAll(db, maxPasses = 50) {
  const { drainBatch } = require('../lib/domainEventDrain');
  for (let i = 0; i < maxPasses; i++) {
    const out = await drainBatch(db);
    if (out.processed === 0) return;
  }
  throw new Error('drainAll: queue never emptied — runaway emission?');
}

const execInserts = (db) => db.calls.filter(c => /INSERT INTO trigger_executions/.test(c.sql));
const execUpdates = (db) => db.calls.filter(c => /UPDATE trigger_executions SET status/.test(c.sql));

const rule = (id, event, actions, over = {}) => ({
  id, event_type: event, name: `rule ${id}`,
  match_mode: 'conditions',
  match_config: { operator: 'and', conditions: [] },   // explicit always-match
  transform_mode: 'passthrough', transform_config: null,
  _actions: actions,
  ...over,
});
const hookAction = (id, ruleId) => ({
  id, rule_id: ruleId, name: null, action_type: 'hook',
  config: { slug: 'test-hook' }, position: 0,
});
const brokenAction = (id, ruleId) => ({
  id, rule_id: ruleId, name: null, action_type: 'internal_function',
  config: '{not json', position: 0,   // fails in _dispatchAction before any dispatcher loads
});

beforeEach(() => { hookService.executeHook.mockClear(); });

// ─────────────────────────────────────────────────────────────
// ALS scope mechanics
// ─────────────────────────────────────────────────────────────

test('runAsAction nests depth/chain and shares counters; scope resets outside', async () => {
  expect(domainEvents.buildEnvelope('x', {}).depth).toBe(0);
  await domainEvents.runAsAction(7, async () => {
    const env = domainEvents.buildEnvelope('appt.created', {});
    expect(env.depth).toBe(1);
    expect(env.chain).toEqual([7]);
    const outerCounters = domainEvents.currentCounters();
    await domainEvents.runAsAction(9, async () => {
      const env2 = domainEvents.buildEnvelope('appt.created', {});
      expect(env2.depth).toBe(2);
      expect(env2.chain).toEqual([7, 9]);
      // budget counters are the SAME object down the chain
      expect(domainEvents.currentCounters()).toBe(outerCounters);
    });
  });
  expect(domainEvents.buildEnvelope('x', {}).depth).toBe(0);
});

test('END-TO-END loop: two mutually-triggering rules stop at the depth cap', async () => {
  // PORTED for split-phase dispatch (2026-08-30). Previously emit() ran the
  // whole tree inline, so this test was a single await. Now emit() only
  // queues, and each level is drained in its own request — so the loop is
  // driven by draining until the queue empties. The ASSERTIONS are
  // unchanged, and that is the point: the depth cap must survive the split.
  // If it did not, this test would either loop forever (drainAll throws) or
  // stop producing the depth_capped row.
  const db = makeDb({
    'appt.created':  [rule(1, 'appt.created',  [hookAction(11, 1)])],
    'appt.attended': [rule(2, 'appt.attended', [hookAction(12, 2)])],
  });
  // The mocked hook RE-EMITS the sibling event — a deliberate A→B→A loop.
  hookService.executeHook.mockImplementation(async (dbArg, slug, wrapped) => {
    const ev = wrapped.body.event === 'appt.created' ? 'appt.attended' : 'appt.created';
    await domainEvents.emit(dbArg, ev, { contact_id: 1 });
    return { status: 'delivered', executionId: 1 };
  });

  await domainEvents.emit(db, 'appt.created', { contact_id: 1 });
  await drainAll(db);

  const depths = execInserts(db).map(c => c.params[3]);
  // depth 0..3 processed; the depth-4 emission is dropped as depth_capped
  expect(depths).toEqual([0, 1, 2, 3, 4]);
  const statuses = execInserts(db).map(c => c.params[4]);
  expect(statuses.slice(0, 4)).toEqual(['matched', 'matched', 'matched', 'matched']);
  expect(statuses[4]).toBe('depth_capped');
  // exactly MAX_DEPTH dispatches happened (one per processed level)
  expect(hookService.executeHook).toHaveBeenCalledTimes(4);
});

test('SPLIT-PHASE: emit() queues and evaluates NOTHING; the drain does the work', async () => {
  // Explicit: the suite's beforeEach only mockClear()s, so the loop test's
  // re-emitting implementation would otherwise leak in here.
  hookService.executeHook.mockImplementation(async () => ({ status: 'delivered', executionId: 1 }));
  const db = makeDb({ 'appt.created': [rule(1, 'appt.created', [hookAction(11, 1)])] });

  await domainEvents.emit(db, 'appt.created', { contact_id: 1 });

  // The whole point of the slice: no rule load, no execution row, no
  // dispatch happened in the (throttled) emit path.
  expect(db.calls.some(c => /FROM trigger_rules/.test(c.sql))).toBe(false);
  expect(execInserts(db)).toHaveLength(0);
  expect(hookService.executeHook).not.toHaveBeenCalled();

  // One durable row, carrying the envelope — the event cannot be lost now.
  expect(db.queue.size).toBe(1);
  const row = [...db.queue.values()][0];
  expect(row.status).toBe('pending');
  expect(row.root_id).toBeNull();              // root emission
  expect(JSON.parse(row.envelope).event).toBe('appt.created');

  await drainAll(db);

  expect(hookService.executeHook).toHaveBeenCalledTimes(1);
  expect(execInserts(db)).toHaveLength(1);
  expect([...db.queue.values()][0].status).toBe('done');
});

test('SPLIT-PHASE: nested emissions carry root_id, and the budget accumulates on the ROOT row', async () => {
  const db = makeDb({
    'appt.created':  [rule(1, 'appt.created',  [hookAction(11, 1)])],
    'appt.attended': [rule(2, 'appt.attended', [hookAction(12, 2)])],
  });
  hookService.executeHook.mockImplementation(async (dbArg, slug, wrapped) => {
    if (wrapped.body.event === 'appt.created') {
      await domainEvents.emit(dbArg, 'appt.attended', { contact_id: 1 });
    }
    return { status: 'delivered', executionId: 1 };
  });

  await domainEvents.emit(db, 'appt.created', { contact_id: 1 });
  await drainAll(db);

  const rows = [...db.queue.values()];
  expect(rows).toHaveLength(2);
  expect(rows[0].root_id).toBeNull();     // root
  expect(rows[1].root_id).toBe(rows[0].id); // child points at the root

  // Two dispatches across the tree, both counted on the ROOT row — this is
  // what keeps MAX_DISPATCHES_PER_ROOT a per-root budget once evaluation is
  // spread across requests. Reconstructing counters fresh per drain would
  // leave both rows at 1.
  expect(rows[0].dispatches).toBe(2);
  expect(rows[1].dispatches).toBe(0);
});

// ─────────────────────────────────────────────────────────────
// Match / transform fail-safe rulings (pure, via evaluateDraft)
// ─────────────────────────────────────────────────────────────

test('NULL match_config on conditions mode is NON-match, not match-all', () => {
  const out = triggerService.evaluateDraft(
    { match_mode: 'conditions', match_config: null }, { event: 'x' });
  expect(out.matched).toBe(false);
});

test('explicit empty conditions IS match-all; throwing code is non-match', () => {
  expect(triggerService.evaluateDraft(
    { match_mode: 'conditions', match_config: { operator: 'and', conditions: [] } },
    { event: 'x' }).matched).toBe(true);
  expect(triggerService.evaluateDraft(
    { match_mode: 'code', match_config: { code: 'return input.' } },   // SyntaxError
    { event: 'x' }).matched).toBe(false);
});

test('code sandbox: infinite loop is killed by the vm timeout (M7)', () => {
  const out = triggerService.evaluateDraft(
    { match_mode: 'conditions', match_config: { operator: 'and', conditions: [] },
      transform_mode: 'code', transform_config: { code: 'while(true){}' } },
    { event: 'x' });
  expect(out.matched).toBe(true);
  expect(out.transform_ok).toBe(false);
  expect(out.transform_error).toMatch(/timed out/i);
});

test('code sandbox has no process/require reach', () => {
  const out = triggerService.evaluateDraft(
    { match_mode: 'code', match_config: { code: 'return typeof process === "undefined" && typeof require === "undefined";' } },
    { event: 'x' });
  expect(out.matched).toBe(true);
});

// ─────────────────────────────────────────────────────────────
// M3 status derivation + isolation + S12 ordering
// ─────────────────────────────────────────────────────────────

test('all actions failing → error status; failure does not abort later rules', async () => {
  const db = makeDb({
    'appt.created': [
      rule(1, 'appt.created', [brokenAction(11, 1)]),
      rule(2, 'appt.created', [hookAction(12, 2)], { name: 'healthy sibling' }),
    ],
  });
  const out = await triggerService.processEvent(
    db, domainEvents.buildEnvelope('appt.created', { contact_id: 1 }));
  // broken rule 1 did not stop rule 2's action
  expect(hookService.executeHook).toHaveBeenCalledTimes(1);
  expect(out.status).toBe('partial');   // one failed + one succeeded
  const upd = execUpdates(db);
  expect(upd.length).toBe(1);
  expect(upd[0].params[0]).toBe('partial');
  expect(String(upd[0].params[2])).toMatch(/rule 1 internal_function/);
});

test('every action failing → error; transform failure counts as a failure', async () => {
  const db = makeDb({
    'appt.created': [
      rule(1, 'appt.created', [brokenAction(11, 1)]),
      rule(2, 'appt.created', [], {
        transform_mode: 'code', transform_config: { code: 'return 5;' },  // non-object → fail
      }),
    ],
  });
  const out = await triggerService.processEvent(
    db, domainEvents.buildEnvelope('appt.created', {}));
  expect(out.status).toBe('error');
  expect(out.warnings.some(w => /transform failed/.test(w))).toBe(true);
});

test('S12: the execution row is inserted BEFORE actions dispatch', async () => {
  const db = makeDb({ 'appt.created': [rule(1, 'appt.created', [hookAction(11, 1)])] });
  let insertSeenBeforeDispatch = false;
  hookService.executeHook.mockImplementation(async () => {
    insertSeenBeforeDispatch = execInserts(db).length === 1;
    return { status: 'delivered', executionId: 1 };
  });
  await triggerService.processEvent(db, domainEvents.buildEnvelope('appt.created', {}));
  expect(insertSeenBeforeDispatch).toBe(true);
  expect(execUpdates(db).length).toBe(1);   // finalized after
});

// ─────────────────────────────────────────────────────────────
// R4/S6 cooldown + R4/P1 per-rule audit rows
// ─────────────────────────────────────────────────────────────

const auditInserts = (db) => db.calls.filter(c => /INSERT INTO trigger_execution_rules/.test(c.sql));
const metricBumps  = (db) => db.calls.filter(c => /UPDATE trigger_rules\s+SET match_count/.test(c.sql));

test('S6: a cooling-down rule does NOT match — no actions, no metrics bump, warning recorded', async () => {
  // cooling_down / secs_since_match are computed by SQL in the real loader;
  // the stub returns whatever the fixture carries.
  const db = makeDb({
    'appt.created': [rule(1, 'appt.created', [hookAction(11, 1)], {
      min_interval_s: 300, cooling_down: 1, secs_since_match: 42,
    })],
  });
  const out = await triggerService.processEvent(db, domainEvents.buildEnvelope('appt.created', {}));

  expect(out.status).toBe('no_match');
  expect(out.matchedRuleIds).toEqual([]);
  expect(hookService.executeHook).not.toHaveBeenCalled();
  // Suppression must not re-arm the window, or a rule under load never fires.
  expect(metricBumps(db).length).toBe(0);
  expect(out.warnings.join(' ')).toMatch(/skipped_cooldown/);
  expect(out.warnings.join(' ')).toMatch(/rule 1 \(rule 1\)/);   // names the rule
  // Nothing matched → nothing to audit.
  expect(auditInserts(db).length).toBe(0);
});

test('S6: cooldown 0 / not cooling is the untouched default path', async () => {
  const db = makeDb({
    'appt.created': [rule(1, 'appt.created', [hookAction(11, 1)], {
      min_interval_s: 0, cooling_down: 0, secs_since_match: null,
    })],
  });
  const out = await triggerService.processEvent(db, domainEvents.buildEnvelope('appt.created', {}));
  expect(out.status).toBe('matched');
  expect(hookService.executeHook).toHaveBeenCalledTimes(1);
});

test('P1: one audit row per matched rule, with action/failed tallies', async () => {
  // rule 1: two actions, one of which fails → 2 actions / 1 failed
  // rule 2: transform blows up → 0 actions / 1 failed (it was meant to act)
  const db = makeDb({
    'appt.created': [
      rule(1, 'appt.created', [hookAction(11, 1), brokenAction(12, 1)]),
      rule(2, 'appt.created', [hookAction(21, 2)], {
        transform_mode: 'code',
        transform_config: { code: 'throw new Error("nope");' },
      }),
    ],
  });
  await triggerService.processEvent(db, domainEvents.buildEnvelope('appt.created', {}));

  const ins = auditInserts(db);
  expect(ins.length).toBe(1);              // ONE batched INSERT, not one per rule
  const p = ins[0].params;
  // (execution_id, rule_id, rule_name, action_count, failed_count) × 2
  expect(p.length).toBe(10);
  expect(p.slice(1, 5)).toEqual([1, 'rule 1', 2, 1]);
  expect(p.slice(6, 10)).toEqual([2, 'rule 2', 0, 1]);
  expect(p[0]).toBe(p[5]);                 // same parent execution
});

test('P1: audit insert failure never disturbs the engine', async () => {
  const db = makeDb({ 'appt.created': [rule(1, 'appt.created', [hookAction(11, 1)])] });
  const inner = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/INSERT INTO trigger_execution_rules/.test(sql)) throw new Error('table missing');
    return inner(sql, params);
  };
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const out = await triggerService.processEvent(db, domainEvents.buildEnvelope('appt.created', {}));
  spy.mockRestore();
  expect(out.status).toBe('matched');       // the real work still reports success
  expect(hookService.executeHook).toHaveBeenCalledTimes(1);
});

// ─────────────────────────────────────────────────────────────
// buildEnvelope redaction (M2) + shaping
// ─────────────────────────────────────────────────────────────

test('buildEnvelope redacts secrets, normalizes case_id, serializes Dates', () => {
  const env = domainEvents.buildEnvelope('contact.updated', {
    case_id: '',
    data: {
      contact_ssn: '123-45-6789',
      contact_token: 'deadbeef',
      portal_session_version: 3,
      zoho_api_key: 'k',                     // pattern-caught
      contact_name: "O'Brien",               // the M1 payload precondition survives as DATA
      contact_dob: new Date('1980-05-02T00:00:00.000Z'),
    },
    changes: { contact_token: { from: 'a', to: 'b' }, contact_tags: { from: 'x', to: 'y' } },
  });
  expect(env.case_id).toBeNull();
  expect(env.data.contact_ssn).toBeUndefined();
  expect(env.data.contact_token).toBeUndefined();
  expect(env.data.portal_session_version).toBeUndefined();
  expect(env.data.zoho_api_key).toBeUndefined();
  expect(env.data.contact_name).toBe("O'Brien");
  expect(env.data.contact_dob).toBe('1980-05-02T00:00:00.000Z');
  expect(env.changes.contact_token).toBeUndefined();
  expect(env.changes.contact_tags).toEqual({ from: 'x', to: 'y' });
});

test('buildChanges: unchanged dates are not flagged; text with T survives', () => {
  const prior = {
    docs_due:   new Date('2026-08-01T00:00:00.000Z'),
    show_cause: new Date('2026-08-05T14:30:00.000Z'),
    case_notes: 'Tuesday call',
  };
  const next = {
    docs_due:   '2026-08-01',
    show_cause: '2026-08-05 14:30:00',
    case_notes: 'Tuesday call updated',
  };
  const ch = domainEvents.buildChanges(prior, next, Object.keys(next));
  expect(Object.keys(ch)).toEqual(['case_notes']);
});