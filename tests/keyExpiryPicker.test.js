// tests/keyExpiryPicker.test.js
//
/**
 * Machine-key UX — access-control B6: optional expiry on api_keys
 * (lib/apiKeys machineKeyExpiry / lookup / createKey / listKeys,
 * routes/admin.apiKeys.js, scripts/accessB6KeyExpiry.js) and the scope picker
 * (lib/routeFamilies.js, public/apikeys.html).
 *
 * WHAT IS LOCKED
 *   - machineKeyExpiry: absent/null/'' → never; a positive whole number of
 *     minutes (number or digit string) up to 5 years → that instant; anything
 *     else → a 400, never a silent "never".
 *   - lookup: NULL expiry behaves exactly as before B6 (same record, one
 *     SELECT, cached); future → live; past → null; revoked → null whatever the
 *     expiry; the CACHE re-checks the row's expiry on every hit — a key that
 *     expires inside the 60s TTL is refused at once, without a SELECT and
 *     without a last_used_at bump; a NULL-expiry row is never refused by time.
 *   - Through the REAL jwtOrApiKey: an expired key and a revoked key produce
 *     the identical 401 and the identical audit write (fall-through to JWT).
 *   - The mint route: ttlMinutes stored as the expiry, returned (ISO) and
 *     audited; omitted → NULL; junk → 400 with nothing inserted. The GET
 *     serves scope_vocabulary: every CAPABILITY (name + desc) and the route
 *     families of the app it is mounted in.
 *   - routeFamilies: '/api/<seg>' or '/<seg>', params/wildcards/array/regex
 *     paths handled, bare '/api' never offered, nested routers walked, an
 *     Express-5-shaped app read, an unreadable one → [].
 *   - The pane (jsdom, its own script): capability boxes + family options come
 *     from the GET; families and validated narrower routes become chips
 *     (de-duplicated, removable); expiry days → ttlMinutes; blank → none;
 *     junk days → no request; the list shows Expires ("—" for never) and an
 *     expired badge (revoked wins); the form resets after a create.
 *   - The migration's statement (always-on pins; the engine run is
 *     tests/keyExpiry.mysql.test.js).
 *
 * Run: npx jest tests/keyExpiryPicker.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'b6-key-expiry-test-secret';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

const apiKeys = require('../lib/apiKeys');
const { CAPABILITIES } = require('../lib/capabilities');
const { routeFamilies, familyOf } = require('../lib/routeFamilies');

const ROOT = path.join(__dirname, '..');
const flush = () => new Promise(r => setTimeout(r, 0));
const RAW = 'yck_' + 'B6exp1ry'.repeat(3);
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
// machineKeyExpiry
// ─────────────────────────────────────────────────────────────

describe('machineKeyExpiry — the mint input', () => {
  const { machineKeyExpiry, MAX_TTL_MINUTES } = apiKeys;

  test.each([undefined, null, ''])('%p → null (never expires)', (v) => {
    expect(machineKeyExpiry(v, T0)).toBeNull();
  });

  test.each([
    [1, T0 + 60_000],
    [1440, T0 + 86_400_000],
    ['90', T0 + 90 * 60_000],
    [' 30 ', T0 + 30 * 60_000],
  ])('%p minutes → that instant', (v, want) => {
    expect(machineKeyExpiry(v, T0).getTime()).toBe(want);
  });

  test('the 5-year ceiling is inclusive', () => {
    expect(MAX_TTL_MINUTES).toBe(5 * 365 * 24 * 60);
    expect(machineKeyExpiry(MAX_TTL_MINUTES, T0).getTime()).toBe(T0 + MAX_TTL_MINUTES * 60_000);
  });

  test.each([0, -5, 1.5, 'abc', '1e3', '-5', '1.5', true, {}, [60], NaN, Infinity, 5 * 365 * 24 * 60 + 1])('%p → 400', (v) => {
    let err;
    try { machineKeyExpiry(v, T0); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/ttlMinutes must be a whole number of minutes from 1 to 2628000/);
  });
});

// ─────────────────────────────────────────────────────────────
// lookup — expiry + the cache re-check
// ─────────────────────────────────────────────────────────────

function keyDb(row) {
  const calls = [];
  return {
    calls,
    selects: () => calls.filter(c => /FROM api_keys WHERE key_hash/.test(c.sql)).length,
    touches: () => calls.filter(c => /UPDATE api_keys SET last_used_at/.test(c.sql)).length,
    query: async (sql, params) => {
      const s = String(sql);
      calls.push({ sql: s, params });
      if (/FROM api_keys WHERE key_hash/.test(s)) {
        expect(s).toMatch(/SELECT id, label, revoked_at, expires_at, scopes FROM api_keys/);
        return [[row].filter(Boolean)];
      }
      if (/UPDATE api_keys SET last_used_at/.test(s) || /jwt_api_audit_log/.test(s)) return [{}];
      throw new Error('unscripted: ' + s);
    },
  };
}
const at = (ms) => jest.spyOn(Date, 'now').mockReturnValue(ms);

describe('lookup — expiry', () => {
  beforeEach(() => { apiKeys.invalidateCache(); apiKeys._touchedForTests.clear(); });

  test('NULL expiry: exactly as before B6 — same record, one SELECT, cached, never refused by time', async () => {
    at(T0);
    const db = keyDb({ id: 3, label: 'Pabbly', revoked_at: null, expires_at: null, scopes: null });
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 3, label: 'Pabbly', scopes: null });
    at(T0 + 59_000);
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 3, label: 'Pabbly', scopes: null });
    expect(db.selects()).toBe(1);
    at(T0 + 10 * 365 * 86_400_000);   // years later, after the TTL: re-read, still live
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 3, label: 'Pabbly', scopes: null });
  });

  test('a future expiry is live; a past one is null', async () => {
    at(T0);
    expect(await apiKeys.lookup(keyDb({ id: 4, label: 'k', revoked_at: null, expires_at: new Date(T0 + 1000), scopes: ['route:/x'] }), RAW))
      .toEqual({ id: 4, label: 'k', scopes: ['route:/x'] });
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(keyDb({ id: 4, label: 'k', revoked_at: null, expires_at: new Date(T0 - 1), scopes: null }), RAW)).toBeNull();
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(keyDb({ id: 4, label: 'k', revoked_at: null, expires_at: new Date(T0), scopes: null }), RAW)).toBeNull();   // the instant itself = expired
  });

  test('revoked is refused whatever the expiry (revoked beats a live expiry)', async () => {
    at(T0);
    for (const expires_at of [null, new Date(T0 + 86_400_000), new Date(T0 - 1)]) {
      apiKeys.invalidateCache();
      const db = keyDb({ id: 5, label: 'k', revoked_at: new Date(T0 - 5000), expires_at, scopes: null });
      expect(await apiKeys.lookup(db, RAW)).toBeNull();
      expect(db.touches()).toBe(0);
    }
  });

  test('the cache re-checks expiry on every hit: refused the moment it passes, no SELECT, no touch', async () => {
    at(T0);
    const db = keyDb({ id: 6, label: 'k', revoked_at: null, expires_at: new Date(T0 + 30_000), scopes: null });
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 6, label: 'k', scopes: null });
    expect(db.touches()).toBe(1);
    at(T0 + 29_999);
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 6, label: 'k', scopes: null });
    apiKeys._touchedForTests.clear();
    at(T0 + 30_000);                                  // inside the 60s TTL, at the expiry
    expect(await apiKeys.lookup(db, RAW)).toBeNull();
    expect(db.selects()).toBe(1);                     // served from the cached row
    expect(db.touches()).toBe(1);                     // no bump for a refused key
  });

  test('a DATETIME string from the driver is read the same as a Date', async () => {
    at(T0);
    expect(await apiKeys.lookup(keyDb({ id: 7, label: 'k', revoked_at: null, expires_at: new Date(T0 - 1).toISOString(), scopes: null }), RAW)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// through the real jwtOrApiKey: expired ≡ revoked
// ─────────────────────────────────────────────────────────────

describe('jwtOrApiKey — an expired key is refused exactly like a revoked one', () => {
  const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
  const run = (req) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ via: 'res', status: this.statusCode, body: b }); return this; } };
    jwtOrApiKey(req, res, () => resolve({ via: 'next' }));
  });

  async function attempt(row) {
    apiKeys.invalidateCache();
    const db = keyDb(row);
    const req = { headers: { 'x-api-key': RAW, 'user-agent': 'jest' }, db, originalUrl: '/process-jobs', method: 'POST', socket: { remoteAddress: '10.0.0.9' } };
    const out = await run(req);
    await flush();
    const audit = db.calls.filter(c => /jwt_api_audit_log/.test(c.sql)).map(c => c.params);
    return { out, audit, auth: req.auth };
  }

  test('same 401, same audit params; a live key passes', async () => {
    at(T0);
    const revoked = await attempt({ id: 8, label: 'sched', revoked_at: new Date(T0 - 1000), expires_at: null, scopes: null });
    const expired = await attempt({ id: 8, label: 'sched', revoked_at: null, expires_at: new Date(T0 - 1000), scopes: null });
    expect(revoked.out).toEqual({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
    expect(expired.out).toEqual(revoked.out);
    expect(expired.audit).toEqual(revoked.audit);
    expect(expired.audit).toHaveLength(1);
    expect(expired.audit[0].slice(7, 10)).toEqual(['none', null, 'unauthorized']);   // auth_type, username, status
    expect(expired.auth).toBeUndefined();
    const live = await attempt({ id: 8, label: 'sched', revoked_at: null, expires_at: new Date(T0 + 60_000), scopes: null });
    expect(live.out).toEqual({ via: 'next' });
    expect(live.auth).toMatchObject({ type: 'api_key', key_id: 8, key_label: 'sched' });
  });
});

// ─────────────────────────────────────────────────────────────
// the mint + list routes
// ─────────────────────────────────────────────────────────────

function listen(app, method, urlPath, body) {
  const token = jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  const { mintElevationToken } = require('../lib/auth.superuser');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign({ authorization: 'Bearer ' + token, 'x-su-elevation': mintElevationToken(6) },
          payload ? { 'content-type': 'application/json' } : {}),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('routes/admin.apiKeys — expiry on the mint; the vocabulary on the GET', () => {
  const router = require('../routes/admin.apiKeys');

  function appWith(extraRouters = []) {
    const calls = [];
    const db = {
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
        if (/^INSERT INTO api_keys/.test(s)) return [{ insertId: 41 }];
        if (/FROM api_keys ORDER BY/.test(s)) {
          return [[{ id: 41, label: 'vendor', key_prefix: 'yck_x', scopes: null, revoked_at: null, expires_at: new Date(T0 + 86_400_000) },
                   { id: 1, label: 'Pabbly', key_prefix: 'yck_y', scopes: null, revoked_at: null, expires_at: null }]];
        }
        if (/FROM app_settings/.test(s)) return [[]];
        throw new Error('unscripted: ' + s);
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _r, next) => { req.db = db; next(); });
    app.use(router);
    for (const r of extraRouters) app.use(r);
    return { app, calls };
  }
  const ins = (calls) => calls.find(c => /^INSERT INTO api_keys/.test(c.sql));
  const hoursAhead = (d) => (new Date(d).getTime() - Date.now()) / 3600e3;

  test('ttlMinutes → stored expiry, returned as ISO, audited', async () => {
    const { app, calls } = appWith();
    const r = await listen(app, 'POST', '/api/api-keys', { label: 'vendor', ttlMinutes: 1440 });
    expect(r.status).toBe(200);
    expect(hoursAhead(r.body.expires_at)).toBeCloseTo(24, 1);
    expect(ins(calls).sql).toMatch(/\(label, key_hash, key_prefix, created_by, scopes, expires_at\)/);
    expect(ins(calls).params[5]).toBeInstanceOf(Date);
    expect(hoursAhead(ins(calls).params[5])).toBeCloseTo(24, 1);
    await flush();
    const audit = calls.find(c => /admin_audit_log/.test(c.sql) && c.params.some(p => String(p).includes('"expires_at"')));
    expect(audit.params.find(p => String(p).includes('"expires_at"'))).toContain(r.body.expires_at);
  });

  test('omitted → NULL stored, expires_at null in the reply (never)', async () => {
    const { app, calls } = appWith();
    const r = await listen(app, 'POST', '/api/api-keys', { label: 'infra', scopes: ['route:/process-jobs'] });
    expect([r.status, r.body.expires_at]).toEqual([200, null]);
    expect(ins(calls).params[5]).toBeNull();
  });

  test.each([0, -1, 'soon', 1.5, 99999999])('ttlMinutes %p → 400, nothing inserted', async (ttlMinutes) => {
    const { app, calls } = appWith();
    const r = await listen(app, 'POST', '/api/api-keys', { label: 'x', ttlMinutes });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/ttlMinutes must be a whole number/);
    expect(ins(calls)).toBeUndefined();
  });

  test('a bad scope and a bad expiry together: still a 400 before any write', async () => {
    const { app, calls } = appWith();
    const r = await listen(app, 'POST', '/api/api-keys', { label: 'x', scopes: ['sql.ro'], ttlMinutes: 'x' });
    expect(r.status).toBe(400);
    expect(ins(calls)).toBeUndefined();
  });

  test('the GET lists expires_at and serves the vocabulary: every capability + this app\'s route families', async () => {
    const extra = express.Router();
    extra.post('/process-jobs', (q, s) => s.end());
    extra.post('/mailbox-ingest/:id', (q, s) => s.end());
    const { app, calls } = appWith([extra]);
    const r = await listen(app, 'GET', '/api/api-keys');
    expect(r.status).toBe(200);
    expect(calls.find(c => /FROM api_keys ORDER BY/.test(c.sql)).sql).toMatch(/revoked_at, expires_at, scopes/);
    expect(r.body.keys.map(k => k.expires_at === null)).toEqual([false, true]);
    expect(r.body.scope_vocabulary.capabilities).toEqual(Object.entries(CAPABILITIES).map(([name, v]) => ({ name, desc: v.desc })));
    expect(r.body.scope_vocabulary.route_families).toEqual(['/api/api-keys', '/mailbox-ingest', '/process-jobs']);
  });
});

// ─────────────────────────────────────────────────────────────
// routeFamilies
// ─────────────────────────────────────────────────────────────

describe('lib/routeFamilies', () => {
  test.each([
    ['/process-jobs', '/process-jobs'],
    ['/process-jobs/run/:id', '/process-jobs'],
    ['/api/cases/:id/notes', '/api/cases'],
    ['/api/cases', '/api/cases'],
    ['/api', null],
    ['/api/:id', null],
    ['/:slug', null],
    ['/*', null],
    ['/', null],
    [/^\/re/, null],
    [undefined, null],
  ])('familyOf(%p) = %p', (p, want) => {
    expect(familyOf(p)).toBe(want);
  });

  test('walks nested routers, array paths; drops what is not a valid route scope; sorted + unique', () => {
    const app = express();
    const a = express.Router();
    a.get('/api/cases/:id', () => {});
    a.post('/api/cases', () => {});
    a.get(['/p', '/q/x'], () => {});
    a.get('/api', () => {});
    a.get('/we!rd', () => {});
    const inner = express.Router();
    inner.get('/hooks/:slug', () => {});
    a.use(inner);
    app.use(a);
    expect(routeFamilies(app)).toEqual(['/api/cases', '/hooks', '/p', '/q']);
  });

  test('an Express-5-shaped app (app.router) is read; an unreadable one → []', () => {
    expect(routeFamilies({ router: { stack: [{ route: { path: '/process-jobs' } }] } })).toEqual(['/process-jobs']);
    expect(routeFamilies({})).toEqual([]);
    expect(routeFamilies(null)).toEqual([]);
    expect(routeFamilies({ _router: { get stack() { throw new Error('boom'); } } })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// the pane
// ─────────────────────────────────────────────────────────────

describe('apikeys.html — scope picker + expiry', () => {
  const VOCAB = {
    capabilities: Object.entries(CAPABILITIES).map(([name, v]) => ({ name, desc: v.desc })),
    route_families: ['/api/cases', '/mailbox-ingest', '/process-jobs'],
  };
  async function boot(keys = []) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'apikeys.html'), 'utf8');
    const sent = [];
    const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(w) {
      w.alert = (m) => sent.push({ alert: m });
      w.apiSend = async (url, method, body) => {
        sent.push({ url, method, body });
        if (url === '/api/api-keys' && method === 'GET') return { status: 'success', keys, internal: { rotated: true }, scope_vocabulary: VOCAB };
        if (url === '/api/api-keys' && method === 'POST') {
          return { status: 'success', key: 'yck_x', id: 41, label: body.label, scopes: body.scopes || null,
            expires_at: body.ttlMinutes ? new Date(Date.now() + body.ttlMinutes * 60_000).toISOString() : null };
        }
        return { status: 'success', log: [] };
      };
    } });
    await flush(); await flush();
    const w = dom.window, d = w.document;
    return { w, d, sent, posts: () => sent.filter(s => s.method === 'POST') };
  }
  const chips = (d) => [...d.querySelectorAll('#routeChips .chip')].map(c => c.firstChild.textContent);

  test('capability boxes and family options come from the GET (no copy in the page)', async () => {
    const { d } = await boot();
    expect([...d.querySelectorAll('.cap-box')].map(b => b.value)).toEqual(Object.keys(CAPABILITIES));
    expect([...d.querySelectorAll('.cap-box')].every(b => !b.checked)).toBe(true);
    expect([...d.querySelectorAll('#routeFamily option')].map(o => o.value)).toEqual(['', ...VOCAB.route_families]);
    expect(d.getElementById('newScopes')).toBeNull();   // the B2 textarea is gone
  });

  test('families and narrower routes become chips — de-duplicated, removable, sent in B2 wire order', async () => {
    const { w, d, posts } = await boot();
    d.getElementById('routeFamily').value = '/process-jobs';
    w.addRouteFamily();
    d.getElementById('routeFamily').value = '/process-jobs';
    w.addRouteFamily();                                         // duplicate ignored
    expect(d.getElementById('routeFamily').value).toBe('');     // select resets
    d.getElementById('routeCustom').value = ' route:/api/cases/import ';
    w.addRouteCustom();                                         // a pasted route: prefix is accepted
    expect(d.getElementById('routeCustom').value).toBe('');
    d.getElementById('routeFamily').value = '/mailbox-ingest';
    w.addRouteFamily();
    expect(chips(d)).toEqual(['route:/process-jobs', 'route:/api/cases/import', 'route:/mailbox-ingest']);
    w.removeRoute(2);
    expect(chips(d)).toEqual(['route:/process-jobs', 'route:/api/cases/import']);
    d.querySelector('.cap-box[value="automations.manage"]').checked = true;
    d.getElementById('newLabel').value = 'sched';
    await w.createKey();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ label: 'sched', scopes: ['route:/process-jobs', 'route:/api/cases/import', 'automations.manage'] });
  });

  test('expiry: days → ttlMinutes; blank → no ttlMinutes; junk → refused before any request', async () => {
    const { w, d, sent, posts } = await boot();
    d.getElementById('newLabel').value = 'vendor';
    for (const bad of ['0', '-3', '1.5']) {
      d.getElementById('newExpiryDays').value = bad;
      await w.createKey();
    }
    expect(posts()).toEqual([]);
    expect(sent.filter(s => s.alert && /whole number of days/.test(s.alert))).toHaveLength(3);
    d.getElementById('newExpiryDays').value = '90';
    await w.createKey();
    expect(posts()[0].body).toEqual({ label: 'vendor', ttlMinutes: 90 * 1440 });
    expect(d.getElementById('newKeyArea').textContent).toMatch(/Expires: (?!never)/);
    d.getElementById('newLabel').value = 'infra';
    await w.createKey();
    expect(posts()[1].body).toEqual({ label: 'infra' });
    expect(d.getElementById('newKeyArea').textContent).toMatch(/Expires: never/);
  });

  test('the form resets after a create: chips, boxes, expiry, label', async () => {
    const { w, d } = await boot();
    d.getElementById('newLabel').value = 'x';
    d.getElementById('newExpiryDays').value = '7';
    d.getElementById('routeFamily').value = '/process-jobs';
    w.addRouteFamily();
    d.querySelector('.cap-box').checked = true;
    await w.createKey();
    expect([d.getElementById('newLabel').value, d.getElementById('newExpiryDays').value]).toEqual(['', '']);
    expect(chips(d)).toEqual([]);
    expect([...d.querySelectorAll('.cap-box')].some(b => b.checked)).toBe(false);
  });

  test('the list: Expires column ("—" = never), an expired badge, revoked beats expired', async () => {
    const past = new Date(Date.now() - 3600e3).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { d } = await boot([
      { id: 4, label: 'live-dated', key_prefix: 'yck_a', scopes: null, revoked_at: null, expires_at: future },
      { id: 3, label: 'lapsed', key_prefix: 'yck_b', scopes: null, revoked_at: null, expires_at: past },
      { id: 2, label: 'gone', key_prefix: 'yck_c', scopes: null, revoked_at: past, expires_at: past },
      { id: 1, label: 'Pabbly', key_prefix: 'yck_d', scopes: null, revoked_at: null, expires_at: null },
    ]);
    expect([...d.querySelectorAll('thead th')].map(t => t.textContent)).toContain('Expires');
    const rows = [...d.querySelectorAll('#keysTbody tr')];
    expect(rows.map(r => r.querySelector('.badge').textContent)).toEqual(['active', 'expired', 'revoked', 'active']);
    expect(rows.map(r => r.querySelector('.expires-cell').textContent)).toEqual([
      new Date(future).toLocaleString(), new Date(past).toLocaleString(), new Date(past).toLocaleString(), '—',
    ]);
    expect(rows.map(r => r.className)).toEqual(['', 'revoked', 'revoked', '']);   // dimmed once not usable
    expect(rows[1].textContent).toMatch(/revoke/);                                  // an expired key can still be revoked
  });
});

// ─────────────────────────────────────────────────────────────
// the migration's statement (always-on)
// ─────────────────────────────────────────────────────────────

describe('scripts/accessB6KeyExpiry — the statement', () => {
  const script = require('../scripts/accessB6KeyExpiry');
  test('datetime NULL, the dispatched comment, after revoked_at, INSTANT', () => {
    expect(script.ALTER_SQL).toBe(
      "ALTER TABLE `api_keys` ADD COLUMN `expires_at` datetime NULL DEFAULT NULL " +
      "COMMENT 'NULL = non-expiring (legacy and infrastructure keys); checked at lookup' AFTER `revoked_at`, ALGORITHM=INSTANT");
  });
});
