// tests/mailboxS1.ingest.test.js
//
/**
 * Mailbox system S1 — the ingest worker (services/mailbox/mailboxIngestService.js).
 * Run: npx jest tests/mailboxS1.ingest.test.js
 *
 * HARNESS. The REAL worker and the REAL lib/withTransaction run against
 * tests/helpers/mailboxS1World.js: a stateful fake MySQL that evaluates the
 * worker's exact statements, enforces UNIQUE(mailbox_id, folder, uid) row by
 * row like InnoDB, and throws on any statement it does not know. Mocked are
 * only the worker's DEPENDENCIES: the IMAP transport (a fake account behind
 * the same session contract), emailIngestService.ingestEmail (a fake pipeline
 * that writes executions rows and dedupes on (source, message_id)), and
 * lib/alerting.
 *
 * The same scenarios ran against real engines — Dovecot IMAPS + MySQL 8.0 +
 * the real emailIngestService/logService — in the worker's verification
 * (37 checks, see the S1 report).
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - backlog emitted on first sight            → "history is never emitted"
 *   - re-key without the parking phase          → "swapped UIDs re-key through parking"
 *   - cursor advanced past a failed message     → "a pipeline throw stops the folder…"
 *   - alert on every failed run (not == N)      → "alerts once, at exactly N…"
 *   - kill switch ignored (source.active)       → "inactive source is a kill switch"
 *   - backfill emit horizon ignored             → "re-key backfill emits only mail delivered after…"
 *   - checked_at stamped on a budget-cut pass   → "stops on budget mid-folder…"
 *   - lock name shortened                       → "every lock statement uses the DB-suffixed name"
 */

'use strict';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../services/emailIngestService', () => ({ ingestEmail: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const transport = require('../services/mailbox/imapTransport');
const emailIngestService = require('../services/emailIngestService');
const { alert } = require('../lib/alerting');
const svc = require('../services/mailbox/mailboxIngestService');
const { makeWorld, makeImapServer, makePipeline, msg, LOCK } = require('./helpers/mailboxS1World');

let W; let S; let P;

beforeEach(() => {
  // The worker narrates to the console by design; keep the test output readable.
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

const run = (opts) => svc.runIngest(W.db, opts);
const emittedMids = () => P.envelopes.map(e => e.headers.message_id);
afterEach(() => jest.restoreAllMocks());

/** A mailbox whose INBOX already has a cursor (skips first-sight baselining). */
function primed(folders = { INBOX: { emit_to_rules: true } }, state = {}) {
  return W.addMailbox({ ingest_folders: folders, ingest_state: state });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('first sight of a folder', () => {
  test('history is never emitted: backlog stored newest-first, cursor at UIDNEXT-1', async () => {
    S.addFolder('INBOX', 777, [msg(1), msg(2), msg(3)]);
    const id = W.addMailbox();
    const s = await run();

    expect(s.backfilled).toBe(3);
    expect(s.stored).toBe(0);
    expect(s.emitted).toBe(0);
    expect(P.envelopes).toEqual([]);
    expect(W.rows(id, 'INBOX').map(r => r.uid)).toEqual([1, 2, 3]);
    // Backfill walks DOWN (newest history first).
    expect(S.fetchCalls).toEqual([[3, 2, 1]]);
    const st = W.state(id).INBOX;
    expect(st).toMatchObject({ uidvalidity: 777, last_uid: 3 });
    expect(st.backfill_uid).toBeUndefined();
    expect(typeof st.backfill_done_at).toBe('string');
    expect(typeof st.checked_at).toBe('string');
  });

  test('mail arriving after the baseline IS emitted, and the log_id is bridged', async () => {
    S.addFolder('INBOX', 777, [msg(1)]);
    const id = W.addMailbox();
    await run();
    S.deliver('INBOX', msg(2, { from: [{ name: 'Court', address: 'MIEB_ECFadmin@MIEB.uscourts.gov' }] }));
    const s = await run();

    expect(s).toMatchObject({ stored: 1, emitted: 1, errors: 0 });
    expect(s.pipeline).toEqual({ logged: 1 });
    const env = P.envelopes[0];
    expect(env).toMatchObject({
      kind: 'email', source: 'mailbox-imap', adapter_version: 'yc-imap-1',
      from: { email: 'mieb_ecfadmin@mieb.uscourts.gov' },
      headers: { message_id: 'm2@example.com' },
      mailbox: { id, folder: 'INBOX', uid: 2, uidvalidity: 777 },
    });
    const row = W.rows(id, 'INBOX').find(r => r.uid === 2);
    expect(row.log_id).toBe(W.T.email_ingest_executions[0].log_id);
    expect(W.T.email_ingest_executions[0].source_id).toBe(3);
    expect(W.state(id).INBOX.last_uid).toBe(2);
  });

  test('the baseline is on disk before any backlog is processed (a crash cannot re-baseline later)', async () => {
    S.addFolder('INBOX', 5, [msg(1), msg(2)]);
    const id = W.addMailbox();
    let release;
    const gate = new Promise((r) => { release = r; });
    const real = S.session;
    S.session = () => {
      const sess = real();
      const search = sess.searchUids;
      sess.searchUids = async (...a) => { await gate; return search(...a); }; // backfill's search: "crash" here
      return sess;
    };
    const pending = run();
    for (let i = 0; i < 20 && !W.state(id); i++) await new Promise(r => setImmediate(r));
    // The process could die right now — the cursor is already on disk.
    expect(W.state(id).INBOX).toMatchObject({ uidvalidity: 5, last_uid: 2, backfill_uid: 3 });
    release();
    await pending;
  });

  test('a failed backfill keeps the baseline; later mail is new, not backlog', async () => {
    S.addFolder('INBOX', 5, [msg(1), msg(2)]);
    const id = W.addMailbox();
    S.failFetchOnUid = 2; // backfill blows up on its first batch
    S.failFetchErr = Object.assign(new Error('IMAP ETIMEOUT: socket'), { code: 'ETIMEOUT', imap: true, sanitized: true });
    await run();
    const st = W.state(id).INBOX;
    expect(st).toMatchObject({ uidvalidity: 5, last_uid: 2, backfill_uid: 3, backfill_errors: 1 });
    // Mail delivered now is NEW (uid 3 > last_uid), not backlog.
    S.failFetchOnUid = null;
    S.deliver('INBOX', msg(3));
    const s = await run();
    expect(emittedMids()).toEqual(['m3@example.com']);
    expect(s.backfilled).toBe(2);
  });
});

describe('emission controls', () => {
  test('emit_to_rules false: stored, never emitted', async () => {
    S.addFolder('Sent', 9, []);
    const id = primed({ Sent: { emit_to_rules: false } }, { Sent: { uidvalidity: 9, last_uid: 0 } });
    S.deliver('Sent', msg(1));
    const s = await run();
    expect(s).toMatchObject({ stored: 1, emitted: 0 });
    expect(W.rows(id, 'Sent')).toHaveLength(1);
    expect(W.T.email_ingest_executions).toEqual([]);
  });

  test('inactive source is a kill switch: stored, not emitted, and not retro-emitted later', async () => {
    S.addFolder('INBOX', 9, []);
    const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    W.T.email_ingest_sources[0].active = 0;
    S.deliver('INBOX', msg(1));
    const s = await run();
    expect(s.emitDisabled).toBe('source_inactive');
    expect(s).toMatchObject({ stored: 1, emitted: 0 });
    W.T.email_ingest_sources[0].active = 1;
    await run();
    expect(P.envelopes).toEqual([]);
    expect(W.rows(id, 'INBOX')).toHaveLength(1);
  });

  test('missing source row: stored, flagged in the summary, one dated warning alert', async () => {
    S.addFolder('INBOX', 9, []);
    primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    W.T.email_ingest_sources = [];
    S.deliver('INBOX', msg(1));
    const s = await run();
    expect(s.emitDisabled).toBe('source_missing');
    expect(s).toMatchObject({ stored: 1, emitted: 0 });
    const a = alert.mock.calls.map(c => c[1]).find(o => o.kind === 'mailbox_ingest_source_missing');
    expect(a).toMatchObject({ severity: 'warning' });
    expect(a.dedup_key).toMatch(/^mailbox_ingest_source_missing:\d{4}-\d{2}-\d{2}$/);
  });
});

describe('idempotency and delivery', () => {
  test('a re-run with nothing new is a clean no-op', async () => {
    S.addFolder('INBOX', 9, []);
    primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    S.deliver('INBOX', msg(1)); S.deliver('INBOX', msg(2));
    await run();
    const fetchesBefore = S.fetchCalls.length;
    const execsBefore = W.T.email_ingest_executions.length;
    const s = await run();
    expect(s).toMatchObject({ fetched: 0, stored: 0, emitted: 0, duplicates: 0, errors: 0 });
    expect(S.fetchCalls.length).toBe(fetchesBefore);
    expect(W.T.email_ingest_executions.length).toBe(execsBefore);
  });

  test('crash window: a stored-but-unbridged row above the cursor is re-emitted, not re-stored', async () => {
    S.addFolder('INBOX', 9, [msg(1), msg(2)]);
    const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    // uid 1: stored + bridged before the crash; uid 2: stored, never emitted.
    W.T.mail_messages.push({ id: 90, mailbox_id: id, folder: 'INBOX', uid: 1, message_id: 'm1@example.com', log_id: 42 });
    W.T.mail_messages.push({ id: 91, mailbox_id: id, folder: 'INBOX', uid: 2, message_id: 'm2@example.com', log_id: null });
    const s = await run();
    expect(S.fetchCalls).toEqual([[2]]); // the bridged row is not even fetched
    expect(s).toMatchObject({ stored: 0, emitted: 1 });
    expect(emittedMids()).toEqual(['m2@example.com']);
    expect(W.T.mail_messages.find(r => r.id === 91).log_id).not.toBeNull();
    expect(W.state(id).INBOX.last_uid).toBe(2);
  });

  test('secondary dedupe: same Message-ID under a new UID in the folder is neither stored nor emitted', async () => {
    S.addFolder('INBOX', 9, [msg(1)]);
    const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    await run();
    S.deliver('INBOX', msg(2, { messageId: 'm1@example.com' }));
    const s = await run();
    expect(s).toMatchObject({ stored: 0, emitted: 0, duplicates: 1 });
    expect(W.rows(id, 'INBOX')).toHaveLength(1);
    expect(W.state(id).INBOX.last_uid).toBe(2);
  });

  test('the same message in two mailboxes: one log row, both copies bridged to it', async () => {
    S.addFolder('INBOX', 9, []);
    const a = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    const b = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    S.deliver('INBOX', msg(1, { messageId: 'shared@example.com' }));
    const s = await run();
    expect(s.pipeline).toEqual({ logged: 1, duplicate: 1 });
    const la = W.rows(a, 'INBOX')[0].log_id;
    expect(la).not.toBeNull();
    expect(W.rows(b, 'INBOX')[0].log_id).toBe(la);
  });

  test('a store-only folder copy is bridged to an already-logged message', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder('Sent', 8, []);
    const a = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    const b = primed({ Sent: { emit_to_rules: false } }, { Sent: { uidvalidity: 8, last_uid: 0 } });
    S.deliver('INBOX', msg(1, { messageId: 'x@example.com' }));
    S.deliver('Sent', msg(1, { messageId: 'x@example.com' }));
    await run();
    expect(P.envelopes).toHaveLength(1);
    expect(W.rows(b, 'Sent')[0].log_id).toBe(W.rows(a, 'INBOX')[0].log_id);
  });

  test('a pipeline throw stops the folder at the last completed message; the retry re-emits only that one', async () => {
    S.addFolder('INBOX', 9, []);
    const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    for (const u of [1, 2, 3]) S.deliver('INBOX', msg(u));
    P.throwFor = (e) => (e.headers.message_id === 'm2@example.com' ? new Error('logService exploded') : null);
    const s1 = await run();

    expect(s1.errors).toBe(1);
    expect(emittedMids()).toEqual(['m1@example.com', 'm2@example.com']);
    const st = W.state(id).INBOX;
    expect(st.last_uid).toBe(1);
    expect(st.errors).toBe(1);
    expect(st.last_error).toMatch(/logService exploded/);
    const errRow = W.T.email_ingest_executions.find(e => e.status === 'error');
    expect(errRow).toMatchObject({ source_id: 3, message_id: 'm2@example.com' });

    P.throwFor = null;
    P.envelopes.length = 0;
    const s2 = await run();
    expect(emittedMids()).toEqual(['m2@example.com', 'm3@example.com']);
    expect(s2.errors).toBe(0);
    expect(W.state(id).INBOX).toMatchObject({ last_uid: 3 });
    expect(W.state(id).INBOX.errors).toBeUndefined();
    expect(W.rows(id, 'INBOX')).toHaveLength(3);
  });

  test('duplicate pipeline result recovers the log_id from the earlier execution', async () => {
    S.addFolder('INBOX', 9, []);
    const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    S.deliver('INBOX', msg(1));
    await run();
    // Simulate: the row lost its bridge (crash between emit and stamp).
    const row = W.rows(id, 'INBOX')[0];
    const logId = row.log_id;
    row.log_id = null;
    const b = W.T.mailboxes.find(x => x.id === id);
    b.ingest_state = JSON.stringify({ INBOX: { ...JSON.parse(b.ingest_state).INBOX, last_uid: 0 } });
    const s = await run();
    expect(s.pipeline).toEqual({ duplicate: 1 });
    expect(W.rows(id, 'INBOX')[0].log_id).toBe(logId);
  });
});

describe('budget and lock', () => {
  test('stops on budget mid-folder at the last completed message, resumes next run, never double-emits', async () => {
    S.addFolder('INBOX', 9, []);
    const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    for (let u = 1; u <= 6; u++) S.deliver('INBOX', msg(u));
    process.env.MAILBOX_INGEST_BATCH_SIZE = '2';
    let t = 0;
    const s1 = await run({ budgetMs: 4500, now: () => (t += 500) });
    expect(s1.skippedBudget).toBeGreaterThan(0);
    const mid = W.state(id).INBOX.last_uid;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(6);
    expect(W.rows(id, 'INBOX')).toHaveLength(mid);
    // A pass cut short must not move the re-key emit horizon.
    expect(W.state(id).INBOX.checked_at).toBeUndefined();
    let t2 = Date.parse('2026-10-08T10:00:00Z');
    await run({ now: () => (t2 += 1000) });
    expect(W.state(id).INBOX.last_uid).toBe(6);
    // Completed: horizon = when the folder was EXAMINEd (before the search),
    // not when the pass finished.
    const ck = Date.parse(W.state(id).INBOX.checked_at);
    expect(ck).toBeGreaterThan(Date.parse('2026-10-08T10:00:00Z'));
    expect(ck).toBeLessThan(t2 - 1000);
    expect(emittedMids()).toEqual([1, 2, 3, 4, 5, 6].map(u => `m${u}@example.com`));
  });

  test('budget env knob bounds the run when no budget is passed', async () => {
    process.env.MAILBOX_INGEST_BUDGET_MS = '1000';
    S.addFolder('INBOX', 9, []);
    primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
    S.deliver('INBOX', msg(1));
    let t = 0;
    const s = await run({ now: () => (t += 2000) });
    expect(s.stored).toBe(0);
    expect(s.skippedBudget).toBe(1);
  });

  test('lock held by another run → {skipped:true}, no IMAP, no writes', async () => {
    S.addFolder('INBOX', 9, [msg(1)]);
    W.addMailbox();
    W.lock.holder = 'someone-else';
    const s = await run();
    expect(s.skipped).toBe(true);
    expect(S.connects).toBe(0);
    expect(W.statements.filter(x => /^(INSERT|UPDATE|DELETE)/.test(x.sql))).toEqual([]);
  });

  test('every lock statement uses the DB-suffixed name, and the lock is released', async () => {
    S.addFolder('INBOX', 9, []);
    W.addMailbox();
    await run();
    const lockSql = W.statements.map(x => x.sql).filter(s => /_LOCK\(/.test(s));
    expect(lockSql.length).toBeGreaterThanOrEqual(2);
    for (const s of lockSql) expect(s).toContain(LOCK);
    expect(W.lock.holder).toBeNull();
    // Static: no other spelling anywhere in the worker.
    const src = fs.readFileSync(path.join(__dirname, '../services/mailbox/mailboxIngestService.js'), 'utf8');
    expect(src).toContain(`const LOCK_EXPR = "CONCAT('mailbox_ingest:', DATABASE())";`);
    // Every *_LOCK( call site — code or comment — names the lock in full.
    const re = /(GET_LOCK|RELEASE_LOCK|IS_USED_LOCK)\(/g;
    let m; let sites = 0;
    while ((m = re.exec(src))) {
      sites++;
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
      expect(after.startsWith('${LOCK_EXPR}') || after.startsWith("CONCAT('mailbox_ingest:', DATABASE())")).toBe(true);
    }
    expect(sites).toBeGreaterThanOrEqual(3);
    expect(src.match(/(GET_LOCK|RELEASE_LOCK|IS_USED_LOCK)\(\$\{LOCK_EXPR\}/g)).toHaveLength(3);
  });

  test('a lost lock (heartbeat fails) stops the run early and alerts', async () => {
    const saved = svc.limits.heartbeatMs;
    svc.limits.heartbeatMs = 5;
    try {
      S.addFolder('INBOX', 9, []);
      const id = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 0 } });
      for (let u = 1; u <= 8; u++) S.deliver('INBOX', msg(u));
      process.env.MAILBOX_INGEST_BATCH_SIZE = '1';
      const realFetch = S.session;
      S.session = () => {
        const sess = realFetch();
        const f = sess.fetchMessages;
        sess.fetchMessages = async (uids) => { await new Promise(r => setTimeout(r, 15)); return f(uids); };
        return sess;
      };
      W.lock.breakHeartbeat = true;
      const s = await run();
      expect(s.lockLost).toBe(true);
      expect(W.state(id).INBOX.last_uid).toBeLessThan(8);
      expect(alert.mock.calls.map(c => c[1].kind)).toContain('mailbox_ingest_lock_lost');
    } finally {
      svc.limits.heartbeatMs = saved;
    }
  });
});

describe('failures', () => {
  test('a connect failure marks every folder; alerts once, at exactly N consecutive runs; success resets', async () => {
    S.addFolder('INBOX', 9, []);
    S.addFolder('Sent', 8, []);
    const id = primed({ INBOX: { emit_to_rules: true }, Sent: { emit_to_rules: false } },
      { INBOX: { uidvalidity: 9, last_uid: 0 }, Sent: { uidvalidity: 8, last_uid: 0 } });
    S.failConnect = Object.assign(new Error('IMAP AUTHENTICATIONFAILED: Authentication failed.'), { code: 'AUTHENTICATIONFAILED', imap: true, sanitized: true });
    const N = svc.limits.alertAfter;
    for (let i = 1; i <= N + 1; i++) {
      await run();
      const failing = alert.mock.calls.filter(c => c[1].kind === 'mailbox_ingest_failing');
      expect(failing).toHaveLength(i >= N ? 1 : 0);
    }
    const st = W.state(id);
    expect(st.INBOX.errors).toBe(N + 1);
    expect(st.Sent.errors).toBe(N + 1);
    const a = alert.mock.calls.find(c => c[1].kind === 'mailbox_ingest_failing')[1];
    expect(a).toMatchObject({ severity: 'warning', group_key: `app:mailbox_ingest_failing:${id}`, ref_table: 'mailboxes', ref_id: id });
    expect(a.message).toMatch(/INBOX \(new\): 5 consecutive/);

    S.failConnect = null;
    await run();
    expect(W.state(id).INBOX.errors).toBeUndefined();
    expect(W.state(id).INBOX.last_error).toBeUndefined();
    S.failConnect = Object.assign(new Error('IMAP ECONNRESET'), { code: 'ECONNRESET', imap: true, sanitized: true });
    alert.mockClear();
    for (let i = 1; i <= N; i++) await run();
    expect(alert.mock.calls.filter(c => c[1].kind === 'mailbox_ingest_failing')).toHaveLength(1);
  });

  test('a missing folder fails alone; the other folder still ingests', async () => {
    S.addFolder('INBOX', 9, []);
    const id = primed({ INBOX: { emit_to_rules: true }, 'INBOX.Sent': { emit_to_rules: false } },
      { INBOX: { uidvalidity: 9, last_uid: 0 } });
    S.deliver('INBOX', msg(1));
    const s = await run();
    expect(s.errors).toBe(1);
    expect(s.stored).toBe(1);
    expect(W.state(id)['INBOX.Sent'].errors).toBe(1);
    expect(W.state(id)['INBOX.Sent'].last_error).toMatch(/NONEXISTENT/);
  });

  test('new mail is processed for every mailbox before any backfill', async () => {
    // A: big backlog (first sight). B: primed, with one new message.
    S.addFolder('INBOX', 9, [msg(1), msg(2), msg(3), msg(4)]);
    const a = W.addMailbox();
    const b = primed(undefined, { INBOX: { uidvalidity: 9, last_uid: 3 } });
    let t = 0;
    let order = [];
    const realFetch = S.session;
    S.session = () => {
      const sess = realFetch();
      const f = sess.fetchMessages;
      sess.fetchMessages = async (uids) => { order.push(uids.slice()); return f(uids); };
      return sess;
    };
    process.env.MAILBOX_INGEST_BATCH_SIZE = '1';
    await run({ budgetMs: 60_000, now: () => (t += 1000) });
    // B's new message (uid 4) was fetched first; A's backfill came after.
    expect(order[0]).toEqual([4]);
    expect(W.rows(b, 'INBOX').map(r => r.uid)).toEqual([4]);
    expect(W.rows(a, 'INBOX').length).toBeGreaterThan(0);
    order = [];
  });
});

describe('UIDVALIDITY re-key', () => {
  function seedStored(id, folder, rows) {
    for (const r of rows) {
      W.seq.mail_messages = Math.max(W.seq.mail_messages, r.id);
      W.T.mail_messages.push({ mailbox_id: id, folder, log_id: null, ...r });
    }
  }

  test('swapped UIDs re-key through parking; orphans purged with read state; unmatched left to backfill', async () => {
    const id = primed(undefined, { INBOX: { uidvalidity: 100, last_uid: 4, checked_at: '2026-10-01T00:00:00.000Z' } });
    seedStored(id, 'INBOX', [
      { id: 1, uid: 1, message_id: 'a@x' },
      { id: 2, uid: 2, message_id: 'b@x' },
      { id: 3, uid: 3, message_id: 'gone@x' },
      { id: 4, uid: 4, message_id: null },
    ]);
    W.T.mail_read_state.push({ user: 6, message_fk: 1 }, { user: 6, message_fk: 3 }, { user: 6, message_fk: 4 });
    // New world: a and b SWAPPED (a:2, b:1), c new at 3, the null-id message back at 4.
    S.addFolder('INBOX', 200, [
      msg(1, { messageId: 'b@x' }), msg(2, { messageId: 'a@x' }),
      msg(3, { messageId: 'c@x', internalDate: new Date('2026-09-01T00:00:00Z') }),
      msg(4, { messageId: null, internalDate: new Date('2026-09-01T00:00:00Z') }),
    ]);
    const s = await run();

    expect(s.rekeyed).toBe(1);
    expect(s.errors).toBe(0);
    const rows = W.rows(id, 'INBOX');
    const byMid = Object.fromEntries(rows.map(r => [r.message_id || 'null', r]));
    expect(byMid['a@x']).toMatchObject({ id: 1, uid: 2 });
    expect(byMid['b@x']).toMatchObject({ id: 2, uid: 1 });
    expect(byMid['gone@x']).toBeUndefined();
    expect(byMid['c@x'].uid).toBe(3);
    expect(byMid.null.uid).toBe(4);
    expect(byMid.null.id).not.toBe(4); // orphan-purged, re-inserted
    expect(W.T.mail_read_state.map(r => r.message_fk).sort()).toEqual([1]);
    // Old mail on the new server (delivered before checked_at) is stored only.
    expect(P.envelopes).toEqual([]);
    const st = W.state(id).INBOX;
    expect(st).toMatchObject({ uidvalidity: 200, last_uid: 4 });
    expect(typeof st.rekeyed_at).toBe('string');
    expect(st.backfill_uid).toBeUndefined(); // backfill completed in the same run
    // Settles: the next run does nothing.
    const s2 = await run();
    expect(s2).toMatchObject({ rekeyed: 0, stored: 0, backfilled: 0, fetched: 0 });
  });

  test('re-key backfill emits only mail delivered after the old cursor last looked', async () => {
    const id = primed(undefined, { INBOX: { uidvalidity: 100, last_uid: 1, checked_at: '2026-10-05T12:00:00.000Z' } });
    seedStored(id, 'INBOX', [{ id: 1, uid: 1, message_id: 'old@x' }]);
    S.addFolder('INBOX', 200, [
      msg(1, { messageId: 'imported@x', internalDate: new Date('2025-01-01T00:00:00Z') }),
      msg(2, { messageId: 'old@x' }),
      msg(3, { messageId: 'skew@x', internalDate: new Date('2026-10-05T11:55:00Z') }), // inside the slack
      msg(4, { messageId: 'gap@x', internalDate: new Date('2026-10-05T12:03:00Z') }),
    ]);
    await run();
    expect(emittedMids().sort()).toEqual(['gap@x', 'skew@x']);
    expect(W.rows(id, 'INBOX')).toHaveLength(4);
    expect(W.rows(id, 'INBOX').find(r => r.message_id === 'old@x')).toMatchObject({ id: 1, uid: 2 });
  });

  test('stored rows but no cursor (state lost): re-keys, and stores unmatched mail without emitting', async () => {
    const id = W.addMailbox();
    seedStored(id, 'INBOX', [{ id: 1, uid: 7, message_id: 'a@x' }]);
    S.addFolder('INBOX', 300, [msg(1, { messageId: 'a@x' }), msg(2, { messageId: 'new-ish@x', internalDate: new Date() })]);
    const s = await run();
    expect(s.rekeyed).toBe(1);
    expect(W.rows(id, 'INBOX').map(r => [r.id, r.uid])).toEqual([[1, 1], [2, 2]]);
    expect(P.envelopes).toEqual([]);
    expect(W.state(id).INBOX.backfill_emit_after).toBeUndefined();
  });

  test('a failed re-key transaction rolls back completely', async () => {
    const id = primed(undefined, { INBOX: { uidvalidity: 100, last_uid: 2, checked_at: '2026-10-01T00:00:00.000Z' } });
    seedStored(id, 'INBOX', [{ id: 1, uid: 1, message_id: 'a@x' }, { id: 2, uid: 2, message_id: 'b@x' }]);
    S.addFolder('INBOX', 200, [msg(1, { messageId: 'b@x' }), msg(2, { messageId: 'a@x' })]);
    W.T.failStateWrite = true; // the txn's last statement fails
    const s = await run();
    expect(s.errors).toBeGreaterThan(0);
    expect(W.rows(id, 'INBOX').map(r => [r.id, r.uid])).toEqual([[1, 1], [2, 2]]);
    W.T.failStateWrite = false;
    await run();
    expect(W.rows(id, 'INBOX').map(r => [r.id, r.uid]).sort()).toEqual([[1, 2], [2, 1]]);
  });
});

describe('planRekey (pure)', () => {
  test('matches only unique Message-IDs on both sides', () => {
    const plan = svc.planRekey(
      [
        { id: 1, uid: 1, message_id: 'a@x' },
        { id: 2, uid: 2, message_id: '<b@x>' },   // brackets normalize away
        { id: 3, uid: 3, message_id: 'dup@x' },
        { id: 4, uid: 4, message_id: 'dup@x' },   // ambiguous stored
        { id: 5, uid: 5, message_id: 'twice@x' }, // ambiguous on server
        { id: 6, uid: 6, message_id: null },
        { id: 7, uid: 7, message_id: 'same@x' },
      ],
      [
        { uid: 2, messageId: 'a@x' }, { uid: 1, messageId: 'b@x' }, { uid: 3, messageId: 'dup@x' },
        { uid: 4, messageId: 'twice@x' }, { uid: 5, messageId: 'twice@x' }, { uid: 6, messageId: null },
        { uid: 7, messageId: 'same@x' }, { uid: 8, messageId: 'new@x' },
      ]
    );
    expect(plan.remap).toEqual([
      { id: 1, oldUid: 1, newUid: 2 }, { id: 2, oldUid: 2, newUid: 1 }, { id: 7, oldUid: 7, newUid: 7 },
    ]);
    expect(plan.moving.map(r => r.id)).toEqual([1, 2]);
    expect(plan.orphans).toEqual([3, 4, 5, 6]);
    expect(plan.unmatchedUids).toEqual([3, 4, 5, 6, 8]);
  });
});

describe('row + envelope builders (pure)', () => {
  test('row: display addresses, thread root from References, sane dates, snippet', () => {
    const m = msg(5, {
      from: [{ name: 'Smith, John', address: 'John@Example.com' }],
      to: [{ name: '', address: 'a@b.c' }, { name: 'Bee', address: 'b@b.c' }, { name: 'undisclosed-recipients', address: '' }],
      date: new Date('2199-01-01T00:00:00Z'),
      internalDate: new Date('2026-10-02T03:04:05Z'),
      headerBlock: 'References: <root@x> <mid@x>\r\nIn-Reply-To: <mid@x>\r\n',
      text: null,
      html: '<p>Hello&nbsp;<b>there</b></p><script>evil()</script>',
      attachments: [{ part: '2', filename: 'a.pdf', size: 10, mime: 'application/pdf' }],
    });
    const r = svc.buildRow(1, 'INBOX', m);
    expect(r.from_addr).toBe('"Smith, John" <john@example.com>');
    expect(r.to_addrs).toBe('a@b.c, Bee <b@b.c>');
    expect(r.thread_key).toBe('root@x');
    expect(r.date.toISOString()).toBe('2026-10-02T03:04:05.000Z'); // header year 2199 rejected
    expect(r.snippet).toBe('Hello there');
    expect(r.body_text).toBeNull();
    expect(JSON.parse(r.attachments)[0].part).toBe('2');
  });

  test('envelope: Delivered-To recipient, plus tag, auth, bcc fallback, derived text', () => {
    const m = msg(1, {
      to: [],
      bcc: [{ name: '', address: 'Hidden@X.com' }],
      headerBlock: 'Delivered-To: billing+court@4lsg.com\r\nAuthentication-Results: mx;\r\n spf=pass; dkim=fail; dmarc=pass\r\nDate: Thu, 1 Oct 2026 12:00:00 +0000\r\n',
      text: null,
      html: '<html><body><p>Case Name: John Q. Public</p><table><tr><td>Trustee:</td><td>Jane Doe with notes</td></tr></table></body></html>',
      attachments: [{ part: '3', filename: null, size: 9, mime: 'image/png', cid: 'img1@x' }],
    });
    const e = svc.buildEnvelope({ source: { id: 3, name: 'mailbox-imap' }, mailbox: { id: 1, address: 'billing@4lsg.com' }, folder: 'INBOX', uidValidity: 9, m, receivedAt: 'now' });
    expect(e.to).toEqual([{ name: '', email: 'hidden@x.com' }]);
    expect(e._parse_warnings).toEqual(expect.arrayContaining(['to_empty_fell_back_to_bcc', 'text_derived_from_html']));
    expect(e.envelope).toMatchObject({ recipient: 'billing+court@4lsg.com', local_part: 'billing', plus_tag: 'court', domain: '4lsg.com' });
    expect(e.auth).toMatchObject({ spf: 'pass', dkim: 'fail', dmarc: 'pass' });
    expect(e.date).toBe('Thu, 1 Oct 2026 12:00:00 +0000');
    // Court rules 8/9 regex the text — they must see the HTML's content.
    expect(e.text).toMatch(/Case Name[^A-Za-z]+([A-Za-z. ]+[A-Za-z])/);
    expect(e.text.match(/Case Name[^A-Za-z]+([A-Za-z. ]+[A-Za-z])/)[1]).toBe('John Q. Public');
    expect(e.text).toMatch(/Trustee[^A-Za-z]+([A-Z][A-Za-z. ]+?[A-Za-z]) with/);
    expect(e.attachments).toEqual([{ filename: null, mime: 'image/png', size: 9, url: null, content_id: 'img1@x' }]);
    expect(e.headers.all['delivered-to']).toBe('billing+court@4lsg.com');
  });

  test('envelope without Delivered-To uses the mailbox address', () => {
    const e = svc.buildEnvelope({ source: { id: 3, name: 'mailbox-imap' }, mailbox: { id: 1, address: 'Info@MDBL.com' }, folder: 'INBOX', uidValidity: 9, m: msg(1, { headerBlock: '' }), receivedAt: 'now' });
    expect(e.envelope.recipient).toBe('info@mdbl.com');
  });

  test('htmlToText decodes entities and drops script/style', () => {
    expect(svc.htmlToText('<style>p{}</style><p>A&amp;B&#39;s &#x41;</p><br>z')).toBe("A&B's A\n\nz");
    expect(svc.htmlToText('<td>a</td><td>b</td>')).toBe('a b');
  });

  test('folderConfig: absent or empty → INBOX emitting; non-boolean emit → false', () => {
    expect(svc.folderConfig(null)).toEqual([['INBOX', { emit_to_rules: true }]]);
    expect(svc.folderConfig({})).toEqual([['INBOX', { emit_to_rules: true }]]);
    expect(svc.folderConfig({ Sent: { emit_to_rules: 'yes' } })).toEqual([['Sent', { emit_to_rules: false }]]);
  });
});

describe('no process-global state (design §2)', () => {
  test.each([
    ['services/mailbox/mailboxIngestService.js'],
    ['services/mailbox/imapTransport.js'],
  ])('%s declares no module-scope let/var', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(src.match(/^(let|var)\s/mg)).toBeNull();
  });
});
