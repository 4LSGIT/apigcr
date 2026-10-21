/**
 * REAL-ENGINE TWIN of tests/logCommDate.routes.test.js — log-comm-date.
 * POST /api/log `date` → the firm wall clock stored in log_date, and the
 * log readers' order and paging once backdated rows tie, over a real MySQL 8
 * with the production schema.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Same protocol as tests/mailboxS2.mysql.test.js (read its header): a FRESH
 * throwaway *_test database loaded from ref/database.sql, timezone tables
 * loaded (CONVERT_TZ(…'EST5EDT') returns NULL without them and log_date is
 * NOT NULL), --runInBand:
 *
 *   mysql -uroot -e "CREATE DATABASE yc_lcd_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_lcd_test < ref/database.sql
 *   mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -uroot mysql
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3306/yc_lcd_test npx jest --runInBand tests/logCommDate.mysql.test.js
 *
 * Pool timezone 'Z' and production's sql_mode on every connection, like
 * startup/db.js. Run 2026-10-22: MySQL 8.4.11 (production's major), green.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'log-comm-date-mysql-secret';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('log-comm-date on real MySQL', () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const mysql = require('mysql2/promise');
  const logService = require('../services/logService');
  const caseService = require('../services/caseService');
  const contactService = require('../services/contactService');

  let pool; let server; let base;
  const SS = 1;
  const tok = jwt.sign({ sub: String(SS), username: 'u1', user_auth: 'authorized', roles: [], aud: 'staff' }, process.env.JWT_SECRET);
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  async function call(method, url, body) {
    const headers = { Authorization: `Bearer ${tok}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const stored = async (id) => (await q(
    "SELECT DATE_FORMAT(log_date, '%Y-%m-%d %H:%i:%s') AS d, log_extra FROM log WHERE log_id = ?", [id]))[0];

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.log'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    await q('DELETE FROM log');
    await q('DELETE FROM users WHERE `user` = ?', [SS]);
    await q(`INSERT INTO users (\`user\`, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral)
             VALUES (?, 'ss', 1, 'Stuart', 'Stuart', 'S', 'SS', 'authorized', 0)`, [SS]);
  });

  test.each([
    ['summer, EDT', '2026-10-18T14:30', '2026-10-18 14:30:00'],
    ['winter, EST', '2026-01-05T09:15', '2026-01-05 09:15:00'],
    ['date-only = firm midnight, same day', '2026-10-18', '2026-10-18 00:00:00'],
    ['SQL-style naive is firm time', '2026-03-09 08:00:00', '2026-03-09 08:00:00'],
  ])('a naive date is stored as that firm wall clock (%s)', async (_l, date, wall) => {
    const r = await call('POST', '/api/log', { type: 'call', link_type: 'contact', link_id: '2111', data: { note: 'n' }, direction: 'incoming', date });
    expect(r.status).toBe(200);
    const row = await stored(r.json.log_id);
    expect(row.d).toBe(wall);
    const extra = typeof row.log_extra === 'string' ? JSON.parse(row.log_extra) : row.log_extra;
    expect(extra).toEqual({ logged_at: expect.any(String) });
  });

  test('no date: stamped now, firm wall clock (within a minute of the engine clock)', async () => {
    const r = await call('POST', '/api/log', { type: 'call', link_type: 'contact', link_id: '2111', data: { note: 'n' } });
    const [row] = await q(
      `SELECT ABS(TIMESTAMPDIFF(SECOND, log_date, CONVERT_TZ(NOW(), '+00:00', 'EST5EDT'))) AS drift, log_extra
         FROM log WHERE log_id = ?`, [r.json.log_id]);
    expect(row.drift).toBeLessThan(60);
    expect(row.log_extra).toBeNull();
  });

  describe('ties: backdated rows share an instant', () => {
    // Seven rows; five share the same firm-midnight log_date (a date-only
    // backdate), inserted in a scrambled id order around two distinct ones.
    beforeEach(async () => {
      const rows = [
        [101, '2026-10-18 00:00:00'], [105, '2026-10-18 00:00:00'], [102, '2026-10-19 10:00:00'],
        [104, '2026-10-18 00:00:00'], [107, '2026-10-17 09:00:00'], [103, '2026-10-18 00:00:00'],
        [106, '2026-10-18 00:00:00'],
      ];
      for (const [id, d] of rows) {
        await q(`INSERT INTO log (log_id, log_type, log_date, log_link, log_link_type, log_link_id, log_by, log_data, log_message)
                 VALUES (?, 'call', ?, '2111', 'contact', '2111', 1, '{}', '')`, [id, d]);
      }
    });
    const DESC = [102, 106, 105, 104, 103, 101, 107];

    test('listLog: newest first, ties by log_id, and paging neither repeats nor skips', async () => {
      const pages = [];
      for (const offset of [0, 2, 4, 6]) {
        const { entries } = await logService.listLog(pool, { link_type: 'contact', link_id: '2111', case_relate_filter: 'default', limit: 2, offset });
        pages.push(...entries.map((e) => e.log_id));
      }
      expect(pages).toEqual(DESC);
    });

    test('listLog sort=asc: the exact reverse', async () => {
      const { entries } = await logService.listLog(pool, { link_type: 'contact', link_id: '2111', sort: 'asc', limit: 50 });
      expect(entries.map((e) => e.log_id)).toEqual([...DESC].reverse());
    });

    test('GET /api/log?sort=asc over the route', async () => {
      const r = await call('GET', '/api/log?link_type=contact&link_id=2111&sort=asc&limit=3');
      expect(r.status).toBe(200);
      expect(r.json.entries.map((e) => e.log_id)).toEqual([107, 101, 103]);
    });

    // FORCE INDEX: on seven rows the optimizer may rightly prefer a scan. The
    // point is that idx_log_date (log_date + the PK InnoDB appends) delivers
    // this ORDER BY in either direction without a filesort; the live plan on
    // production's ~76k rows picked it unforced (EXPLAIN, 2026-10-22).
    test('idx_log_date serves the tiebroken order both ways (no filesort)', async () => {
      for (const dir of ['DESC', 'ASC']) {
        const [plan] = await q(`EXPLAIN SELECT l.log_id FROM log l FORCE INDEX (idx_log_date) ORDER BY l.log_date ${dir}, l.log_id ${dir} LIMIT 50`);
        expect(plan.key).toBe('idx_log_date');
        expect(String(plan.Extra)).not.toMatch(/filesort/);
      }
    });

    test("caseService.getCase's embedded log carries the same tiebreak", async () => {
      await q('DELETE FROM cases WHERE case_id = ?', ['LCD1']);
      // relaxed sql_mode: the NOT-NULL-without-default columns take '' (prod parity)
      await q("INSERT INTO cases (case_id, case_type, case_status) VALUES ('LCD1', 'Ch 7', 'Open')");
      await q("UPDATE log SET log_link_type = 'case', log_link_id = 'LCD1', log_link = 'LCD1'");
      const c = await caseService.getCase(pool, 'LCD1', 'log');
      expect(Array.isArray(c && c.log)).toBe(true);
      expect(c.log.map((e) => e.log_id)).toEqual(DESC);
    });

    test("contactService.getContact's embedded log carries the same tiebreak", async () => {
      await q('DELETE FROM contacts WHERE contact_id = 2111');
      await q("INSERT INTO contacts (contact_id, contact_fname, contact_lname) VALUES (2111, 'Ryan', 'M')");
      const c = await contactService.getContact(pool, 2111, 'log');
      expect(Array.isArray(c && c.log)).toBe(true);
      expect(c.log.map((e) => e.log_id)).toEqual(DESC);
    });
  });
});
