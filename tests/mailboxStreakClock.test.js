// tests/mailboxStreakClock.test.js
//
/**
 * Mailbox ingest — the CLOCK half of FAILURE STREAKS and POISON MESSAGES
 * (services/mailbox/mailboxIngestService.js header). Run:
 *   npx jest tests/mailboxStreakClock.test.js
 *
 * WHY (the step-6 kit, ruled 2026-10-26; built 2026-11-08): the thresholds
 * were run counts, tuned for a 5-minute tick — 3 runs ≈ 15 min before IT is
 * paged, before a message is quarantined. Moving `mailbox-ingest` to every
 * 2 minutes would have made that 4–6 minutes: a Gmail blip that short would
 * page and could cost a message. Each threshold is now a run count AND a span
 * of time, so the cadence no longer moves either:
 *   - a folder feeding the rules: ERROR at alertAfterEmitting runs over alertAfterEmittingMs (10 min)
 *   - store-only / backfill:     warning at alertAfter runs over alertAfterMs (20 min)
 *   - a poison message:          quarantined at quarantineAfter runs over quarantineAfterMs (10 min)
 * The other mailbox suites zero the time knobs and pin the run counts; this
 * one runs the real knobs on a fake clock at the new cadence.
 *
 * HARNESS: the S1 one (tests/helpers/mailboxS1World.js) — the REAL worker
 * over a stateful fake MySQL and a fake IMAP account; time is `opts.now`.
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - the time gate dropped from the streak alert       → "an emitting folder at a 2-minute tick pages once, at 10 minutes …"
 *   - the run-count floor dropped (time alone)          → "the run count still gates: two failures 15 minutes apart …"
 *   - one alert per streak lost (no _alerted_at check)  → "an emitting folder at a 2-minute tick pages once …"
 *   - a good run keeps errors_since / errors_alerted_at → "… a good run clears the streak, and the next one waits its 10 minutes again"
 *   - a quarantine leaves the streak's clock running    → "a poison message at a 2-minute tick is quarantined at 10 minutes …"
 *   - store-only uses the emitting window               → "a store-only folder warns at 20 minutes …"
 *   - the time gate dropped from trackPoison            → "a poison message at a 2-minute tick is quarantined at 10 minutes …"
 *   - legacy since = now (not last_error_at)            → "a streak from before the clock: its last failure stands in for its start"
 *   - legacy streak past its count pages again          → "… one already past its run count was paged then, and is not paged again"
 *   - backfill streak reads errors_since                → "the backfill streak keeps its own clock …"
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

const MIN = 60_000;
const T0 = Date.parse('2026-11-09T15:00:00.000Z');
let W; let S; let P; let t;

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
  t = T0;
});
afterEach(() => jest.restoreAllMocks());

/** One tick at minute `m` past T0. */
const runAt = (m) => { t = T0 + m * MIN; return svc.runIngest(W.db, { now: () => t }); };
/** Ticks every `every` minutes over [from, to]. */
async function ticks(from, to, every = 2) { for (let m = from; m <= to; m += every) await runAt(m); }
const alertsOf = (kind) => alert.mock.calls.map(c => c[1]).filter(a => a.kind === kind);
const authFailed = () => Object.assign(new Error('IMAP AUTHENTICATIONFAILED'), { code: 'AUTHENTICATIONFAILED', imap: true, sanitized: true });
const iso = (m) => new Date(T0 + m * MIN).toISOString();

function emittingInbox(state = {}) {
  S.addFolder('INBOX', 9, []);
  return W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 0, ...state } } });
}

test('the shipped knobs: run counts unchanged, a time span on each, a budget under a 2-minute tick', () => {
  expect(svc.limits).toMatchObject({
    alertAfterEmitting: 3, alertAfterEmittingMs: 10 * MIN,
    alertAfter: 5, alertAfterMs: 20 * MIN,
    quarantineAfter: 3, quarantineAfterMs: 10 * MIN,
  });
  expect(svc.limits.defaultBudgetMs).toBeLessThan(2 * MIN);
});

describe('failure streaks on the clock', () => {
  test('an emitting folder at a 2-minute tick pages once, at 10 minutes — not at its 3rd run — a good run clears the streak, and the next one waits its 10 minutes again', async () => {
    const id = emittingInbox();
    S.failConnect = authFailed();
    await ticks(0, 8); // five failed runs, eight minutes
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);
    let st = W.state(id).INBOX;
    expect(st).toMatchObject({ errors: 5, errors_since: iso(0), last_error_at: iso(8) });
    expect(st.errors_alerted_at).toBeUndefined();

    await runAt(10);
    let f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('error');
    expect(f[0].message).toBe('INBOX (new): 6 consecutive failed runs over 10 min — IMAP AUTHENTICATIONFAILED');
    expect(W.state(id).INBOX.errors_alerted_at).toBe(iso(10));

    await ticks(12, 60); // the outage drags on: still one page
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(1);

    S.failConnect = null;
    await runAt(62);
    st = W.state(id).INBOX;
    for (const k of ['errors', 'errors_since', 'errors_alerted_at', 'last_error', 'last_error_at']) expect(st[k]).toBeUndefined();

    S.failConnect = authFailed(); // a new outage: a new streak, its own clock
    await ticks(64, 72);
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(1);
    expect(W.state(id).INBOX.errors_since).toBe(iso(64));
    await runAt(74);
    f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(2);
    expect(f[1].message).toMatch(/^INBOX \(new\): 6 consecutive failed runs over 10 min/);
  });

  test('a store-only folder warns at 20 minutes; an emitting one in the same outage errors at 10', async () => {
    const emits = emittingInbox();
    S.addFolder('Archive', 4, []);
    const store = W.addMailbox({
      ingest_folders: { Archive: { emit_to_rules: false } },
      ingest_state: { Archive: { uidvalidity: 4, last_uid: 0 } },
    });
    S.failConnect = authFailed();
    await ticks(0, 18);
    let f = alertsOf('mailbox_ingest_failing');
    expect(f.map(a => [a.ref_id, a.severity])).toEqual([[emits, 'error']]);
    expect(W.state(store).Archive.errors).toBe(10); // past alertAfter (5) long ago — the clock holds it

    await runAt(20);
    f = alertsOf('mailbox_ingest_failing');
    expect(f.map(a => [a.ref_id, a.severity])).toEqual([[emits, 'error'], [store, 'warning']]);
    expect(f[1].message).toBe('Archive (new): 11 consecutive failed runs over 20 min — IMAP AUTHENTICATIONFAILED');
  });

  test('the run count still gates: two failures 15 minutes apart (a stalled scheduler) do not page; the third does', async () => {
    emittingInbox();
    S.failConnect = authFailed();
    await runAt(0);
    await runAt(15);
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);
    await runAt(30);
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/^INBOX \(new\): 3 consecutive failed runs over 30 min/);
  });

  test('the backfill streak keeps its own clock (backfill_errors_since) and warns at 20 minutes', async () => {
    process.env.MAILBOX_INGEST_BATCH_SIZE = '1';
    S.addFolder('INBOX', 9, [msg(1), msg(2), msg(3)]);
    const id = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 9, last_uid: 3, backfill_uid: 4 } } });
    S.failFetchOnUid = 2;
    S.failFetchErr = Object.assign(new Error('IMAP INCOMPLETE_FETCH: no message data for UID 2 (flag updates only)'),
      { code: 'INCOMPLETE_FETCH', imap: true, sanitized: true, transient: true, uids: [2] });
    await ticks(0, 18);
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);
    const st = W.state(id).INBOX;
    expect(st).toMatchObject({ backfill_errors: 10, backfill_errors_since: iso(0) });
    expect(st.errors_since).toBeUndefined(); // the new pass is healthy
    await runAt(20);
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning' });
    expect(f[0].message).toMatch(/^INBOX \(backfill\): 11 consecutive failed runs over 20 min/);
    expect(W.state(id).INBOX.backfill_errors_alerted_at).toBe(iso(20));
  });
});

describe('a streak from before the clock (state written by the count-only build)', () => {
  test('a streak from before the clock: its last failure stands in for its start', async () => {
    const id = emittingInbox({ errors: 2, last_error: 'IMAP AUTHENTICATIONFAILED', last_error_at: iso(-12) });
    S.failConnect = authFailed();
    await runAt(0); // 3rd run; 12 minutes since the last failure on record
    const f = alertsOf('mailbox_ingest_failing');
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/^INBOX \(new\): 3 consecutive failed runs over 12 min/);
    expect(W.state(id).INBOX).toMatchObject({ errors: 3, errors_since: iso(-12), errors_alerted_at: iso(0) });
  });

  test('… one already past its run count was paged then, and is not paged again', async () => {
    const id = emittingInbox({ errors: 4, last_error: 'IMAP AUTHENTICATIONFAILED', last_error_at: iso(-2) });
    S.failConnect = authFailed();
    await ticks(0, 30);
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);
    expect(W.state(id).INBOX).toMatchObject({ errors: 20, errors_since: iso(-2), errors_alerted_at: iso(-2) });
  });
});

describe('poison messages on the clock', () => {
  test('a poison message at a 2-minute tick is quarantined at 10 minutes, not at its 3rd failure — one page, the streak folded in', async () => {
    const id = emittingInbox();
    for (const u of [1, 2, 3]) S.deliver('INBOX', msg(u));
    P.throwFor = (env) => (env.headers.message_id === 'm2@example.com'
      ? Object.assign(new Error('Invalid JSON text'), { code: 'ER_INVALID_JSON_TEXT', errno: 3140 })
      : null);

    await ticks(0, 8);
    let st = W.state(id).INBOX;
    expect(st.poison).toMatchObject({ uid: 2, attempts: 5, first_at: iso(0) });
    expect(st.quarantined).toBeUndefined();
    expect(st.last_uid).toBe(1);
    expect(alertsOf('mailbox_ingest_quarantined')).toHaveLength(0);
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);

    const s = await runAt(10);
    expect(s.quarantined).toBe(1);
    st = W.state(id).INBOX;
    expect(st.quarantined.map(q => [q.uid, q.attempts, q.first_at, q.at])).toEqual([[2, 6, iso(0), iso(10)]]);
    expect(st.errors_since).toBeUndefined(); // the quarantine settled the streak
    const q = alertsOf('mailbox_ingest_quarantined');
    expect(q).toHaveLength(1);
    expect(q[0].message).toContain('INBOX: UID 2 failed 6 runs in a row and is now quarantined');
    expect(alertsOf('mailbox_ingest_failing')).toHaveLength(0);

    await runAt(12);
    expect(W.state(id).INBOX.last_uid).toBe(3);
  });
});
