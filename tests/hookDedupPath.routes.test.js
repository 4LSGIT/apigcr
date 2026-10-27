/**
 * tests/hookDedupPath.routes.test.js
 *
 * hooks.dedup_path through the management routes (async hook receiver S3,
 * 2026-10-27): POST /api/hooks and PUT /api/hooks/:id accept an optional
 * `dedup_path` — a dot-path of the provider's event id — validate it at the
 * door (identifier segments, ≤ 100 chars; blank or null clears it) and hand
 * the normalized value to hookService; a request without the key leaves the
 * column alone. hookService is mocked at the module boundary; the receiver's
 * use of the path is pinned in tests/hookTransformFailure.test.js and the
 * real-MySQL suite.
 *
 * Run: npx jest tests/hookDedupPath.routes.test.js
 */
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hook-dedup-path-routes-test-secret';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  getHookById: jest.fn(),
  authenticateRequest: jest.fn(() => ({ valid: true })),
  executeHook: jest.fn(),
  recordExecution: jest.fn(),
  createHook: jest.fn(async () => 77),
  createTarget: jest.fn(async () => 1),
  updateHook: jest.fn(async () => {}),
  withReadableAuth: (h) => h,
}));
jest.mock('../lib/taskQueue', () => ({ enqueueHookExecutionDispatch: jest.fn(async () => true) }));

const hookService = require('../services/hookService');
const express = require('express');
const jwt = require('jsonwebtoken');

const admin = { authorization: 'Bearer ' + jwt.sign(
  { sub: 5, username: 'it', user_type: 1, user_auth: 'authorized', aud: 'staff', ver: 1, roles: ['admin', 'staff'] },
  process.env.JWT_SECRET, { expiresIn: '1h' }) };

let server, base;
const db = { query: async () => [[]], withTransaction: async (fn) => fn({ query: async () => [[]] }) };
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.hooks'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(done); });
beforeEach(() => { hookService.createHook.mockClear(); hookService.updateHook.mockClear(); });

const send = (method, path, body) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe('POST /api/hooks', () => {
  test('a valid dedup_path is stored as given (trimmed); blank → NULL; absent → not in the row', async () => {
    expect((await send('POST', '/api/hooks', { name: 'rc', slug: 'rc-x', dedup_path: ' body.uuid ' })).status).toBe(200);
    expect(hookService.createHook.mock.calls[0][1]).toMatchObject({ name: 'rc', dedup_path: 'body.uuid' });
    expect((await send('POST', '/api/hooks', { name: 'q', dedup_path: '' })).status).toBe(200);
    expect(hookService.createHook.mock.calls[1][1].dedup_path).toBeNull();
    expect((await send('POST', '/api/hooks', { name: 'n' })).status).toBe(200);
    expect(hookService.createHook.mock.calls[2][1]).not.toHaveProperty('dedup_path');
  });

  test('a bad dedup_path is a 400 before anything is written', async () => {
    for (const bad of ['body uuid', 'body..id', '.body', 'body.', 'body[0].id', 'x'.repeat(101), 42, { a: 1 }]) {
      const r = await send('POST', '/api/hooks', { name: 'rc', dedup_path: bad });
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.message).toMatch(/dedup_path/);
    }
    expect(hookService.createHook).not.toHaveBeenCalled();
  });

  test('array indexes are segments: body.data.0.id is fine', async () => {
    expect((await send('POST', '/api/hooks', { name: 'q', dedup_path: 'body.data.0.id' })).status).toBe(200);
    expect(hookService.createHook.mock.calls[0][1].dedup_path).toBe('body.data.0.id');
  });
});

describe('PUT /api/hooks/:id', () => {
  test('sets, clears (null or blank), or leaves alone', async () => {
    expect((await send('PUT', '/api/hooks/22', { dedup_path: 'body.uuid' })).status).toBe(200);
    expect(hookService.updateHook.mock.calls[0][2]).toMatchObject({ dedup_path: 'body.uuid' });
    expect((await send('PUT', '/api/hooks/22', { dedup_path: null })).status).toBe(200);
    expect(hookService.updateHook.mock.calls[1][2].dedup_path).toBeNull();
    expect((await send('PUT', '/api/hooks/22', { dedup_path: '   ' })).status).toBe(200);
    expect(hookService.updateHook.mock.calls[2][2].dedup_path).toBeNull();
    expect((await send('PUT', '/api/hooks/22', { name: 'renamed' })).status).toBe(200);
    expect(hookService.updateHook.mock.calls[3][2]).not.toHaveProperty('dedup_path');
  });

  test('a bad dedup_path is a 400 and nothing is updated', async () => {
    const r = await send('PUT', '/api/hooks/22', { name: 'x', dedup_path: 'body uuid' });
    expect(r.status).toBe(400);
    expect(hookService.updateHook).not.toHaveBeenCalled();
  });
});
