#!/usr/bin/env node
// scripts/storageSeamD3d1CaseFolderLink.js
//
/**
 * storage-seam D3d-1 — MIGRATE the nine workflow steps that name the retiring
 * column `cases.case_dropbox` onto the neutral name `case_folder_link`
 * (Fred, 2026-11-17: "3. yes" — migrate, no permanent alias). Base frozen in
 * tests/fixtures/storageSeamD3d.steps.before.json; record
 * ref/migrations/2026-11-18_storage_seam_d3d1_case_folder_link.json.
 *
 *   node scripts/storageSeamD3d1CaseFolderLink.js            # CHECK (read-only)
 *   node scripts/storageSeamD3d1CaseFolderLink.js --apply    # rewrite + verify
 *
 * WHAT CHANGES (one token, 13 occurrences, every one the same meaning):
 *   - query_db `select` entries `cases.case_dropbox` → `cases.case_folder_link`
 *     (D3d-1's VIRTUAL column in lib/internal_functions/db.js: the binding's
 *     human_link, entity_folders, for the configured provider);
 *   - the set_vars key `case_dropbox` and its `{{this.output.case_dropbox}}`;
 *   - evaluate_condition `variable: "case_dropbox"`; storage_move
 *     `from_human_link: "{{case_dropbox}}"`; custom_code `c0.case_dropbox`.
 * EXPAND / MIGRATE / CONTRACT: the D3d-1 deploy serves BOTH names (the column
 * still exists; the virtual column is new) — this script runs AFTER that
 * deploy (a `cases.case_folder_link` select on the old code is a 500 in wf 28)
 * and before D3d-2 drops the column.
 *
 * ONE connection (CLAUDE.md). CHECK: every fixture row exists live and equals
 * the frozen config key-order-insensitively (pending), or already equals the
 * frozen config with the token renamed (done); anything else is DRIFT → NO-GO.
 * --apply: per pending row, UPDATE … WHERE id = ? AND config LIKE '%case_dropbox%'
 * (the guard: a row someone changed meanwhile is skipped and reported), then
 * every row re-read and compared to the expected text. Resumable; ALREADY
 * APPLIED when nothing is pending. Ends on ONE GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BEFORE = path.join(__dirname, '..', 'tests', 'fixtures', 'storageSeamD3d.steps.before.json');
const RECORD = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-18_storage_seam_d3d1_case_folder_link.json');
const OLD = 'case_dropbox';
const NEW = 'case_folder_link';

const SQL = Object.freeze({
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  rows: 'SELECT id, workflow_id, version, step_number, type, config FROM workflow_steps WHERE id IN (?) ORDER BY id',
  others: "SELECT COUNT(*) AS n FROM workflow_steps WHERE config LIKE '%case\\_dropbox%' AND id NOT IN (?)",
  update: "UPDATE workflow_steps SET config = CAST(? AS JSON) WHERE id = ? AND config LIKE '%case\\_dropbox%'",
});

function parseConfig(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** The renamed config: the token replaced wherever it appears, as a whole identifier (keys, placeholders, column refs, code). */
function migrateConfig(cfg) {
  const text = JSON.stringify(cfg);
  const next = text.replace(/\bcase_dropbox\b/g, NEW);
  return JSON.parse(next);
}

/** Sort the fixture rows against the live ones: pending / done / drift / missing. */
function plan(liveRows, fixture) {
  const live = new Map(liveRows.map((r) => [Number(r.id), r]));
  const pending = [], done = [], drift = [], missing = [];
  for (const f of fixture.rows) {
    const r = live.get(Number(f.id));
    if (!r) { missing.push(f.id); continue; }
    const cfg = parseConfig(r.config);
    if (!cfg) { drift.push(`row ${f.id}: config is not JSON`); continue; }
    const before = canonical(f.config);
    const after = canonical(migrateConfig(f.config));
    const now = canonical(cfg);
    if (now === before) pending.push({ id: f.id, workflow_id: f.workflow_id, version: f.version, step_number: f.step_number, next: migrateConfig(f.config) });
    else if (now === after) done.push({ id: f.id, workflow_id: f.workflow_id, version: f.version, step_number: f.step_number });
    else drift.push(`row ${f.id} (wf ${f.workflow_id} v${f.version} step ${f.step_number}): live config is neither the frozen base nor its migrated form`);
  }
  return { pending, done, drift, missing };
}

async function run(conn, { apply = false, log = console.log } = {}) {
  const fixture = JSON.parse(fs.readFileSync(BEFORE, 'utf8'));
  const ids = fixture.rows.map((r) => Number(r.id));
  const [liveRows] = await conn.query(SQL.rows, [ids]);
  const [[{ n: others }]] = await conn.query(SQL.others, [ids]);
  const p = plan(liveRows, fixture);
  log(`base: ${fixture.rows.length} frozen rows → ${p.pending.length} pending, ${p.done.length} done, ${p.drift.length} drift, ${p.missing.length} missing; ${others} other row(s) name ${OLD} outside the fixture`);
  if (p.drift.length || p.missing.length || Number(others) > 0) {
    const line = `NO-GO — ${[...p.drift, ...p.missing.map((id) => `row ${id} missing`), ...(Number(others) > 0 ? [`${others} row(s) outside the fixture name ${OLD} (re-freeze the fixture)`] : [])].join('; ')}. Nothing was changed.`;
    log(line); return { ok: false, migrated: 0, line, plan: p };
  }
  if (!p.pending.length) {
    const line = `ALREADY APPLIED — GO. All ${p.done.length} rows name ${NEW}; none names ${OLD}. Next: D3d-2 (retire the column).`;
    log(line); return { ok: true, migrated: 0, line, plan: p };
  }
  if (!apply) {
    const line = `CHECK OK — GO. ${p.pending.length} row(s) to rewrite (${p.pending.map((r) => `wf ${r.workflow_id} v${r.version} s${r.step_number}`).join(', ')}), ${p.done.length} already done. Next: node scripts/storageSeamD3d1CaseFolderLink.js --apply`;
    log(line); return { ok: true, migrated: 0, line, plan: p };
  }
  await conn.query(SQL.lockWait);
  let migrated = 0;
  const skipped = [];
  for (const r of p.pending) {
    const [res] = await conn.query(SQL.update, [JSON.stringify(r.next), r.id]);
    if (res.affectedRows === 1) { migrated++; log(`  ✓ row ${r.id} (wf ${r.workflow_id} v${r.version} step ${r.step_number})`); }
    else skipped.push(r.id);
  }
  const [after] = await conn.query(SQL.rows, [ids]);
  const p2 = plan(after, fixture);
  if (skipped.length || p2.pending.length || p2.drift.length || p2.done.length !== fixture.rows.length) {
    const line = `NO-GO — after the rewrite: ${p2.done.length}/${fixture.rows.length} rows in the migrated form, ${p2.pending.length} still pending, ${p2.drift.length} drift${skipped.length ? `, ${skipped.length} skipped by the guard (changed meanwhile: ${skipped.join(', ')})` : ''}. Re-run after reading the rows; nothing else was changed.`;
    log(line); return { ok: false, migrated, line, plan: p2 };
  }
  const line = `APPLIED — GO. ${migrated} row(s) rewritten, all ${fixture.rows.length} verified in the migrated form. Next: D3d-2 (retire the column).`;
  log(line); return { ok: true, migrated, line, plan: p2 };
}

module.exports = { run, plan, migrateConfig, canonical, parseConfig, SQL, BEFORE, RECORD, OLD, NEW };

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
