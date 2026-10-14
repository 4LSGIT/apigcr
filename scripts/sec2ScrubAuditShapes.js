#!/usr/bin/env node
// scripts/sec2ScrubAuditShapes.js
//
/**
 * SEC-2 — rewrite HISTORICAL jwt_api_audit_log rows so their `body` and
 * `query_params` hold value SHAPES ("[str 11]", "[arr 3]", "[secret]" …), the
 * same form lib/auth.jwtOrApiKey writes for every new row. Keys are kept,
 * values are gone. Uses lib/auditShape.shapeTop — the SHIPPED summarizer,
 * never a copy — so a scrubbed row and a new row cannot disagree.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: land + deploy SEC-2 FIRST, then run this. New rows are     │
 * │ born shaped once the code is live; this cleans the history. (Run first,  │
 * │ the old code would keep writing raw rows behind it.)                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/sec2ScrubAuditShapes.js                 # CHECK — read-only count
 *   node scripts/sec2ScrubAuditShapes.js --apply         # rewrite, batched
 *   node scripts/sec2ScrubAuditShapes.js --apply --from-id=50000   # resume from an id
 *
 * Batches of BATCH rows by id (id > last, ORDER BY id, LIMIT BATCH), each
 * rewritten by ONE UPDATE statement (atomic, one round trip; session
 * lock_wait_timeout low; PK record locks only, so the live logger's INSERTs
 * at the tail are not blocked), then re-read and verified. A progress line every PROGRESS_EVERY batches; one
 * GO / NO-GO line at the end. RE-RUNNABLE: a row whose body AND query_params
 * already match the shape grammar (lib/auditShape.isShaped — every value a
 * "[…]" tag, or {} / NULL) is skipped, so a second run rewrites nothing.
 * Only body and query_params change; route, headers, status, ip, user agent,
 * timestamps are untouched (created_at is a plain TIMESTAMP with no ON UPDATE).
 */

'use strict';

const { shapeTop, isShaped } = require('../lib/auditShape');

const BATCH = 2000;
const PROGRESS_EVERY = 10;

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;                 // mysql2 parses JSON columns
  try { return JSON.parse(v); } catch (_) { return v; }
};

async function columnsOk(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(DATA_TYPE) type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'jwt_api_audit_log'
        AND column_name IN ('id', 'body', 'query_params')`);
  const by = Object.fromEntries(cols.map(c => [c.name, c.type]));
  return by.id === 'bigint' && by.body === 'json' && by.query_params === 'json';
}

/** Rows in one id window that still need shaping, with their new values. */
async function pending(conn, fromId) {
  const [rows] = await conn.query(
    'SELECT id, body, query_params FROM jwt_api_audit_log WHERE id > ? ORDER BY id LIMIT ?',
    [fromId, BATCH]);
  const todo = [];
  for (const r of rows) {
    const body = parse(r.body);
    const query = parse(r.query_params);
    if (isShaped(body) && isShaped(query)) continue;
    // an already-shaped side is written back as it was (SQL NULL stays NULL)
    const keep = (raw, v) => (raw == null ? null : JSON.stringify(v));
    todo.push({
      id: r.id,
      body: isShaped(body) ? keep(r.body, body) : JSON.stringify(shapeTop(body)),
      query: isShaped(query) ? keep(r.query_params, query) : JSON.stringify(shapeTop(query)),
    });
  }
  return { last: rows.length ? rows[rows.length - 1].id : null, scanned: rows.length, todo };
}

async function run(conn, { apply, fromId = 0, log = console.log }) {
  log(`sec2ScrubAuditShapes — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}`);
  if (!(await columnsOk(conn))) {
    log('\njwt_api_audit_log is not the expected shape (id bigint, body json, query_params json).');
    log('NO-GO — re-verify by hand. Nothing was changed.');
    return { ok: false };
  }
  if (apply) await conn.query('SET SESSION lock_wait_timeout = 5');

  let cursor = Number(fromId) || 0;
  let scanned = 0, rewritten = 0, batches = 0;
  for (;;) {
    const { last, scanned: n, todo } = await pending(conn, cursor);
    if (last == null) break;
    scanned += n;
    if (apply && todo.length) {
      // ONE statement per batch (one round trip through the proxy, atomic):
      // SET body = CASE id WHEN ? THEN ? … END, query_params = CASE … WHERE id IN (…)
      const caseOf = `CASE id ${todo.map(() => 'WHEN ? THEN ?').join(' ')} END`;
      const params = [
        ...todo.flatMap(t => [t.id, t.body]),
        ...todo.flatMap(t => [t.id, t.query]),
        ...todo.map(t => t.id),
      ];
      try {
        await conn.query(
          `UPDATE jwt_api_audit_log SET body = ${caseOf}, query_params = ${caseOf} WHERE id IN (${todo.map(() => '?').join(',')})`,
          params);
      } catch (err) {
        log(`\nbatch after id ${cursor} failed: ${err.message}`);
        log(`NO-GO — nothing in that batch was written. Resume: node scripts/sec2ScrubAuditShapes.js --apply --from-id=${cursor}`);
        return { ok: false, scanned, rewritten };
      }
      // verify: every row just written now reads back shaped
      const [back] = await conn.query(
        `SELECT id, body, query_params FROM jwt_api_audit_log WHERE id IN (${todo.map(() => '?').join(',')})`,
        todo.map(t => t.id));
      const bad = back.filter(r => !(isShaped(parse(r.body)) && isShaped(parse(r.query_params))));
      if (bad.length || back.length !== todo.length) {
        log(`\nverify failed after id ${cursor}: ${bad.length} row(s) not shaped, ${back.length}/${todo.length} read back.`);
        log(`NO-GO — verify by hand. Resume: node scripts/sec2ScrubAuditShapes.js --apply --from-id=${cursor}`);
        return { ok: false, scanned, rewritten };
      }
    }
    rewritten += todo.length;
    cursor = last;
    batches++;
    if (batches % PROGRESS_EVERY === 0) {
      log(`  … through id ${cursor}: scanned ${scanned}, ${apply ? 'rewritten' : 'to rewrite'} ${rewritten}`);
    }
  }

  log(`\nscanned ${scanned} row(s); ${apply ? 'rewrote' : 'would rewrite'} ${rewritten}.`);
  if (!apply) {
    log(rewritten
      ? 'GO — base state matches. Next (SEC-2 code deployed?): node scripts/sec2ScrubAuditShapes.js --apply'
      : 'GO — every row is already shaped; nothing to do.');
  } else {
    log(rewritten
      ? 'GO — history scrubbed and verified. A re-run (CHECK) should report 0 to rewrite.'
      : 'GO — every row was already shaped; nothing written.');
  }
  return { ok: true, scanned, rewritten };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  const fromArg = process.argv.find(a => a.startsWith('--from-id='));
  const fromId = fromArg ? Number(fromArg.split('=')[1]) : 0;
  (async () => {
    let conn;
    try {
      if (!Number.isInteger(fromId) || fromId < 0) throw new Error('--from-id must be a non-negative integer');
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply, fromId });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Batches reported done above stay done; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, pending, BATCH };
