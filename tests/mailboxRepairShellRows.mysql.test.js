// tests/mailboxRepairShellRows.mysql.test.js
//
/**
 * REAL-ENGINE run of scripts/mailboxRepairShellRows.js — the one-off repair of
 * the envelope-less rows the FETCH-merge defect stored (mail_messages 790 and
 * 1077 on mailbox 2). Its exact SQL — the shell predicate, the worker's
 * recoverLogId, the guarded in-place UPDATE with CAST(? AS JSON), the
 * generated in_inbox — against MySQL with the production schema; IMAP is the
 * REAL transport over imapflow's REAL parser (tests/helpers/imapWire.js); the
 * lock is the worker's real GET_LOCK.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * The gated-suite protocol of tests/mailboxS2.mysql.test.js (its header): ONE
 * fresh throwaway *_test database loaded from ref/database.sql, --runInBand:
 *
 *   mysql -uroot -e "CREATE DATABASE yc_shell_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_shell_test < ref/database.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_shell_test npx jest --runInBand tests/mailboxRepairShellRows.mysql.test.js
 *
 * Run 2026-10-25: MySQL 8.0.46, all green.
 *
 * Mutation-checked (break the script, watch the named test fail):
 *   - the UIDVALIDITY check removed          → "UIDVALIDITY changed on the server → NO-GO …"
 *   - the known-id check removed             → "a known UID that now names another message → NO-GO …"
 *   - the below-the-cursor check removed     → "a shell the worker may still be on → NO-GO …"
 *   - the log-id expectation removed         → "the Apps Script execution names another log row → NO-GO …"
 *   - CHECK writes (apply ignored)           → "CHECK: GO with the plan …"
 */

'use strict';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('scripts/mailboxRepairShellRows.js on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const { encrypt } = require('../lib/credentialCrypto');
  const T = require('../services/mailbox/imapTransport');
  const { FakeImapFlow, dataLine, dec } = require('./helpers/imapWire');
  const repair = require('../scripts/mailboxRepairShellRows');

  const ALL = '[Gmail]/All Mail';
  const [K1, K2] = repair.KNOWN;
  const LAST_UID = 190394;
  let pool; let script; let clients; let realCreate;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const row = async (id) => (await q('SELECT * FROM mail_messages WHERE id = ?', [id]))[0];
  const runIt = async (apply) => {
    const lines = [];
    const r = await repair.run(pool, { apply, say: (s) => lines.push(s) });
    return { ...r, out: lines.join('\n') };
  };

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    realCreate = T.factory.create;
  });
  afterAll(async () => {
    T.factory.create = realCreate;
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clients = [];
    // The server: both shells' UIDs answer with their data (the fix's normal path).
    script = { uidValidity: 12n, uidNext: LAST_UID + 1, fetches: [[dataLine(K1.uid, dec(K1.providerId)), dataLine(K2.uid, dec(K2.providerId), 'Domain for sale')]] };
    T.factory.create = (opts) => { const c = new FakeImapFlow(opts, script); clients.push(c); return c; };

    for (const t of ['mailboxes', 'mail_messages', 'mail_read_state', 'email_ingest_executions', 'email_ingest_sources']) await q(`DELETE FROM ${t}`);
    await q(`INSERT INTO email_ingest_sources (id, name, api_key, active) VALUES
      (1, 'gmail-firm', 'test-not-a-key', 1), (3, 'mailbox-imap', 'test-not-a-key-2', 1)`); // secret-scan: allow
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, ingest_folders, ingest_state,
             ingest_enabled, active, emit_source_name, emit_id_kind)
             VALUES (2, 'stuart@4lsg.com', '4lsg.com', 'imap.gmail.com', 'stuart@4lsg.com', ?, ?, ?, 1, 1, 'gmail-firm', 'provider')`,
    [encrypt('Gm@il-App-Pass-q7'),
      JSON.stringify({ [ALL]: { emit_to_rules: true, backfill: false } }),
      JSON.stringify({ [ALL]: { uidvalidity: 12, last_uid: LAST_UID, checked_at: '2026-10-25T12:55:05.850Z' } })]);
    // a complete neighbour, then the two shells exactly as live (flags + uid, nothing else)
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, provider_id, gmail_labels, from_addr, subject, date, attachments, size, flags, log_id)
             VALUES (789, 2, ?, 188960, 'n@x.test', '1a14549de174b715', CAST('["\\\\\\\\Inbox"]' AS JSON), 'a@x.test', 'neighbour', '2026-10-16 15:16:45', '[]', 10, 'seen', 74830)`, [ALL]);
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, attachments, size, flags) VALUES
             (?, 2, ?, ?, '[]', 0, 'seen,answered'), (?, 2, ?, ?, '[]', 0, 'seen')`, [K1.id, ALL, K1.uid, K2.id, ALL, K2.uid]);
    await q("INSERT INTO mail_read_state (user, message_fk, read_at) VALUES (6, ?, '2026-10-16 16:00:00')", [K1.id]);
    // what the Apps Script's posts left: a logged execution (and a later duplicate) per mail
    await q(`INSERT INTO email_ingest_executions (source_id, message_id, status, log_id, remote_ip) VALUES
             (1, ?, 'logged', ?, '35.187.134.192'), (1, ?, 'duplicate', NULL, NULL),
             (1, ?, 'logged', ?, '35.187.134.192')`, [K1.providerId, K1.logId, K1.providerId, K2.providerId, K2.logId]);
  });
  afterEach(() => jest.restoreAllMocks());

  const isShell = (r) => r.provider_id == null && r.message_id == null && r.from_addr == null && r.date == null && r.log_id == null;
  const freeLock = async () => Number((await q("SELECT IS_FREE_LOCK(CONCAT('mailbox_ingest:', DATABASE())) AS f"))[0].f);

  test('CHECK: GO with the plan, writes nothing, releases the lock', async () => {
    const r = await runIt(false);
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^CHECK OK — GO\. 2 shell row\(s\) can be repaired\. Next: node scripts\/mailboxRepairShellRows\.js --apply$/);
    expect(r.plan.map(p => [p.id, p.row.provider_id, p.logId])).toEqual([[K1.id, K1.providerId, K1.logId], [K2.id, K2.providerId, K2.logId]]);
    expect(isShell(await row(K1.id))).toBe(true);
    expect(isShell(await row(K2.id))).toBe(true);
    expect(await freeLock()).toBe(1);
    expect(clients.flatMap(c => c.calls).filter(c => c[0] === 'mailboxOpen').map(c => c[2])).toEqual([{ readOnly: true }]);
  });

  test('APPLY: both rows rewritten in place, bridged, read state kept, the neighbour untouched; a re-run is ALREADY REPAIRED', async () => {
    const neighbour = await row(789);
    const r = await runIt(true);
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^REPAIRED — GO\. 2 row\(s\)\./);
    expect(r.repaired).toEqual([K1.id, K2.id]);

    const a = await row(K1.id);
    expect(a).toMatchObject({
      mailbox_id: 2, folder: ALL, uid: K1.uid, provider_id: K1.providerId, message_id: `m${K1.uid}@trustee.test`,
      subject: 'Re: adjourning the hearing', log_id: K1.logId, in_inbox: 1, flags: 'seen', size: 4321, // the server's flags now
      body_text: `body ${K1.uid}`,
    });
    expect(a.from_addr).toContain('staff@trustee.test');
    expect(a.gmail_labels).toEqual(['\\Inbox', 'Court Notices']);
    expect(a.attachments).toEqual([]);
    expect(a.date).toEqual(new Date('2026-10-16T15:20:56Z'));
    expect(a.thread_key).toBe(`m${K1.uid}@trustee.test`);
    expect(await row(K2.id)).toMatchObject({ provider_id: K2.providerId, subject: 'Domain for sale', log_id: K2.logId });
    expect(await q('SELECT user, message_fk FROM mail_read_state')).toEqual([{ user: 6, message_fk: K1.id }]);
    expect(await row(789)).toEqual(neighbour);
    expect(await freeLock()).toBe(1);

    const again = await runIt(true);
    expect(again.ok).toBe(true);
    expect(again.line).toMatch(/^ALREADY REPAIRED — /);
    expect(clients).toHaveLength(1); // the re-run never connected to IMAP
  });

  // ── NO-GO: each writes nothing ──
  const assertUntouched = async (r, re) => {
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO/);
    expect(r.out).toMatch(re);
    expect(isShell(await row(K1.id))).toBe(true);
    expect(isShell(await row(K2.id))).toBe(true);
    expect(await freeLock()).toBe(1);
  };

  test('UIDVALIDITY changed on the server → NO-GO, nothing fetched or written', async () => {
    script.uidValidity = 13n;
    await assertUntouched(await runIt(true), /UIDVALIDITY is 13, the cursor's is 12/);
    expect(clients.flatMap(c => c.calls).filter(c => c[0] === 'fetchAll')).toHaveLength(0);
  });

  test('a known UID that now names another message → NO-GO', async () => {
    script.fetches = [[dataLine(K1.uid, dec('1a1400000000abcd')), dataLine(K2.uid, dec(K2.providerId))]];
    await assertUntouched(await runIt(true), /is Gmail id 1a1400000000abcd, expected 1a1454d7167dd8b5/);
  });

  test('a shell the worker may still be on (above the cursor) → NO-GO', async () => {
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, attachments, size, flags) VALUES (5000, 2, ?, ?, '[]', 0, 'seen')`, [ALL, LAST_UID + 5]);
    await assertUntouched(await runIt(true), /shell 5000 \(uid 190399\) is not below the cursor/);
  });

  test('the Apps Script execution names another log row → NO-GO', async () => {
    await q('UPDATE email_ingest_executions SET log_id = 99999 WHERE message_id = ? AND status = ?', [K2.providerId, 'logged']);
    await assertUntouched(await runIt(true), /recorded log 99999, expected 75265/);
  });

  test('Gmail no longer has one of them → NO-GO (a human decides)', async () => {
    script.fetches = [[dataLine(K1.uid, dec(K1.providerId))]];
    await assertUntouched(await runIt(true), /Gmail no longer has uid 189459/);
  });

  test('a tick holds the ingest lock → NO-GO before anything is read', async () => {
    const other = await pool.getConnection();
    try {
      await other.query("SELECT GET_LOCK(CONCAT('mailbox_ingest:', DATABASE()), 0)");
      const r = await runIt(true);
      expect(r.ok).toBe(false);
      expect(r.line).toMatch(/^NO-GO — an ingest run holds the lock/);
      expect(clients).toHaveLength(0);
    } finally {
      await other.query("SELECT RELEASE_LOCK(CONCAT('mailbox_ingest:', DATABASE()))");
      other.release();
    }
    expect(isShell(await row(K1.id))).toBe(true);
  });
});
