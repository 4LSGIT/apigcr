/**
 * REAL-ENGINE run of mailbox slice S2-L (Gmail labels): the ingest worker
 * writing gmail_labels, the generated in_inbox following it, the SU label
 * re-snapshot (CASE … CAST(? AS JSON) + the real GET_LOCK) and the hub
 * reading the result — over a real MySQL with the production schema. IMAP is
 * the S1 world's fake account (tests/helpers/mailboxS1World.js makeImapServer)
 * through imapTransport.withMailbox; everything else is real.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Same throwaway *_test database as tests/mailboxS2.mysql.test.js (its header
 * lists the setup, including ref/migrations/2026-10-11_mailbox_s2l_labels.sql).
 * Worker run 2026-10-11: MySQL 8.0.46 and 8.4.6, all green.
 *
 * Mutation-checked here: snapshotLabels without acquireLock (the held-lock
 * test writes), the CASE write without CAST(? AS JSON) still passes on the
 * engine (assignment parses the text) — kept for explicitness, not relied on.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2l-mysql-secret';
process.env.EMAIL_DOMAINS = 'firm.test';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('mailbox S2-L on real MySQL', () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const mysql = require('mysql2/promise');
  const transport = require('../services/mailbox/imapTransport');
  const svc = require('../services/mailbox/mailboxIngestService');
  const { makeImapServer, msg } = require('./helpers/mailboxS1World');

  const ALL = '[Gmail]/All Mail';
  const SU = 6;
  let pool; let server; let base; let S;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tok = () => jwt.sign({ sub: String(SU), username: 'u6', user_auth: 'authorized - SU', aud: 'staff' }, process.env.JWT_SECRET);
  const hex = (n) => (0x1a11d045dc6887d0n + BigInt(n)).toString(16);
  const gmsg = (uid, labels) => msg(uid, { providerId: hex(uid), labels, date: new Date(Date.UTC(2026, 9, 11, 9, uid)) });

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 6,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const [[col]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages' AND COLUMN_NAME = 'in_inbox'");
    if (!Number(col.n)) throw new Error('apply ref/migrations/2026-10-11_mailbox_s2l_labels.sql to the test database first');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.mail'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'inbox_views']) await q(`DELETE FROM ${t}`);
    await q('DELETE FROM users WHERE user = ?', [SU]);
    await q(`INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, user_custom_tab, roles)
             VALUES (?, 'u6', 1, 'User 6', 'f', 'l', 'xx', 'authorized - SU', 0, '{}', 'it')`, [SU]);
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, ingest_folders, ingest_state, ingest_enabled, active) VALUES
      (2, 'stuart@firm.test', 'firm.test', 'imap.gmail.com', 'u', 'ENCv1:fake', ?, ?, 1, 1),
      (5, 'pilot@firm.test', 'firm.test', 'gcam1191.siteground.biz', 'u', 'ENCv1:fake', ?, ?, 0, 1)`,
    [JSON.stringify({ [ALL]: { emit_to_rules: false, backfill: false } }), JSON.stringify({ [ALL]: { uidvalidity: 12, last_uid: 0 } }),
      JSON.stringify({ INBOX: { emit_to_rules: false } }), JSON.stringify({ INBOX: { uidvalidity: 3, last_uid: 0 } })]);
    S = makeImapServer();
    S.providerIdKind = 'gmail';
    S.labelsKind = 'gmail';
    transport.withMailbox.mockReset().mockImplementation(S.withMailbox);
  });
  afterEach(() => jest.restoreAllMocks());

  const inbox = async () => {
    const r = await fetch(`${base}/api/mail/messages?mailbox_ids=2`, { headers: { Authorization: `Bearer ${tok()}` } });
    return (await r.json()).messages.map((m) => m.id);
  };

  test('the worker stores the snapshot; in_inbox follows it; the hub lists the \\Inbox rows', async () => {
    S.addFolder(ALL, 12, []);
    S.deliver(ALL, gmsg(1, ['\\Inbox', '\\Important']));
    S.deliver(ALL, gmsg(2, ['\\Sent']));
    S.deliver(ALL, gmsg(3, []));
    S.deliver(ALL, gmsg(4, null));
    const s = await svc.runIngest(pool);
    expect([s.skipped, s.stored, s.emitted]).toEqual([false, 4, 0]);
    const rows = await q('SELECT id, uid, gmail_labels, in_inbox FROM mail_messages WHERE mailbox_id = 2 ORDER BY uid');
    expect(rows.map((r) => [r.uid, r.gmail_labels, r.in_inbox])).toEqual([
      [1, ['\\Inbox', '\\Important'], 1], [2, ['\\Sent'], 0], [3, [], 0], [4, null, 0],
    ]);
    expect(await inbox()).toEqual([rows[0].id]);
  });

  test('the re-snapshot writes through CASE … CAST(? AS JSON) under the REAL lock; a held lock writes nothing', async () => {
    S.addFolder(ALL, 12, [1, 2, 3].map((u) => gmsg(u, null)));
    await q('UPDATE mailboxes SET ingest_state = ? WHERE id = 2', [JSON.stringify({ [ALL]: { uidvalidity: 12, last_uid: 3 } })]);
    for (const u of [1, 2, 3]) {
      await q('INSERT INTO mail_messages (mailbox_id, folder, uid, message_id, provider_id, date, attachments) VALUES (2, ?, ?, ?, ?, ?, ?)',
        [ALL, u, `m${u}@example.com`, hex(u), new Date(Date.UTC(2026, 9, 11, 9, u)), '[]']);
    }
    S.labels = { 1: ['\\Inbox'], 2: ['\\Sent', 'IT'], 3: ['\\Inbox'] };
    expect(await inbox()).toEqual([]);

    // another session holds the ingest lock (an ingest run): skipped, untouched
    const other = await pool.getConnection();
    try {
      const [[g]] = await other.query(`SELECT GET_LOCK(${svc.LOCK_EXPR}, 0) AS got`);
      expect(Number(g.got)).toBe(1);
      const r = await svc.snapshotLabels(pool, 2);
      expect(r.skipped).toBe(true);
      expect(S.labelCalls).toEqual([]);
      expect((await q('SELECT COUNT(*) AS n FROM mail_messages WHERE gmail_labels IS NOT NULL'))[0].n).toBe(0);
      await other.query(`SELECT RELEASE_LOCK(${svc.LOCK_EXPR})`);
    } finally {
      other.release();
    }

    const r = await svc.snapshotLabels(pool, 2, { limit: 2 });
    expect([r.updated, r.next_after_uid, r.done]).toEqual([2, 2, false]);
    const r2 = await svc.snapshotLabels(pool, 2, { limit: 2, afterUid: 2 });
    expect([r2.updated, r2.done]).toEqual([1, true]);
    const rows = await q('SELECT uid, gmail_labels, in_inbox, JSON_TYPE(gmail_labels) AS t FROM mail_messages WHERE mailbox_id = 2 ORDER BY uid');
    expect(rows.map((x) => [x.uid, x.gmail_labels, x.in_inbox, x.t])).toEqual([
      [1, ['\\Inbox'], 1, 'ARRAY'], [2, ['\\Sent', 'IT'], 0, 'ARRAY'], [3, ['\\Inbox'], 1, 'ARRAY'],
    ]);
    expect((await inbox()).length).toBe(2);
    // the lock is free again (released by the service)
    const [[free]] = await pool.query(`SELECT IS_FREE_LOCK(${svc.LOCK_EXPR}) AS f`);
    expect(Number(free.f)).toBe(1);
  });

  test('non-Gmail box: the worker stores NULL labels, the re-snapshot writes nothing', async () => {
    S.labelsKind = null;
    S.providerIdKind = null;
    await q('UPDATE mailboxes SET ingest_enabled = 0 WHERE id = 2');
    await q('UPDATE mailboxes SET ingest_enabled = 1 WHERE id = 5');
    S.addFolder('INBOX', 3, []);
    S.deliver('INBOX', msg(1, { labels: null }));
    await svc.runIngest(pool);
    const [row] = await q('SELECT gmail_labels, in_inbox FROM mail_messages WHERE mailbox_id = 5');
    expect([row.gmail_labels, row.in_inbox]).toEqual([null, 1]);
    const r = await svc.snapshotLabels(pool, 5);
    expect([r.labels_supported, r.updated]).toEqual([false, 0]);
    expect((await q('SELECT COUNT(*) AS n FROM mail_messages WHERE gmail_labels IS NOT NULL'))[0].n).toBe(0);
  });
});
