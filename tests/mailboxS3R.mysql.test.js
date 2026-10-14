/**
 * REAL-ENGINE TWIN of the S3-R alias-slice SQL (tests/mailboxS3R.read.test.js
 * runs the same rules over the fake world in CI): mailReadService's
 * ALIAS_WHERE / ALIAS_INBOX_WHERE, the alias list branch and its plan, the
 * scope disjunction (thread / bulk mark-read), the per-slice summary count,
 * the alias-parent read-state seed — on MySQL 8 with the production schema,
 * sql_mode and the S3-R migration applied. The slice edge matrix (S3R_MATRIX,
 * tests/helpers/mailboxS3World.js) is answered three ways — the engine, the
 * fake world, and sliceMatchJs (the JS twin loadVisible and the part route
 * apply) — and all three must agree.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test, loaded as
 * tests/mailboxS2.mysql.test.js describes PLUS this slice's migration:
 *   mysql -uroot yc_s3r_test < ref/migrations/2026-10-12_mailbox_s3r_alias.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_s3r_test npx jest tests/mailboxS3R.mysql.test.js
 * Worker run 2026-10-12: MySQL 8.0.46, all green (with the S2/S3 twins).
 *
 * Mutation-checked HERE (the worlds only match the statement texts, so the
 * SEMANTICS need the engine):
 *   - the label bound → inlined in the SQL text (a backslashed system label
 *     would be eaten); label compare case-blinded            → the matrix (505, 510)
 *   - the address REGEXP's pins dropped ((^|[<,space]) / ($|[>,space]))
 *                                                            → the matrix (506, 507, 508)
 *   - ALIAS_INBOX three-valued NULL bug (NOT (From REGEXP NULL) — the IS NULL
 *     arm dropped)                                           → the matrix (511)
 *   - the Inbox/Sent split keyed on the \Sent label again    → the matrix (512, 513)
 *   - the alias branch walked on the Inbox index / unfiltered → the plan test
 *   - the {ids} disjunction widened to the raw readable ids   → the seed test
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s3r-mysql-secret';
process.env.EMAIL_DOMAINS = 'firm.test';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('mailbox S3-R on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const read = require('../services/mailbox/mailReadService');
  const S = require('../services/mailbox/mailboxSendService');
  const { makeWorld, S3R_MATRIX } = require('./helpers/mailboxS3World');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const SS = 1; const AREADER = 12; const SU = 6;
  const IT = 7; // the it@firm.test alias box of parent 2

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const [[col]] = await pool.query(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mailboxes' AND COLUMN_NAME = 'alias_of'"
    );
    if (!Number(col.n)) throw new Error('run ref/migrations/2026-10-12_mailbox_s3r_alias.sql on the test database first');
  });
  afterAll(async () => { if (pool) await pool.end(); });

  async function seedDb() {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'inbox_views']) await q(`DELETE FROM ${t}`);
    await q('DELETE FROM users WHERE user IN (1, 6, 12)');
    const user = (id, auth, roles) => q(
      `INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, user_custom_tab, roles)
       VALUES (?, ?, 1, ?, 'f', 'l', 'xx', ?, 0, '{}', ?)`, [id, 'u' + id, 'User ' + id, auth, roles]);
    await user(SS, 'authorized', 'staff,attorney');
    await user(SU, 'authorized', 'it,admin,form_dev,su');
    await user(AREADER, 'authorized', 'staff');
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, imap_secret, ingest_folders, active, ingest_enabled, alias_of, alias_label) VALUES
      (2, 'stuart@firm.test', 'firm.test', 'imap.gmail.com', 'stuart@firm.test', 'ENCv1:y', '{"[Gmail]/All Mail":{"emit_to_rules":true}}', 1, 1, NULL, NULL),
      (${IT}, 'it@firm.test', 'firm.test', 'imap.gmail.com', 'stuart@firm.test', NULL, NULL, 1, 0, 2, 'IT')`);
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by)
             VALUES (?, 'mailbox', ${IT}, 1, 1, 0, 6)`, [AREADER]);
    for (const [id, from, to, cc, labels] of S3R_MATRIX) {
      await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, gmail_labels, from_addr, to_addrs, cc_addrs, subject, date, snippet, attachments, ingested_at)
               VALUES (?, 2, '[Gmail]/All Mail', ?, ?, 'slice-thread@x.test', ?, ?, ?, ?, ?, ?, 's', '[]', '2026-10-02 00:00:00')`,
      [id, id, `m${id}@x.test`, labels, from, to, cc, `s${id}`, `2026-10-01 12:${String(id % 60).padStart(2, '0')}:00`]);
    }
  }
  beforeEach(seedDb);
  afterEach(() => jest.restoreAllMocks());

  const entry = { id: IT, address: 'it@firm.test', alias_of: 2, alias_label: 'IT' };

  test('the slice edge matrix: engine = fake world = sliceMatchJs, for the slice AND its Inbox', async () => {
    const wantSlice = S3R_MATRIX.filter((r) => r[5]).map((r) => r[0]).sort((a, b) => a - b);
    const wantInbox = S3R_MATRIX.filter((r) => r[6]).map((r) => r[0]).sort((a, b) => a - b);
    const ids = (r) => r.messages.map((m) => m.id).sort((a, b) => a - b);
    // the engine
    expect(ids(await read.listMessages(pool, AREADER, { all_folders: '1', limit: 100 }))).toEqual(wantSlice);
    expect(ids(await read.listMessages(pool, AREADER, { limit: 100 }))).toEqual(wantInbox);
    // the fake world, same seed
    const W = makeWorld();
    W.user(AREADER, {});
    W.mailbox(2, { address: 'stuart@firm.test' });
    W.mailbox(IT, { address: 'it@firm.test', ingest_enabled: 0, imap_secret: null, alias_of: 2, alias_label: 'IT' });
    W.grant(AREADER, IT, { read: 1 });
    for (const [id, from, to, cc, labels] of S3R_MATRIX) {
      W.message(id, { mailbox_id: 2, folder: '[Gmail]/All Mail', gmail_labels: labels, from_addr: from, to_addrs: to, cc_addrs: cc });
    }
    expect(ids(await read.listMessages(W.db, AREADER, { all_folders: '1', limit: 100 }))).toEqual(wantSlice);
    expect(ids(await read.listMessages(W.db, AREADER, { limit: 100 }))).toEqual(wantInbox);
    // sliceMatchJs — the JS twin the part route and loadVisible apply
    const rows = await q('SELECT id, mailbox_id, from_addr, to_addrs, cc_addrs, gmail_labels FROM mail_messages ORDER BY id');
    expect(rows.filter((r) => read.sliceMatchJs(entry, r)).map((r) => r.id)).toEqual(wantSlice);
    // and every slice row presents AS the alias box
    const shaped = (await read.listMessages(pool, AREADER, { all_folders: '1', limit: 100 })).messages;
    expect(new Set(shaped.map((m) => m.mailbox_id))).toEqual(new Set([IT]));
    expect(shaped.find((m) => m.id === 503)).toMatchObject({ sent: true, place: 'Sent', in_inbox: false });
    expect(shaped.find((m) => m.id === 512)).toMatchObject({ sent: false, in_inbox: true }); // \Sent digest TO it@ = its Inbox
    // the alias's Sent scope = its own mail, on the engine
    expect((await read.listMessages(pool, AREADER, { sent_only: '1', limit: 100 })).messages.map((m) => m.id).sort((a, b) => a - b))
      .toEqual(S3R_MATRIX.filter((r) => r[5] && !r[6]).map((r) => r[0]).sort((a, b) => a - b));
  });

  test('NULL labels and a NULL From land in the alias Inbox (no three-valued hole), and the label is bound, never SQL text', async () => {
    const inbox = (await read.listMessages(pool, AREADER, { limit: 100 })).messages.map((m) => m.id);
    expect(inbox).toEqual(expect.arrayContaining([509, 511])); // labels NULL; From NULL
    const seen = [];
    const spy = { query: (sql, p) => { seen.push({ sql, p }); return pool.query(sql, p); } };
    await read.listMessages(spy, AREADER, {});
    const list = seen.find((s) => /FORCE INDEX/.test(s.sql));
    expect(list.sql).not.toMatch(/'IT'|\\Sent/);          // bound, never inlined (a literal backslash would be eaten)
    expect(list.p).toEqual(expect.arrayContaining(['IT']));
  });

  test('the alias branch walks the PARENT on (mailbox_id, date) — never the Inbox index (slice rows are archived)', async () => {
    const seen = [];
    const spy = { query: (sql, p) => { seen.push({ sql, p }); return pool.query(sql, p); } };
    await read.listMessages(spy, AREADER, {});
    const list = seen.find((s) => /FORCE INDEX/.test(s.sql));
    const plan = await q(`EXPLAIN ${list.sql}`, list.p);
    const branch = plan.find((r) => r.table === 'm');
    expect(branch.key).toBe('idx_mail_messages_mailbox_date');
    expect(list.sql).not.toMatch(/idx_mail_messages_mailbox_inbox_date/);
  });

  test('thread + bulk mark-read ride the scope DISJUNCTION: the slice only, through the parent rows', async () => {
    const t = await read.getThread(pool, AREADER, 'slice-thread@x.test');
    expect(t.messages.map((m) => m.id)).toEqual(S3R_MATRIX.filter((r) => r[5]).map((r) => r[0]));
    expect(new Set(t.messages.map((m) => m.mailbox_id))).toEqual(new Set([IT]));
    // the full thread for the attorney, under the parent, every row once
    const full = await read.getThread(pool, SS, 'slice-thread@x.test');
    expect(full.messages.map((m) => m.id)).toEqual(S3R_MATRIX.map((r) => r[0]));
    expect(new Set(full.messages.map((m) => m.mailbox_id))).toEqual(new Set([2]));
    // {ids}: only the slice marks
    const out = await read.markRead(pool, AREADER, { ids: S3R_MATRIX.map((r) => r[0]) });
    expect(out.marked).toBe(S3R_MATRIX.filter((r) => r[5]).length);
    const marked = (await q('SELECT message_fk FROM mail_read_state WHERE user = ? ORDER BY message_fk', [AREADER])).map((r) => r.message_fk);
    expect(marked).toEqual(S3R_MATRIX.filter((r) => r[5]).map((r) => r[0]));
  });

  test('summary: the alias row carries the slice Inbox counts; mark-all on the alias clears exactly them', async () => {
    const sum = await read.summary(pool, AREADER);
    const inboxN = S3R_MATRIX.filter((r) => r[6]).length;
    expect(sum.mailboxes).toEqual([expect.objectContaining({ id: IT, alias_of: 2, inbox_total: inboxN, inbox_unread: inboxN })]);
    const out = await read.markRead(pool, AREADER, { all: true, mailbox_ids: [IT] });
    expect(out.marked).toBe(inboxN);
    expect((await read.summary(pool, AREADER)).mailboxes[0].inbox_unread).toBe(0);
    // the parent's own rows stayed untouched for everyone
    expect((await q('SELECT COUNT(*) AS n FROM mail_read_state'))[0].n).toBe(inboxN);
  });

  test('the sent-copy seed probes the alias\'s parent and marks through the slice', async () => {
    await q("UPDATE mail_messages SET provider_id = 'cafe01', date = UTC_TIMESTAMP() WHERE id = 503");
    const r = await S.seedSentReadState(pool, {
      user: AREADER, mailbox_id: IT, sent_at: new Date().toISOString(), provider_id: 'cafe01', message_id: null,
    });
    expect(r).toEqual({ seeded: 1, found: 1 });
    expect(await q('SELECT message_fk FROM mail_read_state WHERE user = ?', [AREADER])).toEqual([{ message_fk: 503 }]);
    // a copy outside the slice: found by the parent probe, not markable → done quietly
    await q('UPDATE mail_messages SET provider_id = ?, date = UTC_TIMESTAMP(), gmail_labels = ? WHERE id = 508', ['cafe02', JSON.stringify(['\\Sent'])]);
    const r2 = await S.seedSentReadState(pool, {
      user: AREADER, mailbox_id: IT, sent_at: new Date().toISOString(), provider_id: 'cafe02', message_id: null,
    });
    expect(r2).toEqual({ seeded: 0, found: 1 });
  });
});
