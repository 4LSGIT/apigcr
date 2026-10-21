// tests/logCommDate.routes.test.js
//
/**
 * log-comm-date — routes/api.log.js over the real logService.
 *
 * POST /api/log `date`: when the logged communication happened. A naive value
 * is FIRM time and reaches the INSERT as the matching UTC instant (the
 * service's CONVERT_TZ(?, '+00:00', 'EST5EDT') turns it back into the firm
 * wall clock — tests/logCommDate.mysql.test.js proves that half on the
 * engine). Handing the raw string to createLogEntry instead would read it as
 * UTC: a 4-5 hour shift, the previous day for a date-only value. Future dates
 * are refused; the typing time lands in log_extra.logged_at.
 *
 * GET /api/log `sort`: asc | desc on log_date, with the log_id tiebreak.
 *
 * Auth is mocked (route-test idiom); the db is a fake that records SQL.
 *
 * Run:  npx jest tests/logCommDate.routes.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 1 }; next(); }));

const express = require('express');

const calls = [];
const db = {
  query: jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/^\s*INSERT INTO log\b/.test(sql)) return [{ insertId: 77 }];
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 0 }]];
    return [[]];
  }),
};

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = db; next(); });
app.use(require('../routes/api.log'));

let server, base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { calls.length = 0; jest.clearAllMocks(); });

const post = async (body) => {
  const r = await fetch(`${base}/api/log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};
const get = async (qs) => {
  const r = await fetch(`${base}/api/log${qs}`);
  return { status: r.status, json: await r.json() };
};
const insert = () => {
  const c = calls.filter((x) => /^\s*INSERT INTO log\b/.test(x.sql));
  expect(c).toHaveLength(1);
  return c[0];
};
// INSERT params: [0] log_type, then the log_date param ONLY when a date was
// given, then log_link, log_link_type, log_link_id, log_about_type,
// log_about_id, log_by, log_data, log_extra — so log_extra is [8] without a
// date and [9] with one.
const CALL = { type: 'call', link_type: 'contact', link_id: '2111', data: '{"note":"n"}', direction: 'incoming' };

describe('POST /api/log date', () => {
  test('no date: the server stamps NOW() and log_extra stays as sent', async () => {
    const r = await post(CALL);
    expect(r.status).toBe(200);
    const { sql, params } = insert();
    expect(sql).toContain("CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT')");
    expect(params[0]).toBe('call');
    expect(params[8]).toBeNull(); // log_extra
  });

  test.each([
    ['summer (EDT, UTC-4)', '2026-10-18T14:30', '2026-10-18 18:30:00'],
    ['winter (EST, UTC-5)', '2026-01-05T09:15', '2026-01-05 14:15:00'],
    ['SQL-style naive is firm time too', '2026-10-18 14:30:00', '2026-10-18 18:30:00'],
    ['date-only = firm midnight, not the day before', '2026-10-18', '2026-10-18 04:00:00'],
    ['explicit Z is honoured', '2026-10-18T18:30:00Z', '2026-10-18 18:30:00'],
  ])('%s → the UTC instant the INSERT converts back', async (_l, date, utc) => {
    const before = Date.now();
    const r = await post({ ...CALL, date });
    expect(r.status).toBe(200);
    const { sql, params } = insert();
    expect(sql).toContain("CONVERT_TZ(?, '+00:00', 'EST5EDT')");
    expect(params[1]).toBe(utc);
    const extra = JSON.parse(params[9]);
    expect(Object.keys(extra)).toEqual(['logged_at']);
    const at = Date.parse(extra.logged_at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('logged_at merges into a caller-sent extra (object or JSON string)', async () => {
    await post({ ...CALL, date: '2026-10-18T14:30', extra: { source: 'x' } });
    expect(JSON.parse(insert().params[9])).toMatchObject({ source: 'x', logged_at: expect.any(String) });
    calls.length = 0;
    await post({ ...CALL, date: '2026-10-18T14:30', extra: '{"source":"y"}' });
    expect(JSON.parse(insert().params[9])).toMatchObject({ source: 'y', logged_at: expect.any(String) });
  });

  test('a future date is refused, nothing written', async () => {
    const r = await post({ ...CALL, date: '2099-01-01T00:00' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/future/);
    expect(calls.some((x) => /INSERT INTO log/.test(x.sql))).toBe(false);
  });

  test('a garbage date is a 400, nothing written', async () => {
    const r = await post({ ...CALL, date: 'last tuesday' });
    expect(r.status).toBe(400);
    expect(calls.some((x) => /INSERT INTO log/.test(x.sql))).toBe(false);
  });
});

describe('GET /api/log sort', () => {
  const listSql = () => {
    const c = calls.find((x) => /FROM log l/.test(x.sql) && /ORDER BY/.test(x.sql));
    expect(c).toBeDefined();
    return c.sql;
  };

  test('default: newest first with the log_id tiebreak', async () => {
    expect((await get('?link_type=contact&link_id=2111')).status).toBe(200);
    expect(listSql()).toMatch(/ORDER BY l\.log_date DESC, l\.log_id DESC\s+LIMIT/);
  });

  test('sort=asc: oldest first, tiebreak follows', async () => {
    expect((await get('?link_type=contact&link_id=2111&sort=asc')).status).toBe(200);
    expect(listSql()).toMatch(/ORDER BY l\.log_date ASC, l\.log_id ASC\s+LIMIT/);
  });

  test('anything else is a 400 (it is interpolated into the SQL)', async () => {
    const r = await get('?sort=log_id;DROP');
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
