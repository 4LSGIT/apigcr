// tests/sendRoutes.idempotency.test.js
//
/**
 * Idempotency-Key on the REAL send routes (routes/api.phoneComms.js
 * POST /api/phone-lines/:id/sms, scope phone_lines.sms_send; routes/api.mail.js
 * POST /api/mail/send, scope mail.send) behind the REAL lib/auth.jwtOrApiKey,
 * through the real send services and provider adapters, to a STUBBED
 * transport at the lowest layer:
 *   SMS    global fetch — the Quo adapter's POST to api.openphone.com is
 *          recorded and answered; every other non-local URL THROWS.
 *   email  nodemailer.createTransport — the SMTP adapter's sendMail is a recorder.
 *
 * Ported at Casey v2 S6 (2026-11-24) from the retired v1 suite
 * caseySend.routes.test.js, whose card half (the normalizer, the page's
 * builder, the opt-out confirm) went with v1. These are the ROUTE's cases —
 * the double-send protection every Casey v2 card relies on, since
 * public/casey.html sends `Idempotency-Key: casey:<card>:<step>` on every step:
 *   key        a repeat replays the first result and the provider is called ONCE;
 *   ambiguous  a provider failure after dispatch KEEPS the claim: the same key
 *              is 409 (in_flight → unknown), never a second provider call;
 *   refusal    a pre-dispatch refusal (inactive line, no send grant) releases it;
 *   native     no key = the old behaviour: two posts, two sends; a malformed key is 400.
 *
 * NOTHING HERE CAN SEND: `afterAll` asserts the network guard never saw an
 * un-stubbed URL. The database is the stateful fake worlds of the comms suites
 * (tests/helpers/phoneSPHWorld.js, tests/helpers/mailboxS3World.js) extended
 * with the idempotency statements; unknown statements THROW — no pool, no
 * proxy, no production.
 *
 * Run: npx jest tests/sendRoutes.idempotency.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'send-routes-idem-secret';
process.env.EMAIL_DOMAINS = 'firm.test';
delete process.env.SU_STEPUP;

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});
jest.mock('../lib/credentialInjection', () => {
  const actual = jest.requireActual('../lib/credentialInjection');
  return {
    ...actual,
    loadCredential: jest.fn(async (db, id) => ({ id, name: 'Quo key', type: 'api_key' })),
    buildHeadersForCredential: jest.fn(async () => ({ Authorization: 'test-key' })),
  };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const { SQL } = require('../lib/requestIdempotency');
const { encrypt } = require('../lib/credentialCrypto');
const { _resetRateLimits } = require('../lib/auth.superuser');
const transport = require('../services/mailbox/imapTransport');
const { makeWorld: makePhoneWorld } = require('./helpers/phoneSPHWorld');
const { makeWorld: makeMailWorld } = require('./helpers/mailboxS3World');
const phoneRouter = require('../routes/api.phoneComms');
const mailRouter = require('../routes/api.mail');

// ── The idempotency + provider-side statements on top of a world ───────────
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
function withSendStatements(world, extra = () => undefined) {
  const rows = [];
  let nextId = 1;
  const inner = world.db.query.bind(world.db);
  return {
    rows,
    getConnection: async () => { throw new Error('the fake pool hands out no connections'); },
    async query(sql, p = []) {
      if (sql === SQL.claim) {
        const [user_id, scope, idem_key] = p;
        if (rows.some((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
          throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
        }
        const row = { id: nextId++, user_id, scope, idem_key, status: 'in_flight', result: null, at: Date.now() };
        rows.push(row);
        return [{ insertId: row.id, affectedRows: 1 }];
      }
      if (sql === SQL.read) {
        const row = rows.find((r) => r.user_id === p[0] && r.scope === p[1] && r.idem_key === p[2]);
        return [row ? [{ id: row.id, status: row.status, result: row.result, age_s: Math.floor((Date.now() - row.at) / 1000) }] : []];
      }
      if (sql === SQL.settle) {
        const row = rows.find((r) => r.id === p[1] && r.status === 'in_flight');
        if (!row) return [{ affectedRows: 0 }];
        row.status = 'applied'; row.result = JSON.parse(p[0]);
        return [{ affectedRows: 1 }];
      }
      if (sql === SQL.release) {
        const i = rows.findIndex((r) => r.id === p[0] && r.status === 'in_flight');
        if (i >= 0) rows.splice(i, 1);
        return [{ affectedRows: i >= 0 ? 1 : 0 }];
      }
      const handled = extra(norm(sql), p);
      if (handled !== undefined) return handled;
      return inner(sql, p);
    },
  };
}

// ── The network guard: the ONLY way out of this process ────────────────────
const realFetch = global.fetch;
let base = null;
let quoCalls = [];
let quoReply = () => ({ status: 200, body: { data: { id: 'AC-1', status: 'queued' } } });
const escaped = [];
function installFetchGuard() {
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (base && u.startsWith(base)) return realFetch(url, init);
    if (u === 'https://api.openphone.com/v1/messages') {
      quoCalls.push(JSON.parse(init.body));
      const r = quoReply();
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    escaped.push(u);
    throw new Error(`network guard: refused ${u}`);
  });
}

const tok = (user, roles = []) => jwt.sign({ sub: String(user), username: `u${user}`, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);
async function post(urlPath, body, t, headers = {}) {
  const r = await realFetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json };
}

let current = null;   // { db } the app serves this test with
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.db = current.db; next(); });
app.use(phoneRouter);
app.use(mailRouter);
let server;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  // The proof: nothing in this file ever reached an un-stubbed destination.
  expect(escaped).toEqual([]);
});
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  _resetRateLimits();
  phoneRouter._resetSendRateLimit();
  mailRouter._resetSendRateLimit();
  quoCalls = [];
  quoReply = () => ({ status: 200, body: { data: { id: 'AC-1', status: 'queued' } } });
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async (opts) => ({ messageId: opts.messageId || '<auto@relay>', response: '250 OK', accepted: [opts.to], rejected: [], envelope: {} }));
  installFetchGuard();
  jest.spyOn(transport, 'appendSent').mockResolvedValue({ appended: true, folder: 'INBOX.Sent', uid: 9, reason: null });
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
describe('SMS: POST /api/phone-lines/:id/sms → Quo, with an Idempotency-Key', () => {
  const RENA = 22;
  function phoneWorld() {
    const W = makePhoneWorld();
    W.grant(RENA, 3, { can_read: true, can_send: true });
    W.grant(RENA, 7, { can_read: true, can_send: true });
    const smsLog = [];
    const db = withSendStatements(W, (sql, p) => {
      if (sql === 'SELECT id, phone_number, display_name, provider, provider_id, credential_id, active, mms_capable FROM phone_lines WHERE phone_number = ? LIMIT 1') {
        return [W.T.phone_lines.filter((l) => l.phone_number === p[0])];
      }
      if (/^INSERT INTO rc_messages_log /.test(sql)) { smsLog.push(p); return [{ insertId: smsLog.length }]; }
      return undefined;
    });
    return { W, db, smsLog };
  }

  test('the key replays: the provider is called ONCE, the second answer is the first with replayed:true, one audited send', async () => {
    const world = phoneWorld(); current = world;
    const body = { to: '3135550001', message: 'Hi Pat — your 341 is Tuesday.' };
    const first = await post('/api/phone-lines/3/sms', body, tok(RENA), { 'Idempotency-Key': 'card-replay-1' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'success', line_id: 3, to: '3135550001', result: { id: 'AC-1', status: 'queued' } });
    expect(quoCalls).toEqual([{ content: body.message, from: 'PNx3', to: ['+13135550001'], setInboxStatus: 'done' }]);
    expect(Buffer.from(quoCalls[0].content).equals(Buffer.from(body.message))).toBe(true);   // the bytes the caller sent

    const again = await post('/api/phone-lines/3/sms', body, tok(RENA), { 'Idempotency-Key': 'card-replay-1' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, result: { id: 'AC-1' } });
    expect(quoCalls).toHaveLength(1);
    expect(world.db.rows).toEqual([expect.objectContaining({ scope: 'phone_lines.sms_send', idem_key: 'card-replay-1', status: 'applied' })]);
    // A replay sent nothing, so only ONE send is audited.
    expect(world.W.T.admin_audit_log.filter((a) => a.tool === 'phone_send' && a.status === 'sent')).toHaveLength(1);
  });

  test('a provider failure after dispatch KEEPS the claim: the same key never reaches Quo again', async () => {
    const world = phoneWorld(); current = world;
    quoReply = () => ({ status: 504, body: { message: 'gateway timeout' } });
    const body = { to: '3135550001', message: 'Hello' };
    const first = await post('/api/phone-lines/3/sms', body, tok(RENA), { 'Idempotency-Key': 'card-ambiguous-1' });
    expect(first.status).toBe(502);
    expect(quoCalls).toHaveLength(1);
    quoReply = () => ({ status: 200, body: { data: { id: 'AC-2', status: 'queued' } } });
    const again = await post('/api/phone-lines/3/sms', body, tok(RENA), { 'Idempotency-Key': 'card-ambiguous-1' });
    expect(again.status).toBe(409);
    expect(again.json.idempotency).toEqual({ outcome: 'in_flight' });
    expect(quoCalls).toHaveLength(1);
    expect(world.db.rows).toEqual([expect.objectContaining({ status: 'in_flight' })]);
  });

  test('a pre-dispatch refusal releases the claim; no key keeps the native behaviour', async () => {
    const world = phoneWorld(); current = world;
    const refused = await post('/api/phone-lines/7/sms', { to: '3135550001', message: 'x' }, tok(RENA), { 'Idempotency-Key': 'card-inactive-1' });
    expect(refused.status).toBe(409);
    expect(world.db.rows).toEqual([]);
    expect(quoCalls).toHaveLength(0);
    for (let i = 0; i < 2; i++) expect((await post('/api/phone-lines/3/sms', { to: '3135550001', message: 'same' }, tok(RENA))).status).toBe(200);
    expect(quoCalls).toHaveLength(2);
    expect(world.db.rows).toEqual([]);
    const bad = await post('/api/phone-lines/3/sms', { to: '3135550001', message: 'x' }, tok(RENA), { 'Idempotency-Key': 'short' });
    expect(bad.status).toBe(400);
    expect(quoCalls).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('email: POST /api/mail/send → SMTP, with an Idempotency-Key', () => {
  const SENDER = 8;
  function mailWorld() {
    const W = makeMailWorld();
    W.user(SENDER, { roles: 'staff' });
    W.cred(1, { email: 'billing@firm.test', from_name: 'Firm Billing', smtp_user: 'billing@firm.test', smtp_pass: encrypt('smtp-pw') });
    W.mailbox(1, { address: 'billing@firm.test', display_name: 'Billing', send_credential_id: 1, imap_host: 'imap.firm.test', imap_port: 993,
      imap_user: 'billing@firm.test', imap_secret: 'ENCv1:secret', ingest_enabled: 1,
      ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: true }, 'INBOX.Sent': { emit_to_rules: false } }) });
    W.grant(SENDER, 1, { read: 1, send: 1 });
    return { W, db: withSendStatements(W) };
  }

  test('the key replays: one sendMail, the second answer replayed:true, one audited send', async () => {
    const world = mailWorld(); current = world;
    const body = { mailbox_id: 1, to: ['pat@example.com'], subject: 'Hello Pat', body_text: 'Dear Pat,\n\nYour documents arrived.' };
    const first = await post('/api/mail/send', body, tok(SENDER), { 'Idempotency-Key': 'card-mail-replay-1' });
    expect(first.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const sent = mockSendMail.mock.calls[0][0];
    expect([sent.to, sent.subject, sent.text]).toEqual(['pat@example.com', body.subject, body.body_text]);

    const again = await post('/api/mail/send', body, tok(SENDER), { 'Idempotency-Key': 'card-mail-replay-1' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'success', replayed: true, mailbox_id: 1 });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(world.W.T.admin_audit_log.filter((a) => a.tool === 'mail_send' && a.status === 'sent')).toHaveLength(1);
  });

  test('an SMTP failure keeps the claim; a refusal (no send grant) releases it', async () => {
    const world = mailWorld(); current = world;
    mockSendMail.mockRejectedValueOnce(new Error('Connection timeout'));
    const body = { mailbox_id: 1, to: ['pat@example.com'], subject: 'S', body_text: 'B' };
    expect((await post('/api/mail/send', body, tok(SENDER), { 'Idempotency-Key': 'card-mail-ambig' })).status).toBe(502);
    const again = await post('/api/mail/send', body, tok(SENDER), { 'Idempotency-Key': 'card-mail-ambig' });
    expect([again.status, again.json.idempotency]).toEqual([409, { outcome: 'in_flight' }]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    world.W.user(9, { roles: 'staff' });
    const denied = await post('/api/mail/send', body, tok(9), { 'Idempotency-Key': 'card-mail-denied' });
    expect(denied.status).toBe(404);
    expect(world.db.rows.filter((r) => r.idem_key === 'card-mail-denied')).toEqual([]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});
