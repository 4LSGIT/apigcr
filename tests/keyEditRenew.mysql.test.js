// tests/keyEditRenew.mysql.test.js
//
/**
 * Edit scopes + renew expiry, session AND machine keys, on REAL MySQL —
 * access-control D2 (routes/api.readonlyKeys.js PATCH /:id, POST /:id/renew,
 * POST /children/:id/renew; routes/admin.apiKeys.js PATCH /:id, POST
 * /:id/expiry; lib/apiKeys setScopes / setExpiry; ACCESS_CONTROL_DESIGN §5.9).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_d2_test npx jest tests/keyEditRenew.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * readonly_api_keys, api_keys, admin_audit_log, jwt_api_audit_log and users.
 * Shapes: the post-D1 live tables (parent_key_id + its FK; ip_allowlist gone —
 * D2 never names it, so the pre-stage-2 shape behaves the same).
 *
 * WHAT IS LOCKED
 *   Session edit: full replace stored; legacy NULL → scoped (retrofit); NULL
 *   target 400; unknown 400; sensitive without sql.ro 400; adding sensitive
 *   with > 24h left 400 naming the renew route — then renew ≤ 24h and the add
 *   passes; a child outside the trio 400; revoked 409; parent narrowed → child
 *   effective narrows at auth, child row untouched; keys.mint removed → the
 *   child lives, the reply says so; audit before/after.
 *   Session renew: each cap (ordinary 3d, sensitive 24h, child 24h / parent)
 *   and its default; over a cap 400, never clamped; expired → renewed
 *   authenticates; revoked 409; child of a revoked parent 409; the reply's
 *   expiresStamp; parent renews its own child; foreign / missing / self 404;
 *   a child cannot renew (403); audit before/after.
 *   Machine: scope edit stored + NULL target 400 + surface scope 400; expiry
 *   set / cleared / junk 400 / both 400; revoked 409; expired → renewed passes
 *   lookup on the serving instance at once (invalidateCache); audit rows.
 */
'use strict';

process.env.JWT_SECRET = 'key-edit-renew-d2-mysql-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';
process.env.SU_RATE_LIMIT_API_KEYS = '10000';

const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const { readonlyApiKeyAuth, requireKeyScope, hashKey } = require('../lib/auth.readonly');
const { mintElevationToken } = require('../lib/auth.superuser');
const apiKeys = require('../lib/apiKeys');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('D2 edit + renew on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const MIN = 60e3;

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['readonly_api_keys', 'api_keys', 'admin_audit_log', 'jwt_api_audit_log', 'users']) await q(`DROP TABLE IF EXISTS \`${t}\``);
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
    await q(`CREATE TABLE api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY, label varchar(100) NOT NULL,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(12) NOT NULL, created_by int DEFAULT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at timestamp NULL DEFAULT NULL,
      revoked_at timestamp NULL DEFAULT NULL, expires_at datetime NULL DEFAULT NULL, scopes json DEFAULT NULL
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
    await q('CREATE TABLE users (user int NOT NULL PRIMARY KEY, username varchar(255))');
    await q("INSERT INTO users VALUES (6, 'IT')");

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.readonlyKeys'));
    app.use(require('../routes/admin.apiKeys'));
    for (const s of ['sql.ro', 'scratch', 'alert']) {
      app.get(`/probe/${s}`, readonlyApiKeyAuth, requireKeyScope(s), (req, res) => res.json({ ok: true, auth: req.auth }));
    }
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  const suToken = () => jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, path, { key, su, body } = {}) {
    const headers = {};
    if (key) headers['x-readonly-api-key'] = key;
    if (su) { headers.authorization = 'Bearer ' + suToken(); headers['x-su-elevation'] = mintElevationToken(6); }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  const suMint = (body) => hit('POST', '/api/readonly-keys', { su: true, body });
  const edit = (id, scopes) => hit('PATCH', `/api/readonly-keys/${id}`, { su: true, body: { scopes } });
  const renew = (id, body = {}) => hit('POST', `/api/readonly-keys/${id}/renew`, { su: true, body });
  const childRenew = (key, id, body = {}) => hit('POST', `/api/readonly-keys/children/${id}/renew`, { key, body });
  const mintChild = (key, body = {}) => hit('POST', '/api/readonly-keys/children', { key, body: { label: 'worker', ...body } });
  const probe = (key, scope) => hit('GET', `/probe/${scope}`, { key });
  const row = async (id) => (await q('SELECT * FROM readonly_api_keys WHERE id = ?', [id]))[0];
  const expMs = async (id) => (await row(id)).expires_at.getTime();
  const lastAudit = async (tool, status) => (await q(
    'SELECT user_id, details FROM admin_audit_log WHERE tool = ? AND status = ? ORDER BY id DESC LIMIT 1', [tool, status]))[0];
  const near = (ms, target, tol = 5000) => Math.abs(ms - target) <= tol;

  // ── session: edit ─────────────────────────────────────────────────────────

  test('edit: a full replace is stored, audited before/after', async () => {
    const m = await suMint({ label: 'edit me', scopes: ['sql.ro', 'scratch'] });
    const r = await edit(m.body.id, ['alert', 'temp.clio']);
    expect(r).toEqual({ status: 200, body: { ok: true, id: m.body.id, scopes: ['alert', 'temp.clio'], before: ['sql.ro', 'scratch'] } });
    expect((await row(m.body.id)).scopes).toEqual(['alert', 'temp.clio']);
    expect((await probe(m.body.key, 'sql.ro')).status).toBe(403);
    expect((await probe(m.body.key, 'alert')).status).toBe(200);
    const a = await lastAudit('readonlyKeys', 'scopes_edited');
    expect(a.user_id).toBe(6);
    expect(a.details).toEqual({ key_id: m.body.id, before: { scopes: ['sql.ro', 'scratch'] }, after: { scopes: ['alert', 'temp.clio'] } });
    expect(JSON.stringify(a)).not.toContain(m.body.key.split('_')[1]);
  });

  test('edit: legacy NULL → scoped (the retrofit); NULL is never a target', async () => {
    await q(`INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at)
             VALUES (?, 'ycro_legacy', 'legacy', 6, '2099-01-01')`, [hashKey('ycro_legacyd2')]);
    const [{ id }] = await q("SELECT id FROM readonly_api_keys WHERE label = 'legacy'");
    expect((await probe('ycro_legacyd2', 'scratch')).status).toBe(200);
    for (const scopes of [null, undefined]) {
      const r = await hit('PATCH', `/api/readonly-keys/${id}`, { su: true, body: scopes === null ? { scopes: null } : {} });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/never set back to NULL/);
    }
    expect((await row(id)).scopes).toBeNull();
    const r = await edit(id, ['sql.ro']);
    expect(r.body).toMatchObject({ scopes: ['sql.ro'], before: null });
    expect((await probe('ycro_legacyd2', 'scratch')).status).toBe(403);
    expect((await lastAudit('readonlyKeys', 'scopes_edited')).details.before).toEqual({ scopes: null });
  });

  test('edit 400s: unknown, empty, sensitive without sql.ro — nothing written', async () => {
    const m = await suMint({ label: 'strict', scopes: ['sql.ro'] });
    for (const [scopes, msg] of [[['sql.rw'], /unknown scope/], [[], /non-empty array/],
      [['sql.ro.sensitive'], /needs sql\.ro too/], ['sql.ro', /non-empty array/]]) {
      const r = await edit(m.body.id, scopes);
      expect([JSON.stringify(scopes), r.status]).toEqual([JSON.stringify(scopes), 400]);
      expect(r.body.error).toMatch(msg);
    }
    expect((await row(m.body.id)).scopes).toEqual(['sql.ro']);
  });

  test('edit: adding sensitive with > 24h left → 400 naming renew; renew ≤ 24h, then it passes', async () => {
    const m = await suMint({ label: 'to be sensitive', ttlMinutes: 3 * 1440, scopes: ['sql.ro'] });
    let r = await edit(m.body.id, ['sql.ro', 'sql.ro.sensitive']);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 1440 minutes \(24h\) left/);
    expect(r.body.renewRoute).toBe(`/api/readonly-keys/${m.body.id}/renew`);
    expect((await row(m.body.id)).scopes).toEqual(['sql.ro']);
    expect((await renew(m.body.id, { ttlMinutes: 600 })).status).toBe(200);
    r = await edit(m.body.id, ['sql.ro', 'sql.ro.sensitive']);
    expect(r.status).toBe(200);
    // already sensitive: a further edit keeping it is not re-checked — only ADDING is
    // (a sensitive key with > 24h left exists only by hand; simulate one)
    await q('UPDATE readonly_api_keys SET expires_at = NOW() + INTERVAL 3 DAY WHERE id = ?', [m.body.id]);
    expect((await edit(m.body.id, ['sql.ro', 'sql.ro.sensitive', 'scratch'])).status).toBe(200);
  });

  test('edit / renew a revoked key → 409, nothing written', async () => {
    const m = await suMint({ label: 'gone', scopes: ['sql.ro'] });
    await hit('DELETE', `/api/readonly-keys/${m.body.id}`, { su: true });
    const before = await row(m.body.id);
    for (const r of [await edit(m.body.id, ['scratch']), await renew(m.body.id)]) {
      expect(r).toEqual({ status: 409, body: { error: 'revoked keys stay revoked — mint a new one' } });
    }
    expect(await row(m.body.id)).toEqual(before);
    expect((await edit(999999, ['sql.ro'])).status).toBe(404);
    expect((await renew(999999)).status).toBe(404);
  });

  test('a revoke landing between the read and the write still wins: 409, nothing written', async () => {
    // A db that revokes the key right after the edit's row read — the UPDATE's
    // own revoked_at guard is the only thing standing between them.
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.db = { query: async (sql, p) => {
        const out = await pool.query(sql, p);
        if (/WHERE k\.id = \?/.test(String(sql))) await pool.query('UPDATE readonly_api_keys SET revoked_at = NOW() WHERE id = ?', p);
        return out;
      } };
      next();
    });
    app.use(require('../routes/api.readonlyKeys'));
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const b2 = `http://127.0.0.1:${srv.address().port}`;
    try {
      for (const [method, sfx, body] of [['PATCH', '', { scopes: ['scratch'] }], ['POST', '/renew', { ttlMinutes: 30 }]]) {
        const m = await suMint({ label: 'raced', scopes: ['sql.ro'], ttlMinutes: 60 });
        const before = await row(m.body.id);
        const r = await fetch(`${b2}/api/readonly-keys/${m.body.id}${sfx}`, { method,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + suToken(), 'x-su-elevation': mintElevationToken(6) },
          body: JSON.stringify(body) });
        expect([method, r.status]).toEqual([method, 409]);
        const after = await row(m.body.id);
        expect([after.scopes, after.expires_at]).toEqual([before.scopes, before.expires_at]);
      }
    } finally { await new Promise(r => srv.close(r)); }
  });

  test('the GET vocabulary flags the explicit scopes (the retrofit dialog\'s starting point)', async () => {
    const r = await hit('GET', '/api/readonly-keys', { su: true });
    expect(r.body.scope_vocabulary.filter(v => v.explicit).map(v => v.name)).toEqual(['sql.ro.sensitive', 'keys.mint']);
    expect(r.body.child_scopes).toEqual(['sql.ro', 'scratch', 'alert']);
    expect(r.body.ttl).toEqual({ max_minutes: 4320, default_minutes: 1440, child_max_minutes: 1440 });
  });

  // ── session: parents and children ─────────────────────────────────────────

  let mgr, kid;   // a manager key and its child
  test('a child is edited only within the trio', async () => {
    const m = await suMint({ label: 'manager', scopes: ['sql.ro', 'scratch', 'alert', 'keys.mint'] });
    mgr = { id: m.body.id, key: m.body.key };
    const c = await mintChild(mgr.key, { scopes: ['sql.ro', 'scratch'] });
    kid = { id: c.body.id, key: c.body.key };
    for (const bad of [['keys.mint'], ['sql.ro', 'temp.clio'], ['sql.ro', 'sql.ro.sensitive']]) {
      const r = await edit(kid.id, bad);
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
      expect(r.body.error).toMatch(/not delegable/);
    }
    expect((await edit(kid.id, ['alert'])).body.scopes).toEqual(['alert']);
    expect((await probe(kid.key, 'alert')).status).toBe(200);
    expect((await edit(kid.id, ['sql.ro', 'scratch'])).status).toBe(200);
  });

  test('parent narrowed → the child narrows at auth; its row is never written', async () => {
    const before = await row(kid.id);
    expect((await probe(kid.key, 'scratch')).status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    const snap = { ...(await row(kid.id)) };
    expect((await edit(mgr.id, ['sql.ro', 'keys.mint'])).status).toBe(200);
    const r = await probe(kid.key, 'scratch');
    expect(r.status).toBe(403);
    expect(r.body.keyScopes).toEqual(['sql.ro']);
    const after = await row(kid.id);
    expect({ scopes: after.scopes, expires_at: after.expires_at, revoked_at: after.revoked_at })
      .toEqual({ scopes: snap.scopes, expires_at: snap.expires_at, revoked_at: snap.revoked_at });
    expect(after.scopes).toEqual(before.scopes);
    // and widening the parent back restores it — the child row held its own all along
    expect((await edit(mgr.id, ['sql.ro', 'scratch', 'keys.mint'])).status).toBe(200);
    expect((await probe(kid.key, 'scratch')).status).toBe(200);
  });

  test('keys.mint removed → the child lives; the reply says so; the parent can no longer manage it', async () => {
    const r = await edit(mgr.id, ['sql.ro', 'scratch']);
    expect(r.status).toBe(200);
    expect(r.body.notes).toEqual([expect.stringMatching(/^keys\.mint removed: 1 live child key\(s\) keep working, without a manager/)]);
    expect((await probe(kid.key, 'sql.ro')).status).toBe(200);
    expect((await row(kid.id)).revoked_at).toBeNull();
    expect((await childRenew(mgr.key, kid.id)).status).toBe(403);           // no keys.mint any more
    expect((await edit(mgr.id, ['sql.ro', 'scratch', 'keys.mint'])).body.notes).toBeUndefined();
  });

  // ── session: renew ────────────────────────────────────────────────────────

  test('renew caps — ordinary: default 1 day, ≤ 3 days, over → 400 (never clamped); stamp returned', async () => {
    const m = await suMint({ label: 'renew me', ttlMinutes: 60, scopes: ['sql.ro'] });
    const was = await expMs(m.body.id);
    let r = await renew(m.body.id);
    expect(r.status).toBe(200);
    expect(near(await expMs(m.body.id), Date.now() + 1440 * MIN)).toBe(true);
    expect(r.body.expiresStamp).toBe(new Date(r.body.expiresAt).toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z');
    expect(new Date(r.body.expiresAt).getTime()).toBe(await expMs(m.body.id));
    const a = await lastAudit('readonlyKeys', 'renewed');
    expect(a.details).toEqual({ key_id: m.body.id, before: { expires_at: new Date(was).toISOString() }, after: { expires_at: r.body.expiresAt } });
    r = await renew(m.body.id, { ttlMinutes: 4320 });
    expect(r.status).toBe(200);
    const atMax = await expMs(m.body.id);
    for (const ttl of [4321, 0, -5, 1.5, 'soon']) {
      r = await renew(m.body.id, { ttlMinutes: ttl });
      expect([ttl, r.status]).toEqual([ttl, 400]);
    }
    expect(r.body.error).toMatch(/positive whole number/);
    expect((await renew(m.body.id, { ttlMinutes: 4321 })).body.error).toMatch(/at most 4320 minutes \(3 days\)/);
    expect(await expMs(m.body.id)).toBe(atMax);
  });

  test('renew caps — sensitive: default 4h, ≤ 24h', async () => {
    const m = await suMint({ label: 'sens', scopes: ['sql.ro', 'sql.ro.sensitive'], ttlMinutes: 30 });
    expect((await renew(m.body.id)).status).toBe(200);
    expect(near(await expMs(m.body.id), Date.now() + 240 * MIN)).toBe(true);
    const r = await renew(m.body.id, { ttlMinutes: 1441 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sql\.ro\.sensitive key lives at most 1440/);
    expect((await renew(m.body.id, { ttlMinutes: 1440 })).status).toBe(200);
  });

  test('renew caps — child (SU): ≤ 24h and ≤ the parent; default the smaller; a revoked parent → 409', async () => {
    const p = await suMint({ label: 'short parent', ttlMinutes: 120, scopes: ['sql.ro', 'keys.mint'] });
    const c = await mintChild(p.body.key, { ttlMinutes: 10 });
    const pExp = await expMs(p.body.id);
    expect((await renew(c.body.id)).status).toBe(200);
    expect(await expMs(c.body.id)).toBe(pExp);
    let r = await renew(c.body.id, { ttlMinutes: 121 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cannot outlive its parent/);
    r = await renew(c.body.id, { ttlMinutes: 30 });
    expect(r.status).toBe(200);
    expect(near(await expMs(c.body.id), Date.now() + 30 * MIN)).toBe(true);
    // a long parent: the child cap is 24h
    const lp = await suMint({ label: 'long parent', ttlMinutes: 4320, scopes: ['sql.ro', 'keys.mint'] });
    const lc = await mintChild(lp.body.key);
    expect((await renew(lc.body.id, { ttlMinutes: 1441 })).body.error).toMatch(/at most 1440 minutes/);
    // parent revoked → the child is dead for good
    await hit('DELETE', `/api/readonly-keys/${p.body.id}`, { su: true });
    r = await renew(c.body.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/parent key is revoked/);
  });

  test('an expired (unrevoked) key renews and authenticates again', async () => {
    const m = await suMint({ label: 'lapsed', scopes: ['sql.ro'] });
    await q('UPDATE readonly_api_keys SET expires_at = NOW() - INTERVAL 1 HOUR WHERE id = ?', [m.body.id]);
    expect((await probe(m.body.key, 'sql.ro')).status).toBe(401);
    expect((await renew(m.body.id, { ttlMinutes: 30 })).status).toBe(200);
    expect((await probe(m.body.key, 'sql.ro')).status).toBe(200);
  });

  test('a parent renews its OWN child; foreign / missing / self → 404; a child cannot renew', async () => {
    const a = await suMint({ label: 'A', ttlMinutes: 600, scopes: ['sql.ro', 'keys.mint'] });
    const b = await suMint({ label: 'B', ttlMinutes: 600, scopes: ['sql.ro', 'keys.mint'] });
    const ca = await mintChild(a.body.key, { ttlMinutes: 5 });
    const was = await expMs(ca.body.id);
    let r = await childRenew(a.body.key, ca.body.id, { ttlMinutes: 120 });
    expect(r.status).toBe(200);
    expect(near(await expMs(ca.body.id), Date.now() + 120 * MIN)).toBe(true);
    expect(r.body.expiresStamp).toMatch(/^\d{8}T\d{4}Z$/);
    const au = await lastAudit('readonlyKeys', 'child_renewed');
    expect(au.user_id).toBeNull();
    expect(au.details).toEqual({ parentKeyId: a.body.id, childKeyId: ca.body.id,
      before: { expiresAt: new Date(was).toISOString() }, after: { expiresAt: r.body.expiresAt } });
    // caps
    expect((await childRenew(a.body.key, ca.body.id, { ttlMinutes: 601 })).body.error).toMatch(/cannot outlive its parent/);
    expect((await childRenew(a.body.key, ca.body.id, { ttlMinutes: 1441 })).body.error).toMatch(/at most 1440/);
    // ownership
    const foreign = await childRenew(b.body.key, ca.body.id);
    const missing = await childRenew(b.body.key, 999999);
    const self = await childRenew(a.body.key, a.body.id);
    expect(foreign).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(missing).toEqual(foreign);
    expect(self).toEqual(foreign);
    // a child cannot renew anything (no keys.mint, ever)
    expect((await childRenew(ca.body.key, ca.body.id)).body.missingScope).toBe('keys.mint');
    // an own revoked child → 409 — before any TTL judgement
    await hit('DELETE', `/api/readonly-keys/children/${ca.body.id}`, { key: a.body.key });
    expect((await childRenew(a.body.key, ca.body.id)).status).toBe(409);
    expect((await childRenew(a.body.key, ca.body.id, { ttlMinutes: 99999 })).status).toBe(409);
  });

  // ── machine keys ──────────────────────────────────────────────────────────

  const mkPatch = (id, body) => hit('PATCH', `/api/api-keys/${id}`, { su: true, body });
  const mkExpiry = (id, body) => hit('POST', `/api/api-keys/${id}/expiry`, { su: true, body });
  const mkRow = async (id) => (await q('SELECT * FROM api_keys WHERE id = ?', [id]))[0];

  test('machine: scope edit stored + audited; NULL target and surface scopes 400; legacy retrofit', async () => {
    const k = await apiKeys.createKey(pool, 'Pabbly', 6);                    // legacy NULL
    let r = await mkPatch(k.id, { scopes: ['route:/process-jobs', 'firm.settings'] });
    expect(r).toEqual({ status: 200, body: { status: 'success', id: k.id, before: { scopes: null }, after: { scopes: ['route:/process-jobs', 'firm.settings'] } } });
    expect((await mkRow(k.id)).scopes).toEqual(['route:/process-jobs', 'firm.settings']);
    const a = await lastAudit('api_keys', 'scopes_edited');
    expect(a.details).toEqual({ key_id: k.id, before: { scopes: null }, after: { scopes: ['route:/process-jobs', 'firm.settings'] } });
    for (const [body, msg] of [[{ scopes: null }, /never set back to NULL/], [{}, /never set back to NULL/],
      [{ scopes: ['sql.ro'] }, /session-key scope/], [{ scopes: ['route:/'] }, /unknown scope/], [{ scopes: [] }, /non-empty/]]) {
      r = await mkPatch(k.id, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(r.body.message).toMatch(msg);
    }
    expect((await mkRow(k.id)).scopes).toEqual(['route:/process-jobs', 'firm.settings']);
  });

  test('machine: expiry set, cleared, refused; audited before/after', async () => {
    const k = await apiKeys.createKey(pool, 'scheduler', 6, ['route:/process-jobs']);
    let r = await mkExpiry(k.id, { ttlMinutes: 60 });
    expect(r.status).toBe(200);
    expect(r.body.before).toEqual({ expires_at: null });
    expect(near(new Date(r.body.after.expires_at).getTime(), Date.now() + 60 * MIN)).toBe(true);
    expect((await lastAudit('api_keys', 'expiry_set')).details).toEqual({ key_id: k.id, before: { expires_at: null }, after: r.body.after });
    r = await mkExpiry(k.id, { never: true });
    expect(r.body.after).toEqual({ expires_at: null });
    expect((await mkRow(k.id)).expires_at).toBeNull();
    for (const [body, msg] of [[{}, /ttlMinutes is required/], [{ ttlMinutes: 0 }, /whole number of minutes from 1/],
      [{ ttlMinutes: 5 * 365 * 1440 + 1 }, /5 years/], [{ ttlMinutes: 60, never: true }, /not both/], [{ never: 'yes' }, /true or false/]]) {
      r = await mkExpiry(k.id, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(r.body.message).toMatch(msg);
    }
    expect((await mkRow(k.id)).expires_at).toBeNull();
  });

  test('machine: revoked → 409 on both; missing → 404; nothing written', async () => {
    const k = await apiKeys.createKey(pool, 'old', 6, ['route:/process-jobs']);
    await apiKeys.revokeKey(pool, k.id);
    const before = await mkRow(k.id);
    expect(await mkPatch(k.id, { scopes: ['firm.settings'] })).toEqual({ status: 409, body: { status: 'error', message: 'revoked keys stay revoked — mint a new one' } });
    expect((await mkExpiry(k.id, { never: true })).status).toBe(409);
    expect(await mkRow(k.id)).toEqual(before);
    expect((await mkPatch(999999, { scopes: ['firm.settings'] })).status).toBe(404);
    expect((await mkExpiry(999999, { never: true })).status).toBe(404);
  });

  test('machine: an expired key renewed passes lookup at once on the serving instance (cache invalidated)', async () => {
    const k = await apiKeys.createKey(pool, 'lapsing', 6, ['route:/process-jobs'], 1);
    await q('UPDATE api_keys SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [k.id]);
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(pool, k.raw)).toBeNull();                     // cached: expired
    expect((await mkExpiry(k.id, { ttlMinutes: 60 })).status).toBe(200);
    expect(await apiKeys.lookup(pool, k.raw)).toMatchObject({ id: k.id, scopes: ['route:/process-jobs'] });
    // a scope edit is seen at once here too
    expect((await mkPatch(k.id, { scopes: ['firm.settings'] })).status).toBe(200);
    expect((await apiKeys.lookup(pool, k.raw)).scopes).toEqual(['firm.settings']);
  });
});
