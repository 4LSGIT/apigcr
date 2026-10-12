/**
 * tests/hookSpoolReplay.mysql.test.js
 *
 * Maintenance capture → replay, END TO END on a real MySQL 8 with the
 * production schema. Nothing of ours is mocked: the real gate
 * (lib/maintenance.js), the real receiver (routes/api.hooks.js), the real
 * spool (lib/hookSpool.js — only the Cloud Tasks CLIENT is a fake that keeps
 * tasks in memory), the real replay route behind the real jwtOrApiKey, and
 * the real pipeline (services/hookService.executeHook).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * CI has no MySQL; the mocked suites (hookReceiver.maintenance,
 * hookReplay.routes) run everywhere. This file exists for what they cannot
 * show, because hookService is mocked on both of their sides:
 *
 *   THE IDEMPOTENCY JOIN. The replay route decides "already ran" by reading
 *   meta.spool_id back out of hook_executions.raw_input with a JSON path. That
 *   only works if what executeHook WRITES and what the route READS agree — the
 *   column type, the JSON path, the created_at window against the engine's
 *   clock. A drift on either side passes every mocked test and runs every
 *   redelivered webhook twice.
 *
 * Setup (same shape as tests/mailboxS2.mysql.test.js):
 *   mysql -uroot -e "CREATE DATABASE yc_spool_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_spool_test < ref/database.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_spool_test npx jest tests/hookSpoolReplay.mysql.test.js
 *
 * The database name must end in _test: this suite DELETEs from the hook tables.
 * Run 2026-10-12: MySQL 8.0.46, all green. Mutation-checked HERE (the mocked
 * suites cannot see these): the route reading the wrong JSON path or a window
 * that excludes fresh rows; executeHook storing the input without `meta`, in
 * the normal row or the capture-mode row; the receiver spooling before it
 * authenticates; the replay resolving the wrong hook; no idempotency at all.
 * Spool-failure → 503, JWT → 403 and pipeline-throw → 500 are the mocked
 * suites' job (tests/hookReceiver.maintenance, tests/hookReplay.routes).
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'hook-spool-mysql-secret';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const INTERNAL_KEY = 'yci_spool_mysql_internal';

maybe('hook spool: capture → replay on real MySQL', () => {
  const express = require('express');
  const mysql = require('mysql2/promise');
  const maintenance = require('../lib/maintenance');
  const hookSpool = require('../lib/hookSpool');

  let pool; let server; let base; let tasks; let logSpy; let errSpy; let warnSpy;
  const ENV_KEYS = ['MAINTENANCE_MODE', 'CLOUD_TASKS_LOCATION', 'CLOUD_TASKS_SPOOL_QUEUE',
                    'CLOUD_TASKS_TARGET_URL', 'APP_URL', 'INTERNAL_API_KEY'];
  const saved = {};
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const settle = () => new Promise((r) => setTimeout(r, 150));   // fire-and-forget audit inserts

  // In-memory stand-in for the Cloud Tasks service: stores what put() sends.
  const fakeClient = () => ({
    queuePath: (p, l, qn) => `projects/${p}/locations/${l}/queues/${qn}`,
    taskPath: (p, l, qn, t) => `projects/${p}/locations/${l}/queues/${qn}/tasks/${t}`,
    getProjectId: async () => 'test-proj',
    createTask: async ({ task }) => {
      if (tasks.some((t) => t.name === task.name)) throw Object.assign(new Error('exists'), { code: 6 });
      tasks.push({ name: task.name, url: task.httpRequest.url, headers: task.httpRequest.headers, body: Buffer.from(task.httpRequest.body) });
      return [{ name: task.name }];
    },
  });
  // What Cloud Tasks does on resume: POST the stored request as-is.
  const deliver = (t) => fetch(base + new URL(t.url).pathname, { method: 'POST', headers: t.headers, body: t.body })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const fire = (slug, body = { lead: 'Jane' }, headers = {}) =>
    fetch(`${base}/hooks/${slug}?src=web`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const rawInput = (row) => (typeof row.raw_input === 'string' ? JSON.parse(row.raw_input) : row.raw_input);

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const app = express();
    // server.js order: gate → /hooks parser → (global parser) → req.db → routes
    app.use(maintenance.gate());
    app.use('/hooks', express.json());
    app.use(express.json({ limit: '10mb' }));
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.hooks'));
    app.use(require('../routes/internal/hookReplay'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await settle();
    if (server) { if (server.closeAllConnections) server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.CLOUD_TASKS_LOCATION = 'us-east1';
    process.env.APP_URL = 'https://app.example.test';
    process.env.INTERNAL_API_KEY = INTERNAL_KEY;
    tasks = [];
    hookSpool._test({ client: fakeClient() });
    await settle();
    for (const t of ['hook_delivery_logs', 'hook_executions', 'hook_targets', 'hooks', 'jwt_api_audit_log', 'system_alerts', 'alert_state']) {
      await q(`DELETE FROM ${t}`);
    }
    await q(`INSERT INTO hooks (id, slug, name, auth_type) VALUES (1, 'open-hook', 'open', 'none')`);
    await q(`INSERT INTO hooks (id, slug, name, auth_type, auth_config) VALUES (2, 'keyed-hook', 'keyed', 'api_key', ?)`,
      [JSON.stringify({ header: 'x-hook-key', key: 'k123' })]);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    hookSpool._test({ client: null });
    logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore();
  });

  test('capture writes NOTHING; replay writes exactly one execution; redelivery is a no-op', async () => {
    // ── the freeze
    process.env.MAINTENANCE_MODE = '1';
    const res = await fire('open-hook');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'open-hook' });
    await settle();
    expect(tasks).toHaveLength(1);
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 0 }]);
    expect(await q('SELECT COUNT(*) n FROM jwt_api_audit_log')).toEqual([{ n: 0 }]);

    // a queue resumed DURING the freeze bounces off the gate and runs nothing
    const early = await deliver(tasks[0]);
    expect(early.status).toBe(503);
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 0 }]);

    // ── after the freeze
    delete process.env.MAINTENANCE_MODE;
    const first = await deliver(tasks[0]);
    expect(first.status).toBe(200);
    expect(first.json.status).toBe('replayed');

    const rows = await q('SELECT id, hook_id, slug, raw_input FROM hook_executions');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(Number(first.json.execution_id));
    const stored = rawInput(rows[0]);
    const sent = JSON.parse(tasks[0].body.toString('utf8'));
    expect(stored.meta.spool_id).toBe(sent.spool_id);
    expect(stored.meta.spooled).toBe(true);
    expect(stored.meta.received_at).toBe(sent.input.meta.received_at);   // the ORIGINAL arrival time
    expect(Number.isNaN(Date.parse(stored.meta.replayed_at))).toBe(false);
    expect(stored.body).toEqual({ lead: 'Jane' });
    expect(stored.query).toEqual({ src: 'web' });

    // ── Cloud Tasks delivers at least once
    for (let i = 0; i < 3; i++) {
      const again = await deliver(tasks[0]);
      expect(again.status).toBe(200);
      expect(again.json).toEqual({ status: 'already_replayed', spool_id: sent.spool_id, execution_id: rows[0].id });
    }
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 1 }]);
  });

  test('two captured events of the same hook are two executions — the dedupe is per spool_id, not per hook', async () => {
    process.env.MAINTENANCE_MODE = '1';
    await fire('open-hook', { n: 1 });
    await fire('open-hook', { n: 2 });
    delete process.env.MAINTENANCE_MODE;
    expect(tasks).toHaveLength(2);
    for (const t of tasks) expect((await deliver(t)).json.status).toBe('replayed');
    const rows = await q('SELECT raw_input FROM hook_executions ORDER BY id');
    expect(rows.map((r) => rawInput(r).body.n)).toEqual([1, 2]);
    for (const t of tasks) expect((await deliver(t)).json.status).toBe('already_replayed');
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 2 }]);
  });

  test('live executions (no spool_id, NULL raw_input) in the table neither break nor satisfy the dedupe', async () => {
    await q(`INSERT INTO hook_executions (hook_id, slug, raw_input, status) VALUES (1, 'open-hook', NULL, 'received')`);
    await q(`INSERT INTO hook_executions (hook_id, slug, raw_input, status) VALUES (1, 'open-hook', '[1,2]', 'received')`);
    await q(`INSERT INTO hook_executions (hook_id, slug, raw_input, status) VALUES (1, 'open-hook', '"just a string"', 'received')`);
    expect((await fire('open-hook', { live: true })).status).toBe(200);   // a live event, maintenance off
    await settle();
    process.env.MAINTENANCE_MODE = '1';
    await fire('open-hook', { spooled: true });
    delete process.env.MAINTENANCE_MODE;
    const r = await deliver(tasks[0]);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('replayed');
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 5 }]);
  });

  test('a capture-mode hook: untouched during the freeze, captures the replayed event afterwards', async () => {
    await q(`UPDATE hooks SET capture_mode = 'capturing' WHERE id = 1`);
    process.env.MAINTENANCE_MODE = '1';
    const res = await fire('open-hook', { sample: 1 });
    expect(await res.json()).toEqual({ status: 'received', slug: 'open-hook' });
    expect(await q('SELECT capture_mode, captured_at FROM hooks WHERE id = 1')).toEqual([{ capture_mode: 'capturing', captured_at: null }]);
    delete process.env.MAINTENANCE_MODE;

    const first = await deliver(tasks[0]);
    expect(first.json).toMatchObject({ status: 'replayed', result: 'captured' });
    const [hook] = await q('SELECT capture_mode FROM hooks WHERE id = 1');
    expect(hook.capture_mode).toBe('off');
    const [exec] = await q('SELECT id, status FROM hook_executions');
    expect(exec.status).toBe('captured');
    // the captured row carries the spool_id too, so a redelivery is still a no-op
    expect((await deliver(tasks[0])).json).toMatchObject({ status: 'already_replayed', execution_id: exec.id });
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 1 }]);
  });

  test('authentication is judged at capture: a wrong key stores nothing; a right key replays without it', async () => {
    process.env.MAINTENANCE_MODE = '1';
    expect((await fire('keyed-hook', { x: 1 })).status).toBe(401);
    expect((await fire('keyed-hook', { x: 1 }, { 'x-hook-key': 'wrong' })).status).toBe(401);
    expect(tasks).toHaveLength(0);
    expect((await fire('keyed-hook', { x: 2 }, { 'x-hook-key': 'k123' })).status).toBe(200);
    expect(tasks).toHaveLength(1);
    delete process.env.MAINTENANCE_MODE;
    expect((await deliver(tasks[0])).json.status).toBe('replayed');
    const [row] = await q('SELECT hook_id, raw_input FROM hook_executions');
    expect(row.hook_id).toBe(2);
    expect(rawInput(row).body).toEqual({ x: 2 });
  });

  test('replay refuses anything but the internal key, and then nothing runs', async () => {
    process.env.MAINTENANCE_MODE = '1';
    await fire('open-hook');
    delete process.env.MAINTENANCE_MODE;
    const t = tasks[0];
    const noKey = await deliver({ ...t, headers: { 'content-type': 'application/json' } });
    expect(noKey.status).toBe(401);
    const wrongKey = await deliver({ ...t, headers: { 'content-type': 'application/json', 'x-api-key': 'yck_not_the_internal_key' } });
    expect(wrongKey.status).toBe(401);
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 0 }]);
    // …and the task is still good once the right key is presented
    expect((await deliver(t)).json.status).toBe('replayed');
  });

  test('hook deleted between capture and replay, no catch-all: dropped once, alerted, payload in the log', async () => {
    process.env.MAINTENANCE_MODE = '1';
    await fire('open-hook', { lead: 'only copy' });
    delete process.env.MAINTENANCE_MODE;
    await q('UPDATE hooks SET active = 0 WHERE id = 1');
    const r = await deliver(tasks[0]);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('dropped_no_hook');
    await settle();
    expect(await q('SELECT COUNT(*) n FROM hook_executions')).toEqual([{ n: 0 }]);
    const alerts = await q(`SELECT kind, severity FROM system_alerts WHERE kind = 'spool_replay_dropped'`);
    expect(alerts).toEqual([{ kind: 'spool_replay_dropped', severity: 'error' }]);
    const line = errSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('DROPPED spooled event'));
    expect(line).toContain('"lead":"only copy"');
  });

  test('…with a catch-all hook the same event is kept: executed under the catch-all, attempted slug preserved', async () => {
    await q(`INSERT INTO hooks (id, slug, name, auth_type) VALUES (3, '_catchall', 'catch-all', 'none')`);
    process.env.MAINTENANCE_MODE = '1';
    await fire('open-hook', { lead: 'kept' });
    delete process.env.MAINTENANCE_MODE;
    await q('UPDATE hooks SET active = 0 WHERE id = 1');
    expect((await deliver(tasks[0])).json.status).toBe('replayed');
    expect(await q('SELECT hook_id, slug FROM hook_executions')).toEqual([{ hook_id: 3, slug: 'open-hook' }]);
  });
});
