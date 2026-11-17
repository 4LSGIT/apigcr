#!/usr/bin/env node
// scripts/storageSeamD3aEntityFolders.js
//
/**
 * storage-seam D3a — EXPAND: create `entity_folders` and backfill it from the pair
 * it generalizes (cases.case_dropbox + case_folder_cache). Record and DDL:
 * ref/migrations/2026-11-17_storage_seam_d3a_entity_folders.sql. Design §3, §9 D3.
 *
 *   node scripts/storageSeamD3aEntityFolders.js            # CHECK (read-only)
 *   node scripts/storageSeamD3aEntityFolders.js --apply    # create + backfill + verify
 *
 * ONE connection (CLAUDE.md: a migration that needs a session): sets
 * lock_wait_timeout = 5 before any DDL. CHECK reads the base — how many cases
 * carry a link, how many cache rows exist, how many of each the union has — and
 * whether the table exists and already matches. --apply: CREATE TABLE IF NOT
 * EXISTS (the DDL is this script's copy of the record file, so the two cannot
 * drift: the twin compares them), then the backfill as ONE INSERT … SELECT with
 * ON DUPLICATE KEY UPDATE (idempotent: a second run re-syncs and changes
 * nothing), then VERIFY: the binding row count equals the union's, and a JOIN
 * finds zero source rows whose binding differs in any column. Resumable at every
 * step. Ends on ONE GO / NO-GO line.
 *
 * Runs BEFORE the D3a backend deploys (SQL → backend): until that deploy nothing
 * writes or reads the table; after it the writers dual-write it. Safe to re-run
 * at any time: it only brings the table back to the pair's current state.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RECORD = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-17_storage_seam_d3a_entity_folders.sql');

/** The CREATE TABLE statement, read from the record file (comments stripped) — one source of truth. */
function createTableSql() {
  const body = fs.readFileSync(RECORD, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const stmts = body.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  const create = stmts.find((s) => /^CREATE TABLE IF NOT EXISTS entity_folders/.test(s));
  if (!create) throw new Error('the record file has no CREATE TABLE statement');
  return create;
}

const SQL = Object.freeze({
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  exists: "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'entity_folders'",
  baseCounts: `SELECT
      (SELECT COUNT(*) FROM cases WHERE case_dropbox IS NOT NULL AND case_dropbox <> '') AS linked_cases,
      (SELECT COUNT(*) FROM case_folder_cache) AS cache_rows,
      (SELECT COUNT(*) FROM cases c LEFT JOIN case_folder_cache f ON f.case_id = c.case_id
        WHERE (c.case_dropbox IS NOT NULL AND c.case_dropbox <> '') OR f.case_id IS NOT NULL) AS union_rows`,
  bindingCount: "SELECT COUNT(*) AS n FROM entity_folders WHERE entity_kind = 'case' AND source = 'dropbox'",
  backfill: `INSERT INTO entity_folders
      (entity_kind, entity_id, source, external_id, path_lower, path_display, human_link,
       resolve_error, resolved_at, relink_dismissed_at, relink_dismissed_by)
    SELECT 'case', c.case_id, 'dropbox', f.folder_external_id, f.path_lower, f.path_display,
           NULLIF(TRIM(c.case_dropbox), ''), f.resolve_error, f.resolved_at,
           f.relink_dismissed_at, f.relink_dismissed_by
      FROM cases c LEFT JOIN case_folder_cache f ON f.case_id = c.case_id
     WHERE (c.case_dropbox IS NOT NULL AND c.case_dropbox <> '') OR f.case_id IS NOT NULL
    ON DUPLICATE KEY UPDATE
      external_id = VALUES(external_id), path_lower = VALUES(path_lower), path_display = VALUES(path_display),
      human_link = VALUES(human_link), resolve_error = VALUES(resolve_error), resolved_at = VALUES(resolved_at),
      relink_dismissed_at = VALUES(relink_dismissed_at), relink_dismissed_by = VALUES(relink_dismissed_by)`,
  // a source row whose binding row is missing or differs in any column
  mismatches: `SELECT COUNT(*) AS n
      FROM cases c LEFT JOIN case_folder_cache f ON f.case_id = c.case_id
      LEFT JOIN entity_folders e ON e.entity_kind = 'case' AND e.entity_id = c.case_id AND e.source = 'dropbox'
     WHERE ((c.case_dropbox IS NOT NULL AND c.case_dropbox <> '') OR f.case_id IS NOT NULL)
       AND (e.entity_id IS NULL
            OR NOT (e.external_id <=> f.folder_external_id)
            OR NOT (e.path_lower <=> f.path_lower)
            OR NOT (e.path_display <=> f.path_display)
            OR NOT (e.human_link <=> NULLIF(TRIM(c.case_dropbox), ''))
            OR NOT (e.resolve_error <=> f.resolve_error)
            OR NOT (e.resolved_at <=> f.resolved_at)
            OR NOT (e.relink_dismissed_at <=> f.relink_dismissed_at)
            OR NOT (e.relink_dismissed_by <=> f.relink_dismissed_by))`,
});

/** run(conn, { apply, log }) → { ok, created, backfilled, line } — the whole script, testable. */
async function run(conn, { apply = false, log = console.log } = {}) {
  const [[base]] = await conn.query(SQL.baseCounts);
  const [[{ n: existsN }]] = await conn.query(SQL.exists);
  const exists = Number(existsN) > 0;
  log(`base: ${base.linked_cases} cases with a link, ${base.cache_rows} cache rows, ${base.union_rows} bindings to hold; entity_folders ${exists ? 'EXISTS' : 'does not exist'}`);
  if (exists) {
    const [[{ n: have }]] = await conn.query(SQL.bindingCount);
    const [[{ n: bad }]] = await conn.query(SQL.mismatches);
    log(`entity_folders: ${have} case bindings, ${bad} source row(s) missing or differing`);
    if (Number(have) === Number(base.union_rows) && Number(bad) === 0) {
      const line = `ALREADY APPLIED — GO. entity_folders holds all ${have} bindings and every one matches its source. Next: land D3a (the writers dual-write from its deploy).`;
      log(line); return { ok: true, created: false, backfilled: 0, line };
    }
    if (!apply) {
      const line = `CHECK OK — GO. The table exists; ${bad} binding(s) to (re)sync. Next: node scripts/storageSeamD3aEntityFolders.js --apply`;
      log(line); return { ok: true, created: false, backfilled: 0, line };
    }
  } else if (!apply) {
    const line = `CHECK OK — GO. entity_folders will be created and ${base.union_rows} bindings backfilled. Next: node scripts/storageSeamD3aEntityFolders.js --apply`;
    log(line); return { ok: true, created: false, backfilled: 0, line };
  }

  await conn.query(SQL.lockWait);
  let created = false;
  if (!exists) {
    await conn.query(createTableSql());
    created = true;
    log('  ✓ CREATE TABLE entity_folders');
  }
  const [bf] = await conn.query(SQL.backfill);
  log(`  ✓ backfill: ${bf.affectedRows} row-write(s) reported (inserts count 1, updates 2, no-ops 0)`);
  const [[{ n: have }]] = await conn.query(SQL.bindingCount);
  const [[{ n: bad }]] = await conn.query(SQL.mismatches);
  if (Number(have) !== Number(base.union_rows) || Number(bad) !== 0) {
    const line = `NO-GO — after the backfill entity_folders holds ${have} case bindings (expected ${base.union_rows}) with ${bad} differing from the source. The table stays (nothing reads it yet); paste this output. Do not deploy D3a.`;
    log(line); return { ok: false, created, backfilled: Number(bf.affectedRows), line };
  }
  const line = `APPLIED — GO. ${created ? 'Table created; ' : ''}${have} bindings backfilled and verified equal to their source. Next: land D3a (the writers dual-write from its deploy).`;
  log(line); return { ok: true, created, backfilled: Number(bf.affectedRows), line };
}

module.exports = { run, createTableSql, SQL, RECORD };

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
