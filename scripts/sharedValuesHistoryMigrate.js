#!/usr/bin/env node
// scripts/sharedValuesHistoryMigrate.js
//
/**
 * Shared values — the write history behind GET /api/shared/:ns/_history and
 * the Shared values admin page (2026-10-28). The applied SQL is recorded
 * verbatim in ref/migrations/2026-10-28_shared_values_history.sql
 * (tests/sharedValuesHistoryMigrate.test.js pins the two together).
 *
 *   shared_values_history  one row per SUCCESSFUL write, written in the
 *                          write's own transaction (services/
 *                          sharedValuesService.js recordHistory). No FK: the
 *                          history outlives a deleted namespace.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: run THIS FIRST, then land + deploy the code. One NEW       │
 * │ table; nothing existing is altered. The old backend never names it; the │
 * │ new backend's every shared-values WRITE fails (rolled back) until it     │
 * │ exists, because each write inserts its history row in the same          │
 * │ transaction.                                                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/sharedValuesHistoryMigrate.js           # CHECK — read-only, prints plan
 *   node scripts/sharedValuesHistoryMigrate.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and creates the table only
 * when absent. A table that already exists in ANY other shape is a NO-GO,
 * never altered.
 */

'use strict';

const TABLE = 'shared_values_history';
const INDEX = 'idx_shared_values_history_ns_k_id';      // one key's history, newest first
const NS_INDEX = 'idx_shared_values_history_ns_id';      // a whole namespace's history, newest first (WHERE ns = ? ORDER BY id DESC)

const CREATE_HISTORY =
"CREATE TABLE `shared_values_history` (\n" +
"  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n" +
"  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'shared_namespaces.ns at the time of the write (no FK: history outlives a deleted namespace); utf8mb4_bin like the source column',\n" +
"  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'shared_values.k; NULL = a namespace event (ns_create / ns_update / ns_delete)',\n" +
"  `op` enum('ns_create','ns_update','ns_delete','create','update','delete') NOT NULL COMMENT 'what the write did. App-written only (relaxed sql_mode would store an unknown value as an empty string)',\n" +
"  `old_v` mediumtext DEFAULT NULL COMMENT 'before: the value (update / delete), or the namespace rules as JSON (ns_update; ns_delete adds key_count). NULL for a create. UNTRUSTED staff-written text',\n" +
"  `new_v` mediumtext DEFAULT NULL COMMENT 'after: the value (create / update), or the namespace rules as JSON (ns_create / ns_update). NULL for a delete. UNTRUSTED staff-written text',\n" +
"  `old_rev` int unsigned DEFAULT NULL COMMENT 'shared_values.rev before the write (update / delete); NULL otherwise',\n" +
"  `new_rev` int unsigned DEFAULT NULL COMMENT 'shared_values.rev after the write (create = 1 / update); NULL otherwise',\n" +
"  `changed_by` tinyint NOT NULL COMMENT 'users.user who wrote it, stamped by the server from the JWT (a live View-as: the target user)',\n" +
"  `changed_act` tinyint DEFAULT NULL COMMENT 'users.user of the human behind a live View-as session; NULL otherwise',\n" +
"  `changed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  PRIMARY KEY (`id`),\n" +
"  KEY `idx_shared_values_history_ns_k_id` (`ns`, `k`, `id`),\n" +
"  KEY `idx_shared_values_history_ns_id` (`ns`, `id`)\n" +
") ENGINE=InnoDB COMMENT='Shared values write history (routes/api.shared.js _history; the Shared values admin page): one row per successful write, in its transaction. UNTRUSTED staff-written text — render with textContent. No retention yet (ref/plans.md).'";

// What a correct table looks like in information_schema: name → [type,
// nullable, collation (null = not a string column / not checked)].
const EXPECTED = {
  id:          ['bigint unsigned', 'NO', null],
  ns:          ['varchar(64)', 'NO', 'utf8mb4_bin'],
  k:           ['varchar(64)', 'YES', 'utf8mb4_bin'],
  op:          ["enum('ns_create','ns_update','ns_delete','create','update','delete')", 'NO', 'utf8mb4_general_ci'],
  old_v:       ['mediumtext', 'YES', 'utf8mb4_general_ci'],
  new_v:       ['mediumtext', 'YES', 'utf8mb4_general_ci'],
  old_rev:     ['int unsigned', 'YES', null],
  new_rev:     ['int unsigned', 'YES', null],
  changed_by:  ['tinyint', 'NO', null],
  changed_act: ['tinyint', 'YES', null],
  changed_at:  ['datetime', 'NO', null],
};
const EXPECTED_PK = ['id'];
const EXPECTED_INDEX = ['ns', 'k', 'id'];
const EXPECTED_NS_INDEX = ['ns', 'id'];

async function tableInfo(conn) {
  const [[t]] = await conn.query(
    `SELECT TABLE_TYPE type, TABLE_COLLATION coll FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  if (!t) return null;
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLLATION_NAME coll, EXTRA extra
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`, [TABLE]);
  const [idx] = await conn.query(
    `SELECT INDEX_NAME name, COLUMN_NAME col FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [TABLE]);
  const indexes = {};
  for (const r of idx) (indexes[r.name] = indexes[r.name] || []).push(r.col);
  return { type: t.type, coll: t.coll, cols, indexes };
}

/** Problems with an EXISTING table's shape (empty = it is ours, correct). */
function shapeProblems(info) {
  const out = [];
  if (info.type !== 'BASE TABLE') out.push(`${TABLE} exists as a ${info.type}`);
  if (info.coll !== 'utf8mb4_general_ci') out.push(`${TABLE} table collation is ${info.coll}, expected utf8mb4_general_ci`);
  const got = Object.fromEntries(info.cols.map((c) => [c.name, c]));
  const names = info.cols.map((c) => c.name);
  if (names.join(',') !== Object.keys(EXPECTED).join(',')) {
    out.push(`${TABLE} columns are [${names.join(', ')}], expected [${Object.keys(EXPECTED).join(', ')}]`);
  }
  for (const [name, [type, nullable, coll]] of Object.entries(EXPECTED)) {
    const c = got[name];
    if (!c) continue;
    if (c.type !== type) out.push(`${TABLE}.${name} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) out.push(`${TABLE}.${name} nullable=${c.nullable}, expected ${nullable}`);
    if (coll && c.coll !== coll) out.push(`${TABLE}.${name} collation ${c.coll}, expected ${coll}`);
  }
  if (got.id && !/auto_increment/i.test(String(got.id.extra || ''))) out.push(`${TABLE}.id is not AUTO_INCREMENT`);
  const pk = (info.indexes.PRIMARY || []).join(',');
  if (pk !== EXPECTED_PK.join(',')) out.push(`${TABLE} primary key is (${pk}), expected (${EXPECTED_PK.join(', ')})`);
  const ix = (info.indexes[INDEX] || []).join(',');
  if (ix !== EXPECTED_INDEX.join(',')) out.push(`${TABLE} index ${INDEX} is (${ix}), expected (${EXPECTED_INDEX.join(', ')})`);
  const nx = (info.indexes[NS_INDEX] || []).join(',');
  if (nx !== EXPECTED_NS_INDEX.join(',')) out.push(`${TABLE} index ${NS_INDEX} is (${nx}), expected (${EXPECTED_NS_INDEX.join(', ')})`);
  return out;
}

/** Live state: the table absent | present, plus what is wrong. */
async function state(conn) {
  const problems = [];
  // The table names no default charset, so it inherits the database default —
  // which must be the core tables' collation (ref/SCHEMA_CONVENTIONS.md).
  const [[db]] = await conn.query(
    'SELECT DEFAULT_COLLATION_NAME coll FROM information_schema.schemata WHERE schema_name = DATABASE()');
  if (!db || db.coll !== 'utf8mb4_general_ci') {
    problems.push(`the database default collation is ${db && db.coll}, expected utf8mb4_general_ci`);
  }
  const info = await tableInfo(conn);
  if (info) problems.push(...shapeProblems(info));
  return { history: info ? 'present' : 'absent', problems };
}

async function run(conn, { apply, log = console.log }) {
  log(`sharedValuesHistoryMigrate — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);

  const st = await state(conn);
  if (st.problems.length) {
    log(`Unexpected live state:\n  ${st.problems.join('\n  ')}`);
    log('\nNO-GO — re-verify by hand; this script never alters what it did not create. Nothing was changed.');
    return { ok: false };
  }
  log(`${TABLE}: ${st.history}`);

  if (st.history === 'present') {
    log('\nGO — the migration is already applied; nothing to do. Next: land + deploy the shared-values history code.');
    return { ok: true };
  }
  if (!apply) {
    log('\nPlan:');
    log(`  CREATE TABLE \`${TABLE}\` (…) — ref/migrations/2026-10-28_shared_values_history.sql`);
    log('\nGO — base state matches. Next: node scripts/sharedValuesHistoryMigrate.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  try {
    await conn.query(CREATE_HISTORY);
    log(`✓ ${TABLE} created`);
  } catch (err) {
    log(`\n${err.message}`);
    log('NO-GO — nothing further was changed; re-run (CHECK, then --apply) to resume.');
    return { ok: false };
  }

  const after = await state(conn);
  const probs = [...after.problems];
  if (after.history !== 'present') probs.push(`${TABLE} is ${after.history}`);
  if (probs.length) {
    log(`Applied, but:\n  ${probs.join('\n  ')}`);
    log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  log('✓ verified (columns, types, collations, primary key, auto_increment, the (ns, k, id) and (ns, id) indexes)');
  log('\nGO — migration applied. Next: land + deploy the shared-values history code (then npm run db:ref).');
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
  const apply = process.argv.includes('--apply');
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

module.exports = { run, state, shapeProblems, CREATE_HISTORY, EXPECTED, EXPECTED_PK, EXPECTED_INDEX, EXPECTED_NS_INDEX, TABLE, INDEX, NS_INDEX };
