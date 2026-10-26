#!/usr/bin/env node
// scripts/ingestRuleEditStampAndChangeLog.js
//
/**
 * A20 slice 1 (Fred's go, 2026-10-27) — give email + phone ingest rules an
 * EDIT STAMP and an append-only CHANGE LOG:
 *
 *   email_ingest_rules.definition_updated_at   ADD  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
 *   phone_ingest_rules.definition_updated_at   ADD  (same), backfilled from updated_at
 *   email_ingest_rules.updated_at              COMMENT — the landmine: not an edit stamp
 *   phone_ingest_rules.updated_at              COMMENT
 *   email_ingest_rule_changes                  CREATE TABLE IF NOT EXISTS
 *   phone_ingest_rule_changes                  CREATE TABLE IF NOT EXISTS
 *
 * Why: every MATCH bumps match_count with an UPDATE, so ON UPDATE
 * CURRENT_TIMESTAMP moves updated_at on busy rules all day, and an action edit
 * never touched the rule row — updated_at can't guard a stale edit. The code
 * that sets the stamp and writes the log is services/ingestRuleChangeLog.js.
 * The applied SQL is recorded in
 * ref/migrations/2026-10-27_ingest_rule_edit_stamp_change_log.sql.
 *
 * USAGE (from a checkout of the COMMITTED slice whose .env reaches production —
 * the same setup `npm run db:ref` uses; the Cloud SQL proxy is started if .env
 * opts in):
 *
 *   node scripts/ingestRuleEditStampAndChangeLog.js           # CHECK — read-only, prints the plan
 *   node scripts/ingestRuleEditStampAndChangeLog.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 *
 * ── ORDER: THIS FIRST, THEN THE BACKEND (SQL → backend) ──────────────────
 * The new code SELECTs definition_updated_at in every rule read and writes the
 * change tables on every rule edit. Deployed first, the rule editor's list /
 * get / save routes 500 ("Unknown column") — no row is written (each write is
 * one transaction whose first statement fails). Ingest itself is untouched:
 * evaluateRules and the match bump name neither the column nor the tables.
 *
 * ── THE BACKFILL, AND WHY THE COLUMN IS ADDED IN THREE STEPS ─────────────
 * Each pre-existing row's stamp is its updated_at: the last time the row was
 * written, by an edit OR a match — so an UPPER bound on its last edit, never
 * earlier than one (created_at would be a lower bound that claims "never
 * edited"; neither is the true time, which no column holds). The stamp's job
 * is the precondition, for which any value works; the COMMENT says this.
 *   1. ADD COLUMN with a SENTINEL default ('2000-01-01 00:00:00.000' — no
 *      rule predates 2026), ALGORITHM=INSTANT;
 *   2. MODIFY the default to CURRENT_TIMESTAMP(3), ALGORITHM=INSTANT — from
 *      here a row the old code inserts gets a real stamp;
 *   3. backfill every SENTINEL row from updated_at, assigning updated_at to
 *      itself so ON UPDATE cannot fire — in a transaction that re-reads the
 *      rows and rolls back unless every updated_at is unchanged.
 *   A run stopped anywhere resumes: the sentinel marks "not backfilled yet".
 *   (ADD COLUMN … DEFAULT CURRENT_TIMESTAMP(3) is INSTANT too, on 8.4.11, but
 *   fills every row with the ALTER's time — indistinguishable afterwards from
 *   a real stamp, so a resumed run could not tell what still needs filling.)
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - both rules tables exist; updated_at is exactly `datetime NOT NULL
 *     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`, with no comment
 *     or the target one;
 *   - definition_updated_at is absent, or exactly mid-run (datetime(3) NOT
 *     NULL, sentinel default, target comment), or exactly the target —
 *     anything else (a column someone added by hand) is a NO-GO;
 *   - each change table is absent, or has exactly the target columns, index,
 *     engine, collation and comment;
 *   - no trigger on any of the four tables, and nothing in the schema (view,
 *     trigger, routine, event, generated column) names the new column or the
 *     new tables.
 *   --apply asserts it all AGAIN on its own session after setting the lock
 *   timeouts, and stops if the plan changed in between.
 *
 * ── SESSION (one connection — never the SU console) ───────────────────────
 *   lock_wait_timeout = 5 and innodb_lock_wait_timeout = 5. An ALTER (even an
 *   INSTANT one) takes an exclusive metadata lock; queued behind a long
 *   transaction it would stall every query on the table for up to the global
 *   default (a year); the backfill's row locks would wait 50 s. A timeout here
 *   changes nothing and the re-run resumes.
 *   Every ALTER is ALGORITHM=INSTANT (metadata only; it fails rather than
 *   silently rebuilding if that ever stops being true). CREATE TABLE is a new
 *   empty table.
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   both columns are the target, with no sentinel row left; both updated_at
 *   comments are set and their definitions unchanged; both change tables are
 *   the target shape; the rule and action row counts did not drop. Smoke
 *   (rolled back): a match-shaped UPDATE (match_count + 1) does NOT move the
 *   stamp, and a change row inserts. Then deploy the backend; the next commit
 *   regenerates ref/database.sql.
 *
 * ── ROLLBACK ──────────────────────────────────────────────────────────────
 *   see the ROLLBACK section of the migration file.
 */

'use strict';

const CHANNELS = ['email', 'phone'];
const T = ch => ({ rules: `${ch}_ingest_rules`, actions: `${ch}_ingest_rule_actions`, changes: `${ch}_ingest_rule_changes` });

const COL = 'definition_updated_at';
const SENTINEL = '2000-01-01 00:00:00.000';
const STAMP_TYPE = 'datetime(3)';

const COL_COMMENT = 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). ' +
  'Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, ' +
  'inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. ' +
  'Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).';
const UPD_COMMENT = 'NOT an edit stamp: ON UPDATE moves it on every match (the match_count bump), and an action ' +
  'edit never moves it. The edit stamp is definition_updated_at.';
const UPD_DEF = 'datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP';
const tableComment = ch => `APPEND-ONLY change log of ${ch} ingest rule definitions: one row per real change ` +
  '(the rule fields or its action rows), before and after, with the actor, written inside the edit transaction ' +
  '(services/ingestRuleChangeLog.js). The app never UPDATEs or DELETEs a row.';

// The change table, column by column: [name, COLUMN_TYPE, nullable, extra-regex]. Checked
// against information_schema when the table already exists.
const CHANGE_COLUMNS = [
  ['id', 'bigint unsigned', 'NO', /auto_increment/i],
  ['rule_id', 'int unsigned', 'NO', null],
  ['change_kind', 'varchar(20)', 'NO', null],
  ['action_id', 'int unsigned', 'YES', null],
  ['duplicated_from_rule_id', 'int unsigned', 'YES', null],
  ['actor_user_id', 'int', 'YES', null],
  ['actor_key_id', 'int', 'YES', null],
  ['actor_label', 'varchar(255)', 'YES', null],
  ['changed_at', 'datetime(3)', 'NO', /DEFAULT_GENERATED/],
  ['definition_updated_at', 'datetime(3)', 'YES', null],
  ['before_json', 'json', 'YES', null],
  ['after_json', 'json', 'YES', null],
];

const createChangesSql = ch => `CREATE TABLE IF NOT EXISTS \`${T(ch).changes}\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`rule_id\` int unsigned NOT NULL COMMENT '${T(ch).rules}.id. No FK: the row outlives a deleted rule',
  \`change_kind\` varchar(20) NOT NULL COMMENT 'create|update|activate|deactivate|delete|duplicate|action_add|action_update|action_delete (app-validated)',
  \`action_id\` int unsigned DEFAULT NULL COMMENT 'the ${T(ch).actions} row, for the action_* kinds',
  \`duplicated_from_rule_id\` int unsigned DEFAULT NULL COMMENT 'duplicate: the source rule',
  \`actor_user_id\` int DEFAULT NULL COMMENT 'users.user of a staff JWT; NULL for an API key',
  \`actor_key_id\` int DEFAULT NULL COMMENT 'api_keys.id of a machine caller; NULL for staff and the internal key',
  \`actor_label\` varchar(255) DEFAULT NULL COMMENT 'the username, or api_key:<label>',
  \`changed_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`definition_updated_at\` datetime(3) DEFAULT NULL COMMENT 'the rule edit stamp AFTER this change; NULL for delete',
  \`before_json\` json DEFAULT NULL COMMENT '{rule, actions} before; NULL for create and duplicate. http url and literal header values redacted; over 256 KB a size + sha256 marker',
  \`after_json\` json DEFAULT NULL COMMENT '{rule, actions} after; NULL for delete. Same redaction and cap',
  PRIMARY KEY (\`id\`),
  KEY \`idx_rule_changed\` (\`rule_id\`,\`changed_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='${tableComment(ch)}'`;

const SQL = {
  lockWait:  'SET SESSION lock_wait_timeout = 5',
  rowWait:   'SET SESSION innodb_lock_wait_timeout = 5',
  add:       ch => `ALTER TABLE \`${T(ch).rules}\` ADD COLUMN \`${COL}\` DATETIME(3) NOT NULL DEFAULT '${SENTINEL}' COMMENT ? AFTER \`updated_at\`, ALGORITHM=INSTANT`,
  modify:    ch => `ALTER TABLE \`${T(ch).rules}\` MODIFY COLUMN \`${COL}\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT ?, ALGORITHM=INSTANT`,
  backfill:  ch => `UPDATE \`${T(ch).rules}\` SET \`${COL}\` = \`updated_at\`, \`updated_at\` = \`updated_at\` WHERE \`${COL}\` = '${SENTINEL}'`,
  updComment: ch => `ALTER TABLE \`${T(ch).rules}\` MODIFY COLUMN \`updated_at\` ${UPD_DEF} COMMENT ?, ALGORITHM=INSTANT`,
  create:    createChangesSql,
};

const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS   = 120_000;

const NAMES_RE = /(^|[^A-Za-z0-9_])(definition_updated_at|email_ingest_rule_changes|phone_ingest_rule_changes)([^A-Za-z0-9_]|$)/i;
const norm = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');

async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const [who] = await q(conn, '/* a20s1:who */ SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v');
  const names = CHANNELS.flatMap(ch => [T(ch).rules, T(ch).actions, T(ch).changes]);
  const tables = await q(conn,
    '/* a20s1:tables */ SELECT TABLE_NAME AS t, ENGINE AS engine, TABLE_COLLATION AS coll, TABLE_COMMENT AS cmt ' +
    'FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)', [names]);
  const cols = await q(conn,
    '/* a20s1:columns */ SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, ' +
    'COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS cmt, EXTRA AS extra, GENERATION_EXPRESSION AS gen ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION',
    [names]);
  const idx = await q(conn,
    '/* a20s1:indexes */ SELECT TABLE_NAME AS t, INDEX_NAME AS i, SEQ_IN_INDEX AS seq, COLUMN_NAME AS c ' +
    'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
    [CHANNELS.map(ch => T(ch).changes)]);

  // Matched in JS, not REGEXP in SQL: information_schema text columns carry
  // their own collations (the optout / S5b scripts' reason).
  const triggers = await q(conn, '/* a20s1:triggers */ SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_STATEMENT AS def FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
  const views    = await q(conn, '/* a20s1:views */ SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()');
  const gens     = await q(conn, "/* a20s1:generated */ SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS name, GENERATION_EXPRESSION AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND GENERATION_EXPRESSION <> ''");
  const routines = await q(conn, '/* a20s1:routines */ SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
  const events   = await q(conn, '/* a20s1:events */ SELECT EVENT_NAME AS name, EVENT_DEFINITION AS def FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()');

  const refs = [];
  for (const [kind, list] of [['trigger', triggers], ['view', views], ['generated column', gens], ['routine', routines], ['event', events]]) {
    for (const r of list) if (NAMES_RE.test(norm(r.def))) refs.push({ kind, name: r.name });
  }
  const tableTriggers = triggers.filter(r => names.includes(String(r.tbl))).map(r => ({ name: r.name, table: r.tbl }));

  const col = (t, c) => {
    const r = cols.find(x => x.t === t && String(x.c).toLowerCase() === c);
    return r ? { type: String(r.type).toLowerCase(), nullable: r.nullable, dflt: r.dflt == null ? null : String(r.dflt),
                 comment: r.cmt == null ? '' : String(r.cmt), extra: String(r.extra || ''), gen: String(r.gen || '') } : null;
  };

  const per = {};
  for (const ch of CHANNELS) {
    const t = T(ch);
    const tbl = tables.find(x => x.t === t.rules);
    const chg = tables.find(x => x.t === t.changes);
    const stamp = col(t.rules, COL);
    let rows = null, sentinelRows = null, actions = null;
    if (tbl) {
      const [r] = await q(conn, `/* a20s1:count */ SELECT COUNT(*) AS n FROM \`${t.rules}\``);
      rows = Number(r.n);
      const [a] = await q(conn, `/* a20s1:count-actions */ SELECT COUNT(*) AS n FROM \`${t.actions}\``);
      actions = Number(a.n);
      if (stamp) {
        const [s] = await q(conn, `/* a20s1:sentinel */ SELECT COUNT(*) AS n FROM \`${t.rules}\` WHERE \`${COL}\` = '${SENTINEL}'`);
        sentinelRows = Number(s.n);
      }
    }
    per[ch] = {
      rulesTable: !!tbl,
      rows, actions, sentinelRows,
      stamp,
      updatedAt: col(t.rules, 'updated_at'),
      changes: chg ? {
        engine: chg.engine, coll: chg.coll, comment: chg.cmt == null ? '' : String(chg.cmt),
        cols: cols.filter(x => x.t === t.changes).map(x => ({ c: String(x.c), type: String(x.type).toLowerCase(),
          nullable: x.nullable, extra: String(x.extra || '') })),
        idx: idx.filter(x => x.t === t.changes).map(x => `${x.i}:${x.seq}:${x.c}`),
      } : null,
    };
  }
  return { user: who.cu, db: who.db, version: who.v, per, refs, tableTriggers };
}

// ─────────────────────────────────────────────────────────────
// Deciding — pure, so the tests can drive every branch
// ─────────────────────────────────────────────────────────────

function describeCol(c) {
  return c ? `${c.type} ${c.nullable === 'NO' ? 'NOT NULL' : 'NULL'} DEFAULT ${c.dflt == null ? 'NULL' : c.dflt}` +
    `${c.extra ? ` [${c.extra}]` : ''}${c.gen ? ` AS (${c.gen})` : ''}` : 'missing';
}
const plainStamp = c => !!c && c.type === STAMP_TYPE && c.nullable === 'NO' && c.gen === '' && !/on update|auto_increment|generated (always|stored|virtual)|VIRTUAL|STORED/i.test(c.extra);
const isMidRun   = c => plainStamp(c) && c.dflt === SENTINEL && c.comment === COL_COMMENT;
const isTarget   = c => plainStamp(c) && /^CURRENT_TIMESTAMP\(3\)$/i.test(String(c.dflt)) && /DEFAULT_GENERATED/i.test(c.extra) && c.comment === COL_COMMENT;
const isUpdatedAt = c => !!c && c.type === 'datetime' && c.nullable === 'NO' && /^CURRENT_TIMESTAMP$/i.test(String(c.dflt)) &&
  /on update CURRENT_TIMESTAMP/i.test(c.extra) && c.gen === '';

const EXPECTED_IDX = ['PRIMARY:1:id', 'idx_rule_changed:1:rule_id', 'idx_rule_changed:2:changed_at'];

function changesProblems(ch, c) {
  const out = [];
  const name = T(ch).changes;
  if (c.engine !== 'InnoDB') out.push(`${name} engine is ${c.engine}, expected InnoDB`);
  if (c.coll !== 'utf8mb4_general_ci') out.push(`${name} collation is ${c.coll}, expected utf8mb4_general_ci (ref/SCHEMA_CONVENTIONS.md)`);
  if (c.comment !== tableComment(ch)) out.push(`${name} carries a different table comment ("${c.comment}")`);
  const got = c.cols.map(x => x.c);
  const want = CHANGE_COLUMNS.map(x => x[0]);
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${name} has columns [${got.join(', ')}], expected [${want.join(', ')}]`);
  else {
    CHANGE_COLUMNS.forEach(([cn, type, nullable, extra], i) => {
      const x = c.cols[i];
      if (x.type !== type || x.nullable !== nullable || (extra && !extra.test(x.extra))) {
        out.push(`${name}.${cn} is ${x.type} ${x.nullable === 'NO' ? 'NOT NULL' : 'NULL'} [${x.extra}], expected ${type} ${nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
      }
    });
  }
  const gotIdx = [...c.idx].sort();
  if (JSON.stringify(gotIdx) !== JSON.stringify([...EXPECTED_IDX].sort())) out.push(`${name} indexes are [${gotIdx.join(', ')}], expected [${EXPECTED_IDX.join(', ')}]`);
  return out;
}

/**
 * @returns {{ problems: string[], steps: Array<{kind, ch}>, done: boolean }}
 *   step kinds: add | modify | backfill | updComment | create  (per channel, in this order)
 */
function plan(s) {
  const problems = [];
  const steps = [];
  for (const r of s.tableTriggers) problems.push(`trigger ${r.name} on ${r.table} — this migration expects none on the ingest rule tables; read it first`);
  for (const r of s.refs) problems.push(`${r.kind} ${r.name} already names ${COL} or a change table — find out what wrote it before going on`);

  for (const ch of CHANNELS) {
    const p = s.per[ch];
    const t = T(ch);
    if (!p.rulesTable) { problems.push(`there is no \`${t.rules}\` table in this database — wrong database?`); continue; }

    const u = p.updatedAt;
    if (!isUpdatedAt(u)) problems.push(`${t.rules}.updated_at is ${describeCol(u)}, expected ${UPD_DEF} — the comment MODIFY would change it`);
    else if (u.comment !== UPD_COMMENT && u.comment !== '') problems.push(`${t.rules}.updated_at already carries a different comment ("${u.comment}") — reconcile it here first`);

    const c = p.stamp;
    if (!c) steps.push({ kind: 'add', ch }, { kind: 'modify', ch }, { kind: 'backfill', ch });
    else if (isMidRun(c)) steps.push({ kind: 'modify', ch }, { kind: 'backfill', ch });
    else if (isTarget(c)) { if (p.sentinelRows > 0) steps.push({ kind: 'backfill', ch }); }
    else problems.push(`${t.rules}.${COL} already exists as ${describeCol(c)}${c.comment !== COL_COMMENT ? ' with another comment' : ''} — ` +
      'not this migration\'s column (absent, mid-run, or the target); find out who added it');

    if (isUpdatedAt(u) && u.comment === '') steps.push({ kind: 'updComment', ch });

    if (!p.changes) steps.push({ kind: 'create', ch });
    else problems.push(...changesProblems(ch, p.changes));
  }
  return { problems, steps: problems.length ? [] : steps, done: !problems.length && steps.length === 0 };
}

function describeStep(st) {
  switch (st.kind) {
    case 'add':        return SQL.add(st.ch).replace('?', "'<the edit-stamp comment>'");
    case 'modify':     return SQL.modify(st.ch).replace('?', "'<the edit-stamp comment>'");
    case 'backfill':   return `${SQL.backfill(st.ch)}  (in a transaction; rolled back unless every updated_at is unchanged)`;
    case 'updComment': return SQL.updComment(st.ch).replace('?', "'<the not-an-edit-stamp comment>'");
    case 'create':     return `CREATE TABLE IF NOT EXISTS \`${T(st.ch).changes}\` (… see the migration file)`;
    default:           return st.kind;
  }
}
const stepsKey = p => JSON.stringify(p.steps);

// ─────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────

/** Backfill under row locks; commit only if no updated_at moved. Returns the row count. */
async function backfill(conn, ch) {
  const t = T(ch);
  await conn.beginTransaction();
  try {
    const before = await q(conn, `/* a20s1:bf-before */ SELECT id, updated_at FROM \`${t.rules}\` WHERE \`${COL}\` = '${SENTINEL}' ORDER BY id FOR UPDATE`);
    const [res] = await conn.query({ sql: SQL.backfill(ch), timeout: QUERY_TIMEOUT_MS });
    const ids = before.map(r => r.id);
    const after = ids.length
      ? await q(conn, `/* a20s1:bf-after */ SELECT id, updated_at, \`${COL}\` AS stamp FROM \`${t.rules}\` WHERE id IN (?) ORDER BY id`, [ids])
      : [];
    const bad = [];
    if (res.affectedRows !== ids.length) bad.push(`the UPDATE touched ${res.affectedRows} row(s), ${ids.length} were locked`);
    for (const b of before) {
      const a = after.find(x => x.id === b.id);
      if (!a) { bad.push(`rule ${b.id} vanished`); continue; }
      if (+a.updated_at !== +b.updated_at) bad.push(`rule ${b.id} updated_at moved ${b.updated_at.toISOString()} → ${a.updated_at.toISOString()}`);
      if (+a.stamp !== +b.updated_at) bad.push(`rule ${b.id} stamp is ${a.stamp && a.stamp.toISOString()}, expected ${b.updated_at.toISOString()}`);
    }
    const [{ n: left }] = await q(conn, `/* a20s1:bf-left */ SELECT COUNT(*) AS n FROM \`${t.rules}\` WHERE \`${COL}\` = '${SENTINEL}'`);
    if (Number(left) !== 0) bad.push(`${left} sentinel row(s) left`);
    if (bad.length) {
      await conn.rollback();
      const e = new Error(`backfill of ${t.rules} rolled back: ${bad.join('; ')}`);
      throw e;
    }
    await conn.commit();
    return ids.length;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  }
}

/** Rolled back: a match-shaped UPDATE must not move the stamp; a change row must insert. */
async function smoke(conn, ch, log) {
  const t = T(ch);
  const [r] = await q(conn, `/* a20s1:smoke-pick */ SELECT id, match_count, \`${COL}\` AS stamp FROM \`${t.rules}\` ORDER BY id LIMIT 1`);
  await conn.beginTransaction();
  try {
    if (r) {
      await q(conn, `/* a20s1:smoke-bump */ UPDATE \`${t.rules}\` SET match_count = match_count + 1, last_matched_at = NOW() WHERE id = ?`, [r.id]);
      const [a] = await q(conn, `/* a20s1:smoke-read */ SELECT match_count, \`${COL}\` AS stamp FROM \`${t.rules}\` WHERE id = ?`, [r.id]);
      if (Number(a.match_count) !== Number(r.match_count) + 1) throw new Error(`smoke: rule ${r.id} match_count did not move`);
      if (+a.stamp !== +r.stamp) throw new Error(`smoke: a match bump MOVED rule ${r.id}'s ${COL} — the column is not the edit stamp`);
    }
    const [ins] = await conn.query({ sql: `/* a20s1:smoke-insert */ INSERT INTO \`${t.changes}\` (rule_id, change_kind, after_json) VALUES (0, 'create', JSON_OBJECT('smoke', TRUE))`, timeout: QUERY_TIMEOUT_MS });
    if (ins.affectedRows !== 1) throw new Error(`smoke: the change-row insert affected ${ins.affectedRows} row(s)`);
  } finally {
    await conn.rollback().catch(() => {});
  }
  const [after] = await q(conn, `/* a20s1:smoke-after */ SELECT COUNT(*) AS n FROM \`${t.changes}\` WHERE rule_id = 0 AND JSON_EXTRACT(after_json, '$.smoke') = TRUE`);
  if (Number(after.n) !== 0) throw new Error(`smoke: the rolled-back change row persisted in ${t.changes} — look now`);
  if (r) {
    const [b] = await q(conn, `/* a20s1:smoke-after-rule */ SELECT match_count FROM \`${t.rules}\` WHERE id = ?`, [r.id]);
    if (Number(b.match_count) < Number(r.match_count)) throw new Error(`smoke: rule ${r.id} match_count went backwards — look now`);
  }
  log(`  ✓ smoke ${ch}: ${r ? `a match-shaped bump on rule ${r.id} left ${COL} alone; ` : ''}a change row inserted; both rolled back`);
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

const CMD = 'node scripts/ingestRuleEditStampAndChangeLog.js';

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== A20 slice 1: ingest rule edit stamp + change log — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  for (const ch of CHANNELS) {
    const p = s.per[ch];
    const t = T(ch);
    if (!p.rulesTable) { say(`${t.rules}: MISSING`); continue; }
    const c = p.stamp;
    say(`${t.rules}: ${p.rows} rule(s), ${p.actions} action(s); ${COL} ${!c ? 'absent' : isTarget(c) ? 'TARGET' : isMidRun(c) ? 'mid-run (sentinel default)' : `UNEXPECTED (${describeCol(c)})`}` +
      `${p.sentinelRows ? `, ${p.sentinelRows} row(s) not yet backfilled` : ''}; updated_at comment ${p.updatedAt && p.updatedAt.comment === UPD_COMMENT ? 'SET' : p.updatedAt && p.updatedAt.comment ? 'OTHER' : 'none'}`);
    say(`${t.changes}: ${p.changes ? `present (${p.changes.cols.length} columns)` : 'absent'}`);
  }
  say(`triggers on these tables: ${s.tableTriggers.length ? s.tableTriggers.map(r => r.name).join(', ') : 'none'}; ` +
    `schema references to the new names: ${s.refs.length ? s.refs.map(r => `${r.kind} ${r.name}`).join(', ') : 'none'}`);

  const p = plan(s);
  if (p.problems.length) {
    say('\nPROBLEMS:');
    for (const x of p.problems) say(`  - ${x}`);
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed. Fix them, then re-run ${CMD}`;
    say(`\n${line}`);
    return { ok: false, line, state: s };
  }
  if (p.done) {
    const line = 'ALREADY APPLIED — GO. Both stamps, both comments and both change tables are in place; nothing to do. ' +
      'Next: deploy the backend (push the slice); the next commit regenerates ref/database.sql.';
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
    await q(conn, SQL.rowWait);
    const s2 = await readState(conn);
    const p2 = plan(s2);
    if (p2.problems.length || stepsKey(p2) !== stepsKey(p)) {
      const e = new Error('the live state changed between the check and the apply:\n    - ' +
        (p2.problems.length ? p2.problems.join('\n    - ') : `plan was ${stepsKey(p)}, is now ${stepsKey(p2)}`));
      e.nothingChanged = true;
      throw e;
    }
    for (const st of p2.steps) {
      const t = T(st.ch);
      if (st.kind === 'add') {
        await q(conn, SQL.add(st.ch), [COL_COMMENT], DDL_TIMEOUT_MS);
        say(`  ✓ ${t.rules}: ADD COLUMN ${COL} (sentinel default), INSTANT`);
      } else if (st.kind === 'modify') {
        await q(conn, SQL.modify(st.ch), [COL_COMMENT], DDL_TIMEOUT_MS);
        say(`  ✓ ${t.rules}: ${COL} DEFAULT CURRENT_TIMESTAMP(3), INSTANT`);
      } else if (st.kind === 'backfill') {
        const n = await backfill(conn, st.ch);
        say(`  ✓ ${t.rules}: backfilled ${n} row(s) from updated_at (every updated_at unchanged)`);
      } else if (st.kind === 'updComment') {
        await q(conn, SQL.updComment(st.ch), [UPD_COMMENT], DDL_TIMEOUT_MS);
        say(`  ✓ ${t.rules}: COMMENT on updated_at, INSTANT`);
      } else if (st.kind === 'create') {
        await q(conn, SQL.create(st.ch), [], DDL_TIMEOUT_MS);
        say(`  ✓ CREATE TABLE ${t.changes}`);
      }
      done.push(`${st.kind} ${st.ch}`);
    }

    // ── verify the end state ──
    const after = await readState(conn);
    const bad = [];
    const pa = plan(after);
    bad.push(...pa.problems);
    if (!pa.done) bad.push(`steps still pending: ${stepsKey(pa)}`);
    for (const ch of CHANNELS) {
      const a = after.per[ch];
      const b = s2.per[ch];
      if (!isTarget(a.stamp)) bad.push(`${T(ch).rules}.${COL} is ${describeCol(a.stamp)}, not the target`);
      if (a.sentinelRows !== 0) bad.push(`${T(ch).rules} still has ${a.sentinelRows} sentinel row(s)`);
      if (!isUpdatedAt(a.updatedAt) || a.updatedAt.comment !== UPD_COMMENT) bad.push(`${T(ch).rules}.updated_at is ${describeCol(a.updatedAt)} / "${a.updatedAt && a.updatedAt.comment}"`);
      if (!a.changes) bad.push(`${T(ch).changes} is missing`);
      if (a.rows < b.rows) bad.push(`${T(ch).rules} has ${a.rows} rows, had ${b.rows}`);
      if (a.actions < b.actions) bad.push(`${T(ch).actions} has ${a.actions} rows, had ${b.actions}`);
    }
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: both stamps are the target with no sentinel row, both updated_at comments set (definition unchanged), ` +
      `both change tables the target shape; ${CHANNELS.map(ch => `${after.per[ch].rows} ${ch} rule(s)`).join(', ')}`);

    for (const ch of CHANNELS) await smoke(conn, ch, say);
  } catch (err) {
    say(`\n  ✗ ${err.message}`);
    const line = err.nothingChanged
      ? `NO-GO — nothing was changed. Paste this output; re-run ${CMD} once it is understood.`
      : `NO-GO — stopped ${done.length ? `after: ${done.join('; ')}` : 'before any change'}. ` +
        `Re-running ${CMD} --apply resumes from the live state.`;
    say(`\n${line}`);
    return { ok: false, line, state: s, done };
  }

  const line = 'APPLIED — GO. Next: verify read-only (information_schema.COLUMNS / TABLES), then deploy the backend ' +
    '(push the slice); the next commit regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, done };
}

module.exports = { CHANNELS, COL, SENTINEL, COL_COMMENT, UPD_COMMENT, CHANGE_COLUMNS, SQL, tableComment, plan, readState, run, isTarget, isMidRun };

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
