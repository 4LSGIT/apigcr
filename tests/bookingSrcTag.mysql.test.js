// Own local *_test DB only (YC_TEST_MYSQL_URL; give this twin its own DB — it
// drops and rebuilds its one table). The booking embed's ?src= tag composes
// appt_source = "<base>:<tag>" (routes/booking.js composeApptSource), cut to the
// column: appts.appt_source is varchar(60) and production runs the RELAXED
// sql_mode, where a 61st character is dropped silently — a mock cannot show
// that. The column here is the real one: its definition line is lifted from
// ref/database.sql's `appts` CREATE, so a width change in the schema reaches
// this twin, and the composer's cap (APPT_SOURCE_MAX) has to agree with it.
//
// Run:  YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3306/yc_booking_src_test npx jest tests/bookingSrcTag.mysql.test.js
'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'booking-src-test-secret';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());
const { composeApptSource } = require('../routes/booking')._test;

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;

// Production's sql_mode (ref/INFRA_GCP.md §7): no STRICT_TRANS_TABLES.
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

function apptSourceColumnDdl() {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('CREATE TABLE `appts` '));
  if (start < 0) throw new Error('appts missing from ref/database.sql');
  const end = lines.findIndex((l, i) => i > start && /^\) ENGINE=.*;$/.test(l));
  const col = lines.slice(start, end).find((l) => l.trim().startsWith('`appt_source`'));
  if (!col) throw new Error('appts.appt_source missing from ref/database.sql');
  return col.trim().replace(/,$/, '');
}

suite('appts.appt_source on the real engine — the composed tag fits the column, a 61st character would not', () => {
  let conn;
  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);
    await conn.query('DROP TABLE IF EXISTS appts_appt_source_twin');
    await conn.query(`CREATE TABLE appts_appt_source_twin (
        id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ${apptSourceColumnDdl()}
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  });
  afterAll(async () => {
    if (conn) { await conn.query('DROP TABLE IF EXISTS appts_appt_source_twin'); await conn.end(); }
  });

  const roundTrip = async (value) => {
    const [r] = await conn.query('INSERT INTO appts_appt_source_twin (appt_source) VALUES (?)', [value]);
    const [[row]] = await conn.query('SELECT appt_source FROM appts_appt_source_twin WHERE id = ?', [r.insertId]);
    return row.appt_source;
  };

  test('the column is the schema\'s varchar(60)', () => {
    expect(apptSourceColumnDdl()).toMatch(/^`appt_source` varchar\(60\) /);
  });

  test('a 100-character slug with a 30-character tag round-trips whole: 60 characters, the tag intact', async () => {
    const tag = 't'.repeat(30);
    const v = composeApptSource({ slug: 's'.repeat(100), source_tag: null }, tag);
    expect(await roundTrip(v)).toBe(v);
    expect(v).toHaveLength(60);
    expect(v.endsWith(':' + tag)).toBe(true);
  });

  test('the live shape round-trips as written', async () => {
    for (const v of ['bk-consult:ditchurdebt', 'test-consult:improudtobedebtfree', 'test-consult', 'calendly']) {
      expect([v, await roundTrip(v)]).toEqual([v, v]);
    }
    expect(await roundTrip(composeApptSource({ slug: 'bk-consult', source_tag: null }, null))).toBeNull();
  });

  test('why the cap matters: under production\'s sql_mode a 61-character value is cut silently, the tag\'s tail lost', async () => {
    const v = 's'.repeat(30) + ':' + 't'.repeat(30);   // 61
    const stored = await roundTrip(v);
    expect(stored).toHaveLength(60);
    expect(stored).toBe(v.slice(0, 60));
    expect(stored.endsWith('t'.repeat(30))).toBe(false);
  });
});
