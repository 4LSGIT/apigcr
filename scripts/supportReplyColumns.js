#!/usr/bin/env node
// scripts/supportReplyColumns.js
//
/**
 * Support Inbox replies — five columns on issue_reports that record the reply
 * sent to whoever filed a Help & Support report (services/issueReportService.js
 * respond()). The applied SQL is recorded in
 * ref/migrations/2026-11-20_support_reply_columns.sql.
 *
 * MUST RUN BEFORE the code lands: GET /api/issue-reports selects these columns
 * by name, so the new code on the old table fails every Support Inbox load.
 *
 * USAGE (from a checkout of the COMMITTED sha, whose .env reaches production):
 *
 *   node scripts/supportReplyColumns.js            # CHECK — read-only
 *   node scripts/supportReplyColumns.js --apply    # run it
 *
 * Both end on ONE GO / NO-GO line. --apply reads the live state every time and
 * adds only the columns still missing, so a run that stopped half-way resumes.
 *
 * WHY A NODE SCRIPT ON ONE CONNECTION: lock_wait_timeout must reach the ALTER
 * (the global default is a year; a metadata lock queued behind a long
 * transaction stalls every query on the table). ALGORITHM=INSTANT makes a
 * refused plan fail instead of rebuilding the table.
 *
 * NO BACKUP: every column is NULLable with no default and nothing is
 * backfilled — no existing value is touched, so there is nothing to restore.
 * The end-state check proves the row count held and every new column is NULL.
 */
'use strict';

const path = require('path');

const COLUMNS = [
  { name: 'resolution', type: 'varchar(24)', after: 'resolved_by',
    comment: 'outcome key of the last reply that went out to the reporter (services/issueReportService.js OUTCOMES — app-validated per kind); NULL = never replied (a silent resolve leaves it NULL)' },
  { name: 'reply_message', type: 'text', after: 'resolution',
    comment: 'the personal note in the last reply that went out, plain text (escaped into the email); NULL = generic text only' },
  { name: 'replied_at', type: 'datetime', after: 'reply_message',
    comment: 'UTC — when the last reply to the reporter went out; written only after the send succeeds' },
  { name: 'reply_error', type: 'varchar(255)', after: 'replied_at',
    comment: 'why the last reply ATTEMPT failed; NULL once a reply goes out. A failure writes only this — an earlier reply record (resolution / replied_at) stands' },
  { name: 'reply_claimed_at', type: 'datetime', after: 'reply_error',
    comment: 'UTC — set while a reply send is in flight (respond() claim), NULL otherwise; blocks a second send; older than 15 min = abandoned and may be taken over' },
];

const sqlStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

function ddlFor(missing) {
  return `ALTER TABLE issue_reports\n  ${missing.map((c) =>
    `ADD COLUMN ${c.name} ${c.type} NULL DEFAULT NULL COMMENT ${sqlStr(c.comment)} AFTER ${c.after}`).join(',\n  ')},\n  ALGORITHM=INSTANT`;
}

async function columnsNow(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'issue_reports'`);
  return new Map(rows.map((r) => [r.name, r]));
}

function assertShape(c, got) {
  if (got.type !== c.type || got.nullable !== 'YES' || got.dflt != null || got.comment !== c.comment) {
    throw new Error(`issue_reports.${c.name} exists with the wrong shape (${got.type}, nullable ${got.nullable}, default ${got.dflt})`);
  }
}

async function run(conn, { apply, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  const live = await columnsNow(conn);
  for (const anchor of ['note', 'resolved_at', 'resolved_by', 'kind']) {
    if (!live.has(anchor)) throw new Error(`issue_reports.${anchor} is missing — this is not the expected table`);
  }
  const missing = [];
  for (const c of COLUMNS) {
    if (live.has(c.name)) assertShape(c, live.get(c.name));
    else missing.push(c);
  }
  const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM issue_reports');
  log(`issue_reports: ${total} rows`);
  for (const c of COLUMNS) log(`  ${c.name}: ${missing.includes(c) ? 'to add' : 'already there'}`);

  if (!missing.length) {
    log('\nGO — nothing left to do.');
    return { ok: true };
  }
  if (!apply) {
    log('\nGO — CHECK passed, nothing written. Next: node scripts/supportReplyColumns.js --apply');
    return { ok: true };
  }

  // AFTER needs its anchor to exist; a resumed run has the earlier ones.
  await conn.query(ddlFor(missing));
  log(`  ✓ added ${missing.map((c) => c.name).join(', ')}`);

  // End state, read fresh.
  const after = await columnsNow(conn);
  for (const c of COLUMNS) {
    if (!after.has(c.name)) throw new Error(`${c.name} did not land`);
    assertShape(c, after.get(c.name));
  }
  const [[end]] = await conn.query(
    `SELECT COUNT(*) AS total,
            SUM(resolution IS NOT NULL OR reply_message IS NOT NULL OR replied_at IS NOT NULL
                OR reply_error IS NOT NULL OR reply_claimed_at IS NOT NULL) AS filled
       FROM issue_reports`);
  if (Number(end.total) < Number(total)) throw new Error(`row count fell from ${total} to ${end.total}`);
  if (Number(end.filled)) throw new Error(`${end.filled} row(s) carry a reply value with no code writing it`);
  log('\nGO — columns live, every row NULL. Next: land the support-reply code.');
  return { ok: true };
}

module.exports = { run, COLUMNS, ddlFor };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const testUrl = process.env.YC_TEST_MYSQL_URL_SUPPORT;
      if (testUrl) {
        if (!/_test$/.test(new URL(testUrl).pathname)) throw new Error('YC_TEST_MYSQL_URL_SUPPORT must name a *_test database');
        conn = mysql.createConnection({ uri: testUrl, timezone: 'Z' }).promise();
      } else {
        const proxy = await ensureSqlProxy();
        if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
        for (const k of ['host', 'user', 'password', 'database']) {
          if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
        }
        conn = mysql.createConnection({
          host: process.env.host, user: process.env.user, password: process.env.password,
          database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
        }).promise();
      }
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — stopped. A ✓ above is what landed; rerun to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
      process.exit();
    }
  })();
}
