#!/usr/bin/env node
// scripts/caseyV2ChatsMigrate.js
//
/**
 * Casey v2 S2 — the casey_chats and casey_messages tables (the tool-use
 * loop's transcripts; services/casey/chats.js). The statements, comments
 * included, are read from ref/migrations/2026-11-22_casey_v2_chats.sql so the
 * file and the applied schema can never differ.
 *
 * SUPERSEDED FOR CHECK by scripts/caseyV2S3aMigrate.js (S3a added
 * casey_chats.stop_requested_at): on a database past S3a this script's CHECK
 * reports that column as drift. Its --apply is still the S2 creation step on an
 * empty database (the twin runs it first, then the S3a script).
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/caseyV2ChatsMigrate.js            # CHECK — read-only
 *   2. node scripts/caseyV2ChatsMigrate.js --apply    # CREATE both, verify
 *   3. the S2 backend deploy (land)
 *
 * CHECK (default), read-only: each table is absent, or present with exactly
 * the expected shape (a re-run). Anything misshapen is NO-GO, nothing changed.
 * --apply creates whichever is missing, in order (casey_messages carries the
 * FK), and verifies the end state; a failed run resumes from where it stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 5. Both tables
 * are new, so no live table is locked; the setting is the house rule.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-22_casey_v2_chats.sql');
const GC = 'utf8mb4_general_ci';
const TABLES = ['casey_chats', 'casey_messages'];

/** table → name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA] (file order). */
const COLUMNS = Object.freeze({
  casey_chats: Object.freeze({
    id:             ['bigint unsigned', 'NO', null, null, 'auto_increment'],
    user_id:        ['int', 'NO', null, null, ''],
    title:          ['varchar(120)', 'NO', null, GC, ''],
    model:          ['varchar(64)', 'NO', null, GC, ''],
    effort:         ['varchar(16)', 'NO', null, GC, ''],
    prompt_version: ['varchar(32)', 'NO', null, GC, ''],
    thinking_floor_seq: ['int', 'NO', '0', null, ''],
    running_since:  ['datetime', 'YES', null, null, ''],
    created_at:     ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED'],
    updated_at:     ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'],
  }),
  casey_messages: Object.freeze({
    id:         ['bigint unsigned', 'NO', null, null, 'auto_increment'],
    chat_id:    ['bigint unsigned', 'NO', null, null, ''],
    seq:        ['int', 'NO', null, null, ''],
    role:       ["enum('user','assistant')", 'NO', null, GC, ''],
    content:    ['longtext', 'NO', null, 'utf8mb4_bin', ''],
    meta:       ['json', 'YES', null, null, ''],
    created_at: ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED'],
  }),
});
/** table → index name → [columns in order, unique]. */
const INDEXES = Object.freeze({
  casey_chats: Object.freeze({
    PRIMARY:              [['id'], true],
    idx_casey_chats_user: [['user_id', 'updated_at'], false],
  }),
  casey_messages: Object.freeze({
    PRIMARY:               [['id'], true],
    uk_casey_messages_seq: [['chat_id', 'seq'], true],
  }),
});
const FK = Object.freeze({ table: 'casey_messages', name: 'fk_casey_messages_chat', col: 'chat_id', refTable: 'casey_chats', refCol: 'id', onDelete: 'CASCADE' });

const SQL = Object.freeze({
  exists: 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  table: `SELECT TABLE_COLLATION AS coll, TABLE_COMMENT AS comment FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, EXTRA AS extra, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  indexes: `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq, NON_UNIQUE AS nonUnique
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
  fk: `SELECT k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, r.DELETE_RULE AS onDelete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.CONSTRAINT_NAME = ?`,
  fkAll: `SELECT CONSTRAINT_NAME AS name FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
});

/** The file's statements, in order, comment lines dropped. Each ends with ';' at END OF LINE — a COMMENT may hold ';' mid-line. */
function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}
function createSql(table) {
  return statements().find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${table} \\(`).test(s)) || null;
}

const unq = (s) => s.replace(/''/g, "'");

/** The file's comments for a table: { cols: { col → comment }, table }. */
function fileComments(table) {
  const cols = {};
  const create = createSql(table) || '';
  for (const line of create.split('\n')) {
    const m = /^\s+(\w+)\s+/.exec(line);
    if (!m || !COLUMNS[table][m[1]]) continue;
    const c = /COMMENT '((?:[^']|'')*)',?\s*$/.exec(line.trim());
    cols[m[1]] = c ? unq(c[1]) : '';
  }
  const t = /COMMENT='((?:[^']|'')*)'\s*;?\s*$/.exec(create);
  return { cols, table: t ? unq(t[1]) : null };
}

/** MySQL 8 reports `int(11)` on some servers and `int` on others. */
const normType = (t) => String(t || '').toLowerCase().replace(/\b(int|bigint|smallint|mediumint)\(\d+\)/g, '$1');

/** → { exists, rows, problems } for one table — a present table fully verified. */
async function tableState(conn, table) {
  const problems = [];
  const [[e]] = await conn.query(SQL.exists, [table]);
  const exists = Number(e.n) > 0;
  if (!exists) return { exists, rows: 0, problems };

  const fc = fileComments(table);
  const [[t]] = await conn.query(SQL.table, [table]);
  if (t.coll !== GC) problems.push(`${table} collation ${t.coll}, expected ${GC}`);
  if (t.comment !== fc.table) problems.push(`${table} table comment differs from the migration file`);

  const [cols] = await conn.query(SQL.columns, [table]);
  const names = cols.map((c) => c.name);
  const wanted = Object.keys(COLUMNS[table]);
  if (names.join(',') !== wanted.join(',')) problems.push(`${table} columns are (${names.join(', ')}), expected (${wanted.join(', ')})`);
  for (const c of cols) {
    const def = COLUMNS[table][c.name];
    if (!def) continue;
    const [type, nullable, dflt, coll, extra] = def;
    const w = `${table}.${c.name}`;
    if (normType(c.type) !== type) problems.push(`${w} is ${c.type}, expected ${type}`);
    if (c.nullable !== nullable) problems.push(`${w} IS_NULLABLE ${c.nullable}, expected ${nullable}`);
    if ((c.dflt == null ? null : String(c.dflt)) !== dflt) problems.push(`${w} DEFAULT ${c.dflt}, expected ${dflt}`);
    if ((c.coll || null) !== coll) problems.push(`${w} collation ${c.coll || 'none'}, expected ${coll || 'none'}`);
    if (String(c.extra || '') !== extra) problems.push(`${w} EXTRA "${c.extra}", expected "${extra}"`);
    if ((c.comment || '') !== (fc.cols[c.name] || '')) problems.push(`${w} comment differs from the migration file`);
  }

  const [idx] = await conn.query(SQL.indexes, [table]);
  const by = new Map();
  for (const r of idx) {
    if (!by.has(r.name)) by.set(r.name, { cols: [], unique: Number(r.nonUnique) === 0 });
    by.get(r.name).cols.push(r.col);
  }
  for (const [name, def] of Object.entries(INDEXES[table])) {
    const got = by.get(name);
    if (!got) problems.push(`${table}: index ${name} is missing`);
    else {
      if (got.cols.join(',') !== def[0].join(',')) problems.push(`${table}: index ${name} is (${got.cols.join(', ')}), expected (${def[0].join(', ')})`);
      if (got.unique !== def[1]) problems.push(`${table}: index ${name} is ${got.unique ? '' : 'not '}unique, expected ${def[1] ? '' : 'not '}unique`);
    }
  }
  for (const name of by.keys()) if (!(name in INDEXES[table])) problems.push(`${table}: unexpected index ${name}`);

  const [fks] = await conn.query(SQL.fkAll, [table]);
  if (table === FK.table) {
    const [fk] = await conn.query(SQL.fk, [table, FK.name]);
    if (fk.length !== 1 || fk[0].col !== FK.col || fk[0].refTable !== FK.refTable || fk[0].refCol !== FK.refCol || fk[0].onDelete !== FK.onDelete) {
      problems.push(`foreign key ${FK.name} (${FK.col} → ${FK.refTable}.${FK.refCol} ON DELETE ${FK.onDelete}) is missing or different`);
    }
    for (const f of fks) if (f.name !== FK.name) problems.push(`${table}: unexpected foreign key ${f.name}`);
  } else if (fks.length) {
    problems.push(`${table}: unexpected foreign key ${fks.map((f) => f.name).join(', ')}`);
  }

  const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return { exists, rows: Number(n.n), problems };
}

/** → { tables: { name → tableState }, problems } */
async function state(conn) {
  const out = { tables: {}, problems: [] };
  for (const t of TABLES) {
    out.tables[t] = await tableState(conn, t);
    out.problems.push(...out.tables[t].problems);
  }
  if (out.tables.casey_messages.exists && !out.tables.casey_chats.exists) out.problems.push('casey_messages exists without casey_chats (its FK target)');
  return out;
}

/** CHECK (apply:false) or create + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');

  for (const t of TABLES) {
    if (!createSql(t)) {
      const line = `NO-GO — ${path.basename(MIGRATION)} has no CREATE TABLE IF NOT EXISTS ${t}. Nothing was changed.`;
      say(line);
      return { ok: false, line, applied: false };
    }
  }

  let st = await state(conn);
  for (const t of TABLES) say(st.tables[t].exists ? `${t}: present, ${st.tables[t].rows} row(s)` : `${t}: absent — to do: create`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: false };
  }
  const missing = TABLES.filter((t) => !st.tables[t].exists);

  if (!apply) {
    const line = missing.length === 0
      ? 'CHECK OK — casey_chats and casey_messages are in place as expected. GO (nothing to apply; next: the deploy).'
      : 'CHECK OK — GO. Next: node scripts/caseyV2ChatsMigrate.js --apply';
    say(line);
    return { ok: true, line, applied: false };
  }

  let applied = false;
  for (const t of missing) {
    try {
      await conn.query(createSql(t));
    } catch (err) {
      const line = `NO-GO — CREATE TABLE ${t} failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied };
    }
    applied = true;
    say(`  ✓ created ${t}`);
  }

  st = await state(conn);
  const absent = TABLES.filter((t) => !st.tables[t].exists);
  if (absent.length || st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    absent.forEach((t) => say(`  ✗ ${t} still absent`));
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: columns, types, nullability, defaults, collations, comments, keys and the FK of both tables as in the migration file');
  const line = `${applied ? 'APPLIED' : 'ALREADY IN PLACE'} — casey_chats and casey_messages verified. GO. Next: the deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = { run, state, tableState, statements, createSql, fileComments, MIGRATION, TABLES, COLUMNS, INDEXES, FK, SQL };

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
