// tests/keyRenewalRequests.mysql.test.js
//
/**
 * Session-key renewal requests on REAL MySQL — key-renew-req
 * (routes/api.keyRenewalRequests.js, lib/auth.readonly
 * readonlyApiKeyAuthAllowExpired, routes/api.readonlyKeys.js renewKey,
 * scripts/keyRenewalRequestsMigrate.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3391/krr_test npx jest tests/keyRenewalRequests.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * key_renewal_requests, readonly_api_keys, admin_audit_log, jwt_api_audit_log
 * and users. key_renewal_requests is built by the MIGRATION SCRIPT itself
 * (run(conn, { apply: true })), so the script, its SQL file and this code are
 * proved against each other.
 *
 * Mocked (not under test): emailService.sendEmail (captured / made to fail)
 * and settingsService.getSetting (the sender address).
 *
 * WHAT IS LOCKED
 *   An expired key asks → one pending row, one email to the CREATOR naming the
 *   key, its expiry, the reason, the TTL asked + the max, and the pane link;
 *   the key's usage counter is untouched. A repeat → duplicate, no email.
 *   Concurrent asks → one row, one email (the UNIQUE pending_key). SU list →
 *   the row + its caps. Approve → the ordinary renew (TTL honoured, key
 *   authenticates again, audited `renewed` via_request); a second approve and
 *   a concurrent double approve renew ONCE. Deny → 429 for an hour, then
 *   allowed. Validation: reason 10–200, TTL over the cap (ordinary 3d,
 *   sensitive 24h) → 400 naming the caps, no row. A child → 409; revoked /
 *   unknown → 401. A key revoked while pending → approve 409, deny works.
 *   A failed email → 502, row pending with email_error; the repeat retries
 *   the send. A creator with no email → 502 naming it. Non-SU → 403.
 */
'use strict';

process.env.JWT_SECRET = 'key-renewal-requests-mysql-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';

const mockSent = [];
let mockSendFails = null;
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(async (db, opts) => {
    if (mockSendFails) throw new Error(mockSendFails);
    mockSent.push(opts);
    return { ok: true };
  }),
}));
jest.mock('../services/settingsService', () => ({
  ...jest.requireActual('../services/settingsService'),
  getSetting: jest.fn(async (db, k) => (k === 'alert_from_email' ? 'alerts@example.test' : null)),
}));

const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const { readonlyApiKeyAuth, hashKey } = require('../lib/auth.readonly');
const { mintElevationToken } = require('../lib/auth.superuser');
const migrate = require('../scripts/keyRenewalRequestsMigrate');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('key renewal requests on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const MIN = 60e3;

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['key_renewal_requests', 'readonly_api_keys', 'admin_audit_log', 'jwt_api_audit_log', 'users']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    await q(`CREATE TABLE readonly_api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(16) NOT NULL, label varchar(255) NOT NULL,
      created_by int NOT NULL, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at datetime NOT NULL, revoked_at datetime DEFAULT NULL, last_used_at datetime DEFAULT NULL,
      use_count int NOT NULL DEFAULT '0', scopes json DEFAULT NULL, parent_key_id int DEFAULT NULL,
      KEY idx_rok_parent (parent_key_id, created_at),
      CONSTRAINT fk_rok_parent FOREIGN KEY (parent_key_id) REFERENCES readonly_api_keys (id) ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE admin_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, tool varchar(32) NOT NULL, user_id int DEFAULT NULL,
      username varchar(255) DEFAULT NULL, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      status varchar(40) NOT NULL, error_message text, duration_ms int DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, details json DEFAULT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE jwt_api_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      headers json DEFAULT NULL, query_params json DEFAULT NULL, body json DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, auth_type varchar(20) DEFAULT NULL,
      username varchar(255) DEFAULT NULL, auth_status varchar(20) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q('CREATE TABLE users (user int NOT NULL PRIMARY KEY, username varchar(255), email varchar(50) DEFAULT NULL)');
    await q("INSERT INTO users VALUES (6, 'IT', 'it@example.test'), (1, 'SS', NULL)");

    const conn = await pool.getConnection();
    try {
      const r = await migrate.run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error('migration failed: ' + r.line);
    } finally { conn.release(); }

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.keyRenewalRequests'));
    app.use(require('../routes/api.readonlyKeys'));
    app.get('/probe', readonlyApiKeyAuth, (req, res) => res.json({ ok: true }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });
  beforeEach(() => { mockSent.length = 0; mockSendFails = null; });

  const suToken = (roles = ['su']) => jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles, aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, path, { key, su, body, roles } = {}) {
    const headers = {};
    if (key) headers['x-readonly-api-key'] = key;
    if (su) { headers.authorization = 'Bearer ' + suToken(roles); headers['x-su-elevation'] = mintElevationToken(6); }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  let seq = 0;
  /** A key row straight in the table: → { id, key }. expiresInMin < 0 = expired. */
  async function makeKey({ expiresInMin = -30, scopes = ['sql.ro', 'scratch', 'alert'], createdBy = 6, parent = null, revoked = false, label } = {}) {
    const key = `ycro_krr${++seq}x${Date.now()}`;
    const r = await q(`INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at, scopes, parent_key_id, revoked_at, last_used_at)
                       VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE, ?, ?, ?, '2026-11-01 12:00:00')`,
      [hashKey(key), key.slice(0, 12), label || `session ${seq}`, createdBy, expiresInMin, scopes === null ? null : JSON.stringify(scopes),
        parent, revoked ? new Date() : null]);
    return { id: r.insertId, key };
  }
  const ask = (key, body = { reason: 'finishing the docs review arc' }) => hit('POST', '/api/readonly/renewal-request', { key, body });
  const status = (key) => hit('GET', '/api/readonly/renewal-request', { key });
  const list = (qs = '') => hit('GET', `/api/readonly-keys/renewal-requests${qs}`, { su: true });
  const approve = (id, body = {}) => hit('POST', `/api/readonly-keys/renewal-requests/${id}/approve`, { su: true, body });
  const deny = (id) => hit('POST', `/api/readonly-keys/renewal-requests/${id}/deny`, { su: true });
  const reqRows = (keyId) => q('SELECT * FROM key_renewal_requests WHERE key_id = ? ORDER BY id', [keyId]);
  const keyRow = async (id) => (await q('SELECT * FROM readonly_api_keys WHERE id = ?', [id]))[0];
  const audits = (status) => q('SELECT user_id, details FROM admin_audit_log WHERE tool = ? AND status = ? ORDER BY id', ['readonlyKeys', status]);
  const near = (ms, target, tol = 5000) => Math.abs(ms - target) <= tol;

  test('an expired key asks: one pending row, one email to the creator, usage untouched', async () => {
    const k = await makeKey({ label: 'docs review' });
    expect((await hit('GET', '/probe', { key: k.key })).status).toBe(401);   // the ordinary auth still refuses it
    const before = await keyRow(k.id);
    const r = await ask(k.key, { reason: '  finishing the docs review arc  ', ttlMinutes: 240 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, notified: 'IT',
      request: { status: 'pending', reason: 'finishing the docs review arc', requestedTtlMinutes: 240, emailSent: true } });
    const rows = await reqRows(k.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', notify_user: 6, requested_ttl_min: 240, email_error: null, pending_key: k.id });
    expect(rows[0].key_expires_at.getTime()).toBe(before.expires_at.getTime());
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].to).toBe('it@example.test');
    expect(mockSent[0].from).toBe('alerts@example.test');
    expect(mockSent[0].subject).toBe(`[YisraCase] Session key #${k.id} "docs review" asks to be renewed`);
    expect(mockSent[0].text).toContain('Expired:');
    expect(mockSent[0].text).toContain('Reason:     finishing the docs review arc');
    expect(mockSent[0].text).toContain('Asked for:  4 hours — the max for this key is 3 days');
    expect(mockSent[0].text).toContain(`/?open=tabPanel~adminReadonlyKeys~renew-${rows[0].id}`);
    const after = await keyRow(k.id);
    expect([after.use_count, after.last_used_at.getTime()]).toEqual([before.use_count, before.last_used_at.getTime()]);
    const a = (await audits('renewal_requested')).pop();
    expect(a.details).toMatchObject({ key_id: k.id, request_id: rows[0].id, requested_ttl_min: 240, notify_user: 6 });
    expect(JSON.stringify(a)).not.toContain(k.key);
  });

  test('a repeat is the pending one, no second email; GET reports it', async () => {
    const k = await makeKey();
    const first = await ask(k.key);
    const again = await ask(k.key, { reason: 'please, still need it back' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, request: { id: first.body.request.id, reason: 'finishing the docs review arc' } });
    expect(mockSent).toHaveLength(1);
    expect(await reqRows(k.id)).toHaveLength(1);
    const s = await status(k.key);
    expect(s.body).toMatchObject({ ok: true, keyId: k.id, expired: true, request: { id: first.body.request.id, status: 'pending' } });
  });

  test('concurrent asks: one row, one email (the UNIQUE pending_key)', async () => {
    const k = await makeKey();
    const rs = await Promise.all(Array.from({ length: 6 }, () => ask(k.key)));
    expect(rs.map(r => r.status)).toEqual(Array(6).fill(200));
    expect(rs.filter(r => r.body.duplicate === false)).toHaveLength(1);
    expect(await reqRows(k.id)).toHaveLength(1);
    expect(mockSent).toHaveLength(1);
  });

  test('the database itself refuses a second pending row for one key', async () => {
    const k = await makeKey();
    await ask(k.key);
    await expect(q(`INSERT INTO key_renewal_requests (key_id, reason, notify_user, key_expires_at) VALUES (?, 'x', 6, NOW())`, [k.id]))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await q(`INSERT INTO key_renewal_requests (key_id, reason, notify_user, key_expires_at, status) VALUES (?, 'x', 6, NOW(), 'denied')`, [k.id]);
  });

  test('SU list: the request with its key and caps; ?id= and ?status=pending', async () => {
    const k = await makeKey({ label: 'listed' });
    const r = await ask(k.key);
    const id = r.body.request.id;
    const one = await list(`?id=${id}`);
    expect(one.status).toBe(200);
    expect(one.body.requests).toHaveLength(1);
    expect(one.body.requests[0]).toMatchObject({ id, key_id: k.id, key_label: 'listed', status: 'pending', notify_username: 'IT',
      key_scopes: ['sql.ro', 'scratch', 'alert'], caps: { default_minutes: 1440, max_minutes: 3 * 1440, sensitive: false } });
    const pend = await list('?status=pending');
    expect(pend.body.requests.every(x => x.status === 'pending')).toBe(true);
    expect(pend.body.requests.map(x => x.id)).toContain(id);
    expect((await list('?status=bogus')).status).toBe(400);
  });

  test('approve: the ordinary renew — TTL honoured, key works again, audited via_request; a second approve 409', async () => {
    const k = await makeKey();
    const id = (await ask(k.key)).body.request.id;
    const t0 = Date.now();
    const r = await approve(id, { ttlMinutes: 120 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id, keyId: k.id, status: 'approved', ttlMinutes: 120 });
    expect(near((await keyRow(k.id)).expires_at.getTime(), t0 + 120 * MIN)).toBe(true);
    expect((await hit('GET', '/probe', { key: k.key })).status).toBe(200);
    const [row] = await reqRows(k.id);
    expect(row).toMatchObject({ status: 'approved', decided_by: 6, granted_ttl_min: 120, pending_key: null });
    expect(row.new_expires_at.getTime()).toBe((await keyRow(k.id)).expires_at.getTime());
    const s = await status(k.key);
    expect(s.body).toMatchObject({ expired: false, request: { id, status: 'approved', grantedTtlMinutes: 120 } });
    const a = (await audits('renewed')).pop();
    expect(a).toMatchObject({ user_id: 6, details: { key_id: k.id, via_request: id } });
    expect(await approve(id)).toEqual({ status: 409, body: { error: `request #${id} is already approved`, status: 'approved' } });
  });

  test('approve without a TTL grants the key kind\'s default; a sensitive key caps at 24h', async () => {
    const k = await makeKey();
    const id = (await ask(k.key)).body.request.id;
    const t0 = Date.now();
    expect((await approve(id)).body.ttlMinutes).toBe(1440);
    expect(near((await keyRow(k.id)).expires_at.getTime(), t0 + 1440 * MIN)).toBe(true);

    const s = await makeKey({ scopes: ['sql.ro', 'sql.ro.sensitive'] });
    const over = await ask(s.key, { reason: 'reading the audit log again', ttlMinutes: 1441 });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ maxTtlMinutes: 1440, defaultTtlMinutes: 240 });
    expect(await reqRows(s.id)).toHaveLength(0);
    const sid = (await ask(s.key, { reason: 'reading the audit log again' })).body.request.id;
    expect((await approve(sid, { ttlMinutes: 1441 })).status).toBe(400);   // the renew's own cap
    expect((await reqRows(s.id))[0].status).toBe('pending');               // nothing decided
    expect((await approve(sid)).body.ttlMinutes).toBe(240);
  });

  test('a concurrent double approve renews ONCE', async () => {
    const k = await makeKey();
    const id = (await ask(k.key)).body.request.id;
    const n0 = (await audits('renewed')).length;
    const rs = await Promise.all([approve(id, { ttlMinutes: 60 }), approve(id, { ttlMinutes: 600 })]);
    expect(rs.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await audits('renewed')).length).toBe(n0 + 1);
    const won = rs.find(r => r.status === 200).body.ttlMinutes;
    expect((await reqRows(k.id))[0].granted_ttl_min).toBe(won);
  });

  test('deny: 429 for an hour, then a new request is allowed; a live key may ask', async () => {
    const k = await makeKey({ expiresInMin: 20 });   // live, asking ahead
    const id = (await ask(k.key)).body.request.id;
    expect(mockSent[0].text).toContain('Expires:');
    const r = await deny(id);
    expect(r).toEqual({ status: 200, body: { ok: true, id, status: 'denied' } });
    expect((await reqRows(k.id))[0]).toMatchObject({ status: 'denied', decided_by: 6, pending_key: null });
    expect((await audits('renewal_denied')).pop().details).toEqual({ key_id: k.id, request_id: id });
    expect((await deny(id)).status).toBe(409);
    const again = await ask(k.key);
    expect(again.status).toBe(429);
    expect(again.body.retryInMinutes).toBeGreaterThan(55);
    await q('UPDATE key_renewal_requests SET decided_at = NOW() - INTERVAL 61 MINUTE WHERE id = ?', [id]);
    expect((await ask(k.key)).status).toBe(200);
    expect(await reqRows(k.id)).toHaveLength(2);
  });

  test('validation: reason 10–200 after trim, TTL junk / over 3 days → 400, nothing written', async () => {
    const k = await makeKey();
    for (const body of [{}, { reason: '' }, { reason: '   short   ' }, { reason: 'x'.repeat(201) }, { reason: 42 },
      { reason: 'a fine reason here', ttlMinutes: 3 * 1440 + 1 }, { reason: 'a fine reason here', ttlMinutes: 'soon' },
      { reason: 'a fine reason here', ttlMinutes: 0 }]) {
      const r = await ask(k.key, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await ask(k.key, { reason: 'x'.repeat(200) })).status).toBe(200);
    expect(await reqRows(k.id)).toHaveLength(1);
  });

  test('a child → 409 naming its manager route; revoked / unknown / missing key → 401', async () => {
    const parent = await makeKey({ expiresInMin: 600, scopes: ['sql.ro', 'scratch', 'alert', 'keys.mint'] });
    const child = await makeKey({ parent: parent.id });
    const r = await ask(child.key);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(`/api/readonly-keys/children/${child.id}/renew`);
    expect(await reqRows(child.id)).toHaveLength(0);
    const gone = await makeKey({ revoked: true });
    expect((await ask(gone.key)).body).toEqual({ error: 'Readonly API key revoked' });
    expect((await ask('ycro_nosuchkeyatall')).status).toBe(401);
    expect((await hit('POST', '/api/readonly/renewal-request', { body: { reason: 'no key header at all' } })).status).toBe(401);
    expect((await status(gone.key)).status).toBe(401);
  });

  test('a key revoked while pending: approve 409 (still pending), deny closes it', async () => {
    const k = await makeKey();
    const id = (await ask(k.key)).body.request.id;
    await q('UPDATE readonly_api_keys SET revoked_at = NOW() WHERE id = ?', [k.id]);
    const r = await approve(id);
    expect(r).toEqual({ status: 409, body: { error: 'revoked keys stay revoked — mint a new one' } });
    expect((await reqRows(k.id))[0].status).toBe('pending');
    expect((await deny(id)).status).toBe(200);
  });

  test('a failed email: 502, pending with email_error; the repeat retries the send', async () => {
    const k = await makeKey();
    mockSendFails = 'relay refused';
    const r = await ask(k.key);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, request: { status: 'pending', emailSent: false } });
    expect(r.body.error).toContain('relay refused');
    expect((await reqRows(k.id))[0].email_error).toBe('relay refused');
    mockSendFails = null;
    const again = await ask(k.key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, request: { emailSent: true } });
    expect(mockSent).toHaveLength(1);
    expect((await reqRows(k.id))[0].email_error).toBeNull();
    const third = await ask(k.key);   // sent now: no further email
    expect(third.body.duplicate).toBe(true);
    expect(mockSent).toHaveLength(1);
  });

  test('a creator with no email on file → 502 naming the creator; the request is still listed', async () => {
    const k = await makeKey({ createdBy: 1 });
    const r = await ask(k.key);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/creator \(user 1 SS\) has no email address on file/);
    expect(mockSent).toHaveLength(0);
    const l = await list(`?id=${r.body.request.id}`);
    expect(l.body.requests[0]).toMatchObject({ status: 'pending', notify_username: 'SS' });
  });

  test('the SU routes refuse a non-SU and a key', async () => {
    const k = await makeKey();
    const id = (await ask(k.key)).body.request.id;
    for (const [m, p] of [['GET', '/api/readonly-keys/renewal-requests'], ['POST', `/api/readonly-keys/renewal-requests/${id}/approve`],
      ['POST', `/api/readonly-keys/renewal-requests/${id}/deny`]]) {
      expect((await hit(m, p, { su: true, roles: [], body: m === 'POST' ? {} : undefined })).status).toBe(403);
      expect([401, 403]).toContain((await hit(m, p, { key: k.key, body: m === 'POST' ? {} : undefined })).status);
    }
    expect((await reqRows(k.id))[0].status).toBe('pending');
    expect((await approve(999999)).status).toBe(404);
    expect((await deny(999999)).status).toBe(404);
    expect((await approve('abc')).status).toBe(400);
  });
});
