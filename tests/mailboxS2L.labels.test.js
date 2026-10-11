// tests/mailboxS2L.labels.test.js
//
/**
 * Mailbox system S2-L — Gmail labels (design OQ5): capture at ingest
 * (services/mailbox/imapTransport.js, mailboxIngestService.buildRow), the SU
 * re-snapshot (mailboxIngestService.snapshotLabels, POST
 * /api/mailboxes/:id/labels/snapshot). The hub's use of them (in_inbox,
 * place, sent) is in tests/mailboxS2.routes.test.js / mailboxS2.mysql.test.js.
 * Run: npx jest tests/mailboxS2L.labels.test.js
 *
 * Four layers:
 *   1. THE LIBRARY PIN — imapflow 2.3.0's REAL fetch command + wire compiler +
 *      response parser (only the socket replaced, the S1-G pin's harness):
 *      `labels: true` asks X-GM-LABELS only on X-GM-EXT-1, and the reply
 *      parses into a Set with system labels' backslash intact.
 *   2. THE TRANSPORT over a fake ImapFlow client (the `factory` seam).
 *   3. THE WORKER over the S1 world (tests/helpers/mailboxS1World.js): rows
 *      carry gmail_labels; everything else the worker does is unchanged —
 *      except that the \Draft label is a DRAFT GUARD signal (Gmail does not
 *      flag drafts in All Mail; tests/mailboxS1G.allmail.test.js owns it).
 *   4. THE RE-SNAPSHOT (service + route) over the S1 world: lock, UIDVALIDITY,
 *      identity, bounds, SU + elevation, audit.
 * The non-Gmail no-op ran against a real Dovecot IMAPS + MySQL 8.4.6 in the
 * S2-L worker verification (no X-GM-LABELS on the wire, labels NULL, the
 * re-snapshot answers labels_supported:false and writes nothing).
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - labels asked unconditionally (no X-GM-EXT-1 gate)     → "non-Gmail: S1's query, labels null"
 *   - labels gated on providerIdKind (OBJECTID excluded)    → "OBJECTID + X-GM-EXT-1 still yields labels"
 *   - buildRow dropping gmail_labels                        → "rows carry the snapshot …"
 *   - snapshotLabels without the lock                       → "lock held → skipped …"
 *   - snapshotLabels ignoring a lost lock                   → "a lock lost before the write …"
 *   - UIDVALIDITY check dropped                             → "UIDVALIDITY changed → 409 …"
 *   - provider-id identity check dropped                    → "a row whose provider id the server …"
 *   - breadcrumb folders accepted                           → "only a polled folder …"
 *   - route SU gate → can_manage / elevation not required   → route tests
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2l-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s2l_internal';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  // The worker + snapshot layers swap withMailbox for the fake account; the
  // transport layer calls the REAL one (jest.requireActual below).
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../services/emailIngestService', () => ({ ingestEmail: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const express = require('express');
const jwt = require('jsonwebtoken');
const fetchCommand = require('imapflow/lib/commands/fetch.js').default;
const imapHandler = require('imapflow/lib/handler/imap-handler.js');
const transport = require('../services/mailbox/imapTransport');
const T = jest.requireActual('../services/mailbox/imapTransport');
const emailIngestService = require('../services/emailIngestService');
const svc = require('../services/mailbox/mailboxIngestService');
const { encrypt } = require('../lib/credentialCrypto');
const { mintElevationToken } = require('../lib/auth.superuser');
const { makeWorld, makeImapServer, makePipeline, msg } = require('./helpers/mailboxS1World');

const HEX = '1a11dfc6c43ae8c9';
const DEC = BigInt('0x' + HEX).toString(10);

// ─────────────────────────────────────────────────────────────────────────────
// 1. imapflow 2.3.0, for real
// ─────────────────────────────────────────────────────────────────────────────

async function imapflowFetch(caps, serverLine, query) {
  let wire = null;
  const conn = {
    states: { SELECTED: 3 },
    state: 3,
    mailbox: { path: '[Gmail]/All Mail', uidValidity: 12n },
    capabilities: new Map(caps.map(c => [c, true])),
    enabled: new Set(),
    log: { debug() {}, warn() {}, error() {}, info() {}, trace() {} },
    async exec(cmd, attributes, opts) {
      wire = (await imapHandler.compiler({ tag: 'A1', command: cmd, attributes })).toString();
      await opts.untagged.FETCH(await imapHandler.parser(Buffer.from(serverLine)));
      return { next() {} };
    },
  };
  const out = await fetchCommand(conn, '5', query, { uid: true });
  return { wire, rows: out.list };
}

describe('imapflow 2.3.0 pin: X-GM-LABELS', () => {
  test('X-GM-EXT-1 + labels:true → X-GM-LABELS rides the SAME fetch; system labels keep their backslash', async () => {
    const { wire, rows } = await imapflowFetch(['IMAP4rev1', 'X-GM-EXT-1'],
      `* 1 FETCH (UID 5 X-GM-MSGID ${DEC} X-GM-LABELS (\\Inbox \\Important "Clio/Clio Team - Payments" "\\\\Sent"))`,
      { uid: true, envelope: true, labels: true });
    expect(wire).toBe('A1 UID FETCH 5 (UID ENVELOPE X-GM-MSGID X-GM-LABELS)');
    expect(rows[0].emailId).toBe(DEC);
    expect(rows[0].labels).toBeInstanceOf(Set);
    expect([...rows[0].labels]).toEqual(['\\Inbox', '\\Important', 'Clio/Clio Team - Payments', '\\Sent']);
  });

  test('an empty list is an empty Set (Gmail: no labels = archived); modified UTF-7 names decode', async () => {
    const empty = await imapflowFetch(['IMAP4rev1', 'X-GM-EXT-1'], '* 1 FETCH (UID 5 X-GM-LABELS ())', { uid: true, labels: true });
    expect([...empty.rows[0].labels]).toEqual([]);
    const utf7 = await imapflowFetch(['IMAP4rev1', 'X-GM-EXT-1'], '* 1 FETCH (UID 5 X-GM-LABELS ("Caf&AOk-"))', { uid: true, labels: true });
    expect([...utf7.rows[0].labels]).toEqual(['Café']);
  });

  test('a Gmail draft as All Mail really sends it (live 2026-10-11): FLAGS (\\Seen) only — the \\Draft LABEL is the one signal', async () => {
    const { wire, rows } = await imapflowFetch(['IMAP4rev1', 'X-GM-EXT-1'],
      `* 1 FETCH (UID 187847 FLAGS (\\Seen) X-GM-MSGID ${DEC} X-GM-LABELS (\\Draft))`,
      { uid: true, flags: true, labels: true });
    expect(wire).toBe('A1 UID FETCH 5 (UID FLAGS X-GM-MSGID X-GM-LABELS)');
    expect([...rows[0].flags]).toEqual(['\\Seen']);
    expect([...rows[0].labels]).toEqual(['\\Draft']);
    expect(T.hasDraftLabel(T.labelList(rows[0].labels))).toBe(true);
  });

  test('no X-GM-EXT-1: labels:true asks nothing (Dovecot would answer BAD to an unknown item)', async () => {
    const { wire } = await imapflowFetch(['IMAP4rev1'], '* 1 FETCH (UID 5)', { uid: true, envelope: true, labels: true });
    expect(wire).toBe('A1 UID FETCH 5 (UID ENVELOPE)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The transport over a fake client
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = 'Gm@il-App-Pass-q7';
const USER = 'stuart@4lsg.com';
const connRow = (over = {}) => ({
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
  async mailboxOpen(path, opts) { this.calls.push(['mailboxOpen', path, opts]); return { path, uidValidity: 12n, uidNext: 10, exists: 2 }; }
  async fetchAll(range, query, opts) { this.calls.push(['fetchAll', range, query, opts]); return this.script.rows || []; }
  async download() { this.calls.push(['download']); return { meta: { contentType: 'text/plain' }, content: Readable.from([Buffer.from('body')]) }; }
  async logout() { this.calls.push(['logout']); }
  close() { this.calls.push(['close']); }
}

const fetchRow = (uid, { labels, flags = new Set(), emailId = DEC } = {}) => ({
  uid, emailId, size: 10, flags, internalDate: new Date('2026-10-11T00:00:00Z'),
  envelope: { messageId: `<m${uid}@x>`, subject: 's' },
  bodyStructure: { type: 'text/plain' }, headers: Buffer.from(''),
  ...(labels === undefined ? {} : { labels }),
});

describe('transport: labels on fetchMessages, fetchLabels', () => {
  let clients; let script;
  const realCreate = T.factory.create;
  beforeEach(() => {
    clients = []; script = {};
    T.factory.create = (opts) => { const c = new FakeClient(opts, script); clients.push(c); return c; };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { T.factory.create = realCreate; jest.restoreAllMocks(); });

  test('X-GM-EXT-1: each message carries its labels (array, server order, de-duplicated); a reply without them → null', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1'];
    script.rows = [
      fetchRow(5, { labels: new Set(['\\Inbox', '\\Important']) }),
      fetchRow(6, { labels: new Set() }),
      fetchRow(7),                                                       // attribute missing
      fetchRow(8, { labels: new Set(['\\Draft']), flags: new Set(['\\Seen']) }), // Gmail's draft: label, no flag
    ];
    let out;
    await T.withMailbox(connRow(), async (s) => {
      expect(s.labelsKind).toBe('gmail');
      await s.openFolder('[Gmail]/All Mail');
      out = await s.fetchMessages([5, 6, 7, 8]);
    });
    expect(out.map(m => [m.uid, m.labels])).toEqual([[5, ['\\Inbox', '\\Important']], [6, []], [7, null], [8, ['\\Draft']]]);
    expect(out[3].draft).toBe(true); // the \\Draft label alone makes it a draft (metadata only)
    expect(clients[0].calls.filter(c => c[0] === 'download')).toHaveLength(3); // 5, 6, 7 bodies; never the draft's
    expect(T.labelList(['a', 'a', '', null, 'b'])).toEqual(['a', 'b']);
    expect(T.labelList(null)).toBeNull();
    expect(T.labelList('\\Inbox')).toBeNull(); // a bare string is not a label list
  });

  test('non-Gmail: S1\'s query, labels null — even if a server sent something label-like', async () => {
    script.caps = ['IMAP4rev1'];
    script.rows = [fetchRow(5, { labels: new Set(['\\Inbox']) })];
    let out;
    await T.withMailbox(connRow({ imap_host: 'gcam1191.siteground.biz' }), async (s) => {
      expect(s.labelsKind).toBeNull();
      await s.openFolder('INBOX');
      out = await s.fetchMessages([5]);
    });
    expect(out[0].labels).toBeNull();
    expect(clients[0].calls.find(c => c[0] === 'fetchAll')[2].labels).toBeUndefined();
  });

  test('OBJECTID + X-GM-EXT-1 still yields labels (the gate is X-GM-EXT-1; OBJECTID only changes what emailId means)', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1', 'OBJECTID'];
    script.rows = [fetchRow(5, { labels: new Set(['\\Inbox']), emailId: 'M6d99ac3275bb4e' })];
    let out;
    await T.withMailbox(connRow(), async (s) => { await s.openFolder('[Gmail]/All Mail'); out = await s.fetchMessages([5]); });
    expect([out[0].providerId, out[0].labels]).toEqual([null, ['\\Inbox']]);
  });

  test('fetchLabels: UID + labels only, the asked UIDs only, ascending; non-Gmail → sanitized NO_GMAIL_LABELS', async () => {
    script.caps = ['IMAP4rev1', 'X-GM-EXT-1'];
    script.rows = [
      { uid: 9, emailId: DEC, labels: new Set(['\\Sent']) },
      { uid: 4, emailId: '255', labels: new Set(['\\Inbox']) },
      { uid: 77, emailId: '1', labels: new Set(['x']) },          // unsolicited row
    ];
    let out;
    await T.withMailbox(connRow(), async (s) => { await s.openFolder('[Gmail]/All Mail'); out = await s.fetchLabels([9, 4, 4, 'x']); });
    expect(out).toEqual([{ uid: 4, providerId: 'ff', labels: ['\\Inbox'] }, { uid: 9, providerId: HEX, labels: ['\\Sent'] }]);
    const fa = clients[0].calls.find(c => c[0] === 'fetchAll');
    expect([fa[1], fa[2], fa[3]]).toEqual(['9,4', { uid: true, labels: true }, { uid: true }]);

    script.caps = ['IMAP4rev1'];
    let caught;
    await T.withMailbox(connRow({ imap_host: 'gcam1191.siteground.biz' }), async (s) => {
      try { await s.fetchLabels([1]); } catch (e) { caught = e; }
    });
    expect([caught.code, caught.sanitized]).toEqual(['NO_GMAIL_LABELS', true]);
    expect(JSON.stringify({ m: caught.message, s: caught.stack })).not.toContain(SECRET);
    expect(clients[1].calls.map(c => c[0])).toEqual(['connect', 'logout']); // nothing was fetched
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The worker: rows carry the snapshot; nothing else changes
// ─────────────────────────────────────────────────────────────────────────────

const ALL = '[Gmail]/All Mail';
const GMAIL = { emit_source_name: 'gmail-firm', emit_id_kind: 'provider' };
const hex = (n) => (0x1a11d045dc6887d0n + BigInt(n)).toString(16);
const gmsg = (uid, over = {}) => msg(uid, { providerId: hex(uid), ...over });

let W; let S; let P;
function worldSetup() {
  W = makeWorld();
  S = makeImapServer();
  P = makePipeline(W);
  transport.withMailbox.mockReset().mockImplementation(S.withMailbox);
  emailIngestService.ingestEmail.mockReset().mockImplementation(P.ingestEmail);
}
function allMailBox(state = { [ALL]: { uidvalidity: 12, last_uid: 0 } }, over = {}) {
  return W.addMailbox({
    address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', ...GMAIL,
    ingest_folders: { [ALL]: { emit_to_rules: true, backfill: false } },
    ingest_state: state, ...over,
  });
}

describe('worker: gmail_labels on every stored row; ingest otherwise unchanged', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    worldSetup();
  });
  afterEach(() => jest.restoreAllMocks());

  test('rows carry the snapshot as fetched (JSON text); a non-Gmail box stores NULL', async () => {
    S.providerIdKind = 'gmail'; S.labelsKind = 'gmail';
    S.addFolder(ALL, 12, []);
    const id = allMailBox();
    S.deliver(ALL, gmsg(1, { labels: ['\\Inbox', '\\Important'] }));
    S.deliver(ALL, gmsg(2, { labels: ['\\Sent'] }));
    S.deliver(ALL, gmsg(3, { labels: [] }));
    S.deliver(ALL, gmsg(4)); // a Gmail reply without the attribute: unknown
    await svc.runIngest(W.db);
    expect(W.rows(id, ALL).map(r => [r.uid, r.gmail_labels])).toEqual([
      [1, '["\\\\Inbox","\\\\Important"]'], [2, '["\\\\Sent"]'], [3, '[]'], [4, null],
    ]);
    expect(svc.buildRow(1, 'INBOX', msg(9)).gmail_labels).toBeNull();
    expect(svc.buildRow(1, ALL, msg(9, { labels: ['\\Inbox'] })).gmail_labels).toBe('["\\\\Inbox"]');
  });

  test('labels change nothing else the worker decides (the \\Draft label aside): same rows, envelopes, summary; drafts skipped', async () => {
    const runWith = async (withLabels) => {
      worldSetup();
      S.providerIdKind = 'gmail'; S.labelsKind = withLabels ? 'gmail' : null;
      S.addFolder(ALL, 12, []);
      const id = allMailBox();
      const L = (l) => (withLabels ? { labels: l } : {});
      S.deliver(ALL, gmsg(1, L(['\\Inbox'])));
      S.deliver(ALL, gmsg(2, { ...L(['\\Sent']), from: [{ name: 'Stuart', address: 'stuart@4lsg.com' }] }));
      S.deliver(ALL, gmsg(3, { ...L(['\\Draft']), flags: ['draft'] }));
      S.deliver(ALL, gmsg(4, L(['Clio/Clio Team - Payments'])));
      const summary = await svc.runIngest(W.db);
      const rows = W.rows(id, ALL).map(({ gmail_labels, ...r }) => r);
      return { summary: { ...summary, durationMs: 0 }, rows, envelopes: P.envelopes.map(e => ({ ...e, received_at: null })), state: W.state(id) };
    };
    const a = await runWith(true);
    const b = await runWith(false);
    expect(a.rows).toEqual(b.rows);
    expect(a.envelopes).toEqual(b.envelopes);
    expect(a.summary).toEqual(b.summary);
    expect(JSON.stringify(a.envelopes)).not.toMatch(/Inbox|labels/);
    expect([a.summary.stored, a.summary.draftsSkipped, a.summary.emitted]).toEqual([3, 1, 3]);
    expect({ ...a.state[ALL], checked_at: null }).toEqual({ ...b.state[ALL], checked_at: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The re-snapshot — service
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshotLabels (service)', () => {
  let id;
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    worldSetup();
    S.providerIdKind = 'gmail'; S.labelsKind = 'gmail';
    // rows stored before S2-L: on the server, unlabelled in the store
    S.addFolder(ALL, 12, [1, 2, 3, 4, 5].map(u => gmsg(u)));
    id = allMailBox({ [ALL]: { uidvalidity: 12, last_uid: 5 }, INBOX: { uidvalidity: 1, last_uid: 99 } });
    for (const u of [1, 2, 3, 4, 5]) W.T.mail_messages.push({ id: 100 + u, mailbox_id: id, folder: ALL, uid: u, provider_id: hex(u), gmail_labels: null, log_id: null });
    W.T.mail_messages.push({ id: 900, mailbox_id: id, folder: 'INBOX', uid: 7, provider_id: hex(7), gmail_labels: null, log_id: null }); // breadcrumb folder row
    S.labels = { 1: ['\\Inbox'], 2: ['\\Sent'], 3: [], 4: ['\\Inbox', 'IT'], 5: ['Clio/Payments'] };
  });
  afterEach(() => jest.restoreAllMocks());
  const labelsOf = () => Object.fromEntries(W.T.mail_messages.map(r => [r.uid, r.gmail_labels]));
  const writes = () => W.statements.filter(x => /^(INSERT|UPDATE|DELETE)/.test(x.sql) && !/admin_audit_log/.test(x.sql));

  test('writes the server\'s labels onto the stored rows by id; the folder defaults to the ONE polled folder', async () => {
    const r = await svc.snapshotLabels(W.db, id);
    expect(r).toEqual({
      mailbox_id: id, folder: ALL, uidvalidity: 12, labels_supported: true,
      scanned: 5, updated: 5, gone: 0, mismatched: 0, unlabelled: 0, after_uid: 0, next_after_uid: null, done: true,
    });
    expect(labelsOf()).toEqual({
      1: '["\\\\Inbox"]', 2: '["\\\\Sent"]', 3: '[]', 4: '["\\\\Inbox","IT"]', 5: '["Clio/Payments"]', 7: null,
    });
    expect(S.labelCalls).toEqual([[1, 2, 3, 4, 5]]);
    // ingest_state is never written; the only write is the CASE update
    expect(writes().map(x => x.sql.slice(0, 40))).toEqual(['UPDATE mail_messages SET gmail_labels = ']);
    expect(W.lock.holder).toBeNull(); // released
  });

  test('bounded: limit rows above after_uid per call; loop on next_after_uid to done; a re-run re-snapshots (refresh)', async () => {
    const r1 = await svc.snapshotLabels(W.db, id, { limit: 2 });
    expect([r1.scanned, r1.updated, r1.next_after_uid, r1.done]).toEqual([2, 2, 2, false]);
    const r2 = await svc.snapshotLabels(W.db, id, { limit: 2, afterUid: r1.next_after_uid });
    expect([r2.after_uid, r2.next_after_uid, r2.done]).toEqual([2, 4, false]);
    const r3 = await svc.snapshotLabels(W.db, id, { limit: 2, afterUid: r2.next_after_uid });
    expect([r3.scanned, r3.next_after_uid, r3.done]).toEqual([1, null, true]);
    expect(S.labelCalls).toEqual([[1, 2], [3, 4], [5]]);
    // archived in Gmail since: a refresh picks it up
    S.labels[1] = [];
    await svc.snapshotLabels(W.db, id);
    expect(labelsOf()[1]).toBe('[]');
    // nothing left above the last uid: no IMAP connect at all
    const before = S.connects;
    const r4 = await svc.snapshotLabels(W.db, id, { afterUid: 5 });
    expect([r4.scanned, r4.done, r4.labels_supported, S.connects]).toEqual([0, true, null, before]);
  });

  test('lock held → skipped: no IMAP, no read of rows, no write', async () => {
    W.lock.holder = 'the-ingest-run';
    const r = await svc.snapshotLabels(W.db, id);
    expect(r.skipped).toBe(true);
    expect(S.connects).toBe(0);
    expect(W.statements.filter(x => /FROM mail_messages/.test(x.sql))).toEqual([]);
    expect(writes()).toEqual([]);
    expect(labelsOf()[1]).toBeNull();
  });

  test('a lock lost before the write → 409 LOCK_LOST, nothing written', async () => {
    const saved = svc.limits.heartbeatMs;
    svc.limits.heartbeatMs = 5;
    const realSession = S.session;
    S.session = () => {
      const s = realSession();
      const fl = s.fetchLabels;
      s.fetchLabels = async (u) => { W.lock.breakHeartbeat = true; await new Promise(r => setTimeout(r, 40)); return fl(u); };
      return s;
    };
    try {
      await expect(svc.snapshotLabels(W.db, id)).rejects.toMatchObject({ status: 409, code: 'LOCK_LOST' });
    } finally {
      svc.limits.heartbeatMs = saved;
      W.lock.breakHeartbeat = false;
    }
    expect(writes()).toEqual([]);
  });

  test('UIDVALIDITY changed → 409, nothing fetched or written (a re-key is pending)', async () => {
    S.folders[ALL].uidValidity = 13;
    await expect(svc.snapshotLabels(W.db, id)).rejects.toMatchObject({ status: 409, code: 'UIDVALIDITY_MISMATCH' });
    expect(S.labelCalls).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test('a row whose provider id the server does not match is skipped and counted; a gone UID and an unlabelled reply too', async () => {
    W.T.mail_messages.find(r => r.uid === 2).provider_id = 'deadbeef';  // stored row ≠ the server's message at uid 2
    S.folders[ALL].messages = S.folders[ALL].messages.filter(m => m.uid !== 3); // expunged in Gmail
    S.labels[4] = null;                                                  // reply without X-GM-LABELS
    const r = await svc.snapshotLabels(W.db, id);
    expect([r.scanned, r.updated, r.mismatched, r.gone, r.unlabelled]).toEqual([5, 2, 1, 1, 1]);
    expect(labelsOf()).toMatchObject({ 1: '["\\\\Inbox"]', 2: null, 3: null, 4: null, 5: '["Clio/Payments"]' });
  });

  test('non-Gmail server → labels_supported false: no folder opened, nothing written', async () => {
    S.labelsKind = null;
    const r = await svc.snapshotLabels(W.db, id);
    expect([r.labels_supported, r.updated, r.done]).toEqual([false, 0, true]);
    expect(S.labelCalls).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test('only a polled folder (breadcrumbs keep NULL); folder required when several are polled; no cursor → 409; bad bounds → 400', async () => {
    await expect(svc.snapshotLabels(W.db, id, { folder: 'INBOX' })).rejects.toMatchObject({ status: 400, code: 'NOT_POLLED' });
    expect((await svc.snapshotLabels(W.db, id, { folder: '[gmail]/all mail' })).folder).toBe(ALL); // case-blind, configured spelling
    W.T.mailboxes.find(b => b.id === id).ingest_folders = JSON.stringify({ [ALL]: { emit_to_rules: true }, '[Gmail]/Sent Mail': { emit_to_rules: false } });
    await expect(svc.snapshotLabels(W.db, id)).rejects.toMatchObject({ status: 400, code: 'FOLDER_REQUIRED' });
    await expect(svc.snapshotLabels(W.db, id, { folder: '[Gmail]/Sent Mail' })).rejects.toMatchObject({ status: 409, code: 'NO_CURSOR' });
    for (const bad of [{ afterUid: -1 }, { afterUid: 1.5 }, { limit: 0 }, { limit: svc.LABEL_SNAPSHOT_MAX + 1 }, { limit: '10' }]) {
      await expect(svc.snapshotLabels(W.db, id, { folder: ALL, ...bad })).rejects.toMatchObject({ status: 400 });
    }
    await expect(svc.snapshotLabels(W.db, 999)).rejects.toMatchObject({ status: 404 });
    expect(W.lock.holder).toBeNull(); // released on every error path
    expect(labelsOf()[7]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. The re-snapshot — route
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/mailboxes/:id/labels/snapshot', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = W.db; next(); });
  app.use(require('../routes/api.mailboxes'));
  let server; let base; let id;
  beforeAll(async () => {
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    worldSetup();
    S.providerIdKind = 'gmail'; S.labelsKind = 'gmail';
    S.addFolder(ALL, 12, [gmsg(1), gmsg(2)]);
    id = allMailBox({ [ALL]: { uidvalidity: 12, last_uid: 2 } });
    for (const u of [1, 2]) W.T.mail_messages.push({ id: 100 + u, mailbox_id: id, folder: ALL, uid: u, provider_id: hex(u), gmail_labels: null, log_id: null });
    S.labels = { 1: ['\\Inbox'], 2: ['\\Sent'] };
    W.T.channel_grants.push({ user: 1, channel_type: 'mailbox', channel_id: id, can_read: 1, can_send: 0, can_manage: 1 });
  });
  afterEach(() => jest.restoreAllMocks());

  const tok = (user, user_auth = 'authorized') => jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);
  async function post(body, { user = 6, auth = 'authorized - SU', elevated = true, apiKey } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${tok(user, auth)}`;
    if (elevated) headers['X-SU-Elevation'] = mintElevationToken(user);
    const r = await fetch(`${base}/api/mailboxes/${id}/labels/snapshot`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }

  test('SU + elevation: snapshots, answers the counts, audits them', async () => {
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'success', folder: ALL, scanned: 2, updated: 2, done: true, labels_supported: true });
    expect(W.T.mail_messages.map(m => m.gmail_labels)).toEqual(['["\\\\Inbox"]', '["\\\\Sent"]']);
    expect(W.T.admin_audit_log).toEqual([expect.objectContaining({
      tool: 'mailboxes', user_id: '6', method: 'POST', status: 'success', route: `/api/mailboxes/${id}/labels/snapshot`,
      details: expect.objectContaining({ action: 'mailbox_labels_snapshot', mailbox_id: id, folder: ALL, scanned: 2, updated: 2, done: true }),
    })]);
  });

  test('a manager is 403, a stranger 404, an api key 403; an SU without elevation is 401 elevation_required — none writes', async () => {
    expect((await post({}, { user: 1, auth: 'authorized' })).status).toBe(403);
    expect((await post({}, { user: 9, auth: 'authorized' })).status).toBe(404);
    expect((await post({}, { apiKey: process.env.INTERNAL_API_KEY, elevated: false })).status).toBe(403);
    const noElev = await post({}, { elevated: false });
    expect([noElev.status, noElev.json.code]).toEqual([401, 'elevation_required']);
    expect(W.T.mail_messages.every(m => m.gmail_labels == null)).toBe(true);
    expect(S.connects).toBe(0);
  });

  test('lock held → 409 INGEST_LOCK_HELD (retry); bad body → 400; service 4xx passed through; IMAP failure → 502 sanitized', async () => {
    W.lock.holder = 'tick';
    const held = await post({});
    expect([held.status, held.json.code, held.json.retry]).toEqual([409, 'INGEST_LOCK_HELD', true]);
    W.lock.holder = null;
    expect((await post({ folder: 3 })).status).toBe(400);
    expect((await post({ uid: 3 })).status).toBe(400);
    expect((await post({ limit: 5000 })).status).toBe(400);
    const np = await post({ folder: 'INBOX' });
    expect([np.status, np.json.code]).toEqual([400, 'NOT_POLLED']);
    S.failConnect = Object.assign(new Error('IMAP AUTHENTICATIONFAILED: Invalid credentials'), { code: 'AUTHENTICATIONFAILED', imap: true, sanitized: true });
    const bad = await post({});
    expect([bad.status, bad.json.code]).toEqual([502, 'AUTHENTICATIONFAILED']);
    expect(W.T.mail_messages.every(m => m.gmail_labels == null)).toBe(true);
  });
});
