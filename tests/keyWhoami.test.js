// tests/keyWhoami.test.js
//
/**
 * GET /api/readonly/whoami — a session key asks what it holds
 * (routes/api.readonly.js; ACCESS_CONTROL_DESIGN §5.2).
 *
 * The key string's suffix is a hint that goes stale; this route is the
 * authority, so what it must get right is everything the column alone gets
 * wrong (the real-engine half is tests/keyWhoami.mysql.test.js).
 *
 * WHAT IS LOCKED
 *   - The whole body, exactly: nothing else about the key leaves (no hash, no
 *     created_by, no parent scopes).
 *   - No scope needed: a key holding none of the surfaces still gets its answer.
 *   - `scopes` is what the key can do, not what the column says: legacy NULL
 *     expands to its surface minus the explicit scopes; a child is own ∩ trio ∩
 *     parent; route / capability / retired names drop out; malformed → [].
 *   - It agrees with the gates: over every scope shape and every surface, a
 *     scope is listed iff the real requireKeyScope passes that key.
 *   - `expiresAt` is when the key stops working: a child's earlier of own and
 *     parent's, whichever way round.
 *   - A dead key gets its usual 401 and no log row; a live call writes one, and
 *     the RO pool is never touched.
 *
 * Run: npx jest tests/keyWhoami.test.js
 */
'use strict';

const http = require('http');
const express = require('express');

const mockRoCalls = [];
jest.mock('../startup/dbReadonly', () => ({
  getConnection: async () => { mockRoCalls.push('getConnection'); throw new Error('whoami must not touch the RO pool'); },
}));

const { KEY_SCOPES } = require('../lib/capabilities');
const { readonlyApiKeyAuth, requireKeyScope } = require('../lib/auth.readonly');
const router = require('../routes/api.readonly');

const HOUR = 3600e3;
const LEGACY_SURFACE = ['sql.ro', 'scratch', 'alert', 'temp.clio', 'temp.dropbox', 'temp.zohosign'];
const flush = () => new Promise((r) => setTimeout(r, 0));

const inHours = (h) => new Date(Date.now() + h * HOUR);
const rootRow = (over = {}) => ({
  id: 92, label: 'docs session', expires_at: inHours(1), revoked_at: null, scopes: ['sql.ro', 'scratch', 'alert'],
  parent_key_id: null, created_by: 6, parent_id: null, parent_expires_at: null, parent_revoked_at: null, parent_scopes: null,
  ...over,
});
const childRow = (over = {}) => rootRow({
  id: 93, label: 'worker', scopes: ['sql.ro', 'scratch'], parent_key_id: 92, parent_id: 92,
  parent_expires_at: inHours(2), parent_scopes: ['sql.ro', 'scratch', 'alert', 'keys.mint'], ...over,
});

function get(app, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path: urlPath, method: 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

function appOver(row) {
  const logs = [];
  const db = {
    query: async (q, params = []) => {
      const s = String(q).replace(/\s+/g, ' ').trim();
      if (/FROM readonly_api_keys/.test(s)) return [row ? [row] : []];
      if (/^UPDATE readonly_api_keys/.test(s)) return [{}];
      if (/^INSERT INTO readonly_query_log/.test(s)) {
        const cols = s.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim());
        logs.push(Object.fromEntries(cols.map((c, i) => [c, params[i]])));
        return [{}];
      }
      if (/admin_audit_log/.test(s)) return [{ insertId: 1 }];
      throw new Error('unscripted: ' + s);
    },
  };
  const app = express();
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  // The real gate, for any surface named in the path.
  app.get('/probe/:scope', readonlyApiKeyAuth, (req, res, next) => requireKeyScope(req.params.scope)(req, res, next),
    (_req, res) => res.json({ ok: true }));
  return { app, logs };
}

async function whoami(row, headers = { 'x-readonly-api-key': 'ycro_test' }) {
  const { app, logs } = appOver(row);
  const r = await get(app, '/api/readonly/whoami', headers);
  await flush();
  return { ...r, logs };
}

beforeEach(() => { mockRoCalls.length = 0; });

describe('GET /api/readonly/whoami', () => {
  test('the whole body, exactly, and one log row; the RO pool is never touched', async () => {
    const expires_at = inHours(1);
    const r = await whoami(rootRow({ expires_at, scopes: ['sql.ro', 'keys.mint', 'sql.ro.sensitive'] }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true, id: 92, label: 'docs session',
      scopes: ['sql.ro', 'sql.ro.sensitive', 'keys.mint'],          // vocabulary order, whatever the column's
      legacy: false, expiresAt: expires_at.toISOString(), parentKeyId: null,
    });
    expect(r.logs).toEqual([expect.objectContaining({
      api_key_id: 92, sql_text: 'GET /api/readonly/whoami', status: 'success', row_count: 1, sensitive_key: 1 })]);
    expect(mockRoCalls).toEqual([]);
  });

  test('no scope needed: a key holding no surface still gets its answer', async () => {
    const r = await whoami(rootRow({ scopes: ['route:/process-jobs'] }));
    expect(r.status).toBe(200);
    expect(r.body.scopes).toEqual([]);
  });

  test('a legacy NULL key lists its real surface, never the explicit scopes', async () => {
    const r = await whoami(rootRow({ scopes: null }));
    expect(r.body.legacy).toBe(true);
    expect(r.body.scopes).toEqual(LEGACY_SURFACE);
  });

  test('what grants nothing drops out; a JSON-string column parses; a malformed one is empty', async () => {
    const retired = await whoami(rootRow({ scopes: ['sql.ro', 'temp.ringcentral', 'firm.settings', 'route:/x'] }));
    expect(retired.body.scopes).toEqual(['sql.ro']);
    const stringy = await whoami(rootRow({ scopes: '["scratch","alert"]' }));
    expect(stringy.body.scopes).toEqual(['scratch', 'alert']);
    const bad = await whoami(rootRow({ scopes: 'not json' }));
    expect(bad.body).toMatchObject({ scopes: [], legacy: false });
  });

  test('a child is its effective set: narrowed by the parent, never its column', async () => {
    const r = await whoami(childRow({ parent_scopes: ['sql.ro', 'alert'] }));
    expect(r.body).toMatchObject({ id: 93, scopes: ['sql.ro'], legacy: false, parentKeyId: 92 });
    const nul = await whoami(childRow({ scopes: null }));
    expect(nul.body).toMatchObject({ scopes: [], legacy: false });      // never the legacy surface
  });

  test('expiresAt is when the key stops working: a child takes the earlier, either way round', async () => {
    const sooner = inHours(1);
    const later = inHours(2);
    const parentFirst = await whoami(childRow({ expires_at: later, parent_expires_at: sooner }));
    expect(parentFirst.body.expiresAt).toBe(sooner.toISOString());
    const ownFirst = await whoami(childRow({ expires_at: sooner, parent_expires_at: later }));
    expect(ownFirst.body.expiresAt).toBe(sooner.toISOString());
  });

  test('it agrees with the gates: a scope is listed iff requireKeyScope passes that key', async () => {
    const shapes = [
      rootRow({ scopes: null }),
      rootRow({ scopes: ['sql.ro', 'tasks.own', 'temp.clio'] }),
      rootRow({ scopes: ['temp.ringcentral'] }),
      rootRow({ scopes: 'not json' }),
      childRow(),
      childRow({ parent_scopes: null }),
      childRow({ scopes: ['sql.ro', 'keys.mint'] }),
    ];
    for (const row of shapes) {
      const listed = (await whoami(row)).body.scopes;
      for (const s of Object.keys(KEY_SCOPES)) {
        const { app } = appOver(row);
        const gate = await get(app, `/probe/${s}`, { 'x-readonly-api-key': 'ycro_test' });
        expect({ s, column: row.scopes, passes: gate.status === 200 }).toEqual({ s, column: row.scopes, passes: listed.includes(s) });
      }
    }
  });

  test.each([
    ['no key sent', rootRow(), {}, /key required/],
    ['unknown key', null, undefined, /Invalid readonly API key/],
    ['revoked', rootRow({ revoked_at: inHours(-1) }), undefined, /revoked/],
    ['expired', rootRow({ expires_at: inHours(-1) }), undefined, /expired/],
    ['child of a revoked parent', childRow({ parent_revoked_at: inHours(-1) }), undefined, /parent key revoked/],
    ['child of an expired parent', childRow({ parent_expires_at: inHours(-1) }), undefined, /parent key expired/],
  ])('%s: 401, no answer, no log row', async (_name, row, headers, msg) => {
    const r = await whoami(row, headers);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(msg);
    expect(r.body.scopes).toBeUndefined();
    expect(r.logs).toEqual([]);
  });
});
