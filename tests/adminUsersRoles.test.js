// tests/adminUsersRoles.test.js
//
/**
 * Users pane roles + the A2b access-level shrink — routes/admin.users.js
 * (ref/ACCESS_CONTROL_DESIGN.md §2.2, §2.4 item 5, §2.5).
 *
 * WHAT IS LOCKED
 *   - parseRoles: array or csv; trimmed; de-duplicated; written in SET order;
 *     unknown names / non-string entries / other types refused.
 *   - ROLE_MEMBERS is exactly the users.roles SET in ref/database.sql (a SET
 *     member appended without updating the pane fails here).
 *   - roleChangeRefusal (the su rules): granting OR revoking su needs an SU
 *     caller; nobody removes their own su; non-su changes are free.
 *   - PATCH { roles }: normalized csv reaches the UPDATE and the audit row;
 *     unknown role 400 with no write; own-su removal 400; su grant/revoke on
 *     another user by an SU passes.
 *   - POST create: roles default 'staff'; provided roles normalized.
 *   - GET list carries roles.
 *   - ALLOWED_AUTH = authorized | disabled: 'authorized - SU' is refused on
 *     PATCH and POST. A row STILL holding the legacy string (pre-collapse)
 *     saves through the pane — the form sends 'authorized' and the self-guard
 *     compares login status, not the raw string — and a PATCH that omits
 *     user_auth never trips validation.
 *
 * HARNESS: the REAL router + REAL superuserOnlyFor chain (jwtOrApiKey, the
 * su check, step-up elevation via mintElevationToken, the rate limiter —
 * raised through its documented env knob) over an in-process express app
 * and a scripted users table. Nothing is mocked.
 *
 * Run: npx jest tests/adminUsersRoles.test.js
 */
'use strict';

process.env.JWT_SECRET = 'admin-users-roles-test-secret';
process.env.SU_RATE_LIMIT_USERS = '10000';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const router = require('../routes/admin.users');
const { parseRoles, roleChangeRefusal, ROLE_MEMBERS } = router;
const { mintElevationToken } = require('../lib/auth.superuser');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const seedUsers = () => new Map([
  [2, { user: 2, username: 'VS', user_auth: 'authorized', roles: 'staff' }],
  [3, { user: 3, username: 'RR', user_auth: 'authorized', roles: 'staff,su' }],
  [6, { user: 6, username: 'IT', user_auth: 'authorized - SU', roles: 'it,admin,form_dev,su' }],
]);

function makeDb() {
  const users = seedUsers();
  const calls = [];
  return {
    users, calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log|admin_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/^SELECT user, username, user_auth, roles FROM users WHERE user = \?/.test(s)) {
        const u = users.get(Number(params[0]));
        return [u ? [{ ...u }] : []];
      }
      if (/^SELECT user FROM users WHERE username = \?/.test(s)) return [[]];
      if (/^SELECT user, username, user_name/.test(s)) return [[...users.values()].map(u => ({ ...u }))];
      if (/^UPDATE users SET /.test(s)) return [{ affectedRows: 1 }];
      if (/^INSERT INTO users/.test(s)) return [{ insertId: 30 }];
      throw new Error('unscripted query: ' + s);
    },
  };
}

function call(method, urlPath, { as = 6, roles = ['it', 'admin', 'form_dev', 'su'], body } = {}) {
  const db = makeDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);
  const token = jwt.sign({ sub: as, username: 'u' + as, user_type: 1, user_auth: 'authorized', roles, aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign(
          { authorization: 'Bearer ' + token, 'x-su-elevation': mintElevationToken(as) },
          payload ? { 'content-type': 'application/json' } : {}),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}'), db }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const updates = db => db.calls.filter(c => /^UPDATE users SET /.test(c.sql));
const inserts = db => db.calls.filter(c => /^INSERT INTO users/.test(c.sql));
const flush = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// parseRoles + ROLE_MEMBERS
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRoles', () => {
  test('array or csv, trimmed, de-duplicated, written in SET order', () => {
    expect(parseRoles(['su', 'staff', 'it'])).toEqual({ csv: 'it,staff,su' });
    expect(parseRoles(' attorney , staff,staff ')).toEqual({ csv: 'staff,attorney' });
    expect(parseRoles(['form_dev', 'admin', 'admin'])).toEqual({ csv: 'admin,form_dev' });
  });

  test('empty means no roles', () => {
    expect(parseRoles([])).toEqual({ csv: '' });
    expect(parseRoles('')).toEqual({ csv: '' });
    expect(parseRoles(' , ')).toEqual({ csv: '' });
  });

  test('unknown names refused, named in the error', () => {
    expect(parseRoles(['staff', 'paralegal']).error).toMatch(/unknown role\(s\): paralegal/);
    expect(parseRoles('SU').error).toMatch(/unknown role/);          // case-sensitive, like the SET
    expect(parseRoles(['constructor']).error).toMatch(/unknown role/);
  });

  test('non-string entries and other types refused', () => {
    expect(parseRoles([1]).error).toMatch(/role names/);
    expect(parseRoles(null).error).toMatch(/array or a comma-separated/);
    expect(parseRoles({ su: true }).error).toMatch(/array or a comma-separated/);
  });

  test('ROLE_MEMBERS is exactly the users.roles SET in ref/database.sql, in order', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8');
    const m = sql.match(/`roles` set\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m[1].split(',').map(s => s.replace(/'/g, ''))).toEqual(ROLE_MEMBERS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roleChangeRefusal — the su rules
// ─────────────────────────────────────────────────────────────────────────────

describe('roleChangeRefusal', () => {
  const SU = { type: 'jwt', userId: 6, roles: ['su'] };
  const ADMIN = { type: 'jwt', userId: 1, roles: ['admin', 'it'] };
  const LEGACY = { type: 'jwt', userId: 1, user_auth: 'authorized - SU', roles: [] };

  test('an SU may grant and revoke su on someone else', () => {
    expect(roleChangeRefusal(SU, 2, 'staff', 'staff,su')).toBeNull();
    expect(roleChangeRefusal(SU, 3, 'staff,su', 'staff')).toBeNull();
    expect(roleChangeRefusal(SU, null, '', 'staff,su')).toBeNull();   // create
  });

  test('a non-SU may neither grant nor revoke su (both directions, create too)', () => {
    for (const who of [ADMIN, LEGACY, { type: 'api_key' }, undefined]) {
      expect(roleChangeRefusal(who, 2, 'staff', 'staff,su')).toMatchObject({ status: 403 });
      expect(roleChangeRefusal(who, 3, 'staff,su', 'staff')).toMatchObject({ status: 403 });
      expect(roleChangeRefusal(who, null, '', 'su')).toMatchObject({ status: 403 });
    }
  });

  test('a non-SU may change everything else, su untouched either way', () => {
    expect(roleChangeRefusal(ADMIN, 2, 'staff', 'staff,attorney')).toBeNull();
    expect(roleChangeRefusal(ADMIN, 3, 'staff,su', 'staff,attorney,su')).toBeNull();
  });

  test('nobody removes their own su; keeping it while editing is fine', () => {
    expect(roleChangeRefusal(SU, 6, 'it,su', 'it')).toEqual(
      { status: 400, message: 'You cannot remove your own su role' });
    expect(roleChangeRefusal(SU, 6, 'it,su', 'it,form_dev,su')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/users/:id { roles }', () => {
  test('normalized csv reaches the UPDATE and the audit row', async () => {
    const r = await call('PATCH', '/api/admin/users/2', { body: { roles: ['attorney', 'staff', 'staff'] } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual(['roles']);
    expect(updates(r.db)).toHaveLength(1);
    expect(updates(r.db)[0].sql).toMatch(/SET `roles` = \?/);
    expect(updates(r.db)[0].params).toEqual(['staff,attorney', 2]);
    await flush();
    const audit = r.db.calls.filter(c => /admin_audit_log/.test(c.sql)).map(c => c.params.join('|'));
    expect(audit.some(a => a.includes('user_updated') && a.includes('staff,attorney'))).toBe(true);
  });

  test('csv input works the same', async () => {
    const r = await call('PATCH', '/api/admin/users/2', { body: { roles: 'su,it' } });
    expect(r.status).toBe(200);
    expect(updates(r.db)[0].params).toEqual(['it,su', 2]);
  });

  test('unknown role → 400, nothing written', async () => {
    const r = await call('PATCH', '/api/admin/users/2', { body: { roles: ['staff', 'paralegal'] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/unknown role\(s\): paralegal/);
    expect(updates(r.db)).toHaveLength(0);
  });

  test('an SU grants su to another user, and revokes it', async () => {
    const g = await call('PATCH', '/api/admin/users/2', { body: { roles: ['staff', 'su'] } });
    expect(g.status).toBe(200);
    expect(updates(g.db)[0].params).toEqual(['staff,su', 2]);
    const v = await call('PATCH', '/api/admin/users/3', { body: { roles: ['staff'] } });
    expect(v.status).toBe(200);
    expect(updates(v.db)[0].params).toEqual(['staff', 3]);
  });

  test('removing your own su → 400, nothing written', async () => {
    const r = await call('PATCH', '/api/admin/users/6', { body: { roles: ['it', 'admin'] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('You cannot remove your own su role');
    expect(updates(r.db)).toHaveLength(0);
  });

  test('editing your own roles while keeping su is fine', async () => {
    const r = await call('PATCH', '/api/admin/users/6', { body: { roles: ['it', 'admin', 'su'] } });
    expect(r.status).toBe(200);
    expect(updates(r.db)[0].params).toEqual(['it,admin,su', 6]);
  });

  test('a non-SU caller never reaches the handler (superuserOnlyFor)', async () => {
    const r = await call('PATCH', '/api/admin/users/2', { as: 1, roles: ['admin', 'it'], body: { roles: ['staff'] } });
    expect(r.status).toBe(403);
    expect(updates(r.db)).toHaveLength(0);
  });
});

describe('POST /api/admin/users roles', () => {
  const base = { username: 'nu', user_fname: 'New', user_lname: 'User', user_initials: 'NU' };
  const rolesParam = db => {
    const ins = inserts(db)[0];
    // INSERT column order: username, user_type, user_real_name, user_name, user_fname,
    // user_lname, user_initials, user_auth, roles, …
    return ins.params[8];
  };

  test("roles default to 'staff'", async () => {
    const r = await call('POST', '/api/admin/users', { body: base });
    expect(r.status).toBe(200);
    expect(inserts(r.db)[0].sql).toMatch(/user_auth, roles, email/);
    expect(rolesParam(r.db)).toBe('staff');
  });

  test('provided roles are normalized', async () => {
    const r = await call('POST', '/api/admin/users', { body: { ...base, roles: ['attorney', 'staff'] } });
    expect(r.status).toBe(200);
    expect(rolesParam(r.db)).toBe('staff,attorney');
  });

  test('unknown role → 400, nothing inserted', async () => {
    const r = await call('POST', '/api/admin/users', { body: { ...base, roles: ['boss'] } });
    expect(r.status).toBe(400);
    expect(inserts(r.db)).toHaveLength(0);
  });
});

describe('GET /api/admin/users', () => {
  test('carries roles', async () => {
    const r = await call('GET', '/api/admin/users');
    expect(r.status).toBe(200);
    expect(r.body.users.find(u => u.user === 2).roles).toBe('staff');
    expect(r.db.calls.find(c => /^SELECT user, username, user_name/.test(c.sql)).sql).toMatch(/user_auth, roles,/);
  });
});

describe("ALLOWED_AUTH = authorized | disabled (A2b)", () => {
  test("'authorized - SU' refused on PATCH and POST", async () => {
    const p = await call('PATCH', '/api/admin/users/2', { body: { user_auth: 'authorized - SU' } });
    expect(p.status).toBe(400);
    expect(p.body.message).toBe('user_auth must be one of: authorized, disabled');
    expect(updates(p.db)).toHaveLength(0);
    const c = await call('POST', '/api/admin/users', {
      body: { username: 'x', user_fname: 'X', user_lname: 'Y', user_initials: 'XY', user_auth: 'authorized - SU' } });
    expect(c.status).toBe(400);
    expect(inserts(c.db)).toHaveLength(0);
  });

  test('a not-yet-collapsed row saves through the pane: own record, form sends authorized', async () => {
    // users.html always sends user_auth; for user 6 (still 'authorized - SU'
    // until scripts/accessA2bCollapse.js runs) the dropdown reads 'authorized'.
    const r = await call('PATCH', '/api/admin/users/6', { body: { user_auth: 'authorized', user_name: 'IT' } });
    expect(r.status).toBe(200);
    expect(updates(r.db)[0].params).toEqual(['IT', 'authorized', 6]);
  });

  test('...but disabling yourself is still refused', async () => {
    const r = await call('PATCH', '/api/admin/users/6', { body: { user_auth: 'disabled' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('You cannot change your own access level');
  });

  test('a PATCH that omits user_auth never trips its validation', async () => {
    const r = await call('PATCH', '/api/admin/users/6', { body: { email: 'it@firm.test' } });
    expect(r.status).toBe(200);
    expect(updates(r.db)[0].params).toEqual(['it@firm.test', 6]);
  });
});
