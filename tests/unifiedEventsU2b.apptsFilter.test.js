// tests/unifiedEventsU2b.apptsFilter.test.js
//
/**
 * Unified Events U2b — the Appointments-tab type filter (GET /api/appts).
 *
 * The tab's #tabApptsType dropdown was a hardcoded label list filtering on
 * appts.appt_type. It now builds itself from the registry (active kind='meeting'
 * types) and filters on appts.type_key. These tests pin the SQL that change
 * depends on:
 *
 *   KEY FILTER     type_key → `appts.type_key = ?`, one bind, no label clause
 *   DEFAULT        exclude_type_key is NULL-SAFE — an appt with no type_key
 *                  stays in the default view. The label-based exclude_type it
 *                  replaced does not, and that difference is asserted directly.
 *   OTHER          `unmapped=1` is the COMPLEMENT of the dropdown, not merely
 *                  the unmapped rows: NULL, plus any key outside the active
 *                  meeting set (a hearing key, the deactivated `test`). The
 *                  NOT IN list is asserted to EQUAL the list the dropdown
 *                  builds from GET /api/calendar-types?kind=meeting&active=1,
 *                  so no appointment can fall between the options.
 *   DEGRADED       registry unreachable → narrows to `type_key IS NULL` rather
 *                  than returning every appointment as "Other".
 *   LEGACY         type / exclude_type still work for any caller still on them.
 *
 * Harness follows tests/apiCalendarTypes.routes.test.js: mocked auth, a real
 * listen(0), the registry PRIMED from the seed fixture, and a db stub that
 * records every (sql, params) pair instead of talking to MySQL.
 *
 * Run:  npx jest tests/unifiedEventsU2b.apptsFilter.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const express = require('express');
const calendarTypeService = require('../services/calendarTypeService');
const SEED   = require('./fixtures/calendar_item_types.seed.json');
const router = require('../routes/api.appts');

// Every db.query is recorded. Shapes: the count query needs [[{counter}]], the
// rows query only needs an array; `SELECT COUNT` routes between them.
let queries = [];
const db = {
  query: jest.fn(async (sql, params) => {
    queries.push({ sql, params });
    return /SELECT COUNT/i.test(sql) ? [[{ counter: 0 }]] : [[]];
  }),
};

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = db; next(); });
app.use(router);

let server, base;
beforeAll(async () => {
  calendarTypeService._primeCache(SEED);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  calendarTypeService.invalidate();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => { queries = []; jest.clearAllMocks(); });

/** Run the list route and hand back its rows query (the first non-COUNT one). */
async function listQuery(qs = '') {
  queries = [];                       // per CALL, not per test — several tests
                                      // compare two requests back to back
  const res = await fetch(`${base}/api/appts${qs}`);
  expect(res.status).toBe(200);
  return queries.find((q) => !/SELECT COUNT/i.test(q.sql));
}

/** The exact set the dropdown renders. */
const dropdownKeys = () =>
  SEED.filter((t) => t.kind === 'meeting' && t.active === 1).map((t) => t.type_key);

test('type_key → a single keyed equality, and no label clause rides along', async () => {
  const q = await listQuery('?type_key=ss_follow_up');
  expect(q.sql).toContain('appts.type_key = ?');
  expect(q.sql).not.toContain('appts.appt_type = ?');
  // params order is [ ...filters, limit, offset ]
  expect(q.params.slice(0, -2)).toEqual(['ss_follow_up']);
});

test('Default excludes the 341 NULL-safely — an untyped appt survives it', async () => {
  const q = await listQuery('?exclude_type_key=meeting_341');
  expect(q.sql).toContain('(appts.type_key IS NULL OR appts.type_key != ?)');
  expect(q.params.slice(0, -2)).toEqual(['meeting_341']);

  // The label form it replaced drops untyped rows: `!= ` is never true for NULL.
  const legacy = await listQuery('?exclude_type=341%20Meeting');
  expect(legacy.sql).toContain('appts.appt_type != ?');
  expect(legacy.sql).not.toContain('appt_type IS NULL OR');
});

test('Other is the complement of the dropdown, not just the unmapped rows', async () => {
  const q = await listQuery('?unmapped=1');
  const keys = dropdownKeys();

  expect(q.sql).toContain('appts.type_key IS NULL OR appts.type_key NOT IN');
  expect(q.params.slice(0, -2)).toEqual(keys);

  // The point of the complement: keys that exist but are NOT offered.
  expect(keys).not.toContain('hearing');          // kind=hearing → never listed
  expect(keys).not.toContain('docs_deadline');    // kind=deadline → never listed
  expect(keys).not.toContain('test');             // active=0     → never listed
  expect(keys).toContain('meeting_341');          // listed, so NOT "Other"
});

test('nothing falls between the options: dropdown ∪ Other covers every seeded key', async () => {
  const q = await listQuery('?unmapped=1');
  const listed = new Set(q.params.slice(0, -2));   // what "Other" excludes
  const offered = new Set(dropdownKeys());         // what the dropdown offers

  expect(listed).toEqual(offered);                 // the two lists are one list

  // Every registry key is reachable: either it is an option, or Other claims it.
  for (const t of SEED) {
    const reachable = offered.has(t.type_key) || !listed.has(t.type_key);
    expect(reachable).toBe(true);
  }
  // …and so is a key the registry has never heard of, plus NULL.
  expect(listed.has('some_retired_key')).toBe(false);
});

test('registry failure degrades Other to unmapped-only, not to everything', async () => {
  const spy = jest.spyOn(calendarTypeService, 'listTypes')
    .mockRejectedValueOnce(new Error('registry down'));
  const q = await listQuery('?unmapped=1');
  expect(q.sql).toContain('appts.type_key IS NULL');
  expect(q.sql).not.toContain('NOT IN');
  expect(q.params.slice(0, -2)).toEqual([]);
  spy.mockRestore();
});

test('legacy label params are untouched', async () => {
  const q = await listQuery('?type=Strategy%20Session');
  expect(q.sql).toContain('appts.appt_type = ?');
  expect(q.params.slice(0, -2)).toEqual(['Strategy Session']);
});

test('filters compose: status + Default + a date window', async () => {
  const q = await listQuery('?status=Scheduled&exclude_type_key=meeting_341&from=2026-01-01');
  expect(q.params.slice(0, -2)).toEqual(['Scheduled', '2026-01-01 00:00:00', 'meeting_341']);
  expect(q.sql).toContain('WHERE');
});
