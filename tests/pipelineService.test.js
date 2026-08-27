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
//   - (R1) the lane filter: upcoming is MAIN-lane only, `stages` keeps both,
//     a case sitting ON an off-ramp keeps its position, and a lane-less row
//     (pre-migration payload) reads as main.
//   - (R1) the forwardOnly verdict matrix — one test per row of the table in
//     advanceStage's docblock, plus noop-beats-backward precedence, guard
//     combination, and the non-boolean 400.
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
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

beforeEach(() => { domainEvents.emit.mockClear(); });

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,                       // escape hatches: expectOverruns() / allowLeftovers()
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
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
  // Two arrays, two guards. The conn guard is the load-bearing one: advanceStage's
  // RELEASE_LOCK sits in a finally that swallows errors, so its exhaustion throw
  // never escapes — the guard records the overrun before throwing so the global
  // afterEach sees it anyway. That swallow is correct production behaviour and
  // stays exactly as it is; this is the test layer catching what it hides.
  const connGuard = scriptGuard('stubTxDb(conn)', connScript);
  const poolGuard = scriptGuard('stubTxDb(pool)', poolScript);
  const conn = {
    query: async (sql, params) => {
      connCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!connScript.length) connGuard.overrun(sql);
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
      if (!poolScript.length) poolGuard.overrun(sql);
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
// (R2.5) The live #5 — a role='case' template whose OWN case_subtype is blank
// AND which is is_default. It is the reason the forward-projection selector
// must short-circuit a blank subtype before matching: "subtype exact match"
// alone would pair every blank-subtype lead (721 live) with this row.
const TPL_CIVIL = { id: 5, name: 'Civil Litigation', case_type: 'Civil Litigation', case_subtype: '', role: 'case', is_default: 1, active: 1 };

const ALL_TPLS = [TPL_INTAKE, TPL_CH7, TPL_CH13];

const CH7_STAGES = [
  { stage_id: 21, stage_key: 'docs',        stage_number: 1, internal_label: 'Documents & Prep', client_label: 'Preparing your case', case_stage: 'Pending',   is_terminal: 0, lane: 'main', default_rec: 'Complete schedules & matrix', client_visible: 1 },
  { stage_id: 22, stage_key: 'filed',       stage_number: 2, internal_label: 'Filed',            client_label: 'Your case is filed',  case_stage: 'Filed',     is_terminal: 0, lane: 'main', default_rec: 'Sign post-petition contract (if appl.); 2nd course', client_visible: 1 },
  { stage_id: 23, stage_key: 'meeting_341', stage_number: 3, internal_label: '341 Meeting',      client_label: 'Meeting of creditors', case_stage: 'Filed',    is_terminal: 0, lane: 'main', default_rec: 'Attend 341; provide requested docs', client_visible: 1 },
  { stage_id: 24, stage_key: 'discharge',   stage_number: 4, internal_label: 'Discharge',        client_label: 'Discharge entered',   case_stage: 'Concluded', is_terminal: 0, lane: 'main', default_rec: 'Await closing', client_visible: 1 },
  { stage_id: 25, stage_key: 'closed',      stage_number: 5, internal_label: 'Closed',           client_label: 'Case closed',         case_stage: 'Closed',    is_terminal: 1, lane: 'main', default_rec: '', client_visible: 0 },
];

// R1 — the live Ch7 shape: the happy path above plus a single off-ramp
// carrying the HIGHEST stage_number, which is exactly the arrangement that
// made `dismissed` show up as "upcoming" for every case on the template.
const CH7_DISMISSED = { stage_id: 26, stage_key: 'dismissed', stage_number: 6, internal_label: 'Dismissed', client_label: 'Case dismissed', case_stage: 'Closed', is_terminal: 1, lane: 'offramp', default_rec: '', client_visible: 0 };
const CH7_WITH_OFFRAMP = () => [...CH7_STAGES.map(s => ({ ...s })), { ...CH7_DISMISSED }];

// The adversary shape: an off-ramp SITTING IN THE MIDDLE of the numbering
// (appeal #8, before closed #9). A case at `appeal` must keep `appeal` as its
// position while projecting the main stages numerically after it.
const ADV_STAGES = () => [
  { stage_id: 41, stage_key: 'trial',    stage_number: 6, internal_label: 'Trial',    client_label: 'Trial',    case_stage: 'Filed',     is_terminal: 0, lane: 'main',    default_rec: '', client_visible: 1 },
  { stage_id: 42, stage_key: 'judgment', stage_number: 7, internal_label: 'Judgment', client_label: 'Judgment', case_stage: 'Concluded', is_terminal: 0, lane: 'main',    default_rec: '', client_visible: 1 },
  { stage_id: 43, stage_key: 'appeal',   stage_number: 8, internal_label: 'On Appeal', client_label: 'On appeal', case_stage: 'Filed',   is_terminal: 0, lane: 'offramp', default_rec: '', client_visible: 1 },
  { stage_id: 44, stage_key: 'closed',   stage_number: 9, internal_label: 'Closed',   client_label: 'Closed',   case_stage: 'Closed',    is_terminal: 1, lane: 'main',    default_rec: '', client_visible: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// resolveTemplate — branch order
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveTemplate branch order (T8: phase first, matter second)', () => {
  // Branch 1 is now the LIFECYCLE test. These four prove the T8 thesis:
  // subtype no longer decides the template, phase does.
  test('phase intake + blank subtype → intake template', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: '' });
    expect(t).toBe(ALL_TPLS[0]);
    expect(t.role).toBe('intake');
  });

  test('phase intake + KNOWN chapter → STILL intake (the T8 fix)', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(t.role).toBe('intake');
  });

  test('missing/null phase reads as intake (safe default)', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { case_type: 'Bankruptcy', case_subtype: 'Chapter 13' });
    expect(t.role).toBe('intake');
    const db2 = stubDb([ALL_TPLS.slice()]);
    const t2 = await svc.resolveTemplate(db2,
      { pipeline_phase: null, case_type: 'Bankruptcy', case_subtype: 'Chapter 13' });
    expect(t2.role).toBe('intake');
  });

  test('bad enum value (silent "" under non-strict sql_mode) reads as intake', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: '', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(t.role).toBe('intake');
  });

  test('phase case + exact (type, subtype) match wins', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 13' });
    expect(t.id).toBe(TPL_CH13.id);
  });

  test('phase matching is trimmed + caseless', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: ' CASE ', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(t.id).toBe(TPL_CH7.id);
  });

  test('matching mirrors utf8mb4_general_ci (caseless)', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'case', case_type: 'bankruptcy', case_subtype: 'chapter 7' });
    expect(t.id).toBe(TPL_CH7.id);
  });

  test('phase case, no exact match → is_default=1 template for the case_type', async () => {
    const db = stubDb([[...ALL_TPLS, TPL_BK_DEFAULT]]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 11' });
    expect(t.id).toBe(TPL_BK_DEFAULT.id);
  });

  test('phase case, no exact, no default → intake fallback', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 11' });
    expect(t.role).toBe('intake');
  });

  test('phase case + BLANK subtype reaches branch 3/4, not branch 1', async () => {
    // The 12 live "retained, chapter never recorded" rows. Must NOT be
    // short-circuited to intake by a subtype test — that test is gone.
    const db = stubDb([[...ALL_TPLS, TPL_BK_DEFAULT]]);
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'case', case_type: 'Bankruptcy', case_subtype: '' });
    expect(t.id).toBe(TPL_BK_DEFAULT.id);
  });

  test('nothing resolves (no intake either) → null, no throw', async () => {
    const db = stubDb([[TPL_CH7]]); // active templates but no intake, no match
    const t = await svc.resolveTemplate(db,
      { pipeline_phase: 'case', case_type: 'Estate', case_subtype: 'Probate' });
    expect(t).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveMatterTemplate (T8) — the matter axis alone, ignoring phase
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveMatterTemplate', () => {
  test('exact match regardless of phase', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveMatterTemplate(db,
      { pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(t.id).toBe(TPL_CH7.id);
  });

  test('no match → NULL (not the intake fallback)', async () => {
    const db = stubDb([ALL_TPLS.slice()]);
    const t = await svc.resolveMatterTemplate(db,
      { pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: '' });
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
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
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
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
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
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
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

  // ── R1 — the lane filter ────────────────────────────────────────────────
  test('R1: upcoming excludes off-ramps; stages keeps BOTH lanes', async () => {
    // The bug this closes: `dismissed` carries the highest stage_number purely
    // because it was appended last, so every case below it was told Dismissed
    // was coming next.
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      ALL_TPLS.slice(),
      [
        { stage_id: 21, stage_key: 'docs',  case_stage: 'Pending', status_label: 'Documents & Prep', entered_at: 't1', entered_by: 6, source: 'manual', note: null },
        { stage_id: 22, stage_key: 'filed', case_stage: 'Filed',   status_label: 'Filed',            entered_at: 't2', entered_by: 6, source: 'manual', note: null },
      ],
      CH7_WITH_OFFRAMP(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['meeting_341', 'discharge', 'closed']);
    expect(p.upcoming.some(s => s.stage_key === 'dismissed')).toBe(false);
    // C1 contract: `stages` is BOTH lanes. The board needs the off-ramp
    // column, the advance picker needs to be able to select it, and a history
    // row sitting on it needs its client_label.
    expect(p.stages.map(s => s.stage_key)).toEqual(
      ['docs', 'filed', 'meeting_341', 'discharge', 'closed', 'dismissed']);
    expect(p.stages.find(s => s.stage_key === 'dismissed').lane).toBe('offramp');
  });

  test('R1: no history → upcoming = all MAIN stages (off-ramps still excluded)', async () => {
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      ALL_TPLS.slice(),
      [],
      CH7_WITH_OFFRAMP(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['docs', 'filed', 'meeting_341', 'discharge', 'closed']);
  });

  test('R1: a case sitting ON an off-ramp keeps its position; upcoming = main stages after it', async () => {
    // `appeal` is #8, between judgment (#7) and closed (#9). lane governs
    // PROJECTION, never position — history and current are lane-agnostic, and
    // this is what lets the portal keep rendering "On appeal" as where the
    // case actually is.
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Adversary Proceeding', pipeline_phase: 'case' }],
      [TPL_INTAKE, { id: 4, name: 'Bankruptcy — Adversary Proceeding', case_type: 'Bankruptcy', case_subtype: 'Adversary Proceeding', role: 'case', is_default: 0, active: 1 }],
      [
        { stage_id: 42, stage_key: 'judgment', case_stage: 'Concluded', status_label: 'Judgment',  entered_at: 't1', entered_by: 6, source: 'manual', note: null },
        { stage_id: 43, stage_key: 'appeal',   case_stage: 'Filed',     status_label: 'On Appeal', entered_at: 't2', entered_by: 6, source: 'manual', note: null },
      ],
      ADV_STAGES(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.current.stage_key).toBe('appeal');                       // position intact
    expect(p.history.map(h => h.stage_key)).toEqual(['judgment', 'appeal']);
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['closed']);     // main, numerically after #8
  });

  test('R1: a lane-less stage row (pre-migration payload) reads as MAIN', async () => {
    // The safe default, deliberately: an unclassified stage keeps being
    // projected rather than silently vanishing from every case's next steps.
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      ALL_TPLS.slice(),
      [],
      CH7_STAGES.map(({ lane, ...rest }) => rest),   // lane column absent entirely
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['docs', 'filed', 'meeting_341', 'discharge', 'closed']);
  });

  test('no template resolves → template null, upcoming empty, no throw', async () => {
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Estate', case_subtype: 'Probate', pipeline_phase: 'case' }],
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
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
        [{ id: 900, template_id: 2, stage_key: 'filed' }],   // latest === target
        ALL_TPLS.slice(),
        [stageRow],
        RELEASED,
      ],
      [ // post-tx getPipeline on the pool: case → templates → log → stages
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
        ALL_TPLS.slice(),
        [{ stage_id: 22, stage_key: 'filed', case_stage: 'Filed', status_label: 'Filed', entered_at: 't', entered_by: null, source: 'system', note: null }],
        CH7_STAGES.slice(),
      ]
    );
    const p = await svc.advanceStage(db, 'C1', 'filed', { userId: 6, source: 'manual' });
    expect(p.noop).toBe(true);
    // Sync bus: a no-op wrote nothing, so it announces nothing. Emitting here
    // would make every open frame repaint — and the Cases tab refetch — for a
    // button press that changed no row.
    expect(p.changes).toBeUndefined();
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
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
        [],                                                  // no latest row (read before resolution)
        [stageRow],                                          // direct id lookup (no template resolve)
        [{ insertId: 1 }],                                   // INSERT
        [{ role: 'case' }],                                  // T8 phase source
        [{ affectedRows: 1 }],                               // UPDATE
        RELEASED,
      ],
      [
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
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
    // T8: pipeline_phase from the ENTERED stage's template role, then the PK.
    expect(update.params[3]).toBe('case');
    expect(update.params[4]).toBe('C1');

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

    // ── Sync bus: payload.changes = WHAT THE UPDATE WROTE ────────────────
    // The trap this guards: `outcome.to.internal_label` is the FULL label,
    // while the row holds it clipped to 50. Announcing `to` would broadcast a
    // status no case row anywhere actually carries — every open frame would
    // paint 80 characters and then disagree with its own next GET. So the
    // assertion is deliberately against `update.params`, not against literals:
    // the two must be byte-identical by construction.
    expect(p.changes).toEqual({
      case_stage:     update.params[0],
      case_status:    update.params[1],
      case_rec:       update.params[2],
      pipeline_phase: update.params[3],
    });
    expect(p.changes.case_status).toHaveLength(50);
    expect(p.changes.case_status).not.toBe(longLabel);
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
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
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
  const CASE_CH7 = [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }];
  // T8: same matter, still in the funnel — a lead whose chapter is already
  // known. Pre-T8 this row was IMPOSSIBLE to express: a written subtype WAS
  // the case phase.
  const LEAD_CH7 = [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'intake' }];
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
        [{ role: 'case' }],
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
    // Exact shape, deliberately: the guarded callers branch on it. The sync
    // bus must not have widened the skip envelope — nothing was written.
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
        [{ role: 'case' }],
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
        [{ role: 'case' }],
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

  // ── T8 — the cross-phase bootstrap ──────────────────────────────────────
  test('T8: phase-intake case advancing to a CASE-template stage resolves via the matter template and flips the phase', async () => {
    // Workflow 42 step 5's post-T8 shape. The case is a KNOWN Chapter 7 that
    // has not retained: pipeline_phase 'intake', so resolveTemplate returns
    // the Intake template, where `retained` is active=0 and unreachable.
    // Without the cross-phase fallback this guarded advance would resolve
    // NOTHING and skip SILENTLY — every retention in the firm would stop
    // being recorded. It must find `retained` on t2 instead.
    const db = stubTxDb(
      [
        LOCK_OK, LEAD_CH7.slice(),
        [{ id: 905, template_id: 1, stage_key: 'contract_sent' }],
        [{ role: 'intake' }],     // guard: latest log row's template role
        ALL_TPLS.slice(),         // ONE load, serving both axes
        [RETAINED_T2],            // found on the MATTER template, not the phase one
        [{ insertId: 1 }],
        [{ role: 'case' }],       // entered stage's template role
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { onlyFromRole: ['intake', null], source: 'system' });
    expect(p.skipped).toBe(false);
    expect(p.noop).toBe(false);

    // The key search spanned BOTH templates, phase template first.
    const lookup = db.connCalls.find(c => c.sql.includes('FROM pipeline_stages'));
    expect(lookup.params.slice(0, 2)).toEqual([1, 2]);   // intake, then Ch7
    expect(lookup.params[2]).toBe('retained');
    expect(lookup.params[3]).toBe(1);                    // ORDER BY phase-template-first

    // The log row carries the MATTER template — which is what keeps
    // onlyFromRole meaningful for every later advance.
    const insert = db.connCalls.find(c => c.sql.startsWith('INSERT INTO case_stage_log'));
    expect(insert.params[1]).toBe(2);

    // …and the case is now phase 'case', so the fallback is a one-time
    // bootstrap rather than a permanent crutch.
    const update = db.connCalls.find(c => c.sql.startsWith('UPDATE cases'));
    expect(update.sql).toContain('pipeline_phase = ?');
    expect(update.params[3]).toBe('case');
  });

  test('T8: an intake-phase case is NOT dragged into the case phase by a stage that stays on the intake template', async () => {
    const CONSULT = { id: 4, template_id: 1, stage_key: 'consult_held', stage_number: 4, internal_label: 'Consult Held', case_stage: 'Open', default_rec: 'Send contract', active: 1 };
    const db = stubTxDb(
      [
        LOCK_OK, LEAD_CH7.slice(),
        [],                       // no log rows yet
        ALL_TPLS.slice(),
        [CONSULT],
        [{ insertId: 1 }],
        [{ role: 'intake' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    await svc.advanceStage(db, 'C1', 'consult_held', { source: 'system' });
    const update = db.connCalls.find(c => c.sql.startsWith('UPDATE cases'));
    expect(update.params[3]).toBe('intake');
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
        [{ role: 'case' }],
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
        [{ role: 'case' }],
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
// advanceStage — forwardOnly (R1)
//
// One test per row of the verdict table in advanceStage's docblock. Read that
// table alongside this block; the two are meant to be checked against each
// other.
//
// QUERY BUDGET (scriptGuard fails on drift in BOTH directions, so these counts
// are part of the contract):
//   forwardOnly absent ............ +0 conn queries
//   armed, no latest log row ...... +0  (nothing to regress from)
//   armed, same template .......... +1  (latest's stage row)
//   armed, cross-template ......... +2  (latest's stage row, then BOTH roles
//                                        in one IN(?,?) query)
// ─────────────────────────────────────────────────────────────────────────────

describe('advanceStage forwardOnly (R1)', () => {
  const LOCK_OK  = [{ lockAcquired: 1 }];
  const RELEASED = [{ 'RELEASE_LOCK(?)': 1 }];
  const CASE_CH7 = [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }];
  const LEAD_CH7 = [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'intake' }];

  // Stage rows as _resolveTarget returns them (SELECT * → lane included).
  const T2 = (key, num, lane = 'main') => ({
    id: 100 + num, template_id: 2, stage_key: key, stage_number: num,
    internal_label: key, case_stage: 'Pending', default_rec: '', lane, active: 1,
  });
  const DOCS      = T2('docs', 2);
  const FILED     = T2('filed', 3);
  const DISMISSED = T2('dismissed', 7, 'offramp');
  const RETAINED_T2 = T2('retained', 1);
  const CONTRACT_SENT_T1 = {
    id: 5, template_id: 1, stage_key: 'contract_sent', stage_number: 5,
    internal_label: 'Contract Sent', case_stage: 'Open', default_rec: '', lane: 'main', active: 1,
  };

  const POOL_PIPELINE = () => [   // post-tx getPipeline: case → templates → log → stages
    CASE_CH7.slice(),
    ALL_TPLS.slice(),
    [{ stage_id: 103, stage_key: 'filed', case_stage: 'Filed', status_label: 'Filed', entered_at: 't', entered_by: null, source: 'system', note: null }],
    CH7_WITH_OFFRAMP(),
  ];

  // ── PASS rows ────────────────────────────────────────────────────────────

  test('no latest log row → PASS (and costs no extra query)', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [],                        // no latest
        ALL_TPLS.slice(),
        [RETAINED_T2],
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
    expect(p.noop).toBe(false);
    // Nothing to compare against, so the comparison is skipped entirely.
    expect(db.connCalls.some(c => /stage_number, lane FROM pipeline_stages/.test(c.sql))).toBe(false);
  });

  test('same template, main → main, forward → PASS', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 900, template_id: 2, stage_key: 'docs' }],
        ALL_TPLS.slice(),
        [FILED],                   // target #3
        [{ stage_number: 2, lane: 'main' }],   // latest `docs` #2
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'filed', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
    expect(db.connCalls.some(c => c.sql.startsWith('INSERT INTO case_stage_log'))).toBe(true);
  });

  test('same template, entering an OFF-RAMP from mid-pipeline → PASS', async () => {
    // dismissed is #7 and forward here anyway, but the point is that it would
    // pass even if it were numbered FIRST: an off-ramp is reachable from
    // anywhere, and the lane check short-circuits before any number is read.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 901, template_id: 2, stage_key: 'meeting_341' }],
        ALL_TPLS.slice(),
        [{ ...DISMISSED, stage_number: 1 }],   // deliberately BEFORE the latest
        [{ stage_number: 4, lane: 'main' }],
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'dismissed', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
  });

  test('same template, OFF-RAMP → OFF-RAMP → PASS (no_show → dead_lead)', async () => {
    // DECIDED: the no-show sequence genuinely ends no_show → dead_lead, so an
    // off-ramp target passes even when the case is already on one.
    const DEAD_LEAD = { id: 9, template_id: 1, stage_key: 'dead_lead', stage_number: 9, internal_label: 'Dead Lead', case_stage: 'Closed', default_rec: '', lane: 'offramp', active: 1 };
    const db = stubTxDb(
      [
        LOCK_OK, LEAD_CH7.slice(),
        [{ id: 902, template_id: 1, stage_key: 'no_show' }],
        ALL_TPLS.slice(),
        [DEAD_LEAD],
        [{ stage_number: 6, lane: 'offramp' }],   // latest `no_show`
        [{ insertId: 1 }],
        [{ role: 'intake' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      [
        LEAD_CH7.slice(), ALL_TPLS.slice(),
        [{ stage_id: 9, stage_key: 'dead_lead', case_stage: 'Closed', status_label: 'Dead Lead', entered_at: 't', entered_by: null, source: 'system', note: null }],
        [],
        // (R2.5) This case is phase 'intake', so the post-commit getPipeline
        // resolves the INTAKE template and takes the forward-projection path:
        // subtype 'Chapter 7' matches template 2, so its stages are read.
        // Fixture re-derived, assertions unchanged.
        CH7_STAGES.slice(),
      ]
    );
    const p = await svc.advanceStage(db, 'C1', 'dead_lead', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
  });

  test('cross-template intake → case → PASS (the retention bootstrap)', async () => {
    // forwardOnly must NEVER be the thing that blocks retention. Two role
    // rows come back from ONE IN(?,?) query.
    const db = stubTxDb(
      [
        LOCK_OK, LEAD_CH7.slice(),
        [{ id: 903, template_id: 1, stage_key: 'contract_sent' }],
        ALL_TPLS.slice(),
        [RETAINED_T2],                              // resolved on the MATTER template
        [{ stage_number: 5, lane: 'main' }],        // latest, on t1
        [{ id: 1, role: 'intake' }, { id: 2, role: 'case' }],
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
    const roleQ = db.connCalls.find(c => /FROM pipeline_templates WHERE id IN/.test(c.sql));
    expect(roleQ.params).toEqual([1, 2]);           // ONE query, both roles
  });

  test('cross-template case → case (matter-type change) → PASS, numbers never compared', async () => {
    // DECIDED: stage_numbers are per-template ordinals. Ch7 #3 and Ch13 #3 are
    // not the same milestone, so a lower target number across templates is not
    // evidence of a regression.
    const CH13_DOCS = { id: 302, template_id: 3, stage_key: 'docs', stage_number: 2, internal_label: 'Docs', case_stage: 'Pending', default_rec: '', lane: 'main', active: 1 };
    const db = stubTxDb(
      [
        LOCK_OK,
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 13', pipeline_phase: 'case' }],
        [{ id: 904, template_id: 2, stage_key: 'meeting_341' }],   // was on Ch7 #4
        ALL_TPLS.slice(),
        [CH13_DOCS],                                               // now Ch13 #2 — LOWER
        [{ stage_number: 4, lane: 'main' }],
        [{ id: 2, role: 'case' }, { id: 3, role: 'case' }],
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      [
        [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 13', pipeline_phase: 'case' }],
        ALL_TPLS.slice(),
        [{ stage_id: 302, stage_key: 'docs', case_stage: 'Pending', status_label: 'Docs', entered_at: 't', entered_by: null, source: 'system', note: null }],
        [],
      ]
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
  });

  test('cross-template, latest template row MISSING → PASS (unreachable state must not disarm retention)', async () => {
    // Hard-deleting a template requires ZERO case_stage_log references, and
    // `latest` IS one — so this cannot happen. Passing keeps an impossible
    // state from silently blocking an advance if it ever becomes possible.
    const db = stubTxDb(
      [
        LOCK_OK, LEAD_CH7.slice(),
        [{ id: 905, template_id: 77, stage_key: 'contract_sent' }],
        ALL_TPLS.slice(),
        [RETAINED_T2],
        [{ stage_number: 5, lane: 'main' }],
        [{ id: 2, role: 'case' }],          // only the TARGET template came back
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'retained', { forwardOnly: true, source: 'system' });
    expect(p.skipped).toBe(false);
  });

  // ── SKIP rows ────────────────────────────────────────────────────────────

  test('same template, main → main, BACKWARD → skipped "backward"', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 906, template_id: 2, stage_key: 'meeting_341' }],
        ALL_TPLS.slice(),
        [DOCS],                                  // #2
        [{ stage_number: 4, lane: 'main' }],     // latest #4
        RELEASED,
      ],
      []   // NO pool queries — a skip spends no getPipeline re-read
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { forwardOnly: true, source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'meeting_341', reason: 'backward' });
    const sqls = db.connCalls.map(c => c.sql);
    expect(sqls.some(s => s.startsWith('INSERT INTO case_stage_log'))).toBe(false);
    expect(sqls.some(s => s.startsWith('UPDATE cases'))).toBe(false);
    expect(sqls.some(s => s.includes('RELEASE_LOCK'))).toBe(true);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    expect(db.poolCalls).toHaveLength(0);
  });

  test('same template, EQUAL stage_numbers on different stages → skipped "backward"', async () => {
    // Not the same stage (that is the noop above), so not forward either.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 907, template_id: 2, stage_key: 'meeting_341' }],
        ALL_TPLS.slice(),
        [T2('discharge', 4)],
        [{ stage_number: 4, lane: 'main' }],
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'discharge', { forwardOnly: true, source: 'system' });
    expect(p.reason).toBe('backward');
  });

  test('same template, OFF-RAMP → main (recovery) → skipped "backward"', async () => {
    // Recovery onto the happy path is real, but deliberate — explicit-guard or
    // unguarded territory, not something a monotonic automation does alone.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 908, template_id: 2, stage_key: 'dismissed' }],
        ALL_TPLS.slice(),
        [T2('closed', 9)],                          // main, and NUMERICALLY HIGHER
        [{ stage_number: 7, lane: 'offramp' }],
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'closed', { forwardOnly: true, source: 'system' });
    // Forward by number, backward by lane — lane wins.
    expect(p).toEqual({ skipped: true, noop: false, from: 'dismissed', reason: 'backward' });
  });

  test('cross-template case → intake → skipped "backward"', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 909, template_id: 2, stage_key: 'filed' }],
        ALL_TPLS.slice(),
        [CONTRACT_SENT_T1],                              // an INTAKE-template stage
        [{ stage_number: 3, lane: 'main' }],
        [{ id: 1, role: 'intake' }, { id: 2, role: 'case' }],
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'contract_sent', { forwardOnly: true, source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'filed', reason: 'backward' });
  });

  test("latest's stage row not found (key renamed / stage deleted) → skipped 'unresolved' + warn", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 910, template_id: 2, stage_key: 'gone_key' }],
        ALL_TPLS.slice(),
        [FILED],
        [],                                  // latest's stage row: NOT FOUND
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'filed', { forwardOnly: true, source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'gone_key', reason: 'unresolved' });
    // Loud: an unresolvable comparison is either a real template edit or a bug,
    // and skipping forever in silence is the failure mode to avoid.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/forwardOnly unresolved/);
    warn.mockRestore();
  });

  // ── Precedence + plumbing ────────────────────────────────────────────────

  test('NOOP BEATS BACKWARD: repeating the current stage is still a plain no-op', async () => {
    // Load-bearing ordering. If the comparison ran first, every idempotent
    // re-fire of a forwardOnly automation would start reporting a refusal
    // instead of "nothing to do" — two different answers to two different
    // questions, and callers branch on both.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 911, template_id: 2, stage_key: 'filed' }],   // latest === target
        ALL_TPLS.slice(),
        [FILED],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'filed', { forwardOnly: true, source: 'system' });
    expect(p.noop).toBe(true);
    expect(p.skipped).toBe(false);
    // The comparison never ran — no latest-stage lookup was issued.
    expect(db.connCalls.some(c => /stage_number, lane FROM pipeline_stages/.test(c.sql))).toBe(false);
  });

  test('forwardOnly ALONE counts as guarded: soft resolution + the bare skip shape', async () => {
    // An unknown key under forwardOnly must skip, not 400 — same contract the
    // onlyFrom callers get.
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 912, template_id: 2, stage_key: 'filed' }],
        ALL_TPLS.slice(),
        [],                                  // key does not resolve
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'not_a_stage', { forwardOnly: true, source: 'system' });
    expect(p).toEqual({ skipped: true, noop: false, from: 'filed', reason: 'unresolved' });
  });

  test('guards COMBINE: onlyFrom passes but forwardOnly refuses → skipped "backward"', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 913, template_id: 2, stage_key: 'meeting_341' }],
        ALL_TPLS.slice(),
        [DOCS],
        [{ stage_number: 4, lane: 'main' }],
        RELEASED,
      ],
      []
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', {
      onlyFrom: ['meeting_341'], forwardOnly: true, source: 'system',
    });
    expect(p.reason).toBe('backward');
  });

  test('forwardOnly:false is identical to absent — no extra query, no guarding', async () => {
    const db = stubTxDb(
      [
        LOCK_OK, CASE_CH7.slice(),
        [{ id: 914, template_id: 2, stage_key: 'meeting_341' }],
        ALL_TPLS.slice(),
        [DOCS],                              // a BACKWARD move, allowed unguarded
        [{ insertId: 1 }],
        [{ role: 'case' }],
        [{ affectedRows: 1 }],
        RELEASED,
      ],
      POOL_PIPELINE()
    );
    const p = await svc.advanceStage(db, 'C1', 'docs', { forwardOnly: false, source: 'system' });
    expect(p.skipped).toBe(false);
    expect(db.connCalls.some(c => /stage_number, lane FROM pipeline_stages/.test(c.sql))).toBe(false);
  });

  test('non-boolean forwardOnly → 400 up front, no connection touched', async () => {
    // A string must not silently read as "guard off". The automation-facing
    // string parse lives in lib/internal_functions/pipeline.js.
    const db = stubTxDb([], []);
    await expect(svc.advanceStage(db, 'C1', 'docs', { forwardOnly: 'true' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(svc.advanceStage(db, 'C1', 'docs', { forwardOnly: 1 }))
      .rejects.toMatchObject({ status: 400 });
    expect(db.connCalls).toHaveLength(0);
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

// ─────────────────────────────────────────────────────────────────────────────
// (R2.5) getPipeline `projected` — forward projection across the boundary
// ─────────────────────────────────────────────────────────────────────────────
//
// Query budget, asserted below:
//   role='case' read ......... 4  (case, templates, log, stages) — UNCHANGED
//   role='intake', subtype ... 5  (+ the projected template's stages)
//   role='intake', generic ... 5  (+ the Intake template's `retained` row)
// The projected TEMPLATE costs nothing: getPipeline already loads the whole
// active-template list for resolution, and _pickProjection is pure over it.
// ─────────────────────────────────────────────────────────────────────────────

describe('getPipeline projected (R2.5)', () => {
  // The live Intake shape's tail: contract_sent is the last MAIN stage, and
  // `retained` is #10, INACTIVE (verified live 2026-08-27 — pipeline_stages
  // id 4, template 1, active=0, lane 'main'). It is display-only data; the
  // generic projection READS it and must never activate it.
  const INTAKE_STAGES = () => [
    { stage_id: 1,  stage_key: 'lead',           stage_number: 1, internal_label: 'Lead',                         client_label: 'Inquiry received',            case_stage: 'Open', is_terminal: 0, lane: 'main',    default_rec: '', client_visible: 1 },
    { stage_id: 2,  stage_key: 'consult_booked', stage_number: 2, internal_label: 'Booked — Intake Outstanding',  client_label: 'Consultation scheduled',      case_stage: 'Open', is_terminal: 0, lane: 'main',    default_rec: '', client_visible: 1 },
    { stage_id: 18, stage_key: 'contract_sent',  stage_number: 5, internal_label: 'Contract Sent',                client_label: 'Agreement sent for signature', case_stage: 'Open', is_terminal: 0, lane: 'main',    default_rec: '', client_visible: 1 },
    { stage_id: 19, stage_key: 'no_show',        stage_number: 6, internal_label: 'No Show',                      client_label: null,                          case_stage: 'Open', is_terminal: 0, lane: 'offramp', default_rec: '', client_visible: 0 },
  ];
  // Exactly the projection query's column list — no stage_id, deliberately.
  const RETAINED_ROW = {
    stage_key: 'retained', stage_number: 10, internal_label: 'Retained',
    client_label: "You've retained us", client_visible: 1, lane: 'main',
  };
  const projShape = (s) => ({
    stage_key: s.stage_key, stage_number: s.stage_number,
    internal_label: s.internal_label, client_label: s.client_label,
    client_visible: s.client_visible, lane: s.lane,
  });

  const LEAD = (over = {}) => [{
    case_id: 'L1', case_type: 'Bankruptcy', case_subtype: '',
    pipeline_phase: 'intake', ...over,
  }];

  test('intake-phase Ch7 lead → source subtype: chapter MAIN stages only, off-ramps absent', async () => {
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 7' }),
      ALL_TPLS.slice(),
      [{ stage_id: 2, stage_key: 'consult_booked', case_stage: 'Open', status_label: 'Booked', entered_at: 't1', entered_by: 6, source: 'manual', note: null }],
      INTAKE_STAGES(),
      CH7_WITH_OFFRAMP(),          // the projected template's stages
    ]);
    const p = await svc.getPipeline(db, 'L1');

    expect(db.calls).toHaveLength(5);                       // 4 + exactly one
    expect(p.projected.source).toBe('subtype');
    expect(p.projected.template).toEqual({ id: TPL_CH7.id, name: TPL_CH7.name });
    // `dismissed` is an off-ramp: a case that has not even retained yet must
    // NOT be shown Dismissed as part of its future.
    expect(p.projected.stages.map(s => s.stage_key))
      .toEqual(['docs', 'filed', 'meeting_341', 'discharge', 'closed']);
    // The projection query targets the CHAPTER template, active rows only.
    expect(db.calls[4].params).toEqual([TPL_CH7.id]);
    expect(db.calls[4].sql).toContain('active = 1');
  });

  test('projected stages carry the six documented keys and NO stage_id', async () => {
    // Withholding stage_id is the guard against a consumer POSTing an advance
    // at a stage the case has not entered.
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 7' }), ALL_TPLS.slice(), [],
      INTAKE_STAGES(), CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'L1');
    for (const s of p.projected.stages) {
      expect(Object.keys(s).sort()).toEqual(
        ['client_label', 'client_visible', 'internal_label', 'lane', 'stage_key', 'stage_number']);
    }
    expect(p.projected.stages[0]).toEqual(projShape(CH7_STAGES[0]));
  });

  test('Bankruptcy/blank lead → source generic: the single `retained` row, template null', async () => {
    // The 721-case majority shape. A blank subtype must NEVER fall through to
    // a template whose own case_subtype is blank (live: #5 Civil Litigation) —
    // that would tell every bankruptcy lead it was heading for litigation.
    const db = stubDb([
      LEAD(),
      [...ALL_TPLS, TPL_CIVIL],
      [],
      INTAKE_STAGES(),
      [RETAINED_ROW],
    ]);
    const p = await svc.getPipeline(db, 'L1');

    expect(db.calls).toHaveLength(5);
    expect(p.projected).toEqual({
      source: 'generic',
      template: null,
      stages: [RETAINED_ROW],
    });
    // Reads the INTAKE template's row, by key — and does NOT filter on
    // active, because that row is inactive by design.
    expect(db.calls[4].params).toEqual([TPL_INTAKE.id, 'retained']);
    expect(db.calls[4].sql).not.toContain('active');
  });

  test('blank case_type AND blank subtype → still generic (never matches a blank-subtype template)', async () => {
    const db = stubDb([
      LEAD({ case_type: '' }),
      [...ALL_TPLS, TPL_CIVIL],
      [], INTAKE_STAGES(), [RETAINED_ROW],
    ]);
    const p = await svc.getPipeline(db, 'L1');
    expect(p.projected.source).toBe('generic');
    expect(p.projected.template).toBeNull();
  });

  test('unmatched subtype (Chapter 11) → generic, NOT the is_default template', async () => {
    // The whole reason projection has its own selector: routing it through
    // is_default would tell a Chapter 11 lead it is heading for someone
    // else's pipeline, AND create pressure to set is_default on a chapter
    // template — the footgun resolveTemplate's docblock forbids.
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 11' }),
      [...ALL_TPLS, TPL_BK_DEFAULT],
      [], INTAKE_STAGES(), [RETAINED_ROW],
    ]);
    const p = await svc.getPipeline(db, 'L1');
    expect(p.projected.source).toBe('generic');
    expect(p.projected.template).toBeNull();
  });

  test('matched-but-INACTIVE chapter template → generic (inactive rows never reach the selector)', async () => {
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 7' }),
      [TPL_INTAKE, TPL_CH13],        // TPL_SQL is active-only; Ch7 is absent
      [], INTAKE_STAGES(), [RETAINED_ROW],
    ]);
    const p = await svc.getPipeline(db, 'L1');
    expect(p.projected.source).toBe('generic');
  });

  test('intake-resolved case with NO history still gets the projection', async () => {
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 13' }),
      ALL_TPLS.slice(),
      [],                            // day one — no log rows
      INTAKE_STAGES(),
      CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'L1');
    expect(p.current).toBeNull();
    expect(p.projected.source).toBe('subtype');
    expect(p.projected.template.id).toBe(TPL_CH13.id);
  });

  test('phase=case → key ABSENT (not null) and the query count is unchanged at 4', async () => {
    // C1 contract: the default role='case' payload is byte-identical to
    // pre-R2.5. Consumers feature-detect with `'projected' in payload`.
    const db = stubDb([
      [{ case_id: 'C1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      ALL_TPLS.slice(),
      [],
      CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'C1');
    expect(db.calls).toHaveLength(4);
    expect('projected' in p).toBe(false);
    expect(Object.keys(p).sort()).toEqual(
      ['current', 'history', 'stages', 'template', 'upcoming']);
  });

  test('branch-4 fallback (phase=case, no matching template → Intake) DOES project', async () => {
    // The gate is the RESOLVED TEMPLATE'S ROLE, not pipeline_phase. Live: the
    // single Chapter 11. Such a case IS displaying the intake pipeline, so
    // the projection is consistent with the rest of its payload.
    const db = stubDb([
      [{ case_id: 'C11', case_type: 'Bankruptcy', case_subtype: 'Chapter 11', pipeline_phase: 'case' }],
      ALL_TPLS.slice(),              // no Ch11 template, no is_default → intake
      [], INTAKE_STAGES(), [RETAINED_ROW],
    ]);
    const p = await svc.getPipeline(db, 'C11');
    expect(p.template.role).toBe('intake');
    expect(p.projected.source).toBe('generic');
  });

  test('projected is NEVER merged into stages/upcoming, and carries no requirements', async () => {
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 7' }),
      ALL_TPLS.slice(),
      [{ stage_id: 2, stage_key: 'consult_booked', case_stage: 'Open', status_label: 'Booked', entered_at: 't1', entered_by: 6, source: 'manual', note: null }],
      INTAKE_STAGES(),
      CH7_STAGES.slice(),
    ]);
    const p = await svc.getPipeline(db, 'L1');
    // upcoming stops at the intake boundary, exactly as before R2.5.
    expect(p.upcoming.map(s => s.stage_key)).toEqual(['contract_sent']);
    expect(p.stages.map(s => s.stage_key))
      .toEqual(['lead', 'consult_booked', 'contract_sent', 'no_show']);
    for (const key of p.projected.stages.map(s => s.stage_key)) {
      expect(p.stages.some(s => s.stage_key === key)).toBe(false);
      expect(p.upcoming.some(s => s.stage_key === key)).toBe(false);
    }
    for (const s of p.projected.stages) expect('requirements' in s).toBe(false);
  });

  test('missing `retained` row → stages [] rather than a throw', async () => {
    const db = stubDb([
      LEAD(), ALL_TPLS.slice(), [], INTAKE_STAGES(),
      [],                            // no such row
    ]);
    const p = await svc.getPipeline(db, 'L1');
    expect(p.projected).toEqual({ source: 'generic', template: null, stages: [] });
  });

  test('lane filtering is JS-side: a lane-less projected row reads as MAIN', async () => {
    // isMainLane's R1 default. A SQL `lane <> 'offramp'` would drop NULL rows
    // (pre-migration data), silently deleting stages from the forward view.
    const db = stubDb([
      LEAD({ case_subtype: 'Chapter 7' }),
      ALL_TPLS.slice(), [], INTAKE_STAGES(),
      [
        { stage_key: 'docs',  stage_number: 1, internal_label: 'Docs',  client_label: 'Docs',  client_visible: 1, lane: null },
        { stage_key: 'filed', stage_number: 2, internal_label: 'Filed', client_label: 'Filed', client_visible: 1, lane: '' },
      ],
    ]);
    const p = await svc.getPipeline(db, 'L1');
    expect(p.projected.stages.map(s => s.stage_key)).toEqual(['docs', 'filed']);
    expect(db.calls[4].sql).not.toContain('offramp');
  });

  test('no template resolves at all → no projection, no extra query', async () => {
    const db = stubDb([
      [{ case_id: 'X1', case_type: 'Estate', case_subtype: 'Probate', pipeline_phase: 'case' }],
      [TPL_CH7],                     // no intake template, no match → null
      [],
    ]);
    const p = await svc.getPipeline(db, 'X1');
    expect(p.template).toBeNull();
    expect('projected' in p).toBe(false);
    expect(db.calls).toHaveLength(3);
  });
});