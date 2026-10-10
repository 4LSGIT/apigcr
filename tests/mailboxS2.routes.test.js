// tests/mailboxS2.routes.test.js
//
/**
 * Mailbox system S2 — the comms hub read API (routes/api.mail.js,
 * services/mailbox/mailReadService.js) and the attorney READ bypass in
 * services/mailboxService.js. Run: npx jest tests/mailboxS2.routes.test.js
 *
 * The REAL routers (api.mail + api.mailboxes), lib/auth.jwtOrApiKey,
 * mailboxService grant resolution, mailReadService and logService run over an
 * express app on an ephemeral port, against the stateful fake DB in
 * tests/helpers/mailboxS2World.js (unknown statements throw). The SQL itself
 * is proven on MySQL 8 by tests/mailboxS2.mysql.test.js (gated).
 *
 * Mutation-checked (break it, watch it fail — worker report, 2026-10-09):
 *   - listMessages scope = every mailbox instead of readable ∩ wanted   → grant matrix
 *   - roleBypass returns null / attorney given fullAccess()             → attorney tests
 *   - loadVisible 404 → 403 for an unreadable message                   → no-oracle test
 *   - escapeLike dropped from q / from_domain                           → LIKE tests
 *   - keyset tie-break (m.id < ?) dropped                               → pagination walk
 *   - ON DUPLICATE / anti-join dropped from read writes                  → idempotency
 *   - `AND user = ?` dropped from view UPDATE / DELETE                   → ownership
 *   - emissionPending() short-circuited to false                        → case-link 409
 *   - body_html added to the list projection                            → no-bodies test
 * Review follow-up (2026-10-09), each also mutation-checked:
 *   - priorLogId() returning null (no cross-source lookup)               → gmail-firm / RFC / twin tests
 *   - the log JOIN dropped from the executions lookup                    → deleted-log test
 *   - the store-only grace check removed                                 → grace test
 *   - earliest() → the header date alone                                 → future-Date test
 *   - markRead {all} ignoring scopeWhere (old statement)                 → filtered mark-all tests
 *   - getThread back to oldest-first LIMIT                               → newest-window test
 * Inline vs attached (follow-up), mutation-checked:
 *   - attachment_count back to "no cid"                                 → Gmail-PDF count test
 *   - markInline ignoring the body reference / the image test           → thread inline tests
 *   - the page-body read unconditional / dropped                        → body-read tests
 * Hub polish (images per sender, related), mutation-checked:
 *   - markTrust ignoring the caller (user = ?) / never trusting       → per-user trust tests
 *   - senderOf taking the first address instead of the <angle> one    → "via Group" test
 *   - related keeping firm / mailbox addresses, ended emails, non-client relations,
 *     losing senders-first or the stage order, or the per-contact cap → related tests
 * Mailbox colour (v3), mutation-checked:
 *   - summary dropping `color` / passing it through un-normalized        → colour test
 * Add to client + filters (2026-10-10), mutation-checked:
 *   - has_case + no_case accepted (list or strict filters)               → contradiction test
 *   - no_case evaluated as has_case; client_only never applied           → filter tests
 *   - related's unmatched keeping held / automated addresses, dropping names,
 *     splitting a quoted "Doe, Jane"                                     → unmatched tests
 *   - first-seen reporting the UTC day                                   → first-seen test
 *   The client / files / first-seen SQL semantics are mutation-checked on the
 *   engine (tests/mailboxS2.mysql.test.js): this world matches their text.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s2_internal';
process.env.EMAIL_DOMAINS = 'firm.test';

const express = require('express');
const jwt = require('jsonwebtoken');
const { makeWorld, likeToRegExp } = require('./helpers/mailboxS2World');
const read = require('../services/mailbox/mailReadService');
const mbx = require('../services/mailboxService');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(require('../routes/api.mail'));
app.use(require('../routes/api.mailboxes'));

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user, user_auth = 'authorized') =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);

async function call(method, url, { t, apiKey, body } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

// Users: 1 = SS (attorney), 5 = granted reader of box 1, 7 = send-only on box 1,
// 6 = SU, 9 = no grants, 22 = staff with a manage-only grant on box 2.
const SS = 1; const READER = 5; const SU = 6; const SENDONLY = 7; const NOBODY = 9; const MANAGER = 22;

function seed() {
  W = makeWorld();
  W.user(SS, { roles: 'staff,attorney' });
  W.user(READER, { roles: 'staff' });
  W.user(SU, { auth: 'authorized - SU', roles: 'it,admin,form_dev' });
  W.user(SENDONLY, { roles: 'staff' });
  W.user(NOBODY, { roles: 'staff' });
  W.user(MANAGER, { roles: 'staff' });
  W.mailbox(1, { address: 'billing@firm.test', display_name: 'Billing' });
  W.mailbox(2, { address: 'intake@firm.test', ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: false }, Sent: { emit_to_rules: false } }) });
  W.grant(READER, 1, { read: 1 });
  W.grant(SENDONLY, 1, { read: 0, send: 1 });
  W.grant(MANAGER, 2, { read: 0, manage: 1 });
  // Box 1: 101..104 INBOX; box 2: 201, 202 INBOX + 203 Sent.
  W.message(101, { mailbox_id: 1, thread_key: 'root@x.test', message_id: 'root@x.test', subject: 'Plan objection' });
  W.message(102, { mailbox_id: 1, thread_key: 'root@x.test', message_id: 'reply@x.test', subject: 'Re: Plan objection' });
  W.message(103, { mailbox_id: 1, subject: '50%_off sale', from_addr: 'Deals <deals@shop.test>' });
  W.message(104, { mailbox_id: 1, subject: '50 percent off', from_addr: 'deals2@shop.test' });
  W.message(201, { mailbox_id: 2, thread_key: 'root@x.test', message_id: 'reply@x.test', subject: 'Re: Plan objection' }); // a copy of 102
  W.message(202, { mailbox_id: 2, subject: 'Court notice', from_addr: 'Court <noreply@court.test>' });
  W.message(203, { mailbox_id: 2, folder: 'Sent', subject: 'Sent reply', from_addr: 'intake@firm.test' });
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed();
});
afterEach(() => jest.restoreAllMocks());

const ids = (r) => r.json.messages.map((m) => m.id);

// ─────────────────────────────────────────────────────────────────────────────
describe('humans only', () => {
  test('every /api/mail route: no auth → 401; the internal x-api-key → 403 (no person to resolve grants against)', async () => {
    const routes = [
      ['GET', '/api/mail/mailboxes'], ['GET', '/api/mail/messages'], ['GET', '/api/mail/messages/101'],
      ['GET', '/api/mail/threads/root%40x.test'], ['POST', '/api/mail/messages/101/read'],
      ['DELETE', '/api/mail/messages/101/read'], ['POST', '/api/mail/read'], ['GET', '/api/mail/views'],
      ['POST', '/api/mail/views'], ['PATCH', '/api/mail/views/1'], ['DELETE', '/api/mail/views/1'],
      ['POST', '/api/mail/messages/101/case-link'], ['GET', '/api/mail/messages/101/related'],
      ['GET', '/api/mail/image-senders'], ['POST', '/api/mail/image-senders'], ['DELETE', '/api/mail/image-senders/a%40b.test'],
    ];
    for (const [method, url] of routes) {
      expect((await call(method, url)).status).toBe(401);
      const k = await call(method, url, { apiKey: process.env.INTERNAL_API_KEY, body: method === 'GET' ? undefined : {} });
      expect([method, url, k.status]).toEqual([method, url, 403]);
    }
    expect(W.T.mail_read_state).toEqual([]);
    expect(W.T.inbox_views).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grant matrix — the list, the summary, single messages', () => {
  test('SU reads every mailbox; a grant reader only theirs; INBOX by default', async () => {
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(SU) }))).toEqual([202, 201, 104, 103, 102, 101]);
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(READER) }))).toEqual([104, 103, 102, 101]);
  });

  test('a user with NO grants gets an empty hub — 200s, never an error', async () => {
    const list = await call('GET', '/api/mail/messages', { t: tok(NOBODY) });
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ status: 'success', messages: [], next_cursor: null, scope_ids: [] });
    const sum = await call('GET', '/api/mail/mailboxes', { t: tok(NOBODY) });
    expect(sum.status).toBe(200);
    expect(sum.json.mailboxes).toEqual([]);
    expect((await call('GET', '/api/mail/views', { t: tok(NOBODY) })).json.views).toEqual([]);
  });

  test('send-only and manage-only grants do not read', async () => {
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(SENDONLY) }))).toEqual([]);
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(MANAGER) }))).toEqual([]);
    expect((await call('GET', '/api/mail/messages/101', { t: tok(SENDONLY) })).status).toBe(404);
  });

  test('mailbox_ids narrows but never widens (a probe for an unreadable box just returns less)', async () => {
    const r = await call('GET', '/api/mail/messages?mailbox_ids=1,2', { t: tok(READER) });
    expect(r.json.scope_ids).toEqual([1]);
    expect(ids(r)).toEqual([104, 103, 102, 101]);
    const r2 = await call('GET', '/api/mail/messages?mailbox_ids=2', { t: tok(READER) });
    expect(r2.status).toBe(200);
    expect(ids(r2)).toEqual([]);
  });

  test('an unreadable message and a nonexistent one answer identically (no existence oracle)', async () => {
    const hidden = await call('GET', '/api/mail/messages/202', { t: tok(READER) });
    const absent = await call('GET', '/api/mail/messages/99999', { t: tok(READER) });
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(hidden.json).toEqual(absent.json);
    for (const [m, u] of [['POST', '/api/mail/messages/202/read'], ['DELETE', '/api/mail/messages/202/read']]) {
      expect((await call(m, u, { t: tok(READER) })).json).toEqual(absent.json);
    }
    expect(W.T.mail_read_state).toEqual([]);
  });

  test('summary: readable boxes with INBOX counts — ONE grouped query, not one per mailbox', async () => {
    W.read(SU, 101);
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/mailboxes', { t: tok(SU) });
    expect(r.json.viewer).toEqual({ su: true, role: null });
    expect(r.json.mailboxes.map((m) => [m.id, m.inbox_total, m.inbox_unread])).toEqual([[1, 4, 3], [2, 2, 2]]);
    expect(W.statements.filter((s) => /FROM mail_messages/.test(s.sql))).toHaveLength(1);
  });

  test('summary carries each box\'s stored colour on every access path (grant, SU, attorney); junk reads as none', async () => {
    W.T.mailboxes.find((b) => b.id === 1).color = '#2F6FD1';
    W.T.mailboxes.find((b) => b.id === 2).color = 'red; background:url(x)';
    const colours = async (u) => (await call('GET', '/api/mail/mailboxes', { t: tok(u) })).json.mailboxes.map((m) => [m.id, m.color]);
    expect(await colours(SU)).toEqual([[1, '#2f6fd1'], [2, null]]);
    expect(await colours(SS)).toEqual([[1, '#2f6fd1'], [2, null]]);
    expect(await colours(READER)).toEqual([[1, '#2f6fd1']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attorney READ bypass (users.roles, DB-sourced)', () => {
  test('an attorney reads every mailbox without a grant row', async () => {
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(SS) }))).toEqual([202, 201, 104, 103, 102, 101]);
    const sum = await call('GET', '/api/mail/mailboxes', { t: tok(SS) });
    expect(sum.json.viewer).toEqual({ su: false, role: 'attorney' });
    expect(sum.json.mailboxes.map((m) => m.id)).toEqual([1, 2]);
    expect((await call('GET', '/api/mail/messages/202', { t: tok(SS) })).status).toBe(200);
  });

  test('READ only: send/manage still come from grants, and the attorney is never an SU', async () => {
    expect(await mbx.getAccess(W.db, SS, 'mailbox', 1))
      .toEqual({ can_read: true, can_send: false, can_manage: false, su: false, role: 'attorney' });
    W.grant(SS, 2, { read: 0, send: 1 });
    expect(await mbx.getAccess(W.db, SS, 'mailbox', 2))
      .toEqual({ can_read: true, can_send: true, can_manage: false, su: false, role: 'attorney' });
    const sum = await call('GET', '/api/mail/mailboxes', { t: tok(SS) });
    expect(sum.json.mailboxes.map((m) => [m.id, m.can_send, m.can_manage])).toEqual([[1, false, false], [2, true, false]]);
  });

  test('the admin surfaces stay closed: public projection, no PATCH, no SU diagnostics', async () => {
    const list = await call('GET', '/api/mailboxes', { t: tok(SS) });
    expect(list.status).toBe(200);
    expect(list.json.viewer).toEqual({ su: false });
    expect(list.json.mailboxes.map((m) => m.id).sort()).toEqual([1, 2]);
    for (const m of list.json.mailboxes) {
      expect(m.imap_host).toBeUndefined();
      expect(m.has_secret).toBeUndefined();
      expect(m.access).toEqual({ can_read: true, can_send: false, can_manage: false, su: false, role: 'attorney' });
    }
    expect((await call('PATCH', '/api/mailboxes/1', { t: tok(SS), body: { display_name: 'x' } })).status).toBe(403);
    expect((await call('GET', '/api/mailboxes/1/grants', { t: tok(SS) })).status).toBe(403);
    expect((await call('GET', '/api/mailboxes/1/folders', { t: tok(SS) })).status).toBe(403);
  });

  test('the bypass is read from the DB per request: drop the role, lose the access', async () => {
    W.T.users.find((u) => u.user === SS).roles = 'staff';
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(SS) }))).toEqual([]);
    expect((await call('GET', '/api/mail/messages/101', { t: tok(SS) })).status).toBe(404);
  });

  test('phone lines get no role bypass before slice S-PH', async () => {
    expect(await mbx.getAccess(W.db, SS, 'phone_line', 1))
      .toEqual({ can_read: false, can_send: false, can_manage: false, su: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the list carries no bodies', () => {
  test('no body_html / body_text in any list response, and none selected', async () => {
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/messages?all_folders=1', { t: tok(SU) });
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/body_html|body_text|<p>html/);
    const listSql = W.statements.filter((s) => s.sql.startsWith('(SELECT'));
    expect(listSql).toHaveLength(1);
    expect(listSql[0].sql).not.toMatch(/body_html|body_text/);
    expect(listSql[0].sql).not.toMatch(/\bOFFSET\b/i);
    expect(Object.keys(r.json.messages[0]).sort()).toEqual([
      'attachment_count', 'case', 'cc_addrs', 'date', 'folder', 'from_addr', 'id', 'log_id', 'mailbox_address',
      'mailbox_id', 'snippet', 'subject', 'thread_key', 'to_addrs', 'unread',
    ]);
  });

  test('attachment_count excludes only images the HTML body draws (cid: referenced) — a Content-ID alone is not "inline"', async () => {
    const m104 = W.T.mail_messages.find((m) => m.id === 104);
    m104.body_html = '<p>hi</p><img src="cid:logo%40x"><div style="background:url(cid:BG@X)"></div>';
    m104.attachments = JSON.stringify([
      { part: '2', filename: 'a.pdf', size: 1, mime: 'application/pdf' },
      { part: '3', filename: 'logo.png', size: 1, mime: 'image/png', cid: 'logo@x' },  // drawn (URL-encoded ref)
      { part: '4', filename: 'bg.gif', size: 1, mime: 'image/gif', cid: '<bg@x>' },   // drawn (CSS url, case-blind)
    ]);
    // Gmail: EVERY attachment carries a Content-ID (X-Attachment-Id) — the live "email with pdf" (mail_messages 2)
    const m103 = W.T.mail_messages.find((m) => m.id === 103);
    m103.body_html = '<div dir="ltr">see attached</div>';
    m103.attachments = JSON.stringify([
      { part: '2', filename: 'Untitled.pdf', size: 63118, mime: 'application/pdf', cid: 'f_mv06z1bd0' },
      { part: '3', filename: 'photo.jpg', size: 9, mime: 'image/jpeg', cid: 'f_mv06z1be1' },           // attached, not drawn
    ]);
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/messages', { t: tok(READER) });
    const count = (id) => r.json.messages.find((m) => m.id === id).attachment_count;
    expect([count(104), count(103), count(101)]).toEqual([1, 2, 0]);
    expect(r.text).not.toMatch(/see attached|cid:/); // bodies read for the count, never sent
    // the page's bodies come from ONE query, only for rows that have a cid part
    const reads = W.statements.filter((x) => x.sql.startsWith('SELECT id, body_html'));
    expect(reads).toHaveLength(1);
    expect([...reads[0].params[0]].sort()).toEqual([103, 104]);
  });

  test('no cid part on the page → no body read at all', async () => {
    W.statements.length = 0;
    await call('GET', '/api/mail/messages', { t: tok(READER) });
    expect(W.statements.filter((x) => /body_html/.test(x.sql))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('keyset pagination on (date, id)', () => {
  test('walking next_cursor returns every row exactly once, ties by id, NULL dates last', async () => {
    W.T.mail_messages.find((m) => m.id === 103).date = new Date(W.T.mail_messages.find((m) => m.id === 104).date); // same second
    W.message(105, { mailbox_id: 1, date: null, subject: 'no date' });
    W.message(106, { mailbox_id: 1, date: null, subject: 'no date either' });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await call('GET', `/api/mail/messages?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { t: tok(SU) });
      expect(r.status).toBe(200);
      seen.push(...ids(r));
      cursor = r.json.next_cursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toEqual([202, 201, 104, 103, 102, 101, 106, 105]);
  });

  test('a malformed cursor is a 400, not a full scan', async () => {
    for (const c of ['abc', '12', '1.2.3', 'n.0', '-5.1']) {
      expect((await call('GET', `/api/mail/messages?cursor=${encodeURIComponent(c)}`, { t: tok(SU) })).status).toBe(400);
    }
  });

  test('limit is capped at PAGE_MAX', async () => {
    W.statements.length = 0;
    await call('GET', '/api/mail/messages?limit=5000', { t: tok(SU) });
    const s = W.statements.find((x) => x.sql.startsWith('(SELECT'));
    expect(s.params[s.params.length - 1]).toBe(read.PAGE_MAX + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('filters', () => {
  test('unread_only uses the caller\'s own read state', async () => {
    W.read(READER, 101);
    W.read(SU, 102);
    expect(ids(await call('GET', '/api/mail/messages?unread_only=1', { t: tok(READER) }))).toEqual([104, 103, 102]);
  });

  test('has_case = the log row\'s about-link is a real case', async () => {
    W.caseRow('CaseA1', '26-11111', '26-11111-tjt');
    const l1 = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    const l2 = W.logRow({ log_about_type: 'contact', log_about_id: '77' });
    W.T.mail_messages.find((m) => m.id === 101).log_id = l1;
    W.T.mail_messages.find((m) => m.id === 102).log_id = l2;
    const r = await call('GET', '/api/mail/messages?has_case=true', { t: tok(READER) });
    expect(ids(r)).toEqual([101]);
    expect(r.json.messages[0].case).toEqual({ case_id: 'CaseA1', case_number: '26-11111-tjt' });
  });

  test('from_domain matches the bare and the display form, exact domain only', async () => {
    W.message(107, { mailbox_id: 1, from_addr: 'x@mail.shop.test' });
    expect(ids(await call('GET', '/api/mail/messages?from_domain=shop.test', { t: tok(READER) }))).toEqual([104, 103]);
    expect(ids(await call('GET', '/api/mail/messages?from_domain=%40SHOP.TEST', { t: tok(READER) }))).toEqual([104, 103]);
    expect((await call('GET', '/api/mail/messages?from_domain=not%20a%20domain', { t: tok(READER) })).status).toBe(400);
  });

  test('all_folders adds Sent; the default is INBOX', async () => {
    expect(ids(await call('GET', '/api/mail/messages?mailbox_ids=2', { t: tok(SU) }))).toEqual([202, 201]);
    expect(ids(await call('GET', '/api/mail/messages?mailbox_ids=2&all_folders=1', { t: tok(SU) }))).toEqual([203, 202, 201]);
  });

  test('a bad flag value is a 400', async () => {
    expect((await call('GET', '/api/mail/messages?unread_only=maybe', { t: tok(SU) })).status).toBe(400);
    for (const k of ['no_case', 'client_only', 'has_files']) {
      expect([k, (await call('GET', `/api/mail/messages?${k}=maybe`, { t: tok(SU) })).status]).toEqual([k, 400]);
    }
  });

  test('no_case is has_case\'s complement (unlogged mail included); both on is a 400, however they arrive', async () => {
    W.caseRow('CaseA1', '26-11111');
    W.T.mail_messages.find((m) => m.id === 101).log_id = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    W.T.mail_messages.find((m) => m.id === 102).log_id = W.logRow({ log_about_type: 'contact', log_about_id: '77' });
    expect(ids(await call('GET', '/api/mail/messages?no_case=1', { t: tok(READER) }))).toEqual([104, 103, 102]);
    expect(ids(await call('GET', '/api/mail/messages?no_case=1&has_case=0', { t: tok(READER) }))).toEqual([104, 103, 102]);
    const both = await call('GET', '/api/mail/messages?no_case=1&has_case=1', { t: tok(READER) });
    expect([both.status, both.json.message]).toEqual([400, 'has_case and no_case cannot both be on']);
    const v = (await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'Unfiled', filters: { no_case: true } } })).json.view;
    expect(v.filters).toEqual({ no_case: true });
    expect(ids(await call('GET', `/api/mail/messages?view=${v.id}`, { t: tok(READER) }))).toEqual([104, 103, 102]);
    expect((await call('GET', `/api/mail/messages?view=${v.id}&has_case=1`, { t: tok(READER) })).status).toBe(400);
    expect(ids(await call('GET', `/api/mail/messages?view=${v.id}&has_case=1&no_case=0`, { t: tok(READER) }))).toEqual([101]);
    expect((await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'x', filters: { has_case: true, no_case: true } } })).status).toBe(400);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { has_case: true, no_case: true } } })).status).toBe(400);
  });

  describe('client_only — mail to / from a CLIENT (Primary / Secondary on a case), never through a firm address', () => {
    beforeEach(() => {
      W.mailbox(3, { address: 'shared@gmail.test' });                      // a firm mailbox on an outside domain
      W.contact(500, 'Doe, Jane', ['jane@client.test']);
      W.contact(510, 'Roe, Rick', ['rick@client.test']);
      W.contact(600, 'Trustee, Tom', ['t@trustee.test']);
      W.contact(700, 'Old Owner', [], { ended: ['old@client.test'] });
      W.contact(800, 'Stuart (test client)', ['stuart@firm.test', 'stu@sub.firm.test', 'shared@gmail.test']);
      for (const c of ['CaseA1', 'CaseB2', 'CaseT']) W.caseRow(c, c);
      W.relate('CaseA1', 500, 'Primary');
      W.relate('CaseB2', 510, 'Secondary');
      W.relate('CaseA1', 600, 'Other');
      W.relate('CaseA1', 700, 'Primary');
      W.relate('CaseT', 800, 'Primary');
      const set = (id, f) => Object.assign(W.T.mail_messages.find((m) => m.id === id), f);
      set(101, { from_addr: 'Jane Doe <jane@client.test>', to_addrs: 'billing@firm.test' });                   // client sender
      set(102, { from_addr: 'Stuart <stuart@firm.test>', to_addrs: '"Roe, Rick" <RICK@client.test>' });         // outgoing: To, quoted comma name
      set(103, { from_addr: 't@trustee.test', to_addrs: 'billing@firm.test' });                                 // Other relation
      set(104, { from_addr: 'old@client.test', to_addrs: 'billing@firm.test' });                                // ended row
      W.message(105, { mailbox_id: 1, from_addr: 'Stuart <stuart@firm.test>', to_addrs: 'billing@firm.test', cc_addrs: 'stu@sub.firm.test' }); // staff on a test case
      W.message(106, { mailbox_id: 1, from_addr: 'v@vendor.test', to_addrs: 'a@v.test, b@v.test, "C, D" <c@v.test>, d@v.test', cc_addrs: 'jane@client.test' }); // 5th address
      W.message(107, { mailbox_id: 1, from_addr: 'v@vendor.test', to_addrs: 'a@v.test, b@v.test, c@v.test, d@v.test, e@v.test', cc_addrs: 'jane@client.test' }); // 6th
      W.message(108, { mailbox_id: 1, from_addr: 'Shared <shared@gmail.test>', to_addrs: 'billing@firm.test' }); // a mailbox address
    });

    test('sender or one of the first five To/Cc addresses; Other / ended / firm / subdomain / mailbox addresses never count', async () => {
      W.statements.length = 0;
      const r = await call('GET', '/api/mail/messages?client_only=1', { t: tok(READER) });
      expect(ids(r)).toEqual([106, 102, 101]);
      const branch = W.statements.find((x) => x.sql.startsWith('(SELECT'));
      expect(branch.params).toEqual(expect.arrayContaining([['Primary', 'Secondary'], read.firmAddressPattern()]));
      expect(read.firmAddressPattern()).toBe('@([^@]*[.])?(firm\\.test)$');
    });

    test('combines with the other filters, saves in a view, and mark-all clears exactly that list', async () => {
      W.read(READER, 101);
      expect(ids(await call('GET', '/api/mail/messages?client_only=1&unread_only=1', { t: tok(READER) }))).toEqual([106, 102]);
      const v = (await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'Clients', filters: { client_only: true, no_case: true } } })).json.view;
      expect(v.filters).toEqual({ client_only: true, no_case: true });
      expect(ids(await call('GET', `/api/mail/messages?view=${v.id}`, { t: tok(READER) }))).toEqual([106, 102, 101]);
      expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { client_only: true } } })).json.marked).toBe(2);
      expect(W.readSet(READER)).toEqual([101, 102, 106]);
    });
  });

  test('has_files = the paperclip (attachment_count > 0), in SQL: inline images the body draws are not files', async () => {
    const att = (list) => JSON.stringify(list);
    const fx = {
      301: { attachments: att([{ part: '2', mime: 'application/pdf', cid: 'f_1', filename: 'a.pdf' }, { part: '3', mime: 'image/png', cid: 'ii_sig' }]), body_html: '<img src="cid:ii_sig">' }, // Gmail PDF + sig
      302: { attachments: att([{ part: '2', mime: 'image/png', cid: 'ii_sig' }]), body_html: '<p>x</p><img src="cid:II_SIG">' },          // only the sig (case-blind)
      303: { attachments: att([{ part: '2', mime: 'image/jpeg', cid: 'ii_photo', filename: 'paystub.jpg' }]), body_html: '<p>see attached</p>' }, // phone photo
      304: { attachments: att([{ part: '2', mime: 'image/png', cid: 'image001.png@01DD' }]), body_html: '<img src="cid:image001.png%4001DD">' }, // Outlook, %40
      305: { attachments: att([{ part: '2', mime: 'image/png', filename: 'logo.png' }]), body_html: '<p>x</p>' },                       // no cid
      306: { attachments: att([{ part: '2', mime: 'image/png', cid: 'ii_x' }]), body_html: null },                                       // no html body
      307: { attachments: '[]' },
      308: { attachments: att([{ part: '2', mime: null, cid: 'ii_m' }]), body_html: '<img src="cid:ii_m">' },                             // no mime: a file
      309: { attachments: att([{ part: '2', mime: 'image/gif', cid: '<b@x>' }]), body_html: '<img src="cid:b@x">' },                       // bracketed id
      310: { attachments: att([{ mime: 'application/pdf' }]) },                                                                            // no part: not a part
    };
    for (const [id, f] of Object.entries(fx)) W.message(Number(id), { mailbox_id: 1, ...f });
    const all = (await call('GET', '/api/mail/messages', { t: tok(READER) })).json.messages.filter((m) => m.id > 300);
    const clip = all.filter((m) => m.attachment_count > 0).map((m) => m.id);
    expect(clip).toEqual([308, 306, 305, 303, 301]);
    expect(ids(await call('GET', '/api/mail/messages?has_files=1', { t: tok(READER) }))).toEqual(clip);
  });
});

describe('LIKE escaping (sql_mode has no NO_BACKSLASH_ESCAPES)', () => {
  test('q binds the escaped pattern and matches the literal text only', async () => {
    W.statements.length = 0;
    const r = await call('GET', `/api/mail/messages?q=${encodeURIComponent('50%_')}`, { t: tok(READER) });
    expect(ids(r)).toEqual([103]); // not "50 percent off"
    const s = W.statements.find((x) => x.sql.startsWith('(SELECT'));
    expect(s.params).toContain('%50\\%\\_%');
    expect(s.params).not.toContain('%50%_%');
  });

  test('from_domain never carries a LIKE metacharacter (validated as a domain, then escaped anyway)', async () => {
    W.statements.length = 0;
    for (const d of ['my_co.test', 'my%co.test', 'a\\b.test']) {
      expect((await call('GET', `/api/mail/messages?from_domain=${encodeURIComponent(d)}`, { t: tok(READER) })).status).toBe(400);
    }
    expect(W.statements.some((s) => s.sql.startsWith('(SELECT'))).toBe(false);
  });

  test('the fake\'s LIKE is MySQL\'s (sanity for the two tests above)', () => {
    expect(likeToRegExp('%50\\%\\_%').test('a 50%_ b')).toBe(true);
    expect(likeToRegExp('%50\\%\\_%').test('a 50 percent b')).toBe(false);
    expect(likeToRegExp('%50%_%').test('a 50 percent b')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('threads', () => {
  test('merged across readable mailboxes; copies of one message collapse; bodies here', async () => {
    const r = await call('GET', '/api/mail/threads/root%40x.test', { t: tok(SU) });
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m) => [m.id, m.copies.map((c) => c.id)])).toEqual([[101, [101]], [102, [102, 201]]]);
    expect(r.json.messages[0].body_html).toBe('<p>html 101</p>');
  });

  test('each message is grant-checked: a reader of box 1 never sees box 2\'s copy', async () => {
    const r = await call('GET', '/api/mail/threads/root%40x.test', { t: tok(READER) });
    expect(r.json.messages.map((m) => [m.id, m.copies.map((c) => c.id)])).toEqual([[101, [101]], [102, [102]]]);
  });

  test('a thread only in unreadable mailboxes is a 404, same as none', async () => {
    W.message(210, { mailbox_id: 2, thread_key: 'secret@x.test' });
    const a = await call('GET', '/api/mail/threads/secret%40x.test', { t: tok(READER) });
    const b = await call('GET', '/api/mail/threads/nope%40x.test', { t: tok(READER) });
    expect(a.status).toBe(404);
    expect(a.json).toEqual(b.json);
  });

  test('over THREAD_MAX rows the NEWEST window comes back (the clicked message is the latest), oldest-first', async () => {
    const N = read.THREAD_MAX + 5;
    for (let i = 0; i < N; i++) W.message(1000 + i, { mailbox_id: 1, thread_key: 'long@x.test', message_id: `long${i}@x.test` });
    const r = await call('GET', '/api/mail/threads/long%40x.test', { t: tok(READER) });
    expect(r.json.truncated).toBe(true);
    const got = r.json.messages.map((m) => m.id);
    expect(got).toHaveLength(read.THREAD_MAX);
    expect(got[0]).toBe(1005);
    expect(got[got.length - 1]).toBe(1000 + N - 1);
    expect(got).toEqual([...got].sort((a, b) => a - b));
  });

  test('thread attachments carry `inline`: only images the body draws by cid: (Gmail PDFs with a Content-ID stay files)', async () => {
    W.message(120, {
      mailbox_id: 1, thread_key: 'att@x.test',
      body_html: '<img src="cid:ii_abc">',
      attachments: JSON.stringify([
        { part: '2', filename: 'Untitled.pdf', size: 5, mime: 'application/pdf', cid: 'f_mv06z1bd0' },
        { part: '3', filename: 'sig.png', size: 5, mime: 'image/png', cid: 'ii_abc' },
        { part: '4', filename: 'scan.png', size: 5, mime: 'image/png', cid: 'f_other' },
        { part: '5', filename: 'plain.txt', size: 5, mime: 'text/plain' },
      ]),
    });
    const r = await call('GET', '/api/mail/threads/att%40x.test', { t: tok(READER) });
    expect(r.json.messages[0].attachments.map((a) => [a.part, a.inline])).toEqual([['2', false], ['3', true], ['4', false], ['5', false]]);
    const one = await call('GET', '/api/mail/messages/120', { t: tok(READER) });
    expect(one.json.messages[0].attachments.filter((a) => a.inline).map((a) => a.part)).toEqual(['3']);
  });

  test('referencedCids: RFC 2392 URL-encoded, <bracketed>, case-blind; a cid: that is not an image is never inline', () => {
    expect([...read.referencedCids('<img src="cid:a%40b"> <img src=CID:X@Y> url(\'cid:%3Cz@q%3E\') cid:%E0%A4%A')].sort()).toEqual(['a@b', 'x@y', 'z@q', '%e0%a4%a'].sort());
    expect(read.markInline([{ cid: 'p@x', mime: 'application/pdf' }], '<img src="cid:p@x">')[0].inline).toBe(false);
    expect(read.markInline([{ cid: null, mime: 'image/png' }], '<img src="cid:null">')[0].inline).toBe(false);
  });

  test('thread keys with reserved URL characters round-trip', async () => {
    W.message(110, { mailbox_id: 1, thread_key: 'a/b+c=d%e@x.test' });
    const r = await call('GET', `/api/mail/threads/${encodeURIComponent('a/b+c=d%e@x.test')}`, { t: tok(READER) });
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m) => m.id)).toEqual([110]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('read state (per user, idempotent, never \\Seen)', () => {
  test('POST twice → one row; DELETE twice → none; other users untouched', async () => {
    W.read(SU, 101);
    expect((await call('POST', '/api/mail/messages/101/read', { t: tok(READER) })).json).toMatchObject({ id: 101, unread: false });
    expect((await call('POST', '/api/mail/messages/101/read', { t: tok(READER) })).status).toBe(200);
    expect(W.readSet(READER)).toEqual([101]);
    expect((await call('DELETE', '/api/mail/messages/101/read', { t: tok(READER) })).json).toMatchObject({ id: 101, unread: true });
    expect((await call('DELETE', '/api/mail/messages/101/read', { t: tok(READER) })).status).toBe(200);
    expect(W.readSet(READER)).toEqual([]);
    expect(W.readSet(SU)).toEqual([101]);
    expect(W.T.mail_messages.every((m) => m.flags === '')).toBe(true);
  });

  test('bulk {ids}: only the readable ones, new rows counted once', async () => {
    const r = await call('POST', '/api/mail/read', { t: tok(READER), body: { ids: [101, 102, 201, 202] } });
    expect(r.json).toMatchObject({ marked: 2 });
    expect(W.readSet(READER)).toEqual([101, 102]);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { ids: [101, 102] } })).json.marked).toBe(0);
  });

  test('bulk {all}: what the LIST shows for the readable scope (∩ mailbox_ids) — INBOX unless all_folders', async () => {
    expect((await call('POST', '/api/mail/read', { t: tok(SU), body: { all: true, mailbox_ids: [2] } })).json.marked).toBe(2);
    expect(W.readSet(SU)).toEqual([201, 202]);
    expect((await call('POST', '/api/mail/read', { t: tok(SU), body: { all: true, mailbox_ids: [2], filters: { all_folders: true } } })).json.marked).toBe(1);
    expect(W.readSet(SU)).toEqual([201, 202, 203]);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, mailbox_ids: [2] } })).json.marked).toBe(0);
    expect(W.readSet(READER)).toEqual([]);
  });

  test('bulk {all} with filters clears exactly the filtered list (every page), nothing behind it', async () => {
    // from_domain: the list shows 103 + 104; mark-all must mark those two only.
    const shown = ids(await call('GET', '/api/mail/messages?from_domain=shop.test', { t: tok(READER) }));
    expect(shown).toEqual([104, 103]);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { from_domain: 'shop.test' } } })).json.marked).toBe(2);
    expect(W.readSet(READER)).toEqual([103, 104]);
    // q + has_case ride the same predicates
    const lid = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    W.caseRow('CaseA1', '26-11111');
    W.T.mail_messages.find((m) => m.id === 101).log_id = lid;
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { has_case: true } } })).json.marked).toBe(1);
    expect(W.readSet(READER)).toEqual([101, 103, 104]);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { q: 'Re: Plan' } } })).json.marked).toBe(1);
    expect(W.readSet(READER)).toEqual([101, 102, 103, 104]);
  });

  test('bulk body validation', async () => {
    for (const body of [{}, { ids: [1], all: true }, { ids: [] }, { ids: 'x' }, { all: true, extra: 1 }, { ids: [1], mailbox_ids: [1] },
      { ids: [1], filters: {} }, { all: true, filters: 'x' }, { all: true, filters: { body: 'x' } }, { all: true, filters: { unread_only: 'yes' } },
      { ids: Array.from({ length: read.BULK_READ_MAX + 1 }, (_, i) => i + 1) }]) {
      expect([JSON.stringify(body).slice(0, 40), (await call('POST', '/api/mail/read', { t: tok(SU), body })).status])
        .toEqual([JSON.stringify(body).slice(0, 40), 400]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('saved views (inbox_views) — caller-owned only', () => {
  test('create / list / patch / delete, one default per user', async () => {
    const a = await call('POST', '/api/mail/views', { t: tok(READER), body: { name: ' Unread ', filters: { unread_only: true, q: '' }, is_default: true } });
    expect(a.status).toBe(201);
    expect(a.json.view).toEqual({ id: 1, name: 'Unread', mailbox_ids: null, filters: { unread_only: true }, is_default: true, sort_order: 0 });
    const b = await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'Box 1', mailbox_ids: [1], is_default: true } });
    expect(b.json.view.is_default).toBe(true);
    const list = await call('GET', '/api/mail/views', { t: tok(READER) });
    expect(list.json.views.map((v) => [v.id, v.is_default])).toEqual([[1, false], [2, true]]);
    const p = await call('PATCH', '/api/mail/views/1', { t: tok(READER), body: { name: 'Renamed', is_default: true } });
    expect(p.json.view).toMatchObject({ id: 1, name: 'Renamed', is_default: true });
    expect(W.T.inbox_views.filter((v) => v.is_default).map((v) => v.id)).toEqual([1]);
    expect((await call('DELETE', '/api/mail/views/2', { t: tok(READER) })).json).toMatchObject({ removed: 1, id: 2 });
    expect(W.T.inbox_views.map((v) => v.id)).toEqual([1]);
  });

  test('another user\'s view: invisible, unpatchable, undeletable, unusable — all 404', async () => {
    await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'Mine' } });
    expect((await call('GET', '/api/mail/views', { t: tok(SU) })).json.views).toEqual([]);
    expect((await call('PATCH', '/api/mail/views/1', { t: tok(SU), body: { name: 'stolen' } })).status).toBe(404);
    expect((await call('DELETE', '/api/mail/views/1', { t: tok(SU) })).status).toBe(404);
    expect((await call('GET', '/api/mail/messages?view=1', { t: tok(SU) })).status).toBe(404);
    expect(W.T.inbox_views).toEqual([expect.objectContaining({ id: 1, user: READER, name: 'Mine' })]);
  });

  test('a view never grants: unreadable mailbox ids are refused on write; user is not a field', async () => {
    const r = await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'Sneaky', mailbox_ids: [1, 2] } });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/mailbox 2/);
    expect((await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'x', user: SU } })).status).toBe(400);
    expect(W.T.inbox_views).toEqual([]);
  });

  test('a view applies its scope + filters; a revoked grant just narrows it; explicit params override filters', async () => {
    const v = (await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'Q', mailbox_ids: [1], filters: { q: 'Plan' } } })).json.view;
    expect(ids(await call('GET', `/api/mail/messages?view=${v.id}`, { t: tok(READER) }))).toEqual([102, 101]);
    expect(ids(await call('GET', `/api/mail/messages?view=${v.id}&q=sale`, { t: tok(READER) }))).toEqual([103]);
    W.T.channel_grants = W.T.channel_grants.filter((g) => g.user !== READER);
    const r = await call('GET', `/api/mail/messages?view=${v.id}`, { t: tok(READER) });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([]);
  });

  test('counts: each view\'s INBOX unread under its own boxes + filters = the list it opens with Unread on', async () => {
    W.read(READER, 101);
    W.caseRow('CaseA1', '26-11111');
    W.T.mail_messages.find((m) => m.id === 102).log_id = W.logRow({ log_about_type: 'case', log_about_id: 'CaseA1' });
    const mk = async (t, body) => (await call('POST', '/api/mail/views', { t: tok(t), body })).json.view.id;
    const box1 = await mk(READER, { name: 'Box 1', mailbox_ids: [1] });
    const shop = await mk(READER, { name: 'Shop', filters: { from_domain: 'shop.test' } });
    const cased = await mk(READER, { name: 'Cased', filters: { has_case: true } });
    // stored before a grant was revoked / before validation tightened: no query, no failure
    W.T.inbox_views.push({ id: 90, user: READER, name: 'Gone', mailbox_ids: '[2]', filters: '{}', is_default: 0, sort_order: 0 });
    W.T.inbox_views.push({ id: 91, user: READER, name: 'Bad', mailbox_ids: null, filters: '{"from_domain":"nope"}', is_default: 0, sort_order: 0 });
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/views/counts', { t: tok(READER) });
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ [box1]: 3, [shop]: 2, [cased]: 1, 90: 0 });
    expect(W.statements.filter((x) => x.sql.startsWith('SELECT COUNT(*) AS n FROM mail_messages'))).toHaveLength(3);
    // each count is exactly the unread list of that view
    for (const id of [box1, shop, cased]) {
      const list = await call('GET', `/api/mail/messages?view=${id}&unread_only=1`, { t: tok(READER) });
      expect([id, list.json.messages.length]).toEqual([id, r.json.counts[id]]);
    }
    // all_folders views count the INBOX only: a Sent copy is never "read"
    const all = await mk(SU, { name: 'Box 2 everything', mailbox_ids: [2], filters: { all_folders: true } });
    expect((await call('GET', '/api/mail/views/counts', { t: tok(SU) })).json.counts).toEqual({ [all]: 2 });
    // another user's views never appear; no views → no mail query at all
    W.statements.length = 0;
    expect((await call('GET', '/api/mail/views/counts', { t: tok(NOBODY) })).json).toEqual({ status: 'success', counts: {} });
    expect(W.statements.some((x) => /mail_messages/.test(x.sql))).toBe(false);
  });

  test('validation: name, filter vocabulary, sort_order, the 50-view cap', async () => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(65) }, { name: 'a', filters: { body: 'x' } },
      { name: 'a', filters: { unread_only: 'yes' } }, { name: 'a', filters: { from_domain: 'nope' } },
      { name: 'a', sort_order: 1.5 }, { name: 'a', mailbox_ids: 'all' }, { name: 'a', color: 'red' }]) {
      expect([JSON.stringify(body), (await call('POST', '/api/mail/views', { t: tok(READER), body })).status])
        .toEqual([JSON.stringify(body), 400]);
    }
    for (let i = 0; i < 50; i++) W.T.inbox_views.push({ id: 1000 + i, user: READER, name: `v${i}`, mailbox_ids: null, filters: '{}', is_default: 0, sort_order: 0 });
    expect((await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'one more' } })).status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('case link (about-link machinery)', () => {
  beforeEach(() => {
    W.caseRow('CaseA1', '26-11111', '26-11111-tjt');
    W.caseRow('CaseB2', '26-22222', null);
  });

  test('a logged message: its log row gets about=case; no new log row', async () => {
    const lid = W.logRow({ log_link_id: 's101@outside.test' });
    W.T.mail_messages.find((m) => m.id === 101).log_id = lid;
    const r = await call('POST', '/api/mail/messages/101/case-link', { t: tok(READER), body: { case_id: 'CaseA1' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 101, log_id: lid, log_created: false, case: { case_id: 'CaseA1', case_number: '26-11111-tjt' } });
    expect(W.T.log).toHaveLength(1);
    expect(W.T.log[0]).toMatchObject({ log_about_type: 'case', log_about_id: 'CaseA1' });
    // relink to another case = one about-link, replaced
    await call('POST', '/api/mail/messages/101/case-link', { t: tok(READER), body: { case_id: 'CaseB2' } });
    expect(W.T.log[0]).toMatchObject({ log_about_type: 'case', log_about_id: 'CaseB2' });
  });

  test('a store-only message: its log row is created in the pipeline\'s shape, dated when sent, then stamped', async () => {
    const r = await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 202, log_created: true, case: { case_id: 'CaseB2', case_number: '26-22222' } });
    expect(W.T.log).toHaveLength(1);
    const l = W.T.log[0];
    expect(l).toMatchObject({
      log_type: 'email', log_link_type: 'email', log_link_id: 'noreply@court.test', log_link: '',
      log_about_type: 'case', log_about_id: 'CaseB2', log_by: SU, log_direction: 'incoming',
      log_subject: 'Court notice', log_from: 'noreply@court.test', log_to: 'box1@firm.test',
      log_date_utc: W.T.mail_messages.find((m) => m.id === 202).date.toISOString().slice(0, 19).replace('T', ' '),
    });
    expect(JSON.parse(l.log_data)).toEqual({ From: 'noreply@court.test', To: 'box1@firm.test', Subject: 'Court notice', Message: 'text 202' });
    expect(JSON.parse(l.log_extra)).toMatchObject({ source: 'mailbox-hub', mailbox_id: 2, mail_message_id: 202, folder: 'INBOX' });
    expect(W.T.mail_messages.find((m) => m.id === 202).log_id).toBe(l.log_id);
    // The list now shows the chip.
    const list = await call('GET', '/api/mail/messages?mailbox_ids=2', { t: tok(SU) });
    expect(list.json.messages.find((m) => m.id === 202).case).toEqual({ case_id: 'CaseB2', case_number: '26-22222' });
  });

  test('outgoing store-only mail is logged under the first recipient', async () => {
    W.message(220, { mailbox_id: 2, from_addr: 'Intake <intake@firm.test>', to_addrs: '"Doe, Jane" <jane@client.test>, b@x.test' });
    await call('POST', '/api/mail/messages/220/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } });
    expect(W.T.log[0]).toMatchObject({ log_direction: 'outgoing', log_link_id: 'jane@client.test', log_to: 'jane@client.test, b@x.test' });
  });

  test('a copy already on the log (another mailbox) is reused, not logged twice', async () => {
    const lid = W.logRow();
    W.T.mail_messages.find((m) => m.id === 102).log_id = lid; // box 1 copy logged
    const r = await call('POST', '/api/mail/messages/201/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } }); // box 2 copy
    expect(r.json).toMatchObject({ log_id: lid, log_created: false });
    expect(W.T.log).toHaveLength(1);
    expect(W.T.mail_messages.find((m) => m.id === 201).log_id).toBe(lid);
  });

  test('mail another source already logged (gmail-firm keys Workspace mail by provider id) is linked, never logged twice', async () => {
    const lid = W.logRow({ log_link_id: 'noreply@court.test', log_about_type: 'case', log_about_id: 'CaseA1' });
    W.T.mail_messages.find((m) => m.id === 202).provider_id = '18c2f1a9b3d4e5f6';
    W.execution({ message_id: '18C2F1A9B3D4E5F6', status: 'duplicate', log_id: null }); // a later re-POST: no log row
    W.execution({ message_id: '18C2F1A9B3D4E5F6', log_id: lid });                        // general_ci: case-blind
    const r = await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 202, log_id: lid, log_created: false });
    expect(W.T.log).toHaveLength(1);
    expect(W.T.log[0]).toMatchObject({ log_about_type: 'case', log_about_id: 'CaseB2' });
    expect(W.T.mail_messages.find((m) => m.id === 202).log_id).toBe(lid);
  });

  test('the RFC Message-ID (bare or bracketed) and a forwarded twin\'s provider id count too', async () => {
    const a = W.logRow();
    W.execution({ source_id: 7, message_id: '<m202@x.test>', log_id: a });
    expect((await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } })).json).toMatchObject({ log_id: a, log_created: false });
    // 220 in box 2 has a Workspace twin (box 3) that Apps Script logged by Gmail id
    W.mailbox(3, { address: 'ws@firm.test' });
    W.message(220, { mailbox_id: 2, message_id: 'fwd@x.test' });
    W.message(320, { mailbox_id: 3, message_id: 'fwd@x.test', provider_id: 'abc123' });
    const b = W.logRow();
    W.execution({ message_id: 'abc123', log_id: b });
    expect((await call('POST', '/api/mail/messages/220/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } })).json).toMatchObject({ log_id: b, log_created: false });
    expect(W.T.log).toHaveLength(2);
  });

  test('an execution whose log row is gone is ignored — the row is created instead', async () => {
    W.execution({ message_id: 'm202@x.test', log_id: 999 }); // no such log row
    const r = await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(r.json).toMatchObject({ log_created: true });
    expect(r.json.log_id).not.toBe(999);
  });

  test('store-only folder: refused for STORE_ONLY_GRACE_MIN after the worker stored it (another sync may still log it)', async () => {
    const m = W.T.mail_messages.find((x) => x.id === 202);
    m.ingested_at = new Date(Date.now() - 60_000);
    const r = await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(new RegExp(`${read.STORE_ONLY_GRACE_MIN} minutes`));
    expect(W.T.log).toEqual([]);
    // (the 409 rolled the fake back to its BEGIN snapshot: re-find the row)
    const m2 = W.T.mail_messages.find((x) => x.id === 202);
    expect(m2.log_id).toBeNull();
    m2.ingested_at = new Date(Date.now() - (read.STORE_ONLY_GRACE_MIN + 1) * 60_000);
    expect((await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } })).json).toMatchObject({ log_created: true });
    // An emitting folder is not held by the grace (the worker's cursor is the gate there).
    W.T.mail_messages.find((x) => x.id === 103).ingested_at = new Date();
    expect((await call('POST', '/api/mail/messages/103/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } })).status).toBe(200);
  });

  test('the log row is dated when sent — never after the worker stored it (the Date header is the sender\'s)', async () => {
    const m = W.T.mail_messages.find((x) => x.id === 202);
    m.date = new Date('2099-01-01T00:00:00Z');
    m.ingested_at = new Date('2026-10-02T03:04:05Z');
    await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(W.T.log[0].log_date_utc).toBe('2026-10-02 03:04:05');
  });

  test('mail the ingest worker may still emit → 409, nothing written', async () => {
    // box 1's INBOX emits; its cursor has not passed UID 104 yet.
    W.T.mailboxes.find((b) => b.id === 1).ingest_state = JSON.stringify({ INBOX: { uidvalidity: 1, last_uid: 103 } });
    const r = await call('POST', '/api/mail/messages/104/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } });
    expect(r.status).toBe(409);
    expect(W.T.log).toEqual([]);
    expect(W.T.mail_messages.find((m) => m.id === 104).log_id).toBeNull();
    // Below the cursor (already through the pipeline, which kept no log row) → allowed.
    expect((await call('POST', '/api/mail/messages/103/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } })).status).toBe(200);
  });

  test('unreadable message → 404 (no write); unknown case → 404; bad body → 400', async () => {
    expect((await call('POST', '/api/mail/messages/202/case-link', { t: tok(READER), body: { case_id: 'CaseA1' } })).status).toBe(404);
    expect((await call('POST', '/api/mail/messages/101/case-link', { t: tok(READER), body: { case_id: 'NoSuch' } })).status).toBe(404);
    for (const body of [{}, { case_id: '' }, { case_id: 'a b' }, { case_id: 'x'.repeat(21) }, { case_id: 'CaseA1', extra: 1 }]) {
      expect((await call('POST', '/api/mail/messages/101/case-link', { t: tok(READER), body })).status).toBe(400);
    }
    expect(W.T.log).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('always show images from a sender (per user)', () => {
  test('trust / list / untrust are the caller\'s own; addresses are validated and lowercased; trust is idempotent', async () => {
    let r = await call('POST', '/api/mail/image-senders', { t: tok(READER), body: { address: '  Deals@Shop.TEST ' } });
    expect([r.status, r.json.address]).toEqual([201, 'deals@shop.test']);
    expect((await call('POST', '/api/mail/image-senders', { t: tok(READER), body: { address: 'deals@shop.test' } })).status).toBe(201);
    await call('POST', '/api/mail/image-senders', { t: tok(SU), body: { address: 'noreply@court.test' } });
    expect(W.T.mail_image_senders.filter((x) => x.user === READER).map((x) => x.address)).toEqual(['deals@shop.test']);
    expect((await call('GET', '/api/mail/image-senders', { t: tok(READER) })).json.senders.map((x) => x.address)).toEqual(['deals@shop.test']);
    expect((await call('GET', '/api/mail/image-senders', { t: tok(SU) })).json.senders.map((x) => x.address)).toEqual(['noreply@court.test']);
    // someone else's trust is not yours to remove
    expect((await call('DELETE', '/api/mail/image-senders/noreply%40court.test', { t: tok(READER) })).json.removed).toBe(0);
    expect(W.T.mail_image_senders).toHaveLength(2);
    r = await call('DELETE', `/api/mail/image-senders/${encodeURIComponent('DEALS@shop.test')}`, { t: tok(READER) });
    expect(r.json).toMatchObject({ address: 'deals@shop.test', removed: 1 });
    for (const bad of [{}, { address: 'nope' }, { address: 'a b@c.test' }, { address: '<a@b.test>' }, { address: 5 }, { address: `${'x'.repeat(250)}@b.test` }]) {
      expect((await call('POST', '/api/mail/image-senders', { t: tok(READER), body: bad })).status).toBe(400);
    }
  });

  test('thread and single-message reads carry from_email (the <angle> address) and images_trusted for THIS reader only', async () => {
    W.T.mail_messages.find((m) => m.id === 102).from_addr = '"someone@else.test via Group" <Group@Lists.test>';
    W.trust(READER, 'group@lists.test');
    const t = await call('GET', '/api/mail/threads/root%40x.test', { t: tok(READER) });
    expect(t.json.messages.map((m) => [m.id, m.from_email, m.images_trusted])).toEqual([[101, 's101@outside.test', false], [102, 'group@lists.test', true]]);
    const other = await call('GET', '/api/mail/threads/root%40x.test', { t: tok(SU) });
    expect(other.json.messages.map((m) => m.images_trusted)).toEqual([false, false]);
    W.trust(READER, 'deals@shop.test');
    const one = await call('GET', '/api/mail/messages/103', { t: tok(READER) });
    expect([one.json.messages[0].from_email, one.json.messages[0].images_trusted]).toEqual(['deals@shop.test', true]);
  });
});

describe('related: open the client\'s file from the mail', () => {
  beforeEach(() => {
    // the conversation root@x.test: 101 from a client, 102 cc'ing a trustee; firm addresses on both
    Object.assign(W.T.mail_messages.find((m) => m.id === 101), { from_addr: 'Jane Doe <JANE@client.test>', to_addrs: 'Billing <billing@firm.test>', cc_addrs: 'staff@firm.test' });
    Object.assign(W.T.mail_messages.find((m) => m.id === 102), { from_addr: 'billing@firm.test', to_addrs: 'jane@client.test, Trustee <t@trustee.test>, intake@firm.test', cc_addrs: 'nobody@unknown.test' });
    W.contact(500, 'Doe, Jane', ['jane@client.test']);
    W.contact(600, 'Trustee, Tom', ['t@trustee.test'], { kind: 'person' });
    W.contact(700, 'Old Owner', [], { ended: ['nobody@unknown.test'] });   // an ENDED email row never matches
    W.contact(800, 'Firm Staff', ['staff@firm.test']);                      // firm domain: never looked up
    W.caseRow('CaseOld', '20-00001', null, { case_stage: 'Closed', case_open_date: '2020-01-01' });
    W.caseRow('CaseNew', '26-11111', '26-11111-tjt', { case_stage: 'Filed', case_open_date: '2026-02-01' });
    W.caseRow('CaseOpen', null, null, { case_stage: 'Open', case_open_date: '2026-09-01' });
    W.caseRow('CaseOther', '26-22222', null, { case_stage: 'Open' });
    W.caseRow('CaseShut', '25-33333', null, { case_stage: 'Closed', case_open_date: '2026-10-01' }); // newest, but closed
    W.relate('CaseOld', 500, 'Primary');
    W.relate('CaseNew', 500, 'Secondary');
    W.relate('CaseOpen', 500, 'Primary');
    W.relate('CaseShut', 500, 'Primary');
    W.relate('CaseOther', 600, 'Other');  // the trustee is on it, not a client of it
  });

  test('outside addresses only, senders first; client cases open-first then newest; non-clients are a contact chip with no cases', async () => {
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/messages/102/related', { t: tok(READER) });
    expect(r.status).toBe(200);
    expect(r.json.contacts).toEqual([
      { contact_id: 500, name: 'Doe, Jane', kind: 'person', emails: ['jane@client.test'], role: 'from', cases: [
        { case_id: 'CaseOpen', case_number: null, case_type: 'BK', case_stage: 'Open', case_status: 'New', relation: 'Primary' },
        { case_id: 'CaseNew', case_number: '26-11111-tjt', case_type: 'BK', case_stage: 'Filed', case_status: 'New', relation: 'Secondary' },
        { case_id: 'CaseShut', case_number: '25-33333', case_type: 'BK', case_stage: 'Closed', case_status: 'New', relation: 'Primary' },
        { case_id: 'CaseOld', case_number: '20-00001', case_type: 'BK', case_stage: 'Closed', case_status: 'New', relation: 'Primary' },
      ] },
      { contact_id: 600, name: 'Trustee, Tom', kind: 'person', emails: ['t@trustee.test'], role: 'to', cases: [] },
    ]);
    // only an ENDED row holds nobody@ — an address to add to a client
    expect(r.json.unmatched).toEqual([{ email: 'nobody@unknown.test', name: null, role: 'to' }]);
    // the lookup never asked about a firm address or a firm mailbox
    const lookup = W.statements.find((x) => x.sql.startsWith('SELECT ce.email'));
    expect([...lookup.params[0]].sort()).toEqual(['jane@client.test', 'nobody@unknown.test', 't@trustee.test']);
  });

  test('threadless mail looks at that one message; nothing outside → no contact query at all; unreadable → 404', async () => {
    W.T.mail_messages.find((m) => m.id === 103).to_addrs = 'Jane <jane@client.test>';
    const r = await call('GET', '/api/mail/messages/103/related', { t: tok(READER) });
    expect(r.json.contacts.map((c) => [c.contact_id, c.role])).toEqual([[500, 'to']]);
    Object.assign(W.T.mail_messages.find((m) => m.id === 104), { from_addr: 'billing@firm.test', to_addrs: 'intake@firm.test', cc_addrs: null });
    W.statements.length = 0;
    expect((await call('GET', '/api/mail/messages/104/related', { t: tok(READER) })).json).toEqual({ status: 'success', contacts: [], unmatched: [] });
    expect(W.statements.some((x) => /contact_emails/.test(x.sql))).toBe(false);
    expect((await call('GET', '/api/mail/messages/202/related', { t: tok(READER) })).status).toBe(404);
    expect((await call('GET', '/api/mail/messages/202/related', { t: tok(SS) })).status).toBe(200); // attorney READ bypass
  });

  test('unmatched: outside addresses no active contact row holds — senders first, with the name the mail gave; automated senders left out', async () => {
    W.message(110, { mailbox_id: 1, thread_key: 'u@x.test', from_addr: '"Smith, Ann" <ann@new.test>', to_addrs: 'billing@firm.test, "Bob \\"B\\" Lee" <BOB@new.test>', cc_addrs: 'jane@client.test, carl@new.test' });
    W.message(111, { mailbox_id: 1, thread_key: 'u@x.test', from_addr: 'billing@firm.test', to_addrs: 'ann@new.test, Dee <dee@new.test>', cc_addrs: 'noreply@vendor.test' });
    W.message(112, { mailbox_id: 1, thread_key: 'u@x.test', from_addr: 'Mailer <do_not_reply@court.test>', to_addrs: 'billing@firm.test' });
    W.message(113, { mailbox_id: 2, thread_key: 'u@x.test', from_addr: 'Eve <eve@new.test>', to_addrs: 'intake@firm.test' }); // box 2: not readable for READER
    const r = await call('GET', '/api/mail/messages/111/related', { t: tok(READER) });
    expect(r.json.contacts.map((c) => c.contact_id)).toEqual([500]);
    // senders first, then recipients newest message first (111 before 110) — related()'s order
    expect(r.json.unmatched).toEqual([
      { email: 'ann@new.test', name: 'Smith, Ann', role: 'from' },
      { email: 'dee@new.test', name: 'Dee', role: 'to' },
      { email: 'bob@new.test', name: 'Bob "B" Lee', role: 'to' },
      { email: 'carl@new.test', name: null, role: 'to' },
    ]);
    // SU reads box 2 too: Eve is a sender of the same conversation
    expect((await call('GET', '/api/mail/messages/111/related', { t: tok(SU) })).json.unmatched.map((u) => [u.email, u.role]).slice(0, 2))
      .toEqual([['eve@new.test', 'from'], ['ann@new.test', 'from']]);
  });

  test('AUTOMATED_RE: no-reply style local parts only, whole words', () => {
    for (const a of ['noreply@x.test', 'no-reply@x.test', 'no_reply+1@x.test', 'do_not_reply@psc.uscourts.gov', 'donotreply@x.test', 'Do-Not-Reply@x.test',
      'mailer-daemon@x.test', 'postmaster@x.test', 'bounce@x.test', 'bounces+abc@x.test', 'notification@x.test', 'notifications@github.test']) {
      expect([a, read.AUTOMATED_RE.test(a)]).toEqual([a, true]);
    }
    for (const a of ['jane.noreply@x.test', 'notify@x.test', 'replyto@x.test', 'noreplyjane@x.test', 'bouncer@x.test', 'jane@noreply.test']) {
      expect([a, read.AUTOMATED_RE.test(a)]).toEqual([a, false]);
    }
  });

  test('addressList: quoted commas and escapes, the <angle> address over the name, bare addresses unnamed, junk dropped', () => {
    expect(read.addressList('"Doe, Jane" <JANE@x.test>, b@y.test, Bob <bob@z.test>, undisclosed-recipients:;, "x@y.com via L" <list@z.org>, "Q \\"q\\" Z" <q@q.test>, "jane@x.test" <jane@x.test>'))
      .toEqual([
        { email: 'jane@x.test', name: 'Doe, Jane' }, { email: 'b@y.test', name: null }, { email: 'bob@z.test', name: 'Bob' },
        { email: 'list@z.org', name: 'x@y.com via L' }, { email: 'q@q.test', name: 'Q "q" Z' }, { email: 'jane@x.test', name: null },
      ]);
    expect(read.addressList(null)).toEqual([]);
  });

  test('at most RELATED_CASES_PER_CONTACT cases per contact', async () => {
    for (let i = 0; i < read.RELATED_CASES_PER_CONTACT + 4; i++) {
      W.caseRow(`Bulk${i}`, `26-3${String(i).padStart(4, '0')}`, null, { case_stage: 'Closed', case_open_date: `2019-01-${String(i + 1).padStart(2, '0')}` });
      W.relate(`Bulk${i}`, 500);
    }
    const r = await call('GET', '/api/mail/messages/101/related', { t: tok(READER) });
    const jane = r.json.contacts.find((c) => c.contact_id === 500);
    expect(jane.cases).toHaveLength(read.RELATED_CASES_PER_CONTACT);
    expect(jane.cases[0].case_id).toBe('CaseOpen');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('first-seen: the add-to-client start-date default', () => {
  test('the earliest readable mail carrying the address (From / To / Cc), as a FIRM-LOCAL day', async () => {
    const set = (id, f) => Object.assign(W.T.mail_messages.find((m) => m.id === id), f);
    set(101, { to_addrs: 'billing@firm.test, Jane <jane@client.test>', date: new Date('2026-03-01T03:00:00Z') }); // 22:00 Feb 28 in Detroit
    set(102, { from_addr: 'jane@client.test', date: new Date('2026-04-01T15:00:00Z') });
    set(201, { cc_addrs: 'a@b.test, jane@client.test', date: new Date('2026-01-05T15:00:00Z') });                 // box 2
    set(103, { from_addr: 'mjane@client.test', date: new Date('2025-01-01T15:00:00Z') });                        // not her
    set(104, { to_addrs: 'jane@client.test.evil', date: new Date('2025-01-02T15:00:00Z') });                     // not her
    W.statements.length = 0;
    const r = await call('GET', '/api/mail/first-seen?address=JANE%40client.test', { t: tok(READER) });
    expect(r.json).toEqual({ status: 'success', address: 'jane@client.test', first_seen: '2026-02-28' });
    const q = W.statements.find((x) => x.sql.startsWith('SELECT MIN(date)'));
    expect(q.params[0]).toEqual([1]);                                       // the reader's scope only
    expect(q.params.slice(1, 4)).toEqual(['%jane@client.test%', '%jane@client.test%', '%jane@client.test%']);
    expect((await call('GET', '/api/mail/first-seen?address=jane@client.test', { t: tok(SU) })).json.first_seen).toBe('2026-01-05');
  });

  test('LIKE metacharacters are escaped; none seen → null; no readable mailbox → null without a mail query; junk → 400', async () => {
    W.statements.length = 0;
    expect((await call('GET', '/api/mail/first-seen?address=a_b%25c@x.test', { t: tok(READER) })).json.first_seen).toBeNull();
    expect(W.statements.find((x) => x.sql.startsWith('SELECT MIN(date)')).params[1]).toBe('%a\\_b\\%c@x.test%');
    W.statements.length = 0;
    expect((await call('GET', '/api/mail/first-seen?address=x@y.test', { t: tok(NOBODY) })).json).toEqual({ status: 'success', address: 'x@y.test', first_seen: null });
    expect(W.statements.some((x) => /mail_messages/.test(x.sql))).toBe(false);
    for (const bad of ['', 'not-an-address', 'a@b', '%40x.test', 'a b@x.test']) {
      expect([bad, (await call('GET', `/api/mail/first-seen?address=${encodeURIComponent(bad)}`, { t: tok(READER) })).status]).toEqual([bad, 400]);
    }
    expect((await call('GET', '/api/mail/first-seen', { t: tok(READER) })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('emissionPending (pure)', () => {
  const box = (folders, state) => ({ ingest_folders: folders, ingest_state: state });
  const F = { INBOX: { emit_to_rules: true }, Sent: { emit_to_rules: false } };
  test.each([
    ['emitting, below cursor', F, { INBOX: { last_uid: 10 } }, { folder: 'INBOX', uid: 10 }, false],
    ['emitting, above cursor', F, { INBOX: { last_uid: 10 } }, { folder: 'inbox', uid: 11 }, true],
    ['emitting, no cursor yet', F, {}, { folder: 'INBOX', uid: 1 }, true],
    ['emitting, uid parked', F, { INBOX: { last_uid: 10 } }, { folder: 'INBOX', uid: null }, true],
    ['re-key backfill still walking', F, { INBOX: { last_uid: 10, backfill_uid: 5, backfill_emit_after: '2026-01-01T00:00:00Z' } }, { folder: 'INBOX', uid: 4 }, true],
    ['re-key backfill already past', F, { INBOX: { last_uid: 10, backfill_uid: 5, backfill_emit_after: '2026-01-01T00:00:00Z' } }, { folder: 'INBOX', uid: 6 }, false],
    ['store-only folder', F, {}, { folder: 'Sent', uid: 99 }, false],
    ['folder no longer configured', F, {}, { folder: 'Archive', uid: 99 }, false],
  ])('%s', (_n, folders, state, msg, want) => {
    expect(read.emissionPending(box(folders, state), msg)).toBe(want);
  });
});
