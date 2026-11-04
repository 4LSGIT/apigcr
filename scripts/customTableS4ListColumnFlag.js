#!/usr/bin/env node
// scripts/customTableS4ListColumnFlag.js
//
/**
 * custom_table_view S4 — the per-def "offer as a list column" flag
 * (Fred-ruled 2026-11-05, replacing a hardcoded column set):
 *
 *   ALTER TABLE field_defs ADD COLUMN list_column tinyint(1) NOT NULL DEFAULT 0
 *   UPDATE field_defs SET list_column = 1 WHERE entity='case' AND field_key='cf_court'
 *
 * The flag is what the Config custom-fields builder's "Offer as a list
 * column" checkbox writes, and what listCases' cf SELECT and the Cases
 * Columns picker honor (active AND flagged). cf_court is seeded ON per
 * Fred's ruling — Court in the Cases table is the point of the slice; the
 * checkbox can turn it off. The applied SQL is recorded in
 * ref/migrations/2026-11-05_custom_table_s4_field_defs_list_column.sql.
 *
 * DEPLOY ORDER IS STRICT: fieldDefService's SELECT_COLS is an explicit
 * column list that gains `list_column` in the same slice, so the backend
 * REQUIRES this migration — run it before the S4 backend lands.
 *
 * USAGE (repo root, a machine whose .env reaches production — the proxy is
 * started if .env opts in):
 *
 *   node scripts/customTableS4ListColumnFlag.js           # CHECK — read-only
 *   node scripts/customTableS4ListColumnFlag.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * Session settings (why a node script, not the SU console): lock_wait_timeout
 * = 5 — the ALTER takes an exclusive metadata lock, and the global default
 * would queue it behind any long transaction for up to a year, stalling
 * every query on field_defs while it waits. field_defs has 3 rows; the
 * ALTER itself is instant once it holds the lock.
 */

'use strict';

const COLUMN = 'list_column';
const COMMENT = 'custom_table_view S4 (2026-11-05): offer this def as a list-tab column — '
  + 'written by the Config fields builder checkbox "Offer as a list column"; only '
  + 'ACTIVE defs with this flag reach the listCases cf SELECT and the Cases Columns picker. '
  + 'Off by default.';

async function run(conn, { apply }) {
  const say = (s) => console.log(s);
  const q = async (sql, p) => (await conn.query(sql, p))[0];

  await q('SET SESSION lock_wait_timeout = 5');

  // ── live state ────────────────────────────────────────────────────────────
  const col = await q(
    `SELECT COLUMN_TYPE, COLUMN_DEFAULT, IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'field_defs' AND COLUMN_NAME = ?`, [COLUMN]);
  const defs = await q(
    `SELECT field_key, entity, active FROM field_defs ORDER BY id`);
  const court = defs.find((d) => d.field_key === 'cf_court' && d.entity === 'case');

  say(`field_defs rows: ${defs.length} (${defs.map((d) => d.field_key).join(', ')})`);
  say(`${COLUMN} column: ${col.length ? `PRESENT (${col[0].COLUMN_TYPE}, default ${col[0].COLUMN_DEFAULT})` : 'absent'}`);

  if (!court) {
    say('cf_court (entity=case) is MISSING from field_defs — the seed step has no target.');
    return { ok: false, line: 'NO-GO — cf_court def not found; nothing was changed.' };
  }
  if (!Number(court.active)) {
    say('cf_court exists but is INACTIVE — seeding a retired def makes no sense.');
    return { ok: false, line: 'NO-GO — cf_court is inactive; nothing was changed.' };
  }

  let flagged = [];
  if (col.length) {
    if (col[0].COLUMN_TYPE !== 'tinyint(1)' || col[0].IS_NULLABLE !== 'NO') {
      return { ok: false, line: `NO-GO — ${COLUMN} exists with unexpected shape (${col[0].COLUMN_TYPE}, nullable ${col[0].IS_NULLABLE}); inspect by hand.` };
    }
    flagged = await q(`SELECT field_key, entity FROM field_defs WHERE ${COLUMN} = 1`);
    say(`flagged defs: ${flagged.length ? flagged.map((d) => d.field_key).join(', ') : '(none)'}`);
  }

  const needAlter = !col.length;
  const needSeed = needAlter || !flagged.some((d) => d.field_key === 'cf_court' && d.entity === 'case');

  if (!needAlter && !needSeed) {
    const extra = flagged.filter((d) => !(d.field_key === 'cf_court' && d.entity === 'case'));
    if (extra.length) say(`note: other defs already flagged (deliberate checkbox use?): ${extra.map((d) => d.field_key).join(', ')}`);
    return { ok: true, line: 'GO — already applied (column present, cf_court flagged). Next: land the S4 backend.' };
  }

  if (!apply) {
    say(`\nplan: ${needAlter ? `ALTER TABLE field_defs ADD COLUMN ${COLUMN}; ` : ''}${needSeed ? 'UPDATE cf_court → 1.' : ''}`);
    return { ok: true, line: 'GO — ready. Next: node scripts/customTableS4ListColumnFlag.js --apply' };
  }

  // ── apply ────────────────────────────────────────────────────────────────
  if (needAlter) {
    await q(`ALTER TABLE field_defs
       ADD COLUMN ${COLUMN} tinyint(1) NOT NULL DEFAULT 0 COMMENT '${COMMENT}'
       AFTER indexed`);
    say(`✓ ALTER — ${COLUMN} added`);
  }
  if (needSeed) {
    const r = await conn.query(
      `UPDATE field_defs SET ${COLUMN} = 1 WHERE entity = 'case' AND field_key = 'cf_court'`);
    if (r[0].affectedRows !== 1 && r[0].changedRows !== 1) {
      // affectedRows 1 / changedRows 0 would mean it was already 1 — fine.
      if (r[0].affectedRows !== 1) {
        return { ok: false, line: `NO-GO — the seed UPDATE touched ${r[0].affectedRows} rows (expected 1); inspect by hand.` };
      }
    }
    say('✓ UPDATE — cf_court flagged');
  }

  // ── verify the end state (fresh reads, not the write results) ───────────
  const colAfter = await q(
    `SELECT COLUMN_TYPE, COLUMN_DEFAULT, IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'field_defs' AND COLUMN_NAME = ?`, [COLUMN]);
  const after = await q(`SELECT field_key, entity, ${COLUMN} AS flag FROM field_defs ORDER BY id`);
  const courtAfter = after.find((d) => d.field_key === 'cf_court' && d.entity === 'case');
  say(`end state: ${after.map((d) => `${d.field_key}=${d.flag}`).join(', ')}`);
  if (!colAfter.length || colAfter[0].COLUMN_TYPE !== 'tinyint(1)' || colAfter[0].IS_NULLABLE !== 'NO'
      || String(colAfter[0].COLUMN_DEFAULT) !== '0' || !courtAfter || Number(courtAfter.flag) !== 1) {
    return { ok: false, line: 'NO-GO — end-state verification failed; inspect the lines above.' };
  }
  return { ok: true, line: 'GO — applied and verified (column present, default 0, cf_court=1). Next: land the S4 backend.' };
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
      console.log(`\n${r.line}`);
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}

module.exports = { run };
