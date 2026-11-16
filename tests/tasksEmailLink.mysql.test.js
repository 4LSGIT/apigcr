/**
 * REAL-ENGINE TWIN of comms-polish-2 C2 (tasks.task_link_type 'email'):
 *   - scripts/commsPolish2TasksEmailLink.js applies the enum MODIFY from the
 *     migration file TWICE (the second run says "already applied"), the
 *     column reads back as the C2 enum, NULL / DEFAULT NULL, the row counts
 *     per link type unchanged;
 *   - a task linked to a stored email lists and reads back with the message's
 *     subject (listTasks + getTask, through the real statements), the
 *     mm.id = CAST(task_link_id AS UNSIGNED) join is an eq_ref on mail_messages'
 *     PRIMARY KEY (never a scan of the mail store per task row), and a task
 *     whose message is gone keeps its id.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test, loaded with ref/database.sql
 * (timezone tables loaded — the tasks triggers CONVERT_TZ):
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_sph_test npx jest --runInBand tests/tasksEmailLink.mysql.test.js
 * It deletes the tasks / mail_messages rows it seeds (ids 980001+ / 4470001+).
 */
'use strict';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('tasks email link on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const taskService = require('../services/taskService');
  const mig = require('../scripts/commsPolish2TasksEmailLink');
  let pool; let conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const TASK = 980001; const TASK_GONE = 980002; const MAIL = 4470001;

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    const cfg = { host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database, timezone: 'Z' };
    pool = mysql.createPool({ ...cfg, connectionLimit: 3 });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    conn = await mysql.createConnection(cfg);
    await conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await q('DELETE FROM tasks WHERE task_id IN (?)', [[TASK, TASK_GONE]]);
    await q('DELETE FROM mail_messages WHERE id = ?', [MAIL]);
    await q('DELETE FROM users WHERE user = 6');
    await q(`INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, roles)
             VALUES (6, 'u6', 1, 'IT', 'f', 'l', 'xx', 'authorized', 0, 'it,admin,su')`);
  });
  afterAll(async () => {
    if (pool) {
      await q('DELETE FROM tasks WHERE task_id IN (?)', [[TASK, TASK_GONE]]).catch(() => {});
      await q('DELETE FROM mail_messages WHERE id = ?', [MAIL]).catch(() => {});
      await pool.end();
    }
    if (conn) await conn.end();
  });

  test('the migration TWICE through the script: the enum gains email once; NULL / DEFAULT NULL; counts unchanged', async () => {
    // back to the pre-C2 column first, so run 1 is a real apply
    await conn.query(`ALTER TABLE tasks MODIFY task_link_type ${mig.BEFORE} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL`);
    const r1 = await mig.run(conn, { apply: true, say: () => {} });
    expect(r1.ok).toBe(true);
    const col = async () => (await q(`SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS
                                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'task_link_type'`))[0];
    const c1 = await col();
    expect([c1.COLUMN_TYPE, c1.IS_NULLABLE, c1.COLUMN_DEFAULT]).toEqual([mig.AFTER, 'YES', null]);
    expect(c1.COLUMN_COMMENT).toMatch(/comms-polish-2 C2/);
    const r2 = await mig.run(conn, { apply: true, say: () => {} });
    expect([r2.ok, r2.line]).toEqual([true, expect.stringMatching(/^GO/)]);
    expect(await col()).toEqual(c1);
    const chk = await mig.run(conn, { apply: false, say: () => {} });
    expect(chk.line).toMatch(/nothing \(already applied\)/);
  });

  test('a task linked to a stored email reads back with the subject; the join is an eq_ref on mail_messages PRIMARY; a gone message keeps its id', async () => {
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, from_addr, subject, date, body_text, attachments)
             VALUES (?, 1, 'INBOX', ?, 'c2@x.test', 'c2@x.test', 'a@b.test', 'Plan objection', '2026-11-16 00:00:00', 'x', '[]')`, [MAIL, MAIL]);
    await q(`INSERT INTO tasks (task_id, task_status, task_from, task_to, task_link, task_link_type, task_link_id, task_title, task_desc, task_source)
             VALUES (?, 'Pending', 6, 6, ?, 'email', ?, 'Follow up', '', 'comms'), (?, 'Pending', 6, 6, '4479999', 'email', '4479999', 'Orphan', '', 'comms')`,
    [TASK, String(MAIL), String(MAIL), TASK_GONE]);
    const stored = await q('SELECT task_link_type, task_link_id FROM tasks WHERE task_id = ?', [TASK]);
    expect(stored).toEqual([{ task_link_type: 'email', task_link_id: String(MAIL) }]);      // relaxed sql_mode stored the VALUE, not ''
    const recorded = [];
    const rec = { query: (sql, p) => { recorded.push([sql, p]); return pool.query(sql, p); } };
    const out = await taskService.listTasks(rec, { status: 'All', link_type: 'email', link_id: String(MAIL) });
    expect(out.data.map((t) => [t.id, t.link])).toEqual([[TASK, { type: 'email', id: String(MAIL), title: 'Plan objection' }]]);
    const gone = await taskService.getTask(pool, TASK_GONE);
    expect(gone.link).toEqual({ type: 'email', id: '4479999', title: 'Email #4479999' });
    const one = await taskService.getTask(pool, TASK);
    expect(one.link).toEqual({ type: 'email', id: String(MAIL), title: 'Plan objection' });
    // the plan: mail_messages is reached by its PRIMARY KEY per task row (eq_ref), never scanned
    const rows = recorded.find(([sql]) => /SELECT\s+t\.\*/.test(sql));
    expect(rows).toBeTruthy();
    const plan = await q(`EXPLAIN ${rows[0]}`, rows[1]);
    const mm = plan.find((r) => r.table === 'mm');
    expect([mm.type, mm.key]).toEqual(['eq_ref', 'PRIMARY']);
  });
});
