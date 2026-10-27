'use strict';
/**
 * tests/hookTransformFailure.test.js
 *
 * A FAILED hook transform delivers nothing (2026-10-27). It used to: a code
 * transform that threw, timed out or got no sandbox slot (GUEST_CODE_BUSY,
 * the hooks lane's queue budget) came back `{ output: {}, errors }`, and
 * executeHook ignored the errors — wrote `{}` as transform_output and started
 * every condition-less target on it. Live, hooks 22 (rc-message-out → wf 53)
 * and 23 (rc-call → wf 20) are exactly that shape. Hooks now follow the
 * ingest/trigger hard semantics (AI_CONTEXT §26: never feed garbage to
 * actions). Pinned here:
 *   - runTransform: every failure kind is `failed: true` with its error —
 *     throw, timeout, a non-object return, GUEST_CODE_BUSY (tagged), an
 *     unparseable string config, a mapper whose every rule broke; a PARTIAL
 *     mapping and `return {}` still deliver;
 *   - executeHook (serial and split-phase): a failed hook transform runs NO
 *     target, writes no delivery log / retry job, and records the execution
 *     'failed' with the error and a NULL transform_output;
 *   - a failed TARGET transform skips that target only — a failed delivery
 *     log, a retry job, the execution 'partial' (or 'failed' when no target
 *     succeeded) — and executeRetry obeys the same rule;
 *   - dry runs report both failures instead of hiding them;
 *   - GUEST_CODE_BUSY end to end through the REAL receiver: the hooks lane
 *     saturated by slow bodies, the waiter's webhook answers 200, delivers
 *     nothing, and its stored raw_input replays through /live-test (failing
 *     the same way while still saturated, delivering once it is free);
 *   - a code FILTER that got no slot (BUSY) fails the execution — no
 *     decision was made — while a filter body that throws or times out is
 *     still a non-match ('filtered') (Fred, 2026-10-27);
 *   - the receiver answers 503 + Retry-After ONLY for a Quo delivery
 *     (openphone-signature) whose execution failed BUSY-only before any
 *     target ran; RingCentral, a non-BUSY failure and a partial execution
 *     stay 200;
 *   - the alert sweep: a BUSY-only failure is a warning (guestCode's own
 *     saturation alert owns the escalation), anything else an error; hook-
 *     level partial-mapper rule warnings are not counted as causes.
 *
 * HARNESS: the REAL guest engine (real forks, real QuickJS — guestCode is not
 * mocked), the real router / hookService / alerting scanner, a recording DB
 * stub (no pool exists). lib/actionDispatchers.dispatch is a recorder that
 * succeeds — nothing starts a workflow.
 *
 * Run: npx jest tests/hookTransformFailure.test.js
 */

// Read once at module load by guestCode — set before any require.
process.env.GUEST_CODE_MAX_CHILDREN = '4';
process.env.GUEST_CODE_TIMEOUT_MS = '1500';
process.env.GUEST_CODE_QUEUE_WAIT_MS_HOOKS = '300';
process.env.GUEST_CODE_QUEUE_WAIT_MS_PREVIEW = '4000';
process.env.JWT_SECRET = 'hook-transform-failure-test-secret';
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const mockDispatched = [];
jest.mock('../lib/actionDispatchers', () => {
  const actual = jest.requireActual('../lib/actionDispatchers');
  return {
    ...actual,
    dispatch: jest.fn(async (db, type, cfg, output, ctx) => {
      mockDispatched.push({ type, target_id: ctx.target.id, output });
      return { status: 'success', result: {
        target_id: ctx.target.id, request_url: `internal://${type}`, request_method: 'INTERNAL',
        request_body: JSON.stringify(output), response_status: 200, response_body: '{}',
        status: 'success', log_status: type === 'workflow' ? 'queued' : undefined, error: null,
      } };
    }),
  };
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const guestCode = require('../lib/guestCode');
const hookService = require('../services/hookService');
const alerting = require('../lib/alerting');
const router = require('../routes/api.hooks');

jest.setTimeout(60000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE = { active: { events: 0, hooks: 0, preview: 0 }, queued: { events: 0, hooks: 0, preview: 0 }, total: 0 };
const idle = async () => {
  const t = Date.now();
  while (JSON.stringify(guestCode._poolState()) !== JSON.stringify(IDLE) && Date.now() - t < 8000) await sleep(10);
  expect(guestCode._poolState()).toEqual(IDLE);
};
const until = async (pred, what) => {
  const t = Date.now();
  while (!pred(guestCode._poolState())) {
    if (Date.now() - t > 8000) throw new Error(`timed out waiting for: ${what}`);
    await sleep(5);
  }
};
const SLOW = 'var t = Date.now(); while (Date.now() - t < input.ms) {} return true;';
// Occupy both hooks slots (1 reserved + 1 borrowable with the other lanes idle).
const saturateHooks = (ms) => Array.from({ length: 2 }, () => guestCode.runBodies(SLOW, [{ ms }], { lane: 'hooks', timeoutMs: 6000 }));

const LOOP = 'while (true) {}';
const GOOD = 'return { phone: input.body.phone, kind: "call" };';

const code = (c) => ({ code: c });
function target(id, type, over = {}) {
  return {
    id, name: `t${id}`, target_type: type, position: id, active: 1,
    conditions: null, transform_mode: 'passthrough', transform_config: null,
    config: type === 'workflow' ? { workflow_id: 900 + id } : null,
    method: 'POST', url: type === 'http' ? 'https://example.test/x' : null, headers: null,
    body_mode: 'transform_output', body_template: null, credential_id: null,
    ...over,
  };
}
function hookRow(over = {}, targets = [target(1, 'workflow')]) {
  return {
    id: 22, slug: 'rc-message-out', name: 'RC out', active: 1, auth_type: 'none', auth_config: null,
    capture_mode: 'off', filter_mode: 'none', filter_config: null,
    transform_mode: 'code', transform_config: code(GOOD),
    targets, ...over,
  };
}
const INPUT = { body: { phone: '3135550100' }, headers: {}, query: {}, method: 'POST', meta: { source: 'test', slug: 'rc-message-out' } };

// Recording DB stub. Serves the hook to the receiver / live-test lookups, and
// the execution + target rows to executeRetry.
function makeDb({ hook = null, execution = null, retryTarget = null } = {}) {
  const calls = [];
  let nextExec = 500;
  return {
    calls,
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/^INSERT INTO hook_executions/.test(s)) return [{ insertId: nextExec++, affectedRows: 1 }];
      if (/SELECT \* FROM hooks WHERE slug = \? AND active = 1/.test(s)) {
        return [hook && params[0] === hook.slug ? [{ ...hook, targets: undefined }] : []];
      }
      if (/FROM hooks h LEFT JOIN users u ON h.last_modified_by = u.user WHERE h.id = \?/.test(s)) {
        return [hook ? [{ ...hook, targets: undefined }] : []];
      }
      if (/FROM hook_targets ht LEFT JOIN credentials c ON ht.credential_id = c.id WHERE ht.hook_id = \?/.test(s)) {
        return [hook ? hook.targets.map((t) => ({ ...t })) : []];
      }
      if (/SELECT \* FROM hook_executions WHERE id = \?/.test(s)) return [execution ? [execution] : []];
      if (/FROM hook_targets ht LEFT JOIN credentials c ON ht.credential_id = c.id WHERE ht.id = \?/.test(s)) {
        return [retryTarget ? [retryTarget] : []];
      }
      if (/SELECT id, attempts FROM hook_delivery_logs/.test(s)) return [[{ id: 71, attempts: 1 }]];
      if (/^(INSERT|UPDATE|DELETE)/.test(s)) return [{ affectedRows: 1, insertId: 1 }];
      return [[]];
    },
    async withTransaction(fn) { return fn({ query: this.query.bind(this) }); },
  };
}
const sqls = (db, re) => db.calls.filter((c) => re.test(c.sql));
const execUpdates = (db) => sqls(db, /^UPDATE hook_executions/);
const finalExec = (db) => { const u = execUpdates(db); return u[u.length - 1]; };

beforeEach(() => { mockDispatched.length = 0; });
afterAll(async () => { await idle(); });

// ─────────────────────────────────────────────────────────────
// runTransform — what counts as failed
// ─────────────────────────────────────────────────────────────

describe('runTransform: every failure kind is failed, with its error', () => {
  test('a throwing body', async () => {
    const r = await hookService.runTransform('code', code('throw new Error("broken body")'), INPUT);
    expect(r).toEqual({ output: {}, failed: true, errors: ['Transform code error: broken body'] });
  });

  test('a timeout (an infinite loop) — within the bound', async () => {
    const t = Date.now();
    const r = await hookService.runTransform('code', code(LOOP), INPUT);
    expect(r.failed).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Transform code error: /);
    expect(Date.now() - t).toBeLessThan(6000);
  });

  test.each([
    ['return null;', 'null'], ['return;', 'undefined'], ['return "x";', 'string'], ['return 7;', 'number'],
  ])('a non-object return (%s) is unrecognised', async (body, got) => {
    const r = await hookService.runTransform('code', code(body), INPUT);
    expect(r).toEqual({ output: {}, failed: true, errors: [`Transform code error: must return an object (got ${got})`] });
  });

  test('GUEST_CODE_BUSY: no hooks slot within the budget — tagged, the body never ran', async () => {
    const floods = saturateHooks(2000);
    await until((s) => s.active.hooks === 2, 'hooks lane full');
    const r = await hookService.runTransform('code', code(GOOD), INPUT);
    expect(r.failed).toBe(true);
    expect(r.errors).toEqual(['Transform code error [GUEST_CODE_BUSY]: code sandbox busy: no hooks slot within 300ms — failed closed, the body did not run']);
    await Promise.all(floods);
    await idle();
  });

  test('an unparseable string config fails instead of throwing out of the pipeline', async () => {
    const r = await hookService.runTransform('code', '{not json', INPUT);
    expect(r.failed).toBe(true);
    expect(r.errors[0]).toMatch(/^Transform config is not parseable JSON: /);
  });

  test('mapper: every rule broke and nothing mapped → failed', async () => {
    const r = await hookService.runTransform('mapper', [{ from: 'body.phone' }, { to: 'x' }], INPUT);
    expect(r.failed).toBe(true);
    expect(r.output).toEqual({});
    expect(r.errors).toHaveLength(2);
  });

  test('mapper: a PARTIAL mapping is usable — delivered, errors kept as warnings', async () => {
    const r = await hookService.runTransform('mapper', [{ from: 'body.phone', to: 'phone' }, { to: 'x' }], INPUT);
    expect(r.failed).toBeUndefined();
    expect(r.output).toEqual({ phone: '3135550100' });
    expect(r.errors).toHaveLength(1);
  });

  test('not failed: `return {}` (a deliberate empty result), an object, an empty mapper', async () => {
    expect(await hookService.runTransform('code', code('return {};'), INPUT)).toEqual({ output: {}, errors: [] });
    expect(await hookService.runTransform('code', code(GOOD), INPUT)).toEqual({ output: { phone: '3135550100', kind: 'call' }, errors: [] });
    expect(await hookService.runTransform('mapper', [], INPUT)).toEqual({ output: {}, errors: [] });
  });
});

// ─────────────────────────────────────────────────────────────
// executeHook — a failed HOOK transform delivers nothing
// ─────────────────────────────────────────────────────────────

const HOOK_FAILURES = [
  ['throw', 'throw new Error("boom")', /^Transform code error: boom$/],
  ['timeout', LOOP, /^Transform code error: /],
  ['null return', 'return null;', /^Transform code error: must return an object \(got null\)$/],
];

describe('executeHook: a failed hook transform runs no target and fails the execution', () => {
  for (const splitPhase of [false, true]) {
    test.each(HOOK_FAILURES)(`%s (${splitPhase ? 'split-phase' : 'serial'})`, async (_k, body, errRe) => {
      const db = makeDb();
      // Two condition-less targets, one fast one slow — the live shape is one workflow.
      const hook = hookRow({ transform_config: code(body) }, [target(1, 'workflow'), target(2, 'http')]);
      const r = await hookService.executeHook(db, hook.slug, INPUT, { hook, splitPhase });

      expect(mockDispatched).toEqual([]);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(errRe);
      expect(r.targets).toEqual([]);
      expect(r.detached).toBeUndefined();
      expect(r.transform).toEqual({ output: null, errors: [expect.stringMatching(errRe)], failed: true });
      // One UPDATE, straight to failed: never 'processing', never a `{}` output.
      expect(execUpdates(db)).toHaveLength(1);
      const u = finalExec(db);
      expect(u.sql).toContain("transform_output = NULL, status = 'failed'");
      expect(u.params[0]).toMatch(errRe);
      expect(sqls(db, /hook_delivery_logs|scheduled_jobs/)).toEqual([]);
    });
  }

  test('a healthy transform still delivers its output to every target (control)', async () => {
    const db = makeDb();
    const hook = hookRow({}, [target(1, 'workflow')]);
    const r = await hookService.executeHook(db, hook.slug, INPUT, { hook });
    expect(r.status).toBe('delivered');
    expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 1, output: { phone: '3135550100', kind: 'call' } }]);
  });

  test('mapper: partial → delivered with the errors recorded; all broken → failed, nothing delivered', async () => {
    const db1 = makeDb();
    const partial = hookRow({ transform_mode: 'mapper', transform_config: [{ from: 'body.phone', to: 'phone' }, { to: 'x' }] });
    const r1 = await hookService.executeHook(db1, partial.slug, INPUT, { hook: partial });
    expect(r1.status).toBe('delivered');
    expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 1, output: { phone: '3135550100' } }]);
    expect(finalExec(db1).params[1]).toMatch(/^Rule 1 \(→ x\): Mapping rule for "x" has no source/);

    mockDispatched.length = 0;
    const db2 = makeDb();
    const broken = hookRow({ transform_mode: 'mapper', transform_config: [{ to: 'x' }] });
    const r2 = await hookService.executeHook(db2, broken.slug, INPUT, { hook: broken });
    expect(r2.status).toBe('failed');
    expect(mockDispatched).toEqual([]);
  });

  test.each([
    ['email', '../services/emailIngestRuleService'], ['phone', '../services/phoneIngestRuleService'],
  ])('an ingest caller (%s hook_slug action) records a failed action carrying the transform error', async (_c, mod) => {
    const db = makeDb();
    const hook = hookRow({ transform_config: code('throw new Error("boom")') });
    const ret = await hookService.executeHook(db, hook.slug, INPUT, { hook });
    expect(require(mod)._normalizeHookResult(ret)).toEqual({
      status: 'failed', error: 'Transform code error: boom',
      result: { hook_execution_id: 500, hook_status: 'failed' },
    });
  });
});

// ─────────────────────────────────────────────────────────────
// A failed TARGET transform skips that target only
// ─────────────────────────────────────────────────────────────

describe('a failed target transform skips that target only', () => {
  const failing = (id, type) => target(id, type, { transform_mode: 'code', transform_config: code('throw new Error("target body")') });

  for (const splitPhase of [false, true]) {
    test(`one of two fails → the other delivers, the failure is logged + retried, execution partial (${splitPhase ? 'split-phase' : 'serial'})`, async () => {
      const db = makeDb();
      const hook = hookRow({}, [failing(1, 'http'), target(2, 'workflow')]);
      let r = await hookService.executeHook(db, hook.slug, INPUT, { hook, splitPhase });
      if (r.detached) r = await r.detached;

      expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 2, output: { phone: '3135550100', kind: 'call' } }]);
      expect(r.status).toBe('partial');
      expect(r.targets[0].delivery).toEqual(expect.objectContaining({
        target_id: 1, status: 'failed', error: 'target transform failed (nothing delivered): Transform code error: target body',
      }));
      const logs = sqls(db, /^INSERT INTO hook_delivery_logs/);
      expect(logs.map((l) => [l.params[1], l.params[7]]).sort()).toEqual([[1, 'failed'], [2, 'queued']]);
      const retries = sqls(db, /^INSERT INTO scheduled_jobs/);
      expect(retries).toHaveLength(1);
      expect(JSON.parse(retries[0].params[1])).toEqual({ execution_id: 500, target_id: 1 });
      expect(finalExec(db).params.slice(0, 1)).toEqual(['partial']);
    });
  }

  test('the only target fails → execution failed, nothing dispatched', async () => {
    const db = makeDb();
    const hook = hookRow({}, [target(1, 'workflow', { transform_mode: 'code', transform_config: code('return 3;') })]);
    const r = await hookService.executeHook(db, hook.slug, INPUT, { hook });
    expect(mockDispatched).toEqual([]);
    expect(r.status).toBe('failed');
    expect(finalExec(db).params[1]).toMatch(/^t1: target transform failed \(nothing delivered\): Transform code error: must return an object \(got number\)$/);
  });

  test('executeRetry re-runs the target transform: still failing → nothing dispatched, the log stays failed', async () => {
    const t = failing(1, 'workflow');
    const db = makeDb({ execution: { id: 500, transform_output: { phone: '3135550100' }, status: 'partial' }, retryTarget: t });
    await hookService.executeRetry(db, { execution_id: 500, target_id: 1 });
    expect(mockDispatched).toEqual([]);
    const upd = sqls(db, /^UPDATE hook_delivery_logs/);
    expect(upd).toHaveLength(1);
    expect(upd[0].params[2]).toBe('failed');
    expect(upd[0].params[3]).toMatch(/^target transform failed/);
  });

  test('executeRetry never delivers an execution whose hook transform failed (NULL transform_output)', async () => {
    const db = makeDb({ execution: { id: 501, transform_output: null, status: 'failed' }, retryTarget: target(1, 'workflow') });
    await hookService.executeRetry(db, { execution_id: 501, target_id: 1 });
    expect(mockDispatched).toEqual([]);
    expect(sqls(db, /^(INSERT|UPDATE)/)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Dry runs report the failure
// ─────────────────────────────────────────────────────────────

describe('dry run shows the error rather than hiding it', () => {
  test('hook transform failure: status failed + dry_run, the error, no target previewed, nothing written', async () => {
    const db = makeDb();
    const hook = hookRow({ transform_config: code('throw new Error("boom")') });
    const r = await hookService.executeHook(db, hook.slug, INPUT, { hook, dryRun: true });
    expect(r).toEqual(expect.objectContaining({ status: 'failed', dry_run: true, error: 'Transform code error: boom', targets: [] }));
    expect(sqls(db, /^(INSERT|UPDATE)/)).toEqual([]);
    expect(mockDispatched).toEqual([]);
  });

  test('target transform failure: that target previews as skipped with its errors, the other as usual', async () => {
    const db = makeDb();
    const hook = hookRow({}, [target(1, 'workflow', { transform_mode: 'code', transform_config: code('return null;') }), target(2, 'workflow')]);
    const r = await hookService.executeHook(db, hook.slug, INPUT, { hook, dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.targets[0]).toEqual(expect.objectContaining({
      target_id: 1, skip_reason: 'target transform failed', would_send: null, transform_output: null,
      transform_errors: ['Transform code error: must return an object (got null)'],
    }));
    expect(r.targets[1].would_send).toEqual(expect.objectContaining({ action: 'start_workflow', workflow_id: 902 }));
    expect(mockDispatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// GUEST_CODE_BUSY end to end: receiver → failed row → replay
// ─────────────────────────────────────────────────────────────

function call(db, method, urlPath, { headers = {}, body } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}
// call() with the response headers (Retry-After).
function callFull(db, method, urlPath, { headers = {}, body } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, body: j }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}
const admin = { authorization: 'Bearer ' + jwt.sign(
  { sub: 5, username: 'it', user_type: 1, user_auth: 'authorized', aud: 'staff', ver: 1, roles: ['admin', 'staff'] },
  process.env.JWT_SECRET, { expiresIn: '1h' }) };

describe('GUEST_CODE_BUSY through the receiver, then replay', () => {
  test('a saturated hooks lane: the waiter\'s webhook answers 200, delivers nothing, and replays once the lane is free', async () => {
    const hook = hookRow({ filter_mode: 'none' }, [target(1, 'workflow')]);
    const db = makeDb({ hook });

    const floods = saturateHooks(2500);
    await until((s) => s.active.hooks === 2, 'hooks lane full');
    const res = await call(db, 'POST', `/hooks/${hook.slug}`, { body: { phone: '3135550100' } });
    expect(res).toEqual({ status: 200, body: { status: 'received', slug: hook.slug } });
    expect(mockDispatched).toEqual([]);
    const failed = finalExec(db);
    expect(failed.sql).toContain("status = 'failed'");
    expect(failed.params[0]).toMatch(/^Transform code error \[GUEST_CODE_BUSY\]: code sandbox busy/);
    expect(sqls(db, /hook_delivery_logs|scheduled_jobs/)).toEqual([]);

    // The stored raw_input is the replay payload (the Logs tab → Test tab → Live Test path).
    const rawInput = JSON.parse(sqls(db, /^INSERT INTO hook_executions/)[0].params[2]);
    expect(rawInput.body).toEqual({ phone: '3135550100' });

    // Replayed while STILL saturated → the same semantics: failed, nothing delivered.
    const again = await call(db, 'POST', `/api/hooks/${hook.id}/live-test`, { headers: admin, body: { input: rawInput } });
    expect(again.status).toBe(200);
    expect(again.body.result.status).toBe('failed');
    expect(again.body.result.error).toMatch(/\[GUEST_CODE_BUSY\]/);
    expect(mockDispatched).toEqual([]);

    await Promise.all(floods);
    await idle();

    // Replayed once the lane is free → delivered, exactly once, with the real output.
    const ok = await call(db, 'POST', `/api/hooks/${hook.id}/live-test`, { headers: admin, body: { input: rawInput } });
    expect(ok.status).toBe(200);
    expect(ok.body.result.status).toBe('delivered');
    expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 1, output: { phone: '3135550100', kind: 'call' } }]);
  });
});

// ─────────────────────────────────────────────────────────────
// A code FILTER that got no sandbox slot made no decision → failed
// (Fred, 2026-10-27 — overrides "failed filter = non-match" for BUSY only)
// ─────────────────────────────────────────────────────────────

const BUSY_MSG = 'code sandbox busy: no hooks slot within 300ms — failed closed, the body did not run';
const codeFilterHook = (filterBody, over = {}, targets) =>
  hookRow({ filter_mode: 'code', filter_config: code(filterBody), ...over }, targets);

describe('runFilter: GUEST_CODE_BUSY fails (no decision); a body that ran and broke is still a non-match', () => {
  test('BUSY → failed + busy, error tagged like the transform\'s', async () => {
    const floods = saturateHooks(2000);
    await until((s) => s.active.hooks === 2, 'hooks lane full');
    const r = await hookService.runFilter(codeFilterHook('return true;'), INPUT);
    expect(r).toEqual({ passed: false, failed: true, busy: true, error: `Filter code error [GUEST_CODE_BUSY]: ${BUSY_MSG}` });
    await Promise.all(floods);
    await idle();
  });

  test.each([
    ['a throw', 'throw new Error("nope")', /^Filter code error: nope$/],
    ['a timeout', LOOP, /^Filter code error: /],
  ])('%s → filtered (passed:false + error), never failed', async (_k, body, re) => {
    const r = await hookService.runFilter(codeFilterHook(body), INPUT);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(re);
    expect(r.failed).toBeUndefined();
    expect(r.busy).toBeUndefined();
  });
});

describe('executeHook: a BUSY filter fails the execution, nothing runs after it', () => {
  for (const splitPhase of [false, true]) {
    test(`BUSY filter → failed, filter_passed NULL, no transform, no target (${splitPhase ? 'split-phase' : 'serial'})`, async () => {
      const floods = saturateHooks(2000);
      await until((s) => s.active.hooks === 2, 'hooks lane full');
      const db = makeDb();
      const hook = codeFilterHook('return true;', {}, [target(1, 'workflow'), target(2, 'http')]);
      const r = await hookService.executeHook(db, hook.slug, INPUT, { hook, splitPhase });
      await Promise.all(floods);
      await idle();

      expect(mockDispatched).toEqual([]);
      expect(r).toEqual(expect.objectContaining({ status: 'failed', error: `Filter code error [GUEST_CODE_BUSY]: ${BUSY_MSG}`, targets: [] }));
      expect(r.transform).toBeUndefined();
      expect(r.detached).toBeUndefined();
      expect(r.redeliver).toBeUndefined(); // no redeliverOnBusy from a caller that is not the Quo receiver
      expect(execUpdates(db)).toHaveLength(1);
      expect(finalExec(db).sql).toContain("filter_passed = NULL, status = 'failed'");
      expect(finalExec(db).params).toEqual([`Filter code error [GUEST_CODE_BUSY]: ${BUSY_MSG}`, 500]);
      expect(sqls(db, /hook_delivery_logs|scheduled_jobs/)).toEqual([]);
    });
  }

  test('a filter body that throws still records filtered (filter_passed 0), not failed', async () => {
    const db = makeDb();
    const hook = codeFilterHook('throw new Error("nope")');
    const r = await hookService.executeHook(db, hook.slug, INPUT, { hook });
    expect(r.status).toBe('filtered');
    expect(finalExec(db).sql).toContain("filter_passed = 0, status = 'filtered'");
    expect(mockDispatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// The receiver answers 503 ONLY for Quo, ONLY when nothing was dispatched
// ─────────────────────────────────────────────────────────────

const QUO = { 'openphone-signature': 'hmac;1;1761530000000;dGVzdA==', 'user-agent': 'node' };
const RC = { 'user-agent': 'RingCentral-WebHook' };

describe('receiver: 503 + Retry-After for a BUSY-only Quo failure, 200 for everything else', () => {
  async function postSaturated(hook, headers) {
    const db = makeDb({ hook });
    const floods = saturateHooks(2000);
    await until((s) => s.active.hooks === 2, 'hooks lane full');
    const res = await callFull(db, 'POST', `/hooks/${hook.slug}`, { headers, body: { phone: '3135550100' } });
    await Promise.all(floods);
    await idle();
    return { db, res };
  }

  test('Quo, hook transform BUSY → 503, Retry-After 60, nothing dispatched, the row says it was answered 503', async () => {
    const { db, res } = await postSaturated(hookRow({ slug: 'quo-message' }), QUO);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toEqual({ status: 'error', message: 'Temporarily unavailable — retry shortly' });
    expect(mockDispatched).toEqual([]);
    const u = finalExec(db);
    expect(u.sql).toContain("transform_output = NULL, status = 'failed'");
    expect(u.params[0]).toMatch(/^Transform code error \[GUEST_CODE_BUSY\]: code sandbox busy.* — answered 503, the sender redelivers this event as a new execution/);
    expect(u.params[0]).not.toContain('; ');
    expect(sqls(db, /hook_delivery_logs|scheduled_jobs/)).toEqual([]);
  });

  test('Quo, code filter BUSY → 503, nothing ran after the filter', async () => {
    const { db, res } = await postSaturated(codeFilterHook('return true;', { slug: 'quo-call' }), QUO);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(mockDispatched).toEqual([]);
    expect(finalExec(db).sql).toContain("filter_passed = NULL, status = 'failed'");
    expect(finalExec(db).params[0]).toMatch(/^Filter code error \[GUEST_CODE_BUSY\]: .* — answered 503/);
  });

  test('RingCentral, the same BUSY failure → 200 (a non-2xx risks the subscription), no 503 note', async () => {
    const { db, res } = await postSaturated(hookRow({ slug: 'rc-call' }), RC);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received', slug: 'rc-call' });
    expect(mockDispatched).toEqual([]);
    expect(finalExec(db).params[0]).toBe(`Transform code error [GUEST_CODE_BUSY]: ${BUSY_MSG}`);
  });

  test('Quo, a NON-busy failure (a body that throws) → 200: a redelivery would fail the same way', async () => {
    const hook = hookRow({ slug: 'quo-message', transform_config: code('throw new Error("boom")') });
    const db = makeDb({ hook });
    const res = await callFull(db, 'POST', `/hooks/${hook.slug}`, { headers: QUO, body: { phone: '3135550100' } });
    expect(res.status).toBe(200);
    expect(finalExec(db).params[0]).toBe('Transform code error: boom');
  });

  test('Quo, a PARTIAL execution (one target BUSY, one delivered) → 200: a redelivery would duplicate the delivered one', async () => {
    const busyTarget = target(1, 'workflow', { transform_mode: 'code', transform_config: code('return { a: 1 };') });
    const { res } = await postSaturated(hookRow({ slug: 'quo-message', transform_mode: 'passthrough', transform_config: null },
      [busyTarget, target(2, 'workflow')]), QUO);
    expect(res.status).toBe(200);
    expect(mockDispatched.map((d) => d.target_id)).toEqual([2]);
  });

  test('Quo, healthy → 200 and delivered (control)', async () => {
    const hook = hookRow({ slug: 'quo-message' });
    const db = makeDb({ hook });
    const res = await callFull(db, 'POST', `/hooks/${hook.slug}`, { headers: QUO, body: { phone: '3135550100' } });
    expect(res.status).toBe(200);
    expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 1, output: { phone: '3135550100', kind: 'call' } }]);
  });
});

// ─────────────────────────────────────────────────────────────
// Alert sweep severity
// ─────────────────────────────────────────────────────────────

describe('_scanHooks severity (alert severity convention)', () => {
  const scan = async (rows) => {
    const db = { query: async () => [rows] };
    return (await alerting._scanHooks(db, 0)).rows.map((r) => r.severity);
  };
  const BUSY = 'Transform code error [GUEST_CODE_BUSY]: code sandbox busy: no hooks slot within 3000ms — failed closed, the body did not run';

  test('a BUSY-only failure is a warning — guestCode\'s saturation alert owns the escalation', async () => {
    expect(await scan([{ id: 1, hook_id: 22, slug: 'rc-message-out', status: 'failed', error: BUSY }])).toEqual(['warning']);
    // A target-level BUSY (partial, retried) carries the tag inside its target prefix.
    expect(await scan([{ id: 2, hook_id: 22, slug: 'x', status: 'partial', error: `t1: target transform failed (nothing delivered): ${BUSY}` }])).toEqual(['warning']);
  });

  test('a BUSY filter failure, and a BUSY row answered 503, are warnings', async () => {
    expect(await scan([
      { id: 8, hook_id: 17, slug: 'quo-call', status: 'failed', error: `Filter code error [GUEST_CODE_BUSY]: ${BUSY.replace(/^Transform code error \[GUEST_CODE_BUSY\]: /, '')}` },
      { id: 9, hook_id: 16, slug: 'quo-message', status: 'failed', error: `${BUSY} — answered 503, the sender redelivers this event as a new execution (replay by hand only if no later execution of it delivered)` },
    ])).toEqual(['warning', 'warning']);
  });

  test('hook-level partial-mapper rule warnings in front of a BUSY target are not causes → warning; an all-broken mapper alone → error', async () => {
    expect(await scan([
      { id: 10, hook_id: 3, slug: 'x', status: 'partial', error: `Rule 1 (→ x): Mapping rule for "x" has no source; Rule 3: missing "to" field; t1: target transform failed (nothing delivered): ${BUSY}` },
      { id: 11, hook_id: 3, slug: 'x', status: 'failed', error: 'Rule 0: missing "to" field' },
      { id: 12, hook_id: 3, slug: 'x', status: 'partial', error: 'Rule 1 (→ x): Mapping rule for "x" has no source; t1: HTTP 500' },
    ])).toEqual(['warning', 'error', 'error']);
  });

  test('a body error, a non-object return, a broken target, or BUSY mixed with any of them is an error', async () => {
    expect(await scan([
      { id: 3, hook_id: 23, slug: 'rc-call', status: 'failed', error: 'Transform code error: boom' },
      { id: 4, hook_id: 23, slug: 'rc-call', status: 'failed', error: 'Transform code error: must return an object (got null)' },
      { id: 5, hook_id: 23, slug: 'rc-call', status: 'partial', error: 't2: workflow #20 is inactive' },
      { id: 6, hook_id: 23, slug: 'rc-call', status: 'partial', error: `t1: target transform failed (nothing delivered): ${BUSY}; t2: HTTP 500` },
      { id: 7, hook_id: 23, slug: 'rc-call', status: 'failed', error: null },
    ])).toEqual(['error', 'error', 'error', 'error', 'error']);
  });
});
