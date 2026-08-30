/**
 * tests/triggerService.matchFailure.test.js
 *
 * T9/GAP-1 — when a trigger rule cannot be EVALUATED (as distinct from
 * evaluating to false), the engine must leave a countable, alertable trace.
 *
 * THE BUG THIS LOCKS SHUT: services/triggerService._evaluateMatch returned a
 * bare boolean, and four distinct failure modes all collapsed into `false`:
 *   - match_config that is not parseable JSON
 *   - a conditions evaluation that throws
 *   - a code-mode sandbox that throws
 *   - an unknown match_mode
 * Each console.warn'd and returned false, so processEvent's
 * `if (!_evaluateMatch(...)) continue;` skipped the rule with no signal. The
 * execution row then read `no_match` — green — with nothing in
 * `outcomes.warnings` and NULL in `error`. An ACTIVE rule that could not run
 * at all was indistinguishable from a rule that honestly did not match, and
 * left no queryable trace anywhere in the database.
 *
 * That is the T2/F-3/F-8 shape in a fourth file: a failure occurring OUTSIDE
 * the per-action loop produces no outcome entry. Note the asymmetry it
 * created inside one function — a failed TRANSFORM was a warning, a counted
 * failure, and an alert; a failed MATCH was a line on stderr.
 *
 * WHAT IS ASSERTED
 *   - all four failure modes produce exactly ONE warning naming the rule
 *   - and exactly ONE 'trigger_match_failed' alert per rule
 *   - and an error_count bump on that rule (UPDATE trigger_rules ... error_count)
 *   - FAIL-SAFE UNCHANGED: matched stays false, the rule's actions never fire
 *   - STATUS UNCHANGED: an unevaluatable rule does NOT make the execution
 *     `partial`/`error`. `partial` means "actions of a MATCHED rule failed";
 *     a rule that never got evaluated never matched, so folding it in would
 *     corrupt what the status column means. This is the deliberate divergence
 *     from the transform-failure path, which DOES count toward failures.
 *   - NULL match_config on conditions mode is EXCLUDED — that ruling is a
 *     documented deliberate non-match (authored-but-inert), not a runtime
 *     break, and alerting on it would fire on every event for a state the
 *     author chose.
 *   - the alert's dedup_key is date-bucketed per rule, so a permanently
 *     corrupt rule (which fails on EVERY event of its type) inserts one row
 *     per day rather than thousands
 *   - the dry-run / draft surfaces carry `match_error` so an author testing a
 *     rule they just broke is told why, instead of hunting the envelope
 *
 * Run: npx jest tests/triggerService.matchFailure.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

// Capture alerts instead of letting them hit the stub pool. The sibling suite
// (tests/triggerService.test.js) deliberately does NOT mock alerting — it
// proves the engine swallows its own alerting failures. This file needs the
// opposite: to see what was raised.
jest.mock('../lib/alerting', () => ({
  alert: jest.fn(() => Promise.resolve()),
}));

// Hook engine mocked so a 'hook' action can be observed without loading the
// real delivery machinery.
jest.mock('../services/hookService', () => ({
  executeHook: jest.fn(async () => ({ status: 'delivered', executionId: 1 })),
}));

const { alert }      = require('../lib/alerting');
const hookService    = require('../services/hookService');
const triggerService = require('../services/triggerService');
const domainEvents   = require('../lib/domainEvents');

// ─────────────────────────────────────────────────────────────
// Stub pool — matcher-based (no ordered script; see
// tests/helpers/scriptGuard.js for why ordered scripts are guarded).
// ─────────────────────────────────────────────────────────────

function makeDb(rulesByEvent) {
  const calls = [];
  let nextId = 500;
  let queueRow = null;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
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
      if (/INSERT INTO trigger_execution/.test(sql)) {
        return [{ insertId: nextId++, affectedRows: 1 }];
      }
      // Split-phase dispatch: emit() writes here instead of evaluating.
      // Single-row queue is enough for this suite — it drains by id.
      if (/INSERT INTO domain_event_queue/.test(sql)) {
        queueRow = {
          id: 1, event_type: params[0], root_id: params[1], envelope: params[2],
          status: 'pending', attempts: 0, dispatches: 0,
        };
        return [{ insertId: 1, affectedRows: 1 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /status = 'running'/.test(sql)) {
        if (!queueRow || queueRow.status !== 'pending') return [{ affectedRows: 0 }];
        queueRow.status = 'running';
        queueRow.attempts++;
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE domain_event_queue/.test(sql)) return [{ affectedRows: 1 }];
      if (/SELECT dispatches FROM domain_event_queue/.test(sql)) {
        return [queueRow ? [{ dispatches: queueRow.dispatches }] : []];
      }
      if (/FROM domain_event_queue/.test(sql)) {
        return [queueRow ? [{ ...queueRow }] : []];
      }
      if (/UPDATE trigger_executions/.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE trigger_rules/.test(sql))      return [{ affectedRows: params.length }];
      throw new Error('stub: unscripted SQL: ' + sql.slice(0, 60));
    },
  };
}

const envelope = (over = {}) => ({
  event: 'appt.created', ts: new Date().toISOString(), depth: 0, chain: [],
  source: 'system', actor: null, contact_id: 7, case_id: 'AbCd1234',
  data: {}, changes: null, extra: null, ...over,
});

const hookAction = (id, ruleId) => ({
  id, rule_id: ruleId, name: null, action_type: 'hook',
  config: { slug: 'test-hook' }, position: 0,
});

const rule = (id, over = {}) => ({
  id, event_type: 'appt.created', name: `rule ${id}`,
  match_mode: 'conditions',
  match_config: { operator: 'and', conditions: [] },   // explicit always-match
  transform_mode: 'passthrough', transform_config: null,
  min_interval_s: 0, cooling_down: 0, secs_since_match: null,
  _actions: [hookAction(id * 10, id)],
  ...over,
});

// The four modes that are genuinely BROKEN at runtime.
const BROKEN = [
  ['unparseable match_config',
   { match_mode: 'conditions', match_config: '{not json' },
   /not parseable JSON/],
  ['conditions evaluation throws',
   { match_mode: 'conditions', match_config: { operator: 'and', conditions: [{ get bad() { throw new Error('boom'); } }] } },
   /conditions evaluation threw/],
  ['code sandbox throws',
   { match_mode: 'code', match_config: { code: 'throw new Error("nope");' } },
   /match code threw/],
  ['unknown match_mode',
   { match_mode: 'regex', match_config: { operator: 'and', conditions: [] } },
   /unknown match_mode/],
];

const execInserts = (db) => db.calls.filter(c => /INSERT INTO trigger_executions/.test(c.sql));
const execUpdates = (db) => db.calls.filter(c => /UPDATE trigger_executions SET status/.test(c.sql));
const ruleErrBumps = (db) => db.calls.filter(c => /UPDATE trigger_rules[\s\S]*error_count/.test(c.sql));
const matchAlerts  = () => alert.mock.calls
  .map(c => c[1])
  .filter(o => o && o.kind === 'trigger_match_failed');

beforeEach(() => {
  alert.mockClear();
  hookService.executeHook.mockClear();
});

// ─────────────────────────────────────────────────────────────
// One failure → exactly one of each artifact
// ─────────────────────────────────────────────────────────────

describe.each(BROKEN)('broken rule: %s', (label, over, errRe) => {
  test('yields exactly one warning, one alert, and one error_count bump', async () => {
    const db = makeDb({ 'appt.created': [rule(1, over)] });
    const res = await triggerService.processEvent(db, envelope());

    // ── countable: the warning rides outcomes, which the execution row carries
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^rule 1 \(rule 1\) match failed: /);
    expect(res.warnings[0]).toMatch(errRe);
    expect(res.warnings[0]).toMatch(/rule did not run$/);
    expect(res.failedMatchRuleIds).toEqual([1]);

    // ── countable: the rule's own error metric moved
    expect(ruleErrBumps(db)).toHaveLength(1);
    expect(ruleErrBumps(db)[0].params).toEqual([1]);

    // ── alertable: exactly one, correctly shaped
    const alerts = matchAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: 'app', kind: 'trigger_match_failed', severity: 'warning',
      group_key: 'trigger_rule_1',
    });
    expect(alerts[0].title).toContain('could not be evaluated');
    expect(alerts[0].message).toMatch(errRe);
    expect(alerts[0].context).toMatchObject({ rule_id: 1, event: 'appt.created' });

    // ── FAIL-SAFE: the broken rule fired nothing
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(res.matchedRuleIds).toEqual([]);
  });

  test('status stays no_match — a rule that never matched cannot make it partial', async () => {
    const db = makeDb({ 'appt.created': [rule(1, over)] });
    const res = await triggerService.processEvent(db, envelope());

    expect(res.status).toBe('no_match');
    // The provisional insert and the finalize agree; neither invents a failure
    // status for a rule that was never evaluated.
    expect(execInserts(db)).toHaveLength(1);
    const finalize = execUpdates(db);
    expect(finalize).toHaveLength(1);
    expect(finalize[0].params[0]).toBe('no_match');
    expect(finalize[0].params[2]).toBeNull();      // error summary untouched

    // ...but the warning IS in the persisted outcomes, so the row is countable.
    const outcomes = JSON.parse(finalize[0].params[1]);
    expect(outcomes.warnings).toHaveLength(1);
    expect(outcomes.warnings[0]).toMatch(errRe);
    expect(outcomes.matched_rule_ids).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// The deliberate exclusion
// ─────────────────────────────────────────────────────────────

test('NULL match_config on conditions mode is silent — a ruling, not a break', async () => {
  // NULL-is-non-match is documented and intentional (an explicit always-match
  // is {operator:'and', conditions:[]}). A rule saved this way is inert by the
  // author's own action, so treating it as a runtime failure would alert on
  // every single event forever for a state nobody needs to be told about.
  const db = makeDb({
    'appt.created': [rule(1, { match_mode: 'conditions', match_config: null })],
  });
  const res = await triggerService.processEvent(db, envelope());

  expect(res.status).toBe('no_match');
  expect(res.warnings).toEqual([]);
  expect(res.failedMatchRuleIds).toEqual([]);
  expect(matchAlerts()).toHaveLength(0);
  expect(ruleErrBumps(db)).toHaveLength(0);
  expect(hookService.executeHook).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────
// Isolation — one broken rule must not take down the working ones
// ─────────────────────────────────────────────────────────────

test('a broken rule does not stop a healthy sibling from matching and firing', async () => {
  const db = makeDb({
    'appt.created': [
      rule(1, { match_mode: 'code', match_config: { code: 'throw new Error("nope");' } }),
      rule(2),                                    // healthy always-match
    ],
  });
  const res = await triggerService.processEvent(db, envelope());

  expect(res.failedMatchRuleIds).toEqual([1]);
  expect(res.matchedRuleIds).toEqual([2]);
  expect(res.status).toBe('matched');             // rule 2's action succeeded
  expect(hookService.executeHook).toHaveBeenCalledTimes(1);

  // Rule 1 alerted as a match failure; rule 2 raised nothing.
  const alerts = matchAlerts();
  expect(alerts).toHaveLength(1);
  expect(alerts[0].group_key).toBe('trigger_rule_1');
  expect(alert.mock.calls.filter(c => c[1].kind === 'trigger_action_failed')).toHaveLength(0);
});

test('two broken rules alert independently, one per rule', async () => {
  const db = makeDb({
    'appt.created': [
      rule(1, { match_mode: 'conditions', match_config: '{not json' }),
      rule(2, { match_mode: 'regex' }),
    ],
  });
  const res = await triggerService.processEvent(db, envelope());

  expect(res.failedMatchRuleIds).toEqual([1, 2]);
  expect(res.warnings).toHaveLength(2);
  expect(matchAlerts().map(a => a.group_key)).toEqual(['trigger_rule_1', 'trigger_rule_2']);
  // One batched metrics bump naming both rules.
  expect(ruleErrBumps(db)).toHaveLength(1);
  expect(ruleErrBumps(db)[0].params).toEqual([1, 2]);
});

// ─────────────────────────────────────────────────────────────
// dedup_key — the volume guard
// ─────────────────────────────────────────────────────────────

describe('dedup_key', () => {
  test('is date-bucketed per rule, so a permanently broken rule alerts once a day', async () => {
    const broken = { 'appt.created': [rule(1, { match_mode: 'regex' })] };
    const day = new Date().toISOString().slice(0, 10);

    // Three events in a row — a corrupt match_config fails on EVERY event of
    // its type, so without the dedup_key this is the volume problem: one
    // system_alerts row per mutation, indefinitely.
    for (let i = 0; i < 3; i++) {
      await triggerService.processEvent(makeDb(broken), envelope());
    }

    const keys = matchAlerts().map(a => a.dedup_key);
    expect(keys).toHaveLength(3);                       // alert() called 3×
    expect(new Set(keys).size).toBe(1);                 // ...with ONE key
    expect(keys[0]).toBe(`trigger:match_failed:1:${day}`);
    // alert() does INSERT IGNORE when dedup_key is set and system_alerts has
    // UNIQUE KEY uq_sa_dedup (dedup_key) — verified against live MySQL — so
    // those three calls collapse to one row.
  });

  test('is distinct per rule and fits system_alerts.dedup_key varchar(200)', async () => {
    const db = makeDb({
      'appt.created': [rule(1, { match_mode: 'regex' }), rule(999999, { match_mode: 'regex' })],
    });
    await triggerService.processEvent(db, envelope());

    const keys = matchAlerts().map(a => a.dedup_key);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) {
      expect(k.length).toBeLessThanOrEqual(200);        // column is varchar(200)
      expect(k).toMatch(/^trigger:match_failed:\d+:\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('group_key matches trigger_action_failed so the digest sees ONE condition per rule', async () => {
    // A rule that is broken in more than one way over time (match today,
    // action tomorrow) must not present as two unrelated ongoing problems in
    // the digest or the shell banner.
    const db = makeDb({ 'appt.created': [rule(1, { match_mode: 'regex' })] });
    await triggerService.processEvent(db, envelope());
    expect(matchAlerts()[0].group_key).toBe('trigger_rule_1');
  });
});

// ─────────────────────────────────────────────────────────────
// Author-facing surfaces
// ─────────────────────────────────────────────────────────────

describe('match_error on the test surfaces', () => {
  test('evaluateDraft reports WHY, not just matched:false', () => {
    const out = triggerService.evaluateDraft(
      { match_mode: 'code', match_config: { code: 'throw new Error("nope");' } },
      envelope());
    expect(out.matched).toBe(false);
    expect(out.match_error).toMatch(/match code threw: nope/);
  });

  test('an honest non-match carries NO match_error', () => {
    const out = triggerService.evaluateDraft(
      { match_mode: 'conditions',
        match_config: { operator: 'and', conditions: [{ path: 'contact_id', op: 'equals', value: 999 }] } },
      envelope());
    expect(out.matched).toBe(false);
    expect(out.match_error).toBeUndefined();     // absent, not null
  });

  test('the NULL-config ruling stays silent here too', () => {
    const out = triggerService.evaluateDraft(
      { match_mode: 'conditions', match_config: null }, envelope());
    expect(out.matched).toBe(false);
    expect(out.match_error).toBeUndefined();
  });

  test('evaluateDryRun surfaces match_error per rule', async () => {
    const db = makeDb({
      'appt.created': [rule(1, { match_mode: 'regex' }), rule(2)],
    });
    const out = await triggerService.evaluateDryRun(db, envelope());
    expect(out.rules_evaluated).toBe(2);
    expect(out.report[0]).toMatchObject({ rule_id: 1, matched: false });
    expect(out.report[0].match_error).toMatch(/unknown match_mode 'regex'/);
    expect(out.report[1]).toMatchObject({ rule_id: 2, matched: true });
    expect(out.report[1].match_error).toBeUndefined();

    // Dry run dispatches nothing and writes no rows — unchanged by this slice.
    expect(db.calls.some(c => /INSERT INTO trigger_executions/.test(c.sql))).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Engine robustness — the recording must not become a new failure path
// ─────────────────────────────────────────────────────────────

test('a throwing alert() does not disturb the engine', async () => {
  alert.mockImplementationOnce(() => { throw new Error('alerting is down'); });
  const db = makeDb({ 'appt.created': [rule(1, { match_mode: 'regex' }), rule(2)] });

  const res = await triggerService.processEvent(db, envelope());

  // Rule 2 still matched and fired; the warning is still on the row.
  expect(res.status).toBe('matched');
  expect(res.matchedRuleIds).toEqual([2]);
  expect(res.warnings).toHaveLength(1);
  expect(hookService.executeHook).toHaveBeenCalledTimes(1);
});

test('a rejecting alert() does not produce an unhandled rejection', async () => {
  alert.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));
  const db = makeDb({ 'appt.created': [rule(1, { match_mode: 'regex' })] });
  await expect(triggerService.processEvent(db, envelope())).resolves.toMatchObject({
    status: 'no_match',
  });
});

test('domainEvents.emit stays fire-and-forget over a broken rule', async () => {
  // PORTED for split-phase dispatch (2026-08-30). emit() now queues rather
  // than evaluating, so the broken rule is reached by DRAINING the row. The
  // contract under test is unchanged and is the reason this test exists:
  // neither half may throw, and a rule that fails to EVALUATE must produce
  // exactly one trigger_match_failed alert and no trigger_engine_error on
  // top of it (a match failure is not an engine failure).
  const db = makeDb({ 'appt.created': [rule(1, { match_mode: 'regex' })] });

  await expect(
    domainEvents.emit(db, 'appt.created', { contact_id: 7, source: 'system' })
  ).resolves.toBeUndefined();

  // Nothing evaluated yet — the emit path is now two cheap writes.
  expect(matchAlerts()).toHaveLength(0);

  const { drainOne } = require('../lib/domainEventDrain');
  const out = await drainOne(db, 1);
  expect(out.results[0].status).toBe('done');

  expect(matchAlerts()).toHaveLength(1);
  // The engine did NOT throw, so no trigger_engine_error was raised on top.
  expect(alert.mock.calls.filter(c => c[1].kind === 'trigger_engine_error')).toHaveLength(0);
});