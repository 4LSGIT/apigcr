// tests/issueReportRespond.mysql.test.js
//
// Real-engine twin for Support Inbox replies (services/issueReportService.js
// respond() + POST /api/issue-reports/:id/respond) and the migration that adds
// their columns (scripts/supportReplyColumns.js). Builds issue_reports and
// users from ref/database.sql in its OWN *_test DB, runs the migration script's
// run() on it, then drives the real route over the real pool. Only the email
// send is stubbed (it is not the module under test).
//
// Never points at the dev machine's production proxy (127.0.0.1:3306):
//   YC_TEST_MYSQL_URL_SUPPORT=mysql://root@127.0.0.1:3379/yc_support_reply_test \
//     node node_modules/jest/bin/jest.js tests/issueReportRespond.mysql.test.js --runInBand
// The server needs prod parity: --default-time-zone=+00:00 and prod's relaxed
// sql_mode (CLAUDE.md "SQL mode is relaxed").
'use strict';

process.env.JWT_SECRET = 'support-reply-mysql-secret';
process.env.IT_EMAIL = 'it@4lsg.com';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn() }));

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const migration = require('../scripts/supportReplyColumns');

const URL_ = process.env.YC_TEST_MYSQL_URL_SUPPORT;
const d = URL_ ? describe : describe.skip;

/** CREATE TABLE … through its `) ENGINE=…;` line — line-based: COMMENTs hold ';'. */
function ddlOf(schema, table) {
  const lines = schema.split('\n');
  const start = lines.findIndex((l) => l.startsWith('CREATE TABLE `' + table + '` ('));
  if (start < 0) throw new Error('no CREATE TABLE for ' + table);
  const end = lines.findIndex((l, i) => i > start && /^\) ENGINE=.*;$/.test(l));
  return lines.slice(start, end + 1).join('\n');
}

d('Support Inbox replies on real MySQL', () => {
  let pool, conn, server, base;
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const su = jwt.sign({ sub: 6, username: 'IT', user_type: 1, aud: 'staff', user_auth: 'authorized', roles: ['su'] },
    process.env.JWT_SECRET, { expiresIn: '1h' });

  async function respond(id, body) {
    const res = await fetch(`${base}/api/issue-reports/${id}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + su },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  const row = async (id) => (await q('SELECT * FROM issue_reports WHERE id = ?', [id]))[0];
  async function file(kind, { userId = 5, resolved = false } = {}) {
    const r = await q(
      `INSERT INTO issue_reports (user_id, user_name, kind, note, resolved_at, resolved_by)
       VALUES (?, 'Shoshana', ?, 'the export button\ndoes nothing', ?, ?)`,
      [userId, kind, resolved ? new Date('2026-11-01T10:00:00Z') : null, resolved ? 'Stuart' : null]);
    return r.insertId;
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1)) || !['127.0.0.1', 'localhost'].includes(u.hostname)
        || !u.port || u.port === '3306') throw new Error('Use a disposable local *_test DB on a non-production port');
    const admin = await mysql.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username || 'root'),
      password: decodeURIComponent(u.password || '') });
    await admin.query('CREATE DATABASE IF NOT EXISTS `' + u.pathname.slice(1) + '`');
    await admin.end();

    pool = mysql.createPool({ uri: URL_, connectionLimit: 3, timezone: 'Z' });
    const [[mode]] = await pool.query('SELECT @@SESSION.sql_mode AS m, @@SESSION.time_zone AS tz');
    expect(mode.m).not.toMatch(/STRICT_TRANS_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
    expect(mode.tz).toBe('+00:00');

    const schema = fs.readFileSync(path.join(__dirname, '../ref/database.sql'), 'utf8');
    for (const t of ['issue_reports', 'users']) await q('DROP TABLE IF EXISTS `' + t + '`');
    const ir = ddlOf(schema, 'issue_reports');
    const idCol = '`id` bigint NOT NULL,';
    expect(ir.split(idCol)).toHaveLength(2);
    // The live table predates the migration (ref/database.sql regenerates after
    // it runs): strip the five columns if this dump already carries them, so
    // the script always has work to do here.
    const pre = ir.replace(idCol, '`id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,')
      .split('\n').filter((l) => !/^\s*`(resolution|reply_message|replied_at|reply_error|reply_claimed_at)`/.test(l)).join('\n');
    await q(pre);
    await q(ddlOf(schema, 'users'));
    // jwtOrApiKey's fire-and-forget audit insert lands here instead of logging a miss
    await q('DROP TABLE IF EXISTS `jwt_api_audit_log`');
    const audit = ddlOf(schema, 'jwt_api_audit_log');
    expect(audit.split(idCol)).toHaveLength(2);
    await q(audit.replace(idCol, '`id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,'));
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, email)
             VALUES (5, 'sb', 'Shoshana', 'Shoshana', 'Beitner', 'shoshana@example.test'),
                    (7, 'nomail', 'Nomail', 'No', 'Mail', NULL)`);

    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.issueReports'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => {
    // Bounded teardown: a request still open (a test that failed mid-way under a
    // mutation) must not hold server.close() forever.
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (conn) await conn.end();
    if (pool) await pool.end();
  });
  beforeEach(() => { emailService.sendEmail.mockReset(); emailService.sendEmail.mockResolvedValue({ ok: true }); });

  // Runs first: every later test needs the columns.
  test('migration: CHECK writes nothing, --apply adds the five columns, a rerun is a no-op', async () => {
    const id = await file('problem');
    const logs = [];
    const log = (s) => logs.push(s);
    expect(await migration.run(conn, { apply: false, log })).toEqual({ ok: true });
    expect(logs.join('\n')).toMatch(/GO — CHECK passed, nothing written/);
    const cols = async () => (await q(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'issue_reports' ORDER BY ORDINAL_POSITION`)).map((r) => r.c);
    expect(await cols()).not.toContain('resolution');

    logs.length = 0;
    expect(await migration.run(conn, { apply: true, log })).toEqual({ ok: true });
    expect(logs.join('\n')).toMatch(/GO — columns live, every row NULL/);
    const after = await cols();
    const at = after.indexOf('resolved_by');
    expect(after.slice(at, at + 6)).toEqual(['resolved_by', 'resolution', 'reply_message', 'replied_at', 'reply_error', 'reply_claimed_at']);
    expect(await row(id)).toMatchObject({ resolution: null, reply_message: null, replied_at: null, reply_error: null, reply_claimed_at: null });

    logs.length = 0;
    expect(await migration.run(conn, { apply: true, log })).toEqual({ ok: true });
    expect(logs.join('\n')).toMatch(/GO — nothing left to do/);
  });

  test('migration resumes: with only some columns present, --apply adds just the rest', async () => {
    await q('ALTER TABLE issue_reports DROP COLUMN replied_at, DROP COLUMN reply_error');
    const logs = [];
    expect(await migration.run(conn, { apply: true, log: (s) => logs.push(s) })).toEqual({ ok: true });
    expect(logs.join('\n')).toMatch(/✓ added replied_at, reply_error/);
  });

  test('migration refuses a column of the wrong shape', async () => {
    await q('ALTER TABLE issue_reports MODIFY reply_error varchar(100) NULL');
    await expect(migration.run(conn, { apply: true, log: () => {} })).rejects.toThrow(/reply_error exists with the wrong shape/);
    const c = migration.COLUMNS.find((x) => x.name === 'reply_error');
    await q(`ALTER TABLE issue_reports MODIFY reply_error varchar(255) NULL COMMENT ?`, [c.comment]);
    expect(await migration.run(conn, { apply: false, log: () => {} })).toEqual({ ok: true });
  });

  test('reply + resolve on an open report: one email from IT to the filer, row stamped, resolved by the admin', async () => {
    const id = await file('problem');
    const r = await respond(id, { outcome: 'fixed', message: '  It was the date filter.  ', resolve: true });
    expect(r).toEqual({ status: 200, body: { ok: true, resolved: true, to: 'shoshana@example.test' } });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [, mail] = emailService.sendEmail.mock.calls[0];
    expect(mail).toMatchObject({ from: 'it@4lsg.com', to: 'shoshana@example.test', subject: `Re: your problem report #${id} — Fixed` });
    expect(mail.text).toMatch(/^Hi Shoshana,\n\nThanks for reporting this — it's fixed\./);
    expect(mail.text).toContain('It was the date filter.\n');
    expect(mail.text).toContain('> the export button\n> does nothing');
    const got = await row(id);
    expect(got).toMatchObject({ resolution: 'fixed', reply_message: 'It was the date filter.', reply_error: null, reply_claimed_at: null, resolved_by: 'IT' });
    expect(got.replied_at).toBeInstanceOf(Date);
    expect(got.resolved_at).toBeInstanceOf(Date);
    expect(Math.abs(got.resolved_at - Date.now())).toBeLessThan(60_000);   // UTC NOW() vs the JS clock
  });

  test('a second reply within the debounce window is refused and sends nothing; after it, a follow-up goes out', async () => {
    const id = await file('idea');
    expect((await respond(id, { outcome: 'planned', resolve: false })).status).toBe(200);
    const again = await respond(id, { outcome: 'done', resolve: true });
    expect(again.status).toBe(409);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ resolution: 'planned', resolved_at: null });

    await q('UPDATE issue_reports SET replied_at = NOW() - INTERVAL 31 SECOND WHERE id = ?', [id]);
    expect((await respond(id, { outcome: 'done', resolve: true })).body).toMatchObject({ ok: true, resolved: true });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(2);
    expect(await row(id)).toMatchObject({ resolution: 'done', reply_message: null });
  });

  test('replying to an already-resolved report never moves who resolved it, or when', async () => {
    const id = await file('problem', { resolved: true });
    expect((await respond(id, { outcome: 'cant_reproduce', resolve: true })).body).toMatchObject({ ok: true, resolved: true });
    const got = await row(id);
    expect(got.resolved_by).toBe('Stuart');
    expect(got.resolved_at.toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });

  test('resolve:false leaves an open report open', async () => {
    const id = await file('question');
    expect((await respond(id, { outcome: 'answered', message: 'Use Ctrl+F.' })).body).toMatchObject({ ok: true, resolved: false });
    expect(await row(id)).toMatchObject({ resolution: 'answered', resolved_at: null, resolved_by: null });
  });

  /** A send that waits until the test lets it settle. Any left unsettled (a
   *  test that failed before releasing it) is failed in afterEach, so no
   *  request stays open into the next test or the teardown. */
  const held = [];
  function heldSend() {
    let settle;
    const p = new Promise((resolve, reject) => { settle = { ok: () => resolve({}), fail: (e) => reject(e) }; });
    emailService.sendEmail.mockImplementationOnce(() => p);
    held.push(settle);
    return settle;
  }
  afterEach(async () => {
    while (held.length) held.pop().fail(new Error('released by afterEach'));
    await new Promise((r) => setTimeout(r, 50));
  });
  const until = async (pred) => {
    for (let i = 0; i < 200; i++) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('timed out waiting');
  };

  test('a failed send writes only reply_error: a resolve asked for is not applied, the claim is released', async () => {
    const id = await file('problem');
    emailService.sendEmail.mockRejectedValue(new Error('Gmail said no'));
    const r = await respond(id, { outcome: 'fixed', resolve: true });
    expect(r).toEqual({ status: 200, body: { ok: false, resolved: false, reply_error: 'Gmail said no' } });
    expect(await row(id)).toMatchObject({ resolution: null, reply_message: null, replied_at: null,
      reply_error: 'Gmail said no', reply_claimed_at: null, resolved_at: null, resolved_by: null });
    // the retry is allowed at once, and clears the error
    emailService.sendEmail.mockResolvedValue({ ok: true });
    expect((await respond(id, { outcome: 'fixed', resolve: true })).body).toMatchObject({ ok: true, resolved: true });
    expect(await row(id)).toMatchObject({ resolution: 'fixed', reply_error: null, resolved_by: 'IT' });
  });

  test('a failed follow-up leaves the earlier reply that went out on record', async () => {
    const id = await file('problem');
    expect((await respond(id, { outcome: 'fixed', message: 'Monday', resolve: true })).body.ok).toBe(true);
    const first = await row(id);
    await q('UPDATE issue_reports SET replied_at = replied_at - INTERVAL 1 DAY, resolved_at = resolved_at - INTERVAL 1 DAY WHERE id = ?', [id]);
    const firstAt = (await row(id)).replied_at.toISOString();
    emailService.sendEmail.mockRejectedValue(new Error('timeout'));
    expect((await respond(id, { outcome: 'other', message: 'Tuesday' })).body).toEqual({ ok: false, resolved: true, reply_error: 'timeout' });
    const got = await row(id);
    expect(got).toMatchObject({ resolution: 'fixed', reply_message: 'Monday', reply_error: 'timeout', resolved_by: first.resolved_by });
    expect(got.replied_at.toISOString()).toBe(firstAt);
  });

  test('a failed send on an already-resolved report leaves it resolved', async () => {
    const id = await file('idea', { resolved: true });
    emailService.sendEmail.mockRejectedValue(new Error('timeout'));
    expect((await respond(id, { outcome: 'done', resolve: true })).body).toEqual({ ok: false, resolved: true, reply_error: 'timeout' });
    expect(await row(id)).toMatchObject({ resolved_by: 'Stuart', replied_at: null, reply_error: 'timeout' });
  });

  test('a resolve by someone else DURING a failing send is not undone', async () => {
    const id = await file('problem');
    const send = heldSend();
    const pending = respond(id, { outcome: 'fixed', resolve: true });
    await until(async () => emailService.sendEmail.mock.calls.length === 1);
    await q("UPDATE issue_reports SET resolved_at = NOW(), resolved_by = 'Stuart' WHERE id = ?", [id]);
    send.fail(new Error('timeout'));
    expect((await pending).body).toEqual({ ok: false, resolved: true, reply_error: 'timeout' });
    expect(await row(id)).toMatchObject({ resolved_by: 'Stuart', reply_error: 'timeout', reply_claimed_at: null });
  });

  test('a send in flight blocks a second one however long it takes; a stale claim is taken over, and the late settle writes nothing', async () => {
    const id = await file('problem');
    const slow = heldSend();
    const first = respond(id, { outcome: 'fixed', message: 'first', resolve: false });
    await until(async () => (await row(id)).reply_claimed_at != null);
    expect((await row(id)).replied_at).toBeNull();                    // nothing reads "sent" while in flight

    await q('UPDATE issue_reports SET reply_claimed_at = reply_claimed_at - INTERVAL 5 MINUTE WHERE id = ?', [id]);
    const blocked = await respond(id, { outcome: 'cant_reproduce', resolve: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/is being sent, or went out seconds ago/);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);

    await q('UPDATE issue_reports SET reply_claimed_at = reply_claimed_at - INTERVAL 11 MINUTE WHERE id = ?', [id]);   // 16 min: abandoned
    expect((await respond(id, { outcome: 'cant_reproduce', resolve: true })).body).toMatchObject({ ok: true, resolved: true });
    expect(await row(id)).toMatchObject({ resolution: 'cant_reproduce', reply_claimed_at: null, resolved_by: 'IT' });

    slow.ok();                                                         // the abandoned send finally returns
    expect((await first).body).toMatchObject({ ok: true });
    expect(await row(id)).toMatchObject({ resolution: 'cant_reproduce', reply_message: null, reply_claimed_at: null });
  });

  test('a late FAILURE of a taken-over send does not touch the reply that replaced it', async () => {
    const id = await file('idea');
    const slow = heldSend();
    const first = respond(id, { outcome: 'planned' });
    await until(async () => (await row(id)).reply_claimed_at != null);
    await q('UPDATE issue_reports SET reply_claimed_at = reply_claimed_at - INTERVAL 16 MINUTE WHERE id = ?', [id]);
    expect((await respond(id, { outcome: 'done', resolve: true })).body.ok).toBe(true);
    slow.fail(new Error('socket timeout'));
    expect((await first).body).toMatchObject({ ok: false });
    expect(await row(id)).toMatchObject({ resolution: 'done', reply_error: null, resolved_by: 'IT' });
  });

  test.each([
    ['an outcome of another kind', 'question', { outcome: 'fixed' }, 400, /outcome must be one of: answered/],
    ['a message-required outcome without one', 'question', { outcome: 'answered', message: '   ' }, 400, /"Answered" needs a message/],
    ['"Other" without a message', 'idea', { outcome: 'other' }, 400, /"Other" needs a message/],
    ['a message over the cap', 'problem', { outcome: 'fixed', message: 'x'.repeat(2001) }, 400, /over 2000 characters/],
  ])('refuses %s, writing and sending nothing', async (_n, kind, body, status, err) => {
    const id = await file(kind);
    const r = await respond(id, { resolve: true, ...body });
    expect(r.status).toBe(status);
    expect(r.body.error).toMatch(err);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ resolution: null, replied_at: null, resolved_at: null });
  });

  test('refuses a filer with no email (422) and a missing report (404)', async () => {
    const id = await file('problem', { userId: 7 });
    expect((await respond(id, { outcome: 'fixed', resolve: true })).status).toBe(422);
    expect((await respond(999999, { outcome: 'fixed' })).status).toBe(404);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ resolution: null, resolved_at: null });
  });

  test('GET /:id carries the kind\'s outcomes and the address a reply would go to', async () => {
    const id = await file('idea');
    const res = await fetch(`${base}/api/issue-reports/${id}`, { headers: { Authorization: 'Bearer ' + su } });
    const body = await res.json();
    expect(body.reply_to).toBe('shoshana@example.test');
    expect(body.outcomes.map((o) => o.key)).toEqual(['done', 'planned', 'already_done', 'wont_do', 'other']);
    expect(body.outcomes.find((o) => o.key === 'other')).toMatchObject({ needs_message: true, text: '' });
  });

  test('the list selects the reply columns', async () => {
    const res = await fetch(`${base}/api/issue-reports?status=all&limit=200`, { headers: { Authorization: 'Bearer ' + su } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(body.rows[0])).toEqual(expect.arrayContaining(['resolution', 'replied_at', 'reply_error']));
    expect(body.rows.some((r) => r.resolution === 'fixed' && r.replied_at)).toBe(true);
  });
});
