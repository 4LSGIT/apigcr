#!/usr/bin/env node
// scripts/yisramailT2Migrate.js
//
/**
 * YisraMail T2 — adds campaign_results' delivery columns (provider_message_id,
 * delivery_status, delivered_at, bounced_at, complained_at, delivery_diag,
 * bounce_subtype) and
 * KEY ix_provider_message_id (ref/YISRAMAIL_DESIGN.md §5.4). The definitions,
 * comments included, are read from
 * ref/migrations/2026-11-02_yisramail_t2_campaign_results_delivery.sql so the
 * file and the applied table can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailT2Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailT2Migrate.js --apply    # ALTER, then verify
 *   3. backend deploy
 *
 * CHECK (default), read-only: campaign_results has exactly the pre-T2 columns
 * plus any T2 column already present WITH the expected definition (a re-run);
 * the index is absent or exactly (provider_message_id). Anything else is
 * NO-GO, nothing altered. Prints the row count (the ALTER's copy cost — over
 * 100k it says so).
 * --apply: one ALTER adding whatever is missing (columns and/or the index),
 * then VERIFIES columns, types, nullability, defaults, collation, comments and
 * the index. Re-runnable: resumes from wherever a failed run stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10 — an ALTER
 * queued behind a long transaction gives up in seconds (NO-GO, re-run later)
 * instead of stalling every campaign send on the table. One GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-02_yisramail_t2_campaign_results_delivery.sql');
const TABLE = 'campaign_results';
const INDEX = 'ix_provider_message_id';
const BIG_TABLE = 100000;

/** The live columns before T2 (verified 2026-11-02), in order. */
const BASE_COLUMNS = Object.freeze(['result_id', 'campaign_id', 'contact_id', 'status', 'error', 'sent_at', 'result_meta']);

/** T2 columns: name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null]; comments come from the file. */
const EXPECTED_COLUMNS = Object.freeze({
  provider_message_id: ['varchar(128)', 'YES', null, 'utf8mb4_general_ci'],
  delivery_status: ["enum('unknown','delivered','bounced_hard','bounced_soft','complained','rejected')", 'NO', 'unknown', 'utf8mb4_general_ci'],
  delivered_at: ['datetime(3)', 'YES', null, null],
  bounced_at: ['datetime(3)', 'YES', null, null],
  complained_at: ['datetime(3)', 'YES', null, null],
  delivery_diag: ['varchar(255)', 'YES', null, 'utf8mb4_general_ci'],
  bounce_subtype: ['varchar(40)', 'YES', null, 'utf8mb4_general_ci'],
});
const INDEX_COLUMNS = Object.freeze(['provider_message_id']);

const SQL = Object.freeze({
  table: `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  index: `SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`,
  rows: `SELECT COUNT(*) AS n FROM campaign_results`,
});

/** The file's clauses: { columns: {name → clause}, index: clause | null }. One line each; COMMENTs hold ',' and ';'. */
function clauses() {
  const out = { columns: {}, index: null };
  for (const line of fs.readFileSync(MIGRATION, 'utf8').split('\n')) {
    const c = /^\s*(ADD COLUMN (\w+) .*?)[,;]\s*$/.exec(line);
    if (c) { out.columns[c[2]] = c[1]; continue; }
    const k = /^\s*(ADD KEY (\w+) \(.*\))[,;]\s*$/.exec(line);
    if (k) out.index = k[1];
  }
  return out;
}

function commentOf(clause) {
  const m = /COMMENT '((?:[^']|'')*)'$/.exec(clause);
  return m ? m[1].replace(/''/g, "'") : null;
}

/** The ALTER for what is missing: column names (file order) and/or the index. */
function alterSql(missingColumns, withIndex) {
  const c = clauses();
  const parts = missingColumns.map((n) => c.columns[n]);
  if (withIndex) parts.push(c.index);
  return `ALTER TABLE ${TABLE}\n  ${parts.join(',\n  ')}`;
}

async function state(conn) {
  const [cols] = await conn.query(SQL.columns, [TABLE]);
  const have = new Map(cols.map((c) => [c.name, c]));
  const problems = [];
  for (const b of BASE_COLUMNS) if (!have.has(b)) problems.push(`pre-T2 column ${b} is missing`);
  for (const name of have.keys()) {
    if (!BASE_COLUMNS.includes(name) && !EXPECTED_COLUMNS[name]) problems.push(`unexpected column ${name}`);
  }
  const c = clauses();
  const missing = [];
  for (const [name, [type, nullable, dflt, coll]] of Object.entries(EXPECTED_COLUMNS)) {
    const col = have.get(name);
    if (!col) { missing.push(name); continue; }
    if (String(col.type).toLowerCase() !== type) problems.push(`${name} is ${col.type}, expected ${type}`);
    if (col.nullable !== nullable) problems.push(`${name} IS_NULLABLE ${col.nullable}, expected ${nullable}`);
    if ((col.dflt == null ? null : String(col.dflt)) !== dflt) problems.push(`${name} DEFAULT ${col.dflt}, expected ${dflt}`);
    if ((col.coll || null) !== coll) problems.push(`${name} collation ${col.coll || 'none'}, expected ${coll || 'none'}`);
    if (col.comment !== commentOf(c.columns[name] || '')) problems.push(`${name} comment differs from the migration file`);
  }
  const [idx] = await conn.query(SQL.index, [TABLE, INDEX]);
  const idxCols = idx.map((r) => r.col);
  const indexMissing = idxCols.length === 0;
  if (!indexMissing && idxCols.join(',') !== INDEX_COLUMNS.join(',')) problems.push(`index ${INDEX} is (${idxCols.join(', ')}), expected (${INDEX_COLUMNS.join(', ')})`);
  return { missing, indexMissing, problems };
}

/** CHECK (apply:false) or ALTER + verify (apply:true). → { ok, line, altered } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const c = clauses();
  const fileProblems = Object.keys(EXPECTED_COLUMNS).filter((n) => !c.columns[n] || !commentOf(c.columns[n]));
  if (fileProblems.length || !c.index) {
    const line = `NO-GO — the migration file lacks ${fileProblems.length ? `a commented ADD COLUMN for ${fileProblems.join(', ')}` : `the ADD KEY ${INDEX}`}. Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }
  const [[t]] = await conn.query(SQL.table, [TABLE]);
  if (!Number(t.n)) {
    const line = `NO-GO — table ${TABLE} does not exist in this database. Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }
  const [[rc]] = await conn.query(SQL.rows);
  const rows = Number(rc.n);
  say(`${TABLE}: ${rows} row(s)${rows > BIG_TABLE ? ` — over ${BIG_TABLE}: the ALTER copies them; lock_wait_timeout protects the send queue, the copy time is the cost` : ''}`);

  let st = await state(conn);
  say(`${TABLE}: T2 columns ${st.missing.length ? `missing: ${st.missing.join(', ')}` : 'all present'}; index ${INDEX} ${st.indexMissing ? 'missing' : 'present'}`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = `NO-GO — ${TABLE} is not in a state this script expects (above). Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }
  const todo = st.missing.length > 0 || st.indexMissing;

  if (!apply) {
    const line = todo
      ? 'CHECK OK — GO. Next: node scripts/yisramailT2Migrate.js --apply'
      : 'CHECK OK — the T2 columns and index are in place as expected. GO (nothing to apply; next: the backend deploy).';
    say(line);
    return { ok: true, line, altered: false };
  }

  let altered = false;
  if (todo) {
    try {
      await conn.query(alterSql(st.missing, st.indexMissing));
    } catch (err) {
      const line = `NO-GO — the ALTER failed: ${err.code || ''} ${err.message}. Nothing more was done; re-run --apply (it resumes).`;
      say(line);
      return { ok: false, line, altered: false };
    }
    altered = true;
    say(`  ✓ added ${[...st.missing, ...(st.indexMissing ? [`KEY ${INDEX}`] : [])].join(', ')}`);
  }
  st = await state(conn);
  if (st.problems.length || st.missing.length || st.indexMissing) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    if (st.missing.length) say(`  ✗ still missing: ${st.missing.join(', ')}`);
    if (st.indexMissing) say(`  ✗ still missing: KEY ${INDEX}`);
    const line = `NO-GO — ${TABLE} does not verify (above). Paste this output to Claude; do not deploy.`;
    say(line);
    return { ok: false, line, altered };
  }
  say('  ✓ verified: types, nullability, defaults, collation, comments and the index as in the migration file');
  const line = `${altered ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE} T2 columns verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, altered };
}

module.exports = { run, clauses, commentOf, alterSql, state, MIGRATION, TABLE, INDEX, BASE_COLUMNS, EXPECTED_COLUMNS, SQL };

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
