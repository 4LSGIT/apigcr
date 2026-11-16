// tests/mailboxSendExtras.mysql.test.js
//
/**
 * REAL-ENGINE TWIN of tests/mailboxSendExtras.send.test.js — the SQL the hub
 * send extras add (services/mailbox/mailboxScheduledSendService.SQL and the
 * documents SELECT in mailboxSendService.loadAttachments) on MySQL 8 with the
 * production schema (ref/database.sql, line-based) and sql_mode. The fake
 * world (tests/helpers/mailboxS3World.js) models this SQL; here the engine
 * answers.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_mailsend_test npx jest --runInBand tests/mailboxSendExtras.mysql.test.js
 * The database name must end in _test; the suite DROPS and recreates the
 * tables it touches (its own `_test` DB — twins that load the whole dump
 * cannot share one, CLAUDE.md).
 *
 * WHY A REAL ENGINE (CLAUDE.md: a service's SQL predicates and the row types
 * it reads). A fake cannot hold any of these:
 *   - `JSON_EXTRACT(data, '$.type') = ?` compares a JSON string to a bound
 *     string and `JSON_EXTRACT(data, '$.user') = ?` a JSON NUMBER to a bound
 *     INTEGER — and a bound STRING '8' matches nothing (the non-JSON side is
 *     converted to JSON before comparing), which is why the service binds
 *     Number(userId) and the world refuses a string;
 *   - the list's OR over status / updated_at and the 7-day window run against
 *     the engine's NOW() on a DATETIME column the engine itself bumps
 *     (ON UPDATE CURRENT_TIMESTAMP) — and EXPLAIN says what the predicate
 *     costs (a scan; accepted, the table is small);
 *   - the conditional cancel is ONE UPDATE whose affectedRows the engine
 *     decides (status = 'pending' + the two JSON predicates);
 *   - `JSON_SET(data, '$.outcome', CAST(? AS JSON))` stores an OBJECT, which
 *     mysql2 hands back parsed — a string value there would read back as a
 *     string and the pane would show "[object]"-style garbage;
 *   - the double-send fence is request_idempotency's UNIQUE key: the second
 *     claim is ER_DUP_ENTRY from the engine, the stale age is TIMESTAMPDIFF in
 *     SQL, and an applied `result` is a parsed JSON column.
 *
 * Worker run 2026-11-16: MySQL 8.4.11, prod sql_mode, UTC, all green.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-extras-mysql-secret';
process.env.EMAIL_DOMAINS = 'firm.test';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});

maybe('hub send extras on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const sched = require('../services/mailbox/mailboxScheduledSendService');
  const S = require('../services/mailbox/mailboxSendService');
  const { withIdempotency, SQL: IDEM } = require('../lib/requestIdempotency');
  const { SQL } = sched;

  const TABLES = ['scheduled_jobs', 'request_idempotency', 'users', 'documents', 'mailboxes', 'channel_grants', 'email_credentials', 'system_alerts', 'alert_state'];
  const SENDER = 8; const OTHER = 1;
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  /** A scheduled-send row as scheduleSend writes it (the same INSERT text). */
  async function job(user, over = {}) {
    const body = {
      mailbox_id: 1, to: [{ email: 'client@outside.test', name: null }], cc: [], bcc: [], subject: 'Hello', body_text: 'Hi', body_html: null,
      in_reply_to_message_fk: null, quote_original: true, signature: false, acknowledge_optout: false, case_id: null, attachments: [1, 2], ...over.body,
    };
    const data = { type: sched.JOB_TYPE, user, mailbox_id: 1, body, acknowledged_optout: false, requested_at: new Date().toISOString(), ...over.data };
    const r = await q(SQL.insert, [over.sendAt || new Date(Date.now() + 3600_000), `Mail scheduled send — user #${user} (mailbox #1)`, JSON.stringify(data), 1, 300]);
    return Number(r.insertId);
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await schema.build(pool, TABLES);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const t of TABLES) await q(`DELETE FROM ${t}`);
    const user = (id, roles) => q(
      `INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, roles, email)
       VALUES (?, ?, 1, ?, 'f', 'l', 'xx', 'authorized', 0, ?, ?)`, [id, 'u' + id, 'User ' + id, roles, `u${id}@firm.test`]);
    await user(SENDER, 'staff');
    await user(OTHER, 'staff,attorney');
    await q("INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, send_credential_id, active) VALUES (1, 'billing@firm.test', 'firm.test', 'h', 'u', NULL, NULL, 1)");
    await q(`INSERT INTO documents (id, source, external_id, name, size, status) VALUES
      (1, 'dropbox', 'id:AAA', 'One.pdf', 1048576, 'active'), (2, 'dropbox', 'id:BBB', 'Two.pdf', 2048, 'deleted'), (3, 'dropbox', 'id:CCC', 'Three.pdf', NULL, 'active')`);
  });
  afterEach(() => jest.restoreAllMocks());

  test('loadAttachments on the engine: the row types (size is a bigint → Number; status the enum), a deleted row and a NULL size refused', async () => {
    const rows = await S.loadAttachments(pool, [1]);
    expect(rows).toEqual([{ document_id: 1, source: 'dropbox', external_id: 'id:AAA', name: 'One.pdf', size: 1048576 }]);
    await expect(S.loadAttachments(pool, [1, 2])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/"Two\.pdf" has been deleted/) });
    await expect(S.loadAttachments(pool, [3])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/size of "Three\.pdf" is not known/) });
    await expect(S.loadAttachments(pool, [9])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/#9 is not a registered document/) });
  });

  test('the list predicates: a JSON number equals a bound INTEGER (a bound string matches nothing); another type and another user are out; the status / 7-day window; the plan is a scan (accepted)', async () => {
    const mine = await job(SENDER);
    await job(OTHER);
    await q(SQL.insert, [new Date(Date.now() + 60_000), 'seed', JSON.stringify({ type: 'mail_sent_read_seed', user: SENDER }), 4, 300]); // another type, same user
    const done = await job(SENDER); await q("UPDATE scheduled_jobs SET status = 'completed' WHERE id = ?", [done]);
    const old = await job(SENDER); await q("UPDATE scheduled_jobs SET status = 'failed', updated_at = NOW() - INTERVAL 8 DAY WHERE id = ?", [old]);
    const canc = await job(SENDER); await q("UPDATE scheduled_jobs SET status = 'cancelled', active = 0, updated_at = NOW() - INTERVAL 6 DAY WHERE id = ?", [canc]);
    const running = await job(SENDER); await q("UPDATE scheduled_jobs SET status = 'running', updated_at = NOW() - INTERVAL 9 DAY WHERE id = ?", [running]); // running is shown whatever its age

    const raw = await q(SQL.list, [sched.JOB_TYPE, SENDER, sched.HISTORY_DAYS]);
    expect(raw.map((r) => r.id)).toEqual([mine, done, canc, running]); // scheduled_time order (all +1h, so by id); `old` is out
    expect(typeof raw[0].data).toBe('object'); // mysql2 parses the JSON column
    expect(raw[0].data.user).toBe(SENDER);
    // the bound-type rule the service relies on: a STRING user id matches nothing
    expect(await q(SQL.list, [sched.JOB_TYPE, String(SENDER), sched.HISTORY_DAYS])).toEqual([]);
    // the service shapes it: mailbox address and document names resolved now, the deleted one marked
    const { scheduled } = await sched.listScheduled(pool, SENDER);
    expect(scheduled.map((s) => [s.id, s.status])).toEqual([[mine, 'pending'], [done, 'completed'], [canc, 'cancelled'], [running, 'running']]);
    expect(scheduled[0]).toMatchObject({
      mailbox: { id: 1, address: 'billing@firm.test' }, subject: 'Hello', to: [{ email: 'client@outside.test', name: null }],
      attachments: [{ document_id: 1, name: 'One.pdf', status: 'active' }, { document_id: 2, name: 'Two.pdf', status: 'deleted' }],
    });
    expect(scheduled[0].send_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await sched.listScheduled(pool, OTHER)).scheduled.map((s) => s.id)).toHaveLength(1);
    expect((await sched.listScheduled(pool, 6)).scheduled).toEqual([]);
    // the plan: no index serves a JSON predicate under an OR — a scan of a small table, said so in the service
    const plan = await q(`EXPLAIN ${SQL.list}`, [sched.JOB_TYPE, SENDER, sched.HISTORY_DAYS]);
    expect(plan).toHaveLength(1);
    expect(plan[0].table).toBe('scheduled_jobs');
    expect(['ALL', 'index']).toContain(plan[0].type);
  });

  test('cancel is ONE conditional UPDATE: pending + mine → 1 row (cancelled, active 0); then 409; another user\'s → 404; a running one → 409 with its text', async () => {
    const mine = await job(SENDER);
    const theirs = await job(OTHER);
    expect(await sched.cancelScheduled(pool, SENDER, mine)).toEqual({ id: mine, status: 'cancelled' });
    expect(await q('SELECT status, active FROM scheduled_jobs WHERE id = ?', [mine])).toEqual([{ status: 'cancelled', active: 0 }]);
    await expect(sched.cancelScheduled(pool, SENDER, mine)).rejects.toMatchObject({ status: 409, code: 'already_cancelled' });
    await expect(sched.cancelScheduled(pool, SENDER, theirs)).rejects.toMatchObject({ status: 404 });
    // a one_time row of ANOTHER type, the same user: not a scheduled send → 404, untouched
    const seed = Number((await q(SQL.insert, [new Date(Date.now() + 60_000), 'seed', JSON.stringify({ type: 'mail_sent_read_seed', user: SENDER }), 4, 300])).insertId);
    await expect(sched.cancelScheduled(pool, SENDER, seed)).rejects.toMatchObject({ status: 404 });
    expect(await q('SELECT status FROM scheduled_jobs WHERE id = ?', [seed])).toEqual([{ status: 'pending' }]);
    expect(await q('SELECT status FROM scheduled_jobs WHERE id = ?', [theirs])).toEqual([{ status: 'pending' }]);
    const running = await job(SENDER); await q("UPDATE scheduled_jobs SET status = 'running' WHERE id = ?", [running]);
    await expect(sched.cancelScheduled(pool, SENDER, running)).rejects.toMatchObject({ status: 409, code: 'already_running', message: expect.stringMatching(/may already have gone/) });
    // the UPDATE never touches a row whose user is a different JSON number
    const r = await q(SQL.cancel, [theirs, sched.JOB_TYPE, SENDER]);
    expect(r.affectedRows).toBe(0);
  });

  test('the fence on the real UNIQUE key: a stale in_flight claim stops the run (outcome unknown, JSON_SET stores an OBJECT, ONE alert row); an applied claim replays; a fresh run claims and a 4xx releases', async () => {
    const id = await job(SENDER);
    const row = () => q('SELECT status, data FROM scheduled_jobs WHERE id = ?', [id]).then((r) => r[0]);
    // the instance died mid-send 200 s ago: the claim sits in_flight past IN_FLIGHT_STALE_SECONDS
    await q(IDEM.claim, [SENDER, 'mail.send', `scheduled:${id}`]);
    await q('UPDATE request_idempotency SET updated_at = NOW() - INTERVAL 200 SECOND WHERE idem_key = ?', [`scheduled:${id}`]);
    await expect(sched.runScheduledSend(pool, { id, data: (await row()).data, scheduled_time: new Date() })).rejects.toMatchObject({ idempotency: { outcome: 'unknown' } });
    let r = await row();
    expect(typeof r.data.outcome).toBe('object');
    expect(r.data.outcome).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    expect(r.data.body.subject).toBe('Hello'); // JSON_SET added a key; the rest is untouched
    expect(await q("SELECT kind, severity, dedup_key, ref_id FROM system_alerts")).toEqual([{ kind: 'mail_scheduled_send_failed', severity: 'error', dedup_key: `mail_scheduled_send_failed:${id}`, ref_id: id }]);
    // again: still stopped, the alert row deduped by the UNIQUE dedup_key (INSERT IGNORE)
    await expect(sched.runScheduledSend(pool, { id, data: (await row()).data, scheduled_time: new Date() })).rejects.toMatchObject({ idempotency: { outcome: 'unknown' } });
    expect(await q('SELECT COUNT(*) AS n FROM system_alerts')).toEqual([{ n: 1 }]);
    expect(mockSendMail).not.toHaveBeenCalled(); // no mailbox dispatch (and no notice credential here)

    // an applied claim (died between settle and the completed-mark): replayed, parsed from the JSON column
    const id2 = await job(SENDER);
    await q(IDEM.claim, [SENDER, 'mail.send', `scheduled:${id2}`]);
    await q(IDEM.settle, [JSON.stringify({ send_row_id: 77, email_log_id: 5, provider_message_id: 'abc' }), (await q('SELECT id FROM request_idempotency WHERE idem_key = ?', [`scheduled:${id2}`]))[0].id]);
    const out = await sched.runScheduledSend(pool, { id: id2, data: (await q('SELECT data FROM scheduled_jobs WHERE id = ?', [id2]))[0].data, scheduled_time: new Date() });
    expect(out).toMatchObject({ state: 'sent', replayed: true, send_row_id: 77, email_log_id: 5, provider_message_id: 'abc' });
    expect((await q('SELECT data FROM scheduled_jobs WHERE id = ?', [id2]))[0].data.outcome).toMatchObject({ state: 'sent', replayed: true, send_row_id: 77 });

    // a fresh run: the claim is taken on the engine, the send is refused before dispatch (no grant on
    // the box → 404) and the claim is RELEASED — the key never blocks a key that sent nothing
    const id3 = await job(SENDER);
    await expect(sched.runScheduledSend(pool, { id: id3, data: (await q('SELECT data FROM scheduled_jobs WHERE id = ?', [id3]))[0].data, scheduled_time: new Date() })).rejects.toMatchObject({ status: 404 });
    expect(await q('SELECT COUNT(*) AS n FROM request_idempotency WHERE idem_key = ?', [`scheduled:${id3}`])).toEqual([{ n: 0 }]);
    expect((await q('SELECT data FROM scheduled_jobs WHERE id = ?', [id3]))[0].data.outcome).toMatchObject({ state: 'failed', status: 404 });

    // the UNIQUE key itself: two claims for one job id — the second is the engine's ER_DUP_ENTRY → in_flight
    await q(IDEM.claim, [SENDER, 'mail.send', 'scheduled:999']);
    await expect(withIdempotency(pool, { userId: SENDER, scope: 'mail.send', key: 'scheduled:999' }, async () => 'never'))
      .rejects.toMatchObject({ idempotency: { outcome: 'in_flight' } });
    await expect(q(IDEM.claim, [SENDER, 'mail.send', 'scheduled:999'])).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });
});
