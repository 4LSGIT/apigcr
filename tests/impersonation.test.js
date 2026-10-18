// tests/impersonation.test.js
//
// IT View-as: capability gate, target guardrails, actor-bearing short JWT and
// explicit read-only/live modes across both staff auth middleware implementations.

'use strict';

process.env.JWT_SECRET = 'view-as-test-secret';
process.env.JWT_VERSION = '1';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const router = require('../routes/api.impersonation');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const requireAuth = require('../lib/auth.requireAuth');

const USERS = new Map([
  [0, { user: 0, username: 'automations', user_name: 'Automations', user_type: 0, user_auth: 'authorized', roles: 'automation' }],
  [2, { user: 2, username: 'staff', user_name: 'Staff Person', user_type: 1, user_auth: 'authorized', roles: 'staff' }],
  [3, { user: 3, username: 'off', user_name: 'Disabled', user_type: 1, user_auth: 'disabled', roles: 'staff' }],
  [6, { user: 6, username: 'it', user_name: 'IT Person', user_type: 1, user_auth: 'authorized', roles: 'it' }],
  [7, { user: 7, username: 'root', user_name: 'Root Person', user_type: 1, user_auth: 'authorized', roles: 'su' }],
]);

function makeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log|admin_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM users ORDER BY user ASC/.test(s)) return [[...USERS.values()].map(x => ({ ...x }))];
      if (/FROM users WHERE user = \? LIMIT 1/.test(s)) {
        const row = USERS.get(Number(params[0]));
        return [row ? [{ ...row }] : []];
      }
      throw new Error('unscripted query: ' + s);
    },
  };
}

function token({ sub = 6, username = 'it', roles = ['it'], extra = {} } = {}) {
  return jwt.sign({ sub, username, user_type: 1, user_auth: 'authorized', roles, aud: 'staff', ver: 1, ...extra },
    process.env.JWT_SECRET, { expiresIn: '1h' });
}

function call(method, path, bearer) {
  const db = makeDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  app.get('/legacy-read', jwtOrApiKey, (req, res) => res.json({ user: req.auth.userId, actor: req.auth.impersonator }));
  app.post('/legacy-write', jwtOrApiKey, (_req, res) => res.json({ wrote: true }));
  app.post('/modern-write', requireAuth({ audience: 'staff' }), (_req, res) => res.json({ wrote: true }));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method,
        headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      }, res => {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(text || '{}'), db });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      req.end();
    });
  });
}

describe('IT View as', () => {
  test('IT can list users without gaining password/reset metadata', async () => {
    const r = await call('GET', '/api/impersonation/users', token());
    expect(r.status).toBe(200);
    expect(r.body.can_manage).toBe(false);
    expect(r.body.users.find(u => u.user === 2)).toMatchObject({ can_view_as: true, username: 'staff' });
    expect(r.body.users.find(u => u.user === 6).can_view_as).toBe(false);
    expect(r.body.users.find(u => u.user === 7).can_view_as).toBe(false);
    expect(r.body.users[0]).not.toHaveProperty('has_hash');
  });

  test('staff cannot list or start View as', async () => {
    const staff = token({ sub: 2, username: 'staff', roles: ['staff'] });
    expect((await call('GET', '/api/impersonation/users', staff)).status).toBe(403);
    expect((await call('POST', '/api/impersonation/users/6/start', staff)).status).toBe(403);
  });

  test('minted token is the target with an actor claim and a 30-minute ceiling', async () => {
    const before = Math.floor(Date.now() / 1000);
    const r = await call('POST', '/api/impersonation/users/2/start', token());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ initial_mode: 'readonly', expires_in_seconds: 1800 });
    expect(r.body.token).toBe(r.body.readonly_token);
    const readonly = jwt.verify(r.body.readonly_token, process.env.JWT_SECRET);
    const live = jwt.verify(r.body.live_token, process.env.JWT_SECRET);
    expect(readonly).toMatchObject({ sub: 2, username: 'staff', roles: ['staff'], view_as: true,
      view_as_mode: 'readonly', act: { sub: '6', username: 'it' } });
    expect(live).toMatchObject({ sub: 2, username: 'staff', roles: ['staff'], view_as: true,
      view_as_mode: 'live',
      act: { sub: '6', username: 'it' } });
    expect(readonly.exp).toBeLessThanOrEqual(before + 1801);
    expect(live.exp).toBe(readonly.exp);
    const audit = r.db.calls.find(c => /admin_audit_log/.test(c.sql));
    expect(audit.params).toEqual(expect.arrayContaining(['view_as', 6, 'it', 'view_as_started']));
  });

  test.each([0, 3, 6, 7])('system, disabled, self, and privileged target %s is refused', async id => {
    const r = await call('POST', `/api/impersonation/users/${id}/start`, token());
    expect([400, 403]).toContain(r.status);
    expect(r.body.token).toBeUndefined();
  });

  test('Read-only View-as reads as target but rejects writes through both auth stacks', async () => {
    const view = token({
      sub: 2, username: 'staff', roles: ['staff'],
      extra: { view_as: true, view_as_mode: 'readonly', act: { sub: '6', username: 'it' } },
    });
    const read = await call('GET', '/legacy-read', view);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ user: 2, actor: { userId: 6, username: 'it' } });
    for (const path of ['/legacy-write', '/modern-write']) {
      const write = await call('POST', path, view);
      expect(write.status).toBe(403);
      expect(write.body).toMatchObject({ code: 'view_as_read_only' });
    }
  });

  test('Live View-as permits writes through both auth stacks', async () => {
    const extra = { view_as: true, view_as_mode: 'live', act: { sub: '6', username: 'it' } };
    const view = token({ sub: 2, username: 'staff', roles: ['staff'], extra });
    for (const path of ['/legacy-write', '/modern-write']) {
      const write = await call('POST', path, view);
      expect(write.status).toBe(200);
      expect(write.body).toEqual({ wrote: true });
    }
  });

  test('a pre-mode View-as token fails closed to read-only', async () => {
    const view = token({
      sub: 2, username: 'staff', roles: ['staff'],
      extra: { view_as: true, act: { sub: '6', username: 'it' } },
    });
    expect((await call('POST', '/legacy-write', view)).body).toMatchObject({ code: 'view_as_read_only' });
  });
});
