#!/usr/bin/env node
// scripts/apptLengthSmallint.js
//
/**
 * Widen appts.appt_length from a SIGNED TINYINT to SMALLINT.
 *
 * WHY. A signed tinyint holds -128..127. Production's sql_mode is relaxed (no
 * STRICT_TRANS_TABLES — CLAUDE.md "SQL mode is relaxed"), so an INSERT or
 * UPDATE of a longer length does not fail: MySQL stores 127 and raises only a
 * warning nobody reads. A 180-minute appointment would be saved, synced and
 * confirmed as 127 minutes, and its STORED generated `appt_end` with it.
 * Proved on MySQL 8.4.11 under the production sql_mode (2026-10-28). Nothing
 * is corrupted today — the longest length ever stored is 90 — so this only
 * widens the column. The applied SQL is recorded in
 * ref/migrations/2026-10-28_appt_length_smallint.sql.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production —
 * the same setup `npm run db:ref` uses; the Cloud SQL proxy is started if
 * .env opts in):
 *
 *   node scripts/apptLengthSmallint.js           # CHECK — read-only, prints the plan
 *   node scripts/apptLengthSmallint.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time, and on a column that is
 * already the widened one it changes nothing and says GO.
 *
 * DRY-RUN AGAINST A SCRATCH DATABASE (the gate on the ALTER's exact text):
 *
 *   APPT_LENGTH_DB_URL=mysql://root@127.0.0.1:3378/yc_x_test node scripts/apptLengthSmallint.js --apply
 *
 * APPT_LENGTH_DB_URL replaces the .env connection entirely (the proxy is not
 * touched). It exists ONLY for that dry-run, so it refuses a database whose
 * name does not end in `_test`. Load ref/database.sql into it first.
 *
 * ── WHY A NODE SCRIPT ON ONE CONNECTION (not the SU console) ──────────────
 * /admin/db/batch runs each statement on whichever pooled connection is free,
 * so a SESSION setting cannot reach the statement it is meant for. This needs
 * one: lock_wait_timeout = 10. The ALTER takes an exclusive metadata lock at
 * its start and end; one queued behind a long transaction blocks EVERY new
 * query on appts for as long as it waits, and the global default is a year.
 * With 10 s it gives up instead, changes nothing, and --apply can be re-run.
 *
 * ── WHAT THE ALTER DOES ───────────────────────────────────────────────────
 * A type change cannot run in place: it is ALGORITHM=COPY, LOCK=SHARED —
 * appts stays readable, writes wait for the copy (a few thousand rows:
 * seconds). The STORED generated column `appt_end` (appt_date + interval
 * appt_length minute) is recomputed during the copy; every value fits, so it
 * comes out identical, and that is verified (count + checksum before/after).
 * NULL-ness and default are read from the live column and restated
 * unchanged; only the type and the comment change. The ALTER is atomic: if it
 * fails, the table is as it was.
 *
 * The session sql_mode is reported, not changed. A widening cannot fail on
 * appt_length values; a STRICT session could only make the copy refuse some
 * other column's legacy value, and then the atomic ALTER changes nothing
 * (seen on 8.4.11: a zero appt_date row refuses a COPY under STRICT; the
 * production session — relaxed, inherited from the global — copies it).
 *
 * ── TIME LIMITS ───────────────────────────────────────────────────────────
 * Every statement carries a client-side timeout (30 s reads, 300 s for the
 * ALTER). A client timeout does NOT stop an ALTER already running on the
 * server: on that NO-GO, re-run the CHECK — it reports what the column is.
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - appts.appt_length exists and is EXACTLY a signed tinyint with no
 *     comment (or EXACTLY the widened column — then nothing to do);
 *   - appt_end is still the STORED column generated from it;
 *   - the stored values all fit (they always do in a tinyint; asserted anyway).
 * Any other state is a NO-GO naming what it found.
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   the column is smallint with the same NULL-ness, default and position and
 *   the new comment; appt_end's expression is unchanged; row count and the
 *   appt_length / appt_end checksums are identical. Then — and only then —
 *   land and deploy the backend that drops the 127 guard (SQL → backend).
 *
 * ── ROLLBACK (not expected) ───────────────────────────────────────────────
 *   see the ROLLBACK section of the migration file.
 */

'use strict';

const TABLE = 'appts';
const COLUMN = 'appt_length';
const GENERATED = 'appt_end';
const COMMENT = 'minutes; smallint since 2026-10-28 — was signed tinyint, relaxed sql_mode clamped >127 to 127 silently';

const QUERY_TIMEOUT_MS = 30_000;
const DDL_TIMEOUT_MS = 300_000;
const LOCK_WAIT_S = 10;

const sqlString = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";

/** The ALTER, from the live column's NULL-ness and default — only type and comment change. */
function alterSql(col) {
  const nullable = col.is_nullable === 'YES';
  let def = '';
  if (col.column_default === null) def = nullable ? ' DEFAULT NULL' : '';
  else def = ' DEFAULT ' + sqlString(col.column_default);
  return `ALTER TABLE \`${TABLE}\` MODIFY \`${COLUMN}\` smallint ${nullable ? 'NULL' : 'NOT NULL'}${def} ` +
    `COMMENT ${sqlString(COMMENT)}, ALGORITHM=COPY, LOCK=SHARED`;
}

/** One timed query; returns rows. */
async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const [who] = await q(conn,
    '/* alen:who */ SELECT CURRENT_USER() AS cu, @@SESSION.sql_mode AS sm, DATABASE() AS db, VERSION() AS v');

  const cols = await q(conn,
    '/* alen:columns */ SELECT COLUMN_NAME AS name, COLUMN_TYPE AS column_type, DATA_TYPE AS data_type, ' +
    'IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COLUMN_COMMENT AS column_comment, ' +
    'EXTRA AS extra, GENERATION_EXPRESSION AS gen, ORDINAL_POSITION AS pos ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?)',
    [TABLE, COLUMN, GENERATED]);
  const col = cols.find((c) => c.name === COLUMN) || null;
  const gen = cols.find((c) => c.name === GENERATED) || null;

  let stats = null;
  if (col) {
    const [r] = await q(conn,
      `/* alen:stats */ SELECT COUNT(*) AS n, COUNT(\`${COLUMN}\`) AS filled, MIN(\`${COLUMN}\`) AS mn, ` +
      `MAX(\`${COLUMN}\`) AS mx, COALESCE(SUM(\`${COLUMN}\` = 127), 0) AS at127, ` +
      `COALESCE(SUM(\`${COLUMN}\`), 0) AS total, ` +
      `COALESCE(BIT_XOR(CRC32(CONCAT(appt_id, ':', COALESCE(\`${COLUMN}\`, 'N')))), 0) AS x_len, ` +
      (gen ? `COALESCE(BIT_XOR(CRC32(CONCAT(appt_id, ':', COALESCE(\`${GENERATED}\`, 'N')))), 0) AS x_end ` : '0 AS x_end ') +
      `FROM \`${TABLE}\``);
    stats = {
      n: Number(r.n), filled: Number(r.filled), min: r.mn == null ? null : Number(r.mn),
      max: r.mx == null ? null : Number(r.mx), at127: Number(r.at127), total: String(r.total),
      x_len: String(r.x_len), x_end: String(r.x_end),
    };
  }

  // Anything stored in the schema that names the column (a trigger or routine
  // declaring a TINYINT it copies the length into would still clamp).
  // Matched in JS: information_schema text columns carry mixed collations.
  const NAME_RE = /(^|[^A-Za-z0-9_])appt_length([^A-Za-z0-9_]|$)/i;
  const objs = [
    ...(await q(conn, "/* alen:refs */ SELECT 'trigger' AS kind, TRIGGER_NAME AS name, ACTION_STATEMENT AS def FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()")),
    ...(await q(conn, "/* alen:refs */ SELECT 'view' AS kind, TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()")),
    ...(await q(conn, "/* alen:refs */ SELECT 'routine' AS kind, ROUTINE_NAME AS name, ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()")),
    ...(await q(conn, "/* alen:refs */ SELECT 'event' AS kind, EVENT_NAME AS name, EVENT_DEFINITION AS def FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()")),
  ];
  const refs = objs.filter((o) => NAME_RE.test(String(o.def || ''))).map((o) => `${o.kind} ${o.name}`);

  return { user: who.cu, sessionMode: who.sm, db: who.db, version: who.v, col, gen, stats, refs };
}

// ─────────────────────────────────────────────────────────────
// Deciding — pure, so the tests can drive every branch
// ─────────────────────────────────────────────────────────────

const isOldType = (c) => /^tinyint(\(\d+\))?$/i.test(String(c.column_type));
const isNewType = (c) => /^smallint(\(\d+\))?$/i.test(String(c.column_type));

/** @returns {{ problems: string[], notes: string[], done: boolean, sql: string|null }} */
function plan(s) {
  const problems = [];
  const notes = [];
  const c = s.col;
  if (!c) return { problems: [`${TABLE}.${COLUMN} does not exist`], notes, done: false, sql: null };

  const done = isNewType(c) && c.column_comment === COMMENT;
  if (!done) {
    if (!isOldType(c)) problems.push(`${TABLE}.${COLUMN} is "${c.column_type}", expected a SIGNED tinyint — someone changed it since 2026-10-28; look before going on`);
    if (c.column_comment !== '') problems.push(`${TABLE}.${COLUMN} carries a comment ("${c.column_comment}") the MODIFY would overwrite — fold it into COMMENT here first`);
    if (c.extra !== '') problems.push(`${TABLE}.${COLUMN} has EXTRA "${c.extra}" that the MODIFY does not restate`);
  }
  if (!s.gen) problems.push(`${TABLE}.${GENERATED} is missing`);
  else if (!/STORED GENERATED/i.test(String(s.gen.extra)) || !/appt_length/i.test(String(s.gen.gen))) {
    problems.push(`${TABLE}.${GENERATED} is no longer the STORED column generated from ${COLUMN} ("${s.gen.extra}", "${s.gen.gen}")`);
  }
  if (s.stats && s.stats.max != null && (s.stats.max > 32767 || s.stats.min < -32768)) {
    problems.push(`stored lengths ${s.stats.min}..${s.stats.max} do not fit a smallint`);
  }
  if (s.stats && s.stats.at127 > 0) {
    notes.push(`${s.stats.at127} row(s) hold exactly 127 — possibly a longer length clamped before this fix; the real length is not recoverable from the row`);
  }
  for (const r of s.refs) notes.push(`${r} names ${COLUMN} — widening does not change it; check it holds no tinyint of its own`);
  return { problems, notes, done, sql: done ? null : alterSql(c) };
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

const CMD = 'node scripts/apptLengthSmallint.js';

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== appts.appt_length tinyint → smallint — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}; session sql_mode "${s.sessionMode}"`);
  if (s.col) {
    say(`${TABLE}.${COLUMN}: ${s.col.column_type}, ${s.col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}, ` +
      `default ${s.col.column_default === null ? 'NULL' : JSON.stringify(s.col.column_default)}, ` +
      `comment ${JSON.stringify(s.col.column_comment)}, position ${s.col.pos}`);
  }
  if (s.gen) say(`${TABLE}.${GENERATED}: ${s.gen.column_type} ${s.gen.extra} AS ${s.gen.gen}`);
  if (s.stats) {
    say(`rows ${s.stats.n}; ${COLUMN} filled ${s.stats.filled}, NULL ${s.stats.n - s.stats.filled}, ` +
      `min ${s.stats.min}, max ${s.stats.max}, at 127: ${s.stats.at127}; ` +
      `checksums ${COLUMN} ${s.stats.x_len} / ${GENERATED} ${s.stats.x_end}`);
  }
  say(`schema objects naming ${COLUMN}: ${s.refs.length ? s.refs.join(', ') : 'none'}`);

  const p = plan(s);
  for (const n of p.notes) say(`note: ${n}`);
  if (p.problems.length) {
    say('\nPROBLEMS:');
    for (const x of p.problems) say(`  - ${x}`);
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed.`;
    say(`\n${line}`);
    return { ok: false, line, state: s };
  }
  if (p.done) {
    const line = 'ALREADY APPLIED — appts.appt_length is the widened smallint; nothing to do. GO: land the backend.';
    say(`\n${line}`);
    return { ok: true, line, state: s, done: true };
  }

  say('\nPLAN:');
  say(`  1. SET SESSION lock_wait_timeout = ${LOCK_WAIT_S}`);
  say(`  2. ${p.sql}`);
  say('  then: re-read the column, appt_end and both checksums, and verify');

  if (!apply) {
    const line = `CHECK OK — GO. Next: ${CMD} --apply`;
    say(`\n${line}`);
    return { ok: true, line, state: s, sql: p.sql };
  }

  // ── apply ──
  say('');
  let altered = false;
  try {
    await q(conn, `SET SESSION lock_wait_timeout = ${LOCK_WAIT_S}`);
    const [{ lw }] = await q(conn, '/* alen:lockwait */ SELECT @@SESSION.lock_wait_timeout AS lw');
    if (Number(lw) !== LOCK_WAIT_S) throw new Error(`lock_wait_timeout is ${lw} on this session, expected ${LOCK_WAIT_S} — not running the ALTER`);
    await q(conn, p.sql, [], DDL_TIMEOUT_MS);
    altered = true;
    say(`  ✓ ${p.sql}`);

    // ── verify the end state ──
    const a = await readState(conn);
    const bad = [];
    const c0 = s.col, c1 = a.col;
    if (!c1) bad.push(`${COLUMN} is gone`);
    else {
      if (!isNewType(c1)) bad.push(`${COLUMN} is "${c1.column_type}", expected smallint`);
      if (c1.column_comment !== COMMENT) bad.push(`${COLUMN} comment is ${JSON.stringify(c1.column_comment)}`);
      if (c1.is_nullable !== c0.is_nullable) bad.push(`${COLUMN} NULL-ness changed: ${c0.is_nullable} → ${c1.is_nullable}`);
      if (c1.column_default !== c0.column_default) bad.push(`${COLUMN} default changed: ${c0.column_default} → ${c1.column_default}`);
      if (Number(c1.pos) !== Number(c0.pos)) bad.push(`${COLUMN} moved: position ${c0.pos} → ${c1.pos}`);
    }
    if (!a.gen || a.gen.gen !== s.gen.gen || a.gen.extra !== s.gen.extra) bad.push(`${GENERATED} changed: ${JSON.stringify(a.gen)}`);
    for (const k of ['n', 'filled', 'min', 'max', 'total', 'x_len', 'x_end']) {
      if (a.stats[k] !== s.stats[k]) bad.push(`${k} changed: ${s.stats[k]} → ${a.stats[k]}`);
    }
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: ${COLUMN} ${c1.column_type} ${c1.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'} default ` +
      `${c1.column_default === null ? 'NULL' : c1.column_default}, position ${c1.pos}, comment set; ${GENERATED} unchanged; ` +
      `${a.stats.n} rows, checksums ${a.stats.x_len} / ${a.stats.x_end} identical`);
  } catch (err) {
    say(`\n  ✗ ${err.message}`);
    const line = altered
      ? `NO-GO — the ALTER ran but the end state did not verify (above). Paste this output. Do NOT deploy.`
      : /Lock wait timeout/i.test(String(err.message))
        ? `NO-GO — the ALTER waited ${LOCK_WAIT_S} s for a lock another session holds on ${TABLE} and gave up; nothing was changed. ` +
          `Re-run ${CMD} --apply when the table is quiet.`
      : /timeout/i.test(String(err.message))
        ? `NO-GO — timed out (${err.message.split('\n')[0]}). A client timeout does not stop a server-side ALTER: ` +
          `re-run ${CMD} (CHECK) to see the column. Do NOT deploy until --apply says GO.`
        : `NO-GO — stopped before any change. Re-running ${CMD} --apply resumes from the live state. Do NOT deploy.`;
    say(`\n${line}`);
    return { ok: false, line, state: s, altered };
  }

  const line = 'APPLIED — GO. Next: land the backend slice (SQL → backend); the pre-commit hook regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, altered };
}

module.exports = { TABLE, COLUMN, COMMENT, alterSql, plan, readState, run };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const override = process.env.APPT_LENGTH_DB_URL;
      if (override) {
        const dbName = new URL(override).pathname.slice(1);
        if (!/_test$/.test(dbName)) throw new Error(`APPT_LENGTH_DB_URL names "${dbName}": the override is for a scratch *_test database only`);
        conn = mysql.createConnection({ uri: override, timezone: 'Z', connectTimeout: 15_000 }).promise();
      } else {
        const { ensureSqlProxy } = require('./ensure-sql-proxy');
        const proxy = await ensureSqlProxy();
        if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
        for (const k of ['host', 'user', 'password', 'database']) {
          if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
        }
        conn = mysql.createConnection({
          host: process.env.host, user: process.env.user, password: process.env.password,
          database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
        }).promise();
      }
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
