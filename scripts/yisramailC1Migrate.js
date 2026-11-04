#!/usr/bin/env node
// scripts/yisramailC1Migrate.js
//
/**
 * YisraMail C1 — campaign hardening schema (ref/YISRAMAIL_DESIGN.md §6.1, §6.4):
 *   campaigns:        + class, topic_key, bulk_confirmed_count; status += 'paused'
 *   campaign_results: status += 'sending', 'unknown' (the send reservation);
 *                     provider_message_id COMMENT (C1's sent update writes it)
 *   email_credentials: bulk_ok COMMENT (an over-cap operational campaign may
 *                     send through a bulk row, D16)
 *   app_settings:     marketing_send_enabled = '0' (the kill switch, dark)
 * Every definition, comments included, is read from
 * ref/migrations/2026-11-03_yisramail_c1_campaign_class.sql so the file and the
 * applied tables can never differ.
 *
 * DEPLOY ORDER (absolute):
 *   1. node scripts/yisramailC1Migrate.js            # CHECK — read-only
 *   2. node scripts/yisramailC1Migrate.js --apply    # ALTER + seed, then verify
 *   3. backend deploy
 *
 * CHECK (default), read-only: each table has exactly its pre-C1 columns plus
 * any C1 column already present WITH the expected definition (a re-run); each
 * MODIFY target holds either its pre-C1 definition or the C1 one. Anything
 * else is NO-GO, nothing altered. marketing_send_enabled already '1' is a
 * NO-GO too (C1 ships it dark — set it to '0' first). Prints the row counts.
 * --apply: one ALTER per table for whatever is missing, the seed row (left
 * alone when it exists), then VERIFIES types, nullability, defaults,
 * collation, comments and the seed. Re-runnable: resumes from wherever a
 * failed run stopped.
 *
 * ONE connection; session time_zone +00:00, lock_wait_timeout 10 — an ALTER
 * queued behind a long transaction gives up in seconds (NO-GO, re-run later)
 * instead of stalling every campaign send. One GO / NO-GO line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-03_yisramail_c1_campaign_class.sql');
const SETTING = 'marketing_send_enabled';
const GC = 'utf8mb4_general_ci';

/** Live columns before C1 (verified 2026-11-03), per table, in order. */
const BASE_COLUMNS = Object.freeze({
  campaigns: Object.freeze(['campaign_id', 'type', 'sender', 'subject', 'body', 'attachment_url', 'include_signature',
    'created', 'status', 'scheduled_time', 'created_by', 'result_summary', 'contact_count', 'updated_at']),
  campaign_results: Object.freeze(['result_id', 'campaign_id', 'contact_id', 'status', 'error', 'sent_at', 'result_meta',
    'provider_message_id', 'delivery_status', 'delivered_at', 'bounced_at', 'complained_at', 'delivery_diag', 'bounce_subtype']),
  email_credentials: Object.freeze(['id', 'email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'provider',
    'credential_id', 'from_name', 'signature_html', 'signature_text', 'owner_user', 'bulk_ok', 'events_driver', 'driver_config']),
});

/**
 * Columns a LATER slice adds to these tables — tolerated when present (never
 * checked or touched here), so this CHECK and its twins keep passing once the
 * dump carries them: C2 (scripts/yisramailC2Migrate.js), C3 (scripts/yisramailC3Migrate.js).
 */
const LATER_COLUMNS = Object.freeze({
  campaigns: Object.freeze(['send_snapshot', 'design_id']),
  campaign_results: Object.freeze([]),
  email_credentials: Object.freeze(['held_at', 'held_reason']),
});

/** Columns C1 ADDS: table → name → [COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME | null]. */
const ADDED = Object.freeze({
  campaigns: Object.freeze({
    class: ["enum('operational','marketing')", 'NO', 'operational', GC],
    topic_key: ['varchar(40)', 'YES', null, GC],
    bulk_confirmed_count: ['int unsigned', 'YES', null, null],
  }),
  campaign_results: Object.freeze({}),
  email_credentials: Object.freeze({}),
});

/**
 * Columns C1 MODIFIES: the C1 definition (comment from the file) and the
 * pre-C1 one it may replace: [type, nullable, default, collation, comment].
 */
const T1_BULK_COMMENT = '1 = a marketing (bulk) transport: never listed to a sender picker, refused by the public emailService.sendEmail, by createCampaign and as a mailbox send_credential_id; only sendEmailDirect({bulk:true}) — the campaign marketing path — may send from it. SMTP rows only; no other row may share its (smtp_host, smtp_user) and no mailbox may send through it (the sender editor refuses both). ref/YISRAMAIL_DESIGN.md §5.2';
const T2_PMID_COMMENT = 'the provider message id of the send (SES: the id in the 250 reply, emailService info.providerMessageId; SES events carry it as detail.mail.messageId). Written at send by C2, and by mail_event_ingest when it correlated by the result_id tag first. Second correlation key after the result_id message tag. ref/YISRAMAIL_DESIGN.md §5.2';
const MODIFIED = Object.freeze({
  campaigns: Object.freeze({
    status: {
      now: ["enum('draft','scheduled','sending','sent','failed','partial_fail','canceled','paused')", 'YES', 'draft', GC],
      before: ["enum('draft','scheduled','sending','sent','failed','partial_fail','canceled')", 'YES', 'draft', GC, ''],
    },
  }),
  campaign_results: Object.freeze({
    status: {
      now: ["enum('sent','failed','skipped','sending','unknown')", 'NO', null, GC],
      before: ["enum('sent','failed','skipped')", 'NO', null, GC, ''],
    },
    provider_message_id: {
      now: ['varchar(128)', 'YES', null, GC],
      before: ['varchar(128)', 'YES', null, GC, T2_PMID_COMMENT],
    },
  }),
  email_credentials: Object.freeze({
    bulk_ok: {
      now: ['tinyint(1)', 'NO', '0', null],
      before: ['tinyint(1)', 'NO', '0', null, T1_BULK_COMMENT],
    },
  }),
});
const TABLES = Object.freeze(['campaigns', 'campaign_results', 'email_credentials']);

const SQL = Object.freeze({
  table: 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  columns: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
                   COLLATION_NAME AS coll, COLUMN_COMMENT AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
  setting: 'SELECT `value` FROM app_settings WHERE `key` = ?',
});

/**
 * The file's statements: { alters: { table → { column → clause } }, seed: sql }.
 * One clause per line (COMMENTs hold ',' and ';'); the seed is the INSERT.
 */
function clauses() {
  const out = { alters: Object.fromEntries(TABLES.map((t) => [t, {}])), seed: null };
  const text = fs.readFileSync(MIGRATION, 'utf8');
  let table = null;
  for (const line of text.split('\n')) {
    const t = /^ALTER TABLE (\w+)$/.exec(line);
    if (t) { table = t[1]; continue; }
    const c = /^\s*((?:ADD|MODIFY) COLUMN (\w+) .*?)[,;]\s*$/.exec(line);
    if (c && table && out.alters[table]) { out.alters[table][c[2]] = c[1]; continue; }
    if (/^\S/.test(line)) table = null;
  }
  const seed = /^INSERT INTO app_settings[\s\S]*?;$/m.exec(text);
  out.seed = seed ? seed[0].replace(/;$/, '') : null;
  return out;
}

function commentOf(clause) {
  const m = /COMMENT '((?:[^']|'')*)'$/.exec(clause || '');
  return m ? m[1].replace(/''/g, "'") : null;
}

/** The ALTER for a table's missing work (column names, file order). null when nothing to do. */
function alterSql(table, columns) {
  const c = clauses().alters[table];
  const parts = Object.keys(c).filter((n) => columns.includes(n)).map((n) => c[n]);
  return parts.length ? `ALTER TABLE ${table}\n  ${parts.join(',\n  ')}` : null;
}

function sameDef(col, [type, nullable, dflt, coll], comment) {
  return String(col.type).toLowerCase() === type && col.nullable === nullable
    && (col.dflt == null ? null : String(col.dflt)) === dflt && (col.coll || null) === coll
    && (comment === undefined || col.comment === comment);
}

function describeDiff(name, col, [type, nullable, dflt, coll], comment) {
  const out = [];
  if (String(col.type).toLowerCase() !== type) out.push(`${name} is ${col.type}, expected ${type}`);
  if (col.nullable !== nullable) out.push(`${name} IS_NULLABLE ${col.nullable}, expected ${nullable}`);
  if ((col.dflt == null ? null : String(col.dflt)) !== dflt) out.push(`${name} DEFAULT ${col.dflt}, expected ${dflt}`);
  if ((col.coll || null) !== coll) out.push(`${name} collation ${col.coll || 'none'}, expected ${coll || 'none'}`);
  if (comment !== undefined && col.comment !== comment) out.push(`${name} comment differs from the migration file`);
  return out;
}

/** → { todo: { table → [columns] }, problems: [..] } */
async function state(conn) {
  const c = clauses();
  const todo = {};
  const problems = [];
  for (const table of TABLES) {
    todo[table] = [];
    const [cols] = await conn.query(SQL.columns, [table]);
    const have = new Map(cols.map((x) => [x.name, x]));
    for (const b of BASE_COLUMNS[table]) if (!have.has(b)) problems.push(`${table}: pre-C1 column ${b} is missing`);
    for (const name of have.keys()) {
      if (!BASE_COLUMNS[table].includes(name) && !ADDED[table][name] && !LATER_COLUMNS[table].includes(name)) problems.push(`${table}: unexpected column ${name}`);
    }
    for (const [name, def] of Object.entries(ADDED[table])) {
      const col = have.get(name);
      const comment = commentOf(c.alters[table][name]);
      if (!col) { todo[table].push(name); continue; }
      describeDiff(`${table}.${name}`, col, def, comment).forEach((p) => problems.push(p));
    }
    for (const [name, { now, before }] of Object.entries(MODIFIED[table])) {
      const col = have.get(name);
      if (!col) continue;   // reported as a missing base column
      const comment = commentOf(c.alters[table][name]);
      if (sameDef(col, now, comment)) continue;
      if (sameDef(col, before.slice(0, 4), before[4])) { todo[table].push(name); continue; }
      problems.push(`${table}.${name} is neither its pre-C1 definition nor the C1 one:`);
      describeDiff(`  ${table}.${name}`, col, now, comment).forEach((p) => problems.push(p));
    }
    const order = Object.keys(c.alters[table]);
    todo[table].sort((a, b) => order.indexOf(a) - order.indexOf(b));   // the file's order
  }
  return { todo, problems };
}

/** CHECK (apply:false) or ALTER + seed + verify (apply:true). → { ok, line, altered } */
async function run(conn, { apply = false, say = console.log } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION lock_wait_timeout = 10');

  const c = clauses();
  const fileProblems = [];
  for (const table of TABLES) {
    for (const name of [...Object.keys(ADDED[table]), ...Object.keys(MODIFIED[table])]) {
      if (!c.alters[table][name] || !commentOf(c.alters[table][name])) fileProblems.push(`${table}.${name}`);
    }
  }
  if (fileProblems.length || !c.seed) {
    const line = `NO-GO — the migration file lacks ${fileProblems.length ? `a commented clause for ${fileProblems.join(', ')}` : 'the app_settings seed'}. Nothing was changed.`;
    say(line);
    return { ok: false, line, altered: false };
  }
  for (const table of [...TABLES, 'app_settings']) {
    const [[t]] = await conn.query(SQL.table, [table]);
    if (!Number(t.n)) {
      const line = `NO-GO — table ${table} does not exist in this database. Nothing was changed.`;
      say(line);
      return { ok: false, line, altered: false };
    }
  }
  for (const table of TABLES) {
    const [[rc]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
    say(`${table}: ${Number(rc.n)} row(s)`);
  }

  let st = await state(conn);
  for (const table of TABLES) say(`${table}: C1 work ${st.todo[table].length ? `to do: ${st.todo[table].join(', ')}` : 'none (in place)'}`);
  const [[seedRow]] = await conn.query(SQL.setting, [SETTING]);
  say(`app_settings ${SETTING}: ${seedRow ? `present, value ${JSON.stringify(seedRow.value)}` : "absent (seeded '0' by --apply)"}`);
  if (seedRow && seedRow.value === '1') {
    st.problems.push(`${SETTING} is already '1' — C1 ships the switch dark; set it to '0' in the SU console first`);
  }
  if (st.problems.length) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    const line = 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.';
    say(line);
    return { ok: false, line, altered: false };
  }
  const todo = TABLES.some((t) => st.todo[t].length) || !seedRow;

  if (!apply) {
    const line = todo
      ? 'CHECK OK — GO. Next: node scripts/yisramailC1Migrate.js --apply'
      : 'CHECK OK — the C1 columns, enum members and seed are in place as expected. GO (nothing to apply; next: the backend deploy).';
    say(line);
    return { ok: true, line, altered: false };
  }

  let altered = false;
  for (const table of TABLES) {
    const sql = alterSql(table, st.todo[table]);
    if (!sql) continue;
    try {
      await conn.query(sql);
    } catch (err) {
      const line = `NO-GO — the ${table} ALTER failed: ${err.code || ''} ${err.message}. Re-run --apply (it resumes).`;
      say(line);
      return { ok: false, line, altered };
    }
    altered = true;
    say(`  ✓ ${table}: ${st.todo[table].join(', ')}`);
  }
  if (!seedRow) {
    await conn.query(c.seed);
    altered = true;
    say(`  ✓ app_settings ${SETTING} = '0'`);
  }

  st = await state(conn);
  const [[after]] = await conn.query(SQL.setting, [SETTING]);
  const leftover = TABLES.filter((t) => st.todo[t].length);
  if (st.problems.length || leftover.length || !after) {
    st.problems.forEach((p) => say(`  ✗ ${p}`));
    leftover.forEach((t) => say(`  ✗ ${t}: still to do: ${st.todo[t].join(', ')}`));
    if (!after) say(`  ✗ app_settings ${SETTING} is missing`);
    const line = 'NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.';
    say(line);
    return { ok: false, line, altered };
  }
  say(`  ✓ verified: types, nullability, defaults, collation, comments as in the migration file; ${SETTING} = ${JSON.stringify(after.value)}`);
  const line = `${altered ? 'APPLIED' : 'ALREADY IN PLACE'} — C1 schema verified. GO. Next: the backend deploy.`;
  say(line);
  return { ok: true, line, altered };
}

module.exports = { run, state, clauses, commentOf, alterSql, MIGRATION, TABLES, BASE_COLUMNS, LATER_COLUMNS, ADDED, MODIFIED, SETTING, SQL };

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
