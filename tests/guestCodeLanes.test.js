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
 *     failed, no actions; hook transform → {} + error);
 *   - the bounded queue: beyond it a call fails closed at once;
 *   - the saturation alert: logged always; recorded warning on a first
 *     episode, error when the lane saturates again within the repeat window,
 *     folded to one per lane per minute; preview never escalates;
 *   - slot accounting under timeouts, spawn failures and spawn errors;
 *   - every site names the lane it must run in (the site table).
 *
 * NOTHING DISPATCHES: lib/actionDispatchers.dispatch throws and is asserted
 * untouched; lib/alerting is a recorder; no pool exists.
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
// A slot is released when the child PROCESS is gone (its 'exit'), which can
// trail the answer by a few ms — so "idle" is awaited, then asserted.
const IDLE = { active: { events: 0, hooks: 0, preview: 0 }, queued: { events: 0, hooks: 0, preview: 0 }, total: 0 };
const idle = async () => {
  const t = Date.now();
  while (JSON.stringify(guestCode._poolState()) !== JSON.stringify(IDLE) && Date.now() - t < 5000) await sleep(10);
  expect(guestCode._poolState()).toEqual(IDLE);
};

// Start `n` slow bodies in `lane` (not awaited) and wait until the pool shows
// them running or queued as expected.
function flood(lane, n, ms) {
  return Array.from({ length: n }, () => guestCode.runBodies(SLOW, [{ ms }], { lane, timeoutMs: 6000 }));
}
async function until(pred, what, limit = 5000) {
  const t = Date.now();
  while (!pred(guestCode._poolState())) {
    if (Date.now() - t > limit) throw new Error(`pool never reached: ${what} — ${JSON.stringify(guestCode._poolState())}`);
    await sleep(10);
  }
}

let warnSpy;
let logSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  guestCode._resetSaturationForTests();
  guestCode.setAlertDb(null);
  mockAlert.mockClear();
});
afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
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
        expect(fresh.QUEUE_WAIT_MS).toEqual({ events: 10000, hooks: 3000, preview: 5000 });
        expect(fresh.MAX_QUEUE).toEqual({ events: 100, hooks: 50, preview: 10 });
      });
    } finally { Object.assign(process.env, saved); }
  });

  test('a call that names no lane runs in PREVIEW (a forgotten site can never take a production lane)', async () => {
    const p = guestCode.runBodies(SLOW, [{ ms: 600 }], { timeoutMs: 6000 });
    await until((st) => st.active.preview === 1, 'the unnamed call in preview');
    expect(guestCode._poolState().active).toEqual({ events: 0, hooks: 0, preview: 1 });
    await p;
    const q = guestCode.runBody(SLOW, { ms: 600 }, { timeoutMs: 6000 });
    await until((st) => st.active.preview === 1, 'runBody unnamed in preview');
    await q;
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
  test('hooks + previews flooding every slot they may take leave the events floor: a trigger match, an ingest rule and a suppression run at once', async () => {
    const floods = [...flood('preview', 2, 2500), ...flood('hooks', 3, 2500)];
    // preview takes 1, hooks 1 — the other 2 stay held for events.
    await until((s) => s.active.preview === 1 && s.active.hooks === 1 && s.queued.hooks === 2, 'non-events lanes full');
    const t = Date.now();
    const [trig, rule, supp] = await Promise.all([
      triggerService.processEvent(triggerDb([triggerRule(21, 'return true;')]), envelope()),
      emailRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: { code: 'return input.subject === "Hello";' } }), emailEnvelope()),
      phoneSupp.evaluateSuppressions(suppressionDb('phone_log_suppressions', [{ id: 6, name: 's', match_mode: 'code', match_config: { code: 'return true;' } }]), phoneEvent()),
    ]);
    const elapsed = Date.now() - t;
    expect(trig.matchedRuleIds).toEqual([21]);
    expect(rule).toBe(true);
    expect(supp).toEqual({ suppressed: true, matchedRuleIds: [6] });
    // Well before any flooding body (2.5 s) could have freed a slot.
    expect(elapsed).toBeLessThan(2000);
    const st = guestCode._poolState();
    expect(st.active.hooks + st.active.preview).toBeLessThanOrEqual(2);
    await Promise.all(floods);
    await idle();
  });

  test('an events flood leaves hooks their reserved slot: a live hook filter still runs', async () => {
    const floods = flood('events', 5, 2500);
    await until((s) => s.active.events === 3 && s.queued.events === 2, 'events lane full');
    const t = Date.now();
    const r = await hookService.runFilter({ filter_mode: 'code', filter_config: { code: 'return input.body.a === 1;' } }, hookInput());
    expect(r).toEqual({ passed: true });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(guestCode._poolState().active.events).toBeLessThanOrEqual(3);
    // The two queued events waiters fail closed at their 300 ms budget; the three running finish.
    const done = await Promise.all(floods);
    expect(done.filter(([r]) => r.ok)).toHaveLength(3);
    expect(done.filter(([r]) => !r.ok).every(([r]) => r.error.code === 'GUEST_CODE_BUSY')).toBe(true);
    await idle();
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
  test('hooks: the filter filters with an error, the transform yields {} with an error — after ~the budget, not the stall', async () => {
    const floods = flood('hooks', 2, 3000);
    await until((s) => s.active.hooks === 2, 'hooks lane full');
    const t = Date.now();
    const [filter, transform] = await Promise.all([
      hookService.runFilter({ filter_mode: 'code', filter_config: { code: 'return true;' } }, hookInput()),
      hookService.runTransform('code', { code: 'return { x: 1 };' }, hookInput()),
    ]);
    const elapsed = Date.now() - t;
    expect(filter.passed).toBe(false);
    expect(filter.error).toBe('Filter code error: code sandbox busy: no hooks slot within 300ms — failed closed, the body did not run');
    expect(transform).toEqual({ output: {}, errors: ['Transform code error: code sandbox busy: no hooks slot within 300ms — failed closed, the body did not run'] });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1500);
    await Promise.all(floods);
    await idle();
  });

  test('events: trigger match → non-match + reason, trigger transform → failed (no actions), ingest match → false, ingest transform → failed, suppression → not suppressed', async () => {
    const floods = flood('events', 3, 3500);
    await until((s) => s.active.events === 3, 'events lane full');
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
    expect(elapsed).toBeLessThan(2500);
    await Promise.all(floods);
    await idle();
  });
});

describe('the bounded queue', () => {
  test('beyond MAX_QUEUE a call fails closed AT ONCE; the queued ones still run', async () => {
    const running = flood('preview', 1, 1200);
    await until((s) => s.active.preview === 1, 'preview slot taken');
    const queued = flood('preview', 2, 10);
    await until((s) => s.queued.preview === 2, 'preview queue full');
    const t = Date.now();
    const [over] = await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
    expect(Date.now() - t).toBeLessThan(100);
    expect(over.ok).toBe(false);
    expect(over.error).toMatchObject({ code: 'GUEST_CODE_BUSY', lane: 'preview', reason: 'queue_full',
      message: 'code sandbox busy: the preview lane queue is full (2 waiting) — failed closed, the body did not run' });
    // runBody rejects with the same error (the call sites' entry point).
    await expect(guestCode.runBody('return 1', {}, {})).rejects.toMatchObject({ code: 'GUEST_CODE_BUSY', reason: 'queue_full' });
    const done = await Promise.all([...running, ...queued]);
    expect(done.every(([r]) => r.ok)).toBe(true);
    await idle();
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
      const floods = flood('hooks', 2, 2500);
      await until((s) => s.active.hooks === 2, 'hooks lane full');
      // Three waiters (queue cap 3) and one overflow: 1 queue_full now + 3 wait_timeouts later.
      const waiters = flood('hooks', 3, 10);
      await until((s) => s.queued.hooks === 3, 'hooks queue full');
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
      await Promise.all(floods);

      // preview: a repeat inside the window stays a warning.
      const pFlood = flood('preview', 1, 1500);
      await until((s) => s.active.preview === 1, 'preview slot taken');
      const pq = flood('preview', 2, 10);
      await until((s) => s.queued.preview === 2, 'preview queue full');
      await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
      offset += 61 * 1000;
      await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
      const previewAlerts = mockAlert.mock.calls.filter((c) => c[1].group_key === 'guest_code_saturated:preview');
      expect(previewAlerts.map((c) => c[1].severity)).toEqual(['warning', 'warning']);
      await Promise.all([...pFlood, ...pq]);
    } finally { nowSpy.mockRestore(); }
    await idle();
  });

  test('with no db injected only the log line is written (this module opens no pool)', async () => {
    const floods = flood('preview', 1, 800);
    await until((s) => s.active.preview === 1, 'preview slot taken');
    const pq = flood('preview', 2, 10);
    await until((s) => s.queued.preview === 2, 'preview queue full');
    await guestCode.runBodies('return 1', [{}], { lane: 'preview' });
    expect(mockAlert).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => /preview lane saturated \(queue_full\)/.test(String(c[0])))).toBe(true);
    await Promise.all([...floods, ...pq]);
    await idle();
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
