// tests/queryDbBlockedColumns.test.js
//
// query_db's blocked columns are REFUSED wherever the descriptor names them
// (select, where, join.on, order_by) and stripped from `*` rows — since
// 2026-11-15, when the bearer tokens (users.reset_token, contacts.contact_token,
// appts.appt_manage_token, tasks.task_action_token) joined the list. Before
// it, the runtime only stripped password / password_hash / custom from the
// OUTPUT, so a staff-authored step could `select users.reset_token` into a
// workflow variable, and a `where reset_token = ?` was an oracle on a secret
// even with the column stripped (found by the Ask Casey A17.4a worker).
//
// The pool is a stub that records the SQL and answers canned rows: the
// refusals happen before any query, and the strip is pure JS over the rows.
// 127.0.0.1:3306 is production — nothing here dials a pool.
//
//   npx jest tests/queryDbBlockedColumns.test.js
'use strict';

const fns = require('../lib/internal_functions');

function stubDb(rows = []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return [rows]; } };
}

const BLOCKED = [
  ['users', 'password'], ['users', 'password_hash'], ['users', 'reset_token'],
  ['contacts', 'contact_token'], ['contacts', 'custom'], ['cases', 'custom'],
  ['appts', 'appt_manage_token'], ['tasks', 'task_action_token'],
];

describe('query_db blocked columns', () => {
  test.each(BLOCKED)('select %s.%s is refused by name before any query', async (table, col) => {
    const db = stubDb();
    await expect(fns.query_db({ select: [`${table}.${col}`], from: table }, db))
      .rejects.toThrow(`select column "${table}.${col}" names ${table}.${col}, a blocked column`);
    expect(db.calls.length).toBe(0);
  });

  test('a where clause on a blocked column is refused (an oracle on a secret), through an alias too', async () => {
    const db = stubDb();
    await expect(fns.query_db({ select: ['users.user'], from: 'users',
      where: [{ column: 'users.reset_token', op: '=', value: 'x' }] }, db))
      .rejects.toThrow('where.column "users.reset_token" names users.reset_token, a blocked column');
    await expect(fns.query_db({ select: ['c.contact_name'], from: 'cases',
      join: [{ type: 'left', table: 'contacts', alias: 'c', on: { left: 'cases.case_id', right: 'c.contact_id' } }],
      where: [{ column: 'c.contact_token', op: 'IS NOT NULL' }] }, db))
      .rejects.toThrow('where.column "c.contact_token" names contacts.contact_token, a blocked column');
    expect(db.calls.length).toBe(0);
  });

  test('join.on and order_by on a blocked column are refused', async () => {
    const db = stubDb();
    await expect(fns.query_db({ select: ['appts.appt_id'], from: 'appts',
      join: [{ type: 'left', table: 'tasks', on: { left: 'appts.appt_manage_token', right: 'tasks.task_action_token' } }] }, db))
      .rejects.toThrow('join.on.left "appts.appt_manage_token" names appts.appt_manage_token, a blocked column');
    await expect(fns.query_db({ select: ['tasks.id'], from: 'tasks',
      order_by: [{ column: 'tasks.task_action_token', dir: 'asc' }] }, db))
      .rejects.toThrow('order_by.column "tasks.task_action_token" names tasks.task_action_token, a blocked column');
    expect(db.calls.length).toBe(0);
  });

  test('an unqualified column never reaches the blocked-column check: the builder already refuses it as an unknown table/alias', async () => {
    const db = stubDb();
    await expect(fns.query_db({ select: ['users.user'], from: 'users',
      where: [{ column: 'reset_token', op: 'IS NULL' }] }, db))
      .rejects.toThrow('where references unknown table/alias "reset_token"');
    expect(db.calls.length).toBe(0);
  });

  test('`*` still strips every blocked column from the rows; allowed columns query and pass through', async () => {
    const db = stubDb([{ user: 6, user_name: 'Fred', password_hash: 'h', reset_token: 't' }]);
    const out = await fns.query_db({ select: ['*'], from: 'users', output_var: 'u' }, db);
    expect(db.calls.length).toBe(1);
    expect(db.calls[0].sql).toMatch(/^SELECT `users`\.\* FROM `users` LIMIT 100$/);
    const rows = out && out.output !== undefined ? out.output : out;
    const text = JSON.stringify(rows);
    expect(text).toContain('Fred');
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('reset_token');
    const db2 = stubDb([{ user: 6 }]);
    await expect(fns.query_db({ select: ['users.user', 'users.user_name'], from: 'users' }, db2)).resolves.toBeTruthy();
    expect(db2.calls[0].sql).toMatch(/^SELECT `users`\.`user`, `users`\.`user_name` FROM `users` LIMIT 100$/);
  });
});
