'use strict';
/**
 * tests/pageLandingSubmit.mysql.test.js
 *
 * A landing-page form post on a real MySQL 8 with the production schema, end
 * to end through the queue (routes/pageLanding.js queueSubmission,
 * 2026-11-19). tests/pageLanding.submitQueue.test.js pins the route's order on
 * mocks; this shows what those cannot:
 *   - the visitor's 303 arrives with the hook_executions row already written
 *     QUEUED (received, claimed_at NULL, attempts 0) holding the FLAT landing
 *     envelope, the doorbell rung with that row's id, and nothing run yet;
 *   - lib/hookDrain.drainOne claims that row and the real pipeline runs a code
 *     filter on the flat shape (`input._page`) in the guest and delivers once;
 *     a second doorbell finds it already claimed;
 *   - THE REASON FOR THE CHANGE: a landing row whose code filter finds the
 *     sandbox busy is RE-QUEUED by the drain and delivered on the next one.
 *     On the old detached executeHook path that BUSY was final — the
 *     execution read 'failed' and the lead was never delivered.
 * Real route, real hookService, real guest engine, real drain. Mocked at the
 * boundary: actionDispatchers.dispatch (a recorder — nothing starts a
 * workflow) and taskQueue.enqueueHookExecutionDispatch (a recorder — no Cloud
 * Tasks).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Its own database (a twin family that loads the whole ref/database.sql —
 * never share it with a twin that rebuilds its own tables):
 *   mysql -uroot -e "CREATE DATABASE yc_lpsubmit_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_lpsubmit_test < ref/database.sql
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3398/yc_lpsubmit_test npx jest tests/pageLandingSubmit.mysql.test.js
 * The database name must end in _test: this suite DELETEs from the page and
 * hook tables. NEVER point it at 127.0.0.1:3306 on a dev machine — that is
 * production through the Cloud SQL proxy.
 */

// The hooks lane waits 10 s by default; the BUSY case holds both slots for
// 4 s, so the waiter must give up sooner.
process.env.GUEST_CODE_QUEUE_WAIT_MS_HOOKS = process.env.GUEST_CODE_QUEUE_WAIT_MS_HOOKS || '1000';
const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const mockDispatched = [];
const mockRung = [];
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
jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueHookExecutionDispatch: jest.fn(async (id) => { mockRung.push(id); return true; }) };
});

jest.setTimeout(30000);

maybe('a landing-page submission on real MySQL', () => {
  const express = require('express');
  const mysql = require('mysql2/promise');
  let pool; let server; let base; let ipSeq = 0;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const submit = (slug, body) => fetch(`${base}/p/${slug}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.1.1.${++ipSeq}` },
    body,
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
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/pageLanding'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) { if (server.closeAllConnections) server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    delete process.env.HOOK_ASYNC_ACK;
    mockDispatched.length = 0;
    mockRung.length = 0;
    for (const t of ['hook_delivery_logs', 'hook_executions', 'hook_targets', 'hooks', 'pages']) await q(`DELETE FROM ${t}`);
    await q(`INSERT INTO hooks (id, slug, name, auth_type, filter_mode, filter_config) VALUES (5, 'lp-ch7', 'lp', 'none', 'code', ?)`,
      [JSON.stringify({ code: "return input._page === 'ch7';" })]);
    await q(`INSERT INTO hook_targets (id, hook_id, target_type, name, position, config) VALUES (50, 5, 'workflow', 'wf', 0, ?)`,
      [JSON.stringify({ workflow_id: 7 })]);
    await q(`INSERT INTO pages (id, slug, html, status, hook_slug, thankyou_url) VALUES (1, 'ch7', '<h1>CH7</h1>', 'live', 'lp-ch7', 'thanks')`);
  });

  test('the 303 arrives with the row queued; the drain runs the flat envelope through the filter and delivers once', async () => {
    const hookDrain = require('../lib/hookDrain');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await submit('ch7', 'name=Ann+Lee&phone=5551234&website=');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/p/thanks');

      // Already written when the visitor got the answer — and nothing ran.
      const rows = await q('SELECT id, hook_id, slug, status, claimed_at, completed_at, attempts, filter_passed, dedup_key, raw_input FROM hook_executions');
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({ hook_id: 5, slug: 'lp-ch7', status: 'received', claimed_at: null, completed_at: null, attempts: 0, filter_passed: null, dedup_key: null });
      const raw = typeof row.raw_input === 'string' ? JSON.parse(row.raw_input) : row.raw_input;
      expect(raw).toMatchObject({ name: 'Ann Lee', phone: '5551234', _page: 'ch7', _ip: expect.stringMatching(/^10\.1\.1\./) });
      expect(raw).not.toHaveProperty('body');
      expect(mockRung).toEqual([row.id]);
      expect(mockDispatched).toEqual([]);

      const first = await hookDrain.drainOne(pool, row.id);
      expect(first).toEqual({ processed: 1, results: [{ id: row.id, status: 'delivered' }] });
      const [done] = await q('SELECT status, attempts, filter_passed, claimed_at IS NOT NULL AS claimed, completed_at IS NOT NULL AS completed FROM hook_executions');
      expect(done).toEqual({ status: 'delivered', attempts: 1, filter_passed: 1, claimed: 1, completed: 1 });
      expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 50, output: expect.objectContaining({ name: 'Ann Lee', _page: 'ch7' }) }]);
      expect(await q('SELECT target_id, status FROM hook_delivery_logs')).toEqual([{ target_id: 50, status: 'queued' }]);

      expect(await hookDrain.drainOne(pool, row.id)).toEqual({ processed: 0, results: [{ id: row.id, status: 'already_claimed' }] });
      expect(mockDispatched).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  test('a busy sandbox no longer loses the lead: the drain re-queues the landing row and the next drain delivers it', async () => {
    const guestCode = require('../lib/guestCode');
    const hookDrain = require('../lib/hookDrain');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await submit('ch7', 'name=Bo+Ray');
      expect(res.status).toBe(303);
      const [queued] = await q('SELECT id FROM hook_executions');

      const SLOW = 'var t = Date.now(); while (Date.now() - t < input.ms) {} return true;';
      const floods = [0, 1].map(() => guestCode.runBodies(SLOW, [{ ms: 4000 }], { lane: 'hooks', timeoutMs: 10000 }));
      expect(guestCode._poolState().active.hooks).toBe(2);
      const first = await hookDrain.drainOne(pool, queued.id);
      expect(first).toEqual({ processed: 1, results: [{ id: queued.id, status: 'requeued', attempts: 1 }] });
      const [requeued] = await q('SELECT status, claimed_at, attempts, filter_passed, error FROM hook_executions');
      expect(requeued).toMatchObject({ status: 'received', claimed_at: null, attempts: 1, filter_passed: null });
      expect(requeued.error).toMatch(/GUEST_CODE_BUSY.*re-queued for the next drain \(attempt 1 of 3\)$/);
      expect(mockDispatched).toEqual([]);
      await Promise.all(floods);

      const second = await hookDrain.drainOne(pool, queued.id);
      expect(second).toEqual({ processed: 1, results: [{ id: queued.id, status: 'delivered' }] });
      expect(mockDispatched).toEqual([{ type: 'workflow', target_id: 50, output: expect.objectContaining({ name: 'Bo Ray', _page: 'ch7' }) }]);
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  test("kill switch hook_async_ack='0': the old path — a row written CLAIMED, so the drain never takes it a second time", async () => {
    const hookDrain = require('../lib/hookDrain');
    process.env.HOOK_ASYNC_ACK = '0';
    require('../lib/firmConfig')._test({ resetCache: true });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await submit('ch7', 'name=Cy');
      expect(res.status).toBe(303);
      expect(mockRung).toEqual([]);
      // detached: wait (bounded) for the pipeline to finish on its own
      let row;
      for (let i = 0; i < 100; i++) {
        [row] = await q('SELECT id, status, claimed_at IS NOT NULL AS claimed FROM hook_executions');
        if (row && row.status === 'delivered') break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(row).toMatchObject({ status: 'delivered', claimed: 1 });
      expect(await hookDrain.drainBatch(pool, { graceSeconds: 0 })).toMatchObject({ processed: 0 });
      expect(mockDispatched).toHaveLength(1);
    } finally {
      delete process.env.HOOK_ASYNC_ACK;
      require('../lib/firmConfig')._test({ resetCache: true });
      log.mockRestore();
    }
  });
});
