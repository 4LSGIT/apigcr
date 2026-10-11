// tests/mailboxS3.dovecot.test.js
//
/**
 * REAL-ENGINE proof for mailbox S3: a hub reply threads into its parent's
 * conversation THROUGH THE REAL thread_key DERIVATION, and the Sent APPEND
 * lands on a real IMAP server. Run against a throwaway Dovecot (IMAPS):
 *
 * ── GATED ON YC_TEST_IMAP_HOST — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_IMAP_HOST=localhost YC_TEST_IMAP_PORT=19930 \
 *   YC_TEST_IMAP_USER=pilot@firm.test YC_TEST_IMAP_PASS=… \
 *   YC_TEST_IMAP_USER2=nosent@firm.test   # a second, empty account (the recipient)
 *   NODE_EXTRA_CA_CERTS=/path/to/the/test/cert.pem \
 *   npx jest tests/mailboxS3.dovecot.test.js
 * The accounts must be THROWAWAY: the suite appends to INBOX and the Sent
 * folder and reads them back. Dovecot as SiteGround runs it: namespace prefix
 * "INBOX." with separator "." and the Sent folder flagged \Sent. Worker run
 * 2026-10-11: Dovecot 2.3.21, all green.
 *
 * The chain under test, end to end:
 *   a three-message thread APPENDed to INBOX → imapTransport.fetchMessages →
 *   mailboxIngestService.buildRow (the worker's derivation) → the stored rows;
 *   mailboxSendService.threadingFor(parent row) → the reply's headers;
 *   (a) compileMessage → imapTransport.appendSent → INBOX.Sent → fetch →
 *       buildRow: thread_key = the parent's; \Seen; Bcc kept on the copy;
 *   (b) the SMTP adapter's real MIME (nodemailer stream transport) and
 *   (c) the Gmail adapter's real MIME (MailComposer, fetch mocked), each
 *       delivered to a second mailbox's INBOX → fetch → buildRow: the same
 *       thread_key (Gmail rewrites the Message-ID, never References).
 * The parent is three deep (root → r2 → r3), so the root differs from its
 * In-Reply-To and a References chain in the wrong order cannot pass.
 * Mutation-checked here (worker report 2026-10-11): threadingFor with the
 * parent's id first, with its In-Reply-To first, or without the root — each
 * makes the reply's derived thread_key something other than the root.
 */

'use strict';

const HOST = process.env.YC_TEST_IMAP_HOST;
const maybe = HOST ? describe : describe.skip;

jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  // The SMTP adapter "sends" through a stream transport: the real MIME, no relay.
  return { ...actual, createTransport: jest.fn(() => actual.createTransport({ streamTransport: true, buffer: true })) };
});
jest.mock('../lib/credentialInjection', () => {
  const actual = jest.requireActual('../lib/credentialInjection');
  return { ...actual, buildHeadersForCredential: jest.fn(async () => ({ Authorization: 'Bearer t' })), loadCredential: jest.fn(async (db, id) => ({ id, type: 'oauth2', name: 'G' })) };
});

maybe('mailbox S3 on a real IMAP server', () => {
  const { ImapFlow } = require('imapflow');
  const { encrypt } = require('../lib/credentialCrypto');
  const T = require('../services/mailbox/imapTransport');
  const { buildRow } = require('../services/mailbox/mailboxIngestService');
  const S = require('../services/mailbox/mailboxSendService');
  const smtp = require('../services/adapters/email/smtp');
  const gmail = require('../services/adapters/email/gmail');

  const PORT = Number(process.env.YC_TEST_IMAP_PORT) || 993;
  const acct = (user) => ({ id: 1, address: user, imap_host: HOST, imap_port: PORT, imap_user: user, imap_secret: encrypt(process.env.YC_TEST_IMAP_PASS) });
  // Built in beforeAll: describe.skip still runs this body (collection), and
  // there is no secret to encrypt when the suite is skipped.
  let ROW;
  let ROW2;
  const RUN = `${Date.now()}`;
  const ROOT = `root-${RUN}@x.test`;
  const MID = `r2-${RUN}@x.test`;
  const MID3 = `r3-${RUN}@x.test`; // the parent: three deep, so root ≠ its In-Reply-To

  async function raw(client, folder, text) {
    await client.append(folder, Buffer.from(text.replace(/\n/g, '\r\n')), [], new Date());
  }
  async function direct(row, fn) {
    const c = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: { user: row.imap_user, pass: process.env.YC_TEST_IMAP_PASS }, logger: false });
    await c.connect();
    try { return await fn(c); } finally { await c.logout(); }
  }
  /** The worker's own read + derivation: every message of `folder` → mail_messages rows (+ flags). */
  async function ingest(row, folder) {
    return T.withMailbox(row, async (s) => {
      await s.openFolder(folder);
      const uids = await s.searchUids(1);
      const msgs = await s.fetchMessages(uids);
      return msgs.map((m) => ({ ...buildRow(1, folder, m), flagsList: m.flags, headerBlock: m.headerBlock }));
    });
  }

  let parent;
  beforeAll(async () => {
    ROW = acct(process.env.YC_TEST_IMAP_USER);
    ROW2 = acct(process.env.YC_TEST_IMAP_USER2 || process.env.YC_TEST_IMAP_USER);
    await direct(ROW, async (c) => {
      await raw(c, 'INBOX', `From: Client <client@outside.test>\nTo: ${ROW.address}\nSubject: Plan objection ${RUN}\nMessage-ID: <${ROOT}>\nDate: Thu, 08 Oct 2026 14:00:00 +0000\n\nfirst\n`);
      await raw(c, 'INBOX', `From: Client <client@outside.test>\nTo: ${ROW.address}\nSubject: Re: Plan objection ${RUN}\nMessage-ID: <${MID}>\nIn-Reply-To: <${ROOT}>\nReferences: <${ROOT}>\nDate: Thu, 08 Oct 2026 14:05:00 +0000\n\nsecond\n`);
      await raw(c, 'INBOX', `From: Client <client@outside.test>\nTo: ${ROW.address}\nSubject: Re: Plan objection ${RUN}\nMessage-ID: <${MID3}>\nIn-Reply-To: <${MID}>\nReferences: <${ROOT}> <${MID}>\nDate: Thu, 08 Oct 2026 14:09:00 +0000\n\nthird\n`);
    });
    const rows = await ingest(ROW, 'INBOX');
    parent = rows.find((r) => r.message_id === MID3);
    expect(parent).toBeTruthy();
    expect([parent.thread_key, parent.in_reply_to]).toEqual([ROOT, MID]); // the worker's derivation on the parent
  }, 60_000);

  test('(a) the APPENDed Sent copy: same thread_key as its parent, \\Seen, Bcc kept, in the \\Sent folder', async () => {
    const th = S.threadingFor({ ...parent, id: 102 });
    const rfc = `hub-${RUN}@firm.test`;
    const mime = await S.compileMessage({
      from: `"Billing" <${ROW.address}>`, to: 'client@outside.test', bcc: 'hidden@outside.test',
      subject: S.reSubject(parent.subject), text: 'Thanks', html: '<p>Thanks</p>', messageId: `<${rfc}>`, date: new Date(),
      inReplyTo: th.inReplyTo, references: th.references,
    });
    const r = await T.appendSent(ROW, mime);
    expect(r).toMatchObject({ appended: true, folder: 'INBOX.Sent', reason: null });
    const sent = (await ingest(ROW, 'INBOX.Sent')).find((x) => x.message_id === rfc);
    expect(sent.thread_key).toBe(parent.thread_key);
    expect(sent.in_reply_to).toBe(MID3);
    expect(sent.subject).toBe(`Re: Plan objection ${RUN}`);
    expect(sent.flagsList).toContain('seen');
    expect(sent.headerBlock).toMatch(/^Bcc: hidden@outside\.test/m);
  }, 60_000);

  test('(b) the SMTP adapter\'s real message, as a recipient\'s mailbox stores it: the same thread', async () => {
    const th = S.threadingFor(parent);
    const rfc = `smtp-${RUN}@firm.test`;
    const info = await smtp.sendEmail({ query: async () => [[]] }, {
      from: ROW.address, fromName: 'Billing', to: ROW2.address, subject: `Re: Plan objection ${RUN}`, text: 'Thanks', html: '<p>Thanks</p>',
      emailRow: { id: 1, smtp_pass: encrypt('x') }, inReplyTo: th.inReplyTo, references: th.references, messageId: `<${rfc}>`,
    });
    await direct(ROW2, (c) => c.append('INBOX', info.message, [], new Date()));
    const got = (await ingest(ROW2, 'INBOX')).find((x) => x.message_id === rfc);
    expect(got.thread_key).toBe(ROOT);
  }, 60_000);

  test('(c) the Gmail adapter\'s real message (Gmail keeps References): the same thread', async () => {
    const th = S.threadingFor(parent);
    let sentRaw = null;
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      sentRaw = Buffer.from(JSON.parse(init.body).raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      return new Response(JSON.stringify({ id: '1a2b', threadId: '1a00' }), { status: 200 });
    });
    try {
      await gmail.sendEmail({ query: async () => [[]] }, {
        from: ROW.address, fromName: 'S', to: ROW2.address, subject: `Re: Plan objection ${RUN}`, text: 'Yes', html: '<p>Yes</p>',
        credential: { id: 11, type: 'oauth2', name: 'G' }, emailRow: { id: 1 }, inReplyTo: th.inReplyTo, references: th.references,
      });
    } finally { global.fetch = realFetch; }
    // Gmail would swap the Message-ID for its own; References / In-Reply-To are what thread it.
    const rewritten = sentRaw.toString('utf8').replace(/^Message-ID: <[^>]+>/m, `Message-ID: <CAgmail-${RUN}@mail.gmail.com>`);
    await direct(ROW2, (c) => c.append('INBOX', Buffer.from(rewritten), [], new Date()));
    const got = (await ingest(ROW2, 'INBOX')).find((x) => x.message_id === `CAgmail-${RUN}@mail.gmail.com`);
    expect(got.thread_key).toBe(ROOT);
  }, 60_000);
});
