// Casey v2 S4b — the review readers and the migration on a REAL MySQL 8.4 (own
// *_test DB; gated on YC_TEST_MYSQL_URL, skipped otherwise):
//
//   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3379/yc_casey_review_test \
//     npx jest tests/caseyReview.mysql.test.js --runInBand
//
// Proves scripts/caseyV2S4bMigrate.js (CHECK on the pre-S4b enum → --apply →
// re-run in place → a drift is NO-GO; stored rows survive) and
// services/casey/chats.listForReview / getForReview / flagsForReview and
// cards.listForChat against the real tables: the JSON_EXTRACT join on
// issue_reports.context, the LIKE escape, the user filter, the flagged filter,
// the cost sum over ai_calls, the ordering and the limit. Own DB: this twin
// drops and rebuilds the casey tables, a minimal users / ai_calls, and
// issue_reports from ref/database.sql's CREATE — never share its DB.
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { withTransaction } = require('../lib/withTransaction');
const migrateChats = require('../scripts/caseyV2ChatsMigrate');
const migrateS3a = require('../scripts/caseyV2S3aMigrate');
const migrateS3b = require('../scripts/caseyV2S3bMigrate');
const migrateS3c = require('../scripts/caseyV2S3cMigrate');
const migrate = require('../scripts/caseyV2S4bMigrate');
const chats = require('../services/casey/chats');
const cards = require('../services/casey/cards');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

/** issue_reports' CREATE from the generated schema, with the PRE-S4b enum (the migration widens it). */
function issueReportsCreate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8');
  const m = /CREATE TABLE `issue_reports` \(([\s\S]*?)\n\) ENGINE=[^;]*;/.exec(sql);
  if (!m) throw new Error('issue_reports CREATE not found in ref/database.sql');
  let create = m[0].replace("enum('problem','idea','question','casey')", "enum('problem','idea','question')");
  // the dump's id column has no AUTO_INCREMENT (the ALTER adds it later in the file): give the twin one
  create = create.replace('`id` bigint NOT NULL,', '`id` bigint NOT NULL AUTO_INCREMENT,').replace(/\n\) ENGINE=/, ',\n  PRIMARY KEY (`id`)\n) ENGINE=');
  return create;
}

suite('casey review — real engine', () => {
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = []; const say = (l) => lines.push(l);

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); c.query('SET SESSION lock_wait_timeout = 10'); });
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    for (const t of ['casey_card_steps', 'casey_cards', 'casey_messages', 'casey_chats', 'issue_reports', 'users', 'ai_calls']) await q(`DROP TABLE IF EXISTS ${t}`);
    for (const m of [migrateChats, migrateS3a, migrateS3b, migrateS3c]) expect((await m.run(conn, { apply: true, say })).ok).toBe(true);
    await q('CREATE TABLE users (`user` int NOT NULL PRIMARY KEY, user_name varchar(64) NOT NULL)');
    await q("CREATE TABLE ai_calls (id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, consumer_ref varchar(128) DEFAULT NULL, cost_cents decimal(10,4) DEFAULT NULL)");
    await q(issueReportsCreate());
    await q("INSERT INTO users (`user`, user_name) VALUES (6, 'IT'), (7, 'Rena')");
  });
  afterAll(async () => { await conn.end(); await pool.end(); });
  beforeEach(() => { lines.length = 0; });

  test('migration: CHECK on the pre-S4b enum → GO; --apply widens it (rows kept); re-run in place; a drifted comment is NO-GO', async () => {
    await q("INSERT INTO issue_reports (user_id, user_name, kind, note) VALUES (7, 'Rena', 'problem', 'before')");
    const check = await migrate.run(conn, { apply: false, say });
    expect(check.ok).toBe(true);
    expect(check.line).toMatch(/Next: node scripts\/caseyV2S4bMigrate.js --apply/);
    const applied = await migrate.run(conn, { apply: true, say });
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(applied.line).toMatch(/^APPLIED — issue_reports.kind carries casey/);
    expect((await q('SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['issue_reports', 'kind']))[0].t).toBe("enum('problem','idea','question','casey')");
    expect((await q('SELECT kind, note FROM issue_reports'))).toEqual([{ kind: 'problem', note: 'before' }]);
    const again = await migrate.run(conn, { apply: true, say });
    expect(again).toMatchObject({ ok: true, applied: false });
    await q("ALTER TABLE issue_reports MODIFY COLUMN kind enum('problem','idea','question','casey') NOT NULL DEFAULT 'problem' COMMENT 'drifted'");
    lines.length = 0;
    const drift = await migrate.run(conn, { apply: true, say });
    expect(drift.ok).toBe(false);
    expect(lines.some((l) => /comment differs/.test(l))).toBe(true);
    await q("ALTER TABLE issue_reports MODIFY COLUMN kind enum('problem','idea','question') NOT NULL DEFAULT 'problem'");
    expect((await migrate.run(conn, { apply: true, say })).ok).toBe(true);
    await q('DELETE FROM issue_reports');
  });

  test('listForReview / getForReview / flagsForReview / listForChat against the real tables', async () => {
    // precondition: the migration test above widened the enum (a `-t` run of this test alone would insert 'casey' into a 3-value enum as '' under the relaxed sql_mode)
    expect((await q('SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['issue_reports', 'kind']))[0].t).toContain("'casey'");
    const a = await chats.createChat(pool, { userId: 6, text: 'Overdue tasks 100%', model: 'claude-sonnet-5-5', effort: 'medium', promptVersion: 'v2.5-x' });
    const b = await chats.createChat(pool, { userId: 7, text: 'Mail to _Mary', model: 'claude-opus-5-5', effort: 'high', promptVersion: 'v2.5-x' });
    const c = await chats.createChat(pool, { userId: 7, text: 'Another one', model: 'claude-sonnet-5-5', effort: 'medium', promptVersion: 'v2.5-x' });
    await chats.appendMessage(pool, a, 'user', [{ type: 'text', text: 'q' }], null);
    await chats.appendMessage(pool, a, 'assistant', [{ type: 'thinking', thinking: 'hm', signature: 'S' }, { type: 'text', text: 'A.' }], { cost_cents: 0.5 });
    await chats.appendMessage(pool, b, 'user', [{ type: 'text', text: 'q2' }], null);
    await q("INSERT INTO ai_calls (consumer_ref, cost_cents) VALUES (?, 1.25), (?, 0.75), (?, 9)", [`assistant_v2:u6:c${a}`, `assistant_v2:u6:c${a}`, `assistant_v2:u7:c${b}`]);
    await q("INSERT INTO issue_reports (user_id, user_name, kind, note, context) VALUES (6, 'IT', 'casey', 'wrong count', ?), (7, 'Rena', 'casey', 'by casey', ?), (7, 'Rena', 'problem', 'unrelated', ?)",
      [JSON.stringify({ casey: { chat_id: a, seq: 2, by: 'user' } }), JSON.stringify({ casey: { chat_id: a, seq: null, by: 'casey' } }), JSON.stringify({ casey: { chat_id: b } })]);   // the third is kind problem: never a flag
    const cardId = await cards.createCard(pool, { chatId: b, userId: 7, toolUseId: 'tu1', tier: 1, summary: 'Create a task', steps: [{ method: 'POST', path: '/api/tasks', body: '{"title":"x"}', tier: 1, purpose: 'p' }] });

    const all = await chats.listForReview(pool, {});
    expect(all.map((r) => [r.id, r.user_name, r.message_count, r.cost_cents, r.flags])).toEqual([[c, 'Rena', 0, 0, 0], [b, 'Rena', 1, 9, 0], [a, 'IT', 2, 2, 2]]);   // newest activity first; the problem report is not a flag
    expect(typeof all[0].id).toBe('number');
    expect((await chats.listForReview(pool, { user: 7 })).map((r) => r.id)).toEqual([c, b]);
    expect((await chats.listForReview(pool, { flagged: true })).map((r) => r.id)).toEqual([a]);
    expect((await chats.listForReview(pool, { q: '100%' })).map((r) => r.id)).toEqual([a]);        // % is escaped, not a wildcard
    expect((await chats.listForReview(pool, { q: '_Mary' })).map((r) => r.id)).toEqual([b]);       // _ too
    expect((await chats.listForReview(pool, { q: 'o' })).length).toBe(3);
    expect((await chats.listForReview(pool, { limit: 1 })).map((r) => r.id)).toEqual([c]);
    expect((await chats.listForReview(pool, { before: '2000-01-01' })).length).toBe(0);

    const one = await chats.getForReview(pool, a);
    expect(one).toMatchObject({ id: a, user_id: 6, user_name: 'IT', title: 'Overdue tasks 100%', model: 'claude-sonnet-5-5', prompt_version: 'v2.5-x' });
    expect(await chats.getForReview(pool, 999999)).toBeNull();
    expect(await chats.getForReview(pool, b)).toMatchObject({ id: b, user_id: 7, user_name: 'Rena' });   // unscoped: another user's chat reads too
    const msgs = await chats.loadMessages(pool, a);
    expect(msgs.map((m) => m.content.map((x) => x.type))).toEqual([['text'], ['thinking', 'text']]);   // nothing stripped for the record
    const flags = await chats.flagsForReview(pool, a);
    expect(flags.map((f) => [f.user_name, f.seq, f.by, f.note])).toEqual([['IT', 2, 'user', 'wrong count'], ['Rena', null, 'casey', 'by casey']]);
    expect(await chats.flagsForReview(pool, c)).toEqual([]);
    const cs = await cards.listForChat(pool, b);
    expect(cs.map((x) => [x.id, x.summary, x.steps.length, !!x.steps[0].content])).toEqual([[cardId, 'Create a task', 1, true]]);
    expect(await cards.listForChat(pool, a)).toEqual([]);
  });
});
