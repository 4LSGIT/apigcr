'use strict';
/**
 * tests/hookTransformFailure.mysql.test.js
 *
 * A failed hook transform delivers nothing — the ROW SHAPE on a real MySQL 8
 * with the production schema (tests/hookTransformFailure.test.js pins the
 * logic on a recording stub, which cannot show these):
 *   - the receiver's failed execution lands as status 'failed' (enum), the
 *     error text, filter_passed 1, and a SQL NULL transform_output (the JSON
 *     column) — not `{}`, not the JSON literal null;
 *   - executeRetry reading that row back gets a JS null from mysql2 and
 *     delivers nothing;
 *   - a failed TARGET transform persists a 'failed' delivery-log row and a
 *     pending hook_retry job, and the execution reads 'partial';
 *   - a Quo event whose code filter got no sandbox slot is answered 503 and
 *     lands 'failed' with filter_passed SQL NULL (no decision) and the 503
 *     note on the error, nothing delivered.
 * Real receiver, real hookService, real guest engine; actionDispatchers.dispatch
 * is a recorder (nothing starts a workflow).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   mysql -uroot -e "CREATE DATABASE yc_hookfail_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_hookfail_test < ref/database.sql
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3399/yc_hookfail_test npx jest tests/hookTransformFailure.mysql.test.js
 * The database name must end in _test: this suite DELETEs from the hook tables.
 * NEVER point it at 127.0.0.1:3306 on a dev machine — that is production
 * through the Cloud SQL proxy.
 */

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

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
        status: 'success', log_status: 'queued', error: null,
      } };
    }),
  };
});

jest.setTimeout(30000);

maybe('a failed hook transform on real MySQL', () => {
  const express = require('express');
  const mysql = require('mysql2/promise');
  const hookService = require('../services/hookService');
  let pool; let server; let base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const fire = (slug, body) => fetch(`${base}/hooks/${slug}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    if (Number(u.port || 3306) === 3306 && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) {
      throw new Error('refusing 127.0.0.1:3306 — on a dev machine that is production (Cloud SQL proxy)');
    }
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.hooks'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) { if (server.closeAllConnections) server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    mockDispatched.length = 0;
    for (const t of ['hook_delivery_logs', 'hook_executions', 'hook_targets', 'hooks']) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM scheduled_jobs WHERE type = 'hook_retry'`);
  });

  test('hook transform throws → a failed row with a SQL-NULL output; a retry naming it delivers nothing', async () => {
    await q(`INSERT INTO hooks (id, slug, name, auth_type, transform_mode, transform_config) VALUES (1, 'bad-tf', 'bad', 'none', 'code', ?)`,
      [JSON.stringify({ code: 'throw new Error("boom")' })]);
    await q(`INSERT INTO hook_targets (id, hook_id, target_type, name, position, config) VALUES (10, 1, 'workflow', 'wf', 0, ?)`,
      [JSON.stringify({ workflow_id: 53 })]);

    const res = await fire('bad-tf', { a: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'bad-tf' });

    const rows = await q(`SELECT id, status, filter_passed, error, transform_output IS NULL AS out_null,
                                 JSON_TYPE(transform_output) AS out_type FROM hook_executions`);
    expect(rows).toEqual([{ id: expect.any(Number), status: 'failed', filter_passed: 1,
      error: 'Transform code error: boom', out_null: 1, out_type: null }]);
    expect(await q('SELECT COUNT(*) n FROM hook_delivery_logs')).toEqual([{ n: 0 }]);
    expect(await q(`SELECT COUNT(*) n FROM scheduled_jobs WHERE type = 'hook_retry'`)).toEqual([{ n: 0 }]);
    expect(mockDispatched).toEqual([]);

    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await hookService.executeRetry(pool, { execution_id: rows[0].id, target_id: 10 });
    } finally { err.mockRestore(); }
    expect(mockDispatched).toEqual([]);
    expect(await q('SELECT COUNT(*) n FROM hook_delivery_logs')).toEqual([{ n: 0 }]);
  });

  test('a target transform returns null → that target logs failed + a pending retry, the other delivers, execution partial', async () => {
    await q(`INSERT INTO hooks (id, slug, name, auth_type) VALUES (2, 'two-t', 'two', 'none')`);
    await q(`INSERT INTO hook_targets (id, hook_id, target_type, name, position, config, transform_mode, transform_config)
             VALUES (20, 2, 'workflow', 'broken', 0, ?, 'code', ?), (21, 2, 'workflow', 'fine', 1, ?, 'passthrough', NULL)`,
      [JSON.stringify({ workflow_id: 1 }), JSON.stringify({ code: 'return null;' }), JSON.stringify({ workflow_id: 2 })]);

    const res = await fire('two-t', { a: 1 });
    expect(res.status).toBe(200);
    expect(mockDispatched.map((d) => d.target_id)).toEqual([21]);

    const [ex] = await q('SELECT id, status, error FROM hook_executions');
    expect(ex.status).toBe('partial');
    expect(ex.error).toBe('broken: target transform failed (nothing delivered): Transform code error: must return an object (got null)');
    expect(await q('SELECT target_id, status FROM hook_delivery_logs ORDER BY target_id')).toEqual([
      { target_id: 20, status: 'failed' }, { target_id: 21, status: 'queued' },
    ]);
    const jobs = await q(`SELECT status, data FROM scheduled_jobs WHERE type = 'hook_retry'`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    const data = typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data;
    expect(data).toEqual({ execution_id: ex.id, target_id: 20 });
  });

  test('a Quo event whose code filter finds the sandbox busy → 503, a failed row with filter_passed NULL, nothing delivered', async () => {
    const guestCode = require('../lib/guestCode');
    await q(`INSERT INTO hooks (id, slug, name, auth_type, filter_mode, filter_config) VALUES (3, 'quo-busy', 'quo', 'none', 'code', ?)`,
      [JSON.stringify({ code: 'return true;' })]);
    await q(`INSERT INTO hook_targets (id, hook_id, target_type, name, position, config) VALUES (30, 3, 'workflow', 'wf', 0, ?)`,
      [JSON.stringify({ workflow_id: 7 })]);
    // Both hooks slots (1 reserved + 1 borrowable) held by slow bodies far
    // longer than the lane's 1 s budget — a slow child start only lengthens
    // the hold, so the waiter's budget is the only clock that decides.
    const SLOW = 'var t = Date.now(); while (Date.now() - t < input.ms) {} return true;';
    const floods = [0, 1].map(() => guestCode.runBodies(SLOW, [{ ms: 4000 }], { lane: 'hooks', timeoutMs: 10000 }));
    expect(guestCode._poolState().active.hooks).toBe(2);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let res;
    try {
      res = await fetch(`${base}/hooks/quo-busy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'openphone-signature': 'hmac;1;1;dGVzdA==' },
        body: JSON.stringify({ id: 'EVtest', object: 'event' }),
      });
    } finally { warn.mockRestore(); }
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    const rows = await q('SELECT status, filter_passed, error, transform_output IS NULL AS out_null FROM hook_executions');
    expect(rows).toEqual([{ status: 'failed', filter_passed: null, out_null: 1,
      error: expect.stringMatching(/^Filter code error \[GUEST_CODE_BUSY\]: code sandbox busy: no hooks slot within 1000ms .* — answered 503, the sender redelivers/) }]);
    expect(await q('SELECT COUNT(*) n FROM hook_delivery_logs')).toEqual([{ n: 0 }]);
    expect(mockDispatched).toEqual([]);
    await Promise.all(floods);
  });
});
