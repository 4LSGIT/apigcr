// tests/sensitiveTier.mysql.test.js
//
/**
 * SEC-3 on REAL MySQL (scripts/accessSec3SensitiveTier.js +
 * routes/api.readonly.js's readonly_query_log INSERT).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_sec3_test npx jest tests/sensitiveTier.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * ai_calls, readonly_query_log, readonly_api_keys and the ai_spend view in it
 * (the live DDL's columns, keys and the FK), and creates + drops a MySQL user
 * `sec3_noview` on the server.
 *
 * WHAT IS LOCKED (what a scripted conn cannot prove)
 *   - The migration: CHECK → GO with a plan and nothing changed; APPLY adds
 *     readonly_query_log.sensitive_key with ALGORITHM=INSTANT (accepted by the
 *     engine on the FK'd table; INNODB_TABLES.TOTAL_ROW_VERSIONS proves no
 *     rebuild) and creates ai_spend; a re-run is a no-op GO.
 *   - ai_spend on the engine: exactly the 13 metadata columns, SQL SECURITY
 *     INVOKER, rows readable, no content column.
 *   - Shapes it refuses: a `sensitive_key` column of another type, an ai_spend
 *     that is a TABLE, a view over the wrong columns — NO-GO, unaltered.
 *   - An account without CREATE VIEW gets a NO-GO at CHECK, nothing changed.
 *   - DEPLOY ORDER, proven: the SEC-3 endpoint's log INSERT FAILS before the
 *     migration and lands (sensitive_key = 1 / 0) after it; the pre-SEC-3 INSERT
 *     (no `sensitive_key` column) still lands after it — the old backend is safe.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec3-mysql-test-secret';

const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../startup/dbReadonly', () => ({
  getConnection: async () => ({
    query: async (sql) => (/^SET SESSION/.test(sql) ? [{}] : [[{ n: 1 }], [{ name: 'n', columnType: 8 }]]),
    release() {},
  }),
}));

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('SEC-3 on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const script = require('../scripts/accessSec3SensitiveTier');
  const silent = () => {};
  const lines = () => { const out = []; return { out, log: (s) => out.push(String(s)) }; };
  const goLine = (out) => out.map(l => l.trim()).filter(l => /^(GO|NO-GO)\b/.test(l));

  async function fresh() {
    await q('DROP VIEW IF EXISTS ai_spend');
    await q('DROP TABLE IF EXISTS ai_spend');
    await q('DROP TABLE IF EXISTS readonly_query_log');
    await q('DROP TABLE IF EXISTS readonly_api_keys');
    await q('DROP TABLE IF EXISTS ai_calls');
    await q(`CREATE TABLE ai_calls (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      created_at datetime DEFAULT CURRENT_TIMESTAMP,
      prompt_key varchar(64) DEFAULT NULL, prompt_version varchar(32) DEFAULT NULL, model varchar(64) DEFAULT NULL,
      mode enum('sync','async') DEFAULT 'sync', output_type enum('text','json','html') DEFAULT 'text',
      consumer_ref varchar(128) DEFAULT NULL, status enum('ok','error','timeout') NOT NULL, error text,
      input_tokens int DEFAULT NULL, output_tokens int DEFAULT NULL, cost_cents decimal(10,4) DEFAULT NULL,
      latency_ms int DEFAULT NULL, request_excerpt text, response mediumtext,
      KEY idx_ai_calls_consumer_ref (consumer_ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE readonly_api_keys (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, label varchar(255)) ENGINE=InnoDB`);
    await q(`CREATE TABLE readonly_query_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
      api_key_id int NOT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip varchar(45) DEFAULT NULL, user_agent varchar(512) DEFAULT NULL,
      sql_text mediumtext NOT NULL, params_json json DEFAULT NULL,
      row_count int DEFAULT NULL, duration_ms int DEFAULT NULL,
      status varchar(40) NOT NULL, error_text text,
      KEY idx_key_time (api_key_id, created_at),
      CONSTRAINT fk_rqlog_key FOREIGN KEY (api_key_id) REFERENCES readonly_api_keys (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`INSERT INTO readonly_api_keys (id, label) VALUES (91, 'ordinary'), (92, 'sensitive')`);
    await q(`INSERT INTO ai_calls (prompt_key, model, status, error, input_tokens, cost_cents, request_excerpt, response)
             VALUES ('court_extract', 'claude', 'ok', 'FAKEerr', 10, 1.5, 'FAKEexcerpt', 'FAKEresponse')`);
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
  });
  afterAll(async () => {
    if (pool) {
      await q("DROP USER IF EXISTS 'sec3_noview'@'%'").catch(() => {});
      await pool.end();
    }
  });

  // The SEC-3 endpoint, its log INSERT going to the real table (key auth scripted).
  async function endpointLog(scopes, sql) {
    const errors = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    const db = {
      query: async (s, params) => {
        if (/FROM readonly_api_keys/.test(s)) {
          return [[{ id: (scopes || []).includes('sql.ro.sensitive') ? 92 : 91, label: 'k', expires_at: new Date(Date.now() + 3600e3), revoked_at: null, scopes }]];
        }
        if (/UPDATE readonly_api_keys/.test(s) || /admin_audit_log/.test(s)) return [{}];
        return pool.query(s, params);   // readonly_query_log → the engine
      },
    };
    const router = require('../routes/api.readonly');
    const app = express();
    app.use(express.json());
    app.use((req, _r, next) => { req.db = db; next(); });
    app.use(router);
    const status = await new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const body = JSON.stringify({ sql });
        const r = http.request({ port: server.address().port, path: '/api/readonly/sql', method: 'POST',
          headers: { 'x-readonly-api-key': 'ycro_t', 'content-type': 'application/json' } }, (res) => {
          res.resume(); res.on('end', () => { server.close(); resolve(res.statusCode); });
        });
        r.on('error', (e) => { server.close(); reject(e); });
        r.end(body);
      });
    });
    await new Promise(r => setTimeout(r, 50));   // the fire-and-forget INSERT
    spy.mockRestore();
    return { status, errors };
  }

  test('CHECK → APPLY → re-run; the view on the engine; deploy order proven', async () => {
    await fresh();
    const conn = await pool.getConnection();
    try {
      // before: the SEC-3 INSERT fails (no column) — the query still answers
      const pre = await endpointLog(['sql.ro', 'sql.ro.sensitive'], 'SELECT 1 FROM ai_calls');
      expect(pre.status).toBe(200);
      expect(pre.errors.join('\n')).toMatch(/query-log insert failed: Unknown column 'sensitive_key'/);
      expect((await q('SELECT COUNT(*) n FROM readonly_query_log'))[0].n).toBe(0);

      const c = lines();
      expect(await script.run(conn, { apply: false, log: c.log })).toEqual({ ok: true });
      expect(goLine(c.out)).toEqual(['GO — base state matches. Next: node scripts/accessSec3SensitiveTier.js --apply']);
      expect(c.out.join('\n')).toContain(script.ALTER_SQL);
      expect(c.out.join('\n')).toContain(script.VIEW_SQL);
      expect((await q("SHOW COLUMNS FROM readonly_query_log LIKE 'sensitive_key'"))).toHaveLength(0);   // CHECK wrote nothing
      expect((await q("SHOW FULL TABLES LIKE 'ai_spend'"))).toHaveLength(0);

      const a = lines();
      expect(await script.run(conn, { apply: true, log: a.log })).toEqual({ ok: true });
      expect(goLine(a.out)).toEqual([expect.stringMatching(/^GO — migration applied/)]);
      const r = lines();
      expect(await script.run(conn, { apply: true, log: r.log })).toEqual({ ok: true });
      expect(goLine(r.out)).toEqual([expect.stringMatching(/^GO — the migration is already applied/)]);
    } finally {
      conn.release();
    }

    // the column
    const [col] = await q(`SELECT LOWER(COLUMN_TYPE) t, IS_NULLABLE n, COLUMN_DEFAULT d, COLUMN_COMMENT c
                             FROM information_schema.columns WHERE table_schema = DATABASE()
                              AND table_name = 'readonly_query_log' AND column_name = 'sensitive_key'`);
    expect(col).toEqual({ t: 'tinyint(1)', n: 'NO', d: '0', c: '1 = the session key held sql.ro.sensitive (access SEC-3)' });
    // added INSTANT (a row version, no table copy): a rebuild would leave 0
    const dbName = new URL(URL_).pathname.slice(1);
    const [iv] = await q('SELECT TOTAL_ROW_VERSIONS v FROM information_schema.INNODB_TABLES WHERE NAME = ?', [`${dbName}/readonly_query_log`]);
    expect(iv.v).toBeGreaterThan(0);

    // the view
    const [v] = await q(`SELECT SECURITY_TYPE s FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = 'ai_spend'`);
    expect(v.s).toBe('INVOKER');
    const rows = await q('SELECT * FROM ai_spend');
    expect(Object.keys(rows[0])).toEqual(script.SPEND_COLUMNS);
    expect(rows[0]).toMatchObject({ prompt_key: 'court_extract', model: 'claude', status: 'ok', input_tokens: 10 });
    expect(JSON.stringify(rows)).not.toMatch(/FAKE(err|excerpt|response)/);

    // after: the SEC-3 INSERT lands, flagged per key; the pre-SEC-3 INSERT still lands
    const post = await endpointLog(['sql.ro', 'sql.ro.sensitive'], 'SELECT 1 FROM ai_calls');
    expect(post.errors).toEqual([]);
    const ord = await endpointLog(['sql.ro'], 'SELECT 1 FROM ai_calls');
    expect(ord.status).toBe(403);
    await q(`INSERT INTO readonly_query_log (api_key_id, ip, user_agent, sql_text, params_json, row_count, duration_ms, status, error_text)
             VALUES (91, NULL, 'old-backend', 'SELECT 1', NULL, 1, 1, 'success', NULL)`);
    const log = await q('SELECT api_key_id, status, sensitive_key, user_agent FROM readonly_query_log ORDER BY id');
    expect(log.map(l => [l.api_key_id, l.status, l.sensitive_key])).toEqual([
      [92, 'success', 1],
      [91, 'rejected_sensitive_table', 0],
      [91, 'success', 0],                       // the old INSERT: the column defaults to 0
    ]);
  });

  test('refused shapes: NO-GO, nothing altered', async () => {
    const cases = [
      ['a `sensitive_key` column of another type', async () => q('ALTER TABLE readonly_query_log ADD COLUMN sensitive_key varchar(5) NULL'),
        /readonly_query_log\.sensitive_key exists as varchar\(5\)/],
      ['ai_spend is a TABLE', async () => q('CREATE TABLE ai_spend (id int)'), /ai_spend exists as a BASE TABLE/],
      ['ai_spend over the wrong columns', async () => q('CREATE SQL SECURITY INVOKER VIEW ai_spend AS SELECT id, response FROM ai_calls'),
        /ai_spend exposes \[id, response\]/],
      ['ai_spend as SQL SECURITY DEFINER', async () => q(`CREATE SQL SECURITY DEFINER VIEW ai_spend AS SELECT ${script.SPEND_COLUMNS.join(', ')} FROM ai_calls`),
        /ai_spend is SQL SECURITY DEFINER, expected INVOKER/],
    ];
    for (const [name, plant, want] of cases) {
      await fresh();
      await plant();
      const before = JSON.stringify(await q("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY TABLE_NAME"));
      const conn = await pool.getConnection();
      try {
        const o = lines();
        expect([name, await script.run(conn, { apply: true, log: o.log })]).toEqual([name, { ok: false }]);
        expect(o.out.join('\n')).toMatch(want);
        expect(goLine(o.out)).toEqual([expect.stringMatching(/^NO-GO — re-verify by hand/)]);
      } finally {
        conn.release();
      }
      expect(JSON.stringify(await q("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY TABLE_NAME"))).toBe(before);
    }
  });

  test('an account without CREATE VIEW: NO-GO at CHECK, nothing changed', async () => {
    await fresh();
    const dbName = new URL(URL_).pathname.slice(1);
    await q("DROP USER IF EXISTS 'sec3_noview'@'%'");
    await q("CREATE USER 'sec3_noview'@'%' IDENTIFIED BY 'FAKEpw-sec3'");   // secret-scan: allow
    await q(`GRANT SELECT, INSERT, UPDATE, ALTER ON \`${dbName}\`.* TO 'sec3_noview'@'%'`);
    const u = new URL(URL_);
    const conn = await mysql.createConnection({ host: u.hostname, port: Number(u.port), user: 'sec3_noview', password: 'FAKEpw-sec3', database: dbName });   // secret-scan: allow
    try {
      expect(await script.canCreateView(conn)).toBe(false);
      for (const apply of [false, true]) {
        const o = lines();
        expect(await script.run(conn, { apply, log: o.log })).toEqual({ ok: false });
        expect(goLine(o.out)).toEqual(['NO-GO — run as an account that holds it. Nothing was changed.']);
      }
    } finally {
      await conn.end();
    }
    expect(await q("SHOW COLUMNS FROM readonly_query_log LIKE 'sensitive_key'")).toHaveLength(0);
    // root holds it
    const rc = await pool.getConnection();
    try { expect(await script.canCreateView(rc)).toBe(true); } finally { rc.release(); }
  });
});
