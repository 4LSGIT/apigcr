// tests/trackingDomainCheck.test.js
//
/**
 * C6c — the tracking-domain watchdog: verdictFor's decision matrix (pure,
 * lib/trackingDomainCheck.js) and the tracking_domain_check internal
 * function's wiring (probe mocked — the network wrapper stays thin; alert
 * raised once per UTC day with the verdict's severity).
 *
 *   npx jest tests/trackingDomainCheck.test.js
 */

'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => ({ inserted: true })) }));
jest.mock('../lib/trackingDomainCheck', () => {
  const real = jest.requireActual('../lib/trackingDomainCheck');
  return { ...real, probe: jest.fn() };
});

const { verdictFor, DAYS_MIN, probe } = require('../lib/trackingDomainCheck');
const { alert } = require('../lib/alerting');
const fns = require('../lib/internal_functions/trackingCheck');

const OK = { status: 200, region: 'us-east-2', protocol: 'https', daysLeft: 300 };
const OPTS = { expectRegion: 'us-east-2' };

describe('verdictFor — the decision matrix', () => {
  test('healthy facts → null; a cert date the socket cannot offer is healthy on that axis', () => {
    expect(verdictFor(OK, OPTS)).toBeNull();
    expect(verdictFor({ ...OK, daysLeft: null }, OPTS)).toBeNull();
    expect(verdictFor({ ...OK, daysLeft: DAYS_MIN }, OPTS)).toBeNull();          // boundary: 21 is fine
  });

  test('a thrown probe with a TRANSIENT code → warning (the alert-severity convention)', () => {
    expect(verdictFor({ error: 'socket hang up', errorCode: 'ECONNRESET' }, OPTS)).toMatchObject({ level: 'warning' });
    expect(verdictFor({ error: 'timed out after 10000 ms', errorCode: undefined }, OPTS)).toMatchObject({ level: 'warning' });
  });

  test('a PERMANENT probe failure → error on day one: cert chain and dead name never self-heal (review B1)', () => {
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'SELF_SIGNED_CERT_IN_CHAIN']) {
      const v = verdictFor({ error: 'x', errorCode: code }, OPTS);
      expect(v.level).toBe('error');
      expect(v.reason).toContain(code);
    }
  });

  test('a bad min_days override falls back to the default instead of disabling the expiry check (review N3)', () => {
    expect(verdictFor({ ...OK, daysLeft: 5 }, { ...OPTS, minDays: NaN })).toMatchObject({ level: 'error' });
    expect(verdictFor({ ...OK, daysLeft: DAYS_MIN }, { ...OPTS, minDays: Number('abc') })).toBeNull();
  });

  test.each([
    ['non-200', { ...OK, status: 403 }, /HTTP 403/],
    ['wrong region', { ...OK, region: 'us-east-1' }, /us-east-1.*expected us-east-2/],
    ['missing region header', { ...OK, region: null }, /missing/],
    ['downgraded CDN leg', { ...OK, protocol: 'http' }, /protocol is http/],
    ['expiring cert', { ...OK, daysLeft: DAYS_MIN - 1 }, /expires in 20 day/],
    ['expired cert', { ...OK, daysLeft: -2 }, /ACM validation CNAME/],
  ])('%s → error', (_, facts, re) => {
    const v = verdictFor(facts, OPTS);
    expect(v.level).toBe('error');
    expect(v.reason).toMatch(re);
  });
});

describe('tracking_domain_check — wiring', () => {
  const db = { query: jest.fn(async () => [[]]) };   // no existing alert row
  beforeEach(() => { jest.clearAllMocks(); db.query.mockImplementation(async () => [[]]); });

  test('healthy probe → no alert, healthy output', async () => {
    probe.mockResolvedValue({ ...OK });
    const r = await fns.tracking_domain_check({}, db);
    expect(r).toMatchObject({ success: true, output: { healthy: true, status: 200 } });
    expect(alert).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith('https://r.news.4lsg.com/favicon.ico', {});
  });

  test('expiring cert → ONE error alert with the daily dedup key; output carries the reason', async () => {
    probe.mockResolvedValue({ ...OK, daysLeft: 3 });
    const r = await fns.tracking_domain_check({}, db);
    expect(r.output).toMatchObject({ healthy: false, level: 'error', alerted: true });
    expect(alert).toHaveBeenCalledTimes(1);
    const a = alert.mock.calls[0][1];
    expect(a).toMatchObject({ kind: 'mail_tracking_domain', severity: 'error' });
    expect(a.dedup_key).toBe(`mail_tracking_domain:${new Date().toISOString().slice(0, 10)}`);
    expect(a.message).toMatch(/expires in 3 day/);
  });

  test('an alert already raised today → checked by dedup key, not raised again', async () => {
    probe.mockResolvedValue({ ...OK, status: 500 });
    db.query.mockImplementation(async () => [[{ id: 9 }]]);
    const r = await fns.tracking_domain_check({}, db);
    expect(r.output).toMatchObject({ healthy: false, alerted: false });
    expect(alert).not.toHaveBeenCalled();
    expect(db.query.mock.calls[0][0]).toContain('dedup_key');
  });

  test('a probe that throws transiently → warning alert, never a thrown job; the error code rides to the verdict', async () => {
    probe.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const r = await fns.tracking_domain_check({}, db);
    expect(r).toMatchObject({ success: true, output: { healthy: false, level: 'warning' } });
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ severity: 'warning' }));
  });

  test('a permanent probe throw (the C6b live failure) → ERROR alert on day one', async () => {
    probe.mockRejectedValue(Object.assign(new Error('Hostname/IP does not match'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));
    const r = await fns.tracking_domain_check({}, db);
    expect(r.output).toMatchObject({ healthy: false, level: 'error' });
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ severity: 'error' }));
  });

  test("a warning REPEATED from yesterday escalates to error — 'transient' two days running is not transient (review B1)", async () => {
    probe.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const yday = `mail_tracking_domain:${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`;
    db.query.mockImplementation(async (sql, params) => (params && params[0] === yday ? [[{ id: 7 }]] : [[]]));
    const r = await fns.tracking_domain_check({}, db);
    expect(r.output).toMatchObject({ level: 'error' });
    expect(r.output.reason).toMatch(/second consecutive day/);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ severity: 'error' }));
  });

  test('params override url / region / min_days', async () => {
    probe.mockResolvedValue({ status: 200, region: 'eu-west-1', protocol: 'https', daysLeft: 40 });
    const r = await fns.tracking_domain_check({ url: 'https://x.test/f.ico', region: 'eu-west-1', min_days: 45 }, db);
    expect(probe).toHaveBeenCalledWith('https://x.test/f.ico', {});
    expect(r.output).toMatchObject({ healthy: false, level: 'error' });   // 40 < the overridden 45
    expect(r.output.reason).toMatch(/expires in 40/);
  });
});
