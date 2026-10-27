#!/usr/bin/env node
// scripts/auditLogCredHeaderScrub.js
//
/**
 * Remove credential HEADERS from historical jwt_api_audit_log rows. The
 * logger deleted only authorization / x-api-key / cookie, so x-su-elevation
 * (the SU step-up token) was stored in every stepped-up request's row —
 * 8,926 rows, 2026-08-16 → 2026-10-27. lib/auth.jwtOrApiKey now drops every
 * header whose NAME matches CREDENTIAL_HEADER_RE; this applies the SAME
 * regex (the shipped one, never a copy) to the history, so a scrubbed row
 * and a new row cannot disagree. Derived from scripts/sec2ScrubAuditShapes.js.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: land + deploy the logger fix FIRST, then run this. Run     │
 * │ first, the old code keeps writing tokens behind it.                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/auditLogCredHeaderScrub.js                 # CHECK — read-only count
 *   node scripts/auditLogCredHeaderScrub.js --apply         # rewrite, batched
 *   node scripts/auditLogCredHeaderScrub.js --apply --from-id=50000   # resume from an id
 *
 * Batches of BATCH rows by id, each rewritten by ONE UPDATE (atomic; session
 * lock_wait_timeout low; PK record locks only, so the live logger's INSERTs
 * at the tail are not blocked), then re-read and verified. Only `headers`
 * changes, and only by losing credential-named keys; created_at has no ON
 * UPDATE. RE-RUNNABLE: a row with no credential-named key is skipped, so a
 * second run rewrites nothing. One GO / NO-GO line at the end.
 */

'use strict';

const { CREDENTIAL_HEADER_RE } = require('../lib/auth.jwtOrApiKey');

const BATCH = 2000;
const PROGRESS_EVERY = 10;

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;                 // mysql2 parses JSON columns
  try { return JSON.parse(v); } catch (_) { return v; }
};

/** Credential-named keys in one stored headers value ([] = clean). */
function credKeys(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return [];
  return Object.keys(h).filter(k => CREDENTIAL_HEADER_RE.test(k));
}

async function columnsOk(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(DATA_TYPE) type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'jwt_api_audit_log'
        AND column_name IN ('id', 'headers')`);
  const by = Object.fromEntries(cols.map(c => [c.name, c.type]));
  return by.id === 'bigint' && by.headers === 'json';
}

/** Rows in one id window that hold a credential header, with their new value. */
async function pending(conn, fromId) {
  const [rows] = await conn.query(
    'SELECT id, headers FROM jwt_api_audit_log WHERE id > ? ORDER BY id LIMIT ?',
    [fromId, BATCH]);
  const todo = [];
  const names = {};
  for (const r of rows) {
    const h = parse(r.headers);
    const ks = credKeys(h);
    if (!ks.length) continue;
    const clean = { ...h };
    for (const k of ks) { delete clean[k]; names[k] = (names[k] || 0) + 1; }
    todo.push({ id: r.id, headers: JSON.stringify(clean) });
  }
  return { last: rows.length ? rows[rows.length - 1].id : null, scanned: rows.length, todo, names };
}

async function run(conn, { apply, fromId = 0, log = console.log }) {
  log(`auditLogCredHeaderScrub — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}`);
  if (!(await columnsOk(conn))) {
    log('\njwt_api_audit_log is not the expected shape (id bigint, headers json).');
    log('NO-GO — re-verify by hand. Nothing was changed.');
    return { ok: false };
  }
  if (apply) await conn.query('SET SESSION lock_wait_timeout = 5');

  let cursor = Number(fromId) || 0;
  let scanned = 0, rewritten = 0, batches = 0;
  const byName = {};
  for (;;) {
    const { last, scanned: n, todo, names } = await pending(conn, cursor);
    if (last == null) break;
    scanned += n;
    for (const [k, c] of Object.entries(names)) byName[k] = (byName[k] || 0) + c;
    if (apply && todo.length) {
      const ids = todo.map(t => t.id);
      try {
        await conn.query(
          `UPDATE jwt_api_audit_log SET headers = CASE id ${todo.map(() => 'WHEN ? THEN CAST(? AS JSON)').join(' ')} END
            WHERE id IN (${ids.map(() => '?').join(',')})`,
          [...todo.flatMap(t => [t.id, t.headers]), ...ids]);
      } catch (err) {
        log(`\nbatch after id ${cursor} failed: ${err.message}`);
        log(`NO-GO — nothing in that batch was written. Resume: node scripts/auditLogCredHeaderScrub.js --apply --from-id=${cursor}`);
        return { ok: false, scanned, rewritten };
      }
      // verify: every row just written reads back with no credential key
      const [back] = await conn.query(
        `SELECT id, headers FROM jwt_api_audit_log WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      const bad = back.filter(r => credKeys(parse(r.headers)).length);
      if (bad.length || back.length !== todo.length) {
        log(`\nverify failed after id ${cursor}: ${bad.length} row(s) still hold a credential header, ${back.length}/${todo.length} read back.`);
        log(`NO-GO — verify by hand. Resume: node scripts/auditLogCredHeaderScrub.js --apply --from-id=${cursor}`);
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

  const names = Object.entries(byName).map(([k, c]) => `${k} ${c}`).join(', ') || 'none';
  log(`\nscanned ${scanned} row(s); ${apply ? 'rewrote' : 'would rewrite'} ${rewritten} (keys: ${names}).`);
  if (!apply) {
    log(rewritten
      ? 'GO — base state matches. Next (logger fix deployed?): node scripts/auditLogCredHeaderScrub.js --apply'
      : 'GO — no row holds a credential header; nothing to do.');
  } else {
    log(rewritten
      ? 'GO — history scrubbed and verified. A re-run (CHECK) should report 0 to rewrite.'
      : 'GO — no row held a credential header; nothing written.');
  }
  return { ok: true, scanned, rewritten, byName };
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

module.exports = { run, pending, credKeys, BATCH };
