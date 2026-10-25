// tests/helpers/imapWire.js
//
/**
 * IMAP at the wire, for the mailbox suites that need imapflow's OWN parsing
 * (tests/mailboxFetchMerge.test.js, tests/mailboxRepairShellRows.mysql.test.js).
 *
 *   realFetch(caps, range, query, opts, lines)
 *       imapflow 2.3.0's REAL fetch command + REAL wire compiler + REAL
 *       response parser over a scripted connection (only the socket is
 *       replaced — the S1-G pin's technique): every server line is fed to the
 *       command's untagged FETCH handler, in order. → { wire, rows }
 *   FakeImapFlow
 *       an ImapFlow stand-in for imapTransport's `factory` seam. fetchAll
 *       answers each call from `script.fetches` (one entry per call, in
 *       order): an array of server LINES runs through realFetch; an array of
 *       objects is returned as rows as they are. search / mailboxOpen /
 *       fetch / download answer from `script` too.
 *   dataLine(uid, dec, subject) / flagsLine(uid)
 *       one message's data as Gmail answers the worker's UID FETCH (bodies
 *       aside), and the unsolicited update Gmail sends when that message is
 *       answered meanwhile — the live 2026-10-16 pair. Fictional sender and
 *       subject: this repository is public.
 */

'use strict';

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const fetchCommand = require('imapflow/lib/commands/fetch.js').default;
const imapHandler = require('imapflow/lib/handler/imap-handler.js');

async function realFetch(caps, range, query, opts, lines) {
  let wire = null;
  const conn = {
    states: { SELECTED: 3 },
    state: 3,
    mailbox: { path: '[Gmail]/All Mail', uidValidity: 12n },
    capabilities: new Map(caps.map(c => [c, true])),
    enabled: new Set(),
    log: { debug() {}, warn() {}, error() {}, info() {}, trace() {} },
    async exec(cmd, attributes, o) {
      wire = (await imapHandler.compiler({ tag: 'A1', command: cmd, attributes })).toString();
      for (const l of lines) await o.untagged.FETCH(await imapHandler.parser(Buffer.from(l)));
      return { next() {} };
    },
  };
  const out = await fetchCommand(conn, range, query, opts);
  return { wire, rows: out.list };
}

class FakeImapFlow extends EventEmitter {
  constructor(opts, script) {
    super();
    this.opts = opts;
    this.script = script;
    this.calls = [];
    this.capabilities = new Map((script.caps || ['IMAP4rev1', 'X-GM-EXT-1']).map(c => [c, true]));
  }
  async connect() { this.calls.push(['connect']); }
  async mailboxOpen(path, opts) {
    this.calls.push(['mailboxOpen', path, opts]);
    return { path, uidValidity: this.script.uidValidity || 12n, uidNext: this.script.uidNext || 1, exists: 1 };
  }
  async search(q, opts) {
    this.calls.push(['search', q, opts]);
    const lo = Number(String(q.uid).split(':')[0]);
    return (this.script.uids || []).filter(u => u >= lo);
  }
  async *fetch(range, query, opts) {
    this.calls.push(['fetch', range, query, opts]);
    for (const m of this.script.stream || []) yield m;
  }
  async fetchAll(range, query, opts) {
    this.calls.push(['fetchAll', range, query, opts]);
    const next = (this.script.fetches || []).shift() || [];
    if (next.length && typeof next[0] === 'string') {
      return (await realFetch([...this.capabilities.keys()], range, query, opts, next)).rows;
    }
    return next;
  }
  async download(uid, part) {
    this.calls.push(['download', uid, part]);
    return { meta: { contentType: 'text/plain' }, content: Readable.from([Buffer.from(`body ${uid}`)]) };
  }
  async logout() { this.calls.push(['logout']); }
  close() { this.calls.push(['close']); }
}

const dataLine = (uid, dec, subject = 'Re: adjourning the hearing') =>
  `* 3 FETCH (UID ${uid} X-GM-MSGID ${dec} X-GM-LABELS ("\\\\Inbox" "Court Notices") FLAGS (\\Seen) ` +
  'INTERNALDATE "16-Oct-2026 15:20:56 +0000" RFC822.SIZE 4321 ' +
  `ENVELOPE ("Fri, 16 Oct 2026 15:20:56 +0000" "${subject}" (("Trustee Staff" NIL "staff" "trustee.test")) ` +
  `NIL NIL (("Attorney" NIL "stuart" "4lsg.com")) NIL NIL NIL "<m${uid}@trustee.test>") ` +
  'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL))';

const flagsLine = (uid) => `* 3 FETCH (UID ${uid} FLAGS (\\Seen \\Answered))`;

/** Decimal X-GM-MSGID for a lowercase hex id. */
const dec = (hex) => BigInt('0x' + hex).toString(10);

module.exports = { realFetch, FakeImapFlow, dataLine, flagsLine, dec };
