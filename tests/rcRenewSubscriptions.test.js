'use strict';
/**
 * tests/rcRenewSubscriptions.test.js
 *
 * rc_renew_subscriptions (lib/internal_functions/connections.js) detects a
 * subscription RingCentral no longer delivers on (2026-10-27). RC blacklists
 * a webhook subscription whose deliveries fail or time out for ~10 min, sends
 * no notice, keeps no events, and never reactivates it — so the daily pass
 * GETs every subscription and reads `status`; the renewal PUT's answer is read
 * the same way. Pinned here:
 *   - a status other than 'Active' (Blacklisted with blacklistedData, or
 *     Suspended) raises ONE error-severity alert per subscription per pass,
 *     naming the subscription, its hook, the reason and the recovery, with a
 *     per-day dedup_key (INSERT IGNORE — one row a day however often it runs);
 *   - an Active subscription raises nothing; a not-due one is only GET'd;
 *   - the status check runs on not-due entries (days before renewal would);
 *     a GET 404 removes the entry exactly like a renewal 404;
 *   - a failed status check never blocks the renewal; an absent `status` is
 *     logged, not alerted;
 *   - every RC call carries headers from the ASYNC buildHeadersForCredential
 *     (CLAUDE.md outbound-auth invariant — the sync builder returns {} for
 *     OAuth2), awaited, for that entry's credential and that URL.
 *
 * NOTHING REACHES RINGCENTRAL: global.fetch is replaced by a recorder that
 * answers from a table and FAILS the test on any URL outside the stubbed RC
 * subscription endpoint; it is restored after. No DB pool exists (a recording
 * stub; startup/db is a tripwire), and emailService is a recorder.
 *
 * Run: npx jest tests/rcRenewSubscriptions.test.js
 */

jest.mock('../startup/db', () => { throw new Error('tripwire: a test reached the real DB pool'); });
const mockEmails = [];
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(async (db, msg) => { mockEmails.push(msg); return { ok: true }; }),
}));
const mockHeaderCalls = [];
jest.mock('../lib/credentialInjection', () => ({
  buildHeadersForCredential: jest.fn(async (db, id, url) => {
    mockHeaderCalls.push({ id, url });
    await new Promise((r) => setImmediate(r)); // a real await — a dropped one would send a Promise as headers
    return { Authorization: `Bearer test-token-${id}` };
  }),
}));

const fns = require('../lib/internal_functions/connections');

const BASE = 'https://platform.ringcentral.com/restapi/v1.0/subscription/';
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (d) => new Date(Date.now() + d * DAY_MS).toISOString();

function sub(id, slug, expiresInDays) {
  return {
    subscription_id: id, hook_slug: slug, credential_id: 9,
    event_filters: ['/restapi/v1.0/account/~/extension/~/message-store'],
    expires_at: inDays(expiresInDays), verification_token: 'tok', created_at: inDays(-30),
  };
}

function makeDb(subs) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/^SELECT `value` FROM app_settings WHERE `key` = \?/.test(s)) {
        return [params[0] === 'rc_subscriptions' ? [{ value: JSON.stringify(subs) }] : []];
      }
      if (/^INSERT IGNORE INTO system_alerts|^INSERT INTO system_alerts/.test(s)) return [{ affectedRows: 1, insertId: 77 }];
      return [{ affectedRows: 1 }];
    },
  };
}
const alertsOf = (db) => db.calls.filter((c) => /INTO system_alerts/.test(c.sql)).map((c) => ({
  verb: c.sql.split(' INTO')[0],
  source: c.params[0], kind: c.params[1], group_key: c.params[2], severity: c.params[3],
  title: c.params[4], message: c.params[5], context: JSON.parse(c.params[6]), dedup_key: c.params[9],
}));

// fetch recorder: `answers` maps "METHOD id" → { status, json } | Error.
let fetchCalls;
let realFetch;
function stubFetch(answers) {
  fetchCalls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    fetchCalls.push({ url, method, headers: opts.headers });
    if (typeof url !== 'string' || !url.startsWith(BASE)) {
      throw new Error(`test escape: fetch to ${url} is not the stubbed RC endpoint`);
    }
    const a = answers[`${method} ${decodeURIComponent(url.slice(BASE.length))}`];
    if (a === undefined) throw new Error(`no stubbed answer for ${method} ${url}`);
    if (a instanceof Error) throw a;
    return {
      status: a.status,
      json: async () => { if (a.json === undefined) throw new SyntaxError('Unexpected end of JSON input'); return a.json; },
      text: async () => (a.json === undefined ? '' : JSON.stringify(a.json)),
    };
  });
}
const resource = (id, status, extra = {}) => ({ id, status, expirationTime: inDays(7), ...extra });
const BLACKLISTED = (id) => resource(id, 'Blacklisted', {
  blacklistedData: { reason: 'Webhook responses timed out', blacklistedAt: '2026-10-27T03:10:00.000Z' },
});

beforeAll(() => { realFetch = global.fetch; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => { mockEmails.length = 0; mockHeaderCalls.length = 0; });
afterEach(() => {
  // Every call went to the stub, and only to the RC subscription endpoint.
  for (const c of fetchCalls) expect(c.url.startsWith(BASE)).toBe(true);
});

const today = () => new Date().toISOString().slice(0, 10);

describe('status check: a subscription RC no longer delivers on raises an error alert', () => {
  test('Blacklisted (not due): one error alert naming subscription, hook, reason, recovery — and no renewal PUT', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 5)]);
    stubFetch({ 'GET S-1': { status: 200, json: BLACKLISTED('S-1') } });
    const r = await fns.rc_renew_subscriptions({}, db);

    expect(fetchCalls.map((c) => c.method)).toEqual(['GET']);
    expect(r.output.results).toEqual([expect.objectContaining({ subscription_id: 'S-1', action: 'not_due', rc_status: 'Blacklisted' })]);
    const alerts = alertsOf(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual(expect.objectContaining({
      verb: 'INSERT IGNORE', source: 'connections', kind: 'rc_subscription_inactive', severity: 'error',
      group_key: 'rc_subscription:S-1', dedup_key: `rc_subscription_inactive:S-1:${today()}`,
    }));
    expect(alerts[0].title).toBe('RingCentral subscription Blacklisted: hook rc-call receives no RingCentral events');
    expect(alerts[0].message).toContain('subscription S-1 (hook "rc-call") as Blacklisted — reason: Webhook responses timed out, since 2026-10-27T03:10:00.000Z');
    expect(alerts[0].message).toMatch(/DELETE the subscription on RingCentral, POST a new one/);
    expect(alerts[0].context).toEqual(expect.objectContaining({ subscription_id: 'S-1', hook_slug: 'rc-call', status: 'Blacklisted', reason: 'Webhook responses timed out' }));
    // The dead subscription stays in the array (re-creating it is an operator step): nothing written back.
    expect(db.calls.filter((c) => /app_settings \(/.test(c.sql))).toEqual([]);
    expect(mockEmails).toEqual([]);
  });

  test('Suspended is alerted the same way', async () => {
    const db = makeDb([sub('S-2', 'rc-message-in', 5)]);
    stubFetch({ 'GET S-2': { status: 200, json: resource('S-2', 'Suspended') } });
    await fns.rc_renew_subscriptions({}, db);
    expect(alertsOf(db).map((a) => [a.severity, a.group_key, a.title])).toEqual([
      ['error', 'rc_subscription:S-2', 'RingCentral subscription Suspended: hook rc-message-in receives no RingCentral events'],
    ]);
  });

  test('Active subscriptions raise nothing; not-due ones are only GET\'d', async () => {
    const db = makeDb([sub('S-1', 'rc-message-in', 5), sub('S-2', 'rc-message-out', 5), sub('S-3', 'rc-call', 5)]);
    stubFetch({
      'GET S-1': { status: 200, json: resource('S-1', 'Active') },
      'GET S-2': { status: 200, json: resource('S-2', 'Active') },
      'GET S-3': { status: 200, json: resource('S-3', 'Active') },
    });
    const r = await fns.rc_renew_subscriptions({}, db);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual(['GET S-1', 'GET S-2', 'GET S-3']);
    expect(r.output.results.map((x) => [x.action, x.rc_status])).toEqual([['not_due', 'Active'], ['not_due', 'Active'], ['not_due', 'Active']]);
    expect(alertsOf(db)).toEqual([]);
  });

  test('due: Active on the GET, Blacklisted on the renewal answer → alerted; still renewed as RC answered', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 1)]);
    stubFetch({
      'GET S-1': { status: 200, json: resource('S-1', 'Active') },
      'PUT S-1': { status: 200, json: BLACKLISTED('S-1') },
    });
    const r = await fns.rc_renew_subscriptions({}, db);
    expect(fetchCalls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(r.output.results).toEqual([expect.objectContaining({ action: 'renewed', rc_status: 'Blacklisted' })]);
    const alerts = alertsOf(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].context.seen_in).toBe('renewal');
  });

  test('blacklisted on BOTH the GET and the renewal answer → ONE alert for the pass', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 1)]);
    stubFetch({ 'GET S-1': { status: 200, json: BLACKLISTED('S-1') }, 'PUT S-1': { status: 200, json: BLACKLISTED('S-1') } });
    await fns.rc_renew_subscriptions({}, db);
    const alerts = alertsOf(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].context.seen_in).toBe('status check'); // the first sighting is kept
  });

  test('two passes the same day carry the SAME dedup_key (INSERT IGNORE folds them into one row)', async () => {
    const subs = [sub('S-1', 'rc-call', 5)];
    const db1 = makeDb(subs); const db2 = makeDb(subs);
    stubFetch({ 'GET S-1': { status: 200, json: BLACKLISTED('S-1') } });
    await fns.rc_renew_subscriptions({}, db1);
    await fns.rc_renew_subscriptions({}, db2);
    const [a1] = alertsOf(db1); const [a2] = alertsOf(db2);
    expect(a1.verb).toBe('INSERT IGNORE');
    expect(a2.dedup_key).toBe(a1.dedup_key);
    // and a different subscription is its own row
    const db3 = makeDb([sub('S-9', 'rc-call', 5)]);
    stubFetch({ 'GET S-9': { status: 200, json: BLACKLISTED('S-9') } });
    await fns.rc_renew_subscriptions({}, db3);
    expect(alertsOf(db3)[0].dedup_key).not.toBe(a1.dedup_key);
  });
});

describe('status check never weakens the renewal', () => {
  test('a GET that fails (network) is recorded and the due renewal still runs', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 1)]);
    stubFetch({ 'GET S-1': new Error('socket hang up'), 'PUT S-1': { status: 200, json: resource('S-1', 'Active') } });
    const r = await fns.rc_renew_subscriptions({}, db);
    expect(fetchCalls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(r.output.results).toEqual([expect.objectContaining({
      action: 'renewed', rc_status: 'Active', status_check_error: 'network: socket hang up',
    })]);
    expect(alertsOf(db)).toEqual([]);
  });

  test('a GET 500 on a not-due entry is recorded, nothing alerted', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 5)]);
    stubFetch({ 'GET S-1': { status: 500, json: { errorCode: 'X' } } });
    const r = await fns.rc_renew_subscriptions({}, db);
    expect(r.output.results).toEqual([expect.objectContaining({ action: 'not_due', status_check_error: expect.stringMatching(/^500 /) })]);
    expect(alertsOf(db)).toEqual([]);
  });

  test('an answer with no status is logged, not alerted', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 5)]);
    stubFetch({ 'GET S-1': { status: 200, json: { id: 'S-1', expirationTime: inDays(7) } } });
    const r = await fns.rc_renew_subscriptions({}, db);
    expect(r.output.results[0].rc_status).toBeNull();
    expect(alertsOf(db)).toEqual([]);
  });

  test('a GET 404 removes the entry like a renewal 404 (written back, IT emailed), no PUT', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 5), sub('S-2', 'rc-message-in', 5)]);
    stubFetch({ 'GET S-1': { status: 404, json: { errorCode: 'SUB-' } }, 'GET S-2': { status: 200, json: resource('S-2', 'Active') } });
    const r = await fns.rc_renew_subscriptions({}, db);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual(['GET S-1', 'GET S-2']);
    expect(r.output.results.map((x) => x.action)).toEqual(['removed_404', 'not_due']);
    const wb = db.calls.filter((c) => /^REPLACE INTO app_settings/.test(c.sql));
    expect(wb).toHaveLength(1);
    expect(JSON.parse(wb[0].params[1]).map((e) => e.subscription_id)).toEqual(['S-2']);
    expect(mockEmails.map((m) => m.subject)).toEqual(['RC Subscription removed: rc-call']);
  });
});

describe('outbound auth: the async buildHeadersForCredential, per entry and URL', () => {
  test('GET and PUT both carry the awaited headers for that entry\'s credential', async () => {
    const db = makeDb([sub('S-1', 'rc-call', 1)]);
    stubFetch({ 'GET S-1': { status: 200, json: resource('S-1', 'Active') }, 'PUT S-1': { status: 200, json: resource('S-1', 'Active') } });
    await fns.rc_renew_subscriptions({}, db);
    expect(mockHeaderCalls).toEqual([{ id: 9, url: `${BASE}S-1` }]);
    for (const c of fetchCalls) expect(c.headers.Authorization).toBe('Bearer test-token-9');
    expect(fetchCalls[1].headers['Content-Type']).toBe('application/json');
  });
});
