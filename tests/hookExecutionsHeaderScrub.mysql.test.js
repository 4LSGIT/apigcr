// tests/hookExecutionsHeaderScrub.mysql.test.js
//
/**
 * The hook credential-header history scrub on REAL MySQL
 * (scripts/hookExecutionsHeaderScrub.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_hookscrub_test npx jest tests/hookExecutionsHeaderScrub.mysql.test.js --runInBand
 * The database name must end in _test. Self-building: it drops and rebuilds
 * hooks, hook_executions and hook_delivery_logs from ref/database.sql (the
 * scrub reads no column T2 or later slices add, so the dump's shape is fine).
 *
 * WHAT IS LOCKED
 *   - CHECK counts per hook · column · header name and writes nothing.
 *   - APPLY removes the names from raw_input / transform_output /
 *     request_body / captured_sample in ANY stored case and at any depth under
 *     a `headers` object, across more than one batch; a full re-scan is 0.
 *   - Everything else is untouched byte-for-byte in meaning: other headers,
 *     a body field named `authorization`, a 20-digit number (JSON_REMOVE on
 *     the stored document — no JS re-serialization), SQL NULLs.
 *   - A re-run rewrites nothing.
 */

'use strict';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const S = require('../scripts/hookExecutionsHeaderScrub');
const TOKEN = 'FAKEtoken-canary-91a'; // test literal only — secret-scan: allow
const TABLES = ['hooks', 'hook_executions', 'hook_delivery_logs', 'workflow_executions', 'workflows', 'sequence_enrollments'];

maybe('hook credential-header scrub on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const quiet = { log: (l) => lines.push(l) };
  const N_RC = 1205;   // > BATCH: crosses batches

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await q('SET FOREIGN_KEY_CHECKS = 0');
    await schema.build(pool, TABLES);
    for (const t of ['hooks', 'hook_executions', 'hook_delivery_logs']) await q(`ALTER TABLE ${t} MODIFY id ${t === 'hooks' ? 'int' : 'bigint'} NOT NULL AUTO_INCREMENT`).catch(() => {});
    await q(`INSERT INTO hooks (id, slug, name, auth_type, auth_config, captured_sample) VALUES
      (21, 'rc-call', 'RC', 'api_key', '{"header":"Verification-Token","key":"x"}', ?),
      (36, 'clio-command', 'Clio', 'api_key', '{"header":"x-hook-key","key":"x"}', NULL),
      (40, 'cal-cancel', 'Cal', 'hmac', '{"header":"calendly-webhook-signature","secret":"x"}', NULL),
      (50, 'open', 'Open', 'none', NULL, NULL),
      (1, '_catchall', 'Catch-all', 'none', NULL, NULL),
      (60, 'old-hook', 'Inactive', 'api_key', '{"header":"X-Old-Hook-Secret","key":"x"}', NULL)`,
      [JSON.stringify({ body: { a: 1 }, headers: { 'verification-token': TOKEN, 'user-agent': 'RC' } })]);
    // rc-call: lowercase keys as the receiver stores them, many rows
    const rc = [];
    for (let i = 0; i < N_RC; i++) rc.push([21, 'rc-call', JSON.stringify({ body: { uuid: `u${i}` }, headers: { 'verification-token': TOKEN, 'content-type': 'application/json' } })]);
    await q('INSERT INTO hook_executions (hook_id, slug, raw_input) VALUES ?', [rc]);
    // mixed case (a pasted live test), a big number, a body field named authorization, transform_output
    await q(`INSERT INTO hook_executions (id, hook_id, slug, raw_input, transform_output) VALUES
      (5001, 36, 'clio-command', '{"body":{"n":12345678901234567890,"authorization":"business-field"},"headers":{"X-Hook-Key":"${TOKEN}","Verification-Token":"${TOKEN}","Keep":"yes"}}',
                                 '{"body":{"x":1},"headers":{"x-hook-key":"${TOKEN}","keep":"yes"}}'),
      (5002, 40, 'cal-cancel', '{"body":{},"headers":{"Calendly-Webhook-Signature":"t=1,v1=${TOKEN}"}}', NULL),
      (5003, 50, 'open', '{"body":{},"headers":{"x-signature":"${TOKEN}","accept":"*/*"}}', NULL),
      (5004, 99, 'deleted-hook', '{"body":{},"headers":{"cookie":"${TOKEN}","x-forwarded-for":"1.2.3.4"}}', NULL),
      (5005, 50, 'open', '{"body":{},"headers":{"accept":"*/*"}}', NULL),
      (5006, 50, 'open', NULL, NULL),
      (5007, 1, 'old-hook', '{"body":{},"headers":{"x-old-hook-secret":"${TOKEN}","accept":"*/*"}}', NULL)`);
    // copies of a target's input (no hook id on these rows: the union applies)
    await q(`INSERT INTO workflow_executions (id, workflow_id, status, init_data, variables) VALUES
      (1, 3, 'completed', '{"body":{"a":1},"headers":{"x-hook-key":"${TOKEN}","keep":"yes"}}', '{"body":{"a":1},"headers":{"X-Old-Hook-Secret":"${TOKEN}"},"step_var":"v"}'),
      (2, 3, 'completed', '{"x":1}', '{"x":1}')`);
    await q(`INSERT INTO workflows (id, name, captured_input, test_input) VALUES
      (3, 'wf', '{"headers":{"verification-token":"${TOKEN}","keep":"yes"}}', '{"input":{"headers":{"Calendly-Webhook-Signature":"${TOKEN}"}}}')`);
    await q(`INSERT INTO sequence_enrollments (id, template_id, contact_id, trigger_data) VALUES
      (1, 1, 1, '{"headers":{"cookie":"${TOKEN}","keep":"yes"},"appt_id":9}')`);
    await q(`INSERT INTO hook_delivery_logs (id, execution_id, target_id, request_body, status) VALUES
      (1, 5001, 7, '{"function":"f","params":{"input":{"headers":{"X-Hook-Key":"${TOKEN}","keep":"yes"},"body":{}}}}', 'success'),
      (2, 5005, 7, '{"function":"f","params":{"input":{"headers":{"accept":"*/*"}}}}', 'success')`);
    conn = await pool.getConnection();
  });
  afterAll(async () => {
    if (conn) conn.release();
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS ${t}`);
    await pool.end();
  });

  const tokenCells = async () => (await q(`SELECT
      (SELECT COUNT(*) FROM hook_executions WHERE CAST(raw_input AS CHAR) LIKE ? OR CAST(transform_output AS CHAR) LIKE ?) e,
      (SELECT COUNT(*) FROM hook_delivery_logs WHERE CAST(request_body AS CHAR) LIKE ?) d,
      (SELECT COUNT(*) FROM hooks WHERE CAST(captured_sample AS CHAR) LIKE ?) h,
      (SELECT COUNT(*) FROM workflow_executions WHERE CAST(init_data AS CHAR) LIKE ? OR CAST(variables AS CHAR) LIKE ?) w,
      (SELECT COUNT(*) FROM workflows WHERE CAST(captured_input AS CHAR) LIKE ? OR CAST(test_input AS CHAR) LIKE ?) f,
      (SELECT COUNT(*) FROM sequence_enrollments WHERE CAST(trigger_data AS CHAR) LIKE ?) s`, Array(9).fill(`%${TOKEN}%`)))[0];

  test('CHECK: per hook · column · name counts; nothing written', async () => {
    const before = await tokenCells();
    const r = await S.run(conn, quiet);
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^CHECK OK — \d+ stored credential header\(s\) in \d+ scanned row\(s\)\. GO .*Next: node scripts\/hookExecutionsHeaderScrub\.js --apply$/);
    expect(r.counts).toEqual({
      'rc-call · raw_input · verification-token': N_RC,
      'rc-call · captured_sample · verification-token': 1,
      'clio-command · raw_input · x-hook-key': 1,
      'clio-command · raw_input · verification-token': 1,
      'clio-command · transform_output · x-hook-key': 1,
      'clio-command · request_body · x-hook-key': 1,
      'cal-cancel · raw_input · calendly-webhook-signature': 1,
      'open · raw_input · x-signature': 1,
      '(hook 99) · raw_input · cookie': 1,
      '_catchall · raw_input · x-old-hook-secret': 1,
      '(workflow_executions) · init_data · x-hook-key': 1,
      '(workflow_executions) · variables · x-old-hook-secret': 1,
      '(workflows) · captured_input · verification-token': 1,
      '(workflows) · test_input · calendly-webhook-signature': 1,
      '(sequence_enrollments) · trigger_data · cookie': 1,
    });
    expect(await tokenCells()).toEqual(before);
    // the caution sits directly above the workflow_executions.variables count
    const out = lines.join('\n').split('\n');
    const at = out.indexOf('  (workflow_executions) · variables · x-old-hook-secret: 1');
    expect(at).toBeGreaterThan(0);
    expect(out[at - 1]).toBe(`  ! ${S.VARIABLES_CAUTION}`);
  });

  test('APPLY: every stored token gone, every other byte of meaning kept; a re-run rewrites nothing', async () => {
    const r = await S.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true });
    expect(r.line).toMatch(/^APPLIED — rewrote \d+ cell\(s\); a full re-scan finds 0 stored credential headers\. GO\.$/);
    expect(await tokenCells()).toEqual({ e: 0, d: 0, h: 0, w: 0, f: 0, s: 0 });
    expect((await q('SELECT init_data, variables FROM workflow_executions WHERE id = 1'))[0]).toEqual({
      init_data: { body: { a: 1 }, headers: { keep: 'yes' } }, variables: { body: { a: 1 }, headers: {}, step_var: 'v' } });
    expect((await q('SELECT trigger_data FROM sequence_enrollments WHERE id = 1'))[0].trigger_data).toEqual({ headers: { keep: 'yes' }, appt_id: 9 });
    expect((await q('SELECT raw_input FROM hook_executions WHERE id = 5007'))[0].raw_input.headers).toEqual({ accept: '*/*' });
    const [x] = await q('SELECT raw_input, transform_output, CAST(raw_input AS CHAR) AS raw_txt FROM hook_executions WHERE id = 5001');
    expect(x.raw_input.headers).toEqual({ Keep: 'yes' });
    expect(x.raw_input.body.authorization).toBe('business-field');
    expect(x.raw_txt).toContain('12345678901234567890');          // no JS round trip
    expect(x.transform_output).toEqual({ body: { x: 1 }, headers: { keep: 'yes' } });
    expect((await q('SELECT raw_input FROM hook_executions WHERE id = 5004'))[0].raw_input.headers).toEqual({ 'x-forwarded-for': '1.2.3.4' });
    expect((await q('SELECT raw_input FROM hook_executions WHERE id = 5005'))[0].raw_input.headers).toEqual({ accept: '*/*' });
    expect((await q('SELECT raw_input FROM hook_executions WHERE id = 5006'))[0].raw_input).toBeNull();
    expect((await q('SELECT raw_input FROM hook_executions WHERE hook_id = 21 ORDER BY id LIMIT 1'))[0].raw_input.headers).toEqual({ 'content-type': 'application/json' });
    expect((await q('SELECT request_body FROM hook_delivery_logs WHERE id = 1'))[0].request_body.params.input.headers).toEqual({ keep: 'yes' });
    expect((await q('SELECT captured_sample FROM hooks WHERE id = 21'))[0].captured_sample.headers).toEqual({ 'user-agent': 'RC' });

    lines.length = 0;
    const again = await S.run(conn, { ...quiet, apply: true });
    expect(again.line).toBe('APPLIED — rewrote 0 cell(s); a full re-scan finds 0 stored credential headers. GO.');
    expect((await S.run(conn, quiet)).line).toBe('CHECK OK — no stored credential header. GO (nothing to do).');
  });

  test('the session settings hold on the connection after a run', async () => {
    await conn.query("SET SESSION lock_wait_timeout = 99, innodb_lock_wait_timeout = 99, time_zone = '-05:00'");
    await S.run(conn, quiet);
    const [[s]] = await conn.query('SELECT @@session.lock_wait_timeout AS lwt, @@session.innodb_lock_wait_timeout AS ilwt, @@session.time_zone AS tz');
    expect(s).toEqual({ lwt: 10, ilwt: 10, tz: '+00:00' });
  });

  // The two verify gates, each forced to see a leftover.
  const reseed = () => q(`INSERT INTO hook_executions (hook_id, slug, raw_input) VALUES (21, 'rc-call', ?)`,
    [JSON.stringify({ body: {}, headers: { 'verification-token': TOKEN } })]);
  /** The real connection with one statement intercepted. */
  const wrapped = (intercept) => ({ query: (sql, p) => intercept(sql, p) || conn.query(sql, p) });

  test('per-batch gate: an UPDATE that silently changes nothing → NO-GO naming the table', async () => {
    await reseed();
    const fake = wrapped((sql) => (/^UPDATE hook_executions SET raw_input/.test(sql) ? Promise.resolve([{ affectedRows: 0 }]) : null));
    const r = await S.run(fake, { ...quiet, apply: true });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — hook_executions: 1 cell\(s\) after id \d+ still hold a credential header after the rewrite\. Batches before it are done; re-run --apply/);
  });

  test('final gate: a token written behind the scan (an old receiver still running) → NO-GO after the full re-scan', async () => {
    let injected = false;
    const fake = wrapped((sql, p) => {
      if (!injected && /^UPDATE hooks SET captured_sample/.test(sql)) {
        injected = true;
        return (async () => { await reseed(); return conn.query(sql, p); })();
      }
      return null;
    });
    await q(`UPDATE hooks SET captured_sample = ? WHERE id = 21`, [JSON.stringify({ headers: { 'verification-token': TOKEN } })]);
    const r = await S.run(fake, { ...quiet, apply: true });
    expect(injected).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.line).toBe('NO-GO — 1 credential header(s) remain after the rewrite (above). Re-run --apply; if it persists, paste this to Claude.');
    expect(lines).toContain('  ✗ still: rc-call · raw_input · verification-token: 1');
    // and a plain re-run cleans it
    expect((await S.run(conn, { ...quiet, apply: true })).ok).toBe(true);
  });
});
