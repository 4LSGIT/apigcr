// tests/pipelineService.test.js
//
// Slice B service assertions for services/pipelineService.js, exercised
// against STUB mysql2 pools/connections that record every (sql, params) call
// and return scripted rows — no database needed (stub pattern from
// tests/formTemplates_slice4_service_test.js, jest-hosted like
// tests/taskService.test.js).
//
// Covers (per the slice spec):
//   - resolveTemplate branch order (blank subtype → intake; exact
//     type+subtype; is_default fallback; final intake fallback; caseless
//     matching mirroring utf8mb4_general_ci).
//   - getPipeline upcoming computation, including the branched-from-intake
//     case (current stage_key not in the resolved template → ALL stages).
//   - advanceStage idempotency no-op (no INSERT/UPDATE; lock still released;
//     payload carries noop:true).
//   - case_status truncation at 50 on a real advance (log keeps the ≤100
//     snapshot; cases gets the 50-clip).
//
// Run:
//   npx jest tests/pipelineService.test.js

'use strict';

// (Trigger System T3) advanceStage emits case.stage_advanced post-commit.
// The emission runs the trigger engine, which issues its OWN pool queries
// (rule load + execution log) — against these scripted stubs those would
// consume the rows getPipeline expects. The engine has its own coverage;
// mocking it here keeps this file a pipeline unit test AND lets the
// emission itself be asserted.
jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction: (_ruleId, fn) => fn(),
  MAX_DEPTH: 4,
}));

const domainEvents = require('../lib/domainEvents');
const svc = require('../services/pipelineService');

beforeEach(() => { domainEvents.emit.mockClear(); });

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      return [script.shift()];
    },
  };
}

// Pool stub that also satisfies withTransaction: getConnection() hands out a
// conn whose query() shifts from `connScript`; pool-level query() (used by the
// post-commit getPipeline) shifts from `poolScript`. Both call logs recorded.
function stubTxDb(connScript, poolScript) {
  const connCalls = [];
  const poolCalls = [];
  const conn = {
    query: async (sql, params) => {
      connCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!connScript.length) throw new Error('stubTxDb(conn): unscripted query: ' + sql);
      return [connScript.shift()];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    destroy: () => {},
  };
  return {
    connCalls,
    poolCalls,
    getConnection: async () => conn,
    query: async (sql, params) => {
      poolCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!poolScript.length) throw new Error('stubTxDb(pool): unscripted query: ' + sql);
      return [poolScript.shift()];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — mirror the Slice A seed shape
// ─────────────────────────────────────────────────────────────────────────────

const TPL_INTAKE = { id: 1, name: 'Intake', case_type: '', case_subtype: '', role: 'intake', is_default: 0, active: 1 };
const TPL_CH7    = { id: 2, name: 'Bankruptcy — Chapter 7',  case_type: 'Bankruptcy', case_subtype: 'Chapter 7',  role: 'case', is_default: 0, active: 1 };
const TPL_CH13   = { id: 3, name: 'Bankruptcy — Chapter 13', case_type: 'Bankruptcy', case_subtype: 'Chapter 13', role: 'case', is_default: 0, active: 1 };
const TPL_BK_DEFAULT = { id: 4, name: 'Bankruptcy — Default', case_type: 'Bankruptcy', case_subtype: '', role: 'case', is_default: 1, active: 1 };

const ALL_TPLS = [TPL_INTAKE, TPL_CH7, TPL_CH13];

const CH7_STAGES = [
  { stage_id: 21, stage_key: 'docs',        stage_number: 1, internal_label: 'Documents & Prep', client_label: 'Preparing your case', case_stage: 'Pending',   is_terminal: 0, default_rec: 'Complete schedules & matrix', client_visible: 1 },
  { stage_id: 22, stage_key: 'filed',       stage_number: 2, internal_label: 'Filed',            client_label: 'Your case is filed',  case_stage: 'Filed',     is_terminal: 0, default_rec: 'Sign post-petition contract (if appl.); 2nd course', client_visible: 1 },
  { stage_id: 23, stage_key: 'meeting_341', stage_number: 3, internal_label: '341 Meeting',      client_label: 'Meeting of creditors', case_stage: 'Filed',    is_terminal: 0, default_rec: 'Attend 341; provide requested docs', client_visible: 1 },
  { stage_id: 24, stage_key: 'discharge',   stage_number: 4, internal_label: 'Discharge',        client_label: 'Discharge entered',   case_stage: 'Concluded', is_terminal: 0, default_rec: 'Await closing', client_visible: 1 },
  { stage_id: 25, stage_key: 'closed',      stage_number: 5, internal_label: 'Closed',           client_label: 'Case closed',         case_stage: 'Closed',    is_terminal: 1, default_rec: '', client_visible: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// resolveTemplate — branch order
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveTemplate branch order', () => {
  test('blank subtype → intake template', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db, { case_type: 'Bankruptcy', case_subtype: '' });
    expect(t).toBe(ALL_TPLS[0]);
    expect(t.role).toBe('intake');
  });

  test('null subtype counts as blank → intake', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db, { case_type: 'Bankruptcy', case_subtype: null });
    expect(t.role).toBe('intake');
  });

  test('exact (type, subtype) match wins', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db, { case_type: 'Bankruptcy', case_subtype: 'Chapter 13' });
    expect(t.id).toBe(TPL_CH13.id);
  });

  test('matching mirrors utf8mb4_general_ci (caseless)', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db, { case_type: 'bankruptcy', case_subtype: 'chapter 7' });
    expect(t.id).toBe(TPL_CH7.id);
  });

  test('no exact match → is_default=1 template for the case_type', async () => {
    const db = stubDb([[...ALL_TPLS, TPL_BK_DEFAULT]]);
    const t = await svc.resolveTemplate(db, { case_type: 'Bankruptcy', case_subtype: 'Chapter 11' });
    expect(t.id).toBe(TPL_BK_DEFAULT.id);
  });

  test('no exact, no default → intake fallback', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db, { case_type: 'Bankruptcy', case_subtype: 'Chapter 11' });
    expect(t.role).toBe('intake');
  });

  test('nothing resolves (no intake either) → null, no throw', async () => {
    const db = stubDb([[TPL_CH7]]); // active templates but no intake, no match
    const t = await svc.resolveTemplate(db, { case_type: 'Estate', case_subtype: 'Probate' });
    expect(t).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPipeline — upcoming computation
// ─────────────────────────────────────────────────────────────────────────────

describe('getPipeline', () => {
  // Query order inside getPipeline: case row → templates → log rows → stages.

  test('404 on unknown case', async () => {
    const db = stubDb([[]]);
    await expect(svc.getPipeline(db, 'NOPE')).rejects.toMatchObject({ status: 404 });
  });

  test('no history: current null, upcoming = ALL template stages', async () => {
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
      ALL_TPLS.slice(),
      [],                       // no log rows — the universal day-one state
      CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.current).toBeNull();
    expect(p.history).toEqual([]);
    expect(p.template).toEqual({ id: 2, name: TPL_CH7.name, role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['docs', 'filed', 'meeting_341', 'discharge', 'closed']);
  });

  test('mid-pipeline: upcoming = stages after the current (matched by stage_key)', async () => {
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
      ALL_TPLS.slice(),
      [ // ascending history; last row is current
        { stage_id: 21, stage_key: 'docs',  case_stage: 'Pending', status_label: 'Documents & Prep', entered_at: 't1', entered_by: 6, source: 'manual', note: null },
        { stage_id: 22, stage_key: 'filed', case_stage: 'Filed',   status_label: 'Filed',            entered_at: 't2', entered_by: 6, source: 'manual', note: null },
      ],
      CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.current.stage_key).toBe('filed');
    expect(p.history).toHaveLength(2);
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['meeting_341', 'discharge', 'closed']);
    expect(p.stages.map(s => s.stage_key)).toEqual(['docs', 'filed', 'meeting_341', 'discharge', 'closed']);
    expect(p.stages.every(s => s.client_visible === 1 || s.client_visible === 0)).toBe(true);
  });

  test('branched from intake: current stage_key not in template → upcoming = ALL stages', async () => {
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
      ALL_TPLS.slice(),
      [ // history is intake-shaped; case just gained a subtype
        { stage_id: 4, stage_key: 'retained', case_stage: 'Pending', status_label: 'Retained', entered_at: 't1', entered_by: 6, source: 'manual', note: null },
      ],
      CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.current.stage_key).toBe('retained');            // history survives the branch
    expect(p.template.id).toBe(TPL_CH7.id);                  // but the template re-resolved
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['docs', 'filed', 'meeting_341', 'discharge', 'closed']);
  });

  test('no template resolves → template null, upcoming empty, no throw', async () => {
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Estate', case_subtype: 'Probate' }],
      [TPL_CH7],                // no intake, no match
      [],                       // log
      // NOTE: no stages query — template is null, so it must not run.
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.template).toBeNull();
    expect(p.upcoming).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// advanceStage
// ─────────────────────────────────────────────────────────────────────────────

describe('advanceStage', () => {
  const LOCK_OK = [{ lockAcquired: 1 }];
  const RELEASED = [{ 'RELEASE_LOCK(?)': 1 }];

  test('idempotent repeat → no-op: no INSERT/UPDATE, lock released, noop:true', async () => {
    // conn: GET_LOCK → case row → latest log row (Slice E1: read BEFORE
    //       resolution, so guards can consult it) → templates (resolveTemplate
    //       for key target) → stage lookup → RELEASE_LOCK
    const stageRow = { id: 22, template_id: 2, stage_key: 'filed', stage_number: 2, internal_label: 'Filed', case_stage: 'Filed', default_rec: 'x', active: 1 };
    const db = stubTxDb(
      [
        LOCK_OK,
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
        [{ id: 900, template_id: 2, stage_key: 'filed' }],   // latest === target
        ALL_TPLS.slice(),
        [stageRow],
        RELEASED,
      ],
      [ // post-tx getPipeline on the pool: case → templates → log → stages
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
        ALL_TPLS.slice(),
        [{ stage_id: 22, stage_key: 'filed', case_stage: 'Filed', status_label: 'Filed', entered_at: 't', entered_by: null, source: 'system', note: null }],
        CH7_STAGES.slice(),
      ]
    );
    const p = await svc.advanceStage(db, 'C1', 'filed', { userId: 6, source: 'manual' });
    expect(p.noop).toBe(true);
    const sqls = db.connCalls.map(c => c.sql);
    expect(sqls.some(s => s.startsWith('INSERT INTO case_stage_log'))).toBe(false);
    expect(sqls.some(s => s.startsWith('UPDATE cases'))).toBe(false);
    expect(sqls.some(s => s.includes('RELEASE_LOCK'))).toBe(true);
    expect(sqls.some(s => s.includes('FOR UPDATE'))).toBe(false); // design guard
    // (Trigger T3) a no-op advance is not a stage change — nothing emitted.
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('real advance by numeric stage_id: log snapshot ≤100, case_status clipped to 50', async () => {
    const longLabel = 'L'.repeat(80);   // >50, ≤100
    const stageRow = { id: 77, template_id: 9, stage_key: 'long', stage_number: 1, internal_label: longLabel, case_stage: 'Pending', default_rec: 'Do the thing', active: 1 };
    const db = stubTxDb(
      [
        LOCK_OK,
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
        [],                                                  // no latest row (read before resolution)
        [stageRow],                                          // direct id lookup (no template resolve)
        [{ insertId: 1 }],                                   // INSERT
        [{ affectedRows: 1 }],                               // UPDATE
        RELEASED,
      ],
      [
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
        ALL_TPLS.slice(),
        [{ stage_id: 77, stage_key: 'long', case_stage: 'Pending', status_label: longLabel, entered_at: 't', entered_by: 6, source: 'manual', note: 'hi' }],
        CH7_STAGES.slice(),
      ]
    );
    const p = await svc.advanceStage(db, 'C1', '77', { userId: 6, note: 'hi', source: 'manual' });
    expect(p.noop).toBe(false);

    const insert = db.connCalls.find(c => c.sql.startsWith('INSERT INTO case_stage_log'));
    expect(insert).toBeTruthy();
    // (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_by, source, note)
    expect(insert.params[5]).toBe(longLabel);               // ≤100 → untouched snapshot
    expect(insert.params[6]).toBe(6);
    expect(insert.params[7]).toBe('manual');

    const update = db.connCalls.find(c => c.sql.startsWith('UPDATE cases'));
    expect(update).toBeTruthy();
    // (case_stage, case_status, case_rec, case_id)
    expect(update.params[0]).toBe('Pending');
    expect(update.params[1]).toBe(longLabel.slice(0, 50));  // varchar(50) clip
    expect(update.params[1]).toHaveLength(50);
    expect(update.params[2]).toBe('Do the thing');
    expect(update.params[3]).toBe('C1');

    // (Trigger T3) exactly one post-commit case.stage_advanced emission,
    // carrying the from/to details lifted out of the transaction.
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    const [, evt, payload] = domainEvents.emit.mock.calls[0];
    expect(evt).toBe('case.stage_advanced');
    expect(payload.case_id).toBe('C1');
    expect(payload.source).toBe('manual');
    expect(payload.actor.user_id).toBe(6);
    expect(payload.data.stage_key).toBe('long');
    expect(payload.data.stage_id).toBe(77);
    expect(payload.data.template_id).toBe(9);
    expect(payload.data.status_label).toBe(longLabel);   // full label, not clipped
    expect(payload.extra.from_stage).toBeNull();          // no prior log row
    expect(payload.extra.note).toBe('hi');
  });

  test('lock timeout → 409, no further conn work', async () => {
    const db = stubTxDb([[{ lockAcquired: 0 }]], []);
    await expect(svc.advanceStage(db, 'C1', 'filed', {})).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls).toHaveLength(1);                   // only the GET_LOCK
  });

  test('unknown stage_key (UNGUARDED) → 400, lock still released', async () => {
    const db = stubTxDb(
      [
        LOCK_OK,
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }],
        [],                                                 // latest log row (read before resolution)
        ALL_TPLS.slice(),
        [],                                                 // no matching stage
        RELEASED,
      ],
      []
    );
    await expect(svc.advanceStage(db, 'C1', 'not_a_stage', {})).rejects.toMatchObject({ status: 400 });
    expect(db.connCalls.some(c => c.sql.includes('RELEASE_LOCK'))).toBe(true);
  });

  test('unknown case → 404 (inside the lock, lock released)', async () => {
    const db = stubTxDb([LOCK_OK, [], RELEASED], []);
    await expect(svc.advanceStage(db, 'NOPE', 'filed', {})).rejects.toMatchObject({ status: 404 });
    expect(db.connCalls.some(c => c.sql.includes('RELEASE_LOCK'))).toBe(true);
  });

  test('bad source rejected up front → 400, no connection touched', async () => {
    const db = stubTxDb([], []);
    await expect(svc.advanceStage(db, 'C1', 'filed', { source: 'robot' })).rejects.toMatchObject({ status: 400 });
    expect(db.connCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// advanceStage — onlyFrom / onlyFromRole guards (Slice E1)
// ─────────────────────────────────────────────────────────────────────────────

describe('advanceStage guards (Slice E1)', () => {
  const LOCK_OK = [{ lockAcquired: 1 }];
  const RELEASED = [{ 'RELEASE_LOCK(?)': 1 }];
  const CASE_CH7 = [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' }];
  const DOCS_STAGE = { id: 5, template_id: 2, stage_key: 'docs', stage_number: 2, internal_label: 'Documents & Prep', case_stage: 'Pending', default_rec: 'Collect docs', active: 1 };
  const RETAINED_T2 = { id: 23, template_id: 2, stage_key: 'retained', stage_number: 1, internal_label: 'Retained', case_stage: 'Pending', default_rec: 'Send doc request', active: 1 };
  const POOL_PIPELINE = () => [ // post-tx getPipeline: case → templates → log → stages
    CASE_CH7.slice(),
    ALL_TPLS.slice(),
    [{ stage_id: 5, stage_key: 'docs', case_stage: 'Pending', status_label: 'Documents & Prep', entered_at: 't', entered_by: null, source: 'system', note: null }],
    CH7_STAGES.slice(),
  ];

  test('onlyFrom matches → normal advance (INSERT + UPDATE as today)', async () => {
    // conn: LOCK → case → latest (retained, t2) → [guard passes, no extra
    // query for onlyFrom] → templates → stage → INSERT → UPDATE → RELEASE
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 900, template_id: 2, stage_key: 'retained' }],
        ALL_TPLS.slice(),
        [DOCS_STAGE],
        [{ insertId: 1 }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { onlyFrom: ['retained'], source: 'system', note: 'Doc request sent' });
    expect(p.noop).toBe(false);
    expect(p.skipped).toBe(false);
    const sqls = db.connCalls.map(c => c.sql);
    expect(sqls.some(s => s.startsWith('INSERT INTO case_stage_log'))).toBe(true);
    expect(sqls.some(s => s.startsWith('UPDATE cases'))).toBe(true);
  });

  test('onlyFrom misses → skipped: no INSERT/UPDATE, no resolution, lock released', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 901, template_id: 2, stage_key: 'meeting_341' }],
        RELEASED,
      ],
      [] // NO pool queries — skipped path must not re-read getPipeline
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { onlyFrom: ['retained'], source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'meeting_341', reason: 'guard' });
    const sqls = db.connCalls.map(c => c.sql);
    expect(sqls.some(s => s.startsWith('INSERT INTO case_stage_log'))).toBe(false);
    expect(sqls.some(s => s.startsWith('UPDATE cases'))).toBe(false);
    expect(sqls.some(s => s.includes('RELEASE_LOCK'))).toBe(true);
    // THE ordering assertion: _resolveTarget was never reached — no template
    // resolution, no stage lookup ran on the connection.
    expect(sqls.some(s => s.includes('FROM pipeline_templates'))).toBe(false);
    expect(sqls.some(s => s.includes('FROM pipeline_stages'))).toBe(false);
    // (Trigger T3) a guard-skipped advance changed nothing — nothing emitted.
    expect(domainEvents.emit).not.toHaveBeenCalled();
    expect(db.poolCalls).toHaveLength(0);
  });

  test('onlyFrom [null] on a case with zero log rows → advances', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [],                       // no latest row → null member matches
        ALL_TPLS.slice(),
        [RETAINED_T2],
        [{ insertId: 1 }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { onlyFrom: [null], source: 'system' });
    expect(p.skipped).toBe(false);
    expect(p.noop).toBe(false);
    expect(db.connCalls.some(c => c.sql.startsWith('INSERT INTO case_stage_log'))).toBe(true);
  });

  test('REGRESSION: case at meeting_341 gets a doc request → skipped, no 400 escapes', async () => {
    // Task 2's worst available regression: an unguarded advance would drag
    // the case backwards to docs; a mis-ordered guard would 400 in
    // _resolveTarget. Guarded + reordered: clean skip.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 902, template_id: 2, stage_key: 'meeting_341' }],
        RELEASED,
      ],
      []
    );
    await expect(
      svc.advanceStage(db, 'C1', 'docs', { onlyFrom: ['retained'], source: 'system', note: 'Doc request sent' })
    ).resolves.toMatchObject({ skipped: true, from: 'meeting_341', reason: 'guard' });
    expect(db.connCalls.some(c => c.sql.includes('FROM pipeline_templates'))).toBe(false);
  });

  test('ISS path: intake case at consult_booked gets a doc request → clean skip, no throw', async () => {
    // Fact 6: sendingform-bk runs during the Initial Strategy Session, where
    // the case is on the Intake template and 'docs' does not even exist.
    // Pre-E1 this was a guaranteed 400 + alert on the most common path.
    const db = stubTxDb(
      [
        LOCK_OK,
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: '' }],  // → intake template
        [{ id: 903, template_id: 1, stage_key: 'consult_booked' }],
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { onlyFrom: ['retained'], source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'consult_booked', reason: 'guard' });
  });

  test('onlyFromRole intake: latest row on intake template, subtype already written → advances into t2', async () => {
    // Task 4 step 5's exact shape: update_case wrote the subtype (case now
    // resolves to Ch7), latest log row still carries a t1 stage. The role
    // guard judges the LOG ROW's template — intake — and lets the advance
    // through; 'retained' then resolves in the re-resolved t2.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 904, template_id: 1, stage_key: 'contract_sent' }],
        [{ role: 'intake' }],     // role lookup for latest.template_id=1
        ALL_TPLS.slice(),
        [RETAINED_T2],
        [{ insertId: 1 }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { onlyFromRole: ['intake', null], source: 'system' });
    expect(p.skipped).toBe(false);
    expect(p.noop).toBe(false);
    expect(db.connCalls.some(c => c.sql.startsWith('INSERT INTO case_stage_log'))).toBe(true);
  });

  test('onlyFromRole intake: latest row on a case template → skipped', async () => {
    // Ch7 Post-Filing agreement shape: the case is mid-pipeline on t2; a
    // contract send must NOT yank it back to intake's contract_sent.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 905, template_id: 2, stage_key: 'filed' }],
        [{ role: 'case' }],
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'contract_sent', { onlyFromRole: ['intake', null], source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'filed', reason: 'guard' });
  });

  test('onlyFromRole [.., null] with zero log rows → advances', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [],                       // no latest → null member matches, NO role query
        ALL_TPLS.slice(),
        [RETAINED_T2],
        [{ insertId: 1 }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { onlyFromRole: ['intake', null], source: 'system' });
    expect(p.skipped).toBe(false);
  });

  test('soft resolution: guard passes but key not in the current template → skipped, not 400', async () => {
    // Guard matched a t2 'retained' log row, but the subtype was cleared so
    // the case re-resolves to intake, where 'docs' does not exist. Guarded
    // advances skip here; unguarded still 400 (previous describe block).
    const db = stubTxDb(
      [
        LOCK_OK,
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: '' }],  // → intake
        [{ id: 906, template_id: 2, stage_key: 'retained' }],
        ALL_TPLS.slice(),
        [],                       // 'docs' not in intake template
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { onlyFrom: ['retained'], source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'retained', reason: 'unresolved' });
  });

  test('malformed guards → 400 up front, no connection touched', async () => {
    const db = stubTxDb([], []);
    await expect(svc.advanceStage(db, 'C1', 'docs', { onlyFrom: [] })).rejects.toMatchObject({ status: 400 });
    await expect(svc.advanceStage(db, 'C1', 'docs', { onlyFrom: 'retained' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.advanceStage(db, 'C1', 'docs', { onlyFromRole: [] })).rejects.toMatchObject({ status: 400 });
    expect(db.connCalls).toHaveLength(0);
  });

  test('guards absent (undefined AND null) → identical unguarded behavior', async () => {
    // null must degrade to absent, not 400 — callers computing
    // `cond ? arr : null` get today's behavior.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [],
        ALL_TPLS.slice(),
        [DOCS_STAGE],
        [{ insertId: 1 }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { onlyFrom: null, onlyFromRole: undefined, source: 'system' });
    expect(p.skipped).toBe(false);
    expect(p.noop).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveStageField
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveStageField', () => {
  test('v1 identity passthrough', () => {
    expect(svc.resolveStageField('case_file_date')).toBe('case_file_date');
    expect(svc.resolveStageField('anything')).toBe('anything');
  });
});