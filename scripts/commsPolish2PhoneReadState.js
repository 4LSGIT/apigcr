#!/usr/bin/env node
// scripts/commsPolish2PhoneReadState.js
//
/**
 * comms-polish-2 bundle B — the Comms Phone tab's per-user read state:
 *   TABLE phone_read_state  (user, line_number, other_party) → read_through_id
 *   SEED  one global baseline row ('*', '*') per authorized user at today's
 *         MAX(phone_event_log.id), so launch day shows no unread backlog.
 * Every definition, comments included, is read from
 * ref/migrations/2026-11-16_phone_read_state.sql so the file and the applied
 * table can never differ. The rule the table serves:
 * services/phoneCommsService.js "READ STATE".
 *
 * DEPLOY ORDER (absolute — SQL first):
 *   1. node scripts/commsPolish2PhoneReadState.js            # CHECK — read-only
 *   2. node scripts/commsPolish2PhoneReadState.js --apply    # CREATE + seed, then verify
 *   3. backend + frontend deploy (bundle B)
 *
 * CHECK (default), read-only: the migration file parses into exactly one
 * CREATE TABLE IF NOT EXISTS and one INSERT … SELECT; the table is absent, or
 * present with exactly the file's columns and primary key (a re-run); counts
 * the users the seed would cover and the current MAX(id). Anything else is
 * NO-GO, nothing written. --apply: runs the file's two statements (both
 * idempotent: IF NOT EXISTS + NOT EXISTS), then VERIFIES the columns, types,
 * nullability, the PK, the table comment, and that every authorized user has
 * a baseline whose read_through_id ≤ the MAX(id) read at the start (a re-run
 * never moves a baseline). Re-runnable: resumes from wherever a failed run
 * stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10 — a CREATE
 * TABLE takes no live lock, the setting is the house default for anything
 * that could. One GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-16_phone_read_state.sql');
const TABLE = 'phone_read_state';

/** The file's statements, in order, comments stripped (no DELIMITER blocks in this file). */
function statementsOf(sqlText) {
  const noComments = sqlText.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return noComments.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

/** { name, type, nullable, comment } per column, from the CREATE TABLE text (the same shape information_schema gives back). */
function columnsOf(createSql) {
  const body = createSql.slice(createSql.indexOf('(') + 1, createSql.lastIndexOf(')'));
  const out = [];
  for (const raw of body.split(/,\n/)) {
    const line = raw.trim();
    const m = /^`([a-z_]+)`\s+([a-z]+(?:\(\d+\))?(?: unsigned)?)/i.exec(line);
    if (!m) continue;
    out.push({ name: m[1], type: m[2].toLowerCase(), nullable: !/\bNOT NULL\b/.test(line) });
  }
  return out;
}
function pkOf(createSql) {
  const m = /PRIMARY KEY \(([^)]+)\)/.exec(createSql);
  return m ? m[1].split(',').map((s) => s.trim().replace(/`/g, '')) : [];
}
function tableCommentOf(createSql) {
  const m = /\)\s*ENGINE=[^']*COMMENT='((?:[^']|'')*)'/.exec(createSql);
  return m ? m[1].replace(/''/g, "'") : null;
}

async function liveState(conn) {
  const [[t]] = await conn.query(
    'SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]);
  if (!t) return { exists: false };
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [TABLE]);
  const [pk] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`, [TABLE]);
  const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${TABLE}\``);
  const [[base]] = await conn.query(
    `SELECT COUNT(*) AS n, MAX(read_through_id) AS max_rt FROM \`${TABLE}\` WHERE line_number = '*' AND other_party = '*'`);
  return {
    exists: true,
    comment: t.TABLE_COMMENT,
    columns: cols.map((c) => ({ name: c.COLUMN_NAME, type: String(c.COLUMN_TYPE).toLowerCase(), nullable: c.IS_NULLABLE === 'YES' })),
    pk: pk.map((r) => r.COLUMN_NAME),
    rows: Number(n.n), baselines: Number(base.n), maxBaseline: base.max_rt == null ? null : Number(base.max_rt),
  };
}

function sameSchema(live, want, say) {
  const problems = [];
  const liveCols = live.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' not null'}`);
  const wantCols = want.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' not null'}`);
  if (liveCols.join(' | ') !== wantCols.join(' | ')) problems.push(`columns differ:\n      live  ${liveCols.join(' | ')}\n      file  ${wantCols.join(' | ')}`);
  if (live.pk.join(',') !== want.pk.join(',')) problems.push(`primary key differs: live (${live.pk.join(',')}) vs file (${want.pk.join(',')})`);
  if (want.comment != null && live.comment !== want.comment) problems.push('the table comment differs from the file');
  for (const p of problems) say(`  ✗ ${p}`);
  return problems.length === 0;
}

async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');
  const text = fs.readFileSync(MIGRATION, 'utf8');
  const stmts = statementsOf(text);
  const create = stmts.find((s) => /^CREATE TABLE IF NOT EXISTS `phone_read_state`/.test(s));
  const seed = stmts.find((s) => /^INSERT INTO `phone_read_state`/.test(s));
  if (stmts.length !== 2 || !create || !seed) {
    const line = `NO-GO — ${path.basename(MIGRATION)} must hold exactly one CREATE TABLE IF NOT EXISTS and one INSERT … SELECT (found ${stmts.length} statements). Nothing was changed.`;
    say(line); return { ok: false, line };
  }
  const want = { columns: columnsOf(create), pk: pkOf(create), comment: tableCommentOf(create) };
  if (want.columns.length !== 5 || want.pk.join(',') !== 'user,line_number,other_party') {
    const line = 'NO-GO — the file\'s CREATE TABLE does not parse into the five expected columns + PK (user, line_number, other_party). Nothing was changed.';
    say(line); return { ok: false, line };
  }

  const [[ev]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS n FROM phone_event_log');
  const [[us]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE user_auth = 'authorized' AND user > 0");
  const before = await liveState(conn);
  say(`phone_event_log: ${ev.n} rows, MAX(id) ${ev.max_id}; authorized users (seed targets): ${us.n}`);
  if (!before.exists) say(`  table ${TABLE}: absent — --apply creates it and seeds ${us.n} baseline rows at read_through_id ${ev.max_id}`);
  else {
    say(`  table ${TABLE}: present — ${before.rows} rows, ${before.baselines} global baselines (max ${before.maxBaseline})`);
    if (!sameSchema(before, want, say)) {
      const line = `NO-GO — ${TABLE} exists with a different definition than the file (above). Nothing was changed.`;
      say(line); return { ok: false, line };
    }
  }

  if (!apply) {
    const todo = !before.exists ? 'create + seed' : before.baselines < Number(us.n) ? `seed ${Number(us.n) - before.baselines} missing baseline(s)` : 'nothing (already applied)';
    const line = `GO — CHECK passed; --apply would do: ${todo}. Next: node scripts/commsPolish2PhoneReadState.js --apply`;
    say(line); return { ok: true, line };
  }

  // ── apply (each statement idempotent) ──
  try {
    await conn.query(create);
    say(`  ✓ CREATE TABLE IF NOT EXISTS ${TABLE}`);
    const [r] = await conn.query(seed);
    say(`  ✓ seed: ${r.affectedRows} baseline row(s) inserted`);
  } catch (err) {
    const line = `NO-GO — ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
    say(line); return { ok: false, line };
  }

  // ── verify ──
  const after = await liveState(conn);
  const problems = [];
  if (!after.exists) problems.push('the table is missing after CREATE');
  else if (!sameSchema(after, want, say)) problems.push('the schema does not match the file');
  const [[missing]] = await conn.query(
    `SELECT COUNT(*) AS n FROM users u WHERE u.user_auth = 'authorized' AND u.user > 0
        AND NOT EXISTS (SELECT 1 FROM \`${TABLE}\` r WHERE r.user = u.user AND r.line_number = '*' AND r.other_party = '*')`);
  if (Number(missing.n) !== 0) problems.push(`${missing.n} authorized user(s) still have no global baseline`);
  if (after.exists && after.maxBaseline != null && after.maxBaseline > Number(ev.max_id)) {
    // events can arrive between the read and the seed; a baseline above the START max is only wrong by that much
    const [[now]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM phone_event_log');
    if (after.maxBaseline > Number(now.max_id)) problems.push(`a baseline (${after.maxBaseline}) is above MAX(phone_event_log.id) (${now.max_id})`);
  }
  for (const p of problems) say(`  ✗ ${p}`);
  if (problems.length) {
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line); return { ok: false, line };
  }
  say(`  ✓ verified: ${after.columns.length} columns, PK (${after.pk.join(', ')}), comment as in the file; ${after.baselines} global baselines (max ${after.maxBaseline}), ${after.rows} rows`);
  const line = 'GO — phone_read_state is in place and seeded. Next: land bundle B (backend + frontend).';
  say(line); return { ok: true, line };
}

module.exports = { run, statementsOf, columnsOf, pkOf, tableCommentOf, MIGRATION, TABLE };

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
