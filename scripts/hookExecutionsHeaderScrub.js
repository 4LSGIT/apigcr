#!/usr/bin/env node
// scripts/hookExecutionsHeaderScrub.js
//
/**
 * Remove hook CREDENTIAL HEADERS from stored YisraHook history (2026-11-02).
 * The receiver dropped only x-api-key / authorization / cookie, so the api_key
 * auth's default x-hook-key (clio-command, code-step-test-hook, test-auth),
 * RingCentral's Verification-Token (rc-call / rc-message-out / rc-message-in,
 * ~32.8k rows) and hmac signature headers were stored. routes/api.hooks.js +
 * services/hookService.js now drop every name lib/hookCredentialHeaders
 * gives (the statics, the hook's own header, the union of every hook's
 * configured header); this applies the SAME functions (never a copy), with
 * that union for EVERY row, to every place a hook's input was copied:
 *   hook_executions.raw_input, hook_executions.transform_output (a
 *   passthrough transform copies the headers), hook_delivery_logs.request_body
 *   (a target given the whole object), hooks.captured_sample,
 *   workflow_executions.init_data + .variables (a workflow target's initData),
 *   workflows.captured_input + .test_input (captureWorkflowInput /
 *   captureRefusedStart), sequence_enrollments.trigger_data (a sequence target).
 * Sinks found clean and not scanned (live probe 2026-11-02): workflow
 * step logs, sequence step logs, scheduled_jobs, system_alerts,
 * hook_delivery_logs.response_body. An http target already SENT what it was
 * given to its URL — no scrub reaches that.
 * Only keys INSIDE an object stored under a `headers` key are removed, by
 * JSON_REMOVE on the stored document — nothing else in it is re-serialized.
 * Key case is whatever was stored (the receiver stores Node's lowercase names;
 * a pasted live-test input can carry any case): every case is matched.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: land + deploy the receiver fix FIRST, then run this. Run   │
 * │ first, the old code keeps writing tokens behind it.                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — the npm run db:ref setup):
 *   node scripts/hookExecutionsHeaderScrub.js            # CHECK — read-only counts per hook / column / name
 *   node scripts/hookExecutionsHeaderScrub.js --apply    # remove, batched, then verify the count is 0
 *
 * ONE connection; session time_zone +00:00, innodb_lock_wait_timeout 10 (a
 * row a live writer holds fails its batch in seconds — NO-GO, re-run resumes
 * — instead of waiting the 50 s default) and lock_wait_timeout 10 (metadata
 * locks; nothing here takes one beyond plain DML). Batches of BATCH rows by
 * id; each batch's rewrite is one UPDATE per column (atomic, PK record locks
 * only — the live receiver's INSERTs at the tail are not blocked), re-read and
 * verified. RE-RUNNABLE: a clean row is skipped, so a second run rewrites
 * nothing. One GO / NO-GO line at the end.
 */

'use strict';

const { credentialHeaderNames, credentialHeaderPaths, addHeaderNames, UNION_SQL } = require('../lib/hookCredentialHeaders');

const BATCH = 1000;

/** Printed above the workflow_executions.variables counts (CHECK and APPLY). */
const VARIABLES_CAUTION = 'workflow_executions.variables: a hit on a RUNNING execution that did not come from a hook belongs to a live run (its own variables named `headers`) — read those rows before --apply.';

/** What is scrubbed: table, its JSON columns, and how a row finds its hook id. */
const TARGETS = Object.freeze([
  { table: 'hook_executions', columns: ['raw_input', 'transform_output'],
    select: (cols) => `SELECT e.id, e.hook_id AS hid, ${cols.map((c) => `e.${c}`).join(', ')} FROM hook_executions e WHERE e.id > ? ORDER BY e.id LIMIT ?` },
  { table: 'hook_delivery_logs', columns: ['request_body'],
    select: (cols) => `SELECT d.id, e.hook_id AS hid, ${cols.map((c) => `d.${c}`).join(', ')} FROM hook_delivery_logs d LEFT JOIN hook_executions e ON e.id = d.execution_id WHERE d.id > ? ORDER BY d.id LIMIT ?` },
  { table: 'hooks', columns: ['captured_sample'],
    select: (cols) => `SELECT h.id, h.id AS hid, ${cols.map((c) => `h.${c}`).join(', ')} FROM hooks h WHERE h.id > ? ORDER BY h.id LIMIT ?` },
  // Copies of a target's input — no hook id on the row: the union names apply.
  { table: 'workflow_executions', columns: ['init_data', 'variables'],
    select: (cols) => `SELECT w.id, NULL AS hid, ${cols.map((c) => `w.${c}`).join(', ')} FROM workflow_executions w WHERE w.id > ? ORDER BY w.id LIMIT ?` },
  { table: 'workflows', columns: ['captured_input', 'test_input'],
    select: (cols) => `SELECT f.id, NULL AS hid, ${cols.map((c) => `f.${c}`).join(', ')} FROM workflows f WHERE f.id > ? ORDER BY f.id LIMIT ?` },
  { table: 'sequence_enrollments', columns: ['trigger_data'],
    select: (cols) => `SELECT e.id, NULL AS hid, ${cols.map((c) => `e.${c}`).join(', ')} FROM sequence_enrollments e WHERE e.id > ? ORDER BY e.id LIMIT ?` },
]);

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;                 // mysql2 parses JSON columns
  try { return JSON.parse(v); } catch (_) { return null; }
};

async function loadHooks(conn) {
  const [rows] = await conn.query('SELECT id, slug, auth_config FROM hooks');
  const [u] = await conn.query(UNION_SQL);
  const map = new Map(rows.map((h) => [Number(h.id), h]));
  map.union = addHeaderNames(new Set(), u);   // every hook's configured header — the receiver's union
  return map;
}

/** One batch of one target → { last, scanned, todo: [{id, col, paths, slug}] }. */
async function pending(conn, target, hooks, fromId) {
  const [rows] = await conn.query(target.select(target.columns), [fromId, BATCH]);
  const todo = [];
  for (const r of rows) {
    const hook = r.hid == null ? null : (hooks.get(Number(r.hid)) || null);   // no / a deleted hook: the statics + the union
    const names = credentialHeaderNames(hook, hooks.union);
    for (const col of target.columns) {
      const doc = parse(r[col]);
      if (!doc || typeof doc !== 'object') continue;
      const paths = credentialHeaderPaths(doc, names);
      if (paths.length) todo.push({ id: r.id, col, paths, slug: hook ? hook.slug : (r.hid == null ? `(${target.table})` : `(hook ${r.hid})`) });
    }
  }
  return { last: rows.length ? rows[rows.length - 1].id : null, scanned: rows.length, todo };
}

/** "rc-call raw_input verification-token" → count. */
function tally(into, todo) {
  for (const t of todo) {
    for (const p of t.paths) {
      const name = JSON.parse(p.slice(p.lastIndexOf('."') + 1)).toLowerCase();
      const k = `${t.slug} · ${t.col} · ${name}`;
      into[k] = (into[k] || 0) + 1;
    }
  }
}

async function scan(conn, { apply, log }) {
  const hooks = await loadHooks(conn);
  const counts = {};
  let scanned = 0, rewritten = 0;
  for (const target of TARGETS) {
    let cursor = 0;
    for (;;) {
      const { last, scanned: n, todo } = await pending(conn, target, hooks, cursor);
      if (last == null) break;
      scanned += n;
      tally(counts, todo);
      if (apply && todo.length) {
        for (const col of target.columns) {
          const mine = todo.filter((t) => t.col === col);
          if (!mine.length) continue;
          const ids = mine.map((t) => t.id);
          const cases = mine.map((t) => `WHEN ? THEN JSON_REMOVE(${col}, ${t.paths.map(() => '?').join(', ')})`).join(' ');
          await conn.query(
            `UPDATE ${target.table} SET ${col} = CASE id ${cases} ELSE ${col} END WHERE id IN (${ids.map(() => '?').join(',')})`,
            [...mine.flatMap((t) => [t.id, ...t.paths]), ...ids]);
        }
        const again = await pending(conn, target, hooks, cursor);
        const left = again.todo.filter((t) => t.id <= last);
        if (left.length) {
          throw Object.assign(new Error(`${target.table}: ${left.length} cell(s) after id ${cursor} still hold a credential header after the rewrite`), { code: 'T_VERIFY' });
        }
        rewritten += todo.length;
      }
      cursor = last;
    }
  }
  return { scanned, rewritten, counts };
}

async function run(conn, { apply = false, log = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');
  await conn.query('SET SESSION innodb_lock_wait_timeout = 10');
  log(`hookExecutionsHeaderScrub — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}`);

  let first;
  try {
    first = await scan(conn, { apply, log });
  } catch (err) {
    const line = `NO-GO — ${err.message}. Batches before it are done; re-run --apply (it skips clean rows).`;
    log(line);
    return { ok: false, line };
  }
  const rows = Object.entries(first.counts).sort();
  const shown = [];
  let cautioned = false;
  for (const [k, n] of rows) {
    if (!cautioned && /^\(workflow_executions\) · variables · /.test(k)) {
      shown.push(`  ! ${VARIABLES_CAUTION}`);
      cautioned = true;
    }
    shown.push(`  ${k}: ${n}`);
  }
  log(shown.length ? shown.join('\n') : '  no stored credential header');
  if (!apply) {
    const total = rows.reduce((a, [, n]) => a + n, 0);
    const line = total
      ? `CHECK OK — ${total} stored credential header(s) in ${first.scanned} scanned row(s). GO (receiver fix deployed?). Next: node scripts/hookExecutionsHeaderScrub.js --apply`
      : 'CHECK OK — no stored credential header. GO (nothing to do).';
    log(line);
    return { ok: true, line, counts: first.counts };
  }
  // verify: a full read-only pass must find nothing
  const after = await scan(conn, { apply: false, log });
  const leftover = Object.values(after.counts).reduce((a, n) => a + n, 0);
  if (leftover) {
    Object.entries(after.counts).forEach(([k, n]) => log(`  ✗ still: ${k}: ${n}`));
    const line = `NO-GO — ${leftover} credential header(s) remain after the rewrite (above). Re-run --apply; if it persists, paste this to Claude.`;
    log(line);
    return { ok: false, line };
  }
  const line = `APPLIED — rewrote ${first.rewritten} cell(s); a full re-scan finds 0 stored credential headers. GO.`;
  log(line);
  return { ok: true, line, rewritten: first.rewritten };
}

module.exports = { run, pending, TARGETS, BATCH, VARIABLES_CAUTION };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Batches reported done stay done; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
