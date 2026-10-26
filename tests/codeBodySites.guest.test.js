'use strict';
/**
 * tests/codeBodySites.guest.test.js
 *
 * EVERY site that runs a code body now runs it in the QuickJS guest engine in
 * the sandbox child (lib/guestCode.js) — never in this process:
 *   triggers (match + transform)               services/triggerService.js
 *   email / phone ingest rules (match + transform)
 *                                              services/{email,phone}IngestRuleService.js
 *   email / phone log suppressions             services/{email,phone}IngestSuppressionService.js
 *   hook filter, hook transform, target transform
 *                                              services/hookService.js
 *   the rule previews / native test endpoints  services/ingestRulePreviewService.js
 *
 * Per site this pins, on the REAL engine (nothing here mocks guestCode):
 *   - the site's own result semantics (match → boolean; transform → object;
 *     suppression → suppressed; hook filter → passed/error; hook transform →
 *     {output, errors});
 *   - the AWAIT, at the orchestrator level: a code match returning false must
 *     not match and one returning true must. vm / new Function were
 *     synchronous; the guest is async, and an un-awaited promise is truthy —
 *     a match that is always true;
 *   - no host reach, asserted directly from inside the body;
 *   - an infinite loop and an allocation bomb end within the bound with the
 *     site's FAILURE semantics (match → non-match; transform → failed /
 *     no actions; suppression → not suppressed; hook filter → filtered) and
 *     without hanging the process.
 *
 * NOTHING DISPATCHES: lib/actionDispatchers.dispatch is replaced with a
 * recorder that throws, and asserted untouched after every test — the .env
 * these suites can load points at production. Rules carry no actions, hooks
 * run dry.
 */

// Read once at module load by the services — set before any require.
process.env.GUEST_CODE_TIMEOUT_MS = '400';
process.env.TRIGGER_CODE_TIMEOUT_MS = '400';
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
const triggerService = require('../services/triggerService');
const emailRules = require('../services/emailIngestRuleService');
const phoneRules = require('../services/phoneIngestRuleService');
const emailSupp = require('../services/emailIngestSuppressionService');
const phoneSupp = require('../services/phoneIngestSuppressionService');
const hookService = require('../services/hookService');
const preview = require('../services/ingestRulePreviewService');

jest.setTimeout(60000);

const BOUND_MS = 400 + guestCode.KILL_GRACE_MS + 2500;   // limit + kill grace + fork slack
const ALWAYS = { operator: 'and', conditions: [] };
const LOOP = 'while (true) {}';
const BOMB = 'var a = []; while (true) a.push("x".repeat(1e6)); return a.length;';

// Every probe is a typeof read; all must be 'undefined'. As a match body this
// is a single boolean: TRUE only when every one is absent.
const PROBES = {
  process: 'typeof process',
  require: 'typeof require',
  globalProcess: 'typeof globalThis.process',
  walkBack: 'input.constructor.constructor("return typeof process")()',
  walkBackRequire: 'input.constructor.constructor("return typeof require")()',
  fnThisProcess: 'typeof Function("return this")().process',
};
const ALL_ABSENT = Object.fromEntries(Object.keys(PROBES).map((k) => [k, 'undefined']));
const PROBE_OBJECT_BODY = `return { ${Object.entries(PROBES).map(([k, v]) => `${k}: ${v}`).join(', ')} };`;
const PROBE_MATCH_BODY = `return ${Object.values(PROBES).map((v) => `${v} === "undefined"`).join(' && ')};`;

let warnSpy;
let logSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  expect(mockDispatchTouches).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// Fake pools (the services take db as a parameter)
// ─────────────────────────────────────────────────────────────

function ingestDb(prefix, rules) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push(sql);
      if (sql.includes(`FROM ${prefix}_rules`)) return [rules.map((r) => ({ ...r }))];
      if (sql.includes(`FROM ${prefix}_rule_actions`)) return [[]];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
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

const envelope = () => ({
  event: 'appt.created', ts: '2026-10-26T12:00:00.000Z', depth: 0, chain: [], source: 'system',
  actor: null, contact_id: 7, case_id: 'AbCd1234', data: { stage: 'filed' }, changes: null, extra: null,
});
const emailEnvelope = () => ({ kind: 'email', from: { email: 'a@example.com' }, subject: 'Hello', text: 'body text' });
const phoneEvent = () => ({ type: 'sms', from: '3135550100', to: '2485592400', message: 'hi', extra: {} });
const hookInput = () => ({ body: { a: 1 }, headers: {}, query: {}, method: 'POST', meta: { slug: 't' } });

// ─────────────────────────────────────────────────────────────
// The sites, normalised: match sites resolve { matched, failed },
// transform sites resolve { ok, output, failed }.
// ─────────────────────────────────────────────────────────────

const ruleOf = (over) => ({ id: 1, name: 't', match_mode: 'conditions', match_config: ALWAYS,
  transform_mode: 'passthrough', transform_config: null, ...over });

const MATCH_SITES = {
  'trigger match': async (code) => {
    const out = await triggerService.evaluateDraft({ match_mode: 'code', match_config: { code } }, envelope());
    return { matched: out.matched, failed: !!out.match_error };
  },
  'email rule match': async (code) => {
    const warns = [];
    const matched = await emailRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: { code } }), emailEnvelope(), { warn: (m) => warns.push(m) });
    return { matched, failed: warns.length > 0 };
  },
  'phone rule match': async (code) => {
    const warns = [];
    const matched = await phoneRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: { code } }), phoneEvent(), { warn: (m) => warns.push(m) });
    return { matched, failed: warns.length > 0 };
  },
  'email suppression': async (code) => {
    const r = await emailSupp.evaluateSuppressions(suppressionDb('email_ingest_log_suppressions',
      [{ id: 5, name: 's', match_mode: 'code', match_config: { code } }]), emailEnvelope());
    return { matched: r.suppressed, failed: warnSpy.mock.calls.some((c) => /code error/.test(String(c[0]))) };
  },
  'phone suppression': async (code) => {
    const r = await phoneSupp.evaluateSuppressions(suppressionDb('phone_log_suppressions',
      [{ id: 6, name: 's', match_mode: 'code', match_config: { code } }]), phoneEvent());
    return { matched: r.suppressed, failed: warnSpy.mock.calls.some((c) => /code error/.test(String(c[0]))) };
  },
  'hook filter': async (code) => {
    const r = await hookService.runFilter({ filter_mode: 'code', filter_config: { code } }, hookInput());
    return { matched: r.passed, failed: !!r.error };
  },
};

const TRANSFORM_SITES = {
  'trigger transform': async (code) => {
    const out = await triggerService.evaluateDraft({ match_mode: 'conditions', match_config: ALWAYS,
      transform_mode: 'code', transform_config: { code } }, envelope());
    return out.transform_ok ? { ok: true, output: out.transformed } : { ok: false, failed: true };
  },
  'email rule transform': async (code) => {
    const tr = await emailRules._runTransform(ruleOf({ transform_mode: 'code', transform_config: { code } }), emailEnvelope());
    return tr.ok ? { ok: true, output: tr.output } : { ok: false, failed: true };
  },
  'phone rule transform': async (code) => {
    const tr = await phoneRules._runTransform(ruleOf({ transform_mode: 'code', transform_config: { code } }), phoneEvent());
    return tr.ok ? { ok: true, output: tr.output } : { ok: false, failed: true };
  },
  'hook transform': async (code) => {
    // Hook semantics: a failed code transform is {output:{}, errors:[…]}.
    const r = await hookService.runTransform('code', { code }, hookInput());
    return r.errors.length ? { ok: false, failed: true, output: r.output } : { ok: true, output: r.output };
  },
};

describe.each(Object.entries(MATCH_SITES))('%s', (_name, run) => {
  test('true matches and false does not — the result is AWAITED, never a truthy promise', async () => {
    expect(await run('return input != null;')).toEqual({ matched: true, failed: false });
    expect(await run('return false;')).toEqual({ matched: false, failed: false });
    expect(await run('return 0;')).toEqual({ matched: false, failed: false });
  });

  test('no host reach, asserted from inside the body', async () => {
    expect(await run(PROBE_MATCH_BODY)).toEqual({ matched: true, failed: false });
  });

  test('a throwing body is a non-match, reported', async () => {
    expect(await run('throw new Error("broken rule")')).toEqual({ matched: false, failed: true });
  });

  test('an infinite loop is a non-match within the bound', async () => {
    const t = Date.now();
    expect(await run(LOOP)).toEqual({ matched: false, failed: true });
    expect(Date.now() - t).toBeLessThan(BOUND_MS);
  });

  test('an allocation bomb is a non-match within the bound', async () => {
    const t = Date.now();
    expect(await run(BOMB)).toEqual({ matched: false, failed: true });
    expect(Date.now() - t).toBeLessThan(BOUND_MS);
  });
});

describe.each(Object.entries(TRANSFORM_SITES))('%s', (name, run) => {
  test('returns the body\'s object', async () => {
    expect(await run('return { got: input != null, n: 2 };')).toEqual({ ok: true, output: { got: true, n: 2 } });
  });

  test('no host reach, asserted from inside the body', async () => {
    expect(await run(PROBE_OBJECT_BODY)).toEqual({ ok: true, output: ALL_ABSENT });
  });

  test('a throwing body fails the transform', async () => {
    expect((await run('throw new Error("broken transform")')).ok).toBe(false);
  });

  test('an infinite loop fails the transform within the bound', async () => {
    const t = Date.now();
    const r = await run(LOOP);
    expect(r.ok).toBe(false);
    if (name === 'hook transform') expect(r.output).toEqual({});
    expect(Date.now() - t).toBeLessThan(BOUND_MS);
  });

  test('an allocation bomb fails the transform within the bound', async () => {
    const t = Date.now();
    expect((await run(BOMB)).ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(BOUND_MS);
  });
});

// ─────────────────────────────────────────────────────────────
// The orchestrators — where a dropped await would bite in production
// ─────────────────────────────────────────────────────────────

describe('orchestrators await every code evaluation', () => {
  test.each([
    ['email', emailRules, 'email_ingest', emailEnvelope],
    ['phone', phoneRules, 'phone_ingest', phoneEvent],
  ])('%s evaluateRules: a false code match is not matched; a true one is', async (_c, svc, prefix, mk) => {
    const rules = [ruleOf({ id: 11, match_mode: 'code', match_config: { code: 'return false;' } }),
      ruleOf({ id: 12, match_mode: 'code', match_config: { code: 'return true;' } })];
    const out = await svc.evaluateRules(ingestDb(prefix, rules), mk());
    expect(out.matchedRuleIds).toEqual([12]);
    expect(out.actionOutcomes).toEqual([]);
  });

  test.each([
    ['email', emailRules, 'email_ingest', emailEnvelope],
    ['phone', phoneRules, 'phone_ingest', phoneEvent],
  ])('%s evaluateRules: a code transform that loops = matched, transform failed, no action', async (_c, svc, prefix, mk) => {
    const rules = [ruleOf({ id: 13, transform_mode: 'code', transform_config: { code: LOOP } })];
    const out = await svc.evaluateRules(ingestDb(prefix, rules), mk());
    expect(out.matchedRuleIds).toEqual([13]);
    expect(out.actionOutcomes).toEqual([expect.objectContaining({ rule_id: 13, action_type: 'transform', status: 'failed' })]);
  });

  test.each([
    ['email', emailSupp, 'email_ingest_log_suppressions', emailEnvelope],
    ['phone', phoneSupp, 'phone_log_suppressions', phoneEvent],
  ])('%s evaluateSuppressions: false code does not suppress; true does', async (_c, svc, table, mk) => {
    const no = await svc.evaluateSuppressions(suppressionDb(table, [{ id: 1, name: 'n', match_mode: 'code', match_config: { code: 'return false;' } }]), mk());
    expect(no).toEqual({ suppressed: false, matchedRuleIds: [] });
    const yes = await svc.evaluateSuppressions(suppressionDb(table, [{ id: 2, name: 'y', match_mode: 'code', match_config: { code: 'return true;' } }]), mk());
    expect(yes).toEqual({ suppressed: true, matchedRuleIds: [2] });
  });

  test('trigger processEvent: a false code match is not matched; a true one is', async () => {
    const rule = (id, code) => ({ id, event_type: 'appt.created', name: `r${id}`, match_mode: 'code', match_config: { code },
      transform_mode: 'passthrough', transform_config: null, min_interval_s: 0, secs_since_match: null, cooling_down: 0 });
    const out = await triggerService.processEvent(triggerDb([rule(21, 'return false;'), rule(22, 'return true;')]), envelope());
    expect(out.matchedRuleIds).toEqual([22]);
  });

  test('trigger evaluateDryRun: awaited per rule', async () => {
    const rule = (id, code) => ({ id, event_type: 'appt.created', name: `r${id}`, match_mode: 'code', match_config: { code },
      transform_mode: 'code', transform_config: { code: 'return { id: input.contact_id };' }, min_interval_s: 0, cooling_down: 0 });
    const out = await triggerService.evaluateDryRun(triggerDb([rule(31, 'return false;'), rule(32, 'return true;')]), envelope());
    expect(out.report.map((r) => [r.rule_id, r.matched])).toEqual([[31, false], [32, true]]);
    expect(out.report[1].transformed).toEqual({ id: 7 });
  });

  test('a trigger timeout carries the throttling diagnostic', async () => {
    const out = await triggerService.evaluateDraft({ match_mode: 'conditions', match_config: ALWAYS,
      transform_mode: 'code', transform_config: { code: LOOP } }, envelope());
    expect(out.transform_error).toMatch(/timed out after 400ms .*throttled Cloud Run instance/);
  });

  test('hook executeHook (dry run): a false code filter filters; a true one runs hook + target code transforms', async () => {
    const hook = (filterCode) => ({ id: 1, slug: 't', capture_mode: 'off', filter_mode: 'code', filter_config: { code: filterCode },
      transform_mode: 'code', transform_config: { code: 'return { a: input.body.a + 1 };' },
      targets: [{ id: 9, name: 'tg', target_type: 'http', url: 'https://example.invalid/x', method: 'POST', conditions: null,
        transform_mode: 'code', transform_config: { code: 'return { b: input.a * 10 };' }, headers: null, body_mode: 'transform_output' }] });
    const filtered = await hookService.executeHook({}, 't', hookInput(), { dryRun: true, hook: hook('return false;') });
    expect(filtered.status).toBe('filtered');
    const ran = await hookService.executeHook({}, 't', hookInput(), { dryRun: true, hook: hook('return true;') });
    expect(ran.targets || ran.targetResults || ran).toEqual(expect.anything());
    const json = JSON.stringify(ran);
    expect(json).toContain('"b":20');
  });
});

// ─────────────────────────────────────────────────────────────
// The previews run the SAME engine, batched
// ─────────────────────────────────────────────────────────────

describe('previews: same engine as production, one child per corpus', () => {
  test('test-match evaluates a code rule over the whole corpus in ONE runBodies call, with production per-row answers', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ exec_id: i + 1, ts: '2026-10-26 12:00', status: 'logged', fidelity: 'full',
      envelope: { type: 'sms', from: String(3135550100 + i), to: '2485592400', message: i % 3 ? 'keep' : 'stop' } }));
    const spy = jest.spyOn(guestCode, 'runBodies');
    const ch = preview.CHANNELS.phone;
    const origFetch = ch.fetch;
    ch.fetch = async () => ({ rows, unparseable_skipped: 0 });
    try {
      const r = await preview.testMatch({}, 'phone', { match_mode: 'code', match_config: { code: 'return input.message === "stop";' }, include_misses: true });
      expect(r.status).toBe(200);
      expect(r.body.matched_count).toBe(14);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toHaveLength(40);
      // Same answers as the production function row by row (unbatched).
      for (const row of rows) {
        const prod = await phoneRules._evaluateMatch(ruleOf({ match_mode: 'code', match_config: { code: 'return input.message === "stop";' } }), row.envelope);
        expect(r.body.rows.find((x) => x.exec_id === row.exec_id).matched).toBe(prod);
      }
    } finally { ch.fetch = origFetch; spy.mockRestore(); }
  });

  test('observeWarnings captures only its own call\'s warnings while concurrent calls warn', async () => {
    const slow = preview.observeWarnings((warn) => emailRules._evaluateMatch(
      ruleOf({ id: 41, name: 'slow', match_mode: 'code', match_config: { code: 'throw new Error("mine")' } }), emailEnvelope(), { warn }));
    // Another evaluation warning on the console while `slow` is in flight.
    await emailRules._evaluateMatch(ruleOf({ id: 42, name: 'other', match_mode: 'code', match_config: { code: 'throw new Error("not mine")' } }), emailEnvelope());
    const seen = await slow;
    expect(seen.value).toBe(false);
    expect(seen.note).toMatch(/mine/);
    expect(seen.note).not.toMatch(/not mine/);
  });
});
