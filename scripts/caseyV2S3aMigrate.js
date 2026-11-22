#!/usr/bin/env node
// scripts/caseyV2S3aMigrate.js
//
/**
 * Casey v2 S3a — casey_chats.stop_requested_at (the page's Stop button). The
 * statement, comment included, is read from
 * ref/migrations/2026-11-22_casey_v2_s3a_stop.sql so the file and the applied
 * schema can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/caseyV2S3aMigrate.js            # CHECK — read-only
 *   2. node scripts/caseyV2S3aMigrate.js --apply    # ALTER, verify
 *   3. the S3a backend + frontend deploy (one land)
 *
 * CHECK (default), read-only: casey_chats exists with the S2 shape (the S2
 * script's expectations, re-used) and the column is absent (to do) or present
 * with the expected type, nullability, default, position and comment (a
 * re-run). Anything else is NO-GO, nothing changed.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 5 — an ALTER on
 * a live table takes a metadata lock; 5 s caps a wait behind a long turn's
 * transaction and the run resumes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const s2 = require('./caseyV2ChatsMigrate');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-22_casey_v2_s3a_stop.sql');
const TABLE = 'casey_chats';
const COLUMN = 'stop_requested_at';
const AFTER = 'running_since';
/** [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA] */
const SHAPE = Object.freeze(['datetime', 'YES', null, null, '']);

function alterSql() {
  const stmts = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  return stmts.find((s) => new RegExp(`^ALTER TABLE ${TABLE}\\s`).test(s)) || null;
}
function fileComment() {
  const m = /COMMENT '((?:[^']|'')*)'/.exec(alterSql() || '');
  return m ? m[1].replace(/''/g, "'") : null;
}

/** → { tableOk, present, problems } */
async function state(conn) {
  const problems = [];
  const [[e]] = await conn.query(s2.SQL.exists, [TABLE]);
  if (Number(e.n) === 0) return { tableOk: false, present: false, problems: [`${TABLE} is absent — run scripts/caseyV2ChatsMigrate.js first`] };
  const [cols] = await conn.query(s2.SQL.columns, [TABLE]);
  const names = cols.map((c) => c.name);
  const present = names.includes(COLUMN);
  const expected = Object.keys(s2.COLUMNS[TABLE]);
  const without = names.filter((n) => n !== COLUMN);
  if (without.join(',') !== expected.join(',')) problems.push(`${TABLE} columns (without ${COLUMN}) are (${without.join(', ')}), expected (${expected.join(', ')})`);
  if (present) {
    const c = cols.find((x) => x.name === COLUMN);
    const [type, nullable, dflt, coll, extra] = SHAPE;
    if (String(c.type).toLowerCase() !== type) problems.push(`${COLUMN} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) problems.push(`${COLUMN} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
    if ((c.dflt == null ? null : String(c.dflt)) !== dflt) problems.push(`${COLUMN} DEFAULT ${c.dflt}, expected ${dflt}`);
    if ((c.coll || null) !== coll) problems.push(`${COLUMN} collation ${c.coll || 'none'}, expected none`);
    if (String(c.extra || '') !== extra) problems.push(`${COLUMN} EXTRA "${c.extra}", expected ""`);
    if ((c.comment || '') !== (fileComment() || '')) problems.push(`${COLUMN} comment differs from the migration file`);
    if (names[names.indexOf(AFTER) + 1] !== COLUMN) problems.push(`${COLUMN} is not right after ${AFTER}`);
  }
  return { tableOk: true, present, problems };
}

/** CHECK (apply:false) or ALTER + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');
  if (!alterSql()) {
    const line = `NO-GO — ${path.basename(MIGRATION)} has no ALTER TABLE ${TABLE}. Nothing was changed.`;
    say(line);
    return { ok: false, line, applied: false };
  }
  let st = await state(conn);
  say(st.present ? `${TABLE}.${COLUMN}: present` : `${TABLE}.${COLUMN}: absent — to do: add`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: false };
  }
  if (!apply) {
    const line = st.present
      ? `CHECK OK — ${TABLE}.${COLUMN} is in place as expected. GO (nothing to apply; next: the deploy).`
      : 'CHECK OK — GO. Next: node scripts/caseyV2S3aMigrate.js --apply';
    say(line);
    return { ok: true, line, applied: false };
  }
  let applied = false;
  if (!st.present) {
    try { await conn.query(alterSql()); } catch (err) {
      const line = `NO-GO — ALTER TABLE ${TABLE} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied: false };
    }
    applied = true;
    say(`  ✓ added ${TABLE}.${COLUMN}`);
  }
  st = await state(conn);
  if (!st.present || st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: type, nullability, default, position and comment as in the migration file');
  const line = `${applied ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE}.${COLUMN} verified. GO. Next: the deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = { run, state, alterSql, fileComment, MIGRATION, TABLE, COLUMN, SHAPE };

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
      conn = mysql.createConnection({ host: process.env.host, user: process.env.user, password: process.env.password, database: process.env.database, timezone: 'Z', connectTimeout: 15_000 }).promise();
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
