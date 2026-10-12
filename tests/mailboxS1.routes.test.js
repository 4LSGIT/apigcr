// tests/mailboxS1.routes.test.js
//
/**
 * Mailbox system S1 — the two HTTP surfaces:
 *   GET /api/mailboxes/:id/messages/:mid/parts/:part   (routes/api.mailboxes.js)
 *   ALL /mailbox-ingest                                 (routes/mailboxIngest.js)
 * Run: npx jest tests/mailboxS1.routes.test.js
 *
 * The REAL routers, lib/auth.jwtOrApiKey and mailboxService grant resolution
 * run over an express app on an ephemeral port, against the stateful fake DB
 * in tests/helpers/mailboxS1World.js. Mocked: imapTransport.fetchPart (IMAP)
 * and runIngest (its own suite covers it).
 *
 * Mutation-checked:
 *   - staff throttle removed / applied to the x-api-key tick  → "staff-triggered runs" (S3 follow-up)
 *   - details returned to a non-SU staff caller               → "staff-triggered runs" (S3 follow-up)
 *   - inline allowlist widened to text/html  → "sender-declared HTML is never served inline"
 *   - grant check removed                    → "no grant → 404; grant without read → 403"
 *   - cursor/identity args not passed        → "passes the cursor UIDVALIDITY and the stored Message-ID"
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s1-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s1_internal';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../services/mailbox/mailboxIngestService', () => {
  const actual = jest.requireActual('../services/mailbox/mailboxIngestService');
  return { ...actual, runIngest: jest.fn() };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const { Readable } = require('stream');
const transport = require('../services/mailbox/imapTransport');
const ingest = require('../services/mailbox/mailboxIngestService');
const { makeWorld } = require('./helpers/mailboxS1World');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(require('../routes/api.mailboxes'));
const ingestRouter = require('../routes/mailboxIngest');
app.use(ingestRouter);

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user, user_auth = 'authorized') =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);

async function call(method, url, { t, apiKey } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetch(base + url, { method, headers });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* bytes */ }
  return { status: r.status, headers: r.headers, body: buf, json };
}

let MB; let MSG;
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  W = makeWorld();
  MB = W.addMailbox({ ingest_state: { INBOX: { uidvalidity: 4242, last_uid: 9 } } });
  W.T.mail_messages.push({
    id: 31, mailbox_id: MB, folder: 'INBOX', uid: 9, message_id: 'm9@x', log_id: null,
    attachments: JSON.stringify([
      { part: '2', filename: 'Pétition 1.pdf', size: 900, mime: 'application/pdf' },
      { part: '3', filename: 'evil.html', size: 50, mime: 'text/html' },
      { part: '4', filename: null, size: 20, mime: 'image/svg+xml' },
    ]),
  });
  W.T.channel_grants.push(
    { user: 1, channel_type: 'mailbox', channel_id: MB, can_read: 1, can_send: 0, can_manage: 0 },
    { user: 5, channel_type: 'mailbox', channel_id: MB, can_read: 0, can_send: 1, can_manage: 0 },
  );
  transport.fetchPart.mockReset().mockImplementation(async () => ({
    stream: Readable.from([Buffer.from('%PDF-bytes')]), mime: 'application/pdf', filename: 'x', close: jest.fn(),
  }));
  ingest.runIngest.mockReset();
  ingestRouter._resetStaffThrottle();
});
afterEach(() => jest.restoreAllMocks());

const partUrl = (mb = MB, mid = 31, part = '2') => `/api/mailboxes/${mb}/messages/${mid}/parts/${part}`;

describe('GET …/messages/:mid/parts/:part', () => {
  test('a reader gets the bytes: inline PDF, nosniff, private cache, RFC 5987 filename', async () => {
    const r = await call('GET', partUrl(), { t: tok(1) });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('%PDF-bytes');
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, max-age=300');
    expect(r.headers.get('content-disposition')).toBe(
      `inline; filename="P_tition 1.pdf"; filename*=UTF-8''${encodeURIComponent('Pétition 1.pdf')}`);
  });

  test('passes the cursor UIDVALIDITY and the stored Message-ID (the identity guard)', async () => {
    await call('GET', partUrl(), { t: tok(1) });
    const [conn, folder, uid, part, opts] = transport.fetchPart.mock.calls[0];
    expect(conn).toMatchObject({ id: MB, imap_host: 'imap.example.test' });
    expect([folder, uid, part]).toEqual(['INBOX', 9, '2']);
    expect(opts).toEqual({ uidValidity: 4242, messageId: 'm9@x' });
  });

  test('sender-declared HTML / SVG is never served inline', async () => {
    for (const part of ['3', '4']) {
      const r = await call('GET', partUrl(MB, 31, part), { t: tok(1) });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition')).toMatch(/^attachment; /);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const r = await call('GET', partUrl(MB, 31, '4'), { t: tok(1) });
    expect(r.headers.get('content-disposition')).toContain('filename="attachment-4"');
  });

  test('no grant → 404; grant without read → 403; SU needs no grant', async () => {
    expect((await call('GET', partUrl(), { t: tok(9) })).status).toBe(404);
    expect((await call('GET', partUrl(), { t: tok(5) })).status).toBe(403);
    expect((await call('GET', partUrl(), { t: tok(6, 'authorized - SU') })).status).toBe(200);
    expect(transport.fetchPart).toHaveBeenCalledTimes(1);
  });

  test('humans only: an x-api-key caller is refused', async () => {
    const r = await call('GET', partUrl(), { apiKey: process.env.INTERNAL_API_KEY });
    expect(r.status).toBe(403);
    expect(transport.fetchPart).not.toHaveBeenCalled();
  });

  test('message of another mailbox, unknown part, malformed ids → 404/404/400, IMAP untouched', async () => {
    const other = W.addMailbox();
    W.T.channel_grants.push({ user: 1, channel_type: 'mailbox', channel_id: other, can_read: 1, can_send: 0, can_manage: 0 });
    expect((await call('GET', partUrl(other, 31, '2'), { t: tok(1) })).status).toBe(404);
    expect((await call('GET', partUrl(MB, 31, '7'), { t: tok(1) })).status).toBe(404);
    expect((await call('GET', partUrl(MB, 31, '2;x'), { t: tok(1) })).status).toBe(400);
    expect((await call('GET', partUrl(MB, 'abc', '2'), { t: tok(1) })).status).toBe(400);
    expect(transport.fetchPart).not.toHaveBeenCalled();
  });

  test('re-sync pending → 409 (stale cursor, missing cursor, or a different message at the UID)', async () => {
    transport.fetchPart.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UIDVALIDITY_MISMATCH' }));
    expect((await call('GET', partUrl(), { t: tok(1) })).status).toBe(409);
    transport.fetchPart.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'MESSAGE_MISMATCH' }));
    expect((await call('GET', partUrl(), { t: tok(1) })).status).toBe(409);
    W.T.mailboxes.find(b => b.id === MB).ingest_state = JSON.stringify({});
    const calls = transport.fetchPart.mock.calls.length;
    expect((await call('GET', partUrl(), { t: tok(1) })).status).toBe(409);
    expect(transport.fetchPart.mock.calls.length).toBe(calls);
  });

  test('message gone from the server → 404; IMAP failure → 502 with the sanitized code only', async () => {
    transport.fetchPart.mockResolvedValueOnce(null);
    const gone = await call('GET', partUrl(), { t: tok(1) });
    expect(gone.status).toBe(404);
    expect(gone.json.message).toMatch(/no longer on the mail server/);
    transport.fetchPart.mockRejectedValueOnce(Object.assign(new Error('IMAP AUTHENTICATIONFAILED: [REDACTED]'), { code: 'AUTHENTICATIONFAILED', sanitized: true }));
    const bad = await call('GET', partUrl(), { t: tok(1) });
    expect(bad.status).toBe(502);
    expect(bad.json).toEqual({ status: 'error', message: 'Could not reach the mail server for this attachment', code: 'AUTHENTICATIONFAILED' });
  });
});

describe('ALL /mailbox-ingest', () => {
  test('requires auth; the internal key or a staff JWT runs it; GET works too', async () => {
    ingest.runIngest.mockResolvedValue({ skipped: false, stored: 2 });
    expect((await call('POST', '/mailbox-ingest')).status).toBe(401);
    const a = await call('POST', '/mailbox-ingest', { apiKey: process.env.INTERNAL_API_KEY });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ skipped: false, stored: 2 });
    expect((await call('GET', '/mailbox-ingest', { t: tok(1) })).status).toBe(200);
    expect(ingest.runIngest).toHaveBeenCalledTimes(2);
    expect(ingest.runIngest.mock.calls[0][0]).toBe(W.db);
  });

  test('lock overlap is a 200 {skipped:true}; a run that cannot start is a 500', async () => {
    ingest.runIngest.mockResolvedValueOnce({ skipped: true, reason: 'another ingest run holds the lock' });
    const s = await call('POST', '/mailbox-ingest', { apiKey: process.env.INTERNAL_API_KEY });
    expect(s.status).toBe(200);
    expect(s.json.skipped).toBe(true);
    ingest.runIngest.mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const f = await call('POST', '/mailbox-ingest', { apiKey: process.env.INTERNAL_API_KEY });
    expect(f.status).toBe(500);
    expect(f.json).toMatchObject({ error: 'Mailbox ingest run failed', code: 'ETIMEDOUT' });
  });

  test('staff-triggered runs (the comms hub Refresh): one per window for all staff; the x-api-key tick never throttled; counts only unless SU', async () => {
    const full = { skipped: false, stored: 2, emitted: 1, errors: 0, durationMs: 9, details: [{ mailbox_id: 7, folder: 'INBOX.Secret', error: 'x' }], emitSources: { 'gmail-firm': 'ok' }, pipeline: { a: 1 } };
    ingest.runIngest.mockResolvedValue(full);
    const first = await call('POST', '/mailbox-ingest', { t: tok(1) });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ skipped: false, stored: 2, emitted: 1, errors: 0, durationMs: 9 }); // no details for a non-SU
    const again = await call('POST', '/mailbox-ingest', { t: tok(5) });                            // another person, same window
    expect(again.json).toMatchObject({ skipped: true, throttled: true });
    expect(ingest.runIngest).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', '/mailbox-ingest', { apiKey: process.env.INTERNAL_API_KEY })).json).toEqual(full); // the tick: always runs, full summary
    }
    expect(ingest.runIngest).toHaveBeenCalledTimes(4);
    ingestRouter._resetStaffThrottle();
    expect((await call('POST', '/mailbox-ingest', { t: tok(6, 'authorized - SU') })).json).toEqual(full);            // an SU sees the details
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3-R — the part fetch through an ALIAS box: :id is the alias (the hub's
// re-tagged mailbox_id), can_read is the alias grant, the message row and the
// IMAP connection are the PARENT's, and a parent row outside the slice is a
// 404 like any other unreadable message.
//
// Mutation-checked: the slice test dropped in the route (sliceMatchJs call)
// → "a parent row OUTSIDE the slice"; the connection loaded from the alias
// instead of the parent → "streams through the PARENT's connection" (the
// alias row has no secret, loadConnectionRow would come back secret-less and
// the route would 404/502 instead of streaming).
// ─────────────────────────────────────────────────────────────────────────────
describe('GET …/parts/:part through an alias box (S3-R)', () => {
  let ALIAS;
  beforeEach(() => {
    ALIAS = W.addMailbox({
      address: 'it@example.test', alias_of: MB, alias_label: 'IT',
      ingest_enabled: 0, imap_secret: null, imap_host: 'imap.example.test', imap_user: `box${MB}@example.test`,
    });
    // 31 (seeded above) is To stuart — give it the label so it falls in the slice
    Object.assign(W.T.mail_messages.find((m) => m.id === 31), { gmail_labels: '["IT"]', to_addrs: 'someone@x.test' });
    W.T.mail_messages.push({
      id: 32, mailbox_id: MB, folder: 'INBOX', uid: 8, message_id: 'm8@x', log_id: null, gmail_labels: '["\\\\Inbox"]',
      to_addrs: 'other@x.test', attachments: JSON.stringify([{ part: '2', filename: 'x.pdf', size: 1, mime: 'application/pdf' }]),
    });
    W.T.channel_grants.push({ user: 7, channel_type: 'mailbox', channel_id: ALIAS, can_read: 1, can_send: 0, can_manage: 0 });
  });

  test('an alias reader streams a slice row\'s bytes through the PARENT\'s connection', async () => {
    const r = await call('GET', partUrl(ALIAS, 31, '2'), { t: tok(7) });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('%PDF-bytes');
    const [conn] = transport.fetchPart.mock.calls[0];
    expect([conn.id, !!conn.imap_secret]).toEqual([MB, true]);       // the parent row, secret and cursor included
  });

  test('a parent row OUTSIDE the slice is a 404 through the alias URL; the parent-id URL stays closed to an alias-only reader', async () => {
    expect((await call('GET', partUrl(ALIAS, 32, '2'), { t: tok(7) })).status).toBe(404);
    expect((await call('GET', partUrl(MB, 31, '2'), { t: tok(7) })).status).toBe(404);
    expect(transport.fetchPart).not.toHaveBeenCalled();
    // the SU reads through either id
    expect((await call('GET', partUrl(ALIAS, 31, '2'), { t: tok(6, 'authorized - SU') })).status).toBe(200);
  });
});
