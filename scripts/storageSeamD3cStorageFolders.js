#!/usr/bin/env node
// scripts/storageSeamD3cStorageFolders.js
//
/**
 * storage-seam D3c-1 — seed the v3 folder-tree setting for 4LSG:
 *   app_settings.storage_folders = { case: <the live dropbox_case_folder_templates row>, contact: null }
 * Record: ref/migrations/2026-11-18_storage_seam_d3c_storage_folders.json. Design §6, §9 D3.
 *
 *   node scripts/storageSeamD3cStorageFolders.js            # CHECK (read-only)
 *   node scripts/storageSeamD3cStorageFolders.js --apply    # seed + verify
 *
 * WHY: caseService._loadCaseFolderTemplates reads storage_folders.case FIRST from
 * the D3c-1 deploy on, so the row must exist before that deploy (SQL → backend)
 * with EXACTLY the templates the firm runs on today — then nothing changes for
 * 4LSG (scripts/storageConfigDump.js shows the same `effective` templates before
 * and after). `contact: null` = the firm keeps no contact folders: the platform
 * default (lib/storageDefaults.js) is the nested contact → case tree, which 4LSG
 * must never inherit by accident (design §6, tenancy invariant 8).
 *
 * ONE connection (CLAUDE.md). CHECK asserts the base: the live
 * dropbox_case_folder_templates row parses and equals the frozen copy in
 * tests/fixtures/storageSeamD3c.templates.before.json (key order ignored — MySQL
 * JSON re-orders keys), and storage_folders is absent. --apply INSERTs the row
 * and reads it back; the read-back's case block must equal the live templates
 * row. A later run: the row exists and its case block equals the templates row →
 * ALREADY APPLIED; differs → NO-GO (someone edited one of the two by hand —
 * resolve by hand, this script never overwrites). Ends on ONE GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BEFORE = path.join(__dirname, '..', 'tests', 'fixtures', 'storageSeamD3c.templates.before.json');
const RECORD = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-18_storage_seam_d3c_storage_folders.json');
const KEY_NEW = 'storage_folders';
const KEY_OLD = 'dropbox_case_folder_templates';

const SQL = Object.freeze({
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  read: 'SELECT `key`, `value` FROM app_settings WHERE `key` IN (?, ?)',
  insert: 'INSERT INTO app_settings (`key`, `value`) VALUES (?, ?)',
});

/** JSON with every object's keys sorted — the key-order-insensitive compare (CLAUDE.md: MySQL JSON re-orders keys). */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function parseOrNull(s) {
  if (s == null || String(s).trim() === '') return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (_) { return null; }
}

/** The payload --apply writes, from the live templates row (the record file documents the shape). */
function payloadFor(templatesRow) {
  return { case: templatesRow, contact: null };
}

/** run(conn, { apply, log }) → { ok, applied, line } — the whole script, testable. */
async function run(conn, { apply = false, log = console.log } = {}) {
  const frozen = JSON.parse(fs.readFileSync(BEFORE, 'utf8'));
  const [rows] = await conn.query(SQL.read, [KEY_NEW, KEY_OLD]);
  const row = {};
  for (const r of rows || []) row[r.key] = r.value;
  const live = parseOrNull(row[KEY_OLD]);
  const existing = parseOrNull(row[KEY_NEW]);
  log(`base: ${KEY_OLD} ${live ? `parses (${Object.keys(live).join(', ')})` : 'MISSING or not a JSON object'}; ${KEY_NEW} ${row[KEY_NEW] == null ? 'absent' : existing ? 'present' : 'present but not a JSON object'}`);

  if (row[KEY_NEW] != null) {
    if (existing && live && canon(existing.case) === canon(live) && existing.contact === null) {
      const line = `ALREADY APPLIED — GO. ${KEY_NEW} holds { case: <the live ${KEY_OLD} row>, contact: null }. Next: land D3c-1.`;
      log(line); return { ok: true, applied: false, line };
    }
    const line = `NO-GO — ${KEY_NEW} exists but is not { case: <the live ${KEY_OLD} row>, contact: null } (${existing ? 'its case block differs or contact is not null' : 'not a JSON object'}). One of the two rows was edited by hand; resolve by hand — this script never overwrites. Nothing was changed.`;
    log(line); return { ok: false, applied: false, line };
  }
  if (!live) {
    const line = `NO-GO — ${KEY_OLD} is missing or not a JSON object; there is nothing to seed from. Nothing was changed.`;
    log(line); return { ok: false, applied: false, line };
  }
  if (canon(live) !== canon(frozen)) {
    const line = `NO-GO — the live ${KEY_OLD} row is not the frozen copy in tests/fixtures/storageSeamD3c.templates.before.json (the templates changed since the slice was cut). Re-freeze from the live row and re-run. Nothing was changed.`;
    log(line); return { ok: false, applied: false, line };
  }
  if (!apply) {
    const line = `CHECK OK — GO. ${KEY_NEW} will be seeded as { case: <the live ${KEY_OLD} row, ${Object.keys(live).length} stage(s)>, contact: null }. Next: node scripts/storageSeamD3cStorageFolders.js --apply`;
    log(line); return { ok: true, applied: false, line };
  }

  await conn.query(SQL.lockWait);
  const payload = payloadFor(live);
  await conn.query(SQL.insert, [KEY_NEW, JSON.stringify(payload)]);
  log(`  ✓ INSERT app_settings ${KEY_NEW}`);
  const [after] = await conn.query(SQL.read, [KEY_NEW, KEY_OLD]);
  const back = parseOrNull((after || []).find((r) => r.key === KEY_NEW)?.value);
  const liveAfter = parseOrNull((after || []).find((r) => r.key === KEY_OLD)?.value);
  if (!back || !liveAfter || canon(back.case) !== canon(liveAfter) || back.contact !== null) {
    const line = `NO-GO — after the INSERT the read-back of ${KEY_NEW} does not equal { case: <the live ${KEY_OLD} row>, contact: null }. Paste this output; do not deploy D3c-1.`;
    log(line); return { ok: false, applied: true, line };
  }
  const line = `APPLIED — GO. ${KEY_NEW} seeded and verified equal to { case: <the live ${KEY_OLD} row>, contact: null }. Next: land D3c-1 (the legacy row stays authoritative until D3c-3; this row is what keeps contact folders OFF for the firm when D3c-2 lands).`;
  log(line); return { ok: true, applied: true, line };
}

module.exports = { run, canon, payloadFor, parseOrNull, SQL, BEFORE, RECORD, KEY_NEW, KEY_OLD };

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
