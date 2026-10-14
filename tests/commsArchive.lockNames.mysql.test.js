/**
 * REAL-ENGINE check: the comms archive tick-lock names — the cliff sweep, the
 * media sweep (and purge's SWEEP_LOCKS, which must be the same names), the
 * transcribe and summarize sweeps — stay inside MySQL's 64-character GET_LOCK
 * limit for any database name (they embed DATABASE(); a name over 32
 * characters is hashed), and production's short name keeps every lock name
 * byte-identical to before.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Uses a second, deliberately long *_test database on the same server.
 */

'use strict';

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const LONG = 'yc_comms_lock_name_check_with_a_very_long_database_name_test';   // 60 characters

maybe('tick-lock names on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const tx = require('../services/commsTranscribeSweep');
  const sm = require('../services/commsSummarizeSweep');
  const cliff = require('../services/commsArchiveSweep');
  const media = require('../services/commsArchiveMediaSweep');
  const admin = require('../services/commsArchiveAdmin');
  let adminConn, conn;

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1))) throw new Error('refusing to run against a non-_test database');
    adminConn = await mysql.createConnection({ uri: URL_ });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${LONG}\``);
    u.pathname = `/${LONG}`;
    conn = await mysql.createConnection({ uri: u.toString() });
  });
  afterAll(async () => {
    if (conn) await conn.end();
    if (adminConn) { await adminConn.query(`DROP DATABASE IF EXISTS \`${LONG}\``); await adminConn.end(); }
  });

  test.each([['transcribe', () => tx.LOCK_EXPR], ['summarize', () => sm.LOCK_EXPR],
    ['cliff sweep', () => cliff.LOCK_EXPR], ['media sweep', () => media.LOCK_EXPR]])('%s: GET_LOCK works under a %i-char database name', async (_n, expr) => {
    const [[r]] = await conn.query(`SELECT ${expr()} AS name, CHAR_LENGTH(${expr()}) AS len, GET_LOCK(${expr()}, 0) AS got`);
    expect(Number(r.got)).toBe(1);
    expect(Number(r.len)).toBeLessThanOrEqual(64);
    expect(r.name).not.toMatch(new RegExp(LONG));
    await conn.query(`SELECT RELEASE_LOCK(${expr()})`);
  });

  test('a short (production-like) name: every lock name is byte-identical to the old CONCAT(prefix, DATABASE())', async () => {
    for (const [expr, prefix] of [[sm.LOCK_EXPR, 'comms_archive_summarize:'], [tx.LOCK_EXPR, 'comms_archive_transcribe:'],
      [cliff.LOCK_EXPR, 'comms_archive_sweep:'], [media.LOCK_EXPR, 'comms_archive_media:']]) {
      const [[r]] = await adminConn.query(`SELECT ${expr} AS name, CONCAT('${prefix}', DATABASE()) AS old`);
      expect(r.name).toBe(r.old);
    }
  });

  test('purge locks the SAME names the sweeps hold', () => {
    expect(admin.SWEEP_LOCKS.cliff).toBe(cliff.LOCK_EXPR);
    expect(admin.SWEEP_LOCKS.media).toBe(media.LOCK_EXPR);
  });
});
