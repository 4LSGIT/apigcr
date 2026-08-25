// tests/pipelineAdminService.test.js
//
// Slice C2 service assertions for services/pipelineAdminService.js, exercised
// against STUB mysql2 pools/connections that record every (sql, params) call
// and return scripted rows — no database needed (stub pattern lifted from
// tests/pipelineService.test.js, jest-hosted).
//
// Covers the server-enforced rules from the slice spec:
//   - internal_label > 50 → 400 (create + update; silent-truncation guard).
//   - case_stage enum validated in JS → 400 (lax sql_mode would store '').
//   - stage_key format guard → 400; ER_DUP_ENTRY mapped to 409.
//   - stage_key IMMUTABLE once referenced by log rows (stage_id OR
//     template_id+stage_key) → 409; freely changeable at zero refs.
//   - deleteStage: 409 when referenced, hard DELETE at zero refs.
//   - deleteTemplate: 409 when referenced (template_id or its stage_ids),
//     stages-then-template DELETE at zero refs.
//   - createTemplate duplicate-active (case_type, case_subtype, role) → 409;
//     force:true bypasses; inactive creations skip the check.
//   - is_default=1 transactionally clears other defaults of the case_type.
//   - config: object → JSON.stringify'd STRING at the placeholder;
//     ''/null → SQL NULL; array/bad JSON → 400.
//   - reorderStages: id-set mismatch → 400; happy path rewrites 1..N.
//   - (R1) the BOOTSTRAP INVARIANT: a stage_key may not be ACTIVE on a
//     role='intake' template and a role='case' template at once → 409, no
//     force. Enforced on create, on activation, on key rename, and on a
//     template role flip. The INACTIVE Intake `retained` row stays legal —
//     that inactive flag is what makes retention work at all.
//
// Run:
//   npx jest tests/pipelineAdminService.test.js

'use strict';

const svc = require('../services/pipelineAdminService');
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs (same shapes as tests/pipelineService.test.js)
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
// conn whose query() shifts from `connScript`; pool-level query() shifts from
// `poolScript` (used by post-transaction reads like reorder's listStages).
// A scripted entry may be a function — it receives (sql, params) and returns
// the rows (or throws), which lets one entry simulate ER_DUP_ENTRY.
function stubTxDb(connScript, poolScript = []) {
  const connCalls = [];
  const poolCalls = [];
  // One guard per script array — shift() is called once per array, so the guard
  // is created in the factory rather than inside the returned query fn.
  const shift = (script, calls, tag) => {
    const guard = scriptGuard(`stubTxDb(${tag})`, script);
    return async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      const next = script.shift();
      const rows = (typeof next === 'function') ? next(sql, params) : next;
      return [rows];
    };
  };
  const conn = {
    query: shift(connScript, connCalls, 'conn'),
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
    query: shift(poolScript, poolCalls, 'pool'),
  };
}

function dupErr() {
  const e = new Error('ER_DUP_ENTRY: Duplicate entry');
  e.code = 'ER_DUP_ENTRY';
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TPL = { id: 2, name: 'Bankruptcy — Chapter 7', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', role: 'case', is_default: 0, description: null, active: 1 };
const STAGE = {
  id: 7, template_id: 2, stage_number: 3, stage_key: 'meeting_341',
  internal_label: '341 Meeting', client_label: 'Meeting of creditors',
  case_stage: 'Filed', client_visible: 1, is_terminal: 0, lane: 'main',
  default_rec: 'Attend 341; provide requested docs', config: null, active: 1,
};
const LONG_51 = 'x'.repeat(51);
const OK_50   = 'x'.repeat(50);

// ─────────────────────────────────────────────────────────────────────────────
// internal_label ≤ 50 (silent-truncation guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('internal_label 50-char cap', () => {
  test('createStage rejects 51 chars with 400 before any query', async () => {
    const db = stubTxDb([]);   // any query would throw "unscripted"
    await expect(
      svc.createStage(db, 2, { stage_key: 'k1', internal_label: LONG_51, case_stage: 'Open' })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('createStage accepts exactly 50 chars', async () => {
    const db = stubTxDb([
      [{ id: 2, role: 'case' }],      // template exists (role: R1 invariant)
      [],                             // R1: no cross-role active key
      [{ next_num: 6 }],              // max+1
      { insertId: 99 },               // INSERT
      [{ ...STAGE, id: 99, internal_label: OK_50 }],
    ]);
    const row = await svc.createStage(db, 2, { stage_key: 'k1', internal_label: OK_50, case_stage: 'Open' });
    expect(row.id).toBe(99);
  });

  test('updateStage rejects 51-char label with 400', async () => {
    const db = stubTxDb([[STAGE]]);   // SELECT current, then validation throws
    await expect(
      svc.updateStage(db, 7, { internal_label: LONG_51 })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// case_stage enum + stage_key format
// ─────────────────────────────────────────────────────────────────────────────

describe('field validation', () => {
  test('invalid case_stage → 400 (lax sql_mode would store "")', async () => {
    const db = stubTxDb([]);
    await expect(
      svc.createStage(db, 2, { stage_key: 'k1', internal_label: 'X', case_stage: 'Archived' })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('bad stage_key format → 400', async () => {
    const db = stubTxDb([]);
    await expect(
      svc.createStage(db, 2, { stage_key: 'Bad Key!', internal_label: 'X', case_stage: 'Open' })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('duplicate key in template: ER_DUP_ENTRY mapped to 409', async () => {
    const db = stubTxDb([
      [{ id: 2, role: 'case' }],
      [],                             // R1: no cross-role active key
      [{ next_num: 6 }],
      () => { throw dupErr(); },      // INSERT hits uq_template_key
    ]);
    await expect(
      svc.createStage(db, 2, { stage_key: 'filed', internal_label: 'Filed', case_stage: 'Filed' })
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stage_key immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('stage_key immutability once referenced', () => {
  test('key change with log refs → 409, no UPDATE issued', async () => {
    const db = stubTxDb([
      [STAGE],        // SELECT current
      [{ n: 3 }],     // ref count > 0
    ]);
    await expect(
      svc.updateStage(db, 7, { stage_key: 'renamed_key' })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test('key change with zero refs proceeds', async () => {
    const db = stubTxDb([
      [STAGE],
      [{ n: 0 }],                                   // ref count
      [{ role: 'case' }],                           // R1: owning template role
      [],                                           // R1: no cross-role active key
      {},                                           // UPDATE
      [{ ...STAGE, stage_key: 'renamed_key' }],     // re-SELECT
    ]);
    const row = await svc.updateStage(db, 7, { stage_key: 'renamed_key' });
    expect(row.stage_key).toBe('renamed_key');
  });

  test('label-only edit never runs the ref-count query', async () => {
    const db = stubTxDb([
      [STAGE],
      {},                                           // UPDATE
      [{ ...STAGE, internal_label: 'New Label' }],
    ]);
    const row = await svc.updateStage(db, 7, { internal_label: 'New Label' });
    expect(row.internal_label).toBe('New Label');
    expect(db.connCalls.some(c => /COUNT\(\*\)/.test(c.sql))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteStage / deleteTemplate guards
// ─────────────────────────────────────────────────────────────────────────────

describe('delete guards', () => {
  test('deleteStage with refs → 409, no DELETE', async () => {
    const db = stubTxDb([[STAGE], [{ n: 2 }]]);
    await expect(svc.deleteStage(db, 7)).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
  });

  test('deleteStage with zero refs hard-deletes', async () => {
    const db = stubTxDb([[STAGE], [{ n: 0 }], {}]);
    const out = await svc.deleteStage(db, 7);
    expect(out).toEqual({ deleted: true, id: 7 });
    expect(db.connCalls.filter(c => c.sql.startsWith('DELETE')).length).toBe(1);
  });

  test('deleteTemplate with refs → 409', async () => {
    const db = stubTxDb([[{ id: 2, name: TPL.name }], [{ n: 5 }]]);
    await expect(svc.deleteTemplate(db, 2)).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
  });

  test('deleteTemplate with zero refs deletes stages then template', async () => {
    const db = stubTxDb([[{ id: 2, name: TPL.name }], [{ n: 0 }], {}, {}]);
    const out = await svc.deleteTemplate(db, 2);
    expect(out).toEqual({ deleted: true, id: 2 });
    const dels = db.connCalls.filter(c => c.sql.startsWith('DELETE'));
    expect(dels.length).toBe(2);
    expect(dels[0].sql).toContain('pipeline_stages');
    expect(dels[1].sql).toContain('pipeline_templates');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// duplicate-active template guard + force + is_default exclusivity
// ─────────────────────────────────────────────────────────────────────────────

describe('createTemplate rules', () => {
  const body = { name: 'BK Ch7 v2', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', role: 'case' };

  test('duplicate active triple → 409', async () => {
    const db = stubTxDb([
      [[{ id: 2, name: TPL.name }]][0],   // dupe SELECT returns a hit
    ]);
    await expect(svc.createTemplate(db, body)).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
  });

  test('force:true bypasses the dupe check entirely', async () => {
    const db = stubTxDb([
      { insertId: 10 },                                     // INSERT (no dupe SELECT)
      [{ ...TPL, id: 10, name: body.name }],
    ]);
    const row = await svc.createTemplate(db, { ...body, force: true });
    expect(row.id).toBe(10);
    expect(db.connCalls[0].sql.startsWith('INSERT')).toBe(true);
  });

  test('inactive creation skips the dupe check', async () => {
    const db = stubTxDb([
      { insertId: 11 },
      [{ ...TPL, id: 11, active: 0 }],
    ]);
    const row = await svc.createTemplate(db, { ...body, active: 0 });
    expect(row.id).toBe(11);
    expect(db.connCalls.some(c => /active = 1 AND role/.test(c.sql))).toBe(false);
  });

  test('is_default=1 clears other defaults of the case_type first', async () => {
    const db = stubTxDb([
      [],                                   // dupe SELECT — empty
      {},                                   // UPDATE … is_default = 0 (the clear)
      { insertId: 12 },
      [{ ...TPL, id: 12, is_default: 1 }],
    ]);
    await svc.createTemplate(db, { ...body, is_default: 1 });
    const clear = db.connCalls.find(c => c.sql.includes('SET is_default = 0'));
    expect(clear).toBeTruthy();
    expect(clear.params[0]).toBe('Bankruptcy');   // scoped to the case_type
  });
});

describe('updateTemplate dupe guard', () => {
  test('activating into an existing active triple → 409 (excludes self)', async () => {
    const db = stubTxDb([
      [{ ...TPL, id: 9, active: 0 }],                 // SELECT current (inactive copy)
      [{ id: 2, name: TPL.name }],                    // dupe SELECT hit (id 2, not self)
    ]);
    await expect(svc.updateTemplate(db, 9, { active: 1 })).rejects.toMatchObject({ status: 409 });
    const dupe = db.connCalls.find(c => /active = 1 AND role/.test(c.sql));
    expect(dupe.params).toContain(9);                 // self-exclusion param present
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// config JSON handling (mysql2 placeholder landmine)
// ─────────────────────────────────────────────────────────────────────────────

describe('config column', () => {
  test('object config is stringified at the INSERT placeholder', async () => {
    const cfg = { stamp: 'filed_date' };
    const db = stubTxDb([
      [{ id: 2, role: 'case' }],
      [],                             // R1: no cross-role active key
      [{ next_num: 6 }],
      { insertId: 20 },
      [{ ...STAGE, id: 20, config: cfg }],
    ]);
    await svc.createStage(db, 2, { stage_key: 'k1', internal_label: 'X', case_stage: 'Open', config: cfg });
    const ins = db.connCalls.find(c => c.sql.startsWith('INSERT'));
    const cfgParam = ins.params[10];  // 11th column in the INSERT (lane added at 9)
    expect(typeof cfgParam).toBe('string');
    expect(JSON.parse(cfgParam)).toEqual(cfg);
  });

  test('blank string config → NULL', async () => {
    const db = stubTxDb([
      [{ id: 2, role: 'case' }],
      [],                             // R1: no cross-role active key
      [{ next_num: 6 }],
      { insertId: 21 },
      [{ ...STAGE, id: 21 }],
    ]);
    await svc.createStage(db, 2, { stage_key: 'k2', internal_label: 'X', case_stage: 'Open', config: '' });
    const ins = db.connCalls.find(c => c.sql.startsWith('INSERT'));
    expect(ins.params[10]).toBeNull();
  });

  test('array config → 400', async () => {
    const db = stubTxDb([]);
    await expect(
      svc.createStage(db, 2, { stage_key: 'k3', internal_label: 'X', case_stage: 'Open', config: [1, 2] })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('update without config key re-stringifies the parsed stored object', async () => {
    const cfg = { a: 1 };
    const db = stubTxDb([
      [{ ...STAGE, config: cfg }],      // mysql2 hands JSON back parsed
      {},                               // UPDATE
      [{ ...STAGE, config: cfg }],
    ]);
    await svc.updateStage(db, 7, { internal_label: 'Y' });
    const upd = db.connCalls.find(c => c.sql.startsWith('UPDATE'));
    const cfgParam = upd.params[9];     // config is the 10th SET column (lane added at 8)
    expect(typeof cfgParam).toBe('string');
    expect(JSON.parse(cfgParam)).toEqual(cfg);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reorderStages
// ─────────────────────────────────────────────────────────────────────────────

describe('reorderStages', () => {
  test('id-set mismatch → 400, no UPDATEs', async () => {
    const db = stubTxDb([
      [{ id: 2 }],                              // template
      [{ id: 5 }, { id: 6 }, { id: 7 }],        // actual stage ids
    ]);
    await expect(svc.reorderStages(db, 2, [5, 6])).rejects.toMatchObject({ status: 400 });
    expect(db.connCalls.some(c => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test('happy path rewrites stage_number 1..N in given order', async () => {
    const db = stubTxDb(
      [
        [{ id: 2 }],
        [{ id: 5 }, { id: 6 }, { id: 7 }],
        {}, {}, {},                             // three UPDATEs
      ],
      [
        [TPL],                                  // post-tx listStages: template
        [                                       // post-tx listStages: stages
          { ...STAGE, id: 7, stage_number: 1 },
          { ...STAGE, id: 5, stage_number: 2 },
          { ...STAGE, id: 6, stage_number: 3 },
        ],
      ]
    );
    const out = await svc.reorderStages(db, 2, [7, 5, 6]);
    const updates = db.connCalls.filter(c => c.sql.startsWith('UPDATE'));
    expect(updates.map(u => u.params)).toEqual([
      [1, 7, 2], [2, 5, 2], [3, 6, 2],
    ]);
    expect(out.stages.map(s => s.id)).toEqual([7, 5, 6]);
  });

  test('duplicate ids → 400 before any query', async () => {
    const db = stubTxDb([]);
    await expect(svc.reorderStages(db, 2, [5, 5, 6])).rejects.toMatchObject({ status: 400 });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// R1 — the bootstrap invariant
//
// WHY THIS IS A TEST AND NOT A LINT RULE. pipelineService._resolveTarget
// searches the PHASE-RESOLVED template first. A phase-'intake' case advancing
// to `retained` therefore looks at the Intake template before its chapter
// template, and the ONLY reason it doesn't stop there is that the Intake
// `retained` row is active=0. Activate it while `retained` is also active on a
// chapter template and every retention in the firm logs against intake, keeps
// pipeline_phase='intake', and strands the case in the funnel — with NO error.
//
// The colliding-stage probe SQL is `... AND t.role = ? AND s.id != ?`, so a
// scripted [] means "no collision" and a scripted row means "collision".
// ─────────────────────────────────────────────────────────────────────────────

describe('R1 bootstrap invariant (cross-role active stage_key)', () => {
  const INTAKE_TPL = { id: 1, name: 'Intake', case_type: '', case_subtype: '', role: 'intake', is_default: 0, description: null, active: 1 };
  const HIT_CASE   = [{ id: 23, template_id: 2, name: 'Bankruptcy — Chapter 7', role: 'case' }];
  const HIT_INTAKE = [{ id: 10, template_id: 1, name: 'Intake', role: 'intake' }];

  test('THE LIVE FOOTGUN: activating Intake `retained` while it is active on a chapter template → 409', async () => {
    // Two clicks in Case Config used to be enough. This is the exact toggle
    // (pipelines.html toggleStageActive → PUT {active:1}).
    const INACTIVE_RETAINED = {
      id: 10, template_id: 1, stage_number: 10, stage_key: 'retained',
      internal_label: 'Retained', client_label: 'Retained', case_stage: 'Pending',
      client_visible: 1, is_terminal: 0, lane: 'main', default_rec: '', config: null, active: 0,
    };
    const db = stubTxDb([
      [INACTIVE_RETAINED],       // SELECT current
      [{ role: 'intake' }],      // owning template role
      HIT_CASE,                  // collision on a role='case' template
    ]);
    await expect(svc.updateStage(db, 10, { active: 1 })).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test('the 409 names the colliding template, the key, and why it matters', async () => {
    const INACTIVE_RETAINED = { ...STAGE, id: 10, template_id: 1, stage_key: 'retained', active: 0 };
    const db = stubTxDb([[INACTIVE_RETAINED], [{ role: 'intake' }], HIT_CASE]);
    let msg = '';
    try { await svc.updateStage(db, 10, { active: 1 }); } catch (e) { msg = e.message; }
    expect(msg).toContain('retained');
    expect(msg).toContain('Bankruptcy — Chapter 7');
    expect(msg).toMatch(/bootstrap/i);
    // NO force escape hatch — unlike the duplicate-active TEMPLATE guard,
    // this invariant has no legitimate exception.
    expect(msg).not.toMatch(/force/i);
  });

  test('createStage with active=1 and a key already active on the opposite role → 409, no INSERT', async () => {
    const db = stubTxDb([
      [{ id: 1, role: 'intake' }],   // creating on the INTAKE template
      HIT_CASE,                      // `retained` already active on a case template
    ]);
    await expect(
      svc.createStage(db, 1, { stage_key: 'retained', internal_label: 'Retained', case_stage: 'Pending' })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
  });

  test('the mirror direction is refused too: a case-template key already active on intake → 409', async () => {
    // Stated symmetrically on purpose — the hijack is a property of the PAIR,
    // not of which side you happen to be editing.
    const db = stubTxDb([
      [{ id: 2, role: 'case' }],
      HIT_INTAKE,
    ]);
    await expect(
      svc.createStage(db, 2, { stage_key: 'lead', internal_label: 'Lead', case_stage: 'Open' })
    ).rejects.toMatchObject({ status: 409 });
  });

  test('creating the stage INACTIVE stays legal — that is how the live Intake `retained` row exists', async () => {
    const db = stubTxDb([
      [{ id: 1, role: 'intake' }],
      [{ next_num: 10 }],            // straight to max+1: no invariant probe ran
      { insertId: 40 },
      [{ ...STAGE, id: 40, stage_key: 'retained', active: 0 }],
    ]);
    const row = await svc.createStage(db, 1, {
      stage_key: 'retained', internal_label: 'Retained', case_stage: 'Pending', active: 0,
    });
    expect(row.id).toBe(40);
    expect(db.connCalls.some(c => /t\.role = \?/.test(c.sql))).toBe(false);
  });

  test('renaming a key ONTO a colliding active key → 409, no UPDATE', async () => {
    const db = stubTxDb([
      [{ ...STAGE, template_id: 1, stage_key: 'old_key', active: 1 }],
      [{ n: 0 }],                    // key is renameable (no log refs)
      [{ role: 'intake' }],
      HIT_CASE,                      // …but the NEW key collides
    ]);
    await expect(
      svc.updateStage(db, 7, { stage_key: 'retained' })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test('renaming a key while INACTIVE skips the check entirely', async () => {
    const db = stubTxDb([
      [{ ...STAGE, stage_key: 'old_key', active: 0 }],
      [{ n: 0 }],
      {},                            // straight to UPDATE
      [{ ...STAGE, stage_key: 'retained', active: 0 }],
    ]);
    await svc.updateStage(db, 7, { stage_key: 'retained' });
    expect(db.connCalls.some(c => /t\.role = \?/.test(c.sql))).toBe(false);
  });

  test('an already-active row edited WITHOUT activating or renaming is not re-checked', async () => {
    // It was legal before this call and this call cannot change that. Re-checking
    // would 409 on an unrelated label edit.
    const db = stubTxDb([
      [STAGE],                       // active: 1
      {},                            // UPDATE
      [{ ...STAGE, internal_label: 'New' }],
    ]);
    await svc.updateStage(db, 7, { internal_label: 'New' });
    expect(db.connCalls.some(c => /t\.role = \?/.test(c.sql))).toBe(false);
  });

  test('DEACTIVATING is always allowed — it can only ever REMOVE a collision', async () => {
    const db = stubTxDb([
      [STAGE],
      {},
      [{ ...STAGE, active: 0 }],
    ]);
    await svc.updateStage(db, 7, { active: 0 });
    expect(db.connCalls.some(c => /t\.role = \?/.test(c.sql))).toBe(false);
  });

  test('activation with NO collision proceeds normally', async () => {
    const db = stubTxDb([
      [{ ...STAGE, active: 0 }],
      [{ role: 'case' }],
      [],                            // no cross-role hit
      {},                            // UPDATE
      [{ ...STAGE, active: 1 }],
    ]);
    const row = await svc.updateStage(db, 7, { active: 1 });
    expect(row.active).toBe(1);
  });

  test('a template ROLE FLIP that would collide → 409, no UPDATE', async () => {
    // Flipping Ch7 to role='intake' would make its active `retained` collide
    // with Ch13's — one checkbox, retention broken firm-wide.
    const db = stubTxDb([
      [TPL],                         // SELECT current (role 'case')
      [],                            // assertNoActiveDupe — clean
      [{ stage_key: 'retained', other_id: 3, other_name: 'Bankruptcy — Chapter 13' }],
    ]);
    await expect(svc.updateTemplate(db, 2, { role: 'intake' })).rejects.toMatchObject({ status: 409 });
    expect(db.connCalls.some(c => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test('the role-flip 409 names the key and the colliding template', async () => {
    const db = stubTxDb([
      [TPL], [],
      [{ stage_key: 'retained', other_id: 3, other_name: 'Bankruptcy — Chapter 13' }],
    ]);
    let msg = '';
    try { await svc.updateTemplate(db, 2, { role: 'intake' }); } catch (e) { msg = e.message; }
    expect(msg).toContain('retained');
    expect(msg).toContain('Bankruptcy — Chapter 13');
    expect(msg).toContain('intake');
  });

  test('a role flip with no collision proceeds', async () => {
    const db = stubTxDb([
      [INTAKE_TPL],                  // current role 'intake'
      [],                            // dupe check
      [],                            // no colliding keys
      {},                            // UPDATE
      [{ ...INTAKE_TPL, role: 'case' }],
    ]);
    const row = await svc.updateTemplate(db, 1, { role: 'case' });
    expect(row.role).toBe('case');
  });

  test('a template edit that does NOT change role never runs the flip check', async () => {
    const db = stubTxDb([
      [TPL],
      [],                            // dupe check
      {},                            // UPDATE
      [{ ...TPL, name: 'Renamed' }],
    ]);
    await svc.updateTemplate(db, 2, { name: 'Renamed' });
    expect(db.connCalls.some(c => /JOIN pipeline_stages o/.test(c.sql))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — lane column
// ─────────────────────────────────────────────────────────────────────────────

describe('lane validation and defaulting', () => {
  test('lane defaults to "main" when absent — the recoverable direction', async () => {
    // An unclassified stage shows up where someone will notice it, rather than
    // vanishing from every case's upcoming list.
    const db = stubTxDb([
      [{ id: 2, role: 'case' }], [], [{ next_num: 6 }],
      { insertId: 50 }, [{ ...STAGE, id: 50 }],
    ]);
    await svc.createStage(db, 2, { stage_key: 'k9', internal_label: 'X', case_stage: 'Open' });
    const ins = db.connCalls.find(c => c.sql.startsWith('INSERT'));
    expect(ins.sql).toContain('lane');
    expect(ins.params[8]).toBe('main');
  });

  test('lane "offramp" is stored verbatim', async () => {
    const db = stubTxDb([
      [{ id: 2, role: 'case' }], [], [{ next_num: 7 }],
      { insertId: 51 }, [{ ...STAGE, id: 51, lane: 'offramp' }],
    ]);
    await svc.createStage(db, 2, {
      stage_key: 'dismissed', internal_label: 'Dismissed', case_stage: 'Closed', lane: 'offramp',
    });
    expect(db.connCalls.find(c => c.sql.startsWith('INSERT')).params[8]).toBe('offramp');
  });

  test('an invalid lane → 400 before any query (lax sql_mode would store "")', async () => {
    const db = stubTxDb([]);
    await expect(
      svc.createStage(db, 2, { stage_key: 'k1', internal_label: 'X', case_stage: 'Open', lane: 'sidetrack' })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('updateStage without a lane key preserves the stored value', async () => {
    const db = stubTxDb([
      [{ ...STAGE, lane: 'offramp' }],
      {},
      [{ ...STAGE, lane: 'offramp' }],
    ]);
    await svc.updateStage(db, 7, { internal_label: 'Y' });
    expect(db.connCalls.find(c => c.sql.startsWith('UPDATE')).params[7]).toBe('offramp');
  });

  test('a lane-less stored row (pre-migration) updates as "main", not as ""', async () => {
    const { lane, ...NO_LANE } = STAGE;
    const db = stubTxDb([[NO_LANE], {}, [NO_LANE]]);
    await svc.updateStage(db, 7, { internal_label: 'Y' });
    expect(db.connCalls.find(c => c.sql.startsWith('UPDATE')).params[7]).toBe('main');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// usageCounts
// ─────────────────────────────────────────────────────────────────────────────

describe('usageCounts', () => {
  test('type-only when subtype omitted', async () => {
    const db = stubDb([[{ n: 774 }], [{ n: 2 }]]);
    const out = await svc.usageCounts(db, 'Bankruptcy');
    expect(out).toEqual({ cases: 774, templates: 2 });
    expect(db.calls[0].sql).not.toContain('case_subtype');
    expect(db.calls[0].params).toEqual(['Bankruptcy']);
  });

  test('pair match when subtype given', async () => {
    const db = stubDb([[{ n: 156 }], [{ n: 1 }]]);
    const out = await svc.usageCounts(db, 'Bankruptcy', 'Chapter 7');
    expect(out).toEqual({ cases: 156, templates: 1 });
    expect(db.calls[0].sql).toContain('case_subtype');
  });

  test('blank case_type → 400', async () => {
    const db = stubDb([]);
    await expect(svc.usageCounts(db, '  ')).rejects.toMatchObject({ status: 400 });
  });
});