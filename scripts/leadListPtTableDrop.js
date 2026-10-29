#!/usr/bin/env node
// scripts/leadListPtTableDrop.js
//
/**
 * Lead-list merge arc — drop `master_contacts___leads_list___phil_tirone`, the
 * stalled phpMyAdmin CSV import of the Phil Tirone lead list (columns `COL 1`…
 * `COL 21`, the CSV header row stored as data). Its people are YC contacts now:
 * the earlier list import tagged 'phil tirone', and scripts/leadListImport.js
 * tags/creates the rest from the same list (the "Phil Tirone" tab of SS's lead
 * workbook, which stays the copy of record). Fred's ruling #8 (2026-10-29):
 * drop it after the import, behind a sweep. The applied SQL is in
 * ref/migrations/2026-10-29_lead_list_drop_pt_raw_table.sql — there is no
 * ROLLBACK short of re-importing that workbook tab.
 *
 * USAGE (repo root; .env reaches production, same setup as npm run db:ref):
 *   node scripts/leadListPtTableDrop.js            # CHECK — read-only
 *   node scripts/leadListPtTableDrop.js --apply    # drop the table
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). Before any
 * write, CHECK and --apply alike assert:
 *   - the table is exactly the import: 21 varchar columns `COL 1`…`COL 21`,
 *     no primary key, no index (so it cannot be a table someone repurposed);
 *   - the lead import has run (contacts carry its "[lead:" markers);
 *   - nothing names the table — in the schema (trigger, view, routine, event,
 *     foreign key, a grant in mysql.tables_priv / columns_priv when this
 *     account may read them), in a stored definition (every text / json /
 *     long-varchar column of the tables that hold report SQL, saved queries,
 *     workflow / sequence / trigger / hook / ingest configs, tools, pages,
 *     templates, settings), or in this checkout's code.
 * --apply then: SET SESSION lock_wait_timeout = 5 (the global default is a
 * year), re-reads and re-asserts on that session, DROP TABLE, and verifies the
 * table is gone and the sweep is still clean. RE-RUNNABLE: with the table
 * already gone, CHECK and --apply re-verify and change nothing. Ends on ONE
 * GO / NO-GO line.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TABLE = 'master_contacts___leads_list___phil_tirone';
// what a reference must contain: the distinctive part, so `…phil_tirone2`-style siblings are caught too
const NEEDLE = 'leads_list___phil_tirone';
const COLS = Array.from({ length: 21 }, (_, i) => `COL ${i + 1}`);
// tables whose rows hold definitions something could run against the table
const DEFINITION_TABLES = [
  'admin_saved_queries', 'api_saved_requests', 'app_settings', 'settings', 'shared_values',
  'report_definitions', 'report_definition_versions', 'scheduled_jobs',
  'workflows', 'workflow_steps', 'workflow_versions',
  'sequence_templates', 'sequence_template_versions', 'sequence_steps',
  'trigger_rules', 'trigger_rule_actions', 'hooks', 'hook_targets',
  'email_ingest_rules', 'email_ingest_rule_actions', 'email_ingest_log_suppressions',
  'phone_ingest_rules', 'phone_ingest_rule_actions', 'phone_log_suppressions',
  'tools', 'tool_versions', 'pages', 'portal_cards', 'form_templates', 'form_template_versions',
  'contract_templates', 'cta_links', 'campaigns', 'pipeline_stages', 'pipeline_stage_requirements',
  'ui_config', 'ui_config_versions', 'field_defs', 'booking_views', 'ai_match_sets', 'ai_match_types',
];
const CODE_SKIP = new Set(['node_modules', '.git', 'ref/database.sql', 'ref/routes.md', 'TRACKED_FILES.txt',
  'scripts/leadListPtTableDrop.js', 'ref/migrations/2026-10-29_lead_list_drop_pt_raw_table.sql']);
const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS = 120_000;

async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}
const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

/** Where anything in the database names the table → ["what", …]. */
async function sweepDb(conn) {
  const refs = [];
  const hit = (s) => String(s == null ? '' : s).toLowerCase().includes(NEEDLE);
  for (const [label, sql] of [
    ['trigger', 'SELECT TRIGGER_NAME AS name, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()'],
    ['view', 'SELECT TABLE_NAME AS name, VIEW_DEFINITION AS body FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()'],
    ['routine', 'SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS body FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()'],
    ['event', 'SELECT EVENT_NAME AS name, EVENT_DEFINITION AS body FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()'],
  ]) {
    for (const r of await q(conn, sql)) if (hit(r.body)) refs.push(`${label} ${r.name}`);
  }
  for (const r of await q(conn,
    `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ?`, [TABLE])) refs.push(`foreign key ${r.name} on ${r.t}`);
  let grants = 'checked';
  for (const t of ['tables_priv', 'columns_priv']) {
    try {
      for (const r of await q(conn, `SELECT User AS u, Host AS h FROM mysql.${t} WHERE Db = DATABASE() AND Table_name = ?`, [TABLE])) {
        refs.push(`grant in mysql.${t} for ${r.u}@${r.h}`);
      }
    } catch (_) { grants = 'not readable by this account (only root can see them; none is expected)'; }
  }
  const cols = await q(conn,
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)
        AND (DATA_TYPE IN ('text', 'mediumtext', 'longtext', 'json')
          OR (DATA_TYPE IN ('varchar', 'char') AND CHARACTER_MAXIMUM_LENGTH >= ?))
      ORDER BY TABLE_NAME, ORDINAL_POSITION`, [DEFINITION_TABLES, NEEDLE.length]);
  const tables = new Set(cols.map(r => r.t));
  for (const r of cols) {
    const [n] = await q(conn, `SELECT COUNT(*) AS n FROM ${qi(r.t)} WHERE LOCATE(?, CAST(${qi(r.c)} AS CHAR)) > 0`, [NEEDLE]);
    if (Number(n.n) > 0) refs.push(`${n.n} row(s) of ${r.t}.${r.c}`);
  }
  return { refs, grants, searched: `${cols.length} columns in ${tables.size} definition tables` };
}

/** Files in this checkout that name the table → ["path:line", …]. */
function sweepCode(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (CODE_SKIP.has(rel) || CODE_SKIP.has(e.name)) continue;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!e.isFile() || !/\.(js|mjs|cjs|json|sql|html|md|sh|txt)$/i.test(e.name)) continue;
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      if (!text.toLowerCase().includes(NEEDLE)) continue;
      text.split('\n').forEach((l, i) => { if (l.toLowerCase().includes(NEEDLE)) out.push(`${rel}:${i + 1}`); });
    }
  };
  walk('');
  return out;
}

async function readState(conn, root) {
  const [who] = await q(conn, 'SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v');
  const cols = await q(conn,
    `SELECT COLUMN_NAME AS c, DATA_TYPE AS t, COLUMN_KEY AS k FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [TABLE]);
  const present = cols.length > 0;
  let rows = null, indexes = 0;
  if (present) {
    rows = Number((await q(conn, `SELECT COUNT(*) AS n FROM ${qi(TABLE)}`))[0].n);
    indexes = Number((await q(conn,
      'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]))[0].n);
  }
  const [imp] = await q(conn, "SELECT COUNT(*) AS n FROM contacts WHERE contact_notes LIKE '%[lead:%'");
  const db = await sweepDb(conn);
  return { user: who.cu, db: who.db, version: who.v, present, cols, rows, indexes, imported: Number(imp.n), ...db, code: sweepCode(root) };
}

function problemsOf(s) {
  const p = [];
  if (s.present) {
    const names = s.cols.map(c => c.c);
    if (JSON.stringify(names) !== JSON.stringify(COLS)) p.push(`${TABLE} has columns ${names.join(', ')} — not the 21-column CSV import this script expects`);
    if (s.cols.some(c => c.t !== 'varchar')) p.push(`${TABLE} has a non-varchar column — not the CSV import this script expects`);
    if (s.indexes) p.push(`${TABLE} has ${s.indexes} index entr(ies) — not the bare CSV import this script expects`);
    if (!s.imported) p.push('no contact carries a "[lead:" marker — run scripts/leadListImport.js first (ruling #8: drop after the import)');
  }
  for (const r of s.refs) p.push(`the database names the table: ${r}`);
  for (const r of s.code) p.push(`this checkout names the table: ${r}`);
  return p;
}

async function run(conn, { apply = false, log = console.log, root = path.join(__dirname, '..') } = {}) {
  log(`\n=== lead-list arc — drop ${TABLE} — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);
  let s = await readState(conn, root);
  log(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  log(s.present ? `${TABLE}: ${s.cols.length} columns, ${s.rows} rows (the CSV header row included)` : `${TABLE}: already dropped`);
  log(`lead import: ${s.imported} contact(s) carry its marker`);
  log(`swept: schema objects, foreign keys, grants (${s.grants}), ${s.searched}, this checkout's code`);
  let p = problemsOf(s);
  if (!s.present) {
    p.forEach(x => log('  ✗ ' + x));
    const line = p.length ? `NO-GO — the table is gone but ${p.length} reference(s) above remain. Paste this output.`
      : 'ALREADY APPLIED — GO. Nothing to do; the pre-commit hook drops it from ref/database.sql on the next commit.';
    log('\n' + line);
    return { ok: !p.length, state: p.length ? 'dropped-dirty' : 'applied', line };
  }
  if (p.length) {
    p.forEach(x => log('  ✗ ' + x));
    const line = `NO-GO — ${p.length} problem(s) above. Nothing was changed.`;
    log('\n' + line);
    return { ok: false, state: 'blocked', line };
  }
  log('  ✓ the table is the bare 21-column import, the lead import has run, nothing names the table');
  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/leadListPtTableDrop.js --apply';
    log('\n' + line);
    return { ok: true, state: 'check', line };
  }
  await q(conn, 'SET SESSION lock_wait_timeout = 5');
  s = await readState(conn, root);                     // re-read on the session that will DROP
  p = problemsOf(s);
  if (!s.present || p.length) {
    p.forEach(x => log('  ✗ ' + x));
    const line = `NO-GO — the state changed between CHECK and apply${s.present ? '' : ' (the table is already gone)'}. Nothing was changed by this run; run it again.`;
    log('\n' + line);
    return { ok: false, state: 'changed', line };
  }
  await q(conn, `DROP TABLE ${qi(TABLE)}`, [], DDL_TIMEOUT_MS);
  log(`  ✓ DROP TABLE ${qi(TABLE)}  (${s.rows} rows)`);
  const after = await readState(conn, root);
  const issues = [];
  if (after.present) issues.push(`${TABLE} is still there`);
  for (const r of problemsOf(after)) issues.push(r);
  if (issues.length) {
    issues.forEach(x => log('  ✗ ' + x));
    const line = 'NO-GO — the drop ran but the result does not verify. Paste this output.';
    log('\n' + line);
    return { ok: false, state: 'verify-failed', line };
  }
  const line = `APPLIED — GO. ${TABLE} is gone. Next: any commit regenerates ref/database.sql (pre-commit hook).`;
  log('\n' + line);
  return { ok: true, state: 'applied-now', line };
}

module.exports = { run, readState, problemsOf, sweepCode, TABLE, NEEDLE, COLS, DEFINITION_TABLES };

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
      for (const k of ['host', 'user', 'database']) {
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
