// tests/mailboxFetchMerge.test.js
//
/**
 * Mailbox ingest — FETCH ROWS ARE MERGED PER UID (services/mailbox/imapTransport.js
 * header). Run: npx jest tests/mailboxFetchMerge.test.js
 *
 * THE DEFECT (live 2026-10-16 and 2026-10-20, mailbox 2 = stuart@4lsg.com,
 * [Gmail]/All Mail): imapflow's fetchAll returns every untagged FETCH that
 * arrived while the command ran — including an unsolicited flag update for the
 * SAME UID (Stuart answered / opened the message while the tick fetched it).
 * The transport kept the last row per UID, so the flag-only row replaced the
 * data: an envelope-less row was stored (mail_messages 790 and 1077), the
 * provider-id guard never emitted it, and the cursor moved past it. One was a
 * Chapter 13 trustee's email. The Apps Script logged both, so nothing was lost
 * from the case log this time; with the Apps Script retired, both would have
 * been (ref/MAILBOX_GMAIL_PARITY.md §4).
 *
 * Three layers:
 *   1. THE LIBRARY PIN — imapflow 2.3.0's REAL fetch command + REAL parser
 *      (only the socket is replaced: the S1-G pin's technique): a data row then
 *      a flag-only row for one UID come back as TWO rows. If an imapflow upgrade
 *      starts folding them itself, this breaks first.
 *   2. THE TRANSPORT — fetchMessages / fetchLabels / listMessageIds, over that
 *      same real parser (the live wire sequence through the session facade) and
 *      over a plain fake client for the re-ask and INCOMPLETE_FETCH paths.
 *   3. THE WORKER — the REAL mailboxIngestService over the REAL transport (a
 *      fake ImapFlow client through `factory`, its fetchAll answered by the real
 *      parser) over the S1 world's fake MySQL (tests/helpers/mailboxS1World.js);
 *      mocked are only emailIngestService.ingestEmail (the world's deduping
 *      pipeline) and lib/alerting. The 10-16 tick replayed stores and emits the
 *      message; a UID answered with flag updates only, twice, stores nothing
 *      from its batch, holds the cursor, and is stored and emitted once on the
 *      next tick; a UID the server NEVER sends is quarantined on the Nth tick
 *      and the rest of its batch flows on the next (tests/mailboxPoison.test.js
 *      covers the guard itself).
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - the ORIGINAL transport (last row per UID, no re-ask)   → "the 10-16 tick replayed …":
 *       stored 1, emitted 0, noProviderId 1 — production's signature
 *   - mergeFetchRows keeps the last row (byUid.set)           → "later attributes win …",
 *       "the live 10-16 sequence …", "fetchLabels keeps the labels …", "the 10-16 tick replayed …"
 *   - the re-ask removed (partial UIDs thrown at once)        → "a UID answered with flag updates only is asked once more …"
 *   - INCOMPLETE_FETCH never thrown (partial UIDs returned)   → "still flag updates only → INCOMPLETE_FETCH …",
 *       "gone by the re-ask → INCOMPLETE_FETCH too …", "flag updates only, twice: nothing from the batch …"
 *   - listMessageIds back to one entry per ROW                → "listMessageIds: one entry per UID …"
 *   - processUids ignores the quarantine (no skip)           → "a UID the server never sends …"
 *   - fetchLabels back to last-wins                           → "fetchLabels keeps the labels …"
 * ("flags first, data second" passes under last-wins by construction — the
 * data row is last there; it pins that merging never drops data.)
 */

'use strict';

jest.mock('../services/emailIngestService', () => ({ ingestEmail: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const { encrypt } = require('../lib/credentialCrypto');
const T = require('../services/mailbox/imapTransport');
const emailIngestService = require('../services/emailIngestService');
const { alert } = require('../lib/alerting');
const svc = require('../services/mailbox/mailboxIngestService');
const { makeWorld, makePipeline } = require('./helpers/mailboxS1World');
const { realFetch, FakeImapFlow, dataLine, flagsLine, dec } = require('./helpers/imapWire');

const ALL = '[Gmail]/All Mail';
const UID = 188961;
// Live-shaped Gmail ids (the hex of a 64-bit X-GM-MSGID).
const HEX = '1a1454d7167dd8b5';
const DEC = dec(HEX);
const HEX2 = '1a1455534b0a95fc';
const DEC2 = dec(HEX2);

let clients;
let script;
const realCreate = T.factory.create;
beforeEach(() => {
  clients = [];
  script = { uidNext: UID + 2 };
  T.factory.create = (opts) => { const c = new FakeImapFlow(opts, script); clients.push(c); return c; };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { T.factory.create = realCreate; jest.restoreAllMocks(); });

const boxRow = (over = {}) => ({
  id: 2, address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', imap_port: 993,
  imap_user: 'stuart@4lsg.com', imap_secret: encrypt('Gm@il-App-Pass-q7'), ingest_state: null, ...over,
});
const calls = (name) => clients.flatMap(c => c.calls).filter(c => c[0] === name);

// ─────────────────────────────────────────────────────────────────────────────
// 1. imapflow 2.3.0, for real
// ─────────────────────────────────────────────────────────────────────────────

describe('imapflow 2.3.0 pin: an unsolicited flag update is a second row for the same UID', () => {
  test('data row then flag-only row → two rows; the second has no envelope, no X-GM-MSGID, no labels', async () => {
    const { wire, rows } = await realFetch(['IMAP4rev1', 'X-GM-EXT-1'], String(UID),
      { uid: true, envelope: true, flags: true, labels: true }, { uid: true }, [dataLine(UID, DEC), flagsLine(UID)]);
    expect(wire).toContain(`UID FETCH ${UID}`);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.uid)).toEqual([UID, UID]);
    expect(rows[0].emailId).toBe(DEC);
    expect(rows[0].envelope.subject).toBe('Re: adjourning the hearing');
    expect(rows[1].envelope).toBeUndefined();
    expect(rows[1].emailId).toBeUndefined();
    expect(rows[1].labels).toBeUndefined();
    expect([...rows[1].flags]).toEqual(['\\Seen', '\\Answered']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The transport
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeFetchRows', () => {
  test('later attributes win, missing ones never erase, unwanted and uid-less rows are dropped', () => {
    const a = { uid: 5, envelope: { subject: 'x' }, emailId: '1', flags: new Set(['\\Seen']), labels: null };
    const b = { uid: 5, flags: new Set(['\\Seen', '\\Answered']), envelope: undefined, labels: new Set(['L']) };
    const m = T.mergeFetchRows([a, b, { uid: 6, envelope: {} }, { flags: new Set() }, { uid: 'x' }], new Set([5]));
    expect([...m.keys()]).toEqual([5]);
    expect(m.get(5).envelope).toEqual({ subject: 'x' });
    expect(m.get(5).emailId).toBe('1');
    expect([...m.get(5).flags]).toEqual(['\\Seen', '\\Answered']);
    expect([...m.get(5).labels]).toEqual(['L']);
    expect(a.flags.has('\\Answered')).toBe(false); // the input rows are not mutated
  });
});

describe('fetchMessages folds every row of a UID', () => {
  test('the live 10-16 sequence (data, then the flag update) through the real parser → one complete message', async () => {
    script.fetches = [[dataLine(UID, DEC), flagsLine(UID)]];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.fetchMessages([UID]); });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      uid: UID, providerId: HEX, labels: ['\\Inbox', 'Court Notices'], size: 4321, draft: false,
      flags: ['seen', 'answered'], // the flag update is current, so it wins
      envelope: { subject: 'Re: adjourning the hearing', messageId: `m${UID}@trustee.test`,
        from: [{ name: 'Trustee Staff', address: 'staff@trustee.test' }] },
      text: `body ${UID}`,
    });
    expect(calls('fetchAll')).toHaveLength(1); // complete on the first FETCH: no re-ask
  });

  test('flags first, data second → the same complete message (the data is never dropped)', async () => {
    script.fetches = [[flagsLine(UID), dataLine(UID, DEC)]];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.fetchMessages([UID]); });
    expect(out[0]).toMatchObject({ uid: UID, providerId: HEX, envelope: { messageId: `m${UID}@trustee.test` } });
    expect(calls('fetchAll')).toHaveLength(1);
  });

  test('a UID answered with flag updates only is asked once more — for that UID alone — and merged', async () => {
    script.fetches = [[flagsLine(UID), dataLine(UID + 1, DEC2, 'other')], [dataLine(UID, DEC)]];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.fetchMessages([UID, UID + 1]); });
    expect(out.map(m => [m.uid, m.providerId])).toEqual([[UID, HEX], [UID + 1, HEX2]]);
    expect(out[0].flags).toEqual(['seen']); // the re-ask's answer is the newer one
    const fa = calls('fetchAll');
    expect(fa.map(c => c[1])).toEqual([`${UID},${UID + 1}`, String(UID)]);
    expect(fa[1][2]).toEqual(fa[0][2]); // the same query: the re-ask fetches everything again
  });

  test('still flag updates only → INCOMPLETE_FETCH (sanitized, transient, names the UID); nothing returned or downloaded', async () => {
    script.fetches = [[flagsLine(UID), dataLine(UID + 1, DEC2, 'other')], [flagsLine(UID)]];
    let err = null;
    await T.withMailbox(boxRow(), async (s) => {
      await s.openFolder(ALL);
      await s.fetchMessages([UID, UID + 1]).catch((e) => { err = e; });
    });
    expect(err).toMatchObject({ code: 'INCOMPLETE_FETCH', imap: true, sanitized: true, transient: true, uids: [UID] });
    expect(err.message).toContain(String(UID));
    expect(calls('download')).toHaveLength(0); // not even the complete batch-mate: the batch is retried whole
    expect(calls('logout')).toHaveLength(1);
  });

  test('gone by the re-ask → INCOMPLETE_FETCH too (the next run\'s SEARCH decides, not this one)', async () => {
    script.fetches = [[flagsLine(UID)], []];
    let err = null;
    await T.withMailbox(boxRow(), async (s) => {
      await s.openFolder(ALL);
      await s.fetchMessages([UID]).catch((e) => { err = e; });
    });
    expect(err).toMatchObject({ code: 'INCOMPLETE_FETCH', uids: [UID] });
  });

  test('a UID with no row at all is still simply absent — no re-ask, no error', async () => {
    script.fetches = [[dataLine(UID + 1, DEC2, 'other')]];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.fetchMessages([UID, UID + 1]); });
    expect(out.map(m => m.uid)).toEqual([UID + 1]);
    expect(calls('fetchAll')).toHaveLength(1);
  });

  test('unsolicited rows for OTHER UIDs are still dropped', async () => {
    script.fetches = [[dataLine(UID, DEC), flagsLine(UID + 7)]];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.fetchMessages([UID]); });
    expect(out.map(m => m.uid)).toEqual([UID]);
    expect(calls('fetchAll')).toHaveLength(1);
  });
});

describe('the other two readers fold the same way', () => {
  test('fetchLabels keeps the labels when a flag update follows them', async () => {
    script.fetches = [[
      `* 3 FETCH (UID ${UID} X-GM-MSGID ${DEC} X-GM-LABELS ("\\\\Inbox" "Court Notices"))`,
      flagsLine(UID),
    ]];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.fetchLabels([UID]); });
    expect(out).toEqual([{ uid: UID, providerId: HEX, labels: ['\\Inbox', 'Court Notices'] }]);
  });

  test('listMessageIds: one entry per UID, carrying the id a flag-only row lacks', async () => {
    script.stream = [
      { uid: 5, emailId: DEC, envelope: { messageId: '<m5@x>' } },
      { uid: 5, flags: new Set(['\\Seen']) },
      { uid: 6, flags: new Set(['\\Seen']) },
      { uid: 6, emailId: DEC2, envelope: { messageId: '<m6@x>' } },
      { uid: 7, envelope: {} },
    ];
    let out;
    await T.withMailbox(boxRow(), async (s) => { await s.openFolder(ALL); out = await s.listMessageIds(); });
    expect(out).toEqual([
      { uid: 5, messageId: 'm5@x', providerId: HEX },
      { uid: 6, messageId: 'm6@x', providerId: HEX2 },
      { uid: 7, messageId: null, providerId: null },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The worker, over the real transport
// ─────────────────────────────────────────────────────────────────────────────

describe('the worker over the real transport (mailbox 2, All Mail, emitting under gmail-firm)', () => {
  let W; let P;
  beforeEach(() => {
    W = makeWorld();
    P = makePipeline(W);
    emailIngestService.ingestEmail.mockReset().mockImplementation(P.ingestEmail);
    alert.mockClear();
    delete process.env.MAILBOX_INGEST_BATCH_SIZE;
    delete process.env.MAILBOX_INGEST_BUDGET_MS;
  });

  const box = () => W.addMailbox({
    address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', imap_user: 'stuart@4lsg.com',
    imap_secret: encrypt('Gm@il-App-Pass-q7'),
    emit_source_name: 'gmail-firm', emit_id_kind: 'provider',
    ingest_folders: { [ALL]: { emit_to_rules: true, backfill: false } },
    ingest_state: { [ALL]: { uidvalidity: 12, last_uid: UID - 1 } },
  });
  const run = () => svc.runIngest(W.db, {});
  const alertsOf = (kind) => alert.mock.calls.map(c => c[1]).filter(a => a.kind === kind);

  test('the 10-16 tick replayed: stored whole, emitted under gmail-firm, no provider-id alert', async () => {
    const id = box();
    script.uids = [UID];
    script.fetches = [[dataLine(UID, DEC), flagsLine(UID)]];
    const s = await run();

    expect(s).toMatchObject({ stored: 1, emitted: 1, errors: 0, noProviderId: 0 });
    const rows = W.rows(id, ALL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uid: UID, provider_id: HEX, message_id: `m${UID}@trustee.test`,
      subject: 'Re: adjourning the hearing', flags: 'seen,answered',
    });
    expect(rows[0].from_addr).toContain('staff@trustee.test');
    expect(rows[0].log_id).not.toBeNull();
    expect(P.envelopes.map(e => [e.source, e.headers.message_id])).toEqual([['gmail-firm', HEX]]);
    expect(alertsOf('mailbox_ingest_no_provider_id')).toHaveLength(0);
    expect(W.state(id)[ALL].last_uid).toBe(UID);
  });

  test('flag updates only, twice: nothing from the batch is stored, the cursor holds, the next tick stores and emits once', async () => {
    const id = box();
    script.uids = [UID, UID + 1];
    script.uidNext = UID + 2;
    // tick 1: UID gets flag updates only — on the FETCH and on the re-ask
    script.fetches = [[flagsLine(UID), dataLine(UID + 1, DEC2, 'other')], [flagsLine(UID)]];
    const s1 = await run();

    expect(s1).toMatchObject({ stored: 0, emitted: 0, noProviderId: 0 });
    expect(W.rows(id, ALL)).toHaveLength(0);
    expect(P.envelopes).toHaveLength(0);
    const st1 = W.state(id)[ALL];
    expect(st1.last_uid).toBe(UID - 1);
    expect(st1.errors).toBe(1);
    expect(st1.last_error).toContain('INCOMPLETE_FETCH');
    expect(s1.details.find(d => d.folder === ALL)).toMatchObject({ outcome: 'error' });
    expect(alertsOf('mailbox_ingest_no_provider_id')).toHaveLength(0);

    // tick 2: the server answers normally
    script.fetches = [[dataLine(UID, DEC), dataLine(UID + 1, DEC2, 'other')]];
    const s2 = await run();

    expect(s2).toMatchObject({ stored: 2, emitted: 2, errors: 0, noProviderId: 0 });
    expect(W.rows(id, ALL).map(r => [r.uid, r.provider_id])).toEqual([[UID, HEX], [UID + 1, HEX2]]);
    expect(P.envelopes.map(e => e.headers.message_id)).toEqual([HEX, HEX2]); // each exactly once
    const st2 = W.state(id)[ALL];
    expect(st2.last_uid).toBe(UID + 1);
    expect(st2.errors).toBeUndefined();
  });

  test('a UID the server never sends: quarantined on the Nth tick (POISON MESSAGES), then the rest of its batch flows', async () => {
    const id = box();
    script.uids = [UID, UID + 1];
    script.uidNext = UID + 2;
    const N = svc.limits.quarantineAfter;
    for (let i = 1; i <= N; i++) {
      // every tick: flag updates only for UID, on the FETCH and on the re-ask
      script.fetches = [[flagsLine(UID), dataLine(UID + 1, DEC2, 'other')], [flagsLine(UID)]];
      await run();
      expect(W.rows(id, ALL)).toHaveLength(0);
      expect(W.state(id)[ALL].last_uid).toBe(UID - 1);
    }
    const st = W.state(id)[ALL];
    expect(st.quarantined).toEqual([expect.objectContaining({ uid: UID, uidvalidity: 12, attempts: N, message_id: null })]);
    expect(st.quarantined[0].error).toContain('INCOMPLETE_FETCH');
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(1);
    expect(alertsOf('mailbox_ingest_quarantined')[0]).toMatchObject({ severity: 'error' });

    const before = calls('fetchAll').length;
    script.fetches = [[dataLine(UID + 1, DEC2, 'other')]];
    const s = await run();
    expect(s).toMatchObject({ stored: 1, emitted: 1, errors: 0, quarantineSkipped: 1 });
    const asked = calls('fetchAll').slice(before);
    expect(asked).toHaveLength(1);
    expect(String(asked[0][1])).toBe(String(UID + 1)); // the quarantined UID is never asked for again
    expect(W.rows(id, ALL).map(r => [r.uid, r.provider_id])).toEqual([[UID + 1, HEX2]]);
    expect(P.envelopes.map(e => e.headers.message_id)).toEqual([HEX2]);
    expect(W.state(id)[ALL].last_uid).toBe(UID + 1);
  });
});
