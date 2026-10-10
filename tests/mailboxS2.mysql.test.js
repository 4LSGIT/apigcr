/**
 * REAL-ENGINE TWIN of tests/mailboxS2.routes.test.js — the comms hub read API
 * (routes/api.mail.js → mailReadService → mailboxService / logService) over a
 * real MySQL 8 with the production schema. Mailbox-system arc, slice S2.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * CI has no MySQL; tests/mailboxS2.routes.test.js runs everywhere over the
 * stateful fake (tests/helpers/mailboxS2World.js). This suite proves the SQL
 * the fake models on the engine itself. One-time setup (a THROWAWAY database
 * whose name ends in _test — the suite deletes rows in the tables it uses):
 *
 *   mysql -uroot -e "CREATE DATABASE yc_s2_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_s2_test < ref/database.sql
 *   mysql -uroot yc_s2_test < ref/migrations/2026-10-09_mailbox_s2.sql   # until the dump carries mailboxes.color
 *   mysql -uroot yc_s2_test < ref/migrations/2026-10-09_mail_image_senders.sql   # …and mail_image_senders
 *   mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -uroot mysql      # CONVERT_TZ(…'EST5EDT')
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_s2_test npx jest tests/mailboxS2.mysql.test.js
 *
 * Every connection runs production's sql_mode (no STRICT, no ONLY_FULL_GROUP_BY,
 * no NO_BACKSLASH_ESCAPES, IGNORE_SPACE on) and the pool's timezone 'Z', like
 * startup/db.js. Worker run 2026-10-09: MySQL 8.0.46, all green.
 *
 * Add to client + filters (2026-10-10), mutation-checked HERE (the fake world
 * only matches their text): client_only keeping mailbox / firm addresses,
 * "Other" relations or ended rows, or checking 4 recipients; has_files without
 * the %40 form, with the NULL-cid three-valued bug, with JSON_TABLE columns on
 * the connection collation, or as an EXISTS (semi-join: lost walk + mark-all
 * marking nothing); the client candidates as `IN (…)` (a contact_emails scan
 * per row — the EXPLAIN test); first-seen without the REGEXP escape or bound.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s2-mysql-secret';
process.env.EMAIL_DOMAINS = 'firm.test';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('mailbox S2 on real MySQL', () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const mysql = require('mysql2/promise');

  let pool; let server; let base;
  const SU = 6; const SS = 1; const READER = 5; const NOBODY = 9;
  const tok = (user, user_auth = 'authorized') =>
    jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);

  async function call(method, url, { t, body } = {}) {
    const headers = { Authorization: `Bearer ${t}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const ids = (r) => r.json.messages.map((m) => m.id);
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.mail'));
    app.use(require('../routes/api.mailboxes'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  // One mail_messages row (hoisted so tests can add rows too).
  const msg = (id, mb, over = {}) => {
    const r = {
      folder: 'INBOX', uid: id, message_id: `m${id}@x.test`, thread_key: `m${id}@x.test`, from_addr: `Sender <s${id}@outside.test>`,
      to_addrs: 'billing@firm.test', subject: `Subject ${id}`, date: `2026-10-01 12:${String(id % 60).padStart(2, '0')}:00`,
      body_text: `text ${id}`, body_html: `<p>${id}</p>`,
      // stored a week back: outside the case-link store-only grace (review follow-up)
      ingested_at: '2026-10-02 00:00:00', ...over,
    };
    return q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, from_addr, to_addrs, subject, date, snippet, body_text, body_html, attachments, ingested_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 's', ?, ?, '[]', ?)`,
    [id, mb, r.folder, r.uid, r.message_id, r.thread_key, r.from_addr, r.to_addrs, r.subject, r.date, r.body_text, r.body_html, r.ingested_at]);
  };

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const t of ['mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'inbox_views', 'log', 'jwt_api_audit_log', 'email_ingest_executions', 'mail_image_senders']) {
      await q(`DELETE FROM ${t}`);
    }
    await q('DELETE FROM users WHERE user IN (1, 5, 6, 9)');
    await q("DELETE FROM cases WHERE case_id IN ('CaseA1', 'CaseB2')");
    const user = (id, auth, roles) => q(
      `INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, user_custom_tab, roles)
       VALUES (?, ?, 1, ?, 'f', 'l', 'xx', ?, 0, '{}', ?)`, [id, 'u' + id, 'User ' + id, auth, roles]);
    await user(SS, 'authorized', 'staff,attorney');
    await user(READER, 'authorized', 'staff');
    await user(SU, 'authorized - SU', 'it,admin,form_dev');
    await user(NOBODY, 'authorized', 'staff');
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, ingest_folders, ingest_state) VALUES
      (1, 'billing@firm.test', 'firm.test', 'h', 'u', '{"INBOX":{"emit_to_rules":true}}', '{"INBOX":{"uidvalidity":1,"last_uid":103}}'),
      (2, 'intake@firm.test', 'firm.test', 'h', 'u', '{"INBOX":{"emit_to_rules":false},"Sent":{"emit_to_rules":false}}', NULL)`);
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES (?, 'mailbox', 1, 1, 0, 0, 6)`, [READER]);
    await q("INSERT INTO cases (case_id, case_number, case_number_full) VALUES ('CaseA1', '26-11111', '26-11111-tjt'), ('CaseB2', '26-22222', NULL)");
    await msg(101, 1, { thread_key: 'root@x.test', message_id: 'root@x.test' });
    await msg(102, 1, { thread_key: 'root@x.test', message_id: 'reply@x.test' });
    await msg(103, 1, { subject: '50%_off sale', date: '2026-10-01 12:44:00' });
    await msg(104, 1, { subject: '50 percent off', date: '2026-10-01 12:44:00' }); // same second as 103
    await msg(105, 1, { date: null });
    await msg(201, 2, { thread_key: 'root@x.test', message_id: 'reply@x.test', date: '2026-10-01 12:42:00' }); // a copy of 102: same mail, same Date
    await msg(202, 2, { from_addr: 'Court <noreply@court.test>', subject: 'Court notice' });
    await msg(203, 2, { folder: 'Sent', from_addr: 'intake@firm.test' });
  });
  afterEach(() => jest.restoreAllMocks());

  test('grant matrix + attorney READ bypass', async () => {
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(SU) }))).toEqual([104, 103, 201, 102, 101, 202, 105]);
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(READER) }))).toEqual([104, 103, 102, 101, 105]);
    expect(ids(await call('GET', '/api/mail/messages', { t: tok(SS) }))).toEqual([104, 103, 201, 102, 101, 202, 105]);
    const none = await call('GET', '/api/mail/messages', { t: tok(NOBODY) });
    expect([none.status, none.json.messages]).toEqual([200, []]);
    expect((await call('GET', '/api/mail/messages/202', { t: tok(READER) })).status).toBe(404);
    expect((await call('PATCH', '/api/mailboxes/1', { t: tok(SS), body: { display_name: 'x' } })).status).toBe(403);
    const sum = await call('GET', '/api/mail/mailboxes', { t: tok(SS) });
    expect(sum.json.viewer).toEqual({ su: false, role: 'attorney' });
    expect(sum.json.mailboxes.map((m) => [m.id, m.inbox_total, m.inbox_unread])).toEqual([[1, 5, 5], [2, 2, 2]]);
  });

  test('keyset walk = the engine\'s own full ORDER BY, every row once (ties, NULL tail)', async () => {
    const ref = (await q("SELECT id FROM mail_messages WHERE folder = 'INBOX' ORDER BY date DESC, id DESC")).map((r) => r.id);
    const seen = [];
    let cursor = null;
    do {
      const r = await call('GET', `/api/mail/messages?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { t: tok(SU) });
      seen.push(...ids(r));
      cursor = r.json.next_cursor;
    } while (cursor);
    expect(seen).toEqual(ref);
  });

  test('LIKE: the escaped pattern matches the literal "50%_" only', async () => {
    expect(ids(await call('GET', `/api/mail/messages?q=${encodeURIComponent('50%_')}`, { t: tok(SU) }))).toEqual([103]);
    expect(ids(await call('GET', '/api/mail/messages?from_domain=court.test', { t: tok(SU) }))).toEqual([202]);
  });

  test('read state: idempotent single writes; bulk counts NEW rows only (mysql2 sets CLIENT_FOUND_ROWS)', async () => {
    await call('POST', '/api/mail/messages/101/read', { t: tok(READER) });
    await call('POST', '/api/mail/messages/101/read', { t: tok(READER) });
    expect(await q('SELECT message_fk FROM mail_read_state WHERE user = ?', [READER])).toEqual([{ message_fk: 101 }]);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { ids: [101, 102, 201] } })).json.marked).toBe(1);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true } })).json.marked).toBe(3);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true } })).json.marked).toBe(0);
    await call('DELETE', '/api/mail/messages/101/read', { t: tok(READER) });
    await call('DELETE', '/api/mail/messages/101/read', { t: tok(READER) });
    expect((await q('SELECT message_fk FROM mail_read_state WHERE user = ? ORDER BY message_fk', [READER])).map((r) => r.message_fk)).toEqual([102, 103, 104, 105]);
    expect(ids(await call('GET', '/api/mail/messages?unread_only=1', { t: tok(READER) }))).toEqual([101]);
  });

  test('views: owned rows only, one default', async () => {
    const a = (await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'A', mailbox_ids: [1], filters: { q: 'Subject 10' }, is_default: true } })).json.view;
    const b = (await call('POST', '/api/mail/views', { t: tok(READER), body: { name: 'B', is_default: true } })).json.view;
    expect((await q('SELECT id FROM inbox_views WHERE is_default = 1')).map((r) => r.id)).toEqual([b.id]);
    expect((await call('PATCH', `/api/mail/views/${a.id}`, { t: tok(SU), body: { name: 'stolen' } })).status).toBe(404);
    expect((await call('DELETE', `/api/mail/views/${a.id}`, { t: tok(SU) })).status).toBe(404);
    expect((await q('SELECT name FROM inbox_views WHERE id = ?', [a.id]))[0].name).toBe('A');
    expect(ids(await call('GET', `/api/mail/messages?view=${a.id}`, { t: tok(READER) }))).toEqual([102, 101, 105]);
  });

  test('threads merge readable copies; case link creates / reuses / refuses on the engine', async () => {
    const th = await call('GET', '/api/mail/threads/root%40x.test', { t: tok(SU) });
    expect(th.json.messages.map((m) => [m.id, m.copies.map((c) => c.id)])).toEqual([[101, [101]], [102, [102, 201]]]);

    // store-only box 2 → log row created, dated at the email's time in EST5EDT
    const r = await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(r.json).toMatchObject({ log_created: true, case: { case_id: 'CaseB2' } });
    const [log] = await q("SELECT log_type, DATE_FORMAT(log_date, '%Y-%m-%d %H:%i:%s') AS d, log_link_type, log_link_id, log_about_type, log_about_id, log_by, log_direction FROM log WHERE log_id = ?", [r.json.log_id]);
    expect(log).toEqual({ log_type: 'email', d: '2026-10-01 08:22:00', log_link_type: 'email', log_link_id: 'noreply@court.test', log_about_type: 'case', log_about_id: 'CaseB2', log_by: SU, log_direction: 'incoming' });
    expect((await q('SELECT log_id FROM mail_messages WHERE id = 202'))[0].log_id).toBe(r.json.log_id);

    // 102's copy 201 is logged now? link 201 first (store-only), then 102 reuses it
    const c1 = await call('POST', '/api/mail/messages/201/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } });
    const c2 = await call('POST', '/api/mail/messages/102/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } });
    expect(c2.json).toMatchObject({ log_id: c1.json.log_id, log_created: false });

    // box 1 INBOX emits and its cursor is at 103: 104 may still be emitted
    expect((await call('POST', '/api/mail/messages/104/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } })).status).toBe(409);
    expect((await q('SELECT log_id FROM mail_messages WHERE id = 104'))[0].log_id).toBeNull();

    const list = await call('GET', '/api/mail/messages?has_case=1', { t: tok(SU) });
    expect(ids(list)).toEqual([201, 102, 202]);
  });

  test('review follow-up on the engine: prior-log lookup, store-only grace, date clamp', async () => {
    const logRow = async () => (await q(
      "INSERT INTO log (log_type, log_date, log_link, log_link_type, log_link_id, log_by, log_data, log_message) VALUES ('email', NOW(), '', 'email', 'x@y.test', 0, '{}', '')"
    )).insertId;
    // gmail-firm logged 202 by Gmail id (the store keeps it as provider_id); case-blind (general_ci)
    const g = await logRow();
    await q("UPDATE mail_messages SET provider_id = '18c2f1a9b3d4e5f6' WHERE id = 202");
    await q("INSERT INTO email_ingest_executions (source_id, message_id, status, log_id) VALUES (NULL, '18C2F1A9B3D4E5F6', 'duplicate', NULL), (NULL, '18C2F1A9B3D4E5F6', 'logged', ?)", [g]);
    const a = await call('POST', '/api/mail/messages/202/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(a.json).toMatchObject({ log_id: g, log_created: false });
    expect(await q('SELECT log_about_type, log_about_id FROM log WHERE log_id = ?', [g])).toEqual([{ log_about_type: 'case', log_about_id: 'CaseB2' }]);
    expect((await q('SELECT COUNT(*) AS n FROM log'))[0].n).toBe(1);

    // a bracketed RFC id from another source; an execution pointing at a deleted log row is skipped
    const b = await logRow();
    await q("INSERT INTO email_ingest_executions (source_id, message_id, status, log_id) VALUES (NULL, 'm203@x.test', 'logged', 99999), (NULL, '<m203@x.test>', 'logged', ?)", [b]);
    expect((await call('POST', '/api/mail/messages/203/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } })).json).toMatchObject({ log_id: b, log_created: false });

    // store-only + stored a minute ago → 409 (fresh computed by the engine: ingested_at vs NOW())
    await msg(230, 2);
    await q('UPDATE mail_messages SET ingested_at = NOW() - INTERVAL 1 MINUTE WHERE id = 230');
    expect((await call('POST', '/api/mail/messages/230/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } })).status).toBe(409);
    expect((await q('SELECT log_id FROM mail_messages WHERE id = 230'))[0].log_id).toBeNull();
    await q('UPDATE mail_messages SET ingested_at = NOW() - INTERVAL 11 MINUTE WHERE id = 230');
    expect((await call('POST', '/api/mail/messages/230/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } })).json).toMatchObject({ log_created: true });

    // a future Date header is clamped to when the worker stored it (EST5EDT on the way in)
    await msg(231, 2, { date: '2099-01-01 00:00:00', ingested_at: '2026-10-02 03:04:05' });
    const c = await call('POST', '/api/mail/messages/231/case-link', { t: tok(SU), body: { case_id: 'CaseB2' } });
    expect(await q("SELECT DATE_FORMAT(log_date, '%Y-%m-%d %H:%i:%s') AS d FROM log WHERE log_id = ?", [c.json.log_id])).toEqual([{ d: '2026-10-01 23:04:05' }]);
  });

  test('review follow-up on the engine: filtered mark-all = the filtered list; newest thread window', async () => {
    // has_case on the engine (log + cases joins inside INSERT … SELECT … ON DUPLICATE KEY UPDATE)
    const l = await call('POST', '/api/mail/messages/101/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } });
    expect(l.status).toBe(200);
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { has_case: true } } })).json.marked).toBe(1);
    expect((await q('SELECT message_fk FROM mail_read_state WHERE user = ?', [READER])).map((r) => r.message_fk)).toEqual([101]);
    // q + unread_only, then the default INBOX scope vs all_folders on box 2
    expect((await call('POST', '/api/mail/read', { t: tok(READER), body: { all: true, filters: { q: '50%_', unread_only: true } } })).json.marked).toBe(1);
    expect((await q('SELECT message_fk FROM mail_read_state WHERE user = ? ORDER BY message_fk', [READER])).map((r) => r.message_fk)).toEqual([101, 103]);
    expect((await call('POST', '/api/mail/read', { t: tok(SU), body: { all: true, mailbox_ids: [2] } })).json.marked).toBe(2);
    expect((await call('POST', '/api/mail/read', { t: tok(SU), body: { all: true, mailbox_ids: [2], filters: { all_folders: true } } })).json.marked).toBe(1);

    const svc = require('../services/mailbox/mailReadService');
    const N = svc.THREAD_MAX + 3;
    const rows = [];
    for (let i = 0; i < N; i++) rows.push([5000 + i, 1, 'INBOX', 5000 + i, `t${i}@x.test`, 'long@x.test', new Date(Date.UTC(2026, 0, 1) + i * 60e3), '[]']);
    await q('INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, date, attachments) VALUES ?', [rows]);
    const th = await call('GET', '/api/mail/threads/long%40x.test', { t: tok(READER) });
    const got = th.json.messages.map((m) => m.id);
    expect([th.json.truncated, got.length, got[0], got[got.length - 1]]).toEqual([true, svc.THREAD_MAX, 5003, 5000 + N - 1]);
  });

  test('always-show-images senders on the engine: per user, case-blind unique key, IN lookup on every read', async () => {
    expect((await call('POST', '/api/mail/image-senders', { t: tok(READER), body: { address: 'S102@Outside.test' } })).status).toBe(201);
    expect((await call('POST', '/api/mail/image-senders', { t: tok(READER), body: { address: 's102@outside.test' } })).status).toBe(201); // ON DUPLICATE: no 2nd row
    expect(await q('SELECT user, address FROM mail_image_senders')).toEqual([{ user: READER, address: 's102@outside.test' }]);
    const t = await call('GET', '/api/mail/threads/root%40x.test', { t: tok(READER) });
    expect(t.json.messages.map((m) => [m.id, m.from_email, m.images_trusted])).toEqual([[101, 's101@outside.test', false], [102, 's102@outside.test', true]]);
    expect((await call('GET', '/api/mail/threads/root%40x.test', { t: tok(SU) })).json.messages.every((m) => !m.images_trusted)).toBe(true);
    expect((await call('DELETE', '/api/mail/image-senders/S102%40OUTSIDE.TEST', { t: tok(READER) })).json.removed).toBe(1);
  });

  test('related on the engine: active contact emails → client cases (Primary/Secondary), firm + mailbox addresses skipped', async () => {
    await q("DELETE FROM case_relate WHERE case_relate_client_id IN (9500, 9600)");
    await q('DELETE FROM contact_emails WHERE contact_id IN (9500, 9600)');
    await q('DELETE FROM contacts WHERE contact_id IN (9500, 9600)');
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_type, contact_name, contact_lfm_name, contact_rname, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone)
             VALUES (9500, 'person', 'Client', 'Doe, Jane', 'Doe, Jane', 'Jane Doe', 'Jane', '', 'Doe', '', ''),
                    (9600, 'person', 'Trustee', 'Trustee, Tom', 'Trustee, Tom', 'Tom Trustee', 'Tom', '', 'Trustee', '', '')`);
    await q(`INSERT INTO contact_emails (contact_id, email, end_date) VALUES (9500, 'jane@client.test', NULL), (9600, 't@trustee.test', NULL), (9600, 'old@trustee.test', '2025-01-01')`);
    await q("UPDATE cases SET case_stage = 'Filed', case_type = 'BK', case_open_date = '2026-01-01' WHERE case_id = 'CaseA1'");
    await q("UPDATE cases SET case_stage = 'Open', case_type = 'BK', case_open_date = '2026-05-01' WHERE case_id = 'CaseB2'");
    await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES ('CaseA1', 9500, 'Primary'), ('CaseB2', 9500, 'Secondary'), ('CaseB2', 9600, 'Other')`);
    await q("UPDATE mail_messages SET from_addr = 'Jane <JANE@client.test>', to_addrs = 'billing@firm.test, intake@firm.test', cc_addrs = 'Tom <t@trustee.test>, old@trustee.test' WHERE id = 101");
    try {
      const r = await call('GET', '/api/mail/messages/102/related', { t: tok(READER) });
      expect(r.json.contacts.map((c) => [c.contact_id, c.role, c.cases.map((x) => [x.case_id, x.case_stage, x.relation])])).toEqual([
        [9500, 'from', [['CaseB2', 'Open', 'Secondary'], ['CaseA1', 'Filed', 'Primary']]],
        [9600, 'to', []],
      ]);
    } finally {
      await q("DELETE FROM case_relate WHERE case_relate_client_id IN (9500, 9600)");
      await q('DELETE FROM contact_emails WHERE contact_id IN (9500, 9600)');
      await q('DELETE FROM contacts WHERE contact_id IN (9500, 9600)');
    }
  });

  test('inline vs attached on the engine: a Gmail-style PDF with a Content-ID counts; an image the body draws does not', async () => {
    await q(`UPDATE mail_messages SET body_html = '<p>x</p><img src="cid:ii_sig">',
      attachments = '[{"part":"2","filename":"Untitled.pdf","size":63118,"mime":"application/pdf","cid":"f_mv06z1bd0"},{"part":"3","filename":"sig.png","size":9,"mime":"image/png","cid":"ii_sig"}]'
      WHERE id = 103`);
    const r = await call('GET', '/api/mail/messages', { t: tok(READER) });
    expect(r.json.messages.find((m) => m.id === 103).attachment_count).toBe(1);
    expect(JSON.stringify(r.json)).not.toMatch(/ii_sig|cid:/);
    const t = await call('GET', '/api/mail/messages/103', { t: tok(READER) });
    expect(t.json.messages[0].attachments.map((a) => [a.filename, a.inline])).toEqual([['Untitled.pdf', false], ['sig.png', true]]);
  });

  test('client_only / has_files / no_case on the engine = the fake world, row for row (REGEXP_SUBSTR, the firm REGEXP, JSON_TABLE through mysql2)', async () => {
    const { makeWorld } = require('./helpers/mailboxS2World');
    const svc = require('../services/mailbox/mailReadService');
    const CIDS = [9700, 9701, 9702, 9703, 9704];
    const wipe = async () => {
      await q('DELETE FROM case_relate WHERE case_relate_client_id IN (?)', [CIDS]);
      await q('DELETE FROM contact_emails WHERE contact_id IN (?)', [CIDS]);
      await q('DELETE FROM contacts WHERE contact_id IN (?)', [CIDS]);
    };
    await wipe();
    const W = makeWorld();
    W.user(SU, { auth: 'authorized - SU' });
    W.mailbox(1, { address: 'billing@firm.test' });
    W.mailbox(2, { address: 'intake@firm.test' });
    W.mailbox(3, { address: 'shared@gmail.test' });
    await q("INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, ingest_folders) VALUES (3, 'shared@gmail.test', 'gmail.test', 'h', 'u', '{}')");
    const people = [ // [id, name, active emails, ended emails, [case, relation]]
      [9700, 'Jane', ['jane@client.test'], [], ['CaseA1', 'Primary']],
      [9701, 'Rick', ['rick@client.test'], [], ['CaseB2', 'Secondary']],
      [9702, 'Tom', ['t@trustee.test'], [], ['CaseA1', 'Other']],
      [9703, 'Old', [], ['old@client.test'], ['CaseA1', 'Primary']],
      [9704, 'Stuart', ['stuart@firm.test', 'stu@sub.firm.test', 'shared@gmail.test'], [], ['CaseB2', 'Primary']],
    ];
    W.caseRow('CaseA1', '26-11111'); W.caseRow('CaseB2', '26-22222');
    for (const [id, name, act, ended, [cs, rel]] of people) {
      await q(`INSERT INTO contacts (contact_id, contact_kind, contact_type, contact_name, contact_lfm_name, contact_rname, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone)
               VALUES (?, 'person', 'Client', ?, ?, ?, ?, '', 'X', '', '')`, [id, name, name, name, name]);
      for (const e of act) await q('INSERT INTO contact_emails (contact_id, email, end_date) VALUES (?, ?, NULL)', [id, e]);
      for (const e of ended) await q("INSERT INTO contact_emails (contact_id, email, end_date) VALUES (?, ?, '2025-01-01')", [id, e]);
      await q('INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, ?)', [cs, id, rel]);
      W.contact(id, name, act, { ended });
      W.relate(cs, id, rel);
    }
    const att = (l) => JSON.stringify(l);
    const rows = [ // id, box, from, to, cc, attachments, body_html
      [401, 1, 'Jane Doe <jane@client.test>', 'billing@firm.test', null, '[]', '<p>x</p>'],
      [402, 1, 'Stuart <stuart@firm.test>', '"Roe, Rick" <RICK@client.test>', null, att([{ part: '2', mime: 'application/pdf', cid: 'f_1' }, { part: '3', mime: 'image/png', cid: 'ii_sig' }]), '<img src="cid:ii_sig">'],
      [403, 1, 't@trustee.test', 'billing@firm.test', null, att([{ part: '2', mime: 'image/png', cid: 'ii_sig' }]), '<img src="cid:II_SIG">'],
      [404, 1, 'old@client.test', 'billing@firm.test', null, att([{ part: '2', mime: 'image/jpeg', cid: 'ii_photo' }]), '<p>attached</p>'],
      [405, 1, 'Stuart <stuart@firm.test>', 'billing@firm.test', 'stu@sub.firm.test', att([{ part: '2', mime: 'image/png', cid: 'image001.png@01DD' }]), '<img src="cid:image001.png%4001DD">'],
      [406, 1, 'v@vendor.test', 'a@v.test, b@v.test, "C, D" <c@v.test>, d@v.test', 'jane@client.test', att([{ part: '2', mime: 'image/png' }]), '<p>x</p>'],
      [407, 1, 'v@vendor.test', 'a@v.test, b@v.test, c@v.test, d@v.test, e@v.test', 'jane@client.test', att([{ part: '2', mime: 'image/png', cid: 'ii_x' }]), null],
      [408, 2, 'Shared <shared@gmail.test>', 'intake@firm.test', null, att([{ part: '2', mime: null, cid: 'ii_m' }]), '<img src="cid:ii_m">'],
      [409, 2, 'x@y.test', 'intake@firm.test', null, att([{ part: '2', mime: 'image/gif', cid: '<b@x>' }]), '<img src="cid:b@x">'],
      [410, 2, 'x@y.test', 'intake@firm.test', null, att([{ mime: 'application/pdf' }]), null],
      [412, 2, 'intake@firm.test', 'x@y.test', null, att([{ part: '2', mime: 'application/pdf' }]), null, 'Sent'], // a sent file: never "unread"
    ];
    for (const [id, mb, from, to, cc, a, html, folder = 'INBOX'] of rows) {
      await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, from_addr, to_addrs, cc_addrs, subject, date, attachments, body_html)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 's', ?, ?, ?)`, [id, mb, folder, id, `m${id}@x.test`, `m${id}@x.test`, from, to, cc, new Date(Date.UTC(2026, 9, 3) + id * 60e3), a, html]);
      W.message(id, { mailbox_id: mb, folder, from_addr: from, to_addrs: to, cc_addrs: cc, attachments: a, body_html: html, date: new Date(Date.UTC(2026, 9, 3) + id * 60e3) });
    }
    try {
      const mine = (r) => ids(r).filter((id) => id > 400);
      const world = async (f) => (await svc.listMessages(W.db, SU, f)).messages.map((m) => m.id);
      const client = mine(await call('GET', '/api/mail/messages?client_only=1', { t: tok(SU) }));
      expect(client).toEqual([406, 402, 401]);
      expect(await world({ client_only: 1 })).toEqual(client);
      // has_files on the engine = the list's own paperclip = the world
      const all = (await call('GET', '/api/mail/messages', { t: tok(SU) })).json.messages.filter((m) => m.id > 400);
      const clip = all.filter((m) => m.attachment_count > 0).map((m) => m.id);
      expect(clip).toEqual([408, 407, 406, 404, 402]);
      expect(mine(await call('GET', '/api/mail/messages?has_files=1', { t: tok(SU) }))).toEqual(clip);
      expect(await world({ has_files: 1 })).toEqual(clip);
      expect(mine(await call('GET', '/api/mail/messages?client_only=1&has_files=1', { t: tok(SU) }))).toEqual([406, 402]);
      // per-view unread counts on the engine (one COUNT per view through scopeWhere) = the view's unread list
      const mkView = async (body) => (await call('POST', '/api/mail/views', { t: tok(SU), body })).json.view.id;
      const vIds = [await mkView({ name: 'Clients', filters: { client_only: true } }), await mkView({ name: 'Files', filters: { has_files: true, all_folders: true } }),
        await mkView({ name: 'Box 2', mailbox_ids: [2], filters: { no_case: true } })];
      const counts = (await call('GET', '/api/mail/views/counts', { t: tok(SU) })).json.counts;
      for (const id of vIds) {
        const unread = (await call('GET', `/api/mail/messages?view=${id}&unread_only=1&all_folders=0&limit=100`, { t: tok(SU) })).json.messages.length;
        expect([id, counts[id]]).toEqual([id, unread]);
      }
      expect(counts[vIds[0]]).toBeGreaterThan(0);
      // the same predicates inside INSERT … SELECT (mark-all)
      expect((await call('POST', '/api/mail/read', { t: tok(SU), body: { all: true, filters: { client_only: true, has_files: true } } })).json.marked).toBe(2);
      // no_case: 401 linked to a case → gone from it
      expect((await call('POST', '/api/mail/messages/401/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } })).status).toBe(409); // INBOX emits, cursor 103
      await q("UPDATE mailboxes SET ingest_state = '{\"INBOX\":{\"uidvalidity\":1,\"last_uid\":999}}' WHERE id = 1");
      expect((await call('POST', '/api/mail/messages/401/case-link', { t: tok(SU), body: { case_id: 'CaseA1' } })).status).toBe(200);
      expect(mine(await call('GET', '/api/mail/messages?no_case=1&client_only=1', { t: tok(SU) }))).toEqual([406, 402]);
    } finally {
      await wipe();
    }
  });

  test('first-seen on the engine: LIKE + REGEXP pin the address, MIN(date) as a firm-local day, readable boxes only', async () => {
    await q("UPDATE mail_messages SET to_addrs = 'billing@firm.test, Jane <jane@client.test>', date = '2026-03-01 03:00:00' WHERE id = 101");
    await q("UPDATE mail_messages SET from_addr = 'mjane@client.test', date = '2025-01-01 12:00:00' WHERE id = 103");
    await q("UPDATE mail_messages SET to_addrs = 'jane@client.test.evil', date = '2025-01-02 12:00:00' WHERE id = 104");
    await q("UPDATE mail_messages SET cc_addrs = 'a@b.test,jane@client.test', date = '2026-01-05 15:00:00' WHERE id = 202");
    expect((await call('GET', '/api/mail/first-seen?address=jane%40client.test', { t: tok(READER) })).json.first_seen).toBe('2026-02-28');
    expect((await call('GET', '/api/mail/first-seen?address=jane%40client.test', { t: tok(SU) })).json.first_seen).toBe('2026-01-05');
    // a REGEXP metacharacter in the address is escaped: "+" is literal
    await q("UPDATE mail_messages SET from_addr = 'Jo <jo+1@client.test>', date = '2026-07-04 16:00:00' WHERE id = 105");
    expect((await call('GET', '/api/mail/first-seen?address=jo%2B1%40client.test', { t: tok(READER) })).json.first_seen).toBe('2026-07-04');
    expect((await call('GET', '/api/mail/first-seen?address=joo1%40client.test', { t: tok(READER) })).json.first_seen).toBeNull();
  });

  test('mailbox colour on the engine (ref/migrations/2026-10-09_mailbox_s2.sql applied): default on create, manager edit, every projection', async () => {
    const { mintElevationToken } = require('../lib/auth.superuser');
    const C = require('../public/js/mailboxColor');
    await q("UPDATE mailboxes SET color = '#2f6fd1' WHERE id = 1"); // box 2 stays NULL
    // POST without a colour: an unused palette colour (blue is taken) — the engine runs the used-colour SELECT
    const r = await fetch(`${base}/api/mailboxes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok(SU, 'authorized - SU')}`, 'X-SU-Elevation': mintElevationToken(SU), 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'new@firm.test', imap_host: 'imap.firm.test', imap_user: 'new' }),
    });
    expect(r.status).toBe(201);
    const created = (await r.json()).id;
    const [{ color }] = await q('SELECT color FROM mailboxes WHERE id = ?', [created]);
    expect(C.PALETTE).toContain(color);
    expect(color).not.toBe('#2f6fd1');
    // a can_manage holder edits it; the hub summary and GET /api/mailboxes carry it
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES (?, 'mailbox', 2, 1, 0, 1, 6)`, [NOBODY]);
    const p = await call('PATCH', '/api/mailboxes/2', { t: tok(NOBODY), body: { color: '#C2255C' } });
    expect([p.status, p.json.mailbox.color]).toEqual([200, '#c2255c']);
    const sum = await call('GET', '/api/mail/mailboxes', { t: tok(SS) });
    expect(sum.json.mailboxes.map((m) => [m.address, m.color])).toEqual([['billing@firm.test', '#2f6fd1'], ['intake@firm.test', '#c2255c'], ['new@firm.test', color]]);
    const pub = await call('GET', '/api/mailboxes', { t: tok(NOBODY) });
    expect(pub.json.mailboxes.map((m) => m.color)).toEqual(['#c2255c']);
  });

  test('the list walks idx_mail_messages_mailbox_date backwards with a LIMIT (no filesort per branch)', async () => {
    const rows = [];
    for (let i = 0; i < 4000; i++) {
      rows.push([10000 + i, 1 + (i % 2), i % 5 === 0 ? 'Sent' : 'INBOX', 10000 + i, `bulk${i}@x.test`, `bulk${i}@x.test`, 'a@b.test', 'x', `s${i}`,
        new Date(Date.UTC(2025, 0, 1) + i * 3600e3), '[]']);
    }
    await q('INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, from_addr, to_addrs, subject, date, attachments) VALUES ?', [rows]);
    await q('ANALYZE TABLE mail_messages');
    const captured = [];
    const spy = { query: (sql, p) => { captured.push([sql, p]); return pool.query(sql, p); }, getConnection: () => pool.getConnection() };
    await require('../services/mailbox/mailReadService').listMessages(spy, SU, { cursor: `${Date.UTC(2025, 3, 1)}.15000` });
    const [sql, p] = captured.find(([s]) => /UNION ALL/.test(s));
    const plan = (await q('EXPLAIN ' + sql, p)).filter((e) => e.table === 'm');
    expect(plan).toHaveLength(2);
    for (const e of plan) {
      expect(e.key).toBe('idx_mail_messages_mailbox_date');
      expect(e.Extra).toMatch(/Backward index scan/);
      expect(e.Extra).not.toMatch(/filesort/);
    }
    // …and still with the per-row subquery filters on (client / files / no case),
    // with contact_emails at production's size (~1k rows; the plan is cost-based)
    await q('DELETE FROM contacts WHERE contact_id = 9800000'); // cascades to its emails
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_type, contact_name, contact_lfm_name, contact_rname, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone)
             VALUES (9800000, 'person', 'Client', 'Bulk', 'Bulk', 'Bulk', 'B', '', 'X', '', '')`);
    await q('INSERT INTO contact_emails (contact_id, email) VALUES ?', [Array.from({ length: 1000 }, (_, i) => [9800000, `p${i}@people.test`])]);
    await q('ANALYZE TABLE contact_emails');
    captured.length = 0;
    await require('../services/mailbox/mailReadService').listMessages(spy, SU, { client_only: 1, has_files: 1, no_case: 1 });
    const [sql2, p2] = captured.find(([s]) => /UNION ALL/.test(s));
    const full2 = await q('EXPLAIN ' + sql2, p2);
    await q('DELETE FROM contacts WHERE contact_id = 9800000');
    // the client candidates probe contact_emails by index — never a scan per walked row
    const ce = full2.filter((e) => e.table === 'ce');
    expect(ce).toHaveLength(2);
    for (const e of ce) expect([e.type, e.key]).toEqual(['ref', 'idx_email_history']);
    const plan2 = full2.filter((e) => e.table === 'm');
    expect(plan2).toHaveLength(2);
    for (const e of plan2) {
      expect(e.key).toBe('idx_mail_messages_mailbox_date');
      expect(e.Extra).toMatch(/Backward index scan/);
      expect(e.Extra).not.toMatch(/filesort/);
    }
  });
});
