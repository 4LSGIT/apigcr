// tests/customFields.s3.test.js
//
/**
 * Custom-fields arc S3 — the column reconciler (services/fieldDefReconciler.js)
 * and its two riders (ref/CUSTOM_FIELDS_DESIGN.md §2–§3, §7 S3 row, §9).
 *
 * Proof obligations:
 *
 *   1. PLAN (pure): exact DDL per field type, with the ruled algorithms —
 *      ADD … VIRTUAL ALGORITHM=INSTANT; DROP COLUMN and both index ops
 *      INPLACE, LOCK=NONE (INSTANT drop is refused for a non-last column on
 *      8.4.11 and 9.6.0 — design doc §8). Orphan → drop, retype → drop+add,
 *      index on/off, multiselect never indexed, a cf_ column that is not
 *      VIRTUAL GENERATED is never touched, a bad key never reaches DDL.
 *   2. IDEMPOTENCE: against a fake engine that applies the DDL to its own
 *      information_schema (normalizing expressions the way 8.4 does, and
 *      refusing an INSTANT drop of a non-last column), a second run plans
 *      and issues nothing.
 *   3. GUARDS: GET_LOCK busy → one delayed retry → alert; the session
 *      lock_wait_timeout is lowered for the DDL and restored before release
 *      (destroy if the restore fails); ER_LOCK_WAIT_TIMEOUT retried once, a
 *      second one stops the run and alerts; never a transaction.
 *   4. AUDIT: a run that attempted DDL writes one admin_audit_log row (tool
 *      field_defs); a no-op / dry run writes none. Every def mutation route
 *      writes one too.
 *   5. TRIGGERS: create, deactivate, reactivate, and a field_type change fire
 *      scheduleReconcile; label / options / validation / sort_order don't.
 *      Boot fires it (startup/init.js). POST /api/field-defs/reconcile runs
 *      it and maps locked → 409, failed → 500 without engine text.
 *   6. CAPS: text values and option values ≤ STRING_MAX_LEN (the VARCHAR
 *      width); validation.max_len can't promise more.
 *   7. MERGE (rider A): generated columns are never written (read fresh from
 *      information_schema per call); the `custom` bag merges per key —
 *      absent → fill (same UPDATE, customAssignment), equal → skip,
 *      different → conflict 'custom.<key>'.
 *   8. PETITION (rider B): get_contacts rows lack `custom`, keep contact_ssn.
 *
 * Harness: dispatch-on-SQL-text worlds, no MySQL (house rule for this run).
 * The same DDL ran against a real MySQL 8.4.11 clone of cases/contacts during
 * the S3 build: two passes, the second planned nothing — see the S3 report.
 *
 *   npx jest tests/customFields.s3.test.js
 */

'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { userId: 6, username: 'fred' }; next(); }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));

const express = require('express');

const { alert } = require('../lib/alerting');
const logService = require('../services/logService');
const fieldDefs = require('../services/fieldDefService');
const reconciler = require('../services/fieldDefReconciler');
const caseService = require('../services/caseService');

reconciler.timing.lockRetryMs = 0;
reconciler.timing.mdlBackoffMs = 0;
reconciler.timing.connectRetryMs = 0;

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  fieldDefs.bump();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

const tick = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────
// Fake engine — information_schema that DDL actually changes
// ─────────────────────────────────────────────────────────────

/** Declared type → what information_schema reports (measured on 8.4.11). */
function typeOf(ddl) {
  const d = ddl.trim();
  let m;
  if ((m = /^VARCHAR\((\d+)\) CHARACTER SET utf8mb4 COLLATE (\w+)$/.exec(d))) return { COLUMN_TYPE: `varchar(${m[1]})`, COLLATION_NAME: m[2] };
  if (/^DECIMAL\(18,4\)$/.test(d)) return { COLUMN_TYPE: 'decimal(18,4)', COLLATION_NAME: null };
  if (/^DATE$/.test(d)) return { COLUMN_TYPE: 'date', COLLATION_NAME: null };
  if (/^TINYINT\(1\)$/.test(d)) return { COLUMN_TYPE: 'tinyint(1)', COLLATION_NAME: null };
  if (/^JSON$/.test(d)) return { COLUMN_TYPE: 'json', COLLATION_NAME: null };
  throw new Error('fake engine: unknown type ' + d);
}
/** 8.4 stores the expression lowercased with introducer + escaped quotes. */
const normExpr = e => e.toLowerCase().replace(/'(\$\.[a-z0-9_]+)'/g, "_utf8mb4\\'$1\\'");

function col(table, name, over = {}) {
  return { TABLE_NAME: table, COLUMN_NAME: name, COLUMN_TYPE: 'varchar(255)', COLLATION_NAME: 'utf8mb4_general_ci',
    EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: normExpr(`json_value(\`custom\`, '$.${name}' returning char(255) character set utf8mb4)`), ...over };
}
const def = (entity, field_key, field_type, over = {}) => ({ entity, field_key, field_type, indexed: 0, active: 1, ...over });

function engine({ defs = [], columns = [], indexes = [], lockHeldBy = null, fail = [], restoreFails = false } = {}) {
  const state = {
    defs, columns: columns.map(c => ({ ...c })), indexes: indexes.map(i => ({ ...i })),
    lockHeldBy, log: [], poolLog: [], session: {}, released: 0, destroyed: 0, conns: 0, tx: 0,
  };
  let nextConn = 1;

  function ddl(s, connId) {
    let m;
    if ((m = /^ALTER TABLE `(\w+)` ADD COLUMN `(\w+)` (.+) GENERATED ALWAYS AS \((.+)\) VIRTUAL, ALGORITHM=INSTANT$/.exec(s))) {
      const [, table, name, type, expr] = m;
      if (state.columns.some(c => c.TABLE_NAME === table && c.COLUMN_NAME.toLowerCase() === name.toLowerCase())) {
        throw Object.assign(new Error(`Duplicate column name '${name}'`), { errno: 1060, code: 'ER_DUP_FIELDNAME' });
      }
      state.columns.push({ TABLE_NAME: table, COLUMN_NAME: name, ...typeOf(type), EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: normExpr(expr) });
      return [{}];
    }
    if ((m = /^ALTER TABLE `(\w+)` DROP COLUMN `(\w+)`, ALGORITHM=(\w+)(, LOCK=NONE)?$/.exec(s))) {
      const [, table, name, alg] = m;
      const tcols = state.columns.filter(c => c.TABLE_NAME === table);
      const i = tcols.findIndex(c => c.COLUMN_NAME === name);
      if (i < 0) throw Object.assign(new Error(`Can't DROP '${name}'`), { errno: 1091 });
      // measured: INSTANT refuses a non-last virtual column (and an indexed one)
      if (alg === 'INSTANT' && (i !== tcols.length - 1 || state.indexes.some(x => x.TABLE_NAME === table && x.COLUMN_NAME === name))) {
        throw Object.assign(new Error('ALGORITHM=INSTANT is not supported for this operation.'), { errno: 1845 });
      }
      state.columns = state.columns.filter(c => !(c.TABLE_NAME === table && c.COLUMN_NAME === name));
      state.indexes = state.indexes.filter(x => !(x.TABLE_NAME === table && x.COLUMN_NAME === name));
      return [{}];
    }
    if ((m = /^CREATE INDEX `(\w+)` ON `(\w+)` \(`(\w+)`\) ALGORITHM=INPLACE LOCK=NONE$/.exec(s))) {
      const [, idx, table, name] = m;
      const c = state.columns.find(x => x.TABLE_NAME === table && x.COLUMN_NAME === name);
      if (!c) throw Object.assign(new Error(`Key column '${name}' doesn't exist`), { errno: 1072 });
      if (c.COLUMN_TYPE === 'json') throw Object.assign(new Error('JSON column supports indexing only via generated columns'), { errno: 3152 });
      state.indexes.push({ TABLE_NAME: table, INDEX_NAME: idx, COLUMN_NAME: name });
      return [{}];
    }
    if ((m = /^DROP INDEX `(\w+)` ON `(\w+)` ALGORITHM=INPLACE LOCK=NONE$/.exec(s))) {
      const [, idx, table] = m;
      state.indexes = state.indexes.filter(x => !(x.TABLE_NAME === table && x.INDEX_NAME === idx));
      return [{}];
    }
    throw new Error('fake engine: unscripted DDL — ' + s);
  }

  function makeConn() {
    const id = nextConn++;
    state.conns++;
    const query = async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      state.log.push({ conn: id, s, params });
      for (const f of fail) {
        if (f.re.test(s) && f.times > 0) { f.times--; throw Object.assign(new Error(f.message || 'boom'), { errno: f.errno, code: f.code }); }
      }
      if (/^SELECT GET_LOCK\(\?, 0\) AS got$/.test(s)) {
        if (state.lockHeldBy == null || state.lockHeldBy === id) { state.lockHeldBy = id; return [[{ got: 1 }]]; }
        return [[{ got: 0 }]];
      }
      if (/^SELECT RELEASE_LOCK\(\?\)$/.test(s)) { if (state.lockHeldBy === id) state.lockHeldBy = null; return [[{ r: 1 }]]; }
      if (/^SET SESSION lock_wait_timeout = \?$/.test(s)) { state.session[id] = params[0]; return [{}]; }
      if (/^SET SESSION lock_wait_timeout = @@GLOBAL\.lock_wait_timeout$/.test(s)) {
        if (restoreFails) throw new Error('connection lost');
        state.session[id] = 'global'; return [{}];
      }
      if (/FROM field_defs WHERE active = 1/.test(s)) return [state.defs.filter(d => d.active)];
      if (/FROM information_schema\.COLUMNS/.test(s)) {
        expect(params).toEqual([['cases', 'contacts'], 'cf\\_%']);
        return [state.columns.map(c => ({ ...c }))];
      }
      if (/FROM information_schema\.STATISTICS/.test(s)) return [state.indexes.map(i => ({ ...i }))];
      if (/^(START TRANSACTION|BEGIN)/i.test(s)) { state.tx++; return [{}]; }
      if (/^(ALTER|CREATE|DROP)/.test(s)) {
        state.ddlConn = id;
        expect(state.session[id]).toBe(reconciler.LOCK_WAIT_TIMEOUT_S); // low MDL timeout is in force
        expect(state.lockHeldBy).toBe(id);                              // and the named lock is held
        return ddl(s, id);
      }
      throw new Error('fake engine: unscripted query — ' + s);
    };
    return {
      id, query,
      beginTransaction: async () => { state.tx++; },
      release: () => { state.released++; },
      destroy: () => { state.destroyed++; if (state.lockHeldBy === id) state.lockHeldBy = null; },
    };
  }

  const db = {
    state,
    getConnection: async () => makeConn(),
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      state.poolLog.push({ s, params });
      if (/^INSERT INTO admin_audit_log/.test(s)) return [{ insertId: 1 }];
      throw new Error('fake engine pool: unscripted query — ' + s);
    },
  };
  return db;
}

const ddlOf = db => db.state.log.filter(q => /^(ALTER|CREATE|DROP)/.test(q.s)).map(q => q.s);
const audits = db => db.state.poolLog.filter(q => /^INSERT INTO admin_audit_log/.test(q.s));
const auditRow = q => ({
  tool: q.params[0], userId: q.params[1], username: q.params[2], route: q.params[3], method: q.params[4],
  status: q.params[5], details: JSON.parse(q.params[10]),
});

// ─────────────────────────────────────────────────────────────
// 1. Plan — exact DDL
// ─────────────────────────────────────────────────────────────

describe('planFor — the diff and its exact DDL', () => {
  const sqls = p => p.steps.map(s => s.sql);

  test('missing column, one per field type — JSON_VALUE for scalars, JSON_EXTRACT for multiselect, ADD is INSTANT', () => {
    const p = reconciler.planFor([
      def('case', 'cf_tx', 'text'), def('case', 'cf_sl', 'select'), def('case', 'cf_nm', 'number'),
      def('contact', 'cf_dt', 'date'), def('contact', 'cf_bo', 'boolean'), def('contact', 'cf_ms', 'multiselect'),
    ], [], []);
    expect(sqls(p)).toEqual([
      "ALTER TABLE `cases` ADD COLUMN `cf_tx` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (JSON_VALUE(`custom`, '$.cf_tx' RETURNING CHAR(255) CHARACTER SET utf8mb4)) VIRTUAL, ALGORITHM=INSTANT",
      "ALTER TABLE `cases` ADD COLUMN `cf_sl` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (JSON_VALUE(`custom`, '$.cf_sl' RETURNING CHAR(255) CHARACTER SET utf8mb4)) VIRTUAL, ALGORITHM=INSTANT",
      "ALTER TABLE `cases` ADD COLUMN `cf_nm` DECIMAL(18,4) GENERATED ALWAYS AS (JSON_VALUE(`custom`, '$.cf_nm' RETURNING DECIMAL(18,4))) VIRTUAL, ALGORITHM=INSTANT",
      "ALTER TABLE `contacts` ADD COLUMN `cf_dt` DATE GENERATED ALWAYS AS (JSON_VALUE(`custom`, '$.cf_dt' RETURNING DATE)) VIRTUAL, ALGORITHM=INSTANT",
      "ALTER TABLE `contacts` ADD COLUMN `cf_bo` TINYINT(1) GENERATED ALWAYS AS (JSON_VALUE(`custom`, '$.cf_bo' RETURNING UNSIGNED)) VIRTUAL, ALGORITHM=INSTANT",
      "ALTER TABLE `contacts` ADD COLUMN `cf_ms` JSON GENERATED ALWAYS AS (JSON_EXTRACT(`custom`, '$.cf_ms')) VIRTUAL, ALGORITHM=INSTANT",
    ]);
    expect(p.steps.every(s => s.action === 'add_column' && s.reason === 'missing')).toBe(true);
    expect(p.skipped).toEqual([]);
    expect(p.conflicts).toEqual([]);
  });

  test('the string width is the chokepoint cap — one constant', () => {
    expect(fieldDefs.STRING_MAX_LEN).toBe(255);
    expect(reconciler.COLUMN_SPECS.text.columnType).toBe(`varchar(${fieldDefs.STRING_MAX_LEN})`);
    expect(reconciler.COLUMN_SPECS.select.columnType).toBe(`varchar(${fieldDefs.STRING_MAX_LEN})`);
    expect(Object.keys(reconciler.COLUMN_SPECS).sort()).toEqual([...fieldDefs.FIELD_TYPES].sort());
  });

  test('indexed=1 adds the column, then an INPLACE, LOCK=NONE index named idx_<key>', () => {
    const p = reconciler.planFor([def('case', 'cf_tx', 'text', { indexed: 1 })], [], []);
    expect(p.steps.map(s => [s.action, s.reason])).toEqual([['add_column', 'missing'], ['create_index', 'indexed']]);
    expect(p.steps[1].sql).toBe('CREATE INDEX `idx_cf_tx` ON `cases` (`cf_tx`) ALGORITHM=INPLACE LOCK=NONE');
  });

  test('orphaned column (no active def) → DROP COLUMN INPLACE, LOCK=NONE — its index first', () => {
    const p = reconciler.planFor([], [col('cases', 'cf_old'), col('contacts', 'cf_gone')],
      [{ TABLE_NAME: 'cases', INDEX_NAME: 'idx_cf_old', COLUMN_NAME: 'cf_old' }]);
    expect(sqls(p)).toEqual([
      'DROP INDEX `idx_cf_old` ON `cases` ALGORITHM=INPLACE LOCK=NONE',
      'ALTER TABLE `cases` DROP COLUMN `cf_old`, ALGORITHM=INPLACE, LOCK=NONE',
      'ALTER TABLE `contacts` DROP COLUMN `cf_gone`, ALGORITHM=INPLACE, LOCK=NONE',
    ]);
    expect(p.steps.every(s => s.reason === 'orphaned')).toBe(true);
  });

  test('type mismatch → DROP + ADD (+ index back); a matching column is left alone', () => {
    const p = reconciler.planFor(
      [def('case', 'cf_xx', 'number', { indexed: 1 }), def('case', 'cf_ok', 'text')],
      [col('cases', 'cf_xx'), col('cases', 'cf_ok')],
      [{ TABLE_NAME: 'cases', INDEX_NAME: 'idx_cf_xx', COLUMN_NAME: 'cf_xx' }]);
    expect(p.steps.map(s => `${s.action} ${s.key} ${s.reason}`)).toEqual([
      'drop_index cf_xx retype', 'drop_column cf_xx retype', 'add_column cf_xx retype', 'create_index cf_xx retype',
    ]);
    expect(p.steps[2].sql).toMatch(/ADD COLUMN `cf_xx` DECIMAL\(18,4\) .*RETURNING DECIMAL\(18,4\)/);
  });

  test('right type, wrong expression (another function, another key\'s path, wrong collation) → retype', () => {
    const cast = col('cases', 'cf_al', { GENERATION_EXPRESSION: normExpr("cast(json_unquote(json_extract(`custom`,'$.cf_al')) as char(255) charset utf8mb4)") });
    const other = col('cases', 'cf_bo', { GENERATION_EXPRESSION: normExpr("json_value(`custom`, '$.cf_bb' returning char(255) character set utf8mb4)") });
    const bin = col('cases', 'cf_co', { COLLATION_NAME: 'utf8mb4_bin' });
    const p = reconciler.planFor(['cf_al', 'cf_bo', 'cf_co'].map(k => def('case', k, 'text')), [cast, other, bin], []);
    expect(p.steps.filter(s => s.action === 'add_column').map(s => s.key)).toEqual(['cf_al', 'cf_bo', 'cf_co']);
  });

  test('columnMatches is loose on formatting: backslash-escaped or plain quotes both match', () => {
    const spec = reconciler.COLUMN_SPECS.number;
    for (const g of ["json_value(`custom`, _utf8mb4\\'$.cf_nm\\' returning decimal(18,4))",
                     "JSON_VALUE(`custom`,'$.cf_nm' RETURNING DECIMAL(18,4))"]) {
      expect(reconciler.columnMatches({ COLUMN_TYPE: 'decimal(18,4)', GENERATION_EXPRESSION: g }, spec, 'cf_nm')).toBe(true);
    }
    // cf_nm is a prefix of cf_nmm — the quote after the path keeps them apart
    expect(reconciler.columnMatches({ COLUMN_TYPE: 'decimal(18,4)', GENERATION_EXPRESSION: "json_value(`custom`, '$.cf_nmm' returning decimal(18,4))" }, spec, 'cf_nm')).toBe(false);
  });

  test('index toggles on a matching column: indexed 1 → create; 0 → drop', () => {
    const on = reconciler.planFor([def('case', 'cf_tx', 'text', { indexed: 1 })], [col('cases', 'cf_tx')], []);
    expect(sqls(on)).toEqual(['CREATE INDEX `idx_cf_tx` ON `cases` (`cf_tx`) ALGORITHM=INPLACE LOCK=NONE']);
    const off = reconciler.planFor([def('case', 'cf_tx', 'text')], [col('cases', 'cf_tx')],
      [{ TABLE_NAME: 'cases', INDEX_NAME: 'idx_cf_tx', COLUMN_NAME: 'cf_tx' }]);
    expect(sqls(off)).toEqual(['DROP INDEX `idx_cf_tx` ON `cases` ALGORITHM=INPLACE LOCK=NONE']);
    expect(off.steps[0].reason).toBe('unindexed');
  });

  test('multiselect with indexed=1 is never indexed — skipped and reported, column still added', () => {
    const p = reconciler.planFor([def('contact', 'cf_ms', 'multiselect', { indexed: 1 })], [], []);
    expect(p.steps.map(s => s.action)).toEqual(['add_column']);
    expect(p.skipped).toEqual([{ table: 'contacts', key: 'cf_ms', reason: expect.stringMatching(/JSON.*3152/) }]);
    const existing = reconciler.planFor([def('contact', 'cf_ms', 'multiselect', { indexed: 1 })],
      [col('contacts', 'cf_ms', { COLUMN_TYPE: 'json', COLLATION_NAME: null, GENERATION_EXPRESSION: normExpr("json_extract(`custom`,'$.cf_ms')") })], []);
    expect(existing.steps).toEqual([]);
    expect(existing.skipped).toHaveLength(1);
  });

  test('a cf_ column that is NOT a virtual generated one is never touched — real, STORED, DEFAULT_GENERATED', () => {
    const real = col('cases', 'cf_real', { EXTRA: '', GENERATION_EXPRESSION: '' });
    const stored = col('cases', 'cf_stored', { EXTRA: 'STORED GENERATED' });
    const dflt = col('cases', 'cf_dflt', { EXTRA: 'DEFAULT_GENERATED', GENERATION_EXPRESSION: '' });
    // no defs → nothing is orphan-dropped
    expect(reconciler.planFor([], [real, stored, dflt], []).steps).toEqual([]);
    // a def that wants one of those names → conflict, no DDL
    const p = reconciler.planFor([def('case', 'cf_real', 'text'), def('case', 'cf_dflt', 'text')], [real, stored, dflt], []);
    expect(p.steps).toEqual([]);
    expect(p.conflicts.map(c => c.key)).toEqual(['cf_real', 'cf_dflt']);
  });

  test('a key that fails KEY_RE or an unknown type never reaches DDL', () => {
    const p = reconciler.planFor([def('case', 'cf_xx`; DROP TABLE cases; --', 'text'), def('case', 'cf_ok', 'currency')], [], []);
    expect(p.steps).toEqual([]);
    expect(p.conflicts.map(c => c.reason)).toEqual([expect.stringMatching(/KEY_RE/), expect.stringMatching(/unknown field_type/)]);
  });

  test('same key on both entities → one column per table; a contact def never lands on cases', () => {
    const p = reconciler.planFor([def('case', 'cf_ref', 'text'), def('contact', 'cf_ref', 'text')], [col('cases', 'cf_ref')], []);
    expect(p.steps.map(s => `${s.action} ${s.table}`)).toEqual(['add_column contacts']);
  });

  test('execution order across keys: drop index → drop column → add column → create index', () => {
    const p = reconciler.planFor(
      [def('case', 'cf_new', 'text', { indexed: 1 }), def('case', 'cf_re', 'date')],
      [col('cases', 'cf_re'), col('cases', 'cf_old')],
      [{ TABLE_NAME: 'cases', INDEX_NAME: 'idx_cf_old', COLUMN_NAME: 'cf_old' }]);
    expect(p.steps.map(s => `${s.action} ${s.key}`)).toEqual([
      'drop_index cf_old', 'drop_column cf_re', 'drop_column cf_old', 'add_column cf_re', 'add_column cf_new', 'create_index cf_new',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Idempotence — two runs against the fake engine
// ─────────────────────────────────────────────────────────────

describe('reconcile — idempotent against an engine that applies the DDL', () => {
  function world() {
    return engine({
      defs: [
        def('case', 'cf_al', 'text', { indexed: 1 }), def('case', 'cf_nm', 'number'),
        def('contact', 'cf_ms', 'multiselect', { indexed: 1 }), def('contact', 'cf_bo', 'boolean', { indexed: 1 }),
        def('case', 'cf_retired', 'text', { active: 0 }),
      ],
      // cf_old is an orphan that is NOT the last column (INSTANT would 1845);
      // cf_nm exists with the wrong type
      columns: [col('cases', 'cf_old'), col('cases', 'cf_nm'), col('cases', 'cf_retired')],
      indexes: [{ TABLE_NAME: 'cases', INDEX_NAME: 'idx_cf_old', COLUMN_NAME: 'cf_old' }],
    });
  }

  test('first run converges; the second plans and issues nothing', async () => {
    const db = world();
    const r1 = await reconciler.reconcile(db, { trigger: 'manual' });
    expect(r1.status).toBe('ok');
    expect(r1.failed).toBeNull();
    expect(r1.executed).toHaveLength(r1.plan.length);
    expect(r1.skipped.map(s => s.key)).toEqual(['cf_ms']);

    const shape = t => db.state.columns.filter(c => c.TABLE_NAME === t).map(c => `${c.COLUMN_NAME}:${c.COLUMN_TYPE}`).sort();
    expect(shape('cases')).toEqual(['cf_al:varchar(255)', 'cf_nm:decimal(18,4)']);
    expect(shape('contacts')).toEqual(['cf_bo:tinyint(1)', 'cf_ms:json']);
    expect(db.state.indexes.map(i => i.INDEX_NAME).sort()).toEqual(['idx_cf_al', 'idx_cf_bo']);

    const before = ddlOf(db).length;
    const r2 = await reconciler.reconcile(db, { trigger: 'manual' });
    expect(r2.status).toBe('noop');
    expect(r2.plan).toEqual([]);
    expect(ddlOf(db)).toHaveLength(before);
  });

  test('a real run holds the lock and the low MDL timeout for every statement, then restores both', async () => {
    const db = world();
    await reconciler.reconcile(db, {});
    const conn = db.state.ddlConn;
    const mine = db.state.log.filter(q => q.conn === conn).map(q => q.s);
    expect(mine[0]).toBe('SELECT GET_LOCK(?, 0) AS got');
    expect(mine[1]).toBe('SET SESSION lock_wait_timeout = ?');
    expect(mine.slice(-2)).toEqual(['SET SESSION lock_wait_timeout = @@GLOBAL.lock_wait_timeout', 'SELECT RELEASE_LOCK(?)']);
    expect(db.state.session[conn]).toBe('global');
    expect(db.state.lockHeldBy).toBeNull();
    expect(db.state.released).toBe(1);
    expect(db.state.destroyed).toBe(0);
    expect(db.state.tx).toBe(0); // never a transaction — DDL commits implicitly
  });

  test('dry run: plan under the lock, execute nothing, audit nothing', async () => {
    const db = world();
    const r = await reconciler.reconcile(db, { dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.plan.length).toBeGreaterThan(0);
    expect(r.executed).toEqual([]);
    expect(ddlOf(db)).toEqual([]);
    expect(audits(db)).toEqual([]);
  });

  test('empty registry, no columns (today\'s boot) → noop: three reads, no DDL, no audit, no alert', async () => {
    const db = engine();
    const r = await reconciler.reconcile(db, { trigger: 'boot' });
    expect(r.status).toBe('noop');
    expect(ddlOf(db)).toEqual([]);
    expect(audits(db)).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
    expect(db.state.log.filter(q => /^SELECT .* FROM (field_defs|information_schema)/.test(q.s))).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Guards — lock, MDL timeout, failures
// ─────────────────────────────────────────────────────────────

describe('reconcile — guards', () => {
  test('lock busy → one retry → still busy: status locked, alert, no DDL, every connection released', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text')], lockHeldBy: 999 });
    const r = await reconciler.reconcile(db, { trigger: 'create' });
    expect(r.status).toBe('locked');
    expect(db.state.log.filter(q => /GET_LOCK/.test(q.s))).toHaveLength(2);
    expect(db.state.conns).toBe(2);
    expect(db.state.released).toBe(2);
    expect(ddlOf(db)).toEqual([]);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({
      kind: 'field_defs_reconcile_lock_busy', group_key: 'app:field_defs_reconcile_lock_busy', severity: 'error',
    }));
  });

  test('lock busy on the first try, free on the retry → runs', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text')], fail: [{ re: /GET_LOCK/, times: 0 }] });
    let calls = 0;
    const inner = db.getConnection;
    db.getConnection = async () => {
      const c = await inner();
      const q = c.query;
      c.query = async (sql, p) => (/GET_LOCK/.test(sql) && ++calls === 1 ? [[{ got: 0 }]] : q(sql, p));
      return c;
    };
    const r = await reconciler.reconcile(db, {});
    expect(r.status).toBe('ok');
    expect(calls).toBe(2);
  });

  test('ER_LOCK_WAIT_TIMEOUT once → retried and succeeds', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text')], fail: [{ re: /^ALTER TABLE/, times: 1, errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' }] });
    const r = await reconciler.reconcile(db, {});
    expect(r.status).toBe('ok');
    expect(db.state.log.filter(q => /^ALTER TABLE/.test(q.s))).toHaveLength(2);
    expect(alert).not.toHaveBeenCalled();
  });

  test('ER_LOCK_WAIT_TIMEOUT twice → stop at that statement, alert, audit status error, lock + session restored', async () => {
    const db = engine({
      defs: [def('case', 'cf_al', 'text', { indexed: 1 }), def('case', 'cf_bo', 'text')],
      fail: [{ re: /ADD COLUMN `cf_bo`/, times: 2, errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', message: 'Lock wait timeout exceeded' }],
    });
    const r = await reconciler.reconcile(db, { trigger: 'create', actor: { userId: 6, username: 'fred', route: '/api/field-defs', method: 'POST' } });
    expect(r.status).toBe('failed');
    expect(r.executed.map(s => `${s.action} ${s.key}`)).toEqual(['add_column cf_al']);
    expect(r.failed).toEqual(expect.objectContaining({ code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205, sql: expect.stringMatching(/ADD COLUMN `cf_bo`/) }));
    // the index step after the failure was never attempted
    expect(ddlOf(db).some(s => /CREATE INDEX/.test(s))).toBe(false);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ kind: 'field_defs_reconcile_failed', severity: 'error' }));
    const [a] = audits(db).map(auditRow);
    expect(a).toEqual(expect.objectContaining({ tool: 'field_defs', status: 'error', userId: 6, username: 'fred', route: '/api/field-defs', method: 'POST' }));
    expect(a.details.executed).toHaveLength(1);
    expect(a.details.failed).toMatch(/cf_bo/);
    expect(db.state.lockHeldBy).toBeNull();
    expect(db.state.released).toBe(1);
  });

  test('any other DDL error is not retried', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text')], fail: [{ re: /^ALTER TABLE/, times: 1, errno: 1118, code: 'ER_TOO_BIG_ROWSIZE' }] });
    const r = await reconciler.reconcile(db, {});
    expect(r.status).toBe('failed');
    expect(db.state.log.filter(q => /^ALTER TABLE/.test(q.s))).toHaveLength(1);
  });

  test('restoring the session timeout fails → the connection is destroyed, never returned to the pool', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text')], restoreFails: true });
    const r = await reconciler.reconcile(db, {});
    expect(r.status).toBe('ok');
    expect(db.state.destroyed).toBe(1);
    expect(db.state.released).toBe(0);
  });

  test('a read failing under the lock → failed + alert, still unlocked and released; reconcile never throws', async () => {
    const db = engine({ fail: [{ re: /FROM field_defs/, times: 1, errno: 1146, message: "Table 'field_defs' doesn't exist" }] });
    const r = await reconciler.reconcile(db, {});
    expect(r.status).toBe('failed');
    expect(db.state.lockHeldBy).toBeNull();
    expect(db.state.released).toBe(1);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ kind: 'field_defs_reconcile_failed' }));
    const noConn = { getConnection: async () => { throw new Error('ECONNREFUSED'); }, query: async () => [[]] };
    await expect(reconciler.reconcile(noConn, {})).resolves.toEqual(expect.objectContaining({ status: 'failed' }));
  });

  test('transient connect (ETIMEDOUT) on the first acquire → one retry, then a normal run, no alert', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text')] });
    const inner = db.getConnection;
    let calls = 0;
    db.getConnection = async () => {
      if (++calls === 1) throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return inner();
    };
    const r = await reconciler.reconcile(db, { trigger: 'boot' });
    expect(r.status).toBe('ok');
    expect(calls).toBe(2);
    expect(alert).not.toHaveBeenCalled();
  });

  test('transient connect on both attempts at boot → failed, WARNING severity, transient flagged', async () => {
    const db = { getConnection: async () => { throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); }, query: async () => [[]] };
    const r = await reconciler.reconcile(db, { trigger: 'boot' });
    expect(r.status).toBe('failed');
    expect(r.failed).toEqual(expect.objectContaining({ code: 'ETIMEDOUT' }));
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({
      kind: 'field_defs_reconcile_failed', severity: 'warning',
      context: expect.objectContaining({ trigger: 'boot', transient: true }),
    }));
  });

  test('transient connect on both attempts on a user-triggered run → still ERROR severity', async () => {
    let calls = 0;
    const db = { getConnection: async () => { calls++; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }, query: async () => [[]] };
    const r = await reconciler.reconcile(db, { trigger: 'create' });
    expect(r.status).toBe('failed');
    expect(calls).toBe(2);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({
      kind: 'field_defs_reconcile_failed', severity: 'error',
    }));
  });

  test('a non-transient acquire failure is NOT retried, and boot severity stays error', async () => {
    let calls = 0;
    const db = { getConnection: async () => { calls++; throw Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' }); }, query: async () => [[]] };
    const r = await reconciler.reconcile(db, { trigger: 'boot' });
    expect(r.status).toBe('failed');
    expect(calls).toBe(1);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ kind: 'field_defs_reconcile_failed', severity: 'error' }));
  });

  test('a conflicted def raises a warning alert and is left alone', async () => {
    const db = engine({ defs: [def('case', 'cf_real', 'text')], columns: [col('cases', 'cf_real', { EXTRA: '', GENERATION_EXPRESSION: '' })] });
    const r = await reconciler.reconcile(db, {});
    expect(r.status).toBe('noop');
    expect(r.conflicts).toHaveLength(1);
    expect(alert).toHaveBeenCalledWith(db, expect.objectContaining({ kind: 'field_defs_reconcile_conflict', severity: 'warning' }));
    expect(db.state.columns).toHaveLength(1);
  });

  test('a successful DDL run writes exactly one audit row naming every statement; boot is attributed to the system', async () => {
    const db = engine({ defs: [def('case', 'cf_al', 'text', { indexed: 1 })] });
    const r = await reconciler.reconcile(db, { trigger: 'boot' });
    const rows = audits(db).map(auditRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ tool: 'field_defs', status: 'success', username: 'system', route: 'startup/init', method: 'BOOT' }));
    expect(rows[0].details).toEqual(expect.objectContaining({ action: 'reconcile', trigger: 'boot', executed: r.executed.map(s => s.sql) }));
    expect(rows[0].details.executed).toHaveLength(2);
  });

  test('scheduleReconcile coalesces a burst: one run in flight, ONE follow-up with the latest trigger, then quiet', async () => {
    const gates = [];
    const spy = jest.spyOn(reconciler, 'reconcile').mockImplementation(() => new Promise(r => gates.push(r)));
    const db = { marker: 'pool' };
    for (const t of ['create', 'create', 'deactivate', 'update', 'reactivate']) reconciler.scheduleReconcile(db, { trigger: t });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ trigger: 'create' });
    gates[0]({ status: 'ok' }); await tick(); await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toEqual({ trigger: 'reactivate' });
    gates[1]({ status: 'noop' }); await tick(); await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    // idle again → the next call runs immediately
    reconciler.scheduleReconcile(db, { trigger: 'boot' });
    expect(spy).toHaveBeenCalledTimes(3);
    gates[2]({ status: 'noop' }); await tick(); await tick();
  });

  test('a rejected run still frees the slot for the follow-up', async () => {
    const spy = jest.spyOn(reconciler, 'reconcile')
      .mockImplementationOnce(() => Promise.reject(new Error('bug')))
      .mockImplementationOnce(async () => ({ status: 'ok' }));
    reconciler.scheduleReconcile({}, { trigger: 'create' });
    reconciler.scheduleReconcile({}, { trigger: 'update' });
    await tick(); await tick(); await tick();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('scheduleReconcile never throws and returns nothing (fire-and-forget)', async () => {
    const spy = jest.spyOn(reconciler, 'reconcile');
    expect(reconciler.scheduleReconcile({ getConnection: async () => { throw new Error('down'); }, query: async () => [[]] }, { trigger: 'boot' })).toBeUndefined();
    await tick(); await tick();
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────
// 4/5. Triggers from the service, boot, and the routes
// ─────────────────────────────────────────────────────────────

function registryDb(rows = []) {
  const state = { rows: rows.map(r => ({ ...r })), nextId: 50, log: [], audits: [] };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.log.push(s);
    if (/^INSERT INTO admin_audit_log/.test(s)) { state.audits.push(params); return [{ insertId: 1 }]; }
    if (/^SELECT id FROM field_defs WHERE entity = \? AND field_key = \? LIMIT 1$/.test(s)) {
      return [[...state.rows.filter(r => r.entity === params[0] && r.field_key === params[1])]];
    }
    if (/information_schema\.COLUMNS/.test(s)) return [[]];
    if (/^INSERT INTO field_defs/.test(s)) {
      const [entity, field_key, label, field_type, options, validation, show_when, sort_order, active] = params;
      const id = state.nextId++;
      state.rows.push({ id, entity, field_key, label, field_type, options, validation, show_when, sort_order, active, indexed: 0 });
      return [{ insertId: id }];
    }
    if (/WHERE id = \? LIMIT 1 FOR UPDATE$/.test(s)) return [[...state.rows.filter(r => r.id === params[0])]];
    if (/JSON_CONTAINS/.test(s)) return [[]];
    if (/^UPDATE field_defs SET active = \? WHERE id = \?$/.test(s)) {
      const r = state.rows.find(x => x.id === params[1]); if (r) r.active = params[0];
      return [{ affectedRows: r ? 1 : 0 }];
    }
    if (/^UPDATE field_defs SET .* WHERE id = \?$/.test(s)) return [{ affectedRows: 1 }];
    throw new Error('registryDb: unscripted query — ' + s);
  };
  return {
    state, query,
    getConnection: async () => ({ query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }),
  };
}

const SEL = {
  id: 7, entity: 'case', field_key: 'cf_status', label: 'Status', field_type: 'select',
  options: JSON.stringify([{ value: 'open', label: 'Open' }]), validation: null, show_when: null,
  indexed: 0, sort_order: 0, active: 1,
};

describe('the service fires the reconcile exactly for column-surface changes', () => {
  let spy;
  beforeEach(() => { spy = jest.spyOn(reconciler, 'scheduleReconcile').mockImplementation(() => {}); });

  test('create / deactivate / reactivate / field_type change → one scheduleReconcile each, with the actor', async () => {
    const db = registryDb([SEL]);
    const actor = { userId: 6, route: '/x', method: 'POST' };
    await fieldDefs.createDef(db, { entity: 'case', field_key: 'cf_new', label: 'New', field_type: 'text' }, { actor });
    await fieldDefs.setActive(db, 7, false, { actor });
    await fieldDefs.setActive(db, 7, true, { actor });
    await fieldDefs.updateDef(db, 7, { field_type: 'text', options: null }, { actor });
    expect(spy.mock.calls.map(c => c[1])).toEqual([
      { trigger: 'create', actor }, { trigger: 'deactivate', actor }, { trigger: 'reactivate', actor }, { trigger: 'update', actor },
    ]);
    expect(spy.mock.calls.every(c => c[0] === db)).toBe(true);
  });

  test('label / options / validation / sort_order / show_when edits do NOT reconcile', async () => {
    const db = registryDb([SEL]);
    await fieldDefs.updateDef(db, 7, { label: 'Case status' });
    await fieldDefs.updateDef(db, 7, { options: [{ value: 'open', label: 'Opened' }, { value: 'closed', label: 'Closed' }] });
    await fieldDefs.updateDef(db, 7, { validation: { required: true } });
    await fieldDefs.updateDef(db, 7, { sort_order: 4, show_when: { x: 1 } });
    await fieldDefs.updateDef(db, 7, { field_type: 'select' }); // same type — not a change
    expect(spy).not.toHaveBeenCalled();
  });

  test('a rejected mutation fires nothing', async () => {
    const db = registryDb([SEL]);
    await expect(fieldDefs.createDef(db, { entity: 'case', field_key: 'cf_X', label: 'x', field_type: 'text' })).rejects.toThrow();
    await expect(fieldDefs.setActive(db, 999, false)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  test('boot (startup/init.js) schedules one reconcile with trigger boot', async () => {
    jest.spyOn(require('../lib/taskQueue'), 'warmup').mockImplementation(() => {});
    const pool = { marker: 'pool' };
    await require('../startup/init')(pool);
    expect(spy).toHaveBeenCalledWith(pool, { trigger: 'boot' });
  });
});

describe('routes/api.fieldDefs.js — audit rows + POST /api/field-defs/reconcile', () => {
  const router = require('../routes/api.fieldDefs');
  let server, base, db;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => { db = registryDb([SEL]); jest.spyOn(reconciler, 'scheduleReconcile').mockImplementation(() => {}); });

  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const row = p => ({ tool: p[0], userId: p[1], username: p[2], route: p[3], method: p[4], status: p[5], details: JSON.parse(p[10]) });

  test('every mutation writes one field_defs audit row; reads and rejections write none', async () => {
    await call('GET', '/api/field-defs?entity=case');
    await call('POST', '/api/field-defs', { entity: 'case', field_key: 'cf_X', label: 'x', field_type: 'text' }); // 400
    await tick();
    expect(db.state.audits).toEqual([]);

    await call('POST', '/api/field-defs', { entity: 'case', field_key: 'cf_ref', label: 'Referral', field_type: 'text' });
    await call('PATCH', '/api/field-defs/7', { label: 'Case status' });
    await call('POST', '/api/field-defs/7/deactivate');
    await call('POST', '/api/field-defs/7/reactivate');
    await tick();
    const rows = db.state.audits.map(row);
    expect(rows.map(r => r.details.action)).toEqual(['create', 'update', 'deactivate', 'reactivate']);
    expect(rows.every(r => r.tool === 'field_defs' && r.status === 'success' && r.userId === 6 && r.username === 'fred')).toBe(true);
    expect(rows.map(r => `${r.method} ${r.route}`)).toEqual([
      'POST /api/field-defs', 'PATCH /api/field-defs/7', 'POST /api/field-defs/7/deactivate', 'POST /api/field-defs/7/reactivate',
    ]);
    expect(rows[0].details).toEqual(expect.objectContaining({ id: 50, field_key: 'cf_ref', body: expect.objectContaining({ label: 'Referral' }) }));
    expect(rows[1].details.patch).toEqual({ label: 'Case status' });
    // the reconcile the create triggered carries the same actor
    const [, opts] = reconciler.scheduleReconcile.mock.calls[0];
    expect(opts).toEqual({ trigger: 'create', actor: expect.objectContaining({ userId: 6, username: 'fred', route: '/api/field-defs', method: 'POST' }) });
  });

  test('reconcile → 200 with the plan; dry_run passes through; the actor rides along', async () => {
    const spy = jest.spyOn(reconciler, 'reconcile').mockResolvedValue({ status: 'ok', plan: [{ sql: 'X' }], executed: [{ sql: 'X' }], failed: null, skipped: [], conflicts: [] });
    const r = await call('POST', '/api/field-defs/reconcile', { dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'success', result: expect.objectContaining({ status: 'ok', executed: [{ sql: 'X' }] }) });
    expect(spy).toHaveBeenCalledWith(db, { trigger: 'manual', dryRun: true, actor: expect.objectContaining({ userId: 6, route: '/api/field-defs/reconcile' }) });
  });

  test('locked → 409; failed → 500 carrying the statement + error code but not the engine message', async () => {
    jest.spyOn(reconciler, 'reconcile').mockResolvedValueOnce({ status: 'locked', plan: [], executed: [], failed: null, skipped: [], conflicts: [] });
    expect((await call('POST', '/api/field-defs/reconcile')).status).toBe(409);
    jest.spyOn(reconciler, 'reconcile').mockResolvedValueOnce({
      status: 'failed', plan: [], executed: [], skipped: [], conflicts: [],
      failed: { sql: 'ALTER TABLE `cases` …', code: 'ER_TOO_BIG_ROWSIZE', errno: 1118, message: 'Row size too large. The maximum row size…' },
    });
    const f = await call('POST', '/api/field-defs/reconcile');
    expect(f.status).toBe(500);
    expect(f.body.result.failed).toEqual({ sql: 'ALTER TABLE `cases` …', code: 'ER_TOO_BIG_ROWSIZE', errno: 1118 });
    expect(JSON.stringify(f.body)).not.toMatch(/Row size too large/);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. Caps — the VARCHAR width is enforced at write + def time
// ─────────────────────────────────────────────────────────────

describe('STRING_MAX_LEN caps (the S3 column width)', () => {
  const textDef = { field_key: 'cf_tx', field_type: 'text', validation: null };

  test('text: 255 characters ok (counted as characters, not UTF-16 units), 256 refused even with no max_len', () => {
    expect(fieldDefs.validateValue(textDef, 'x'.repeat(255))).toEqual({ ok: true, value: 'x'.repeat(255) });
    expect(fieldDefs.validateValue(textDef, '😀'.repeat(255)).ok).toBe(true);
    const r = fieldDefs.validateValue(textDef, 'x'.repeat(256));
    expect(r).toEqual({ ok: false, error: 'cf_tx: must be 255 characters or fewer (got 256)' });
  });

  test('option values over 255 characters are refused at def time; max_len can promise at most 255', async () => {
    const db = registryDb();
    const bad = fieldDefs.validateDef(db, { entity: 'case', field_key: 'cf_sl', label: 'S', field_type: 'select',
      options: [{ value: 'v'.repeat(256), label: 'Long' }] });
    await expect(bad).rejects.toThrow(/options\[0\]\.value must be 255 characters or fewer/);
    await expect(fieldDefs.validateDef(db, { entity: 'case', field_key: 'cf_sl', label: 'S', field_type: 'select',
      options: [{ value: 'v'.repeat(255), label: 'Long' }] })).resolves.toBeTruthy();
    await expect(fieldDefs.validateDef(db, { entity: 'case', field_key: 'cf_tx', label: 'T', field_type: 'text', validation: { max_len: 256 } }))
      .rejects.toThrow(/validation\.max_len must be a whole number from 1 to 255/);
    await expect(fieldDefs.validateDef(db, { entity: 'case', field_key: 'cf_tx', label: 'T', field_type: 'text', validation: { max_len: 255 } }))
      .resolves.toBeTruthy();
  });

  test('KEY_RE: 60 characters max, so idx_<key> fits MySQL\'s 64-char identifier cap', () => {
    const k60 = 'cf_' + 'a' + 'b'.repeat(56);
    expect(fieldDefs.KEY_RE.test(k60)).toBe(true);
    expect(fieldDefs.KEY_RE.test(k60 + 'b')).toBe(false);
    const p = reconciler.planFor([def('case', k60, 'text', { indexed: 1 })], [], []);
    const idx = p.steps[1].sql.match(/CREATE INDEX `(\w+)`/)[1];
    expect(idx).toHaveLength(64);
  });
});

// ─────────────────────────────────────────────────────────────
// 7. Rider A — mergeCases vs generated columns + the custom bag
// ─────────────────────────────────────────────────────────────

describe('mergeCases — generated columns and the custom bag (design doc §9)', () => {
  const SURVIVOR = 'AAAAAAAA';
  const LOSER = 'BBBBBBBB';

  function mergeDb({ survivor = {}, loser = {}, generated = ['cf_al', 'cf_nm'] } = {}) {
    const base = {
      case_stage: 'Open', case_status: 'New', case_type: 'Bankruptcy', case_number: '', case_number_full: '',
      case_notes: '', case_alerts: '', case_dropbox: '', case_open_date: null, pipeline_phase: 'lead', custom: {},
    };
    const rows = [{ case_id: SURVIVOR, ...base, ...survivor }, { case_id: LOSER, ...base, ...loser }];
    const calls = [];
    const query = async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/^SELECT \* FROM cases WHERE case_id IN/.test(s)) return [rows.map(r => ({ ...r }))];
      if (/FROM information_schema\.COLUMNS/.test(s)) {
        expect(s).toMatch(/TABLE_NAME = 'cases' AND GENERATION_EXPRESSION <> ''/);
        return [generated.map(c => ({ COLUMN_NAME: c }))];
      }
      if (/FROM cases WHERE case_id NOT IN/.test(s)) return [[]];
      if (/FROM checklists l JOIN checklists s/.test(s)) return [[]];
      if (/SELECT COUNT\(\*\) AS c/.test(s)) return [[{ c: 0 }]];
      if (/^(DELETE|UPDATE|INSERT)/.test(s)) return [{ affectedRows: 0 }];
      return [[]];
    };
    const conn = { query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
    return { calls, query, getConnection: async () => conn };
  }
  const updates = db => db.calls.filter(c => /^UPDATE cases SET/.test(c.sql));

  // post-S3 rows: the bag AND the virtual columns SELECT * returns alongside it
  const POST_S3 = {
    survivor: { custom: { cf_same: 'q', cf_diff: 'S', cf_zero: 0 }, cf_al: null, cf_nm: null },
    loser:    { custom: { cf_al: 'x', cf_nm: 5, cf_same: 'q', cf_diff: 'L', cf_zero: 3, cf_tags: ['a', 'b'] }, cf_al: 'x', cf_nm: '5.0000' },
  };

  test('dry run: bag keys fill / skip / conflict per key; generated columns appear nowhere', async () => {
    const plan = await caseService.mergeCases(mergeDb(POST_S3), SURVIVOR, LOSER, { dryRun: true });
    expect(plan.fields.filled).toEqual(['custom.cf_al', 'custom.cf_nm', 'custom.cf_tags']);
    expect(plan.fields.conflicts).toEqual([
      { column: 'custom.cf_diff', survivor: 'S', loser: 'L' },
      // 0 is a VALUE in the bag (unlike the generic isEmpty) — a conflict, not a fill
      { column: 'custom.cf_zero', survivor: 0, loser: 3 },
    ]);
    const cols = [...plan.fields.filled, ...plan.fields.conflicts.map(c => c.column), ...plan.fields.survivor_wins.map(c => c.column)];
    expect(cols.some(c => c === 'cf_al' || c === 'cf_nm' || c === 'custom')).toBe(false);
  });

  test('a bag conflict blocks like a core-column conflict (MERGE_CONFLICT, nothing written)', async () => {
    const db = mergeDb(POST_S3);
    const err = await caseService.mergeCases(db, SURVIVOR, LOSER).catch(e => e);
    expect(err.code).toBe('MERGE_CONFLICT');
    expect(err.conflicts.map(c => c.column)).toEqual(['custom.cf_diff', 'custom.cf_zero']);
    expect(updates(db)).toEqual([]);
  });

  test('force: fills compose into the ONE survivor UPDATE via customAssignment; survivor keeps its conflicting values; no generated column is assigned', async () => {
    const db = mergeDb(POST_S3);
    await caseService.mergeCases(db, SURVIVOR, LOSER, { force: true });
    const ups = updates(db);
    expect(ups).toHaveLength(1);
    const { sql, params } = ups[0];
    expect(sql).toBe('UPDATE cases SET `custom` = JSON_SET(`custom`, ?, CAST(? AS JSON), ?, CAST(? AS JSON), ?, CAST(? AS JSON)) WHERE case_id = ?');
    expect(params).toEqual(['$.cf_al', '"x"', '$.cf_nm', '5', '$.cf_tags', '["a","b"]', SURVIVOR]);
    // the 3105 the rider exists for: never `cf_al` = ? / `cf_nm` = ?
    expect(sql).not.toMatch(/`cf_(a|n)` =/);
    expect(params).not.toContain('L');
  });

  test('the snapshot in log_extra carries the loser\'s whole bag (and its cf_ columns)', async () => {
    await caseService.mergeCases(mergeDb(POST_S3), SURVIVOR, LOSER, { force: true });
    const extra = logService.createLogEntry.mock.calls[0][1].extra.merge;
    expect(extra.loser_snapshot.custom).toEqual(POST_S3.loser.custom);
    expect(extra.loser_snapshot.cf_al).toBe('x');
    expect(extra.filled).toEqual(['custom.cf_al', 'custom.cf_nm', 'custom.cf_tags']);
    expect(extra.forced_conflicts.map(c => c.column)).toEqual(['custom.cf_diff', 'custom.cf_zero']);
  });

  test('core fills and bag fills share the statement; params stay aligned', async () => {
    const db = mergeDb({ survivor: { case_type: '' }, loser: { case_type: 'Bankruptcy', custom: { cf_al: 'x' }, cf_al: 'x' } });
    await caseService.mergeCases(db, SURVIVOR, LOSER);
    const [{ sql, params }] = updates(db);
    expect(sql).toBe('UPDATE cases SET `case_type` = ?, `custom` = JSON_SET(`custom`, ?, CAST(? AS JSON)) WHERE case_id = ?');
    expect(params).toEqual(['Bankruptcy', '$.cf_al', '"x"', SURVIVOR]);
  });

  test('generated columns are read fresh on every merge — never cached', async () => {
    const db = mergeDb(POST_S3);
    await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });
    await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });
    expect(db.calls.filter(c => /information_schema/.test(c.sql))).toHaveLength(2);
  });

  test('a brand-new generated column the loser fills is still never written (the skip is derived, not listed)', async () => {
    const db = mergeDb({ survivor: { cf_brand_new: null }, loser: { cf_brand_new: 'v' }, generated: ['cf_brand_new'] });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);
    expect(plan.fields.filled).toEqual([]);
    expect(updates(db)).toEqual([]);
  });

  test('equal bags → nothing; a string bag (driver without JSON parsing) is read the same; empty bags are fine', async () => {
    const same = await caseService.mergeCases(mergeDb({ survivor: { custom: { cf_xx: [1, 2] } }, loser: { custom: '{"cf_xx":[1,2]}' } }), SURVIVOR, LOSER, { dryRun: true });
    expect(same.fields.filled).toEqual([]);
    expect(same.fields.conflicts).toEqual([]);
    const fill = await caseService.mergeCases(mergeDb({ survivor: { custom: '{}' }, loser: { custom: '{"cf_xx":false}' } }), SURVIVOR, LOSER, { dryRun: true });
    expect(fill.fields.filled).toEqual(['custom.cf_xx']); // false is a value
    const none = await caseService.mergeCases(mergeDb({ survivor: { custom: null }, loser: { custom: undefined } }), SURVIVOR, LOSER, { dryRun: true });
    expect(none.fields.filled).toEqual([]);
  });

  test('a loser key that fails KEY_RE is a conflict, not a 500 — force drops it (snapshot keeps it)', async () => {
    const db = mergeDb({ loser: { custom: { 'BAD KEY': 1, cf_ok: 'y' } } });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });
    expect(plan.fields.conflicts).toEqual([{ column: 'custom.BAD KEY', survivor: null, loser: 1 }]);
    await caseService.mergeCases(db, SURVIVOR, LOSER, { force: true });
    expect(updates(db)[0].params).toEqual(['$.cf_ok', '"y"', SURVIVOR]);
  });
});

// ─────────────────────────────────────────────────────────────
// 8. Rider B — petition get_contacts egress
// ─────────────────────────────────────────────────────────────

describe('POST /api/intake/petition get_contacts — custom stripped, contact_ssn kept', () => {
  const router = require('../routes/api.intake.petition');
  let server, base, db;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  // The "already filed under this client" path — the shortest route to fetchContacts.
  const CONTACT = {
    contact_id: 42, contact_fname: 'John', contact_lname: 'Smith', contact_ssn: '123-45-6789',
    custom: { cf_clio_id: '991', cf_note: 'whole bag' }, cf_clio_id: '991',
  };
  beforeEach(() => {
    db = {
      query: async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT contact_id, contact_name FROM contacts WHERE contact_name LIKE/.test(s)) return [[{ contact_id: 42, contact_name: 'John Smith' }]];
        if (/FROM cases c LEFT JOIN case_relate cr/.test(s)) return [[{ case_id: 'CASE0001', client_id: 42 }]];
        if (/^SELECT case_relate_id FROM case_relate/.test(s)) return [[{ case_relate_id: 1 }]];
        if (/^SELECT \* FROM contacts WHERE contact_id IN/.test(s)) { expect(params).toEqual([42]); return [[{ ...CONTACT }]]; }
        throw new Error('petition stub: unscripted query — ' + s);
      },
    };
  });

  test('primary_contact has no `custom`, keeps contact_ssn, and keeps the named cf_ column', async () => {
    const res = await fetch(base + '/api/intake/petition', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_name: 'John Smith', case_number: '26-12345', chapter: '7', get_contacts: true }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('already_filed');
    expect(body.primary_contact).not.toHaveProperty('custom');
    expect(body.primary_contact.contact_ssn).toBe('123-45-6789');
    expect(body.primary_contact.cf_clio_id).toBe('991');
    expect(JSON.stringify(body)).not.toMatch(/whole bag/);
  });
});
