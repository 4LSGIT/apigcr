// tests/mailboxSendExtras.send.test.js
//
/**
 * Comms hub send extras (2026-11-16): attachments by document id on
 * POST /api/mail/send, and scheduled sends — POST /api/mail/send/schedule,
 * GET /api/mail/send/scheduled, DELETE /api/mail/send/scheduled/:id, and the
 * 'mail_scheduled_send' job (services/mailbox/mailboxScheduledSendService →
 * lib/job_executor). Run: npx jest tests/mailboxSendExtras.send.test.js
 *
 * Harness: the S3 send harness — the REAL routers, grant resolution, the send
 * service, emailService and both adapters over an express app against the
 * stateful fake DB (tests/helpers/mailboxS3World.js — `documents`,
 * scheduled_jobs and request_idempotency statements added for this slice;
 * unknown statements throw). Mocked at the edges only: nodemailer's
 * transport, the Gmail HTTP API, credentialInjection's token minting,
 * imapTransport.appendSent, and documentSourceService's Dropbox provider
 * `download` (the bytes). The SQL runs on MySQL in
 * tests/mailboxSendExtras.mysql.test.js (gated).
 *
 * Mutation-checked (break it, watch it fail — jest EXIT CODE; worker run
 * 2026-11-16, each listed in the slice report):
 *   - loadAttachments: the status check dropped / size NULL allowed / the
 *     per-file or total cap off / duplicates counted                 → "validation, before any Dropbox call"
 *   - the documents check moved AFTER checkBudget                    → "the daily budget comes before any Dropbox call"
 *   - fetchAttachments after the dispatch; a fetch failure swallowed → "a fetch failure is a 502"
 *   - the route releasing a 502 claim for ANY 502 / for none          → the Idempotency-Key retry test
 *   - attachments left out of the APPEND copy / a contentType added  → "the exact adapter payload"
 *   - parseSendAt: a naive time accepted; the window edges off         → "send_at …"
 *   - scheduleSend storing the RAW body; max_attempts 3                → "ONE scheduled_jobs row"
 *   - the schedule route skipping the SU step-up / limiter / gate     → "the checks a send runs"
 *   - the list predicate without the user / the 7-day window off      → "own only"
 *   - cancel without `status = 'pending'`; 404 for a finished row     → cancel tests
 *   - runScheduledSend without the fence (sendFromMailbox called bare);
 *     releaseOnError dropped (a 502 releases); the unknown outcome
 *     re-dispatching                                                   → the executor tests
 *   - the sender notice / the alert dropped; the alert's dedup off     → "stale in_flight claim"
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-extras-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_extras_internal';
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
const { makeWorld } = require('./helpers/mailboxS3World');
const transport = require('../services/mailbox/imapTransport');
const sendSvc = require('../services/mailbox/mailboxSendService');
const sched = require('../services/mailbox/mailboxScheduledSendService');
const sources = require('../services/documentSourceService');
const optout = require('../services/optoutService');
const { executeJob } = require('../lib/job_executor');
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

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user, user_auth = 'authorized', roles = []) =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, roles, aud: 'staff' }, process.env.JWT_SECRET);

async function call(method, url, { t, body, elevate, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (elevate != null) headers['x-su-elevation'] = mintElevationToken(elevate);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json };
}

// Users: 1 = SS (attorney; send on box 2), 5 = reader of box 1, 6 = SU,
// 8 = reader + sender of boxes 1 (smtp) and 2 (gmail), 9 = nobody.
const SS = 1; const READER = 5; const SU = 6; const SENDER = 8; const NOBODY = 9;
const MiB = 1024 * 1024;
const SENT_ALL_MAIL = { '[Gmail]/All Mail': { emit_to_rules: true, backfill: false } };
let download;

function seed() {
  W = makeWorld();
  const cred = W.cred;
  W.cred = (id, over = {}) => cred(id, { smtp_pass: encrypt('smtp-pw'), ...over });
  W.user(SS, { roles: 'staff,attorney' });
  W.user(READER, { roles: 'staff' });
  W.user(SU, { auth: 'authorized', roles: 'it,admin,form_dev,su' });
  W.user(SENDER, { roles: 'staff' });
  W.user(NOBODY, { roles: 'staff' });
  W.setEmail(SENDER, 'sender8@firm.test');
  W.cred(1, { email: 'billing@firm.test', from_name: 'Firm Billing', smtp_user: 'billing@firm.test' });
  W.cred(2, { email: 'stuart@firm.test', from_name: 'Stuart S', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '' });
  // the task reminders' sender — what the scheduled-send failure notice goes out as
  W.cred(9, { email: 'automations@firm.test', from_name: 'Automations', smtp_user: 'automations@firm.test' });
  W.setting('email_automations', 'automations@firm.test');
  W.mailbox(1, { address: 'billing@firm.test', display_name: 'Billing', send_credential_id: 1, imap_host: 'imap.firm.test', imap_port: 993,
    imap_user: 'billing@firm.test', imap_secret: 'ENCv1:secret', ingest_enabled: 1,
    ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: true }, 'INBOX.Sent': { emit_to_rules: false } }) });
  W.mailbox(2, { address: 'stuart@firm.test', display_name: 'Stuart', send_credential_id: 2, imap_host: 'imap.gmail.com',
    imap_user: 'stuart@firm.test', imap_secret: 'ENCv1:g', ingest_enabled: 1, ingest_folders: JSON.stringify(SENT_ALL_MAIL) });
  W.grant(READER, 1, { read: 1 });
  W.grant(SENDER, 1, { read: 1, send: 1 });
  W.grant(SENDER, 2, { read: 1, send: 1 });
  W.grant(SS, 2, { read: 1, send: 1, manage: 1 });
  W.caseRow('CaseA1', '26-11111', '26-11111-tjt');
  W.message(101, { mailbox_id: 1, message_id: 'root@x.test', thread_key: 'root@x.test', subject: 'Plan objection',
    from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test' });
  // documents: 1 a 1 MB pdf; 2 a 14 MB pdf; 3 deleted; 4 size unknown; 5 over the per-file cap; 6 a 2 MB docx
  W.doc(1);
  W.doc(2, { name: 'Big.pdf', size: 14 * MiB });
  W.doc(3, { name: 'Gone.pdf', status: 'deleted' });
  W.doc(4, { name: 'Unknown.bin', size: null, ext: 'bin', mime: null });
  W.doc(5, { name: 'Huge.zip', size: 16 * MiB, ext: 'zip' });
  W.doc(6, { name: 'Letter.docx', size: 2 * MiB, ext: 'docx' });
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
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://gmail.googleapis.com/')) return realFetch(url, init);
    gmailCalls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const body = /\/messages\/send$/.test(u) ? { id: '1a2b3c4d5e6f7081', threadId: '1a2b3c4d5e6f7000', labelIds: ['SENT'] } : { id: 'abc123', threadId: '77aa' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  jest.spyOn(transport, 'appendSent').mockResolvedValue({ appended: true, folder: 'INBOX.Sent', uid: 9, reason: null });
  // the bytes: documentSourceService.get('dropbox') IS this object, so the spy is what the service calls
  download = jest.spyOn(sources.dropboxProvider, 'download').mockImplementation(async (db, externalId) => ({ buffer: Buffer.from(`bytes-of-${externalId}`), metadata: {} }));
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

const MSG = (over = {}) => ({ mailbox_id: 1, to: ['client@outside.test'], subject: 'Hello', body_text: 'Hi there', ...over });
const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();
const statementsLike = (re) => W.statements.filter((s) => re.test(s.sql));
const gmailRaw = () => {
  const send = gmailCalls.find((c) => /\/messages\/send$/.test(c.url));
  return send ? Buffer.from(send.body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : null;
};
const jobs = () => W.T.scheduled_jobs.filter((j) => JSON.parse(j.data).type === sched.JOB_TYPE);
const jobData = (j) => JSON.parse(j.data);
const alerts = () => W.T.system_alerts.map((a) => [a.kind, a.severity]);
const audits = () => W.T.admin_audit_log.map((a) => a.status);

// ─────────────────────────────────────────────────────────────────────────────
describe('attachments on POST /api/mail/send', () => {
  test('the exact adapter payload: inline {filename, content} with NO declared type; the Sent copy carries the same file; duplicates collapse; the response and the audit name it', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 1 }, 1, '1'] }) });
    expect(r.status).toBe(200);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0].slice(1)).toEqual(['id:doc1']);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.attachments).toHaveLength(1);
    expect(Object.keys(opts.attachments[0]).sort()).toEqual(['content', 'filename']); // the type is MailComposer's to infer — never row.mime
    expect(opts.attachments[0].filename).toBe('Document 1.pdf');
    expect(opts.attachments[0].content.equals(Buffer.from('bytes-of-id:doc1'))).toBe(true);
    // the APPENDed copy IS the message: the file is in it, base64 and named
    const raw = transport.appendSent.mock.calls[0][1].toString('utf8');
    expect(raw).toMatch(/filename="?Document 1\.pdf"?/);
    expect(raw).toMatch(/Content-Type: application\/pdf/);
    expect(raw).toContain(Buffer.from('bytes-of-id:doc1').toString('base64'));
    expect(r.json.attachments).toEqual([{ document_id: 1, name: 'Document 1.pdf', size: MiB }]);
    const audit = W.T.admin_audit_log.find((a) => a.status === 'sent');
    expect(audit.details.attachments).toEqual([1]);
    expect(JSON.stringify(audit.details)).not.toMatch(/Document 1/); // ids, never names
    // order: the documents check runs BEFORE the budget count
    const docsAt = W.statements.findIndex((s) => /FROM documents WHERE id IN/.test(s.sql));
    const budgetAt = W.statements.findIndex((s) => /COUNT\(\*\) AS n FROM email_log/.test(s.sql));
    expect(docsAt).toBeGreaterThan(-1);
    expect(docsAt).toBeLessThan(budgetAt);
  });

  test('a send without attachments is byte-for-byte the S3 send (no attachments key reaches the adapter)', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG() });
    expect(r.status).toBe(200);
    expect(download).not.toHaveBeenCalled();
    expect(statementsLike(/FROM documents/)).toEqual([]);
    expect('attachments' in mockSendMail.mock.calls[0][0]).toBe(false);
    expect(r.json.attachments).toEqual([]);
  });

  test('Gmail: the file rides the MIME Gmail gets', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ mailbox_id: 2, attachments: [{ document_id: 6 }] }) });
    expect(r.status).toBe(200);
    const raw = gmailRaw();
    expect(raw).toMatch(/filename="?Letter\.docx"?/);
    expect(raw).toContain(Buffer.from('bytes-of-id:doc6').toString('base64'));
  });

  test('validation, before any Dropbox call: unknown id, deleted, size unknown, over the per-file cap, over the total cap, more than 10, bad shapes — 400 naming the file, nothing fetched, nothing sent', async () => {
    for (let i = 11; i <= 21; i++) W.doc(i, { size: 1000 });
    const cases = [
      [[{ document_id: 777 }], /document #777 is not a registered document/],
      [[{ document_id: 3 }], /"Gone\.pdf" has been deleted from storage/],
      [[{ document_id: 4 }], /size of "Unknown\.bin" is not known/],
      [[{ document_id: 5 }], /"Huge\.zip" is 16 MB — at most 15 MB per file/],
      [[{ document_id: 2 }, { document_id: 6 }], /together they come to more than 15 MB/],
      [Array.from({ length: 11 }, (_, i) => ({ document_id: 11 + i })), /at most 10 attachments/],
      ['x', /must be an array/],
      [[{ document_id: 'abc' }], /positive integer/],
      [[{}], /positive integer/],
      [[null], /positive integer/],
    ];
    for (const [attachments, re] of cases) {
      const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments }) });
      expect([String(re), r.status, r.json.message]).toEqual([String(re), 400, expect.stringMatching(re)]);
    }
    // ten of 1000 bytes pass the count cap; 14 MB + 1 MB = 15 MB is AT the total cap (allowed)
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: Array.from({ length: 10 }, (_, i) => ({ document_id: 11 + i })) }) })).status).toBe(200);
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 2 }, { document_id: 1 }] }) })).status).toBe(200);
    expect(download).toHaveBeenCalledTimes(12);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  test('the daily budget comes before any Dropbox call (a 429 costs no fetch); a missing document is refused before the budget is even counted', async () => {
    W.setting(sendSvc.BUDGET_SETTING, JSON.stringify({ smtp: 1 }));
    W.sent({ source: 'outbound-smtp', from_email: 'billing@firm.test' });
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 1 }] }) });
    expect(r.status).toBe(429);
    expect(download).not.toHaveBeenCalled();
    W.statements.length = 0;
    const bad = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 777 }] }) });
    expect(bad.status).toBe(400);
    expect(statementsLike(/COUNT\(\*\) AS n FROM email_log/)).toEqual([]);
  });

  test('a fetch failure is a 502 naming the file — nothing sent, no Sent copy, audited send_failed; with an Idempotency-Key the claim is RELEASED (pre-dispatch), so the same key sends once the fetch works', async () => {
    download.mockRejectedValue(Object.assign(new Error('dropbox: request to /2/files/download failed: ECONNRESET'), { transient: true }));
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 1 }, { document_id: 6 }] }) });
    expect(r.status).toBe(502);
    expect(r.json.message).toMatch(/not sent/);
    expect(r.json.message).toMatch(/"Document 1\.pdf" could not be fetched/);
    expect(r.json.message).toMatch(/ECONNRESET/);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(transport.appendSent).not.toHaveBeenCalled();
    expect(audits()).toEqual(['send_failed']);
    // the idempotent client: the key comes back after a pre-dispatch 502
    const headers = { 'Idempotency-Key': 'attach-retry-0001' };
    const again = await call('POST', '/api/mail/send', { t: tok(SENDER), headers, body: MSG({ attachments: [{ document_id: 1 }] }) });
    expect(again.status).toBe(502);
    expect(W.T.request_idempotency).toEqual([]); // released — nothing was sent
    download.mockImplementation(async (db, externalId) => ({ buffer: Buffer.from(`bytes-of-${externalId}`), metadata: {} }));
    const ok = await call('POST', '/api/mail/send', { t: tok(SENDER), headers, body: MSG({ attachments: [{ document_id: 1 }] }) });
    expect([ok.status, ok.json.replayed]).toEqual([200, undefined]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(W.T.request_idempotency.map((x) => [x.scope, x.idem_key, x.status])).toEqual([['mail.send', 'attach-retry-0001', 'applied']]);
    // …but a 502 AFTER dispatch still keeps the claim (the S3/A14 rule, untouched)
    mockSendMail.mockRejectedValueOnce(new Error('451 try later'));
    const h2 = { 'Idempotency-Key': 'attach-retry-0002' };
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), headers: h2, body: MSG({ attachments: [{ document_id: 1 }] }) })).status).toBe(502);
    expect(W.T.request_idempotency.find((x) => x.idem_key === 'attach-retry-0002')).toMatchObject({ status: 'in_flight' });
  });

  test('storage returning no bytes, or a file grown past the cap since registration, is the same 502 — nothing sent', async () => {
    download.mockResolvedValueOnce({ metadata: {} });
    let r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 1 }] }) });
    expect([r.status, r.json.message]).toEqual([502, expect.stringMatching(/storage returned no bytes/)]);
    download.mockResolvedValueOnce({ buffer: Buffer.alloc(15 * MiB + 1), metadata: {} });
    r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 1 }] }) });
    expect([r.status, r.json.message]).toEqual([502, expect.stringMatching(/larger than the 1 MB the registry recorded/)]);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('GET /api/mail/identities carries the caps the composer mirrors', async () => {
    const r = await call('GET', '/api/mail/identities', { t: tok(SENDER) });
    expect(r.json.limits).toEqual({
      max_attachments: 10, attachment_max_bytes: 15 * MiB, attachments_total_bytes: 15 * MiB,
      schedule_min_ahead_ms: 2 * 60_000, schedule_max_ahead_ms: 30 * 86_400_000,
    });
    expect([sendSvc.MAX_ATTACHMENTS, sendSvc.ATTACHMENT_MAX_BYTES, sendSvc.ATTACHMENTS_TOTAL_BYTES]).toEqual([10, 15 * MiB, 15 * MiB]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/mail/send/schedule', () => {
  test('send_at: missing, naive (no zone), under 2 minutes, over 30 days — 400s, no row', async () => {
    const now = Date.now();
    for (const [send_at, re] of [
      [undefined, /zone/], ['2026-12-01T09:30:00', /zone/], ['soon', /zone/], ['2026-12-01T09:30:00+0500', /zone/],
      [new Date(now + 90_000).toISOString(), /at least 2 minutes/], [new Date(now + 31 * 86_400_000).toISOString(), /within 30 days/],
    ]) {
      const r = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at }) });
      expect([String(send_at), r.status, r.json.message]).toEqual([String(send_at), 400, expect.stringMatching(re)]);
    }
    // the edges hold: +2 min and +30 days (less a second) are accepted; ±hh:mm zones parse
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at: new Date(now + 121_000).toISOString() }) })).status).toBe(201);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at: new Date(now + 30 * 86_400_000 - 1000).toISOString() }) })).status).toBe(201);
    const offset = new Date(now + 3600_000);
    const local = new Date(offset.getTime() + 5 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+05:00');
    const r = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at: local }) });
    expect([r.status, Math.abs(new Date(r.json.send_at).getTime() - offset.getTime()) < 1000]).toEqual([201, true]);
    expect(jobs()).toHaveLength(3);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('ONE scheduled_jobs row (one_time, pending, max_attempts 1) holding the VALIDATED body — never the raw request; 201 {job_id, send_at}; audited scheduled', async () => {
    const send_at = IN_1H();
    const body = {
      mailbox_id: 1, to: ['Client <client@outside.test>'], cc: ['x@outside.test', 'CLIENT@outside.test'], subject: '  Hello  ', body_text: 'Hi',
      case_id: 'CaseA1', attachments: [{ document_id: 1 }, { document_id: 1 }], signature: true, send_at,
    };
    const r = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ job_id: 1, send_at, mailbox_id: 1, from: 'billing@firm.test', recipients: 2, attachments: [{ document_id: 1, name: 'Document 1.pdf', size: MiB }] });
    const [job] = jobs();
    expect(job).toMatchObject({ type: 'one_time', status: 'pending', active: 1, max_attempts: 1, name: 'Mail scheduled send — user #8 (mailbox #1)' });
    expect(job.scheduled_time).toEqual(new Date(send_at));
    const data = jobData(job);
    expect(data).toMatchObject({ type: 'mail_scheduled_send', user: SENDER, mailbox_id: 1, acknowledged_optout: false });
    expect(Date.parse(data.requested_at)).toBeGreaterThan(Date.now() - 10_000);
    expect(data.body).toEqual({
      mailbox_id: 1, to: [{ email: 'client@outside.test', name: 'Client' }], cc: [{ email: 'x@outside.test', name: null }], bcc: [],
      subject: 'Hello', body_text: 'Hi', body_html: null, in_reply_to_message_fk: null, quote_original: true, signature: true,
      acknowledge_optout: false, case_id: 'CaseA1', attachments: [1],
    });
    expect('send_at' in data.body).toBe(false);
    // the stored body re-validates as itself at send time (what runScheduledSend hands sendFromMailbox)
    expect(sendSvc.validateSendBody(data.body)).toEqual(data.body);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled(); // bytes are fetched at SEND time
    const audit = W.T.admin_audit_log.find((a) => a.status === 'scheduled');
    expect(audit.details).toMatchObject({ mailbox_id: 1, job_id: 1, send_at, recipients: 2, attachments: [1] });
    expect(JSON.stringify(audit.details)).not.toMatch(/client@|Hello/);
    // a reply schedules too (the parent must be readable; the subject may be empty)
    const rep = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: { mailbox_id: 1, to: ['c@x.test'], body_text: 'Re', in_reply_to_message_fk: 101, send_at } });
    expect(rep.status).toBe(201);
    expect(jobData(jobs()[1]).body).toMatchObject({ in_reply_to_message_fk: 101, subject: '' });
  });

  test('the checks a send runs, in its order: SU step-up 401; reader 403; nobody 404; unknown box 404; unknown case 400; a deleted / unknown document 400; an unreadable parent 404; the opt-out gate 409 — no row for any of them', async () => {
    const send_at = IN_1H();
    const su = await call('POST', '/api/mail/send/schedule', { t: tok(SU, 'authorized', ['su']), body: MSG({ send_at }) });
    expect([su.status, su.json.code]).toEqual([401, 'elevation_required']);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(READER), body: MSG({ send_at }) })).status).toBe(403);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(NOBODY), body: MSG({ send_at }) })).status).toBe(404);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ mailbox_id: 999, send_at }) })).status).toBe(404);
    const cs = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ case_id: 'NOPE', send_at }) });
    expect([cs.status, cs.json.message]).toEqual([400, expect.stringMatching(/not a case/)]);
    const del = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 3 }], send_at }) });
    expect([del.status, del.json.message]).toEqual([400, expect.stringMatching(/"Gone\.pdf" has been deleted/)]);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ attachments: [{ document_id: 777 }], send_at }) })).status).toBe(400);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ in_reply_to_message_fk: 999, send_at }) })).status).toBe(404);
    const gate = jest.spyOn(optout, 'optoutGate').mockResolvedValue({ refusal: { status: 409, body: { status: 'error', code: 'opted_out', message: 'c has opted out' } }, overridden: [] });
    const oo = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at }) });
    expect([oo.status, oo.json.code]).toEqual([409, 'opted_out']);
    expect(gate.mock.calls[0][1]).toMatchObject({ channel: 'email', acknowledged: false });
    gate.mockRestore();
    expect(jobs()).toEqual([]);
    expect(audits()).toEqual(['rejected_no_elevation', 'refused_opted_out']);
    // the SU, elevated, schedules; the acknowledgement travels with the job
    const ok = await call('POST', '/api/mail/send/schedule', { t: tok(SU, 'authorized', ['su']), elevate: SU, body: MSG({ send_at, acknowledge_optout: true }) });
    expect(ok.status).toBe(201);
    expect(jobData(jobs()[0])).toMatchObject({ user: SU, acknowledged_optout: true, body: { acknowledge_optout: true } });
  });

  test('the per-user send limiter counts schedules and sends in one window; a colleague is unaffected', async () => {
    for (let i = 0; i < mailRouter.SEND_RATE_MAX; i++) {
      expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at: IN_1H() }) })).status).toBe(201);
    }
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at: IN_1H() }) })).status).toBe(429);
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG() })).status).toBe(429);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SS), body: MSG({ mailbox_id: 2, send_at: IN_1H() }) })).status).toBe(201);
    expect(jobs()).toHaveLength(mailRouter.SEND_RATE_MAX + 1);
  });

  test('Idempotency-Key (scope mail.schedule): the same key twice schedules ONCE and the replay says so; a refusal releases it', async () => {
    const headers = { 'Idempotency-Key': 'sched-key-0001' };
    const bad = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), headers, body: MSG({ case_id: 'NOPE', send_at: IN_1H() }) });
    expect(bad.status).toBe(400);
    expect(W.T.request_idempotency).toEqual([]);
    const a = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), headers, body: MSG({ send_at: IN_1H() }) });
    const b = await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), headers, body: MSG({ send_at: IN_1H() }) });
    expect([a.status, b.status, b.json.replayed, b.json.job_id]).toEqual([201, 200, true, a.json.job_id]);
    expect(jobs()).toHaveLength(1);
    expect(W.T.request_idempotency.map((x) => [x.user_id, x.scope, x.status])).toEqual([[SENDER, 'mail.schedule', 'applied']]);
    expect(audits().filter((s) => s === 'scheduled')).toHaveLength(1);
  });

  test('the daily budget is NOT checked at scheduling (it is send-time)', async () => {
    W.setting(sendSvc.BUDGET_SETTING, JSON.stringify({ smtp: 1 }));
    W.sent({ source: 'outbound-smtp', from_email: 'billing@firm.test' });
    expect((await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG() })).status).toBe(429);
    expect((await call('POST', '/api/mail/send/schedule', { t: tok(SENDER), body: MSG({ send_at: IN_1H() }) })).status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/mail/send/scheduled · DELETE /api/mail/send/scheduled/:id', () => {
  async function schedule(t, over = {}) {
    const r = await call('POST', '/api/mail/send/schedule', { t, body: MSG({ send_at: IN_1H(), ...over }) });
    expect(r.status).toBe(201);
    return W.T.scheduled_jobs.find((j) => j.id === r.json.job_id);
  }

  test('own only — an SU included; the shape; finished rows for 7 days; a document deleted since is marked, never dropped', async () => {
    const a = await schedule(tok(SENDER), { attachments: [{ document_id: 1 }], cc: ['x@outside.test'], case_id: 'CaseA1' });
    await schedule(tok(SS), { mailbox_id: 2 });
    const done = await schedule(tok(SENDER)); done.status = 'completed'; done.updated_at = new Date();
    const old = await schedule(tok(SENDER)); old.status = 'failed'; old.updated_at = new Date(Date.now() - 8 * 86_400_000);
    const canc = await schedule(tok(SENDER)); canc.status = 'cancelled'; canc.active = 0; canc.updated_at = new Date(Date.now() - 86_400_000);
    const running = await schedule(tok(SENDER)); running.status = 'running';
    W.T.documents.find((d) => d.id === 1).status = 'deleted';
    const r = await call('GET', '/api/mail/send/scheduled', { t: tok(SENDER) });
    expect(r.status).toBe(200);
    expect(r.json.scheduled.map((s) => [s.id, s.status])).toEqual([[a.id, 'pending'], [done.id, 'completed'], [canc.id, 'cancelled'], [running.id, 'running']]);
    expect(r.json.scheduled[0]).toEqual({
      id: a.id, send_at: a.scheduled_time.toISOString(), status: 'pending', outcome: null,
      mailbox: { id: 1, address: 'billing@firm.test' },
      to: [{ email: 'client@outside.test', name: null }], cc: [{ email: 'x@outside.test', name: null }], bcc: [],
      subject: 'Hello', in_reply_to_message_fk: null, case_id: 'CaseA1',
      attachments: [{ document_id: 1, name: 'Document 1.pdf', status: 'deleted' }],
      acknowledged_optout: false, created_at: expect.any(String),
    });
    expect(JSON.stringify(r.json)).not.toMatch(/Hi there/); // never the bodies
    expect((await call('GET', '/api/mail/send/scheduled', { t: tok(SU, 'authorized', ['su']) })).json.scheduled).toEqual([]);
    expect((await call('GET', '/api/mail/send/scheduled', { t: tok(SS) })).json.scheduled.map((s) => s.mailbox.address)).toEqual(['stuart@firm.test']);
    expect((await call('GET', '/api/mail/send/scheduled', { t: tok(NOBODY) })).json.scheduled).toEqual([]);
  });

  test('cancel: ONE conditional UPDATE — 200 once (status cancelled, active 0, audited); again 409 already_cancelled; another user\'s 404; running / completed / failed 409 with the text', async () => {
    const mine = await schedule(tok(SENDER));
    const theirs = await schedule(tok(SS), { mailbox_id: 2 });
    const r = await call('DELETE', `/api/mail/send/scheduled/${mine.id}`, { t: tok(SENDER) });
    expect([r.status, r.json]).toEqual([200, { status: 'success', id: mine.id, status: 'cancelled' }]);
    expect(mine).toMatchObject({ status: 'cancelled', active: 0 });
    expect(statementsLike(/^UPDATE scheduled_jobs SET status = 'cancelled'/)).toHaveLength(1);
    const again = await call('DELETE', `/api/mail/send/scheduled/${mine.id}`, { t: tok(SENDER) });
    expect([again.status, again.json.code, again.json.message]).toEqual([409, 'already_cancelled', expect.stringMatching(/already cancelled/)]);
    expect((await call('DELETE', `/api/mail/send/scheduled/${theirs.id}`, { t: tok(SENDER) })).status).toBe(404);
    expect((await call('DELETE', '/api/mail/send/scheduled/999', { t: tok(SENDER) })).status).toBe(404);
    expect((await call('DELETE', '/api/mail/send/scheduled/abc', { t: tok(SENDER) })).status).toBe(400);
    expect(theirs.status).toBe('pending');
    for (const [status, re] of [['running', /may already have gone/], ['completed', /already gone out/], ['failed', /already failed/]]) {
      const j = await schedule(tok(SENDER)); j.status = status;
      const x = await call('DELETE', `/api/mail/send/scheduled/${j.id}`, { t: tok(SENDER) });
      expect([status, x.status, x.json.code, x.json.message]).toEqual([status, 409, `already_${status}`, expect.stringMatching(re)]);
    }
    expect(audits().filter((s) => s === 'cancelled')).toHaveLength(1);
    expect(W.T.admin_audit_log.find((a) => a.status === 'cancelled').details).toEqual({ job_id: mine.id });
    // an SU cancels only their own too (the predicate names the user; no bypass)
    expect((await call('DELETE', `/api/mail/send/scheduled/${theirs.id}`, { t: tok(SU, 'authorized', ['su']), elevate: SU })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the mail_scheduled_send job (runScheduledSend through lib/job_executor)', () => {
  async function scheduled(over = {}, t = tok(SENDER)) {
    const r = await call('POST', '/api/mail/send/schedule', { t, body: MSG({ send_at: IN_1H(), ...over }) });
    expect(r.status).toBe(201);
    return W.T.scheduled_jobs.find((j) => j.id === r.json.job_id);
  }
  /** What routes/process_jobs.js hands executeJob: the claimed row. */
  const run = (job) => executeJob({ id: job.id, type: job.type, attempts: job.attempts || 0, max_attempts: job.max_attempts, scheduled_time: job.scheduled_time, data: job.data }, W.db);
  const clientSends = () => mockSendMail.mock.calls.filter((c) => /client@outside\.test/.test(c[0].to));
  const notices = () => mockSendMail.mock.calls.filter((c) => c[0].to === 'sender8@firm.test').map((c) => c[0]);
  const claims = () => W.T.request_idempotency.map((x) => [x.user_id, x.scope, x.idem_key, x.status]);
  /** The sender notice is fire-and-forget (users row → credential → adapter): let it land. Bounded. */
  const settle = () => new Promise((r) => setTimeout(r, 80));

  test('sends AS the sender behind the fence: one dispatch with the attachment, outcome sent on the row, the claim applied under scheduled:<id>; a re-run (the 15-minute sweep) REPLAYS — no second dispatch', async () => {
    const job = await scheduled({ attachments: [{ document_id: 1 }], case_id: 'CaseA1' });
    const out = await run(job);
    expect(out).toMatchObject({ state: 'sent', replayed: false, email_log_id: expect.any(Number), send_row_id: 1 });
    expect(clientSends()).toHaveLength(1);
    expect(clientSends()[0][0].attachments[0].filename).toBe('Document 1.pdf');
    expect(download).toHaveBeenCalledTimes(1); // fetched at send time, not at scheduling
    expect(jobData(job).outcome).toMatchObject({ state: 'sent', send_row_id: 1, provider_message_id: expect.any(String) });
    expect(claims()).toEqual([[SENDER, 'mail.send', `scheduled:${job.id}`, 'applied']]);
    expect(W.T.mail_sends[0]).toMatchObject({ user: SENDER, mailbox_id: 1, case_id: 'CaseA1' });
    // the sweep re-runs it: the fence replays, nothing leaves twice
    const again = await run(job);
    expect(again).toMatchObject({ state: 'sent', replayed: true, send_row_id: 1 });
    expect(clientSends()).toHaveLength(1);
    expect(W.T.mail_sends).toHaveLength(1);
    expect(alerts()).toEqual([]);
    expect(notices()).toEqual([]);
  });

  test('a stale in_flight claim (the instance died mid-send) → outcome unknown: nothing dispatched, the job throws, the sender is emailed and IT gets ONE error alert (dedup per job); a fresh in_flight claim is the same stop', async () => {
    const job = await scheduled();
    W.claim({ user_id: SENDER, scope: 'mail.send', idem_key: `scheduled:${job.id}`, updated_at: new Date(Date.now() - 200_000) });
    await expect(run(job)).rejects.toMatchObject({ idempotency: { outcome: 'unknown' } });
    await settle();
    expect(clientSends()).toEqual([]);
    expect(jobData(job).outcome).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    expect(alerts()).toEqual([['mail_scheduled_send_failed', 'error']]);
    const alert = W.T.system_alerts[0];
    expect(alert).toMatchObject({ dedup_key: `mail_scheduled_send_failed:${job.id}`, ref_table: 'scheduled_jobs', ref_id: job.id });
    expect(alert.message).toMatch(/may have been sent|unknown outcome/);
    expect(alert.message).not.toMatch(/client@outside/); // IT: counts and the reason, never the addresses
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ from: expect.stringMatching(/automations@firm\.test/), subject: expect.stringMatching(/may not have gone out: Hello/) });
    expect(notices()[0].html).toMatch(/client@outside\.test/);
    expect(notices()[0].html).toMatch(/Check the mailbox's Sent folder/);
    // a second run of the same job: still stopped, alert deduped, the sender told again
    await expect(run(job)).rejects.toMatchObject({ idempotency: { outcome: 'unknown' } });
    await settle();
    expect(alerts()).toHaveLength(1);
    expect(notices()).toHaveLength(2);
    expect(clientSends()).toEqual([]);
    // fresh in_flight (a sibling run still going): stop too — never a second dispatch
    const job2 = await scheduled();
    W.claim({ user_id: SENDER, scope: 'mail.send', idem_key: `scheduled:${job2.id}` });
    await expect(run(job2)).rejects.toMatchObject({ idempotency: { outcome: 'in_flight' } });
    expect(jobData(job2).outcome).toMatchObject({ state: 'unknown', outcome: 'in_flight' });
    expect(clientSends()).toEqual([]);
  });

  test('an applied claim with the job\'s own result (died between settle and the completed-mark) replays it — nothing dispatched', async () => {
    const job = await scheduled();
    W.claim({ user_id: SENDER, scope: 'mail.send', idem_key: `scheduled:${job.id}`, status: 'applied', result: { send_row_id: 77, email_log_id: 5, provider_message_id: '<x@relay>' } });
    const out = await run(job);
    expect(out).toMatchObject({ state: 'sent', replayed: true, send_row_id: 77, email_log_id: 5 });
    expect(clientSends()).toEqual([]);
    expect(jobData(job).outcome).toMatchObject({ state: 'sent', replayed: true, send_row_id: 77 });
  });

  test('a refusal at send time (the document deleted since; the daily budget spent) → outcome failed with the status, thrown, the sender emailed + ONE alert, the claim released', async () => {
    const job = await scheduled({ attachments: [{ document_id: 1 }] });
    W.T.documents.find((d) => d.id === 1).status = 'deleted';
    await expect(run(job)).rejects.toMatchObject({ status: 400 });
    await settle();
    expect(clientSends()).toEqual([]);
    expect(jobData(job).outcome).toMatchObject({ state: 'failed', status: 400, message: expect.stringMatching(/"Document 1\.pdf" has been deleted/) });
    expect(claims()).toEqual([]); // a pre-dispatch refusal gives the key back; the job is failed anyway (max_attempts 1)
    expect(alerts()).toEqual([['mail_scheduled_send_failed', 'error']]);
    expect(W.T.system_alerts[0].message).toMatch(/did not go out.*Document 1\.pdf/);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].subject).toMatch(/was NOT sent: Hello/);
    expect(notices()[0].html).toMatch(/Document 1\.pdf.*has been deleted/);
    expect(notices()[0].html).toMatch(/Nothing is retried automatically/);
    // the budget: spent between scheduling and sending
    const job2 = await scheduled();
    W.setting(sendSvc.BUDGET_SETTING, JSON.stringify({ smtp: 1 }));
    W.sent({ source: 'outbound-smtp', from_email: 'billing@firm.test' });
    await expect(run(job2)).rejects.toMatchObject({ status: 429 });
    expect(jobData(job2).outcome).toMatchObject({ state: 'failed', status: 429, code: 'SEND_BUDGET' });
    expect(clientSends()).toEqual([]);
  });

  test('a grant revoked between scheduling and sending fails the send — the job runs on the same seat', async () => {
    const job = await scheduled();
    W.T.channel_grants.length = 0;
    await expect(run(job)).rejects.toMatchObject({ status: 404 }); // cannot even read the box any more
    expect(clientSends()).toEqual([]);
    expect(jobData(job).outcome).toMatchObject({ state: 'failed', status: 404 });
  });

  test('the provider refuses (502) → failed, thrown, the claim KEPT; a re-run stops as unknown and never re-dispatches', async () => {
    const job = await scheduled();
    mockSendMail.mockImplementation(async (opts) => {
      if (/client@outside\.test/.test(opts.to)) throw new Error('451 4.3.0 try again later');
      return { messageId: opts.messageId || '<auto@relay>', response: '250 OK', accepted: [opts.to], rejected: [], envelope: {} };
    });
    await expect(run(job)).rejects.toMatchObject({ status: 502, code: 'SEND_FAILED' });
    await settle();
    expect(clientSends()).toHaveLength(1);
    expect(jobData(job).outcome).toMatchObject({ state: 'failed', status: 502, code: 'SEND_FAILED', message: expect.stringMatching(/451/) });
    expect(claims()).toEqual([[SENDER, 'mail.send', `scheduled:${job.id}`, 'in_flight']]); // may have gone: kept
    expect(notices()).toHaveLength(1);
    expect(notices()[0].subject).toMatch(/was NOT sent/);
    await expect(run(job)).rejects.toMatchObject({ idempotency: { outcome: 'in_flight' } });
    expect(clientSends()).toHaveLength(1); // exactly one attempt at the client, ever
    expect(alerts()).toHaveLength(1);
  });

  test('a job whose data names no user / mailbox, or another type, throws before anything runs', async () => {
    await expect(run({ id: 50, type: 'one_time', max_attempts: 1, data: JSON.stringify({ type: 'mail_scheduled_send', body: MSG() }) })).rejects.toThrow(/names no user/);
    await expect(sched.runScheduledSend(W.db, { id: 51, data: JSON.stringify({ type: 'mail_sent_read_seed', user: 8 }) })).rejects.toThrow(/not a scheduled-send job/);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(W.T.request_idempotency).toEqual([]);
  });

  test('a sender with no users.email: the alert still fires, the notice is skipped (never thrown)', async () => {
    W.setEmail(SENDER, null);
    const job = await scheduled({ attachments: [{ document_id: 1 }] });
    W.T.documents.find((d) => d.id === 1).status = 'deleted';
    await expect(run(job)).rejects.toMatchObject({ status: 400 });
    await settle();
    expect(alerts()).toEqual([['mail_scheduled_send_failed', 'error']]);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
