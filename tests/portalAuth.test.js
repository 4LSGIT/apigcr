// tests/portalAuth.test.js
//
// Client Portal Slice 1 — mocked-db unit tests for
// services/portalAuthService.js, lib/auth.requireAuth.js, and the D3
// changes to lib/auth.jwtOrApiKey.js. Regex-scripted stub pool (pattern
// evolved from tests/pipelineService.test.js's scripted stubs — regex
// matching instead of shift-order because portal flows interleave
// fire-and-forget access-log inserts with the main query sequence).
// External services (settings, phone, email, alerting) are jest-mocked at
// the module boundary — no database, no network.
//
// Run:
//   npx jest tests/portalAuth.test.js

'use strict';

process.env.JWT_SECRET = 'portal-s1-test-secret';
delete process.env.JWT_VERSION; // version gate off unless a test sets it

jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(),
  getSettings: jest.fn(),
}));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn() }));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

const settingsService = require('../services/settingsService');
const phoneService = require('../services/phoneService');
const emailService = require('../services/emailService');
const { alert } = require('../lib/alerting');

const svc = require('../services/portalAuthService');
const requireAuth = require('../lib/auth.requireAuth');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const SECRET = process.env.JWT_SECRET;
const UTC_YM = new Date().toISOString().slice(0, 7);

const hashPin = pin =>
  crypto.createHmac('sha256', SECRET).update(String(pin)).digest('hex');

const flush = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

// Regex-scripted pool stub: query() matches the (whitespace-normalized) SQL
// against handlers in order; first hit returns [rows]. Unscripted → throw
// (fire-and-forget callers self-catch; scripted-path callers surface it).
function stubDb(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: norm, params: params || [] });
      for (const h of handlers) {
        if (h.re.test(norm)) {
          return [typeof h.rows === 'function' ? h.rows(norm, params) : h.rows];
        }
      }
      throw new Error('stubDb: unscripted query: ' + norm);
    },
  };
}

const ACCESS_LOG = { re: /INSERT INTO portal_access_log/, rows: { affectedRows: 1 } };

function accessLogCalls(db) {
  return db.calls.filter(c => /INSERT INTO portal_access_log/.test(c.sql));
}
// portal_access_log column order:
// (contact_id, case_id, route, method, status, event, meta, ip)
function eventOf(call) { return call.params[5]; }
function contactIdOf(call) { return call.params[0]; }
function metaOf(call) { return call.params[6] ? JSON.parse(call.params[6]) : null; }

function stubRes() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.emit('finish'); return this; },
    set() { return this; },
  });
}

// Run a middleware; resolve on next() OR on a response being sent.
function runMw(mw, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = out => { if (!settled) { settled = true; resolve(out); } };
    const origJson = res.json;
    res.json = function (b) {
      const r = origJson.call(this, b);
      done({ via: 'res', status: this.statusCode, body: b });
      return r;
    };
    try {
      mw(req, res, err => (err ? reject(err) : done({ via: 'next' })));
    } catch (e) { reject(e); }
  });
}

function baseReq(overrides = {}) {
  return Object.assign({
    headers: {},
    body: {},
    query: {},
    originalUrl: '/api/portal/me',
    method: 'GET',
    ip: '1.2.3.4',
    socket: { remoteAddress: '127.0.0.1' },
    db: stubDb([ACCESS_LOG, { re: /jwt_api_audit_log/, rows: { affectedRows: 1 } }]),
  }, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// parseIdentifier / resolveIdentifier
// ─────────────────────────────────────────────────────────────────────────────

describe('parseIdentifier', () => {
  test('phone: formatting stripped, leading 1 dropped at 11 digits', () => {
    expect(svc.parseIdentifier('(248) 559-2400')).toEqual({ kind: 'phone', normalized: '2485592400' });
    expect(svc.parseIdentifier('+1 248 559 2400')).toEqual({ kind: 'phone', normalized: '2485592400' });
    expect(svc.parseIdentifier('12485592400')).toEqual({ kind: 'phone', normalized: '2485592400' });
  });

  test('phone: wrong length is malformed (no last-10 truncation)', () => {
    expect(svc.parseIdentifier('248559240').kind).toBeNull();       // 9
    expect(svc.parseIdentifier('224855924001').kind).toBeNull();    // 12
    expect(svc.parseIdentifier('').kind).toBeNull();
  });

  test('email: trimmed, must contain a sane @', () => {
    expect(svc.parseIdentifier('  fred@example.com  '))
      .toEqual({ kind: 'email', normalized: 'fred@example.com' });
    expect(svc.parseIdentifier('nope').kind).toBeNull();
    expect(svc.parseIdentifier('@x').kind).toBeNull();
    expect(svc.parseIdentifier('x@').kind).toBeNull();
    expect(svc.parseIdentifier('a b@c.com').kind).toBeNull();
  });
});

describe('resolveIdentifier', () => {
  test('phone: unions contact_phones + both legacy columns, dedup by UNION', async () => {
    const db = stubDb([
      { re: /FROM contact_phones/, rows: [{ contact_id: 7 }] },
      ACCESS_LOG,
    ]);
    const out = await svc.resolveIdentifier(db, '(248) 559-2400');
    expect(out).toEqual({ kind: 'phone', normalized: '2485592400', contactIds: [7] });
    const q = db.calls[0];
    expect(q.sql).toMatch(/contact_phones/);
    expect(q.sql).toMatch(/end_date IS NULL/);
    expect(q.sql).toMatch(/contact_phone = \?/);
    expect(q.sql).toMatch(/contact_phone2 = \?/);
    expect(q.sql).toMatch(/UNION/);
    expect(q.params).toEqual(['2485592400', '2485592400', '2485592400']);
  });

  test('email: unions contact_emails + both legacy columns', async () => {
    const db = stubDb([{ re: /FROM contact_emails/, rows: [] }]);
    const out = await svc.resolveIdentifier(db, 'fred@example.com');
    expect(out.kind).toBe('email');
    expect(out.contactIds).toEqual([]);
    expect(db.calls[0].sql).toMatch(/contact_email = \?/);
    expect(db.calls[0].sql).toMatch(/contact_email2 = \?/);
  });

  test('multi-match reachable (legacy columns)', async () => {
    const db = stubDb([
      { re: /FROM contact_phones/, rows: [{ contact_id: 7 }, { contact_id: 9 }] },
    ]);
    const out = await svc.resolveIdentifier(db, '2485592400');
    expect(out.contactIds).toEqual([7, 9]);
  });

  test('malformed: kind null, no query', async () => {
    const db = stubDb([]);
    const out = await svc.resolveIdentifier(db, 'garbage');
    expect(out).toEqual({ kind: null, normalized: null, contactIds: [] });
    expect(db.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestPin
// ─────────────────────────────────────────────────────────────────────────────

describe('requestPin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    phoneService.sendSms.mockResolvedValue({});
    emailService.sendEmail.mockResolvedValue({});
    settingsService.getSetting.mockResolvedValue('2485592400'); // sms_default_from
    settingsService.getSettings.mockImplementation(async (db, keys) => {
      const out = {};
      for (const k of keys) out[k] = null;
      if (keys.includes('portal_sms_counter')) {
        out.portal_sms_counter = JSON.stringify({ ym: UTC_YM, count: 0, alerted_ym: '' });
        out.portal_sms_monthly_cap = '300';
      }
      if (keys.includes('portal_email_from')) {
        out.portal_email_from = 'office@4lsg.com';
        out.email_default_from = 'stuart@4lsg.com';
      }
      return out;
    });
  });

  function smsDb(resolveRows, contactRow = { portal_enabled: 1 }) {
    return stubDb([
      { re: /FROM contact_phones/, rows: resolveRows },
      { re: /SELECT portal_enabled FROM contacts/, rows: contactRow ? [contactRow] : [] },
      { re: /UPDATE app_settings SET .value./, rows: { affectedRows: 1 } },
      { re: /INSERT INTO portal_login_pins/, rows: { insertId: 1 } },
      ACCESS_LOG,
    ]);
  }

  test('no match: logs pin_no_match, sends nothing, generic ok', async () => {
    const db = smsDb([]);
    const out = await svc.requestPin(db, { identifier: '2485592400', ip: '9.9.9.9' });
    await flush();
    expect(out).toEqual({ ok: true });
    const evs = accessLogCalls(db);
    expect(evs).toHaveLength(1);
    expect(eventOf(evs[0])).toBe('pin_no_match');
    expect(contactIdOf(evs[0])).toBeNull();
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(db.calls.some(c => /portal_login_pins/.test(c.sql))).toBe(false);
  });

  test('multi-match: logs pin_multi_match with count, sends NOTHING', async () => {
    const db = smsDb([{ contact_id: 7 }, { contact_id: 9 }]);
    const out = await svc.requestPin(db, { identifier: '2485592400', ip: null });
    await flush();
    expect(out).toEqual({ ok: true });
    const evs = accessLogCalls(db);
    expect(evs).toHaveLength(1);
    expect(eventOf(evs[0])).toBe('pin_multi_match');
    expect(metaOf(evs[0])).toEqual({ count: 2 });
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(settingsService.getSettings).not.toHaveBeenCalled();
    expect(db.calls.some(c => /portal_login_pins/.test(c.sql))).toBe(false);
  });

  test('disabled: logs pin_disabled, sends nothing', async () => {
    const db = smsDb([{ contact_id: 7 }], { portal_enabled: 0 });
    await svc.requestPin(db, { identifier: '2485592400', ip: null });
    await flush();
    const evs = accessLogCalls(db);
    expect(evs).toHaveLength(1);
    expect(eventOf(evs[0])).toBe('pin_disabled');
    expect(contactIdOf(evs[0])).toBe(7);
    expect(phoneService.sendSms).not.toHaveBeenCalled();
  });

  test('sms happy path: counter incremented, pin stored hashed, sms sent, pin_sent', async () => {
    const db = smsDb([{ contact_id: 7 }]);
    await svc.requestPin(db, { identifier: '(248) 559-2400', ip: '9.9.9.9' });
    await flush();

    // Counter incremented 0 → 1.
    const persist = db.calls.find(c => /UPDATE app_settings/.test(c.sql));
    expect(JSON.parse(persist.params[0])).toEqual({ ym: UTC_YM, count: 1, alerted_ym: '' });

    // PIN row: (contact_id, channel, destination, pin_hash, ip); hash is
    // 64-hex, never the raw pin.
    const pinIns = db.calls.find(c => /INSERT INTO portal_login_pins/.test(c.sql));
    expect(pinIns.params[0]).toBe(7);
    expect(pinIns.params[1]).toBe('sms');
    expect(pinIns.params[2]).toBe('2485592400');
    expect(pinIns.params[3]).toMatch(/^[a-f0-9]{64}$/);
    expect(pinIns.sql).toMatch(/INTERVAL 10 MINUTE/);

    // SMS sent to the typed (normalized) destination with a 6-digit code
    // matching the stored hash.
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
    const [, from, to, msg] = phoneService.sendSms.mock.calls[0];
    expect(from).toBe('2485592400');
    expect(to).toBe('2485592400');
    const pin = msg.match(/(\d{6})/)[1];
    expect(hashPin(pin)).toBe(pinIns.params[3]);

    const evs = accessLogCalls(db);
    expect(evs.map(eventOf)).toEqual(['pin_sent']);
    expect(metaOf(evs[0])).toEqual({ channel: 'sms' });
  });

  test('email path: portal_email_from used; email_default_from only when row missing', async () => {
    const emailDb = () => stubDb([
      { re: /FROM contact_emails/, rows: [{ contact_id: 7 }] },
      { re: /SELECT portal_enabled FROM contacts/, rows: [{ portal_enabled: 1 }] },
      { re: /INSERT INTO portal_login_pins/, rows: { insertId: 1 } },
      ACCESS_LOG,
    ]);

    let db = emailDb();
    await svc.requestPin(db, { identifier: 'fred@example.com', ip: null });
    await flush();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail.mock.calls[0][1].from).toBe('office@4lsg.com');
    expect(emailService.sendEmail.mock.calls[0][1].to).toBe('fred@example.com');

    // Setting row missing → fallback sender.
    settingsService.getSettings.mockImplementation(async (db, keys) => {
      const out = {}; for (const k of keys) out[k] = null;
      out.email_default_from = 'stuart@4lsg.com';
      return out;
    });
    db = emailDb();
    await svc.requestPin(db, { identifier: 'fred@example.com', ip: null });
    await flush();
    expect(emailService.sendEmail.mock.calls[1][1].from).toBe('stuart@4lsg.com');
  });

  test('send failure: still ok, pin_send_failed logged, alert fired', async () => {
    phoneService.sendSms.mockRejectedValue(new Error('carrier down'));
    const db = smsDb([{ contact_id: 7 }]);
    const out = await svc.requestPin(db, { identifier: '2485592400', ip: null });
    await flush(); await flush();
    expect(out).toEqual({ ok: true });
    const evs = accessLogCalls(db).map(eventOf);
    expect(evs).toContain('pin_sent');
    expect(evs).toContain('pin_send_failed');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].kind).toBe('portal_pin_send_failed');
  });

  test('cap: under-cap increments; at-cap blocks + logs + single alert per month', async () => {
    // At cap, not yet alerted this month.
    settingsService.getSettings.mockImplementation(async (db, keys) => {
      const out = {}; for (const k of keys) out[k] = null;
      out.portal_sms_counter = JSON.stringify({ ym: UTC_YM, count: 300, alerted_ym: '' });
      out.portal_sms_monthly_cap = '300';
      return out;
    });
    let db = smsDb([{ contact_id: 7 }]);
    await svc.requestPin(db, { identifier: '2485592400', ip: null });
    await flush();
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(db.calls.some(c => /portal_login_pins/.test(c.sql))).toBe(false);
    expect(accessLogCalls(db).map(eventOf)).toEqual(['pin_capped']);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].kind).toBe('portal_sms_capped');
    // alerted_ym persisted so the alert fires once per month.
    const persist = db.calls.find(c => /UPDATE app_settings/.test(c.sql));
    expect(JSON.parse(persist.params[0]).alerted_ym).toBe(UTC_YM);

    // Second capped request in the same month: no second alert.
    settingsService.getSettings.mockImplementation(async (db, keys) => {
      const out = {}; for (const k of keys) out[k] = null;
      out.portal_sms_counter = JSON.stringify({ ym: UTC_YM, count: 300, alerted_ym: UTC_YM });
      out.portal_sms_monthly_cap = '300';
      return out;
    });
    db = smsDb([{ contact_id: 7 }]);
    await svc.requestPin(db, { identifier: '2485592400', ip: null });
    await flush();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(accessLogCalls(db).map(eventOf)).toEqual(['pin_capped']);
  });

  test('cap: month rollover resets the count and sends', async () => {
    settingsService.getSettings.mockImplementation(async (db, keys) => {
      const out = {}; for (const k of keys) out[k] = null;
      out.portal_sms_counter = JSON.stringify({ ym: '2020-01', count: 300, alerted_ym: '2020-01' });
      out.portal_sms_monthly_cap = '300';
      return out;
    });
    const db = smsDb([{ contact_id: 7 }]);
    await svc.requestPin(db, { identifier: '2485592400', ip: null });
    await flush();
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
    const persist = db.calls.find(c => /UPDATE app_settings/.test(c.sql));
    expect(JSON.parse(persist.params[0])).toEqual({ ym: UTC_YM, count: 1, alerted_ym: '2020-01' });
    expect(accessLogCalls(db).map(eventOf)).toEqual(['pin_sent']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyPin
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyPin', () => {
  beforeEach(() => jest.clearAllMocks());

  function verifyDb({ pinRow, contactRow = { portal_enabled: 1, portal_session_version: 3 } }) {
    return stubDb([
      { re: /FROM contact_phones/, rows: [{ contact_id: 7 }] },
      { re: /SELECT id, pin_hash, attempts/, rows: pinRow ? [pinRow] : [] },
      { re: /UPDATE portal_login_pins SET attempts/, rows: { affectedRows: 1 } },
      { re: /UPDATE portal_login_pins SET consumed_at/, rows: { affectedRows: 1 } },
      { re: /SELECT portal_enabled, portal_session_version FROM contacts/,
        rows: contactRow ? [contactRow] : [] },
      ACCESS_LOG,
    ]);
  }
  const goodRow = pin => ({ id: 42, pin_hash: hashPin(pin), attempts: 0, live: 1 });

  test('newest-row query shape: unconsumed, per (contact,channel), ORDER BY id DESC LIMIT 1', async () => {
    const db = verifyDb({ pinRow: goodRow('111111') });
    await svc.verifyPin(db, { identifier: '2485592400', pin: '111111', trustDevice: true });
    const sel = db.calls.find(c => /SELECT id, pin_hash, attempts/.test(c.sql));
    expect(sel.sql).toMatch(/consumed_at IS NULL/);
    expect(sel.sql).toMatch(/ORDER BY id DESC LIMIT 1/);
    expect(sel.sql).toMatch(/expires_at > NOW\(\)/);
    expect(sel.params).toEqual([7, 'sms']);
  });

  test('wrong pin: fails, attempts incremented, not consumed', async () => {
    const db = verifyDb({ pinRow: goodRow('111111') });
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '222222', trustDevice: true });
    expect(out).toEqual({ ok: false });
    expect(db.calls.some(c => /SET attempts = attempts \+ 1/.test(c.sql))).toBe(true);
    expect(db.calls.some(c => /consumed_at = NOW/.test(c.sql))).toBe(false);
  });

  test('6th attempt fails even with the CORRECT pin (attempts=5), no further increment', async () => {
    const db = verifyDb({ pinRow: { id: 42, pin_hash: hashPin('111111'), attempts: 5, live: 1 } });
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '111111', trustDevice: true });
    expect(out).toEqual({ ok: false });
    expect(db.calls.some(c => /SET attempts/.test(c.sql))).toBe(false);
  });

  test('expired pin fails', async () => {
    const db = verifyDb({ pinRow: { id: 42, pin_hash: hashPin('111111'), attempts: 0, live: 0 } });
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '111111', trustDevice: true });
    expect(out).toEqual({ ok: false });
  });

  test('single-use: no unconsumed row ⇒ fail', async () => {
    const db = verifyDb({ pinRow: null });
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '111111', trustDevice: true });
    expect(out).toEqual({ ok: false });
  });

  test('supersession: only the newest row counts — old pin fails, new pin wins', async () => {
    // The query returns the NEWEST row (pin B). Old pin A fails against it…
    let db = verifyDb({ pinRow: goodRow('222222') });
    let out = await svc.verifyPin(db, { identifier: '2485592400', pin: '111111', trustDevice: true });
    expect(out).toEqual({ ok: false });
    // …and pin B succeeds.
    db = verifyDb({ pinRow: goodRow('222222') });
    out = await svc.verifyPin(db, { identifier: '2485592400', pin: '222222', trustDevice: true });
    expect(out.ok).toBe(true);
  });

  test('multi-match identifier fails verification', async () => {
    const db = stubDb([
      { re: /FROM contact_phones/, rows: [{ contact_id: 7 }, { contact_id: 9 }] },
    ]);
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '111111', trustDevice: true });
    expect(out).toEqual({ ok: false });
  });

  test('success: consumed, login logged; token claims EXACTLY {sub,aud,ver,iat,exp} — user_auth ABSENT', async () => {
    const db = verifyDb({ pinRow: goodRow('654321') });
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '654321', trustDevice: true, ip: '9.9.9.9' });
    await flush();
    expect(out.ok).toBe(true);
    expect(db.calls.some(c => /consumed_at = NOW/.test(c.sql))).toBe(true);
    expect(accessLogCalls(db).map(eventOf)).toEqual(['login']);

    const payload = jwt.verify(out.token, SECRET);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'sub', 'ver']);
    expect(payload.sub).toBe(7);
    expect(payload.aud).toBe('contact');
    expect(payload.ver).toBe(3);          // CURRENT portal_session_version
    expect(payload.user_auth).toBeUndefined();
  });

  test('expiry: 90d when trusted, 12h when not', async () => {
    let db = verifyDb({ pinRow: goodRow('654321') });
    let out = await svc.verifyPin(db, { identifier: '2485592400', pin: '654321', trustDevice: true });
    let p = jwt.decode(out.token);
    expect(p.exp - p.iat).toBe(90 * 24 * 3600);

    db = verifyDb({ pinRow: goodRow('654321') });
    out = await svc.verifyPin(db, { identifier: '2485592400', pin: '654321', trustDevice: false });
    p = jwt.decode(out.token);
    expect(p.exp - p.iat).toBe(12 * 3600);
  });

  test('disabled flipped between request and verify: fail after consume, no token', async () => {
    const db = verifyDb({
      pinRow: goodRow('654321'),
      contactRow: { portal_enabled: 0, portal_session_version: 3 },
    });
    const out = await svc.verifyPin(db, { identifier: '2485592400', pin: '654321', trustDevice: true });
    expect(out).toEqual({ ok: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireAuth — contact path
// ─────────────────────────────────────────────────────────────────────────────

describe('requireAuth({audience:"contact"})', () => {
  const mw = requireAuth({ audience: 'contact' });
  const contactToken = (claims = {}) =>
    jwt.sign(Object.assign({ sub: 7, aud: 'contact', ver: 3 }, claims), SECRET, { expiresIn: '1h' });

  function contactDb(row = { portal_enabled: 1, portal_session_version: 3 }) {
    return stubDb([
      { re: /SELECT portal_enabled, portal_session_version FROM contacts/, rows: row ? [row] : [] },
      ACCESS_LOG,
    ]);
  }

  test('accepts a valid contact token; access log row carries contact_id', async () => {
    const db = contactDb();
    const req = baseReq({ db, headers: { authorization: 'Bearer ' + contactToken() } });
    const res = stubRes();
    const out = await runMw(mw, req, res);
    expect(out.via).toBe('next');
    expect(req.auth).toEqual({ type: 'portal', contactId: 7 });

    res.emit('finish'); // route would end the response
    await flush();
    const evs = accessLogCalls(db);
    expect(evs).toHaveLength(1);
    expect(contactIdOf(evs[0])).toBe(7);
    expect(evs[0].params[2]).toBe('/api/portal/me'); // route
  });

  test('failures also log (missing token): row with NULL contact_id', async () => {
    const db = contactDb();
    const req = baseReq({ db, headers: {} });
    const res = stubRes();
    const out = await runMw(mw, req, res);
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
    await flush();
    const evs = accessLogCalls(db);
    expect(evs).toHaveLength(1);
    expect(contactIdOf(evs[0])).toBeNull();
    expect(evs[0].params[4]).toBe(401); // status
  });

  test('rejects staff-audience token — DB never queried', async () => {
    const staffish = jwt.sign(
      { sub: 6, aud: 'staff', user_auth: 'authorized - SU', ver: 1 }, SECRET, { expiresIn: '1h' });
    const db = contactDb();
    const req = baseReq({ db, headers: { authorization: 'Bearer ' + staffish } });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
    expect(db.calls.some(c => /FROM contacts/.test(c.sql))).toBe(false);
  });

  test('rejects missing-aud (legacy staff) token', async () => {
    const legacy = jwt.sign({ sub: 6, user_auth: 'authorized', ver: 1 }, SECRET, { expiresIn: '1h' });
    const req = baseReq({ db: contactDb(), headers: { authorization: 'Bearer ' + legacy } });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401 });
  });

  test('rejects session-version mismatch (revoke)', async () => {
    const req = baseReq({
      db: contactDb({ portal_enabled: 1, portal_session_version: 4 }),
      headers: { authorization: 'Bearer ' + contactToken({ ver: 3 }) },
    });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
  });

  test('rejects portal_enabled = 0', async () => {
    const req = baseReq({
      db: contactDb({ portal_enabled: 0, portal_session_version: 3 }),
      headers: { authorization: 'Bearer ' + contactToken() },
    });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
  });

  test('rejects unknown contact and garbage token — same uniform body', async () => {
    let out = await runMw(mw, baseReq({
      db: contactDb(null),
      headers: { authorization: 'Bearer ' + contactToken() },
    }), stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });

    out = await runMw(mw, baseReq({ headers: { authorization: 'Bearer not.a.jwt' } }), stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
  });

  test('factory throws on unknown audience (config error, mount time)', () => {
    expect(() => requireAuth({ audience: 'martian' })).toThrow(/unknown audience/);
    expect(() => requireAuth({})).toThrow(/unknown audience/);
  });

  // ── global kill switch (app_settings.portal_live) ─────────────────────────
  // settingsService is jest-mocked file-wide (top of file), so the switch is
  // driven through getSetting's mock, not DB stub rows. The suite default
  // (jest.fn() → undefined) reads as LIVE — which is itself the fail-open
  // contract under test. getSetting (singular) has no other caller in this
  // suite (requestPin's SMS cap uses getSettings), so resetting it is safe.

  describe('portal_live kill switch', () => {
    const { getSetting } = require('../services/settingsService');
    afterEach(() => getSetting.mockReset());

    test("isPortalLive: only an explicit '0' takes the portal down (fail-open)", async () => {
      const dummyDb = {};   // getSetting is mocked — db is passed through, unused
      for (const [v, expected] of [
        [null, true],       // row absent
        [undefined, true],  // defensive: not a real getSetting return, still live
        ['1', true],
        ['0', false],
        [' 0 ', false],     // trimmed
        ['yes', true],      // junk = live
        ['', true],
      ]) {
        getSetting.mockResolvedValueOnce(v);
        await expect(requireAuth.isPortalLive(dummyDb)).resolves.toBe(expected);
      }
      expect(getSetting).toHaveBeenCalledWith(dummyDb, 'portal_live');
    });

    test("portal_live '0': valid token still 401s — contacts never read (portal is DOWN)", async () => {
      getSetting.mockResolvedValue('0');
      const db = contactDb();
      const req = baseReq({ db, headers: { authorization: 'Bearer ' + contactToken() } });
      const out = await runMw(mw, req, stubRes());
      expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
      expect(db.calls.some(c => /FROM contacts/.test(c.sql))).toBe(false);
      expect(getSetting).toHaveBeenCalledWith(db, 'portal_live');
    });

    test("portal_live '1': valid token passes as normal", async () => {
      getSetting.mockResolvedValue('1');
      const db = contactDb();
      const req = baseReq({ db, headers: { authorization: 'Bearer ' + contactToken() } });
      const out = await runMw(mw, req, stubRes());
      expect(out.via).toBe('next');
      expect(req.auth).toEqual({ type: 'portal', contactId: 7 });
    });

    test('switch read happens AFTER token checks — junk requests never cost it', async () => {
      getSetting.mockResolvedValue('0');
      await runMw(mw, baseReq({ db: contactDb(), headers: {} }), stubRes());   // no token
      expect(getSetting).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// jwtOrApiKey — D3 audience guard + roles carry
// ─────────────────────────────────────────────────────────────────────────────

describe('jwtOrApiKey D3 changes', () => {
  const legacyToken = jwt.sign(
    { sub: 6, username: 'IT', user_type: 'admin', user_auth: 'authorized - SU', ver: 1 },
    SECRET, { expiresIn: '1h' });
  const staffToken = jwt.sign(
    { sub: 6, username: 'IT', user_type: 'admin', user_auth: 'authorized - SU',
      aud: 'staff', roles: ['it', 'admin'], ver: 1 },
    SECRET, { expiresIn: '1h' });
  const portalToken = jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' });

  test('legacy no-aud token still passes; roles defaults to []', async () => {
    const req = baseReq({ headers: { authorization: 'Bearer ' + legacyToken } });
    const out = await runMw(jwtOrApiKey, req, stubRes());
    expect(out.via).toBe('next');
    expect(req.auth.type).toBe('jwt');
    expect(req.auth.roles).toEqual([]);
  });

  test('aud:"staff" token passes; roles carried onto req.auth', async () => {
    const req = baseReq({ headers: { authorization: 'Bearer ' + staffToken } });
    const out = await runMw(jwtOrApiKey, req, stubRes());
    expect(out.via).toBe('next');
    expect(req.auth.roles).toEqual(['it', 'admin']);
  });

  test('portal (aud:"contact") token rejected 401', async () => {
    const req = baseReq({ headers: { authorization: 'Bearer ' + portalToken } });
    const out = await runMw(jwtOrApiKey, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
  });

  test('portal-shaped token with forged user_auth still rejected by the aud guard', async () => {
    const forged = jwt.sign(
      { sub: 7, aud: 'contact', user_auth: 'authorized', ver: 1 }, SECRET, { expiresIn: '1h' });
    const req = baseReq({ headers: { authorization: 'Bearer ' + forged } });
    const out = await runMw(jwtOrApiKey, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401 });
  });

  test('exports logJwtApiAttempt as a property; module.exports stays a function', () => {
    expect(typeof jwtOrApiKey).toBe('function');
    expect(typeof jwtOrApiKey.logJwtApiAttempt).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireAuth — staff path (mounted nowhere this slice; ships complete)
// ─────────────────────────────────────────────────────────────────────────────

describe('requireAuth({audience:"staff"})', () => {
  const tok = (claims = {}) => jwt.sign(Object.assign(
    { sub: 5, username: 'sb', user_type: 'staff', user_auth: 'authorized', aud: 'staff', ver: 1 },
    claims), SECRET, { expiresIn: '1h' });

  test('roles gate: token lacking a required role → 403 Forbidden', async () => {
    const mw = requireAuth({ audience: 'staff', roles: ['admin'] });
    const req = baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['staff'] }) } });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 403, body: { error: 'Forbidden' } });
  });

  test('roles gate: matching role passes; req.auth carries roles', async () => {
    const mw = requireAuth({ audience: 'staff', roles: ['admin'] });
    const req = baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['admin', 'staff'] }) } });
    const out = await runMw(mw, req, stubRes());
    expect(out.via).toBe('next');
    expect(req.auth).toMatchObject({ type: 'jwt', userId: 5, roles: ['admin', 'staff'] });
  });

  test('"it" bypasses the role check (only the role check)', async () => {
    const mw = requireAuth({ audience: 'staff', roles: ['admin'] });
    const req = baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['it'] }) } });
    const out = await runMw(mw, req, stubRes());
    expect(out.via).toBe('next');
  });

  test('legacy token (no roles claim) fails a roles-required route CLOSED', async () => {
    const legacy = jwt.sign(
      { sub: 6, username: 'IT', user_type: 'admin', user_auth: 'authorized - SU', ver: 1 },
      SECRET, { expiresIn: '1h' });
    const mw = requireAuth({ audience: 'staff', roles: ['it'] });
    const req = baseReq({ headers: { authorization: 'Bearer ' + legacy } });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 403 });
  });

  test('legacy token passes when no roles are required', async () => {
    const legacy = jwt.sign(
      { sub: 6, username: 'IT', user_type: 'admin', user_auth: 'authorized', ver: 1 },
      SECRET, { expiresIn: '1h' });
    const mw = requireAuth({ audience: 'staff' });
    const out = await runMw(mw, baseReq({ headers: { authorization: 'Bearer ' + legacy } }), stubRes());
    expect(out.via).toBe('next');
  });

  test('portal token on a staff route → 401 (aud guard, before roles)', async () => {
    const portal = jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' });
    const mw = requireAuth({ audience: 'staff', roles: ['it'] });
    const out = await runMw(mw, baseReq({ headers: { authorization: 'Bearer ' + portal } }), stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401, body: { error: 'Unauthorized' } });
  });

  test('no bearer header → 401', async () => {
    const mw = requireAuth({ audience: 'staff' });
    const out = await runMw(mw, baseReq({}), stubRes());
    expect(out).toMatchObject({ via: 'res', status: 401 });
  });

  test('staff-path audit parity: writes jwt_api_audit_log rows like jwtOrApiKey', async () => {
    const mw = requireAuth({ audience: 'staff' });
    const req = baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['staff'] }) } });
    await runMw(mw, req, stubRes());
    await flush();
    const audit = req.db.calls.filter(c => /jwt_api_audit_log/.test(c.sql));
    expect(audit).toHaveLength(1);
    // (route, method, headers, query, body, ip, ua, auth_type, username, status)
    expect(audit[0].params[7]).toBe('jwt');
    expect(audit[0].params[9]).toBe('authorized');
  });
});
