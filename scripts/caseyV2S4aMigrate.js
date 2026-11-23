#!/usr/bin/env node
// scripts/caseyV2S4aMigrate.js
//
/**
 * Casey v2 S4a — the casey_notes table (the pitfalls document the firm edits in
 * Admin → Casey Notes; services/casey/notes.js) and its seed. The CREATE
 * statement, comments included, is read from
 * ref/migrations/2026-11-23_casey_v2_s4a_notes.sql so the file and the applied
 * schema can never differ; the seed body is read from
 * ref/migrations/2026-11-23_casey_v2_s4a_notes_seed.md.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/caseyV2S4aMigrate.js            # CHECK — read-only
 *   2. node scripts/caseyV2S4aMigrate.js --apply    # CREATE, seed, verify
 *   3. the S4a backend + frontend deploy (one land)
 *
 * CHECK (default), read-only: the table is absent, or present with exactly the
 * expected shape (a re-run); and whether the `global` scope has a version.
 * Anything misshapen is NO-GO, nothing changed. --apply creates the table when
 * missing, inserts version 1 of `global` (author "seed") when that scope has
 * no row, and verifies the end state; a failed run resumes from where it
 * stopped. A later edit of the seed file changes nothing here: the seed is
 * written once, when the scope is empty — the firm's edits are the record.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 5. The table is
 * new, so no live table is locked; the setting is the house rule.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-23_casey_v2_s4a_notes.sql');
const SEED = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-23_casey_v2_s4a_notes_seed.md');
const GC = 'utf8mb4_general_ci';
const TABLE = 'casey_notes';
const SEED_SCOPE = 'global';
const SEED_AUTHOR = 'seed';
const SEED_NOTE = 'Seed (ref/migrations/2026-11-23_casey_v2_s4a_notes_seed.md)';

/** name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null, EXTRA] (file order). */
const COLUMNS = Object.freeze({
  id:          ['bigint unsigned', 'NO', null, null, 'auto_increment'],
  scope:       ['varchar(64)', 'NO', null, GC, ''],
  version:     ['int unsigned', 'NO', null, null, ''],
  body:        ['mediumtext', 'NO', null, GC, ''],
  edit_note:   ['varchar(300)', 'NO', null, GC, ''],
  author_id:   ['int', 'YES', null, null, ''],
  author_name: ['varchar(64)', 'NO', null, GC, ''],
  created_at:  ['datetime', 'NO', 'CURRENT_TIMESTAMP', null, 'DEFAULT_GENERATED'],
});
/** index name → [columns in order, unique]. */
const INDEXES = Object.freeze({
  PRIMARY:                       [['id'], true],
  uk_casey_notes_scope_version:  [['scope', 'version'], true],
});

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
  fks: `SELECT k.CONSTRAINT_NAME AS name
          FROM information_schema.KEY_COLUMN_USAGE k
         WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
  seedCount: 'SELECT COUNT(*) AS n FROM casey_notes WHERE scope = ?',
  seedInsert: 'INSERT INTO casey_notes (scope, version, body, edit_note, author_id, author_name) VALUES (?, 1, ?, ?, NULL, ?)',
});

/** The file's statements, in order, comment lines dropped. Each ends with ';' at END OF LINE — a COMMENT may hold ';' mid-line. */
function statements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}
function createSql() {
  return statements().find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${TABLE} \\(`).test(s)) || null;
}
/** Text as services/casey/notes.normalize stores it: LF line ends, trailing whitespace off every line (trimEnd — linear, never a `\s+$` regex), no trailing blank lines. */
function normalizeText(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
/** The seed body as services/casey/notes.js would store it. */
function seedBody() { return normalizeText(fs.readFileSync(SEED, 'utf8')); }

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
const normType = (t) => String(t || '').toLowerCase().replace(/\b(int|bigint|smallint|mediumint|tinyint)\(\d+\)/g, '$1');

/** → { exists, rows, seeded, problems } — a present table fully verified. */
async function state(conn) {
  const problems = [];
  const [[e]] = await conn.query(SQL.exists, [TABLE]);
  const exists = Number(e.n) > 0;
  if (!exists) return { exists, rows: 0, seeded: false, problems };

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

  const [idx] = await conn.query(SQL.indexes, [TABLE]);
  const by = new Map();
  for (const r of idx) {
    if (!by.has(r.name)) by.set(r.name, { cols: [], unique: Number(r.nonUnique) === 0 });
    by.get(r.name).cols.push(r.col);
  }
  for (const [name, def] of Object.entries(INDEXES)) {
    const got = by.get(name);
    if (!got) problems.push(`${TABLE}: index ${name} is missing`);
    else {
      if (got.cols.join(',') !== def[0].join(',')) problems.push(`${TABLE}: index ${name} is (${got.cols.join(', ')}), expected (${def[0].join(', ')})`);
      if (got.unique !== def[1]) problems.push(`${TABLE}: index ${name} is ${got.unique ? '' : 'not '}unique, expected ${def[1] ? '' : 'not '}unique`);
    }
  }
  for (const name of by.keys()) if (!(name in INDEXES)) problems.push(`${TABLE}: unexpected index ${name}`);
  const [fks] = await conn.query(SQL.fks, [TABLE]);
  for (const f of fks) problems.push(`${TABLE}: unexpected foreign key ${f.name}`);

  const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  const [[s]] = await conn.query(SQL.seedCount, [SEED_SCOPE]);
  return { exists, rows: Number(n.n), seeded: Number(s.n) > 0, problems };
}

/** CHECK (apply:false) or create + seed + verify (apply:true). → { ok, line, applied } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 5');

  if (!createSql()) {
    const line = `NO-GO — ${path.basename(MIGRATION)} has no CREATE TABLE IF NOT EXISTS ${TABLE}. Nothing was changed.`;
    say(line);
    return { ok: false, line, applied: false };
  }
  let seed;
  try { seed = seedBody(); } catch (e) { seed = ''; }
  if (!seed) {
    const line = `NO-GO — ${path.basename(SEED)} is missing or empty. Nothing was changed.`;
    say(line);
    return { ok: false, line, applied: false };
  }

  let st = await state(conn);
  say(st.exists ? `${TABLE}: present, ${st.rows} row(s); ${SEED_SCOPE}: ${st.seeded ? 'has a version' : 'no version — to do: seed'}` : `${TABLE}: absent — to do: create, then seed ${SEED_SCOPE}`);
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, applied: false };
  }

  if (!apply) {
    const line = st.exists && st.seeded
      ? `CHECK OK — ${TABLE} is in place and ${SEED_SCOPE} has a version. GO (nothing to apply; next: the deploy).`
      : 'CHECK OK — GO. Next: node scripts/caseyV2S4aMigrate.js --apply';
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
      return { ok: false, line, applied };
    }
    applied = true;
    say(`  ✓ created ${TABLE}`);
  }
  if (!st.seeded) {
    try {
      await conn.query(SQL.seedInsert, [SEED_SCOPE, seed, SEED_NOTE, SEED_AUTHOR]);
    } catch (err) {
      const line = `NO-GO — the seed INSERT failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes from here).`;
      say(line);
      return { ok: false, line, applied };
    }
    applied = true;
    say(`  ✓ seeded ${SEED_SCOPE} version 1 (${seed.length} characters, author ${SEED_AUTHOR})`);
  }

  st = await state(conn);
  if (!st.exists || !st.seeded || st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    if (!st.exists) say(`  ✗ ${TABLE} still absent`);
    if (!st.seeded) say(`  ✗ ${SEED_SCOPE} still has no version`);
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, applied };
  }
  say('  ✓ verified: columns, types, nullability, defaults, collations, comments and keys as in the migration file; the global scope has a version');
  const line = `${applied ? 'APPLIED' : 'ALREADY IN PLACE'} — ${TABLE} verified. GO. Next: the deploy.`;
  say(line);
  return { ok: true, line, applied };
}

module.exports = { run, state, statements, createSql, seedBody, normalizeText, fileComments, MIGRATION, SEED, TABLE, SEED_SCOPE, SEED_AUTHOR, SEED_NOTE, COLUMNS, INDEXES, SQL };

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
