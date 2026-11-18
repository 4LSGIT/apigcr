#!/usr/bin/env node
// scripts/keyRenewalRequestsMigrate.js
//
/**
 * key-renew-req S1 — the key_renewal_requests table (session-key renewal
 * requests; routes/api.keyRenewalRequests.js). The statement, comments
 * included, is read from ref/migrations/2026-11-19_key_renewal_requests.sql so
 * the file and the applied schema can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/keyRenewalRequestsMigrate.js            # CHECK — read-only
 *   2. node scripts/keyRenewalRequestsMigrate.js --apply    # CREATE, verify
 *   3. backend + frontend deploy (one land)
 *
 * CHECK (default), read-only: readonly_api_keys.id is the int the FK needs;
 * the table is absent, or present with exactly the expected shape (a re-run).
 * Anything misshapen is NO-GO, nothing changed.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 5 — the FK
 * takes a shared metadata lock on live readonly_api_keys while the CREATE
 * runs; an MDL queued behind a long transaction would stall the auth lookup
 * of every session key, so 5 s caps it and the run resumes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-19_key_renewal_requests.sql');
const GC = 'utf8mb4_general_ci';
const TABLE = 'key_renewal_requests';

/** name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA] (file order). */
const COLUMNS = Object.freeze({
  id:                ['int', 'NO', null, null, 'auto_increment'],
  key_id:            ['int', 'NO', null, null, ''],
  reason:            ['varchar(200)', 'NO', null, GC, ''],
  requested_ttl_min: ['int', 'YES', null, null, ''],
  notify_user:       ['int', 'NO', null, null, ''],
  key_expires_at:    ['datetime', 'NO', null, null, ''],
  status:            ['varchar(16)', 'NO', 'pending', GC, ''],
  requested_at:      ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED'],
  request_ip:        ['varchar(64)', 'YES', null, GC, ''],
  user_agent:        ['varchar(255)', 'YES', null, GC, ''],
  email_error:       ['varchar(500)', 'YES', null, GC, ''],
  decided_by:        ['int', 'YES', null, null, ''],
  decided_at:        ['datetime', 'YES', null, null, ''],
  granted_ttl_min:   ['int', 'YES', null, null, ''],
  new_expires_at:    ['datetime', 'YES', null, null, ''],
  pending_key:       ['int', 'YES', null, null, 'STORED GENERATED'],
});
/** index name → [columns in order, unique]. */
const INDEXES = Object.freeze({
  PRIMARY:        [['id'], true],
  uk_krr_pending: [['pending_key'], true],
  idx_krr_key:    [['key_id', 'requested_at'], false],
  idx_krr_status: [['status', 'requested_at'], false],
  fk_krr_key:     null,   // InnoDB reuses idx_krr_key for the FK; tolerated if a server adds it
});

const SQL = Object.freeze({
  exists: 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  table: `SELECT TABLE_COLLATION AS coll, TABLE_COMMENT AS comment FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, EXTRA AS extra, COLUMN_COMMENT AS comment,
                   GENERATION_EXPRESSION AS gen
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  indexes: `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq, NON_UNIQUE AS nonUnique
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
  fk: `SELECT REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol, COLUMN_NAME AS col
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'fk_krr_key'`,
  parentId: `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'readonly_api_keys' AND COLUMN_NAME = 'id'`,
});

/** The file's one statement. Ends with ';' at END OF LINE — a COMMENT may hold ';' mid-line. */
function createSql() {
  const stmts = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  return stmts.find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${TABLE} \\(`).test(s)) || null;
}

const unq = (s) => s.replace(/''/g, "'");

/** The file's comments: { cols: { col → comment }, table }. */
function fileComments() {
  const cols = {};
  const create = createSql() || '';
  for (const line of create.split('\n')) {
    const m = /^\s+(\w+)\s+/.exec(line);
    if (!m || !COLUMNS[m[1]]) continue;
    const c = /COMMENT '((?:[^']|'')*)',?\s*$/.exec(line.trim());
    cols[m[1]] = c ? unq(c[1]) : '';
  }
  const t = /COMMENT='((?:[^']|'')*)'\s*;?\s*$/.exec(create);
  return { cols, table: t ? unq(t[1]) : null };
}

/** MySQL 8 reports `int(11)` on some servers and `int` on others. */
const normType = (t) => String(t || '').toLowerCase().replace(/\b(int|bigint|smallint|mediumint)\(\d+\)/g, '$1');

/** → { exists, rows, problems } — a present table fully verified. */
async function state(conn) {
  const problems = [];
  const [[p]] = await conn.query(SQL.parentId);
  if (!p) problems.push('readonly_api_keys.id is missing — the FK target');
  else if (normType(p.type) !== 'int') problems.push(`readonly_api_keys.id is ${p.type}, expected int (the FK needs the same type)`);

  const [[e]] = await conn.query(SQL.exists, [TABLE]);
  const exists = Number(e.n) > 0;
  if (!exists) return { exists, rows: 0, problems };

  const fc = fileComments();
  const [[t]] = await conn.query(SQL.table, [TABLE]);
  if (t.coll !== GC) problems.push(`${TABLE} collation ${t.coll}, expected ${GC}`);
  if (t.comment !== fc.table) problems.push(`${TABLE} table comment differs from the migration file`);

  const [cols] = await conn.query(SQL.columns, [TABLE]);
  const names = cols.map((c) => c.name);
  const wanted = Object.keys(COLUMNS);
  if (names.join(',') !== wanted.join(',')) problems.push(`${TABLE} columns are (${names.join(', ')}), expected (${wanted.join(', ')})`);
  for (const c of cols) {
    const def = COLUMNS[c.name];
    if (!def) continue;
    const [type, nullable, dflt, coll, extra] = def;
    const w = `${TABLE}.${c.name}`;
    if (normType(c.type) !== type) problems.push(`${w} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) problems.push(`${w} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
    if ((c.dflt == null ? null : String(c.dflt)) !== dflt) problems.push(`${w} DEFAULT ${c.dflt}, expected ${dflt}`);
    if ((c.coll || null) !== coll) problems.push(`${w} collation ${c.coll || 'none'}, expected ${coll || 'none'}`);
    if (String(c.extra || '') !== extra) problems.push(`${w} EXTRA "${c.extra}", expected "${extra}"`);
    if ((c.comment || '') !== (fc.cols[c.name] || '')) problems.push(`${w} comment differs from the migration file`);
  }
  const gen = cols.find((c) => c.name === 'pending_key');
  // MySQL 8.4 stores it as if((`status` = _utf8mb4\'pending\'),`key_id`,NULL): compare without
  // quoting, the charset introducer, backslashes and spaces — exactly, not by pattern.
  const genNorm = String(gen ? gen.gen || '' : '').replace(/[`\\\s]/g, '').replace(/_utf8mb4'/g, "'").toLowerCase();
  if (gen && genNorm !== "if((status='pending'),key_id,null)") {
    problems.push(`${TABLE}.pending_key is generated as ${gen.gen}, expected if(status = 'pending', key_id, NULL)`);
  }

  const [idx] = await conn.query(SQL.indexes, [TABLE]);
  const by = new Map();
  for (const r of idx) {
    if (!by.has(r.name)) by.set(r.name, { cols: [], unique: Number(r.nonUnique) === 0 });
    by.get(r.name).cols.push(r.col);
  }
  for (const [name, def] of Object.entries(INDEXES)) {
    if (def === null) continue;
    const got = by.get(name);
    if (!got) problems.push(`index ${name} is missing`);
    else {
      if (got.cols.join(',') !== def[0].join(',')) problems.push(`index ${name} is (${got.cols.join(', ')}), expected (${def[0].join(', ')})`);
      if (got.unique !== def[1]) problems.push(`index ${name} is ${got.unique ? '' : 'not '}unique, expected ${def[1] ? '' : 'not '}unique`);
    }
  }
  for (const name of by.keys()) if (!(name in INDEXES)) problems.push(`unexpected index ${name}`);

  const [fk] = await conn.query(SQL.fk, [TABLE]);
  if (fk.length !== 1 || fk[0].refTable !== 'readonly_api_keys' || fk[0].refCol !== 'id' || fk[0].col !== 'key_id') {
    problems.push('foreign key fk_krr_key (key_id → readonly_api_keys.id) is missing or different');
  }

  const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  return { exists, rows: Number(n.n), problems };
}

/** CHECK (apply:false) or create + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');

  if (!createSql()) {
    const line = `NO-GO — ${path.basename(MIGRATION)} has no CREATE TABLE IF NOT EXISTS ${TABLE}. Nothing was changed.`;
    say(line);
    return { ok: false, line, applied: false };
  }

  let st = await state(conn);
  say(st.exists ? `${TABLE}: present, ${st.rows} row(s)` : `${TABLE}: absent — to do: create`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: false };
  }

  if (!apply) {
    const line = st.exists
      ? `CHECK OK — ${TABLE} is in place as expected. GO (nothing to apply; next: the deploy).`
      : 'CHECK OK — GO. Next: node scripts/keyRenewalRequestsMigrate.js --apply';
    say(line);
    return { ok: true, line, applied: false };
  }

  let applied = false;
  if (!st.exists) {
    try {
      await conn.query(createSql());
    } catch (err) {
      const line = `NO-GO — CREATE TABLE ${TABLE} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied: false };
    }
    applied = true;
    say(`  ✓ created ${TABLE}`);
  }

  st = await state(conn);
  if (!st.exists || st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    if (!st.exists) say(`  ✗ ${TABLE} still absent`);
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: columns, types, nullability, defaults, collations, comments, the generated column, keys and the FK as in the migration file');
  const line = `${applied ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE} verified. GO. Next: the deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = { run, state, createSql, fileComments, MIGRATION, TABLE, COLUMNS, INDEXES, SQL };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

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
