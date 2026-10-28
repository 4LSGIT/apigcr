#!/usr/bin/env node
// scripts/sharedValuesMigrate.js
//
/**
 * Shared values — the two tables behind routes/api.shared.js (settings-access
 * arc, 2026-10-28). The applied SQL is recorded verbatim in
 * ref/migrations/2026-10-28_shared_values.sql (tests/sharedValuesMigrate.test.js
 * pins the two together).
 *
 *   shared_namespaces  one row per namespace: write_mode, limits, created_by
 *   shared_values      one row per key: v, rev (compare-and-set), updated_by,
 *                      updated_act; FK ns → shared_namespaces ON DELETE CASCADE
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: run THIS FIRST, then land + deploy the shared-values code. │
 * │ Two NEW tables; nothing existing is altered. The old backend never names │
 * │ them; the new backend's /api/shared routes fail until they exist.        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/sharedValuesMigrate.js           # CHECK — read-only, prints plan
 *   node scripts/sharedValuesMigrate.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and creates only what is
 * absent. A table that already exists in ANY other shape is a NO-GO, never
 * altered.
 */

'use strict';

const NS_TABLE = 'shared_namespaces';
const VALUES_TABLE = 'shared_values';

const CREATE_NAMESPACES =
"CREATE TABLE `shared_namespaces` (\n" +
"  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'namespace name, ^[a-z0-9][a-z0-9_-]{0,63}$ (route-enforced); utf8mb4_bin so case never folds two names together (it is still PAD SPACE, so trailing spaces would: the pattern refusing spaces keeps every name distinct)',\n" +
"  `description` varchar(500) DEFAULT NULL COMMENT 'what the namespace is for (free text, shown in listings)',\n" +
"  `write_mode` enum('staff','creator','own_key') NOT NULL DEFAULT 'staff' COMMENT 'who may write values: staff = any staff; creator = created_by or a firm.settings holder; own_key = each user only the key equal to their users.user (firm.settings any). App-validated (relaxed sql_mode stores an unknown value as an empty string, which writes refuse)',\n" +
"  `max_value_bytes` int unsigned NOT NULL DEFAULT 65536 COMMENT 'largest value (UTF-8 bytes) a write may store; refused at the route BEFORE SQL (relaxed sql_mode would truncate silently). 1..1048576',\n" +
"  `max_keys` int unsigned NOT NULL DEFAULT 1000 COMMENT 'most keys the namespace may hold; a create beyond it is refused. 1..10000',\n" +
"  `created_by` tinyint NOT NULL COMMENT 'users.user who created it (manages it, with firm.settings holders)',\n" +
"  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n" +
"  PRIMARY KEY (`ns`)\n" +
") ENGINE=InnoDB COMMENT='Shared values: staff-created namespaces of staff-written key/value pairs (routes/api.shared.js). Values are UNTRUSTED text: render with textContent, never as HTML. Not config: app_settings is.'";

const CREATE_VALUES =
"CREATE TABLE `shared_values` (\n" +
"  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'shared_namespaces.ns (FK, cascade delete)',\n" +
"  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'key within the namespace, ^[a-z0-9][a-z0-9_-]{0,63}$ (route-enforced); utf8mb4_bin',\n" +
"  `v` mediumtext NOT NULL COMMENT 'the value, verbatim (UNTRUSTED staff-written text; size capped per namespace by the route)',\n" +
"  `rev` int unsigned NOT NULL DEFAULT 1 COMMENT 'compare-and-set revision: 1 on create, +1 per write; a write names the rev it read and is refused (409) when it moved',\n" +
"  `updated_by` tinyint NOT NULL COMMENT 'users.user of the last writer, stamped by the server from the JWT (a live View-as: the target user)',\n" +
"  `updated_act` tinyint DEFAULT NULL COMMENT 'users.user of the human behind a live View-as session that made the last write; NULL otherwise',\n" +
"  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n" +
"  PRIMARY KEY (`ns`, `k`),\n" +
"  CONSTRAINT `fk_shared_values_ns` FOREIGN KEY (`ns`) REFERENCES `shared_namespaces` (`ns`) ON DELETE CASCADE\n" +
") ENGINE=InnoDB COMMENT='Shared values (routes/api.shared.js): one row per key. UNTRUSTED staff-written text — render with textContent. Kept out of update_db / insert_db / query_db.'";

// What a correct table looks like in information_schema: name → [type,
// nullable, collation (null = not a string column / not checked)].
const EXPECTED = {
  [NS_TABLE]: {
    ns:              ['varchar(64)', 'NO', 'utf8mb4_bin'],
    description:     ['varchar(500)', 'YES', 'utf8mb4_general_ci'],
    write_mode:      ["enum('staff','creator','own_key')", 'NO', 'utf8mb4_general_ci'],
    max_value_bytes: ['int unsigned', 'NO', null],
    max_keys:        ['int unsigned', 'NO', null],
    created_by:      ['tinyint', 'NO', null],
    created_at:      ['datetime', 'NO', null],
    updated_at:      ['datetime', 'NO', null],
  },
  [VALUES_TABLE]: {
    ns:          ['varchar(64)', 'NO', 'utf8mb4_bin'],
    k:           ['varchar(64)', 'NO', 'utf8mb4_bin'],
    v:           ['mediumtext', 'NO', 'utf8mb4_general_ci'],
    rev:         ['int unsigned', 'NO', null],
    updated_by:  ['tinyint', 'NO', null],
    updated_act: ['tinyint', 'YES', null],
    created_at:  ['datetime', 'NO', null],
    updated_at:  ['datetime', 'NO', null],
  },
};
const EXPECTED_PK = { [NS_TABLE]: ['ns'], [VALUES_TABLE]: ['ns', 'k'] };

async function tableInfo(conn, table) {
  const [[t]] = await conn.query(
    `SELECT TABLE_TYPE type, TABLE_COLLATION coll FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
  if (!t) return null;
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLLATION_NAME coll
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`, [table]);
  const [pk] = await conn.query(
    `SELECT COLUMN_NAME name FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND table_name = ? AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION`, [table]);
  return { type: t.type, coll: t.coll, cols, pk: pk.map((r) => r.name) };
}

/** Problems with an EXISTING table's shape (empty = it is ours, correct). */
function shapeProblems(table, info) {
  const out = [];
  if (info.type !== 'BASE TABLE') out.push(`${table} exists as a ${info.type}`);
  if (info.coll !== 'utf8mb4_general_ci') out.push(`${table} table collation is ${info.coll}, expected utf8mb4_general_ci`);
  const want = EXPECTED[table];
  const got = Object.fromEntries(info.cols.map((c) => [c.name, c]));
  const names = info.cols.map((c) => c.name);
  if (names.join(',') !== Object.keys(want).join(',')) {
    out.push(`${table} columns are [${names.join(', ')}], expected [${Object.keys(want).join(', ')}]`);
  }
  for (const [name, [type, nullable, coll]] of Object.entries(want)) {
    const c = got[name];
    if (!c) continue;
    if (c.type !== type) out.push(`${table}.${name} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) out.push(`${table}.${name} nullable=${c.nullable}, expected ${nullable}`);
    if (coll && c.coll !== coll) out.push(`${table}.${name} collation ${c.coll}, expected ${coll}`);
  }
  if (info.pk.join(',') !== EXPECTED_PK[table].join(',')) {
    out.push(`${table} primary key is (${info.pk.join(', ')}), expected (${EXPECTED_PK[table].join(', ')})`);
  }
  return out;
}

async function fkPresent(conn) {
  const [rows] = await conn.query(
    `SELECT r.DELETE_RULE del, r.REFERENCED_TABLE_NAME ref
       FROM information_schema.referential_constraints r
      WHERE r.CONSTRAINT_SCHEMA = DATABASE() AND r.TABLE_NAME = ? AND r.CONSTRAINT_NAME = 'fk_shared_values_ns'`,
    [VALUES_TABLE]);
  return rows.length === 1 && rows[0].ref === NS_TABLE && rows[0].del === 'CASCADE';
}

/** Live state: each table absent | present, plus what is wrong. */
async function state(conn) {
  const problems = [];
  const st = {};
  // The tables name no charset, so they inherit the database default — which
  // must be the core tables' collation (ref/SCHEMA_CONVENTIONS.md).
  const [[db]] = await conn.query(
    'SELECT DEFAULT_COLLATION_NAME coll FROM information_schema.schemata WHERE schema_name = DATABASE()');
  if (!db || db.coll !== 'utf8mb4_general_ci') {
    problems.push(`the database default collation is ${db && db.coll}, expected utf8mb4_general_ci`);
  }
  for (const table of [NS_TABLE, VALUES_TABLE]) {
    const info = await tableInfo(conn, table);
    if (!info) { st[table] = 'absent'; continue; }
    const p = shapeProblems(table, info);
    if (p.length) problems.push(...p);
    st[table] = 'present';
  }
  if (st[VALUES_TABLE] === 'present' && !problems.length && !(await fkPresent(conn))) {
    problems.push(`${VALUES_TABLE} lacks fk_shared_values_ns → ${NS_TABLE} ON DELETE CASCADE`);
  }
  if (st[VALUES_TABLE] === 'present' && st[NS_TABLE] === 'absent') {
    problems.push(`${VALUES_TABLE} exists without ${NS_TABLE}`);
  }
  return { namespaces: st[NS_TABLE], values: st[VALUES_TABLE], problems };
}

async function run(conn, { apply, log = console.log }) {
  log(`sharedValuesMigrate — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);

  const st = await state(conn);
  if (st.problems.length) {
    log(`Unexpected live state:\n  ${st.problems.join('\n  ')}`);
    log('\nNO-GO — re-verify by hand; this script never alters what it did not create. Nothing was changed.');
    return { ok: false };
  }
  log(`${NS_TABLE}: ${st.namespaces}`);
  log(`${VALUES_TABLE}: ${st.values}`);

  if (st.namespaces === 'present' && st.values === 'present') {
    log('\nGO — the migration is already applied; nothing to do. Next: land + deploy the shared-values code.');
    return { ok: true };
  }
  if (!apply) {
    log('\nPlan:');
    if (st.namespaces === 'absent') log(`  CREATE TABLE \`${NS_TABLE}\` (…) — ref/migrations/2026-10-28_shared_values.sql`);
    if (st.values === 'absent') log(`  CREATE TABLE \`${VALUES_TABLE}\` (…) — same file`);
    log('\nGO — base state matches. Next: node scripts/sharedValuesMigrate.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  try {
    if (st.namespaces === 'absent') { await conn.query(CREATE_NAMESPACES); log(`✓ ${NS_TABLE} created`); }
    if (st.values === 'absent') { await conn.query(CREATE_VALUES); log(`✓ ${VALUES_TABLE} created`); }
  } catch (err) {
    log(`\n${err.message}`);
    log('NO-GO — whatever was reported done above stays done; re-run (CHECK, then --apply) to resume.');
    return { ok: false };
  }

  const after = await state(conn);
  const probs = [...after.problems];
  if (after.namespaces !== 'present') probs.push(`${NS_TABLE} is ${after.namespaces}`);
  if (after.values !== 'present') probs.push(`${VALUES_TABLE} is ${after.values}`);
  if (probs.length) {
    log(`Applied, but:\n  ${probs.join('\n  ')}`);
    log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  log('✓ both verified (columns, types, collations, primary keys, the cascade FK)');
  log('\nGO — migration applied. Next: land + deploy the shared-values code (then npm run db:ref).');
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

module.exports = { run, state, shapeProblems, CREATE_NAMESPACES, CREATE_VALUES, EXPECTED, EXPECTED_PK, NS_TABLE, VALUES_TABLE };
