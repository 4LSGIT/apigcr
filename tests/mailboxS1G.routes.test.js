// tests/mailboxS1G.routes.test.js
//
/**
 * Mailbox system S1-G — the two SU diagnostic reads in routes/api.mailboxes.js:
 *   GET /api/mailboxes/:id/folders
 *   GET /api/mailboxes/:id/messages/:mid/emit-preview
 * Run: npx jest tests/mailboxS1G.routes.test.js
 *
 * The REAL router, lib/auth.jwtOrApiKey, mailboxService grant resolution and
 * mailboxIngestService.previewEmission run over an express app against the
 * stateful fake DB in tests/helpers/mailboxS1World.js. Mocked: only
 * imapTransport.listFolders (IMAP).
 *
 * Mutation-checked:
 *   - SU gate replaced by can_manage          → "grant holders (manage included) get 403; strangers 404"
 *   - configured-folder check dropped         → "flags configured folders that are missing or All Mail"
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s1g-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s1g_internal';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn(), listFolders: jest.fn() };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const transport = require('../services/mailbox/imapTransport');
const { makeWorld } = require('./helpers/mailboxS1World');

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(require('../routes/api.mailboxes'));

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tok = (user, user_auth = 'authorized') =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);
const SU = () => tok(6, 'authorized - SU');

async function call(url, { t } = {}) {
  const headers = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(base + url, { headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

const SENT = '[Gmail]/Sent Mail';
let MB;
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  W = makeWorld();
  MB = W.addMailbox({
    address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com',
    ingest_folders: { INBOX: { emit_to_rules: false, backfill: false }, [SENT]: { emit_to_rules: false, backfill: false }, '[Gmail]/All Mail': { emit_to_rules: false } },
  });
  W.T.channel_grants.push(
    { user: 1, channel_type: 'mailbox', channel_id: MB, can_read: 1, can_send: 0, can_manage: 1 },
  );
  W.T.mail_messages.push({
    id: 41, mailbox_id: MB, folder: 'INBOX', uid: 3, message_id: 'nef@uscourts', provider_id: '1a11dfc6c43ae8c9',
    subject: '26-44883-mlo Ch 7', from_addr: 'mieb_ecfadmin@mieb.uscourts.gov', body_text: null,
    body_html: '<p>Case Name: John Q. Public</p>', log_id: null,
  });
  transport.listFolders.mockReset().mockImplementation(async () => ({
    provider_id_kind: 'gmail',
    folders: [
      { path: 'INBOX', delimiter: '/', special_use: '\\Inbox', flags: [], selectable: true, messages: 62012, uid_next: 900001, uid_validity: 1 },
      { path: '[Gmail]/All Mail', delimiter: '/', special_use: '\\All', flags: ['\\All'], selectable: true, messages: 99000, uid_next: 1, uid_validity: 9 },
      { path: '[Gmail]/Sent', delimiter: '/', special_use: '\\Sent', flags: ['\\Sent'], selectable: true, messages: 26206, uid_next: 30001, uid_validity: 5 },
    ],
  }));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/mailboxes/:id/folders', () => {
  test('SU: the server list, provider_id_kind, and the configured folders checked against it', async () => {
    const r = await call(`/api/mailboxes/${MB}/folders`, { t: SU() });
    expect(r.status).toBe(200);
    expect(r.json.provider_id_kind).toBe('gmail');
    expect(r.json.folders).toHaveLength(3);
    expect(r.json.emit_override).toEqual({ emit_source_name: null, emit_id_kind: null });
    // The transport got the secret-bearing connection row; the response never carries it.
    expect(transport.listFolders.mock.calls[0][0]).toMatchObject({ id: MB, imap_secret: 'ENCv1:fake' });
    expect(r.text).not.toContain('ENCv1');
  });

  test('flags configured folders that are missing or All Mail', async () => {
    const r = await call(`/api/mailboxes/${MB}/folders`, { t: SU() });
    const byName = Object.fromEntries(r.json.configured.map(c => [c.folder, c]));
    expect(byName.INBOX).toMatchObject({ exists: true, messages: 62012, backfill: false, all_mail: false });
    expect(byName[SENT]).toMatchObject({ exists: false }); // localized/misspelt name caught before polling
    expect(byName['[Gmail]/All Mail']).toMatchObject({ exists: true, all_mail: true });
  });

  test('grant holders (manage included) get 403; strangers 404; no IMAP connection is made', async () => {
    expect((await call(`/api/mailboxes/${MB}/folders`, { t: tok(1) })).status).toBe(403);
    expect((await call(`/api/mailboxes/${MB}/folders`, { t: tok(9) })).status).toBe(404);
    expect((await call(`/api/mailboxes/${MB}/folders`)).status).toBe(401);
    expect(transport.listFolders).not.toHaveBeenCalled();
  });

  test('an IMAP failure is a 502 carrying the sanitized code', async () => {
    transport.listFolders.mockRejectedValueOnce(Object.assign(new Error('IMAP AUTHENTICATIONFAILED: Invalid credentials'),
      { code: 'AUTHENTICATIONFAILED', imap: true, sanitized: true }));
    const r = await call(`/api/mailboxes/${MB}/folders`, { t: SU() });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ code: 'AUTHENTICATIONFAILED' });
  });

  test('unknown mailbox → 404, bad id → 400', async () => {
    expect((await call('/api/mailboxes/999/folders', { t: SU() })).status).toBe(404);
    expect((await call('/api/mailboxes/x/folders', { t: SU() })).status).toBe(400);
  });
});

describe('GET /api/mailboxes/:id/messages/:mid/emit-preview', () => {
  test('SU: the would-be emission — default identity, derived text', async () => {
    const r = await call(`/api/mailboxes/${MB}/messages/41/emit-preview`, { t: SU() });
    expect(r.status).toBe(200);
    expect(r.json.preview).toMatchObject({
      id: 41, provider_id: '1a11dfc6c43ae8c9', text: 'Case Name: John Q. Public', text_derived_from_html: true,
      emit: { source: 'mailbox-imap', id_kind: 'rfc', key: 'nef@uscourts', folder_emits: false },
    });
  });

  test('with the override set, the key is the provider id', async () => {
    Object.assign(W.T.mailboxes.find(b => b.id === MB), { emit_source_name: 'gmail-firm', emit_id_kind: 'provider' });
    const r = await call(`/api/mailboxes/${MB}/messages/41/emit-preview`, { t: SU() });
    expect(r.json.preview.emit).toMatchObject({ source: 'gmail-firm', id_kind: 'provider', key: '1a11dfc6c43ae8c9' });
  });

  test('SU only; unknown message → 404; bad id → 400', async () => {
    expect((await call(`/api/mailboxes/${MB}/messages/41/emit-preview`, { t: tok(1) })).status).toBe(403);
    expect((await call(`/api/mailboxes/${MB}/messages/41/emit-preview`, { t: tok(9) })).status).toBe(404);
    expect((await call(`/api/mailboxes/${MB}/messages/77/emit-preview`, { t: SU() })).status).toBe(404);
    expect((await call(`/api/mailboxes/${MB}/messages/0/emit-preview`, { t: SU() })).status).toBe(400);
  });
});
