#!/usr/bin/env node
// scripts/hookAsyncReceiverS0.js
//
/**
 * Async hook receiver S0 (Fred's go 2026-10-28) — give `hook_executions` the
 * three columns the request-bound drain needs:
 *
 *   hook_executions.claimed_at     ADD  DATETIME(3) NULL        — when a drain claimed the row
 *   hook_executions.completed_at   ADD  DATETIME(3) NULL        — when the pipeline finished
 *   hook_executions.attempts       ADD  TINYINT UNSIGNED NOT NULL DEFAULT 0 — claims so far
 *   hook_executions.status         COMMENT — what each value means once the row is the queue
 *
 * Why: the receiver (routes/api.hooks.js) will answer the sender as soon as
 * the execution row is written and a Cloud Tasks doorbell is rung; filter,
 * transform and targets then run in POST /process-hook-execution/:id (or the
 * 60 s /process-jobs cron when the doorbell never rang). Cloud Tasks delivers
 * at least once, so the handler claims the row with ONE conditional UPDATE
 * (`WHERE status = 'received' AND claimed_at IS NULL`) and only the winner
 * runs — the domain_event_queue pattern (lib/domainEventDrain.js). Research:
 * local/RESEARCH_async_hook_receiver_FINDINGS.md. The applied SQL is recorded
 * in ref/migrations/2026-10-28_hook_executions_async_receiver.sql.
 *
 * USAGE (from a checkout of the COMMITTED slice whose .env reaches production —
 * the same setup `npm run db:ref` uses; the Cloud SQL proxy is started if .env
 * opts in):
 *
 *   node scripts/hookAsyncReceiverS0.js           # CHECK — read-only, prints the plan
 *   node scripts/hookAsyncReceiverS0.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 *
 * ── ORDER: THIS FIRST, THEN THE BACKEND (SQL → backend) ──────────────────
 * S1's receiver SETs claimed_at / attempts / completed_at on every inbound
 * webhook. Deployed before this migration, every hook would 500 on an unknown
 * column — and the receiver answers 200 regardless, so the events would be
 * LOST, not retried. Today's code never names the three columns: this
 * migration is invisible to the running app (SELECT * readers get three more
 * NULL/0 fields nobody reads).
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - `hook_executions` exists; each new column is absent or EXACTLY the
 *     target (type, nullability, default, extra, comment) — anything else (a
 *     column someone added by hand) is a NO-GO;
 *   - `status` is exactly the live enum, NOT NULL DEFAULT 'received', with
 *     no comment or the target comment — the COMMENT MODIFY restates the
 *     definition and must not change it;
 *   - no trigger on hook_executions, and nothing in the schema (view, trigger,
 *     routine, event, generated column) names the new columns.
 *   --apply asserts it all AGAIN on its own session after setting the lock
 *   timeout, and stops if the plan changed in between.
 *
 * ── SESSION (one connection — never the SU console) ───────────────────────
 *   lock_wait_timeout = 2. An ALTER (even an INSTANT one) takes an exclusive
 *   metadata lock; queued behind a long transaction it would stall every
 *   query on the table for up to the global default (a year). The receiver
 *   INSERTs into this table ~170 times a day — each one queued behind a
 *   waiting ALTER is a late webhook answer (RingCentral allows 3 s), so the
 *   wait is 2 s, shorter than the usual 5; a timeout here changes nothing and
 *   the re-run resumes. Every ALTER is
 *   ALGORITHM=INSTANT (metadata only; it fails rather than silently
 *   rebuilding the 30k-row table if that ever stops being true).
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   the three columns are the target; the status comment is set and its
 *   definition unchanged; the row count did not drop. Smoke (rolled back): a
 *   row inserts with the defaults (claimed_at NULL, attempts 0), the claim
 *   UPDATE wins exactly once and loses on the second try — the at-least-once
 *   primitive, proven on the live table. Then deploy S1; the next commit
 *   regenerates ref/database.sql.
 *
 * ── ROLLBACK ──────────────────────────────────────────────────────────────
 *   see the ROLLBACK section of the migration file.
 */

'use strict';

const TABLE = 'hook_executions';

// The live definition of `status`, restated by the COMMENT MODIFY — asserted
// equal before the MODIFY runs, so the comment can never change the column.
const STATUS_TYPE = "enum('received','filtered','processing','delivered','partial','failed','captured')";
const STATUS_DEF = `${STATUS_TYPE} NOT NULL DEFAULT 'received'`;
const STATUS_COMMENT = 'received = queued for the drain (claimed_at NULL) or running filter and transform (claimed_at set, completed_at NULL); ' +
  'processing = transform written, targets running; filtered | delivered | partial | failed | captured = final. ' +
  'A row stuck in processing after its claim must NOT be re-run automatically — targets may have fired. (Async receiver, 2026-10-28)';

// The new columns, in the order they are added (each AFTER the previous).
// [name, DDL fragment, COLUMN_TYPE, nullable, default, comment]
const COLUMNS = [
  {
    name: 'claimed_at', after: 'created_at',
    ddl: 'DATETIME(3) NULL DEFAULT NULL',
    type: 'datetime(3)', nullable: 'YES', dflt: null,
    comment: 'Async receiver (2026-10-28): when a drain — the Cloud Tasks doorbell POST /process-hook-execution/:id or the ' +
      '/process-jobs cron — claimed this row to run filter, transform and targets. NULL = still queued (status received), ' +
      'or a row that predates the async receiver. The claim is ONE conditional UPDATE (WHERE status = received AND claimed_at IS NULL): ' +
      'Cloud Tasks delivers at least once and the loser of the claim does nothing. A synchronous run (dry run, live-test, ' +
      '/internal/hook-replay, the kill-switch path) sets claimed_at at INSERT so the drain never picks it up.',
  },
  {
    name: 'completed_at', after: 'claimed_at',
    ddl: 'DATETIME(3) NULL DEFAULT NULL',
    type: 'datetime(3)', nullable: 'YES', dflt: null,
    comment: 'Async receiver: when the drain finished and status became final. completed_at - created_at is the end-to-end ' +
      'pipeline time (created_at is receipt). NULL while queued or running, and on rows that predate the async receiver.',
  },
  {
    name: 'attempts', after: 'completed_at',
    ddl: 'TINYINT UNSIGNED NOT NULL DEFAULT 0',
    type: 'tinyint unsigned', nullable: 'NO', dflt: '0',
    comment: 'Async receiver: claims so far, bumped AT claim time (a run that killed its instance has already spent its attempt). ' +
      'The stale sweep (lib/hookDrain.js) re-queues or fails a claimed row that never completed; its window and cap live there.',
  },
];

const SQL = {
  lockWait: 'SET SESSION lock_wait_timeout = 2',
  add: c => `ALTER TABLE \`${TABLE}\` ADD COLUMN \`${c.name}\` ${c.ddl} COMMENT ? AFTER \`${c.after}\`, ALGORITHM=INSTANT`,
  statusComment: `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`status\` ${STATUS_DEF} COMMENT ?, ALGORITHM=INSTANT`,
};

const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS   = 120_000;

const NAMES_RE = /(^|[^A-Za-z0-9_])(claimed_at|completed_at|attempts)([^A-Za-z0-9_]|$)/i;
const norm = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');

async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const [who] = await q(conn, '/* hookS0:who */ SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v');
  const tables = await q(conn,
    '/* hookS0:table */ SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]);
  const [tbl] = tables.length ? await q(conn,
    '/* hookS0:collation */ SELECT TABLE_COLLATION AS coll FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]) : [null];
  const cols = await q(conn,
    '/* hookS0:columns */ SELECT COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, ' +
    'COLUMN_COMMENT AS cmt, EXTRA AS extra, GENERATION_EXPRESSION AS gen, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [TABLE]);

  // Matched in JS, not REGEXP in SQL: information_schema text columns carry
  // their own collations (the optout / S5b scripts' reason). The names are
  // generic words (`attempts` exists on hook_delivery_logs and scheduled_jobs),
  // so a hit is read against THIS table in plan(): only an object that names
  // hook_executions too is a problem.
  const triggers = await q(conn, '/* hookS0:triggers */ SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_STATEMENT AS def FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
  const views    = await q(conn, '/* hookS0:views */ SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()');
  const gens     = await q(conn, "/* hookS0:generated */ SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS name, GENERATION_EXPRESSION AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND GENERATION_EXPRESSION <> '' AND TABLE_NAME = ?", [TABLE]);
  const routines = await q(conn, '/* hookS0:routines */ SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
  const events   = await q(conn, '/* hookS0:events */ SELECT EVENT_NAME AS name, EVENT_DEFINITION AS def FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()');

  const tableRe = new RegExp(`(^|[^A-Za-z0-9_])${TABLE}([^A-Za-z0-9_]|$)`, 'i');
  const refs = [];
  for (const [kind, list] of [['trigger', triggers], ['view', views], ['routine', routines], ['event', events]]) {
    for (const r of list) {
      const d = norm(r.def);
      if (NAMES_RE.test(d) && tableRe.test(d)) refs.push({ kind, name: r.name });
    }
  }
  for (const r of gens) if (NAMES_RE.test(norm(r.def))) refs.push({ kind: 'generated column', name: r.name });
  const tableTriggers = triggers.filter(r => String(r.tbl) === TABLE).map(r => ({ name: r.name, table: r.tbl }));

  const col = name => {
    const r = cols.find(x => String(x.c).toLowerCase() === name);
    return r ? { type: String(r.type).toLowerCase(), nullable: r.nullable, dflt: r.dflt == null ? null : String(r.dflt),
                 comment: r.cmt == null ? '' : String(r.cmt), extra: String(r.extra || ''), gen: String(r.gen || ''),
                 charset: r.cs == null ? null : String(r.cs), collation: r.coll == null ? null : String(r.coll) } : null;
  };

  let rows = null;
  if (tables.length) {
    const [r] = await q(conn, `/* hookS0:count */ SELECT COUNT(*) AS n FROM \`${TABLE}\``);
    rows = Number(r.n);
  }
  const newCols = {};
  for (const c of COLUMNS) newCols[c.name] = col(c.name);
  return { user: who.cu, db: who.db, version: who.v, table: tables.length > 0, rows,
           tableCollation: tbl ? String(tbl.coll) : null,
           cols: newCols, status: col('status'), order: cols.map(x => String(x.c)), refs, tableTriggers };
}

// ─────────────────────────────────────────────────────────────
// Deciding — pure, so the tests can drive every branch
// ─────────────────────────────────────────────────────────────

function describeCol(c) {
  return c ? `${c.type} ${c.nullable === 'NO' ? 'NOT NULL' : 'NULL'} DEFAULT ${c.dflt == null ? 'NULL' : c.dflt}` +
    `${c.extra ? ` [${c.extra}]` : ''}${c.gen ? ` AS (${c.gen})` : ''}` : 'missing';
}
const plainCol = c => !!c && c.gen === '' && !/on update|auto_increment|generated (always|stored|virtual)|VIRTUAL|STORED|DEFAULT_GENERATED/i.test(c.extra);
const isTarget = (spec, c) => plainCol(c) && c.type === spec.type && c.nullable === spec.nullable && c.dflt === spec.dflt && c.comment === spec.comment;
const isStatus = c => !!c && c.type === STATUS_TYPE && c.nullable === 'NO' && c.dflt === 'received' && c.gen === '' && c.extra === '';

/**
 * @returns {{ problems: string[], steps: Array<{kind, name?}>, done: boolean }}
 *   step kinds: add (one per column, in COLUMNS order) | statusComment
 */
function plan(s) {
  const problems = [];
  const steps = [];
  if (!s.table) {
    problems.push(`there is no \`${TABLE}\` table in this database — wrong database?`);
    return { problems, steps, done: false };
  }
  for (const r of s.tableTriggers) problems.push(`trigger ${r.name} on ${r.table} — this migration expects none on ${TABLE}; read it first`);
  for (const r of s.refs) problems.push(`${r.kind} ${r.name} already names ${TABLE} and one of the new columns — find out what wrote it before going on`);

  for (const spec of COLUMNS) {
    const c = s.cols[spec.name];
    if (!c) steps.push({ kind: 'add', name: spec.name });
    else if (!isTarget(spec, c)) problems.push(`${TABLE}.${spec.name} already exists as ${describeCol(c)}${c.comment !== spec.comment ? ' with another comment' : ''} — ` +
      'not this migration\'s column (absent or the target); find out who added it');
  }
  // A column added by hand out of order (claimed_at present, completed_at
  // absent) still adds the missing one AFTER its spec'd neighbour, which must
  // then exist — it does, or the add above would be a problem already.
  // The MODIFY names no charset, so the column inherits the TABLE default: it
  // restates the live definition only while the two collations agree.
  const st = s.status;
  if (!isStatus(st)) problems.push(`${TABLE}.status is ${describeCol(st)}, expected ${STATUS_DEF} — the comment MODIFY would change it`);
  else if (st.charset !== 'utf8mb4' || st.collation !== s.tableCollation) problems.push(`${TABLE}.status is ${st.charset} / ${st.collation} while the table default is ${s.tableCollation} — the comment MODIFY would re-collate it`);
  else if (st.comment === '') steps.push({ kind: 'statusComment' });
  else if (st.comment !== STATUS_COMMENT) problems.push(`${TABLE}.status already carries a different comment ("${st.comment}") — reconcile it here first`);

  return { problems, steps: problems.length ? [] : steps, done: !problems.length && steps.length === 0 };
}

function describeStep(st) {
  if (st.kind === 'add') return SQL.add(COLUMNS.find(c => c.name === st.name)).replace('?', `'<the ${st.name} comment>'`);
  if (st.kind === 'statusComment') return SQL.statusComment.replace('?', "'<the status comment>'");
  return st.kind;
}
const stepsKey = p => JSON.stringify(p.steps);

/** The end state every --apply must prove (first run and rerun alike). Returns problems. */
function verifyEndState(after, before) {
  const bad = [];
  const pa = plan(after);
  bad.push(...pa.problems);
  if (!pa.done) bad.push(`steps still pending: ${stepsKey(pa)}`);
  for (const spec of COLUMNS) if (!isTarget(spec, after.cols[spec.name])) bad.push(`${TABLE}.${spec.name} is ${describeCol(after.cols[spec.name])}, not the target`);
  if (!isStatus(after.status) || after.status.comment !== STATUS_COMMENT) bad.push(`${TABLE}.status is ${describeCol(after.status)} / "${after.status && after.status.comment}"`);
  if (after.rows < before.rows) bad.push(`${TABLE} has ${after.rows} rows, had ${before.rows}`);
  const want = ['created_at', 'claimed_at', 'completed_at', 'attempts'];
  const got = after.order.slice(after.order.indexOf('created_at'), after.order.indexOf('created_at') + want.length);
  if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`column order after created_at is [${got.join(', ')}], expected [${want.join(', ')}]`);
  return bad;
}

// ─────────────────────────────────────────────────────────────
// Smoke — rolled back: the defaults and the claim primitive on the live shape
// ─────────────────────────────────────────────────────────────

async function smoke(conn, log) {
  await conn.beginTransaction();
  let id = null;
  try {
    const [ins] = await conn.query({ sql: `/* hookS0:smoke-insert */ INSERT INTO \`${TABLE}\` (hook_id, slug, raw_input, status) VALUES (0, 'hookS0-smoke', JSON_OBJECT('smoke', TRUE), 'received')`, timeout: QUERY_TIMEOUT_MS });
    id = ins.insertId;
    const [row] = await q(conn, `/* hookS0:smoke-read */ SELECT claimed_at, completed_at, attempts FROM \`${TABLE}\` WHERE id = ?`, [id]);
    if (!row || row.claimed_at !== null || row.completed_at !== null || Number(row.attempts) !== 0) {
      throw new Error(`smoke: a fresh row reads ${JSON.stringify(row)}, expected claimed_at NULL, completed_at NULL, attempts 0`);
    }
    const claim = `/* hookS0:smoke-claim */ UPDATE \`${TABLE}\` SET claimed_at = NOW(3), attempts = attempts + 1 WHERE id = ? AND status = 'received' AND claimed_at IS NULL`;
    const [first] = await conn.query({ sql: claim, timeout: QUERY_TIMEOUT_MS }, [id]);
    if (first.affectedRows !== 1) throw new Error(`smoke: the first claim affected ${first.affectedRows} row(s), expected 1`);
    const [second] = await conn.query({ sql: claim, timeout: QUERY_TIMEOUT_MS }, [id]);
    if (second.affectedRows !== 0) throw new Error(`smoke: the second claim affected ${second.affectedRows} row(s), expected 0 — the at-least-once primitive does not hold`);
    const [after] = await q(conn, `/* hookS0:smoke-after */ SELECT attempts FROM \`${TABLE}\` WHERE id = ?`, [id]);
    if (Number(after.attempts) !== 1) throw new Error(`smoke: attempts is ${after.attempts} after one winning claim, expected 1`);
  } finally {
    await conn.rollback().catch(() => {});
  }
  const [left] = await q(conn, `/* hookS0:smoke-left */ SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE slug = 'hookS0-smoke'`);
  if (Number(left.n) !== 0) throw new Error(`smoke: the rolled-back row persisted in ${TABLE} — look now`);
  log('  ✓ smoke: a fresh row has claimed_at NULL / completed_at NULL / attempts 0; the claim UPDATE won once and lost once; rolled back');
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

const CMD = 'node scripts/hookAsyncReceiverS0.js';

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== Async hook receiver S0: hook_executions claim columns — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  if (!s.table) say(`${TABLE}: MISSING`);
  else {
    say(`${TABLE}: ${s.rows} row(s)`);
    for (const spec of COLUMNS) {
      const c = s.cols[spec.name];
      say(`  ${spec.name}: ${!c ? 'absent' : isTarget(spec, c) ? 'TARGET' : `UNEXPECTED (${describeCol(c)})`}`);
    }
    say(`  status: ${isStatus(s.status) ? 'live definition as expected' : `UNEXPECTED (${describeCol(s.status)})`}; comment ${s.status && s.status.comment === STATUS_COMMENT ? 'SET' : s.status && s.status.comment ? 'OTHER' : 'none'}`);
  }
  say(`triggers on ${TABLE}: ${s.tableTriggers.length ? s.tableTriggers.map(r => r.name).join(', ') : 'none'}; ` +
    `schema references to the new columns on ${TABLE}: ${s.refs.length ? s.refs.map(r => `${r.kind} ${r.name}`).join(', ') : 'none'}`);

  const p = plan(s);
  if (p.problems.length) {
    say('\nPROBLEMS:');
    for (const x of p.problems) say(`  - ${x}`);
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed. Fix them, then re-run ${CMD}`;
    say(`\n${line}`);
    return { ok: false, line, state: s };
  }
  if (p.done) {
    // Under --apply this may be the RERUN after a stopped verify or smoke
    // ("resumes from the live state"): the DDL is in place, so prove the rest
    // again before vouching for it. CHECK stays read-only and says so.
    if (apply) {
      try {
        const bad = verifyEndState(s, s);
        if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
        say('  ✓ verified: claimed_at, completed_at, attempts are the target after created_at; status comment set, definition unchanged');
        await smoke(conn, say);
      } catch (err) {
        say(`\n  ✗ ${err.message}`);
        const line = `NO-GO — the columns are in place but the end state or the smoke failed. Nothing was changed. Paste this output; re-run ${CMD} --apply once it is understood.`;
        say(`\n${line}`);
        return { ok: false, line, state: s, done: [] };
      }
    }
    const line = `ALREADY APPLIED — GO. The three columns and the status comment are in place${apply ? ', verified and smoke-tested again' : ''}; nothing to do. ` +
      'Next: deploy S1 (push the slice); the next commit regenerates ref/database.sql.';
    say(`\n${line}`);
    return { ok: true, line, state: s, done: true };
  }

  say('\nPLAN, in this order:');
  p.steps.forEach((st, i) => say(`  ${i + 1}. ${describeStep(st)}`));
  say('  then: re-read everything, verify the end state, smoke-test (rolled back)');

  if (!apply) {
    const line = `CHECK OK — GO. Next: ${CMD} --apply`;
    say(`\n${line}`);
    return { ok: true, line, state: s, plan: p };
  }

  say('');
  const done = [];
  try {
    await q(conn, SQL.lockWait);
    const s2 = await readState(conn);
    const p2 = plan(s2);
    if (p2.problems.length || stepsKey(p2) !== stepsKey(p)) {
      const e = new Error('the live state changed between the check and the apply:\n    - ' +
        (p2.problems.length ? p2.problems.join('\n    - ') : `plan was ${stepsKey(p)}, is now ${stepsKey(p2)}`));
      e.nothingChanged = true;
      throw e;
    }
    for (const st of p2.steps) {
      if (st.kind === 'add') {
        const spec = COLUMNS.find(c => c.name === st.name);
        await q(conn, SQL.add(spec), [spec.comment], DDL_TIMEOUT_MS);
        say(`  ✓ ${TABLE}: ADD COLUMN ${spec.name} ${spec.ddl}, INSTANT`);
      } else if (st.kind === 'statusComment') {
        await q(conn, SQL.statusComment, [STATUS_COMMENT], DDL_TIMEOUT_MS);
        say(`  ✓ ${TABLE}: COMMENT on status (definition restated, unchanged), INSTANT`);
      }
      done.push(st.kind === 'add' ? `add ${st.name}` : st.kind);
    }

    // ── verify the end state ──
    const after = await readState(conn);
    const bad = verifyEndState(after, s2);
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: claimed_at, completed_at, attempts are the target after created_at; status comment set, definition unchanged; ${after.rows} row(s)`);

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

  const line = 'APPLIED — GO. Next: verify read-only (information_schema.COLUMNS), then deploy S1 ' +
    '(push the slice); the next commit regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, done };
}

module.exports = { TABLE, COLUMNS, STATUS_TYPE, STATUS_DEF, STATUS_COMMENT, SQL, NAMES_RE, plan, readState, run, isTarget, isStatus, verifyEndState };

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
