// tests/mailboxS1G.allmail.test.js
//
/**
 * Mailbox system S1-G, All-Mail slice — the Gmail mailbox polls
 * `[Gmail]/All Mail` as its ONLY folder (inbound, sent and filed-away mail in
 * one copy each), and the DRAFT GUARD: a \Draft message is neither stored nor
 * emitted (services/mailbox/mailboxIngestService.js processUids;
 * services/mailbox/imapTransport.js fetchMessages; design §4.1).
 * Run: npx jest tests/mailboxS1G.allmail.test.js
 *
 * HARNESS: the worker half runs the REAL worker over the S1 world
 * (tests/helpers/mailboxS1World.js — stateful fake MySQL that throws on any
 * statement it does not know, fake IMAP account, fake deduping pipeline). The
 * transport half runs the REAL transport against a fake ImapFlow client
 * through its `factory` seam (the S1 transport suite's pattern).
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - draft guard removed from processUids        → "All Mail only: inbound, sent and filed mail store and emit …"
 *   - guard reads only m.draft (not \Draft flags) → "the guard reads the \Draft flag itself …"
 *   - cursor not advanced past a skipped draft    → "a skipped draft is never fetched again …"
 *   - transport downloads draft bodies            → "transport: a \Draft message comes back metadata-only …"
 */

'use strict';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../services/emailIngestService', () => ({ ingestEmail: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const transport = require('../services/mailbox/imapTransport');
const emailIngestService = require('../services/emailIngestService');
const svc = require('../services/mailbox/mailboxIngestService');
const { encrypt } = require('../lib/credentialCrypto');
const { makeWorld, makeImapServer, makePipeline, msg } = require('./helpers/mailboxS1World');

let W; let S; let P;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  W = makeWorld();
  S = makeImapServer();
  S.providerIdKind = 'gmail';
  P = makePipeline(W);
  transport.withMailbox.mockReset().mockImplementation(S.withMailbox);
  emailIngestService.ingestEmail.mockReset().mockImplementation(P.ingestEmail);
});
afterEach(() => jest.restoreAllMocks());

const run = (opts) => svc.runIngest(W.db, opts);
const ALL = '[Gmail]/All Mail';
const GMAIL = { emit_source_name: 'gmail-firm', emit_id_kind: 'provider' };
const hex = (n) => (0x1a11d045dc6887d0n + BigInt(n)).toString(16);
const gmsg = (uid, over = {}) => msg(uid, { providerId: hex(uid), ...over });
const STUART = [{ name: 'Stuart Sandweiss', address: 'stuart@4lsg.com' }];

/** Mailbox 2 after the switch: All Mail only, emitting under gmail-firm, cursor primed. */
function allMailBox(cfg = { emit_to_rules: true, backfill: false }) {
  return W.addMailbox({
    address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', ...GMAIL,
    ingest_folders: { [ALL]: cfg },
    ingest_state: { [ALL]: { uidvalidity: 11, last_uid: 0 } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('All Mail only + the draft guard (worker)', () => {
  test('All Mail only: inbound, sent and filed mail store and emit under gmail-firm; the draft is neither', async () => {
    S.addFolder(ALL, 11, []);
    const id = allMailBox();
    S.deliver(ALL, gmsg(1));                                                   // inbound
    S.deliver(ALL, gmsg(2, { from: STUART, to: [{ name: '', address: 'client@example.com' }], flags: ['seen'] })); // sent
    S.deliver(ALL, gmsg(3, { from: STUART, flags: ['draft', 'seen'] }));       // a draft
    S.deliver(ALL, gmsg(4, { flags: ['seen'] }));                              // filed away by a label filter
    const s = await run();

    expect(s).toMatchObject({ stored: 3, emitted: 3, draftsSkipped: 1, errors: 0 });
    expect(W.rows(id, ALL).map(r => r.uid)).toEqual([1, 2, 4]);
    expect(P.envelopes.map(e => [e.source, e.headers.message_id, e.from.email])).toEqual([
      ['gmail-firm', hex(1), 'client1@example.com'],
      ['gmail-firm', hex(2), 'stuart@4lsg.com'],   // sent mail emits (§4.1 amendment): GAS posts it today
      ['gmail-firm', hex(4), 'client4@example.com'],
    ]);
    expect(W.T.email_ingest_executions.map(e => e.message_id)).not.toContain(hex(3));
    const st = W.state(id)[ALL];
    expect(st).toMatchObject({ last_uid: 4, drafts_skipped_total: 1 });
    expect(s.details.find(d => d.folder === ALL)).toMatchObject({ stored: 3, emitted: 3, drafts_skipped: 1 });
  });

  test('a skipped draft is never fetched again: the cursor passes it, even when it is the last UID', async () => {
    S.addFolder(ALL, 11, []);
    const id = allMailBox();
    S.deliver(ALL, gmsg(1, { flags: ['draft'] }));
    await run();
    expect(W.state(id)[ALL]).toMatchObject({ last_uid: 1, drafts_skipped_total: 1 });
    S.fetchCalls.length = 0;
    const s2 = await run();
    expect(s2).toMatchObject({ fetched: 0, draftsSkipped: 0, stored: 0 });
    expect(S.fetchCalls).toEqual([]);
    expect(W.rows(id, ALL)).toEqual([]);
  });

  test('autosave churn: every re-save (new UID, old one expunged) is skipped; the sent message stores once', async () => {
    S.addFolder(ALL, 11, []);
    const id = allMailBox();
    const folder = S.folders[ALL];
    S.deliver(ALL, gmsg(5, { from: STUART, flags: ['draft'], messageId: 'draft@x' }));
    await run();
    folder.messages = folder.messages.filter(m => m.uid !== 5);               // Gmail expunges the old revision
    S.deliver(ALL, gmsg(6, { from: STUART, flags: ['draft'], messageId: 'draft@x' }));
    await run();
    folder.messages = folder.messages.filter(m => m.uid !== 6);
    S.deliver(ALL, gmsg(7, { from: STUART, flags: ['seen'], messageId: 'sent@x' })); // sent: a new message
    const s = await run();
    expect(s).toMatchObject({ stored: 1, emitted: 1 });
    expect(W.rows(id, ALL).map(r => [r.uid, r.message_id])).toEqual([[7, 'sent@x']]);
    expect(W.state(id)[ALL]).toMatchObject({ last_uid: 7, drafts_skipped_total: 2 });
  });

  test('the backfill pass skips drafts too (a store-history folder)', async () => {
    S.addFolder(ALL, 11, [gmsg(1), gmsg(2, { flags: ['draft'] }), gmsg(3)]);
    const id = W.addMailbox({ ...GMAIL, address: 'stuart@4lsg.com', ingest_folders: { [ALL]: { emit_to_rules: true } } });
    const s = await run();
    expect(s).toMatchObject({ backfilled: 2, emitted: 0, draftsSkipped: 1 });   // history: stored, never emitted
    expect(W.rows(id, ALL).map(r => r.uid)).toEqual([1, 3]);
  });

  test('a draft row stored by an older build is never emitted from the crash-window retry', async () => {
    S.addFolder(ALL, 11, []);
    const id = allMailBox();
    W.T.mail_messages.push({ id: 900, mailbox_id: id, folder: ALL, uid: 1, message_id: 'm1@example.com', provider_id: hex(1), log_id: null, flags: 'draft' });
    S.deliver(ALL, gmsg(1, { flags: ['draft'] }));
    const s = await run();
    expect(s).toMatchObject({ emitted: 0, draftsSkipped: 1 });
    expect(P.envelopes).toEqual([]);
    expect(W.rows(id, ALL).map(r => r.id)).toEqual([900]);                     // left alone, not purged
  });

  test('the guard reads the \\Draft flag itself (not only the transport\'s draft marker)', () => {
    expect(svc.isDraft({ flags: ['seen', 'draft'] })).toBe(true);
    expect(svc.isDraft({ draft: true, flags: [] })).toBe(true);
    expect(svc.isDraft({ flags: ['seen', 'answered'] })).toBe(false);
    expect(svc.isDraft(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The transport half — the REAL imapTransport against a fake ImapFlow client
// ─────────────────────────────────────────────────────────────────────────────

const realT = jest.requireActual('../services/mailbox/imapTransport');

class FakeClient extends EventEmitter {
  constructor(opts, script) { super(); this.opts = opts; this.script = script; this.calls = []; }
  async connect() { this.calls.push(['connect']); }
  async mailboxOpen(path) { this.calls.push(['mailboxOpen', path]); return { path, uidValidity: 11n, uidNext: 10, exists: 2 }; }
  async fetchAll(range, query) { this.calls.push(['fetchAll', range, query]); return this.script.rows; }
  async download(uid, part) {
    this.calls.push(['download', uid, part]);
    return { meta: { contentType: 'text/plain' }, content: Readable.from([Buffer.from(`body of ${uid}`)]) };
  }
  async logout() { this.calls.push(['logout']); }
  close() {}
}

describe('transport: drafts come back metadata-only', () => {
  const realCreate = realT.factory.create;
  afterEach(() => { realT.factory.create = realCreate; });

  test('transport: a \\Draft message comes back metadata-only (draft:true, no download); others are fetched as before', async () => {
    const clients = [];
    const script = {
      rows: [
        { uid: 3, flags: new Set(['\\Draft', '\\Seen']), envelope: { messageId: '<d@x>' }, bodyStructure: { type: 'text/plain', part: '1' }, headers: Buffer.from('') },
        { uid: 4, flags: new Set(['\\Seen']), envelope: { messageId: '<s@x>' }, bodyStructure: { type: 'text/plain', part: '1' }, headers: Buffer.from('') },
      ],
    };
    realT.factory.create = (opts) => { const c = new FakeClient(opts, script); clients.push(c); return c; };
    const row = { id: 2, address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', imap_port: 993, imap_user: 'stuart@4lsg.com', imap_secret: encrypt('pw') };
    let out;
    await realT.withMailbox(row, async (s) => { await s.openFolder(ALL); out = await s.fetchMessages([3, 4]); });

    expect(out.map(m => [m.uid, m.draft, m.text])).toEqual([[3, true, null], [4, false, 'body of 4']]);
    expect(out[0].flags).toEqual(['draft', 'seen']);
    expect(clients[0].calls.filter(c => c[0] === 'download').map(c => c[1])).toEqual(['4']);
  });
});
