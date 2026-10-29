#!/usr/bin/env node
// scripts/yisramailP3Migrate.js
//
/**
 * YisraMail P3 — creates comm_unsub_tokens (the per-recipient unsubscribe
 * token behind /u/<token>). ref/YISRAMAIL_DESIGN.md §4.2 / §4.5; the DDL is
 * ref/migrations/2026-10-30_yisramail_p3_unsub_tokens.sql, read from disk so
 * the file and the applied table can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailP3Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailP3Migrate.js --apply    # CREATE TABLE, then verify
 *   3. backend deploy
 *
 * CHECK (default): P1's consent tables exist (P3 records through
 * optoutService.recordConsent — NO-GO without them); comm_unsub_tokens is
 * absent (GO, next: --apply) or present with the expected shape (GO, nothing
 * to do). A present table with another shape is NO-GO — nothing is altered.
 *
 * --apply: runs the migration file's CREATE TABLE IF NOT EXISTS (a no-op when
 * the table is there), then VERIFIES the end state:
 *   - every column with its type, nullability and collation (`token` must be
 *     char(22) utf8mb4_bin — base62 tokens are case-sensitive);
 *   - PRIMARY KEY (token), KEY ix_dest (destination), KEY ix_campaign;
 *   - on the engine, inside a transaction that is ROLLED BACK: two tokens that
 *     differ only in letter case insert as two rows and an exact lookup finds
 *     one of them — the collation doing its job, not just reading right.
 * Re-runnable: a run that stopped part-way resumes from wherever it is.
 *
 * USAGE (repo root, .env reaching production — the `npm run db:ref` setup).
 * Each run ends with ONE line: GO or NO-GO, naming the next step.
 * One connection; session settings: time_zone +00:00, lock_wait_timeout 10
 * (the CREATE takes a metadata lock on a NEW name only, but nothing here may
 * ever wait a year behind a stray transaction).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-10-30_yisramail_p3_unsub_tokens.sql');
const TABLE = 'comm_unsub_tokens';
const P1_TABLES = Object.freeze(['comm_topics', 'comm_consent_events', 'comm_consent_state']);

/** The expected columns: name → [COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME | null]. */
const EXPECTED_COLUMNS = Object.freeze({
  token:       ['char(22)', 'NO', 'utf8mb4_bin'],
  channel:     ["enum('email')", 'NO', 'utf8mb4_general_ci'],
  destination: ['varchar(254)', 'NO', 'utf8mb4_general_ci'],
  topic_key:   ['varchar(40)', 'NO', 'utf8mb4_general_ci'],
  campaign_id: ['int', 'YES', null],
  contact_id:  ['int unsigned', 'YES', null],
  send_ref:    ['varchar(64)', 'YES', 'utf8mb4_general_ci'],
  created_at:  ['datetime', 'NO', null],
  used_at:     ['datetime', 'YES', null],
});
/** index name → its columns in order. */
const EXPECTED_INDEXES = Object.freeze({
  PRIMARY:     ['token'],
  ix_dest:     ['destination'],
  ix_campaign: ['campaign_id'],
});

const SQL = Object.freeze({
  tables: `SELECT TABLE_NAME AS t FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLLATION_NAME AS coll
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  indexes: `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
});

// The two smoke tokens: identical but for the case of the last letter.
const SMOKE_A = 'P3smokeCaseProbeTokenA';
const SMOKE_B = 'P3smokeCaseProbeTokena';

/** The migration file's statements. Each ends with ';' at END OF LINE — a COMMENT may hold ';' mid-line. */
function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

/** MySQL 8 reports `int(11)` on some servers and `int` on others — compare without display widths. */
function normType(t) {
  return String(t || '').toLowerCase().replace(/\b(int|bigint|tinyint|smallint|mediumint)\(\d+\)/g, '$1');
}

/** The table's shape against EXPECTED_* → [problem lines] ([] = as expected). */
async function shapeProblems(conn) {
  const problems = [];
  const [cols] = await conn.query(SQL.columns, [TABLE]);
  const have = new Map(cols.map((c) => [c.name, c]));
  for (const [name, [type, nullable, coll]] of Object.entries(EXPECTED_COLUMNS)) {
    const c = have.get(name);
    if (!c) { problems.push(`column ${name} is missing`); continue; }
    if (normType(c.type) !== type) problems.push(`${name} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) problems.push(`${name} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
    if ((c.coll || null) !== coll) problems.push(`${name} collation ${c.coll || 'none'}, expected ${coll || 'none'}`);
  }
  for (const name of have.keys()) if (!EXPECTED_COLUMNS[name]) problems.push(`unexpected column ${name}`);
  const [idx] = await conn.query(SQL.indexes, [TABLE]);
  const byName = new Map();
  for (const r of idx) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r.col);
  }
  for (const [name, colsWanted] of Object.entries(EXPECTED_INDEXES)) {
    const got = byName.get(name);
    if (!got) problems.push(`index ${name} is missing`);
    else if (got.join(',') !== colsWanted.join(',')) problems.push(`index ${name} is (${got.join(', ')}), expected (${colsWanted.join(', ')})`);
  }
  return problems;
}

/**
 * The collation, proved on the engine in a transaction that is ROLLED BACK:
 * two tokens differing only in case are two rows, and an exact lookup finds
 * exactly the one it names. → null when it holds, else the problem.
 */
async function caseProbe(conn) {
  await conn.beginTransaction();
  try {
    const ins = `INSERT INTO ${TABLE} (token, destination, topic_key) VALUES (?, 'p3-smoke@invalid.example', 'p3_smoke')`;
    await conn.query(ins, [SMOKE_A]);
    await conn.query(ins, [SMOKE_B]);   // a case-insensitive key would refuse this one (ER_DUP_ENTRY)
    const [rows] = await conn.query(`SELECT token FROM ${TABLE} WHERE token = ?`, [SMOKE_A]);
    if (rows.length !== 1 || rows[0].token !== SMOKE_A) return `an exact lookup of ${SMOKE_A} returned ${rows.length} row(s)`;
    return null;
  } catch (err) {
    return err && err.code === 'ER_DUP_ENTRY'
      ? 'two tokens that differ only in case collide — token is not case-sensitive'
      : `the case probe failed: ${err.message}`;
  } finally {
    await conn.rollback().catch(() => {});
  }
}

/**
 * CHECK (apply:false) or create + verify (apply:true). → { ok, line, created }
 */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const [present] = await conn.query(SQL.tables, [[...P1_TABLES, TABLE]]);
  const have = new Set(present.map((r) => r.t));
  const missingP1 = P1_TABLES.filter((t) => !have.has(t));
  if (missingP1.length) {
    const line = `NO-GO — P1's consent table(s) ${missingP1.join(', ')} are missing: P3 records through them. Apply P1 first. Nothing was changed.`;
    say(line);
    return { ok: false, line, created: false };
  }
  const exists = have.has(TABLE);
  say(`${TABLE}: ${exists ? 'present' : 'absent'}`);

  if (exists) {
    const problems = await shapeProblems(conn);
    if (problems.length) {
      problems.forEach((p) => say(`  ✗ ${p}`));
      const line = `NO-GO — ${TABLE} exists with another shape (above). Nothing was changed; this script never alters it.`;
      say(line);
      return { ok: false, line, created: false };
    }
  }

  if (!apply) {
    const line = exists
      ? `CHECK OK — ${TABLE} is in place with the expected shape. GO (nothing to apply; next: the backend deploy).`
      : `CHECK OK — GO. Next: node scripts/yisramailP3Migrate.js --apply`;
    say(line);
    return { ok: true, line, created: false };
  }

  if (!exists) {
    for (const s of statements()) await conn.query(s);
    say(`  ✓ created ${TABLE}`);
  }
  const problems = await shapeProblems(conn);
  const probe = problems.length ? null : await caseProbe(conn);
  if (problems.length || probe) {
    problems.forEach((p) => say(`  ✗ ${p}`));
    if (probe) say(`  ✗ ${probe}`);
    const line = `NO-GO — ${TABLE} does not verify (above). Paste this output to Claude; do not deploy.`;
    say(line);
    return { ok: false, line, created: !exists };
  }
  say('  ✓ shape verified; token is case-sensitive on the engine (probe rolled back)');
  const line = `${exists ? 'ALREADY IN PLACE' : 'CREATED'} — ${TABLE} verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, created: !exists };
}

module.exports = { run, statements, shapeProblems, caseProbe, MIGRATION, TABLE, P1_TABLES, EXPECTED_COLUMNS, EXPECTED_INDEXES, SQL };

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
