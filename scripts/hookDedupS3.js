#!/usr/bin/env node
// scripts/hookDedupS3.js
//
/**
 * Async hook receiver S3 (Fred's go 2026-10-27, "build") — dedup inbound
 * webhooks on the PROVIDER's event id:
 *
 *   hooks.dedup_path             ADD  VARCHAR(100) NULL       — dot-path into the event (e.g. body.uuid)
 *   hook_executions.dedup_key    ADD  VARCHAR(191) NULL       — the resolved id, NULL when no path / no value
 *   hook_executions              ADD UNIQUE KEY uq_hook_dedup (hook_id, dedup_key)
 *   hooks 16, 17 (quo-message, quo-call)                 SET dedup_path = 'body.id'
 *   hooks 21, 22, 23 (rc-message-in, rc-message-out, rc-call)  SET dedup_path = 'body.uuid'
 *
 * Why: RingCentral stamps every event with a unique `body.uuid` (0 duplicates
 * in 30 days) but Quo redelivers: 5 groups of duplicate `body.id` in 14 days,
 * mostly 0–5 s apart, every copy delivered, workflows started twice (Casey
 * manager, 2026-10-27). Quo sends no `webhook-id` header; `body.id` is its
 * event id. The receiver (routes/api.hooks.js → hookService.recordExecution)
 * resolves the hook's dedup_path against the event, stores it as dedup_key,
 * and a second INSERT with the same (hook_id, dedup_key) fails on the unique
 * key: the duplicate is answered 200 {status:'received'} with no row and
 * nothing rung. NULL keys never collide (MySQL UNIQUE ignores NULLs), so a
 * hook without a path, or an event without the field, behaves exactly as
 * before. The applied SQL is recorded in
 * ref/migrations/2026-10-27_hook_dedup_key.sql.
 *
 * USAGE (from a checkout of the COMMITTED slice whose .env reaches production):
 *
 *   node scripts/hookDedupS3.js           # CHECK — read-only, prints the plan
 *   node scripts/hookDedupS3.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 *
 * ── ORDER: THIS FIRST, THEN THE BACKEND (SQL → backend) ──────────────────
 * S3's recordExecution names dedup_key in every INSERT and getHookBySlug's
 * SELECT * carries dedup_path to it. Deployed first, every inbound webhook
 * would 500 on an unknown column while still being answered 200 — events
 * LOST. Today's code never names either column, so this migration is
 * invisible to the running app (the seeded dedup_path is read by nobody until
 * S3 deploys). The seeding is deliberately part of the migration: without it
 * the slice ships inert.
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - both tables exist; each new column is absent or EXACTLY the target
 *     (dedup_key including its utf8mb4_bin collation);
 *   - the unique key is absent or exactly (hook_id, dedup_key); no other key
 *     named uq_hook_dedup;
 *   - no existing rows could collide: hook_executions.dedup_key is NULL on
 *     every row when the column exists (it does not exist yet at this
 *     writing, so this guards a re-run);
 *   - the five seeded hooks exist with their expected slugs and have
 *     dedup_path NULL or the target value — any other value is a NO-GO
 *     (someone configured it by hand; do not overwrite);
 *   - no trigger on either table, nothing in the schema naming the new
 *     columns.
 *   --apply asserts it all AGAIN on its own session after setting the lock
 *   timeout, and stops if the plan changed in between.
 *
 * ── SESSION (one connection — never the SU console) ───────────────────────
 *   lock_wait_timeout = 2 (the receiver INSERTs into hook_executions ~170
 *   times a day; a waiting ALTER queues each one behind it and RingCentral
 *   allows 3 s). The two ADD COLUMNs are ALGORITHM=INSTANT. The UNIQUE KEY is
 *   ALGORITHM=INPLACE, LOCK=NONE — an online index build over ~35k rows
 *   (seconds); concurrent INSERTs proceed. It cannot fail on duplicates: the
 *   column it indexes is NULL everywhere at that moment (asserted).
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   both columns and the key are the target; the five hooks carry their
 *   paths; no row count dropped. Smoke (rolled back): two INSERTs with the
 *   same (hook_id, dedup_key) — the second fails with ER_DUP_ENTRY; two with
 *   NULL keys both succeed. Then deploy S3.
 *
 * ── ROLLBACK ──────────────────────────────────────────────────────────────
 *   see the ROLLBACK section of the migration file.
 */

'use strict';

const T_HOOKS = 'hooks';
const T_EXEC = 'hook_executions';
const UQ = 'uq_hook_dedup';

const PATH_COL = {
  table: T_HOOKS, name: 'dedup_path', after: 'transform_config',
  ddl: 'VARCHAR(100) NULL DEFAULT NULL',
  type: 'varchar(100)', nullable: 'YES', dflt: null,
  comment: 'Async hook receiver S3 (2026-10-27): dot-path into the received event ({body,headers,query,method,meta}) ' +
    'of the PROVIDER event id — RingCentral body.uuid, Quo body.id. The receiver stores the resolved value as ' +
    'hook_executions.dedup_key; a second event with the same id for this hook is answered 200 and NOT recorded ' +
    '(no row, nothing runs). NULL = no dedup. Edited in the hook editor (Filter tab).',
};
// utf8mb4_bin: provider ids are opaque, case-sensitive strings (Quo's are
// mixed-case base62); the table default utf8mb4_general_ci would fold
// 'EVabc' and 'EVABC' together — and PAD SPACE 'EVabc ' — so a second,
// legitimate event could be refused as a duplicate. Same precedent as
// documents.external_id (CLAUDE.md, Collation).
const KEY_COL = {
  table: T_EXEC, name: 'dedup_key', after: 'attempts',
  ddl: 'VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL',
  type: 'varchar(191)', nullable: 'YES', dflt: null, collation: 'utf8mb4_bin',
  comment: 'Async hook receiver S3 (2026-10-27): the provider event id resolved from hooks.dedup_path at receipt ' +
    '(longer than 191 chars: sha256 hex). UNIQUE with hook_id — a redelivered event fails its INSERT and is answered 200 ' +
    'with no row. NULL when the hook has no path, the event no value, or the row was written by a synchronous run ' +
    '(live-test, replay, kill-switch path) — NULLs never collide.',
};
const COLUMNS = [PATH_COL, KEY_COL];

// The seeded paths: id → { slug, path }. Asserted by slug before any write.
const SEEDS = Object.freeze({
  16: { slug: 'quo-message', path: 'body.id' },
  17: { slug: 'quo-call', path: 'body.id' },
  21: { slug: 'rc-message-in', path: 'body.uuid' },
  22: { slug: 'rc-message-out', path: 'body.uuid' },
  23: { slug: 'rc-call', path: 'body.uuid' },
});

const SQL = {
  lockWait: 'SET SESSION lock_wait_timeout = 2',
  add: c => `ALTER TABLE \`${c.table}\` ADD COLUMN \`${c.name}\` ${c.ddl} COMMENT ? AFTER \`${c.after}\`, ALGORITHM=INSTANT`,
  addKey: `ALTER TABLE \`${T_EXEC}\` ADD UNIQUE KEY \`${UQ}\` (\`hook_id\`, \`dedup_key\`), ALGORITHM=INPLACE, LOCK=NONE`,
  seed: `UPDATE \`${T_HOOKS}\` SET dedup_path = ?, updated_at = updated_at WHERE id = ? AND slug = ? AND dedup_path IS NULL`,
};

const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS = 300_000;

const NAMES_RE = /(^|[^A-Za-z0-9_])(dedup_path|dedup_key|uq_hook_dedup)([^A-Za-z0-9_]|$)/i;
const norm = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');

async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const [who] = await q(conn, '/* hookS3:who */ SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v');
  const tables = await q(conn,
    '/* hookS3:tables */ SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)', [[T_HOOKS, T_EXEC]]);
  const cols = await q(conn,
    '/* hookS3:columns */ SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, ' +
    'COLUMN_COMMENT AS cmt, EXTRA AS extra, GENERATION_EXPRESSION AS gen, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION', [[T_HOOKS, T_EXEC]]);
  const idx = await q(conn,
    '/* hookS3:indexes */ SELECT INDEX_NAME AS i, SEQ_IN_INDEX AS seq, COLUMN_NAME AS c, NON_UNIQUE AS nu ' +
    'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX', [T_EXEC, UQ]);
  const triggers = await q(conn, '/* hookS3:triggers */ SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_STATEMENT AS def FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
  const views    = await q(conn, '/* hookS3:views */ SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()');
  const routines = await q(conn, '/* hookS3:routines */ SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
  const events   = await q(conn, '/* hookS3:events */ SELECT EVENT_NAME AS name, EVENT_DEFINITION AS def FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()');

  const refs = [];
  for (const [kind, list] of [['trigger', triggers], ['view', views], ['routine', routines], ['event', events]]) {
    for (const r of list) if (NAMES_RE.test(norm(r.def))) refs.push({ kind, name: r.name });
  }
  const tableTriggers = triggers.filter(r => [T_HOOKS, T_EXEC].includes(String(r.tbl))).map(r => ({ name: r.name, table: r.tbl }));

  const col = (t, name) => {
    const r = cols.find(x => x.t === t && String(x.c).toLowerCase() === name);
    return r ? { type: String(r.type).toLowerCase(), nullable: r.nullable, dflt: r.dflt == null ? null : String(r.dflt),
                 comment: r.cmt == null ? '' : String(r.cmt), extra: String(r.extra || ''), gen: String(r.gen || ''),
                 charset: r.cs == null ? null : String(r.cs), collation: r.coll == null ? null : String(r.coll) } : null;
  };
  const has = t => tables.some(x => x.t === t);

  let execRows = null, keyedRows = null, hooks = {};
  if (has(T_EXEC)) {
    const [r] = await q(conn, `/* hookS3:count */ SELECT COUNT(*) AS n FROM \`${T_EXEC}\``);
    execRows = Number(r.n);
    if (col(T_EXEC, 'dedup_key')) {
      const [k] = await q(conn, `/* hookS3:keyed */ SELECT COUNT(*) AS n FROM \`${T_EXEC}\` WHERE dedup_key IS NOT NULL`);
      keyedRows = Number(k.n);
    }
  }
  if (has(T_HOOKS)) {
    const pathCol = col(T_HOOKS, 'dedup_path');
    const rows = await q(conn, `/* hookS3:seeds */ SELECT id, slug${pathCol ? ', dedup_path' : ''} FROM \`${T_HOOKS}\` WHERE id IN (?)`, [Object.keys(SEEDS).map(Number)]);
    for (const r of rows) hooks[r.id] = { slug: String(r.slug), path: pathCol ? (r.dedup_path == null ? null : String(r.dedup_path)) : undefined };
  }
  return {
    user: who.cu, db: who.db, version: who.v,
    tables: { hooks: has(T_HOOKS), exec: has(T_EXEC) },
    cols: { dedup_path: col(T_HOOKS, 'dedup_path'), dedup_key: col(T_EXEC, 'dedup_key') },
    key: idx.map(x => ({ seq: Number(x.seq), c: String(x.c), unique: Number(x.nu) === 0 })),
    execRows, keyedRows, hooks, refs, tableTriggers,
  };
}

// ─────────────────────────────────────────────────────────────
// Deciding — pure, so the tests can drive every branch
// ─────────────────────────────────────────────────────────────

function describeCol(c) {
  return c ? `${c.type} ${c.nullable === 'NO' ? 'NOT NULL' : 'NULL'} DEFAULT ${c.dflt == null ? 'NULL' : c.dflt}` +
    `${c.extra ? ` [${c.extra}]` : ''}${c.gen ? ` AS (${c.gen})` : ''}` : 'missing';
}
const plainCol = c => !!c && c.gen === '' && !/on update|auto_increment|generated (always|stored|virtual)|VIRTUAL|STORED|DEFAULT_GENERATED/i.test(c.extra);
const isTarget = (spec, c) => plainCol(c) && c.type === spec.type && c.nullable === spec.nullable && c.dflt === spec.dflt && c.comment === spec.comment &&
  (!spec.collation || c.collation === spec.collation);
const isTargetKey = k => k.length === 2 && k[0].c === 'hook_id' && k[1].c === 'dedup_key' && k.every(x => x.unique);

/**
 * @returns {{ problems: string[], steps: Array<{kind, name?, id?}>, done: boolean }}
 *   step kinds: add (dedup_path | dedup_key) | addKey | seed (per hook id, in SEEDS order)
 */
function plan(s) {
  const problems = [];
  const steps = [];
  if (!s.tables.hooks) problems.push(`there is no \`${T_HOOKS}\` table in this database — wrong database?`);
  if (!s.tables.exec) problems.push(`there is no \`${T_EXEC}\` table in this database — wrong database?`);
  if (problems.length) return { problems, steps, done: false };

  for (const r of s.tableTriggers) problems.push(`trigger ${r.name} on ${r.table} — this migration expects none; read it first`);
  for (const r of s.refs) problems.push(`${r.kind} ${r.name} already names dedup_path / dedup_key / ${UQ} — find out what wrote it before going on`);

  for (const spec of COLUMNS) {
    const c = s.cols[spec.name];
    if (!c) steps.push({ kind: 'add', name: spec.name });
    else if (!isTarget(spec, c)) problems.push(`${spec.table}.${spec.name} already exists as ${describeCol(c)}${c.comment !== spec.comment ? ' with another comment' : ''} — ` +
      'not this migration\'s column (absent or the target); find out who added it');
  }

  if (!s.key.length) steps.push({ kind: 'addKey' });
  else if (!isTargetKey(s.key)) problems.push(`${T_EXEC} already has an index named ${UQ} on [${s.key.map(x => x.c).join(', ')}]${s.key.every(x => x.unique) ? '' : ' (not unique)'} — not this migration's key`);
  // The key is built over a column that must be NULL everywhere (no collision
  // is possible, and no row from before S3 may carry a key the code did not
  // write).
  if (s.cols.dedup_key && s.keyedRows > 0 && !s.key.length) problems.push(`${s.keyedRows} row(s) of ${T_EXEC} already carry a dedup_key before the unique key exists — find out who wrote them`);

  for (const [id, seed] of Object.entries(SEEDS)) {
    const h = s.hooks[id];
    if (!h) { problems.push(`hook ${id} (${seed.slug}) does not exist — the seed list is stale`); continue; }
    if (h.slug !== seed.slug) { problems.push(`hook ${id} is "${h.slug}", expected "${seed.slug}" — the seed list is stale`); continue; }
    if (h.path === undefined || h.path === null) steps.push({ kind: 'seed', id: Number(id) });
    else if (h.path !== seed.path) problems.push(`hook ${id} (${seed.slug}) already has dedup_path "${h.path}" — someone set it by hand; not overwriting`);
  }
  return { problems, steps: problems.length ? [] : steps, done: !problems.length && steps.length === 0 };
}

function describeStep(st) {
  if (st.kind === 'add') return SQL.add(COLUMNS.find(c => c.name === st.name)).replace('?', `'<the ${st.name} comment>'`);
  if (st.kind === 'addKey') return SQL.addKey;
  if (st.kind === 'seed') return SQL.seed.replace('?', `'${SEEDS[st.id].path}'`).replace('?', String(st.id)).replace('?', `'${SEEDS[st.id].slug}'`);
  return st.kind;
}
const stepsKey = p => JSON.stringify(p.steps);

/** The end state every --apply must prove. Returns problems. */
function verifyEndState(after, before) {
  const bad = [];
  const pa = plan(after);
  bad.push(...pa.problems);
  if (!pa.done) bad.push(`steps still pending: ${stepsKey(pa)}`);
  for (const spec of COLUMNS) if (!isTarget(spec, after.cols[spec.name])) bad.push(`${spec.table}.${spec.name} is ${describeCol(after.cols[spec.name])}, not the target`);
  if (!isTargetKey(after.key)) bad.push(`${UQ} is [${after.key.map(x => x.c).join(', ')}], not (hook_id, dedup_key) UNIQUE`);
  for (const [id, seed] of Object.entries(SEEDS)) if (!after.hooks[id] || after.hooks[id].path !== seed.path) bad.push(`hook ${id} dedup_path is ${after.hooks[id] ? JSON.stringify(after.hooks[id].path) : 'missing'}, expected '${seed.path}'`);
  if (after.execRows < before.execRows) bad.push(`${T_EXEC} has ${after.execRows} rows, had ${before.execRows}`);
  return bad;
}

// ─────────────────────────────────────────────────────────────
// Smoke — rolled back: the unique key refuses a duplicate, lets NULLs through
// ─────────────────────────────────────────────────────────────

async function smoke(conn, log) {
  await conn.beginTransaction();
  try {
    const ins = (key) => conn.query({ sql: `/* hookS3:smoke */ INSERT INTO \`${T_EXEC}\` (hook_id, slug, raw_input, status, claimed_at, attempts, dedup_key) VALUES (0, 'hookS3-smoke', JSON_OBJECT('smoke', TRUE), 'received', NOW(3), 1, ?)`, timeout: QUERY_TIMEOUT_MS }, [key]);
    await ins('smoke-dup-1');
    let dup = null;
    try { await ins('smoke-dup-1'); } catch (err) { dup = err; }
    if (!dup || dup.code !== 'ER_DUP_ENTRY') throw new Error(`smoke: a second INSERT with the same (hook_id, dedup_key) ${dup ? `failed with ${dup.code}` : 'SUCCEEDED'} — expected ER_DUP_ENTRY`);
    await ins(null);
    await ins(null);
    const [[n]] = await conn.query({ sql: `/* hookS3:smoke-count */ SELECT COUNT(*) AS n FROM \`${T_EXEC}\` WHERE slug = 'hookS3-smoke'`, timeout: QUERY_TIMEOUT_MS });
    if (Number(n.n) !== 3) throw new Error(`smoke: ${n.n} smoke row(s) in the transaction, expected 3 (one keyed + two NULL)`);
  } finally {
    await conn.rollback().catch(() => {});
  }
  const [left] = await q(conn, `/* hookS3:smoke-left */ SELECT COUNT(*) AS n FROM \`${T_EXEC}\` WHERE slug = 'hookS3-smoke'`);
  if (Number(left.n) !== 0) throw new Error(`smoke: the rolled-back rows persisted in ${T_EXEC} — look now`);
  log('  ✓ smoke: a duplicate (hook_id, dedup_key) is refused with ER_DUP_ENTRY; two NULL keys both insert; rolled back');
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

const CMD = 'node scripts/hookDedupS3.js';

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== Async hook receiver S3: provider-event dedup — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  if (!s.tables.hooks || !s.tables.exec) say(`tables: hooks ${s.tables.hooks ? 'present' : 'MISSING'}, hook_executions ${s.tables.exec ? 'present' : 'MISSING'}`);
  else {
    say(`${T_HOOKS}.dedup_path: ${!s.cols.dedup_path ? 'absent' : isTarget(PATH_COL, s.cols.dedup_path) ? 'TARGET' : `UNEXPECTED (${describeCol(s.cols.dedup_path)})`}`);
    say(`${T_EXEC}.dedup_key: ${!s.cols.dedup_key ? 'absent' : isTarget(KEY_COL, s.cols.dedup_key) ? 'TARGET' : `UNEXPECTED (${describeCol(s.cols.dedup_key)})`}${s.keyedRows != null ? ` (${s.keyedRows} keyed row(s))` : ''}; ${s.execRows} row(s)`);
    say(`${UQ}: ${!s.key.length ? 'absent' : isTargetKey(s.key) ? 'TARGET' : `UNEXPECTED [${s.key.map(x => x.c).join(', ')}]`}`);
    for (const [id, seed] of Object.entries(SEEDS)) {
      const h = s.hooks[id];
      say(`hook ${id} ${seed.slug}: ${!h ? 'MISSING' : h.slug !== seed.slug ? `slug is "${h.slug}"` : h.path === undefined || h.path === null ? 'no dedup_path' : h.path === seed.path ? `dedup_path '${h.path}' (target)` : `dedup_path '${h.path}' (OTHER)`}`);
    }
  }
  say(`triggers on the two tables: ${s.tableTriggers.length ? s.tableTriggers.map(r => r.name).join(', ') : 'none'}; ` +
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
    if (apply) {
      try {
        const bad = verifyEndState(s, s);
        if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
        say('  ✓ verified: both columns, the unique key and the five seeded paths are the target');
        await smoke(conn, say);
      } catch (err) {
        say(`\n  ✗ ${err.message}`);
        const line = `NO-GO — the schema is in place but the end state or the smoke failed. Nothing was changed. Paste this output; re-run ${CMD} --apply once it is understood.`;
        say(`\n${line}`);
        return { ok: false, line, state: s, done: [] };
      }
    }
    const line = `ALREADY APPLIED — GO. Both columns, the unique key and the five seeded paths are in place${apply ? ', verified and smoke-tested again' : ''}; nothing to do. ` +
      'Next: deploy S3 (push the slice); the next commit regenerates ref/database.sql.';
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
        say(`  ✓ ${spec.table}: ADD COLUMN ${spec.name} ${spec.ddl}, INSTANT`);
        done.push(`add ${st.name}`);
      } else if (st.kind === 'addKey') {
        // Re-assert right before the build: the column must be NULL on every row.
        const [k] = await q(conn, `/* hookS3:keyed-now */ SELECT COUNT(*) AS n FROM \`${T_EXEC}\` WHERE dedup_key IS NOT NULL`);
        if (Number(k.n) !== 0) throw new Error(`${k.n} row(s) carry a dedup_key just before the unique key build — stopped`);
        await q(conn, SQL.addKey, [], DDL_TIMEOUT_MS);
        say(`  ✓ ${T_EXEC}: ADD UNIQUE KEY ${UQ} (hook_id, dedup_key), INPLACE, LOCK=NONE`);
        done.push('addKey');
      } else if (st.kind === 'seed') {
        const seed = SEEDS[st.id];
        const [r] = await conn.query({ sql: SQL.seed, timeout: QUERY_TIMEOUT_MS }, [seed.path, st.id, seed.slug]);
        if (r.affectedRows !== 1) throw new Error(`seeding hook ${st.id} (${seed.slug}) touched ${r.affectedRows} row(s), expected 1 — the row changed under us`);
        say(`  ✓ hook ${st.id} ${seed.slug}: dedup_path = '${seed.path}'`);
        done.push(`seed ${st.id}`);
      }
    }

    const after = await readState(conn);
    const bad = verifyEndState(after, s2);
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: dedup_path, dedup_key and ${UQ} are the target; five hooks seeded; ${after.execRows} row(s)`);

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

  const line = 'APPLIED — GO. Next: verify read-only (information_schema.COLUMNS / STATISTICS, hooks.dedup_path), then deploy S3 ' +
    '(push the slice); the next commit regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, done };
}

module.exports = { T_HOOKS, T_EXEC, UQ, PATH_COL, KEY_COL, COLUMNS, SEEDS, SQL, NAMES_RE, plan, readState, run, isTarget, isTargetKey, verifyEndState };

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
