// tests/machineKeyScopes.test.js
//
/**
 * Machine-key scopes ENFORCED — access-control B2 (lib/capabilities
 * routeAllowed / can(), lib/auth.jwtOrApiKey, lib/auth.requireAuth,
 * lib/apiKeys.createKey, routes/admin.apiKeys.js, public/apikeys.html;
 * ref/ACCESS_CONTROL_DESIGN.md §5.2, §5.6 B2).
 *
 * WHAT IS LOCKED
 *   - routeAllowed semantics, as a table: route:/p reaches p and p/…, never a
 *     sibling (p-evil, px); case-insensitive; trailing slash and query ignored;
 *     dot segments (plain or %-encoded) and malformed escapes refused; NULL
 *     scopes = everything; a capability-only key reaches no route.
 *   - jwtOrApiKey on the REAL middleware: a scoped yck_ key off its routes →
 *     403 { error, path } + a forbidden_scope audit row under its label; on
 *     them → through. NULL scopes → through anywhere. The INTERNAL yci_ key →
 *     through anywhere, and its req.auth carries no scopes. HOT PATH: scopes
 *     ride the cached lookup — two requests, ONE api_keys SELECT.
 *   - requireAuth({ can, allowApiKey }): a scoped key passes only if its scopes
 *     name the capability (403 missingCapability + audit otherwise), with NO
 *     route scope needed; NULL → through (Q3 per key); internal → through.
 *     requireAuth({ roles, allowApiKey }) leaves the route check on.
 *   - Mints: createKey/POST /api/api-keys take route:/ + capability scopes,
 *     store them as JSON, refuse surface/unknown/empty with nothing inserted;
 *     omitted → NULL. The list returns scopes.
 *   - apikeys.html: the scopes box sends one scope per line; a malformed line
 *     stops the request; empty sends none; the list shows "all (unscoped)".
 *
 * Run: npx jest tests/machineKeyScopes.test.js
 */
'use strict';

process.env.JWT_SECRET = 'machine-key-scopes-b2-test-secret';
process.env.INTERNAL_API_KEY = 'yci_machine_scopes_b2_internal';
process.env.SU_RATE_LIMIT_API_KEYS = '10000';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

const { routeAllowed, can } = require('../lib/capabilities');
const apiKeys = require('../lib/apiKeys');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const requireAuth = require('../lib/auth.requireAuth');
const { mintElevationToken } = require('../lib/auth.superuser');

const flush = () => new Promise(r => setImmediate(r));

// ── routeAllowed: the semantics table ───────────────────────────────────────

describe('routeAllowed semantics', () => {
  const PJ = { scopes: ['route:/process-jobs'] };
  const TABLE = [
    [PJ, '/process-jobs', true],
    [PJ, '/process-jobs/', true],
    [PJ, '/process-jobs/run/7', true],
    [PJ, '/PROCESS-JOBS', true],
    [PJ, '/process-jobs?force=1', true],
    [PJ, '/process-jobs#x', true],
    [PJ, '/process-jobs-evil', false],
    [PJ, '/process-jobsx', false],
    [PJ, '/process', false],
    [PJ, '/api/process-jobs', false],
    [PJ, '/mailbox-ingest', false],
    [PJ, '/', false],
    [PJ, '', false],
    [PJ, 'process-jobs', false],
    [PJ, '/process-jobs/../api/x', false],
    [PJ, '/process-jobs/./x', false],
    [PJ, '/process-jobs/%2e%2e/api', false],
    [PJ, '/process-jobs/%2E%2E', false],
    [PJ, '/process-jobs/%zz', false],
    [{ scopes: ['route:/process-jobs/'] }, '/process-jobs', true],            // trailing slash on the scope
    [{ scopes: ['route:/process-jobs', 'route:/mailbox-ingest'] }, '/mailbox-ingest', true],
    [{ scopes: ['firm.settings'] }, '/api/app-settings', false],             // capability-only: no route
    [{ scopes: [] }, '/process-jobs', false],
    [{ scopes: null }, '/anything/at/all', true],                             // legacy
    [{}, '/anything', true],                                                  // no scopes key (internal)
    [{ scopes: 'route:/process-jobs' }, '/process-jobs', false],              // malformed: fail closed
    [null, '/process-jobs', false],
  ];
  test('the table', () => {
    const got = TABLE.map(([a, p]) => routeAllowed(a, p));
    expect(got).toEqual(TABLE.map(([, , want]) => want));
  });
});

// ── jwtOrApiKey: the route family ───────────────────────────────────────────

const KEYS = {
  pj: { raw: 'yck_' + 'p'.repeat(22), row: { id: 3, label: 'scheduler-process-jobs', revoked_at: null, scopes: ['route:/process-jobs'] } },
  mi: { raw: 'yck_' + 'm'.repeat(22), row: { id: 4, label: 'scheduler-mailbox', revoked_at: null, scopes: ['route:/mailbox-ingest'] } },
  cap: { raw: 'yck_' + 'c'.repeat(22), row: { id: 5, label: 'settings-bot', revoked_at: null, scopes: ['firm.settings'] } },
  legacy: { raw: 'yck_' + 'l'.repeat(22), row: { id: 2, label: 'Pabbly', revoked_at: null, scopes: null } },
};

function keyDb() {
  const calls = [];
  const byHash = Object.fromEntries(Object.values(KEYS).map(k => [apiKeys.hashKey(k.raw), k.row]));
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/FROM api_keys WHERE key_hash/.test(s)) { const r = byHash[params[0]]; return [r ? [{ ...r }] : []]; }
      if (/UPDATE api_keys SET last_used_at|jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      throw new Error('unscripted: ' + s);
    },
  };
}
const run = (mw, req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ via: 'res', status: this.statusCode, body: b }); return this; } };
  mw(req, res, () => resolve({ via: 'next' }));
});
const reqFor = (raw, url, db = keyDb()) => ({ headers: { 'x-api-key': raw }, db, originalUrl: url, method: 'POST', socket: {} });
const audits = (db) => db.calls.filter(c => /jwt_api_audit_log/.test(c.sql)).map(c => ({ type: c.params[7], user: c.params[8], status: c.params[9] }));

describe('jwtOrApiKey enforces route scopes', () => {
  beforeEach(() => apiKeys.invalidateCache());

  test('a scoped key reaches its route and below', async () => {
    for (const url of ['/process-jobs', '/process-jobs?x=1', '/process-jobs/sub']) {
      apiKeys.invalidateCache();
      const req = reqFor(KEYS.pj.raw, url);
      expect(await run(jwtOrApiKey, req)).toEqual({ via: 'next' });
      expect(req.auth).toMatchObject({ type: 'api_key', key_label: 'scheduler-process-jobs', scopes: ['route:/process-jobs'] });
    }
  });

  test('off its routes → 403 naming the path, audited forbidden_scope under its label', async () => {
    for (const url of ['/process-jobs-evil', '/mailbox-ingest', '/api/cases', '/process-jobs/../api/x']) {
      apiKeys.invalidateCache();
      const db = keyDb();
      const out = await run(jwtOrApiKey, reqFor(KEYS.pj.raw, url, db));
      expect(out).toEqual({ via: 'res', status: 403, body: { error: 'API key is not scoped for this route', path: url } });
      await flush();
      expect(audits(db)).toEqual([{ type: 'api_key', user: 'scheduler-process-jobs', status: 'forbidden_scope' }]);
    }
  });

  test('the two scheduler shapes do not cross', async () => {
    expect(await run(jwtOrApiKey, reqFor(KEYS.mi.raw, '/mailbox-ingest'))).toEqual({ via: 'next' });
    apiKeys.invalidateCache();
    expect((await run(jwtOrApiKey, reqFor(KEYS.mi.raw, '/process-jobs'))).status).toBe(403);
  });

  test('a capability-only key reaches no plain jwtOrApiKey route', async () => {
    expect((await run(jwtOrApiKey, reqFor(KEYS.cap.raw, '/api/app-settings'))).status).toBe(403);
  });

  test('NULL scopes (legacy) and the internal yci_ key pass anywhere; internal carries no scopes', async () => {
    for (const url of ['/api/cases', '/process-jobs-evil', '/whatever']) {
      apiKeys.invalidateCache();
      expect(await run(jwtOrApiKey, reqFor(KEYS.legacy.raw, url))).toEqual({ via: 'next' });
      const req = reqFor(process.env.INTERNAL_API_KEY, url);
      expect(await run(jwtOrApiKey, req)).toEqual({ via: 'next' });
      expect(req.auth).toEqual({ type: 'api_key', key_label: 'internal' });
    }
  });

  test('HOT PATH: scopes ride the cached lookup — two requests, one api_keys SELECT, no other read', async () => {
    const db = keyDb();
    expect(await run(jwtOrApiKey, reqFor(KEYS.pj.raw, '/process-jobs', db))).toEqual({ via: 'next' });
    expect(await run(jwtOrApiKey, reqFor(KEYS.pj.raw, '/process-jobs', db))).toEqual({ via: 'next' });
    await flush();
    const reads = db.calls.filter(c => /^SELECT/.test(c.sql));
    expect(reads).toHaveLength(1);
    expect(reads[0].sql).toMatch(/FROM api_keys WHERE key_hash/);
  });
});

// ── requireAuth: the capability family ──────────────────────────────────────

describe('requireAuth({ can, allowApiKey }) judges a scoped key by capability', () => {
  const mw = requireAuth({ audience: 'staff', can: 'firm.settings', allowApiKey: true });
  beforeEach(() => apiKeys.invalidateCache());

  test('scoped WITH the capability → through, no route scope needed', async () => {
    expect(await run(mw, reqFor(KEYS.cap.raw, '/api/app-settings/fe-x'))).toEqual({ via: 'next' });
  });

  test('scoped WITHOUT it → 403 missingCapability, audited forbidden_scope', async () => {
    const db = keyDb();
    const out = await run(mw, reqFor(KEYS.pj.raw, '/api/app-settings/fe-x', db));
    expect(out).toEqual({ via: 'res', status: 403, body: { error: 'Forbidden', missingCapability: 'firm.settings' } });
    await flush();
    expect(audits(db).map(a => a.status)).toContain('forbidden_scope');
  });

  test('a route scope covering the path does NOT stand in for the capability', async () => {
    const both = { raw: 'yck_' + 'r'.repeat(22) };
    const db = keyDb();
    const orig = db.query;
    db.query = async (sql, params) => (/FROM api_keys WHERE key_hash/.test(String(sql)) && params[0] === apiKeys.hashKey(both.raw)
      ? [[{ id: 9, label: 'route-only', revoked_at: null, scopes: ['route:/api/app-settings'] }]] : orig(sql, params));
    expect((await run(mw, reqFor(both.raw, '/api/app-settings/fe-x', db))).status).toBe(403);
  });

  test('NULL scopes (Q3 per key) and the internal key → through', async () => {
    expect(await run(mw, reqFor(KEYS.legacy.raw, '/api/app-settings/fe-x'))).toEqual({ via: 'next' });
    expect(await run(mw, reqFor(process.env.INTERNAL_API_KEY, '/api/app-settings/fe-x'))).toEqual({ via: 'next' });
  });

  test('a ROLES gate with allowApiKey keeps the route check', async () => {
    const rolesMw = requireAuth({ audience: 'staff', roles: ['admin'], allowApiKey: true });
    expect((await run(rolesMw, reqFor(KEYS.pj.raw, '/api/thing'))).status).toBe(403);
    apiKeys.invalidateCache();
    expect(await run(rolesMw, reqFor(KEYS.pj.raw, '/process-jobs'))).toEqual({ via: 'next' });
  });

  test('can() on api_key auths', () => {
    expect(can({ type: 'api_key', key_label: 'internal' }, 'tools.author')).toBe(true);
    expect(can({ type: 'api_key', scopes: null }, 'firm.settings')).toBe(true);
    expect(can({ type: 'api_key', scopes: ['firm.settings'] }, 'firm.settings')).toBe(true);
    expect(can({ type: 'api_key', scopes: ['firm.settings'] }, 'automations.manage')).toBe(false);
    expect(can({ type: 'api_key', scopes: ['route:/process-jobs'] }, 'firm.settings')).toBe(false);
    expect(can({ type: 'api_key', scopes: 'firm.settings' }, 'firm.settings')).toBe(false);
  });
});

// ── mints ───────────────────────────────────────────────────────────────────

describe('machine key mints', () => {
  function mintDb() {
    const calls = [];
    return { calls, query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/^INSERT INTO api_keys/.test(s)) return [{ insertId: 30 }];
      if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
      if (/FROM api_keys ORDER BY/.test(s)) return [[{ id: 30, label: 'sched', key_prefix: 'yck_x', scopes: ['route:/process-jobs'] }, { id: 2, label: 'Pabbly', key_prefix: 'yck_y', scopes: null }]];
      if (/FROM app_settings WHERE `key` IN/.test(s)) return [[]];
      throw new Error('unscripted: ' + s);
    } };
  }
  const insertOf = (db) => db.calls.find(c => /^INSERT INTO api_keys/.test(c.sql));

  test('createKey: route + capability scopes stored as JSON; omitted → NULL', async () => {
    let db = mintDb();
    const out = await apiKeys.createKey(db, 'sched', 6, ['route:/process-jobs', 'firm.settings', 'route:/process-jobs']);
    expect(out.scopes).toEqual(['route:/process-jobs', 'firm.settings']);
    expect(insertOf(db).sql).toMatch(/created_by, scopes\)/);
    expect(JSON.parse(insertOf(db).params[4])).toEqual(['route:/process-jobs', 'firm.settings']);
    db = mintDb();
    expect((await apiKeys.createKey(db, 'legacy', 6)).scopes).toBeNull();
    expect(insertOf(db).params[4]).toBeNull();
  });

  test('createKey refuses surface / unknown / empty / non-array scopes, with nothing inserted', async () => {
    for (const bad of [['sql.ro'], ['route:/process-jobs', 'scratch'], ['firm.setting'], ['route:/'], [], 'route:/process-jobs']) {
      const db = mintDb();
      await expect(apiKeys.createKey(db, 'x', 6, bad)).rejects.toMatchObject({ status: 400 });
      expect(insertOf(db)).toBeUndefined();
    }
  });

  function suCall(method, urlPath, body) {
    const db = mintDb();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = db; next(); });
    app.use(require('../routes/admin.apiKeys'));
    const token = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET);
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const rq = http.request({ port: server.address().port, path: urlPath, method,
          headers: Object.assign({ authorization: 'Bearer ' + token, 'x-su-elevation': mintElevationToken(6) }, payload ? { 'content-type': 'application/json' } : {}) }, (res) => {
          let d = ''; res.on('data', c => (d += c)); res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || '{}'), db }); });
        });
        rq.on('error', (e) => { server.close(); reject(e); });
        if (payload) rq.write(payload);
        rq.end();
      });
    });
  }

  test('POST /api/api-keys: scopes pass through and come back; a bad scope is a 400 with nothing inserted', async () => {
    const ok = await suCall('POST', '/api/api-keys', { label: 'sched', scopes: ['route:/process-jobs'] });
    expect(ok.status).toBe(200);
    expect(ok.body.scopes).toEqual(['route:/process-jobs']);
    expect(ok.body.key).toMatch(/^yck_[0-9A-Za-z]{22}$/);
    const bad = await suCall('POST', '/api/api-keys', { label: 'x', scopes: ['sql.ro'] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/session-key scope/);
    expect(insertOf(bad.db)).toBeUndefined();
  });

  test('GET /api/api-keys lists scopes (NULL = unscoped)', async () => {
    const r = await suCall('GET', '/api/api-keys');
    expect(r.status).toBe(200);
    expect(r.body.keys.map(k => k.scopes)).toEqual([['route:/process-jobs'], null]);
    expect(r.db.calls.find(c => /FROM api_keys ORDER BY/.test(c.sql)).sql).toMatch(/revoked_at, scopes/);
  });
});

// ── the pane ────────────────────────────────────────────────────────────────

describe('apikeys.html scopes box', () => {
  function boot(keys = []) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'apikeys.html'), 'utf8');
    const sent = [];
    const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(w) {
      w.alert = (m) => sent.push({ alert: m });
      w.apiSend = async (url, method, body) => {
        sent.push({ url, method, body });
        if (url === '/api/api-keys' && method === 'GET') return { status: 'success', keys, internal: { rotated: true, has_previous: false } };
        if (url === '/api/api-keys' && method === 'POST') return { status: 'success', key: 'yck_x', id: 31, label: body.label, scopes: body.scopes || null };
        return { status: 'success', log: [] };
      };
    } });
    return { w: dom.window, sent };
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  test('one scope per line is sent; the receipt shows them', async () => {
    const { w, sent } = boot();
    await tick(); await tick();
    w.document.getElementById('newLabel').value = 'scheduler';
    w.document.getElementById('newScopes').value = 'route:/process-jobs\n\n  firm.settings  \n';
    await w.createKey();
    expect(sent.find(s => s.method === 'POST').body).toEqual({ label: 'scheduler', scopes: ['route:/process-jobs', 'firm.settings'] });
    expect(w.document.getElementById('newKeyArea').textContent).toMatch(/Scopes: route:\/process-jobs, firm\.settings/);
  });

  test('a malformed line stops the request', async () => {
    const { w, sent } = boot();
    await tick(); await tick();
    w.document.getElementById('newLabel').value = 'x';
    for (const line of ['/process-jobs', 'route:/a/../b', 'route://x', 'Firm.Settings', 'route:']) {
      w.document.getElementById('newScopes').value = line;
      await w.createKey();
    }
    expect(sent.some(s => s.method === 'POST')).toBe(false);
    expect(sent.filter(s => s.alert && /Not a scope/.test(s.alert))).toHaveLength(5);
  });

  test('empty box → no scopes key in the request (unscoped)', async () => {
    const { w, sent } = boot();
    await tick(); await tick();
    w.document.getElementById('newLabel').value = 'pabbly';
    await w.createKey();
    expect(sent.find(s => s.method === 'POST').body).toEqual({ label: 'pabbly' });
  });

  test('the list shows scopes, "all (unscoped)" for NULL', async () => {
    const { w } = boot([{ id: 30, label: 'sched', key_prefix: 'yck_a', scopes: ['route:/process-jobs'] }, { id: 2, label: 'Pabbly', key_prefix: 'yck_b', scopes: null }]);
    await tick(); await tick();
    const cells = [...w.document.querySelectorAll('.scope-cell')].map(td => td.textContent.trim());
    expect(cells).toEqual(['route:/process-jobs', 'all (unscoped)']);
  });
});
