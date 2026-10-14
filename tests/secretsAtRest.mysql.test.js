// tests/secretsAtRest.mysql.test.js
//
/**
 * Secrets at rest on REAL MySQL — access-control B4
 * (scripts/accessB4SecretsAtRest.js through the real table shapes and the
 * real read paths).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_b4_test npx jest tests/secretsAtRest.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * credentials and hooks in it (production shapes, from ref/database.sql).
 *
 * WHAT IS LOCKED (what a fake db cannot prove)
 *   - The key guard: a local key that cannot decrypt the existing oauth2
 *     client_secret is a NO-GO before ANY write.
 *   - Base asserts: a plaintext secret on a row outside the verified id sets
 *     is a NO-GO with nothing written.
 *   - CHECK writes nothing; APPLY encrypts exactly the secret JSON values
 *     (credentials 10/12/14 $.key; hooks $.key / $.secret on the 8 ids), every
 *     other JSON key survives (compared key-order-insensitively — MySQL
 *     re-orders), and a re-run is a GO no-op.
 *   - The read paths on the migrated rows: credentialInjection
 *     .buildHeadersForCredential returns the plaintext header; hookService
 *     .getHookBySlug → authenticateRequest accepts a real key / a real
 *     Calendly-timestamped signature; a NEW hook written through
 *     hookService.createHook lands encrypted and verifies.
 */
'use strict';

const crypto = require('crypto');
const mysql = require('mysql2/promise');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('secrets at rest on real MySQL', () => {
  let pool, script, cc, hookService, credentialInjection;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const KEYS = { 10: 'quo-' + crypto.randomBytes(12).toString('hex'), 12: 'sk-claude-test', 14: 'aai-test-key' };
  const HOOKS = {
    5: ['api_key', { key: 'test-auth-key-17c', header: 'x-hook-key' }],
    21: ['api_key', { key: 'rc-in-' + 'a'.repeat(26), header: 'x-hook-key' }],
    22: ['api_key', { key: 'rc-out-' + 'b'.repeat(25), header: 'x-hook-key' }],
    23: ['api_key', { key: 'rc-call-' + 'c'.repeat(24), header: 'x-hook-key' }],
    32: ['hmac', { secret: 'cal-sched-' + 'd'.repeat(54), header: 'Calendly-Webhook-Signature', scheme: 'timestamped', algorithm: 'sha256', tolerance_seconds: 300 }],
    36: ['api_key', { key: 'clio-cmd-' + 'e'.repeat(43), header: 'x-clio-key' }],
    38: ['api_key', { key: 'abc123', header: 'x-hook-key' }],
    40: ['hmac', { secret: 'cal-cancel-' + 'f'.repeat(53), header: 'Calendly-Webhook-Signature', scheme: 'timestamped', algorithm: 'sha256', tolerance_seconds: 300 }],
  };
  const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => (a[k] = o[k], a), {}));
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});

  async function seed() {
    for (const t of ['credentials', 'hooks', 'hook_targets']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q(`CREATE TABLE hook_targets (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, hook_id int NOT NULL,
      credential_id int DEFAULT NULL, position int NOT NULL DEFAULT 0, active tinyint(1) NOT NULL DEFAULT 1) ENGINE=InnoDB`);
    await q(`CREATE TABLE credentials (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY, name varchar(255) NOT NULL,
      type enum('internal','bearer','api_key','basic','oauth2') NOT NULL DEFAULT 'internal',
      config json DEFAULT NULL, allowed_urls json DEFAULT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      access_token text, refresh_token text, access_token_expires_at datetime DEFAULT NULL,
      refresh_token_expires_at datetime DEFAULT NULL, last_refreshed_at datetime DEFAULT NULL,
      oauth_status enum('pending_auth','connected','refresh_failed','revoked') DEFAULT NULL,
      oauth_state varchar(64) DEFAULT NULL, oauth_pkce_verifier varchar(128) DEFAULT NULL,
      oauth_last_error text, oauth_last_error_at datetime DEFAULT NULL,
      refresh_failure_count tinyint unsigned NOT NULL DEFAULT '0', verbose tinyint(1) NOT NULL DEFAULT '0'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE hooks (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY, slug varchar(100) NOT NULL UNIQUE, name varchar(255) NOT NULL,
      description text, auth_type enum('none','api_key','hmac') NOT NULL DEFAULT 'none', auth_config json DEFAULT NULL,
      filter_mode enum('none','conditions','code') NOT NULL DEFAULT 'none', filter_config json DEFAULT NULL,
      transform_mode enum('passthrough','mapper','code') NOT NULL DEFAULT 'passthrough', transform_config json DEFAULT NULL,
      active tinyint(1) NOT NULL DEFAULT '1', version int NOT NULL DEFAULT '1', last_modified_by int DEFAULT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      capture_mode enum('off','capturing') NOT NULL DEFAULT 'off', captured_sample json DEFAULT NULL, captured_at datetime DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`INSERT INTO credentials (id, name, type, config) VALUES (1, 'YisraCase Internal', 'internal', NULL),
               (7, 'Clio', 'oauth2', ?)`, [JSON.stringify({ client_id: 'cid', client_secret: cc.encrypt('clio-client-secret'), scopes: 'a b' })]);
    for (const [id, key] of Object.entries(KEYS)) {
      await q(`INSERT INTO credentials (id, name, type, config, allowed_urls) VALUES (?, ?, 'api_key', ?, ?)`,
        [id, 'cred' + id, JSON.stringify({ key, header: id === '12' ? 'x-api-key' : 'Authorization' }), JSON.stringify([`https://api${id}.example.test/*`])]);
    }
    for (const [id, [type, cfg]] of Object.entries(HOOKS)) {
      await q(`INSERT INTO hooks (id, slug, name, auth_type, auth_config) VALUES (?, ?, ?, ?, ?)`, [id, 'hook-' + id, 'h' + id, type, JSON.stringify(cfg)]);
    }
    await q(`INSERT INTO hooks (id, slug, name, auth_type) VALUES (2, 'open-hook', 'open', 'none')`);
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    script = require('../scripts/accessB4SecretsAtRest');
    cc = require('../lib/credentialCrypto');
    hookService = require('../services/hookService');
    credentialInjection = require('../lib/credentialInjection');
  });
  afterAll(async () => { if (pool) await pool.end(); });
  afterEach(() => jest.restoreAllMocks());

  const snapshot = async () => ({
    creds: await q('SELECT id, config FROM credentials ORDER BY id'),
    hooks: await q('SELECT id, auth_config FROM hooks ORDER BY id'),
  });

  test('NO-GO before any write when the local key cannot decrypt the existing oauth2 secret', async () => {
    quiet();
    await seed();
    // replace the oauth2 client_secret with one encrypted under ANOTHER key
    const other = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', other, iv);
    const ct = Buffer.concat([c.update('x', 'utf8'), c.final()]);
    const foreign = 'ENCv1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    await q("UPDATE credentials SET config = JSON_SET(config, '$.client_secret', ?) WHERE id = 7", [foreign]);
    const before = await snapshot();
    const conn = await pool.getConnection();
    try { expect(await script.run(conn, { apply: true })).toEqual({ ok: false }); } finally { conn.release(); }
    expect(await snapshot()).toEqual(before);
  });

  test('NO-GO with nothing written when a plaintext secret sits on an unexpected row', async () => {
    quiet();
    await seed();
    await q(`INSERT INTO hooks (id, slug, name, auth_type, auth_config) VALUES (99, 'stray', 'stray', 'api_key', ?)`, [JSON.stringify({ key: 'stray-key' })]);
    const before = await snapshot();
    const conn = await pool.getConnection();
    try { expect(await script.run(conn, { apply: true })).toEqual({ ok: false }); } finally { conn.release(); }
    expect(await snapshot()).toEqual(before);
  });

  test('CHECK writes nothing; APPLY encrypts exactly the secrets; re-run is a no-op', async () => {
    quiet();
    await seed();
    const before = await snapshot();
    const conn = await pool.getConnection();
    try {
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
      expect(await snapshot()).toEqual(before);
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      const mid = await snapshot();
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      expect(await snapshot()).toEqual(mid);                  // no-op: ciphertexts unchanged
    } finally { conn.release(); }

    for (const [id, key] of Object.entries(KEYS)) {
      const [r] = await q('SELECT config FROM credentials WHERE id = ?', [id]);
      expect(cc.isEncrypted(r.config.key)).toBe(true);
      expect(cc.decrypt(r.config.key)).toBe(key);
      expect(r.config.header).toBe(id === '12' ? 'x-api-key' : 'Authorization');
    }
    for (const [id, [type, cfg]] of Object.entries(HOOKS)) {
      const [r] = await q('SELECT auth_config FROM hooks WHERE id = ?', [id]);
      const f = type === 'hmac' ? 'secret' : 'key';
      expect(cc.decrypt(r.auth_config[f])).toBe(cfg[f]);
      expect(canon({ ...r.auth_config, [f]: null })).toBe(canon({ ...cfg, [f]: null }));
    }
    const [oauth] = await q('SELECT config FROM credentials WHERE id = 7');
    expect(cc.decrypt(oauth.config.client_secret)).toBe('clio-client-secret');   // untouched, still readable
  });

  test('the real read paths work on the migrated rows', async () => {
    // credentials: the async chokepoint every caller uses
    for (const [id, key] of Object.entries(KEYS)) {
      const h = await credentialInjection.buildHeadersForCredential(pool, Number(id), `https://api${id}.example.test/v2/x`);
      expect(h[id === '12' ? 'x-api-key' : 'Authorization']).toBe(key);
    }
    // hooks: the receiver's own lookup, then verify
    const h21 = await hookService.getHookBySlug(pool, 'hook-21');
    expect(cc.isEncrypted(h21.auth_config.key)).toBe(true);
    expect(hookService.authenticateRequest(h21, { headers: { 'x-hook-key': HOOKS[21][1].key } }).valid).toBe(true);
    expect(hookService.authenticateRequest(h21, { headers: { 'x-hook-key': h21.auth_config.key } }).valid).toBe(false);

    const h32 = await hookService.getHookBySlug(pool, 'hook-32');
    const body = Buffer.from('{"event":"invitee.created"}');
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = crypto.createHmac('sha256', HOOKS[32][1].secret).update(t + '.').update(body).digest('hex');
    expect(hookService.authenticateRequest(h32, { headers: { 'calendly-webhook-signature': `t=${t},v1=${v1}` }, rawBodyBuf: body }).valid).toBe(true);
  });

  test('a hook created after the migration lands encrypted and verifies', async () => {
    const id = await hookService.createHook(pool, { slug: 'new-hook', name: 'new', auth_type: 'api_key', auth_config: { key: 'fresh-key', header: 'x-hook-key' } });
    const [r] = await q('SELECT auth_config FROM hooks WHERE id = ?', [id]);
    expect(cc.isEncrypted(r.auth_config.key)).toBe(true);
    const h = await hookService.getHookBySlug(pool, 'new-hook');
    expect(hookService.authenticateRequest(h, { headers: { 'x-hook-key': 'fresh-key' } }).valid).toBe(true);
  });
});
