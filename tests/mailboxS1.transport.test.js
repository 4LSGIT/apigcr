// tests/mailboxS1.transport.test.js
//
/**
 * Mailbox system S1 — services/mailbox/imapTransport.js.
 * Run: npx jest tests/mailboxS1.transport.test.js
 *
 * The REAL transport runs against a fake ImapFlow client injected through
 * its `factory` seam (CI has no IMAP server). The fake records every option
 * and call, and reproduces the server behaviours that matter: BigInt
 * UIDVALIDITY, the `UID n:*` top-message quirk, unsolicited FETCH rows,
 * `{}` for a vanished message, and EventEmitter 'error' semantics (an
 * unlistened 'error' THROWS). The same code ran against a real Dovecot IMAPS
 * server in the worker's verification (S1 report).
 *
 * Mutation-checked:
 *   - client.on('error') removed            → "an 'error' after connect does not throw"
 *   - readOnly dropped from mailboxOpen      → "folders are EXAMINEd, never SELECTed"
 *   - scrub() bypassed                       → "the secret never leaves in an error"
 *   - n:* filter removed from searchUids     → "UID n:* top-message quirk"
 *   - message-id identity check removed      → "fetchPart refuses a different message at the UID"
 */

'use strict';

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { encrypt } = require('../lib/credentialCrypto');
const T = require('../services/mailbox/imapTransport');

const SECRET = 'Pl@in-Secret-Zx9';
const USER = 'billing@4lsg.com';
const row = (over = {}) => ({
  id: 7, address: USER, imap_host: 'gcam1191.siteground.biz', imap_port: 993, imap_user: USER,
  imap_secret: encrypt(SECRET), ingest_state: null, ...over,
});

class FakeClient extends EventEmitter {
  constructor(opts, script) {
    super();
    this.opts = opts;
    this.script = script;
    this.calls = [];
    this.errorListenersAtConnect = null;
  }
  async connect() {
    this.calls.push(['connect']);
    this.errorListenersAtConnect = this.listenerCount('error');
    if (this.script.connectError) throw this.script.connectError;
  }
  async mailboxOpen(path, opts) {
    this.calls.push(['mailboxOpen', path, opts]);
    return { path, uidValidity: this.script.uidValidity ?? 4242n, uidNext: 10, exists: 3 };
  }
  async search(q, opts) {
    this.calls.push(['search', q, opts]);
    return this.script.search ? this.script.search(q) : [];
  }
  async *fetch(range, query, opts) {
    this.calls.push(['fetch', range, query, opts]);
    for (const m of this.script.envelopes || []) yield m;
  }
  async fetchAll(range, query, opts) {
    this.calls.push(['fetchAll', range, query, opts]);
    if (this.script.fetchAllError) throw this.script.fetchAllError;
    return this.script.rows || [];
  }
  async fetchOne(uid, query, opts) {
    this.calls.push(['fetchOne', uid, query, opts]);
    return this.script.fetchOne === undefined ? { uid: Number(uid), envelope: { messageId: '<m@x>' } } : this.script.fetchOne;
  }
  async download(uid, part, opts) {
    this.calls.push(['download', uid, part, opts]);
    const d = this.script.download ? this.script.download(uid, part) : null;
    return d || {};
  }
  async logout() { this.calls.push(['logout']); if (this.script.logoutError) throw this.script.logoutError; }
  close() { this.calls.push(['close']); }
}

let clients;
let script;
const realCreate = T.factory.create;
beforeEach(() => {
  clients = [];
  script = {};
  T.factory.create = (opts) => { const c = new FakeClient(opts, script); clients.push(c); return c; };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { T.factory.create = realCreate; jest.restoreAllMocks(); });

const textStream = (s) => Readable.from([Buffer.from(s, 'utf8')]);

// ─────────────────────────────────────────────────────────────────────────────

describe('connection', () => {
  test('TLS always: 993 implicit, 143 mandatory STARTTLS; imapflow logging off; no auto-IDLE', async () => {
    await T.withMailbox(row(), async () => {});
    await T.withMailbox(row({ imap_port: 143 }), async () => {});
    const [a, b] = clients.map(c => c.opts);
    expect(a).toMatchObject({ host: 'gcam1191.siteground.biz', port: 993, secure: true, logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true });
    expect(b).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
    for (const o of [a, b]) {
      expect(o.tls).toMatchObject({ minVersion: 'TLSv1.2' });
      expect(o.tls.rejectUnauthorized).toBeUndefined();
      expect(o.auth).toEqual({ user: USER, pass: SECRET }); // decrypted only into the client
    }
  });

  test("an 'error' listener is attached before connect, so an 'error' after connect does not throw", async () => {
    await T.withMailbox(row(), async () => {
      expect(clients[0].errorListenersAtConnect).toBeGreaterThan(0);
      expect(() => clients[0].emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).not.toThrow();
    });
  });

  test('always logs out, even when the callback throws; a failing logout falls back to close()', async () => {
    await expect(T.withMailbox(row(), async () => { throw new Error('worker bug'); })).rejects.toThrow('worker bug');
    expect(clients[0].calls.map(c => c[0])).toEqual(['connect', 'logout']);
    script.logoutError = new Error('BYE');
    await T.withMailbox(row(), async () => 'ok');
    expect(clients[1].calls.map(c => c[0])).toEqual(['connect', 'logout', 'close']);
  });

  test('missing or undecryptable secret: typed errors, no connection attempted', async () => {
    await expect(T.withMailbox(row({ imap_secret: null }), async () => {})).rejects.toMatchObject({ code: 'NO_SECRET' });
    await expect(T.withMailbox(row({ imap_secret: 'ENCv1:garbage' }), async () => {})).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    expect(clients).toEqual([]);
  });
});

describe('secrets never leave the module', () => {
  const sasl = Buffer.from(`\u0000${USER}\u0000${SECRET}`).toString('base64');
  const forms = [SECRET, Buffer.from(SECRET).toString('base64'), sasl];

  test('the secret never leaves in an error: connect failure is rebuilt and scrubbed', async () => {
    const raw = Object.assign(new Error(`AUTHENTICATE PLAIN ${sasl} failed for ${SECRET}`), {
      authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED',
      responseText: `bad pass ${SECRET}`, response: { attributes: [{ value: SECRET }] },
    });
    script.connectError = raw;
    let caught;
    try { await T.withMailbox(row(), async () => {}); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught).not.toBe(raw);
    expect(caught.code).toBe('AUTHENTICATIONFAILED');
    expect(caught.authFailed).toBe(true);
    expect(caught.response).toBeUndefined();
    const dump = JSON.stringify({ m: caught.message, s: caught.stack, ...caught });
    for (const f of forms) expect(dump).not.toContain(f);
    expect(caught.message).toContain('[REDACTED]');
    expect(clients[0].calls.map(c => c[0])).toContain('close');
  });

  test('session-method errors are scrubbed too', async () => {
    script.fetchAllError = Object.assign(new Error(`boom ${SECRET}`), { code: 'ParserError3' });
    await T.withMailbox(row(), async (s) => {
      await s.openFolder('INBOX');
      const e = await s.fetchMessages([1]).catch(x => x);
      expect(e.code).toBe('ParserError3');
      expect(e.message).not.toContain(SECRET);
    });
  });

  test('transient classification', () => {
    expect(T.sanitizeError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).transient).toBe(true);
    expect(T.sanitizeError(Object.assign(new Error('x'), { authenticationFailed: true })).transient).toBe(false);
  });
});

describe('session facade', () => {
  test('folders are EXAMINEd, never SELECTed; UIDVALIDITY comes back a Number', async () => {
    await T.withMailbox(row(), async (s) => {
      const box = await s.openFolder('INBOX.Sent');
      expect(box).toEqual({ uidValidity: 4242, uidNext: 10, exists: 3 });
      expect(typeof box.uidValidity).toBe('number');
    });
    const open = clients[0].calls.find(c => c[0] === 'mailboxOpen');
    expect(open[2]).toEqual({ readOnly: true });
  });

  test('UID n:* top-message quirk: results are bounded to the requested range', async () => {
    // Server answers `UID 8:*` with the highest message (uid 7) when nothing is ≥ 8.
    script.search = (q) => (q.uid === '8:*' ? [7] : q.uid === '1:4' ? [4, 2, 2, 9] : []);
    await T.withMailbox(row(), async (s) => {
      await s.openFolder('INBOX');
      expect(await s.searchUids(8)).toEqual([]);
      expect(await s.searchUids(1, 4)).toEqual([2, 4]);
      expect(await s.searchUids(5, 4)).toEqual([]);
    });
    const searches = clients[0].calls.filter(c => c[0] === 'search');
    expect(searches.map(c => [c[1], c[2]])).toEqual([[{ uid: '8:*' }, { uid: true }], [{ uid: '1:4' }, { uid: true }]]);
  });

  test('fetchMessages: text parts only (attachments are never downloaded), unsolicited rows dropped', async () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'multipart/alternative', childNodes: [
          { part: '1.1', type: 'text/plain', size: 10 },
          { part: '1.2', type: 'text/html', size: 20 },
        ] },
        { part: '2', type: 'application/pdf', size: 900, disposition: 'attachment', dispositionParameters: { filename: 'Petition.pdf' } },
      ],
    };
    script.rows = [
      { uid: 5, size: 1200, flags: new Set(['\\Seen', '\\Recent', '\\Flagged']), internalDate: new Date('2026-10-01T00:00:00Z'),
        envelope: { messageId: '<m5@x>', subject: 'Hi', date: new Date('2026-10-01T00:00:00Z'), from: [{ name: 'A', address: 'a@x' }] },
        bodyStructure: structure, headers: Buffer.from('Message-ID: <m5@x>\r\n') },
      { uid: 99, envelope: {}, bodyStructure: { type: 'text/plain' } }, // unsolicited
    ];
    script.download = (uid, part) => ({
      meta: { contentType: part === '1.1' ? 'text/plain' : 'text/html' },
      content: textStream(part === '1.1' ? 'plain body' : '<p>html</p>'),
    });
    let out;
    await T.withMailbox(row(), async (s) => { await s.openFolder('INBOX'); out = await s.fetchMessages([5]); });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      uid: 5, size: 1200, flags: ['seen', 'flagged'], text: 'plain body', html: '<p>html</p>',
      envelope: { messageId: 'm5@x', subject: 'Hi' },
      attachments: [{ part: '2', filename: 'Petition.pdf', size: 900, mime: 'application/pdf' }],
    });
    const fa = clients[0].calls.find(c => c[0] === 'fetchAll');
    expect(fa[1]).toBe('5');
    expect(fa[2]).toMatchObject({ envelope: true, bodyStructure: true, flags: true, headers: true, size: true, internalDate: true });
    expect(fa[2].source).toBeUndefined();
    const downloads = clients[0].calls.filter(c => c[0] === 'download');
    expect(downloads.map(c => c[2])).toEqual(['1.1', '1.2']);
    for (const d of downloads) expect(d[3]).toEqual({ uid: true, maxBytes: T.limits.maxBodyBytes });
  });

  test('listMessageIds normalizes Message-IDs for the re-key', async () => {
    script.envelopes = [{ uid: 2, envelope: { messageId: '<b@x>' } }, { uid: 1, envelope: { messageId: ' <a@x> ' } }, { uid: 3, envelope: {} }];
    await T.withMailbox(row(), async (s) => {
      await s.openFolder('INBOX');
      expect(await s.listMessageIds()).toEqual([{ uid: 1, messageId: 'a@x' }, { uid: 2, messageId: 'b@x' }, { uid: 3, messageId: null }]);
    });
  });
});

describe('analyzeStructure', () => {
  test('body = first non-attachment text/plain + text/html; everything else listed; message/rfc822 not descended', () => {
    const st = T.analyzeStructure({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'multipart/related', childNodes: [
          { part: '1.1', type: 'text/html' },
          { part: '1.2', type: 'image/png', id: '<logo@x>', disposition: 'inline', size: 12 },
        ] },
        { part: '2', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' }, size: 5 },
        { part: '3', type: 'message/rfc822', size: 100, childNodes: [{ part: '3', type: 'text/plain' }] },
        { part: '4', type: 'text/calendar', parameters: { name: 'invite.ics' }, size: 7 },
        { part: '5', type: 'text/plain', size: 3 },
      ],
    });
    expect(st.textPart).toBe('5');
    expect(st.htmlPart).toBe('1.1');
    expect(st.attachments).toEqual([
      { part: '1.2', filename: null, size: 12, mime: 'image/png', cid: 'logo@x' },
      { part: '2', filename: 'notes.txt', size: 5, mime: 'text/plain' },
      { part: '3', filename: null, size: 100, mime: 'message/rfc822' },
      { part: '4', filename: 'invite.ics', size: 7, mime: 'text/calendar' },
    ]);
  });

  test('single-part messages: the root is part "1"', () => {
    expect(T.analyzeStructure({ type: 'text/html' })).toEqual({ textPart: null, htmlPart: '1', attachments: [] });
    expect(T.analyzeStructure({ type: 'application/pdf', size: 4 }).attachments).toEqual([{ part: '1', filename: null, size: 4, mime: 'application/pdf' }]);
  });
});

describe('fetchPart', () => {
  test('streams the part after verifying UIDVALIDITY and the Message-ID; closes when the stream ends', async () => {
    script.fetchOne = { uid: 5, envelope: { messageId: '<m5@x>' } };
    script.download = () => ({ meta: { contentType: 'application/pdf', filename: 'P.pdf' }, content: Readable.from([Buffer.from('%PDF')]) });
    const got = await T.fetchPart(row(), 'INBOX', 5, '2', { uidValidity: 4242, messageId: 'm5@x' });
    expect(got).toMatchObject({ mime: 'application/pdf', filename: 'P.pdf' });
    let bytes = '';
    for await (const c of got.stream) bytes += c.toString();
    expect(bytes).toBe('%PDF');
    await new Promise(r => setImmediate(r));
    const calls = clients[0].calls.map(c => c[0]);
    expect(calls).toEqual(['connect', 'mailboxOpen', 'fetchOne', 'download', 'logout']);
    expect(clients[0].calls[1][2]).toEqual({ readOnly: true });
  });

  test('stale UIDVALIDITY → UIDVALIDITY_MISMATCH, nothing downloaded, connection closed', async () => {
    await expect(T.fetchPart(row(), 'INBOX', 5, '2', { uidValidity: 1, messageId: 'm5@x' })).rejects.toMatchObject({ code: 'UIDVALIDITY_MISMATCH' });
    expect(clients[0].calls.map(c => c[0])).not.toContain('download');
    await new Promise(r => setImmediate(r));
    expect(clients[0].calls.map(c => c[0])).toContain('logout');
  });

  test('fetchPart refuses a different message at the UID', async () => {
    script.fetchOne = { uid: 5, envelope: { messageId: '<someone-else@x>' } };
    await expect(T.fetchPart(row(), 'INBOX', 5, '2', { uidValidity: 4242, messageId: 'm5@x' })).rejects.toMatchObject({ code: 'MESSAGE_MISMATCH' });
    expect(clients[0].calls.map(c => c[0])).not.toContain('download');
  });

  test('a vanished message or part → null', async () => {
    script.fetchOne = false;
    expect(await T.fetchPart(row(), 'INBOX', 5, '2', { uidValidity: 4242, messageId: 'm5@x' })).toBeNull();
    script.fetchOne = { uid: 5, envelope: { messageId: '<m5@x>' } };
    script.download = () => null; // imapflow answers {}
    expect(await T.fetchPart(row(), 'INBOX', 5, '2', { uidValidity: 4242, messageId: 'm5@x' })).toBeNull();
  });
});
