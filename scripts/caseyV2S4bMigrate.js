#!/usr/bin/env node
// scripts/caseyV2S4bMigrate.js
//
/**
 * Casey v2 S4b — issue_reports.kind gains 'casey' (a Casey answer flagged for
 * review; routes/api.issueReports.js, services/casey/tools/flag_for_review.js).
 * The MODIFY statement, comment included, is read from
 * ref/migrations/2026-11-23_casey_v2_s4b_flag.sql so the file and the applied
 * schema can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/caseyV2S4bMigrate.js            # CHECK — read-only
 *   2. node scripts/caseyV2S4bMigrate.js --apply    # MODIFY, verify
 *   3. the S4b backend + frontend deploy (one land)
 *
 * CHECK (default), read-only: issue_reports exists and its `kind` column is
 * either the S4b shape (a re-run) or the pre-S4b shape ('problem','idea',
 * 'question'); anything else is NO-GO, nothing changed. --apply runs the ONE
 * ALTER and verifies the end state. issue_reports is a LIVE table: the session
 * sets lock_wait_timeout 5 so a metadata lock queued behind a long transaction
 * fails fast instead of stalling every write to the table (CLAUDE.md).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-23_casey_v2_s4b_flag.sql');
const TABLE = 'issue_reports';
const COLUMN = 'kind';
const BEFORE = "enum('problem','idea','question')";
const AFTER = "enum('problem','idea','question','casey')";

const SQL = Object.freeze({
  exists: 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  column: `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS comment
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
});

/** The file's statements, in order, comment lines dropped; each ends with ';' at END OF LINE. */
function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}
function modifySql() {
  return statements().find((s) => new RegExp(`^ALTER TABLE ${TABLE}\\s+MODIFY COLUMN ${COLUMN} `).test(s)) || null;
}
const unq = (s) => s.replace(/''/g, "'");
function fileComment() {
  const m = /COMMENT '((?:[^']|'')*)'/.exec(modifySql() || '');
  return m ? unq(m[1]) : null;
}

/** → { tableOk, column: { type, nullable, dflt, comment } | null, state: 'after' | 'before' | 'other', problems } */
async function state(conn) {
  const problems = [];
  const [[e]] = await conn.query(SQL.exists, [TABLE]);
  if (Number(e.n) === 0) return { tableOk: false, column: null, state: 'other', problems: [`${TABLE} is absent`] };
  const [[c]] = await conn.query(SQL.column, [TABLE, COLUMN]);
  if (!c) return { tableOk: true, column: null, state: 'other', problems: [`${TABLE}.${COLUMN} is absent`] };
  const type = String(c.type).toLowerCase();
  let st = 'other';
  if (type === AFTER) {
    st = 'after';
    if (c.nullable !== 'NO') problems.push(`${TABLE}.${COLUMN} IS_NULLABLE ${c.nullable}, expected NO`);
    if (String(c.dflt) !== 'problem') problems.push(`${TABLE}.${COLUMN} DEFAULT ${c.dflt}, expected problem`);
    if ((c.comment || '') !== (fileComment() || '')) problems.push(`${TABLE}.${COLUMN} comment differs from the migration file`);
  } else if (type === BEFORE) st = 'before';
  else problems.push(`${TABLE}.${COLUMN} is ${c.type}, expected ${BEFORE} (to migrate) or ${AFTER} (migrated)`);
  return { tableOk: true, column: c, state: st, problems };
}

/** CHECK (apply:false) or MODIFY + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');
  if (!modifySql()) {
    const line = `NO-GO — ${path.basename(MIGRATION)} has no ALTER TABLE ${TABLE} MODIFY COLUMN ${COLUMN}. Nothing was changed.`;
    say(line);
    return { ok: false, line, applied: false };
  }
  let st = await state(conn);
  say(`${TABLE}.${COLUMN}: ${st.column ? st.column.type : 'absent'} — ${st.state === 'after' ? 'S4b shape' : st.state === 'before' ? 'to do: add casey' : 'unexpected'}`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: false };
  }
  if (!apply) {
    const line = st.state === 'after'
      ? `CHECK OK — ${TABLE}.${COLUMN} already carries casey. GO (nothing to apply; next: the deploy).`
      : 'CHECK OK — GO. Next: node scripts/caseyV2S4bMigrate.js --apply';
    say(line);
    return { ok: true, line, applied: false };
  }
  let applied = false;
  if (st.state === 'before') {
    try { await conn.query(modifySql()); } catch (err) {
      const line = `NO-GO — ALTER TABLE ${TABLE} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied };
    }
    applied = true;
    say(`  ✓ ${TABLE}.${COLUMN} now ${AFTER}`);
  }
  st = await state(conn);
  if (st.state !== 'after' || st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: type, nullability, default and comment as in the migration file');
  const line = `${applied ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE}.${COLUMN} carries casey. GO. Next: the deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = { run, state, statements, modifySql, fileComment, MIGRATION, TABLE, COLUMN, BEFORE, AFTER, SQL };

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
      for (const k of ['host', 'user', 'password', 'database']) if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      conn = mysql.createConnection({ host: process.env.host, user: process.env.user, password: process.env.password, database: process.env.database, timezone: 'Z', connectTimeout: 15_000 }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally { if (conn) await conn.end().catch(() => {}); }
  })();
}
