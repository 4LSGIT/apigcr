#!/usr/bin/env node
// scripts/optoutContactColumnsDrop.js
//
/**
 * Opt-out follow-up (ruling 2026-10-27, Fred's go the same day) — drop the two
 * retired contact-level opt-out columns, and name the row flags THE consent
 * flag in the schema:
 *
 *   contacts.contact_sms_optout     DROP (retired: consent is the row's flag)
 *   contacts.contact_email_optout   DROP
 *   contact_phones.sms_optout       COMMENT — THE SMS/MMS consent flag
 *   contact_emails.email_optout     COMMENT — THE email consent flag
 *
 * The applied SQL is recorded in
 * ref/migrations/2026-10-27_optout_contact_columns_drop.sql.
 *
 * USAGE (from a checkout of the LANDED commit whose .env reaches production —
 * the same setup `npm run db:ref` uses; the Cloud SQL proxy is started if .env
 * opts in):
 *
 *   node scripts/optoutContactColumnsDrop.js           # CHECK — read-only, prints the plan
 *   node scripts/optoutContactColumnsDrop.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 *
 * ── ORDER: CODE FIRST, THEN THIS (a DROP inverts SQL → backend) ───────────
 * The deploy rule is SQL → backend because new code must not run against a
 * schema that lacks what it needs. A DROP is the mirror image: the column must
 * outlive every reader, so the code that stopped naming these two columns
 * (lib/reportSchema/manifest.js — the report author's schema — and the test
 * fixtures) is deployed FIRST, and this runs after. Run before that deploy and
 * the report author is still offered two columns that no longer exist.
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - each column to drop is either gone or exactly `tinyint(1) NOT NULL
 *     DEFAULT '0'` — anything else and someone changed it;
 *   - every value in it is 0 (or NULL): nothing is lost. A nonzero value means
 *     something wrote it since the 2026-10-26 sweep (1,106 rows, all 0) — find
 *     out what before dropping;
 *   - nothing else in the schema names either column: no trigger, view,
 *     generated column, routine, event, CHECK constraint, index or foreign key;
 *   - each row flag to comment is exactly `tinyint(1) NOT NULL DEFAULT '0'`
 *     and carries either no comment or exactly the target one.
 *   --apply asserts it all AGAIN after setting lock_wait_timeout, and the
 *   value census is re-run under LOCK TABLES contacts WRITE immediately before
 *   the DROP, so no write can land between the census and the drop.
 *
 * ── SESSION (one connection — never the SU console) ───────────────────────
 *   lock_wait_timeout = 5. LOCK TABLES and the ALTERs take an exclusive
 *   metadata lock; one queued behind a long transaction would stall every
 *   query on the table for up to the global default (a year). A timeout here
 *   changes nothing and the re-run resumes.
 *   contacts has a FULLTEXT index, which rules out INSTANT / INPLACE for the
 *   drop (error 1846): ALGORITHM=COPY, ~1.1k rows, under a second. The two
 *   COMMENT changes are metadata only: ALGORITHM=INSTANT (it fails rather than
 *   silently rebuilding if that ever stops being true).
 *
 * ── THE REPORT GRANT (proved on MySQL 8.4.11) ─────────────────────────────
 * yc_report (scripts/reportGrantUserProvision.js) holds per-COLUMN SELECT on
 * contacts, both columns included. The DROP does NOT fail on that grant: it
 * succeeds and the grant stays ORPHANED in mysql.columns_priv / SHOW GRANTS —
 * inert (yc_report still reads every other column; the dropped ones are
 * "Unknown column" to everyone), but it re-attaches to any later column of the
 * same name. This connection (the app user) can neither see nor revoke it.
 * Cleared by the next `reportGrantUserProvision.js --apply --rotate`, or a
 * root `REVOKE SELECT (`contact_sms_optout`, `contact_email_optout`) ON
 * <db>.`contacts` FROM 'yc_report'@'%'`. Optional; ref/plans.md.
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   both columns are gone; both comments are set; the type/null/default of
 *   the commented columns is unchanged; the row count is unchanged; the
 *   reference sweep is clean; a contact UPDATE (fires the contacts triggers)
 *   works and is rolled back. Then verify read-only (information_schema) and
 *   the next commit's hook regenerates ref/database.sql.
 *
 * ── ROLLBACK (not expected: every value was 0) ────────────────────────────
 *   see the ROLLBACK section of the migration file.
 */

'use strict';

const DROP_TABLE = 'contacts';
const DROP_COLUMNS = ['contact_sms_optout', 'contact_email_optout'];

const FLAG_TYPE = 'tinyint(1)';
const FLAG_DEF = "tinyint(1) NOT NULL DEFAULT '0'";

const COMMENTS = [
  {
    table: 'contact_phones', column: 'sms_optout',
    comment: 'messaging consent: 1 = opted out of SMS/MMS. THE consent flag (services/optoutService.js); ' +
      'only the active row (end_date IS NULL) counts; automation refuses, staff sends warn',
  },
  {
    table: 'contact_emails', column: 'email_optout',
    comment: 'messaging consent: 1 = opted out of email. THE consent flag (services/optoutService.js); ' +
      'only the active row (end_date IS NULL) counts; automation refuses, staff sends warn',
  },
];

const NAMES_RE = /(^|[^A-Za-z0-9_])(contact_sms_optout|contact_email_optout)([^A-Za-z0-9_]|$)/i;

const SQL = {
  lockWait: 'SET SESSION lock_wait_timeout = 5',
  lock:     'LOCK TABLES `contacts` WRITE',
  unlock:   'UNLOCK TABLES',
  drop:     cols => 'ALTER TABLE `contacts` ' + cols.map(c => 'DROP COLUMN `' + c + '`').join(', ') + ', ALGORITHM=COPY',
  comment:  (t, c) => 'ALTER TABLE `' + t + '` MODIFY COLUMN `' + c + '` ' + FLAG_DEF + ' COMMENT ?, ALGORITHM=INSTANT',
};

const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS   = 180_000;

const norm = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');

/** One timed query; returns rows. */
async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

/** The value census of the drop columns still present ({} when none is). */
async function census(conn, present) {
  if (!present.length) return { rows: null, nonzero: {} };
  const parts = present.map(c => `COALESCE(SUM(\`${c}\` IS NOT NULL AND \`${c}\` <> 0), 0) AS \`${c}\``);
  const [r] = await q(conn, `/* optdrop:census */ SELECT COUNT(*) AS n, ${parts.join(', ')} FROM \`contacts\``);
  const nonzero = {};
  for (const c of present) nonzero[c] = Number(r[c]);
  return { rows: Number(r.n), nonzero };
}

async function readState(conn) {
  const [who] = await q(conn,
    '/* optdrop:who */ SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v');

  const cols = await q(conn,
    '/* optdrop:columns */ SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, ' +
    'COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS cmt, EXTRA AS extra, GENERATION_EXPRESSION AS gen ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (' +
    "(TABLE_NAME = 'contacts' AND COLUMN_NAME IN ('contact_sms_optout', 'contact_email_optout')) OR " +
    "(TABLE_NAME = 'contact_phones' AND COLUMN_NAME = 'sms_optout') OR " +
    "(TABLE_NAME = 'contact_emails' AND COLUMN_NAME = 'email_optout'))");
  const col = (t, c) => {
    const r = cols.find(x => x.t === t && String(x.c).toLowerCase() === c);
    return r ? { type: String(r.type).toLowerCase(), nullable: r.nullable, dflt: r.dflt == null ? null : String(r.dflt),
                 comment: r.cmt == null ? '' : String(r.cmt), extra: String(r.extra || ''), gen: String(r.gen || '') } : null;
  };

  const [{ n: tables }] = await q(conn,
    "/* optdrop:table */ SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contacts'");

  // Everything else in the schema that could name a column. Matched in JS, not
  // with REGEXP in SQL: information_schema text columns carry their own
  // collations and a REGEXP across them is a collation-mix error waiting.
  const triggers = await q(conn, '/* optdrop:triggers */ SELECT TRIGGER_NAME AS name, ACTION_STATEMENT AS def FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
  const views    = await q(conn, '/* optdrop:views */ SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()');
  const gens     = await q(conn, "/* optdrop:generated */ SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS name, GENERATION_EXPRESSION AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND GENERATION_EXPRESSION <> ''");
  const routines = await q(conn, '/* optdrop:routines */ SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
  const events   = await q(conn, '/* optdrop:events */ SELECT EVENT_NAME AS name, EVENT_DEFINITION AS def FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()');
  const checks   = await q(conn, '/* optdrop:checks */ SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS def FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()');
  const indexes  = await q(conn, "/* optdrop:indexes */ SELECT CONCAT(TABLE_NAME, '.', INDEX_NAME) AS name, COLUMN_NAME AS def FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contacts'");
  const fks      = await q(conn, "/* optdrop:fks */ SELECT CONCAT(TABLE_NAME, '.', CONSTRAINT_NAME) AS name, CONCAT(COLUMN_NAME, ' ', COALESCE(REFERENCED_COLUMN_NAME, '')) AS def FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME = 'contacts' OR REFERENCED_TABLE_NAME = 'contacts')");

  const refs = [];
  for (const [kind, list] of [['trigger', triggers], ['view', views], ['generated column', gens], ['routine', routines],
    ['event', events], ['CHECK constraint', checks], ['index', indexes], ['foreign key', fks]]) {
    for (const r of list) if (NAMES_RE.test(norm(r.def))) refs.push({ kind, name: r.name });
  }

  const drop = {};
  for (const c of DROP_COLUMNS) drop[c] = col(DROP_TABLE, c);
  const present = DROP_COLUMNS.filter(c => drop[c]);
  const cen = await census(conn, present);

  const flags = {};
  for (const C of COMMENTS) flags[`${C.table}.${C.column}`] = col(C.table, C.column);

  return {
    user: who.cu, db: who.db, version: who.v,
    contactsTable: Number(tables) === 1,
    drop, present, rows: cen.rows, nonzero: cen.nonzero,
    flags, refs,
  };
}

// ─────────────────────────────────────────────────────────────
// Deciding — pure, so the tests can drive every branch
// ─────────────────────────────────────────────────────────────

/** Is a column exactly `tinyint(1) NOT NULL DEFAULT '0'` (stored, not generated)? */
function isFlag(c) {
  return !!c && c.type === FLAG_TYPE && c.nullable === 'NO' && c.dflt === '0' && c.gen === '' &&
    !/GENERATED|AUTO_INCREMENT|ON UPDATE/i.test(c.extra);
}
function describeCol(c) {
  return c ? `${c.type} ${c.nullable === 'NO' ? 'NOT NULL' : 'NULL'} DEFAULT ${c.dflt == null ? 'NULL' : `'${c.dflt}'`}` +
    `${c.extra ? ` ${c.extra}` : ''}${c.gen ? ` AS (${c.gen})` : ''}` : 'missing';
}

/**
 * @returns {{ problems: string[], notes: string[], steps: Array<{kind:'drop', cols:string[]}|{kind:'comment', table, column, comment}>, done: boolean }}
 */
function plan(s) {
  const problems = [];
  const notes = [];
  const steps = [];

  if (!s.contactsTable) problems.push('there is no `contacts` table in this database — wrong database?');

  for (const c of DROP_COLUMNS) {
    const d = s.drop[c];
    if (!d) continue;
    if (!isFlag(d)) problems.push(`contacts.${c} is ${describeCol(d)}, expected ${FLAG_DEF} — someone changed it; find out why before dropping`);
    const n = s.nonzero[c];
    if (!(n === 0)) {
      problems.push(`${n} row(s) of contacts.${c} hold a nonzero value — something wrote it since the 2026-10-26 sweep ` +
        '(all 0); dropping now would lose it. Find the writer first');
    }
  }
  for (const r of s.refs) problems.push(`${r.kind} ${r.name} names a column being dropped — it would break on the drop`);

  for (const C of COMMENTS) {
    const key = `${C.table}.${C.column}`;
    const f = s.flags[key];
    if (!f) { problems.push(`${key} does not exist — it is THE consent flag; wrong database?`); continue; }
    if (!isFlag(f)) { problems.push(`${key} is ${describeCol(f)}, expected ${FLAG_DEF} — the MODIFY would change it`); continue; }
    if (f.comment === C.comment) continue;
    if (f.comment !== '') {
      problems.push(`${key} already carries a different comment ("${f.comment}") — someone set it since; ` +
        'reconcile the text here before overwriting it');
      continue;
    }
    steps.push({ kind: 'comment', table: C.table, column: C.column, comment: C.comment });
  }

  if (s.present.length) {
    steps.unshift({ kind: 'drop', cols: [...s.present] });
    notes.push("yc_report's per-column grant on the dropped column(s) stays ORPHANED in mysql.columns_priv " +
      '(inert; cleared by reportGrantUserProvision.js --apply --rotate or a root REVOKE — ref/plans.md)');
  }

  return { problems, notes, steps, done: steps.length === 0 };
}

function describeStep(st) {
  return st.kind === 'drop'
    ? `LOCK TABLES contacts WRITE; re-census; ${SQL.drop(st.cols)}; UNLOCK TABLES`
    : SQL.comment(st.table, st.column).replace('?', `'${st.comment}'`);
}

const stepsKey = p => JSON.stringify(p.steps);

// ─────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────

/** LOCK, re-census (nothing may have been written since), DROP, UNLOCK. */
async function dropUnderLock(conn, cols, log) {
  await q(conn, SQL.lock, [], DDL_TIMEOUT_MS);
  try {
    const { nonzero } = await census(conn, cols);
    const bad = cols.filter(c => nonzero[c] !== 0);
    if (bad.length) {
      const e = new Error(`under the lock, ${bad.map(c => `contacts.${c} has ${nonzero[c]} nonzero row(s)`).join('; ')} — ` +
        'something wrote it between the check and the drop. Nothing was dropped');
      e.nothingChanged = true;
      throw e;
    }
    await q(conn, SQL.drop(cols), [], DDL_TIMEOUT_MS);
  } finally {
    await q(conn, SQL.unlock).catch(() => {});
  }
  log(`  ✓ ${SQL.drop(cols)} (under LOCK TABLES, census 0)`);
}

/** A real contact UPDATE in a transaction that is rolled back: the contacts triggers still run. */
async function smoke(conn, log) {
  const [c] = await q(conn,
    '/* optdrop:smoke-pick */ SELECT contact_id, contact_notes FROM contacts ' +
    'WHERE CHAR_LENGTH(contact_notes) < 2000 ORDER BY contact_id ASC LIMIT 1');
  if (!c) { log('  · smoke skipped: no contact to update'); return; }
  await conn.beginTransaction();
  let res;
  try {
    [res] = await conn.query({ sql: '/* optdrop:smoke */ UPDATE contacts SET contact_notes = CONCAT(contact_notes, ?) WHERE contact_id = ?', timeout: QUERY_TIMEOUT_MS },
      ['.', c.contact_id]);
  } finally {
    await conn.rollback().catch(() => {});
  }
  const [after] = await q(conn, '/* optdrop:smoke-after */ SELECT contact_notes FROM contacts WHERE contact_id = ?', [c.contact_id]);
  if (!res || res.affectedRows !== 1) throw new Error(`the smoke UPDATE on contact ${c.contact_id} touched ${res && res.affectedRows} row(s), expected 1`);
  if (!after || after.contact_notes !== c.contact_notes) throw new Error(`the smoke rollback did not undo contact ${c.contact_id} — look now`);
  log(`  ✓ smoke: contact ${c.contact_id} UPDATE ran (contacts triggers fired) and was rolled back`);
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

const CMD = 'node scripts/optoutContactColumnsDrop.js';

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== Opt-out: drop the contact-level opt-out columns + comment the row flags — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  for (const c of DROP_COLUMNS) {
    const d = s.drop[c];
    say(`contacts.${c}: ${d ? `present (${describeCol(d)}) — ${s.nonzero[c]} nonzero of ${s.rows} rows` : 'already dropped'}`);
  }
  for (const C of COMMENTS) {
    const f = s.flags[`${C.table}.${C.column}`];
    say(`${C.table}.${C.column}: ${f ? `${describeCol(f)}, comment ${f.comment === C.comment ? 'SET (target)' : f.comment ? `"${f.comment}"` : 'none'}` : 'MISSING'}`);
  }
  say(`schema references to the two columns: ${s.refs.length ? s.refs.map(r => `${r.kind} ${r.name}`).join(', ') : 'none'}`);

  const p = plan(s);
  for (const n of p.notes) say(`note: ${n}`);
  if (p.problems.length) {
    say('\nPROBLEMS:');
    for (const x of p.problems) say(`  - ${x}`);
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed. Fix them, then re-run ${CMD}`;
    say(`\n${line}`);
    return { ok: false, line, state: s };
  }
  if (p.done) {
    const line = 'ALREADY APPLIED — GO. Both columns are gone and both comments are set; nothing to do. ' +
      'Next: verify read-only (information_schema.COLUMNS); the next commit regenerates ref/database.sql.';
    say(`\n${line}`);
    return { ok: true, line, state: s, done: true };
  }

  say('\nPLAN, in this order:');
  p.steps.forEach((st, i) => say(`  ${i + 1}. ${describeStep(st)}`));
  say('  then: re-read everything, verify, and smoke-test a contact UPDATE (rolled back)');

  if (!apply) {
    const line = `CHECK OK — GO. Next: ${CMD} --apply`;
    say(`\n${line}`);
    return { ok: true, line, state: s, plan: p };
  }

  // ── apply ──
  say('');
  const done = [];
  try {
    await q(conn, SQL.lockWait);
    // Re-assert the live state on THIS session, after the lock timeout is set.
    const s2 = await readState(conn);
    const p2 = plan(s2);
    if (p2.problems.length || stepsKey(p2) !== stepsKey(p)) {
      const e = new Error('the live state changed between the check and the apply:\n    - ' +
        (p2.problems.length ? p2.problems.join('\n    - ') : `plan was ${stepsKey(p)}, is now ${stepsKey(p2)}`));
      e.nothingChanged = true;
      throw e;
    }
    for (const st of p2.steps) {
      if (st.kind === 'drop') {
        await dropUnderLock(conn, st.cols, say);
        done.push(`dropped contacts.${st.cols.join(', contacts.')}`);
      } else {
        await q(conn, SQL.comment(st.table, st.column), [st.comment], DDL_TIMEOUT_MS);
        say(`  ✓ COMMENT on ${st.table}.${st.column}`);
        done.push(`commented ${st.table}.${st.column}`);
      }
    }

    // ── verify the end state ──
    const after = await readState(conn);
    const bad = [];
    for (const c of DROP_COLUMNS) if (after.drop[c]) bad.push(`contacts.${c} still exists`);
    for (const r of after.refs) bad.push(`${r.kind} ${r.name} still names a dropped column`);
    for (const C of COMMENTS) {
      const key = `${C.table}.${C.column}`;
      const f = after.flags[key];
      if (!f || f.comment !== C.comment) bad.push(`${key} comment is ${f ? `"${f.comment}"` : 'MISSING'}, expected the target`);
      if (!isFlag(f)) bad.push(`${key} is now ${describeCol(f)}, expected ${FLAG_DEF}`);
    }
    const [{ n: rowsAfter }] = await q(conn, '/* optdrop:rows */ SELECT COUNT(*) AS n FROM contacts');
    if (s2.rows != null && Number(rowsAfter) !== s2.rows) bad.push(`contacts has ${rowsAfter} rows, had ${s2.rows}`);
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: both columns gone, both comments set, flags unchanged (${FLAG_DEF}), ` +
      `${rowsAfter} contacts, no remaining references`);

    await smoke(conn, say);
  } catch (err) {
    say(`\n  ✗ ${err.message}`);
    const line = err.nothingChanged
      ? `NO-GO — nothing was changed. Paste this output; re-run ${CMD} once it is understood.`
      : `NO-GO — stopped ${done.length ? `after: ${done.join('; ')}` : 'before any change'}. ` +
        `Re-running ${CMD} --apply resumes from the live state.`;
    say(`\n${line}`);
    return { ok: false, line, state: s, done };
  }

  const line = 'APPLIED — GO. Next: verify read-only (information_schema.COLUMNS: the two contacts columns absent, ' +
    'both comments set); the next commit regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, done };
}

module.exports = { DROP_COLUMNS, COMMENTS, SQL, FLAG_DEF, NAMES_RE, plan, readState, run };

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
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
