#!/usr/bin/env node
// scripts/accessD1ParentKey.js
//
/**
 * Access-control D1 — delegated session keys: readonly_api_keys.parent_key_id,
 * and the retirement of readonly_api_keys.ip_allowlist. TWO STAGES, in
 * opposite order around the deploy. The applied SQL is recorded in
 * ref/migrations/2026-10-15_access_d1_parent_key.sql.
 *
 * STAGE 1 — BEFORE the D1 deploy (default CHECK / --apply):
 *   1. ALTER TABLE readonly_api_keys ADD COLUMN parent_key_id int NULL COMMENT …
 *        AFTER scopes, ALGORITHM=INSTANT
 *   2. ALTER TABLE readonly_api_keys ADD INDEX idx_rok_parent (parent_key_id, created_at),
 *        ALGORITHM=INPLACE, LOCK=NONE
 *   3. ALTER TABLE readonly_api_keys ADD CONSTRAINT fk_rok_parent FOREIGN KEY (parent_key_id)
 *        REFERENCES readonly_api_keys (id) ON DELETE RESTRICT, ALGORITHM=INPLACE
 *
 * NULL = a root key — every existing row stays exactly what it is. The index
 * serves the child-mint rate count (parent_key_id = ? AND created_at > …) and
 * the child list. The foreign key is RESTRICT on purpose: a hard DELETE of a
 * parent with children is refused, rather than CASCADE silently deleting the
 * children (and, through fk_rqlog_key, their query logs) or SET NULL promoting
 * them to root keys that no longer die with their parent. Step 3 runs INPLACE
 * with foreign_key_checks off on this one connection (COPY would rebuild the
 * table under a lock); the script proves first that no row points at a missing
 * key, so nothing goes unchecked.
 *
 * STAGE 2 — AFTER the D1 deploy (--check-drop / --apply-drop):
 *   ALTER TABLE readonly_api_keys DROP COLUMN ip_allowlist, ALGORITHM=INSTANT
 *
 * ip_allowlist was stored at mint and enforced nowhere (Fred's ruling
 * 2026-10-15: retire it). The pre-D1 backend NAMES it — its SU mint INSERTs
 * it and its SU list SELECTs it — so dropping it before D1 is live would break
 * minting and listing keys. D1 never touches it, so D1 runs on either schema.
 * Stage 2 prints every row that still holds a value (the record of what was
 * believed restricted) before dropping.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER: stage 1 FIRST, then land + deploy D1, THEN stage 2.        │
 * │ The D1 session-key auth SELECTs parent_key_id: deployed first, EVERY     │
 * │ ycro_ request fails with a 500 "Auth lookup failed" — CLOSED, never      │
 * │ open — until the column exists. The old backend names its columns, so   │
 * │ the new NULL column is invisible to it. Stage 2 BEFORE the deploy breaks │
 * │ the pre-D1 SU mint and SU list (both name ip_allowlist).                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/accessD1ParentKey.js                # stage 1 CHECK — read-only, prints plan
 *   node scripts/accessD1ParentKey.js --apply        # stage 1: add parent_key_id
 *     … land + deploy D1 …
 *   node scripts/accessD1ParentKey.js --check-drop   # stage 2 CHECK — read-only
 *   node scripts/accessD1ParentKey.js --apply-drop   # stage 2: drop ip_allowlist
 *
 * Every run ends with ONE line: GO or NO-GO, naming the next command. Each stage is
 * resumable: it reads the live state every time and does only what is left.
 * A column, index or constraint that already exists in ANY other shape is a
 * NO-GO, never altered.
 */

'use strict';

const TABLE = 'readonly_api_keys';
const INDEX = 'idx_rok_parent';
const FK = 'fk_rok_parent';
const COMMENT =
  'Delegation (access-control D1): NULL = a root key (SU-minted); else the id of the keys.mint key ' +
  'that minted this child. A child is refused at auth once its parent is revoked or expired; its ' +
  'effective scopes = own ∩ parent ∩ (sql.ro, scratch, alert). FK RESTRICT: no hard delete of a parent.';
const ADD_COLUMN_SQL =
  `ALTER TABLE \`${TABLE}\` ADD COLUMN \`parent_key_id\` int NULL DEFAULT NULL ` +
  `COMMENT '${COMMENT}' AFTER \`scopes\`, ALGORITHM=INSTANT`;
const ADD_INDEX_SQL =
  `ALTER TABLE \`${TABLE}\` ADD INDEX \`${INDEX}\` (\`parent_key_id\`, \`created_at\`), ALGORITHM=INPLACE, LOCK=NONE`;
const ADD_FK_SQL =
  `ALTER TABLE \`${TABLE}\` ADD CONSTRAINT \`${FK}\` FOREIGN KEY (\`parent_key_id\`) ` +
  `REFERENCES \`${TABLE}\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT, ALGORITHM=INPLACE`;

/** { column, index, fk } each 'absent' | 'present', or { problem }. */
async function liveState(conn) {
  const [[t]] = await conn.query(
    `SELECT TABLE_TYPE type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  if (!t || t.type !== 'BASE TABLE') return { problem: `${TABLE} is not a base table here` };
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME name, LOWER(COLUMN_TYPE) type, IS_NULLABLE nullable, COLUMN_DEFAULT def
       FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [TABLE]);
  const names = cols.map(c => c.name);
  for (const need of ['id', 'key_hash', 'created_by', 'created_at', 'expires_at', 'revoked_at', 'scopes']) {
    if (!names.includes(need)) return { problem: `${TABLE} lacks ${need} — not the expected table` };
  }
  const idCol = cols.find(x => x.name === 'id');
  if (idCol.type !== 'int') return { problem: `${TABLE}.id is ${idCol.type} — expected int (the foreign key must match it)` };

  const c = cols.find(x => x.name === 'parent_key_id');
  let column = 'absent';
  if (c) {
    if (c.type !== 'int' || c.nullable !== 'YES' || c.def != null) {
      return { problem: `${TABLE}.parent_key_id exists as ${c.type} nullable=${c.nullable} default=${JSON.stringify(c.def)} — expected int NULL DEFAULT NULL` };
    }
    column = 'present';
  }

  const [idx] = await conn.query(
    `SELECT INDEX_NAME name, SEQ_IN_INDEX seq, COLUMN_NAME col, NON_UNIQUE nu
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`, [TABLE, INDEX]);
  let index = 'absent';
  if (idx.length) {
    const shape = idx.map(r => r.col).join(',');
    if (shape !== 'parent_key_id,created_at' || Number(idx[0].nu) !== 1) {
      return { problem: `index ${INDEX} exists as (${shape}) non_unique=${idx[0].nu} — expected (parent_key_id,created_at) non-unique` };
    }
    index = 'present';
  }

  const [fks] = await conn.query(
    `SELECT rc.CONSTRAINT_NAME name, rc.DELETE_RULE del, rc.UPDATE_RULE upd, rc.REFERENCED_TABLE_NAME ref,
            k.COLUMN_NAME col, k.REFERENCED_COLUMN_NAME refcol
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage k
         ON k.constraint_schema = rc.constraint_schema AND k.constraint_name = rc.constraint_name
        AND k.table_name = rc.table_name
      WHERE rc.constraint_schema = DATABASE() AND rc.table_name = ?
        AND (rc.constraint_name = ? OR k.column_name = 'parent_key_id')`, [TABLE, FK]);
  let fk = 'absent';
  if (fks.length) {
    const f = fks[0];
    if (fks.length !== 1 || f.name !== FK || f.ref !== TABLE || f.col !== 'parent_key_id' || f.refcol !== 'id'
        || f.del !== 'RESTRICT' || f.upd !== 'RESTRICT') {
      return { problem: `a foreign key on parent_key_id / named ${FK} exists in another shape: ${JSON.stringify(fks)}` };
    }
    fk = 'present';
  }
  if (column === 'absent' && (index === 'present' || fk === 'present')) {
    return { problem: `${INDEX}/${FK} present without the column — impossible state, not ours` };
  }
  return { column, index, fk };
}

const DROP_SQL = `ALTER TABLE \`${TABLE}\` DROP COLUMN \`ip_allowlist\`, ALGORITHM=INSTANT`;

/** 'present' | 'absent' | a problem string. */
async function ipAllowlistState(conn) {
  const [cols] = await conn.query(
    `SELECT LOWER(COLUMN_TYPE) type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'ip_allowlist'`, [TABLE]);
  if (!cols.length) return 'absent';
  if (cols[0].type !== 'text') return `${TABLE}.ip_allowlist is ${cols[0].type} — expected text`;
  return 'present';
}

const done = (s) => s.column === 'present' && s.index === 'present' && s.fk === 'present';

async function run(conn, { apply, log = console.log }) {
  log(`accessD1ParentKey — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);
  let st = await liveState(conn);
  if (st.problem) {
    log(`Unexpected live state: ${st.problem}`);
    log('\nNO-GO — re-verify by hand; this script never alters what it did not create. Nothing was changed.');
    return { ok: false };
  }
  log(`${TABLE}.parent_key_id: ${st.column}   index ${INDEX}: ${st.index}   foreign key ${FK}: ${st.fk}`);
  if (done(st)) {
    log('\nGO — stage 1 is already applied; nothing to do. Next: land + deploy access D1, then node scripts/accessD1ParentKey.js --check-drop');
    return { ok: true };
  }
  const plan = [
    st.column === 'absent' && ADD_COLUMN_SQL,
    st.index === 'absent' && ADD_INDEX_SQL,
    st.fk === 'absent' && ADD_FK_SQL,
  ].filter(Boolean);
  if (!apply) {
    log(`\nPlan:\n  ${plan.join('\n  ')}`);
    log('\nGO — base state matches. Next: node scripts/accessD1ParentKey.js --apply');
    return { ok: true };
  }

  await conn.query('SET SESSION lock_wait_timeout = 5');
  const step = async (label, sql) => {
    try {
      await conn.query(sql);
      log(`✓ ${label}`);
      return true;
    } catch (err) {
      log(`\n${label}: ${err.message}`);
      log('NO-GO — that step changed nothing (each ALTER is atomic); earlier steps stand. Re-run CHECK, then --apply resumes.');
      return false;
    }
  };

  if (st.column === 'absent') {
    if (!(await step('column added', ADD_COLUMN_SQL))) return { ok: false };
    const [[{ set }]] = await conn.query(`SELECT COUNT(*) \`set\` FROM \`${TABLE}\` WHERE parent_key_id IS NOT NULL`);
    if (Number(set)) {
      log(`parent_key_id is set on ${set} row(s) right after the ALTER — expected 0.`);
      log('\nNO-GO — verify by hand.');
      return { ok: false };
    }
  }
  if (st.index === 'absent') {
    if (!(await step(`index ${INDEX} added`, ADD_INDEX_SQL))) return { ok: false };
  }
  if (st.fk === 'absent') {
    // foreign_key_checks off lets the ALTER run INPLACE; this check is the one it skips.
    const [[{ orphans }]] = await conn.query(
      `SELECT COUNT(*) orphans FROM \`${TABLE}\` c LEFT JOIN \`${TABLE}\` p ON p.id = c.parent_key_id
        WHERE c.parent_key_id IS NOT NULL AND p.id IS NULL`);
    if (Number(orphans)) {
      log(`${orphans} row(s) name a parent_key_id that does not exist — the foreign key would be a lie.`);
      log('\nNO-GO — verify by hand; nothing further was changed.');
      return { ok: false };
    }
    await conn.query('SET SESSION foreign_key_checks = 0');
    let ok;
    try {
      ok = await step(`foreign key ${FK} added (ON DELETE RESTRICT)`, ADD_FK_SQL);
    } finally {
      await conn.query('SET SESSION foreign_key_checks = 1');
    }
    if (!ok) return { ok: false };
  }

  st = await liveState(conn);
  if (st.problem || !done(st)) {
    log(`After the ALTERs: ${st.problem || JSON.stringify(st)}`);
    log('\nNO-GO — verify by hand before rerunning.');
    return { ok: false };
  }
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM \`${TABLE}\``);
  log(`✓ verified — column int NULL, index (parent_key_id, created_at), FK RESTRICT; ${n} existing key(s)`);
  log('\nGO — stage 1 applied. Next: land + deploy access D1, then node scripts/accessD1ParentKey.js --check-drop');
  return { ok: true };
}

/** Stage 2 — retire ip_allowlist. Only after the D1 backend is live. */
async function runDrop(conn, { apply, log = console.log }) {
  log(`accessD1ParentKey stage 2 (drop ip_allowlist) — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}\n`);
  const s1 = await liveState(conn);
  if (s1.problem || !done(s1)) {
    log(`Stage 1 is not complete: ${s1.problem || JSON.stringify(s1)}`);
    log('\nNO-GO — stage 2 follows stage 1 and the D1 deploy. Next: node scripts/accessD1ParentKey.js');
    return { ok: false };
  }
  const st = await ipAllowlistState(conn);
  if (st !== 'present' && st !== 'absent') {
    log(`Unexpected live state: ${st}`);
    log('\nNO-GO — re-verify by hand; nothing was changed.');
    return { ok: false };
  }
  log(`${TABLE}.ip_allowlist: ${st}`);
  if (st === 'absent') {
    log('\nGO — stage 2 is already applied; nothing to do. Next: npm run db:ref');
    return { ok: true };
  }
  const [held] = await conn.query(
    `SELECT id, label, ip_allowlist FROM \`${TABLE}\` WHERE ip_allowlist IS NOT NULL AND ip_allowlist <> '' ORDER BY id`);
  log(`Rows holding a value (never enforced): ${held.length}`);
  for (const r of held) log(`  #${r.id} ${JSON.stringify(r.label)}: ${JSON.stringify(r.ip_allowlist)}`);
  if (!apply) {
    log(`\nPlan:\n  ${DROP_SQL}`);
    log('\nGO — ONLY IF the D1 backend is already deployed (the pre-D1 backend writes this column). Next: node scripts/accessD1ParentKey.js --apply-drop');
    return { ok: true };
  }
  await conn.query('SET SESSION lock_wait_timeout = 5');
  try {
    await conn.query(DROP_SQL);
  } catch (err) {
    log(`\n${err.message}`);
    log('NO-GO — nothing was changed (an ALTER is atomic); re-run --check-drop, then --apply-drop.');
    return { ok: false };
  }
  if ((await ipAllowlistState(conn)) !== 'absent') {
    log('DROP ran but the column is still there.');
    log('\nNO-GO — verify by hand.');
    return { ok: false };
  }
  log(`✓ ${TABLE}.ip_allowlist dropped (${held.length} value(s) listed above)`);
  log('\nGO — stage 2 applied; D1 is complete. Next: npm run db:ref');
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
  const argv = process.argv.slice(2);
  const known = ['--apply', '--check-drop', '--apply-drop'];
  const bad = argv.filter(a => !known.includes(a));
  if (bad.length || argv.length > 1) {
    console.log(`Unknown or combined flags: ${argv.join(' ')}\n\nNO-GO — pass at most one of ${known.join(', ')}. Nothing was changed.`);
    process.exit(1);
  }
  const apply = argv[0] === '--apply' || argv[0] === '--apply-drop';
  const stage2 = argv[0] === '--check-drop' || argv[0] === '--apply-drop';
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
      const r = await (stage2 ? runDrop : run)(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing further was changed; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run, runDrop, liveState, ipAllowlistState, ADD_COLUMN_SQL, ADD_INDEX_SQL, ADD_FK_SQL, DROP_SQL, COMMENT };
