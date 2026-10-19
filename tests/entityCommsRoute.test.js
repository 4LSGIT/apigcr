'use strict';

jest.mock('../services/entityCommsService', () => ({ list: jest.fn() }));
jest.mock('../services/commsArchiveView', () => ({ summaryMediaIds: jest.fn(() => []) }));
jest.mock('../lib/auth.superuser', () => ({ auditAdminAction: jest.fn(() => Promise.resolve()) }));

const svc = require('../services/entityCommsService');
const router = require('../routes/api.entityComms');

function route(path) {
  return router.stack.find(layer => layer.route && layer.route.path === path).route;
}

function response() {
  return {
    code: 200,
    body: null,
    status(n) { this.code = n; return this; },
    json(value) { this.body = value; return this; },
  };
}

describe('entity communications route', () => {
  test.each(['/api/contacts/:id/communications', '/api/cases/:id/communications'])
    ('is GET-only and has auth plus the JWT-only guard: %s', (path) => {
      const r = route(path);
      expect(r).toBeDefined();
      expect(r.methods).toMatchObject({ get: true });
      expect(r.stack).toHaveLength(3);

      const res = response();
      const next = jest.fn();
      r.stack[1].handle({ auth: { type: 'api_key', userId: 7 } }, res, next);
      expect(res.code).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

  test('passes the contact scope and validated identity to the service', async () => {
    svc.list.mockResolvedValueOnce({
      entity: { type: 'contact', id: 42 }, items: [], next_offset: null, has_more: false,
    });
    const req = {
      db: { marker: true }, auth: { type: 'jwt', userId: 7 }, params: { id: '42' },
      query: { kind: 'sms' }, headers: {}, socket: {}, originalUrl: '/api/contacts/42/communications', method: 'GET',
    };
    const res = response();
    await route('/api/contacts/:id/communications').stack[2].handle(req, res);
    expect(svc.list).toHaveBeenCalledWith(req.db, req.auth, 'contact', '42', req.query);
    expect(res.body).toMatchObject({ status: 'success', entity: { type: 'contact', id: 42 }, items: [] });
  });

  test('uses the public error envelope for validation failures', async () => {
    svc.list.mockRejectedValueOnce(Object.assign(new Error('bad kind'), { status: 400 }));
    const req = {
      db: {}, auth: { type: 'jwt', userId: 7 }, params: { id: 'C1' }, query: {},
      headers: {}, socket: {}, originalUrl: '/api/cases/C1/communications', method: 'GET',
    };
    const res = response();
    await route('/api/cases/:id/communications').stack[2].handle(req, res);
    expect(res.code).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'bad kind' });
  });
});
