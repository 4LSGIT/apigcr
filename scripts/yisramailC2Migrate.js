#!/usr/bin/env node
// scripts/yisramailC2Migrate.js
//
/**
 * YisraMail C2 — the marketing send path's schema (ref/YISRAMAIL_DESIGN.md
 * §6.4 / §6.5 "As built (C2)"):
 *   campaigns:         + send_snapshot (the send-start snapshot, MRPC 7.2(b))
 *   email_credentials: + held_at, held_reason (the transport hold, §6.5)
 * Every definition, comments included, is read from
 * ref/migrations/2026-11-04_yisramail_c2_marketing_send.sql so the file and the
 * applied tables can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailC2Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailC2Migrate.js --apply    # ALTER, then verify
 *   3. backend deploy
 *
 * CHECK (default), read-only: each table has exactly its pre-C2 columns
 * (post-C1, verified live 2026-11-04) plus any C2 column already present WITH
 * the expected definition (a re-run). Anything else is NO-GO, nothing altered.
 * Prints the row counts. --apply: one ALTER per table for whatever is missing,
 * then VERIFIES types, nullability, defaults, collation and comments.
 * Re-runnable: resumes from wherever a failed run stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10 — an ALTER
 * queued behind a long transaction gives up in seconds (NO-GO, re-run later)
 * instead of stalling every campaign send. One GO / NO-GO line.
 * (The C1 / T1 scripts tolerate these three columns as LATER columns, so their
 * CHECKs and twins keep passing once the dump carries them.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-04_yisramail_c2_marketing_send.sql');
const GC = 'utf8mb4_general_ci';

/** Live columns before C2 (post-C1, verified 2026-11-04), per table, in order. */
const BASE_COLUMNS = Object.freeze({
  campaigns: Object.freeze(['campaign_id', 'type', 'sender', 'subject', 'body', 'attachment_url', 'include_signature',
    'created', 'status', 'scheduled_time', 'created_by', 'result_summary', 'contact_count', 'updated_at',
    'class', 'topic_key', 'bulk_confirmed_count']),
  email_credentials: Object.freeze(['id', 'email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'provider',
    'credential_id', 'from_name', 'signature_html', 'signature_text', 'owner_user', 'bulk_ok', 'events_driver', 'driver_config']),
});

/**
 * Columns a LATER slice adds to these tables — tolerated when present (never
 * checked or touched here), so this CHECK and its twins keep passing once the
 * dump carries them: C3 (scripts/yisramailC3Migrate.js).
 */
const LATER_COLUMNS = Object.freeze({
  campaigns: Object.freeze(['design_id']),
  email_credentials: Object.freeze([]),
});

/** Columns C2 ADDS: table → name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null]. */
const ADDED = Object.freeze({
  campaigns: Object.freeze({
    send_snapshot: ['json', 'YES', null, null],
  }),
  email_credentials: Object.freeze({
    held_at: ['datetime', 'YES', null, null],
    held_reason: ['varchar(255)', 'YES', null, GC],
  }),
});
const TABLES = Object.freeze(['campaigns', 'email_credentials']);

const SQL = Object.freeze({
  table: 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
});

/** The file's ALTER clauses: { table → { column → clause } } (one clause per line; COMMENTs hold ',' and ';'). */
function clauses() {
  const out = Object.fromEntries(TABLES.map((t) => [t, {}]));
  let table = null;
  for (const line of fs.readFileSync(MIGRATION, 'utf8').split('\n')) {
    const t = /^ALTER TABLE (\w+)$/.exec(line);
    if (t) { table = t[1]; continue; }
    const c = /^\s*(ADD COLUMN (\w+) .*?)[,;]\s*$/.exec(line);
    if (c && table && out[table]) { out[table][c[2]] = c[1]; continue; }
    if (/^\S/.test(line)) table = null;
  }
  return out;
}

function commentOf(clause) {
  const m = /COMMENT '((?:[^']|'')*)'$/.exec(clause || '');
  return m ? m[1].replace(/''/g, "'") : null;
}

/** The ALTER for a table's missing columns (file order). null when nothing to do. */
function alterSql(table, columns) {
  const c = clauses()[table];
  const parts = Object.keys(c).filter((n) => columns.includes(n)).map((n) => c[n]);
  return parts.length ? `ALTER TABLE ${table}\n  ${parts.join(',\n  ')}` : null;
}

function describeDiff(name, col, [type, nullable, dflt, coll], comment) {
  const out = [];
  if (String(col.type).toLowerCase() !== type) out.push(`${name} is ${col.type}, expected ${type}`);
  if (col.nullable !== nullable) out.push(`${name} IS_NULLABLE ${col.nullable}, expected ${nullable}`);
  if ((col.dflt == null ? null : String(col.dflt)) !== dflt) out.push(`${name} DEFAULT ${col.dflt}, expected ${dflt}`);
  if ((col.coll || null) !== coll) out.push(`${name} collation ${col.coll || 'none'}, expected ${coll || 'none'}`);
  if (col.comment !== comment) out.push(`${name} comment differs from the migration file`);
  return out;
}

/** → { todo: { table → [columns] }, problems: [..] } */
async function state(conn) {
  const c = clauses();
  const todo = {};
  const problems = [];
  for (const table of TABLES) {
    todo[table] = [];
    const [cols] = await conn.query(SQL.columns, [table]);
    const have = new Map(cols.map((x) => [x.name, x]));
    for (const b of BASE_COLUMNS[table]) if (!have.has(b)) problems.push(`${table}: pre-C2 column ${b} is missing`);
    for (const name of have.keys()) {
      if (!BASE_COLUMNS[table].includes(name) && !ADDED[table][name] && !LATER_COLUMNS[table].includes(name)) problems.push(`${table}: unexpected column ${name}`);
    }
    for (const [name, def] of Object.entries(ADDED[table])) {
      const col = have.get(name);
      if (!col) { todo[table].push(name); continue; }
      describeDiff(`${table}.${name}`, col, def, commentOf(c[table][name])).forEach((p) => problems.push(p));
    }
    const order = Object.keys(c[table]);
    todo[table].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  return { todo, problems };
}

/** CHECK (apply:false) or ALTER + verify (apply:true). → { ok, line, altered } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const c = clauses();
  const fileProblems = [];
  for (const table of TABLES) {
    for (const name of Object.keys(ADDED[table])) if (!c[table][name] || !commentOf(c[table][name])) fileProblems.push(`${table}.${name}`);
  }
  if (fileProblems.length) {
    const line = `NO-GO — the migration file lacks a commented clause for ${fileProblems.join(', ')}. Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }
  for (const table of TABLES) {
    const [[t]] = await conn.query(SQL.table, [table]);
    if (!Number(t.n)) {
      const line = `NO-GO — table ${table} does not exist in this database. Nothing was changed.`;
      say(line);
      return { ok: false, line, altered: false };
    }
  }
  for (const table of TABLES) {
    const [[rc]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
    say(`${table}: ${Number(rc.n)} row(s)`);
  }

  let st = await state(conn);
  for (const table of TABLES) say(`${table}: C2 work ${st.todo[table].length ? `to do: ${st.todo[table].join(', ')}` : 'none (in place)'}`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, altered: false };
  }
  const todo = TABLES.some((t) => st.todo[t].length);

  if (!apply) {
    const line = todo
      ? 'CHECK OK — GO. Next: node scripts/yisramailC2Migrate.js --apply'
      : 'CHECK OK — the C2 columns are in place as expected. GO (nothing to apply; next: the backend deploy).';
    say(line);
    return { ok: true, line, altered: false };
  }

  let altered = false;
  for (const table of TABLES) {
    const sql = alterSql(table, st.todo[table]);
    if (!sql) continue;
    try {
      await conn.query(sql);
    } catch (err) {
      const line = `NO-GO — the ${table} ALTER failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
      say(line);
      return { ok: false, line, altered };
    }
    altered = true;
    say(`  ✓ ${table}: ${st.todo[table].join(', ')}`);
  }

  st = await state(conn);
  const leftover = TABLES.filter((t) => st.todo[t].length);
  if (st.problems.length || leftover.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    leftover.forEach((t) => say(`  ✗ ${t}: still to do: ${st.todo[t].join(', ')}`));
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, altered };
  }
  say('  ✓ verified: types, nullability, defaults, collation, comments as in the migration file');
  const line = `${altered ? 'APPLIED' : 'ALREADY IN PLACE'} — C2 schema verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, altered };
}

module.exports = { run, state, clauses, commentOf, alterSql, MIGRATION, TABLES, BASE_COLUMNS, LATER_COLUMNS, ADDED, SQL };

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
