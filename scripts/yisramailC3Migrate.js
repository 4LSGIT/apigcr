#!/usr/bin/env node
// scripts/yisramailC3Migrate.js
//
/**
 * YisraMail C3a — the designs library's schema (ref/YISRAMAIL_DESIGN.md §6.3
 * "As built (C3a)"):
 *   email_designs (NEW) — the library: design_json + html + text, validated on
 *                         every save by services/emailDesignService.js
 *   campaigns:          + design_id (provenance for "duplicate last month's")
 * Every definition, comments included, is read from
 * ref/migrations/2026-11-04_yisramail_c3_email_designs.sql so the file and the
 * applied schema can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailC3Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailC3Migrate.js --apply    # CREATE + ALTER, then verify
 *   3. backend deploy
 *
 * CHECK (default), read-only: campaigns has exactly its pre-C3 columns
 * (post-C2, verified live 2026-11-04) plus design_id if already present WITH
 * the expected definition (a re-run); email_designs is absent, or present with
 * exactly the file's shape (columns, types, nullability, defaults, extras,
 * collations, comments, keys). Anything else is NO-GO, nothing changed.
 * Prints the row counts. --apply: the CREATE when the table is absent, the
 * ALTER when the column is missing, then VERIFIES the whole end state.
 * Re-runnable: resumes from wherever a failed run stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10 — the ALTER
 * of the live campaigns table gives up in seconds behind a long transaction
 * (NO-GO, re-run later) instead of stalling every campaign create and send.
 * One GO / NO-GO line.
 * (The C1 / C2 scripts tolerate campaigns.design_id as a LATER column, so their
 * CHECKs and twins keep passing once the dump carries it.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-04_yisramail_c3_email_designs.sql');
const GC = 'utf8mb4_general_ci';
const TABLE = 'email_designs';

/** campaigns' live columns before C3 (post-C2, verified 2026-11-04), in order. */
const CAMPAIGNS_BASE = Object.freeze(['campaign_id', 'type', 'sender', 'subject', 'body', 'attachment_url', 'include_signature',
  'created', 'status', 'scheduled_time', 'created_by', 'result_summary', 'contact_count', 'updated_at',
  'class', 'topic_key', 'bulk_confirmed_count', 'send_snapshot']);

/** campaigns.design_id: [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null]. */
const DESIGN_ID = Object.freeze(['int unsigned', 'YES', null, null]);

/** email_designs: name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA] (file order). */
const EXPECTED_COLUMNS = Object.freeze({
  id:                 ['int unsigned', 'NO', null, null, 'auto_increment'],
  name:               ['varchar(255)', 'NO', null, GC, ''],
  builder:            ['varchar(32)', 'NO', 'grapesjs-mjml', GC, ''],
  design_json:        ['json', 'NO', null, null, ''],
  html:               ['mediumtext', 'NO', null, GC, ''],
  text:               ['mediumtext', 'NO', null, GC, ''],
  thumbnail_asset_id: ['int unsigned', 'YES', null, null, ''],
  created_by:         ['tinyint unsigned', 'YES', null, null, ''],
  created_at:         ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED'],
  updated_at:         ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'],
  archived:           ['tinyint(1)', 'NO', '0', null, ''],
});
/** index name → its columns in order. */
const EXPECTED_INDEXES = Object.freeze({
  PRIMARY: ['id'],
  ix_archived_updated: ['archived', 'updated_at'],
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
function createSql() { return statements().find((s) => /^CREATE TABLE IF NOT EXISTS email_designs \(/.test(s)) || null; }
function alterSql() { return statements().find((s) => /^ALTER TABLE campaigns\b/.test(s)) || null; }

function unq(s) { return s.replace(/''/g, "'"); }

/** The file's comments: { columns: { name → comment }, table, design_id }. */
function fileComments() {
  const columns = {};
  const create = createSql() || '';
  for (const line of create.split('\n')) {
    const m = /^\s+(\w+)\s+.*COMMENT '((?:[^']|'')*)',?\s*$/.exec(line);
    if (m && EXPECTED_COLUMNS[m[1]]) columns[m[1]] = unq(m[2]);
  }
  const t = /COMMENT='((?:[^']|'')*)'\s*$/.exec(create);
  const a = /ADD COLUMN design_id .*COMMENT '((?:[^']|'')*)'\s*$/.exec(alterSql() || '');
  return { columns, table: t ? unq(t[1]) : null, design_id: a ? unq(a[1]) : null };
}

/** MySQL 8 reports `int(11)` on some servers and `int` on others — compare without display widths (tinyint(1) kept). */
function normType(t) {
  return String(t || '').toLowerCase().replace(/\b(int|bigint|smallint|mediumint)\(\d+\)/g, '$1').replace(/\btinyint\((?!1\))\d+\)/g, 'tinyint');
}

/** email_designs' shape against the file → [problem lines] ([] = as expected). */
async function tableProblems(conn) {
  const fc = fileComments();
  const problems = [];
  const [[t]] = await conn.query(SQL.table, [TABLE]);
  if (t.coll !== GC) problems.push(`${TABLE} collation ${t.coll}, expected ${GC}`);
  if (t.comment !== fc.table) problems.push(`${TABLE} table comment differs from the migration file`);
  const [cols] = await conn.query(SQL.columns, [TABLE]);
  const names = cols.map((c) => c.name);
  const wanted = Object.keys(EXPECTED_COLUMNS);
  if (names.join(',') !== wanted.join(',')) problems.push(`${TABLE} columns are (${names.join(', ')}), expected (${wanted.join(', ')})`);
  for (const c of cols) {
    const def = EXPECTED_COLUMNS[c.name];
    if (!def) continue;
    const [type, nullable, dflt, coll, extra] = def;
    if (normType(c.type) !== type) problems.push(`${c.name} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) problems.push(`${c.name} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
    if ((c.dflt == null ? null : String(c.dflt)) !== dflt) problems.push(`${c.name} DEFAULT ${c.dflt}, expected ${dflt}`);
    if ((c.coll || null) !== coll) problems.push(`${c.name} collation ${c.coll || 'none'}, expected ${coll || 'none'}`);
    if (String(c.extra || '') !== extra) problems.push(`${c.name} EXTRA "${c.extra}", expected "${extra}"`);
    if (c.comment !== fc.columns[c.name]) problems.push(`${c.name} comment differs from the migration file`);
  }
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
  for (const name of byName.keys()) if (!EXPECTED_INDEXES[name]) problems.push(`unexpected index ${name}`);
  return problems;
}

/** → { tableExists, designIdTodo, problems } */
async function state(conn) {
  const problems = [];
  const [[e]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]);
  const tableExists = Number(e.n) > 0;
  if (tableExists) (await tableProblems(conn)).forEach((p) => problems.push(p));

  const [cols] = await conn.query(SQL.columns, ['campaigns']);
  const have = new Map(cols.map((x) => [x.name, x]));
  for (const b of CAMPAIGNS_BASE) if (!have.has(b)) problems.push(`campaigns: pre-C3 column ${b} is missing`);
  for (const name of have.keys()) {
    if (!CAMPAIGNS_BASE.includes(name) && name !== 'design_id') problems.push(`campaigns: unexpected column ${name}`);
  }
  const col = have.get('design_id');
  if (col) {
    const [type, nullable, dflt, coll] = DESIGN_ID;
    if (normType(col.type) !== type) problems.push(`campaigns.design_id is ${col.type}, expected ${type}`);
    if (col.nullable !== nullable) problems.push(`campaigns.design_id IS_NULLABLE ${col.nullable}, expected ${nullable}`);
    if ((col.dflt == null ? null : String(col.dflt)) !== dflt) problems.push(`campaigns.design_id DEFAULT ${col.dflt}, expected ${dflt}`);
    if ((col.coll || null) !== coll) problems.push(`campaigns.design_id collation ${col.coll}, expected none`);
    if (col.comment !== fileComments().design_id) problems.push('campaigns.design_id comment differs from the migration file');
  }
  return { tableExists, designIdTodo: !col, problems };
}

/** CHECK (apply:false) or create + alter + verify (apply:true). → { ok, line, created, altered } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const fc = fileComments();
  const missing = Object.keys(EXPECTED_COLUMNS).filter((n) => !fc.columns[n]);
  if (!createSql() || !alterSql() || missing.length || !fc.table || !fc.design_id) {
    const line = `NO-GO — the migration file lacks a statement or a COMMENT${missing.length ? ` (${missing.join(', ')})` : ''}. Nothing was changed.`;
    say(line);
    return { ok: false, line, created: false, altered: false };
  }
  const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['campaigns']);
  if (!Number(c.n)) {
    const line = 'NO-GO — table campaigns does not exist in this database. Nothing was changed.';
    say(line);
    return { ok: false, line, created: false, altered: false };
  }
  const [[rc]] = await conn.query('SELECT COUNT(*) AS n FROM campaigns');
  say(`campaigns: ${Number(rc.n)} row(s)`);

  let st = await state(conn);
  if (st.tableExists) {
    const [[dc]] = await conn.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    say(`${TABLE}: present, ${Number(dc.n)} row(s)`);
  } else {
    say(`${TABLE}: absent — to do: create`);
  }
  say(`campaigns: C3 work ${st.designIdTodo ? 'to do: design_id' : 'none (in place)'}`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, created: false, altered: false };
  }
  const todo = !st.tableExists || st.designIdTodo;

  if (!apply) {
    const line = todo
      ? 'CHECK OK — GO. Next: node scripts/yisramailC3Migrate.js --apply'
      : 'CHECK OK — the C3 schema is in place as expected. GO (nothing to apply; next: the backend deploy).';
    say(line);
    return { ok: true, line, created: false, altered: false };
  }

  let created = false;
  let altered = false;
  if (!st.tableExists) {
    try {
      await conn.query(createSql());
    } catch (err) {
      const line = `NO-GO — the CREATE TABLE ${TABLE} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
      say(line);
      return { ok: false, line, created, altered };
    }
    created = true;
    say(`  ✓ created ${TABLE}`);
  }
  if (st.designIdTodo) {
    try {
      await conn.query(alterSql());
    } catch (err) {
      const line = `NO-GO — the campaigns ALTER failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
      say(line);
      return { ok: false, line, created, altered };
    }
    altered = true;
    say('  ✓ campaigns: design_id');
  }

  st = await state(conn);
  if (st.problems.length || !st.tableExists || st.designIdTodo) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    if (!st.tableExists) say(`  ✗ ${TABLE} still absent`);
    if (st.designIdTodo) say('  ✗ campaigns.design_id still missing');
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, created, altered };
  }
  say('  ✓ verified: columns, types, nullability, defaults, extras, collations, comments and keys as in the migration file');
  const line = `${created || altered ? 'APPLIED' : 'ALREADY IN PLACE'} — C3 schema verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, created, altered };
}

module.exports = {
  run, state, statements, createSql, alterSql, fileComments, tableProblems,
  MIGRATION, TABLE, CAMPAIGNS_BASE, DESIGN_ID, EXPECTED_COLUMNS, EXPECTED_INDEXES, SQL,
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
