// tests/mailboxS3.send.test.js
//
/**
 * Mailbox system S3 — send / reply from the comms hub: routes/api.mail.js
 * (identities, reply defaults, send) → services/mailbox/mailboxSendService.js
 * → emailService.sendEmailDirect → the REAL smtp / gmail adapters.
 * Run: npx jest tests/mailboxS3.send.test.js
 *
 * The real routers, lib/auth.jwtOrApiKey, mailboxService grant resolution,
 * the send service, emailService and both adapters run over an express app on
 * an ephemeral port against the stateful fake DB (tests/helpers/mailboxS3World.js,
 * unknown statements throw). Mocked at the edges only: nodemailer's transport
 * (no SMTP server — the adapter still builds its mailOptions and writes its
 * email_log row), the Gmail HTTP API (global fetch, for googleapis URLs only),
 * credentialInjection's token minting, and imapTransport.appendSent (proved
 * on a real Dovecot in tests/mailboxS3.dovecot.test.js). The SQL runs on MySQL
 * in tests/mailboxS3.mysql.test.js (gated).
 *
 * Mutation-checked (break it, watch it fail — worker run 2026-10-11, every
 * one below fails at least one test here):
 *   - the can_send check removed from resolveIdentity               → the grant matrix
 *   - the attorney READ bypass also granting can_send              → "attorney without a grant 403"
 *   - the grant check moved INTO emailService                       → "automation sends stay grant-blind"
 *   - listSendable on can_read instead of can_send                  → identities tests
 *   - checkBudget removed; `used < budget` → `<=`                   → budget tests
 *   - the budget alert's dedup_key dropped; its severity back to warning
 *     (S3 follow-up: a warning never emails, the 429 says IT was told) → "ONE error alert per transport per day"
 *   - the gmail transport not counting its aliases                  → the Gmail budget / send tests
 *   - APPEND attempted for a gmail credential                       → "Gmail: no APPEND, no IMAP connection"
 *   - a send-time email_log INSERT added in the service             → "ONE email_log row (the adapter's)"
 *   - threadingFor: parent first / In-Reply-To first / root dropped → reply header tests (three deep)
 *   - recipient de-dup removed; the cap removed; the cap counted
 *     before de-duplication                                          → cap tests
 *   - the seed for an unpolled APPEND folder                        → "no seed when … not polled"
 *   - seedSentReadState throwing on the final attempt; the executor
 *     never passing final                                           → seed tests
 *   - the seed scoped to / marking for another user                 → seed tests
 *   - the Gmail threadId sent on a changed subject                  → Gmail reply test
 *   - sender name / signature taken from a SHARED credential        → "a box sending through a SHARED credential"
 *   - the SU elevation check removed, or after the dispatch         → elevation test
 *   - the per-user rate limit removed                               → rate test
 *   - a 5xx message shown without `expose` / the 502 hidden         → "the provider refuses: 502 with its words"
 *   - pabbly accepted as a send provider                            → 409 / identities tests
 *   - replying to an unreadable parent; reply-all keeping the
 *     identity's own address                                        → reply tests
 *   - the Sent scope ignored / its REGEXP unanchored / + all_folders
 *     allowed / a Sent view counted                                 → Sent scope test
 *
 * Reviewer additions (2026-10-11, each mutation survived the suite above
 * before its test existed):
 *   - the APPENDed copy built with another subject / bodies / From / To,
 *     or without the threading headers                              → "the APPENDed copy IS the message that was dispatched"
 *   - any non-empty X-SU-Elevation accepted; a token for another user → "SU elevation is a real token for THIS user"
 *   - the send rate keyed globally instead of per user              → rate test (a colleague still sends)
 *   - cleanName / oneLine(subject) removed                          → "names and the subject cannot add a header"
 *   - a Sent copy from an alias not treated as own mail             → "a SENT copy is own mail"
 *   - a Google sender for another address allowed                   → 409 credential_mismatch test
 *   - the rejected-recipients warning dropped                       → "recipients the relay refused"
 *
 * S3 follow-up (executor, 2026-10-12), each mutation fails a test here:
 *   - MID_MAX back to 500                                           → "a 512-character thread id"
 *   - the gmail_server warning back to "the server files its own"   → the APPEND-skipped test
 *   - the rate check back BEFORE the SU elevation check             → "elevation-rejected attempts do not use up the window"
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s3-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s3_internal';
process.env.EMAIL_DOMAINS = 'firm.test';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});
jest.mock('../lib/credentialInjection', () => {
  const actual = jest.requireActual('../lib/credentialInjection');
  return {
    ...actual,
    loadCredential: jest.fn(async (db, id) => ({ id, name: 'Google Workspace', type: 'oauth2' })),
    buildHeadersForCredential: jest.fn(async () => ({ Authorization: 'Bearer test-token' })),
  };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const { makeWorld, SENT_MATRIX } = require('./helpers/mailboxS3World');
const transport = require('../services/mailbox/imapTransport');
const sendSvc = require('../services/mailbox/mailboxSendService');
const emailService = require('../services/emailService');
const { mintElevationToken } = require('../lib/auth.superuser');
const { encrypt } = require('../lib/credentialCrypto');
const mailRouter = require('../routes/api.mail');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(mailRouter);

const realFetch = global.fetch;
let gmailCalls = [];
let gmailSendReply = () => ({ status: 200, body: { id: '1a2b3c4d5e6f7081', threadId: '1a2b3c4d5e6f7000', labelIds: ['SENT'] } });
let gmailGetReply = () => ({ status: 200, body: { id: 'abc123', threadId: '77aa' } });

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user, user_auth = 'authorized') =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);

async function call(method, url, { t, apiKey, body, elevate } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (elevate != null) headers['x-su-elevation'] = mintElevationToken(elevate);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

// Users: 1 = SS (attorney; send on box 2), 5 = reader of box 1, 6 = SU,
// 7 = send-only on box 1, 8 = reader+sender of box 1, 9 = nobody.
const SS = 1; const READER = 5; const SU = 6; const SENDONLY = 7; const SENDER = 8; const NOBODY = 9;
const SENT_ALL_MAIL = { '[Gmail]/All Mail': { emit_to_rules: true, backfill: false } };

function seed() {
  W = makeWorld();
  const cred = W.cred;
  W.cred = (id, over = {}) => cred(id, { smtp_pass: encrypt('smtp-pw'), ...over }); // the adapter decrypts for real
  W.user(SS, { roles: 'staff,attorney' });
  W.user(READER, { roles: 'staff' });
  W.user(SU, { auth: 'authorized - SU', roles: 'it,admin,form_dev' });
  W.user(SENDONLY, { roles: 'staff' });
  W.user(SENDER, { roles: 'staff' });
  W.user(NOBODY, { roles: 'staff' });
  // Credentials: 1 smtp billing (own address + signature); 2/5 gmail aliases of one
  // Google account (credential 11); 3 smtp for the inactive box; 4 pabbly.
  W.cred(1, { email: 'billing@firm.test', from_name: 'Firm Billing', smtp_user: 'billing@firm.test', signature_html: '<b>Billing Dept</b>', signature_text: 'Billing Dept' });
  W.cred(2, { email: 'stuart@firm.test', from_name: 'Stuart S', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '' });
  W.cred(5, { email: 'automations@firm.test', from_name: 'Automations', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '' });
  W.cred(3, { email: 'off@firm.test', smtp_user: 'off@firm.test' });
  W.cred(4, { email: 'pab@firm.test', provider: 'pabbly' });
  W.mailbox(1, { address: 'billing@firm.test', display_name: 'Billing', send_credential_id: 1, imap_host: 'imap.firm.test', imap_port: 993,
    imap_user: 'billing@firm.test', imap_secret: 'ENCv1:secret', ingest_enabled: 1,
    ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: true }, 'INBOX.Sent': { emit_to_rules: false } }) });
  W.mailbox(2, { address: 'stuart@firm.test', display_name: 'Stuart — Workspace (Gmail)', send_credential_id: 2, imap_host: 'imap.gmail.com',
    imap_user: 'stuart@firm.test', imap_secret: 'ENCv1:g', ingest_enabled: 1, ingest_folders: JSON.stringify(SENT_ALL_MAIL) });
  W.mailbox(3, { address: 'nosend@firm.test', send_credential_id: null });
  W.mailbox(4, { address: 'off@firm.test', send_credential_id: 3, active: 0 });
  W.mailbox(5, { address: 'pab@firm.test', send_credential_id: 4 });
  W.grant(READER, 1, { read: 1 });
  W.grant(SENDONLY, 1, { read: 0, send: 1 });
  W.grant(SENDER, 1, { read: 1, send: 1 });
  W.grant(SS, 2, { read: 1, send: 1, manage: 1 });
  W.message(101, { mailbox_id: 1, message_id: 'root@x.test', thread_key: 'root@x.test', subject: 'Plan objection',
    from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test' });
  W.message(102, { mailbox_id: 1, message_id: 'r2@x.test', in_reply_to: 'root@x.test', thread_key: 'root@x.test', subject: 'Re: Plan objection',
    from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test', cc_addrs: '"Doe, Jane" <jane@outside.test>, stuart@firm.test',
    body_text: 'Line one\nLine two', date: new Date('2026-10-08T14:05:00Z') });
  W.message(103, { mailbox_id: 1, folder: 'INBOX.Sent', message_id: 'own@firm.test', thread_key: 'own@firm.test', subject: 'Your documents',
    from_addr: 'Firm Billing <billing@firm.test>', to_addrs: 'Client <client@outside.test>, second@outside.test', cc_addrs: 'billing@firm.test' });
  W.message(201, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', provider_id: 'abc123', message_id: 'g1@mail.gmail.com',
    thread_key: 'g1@mail.gmail.com', subject: 'Plan', from_addr: 'Client <client@outside.test>', to_addrs: 'stuart@firm.test' });
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed();
  mailRouter._resetSendRateLimit();
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async (opts) => ({
    messageId: opts.messageId || '<auto@relay>', response: '250 2.0.0 OK queued as ABC', accepted: [opts.to], rejected: [], envelope: {},
  }));
  gmailCalls = [];
  gmailSendReply = () => ({ status: 200, body: { id: '1a2b3c4d5e6f7081', threadId: '1a2b3c4d5e6f7000', labelIds: ['SENT'] } });
  gmailGetReply = () => ({ status: 200, body: { id: 'abc123', threadId: '77aa' } });
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://gmail.googleapis.com/')) return realFetch(url, init);
    gmailCalls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const r = /\/messages\/send$/.test(u) ? gmailSendReply() : gmailGetReply();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  jest.spyOn(transport, 'appendSent').mockResolvedValue({ appended: true, folder: 'INBOX.Sent', uid: 9, reason: null });
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

const NEW_MSG = (over = {}) => ({ mailbox_id: 1, to: ['client@outside.test'], subject: 'Hello', body_text: 'Hi there', ...over });
const statementsLike = (re) => W.statements.filter((s) => re.test(s.sql));
const gmailRaw = () => {
  const send = gmailCalls.find((c) => /\/messages\/send$/.test(c.url));
  return send ? Buffer.from(send.body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : null;
};

// ─────────────────────────────────────────────────────────────────────────────
describe('humans only', () => {
  test('S3 routes: no auth → 401; the internal x-api-key → 403', async () => {
    for (const [method, url] of [['GET', '/api/mail/identities'], ['GET', '/api/mail/messages/101/reply'], ['POST', '/api/mail/send']]) {
      expect((await call(method, url, { body: method === 'POST' ? NEW_MSG() : undefined })).status).toBe(401);
      expect((await call(method, url, { apiKey: process.env.INTERNAL_API_KEY, body: method === 'POST' ? NEW_MSG() : undefined })).status).toBe(403);
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('identities (the From picker)', () => {
  test('SU: every mailbox, each sendable or not with its reason; signature only for a box with its OWN credential signature', async () => {
    const r = await call('GET', '/api/mail/identities', { t: tok(SU) });
    expect(r.status).toBe(200);
    expect(r.json.max_recipients).toBe(10);
    const by = Object.fromEntries(r.json.identities.map((i) => [i.address, i]));
    expect(Object.keys(by).sort()).toEqual(['billing@firm.test', 'nosend@firm.test', 'off@firm.test', 'pab@firm.test', 'stuart@firm.test']);
    expect(by['billing@firm.test']).toMatchObject({ sendable: true, reason: null, signature: true });
    expect(by['stuart@firm.test']).toMatchObject({ sendable: true, signature: false });
    expect(by['nosend@firm.test']).toMatchObject({ sendable: false, reason: 'no_send_credential' });
    expect(by['off@firm.test']).toMatchObject({ sendable: false, reason: 'inactive' });
    expect(by['pab@firm.test']).toMatchObject({ sendable: false, reason: 'unsupported_provider' });
    expect(JSON.stringify(r.json)).not.toMatch(/send_credential_id|smtp_|credential_id/);
  });

  test('attorney: only the box they hold can_send on — the READ bypass is not a send right', async () => {
    const r = await call('GET', '/api/mail/identities', { t: tok(SS) });
    expect(r.json.identities.map((i) => i.address)).toEqual(['stuart@firm.test']);
  });

  test('a reader gets nothing; a send-only grant counts', async () => {
    expect((await call('GET', '/api/mail/identities', { t: tok(READER) })).json.identities).toEqual([]);
    expect((await call('GET', '/api/mail/identities', { t: tok(SENDONLY) })).json.identities.map((i) => i.id)).toEqual([1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the grant check sits on the interactive seat', () => {
  test('matrix: sender + send-only send; reader 403; attorney without a grant 403; nobody 404', async () => {
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() })).status).toBe(200);
    expect((await call('POST', '/api/mail/send', { t: tok(SENDONLY), body: NEW_MSG() })).status).toBe(200);
    const reader = await call('POST', '/api/mail/send', { t: tok(READER), body: NEW_MSG() });
    expect([reader.status, reader.json.message]).toEqual([403, expect.stringMatching(/not send/)]);
    const attorney = await call('POST', '/api/mail/send', { t: tok(SS), body: NEW_MSG() }); // reads box 1 by role, no send grant
    expect(attorney.status).toBe(403);
    expect((await call('POST', '/api/mail/send', { t: tok(NOBODY), body: NEW_MSG() })).status).toBe(404);
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG({ mailbox_id: 999 }) })).status).toBe(404);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  test('attorney WITH a grant sends (box 2)', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SS), body: NEW_MSG({ mailbox_id: 2 }) });
    expect(r.status).toBe(200);
  });

  test('SU: the bypass sends — but only elevated (S0 rule), refused BEFORE anything is dispatched', async () => {
    const no = await call('POST', '/api/mail/send', { t: tok(SU, 'authorized - SU'), body: NEW_MSG() });
    expect([no.status, no.json.code]).toEqual([401, 'elevation_required']);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(W.T.admin_audit_log.map((a) => [a.tool, a.status])).toEqual([['mail_send', 'rejected_no_elevation']]);
    const yes = await call('POST', '/api/mail/send', { t: tok(SU, 'authorized - SU'), elevate: SU, body: NEW_MSG() });
    expect(yes.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('SU elevation is a real token for THIS user: a junk header or another user\'s token is a 401, nothing dispatched', async () => {
    const withHeader = async (h) => (await realFetch(base + '/api/mail/send', {
      method: 'POST', headers: { Authorization: `Bearer ${tok(SU, 'authorized - SU')}`, 'Content-Type': 'application/json', 'x-su-elevation': h }, body: JSON.stringify(NEW_MSG()),
    })).status;
    expect(await withHeader('not-a-token')).toBe(401);
    expect(await withHeader(mintElevationToken(SENDER))).toBe(401);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(await withHeader(mintElevationToken(SU))).toBe(200);
  });

  test('a Google sender for a DIFFERENT address is refused (Gmail would send under its own address): 409, greyed in the picker', async () => {
    W.mailbox(6, { address: 'pilot@other.test', display_name: 'Pilot', send_credential_id: 2 }); // stuart@'s gmail sender
    const r = await call('POST', '/api/mail/send', { t: tok(SU, 'authorized - SU'), elevate: SU, body: NEW_MSG({ mailbox_id: 6 }) });
    expect([r.status, r.json.message]).toEqual([409, expect.stringMatching(/different address/)]);
    expect(gmailCalls).toEqual([]);
    const ids = (await call('GET', '/api/mail/identities', { t: tok(SU, 'authorized - SU') })).json.identities;
    expect(ids.find((i) => i.id === 6)).toMatchObject({ sendable: false, reason: 'credential_mismatch' });
    expect(ids.find((i) => i.id === 2)).toMatchObject({ sendable: true }); // the box whose address IS the sender's
  });

  test('a box that cannot send: 409 with the reason (read-only, inactive, Pabbly)', async () => {
    for (const [id, re] of [[3, /Read-only/], [4, /switched off/], [5, /Pabbly/]]) {
      const r = await call('POST', '/api/mail/send', { t: tok(SU, 'authorized - SU'), elevate: SU, body: NEW_MSG({ mailbox_id: id }) });
      expect([r.status, r.json.message]).toEqual([409, expect.stringMatching(re)]);
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('automation sends stay grant-blind: emailService.sendEmail never consults grants or mailboxes', async () => {
    const queries = [];
    const db = {
      query: async (sql, p) => {
        queries.push(String(sql).replace(/\s+/g, ' '));
        if (/FROM email_credentials WHERE email = \?/.test(sql)) return [[{ id: 1, email: 'billing@firm.test', from_name: 'B', provider: 'smtp', credential_id: null, smtp_host: 'h', smtp_port: 587, smtp_user: 'u', smtp_pass: encrypt('pw'), smtp_secure: 0 }]];
        return [{ affectedRows: 1 }];
      },
    };
    await emailService.sendEmail(db, { from: 'billing@firm.test', to: 'x@y.test', subject: 's', text: 't' });
    expect(queries.some((q) => /channel_grants|mailboxes|users/.test(q))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('validation + recipient cap', () => {
  const bad = async (body) => (await call('POST', '/api/mail/send', { t: tok(SENDER), body })).json.message;
  test('400s', async () => {
    expect(await bad(NEW_MSG({ to: [] }))).toMatch(/to needs/);
    expect(await bad(NEW_MSG({ to: 'client@outside.test' }))).toMatch(/array/);
    expect(await bad(NEW_MSG({ to: ['not-an-address'] }))).toMatch(/not an email address/);
    expect(await bad(NEW_MSG({ to: ['a@b.test\r\nBcc: evil@x.test'] }))).toMatch(/not an email address/);
    expect(await bad(NEW_MSG({ subject: '' }))).toMatch(/subject is required/);
    expect(await bad(NEW_MSG({ body_text: '   ' }))).toMatch(/write a message/);
    expect(await bad(NEW_MSG({ from: 'x@y.test' }))).toMatch(/unknown field "from"/);
    expect(await bad(NEW_MSG({ in_reply_to_message_fk: 'x' }))).toMatch(/positive integer/);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('names and the subject cannot add a header or a recipient (quotes, angle brackets, CR/LF)', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG({
      to: [{ email: 'client@outside.test', name: 'Evil" <victim@x.test>, "X' }],
      cc: [{ email: 'c@outside.test', name: 'Line\r\nBcc: sneak@x.test' }],
      subject: 'Hi\r\nBcc: sneak2@x.test',
    }) });
    expect([r.status, r.json.recipients]).toEqual([200, 2]);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.to).toBe('"Evil victim@x.test, X" <client@outside.test>');   // one mailbox: the name is inert text
    expect(opts.cc).toBe('"Line Bcc: sneak@x.test" <c@outside.test>');
    expect(opts.subject).toBe('Hi Bcc: sneak2@x.test');
    expect(opts.bcc).toBeUndefined();
    expect([opts.to, opts.cc, opts.subject].join('')).not.toMatch(/[\r\n]/);
  });

  test('at most 10 recipients across To + Cc + Bcc, counted after de-duplication', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@outside.test`);
    expect(await bad(NEW_MSG({ to: eleven.slice(0, 6), cc: eleven.slice(6, 9), bcc: eleven.slice(9) }))).toMatch(/at most 10 recipients/);
    // the same address in To, Cc and Bcc is one recipient
    const dup = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG({ to: eleven.slice(0, 10), cc: [eleven[0].toUpperCase()], bcc: [eleven[1]] }) });
    expect(dup.status).toBe(200);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.cc).toBeUndefined();
    expect(opts.bcc).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SMTP send (an APPEND host)', () => {
  test('dispatch through the adapter, ONE email_log row (the adapter\'s), no log write, APPEND of the same message, seed scheduled', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG({
      to: ['"Client Name" <client@outside.test>'], cc: [{ email: 'cc@outside.test', name: 'Cee' }], bcc: ['hidden@outside.test'], signature: true,
    }) });
    expect(r.status).toBe(200);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.from).toBe('"Firm Billing" <billing@firm.test>');
    expect(opts.to).toBe('"Client Name" <client@outside.test>');
    expect(opts.cc).toBe('"Cee" <cc@outside.test>');
    expect(opts.bcc).toBe('hidden@outside.test');
    expect(opts.messageId).toMatch(/^<[0-9a-f-]{36}@firm\.test>$/);
    expect(opts.inReplyTo).toBeUndefined();
    expect(opts.text).toBe('Hi there\n\nBilling Dept');               // signature appended
    expect(opts.html).toBe('<div><p>Hi there</p></div><br><div><b>Billing Dept</b></div>');
    // the response carries the adapter's own email_log row
    const logs = W.T.email_log.filter((l) => l.source === 'outbound-smtp');
    expect(logs).toHaveLength(1);
    expect(r.json.email_log_id).toBe(logs[0].id);
    expect(r.json.rfc_message_id).toBe(opts.messageId.slice(1, -1));
    expect(r.json.thread_key).toBe(r.json.rfc_message_id);
    // carry #1: nothing else logged — no timeline row, no second email_log row
    expect(statementsLike(/^INSERT INTO log\b/)).toHaveLength(0);
    expect(statementsLike(/^INSERT INTO email_log/)).toHaveLength(1);
    // carry #2: APPEND the same message (same Message-ID, Bcc kept) to the box's IMAP
    expect(transport.appendSent).toHaveBeenCalledTimes(1);
    const [row, raw] = transport.appendSent.mock.calls[0];
    expect(row).toMatchObject({ id: 1, imap_host: 'imap.firm.test', imap_secret: 'ENCv1:secret' });
    const mime = raw.toString('utf8');
    expect(mime).toContain(`Message-ID: ${opts.messageId}`);
    expect(mime).toMatch(/^Bcc: hidden@outside\.test/m);
    expect(mime).toMatch(/^Cc: Cee <cc@outside\.test>/m);
    expect(r.json.append).toEqual({ attempted: true, appended: true, folder: 'INBOX.Sent', reason: null });
    // carry #3: INBOX.Sent is polled → the seed job by Message-ID
    expect(r.json.read_seed.scheduled).toBe(true);
    const job = W.T.scheduled_jobs[0];
    expect(JSON.parse(job.data)).toEqual({ type: 'mail_sent_read_seed', user: SENDER, mailbox_id: 1, sent_at: expect.any(String), provider_id: null, message_id: r.json.rfc_message_id });
    expect([job.max_attempts, job.backoff_seconds]).toEqual([4, 300]);
    expect(new Date(job.scheduled_time).getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    // audit: who sent as which box — never addresses or bodies
    const audit = W.T.admin_audit_log.find((a) => a.status === 'sent');
    expect(audit).toMatchObject({ tool: 'mail_send', user_id: String(SENDER) });
    expect(audit.details).toMatchObject({ mailbox_id: 1, email_log_id: logs[0].id, recipients: 3, append: 'appended:INBOX.Sent' });
    expect(JSON.stringify(audit.details)).not.toMatch(/outside\.test|Hi there/);
  });

  test('the APPENDed copy IS the message that was dispatched: From, To, Cc, Subject, both bodies, threading — field by field', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: {
      mailbox_id: 1, to: ['"Client Name" <client@outside.test>'], cc: ['cc@outside.test'], body_text: 'Thanks', in_reply_to_message_fk: 102, signature: true,
    } });
    expect(r.status).toBe(200);
    const opts = mockSendMail.mock.calls[0][0];                       // what the relay was handed
    const raw = transport.appendSent.mock.calls[0][1].toString('utf8'); // what went to Sent
    const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
    const header = (name) => (new RegExp(`^${name}: (.*)$`, 'mi').exec(unfolded) || [])[1];
    /** One body part of the copy, transfer-decoded. */
    const part = (type) => {
      const boundary = /boundary="([^"]+)"/.exec(raw)[1];
      for (const seg of raw.split(`--${boundary}`)) {
        const cut = seg.indexOf('\r\n\r\n');
        if (cut < 0 || !new RegExp(`Content-Type: ${type}`, 'i').test(seg.slice(0, cut))) continue;
        const head = seg.slice(0, cut);
        let body = seg.slice(cut + 4).replace(/\r\n$/, '');
        if (/quoted-printable/i.test(head)) body = Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
        else if (/base64/i.test(head)) body = Buffer.from(body, 'base64').toString('utf8');
        return body.replace(/\r\n/g, '\n');
      }
      return null;
    };
    expect(opts.from).toBe('"Firm Billing" <billing@firm.test>');
    expect(header('From')).toBe('Firm Billing <billing@firm.test>');
    expect(opts.to).toBe('"Client Name" <client@outside.test>');
    expect(header('To')).toBe('Client Name <client@outside.test>');
    expect(header('Cc')).toBe(opts.cc);
    expect(header('Subject')).toBe(opts.subject);
    expect(header('Message-ID')).toBe(opts.messageId);
    expect(header('In-Reply-To')).toBe(opts.inReplyTo);
    expect(header('References')).toBe(opts.references);
    expect(opts.text).toMatch(/^Thanks\n\nBilling Dept\n\nOn /);        // new text, the signature, then the quote
    expect(part('text/plain')).toBe(opts.text);
    expect(part('text/html')).toBe(opts.html);
  });

  test('recipients the relay refused while taking the others: sent, with a warning naming them', async () => {
    mockSendMail.mockImplementationOnce(async (opts) => ({ messageId: opts.messageId, response: '250 OK', accepted: ['client@outside.test'], rejected: ['bad@outside.test'], envelope: {} }));
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG({ to: ['client@outside.test', 'bad@outside.test'] }) });
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([{ code: 'recipients_rejected', message: expect.stringMatching(/refused one recipient: bad@outside\.test/) }]);
  });

  test('no seed when the APPEND folder is not polled; APPEND skipped / failed are warnings, never a failed send', async () => {
    transport.appendSent.mockResolvedValueOnce({ appended: true, folder: 'Sent Items', uid: 1, reason: null });
    let r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect([r.status, r.json.read_seed.scheduled]).toEqual([200, false]);

    transport.appendSent.mockResolvedValueOnce({ appended: false, folder: null, uid: null, reason: 'no_sent_folder' });
    r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([{ code: 'append_skipped', message: expect.stringMatching(/has no Sent folder/) }]);

    // a Google mailbox sending through a non-Google relay: nothing files the copy — say what fixes it
    transport.appendSent.mockResolvedValueOnce({ appended: false, folder: null, uid: null, reason: 'gmail_server' });
    r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect(r.json.warnings).toEqual([{ code: 'append_skipped', message: expect.stringMatching(/never writes into a Google mailbox\. Give this box its Google sender/) }]);

    transport.appendSent.mockRejectedValueOnce(Object.assign(new Error('IMAP ETIMEDOUT: timed out'), { code: 'ETIMEDOUT' }));
    r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect([r.status, r.json.append.reason]).toEqual([200, 'error']);
    expect(r.json.warnings.map((w) => w.code)).toEqual(['append_failed']);
    await new Promise((res) => setTimeout(res, 20));
    expect(W.T.system_alerts.map((a) => [a.kind, a.severity])).toEqual([['mailbox_send_append_failed', 'warning']]);
    expect(mockSendMail).toHaveBeenCalledTimes(4);
  });

  test('a box with no IMAP login: sent, APPEND skipped (no_imap)', async () => {
    W.T.mailboxes.find((b) => b.id === 1).imap_secret = null;
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect([r.status, r.json.append.reason]).toEqual([200, 'no_imap']);
    expect(transport.appendSent).not.toHaveBeenCalled();
  });

  test('the provider refuses: 502 with its words, its FAILED row, nothing appended or seeded', async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('Invalid login: 535 Authentication failed'), { responseCode: 535 }));
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect([r.status, r.json.message]).toEqual([502, expect.stringMatching(/not sent: Invalid login: 535/)]);
    expect(W.T.email_log.map((l) => l.message_id)).toEqual([expect.stringMatching(/^FAILED-/)]);
    expect(transport.appendSent).not.toHaveBeenCalled();
    expect(W.T.scheduled_jobs).toEqual([]);
    expect(W.T.admin_audit_log.map((a) => a.status)).toEqual(['send_failed']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Gmail send (Gmail files its own Sent)', () => {
  test('no APPEND, no IMAP connection row read; the Gmail id seeds read state; the outbound-gmail row is the only one', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SS), body: NEW_MSG({ mailbox_id: 2, bcc: ['b@outside.test'] }) });
    expect(r.status).toBe(200);
    expect(transport.appendSent).not.toHaveBeenCalled();
    expect(statementsLike(/imap_secret/)).toHaveLength(0);
    expect(r.json.append).toEqual({ attempted: false, appended: false, folder: null, reason: 'gmail_files_sent' });
    expect(r.json.provider_message_id).toBe('1a2b3c4d5e6f7081');
    expect(r.json.rfc_message_id).toBeNull();                 // Gmail mints its own Message-ID
    const logs = W.T.email_log;
    expect(logs.map((l) => [l.source, l.message_id])).toEqual([['outbound-gmail', '1a2b3c4d5e6f7081']]);
    expect(r.json.email_log_id).toBe(logs[0].id);
    expect(JSON.parse(W.T.scheduled_jobs[0].data)).toMatchObject({ provider_id: '1a2b3c4d5e6f7081', message_id: null, user: SS });
    // the Gmail API reads recipients from the raw headers: the Bcc must be in it
    expect(gmailRaw()).toMatch(/^Bcc: b@outside\.test/m);
    expect(gmailRaw()).toMatch(/^From: Stuart S <stuart@firm\.test>/m);
    expect(Object.keys(gmailCalls[0].body)).toEqual(['raw']);  // no threadId on a new message
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reply correctness', () => {
  test('SMTP reply: In-Reply-To = the parent, References = root … parent, Re: subject, the original quoted, thread_key = the parent\'s', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: { mailbox_id: 1, to: ['client@outside.test'], body_text: 'Thanks', in_reply_to_message_fk: 102 } });
    expect(r.status).toBe(200);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.inReplyTo).toBe('<r2@x.test>');
    expect(opts.references).toBe('<root@x.test> <r2@x.test>');
    expect(opts.subject).toBe('Re: Plan objection');           // already a Re: — not doubled
    expect(opts.text).toMatch(/^Thanks\n\nOn Thu, Oct 8, 2026 at 10:05 AM, Client <client@outside\.test> wrote:\n> Line one\n> Line two$/);
    expect(opts.html).toContain('<blockquote');
    expect(r.json.thread_key).toBe('root@x.test');            // = message 102's stored thread_key
    expect(r.json.in_reply_to_message_fk).toBe(102);
  });

  test('quote_original:false leaves the original out; a root parent threads on itself', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: { mailbox_id: 1, to: ['client@outside.test'], body_text: 'Ok', in_reply_to_message_fk: 101, quote_original: false } });
    const opts = mockSendMail.mock.calls[0][0];
    expect([opts.inReplyTo, opts.references, opts.text]).toEqual(['<root@x.test>', '<root@x.test>', 'Ok']);
    expect(r.json.thread_key).toBe('root@x.test');
  });

  test('three deep (root ≠ the parent\'s parent): References = root, parent\'s parent, parent — thread_key the root, never the middle', async () => {
    W.message(105, { mailbox_id: 1, message_id: 'r3@x.test', in_reply_to: 'r2@x.test', thread_key: 'root@x.test', subject: 'Re: Plan objection',
      from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test' });
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: { mailbox_id: 1, to: ['client@outside.test'], body_text: 'Ok', in_reply_to_message_fk: 105 } });
    const opts = mockSendMail.mock.calls[0][0];
    expect([opts.inReplyTo, opts.references]).toEqual(['<r3@x.test>', '<root@x.test> <r2@x.test> <r3@x.test>']);
    expect(r.json.thread_key).toBe('root@x.test');
  });

  test('a 512-character thread id (the column\'s width) still threads; a longer one is dropped, never sent half', async () => {
    const long = `${'k'.repeat(512 - '@x.test'.length)}@x.test`;
    W.message(106, { mailbox_id: 1, message_id: 'p6@x.test', in_reply_to: null, thread_key: long, subject: 'Long', from_addr: 'client@outside.test', to_addrs: 'billing@firm.test' });
    let r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: { mailbox_id: 1, to: ['client@outside.test'], body_text: 'Ok', in_reply_to_message_fk: 106 } });
    expect(mockSendMail.mock.calls[0][0].references).toBe(`<${long}> <p6@x.test>`);
    expect(r.json.thread_key).toBe(long);
    W.message(107, { mailbox_id: 1, message_id: 'p7@x.test', in_reply_to: null, thread_key: `k${long}`, subject: 'Long', from_addr: 'client@outside.test', to_addrs: 'billing@firm.test' });
    r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: { mailbox_id: 1, to: ['client@outside.test'], body_text: 'Ok', in_reply_to_message_fk: 107 } });
    expect(mockSendMail.mock.calls[1][0].references).toBe('<p7@x.test>');
  });

  test('a box sending through a SHARED credential (another address): its bare address, no sender name, no signature — and the budget counts it', async () => {
    W.mailbox(6, { address: 'intake@firm.test', display_name: 'Intake', send_credential_id: 1 }); // billing@'s credential
    W.grant(SENDER, 6, { read: 1, send: 1 });
    const ids = (await call('GET', '/api/mail/identities', { t: tok(SENDER) })).json.identities;
    expect(ids.find((i) => i.id === 6)).toMatchObject({ sendable: true, signature: false });
    expect(ids.find((i) => i.id === 1)).toMatchObject({ sendable: true, signature: true });
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG({ mailbox_id: 6, signature: true }) });
    expect(r.status).toBe(200);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.from).toBe('intake@firm.test');
    expect(opts.text).not.toMatch(/Billing Dept/);
    expect(opts.html).not.toMatch(/Billing Dept/);
    expect(r.json.warnings.map((w) => w.code)).toContain('no_signature');
    const [budget] = statementsLike(/FROM email_log WHERE source = \? AND from_email IN/).slice(-1);
    expect(budget.params[1]).toEqual(expect.arrayContaining(['billing@firm.test', 'intake@firm.test']));
  });

  test('replying to a message you cannot read is a 404 (send-only grant)', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDONLY), body: { mailbox_id: 1, to: ['client@outside.test'], body_text: 'x', in_reply_to_message_fk: 102 } });
    expect(r.status).toBe(404);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('Gmail reply: the parent\'s Gmail threadId files it in the sender\'s own conversation; a changed subject does not', async () => {
    let r = await call('POST', '/api/mail/send', { t: tok(SS), body: { mailbox_id: 2, to: ['client@outside.test'], body_text: 'Yes', in_reply_to_message_fk: 201 } });
    expect(r.status).toBe(200);
    expect(gmailCalls.map((c) => c.url)).toEqual([
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=minimal',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    ]);
    expect(gmailCalls[1].body.threadId).toBe('77aa');
    expect(r.json.gmail_thread_id).toBe('77aa');
    expect(gmailRaw()).toMatch(/^In-Reply-To: <g1@mail\.gmail\.com>/m);
    expect(gmailRaw()).toMatch(/^References: <g1@mail\.gmail\.com>/m);
    expect(gmailRaw()).toMatch(/^Subject: Re: Plan/m);

    gmailCalls = [];
    r = await call('POST', '/api/mail/send', { t: tok(SS), body: { mailbox_id: 2, to: ['client@outside.test'], subject: 'Something else', body_text: 'Yes', in_reply_to_message_fk: 201 } });
    expect(gmailCalls.map((c) => c.url)).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
    expect(Object.keys(gmailCalls[0].body)).toEqual(['raw']);

    gmailCalls = [];
    gmailGetReply = () => ({ status: 404, body: { error: { message: 'Not found' } } }); // another account's id: no threadId, still sent
    r = await call('POST', '/api/mail/send', { t: tok(SS), body: { mailbox_id: 2, to: ['client@outside.test'], body_text: 'Yes', in_reply_to_message_fk: 201 } });
    expect([r.status, r.json.gmail_thread_id, Object.keys(gmailCalls[1].body)]).toEqual([200, null, ['raw']]);
  });

  test('reply defaults: a SENT copy is own mail whatever its From (an alias, automations@) — the reply goes to its recipients', async () => {
    W.message(301, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Sent"]', provider_id: 'ddd1', message_id: 'al@mail.gmail.com', thread_key: 'al@mail.gmail.com',
      subject: 'Reminder', from_addr: 'Automations <automations@firm.test>', to_addrs: 'Client <client@outside.test>', cc_addrs: 'second@outside.test' });
    let r = await call('GET', '/api/mail/messages/301/reply', { t: tok(SS) });
    expect(r.json).toMatchObject({ mailbox_id: 2, to: [{ email: 'client@outside.test', name: 'Client' }], cc: [] });
    r = await call('GET', '/api/mail/messages/301/reply?all=1', { t: tok(SS) });
    expect(r.json.cc).toEqual([{ email: 'second@outside.test', name: null }]);
    // an inbound message from the same alias address is NOT own mail (no \Sent, not a Sent folder)
    W.message(302, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', provider_id: 'ddd2', message_id: 'in@mail.gmail.com', thread_key: 'in@mail.gmail.com',
      subject: 'Bounce', from_addr: 'Automations <automations@firm.test>', to_addrs: 'stuart@firm.test' });
    r = await call('GET', '/api/mail/messages/302/reply', { t: tok(SS) });
    expect(r.json.to).toEqual([{ email: 'automations@firm.test', name: 'Automations' }]);
  });

  test('reply defaults: reply → the sender; reply-all → + the other To/Cc minus the identity; own mail → its recipients', async () => {
    let r = await call('GET', '/api/mail/messages/102/reply', { t: tok(SENDER) });
    expect(r.json).toMatchObject({ in_reply_to_message_fk: 102, mailbox_id: 1, all: false, subject: 'Re: Plan objection', over_cap: false,
      to: [{ email: 'client@outside.test', name: 'Client' }], cc: [] });
    expect(r.json.quote.header).toBe('On Thu, Oct 8, 2026 at 10:05 AM, Client <client@outside.test> wrote:');
    expect(r.json.quote.text).toBe('Line one\nLine two');
    r = await call('GET', '/api/mail/messages/102/reply?all=1', { t: tok(SENDER) });
    expect(r.json.cc).toEqual([{ email: 'jane@outside.test', name: 'Doe, Jane' }, { email: 'stuart@firm.test', name: null }]);
    r = await call('GET', '/api/mail/messages/103/reply?all=1', { t: tok(SENDER) });   // the box's own sent mail
    expect(r.json.to).toEqual([{ email: 'client@outside.test', name: 'Client' }, { email: 'second@outside.test', name: null }]);
    expect(r.json.cc).toEqual([]);                                                       // billing@ is the identity
    r = await call('GET', '/api/mail/messages/102/reply', { t: tok(READER) });
    expect(r.json.mailbox_id).toBeNull();                                                // can read, cannot reply
    expect((await call('GET', '/api/mail/messages/102/reply', { t: tok(NOBODY) })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Sent scope (list) — the engine twin is tests/mailboxS3.mysql.test.js', () => {
  test('sent_only: the \\Sent label or a Sent folder leaf (the shared edge matrix), grant-scoped; + all_folders is a 400', async () => {
    for (const [id, mb, folder, labels] of SENT_MATRIX) {
      W.message(id, { mailbox_id: mb, folder, gmail_labels: labels, message_id: `m${id}@x.test`, thread_key: `m${id}@x.test`, subject: `s${id}`, from_addr: 'a@x.test' });
    }
    const want = SENT_MATRIX.filter((r) => r[4]).map((r) => r[0]);
    const su = await call('GET', '/api/mail/messages?sent_only=1&limit=100', { t: tok(SU, 'authorized - SU') });
    expect(su.status).toBe(200);
    expect(su.json.messages.map((m) => m.id).sort((a, b) => a - b)).toEqual([103, ...want].sort((a, b) => a - b));
    const sender = await call('GET', '/api/mail/messages?sent_only=1&limit=100', { t: tok(SENDER) }); // box 1 only
    expect(sender.json.messages.map((m) => m.id).sort((a, b) => a - b)).toEqual([103, ...want.filter((id) => SENT_MATRIX.find((r) => r[0] === id)[1] === 1)].sort((a, b) => a - b));
    expect((await call('GET', '/api/mail/messages?sent_only=1&all_folders=1', { t: tok(SENDER) })).status).toBe(400);
    // a saved Sent view gets no unread count (sent mail is nobody's unread); an Inbox view still does
    const sentView = (await call('POST', '/api/mail/views', { t: tok(SENDER), body: { name: 'Sent', filters: { sent_only: true } } })).json.view.id;
    const inboxView = (await call('POST', '/api/mail/views', { t: tok(SENDER), body: { name: 'Inbox' } })).json.view.id;
    const counts = (await call('GET', '/api/mail/views/counts', { t: tok(SENDER) })).json.counts;
    expect(counts[sentView]).toBeUndefined();
    expect(counts[inboxView]).toEqual(expect.any(Number));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('daily budget (design §4.2)', () => {
  const fill = (n, from, source = 'outbound-smtp', hoursAgo = 1) => {
    for (let i = 0; i < n; i++) W.sent({ source, from_email: from, processed_at: Date.now() - hoursAgo * 3600_000 });
  };

  test('at the budget: 429, nothing dispatched, ONE error alert per transport per day', async () => {
    fill(300, 'BILLING@firm.test');
    let r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect([r.status, r.json.message]).toEqual([429, expect.stringMatching(/daily limit \(300 of 300/)]);
    r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect(r.status).toBe(429);
    expect(mockSendMail).not.toHaveBeenCalled();
    await new Promise((res) => setTimeout(res, 20));
    expect(W.T.system_alerts).toHaveLength(1);
    expect(W.T.system_alerts[0]).toMatchObject({ kind: 'mailbox_send_budget', severity: 'error', group_key: 'app:mailbox_send_budget:smtp:mail.firm.test:billing@firm.test' });
    expect(W.T.admin_audit_log.map((a) => a.status)).toEqual(['refused_budget', 'refused_budget']);
  });

  test('one under, and rows older than 24 hours, still send', async () => {
    fill(299, 'billing@firm.test');
    fill(50, 'billing@firm.test', 'outbound-smtp', 25);
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() })).status).toBe(200);
  });

  test('the app_settings override; Gmail counts every alias of the Google account (automation sends too)', async () => {
    W.setting('mail_send_daily_budget', JSON.stringify({ smtp: 5, gmail: 3 }));
    fill(5, 'billing@firm.test');
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() })).status).toBe(429);
    fill(3, 'automations@firm.test', 'outbound-gmail');
    expect((await call('POST', '/api/mail/send', { t: tok(SS), body: NEW_MSG({ mailbox_id: 2 }) })).status).toBe(429);
    expect(gmailCalls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('per-user send rate (route)', () => {
  test(`send number ${mailRouter.SEND_RATE_MAX + 1} in the window is a 429, before any work`, async () => {
    W.setting('mail_send_daily_budget', JSON.stringify({ smtp: 1000 }));
    for (let i = 0; i < mailRouter.SEND_RATE_MAX; i++) {
      expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() })).status).toBe(200);
    }
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: NEW_MSG() });
    expect([r.status, r.json.message]).toEqual([429, expect.stringMatching(/Too many sends/)]);
    expect(mockSendMail).toHaveBeenCalledTimes(mailRouter.SEND_RATE_MAX);
    // …and it is THAT user's window: a colleague still sends
    expect((await call('POST', '/api/mail/send', { t: tok(SENDONLY), body: NEW_MSG() })).status).toBe(200);
  });

  test('an SU\'s elevation-rejected attempts do not use up the window (a prompt-and-retry is ONE send)', async () => {
    W.setting('mail_send_daily_budget', JSON.stringify({ smtp: 1000 }));
    for (let i = 0; i < mailRouter.SEND_RATE_MAX + 1; i++) {
      expect((await call('POST', '/api/mail/send', { t: tok(SU, 'authorized - SU'), body: NEW_MSG() })).status).toBe(401);
    }
    expect((await call('POST', '/api/mail/send', { t: tok(SU, 'authorized - SU'), elevate: SU, body: NEW_MSG() })).status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the read-state seed (carry #3)', () => {
  const job = (over = {}) => ({ user: SS, mailbox_id: 2, sent_at: '2026-10-11T14:00:00.000Z', provider_id: '1a2b3c4d5e6f7081', message_id: null, ...over });

  test('the copy not stored yet: throws (the job retries); on the LAST attempt it completes quietly', async () => {
    await expect(sendSvc.seedSentReadState(W.db, job())).rejects.toThrow(/not stored yet/);
    await expect(sendSvc.seedSentReadState(W.db, job(), { final: true })).resolves.toEqual({ seeded: 0, found: 0, gave_up: true });
  });

  test('marks the stored copy read for the SENDER only, found by Gmail id within a day of the send', async () => {
    W.message(301, { mailbox_id: 2, folder: '[Gmail]/All Mail', provider_id: '1a2b3c4d5e6f7081', date: new Date('2026-10-11T14:00:05Z') });
    W.message(302, { mailbox_id: 2, folder: '[Gmail]/All Mail', provider_id: '1a2b3c4d5e6f7081', date: new Date('2026-10-01T10:00:00Z') }); // same id, long before: not this send
    expect(await sendSvc.seedSentReadState(W.db, job())).toEqual({ seeded: 1, found: 1 });
    expect(W.readSet(SS)).toEqual([301]);
    expect(W.readSet(SU)).toEqual([]);
  });

  test('by Message-ID across the mailboxes the sender can READ — never one they cannot', async () => {
    W.message(311, { mailbox_id: 1, folder: 'INBOX.Sent', message_id: 'uuid-1@firm.test' });
    W.message(312, { mailbox_id: 2, folder: 'INBOX', message_id: 'uuid-1@firm.test' });
    expect(await sendSvc.seedSentReadState(W.db, { user: SENDER, mailbox_id: 1, sent_at: new Date().toISOString(), message_id: 'uuid-1@firm.test', provider_id: null }))
      .toEqual({ seeded: 1, found: 1 });
    expect(W.readSet(SENDER)).toEqual([311]);
  });

  test('lib/job_executor dispatches the type, final on the last attempt', async () => {
    const { executeJob } = require('../lib/job_executor');
    const data = JSON.stringify({ type: 'mail_sent_read_seed', ...job() });
    await expect(executeJob({ data, attempts: 0, max_attempts: 4 }, W.db)).rejects.toThrow(/not stored yet/);
    await expect(executeJob({ data, attempts: 3, max_attempts: 4 }, W.db)).resolves.toMatchObject({ gave_up: true });
  });
});
