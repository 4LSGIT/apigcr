// tests/mailboxS1G.ingest.test.js
//
/**
 * Mailbox system S1-G — Gmail second pilot: per-mailbox emission identity,
 * the provider-id guard, the backlog policy, provider-aware re-key and the
 * failure-severity rider (services/mailbox/mailboxIngestService.js).
 * Run: npx jest tests/mailboxS1G.ingest.test.js
 *
 * HARNESS: the S1 one (tests/helpers/mailboxS1World.js) — the REAL worker and
 * REAL lib/withTransaction over a stateful fake MySQL that throws on any
 * statement it does not know; mocked are only the IMAP transport (fake
 * account, same session contract), emailIngestService.ingestEmail (a fake
 * pipeline deduping on (source, message_id) exactly like email_log) and
 * lib/alerting. The world carries a `gmail-firm` source (id 1) beside
 * `mailbox-imap` (id 3); "the Apps Script adapter posted it" is modelled by
 * calling the fake pipeline under gmail-firm before the worker runs.
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - provider guard removed                  → "no provider id: stored, counted, alerted — never emitted"
 *   - RFC fallback (emitKeyOf provider → RFC)  → "no provider id: stored, counted, alerted — never emitted"
 *   - override forces Sent to emit            → "Sent never emits under the override, but bridges to the GAS row"
 *   - emission ignores the override           → "the Apps Script copy and the worker copy collide"
 *   - error row keyed by RFC id               → "a pipeline throw writes its error row under the emit key"
 *   - backfill:false ignored at first sight   → "backfill:false: first sight stores nothing old"
 *   - re-key floor ignored                    → "re-key of a backfill:false folder stores only above the floor"
 *   - planRekey ignores provider ids          → "provider ids re-map where Message-IDs are ambiguous"
 *   - soleFeederSources ignored               → "severity rider: …"
 *   - buildEnvelope stops using emitText      → "previewEmission's text IS the emitted text"
 */

'use strict';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../services/emailIngestService', () => ({ ingestEmail: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const transport = require('../services/mailbox/imapTransport');
const emailIngestService = require('../services/emailIngestService');
const { alert } = require('../lib/alerting');
const svc = require('../services/mailbox/mailboxIngestService');
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
  alert.mockClear();
  svc.limits.soleFeederSources = [];
  delete process.env.MAILBOX_INGEST_BATCH_SIZE;
  delete process.env.MAILBOX_INGEST_BUDGET_MS;
});
afterEach(() => { svc.limits.soleFeederSources = []; jest.restoreAllMocks(); });

const run = (opts) => svc.runIngest(W.db, opts);
const SENT = '[Gmail]/Sent Mail';
const GMAIL = { emit_source_name: 'gmail-firm', emit_id_kind: 'provider' };
const hex = (n) => (0x1a11d045dc6887d0n + BigInt(n)).toString(16);
const gmsg = (uid, over = {}) => msg(uid, { providerId: hex(uid), ...over });
const alertsOf = (kind) => alert.mock.calls.map(c => c[1]).filter(a => a.kind === kind);

/** The Gmail pilot mailbox, cursors primed (no first-sight baselining). */
function gmailBox(over = {}, folders = { INBOX: { emit_to_rules: true }, [SENT]: { emit_to_rules: false } }) {
  return W.addMailbox({
    address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', ...GMAIL,
    ingest_folders: folders,
    ingest_state: Object.fromEntries(Object.keys(folders).map(f => [f, { uidvalidity: 9, last_uid: 0 }])),
    ...over,
  });
}

/** What the Apps Script adapter does for the same mail: POST under gmail-firm, key = Gmail id. */
async function gasPosts(providerId) {
  return P.ingestEmail(W.db, { id: 1, name: 'gmail-firm' }, { headers: { message_id: providerId } });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('emission identity', () => {
  test('override: emitted under gmail-firm, keyed by the hex X-GM-MSGID; RFC id kept as provenance', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    S.deliver('INBOX', gmsg(1));
    const s = await run();

    expect(s).toMatchObject({ stored: 1, emitted: 1, errors: 0, noProviderId: 0 });
    expect(s.emitSources).toEqual({ 'gmail-firm': 'ok' });
    const env = P.envelopes[0];
    expect(env).toMatchObject({
      source: 'gmail-firm',
      headers: { message_id: hex(1) },
      mailbox: { id, folder: 'INBOX', uid: 1, id_kind: 'provider', provider_id: hex(1), rfc_message_id: 'm1@example.com' },
    });
    expect(W.T.email_ingest_executions[0]).toMatchObject({ source_id: 1, message_id: hex(1), status: 'logged' });
    const row = W.rows(id, 'INBOX')[0];
    expect(row).toMatchObject({ provider_id: hex(1), message_id: 'm1@example.com' });
    expect(row.log_id).toBe(W.T.email_ingest_executions[0].log_id);
    expect(s.details.find(d => d.folder === 'INBOX')).toMatchObject({ emit_source: 'gmail-firm', emit_id_kind: 'provider' });
  });

  test('the Apps Script copy and the worker copy collide: one logged execution + one duplicate, row bridged', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    const gas = await gasPosts(hex(1));           // GAS got there first
    S.deliver('INBOX', gmsg(1));
    const s = await run();

    expect(s.pipeline).toEqual({ duplicate: 1 });
    const execs = W.T.email_ingest_executions;
    expect(execs.map(e => [e.source_id, e.message_id, e.status])).toEqual([
      [1, hex(1), 'logged'], [1, hex(1), 'duplicate'],
    ]);
    expect(W.rows(id, 'INBOX')[0].log_id).toBe(gas.logId); // recovered from the GAS execution
  });

  test('default mailbox on a Gmail server: provider_id is captured but emission is unchanged (mailbox-imap + RFC id)', async () => {
    S.addFolder('INBOX', 9, []);
    const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 0 } } });
    S.deliver('INBOX', gmsg(1));
    await run();
    expect(P.envelopes[0]).toMatchObject({ source: 'mailbox-imap', headers: { message_id: 'm1@example.com' }, mailbox: { id_kind: 'rfc' } });
    expect(W.T.email_ingest_executions[0].source_id).toBe(3);
    expect(W.rows(id, 'INBOX')[0].provider_id).toBe(hex(1));
  });

  test('non-Gmail server (no provider ids): rows keep provider_id NULL and S1 emission is untouched', async () => {
    S.providerIdKind = null;
    S.addFolder('INBOX', 9, []);
    const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 0 } } });
    S.deliver('INBOX', msg(1));
    const s = await run();
    expect(s).toMatchObject({ emitted: 1, noProviderId: 0 });
    expect(P.envelopes[0].headers.message_id).toBe('m1@example.com');
    expect(W.rows(id, 'INBOX')[0].provider_id).toBeNull();
  });
});

describe('the provider-id guard', () => {
  test('no provider id: stored, counted, alerted — never emitted, never under the RFC id', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    S.deliver('INBOX', msg(1));          // no providerId
    S.deliver('INBOX', gmsg(2));         // a normal one after it
    const s = await run();

    expect(P.envelopes.map(e => e.headers.message_id)).toEqual([hex(2)]);
    expect(s).toMatchObject({ stored: 2, emitted: 1, noProviderId: 1, errors: 1 });
    expect(s.details.find(d => d.folder === 'INBOX').no_provider_id).toBe(1);
    expect(W.T.email_ingest_executions.every(e => e.message_id !== 'm1@example.com')).toBe(true);
    const st = W.state(id).INBOX;
    expect(st).toMatchObject({ last_uid: 2, no_provider_id_total: 1, last_no_provider_id_uid: 1 });
    expect(W.rows(id, 'INBOX').find(r => r.uid === 1).log_id).toBeNull();
    const a = alertsOf('mailbox_ingest_no_provider_id');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: 'warning', ref_table: 'mailboxes', ref_id: id });
    expect(a[0].dedup_key).toMatch(new RegExp(`^mailbox_ingest_no_provider_id:${id}:\\d{4}-\\d{2}-\\d{2}$`));
    // Not retried later: the cursor is past it.
    P.envelopes.length = 0;
    await run();
    expect(P.envelopes).toEqual([]);
  });

  test('override on a server without X-GM-EXT-1: every new message is stored, none emitted', async () => {
    S.providerIdKind = null;
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    S.deliver('INBOX', msg(1)); S.deliver('INBOX', msg(2));
    const s = await run();
    expect(P.envelopes).toEqual([]);
    expect(s).toMatchObject({ stored: 2, emitted: 0, noProviderId: 2 });
    expect(W.rows(id, 'INBOX').map(r => r.provider_id)).toEqual([null, null]);
  });

  test('a pipeline throw writes its error row under the emit key (source + provider id)', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    gmailBox();
    S.deliver('INBOX', gmsg(1));
    P.throwFor = () => new Error('logService exploded');
    await run();
    const err = W.T.email_ingest_executions.find(e => e.status === 'error');
    expect(err).toMatchObject({ source_id: 1, message_id: hex(1) });
  });
});

describe('folders under the override', () => {
  test('Sent never emits under the override, but bridges to the GAS row', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    const gas = await gasPosts(hex(7));  // GAS posted the firm's reply from its thread
    S.deliver(SENT, gmsg(7, { from: [{ name: 'Stuart', address: 'stuart@4lsg.com' }] }));
    const s = await run();
    expect(P.envelopes.filter(e => e.mailbox)).toEqual([]); // the worker emitted nothing (GAS's post has no mailbox block)
    expect(s.emitted).toBe(0);
    expect(W.rows(id, SENT)[0]).toMatchObject({ provider_id: hex(7), log_id: gas.logId });
  });

  test('one Gmail message in INBOX and Sent (same X-GM-MSGID): emitted once, both rows bridged', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    S.deliver('INBOX', gmsg(3));
    S.deliver(SENT, gmsg(3));
    await run();
    expect(P.envelopes).toHaveLength(1);
    const lid = W.rows(id, 'INBOX')[0].log_id;
    expect(lid).not.toBeNull();
    expect(W.rows(id, SENT)[0].log_id).toBe(lid);
  });

  test('two Gmail messages sharing a Message-ID are two messages (provider id is the identity) — like GAS', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    S.deliver('INBOX', gmsg(1, { messageId: 'same@x' }));
    S.deliver('INBOX', gmsg(2, { messageId: 'same@x' }));
    const s = await run();
    expect(s).toMatchObject({ stored: 2, emitted: 2, duplicates: 0 });
    expect(W.rows(id, 'INBOX')).toHaveLength(2);
  });
});

describe('emit source states', () => {
  test('override source inactive: a per-source kill switch (stored, not emitted, not retro-emitted)', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    W.T.email_ingest_sources.find(x => x.name === 'gmail-firm').active = 0;
    S.deliver('INBOX', gmsg(1));
    const s = await run();
    expect(s.emitSources).toEqual({ 'gmail-firm': 'inactive' });
    expect(s).toMatchObject({ stored: 1, emitted: 0 });
    W.T.email_ingest_sources.find(x => x.name === 'gmail-firm').active = 1;
    await run();
    expect(P.envelopes).toEqual([]);
    expect(W.rows(id, 'INBOX')).toHaveLength(1);
  });

  test('override source missing: stored, flagged, one dated warning naming the source', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    gmailBox();
    W.T.email_ingest_sources = W.T.email_ingest_sources.filter(x => x.name !== 'gmail-firm');
    S.deliver('INBOX', gmsg(1));
    const s = await run();
    expect(s.emitSources['gmail-firm']).toBe('missing');
    expect(s.emitted).toBe(0);
    const a = alertsOf('mailbox_ingest_source_missing');
    expect(a).toHaveLength(1);
    expect(a[0].dedup_key).toMatch(/^mailbox_ingest_source_missing:gmail-firm:\d{4}-\d{2}-\d{2}$/);
  });

  test('a half-set or invalid override (DB edited by hand) emits nothing and alerts', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    gmailBox({ emit_id_kind: null });
    S.deliver('INBOX', gmsg(1));
    const s = await run();
    expect(P.envelopes).toEqual([]);
    expect(s.stored).toBe(1);
    expect(s.emitSources['gmail-firm']).toBe('misconfigured');
    expect(alertsOf('mailbox_ingest_source_missing')[0].title).toMatch(/misconfigured/);
  });

  test('emissionConfig: the pair, the kinds, provider never under mailbox-imap', () => {
    expect(svc.emissionConfig({})).toEqual({ sourceName: 'mailbox-imap', kind: 'rfc', misconfig: null });
    expect(svc.emissionConfig(GMAIL)).toEqual({ sourceName: 'gmail-firm', kind: 'provider', misconfig: null });
    expect(svc.emissionConfig({ emit_source_name: 'gmail-firm' }).misconfig).toMatch(/together/);
    expect(svc.emissionConfig({ emit_source_name: 'x', emit_id_kind: 'hex' }).misconfig).toMatch(/unknown/);
    expect(svc.emissionConfig({ emit_source_name: 'mailbox-imap', emit_id_kind: 'provider' }).misconfig).toMatch(/never/);
    expect(svc.emitKeyOf('provider', { providerId: null, envelope: { messageId: 'rfc@x' } })).toBeNull();
    expect(svc.emitKeyOf('rfc', { providerId: 'ab', envelope: { messageId: 'rfc@x' } })).toBe('rfc@x');
  });
});

describe('backlog policy (ingest_folders.<folder>.backfill)', () => {
  test('backfill:false: first sight stores nothing old; mail after the baseline is stored and emitted', async () => {
    S.addFolder('INBOX', 777, [gmsg(1), gmsg(2), gmsg(3)]);
    const id = W.addMailbox({ ...GMAIL, ingest_folders: { INBOX: { emit_to_rules: true, backfill: false } } });
    const s1 = await run();
    expect(s1).toMatchObject({ stored: 0, backfilled: 0, emitted: 0 });
    expect(W.rows(id, 'INBOX')).toEqual([]);
    const st = W.state(id).INBOX;
    expect(st).toMatchObject({ uidvalidity: 777, last_uid: 3, backfill_skipped_below: 4 });
    expect(st.backfill_uid).toBeUndefined();
    expect(S.fetchCalls).toEqual([]);

    S.deliver('INBOX', gmsg(4));
    const s2 = await run();
    expect(s2).toMatchObject({ stored: 1, emitted: 1, backfilled: 0 });
    expect(W.rows(id, 'INBOX').map(r => r.uid)).toEqual([4]);
  });

  test('backfill default (true) is S1 behaviour: history stored newest-first, never emitted', async () => {
    S.addFolder('INBOX', 777, [gmsg(1), gmsg(2)]);
    const id = W.addMailbox({ ...GMAIL, ingest_folders: { INBOX: { emit_to_rules: true } } });
    const s = await run();
    expect(s).toMatchObject({ backfilled: 2, emitted: 0 });
    expect(W.rows(id, 'INBOX')).toHaveLength(2);
  });

  test('re-key of a backfill:false folder stores only above the floor (the highest re-mapped UID)', async () => {
    const id = W.addMailbox({
      ...GMAIL,
      ingest_folders: { INBOX: { emit_to_rules: true, backfill: false } },
      ingest_state: { INBOX: { uidvalidity: 100, last_uid: 51, checked_at: '2026-10-05T12:00:00.000Z' } },
    });
    W.seq.mail_messages = 2;
    W.T.mail_messages.push(
      { id: 1, mailbox_id: id, folder: 'INBOX', uid: 50, message_id: 'r1@x', provider_id: hex(50), log_id: 7 },
      { id: 2, mailbox_id: id, folder: 'INBOX', uid: 51, message_id: 'r2@x', provider_id: hex(51), log_id: 8 },
    );
    // Renumbered: years of history at 1..3, our two stored rows at 4..5, new mail at 6.
    S.addFolder('INBOX', 200, [
      gmsg(1, { providerId: hex(901), internalDate: new Date('2019-01-01T00:00:00Z') }),
      gmsg(2, { providerId: hex(902), internalDate: new Date('2020-01-01T00:00:00Z') }),
      gmsg(3, { providerId: hex(903), internalDate: new Date('2021-01-01T00:00:00Z') }),
      gmsg(4, { providerId: hex(50), messageId: 'r1@x' }),
      gmsg(5, { providerId: hex(51), messageId: 'r2@x' }),
      gmsg(6, { providerId: hex(906), internalDate: new Date('2026-10-05T12:05:00Z') }),
    ]);
    const s = await run();
    expect(s.rekeyed).toBe(1);
    expect(W.rows(id, 'INBOX').map(r => [r.uid, r.provider_id])).toEqual([[4, hex(50)], [5, hex(51)], [6, hex(906)]]);
    expect(P.envelopes.map(e => e.headers.message_id)).toEqual([hex(906)]); // after checked_at → emitted
    const st = W.state(id).INBOX;
    expect(st.backfill_floor_uid).toBeUndefined(); // finished in the same run
    expect(st.backfill_uid).toBeUndefined();
  });

  test('re-key of a backfill:false folder with nothing re-mapped re-baselines (stores nothing old)', async () => {
    const id = W.addMailbox({
      ...GMAIL,
      ingest_folders: { INBOX: { emit_to_rules: true, backfill: false } },
      ingest_state: { INBOX: { uidvalidity: 100, last_uid: 9, checked_at: '2026-10-05T12:00:00.000Z' } },
    });
    S.addFolder('INBOX', 200, [gmsg(1), gmsg(2)]);
    const s = await run();
    expect(s.rekeyed).toBe(1);
    expect(W.rows(id, 'INBOX')).toEqual([]);
    expect(W.state(id).INBOX).toMatchObject({ uidvalidity: 200, last_uid: 2, backfill_skipped_below: 3 });
  });
});

describe('provider-aware re-key', () => {
  test('provider ids re-map where Message-IDs are ambiguous', () => {
    const plan = svc.planRekey(
      [
        { id: 1, uid: 1, message_id: 'dup@x', provider_id: 'aa' },
        { id: 2, uid: 2, message_id: 'dup@x', provider_id: 'bb' },
        { id: 3, uid: 3, message_id: 'solo@x', provider_id: null }, // pre-capture row: RFC match
        { id: 4, uid: 4, message_id: 'gone@x', provider_id: 'dd' },
      ],
      [
        { uid: 10, messageId: 'dup@x', providerId: 'bb' },
        { uid: 11, messageId: 'dup@x', providerId: 'AA' },  // case-insensitive
        { uid: 12, messageId: 'solo@x', providerId: 'cc' },
        { uid: 13, messageId: 'new@x', providerId: 'ee' },
      ]
    );
    expect(plan.remap.sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, oldUid: 1, newUid: 11 }, { id: 2, oldUid: 2, newUid: 10 }, { id: 3, oldUid: 3, newUid: 12 },
    ]);
    expect(plan.orphans).toEqual([4]);
    expect(plan.unmatchedUids).toEqual([13]);
  });

  test('a server without provider ids falls back to Message-IDs for every row (S1 behaviour)', () => {
    const plan = svc.planRekey(
      [{ id: 1, uid: 1, message_id: 'a@x', provider_id: 'aa' }],
      [{ uid: 5, messageId: 'a@x', providerId: null }]
    );
    expect(plan.remap).toEqual([{ id: 1, oldUid: 1, newUid: 5 }]);
  });
});

describe('severity rider (limits.soleFeederSources)', () => {
  async function failFiveTimes() {
    S.failConnect = Object.assign(new Error('IMAP AUTHENTICATIONFAILED'), { code: 'AUTHENTICATIONFAILED', imap: true, sanitized: true });
    for (let i = 0; i < svc.limits.alertAfter; i++) await run();
    return alertsOf('mailbox_ingest_failing');
  }

  test('before retirement (default []): an INBOX streak on the Gmail box is a warning', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    gmailBox();
    const a = await failFiveTimes();
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe('warning');
  });

  test("after the retirement flip (['gmail-firm']): the same streak is an error", async () => {
    svc.limits.soleFeederSources = ['gmail-firm'];
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    gmailBox();
    const a = await failFiveTimes();
    expect(a[0].severity).toBe('error');
  });

  test('…but only for emitting folders and only for mailboxes emitting under that source', async () => {
    svc.limits.soleFeederSources = ['gmail-firm'];
    S.addFolder(SENT, 9, []);
    gmailBox({}, { [SENT]: { emit_to_rules: false } });      // store-only box
    W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 0 } } }); // default source box
    const a = await failFiveTimes();
    expect(a.map(x => x.severity)).toEqual(['warning', 'warning']);
  });
});

describe('previewEmission (the pre-emission text-parity check)', () => {
  test("previewEmission's text IS the emitted text (HTML-only court mail), keyed like the emission", async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder(SENT, 9, []);
    const id = gmailBox();
    const html = '<html><body><p>Case Name: John Q. Public</p><table><tr><td>Trustee:</td><td>Jane Doe with notes</td></tr></table></body></html>';
    S.deliver('INBOX', gmsg(1, { text: null, html, from: [{ name: 'Court', address: 'mieb_ecfadmin@mieb.uscourts.gov' }] }));
    await run();
    const stored = W.rows(id, 'INBOX')[0];
    const p = await svc.previewEmission(W.db, id, stored.id);
    expect(p.text).toBe(P.envelopes[0].text);
    expect(p).toMatchObject({
      text_derived_from_html: true, provider_id: hex(1), message_id: 'm1@example.com',
      emit: { source: 'gmail-firm', id_kind: 'provider', key: hex(1), misconfig: null, folder_emits: true },
    });
    expect(p.text).toMatch(/Case Name[^A-Za-z]+John Q\. Public/);
  });

  test('default mailbox → key is the RFC id; unknown message → null', async () => {
    S.addFolder('INBOX', 9, []);
    const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 0 } } });
    S.deliver('INBOX', msg(1, { text: 'plain' }));
    await run();
    const p = await svc.previewEmission(W.db, id, W.rows(id, 'INBOX')[0].id);
    expect(p.emit).toMatchObject({ source: 'mailbox-imap', id_kind: 'rfc', key: 'm1@example.com' });
    expect(p).toMatchObject({ text: 'plain', text_derived_from_html: false });
    expect(await svc.previewEmission(W.db, id, 9999)).toBeNull();
    expect(await svc.previewEmission(W.db, 9999, 1)).toBeNull();
  });

  test('emitText: text part wins; empty text + HTML → derived; nothing → empty', () => {
    expect(svc.emitText('a', '<p>b</p>')).toEqual({ text: 'a', derived: false });
    expect(svc.emitText('', '<p>b</p>')).toEqual({ text: 'b', derived: true });
    expect(svc.emitText(null, null)).toEqual({ text: '', derived: false });
  });
});

describe('folderConfig backfill', () => {
  test('backfill is false only when exactly false', () => {
    expect(svc.folderConfig({ INBOX: { emit_to_rules: true, backfill: false }, Sent: { emit_to_rules: false, backfill: 'no' } }))
      .toEqual([['INBOX', { emit_to_rules: true, backfill: false }], ['Sent', { emit_to_rules: false, backfill: true }]]);
  });
});
