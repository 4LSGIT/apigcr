// tests/apptsSearch.picker.test.js
//
/**
 * GET /api/appts — the free-text `q` filter behind apptform2.html's picker.
 *
 * Every other filter on this route is an exact match or a range. `q` is the one
 * a human types, so it is the one with branches worth pinning:
 *
 *   COLUMNS     contact name, both docket spellings, and the appt_type LABEL —
 *               the drifted free text, on purpose, because the label is what
 *               the picker renders. NOT type_key.
 *   NUMERIC     a digits-only term ALSO matches appt_id exactly, bound as an
 *               integer. A non-numeric term must NOT emit that clause: MySQL
 *               would coerce `appt_id = 'bob'` to `appt_id = 0` and silently
 *               return the wrong rows rather than none.
 *   BLANK       absent / empty / whitespace-only adds nothing, so the picker's
 *               unsearched first page is byte-for-byte the old list call.
 *   COUNT PARITY the rows query and the count query share one whereSql/params
 *               pair. If they ever drift, the picker's "N of M" lies and its
 *               pager runs off the end of a result set that was never that big.
 *   NO NEW JOIN contacts and cases are already LEFT JOINed by BOTH queries;
 *               users is joined by the rows query ONLY, which is why user_name
 *               is deliberately not searchable.
 *
 * Harness follows tests/unifiedEventsU2b.apptsFilter.test.js: mocked auth, a
 * real listen(0), and a db stub recording every (sql, params) pair.
 *
 * Run:  npx jest tests/apptsSearch.picker.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const express = require('express');
const router  = require('../routes/api.appts');

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
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { queries = []; jest.clearAllMocks(); });

/** Run the list route; hand back both queries it issued. */
async function list(qs = '') {
  queries = [];
  const res = await fetch(`${base}/api/appts${qs}`);
  expect(res.status).toBe(200);
  return {
    rows:  queries.find((q) => !/SELECT COUNT/i.test(q.sql)),
    count: queries.find((q) => /SELECT COUNT/i.test(q.sql)),
  };
}

/** The rows query binds [...filters, limit, offset]; the count query binds only filters. */
const filterParams = (rowsQuery) => rowsQuery.params.slice(0, -2);

const SEARCH_COLUMNS = [
  'contacts.contact_name LIKE ?',
  'cases.case_number LIKE ?',
  'cases.case_number_full LIKE ?',
  'appts.appt_type LIKE ?',
];

test('a text term LIKEs the four human-typed columns and nothing else', async () => {
  const { rows } = await list('?q=smith');
  SEARCH_COLUMNS.forEach((c) => expect(rows.sql).toContain(c));
  expect(filterParams(rows)).toEqual(['%smith%', '%smith%', '%smith%', '%smith%']);
});

test('a text term does NOT emit the id clause — `appt_id = "bob"` is `appt_id = 0`', async () => {
  const { rows } = await list('?q=bob');
  expect(rows.sql).not.toContain('appts.appt_id = ?');
  expect(filterParams(rows)).toHaveLength(4);
});

test('a digits-only term adds an exact id match, bound as a number', async () => {
  const { rows } = await list('?q=1234');
  expect(rows.sql).toContain('appts.appt_id = ?');
  expect(filterParams(rows)).toEqual(['%1234%', '%1234%', '%1234%', '%1234%', 1234]);
  // The id is an OR arm inside the search group, not a second AND condition —
  // searching "1234" must still find a contact whose phone-ish name matches.
  expect(rows.sql).toMatch(/OR appts\.appt_id = \?\)/);
});

test('the search group is ONE parenthesised OR, so it ANDs cleanly with other filters', async () => {
  const { rows } = await list('?q=smith&status=Scheduled&appt_with=7');
  expect(rows.sql).toContain('appts.appt_status = ?');
  expect(rows.sql).toContain('appts.appt_with = ?');
  expect(filterParams(rows)).toEqual(['Scheduled', '7', '%smith%', '%smith%', '%smith%', '%smith%']);
});

test.each([['absent', ''], ['empty', '?q='], ['whitespace', '?q=%20%20']])(
  'a %s term adds no clause and no bind — the unsearched page is the old list call',
  async (_label, qs) => {
    const { rows } = await list(qs);
    expect(rows.sql).not.toContain('LIKE ?');
    expect(filterParams(rows)).toEqual([]);
  },
);

test('the count query binds exactly what the rows query filters on', async () => {
  // The picker paginates off `counter`. A count computed over a different WHERE
  // reports a total the rows can never reach.
  const { rows, count } = await list('?q=1234&status=Attended');
  expect(count.params).toEqual(filterParams(rows));
  expect(count.sql).toContain('appts.appt_id = ?');
});

test('search needs no join the count query lacks', async () => {
  const { count } = await list('?q=smith');
  expect(count.sql).toContain('LEFT JOIN contacts');
  expect(count.sql).toContain('LEFT JOIN cases');
  // users is rows-only — asserted so that widening the search to user_name is
  // forced to notice it must add the join in two places, not one.
  expect(count.sql).not.toContain('LEFT JOIN users');
});

test('% and _ are passed through as the literal term, not re-escaped into a new pattern', async () => {
  // Documenting today's behaviour: a term containing a wildcard is a wildcard.
  // Harmless for a staff-only picker (worst case is a broad match), and worth a
  // failing test the day someone decides it should not be.
  const { rows } = await list('?q=%25');
  expect(filterParams(rows)).toEqual(['%%%', '%%%', '%%%', '%%%']);
});
