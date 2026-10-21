/**
 * tests/requestIdempotency.test.js — canonical request idempotency
 * (lib/requestIdempotency.js) and its wiring into the six create routes Ask
 * Casey's shipped families drive. Run: npx jest tests/requestIdempotency.test.js
 *
 * HARNESS. The REAL routers and the REAL lib/auth.jwtOrApiKey run over an
 * express app on an ephemeral port. The database is a stateful fake that
 * implements exactly the four statements lib/requestIdempotency.js issues
 * (taken from its exported SQL, so a changed statement cannot quietly stop
 * being tested) plus the auth audit insert; any other statement THROWS. The
 * create SERVICES are spied — they are the boundary this module guards, and
 * the spy is how "exactly one record" is counted.
 *
 * THE SQL ITSELF IS HELD TO A REAL ENGINE in tests/requestIdempotency.mysql.test.js
 * (gated on YC_TEST_MYSQL_URL): the unique key, the ER_DUP_ENTRY race, the JSON
 * round-trip and the server-side staleness age cannot be proved by a fake.
 *
 * WHAT IS PINNED (every assertion mutation-checked — the slice report lists
 * each mutation):
 *   no key      a caller that sends no Idempotency-Key is untouched: fn runs,
 *               the database is never touched by this module, no `replayed`
 *               field appears, and two identical submissions create two
 *               records. A key in the BODY is not a key.
 *   validation  absent/blank = none; malformed (too short, too long, bad
 *               chars, repeated header) is a 400 and nothing is written; an
 *               actor id outside users.user's TINYINT range is refused, not
 *               clamped.
 *   claim       the claim must be committed before fn runs, so the pool is
 *               required and a transaction connection is refused.
 *   replay      the same key twice runs fn ONCE; the second call returns the
 *               stored canonical result with replayed:true.
 *   race        a second submission while the first is in flight is 409
 *               outcome 'in_flight' and does not reach the service.
 *   unknown     a claim left in_flight past the staleness window is 409
 *               outcome 'unknown' — never taken over, never re-run.
 *   failure     a failed fn releases the claim (the key is reusable) and the
 *               route's own error is what surfaces.
 *   bookkeeping a settle that fails does not fail the committed operation.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'request-idem-test-secret';

const express = require('express');
const jwt = require('jsonwebtoken');

const idem = require('../lib/requestIdempotency');
const { withIdempotency, readIdempotencyKey, idempotencyActorId, SQL, IN_FLIGHT_STALE_SECONDS } = idem;

const taskService = require('../services/taskService');
const eventService = require('../services/eventService');
const apptService = require('../services/apptService');
const phoneSvc = require('../services/contactPhoneService');
const emailSvc = require('../services/contactEmailService');
const addrSvc = require('../services/contactAddressService');

const USER = 6;

// ─────────────────────────────────────────────────────────────────────────────
// The fake database: the four statements this module issues, nothing else.
// ─────────────────────────────────────────────────────────────────────────────
function makePool() {
  const rows = [];
  let nextId = 1;
  const seen = [];
  const pool = {
    // Present so the module's pool check passes; never called by it.
    getConnection: async () => { throw new Error('the fake pool hands out no connections'); },
    async query(sql, params) {
      // lib/auth.jwtOrApiKey's fire-and-forget audit row.
      if (/INSERT INTO jwt_api_audit_log/.test(sql)) return [{ affectedRows: 1 }];
      seen.push(sql);
      if (sql === SQL.claim) {
        const [user_id, scope, idem_key] = params;
        if (rows.some(r => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
          const err = new Error(`Duplicate entry '${user_id}-${scope}-${idem_key}'`);
          err.code = 'ER_DUP_ENTRY';
          throw err;
        }
        const row = { id: nextId++, user_id, scope, idem_key, status: 'in_flight', result: null, updated_at: Date.now() };
        rows.push(row);
        return [{ insertId: row.id, affectedRows: 1 }];
      }
      if (sql === SQL.read) {
        const [user_id, scope, idem_key] = params;
        const row = rows.find(r => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key);
        if (!row) return [[]];
        // Mirrors TIMESTAMPDIFF(SECOND, updated_at, NOW()).
        return [[{ id: row.id, status: row.status, result: row.result, age_s: Math.floor((Date.now() - row.updated_at) / 1000) }]];
      }
      if (sql === SQL.settle) {
        const [json, id] = params;
        const row = rows.find(r => r.id === id && r.status === 'in_flight');
        if (!row) return [{ affectedRows: 0 }];
        if (pool.failSettle) throw new Error('settle exploded');
        row.status = 'applied';
        row.result = JSON.parse(json);   // a JSON column comes back parsed
        row.updated_at = Date.now();
        return [{ affectedRows: 1 }];
      }
      if (sql === SQL.release) {
        const [id] = params;
        const i = rows.findIndex(r => r.id === id && r.status === 'in_flight');
        if (i < 0) return [{ affectedRows: 0 }];
        rows.splice(i, 1);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  pool.rows = rows;
  pool.seen = seen;
  pool.failSettle = false;
  /** Age the single in-flight claim so the staleness window has passed. */
  pool.backdate = (seconds) => { for (const r of rows) r.updated_at = Date.now() - seconds * 1000; };
  return pool;
}

const req = (headers = {}, userId = USER) => ({ headers, auth: { userId }, db: makePool() });

// ─────────────────────────────────────────────────────────────────────────────
describe('key reading and validation', () => {
  test('absent and blank keys are "no key"', () => {
    expect(readIdempotencyKey({ headers: {} })).toBeNull();
    expect(readIdempotencyKey({ headers: { 'idempotency-key': '' } })).toBeNull();
    expect(readIdempotencyKey({ headers: { 'idempotency-key': '   ' } })).toBeNull();
  });

  test('a well-formed key is returned trimmed', () => {
    expect(readIdempotencyKey({ headers: { 'idempotency-key': ' 4f1c9e22-1b0a-4a5e-9f7e-0c3a8d5b1e77 ' } }))
      .toBe('4f1c9e22-1b0a-4a5e-9f7e-0c3a8d5b1e77');
  });

  test('malformed keys are rejected 400, never truncated or ignored', () => {
    const bad = [
      'short7',                       // 6 chars, under the floor
      'a'.repeat(101),                // over varchar(100) — relaxed sql_mode would TRUNCATE
      'has space here',               // whitespace
      'semi;colon;key!',              // outside the charset
      '-leadinghyphen',               // must start alphanumeric
      'new\nline-key-value',          // control char
    ];
    for (const k of bad) {
      let err = null;
      try { readIdempotencyKey({ headers: { 'idempotency-key': k } }); } catch (e) { err = e; }
      expect(err && err.idempotency).toEqual({ status: 400, outcome: 'invalid_key' });
    }
    // Exactly 100 chars still passes — the boundary is the column width.
    expect(readIdempotencyKey({ headers: { 'idempotency-key': 'k'.repeat(100) } })).toBe('k'.repeat(100));
  });

  test('a repeated header is ambiguous and refused', () => {
    expect(() => readIdempotencyKey({ headers: { 'idempotency-key': ['aaaaaaaa', 'bbbbbbbb'] } }))
      .toThrow(/at most once/);
  });

  test('the actor is users.user, 0 when the request carries no staff user, and never clamped', () => {
    expect(idempotencyActorId({ auth: { userId: 6 } })).toBe(6);
    expect(idempotencyActorId({ auth: { userId: '22' } })).toBe(22);
    expect(idempotencyActorId({ auth: {} })).toBe(0);
    expect(idempotencyActorId({})).toBe(0);
    // users.user is TINYINT: 300 would be stored as 127 (relaxed sql_mode) and
    // scope another user's claims. Refused instead.
    let err = null;
    try { idempotencyActorId({ auth: { userId: 300 } }); } catch (e) { err = e; }
    expect(err && err.idempotency).toEqual({ status: 400, outcome: 'invalid_actor' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('withIdempotency', () => {
  test('no key: fn runs and the database is never touched', async () => {
    const pool = makePool();
    const fn = jest.fn().mockResolvedValue({ task_id: 7 });
    const out = await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: null }, fn);
    expect(out).toEqual({ value: { task_id: 7 }, replayed: false, idempotent: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pool.seen).toEqual([]);
    expect(pool.rows).toEqual([]);
  });

  test('a transaction connection is refused: the claim could not commit before fn', async () => {
    const conn = { query: async () => [{ insertId: 1 }] };   // no getConnection
    const fn = jest.fn();
    await expect(withIdempotency(conn, { userId: USER, scope: 's.create', key: 'key-one-1234' }, fn))
      .rejects.toThrow(/requires the database pool/);
    expect(fn).not.toHaveBeenCalled();
  });

  test('the same key twice runs fn once and replays the stored result', async () => {
    const pool = makePool();
    const fn = jest.fn().mockResolvedValue({ task_id: 9, nested: { a: [1, 2] } });
    const first = await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'key-one-1234' }, fn);
    const second = await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'key-one-1234' }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ value: { task_id: 9 }, replayed: false, recorded: true });
    expect(second).toEqual({ value: { task_id: 9, nested: { a: [1, 2] } }, replayed: true, idempotent: true });
    expect(pool.rows).toHaveLength(1);
    expect(pool.rows[0].status).toBe('applied');
  });

  test('the key is scoped: another user, or another operation, is a different claim', async () => {
    const pool = makePool();
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'shared-key-123' }, fn);
    await withIdempotency(pool, { userId: 1, scope: 'tasks.create', key: 'shared-key-123' }, fn);
    await withIdempotency(pool, { userId: USER, scope: 'events.create', key: 'shared-key-123' }, fn);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(pool.rows).toHaveLength(3);
  });

  test('a submission while the first is in flight is 409 in_flight and does not run fn', async () => {
    const pool = makePool();
    let release;
    const slow = jest.fn(() => new Promise((res) => { release = () => res({ task_id: 1 }); }));
    const firstP = withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'racing-key-12' }, slow);
    await new Promise((r) => setImmediate(r));          // let the claim land
    const second = jest.fn();
    let err = null;
    try { await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'racing-key-12' }, second); } catch (e) { err = e; }
    expect(err && err.idempotency).toEqual({ status: 409, outcome: 'in_flight' });
    expect(err.message).toMatch(/still being applied/);
    expect(second).not.toHaveBeenCalled();
    release();
    await expect(firstP).resolves.toMatchObject({ replayed: false });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  test('a claim stranded past the staleness window is 409 unknown, never taken over', async () => {
    const pool = makePool();
    const stranded = jest.fn(() => new Promise(() => {}));   // never settles
    withIdempotency(pool, { userId: USER, scope: 'appts.create', key: 'stranded-key-1' }, stranded).catch(() => {});
    await new Promise((r) => setImmediate(r));
    pool.backdate(IN_FLIGHT_STALE_SECONDS);
    const retry = jest.fn();
    let err = null;
    try { await withIdempotency(pool, { userId: USER, scope: 'appts.create', key: 'stranded-key-1' }, retry); } catch (e) { err = e; }
    expect(err && err.idempotency).toEqual({ status: 409, outcome: 'unknown' });
    expect(err.message).toMatch(/unknown/i);
    expect(retry).not.toHaveBeenCalled();                    // never blind-retried
    expect(pool.rows).toHaveLength(1);
    expect(pool.rows[0].status).toBe('in_flight');           // not taken over
  });

  test('a failed fn releases the claim: the same key may be retried', async () => {
    const pool = makePool();
    const boom = jest.fn().mockRejectedValue(new Error('contact_id is required'));
    await expect(withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'failing-key-1' }, boom))
      .rejects.toThrow('contact_id is required');
    expect(pool.rows).toEqual([]);                           // claim gone
    const ok = jest.fn().mockResolvedValue({ task_id: 3 });
    const retry = await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'failing-key-1' }, ok);
    expect(retry).toMatchObject({ value: { task_id: 3 }, replayed: false });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('a settle that fails does not fail the committed operation', async () => {
    const pool = makePool();
    pool.failSettle = true;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fn = jest.fn().mockResolvedValue({ task_id: 11 });
    const out = await withIdempotency(pool, { userId: USER, scope: 'tasks.create', key: 'unsettled-k-1' }, fn);
    expect(out).toEqual({ value: { task_id: 11 }, replayed: false, idempotent: true, recorded: false });
    expect(pool.rows[0].status).toBe('in_flight');           // -> a repeat reads `unknown`
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The routes, over HTTP, through the real auth middleware.
// ─────────────────────────────────────────────────────────────────────────────
describe('the wired create routes', () => {
  const app = express();
  app.use(express.json());
  let pool;
  app.use((r, _res, next) => { r.db = pool; next(); });
  app.use(require('../routes/api.tasks'));
  app.use(require('../routes/api.events'));
  app.use(require('../routes/api.appts'));
  app.use(require('../routes/api.contactPhones'));
  app.use(require('../routes/api.contactEmails'));
  app.use(require('../routes/api.contactAddresses'));

  let server;
  let base;
  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const token = jwt.sign({ sub: String(USER), username: 'fred', user_auth: 'authorized', aud: 'staff' }, process.env.JWT_SECRET);

  async function post(url, body, key) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const r = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-json */ }
    return { status: r.status, json };
  }

  // One row per wired route: path, body, the spied create, what it returns.
  const FAMILIES = [
    ['/api/tasks', { to: 3, title: 'Call client' }, taskService, 'createTask', { task_id: 51, action_token: 'tok', action_url: 'https://x/t/tok' }, 200],
    ['/api/events', { event_title: '341 hearing', event_date: '2099-02-02' }, eventService, 'createEvent', { event_id: 61, event: { event_id: 61, event_title: '341 hearing' } }, 200],
    ['/api/appts', { appt_client_id: 1309, appt_date: '2099-02-02 10:00' }, apptService, 'createAppt', { appt_id: 71 }, 200],
    ['/api/contact-phones', { contact_id: 1309, phone: '2485550100' }, phoneSvc, 'createContactPhone', { id: 81, phone: '2485550100' }, 201],
    ['/api/contact-emails', { contact_id: 1309, email: 'a@b.com' }, emailSvc, 'createContactEmail', { id: 91, email: 'a@b.com' }, 201],
    ['/api/contact-addresses', { contact_id: 1309, address: '1 Main St' }, addrSvc, 'createContactAddress', { id: 101 }, 201],
  ];

  let spy;
  beforeEach(() => { pool = makePool(); spy = null; jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  const arm = (svc, method, result) => { spy = jest.spyOn(svc, method).mockResolvedValue(result); return spy; };

  test.each(FAMILIES)('%s with no key: untouched — two submissions, two records, no idempotency SQL',
    async (path, body, svc, method, result, ok) => {
      arm(svc, method, result);
      const a = await post(path, body);
      const b = await post(path, body);
      expect([a.status, b.status]).toEqual([ok, ok]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(a.json.replayed).toBeUndefined();
      expect(pool.seen).toEqual([]);          // this module issued nothing
      expect(pool.rows).toEqual([]);
    });

  test.each(FAMILIES)('%s with the same key twice: ONE record, the second replays the stored result',
    async (path, body, svc, method, result, ok) => {
      arm(svc, method, result);
      const key = `tab-dup-${method}-0001`;
      const a = await post(path, body, key);
      const b = await post(path, body, key);
      expect(a.status).toBe(ok);
      expect(b.status).toBe(ok);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(a.json.replayed).toBeUndefined();
      expect(b.json.replayed).toBe(true);
      // Same response bytes apart from the replay marker.
      expect({ ...b.json, replayed: undefined }).toEqual({ ...a.json, replayed: undefined });
      expect(pool.rows).toHaveLength(1);
      expect(pool.rows[0].status).toBe('applied');
    });

  test.each(FAMILIES)('%s: a concurrent submission of the same key is 409 in_flight, not a second record',
    async (path, body, svc, method, result, ok) => {
      let release;
      spy = jest.spyOn(svc, method).mockImplementation(() => new Promise((res) => { release = () => res(result); }));
      const key = `tab-race-${method}-0001`;
      const firstP = post(path, body, key);
      await new Promise((r) => setTimeout(r, 25));
      const second = await post(path, body, key);
      expect(second.status).toBe(409);
      expect(second.json.idempotency).toEqual({ outcome: 'in_flight' });
      expect(spy).toHaveBeenCalledTimes(1);
      release();
      expect((await firstP).status).toBe(ok);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(pool.rows).toHaveLength(1);
    });

  test.each(FAMILIES)('%s: a malformed key is 400 and nothing is written',
    async (path, body, svc, method, result) => {
      arm(svc, method, result);
      const r = await post(path, body, 'no');
      expect(r.status).toBe(400);
      expect(r.json.idempotency).toEqual({ outcome: 'invalid_key' });
      expect(spy).not.toHaveBeenCalled();
      expect(pool.rows).toEqual([]);
    });

  test.each(FAMILIES)('%s: the key never reaches the service, and a key in the BODY is not a key',
    async (path, body, svc, method, result, ok) => {
      arm(svc, method, result);
      const key = 'header-only-key-1';
      await post(path, body, key);
      // Everything the route hands the service EXCEPT the db handle (the fake
      // pool holds the claim rows, so it naturally contains the key).
      expect(JSON.stringify(spy.mock.calls[0].slice(1))).not.toContain(key);
      // A proposal that puts a key in the body gets no protection from it:
      // two submissions, two records.
      spy.mockClear();
      const withBodyKey = { ...body, idempotency_key: 'body-key-00001', idem_key: 'body-key-00001' };
      const a = await post(path, withBodyKey);
      const b = await post(path, withBodyKey);
      expect([a.status, b.status]).toEqual([ok, ok]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(pool.rows).toHaveLength(1);      // only the header-keyed claim
    });

  test.each(FAMILIES)('%s: a failed create releases the key for an honest retry',
    async (path, body, svc, method, result, ok) => {
      spy = jest.spyOn(svc, method).mockRejectedValue(new Error('not found'));
      const key = `tab-fail-${method}-0001`;
      const bad = await post(path, body, key);
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.json.idempotency).toBeUndefined();     // the route's own error
      expect(pool.rows).toEqual([]);
      spy.mockRestore();
      arm(svc, method, result);
      const good = await post(path, body, key);
      expect(good.status).toBe(ok);
      expect(good.json.replayed).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    });
});
