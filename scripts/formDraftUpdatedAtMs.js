#!/usr/bin/env node
// scripts/formDraftUpdatedAtMs.js
//
/**
 * form_submissions.updated_at → DATETIME(3). The applied SQL is recorded in
 * ref/migrations/2026-11-11_form_submissions_updated_at_ms.sql.
 *
 * WHY: POST /api/forms/draft takes a precondition (expected_draft_id +
 * expected_updated_at, services/formService.js upsertDraft) that refuses a
 * save when the draft row moved since the caller read it. At whole seconds two
 * saves inside one second leave the same updated_at, so a stale save passed
 * the check and silently replaced the newer draft (proven on MySQL 8.4,
 * 2026-11-11). At milliseconds — the draft writes stamp NOW(3) — it cannot.
 *
 * MUST RUN BEFORE the slice's code lands (SQL → backend). Existing values keep
 * their second and gain .000; created_at is untouched.
 *
 * USAGE (from a checkout of the COMMITTED sha, whose .env reaches production):
 *
 *   node scripts/formDraftUpdatedAtMs.js            # CHECK — read-only
 *   node scripts/formDraftUpdatedAtMs.js --apply    # run it
 *
 * Both end on ONE GO / NO-GO line. --apply is re-run safe: an already
 * migrated column is a GO with nothing written.
 *
 * WHY A NODE SCRIPT ON ONE CONNECTION: lock_wait_timeout must reach the ALTER.
 * Changing a column's type rebuilds the table under an exclusive metadata
 * lock; one queued behind a long transaction stalls every query on the table,
 * and the global default is a year. ~255 rows: the rebuild is sub-second.
 *
 * No backup step: the change only widens the precision (no value is lost or
 * rewritten beyond gaining .000), and Cloud SQL keeps 7 days of point-in-time
 * recovery. The CHECK refuses a table carrying a trigger (a trigger naming the
 * column is the landmine a type change can trip — CLAUDE.md "Dropping a
 * COLUMN").
 */
'use strict';

const path = require('path');

const COLUMN_COMMENT = 'DATETIME(3) since 2026-11-11: POST /api/forms/draft expected_updated_at compares it to the millisecond (at whole seconds two saves in one second were indistinguishable)';

// ONE string, shared with tests/formsDraftPrecondition.mysql.test.js (which
// applies it through run() on a scratch MySQL 8.4) and copied verbatim into
// the ref/migrations file (the twin asserts the copy).
const ALTER_SQL = `ALTER TABLE form_submissions
  MODIFY COLUMN updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    COMMENT '${COLUMN_COMMENT}'`;

async function columnState(conn) {
  const [[col]] = await conn.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
            EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_submissions' AND COLUMN_NAME = 'updated_at'`);
  return col || null;
}

/** 'pre' | 'done' — anything else throws, naming what it found. */
function classify(col) {
  if (!col) throw new Error('form_submissions.updated_at is missing — this is not the expected table');
  const shape = `${col.type}, nullable ${col.nullable}, default ${col.dflt}, extra "${col.extra}"`;
  if (col.nullable !== 'NO') throw new Error(`form_submissions.updated_at is nullable (${shape})`);
  if (col.type === 'datetime' && /^CURRENT_TIMESTAMP$/i.test(String(col.dflt))
      && /on update CURRENT_TIMESTAMP$/i.test(col.extra)) return 'pre';
  if (col.type === 'datetime(3)' && /^CURRENT_TIMESTAMP\(3\)$/i.test(String(col.dflt))
      && /on update CURRENT_TIMESTAMP\(3\)$/i.test(col.extra) && col.comment === COLUMN_COMMENT) return 'done';
  throw new Error(`form_submissions.updated_at is neither the pre-state nor the migrated state (${shape}, comment "${col.comment}")`);
}

async function run(conn, { apply, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  const before = await columnState(conn);
  const state = classify(before);
  const [triggers] = await conn.query(
    `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
      WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'form_submissions'`);
  if (triggers.length) throw new Error(`form_submissions carries trigger(s) ${triggers.map((t) => t.name).join(', ')} — read them before changing the column`);
  const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM form_submissions');

  log(`form_submissions: ${total} rows, no triggers`);
  log(`updated_at now: ${before.type}, default ${before.dflt}, extra "${before.extra}"`);
  log(state === 'done' ? 'Already migrated.' : `Planned:\n${ALTER_SQL};`);

  if (!apply) {
    log(state === 'done'
      ? '\nGO — CHECK passed, nothing left to do.'
      : '\nGO — CHECK passed, nothing written. Next: node scripts/formDraftUpdatedAtMs.js --apply');
    return { ok: true, state };
  }
  if (state === 'done') {
    log('\nGO — already migrated, nothing written.');
    return { ok: true, state };
  }

  await conn.query(ALTER_SQL);
  log('  ✓ ALTER ran');

  // End state, read fresh.
  const after = await columnState(conn);
  if (classify(after) !== 'done') throw new Error('the column did not reach the migrated state');
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM form_submissions');
  if (Number(n) < Number(total)) throw new Error(`row count fell from ${total} to ${n}`);
  log(`\nGO — updated_at is ${after.type}, default ${after.dflt}, extra "${after.extra}"; ${n} rows. Next: land the slice.`);
  return { ok: true, state: 'migrated' };
}

module.exports = { run, ALTER_SQL, COLUMN_COMMENT, columnState, classify };

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
      console.log(`\n${err.message}\n\nNO-GO — stopped. A ✓ above is what landed; rerun to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
      process.exit();
    }
  })();
}
