#!/usr/bin/env node
// scripts/mailboxIngestStateComment.js
//
/**
 * mailboxes.ingest_state COMMENT gains the poison-message keys the ingest
 * worker writes since the quarantine slice (2026-10-26): `poison`,
 * `quarantined`, `quarantined_total` — the COMMENT listed the cursor keys
 * only. MySQL caps a column COMMENT at 1024 characters and the old one was
 * already 968, so the new text names the keys and points at the service
 * header (POISON MESSAGES) for the full shapes. Doc-debt
 * 20261026_mailboxes_ingest_state_comment. This changes the COMMENT and
 * nothing else. Derived from scripts/commsSummariesSkipReasonComment.js.
 *
 * USAGE (repo root; .env reaches production, same setup as npm run db:ref):
 *   node scripts/mailboxIngestStateComment.js            # CHECK — read-only
 *   node scripts/mailboxIngestStateComment.js --apply    # change the comment
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). --apply:
 *   1. asserts the live column is exactly what this script expects (type,
 *      nullability, default, charset, collation, extra) — anything else is
 *      NO-GO and nothing is changed;
 *   2. SET SESSION lock_wait_timeout = 5 (the global default is a year; a
 *      metadata lock queued behind a long transaction would stall every
 *      query on the table — the ingest worker writes this row every tick);
 *   3. ALTER … MODIFY COLUMN with the SAME definition and the new COMMENT,
 *      ALGORITHM=INSTANT — a comment change is metadata-only; if the server
 *      ever refused INSTANT it errors instead of rebuilding the table;
 *   4. re-reads and verifies every attribute plus the new comment.
 * RE-RUNNABLE: when the comment is already the new text, CHECK and --apply
 * both report ALREADY APPLIED and change nothing. Ends on ONE GO / NO-GO line.
 */
'use strict';

const TABLE = 'mailboxes';
const COLUMN = 'ingest_state';
const OLD_COMMENT = "per-folder CURSOR, written only by the ingest worker (services/mailbox/mailboxIngestService.js): {\"<folder>\": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_floor_uid = re-key of a backfill:false folder stores only above this, backfill_emit_after = ISO emit horizon set by a re-key (null = store-only), backfill_skipped_below / backfill_skipped_at = backfill:false baseline, checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at, no_provider_id_total / last_no_provider_id_at / last_no_provider_id_uid = provider-keyed mail stored but not emitted, drafts_skipped_total = Draft-flagged messages passed over (never stored)}}. First poll baselines at UIDNEXT: existing mail is stored (or skipped), never emitted. UIDVALIDITY change = re-key, never blanket purge (§4.1). A folder dropped from ingest_folders keeps its key here as a breadcrumb. NULL = never ingested";
const NEW_COMMENT = "per-folder CURSOR, written only by services/mailbox/mailboxIngestService.js (its header is the contract): {\"<folder>\": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_floor_uid = re-keyed backfill:false folder stores only above it, backfill_emit_after = ISO emit horizon from a re-key (null = store-only), backfill_skipped_below / _at = backfill:false baseline, checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at, no_provider_id_total / last_no_provider_id_at / _uid = stored, not emitted, drafts_skipped_total = Drafts never stored, poison = {uid, attempts, ..., held?} UID the new pass keeps failing on, quarantined = [...] last 20 UIDs skipped for good, quarantined_total (POISON MESSAGES)}}. First poll baselines at UIDNEXT: existing mail stored (or skipped), never emitted. UIDVALIDITY change = re-key, never blanket purge. A folder dropped from ingest_folders keeps its key. NULL = never ingested";
const EXPECT = {
  COLUMN_TYPE: 'json', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
  CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: '',
};
const SQL = {
  read: 'SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, COLUMN_COMMENT ' +
        'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  alter: 'ALTER TABLE `mailboxes` MODIFY COLUMN `ingest_state` json DEFAULT NULL COMMENT ?, ALGORITHM=INSTANT',
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

/** run(conn, { apply }) → { ok, state, line } — the whole script, testable. */
async function run(conn, { apply = false, log = console.log } = {}) {
  const col = await readColumn(conn);
  const probs = definitionProblems(col);
  if (probs.length) {
    probs.forEach((p) => log('  ✗ ' + p));
    const line = `NO-GO — ${TABLE}.${COLUMN} is not the column this script expects. Nothing was changed.`;
    log(line); return { ok: false, state: 'unexpected', line };
  }
  log(`  ✓ ${TABLE}.${COLUMN}: ${col.COLUMN_TYPE} NULL`);
  log(`  current comment: ${JSON.stringify(col.COLUMN_COMMENT)}`);
  if (col.COLUMN_COMMENT === NEW_COMMENT) {
    const line = 'ALREADY APPLIED — GO. Nothing to do; the pre-commit hook regenerates ref/database.sql on the next commit.';
    log(line); return { ok: true, state: 'applied', line };
  }
  if (col.COLUMN_COMMENT !== OLD_COMMENT) {
    const line = 'NO-GO — the current comment is neither the old nor the new text (someone changed it). Nothing was changed.';
    log(line); return { ok: false, state: 'unknown-comment', line };
  }
  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/mailboxIngestStateComment.js --apply';
    log(line); return { ok: true, state: 'check', line };
  }
  await conn.query(SQL.lockWait);
  await conn.query(SQL.alter, [NEW_COMMENT]);
  log('  ✓ ALTER … COMMENT (ALGORITHM=INSTANT)');
  const after = await readColumn(conn);
  const after_ = definitionProblems(after);
  if (after_.length || !after || after.COLUMN_COMMENT !== NEW_COMMENT) {
    after_.forEach((p) => log('  ✗ ' + p));
    if (after && after.COLUMN_COMMENT !== NEW_COMMENT) log(`  ✗ comment reads ${JSON.stringify(after.COLUMN_COMMENT)}`);
    const line = 'NO-GO — the column does not read back as expected after the ALTER. Paste this output.';
    log(line); return { ok: false, state: 'verify-failed', line };
  }
  log(`  ✓ verified: definition unchanged, comment ${JSON.stringify(after.COLUMN_COMMENT)}`);
  const line = 'APPLIED — GO. Next: any commit regenerates ref/database.sql (pre-commit hook).';
  log(line); return { ok: true, state: 'applied-now', line };
}

module.exports = { run, definitionProblems, OLD_COMMENT, NEW_COMMENT, EXPECT, SQL };

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
