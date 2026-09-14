// tests/apiAlertIt.routes.test.js
//
/**
 * POST /api/alert/it — routes/api.alertIt.js
 *
 * Auth via the REAL lib/auth.readonly middleware over a scripted db (auth
 * rejects are its behavior under test too); emailService / phoneService are
 * jest-mocked (provider boundaries); auditAdminAction runs for real against
 * the scripted db so the admin_audit_log rows are asserted as written.
 *
 * Covers: auth reject · length caps + type checks · severity vocabulary
 * (incl. 'warning' alias, channel rejection) · severity-derived delivery
 * (info → email only, critical → email+SMS) · settings fallbacks + sms-unset
 * skip path · email/SMS send failure → 502 · rate limit 429 (and that
 * validation failures don't burn quota) · audit rows on success AND reject.
 *
 * Run:  npx jest tests/apiAlertIt.routes.test.js
 */

'use strict';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn() }));

const emailService = require('../services/emailService');
const phoneService = require('../services/phoneService');
const express = require('express');
const router  = require('../routes/api.alertIt');

const KEY = 'ycro_deadbeef';

// ── scripted db ──────────────────────────────────────────────────────────
// keyRow: undefined → default valid key; null → unknown key.
// settings: app_settings map served to settingsService.getSetting.
function makeDb({ keyRow, settings } = {}) {
  const auditRows = []; // auditAdminAction param arrays, in insert order
  const row = keyRow === undefined
    ? { id: 7, label: 'jest key', expires_at: new Date(Date.now() + 3_600_000), revoked_at: null }
    : keyRow;
  const map = { alert_from_email: 'alerts@4lsg.com', ...settings };
  return {
    auditRows,
    query: jest.fn(async (sql, params) => {
      if (/FROM readonly_api_keys/.test(sql))   return [row ? [row] : []];
      if (/UPDATE readonly_api_keys/.test(sql)) return [{}];
      if (/INSERT INTO admin_audit_log/i.test(sql)) { auditRows.push(params); return [{}]; }
      if (/FROM app_settings/.test(sql)) {
        const k = params[0];
        return [map[k] != null && map[k] !== '' ? [{ value: map[k] }] : []];
      }
      throw new Error('unexpected sql in test db: ' + sql);
    }),
  };
}

// auditAdminAction param order:
// [tool, userId, username, route, method, status, errorMessage, durationMs, ip, userAgent, details]
const auditTool    = (p) => p[0];
const auditStatus  = (p) => p[5];
const auditDetails = (p) => JSON.parse(p[10]);

// ── app harness ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
let currentDb;
app.use((req, res, next) => { req.db = currentDb; next(); });
app.use(router);

let server, base;
const savedEnv = {};
beforeAll(async () => {
  // Deterministic fallback paths: cfg() must not find these in env.
  for (const k of ['IT_EMAIL', 'AUTO_EMAIL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
  }
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  router._test.resetRateLimit();
  emailService.sendEmail.mockResolvedValue({ ok: true });
  phoneService.sendSms.mockResolvedValue({ ok: true });
  currentDb = makeDb();
});

const post = (body, { key = KEY, headers = {} } = {}) =>
  fetch(`${base}/api/alert/it`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== null ? { 'x-readonly-api-key': key } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

const good = { subject: 'disk filling', message: 'ingest volume at 92%' };

// ── auth ─────────────────────────────────────────────────────────────────
test('missing key → 401, audited by auth layer under readonlyKeys', async () => {
  const res = await post(good, { key: null });
  expect(res.status).toBe(401);
  expect(emailService.sendEmail).not.toHaveBeenCalled();
  expect(currentDb.auditRows).toHaveLength(1);
  expect(auditTool(currentDb.auditRows[0])).toBe('readonlyKeys');
  expect(auditStatus(currentDb.auditRows[0])).toBe('rejected_no_key');
});

test('unknown key → 401, no send', async () => {
  currentDb = makeDb({ keyRow: null });
  const res = await post(good);
  expect(res.status).toBe(401);
  expect(emailService.sendEmail).not.toHaveBeenCalled();
  expect(auditStatus(currentDb.auditRows[0])).toBe('rejected_unknown_key');
});

// ── validation ───────────────────────────────────────────────────────────
test('length caps and type checks → 400 with it_alert audit row', async () => {
  for (const body of [
    { subject: 'x'.repeat(201), message: 'm' },
    { subject: 's', message: 'x'.repeat(10_001) },
    { subject: '   ', message: 'm' },
    { message: 'm' },
    { subject: 's' },
    { subject: { nested: true }, message: 'm' },
  ]) {
    currentDb = makeDb();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(auditTool(currentDb.auditRows[0])).toBe('it_alert');
    expect(auditStatus(currentDb.auditRows[0])).toBe('rejected_validation');
  }
});

test('unknown severity → 400; channel key → explicit 400', async () => {
  let res = await post({ ...good, severity: 'error' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/severity must be one of/);

  res = await post({ ...good, channel: 'email' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/channel is not accepted/);
  expect(emailService.sendEmail).not.toHaveBeenCalled();
});

// ── delivery semantics ───────────────────────────────────────────────────
test('default severity info → email only, prefixed subject, email_it fallback recipient', async () => {
  const res = await post(good);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, severity: 'info', sent: { email: true, sms: false } });

  expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  const [, opts] = emailService.sendEmail.mock.calls[0];
  expect(opts).toMatchObject({
    from: 'alerts@4lsg.com',                      // alert_from_email setting
    to: 'it@4lsg.com',                            // email_it unset + IT_EMAIL env deleted → fallback
    subject: '[YC-ALERT:INFO] disk filling',
    text: 'ingest volume at 92%',
  });
  expect(opts.html).toBeUndefined();              // text-only — escaping happens in emailService
  expect(phoneService.sendSms).not.toHaveBeenCalled();

  expect(auditStatus(currentDb.auditRows[0])).toBe('sent');
  expect(auditDetails(currentDb.auditRows[0])).toMatchObject({
    keyId: 7, severity: 'info', sms: 'not_applicable', sent: { email: true, sms: false },
  });
});

test("severity 'warning' is accepted as warn; still no SMS", async () => {
  const res = await post({ ...good, severity: 'warning' });
  expect(res.status).toBe(200);
  expect((await res.json()).severity).toBe('warn');
  expect(emailService.sendEmail.mock.calls[0][1].subject).toBe('[YC-ALERT:WARN] disk filling');
  expect(phoneService.sendSms).not.toHaveBeenCalled();
});

test('critical → email + one SMS per csv recipient from the staff line', async () => {
  currentDb = makeDb({ settings: {
    alert_critical_sms_to: '2481112222, 2483334444',
    sms_staff_from: '2484179800',
  } });
  const res = await post({ ...good, severity: 'critical' });
  expect(res.status).toBe(200);
  expect((await res.json()).sent).toEqual({ email: true, sms: true });

  expect(phoneService.sendSms).toHaveBeenCalledTimes(2);
  const calls = phoneService.sendSms.mock.calls;
  expect(calls.map((c) => c[2])).toEqual(['2481112222', '2483334444']);
  for (const c of calls) {
    expect(c[1]).toBe('2484179800');
    expect(c[3]).toMatch(/^\[YC-ALERT:CRITICAL\] disk filling — /);
    expect(c[3].length).toBeLessThanOrEqual(400);
  }
  expect(auditDetails(currentDb.auditRows[0]).sms).toBe('sent');
});

test('critical with alert_critical_sms_to unset → sms skipped + noted, still 200', async () => {
  const res = await post({ ...good, severity: 'critical' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sent).toEqual({ email: true, sms: false });
  expect(body.notes).toEqual(['sms skipped: alert_critical_sms_to unset']);
  expect(phoneService.sendSms).not.toHaveBeenCalled();
  expect(auditDetails(currentDb.auditRows[0]).sms).toBe('skipped_unset');
});

test('critical with recipients but no from line → sms skipped_no_from, still 200', async () => {
  currentDb = makeDb({ settings: { alert_critical_sms_to: '2481112222' } });
  const res = await post({ ...good, severity: 'critical' });
  expect(res.status).toBe(200);
  expect((await res.json()).notes[0]).toMatch(/no sms_staff_from/);
  expect(phoneService.sendSms).not.toHaveBeenCalled();
});

// ── loud failures ────────────────────────────────────────────────────────
test('email send failure → 502, audit send_failed', async () => {
  emailService.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
  const res = await post(good);
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.sent.email).toBe(false);
  expect(body.error).toMatch(/email: smtp down/);
  expect(auditStatus(currentDb.auditRows[0])).toBe('send_failed');
});

test('no sender configured anywhere → 502 naming the settings', async () => {
  currentDb = makeDb({ settings: { alert_from_email: '' } }); // AUTO_EMAIL deleted in beforeAll
  const res = await post(good);
  expect(res.status).toBe(502);
  expect((await res.json()).error).toMatch(/no sender configured/);
});

test('critical: SMS failure → 502 even when the email went out', async () => {
  currentDb = makeDb({ settings: {
    alert_critical_sms_to: '2481112222',
    sms_staff_from: '2484179800',
  } });
  phoneService.sendSms.mockRejectedValueOnce(new Error('provider 500'));
  const res = await post({ ...good, severity: 'critical' });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.sent).toEqual({ email: true, sms: false });
  expect(body.error).toMatch(/sms: 2481112222: provider 500/);
  expect(auditDetails(currentDb.auditRows[0]).sms).toBe('failed');
});

// ── rate limit ───────────────────────────────────────────────────────────
test('11th valid alert in the window → 429 with digest guidance, audited', async () => {
  for (let i = 0; i < router._test.RATE_LIMIT; i++) {
    expect((await post(good)).status).toBe(200);
  }
  currentDb = makeDb(); // fresh audit capture for the reject
  const res = await post(good);
  expect(res.status).toBe(429);
  const body = await res.json();
  expect(body.error).toMatch(/10 IT alerts per hour/);
  expect(body.error).toMatch(/digest/);
  expect(body.retryInMs).toBeGreaterThan(0);
  expect(emailService.sendEmail).toHaveBeenCalledTimes(router._test.RATE_LIMIT);
  expect(auditStatus(currentDb.auditRows[0])).toBe('rejected_rate_limit');
});

test('validation failures do not burn quota', async () => {
  for (let i = 0; i < 15; i++) {
    expect((await post({ message: 'no subject' })).status).toBe(400);
  }
  expect((await post(good)).status).toBe(200);
});
