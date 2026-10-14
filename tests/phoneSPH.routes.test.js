/**
 * tests/phoneSPH.routes.test.js — comms slice S-PH: per-line phone reading +
 * grant-gated SMS send (routes/api.phoneComms.js, services/phoneCommsService.js,
 * the phone_line branches of services/mailboxService.js, and the staff-JWT
 * gate in routes/internal/{sms,mms}.js). Run: npx jest tests/phoneSPH
 *
 * HARNESS. The REAL routers, services, lib/auth.jwtOrApiKey and
 * lib/auth.superuser run over an express app on an ephemeral port. The
 * database is the stateful fake in tests/helpers/phoneSPHWorld.js (unknown
 * statements THROW); the SQL itself is held to MySQL in
 * tests/phoneSPH.mysql.test.js (gated). The provider boundary is the only
 * stub: phoneService.sendSms / sendMms are spied (they would dial out) — the
 * grant seat is the route, and phoneService stays grant-blind (D6).
 *
 * WHAT IS PINNED (mutation-checked — the S-PH report lists each mutation):
 *   access    SU every line (inactive too); attorney every line READ, send /
 *             manage only from a grant; grantee their can_read lines; nobody
 *             nothing; an x-api-key caller 403.
 *   attrib.   incoming → to_number, else from_number (NULL direction too);
 *             orphans and suppressed rows invisible; a number on the FROM
 *             side of an incoming row is not that line's; a line-to-line text
 *             is on both lines, once each.
 *   reads     conversations grouped by party over texts AND calls (a number
 *             that only called has one; `last` shaped by kind), newest
 *             activity first, paged by last id; one conversation oldest-first
 *             with an older cursor,
 *             its texts AND calls interleaved (`kind`; calls shaped like the
 *             call log's; suppressed calls out); the call log newest-first,
 *             missed / unanswered / duration; names from the ACTIVE owner of
 *             a number only.
 *   send      can_send only (attorney bypass and read-only grants refused);
 *             SU needs step-up; inactive line 409; bad to / message 400;
 *             provider failure 502 + audit; rate limit; nothing reaches
 *             phoneService unless every gate passed.
 *   all       All numbers (/api/phone-lines/all/*): every READABLE line at
 *             once — one row per OUTSIDE number (firm-line parties left
 *             out), its thread and the call log merged, every item tagged
 *             with its line_id; the scope is the caller's (a grantee sees
 *             only granted lines' events); routed ahead of /:id.
 *   /internal staff JWT needs can_send on `from`; API key stays grant-blind.
 *   grants    phone_line CRUD mirrors the mailbox block (elevation, manager
 *             scope, ownership, audit tool 'phone_lines', channel pinned);
 *             NO INERT GRANT — a written grant is effective on the next read.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phone-sph-test-secret';
process.env.INTERNAL_API_KEY = 'yci_phone_sph_internal';
delete process.env.SU_STEPUP; // step-up ON (the default)

const express = require('express');
const jwt = require('jsonwebtoken');
const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');
const phoneService = require('../services/phoneService');
const mbx = require('../services/mailboxService');
const phone = require('../services/phoneCommsService');
const router = require('../routes/api.phoneComms');
const smsRouter = require('../routes/internal/sms');
const mmsRouter = require('../routes/internal/mms');
const { makeWorld, SPH_SEED } = require('./helpers/phoneSPHWorld');

const SU = 6; const SS = 1; const SB = 5; const RENA = 22; const NOBODY = 9; const DEMOTED = 7;

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(router);
app.use(smsRouter);
app.use(mmsRouter);

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

let sent;
beforeEach(() => {
  W = makeWorld();
  _resetRateLimits();
  router._resetSendRateLimit();
  sent = [];
  jest.spyOn(phoneService, 'sendSms').mockImplementation(async (db, from, to, message) => { sent.push({ kind: 'sms', from, to, message }); return { id: 'prov-1' }; });
  jest.spyOn(phoneService, 'sendMms').mockImplementation(async (db, from, to, text, url) => { sent.push({ kind: 'mms', from, to, text, url }); return { id: 'prov-2' }; });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const tok = (user, user_auth = 'authorized', roles = []) =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, roles, aud: 'staff' }, process.env.JWT_SECRET);
const T = {
  su: () => tok(SU, 'authorized', ['su']), ss: () => tok(SS), sb: () => tok(SB), rena: () => tok(RENA), nobody: () => tok(NOBODY),
  demoted: () => tok(DEMOTED, 'authorized', ['su']), // the JWT claims SU; the DB says otherwise
};
const ELEV = () => mintElevationToken(SU);

async function call(method, url, { t, body, elev, apiKey, headers: extra } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (elev) headers['X-SU-Elevation'] = elev;
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-json */ }
  return { status: r.status, json, text };
}
const ids = (rows) => rows.map((r) => r.id);

// ─────────────────────────────────────────────────────────────────────────────
describe('access resolution (mailboxService, phone_line)', () => {
  test('SU: every line, inactive included, full flags; viewer.su', async () => {
    const r = await call('GET', '/api/phone-lines/readable', { t: T.su() });
    expect(r.status).toBe(200);
    expect(r.json.viewer).toEqual({ su: true });
    expect(ids(r.json.lines)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(r.json.lines.find((l) => l.id === 7)).toMatchObject({ active: false, can_read: true, can_send: true, can_manage: true });
    for (const l of r.json.lines) {
      expect(Object.keys(l).sort()).toEqual(['active', 'can_manage', 'can_read', 'can_send', 'display_name', 'id', 'mms_capable', 'phone_number', 'provider']);
    }
    expect(r.text).not.toMatch(/credential_id|provider_id|PNx/);
  });

  test('attorney: READ on every line without a row; send / manage only from the grant row', async () => {
    W.grant(SS, 1, { can_read: true, can_send: true });
    const r = await call('GET', '/api/phone-lines/readable', { t: T.ss() });
    expect(r.json.viewer).toEqual({ su: false });
    expect(ids(r.json.lines)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(r.json.lines.every((l) => l.can_read === true && l.role === 'attorney')).toBe(true);
    expect(r.json.lines.filter((l) => l.can_send).map((l) => l.id)).toEqual([1]);
    expect(r.json.lines.some((l) => l.can_manage)).toBe(false);
    expect(await mbx.getAccess(W.db, SS, 'phone_line', 2))
      .toEqual({ can_read: true, can_send: false, can_manage: false, su: false, role: 'attorney' });
  });

  test('grantee: only can_read rows; a send-only grant is sendable but not readable', async () => {
    W.grant(RENA, 3, { can_read: true, can_send: true });
    W.grant(RENA, 6, { can_send: true });
    W.grant(RENA, 2, { can_manage: true });
    const r = await call('GET', '/api/phone-lines/readable', { t: T.rena() });
    expect(ids(r.json.lines)).toEqual([3]);
    expect(r.json.lines[0]).toMatchObject({ can_read: true, can_send: true, can_manage: false });
    expect(r.json.lines[0]).not.toHaveProperty('role');
    const s = await call('GET', '/api/phone-lines/sendable', { t: T.rena() });
    expect(ids(s.json.lines)).toEqual([3, 6]);
  });

  test('nobody: nothing; the demoted SU (JWT claims SU, DB does not) gets nothing either', async () => {
    for (const t of [T.nobody(), T.demoted()]) {
      expect((await call('GET', '/api/phone-lines/readable', { t })).json.lines).toEqual([]);
      expect((await call('GET', '/api/phone-lines/sendable', { t })).json.lines).toEqual([]);
    }
  });

  test('sendable: SU every line; the attorney only granted lines (no role bypass on send)', async () => {
    W.grant(SS, 1, { can_read: true, can_send: true });
    expect(ids((await call('GET', '/api/phone-lines/sendable', { t: T.su() })).json.lines)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(ids((await call('GET', '/api/phone-lines/sendable', { t: T.ss() })).json.lines)).toEqual([1]);
  });

  test('an x-api-key caller is refused (grants resolve against a person)', async () => {
    for (const url of ['/api/phone-lines/readable', '/api/phone-lines/sendable', '/api/phone-lines/1/calls']) {
      const r = await call('GET', url, { apiKey: process.env.INTERNAL_API_KEY });
      expect(r.status).toBe(403);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('line attribution', () => {
  test('incoming → to_number, outgoing → from_number; orphans, suppressed and from-side-only rows are on no line', async () => {
    const S = SPH_SEED(W);
    const convos = async (line) => (await call('GET', `/api/phone-lines/${line}/conversations`, { t: T.su() })).json.conversations;
    const l1 = await convos(1);
    expect(l1.map((c) => c.other_party)).toEqual(['3135550001', '22395', S.L3, '3135550002']);
    // P2 on line 1 = call #3 + SMS #4; #12 has line 1 on the FROM side of an INCOMING row → not line 1's
    expect(l1.find((c) => c.other_party === S.P2)).toMatchObject({ count: 2, last_id: 4 });
    // P3 only ever sent a suppressed text → no conversation
    expect(l1.some((c) => c.other_party === S.P3)).toBe(false);
    // the orphan call (to 7344663328) is on no line; nobody's call log has it
    for (const l of [1, 2, 3, 4, 6, 7]) {
      const calls = (await call('GET', `/api/phone-lines/${l}/calls`, { t: T.su() })).json.calls;
      expect(calls.some((c) => c.id === 6)).toBe(false);
    }
  });

  test('a line-to-line text is on both lines, once each (never de-duplicated)', async () => {
    const S = SPH_SEED(W);
    const l1 = (await call('GET', `/api/phone-lines/1/conversations/${S.L3}`, { t: T.su() })).json.messages;
    const l3 = (await call('GET', `/api/phone-lines/3/conversations/${S.L1}`, { t: T.su() })).json.messages;
    expect(l1.map((m) => [m.id, m.direction])).toEqual([[7, 'outgoing']]);
    expect(l3.map((m) => [m.id, m.direction])).toEqual([[8, 'incoming']]);
  });

  test('a NULL direction attributes to the from side (the generated column\'s IF)', async () => {
    SPH_SEED(W);
    const calls = (await call('GET', '/api/phone-lines/6/calls', { t: T.su() })).json.calls;
    expect(calls.map((c) => c.id)).toEqual([14, 11, 10]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reads', () => {
  test('conversations: newest activity first, counts, last snippet + direction, contact of the ACTIVE owner only', async () => {
    const S = SPH_SEED(W);
    const c = (await call('GET', '/api/phone-lines/1/conversations', { t: T.su() })).json;
    expect(c.line_id).toBe(1);
    const p1 = c.conversations[0];
    expect(p1).toMatchObject({ other_party: S.P1, count: 3, last_id: 13, contact: { contact_id: 501, name: 'Pat One' } });
    expect(p1.last).toMatchObject({ id: 13, direction: 'incoming', snippet: 'P1 again' });
    // P2's number belonged to a contact whose ownership ENDED → no name
    expect(c.conversations.find((x) => x.other_party === S.P2).contact).toBeNull();
    expect(c.next_cursor).toBeNull();
  });

  test('conversations count texts AND calls: a number that only CALLED has one, its `last` a call (missed / unanswered / duration)', async () => {
    const S = SPH_SEED(W);
    // line 6 has no texts at all — every conversation is calls (P4's call has a NULL direction: from side = line 6)
    const six = (await call('GET', '/api/phone-lines/6/conversations', { t: T.su() })).json.conversations;
    expect(six.map((c) => [c.other_party, c.count, c.last_id])).toEqual([[S.P4, 1, 14], [S.P2, 1, 11], [S.P1, 1, 10]]);
    expect(six.find((c) => c.other_party === S.P1)).toMatchObject({
      contact: { contact_id: 501, name: 'Pat One' },
      last: { id: 10, kind: 'call', direction: 'incoming', at: '2026-10-01T12:08:00.000Z', duration_s: 30, status: 'no-answer', unanswered: true, missed: true },
    });
    expect(six.find((c) => c.other_party === S.P2).last).toEqual({
      id: 11, kind: 'call', direction: 'outgoing', at: '2026-10-01T12:09:00.000Z', duration_s: 125, status: 'completed', unanswered: false, missed: false,
    });
    expect(six.find((c) => c.other_party === S.P1).last).not.toHaveProperty('snippet');
    // a text newer than the call: the conversation's `last` is the text; the count holds both
    W.sms(S.L6, S.P1, 'outgoing', { body: 'sorry we missed you' });             // 16
    const again = (await call('GET', '/api/phone-lines/6/conversations', { t: T.su() })).json.conversations;
    expect(again[0]).toMatchObject({ other_party: S.P1, count: 2, last_id: 16, last: { id: 16, kind: 'sms', direction: 'outgoing', snippet: 'sorry we missed you' } });
    // a suppressed call does not make a conversation, nor does a call with no number (#15, line 1)
    W.call(S.L6, '3135550009', 'incoming', { suppressed: 1 });
    const l6 = (await call('GET', '/api/phone-lines/6/conversations', { t: T.su() })).json.conversations;
    expect(l6.some((c) => c.other_party === '3135550009')).toBe(false);
    const l1 = (await call('GET', '/api/phone-lines/1/conversations', { t: T.su() })).json.conversations;
    expect(l1.some((c) => c.last_id === 15)).toBe(false);
  });

  test('conversations page by the last id; a malformed cursor is a 400', async () => {
    SPH_SEED(W);
    const p1 = (await call('GET', '/api/phone-lines/1/conversations?limit=2', { t: T.su() })).json;
    expect(p1.conversations.map((c) => c.last_id)).toEqual([13, 9]);
    expect(p1.next_cursor).toBe('9');
    const p2 = (await call('GET', `/api/phone-lines/1/conversations?limit=2&cursor=${p1.next_cursor}`, { t: T.su() })).json;
    expect(p2.conversations.map((c) => c.last_id)).toEqual([7, 4]);
    expect(p2.next_cursor).toBeNull();
    expect((await call('GET', '/api/phone-lines/1/conversations?cursor=abc', { t: T.su() })).status).toBe(400);
  });

  test('conversations ?kind=sms: texts only — a number that only called has no row, `count` and `last` are its texts; any other kind is a 400', async () => {
    const S = SPH_SEED(W);
    const l1 = (await call('GET', '/api/phone-lines/1/conversations?kind=sms', { t: T.su() })).json.conversations;
    // P2's call #3 is out of its count (2 → 1)
    expect(l1.map((c) => [c.other_party, c.count, c.last_id])).toEqual([[S.P1, 3, 13], ['22395', 1, 9], [S.L3, 1, 7], [S.P2, 1, 4]]);
    // line 6 is calls only → nothing
    expect((await call('GET', '/api/phone-lines/6/conversations?kind=sms', { t: T.su() })).json).toMatchObject({ conversations: [], next_cursor: null });
    // a text, then a newer call: unfiltered `last` is the call; texts-only `last` is the text, the count its texts
    W.sms(S.L6, S.P1, 'outgoing', { body: 'call us back' });                  // 16
    W.call(S.L6, S.P1, 'incoming');                                           // 17
    const both = (await call('GET', '/api/phone-lines/6/conversations', { t: T.su() })).json.conversations;
    expect(both[0]).toMatchObject({ other_party: S.P1, count: 3, last_id: 17, last: { kind: 'call' } });
    const texts = (await call('GET', '/api/phone-lines/6/conversations?kind=sms', { t: T.su() })).json.conversations;
    expect(texts).toEqual([expect.objectContaining({ other_party: S.P1, count: 1, last_id: 16, last: expect.objectContaining({ id: 16, kind: 'sms', snippet: 'call us back' }) })]);
    // pages under the filter
    const p1 = (await call('GET', '/api/phone-lines/1/conversations?kind=sms&limit=2', { t: T.su() })).json;
    const p2 = (await call('GET', `/api/phone-lines/1/conversations?kind=sms&limit=2&cursor=${p1.next_cursor}`, { t: T.su() })).json;
    expect([p1.conversations.map((c) => c.last_id), p2.conversations.map((c) => c.last_id), p2.next_cursor]).toEqual([[13, 9], [7, 4], null]);
    for (const k of ['call', 'SMS', 'x']) {
      expect([k, (await call('GET', `/api/phone-lines/1/conversations?kind=${k}`, { t: T.su() })).status]).toEqual([k, 400]);
    }
  });

  test('one conversation: newest page, oldest first; older pages by cursor; `at` prefers the provider ts', async () => {
    const S = SPH_SEED(W);
    const a = (await call('GET', `/api/phone-lines/1/conversations/${S.P1}?limit=2`, { t: T.su() })).json;
    expect(a.messages.map((m) => m.id)).toEqual([2, 13]);
    expect(a.contact).toEqual({ contact_id: 501, name: 'Pat One' });
    const row2 = W.T.phone_event_log.find((e) => e.id === 2);
    expect(a.messages[0].at).toBe(JSON.parse(row2.raw_extra).ts);
    const row13 = W.T.phone_event_log.find((e) => e.id === 13);
    expect(a.messages[1].at).toBe(row13.processed_at.toISOString()); // no ts → processed_at
    const b = (await call('GET', `/api/phone-lines/1/conversations/${S.P1}?limit=2&cursor=${a.next_cursor}`, { t: T.su() })).json;
    expect(b.messages.map((m) => m.id)).toEqual([1]);
    expect(b.next_cursor).toBeNull();
    expect((await call('GET', '/api/phone-lines/1/conversations/abc', { t: T.su() })).status).toBe(400);
  });

  test('one conversation carries the CALLS with that number too: kind, duration, unanswered / missed; suppressed calls out', async () => {
    const S = SPH_SEED(W);
    W.call(S.L1, S.P2, 'incoming', { suppressed: 1 });                                       // 16 suppressed — never shown
    W.call(S.L1, S.P2, 'outgoing', { raw_extra: JSON.stringify({ line: S.L1, started_at: '2026-10-01T12:20:00.000Z', ended_at: '2026-10-01T12:20:40.000Z', provider_status: 'no-answer' }) }); // 17
    const t = (await call('GET', `/api/phone-lines/1/conversations/${S.P2}`, { t: T.su() })).json;
    expect(t.messages.map((m) => [m.id, m.kind, m.direction])).toEqual([[3, 'call', 'incoming'], [4, 'sms', 'incoming'], [17, 'call', 'outgoing']]);
    const row3 = W.T.phone_event_log.find((e) => e.id === 3);
    expect(t.messages[0]).toEqual({
      id: 3, kind: 'call', direction: 'incoming', at: JSON.parse(row3.raw_extra).started_at, logged: false,
      duration_s: 85, status: 'completed', unanswered: false, missed: false,
    });
    const row4 = W.T.phone_event_log.find((e) => e.id === 4);
    expect(t.messages[1]).toEqual({ id: 4, kind: 'sms', direction: 'incoming', body: 'P2 texts', at: JSON.parse(row4.raw_extra).ts, logged: false });
    // nobody answered OUR call: unanswered, but only an incoming one is "missed"
    expect(t.messages[2]).toMatchObject({ kind: 'call', status: 'no-answer', unanswered: true, missed: false, duration_s: 40, at: '2026-10-01T12:20:00.000Z' });
    // line 6 ↔ P1 is one missed call; line 6 ↔ P4 one call with no direction and no times
    const six = (await call('GET', `/api/phone-lines/6/conversations/${S.P1}`, { t: T.su() })).json.messages;
    expect(six).toEqual([expect.objectContaining({ id: 10, kind: 'call', direction: 'incoming', missed: true, unanswered: true, duration_s: 30 })]);
    const p4 = (await call('GET', `/api/phone-lines/6/conversations/${S.P4}`, { t: T.su() })).json.messages;
    expect(p4).toEqual([expect.objectContaining({ id: 14, kind: 'call', direction: null, duration_s: null, status: null, unanswered: false, missed: false })]);
    // the orphan call (#6, to a number that is no line) is in no conversation
    for (const l of [1, 6]) {
      expect((await call('GET', `/api/phone-lines/${l}/conversations/${S.P4}`, { t: T.su() })).json.messages.some((m) => m.id === 6)).toBe(false);
    }
  });

  test('a mixed conversation pages on (processed_at, id) across texts and calls', async () => {
    const S = SPH_SEED(W);
    const a = (await call('GET', `/api/phone-lines/1/conversations/${S.P2}?limit=1`, { t: T.su() })).json;
    expect(a.messages.map((m) => [m.id, m.kind])).toEqual([[4, 'sms']]);
    const b = (await call('GET', `/api/phone-lines/1/conversations/${S.P2}?limit=1&cursor=${a.next_cursor}`, { t: T.su() })).json;
    expect(b.messages.map((m) => [m.id, m.kind])).toEqual([[3, 'call']]);
    expect(b.next_cursor).toBeNull();
  });

  test('call log: newest first, SMS and suppressed excluded, duration, missed only for an unanswered INCOMING call', async () => {
    SPH_SEED(W);
    const c6 = (await call('GET', '/api/phone-lines/6/calls', { t: T.su() })).json.calls;
    const byId = Object.fromEntries(c6.map((c) => [c.id, c]));
    expect(byId[10]).toMatchObject({ direction: 'incoming', missed: true, unanswered: true, status: 'no-answer', duration_s: 30, contact: { contact_id: 501, name: 'Pat One' } });
    expect(byId[11]).toMatchObject({ direction: 'outgoing', missed: false, unanswered: false, duration_s: 125 });
    expect(byId[14]).toMatchObject({ duration_s: null, status: null, unanswered: false, missed: false });
    const c1 = (await call('GET', '/api/phone-lines/1/calls', { t: T.su() })).json.calls;
    expect(c1.map((c) => c.id)).toEqual([15, 3]);
    expect(c1[0]).toMatchObject({ other_party: null, contact: null });
  });

  test('first-seen: the firm-local day of the earliest text or call with a number on the lines the caller READS; suppressed rows ignored', async () => {
    const S = SPH_SEED(W);
    // an older call from P1 on line 1 at 02:00 UTC = 22:00 the day before in Detroit, and an even older SUPPRESSED one
    W.call(S.L1, S.P1, 'incoming', { processed_at: new Date('2026-09-15T02:00:00Z') });
    W.call(S.L1, S.P1, 'incoming', { processed_at: new Date('2026-08-01T12:00:00Z'), suppressed: 1 });
    const fs = async (t, n) => call('GET', `/api/phone-lines/first-seen?number=${n}`, { t });
    expect((await fs(T.su(), S.P1)).json).toMatchObject({ number: S.P1, first_seen: '2026-09-14' });
    // a grantee who reads only line 6 sees line 6's first (the missed call #10, 2026-10-01) — never line 1's
    W.grant(NOBODY, 6, { can_read: 1 });
    expect((await fs(T.nobody(), S.P1)).json.first_seen).toBe('2026-10-01');
    // nothing on a readable line → null; no readable line at all → null without touching phone_event_log
    expect((await fs(T.nobody(), S.L3)).json.first_seen).toBeNull();
    const before = W.statements.length;
    expect((await fs(T.rena(), S.P1)).json.first_seen).toBeNull();
    expect(W.statements.slice(before).some((x) => /phone_event_log/.test(x.sql))).toBe(false);
    expect((await fs(T.su(), 'abc')).status).toBe(400);
    expect((await call('GET', `/api/phone-lines/first-seen?number=${S.P1}`, { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
  });

  test('call log pages on (processed_at, id)', async () => {
    for (let i = 0; i < 5; i++) W.call('2485592400', `31355500${10 + i}`, 'incoming');
    const a = (await call('GET', '/api/phone-lines/1/calls?limit=2', { t: T.su() })).json;
    expect(a.calls.map((c) => c.id)).toEqual([5, 4]);
    const b = (await call('GET', `/api/phone-lines/1/calls?limit=2&cursor=${a.next_cursor}`, { t: T.su() })).json;
    expect(b.calls.map((c) => c.id)).toEqual([3, 2]);
    const c = (await call('GET', `/api/phone-lines/1/calls?limit=2&cursor=${b.next_cursor}`, { t: T.su() })).json;
    expect(c.calls.map((x) => x.id)).toEqual([1]);
    expect(c.next_cursor).toBeNull();
  });

  test('read gating: nobody 404 (no oracle), send-only 403, missing line 404 for SU and attorney too', async () => {
    SPH_SEED(W);
    W.grant(RENA, 6, { can_send: true });
    for (const path of ['conversations', 'calls', 'conversations/3135550001']) {
      expect((await call('GET', `/api/phone-lines/1/${path}`, { t: T.nobody() })).status).toBe(404);
      expect((await call('GET', `/api/phone-lines/6/${path}`, { t: T.rena() })).status).toBe(403);
      expect((await call('GET', `/api/phone-lines/99/${path}`, { t: T.su() })).status).toBe(404);
      expect((await call('GET', `/api/phone-lines/99/${path}`, { t: T.ss() })).status).toBe(404);
      expect((await call('GET', `/api/phone-lines/1/${path}`, { t: T.ss() })).status).toBe(200);
    }
    expect((await call('GET', '/api/phone-lines/abc/calls', { t: T.su() })).status).toBe(400);
  });

  test('an inactive line stays readable to its grant holders', async () => {
    W.sms('2480000007', '3135550099', 'incoming', { body: 'old line' });
    W.grant(RENA, 7, { can_read: true });
    const r = await call('GET', '/api/phone-lines/7/conversations', { t: T.rena() });
    expect(r.status).toBe(200);
    expect(r.json.conversations.map((c) => c.other_party)).toEqual(['3135550099']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('All numbers — /api/phone-lines/all/*', () => {
  const get = async (url, t) => (await call('GET', url, { t })).json;

  test('conversations: one row per OUTSIDE number across every readable line, newest first; line_ids + last.line_id; firm-line parties and suppressed out', async () => {
    const S = SPH_SEED(W);
    const su = await get('/api/phone-lines/all/conversations', T.su());
    expect(su.all).toBe(true);
    expect(su.conversations.map((c) => [c.other_party, c.count, c.last_id, c.line_ids])).toEqual([
      [S.P4, 1, 14, [6]], [S.P1, 4, 13, [1, 6]], [S.P2, 3, 11, [1, 6]], ['22395', 1, 9, [1]],
    ]);
    const p1 = su.conversations.find((c) => c.other_party === S.P1);
    expect(p1).toMatchObject({ contact: { contact_id: 501, name: 'Pat One' }, last: { id: 13, kind: 'sms', snippet: 'P1 again', line_id: 1 } });
    expect(su.conversations[0].last).toMatchObject({ id: 14, kind: 'call', line_id: 6 });
    // the line-to-line text (#7 / #8: parties are firm lines) and the suppressed P3 are not rows
    expect(su.conversations.some((c) => [S.L1, S.L3, S.P3].includes(c.other_party))).toBe(false);
    // the attorney reads every line → the same list
    expect((await get('/api/phone-lines/all/conversations', T.ss())).conversations).toEqual(su.conversations);
  });

  test('scope is the caller\'s: a line-6 grantee sees line 6 only; nobody gets an empty list without touching phone_event_log', async () => {
    const S = SPH_SEED(W);
    W.grant(NOBODY, 6, { can_read: 1 });
    const g = await get('/api/phone-lines/all/conversations', T.nobody());
    expect(g.conversations.map((c) => [c.other_party, c.count, c.line_ids])).toEqual([[S.P4, 1, [6]], [S.P2, 1, [6]], [S.P1, 1, [6]]]);
    const t = await get(`/api/phone-lines/all/conversations/${S.P1}`, T.nobody());
    expect([t.line_ids, t.messages.map((m) => [m.id, m.line_id])]).toEqual([[6], [[10, 6]]]);
    expect((await get('/api/phone-lines/all/calls', T.nobody())).calls.map((c) => [c.id, c.line_id])).toEqual([[14, 6], [11, 6], [10, 6]]);
    W.T.channel_grants = [];
    const before = W.statements.length;
    expect(await get('/api/phone-lines/all/conversations', T.nobody())).toMatchObject({ conversations: [], next_cursor: null });
    expect(await get('/api/phone-lines/all/calls', T.nobody())).toMatchObject({ calls: [], next_cursor: null });
    expect(await get(`/api/phone-lines/all/conversations/${S.P1}`, T.nobody())).toMatchObject({ messages: [], line_ids: [] });
    expect(W.statements.slice(before).some((x) => /FROM phone_event_log/.test(x.sql))).toBe(false);
  });

  test('one number merged across lines: texts and calls from every readable line, oldest first, each with line_id; pages on (processed_at, id)', async () => {
    const S = SPH_SEED(W);
    const t = await get(`/api/phone-lines/all/conversations/${S.P1}`, T.su());
    expect(t).toMatchObject({ all: true, other_party: S.P1, contact: { contact_id: 501, name: 'Pat One' }, line_ids: [1, 6], next_cursor: null });
    expect(t.messages.map((m) => [m.id, m.kind, m.line_id])).toEqual([[1, 'sms', 1], [2, 'sms', 1], [10, 'call', 6], [13, 'sms', 1]]);
    expect(t.messages[2]).toMatchObject({ missed: true, duration_s: 30 });
    const a = await get(`/api/phone-lines/all/conversations/${S.P1}?limit=2`, T.su());
    expect(a.messages.map((m) => m.id)).toEqual([10, 13]);
    const b = await get(`/api/phone-lines/all/conversations/${S.P1}?limit=2&cursor=${a.next_cursor}`, T.su());
    expect([b.messages.map((m) => m.id), b.next_cursor]).toEqual([[1, 2], null]);
    // a firm line opened from All (e.g. from a call row): every readable line's copy, tagged
    expect((await get(`/api/phone-lines/all/conversations/${S.L3}`, T.su())).messages.map((m) => [m.id, m.line_id])).toEqual([[7, 1]]);
    expect((await call('GET', '/api/phone-lines/all/conversations/abc', { t: T.su() })).status).toBe(400);
  });

  test('calls: every readable line\'s call log merged, newest first, each with line_id (orphans out); pages', async () => {
    SPH_SEED(W);
    const c = await get('/api/phone-lines/all/calls', T.su());
    expect(c.calls.map((x) => [x.id, x.line_id])).toEqual([[15, 1], [14, 6], [11, 6], [10, 6], [3, 1]]);
    expect(c.calls.find((x) => x.id === 10)).toMatchObject({ missed: true, contact: { contact_id: 501, name: 'Pat One' } });
    const a = await get('/api/phone-lines/all/calls?limit=2', T.su());
    const b = await get(`/api/phone-lines/all/calls?limit=2&cursor=${a.next_cursor}`, T.su());
    const z = await get(`/api/phone-lines/all/calls?limit=2&cursor=${b.next_cursor}`, T.su());
    expect([a.calls, b.calls, z.calls].map((p) => p.map((x) => x.id))).toEqual([[15, 14], [11, 10], [3]]);
    expect(z.next_cursor).toBeNull();
  });

  test('conversations page by the last id; malformed cursors 400; humans only; "all" never reaches the /:id routes', async () => {
    const S = SPH_SEED(W);
    const a = await get('/api/phone-lines/all/conversations?limit=2', T.su());
    const b = await get(`/api/phone-lines/all/conversations?limit=2&cursor=${a.next_cursor}`, T.su());
    expect([a.conversations.map((c) => c.last_id), a.next_cursor, b.conversations.map((c) => c.last_id), b.next_cursor]).toEqual([[14, 13], '13', [11, 9], null]);
    for (const u of ['/api/phone-lines/all/conversations?cursor=x', '/api/phone-lines/all/calls?cursor=x', '/api/phone-lines/all/conversations/3135550001?cursor=x']) {
      expect([u, (await call('GET', u, { t: T.su() })).status]).toEqual([u, 400]);
    }
    for (const u of ['/api/phone-lines/all/conversations', '/api/phone-lines/all/conversations/3135550001', '/api/phone-lines/all/calls']) {
      expect([u, (await call('GET', u, { apiKey: process.env.INTERNAL_API_KEY })).status]).toEqual([u, 403]);
    }
    // ?kind=sms: texts only — P4 (calls only) drops out; P1 / P2 count their texts, line_ids the lines they TEXTED on.
    // P2's newest event is a call (#11) but its newest text is #4: the second page (HAVING MAX(id) < 9) has it only
    // because the filter holds on that page too
    const t1 = await get('/api/phone-lines/all/conversations?kind=sms&limit=2', T.su());
    const t2 = await get(`/api/phone-lines/all/conversations?kind=sms&limit=2&cursor=${t1.next_cursor}`, T.su());
    expect([t1.conversations, t2.conversations].map((pg) => pg.map((c) => [c.other_party, c.count, c.last_id, c.line_ids, c.last.kind])))
      .toEqual([[[S.P1, 3, 13, [1], 'sms'], ['22395', 1, 9, [1], 'sms']], [[S.P2, 1, 4, [1], 'sms']]]);
    expect([t1.next_cursor, t2.next_cursor]).toEqual(['9', null]);
    // a bad kind is a 400 even with nothing readable
    expect((await call('GET', '/api/phone-lines/all/conversations?kind=call', { t: T.su() })).status).toBe(400);
    expect((await call('GET', '/api/phone-lines/all/conversations?kind=call', { t: T.nobody() })).status).toBe(400);
    // a line literally numbered "all" does not exist: /:id with a non-integer is still a 400
    expect((await call('GET', '/api/phone-lines/allx/conversations', { t: T.su() })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('send — POST /api/phone-lines/:id/sms', () => {
  const sms = (line, t, body, extra = {}) => call('POST', `/api/phone-lines/${line}/sms`, { t, body, ...extra });

  test('a can_send grantee sends from the LINE\'s number to +1 E.164, text only; audited without number or text', async () => {
    W.grant(RENA, 3, { can_read: true, can_send: true });
    const r = await sms(3, T.rena(), { to: '(313) 555-0001', message: '  Hello there  ' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'success', line_id: 3, to: '3135550001', result: { id: 'prov-1' } });
    expect(sent).toEqual([{ kind: 'sms', from: '2489655355', to: '+13135550001', message: 'Hello there' }]);
    const a = W.T.admin_audit_log.find((x) => x.tool === 'phone_send');
    expect(a).toMatchObject({ status: 'sent', details: { line_id: 3, length: 11, via: 'grant' } });
    expect(JSON.stringify(a)).not.toMatch(/5550001|Hello/);
    expect(W.statements.some((s) => /phone_event_log/.test(s.sql))).toBe(false); // the webhook echo records it
  });

  test('read-only grantee 403; the attorney READ bypass does not send; nobody 404 — nothing dispatched', async () => {
    W.grant(RENA, 3, { can_read: true });
    expect((await sms(3, T.rena(), { to: '3135550001', message: 'x' })).status).toBe(403);
    expect((await sms(2, T.ss(), { to: '3135550001', message: 'x' })).status).toBe(403);
    expect((await sms(3, T.nobody(), { to: '3135550001', message: 'x' })).status).toBe(404);
    expect(sent).toEqual([]);
  });

  test('SU: step-up before anything is dispatched; elevated → sent', async () => {
    let r = await sms(1, T.su(), { to: '3135550001', message: 'hi' });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('elevation_required');
    expect(sent).toEqual([]);
    expect(W.T.admin_audit_log.find((x) => x.tool === 'phone_send')).toMatchObject({ status: 'rejected_no_elevation' });
    r = await sms(1, T.su(), { to: '3135550001', message: 'hi' }, { elev: ELEV() });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(W.T.admin_audit_log.filter((x) => x.tool === 'phone_send').pop()).toMatchObject({ status: 'sent', details: { via: 'su' } });
  });

  test('inactive line 409; missing line 404; bad recipient / message 400 — nothing dispatched', async () => {
    W.grant(RENA, 7, { can_read: true, can_send: true });
    W.grant(RENA, 3, { can_read: true, can_send: true });
    expect((await sms(7, T.rena(), { to: '3135550001', message: 'x' })).status).toBe(409);
    expect((await sms(99, T.su(), { to: '3135550001', message: 'x' }, { elev: ELEV() })).status).toBe(404);
    for (const body of [
      { to: '22395', message: 'x' }, { to: '+44 20 7946 0958', message: 'x' }, { to: '', message: 'x' },
      { to: '3135550001', message: '   ' }, { to: '3135550001' }, { to: '3135550001', message: 'y'.repeat(1001) },
      { to: '3135550001', message: 42 },
    ]) {
      const r = await sms(3, T.rena(), body);
      expect([r.status, body]).toEqual([400, body]);
    }
    expect((await sms(3, T.rena(), { to: '13135550001', message: 'y'.repeat(1000) })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test('a provider failure is a 502 the sender can read, audited send_failed', async () => {
    W.grant(RENA, 3, { can_read: true, can_send: true });
    phoneService.sendSms.mockImplementationOnce(async () => { throw new Error('Quo 422: invalid recipient'); });
    const r = await sms(3, T.rena(), { to: '3135550001', message: 'hi' });
    expect(r.status).toBe(502);
    expect(r.json.message).toMatch(/Quo 422: invalid recipient/);
    expect(W.T.admin_audit_log.find((x) => x.tool === 'phone_send')).toMatchObject({ status: 'send_failed' });
  });

  test('per-user rate limit: the 31st send in the window is a 429, not dispatched', async () => {
    W.grant(RENA, 3, { can_read: true, can_send: true });
    for (let i = 0; i < router.SEND_RATE_MAX; i++) expect((await sms(3, T.rena(), { to: '3135550001', message: `m${i}` })).status).toBe(200);
    expect((await sms(3, T.rena(), { to: '3135550001', message: 'one more' })).status).toBe(429);
    expect(sent).toHaveLength(router.SEND_RATE_MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('/internal/sms|mms/send — the staff-JWT grant gate (ruling 1)', () => {
  const internal = (kind, opts) => call('POST', `/internal/${kind}/send`, opts);

  test('staff JWT with can_send on `from` → sent; without → 403 and nothing sent', async () => {
    W.grant(RENA, 3, { can_read: true, can_send: true });
    let r = await internal('sms', { t: T.rena(), body: { from: '2489655355', to: '3135550001', message: 'hi' } });
    expect(r.status).toBe(200);
    r = await internal('sms', { t: T.rena(), body: { from: '2485592400', to: '3135550001', message: 'hi' } });
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/Stuart/);
    r = await internal('mms', { t: T.rena(), body: { from: '2485592400', to: '3135550001', text: 'x', attachment_url: 'https://x.test/a.png' } });
    expect(r.status).toBe(403);
    r = await internal('mms', { t: T.rena(), body: { from: '(248) 965-5355', to: '3135550001', text: 'x', attachment_url: 'https://x.test/a.png' } });
    expect(r.status).toBe(200);
    expect(sent.map((s) => [s.kind, s.from])).toEqual([['sms', '2489655355'], ['mms', '(248) 965-5355']]);
  });

  test('the attorney READ bypass does not send; read-only grant does not send; SU sends (no step-up here)', async () => {
    W.grant(RENA, 3, { can_read: true });
    expect((await internal('sms', { t: T.ss(), body: { from: '2485592400', to: '3135550001', message: 'hi' } })).status).toBe(403);
    expect((await internal('sms', { t: T.rena(), body: { from: '2489655355', to: '3135550001', message: 'hi' } })).status).toBe(403);
    expect((await internal('sms', { t: T.su(), body: { from: '2485592400', to: '3135550001', message: 'hi' } })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test('the seeded grant (Stuart → line 1) keeps the contact-tab path working', async () => {
    W.grant(SS, 1, { can_read: true, can_send: true });
    expect((await internal('sms', { t: T.ss(), body: { from: '2485592400', to: '3135550001', message: 'hi' } })).status).toBe(200);
    expect((await internal('mms', { t: T.ss(), body: { from: '2485592400', to: '3135550001', attachment_url: 'https://x.test/a.png' } })).status).toBe(200);
  });

  test('an unknown `from` is a 400 for staff (before any send)', async () => {
    const r = await internal('sms', { t: T.su(), body: { from: '2480009999', to: '3135550001', message: 'hi' } });
    expect(r.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test('API-key callers stay grant-blind (D6): no grant row, still sent; no grant query issued', async () => {
    const r = await internal('sms', { apiKey: process.env.INTERNAL_API_KEY, body: { from: '2485592400', to: '3135550001', message: 'auto' } });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(W.statements.some((s) => /channel_grants|phone_lines/.test(s.sql))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grants on phone lines', () => {
  const grants = (line, method, opts) => call(method, `/api/phone-lines/${line}/grants${opts && opts.gid ? `/${opts.gid}` : ''}`, opts);

  test('NO INERT GRANT: a written can_read grant is effective on the very next read; removing it closes it', async () => {
    SPH_SEED(W);
    expect((await call('GET', '/api/phone-lines/1/conversations', { t: T.nobody() })).status).toBe(404);
    const c = await grants(1, 'POST', { t: T.su(), elev: ELEV(), body: { user: NOBODY, can_read: true } });
    expect(c.status).toBe(201);
    expect(c.json.grant).toMatchObject({ user: NOBODY, channel_type: 'phone_line', channel_id: 1, can_read: true, can_send: false });
    expect((await call('GET', '/api/phone-lines/1/conversations', { t: T.nobody() })).status).toBe(200);
    expect(ids((await call('GET', '/api/phone-lines/readable', { t: T.nobody() })).json.lines)).toEqual([1]);
    expect((await call('POST', '/api/phone-lines/1/sms', { t: T.nobody(), body: { to: '3135550001', message: 'x' } })).status).toBe(403);
    const p = await grants(1, 'PATCH', { gid: c.json.grant.id, t: T.su(), elev: ELEV(), body: { can_send: true } });
    expect(p.status).toBe(200);
    expect((await call('POST', '/api/phone-lines/1/sms', { t: T.nobody(), body: { to: '3135550001', message: 'x' } })).status).toBe(200);
    const d = await grants(1, 'DELETE', { gid: c.json.grant.id, t: T.su(), elev: ELEV() });
    expect(d.status).toBe(200);
    expect((await call('GET', '/api/phone-lines/1/conversations', { t: T.nobody() })).status).toBe(404);
    expect(W.T.admin_audit_log.filter((a) => a.tool === 'phone_lines').map((a) => [a.status, a.details.action, a.details.line_id]))
      .toEqual([['success', 'grant_create', 1], ['success', 'grant_update', 1], ['success', 'grant_delete', 1]]);
  });

  test('SU writes need step-up; reads do not', async () => {
    expect((await grants(2, 'GET', { t: T.su() })).status).toBe(200);
    const r = await grants(2, 'POST', { t: T.su(), body: { user: NOBODY, can_read: true } });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('elevation_required');
    expect(W.T.channel_grants).toEqual([]);
  });

  test('a can_manage holder manages THAT line only; read-only 403; nobody 404; rows ownership-scoped', async () => {
    W.grant(RENA, 3, { can_read: true, can_manage: true });
    W.grant(SB, 2, { can_read: true });
    const other = W.grant(SB, 6, { can_read: true });
    let r = await grants(3, 'POST', { t: T.rena(), body: { user: NOBODY, can_read: true, can_send: true } });
    expect(r.status).toBe(201);
    expect(r.json.grant.granted_by).toBe(RENA);
    expect(W.T.admin_audit_log.pop()).toMatchObject({ tool: 'phone_lines', details: { via: 'manage', line_id: 3 } });
    expect((await grants(2, 'GET', { t: T.rena() })).status).toBe(404);
    expect((await grants(2, 'GET', { t: T.sb() })).status).toBe(403);
    // a grant on line 6 through line 3's URL → 404, untouched
    r = await grants(3, 'PATCH', { gid: other, t: T.rena(), body: { can_send: true } });
    expect(r.status).toBe(404);
    expect(r.json.message).toBe('Grant not found on this phone line');
    expect(W.T.channel_grants.find((g) => g.id === other).can_send).toBe(0);
  });

  test('the attorney reads every line but manages none without a grant (403; a missing line 404)', async () => {
    expect((await grants(2, 'GET', { t: T.ss() })).status).toBe(403);
    expect((await grants(99, 'GET', { t: T.ss() })).status).toBe(404);
  });

  test('the channel is pinned: a body naming another channel_type is a 400 and writes nothing', async () => {
    for (const ct of ['mailbox', 'fax']) {
      const r = await grants(3, 'POST', { t: T.su(), elev: ELEV(), body: { user: NOBODY, can_read: true, channel_type: ct } });
      expect(r.status).toBe(400);
    }
    expect(W.T.channel_grants).toEqual([]);
    expect((await grants(3, 'POST', { t: T.su(), elev: ELEV(), body: { user: NOBODY, can_read: true, channel_type: 'phone_line' } })).status).toBe(201);
  });

  test('line must exist (inactive counts); duplicate 409; user 0 refused; copy says "phone line"', async () => {
    let r = await grants(99, 'POST', { t: T.su(), elev: ELEV(), body: { user: NOBODY, can_read: true } });
    expect(r.status).toBe(404);
    expect(r.json.message).toBe('Phone line not found');
    expect((await grants(7, 'POST', { t: T.su(), elev: ELEV(), body: { user: NOBODY, can_read: true } })).status).toBe(201);
    r = await grants(7, 'POST', { t: T.su(), elev: ELEV(), body: { user: NOBODY, can_read: true } });
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/this phone line/);
    expect((await grants(7, 'POST', { t: T.su(), elev: ELEV(), body: { user: 0, can_read: true } })).status).toBe(400);
  });

  test('service: createGrant on a phone line checks phone_lines, not mailboxes', async () => {
    await expect(mbx.createGrant(W.db, { channelType: 'phone_line', channelId: 99, body: { user: NOBODY, can_read: true }, grantedBy: SU }))
      .rejects.toMatchObject({ status: 404, message: 'Phone line not found' });
    W.T.mailboxes.push({ id: 2 });
    await expect(mbx.createGrant(W.db, { channelType: 'mailbox', channelId: 2, body: { user: NOBODY, can_read: true }, grantedBy: SU }))
      .resolves.toBeTruthy();
    expect(W.statements.some((s) => s.sql === 'SELECT id FROM phone_lines WHERE id = ? LIMIT 1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('jwt_api_audit_log redaction (ruling 5)', () => {
  test('a credential in the Referer or the route query is redacted at write time; the rest is kept', async () => {
    const r = await call('GET', '/api/phone-lines/readable?token=abc123&x=1', {
      t: T.su(), headers: { Referer: 'https://app.4lsg.com/?user=Ssandweiss&pass=Hunter2&files=c1' },
    });
    expect(r.status).toBe(200);
    const row = W.T.jwt_api_audit_log.pop();
    expect(row.headers.referer).toBe('https://app.4lsg.com/?user=Ssandweiss&pass=[REDACTED]&files=c1');
    expect(row.route).toBe('/api/phone-lines/readable?token=[REDACTED]&x=1');
    expect(row.query).toEqual({ token: '[secret]', x: '[str 1]' });   // SEC-2 shapes
    expect(JSON.stringify(row)).not.toMatch(/Hunter2|abc123/);
  });

  // redactUrlParams itself is pinned in tests/refererRedaction.test.js (SEC-1).
});

// ─────────────────────────────────────────────────────────────────────────────
describe('service helpers', () => {
  test('normalizeTo: US 10 digits (formatted, +1, 1) only', () => {
    expect(phone.normalizeTo('+1 (313) 555-0001')).toEqual({ ten: '3135550001', e164: '+13135550001' });
    expect(phone.normalizeTo('13135550001').ten).toBe('3135550001');
    for (const bad of ['22395', '+442079460958', '313555000', 'abc', null, '3135550001x']) {
      expect(() => phone.normalizeTo(bad)).toThrow(/US phone number/);
    }
  });

  test('cursorOf / parseCursor round-trip', () => {
    const at = new Date('2026-10-01T12:00:00Z');
    expect(phone.parseCursor(phone.cursorOf({ processed_at: at, id: 42 }))).toEqual({ at, id: 42 });
    expect(() => phone.parseCursor('12.x')).toThrow(/malformed/);
  });
});
