// tests/usersFreebusyOwnership.test.js
//
// PATCH /api/users/:id/freebusy-calendars is self-or-su only (arc review
// 2026-10-21 side finding: any staff login could rewrite any user's list).
// The one caller is My Settings editing the signed-in user's own row; su
// keeps the admin path. API keys have no self, so they are refused.

'use strict';

process.env.JWT_SECRET = 'freebusy-test-secret';
process.env.JWT_VERSION = '1';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const router = require('../routes/api.users');

function makeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/UPDATE users SET freebusy_calendar_ids/.test(s)) return [{ affectedRows: 1 }];
      // External API key (legacy NULL scopes = full route surface — the
      // strongest key shape must still be refused by the handler's guard).
      if (/FROM api_keys WHERE key_hash/.test(s)) {
        return [[{ id: 5, label: 'test-key', revoked_at: null, expires_at: null, scopes: null }]];
      }
      if (/UPDATE api_keys SET last_used_at/.test(s)) return [{ affectedRows: 1 }];
      throw new Error('unscripted query: ' + s);
    },
  };
}

function token({ sub = 2, username = 'staff', roles = ['staff'] } = {}) {
  return jwt.sign(
    { sub, username, user_type: 1, user_auth: 'authorized', roles, aud: 'staff', ver: 1 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
}

function call(id, { bearer, apiKey, body = { calendar_ids: ['a@b.com'] } } = {}) {
  const db = makeDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/users/${id}/freebusy-calendars`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
          },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => null);
        resolve({ status: r.status, data, db });
      } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}

const wrote = (db) => db.calls.some((c) => /UPDATE users SET freebusy_calendar_ids/.test(c.sql));

describe('PATCH /api/users/:id/freebusy-calendars ownership', () => {
  test('a staff JWT edits its own list', async () => {
    const r = await call(2, { bearer: token({ sub: 2 }) });
    expect(r.status).toBe(200);
    expect(r.data.freebusy_calendar_ids).toEqual(['a@b.com']);
    expect(wrote(r.db)).toBe(true);
  });

  test("a staff JWT may NOT edit another user's list (403, nothing written)", async () => {
    const r = await call(6, { bearer: token({ sub: 2 }) });
    expect(r.status).toBe(403);
    expect(wrote(r.db)).toBe(false);
  });

  test('su edits anyone', async () => {
    const r = await call(2, { bearer: token({ sub: 7, username: 'root', roles: ['su'] }) });
    expect(r.status).toBe(200);
    expect(wrote(r.db)).toBe(true);
  });

  test('sub is compared numerically (JWT sub is a string)', async () => {
    const r = await call(2, { bearer: jwt.sign(
      { sub: '2', username: 'staff', user_type: 1, user_auth: 'authorized', roles: ['staff'], aud: 'staff', ver: 1 },
      process.env.JWT_SECRET, { expiresIn: '1h' },
    ) });
    expect(r.status).toBe(200);
  });

  test('an api_key identity is refused (403, nothing written)', async () => {
    const r = await call(2, { apiKey: 'yck_freebusyTestKey000000' });   // secret-scan: allow (fake test key)
    expect(r.status).toBe(403);
    expect(wrote(r.db)).toBe(false);
  });
});
