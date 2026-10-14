#!/usr/bin/env node
// scripts/accessB6KeyExpiry.js
//
/**
 * Access-control B6 — optional expiry on machine keys: api_keys.expires_at.
 * The applied SQL is recorded in ref/migrations/2026-10-14_access_b6_api_key_expiry.sql.
 *
 *   ALTER TABLE api_keys ADD COLUMN expires_at datetime NULL COMMENT …
 *     AFTER revoked_at, ALGORITHM=INSTANT
 *
 * NULL = non-expiring — every existing row (legacy and infrastructure keys)
 * keeps working exactly as today. lib/apiKeys.lookup refuses a row whose
 * expires_at has passed, exactly like a revoked one.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: run THIS FIRST, then land + deploy B6.                     │
 * │ The B6 backend SELECTs and INSERTs api_keys.expires_at: deployed first, │
 * │ every yck_ lookup fails — and lookup fails CLOSED, so every machine key │
 * │ (the scheduler jobs, Pabbly) stops authenticating. The old backend      │
 * │ names its columns, so the new NULL column is invisible to it.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/accessB6KeyExpiry.js           # CHECK — read-only, prints plan
 *   node scripts/accessB6KeyExpiry.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * A column that already exists in ANY other shape is a NO-GO, never altered.
 */

'use strict';

const TABLE = 'api_keys';
const COMMENT = 'NULL = non-expiring (legacy and infrastructure keys); checked at lookup';
const ALTER_SQL =
  `ALTER TABLE \`${TABLE}\` ADD COLUMN \`expires_at\` datetime NULL DEFAULT NULL ` +
  `COMMENT '${COMMENT}' AFTER \`revoked_at\`, ALGORITHM=INSTANT`;

/** 'absent' | 'present' | a problem string. */
async function columnState(conn) {
  const [[t]] = await conn.query(
    `SELECT TABLE_TYPE type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  if (!t || t.type !== 'BASE TABLE') return `${TABLE} is not a base table here`;
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLUMN_DEFAULT def
       FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  const names = cols.map(c => c.name);
  for (const need of ['id', 'key_hash', 'revoked_at', 'scopes']) {
    if (!names.includes(need)) return `${TABLE} lacks ${need} — not the expected table`;
  }
  const c = cols.find(x => x.name === 'expires_at');
  if (!c) return 'absent';
  if (c.type === 'datetime' && c.nullable === 'YES' && c.def == null) return 'present';
  return `${TABLE}.expires_at exists as ${c.type} nullable=${c.nullable} default=${JSON.stringify(c.def)} — expected datetime NULL DEFAULT NULL`;
}

async function run(conn, { apply, log = console.log }) {
  log(`accessB6KeyExpiry — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);
  const st = await columnState(conn);
  if (st !== 'absent' && st !== 'present') {
    log(`Unexpected live state: ${st}`);
    log('\nNO-GO — re-verify by hand; this script never alters what it did not create. Nothing was changed.');
    return { ok: false };
  }
  log(`${TABLE}.expires_at: ${st}`);
  if (st === 'present') {
    log('\nGO — the migration is already applied; nothing to do. Next: land + deploy access B6.');
    return { ok: true };
  }
  if (!apply) {
    log(`\nPlan:\n  ${ALTER_SQL}`);
    log('\nGO — base state matches. Next: node scripts/accessB6KeyExpiry.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  try {
    await conn.query(ALTER_SQL);
  } catch (err) {
    log(`\n${err.message}`);
    log('NO-GO — nothing was changed (an ALTER is atomic); re-run CHECK, then --apply.');
    return { ok: false };
  }
  const after = await columnState(conn);
  if (after !== 'present') {
    log(`ALTER ran but: ${after}`);
    log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  const [[{ n, set }]] = await conn.query(
    `SELECT COUNT(*) n, SUM(expires_at IS NOT NULL) \`set\` FROM \`${TABLE}\``);
  if (Number(set)) {
    log(`expires_at is set on ${set} row(s) right after the ALTER — expected 0.`);
    log('\nNO-GO — verify by hand.');
    return { ok: false };
  }
  log(`✓ ${TABLE}.expires_at added and verified — all ${n} existing key(s) NULL (non-expiring)`);
  log('\nGO — migration applied. Next: land + deploy access B6 (then npm run db:ref).');
  return { ok: true };
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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing further was changed; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, columnState, ALTER_SQL, COMMENT };
