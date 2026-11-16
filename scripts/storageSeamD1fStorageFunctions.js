#!/usr/bin/env node
// scripts/storageSeamD1fStorageFunctions.js
//
/**
 * storage-seam D1f-2 — MIGRATE the workflow definitions from the dropbox_*
 * automation functions to the storage_* ones (ref/DOCUMENTS_V3_DESIGN.md §9
 * D1f; spec local/2026-11-17_STORAGE_SEAM_D1f.md; ruling §10 e).
 *
 *   node scripts/storageSeamD1fStorageFunctions.js            # CHECK (read-only)
 *   node scripts/storageSeamD1fStorageFunctions.js --apply    # rewrite the rows
 *
 * The names live in DATA: workflow_steps.config carries `function_name` and
 * `params`. D1f-1 registered the storage_* names and left the dropbox_* names
 * as aliases, so this rewrite is safe to run while that deploy is live; D1f-3
 * deletes the aliases once it has run. SQL → backend order: this runs BEFORE
 * D1f-3 deploys, never after.
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). What it does:
 *   1. reads every workflow_steps row whose config mentions `dropbox_` or whose
 *      function is already a storage_* one (so a re-run still sees them) and
 *      counts the five other config-bearing columns (sequence_steps.action_config,
 *      trigger_rule_actions.config, scheduled_jobs.data, tools.html,
 *      workflow_versions.test_input) — they must carry NONE (verified 2026-11-17);
 *   2. asserts the BASE: every row still to migrate is one the fixture
 *      tests/fixtures/storageReplay.workflowSteps.json captured — same id, same
 *      function_name, same param KEYS (values differ by the fixture's
 *      sanitization, so keys are the comparison); a row this script does not
 *      know, or a fixture row that vanished, is NO-GO — refresh the fixture
 *      (and scenario 10) first, then come back;
 *   3. CHECK prints the plan and stops; --apply sets lock_wait_timeout = 5,
 *      rewrites each pending row in ONE transaction — function_name renamed,
 *      param KEYS renamed or dropped per MAPPING, every value and every other
 *      config key (set_vars, …) untouched — each UPDATE guarded by the old
 *      function_name and required to hit exactly one row, then COMMITs,
 *      re-reads every rewritten row and verifies it key-order-insensitively
 *      (MySQL re-orders JSON object keys on write — never compare strings);
 *   4. resumable: a row already carrying its storage_* name is reported as
 *      done and left alone, so a run that died mid-way is simply run again;
 *      when nothing is pending, CHECK and --apply both say ALREADY APPLIED.
 * Ends on ONE GO / NO-GO line.
 *
 * A dropbox_ mention that is NOT a function name (a get_setting step naming
 * the dropbox_unsorted_forms_path key) is listed as ignored: D2 renames those
 * settings with their registry entries.
 */

'use strict';

/** old function → new function, and the param keys it renames (null = dropped). */
const MAPPING = Object.freeze({
  dropbox_create_folder:      { to: 'storage_ensure_folder',      keys: { share_link: 'with_link', credential_id: null } },
  dropbox_get_shared_link:    { to: 'storage_human_link',         keys: { credential_id: null } },
  dropbox_list_folder:        { to: 'storage_list',               keys: { shared_link: 'human_link', credential_id: null } },
  dropbox_move:               { to: 'storage_move',               keys: { from_shared_link: 'from_human_link', credential_id: null } },
  dropbox_rename:             { to: 'storage_rename',             keys: { shared_link: 'human_link', credential_id: null } },
  dropbox_delete:             { to: 'storage_delete',             keys: { shared_link: 'human_link', credential_id: null } },
  dropbox_save_url:           { to: 'storage_import_url',         keys: { shared_link: 'human_link', credential_id: null } },
  dropbox_ensure_case_folder: { to: 'storage_ensure_case_folder', keys: {} },
});
const NEW_NAMES = Object.freeze(Object.values(MAPPING).map((m) => m.to));

/** The five other config-bearing columns; none may name a dropbox_* function. */
const OTHER_COLUMNS = Object.freeze([
  ['sequence_steps', 'action_config'],
  ['trigger_rule_actions', 'config'],
  ['scheduled_jobs', 'data'],
  ['tools', 'html'],
  ['workflow_versions', 'test_input'],
]);

const FIXTURE_PATH = '../tests/fixtures/storageReplay.workflowSteps.json';

const SQL = Object.freeze({
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  // the rows in EITHER shape: a dropbox_ mention (old names, and the setting-key
  // steps the plan ignores) OR a storage_* function name — a re-run after the
  // rewrite must still SEE the migrated rows, or it reads them as vanished
  rows: "SELECT id, workflow_id, version, step_number, type, config FROM workflow_steps WHERE config LIKE '%dropbox\\\\_%' OR JSON_UNQUOTE(JSON_EXTRACT(config, '$.function_name')) IN (?) ORDER BY id",
  other: (table, col) => `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` LIKE '%dropbox\\\\_%'`,
  update: "UPDATE workflow_steps SET config = CAST(? AS JSON) WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(config, '$.function_name')) = ?",
  reread: 'SELECT id, config FROM workflow_steps WHERE id IN (?) ORDER BY id',
});

function parseConfig(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (err) { return null; } }
  return v;
}

/** Canonical JSON: keys sorted at every level — MySQL re-orders object keys on write. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The migrated config for one row, or null when its function is not a dropbox_* one. */
function migrateConfig(cfg) {
  const m = cfg && MAPPING[cfg.function_name];
  if (!m) return null;
  const params = {};
  const renamed = [];
  const dropped = [];
  for (const [k, v] of Object.entries(cfg.params || {})) {
    if (k in m.keys) {
      if (m.keys[k] === null) { dropped.push(k); continue; }
      params[m.keys[k]] = v; renamed.push(`${k}→${m.keys[k]}`);
    } else {
      params[k] = v;
    }
  }
  return { next: { ...cfg, function_name: m.to, params }, renamed, dropped };
}

/** Sort the live rows into pending / done / ignored, and check them against the fixture. */
function plan(rows, fixture) {
  const pending = [];
  const done = [];
  const ignored = [];
  const drift = [];
  const byId = new Map(fixture.steps.map((s) => [Number(s.step_id), s]));
  for (const r of rows) {
    const cfg = parseConfig(r.config);
    if (!cfg) { drift.push(`row ${r.id}: config is not JSON`); continue; }
    const mig = migrateConfig(cfg);
    if (!mig) {
      (NEW_NAMES.includes(cfg.function_name) ? done : ignored).push({ id: r.id, workflow_id: r.workflow_id, function_name: cfg.function_name });
      continue;
    }
    const fx = byId.get(Number(r.id));
    if (!fx) { drift.push(`row ${r.id} (wf ${r.workflow_id}, ${cfg.function_name}) is not in the fixture`); continue; }
    if (fx.function_name !== cfg.function_name) { drift.push(`row ${r.id}: fixture says ${fx.function_name}, live says ${cfg.function_name}`); continue; }
    const liveKeys = Object.keys(cfg.params || {}).sort().join(',');
    const fxKeys = Object.keys(fx.params || {}).sort().join(',');
    if (liveKeys !== fxKeys) { drift.push(`row ${r.id}: param keys drifted — fixture [${fxKeys}], live [${liveKeys}]`); continue; }
    pending.push({ id: r.id, workflow_id: r.workflow_id, version: r.version, step_number: r.step_number, from: cfg.function_name, to: mig.next.function_name, next: mig.next, renamed: mig.renamed, dropped: mig.dropped });
  }
  // a fixture row that is neither pending nor done has vanished from the live table
  const seen = new Set([...pending, ...done].map((p) => Number(p.id)));
  for (const s of fixture.steps) {
    if (!seen.has(Number(s.step_id)) && MAPPING[s.function_name]) drift.push(`fixture step ${s.step_id} (${s.function_name}) is no longer a live row`);
  }
  return { pending, done, ignored, drift };
}

/** run(conn, { apply, log, fixture }) → { ok, applied, line } — the whole script, testable. */
async function run(conn, { apply = false, log = console.log, fixture = require(FIXTURE_PATH) } = {}) {
  const [rows] = await conn.query(SQL.rows, [NEW_NAMES]);
  const others = [];
  for (const [table, col] of OTHER_COLUMNS) {
    const [[{ n }]] = await conn.query(SQL.other(table, col));
    if (Number(n) > 0) others.push(`${table}.${col}: ${n}`);
  }
  const p = plan(rows, fixture);
  log(`workflow_steps rows mentioning dropbox_: ${rows.length} — pending ${p.pending.length}, already migrated ${p.done.length}, ignored (not a function name) ${p.ignored.length}`);
  for (const i of p.ignored) log(`  ignored: row ${i.id} (wf ${i.workflow_id}) ${i.function_name}`);
  if (others.length) {
    const line = `NO-GO — a dropbox_ mention sits outside workflow_steps (${others.join('; ')}); this script only knows workflow_steps. Nothing was changed.`;
    log(line); return { ok: false, applied: 0, line };
  }
  if (p.drift.length) {
    for (const d of p.drift) log(`  drift: ${d}`);
    const line = 'NO-GO — the live rows are not the base this script was written against (see drift above). Refresh tests/fixtures/storageReplay.workflowSteps.json and scenario 10, then run again. Nothing was changed.';
    log(line); return { ok: false, applied: 0, line };
  }
  if (!p.pending.length) {
    const line = `ALREADY APPLIED — GO. ${p.done.length} row(s) carry their storage_* name; nothing to do. Next: D1f-3 may land.`;
    log(line); return { ok: true, applied: 0, line };
  }
  for (const r of p.pending) {
    log(`  row ${r.id} (wf ${r.workflow_id} v${r.version} step ${r.step_number}): ${r.from} → ${r.to}` +
        (r.renamed.length ? ` | keys ${r.renamed.join(', ')}` : '') + (r.dropped.length ? ` | dropped ${r.dropped.join(', ')}` : ''));
  }
  if (!apply) {
    const line = `CHECK OK — GO. ${p.pending.length} row(s) to rewrite. Next: node scripts/storageSeamD1fStorageFunctions.js --apply`;
    log(line); return { ok: true, applied: 0, line };
  }

  await conn.query(SQL.lockWait);
  await conn.query('START TRANSACTION');
  try {
    for (const r of p.pending) {
      const [res] = await conn.query(SQL.update, [JSON.stringify(r.next), r.id, r.from]);
      if (!res || res.affectedRows !== 1) throw new Error(`row ${r.id}: the UPDATE matched ${res ? res.affectedRows : '?'} row(s) instead of 1 (did someone edit the step?)`);
      log(`  ✓ row ${r.id}: ${r.from} → ${r.to}`);
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    const line = `NO-GO — ${err.message}. Rolled back; nothing was changed. Run the CHECK and paste this output.`;
    log(line); return { ok: false, applied: 0, line };
  }

  const [back] = await conn.query(SQL.reread, [p.pending.map((r) => r.id)]);
  const got = new Map(back.map((b) => [Number(b.id), parseConfig(b.config)]));
  const bad = [];
  for (const r of p.pending) {
    const cfg = got.get(Number(r.id));
    if (!cfg || canonical(cfg) !== canonical(r.next)) bad.push(r.id);
  }
  if (bad.length) {
    const line = `NO-GO — row(s) ${bad.join(', ')} do not read back as written (committed). Paste this output; do not deploy D1f-3.`;
    log(line); return { ok: false, applied: p.pending.length, line };
  }
  const line = `APPLIED — GO. ${p.pending.length} row(s) rewritten and verified. Next: land D1f-3 (deletes the dropbox_* aliases).`;
  log(line); return { ok: true, applied: p.pending.length, line };
}

module.exports = { run, plan, migrateConfig, canonical, parseConfig, MAPPING, NEW_NAMES, OTHER_COLUMNS, SQL, FIXTURE_PATH };

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
