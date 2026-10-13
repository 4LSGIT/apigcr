// tests/mailboxS2P.read.test.js
//
/**
 * Mailbox S2P — the read side of the Comms polish slice:
 *   A  log_status on every thread / message / list row (the two-tier record
 *      made visible), batched — resolution order, the bridge keys, the
 *      verdicts, pending / history / store_only;
 *   B  one row per email in the list (copies merge; the keyset cursor stays
 *      the last RAW row's; the badge counts emails — inbox_unread_distinct);
 *   C  sync freshness in the summary (polled folders ONLY; SU-only error);
 *   F  sent_by attribution (mail_sends), latest sent_at wins;
 *   G  sent_link (the Case field's state) on the sent copy.
 *
 * Runs the real routers over tests/helpers/mailboxS2World.js, like
 * tests/mailboxS2.routes.test.js. The SQL is proven on the engine by
 * tests/mailboxS2P.mysql.test.js (gated).
 *
 * Mutation-checked (break it, watch it fail — S2P worker report):
 *   - the A resolution order (verdict before pending; bridge last; …)   → resolution-order tests
 *   - EXEC_STATE dropping a status / mapping 'duplicate'                → verdict tests
 *   - "logged copy wins" (A.3) in mergeCopies / collapse                → B precedence test
 *   - the twin / executions lookup skipped (a bridge never found)       → copy- and source-bridge tests
 *   - the log-liveness JOIN dropped (a deleted log row still "logged")  → dead-log test
 *   - per-message queries instead of the batch                          → statement-count test
 *   - the list cursor taken from the MERGED last row                    → keyset test
 *   - inbox_unread_distinct back to a plain sum                         → distinct test
 *   - syncOf reading cursor entries for UNPOLLED folders                → stale-folder-exclusion test
 *   - sync.error leaking to non-SU readers                              → SU-only test
 *   - sent_by matching ignoring provider_id / taking the oldest row     → sent-by tests
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2p-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s2p_internal';
process.env.EMAIL_DOMAINS = 'firm.test';

const express = require('express');
const jwt = require('jsonwebtoken');
const { makeWorld } = require('./helpers/mailboxS2World');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(require('../routes/api.mail'));

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user) => jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', aud: 'staff' }, process.env.JWT_SECRET);
async function call(method, url, { t, body } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const SU = 6; const READER = 5;

// Box 1 emits INBOX (cursor at 1000); box 2 polls [Gmail]/All Mail only and
// still holds a DEAD cursor for INBOX (live box 2's shape — §C). Box 3 is
// unreadable by everyone but the SU — its stamps still bridge.
function seed() {
  W = makeWorld();
  W.user(SU, { auth: 'authorized - SU', roles: 'it' });
  W.user(READER, { roles: 'staff' });
  W.T.users.push({ user: 2, username: 'rena', user_name: 'Rena R', user_auth: 'authorized', roles: 'staff' });
  W.mailbox(1, { address: 'billing@firm.test' }); // INBOX emits, last_uid 1000
  W.mailbox(2, {
    address: 'stuart@firm.test',
    ingest_folders: JSON.stringify({ '[Gmail]/All Mail': { emit_to_rules: true, backfill: false } }),
    ingest_state: JSON.stringify({
      '[Gmail]/All Mail': { uidvalidity: 12, last_uid: 5000, checked_at: new Date(Date.now() - 3 * 60_000).toISOString() },
      // a cursor for a folder that is NO LONGER polled — must be ignored (C)
      INBOX: { uidvalidity: 1, last_uid: 92315, checked_at: '2026-10-11T07:25:05.737Z' },
    }),
  });
  W.mailbox(3, { address: 'private@firm.test' });
  W.grant(READER, 1, { read: 1 });
  W.grant(READER, 2, { read: 1 });
  W.caseRow('CaseA1', '26-11111', '26-11111-tjt');
  W.caseRow('CaseB2', '26-22222');
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed();
});
afterEach(() => jest.restoreAllMocks());

const status = async (id, user = READER) => {
  const r = await call('GET', `/api/mail/messages/${id}`, { t: tok(user) });
  expect(r.status).toBe(200);
  return r.json.messages[0].log_status;
};

// ─────────────────────────────────────────────────────────────────────────────
describe('A — log_status resolution order', () => {
  test('a live stamped log row: case when about-linked, logged otherwise; via stamped', async () => {
    const caseLog = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    const plainLog = W.logRow({});
    W.message(101, { mailbox_id: 1, log_id: caseLog });
    W.message(102, { mailbox_id: 1, log_id: plainLog });
    expect(await status(101)).toEqual({ state: 'case', log_id: caseLog, via: 'stamped', case: { case_id: 'CaseA1', case_number: '26-11111-tjt' } });
    expect(await status(102)).toEqual({ state: 'logged', log_id: plainLog, via: 'stamped' });
  });

  test('a stamp whose log row was DELETED is not "logged" — it falls through (here: history)', async () => {
    W.message(103, { mailbox_id: 1, log_id: 777 }); // no such log row
    expect(await status(103)).toEqual({ state: 'history' });
  });

  test('a copy\'s stamp bridges — even a copy in a mailbox this reader cannot read; via copy', async () => {
    const lg = W.logRow({ log_about_type: 'case', log_about_id: 'CaseB2' });
    W.message(104, { mailbox_id: 1, message_id: 'shared@x.test' });
    W.message(301, { mailbox_id: 3, message_id: 'shared@x.test', log_id: lg }); // box 3: unreadable
    expect(await status(104)).toEqual({ state: 'case', log_id: lg, via: 'copy', case: { case_id: 'CaseB2', case_number: '26-22222' } });
  });

  test('another source\'s execution row bridges by provider id (the Apps Script copy) — via source', async () => {
    const lg = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    W.execution({ message_id: '1a2b3c4d', status: 'logged', log_id: lg });
    W.message(105, { mailbox_id: 2, folder: '[Gmail]/All Mail', uid: 400, provider_id: '1a2b3c4d', message_id: 'g5@x.test' });
    expect(await status(105)).toEqual({ state: 'case', log_id: lg, via: 'source', case: { case_id: 'CaseA1', case_number: '26-11111-tjt' } });
  });

  test('…and by the bracketed RFC id; an execution whose log row is gone bridges nothing', async () => {
    const lg = W.logRow({});
    W.execution({ message_id: '<rfc9@x.test>', status: 'logged', log_id: lg });
    W.message(106, { mailbox_id: 2, folder: '[Gmail]/All Mail', uid: 401, message_id: 'rfc9@x.test' });
    expect(await status(106)).toEqual({ state: 'logged', log_id: lg, via: 'source' });
    W.T.log.length = 0; // the log row dies: no bridge, and a 'logged' execution is NOT a verdict
    expect(await status(106)).toEqual({ state: 'history' }); // All Mail emits; uid 401 < cursor 5000
  });

  test('pending: an emitting folder whose cursor has not passed the UID', async () => {
    W.message(107, { mailbox_id: 1, uid: 2000 }); // cursor at 1000
    expect(await status(107)).toEqual({ state: 'pending' });
  });

  test('a LIVE log row beats pending (D2): an above-cursor row that is already logged never reads "Still syncing"', async () => {
    // The live box-2 reality: All Mail emits, and the Apps Script source logs
    // new mail BEFORE the worker's cursor passes it — the bridge must win.
    const lgA = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    const lgB = W.logRow({});
    W.message(150, { mailbox_id: 1, uid: 5000, log_id: lgA });                    // stamped + above the cursor
    W.execution({ message_id: '9f9f9f', status: 'logged', log_id: lgB });
    W.message(151, { mailbox_id: 2, folder: '[Gmail]/All Mail', uid: 9000, provider_id: '9f9f9f', message_id: 'srcpend@x.test' }); // source-bridged + above the cursor
    expect(await status(150)).toMatchObject({ state: 'case', via: 'stamped', log_id: lgA });
    expect(await status(151)).toMatchObject({ state: 'logged', via: 'source', log_id: lgB });
  });

  test('the verdicts map; pending outranks a verdict; the LATEST verdict wins; duplicate falls through', async () => {
    const MATRIX = [
      ['ftf@x.test', 'skipped_firm_to_firm', 'firm_to_firm'],
      ['sup@x.test', 'skipped_suppression', 'suppressed'],
      ['err@x.test', 'error', 'pipeline_error'],
      ['val@x.test', 'validation_failed', 'pipeline_error'],
      ['auth@x.test', 'auth_failed', 'pipeline_error'],
    ];
    let id = 110;
    for (const [mid, st, want] of MATRIX) {
      W.execution({ message_id: mid, status: st });
      W.message(id, { mailbox_id: 1, uid: id, message_id: mid });
      expect(await status(id)).toEqual({ state: want });
      id += 1;
    }
    // a verdict NEVER beats a still-pending emission
    W.execution({ message_id: 'race@x.test', status: 'skipped_suppression' });
    W.message(120, { mailbox_id: 1, uid: 3000, message_id: 'race@x.test' });
    expect(await status(120)).toEqual({ state: 'pending' });
    // two verdict rows: the latest (max id) wins
    W.execution({ message_id: 'two@x.test', status: 'skipped_firm_to_firm' });
    W.execution({ message_id: 'two@x.test', status: 'skipped_suppression' });
    W.message(121, { mailbox_id: 1, uid: 121, message_id: 'two@x.test' });
    expect(await status(121)).toEqual({ state: 'suppressed' });
    // a lone duplicate row (no live log) decides nothing
    W.execution({ message_id: 'dup@x.test', status: 'duplicate' });
    W.message(122, { mailbox_id: 1, uid: 122, message_id: 'dup@x.test' });
    expect(await status(122)).toEqual({ state: 'history' });
  });

  test('history (emitting folder, below the cursor) vs store_only (a folder that does not emit)', async () => {
    W.message(130, { mailbox_id: 1, uid: 130 });
    W.message(131, { mailbox_id: 1, folder: 'INBOX.Archive', uid: 131 });
    expect(await status(130)).toEqual({ state: 'history' });
    expect(await status(131)).toEqual({ state: 'store_only' });
  });

  test('a thread resolves its statuses BATCHED: one twin query, one executions query, one config fetch', async () => {
    for (let i = 0; i < 5; i++) {
      W.message(140 + i, { mailbox_id: 1, uid: 140 + i, message_id: `t${i}@x.test`, thread_key: 'batch@x.test' });
    }
    W.execution({ message_id: 't0@x.test', status: 'skipped_suppression' });
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/threads/batch%40x.test', { t: tok(READER) });
    expect(r.status).toBe(200);
    expect(r.json.messages).toHaveLength(5);
    const twinQ = W.statements.filter((s) => /FROM mail_messages m LEFT JOIN log l/.test(s.sql));
    const execQ = W.statements.filter((s) => /FROM email_ingest_executions e/.test(s.sql));
    const cfgQ = W.statements.filter((s) => /ingest_folders, ingest_state FROM mailboxes WHERE id IN/.test(s.sql));
    expect([twinQ.length, execQ.length, cfgQ.length]).toEqual([1, 1, 1]);
    expect(r.json.messages.map((m) => m.log_status.state)).toEqual(['suppressed', 'history', 'history', 'history', 'history']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B — one row per email', () => {
  test('copies merge into one list row: any-copy unread, a copies entry per copy; a logged email shows its case', async () => {
    // The stamp sits on the lower-id copy; the copy BRIDGE lifts the other
    // copy to the same 'case' state, so the merged row shows the case
    // whichever copy presents (the tie keeps page order — 202 first).
    const lg = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    W.message(201, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 100, message_id: 'twin@x.test', log_id: lg, date: new Date('2026-10-08T12:00:00Z') });
    W.message(202, { mailbox_id: 1, uid: 20, message_id: 'twin@x.test', date: new Date('2026-10-08T12:00:00Z') });
    W.read(READER, 201); // the logged copy is read; the other is not
    const r = await call('GET', '/api/mail/messages', { t: tok(READER) });
    expect(r.json.messages).toHaveLength(1);
    const m = r.json.messages[0];
    expect(m.id).toBe(202);                                   // tie on state 'case' → page order
    expect(m.unread).toBe(true);                              // any copy unread
    expect(m.log_status).toMatchObject({ state: 'case', via: 'copy', log_id: lg });
    expect(m.case).toEqual({ case_id: 'CaseA1', case_number: '26-11111-tjt' });
    expect(m.copies.map((c) => [c.id, c.mailbox_id, c.unread]).sort((a, b) => a[0] - b[0]))
      .toEqual([[201, 2, false], [202, 1, true]]);
  });

  test('A.3: where copy STATES differ, the better-ranked copy is primary — in the list AND the thread', async () => {
    // 301 (box 1, above the cursor) is 'pending'; 302 (box 2's INBOX — a
    // folder box 2 does not poll) is 'store_only'. Page order (id DESC) puts
    // 302 FIRST — only the A.3 rank can pick 301 and show 'pending'.
    W.message(301, { mailbox_id: 1, uid: 2000, message_id: 'rank@x.test', thread_key: 'rank@x.test', date: new Date('2026-10-08T12:00:00Z') });
    W.message(302, { mailbox_id: 2, folder: 'INBOX', uid: 7, message_id: 'rank@x.test', thread_key: 'rank@x.test', date: new Date('2026-10-08T12:00:00Z') });
    const r = await call('GET', '/api/mail/messages', { t: tok(READER) });
    expect(r.json.messages).toHaveLength(1);
    expect(r.json.messages[0].id).toBe(301);                  // NOT the first in page order
    expect(r.json.messages[0].mailbox_id).toBe(1);            // the pending copy's stripe
    expect(r.json.messages[0].log_status).toEqual({ state: 'pending' });
    // the THREAD's collapse picks by the same rank (list and thread agree).
    // collapse iterates oldest-first — the REVERSE of the list — so this pair
    // puts the better-ranked copy LAST in collapse order (pending on the
    // higher id): only the rank can pick 402 there.
    W.message(401, { mailbox_id: 2, folder: 'INBOX', uid: 8, message_id: 'rank2@x.test', thread_key: 'rank2@x.test', date: new Date('2026-10-08T12:10:00Z') });
    W.message(402, { mailbox_id: 1, uid: 2001, message_id: 'rank2@x.test', thread_key: 'rank2@x.test', date: new Date('2026-10-08T12:10:00Z') });
    const th = await call('GET', '/api/mail/threads/rank%40x.test', { t: tok(READER) });
    expect(th.json.messages.map((x) => [x.id, x.log_status.state])).toEqual([[301, 'pending']]);
    const th2 = await call('GET', '/api/mail/threads/rank2%40x.test', { t: tok(READER) });
    expect(th2.json.messages.map((x) => [x.id, x.log_status.state])).toEqual([[402, 'pending']]);
  });

  test('the cursor stays the last RAW row\'s (date, id): a copy pair split at the page cut comes back next page — nothing dropped, nothing doubled', async () => {
    // raw rows newest-first: 203 (12:30), then the twins 202 / 201 (both 12:00)
    W.message(201, { mailbox_id: 1, uid: 21, message_id: 'twin@x.test', date: new Date('2026-10-08T12:00:00Z') });
    W.message(202, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 22, message_id: 'twin@x.test', date: new Date('2026-10-08T12:00:00Z') });
    W.message(203, { mailbox_id: 1, uid: 23, message_id: 'top@x.test', date: new Date('2026-10-08T12:30:00Z') });
    const p1 = await call('GET', '/api/mail/messages?limit=2', { t: tok(SU) });
    expect(p1.json.messages.map((m) => m.id)).toEqual([203, 202]);           // the raw cut fell between the twins
    expect(p1.json.next_cursor).toBe(`${new Date('2026-10-08T12:00:00Z').getTime()}.202`);
    const p2 = await call('GET', `/api/mail/messages?limit=2&cursor=${encodeURIComponent(p1.json.next_cursor)}`, { t: tok(SU) });
    expect(p2.json.messages.map((m) => m.id)).toEqual([201]);                // the twin, for the client to FOLD
    expect(p2.json.messages[0].message_id).toBe('twin@x.test');
    expect(p2.json.next_cursor).toBeNull();
    // every raw row appeared exactly once across the walk
    const seen = [...p1.json.messages, ...p2.json.messages].flatMap((m) => m.copies.map((c) => c.id));
    expect(seen.sort((a, b) => a - b)).toEqual([201, 202, 203]);
  });

  test('…and when a FULL pair fits one page, the cursor is still the last RAW row — the next page never re-serves a copy', async () => {
    // p1 raw = the whole twin pair (merged to ONE row whose primary is the
    // HIGHER id); a cursor taken from the merged row would walk back over the
    // lower twin and serve it twice.
    W.message(201, { mailbox_id: 1, uid: 21, message_id: 'twin@x.test', date: new Date('2026-10-08T12:30:00Z') });
    W.message(202, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 22, message_id: 'twin@x.test', date: new Date('2026-10-08T12:30:00Z') });
    W.message(203, { mailbox_id: 1, uid: 23, message_id: 'older@x.test', date: new Date('2026-10-08T11:00:00Z') });
    const seenCopies = [];
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const r = await call('GET', `/api/mail/messages?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { t: tok(SU) });
      for (const m of r.json.messages) seenCopies.push(...m.copies.map((c) => c.id));
      cursor = r.json.next_cursor;
      if (!cursor) break;
    }
    expect(seenCopies.sort((a, b) => a - b)).toEqual([201, 202, 203]); // no copy served twice, none dropped
  });

  test('summary counts EMAILS: inbox_unread_distinct collapses copies; per-box numbers stay raw', async () => {
    W.message(201, { mailbox_id: 1, uid: 21, message_id: 'twin@x.test' });
    W.message(202, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 22, message_id: 'twin@x.test' });
    W.message(203, { mailbox_id: 1, uid: 23, message_id: 'solo@x.test' });
    const r = await call('GET', '/api/mail/mailboxes', { t: tok(READER) });
    expect(r.json.mailboxes.map((m) => [m.id, m.inbox_unread])).toEqual([[1, 2], [2, 1]]);
    expect(r.json.inbox_unread_distinct).toBe(2); // twin + solo — never 3
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C — sync freshness', () => {
  test('derived from POLLED folders only: box 2\'s dead INBOX cursor is ignored; fresh All Mail = not stale', async () => {
    const r = await call('GET', '/api/mail/mailboxes', { t: tok(READER) });
    const by = Object.fromEntries(r.json.mailboxes.map((m) => [m.id, m.sync]));
    expect(by[2].stale).toBe(false);          // All Mail checked 3 min ago; the 2-day-old INBOX cursor is NOT polled
    expect(by[2].failing).toBe(false);
    expect(new Date(by[2].checked_at).getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
    expect(by[1].stale).toBe(true);           // box 1 was never checked
    expect(by[1].checked_at).toBeNull();
  });

  test('failing = an error newer than the last good check; the error TEXT is SU-only', async () => {
    const b = W.T.mailboxes.find((x) => x.id === 1);
    b.ingest_state = JSON.stringify({ INBOX: {
      uidvalidity: 1, last_uid: 10,
      checked_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      errors: 2, last_error: 'LOGIN failed', last_error_at: new Date(Date.now() - 60_000).toISOString(),
    } });
    const su = await call('GET', '/api/mail/mailboxes', { t: tok(SU) });
    const mine = await call('GET', '/api/mail/mailboxes', { t: tok(READER) });
    const suBox = su.json.mailboxes.find((m) => m.id === 1).sync;
    const roBox = mine.json.mailboxes.find((m) => m.id === 1).sync;
    expect(suBox).toMatchObject({ stale: false, failing: true, error: 'LOGIN failed' });
    expect(roBox).toMatchObject({ stale: false, failing: true });
    expect(roBox.error).toBeUndefined();
    expect(roBox.error_at).toBeTruthy();
    // an error OLDER than the last good check is healed — not failing
    b.ingest_state = JSON.stringify({ INBOX: {
      uidvalidity: 1, last_uid: 10,
      checked_at: new Date(Date.now() - 60_000).toISOString(),
      last_error: 'old blip', last_error_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    } });
    const healed = await call('GET', '/api/mail/mailboxes', { t: tok(READER) });
    expect(healed.json.mailboxes.find((m) => m.id === 1).sync.failing).toBe(false);
  });

  test('stale = no successful check for 15 minutes; an alias box reports its PARENT\'s sync', async () => {
    const b = W.T.mailboxes.find((x) => x.id === 1);
    b.ingest_state = JSON.stringify({ INBOX: { uidvalidity: 1, last_uid: 10, checked_at: new Date(Date.now() - 16 * 60_000).toISOString() } });
    W.mailbox(4, { address: 'it@firm.test', alias_of: 2, alias_label: 'IT', ingest_enabled: 0, ingest_state: null });
    W.grant(READER, 4, { read: 1 });
    const r = await call('GET', '/api/mail/mailboxes', { t: tok(READER) });
    const by = Object.fromEntries(r.json.mailboxes.map((m) => [m.id, m.sync]));
    expect(by[1].stale).toBe(true);
    expect(by[4]).toEqual(by[2]); // the alias's mail lives in the parent box
    expect(by[4].stale).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F / G — sent_by attribution and the Case field\'s state', () => {
  test('a thread message matching a mail_sends row carries sent_by; the LATEST sent_at wins; provider id matches too', async () => {
    W.message(301, { mailbox_id: 1, uid: 31, message_id: 'sent1@firm.test', thread_key: 'sb@x.test', date: new Date('2026-10-08T12:00:00Z') });
    W.message(302, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 32, message_id: 'g2@mail.gmail.com', provider_id: '1a2b3c', thread_key: 'sb@x.test', date: new Date('2026-10-08T12:05:00Z') });
    W.send({ user: 2, message_id: 'sent1@firm.test', sent_at: new Date('2026-10-12T10:00:00Z') });
    W.send({ user: 6, message_id: 'sent1@firm.test', sent_at: new Date('2026-10-12T11:00:00Z') }); // later wins
    W.send({ user: 2, provider_id: '1a2b3c', case_id: 'CaseB2', case_link_state: 'pending' });
    const r = await call('GET', '/api/mail/threads/sb%40x.test', { t: tok(READER) });
    const by = Object.fromEntries(r.json.messages.map((m) => [m.id, m]));
    expect(by[301].sent_by).toEqual({ user: 6, name: 'User 6' });
    expect(by[302].sent_by).toEqual({ user: 2, name: 'Rena R' });
    expect(by[302].sent_link).toEqual({ state: 'pending', case: { case_id: 'CaseB2', case_number: '26-22222' } });
    expect(by[301].sent_link).toBeUndefined();
  });

  test('no matching send row → no sent_by; a match is visible to ANY reader, not only the sender', async () => {
    W.message(303, { mailbox_id: 1, uid: 33, message_id: 'plain@x.test' });
    W.message(304, { mailbox_id: 1, uid: 34, message_id: 'mine@firm.test' });
    W.send({ user: 2, message_id: 'mine@firm.test' });
    const r1 = await call('GET', '/api/mail/messages/303', { t: tok(READER) });
    expect(r1.json.messages[0].sent_by).toBeUndefined();
    const r2 = await call('GET', '/api/mail/messages/304', { t: tok(READER) }); // READER ≠ the sender
    expect(r2.json.messages[0].sent_by).toEqual({ user: 2, name: 'Rena R' });
  });
});
