#!/usr/bin/env node
// scripts/yisramailT1Migrate.js
//
/**
 * YisraMail T1 — adds email_credentials.bulk_ok / events_driver / driver_config
 * (ref/YISRAMAIL_DESIGN.md §5.2). The column definitions, comments included,
 * are read from ref/migrations/2026-11-01_yisramail_t1_email_credentials_bulk.sql
 * so the file and the applied table can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailT1Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailT1Migrate.js --apply    # ALTER, then verify
 *   3. backend deploy
 *
 * CHECK (default), read-only:
 *   - email_credentials has exactly the pre-T1 columns, plus any of the three
 *     T1 columns already present WITH the expected definition (a re-run after
 *     a partial or complete apply). Anything else — a pre-T1 column missing,
 *     a column nobody expected, a T1 column with another type / nullability /
 *     default / collation / comment — is NO-GO; nothing is altered.
 *   - once bulk_ok exists, the §5.2 invariants on the DATA: a bulk_ok row is an
 *     smtp row, names a known events_driver (or none), shares its
 *     (smtp_host, smtp_user) with no other row, and no mailbox sends through
 *     it; and no row that is NOT bulk_ok carries an events_driver or
 *     driver_config. A violation is NO-GO, naming the rows.
 *   - prints any group of SMTP rows that share a login (informational: a row
 *     in such a group cannot be marked bulk in the editor).
 * --apply: one ALTER adding whichever T1 columns are missing (none → no
 *   ALTER), then VERIFIES columns, types, nullability, defaults, collation and
 *   comments, and re-runs the data checks. Re-runnable: resumes from wherever
 *   a failed run stopped.
 *
 * USAGE (repo root, .env reaching production — the `npm run db:ref` setup).
 * Each run ends with ONE line: GO or NO-GO, naming the next step. One
 * connection; session settings: time_zone +00:00, lock_wait_timeout 10 — an
 * ALTER queued behind a long transaction gives up in seconds (NO-GO, re-run
 * later) instead of stalling every query on the table.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-01_yisramail_t1_email_credentials_bulk.sql');
const TABLE = 'email_credentials';

/** The live columns before T1 (verified 2026-11-01), in order. */
const BASE_COLUMNS = Object.freeze([
  'id', 'email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure',
  'provider', 'credential_id', 'from_name', 'signature_html', 'signature_text', 'owner_user',
]);

/**
 * Columns a LATER slice adds to the table — tolerated when present (never
 * checked or touched here), so this CHECK and its twin keep passing once the
 * dump carries them: C2's transport hold (scripts/yisramailC2Migrate.js).
 */
const LATER_COLUMNS = Object.freeze(['held_at', 'held_reason']);

/** T1 columns: name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null]; comments come from the file. */
const EXPECTED_COLUMNS = Object.freeze({
  bulk_ok:       ['tinyint(1)', 'NO', '0', null],
  events_driver: ['varchar(20)', 'YES', null, 'utf8mb4_general_ci'],
  driver_config: ['json', 'YES', null, null],
});

/** emailService.VALID_EVENTS_DRIVERS, frozen here so the script loads no app code (a test pins the two equal). */
const KNOWN_DRIVERS = Object.freeze(['ses']);

const SQL = Object.freeze({
  table: `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  sharedLogins: `SELECT LOWER(smtp_host) AS host, LOWER(smtp_user) AS user, GROUP_CONCAT(id ORDER BY id) AS ids
                   FROM email_credentials
                  WHERE provider = 'smtp' AND smtp_host <> '' AND smtp_user <> ''
                  GROUP BY LOWER(smtp_host), LOWER(smtp_user)
                 HAVING COUNT(*) > 1`,
  bulkRows: `SELECT id, email, provider, smtp_host, smtp_user, events_driver FROM email_credentials WHERE bulk_ok <> 0 ORDER BY id`,
  driverOnPlain: `SELECT id, email FROM email_credentials
                   WHERE bulk_ok = 0 AND (events_driver IS NOT NULL OR driver_config IS NOT NULL) ORDER BY id`,
  boxesOn: `SELECT id, address FROM mailboxes WHERE send_credential_id = ?`,
});

/** The file's ADD COLUMN clauses: name → the clause text (one line each; COMMENTs hold ',' and ';'). */
function clauses() {
  const out = {};
  for (const line of fs.readFileSync(MIGRATION, 'utf8').split('\n')) {
    const m = /^\s*(ADD COLUMN (\w+) .*?)[,;]\s*$/.exec(line);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/** A clause's COMMENT literal, unescaped. */
function commentOf(clause) {
  const m = /COMMENT '((?:[^']|'')*)'$/.exec(clause);
  return m ? m[1].replace(/''/g, "'") : null;
}

function alterSql(names) {
  const c = clauses();
  return `ALTER TABLE ${TABLE}\n  ${names.map((n) => c[n]).join(',\n  ')}`;
}

/** → { missing: [names], problems: [lines] } for the table's columns. */
async function columnState(conn) {
  const [cols] = await conn.query(SQL.columns, [TABLE]);
  const have = new Map(cols.map((c) => [c.name, c]));
  const problems = [];
  for (const b of BASE_COLUMNS) if (!have.has(b)) problems.push(`pre-T1 column ${b} is missing`);
  for (const name of have.keys()) {
    if (!BASE_COLUMNS.includes(name) && !EXPECTED_COLUMNS[name] && !LATER_COLUMNS.includes(name)) problems.push(`unexpected column ${name}`);
  }
  const c = clauses();
  const missing = [];
  for (const [name, [type, nullable, dflt, coll]] of Object.entries(EXPECTED_COLUMNS)) {
    const col = have.get(name);
    if (!col) { missing.push(name); continue; }
    if (String(col.type).toLowerCase() !== type) problems.push(`${name} is ${col.type}, expected ${type}`);
    if (col.nullable !== nullable) problems.push(`${name} IS_NULLABLE ${col.nullable}, expected ${nullable}`);
    if ((col.dflt == null ? null : String(col.dflt)) !== dflt) problems.push(`${name} DEFAULT ${col.dflt}, expected ${dflt}`);
    if ((col.coll || null) !== coll) problems.push(`${name} collation ${col.coll || 'none'}, expected ${coll || 'none'}`);
    const want = commentOf(c[name] || '');
    if (col.comment !== want) problems.push(`${name} comment differs from the migration file`);
  }
  return { missing, problems };
}

/** Prints every group of SMTP rows sharing a login. → Map(row id → the group's ids). */
async function sharedLogins(conn, say) {
  const [shared] = await conn.query(SQL.sharedLogins);
  const sharedIds = new Map();
  for (const g of shared) {
    say(`  · SMTP rows ${g.ids} share one login (${g.host} / ${g.user}) — none of them can be marked bulk`);
    for (const id of String(g.ids).split(',')) sharedIds.set(Number(id), g.ids);
  }
  if (!shared.length) say('  · no two SMTP rows share a login');
  return sharedIds;
}

/** The §5.2 invariants on the rows, once bulk_ok exists. → [problem lines]. */
async function dataProblems(conn, say) {
  const problems = [];
  const sharedIds = await sharedLogins(conn, say);
  const [bulk] = await conn.query(SQL.bulkRows);
  for (const r of bulk) {
    if (r.provider !== 'smtp') problems.push(`bulk row ${r.id} (${r.email}) is provider ${r.provider} — bulk_ok is for smtp rows only`);
    if (r.events_driver != null && !KNOWN_DRIVERS.includes(r.events_driver)) problems.push(`bulk row ${r.id} names unknown events_driver "${r.events_driver}"`);
    if (sharedIds.has(Number(r.id))) problems.push(`bulk row ${r.id} (${r.email}) shares its SMTP login with rows ${sharedIds.get(Number(r.id))} — §5.2: no other row may`);
    const [boxes] = await conn.query(SQL.boxesOn, [r.id]);
    for (const b of boxes) problems.push(`mailbox ${b.id} (${b.address}) sends through bulk row ${r.id} — re-point it`);
  }
  const [plain] = await conn.query(SQL.driverOnPlain);
  for (const r of plain) problems.push(`row ${r.id} (${r.email}) carries an events_driver / driver_config but is not bulk_ok — a driver is for bulk rows only`);
  say(`  · bulk rows: ${bulk.length ? bulk.map((r) => `${r.id} ${r.email}${r.events_driver ? ` [${r.events_driver}]` : ''}`).join(', ') : 'none'}`);
  return problems;
}

/** CHECK (apply:false) or ALTER + verify (apply:true). → { ok, line, altered } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const c = clauses();
  const fileProblems = Object.keys(EXPECTED_COLUMNS).filter((n) => !c[n] || !commentOf(c[n]));
  if (fileProblems.length) {
    const line = `NO-GO — the migration file lacks a commented ADD COLUMN for ${fileProblems.join(', ')}. Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }
  const [[t]] = await conn.query(SQL.table, [TABLE]);
  if (!Number(t.n)) {
    const line = `NO-GO — table ${TABLE} does not exist in this database. Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }

  let state = await columnState(conn);
  say(`${TABLE}: T1 columns ${state.missing.length ? `missing: ${state.missing.join(', ')}` : 'all present'}`);
  if (state.problems.length) {
    state.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = `NO-GO — ${TABLE} is not in a state this script expects (above). Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }

  // The data checks read all three columns: only once none is missing.
  const checkData = async () => {
    if (state.missing.length) return [];
    return dataProblems(conn, say);
  };

  if (!apply) {
    const dp = await checkData();
    if (dp.length) {
      dp.forEach((p) => say(`  ✗ ${p}`));
      const line = 'NO-GO — the rows break §5.2 (above). Fix them in the sender editor first; nothing was changed.';
      say(line);
      return { ok: false, line, altered: false };
    }
    if (state.missing.length) await sharedLogins(conn, say); // columns not all there yet: the login groups, for information
    const line = state.missing.length
      ? 'CHECK OK — GO. Next: node scripts/yisramailT1Migrate.js --apply'
      : 'CHECK OK — the T1 columns are in place as expected. GO (nothing to apply; next: the backend deploy).';
    say(line);
    return { ok: true, line, altered: false };
  }

  let altered = false;
  if (state.missing.length) {
    try {
      await conn.query(alterSql(state.missing));
    } catch (err) {
      const line = `NO-GO — the ALTER failed: ${err.code || ''} ${err.message}. Nothing more was done; re-run --apply (it resumes).`;
      say(line);
      return { ok: false, line, altered: false };
    }
    altered = true;
    say(`  ✓ added ${state.missing.join(', ')}`);
  }
  state = await columnState(conn);
  const dp = state.problems.length || state.missing.length ? [] : await checkData();
  if (state.problems.length || state.missing.length || dp.length) {
    state.problems.forEach((p) => say(`  ✗ ${p}`));
    if (state.missing.length) say(`  ✗ still missing: ${state.missing.join(', ')}`);
    dp.forEach((p) => say(`  ✗ ${p}`));
    const line = `NO-GO — ${TABLE} does not verify (above). Paste this output to Claude; do not deploy.`;
    say(line);
    return { ok: false, line, altered };
  }
  say('  ✓ verified: types, nullability, defaults, collation and comments as in the migration file');
  const line = `${altered ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE} T1 columns verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, altered };
}

module.exports = { run, clauses, commentOf, alterSql, columnState, MIGRATION, TABLE, BASE_COLUMNS, LATER_COLUMNS, EXPECTED_COLUMNS, KNOWN_DRIVERS, SQL };

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
