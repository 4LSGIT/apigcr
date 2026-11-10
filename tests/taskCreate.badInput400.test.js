/**
 * tests/taskCreate.badInput400.test.js
 *
 * POST /api/tasks answers a caller's bad input with 400, not 500.
 *
 * WHY: on 2026-11-10 a 1,010-char desc was refused by createTask and the route
 * answered 500, which raised a route_500 alert (system_alerts 2201) and a
 * failure-digest email for what was the caller's mistake. A real server fault
 * must still be a 500 — that half is pinned too.
 *
 * Over HTTP through the real auth middleware, with a stub pool (the auth
 * layer writes its own audit row; createTask's refusals run before any SQL).
 *
 * Run: npx jest tests/taskCreate.badInput400.test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-task-bad-input';

const express = require('express');
const jwt = require('jsonwebtoken');
const taskService = require('../services/taskService');

describe('createTask input refusals carry status 400', () => {
  const db = { query: () => { throw new Error('db must not be reached'); } };
  const cases = [
    [{ to: 5 },                                         'createTask requires title'],
    [{ title: 't' },                                    'createTask requires to'],
    [{ to: 5, title: 'x'.repeat(101) },                 'createTask: title exceeds 100 chars'],
    [{ to: 5, title: 't', desc: 'x'.repeat(1001) },     'createTask: desc exceeds 1000 chars'],
    [{ to: 5, title: 't', source: 'x'.repeat(51) },     'createTask: source exceeds 50 chars'],
  ];
  test.each(cases)('%j', async (args, message) => {
    await expect(taskService.createTask(db, args)).rejects.toMatchObject({ message, status: 400 });
  });
});

describe('POST /api/tasks', () => {
  const app = express();
  app.use(express.json());
  let pool;
  app.use((r, _res, next) => { r.db = pool; next(); });
  app.use(require('../routes/api.tasks'));

  let server;
  let base;
  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const token = jwt.sign({ sub: '6', username: 'fred', user_auth: 'authorized', aud: 'staff' }, process.env.JWT_SECRET);
  async function post(body) {
    const r = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }

  const stubPool = () => ({ query: jest.fn(async () => [[], []]) });

  test('an over-long desc is 400 with the service message, and is not logged as a route error', async () => {
    pool = stubPool();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await post({ to: 5, title: 'A task', desc: 'x'.repeat(1001) });
    expect(out.status).toBe(400);
    expect(out.json).toEqual({ status: 'error', message: 'createTask: desc exceeds 1000 chars' });
    expect(spy.mock.calls.filter((c) => c[0] === 'POST /api/tasks error:')).toEqual([]);
    expect(pool.query.mock.calls.filter((c) => /INSERT INTO tasks/i.test(String(c[0])))).toEqual([]);
    spy.mockRestore();
  });

  test('an over-long title is 400', async () => {
    pool = stubPool();
    const out = await post({ to: 5, title: 'x'.repeat(101) });
    expect(out.status).toBe(400);
    expect(out.json.message).toBe('createTask: title exceeds 100 chars');
  });

  test('a real fault inside createTask is still 500', async () => {
    const boom = jest.spyOn(taskService, 'createTask').mockRejectedValue(new Error('ER_LOCK_DEADLOCK'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    pool = stubPool();
    const out = await post({ to: 5, title: 'A task' });
    expect(out.status).toBe(500);
    expect(out.json.message).toBe('ER_LOCK_DEADLOCK');
    boom.mockRestore();
    spy.mockRestore();
  });
});
