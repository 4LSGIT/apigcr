// tests/mailboxContentKey.mysql.test.js
//
/**
 * REAL-ENGINE run of the CONTENT-AWARE RFC KEY (dedup-A,
 * services/mailbox/mailboxIngestService.js header): the REAL worker, the REAL
 * emailIngestService (email_log's UNIQUE(source, message_id), executions,
 * logService) over a real MySQL with the production schema. IMAP is the S1
 * world's fake account (tests/helpers/mailboxS1World.js makeImapServer)
 * through imapTransport.withMailbox; alerting is stubbed.
 *
 * What it proves on the engine: the first-row lookup
 * (SELECT subject FROM email_log WHERE source = ? AND message_id = ?) and the
 * non-provider secondary dedupe (… message_id = ? LIMIT 50 + the subject)
 * decide as designed — a CM/ECF "Docket Entry #N has been updated" notice
 * that reuses the corrected notice's Message-ID gets its own key, log row and
 * rules; per-recipient copies (same subject, different body / Date / Gmail
 * id) and cross-mailbox copies collapse to one log row.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Its OWN fresh throwaway *_test database (it DELETEs from mailboxes,
 * mail_messages, email_log, email_ingest_executions, email_ingest_sources,
 * log):
 *   mysql -uroot -e 'CREATE DATABASE yc_ckey_test'
 *   mysql -uroot yc_ckey_test < ref/database.sql
 *   mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -uroot mysql   # once per server (CONVERT_TZ … 'EST5EDT')
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3306/yc_ckey_test npx jest --runInBand tests/mailboxContentKey.mysql.test.js
 * Run 2026-11-20: MySQL 8.4.11, production sql_mode, session time zone UTC.
 */

'use strict';

process.env.EMAIL_DOMAINS = 'firm.test';

jest.mock('../services/mailbox/imapTransport', () => {
  const actual = jest.requireActual('../services/mailbox/imapTransport');
  return { ...actual, withMailbox: jest.fn(), fetchPart: jest.fn() };
});
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('content-aware RFC key on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const transport = require('../services/mailbox/imapTransport');
  const svc = require('../services/mailbox/mailboxIngestService');
  const { makeImapServer, msg } = require('./helpers/mailboxS1World');

  const ALL = '[Gmail]/All Mail';
  const X = '74463508@mieb.uscourts.gov';
  const NEF = '26-51058-lsg "Meeting of Creditors Chapter 13" Ch 13';
  const UPD = '26-51058-lsg  Docket Entry #18 has been updated';
  const COURT = [{ name: '', address: 'mieb_ecfadmin@mieb.uscourts.gov' }];
  let pool; let S;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const hex = (n) => (0x1a1833da2f54f9bdn + BigInt(n)).toString(16);
  const run = () => svc.runIngest(pool, { budgetMs: 60000 });
  const tagged = (rfc, subject) => `${rfc}#s:${svc.subjectTag(subject)}`;

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 6,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}', time_zone = '+00:00'`));
  });
  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['mailboxes', 'mail_messages', 'mail_read_state', 'email_log', 'email_ingest_executions', 'email_ingest_sources']) {
      await q(`DELETE FROM ${t}`);
    }
    await q("DELETE FROM log WHERE log_type = 'email'");
    await q(`INSERT INTO email_ingest_sources (id, name, api_key, active) VALUES (3, 'mailbox-imap', NULL, 1), (1, 'gmail-firm', 'k', 1)`);
    // box 2: the Google inbox at the DEFAULT identity (dedup-A); box 3: a host without provider ids
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, ingest_folders, ingest_state, ingest_enabled, active) VALUES
      (2, 'stuart@firm.test', 'firm.test', 'imap.gmail.com', 'u', 'ENCv1:fake', ?, ?, 1, 1),
      (3, 'it@firm.test', 'firm.test', 'mail.host.test', 'u', 'ENCv1:fake', ?, ?, 1, 1)`,
    [JSON.stringify({ [ALL]: { emit_to_rules: true, backfill: false } }), JSON.stringify({ [ALL]: { uidvalidity: 12, last_uid: 0 } }),
      JSON.stringify({ INBOX: { emit_to_rules: true } }), JSON.stringify({ INBOX: { uidvalidity: 3, last_uid: 0 } })]);
    S = makeImapServer();
    S.addFolder(ALL, 12, []);
    S.addFolder('INBOX', 3, []);
    transport.withMailbox.mockReset().mockImplementation(S.withMailbox);
  });
  afterEach(() => jest.restoreAllMocks());

  const logRows = () => q('SELECT message_id, subject FROM email_log ORDER BY id');
  const execs = () => q('SELECT message_id, status FROM email_ingest_executions ORDER BY id');
  const stored = (box, folder) => q('SELECT uid, message_id, subject, log_id FROM mail_messages WHERE mailbox_id = ? AND folder = ? ORDER BY uid', [box, folder]);

  test('Google inbox: per-recipient ECF copies collapse to one log row; the "Docket Entry updated" notice is its own (and so are its copies)', async () => {
    const at = (s) => new Date(Date.UTC(2026, 9, 28, 15, 59, s));
    S.deliver(ALL, msg(1, { messageId: X, subject: NEF, from: COURT, providerId: hex(1), date: at(0), text: 'NEF magic_num=111' }));
    S.deliver(ALL, msg(2, { messageId: X, subject: NEF, from: COURT, providerId: hex(2), date: at(1), text: 'NEF  magic_num=222\n(re-wrapped)' }));
    S.deliver(ALL, msg(3, { messageId: X, subject: UPD, from: COURT, providerId: hex(3), date: at(50), text: 'PLEASE DISREGARD' }));
    S.deliver(ALL, msg(4, { messageId: X, subject: UPD, from: COURT, providerId: hex(4), date: at(51), text: 'PLEASE DISREGARD (copy)' }));
    const s = await run();
    expect([s.stored, s.emitted]).toEqual([4, 4]);
    expect(await logRows()).toEqual([{ message_id: X, subject: NEF }, { message_id: tagged(X, UPD), subject: UPD }]);
    expect((await execs()).map(e => [e.message_id, e.status])).toEqual([
      [X, 'logged'], [X, 'duplicate'], [tagged(X, UPD), 'logged'], [tagged(X, UPD), 'duplicate'],
    ]);
    const rows = await stored(2, ALL);
    expect(rows.map(r => r.log_id != null)).toEqual([true, true, true, true]);
    expect(rows[1].log_id).toBe(rows[0].log_id);
    expect(rows[3].log_id).toBe(rows[2].log_id);
    expect(rows[2].log_id).not.toBe(rows[0].log_id);
    expect((await q("SELECT COUNT(*) AS n FROM log WHERE log_type = 'email'"))[0].n).toBe(2);
  });

  test('host without provider ids: a same-subject copy is not even stored; a different-subject repeat is stored and emitted under its own key', async () => {
    S.deliver('INBOX', msg(1, { messageId: 'y@court', subject: 'Order  Entered', from: COURT }));
    S.deliver('INBOX', msg(2, { messageId: 'y@court', subject: ' order entered', from: COURT }));
    S.deliver('INBOX', msg(3, { messageId: 'y@court', subject: 'Docket Entry #2 has been updated', from: COURT }));
    const s = await run();
    expect([s.stored, s.duplicates, s.emitted]).toEqual([2, 1, 2]);
    expect((await stored(3, 'INBOX')).map(r => [r.uid, r.subject])).toEqual([[1, 'Order  Entered'], [3, 'Docket Entry #2 has been updated']]);
    expect((await logRows()).map(r => r.message_id)).toEqual(['y@court', tagged('y@court', 'Docket Entry #2 has been updated')]);
  });

  test('order does not matter: the update seen FIRST keeps the bare id; the notice after it is the suffixed one', async () => {
    S.deliver(ALL, msg(1, { messageId: X, subject: UPD, from: COURT, providerId: hex(1) }));
    S.deliver(ALL, msg(2, { messageId: X, subject: NEF, from: COURT, providerId: hex(2) }));
    await run();
    expect(await logRows()).toEqual([{ message_id: X, subject: UPD }, { message_id: tagged(X, NEF), subject: NEF }]);
  });

  test('across mailboxes, in one run: the copy is a duplicate bridged to the first log row; a third subject gets a third key', async () => {
    S.deliver(ALL, msg(1, { messageId: 'z@x', subject: 'Re: plan', providerId: hex(1) }));
    S.deliver('INBOX', msg(1, { messageId: 'z@x', subject: 'RE:  PLAN' }));
    S.deliver('INBOX', msg(2, { messageId: 'z@x', subject: 'Re: plan v2' }));
    await run();
    expect((await execs()).map(e => [e.message_id, e.status])).toEqual([
      ['z@x', 'logged'], ['z@x', 'duplicate'], [tagged('z@x', 'Re: plan v2'), 'logged'],
    ]);
    const [g] = await stored(2, ALL);
    const [copy, v2] = await stored(3, 'INBOX');
    expect(copy.log_id).toBe(g.log_id);
    expect(v2.log_id).not.toBe(g.log_id);
  });

  test('a provider-keyed override is untouched: keyed by the Gmail id, whatever the subject — an earlier row under that id is a duplicate even when its subject differs', async () => {
    await q("UPDATE mailboxes SET emit_source_name = 'gmail-firm', emit_id_kind = 'provider' WHERE id = 2");
    // what the Apps Script adapter logged for hex(3), its subject rendered differently
    await q(`INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, attachments, processed_at)
             VALUES ('gmail-firm', ?, 'a@x.com', 'stuart@firm.test', 'other rendering', '', '[]', NOW())`, [hex(3)]);
    S.deliver(ALL, msg(1, { messageId: X, subject: NEF, from: COURT, providerId: hex(1) }));
    S.deliver(ALL, msg(2, { messageId: X, subject: UPD, from: COURT, providerId: hex(2) }));
    S.deliver(ALL, msg(3, { messageId: 'w@x', subject: 'the rendering', providerId: hex(3) }));
    await run();
    expect((await logRows()).map(r => r.message_id)).toEqual([hex(3), hex(1), hex(2)]);
    expect((await execs()).map(e => [e.message_id, e.status])).toEqual([[hex(1), 'logged'], [hex(2), 'logged'], [hex(3), 'duplicate']]);
  });
});
