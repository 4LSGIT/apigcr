// tests/listSorting.mysql.test.js
/**
 * The list sorts on a REAL engine: contactService.listContacts (name / ID /
 * DOB orders, the BIRTHDAYS window), caseService.listCases (client name reads
 * the PRIMARY client; every order ends on case_id), GET /api/appts (the
 * 'upcoming' agenda, column sorts, the unchanged default) and
 * eventService.listEvents (the same for events). ORDER BY predicates are the
 * thing under test, so they run on MySQL 8.4 with production's sql_mode — a
 * mocked query would only echo the SQL back.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_sort_test \
 *     npx jest tests/listSorting.mysql.test.js --runInBand
 * Refuses port 3306 (production through the proxy) and any database whose
 * name does not end in _test. Tables are cloned from ref/database.sql.
 *
 * "Today" is pinned through luxon's Settings.now: 2026-10-27 12:00 in Detroit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');
const { Settings } = require('luxon');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());

const contactService = require('../services/contactService');
const caseService = require('../services/caseService');
const eventService = require('../services/eventService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'cases', 'case_relate', 'appts', 'events'];
const NOW = Date.parse('2026-10-27T16:00:00Z');   // noon, America/Detroit (EDT)

function dumpBlocks(dumpLines, table) {
  const out = [];
  let cur = null;
  const start = new RegExp(`^(?:CREATE TABLE|ALTER TABLE) \`${table}\`[ (]*$`);
  for (const line of dumpLines) {
    if (cur == null) { if (start.test(line)) cur = [line]; continue; }
    cur.push(line);
    if (/;\s*$/.test(line)) { out.push(cur.join('\n').replace(/;\s*$/, '')); cur = null; }
  }
  return out;
}

d('list sorts on a real engine', () => {
  let pool;
  let server;
  let base;
  const realNow = Settings.now;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const ids = (rows, key) => rows.map((r) => r[key]);

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname.slice(1))) throw new Error(`refusing to run against "${url.pathname}"`);
    if (url.port === '3306' || url.port === '') throw new Error('refusing port 3306 — that is production');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const [[{ mode }]] = await pool.query('SELECT @@SESSION.sql_mode AS mode');
    expect(mode).not.toMatch(/STRICT_TRANS_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);

    const dumpLines = read('ref/database.sql').split('\n');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of TABLES) {
      const blocks = dumpBlocks(dumpLines, t);
      if (!blocks.length) throw new Error(`ref/database.sql has no CREATE TABLE for ${t}`);
      for (const b of blocks) await pool.query(b);
    }

    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type) VALUES
      (6, 'fred', 'Fred Ross', 'Fred', 'Ross', 'FR', 'authorized', 1),
      (22, 'rena', 'Rena G', 'Rena', 'G', 'RG', 'authorized', 1)`);
    // DOBs: two with none (they must sort LAST both ways), a Feb 29, a
    // year-end wrap pair, and a shared last name broken by first name.
    await q(`INSERT INTO contacts (contact_id, contact_fname, contact_lname, contact_name, contact_dob) VALUES
      (1, 'Pat',  'Smith', 'Pat Smith',  '1980-10-29'),
      (2, 'Abe',  'Smith', 'Abe Smith',  '1975-11-02'),
      (3, 'Zoe',  'Adams', 'Zoe Adams',  NULL),
      (4, 'Lee',  'Moe',   'Lee Moe',    '1992-02-29'),
      (5, 'Kim',  'Zed',   'Kim Zed',    '1990-12-30'),
      (6, 'Ann',  'Able',  'Ann Able',   '1988-01-02'),
      (7, 'Bo',   'Brown', 'Bo Brown',   NULL),
      (8, 'Cy',   'Cole',  'Cy Cole',    '1985-02-28'),
      (9, 'Di',   'Dunn',  'Di Dunn',    '1970-10-27')`);

    // A: primary Able, secondary Zed — on this engine a bare co.contact_lname
    // (the bug: relaxed GROUP BY picks a row) reads Zed and sorts A last.
    // D: primary Smith (Pat), secondary Adams — a plain MIN() over all clients
    // would sort D second, under Adams. C has no primary: its only client,
    // Smith (Abe) — tied with D on last name, so case_id breaks it.
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_stage, case_status, case_open_date) VALUES
      ('CASEAAAA', '26-1', 'bk', 'Open', 'Active', '2026-01-01'),
      ('CASEBBBB', '26-2', 'bk', 'Open', 'Active', '2026-01-01'),
      ('CASECCCC', '26-3', 'bk', 'Open', 'Active', '2026-01-01'),
      ('CASEDDDD', '26-4', 'bk', 'Open', 'Active', '2026-01-01')`);
    await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      ('CASEAAAA', 5, 'Secondary'), ('CASEAAAA', 6, 'Primary'),
      ('CASEBBBB', 4, 'Primary'),
      ('CASECCCC', 2, 'Secondary'),
      ('CASEDDDD', 3, 'Secondary'), ('CASEDDDD', 1, 'Primary')`);

    // Appts around "today" (Oct 27, firm-local naive).
    await q(`INSERT INTO appts (appt_id, appt_client_id, appt_case_id, appt_type, appt_status, appt_date, appt_with) VALUES
      (101, 1, '', 'Consult',      'Scheduled', '2026-10-27 09:00:00', 6),
      (102, 2, '', '341 Meeting',  'Scheduled', '2026-10-27 15:00:00', 22),
      (103, 3, '', 'Consult',      'Scheduled', '2026-10-28 10:00:00', 6),
      (104, 4, '', '',             'Scheduled', '2026-11-05 10:00:00', 6),
      (105, 5, '', 'Consult',      'Attended',  '2026-10-26 10:00:00', 22),
      (106, 6, '', 'Consult',      'Attended',  '2026-09-01 10:00:00', 6),
      (107, NULL, '', 'Consult',   'Scheduled', '2026-12-01 10:00:00', NULL)`);

    await q(`INSERT INTO events (event_id, event_type, event_title, event_date, event_time, event_all_day, event_status) VALUES
      (201, 'Deadline', 'Proof of claim',  '2026-10-27', '14:00:00', 0, 'Scheduled'),
      (202, 'Hearing',  'Confirmation',    '2026-10-27', NULL,       1, 'Scheduled'),
      (203, 'Hearing',  'Valuation',       '2026-11-02', '09:00:00', 0, 'Scheduled'),
      (204, 'Deadline', '',                '2026-10-20', '10:00:00', 0, 'Scheduled'),
      (205, 'Deadline', 'Objection',       '2026-10-20', NULL,       1, 'Scheduled'),
      (206, 'Hearing',  'Status',          '2026-08-01', '09:00:00', 0, 'Scheduled')`);

    const app = express();
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.appts'));
    app.use(require('../routes/api.contacts'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => { Settings.now = () => NOW; });
  afterEach(() => { Settings.now = realNow; });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };

  describe('contacts', () => {
    const list = (o) => contactService.listContacts(pool, { limit: 100, ...o });

    test('last name breaks ties on first name, then id', async () => {
      const { contacts } = await list({ sort_by: 'contact_lname', sort_dir: 'ASC' });
      expect(ids(contacts, 'contact_id')).toEqual([6, 3, 7, 8, 9, 4, 2, 1, 5]);
      const desc = await list({ sort_by: 'contact_lname', sort_dir: 'DESC' });
      expect(ids(desc.contacts, 'contact_id')).toEqual([5, 1, 2, 4, 9, 8, 7, 3, 6]);
    });

    test('first name and id', async () => {
      expect(ids((await list({ sort_by: 'contact_fname', sort_dir: 'ASC' })).contacts, 'contact_id'))
        .toEqual([2, 6, 7, 8, 9, 5, 4, 1, 3]);
      expect(ids((await list({ sort_by: 'contact_id', sort_dir: 'DESC' })).contacts, 'contact_id'))
        .toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    test('DOB: contacts without one sort LAST in both directions', async () => {
      expect(ids((await list({ sort_by: 'contact_dob', sort_dir: 'ASC' })).contacts, 'contact_id'))
        .toEqual([9, 2, 1, 8, 6, 5, 4, 3, 7]);
      expect(ids((await list({ sort_by: 'contact_dob', sort_dir: 'DESC' })).contacts, 'contact_id'))
        .toEqual([4, 5, 6, 8, 1, 2, 9, 3, 7]);
    });

    test('an unlisted sort falls back to last name', async () => {
      expect(ids((await list({ sort_by: 'contact_ssn', sort_dir: 'ASC' })).contacts, 'contact_id'))
        .toEqual([6, 3, 7, 8, 9, 4, 2, 1, 5]);
    });

    test('pages never repeat or skip a row', async () => {
      const seen = [];
      for (let off = 0; off < 9; off += 2) {
        const { contacts } = await list({ sort_by: 'contact_dob', sort_dir: 'ASC', limit: 2, offset: off });
        seen.push(...ids(contacts, 'contact_id'));
      }
      expect(seen).toEqual([9, 2, 1, 8, 6, 5, 4, 3, 7]);
    });

    test('BIRTHDAYS next7 from Oct 27: in the window only, upcoming first, whatever the sort says', async () => {
      const r = await list({ birthdays: 'next7', sort_by: 'contact_dob', sort_dir: 'DESC' });
      expect(ids(r.contacts, 'contact_id')).toEqual([9, 1, 2]);   // Oct 27, Oct 29, Nov 2
      expect(r.total).toBe(3);
    });

    test('BIRTHDAYS wrap the year end', async () => {
      const r = await list({ birthdays: 'next7', today: '2026-12-28' });
      expect(ids(r.contacts, 'contact_id')).toEqual([5, 6]);       // Dec 30, Jan 2
    });

    test('BIRTHDAYS: Feb 29 rides Feb 28 in a non-leap year, after it', async () => {
      const r = await list({ birthdays: 'this_month', today: '2027-02-10' });
      expect(ids(r.contacts, 'contact_id')).toEqual([8, 4]);
      const leap = await list({ birthdays: 'next7', today: '2028-02-27' });
      expect(ids(leap.contacts, 'contact_id')).toEqual([8, 4]);
    });

    test('the route rejects an unknown window and passes a known one through', async () => {
      expect((await get('/api/contacts?birthdays=decade')).status).toBe(400);
      const r = await get('/api/contacts?birthdays=next7&limit=50');
      expect(r.status).toBe(200);
      expect(ids(r.body.contacts, 'contact_id')).toEqual([9, 1, 2]);
    });
  });

  describe('cases', () => {
    test('client last name reads the PRIMARY client', async () => {
      const r = await caseService.listCases(pool, { sort_by: 'co.contact_lname', sort_dir: 'ASC' });
      expect(ids(r.cases, 'case_id')).toEqual(['CASEAAAA', 'CASEBBBB', 'CASECCCC', 'CASEDDDD']);
    });

    test('equal values break on case_id, in the sort direction', async () => {
      const asc = await caseService.listCases(pool, { sort_by: 'c.case_stage', sort_dir: 'ASC' });
      expect(ids(asc.cases, 'case_id')).toEqual(['CASEAAAA', 'CASEBBBB', 'CASECCCC', 'CASEDDDD']);
      const desc = await caseService.listCases(pool, { sort_by: 'c.case_stage', sort_dir: 'DESC' });
      expect(ids(desc.cases, 'case_id')).toEqual(['CASEDDDD', 'CASECCCC', 'CASEBBBB', 'CASEAAAA']);
    });
  });

  describe('appts', () => {
    const order = async (qs) => ids((await get(`/api/appts?limit=50${qs}`)).body.appts, 'id');

    test('no sort_by: newest first, as every other caller has always had', async () => {
      expect(await order('')).toEqual([107, 104, 103, 102, 101, 105, 106]);
    });

    test('upcoming: today (all of it), then later soonest first, then the past newest first', async () => {
      expect(await order('&sort_by=upcoming')).toEqual([101, 102, 103, 104, 107, 105, 106]);
    });

    test('"today" is the FIRM day: 01:00 UTC on Oct 28 is still Oct 27 in Detroit', async () => {
      Settings.now = () => Date.parse('2026-10-28T01:00:00Z');
      expect(await order('&sort_by=upcoming')).toEqual([101, 102, 103, 104, 107, 105, 106]);
    });

    test('date both ways', async () => {
      expect(await order('&sort_by=date&sort_dir=ASC')).toEqual([106, 105, 101, 102, 103, 104, 107]);
      expect(await order('&sort_by=date&sort_dir=DESC')).toEqual([107, 104, 103, 102, 101, 105, 106]);
    });

    test('a column sort puts blanks last in both directions, then newest first', async () => {
      // client: the full name the column shows (Abe Smith, Ann Able, …); 107 has none.
      expect(await order('&sort_by=client&sort_dir=ASC')).toEqual([102, 106, 105, 104, 101, 103, 107]);
      expect(await order('&sort_by=client&sort_dir=DESC')).toEqual([103, 101, 104, 105, 106, 102, 107]);
      // type: 104 is ''.
      expect(await order('&sort_by=type&sort_dir=ASC')).toEqual([102, 107, 103, 101, 105, 106, 104]);
      expect(await order('&sort_by=with&sort_dir=ASC')).toEqual([104, 103, 101, 106, 102, 105, 107]);
    });

    test('an unlisted sort_by is the default, never interpolated', async () => {
      expect(await order('&sort_by=appt_note;DROP')).toEqual([107, 104, 103, 102, 101, 105, 106]);
    });
  });

  describe('events', () => {
    const order = async (o) => ids((await eventService.listEvents(pool, { status: 'all', limit: 50, ...o })).data, 'event_id');

    test('default asc is unchanged: oldest first, all-day first within a day', async () => {
      expect(await order({})).toEqual([206, 205, 204, 202, 201, 203]);
      expect(await order({ sort: 'desc' })).toEqual([203, 201, 202, 204, 205, 206]);
    });

    test('upcoming: today (all-day first), later soonest first, then the past newest first', async () => {
      expect(await order({ sort: 'upcoming' })).toEqual([202, 201, 203, 204, 205, 206]);
    });

    test('a column sort: blanks last, then by date', async () => {
      expect(await order({ sort: 'asc', sort_by: 'title' })).toEqual([202, 205, 201, 206, 203, 204]);
      expect(await order({ sort: 'desc', sort_by: 'title' })).toEqual([203, 206, 201, 205, 202, 204]);
      expect(await order({ sort: 'asc', sort_by: 'type' })).toEqual([205, 204, 201, 206, 202, 203]);
    });
  });
});
