// tests/listSorting.mysql.test.js
/**
 * The list sorts on a REAL engine: contactService.listContacts (name / ID /
 * DOB orders, the BIRTHDAYS window), caseService.listCases (client name reads
 * the PRIMARY client; every order ends on case_id), GET /api/appts (the
 * 'upcoming' agenda, column sorts, the unchanged default) and
 * eventService.listEvents (the same for events), and taskService.listTasks /
 * GET /api/tasks (the work-queue default, every column sort, the Status
 * column sorting by the pill it shows). ORDER BY predicates are the
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
const taskService = require('../services/taskService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'cases', 'case_relate', 'appts', 'events', 'tasks', 'contact_roles', 'field_defs'];

// createDef/updateDef schedule the S3 reconciler post-commit (fire-and-forget
// ALTERs); on this twin that would race the tests' own DDL — stub it out.
jest.mock('../services/fieldDefReconciler', () => ({ scheduleReconcile: jest.fn() }));
const fieldDefs = require('../services/fieldDefService');
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

    // Tasks around "today" (Oct 27). Stored task_status is what the sweep last
    // wrote: 302 is due today but still stored Pending (sweep not run yet),
    // 305 is past due but deferred (starts Nov 1) — due BEFORE 301, so only the
    // default's deferred-sinks clause keeps it under 301. 303/308 tie on due, title
    // AND created — task_id breaks it. 303 is from the Automation pseudo-user
    // (task_from 0, no users row). 302 links a case with no case_number_full,
    // 307 one whose case_number_full is '' (free text) — both read case_number.
    await q(`INSERT INTO tasks (task_id, task_status, task_from, task_to, task_date, task_start, task_due,
        task_link, task_link_type, task_link_id, task_title, task_desc) VALUES
      (301, 'Overdue',   6,  22, '2026-10-01 09:00:00', NULL,         '2026-10-20', '', 'contact', '1',        'Bravo',   ''),
      (302, 'Pending',   22, 6,  '2026-10-02 09:00:00', NULL,         '2026-10-27', '', 'case',    'CASEAAAA', 'alpha',   ''),
      (303, 'Pending',   0,  6,  '2026-10-03 09:00:00', NULL,         '2026-11-05', '', NULL,      NULL,       'Charlie', ''),
      (304, 'Pending',   6,  22, '2026-10-04 09:00:00', NULL,         NULL,         '', 'appt',    '101',      '',        ''),
      (305, 'Overdue',   6,  6,  '2026-10-05 09:00:00', '2026-11-01', '2026-10-15', '', NULL,      NULL,       'Delta',   ''),
      (306, 'Completed', 6,  22, '2026-10-06 09:00:00', NULL,         '2026-10-01', '', 'contact', '3',        'Echo',    ''),
      (307, 'Deleted',   22, 6,  '2026-10-07 09:00:00', NULL,         '2026-10-10', '', 'case',    'CASEBBBB', 'Foxtrot', ''),
      (308, 'Pending',   22, 6,  '2026-10-03 09:00:00', NULL,         '2026-11-05', '', NULL,      NULL,       'Charlie', '')`);
    await q(`UPDATE cases SET case_number_full = '' WHERE case_id = 'CASEBBBB'`);

    const app = express();
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.tasks'));
    app.use(require('../routes/api.appts'));
    app.use(require('../routes/api.contacts'));
    app.use(require('../routes/api.cases'));
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

    // Role multi filter (F2): CSV/array = one EXISTS over role IN; '-none'
    // alone keeps its NOT-EXISTS meaning; fixtures are per-test and cleaned.
    test('role CSV matches the union of codes; -none still means no active role', async () => {
      await q(`INSERT INTO contact_roles (contact_id, role, active) VALUES
        (1, 'judge', 1), (2, 'trustee', 1), (3, 'judge', 0)`);
      try {
        const both = await list({ role: 'judge,trustee' });
        expect(ids(both.contacts, 'contact_id').sort()).toEqual([1, 2]);
        expect(both.total).toBe(2);
        // inactive role rows never match
        expect(ids((await list({ role: 'judge' })).contacts, 'contact_id')).toEqual([1]);
        // -none = everyone with no ACTIVE role row (contact 3's is inactive)
        const none = await list({ role: '-none' });
        expect(ids(none.contacts, 'contact_id').sort()).toEqual([3, 4, 5, 6, 7, 8, 9]);
      } finally {
        await q(`DELETE FROM contact_roles WHERE contact_id IN (1, 2, 3)`);
      }
    });

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

    test('caption sorts with blanks last, both ways', async () => {
      await q(`UPDATE cases SET case_caption = 'In re Zed' WHERE case_id = 'CASEAAAA'`);
      await q(`UPDATE cases SET case_caption = 'Able v. Baker' WHERE case_id = 'CASEBBBB'`);
      await q(`UPDATE cases SET case_caption = '' WHERE case_id = 'CASECCCC'`);
      try {
        const asc = await caseService.listCases(pool, { sort_by: 'c.case_caption', sort_dir: 'ASC' });
        expect(ids(asc.cases, 'case_id').slice(0, 2)).toEqual(['CASEBBBB', 'CASEAAAA']);
        const desc = await caseService.listCases(pool, { sort_by: 'c.case_caption', sort_dir: 'DESC' });
        expect(ids(desc.cases, 'case_id').slice(0, 2)).toEqual(['CASEAAAA', 'CASEBBBB']);
      } finally {
        await q(`UPDATE cases SET case_caption = NULL`);
      }
    });

    test('each row says whether its caption adds to the Primary client', async () => {
      await q(`UPDATE cases SET case_caption = 'In re Ann Able' WHERE case_id = 'CASEAAAA'`);
      await q(`UPDATE cases SET case_caption = 'Cohen v. Moe' WHERE case_id = 'CASEBBBB'`);
      try {
        const r = await caseService.listCases(pool, { sort_by: 'c.case_id', sort_dir: 'ASC' });
        const flags = Object.fromEntries(r.cases.map((c) => [c.case_id, c.caption_adds_info]));
        expect(flags).toEqual({ CASEAAAA: false, CASEBBBB: true, CASECCCC: false, CASEDDDD: false });
      } finally {
        await q(`UPDATE cases SET case_caption = NULL`);
      }
    });

    test('a name search finds a Secondary-only client, and the total agrees', async () => {
      const r = await caseService.listCases(pool, { query: 'Kim Zed' });
      expect(ids(r.cases, 'case_id')).toEqual(['CASEAAAA']);
      expect(r.total).toBe(1);
    });

    test('a name search keeps the case\'s other contacts on the row', async () => {
      const r = await caseService.listCases(pool, { query: 'Kim Zed' });
      const raw = r.cases[0].contacts;
      const contacts = typeof raw === 'string' ? JSON.parse(raw) : raw;
      expect(contacts.map((c) => c.contact_name).sort()).toEqual(['Ann Able', 'Kim Zed']);
    });

    test('a client on two cases in different roles counts both, once each', async () => {
      await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
        ('CASEBBBB', 5, 'Secondary')`);
      try {
        const r = await caseService.listCases(pool, { query: 'Kim Zed' });
        expect(ids(r.cases, 'case_id').sort()).toEqual(['CASEAAAA', 'CASEBBBB']);
        expect(r.total).toBe(2);
      } finally {
        await q(`DELETE FROM case_relate WHERE case_relate_case_id = 'CASEBBBB' AND case_relate_client_id = 5`);
      }
    });

    test('no search: the total is every case, and a filter narrows it', async () => {
      expect((await caseService.listCases(pool, {})).total).toBe(4);
      expect((await caseService.listCases(pool, { stage: 'Closed' })).total).toBe(0);
    });

    // Stage multi filter (F1): CSV/array = IN; one value keeps the legacy
    // LIKE so '%'-pattern callers are untouched. Fixture: all four cases are
    // 'Open'; two are flipped per test and restored.
    test('stage CSV and array become IN; a lone value still matches as LIKE', async () => {
      await q(`UPDATE cases SET case_stage = 'Filed'  WHERE case_id = 'CASEAAAA'`);
      await q(`UPDATE cases SET case_stage = 'Closed' WHERE case_id = 'CASEBBBB'`);
      try {
        const csv = await caseService.listCases(pool, { stage: 'Filed,Closed' });
        expect(ids(csv.cases, 'case_id').sort()).toEqual(['CASEAAAA', 'CASEBBBB']);
        expect(csv.total).toBe(2);
        const arr = await caseService.listCases(pool, { stage: ['Open', 'Filed'] });
        expect(ids(arr.cases, 'case_id').sort()).toEqual(['CASEAAAA', 'CASECCCC', 'CASEDDDD']);
        expect(arr.total).toBe(3);
        // IN is exact: no LIKE semantics ride a list member
        expect((await caseService.listCases(pool, { stage: 'Fil%,Closed' })).total).toBe(1);
        // legacy single value keeps LIKE patterns
        expect((await caseService.listCases(pool, { stage: 'Fil%' })).total).toBe(1);
        expect((await caseService.listCases(pool, { stage: '%' })).total).toBe(4);
      } finally {
        await q(`UPDATE cases SET case_stage = 'Open' WHERE case_id IN ('CASEAAAA', 'CASEBBBB')`);
      }
    });

    // Case type multi filter (F3): `types` tuples — [type] takes the whole
    // type, [type, subtype] one exact pair — OR'd together. Both values are
    // opaque free text, so the fixture plants a comma and a '%' to prove the
    // wire survives them (JSON, never CSV) and the match is `=`, never LIKE.
    test('types tuples: whole types OR (type, subtype) pairs, all exact', async () => {
      await q(`UPDATE cases SET case_type = 'Bankruptcy', case_subtype = 'Chapter 7'  WHERE case_id = 'CASEAAAA'`);
      await q(`UPDATE cases SET case_type = 'Bankruptcy', case_subtype = 'Chapter 13' WHERE case_id = 'CASEBBBB'`);
      await q(`UPDATE cases SET case_type = 'Civil, Litigation', case_subtype = '100% Business' WHERE case_id = 'CASECCCC'`);
      // D's subtype MATCHES the '100% Business' LIKE pattern ('100' + any +
      // ' Business') without equalling it — the row that catches a pair
      // clause drifting from `=` to LIKE.
      await q(`UPDATE cases SET case_type = 'Civil, Litigation', case_subtype = '100345 Business' WHERE case_id = 'CASEDDDD'`);
      try {
        // a subtype's '%' is data: the pair takes C and never pattern-takes D
        const pct = await caseService.listCases(pool, { types: [['Civil, Litigation', '100% Business']] });
        expect(ids(pct.cases, 'case_id')).toEqual(['CASECCCC']);
        expect(pct.total).toBe(1);
        const pair = await caseService.listCases(pool, { types: [['Bankruptcy', 'Chapter 7']] });
        expect(ids(pair.cases, 'case_id')).toEqual(['CASEAAAA']);
        expect(pair.total).toBe(1);
        // a whole type takes every subtype under it
        const whole = await caseService.listCases(pool, { types: [['Bankruptcy']] });
        expect(ids(whole.cases, 'case_id').sort()).toEqual(['CASEAAAA', 'CASEBBBB']);
        expect(whole.total).toBe(2);
        // OR of a pair and a whole type, with ',' and '%' riding as data
        const mix = await caseService.listCases(pool, {
          types: [['Civil, Litigation', '100% Business'], ['Bankruptcy', 'Chapter 13']] });
        expect(ids(mix.cases, 'case_id').sort()).toEqual(['CASEBBBB', 'CASECCCC']);
        expect(mix.total).toBe(2);
        // the whole type still takes every subtype under it
        expect((await caseService.listCases(pool, { types: [['Civil, Litigation']] })).total).toBe(2);
        // exact, not LIKE: a lone '%' matches nothing, not everything
        expect((await caseService.listCases(pool, { types: [['%']] })).total).toBe(0);
        // the multi composes with the other filters (same AND chain)
        expect((await caseService.listCases(pool, { types: [['Bankruptcy']], stage: 'Closed' })).total).toBe(0);
        // an empty array adds nothing
        expect((await caseService.listCases(pool, { types: [] })).total).toBe(4);
        // a malformed entry throws rather than silently mis-filtering
        await expect(caseService.listCases(pool, { types: [['']] })).rejects.toThrow(/types entries/);
        await expect(caseService.listCases(pool, { types: ['Bankruptcy'] })).rejects.toThrow(/types entries/);
        await expect(caseService.listCases(pool, { types: [['Bankruptcy', '']] })).rejects.toThrow(/types entries/);
      } finally {
        await q(`UPDATE cases SET case_type = 'bk', case_subtype = '' WHERE case_id IN ('CASEAAAA', 'CASEBBBB', 'CASECCCC', 'CASEDDDD')`);
      }
    });

    // "Other (unlisted)" (F3b): typesNot is the type list the client
    // displayed; the match is its complement — any case_type not on it,
    // including '' ("no type set"). OR'd into the same group as the tuples.
    test('typesNot complements the displayed list, blank types included', async () => {
      await q(`UPDATE cases SET case_type = 'Bankruptcy'     WHERE case_id = 'CASEAAAA'`);
      await q(`UPDATE cases SET case_type = 'potato hunting' WHERE case_id = 'CASEBBBB'`);
      await q(`UPDATE cases SET case_type = ''               WHERE case_id = 'CASECCCC'`);
      // CASEDDDD stays 'bk' — unlisted too
      try {
        const other = await caseService.listCases(pool, { typesNot: ['Bankruptcy', 'Civil Litigation'] });
        expect(ids(other.cases, 'case_id').sort()).toEqual(['CASEBBBB', 'CASECCCC', 'CASEDDDD']);
        expect(other.total).toBe(3);
        // same OR group as the tuples: a listed type plus Other takes both
        const both = await caseService.listCases(pool, {
          types: [['Bankruptcy']], typesNot: ['Bankruptcy', 'Civil Litigation'] });
        expect(both.total).toBe(4);
        // nothing listed: every case is "other"
        expect((await caseService.listCases(pool, { typesNot: [] })).total).toBe(4);
        // still ANDs with the rest of the filter chain
        expect((await caseService.listCases(pool, { typesNot: ['Bankruptcy'], stage: 'Closed' })).total).toBe(0);
        // a malformed entry throws rather than silently mis-filtering
        await expect(caseService.listCases(pool, { typesNot: [''] })).rejects.toThrow(/typesNot/);
        await expect(caseService.listCases(pool, { typesNot: [1] })).rejects.toThrow(/typesNot/);
      } finally {
        await q(`UPDATE cases SET case_type = 'bk' WHERE case_id IN ('CASEAAAA', 'CASEBBBB', 'CASECCCC')`);
      }
    });
  });

  describe('appts', () => {
    const order = async (qs) => ids((await get(`/api/appts?limit=50${qs}`)).body.appts, 'id');

    // Status multi filter (F2): CSV = IN on the route; one value keeps `= ?`.
    test('status CSV matches the union of statuses', async () => {
      const all = (await get('/api/appts?limit=50')).body.appts;
      const by = {};
      for (const a of all) by[a.status] = (by[a.status] || 0) + 1;
      const statuses = Object.keys(by);
      expect(statuses.length).toBeGreaterThan(1);  // the fixture must exercise IN
      const [s1, s2] = statuses;
      const two = (await get(`/api/appts?limit=50&status=${encodeURIComponent(`${s1},${s2}`)}`)).body.appts;
      expect(two.length).toBe(by[s1] + by[s2]);
      expect(two.every((a) => a.status === s1 || a.status === s2)).toBe(true);
      const one = (await get(`/api/appts?limit=50&status=${encodeURIComponent(s1)}`)).body.appts;
      expect(one.length).toBe(by[s1]);
      // a single-element CSV (trailing comma) MUST take the IN branch: a
      // mutation that drops it filters nothing, and by[s1] < total catches it
      expect(by[s1]).toBeLessThan(all.length);
      const csvOne = (await get(`/api/appts?limit=50&status=${encodeURIComponent(`${s1},`)}`)).body.appts;
      expect(csvOne.length).toBe(by[s1]);
    });

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

  describe('tasks', () => {
    const order = async (o) => ids((await taskService.listTasks(pool, { status: 'All', limit: 50, ...o })).data, 'id');
    const DEFAULT = [301, 305, 302, 308, 303, 304, 306, 307];

    test('no sort_by: the work queue, unchanged — stored status group, deferred sinks, undated last', async () => {
      expect(await order({})).toEqual(DEFAULT);
      expect(await order({ sort_by: 'priority' })).toEqual(DEFAULT);
    });

    test('an unlisted sort_by is the default, never interpolated', async () => {
      expect(await order({ sort_by: 'task_desc;DROP', sort_dir: 'DESC; x' })).toEqual(DEFAULT);
    });

    test('pages never repeat or skip a row', async () => {
      const pages = [];
      for (let off = 0; off < 8; off += 3) pages.push(...await order({ limit: 3, offset: off }));
      expect(pages).toEqual(DEFAULT);
      const byTitle = [];
      for (let off = 0; off < 8; off += 3) byTitle.push(...await order({ sort_by: 'title', limit: 3, offset: off }));
      expect(byTitle).toEqual(await order({ sort_by: 'title' }));
    });

    test('status sorts by the PILL (derived from the dates), not the stored value', async () => {
      // 302: stored Pending, due today → Due Today. 305: stored Overdue, deferred → Scheduled.
      expect(await order({ sort_by: 'status' })).toEqual([301, 302, 308, 303, 304, 305, 306, 307]);
      expect(await order({ sort_by: 'status', sort_dir: 'DESC' })).toEqual([307, 306, 305, 304, 308, 303, 302, 301]);
    });

    test('"today" is the FIRM day: 01:00 UTC on Oct 28 is still Oct 27 in Detroit', async () => {
      Settings.now = () => Date.parse('2026-10-28T01:00:00Z');
      expect(await order({ sort_by: 'status' })).toEqual([301, 302, 308, 303, 304, 305, 306, 307]);
    });

    test('due: undated last both ways', async () => {
      expect(await order({ sort_by: 'due' })).toEqual([306, 307, 305, 301, 302, 303, 308, 304]);
      expect(await order({ sort_by: 'due', sort_dir: 'DESC' })).toEqual([308, 303, 302, 301, 305, 307, 306, 304]);
    });

    test('text columns: case-insensitive, blanks last both ways, ties by due', async () => {
      expect(await order({ sort_by: 'title' })).toEqual([302, 301, 308, 303, 305, 306, 307, 304]);
      expect(await order({ sort_by: 'title', sort_dir: 'DESC' })).toEqual([307, 306, 305, 308, 303, 301, 302, 304]);
      expect(await order({ sort_by: 'to' })).toEqual([307, 305, 302, 308, 303, 306, 301, 304]);
      // 303 is from Automation (no users row): last both ways.
      expect(await order({ sort_by: 'by' })).toEqual([306, 305, 301, 304, 307, 302, 308, 303]);
      expect(await order({ sort_by: 'by', sort_dir: 'DESC' })).toEqual([307, 302, 308, 306, 305, 301, 304, 303]);
    });

    test('linked to: the title the column shows — a case without case_number_full (NULL or \'\') reads case_number', async () => {
      expect(await order({ sort_by: 'link' })).toEqual([302, 307, 301, 306, 305, 308, 303, 304]);
    });

    test('created both ways, task_id breaking the tie', async () => {
      expect(await order({ sort_by: 'created' })).toEqual([301, 302, 303, 308, 304, 305, 306, 307]);
      expect(await order({ sort_by: 'created', sort_dir: 'DESC' })).toEqual([307, 306, 305, 304, 308, 303, 302, 301]);
    });

    test('the route passes sort_by / sort_dir through', async () => {
      const r = await get('/api/tasks?status=All&limit=50&sort_by=due&sort_dir=DESC');
      expect(r.status).toBe(200);
      expect(ids(r.body.data, 'id')).toEqual([308, 303, 302, 301, 305, 307, 306, 304]);
      expect(ids((await get('/api/tasks?status=All&limit=50')).body.data, 'id')).toEqual(DEFAULT);
    });
  });

  // ── Custom-field columns in the list query (custom_table_view S4) ────────
  // The cases twin (cloned from ref/database.sql) already carries the live
  // cf_court VIRTUAL column; cf_multi and cf_drop get twins of the same shape
  // here. cf_notes deliberately has NO column: its def exists but is not
  // flagged, so the list_column gate — not luck — must keep it out of SQL.
  describe('cases cf columns (S4)', () => {
    beforeAll(async () => {
      // ref/database.sql regenerates from the LIVE schema at each land, so
      // once the S4 migration's commit lands this guard finds the column in
      // the clone and skips; until then the twin needs the migration's ALTER.
      const [has] = await q(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'field_defs' AND COLUMN_NAME = 'list_column'`);
      if (!has) {
        await q(`ALTER TABLE field_defs ADD COLUMN list_column tinyint(1) NOT NULL DEFAULT 0 AFTER indexed`);
      }
      await q(`INSERT INTO field_defs (entity, field_key, label, field_type, options, list_column, active) VALUES
        ('case', 'cf_court', 'Court', 'select',
         '[{"value":"MIEB","label":"Michigan Eastern"},{"value":"MIWB","label":"Michigan Western"}]', 1, 1),
        ('case', 'cf_notes', 'Internal Notes', 'text', NULL, 0, 1),
        ('case', 'cf_multi', 'Tags', 'multiselect', '[{"value":"a","label":"A"},{"value":"z","label":"Z"}]', 1, 1),
        ('case', 'cf_drop',  'Dropped Soon', 'text', NULL, 1, 1)`);
      // cf_notes gets a column too although UNFLAGGED: with no column, a
      // list_column-gate mutant would be masked by the 1054 retry's
      // column-intersect dropping it anyway.
      for (const k of ['cf_multi', 'cf_drop', 'cf_notes']) {
        await q(`ALTER TABLE cases ADD COLUMN \`${k}\` varchar(255)
          GENERATED ALWAYS AS (json_value(custom, '$.${k}' RETURNING CHAR(255))) VIRTUAL`);
      }
      await q(`UPDATE cases SET custom = JSON_OBJECT('cf_court', 'MIWB', 'cf_multi', 'z') WHERE case_id = 'CASEAAAA'`);
      await q(`UPDATE cases SET custom = JSON_OBJECT('cf_court', 'MIEB', 'cf_drop', 'x') WHERE case_id = 'CASEBBBB'`);
      await q(`UPDATE cases SET custom = JSON_OBJECT('cf_court', 'MIEB', 'cf_multi', 'a') WHERE case_id = 'CASECCCC'`);
      // CASEDDDD keeps custom NULL — its cf_court must ride as null, not vanish.
      fieldDefs.bump();
    });
    afterAll(() => fieldDefs.bump());

    const byId = (r) => Object.fromEntries(r.cases.map((c) => [c.case_id, c]));

    test('requested flagged keys ride on every row; unrequested rows carry no cf keys', async () => {
      const r = await caseService.listCases(pool, { cf: ['cf_court'], sort_by: 'c.case_id', sort_dir: 'ASC' });
      const rows = byId(r);
      expect(rows.CASEAAAA.cf_court).toBe('MIWB');
      expect(rows.CASEBBBB.cf_court).toBe('MIEB');
      expect(rows.CASEDDDD.cf_court).toBeNull();            // no custom JSON at all
      const bare = await caseService.listCases(pool, { sort_by: 'c.case_id', sort_dir: 'ASC' });
      expect('cf_court' in bare.cases[0]).toBe(false);
    });

    test('the list_column gate holds: an unflagged def never reaches SQL (its column exists and must stay unread)', async () => {
      const r = await caseService.listCases(pool, { cf: ['cf_notes', 'cf_court'] });
      expect('cf_notes' in r.cases[0]).toBe(false);
      expect('cf_court' in r.cases[0]).toBe(true);
    });

    test('an unknown key drops silently', async () => {
      const r = await caseService.listCases(pool, { cf: ['cf_nope'] });
      expect(r.total).toBe(4);
      expect('cf_nope' in r.cases[0]).toBe(false);
    });

    test('a hostile key never reaches SQL — the registry, not the client, names identifiers', async () => {
      const r = await caseService.listCases(pool, { cf: ['cf_x` , (SELECT 1)'] });
      expect(r.total).toBe(4);
    });

    test('a hand-written registry row with a malformed key is dropped too (KEY_RE re-check)', async () => {
      // The API shape-checks field_key at create, but a script or migration
      // writes rows without it — and field_key lands inside backticks.
      await q(`INSERT INTO field_defs (entity, field_key, label, field_type, list_column, active)
               VALUES ('case', 'cf_bad\`x', 'Hand Written', 'text', 1, 1)`);
      fieldDefs.bump();
      try {
        const r = await caseService.listCases(pool, { cf: ['cf_bad\`x', 'cf_court'] });
        expect(r.total).toBe(4);
        expect('cf_court' in r.cases[0]).toBe(true);
      } finally {
        await q('DELETE FROM field_defs WHERE label = ?', ['Hand Written']);
        fieldDefs.bump();
      }
    });

    test('sort by a requested scalar cf works, NULLs grouping per engine order', async () => {
      const asc = await caseService.listCases(pool, { cf: ['cf_court'], sort_by: 'cf_court', sort_dir: 'ASC' });
      expect(ids(asc.cases, 'case_id')).toEqual(['CASEDDDD', 'CASEBBBB', 'CASECCCC', 'CASEAAAA']);
      const desc = await caseService.listCases(pool, { cf: ['cf_court'], sort_by: 'cf_court', sort_dir: 'DESC' });
      expect(ids(desc.cases, 'case_id')).toEqual(['CASEAAAA', 'CASECCCC', 'CASEBBBB', 'CASEDDDD']);
    });

    test('a multiselect cf never sorts; an unrequested cf never sorts — both fall to the default', async () => {
      // cf_multi values (z, -, a, -) would reorder if the sort ran; the
      // default (open date, all equal → case_id) must come back instead.
      const multi = await caseService.listCases(pool, { cf: ['cf_multi'], sort_by: 'cf_multi', sort_dir: 'ASC' });
      expect(ids(multi.cases, 'case_id')).toEqual(['CASEAAAA', 'CASEBBBB', 'CASECCCC', 'CASEDDDD']);
      const unreq = await caseService.listCases(pool, { sort_by: 'cf_court', sort_dir: 'ASC' });
      expect(ids(unreq.cases, 'case_id')).toEqual(['CASEAAAA', 'CASEBBBB', 'CASECCCC', 'CASEDDDD']);
    });

    test('the ER 1054 stale-cache window: bust, recompose, retry once — the list never 500s', async () => {
      await fieldDefs.listActive(pool, 'case');              // warm the cache WITH cf_drop
      await q('ALTER TABLE cases DROP COLUMN cf_drop');      // the reconciler's drop…
      await q(`UPDATE field_defs SET active = 0 WHERE field_key = 'cf_drop'`);  // …after the def retired
      try {
        // The stale cache still offers cf_drop → the first SELECT throws 1054
        // → bump + recompose (fresh read: inactive, dropped) → retry carries
        // cf_court only.
        const r = await caseService.listCases(pool, { cf: ['cf_drop', 'cf_court'], sort_by: 'c.case_id', sort_dir: 'ASC' });
        expect(r.total).toBe(4);
        expect('cf_drop' in r.cases[0]).toBe(false);
        expect(byId(r).CASEBBBB.cf_court).toBe('MIEB');
        // And the cache really was busted: a second call works first try.
        const again = await caseService.listCases(pool, { cf: ['cf_drop', 'cf_court'] });
        expect(again.total).toBe(4);
      } finally {
        await q(`UPDATE field_defs SET active = 1 WHERE field_key = 'cf_drop'`);
        await q(`ALTER TABLE cases ADD COLUMN cf_drop varchar(255)
          GENERATED ALWAYS AS (json_value(custom, '$.cf_drop' RETURNING CHAR(255))) VIRTUAL`);
        fieldDefs.bump();
      }
    });

    test('an ACTIVE flagged def whose column never materialized cannot 500 the list', async () => {
      // createDef's reconcile is post-commit and can lose its lock with no
      // sweep behind it (CLAUDE.md) — the def then exists, flagged, while
      // its virtual column does not. Both the first SELECT and a registry-
      // only recompose would 1054; the retry must intersect with the columns
      // that actually exist (review-caught blocker).
      await fieldDefs.createDef(pool, {
        entity: 'case', field_key: 'cf_nocol', label: 'No Column', field_type: 'text', list_column: true,
      });
      try {
        const r = await caseService.listCases(pool, { cf: ['cf_nocol', 'cf_court'], sort_by: 'c.case_id', sort_dir: 'ASC' });
        expect(r.total).toBe(4);
        expect('cf_nocol' in r.cases[0]).toBe(false);   // blank until a reconcile lands it
        expect(byId(r).CASEBBBB.cf_court).toBe('MIEB'); // the healthy column still rides
      } finally {
        await q('DELETE FROM field_defs WHERE field_key = ?', ['cf_nocol']);
        fieldDefs.bump();
      }
    });

    test('a non-1054 error is rethrown untouched, never retried', async () => {
      let selects = 0;
      const wrapped = { query: async (sql, p) => {
        if (typeof sql === 'string' && sql.includes('JSON_ARRAYAGG')) {
          selects++;
          const e = new Error('boom'); e.code = 'ER_NO_SUCH_TABLE'; throw e;
        }
        return pool.query(sql, p);
      } };
      await expect(caseService.listCases(wrapped, { cf: ['cf_court'] })).rejects.toThrow('boom');
      expect(selects).toBe(1);                           // one attempt, no retry
    });

    test('the route: shape-checked cf, 400 on anything else', async () => {
      const ok = await get(`/api/cases?limit=50&cf=${encodeURIComponent('["cf_court"]')}`);
      expect(ok.status).toBe(200);
      expect(ok.body.cases.every((c) => 'cf_court' in c)).toBe(true);
      expect((await get('/api/cases?cf=not-json')).status).toBe(400);
      expect((await get(`/api/cases?cf=${encodeURIComponent('["CF_COURT"]')}`)).status).toBe(400);
      expect((await get(`/api/cases?cf=${encodeURIComponent('["cf_x` (SELECT 1)"]')}`)).status).toBe(400);
      expect((await get(`/api/cases?cf=${encodeURIComponent(JSON.stringify(Array(31).fill('cf_court')))}`)).status).toBe(400);
      expect((await get(`/api/cases?cf=${encodeURIComponent('[]')}`)).status).toBe(200);
    });

    test('the def write path: list_column is patchable and round-trips', async () => {
      const made = await fieldDefs.createDef(pool, {
        entity: 'case', field_key: 'cf_rt', label: 'Round Trip', field_type: 'text', list_column: true,
      });
      try {
        let defs = await fieldDefs.listActive(pool, 'case');
        expect(defs.find((d) => d.field_key === 'cf_rt').list_column).toBe(1);
        await fieldDefs.updateDef(pool, made.id, { list_column: 0 });
        defs = await fieldDefs.listActive(pool, 'case');
        expect(defs.find((d) => d.field_key === 'cf_rt').list_column).toBe(0);
      } finally {
        await q('DELETE FROM field_defs WHERE field_key = ?', ['cf_rt']);
        fieldDefs.bump();
      }
    });
  });

  describe('contacts cf columns (C1 — the listCases machinery, shared)', () => {
    beforeAll(async () => {
      // Contact-entity defs beside the S4 case ones (same field_defs table;
      // same key on both entities is allowed, UNIQUE is (entity, field_key)).
      // cf_lang / cf_cmulti / cf_cdrop need their virtual columns by hand —
      // the reconciler is mocked. cf_cnotes is UNFLAGGED but gets a real
      // column: with no column, a list_column-gate mutant would be masked by
      // the 1054 retry's column-intersect dropping it anyway.
      await q(`INSERT INTO field_defs (entity, field_key, label, field_type, options, list_column, active) VALUES
        ('contact', 'cf_lang', 'Preferred Language', 'select',
         '[{"value":"en","label":"English"},{"value":"es","label":"Spanish"},{"value":"yi","label":"Yiddish"}]', 1, 1),
        ('contact', 'cf_cnotes', 'Contact Notes', 'text', NULL, 0, 1),
        ('contact', 'cf_cmulti', 'Contact Tags', 'multiselect', '[{"value":"a","label":"A"},{"value":"z","label":"Z"}]', 1, 1),
        ('contact', 'cf_cdrop', 'Dropped Soon', 'text', NULL, 1, 1)`);
      // cf_court gets a CONTACTS column too although its def is case-entity:
      // with no column, an entity-crossing mutant would be masked by the 1054
      // retry's column-intersect dropping it anyway (review-caught — the
      // reviewer's crossing mutant survived the twin without this line).
      for (const k of ['cf_lang', 'cf_cnotes', 'cf_cmulti', 'cf_cdrop', 'cf_court']) {
        await q(`ALTER TABLE contacts ADD COLUMN \`${k}\` varchar(255)
          GENERATED ALWAYS AS (json_value(custom, '$.${k}' RETURNING CHAR(255))) VIRTUAL`);
      }
      await q(`UPDATE contacts SET custom = JSON_OBJECT('cf_lang', 'es') WHERE contact_id = 1`);
      await q(`UPDATE contacts SET custom = JSON_OBJECT('cf_lang', 'en', 'cf_cmulti', 'z') WHERE contact_id = 2`);
      await q(`UPDATE contacts SET custom = JSON_OBJECT('cf_lang', 'yi', 'cf_cdrop', 'x') WHERE contact_id = 4`);
      // every other contact keeps custom at its default {} — cf_lang rides null
      fieldDefs.bump();
    });
    afterAll(() => fieldDefs.bump());

    const byId = (r) => Object.fromEntries(r.contacts.map((c) => [c.contact_id, c]));
    const list = (o) => contactService.listContacts(pool, { limit: 100, ...o });

    test('requested flagged keys ride on every row; unrequested rows carry no cf keys', async () => {
      const r = await list({ cf: ['cf_lang'] });
      const rows = byId(r);
      expect(rows[1].cf_lang).toBe('es');
      expect(rows[2].cf_lang).toBe('en');
      expect(rows[3].cf_lang).toBeNull();                 // default {} custom
      const bare = await list({});
      expect('cf_lang' in bare.contacts[0]).toBe(false);
    });

    test('the list_column gate holds; unknown and hostile keys drop; a CASE def never crosses the entity', async () => {
      const r = await list({ cf: ['cf_cnotes', 'cf_nope', 'cf_x` , (SELECT 1)', 'cf_court', 'cf_lang'] });
      expect(r.total).toBe(9);
      expect('cf_cnotes' in r.contacts[0]).toBe(false);   // unflagged (its column exists and must stay unread)
      expect('cf_nope' in r.contacts[0]).toBe(false);
      // cf_court is a flagged CASE def (S4 section) — entity scoping drops it here
      expect('cf_court' in r.contacts[0]).toBe(false);
      expect('cf_lang' in r.contacts[0]).toBe(true);
    });

    test('a hand-written registry row with a malformed key is dropped too (KEY_RE re-check)', async () => {
      await q(`INSERT INTO field_defs (entity, field_key, label, field_type, list_column, active)
               VALUES ('contact', 'cf_cbad\`x', 'Hand Written', 'text', 1, 1)`);
      fieldDefs.bump();
      try {
        const r = await list({ cf: ['cf_cbad\`x', 'cf_lang'] });
        expect(r.total).toBe(9);
        expect('cf_lang' in r.contacts[0]).toBe(true);
      } finally {
        await q('DELETE FROM field_defs WHERE label = ?', ['Hand Written']);
        fieldDefs.bump();
      }
    });

    test('sort by a requested scalar cf works; the contact_id tiebreak stays ASC (house order)', async () => {
      const asc = await list({ cf: ['cf_lang'], sort_by: 'cf_lang', sort_dir: 'ASC' });
      expect(ids(asc.contacts, 'contact_id')).toEqual([3, 5, 6, 7, 8, 9, 2, 1, 4]);
      const desc = await list({ cf: ['cf_lang'], sort_by: 'cf_lang', sort_dir: 'DESC' });
      expect(ids(desc.contacts, 'contact_id')).toEqual([4, 1, 2, 3, 5, 6, 7, 8, 9]);
    });

    test('a multiselect cf never sorts; an unrequested cf never sorts — both fall to the default', async () => {
      const multi = await list({ cf: ['cf_cmulti'], sort_by: 'cf_cmulti', sort_dir: 'ASC' });
      // default: contact_lname ASC, contact_fname ASC, contact_id ASC
      expect(ids(multi.contacts, 'contact_id').slice(0, 3)).toEqual([6, 3, 7]);
      const unreq = await list({ sort_by: 'cf_lang', sort_dir: 'ASC' });
      expect(ids(unreq.contacts, 'contact_id').slice(0, 3)).toEqual([6, 3, 7]);
    });

    test('birthdays still outranks a cf sort (FIELD order wins, params aligned across the retry shape)', async () => {
      const r = await list({ cf: ['cf_lang'], sort_by: 'cf_lang', sort_dir: 'DESC',
        birthdays: 'next7', today: '2026-10-27' });
      // Window Oct 27–Nov 2: Di (10-27), Pat (10-29), Abe (11-02) — FIELD order,
      // not cf_lang DESC (which would put Pat/es before Di/null).
      expect(ids(r.contacts, 'contact_id')).toEqual([9, 1, 2]);
    });

    test('the ER 1054 stale-cache window: bust, recompose, retry once — the list never 500s', async () => {
      await fieldDefs.listActive(pool, 'contact');             // warm the cache WITH cf_cdrop
      await q('ALTER TABLE contacts DROP COLUMN cf_cdrop');
      await q(`UPDATE field_defs SET active = 0 WHERE entity = 'contact' AND field_key = 'cf_cdrop'`);
      try {
        const r = await list({ cf: ['cf_cdrop', 'cf_lang'] });
        expect(r.total).toBe(9);
        expect('cf_cdrop' in r.contacts[0]).toBe(false);
        expect(byId(r)[1].cf_lang).toBe('es');
        const again = await list({ cf: ['cf_cdrop', 'cf_lang'] });
        expect(again.total).toBe(9);
      } finally {
        await q(`UPDATE field_defs SET active = 1 WHERE entity = 'contact' AND field_key = 'cf_cdrop'`);
        await q(`ALTER TABLE contacts ADD COLUMN cf_cdrop varchar(255)
          GENERATED ALWAYS AS (json_value(custom, '$.cf_cdrop' RETURNING CHAR(255))) VIRTUAL`);
        fieldDefs.bump();
      }
    });

    test('an ACTIVE flagged def whose column never materialized cannot 500 the list', async () => {
      await fieldDefs.createDef(pool, {
        entity: 'contact', field_key: 'cf_cnocol', label: 'No Column', field_type: 'text', list_column: true,
      });
      try {
        const r = await list({ cf: ['cf_cnocol', 'cf_lang'] });
        expect(r.total).toBe(9);
        expect('cf_cnocol' in r.contacts[0]).toBe(false);  // blank until a reconcile lands it
        expect(byId(r)[2].cf_lang).toBe('en');             // the healthy column still rides
      } finally {
        await q('DELETE FROM field_defs WHERE field_key = ?', ['cf_cnocol']);
        fieldDefs.bump();
      }
    });

    test('a non-1054 error is rethrown untouched, never retried', async () => {
      let selects = 0;
      const wrapped = { query: async (sql, p) => {
        if (typeof sql === 'string' && sql.includes('JSON_ARRAYAGG')) {
          selects++;
          const e = new Error('boom'); e.code = 'ER_NO_SUCH_TABLE'; throw e;
        }
        return pool.query(sql, p);
      } };
      await expect(contactService.listContacts(wrapped, { cf: ['cf_lang'] })).rejects.toThrow('boom');
      expect(selects).toBe(1);
    });

    test('the route: shape-checked cf, 400 on anything else', async () => {
      const ok = await get(`/api/contacts?limit=50&cf=${encodeURIComponent('["cf_lang"]')}`);
      expect(ok.status).toBe(200);
      expect(ok.body.contacts.every((c) => 'cf_lang' in c)).toBe(true);
      expect((await get('/api/contacts?cf=not-json')).status).toBe(400);
      expect((await get(`/api/contacts?cf=${encodeURIComponent('["CF_LANG"]')}`)).status).toBe(400);
      expect((await get(`/api/contacts?cf=${encodeURIComponent('["cf_x` (SELECT 1)"]')}`)).status).toBe(400);
      expect((await get(`/api/contacts?cf=${encodeURIComponent(JSON.stringify(Array(31).fill('cf_lang')))}`)).status).toBe(400);
      expect((await get(`/api/contacts?cf=${encodeURIComponent('[]')}`)).status).toBe(200);
    });
  });
});
