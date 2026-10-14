#!/usr/bin/env node
// scripts/accessSec3SensitiveTier.js
//
/**
 * Access-control SEC-3 — the sensitive-read tier's two schema pieces
 * (ref/ACCESS_CONTROL_DESIGN.md §5.7). The applied SQL is recorded in
 * ref/migrations/2026-10-14_access_sec3_sensitive_tier.sql.
 *
 *   A  readonly_query_log.sensitive_key — tinyint(1) NOT NULL DEFAULT 0: 1
 *      when the session key that ran the statement held sql.ro.sensitive.
 *      (Not `sensitive`: SENSITIVE is a MySQL reserved word.)
 *      ALGORITHM=INSTANT (metadata-only on 8.4; refused rather than copied).
 *   B  VIEW ai_spend — ai_calls' metadata columns only (no error,
 *      request_excerpt, response): spend monitoring for ordinary session
 *      keys once ai_calls joins SENSITIVE_TABLES. SQL SECURITY INVOKER: the
 *      view grants nothing its reader could not already SELECT.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: run THIS FIRST, then land + deploy SEC-3.                 │
 * │ The SEC-3 backend writes readonly_query_log.sensitive_key on every      │
 * │ /api/readonly/sql call — before the column exists every log INSERT     │
 * │ fails (fire-and-forget: queries still answer, the audit goes dark).    │
 * │ The old backend never names the column (explicit INSERT column list)   │
 * │ and never reads the view, so running this first is safe.               │
 * │ The view alone is order-free — nothing server-side reads it.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * NOTE: lib/schemaDump enumerates BASE TABLEs only, so ai_spend never appears
 * in ref/database.sql — the migration record is the view's definition of
 * record.
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/accessSec3SensitiveTier.js           # CHECK — read-only, prints plan
 *   node scripts/accessSec3SensitiveTier.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * A column or view that already exists in ANY other shape is a NO-GO, never
 * altered.
 */

'use strict';

const LOG = 'readonly_query_log';
const VIEW = 'ai_spend';
const SPEND_COLUMNS = [
  'id', 'created_at', 'prompt_key', 'prompt_version', 'model', 'mode', 'output_type',
  'consumer_ref', 'status', 'input_tokens', 'output_tokens', 'cost_cents', 'latency_ms',
];
const CONTENT_COLUMNS = ['error', 'request_excerpt', 'response'];   // what the view leaves out

const COMMENT = '1 = the session key held sql.ro.sensitive (access SEC-3)';
const ALTER_SQL =
  `ALTER TABLE \`${LOG}\` ADD COLUMN \`sensitive_key\` tinyint(1) NOT NULL DEFAULT 0 ` +
  `COMMENT '${COMMENT}' AFTER \`status\`, ALGORITHM=INSTANT`;
const VIEW_SQL =
  `CREATE SQL SECURITY INVOKER VIEW \`${VIEW}\` AS SELECT ` +
  SPEND_COLUMNS.map(c => `\`${c}\``).join(', ') + ' FROM `ai_calls`';

async function columnsOf(conn, table) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLUMN_DEFAULT def, COLUMN_COMMENT comment
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`, [table]);
  return cols;
}

async function tableType(conn, name) {
  const [[t]] = await conn.query(
    `SELECT TABLE_TYPE type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [name]);
  return t ? t.type : null;
}

/** Live state of both pieces + what is wrong with it (empty = fine). */
async function state(conn) {
  const problems = [];

  // base: ai_calls carries every column the view selects
  const ai = (await columnsOf(conn, 'ai_calls')).map(c => c.name);
  const missing = SPEND_COLUMNS.filter(c => !ai.includes(c));
  if (!ai.length) problems.push('ai_calls does not exist');
  else if (missing.length) problems.push(`ai_calls lacks [${missing.join(', ')}]`);

  // A — the log column
  if ((await tableType(conn, LOG)) !== 'BASE TABLE') problems.push(`${LOG} is not a base table`);
  const col = (await columnsOf(conn, LOG)).find(c => c.name === 'sensitive_key');
  let column = 'absent';
  if (col) {
    const ok = col.type === 'tinyint(1)' && col.nullable === 'NO' && String(col.def) === '0';
    if (ok) column = 'present';
    else problems.push(`${LOG}.sensitive_key exists as ${col.type} nullable=${col.nullable} default=${JSON.stringify(col.def)} — expected tinyint(1) NOT NULL DEFAULT 0`);
  }

  // B — the view
  let view = 'absent';
  const vt = await tableType(conn, VIEW);
  if (vt === 'VIEW') {
    const got = (await columnsOf(conn, VIEW)).map(c => c.name);
    const [[v]] = await conn.query(
      `SELECT SECURITY_TYPE sec FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = ?`, [VIEW]);
    if (got.join(',') !== SPEND_COLUMNS.join(',')) problems.push(`${VIEW} exposes [${got.join(', ')}], expected [${SPEND_COLUMNS.join(', ')}]`);
    else if (!v || v.sec !== 'INVOKER') problems.push(`${VIEW} is SQL SECURITY ${v && v.sec}, expected INVOKER`);
    else view = 'present';
  } else if (vt) {
    problems.push(`${VIEW} exists as a ${vt}, not a view`);
  }

  return { column, view, problems };
}

/** The account may create the view? (SHOW GRANTS on this connection's own user.) */
async function canCreateView(conn) {
  const [rows] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
  const [[{ db }]] = await conn.query('SELECT DATABASE() db');
  const grants = rows.map(r => String(Object.values(r)[0]));
  const onThis = (g) => / ON \*\.\* /.test(g) || g.includes(` ON \`${db}\`.* `) || g.includes(` ON \`${db.replace(/_/g, '\\_')}\`.* `);
  return grants.some(g => onThis(g) && (/GRANT ALL PRIVILEGES/.test(g) || /\bCREATE VIEW\b/.test(g)));
}

async function run(conn, { apply, log = console.log }) {
  log(`accessSec3SensitiveTier — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);

  const st = await state(conn);
  if (st.problems.length) {
    log(`Unexpected live state:\n  ${st.problems.join('\n  ')}`);
    log('\nNO-GO — re-verify by hand; this script never alters what it did not create. Nothing was changed.');
    return { ok: false };
  }
  log(`${LOG}.sensitive_key: ${st.column}`);
  log(`${VIEW} view: ${st.view}`);

  if (st.column === 'present' && st.view === 'present') {
    log('\nGO — the migration is already applied; nothing to do. Next: land + deploy access SEC-3.');
    return { ok: true };
  }
  if (st.view === 'absent' && !(await canCreateView(conn))) {
    log('\nthis account lacks CREATE VIEW on the database (SHOW GRANTS FOR CURRENT_USER()).');
    log('NO-GO — run as an account that holds it. Nothing was changed.');
    return { ok: false };
  }
  if (!apply) {
    log('\nPlan:');
    if (st.column === 'absent') log(`  ${ALTER_SQL}`);
    if (st.view === 'absent') log(`  ${VIEW_SQL}`);
    log('\nGO — base state matches. Next: node scripts/accessSec3SensitiveTier.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  try {
    if (st.column === 'absent') { await conn.query(ALTER_SQL); log(`✓ ${LOG}.sensitive_key added`); }
    if (st.view === 'absent') { await conn.query(VIEW_SQL); log(`✓ ${VIEW} created`); }
  } catch (err) {
    log(`\n${err.message}`);
    log('NO-GO — whatever was reported done above stays done; re-run (CHECK, then --apply) to resume.');
    return { ok: false };
  }

  const after = await state(conn);
  const probs = [...after.problems];
  if (after.column !== 'present') probs.push(`${LOG}.sensitive_key is ${after.column}`);
  if (after.view !== 'present') probs.push(`${VIEW} is ${after.view}`);
  if (!probs.length) {
    // the view answers, and carries no content column
    const [, fields] = await conn.query(`SELECT * FROM \`${VIEW}\` LIMIT 1`);
    const names = fields.map(f => f.name);
    const leaked = names.filter(n => CONTENT_COLUMNS.includes(n));
    if (leaked.length) probs.push(`${VIEW} returns content column(s) ${leaked.join(', ')}`);
  }
  if (probs.length) {
    log(`Applied, but:\n  ${probs.join('\n  ')}`);
    log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  log('✓ both verified');
  log('\nGO — migration applied. Next: land + deploy access SEC-3 (then npm run db:ref).');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing further was changed; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, state, canCreateView, ALTER_SQL, VIEW_SQL, SPEND_COLUMNS };
