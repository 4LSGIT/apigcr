/**
 * Mailbox S3-R — per-address reading: a can_read grant on an ALIAS box
 * (mailboxes.alias_of) reads the alias's SLICE of the parent box.
 * routes/api.mail.js → services/mailbox/mailReadService.js (ALIAS SLICE) +
 * services/mailboxService.js (alias create/patch rules) +
 * services/mailbox/mailboxSendService.js (loadParent / the read-state seed).
 * World: tests/helpers/mailboxS3World.js (the S2 world + S3 statements, now
 * parsing the alias branch, the scope disjunction and the per-slice
 * summary / mark-all / view-count statements). Engine twin:
 * tests/mailboxS3R.mysql.test.js (gated on YC_TEST_MYSQL_URL).
 *
 * What this pins (each mutation-checked — break it, watch a test fail):
 *   - the visibility matrix: an alias reader sees mail ADDRESSED to the alias
 *     (From/To/Cc, pinned — a superstring address never matches) and mail the
 *     Gmail filter LABELLED for it (the Bcc / list-mail catch: a row whose
 *     To/Cc never name the alias), and NOTHING else of the parent box; the
 *     parent's own readers and the SU see exactly what they saw before.
 *   - slice rows present AS the alias box (mailbox_id / mailbox_address /
 *     colour re-tag) in the list AND the thread view; within the slice the
 *     alias's OWN mail (From = the alias) = Sent and everything else = Inbox
 *     — a \Sent-labelled automations@ → it@ digest is it@'s INCOMING mail
 *     (review 2026-10-12); in_inbox never applies (the live rows are
 *     archived).
 *   - the summary row for an alias box carries the slice's Inbox counts —
 *     what the shell's sidebar badge sums (the "badge never counts" fix).
 *   - read state and mark-all stay grant-scoped THROUGH the slice: {ids}
 *     marks only slice rows; {all} on the alias marks the slice's list and
 *     nothing else of the parent.
 *   - send-only IS alias_of (mailReadService.SEND_ONLY_SQL): a non-alias box
 *     with ingest off and no secret is NOT send-only any more (the flip; see
 *     also tests/mailboxS3.send.test.js), and grants on alias boxes are
 *     ACCEPTED — capability and validation shipped together, no guard, no
 *     inert-grant window (ruling 2026-10-12).
 *   - alias create copies host/login from the parent, forces ingest off, and
 *     refuses connection / ingest / emit fields and alias-of-alias; PATCH
 *     refuses them, and re-points alias_of only SU-side, re-copying the
 *     connection (tests/mailboxS0.test.js S3-R describe).
 *   - replyDefaults / caseLink-style access (loadVisible / loadParent) admit
 *     a slice row; the sent-copy read-state seed probes the alias's PARENT
 *     and marks the copy through the slice.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s3r-test-secret';
process.env.EMAIL_DOMAINS = 'firm.test';
process.env.FIRM_TZ = 'America/Detroit';

const express = require('express');
const jwt = require('jsonwebtoken');
const { makeWorld } = require('./helpers/mailboxS3World');
const read = require('../services/mailbox/mailReadService');
const sendSvc = require('../services/mailbox/mailboxSendService');
const mailRouter = require('../routes/api.mail');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(mailRouter);

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user, user_auth = 'authorized', roles = []) =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, roles, aud: 'staff' }, process.env.JWT_SECRET);

async function call(method, url, { t, body } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json };
}

// Users: 1 = SS (attorney), 5 = reader of PARENT box 2, 6 = SU, 9 = nobody,
// 12 = reader+sender of the it@ ALIAS only, 13 = reader of BOTH aliases.
const SS = 1; const PREADER = 5; const SU = 6; const NOBODY = 9; const AREADER = 12; const BOTH = 13; const DUAL = 14;
const IT = 7; const RENA = 8; // alias boxes of parent 2

function seed() {
  W = makeWorld();
  W.user(SS, { roles: 'staff,attorney' });
  W.user(PREADER, { roles: 'staff' });
  W.user(SU, { auth: 'authorized', roles: 'it,admin,form_dev,su' });
  W.user(NOBODY, { roles: 'staff' });
  W.user(AREADER, { roles: 'staff' });
  W.user(BOTH, { roles: 'staff' });
  W.user(DUAL, { roles: 'staff' });
  W.cred(2, { email: 'stuart@firm.test', from_name: 'Stuart S', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '' });
  W.cred(6, { email: 'it@firm.test', from_name: 'Firm IT', provider: 'gmail', credential_id: 11, smtp_host: '', smtp_user: '' });
  W.mailbox(1, { address: 'billing@firm.test', imap_host: 'imap.firm.test', imap_user: 'billing@firm.test', imap_secret: 'ENCv1:x' });
  W.mailbox(2, { address: 'stuart@firm.test', send_credential_id: 2, imap_host: 'imap.gmail.com', imap_user: 'stuart@firm.test',
    imap_secret: 'ENCv1:g', ingest_folders: JSON.stringify({ '[Gmail]/All Mail': { emit_to_rules: true } }) });
  W.mailbox(IT, { address: 'it@firm.test', display_name: 'IT', send_credential_id: 6, ingest_enabled: 0, imap_secret: null,
    imap_host: 'imap.gmail.com', imap_user: 'stuart@firm.test', alias_of: 2, alias_label: 'IT', color: '#2f6fd1' });
  W.mailbox(RENA, { address: 'rena@firm.test', ingest_enabled: 0, imap_secret: null,
    imap_host: 'imap.gmail.com', imap_user: 'stuart@firm.test', alias_of: 2, alias_label: 'Rena' });
  W.grant(PREADER, 2, { read: 1 });
  W.grant(AREADER, IT, { read: 1, send: 1 });
  W.grant(BOTH, IT, { read: 1 });
  W.grant(BOTH, RENA, { read: 1 });
  W.grant(DUAL, 2, { read: 1 });
  W.grant(DUAL, IT, { read: 1 });

  const g = (id, over) => W.message(id, { mailbox_id: 2, folder: '[Gmail]/All Mail', ...over });
  // ── the slice matrix (parent box 2) ──
  g(301, { to_addrs: 'it@firm.test', gmail_labels: '["IT"]', from_addr: 'Client <client@outside.test>',
    message_id: 'x301@o.test', thread_key: 'troot@o.test', subject: 'Printer down' });
  g(302, { to_addrs: 'stuart@firm.test', gmail_labels: '["Trigger Label", "IT"]', from_addr: 'List <list@vendor.test>',
    message_id: 'x302@o.test', thread_key: 'x302@o.test', subject: 'Bcc-style: label only' });
  g(303, { to_addrs: 'it@firm.test', gmail_labels: null, folder: '[Gmail]/Sent Mail', from_addr: 'Automations <automations@firm.test>',
    message_id: 'x303@o.test', thread_key: 'x303@o.test', subject: 'Internal, no snapshot' });
  // the live digest shape (ids 101/103/108): another send-as address of the
  // account → it@, so Gmail files it \Sent + the filter's label
  g(308, { to_addrs: 'it@firm.test', gmail_labels: '["\\\\Sent", "IT"]', from_addr: 'Automations <automations@firm.test>',
    message_id: 'x308@mail.gmail.com', thread_key: 'x308@mail.gmail.com', subject: 'Your Task Summary' });
  g(304, { to_addrs: 'stuart@firm.test', gmail_labels: '["\\\\Inbox"]', from_addr: 'Client <client@outside.test>',
    message_id: 'x304@o.test', thread_key: 'troot@o.test', subject: 'Re: Printer down — but not it@\'s' });
  g(305, { to_addrs: 'client@outside.test', gmail_labels: '["\\\\Sent", "IT"]', from_addr: 'Firm IT <it@firm.test>',
    message_id: 'x305@mail.gmail.com', thread_key: 'troot@o.test', subject: 'Re: Printer down' });
  g(306, { to_addrs: 'it@firm.test', gmail_labels: '["Rena"]', from_addr: 'HR <hr@outside.test>',
    message_id: 'x306@o.test', thread_key: 'x306@o.test', subject: 'Both slices' });
  g(307, { to_addrs: 'mit@firm.test', gmail_labels: '["\\\\Inbox"]', from_addr: 'x@outside.test',
    message_id: 'x307@o.test', thread_key: 'x307@o.test', subject: 'Superstring address — not it@' });
  W.message(310, { mailbox_id: 1, message_id: 'x310@o.test', thread_key: 'x310@o.test', subject: 'Box 1 mail' });
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed();
});
afterEach(() => jest.restoreAllMocks());

const ids = (r) => r.json.messages.map((m) => m.id).sort((a, b) => a - b);

// ─────────────────────────────────────────────────────────────────────────────
describe('the visibility matrix — list / scopes', () => {
  test('alias reader: Inbox = addressed + labelled (Bcc catch) + internal mail TO the alias (\\Sent copies included); Sent = the alias\'s own mail; never the rest of the parent', async () => {
    const inbox = await call('GET', '/api/mail/messages', { t: tok(AREADER) });
    expect(inbox.status).toBe(200);
    expect(ids(inbox)).toEqual([301, 302, 303, 306, 308]);
    for (const m of inbox.json.messages) {
      expect([m.mailbox_id, m.mailbox_address, m.in_inbox, m.sent, m.place]).toEqual([IT, 'it@firm.test', true, false, null]);
    }
    // Sent WITHIN a slice = From is the alias: 305 only. Neither the label-less
    // Sent-folder copy (303) nor the \Sent-labelled digest (308) — both are
    // automations@ → it@, incoming to it@ — and nothing shows in both scopes.
    const sent = await call('GET', '/api/mail/messages?sent_only=1', { t: tok(AREADER) });
    expect(ids(sent)).toEqual([305]);
    expect(sent.json.messages[0]).toMatchObject({ mailbox_id: IT, in_inbox: false, sent: true, place: 'Sent' });
    const all = await call('GET', '/api/mail/messages?all_folders=1', { t: tok(AREADER) });
    expect(ids(all)).toEqual([301, 302, 303, 305, 306, 308]);
    expect(all.json.scope_ids).toEqual([IT]);
    // the parent's reader still sees 308 as the account's Sent copy (S3 rule, unchanged)
    const p = await call('GET', '/api/mail/messages?sent_only=1&limit=100', { t: tok(PREADER) });
    expect(p.json.messages.find((m) => m.id === 308)).toMatchObject({ mailbox_id: 2, sent: true, place: 'Sent' });
  });

  test('the parent\'s reader and the SU are unaffected: the parent branch, each row once, tagged with the parent', async () => {
    const p = await call('GET', '/api/mail/messages?all_folders=1&limit=100', { t: tok(PREADER) });
    expect(ids(p)).toEqual([301, 302, 303, 304, 305, 306, 307, 308]);
    expect(new Set(p.json.messages.map((m) => m.mailbox_id))).toEqual(new Set([2]));
    // SU default scope holds the parent AND its aliases: the alias branches
    // are DROPPED (no duplicate rows), the parent branch carries everything.
    const su = await call('GET', '/api/mail/messages?all_folders=1&limit=100', { t: tok(SU, 'authorized', ['su']) });
    const got = su.json.messages.map((m) => m.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.sort((a, b) => a - b)).toEqual([301, 302, 303, 304, 305, 306, 307, 308, 310]);
    // …but scoped TO the alias, the SU reads the slice as the alias box.
    const sliced = await call('GET', `/api/mail/messages?mailbox_ids=${IT}`, { t: tok(SU, 'authorized', ['su']) });
    expect(ids(sliced)).toEqual([301, 302, 303, 306, 308]);
    expect(new Set(sliced.json.messages.map((m) => m.mailbox_id))).toEqual(new Set([IT]));
    // a reader of the parent AND one alias: the alias branch is DROPPED
    // (branchPlan) — each row once, under the parent — in the list AND the
    // thread (collapse would otherwise show a row as a copy of itself).
    const dual = await call('GET', '/api/mail/messages?all_folders=1&limit=100', { t: tok(DUAL) });
    const dgot = dual.json.messages.map((m) => m.id);
    expect(new Set(dgot).size).toBe(dgot.length);
    expect(dgot.sort((a, b) => a - b)).toEqual([301, 302, 303, 304, 305, 306, 307, 308]);
    expect(new Set(dual.json.messages.map((m) => m.mailbox_id))).toEqual(new Set([2]));
    const dthread = await call('GET', `/api/mail/threads/${encodeURIComponent('troot@o.test')}`, { t: tok(DUAL) });
    expect(dthread.json.messages.map((m) => [m.id, m.copies.length])).toEqual([[301, 1], [304, 1], [305, 1]]);
  });

  test('two slices of one parent: overlap listed once; a reader of both sees the union, each row under one alias', async () => {
    const r = await call('GET', '/api/mail/messages?all_folders=1&limit=100', { t: tok(BOTH) });
    const got = r.json.messages.map((m) => m.id);
    expect(new Set(got).size).toBe(got.length);               // 306 (both slices) once
    expect(got.sort((a, b) => a - b)).toEqual([301, 302, 303, 305, 306, 308]);
    const byId = new Map(r.json.messages.map((m) => [m.id, m.mailbox_id]));
    expect(byId.get(306)).toBe(IT);                           // the lowest alias id that admits it wins the tag
  });

  test('the overlap tag does not depend on the UNION\'s tie order: the lowest admitting alias wins even when the other copy comes first', async () => {
    // MySQL leaves the order of two copies of one row (same date, same id)
    // undefined; hand the service the LATER branch's copy first.
    const flipped = {
      query: async (sql, p) => {
        const out = await W.db.query(sql, p);
        if (!/UNION ALL/.test(sql)) return out;
        const t = (r) => new Date(r.date).getTime();
        const rows = [...out[0]].reverse().sort((a, b) => (t(b) - t(a)) || (b.id - a.id)); // stable: ties stay reversed
        return [rows, out[1]];
      },
    };
    const r = await read.listMessages(flipped, BOTH, { all_folders: '1', limit: 100 });
    expect(r.messages.find((m) => m.id === 306)).toMatchObject({ mailbox_id: IT, mailbox_address: 'it@firm.test' });
    expect(r.messages.filter((m) => m.id === 306)).toHaveLength(1);
  });

  test('filters compose with the slice (unread_only, q)', async () => {
    W.read(AREADER, 301);
    const r = await call('GET', '/api/mail/messages?unread_only=1', { t: tok(AREADER) });
    expect(ids(r)).toEqual([302, 303, 306, 308]);
    const q = await call('GET', '/api/mail/messages?q=Bcc-style', { t: tok(AREADER) });
    expect(ids(q)).toEqual([302]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('thread / single message through the slice', () => {
  test('the thread view merges only the slice: a non-slice reply in the same thread stays invisible; rows re-tagged', async () => {
    const r = await call('GET', `/api/mail/threads/${encodeURIComponent('troot@o.test')}`, { t: tok(AREADER) });
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m) => m.id)).toEqual([301, 305]);           // 304 (stuart@'s reply) is not it@'s
    expect(new Set(r.json.messages.map((m) => m.mailbox_id))).toEqual(new Set([IT]));
    expect(r.json.messages.find((m) => m.id === 305)).toMatchObject({ sent: true, place: 'Sent', in_inbox: false });
    // the parent's reader sees the whole thread, as before, under the parent
    const p = await call('GET', `/api/mail/threads/${encodeURIComponent('troot@o.test')}`, { t: tok(PREADER) });
    expect(p.json.messages.map((m) => m.id)).toEqual([301, 304, 305]);
    expect(new Set(p.json.messages.map((m) => m.mailbox_id))).toEqual(new Set([2]));
  });

  test('getMessage: a slice row opens (re-tagged); a non-slice parent row and a foreign box answer 404 alike', async () => {
    const ok = await call('GET', '/api/mail/messages/302', { t: tok(AREADER) });
    expect(ok.status).toBe(200);
    expect(ok.json.messages[0]).toMatchObject({ id: 302, mailbox_id: IT, mailbox_address: 'it@firm.test' });
    expect((await call('GET', '/api/mail/messages/304', { t: tok(AREADER) })).status).toBe(404);
    expect((await call('GET', '/api/mail/messages/307', { t: tok(AREADER) })).status).toBe(404);
    expect((await call('GET', '/api/mail/messages/310', { t: tok(AREADER) })).status).toBe(404);
    expect((await call('GET', '/api/mail/messages/301', { t: tok(NOBODY) })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('read state through the slice (grant-scoped)', () => {
  test('setRead on a slice row works; on a non-slice row 404', async () => {
    expect((await call('POST', '/api/mail/messages/302/read', { t: tok(AREADER) })).status).toBe(200);
    expect(W.readSet(AREADER)).toEqual([302]);
    expect((await call('POST', '/api/mail/messages/304/read', { t: tok(AREADER) })).status).toBe(404);
  });

  test('bulk {ids}: only the slice\'s ids mark', async () => {
    const r = await call('POST', '/api/mail/read', { t: tok(AREADER), body: { ids: [301, 304, 310] } });
    expect(r.json).toMatchObject({ marked: 1 });
    expect(W.readSet(AREADER)).toEqual([301]);
  });

  test('mark-all on the alias clears the slice\'s Inbox — and ONLY it; filters ride along', async () => {
    const r = await call('POST', '/api/mail/read', { t: tok(AREADER), body: { all: true, mailbox_ids: [IT] } });
    expect(r.json).toMatchObject({ marked: 5 });                        // 301 302 303 306 308 — never 304/305/307
    expect(W.readSet(AREADER)).toEqual([301, 302, 303, 306, 308]);
    // all_folders adds the Sent copy
    const r2 = await call('POST', '/api/mail/read', { t: tok(AREADER), body: { all: true, filters: { all_folders: true } } });
    expect(r2.json).toMatchObject({ marked: 1 });
    expect(W.readSet(AREADER)).toEqual([301, 302, 303, 305, 306, 308]);
  });

  test('a reader of BOTH slices marking all counts the overlap once', async () => {
    const r = await call('POST', '/api/mail/read', { t: tok(BOTH), body: { all: true } });
    expect(r.json).toMatchObject({ marked: 5 });                        // 301 302 303 306 308 (306 once)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('summary / badge counts + views', () => {
  test('the alias box is ON the reading surfaces with its slice\'s Inbox counts (what the sidebar badge sums)', async () => {
    let s = await call('GET', '/api/mail/mailboxes', { t: tok(AREADER) });
    expect(s.json.mailboxes).toEqual([expect.objectContaining({
      id: IT, address: 'it@firm.test', alias_of: 2, can_send: true, inbox_total: 5, inbox_unread: 5,
    })]);
    W.read(AREADER, 301);
    s = await call('GET', '/api/mail/mailboxes', { t: tok(AREADER) });
    expect(s.json.mailboxes[0]).toMatchObject({ inbox_total: 5, inbox_unread: 4 });
    // SU: the parent keeps its own in_inbox count (304 + 307), the aliases their slices
    const su = (await call('GET', '/api/mail/mailboxes', { t: tok(SU, 'authorized', ['su']) })).json.mailboxes;
    expect(su.find((m) => m.id === 2)).toMatchObject({ alias_of: null, inbox_total: 2 });
    expect(su.find((m) => m.id === IT)).toMatchObject({ alias_of: 2, inbox_total: 5 });
    expect(su.find((m) => m.id === RENA)).toMatchObject({ alias_of: 2, inbox_total: 1 });   // 306
  });

  test('a saved view over the alias counts the slice\'s unread', async () => {
    const v = (await call('POST', '/api/mail/views', { t: tok(AREADER), body: { name: 'IT', mailbox_ids: [IT] } })).json.view;
    W.read(AREADER, 302);
    const c = await call('GET', '/api/mail/views/counts', { t: tok(AREADER) });
    expect(c.json.counts[v.id]).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('send interplay (S3.2 premises)', () => {
  test('replyDefaults reads the parent row through the slice: the alias reader replies, as the alias, to the sender', async () => {
    const r = await call('GET', '/api/mail/messages/302/reply', { t: tok(AREADER) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ mailbox_id: IT, to: [{ email: 'list@vendor.test', name: 'List' }] });
    expect((await call('GET', '/api/mail/messages/304/reply', { t: tok(AREADER) })).status).toBe(404);
  });

  test('the sent-copy read-state seed probes the alias\'s PARENT and marks the copy through the slice', async () => {
    // the copy of a send AS it@ arrives in box 2 with the Gmail id
    W.message(320, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Sent", "IT"]', provider_id: 'feedc0de',
      message_id: 'x320@mail.gmail.com', thread_key: 'x320@mail.gmail.com', subject: 'Re: ticket',
      from_addr: 'Firm IT <it@firm.test>', to_addrs: 'client@outside.test', date: new Date() });
    const r = await sendSvc.seedSentReadState(W.db, {
      user: AREADER, mailbox_id: IT, sent_at: new Date().toISOString(), provider_id: 'feedc0de', message_id: null,
    });
    expect(r).toEqual({ seeded: 1, found: 1 });
    expect(W.readSet(AREADER)).toEqual([320]);
    // a copy OUTSIDE the slice (another alias's send) is found but not markable → done, 0 seeded
    W.message(321, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Sent", "Shoshana"]', provider_id: '0ddba11',
      message_id: 'x321@mail.gmail.com', thread_key: 'x321@mail.gmail.com', subject: 's',
      from_addr: 'shoshana@firm.test', to_addrs: 'client@outside.test', date: new Date() });
    const r2 = await sendSvc.seedSentReadState(W.db, {
      user: AREADER, mailbox_id: IT, sent_at: new Date().toISOString(), provider_id: '0ddba11', message_id: null,
    });
    expect(r2).toEqual({ seeded: 0, found: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grant writes and the alias create/PATCH rules run over the S0 harness (its
// generic SQL evaluator models the mailbox/grant writes) — see the S3-R
// describe in tests/mailboxS0.test.js. Here: the flip itself.
describe('send-only = alias_of', () => {
  test('sendOnlyIds: the alias boxes and nothing else — a box that merely has ingest off and no secret is NOT send-only (the S3.1 inference is dead)', async () => {
    W.mailbox(9, { address: 'paused@firm.test', ingest_enabled: 0, imap_secret: null, imap_host: 'h.test', imap_user: 'u' });
    expect([...await read.sendOnlyIds(W.db, [1, 2, IT, RENA, 9])].sort((a, b) => a - b)).toEqual([IT, RENA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('slice mechanics (pure)', () => {
  const entry = { id: IT, address: 'it@firm.test', alias_of: 2, alias_label: 'IT' };

  test('sliceMatchJs: the label exact and case-sensitive; a NULL label falls back to the pinned address; placeInSlice partitions on the From', () => {
    expect(read.sliceMatchJs(entry, { from_addr: 'a@b.test', to_addrs: 'x@y.test', cc_addrs: null, gmail_labels: ['IT'] })).toBe(true);
    expect(read.sliceMatchJs(entry, { from_addr: 'a@b.test', to_addrs: 'x@y.test', cc_addrs: null, gmail_labels: ['it'] })).toBe(false);
    expect(read.sliceMatchJs(entry, { from_addr: 'a@b.test', to_addrs: 'mit@firm.test', cc_addrs: null, gmail_labels: [] })).toBe(false);
    expect(read.sliceMatchJs({ ...entry, alias_label: null }, { from_addr: 'a@b.test', to_addrs: 'Z <it@firm.test>', cc_addrs: null, gmail_labels: null })).toBe(true);
    expect(read.placeInSlice(entry, { from_addr: 'Firm IT <it@firm.test>', gmail_labels: ['IT'] })).toEqual({ in_inbox: false, sent: true, place: 'Sent' });
    expect(read.placeInSlice(entry, { from_addr: 'Automations <automations@firm.test>', gmail_labels: ['\\Sent', 'IT'] }))
      .toEqual({ in_inbox: true, sent: false, place: null });                    // incoming TO it@, \Sent or not
    expect(read.placeInSlice(entry, { from_addr: '"it@firm.test" <evil@o.test>', gmail_labels: null }))
      .toEqual({ in_inbox: true, sent: false, place: null });                    // the address quoted in a NAME is not the From
    expect(read.placeInSlice(entry, { from_addr: null, gmail_labels: null })).toEqual({ in_inbox: true, sent: false, place: null });
  });

  test('branchPlan drops an alias whose parent is in scope; scopeDisjunction without aliases is the pre-S3-R text, byte for byte', () => {
    const scope = new Map([
      [2, { id: 2, address: 'stuart@firm.test', alias_of: null }],
      [IT, entry],
    ]);
    expect(read.branchPlan(scope, [2, IT])).toEqual({ direct: [2], aliases: [] });
    expect(read.branchPlan(scope, [IT])).toEqual({ direct: [], aliases: [entry] });
    expect(read.scopeDisjunction({ direct: [1, 2], aliases: [] })).toEqual({ sql: 'm.mailbox_id IN (?)', params: [[1, 2]] });
    const d = read.scopeDisjunction({ direct: [], aliases: [entry] });
    expect(d.sql).toMatch(/^\(\(m\.mailbox_id = \? AND /);
    expect(d.params[0]).toBe(2);
    expect(d.params[1]).toBe('IT');
  });
});
