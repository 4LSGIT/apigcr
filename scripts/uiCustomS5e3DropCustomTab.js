#!/usr/bin/env node
// scripts/uiCustomS5e3DropCustomTab.js
//
/**
 * ui-custom S5e-3 — drop users.user_custom_tab, the retired custom tab's
 * column. S5e-1 turned every custom tab into a launcher button and set the
 * column to the JSON null (applied 2026-10-16; prior values in
 * ref/migrations/2026-10-16_ui_custom_s5e_custom_tabs_to_buttons.json); S5e-2
 * removed every reader. The applied SQL and its ROLLBACK are in
 * ref/migrations/2026-10-17_ui_custom_s5e3_drop_user_custom_tab.sql.
 *
 * USAGE (repo root; .env reaches production, same setup as npm run db:ref):
 *   node scripts/uiCustomS5e3DropCustomTab.js            # CHECK — read-only
 *   node scripts/uiCustomS5e3DropCustomTab.js --apply    # drop the column
 *
 * WHEN: after the soak of S5e-2 (live since 2026-10-16), and only once the
 * backend this script landed with is LIVE. That commit took the column out of
 * routes/admin.users.js's INSERT — the last thing that named it; drop the
 * column under the old INSERT and creating a user fails (Unknown column).
 * The script checks it: the live build (GET /api/version `mtime`, the newest
 * file time in the deployed image — when Cloud Build checked the source out)
 * must be later than the commit that added this script. That proves a build
 * checked out after the commit was made, which is "deployed" unless the
 * commit sat unpushed while another build ran.
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). Before any
 * write, CHECK and --apply alike assert:
 *   - the column is exactly `json NOT NULL`, no default, no extra, no comment;
 *   - every row holds the JSON null scalar (JSON_TYPE 'NULL', never SQL
 *     NULL): there is nothing left to lose;
 *   - nothing else in the schema names it — no trigger, view, routine, event,
 *     generated column, CHECK constraint, index or foreign key (the
 *     customFieldsS5bDrop landmine: a trigger naming a dropped column lets the
 *     DROP succeed and then fails every UPDATE on the table);
 *   - this checkout's routes/admin.users.js no longer names it, and the live
 *     build is newer than this script's commit (above).
 * --apply then: SET SESSION lock_wait_timeout = 5 (the global default is a
 * year; a metadata lock queued behind a long transaction stalls every query
 * on the table), re-reads and re-asserts on that session, and runs
 *   ALTER TABLE `users` DROP COLUMN `user_custom_tab`, ALGORITHM=INSTANT
 * (metadata only on 8.4 — measured on 8.4.11 with users built from
 * ref/database.sql; if the server ever refused INSTANT it errors instead of
 * rebuilding the table). Verified after: the column is gone, the other
 * columns are exactly as before (definition and order), the row count is
 * unchanged, the sweep is clean, and in a ROLLED-BACK transaction a
 * `SELECT *` row comes back without it and a one-row UPDATE matches.
 * RE-RUNNABLE: with the column already gone, CHECK and --apply re-verify the
 * end state and change nothing. Ends on ONE GO / NO-GO line.
 */
'use strict';

const TABLE = 'users';
const COLUMN = 'user_custom_tab';
const EXPECT = { COLUMN_TYPE: 'json', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '' };
// the column's name as a whole identifier (word boundaries that respect `_` and `$`)
const NAMES_RE = /(^|[^A-Za-z0-9_$])user_custom_tab([^A-Za-z0-9_$]|$)/i;

const SQL = {
  who:      '/* s5e3:who */ SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v',
  columns:  '/* s5e3:columns */ SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, ' +
            'COLLATION_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ' +
            'ORDER BY ORDINAL_POSITION',
  values:   '/* s5e3:values */ SELECT COUNT(*) AS n, COALESCE(SUM(JSON_TYPE(`user_custom_tab`) = \'NULL\'), 0) AS jnull, ' +
            'COALESCE(SUM(`user_custom_tab` IS NULL), 0) AS sqlnull FROM `users`',
  rows:     '/* s5e3:rows */ SELECT COUNT(*) AS n FROM `users`',
  triggers: '/* s5e3:triggers */ SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_STATEMENT AS body ' +
            'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()',
  views:    '/* s5e3:views */ SELECT TABLE_NAME AS name, VIEW_DEFINITION AS body FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()',
  routines: '/* s5e3:routines */ SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS body FROM information_schema.ROUTINES ' +
            'WHERE ROUTINE_SCHEMA = DATABASE()',
  events:   '/* s5e3:events */ SELECT EVENT_NAME AS name, EVENT_DEFINITION AS body FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()',
  generated: '/* s5e3:generated */ SELECT CONCAT(TABLE_NAME, \'.\', COLUMN_NAME) AS name, GENERATION_EXPRESSION AS body ' +
            'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND GENERATION_EXPRESSION <> \'\'',
  checks:   '/* s5e3:checks */ SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS body FROM information_schema.CHECK_CONSTRAINTS ' +
            'WHERE CONSTRAINT_SCHEMA = DATABASE()',
  indexes:  '/* s5e3:indexes */ SELECT INDEX_NAME AS name FROM information_schema.STATISTICS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'users\' AND COLUMN_NAME = \'user_custom_tab\'',
  fks:      '/* s5e3:fks */ SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() ' +
            'AND ((TABLE_NAME = \'users\' AND COLUMN_NAME = \'user_custom_tab\') ' +
            'OR (REFERENCED_TABLE_NAME = \'users\' AND REFERENCED_COLUMN_NAME = \'user_custom_tab\'))',
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  drop:     'ALTER TABLE `users` DROP COLUMN `user_custom_tab`, ALGORITHM=INSTANT',
  smokeRow: '/* s5e3:smoke */ SELECT * FROM `users` ORDER BY `user` LIMIT 1',
  smokeUpd: '/* s5e3:smoke */ UPDATE `users` SET `user_name` = `user_name` WHERE `user` = ?',
};
const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS = 120_000;
// the sweep: [label, SQL key, whether every row is a hit (index / fk rows only exist when they name the column)]
const SWEEP = [
  ['trigger', 'triggers', false], ['view', 'views', false], ['routine', 'routines', false], ['event', 'events', false],
  ['generated column', 'generated', false], ['CHECK constraint', 'checks', false],
  ['index', 'indexes', true], ['foreign key', 'fks', true],
];

async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

/** The live state, read on `conn`. */
async function readState(conn) {
  const [who] = await q(conn, SQL.who);
  const columns = (await q(conn, SQL.columns, [TABLE])).map((c) => ({ ...c }));
  const column = columns.find((c) => c.COLUMN_NAME === COLUMN) || null;
  const [rows] = await q(conn, SQL.rows);
  let values = null;
  if (column) {
    const [v] = await q(conn, SQL.values);
    values = { n: Number(v.n), jnull: Number(v.jnull), sqlnull: Number(v.sqlnull) };
  }
  const refs = [];
  for (const [label, key, all] of SWEEP) {
    for (const r of await q(conn, SQL[key])) {
      if (all || NAMES_RE.test(String(r.body == null ? '' : r.body))) refs.push(`${label} ${r.name}${r.tbl ? ` (on ${r.tbl})` : ''}`);
    }
  }
  return { user: who.cu, db: who.db, version: who.v, columns, column, rows: Number(rows.n), values, refs };
}

/** The live state → { present, problems } (pure; the live-build check is run()'s). */
function plan(s) {
  const problems = [];
  if (s.column) {
    for (const k of Object.keys(EXPECT)) {
      if (s.column[k] !== EXPECT[k]) problems.push(`${TABLE}.${COLUMN} ${k} is ${JSON.stringify(s.column[k])}, expected ${JSON.stringify(EXPECT[k])}`);
    }
    const v = s.values || { n: NaN, jnull: NaN, sqlnull: NaN };
    if (!(v.n === s.rows && v.jnull === v.n && v.sqlnull === 0)) {
      problems.push(`not every row holds the JSON null: ${v.jnull} of ${v.n} do, ${v.sqlnull} are SQL NULL, ` +
        `${v.n - v.jnull - v.sqlnull} hold a value — someone wrote it after S5e-1; find out why before dropping`);
    }
  }
  for (const r of s.refs) problems.push(`the schema still names ${COLUMN}: ${r}`);
  return { present: !!s.column, problems };
}

/** A column's definition, for the before / after comparison (key-order-free). */
const defOf = (c) => JSON.stringify([c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA,
  c.CHARACTER_SET_NAME, c.COLLATION_NAME, c.COLUMN_COMMENT]);

/** The rolled-back smoke: SELECT * no longer carries the column; a one-row UPDATE matches. → problems. */
async function smoke(conn) {
  const out = [];
  await conn.beginTransaction();
  try {
    const rows = await q(conn, SQL.smokeRow);
    if (!rows.length) out.push('SELECT * FROM users returned no row');
    else {
      if (Object.prototype.hasOwnProperty.call(rows[0], COLUMN)) out.push(`SELECT * still returns ${COLUMN}`);
      const res = await q(conn, SQL.smokeUpd, [rows[0].user]);
      if (!res || res.affectedRows !== 1) out.push(`a one-row UPDATE matched ${res && res.affectedRows} rows`);
    }
  } finally {
    await conn.rollback();
  }
  return out;
}

/**
 * run(conn, { apply, log, live }) → { ok, state, line } — the whole script, testable.
 * live: async () => { ok, detail } — the deployed-backend check (the CLI's liveCheck).
 */
async function run(conn, { apply = false, log = console.log, live } = {}) {
  if (typeof live !== 'function') throw new Error('run(): a live-build check is required');
  log(`\n=== ui-custom S5e-3 — drop ${TABLE}.${COLUMN} — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);
  let s = await readState(conn);
  log(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}; ${s.rows} users, ${s.columns.length} columns`);
  log(s.column
    ? `${TABLE}.${COLUMN}: ${s.column.COLUMN_TYPE} ${s.column.IS_NULLABLE === 'NO' ? 'NOT NULL' : 'NULL'}; ` +
      `${s.values.jnull} of ${s.values.n} rows hold the JSON null`
    : `${TABLE}.${COLUMN}: already dropped`);
  let p = plan(s);

  if (!p.present) {
    p.problems.forEach((x) => log('  ✗ ' + x));
    const line = p.problems.length
      ? `NO-GO — the column is gone but ${p.problems.length} problem(s) above remain. Paste this output.`
      : 'ALREADY APPLIED — GO. Nothing to do; the pre-commit hook regenerates ref/database.sql on the next commit.';
    log('\n' + line);
    return { ok: !p.problems.length, state: p.problems.length ? 'dropped-dirty' : 'applied', line };
  }

  const L = await live();
  log(`live backend: ${L.detail}`);
  const problems = p.problems.concat(L.ok ? [] : ['the backend that stops naming the column is not confirmed live (above)']);
  if (problems.length) {
    problems.forEach((x) => log('  ✗ ' + x));
    const line = `NO-GO — ${problems.length} problem(s) above. Nothing was changed.`;
    log('\n' + line);
    return { ok: false, state: 'blocked', line };
  }
  log('  ✓ the column is exactly json NOT NULL, every row is the JSON null, nothing else names it, the new backend is live');
  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/uiCustomS5e3DropCustomTab.js --apply';
    log('\n' + line);
    return { ok: true, state: 'check', line };
  }

  await q(conn, SQL.lockWait);
  s = await readState(conn);          // re-read on the session that will ALTER
  p = plan(s);
  if (!p.present || p.problems.length) {
    p.problems.forEach((x) => log('  ✗ ' + x));
    const line = `NO-GO — the state changed between CHECK and apply${p.present ? '' : ' (the column is already gone)'}. ` +
      'Nothing was changed by this run; run it again.';
    log('\n' + line);
    return { ok: false, state: 'changed', line };
  }
  await q(conn, SQL.drop, [], DDL_TIMEOUT_MS);
  log(`  ✓ ${SQL.drop}`);

  const after = await readState(conn);
  const issues = [];
  if (after.column) issues.push(`${TABLE}.${COLUMN} is still there`);
  const want = s.columns.filter((c) => c.COLUMN_NAME !== COLUMN).map(defOf);
  const got = after.columns.map(defOf);
  if (JSON.stringify(want) !== JSON.stringify(got)) issues.push('the other columns do not read back exactly as before (definition or order)');
  if (after.rows !== s.rows) issues.push(`the row count went from ${s.rows} to ${after.rows}`);
  for (const r of after.refs) issues.push(`the schema still names ${COLUMN}: ${r}`);
  if (!issues.length) issues.push(...await smoke(conn));
  if (issues.length) {
    issues.forEach((x) => log('  ✗ ' + x));
    const line = 'NO-GO — the drop ran but the result does not verify. Paste this output; the rollback is in ' +
      'ref/migrations/2026-10-17_ui_custom_s5e3_drop_user_custom_tab.sql.';
    log('\n' + line);
    return { ok: false, state: 'verify-failed', line };
  }
  log(`  ✓ verified: ${after.columns.length} columns as before minus ${COLUMN}, ${after.rows} rows, sweep clean, ` +
    'SELECT * and a one-row UPDATE fine (rolled back)');
  const line = `APPLIED — GO. ${TABLE}.${COLUMN} is gone. Next: any commit regenerates ref/database.sql (pre-commit hook).`;
  log('\n' + line);
  return { ok: true, state: 'applied-now', line };
}

/**
 * The CLI's live-build check. root: the repo root; fetchImpl / gitTime injectable for tests.
 * → { ok, detail }. Every external call is time-limited.
 */
async function liveCheck({ root, url, fetchImpl = fetch, gitTime, readFile } = {}) {
  const fs = require('fs');
  const path = require('path');
  const read = readFile || ((rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  const route = read('routes/admin.users.js');
  if (NAMES_RE.test(route)) return { ok: false, detail: 'this checkout\'s routes/admin.users.js still names the column — run from an up-to-date main' };
  const committed = gitTime ? await gitTime() : (() => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--diff-filter=A', '--', 'scripts/uiCustomS5e3DropCustomTab.js'],
      { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
    return out ? Number(out) * 1000 : null;
  })();
  if (!committed) return { ok: false, detail: 'this script is not committed here — run it from a checkout of main' };
  let v;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, detail: `${url} answered ${res.status}` };
    v = await res.json();
  } catch (e) {
    return { ok: false, detail: `could not read ${url} (${e && e.name === 'TimeoutError' ? 'timed out after 10 s' : e && e.message})` };
  }
  const mtime = Number(v && v.mtime);
  const at = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  if (!(mtime > committed)) {
    return { ok: false, detail: `live build ${v && v.build} is from ${Number.isFinite(mtime) ? at(mtime) : '?'}, ` +
      `older than this script's commit (${at(committed)}) — deploy main first` };
  }
  return { ok: true, detail: `build ${v.build} from ${at(mtime)}, after this script's commit (${at(committed)})` };
}

module.exports = { run, plan, readState, liveCheck, smoke, SQL, EXPECT, NAMES_RE, SWEEP };

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  const root = path.join(__dirname, '..');
  const url = (process.env.APP_URL || 'https://app.4lsg.com').replace(/\/+$/, '') + '/api/version';
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
      const r = await run(conn, { apply, live: () => liveCheck({ root, url }) });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
