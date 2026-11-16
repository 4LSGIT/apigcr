#!/usr/bin/env node
// scripts/commsPolish2MailFulltext.js
//
/**
 * comms-polish-2 bundle C1 — the Comms Email tab's body search:
 *   FULLTEXT INDEX ft_mail_messages_text (subject, body_text) ON mail_messages
 * The statement is read from ref/migrations/2026-11-16_mail_fulltext_search.sql
 * so the file and the applied index can never differ. The query that uses it:
 * services/mailbox/mailReadService.js (ftQueryOf + scopeWhere's q).
 *
 * DEPLOY ORDER (absolute — SQL first):
 *   1. node scripts/commsPolish2MailFulltext.js            # CHECK — read-only
 *   2. node scripts/commsPolish2MailFulltext.js --apply    # ADD FULLTEXT, then verify
 *   3. backend + frontend deploy (bundle C)
 *
 * CHECK (default), read-only: the file parses into exactly one ALTER TABLE
 * mail_messages ADD FULLTEXT INDEX ft_mail_messages_text (subject, body_text);
 * the table has both columns; the index is absent, or present as a FULLTEXT
 * over exactly those two columns in that order (a re-run); prints the row and
 * byte counts the rebuild will touch. Anything else is NO-GO, nothing written.
 * --apply: runs the ALTER when the index is absent (MySQL has no ADD INDEX IF
 * NOT EXISTS — THIS script is the idempotency), then VERIFIES the index type
 * and columns and that a MATCH against it parses (a SELECT COUNT(*) … MATCH …
 * AGAINST ('+a*' IN BOOLEAN MODE) runs). Re-runnable.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10: the first
 * FULLTEXT index on an InnoDB table rebuilds it (INPLACE, LOCK=SHARED — reads
 * go on, writes to mail_messages wait for the seconds the build takes; 8.4.11
 * refuses LOCK=NONE for a FULLTEXT build) — behind a long transaction it
 * gives up in seconds (NO-GO, re-run later) instead of stalling every mail
 * read. One GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-16_mail_fulltext_search.sql');
const TABLE = 'mail_messages';
const INDEX = 'ft_mail_messages_text';
const COLUMNS = ['subject', 'body_text'];

function statementsOf(sqlText) {
  const noComments = sqlText.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return noComments.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

async function liveIndex(conn) {
  const [rows] = await conn.query(
    `SELECT INDEX_TYPE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`, [TABLE, INDEX]);
  if (!rows.length) return null;
  return { type: rows[0].INDEX_TYPE, columns: rows.map((r) => r.COLUMN_NAME) };
}

async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');
  const stmts = statementsOf(fs.readFileSync(MIGRATION, 'utf8'));
  const alter = stmts[0];
  const shape = new RegExp(`^ALTER TABLE \`${TABLE}\`\\s+ADD FULLTEXT INDEX \`${INDEX}\` \\(\`${COLUMNS[0]}\`, \`${COLUMNS[1]}\`\\)$`);
  if (stmts.length !== 1 || !shape.test(alter)) {
    const line = `NO-GO — ${path.basename(MIGRATION)} must hold exactly one ALTER TABLE ${TABLE} ADD FULLTEXT INDEX ${INDEX} (${COLUMNS.join(', ')}) (found ${stmts.length} statement(s)). Nothing was changed.`;
    say(line); return { ok: false, line };
  }
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?)`, [TABLE, COLUMNS]);
  if (cols.length !== COLUMNS.length) {
    const line = `NO-GO — ${TABLE} lacks ${COLUMNS.filter((c) => !cols.some((r) => r.COLUMN_NAME === c)).join(', ')}. Nothing was changed.`;
    say(line); return { ok: false, line };
  }
  const [[size]] = await conn.query(`SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(CHAR_LENGTH(body_text)), 0) / 1048576, 1) AS mb FROM \`${TABLE}\``);
  const before = await liveIndex(conn);
  say(`${TABLE}: ${size.n} rows, ${size.mb} MB of body_text`);
  if (!before) say(`  index ${INDEX}: absent — --apply adds it (the table is rebuilt once, INPLACE)`);
  else {
    say(`  index ${INDEX}: present — ${before.type} over (${before.columns.join(', ')})`);
    if (before.type !== 'FULLTEXT' || before.columns.join(',') !== COLUMNS.join(',')) {
      const line = `NO-GO — ${INDEX} exists but is not a FULLTEXT index over (${COLUMNS.join(', ')}). Nothing was changed.`;
      say(line); return { ok: false, line };
    }
  }
  if (!apply) {
    const line = `GO — CHECK passed; --apply would do: ${before ? 'nothing (already applied)' : `ADD FULLTEXT INDEX ${INDEX}`}. Next: node scripts/commsPolish2MailFulltext.js --apply`;
    say(line); return { ok: true, line };
  }
  if (!before) {
    try {
      const t0 = Date.now();
      await conn.query(alter);
      say(`  ✓ ${alter.replace(/\s+/g, ' ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      const line = `NO-GO — the ALTER failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
      say(line); return { ok: false, line };
    }
  }
  const after = await liveIndex(conn);
  const problems = [];
  if (!after) problems.push('the index is missing after the ALTER');
  else if (after.type !== 'FULLTEXT' || after.columns.join(',') !== COLUMNS.join(',')) problems.push(`the index is ${after.type} over (${after.columns.join(', ')})`);
  try {
    await conn.query(`SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE MATCH(\`${COLUMNS[0]}\`, \`${COLUMNS[1]}\`) AGAINST (? IN BOOLEAN MODE)`, ['+paystub*']);
  } catch (err) { problems.push(`a MATCH against the index does not run: ${err.code || ''} ${err.message}`); }
  for (const p of problems) say(`  ✗ ${p}`);
  if (problems.length) {
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line); return { ok: false, line };
  }
  say(`  ✓ verified: ${INDEX} is FULLTEXT over (${after.columns.join(', ')}); a boolean MATCH runs`);
  const line = 'GO — the body-search index is in place. Next: land bundle C (backend + frontend).';
  say(line); return { ok: true, line };
}

module.exports = { run, statementsOf, MIGRATION, TABLE, INDEX, COLUMNS };

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
