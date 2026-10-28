// tests/readonlySettings.test.js
//
/**
 * GET /api/readonly/settings — app_settings for session keys, without its
 * secrets (settings-access arc, Fred 2026-10-28).
 *
 * app_settings stays a SECRET table to POST /api/readonly/sql; this endpoint
 * serves the rest, judged by lib/settingsRegistry in code.
 *
 * WHAT IS LOCKED
 *   - Exactly which rows come back from a store holding every class: a
 *     registry secret whose row is NOT flagged (rc_subscriptions — the
 *     RingCentral renewal REPLACEs it without the flag), a flagged secret, an
 *     unregistered flagged row, access and retired kinds, clio_login_code,
 *     an is_editable = 0 variable, and rows spelled as a registered key with
 *     other case / trailing spaces (the collation folds them onto it).
 *   - No withheld value appears anywhere in the response. The mocked RO pool
 *     returns raw values (it ignores the SELECT's IF), so the registry
 *     filter alone is under test here.
 *   - Over the WHOLE registry: a registered key is served iff its kind is not
 *     secret / access / retired and it is not clio_login_code — a new
 *     secret-kind key is withheld with no other change.
 *   - The scope: a key without sql.ro gets 403 and nothing runs; every call
 *     writes one readonly_query_log row.
 *
 * Run: npx jest tests/readonlySettings.test.js
 */
'use strict';

const http = require('http');
const express = require('express');

let mockRoRows = [];
const roCalls = [];
jest.mock('../startup/dbReadonly', () => ({
  getConnection: async () => ({
    query: async (sql) => {
      roCalls.push(String(sql));
      if (/^SET SESSION/.test(sql)) return [{}];
      return [mockRoRows.map((r) => ({ ...r }))];
    },
    release() {},
  }),
}));

const reg = require('../lib/settingsRegistry');
const router = require('../routes/api.readonly');
const { aiReadableSetting } = router;

const flush = () => new Promise((r) => setTimeout(r, 0));

function listen(app, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path: urlPath, method: 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, raw: data, body: JSON.parse(data || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

async function ask(scopes) {
  roCalls.length = 0;
  const logs = [];
  const db = {
    query: async (q, params = []) => {
      const s = String(q).replace(/\s+/g, ' ').trim();
      if (/FROM readonly_api_keys/.test(s)) {
        return [[{ id: 92, label: 'k', expires_at: new Date(Date.now() + 3600e3), revoked_at: null, scopes }]];
      }
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
  const r = await listen(app, '/api/readonly/settings', { 'x-readonly-api-key': 'ycro_test' });
  await flush();
  return { ...r, logs, ran: roCalls.filter((q) => !/^SET SESSION/.test(q)) };
}

const row = (key, value, { is_secret = 0, is_editable = 1 } = {}) =>
  ({ key, value, is_secret, is_editable, updated_at: '2026-10-28T00:00:00.000Z' });

// Every withheld value carries the marker, so one scan of the raw response
// proves none leaked.
const STORE = [
  row('firm_name', 'Example Firm'),
  row('cloud_tasks_enabled', '1'),
  row('alert_last_sweep_at', '2026-10-28T03:00:00.000Z', { is_editable: 0 }),
  row('fe-lead_sources', '["Google"]'),
  row('intake_banner_text', 'Open today'),
  row('rc_subscriptions', 'WITHHELD-rc-subs'),                                  // secret kind, row NOT flagged
  row('internal_api_key', 'WITHHELD-internal', { is_secret: 1, is_editable: 0 }),
  row('vendor_side_token', 'WITHHELD-vendor', { is_secret: 1 }),                // unregistered, flagged
  row('firm_email', 'WITHHELD-flagged-registered', { is_secret: 1 }),           // registered, flagged by its row
  row('clio_login_code', 'WITHHELD-2fa', { is_editable: 0 }),
  row('comms_archive_admins', 'WITHHELD-access', { is_editable: 0 }),
  row('fe-trustees', 'WITHHELD-retired'),
  row('hidden_var', 'WITHHELD-not-editable', { is_editable: 0 }),
  row('Quo_Api_Key ', 'WITHHELD-alias-secret'),                                  // folds onto quo_api_key
  row('FIRM_NAME', 'WITHHELD-alias-registered'),                                 // folds onto firm_name
];

describe('GET /api/readonly/settings', () => {
  test('serves exactly the non-secret rows; no withheld value anywhere in the response', async () => {
    mockRoRows = STORE;
    const r = await ask(['sql.ro', 'scratch', 'alert']);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.settings.map((s) => s.key)).toEqual(
      ['firm_name', 'cloud_tasks_enabled', 'alert_last_sweep_at', 'fe-lead_sources', 'intake_banner_text']);
    expect(r.body.count).toBe(5);
    expect(r.raw).not.toMatch(/WITHHELD/);
    expect(r.body.settings[0]).toEqual({ key: 'firm_name', value: 'Example Firm', updated_at: '2026-10-28T00:00:00.000Z',
      registered: true, kind: 'firm', home: 'firm' });
    expect(r.body.settings[4]).toMatchObject({ key: 'intake_banner_text', registered: false, kind: 'variable' });
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toMatch(/IF\(is_secret = 0, `value`, NULL\)/);
    expect(r.logs).toEqual([expect.objectContaining({
      api_key_id: 92, sql_text: 'GET /api/readonly/settings', status: 'success', row_count: 5 })]);
  });

  test('a key without sql.ro: 403 naming the scope, nothing read', async () => {
    mockRoRows = STORE;
    const r = await ask(['scratch', 'alert']);
    expect(r.status).toBe(403);
    expect(r.body.missingScope).toBe('sql.ro');
    expect(r.ran).toEqual([]);
  });
});

describe('aiReadableSetting over the whole registry', () => {
  test('a registered key is served iff its kind is not secret / access / retired and it is not clio_login_code', () => {
    for (const [key, e] of Object.entries(reg.SETTINGS)) {
      const expected = !['secret', 'access', 'retired'].includes(e.kind) && key !== 'clio_login_code';
      const out = aiReadableSetting(row(key, 'v'));
      expect([key, !!out]).toEqual([key, expected]);
    }
  });

  test('every registered secret stays withheld when its row is not flagged, in any spelling', () => {
    const secrets = Object.keys(reg.SETTINGS).filter((k) => reg.SETTINGS[k].kind === 'secret');
    expect(secrets.length).toBeGreaterThan(0);
    for (const k of secrets) {
      for (const spelling of [k, k.toUpperCase(), k + ' ']) {
        expect([spelling, aiReadableSetting(row(spelling, 'x'))]).toEqual([spelling, null]);
      }
    }
  });
});
