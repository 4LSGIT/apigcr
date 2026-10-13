// tests/mailboxS2P.send.test.js
//
/**
 * Mailbox S2P — the send side of the Comms polish slice:
 *   F.2  every successful hub send writes ONE mail_sends row in the
 *        best-effort tail; a failed insert never fails the send (one
 *        `warning` alert, dedup by the email_log id);
 *   G    the composer's Case field: case_id validated BEFORE dispatch (400,
 *        nothing leaves); a copy-will-be-stored send goes case_link_state
 *        'pending' + a 'mail_sent_case_link' job; a send whose copy will
 *        NEVER be stored gets its log row AT SEND (about = the case, by =
 *        the sender); a Gmail send with no provider id fails loudly instead
 *        of risking the §G.3 double log;
 *   job  linkSentCase: find-copy-FIRST (the seed's probe), caseLink as the
 *        sender; 409 retries; 403/404 and the final attempt are terminal
 *        (state 'failed' + ONE error alert); success stamps case_log_id.
 *
 * Harness: the S3 send harness (real routers over mailboxS3World, nodemailer
 * + Gmail API mocked at the transport edge, imapTransport.appendSent spied).
 *
 * Mutation-checked (break it, watch it fail — S2P worker report):
 *   - case existence checked after dispatch (or not at all)        → "unknown case is a 400 BEFORE dispatch"
 *   - the mail_sends insert dropped / made send-fatal              → attribution tests
 *   - the no-copy condition widened to gmail sends                 → "gmail + case → pending, never a send-time log row"
 *   - the send-time log row written when a copy WILL be stored     → same test (log row count)
 *   - the link job scheduled with the seed's 4 attempts            → job-row test (LINK_MAX_ATTEMPTS)
 *   - linkSentCase calling caseLink before the probe found a copy  → "copy not stored yet" test
 *   - 409 treated as final / 404 treated as a retry                → outcome tests
 *   - the final-attempt alert dropped / left at warning            → give-up tests
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2p-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s2p_internal';
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
const read = require('../services/mailbox/mailReadService');
const { executeJob } = require('../lib/job_executor');
const { encrypt } = require('../lib/credentialCrypto');
const mailRouter = require('../routes/api.mail');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(mailRouter);

const realFetch = global.fetch;
let gmailSendReply = () => ({ status: 200, body: { id: '1a2b3c4d5e6f7081', threadId: '1a2b3c4d5e6f7000', labelIds: ['SENT'] } });

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user) => jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', aud: 'staff' }, process.env.JWT_SECRET);
async function call(method, url, { t, body } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const SENDER = 8; // reader + sender of box 1 (smtp) and box 2 (gmail)
const SENT_ALL_MAIL = { '[Gmail]/All Mail': { emit_to_rules: true, backfill: false } };

function seed() {
  W = makeWorld();
  const cred = W.cred;
  W.cred = (id, over = {}) => cred(id, { smtp_pass: encrypt('smtp-pw'), ...over });
  W.user(SENDER, { roles: 'staff' });
  W.cred(1, { email: 'billing@firm.test', from_name: 'Firm Billing', smtp_user: 'billing@firm.test' });
  W.cred(2, { email: 'stuart@firm.test', from_name: 'Stuart S', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '' });
  // Box 1: smtp, polls INBOX only — an APPEND into INBOX.Sent is NEVER stored.
  W.mailbox(1, { address: 'billing@firm.test', display_name: 'Billing', send_credential_id: 1, imap_host: 'imap.firm.test', imap_port: 993,
    imap_user: 'billing@firm.test', imap_secret: 'ENCv1:secret', ingest_enabled: 1,
    ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: true } }) });
  // Box 2: gmail, polls All Mail — a send's copy WILL be stored (provider id key).
  W.mailbox(2, { address: 'stuart@firm.test', display_name: 'Stuart', send_credential_id: 2, imap_host: 'imap.gmail.com',
    imap_user: 'stuart@firm.test', imap_secret: 'ENCv1:g', ingest_enabled: 1, ingest_folders: JSON.stringify(SENT_ALL_MAIL),
    ingest_state: JSON.stringify({ '[Gmail]/All Mail': { uidvalidity: 12, last_uid: 5000 } }) });
  W.grant(SENDER, 1, { read: 1, send: 1 });
  W.grant(SENDER, 2, { read: 1, send: 1 });
  W.caseRow('CaseA1', '26-11111', '26-11111-tjt');
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed();
  mailRouter._resetSendRateLimit();
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async (opts) => ({
    messageId: opts.messageId || '<auto@relay>', response: '250 OK', accepted: [opts.to], rejected: [], envelope: {},
  }));
  gmailSendReply = () => ({ status: 200, body: { id: '1a2b3c4d5e6f7081', threadId: '1a2b3c4d5e6f7000', labelIds: ['SENT'] } });
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://gmail.googleapis.com/')) return realFetch(url, init);
    const r = /\/messages\/send$/.test(u) ? gmailSendReply() : { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  jest.spyOn(transport, 'appendSent').mockResolvedValue({ appended: true, folder: 'INBOX.Sent', uid: 9, reason: null });
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

const MSG = (over = {}) => ({ mailbox_id: 1, to: ['client@outside.test'], subject: 'Hello', body_text: 'Hi there', ...over });
const alerts = () => W.T.system_alerts.map((a) => [a.kind, a.severity]);
const linkJobs = () => W.T.scheduled_jobs.filter((j) => JSON.parse(j.data).type === 'mail_sent_case_link');

// ─────────────────────────────────────────────────────────────────────────────
describe('G — the Case field at send time', () => {
  test('an unknown case is a 400 BEFORE dispatch — nothing leaves, nothing is recorded', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ case_id: 'NOPE' }) });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/not a case/);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(W.T.mail_sends).toEqual([]);
    expect(W.T.log).toEqual([]);
  });

  test('a malformed case_id is a 400 from the body validator', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ case_id: 'bad id!' }) });
    expect(r.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('gmail + case → mail_sends pending + ONE mail_sent_case_link job; NEVER a send-time log row (§G.3)', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ mailbox_id: 2, case_id: 'CaseA1' }) });
    expect(r.status).toBe(200);
    expect(r.json.case_link).toEqual({ state: 'pending', job_id: expect.any(Number) });
    expect(W.T.log).toEqual([]); // the §G.3 hazard: the stored copy may emit — no send-time row
    expect(W.T.mail_sends).toHaveLength(1);
    expect(W.T.mail_sends[0]).toMatchObject({
      mailbox_id: 2, user: SENDER, provider_id: '1a2b3c4d5e6f7081', message_id: null,
      case_id: 'CaseA1', case_link_state: 'pending', case_log_id: null,
    });
    const jobs = linkJobs();
    expect(jobs).toHaveLength(1);
    expect([jobs[0].max_attempts, jobs[0].backoff_seconds]).toEqual([sendSvc.LINK_MAX_ATTEMPTS, sendSvc.LINK_BACKOFF_S]);
    const data = JSON.parse(jobs[0].data);
    expect(data).toMatchObject({ type: 'mail_sent_case_link', send_id: 1, user: SENDER, case_id: 'CaseA1', provider_id: '1a2b3c4d5e6f7081', message_id: null });
  });

  test('smtp whose APPEND lands in an UNPOLLED folder + case → the log row is written AT SEND (about = the case, by = the sender); state linked', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ case_id: 'CaseA1' }) });
    expect(r.status).toBe(200);
    expect(r.json.case_link.state).toBe('linked');
    expect(linkJobs()).toEqual([]); // no copy will ever be stored — nothing to wait for
    expect(W.T.log).toHaveLength(1);
    const lg = W.T.log[0];
    expect(lg).toMatchObject({ log_type: 'email', log_about_type: 'case', log_about_id: 'CaseA1', log_by: SENDER, log_direction: 'outgoing' });
    expect(lg.log_link_id).toBe('client@outside.test');
    expect(W.T.mail_sends[0]).toMatchObject({ case_link_state: 'linked', case_log_id: lg.log_id });
    expect(W.T.mail_sends[0].message_id).toMatch(/@firm\.test$/); // the smtp RFC id, brackets stripped
  });

  test('smtp whose APPEND lands in a POLLED folder + case → pending + job, no send-time log row', async () => {
    const b = W.T.mailboxes.find((x) => x.id === 1);
    b.ingest_folders = JSON.stringify({ INBOX: { emit_to_rules: true }, 'INBOX.Sent': { emit_to_rules: false } });
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ case_id: 'CaseA1' }) });
    expect(r.status).toBe(200);
    expect(r.json.case_link.state).toBe('pending');
    expect(W.T.log).toEqual([]);
    expect(linkJobs()).toHaveLength(1);
    expect(JSON.parse(linkJobs()[0].data).message_id).toBe(W.T.mail_sends[0].message_id);
  });

  test('a gmail send that returns NO provider id + case → failed + ONE error alert (never a send-time log row)', async () => {
    gmailSendReply = () => ({ status: 200, body: { labelIds: ['SENT'] } }); // no id
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ mailbox_id: 2, case_id: 'CaseA1' }) });
    expect(r.status).toBe(200); // the mail went out
    expect(r.json.case_link.state).toBe('failed');
    expect(W.T.log).toEqual([]);
    expect(linkJobs()).toEqual([]);
    expect(W.T.mail_sends[0]).toMatchObject({ case_link_state: 'failed', provider_id: null });
    expect(alerts()).toEqual([['mail_sent_case_link_failed', 'error']]);
  });

  test('no case asked → no link state, no job, no alert — just the attribution row', async () => {
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG() });
    expect(r.status).toBe(200);
    expect(r.json.case_link).toEqual({ state: null, job_id: null });
    expect(W.T.mail_sends[0]).toMatchObject({ case_id: null, case_link_state: null });
    expect(linkJobs()).toEqual([]);
    expect(alerts()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F.2 — the attribution row', () => {
  test('a failed mail_sends insert never fails the send: 200 + ONE warning alert, dedup by the email_log id', async () => {
    const q = W.db.query;
    W.db.query = async (sql, p) => {
      if (/^INSERT INTO mail_sends/.test(String(sql).replace(/\s+/g, ' ').trim())) throw new Error('boom');
      return q(sql, p);
    };
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG() });
    expect(r.status).toBe(200);
    expect(W.T.mail_sends).toEqual([]);
    const warn = W.T.system_alerts.find((a) => a.kind === 'mail_send_attribution_failed');
    expect(warn).toMatchObject({ severity: 'warning' });
    expect(warn.dedup_key).toMatch(/^mail_send_attribution_failed:log\d+$/);
  });

  test('…and when a case WAS asked (pending branch), the alert is an ERROR saying the link was lost (D3)', async () => {
    const q = W.db.query;
    W.db.query = async (sql, p) => {
      if (/^INSERT INTO mail_sends/.test(String(sql).replace(/\s+/g, ' ').trim())) throw new Error('boom');
      return q(sql, p);
    };
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ mailbox_id: 2, case_id: 'CaseA1' }) });
    expect(r.status).toBe(200);
    const a = W.T.system_alerts.find((x) => x.kind === 'mail_send_attribution_failed');
    expect(a.severity).toBe('error'); // a requested log entry will never be made
    expect(a.message).toMatch(/link it to case CaseA1.*NOT scheduled/);
    expect(linkJobs()).toEqual([]); // no row id to update → no job
  });

  test('…but in the NO-COPY branch the log row was already written at send: the alert stays a warning and says so (D3)', async () => {
    const q = W.db.query;
    W.db.query = async (sql, p) => {
      if (/^INSERT INTO mail_sends/.test(String(sql).replace(/\s+/g, ' ').trim())) throw new Error('boom');
      return q(sql, p);
    };
    const r = await call('POST', '/api/mail/send', { t: tok(SENDER), body: MSG({ case_id: 'CaseA1' }) }); // smtp, APPEND unpolled
    expect(r.status).toBe(200);
    expect(W.T.log).toHaveLength(1); // the send-time log row exists — only attribution was lost
    const a = W.T.system_alerts.find((x) => x.kind === 'mail_send_attribution_failed');
    expect(a.severity).toBe('warning');
    expect(a.message).toMatch(new RegExp(`case CaseA1 log entry was written at send \\(log ${W.T.log[0].log_id}\\)`));
    expect(a.message).not.toMatch(/NOT scheduled/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the mail_sent_case_link job (linkSentCase)', () => {
  /** A pending send row + its job data, as sendFromMailbox writes them. */
  function pendingSend(over = {}) {
    const id = W.send({ user: SENDER, mailbox_id: 2, provider_id: 'abc123', case_id: 'CaseA1', case_link_state: 'pending', sent_at: new Date(), ...over });
    const row = W.T.mail_sends.find((s) => s.id === id);
    return { send_id: id, user: SENDER, mailbox_id: row.mailbox_id, case_id: row.case_id, sent_at: new Date().toISOString(), provider_id: row.provider_id, message_id: row.message_id };
  }

  test('copy not stored yet → THROWS (the job retries); on the final attempt → failed + ONE error alert', async () => {
    const data = pendingSend();
    await expect(sendSvc.linkSentCase(W.db, data, { final: false })).rejects.toThrow(/not stored yet/);
    expect(W.T.mail_sends[0].case_link_state).toBe('pending'); // untouched — it will retry
    const out = await sendSvc.linkSentCase(W.db, data, { final: true });
    expect(out).toMatchObject({ linked: false, gave_up: true });
    expect(W.T.mail_sends[0].case_link_state).toBe('failed');
    expect(alerts()).toEqual([['mail_sent_case_link_failed', 'error']]);
  });

  test('find-copy-FIRST, then caseLink as the sender: a stored store-only copy past the grace links and stamps case_log_id', async () => {
    const data = pendingSend();
    // the copy: stored in the parent box, store-only (uid below the cursor is
    // irrelevant — All Mail emits, so make it an OLD row below last_uid with
    // a live prior execution? No: simplest true-success path is a copy whose
    // emission already happened and logged nothing… use a NON-emitting box:
    // repoint the send at box 1 (polls INBOX only; copy in INBOX.Sent).
    W.T.mail_sends[0].mailbox_id = 1;
    W.T.mail_sends[0].provider_id = null;
    W.T.mail_sends[0].message_id = 'sent-copy@firm.test';
    data.mailbox_id = 1; data.provider_id = null; data.message_id = 'sent-copy@firm.test';
    W.message(900, { mailbox_id: 1, folder: 'INBOX.Sent', uid: 900, message_id: 'sent-copy@firm.test',
      from_addr: 'billing@firm.test', to_addrs: 'client@outside.test', subject: 'Hello',
      date: new Date(Date.now() - 3600_000), ingested_at: new Date(Date.now() - 3600_000) }); // past the 10-min grace
    const out = await sendSvc.linkSentCase(W.db, data, { final: false });
    expect(out).toMatchObject({ linked: true, message_fk: 900 });
    expect(W.T.mail_sends[0]).toMatchObject({ case_link_state: 'linked', case_log_id: out.log_id });
    const lg = W.T.log.find((l) => l.log_id === out.log_id);
    expect(lg).toMatchObject({ log_about_type: 'case', log_about_id: 'CaseA1', log_by: SENDER });
    expect(W.T.mail_messages.find((m) => m.id === 900).log_id).toBe(out.log_id); // caseLink stamped the copy
    expect(alerts()).toEqual([]);
  });

  test('caseLink 409 (store-only grace still open) → retry; 403/404 (revoked between send and run) → terminal', async () => {
    const data = pendingSend();
    W.T.mail_sends[0].mailbox_id = 1;
    W.T.mail_sends[0].provider_id = null;
    W.T.mail_sends[0].message_id = 'fresh@firm.test';
    data.mailbox_id = 1; data.provider_id = null; data.message_id = 'fresh@firm.test';
    // a copy stored seconds ago in a store-only folder: caseLink answers 409
    W.message(901, { mailbox_id: 1, folder: 'INBOX.Sent', uid: 901, message_id: 'fresh@firm.test',
      from_addr: 'billing@firm.test', to_addrs: 'client@outside.test',
      date: new Date(), ingested_at: new Date() });
    await expect(sendSvc.linkSentCase(W.db, data, { final: false })).rejects.toMatchObject({ status: 409 });
    expect(W.T.mail_sends[0].case_link_state).toBe('pending');
    // a 404 from caseLink (the probe found the copy, the grant died between) is FINAL even off the last attempt
    const spy = jest.spyOn(read, 'caseLink').mockRejectedValue(Object.assign(new Error('Message not found'), { status: 404 }));
    const out = await sendSvc.linkSentCase(W.db, data, { final: false });
    spy.mockRestore();
    expect(out).toMatchObject({ linked: false, gave_up: true, reason: expect.stringMatching(/revoked/) });
    expect(W.T.mail_sends[0].case_link_state).toBe('failed');
    expect(alerts()).toEqual([['mail_sent_case_link_failed', 'error']]);
  });

  test('a revoked READ scope is terminal before any probe; a row no longer pending is a no-op', async () => {
    const data = pendingSend();
    W.T.channel_grants.length = 0; // every grant gone
    const out = await sendSvc.linkSentCase(W.db, data, { final: false });
    expect(out).toMatchObject({ linked: false, gave_up: true, reason: expect.stringMatching(/no longer read/) });
    expect(W.T.mail_sends[0].case_link_state).toBe('failed');
    // already linked / failed rows are left alone
    const again = await sendSvc.linkSentCase(W.db, data, { final: true });
    expect(again).toMatchObject({ linked: false, skipped: expect.stringMatching(/failed/) });
    expect(alerts()).toHaveLength(1); // no second alert
  });

  test('job_executor routes the type and computes `final` from attempts vs max_attempts', async () => {
    const spy = jest.spyOn(sendSvc, 'linkSentCase').mockResolvedValue({ linked: true });
    await executeJob({ id: 1, attempts: 0, max_attempts: 6, data: JSON.stringify({ type: 'mail_sent_case_link', send_id: 9 }) }, W.db);
    await executeJob({ id: 1, attempts: 5, max_attempts: 6, data: JSON.stringify({ type: 'mail_sent_case_link', send_id: 9 }) }, W.db);
    expect(spy.mock.calls.map((c) => c[2])).toEqual([{ final: false }, { final: true }]);
    spy.mockRestore();
  });
});
