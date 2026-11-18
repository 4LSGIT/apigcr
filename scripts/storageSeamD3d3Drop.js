#!/usr/bin/env node
// scripts/storageSeamD3d3Drop.js
//
/**
 * storage-seam D3d-3 — CONTRACT: DROP the retired pair, `cases.case_dropbox`
 * and `case_folder_cache`. The entity_folders binding has been their only
 * reader and writer since D3d-2 (ref/DOCUMENTS_V3_DESIGN.md §3, §9 D3;
 * CLAUDE.md "Dropping a COLUMN"). Record:
 * ref/migrations/<date>_storage_seam_d3d3_drop.sql (written when applied).
 *
 *   node scripts/storageSeamD3d3Drop.js            # CHECK (read-only)
 *   node scripts/storageSeamD3d3Drop.js --apply    # drop + verify
 *
 * THE GATE (every check must pass, or NO-GO; nothing is dropped on a NO-GO):
 *   1. the pair still exists (both gone → ALREADY APPLIED);
 *   2. no STORED DEFINITION names either — workflow_steps.config,
 *      trigger_rule_actions.config, sequence_steps.action_config,
 *      scheduled_jobs.data, report_definitions / report_definition_versions
 *      .sql_text, contract_templates.body, pages.html (the D3d-2 sweep's set);
 *   3. no TRIGGER or VIEW names either (a trigger naming the column lets the
 *      DROP succeed and then fails every UPDATE on cases — CLAUDE.md);
 *   4. the binding COVERS the pair: every case whose column holds a link has a
 *      binding whose human_link equals it (trimmed), and every cache row has a
 *      binding with the same path_lower — the soak's proof that nothing wrote
 *      only the old pair since D3d-2;
 *   5. the report manifest (lib/reportSchema/manifest.js) no longer lists
 *      cases.case_dropbox — D3d-2b's deploy and its yc_report regrant precede
 *      this drop (a column the manifest still names would turn every report
 *      selecting it into an error).
 * --apply: SET SESSION lock_wait_timeout = 5 (a metadata lock queued behind a
 * long transaction must fail fast, not stall every query on cases), ALTER TABLE
 * cases DROP COLUMN case_dropbox, DROP TABLE case_folder_cache, then re-read
 * information_schema to verify both are gone. Resumable: a run that dropped one
 * and died drops the other. Ends on ONE GO / NO-GO line.
 * AFTER: re-run scripts/reportGrantUserProvision.js --apply --rotate (root) so
 * the dropped column's orphaned mysql.columns_priv grant goes too (CLAUDE.md:
 * harmless until a column of the same name is re-added, which it then covers).
 */

'use strict';

const path = require('path');

const COLUMN = 'case_dropbox';
const TABLE = 'case_folder_cache';

const SQL = Object.freeze({
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  columnExists: "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases' AND COLUMN_NAME = 'case_dropbox'",
  tableExists: "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'case_folder_cache'",
  // stored definitions (2): one row per (table, column), n = rows naming either name
  definitions: [
    ['workflow_steps', 'config'], ['trigger_rule_actions', 'config'], ['sequence_steps', 'action_config'], ['scheduled_jobs', 'data'],
    ['report_definitions', 'sql_text'], ['report_definition_versions', 'sql_text'], ['contract_templates', 'body'], ['pages', 'html'],
  ].map(([t, c]) => ({ table: t, column: c, sql: `SELECT COUNT(*) AS n FROM \`${t}\` WHERE CAST(\`${c}\` AS CHAR) LIKE '%case\\_dropbox%' OR CAST(\`${c}\` AS CHAR) LIKE '%case\\_folder\\_cache%'` })),
  triggers: "SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND (ACTION_STATEMENT LIKE '%case\\_dropbox%' OR ACTION_STATEMENT LIKE '%case\\_folder\\_cache%')",
  views: "SELECT COUNT(*) AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND (VIEW_DEFINITION LIKE '%case\\_dropbox%' OR VIEW_DEFINITION LIKE '%case\\_folder\\_cache%')",
  // coverage (4): the column's links vs the bindings' links; the cache's paths vs the bindings' paths
  columnRows: "SELECT COUNT(*) AS n FROM cases WHERE case_dropbox IS NOT NULL AND TRIM(case_dropbox) <> ''",
  columnUncovered: "SELECT COUNT(*) AS n FROM cases c LEFT JOIN entity_folders e ON e.entity_kind = 'case' AND e.source = 'dropbox' AND e.entity_id = c.case_id WHERE c.case_dropbox IS NOT NULL AND TRIM(c.case_dropbox) <> '' AND NOT (e.human_link <=> TRIM(c.case_dropbox))",
  cacheRows: 'SELECT COUNT(*) AS n FROM case_folder_cache',
  cacheUncovered: "SELECT COUNT(*) AS n FROM case_folder_cache f LEFT JOIN entity_folders e ON e.entity_kind = 'case' AND e.source = 'dropbox' AND e.entity_id = f.case_id WHERE NOT (e.path_lower <=> f.path_lower)",
  dropColumn: 'ALTER TABLE cases DROP COLUMN case_dropbox',
  dropTable: 'DROP TABLE case_folder_cache',
});

function manifestNamesColumn() {
  const { TABLES } = require(path.join(__dirname, '..', 'lib', 'reportSchema', 'manifest'));
  return !!(TABLES && TABLES.cases && TABLES.cases.columns && TABLES.cases.columns[COLUMN]);
}

const n = (rows) => Number((rows && rows[0] && rows[0].n) || 0);

async function run(conn, { apply = false, log = console.log, manifestCheck = manifestNamesColumn } = {}) {
  const column = n((await conn.query(SQL.columnExists))[0]) > 0;
  const table = n((await conn.query(SQL.tableExists))[0]) > 0;
  log(`live: cases.${COLUMN} ${column ? 'EXISTS' : 'gone'}; ${TABLE} ${table ? 'EXISTS' : 'gone'}`);
  if (!column && !table) {
    const line = `ALREADY APPLIED — GO. cases.${COLUMN} and ${TABLE} are gone. Next: scripts/reportGrantUserProvision.js --apply --rotate (the orphaned grant).`;
    log(line); return { ok: true, dropped: [], line };
  }

  const problems = [];
  for (const d of SQL.definitions) {
    const count = n((await conn.query(d.sql))[0]);
    if (count) problems.push(`${count} ${d.table}.${d.column} row(s) name the pair`);
  }
  const trig = n((await conn.query(SQL.triggers))[0]);
  if (trig) problems.push(`${trig} trigger(s) name the pair`);
  const views = n((await conn.query(SQL.views))[0]);
  if (views) problems.push(`${views} view(s) name the pair`);
  let coverage = '';
  if (column) {
    const rows = n((await conn.query(SQL.columnRows))[0]);
    const bad = n((await conn.query(SQL.columnUncovered))[0]);
    coverage += `${rows} column link(s), ${bad} not on the binding`;
    if (bad) problems.push(`${bad} case(s) hold a link in cases.${COLUMN} that the binding does not (something wrote only the column — find it before dropping)`);
  }
  if (table) {
    const rows = n((await conn.query(SQL.cacheRows))[0]);
    const bad = n((await conn.query(SQL.cacheUncovered))[0]);
    coverage += `${coverage ? '; ' : ''}${rows} cache row(s), ${bad} not on the binding`;
    if (bad) problems.push(`${bad} ${TABLE} row(s) carry a path the binding does not`);
  }
  log(`coverage: ${coverage || 'n/a'}`);
  if (column && manifestCheck()) problems.push(`lib/reportSchema/manifest.js still lists cases.${COLUMN} (land D3d-2b and run the yc_report regrant first)`);

  if (problems.length) {
    const line = `NO-GO — ${problems.join('; ')}. Nothing dropped.`;
    log(line); return { ok: false, dropped: [], line, problems };
  }
  if (!apply) {
    const line = `CHECK OK — GO. Would drop ${[column && `cases.${COLUMN}`, table && TABLE].filter(Boolean).join(' and ')}. Next: --apply.`;
    log(line); return { ok: true, dropped: [], line };
  }

  await conn.query(SQL.lockWait);
  const dropped = [];
  if (column) { await conn.query(SQL.dropColumn); dropped.push(`cases.${COLUMN}`); log(`  ✓ ${SQL.dropColumn}`); }
  if (table) { await conn.query(SQL.dropTable); dropped.push(TABLE); log(`  ✓ ${SQL.dropTable}`); }
  const columnAfter = n((await conn.query(SQL.columnExists))[0]) > 0;
  const tableAfter = n((await conn.query(SQL.tableExists))[0]) > 0;
  if (columnAfter || tableAfter) {
    const line = `NO-GO — after the drop: cases.${COLUMN} ${columnAfter ? 'STILL EXISTS' : 'gone'}, ${TABLE} ${tableAfter ? 'STILL EXISTS' : 'gone'}. Re-run to finish.`;
    log(line); return { ok: false, dropped, line };
  }
  const line = `APPLIED — GO. Dropped ${dropped.join(' and ')}; both verified gone. Next: scripts/reportGrantUserProvision.js --apply --rotate (the orphaned grant), then node scripts/dump-schema.js on the next commit.`;
  log(line); return { ok: true, dropped, line };
}

module.exports = { run, SQL, COLUMN, TABLE, manifestNamesColumn };

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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was dropped unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
