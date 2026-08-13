/**
 * tests/control.flow.test.js
 *
 * Court Pipeline v2 slice — the control-flow primitives:
 *   - evaluate_condition BACKWARD COMPATIBILITY (the non-negotiable): the
 *     binary then/else and conditions[] modes behave byte-identically,
 *     including the load-bearing loose-equality semantics (`true == "true"`
 *     is FALSE — wf15 s1 / wf16 s1 gate on a literal boolean operand).
 *   - evaluate_condition BRANCH MODE: ordered if/else-if, first match wins,
 *     matched-branch-without-then throws, else fallback.
 *   - foreach: init/iterate/exhaust, cursor persisted in workflow variables
 *     (survives simulated cross-invocation state rebuilds), empty list,
 *     max_items bound, mid-loop list-mutation guard, end_step contract
 *     (number / null / 'cancel').
 *   - META SAFETY: the extended evaluate_condition meta still validates every
 *     live param shape (all 31 production configs' shapes), so saving an
 *     existing step cannot wipe params; and branch-mode configs validate.
 *
 *   npx jest tests/control.flow.test.js
 */

const control = require('../lib/internal_functions/control');
// index.js exposes the validator as a dunder property on the registry object.
// NOTE: requiring index pulls in every category module (incl. phoneIngestService);
// jest.setup.js provides the env those modules need.
const registry = require('../lib/internal_functions/index');
const validateParamsAgainstMeta = registry.__validateParamsAgainstMeta;

const ec = control.evaluate_condition;
const fe = control.foreach;

// ─────────────────────────────────────────────────────────────
// evaluate_condition — backward compatibility
// ─────────────────────────────────────────────────────────────
describe('evaluate_condition — legacy modes unchanged', () => {
  test('binary then/else, string equality', async () => {
    const r = await ec({ variable: 'outcome', operator: '==', value: 'Continued',
                         then: 2, else: 4, _variables: { outcome: 'Continued' } });
    expect(r).toEqual({ success: true, next_step: 2 });
    const r2 = await ec({ variable: 'outcome', operator: '==', value: 'Continued',
                          then: 2, else: 4, _variables: { outcome: 'Held' } });
    expect(r2.next_step).toBe(4);
  });

  test('LOAD-BEARING: literal boolean operand — true == "true" is FALSE (wf15/wf16 s1)', async () => {
    // boolean operand vs boolean variable → then
    const a = await ec({ variable: 'needs_fetch', operator: '==', value: true,
                         then: 2, else: 4, _variables: { needs_fetch: true } });
    expect(a.next_step).toBe(2);
    // boolean operand vs STRING "true" → else (loose == does NOT bridge them)
    const b = await ec({ variable: 'needs_fetch', operator: '==', value: true,
                         then: 2, else: 4, _variables: { needs_fetch: 'true' } });
    expect(b.next_step).toBe(4);
  });

  test('numeric loose equality — value:1 vs "1" matches (wf15 s5 / wf17 s3)', async () => {
    const r = await ec({ variable: 'matchCount', operator: '==', value: 1,
                         then: 6, else: 7, _variables: { matchCount: '1' } });
    expect(r.next_step).toBe(6);
  });

  test('else omitted defaults to null (stop) — wf17 s3 shape', async () => {
    const r = await ec({ variable: 'matchCount', operator: '==', value: 1,
                         then: 4, _variables: { matchCount: 0 } });
    expect(r.next_step).toBeNull();
  });

  test('conditions[] multi-condition mode, match:all (wf18 s3 shape)', async () => {
    const params = {
      conditions: [
        { variable: 'direction', operator: '==', value: 'incoming' },
        { variable: 'matchCount', operator: '==', value: 1 },
      ],
      match: 'all', then: 4, else: null,
    };
    const yes = await ec({ ...params, _variables: { direction: 'incoming', matchCount: 1 } });
    expect(yes.next_step).toBe(4);
    const no = await ec({ ...params, _variables: { direction: 'Outbound', matchCount: 1 } });
    expect(no.next_step).toBeNull();
  });

  test('is_empty / is_not_empty (wf28 s3 / wf31 s4 shapes)', async () => {
    const r = await ec({ variable: 'case_dropbox', operator: 'is_empty',
                         then: 7, else: 4, _variables: { case_dropbox: '' } });
    expect(r.next_step).toBe(7);
    const r2 = await ec({ variable: 'contactId', operator: 'is_not_empty',
                          then: 5, else: null, _variables: { contactId: 42 } });
    expect(r2.next_step).toBe(5);
  });

  test('missing variable+operator throws (unchanged)', async () => {
    await expect(ec({ then: 1, _variables: {} }))
      .rejects.toThrow('evaluate_condition requires variable and operator');
  });
});

// ─────────────────────────────────────────────────────────────
// evaluate_condition — branch mode
// ─────────────────────────────────────────────────────────────
describe('evaluate_condition — branch mode', () => {
  const branches = [
    { variable: 'key', operator: '==', value: '341_scheduled', then: 5 },
    { variable: 'key', operator: '==', value: 'show_cause_scheduled', then: 9 },
    { conditions: [{ variable: 'verb', operator: '==', value: 'cancelled' }], match: 'all', then: 12 },
  ];

  test('first match wins, in order', async () => {
    const r = await ec({ branches, else: 20, _variables: { key: '341_scheduled', verb: 'cancelled' } });
    expect(r.next_step).toBe(5); // branch 0 wins even though branch 2 also matches
  });

  test('second branch', async () => {
    const r = await ec({ branches, else: 20, _variables: { key: 'show_cause_scheduled' } });
    expect(r.next_step).toBe(9);
  });

  test('conditions-clause branch', async () => {
    const r = await ec({ branches, else: 20, _variables: { key: 'other', verb: 'cancelled' } });
    expect(r.next_step).toBe(12);
  });

  test('no match → else', async () => {
    const r = await ec({ branches, else: 20, _variables: { key: 'other', verb: 'scheduled' } });
    expect(r.next_step).toBe(20);
  });

  test('no match, no else → null (stop, matching legacy semantics)', async () => {
    const r = await ec({ branches, _variables: { key: 'other', verb: 'scheduled' } });
    expect(r.next_step).toBeNull();
  });

  test('branch semantics reuse evaluateSingle: boolean operand stays loose-==', async () => {
    const r = await ec({
      branches: [{ variable: 'flag', operator: '==', value: true, then: 3 }],
      else: 7, _variables: { flag: 'true' },   // string "true" ≠ boolean true
    });
    expect(r.next_step).toBe(7);
  });

  test('matched branch without then throws', async () => {
    await expect(ec({
      branches: [{ variable: 'k', operator: '==', value: 'x' }],
      _variables: { k: 'x' },
    })).rejects.toThrow('matched but has no "then"');
  });

  test('malformed branch entry throws', async () => {
    await expect(ec({ branches: [null], _variables: {} }))
      .rejects.toThrow('branches[0] must be an object');
  });
});

// ─────────────────────────────────────────────────────────────
// foreach
// ─────────────────────────────────────────────────────────────
describe('foreach', () => {
  const STEP = 4;
  const base = { item_var: 'match', index_var: 'i', end_step: 12, _step_number: STEP };

  test('full loop: iterate all items via persisted cursor, then exit to end_step', async () => {
    const list = [{ k: 'a' }, { k: 'b' }, { k: 'c' }];
    // Simulate the engine: variables persist across visits via mergeVariables.
    let variables = { matches: list };

    const visits = [];
    for (let guard = 0; guard < 10; guard++) {
      const r = await fe({ ...base, list, _variables: variables });
      // engine merge simulation
      Object.assign(variables, r.set_vars || {});
      visits.push(r);
      if (r.output.done) break;
    }

    expect(visits).toHaveLength(4); // 3 items + exhaustion visit
    expect(visits[0].next_step).toBe(STEP + 1);        // falls into the body
    expect(visits[0].set_vars.match).toEqual({ k: 'a' });
    expect(visits[0].set_vars.i).toBe(0);
    expect(visits[1].set_vars.match).toEqual({ k: 'b' });
    expect(visits[2].set_vars.match).toEqual({ k: 'c' });
    expect(visits[3].next_step).toBe(12);              // end_step
    expect(visits[3].set_vars.__foreach_match).toBeNull(); // state cleared
    expect(visits[3].output).toEqual({ done: true, count: 3 });
  });

  test('cursor state survives a cross-invocation rebuild (self-continue span)', async () => {
    const list = ['x', 'y'];
    let variables = {};
    const r1 = await fe({ ...base, list, _variables: variables });
    // Simulate DB round-trip: only what mergeVariables persisted comes back.
    const persisted = JSON.parse(JSON.stringify(r1.set_vars));
    const r2 = await fe({ ...base, list, _variables: persisted });
    expect(r2.set_vars.match).toBe('y');
    expect(r2.set_vars.i).toBe(1);
  });

  test('empty list → immediate end_step, no body pass', async () => {
    const r = await fe({ ...base, list: [], _variables: {} });
    expect(r.next_step).toBe(12);
    expect(r.output).toEqual({ done: true, count: 0 });
  });

  test('end_step null ends the workflow (set_next contract)', async () => {
    const r = await fe({ ...base, end_step: null, list: [], _variables: {} });
    expect(r.next_step).toBeNull();
  });

  test("end_step 'cancel' passes through (engine maps it to cancelled)", async () => {
    const r = await fe({ ...base, end_step: 'cancel', list: [], _variables: {} });
    expect(r.next_step).toBe('cancel');
  });

  test('JSON-array string list is parsed', async () => {
    const r = await fe({ ...base, list: '["a","b"]', _variables: {} });
    expect(r.set_vars.match).toBe('a');
  });

  test('non-array list throws', async () => {
    await expect(fe({ ...base, list: 'not json', _variables: {} }))
      .rejects.toThrow('list must resolve to an array');
    await expect(fe({ ...base, list: { a: 1 }, _variables: {} }))
      .rejects.toThrow('list must resolve to an array');
  });

  test('max_items bound: default 100, hard ceiling 500', async () => {
    const big = Array.from({ length: 101 }, (_, i) => i);
    await expect(fe({ ...base, list: big, _variables: {} }))
      .rejects.toThrow('exceeding max_items=100');
    // explicit max_items above the ceiling is clamped to 500
    const huge = Array.from({ length: 501 }, (_, i) => i);
    await expect(fe({ ...base, list: huge, max_items: 9999, _variables: {} }))
      .rejects.toThrow('exceeding max_items=500');
    // explicit max_items within range works
    const r = await fe({ ...base, list: big, max_items: 200, _variables: {} });
    expect(r.output.count).toBe(101);
  });

  test('mid-loop list mutation throws (loop-stability guard)', async () => {
    const list3 = ['a', 'b', 'c'];
    let variables = {};
    const r1 = await fe({ ...base, list: list3, _variables: variables });
    Object.assign(variables, r1.set_vars);
    await expect(fe({ ...base, list: ['a', 'b'], _variables: variables }))
      .rejects.toThrow('list length changed mid-loop');
  });

  test('missing item_var / end_step / _step_number throw', async () => {
    await expect(fe({ list: [], end_step: 1, _step_number: 2, _variables: {} }))
      .rejects.toThrow('item_var is required');
    await expect(fe({ list: [], item_var: 'x', _step_number: 2, _variables: {} }))
      .rejects.toThrow('end_step is required');
    await expect(fe({ list: [], item_var: 'x', end_step: 1, _variables: {} }))
      .rejects.toThrow('_step_number');
  });

  test('custom state_var honored; default derives from item_var (nested loops)', async () => {
    const r = await fe({ ...base, list: ['a'], state_var: 'outer_loop', _variables: {} });
    expect(r.set_vars.outer_loop).toEqual({ i: 1, n: 1 });
    expect(r.set_vars.__foreach_match).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Meta safety — save-time validation of live + new shapes
// ─────────────────────────────────────────────────────────────
describe('meta validation — live configs still save, branch mode saves', () => {
  const meta = ec.__meta;

  // Representative shapes of ALL 31 live evaluate_condition steps (verified
  // against production workflow_steps 2026-08-10).
  const LIVE = [
    { else: 5, then: 3, value: '0', operator: '>', variable: 'apptCount' },                 // wf5 s2
    { else: null, then: 9, value: '0', operator: '>', variable: 'apptCount' },              // wf5 s8
    { else: 4, then: 2, value: true, operator: '==', variable: 'needs_fetch' },             // wf15 s1 (boolean operand)
    { else: 7, then: 6, value: 1, operator: '==', variable: 'matchCount' },                 // wf15 s5 (numeric operand)
    { else: null, then: 10, match: 'all',
      conditions: [{ value: 'incoming', operator: '==', variable: 'direction' },
                   { value: 1, operator: '==', variable: 'matchCount' }] },                 // wf15 s9
    { else: 4, then: 7, operator: 'is_empty', variable: 'case_dropbox' },                   // wf28 s3
    { else: 37, then: 38, value: '1', operator: '<', variable: 'recentEnrollCount' },       // wf37 s36
  ];

  test.each(LIVE.map((p, i) => [i, p]))('live shape %#%s validates', (_i, params) => {
    expect(validateParamsAgainstMeta(meta, params)).toBeNull();
  });

  test('branch-mode config (no top-level then) validates', () => {
    const params = {
      branches: [{ variable: 'match_key', operator: '==', value: '341_scheduled', then: 5 }],
      else: 20,
    };
    expect(validateParamsAgainstMeta(meta, params)).toBeNull();
  });

  test('branches + variable together rejected (exclusiveOneOf)', () => {
    const err = validateParamsAgainstMeta(meta, {
      variable: 'x', operator: '==', value: 'y', then: 1,
      branches: [{ variable: 'x', operator: '==', value: 'y', then: 2 }],
    });
    expect(err).not.toBeNull();
  });

  test('neither then nor branches rejected (requiredWith)', () => {
    const err = validateParamsAgainstMeta(meta, { variable: 'x', operator: '==', value: 'y' });
    expect(err).not.toBeNull();
    expect(err.error).toMatch(/at least one of: then, branches/);
  });

  test('foreach meta validates its example and rejects bad shapes', () => {
    const fmeta = fe.__meta;
    expect(validateParamsAgainstMeta(fmeta, fe.__meta.example)).toBeNull();
    expect(validateParamsAgainstMeta(fmeta, { list: '{{matches}}', item_var: 'm', end_step: null })).toBeNull(); // explicit null legal
    expect(validateParamsAgainstMeta(fmeta, { list: '{{matches}}', item_var: 'm' })).not.toBeNull();             // end_step omitted
    expect(validateParamsAgainstMeta(fmeta, { list: '{{matches}}', end_step: 3 })).not.toBeNull();               // item_var missing
  });
});

// ─────────────────────────────────────────────────────────────
// Engine coupling — control-flow registration has ONE source of truth
//
// isControlStep() used to be a literal whitelist in workflow_engine.js kept in
// sync BY HAND with the controlFlow:true meta flag. They drifted in both
// directions (wait_for whitelisted-but-unflagged; request_decision
// flagged-but-unwhitelisted) and the failure mode is silent: the engine ignores
// the function's next_step and sequential-advances. These tests pin the
// derivation and the two invariants that hang off it.
// ─────────────────────────────────────────────────────────────
describe('workflow_engine isControlStep', () => {
  const { isControlStep } = require('../lib/workflow_engine');

  const flaggedFns = Object.entries(registry.__getAllMeta())
    .filter(([, meta]) => meta.controlFlow === true)
    .map(([name]) => name)
    .sort();

  test('derives from __meta.controlFlow — no hardcoded name list survives', () => {
    const src = require('fs').readFileSync(
      require.resolve('../lib/workflow_engine.js'), 'utf8');
    expect(src).not.toMatch(/\[[^\]]*\]\.includes\(step\.config\?\.function_name\)/);
    expect(src).toMatch(/__getMeta\(step\.config\?\.function_name\)\?\.controlFlow/);
  });

  test('every controlFlow-flagged function IS a control step', () => {
    // Guards the regression this refactor exists to prevent: a control function
    // whose next_step the engine silently drops.
    expect(flaggedFns.length).toBeGreaterThan(0);
    for (const function_name of flaggedFns) {
      expect(isControlStep({ type: 'internal_function', config: { function_name } })).toBe(true);
    }
  });

  test('the flagged set covers the known control primitives', () => {
    // Names, not just count — so DELETING a flag is caught, not just adding one.
    expect(flaggedFns).toEqual(expect.arrayContaining([
      'evaluate_condition', 'foreach', 'request_decision',
      'schedule_resume', 'set_next', 'wait_for',
    ]));
  });

  test('non-control steps are not control steps', () => {
    // wait_until_time is deliberately unflagged (always returns delayed_until).
    expect(isControlStep({ type: 'internal_function', config: { function_name: 'wait_until_time' } })).toBe(false);
    // custom_code has no meta — its next_step stays ignored by design.
    expect(isControlStep({ type: 'internal_function', config: { function_name: 'custom_code' } })).toBe(false);
    expect(isControlStep({ type: 'internal_function', config: { function_name: 'no_such_function' } })).toBe(false);
    expect(isControlStep({ type: 'internal_function', config: {} })).toBe(false);
    expect(isControlStep({ type: 'internal_function' })).toBe(false);
    expect(isControlStep({ type: 'send_email', config: { function_name: 'set_next' } })).toBe(false);
  });

  test('every control function has BRANCH_TARGET_PARAMS entries (renumber safety)', () => {
    // A control function whose step targets are not remapped breaks on every
    // insert/delete/reorder — silently, pointing at the old step number.
    const src = require('fs').readFileSync(
      require.resolve('../routes/workflows.js'), 'utf8');
    const block = src.match(/const BRANCH_TARGET_PARAMS = \{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    const remapped = [...block[1].matchAll(/^\s{2}(\w+):\s*\[/gm)].map(m => m[1]);
    for (const fn of flaggedFns) {
      expect(remapped).toContain(fn);
    }
  });

  test('_step_number is injected alongside _variables', () => {
    const src = require('fs').readFileSync(
      require.resolve('../lib/workflow_engine.js'), 'utf8');
    expect(src).toMatch(/_step_number:\s*context\.env\?\.stepNumber/);
  });
});