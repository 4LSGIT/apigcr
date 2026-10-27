'use strict';
/**
 * tests/guestCodeLanes.test.js
 *
 * lib/guestCode.js LANES (review 2026-10-27): every code site shares one pool
 * of MAX_CHILDREN sandbox children, so a webhook burst plus one slow body used
 * to starve every trigger / ingest rule / suppression on the instance, with an
 * unbounded FIFO whose waiters never timed out. Pinned here, on the REAL
 * engine (real forks, real QuickJS — nothing mocks guestCode):
 *   - reservation: hooks + previews flooding every slot they may take leave
 *     the events lane its floor, and an events flood leaves hooks theirs;
 *   - the queue-wait budget: a waiter past it FAILS CLOSED with each site's own
 *     failure semantics (match / filter / suppression → non-match; transform →
 *     failed, no actions; hook transform → failed, no target runs);
 *   - the bounded queue: beyond it a call fails closed at once;
 *   - the saturation alert: logged always; recorded warning on a first
 *     episode, error when the lane saturates again within the repeat window,
 *     folded to one per lane per minute; preview never escalates;
 *   - slot accounting under timeouts, spawn failures and spawn errors;
 *   - every site names the lane it must run in (the site table).
 *
 * NOTHING DISPATCHES: lib/actionDispatchers.dispatch throws and is asserted
 * untouched; lib/alerting is a recorder; no pool exists.
 *
 * DETERMINISM (2026-10-27, after a CI flake: 1 run in 13 on a cold 4-vCPU
 * runner). The occupying load — the "flood" that fills a lane — no longer
 * runs real slow bodies whose slot frees on the wall clock. It is HELD:
 * `hold()` makes the next forks fake children (child_process.fork is wrapped
 * at the lowest layer; guestCode's slot accounting, queueing, budgets and
 * release-on-exit all run for real) that keep their slot until the test
 * releases them, then answer and exit. Every production call under test
 * still forks a REAL child running the REAL QuickJS body. Consequences:
 *   - a lane's state is asserted right after the calls are made (a grant or
 *     a queue entry is synchronous inside runBodies) — no polling for it;
 *   - no assertion depends on how fast a real child starts: a production call
 *     is only ever made when a slot is free for it (the reservation proofs),
 *     or into a lane whose slots are held for as long as the test wants (the
 *     budget proofs — the waiter's own budget timer is the only clock);
 *   - a held load never frees a slot by itself, so "it ran while the lane was
 *     flooded" needs no elapsed-time bound;
 *   - afterEach releases whatever a failed test left held, so one failure
 *     cannot cascade into the next test (the CI flake's second failure was
 *     exactly that cascade).
 * The CI flake reproduces locally by making every child take 700 ms to boot
 * (a --require preload in the child): the old tests failed the same two
 * assertions; these pass.
 */

// Read once at module load by guestCode / the services — set before any require.
process.env.GUEST_CODE_MAX_CHILDREN = '4';
process.env.GUEST_CODE_TIMEOUT_MS = '6000';
process.env.TRIGGER_CODE_TIMEOUT_MS = '6000';
process.env.GUEST_CODE_QUEUE_WAIT_MS_EVENTS = '300';
process.env.GUEST_CODE_QUEUE_WAIT_MS_HOOKS = '300';
process.env.GUEST_CODE_QUEUE_WAIT_MS_PREVIEW = '4000';
process.env.GUEST_CODE_MAX_QUEUE_EVENTS = '10';
process.env.GUEST_CODE_MAX_QUEUE_HOOKS = '3';
process.env.GUEST_CODE_MAX_QUEUE_PREVIEW = '2';
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);
process.env.EMAIL_DOMAINS = process.env.EMAIL_DOMAINS || '4lsg.com';

const mockDispatchTouches = [];
jest.mock('../lib/actionDispatchers', () => {
  const actual = jest.requireActual('../lib/actionDispatchers');
  return {
    ...actual,
    dispatch: jest.fn(async (...args) => {
      mockDispatchTouches.push(String(args[1]));
      throw new Error('dispatch reached in test');
    }),
  };
});
jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const guestCode = require('../lib/guestCode');
const { alert: mockAlert } = require('../lib/alerting');
const triggerService = require('../services/triggerService');
const emailRules = require('../services/emailIngestRuleService');
const phoneRules = require('../services/phoneIngestRuleService');
const emailSupp = require('../services/emailIngestSuppressionService');
const phoneSupp = require('../services/phoneIngestSuppressionService');
const hookService = require('../services/hookService');
const preview = require('../services/ingestRulePreviewService');

jest.setTimeout(60000);

const SLOW = 'var t = Date.now(); while (Date.now() - t < input.ms) {} return true;';
const ALWAYS = { operator: 'and', conditions: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A slot is released when the child PROCESS is gone (its 'exit' event), which
// trails the answer — so "idle" is awaited, then asserted. The limit is only a
// backstop against a hang, not a latency budget: nothing here asserts speed.
const IDLE = { active: { events: 0, hooks: 0, preview: 0 }, queued: { events: 0, hooks: 0, preview: 0 }, total: 0 };
const idle = async () => {
  const t = Date.now();
  while (JSON.stringify(guestCode._poolState()) !== JSON.stringify(IDLE) && Date.now() - t < 30000) await sleep(10);
  expect(guestCode._poolState()).toEqual(IDLE);
};

// ── HELD SLOTS (see DETERMINISM above) ─────────────────────────────────────
// child_process.fork is wrapped once: while `fakeForks` holds modes, the next
// fork returns a fake child instead of a process — 'hold' keeps its slot until
// released, 'auto' answers at once. Otherwise the real fork runs. guestCode
// reads require('child_process').fork at call time, so this is the lowest
// layer it has; tests that spy on fork themselves wrap this wrapper.
const cp = require('child_process');
const { EventEmitter } = require('events');
const forkUnwrapped = cp.fork;
const fakeForks = [];
const heldChildren = [];
function fakeChild({ mode, owner }) {
  const c = new EventEmitter();
  let msg = null;
  let done = false;
  const answer = () => {
    if (done) return;
    done = true;
    // The batch reply shape guestCode reads (one result per input, the body's
    // `return true` as the tagged wrapper the guest source produces).
    const batch = ((msg && msg.batch) || []).map(() => ({ ok: true, valueJson: JSON.stringify({ ok: true, value: true }), logs: [] }));
    c.emit('message', { ok: true, batch });
    setImmediate(() => c.emit('exit', 0, null));
  };
  Object.assign(c, {
    pid: 900000 + heldChildren.length, connected: true,
    send(m) { msg = m; if (mode === 'auto') setImmediate(answer); },
    kill() {}, disconnect() { c.connected = false; }, unref() {},
    release: answer,
  });
  if (mode === 'hold') { heldChildren.push(c); if (owner) owner.push(c); }
  return c;
}
cp.fork = function forkOrFake(...args) {
  if (fakeForks.length) return fakeChild(fakeForks.shift());
  return forkUnwrapped.apply(this, args);
};
afterAll(() => { cp.fork = forkUnwrapped; });

// Occupy `lane` with `n` calls, of which the first `granted` are expected to
// get a slot at once (each a held fake child) and the rest to queue. The
// grants and queue entries happen synchronously inside runBodies, so the
// caller asserts the pool state right after. `then` lists modes for forks
// made LATER (e.g. 'auto' for queued calls that run after a release).
function hold(lane, n, granted, { then = [] } = {}) {
  const mine = [];
  fakeForks.push(...Array.from({ length: granted }, () => ({ mode: 'hold', owner: mine })),
    ...then.map((mode) => ({ mode })));
  const calls = Array.from({ length: n }, () => guestCode.runBodies('return true;', [{}], { lane, timeoutMs: 6000 }));
  return {
    calls,
    // This hold's children, once their forks have happened (a microtask after
    // the grant) — then each answers and exits, releasing its slot.
    async release() {
      const t = Date.now();
      while (mine.length < granted && Date.now() - t < 30000) await sleep(5);
      expect(mine).toHaveLength(granted);
      for (const c of mine) c.release();
    },
  };
}
// Real slow bodies (the mixed-flood test wants real forks under contention).
function flood(lane, n, ms) {
  return Array.from({ length: n }, () => guestCode.runBodies(SLOW, [{ ms }], { lane, timeoutMs: 6000 }));
}
function releaseAll() {
  fakeForks.length = 0;
  for (const c of heldChildren) c.release();
}
const state = () => guestCode._poolState();

let warnSpy;
let logSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  guestCode._resetSaturationForTests();
  guestCode.setAlertDb(null);
  mockAlert.mockClear();
});
afterEach(async () => {
  // A failed test must not leave its held slots behind for the next one.
  const leftover = fakeForks.length;
  releaseAll();
  await idle();
  warnSpy.mockRestore();
  logSpy.mockRestore();
  expect(leftover).toBe(0);  // every fake fork a test asked for was used
  expect(mockDispatchTouches).toEqual([]);
});

const envelope = () => ({
  event: 'appt.created', ts: '2026-10-26T12:00:00.000Z', depth: 0, chain: [], source: 'system',
  actor: null, contact_id: 7, case_id: 'AbCd1234', data: { stage: 'filed' }, changes: null, extra: null,
});
const emailEnvelope = () => ({ kind: 'email', from: { email: 'a@example.com' }, subject: 'Hello', text: 'body text' });
const phoneEvent = () => ({ type: 'sms', from: '3135550100', to: '2485592400', message: 'hi', extra: {} });
const hookInput = () => ({ body: { a: 1 }, headers: {}, query: {}, method: 'POST', meta: { slug: 't' } });
const ruleOf = (over) => ({ id: 1, name: 't', match_mode: 'conditions', match_config: ALWAYS,
  transform_mode: 'passthrough', transform_config: null, ...over });
const triggerRule = (id, code, transformCode) => ({ id, event_type: 'appt.created', name: `r${id}`, match_mode: 'code',
  match_config: { code }, transform_mode: transformCode ? 'code' : 'passthrough',
  transform_config: transformCode ? { code: transformCode } : null, min_interval_s: 0, secs_since_match: null, cooling_down: 0 });
function triggerDb(rules) {
  let nextId = 900;
  return {
    query: async (sql) => {
      if (/FROM trigger_rules/.test(sql)) return [rules.map((r) => ({ ...r }))];
      if (/FROM trigger_rule_actions/.test(sql)) return [[]];
      if (/INSERT INTO trigger_execution/.test(sql)) return [{ insertId: nextId++, affectedRows: 1 }];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      throw new Error('triggerDb: unscripted SQL: ' + sql.slice(0, 60));
    },
  };
}
function suppressionDb(table, rules) {
  return {
    query: async (sql) => {
      if (sql.includes(`FROM ${table}`)) return [rules.map((r) => ({ ...r }))];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    },
  };
}

describe('the lane table', () => {
  test('reservations derive from MAX_CHILDREN; budgets and queue caps come from the env knobs', () => {
    expect(guestCode.MAX_CHILDREN).toBe(4);
    expect(guestCode.RESERVED).toEqual({ events: 2, hooks: 1, preview: 0 });
    expect(guestCode.QUEUE_WAIT_MS).toEqual({ events: 300, hooks: 300, preview: 4000 });
    expect(guestCode.MAX_QUEUE).toEqual({ events: 10, hooks: 3, preview: 2 });
    expect(guestCode.LANES).toEqual({ events: 'events', hooks: 'hooks', preview: 'preview' });
  });

  test('the defaults, read with no knobs set (isolated module)', () => {
    const keys = Object.keys(process.env).filter((k) => k.startsWith('GUEST_CODE_'));
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    keys.forEach((k) => delete process.env[k]);
    try {
      jest.isolateModules(() => {
        const fresh = require('../lib/guestCode');
        expect(fresh.MAX_CHILDREN).toBe(4);
        expect(fresh.RESERVED).toEqual({ events: 2, hooks: 1, preview: 0 });
        expect(fresh.QUEUE_WAIT_MS).toEqual({ events: 10000, hooks: 10000, preview: 5000 });
        expect(fresh.MAX_QUEUE).toEqual({ events: 100, hooks: 100, preview: 10 });
        // Since the ack-first receiver (2026-10-28) the hooks lane is NOT
        // request-bound: the sender has its 200 before any body runs, and a
        // waiter that still fails closed is re-queued by lib/hookDrain. The
        // budget is sized like events, and a RingCentral-window arithmetic
        // (the old 2 waits + 2 forks + workflow start < 3 s) no longer applies.
        expect(fresh.QUEUE_WAIT_MS.hooks).toBe(fresh.QUEUE_WAIT_MS.events);
      });
    } finally { Object.assign(process.env, saved); }
  });

  test('a call that names no lane runs in PREVIEW (a forgotten site can never take a production lane)', async () => {
    const p = guestCode.runBodies(SLOW, [{ ms: 50 }], { timeoutMs: 6000 });
    expect(state().active).toEqual({ events: 0, hooks: 0, preview: 1 });   // granted synchronously
    expect((await p)[0]).toEqual({ ok: true, value: true });
    await idle();
    const q = guestCode.runBody(SLOW, { ms: 50 }, { timeoutMs: 6000 });
    await sleep(0); // runBody reaches runBodies after one microtask hop
    expect(state().active).toEqual({ events: 0, hooks: 0, preview: 1 });
    expect(await q).toBe(true);
    await idle();
  });

  test('an unknown lane fails closed and never forks', async () => {
    const cp = require('child_process');
    const spy = jest.spyOn(cp, 'fork');
    try {
      const [r] = await guestCode.runBodies('return 1', [{}], { lane: 'evnts' });
      expect(r.ok).toBe(false);
      expect(r.error.message).toBe('unknown code lane "evnts"');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    await idle();
  });
});

describe('reservation', () => {
  test('hooks + previews flooding every slot they may take leave the events floor: a trigger match, an ingest rule and a suppression all run', async () => {
    // More demand than either lane may have: 2 previews, 3 hooks.
    const preview_ = hold('preview', 2, 1);
    const hooks_ = hold('hooks', 3, 1);
    // preview took 1, hooks 1, the rest queued — the other 2 slots stay held for events.
    expect(state()).toEqual({ active: { events: 0, hooks: 1, preview: 1 }, queued: { events: 0, hooks: 2, preview: 1 }, total: 2 });
    // Two events calls at once — exactly the floor, so neither waits for a slot.
    const [trig, rule] = await Promise.all([
      triggerService.processEvent(triggerDb([triggerRule(21, 'return true;')]), envelope()),
      emailRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: { code: 'return input.subject === "Hello";' } }), emailEnvelope()),
    ]);
    const supp = await phoneSupp.evaluateSuppressions(suppressionDb('phone_log_suppressions', [{ id: 6, name: 's', match_mode: 'code', match_config: { code: 'return true;' } }]), phoneEvent());
    expect(trig.matchedRuleIds).toEqual([21]);
    expect(rule).toBe(true);
    expect(supp).toEqual({ suppressed: true, matchedRuleIds: [6] });
    // All three ran while the flood still held its slots (a held slot never
    // frees by itself; the events slots come back on their children's exit).
    expect(state().active.hooks).toBe(1);
    expect(state().active.preview).toBe(1);
    expect(state().queued.preview).toBe(1);
    // The queued hooks waiters fail closed at their budget behind the held slot.
    const hookOut = await Promise.all(hooks_.calls.slice(1));
    expect(hookOut.every(([r]) => r.error && r.error.code === 'GUEST_CODE_BUSY' && r.error.reason === 'wait_timeout')).toBe(true);
    fakeForks.push({ mode: 'auto' }); // the queued preview runs once its lane frees
    await preview_.release();
    await hooks_.release();
    const rest = await Promise.all([...preview_.calls, hooks_.calls[0]]);
    expect(rest.every(([r]) => r.ok)).toBe(true);
  });

  test('an events flood leaves hooks their reserved slot: a live hook filter still runs', async () => {
    const events_ = hold('events', 5, 3);
    expect(state()).toEqual({ active: { events: 3, hooks: 0, preview: 0 }, queued: { events: 2, hooks: 0, preview: 0 }, total: 3 });
    const r = await hookService.runFilter({ filter_mode: 'code', filter_config: { code: 'return input.body.a === 1;' } }, hookInput());
    expect(r).toEqual({ passed: true });
    expect(state().active.events).toBe(3);
    // The two queued events waiters fail closed at their 300 ms budget behind the held slots...
    const queued = await Promise.all(events_.calls.slice(3));
    expect(queued.every(([q]) => q.error && q.error.code === 'GUEST_CODE_BUSY' && q.error.reason === 'wait_timeout')).toBe(true);
    // ...and the three holders finish once released.
    await events_.release();
    const held = await Promise.all(events_.calls.slice(0, 3));
    expect(held.every(([h]) => h.ok)).toBe(true);
  });

  test('the total never exceeds MAX_CHILDREN across a mixed flood; every call ends ok or fails closed busy — nothing hangs or errs otherwise', async () => {
    const cp = require('child_process');
    const realFork = cp.fork;
    let live = 0;
    let peak = 0;
    const spy = jest.spyOn(cp, 'fork').mockImplementation((...args) => {
      const child = realFork(...args);
      live += 1; peak = Math.max(peak, live);
      child.once('exit', () => { live -= 1; });
      return child;
    });
    try {
      const all = [...flood('events', 6, 150), ...flood('hooks', 3, 150), ...flood('preview', 2, 150)];
      const out = await Promise.all(all);
      // The 300 ms test budgets can expire under machine load: busy is a legal outcome, nothing else is.
      expect(out.every(([r]) => (r.ok && r.value === true) || (r.error && r.error.code === 'GUEST_CODE_BUSY'))).toBe(true);
      const ran = out.filter(([r]) => r.ok).length;
      expect(ran).toBeGreaterThanOrEqual(4);           // at least the first grants (events 3 + hooks 1)
      expect(spy).toHaveBeenCalledTimes(ran);          // a busy call never forked
      expect(peak).toBeLessThanOrEqual(guestCode.MAX_CHILDREN);
      expect(peak).toBeGreaterThan(2);
    } finally { spy.mockRestore(); }
    await idle();
  });
});

describe('the queue-wait budget fails closed with each site\'s own semantics', () => {
  test('hooks: the filter and the transform both FAIL (tagged busy — no decision was made) — after ~the budget, not the stall', async () => {
    const hooks_ = hold('hooks', 2, 2);
    expect(state().active.hooks).toBe(2);
    const t = Date.now();
    const [filter, transform] = await Promise.all([
      hookService.runFilter({ filter_mode: 'code', filter_config: { code: 'return true;' } }, hookInput()),
      hookService.runTransform('code', { code: 'return { x: 1 };' }, hookInput()),
    ]);
    const elapsed = Date.now() - t;
    expect(filter).toEqual({ passed: false, failed: true, busy: true, error: 'Filter code error [GUEST_CODE_BUSY]: code sandbox busy: no hooks slot within 300ms — failed closed, the body did not run' });
    expect(transform).toEqual({ output: {}, failed: true, busy: true, errors: ['Transform code error [GUEST_CODE_BUSY]: code sandbox busy: no hooks slot within 300ms — failed closed, the body did not run'] });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    // The holders never free a slot, so ANY answer is the budget's, not the
    // stall's; this bound only catches a budget read wrong by an order of magnitude.
    expect(elapsed).toBeLessThan(3000);
    await hooks_.release();
    await Promise.all(hooks_.calls);
  });

  test('events: trigger match → non-match + reason, trigger transform → failed (no actions), ingest match → false, ingest transform → failed, suppression → not suppressed', async () => {
    const events_ = hold('events', 3, 3);
    expect(state().active.events).toBe(3);
    const warns = [];
    const t = Date.now();
    const [trig, trigTr, rule, ruleTr, supp] = await Promise.all([
      triggerService.processEvent(triggerDb([triggerRule(21, 'return true;')]), envelope()),
      // the transform half: the match is conditions (no code), the transform is code
      triggerService.processEvent(triggerDb([{ ...triggerRule(22, 'x'), match_mode: 'conditions', match_config: ALWAYS,
        transform_mode: 'code', transform_config: { code: 'return { a: 1 };' } }]), envelope()),
      phoneRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: { code: 'return true;' } }), phoneEvent(), { warn: (m) => warns.push(m) }),
      emailRules._runTransform(ruleOf({ transform_mode: 'code', transform_config: { code: 'return { a: 1 };' } }), emailEnvelope()),
      emailSupp.evaluateSuppressions(suppressionDb('email_ingest_log_suppressions', [{ id: 5, name: 's', match_mode: 'code', match_config: { code: 'return true;' } }]), emailEnvelope()),
    ]);
    const elapsed = Date.now() - t;
    const busy = /code sandbox busy: no events slot within 300ms — failed closed/;
    expect(trig.matchedRuleIds).toEqual([]);
    expect(trig.failedMatchRuleIds).toEqual([21]);
    expect(JSON.stringify(trig.warnings)).toMatch(busy);
    expect(trigTr.matchedRuleIds).toEqual([22]);
    expect(JSON.stringify(trigTr)).toMatch(busy);
    expect(trigTr.actionOutcomes.every((o) => o.status !== 'dispatched')).toBe(true);
    expect(rule).toBe(false);
    expect(warns.join('\n')).toMatch(busy);
    expect(ruleTr.ok).toBe(false);
    expect(ruleTr.error).toMatch(busy);
    expect(supp).toEqual({ suppressed: false, matchedRuleIds: [] });
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/\[guestCode\] events lane saturated \(wait_timeout\)/);
    expect(elapsed).toBeLessThan(3000); // the 300 ms budget, not the (endless) hold
    await events_.release();
    await Promise.all(events_.calls);
  });
});

describe('the bounded queue', () => {
  test('beyond MAX_QUEUE a call fails closed AT ONCE; the queued ones still run', async () => {
    // One holder, then two waiters that will run (instantly, as fakes) once it frees.
    const running = hold('preview', 1, 1, { then: ['auto', 'auto'] });
    const queued = Array.from({ length: 2 }, () => guestCode.runBodies(SLOW, [{ ms: 10 }], { lane: 'preview' }));
    expect(state()).toEqual({ active: { events: 0, hooks: 0, preview: 1 }, queued: { events: 0, hooks: 0, preview: 2 }, total: 1 });
    let settledAt = null;
    const t = Date.now();
    const overP = guestCode.runBodies('return 1', [{}], { lane: 'preview' }).then((x) => { settledAt = Date.now(); return x; });
    const [over] = await overP;
    // Refused without queueing (it never waited for its 4 s budget).
    expect(settledAt - t).toBeLessThan(1000);
    expect(state().queued.preview).toBe(2);
    expect(over.ok).toBe(false);
    expect(over.error).toMatchObject({ code: 'GUEST_CODE_BUSY', lane: 'preview', reason: 'queue_full',
      message: 'code sandbox busy: the preview lane queue is full (2 waiting) — failed closed, the body did not run' });
    // runBody rejects with the same error (the call sites' entry point).
    await expect(guestCode.runBody('return 1', {}, {})).rejects.toMatchObject({ code: 'GUEST_CODE_BUSY', reason: 'queue_full' });
    await running.release();
    const done = await Promise.all([...running.calls, ...queued]);
    expect(done.every(([r]) => r.ok)).toBe(true);
  });
});

describe('saturation alerts (house severity convention)', () => {
  test('first episode → warning; again inside the repeat window → error; folded to one per minute; preview never escalates', async () => {
    const db = { marker: 'pool' };
    guestCode.setAlertDb(db);
    const realNow = Date.now;
    let offset = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + offset);
    try {
      const hooks_ = hold('hooks', 2, 2);
      expect(state()).toEqual({ active: { events: 0, hooks: 2, preview: 0 }, queued: { events: 0, hooks: 0, preview: 0 }, total: 2 });
      // Three waiters (queue cap 3) and one overflow: 1 queue_full now + 3 wait_timeouts later.
      const waiters = Array.from({ length: 3 }, () => guestCode.runBodies(SLOW, [{ ms: 10 }], { lane: 'hooks' }));
      expect(state().queued.hooks).toBe(3);
      const [over] = await guestCode.runBodies('return 1', [{}], { lane: 'hooks' });
      expect(over.error.reason).toBe('queue_full');
      const timedOut = await Promise.all(waiters);
      expect(timedOut.every(([r]) => r.error && r.error.reason === 'wait_timeout')).toBe(true);
      // ONE alert for four rejections inside the minute; every one was logged.
      expect(mockAlert).toHaveBeenCalledTimes(1);
      expect(mockAlert.mock.calls[0][0]).toBe(db);
      expect(mockAlert.mock.calls[0][1]).toMatchObject({ source: 'app', kind: 'guest_code_saturated', severity: 'warning',
        group_key: 'guest_code_saturated:hooks', title: 'Code sandbox hooks lane saturated' });
      expect(mockAlert.mock.calls[0][1].context).toMatchObject({ lane: 'hooks', reason: 'queue_full', count: 1 });
      expect(warnSpy.mock.calls.filter((c) => /\[guestCode\] hooks lane saturated/.test(String(c[0])))).toHaveLength(4);

      // 61 s later the lane saturates again: repeated → error, carrying the folded count.
      offset = 61 * 1000;
      const [again] = await guestCode.runBodies('return 1', [{}], { lane: 'hooks' });
      expect(again.error.code).toBe('GUEST_CODE_BUSY');
      expect(mockAlert).toHaveBeenCalledTimes(2);
      expect(mockAlert.mock.calls[1][1]).toMatchObject({ severity: 'error', title: 'Code sandbox hooks lane saturated again' });
      expect(mockAlert.mock.calls[1][1].context.count).toBe(4);   // 3 folded + this one

      // Past the repeat window: a fresh episode is a warning again.
      offset += 31 * 60 * 1000;
      await guestCode.runBodies('return 1', [{}], { lane: 'hooks' });
      expect(mockAlert).toHaveBeenCalledTimes(3);
      expect(mockAlert.mock.calls[2][1].severity).toBe('warning');
      await hooks_.release();
      await Promise.all(hooks_.calls);
      await idle(); // the released slots come back on their children's exit

      // preview: a repeat inside the window stays a warning.
      const pFlood = hold('preview', 1, 1, { then: ['auto', 'auto'] });
      const pq = Array.from({ length: 2 }, () => guestCode.runBodies(SLOW, [{ ms: 10 }], { lane: 'preview' }));
      expect(state()).toEqual({ active: { events: 0, hooks: 0, preview: 1 }, queued: { events: 0, hooks: 0, preview: 2 }, total: 1 });
      await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
      offset += 61 * 1000;
      await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
      const previewAlerts = mockAlert.mock.calls.filter((c) => c[1].group_key === 'guest_code_saturated:preview');
      expect(previewAlerts.map((c) => c[1].severity)).toEqual(['warning', 'warning']);
      await pFlood.release();
      await Promise.all([...pFlood.calls, ...pq]);
    } finally { nowSpy.mockRestore(); }
  });

  test('with no db injected only the log line is written (this module opens no pool)', async () => {
    const pFlood = hold('preview', 1, 1, { then: ['auto', 'auto'] });
    const pq = Array.from({ length: 2 }, () => guestCode.runBodies(SLOW, [{ ms: 10 }], { lane: 'preview' }));
    expect(state()).toEqual({ active: { events: 0, hooks: 0, preview: 1 }, queued: { events: 0, hooks: 0, preview: 2 }, total: 1 });
    await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
    expect(mockAlert).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => /preview lane saturated \(queue_full\)/.test(String(c[0])))).toBe(true);
    await pFlood.release();
    await Promise.all([...pFlood.calls, ...pq]);
  });
});

describe('slot accounting', () => {
  test('a timed-out body, a fork that throws and a fork that errors with no process all give their slot back', async () => {
    const [timedOut] = await guestCode.runBodies('while (true) {}', [{}], { lane: 'events', timeoutMs: 200 });
    expect(timedOut.error.code).toBe('GUEST_CODE_TIMEOUT');
    await idle();

    const cp = require('child_process');
    const { EventEmitter } = require('events');
    const throwing = jest.spyOn(cp, 'fork').mockImplementation(() => { throw new Error('EAGAIN'); });
    try {
      const out = await Promise.all(Array.from({ length: 6 }, () => guestCode.runBodies('return 1', [{}], { lane: 'events' })));
      expect(out.every(([r]) => /could not start: EAGAIN/.test(r.error.message))).toBe(true);
    } finally { throwing.mockRestore(); }
    await idle();

    const erroring = jest.spyOn(cp, 'fork').mockImplementation(() => {
      const child = new EventEmitter();
      Object.assign(child, { pid: undefined, connected: false, send() {}, kill() {}, disconnect() {}, unref() {} });
      process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    });
    try {
      // 5 = the 2 hooks slots + the 3-deep hooks queue: every one forks (and fails) in turn.
      const out = await Promise.all(Array.from({ length: 5 }, () => guestCode.runBodies('return 1', [{}], { lane: 'hooks' })));
      expect(out.map(([r]) => r.error.message)).toEqual(Array(5).fill('code sandbox could not start: spawn ENOENT'));
    } finally { erroring.mockRestore(); }
    await idle();

    // And the pool still works for real afterwards, in every lane.
    for (const lane of ['events', 'hooks', 'preview']) {
      const [r] = await guestCode.runBodies('return input.n * 2', [{ n: 21 }], { lane });
      expect(r).toEqual({ ok: true, value: 42 });
    }
    await idle();
  });
});

describe('every site names its lane (observed at runBodies, the one entry point)', () => {
  test('production → events / hooks; editor tests, dry runs and previews → preview', async () => {
    const spy = jest.spyOn(guestCode, 'runBodies');
    const lanes = async (fn) => {
      spy.mockClear();
      await fn();
      // String(): toEqual ignores undefined array items, so an unnamed lane must read as 'undefined'.
      return [...new Set(spy.mock.calls.map((c) => String(c[2] && c[2].lane)))];
    };
    const code = (c) => ({ code: c });
    const hook = { id: 1, slug: 't', capture_mode: 'off', filter_mode: 'code', filter_config: code('return true;'),
      transform_mode: 'code', transform_config: code('return { a: 1 };'),
      targets: [{ id: 9, name: 'tg', target_type: 'http', url: 'https://example.invalid/x', method: 'POST', conditions: null,
        transform_mode: 'code', transform_config: code('return { b: 2 };'), headers: null, body_mode: 'transform_output' }] };
    const hookDb = { query: async (sql) => (/^\s*INSERT/i.test(sql) ? [{ insertId: 1, affectedRows: 1 }] : [{ affectedRows: 1 }]) };
    const phoneRuleDb = { query: async (sql) => {
      if (/FROM phone_ingest_rules/.test(sql)) return [[{ id: 3, name: 'r', active: 1, position: 1, match_mode: 'code',
        match_config: code('return true;'), transform_mode: 'code', transform_config: code('return { a: 1 };') }]];
      return [[]];
    } };
    const ch = preview.CHANNELS.phone;
    const origFetch = ch.fetch;
    ch.fetch = async () => ({ rows: [{ exec_id: 1, ts: '2026-10-26 12:00', status: 'logged', fidelity: 'full', envelope: phoneEvent() }], unparseable_skipped: 0 });
    try {
      const table = {
        'trigger processEvent (match + transform)': await lanes(() => triggerService.processEvent(
          triggerDb([triggerRule(21, 'return true;', 'return { a: 1 };')]), envelope())),
        'trigger evaluateDryRun': await lanes(() => triggerService.evaluateDryRun(
          triggerDb([triggerRule(21, 'return true;', 'return { a: 1 };')]), envelope())),
        'trigger evaluateDraft': await lanes(() => triggerService.evaluateDraft(
          { match_mode: 'code', match_config: code('return true;'), transform_mode: 'code', transform_config: code('return {};') }, envelope())),
        'email rule match + transform': await lanes(async () => {
          await emailRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: code('return true;') }), emailEnvelope());
          await emailRules._runTransform(ruleOf({ transform_mode: 'code', transform_config: code('return {};') }), emailEnvelope());
        }),
        'phone rule match + transform': await lanes(async () => {
          await phoneRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: code('return true;') }), phoneEvent());
          await phoneRules._runTransform(ruleOf({ transform_mode: 'code', transform_config: code('return {};') }), phoneEvent());
        }),
        'suppressions': await lanes(async () => {
          await emailSupp.evaluateSuppressions(suppressionDb('email_ingest_log_suppressions', [{ id: 5, name: 's', match_mode: 'code', match_config: code('return false;') }]), emailEnvelope());
          await phoneSupp.evaluateSuppressions(suppressionDb('phone_log_suppressions', [{ id: 6, name: 's', match_mode: 'code', match_config: code('return false;') }]), phoneEvent());
        }),
        'hook live (filter + transform)': await lanes(() => hookService.executeHook(hookDb, 't', hookInput(), { hook: { ...hook, targets: [] } })),
        'hook runFilter / runTransform default': await lanes(async () => {
          await hookService.runFilter(hook, hookInput());
          await hookService.runTransform('code', code('return {};'), hookInput());
        }),
        'hook dry run (filter + transform + target transform)': await lanes(() => hookService.executeHook({}, 't', hookInput(), { dryRun: true, hook })),
        'ingest testMatch (batched)': await lanes(() => preview.testMatch({}, 'phone', { match_mode: 'code', match_config: code('return true;') })),
        'ingest testTransform': await lanes(() => preview.testTransform({}, 'phone', { transform_mode: 'code', transform_config: code('return { a: 1 };'), input: phoneEvent() })),
        'ingest previewRows (sample)': await lanes(() => preview.previewRows(phoneRuleDb, { channel: 'phone', rule_id: 3, sample: phoneEvent() })),
        'ingest previewRows (window, batched)': await lanes(() => preview.previewRows(phoneRuleDb, { channel: 'phone', rule_id: 3, window: { limit: 5 } })),
      };
      expect(table).toEqual({
        'trigger processEvent (match + transform)': ['events'],
        'trigger evaluateDryRun': ['preview'],
        'trigger evaluateDraft': ['preview'],
        'email rule match + transform': ['events'],
        'phone rule match + transform': ['events'],
        'suppressions': ['events'],
        'hook live (filter + transform)': ['hooks'],
        'hook runFilter / runTransform default': ['hooks'],
        'hook dry run (filter + transform + target transform)': ['preview'],
        'ingest testMatch (batched)': ['preview'],
        'ingest testTransform': ['preview'],
        'ingest previewRows (sample)': ['preview'],
        'ingest previewRows (window, batched)': ['preview'],
      });
    } finally { ch.fetch = origFetch; spy.mockRestore(); }
  });

  test('batchRunner pins its lane over the per-row function\'s own (an uncovered call included)', async () => {
    const spy = jest.spyOn(guestCode, 'runBodies');
    try {
      const a = { s: 'x' };
      const run = await guestCode.batchRunner('return input.s', [a], { truthy: true });
      await run('return input.s', { s: 'uncovered' }, { truthy: true, lane: 'events' });
      expect(spy.mock.calls.map((c) => String(c[2].lane))).toEqual(['preview', 'preview']);
    } finally { spy.mockRestore(); }
  });

  test('the hooks editor\'s test-transform route asks for the preview lane', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'api.hooks.js'), 'utf8');
    expect(src.match(/hookService\.runTransform\(/g)).toHaveLength(1);
    expect(src).toContain("hookService.runTransform(mode, config, data, { lane: 'preview' })");
  });

  test('boot hands the app pool to guestCode for saturation alerts', async () => {
    jest.spyOn(require('../lib/taskQueue'), 'warmup').mockImplementation(() => {});
    const reconciler = require('../services/fieldDefReconciler');
    const sched = jest.spyOn(reconciler, 'scheduleReconcile').mockImplementation(() => {});
    const set = jest.spyOn(guestCode, 'setAlertDb');
    try {
      const pool = { marker: 'pool' };
      await require('../startup/init')(pool);
      expect(set).toHaveBeenCalledWith(pool);
    } finally { set.mockRestore(); sched.mockRestore(); guestCode.setAlertDb(null); }
  });
});
