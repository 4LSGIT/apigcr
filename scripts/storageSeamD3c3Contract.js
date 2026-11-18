#!/usr/bin/env node
// scripts/storageSeamD3c3Contract.js
//
/**
 * storage-seam D3c-3 — CONTRACT: the folder templates move from the legacy key
 * dropbox_case_folder_templates into storage_folders.case for good, and the legacy
 * row is deleted. Record: ref/migrations/2026-11-18_storage_seam_d3c3_contract.sql.
 *
 *   node scripts/storageSeamD3c3Contract.js            # CHECK (read-only)
 *   node scripts/storageSeamD3c3Contract.js --apply    # re-copy + verify + delete
 *
 * ONE connection (CLAUDE.md). CHECK asserts the base: storage_folders exists and is
 * a JSON object with `contact: null` (4LSG's D3c-1 seed — this script is for the
 * firm whose contact folders are off; a tree with contact folders on is refused,
 * resolve by hand), and the legacy row parses to a stage map. --apply writes
 * storage_folders = { ...tree, case: <the legacy row NOW> } (so an edit made after
 * D3c-1's seed is kept — the editor wrote the legacy key until this deploy), reads
 * it back, verifies the case block equals the legacy row key-order-insensitively
 * and contact is still null, then DELETEs the legacy row and verifies it is gone.
 * Resumable: re-copied but not deleted → the next run deletes; both done →
 * ALREADY APPLIED. Ends on ONE GO / NO-GO line.
 */

'use strict';

const path = require('path');

const RECORD = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-18_storage_seam_d3c3_contract.sql');
const KEY_NEW = 'storage_folders';
const KEY_OLD = 'dropbox_case_folder_templates';

const SQL = Object.freeze({
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  read: 'SELECT `key`, `value` FROM app_settings WHERE `key` IN (?, ?)',
  update: 'UPDATE app_settings SET `value` = ? WHERE `key` = ?',
  del: 'DELETE FROM app_settings WHERE `key` = ?',
});

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function parseOrNull(s) {
  if (s == null || String(s).trim() === '') return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (_) { return null; }
}
function isStageMap(m) {
  return !!m && Object.keys(m).length > 0 && Object.values(m).every((st) => st && typeof st === 'object' && !Array.isArray(st) && typeof st.default === 'string');
}

async function readBoth(conn) {
  const [rows] = await conn.query(SQL.read, [KEY_NEW, KEY_OLD]);
  const row = {};
  for (const r of rows || []) row[r.key] = r.value;
  return row;
}

/** run(conn, { apply, log }) → { ok, copied, deleted, line } */
async function run(conn, { apply = false, log = console.log } = {}) {
  const row = await readBoth(conn);
  const tree = parseOrNull(row[KEY_NEW]);
  const legacy = parseOrNull(row[KEY_OLD]);
  const legacyPresent = row[KEY_OLD] != null;
  log(`base: ${KEY_NEW} ${row[KEY_NEW] == null ? 'absent' : tree ? `present (case: ${tree.case ? 'yes' : 'no'}, contact: ${JSON.stringify(tree.contact === undefined ? 'absent' : tree.contact)})` : 'present but not a JSON object'}; ${KEY_OLD} ${legacyPresent ? (legacy && isStageMap(legacy) ? `present (${Object.keys(legacy).join(', ')})` : 'present but not a stage map') : 'absent'}`);

  if (!tree) {
    const line = `NO-GO — ${KEY_NEW} is ${row[KEY_NEW] == null ? 'absent (run scripts/storageSeamD3cStorageFolders.js first)' : 'not a JSON object'}. Nothing was changed.`;
    log(line); return { ok: false, copied: false, deleted: false, line };
  }
  if (tree.contact !== null) {
    const line = `NO-GO — ${KEY_NEW}.contact is ${tree.contact === undefined ? 'absent' : 'not null'}: this script is for the firm whose contact folders are off (the D3c-1 seed). Resolve by hand. Nothing was changed.`;
    log(line); return { ok: false, copied: false, deleted: false, line };
  }
  if (!legacyPresent) {
    if (tree.case && isStageMap(tree.case)) {
      const line = `ALREADY APPLIED — GO. ${KEY_OLD} is gone and ${KEY_NEW}.case holds the templates (${Object.keys(tree.case).join(', ')}). Next: land D3c-3.`;
      log(line); return { ok: true, copied: false, deleted: false, line };
    }
    const line = `NO-GO — ${KEY_OLD} is gone but ${KEY_NEW}.case is not a stage map; the firm would run on the code default. Restore the templates by hand. Nothing was changed.`;
    log(line); return { ok: false, copied: false, deleted: false, line };
  }
  if (!legacy || !isStageMap(legacy)) {
    const line = `NO-GO — ${KEY_OLD} is present but not a stage map ({ <stage>: { default, … } }); nothing to copy. Resolve by hand. Nothing was changed.`;
    log(line); return { ok: false, copied: false, deleted: false, line };
  }
  const same = tree.case && canon(tree.case) === canon(legacy);
  if (!apply) {
    const line = `CHECK OK — GO. ${KEY_NEW}.case ${same ? 'already equals' : 'will be re-copied from'} the live ${KEY_OLD} row (${Object.keys(legacy).join(', ')}); then the legacy row is deleted. Next: node scripts/storageSeamD3c3Contract.js --apply`;
    log(line); return { ok: true, copied: false, deleted: false, line };
  }

  await conn.query(SQL.lockWait);
  let copied = false;
  if (!same) {
    const next = { ...tree, case: legacy };
    await conn.query(SQL.update, [JSON.stringify(next), KEY_NEW]);
    copied = true;
    log(`  ✓ UPDATE app_settings ${KEY_NEW} (case ← the live ${KEY_OLD} row)`);
  }
  const after = await readBoth(conn);
  const treeAfter = parseOrNull(after[KEY_NEW]);
  const legacyAfter = parseOrNull(after[KEY_OLD]);
  if (!treeAfter || !legacyAfter || canon(treeAfter.case) !== canon(legacyAfter) || treeAfter.contact !== null) {
    const line = `NO-GO — after the copy ${KEY_NEW}.case does not equal the live ${KEY_OLD} row (or contact moved). The legacy row was NOT deleted; paste this output. Do not deploy D3c-3.`;
    log(line); return { ok: false, copied, deleted: false, line };
  }
  await conn.query(SQL.del, [KEY_OLD]);
  log(`  ✓ DELETE app_settings ${KEY_OLD}`);
  const final = await readBoth(conn);
  if (final[KEY_OLD] != null) {
    const line = `NO-GO — ${KEY_OLD} is still present after the DELETE. Paste this output.`;
    log(line); return { ok: false, copied, deleted: false, line };
  }
  const line = `APPLIED — GO. ${KEY_NEW}.case ${copied ? 're-copied from' : 'already equalled'} the legacy row, verified, and ${KEY_OLD} deleted. Next: land D3c-3 (the editor writes ${KEY_NEW} from that deploy).`;
  log(line); return { ok: true, copied, deleted: true, line };
}

module.exports = { run, canon, parseOrNull, isStageMap, SQL, RECORD, KEY_NEW, KEY_OLD };

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
