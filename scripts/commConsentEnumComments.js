#!/usr/bin/env node
// scripts/commConsentEnumComments.js
//
/**
 * COMMENTs for the five enum-ish consent columns that shipped without one in
 * YisraMail P1 (2026-10-29_yisramail_p1_consent_core.sql):
 *   comm_consent_events.channel, .action
 *   comm_consent_state.channel, .scope, .state
 * Every other value column of the two tables carries its vocabulary in a
 * COMMENT (destination, scope, source, …); these five are the ones a reader
 * of ref/database.sql has to open optoutService to decode. Docs review #4
 * (2026-11-15) schema sweep. This changes COMMENTs and nothing else.
 * Derived from scripts/commUnsubTokensCampaignIdComment.js, generalized to
 * several columns on two tables.
 *
 * USAGE (repo root; .env reaches production, same setup as npm run db:ref):
 *   node scripts/commConsentEnumComments.js            # CHECK — read-only
 *   node scripts/commConsentEnumComments.js --apply    # write the comments
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). --apply:
 *   1. asserts both tables default to utf8mb4_general_ci and every live column
 *      is exactly what this script expects (type — the enum values included —
 *      nullability, default, charset, collation, extra) and that its comment
 *      is either empty or already the new text;
 *      anything else is NO-GO and nothing is changed;
 *   2. SET SESSION lock_wait_timeout = 5 (the global default is a year; a
 *      metadata lock queued behind a long transaction would stall every
 *      query on the table — every send reads comm_consent_state);
 *   3. ONE ALTER per table with a MODIFY COLUMN for each column still
 *      pending, restating the SAME definition with the new COMMENT,
 *      ALGORITHM=INSTANT — a comment change is metadata-only; if the server
 *      ever refused INSTANT it errors instead of rebuilding the table;
 *   4. re-reads and verifies every attribute plus the new comment, all five.
 * RE-RUNNABLE and resumable per column: a column already carrying the new
 * text is left alone; when all five do, CHECK and --apply both report
 * ALREADY APPLIED and change nothing. Ends on ONE GO / NO-GO line.
 */
'use strict';

const OLD_COMMENT = '';
// No charset / COLLATE clause in the MODIFY: the column inherits the table's
// utf8mb4_general_ci (asserted below), exactly as P1 created it, so the dumped
// DDL line changes in nothing but the COMMENT (a restated COLLATE makes the
// server render an explicit CHARACTER SET from then on; seen on 8.4).
const CS = 'NOT NULL';
const TABLE_COLLATION = 'utf8mb4_general_ci';
const EXPECT_ENUM = (type) => ({
  COLUMN_TYPE: type, IS_NULLABLE: 'NO', COLUMN_DEFAULT: null,
  CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci', EXTRA: '',
});

const COMMENTS = {
  'comm_consent_events.channel':
    'sms | email: the channel of the destination (MMS is recorded as sms, optoutService.CHANNELS). Picks the scope vocabulary: sms has all + topics, email has marketing + topics',
  'comm_consent_events.action':
    'opt_out | opt_in (app-validated, optoutService.ACTIONS). Sets comm_consent_state.state to opted_out | opted_in when (occurred_at, id) is newest. An opt_in is recorded by staff (a signed-in user; automation and API keys are refused), by the preference page, or by an SMS START keyword while the number is opted out; providers and imports only opt out',
  'comm_consent_state.channel':
    'sms | email, as comm_consent_events.channel (MMS is sms). Primary key (channel, destination, scope)',
  'comm_consent_state.scope':
    'as comm_consent_events.scope: sms all | topic, email marketing | topic (no email all, D18). A send reads sms all (every text) and email marketing (marketing mail only), plus the topic row of a topic send. A row exists only for a scope an event has set',
  'comm_consent_state.state':
    'opted_out | opted_in: the newest decision by (occurred_at, id). opted_out blocks a send that checks this scope. An opt_in topic (comm_topics.consent_model) sends ONLY to a destination whose topic row is opted_in, so no row = not sendable there; an opt_out topic sends unless opted_out',
};

const TABLES = [
  { table: 'comm_consent_events', columns: [
    { column: 'channel', def: `enum('email','sms') ${CS}`, expect: EXPECT_ENUM("enum('email','sms')") },
    { column: 'action', def: `enum('opt_out','opt_in') ${CS}`, expect: EXPECT_ENUM("enum('opt_out','opt_in')") },
  ] },
  { table: 'comm_consent_state', columns: [
    { column: 'channel', def: `enum('email','sms') ${CS}`, expect: EXPECT_ENUM("enum('email','sms')") },
    { column: 'scope', def: `varchar(40) ${CS}`, expect: EXPECT_ENUM('varchar(40)') },
    { column: 'state', def: `enum('opted_out','opted_in') ${CS}`, expect: EXPECT_ENUM("enum('opted_out','opted_in')") },
  ] },
];
for (const t of TABLES) for (const c of t.columns) c.comment = COMMENTS[`${t.table}.${c.column}`];

const SQL = {
  read: 'SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, COLUMN_COMMENT ' +
        'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
  readTable: 'SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  lockWait: 'SET SESSION lock_wait_timeout = 5',
};

/** The ALTER for `table` over `columns` (a subset of its TABLES entry) — one MODIFY each, COMMENT ? placeholders in order. */
function alterSql(table, columns) {
  const mods = columns.map((c) => `MODIFY COLUMN \`${c.column}\` ${c.def} COMMENT ?`);
  return `ALTER TABLE \`${table}\` ${mods.join(', ')}, ALGORITHM=INSTANT`;
}

/** Problems with one live column's definition (comment aside); [] = as expected. */
function definitionProblems(spec, col) {
  if (!col) return [`${spec.table}.${spec.column} not found`];
  const out = [];
  for (const k of Object.keys(spec.expect)) {
    if (col[k] !== spec.expect[k]) out.push(`${spec.table}.${spec.column}: ${k} is ${JSON.stringify(col[k])}, expected ${JSON.stringify(spec.expect[k])}`);
  }
  return out;
}

async function readColumn(conn, table, column) {
  const [rows] = await conn.query(SQL.read, [table, column]);
  return rows[0] || null;
}

/** Every column with its live row: [{ table, column, def, expect, comment, live }]. */
async function readAll(conn) {
  const out = [];
  for (const t of TABLES) {
    for (const c of t.columns) out.push({ table: t.table, ...c, live: await readColumn(conn, t.table, c.column) });
  }
  return out;
}

/** Tables whose default collation is not the one the columns must inherit; [] = fine. */
async function tableProblems(conn) {
  const out = [];
  for (const t of TABLES) {
    const [rows] = await conn.query(SQL.readTable, [t.table]);
    const coll = rows[0] ? rows[0].TABLE_COLLATION : null;
    if (coll !== TABLE_COLLATION) out.push(`${t.table}: TABLE_COLLATION is ${JSON.stringify(coll)}, expected ${JSON.stringify(TABLE_COLLATION)}`);
  }
  return out;
}

/** run(conn, { apply }) → { ok, state, line } — the whole script, testable. */
async function run(conn, { apply = false, log = console.log } = {}) {
  const cols = await readAll(conn);
  const probs = [...await tableProblems(conn), ...cols.flatMap((s) => definitionProblems(s, s.live))];
  if (probs.length) {
    probs.forEach((p) => log('  ✗ ' + p));
    const line = 'NO-GO — a consent column is not what this script expects. Nothing was changed.';
    log(line); return { ok: false, state: 'unexpected', line };
  }
  const unknown = cols.filter((s) => s.live.COLUMN_COMMENT !== OLD_COMMENT && s.live.COLUMN_COMMENT !== s.comment);
  for (const s of cols) log(`  ✓ ${s.table}.${s.column}: ${s.live.COLUMN_TYPE}, comment ${JSON.stringify(s.live.COLUMN_COMMENT)}`);
  if (unknown.length) {
    unknown.forEach((s) => log(`  ✗ ${s.table}.${s.column}: the comment is neither empty nor the new text (someone changed it)`));
    const line = 'NO-GO — a consent column carries a comment this script did not write. Nothing was changed.';
    log(line); return { ok: false, state: 'unknown-comment', line };
  }
  const pending = cols.filter((s) => s.live.COLUMN_COMMENT !== s.comment);
  if (!pending.length) {
    const line = 'ALREADY APPLIED — GO. Nothing to do; the pre-commit hook regenerates ref/database.sql on the next commit.';
    log(line); return { ok: true, state: 'applied', line };
  }
  log(`  ${pending.length} of ${cols.length} column(s) pending: ${pending.map((s) => `${s.table}.${s.column}`).join(', ')}`);
  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/commConsentEnumComments.js --apply';
    log(line); return { ok: true, state: 'check', line };
  }
  await conn.query(SQL.lockWait);
  for (const t of TABLES) {
    const todo = pending.filter((s) => s.table === t.table);
    if (!todo.length) continue;
    await conn.query(alterSql(t.table, todo), todo.map((s) => s.comment));
    log(`  ✓ ALTER ${t.table} … COMMENT ×${todo.length} (ALGORITHM=INSTANT)`);
  }
  const after = await readAll(conn);
  const bad = after.flatMap((s) => {
    const p = definitionProblems(s, s.live);
    if (!p.length && s.live.COLUMN_COMMENT !== s.comment) p.push(`${s.table}.${s.column}: comment reads ${JSON.stringify(s.live.COLUMN_COMMENT)}`);
    return p;
  });
  if (bad.length) {
    bad.forEach((p) => log('  ✗ ' + p));
    const line = 'NO-GO — a column does not read back as expected after the ALTER. Paste this output.';
    log(line); return { ok: false, state: 'verify-failed', line };
  }
  log(`  ✓ verified: ${after.length} definitions unchanged, every comment the new text`);
  const line = 'APPLIED — GO. Next: any commit regenerates ref/database.sql (pre-commit hook).';
  log(line); return { ok: true, state: 'applied-now', line };
}

module.exports = { run, definitionProblems, tableProblems, alterSql, OLD_COMMENT, COMMENTS, TABLES, TABLE_COLLATION, SQL };

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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
