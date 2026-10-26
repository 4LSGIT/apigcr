// tests/mailboxPoison.test.js
//
/**
 * Mailbox ingest — POISON MESSAGES (services/mailbox/mailboxIngestService.js
 * header). Run: npx jest tests/mailboxPoison.test.js
 *
 * THE DEFECT (live 2026-10-25, mailbox 2 = stuart@4lsg.com, [Gmail]/All
 * Mail): one message whose executions row MySQL refused (a lone surrogate)
 * threw on every tick. At-least-once retried it forever, the cursor stayed
 * below it, and nothing after it was stored or emitted for an hour — only the
 * Apps Script still fed the rules. Fixed for that message by 3e21408; this
 * suite pins the general guard: the new pass remembers the UID it failed on,
 * and after `limits.quarantineAfter` consecutive failures on that same UID it
 * quarantines it (skipped for good, one ERROR alert), so the folder moves on.
 * An outage, or a failure that names no message, never costs mail.
 *
 * HARNESS: the S1 one (tests/helpers/mailboxS1World.js) — the REAL worker and
 * REAL lib/withTransaction over a stateful fake MySQL; mocked are only the
 * IMAP transport (fake account, same session contract — its failFetchOnUid
 * hook throws the transport's own INCOMPLETE_FETCH shape),
 * emailIngestService.ingestEmail (the world's deduping pipeline; its
 * throwFor hook makes one message fail) and lib/alerting. The same guard over
 * the REAL transport: tests/mailboxFetchMerge.test.js ("a UID the server
 * never sends …").
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - trackPoison never quarantines (attempts only)   → "a message that throws on every tick …",
 *       "INCOMPLETE_FETCH: the lowest UID the server will not send …"
 *   - processUids ignores the quarantine (no skip)     → "a message that throws on every tick …",
 *       "INCOMPLETE_FETCH: …"
 *   - isOutage() always false                          → "an outage on the same message never quarantines …"
 *   - a no-message failure resets the count            → "a failure that names no message neither counts nor clears"
 *   - a different UID keeps counting (no same-uid test) → "a different, LOWER UID restarts the count too …"
 *   - skip set ignores UIDVALIDITY                     → "a quarantine record from an older UIDVALIDITY skips nothing"
 *   - re-key keeps st.poison                           → "a re-key drops the remembered failure"
 *   - backfill pass calls trackPoison                  → "the backfill pass never quarantines"
 *   - INCOMPLETE_FETCH stuck = the highest UID          → "INCOMPLETE_FETCH: the lowest UID …"
 *   - the streak alert not suppressed on quarantine    → "a message that throws on every tick …"
 *   - quarantine leaves the streak counting            → "the quarantine settles the streak …"
 *   - THE BRAKE removed (no prior-signature check)     → "THE BRAKE: a second message failing the same way …"
 *   - THE BRAKE keyed on nothing (any prior brakes)    → "…while a DIFFERENT failure on the next message …"
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
  P = makePipeline(W);
  transport.withMailbox.mockReset().mockImplementation(S.withMailbox);
  emailIngestService.ingestEmail.mockReset().mockImplementation(P.ingestEmail);
  alert.mockClear();
  delete process.env.MAILBOX_INGEST_BATCH_SIZE;
  delete process.env.MAILBOX_INGEST_BUDGET_MS;
});
afterEach(() => jest.restoreAllMocks());

const run = (opts) => svc.runIngest(W.db, opts);
const alertsOf = (kind) => alert.mock.calls.map(c => c[1]).filter(a => a.kind === kind);
const emitted = () => P.envelopes.map(e => e.headers.message_id);
const Q = () => svc.limits.quarantineAfter;

/** The live 2026-10-25 error, as mysql2 raises it (not an outage). */
const jsonRefused = () => Object.assign(
  new Error('Invalid JSON text: "The surrogate pair in string is invalid." at position 16383 in value for column \'email_ingest_executions.raw_input\'.'),
  { code: 'ER_INVALID_JSON_TEXT', errno: 3140, fatal: false }
);

/** INBOX feeding the rules (default source), cursor primed at 0, three new messages. */
function inboxWithThree(state = {}) {
  S.addFolder('INBOX', 9, []);
  const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 0, ...state } } });
  for (const u of [1, 2, 3]) S.deliver('INBOX', msg(u));
  return id;
}

describe('quarantine', () => {
  test('a message that throws on every tick: quarantined on the Nth consecutive failure, one error alert, then skipped for good', async () => {
    const id = inboxWithThree();
    P.throwFor = (env) => (env.headers.message_id === 'm2@example.com' ? jsonRefused() : null);

    for (let i = 1; i < Q(); i++) {
      const s = await run();
      expect(s).toMatchObject({ errors: 1, quarantined: 0 });
      const st = W.state(id).INBOX;
      expect(st.last_uid).toBe(1); // held below the failing message
      expect(st.poison).toMatchObject({ uid: 2, uidvalidity: 9, attempts: i, message_id: 'm2@example.com' });
      expect(st.poison.last_error).toMatch(/^ER_INVALID_JSON_TEXT: Invalid JSON text/);
      expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(0);
    }

    const sQ = await run(); // the Nth
    expect(sQ).toMatchObject({ errors: 1, quarantined: 1 });
    expect(sQ.details.find(d => d.folder === 'INBOX')).toMatchObject({ outcome: 'error', quarantined: 2 });
    const st = W.state(id).INBOX;
    expect(st.poison).toBeUndefined();
    expect(st.quarantined).toHaveLength(1);
    expect(st.quarantined[0]).toMatchObject({ uid: 2, uidvalidity: 9, attempts: Q(), message_id: 'm2@example.com' });
    expect(st.quarantined_total).toBe(1);
    const a = alertsOf('mailbox_ingest_quarantined');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      severity: 'error', ref_table: 'mailboxes', ref_id: id,
      group_key: `app:mailbox_ingest_quarantined:${id}`,
      dedup_key: `mailbox_ingest_quarantined:${id}:INBOX:9:2`,
      context: expect.objectContaining({ mailbox_id: id, folder: 'INBOX', uid: 2, emits: true }),
    });
    expect(a[0].message).toContain(`INBOX: UID 2 failed ${Q()} runs in a row and is now quarantined`);
    expect(a[0].message).toContain('Message-ID: m2@example.com (Gmail search: rfc822msgid:m2@example.com)');
    expect(a[0].message).toContain("Its emission under 'mailbox-imap' never completed — its rules may not have run.");
    expect(a[0].message).toContain('Quarantined messages');
    // the same run's streak alert is folded into the quarantine — one page, not two
    expect(Q()).toBe(svc.limits.alertAfterEmitting);
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);

    const tries = emitted().filter(m => m === 'm2@example.com').length;
    expect(tries).toBe(Q());
    const sNext = await run();
    expect(sNext).toMatchObject({ errors: 0, quarantineSkipped: 1, quarantined: 0 });
    expect(sNext.details.find(d => d.folder === 'INBOX')).toMatchObject({ outcome: 'ok', quarantine_skipped: 1 });
    expect(W.state(id).INBOX).toMatchObject({ last_uid: 3 });
    expect(W.state(id).INBOX.errors).toBeUndefined();
    expect(emitted().filter(m => m === 'm2@example.com')).toHaveLength(tries); // never tried again
    expect(emitted()).toContain('m3@example.com');
    // stored before it threw: kept, never linked to a log row
    const rows = W.rows(id, 'INBOX');
    expect(rows.map(r => r.uid)).toEqual([1, 2, 3]);
    expect(rows.find(r => r.uid === 2).log_id).toBeNull();
    expect(rows.find(r => r.uid === 3).log_id).not.toBeNull();
    // once the cursor is past it, later runs are ordinary
    const sLater = await run();
    expect(sLater).toMatchObject({ errors: 0, quarantineSkipped: 0 });
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(1);
  });

  test('INCOMPLETE_FETCH: the lowest UID the server will not send is quarantined; the messages below it in the batch still flow', async () => {
    const id = inboxWithThree();
    S.failFetchOnUid = 2;
    S.failFetchErr = Object.assign(
      new Error('IMAP INCOMPLETE_FETCH: no message data for UID 2, 3 (flag updates only) — will retry next run'),
      { code: 'INCOMPLETE_FETCH', imap: true, sanitized: true, transient: true, uids: [3, 2] }
    );
    for (let i = 1; i <= Q(); i++) await run();
    let st = W.state(id).INBOX;
    expect(st.last_uid).toBe(0); // the whole batch is held — UID 1 included
    expect(W.rows(id, 'INBOX')).toHaveLength(0);
    expect(st.quarantined.map(q => q.uid)).toEqual([2]);
    expect(st.quarantined[0].message_id).toBeNull();
    const a = alertsOf('mailbox_ingest_quarantined');
    expect(a).toHaveLength(1);
    expect(a[0].message).not.toContain('Message-ID');

    S.failFetchOnUid = null; // (the transport would now be asked for 1 and 3 only)
    const s = await run();
    expect(s).toMatchObject({ errors: 0, quarantineSkipped: 1, stored: 2, emitted: 2 });
    expect(S.fetchCalls[S.fetchCalls.length - 1]).toEqual([1, 3]);
    st = W.state(id).INBOX;
    expect(st.last_uid).toBe(3);
    expect(emitted()).toEqual(['m1@example.com', 'm3@example.com']);
  });
});

describe('after a quarantine', () => {
  test('the quarantine settles the streak: a later outage still pages at its threshold', async () => {
    const id = inboxWithThree();
    P.throwFor = (env) => (env.headers.message_id === 'm2@example.com' ? jsonRefused() : null);
    for (let i = 0; i < Q(); i++) await run();
    expect(W.state(id).INBOX.quarantined).toHaveLength(1);
    expect(W.state(id).INBOX.errors).toBeUndefined();
    expect(W.state(id).INBOX.last_error).toMatch(/ER_INVALID_JSON_TEXT/); // the record of the run stays

    S.failConnect = Object.assign(new Error('IMAP AUTHENTICATIONFAILED'), { code: 'AUTHENTICATIONFAILED', imap: true, sanitized: true });
    for (let i = 1; i <= svc.limits.alertAfterEmitting; i++) await run();
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'error' });
    expect(f[0].message).toMatch(new RegExp(`^INBOX \\(new\\): ${svc.limits.alertAfterEmitting} consecutive`));
  });

  test('THE BRAKE: a second message failing the same way is held, not quarantined — and the streak pages', async () => {
    const id = inboxWithThree();
    P.throwFor = () => jsonRefused(); // a bad deploy: every message fails alike
    for (let i = 0; i < Q(); i++) await run();
    expect(W.state(id).INBOX.quarantined.map(q => [q.uid, q.signature])).toEqual([[1, 'ER_INVALID_JSON_TEXT']]);

    for (let i = 0; i < Q() + 2; i++) await run();
    let st = W.state(id).INBOX;
    expect(st.last_uid).toBe(1); // held at UID 2
    expect(st.quarantined).toHaveLength(1);
    expect(st.poison).toMatchObject({ uid: 2, attempts: Q() + 2 });
    expect(st.poison.held).toMatch(/^same failure \(ER_INVALID_JSON_TEXT\) as quarantined UID 1 at .+: held, not quarantined$/);
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(1);
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('error');
    expect(f[0].message).toContain('(UID 2 same failure (ER_INVALID_JSON_TEXT) as quarantined UID 1');

    // past the brake window the next same-signature failure quarantines again (one per window)
    const later = Date.now() + svc.limits.quarantineBrakeMs + 60_000;
    const s = await run({ now: () => later });
    expect(s.quarantined).toBe(1);
    st = W.state(id).INBOX;
    expect(st.quarantined.map(q => q.uid)).toEqual([1, 2]);
    expect(st.poison).toBeUndefined();
  });

  test('…while a DIFFERENT failure on the next message is quarantined as usual', async () => {
    const id = inboxWithThree();
    P.throwFor = (env) => ({
      'm1@example.com': jsonRefused(),
      'm2@example.com': new TypeError("Cannot read properties of undefined (reading 'address')"),
    })[env.headers.message_id] || null;
    for (let i = 0; i < 2 * Q(); i++) await run();
    const st = W.state(id).INBOX;
    expect(st.quarantined.map(q => [q.uid, q.signature])).toEqual([
      [1, 'ER_INVALID_JSON_TEXT'],
      [2, "TypeError: Cannot read properties of undefined (reading 'address')"],
    ]);
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(2);
    expect(st.last_uid).toBe(1); // below UID 2 until the next run skips it
    await run();
    expect(W.state(id).INBOX.last_uid).toBe(3);
    expect(emitted().filter(m => m === 'm3@example.com')).toHaveLength(1);
  });
});

describe('what never quarantines', () => {
  test.each([
    ['a DB connection loss', () => Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })],
    ['a lock wait timeout', () => Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' })],
    ['a dead pooled connection (no code)', () => Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true })],
    ['an IMAP socket reset', () => Object.assign(new Error('IMAP ECONNRESET: socket hang up'), { code: 'ECONNRESET', imap: true, sanitized: true, transient: true })],
  ])('an outage on the same message never quarantines it (%s); the streak still pages', async (_name, mk) => {
    const id = inboxWithThree();
    P.throwFor = (env) => (env.headers.message_id === 'm2@example.com' ? mk() : null);
    for (let i = 0; i < Q() + 2; i++) await run();
    const st = W.state(id).INBOX;
    expect(st.poison).toBeUndefined();
    expect(st.quarantined).toBeUndefined();
    expect(st.last_uid).toBe(1);
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(0);
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('error');

    P.throwFor = null; // the outage ends: the message flows
    await run();
    expect(W.state(id).INBOX.last_uid).toBe(3);
    expect(emitted().filter(m => m === 'm3@example.com')).toHaveLength(1);
  });

  test('a failure that names no message neither counts nor clears', async () => {
    const id = inboxWithThree();
    P.throwFor = (env) => (env.headers.message_id === 'm2@example.com' ? jsonRefused() : null);
    for (let i = 1; i < Q(); i++) await run();
    expect(W.state(id).INBOX.poison.attempts).toBe(Q() - 1);

    S.failOpen.INBOX = Object.assign(new Error('IMAP NONEXISTENT: Mailbox doesn\'t exist: INBOX'), { code: 'NONEXISTENT', imap: true, sanitized: true });
    await run(); // the folder would not open
    expect(W.state(id).INBOX.poison.attempts).toBe(Q() - 1);
    delete S.failOpen.INBOX;

    S.failFetchOnUid = 2; // the batch FETCH fails as a whole, naming no message (not an outage either)
    S.failFetchErr = Object.assign(new Error('IMAP NO: [SERVERBUG] Internal error'), { code: 'NO', imap: true, sanitized: true, transient: false });
    await run();
    expect(W.state(id).INBOX.errors).toBe(Q() + 1);
    expect(W.state(id).INBOX.poison.attempts).toBe(Q() - 1);
    expect(W.state(id).INBOX.quarantined).toBeUndefined();

    S.failFetchOnUid = null;
    const s = await run();
    expect(s.quarantined).toBe(1);
    expect(W.state(id).INBOX.quarantined.map(q => q.uid)).toEqual([2]);
  });

  test('a different UID restarts the count; getting past it clears it', async () => {
    const id = inboxWithThree();
    let bad = 'm2@example.com';
    P.throwFor = (env) => (env.headers.message_id === bad ? jsonRefused() : null);
    for (let i = 1; i < Q(); i++) await run();
    expect(W.state(id).INBOX.poison).toMatchObject({ uid: 2, attempts: Q() - 1 });

    bad = 'm3@example.com'; // 2 now succeeds, 3 fails
    await run();
    let st = W.state(id).INBOX;
    expect(st.last_uid).toBe(2);
    expect(st.poison).toMatchObject({ uid: 3, attempts: 1 });
    expect(st.quarantined).toBeUndefined();

    bad = null;
    await run();
    st = W.state(id).INBOX;
    expect(st.last_uid).toBe(3);
    expect(st.poison).toBeUndefined();
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(0);
  });

  test('a different, LOWER UID restarts the count too (the server stopped sending another message of the batch)', async () => {
    const id = inboxWithThree();
    S.failFetchOnUid = 2;
    S.failFetchErr = Object.assign(new Error('IMAP INCOMPLETE_FETCH: no message data for UID 3'),
      { code: 'INCOMPLETE_FETCH', imap: true, sanitized: true, transient: true, uids: [3] });
    for (let i = 1; i < Q(); i++) await run();
    expect(W.state(id).INBOX).toMatchObject({ last_uid: 0, poison: { uid: 3, attempts: Q() - 1 } });

    S.failFetchErr = Object.assign(new Error('IMAP INCOMPLETE_FETCH: no message data for UID 2'),
      { code: 'INCOMPLETE_FETCH', imap: true, sanitized: true, transient: true, uids: [2] });
    await run();
    const st = W.state(id).INBOX;
    expect(st.poison).toMatchObject({ uid: 2, attempts: 1 });
    expect(st.quarantined).toBeUndefined();
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(0);
  });

  test('the backfill pass never quarantines (a stuck backfill only warns at alertAfter)', async () => {
    // History the server will not send one message of — every run, one per batch.
    process.env.MAILBOX_INGEST_BATCH_SIZE = '1';
    S.addFolder('INBOX', 9, [msg(1), msg(2), msg(3)]);
    const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 3, backfill_uid: 4 } } });
    S.failFetchOnUid = 2;
    S.failFetchErr = Object.assign(new Error('IMAP INCOMPLETE_FETCH: no message data for UID 2 (flag updates only)'),
      { code: 'INCOMPLETE_FETCH', imap: true, sanitized: true, transient: true, uids: [2] });
    for (let i = 0; i < svc.limits.alertAfter; i++) await run();
    const st = W.state(id).INBOX;
    expect(st.backfill_errors).toBe(svc.limits.alertAfter);
    expect(st.backfill_uid).toBe(3); // held at the failing message (descending)
    expect(st.poison).toBeUndefined();
    expect(st.quarantined).toBeUndefined();
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(0);
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning' });
    expect(f[0].message).toMatch(/^INBOX \(backfill\): 5 consecutive/);
  });
});

describe('UIDVALIDITY', () => {
  test('a quarantine record from an older UIDVALIDITY skips nothing', async () => {
    const id = inboxWithThree({
      quarantined: [{ uid: 2, uidvalidity: 8, attempts: 3, at: '2026-10-01T00:00:00.000Z', error: 'x', message_id: null }],
    });
    const s = await run();
    expect(s).toMatchObject({ errors: 0, quarantineSkipped: 0, emitted: 3 });
    expect(emitted()).toEqual(['m1@example.com', 'm2@example.com', 'm3@example.com']);
  });

  test('…while one from the current UIDVALIDITY is skipped (no fetch, no store, no emit)', async () => {
    const id = inboxWithThree({
      quarantined: [{ uid: 2, uidvalidity: 9, attempts: 3, at: '2026-10-01T00:00:00.000Z', error: 'x', message_id: null }],
    });
    const s = await run();
    expect(s).toMatchObject({ errors: 0, quarantineSkipped: 1, emitted: 2, stored: 2 });
    expect(S.fetchCalls).toEqual([[1, 3]]);
    expect(W.rows(id, 'INBOX').map(r => r.uid)).toEqual([1, 3]);
    expect(W.state(id).INBOX.last_uid).toBe(3);
  });

  test('a re-key drops the remembered failure', async () => {
    S.addFolder('INBOX', 10, [msg(1)]);
    const id = W.addMailbox({ ingest_state: { INBOX: {
      uidvalidity: 9, last_uid: 0, checked_at: '2026-10-01T00:00:00.000Z',
      poison: { uid: 2, uidvalidity: 9, attempts: 2, first_at: '2026-10-01T00:00:00.000Z', last_error: 'x' },
    } } });
    await run();
    const st = W.state(id).INBOX;
    expect(st.uidvalidity).toBe(10);
    expect(st.rekeyed_at).toBeTruthy();
    expect(st.poison).toBeUndefined();
  });
});

describe('limits', () => {
  test('quarantined records are capped at quarantineKeep (oldest dropped)', async () => {
    const saved = svc.limits.quarantineKeep;
    svc.limits.quarantineKeep = 2;
    try {
      S.addFolder('INBOX', 9, []);
      const old = [5, 6].map(uid => ({ uid, uidvalidity: 9, attempts: 3, at: '2026-10-01T00:00:00.000Z', error: 'x', message_id: null }));
      const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 6, quarantined: old, quarantined_total: 2 } } });
      S.deliver('INBOX', msg(7));
      P.throwFor = (env) => (env.headers.message_id === 'm7@example.com' ? jsonRefused() : null);
      for (let i = 0; i < Q(); i++) await run();
      const st = W.state(id).INBOX;
      expect(st.quarantined.map(q => q.uid)).toEqual([6, 7]);
      expect(st.quarantined_total).toBe(3);
    } finally {
      svc.limits.quarantineKeep = saved;
    }
  });
});
