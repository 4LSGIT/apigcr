#!/usr/bin/env node
// scripts/accessA5Entitlements.js
//
/**
 * Access-control A5 — the entitlement_denies table.
 *
 * ref/ACCESS_CONTROL_DESIGN.md §2.6. The applied SQL is recorded in
 * ref/migrations/2026-10-14_access_a5_entitlement_denies.sql.
 *
 * DENY-ONLY rows: "deny wins" and "default allow" fall out of the storage
 * shape — there are no allow rows to rank. scope_ref is '' for firm (NOT
 * NULL: a UNIQUE index treats NULLs as distinct, so a nullable firm scope
 * would let one firm deny be stored twice — and deleting one copy would leave
 * the deny in force). Same sentinel spelling as ui_config's role column.
 *
 * Deploy order (SQL → backend → frontend): run THIS, then land + deploy A5.
 * The old backend never reads the table, so creating it first is safe — and
 * the new /api/firm-data reads it on every shell boot.
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *
 *   node scripts/accessA5Entitlements.js           # CHECK — read-only, prints plan
 *   node scripts/accessA5Entitlements.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * A table that already exists in ANY other shape is a NO-GO, never altered.
 */

'use strict';

const TABLE = 'entitlement_denies';

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS \`entitlement_denies\` (
  \`id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`scope\` enum('firm','role','user') NOT NULL COMMENT 'firm = everyone; role = holders of scope_ref; user = users.user scope_ref',
  \`scope_ref\` varchar(64) NOT NULL DEFAULT '' COMMENT 'empty string = firm (sentinel; NOT NULL so the UNIQUE holds); role = a users.roles SET member; user = users.user as digits',
  \`item_key\` varchar(64) NOT NULL COMMENT 'public/js/featureRegistry.js key — validated at write; moreSettings/helpSupport refused (undeniable)',
  \`created_by\` tinyint NOT NULL COMMENT 'users.user of the writer; 0 = an x-api-key caller',
  \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_entitlement_denies_scope_item\` (\`scope\`,\`scope_ref\`,\`item_key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Launcher entitlement DENIES (access-control A5). Deny-only: absent = allowed; any matching row denies. Visibility-only in v2 — no route enforcement.'`;

// What information_schema must say once the table exists (lower-cased types).
const EXPECTED_COLUMNS = [
  { name: 'id',         type: 'int unsigned',                 nullable: 'NO', def: null },
  { name: 'scope',      type: "enum('firm','role','user')",   nullable: 'NO', def: null },
  { name: 'scope_ref',  type: 'varchar(64)',                  nullable: 'NO', def: '' },
  { name: 'item_key',   type: 'varchar(64)',                  nullable: 'NO', def: null },
  { name: 'created_by', type: 'tinyint',                      nullable: 'NO', def: null },
  { name: 'created_at', type: 'datetime',                     nullable: 'NO', def: 'CURRENT_TIMESTAMP' },
];
const EXPECTED_UNIQUE = ['scope', 'scope_ref', 'item_key'];
const EXPECTED_COLLATION = 'utf8mb4_general_ci';

async function tableState(conn) {
  const [[t]] = await conn.query(
    `SELECT TABLE_COLLATION coll FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  if (!t) return { exists: false };
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLUMN_DEFAULT def
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`, [TABLE]);
  const [idx] = await conn.query(
    `SELECT COLUMN_NAME name FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [TABLE]);
  return { exists: true, coll: t.coll, cols, unique: idx.map(r => r.name) };
}

/** Returns a list of human-readable differences from the expected shape. */
function shapeProblems(st) {
  const out = [];
  if (st.coll !== EXPECTED_COLLATION) out.push(`table collation '${st.coll}', expected '${EXPECTED_COLLATION}'`);
  const got = st.cols.map(c => c.name);
  const want = EXPECTED_COLUMNS.map(c => c.name);
  if (got.join(',') !== want.join(',')) out.push(`columns [${got.join(', ')}], expected [${want.join(', ')}]`);
  for (const e of EXPECTED_COLUMNS) {
    const c = st.cols.find(x => x.name === e.name);
    if (!c) continue;
    if (c.type !== e.type) out.push(`${e.name} type '${c.type}', expected '${e.type}'`);
    if (c.nullable !== e.nullable) out.push(`${e.name} nullable ${c.nullable}, expected ${e.nullable}`);
    if ((c.def ?? null) !== e.def) out.push(`${e.name} default ${JSON.stringify(c.def)}, expected ${JSON.stringify(e.def)}`);
  }
  if (st.unique.join(',') !== EXPECTED_UNIQUE.join(',')) {
    out.push(`unique key [${st.unique.join(', ')}], expected [${EXPECTED_UNIQUE.join(', ')}]`);
  }
  return out;
}

async function run(conn, { apply }) {
  const mode = apply ? 'APPLY' : 'CHECK';
  console.log(`accessA5Entitlements — ${mode} — ${new Date().toISOString()}\n`);

  const st = await tableState(conn);
  if (st.exists) {
    const probs = shapeProblems(st);
    if (probs.length) {
      console.log(`${TABLE} exists in a different shape:\n  ${probs.join('\n  ')}`);
      console.log('\nNO-GO — re-verify by hand; this script never alters an existing table. Nothing was changed.');
      return { ok: false };
    }
    console.log(`${TABLE}: present, shape matches ✓`);
    console.log('\nGO — the migration is already applied; nothing to do. Next: land + deploy access A5.');
    return { ok: true };
  }

  console.log(`${TABLE}: absent`);
  if (!apply) {
    console.log(`\nPlan:\n${CREATE_SQL}\n`);
    console.log('GO — base state matches. Next: node scripts/accessA5Entitlements.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  await conn.query(CREATE_SQL);
  const after = await tableState(conn);
  const probs = after.exists ? shapeProblems(after) : ['table still absent after CREATE'];
  if (probs.length) {
    console.log(`CREATE ran but:\n  ${probs.join('\n  ')}`);
    console.log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  console.log(`✓ ${TABLE} created and its shape verified`);
  console.log('\nGO — migration applied. Next: land + deploy access A5 (then npm run db:ref).');
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

module.exports = { run, CREATE_SQL, EXPECTED_COLUMNS, EXPECTED_UNIQUE, shapeProblems, TABLE };
