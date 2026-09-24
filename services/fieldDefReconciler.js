// services/fieldDefReconciler.js
//
/**
 * Custom-field column reconciler (custom-fields arc S3)
 * services/fieldDefReconciler.js
 *
 * Gives every ACTIVE field_defs row its SQL surface: a typed VIRTUAL generated
 * column named exactly field_key on the entity table, plus a secondary index
 * `idx_<field_key>` when the def has indexed = 1 (ref/CUSTOM_FIELDS_DESIGN.md
 * §2 "SQL surface", §3 reconciler rule). Values never move — the column is a
 * read of <entity>.custom, so dropping one destroys nothing (§3).
 *
 *   reconcile(db, opts)          diff defs vs information_schema → plan → run
 *   scheduleReconcile(db, opts)  fire-and-forget wrapper (boot, def mutations)
 *   planFor(defs, columns, idx)  the pure diff, exported for tests
 *
 * ── THE DIFF ────────────────────────────────────────────────────────────────
 * Managed columns = cf_-named columns whose EXTRA is exactly 'VIRTUAL
 * GENERATED'. (NOT "EXTRA contains GENERATED": that also matches
 * DEFAULT_GENERATED — `custom` itself and every CURRENT_TIMESTAMP column.)
 *   active def, no column             → ADD COLUMN (+ CREATE INDEX if indexed)
 *   managed column, no active def     → DROP COLUMN (values stay in the JSON)
 *   managed column, wrong type/expr   → DROP + ADD (retype; pre-data only by
 *                                       the S2 field_type lock, so no data
 *                                       semantics change under anyone)
 *   indexed=1 and no idx_<key>        → CREATE INDEX; indexed=0 and one → DROP
 *   multiselect (JSON column)         → never indexed: a plain index on a JSON
 *                                       column is ERROR 3152 — skipped, logged
 *   a cf_ column that is NOT managed  → never touched, never dropped (a real
 *     (real or STORED, hand-made)       column holds real data); a def that
 *                                       wants its name is skipped + alerted
 * Idempotent: a second run over the result plans nothing. Execution order is
 * drop-index → drop-column → add-column → create-index, so row-size budget is
 * freed before it is spent and indexes build last.
 *
 * ── DDL ALGORITHMS (measured, MySQL 8.4.11 + 9.6.0, design doc §8) ──────────
 * Spelled out on every statement so the engine ERRORS instead of silently
 * picking a table copy or a blocking lock:
 *   ADD COLUMN … VIRTUAL        ALGORITHM=INSTANT — no rebuild, 0 row versions
 *   DROP COLUMN                 ALGORITHM=INPLACE, LOCK=NONE — INSTANT is
 *                               refused (1845) unless the column is the
 *                               table's last; INPLACE is metadata-only for a
 *                               virtual column (no rebuild, 0 row versions)
 *   CREATE / DROP INDEX         ALGORITHM=INPLACE, LOCK=NONE — online
 *
 * ── GUARDS ──────────────────────────────────────────────────────────────────
 * - ONE dedicated connection, never a transaction (DDL commits implicitly).
 * - GET_LOCK('field_defs_reconcile', 0) serializes instances (Cloud Run runs up
 *   to 6) and overlapping triggers. Busy → one retry after timing.lockRetryMs
 *   (jittered ±50%, so instances that collided don't collide again on the
 *   retry), then log + alert. Within one process scheduleReconcile coalesces:
 *   triggers that arrive while a run is in flight collapse into ONE follow-up
 *   run (it must still happen — the in-flight run may have read the registry
 *   before their mutation committed). Measured on the 8.4 clone: 7 creates in
 *   a burst without coalescing → 5 lock-busy alerts; with it → 0.
 *   Defs and columns are read UNDER the lock, fresh from the DB —
 *   never from fieldDefService's cache, whose other-instance copies can be up
 *   to TTL_MS stale (a stale read would DROP a column a sibling just added).
 * - SET SESSION lock_wait_timeout = LOCK_WAIT_TIMEOUT_S: every ALTER takes a
 *   brief exclusive MDL, and one waiting behind a long transaction blocks
 *   every new query on the table for as long as it waits. The global default
 *   is a year (31536000, verified live). ER_LOCK_WAIT_TIMEOUT → one retry
 *   after MDL_BACKOFF_MS. The session value is restored before the pooled
 *   connection goes back; if the restore fails the connection is destroyed
 *   instead, so a 5-second timeout can never leak to another caller.
 * - First failure stops the run (the rest is re-planned next time — the diff
 *   is idempotent) and raises a system alert. reconcile() never throws for a
 *   DB problem: it resolves with status 'failed' | 'locked'.
 * - Every executed statement is logged; a run that attempted DDL writes one
 *   admin_audit_log row (tool 'field_defs').
 *
 * ── VERSION SKEW ────────────────────────────────────────────────────────────
 * COLUMN_SPECS is load-bearing: two code versions with different specs would
 * each retype the other's columns on their next run (boot, mutation). Change
 * it only as a deliberate slice, expecting one retype per column per deploy.
 *
 * The expressions below are the ONE sanctioned JSON-path read of `custom`
 * (design doc §3) — tests/customFields.s2.test.js allowlists this file.
 */

'use strict';

const fieldDefs = require('./fieldDefService');

const LOCK_NAME = 'field_defs_reconcile';
const LOCK_WAIT_TIMEOUT_S = 5;
const ER_LOCK_WAIT_TIMEOUT = 1205;

/** Delays, read at call time — tests set them to 0. */
const timing = { lockRetryMs: 10_000, mdlBackoffMs: 2_000 };

const STR = fieldDefs.STRING_MAX_LEN; // 255 — the chokepoint caps text + option values to it

/**
 * field_type → column. `ddl` is the declared type; `returning` feeds
 * JSON_VALUE(custom, '$.<key>' RETURNING …) — NULL on a missing key AND on a
 * value that doesn't convert (measured: the CAST(JSON_UNQUOTE(JSON_EXTRACT()))
 * form reads junk numbers as 0.0000, reads JSON true as 0 for a boolean, and
 * lets a matching index flip raw `->>` results; JSON_VALUE does none of it).
 * `columnType` / `collation` are what information_schema reports back — the
 * type half of the diff. Multiselect is a JSON column (query with MEMBER OF).
 */
const COLUMN_SPECS = Object.freeze({
  text:        { ddl: `VARCHAR(${STR}) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`, returning: `CHAR(${STR}) CHARACTER SET utf8mb4`, columnType: `varchar(${STR})`, collation: 'utf8mb4_general_ci', indexable: true },
  select:      { ddl: `VARCHAR(${STR}) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`, returning: `CHAR(${STR}) CHARACTER SET utf8mb4`, columnType: `varchar(${STR})`, collation: 'utf8mb4_general_ci', indexable: true },
  number:      { ddl: 'DECIMAL(18,4)', returning: 'DECIMAL(18,4)', columnType: 'decimal(18,4)', collation: null, indexable: true },
  date:        { ddl: 'DATE',          returning: 'DATE',          columnType: 'date',          collation: null, indexable: true },
  boolean:     { ddl: 'TINYINT(1)',    returning: 'UNSIGNED',      columnType: 'tinyint(1)',    collation: null, indexable: true },
  multiselect: { ddl: 'JSON',          returning: null,            columnType: 'json',          collation: null, indexable: false },
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => {
  if (!ms) return resolve();
  const t = setTimeout(resolve, ms);
  if (t && typeof t.unref === 'function') t.unref();
});

/** Identifiers from information_schema are re-checked before they reach DDL. */
const COLUMN_NAME_RE = /^cf_[a-z0-9_]{1,61}$/i;

const indexName = key => `idx_${key}`;

/** The generation expression for a spec. Keys are KEY_RE-checked by the caller. */
function columnExpression(spec, key) {
  return spec.returning
    ? `JSON_VALUE(\`custom\`, '$.${key}' RETURNING ${spec.returning})`
    : `JSON_EXTRACT(\`custom\`, '$.${key}')`;
}

function addColumnSql(table, key, spec) {
  return `ALTER TABLE \`${table}\` ADD COLUMN \`${key}\` ${spec.ddl} ` +
         `GENERATED ALWAYS AS (${columnExpression(spec, key)}) VIRTUAL, ALGORITHM=INSTANT`;
}
const dropColumnSql = (table, name) => `ALTER TABLE \`${table}\` DROP COLUMN \`${name}\`, ALGORITHM=INPLACE, LOCK=NONE`;
const createIndexSql = (table, key) => `CREATE INDEX \`${indexName(key)}\` ON \`${table}\` (\`${key}\`) ALGORITHM=INPLACE LOCK=NONE`;
const dropIndexSql = (table, idx) => `DROP INDEX \`${idx}\` ON \`${table}\` ALGORITHM=INPLACE LOCK=NONE`;

/**
 * Does an existing managed column match the def's spec? information_schema
 * normalizes the expression (lowercased, `_utf8mb4\'…\'` literals), so the
 * expression half is checked loosely: right function, right path. A strict
 * text comparison would retype every column on any engine that formats it
 * differently — a DROP+ADD loop on every run.
 */
function columnMatches(col, spec, key) {
  if (String(col.COLUMN_TYPE || '').toLowerCase() !== spec.columnType) return false;
  if (spec.collation && String(col.COLLATION_NAME || '').toLowerCase() !== spec.collation) return false;
  const expr = String(col.GENERATION_EXPRESSION || '').toLowerCase().replace(/\\/g, '');
  const fn = spec.returning ? 'json_value(' : 'json_extract(';
  return expr.startsWith(fn) && expr.includes(`'$.${key}'`);
}

// ─────────────────────────────────────────────────────────────
// Plan — pure
// ─────────────────────────────────────────────────────────────

/**
 * @param {Array<{entity, field_key, field_type, indexed}>} defs  ACTIVE defs
 * @param {Array<{TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME, EXTRA, GENERATION_EXPRESSION}>} columns
 *        every cf_-named column on the entity tables
 * @param {Array<{TABLE_NAME, INDEX_NAME, COLUMN_NAME}>} indexes  index rows on those columns
 * @returns {{ steps: Array<{table, key, action, reason, sql}>,
 *             skipped: Array<{table, key, reason}>,
 *             conflicts: Array<{table, key, reason}> }}
 *   steps are in execution order. conflicts are alert-worthy; skipped are not.
 */
function planFor(defs, columns, indexes) {
  const phases = { drop_index: [], drop_column: [], add_column: [], create_index: [] };
  const skipped = [];
  const conflicts = [];
  const push = (action, table, key, reason, sql) => phases[action].push({ table, key, action, reason, sql });

  for (const [entity, table] of Object.entries(fieldDefs.ENTITY_TABLES)) {
    const lc = s => String(s).toLowerCase();
    const cols = (columns || []).filter(c => lc(c.TABLE_NAME) === table && /^cf_/i.test(c.COLUMN_NAME));
    const managed = new Map(cols.filter(c => c.EXTRA === 'VIRTUAL GENERATED').map(c => [lc(c.COLUMN_NAME), c]));
    const foreign = new Map(cols.filter(c => c.EXTRA !== 'VIRTUAL GENERATED').map(c => [lc(c.COLUMN_NAME), c]));
    const idxNames = new Set((indexes || []).filter(i => lc(i.TABLE_NAME) === table).map(i => lc(i.INDEX_NAME)));
    const wanted = new Map();

    for (const d of (defs || []).filter(x => x.entity === entity)) {
      const key = d.field_key;
      if (!fieldDefs.KEY_RE.test(key)) { conflicts.push({ table, key, reason: 'field_key fails KEY_RE — refusing to put it in DDL' }); continue; }
      const spec = COLUMN_SPECS[d.field_type];
      if (!spec) { conflicts.push({ table, key, reason: `unknown field_type "${d.field_type}"` }); continue; }
      wanted.set(key, { spec, indexed: !!Number(d.indexed) });
    }

    // Managed columns: orphaned, retype, or keep.
    for (const [name, col] of managed) {
      const want = wanted.get(name);
      const hasIdx = idxNames.has(indexName(name));
      if (!want) {
        if (!COLUMN_NAME_RE.test(col.COLUMN_NAME)) { conflicts.push({ table, key: col.COLUMN_NAME, reason: 'orphaned column name is not a plain cf_ identifier — left alone' }); continue; }
        if (hasIdx) push('drop_index', table, name, 'orphaned', dropIndexSql(table, indexName(name)));
        push('drop_column', table, name, 'orphaned', dropColumnSql(table, col.COLUMN_NAME));
        continue;
      }
      if (!columnMatches(col, want.spec, name)) {
        if (hasIdx) push('drop_index', table, name, 'retype', dropIndexSql(table, indexName(name)));
        push('drop_column', table, name, 'retype', dropColumnSql(table, col.COLUMN_NAME));
        push('add_column', table, name, 'retype', addColumnSql(table, name, want.spec));
        if (want.indexed && want.spec.indexable) push('create_index', table, name, 'retype', createIndexSql(table, name));
        continue;
      }
      if (want.indexed && !want.spec.indexable) {
        skipped.push({ table, key: name, reason: 'indexed=1 on a JSON (multiselect) column — plain indexes on JSON are ERROR 3152' });
      } else if (want.indexed && !hasIdx) {
        push('create_index', table, name, 'indexed', createIndexSql(table, name));
      } else if (!want.indexed && hasIdx) {
        push('drop_index', table, name, 'unindexed', dropIndexSql(table, indexName(name)));
      }
    }

    // Active defs with no managed column.
    for (const [key, want] of wanted) {
      if (managed.has(key)) continue;
      if (foreign.has(key)) {
        conflicts.push({ table, key, reason: `a non-generated column \`${foreign.get(key).COLUMN_NAME}\` (${foreign.get(key).EXTRA || 'real column'}) already has this name — not touched` });
        continue;
      }
      push('add_column', table, key, 'missing', addColumnSql(table, key, want.spec));
      if (want.indexed && want.spec.indexable) push('create_index', table, key, 'indexed', createIndexSql(table, key));
      else if (want.indexed) skipped.push({ table, key, reason: 'indexed=1 on a JSON (multiselect) column — plain indexes on JSON are ERROR 3152' });
    }
  }

  const steps = [...phases.drop_index, ...phases.drop_column, ...phases.add_column, ...phases.create_index];
  return { steps, skipped, conflicts };
}

// ─────────────────────────────────────────────────────────────
// Reads (under the lock, on the reconcile connection)
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const tables = Object.values(fieldDefs.ENTITY_TABLES);
  const [defs] = await conn.query(
    'SELECT entity, field_key, field_type, indexed FROM field_defs WHERE active = 1 ORDER BY id'
  );
  const [columns] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME, EXTRA, GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME LIKE ?`,
    [tables, 'cf\\_%']
  );
  const [indexes] = await conn.query(
    `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME LIKE ?`,
    [tables, 'cf\\_%']
  );
  return { defs: defs || [], columns: columns || [], indexes: indexes || [] };
}

// ─────────────────────────────────────────────────────────────
// Side channels — never throw
// ─────────────────────────────────────────────────────────────

function _alert(db, kind, severity, title, message, context) {
  try {
    const { alert } = require('../lib/alerting'); // deferred require (circular-dep safety convention)
    return Promise.resolve(alert(db, {
      source: 'app', kind, group_key: `app:${kind}`, severity, title, message, context,
    })).catch(() => {});
  } catch (_) { return Promise.resolve(); }
}

async function _audit(db, actor, trigger, result, durationMs) {
  try {
    const { auditAdminAction } = require('../lib/auth.superuser');
    const a = actor || {};
    await auditAdminAction(db, {
      tool: 'field_defs',
      userId: a.userId ?? null,
      username: a.username ?? (trigger === 'boot' ? 'system' : null),
      route: a.route || (trigger === 'boot' ? 'startup/init' : 'fieldDefReconciler'),
      method: a.method || (trigger === 'boot' ? 'BOOT' : 'INTERNAL'),
      status: result.status === 'ok' ? 'success' : 'error',
      errorMessage: result.failed ? `${result.failed.code || 'error'}: ${result.failed.message}` : null,
      durationMs,
      ip: a.ip ?? null,
      userAgent: a.userAgent ?? null,
      details: {
        action: 'reconcile', trigger,
        executed: result.executed.map(s => s.sql),
        failed: result.failed ? result.failed.sql : null,
        skipped: result.skipped, conflicts: result.conflicts,
      },
    });
  } catch (err) {
    console.error('[fieldDefReconciler] audit failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Lock + run
// ─────────────────────────────────────────────────────────────

/** One attempt: a connection holding the named lock, or null (connection released). */
async function _acquire(db) {
  const conn = await db.getConnection();
  try {
    const [[r]] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
    if (r && Number(r.got) === 1) return conn;
  } catch (err) {
    conn.release();
    throw err;
  }
  conn.release();
  return null;
}

/** Restore the session, drop the lock, hand the connection back — or destroy it. */
async function _finish(conn) {
  let clean = true;
  try { await conn.query('SET SESSION lock_wait_timeout = @@GLOBAL.lock_wait_timeout'); } catch (_) { clean = false; }
  try { await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch (_) { clean = false; }
  if (clean) conn.release();
  else { try { conn.destroy(); } catch (_) { /* closing the socket releases the lock anyway */ } }
}

async function _exec(conn, step) {
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      await conn.query(step.sql);
      console.log(`[fieldDefReconciler] ${step.action} ${step.table}.${step.key} (${step.reason}) ${Date.now() - t0}ms: ${step.sql}`);
      return;
    } catch (err) {
      if (err && err.errno === ER_LOCK_WAIT_TIMEOUT && attempt === 1) {
        console.warn(`[fieldDefReconciler] metadata lock wait timed out on ${step.table}; retrying once: ${step.sql}`);
        await sleep(timing.mdlBackoffMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Reconcile the column surface with the registry.
 *
 * @param {object} db  mysql2 promise pool (needs getConnection)
 * @param {object} [opts]
 * @param {string} [opts.trigger='manual']  boot | create | update | deactivate | reactivate | manual
 * @param {object} [opts.actor]  { userId, username, route, method, ip, userAgent } for the audit row
 * @param {boolean} [opts.dryRun=false]  plan under the lock, execute nothing, audit nothing
 * @returns {Promise<{ status: 'ok'|'noop'|'dry_run'|'failed'|'locked', trigger,
 *           plan: step[], executed: step[], failed: null|{sql, code, errno, message},
 *           skipped: object[], conflicts: object[] }>}
 */
async function reconcile(db, { trigger = 'manual', actor = null, dryRun = false } = {}) {
  const started = Date.now();
  const result = { status: 'noop', trigger, plan: [], executed: [], failed: null, skipped: [], conflicts: [] };
  let conn = null;
  try {
    conn = await _acquire(db);
    if (!conn) {
      await sleep(Math.round(timing.lockRetryMs * (0.5 + Math.random())));
      conn = await _acquire(db);
    }
  } catch (err) {
    result.status = 'failed';
    result.failed = { sql: null, code: err.code || null, errno: err.errno || null, message: err.message };
    console.error(`[fieldDefReconciler] ${trigger}: could not get a connection / the lock:`, err.message);
    await _alert(db, 'field_defs_reconcile_failed', 'error', 'Custom-field reconcile could not start',
      `${trigger}: ${err.message}`, { trigger });
    return result;
  }
  if (!conn) {
    result.status = 'locked';
    console.error(`[fieldDefReconciler] ${trigger}: '${LOCK_NAME}' still held after one retry — skipped`);
    await _alert(db, 'field_defs_reconcile_lock_busy', 'error',
      'Custom-field reconcile skipped: lock busy',
      `${trigger}: another reconcile held '${LOCK_NAME}' through one ${timing.lockRetryMs}ms retry. ` +
      'Columns may lag the registry until the next run — POST /api/field-defs/reconcile to run it now.',
      { trigger });
    return result;
  }

  try {
    await conn.query('SET SESSION lock_wait_timeout = ?', [LOCK_WAIT_TIMEOUT_S]);
    const state = await readState(conn);
    const { steps, skipped, conflicts } = planFor(state.defs, state.columns, state.indexes);
    result.plan = steps;
    result.skipped = skipped;
    result.conflicts = conflicts;
    for (const s of skipped) console.warn(`[fieldDefReconciler] skipped ${s.table}.${s.key}: ${s.reason}`);

    if (dryRun) {
      result.status = 'dry_run';
    } else {
      for (const step of steps) {
        try {
          await _exec(conn, step);
          result.executed.push(step);
        } catch (err) {
          result.failed = { sql: step.sql, code: err.code || null, errno: err.errno || null, message: err.message };
          break;
        }
      }
      result.status = result.failed ? 'failed' : (steps.length ? 'ok' : 'noop');
    }
  } catch (err) {
    result.status = 'failed';
    result.failed = { sql: null, code: err.code || null, errno: err.errno || null, message: err.message };
  } finally {
    await _finish(conn);
  }

  if (result.failed) {
    console.error(`[fieldDefReconciler] ${trigger}: FAILED${result.failed.sql ? ` on: ${result.failed.sql}` : ''} — ${result.failed.message}`);
    await _alert(db, 'field_defs_reconcile_failed', 'error', 'Custom-field reconcile failed',
      `${trigger}: ${result.failed.message}` +
      (result.failed.sql ? `\nStatement: ${result.failed.sql}` : '') +
      `\nExecuted before it: ${result.executed.length}; not attempted: ${result.plan.length - result.executed.length - (result.failed.sql ? 1 : 0)}.`,
      { trigger, failed: result.failed, executed: result.executed.map(s => s.sql) });
  }
  if (result.conflicts.length) {
    console.error('[fieldDefReconciler] conflicts:', JSON.stringify(result.conflicts));
    await _alert(db, 'field_defs_reconcile_conflict', 'warning', 'Custom-field reconcile left fields without a column',
      result.conflicts.map(c => `${c.table}.${c.key}: ${c.reason}`).join('\n'), { trigger, conflicts: result.conflicts });
  }
  if (result.executed.length || (result.failed && result.failed.sql)) {
    await _audit(db, actor, trigger, result, Date.now() - started);
  }
  return result;
}

let _inFlight = false;
let _followUp = null;   // { db, opts } — the latest trigger that arrived mid-run

/**
 * Fire-and-forget: boot and every def mutation that can change the column
 * surface. Never throws, never awaited — reconcile() surfaces its own
 * failures through the alert path. Coalesced per process: while a scheduled
 * run is in flight, further calls collapse into one follow-up run carrying
 * the LATEST call's trigger + actor (the mutation routes audit each call
 * themselves, so no attribution is lost).
 */
function scheduleReconcile(db, opts = {}) {
  if (_inFlight) { _followUp = { db, opts }; return; }
  _inFlight = true;
  module.exports.reconcile(db, opts) // via exports so a test can observe the runs
    .catch(err => { console.error(`[fieldDefReconciler] ${opts.trigger || 'manual'}: unexpected error:`, err); })
    .finally(() => {
      _inFlight = false;
      if (_followUp) {
        const next = _followUp;
        _followUp = null;
        scheduleReconcile(next.db, next.opts);
      }
    });
}

module.exports = {
  LOCK_NAME,
  LOCK_WAIT_TIMEOUT_S,
  COLUMN_SPECS,
  timing,
  planFor,
  reconcile,
  scheduleReconcile,
  // exported for tests
  columnExpression,
  columnMatches,
};
