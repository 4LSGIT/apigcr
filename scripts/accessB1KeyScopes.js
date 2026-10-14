#!/usr/bin/env node
// scripts/accessB1KeyScopes.js
//
/**
 * Access-control B1 — the `scopes` column on both key tables.
 *
 *   readonly_api_keys.scopes  JSON NULL   (session keys, ycro_)
 *   api_keys.scopes           JSON NULL   (machine keys, yck_)
 *
 * NULL = the legacy full surface: every existing key keeps exactly today's
 * behavior until someone sets its scopes (design §5.2 — per-key rollout, no
 * flag day). Vocabulary: lib/capabilities.js KEY_SCOPES (+ route:/ and
 * capability families). ref/ACCESS_CONTROL_DESIGN.md §5.2, §5.6 B1; the
 * applied SQL is recorded in ref/migrations/2026-10-14_access_b1_key_scopes.sql.
 *
 * Deploy order (SQL → backend → frontend): run THIS, then land + deploy B1.
 * The old backend never names the column; the new one SELECTs it on every
 * key-authenticated request, so the column must exist first.
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *
 *   node scripts/accessB1KeyScopes.js           # CHECK — read-only, prints plan
 *   node scripts/accessB1KeyScopes.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable per table: it reads the live state every time and adds only the
 * column still missing. A `scopes` column of any other shape is a NO-GO.
 *
 * ── WHY A NODE SCRIPT ON ONE CONNECTION ─────────────────────────────────────
 * Each ALTER takes a metadata lock on a table every key-authenticated request
 * reads. lock_wait_timeout must be LOW on the SAME session (global default is
 * a year); /admin/db/batch cannot pin a session setting to a statement.
 * ALGORITHM=INPLACE, LOCK=NONE: refuses rather than block writers.
 */

'use strict';

const COMMENT =
  'Key scopes (access-control B1): NULL = legacy full surface; else a JSON array of scope strings — ' +
  'surface (sql.ro, scratch, alert, temp.*), route:/<path>, or a capability name. Vocabulary: lib/capabilities.js KEY_SCOPES.';

const TABLES = ['readonly_api_keys', 'api_keys'];

const alterSql = (t) =>
  `ALTER TABLE \`${t}\` ADD COLUMN \`scopes\` JSON NULL COMMENT '${COMMENT.replace(/'/g, "''")}', ALGORITHM=INPLACE, LOCK=NONE`;

async function colOf(conn, table) {
  const [[t]] = await conn.query(
    'SELECT 1 x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table]);
  if (!t) return { table: false };
  const [[c]] = await conn.query(
    `SELECT LOWER(DATA_TYPE) type, IS_NULLABLE nullable, COLUMN_DEFAULT def
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'scopes'`, [table]);
  return { table: true, col: c || null };
}

const shapeOk = (c) => c && c.type === 'json' && c.nullable === 'YES' && c.def == null;

async function run(conn, { apply }) {
  const mode = apply ? 'APPLY' : 'CHECK';
  console.log(`accessB1KeyScopes — ${mode} — ${new Date().toISOString()}\n`);

  // ── base state ────────────────────────────────────────────────────────────
  const todo = [];
  for (const t of TABLES) {
    const st = await colOf(conn, t);
    if (!st.table) {
      console.log(`${t}: TABLE MISSING`);
      console.log('\nNO-GO — wrong database? Nothing was changed.');
      return { ok: false };
    }
    if (!st.col) { console.log(`${t}.scopes: absent`); todo.push(t); continue; }
    if (!shapeOk(st.col)) {
      console.log(`${t}.scopes exists as ${st.col.type} nullable=${st.col.nullable} default=${JSON.stringify(st.col.def)} — expected json, NULL, no default.`);
      console.log('\nNO-GO — re-verify by hand; this script never alters an existing column. Nothing was changed.');
      return { ok: false };
    }
    console.log(`${t}.scopes: present ✓`);
  }

  if (!todo.length) {
    console.log('\nGO — the migration is already applied; nothing to do. Next: land + deploy access B1.');
    return { ok: true };
  }

  if (!apply) {
    console.log(`\nPlan:\n${todo.map(t => '  ' + alterSql(t)).join('\n')}\n`);
    console.log('GO — base state matches. Next: node scripts/accessB1KeyScopes.js --apply');
    return { ok: true };
  }

  // ── apply ────────────────────────────────────────────────────────────────
  await conn.query('SET SESSION lock_wait_timeout = 5');
  for (const t of todo) {
    await conn.query(alterSql(t));
    const st = await colOf(conn, t);
    if (!shapeOk(st.col)) {
      console.log(`ALTER on ${t} ran but scopes reads back as ${JSON.stringify(st.col)}.`);
      console.log('\nNO-GO — verify by hand before rerunning.');
      return { ok: false };
    }
    const [[n]] = await conn.query(`SELECT COUNT(*) total, SUM(scopes IS NULL) nulls FROM \`${t}\``);
    if (Number(n.total) !== Number(n.nulls || 0)) {
      console.log(`${t}: ${n.total} rows but only ${n.nulls} NULL scopes after the ADD — expected all NULL.`);
      console.log('\nNO-GO — verify by hand.');
      return { ok: false };
    }
    console.log(`✓ ${t}.scopes added (JSON NULL); all ${n.total} existing rows NULL = legacy full surface`);
  }

  console.log('\nGO — migration applied and verified. Next: land + deploy access B1 (then npm run db:ref).');
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
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, alterSql, TABLES, COMMENT };
