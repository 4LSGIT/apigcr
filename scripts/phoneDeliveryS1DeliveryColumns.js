#!/usr/bin/env node
// scripts/phoneDeliveryS1DeliveryColumns.js
//
/**
 * Phone-delivery S1 migration (ref/PHONE_DELIVERY_DESIGN.md §4): four
 * delivery columns + one index on phone_event_log. Runs BEFORE the S1
 * backend deploy (SQL → backend → frontend, the one-way door).
 *
 * USAGE (repo root; .env reaches production, same setup as npm run db:ref):
 *   node scripts/phoneDeliveryS1DeliveryColumns.js            # CHECK — read-only
 *   node scripts/phoneDeliveryS1DeliveryColumns.js --apply    # add columns + index
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). --apply:
 *   1. asserts the live table has NONE of the four columns and not the index
 *      (fresh), or ALL of them exactly as specified (already applied — GO,
 *      no-op). A partial state (some but not all) is NO-GO: a person looks.
 *   2. SET SESSION lock_wait_timeout = 5 (the global default is a year; a
 *      metadata lock queued behind a long transaction would stall every
 *      query on the table).
 *   3. ALTER … ADD COLUMN ×4, ALGORITHM=INSTANT (metadata-only; if the
 *      server ever refused INSTANT it errors instead of rebuilding), then
 *      ALTER … ADD INDEX, ALGORITHM=INPLACE, LOCK=NONE (an index build is
 *      never INSTANT; ~11k rows → sub-second).
 *   4. re-reads and verifies every column definition and the index.
 * RE-RUNNABLE: resumes from a run that died between the two ALTERs (columns
 * present + index absent is recognized and only the index is added).
 * Ends on ONE GO / NO-GO line.
 *
 * Dated record + rollback: ref/migrations/2026-10-21_phone_delivery_s1_delivery_columns.sql
 */
'use strict';

const TABLE = 'phone_event_log';
const INDEX = 'idx_phone_event_delivery';

// COLUMN_NAME → expected information_schema attributes after the ALTER.
const COLUMNS = {
  delivery_state: {
    COLUMN_TYPE: 'varchar(12)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
    CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci', EXTRA: '',
    COLUMN_COMMENT: 'outbound delivery, normalized by phoneDeliveryService: pending|sent|delivered|failed. NULL = incoming row, call, or never synced. Vocabulary: ref/PHONE_DELIVERY_DESIGN.md §3',
  },
  delivery_reason: {
    COLUMN_TYPE: 'varchar(16)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
    CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci', EXTRA: '',
    COLUMN_COMMENT: 'failure reason (delivery_state=failed): unreachable|opted_out|spam_content|sender_flagged|unknown',
  },
  delivery_code: {
    COLUMN_TYPE: 'varchar(32)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
    CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci', EXTRA: '',
    COLUMN_COMMENT: 'raw provider error code (e.g. SMS-CAR-411). Tooltip/forensics only — only the provider adapter may interpret it',
  },
  delivery_checked_at: {
    COLUMN_TYPE: 'datetime', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
    CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: '',
    COLUMN_COMMENT: 'last phone_outbound_sync stamp (UTC)',
  },
};
const COL_NAMES = Object.keys(COLUMNS);

const SQL = {
  readCols: 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, COLUMN_COMMENT ' +
            'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?)',
  readTable: 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  readIndex: 'SELECT COUNT(DISTINCT INDEX_NAME) AS n FROM information_schema.STATISTICS ' +
             'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
  readIndexCols: 'SELECT COLUMN_NAME FROM information_schema.STATISTICS ' +
                 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX',
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  addCols: 'ALTER TABLE `phone_event_log` ' +
    "ADD COLUMN `delivery_state` varchar(12) DEFAULT NULL COMMENT 'outbound delivery, normalized by phoneDeliveryService: pending|sent|delivered|failed. NULL = incoming row, call, or never synced. Vocabulary: ref/PHONE_DELIVERY_DESIGN.md §3', " +
    "ADD COLUMN `delivery_reason` varchar(16) DEFAULT NULL COMMENT 'failure reason (delivery_state=failed): unreachable|opted_out|spam_content|sender_flagged|unknown', " +
    "ADD COLUMN `delivery_code` varchar(32) DEFAULT NULL COMMENT 'raw provider error code (e.g. SMS-CAR-411). Tooltip/forensics only — only the provider adapter may interpret it', " +
    "ADD COLUMN `delivery_checked_at` datetime DEFAULT NULL COMMENT 'last phone_outbound_sync stamp (UTC)', " +
    'ALGORITHM=INSTANT',
  addIndex: 'ALTER TABLE `phone_event_log` ADD INDEX `idx_phone_event_delivery` (`delivery_state`, `processed_at`), ALGORITHM=INPLACE, LOCK=NONE',
};

/** Problems with the live columns' definitions; [] = all four exactly as expected. */
function definitionProblems(rows) {
  const byName = new Map((rows || []).map(r => [r.COLUMN_NAME, r]));
  const out = [];
  for (const name of COL_NAMES) {
    const col = byName.get(name);
    if (!col) { out.push(`${TABLE}.${name} not found`); continue; }
    for (const k of Object.keys(COLUMNS[name])) {
      if (col[k] !== COLUMNS[name][k]) {
        out.push(`${name}.${k} is ${JSON.stringify(col[k])}, expected ${JSON.stringify(COLUMNS[name][k])}`);
      }
    }
  }
  return out;
}

async function readState(conn) {
  const [[t]] = await conn.query(SQL.readTable, [TABLE]);
  const [cols] = await conn.query(SQL.readCols, [TABLE, COL_NAMES]);
  const [[idx]] = await conn.query(SQL.readIndex, [TABLE, INDEX]);
  return { tableExists: Number(t.n) > 0, cols, colCount: cols.length, indexExists: Number(idx.n) > 0 };
}

async function verifyApplied(conn, log) {
  const s = await readState(conn);
  const probs = definitionProblems(s.cols);
  if (!s.indexExists) probs.push(`index ${INDEX} not found`);
  else {
    const [ic] = await conn.query(SQL.readIndexCols, [TABLE, INDEX]);
    const got = ic.map(r => r.COLUMN_NAME).join(',');
    if (got !== 'delivery_state,processed_at') probs.push(`index ${INDEX} is (${got}), expected (delivery_state,processed_at)`);
  }
  probs.forEach(p => log('  ✗ ' + p));
  return probs.length === 0;
}

/** run(conn, { apply }) → { ok, state, line } — the whole script, testable. */
async function run(conn, { apply = false, log = console.log } = {}) {
  const s = await readState(conn);
  if (!s.tableExists) {
    const line = `NO-GO — ${TABLE} does not exist in this database. Nothing was changed.`;
    log(line); return { ok: false, state: 'no-table', line };
  }

  if (s.colCount === COL_NAMES.length && s.indexExists) {
    if (!(await verifyApplied(conn, log))) {
      const line = 'NO-GO — the columns/index exist but do not match this script (someone else\'s definitions). Nothing was changed.';
      log(line); return { ok: false, state: 'mismatch', line };
    }
    const line = 'ALREADY APPLIED — GO. Nothing to do; the pre-commit hook regenerates ref/database.sql on the next commit.';
    log(line); return { ok: true, state: 'applied', line };
  }

  if (s.colCount !== 0 && s.colCount !== COL_NAMES.length) {
    const line = `NO-GO — ${s.colCount} of ${COL_NAMES.length} delivery columns exist (partial state beyond the index). A person looks before anything runs. Nothing was changed.`;
    log(line); return { ok: false, state: 'partial', line };
  }

  const needCols = s.colCount === 0;
  const needIndex = !s.indexExists;
  if (needCols && !needIndex) {
    const line = `NO-GO — index ${INDEX} exists but the columns do not. A person looks. Nothing was changed.`;
    log(line); return { ok: false, state: 'index-without-columns', line };
  }
  if (!needCols) {
    const probs = definitionProblems(s.cols);
    if (probs.length) {
      probs.forEach(p => log('  ✗ ' + p));
      const line = 'NO-GO — the columns exist (a prior run died before the index?) but do not match. Nothing was changed.';
      log(line); return { ok: false, state: 'mismatch', line };
    }
    log('  ✓ columns present and exact — resuming at the index');
  }
  log(`  plan: ${needCols ? 'ADD 4 columns (INSTANT) → ' : ''}ADD INDEX ${INDEX} (INPLACE, LOCK=NONE)`);

  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/phoneDeliveryS1DeliveryColumns.js --apply';
    log(line); return { ok: true, state: 'check', line };
  }

  await conn.query(SQL.lockWait);
  if (needCols) {
    await conn.query(SQL.addCols);
    log('  ✓ ALTER … ADD COLUMN ×4 (ALGORITHM=INSTANT)');
  }
  await conn.query(SQL.addIndex);
  log(`  ✓ ALTER … ADD INDEX ${INDEX} (ALGORITHM=INPLACE, LOCK=NONE)`);

  if (!(await verifyApplied(conn, log))) {
    const line = 'NO-GO — the table does not read back as expected after the ALTERs. Paste this output.';
    log(line); return { ok: false, state: 'verify-failed', line };
  }
  log('  ✓ verified: four columns + index exactly as specified');
  const line = 'APPLIED — GO. Next: deploy the S1 backend, then any commit regenerates ref/database.sql (pre-commit hook).';
  log(line); return { ok: true, state: 'applied-now', line };
}

module.exports = { run, definitionProblems, readState, COLUMNS, COL_NAMES, TABLE, INDEX, SQL };

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
