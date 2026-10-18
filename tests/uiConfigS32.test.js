// tests/uiConfigS32.test.js
//
/**
 * ui-custom S3.2 — the server side of the Firm tab (routes/api.uiConfig.js +
 * services/uiConfigService.js), on a scripted stub DB:
 *   - GET /api/ui-config's can_edit_firm = lib/capabilities can(firm.settings),
 *     across roles (and a legacy token with no roles claim → false); and
 *     can_edit_system = can(system.settings) the same way (settings arc:
 *     it / su only — admin does not hold it);
 *   - the versions / view / restore auth matrix: no firm.settings →
 *     403 with nothing but the audit row touched; API key / no token → 401
 *     (pickers too — since ui-custom S5a any staff user reads it, so it is
 *     out of the 403 matrix; tests/uiConfigS5a.test.js has its staff 200);
 *   - versions: is_current mapped to a real boolean (mysql2 hands 1/0),
 *     config_key whitelisted; view: bad id 400, not a firm row's 404;
 *   - restore of a version the validator now refuses → 400 with errors[],
 *     the write path never reached;
 *   - pickers: keys + titles only (never html), bad keys dropped, the SQL
 *     asks for live tools and active views.
 * The same routes on a REAL engine (versions, no-op restore, stale version,
 * live-only pickers): tests/uiConfigS32.mysql.test.js (gated).
 *
 * Mutation-checked (see the S3.2 worker report).
 *
 * Run:  npx jest tests/uiConfigS32.test.js
 */

'use strict';

process.env.JWT_SECRET = 'ui-config-s32-test-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s32_internal';   // secret-scan: allow

const express = require('express');
const jwt = require('jsonwebtoken');

const uiRouter = require('../routes/api.uiConfig');
const svc = require('../services/uiConfigService');

function makeDb(script = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM api_keys WHERE key_hash/.test(s)) return [[]];
      if (/FROM ui_config_versions v/.test(s) && /ORDER BY v\.id DESC/.test(s)) return [script.versions || []];
      if (/FROM ui_config_versions v/.test(s) && /WHERE v\.id = \?/.test(s)) {
        return [script.version ? [{ row_config_key: script.version.config_key, ...script.version }] : []];
      }
      if (/AS version_id FROM ui_config c/.test(s)) return [script.heads || []];
      if (/FROM tools/.test(s)) return [script.tools || []];
      if (/FROM report_definitions/.test(s)) return [script.views || []];
      if (/FROM ui_config/.test(s)) return [script.uiRows || []];
      throw new Error('unscripted query: ' + s);
    },
    getConnection: async () => { throw new Error('the write path must not be reached'); },
  };
}

// HTTP round trips on a loaded machine (a full gated run beside Chromium
// surveys) can pass jest's 5 s default; 20 s still catches a real hang.
jest.setTimeout(20000);

// One server per router for the whole file, the stub db swapped per call.
// Building an app and listening anew on every call (several per test) hit
// jest's 5 s default under a loaded full run (2026-10-15) and could NO-GO
// another arc's landing. Calls in this file are sequential, so one current
// db is safe.
const callServers = new Map();
let callDb = null;
function callServer(router) {
  if (!callServers.has(router)) callServers.set(router, new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = callDb; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  }));
  return callServers.get(router);
}
afterAll(async () => {
  for (const p of callServers.values()) {
    const server = await p;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function call(method, url, { headers = {}, body, db }) {
  const server = await callServer(uiRouter);
  callDb = db;
  const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch (_) { /* text */ }
  return { status: r.status, body: json, text };
}

const tok = (roles, sub = 9) => ({ authorization: 'Bearer ' + jwt.sign(
  { sub, username: 'u' + sub, user_type: 1, user_auth: 'authorized', ...(roles === undefined ? {} : { roles }), aud: 'staff' },
  process.env.JWT_SECRET, { expiresIn: '5m' }) });
const KEY = { 'x-api-key': process.env.INTERNAL_API_KEY };
const notAudit = (db) => db.calls.filter((c) => !/jwt_api_audit_log/.test(c.sql));

const FIRM_ROUTES = [
  ['GET', '/api/ui-config/versions?config_key=registry_overrides'],
  ['GET', '/api/ui-config/versions/3'],
  ['POST', '/api/ui-config/versions/3/restore'],
];
// any staff user since ui-custom S5a (their own buttons pick tools / views)
const PICKERS = ['GET', '/api/ui-config/pickers'];

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────
describe('GET /api/ui-config — can_edit_firm', () => {
  test('true exactly for the firm.settings holders (admin / it / su), false for everyone else', async () => {
    const cases = [[['admin'], true], [['it'], true], [['su'], true], [['staff', 'admin'], true],
      [['staff'], false], [['attorney'], false], [['form_dev'], false], [['automation'], false], [[], false]];
    for (const [roles, want] of cases) {
      const r = await call('GET', '/api/ui-config', { headers: tok(roles), db: makeDb() });
      expect([roles, r.status, r.body.can_edit_firm]).toEqual([roles, 200, want]);
    }
  });

  test('a legacy token with no roles claim reads false (the same can() the write gate uses)', async () => {
    const r = await call('GET', '/api/ui-config', { headers: tok(undefined), db: makeDb() });
    expect([r.status, r.body.can_edit_firm]).toEqual([200, false]);
  });

  test('the flag is additive: firm / user layers unchanged', async () => {
    const db = makeDb({ uiRows: [{ scope: 'firm', user_id: 0, config_key: 'registry_overrides', config: { hidden: ['bills'] } }] });
    const r = await call('GET', '/api/ui-config', { headers: tok(['admin']), db });
    expect(r.body).toEqual({ status: 'success', firm: { registry_overrides: { hidden: ['bills'] } }, user: {}, can_edit_firm: true,
      can_edit_system: false,
      firm_versions: { registry_overrides: null, layout: null } });   // layout: the firm's default layout key (S6c)
  });
});

describe('GET /api/ui-config — can_edit_system (settings arc)', () => {
  test('true exactly for the system.settings holders (it / su), false for admin and everyone else', async () => {
    const cases = [[['it'], true], [['su'], true], [['staff', 'it'], true], [['admin'], false], [['staff', 'admin'], false],
      [['staff'], false], [['attorney'], false], [['form_dev'], false], [['automation'], false], [[], false]];
    for (const [roles, want] of cases) {
      const r = await call('GET', '/api/ui-config', { headers: tok(roles), db: makeDb() });
      expect([roles, r.status, r.body.can_edit_system]).toEqual([roles, 200, want]);
    }
  });

  test('a legacy token with no roles claim reads false; the flag adds no read (the same can() as the routes)', async () => {
    const db = makeDb();
    const r = await call('GET', '/api/ui-config', { headers: tok(undefined), db });
    expect([r.status, r.body.can_edit_system]).toEqual([200, false]);
    expect(notAudit(db).map((c) => c.sql).every((q) => /FROM ui_config/.test(q))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('Firm-tab routes — the auth matrix', () => {
  test('without firm.settings → 403 and nothing but the audit row touched', async () => {
    for (const roles of [['staff'], ['attorney'], ['form_dev'], [], undefined]) {
      for (const [m, url] of FIRM_ROUTES) {
        const db = makeDb({ versions: [{ id: 1 }], version: { id: 3, config_key: 'registry_overrides', config: {} } });
        const r = await call(m, url, { headers: tok(roles), db });
        expect([roles, m, url, r.status]).toEqual([roles, m, url, 403]);
        expect(notAudit(db)).toEqual([]);
      }
    }
  });

  test('API key → 401; no token → 401; nothing read', async () => {
    for (const headers of [KEY, {}]) {
      for (const [m, url] of [...FIRM_ROUTES, PICKERS]) {
        const db = makeDb();
        const r = await call(m, url, { headers, db });
        expect([m, url, r.status]).toEqual([m, url, 401]);
        expect(notAudit(db)).toEqual([]);
      }
    }
  });

  test('admin / it / su pass every route', async () => {
    for (const roles of [['admin'], ['it'], ['su']]) {
      const db = makeDb({ versions: [], version: { id: 3, config_key: 'registry_overrides', config: { hidden: ['moreSettings'] } } });
      expect((await call('GET', FIRM_ROUTES[0][1], { headers: tok(roles), db })).status).toBe(200);
      expect((await call('GET', FIRM_ROUTES[1][1], { headers: tok(roles), db })).status).toBe(200);
      expect((await call('GET', PICKERS[1], { headers: tok(roles), db })).status).toBe(200);
      // restore reaches the service (this version is stale-invalid → 400, not 403)
      expect((await call('POST', FIRM_ROUTES[2][1], { headers: tok(roles), db })).status).toBe(400);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('versions + view', () => {
  test('list: newest first as the SQL orders it; is_current a real boolean; only the firm row of that key', async () => {
    const db = makeDb({ versions: [
      { id: 7, saved_by: 1, saved_by_name: 'A', saved_at: '2026-10-15T10:00:00.000Z', size: '120', is_current: 1 },
      { id: 4, saved_by: 2, saved_by_name: null, saved_at: '2026-10-14T10:00:00.000Z', size: 64, is_current: 0 },
    ] });
    const r = await call('GET', '/api/ui-config/versions?config_key=registry_overrides', { headers: tok(['admin']), db });
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([
      { id: 7, saved_by: 1, saved_by_name: 'A', saved_at: '2026-10-15T10:00:00.000Z', size: 120, is_current: true },
      { id: 4, saved_by: 2, saved_by_name: null, saved_at: '2026-10-14T10:00:00.000Z', size: 64, is_current: false },
    ]);
    const q = notAudit(db)[0];
    expect(q.params).toEqual(['registry_overrides']);
    expect(q.sql).toMatch(/c\.scope = 'firm' AND c\.user_id = 0 AND c\.role = ''/);
    expect(q.sql).toMatch(/ORDER BY v\.id DESC LIMIT 200/);
  });

  test('list: config_key is whitelisted (firm keys only) → 400 otherwise', async () => {
    for (const k of ['', 'shortcuts', 'prefs', 'x%27--']) {   // (layout is a firm key since S6c)
      const db = makeDb();
      const r = await call('GET', `/api/ui-config/versions?config_key=${k}`, { headers: tok(['admin']), db });
      expect([k, r.status]).toEqual([k, 400]);
      expect(notAudit(db)).toEqual([]);
    }
    expect((await call('GET', '/api/ui-config/versions', { headers: tok(['admin']), db: makeDb() })).status).toBe(400);
  });

  test('view: one firm version in full; a bad id is 400; not a firm row\'s → 404', async () => {
    const version = { id: 3, config_key: 'registry_overrides', config: '{"hidden":["bills"]}', saved_by: 1, saved_by_name: 'A', saved_at: 'T' };
    const r = await call('GET', '/api/ui-config/versions/3', { headers: tok(['admin']), db: makeDb({ version }) });
    expect(r.body).toEqual({ status: 'success', version: { ...version, config: { hidden: ['bills'] } } });
    for (const bad of ['0', '-1', 'abc', '1.5', '99999999999']) {
      const db = makeDb({ version });
      expect([bad, (await call('GET', `/api/ui-config/versions/${bad}`, { headers: tok(['admin']), db })).status]).toEqual([bad, 400]);
      expect(notAudit(db)).toEqual([]);
    }
    expect((await call('GET', '/api/ui-config/versions/3', { headers: tok(['admin']), db: makeDb() })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('restore', () => {
  test('a version the validator now refuses → 400 listing the errors; the write path is never reached', async () => {
    const db = makeDb({ version: { id: 5, config_key: 'registry_overrides',
      config: { hidden: ['moreSettings'], items: [{ id: 'firm:x', label: 'X', icon: 'x', action: { type: 'action', fetch: '/clio-code', present: 'modal' } }] } } });
    const r = await call('POST', '/api/ui-config/versions/5/restore', { headers: tok(['admin']), db });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/version 5 no longer passes/);
    expect(r.body.errors.join(' | ')).toMatch(/moreSettings cannot be hidden/);
    expect(r.body.errors.join(' | ')).toMatch(/there is no action kind: a firm action is a tool item/);
  });

  test('a missing version → 404, nothing written', async () => {
    const r = await call('POST', '/api/ui-config/versions/5/restore', { headers: tok(['admin']), db: makeDb() });
    expect(r.status).toBe(404);
  });

  test('restore goes through write(): the capability re-check refuses a non-holder even past the route', async () => {
    const db = makeDb({ version: { id: 5, config_key: 'registry_overrides', config: { hidden: ['bills'] } } });
    await expect(svc.restoreVersion(db, 5, { type: 'jwt', userId: 9, roles: ['staff'] })).rejects.toMatchObject({ status: 403 });
    // with the capability it reaches the transaction (the stub refuses it there)
    await expect(svc.restoreVersion(db, 5, { type: 'jwt', userId: 1, roles: ['admin'] })).rejects.toThrow(/write path must not be reached/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('pickers', () => {
  test('keys + titles only — never html; bad keys dropped; blank title → the key', async () => {
    const db = makeDb({
      tools: [{ tool_key: 'appt-form', title: 'Appt Form', html: '<script>x</script>' }, { tool_key: 'Bad Key', title: 'x' },
        { tool_key: 'call-review', title: '  ' }],
      views: [{ report_key: 'lead_followups', title: 'Leads' }, { report_key: 'X', title: 'bad' }],
    });
    const r = await call('GET', '/api/ui-config/pickers', { headers: tok(['admin']), db });
    expect(r.body).toEqual({ status: 'success',
      tools: [{ key: 'appt-form', title: 'Appt Form' }, { key: 'call-review', title: 'call-review' }],
      views: [{ key: 'lead_followups', title: 'Leads' }] });
    expect(r.text).not.toMatch(/script|html/);
    const [tq, vq] = notAudit(db);
    expect(tq.sql).toMatch(/^SELECT tool_key, title FROM tools WHERE status = 'live'/);
    expect(vq.sql).toMatch(/FROM report_definitions WHERE kind = 'view' AND is_active = 1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix round (review SF1 / N3): optimistic concurrency's envelope + the restore key binding.
describe('base (optimistic concurrency) — envelope and delivery', () => {
  const shape = require('../lib/uiConfigShape');
  const FIRM = { scope: 'firm', config_key: 'registry_overrides', config: {} };

  test('base is optional, firm-only, a version id or null', () => {
    expect(shape.validateWrite(FIRM).value).not.toHaveProperty('base');          // absent → no check (S3.1 contract)
    expect(shape.validateWrite({ ...FIRM, base: null }).value.base).toBe(null);
    expect(shape.validateWrite({ ...FIRM, base: 12 }).value.base).toBe(12);
    for (const bad of [0, -1, 1.5, '12', true, {}, [], 4294967296]) {
      expect([bad, shape.validateWrite({ ...FIRM, base: bad }).ok]).toEqual([bad, false]);
    }
    const u = shape.validateWrite({ scope: 'user', config_key: 'shortcuts', config: {}, base: 3 });
    expect([u.ok, u.errors.join(' ')]).toEqual([false, expect.stringMatching(/firm" only/)]);
  });

  test('GET hands firm.settings holders the newest version id per firm key; staff get none and cost no query', async () => {
    const db = makeDb({ heads: [{ config_key: 'registry_overrides', version_id: '7' }, { config_key: 'nope', version_id: 3 }] });
    const r = await call('GET', '/api/ui-config', { headers: tok(['admin']), db });
    expect(r.body.firm_versions).toEqual({ registry_overrides: 7, layout: null });
    const db2 = makeDb({ heads: [{ config_key: 'registry_overrides', version_id: 7 }] });
    const r2 = await call('GET', '/api/ui-config', { headers: tok(['staff']), db: db2 });
    expect(r2.body).not.toHaveProperty('firm_versions');
    expect(db2.calls.some((c) => /AS version_id/.test(c.sql))).toBe(false);
  });

  test('S6c-3 review SF1: the version ids are read BEFORE the documents (a save between them can only cost a spurious 409)', async () => {
    const db = makeDb({ heads: [{ config_key: 'registry_overrides', version_id: 7 }] });
    await call('GET', '/api/ui-config', { headers: tok(['admin']), db });
    const order = notAudit(db).map((c) => c.sql);
    const heads = order.findIndex((q) => /AS version_id FROM ui_config c/.test(q));
    const docs = order.findIndex((q) => /FROM ui_config/.test(q) && !/AS version_id/.test(q));
    expect(heads).toBeGreaterThanOrEqual(0);
    expect(docs).toBeGreaterThanOrEqual(0);
    expect(heads).toBeLessThan(docs);
  });

  test('N3: a version whose key disagrees with its parent row\'s → 400, nothing written; view never leaks the parent key', async () => {
    const version = { id: 5, config_key: 'registry_overrides', row_config_key: 'other_key', config: { hidden: ['bills'] } };
    const r = await call('POST', '/api/ui-config/versions/5/restore', { headers: tok(['admin']), db: makeDb({ version }) });
    expect([r.status, r.body.message]).toEqual([400, 'version 5 does not match its row\'s config_key']);
    const v = await call('GET', '/api/ui-config/versions/5', { headers: tok(['admin']), db: makeDb({ version: { ...version, row_config_key: 'registry_overrides' } }) });
    expect(v.body.version).not.toHaveProperty('row_config_key');
  });

  test('restore passes the body\'s base through (a bad one is the envelope\'s 400)', async () => {
    const version = { id: 5, config_key: 'registry_overrides', config: { hidden: ['bills'] } };
    const r = await call('POST', '/api/ui-config/versions/5/restore', { headers: tok(['admin']), body: { base: 'x' }, db: makeDb({ version }) });
    expect([r.status, r.body.message, r.body.errors]).toEqual([400, 'base must be a version id or null', ['base must be a version id or null']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The base check on the REAL uiConfigService.write, always-run (the gated
// mysql suite is skipped in CI). A scripted transaction connection stands in
// for MySQL: it answers the FOR UPDATE read and the head-version read, and
// records every statement, so "nothing written" is asserted directly.
describe('write(): the optimistic-concurrency base check (always-run)', () => {
  const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
  const NEW = { hidden: ['tasks'], locked: [], renames: {}, items: [] };
  function txDb({ row = { id: 4, config: { hidden: ['bills'], locked: [], renames: {}, items: [] } }, head = 7 } = {}) {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push(s);
        if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) return [row ? [row] : []];
        if (/^SELECT MAX\(id\) AS id FROM ui_config_versions WHERE ui_config_id = \?$/.test(s)) return [[{ id: head }]];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: row ? row.id : 4 }];
        if (/^INSERT INTO ui_config_versions /.test(s)) return [{ insertId: head + 1 }];
        throw new Error('unscripted statement: ' + s);
      },
    };
    return { stmts, writes: () => stmts.filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s)), getConnection: async () => conn, query: async () => { throw new Error('pool query not expected'); } };
  }
  const body = (extra) => ({ scope: 'firm', config_key: 'registry_overrides', config: NEW, ...extra });

  test('a stale base → 409 with CONFLICT_MSG, and no INSERT / UPDATE is issued', async () => {
    const db = txDb({ head: 7 });
    await expect(svc.write(db, body({ base: 6 }), admin)).rejects.toMatchObject({ status: 409, message: svc.CONFLICT_MSG });
    expect(db.writes()).toEqual([]);
    expect(db.stmts.some((s) => /FOR UPDATE$/.test(s))).toBe(true);        // checked under the row lock
  });

  test('the current base → it proceeds: the row and a version are written; version_id is the new one', async () => {
    const db = txDb({ head: 7 });
    const r = await svc.write(db, body({ base: 7 }), admin);
    expect([r.changed, r.versioned, r.version_id]).toEqual([true, true, 8]);
    expect(db.writes().map((s) => s.split(' (')[0])).toEqual(['INSERT INTO ui_config', 'INSERT INTO ui_config_versions']);
  });

  test('base: null while a firm row exists → 409, nothing written', async () => {
    const db = txDb({ head: 7 });
    await expect(svc.write(db, body({ base: null }), admin)).rejects.toMatchObject({ status: 409, message: svc.CONFLICT_MSG });
    expect(db.writes()).toEqual([]);
    // …and null is the right base when there is no row yet
    const fresh = txDb({ row: null });
    expect((await svc.write(fresh, body({ base: null }), admin)).changed).toBe(true);
  });

  test('no base → no check (the S3.1 contract): it proceeds whatever the head', async () => {
    const db = txDb({ head: 99 });
    const r = await svc.write(db, body({}), admin);
    expect([r.changed, r.version_id]).toEqual([true, 100]);
    expect(db.writes()).toHaveLength(2);
  });
});
