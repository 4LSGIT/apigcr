#!/usr/bin/env node
// scripts/yisramailC6Migrate.js
//
/**
 * YisraMail C6 — open/click tracking (ref/YISRAMAIL_DESIGN.md §6.5 "As built (C6)"):
 *   campaign_results + opened_at, clicked_at (engagement axis, set once)
 *   campaign_clicks (NEW)        — one row per correlated SES Click event
 * The statements, comments included, are read from
 * ref/migrations/2026-11-05_yisramail_c6_open_click.sql so the file and the
 * applied schema can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailC6Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailC6Migrate.js --apply    # ALTER + CREATE, verify
 *   3. backend deploy → frontend → SES config-set flip (step 0 snippet)
 *
 * CHECK (default), read-only: each piece is absent, or present with exactly
 * the file's shape (type, nullability, default, collation, comment, keys —
 * a re-run). A HALF state (one of the two columns) is fine: --apply resumes
 * per statement. Anything misshapen is NO-GO, nothing changed.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10 — the
 * ALTERs take a metadata lock on live campaign_results (INSTANT algorithm,
 * but an MDL queued behind a long transaction would stall every query on the
 * table; 10 s caps the damage and the run resumes).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-05_yisramail_c6_open_click.sql');
const GC = 'utf8mb4_general_ci';
const RESULTS = 'campaign_results';
const CLICKS = 'campaign_clicks';

/** New campaign_results columns: name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA]. */
const EXPECTED_RESULT_COLUMNS = Object.freeze({
  opened_at:  ['datetime(3)', 'YES', null, null, ''],
  clicked_at: ['datetime(3)', 'YES', null, null, ''],
});

/** campaign_clicks: name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA] (file order). */
const CLICK_COLUMNS = Object.freeze({
  click_id:          ['int unsigned', 'NO', null, null, 'auto_increment'],
  campaign_id:       ['int', 'NO', null, null, ''],
  result_id:         ['int', 'NO', null, null, ''],
  link:              ['varchar(512)', 'NO', null, 'utf8mb4_bin', ''],
  clicked_at:        ['datetime(3)', 'NO', null, null, ''],
  provider_event_id: ['varchar(128)', 'NO', null, GC, ''],
});
/** index name → its columns in order. */
const EXPECTED_CLICK_INDEXES = Object.freeze({
  PRIMARY: ['click_id'],
  uk_provider_event: ['provider_event_id'],
  ix_campaign: ['campaign_id'],
});

const SQL = Object.freeze({
  table: `SELECT TABLE_COLLATION AS coll, TABLE_COMMENT AS comment FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, EXTRA AS extra, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  indexes: `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
});

/** The file's statements. Each ends with ';' at END OF LINE — a COMMENT may hold ';' mid-line. */
function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}
function alterSqlFor(column) {
  const re = new RegExp(`^ALTER TABLE ${RESULTS} ADD COLUMN ${column} `);
  return statements().find((s) => re.test(s)) || null;
}
function createSql() { return statements().find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${CLICKS} \\(`).test(s)) || null; }

function unq(s) { return s.replace(/''/g, "'"); }

/** A statement's COMMENT for a column line (ALTER: the whole statement is one column). */
function commentIn(line) {
  const c = /COMMENT '((?:[^']|'')*)',?\s*$/.exec(line.trim().replace(/;\s*$/, ''));
  return c ? unq(c[1]) : '';
}

/** The file's comments: { results: { col → comment }, clicks: { col → comment }, clicksTable }. */
function fileComments() {
  const results = {};
  for (const col of Object.keys(EXPECTED_RESULT_COLUMNS)) {
    const s = alterSqlFor(col);
    results[col] = s == null ? undefined : commentIn(s);
  }
  const clicks = {};
  const create = createSql() || '';
  for (const line of create.split('\n')) {
    const m = /^\s+(\w+)\s+/.exec(line);
    if (!m || !CLICK_COLUMNS[m[1]]) continue;
    clicks[m[1]] = commentIn(line);
  }
  const t = /COMMENT='((?:[^']|'')*)'\s*;?\s*$/.exec(create);
  return { results, clicks, clicksTable: t ? unq(t[1]) : null };
}

/** MySQL 8 reports `int(11)` on some servers and `int` on others — compare without display widths (tinyint(1) kept). */
function normType(t) {
  return String(t || '').toLowerCase().replace(/\b(int|bigint|smallint|mediumint)\(\d+\)/g, '$1').replace(/\btinyint\((?!1\))\d+\)/g, 'tinyint');
}

function columnProblems(c, def, fileComment, where) {
  const problems = [];
  const [type, nullable, dflt, coll, extra] = def;
  if (normType(c.type) !== type) problems.push(`${where}.${c.name} is ${c.type}, expected ${type}`);
  if (c.nullable !== nullable) problems.push(`${where}.${c.name} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
  if ((c.dflt == null ? null : String(c.dflt)) !== dflt) problems.push(`${where}.${c.name} DEFAULT ${c.dflt}, expected ${dflt}`);
  if ((c.coll || null) !== coll) problems.push(`${where}.${c.name} collation ${c.coll || 'none'}, expected ${coll || 'none'}`);
  if (String(c.extra || '') !== extra) problems.push(`${where}.${c.name} EXTRA "${c.extra}", expected "${extra}"`);
  if ((c.comment || '') !== fileComment) problems.push(`${where}.${c.name} comment differs from the migration file`);
  return problems;
}

/** → { resultCols: {col → present}, clicksExists, problems } — present pieces fully verified. */
async function state(conn) {
  const fc = fileComments();
  const problems = [];
  const [rcols] = await conn.query(SQL.columns, [RESULTS]);
  const byName = new Map(rcols.map((c) => [c.name, c]));
  const resultCols = {};
  for (const [name, def] of Object.entries(EXPECTED_RESULT_COLUMNS)) {
    const c = byName.get(name);
    resultCols[name] = !!c;
    if (c) columnProblems(c, def, fc.results[name], RESULTS).forEach((p) => problems.push(p));
  }
  const [[e]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [CLICKS]);
  const clicksExists = Number(e.n) > 0;
  if (clicksExists) {
    const [[t]] = await conn.query(SQL.table, [CLICKS]);
    if (t.coll !== GC) problems.push(`${CLICKS} collation ${t.coll}, expected ${GC}`);
    if (t.comment !== fc.clicksTable) problems.push(`${CLICKS} table comment differs from the migration file`);
    const [cols] = await conn.query(SQL.columns, [CLICKS]);
    const names = cols.map((c) => c.name);
    const wanted = Object.keys(CLICK_COLUMNS);
    if (names.join(',') !== wanted.join(',')) problems.push(`${CLICKS} columns are (${names.join(', ')}), expected (${wanted.join(', ')})`);
    for (const c of cols) {
      const def = CLICK_COLUMNS[c.name];
      if (def) columnProblems(c, def, fc.clicks[c.name], CLICKS).forEach((p) => problems.push(p));
    }
    const [idx] = await conn.query(SQL.indexes, [CLICKS]);
    const idxBy = new Map();
    for (const r of idx) {
      if (!idxBy.has(r.name)) idxBy.set(r.name, []);
      idxBy.get(r.name).push(r.col);
    }
    for (const [name, colsWanted] of Object.entries(EXPECTED_CLICK_INDEXES)) {
      const got = idxBy.get(name);
      if (!got) problems.push(`index ${name} is missing`);
      else if (got.join(',') !== colsWanted.join(',')) problems.push(`index ${name} is (${got.join(', ')}), expected (${colsWanted.join(', ')})`);
    }
    for (const name of idxBy.keys()) if (!EXPECTED_CLICK_INDEXES[name]) problems.push(`unexpected index ${name}`);
  }
  return { resultCols, clicksExists, problems };
}

/** CHECK (apply:false) or apply missing pieces + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const fc = fileComments();
  const missingStmts = Object.keys(EXPECTED_RESULT_COLUMNS).filter((c) => fc.results[c] === undefined);
  if (!createSql()) missingStmts.push(CLICKS);
  if (missingStmts.length) {
    const line = `NO-GO — the migration file lacks statement(s) for: ${missingStmts.join(', ')}. Nothing was changed.`;
    say(line);
    return { ok: false, line, applied: [] };
  }

  let st = await state(conn);
  const todo = [];
  for (const [col, present] of Object.entries(st.resultCols)) {
    say(`${RESULTS}.${col}: ${present ? 'present' : 'absent — to do: ALTER'}`);
    if (!present) todo.push({ what: `${RESULTS}.${col}`, sql: alterSqlFor(col) });
  }
  if (st.clicksExists) {
    const [[dc]] = await conn.query(`SELECT COUNT(*) AS n FROM ${CLICKS}`);
    say(`${CLICKS}: present, ${Number(dc.n)} row(s)`);
  } else {
    say(`${CLICKS}: absent — to do: create`);
    todo.push({ what: CLICKS, sql: createSql() });
  }
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: [] };
  }

  if (!apply) {
    const line = todo.length
      ? 'CHECK OK — GO. Next: node scripts/yisramailC6Migrate.js --apply'
      : 'CHECK OK — the C6 schema is in place as expected. GO (nothing to apply; next: the backend deploy).';
    say(line);
    return { ok: true, line, applied: [] };
  }

  const applied = [];
  for (const t of todo) {
    try {
      await conn.query(t.sql);
    } catch (err) {
      const line = `NO-GO — ${t.what} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied };
    }
    applied.push(t.what);
    say(`  ✓ applied ${t.what}`);
  }

  st = await state(conn);
  const stillMissing = Object.entries(st.resultCols).filter(([, p]) => !p).map(([c]) => `${RESULTS}.${c}`);
  if (!st.clicksExists) stillMissing.push(CLICKS);
  if (st.problems.length || stillMissing.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    stillMissing.forEach((m) => say(`  ✗ ${m} still absent`));
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: columns, types, nullability, defaults, collations, comments and keys as in the migration file');
  const line = `${applied.length ? 'APPLIED' : 'ALREADY IN PLACE'} — C6 schema verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = {
  run, state, statements, createSql, alterSqlFor, fileComments,
  MIGRATION, RESULTS, CLICKS, EXPECTED_RESULT_COLUMNS, CLICK_COLUMNS, EXPECTED_CLICK_INDEXES, SQL,
};

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
