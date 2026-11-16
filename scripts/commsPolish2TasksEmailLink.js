#!/usr/bin/env node
// scripts/commsPolish2TasksEmailLink.js
//
/**
 * comms-polish-2 bundle C2 — tasks.task_link_type gains 'email'
 * (task_link_id = mail_messages.id). The MODIFY is read from
 * ref/migrations/2026-11-16_tasks_link_type_email.sql so the file and the
 * applied column can never differ.
 *
 * DEPLOY ORDER (absolute — SQL first, and it matters: sql_mode is relaxed, so
 * a backend writing 'email' before the ALTER would store '' with a warning):
 *   1. node scripts/commsPolish2TasksEmailLink.js            # CHECK — read-only
 *   2. node scripts/commsPolish2TasksEmailLink.js --apply    # MODIFY (INSTANT), then verify
 *   3. backend + frontend deploy (bundle C)
 *
 * CHECK (default), read-only: the file holds exactly one ALTER TABLE tasks
 * MODIFY task_link_type …; the live column is the pre-C2 enum
 * ('contact','case','appt','bill','event'), or already the C2 one (a re-run);
 * counts the rows per link type. Anything else is NO-GO, nothing written.
 * --apply: runs the MODIFY when 'email' is missing, then VERIFIES the
 * COLUMN_TYPE, nullability, default and that every pre-existing link type
 * count is unchanged. Re-runnable.
 *
 * ONE connection; lock_wait_timeout 10 (an INSTANT ALTER still takes a brief
 * exclusive metadata lock). One GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-16_tasks_link_type_email.sql');
const TABLE = 'tasks';
const COLUMN = 'task_link_type';
const BEFORE = "enum('contact','case','appt','bill','event')";
const AFTER = "enum('contact','case','appt','bill','event','email')";

function statementsOf(sqlText) {
  const noComments = sqlText.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return noComments.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

async function liveColumn(conn) {
  const [[c]] = await conn.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [TABLE, COLUMN]);
  return c ? { type: String(c.COLUMN_TYPE).toLowerCase(), nullable: c.IS_NULLABLE === 'YES', def: c.COLUMN_DEFAULT, comment: c.COLUMN_COMMENT } : null;
}
const counts = async (conn) => Object.fromEntries((await conn.query(`SELECT COALESCE(${COLUMN}, '(null)') AS t, COUNT(*) AS n FROM \`${TABLE}\` GROUP BY 1 ORDER BY 1`))[0].map((r) => [r.t, Number(r.n)]));

async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');
  const stmts = statementsOf(fs.readFileSync(MIGRATION, 'utf8'));
  const alter = stmts[0];
  if (stmts.length !== 1 || !new RegExp(`^ALTER TABLE \`${TABLE}\`\\s+MODIFY \`${COLUMN}\` ${AFTER.replace(/[()]/g, '\\$&')}`).test(alter)) {
    const line = `NO-GO — ${path.basename(MIGRATION)} must hold exactly one ALTER TABLE ${TABLE} MODIFY ${COLUMN} ${AFTER} … (found ${stmts.length} statement(s)). Nothing was changed.`;
    say(line); return { ok: false, line };
  }
  const col = await liveColumn(conn);
  if (!col) { const line = `NO-GO — ${TABLE}.${COLUMN} does not exist. Nothing was changed.`; say(line); return { ok: false, line }; }
  const before = await counts(conn);
  say(`${TABLE}.${COLUMN}: ${col.type}; rows per link type: ${JSON.stringify(before)}`);
  const done = col.type === AFTER;
  if (col.type !== BEFORE && !done) {
    const line = `NO-GO — the column is ${col.type}, neither the pre-C2 ${BEFORE} nor the C2 ${AFTER}. Nothing was changed.`;
    say(line); return { ok: false, line };
  }
  if (!apply) {
    const line = `GO — CHECK passed; --apply would do: ${done ? 'nothing (already applied)' : "MODIFY (append 'email', INSTANT)"}. Next: node scripts/commsPolish2TasksEmailLink.js --apply`;
    say(line); return { ok: true, line };
  }
  if (!done) {
    try { await conn.query(alter); say(`  ✓ ${COLUMN} → ${AFTER}`); } catch (err) {
      const line = `NO-GO — the ALTER failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
      say(line); return { ok: false, line };
    }
  }
  const after = await liveColumn(conn);
  const after_counts = await counts(conn);
  const problems = [];
  if (!after || after.type !== AFTER) problems.push(`the column is ${after && after.type}`);
  if (after && (!after.nullable || after.def !== null)) problems.push('the column lost NULL / DEFAULT NULL');
  if (after && !/comms-polish-2 C2/.test(after.comment || '')) problems.push('the column comment is not the file\'s');
  for (const k of Object.keys(before)) if (after_counts[k] !== before[k]) problems.push(`rows with link type ${k}: ${before[k]} → ${after_counts[k]}`);
  for (const p of problems) say(`  ✗ ${p}`);
  if (problems.length) { const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.'; say(line); return { ok: false, line }; }
  say(`  ✓ verified: ${AFTER}, NULL / DEFAULT NULL, comment, counts unchanged`);
  const line = "GO — tasks.task_link_type takes 'email'. Next: land bundle C (backend + frontend).";
  say(line); return { ok: true, line };
}

module.exports = { run, statementsOf, MIGRATION, TABLE, COLUMN, BEFORE, AFTER };

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
