#!/usr/bin/env node
// scripts/caseyV2S3cMigrate.js
//
/**
 * Casey v2 S3c — casey_card_steps.path_sent and .body_sent (what a step was
 * handed at claim once `$N.field` references were resolved), and the corrected
 * COMMENTs of `path` and `body` (S3b's wording became false with references —
 * MODIFY COLUMN, comment only, type and nullability unchanged). The statements,
 * comments included, are read from ref/migrations/2026-11-23_casey_v2_s3c_sent.sql
 * so the file and the applied schema can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/caseyV2S3cMigrate.js            # CHECK — read-only
 *   2. node scripts/caseyV2S3cMigrate.js --apply    # ALTER ×2, verify
 *   3. the S3c backend + frontend deploy (one land)
 *
 * CHECK (default), read-only: casey_card_steps exists with the S3b shape (the
 * S3b script's expectations, re-used, minus the two new columns) and each
 * column is absent (to do) or present with the expected type, nullability,
 * default, collation, position and comment (a re-run). Anything else is
 * NO-GO, nothing changed. --apply adds whichever is missing, in order, and
 * verifies; a failed run resumes from where it stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 5 — an ALTER on
 * a live table takes a metadata lock; 5 s caps a wait behind a running claim.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const s3b = require('./caseyV2S3bMigrate');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-23_casey_v2_s3c_sent.sql');
const TABLE = 'casey_card_steps';
/** name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA, AFTER] in file order. */
const COLUMNS = Object.freeze({
  path_sent: ['varchar(2000)', 'YES', null, 'utf8mb4_general_ci', '', 'body'],
  body_sent: ['longtext', 'YES', null, 'utf8mb4_bin', '', 'path_sent'],
});
const NAMES = Object.keys(COLUMNS);
/** The S3b columns whose COMMENT this migration rewrites (MODIFY COLUMN): the S3c file's comment is the expected one. */
const RECOMMENTED = ['path', 'body'];

function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}
function alterSql(col) {
  return statements().find((s) => new RegExp(`^ALTER TABLE ${TABLE}\\s+ADD COLUMN ${col}\\s`).test(s)) || null;
}
function modifySql(col) {
  return statements().find((s) => new RegExp(`^ALTER TABLE ${TABLE}\\s+MODIFY COLUMN ${col}\\s`).test(s)) || null;
}
function fileComment(col) {
  const m = /COMMENT '((?:[^']|'')*)'/.exec(alterSql(col) || modifySql(col) || '');
  return m ? m[1].replace(/''/g, "'") : null;
}

/** → { tableOk, present: {col → bool}, recomment: {col → bool (the comment is still S3b's)}, problems } */
async function state(conn) {
  const problems = [];
  const [[e]] = await conn.query(s3b.SQL.exists, [TABLE]);
  if (Number(e.n) === 0) return { tableOk: false, present: {}, recomment: {}, problems: [`${TABLE} is absent — run scripts/caseyV2S3bMigrate.js first`] };
  const [cols] = await conn.query(s3b.SQL.columns, [TABLE]);
  const names = cols.map((c) => c.name);
  const present = {}; for (const n of NAMES) present[n] = names.includes(n);
  const expected = Object.keys(s3b.COLUMNS[TABLE]);
  const without = names.filter((n) => !NAMES.includes(n));
  if (without.join(',') !== expected.join(',')) problems.push(`${TABLE} columns (without ${NAMES.join(' / ')}) are (${without.join(', ')}), expected (${expected.join(', ')})`);
  // The re-commented S3b columns: either S3b's comment (to do) or this file's (done); anything else is drift. Type and nullability must be S3b's.
  const s3bComments = s3b.fileComments(TABLE).cols;
  const recomment = {};
  for (const n of RECOMMENTED) {
    const c = cols.find((x) => x.name === n);
    if (!c) continue;   // reported above
    const [type, nullable, , coll] = s3b.COLUMNS[TABLE][n];
    if (String(c.type).toLowerCase() !== type || c.nullable !== nullable || (c.coll || null) !== coll) problems.push(`${n} is ${c.type} ${c.nullable} ${c.coll || 'none'}, expected ${type} ${nullable} ${coll || 'none'} (this migration changes its comment only)`);
    const now = c.comment || '';
    if (now === (fileComment(n) || '')) recomment[n] = false;
    else if (now === (s3bComments[n] || '')) recomment[n] = true;
    else problems.push(`${n} comment is neither S3b's nor this migration's`);
  }
  for (const n of NAMES) {
    if (!present[n]) continue;
    const c = cols.find((x) => x.name === n);
    const [type, nullable, dflt, coll, extra, after] = COLUMNS[n];
    if (String(c.type).toLowerCase() !== type) problems.push(`${n} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) problems.push(`${n} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
    if ((c.dflt == null ? null : String(c.dflt)) !== dflt) problems.push(`${n} DEFAULT ${c.dflt}, expected ${dflt}`);
    if ((c.coll || null) !== coll) problems.push(`${n} collation ${c.coll || 'none'}, expected ${coll || 'none'}`);
    if (String(c.extra || '') !== extra) problems.push(`${n} EXTRA "${c.extra}", expected ""`);
    if ((c.comment || '') !== (fileComment(n) || '')) problems.push(`${n} comment differs from the migration file`);
    if (names[names.indexOf(after) + 1] !== n) problems.push(`${n} is not right after ${after}`);
  }
  return { tableOk: true, present, recomment, problems };
}

/** CHECK (apply:false) or ALTER + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');
  for (const n of NAMES) {
    if (!alterSql(n)) {
      const line = `NO-GO — ${path.basename(MIGRATION)} has no ALTER TABLE ${TABLE} ADD COLUMN ${n}. Nothing was changed.`;
      say(line);
      return { ok: false, line, applied: false };
    }
  }
  for (const n of RECOMMENTED) {
    if (!modifySql(n)) {
      const line = `NO-GO — ${path.basename(MIGRATION)} has no ALTER TABLE ${TABLE} MODIFY COLUMN ${n}. Nothing was changed.`;
      say(line);
      return { ok: false, line, applied: false };
    }
  }
  let st = await state(conn);
  for (const n of NAMES) say(st.present[n] ? `${TABLE}.${n}: present` : `${TABLE}.${n}: absent — to do: add`);
  for (const n of RECOMMENTED) if (n in st.recomment) say(st.recomment[n] ? `${TABLE}.${n}: S3b comment — to do: re-comment` : `${TABLE}.${n}: comment current`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: false };
  }
  const missing = NAMES.filter((n) => !st.present[n]);
  const toRecomment = RECOMMENTED.filter((n) => st.recomment[n]);
  if (!apply) {
    const line = missing.length === 0 && toRecomment.length === 0
      ? `CHECK OK — ${TABLE}.${NAMES.join(' / ')} and the re-commented ${RECOMMENTED.join(' / ')} are in place as expected. GO (nothing to apply; next: the deploy).`
      : 'CHECK OK — GO. Next: node scripts/caseyV2S3cMigrate.js --apply';
    say(line);
    return { ok: true, line, applied: false };
  }
  let applied = false;
  for (const n of missing) {
    try { await conn.query(alterSql(n)); } catch (err) {
      const line = `NO-GO — ALTER TABLE ${TABLE} ADD COLUMN ${n} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied };
    }
    applied = true;
    say(`  ✓ added ${TABLE}.${n}`);
  }
  for (const n of toRecomment) {
    try { await conn.query(modifySql(n)); } catch (err) {
      const line = `NO-GO — ALTER TABLE ${TABLE} MODIFY COLUMN ${n} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied };
    }
    applied = true;
    say(`  ✓ re-commented ${TABLE}.${n}`);
  }
  st = await state(conn);
  if (NAMES.some((n) => !st.present[n]) || RECOMMENTED.some((n) => st.recomment[n]) || st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: type, nullability, default, collation, position and comment of both new columns, and the comments of path / body, as in the migration file');
  const line = `${applied ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE}.${NAMES.join(' / ')} verified. GO. Next: the deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = { run, state, alterSql, modifySql, fileComment, statements, MIGRATION, TABLE, COLUMNS, NAMES, RECOMMENTED };

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
