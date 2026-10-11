// tests/mailboxS3.transport.test.js
//
/**
 * Mailbox system S3 — imapTransport.appendSent / pickSentFolder, the module's
 * one writer. Run: npx jest tests/mailboxS3.transport.test.js
 *
 * The REAL transport against a fake ImapFlow injected through its `factory`
 * seam (CI has no IMAP server; tests/mailboxS3.dovecot.test.js runs the same
 * function against a real Dovecot, gated). What is locked:
 *   - NEVER APPEND TO GMAIL: an X-GM-EXT-1 server is refused before anything
 *     is listed or written (the second layer behind the send service's
 *     provider check).
 *   - The Sent folder: \Sent special-use first, else a Sent-ish leaf name;
 *     never a \Noselect one, never created.
 *   - APPEND flags the copy \Seen; the connection is always logged out; the
 *     secret never leaves in an error.
 *
 * Mutation-checked (worker run 2026-10-11 — each fails a test here):
 *   - the X-GM-EXT-1 interlock removed                → "Gmail: refused before LIST / APPEND"
 *   - special-use ignored (name match only)           → "the \\Sent flag wins over a name"
 *   - \Noselect not filtered                          → "never a \\Noselect folder"
 *   - ['\\Seen'] dropped from APPEND                  → "APPENDs flagged \\Seen"
 *   - logout dropped from the finally                → "always logged out" (and every appendSent test)
 *   - an APPEND error re-thrown unsanitized           → "comes back sanitized (no secret)"
 */

'use strict';

const { EventEmitter } = require('events');
const { encrypt } = require('../lib/credentialCrypto');
const T = require('../services/mailbox/imapTransport');

const SECRET = 'Pl@in-Secret-Zx9';
const ROW = { id: 1, address: 'billing@mdbl.test', imap_host: 'gcam1191.siteground.biz', imap_port: 993, imap_user: 'billing@mdbl.test', imap_secret: encrypt(SECRET) };
const RAW = Buffer.from('From: billing@mdbl.test\r\nTo: c@x.test\r\nSubject: s\r\nMessage-ID: <m@mdbl.test>\r\n\r\nbody\r\n');

class FakeClient extends EventEmitter {
  constructor(opts, script) { super(); this.opts = opts; this.script = script; this.calls = []; this.capabilities = new Map((script.caps || ['IMAP4rev1', 'SPECIAL-USE']).map((c) => [c, true])); }
  async connect() { this.calls.push(['connect']); if (this.script.connectError) throw this.script.connectError; }
  async list() { this.calls.push(['list']); return this.script.list || []; }
  async append(path, raw, flags, idate) {
    this.calls.push(['append', path, flags, idate instanceof Date]);
    if (this.script.appendError) throw this.script.appendError;
    return { destination: path, uid: 77, uidValidity: 5n };
  }
  async logout() { this.calls.push(['logout']); }
  close() { this.calls.push(['close']); }
}

let clients;
let script;
const origCreate = T.factory.create;
beforeEach(() => {
  clients = [];
  script = {};
  T.factory.create = (opts) => { const c = new FakeClient(opts, script); clients.push(c); return c; };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { T.factory.create = origCreate; jest.restoreAllMocks(); });

const L = (path, specialUse = null, flags = []) => ({ path, delimiter: '.', specialUse, flags: new Set(flags) });

describe('pickSentFolder', () => {
  test('the \\Sent flag wins over a name; else the SENT_NAMES order on the leaf; else null', () => {
    expect(T.pickSentFolder([L('INBOX'), L('INBOX.Sent Items'), L('INBOX.Outbox', '\\Sent')])).toBe('INBOX.Outbox');
    expect(T.pickSentFolder([L('INBOX'), L('INBOX.Sent Items'), L('INBOX.Sent')])).toBe('INBOX.Sent');
    expect(T.pickSentFolder([L('INBOX'), L('INBOX.SENT MESSAGES')])).toBe('INBOX.SENT MESSAGES');
    expect(T.pickSentFolder([{ path: '[Gmail]/Sent Mail', delimiter: '/', specialUse: null, flags: new Set() }])).toBe('[Gmail]/Sent Mail');
    expect(T.pickSentFolder([L('INBOX'), L('INBOX.Sentinel')])).toBeNull();
    expect(T.pickSentFolder(null)).toBeNull();
  });

  test('never a \\Noselect folder', () => {
    expect(T.pickSentFolder([L('Sent', '\\Sent', ['\\Noselect']), L('INBOX.Sent')])).toBe('INBOX.Sent');
    expect(T.pickSentFolder([L('Sent', '\\Sent', ['\\NonExistent'])])).toBeNull();
  });
});

describe('appendSent', () => {
  test('APPENDs to the Sent folder, flagged \\Seen, internal date now; always logged out', async () => {
    script.list = [L('INBOX', '\\Inbox'), L('INBOX.Sent', '\\Sent'), L('INBOX.Drafts', '\\Drafts')];
    const r = await T.appendSent(ROW, RAW);
    expect(r).toEqual({ appended: true, folder: 'INBOX.Sent', uid: 77, reason: null });
    expect(clients[0].calls).toEqual([['connect'], ['list'], ['append', 'INBOX.Sent', ['\\Seen'], true], ['logout']]);
    expect(clients[0].opts.auth).toEqual({ user: 'billing@mdbl.test', pass: SECRET });
    expect(clients[0].listenerCount('error')).toBe(1); // attached before connect (header: an unlistened 'error' crashes the process)
  });

  test('Gmail: refused before LIST / APPEND (Gmail files its own sends; a copy would double-store and double-emit)', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1'];
    script.list = [{ path: '[Gmail]/Sent Mail', delimiter: '/', specialUse: '\\Sent', flags: new Set() }];
    const r = await T.appendSent(ROW, RAW);
    expect(r).toEqual({ appended: false, folder: null, uid: null, reason: 'gmail_server' });
    expect(clients[0].calls).toEqual([['connect'], ['logout']]);
  });

  test('no Sent folder: nothing written, never created', async () => {
    script.list = [L('INBOX', '\\Inbox')];
    expect(await T.appendSent(ROW, RAW)).toEqual({ appended: false, folder: null, uid: null, reason: 'no_sent_folder' });
    expect(clients[0].calls.map((c) => c[0])).toEqual(['connect', 'list', 'logout']);
  });

  test('an APPEND error comes back sanitized (no secret) and the connection is still logged out', async () => {
    script.list = [L('INBOX.Sent', '\\Sent')];
    script.appendError = Object.assign(new Error(`NO quota exceeded for ${SECRET}`), { serverResponseCode: 'OVERQUOTA' });
    const err = await T.appendSent(ROW, RAW).catch((e) => e);
    expect(err.sanitized).toBe(true);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toMatch(/OVERQUOTA/);
    expect(clients[0].calls[clients[0].calls.length - 1]).toEqual(['logout']);
  });

  test('connect failure: sanitized, closed; a bad message or a missing secret never connects', async () => {
    script.connectError = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = await T.appendSent(ROW, RAW).catch((e) => e);
    expect([err.code, err.transient]).toEqual(['ECONNREFUSED', true]);
    expect(clients[0].calls).toEqual([['connect'], ['close']]);
    clients = [];
    await expect(T.appendSent(ROW, '')).rejects.toMatchObject({ code: 'BAD_MESSAGE' });
    await expect(T.appendSent({ ...ROW, imap_secret: null }, RAW)).rejects.toMatchObject({ code: 'NO_SECRET' });
    expect(clients).toEqual([]);
  });
});
