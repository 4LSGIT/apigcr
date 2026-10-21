#!/usr/bin/env node
// scripts/caseyP4Idempotency.js
//
/**
 * Ask Casey actions P4-minimal — create the `request_idempotency` table.
 *
 * The applied SQL is ref/migrations/2026-10-22_request_idempotency.sql and
 * this script RUNS THAT FILE's CREATE TABLE verbatim (line-extracted, never
 * regex-split: the column COMMENTs would break a `[^;]*;` match). The reader
 * for the table is lib/requestIdempotency.js.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production — the
 * same setup `npm run db:ref` uses; the Cloud SQL proxy is started if .env
 * opts in):
 *
 *   node scripts/caseyP4Idempotency.js           # CHECK — read-only
 *   node scripts/caseyP4Idempotency.js --apply   # create it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left, so
 * re-running after a failure is safe.
 *
 * ── WHY A NODE SCRIPT ON ONE CONNECTION (not the SU console) ──────────────
 * /admin/db/batch runs each statement on whichever pooled connection is free,
 * so a SESSION setting cannot reach the statement it is meant for. This needs
 * one: `lock_wait_timeout = 5`. The table's FK to `users` takes a SHARED
 * metadata lock on `users` while it is created; queued behind a long
 * transaction at the global default (a year on this instance) that would stall
 * every new query against `users` — i.e. every login and every task read.
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - sql_mode has no STRICT_TRANS_TABLES (the app's invariant; the column
 *     widths and the app-side key validation are written for relaxed mode);
 *   - `users` exists and `users`.`user` is TINYINT, so the FK can be created
 *     at all and an actor id is never clamped into a different user;
 *   - user 0 exists (the no-staff-user actor the app falls back to);
 *   - no `request_idempotency` table exists with a DIFFERENT shape than the
 *     migration's (a half-applied or hand-made one stops the run).
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   the table exists with the migration's exact columns, types, nullability
 *   and collations, the (user_id, scope, idem_key) UNIQUE key, the created_at
 *   index and the users FK; and a smoke test — inside a transaction that is
 *   ROLLED BACK — proves on this engine that a second claim for the same key
 *   is ER_DUP_ENTRY, that the same key in a different case is a DIFFERENT row
 *   (utf8mb4_bin), that a JSON result round-trips, and that the leftover rows
 *   disappear with the rollback.
 *
 * ── ROLLBACK ──────────────────────────────────────────────────────────────
 *   DROP TABLE request_idempotency; — the table is inert to any caller that
 *   sends no Idempotency-Key header.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TABLE         = 'request_idempotency';
const MIGRATION_REL = 'ref/migrations/2026-10-22_request_idempotency.sql';
const MIGRATION_ABS = path.join(__dirname, '..', MIGRATION_REL);

const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS   = 120_000;

// The shape the migration promises. Verified column by column, both in CHECK
// (so a hand-made table is caught before --apply) and after the create.
const EXPECTED_COLUMNS = {
  id:         { type: 'bigint unsigned', nullable: 'NO',  collation: null },
  user_id:    { type: 'tinyint',         nullable: 'NO',  collation: null },
  scope:      { type: 'varchar(64)',     nullable: 'NO',  collation: 'utf8mb4_general_ci' },
  idem_key:   { type: 'varchar(100)',    nullable: 'NO',  collation: 'utf8mb4_bin' },
  status:     { type: "enum('in_flight','applied')", nullable: 'NO', collation: 'utf8mb4_general_ci' },
  result:     { type: 'json',            nullable: 'YES', collation: null },
  created_at: { type: 'datetime',        nullable: 'NO',  collation: null },
  updated_at: { type: 'datetime',        nullable: 'NO',  collation: null },
};
const EXPECTED_UNIQUE = ['user_id', 'scope', 'idem_key'];

const hasStrict = mode => /STRICT_(TRANS|ALL)_TABLES/i.test(String(mode || ''));

/**
 * Key-order-insensitive JSON (CLAUDE.md: MySQL re-orders JSON object keys on
 * write — it sorts them by length then lexicographically — so a JSON.stringify
 * of what you SENT never equals a JSON.stringify of what you read back).
 */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** One timed query; returns rows. */
async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

/**
 * The CREATE TABLE statement, taken from the migration file by LINES.
 * Column COMMENTs may contain `;` and `)`, so the end is the first line that
 * is exactly a `) ENGINE=...;` line (reference_local_mysql84 landmine).
 */
function createStatement(file = MIGRATION_ABS) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => new RegExp(`^CREATE TABLE IF NOT EXISTS ${TABLE}\\s*\\(`).test(l.trim()));
  if (start < 0) throw new Error(`${MIGRATION_REL} has no "CREATE TABLE IF NOT EXISTS ${TABLE} (" line`);
  // The tail starts at the `) ENGINE=` line and runs to the first line that
  // ENDS in `;` — the table COMMENT sits on its own continuation line, and a
  // column COMMENT may contain both `;` and `)`.
  let tail = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\)\s*ENGINE=/.test(lines[i])) { tail = i; break; }
  }
  if (tail < 0) throw new Error(`${MIGRATION_REL}: no ") ENGINE=..." line after the CREATE`);
  let end = -1;
  for (let i = tail; i < lines.length; i++) {
    if (/;\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) throw new Error(`${MIGRATION_REL}: the CREATE statement is not terminated by ";"`);
  const sql = lines.slice(start, end + 1).join('\n').trim().replace(/;$/, '');
  if (!/^CREATE TABLE IF NOT EXISTS/.test(sql)) throw new Error('extracted statement is not a CREATE TABLE');
  return sql;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const [who] = await q(conn,
    '/* p4idem:who */ SELECT CURRENT_USER() AS cu, @@SESSION.sql_mode AS sm, DATABASE() AS db, VERSION() AS v');

  const [usersCol] = await q(conn,
    '/* p4idem:userscol */ SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['users', 'user']);

  const [zero] = await q(conn,
    '/* p4idem:user0 */ SELECT `user` AS u, user_name AS n FROM users WHERE `user` = 0');

  const cols = await q(conn,
    '/* p4idem:cols */ SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, ' +
    'COLLATION_NAME AS collation_name FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [TABLE]);

  const idx = await q(conn,
    '/* p4idem:idx */ SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, ' +
    'COLUMN_NAME AS col FROM information_schema.STATISTICS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [TABLE]);

  const fks = await q(conn,
    '/* p4idem:fk */ SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, ' +
    'k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col ' +
    'FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = DATABASE() ' +
    'AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL', [TABLE]);

  let rowCount = null;
  if (cols.length) {
    const [c] = await q(conn, `/* p4idem:count */ SELECT COUNT(*) AS n FROM \`${TABLE}\``);
    rowCount = Number(c.n);
  }

  return {
    user: who.cu, sqlMode: who.sm, db: who.db, version: who.v,
    usersColumnType: usersCol ? usersCol.t : null,
    userZero: zero ? zero.n : null,
    exists: cols.length > 0,
    columns: cols,
    indexes: idx,
    fks,
    rowCount,
  };
}

/** Differences between the live table and the migration's promise. */
function shapeProblems(s) {
  const bad = [];
  const seen = new Map(s.columns.map(c => [c.name, c]));
  for (const [name, want] of Object.entries(EXPECTED_COLUMNS)) {
    const got = seen.get(name);
    if (!got) { bad.push(`${TABLE}.${name} is missing`); continue; }
    if (got.type.toLowerCase() !== want.type) bad.push(`${TABLE}.${name} is ${got.type}, expected ${want.type}`);
    if (got.nullable !== want.nullable) bad.push(`${TABLE}.${name} is nullable=${got.nullable}, expected ${want.nullable}`);
    const coll = got.collation_name || null;
    if (coll !== want.collation) bad.push(`${TABLE}.${name} collation is ${coll}, expected ${want.collation}`);
  }
  for (const c of s.columns) if (!EXPECTED_COLUMNS[c.name]) bad.push(`${TABLE}.${c.name} is an unexpected column`);

  const byIndex = new Map();
  for (const r of s.indexes) {
    if (!byIndex.has(r.name)) byIndex.set(r.name, { unique: r.non_unique === 0, cols: [] });
    byIndex.get(r.name).cols.push(r.col);
  }
  const uniques = [...byIndex.entries()].filter(([n, v]) => v.unique && n !== 'PRIMARY');
  const wanted = uniques.find(([, v]) => v.cols.join(',') === EXPECTED_UNIQUE.join(','));
  if (!wanted) {
    bad.push(`no UNIQUE key on (${EXPECTED_UNIQUE.join(', ')}) — found ${uniques.length ? uniques.map(([n, v]) => `${n}(${v.cols.join(',')})`).join(', ') : 'none'}`);
  }
  if (!byIndex.has('idx_request_idempotency_created')) bad.push('idx_request_idempotency_created is missing');
  if (!s.fks.some(f => f.col === 'user_id' && f.ref_table === 'users' && f.ref_col === 'user')) {
    bad.push('the user_id -> users.`user` foreign key is missing');
  }
  return bad;
}

function plan(s) {
  const problems = [];
  const notes = [];

  if (hasStrict(s.sqlMode)) {
    problems.push(`session sql_mode has STRICT mode ("${s.sqlMode}") — this app runs relaxed; stop and check the connection`);
  }
  if (!s.usersColumnType) problems.push('users.`user` not found — wrong database?');
  else if (s.usersColumnType.toLowerCase() !== 'tinyint') {
    problems.push(`users.\`user\` is ${s.usersColumnType}, expected tinyint — the FK and the TINYINT actor column assume it`);
  }
  if (s.userZero == null) problems.push('users.`user` = 0 does not exist — the no-staff-user actor id has no row to reference');

  if (s.exists) {
    const bad = shapeProblems(s);
    if (bad.length) problems.push(...bad.map(b => `existing table: ${b}`));
    else notes.push(`${TABLE} already exists and matches the migration (${s.rowCount} row(s))`);
  }

  return { problems, notes, done: s.exists && !problems.length, steps: s.exists ? [] : ['create'] };
}

// ─────────────────────────────────────────────────────────────
// Smoke test (inside a transaction that is ROLLED BACK)
// ─────────────────────────────────────────────────────────────

async function smoke(conn, log) {
  const key = `migration-smoke-${Date.now().toString(36)}`;
  const SCOPE = 'migration.smoke';
  await q(conn, 'START TRANSACTION');
  try {
    await q(conn, `INSERT INTO \`${TABLE}\` (user_id, scope, idem_key, status) VALUES (0, ?, ?, 'in_flight')`, [SCOPE, key]);

    let dup = null;
    try {
      await q(conn, `INSERT INTO \`${TABLE}\` (user_id, scope, idem_key, status) VALUES (0, ?, ?, 'in_flight')`, [SCOPE, key]);
    } catch (err) { dup = err.code; }
    if (dup !== 'ER_DUP_ENTRY') throw new Error(`a second claim for the same key gave ${dup || 'NO ERROR'}, expected ER_DUP_ENTRY`);
    log('  ✓ a second claim for the same (user, scope, key) is ER_DUP_ENTRY');

    // utf8mb4_bin: the same key in a different case must be a DIFFERENT row.
    await q(conn, `INSERT INTO \`${TABLE}\` (user_id, scope, idem_key, status) VALUES (0, ?, ?, 'in_flight')`, [SCOPE, key.toUpperCase()]);
    log('  ✓ the same key upper-cased is a different row (utf8mb4_bin)');

    const payload = { status: 'success', task_id: 4242, note: 'smoke' };
    const upd = await q(conn, `UPDATE \`${TABLE}\` SET status = 'applied', result = ? WHERE scope = ? AND idem_key = ? AND status = 'in_flight'`, [JSON.stringify(payload), SCOPE, key]);
    if (upd.affectedRows !== 1) throw new Error(`settling the claim touched ${upd.affectedRows} rows, expected 1`);

    const [back] = await q(conn, `SELECT status, result, TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_s FROM \`${TABLE}\` WHERE scope = ? AND idem_key = ?`, [SCOPE, key]);
    const got = typeof back.result === 'string' ? JSON.parse(back.result) : back.result;
    if (back.status !== 'applied') throw new Error(`status came back "${back.status}", expected "applied"`);
    // Compared key-order-insensitively: MySQL stores JSON object keys in its
    // own order, so the bytes differ while every value round-trips.
    if (stableJson(got) !== stableJson(payload)) throw new Error(`the JSON result did not round-trip: ${JSON.stringify(got)}`);
    if (!(Number(back.age_s) >= 0 && Number(back.age_s) < 60)) throw new Error(`server-side age is ${back.age_s}s, expected a fresh row`);
    log('  ✓ settle to applied stores and round-trips the JSON result (key order is MySQL\'s), with a server-side age');
  } finally {
    await q(conn, 'ROLLBACK');
  }
  const [left] = await q(conn, `SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE scope = ?`, [SCOPE]);
  if (Number(left.n) !== 0) throw new Error(`${left.n} smoke row(s) survived the rollback — remove them by hand`);
  log('  ✓ every smoke row disappeared with the rollback');
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== Casey P4 — create ${TABLE} — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const create = createStatement();
  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  say(`session sql_mode: "${s.sqlMode}"`);
  say(`users.\`user\`: ${s.usersColumnType || 'MISSING'}; user 0 = ${s.userZero == null ? 'MISSING' : s.userZero}`);
  say(`${TABLE}: ${s.exists ? `exists, ${s.columns.length} column(s), ${s.rowCount} row(s)` : 'absent'}`);

  const p = plan(s);
  for (const n of p.notes) say(`note: ${n}`);
  if (p.problems.length) {
    say('\nPROBLEMS:');
    for (const x of p.problems) say(`  - ${x}`);
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed.`;
    say(`\n${line}`);
    return { ok: false, line, state: s };
  }

  if (p.done) {
    if (!apply) {
      const line = `ALREADY APPLIED — ${TABLE} exists and matches ${MIGRATION_REL}. GO: deploy the backend.`;
      say(`\n${line}`);
      return { ok: true, line, state: s, done: true };
    }
  } else {
    say(`\nPLAN:\n  1. SET SESSION lock_wait_timeout = 5\n  2. run ${MIGRATION_REL}'s CREATE TABLE (${create.split('\n').length} lines)`);
    say('  then: re-read the shape and smoke-test claim / duplicate / case / settle (rolled back)');
    if (!apply) {
      const line = `CHECK OK — GO. Next: node scripts/caseyP4Idempotency.js --apply`;
      say(`\n${line}`);
      return { ok: true, line, state: s, plan: p };
    }
  }

  // ── apply ──
  say('');
  const done = [];
  try {
    await q(conn, 'SET SESSION lock_wait_timeout = 5');
    if (p.steps.includes('create')) {
      await q(conn, create, [], DDL_TIMEOUT_MS);
      say(`  ✓ CREATE TABLE ${TABLE}`);
      done.push(`${TABLE} created`);
    }

    // ── verify the end state ──
    const after = await readState(conn);
    if (!after.exists) throw new Error(`${TABLE} does not exist after the create`);
    const bad = shapeProblems(after);
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: ${after.columns.length} columns with the migration's types and collations, ` +
        `the (${EXPECTED_UNIQUE.join(', ')}) UNIQUE key, idx_request_idempotency_created, and the users FK`);

    await smoke(conn, say);
  } catch (err) {
    say(`\n  ✗ ${err.message}`);
    const line = `NO-GO — stopped ${done.length ? `after: ${done.join('; ')}` : 'before any change'}. ` +
      'Re-running --apply resumes from the live state. Do NOT deploy until it says GO.';
    say(`\n${line}`);
    return { ok: false, line, state: s, done };
  }

  const line = `P4 APPLIED — GO. ${TABLE} is live with the verified shape; next: deploy the backend (git go). ` +
    'The pre-commit hook regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, done };
}

module.exports = { TABLE, MIGRATION_ABS, EXPECTED_COLUMNS, EXPECTED_UNIQUE, createStatement, readState, shapeProblems, plan, smoke, run, stableJson };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
