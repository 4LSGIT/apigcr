/**
 * tests/optout.routes.test.js — POST /internal/email/send under YisraMail D18
 * (2026-10-29): an email opt-out is MARKETING-only, so this operational send
 * route is never refused or warned by one — not by the row flag
 * (contact_emails.email_optout, the cache) nor by the address's consent state
 * — for a staff JWT or an API key alike, and the gate issues no consent read
 * at all. The call stays in place for C7 (promotional sends). (/internal/sms
 * and /internal/mms keep the 2026-10-27 rule — warn staff, refuse automation —
 * and are pinned in tests/phoneSPH.routes.test.js; the comms hub routes in
 * phoneSPH.routes / mailboxS3.send.)
 *
 * HARNESS: the real router + lib/auth.jwtOrApiKey over an ephemeral express
 * app; the database answers ONLY optoutService's lookups (tests/helpers/
 * optoutFake.js) — any other statement throws, except the auth audit insert
 * the middleware fires and forgets. The send seam emailService.sendEmail is
 * spied; under it nodemailer.createTransport is a recorder that refuses, and
 * every non-local fetch is refused and recorded — afterAll proves nothing
 * escaped.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'optout-routes-test-secret';
process.env.INTERNAL_API_KEY = 'yci_optout_routes_internal';

const escaped = [];
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => { escaped.push('smtp'); throw new Error('test: SMTP is unreachable'); }) };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const { answerOptout } = require('./helpers/optoutFake');
const emailRouter = require('../routes/internal/email');

const EMAILS = [
  { id: 1, contact_id: 900, email: 'Pat@Example.com', end_date: null, email_optout: 1 },
  { id: 2, contact_id: 901, email: 'sam@example.com', end_date: null, email_optout: 0 },
];
const CONTACTS = [{ contact_id: 900, contact_name: 'Pat One' }, { contact_id: 901, contact_name: 'Sam Two' }];
// An address opted out both ways the reader knows: Pat by the row flag (the
// cache), Lee by the consent state alone (marketing scope).
const STATES = [{ channel: 'email', destination: 'lee@example.com', scope: 'marketing', state: 'opted_out', last_event_id: 5 }];
const consentReads = [];
const db = {
  async query(sql, p) {
    const oo = answerOptout(sql, p, { emails: EMAILS, contacts: CONTACTS, states: STATES });
    if (oo) { consentReads.push(sql); return oo; }
    if (/^\s*INSERT INTO jwt_api_audit_log/.test(sql)) return [{ insertId: 1 }];
    throw new Error(`optout.routes fake db: unscripted statement: ${sql}`);
  },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.db = db; next(); });
app.use(emailRouter);

const realFetch = global.fetch;
let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    escaped.push(String(url));
    throw new Error('test: the network is unreachable');
  };
});
afterAll(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  expect(escaped).toEqual([]);
});

let sent;
beforeEach(() => {
  sent = [];
  jest.spyOn(emailService, 'sendEmail').mockImplementation(async (_db, o) => { sent.push(o.to); return { messageId: '<m>' }; });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const staff = () => jwt.sign({ sub: '22', username: 'rena', user_auth: 'authorized', roles: [], aud: 'staff' }, process.env.JWT_SECRET);
async function post(body, { t, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetch(`${base}/internal/email/send`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
const MAIL = (over = {}) => ({ from: 'firm@firm.test', to: 'pat@example.com', subject: 'S', text: 'T', ...over });

test('staff JWT (D18): an email opt-out — row flag or consent state — never warns this operational send; no consent read is made', async () => {
  for (const to of ['pat@example.com', 'Sam <sam@example.com>, PAT@EXAMPLE.COM', 'lee@example.com']) {
    const r = await post(MAIL({ to }), { t: staff() });
    expect([to, r.status, r.json.code]).toEqual([to, 200, undefined]);
  }
  // acknowledge_optout is irrelevant when nobody can be opted out: any value sends.
  for (const ack of ['true', 1, true]) expect((await post(MAIL({ acknowledge_optout: ack }), { t: staff() })).status).toBe(200);
  expect(sent).toEqual(['pat@example.com', 'Sam <sam@example.com>, PAT@EXAMPLE.COM', 'lee@example.com',
    'pat@example.com', 'pat@example.com', 'pat@example.com']);
  expect(consentReads).toEqual([]);
});

test('API key (automation, D18): the email is operational — it SENDS to a marketing opt-out; nothing reads consent', async () => {
  for (const body of [MAIL(), MAIL({ acknowledge_optout: true }), MAIL({ to: 'lee@example.com' }), MAIL({ to: 'sam@example.com' })]) {
    const r = await post(body, { apiKey: process.env.INTERNAL_API_KEY });
    expect(r.status).toBe(200);
  }
  expect(sent).toEqual(['pat@example.com', 'pat@example.com', 'lee@example.com', 'sam@example.com']);
  expect(consentReads).toEqual([]);
});
