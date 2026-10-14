// tests/accessA2SuRole.test.js
//
/**
 * Access-control A2 — SU moves from the user_auth string to the `su` role
 * (ref/ACCESS_CONTROL_DESIGN.md §2.4): lib/auth.superuser isSuperuser /
 * rowIsSuperuser, the straggler reroutes, the phantom 'authorized - admin'
 * tier removal, and scripts/accessA2SuRole.js stage 1.
 *
 * Proof obligations:
 *   1. THE PREDICATES. A `su` role passes with a plain 'authorized'
 *      user_auth; the legacy string still passes (dual-accept window, A2b
 *      removes); everything else fails. Same for the DB-row variant.
 *   2. THE PHANTOM. 'authorized - admin' no longer authorizes anything:
 *      gone from both route files as a literal, and a token carrying it is
 *      403'd where it used to pass.
 *   3. THE SCRIPT. Every live state maps to the right remaining steps
 *      (fresh / altered-only / done), every unexpected state is a NO-GO
 *      before any write, and lock_wait_timeout is set on the session
 *      BEFORE the ALTER.
 *
 *   npx jest tests/accessA2SuRole.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const { isSuperuser, rowIsSuperuser } = require('../lib/auth.superuser');
const script = require('../scripts/accessA2SuRole');
const { run, ALTER_SQL, GRANT_SQL, CUR_SET, NEW_SET } = script;

const REPO = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');

// ── 1. predicates ────────────────────────────────────────────────────────────

describe('isSuperuser (JWT-shaped, A2 dual-accept)', () => {
  const jwtAuth = (over = {}) =>
    ({ type: 'jwt', userId: 6, username: 'IT', user_auth: 'authorized', roles: [], ...over });

  test('su role passes with plain authorized user_auth', () => {
    expect(isSuperuser(jwtAuth({ roles: ['it', 'admin', 'su'] }))).toBe(true);
  });
  test('legacy SU string passes with no roles (dual-accept window)', () => {
    expect(isSuperuser(jwtAuth({ user_auth: 'authorized - SU' }))).toBe(true);
  });
  test('both at once passes', () => {
    expect(isSuperuser(jwtAuth({ user_auth: 'authorized - SU', roles: ['su'] }))).toBe(true);
  });
  test('ordinary staff fails', () => {
    expect(isSuperuser(jwtAuth({ roles: ['staff'] }))).toBe(false);
  });
  test('it/admin roles alone do NOT make SU', () => {
    expect(isSuperuser(jwtAuth({ roles: ['it', 'admin', 'form_dev'] }))).toBe(false);
  });
  test('the phantom admin string fails', () => {
    expect(isSuperuser(jwtAuth({ user_auth: 'authorized - admin' }))).toBe(false);
  });
  test('non-jwt auth types fail even with su markers', () => {
    expect(isSuperuser({ type: 'api_key', roles: ['su'], user_auth: 'authorized - SU' })).toBe(false);
    expect(isSuperuser({ type: 'portal', roles: ['su'] })).toBe(false);
    expect(isSuperuser(null)).toBe(false);
    expect(isSuperuser(undefined)).toBe(false);
  });
  test('non-array roles claim is tolerated', () => {
    expect(isSuperuser(jwtAuth({ roles: 'su' }))).toBe(false);
  });
});

describe('rowIsSuperuser (DB-row-shaped)', () => {
  test('su in the roles csv passes, wherever it sits', () => {
    expect(rowIsSuperuser({ user_auth: 'authorized', roles: 'it,admin,su' })).toBe(true);
    expect(rowIsSuperuser({ user_auth: 'authorized', roles: 'su' })).toBe(true);
    expect(rowIsSuperuser({ user_auth: 'authorized', roles: ' su ,staff' })).toBe(true);
  });
  test('legacy SU string passes with empty/null roles', () => {
    expect(rowIsSuperuser({ user_auth: 'authorized - SU', roles: '' })).toBe(true);
    expect(rowIsSuperuser({ user_auth: 'authorized - SU', roles: null })).toBe(true);
  });
  test('neither marker fails; missing row fails', () => {
    expect(rowIsSuperuser({ user_auth: 'authorized', roles: 'it,admin,staff' })).toBe(false);
    expect(rowIsSuperuser({ user_auth: 'disabled', roles: '' })).toBe(false);
    expect(rowIsSuperuser(null)).toBe(false);
    expect(rowIsSuperuser(undefined)).toBe(false);
  });
  test('a DISABLED user is never SU, whatever roles the row holds (A2-F1)', () => {
    // Pre-A2 the off switch overwrote the SU string; with SU on the roles
    // SET the status check must be explicit, or a disabled SU with a live
    // 24h token keeps every DB-read bypass.
    expect(rowIsSuperuser({ user_auth: 'disabled', roles: 'su' })).toBe(false);
    expect(rowIsSuperuser({ user_auth: 'disabled', roles: 'it,admin,form_dev,su' })).toBe(false);
    expect(rowIsSuperuser({ user_auth: '', roles: 'su' })).toBe(false);
  });
  test("'su' must be a whole member, not a substring", () => {
    expect(rowIsSuperuser({ user_auth: 'authorized', roles: 'super,status' })).toBe(false);
  });
});

// ── 1b. the rerouted DB-row call sites meet a ROLE-ONLY SU (A2-F2) ──────────
// Until A2b deletes the legacy string, every live SU row carries it — so
// these are the only tests where the sites see su-by-role alone. A mutant
// reverting any site to string-only dies here.

describe('DB-row call sites on a role-only SU', () => {
  const userDb = (row) => ({
    query: async (sql) => {
      if (/FROM users/i.test(String(sql))) {
        return [Array.isArray(row) ? row : (row ? [row] : []), []];
      }
      throw new Error(`unscripted SQL: ${sql}`);
    },
  });
  const ROLE_ONLY_SU = { user: 6, username: 'IT', user_auth: 'authorized', roles: 'it,admin,su' };
  const DISABLED_SU  = { user: 6, username: 'IT', user_auth: 'disabled',   roles: 'it,admin,su' };

  test('ctaService.isActiveSuperuser (B1 kill switch)', async () => {
    const cta = require('../services/ctaService');
    expect(await cta.isActiveSuperuser(userDb(ROLE_ONLY_SU), 6)).toBe(true);
    expect(await cta.isActiveSuperuser(userDb(DISABLED_SU), 6)).toBe(false);
    expect(await cta.isActiveSuperuser(userDb(null), 6)).toBe(false);
  });

  test('mailboxService.isSuperuser (the 24h-freshness read)', async () => {
    const mbx = require('../services/mailboxService');
    expect(await mbx.isSuperuser(userDb(ROLE_ONLY_SU), 6)).toBe(true);
    expect(await mbx.isSuperuser(userDb(DISABLED_SU), 6)).toBe(false);
  });

  test('alerting._activeSuUserId picks a role-only SU and skips a disabled one', async () => {
    const { _activeSuUserId } = require('../lib/alerting');
    const staff = { user: 2, username: 'VS', user_auth: 'authorized', roles: 'staff' };
    expect(await _activeSuUserId(userDb([staff, ROLE_ONLY_SU]))).toBe(6);
    expect(await _activeSuUserId(userDb([staff, DISABLED_SU]))).toBe(null);
  });

  test('isFormDev accepts a role-only SU (A2-F3 straggler, rerouted)', () => {
    const { isFormDev } = require('../lib/auth.formDev');
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized', roles: ['su'] })).toBe(true);
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized', roles: ['staff'] })).toBe(false);
  });
});

// ── 2. the phantom tier ──────────────────────────────────────────────────────

describe("the 'authorized - admin' phantom tier is gone", () => {
  test('no route file carries the literal in CODE any more (comments may name it)', () => {
    for (const f of ['routes/api.issueReports.js', 'routes/api.featureRequests.js']) {
      const code = read(f).split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect(code.includes('authorized - admin')).toBe(false);
      expect(code.includes('ADMIN_AUTH')).toBe(false);
    }
  });

  // Route-level: mount the real router behind the real jwtOrApiKey with a
  // stub req.db (audit inserts + the list SELECT). No mocking of the module
  // under test — the real gate decides.
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'a2-test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });

  function appWithDb() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.db = {
        query: async (sql) => {
          const s = String(sql);
          if (/COUNT\(\*\)/i.test(s)) return [[{ total: 0 }], []];
          if (/SUM\(/i.test(s)) return [[{}], []]; // the stats card row
          return [[], []];
        },
      };
      next();
    });
    app.use(require('../routes/api.issueReports'));
    return app;
  }

  function tokenWith(claims) {
    return jwt.sign(
      { sub: 6, username: 'IT', user_type: 1, aud: 'staff',
        user_auth: 'authorized', roles: [], ...claims },
      process.env.JWT_SECRET, { expiresIn: '5m' }
    );
  }

  function get(app, token) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app).listen(0, () => {
        const { port } = srv.address();
        http.get(
          { port, path: '/api/issue-reports', headers: { authorization: `Bearer ${token}` } },
          res => { res.resume(); res.on('end', () => { srv.close(); resolve(res.statusCode); }); }
        ).on('error', e => { srv.close(); reject(e); });
      });
    });
  }

  test("a token with user_auth 'authorized - admin' is 403'd on the admin list", async () => {
    expect(await get(appWithDb(), tokenWith({ user_auth: 'authorized - admin' }))).toBe(403);
  });
  test('a su-role token passes the gate', async () => {
    expect(await get(appWithDb(), tokenWith({ roles: ['su'] }))).toBe(200);
  });
  test('the legacy SU string still passes the gate (dual-accept window)', async () => {
    expect(await get(appWithDb(), tokenWith({ user_auth: 'authorized - SU' }))).toBe(200);
  });
  test('plain staff is 403’d', async () => {
    expect(await get(appWithDb(), tokenWith({ roles: ['staff'] }))).toBe(403);
  });
});

// ── 3. the stage-1 script ────────────────────────────────────────────────────

// Scripted single connection: models only what the script touches —
// information_schema COLUMN_TYPE, the legacy-SU SELECT, the ALTER, the
// session setting, the grant UPDATE.
function fakeConn(state) {
  const log = [];
  return {
    log,
    state,
    async query(sql, params) {
      log.push(sql);
      if (/COLUMN_TYPE/i.test(sql)) {
        return [[{ ct: state.ct, coll: state.coll ?? 'utf8mb4_general_ci', cmt: state.cmt ?? '' }], []];
      }
      if (/SELECT `user`, username/.test(sql)) {
        return [state.rows.filter(r => r.user_auth === (params ? params[0] : 'authorized - SU')
          || r.user_auth === 'authorized - SU'), []];
      }
      if (/^SET SESSION lock_wait_timeout/.test(sql)) { state.lockSet = true; return [{}, []]; }
      if (/^ALTER TABLE/.test(sql)) {
        if (!state.lockSet) throw new Error('test harness: ALTER before lock_wait_timeout');
        if (!state.alterLies) state.ct = NEW_SET; // alterLies: ALTER "succeeds" but the type never changes
        return [{}, []];
      }
      if (/^UPDATE users SET roles/.test(sql)) {
        let n = 0;
        for (const r of state.rows) {
          if (r.user_auth === params[0] && !String(r.roles || '').split(',').map(s => s.trim()).includes('su')) {
            r.roles = r.roles ? `${r.roles},su` : 'su'; n++;
          }
        }
        return [{ affectedRows: n }, []];
      }
      throw new Error(`test harness: unscripted SQL: ${sql}`);
    },
  };
}

const FRESH = () => ({
  ct: CUR_SET, lockSet: false,
  rows: [{ user: 6, username: 'IT', user_auth: 'authorized - SU', roles: 'it,admin,form_dev' }],
});

describe('scripts/accessA2SuRole.js', () => {
  let silence;
  beforeEach(() => { silence = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => silence.mockRestore());

  test('CHECK on the fresh state is GO and writes nothing', async () => {
    const c = fakeConn(FRESH());
    expect((await run(c, { apply: false })).ok).toBe(true);
    expect(c.log.some(s => /^ALTER|^UPDATE|^SET SESSION/.test(s))).toBe(false);
    expect(c.state.ct).toBe(CUR_SET);
  });

  test('APPLY on the fresh state alters, grants, verifies — in that order', async () => {
    const c = fakeConn(FRESH());
    expect((await run(c, { apply: true })).ok).toBe(true);
    expect(c.state.ct).toBe(NEW_SET);
    expect(c.state.rows[0].roles).toBe('it,admin,form_dev,su');
    const iLock = c.log.findIndex(s => /^SET SESSION lock_wait_timeout/.test(s));
    const iAlter = c.log.findIndex(s => /^ALTER TABLE/.test(s));
    const iGrant = c.log.findIndex(s => /^UPDATE users SET roles/.test(s));
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iAlter).toBeGreaterThan(iLock);
    expect(iGrant).toBeGreaterThan(iAlter);
  });

  test('resume: SET already altered → only the grant runs', async () => {
    const st = FRESH(); st.ct = NEW_SET;
    const c = fakeConn(st);
    expect((await run(c, { apply: true })).ok).toBe(true);
    expect(c.log.some(s => /^ALTER TABLE/.test(s))).toBe(false);
    expect(c.state.rows[0].roles).toBe('it,admin,form_dev,su');
  });

  test('done: fully applied → GO as a no-op, no writes', async () => {
    const st = FRESH(); st.ct = NEW_SET; st.rows[0].roles = 'it,admin,form_dev,su';
    const c = fakeConn(st);
    expect((await run(c, { apply: true })).ok).toBe(true);
    expect(c.log.some(s => /^ALTER|^UPDATE|^SET SESSION/.test(s))).toBe(false);
  });

  test('NO-GO: an ALTER whose read-back is not the target stops before the grant', async () => {
    const st = FRESH(); st.alterLies = true;
    const c = fakeConn(st);
    expect((await run(c, { apply: true })).ok).toBe(false);
    expect(c.log.some(s => /^UPDATE users SET roles/.test(s))).toBe(false);
  });

  test('NO-GO: an unexpected collation or column comment stops before any write (A2-F5)', async () => {
    for (const patch of [{ coll: 'utf8mb4_bin' }, { cmt: 'some comment' }]) {
      const st = Object.assign(FRESH(), patch);
      const c = fakeConn(st);
      expect((await run(c, { apply: true })).ok).toBe(false);
      expect(c.log.some(s => /^ALTER|^UPDATE|^SET SESSION/.test(s))).toBe(false);
    }
  });

  test('NO-GO: an unexpected COLUMN_TYPE stops before any write', async () => {
    const st = FRESH(); st.ct = "set('it','admin')";
    const c = fakeConn(st);
    expect((await run(c, { apply: true })).ok).toBe(false);
    expect(c.log.some(s => /^ALTER|^UPDATE|^SET SESSION/.test(s))).toBe(false);
  });

  test('NO-GO: two legacy-SU rows stop before any write', async () => {
    const st = FRESH();
    st.rows.push({ user: 2, username: 'VS', user_auth: 'authorized - SU', roles: 'staff' });
    const c = fakeConn(st);
    expect((await run(c, { apply: true })).ok).toBe(false);
    expect(c.log.some(s => /^ALTER|^UPDATE|^SET SESSION/.test(s))).toBe(false);
  });

  test('the migration record carries the same SQL the script runs', () => {
    const rec = read('ref/migrations/2026-10-14_access_a2_su_role.sql');
    expect(rec).toContain("'form_dev','su')");
    expect(rec).toContain('ALGORITHM=INPLACE, LOCK=NONE');
    expect(rec).toContain("CONCAT_WS(',', NULLIF(roles,''), 'su')");
    expect(ALTER_SQL).toContain("'form_dev','su')");
    expect(GRANT_SQL).toContain("NOT FIND_IN_SET('su', roles)");
  });

  test('ref/database.sql is on one side of the migration, not elsewhere', () => {
    const ddl = read('ref/database.sql');
    const cur = ddl.includes("set('it','admin','staff','attorney','automation','form_dev')");
    const next = ddl.includes("set('it','admin','staff','attorney','automation','form_dev','su')");
    expect(cur || next).toBe(true);
  });
});
