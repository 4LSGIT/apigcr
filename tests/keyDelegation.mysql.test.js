// tests/keyDelegation.mysql.test.js
//
/**
 * Delegated session keys on REAL MySQL — access-control D1
 * (scripts/accessD1ParentKey.js; routes/api.readonlyKeys.js /children and the
 * SU routes; lib/auth.readonly cascade — all over a real pool).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_d1_test npx jest tests/keyDelegation.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * readonly_api_keys, admin_audit_log, jwt_api_audit_log and users in it.
 *
 * WHAT IS LOCKED (what a scripted db cannot prove)
 *   - DEPLOY ORDER, both directions: the D1 auth on the PRE-D1 schema fails
 *     CLOSED (500, next() never runs) for every key; the pre-D1 SU insert
 *     still lands on the D1 schema (column NULL = root).
 *   - The migration: CHECK writes nothing; APPLY adds the column INSTANT, the
 *     index and the RESTRICT foreign key; re-run no-op; a column / index of
 *     another shape and an orphan parent id are NO-GOs, unaltered; RESTRICT
 *     refuses a hard delete of a parent with children.
 *   - Mint: SU mints a keys.mint key through the real POST; the manager mints
 *     a child: scopes = the trio ∩ parent, expiry min(24h, parent), created_by
 *     = parent's, plaintext once, audited without it; an explicit ttl.
 *   - Rate limit counted in the DB: the 11th → 429; rows from "another
 *     instance" count; ageing them past an hour frees the budget; 15
 *     concurrent mints on a fresh parent → exactly 10 (the row lock).
 *   - Cascade: parent revoked / expired → child 401 with its own status and
 *     the child's row untouched; parent narrowed → child loses the scope.
 *   - Ownership: another key's child → 404 (same body as a missing id) and
 *     stays live; the child list is the caller's own only; own revoke works.
 *   - No chain: a child (even one whose row is tampered to carry keys.mint
 *     under a parent holding it) cannot reach /children.
 *   - SU list: parent columns; activeOnly drops a child of a revoked parent.
 *   - ip_allowlist retirement (stage 2): refused before stage 1; CHECK lists
 *     the rows holding a value and drops nothing; APPLY drops it INSTANT;
 *     re-run no-op. BOTH SCHEMAS: the whole D1 flow above ran with the column
 *     present; it re-runs (SU mint / list / revoke, child mint / list / auth /
 *     revoke) with it absent — while the pre-D1 SU INSERT now fails, which is
 *     why stage 2 waits for the deploy.
 */
'use strict';

process.env.JWT_SECRET = 'key-delegation-d1-mysql-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';

const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const script = require('../scripts/accessD1ParentKey');
const { readonlyApiKeyAuth, requireKeyScope, hashKey } = require('../lib/auth.readonly');
const { mintElevationToken } = require('../lib/auth.superuser');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('D1 delegated session keys on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = () => { const out = []; return { out, log: (s) => out.push(String(s)) }; };
  const goLine = (out) => out.map(l => l.trim()).filter(l => /^(GO|NO-GO)\b/.test(l));

  const PRE_D1_KEYS = `CREATE TABLE readonly_api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(16) NOT NULL, label varchar(255) NOT NULL,
      created_by int NOT NULL, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at datetime NOT NULL, revoked_at datetime DEFAULT NULL, last_used_at datetime DEFAULT NULL,
      use_count int NOT NULL DEFAULT '0', ip_allowlist text, scopes json DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;
  // The pre-D1 SU mint's INSERT, verbatim in shape (the old backend after the migration).
  const OLD_INSERT = `INSERT INTO readonly_api_keys
      (key_hash, key_prefix, label, created_by, expires_at, ip_allowlist, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)`;

  async function freshKeysTable() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    await q('DROP TABLE IF EXISTS readonly_api_keys');
    await q('SET FOREIGN_KEY_CHECKS = 1');
    await q(PRE_D1_KEYS);
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 20, timezone: 'Z' });
    for (const t of ['admin_audit_log', 'jwt_api_audit_log', 'users']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await freshKeysTable();
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
    await q("INSERT INTO users VALUES (6, 'IT'), (9, 'Fred')");

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.readonlyKeys'));
    // A probe surface per scope: auth → gate → 200 (stands in for sql/scratch/alert).
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
  afterEach(() => jest.restoreAllMocks());

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
  const mintChild = (key, body = {}) => hit('POST', '/api/readonly-keys/children', { key, body: { label: 'worker', ...body } });
  const probe = (key, scope) => hit('GET', `/probe/${scope}`, { key });
  const row = async (id) => (await q('SELECT * FROM readonly_api_keys WHERE id = ?', [id]))[0];
  const lastAudit = async (status) => (await q(
    'SELECT tool, user_id, status, details FROM admin_audit_log WHERE status = ? ORDER BY id DESC LIMIT 1', [status]))[0];

  // ── deploy order + migration ──────────────────────────────────────────────

  test('DEPLOY ORDER: D1 auth on the pre-D1 schema fails CLOSED for every key', async () => {
    await q(OLD_INSERT, [hashKey('ycro_legacy'), 'ycro_legacy', 'claude long key', 9, '2099-01-01', null, null]);
    await q(OLD_INSERT, [hashKey('ycro_scoped'), 'ycro_scoped', 'scoped', 9, '2099-01-01', null, '["sql.ro","keys.mint"]']);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const k of ['ycro_legacy', 'ycro_scoped']) {
      const r = await probe(k, 'sql.ro');
      expect([k, r.status, r.body]).toEqual([k, 500, { error: 'Auth lookup failed' }]);
      expect((await mintChild(k)).status).toBe(500);
    }
    expect(console.error.mock.calls.some(c => /Unknown column 'k\.parent_key_id'/.test(c.join(' ')))).toBe(true);
  });

  test('migration: CHECK writes nothing; APPLY: INSTANT column + index + RESTRICT FK; re-run no-op', async () => {
    const conn = await pool.getConnection();
    try {
      let L = lines();
      expect(await script.run(conn, { apply: false, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)).toEqual(['GO — base state matches. Next: node scripts/accessD1ParentKey.js --apply']);
      expect(await q("SHOW COLUMNS FROM readonly_api_keys LIKE 'parent_key_id'")).toHaveLength(0);

      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)).toEqual(['GO — stage 1 applied. Next: land + deploy access D1, then node scripts/accessD1ParentKey.js --check-drop']);
      const [c] = await q("SHOW FULL COLUMNS FROM readonly_api_keys LIKE 'parent_key_id'");
      expect(c).toMatchObject({ Type: 'int', Null: 'YES', Default: null, Key: 'MUL' });
      expect(c.Comment).toMatch(/^Delegation \(access-control D1\): NULL = a root key/);
      const [[v]] = await conn.query(
        "SELECT TOTAL_ROW_VERSIONS n FROM information_schema.innodb_tables WHERE name = CONCAT(DATABASE(), '/readonly_api_keys')");
      expect(Number(v.n)).toBeGreaterThan(0);                 // INSTANT: a row version, no rebuild
      const idx = await q("SHOW INDEX FROM readonly_api_keys WHERE Key_name = 'idx_rok_parent'");
      expect(idx.map(i => i.Column_name)).toEqual(['parent_key_id', 'created_at']);
      const [[ddl]] = await conn.query('SHOW CREATE TABLE readonly_api_keys');
      expect(ddl['Create Table']).toMatch(/CONSTRAINT `fk_rok_parent` FOREIGN KEY \(`parent_key_id`\) REFERENCES `readonly_api_keys` \(`id`\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
      expect(await q('SELECT id FROM readonly_api_keys WHERE parent_key_id IS NOT NULL')).toEqual([]);
      const [[fkc]] = await conn.query('SELECT @@SESSION.foreign_key_checks f');
      expect(Number(fkc.f)).toBe(1);                          // restored on the script's connection

      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)[0]).toMatch(/^GO — stage 1 is already applied/);
    } finally { conn.release(); }
  });

  test('the pre-D1 backend on the D1 schema: its INSERT lands as a root key (NULL)', async () => {
    await q(OLD_INSERT, [hashKey('ycro_oldmint'), 'ycro_oldmin', 'old backend', 9, '2099-01-01', null, '["sql.ro"]']);
    const [r] = await q("SELECT parent_key_id FROM readonly_api_keys WHERE label = 'old backend'");
    expect(r.parent_key_id).toBeNull();
    const p = await probe('ycro_oldmint', 'sql.ro');
    expect(p.status).toBe(200);
    expect(p.body.auth).toMatchObject({ parentKeyId: null, scopes: ['sql.ro'] });
    expect(p.body.auth.rootKeyId).toBe(p.body.auth.keyId);
  });

  test('legacy NULL keys lack keys.mint: 403 on /children', async () => {
    const r = await mintChild('ycro_legacy');
    expect(r.status).toBe(403);
    expect(r.body.missingScope).toBe('keys.mint');
    expect((await hit('GET', '/api/readonly-keys/children', { key: 'ycro_legacy' })).status).toBe(403);
  });

  // ── mint ──────────────────────────────────────────────────────────────────

  let mgr;   // { id, key }
  test('SU mints a keys.mint key through the real POST; the manager mints a default child', async () => {
    const m = await suMint({ label: 'manager', ttlMinutes: 3 * 1440, scopes: ['sql.ro', 'scratch', 'keys.mint'] });
    expect(m.status).toBe(200);
    expect(m.body.scopes).toEqual(['sql.ro', 'scratch', 'keys.mint']);
    mgr = { id: m.body.id, key: m.body.key };
    await q('UPDATE readonly_api_keys SET created_by = 9 WHERE id = ?', [mgr.id]);   // a non-SU owner, to see it inherited

    const before = Date.now();
    const c = await mintChild(mgr.key, { label: 'worker one' });
    expect(c.status).toBe(200);
    expect(c.body.scopes).toEqual(['sql.ro', 'scratch']);                // trio ∩ parent
    expect(c.body.key).toMatch(/^ycro_[A-Za-z0-9]{22}_\d{8}T\d{4}Z$/);  // the shared generator's format
    const exp = new Date(c.body.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(Math.floor((before + 24 * 3600e3) / 1000) * 1000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 24 * 3600e3);
    const r = await row(c.body.id);
    expect(r).toMatchObject({ parent_key_id: mgr.id, created_by: 9, label: 'worker one', scopes: ['sql.ro', 'scratch'] });
    expect(r.expires_at.getTime()).toBe(exp);
    expect(r.key_hash).toBe(hashKey(c.body.key));

    const a = await lastAudit('child_created');
    expect(a).toMatchObject({ tool: 'readonlyKeys', user_id: null });
    expect(a.details).toEqual({ parentKeyId: mgr.id, childKeyId: c.body.id, label: 'worker one', scopes: ['sql.ro', 'scratch'], expiresAt: c.body.expiresAt });
    const all = JSON.stringify(await q('SELECT * FROM admin_audit_log'));
    expect(all.includes(c.body.key.split('_')[1])).toBe(false);          // the plaintext body never lands

    const p = await probe(c.body.key, 'scratch');
    expect(p.status).toBe(200);
    expect(p.body.auth).toMatchObject({ keyId: c.body.id, parentKeyId: mgr.id, rootKeyId: mgr.id, scopes: ['sql.ro', 'scratch'] });
    expect((await probe(c.body.key, 'alert')).status).toBe(403);
  });

  test('omitted TTL is capped by the parent; an explicit TTL is honoured; past the parent → 400', async () => {
    const m = await suMint({ label: 'short manager', ttlMinutes: 90, scopes: ['sql.ro', 'alert', 'keys.mint'] });
    const parentExp = (await row(m.body.id)).expires_at.getTime();
    const c = await mintChild(m.body.key);
    expect(c.status).toBe(200);
    expect(c.body.scopes).toEqual(['sql.ro', 'alert']);
    expect((await row(c.body.id)).expires_at.getTime()).toBe(parentExp);
    const t = await mintChild(m.body.key, { ttlMinutes: 30, scopes: ['alert'] });
    expect(t.status).toBe(200);
    expect(Math.abs(new Date(t.body.expiresAt).getTime() - (Date.now() + 30 * 60e3))).toBeLessThan(5000);
    const over = await mintChild(m.body.key, { ttlMinutes: 91 });
    expect(over.status).toBe(400);
    expect(over.body.parentExpiresAt).toBe(new Date(parentExp).toISOString());
  });

  // ── rate limit ────────────────────────────────────────────────────────────

  test('10 per rolling hour per parent, counted in the DB', async () => {
    const m = await suMint({ label: 'rate manager', scopes: ['sql.ro', 'keys.mint'] });
    for (let i = 0; i < 10; i++) expect((await mintChild(m.body.key, { label: `w${i}` })).status).toBe(200);
    const r11 = await mintChild(m.body.key, { label: 'eleventh' });
    expect(r11.status).toBe(429);
    expect(r11.body.error).toMatch(/10 child keys per rolling hour per parent key/);
    expect((await lastAudit('rejected_child_rate_limit')).details).toEqual({ parentKeyId: m.body.id, limit: 10 });
    expect(await q("SELECT id FROM readonly_api_keys WHERE label = 'eleventh'")).toEqual([]);
    // another parent's budget is its own
    expect((await mintChild(mgr.key, { label: 'mgr ok' })).status).toBe(200);
    // ageing the window frees it — the count is the DB's, not memory
    await q('UPDATE readonly_api_keys SET created_at = NOW() - INTERVAL 61 MINUTE WHERE parent_key_id = ?', [m.body.id]);
    expect((await mintChild(m.body.key, { label: 'after the hour' })).status).toBe(200);
    // rows another instance wrote count too
    const m2 = await suMint({ label: 'rate manager 2', scopes: ['sql.ro', 'keys.mint'] });
    const exp = new Date(Date.now() + 3600e3);
    for (let i = 0; i < 10; i++) {
      await q(`INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at, scopes, parent_key_id)
               VALUES (?, 'ycro_x', 'elsewhere', 6, ?, '["sql.ro"]', ?)`, [hashKey(`ycro_elsewhere${i}`), exp, m2.body.id]);
    }
    expect((await mintChild(m2.body.key)).status).toBe(429);
  });

  test('15 concurrent mints on a fresh parent → exactly 10 (the parent row lock)', async () => {
    const m = await suMint({ label: 'race manager', scopes: ['scratch', 'keys.mint'] });
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => mintChild(m.body.key, { label: `race${i}` })));
    const by = rs.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
    expect(by).toEqual({ 200: 10, 429: 5 });
    const [[n]] = await pool.query('SELECT COUNT(*) n FROM readonly_api_keys WHERE parent_key_id = ?', [m.body.id]);
    expect(Number(n.n)).toBe(10);
  });

  // ── cascade ───────────────────────────────────────────────────────────────

  test('parent revoked → child 401 rejected_parent_revoked; nothing written to the child', async () => {
    const m = await suMint({ label: 'doomed manager', scopes: ['sql.ro', 'keys.mint'] });
    const c = await mintChild(m.body.key);
    expect((await probe(c.body.key, 'sql.ro')).status).toBe(200);
    await new Promise(r => setTimeout(r, 50));                      // the fire-and-forget usage counter
    const before = await row(c.body.id);
    expect((await hit('DELETE', `/api/readonly-keys/${m.body.id}`, { su: true })).status).toBe(200);
    const r = await probe(c.body.key, 'sql.ro');
    expect(r).toEqual({ status: 401, body: { error: "Readonly API key's parent key revoked" } });
    expect((await lastAudit('rejected_parent_revoked')).details).toEqual({ keyId: c.body.id, parentKeyId: m.body.id });
    await new Promise(r2 => setTimeout(r2, 50));
    expect(await row(c.body.id)).toEqual(before);
  });

  test('parent expired → child 401 rejected_parent_expired', async () => {
    const m = await suMint({ label: 'expiring manager', scopes: ['sql.ro', 'keys.mint'] });
    const c = await mintChild(m.body.key);
    await q('UPDATE readonly_api_keys SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [m.body.id]);
    const r = await probe(c.body.key, 'sql.ro');
    expect(r).toEqual({ status: 401, body: { error: "Readonly API key's parent key expired" } });
    expect((await lastAudit('rejected_parent_expired')).details).toEqual({ keyId: c.body.id, parentKeyId: m.body.id });
  });

  test('parent narrowed → the child loses the scope on its next request', async () => {
    const m = await suMint({ label: 'narrowing manager', scopes: ['sql.ro', 'scratch', 'keys.mint'] });
    const c = await mintChild(m.body.key);
    expect((await probe(c.body.key, 'scratch')).status).toBe(200);
    await q(`UPDATE readonly_api_keys SET scopes = '["sql.ro","keys.mint"]' WHERE id = ?`, [m.body.id]);
    const r = await probe(c.body.key, 'scratch');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ missingScope: 'scratch', keyScopes: ['sql.ro'] });
    expect((await probe(c.body.key, 'sql.ro')).status).toBe(200);
    expect((await row(c.body.id)).scopes).toEqual(['sql.ro', 'scratch']);   // the child's own row unchanged
  });

  test('RESTRICT: a parent with children cannot be hard-deleted', async () => {
    await expect(q('DELETE FROM readonly_api_keys WHERE id = ?', [mgr.id])).rejects.toThrow(/foreign key constraint fails/);
  });

  // ── ownership + no chain ──────────────────────────────────────────────────

  test("another key's child → 404 (same body as a missing id) and stays live; lists are own-only; own revoke works", async () => {
    const a = await suMint({ label: 'manager A', scopes: ['sql.ro', 'keys.mint'] });
    const b = await suMint({ label: 'manager B', scopes: ['sql.ro', 'keys.mint'] });
    const ca = await mintChild(a.body.key, { label: 'A child' });
    const foreign = await hit('DELETE', `/api/readonly-keys/children/${ca.body.id}`, { key: b.body.key });
    const missing = await hit('DELETE', '/api/readonly-keys/children/999999', { key: b.body.key });
    expect(foreign).toEqual({ status: 404, body: { error: 'Not found or already revoked' } });
    expect(missing).toEqual(foreign);
    expect((await row(ca.body.id)).revoked_at).toBeNull();
    expect((await probe(ca.body.key, 'sql.ro')).status).toBe(200);

    const la = await hit('GET', '/api/readonly-keys/children', { key: a.body.key });
    const lb = await hit('GET', '/api/readonly-keys/children', { key: b.body.key });
    expect(la.body.children.map(c => c.id)).toEqual([ca.body.id]);
    expect(Object.keys(la.body.children[0]).sort()).toEqual(
      ['created_at', 'expires_at', 'id', 'key_prefix', 'label', 'last_used_at', 'revoked_at', 'scopes', 'use_count']);
    expect(lb.body.children).toEqual([]);

    const own = await hit('DELETE', `/api/readonly-keys/children/${ca.body.id}`, { key: a.body.key });
    expect(own).toEqual({ status: 200, body: { ok: true } });
    expect((await probe(ca.body.key, 'sql.ro')).body.error).toBe('Readonly API key revoked');
    const audit = await lastAudit('child_revoked');
    expect(audit).toMatchObject({ tool: 'readonlyKeys', user_id: null });
    expect(audit.details).toMatchObject({ parentKeyId: a.body.id, childKeyId: ca.body.id, scopes: ['sql.ro'] });
    expect(audit.details.expiresAt).toBe(ca.body.expiresAt);
    expect((await hit('DELETE', `/api/readonly-keys/children/${ca.body.id}`, { key: a.body.key })).status).toBe(404);
  });

  test('no chain: a child cannot mint — even with keys.mint tampered into its row', async () => {
    const m = await suMint({ label: 'chain manager', scopes: ['sql.ro', 'keys.mint'] });
    const c = await mintChild(m.body.key);
    await q(`UPDATE readonly_api_keys SET scopes = '["sql.ro","keys.mint"]' WHERE id = ?`, [c.body.id]);
    for (const [method, path] of [['POST', '/api/readonly-keys/children'], ['GET', '/api/readonly-keys/children'], ['DELETE', '/api/readonly-keys/children/1']]) {
      const r = await hit(method, path, { key: c.body.key, body: method === 'POST' ? { label: 'grandchild' } : undefined });
      expect([method, r.status, r.body.missingScope]).toEqual([method, 403, 'keys.mint']);
    }
    expect(await q("SELECT id FROM readonly_api_keys WHERE label = 'grandchild'")).toEqual([]);
  });

  // ── SU list ───────────────────────────────────────────────────────────────

  test('SU list: parent columns; activeOnly drops children of a dead parent', async () => {
    const m = await suMint({ label: 'listed manager', scopes: ['sql.ro', 'keys.mint'] });
    const c = await mintChild(m.body.key, { label: 'listed child' });
    let l = await hit('GET', '/api/readonly-keys?activeOnly=1', { su: true });
    const child = l.body.keys.find(k => k.id === c.body.id);
    expect(child).toMatchObject({ parent_key_id: m.body.id, parent_label: 'listed manager', parent_revoked_at: null });
    expect(l.body.keys.find(k => k.id === m.body.id)).toMatchObject({ parent_key_id: null, parent_label: null });
    expect(l.body.scope_vocabulary.map(v => v.name)).toContain('keys.mint');
    expect(l.body.default_scopes).not.toContain('keys.mint');

    await hit('DELETE', `/api/readonly-keys/${m.body.id}`, { su: true });
    l = await hit('GET', '/api/readonly-keys?activeOnly=1', { su: true });
    expect(l.body.keys.some(k => k.id === c.body.id)).toBe(false);
    l = await hit('GET', '/api/readonly-keys', { su: true });
    const dead = l.body.keys.find(k => k.id === c.body.id);
    expect(dead.revoked_at).toBeNull();
    expect(dead.parent_revoked_at).not.toBeNull();
    // SU revoke of a child works as before
    expect((await hit('DELETE', `/api/readonly-keys/${c.body.id}`, { su: true })).status).toBe(200);
  });

  // ── stage 2: retire ip_allowlist (post-deploy) ────────────────────────────

  test('stage 2 is a NO-GO before stage 1 completes', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE readonly_api_keys DROP FOREIGN KEY fk_rok_parent');
      const L = lines();
      expect(await script.runDrop(conn, { apply: true, log: L.log })).toEqual({ ok: false });
      expect(goLine(L.out)).toEqual(['NO-GO — stage 2 follows stage 1 and the D1 deploy. Next: node scripts/accessD1ParentKey.js']);
      expect(await script.ipAllowlistState(conn)).toBe('present');
      expect(await script.run(conn, { apply: true, log: () => {} })).toEqual({ ok: true });   // resume stage 1
    } finally { conn.release(); }
  });

  test('stage 2: CHECK lists the held values and drops nothing; APPLY drops INSTANT; re-run no-op', async () => {
    await q(OLD_INSERT, [hashKey('ycro_ipheld'), 'ycro_ipheld', 'believed restricted', 9, '2099-01-01', '203.0.113.7', '["sql.ro"]']);
    const [{ id: heldId }] = await q("SELECT id FROM readonly_api_keys WHERE label = 'believed restricted'");
    const conn = await pool.getConnection();
    try {
      let L = lines();
      expect(await script.runDrop(conn, { apply: false, log: L.log })).toEqual({ ok: true });
      expect(L.out).toContain(`  #${heldId} "believed restricted": "203.0.113.7"`);
      expect(L.out).toContain('Rows holding a value (never enforced): 1');
      expect(goLine(L.out)).toEqual(['GO — ONLY IF the D1 backend is already deployed (the pre-D1 backend writes this column). Next: node scripts/accessD1ParentKey.js --apply-drop']);
      expect(await script.ipAllowlistState(conn)).toBe('present');

      // a DROP that reports success but did not take is caught by the after-check
      const swallow = { query: (sql, p) => (/DROP COLUMN/.test(sql) ? Promise.resolve([{}]) : conn.query(sql, p)) };
      L = lines();
      expect(await script.runDrop(swallow, { apply: true, log: L.log })).toEqual({ ok: false });
      expect(goLine(L.out)).toEqual(['NO-GO — verify by hand.']);
      expect(L.out).toContain('DROP ran but the column is still there.');

      L = lines();
      expect(await script.runDrop(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)).toEqual(['GO — stage 2 applied; D1 is complete. Next: npm run db:ref']);
      expect(await q("SHOW COLUMNS FROM readonly_api_keys LIKE 'ip_allowlist'")).toEqual([]);
      expect(await script.run(conn, { apply: false, log: () => {} })).toEqual({ ok: true });     // stage 1 still GO

      L = lines();
      expect(await script.runDrop(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)[0]).toMatch(/^GO — stage 2 is already applied/);
    } finally { conn.release(); }
  });

  test('WITHOUT ip_allowlist: the pre-D1 SU mint breaks, the whole D1 flow works', async () => {
    await expect(q(OLD_INSERT, [hashKey('ycro_late'), 'ycro_late', 'old', 9, '2099-01-01', null, null]))
      .rejects.toThrow(/Unknown column 'ip_allowlist'/);
    expect((await suMint({ label: 'x', ipAllowlist: '1.2.3.4' })).status).toBe(400);
    const m = await suMint({ label: 'post-drop manager', scopes: ['sql.ro', 'scratch', 'alert', 'keys.mint'] });
    expect(m.status).toBe(200);
    const c = await mintChild(m.body.key, { scopes: ['scratch'] });
    expect(c.status).toBe(200);
    const p = await probe(c.body.key, 'scratch');
    expect(p.status).toBe(200);
    expect(p.body.auth).toMatchObject({ parentKeyId: m.body.id, scopes: ['scratch'] });
    expect((await hit('GET', '/api/readonly-keys/children', { key: m.body.key })).body.children.map(x => x.id)).toEqual([c.body.id]);
    const l = await hit('GET', '/api/readonly-keys?activeOnly=1', { su: true });
    expect(l.status).toBe(200);
    expect(l.body.keys.find(k => k.id === c.body.id)).toMatchObject({ parent_key_id: m.body.id });
    expect(l.body.keys.every(k => !('ip_allowlist' in k))).toBe(true);
    expect((await hit('DELETE', `/api/readonly-keys/children/${c.body.id}`, { key: m.body.key })).status).toBe(200);
    expect((await hit('DELETE', `/api/readonly-keys/${m.body.id}`, { su: true })).status).toBe(200);
    expect((await probe(m.body.key, 'sql.ro')).status).toBe(401);
  });

  // ── migration NO-GOs (last: they reshape the table) ───────────────────────

  test('NO-GO on a foreign shape or an orphan parent id; nothing altered', async () => {
    const conn = await pool.getConnection();
    try {
      // orphan: FK dropped, a row naming a missing parent
      await conn.query('ALTER TABLE readonly_api_keys DROP FOREIGN KEY fk_rok_parent');
      await conn.query('SET foreign_key_checks = 0');
      await conn.query(`INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at, parent_key_id)
                        VALUES (?, 'ycro_o', 'orphan', 6, '2099-01-01', 987654)`, [hashKey('ycro_orphan')]);
      await conn.query('SET foreign_key_checks = 1');
      let L = lines();
      expect(await script.run(conn, { apply: false, log: L.log })).toEqual({ ok: true });   // CHECK plans the FK
      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: false });
      expect(goLine(L.out)[0]).toMatch(/^NO-GO — verify by hand; nothing further was changed/);
      expect(L.out.join('\n')).toMatch(/1 row\(s\) name a parent_key_id that does not exist/);
      const [[ddl]] = await conn.query('SHOW CREATE TABLE readonly_api_keys');
      expect(ddl['Create Table']).not.toMatch(/fk_rok_parent/);
      // the orphan is the real one — fix it, and --apply resumes with only the FK
      expect(await probe('ycro_orphan', 'sql.ro')).toEqual({ status: 401, body: { error: "Readonly API key's parent key revoked" } });
      await conn.query("DELETE FROM readonly_api_keys WHERE label = 'orphan'");
      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(L.out.filter(l => l.startsWith('✓')).slice(0, 1)).toEqual(['✓ foreign key fk_rok_parent added (ON DELETE RESTRICT)']);

      // a column of another shape
      await conn.query('ALTER TABLE readonly_api_keys DROP FOREIGN KEY fk_rok_parent');
      await conn.query('ALTER TABLE readonly_api_keys MODIFY parent_key_id bigint NULL');
      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: false });
      expect(L.out.join('\n')).toMatch(/parent_key_id exists as bigint/);
      const [[col]] = await conn.query("SHOW COLUMNS FROM readonly_api_keys LIKE 'parent_key_id'");
      expect(col.Type).toBe('bigint');

      // an index of another shape
      await conn.query('ALTER TABLE readonly_api_keys MODIFY parent_key_id int NULL');
      await conn.query('ALTER TABLE readonly_api_keys DROP INDEX idx_rok_parent, ADD INDEX idx_rok_parent (parent_key_id)');
      L = lines();
      expect(await script.run(conn, { apply: false, log: L.log })).toEqual({ ok: false });
      expect(L.out.join('\n')).toMatch(/index idx_rok_parent exists as \(parent_key_id\)/);
    } finally {
      await conn.query('SET foreign_key_checks = 1').catch(() => {});
      conn.release();
    }
  });
});
