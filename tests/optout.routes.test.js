/**
 * tests/optout.routes.test.js — POST /internal/email/send under the opt-out
 * ruling (2026-10-27): a staff JWT (the contact Communicate tab, the sending
 * forms) is WARNED — 409 opted_out until acknowledge_optout:true; an API-key
 * caller is automation and is REFUSED 422 whatever it sends. (/internal/sms
 * and /internal/mms carry a grant gate and are pinned in
 * tests/phoneSPH.routes.test.js; the comms hub routes in phoneSPH.routes /
 * mailboxS3.send.)
 *
 * HARNESS: the real router + lib/auth.jwtOrApiKey over an ephemeral express
 * app; the database answers ONLY optoutService's lookup (tests/helpers/
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
const db = {
  async query(sql, p) {
    const oo = answerOptout(sql, p, { emails: EMAILS, contacts: CONTACTS });
    if (oo) return oo;
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

test('staff JWT: 409 opted_out (any address in a list), nothing sent; acknowledge_optout:true sends; only a literal true counts', async () => {
  for (const to of ['pat@example.com', 'Sam <sam@example.com>, PAT@EXAMPLE.COM']) {
    const r = await post(MAIL({ to }), { t: staff() });
    expect([to, r.status, r.json.code]).toEqual([to, 409, 'opted_out']);
    expect(r.json.opted_out).toEqual([{ channel: 'email', destination: 'pat@example.com', contact_id: 900, contact_name: 'Pat One', row_id: 1 }]);
  }
  for (const ack of ['true', 1]) expect((await post(MAIL({ acknowledge_optout: ack }), { t: staff() })).status).toBe(409);
  expect(sent).toEqual([]);
  expect((await post(MAIL({ acknowledge_optout: true }), { t: staff() })).status).toBe(200);
  expect(sent).toEqual(['pat@example.com']);
});

test('API key (automation): REFUSED 422 even when it acknowledges; a consenting address sends without one', async () => {
  for (const body of [MAIL(), MAIL({ acknowledge_optout: true })]) {
    const r = await post(body, { apiKey: process.env.INTERNAL_API_KEY });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: 'opted_out', message: expect.stringMatching(/^Not sent — Pat One pat@example\.com \(contact #900\) has opted out of email\. Automation never/) });
  }
  expect(sent).toEqual([]);
  expect((await post(MAIL({ to: 'sam@example.com' }), { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(200);
  expect((await post(MAIL({ to: 'sam@example.com' }), { t: staff() })).status).toBe(200);
  expect(sent).toEqual(['sam@example.com', 'sam@example.com']);
});
