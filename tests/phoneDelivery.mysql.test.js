/**
 * REAL-ENGINE TWIN of the phone-delivery S1 suite (tests/phoneDelivery.test.js
 * pins the same decisions over a scripted db in CI): the migration script on a
 * real MySQL 8 (fresh apply, idempotent re-run, resume-at-the-index), and
 * runSync's actual SQL — the (provider, provider_ref) lookup, the stamp
 * UPDATE, the churn-free second run, the terminal guard, and a backfill run's
 * executions metadata — through the REAL phoneIngestService / logService /
 * suppression / rules chain over the production schema (only the provider
 * adapter is a fixture, and settings come from a seeded app_settings row).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test (the suite deletes rows in
 * phone_event_log, phone_lines, log, phone_ingest_executions, app_settings):
 *   mysql -uroot -e "CREATE DATABASE yc_phdel_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_phdel_test < ref/database.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_phdel_test npx jest --runInBand tests/phoneDelivery.mysql.test.js
 * The migration script runs INSIDE the suite (and again, asserting
 * idempotence), so the suite is green whether or not ref/database.sql already
 * carries the delivery columns (it will after the live apply + next commit).
 * One fresh database per run (the gated-suite protocol in
 * tests/mailboxS2.mysql.test.js).
 */
'use strict';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('phone-delivery S1 on real MySQL', () => {
  jest.setTimeout(60_000);
  const mysql = require('mysql2/promise');
  const migration = require('../scripts/phoneDeliveryS1DeliveryColumns');
  const svc = require('../services/phoneDeliveryService');
  const phoneService = require('../services/phoneService');
  const { resetFirmNumberCache } = require('../services/phoneIngestService');

  let pool;
  let getAdapterSpy;

  const REC = (over = {}) => ({
    provider: 'ringcentral', provider_ref: 'twin-1',
    from: '2485592400', to: '2482405969', body: 'twin text',
    ts: '2026-10-20T10:00:00.000Z', conversation_id: 'conv-1', attachments: [],
    delivery: { state: 'sent', reason: null, provider_code: null },
    ...over,
  });

  function arm(recordsByPage) {
    const adapter = {
      capabilities: { sms: true, mms: true, outboundSync: true },
      async listOutbound(_db, { page }) {
        const records = recordsByPage[page - 1] || [];
        return { status: 200, records, page, totalPages: recordsByPage.length || 1, rate: {}, errorText: null };
      },
    };
    getAdapterSpy = jest.spyOn(phoneService, 'getAdapter')
      .mockImplementation(p => (p === 'ringcentral' ? adapter : null));
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1))) throw new Error('refusing: database name must end in _test');
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.slice(1),
      timezone: 'Z', connectionLimit: 4, multipleStatements: false,
      charset: 'utf8mb4_general_ci',
    });
    await pool.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);

    // ── the migration: fresh apply (or already applied via a newer dump), then idempotent re-run
    const conn = await pool.getConnection();
    try {
      const first = await migration.run(conn, { apply: true, log: () => {} });
      expect(['applied-now', 'applied']).toContain(first.state);
      expect(first.ok).toBe(true);
      const again = await migration.run(conn, { apply: true, log: () => {} });
      expect([again.ok, again.state]).toEqual([true, 'applied']);

      // resume path: drop only the index, run again → index re-added, columns untouched
      await conn.query('ALTER TABLE phone_event_log DROP INDEX idx_phone_event_delivery');
      const resumed = await migration.run(conn, { apply: true, log: () => {} });
      expect([resumed.ok, resumed.state]).toEqual([true, 'applied-now']);
    } finally {
      conn.release();
    }

    // ── seed: the enabled setting and one active RC line
    await pool.query(`DELETE FROM app_settings WHERE \`key\` = ?`, [svc.ENABLED_KEY]);
    await pool.query('INSERT INTO app_settings (`key`, `value`) VALUES (?, ?)', [svc.ENABLED_KEY, '1']);
    await pool.query(`DELETE FROM phone_lines WHERE phone_number IN ('2485592400')`);
    await pool.query(
      `INSERT INTO phone_lines (phone_number, provider, active, credential_id) VALUES ('2485592400', 'ringcentral', 1, 9)`
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    resetFirmNumberCache();
    await pool.query(`DELETE FROM phone_ingest_executions`);
    await pool.query(`DELETE FROM phone_event_log WHERE provider_ref LIKE 'twin-%'`);
    await pool.query(`DELETE FROM log WHERE log_type = 'sms' AND log_to = '2482405969'`);
  });

  afterEach(() => { if (getAdapterSpy) getAdapterSpy.mockRestore(); });

  async function eventRow(ref) {
    const [[row]] = await pool.query(
      `SELECT * FROM phone_event_log WHERE provider = 'ringcentral' AND provider_ref = ?`, [ref]);
    return row || null;
  }

  test('unknown ref: ingested through the REAL chain, stamped, and the log row exists', async () => {
    arm([[REC()]]);
    const out = await svc.runSync(pool);
    expect([out.enabled, out.skipped, out.groups, out.ingested, out.stamped, out.ingest_errors])
      .toEqual([true, null, 1, 1, 1, 0]);

    const row = await eventRow('twin-1');
    expect(row).not.toBeNull();
    expect([row.direction, row.delivery_state, row.delivery_reason, row.delivery_code])
      .toEqual(['outgoing', 'sent', null, null]);
    expect(row.delivery_checked_at).not.toBeNull();
    expect(row.log_id).not.toBeNull();   // the real createLogEntry ran

    const [[logRow]] = await pool.query(`SELECT log_type, log_direction, log_from, log_to FROM log WHERE log_id = ?`, [row.log_id]);
    expect(logRow).toEqual({ log_type: 'sms', log_direction: 'outgoing', log_from: '2485592400', log_to: '2482405969' });
  });

  test('second run with the same verdict is churn-free; a new verdict stamps; terminal never downgrades', async () => {
    arm([[REC()]]);
    await svc.runSync(pool);
    const stamped1 = (await eventRow('twin-1')).delivery_checked_at;

    // same verdict again → unchanged, checked_at untouched (write only on change)
    arm([[REC()]]);
    const out2 = await svc.runSync(pool);
    expect([out2.ingested, out2.stamped, out2.unchanged]).toEqual([0, 0, 1]);
    expect((await eventRow('twin-1')).delivery_checked_at).toEqual(stamped1);

    // the verdict lands → stamped
    arm([[REC({ delivery: { state: 'failed', reason: 'unreachable', provider_code: 'SMS-CAR-411' } })]]);
    const out3 = await svc.runSync(pool);
    expect([out3.stamped, out3.unchanged]).toEqual([1, 0]);
    let row = await eventRow('twin-1');
    expect([row.delivery_state, row.delivery_reason, row.delivery_code]).toEqual(['failed', 'unreachable', 'SMS-CAR-411']);

    // a later 'sent' can never un-fail it (terminal guard against the real UPDATE)
    arm([[REC()]]);
    const out4 = await svc.runSync(pool);
    expect([out4.stamped, out4.unchanged]).toEqual([0, 1]);
    row = await eventRow('twin-1');
    expect(row.delivery_state).toBe('failed');
  });

  test('backfill: Layer 3 skipped is RECORDED in the real executions row; the event carries the marker', async () => {
    arm([[REC({ provider_ref: 'twin-bf', ts: '2026-06-01T00:00:00.000Z' })]]);
    const out = await svc.runSync(pool, { since: '2026-05-20T00:00:00Z', until: '2026-06-02T00:00:00Z', backfill: true });
    expect([out.ingested, out.ingest_errors]).toEqual([1, 0]);

    const row = await eventRow('twin-bf');
    expect(row.raw_extra.backfill).toBe(true);   // mysql2 parses JSON columns

    const [[exec]] = await pool.query(
      `SELECT status, metadata FROM phone_ingest_executions ORDER BY id DESC LIMIT 1`);
    expect(exec.status).toBe('logged');
    expect(exec.metadata && exec.metadata.automation).toEqual({ skipped: 'backfill' });
  });

  test('the shipped lookup uses the unique key (no scan) and the new index serves the digest shape', async () => {
    const [[lookup]] = await pool.query(
      `EXPLAIN FORMAT=JSON SELECT id FROM phone_event_log WHERE provider = ? AND provider_ref IN (?, ?)`,
      ['ringcentral', 'a', 'b']).then(([r]) => [[JSON.parse(JSON.stringify(r[0]))]]);
    expect(JSON.stringify(lookup)).toContain('ux_phone_event_provider_ref');

    const [idx] = await pool.query(
      `EXPLAIN SELECT id FROM phone_event_log WHERE delivery_state = 'failed' AND processed_at > NOW() - INTERVAL 7 DAY`);
    expect(JSON.stringify(idx)).toContain('idx_phone_event_delivery');
  });
});
