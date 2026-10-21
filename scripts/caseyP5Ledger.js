#!/usr/bin/env node
// One connection from .env. CHECK is read only; only Fred runs --apply.
// Retain all rows, including unknown claims and old kind versions, until the
// actor is deleted. Never prune on chat deletion: that would erase the fence.
// Rollback: revert frontend, then backend; KEEP this table and its receipts.
'use strict';
const path = require('path');
const TABLE = 'assistant_action_ledger';
const DDL = `CREATE TABLE assistant_action_ledger (
  user_id TINYINT NOT NULL,
  draft_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Server-minted UUID v4; user-scoped, never model-chosen',
  kind VARCHAR(64) NOT NULL COMMENT 'Closed versioned action kind; old versions remain readable',
  status ENUM('in_flight','applied') NULL DEFAULT NULL COMMENT 'NULL is not-applied; in_flight without result is unknown forever, never retry',
  claim_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL COMMENT 'Receipt capability, not a session credential; never included in chat payload',
  result JSON DEFAULT NULL COMMENT 'Only the canonical task/event/appt/contact numeric id; no evidence or credentials',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, draft_id),
  CONSTRAINT fk_assistant_action_ledger_user FOREIGN KEY (user_id) REFERENCES users (\`user\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
 COMMENT='Applied-result receipts; retained until actor deletion, independently of chat retention'`;
const COLUMNS = [
  ['user_id', 'tinyint', 'NO', null], ['draft_id', 'char(36)', 'NO', 'ascii_bin'],
  ['kind', 'varchar(64)', 'NO', 'utf8mb4_general_ci'], [ 'status', "enum('in_flight','applied')", 'YES', 'utf8mb4_general_ci'],
  ['claim_token', 'char(36)', 'YES', 'ascii_bin'], ['result', 'json', 'YES', null],
  ['created_at', 'datetime', 'NO', null], ['updated_at', 'datetime', 'NO', null],
];
async function q(conn, sql, params = []) { return (await conn.query({ sql, timeout: 30000 }, params))[0]; }
async function state(conn) {
  const [who] = await q(conn, 'SELECT @@SESSION.sql_mode AS mode');
  if (/STRICT_(TRANS|ALL)_TABLES/.test(who.mode)) throw new Error('Expected relaxed sql_mode');
  const users = await q(conn, "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='user'");
  if (!users[0] || users[0].t !== 'tinyint') throw new Error('Expected users.user tinyint');
  const columns = await q(conn, `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [TABLE]);
  if (!columns.length) return false;
  const actual = columns.map(c => [c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLLATION_NAME]);
  if (JSON.stringify(actual) !== JSON.stringify(COLUMNS)) throw new Error('Existing ledger has an unexpected column shape');
  const byName = new Map(columns.map(c => [c.COLUMN_NAME, c]));
  if (byName.get('status').COLUMN_DEFAULT !== null || byName.get('claim_token').COLUMN_DEFAULT !== null
      || byName.get('result').COLUMN_DEFAULT !== null
      || !/^CURRENT_TIMESTAMP(?:\(\))?$/i.test(byName.get('created_at').COLUMN_DEFAULT)
      || !/^CURRENT_TIMESTAMP(?:\(\))?$/i.test(byName.get('updated_at').COLUMN_DEFAULT)
      || !/on update CURRENT_TIMESTAMP/i.test(byName.get('updated_at').EXTRA)) throw new Error('Wrong ledger defaults');
  const [table] = await q(conn, 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [TABLE]);
  if (!table || table.ENGINE !== 'InnoDB') throw new Error('Ledger must be InnoDB');
  const indexes = await q(conn, `SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX`, [TABLE]);
  if (indexes.map(c => c.COLUMN_NAME).join(',') !== 'user_id,draft_id') throw new Error('Wrong ledger primary key');
  const fks = await q(conn, `SELECT k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r USING (CONSTRAINT_SCHEMA, CONSTRAINT_NAME, TABLE_NAME)
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.COLUMN_NAME='user_id'`, [TABLE]);
  if (fks.length !== 1 || fks[0].REFERENCED_TABLE_NAME !== 'users' || fks[0].REFERENCED_COLUMN_NAME !== 'user' || fks[0].DELETE_RULE !== 'CASCADE') throw new Error('Wrong ledger user FK');
  return true;
}
async function run(conn, { apply = false, log = console.log } = {}) {
  try {
    const exists = await state(conn);
    if (!exists && apply) {
      await q(conn, 'SET SESSION lock_wait_timeout = 5');
      await q(conn, DDL);
      if (!await state(conn)) throw new Error('Ledger missing after CREATE');
    }
    if (apply) {
      const draftId = require('crypto').randomUUID();
      const [user] = await q(conn, 'SELECT `user` AS id FROM users ORDER BY `user` LIMIT 1');
      if (!user) throw new Error('No staff user for rolled-back smoke test');
      await q(conn, 'START TRANSACTION');
      try {
        await q(conn, 'INSERT INTO assistant_action_ledger (user_id,draft_id,kind) VALUES (?,?,?)', [user.id, draftId, 'task.create.v1']);
        const changed = await q(conn, "UPDATE assistant_action_ledger SET status='in_flight' WHERE user_id=? AND draft_id=? AND status IS NULL", [user.id, draftId]);
        if (changed.affectedRows !== 1) throw new Error('Smoke claim failed');
        const payload = { task_id: 71 };
        await q(conn, "UPDATE assistant_action_ledger SET status='applied',result=? WHERE user_id=? AND draft_id=?", [JSON.stringify(payload), user.id, draftId]);
        const [row] = await q(conn, 'SELECT status,result FROM assistant_action_ledger WHERE user_id=? AND draft_id=?', [user.id, draftId]);
        const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        if (row.status !== 'applied' || result.task_id !== 71 || Object.keys(result).length !== 1) throw new Error('Smoke receipt failed');
      } finally { await q(conn, 'ROLLBACK'); }
      const [left] = await q(conn, 'SELECT COUNT(*) AS n FROM assistant_action_ledger WHERE user_id=? AND draft_id=?', [user.id, draftId]);
      if (left.n !== 0) throw new Error('Smoke rows survived rollback');
    }
    const line = exists || apply
      ? 'P5 APPLIED — GO. Next: deploy backend, then frontend; retain the ledger on rollback.'
      : 'CHECK OK — GO. Next: node scripts/caseyP5Ledger.js --apply';
    log(line); return { ok: true, line };
  } catch (err) {
    const line = `NO-GO — ${err.message}. Re-run CHECK; do not deploy.`;
    log(line); return { ok: false, line };
  }
}
module.exports = { run, state, DDL };
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  (async () => {
    let conn;
    try {
      const proxy = await require('./ensure-sql-proxy').ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(proxy.reason);
      for (const k of ['host', 'user', 'password', 'database']) if (!process.env[k]) throw new Error(`Missing env ${k}`);
      conn = await require('mysql2/promise').createConnection({ host: process.env.host, user: process.env.user,
        password: process.env.password, database: process.env.database, timezone: 'Z', connectTimeout: 15000 });
      const out = await run(conn, { apply: process.argv.includes('--apply') });
      process.exitCode = out.ok ? 0 : 1;
    } catch (e) { console.log(`NO-GO — ${e.message}. Do not deploy.`); process.exitCode = 1; }
    finally { if (conn) await conn.end(); }
  })();
}
