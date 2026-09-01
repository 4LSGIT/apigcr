// tests/apiCalendarTypes.routes.test.js
//
/**
 * Unified Events U2 — routes/api.calendarTypes.js
 *
 * GET /api/calendar-types with kind (CSV / repeated), active, case_type
 * filters; auth via jwtOrApiKey; envelope { status:'success', data:[…] };
 * the eventform picker's exact query returns the four non-meeting kinds and
 * no inactive rows; a service failure maps to 500.
 *
 * Run:  npx jest tests/apiCalendarTypes.routes.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const express = require('express');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const calendarTypeService = require('../services/calendarTypeService');
const SEED   = require('./fixtures/calendar_item_types.seed.json');
const router = require('../routes/api.calendarTypes');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = { marker: 'pool' }; next(); });
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
beforeEach(() => jest.clearAllMocks());

const get = (qs = '') => fetch(`${base}/api/calendar-types${qs}`);

test('no filters → every registry row, in registry order, full shape', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('success');
  expect(body.data).toHaveLength(SEED.length);
  expect(body.data[0]).toMatchObject({ type_key: 'iss', label: 'Initial Strategy Session', kind: 'meeting',
    singleton: 0, blocks_default: 'attendee', client_attends: 1, default_length: 15,
    ingest_aliases: ['Intial Strategy Session'], case_types: null, active: 1, sort_order: 10 });
  expect(jwtOrApiKey).toHaveBeenCalledTimes(1);
});

test("the eventform picker query: kind=hearing,deadline,conference,other&active=1 — no meetings, no inactive", async () => {
  const body = await (await get('?kind=hearing,deadline,conference,other&active=1')).json();
  const kinds = new Set(body.data.map((r) => r.kind));
  expect(kinds.has('meeting')).toBe(false);
  expect([...kinds].sort()).toEqual(['conference', 'deadline', 'hearing', 'other']);
  expect(body.data.some((r) => r.active === 0)).toBe(false);
  expect(body.data.map((r) => r.type_key)).not.toContain('test');
  expect(body.data.map((r) => r.type_key)).toContain('internal');
});

test('repeated kind params and active=0 and case_type', async () => {
  const rep = await (await get('?kind=hearing&kind=conference')).json();
  expect(new Set(rep.data.map((r) => r.kind))).toEqual(new Set(['hearing', 'conference']));

  const inactive = await (await get('?active=0')).json();
  expect(inactive.data.map((r) => r.type_key)).toEqual(['test']);

  const civ = await (await get('?kind=meeting&case_type=Civil%20Litigation')).json();
  const keys = civ.data.map((r) => r.type_key);
  expect(keys).toContain('pre_lawsuit');
  expect(keys).toContain('iss');            // NULL case_types = all
  expect(keys).not.toContain('pre_filing'); // Bankruptcy-scoped
});

test('service failure → 500 with the generic message', async () => {
  const spy = jest.spyOn(calendarTypeService, 'listTypes').mockRejectedValueOnce(new Error('boom'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const res = await get();
  expect(res.status).toBe(500);
  expect((await res.json()).message).toBe('Failed to fetch calendar types');
  spy.mockRestore();
  console.error.mockRestore();
});
