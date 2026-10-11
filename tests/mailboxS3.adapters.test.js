// tests/mailboxS3.adapters.test.js
//
/**
 * Mailbox system S3 — the HUB-ONLY OPTIONS in services/emailService.js and the
 * two adapters that carry them (services/adapters/email/smtp.js, gmail.js).
 * Run: npx jest tests/mailboxS3.adapters.test.js
 *
 * The bar: every existing caller (workflows, sequences, campaigns, alerts)
 * builds EXACTLY what it built before — the options exist only on
 * sendEmailDirect, the public sendEmail strips them, and an adapter sets a
 * header only when its option is present. Real adapters; mocked: nodemailer's
 * SMTP transport (capture mailOptions), the Gmail API (global fetch) and the
 * token minting in credentialInjection. MIME is compiled by the real
 * MailComposer.
 *
 * Mutation-checked (worker run 2026-10-11 — each fails a test here):
 *   - sendEmail forwarding the hub-only keys            → "public sendEmail strips them"
 *   - smtp mailOptions spreading cc/bcc unconditionally  → "baseline mailOptions" (undefined keys appear)
 *   - gmail keepBcc dropped                              → "Bcc reaches the raw message"
 *   - gmail threadId sent always / never                 → threadId tests
 *   - lookupThreadId throwing instead of null            → lookup tests
 *   - lookupThreadId without its hex-id check            → lookup tests (no fetch for a path)
 */

'use strict';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});
const mockHeaders = jest.fn(async () => ({ Authorization: 'Bearer t' }));
jest.mock('../lib/credentialInjection', () => {
  const actual = jest.requireActual('../lib/credentialInjection');
  return { ...actual, buildHeadersForCredential: (...a) => mockHeaders(...a), loadCredential: jest.fn(async (db, id) => ({ id, name: 'G', type: 'oauth2' })) };
});

const emailService = require('../services/emailService');
const smtp = require('../services/adapters/email/smtp');
const gmail = require('../services/adapters/email/gmail');
const { encrypt } = require('../lib/credentialCrypto');

const SMTP_ROW = { id: 4, email: 'it@mdbl.test', from_name: 'IT', provider: 'smtp', credential_id: null,
  smtp_host: 'mail.mdbl.test', smtp_port: 587, smtp_secure: 0, smtp_user: 'it@mdbl.test', smtp_pass: encrypt('pw') };
const GMAIL_ROW = { id: 1, email: 'stuart@firm.test', from_name: 'Stuart', provider: 'gmail', credential_id: 11 };
const HUB = { cc: 'c@x.test', bcc: 'b@x.test', in_reply_to: '<p@x.test>', references: '<r@x.test> <p@x.test>', message_id: '<mine@firm.test>', thread_id: '77aa' };
const db = () => ({ calls: [], query(sql, p) { this.calls.push({ sql, p }); return Promise.resolve([[]]); } });

const realFetch = global.fetch;
let fetchCalls;
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async (o) => ({ messageId: o.messageId || '<auto@x>', response: '250 OK', accepted: [o.to], rejected: [] }));
  mockHeaders.mockReset();
  mockHeaders.mockImplementation(async () => ({ Authorization: 'Bearer t' }));
  fetchCalls = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    fetchCalls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (/format=minimal/.test(url)) return new Response(JSON.stringify({ id: 'abc', threadId: '99ff' }), { status: 200 });
    return new Response(JSON.stringify({ id: '1a2b', threadId: '1a00' }), { status: 200 });
  });
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

const rawOf = (call) => Buffer.from(call.body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const headerNames = (raw) => raw.split(/\r?\n\r?\n/)[0].split(/\r?\n/).filter((l) => /^[A-Za-z-]+:/.test(l)).map((l) => l.split(':')[0]);

describe('emailService: hub-only options live on sendEmailDirect only', () => {
  test('the public sendEmail strips them — an automation caller can never start setting headers', async () => {
    const spy = jest.spyOn(smtp, 'sendEmail');
    const d = { query: jest.fn(async (sql) => (/FROM email_credentials/.test(sql) ? [[SMTP_ROW]] : [{}])) };
    await emailService.sendEmail(d, { from: 'it@mdbl.test', to: 'x@y.test', subject: 's', text: 't', ...HUB });
    const a = spy.mock.calls[0][1];
    for (const k of ['cc', 'bcc', 'inReplyTo', 'references', 'messageId', 'threadId']) expect(a[k]).toBeUndefined();
    expect(Object.keys(mockSendMail.mock.calls[0][0]).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    expect(emailService.HUB_ONLY_OPTIONS).toEqual(['cc', 'bcc', 'in_reply_to', 'references', 'message_id', 'thread_id']);
  });

  test('sendEmailDirect passes them to the adapter, renamed', async () => {
    const spy = jest.spyOn(smtp, 'sendEmail');
    await emailService.sendEmailDirect(db(), SMTP_ROW, { from: 'it@mdbl.test', to: 'x@y.test', subject: 's', text: 't', ...HUB });
    expect(spy.mock.calls[0][1]).toMatchObject({ cc: 'c@x.test', bcc: 'b@x.test', inReplyTo: '<p@x.test>', references: '<r@x.test> <p@x.test>', messageId: '<mine@firm.test>', threadId: '77aa' });
  });
});

describe('smtp adapter', () => {
  const base = { from: 'it@mdbl.test', fromName: 'IT', to: 'x@y.test', subject: 's', text: 't', html: '<p>t</p>', emailRow: SMTP_ROW };

  test('baseline: the exact mailOptions it always built — no new key, not even an undefined one', async () => {
    await smtp.sendEmail(db(), base);
    expect(mockSendMail.mock.calls[0][0]).toEqual({ from: '"IT" <it@mdbl.test>', to: 'x@y.test', subject: 's', text: 't', html: '<p>t</p>' });
    expect(Object.keys(mockSendMail.mock.calls[0][0])).toEqual(['from', 'to', 'subject', 'text', 'html']);
  });

  test('hub options reach nodemailer; email_log is still the one outbound-smtp row keyed by the Message-ID', async () => {
    const d = db();
    await smtp.sendEmail(d, { ...base, cc: 'c@x.test', bcc: 'b@x.test', inReplyTo: '<p@x.test>', references: '<r@x.test> <p@x.test>', messageId: '<mine@firm.test>' });
    expect(mockSendMail.mock.calls[0][0]).toMatchObject({ cc: 'c@x.test', bcc: 'b@x.test', inReplyTo: '<p@x.test>', references: '<r@x.test> <p@x.test>', messageId: '<mine@firm.test>' });
    const logs = d.calls.filter((c) => /INSERT INTO email_log/.test(c.sql));
    expect(logs).toHaveLength(1);
    expect(logs[0].p[0]).toBe('<mine@firm.test>');
    expect(logs[0].p[2]).toBe('x@y.test');
  });

  test('the headers nodemailer writes from those options (real MIME build)', async () => {
    const actual = jest.requireActual('nodemailer');
    const t = actual.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    await smtp.sendEmail(db(), { ...base, cc: 'c@x.test', inReplyTo: '<p@x.test>', references: '<r@x.test> <p@x.test>', messageId: '<mine@firm.test>' });
    const info = await t.sendMail(mockSendMail.mock.calls[0][0]);
    const raw = info.message.toString('utf8');
    expect(raw).toMatch(/^In-Reply-To: <p@x\.test>$/m);
    expect(raw).toMatch(/^References: <r@x\.test> <p@x\.test>$/m);
    expect(raw).toMatch(/^Message-ID: <mine@firm\.test>$/m);
    expect(raw).toMatch(/^Cc: c@x\.test$/m);
  });
});

describe('gmail adapter', () => {
  const base = { from: 'stuart@firm.test', fromName: 'Stuart', to: 'x@y.test', subject: 's', text: 't', html: '<p>t</p>', credential: { id: 11, type: 'oauth2', name: 'G' }, emailRow: GMAIL_ROW };

  test('baseline: body {raw} only; the raw message carries the headers it always did', async () => {
    await gmail.sendEmail(db(), base);
    expect(Object.keys(fetchCalls[0].body)).toEqual(['raw']);
    expect(headerNames(rawOf(fetchCalls[0])).sort()).toEqual(['Content-Type', 'Date', 'From', 'MIME-Version', 'Message-ID', 'Subject', 'To']);
  });

  test('hub options: Cc / In-Reply-To / References / Message-ID in the MIME, Bcc KEPT (Gmail reads recipients from it), threadId in the body', async () => {
    await gmail.sendEmail(db(), { ...base, cc: 'c@x.test', bcc: 'b@x.test', inReplyTo: '<p@x.test>', references: '<r@x.test> <p@x.test>', messageId: '<mine@firm.test>', threadId: '77aa' });
    const raw = rawOf(fetchCalls[0]);
    expect(raw).toMatch(/^Bcc: b@x\.test\r?$/m);
    expect(raw).toMatch(/^Cc: c@x\.test\r?$/m);
    expect(raw).toMatch(/^In-Reply-To: <p@x\.test>\r?$/m);
    expect(raw).toMatch(/^References: <r@x\.test> <p@x\.test>\r?$/m);
    expect(raw).toMatch(/^Message-ID: <mine@firm\.test>\r?$/m);
    expect(fetchCalls[0].body.threadId).toBe('77aa');
  });

  test('no bcc → no Bcc header and no keepBcc', async () => {
    await gmail.sendEmail(db(), { ...base, cc: 'c@x.test' });
    expect(rawOf(fetchCalls[0])).not.toMatch(/^Bcc:/m);
  });

  test('lookupThreadId: the threadId, or null on ANY failure — never a throw', async () => {
    await expect(gmail.lookupThreadId(db(), 11, 'ABC')).resolves.toBe('99ff');
    expect(fetchCalls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=minimal');
    global.fetch = jest.fn(async () => new Response('{"error":{}}', { status: 404 }));
    await expect(gmail.lookupThreadId(db(), 11, 'abc')).resolves.toBeNull();
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(gmail.lookupThreadId(db(), 11, 'abc')).resolves.toBeNull();
    mockHeaders.mockImplementation(async () => ({}));
    await expect(gmail.lookupThreadId(db(), 11, 'abc')).resolves.toBeNull();
    mockHeaders.mockImplementation(async () => ({ Authorization: 'Bearer t' })); // a token again: only the id check stands between
    const f = jest.fn();
    global.fetch = f;
    await expect(gmail.lookupThreadId(db(), 11, '../../etc')).resolves.toBeNull();
    await expect(gmail.lookupThreadId(db(), 11, 'abc?x=1')).resolves.toBeNull();
    await expect(gmail.lookupThreadId(db(), null, 'abc')).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
