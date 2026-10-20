// tests/impersonation.test.js
//
// IT View-as: capability gate, target guardrails, actor-bearing short JWT,
// fail-closed read-only mode across both staff auth middleware stacks,
// on-demand SU-only Live mint (Fred's ruling 2026-10-21), audited mode
// switches and exit, and the actor stamp in jwt_api_audit_log.

'use strict';

process.env.JWT_SECRET = 'view-as-test-secret';
process.env.JWT_VERSION = '1';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const router = require('../routes/api.impersonation');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const requireAuth = require('../lib/auth.requireAuth');

const BASE_USERS = [
  { user: 0, username: 'automations', user_name: 'Automations', user_type: 0, user_auth: 'authorized', roles: 'automation' },
  { user: 2, username: 'staff', user_name: 'Staff Person', user_type: 1, user_auth: 'authorized', roles: 'staff' },
  { user: 3, username: 'off', user_name: 'Disabled', user_type: 1, user_auth: 'disabled', roles: 'staff' },
  { user: 6, username: 'it', user_name: 'IT Person', user_type: 1, user_auth: 'authorized', roles: 'it' },
  { user: 7, username: 'root', user_name: 'Root Person', user_type: 1, user_auth: 'authorized', roles: 'su' },
  { user: 8, username: 'bot', user_name: 'Second Bot', user_type: 1, user_auth: 'authorized', roles: 'automation' },
  { user: 9, username: 'it2', user_name: 'Other IT', user_type: 1, user_auth: 'authorized', roles: 'it' },
];

function makeDb(overrides = {}) {
  const users = new Map(BASE_USERS.map(u => [u.user, { ...u, ...(overrides[u.user] || {}) }]));
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log|admin_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM users ORDER BY user ASC/.test(s)) return [[...users.values()].map(x => ({ ...x }))];
      if (/FROM users WHERE user = \? LIMIT 1/.test(s)) {
        const row = users.get(Number(params[0]));
        return [row ? [{ ...row }] : []];
      }
      throw new Error('unscripted query: ' + s);
    },
  };
}

function token({ sub = 6, username = 'it', roles = ['it'], extra = {}, expiresIn = '1h' } = {}) {
  return jwt.sign({ sub, username, user_type: 1, user_auth: 'authorized', roles, aud: 'staff', ver: 1, ...extra },
    process.env.JWT_SECRET, { expiresIn });
}

// A View-as token for target 2 started by `actor` (6 = it, 7 = su).
function viewAs(mode, { actor = { sub: '6', username: 'it' }, extra = {}, expiresIn = '30m' } = {}) {
  return token({
    sub: 2, username: 'staff', roles: ['staff'], expiresIn,
    extra: { view_as: true, ...(mode ? { view_as_mode: mode } : {}), act: actor, ...extra },
  });
}

function call(method, path, bearer, { body, users } = {}) {
  const db = makeDb(users);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  app.get('/legacy-read', jwtOrApiKey, (req, res) => res.json({ user: req.auth.userId, actor: req.auth.impersonator }));
  app.get('/modern-read', requireAuth({ audience: 'staff' }), (req, res) => res.json({ user: req.auth.userId }));
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
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

const adminAudits = r => r.db.calls.filter(c => /admin_audit_log/.test(c.sql)).map(c => ({
  userId: c.params[1], username: c.params[2], status: c.params[5], details: JSON.parse(c.params[10] || 'null'),
}));
// jwt_api_audit_log params: [..., auth_type (7), username (8), auth_status (9)]
const gatewayRows = r => r.db.calls.filter(c => /jwt_api_audit_log/.test(c.sql))
  .map(c => ({ authType: c.params[7], username: c.params[8], status: c.params[9] }));

describe('IT View as — start', () => {
  test('IT can list users without gaining password/reset metadata', async () => {
    const r = await call('GET', '/api/impersonation/users', token());
    expect(r.status).toBe(200);
    expect(r.body.can_manage).toBe(false);
    expect(r.body.users.find(u => u.user === 2)).toMatchObject({ can_view_as: true, username: 'staff' });
    for (const id of [0, 3, 6, 7, 8, 9]) expect(r.body.users.find(u => u.user === id).can_view_as).toBe(false);
    expect(r.body.users[0]).not.toHaveProperty('has_hash');
  });

  test('staff cannot list or start View as', async () => {
    const staff = token({ sub: 2, username: 'staff', roles: ['staff'] });
    expect((await call('GET', '/api/impersonation/users', staff)).status).toBe(403);
    expect((await call('POST', '/api/impersonation/users/6/start', staff)).status).toBe(403);
  });

  test('start returns ONLY a read-only token: the target with an actor claim and a 30-minute ceiling', async () => {
    const before = Math.floor(Date.now() / 1000);
    const r = await call('POST', '/api/impersonation/users/2/start', token());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ initial_mode: 'readonly', expires_in_seconds: 1800, live_allowed: false });
    expect(r.body).not.toHaveProperty('live_token');
    expect(r.body).not.toHaveProperty('readonly_token');
    const t = jwt.verify(r.body.token, process.env.JWT_SECRET);
    expect(t).toMatchObject({ sub: 2, username: 'staff', roles: ['staff'], view_as: true,
      view_as_mode: 'readonly', view_as_live_allowed: false, act: { sub: '6', username: 'it' } });
    expect(t.exp).toBeLessThanOrEqual(before + 1801);
    expect(adminAudits(r)).toEqual([expect.objectContaining({ userId: 6, username: 'it', status: 'view_as_started' })]);
  });

  test('an SU start carries the cosmetic live hint', async () => {
    const r = await call('POST', '/api/impersonation/users/2/start', token({ sub: 7, username: 'root', roles: ['su'] }));
    expect(r.status).toBe(200);
    expect(r.body.live_allowed).toBe(true);
    expect(jwt.verify(r.body.token, process.env.JWT_SECRET).view_as_live_allowed).toBe(true);
  });

  // Privileged targets must be refused BY THE ROLE CHECK (403 + audit row),
  // not masked by the self-check: the caller here is never the target.
  test.each([
    [7, 'su'], [9, 'it'], [8, 'automation'],
  ])('privileged/system target %s (%s) is refused by role', async id => {
    const r = await call('POST', `/api/impersonation/users/${id}/start`, token());
    expect(r.status).toBe(403);
    expect(r.body.token).toBeUndefined();
    expect(adminAudits(r)).toEqual([expect.objectContaining({ status: 'view_as_rejected_target' })]);
  });

  test.each([0, 3, 6])('system user 0, disabled, and self target %s is refused', async id => {
    const r = await call('POST', `/api/impersonation/users/${id}/start`, token());
    expect([400, 403]).toContain(r.status);
    expect(r.body.token).toBeUndefined();
  });

  test('BLOCKED_TARGET_ROLES covers it, su and automation', () => {
    expect([...router._test.BLOCKED_TARGET_ROLES].sort()).toEqual(['automation', 'it', 'su']);
  });

  // The capability gate passes only because these hand-crafted tokens carry
  // `it`; the nesting check is what must refuse them.
  test('a View-as session cannot start another (nesting)', async () => {
    const nested = token({ sub: 2, username: 'staff', roles: ['it'],
      extra: { view_as: true, view_as_mode: 'live', act: { sub: '7', username: 'root' } } });
    const r = await call('POST', '/api/impersonation/users/9/start', nested);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Exit the current View-as session/);
    expect(r.body.token).toBeUndefined();
  });

  test('nesting is refused even when the act claim is malformed', async () => {
    const nested = token({ sub: 2, username: 'staff', roles: ['it'], extra: { view_as: true, view_as_mode: 'readonly' } });
    const r = await call('GET', '/api/impersonation/users', nested);
    expect(r.status).toBe(200); // reads are fine
    const s = await call('POST', '/api/impersonation/users/9/start', nested);
    expect(s.status).toBe(403); // read-only write block fires first
    const live = token({ sub: 2, username: 'staff', roles: ['it'], extra: { view_as: true, view_as_mode: 'live', act: { sub: 'x' } } });
    expect((await call('POST', '/api/impersonation/users/9/start', live)).status).toBe(403);
  });
});

describe('IT View as — read-only enforcement', () => {
  test('Read-only View-as reads as target but rejects writes through both auth stacks', async () => {
    const view = viewAs('readonly');
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
    const view = viewAs('live', { actor: { sub: '7', username: 'root' } });
    for (const path of ['/legacy-write', '/modern-write']) {
      const write = await call('POST', path, view);
      expect(write.status).toBe(200);
      expect(write.body).toEqual({ wrote: true });
    }
  });

  test('a pre-mode View-as token fails closed to read-only', async () => {
    expect((await call('POST', '/legacy-write', viewAs(null))).body).toMatchObject({ code: 'view_as_read_only' });
  });

  // Fail closed on view_as itself, not on a parseable actor: a Live claim
  // with a malformed act is still read-only.
  test.each([
    ['missing act', { act: undefined }],
    ['act without username', { act: { sub: '7' } }],
    ['non-numeric actor', { act: { sub: 'root', username: 'root' } }],
    ['act not an object', { act: 'root' }],
  ])('a Live claim with %s is read-only on both stacks', async (_label, extra) => {
    const view = viewAs('live', { extra });
    for (const path of ['/legacy-write', '/modern-write']) {
      const write = await call('POST', path, view);
      expect(write.status).toBe(403);
      expect(write.body).toMatchObject({ code: 'view_as_read_only' });
    }
  });
});

describe('IT View as — actor in jwt_api_audit_log', () => {
  test.each(['/legacy-read', '/modern-read'])('%s: read-only rows name the actor', async path => {
    const r = await call('GET', path, viewAs('readonly'));
    expect(r.status).toBe(200);
    expect(gatewayRows(r)).toEqual([{ authType: 'jwt_view_as', username: 'staff [by it#6]', status: 'authorized' }]);
  });

  test.each(['/legacy-write', '/modern-write'])('%s: Live rows say live; refusals name the actor', async path => {
    const live = await call('POST', path, viewAs('live', { actor: { sub: '7', username: 'root' } }));
    expect(gatewayRows(live)).toEqual([{ authType: 'jwt_view_as_live', username: 'staff [by root#7]', status: 'authorized' }]);
    const ro = await call('POST', path, viewAs('readonly'));
    expect(gatewayRows(ro)).toEqual([{ authType: 'jwt_view_as', username: 'staff [by it#6]', status: 'forbidden_view_as_write' }]);
  });

  test('a malformed actor is recorded as unknown, never as a plain jwt row', async () => {
    const r = await call('GET', '/legacy-read', viewAs('live', { extra: { act: { sub: '7' } } }));
    expect(gatewayRows(r)).toEqual([{ authType: 'jwt_view_as', username: 'staff [by unknown]', status: 'authorized' }]);
  });

  test('ordinary sessions keep auth_type jwt and the bare username', async () => {
    const r = await call('GET', '/legacy-read', token({ sub: 2, username: 'staff', roles: ['staff'] }));
    expect(gatewayRows(r)).toEqual([{ authType: 'jwt', username: 'staff', status: 'authorized' }]);
  });
});

describe('IT View as — on-demand Live mint (SU-only) and audited exit', () => {
  const SU = { sub: '7', username: 'root' };

  test('an SU actor in read-only mode gets a Live token that keeps the session expiry', async () => {
    const ro = viewAs('readonly', { actor: SU, extra: { view_as_live_allowed: true } });
    const roExp = jwt.decode(ro).exp;
    const r = await call('POST', '/api/impersonation/mode', ro, { body: { mode: 'live' } });
    expect(r.status).toBe(200);
    const t = jwt.verify(r.body.token, process.env.JWT_SECRET);
    expect(t).toMatchObject({ sub: 2, username: 'staff', roles: ['staff'], view_as: true, view_as_mode: 'live',
      view_as_live_allowed: true, act: SU });
    expect(t.exp).toBe(roExp);
    expect(adminAudits(r)).toEqual([expect.objectContaining({ userId: 7, username: 'root', status: 'view_as_live',
      details: expect.objectContaining({ target_user_id: 2, mode: 'live' }) })]);
    // and the minted token really writes
    expect((await call('POST', '/legacy-write', r.body.token)).status).toBe(200);
  });

  test('an IT actor is refused Live (audited) — read-only is all IT gets', async () => {
    const r = await call('POST', '/api/impersonation/mode', viewAs('readonly'), { body: { mode: 'live' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'view_as_live_forbidden' });
    expect(r.body.token).toBeUndefined();
    expect(adminAudits(r)).toEqual([expect.objectContaining({ userId: 6, status: 'view_as_live_rejected' })]);
  });

  test('the Live gate reads the actor row, not the token: a demoted or disabled SU is refused', async () => {
    // The token still claims live_allowed: only the DB row may decide.
    const ro = viewAs('readonly', { actor: SU, extra: { view_as_live_allowed: true } });
    for (const o of [{ roles: 'staff' }, { user_auth: 'disabled' }]) {
      const r = await call('POST', '/api/impersonation/mode', ro, { body: { mode: 'live' }, users: { 7: o } });
      expect(r.status).toBe(403);
      expect(r.body.token).toBeUndefined();
    }
  });

  test('a target that has become ineligible cannot be switched', async () => {
    const r = await call('POST', '/api/impersonation/mode', viewAs('readonly', { actor: SU }),
      { body: { mode: 'live' }, users: { 2: { roles: 'it' } } });
    expect(r.status).toBe(403);
    expect(r.body.token).toBeUndefined();
  });

  test('Live → read-only mints a read-only token (audited)', async () => {
    const r = await call('POST', '/api/impersonation/mode', viewAs('live', { actor: SU }), { body: { mode: 'readonly' } });
    expect(r.status).toBe(200);
    expect(jwt.verify(r.body.token, process.env.JWT_SECRET)).toMatchObject({ view_as_mode: 'readonly', act: SU });
    expect(adminAudits(r)).toEqual([expect.objectContaining({ userId: 7, status: 'view_as_readonly' })]);
  });

  test('mode refuses a bad mode, an ordinary session, and a malformed actor', async () => {
    expect((await call('POST', '/api/impersonation/mode', viewAs('readonly', { actor: SU }), { body: { mode: 'god' } })).status).toBe(400);
    const plainSu = token({ sub: 7, username: 'root', roles: ['su'] });
    expect((await call('POST', '/api/impersonation/mode', plainSu, { body: { mode: 'live' } })).status).toBe(403);
    const bad = viewAs('readonly', { extra: { act: { sub: '7' } } });
    const r = await call('POST', '/api/impersonation/mode', bad, { body: { mode: 'live' } });
    expect(r.status).toBe(403);
    expect(r.body.token).toBeUndefined();
  });

  test('the control-route exemption does not leak to other writes', async () => {
    const ro = viewAs('readonly', { actor: SU });
    expect((await call('POST', '/api/impersonation/mode', ro, { body: { mode: 'readonly' } })).status).toBe(200);
    expect((await call('POST', '/legacy-write', ro)).body).toMatchObject({ code: 'view_as_read_only' });
  });

  test('exit writes an actor-attributed audit row; ordinary sessions are refused', async () => {
    const r = await call('POST', '/api/impersonation/exit', viewAs('readonly'));
    expect(r.status).toBe(200);
    expect(adminAudits(r)).toEqual([expect.objectContaining({ userId: 6, username: 'it', status: 'view_as_exited',
      details: expect.objectContaining({ target_user_id: 2, mode: 'readonly' }) })]);
    expect((await call('POST', '/api/impersonation/exit', token())).status).toBe(403);
  });
});
