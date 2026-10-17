/**
 * REAL-ENGINE TWIN of the mailbox S2P suites: every statement the slice adds,
 * on MySQL 8.4 with the production schema and sql_mode —
 *   A  the batched log-status lookups: the store-wide twin fetch, the
 *      executions fetch (case-blind key matching on the general_ci column,
 *      and the plan: range on idx_message_id, never a scan), the config
 *      fetch — run through the service end to end;
 *   B  the merged list's KEYSET WALK with copies at page boundaries — every
 *      email exactly once over a full walk (the §B non-negotiable), the
 *      cursor from the last RAW row; inbox_unread_distinct;
 *   F  the mail_sends migration file applied from disk, TWICE (idempotent:
 *      one CREATE TABLE IF NOT EXISTS; the backfill INSERT…SELECT guarded by
 *      NOT EXISTS), the backfill against seeded admin_audit_log + email_log
 *      rows, and the sent_by join;
 *   G  linkSentCase's success path on the engine: probe → caseLink as the
 *      sender (the store-only grace honoured) → case_log_id stamped.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test, loaded with ref/database.sql
 * (the S2P migration is applied BY THIS SUITE, from the file — that is part
 * of what it proves). Timezone tables must be loaded (logService uses named
 * zones): mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql mysql.
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3318/yc_s2p_test npx jest tests/mailboxS2P.mysql.test.js
 * Worker run 2026-10-13: MySQL 8.4.11, all green.
 *
 * Mutation-checked HERE (the fake world only matches statement TEXT):
 *   - the executions key set matched case-SENSITIVELY in JS but blind on the
 *     engine (general_ci) — the mixed-case key test
 *   - idx_message_id dropped from the executions fetch → the plan test
 *   - the walk cursor from the merged page (emails dropped at boundaries) →
 *     the full-walk test
 *   - DISTINCT dropped from inbox_unread_distinct → the distinct test
 *   - the backfill INSERT without its NOT EXISTS guard → the idempotency test
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2p-mysql-secret';
process.env.EMAIL_DOMAINS = 'firm.test';

const fs = require('fs');
const path = require('path');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('mailbox S2P on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const read = require('../services/mailbox/mailReadService');
  const S = require('../services/mailbox/mailboxSendService');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const SU = 6; const READER = 5; const SENDER = 8;

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4, multipleStatements: true,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    // The migration file, from disk, twice — CREATE + backfill are idempotent.
    const migration = fs.readFileSync(path.join(__dirname, '..', 'ref/migrations/2026-10-13_mail_sends.sql'), 'utf8');
    await q(migration);
    await q(migration);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  async function seedDb() {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'inbox_views',
      'email_ingest_executions', 'log', 'mail_sends', 'admin_audit_log', 'email_log', 'system_alerts', 'alert_state']) {
      await q(`DELETE FROM ${t}`);
    }
    await q('DELETE FROM users WHERE user IN (?)', [[READER, SU, SENDER]]);
    await q('DELETE FROM cases WHERE case_id IN (?)', [['CaseA1', 'CaseB2']]);
    const user = (id, auth, roles) => q(
      `INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, roles)
       VALUES (?, ?, 1, ?, 'f', 'l', 'xx', ?, 0, ?)`, [id, 'u' + id, 'User ' + id, auth, roles]);
    await user(READER, 'authorized', 'staff');
    await user(SU, 'authorized', 'it,admin,form_dev,su');
    await user(SENDER, 'authorized', 'staff');
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_stage, case_status)
             VALUES ('CaseA1', '26-11111', '26-11111-tjt', 'BK', 'Open', 'New'), ('CaseB2', '26-22222', NULL, 'BK', 'Open', 'New')`);
    // Box 1 emits INBOX (cursor 1000); box 2 polls All Mail; box 3 unreadable.
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, ingest_folders, ingest_state, active) VALUES
      (1, 'billing@firm.test', 'firm.test', 'h', 'u', 'ENCv1:x', '{"INBOX":{"emit_to_rules":true},"INBOX.Sent":{"emit_to_rules":false}}', '{"INBOX":{"uidvalidity":1,"last_uid":1000}}', 1),
      (2, 'stuart@firm.test', 'firm.test', 'h', 'u', 'ENCv1:y', '{"[Gmail]/All Mail":{"emit_to_rules":true,"backfill":false}}', '{"[Gmail]/All Mail":{"uidvalidity":12,"last_uid":5000}}', 1),
      (3, 'private@firm.test', 'firm.test', 'h', 'u', 'ENCv1:z', NULL, NULL, 1)`);
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES
      (?, 'mailbox', 1, 1, 0, 0, 6), (?, 'mailbox', 2, 1, 0, 0, 6), (?, 'mailbox', 1, 1, 1, 0, 6)`, [READER, READER, SENDER]);
  }

  let msgId = 0;
  async function msg(over = {}) {
    const m = {
      id: ++msgId + 1000, mailbox_id: 1, folder: 'INBOX', uid: null, message_id: null, provider_id: null,
      gmail_labels: null, in_reply_to: null, thread_key: null, from_addr: 'Jane <jane@client.test>',
      to_addrs: 'billing@firm.test', cc_addrs: null, subject: 's', date: new Date('2026-10-08T12:00:00Z'),
      snippet: 'snip', body_text: 't', body_html: null, attachments: '[]', log_id: null,
      ingested_at: new Date('2026-10-08T12:00:00Z'), ...over,
    };
    if (m.uid == null) m.uid = m.id;
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, provider_id, gmail_labels, in_reply_to, thread_key,
      from_addr, to_addrs, cc_addrs, subject, date, snippet, body_text, body_html, attachments, log_id, ingested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.id, m.mailbox_id, m.folder, m.uid, m.message_id, m.provider_id, m.gmail_labels, m.in_reply_to, m.thread_key,
        m.from_addr, m.to_addrs, m.cc_addrs, m.subject, m.date, m.snippet, m.body_text, m.body_html, m.attachments, m.log_id, m.ingested_at]);
    return m.id;
  }
  const logRow = async (about = null) => (await q(
    `INSERT INTO log (log_type, log_date, log_link, log_link_type, log_link_id, log_about_type, log_about_id, log_by, log_data, log_direction, log_message)
     VALUES ('email', NOW(), '', 'email', 'x@y.test', ?, ?, 0, '{}', 'incoming', '')`, [about ? 'case' : null, about])).insertId;

  beforeEach(seedDb);
  afterEach(() => jest.restoreAllMocks());

  // ───────────────────────────────────────────────────────────────────────────
  test('A: resolution on the engine — stamped / copy / source bridges, pending, verdicts, history / store_only', async () => {
    const lgCase = await logRow('CaseA1');
    const lgPlain = await logRow();
    const stamped = await msg({ uid: 1, log_id: lgCase });
    const copyLo = await msg({ uid: 2, message_id: 'shared@x.test' });
    await msg({ mailbox_id: 3, folder: 'Stuff', uid: 3, message_id: 'SHARED@X.TEST', log_id: lgPlain }); // unreadable box; case-blind mid
    const viaSrc = await msg({ mailbox_id: 2, folder: '[Gmail]/All Mail', uid: 10, provider_id: '1A2B3C', message_id: 'g@x.test' });
    await q("INSERT INTO email_ingest_executions (source_id, message_id, status, log_id) VALUES (NULL, '1a2b3c', 'logged', ?)", [lgCase]);
    const pending = await msg({ uid: 2000 });
    const verdict = await msg({ uid: 4, message_id: 'ftf@x.test' });
    await q("INSERT INTO email_ingest_executions (source_id, message_id, status) VALUES (NULL, '<FTF@x.test>', 'skipped_firm_to_firm')");
    const history = await msg({ uid: 5 });
    const storeOnly = await msg({ folder: 'INBOX.Sent', uid: 6 });

    const one = async (id) => (await read.getMessage(pool, READER, id)).messages[0].log_status;
    expect(await one(stamped)).toMatchObject({ state: 'case', via: 'stamped', case: { case_id: 'CaseA1', case_number: '26-11111-tjt' } });
    expect(await one(copyLo)).toMatchObject({ state: 'logged', via: 'copy', log_id: lgPlain }); // bridged by the UNREADABLE box's stamp, key case-blind
    expect(await one(viaSrc)).toMatchObject({ state: 'case', via: 'source', log_id: lgCase }); // provider id, case-blind on general_ci
    expect(await one(pending)).toEqual({ state: 'pending' });
    expect(await one(verdict)).toEqual({ state: 'firm_to_firm' }); // the bracketed, case-blind RFC key
    expect(await one(history)).toEqual({ state: 'history' });
    expect(await one(storeOnly)).toEqual({ state: 'store_only' });
  });

  test('A: the executions fetch rides idx_message_id (range), never a scan', async () => {
    const [plan] = await pool.query(
      `EXPLAIN SELECT e.id FROM email_ingest_executions e LEFT JOIN log l ON l.log_id = e.log_id WHERE e.message_id IN (?, ?, ?)`,
      ['a@b.test', '<a@b.test>', '1a2b3c']
    );
    const e = plan.find((r) => r.table === 'e');
    expect(e.key).toBe('idx_message_id');
    expect(e.type).toBe('range');
  });

  test('B: the full keyset walk with copies at page boundaries — every email exactly once after the client fold', async () => {
    // 9 raw rows: 3 copy-pairs with IDENTICAL dates (ties cut mid-pair at
    // limit 2) + 3 singles, interleaved.
    const at = (m) => new Date(`2026-10-08T12:${String(m).padStart(2, '0')}:00Z`);
    const mk = async (mid, mbox, date) => msg({
      mailbox_id: mbox, folder: mbox === 2 ? '[Gmail]/All Mail' : 'INBOX',
      gmail_labels: mbox === 2 ? '["\\\\Inbox"]' : null, message_id: mid, date,
    });
    const raw = [];
    for (let i = 0; i < 3; i++) {
      raw.push(await mk(`pair${i}@x.test`, 1, at(10 - i * 2)));
      raw.push(await mk(`pair${i}@x.test`, 2, at(10 - i * 2)));
      raw.push(await mk(`solo${i}@x.test`, 1, at(9 - i * 2)));
    }
    // walk at limit 2 — every cut lands inside or beside a pair
    const seenCopies = [];
    const seenEmails = new Map(); // mid → rows folded
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const out = await read.listMessages(pool, READER, { limit: 2, ...(cursor ? { cursor } : {}) });
      for (const m of out.messages) {
        for (const c of m.copies) seenCopies.push(c.id);
        const k = m.message_id.toLowerCase();
        seenEmails.set(k, (seenEmails.get(k) || 0) + m.copies.length);
      }
      cursor = out.next_cursor;
      if (!cursor) break;
    }
    expect(seenCopies.sort((a, b) => a - b)).toEqual(raw.slice().sort((a, b) => a - b)); // no row dropped, none doubled
    expect([...seenEmails.values()].sort()).toEqual([1, 1, 1, 2, 2, 2]); // pairs complete after folding
    expect(seenEmails.size).toBe(6);
  });

  test('B: inbox_unread_distinct is DISTINCT over the merge key; summary still one grouped count per box set', async () => {
    await msg({ uid: 21, message_id: 'twin@x.test' });
    await msg({ mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 22, message_id: 'TWIN@x.test' }); // case-blind merge key
    await msg({ uid: 23, message_id: null }); // a NULL mid counts as itself
    const out = await read.summary(pool, READER);
    expect(out.mailboxes.map((m) => [m.id, m.inbox_unread])).toEqual([[1, 2], [2, 1]]);
    expect(out.inbox_unread_distinct).toBe(2);
    expect(out.mailboxes[0].sync).toMatchObject({ stale: true });  // never checked
    expect(out.mailboxes[1].sync).toMatchObject({ stale: true });  // cursor has no checked_at
  });

  test('F: the migration backfill — seeded audit + email_log rows land once; a re-run inserts nothing; the sent_by join reads them', async () => {
    // two pre-S2P sends: one gmail (hex id in email_log.message_id), one smtp (bracketed RFC id)
    const el1 = (await q("INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, processed_at) VALUES ('outbound-gmail', '1a12ca005343b209', 'stuart@firm.test', 'x@y.test', 's', 'b', NOW())")).insertId;
    const el2 = (await q("INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, processed_at) VALUES ('outbound-smtp', '<abc-def@firm.test>', 'billing@firm.test', 'x@y.test', 's', 'b', NOW())")).insertId;
    const audit = (elid, mbox) => q(
      `INSERT INTO admin_audit_log (tool, user_id, username, route, method, status, details)
       VALUES ('mail_send', 6, 'IT', '/api/mail/send', 'POST', 'sent', ?)`,
      [JSON.stringify({ mailbox_id: mbox, email_log_id: elid, provider_message_id: 'x' })]);
    await audit(el1, 2);
    await audit(el2, 1);
    const migration = fs.readFileSync(path.join(__dirname, '..', 'ref/migrations/2026-10-13_mail_sends.sql'), 'utf8');
    await q(migration);
    const rows = await q('SELECT mailbox_id, user, message_id, provider_id, email_log_id FROM mail_sends ORDER BY email_log_id');
    expect(rows).toEqual([
      expect.objectContaining({ mailbox_id: 2, user: 6, message_id: null, provider_id: '1a12ca005343b209', email_log_id: el1 }),
      expect.objectContaining({ mailbox_id: 1, user: 6, message_id: 'abc-def@firm.test', provider_id: null, email_log_id: el2 }),
    ]);
    await q(migration); // idempotent: the NOT EXISTS guard holds
    expect((await q('SELECT COUNT(*) AS n FROM mail_sends'))[0].n).toBe(2);
    // the read side: a stored copy keyed either way carries sent_by
    const byMid = await msg({ folder: 'INBOX.Sent', uid: 51, message_id: 'abc-def@firm.test' });
    const byPid = await msg({ mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: '["\\\\Inbox"]', uid: 52, message_id: 'g9@x.test', provider_id: '1A12CA005343B209' });
    expect((await read.getMessage(pool, READER, byMid)).messages[0].sent_by).toEqual({ user: 6, name: 'User 6' });
    expect((await read.getMessage(pool, READER, byPid)).messages[0].sent_by).toEqual({ user: 6, name: 'User 6' });
  });

  test('G: linkSentCase on the engine — probe finds the copy, caseLink links it AS the sender, case_log_id stamped; the fresh-copy 409 retries', async () => {
    const copy = await msg({
      folder: 'INBOX.Sent', uid: 61, message_id: 'sent-copy@firm.test',
      from_addr: 'billing@firm.test', to_addrs: 'client@outside.test',
      date: new Date(Date.now() - 3600_000), ingested_at: new Date(Date.now() - 3600_000), // past the store-only grace
    });
    const sendId = (await q(
      "INSERT INTO mail_sends (mailbox_id, user, message_id, case_id, case_link_state) VALUES (1, ?, 'sent-copy@firm.test', 'CaseA1', 'pending')", [SENDER]
    )).insertId;
    const data = { send_id: sendId, user: SENDER, mailbox_id: 1, case_id: 'CaseA1', sent_at: new Date().toISOString(), provider_id: null, message_id: 'sent-copy@firm.test' };
    const out = await S.linkSentCase(pool, data, { final: false });
    expect(out).toMatchObject({ linked: true, message_fk: copy });
    const [row] = await q('SELECT case_link_state, case_log_id FROM mail_sends WHERE id = ?', [sendId]);
    expect(row.case_link_state).toBe('linked');
    const [lg] = await q('SELECT log_about_type, log_about_id, log_by FROM log WHERE log_id = ?', [row.case_log_id]);
    expect(lg).toEqual({ log_about_type: 'case', log_about_id: 'CaseA1', log_by: SENDER });
    expect((await q('SELECT log_id FROM mail_messages WHERE id = ?', [copy]))[0].log_id).toBe(row.case_log_id);
    // a copy stored MINUTES ago in a store-only folder: caseLink's grace answers 409 → the job retries
    await msg({ folder: 'INBOX.Sent', uid: 62, message_id: 'fresh@firm.test', from_addr: 'billing@firm.test',
      to_addrs: 'client@outside.test', date: new Date(), ingested_at: new Date() });
    const sendId2 = (await q(
      "INSERT INTO mail_sends (mailbox_id, user, message_id, case_id, case_link_state) VALUES (1, ?, 'fresh@firm.test', 'CaseA1', 'pending')", [SENDER]
    )).insertId;
    await expect(S.linkSentCase(pool, { ...data, send_id: sendId2, message_id: 'fresh@firm.test' }, { final: false }))
      .rejects.toMatchObject({ status: 409 });
    expect((await q('SELECT case_link_state FROM mail_sends WHERE id = ?', [sendId2]))[0].case_link_state).toBe('pending');
  });
});
