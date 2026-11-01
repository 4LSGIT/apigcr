#!/usr/bin/env node
// scripts/launcherL5ToolsVisibleTo.js
//
/**
 * launcher-nits L5 — adds tools.visible_to, the role allow-list for the tool
 * picker. ref/AI_CONTEXT.md §31; the DDL is
 * ref/migrations/2026-11-01_tools_visible_to.sql, read from disk so the file
 * and the applied column can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/launcherL5ToolsVisibleTo.js            # CHECK — read-only
 *   2. node scripts/launcherL5ToolsVisibleTo.js --apply    # ALTER, then verify
 *   3. backend deploy, then frontend deploy
 *
 * CHECK (default): `tools` has exactly the columns this script expects, and
 * visible_to is absent (GO, next: --apply) or present with the expected shape
 * (GO, nothing to do). Any other shape is NO-GO — nothing is altered.
 *
 * --apply: runs the migration file's ALTER when the column is absent, then
 * VERIFIES the end state:
 *   - the column's type, nullability, default and COMMENT;
 *   - every tool is still NULL (nobody restricted by the migration);
 *   - on the engine, in a transaction that is ROLLED BACK: a list written to
 *     one tool reads back as a list, the shape the picker filters on.
 * Re-runnable: a run that stopped part-way resumes from wherever it is.
 *
 * USAGE (repo root, .env reaching production — the `npm run db:ref` setup).
 * Each run ends with ONE line: GO or NO-GO, naming the next step.
 * One connection; session settings: time_zone +00:00, lock_wait_timeout 5 and
 * innodb_lock_wait_timeout 5 (an ALTER queued behind a long transaction stalls
 * every query on the table, and the global default is a year).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-01_tools_visible_to.sql');
const TABLE = 'tools';
const COLUMN = 'visible_to';
const BASE_COLUMNS = Object.freeze(['id', 'tool_key', 'title', 'status', 'html', 'updated_by', 'created_at', 'updated_at']);

const SQL = Object.freeze({
  columns: `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable,
                   COLUMN_DEFAULT AS def, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  restricted: `SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${COLUMN} IS NOT NULL`,
  firstTool: `SELECT id FROM ${TABLE} ORDER BY id LIMIT 1`,
  probeWrite: `UPDATE ${TABLE} SET ${COLUMN} = ? WHERE id = ?`,
  probeRead: `SELECT ${COLUMN} AS v FROM ${TABLE} WHERE id = ?`,
});

const PROBE = Object.freeze(['staff', 'attorney']);

/** The migration file's statements. Each ends with ';' at END OF LINE — the COMMENT may hold ';' mid-line. */
function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

/** The COMMENT the migration file gives the column — the one definition of it. */
function expectedComment() {
  const m = /COMMENT '([^']*)'/.exec(statements().join('\n'));
  if (!m) throw new Error('the migration file has no COMMENT');
  return m[1];
}

/** The live column list against the expected one → [problem lines] ([] = as expected). */
function shapeProblems(cols) {
  const problems = [];
  const have = new Map(cols.map((c) => [c.name, c]));
  for (const name of BASE_COLUMNS) if (!have.has(name)) problems.push(`column ${name} is missing`);
  for (const name of have.keys()) {
    if (name !== COLUMN && !BASE_COLUMNS.includes(name)) problems.push(`unexpected column ${name}`);
  }
  const c = have.get(COLUMN);
  if (c) {
    if (String(c.type).toLowerCase() !== 'json') problems.push(`${COLUMN} is ${c.type}, expected json`);
    if (c.nullable !== 'YES') problems.push(`${COLUMN} IS_NULLABLE ${c.nullable}, expected YES`);
    if (c.def !== null) problems.push(`${COLUMN} default ${c.def}, expected NULL`);
    if (c.comment !== expectedComment()) problems.push(`${COLUMN} COMMENT differs from the migration file`);
  }
  return problems;
}

/**
 * A list written to one tool reads back as a list, in a transaction that is
 * ROLLED BACK (updated_at with it). → null when it holds, else the problem.
 * No tools at all → nothing to probe on, and nothing to break.
 */
async function roundTripProbe(conn) {
  const [[tool]] = await conn.query(SQL.firstTool);
  if (!tool) return null;
  await conn.beginTransaction();
  try {
    await conn.query(SQL.probeWrite, [JSON.stringify(PROBE), tool.id]);
    const [[row]] = await conn.query(SQL.probeRead, [tool.id]);
    const v = row && row.v;
    return Array.isArray(v) && v.join() === PROBE.join() ? null
      : `a list written to ${COLUMN} read back as ${JSON.stringify(v)} (${Array.isArray(v) ? 'array' : typeof v})`;
  } catch (err) {
    return `the round-trip probe failed: ${err.message}`;
  } finally {
    await conn.rollback().catch(() => {});
  }
}

/** CHECK (apply:false) or alter + verify (apply:true). → { ok, line, altered } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');
  await conn.query('SET SESSION innodb_lock_wait_timeout = 5');

  const finish = (ok, line, altered) => { say(line); return { ok, line, altered }; };

  const [before] = await conn.query(SQL.columns, [TABLE]);
  if (!before.length) return finish(false, `NO-GO — table ${TABLE} is not there. Nothing was changed.`, false);
  const exists = before.some((c) => c.name === COLUMN);
  say(`${TABLE}.${COLUMN}: ${exists ? 'present' : 'absent'}`);

  const problems = shapeProblems(before);
  if (problems.length) {
    problems.forEach((p) => say(`  ✗ ${p}`));
    return finish(false, `NO-GO — ${TABLE} has another shape (above). Nothing was changed; this script never reshapes it.`, false);
  }

  if (!apply) {
    return finish(true, exists
      ? `CHECK OK — ${TABLE}.${COLUMN} is in place with the expected shape. GO (nothing to apply; next: the backend deploy).`
      : 'CHECK OK — GO. Next: node scripts/launcherL5ToolsVisibleTo.js --apply', false);
  }

  if (!exists) {
    for (const s of statements()) await conn.query(s);
    say(`  ✓ added ${TABLE}.${COLUMN}`);
  }

  const [after] = await conn.query(SQL.columns, [TABLE]);
  const left = after.some((c) => c.name === COLUMN) ? shapeProblems(after) : [`column ${COLUMN} is missing`];
  const [[{ n }]] = await conn.query(SQL.restricted);
  // Re-running after a superuser restricted a tool is fine; only a fresh ALTER
  // promises that every tool is still everyone's.
  if (!exists && Number(n) !== 0) left.push(`${n} tool(s) have a value right after the ALTER`);
  const probe = left.length ? null : await roundTripProbe(conn);
  if (left.length || probe) {
    left.forEach((p) => say(`  ✗ ${p}`));
    if (probe) say(`  ✗ ${probe}`);
    return finish(false, `NO-GO — ${TABLE}.${COLUMN} does not verify (above). Paste this output to Claude; do not deploy.`, !exists);
  }
  say('  ✓ shape verified; a list round-trips on the engine (probe rolled back)');
  return finish(true, `${exists ? 'ALREADY IN PLACE' : 'ADDED'} — ${TABLE}.${COLUMN} verified. GO. Next: the backend deploy.`, !exists);
}

module.exports = { run, statements, expectedComment, shapeProblems, roundTripProbe, MIGRATION, TABLE, COLUMN, BASE_COLUMNS, PROBE, SQL };

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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Re-run this command; it resumes from the live state. Do not deploy.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
