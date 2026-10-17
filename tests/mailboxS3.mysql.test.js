/**
 * REAL-ENGINE TWIN of the mailbox S3 suites: the SQL S3 adds — the Sent
 * scope (mailReadService SENT_WHERE), mailboxService.listSendable, and every
 * statement of services/mailbox/mailboxSendService (identity, credential,
 * signature flag, budget count, the adapter's email_log row + its lookup, the
 * seed job row, the seed probes, the budget alert's dedup) — on MySQL 8 with
 * the production schema and sql_mode. The fake worlds
 * (tests/helpers/mailboxS2World.js, mailboxS3World.js) model this SQL; here
 * the engine answers, and the Sent edge matrix is checked engine = world.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test (the suite deletes rows in
 * the tables it uses), loaded as tests/mailboxS2.mysql.test.js describes
 * (ref/database.sql + the S2 / S2-L migrations; the S3 slice adds none):
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_s3_test npx jest tests/mailboxS3.mysql.test.js
 * Worker run 2026-10-11: MySQL 8.0.46, all green.
 *
 * Mutation-checked HERE (worker run 2026-10-11 — the worlds only match the
 * text, so these need the engine):
 *   - SENT_WHERE with the label inline in the SQL text instead of bound —
 *     the edge matrix (a single backslash in SQL text is eaten: '\Sent' is
 *     'Sent') and the plan test's no-backslash check
 *   - the folder REGEXP without its (^|[./]) anchor ("INBOX.Sentinel" /
 *     "Unsent" would match) — the edge matrix (also in CI, via the world)
 *   - the Sent list on idx_mail_messages_mailbox_inbox_date → the plan test
 *   - the seed's provider probe without the date bound → the plan test
 *     (range on (mailbox_id, date))
 *   - a Sent view counted; sent_only + all_folders allowed → the mark-all test
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s3-mysql-secret';
process.env.EMAIL_DOMAINS = 'firm.test';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});

maybe('mailbox S3 on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const read = require('../services/mailbox/mailReadService');
  const mbx = require('../services/mailboxService');
  const S = require('../services/mailbox/mailboxSendService');
  const transport = require('../services/mailbox/imapTransport');
  const { encrypt } = require('../lib/credentialCrypto');
  const { makeWorld, SENT_MATRIX } = require('./helpers/mailboxS3World');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const SS = 1; const SU = 6; const SENDER = 8; const READER = 5;

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
  });
  afterAll(async () => { if (pool) await pool.end(); });

  // The Sent edge matrix: [id, mailbox, folder, gmail_labels JSON | null, in the Sent scope?]
  const MATRIX = SENT_MATRIX; // tests/helpers/mailboxS3World.js — the world half runs in CI (mailboxS3.send.test.js)

  async function seedDb() {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'inbox_views', 'email_log', 'scheduled_jobs', 'system_alerts', 'alert_state', 'email_credentials']) {
      await q(`DELETE FROM ${t}`);
    }
    await q("DELETE FROM app_settings WHERE `key` = 'mail_send_daily_budget'");
    await q('DELETE FROM users WHERE user IN (1, 5, 6, 8)');
    const user = (id, auth, roles) => q(
      `INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, roles)
       VALUES (?, ?, 1, ?, 'f', 'l', 'xx', ?, 0, ?)`, [id, 'u' + id, 'User ' + id, auth, roles]);
    await user(SS, 'authorized', 'staff,attorney');
    await user(READER, 'authorized', 'staff');
    await user(SU, 'authorized', 'it,admin,form_dev,su');
    await user(SENDER, 'authorized', 'staff');
    await q("INSERT IGNORE INTO credentials (id, name, type) VALUES (11, 'Google Workspace (test)', 'oauth2')"); // email_credentials.credential_id FK
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, credential_id, from_name, signature_html, signature_text) VALUES
      (1, 'billing@firm.test', 'mail.firm.test', 587, 'billing@firm.test', ?, 0, 'smtp', NULL, 'Billing', '<b>Billing</b>', NULL),
      (2, 'stuart@firm.test', '', 0, '', '', 0, 'gmail', 11, 'Stuart', NULL, ''),
      (3, 'automations@firm.test', '', 0, '', '', 0, 'gmail', 11, 'Automations', NULL, NULL),
      (4, 'pab@firm.test', '', 0, '', '', 0, 'pabbly', NULL, 'Pab', NULL, NULL)`, [encrypt('pw')]);
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, send_credential_id, ingest_folders, active) VALUES
      (1, 'billing@firm.test', 'firm.test', 'imap.firm.test', 'billing@firm.test', 'ENCv1:x', 1, '{"INBOX":{"emit_to_rules":true},"INBOX.Sent":{"emit_to_rules":false}}', 1),
      (2, 'stuart@firm.test', 'firm.test', 'imap.gmail.com', 'stuart@firm.test', 'ENCv1:y', 2, '{"[Gmail]/All Mail":{"emit_to_rules":true,"backfill":false}}', 1),
      (3, 'pab@firm.test', 'firm.test', 'h', 'u', NULL, 4, NULL, 1),
      (4, 'nosend@firm.test', 'firm.test', 'h', 'u', NULL, NULL, NULL, 1)`);
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES
      (?, 'mailbox', 1, 1, 1, 0, 6), (?, 'mailbox', 2, 1, 1, 1, 6), (?, 'mailbox', 1, 1, 0, 0, 6)`, [SENDER, SS, READER]);
    for (const [id, mb, folder, labels] of MATRIX) {
      await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, gmail_labels, from_addr, to_addrs, subject, date, snippet, attachments, ingested_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'a@b.test', 'c@d.test', 's', ?, 's', '[]', '2026-10-02 00:00:00')`,
      [id, mb, folder, id, `m${id}@x.test`, `m${id}@x.test`, labels, `2026-10-01 12:${String(id % 60).padStart(2, '0')}:00`]);
    }
  }
  beforeEach(seedDb);
  afterEach(() => jest.restoreAllMocks());

  test('the Sent edge matrix on the engine = the expected set = the fake world', async () => {
    const want = MATRIX.filter((r) => r[4]).map((r) => r[0]).sort((a, b) => a - b);
    const engine = (await read.listMessages(pool, SU, { sent_only: '1', limit: 100 })).messages.map((m) => m.id).sort((a, b) => a - b);
    expect(engine).toEqual(want);
    const W = makeWorld();
    W.user(SU, { auth: 'authorized', roles: 'su' });
    W.mailbox(1, { address: 'billing@firm.test' });
    W.mailbox(2, { address: 'stuart@firm.test' });
    for (const [id, mb, folder, labels] of MATRIX) W.message(id, { mailbox_id: mb, folder, gmail_labels: labels });
    const world = (await read.listMessages(W.db, SU, { sent_only: '1', limit: 100 })).messages.map((m) => m.id).sort((a, b) => a - b);
    expect(world).toEqual(want);
    // and the Sent list's rows tell the pane where they sit
    const rows = (await read.listMessages(pool, SU, { sent_only: '1', limit: 100 })).messages;
    expect(rows.find((m) => m.id === 401)).toMatchObject({ sent: true, place: 'Sent' });
    expect(rows.find((m) => m.id === 408)).toMatchObject({ sent: false, place: 'INBOX.Sent' });
  });

  test('the Sent list walks (mailbox_id, date) backwards, per branch', async () => {
    const seen = [];
    const spy = { query: (sql, p) => { seen.push({ sql, p }); return pool.query(sql, p); } };
    await read.listMessages(spy, SU, { sent_only: '1' });
    const list = seen.find((s) => /UNION ALL|FORCE INDEX/.test(s.sql));
    const plan = await q(`EXPLAIN ${list.sql}`, list.p);
    const branches = plan.filter((r) => r.table === 'm');
    expect(branches.length).toBe(4); // one per readable mailbox (SU: all four)
    for (const b of branches) expect(b.key).toBe('idx_mail_messages_mailbox_date');
    expect(list.sql).not.toMatch(/\\Sent/); // the label is a bound parameter, never SQL text
  });

  test('mark-all on the Sent scope marks exactly the Sent rows; sent_only + all_folders is a 400; a Sent view counts nothing', async () => {
    const out = await read.markRead(pool, SU, { all: true, filters: { sent_only: true } });
    expect(out.marked).toBe(MATRIX.filter((r) => r[4]).length);
    await expect(read.listMessages(pool, SU, { sent_only: '1', all_folders: '1' })).rejects.toMatchObject({ status: 400 });
    const v = await read.createView(pool, SU, { name: 'Sent', filters: { sent_only: true } });
    const w = await read.createView(pool, SU, { name: 'Inbox' });
    const counts = (await read.viewCounts(pool, SU)).counts;
    expect(counts[v.id]).toBeUndefined();
    expect(counts[w.id]).toBe(1); // Inbox unread: 413 (402 is in the Inbox too, but mark-all on Sent just marked it)
  });

  test('identities + listSendable: SU every box; attorney only the granted one; the signature flag', async () => {
    const su = (await S.listIdentities(pool, SU)).identities;
    expect(su.map((i) => [i.id, i.sendable, i.reason, i.signature])).toEqual([
      [1, true, null, true], [4, false, 'no_send_credential', false], [3, false, 'unsupported_provider', false], [2, true, null, false],
    ]);
    expect((await mbx.listSendable(pool, SS)).map((r) => r.id)).toEqual([2]);
    expect((await mbx.listSendable(pool, READER))).toEqual([]);
  });

  test('S3.1/S3.2 on the engine: a send-only (ALIAS, S3-R) box is last in the From picker and carries its slice on the summary; an SU\'s grant row picks the alias for internal mail', async () => {
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, credential_id, from_name, signature_html, signature_text)
             VALUES (5, 'it@firm.test', '', 0, '', '', 0, 'gmail', 11, 'IT', NULL, NULL)`);
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, send_credential_id, ingest_enabled, ingest_folders, active, alias_of, alias_label)
             VALUES (5, 'it@firm.test', 'firm.test', 'imap.gmail.com', 'stuart@firm.test', NULL, 5, 0, '{"INBOX":{"emit_to_rules":true}}', 1, 2, 'IT')`);
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, gmail_labels, from_addr, to_addrs, subject, date, snippet, attachments, ingested_at)
             VALUES (420, 2, '[Gmail]/All Mail', 420, 'x420@mail.gmail.com', 'x420@mail.gmail.com', ?, 'Stuart <stuart@firm.test>', 'it@firm.test', 'Printer', '2026-10-01 12:00:00', 's', '[]', '2026-10-02 00:00:00')`, [JSON.stringify(['\\Sent', 'IT'])]);
    const ids = (await S.listIdentities(pool, SU)).identities;
    expect(ids.map((i) => [i.id, i.send_only])).toEqual([[1, false], [4, false], [3, false], [2, false], [5, true]]);
    // S3-R: the alias box IS on the summary, with its SLICE — row 420 is a
    // \Sent copy from stuart@ TO it@: the account's Sent, but INCOMING to
    // it@, so it counts in the alias's Inbox (its Sent is mail FROM it@).
    expect((await read.summary(pool, SU)).mailboxes.find((m) => m.id === 5))
      .toMatchObject({ alias_of: 2, inbox_total: 1, inbox_unread: 1 });
    let r = await S.replyDefaults(pool, SU, 420);                 // no grant rows: the bypass pick (From stuart@)
    expect([r.mailbox_id, r.to.map((a) => a.email)]).toEqual([2, ['it@firm.test']]);
    await q("INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES (?, 'mailbox', 5, 0, 1, 0, 6)", [SU]);
    r = await S.replyDefaults(pool, SU, 420);                     // a grant row on it@: who they are
    expect([r.mailbox_id, r.to.map((a) => a.email)]).toEqual([5, ['stuart@firm.test']]);
  });

  test('a send on the engine: the adapter\'s email_log row found, the seed job row, the budget count + ONE alert', async () => {
    mockSendMail.mockImplementation(async (o) => ({ messageId: o.messageId, response: '250 OK', accepted: [o.to], rejected: [] }));
    jest.spyOn(transport, 'appendSent').mockResolvedValue({ appended: true, folder: 'INBOX.Sent', uid: 3, reason: null });
    const out = await S.sendFromMailbox(pool, SENDER, 1, { to: ['c@x.test'], subject: 'Hi', body_text: 'Hello', in_reply_to_message_fk: 408 });
    const [log] = await q('SELECT id, source, message_id FROM email_log');
    expect(out.email_log_id).toBe(log.id);
    expect(log).toMatchObject({ source: 'outbound-smtp', message_id: `<${out.rfc_message_id}>` });
    const [job] = await q('SELECT type, status, max_attempts, backoff_seconds, data, scheduled_time > UTC_TIMESTAMP() + INTERVAL 5 MINUTE AS later FROM scheduled_jobs');
    expect(job).toMatchObject({ type: 'one_time', status: 'pending', max_attempts: 4, backoff_seconds: 300, later: 1 });
    expect(job.data).toMatchObject({ type: 'mail_sent_read_seed', user: SENDER, message_id: out.rfc_message_id });

    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('mail_send_daily_budget', '{\"smtp\": 2}')");
    await q("INSERT INTO email_log (source, message_id, from_email, processed_at) VALUES ('outbound-smtp', 'old-1', 'BILLING@firm.test', UTC_TIMESTAMP() - INTERVAL 30 HOUR)");
    await expect(S.sendFromMailbox(pool, SENDER, 1, { to: ['c@x.test'], subject: 'Hi', body_text: 'x' })).resolves.toBeTruthy(); // 1 recent + 1 old: under 2
    await expect(S.sendFromMailbox(pool, SENDER, 1, { to: ['c@x.test'], subject: 'Hi', body_text: 'x' })).rejects.toMatchObject({ status: 429 });
    await expect(S.sendFromMailbox(pool, SENDER, 1, { to: ['c@x.test'], subject: 'Hi', body_text: 'x' })).rejects.toMatchObject({ status: 429 });
    const alerts = await q("SELECT kind, severity FROM system_alerts WHERE kind = 'mailbox_send_budget'");
    expect(alerts).toEqual([{ kind: 'mailbox_send_budget', severity: 'error' }]);
  });

  test('the Gmail transport counts every alias of the Google account', async () => {
    const t = await S.transportOf(pool, (await q('SELECT * FROM email_credentials WHERE id = 2'))[0]);
    expect(t.key).toBe('gmail:11');
    expect(t.addresses.sort()).toEqual(['automations@firm.test', 'stuart@firm.test']);
  });

  test('the seed probes: Gmail id within a day of the send (an index probe, never a scan); Message-ID; final', async () => {
    await q("UPDATE mail_messages SET provider_id = 'abc1', date = '2026-10-11 14:00:05' WHERE id = 401");
    await q("UPDATE mail_messages SET provider_id = 'abc1', date = '2026-09-01 10:00:00' WHERE id = 402");
    const r = await S.seedSentReadState(pool, { user: SS, sent_at: '2026-10-11T14:00:00Z', provider_id: 'abc1', message_id: null });
    expect(r).toEqual({ seeded: 1, found: 1 });
    expect(await q('SELECT message_fk FROM mail_read_state WHERE user = ?', [SS])).toEqual([{ message_fk: 401 }]);
    const plan = await q('EXPLAIN SELECT id FROM mail_messages WHERE mailbox_id IN (?) AND date >= ? AND provider_id = ?', [[1, 2], new Date('2026-10-10T14:00:00Z'), 'abc1']);
    // both indexes serve it; which one is the optimizer's call (8.0.46 on this fixture: the date
    // range; production 8.4.6 on live rows: idx_mail_messages_mailbox_provider — reviewer EXPLAIN 2026-10-11)
    expect(['range', 'ref']).toContain(plan[0].type);
    expect(['idx_mail_messages_mailbox_date', 'idx_mail_messages_mailbox_provider']).toContain(plan[0].key);
    expect(await S.seedSentReadState(pool, { user: SENDER, sent_at: '2026-10-11T14:00:00Z', message_id: 'm408@x.test' })).toEqual({ seeded: 1, found: 1 });
    await expect(S.seedSentReadState(pool, { user: SENDER, sent_at: '2026-10-11T14:00:00Z', message_id: 'nope@x.test' })).rejects.toThrow(/not stored yet/);
    await expect(S.seedSentReadState(pool, { user: SENDER, message_id: 'nope@x.test' }, { final: true })).resolves.toMatchObject({ gave_up: true });
  });
});
