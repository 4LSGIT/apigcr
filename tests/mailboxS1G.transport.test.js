// tests/mailboxS1G.transport.test.js
//
/**
 * Mailbox system S1-G — provider ids and the folder listing in
 * services/mailbox/imapTransport.js. Run: npx jest tests/mailboxS1G.transport.test.js
 *
 * Two layers:
 *   1. THE LIBRARY PIN. The slice rests on imapflow 2.3.0 asking for
 *      X-GM-MSGID unprompted on X-GM-EXT-1 servers and surfacing it as
 *      `emailId` — and on it asking for RFC 8474 EMAILID INSTEAD when the
 *      server also advertises OBJECTID. Both are driven here through
 *      imapflow's REAL fetch command + REAL wire compiler + REAL response
 *      parser (only the socket is replaced), so an imapflow upgrade that
 *      changes either breaks this file, not production.
 *   2. THE TRANSPORT, against a fake ImapFlow client injected through
 *      `factory` (the S1 transport suite's seam — CI has no IMAP server, and
 *      no Dovecot speaks X-GM-EXT-1; the NULL path against a real Dovecot
 *      runs in the S1-G worker verification).
 *
 * Mutation-checked:
 *   - OBJECTID exclusion dropped from providerIdKind → "OBJECTID servers yield no provider id"
 *   - Number() instead of BigInt in gmailHexId         → "hex of a real 64-bit id is exact"
 *   - providerIdOf ignores the capability             → "no X-GM-EXT-1 → providerId null"
 */

'use strict';

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const fetchCommand = require('imapflow/lib/commands/fetch.js').default;
const imapHandler = require('imapflow/lib/handler/imap-handler.js');
const { encrypt } = require('../lib/credentialCrypto');
const T = require('../services/mailbox/imapTransport');

// A real-shaped id: 0x1a11dfc6c43ae8c9 is a live gmail-firm email_log id.
const HEX = '1a11dfc6c43ae8c9';
const DEC = BigInt('0x' + HEX).toString(10);

// ─────────────────────────────────────────────────────────────────────────────
// 1. imapflow 2.3.0, for real
// ─────────────────────────────────────────────────────────────────────────────

/** Run imapflow's FETCH command against a scripted connection; return the wire line + parsed rows. */
async function imapflowFetch(caps, serverLine) {
  let wire = null;
  const conn = {
    states: { SELECTED: 3 },
    state: 3,
    mailbox: { path: 'INBOX', uidValidity: 7n },
    capabilities: new Map(caps.map(c => [c, true])),
    enabled: new Set(),
    log: { debug() {}, warn() {}, error() {}, info() {}, trace() {} },
    async exec(cmd, attributes, opts) {
      wire = (await imapHandler.compiler({ tag: 'A1', command: cmd, attributes })).toString();
      await opts.untagged.FETCH(await imapHandler.parser(Buffer.from(serverLine)));
      return { next() {} };
    },
  };
  const out = await fetchCommand(conn, '5', { uid: true, envelope: true }, { uid: true });
  return { wire, rows: out.list };
}

describe('imapflow 2.3.0 pin (the library this slice rests on)', () => {
  test('X-GM-EXT-1: X-GM-MSGID is requested unasked and parsed into emailId as a decimal string', async () => {
    const { wire, rows } = await imapflowFetch(['IMAP4rev1', 'X-GM-EXT-1'],
      `* 1 FETCH (UID 5 X-GM-MSGID ${DEC})`);
    expect(wire).toBe('A1 UID FETCH 5 (UID ENVELOPE X-GM-MSGID)');
    expect(rows[0].emailId).toBe(DEC);
    expect(typeof rows[0].emailId).toBe('string'); // never a lossy Number
  });

  test('OBJECTID wins over X-GM-EXT-1: EMAILID is requested instead, so emailId is NOT a Gmail id', async () => {
    const { wire, rows } = await imapflowFetch(['IMAP4rev1', 'X-GM-EXT-1', 'OBJECTID'],
      '* 1 FETCH (UID 5 EMAILID (M6d99ac3275bb4e))');
    expect(wire).toContain('EMAILID');
    expect(wire).not.toContain('X-GM-MSGID');
    expect(rows[0].emailId).toBe('M6d99ac3275bb4e');
  });

  test('neither capability: no id is requested', async () => {
    const { wire } = await imapflowFetch(['IMAP4rev1'], '* 1 FETCH (UID 5)');
    expect(wire).toBe('A1 UID FETCH 5 (UID ENVELOPE)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('providerIdKind / gmailHexId', () => {
  const caps = (...c) => ({ capabilities: new Map(c.map(x => [x, true])) });

  test("'gmail' only on X-GM-EXT-1 without OBJECTID", () => {
    expect(T.providerIdKind(caps('IMAP4rev1', 'X-GM-EXT-1'))).toBe('gmail');
    expect(T.providerIdKind(caps('IMAP4rev1'))).toBeNull();
    expect(T.providerIdKind(caps('X-GM-EXT-1', 'OBJECTID'))).toBeNull();
    expect(T.providerIdKind({})).toBeNull();
    expect(T.providerIdKind(null)).toBeNull();
  });

  test('hex of a real 64-bit id is exact (no Number precision loss) and lowercase', () => {
    expect(T.gmailHexId(DEC)).toBe(HEX);
    expect(T.gmailHexId(' ' + DEC + ' ')).toBe(HEX);
    expect(T.gmailHexId('18446744073709551615')).toBe('ffffffffffffffff'); // 2^64-1
    expect(T.gmailHexId('255')).toBe('ff');
  });

  test('anything that is not a positive decimal 64-bit integer → null', () => {
    for (const v of [null, undefined, '', '0', '-5', '18446744073709551616', 'M6d99ac3275bb4e', '12ab', '1e5', 12.5]) {
      expect(T.gmailHexId(v)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The transport over a fake client
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = 'Gm@il-App-Pass-q7';
const USER = 'stuart@4lsg.com';
const row = (over = {}) => ({
  id: 2, address: USER, imap_host: 'imap.gmail.com', imap_port: 993, imap_user: USER,
  imap_secret: encrypt(SECRET), ingest_state: null, ...over,
});

class FakeClient extends EventEmitter {
  constructor(opts, script) {
    super();
    this.opts = opts;
    this.script = script;
    this.calls = [];
    this.capabilities = new Map((script.caps || ['IMAP4rev1']).map(c => [c, true]));
  }
  async connect() { this.calls.push(['connect']); }
  async mailboxOpen(path, opts) {
    this.calls.push(['mailboxOpen', path, opts]);
    return { path, uidValidity: 11n, uidNext: 10, exists: 2 };
  }
  async *fetch(range, query, opts) {
    this.calls.push(['fetch', range, query, opts]);
    for (const m of this.script.envelopes || []) yield m;
  }
  async fetchAll(range, query, opts) {
    this.calls.push(['fetchAll', range, query, opts]);
    return this.script.rows || [];
  }
  async download() { return { meta: { contentType: 'text/plain' }, content: Readable.from([Buffer.from('body')]) }; }
  async list(opts) {
    this.calls.push(['list', opts]);
    if (this.script.listError) throw this.script.listError;
    return this.script.list || [];
  }
  async logout() { this.calls.push(['logout']); }
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

const fetchRow = (uid, emailId) => ({
  uid, emailId, size: 10, flags: new Set(), internalDate: new Date('2026-10-09T00:00:00Z'),
  envelope: { messageId: `<m${uid}@x>`, subject: 's' },
  bodyStructure: { type: 'text/plain' }, headers: Buffer.from(''),
});

describe('provider ids through the session facade', () => {
  test('X-GM-EXT-1: fetchMessages and listMessageIds carry the hex providerId; session reports gmail', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1'];
    script.rows = [fetchRow(5, DEC), fetchRow(6, 'garbage')];
    script.envelopes = [{ uid: 5, emailId: DEC, envelope: { messageId: '<m5@x>' } }];
    await T.withMailbox(row(), async (s) => {
      expect(s.providerIdKind).toBe('gmail');
      await s.openFolder('INBOX');
      const out = await s.fetchMessages([5, 6]);
      expect(out.map(m => [m.uid, m.providerId])).toEqual([[5, HEX], [6, null]]);
      expect(await s.listMessageIds()).toEqual([{ uid: 5, messageId: 'm5@x', providerId: HEX }]);
    });
  });

  test('no X-GM-EXT-1 → providerId null even if a server sends something id-like', async () => {
    script.caps = ['IMAP4rev1'];
    script.rows = [fetchRow(5, DEC)];
    await T.withMailbox(row({ imap_host: 'gcam1191.siteground.biz' }), async (s) => {
      expect(s.providerIdKind).toBeNull();
      await s.openFolder('INBOX');
      expect((await s.fetchMessages([5]))[0].providerId).toBeNull();
    });
  });

  test('OBJECTID servers yield no provider id (emailId there is an RFC 8474 objectid)', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1', 'OBJECTID'];
    script.rows = [fetchRow(5, DEC)];
    await T.withMailbox(row(), async (s) => {
      expect(s.providerIdKind).toBeNull();
      await s.openFolder('INBOX');
      expect((await s.fetchMessages([5]))[0].providerId).toBeNull();
    });
  });

  test('the fetch query itself is unchanged from S1 (imapflow adds the id; nothing extra is asked)', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1'];
    script.rows = [fetchRow(5, DEC)];
    await T.withMailbox(row(), async (s) => { await s.openFolder('INBOX'); await s.fetchMessages([5]); });
    const fa = clients[0].calls.find(c => c[0] === 'fetchAll');
    expect(Object.keys(fa[2]).sort()).toEqual(['bodyStructure', 'envelope', 'flags', 'headers', 'internalDate', 'size', 'uid']);
  });
});

describe('listFolders', () => {
  test('LIST + STATUS shaped, sorted, special-use kept; no folder opened; logged out', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1'];
    script.list = [
      { path: '[Gmail]/Sent Mail', delimiter: '/', flags: new Set(['\\HasNoChildren', '\\Sent']), specialUse: '\\Sent',
        status: { messages: 26206, uidNext: 30001, uidValidity: 5n } },
      { path: 'INBOX', delimiter: '/', flags: new Set(['\\HasNoChildren']), specialUse: '\\Inbox',
        status: { messages: 62012, uidNext: 900001, uidValidity: 1n } },
      { path: '[Gmail]', delimiter: '/', flags: new Set(['\\Noselect', '\\HasChildren']) },
      { path: '[Gmail]/All Mail', delimiter: '/', flags: new Set(['\\All']), specialUse: '\\All',
        status: { messages: 99000, uidNext: 1, uidValidity: 9n } },
    ];
    const out = await T.listFolders(row());
    expect(out.provider_id_kind).toBe('gmail');
    expect(out.folders.map(f => f.path)).toEqual(['INBOX', '[Gmail]', '[Gmail]/All Mail', '[Gmail]/Sent Mail']);
    expect(out.folders[0]).toEqual({
      path: 'INBOX', delimiter: '/', special_use: '\\Inbox', flags: ['\\HasNoChildren'], selectable: true,
      messages: 62012, uid_next: 900001, uid_validity: 1,
    });
    expect(out.folders[1]).toMatchObject({ path: '[Gmail]', selectable: false, messages: null, uid_validity: null });
    expect(out.folders[2].special_use).toBe('\\All');
    const calls = clients[0].calls.map(c => c[0]);
    expect(calls).toEqual(['connect', 'list', 'logout']);
    expect(clients[0].calls[1][1]).toEqual({ statusQuery: { messages: true, uidNext: true, uidValidity: true } });
  });

  test('a LIST failure comes back sanitized — the secret never leaves', async () => {
    script.listError = Object.assign(new Error(`LIST failed for ${SECRET}`), { code: 'ParserError' });
    let caught;
    try { await T.listFolders(row()); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('ParserError');
    expect(JSON.stringify({ m: caught.message, s: caught.stack, ...caught })).not.toContain(SECRET);
    expect(clients[0].calls.map(c => c[0])).toContain('logout');
  });
});
