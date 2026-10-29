// tests/caseySend.routes.test.js
//
/**
 * Ask Casey A14, end to end: the REAL normalizer (resolving the model's
 * placeholders) → the browser's REAL fixed request builder (extracted from
 * public/assistant.html) → the REAL send routes (routes/api.phoneComms.js,
 * routes/api.mail.js) behind the REAL lib/auth.jwtOrApiKey → the real send
 * services and provider adapters → a STUBBED transport at the lowest layer:
 *   SMS    global fetch — the Quo adapter's POST to api.openphone.com is
 *          recorded and answered; every other non-local URL THROWS.
 *   email  nodemailer.createTransport — the SMTP adapter's sendMail is a
 *          recorder; gmail (fetch) is covered by the same fetch guard.
 * Run: npx jest tests/caseySend.routes.test.js
 *
 * NOTHING HERE CAN SEND. Every external call goes through one of the two
 * stubs, and `afterAll` asserts the guard never saw an un-stubbed URL. The
 * database is the stateful fake worlds of the comms suites
 * (tests/helpers/phoneSPHWorld.js, tests/helpers/mailboxS3World.js), extended
 * with the idempotency statements and the two provider-side statements, and
 * unknown statements THROW — no pool, no proxy, no production.
 *
 * WHAT IS PINNED (mutation-checked — the A14 report lists each mutation):
 *   bytes      the text the provider receives is byte-for-byte the text the
 *              card showed (the normalizer's resolved output), and the routes
 *              re-resolve nothing (a literal brace pair is refused upstream).
 *   key        the card's draft_id rides as Idempotency-Key; a repeat replays
 *              the first result and the provider is called ONCE.
 *   ambiguous  a provider failure after dispatch KEEPS the claim: the same key
 *              is 409 (in_flight → unknown), never a second provider call.
 *   refusal    a pre-dispatch refusal (inactive line) releases the claim.
 *   native     no key = the old behaviour: two posts, two sends.
 *   opt-out    ruling 17: an opted-out NUMBER is proposed (recipient.
 *              opted_out), the builder never acknowledges, and the page's own
 *              dispatch through the REAL public/js/optoutAck.js turns the
 *              route's 409 into the user's confirm and ONE acknowledged
 *              resend under the same key — one provider call, audited
 *              acknowledged_optout; Cancel sends nothing. An email opt-out is
 *              marketing-only (YisraMail D18): a direct email is never marked,
 *              warned or acknowledged.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-a14-send-secret';
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

const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { SQL } = require('../lib/requestIdempotency');
const { encrypt } = require('../lib/credentialCrypto');
const { _resetRateLimits } = require('../lib/auth.superuser');
const assistant = require('../services/assistantService');
const transport = require('../services/mailbox/imapTransport');
const { makeDb: makeProposalDb } = require('./helpers/caseySendProposalDb');
const { makeWorld: makePhoneWorld } = require('./helpers/phoneSPHWorld');
const { makeWorld: makeMailWorld } = require('./helpers/mailboxS3World');
const phoneRouter = require('../routes/api.phoneComms');
const mailRouter = require('../routes/api.mail');

// ── The browser half: the page's own builder, nothing re-implemented ──────
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let parens = 0; let i = m.index + m[0].length - 1;
  for (; i < html.length; i++) { if (html[i] === '(') parens++; else if (html[i] === ')' && --parens === 0) break; }
  let depth = 0;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) return html.slice(m.index, j + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
// eslint-disable-next-line no-new-func
const sendActionRequest = new Function(`${fnSrc('sendIsSms')}\n${fnSrc('sendActionRequest')}\nreturn sendActionRequest;`)();
// The page's dispatch, bound to the REAL helper (run in a JSDOM window, as the
// page loads it) and an apiSend-shaped caller of the real routes.
// eslint-disable-next-line no-new-func
const makeDispatch = new Function('api', 'ycOptoutAck', `${fnSrc('sendActionDispatch')}\nreturn sendActionDispatch;`);
function optoutHelper(confirmAnswer) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'optoutAck.js'), 'utf8'));
  const asked = [];
  dom.window.confirm = (t) => { asked.push(t); return confirmAnswer; };
  return { ycOptoutAck: dom.window.ycOptoutAck, asked };
}
// P.apiSend's contract as the card's api() sees it: a non-2xx throws with status + body.
function pageApi(token, seen) {
  return async (p, body, method, headers) => {
    seen.push({ path: p, body, method, headers });
    const r = await post(p, body, token, headers || {});
    if (r.status >= 400) throw Object.assign(new Error((r.json && r.json.message) || `HTTP ${r.status}`), { status: r.status, body: r.json });
    return r.json;
  };
}

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

/** The proposal reads the normalizer's own fake; channel access falls through to the world (real mailboxService SQL). */
function proposalDb(world, over) {
  const own = makeProposalDb(over);
  return { query: async (sql, p) => {
    try { return await own.query(sql, p); } catch (e) {
      if (!/unscripted statement/.test(e.message)) throw e;
      return world.db.query(sql, p);
    }
  } };
}

const EVID = [{ id: 'q1', purpose: 'Client phones and emails', rows: [
  { contact_id: 1309, contact_name: 'Pat One', phone_id: 12, email_id: 13 },
] }];
const CITE = [{ query_id: 'q1', row_number: 1 }];

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
describe('SMS: card → POST /api/phone-lines/:id/sms → Quo', () => {
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

  test('the provider receives exactly the text the card showed; the key replays, the provider is called once', async () => {
    const world = phoneWorld();
    const draft = await assistant.normalizeActionDraft(proposalDb(world.W),
      { kind: 'sms.send.v1', contact_id: 1309, phone_id: 12, line_id: 3, message: '  Hi {{contacts.contact_fname}} — your 341 is Tuesday.  ', evidence: CITE },
      EVID, { currentUserId: RENA });
    expect(draft.message).toBe('Hi Pat — your 341 is Tuesday.');
    const request = sendActionRequest(draft);
    expect(request).toEqual({ path: '/api/phone-lines/3/sms', method: 'POST', body: { to: '3135550001', message: draft.message }, idempotent: true });

    current = world;
    const first = await post(request.path, request.body, tok(RENA), { 'Idempotency-Key': draft.draft_id });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'success', line_id: 3, to: '3135550001', result: { id: 'AC-1', status: 'queued' } });
    expect(quoCalls).toEqual([{ content: draft.message, from: 'PNx3', to: ['+13135550001'], setInboxStatus: 'done' }]);
    expect(Buffer.from(quoCalls[0].content).equals(Buffer.from(draft.message))).toBe(true);

    const again = await post(request.path, request.body, tok(RENA), { 'Idempotency-Key': draft.draft_id });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, result: { id: 'AC-1' } });
    expect(quoCalls).toHaveLength(1);
    expect(world.db.rows).toEqual([expect.objectContaining({ scope: 'phone_lines.sms_send', idem_key: draft.draft_id, status: 'applied' })]);
    // A replay sent nothing, so only ONE send is audited.
    expect(world.W.T.admin_audit_log.filter((a) => a.tool === 'phone_send' && a.status === 'sent')).toHaveLength(1);
  });

  test('an opt-out landing after the card was prepared: 409 opted_out BEFORE the claim, Quo never called; the key stays free', async () => {
    const world = phoneWorld();
    const draft = await assistant.normalizeActionDraft(proposalDb(world.W),
      { kind: 'sms.send.v1', contact_id: 1309, phone_id: 12, line_id: 3, message: 'Hi', evidence: CITE }, EVID, { currentUserId: RENA });
    world.W.T.contact_phones.push({ id: 12, contact_id: 1309, phone: '3135550001', end_date: null, sms_optout: 1 });
    expect(draft.recipient.opted_out).toBe(false);
    const request = sendActionRequest(draft);
    expect(request.body).not.toHaveProperty('acknowledge_optout');   // the builder never acknowledges
    current = world;
    const r = await post(request.path, request.body, tok(RENA), { 'Idempotency-Key': draft.draft_id });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'opted_out', opted_out: [{ contact_id: 1309 }] });
    expect(r.json.idempotency).toBeUndefined();                     // the card reads it as a refusal, not "outcome unknown"
    expect(quoCalls).toEqual([]);
    expect(world.db.rows).toEqual([]);
  });

  test('ruling 17: an opted-out number is proposed and shown; the confirm → ONE acknowledged resend, same key, one Quo call, audited', async () => {
    const world = phoneWorld();
    const optedRow = { id: 12, contact_id: 1309, phone: '3135550001', label: 'Mobile', is_primary: 1, sms_optout: 1, end_date: null, updated_at: new Date('2026-10-26T10:00:00Z') };
    const draft = await assistant.normalizeActionDraft(proposalDb(world.W, { contact_phones: [optedRow] }),
      { kind: 'sms.send.v1', contact_id: 1309, phone_id: 12, line_id: 3, message: 'Hi', evidence: CITE }, EVID, { currentUserId: RENA });
    expect(draft.recipient.opted_out).toBe(true);
    world.W.T.contact_phones.push({ id: 12, contact_id: 1309, phone: '3135550001', end_date: null, sms_optout: 1 });
    const request = sendActionRequest(draft);
    expect(request.body).not.toHaveProperty('acknowledge_optout');   // never pre-set, even when the card knows
    current = world;
    const seen = [];
    const { ycOptoutAck, asked } = optoutHelper(true);
    const headers = { 'Idempotency-Key': draft.draft_id };
    const out = await makeDispatch(pageApi(tok(RENA), seen), ycOptoutAck)(request, headers);
    expect(out).toMatchObject({ status: 'success', line_id: 3, result: { id: 'AC-1' } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/opted out of texts[\s\S]*\n\nSend anyway\?$/);
    expect(seen.map((c) => [c.body.acknowledge_optout === true, c.headers['Idempotency-Key']])).toEqual([
      [false, draft.draft_id], [true, draft.draft_id]]);
    expect(quoCalls).toHaveLength(1);
    expect(world.db.rows).toEqual([expect.objectContaining({ scope: 'phone_lines.sms_send', idem_key: draft.draft_id, status: 'applied' })]);
    const audit = world.W.T.admin_audit_log.filter((a) => a.tool === 'phone_send');
    expect(audit.map((a) => a.status)).toEqual(['refused_opted_out', 'sent']);
    expect(JSON.stringify(audit[1].details)).toContain('"acknowledged_optout":[1309]');
    expect(audit[1].details.acknowledged_optout_destinations).toEqual([draft.recipient.phone]);   // fix round minor 6
  });

  test('ruling 17: Cancel on the opt-out confirm sends nothing — one refused POST, no Quo call, the key stays free', async () => {
    const world = phoneWorld();
    world.W.T.contact_phones.push({ id: 12, contact_id: 1309, phone: '3135550001', end_date: null, sms_optout: 1 });
    current = world;
    const seen = [];
    const { ycOptoutAck } = optoutHelper(false);
    const err = await makeDispatch(pageApi(tok(RENA), seen), ycOptoutAck)(
      { path: '/api/phone-lines/3/sms', method: 'POST', body: { to: '3135550001', message: 'Hi' } }, { 'Idempotency-Key': 'card-optout-cancel' })
      .then(() => null, (e) => e);
    expect(err).toMatchObject({ optoutDeclined: true });
    expect(seen).toHaveLength(1);
    expect(quoCalls).toEqual([]);
    expect(world.db.rows).toEqual([]);
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
describe('email: card → POST /api/mail/send → SMTP', () => {
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

  test('D18: a (marketing) email opt-out landing after the card was prepared does not stop it — sent once, nothing acknowledged', async () => {
    const world = mailWorld();
    const draft = await assistant.normalizeActionDraft(proposalDb(world.W),
      { kind: 'email.send.v1', contact_id: 1309, email_id: 13, mailbox_id: 1, subject: 'Hi', body: 'Hello', evidence: CITE },
      EVID, { currentUserId: SENDER });
    world.W.T.contact_emails.push({ id: 13, contact_id: 1309, email: 'pat@example.com', end_date: null, email_optout: 1 });
    current = world;
    const request = sendActionRequest(draft);
    const r = await post(request.path, request.body, tok(SENDER), { 'Idempotency-Key': draft.draft_id });
    expect(r.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const audit = world.W.T.admin_audit_log.filter((a) => a.tool === 'mail_send');
    expect(audit.map((a) => a.status)).toEqual(['sent']);
    expect(JSON.stringify(audit[0].details)).not.toContain('acknowledged_optout');
  });

  test('D18: an address with the (marketing) email opt-out is proposed NOT opted out; the page never confirms; one sendMail', async () => {
    const world = mailWorld();
    const optedRow = { id: 13, contact_id: 1309, email: 'pat@example.com', label: 'Personal', is_primary: 1, email_optout: 1, end_date: null, updated_at: new Date('2026-10-26T10:00:00Z') };
    const draft = await assistant.normalizeActionDraft(proposalDb(world.W, { contact_emails: [optedRow] }),
      { kind: 'email.send.v1', contact_id: 1309, email_id: 13, mailbox_id: 1, subject: 'Hi', body: 'Hello', evidence: CITE },
      EVID, { currentUserId: SENDER });
    expect(draft.recipient.opted_out).toBe(false);
    world.W.T.contact_emails.push({ id: 13, contact_id: 1309, email: 'pat@example.com', end_date: null, email_optout: 1 });
    current = world;
    const request = sendActionRequest(draft);
    expect(request.body).not.toHaveProperty('acknowledge_optout');
    const seen = [];
    const { ycOptoutAck, asked } = optoutHelper(true);
    const out = await makeDispatch(pageApi(tok(SENDER), seen), ycOptoutAck)(request, { 'Idempotency-Key': draft.draft_id });
    expect(out).toMatchObject({ status: 'success', mailbox_id: 1 });
    expect(asked).toHaveLength(0);
    expect(seen.map((c) => c.body.acknowledge_optout === true)).toEqual([false]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const audit = world.W.T.admin_audit_log.filter((a) => a.tool === 'mail_send');
    expect(audit.map((a) => a.status)).toEqual(['sent']);
  });

  test('SMTP receives exactly the subject and body the card showed; the key replays, one sendMail', async () => {
    const world = mailWorld();
    const draft = await assistant.normalizeActionDraft(proposalDb(world.W),
      { kind: 'email.send.v1', contact_id: 1309, email_id: 13, mailbox_id: 1,
        subject: 'Hello {{contacts.contact_fname}}', body: 'Dear {{contacts.contact_fname}},\r\n\r\nYour documents arrived.\n', evidence: CITE },
      EVID, { currentUserId: SENDER });
    expect([draft.subject, draft.body]).toEqual(['Hello Pat', 'Dear Pat,\n\nYour documents arrived.']);
    expect(draft.sender).toMatchObject({ mailbox_id: 1, address: 'billing@firm.test' });   // the REAL resolveIdentity, on the world
    const request = sendActionRequest(draft);
    expect(request.body).toEqual({ mailbox_id: 1, to: ['pat@example.com'], subject: 'Hello Pat', body_text: 'Dear Pat,\n\nYour documents arrived.' });

    current = world;
    const first = await post(request.path, request.body, tok(SENDER), { 'Idempotency-Key': draft.draft_id });
    expect(first.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const sent = mockSendMail.mock.calls[0][0];
    expect([sent.to, sent.subject, sent.text]).toEqual(['pat@example.com', draft.subject, draft.body]);
    expect(sent.cc == null && sent.bcc == null && !(sent.attachments && sent.attachments.length)).toBe(true);

    const again = await post(request.path, request.body, tok(SENDER), { 'Idempotency-Key': draft.draft_id });
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
