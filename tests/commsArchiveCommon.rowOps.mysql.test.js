/**
 * REAL-ENGINE test for commsArchiveCommon.rowOps(limits, {table, claimStates})
 * — the S2 parameterisation (the transcription sweep leases comms_transcripts
 * rows from 'pending' AND 'transcribing'). The default binding (comms_media,
 * ['pending']) is exercised unchanged by the S1 suites
 * (commsArchive.sweep / s1b / s1c .mysql.test.js), which this slice does not
 * modify.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s2_test npx jest tests/commsArchiveCommon.rowOps.mysql.test.js --runInBand
 */

'use strict';

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

describe('rowOps option validation (no DB)', () => {
  const common = require('../services/commsArchiveCommon');
  test('identifiers are validated, never interpolated raw', () => {
    expect(() => common.rowOps({}, { table: 'x; DROP TABLE y' })).toThrow(/bad table/);
    expect(() => common.rowOps({}, { claimStates: [] })).toThrow(/claimStates/);
    expect(() => common.rowOps({}, { claimStates: ["pending' OR 1=1 --"] })).toThrow(/claimStates/);
    expect(() => common.rowOps({}, { claimStates: 'pending' })).toThrow(/claimStates/);
  });
  test('markArchived / anomaly refuse any table but comms_media', async () => {
    const ops = common.rowOps({}, { table: 'comms_transcripts', claimStates: ['pending'] });
    await expect(ops.markArchived({}, 1, {})).rejects.toThrow(/comms_media only/);
    await expect(ops.anomaly({}, { id: 1 }, 'x')).rejects.toThrow(/comms_media only/);
  });
});

maybe('rowOps bound to another table / several claim states, on real MySQL', () => {
  const mysql  = require('mysql2/promise');
  const common = require('../services/commsArchiveCommon');
  const limits = { leaseMin: 10, stuckBackoffMin: 360, repeatWindowHours: 24, maxAttempts: 3, backoffCapMin: 60, noCliffDays: 30 };
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const row = async (id) => (await q('SELECT * FROM rowops_t WHERE id = ?', [id]))[0];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await q('DROP TABLE IF EXISTS rowops_t');
    await q(`CREATE TABLE rowops_t (
      id INT UNSIGNED NOT NULL PRIMARY KEY, state VARCHAR(16) NOT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME NULL, last_error VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  });
  afterAll(async () => { await q('DROP TABLE IF EXISTS rowops_t'); await pool.end(); });
  beforeEach(async () => {
    await q('DELETE FROM rowops_t');
    await q(`INSERT INTO rowops_t (id, state) VALUES (1,'pending'),(2,'transcribing'),(3,'transcribed'),(4,'failed')`);
  });

  const ops = () => common.rowOps(limits, { table: 'rowops_t', claimStates: ['pending', 'transcribing'] });

  test('claim leases from EVERY claim state, and only those; a held lease is not re-claimable', async () => {
    const o = ops();
    expect(await o.claim(pool, 1)).toBe(true);
    expect(await o.claim(pool, 2)).toBe(true);
    expect(await o.claim(pool, 3)).toBe(false);
    expect(await o.claim(pool, 4)).toBe(false);
    expect(await o.claim(pool, 1)).toBe(false);            // leased
    expect((await row(1)).attempts).toBe(1);
    expect((await row(3)).attempts).toBe(0);
  });

  test('refund / park / transient / fail act on claim states and never touch other rows', async () => {
    const o = ops();
    await o.claim(pool, 2);
    await o.refund(pool, 2, 'ours');
    expect(await row(2)).toMatchObject({ attempts: 0, next_attempt_at: null, last_error: 'ours' });
    await o.claim(pool, 1);
    await o.park(pool, 1, 120, 'drift');
    const r1 = await row(1);
    expect(r1.attempts).toBe(0);
    expect(r1.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 100 * 60e3);
    expect(await o.transient(pool, { id: 2 }, 1, 'boom')).toBe('retry');
    expect((await row(2)).last_error).toBe('boom');
    expect(await o.transient(pool, { id: 2 }, 3, 'boom3')).toBe('stuck');
    await o.fail(pool, 2, 'dead');
    expect((await row(2)).state).toBe('failed');
    // rows outside the claim states are inert
    for (const id of [3]) {
      await o.refund(pool, id, 'x'); await o.park(pool, id, 5, 'x'); await o.fail(pool, id, 'x');
      expect(await row(id)).toMatchObject({ state: 'transcribed', last_error: null, next_attempt_at: null });
    }
  });

  test('the default binding still leases pending only (a transcribing row is NOT claimable)', async () => {
    // Same table, default claimStates: the S1 behaviour, proven on this table.
    const o = common.rowOps(limits, { table: 'rowops_t' });
    expect(await o.claim(pool, 2)).toBe(false);
    expect(await o.claim(pool, 1)).toBe(true);
  });
});
