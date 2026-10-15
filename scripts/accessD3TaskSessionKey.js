#!/usr/bin/env node
// scripts/accessD3TaskSessionKey.js
//
/**
 * Access-control D3 — session-key tasks: tasks.task_session_key_id.
 * The applied SQL is recorded in ref/migrations/2026-10-15_access_d3_task_session_key.sql.
 *
 *   1. ALTER TABLE tasks ADD COLUMN task_session_key_id int NULL COMMENT …
 *        AFTER task_source, ALGORITHM=INSTANT
 *   2. ALTER TABLE tasks ADD INDEX idx_tasks_session_key (task_session_key_id, task_date),
 *        ALGORITHM=INPLACE, LOCK=NONE
 *
 * `tasks` is a HOT table: both steps are online — the column INSTANT (metadata
 * only, no rebuild, no copy), the index INPLACE with LOCK=NONE (concurrent
 * reads AND writes keep running; only a brief metadata lock at each end).
 * Each statement names its algorithm, so MySQL refuses rather than silently
 * falling back to a table copy. lock_wait_timeout is low on this connection:
 * a metadata lock queued behind a long transaction would otherwise stall every
 * query on tasks (the global default is a year).
 *
 * NULL = not a session-key task — every existing row, and every task the app
 * creates. The key that creates a task owns it (routes/api.keyTasks.js); the
 * index serves "this key's tasks" and the per-root create count.
 * NO foreign key to readonly_api_keys, deliberately: on the hot table an FK
 * adds a parent-row lookup + shared lock to every keyed INSERT, and ownership
 * needs only equality. Keys are never hard-deleted in practice, and InnoDB never
 * reuses an AUTO_INCREMENT id, so a dangling id can match no other key.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: run THIS FIRST, then land + deploy D3.                     │
 * │ The D3 key-task routes name task_session_key_id: deployed first, every  │
 * │ /api/key-tasks call is a 500 — CLOSED, nothing written — until the      │
 * │ column exists. Every OTHER task path is untouched either way: createTask │
 * │ names the column only for a key's task, the rest select t.* / name      │
 * │ their columns.                                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/accessD3TaskSessionKey.js           # CHECK — read-only, prints plan
 *   node scripts/accessD3TaskSessionKey.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * A column or index that already exists in ANY other shape is a NO-GO, never
 * altered.
 */

'use strict';

const TABLE = 'tasks';
const INDEX = 'idx_tasks_session_key';
const COMMENT =
  'Session-key tasks (access-control D3): NULL = not created by a session key; else ' +
  'readonly_api_keys.id of the tasks.own key that created it and alone may manage it via /api/key-tasks. ' +
  'Ownership lives HERE, never in task_source (free text). No FK: hot table; key ids are never reused.';
const ADD_COLUMN_SQL =
  `ALTER TABLE \`${TABLE}\` ADD COLUMN \`task_session_key_id\` int NULL DEFAULT NULL ` +
  `COMMENT '${COMMENT}' AFTER \`task_source\`, ALGORITHM=INSTANT`;
const ADD_INDEX_SQL =
  `ALTER TABLE \`${TABLE}\` ADD INDEX \`${INDEX}\` (\`task_session_key_id\`, \`task_date\`), ALGORITHM=INPLACE, LOCK=NONE`;

/** { column, index } each 'absent' | 'present', or { problem }. */
async function liveState(conn) {
  const [[t]] = await conn.query(
    `SELECT TABLE_TYPE type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  if (!t || t.type !== 'BASE TABLE') return { problem: `${TABLE} is not a base table here` };
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLUMN_DEFAULT def
       FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  const names = cols.map(c => c.name);
  for (const need of ['task_id', 'task_from', 'task_to', 'task_date', 'task_source', 'task_action_token']) {
    if (!names.includes(need)) return { problem: `${TABLE} lacks ${need} — not the expected table` };
  }
  const c = cols.find(x => x.name === 'task_session_key_id');
  let column = 'absent';
  if (c) {
    if (c.type !== 'int' || c.nullable !== 'YES' || c.def != null) {
      return { problem: `${TABLE}.task_session_key_id exists as ${c.type} nullable=${c.nullable} default=${JSON.stringify(c.def)} — expected int NULL DEFAULT NULL` };
    }
    column = 'present';
  }
  const [idx] = await conn.query(
    `SELECT SEQ_IN_INDEX seq, COLUMN_NAME col, NON_UNIQUE nu FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`, [TABLE, INDEX]);
  let index = 'absent';
  if (idx.length) {
    const shape = idx.map(r => r.col).join(',');
    if (shape !== 'task_session_key_id,task_date' || Number(idx[0].nu) !== 1) {
      return { problem: `index ${INDEX} exists as (${shape}) non_unique=${idx[0].nu} — expected (task_session_key_id,task_date) non-unique` };
    }
    index = 'present';
  }
  if (column === 'absent' && index === 'present') return { problem: `${INDEX} present without the column — impossible state, not ours` };
  return { column, index };
}

async function run(conn, { apply, log = console.log }) {
  log(`accessD3TaskSessionKey — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);
  let st = await liveState(conn);
  if (st.problem) {
    log(`Unexpected live state: ${st.problem}`);
    log('\nNO-GO — re-verify by hand; this script never alters what it did not create. Nothing was changed.');
    return { ok: false };
  }
  log(`${TABLE}.task_session_key_id: ${st.column}   index ${INDEX}: ${st.index}`);
  // INSTANT ADD COLUMN spends one of 64 row versions per table (MySQL 8.0.29+);
  // at the cap MySQL refuses INSTANT and this script would stop — say so up front.
  if (st.column === 'absent') {
    let versions = null;
    try {
      const [[r]] = await conn.query(
        `SELECT TOTAL_ROW_VERSIONS n FROM information_schema.innodb_tables WHERE name = CONCAT(DATABASE(), '/${TABLE}')`);
      versions = r ? Number(r.n) : null;
    } catch (_) { /* not visible to this user: MySQL still refuses rather than copies */ }
    log(`INSTANT row versions used on ${TABLE}: ${versions == null ? 'unknown' : versions} of 64`);
    if (versions != null && versions >= 64) {
      log('\nNO-GO — tasks has no INSTANT row versions left; adding the column would need a table rebuild. Stop and plan one.');
      return { ok: false };
    }
  }
  if (st.column === 'present' && st.index === 'present') {
    log('\nGO — the migration is already applied; nothing to do. Next: land + deploy access D3.');
    return { ok: true };
  }
  const plan = [st.column === 'absent' && ADD_COLUMN_SQL, st.index === 'absent' && ADD_INDEX_SQL].filter(Boolean);
  if (!apply) {
    log(`\nPlan:\n  ${plan.join('\n  ')}`);
    log('\nGO — base state matches. Next: node scripts/accessD3TaskSessionKey.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  const step = async (label, sql) => {
    try {
      await conn.query(sql);
      log(`✓ ${label}`);
      return true;
    } catch (err) {
      log(`\n${label}: ${err.message}`);
      log('NO-GO — that step changed nothing (each ALTER is atomic); earlier steps stand. Re-run CHECK, then --apply resumes.');
      return false;
    }
  };
  if (st.column === 'absent') {
    if (!(await step('column added (INSTANT)', ADD_COLUMN_SQL))) return { ok: false };
    const [[{ set }]] = await conn.query(`SELECT COUNT(*) \`set\` FROM \`${TABLE}\` WHERE task_session_key_id IS NOT NULL`);
    if (Number(set)) {
      log(`task_session_key_id is set on ${set} row(s) right after the ALTER — expected 0.`);
      log('\nNO-GO — verify by hand.');
      return { ok: false };
    }
  }
  if (st.index === 'absent') {
    if (!(await step(`index ${INDEX} added (INPLACE, LOCK=NONE)`, ADD_INDEX_SQL))) return { ok: false };
  }
  st = await liveState(conn);
  if (st.problem || st.column !== 'present' || st.index !== 'present') {
    log(`After the ALTERs: ${st.problem || JSON.stringify(st)}`);
    log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM \`${TABLE}\``);
  log(`✓ verified — column int NULL, index (task_session_key_id, task_date); ${n} existing task(s), all NULL`);
  log('\nGO — migration applied. Next: land + deploy access D3 (then npm run db:ref).');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const argv = process.argv.slice(2);
  if (argv.some(a => a !== '--apply') || argv.length > 1) {
    console.log(`Unknown flags: ${argv.join(' ')}\n\nNO-GO — pass nothing (CHECK) or --apply. Nothing was changed.`);
    process.exit(1);
  }
  const apply = argv[0] === '--apply';
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing further was changed; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, liveState, ADD_COLUMN_SQL, ADD_INDEX_SQL, COMMENT };
