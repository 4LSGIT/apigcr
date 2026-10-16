#!/usr/bin/env node
// scripts/uiCustomConfigKeyComment.js
//
/**
 * ui-custom arc close — correct the COMMENTs on ui_config: the config_key
 * column (it lists only "user shortcuts"; layout, items and prefs arrived in
 * S4a, S5a and S5d) and the table (it says "launcher" documents; prefs holds
 * the theme). This changes the two COMMENTs and nothing else, in ONE ALTER.
 *
 * USAGE (repo root; .env reaches production, same setup as npm run db:ref):
 *   node scripts/uiCustomConfigKeyComment.js            # CHECK — read-only
 *   node scripts/uiCustomConfigKeyComment.js --apply    # change the comment
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). --apply:
 *   1. asserts the live column is exactly what this script expects (type,
 *      nullability, default, charset, collation, extra) — anything else is
 *      NO-GO and nothing is changed;
 *   2. SET SESSION lock_wait_timeout = 5 (the global default is a year; a
 *      metadata lock queued behind a long transaction would stall every
 *      query on the table);
 *   3. ONE ALTER: MODIFY COLUMN with the SAME definition and the new COMMENT, plus the table COMMENT,
 *      ALGORITHM=INPLACE, LOCK=NONE — metadata-only (no rebuild; reads and writes keep
 *      running). Not INSTANT: MySQL 8.4 refuses ALGORITHM=INSTANT for a TABLE comment
 *      (error 1845; proven on 8.4.11). INPLACE does not fail closed on a rebuild, so the
 *      guard against one is step 1's exact six-field definition check;
 *   4. re-reads and verifies every attribute plus the new comment.
 * RE-RUNNABLE: when the comment is already the new text, CHECK and --apply
 * both report ALREADY APPLIED and change nothing. Ends on ONE GO / NO-GO line.
 */
'use strict';

const TABLE = 'ui_config';
const COLUMN = 'config_key';
const OLD_COMMENT = 'app-validated per scope: firm registry_overrides | user shortcuts (lib/uiConfigShape.js CONFIG_KEYS)';
const NEW_COMMENT = 'app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides | user layout, shortcuts, items, prefs';
const OLD_TABLE_COMMENT = 'ui-custom launcher config documents (PLAN §6): firm overlay + per-user layers, delivered by /api/firm-data ui and GET /api/ui-config, written by PUT /api/ui-config. Firm writes are versioned in ui_config_versions; user writes are not.';
const NEW_TABLE_COMMENT = 'ui-custom config documents (PLAN §6): the firm launcher overlay + per-user layers (layout, shortcuts, own buttons, theme prefs), delivered by /api/firm-data ui and GET /api/ui-config, written by PUT /api/ui-config. Firm writes are versioned in ui_config_versions; user writes are not.';
const EXPECT = {
  COLUMN_TYPE: 'varchar(50)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null,
  CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci', EXTRA: '',
};
const SQL = {
  read: 'SELECT c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.CHARACTER_SET_NAME, c.COLLATION_NAME, c.EXTRA, c.COLUMN_COMMENT, ' +
        't.TABLE_COMMENT, t.TABLE_COLLATION FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ' +
        'ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME ' +
        'WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? AND c.COLUMN_NAME = ?',
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  alter: 'ALTER TABLE `ui_config` MODIFY COLUMN `config_key` varchar(50) ' +
         'CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT ?, COMMENT = ?, ALGORITHM=INPLACE, LOCK=NONE',
};

/** Problems with the live column's definition (comment aside); [] = as expected. */
function definitionProblems(col) {
  if (!col) return [`${TABLE}.${COLUMN} not found`];
  const out = [];
  for (const k of Object.keys(EXPECT)) {
    if (col[k] !== EXPECT[k]) out.push(`${k} is ${JSON.stringify(col[k])}, expected ${JSON.stringify(EXPECT[k])}`);
  }
  return out;
}

async function readColumn(conn) {
  const [rows] = await conn.query(SQL.read, [TABLE, COLUMN]);
  return rows[0] || null;
}

/** run(conn, { apply }) → { ok, state, line } — the whole script, testable.
 *  Both comments must each be exactly the OLD or exactly the NEW text; the
 *  ALTER only runs when BOTH are old (one statement, so they move together). */
async function run(conn, { apply = false, log = console.log } = {}) {
  const col = await readColumn(conn);
  const probs = definitionProblems(col);
  if (probs.length) {
    probs.forEach((p) => log('  ✗ ' + p));
    const line = `NO-GO — ${TABLE}.${COLUMN} is not the column this script expects. Nothing was changed.`;
    log(line); return { ok: false, state: 'unexpected', line };
  }
  log(`  ✓ ${TABLE}.${COLUMN}: ${col.COLUMN_TYPE} NOT NULL ${col.CHARACTER_SET_NAME}/${col.COLLATION_NAME}`);
  log(`  column comment: ${JSON.stringify(col.COLUMN_COMMENT)}`);
  log(`  table comment:  ${JSON.stringify(col.TABLE_COMMENT)}`);
  const colNew = col.COLUMN_COMMENT === NEW_COMMENT, tabNew = col.TABLE_COMMENT === NEW_TABLE_COMMENT;
  const colOld = col.COLUMN_COMMENT === OLD_COMMENT, tabOld = col.TABLE_COMMENT === OLD_TABLE_COMMENT;
  if (colNew && tabNew) {
    const line = 'ALREADY APPLIED — GO. Nothing to do; the pre-commit hook regenerates ref/database.sql on the next commit.';
    log(line); return { ok: true, state: 'applied', line };
  }
  if (!(colOld && tabOld)) {
    const line = 'NO-GO — the comments are not both the old text (someone changed one, or a partial state). Nothing was changed.';
    log(line); return { ok: false, state: 'unknown-comment', line };
  }
  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/uiCustomConfigKeyComment.js --apply';
    log(line); return { ok: true, state: 'check', line };
  }
  await conn.query(SQL.lockWait);
  await conn.query(SQL.alter, [NEW_COMMENT, NEW_TABLE_COMMENT]);
  log('  ✓ ALTER … column COMMENT + table COMMENT (ALGORITHM=INPLACE, LOCK=NONE)');
  const after = await readColumn(conn);
  const after_ = definitionProblems(after);
  const okAfter = after && after.COLUMN_COMMENT === NEW_COMMENT && after.TABLE_COMMENT === NEW_TABLE_COMMENT;
  if (after_.length || !okAfter) {
    after_.forEach((p) => log('  ✗ ' + p));
    if (after) log(`  ✗ read back: column ${JSON.stringify(after.COLUMN_COMMENT)} / table ${JSON.stringify(after.TABLE_COMMENT)}`);
    const line = 'NO-GO — the table does not read back as expected after the ALTER. Paste this output.';
    log(line); return { ok: false, state: 'verify-failed', line };
  }
  log('  ✓ verified: definition unchanged, both comments are the new text');
  const line = 'APPLIED — GO. Next: any commit regenerates ref/database.sql (pre-commit hook).';
  log(line); return { ok: true, state: 'applied-now', line };
}

module.exports = { run, definitionProblems, OLD_COMMENT, NEW_COMMENT, OLD_TABLE_COMMENT, NEW_TABLE_COMMENT, EXPECT, SQL };

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
