// SU step-up (2026-08-16) — lib/auth.superuser.js elevation + /admin/elevate.
//
// Locks:
//   - Every superuserOnlyFor() route 401s with code 'elevation_required'
//     until a live elevation token rides X-SU-Elevation (audited).
//   - /admin/elevate: wrong password → 401 bad_password + audit; right
//     password → token; the token satisfies the SU chain; expired → 401.
//   - Token families are mutually rejectable: a staff session JWT is not an
//     elevation token (aud), an elevation token is not a session (aud), a
//     token for another sub is rejected.
//   - Elevation ADDS to the SU check, never substitutes: a non-SU caller is
//     403'd with or without a (hand-forged) elevation token, and cannot
//     elevate.
//   - SU_STEPUP=0 restores exact pre-slice behavior (the rip-out valve).
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-stepup';

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const suMod = require('../lib/auth.superuser');
const { superuserOnlyFor, mintElevationToken, _resetRateLimits } = suMod;

const SECRET = process.env.JWT_SECRET;
const PASSWORD = 'correct-horse';
let HASH; // bcrypt of PASSWORD, rounds 4 (test speed; compare is rounds-agnostic)

// ── fakes ───────────────────────────────────────────────────────────────────
const auditRows = [];
const db = {
  query: jest.fn(async (sql, params) => {
    if (/FROM users WHERE user = \?/i.test(sql)) {
      return [[{ password_hash: HASH }]];
    }
    if (/INSERT INTO admin_audit_log/i.test(sql)) {
      auditRows.push(params);
      return [{}];
    }
    if (/INSERT INTO jwt_api_audit_log/i.test(sql)) return [{}];
    return [[]];
  }),
};

const staffToken = (over = {}) =>
  jwt.sign(
    {
      sub: 42, username: 'fred', user_type: 'staff',
      user_auth: 'authorized - SU', aud: 'staff', roles: [],
      ...over,
    },
    SECRET,
    { expiresIn: '1h' }
  );

let server, base;

beforeAll(async () => {
  HASH = await bcrypt.hash(PASSWORD, 4);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.post('/admin/probe', ...superuserOnlyFor('probe_tool'), (req, res) =>
    res.json({ ok: true })
  );
  app.use(require('../routes/admin.elevate.js'));
  await new Promise((r) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  _resetRateLimits();
  auditRows.length = 0;
  delete process.env.SU_STEPUP; // default = ON
});

const call = (p, { bearer, elev, body } = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(elev ? { 'x-su-elevation': elev } : {}),
    },
    body: JSON.stringify(body || {}),
  });

const auditStatuses = () => auditRows.map((p) => p[5]); // status column position

// ── the gate ────────────────────────────────────────────────────────────────
describe('elevation gate on superuserOnlyFor routes', () => {
  test('SU without elevation → 401 elevation_required, audited', async () => {
    const res = await call('/admin/probe', { bearer: staffToken() });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('elevation_required');
    expect(auditStatuses()).toContain('rejected_no_elevation');
  });

  test('full happy path: elevate with the right password, retry succeeds', async () => {
    const bad = await call('/admin/elevate', {
      bearer: staffToken(), body: { password: 'wrong' },
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe('bad_password');
    expect(auditStatuses()).toContain('rejected_bad_password');

    const good = await call('/admin/elevate', {
      bearer: staffToken(), body: { password: PASSWORD },
    });
    expect(good.status).toBe(200);
    const { token, expires_in } = await good.json();
    expect(typeof token).toBe('string');
    expect(expires_in).toBe(900);
    expect(auditStatuses()).toContain('elevated');

    const probe = await call('/admin/probe', { bearer: staffToken(), elev: token });
    expect(probe.status).toBe(200);
    expect((await probe.json()).ok).toBe(true);
  });

  test('expired elevation token → 401 again', async () => {
    const expired = jwt.sign({ sub: '42', aud: 'su-elev' }, SECRET, { expiresIn: -10 });
    const res = await call('/admin/probe', { bearer: staffToken(), elev: expired });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('elevation_required');
  });

  test('token for a DIFFERENT sub is rejected', async () => {
    const other = mintElevationToken(999);
    const res = await call('/admin/probe', { bearer: staffToken(), elev: other });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('elevation_required');
  });

  test('a staff SESSION token is not an elevation token (aud)', async () => {
    const res = await call('/admin/probe', {
      bearer: staffToken(), elev: staffToken(),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('elevation_required');
  });

  test('an elevation token is not a SESSION token (jwtOrApiKey aud guard)', async () => {
    const res = await call('/admin/probe', { bearer: mintElevationToken(42) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined(); // the plain Unauthorized, not step-up
  });
});

// ── SU precedence — elevation ADDS, never substitutes ───────────────────────
describe('non-SU callers', () => {
  const nonSu = () => staffToken({ user_auth: 'authorized', sub: 7 });

  test('cannot elevate (403 before the password is read)', async () => {
    const res = await call('/admin/elevate', {
      bearer: nonSu(), body: { password: PASSWORD },
    });
    expect(res.status).toBe(403);
    expect(auditStatuses()).toContain('rejected_not_su');
  });

  test('a hand-forged elevation token never opens an SU route', async () => {
    const forged = mintElevationToken(7);
    const res = await call('/admin/probe', { bearer: nonSu(), elev: forged });
    expect(res.status).toBe(403); // SU check fires first — no elevation prompt
    expect((await res.json()).error).toMatch(/Superuser/);
  });
});

// ── kill switch ─────────────────────────────────────────────────────────────
describe('SU_STEPUP=0 (the rip-out valve)', () => {
  test('restores exact pre-slice behavior: SU JWT alone is enough', async () => {
    process.env.SU_STEPUP = '0';
    const res = await call('/admin/probe', { bearer: staffToken() });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(auditStatuses()).not.toContain('rejected_no_elevation');
  });
});

// ── edge: account without a hash ────────────────────────────────────────────
describe('account not enabled for password login', () => {
  test('elevate → 403 no_password, audited', async () => {
    const saved = HASH;
    HASH = null;
    try {
      const res = await call('/admin/elevate', {
        bearer: staffToken(), body: { password: PASSWORD },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('no_password');
      expect(auditStatuses()).toContain('rejected_no_hash');
    } finally {
      HASH = saved;
    }
  });
});
