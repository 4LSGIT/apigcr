/**
 * tests/versionDiff.test.js
 *
 * Unit tests for lib/versionDiff.js — the content-only/structural classifier
 * and the publish-validation gate (automation versioning S3, plan-v2 rulings
 * O1 + O5).
 *
 * THE STAKES: a diff misclassified as content_only licenses migrating live
 * executions onto a definition whose control flow moved — silent corruption.
 * The classifier is fail-closed (positive whitelist); these tests pin both
 * directions: the typo-fix cases MUST classify content_only (or the migrate
 * feature is uselessly disabled), and every control-flow-adjacent change MUST
 * classify structural.
 *
 * BRANCH_TARGET_PARAMS / TERMINAL_SENTINELS are extracted from
 * routes/workflows.js SOURCE (same technique as tests/control.flow.test.js)
 * so these tests exercise the exact production map — a param added to the map
 * automatically tightens the classifier here too.
 *
 *   npx jest tests/versionDiff.test.js
 */

const fs = require('fs');
const path = require('path');

const { diffWorkflowSteps, validateWorkflowDraft } = require('../lib/versionDiff');

const wfSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workflows.js'), 'utf8');

const mapMatch = wfSrc.match(/const BRANCH_TARGET_PARAMS = \{([\s\S]*?)\n\};/);
if (!mapMatch) throw new Error('BRANCH_TARGET_PARAMS not found in routes/workflows.js');
// eslint-disable-next-line no-eval
const BRANCH_TARGET_PARAMS = eval('({' + mapMatch[1] + '})');

const sentMatch = wfSrc.match(/const TERMINAL_SENTINELS = new Set\(\[([^\]]*)\]\)/);
if (!sentMatch) throw new Error('TERMINAL_SENTINELS not found in routes/workflows.js');
// eslint-disable-next-line no-eval
const TERMINAL_SENTINELS = new Set(eval('[' + sentMatch[1] + ']'));
const isTerminalSentinel = (v) =>
  typeof v === 'string' && TERMINAL_SENTINELS.has(v.trim().toLowerCase());

const OPTS = { branchTargetParams: BRANCH_TARGET_PARAMS, isTerminalSentinel };

// ── step factory ────────────────────────────────────────────────────────────
let nextId = 1;
function step(step_number, over = {}) {
  return {
    id: nextId++,
    step_number,
    label: null,
    note: null,
    type: 'internal_function',
    config: JSON.stringify({ function_name: 'send_sms', params: { to: '{{phone}}', message: 'hi' } }),
    error_policy: null,
    ...over,
  };
}
const clone = (steps) => steps.map((s) => ({ ...s }));

describe('diffWorkflowSteps — classification', () => {
  const base = [
    step(1),
    step(2, { config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: 'equals', value: 'true', then: 3, else: 4 } }) }),
    step(3, { type: 'webhook', config: JSON.stringify({ url: 'https://a.example/x', method: 'POST' }) }),
    step(4, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{items}}', end_step: 5 } }) }),
    step(5),
  ];

  test('identical drafts classify identical', () => {
    const r = diffWorkflowSteps(base, clone(base), OPTS);
    expect(r.classification).toBe('identical');
    expect(r.changes).toEqual([]);
  });

  test('the typo-fix case (message text) is content_only', () => {
    const d = clone(base);
    d[0] = { ...d[0], config: JSON.stringify({ function_name: 'send_sms', params: { to: '{{phone}}', message: 'hello (fixed typo)' } }) };
    const r = diffWorkflowSteps(base, d, OPTS);
    expect(r.classification).toBe('content_only');
    expect(r.changes).toEqual([{ step_number: 1, kind: 'modified', fields: ['config'] }]);
  });

  test('label/note changes are content_only', () => {
    const d = clone(base);
    d[0] = { ...d[0], label: 'renamed', note: 'annotated' };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('content_only');
  });

  test('webhook URL change is content_only (workflow rule — sequences differ)', () => {
    const d = clone(base);
    d[2] = { ...d[2], config: JSON.stringify({ url: 'https://b.example/y', method: 'POST' }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('content_only');
  });

  test('evaluate_condition COMPARISON value change is content_only (value is not a target for this fn)', () => {
    const d = clone(base);
    d[1] = { ...d[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: 'equals', value: 'CHANGED', then: 3, else: 4 } }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('content_only');
  });

  test('evaluate_condition target (then) change is structural', () => {
    const d = clone(base);
    d[1] = { ...d[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: 'equals', value: 'true', then: 5, else: 4 } }) };
    const r = diffWorkflowSteps(base, d, OPTS);
    expect(r.classification).toBe('structural');
    expect(r.structural_reasons.join(' ')).toMatch(/branch target/);
  });

  test('branches[].value (a predicate INPUT) is content — deliberate seam, final-review F10 ruling', () => {
    // Predicate inputs at any nesting depth are content; only branch TARGETS
    // are structural. branches[i].value is the same comparison operand the
    // flat evaluate_condition.value case already pins as content — tightening
    // one and not the other would make classification depend on authoring
    // mode. Migrating it means in-flight runs evaluate the new condition at
    // that step, which is what "apply to in-flight" is asking for; it cannot
    // move a step pointer, and publish validation independently range-checks
    // every literal target.
    const withBranches = clone(base);
    withBranches[1] = { ...withBranches[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { branches: [{ variable: 'x', operator: 'equals', value: 'a', then: 3 }], else: 4 } }) };
    const d = clone(withBranches);
    d[1] = { ...d[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { branches: [{ variable: 'x', operator: 'equals', value: 'CHANGED', then: 3 }], else: 4 } }) };
    expect(diffWorkflowSteps(withBranches, d, OPTS).classification).toBe('content_only');
  });

  test('branches[].then change is structural (the array form the flat map cannot see)', () => {
    const withBranches = clone(base);
    withBranches[1] = { ...withBranches[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { branches: [{ variable: 'x', operator: 'equals', value: 'a', then: 3 }], else: 4 } }) };
    const d = clone(withBranches);
    d[1] = { ...d[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { branches: [{ variable: 'x', operator: 'equals', value: 'a', then: 5 }], else: 4 } }) };
    expect(diffWorkflowSteps(withBranches, d, OPTS).classification).toBe('structural');
  });

  test('set_next.value change is structural (value IS the target for set_next)', () => {
    const b = [step(1, { config: JSON.stringify({ function_name: 'set_next', params: { value: 2 } }) }), step(2)];
    const d = clone(b);
    d[0] = { ...d[0], config: JSON.stringify({ function_name: 'set_next', params: { value: '{{jump_to}}' } }) };
    expect(diffWorkflowSteps(b, d, OPTS).classification).toBe('structural');
  });

  test('foreach.end_step change is structural', () => {
    const d = clone(base);
    d[3] = { ...d[3], config: JSON.stringify({ function_name: 'foreach', params: { list: '{{items}}', end_step: 4 } }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('structural');
  });

  test('type change, function_name change, error_policy change are each structural', () => {
    let d = clone(base);
    d[0] = { ...d[0], type: 'webhook', config: JSON.stringify({ url: 'https://x' }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('structural');

    d = clone(base);
    d[0] = { ...d[0], config: JSON.stringify({ function_name: 'send_email', params: { to: '{{phone}}', message: 'hi' } }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('structural');

    d = clone(base);
    d[0] = { ...d[0], error_policy: JSON.stringify({ on_error: 'continue' }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('structural');
  });

  test('any change to a custom_code step is structural — even whitespace', () => {
    const b = [step(1, { type: 'custom_code', config: JSON.stringify({ code: 'return 1;' }) }), step(2)];
    const d = clone(b);
    d[0] = { ...d[0], config: JSON.stringify({ code: 'return 1; ' }) };
    const r = diffWorkflowSteps(b, d, OPTS);
    expect(r.classification).toBe('structural');
    expect(r.structural_reasons.join(' ')).toMatch(/custom_code/);
  });

  test('set_vars change is STRUCTURAL when the workflow carries a runtime-resolved branch target (review III.F1)', () => {
    // set_vars populates the variables a "{{jump_to}}"-style target reads at
    // dispatch — with a dynamic target in play, a set_vars edit IS a control
    // flow edit. The live archetype: wf41 step 8 sets jump_to, step 9 is
    // set_next {value: "{{jump_to}}"}.
    const b = [
      step(1, { type: 'webhook', config: JSON.stringify({ url: 'https://x', set_vars: { jump_to: 2 } }) }),
      step(2, { config: JSON.stringify({ function_name: 'set_next', params: { value: '{{jump_to}}' } }) }),
      step(3),
    ];
    const d = clone(b);
    d[0] = { ...d[0], config: JSON.stringify({ url: 'https://x', set_vars: { jump_to: 3 } }) };
    const r = diffWorkflowSteps(b, d, OPTS);
    expect(r.classification).toBe('structural');
    expect(r.structural_reasons.join(' ')).toMatch(/set_vars changed while this workflow uses a runtime-resolved branch target/);
  });

  test('set_vars change stays CONTENT when no dynamic target exists (wf15/16 logging-style edits remain migratable)', () => {
    const b = [
      step(1, { config: JSON.stringify({ function_name: 'set_next', params: { value: 2 }, set_vars: { note: 'a' } }) }),
      step(2),
    ];
    const d = clone(b);
    d[0] = { ...d[0], config: JSON.stringify({ function_name: 'set_next', params: { value: 2 }, set_vars: { note: 'b' } }) };
    expect(diffWorkflowSteps(b, d, OPTS).classification).toBe('content_only');
  });

  test('a draft that INTRODUCES a dynamic target while editing set_vars is structural (both-sides scan)', () => {
    const b = [
      step(1, { type: 'webhook', config: JSON.stringify({ url: 'https://x', set_vars: { jump_to: 2 } }) }),
      step(2, { config: JSON.stringify({ function_name: 'set_next', params: { value: 2 } }) }),
      step(3),
    ];
    const d = clone(b);
    d[0] = { ...d[0], config: JSON.stringify({ url: 'https://x', set_vars: { jump_to: 3 } }) };
    d[1] = { ...d[1], config: JSON.stringify({ function_name: 'set_next', params: { value: '{{jump_to}}' } }) };
    const r = diffWorkflowSteps(b, d, OPTS);
    expect(r.classification).toBe('structural');
  });

  test('internal_function with a missing function_name is structural — fail-closed, not fail-harmless (review II.5)', () => {
    // Without function_name the branch-target extraction has nothing to key
    // on, so both sides extract [] and config diffs used to fall through to
    // content. The step is inert (the engine dispatches on function_name),
    // but the classifier's contract is fail-closed in every reachable case.
    const b = [step(1, { config: JSON.stringify({ params: { value: 3 } }) }), step(2)];
    const d = clone(b);
    d[0] = { ...d[0], config: JSON.stringify({ params: { value: 9 } }) };
    const r = diffWorkflowSteps(b, d, OPTS);
    expect(r.classification).toBe('structural');
    expect(r.structural_reasons.join(' ')).toMatch(/without a valid function_name/);
  });

  test('added / removed steps are structural', () => {
    expect(diffWorkflowSteps(base, [...clone(base), step(6)], OPTS).classification).toBe('structural');
    expect(diffWorkflowSteps(base, clone(base).slice(0, 4), OPTS).classification).toBe('structural');
  });

  test('a content change AND a structural change together classify structural (fail-closed)', () => {
    const d = clone(base);
    d[0] = { ...d[0], label: 'typo fix' };
    d[1] = { ...d[1], config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: 'equals', value: 'true', then: 5, else: 4 } }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('structural');
  });

  test('config key-order differences alone do NOT register as changes (canonical compare)', () => {
    const d = clone(base);
    d[0] = { ...d[0], config: JSON.stringify({ params: { message: 'hi', to: '{{phone}}' }, function_name: 'send_sms' }) };
    expect(diffWorkflowSteps(base, d, OPTS).classification).toBe('identical');
  });
});

describe('validateWorkflowDraft — publish gate (O5)', () => {
  test('empty draft blocks', () => {
    const v = validateWorkflowDraft([], OPTS);
    expect(v.errors).toEqual(['draft has no steps']);
  });

  test('non-contiguous numbering blocks', () => {
    const v = validateWorkflowDraft([step(1), step(3)], OPTS);
    expect(v.errors.join(' ')).toMatch(/not contiguous/);
  });

  test('out-of-range literal target blocks', () => {
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'set_next', params: { value: 9 } }) }),
      step(2),
    ];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors.join(' ')).toMatch(/set_next\.value targets step 9, outside 1\.\.2/);
  });

  test('branches[].then out of range blocks', () => {
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'evaluate_condition', params: { branches: [{ then: 7 }], else: 2 } }) }),
      step(2),
    ];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors.join(' ')).toMatch(/branches\[0\]\.then targets step 7/);
  });

  test('foreach.end_step must be strictly after its own step (in-range is not enough)', () => {
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{x}}', end_step: 2 } }) }),
      step(3),
    ];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors.join(' ')).toMatch(/end_step \(2\) must be greater/);
    // and a forward exit passes
    const ok = validateWorkflowDraft([
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{x}}', end_step: 3 } }) }),
      step(3),
    ], OPTS);
    expect(ok.errors).toEqual([]);
  });

  test('non-literal target WARNS but does not block (live wf41 {{jump_to}} usage)', () => {
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'set_next', params: { value: '{{jump_to}}' } }) }),
      step(2),
    ];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/non-literal/);
  });

  test('terminal sentinels pass silently', () => {
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: 'equals', value: 'y', then: 2, else: 'end' } }) }),
      step(2),
    ];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test('custom_code mentioning next_step is informational only', () => {
    const steps = [step(1, { type: 'custom_code', config: JSON.stringify({ code: 'ctx.next_step = 2;' }) }), step(2)];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors).toEqual([]);
    expect(v.info.join(' ')).toMatch(/custom_code mentions next_step/);
  });

  test('digit-string targets validate like integers', () => {
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'set_next', params: { value: '4' } }) }),
      step(2),
    ];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors.join(' ')).toMatch(/targets step 4, outside 1\.\.2/);
  });
});


// ── Pause-free cycle gate (2026-09-22, wf27 v6 runaway) ────────────────────
// V6 is the CONTROL-FLOW SHAPE of the live wf27 v6 draft that looped: each
// row is [step_number, function_name | 'custom_code', branch-target params].
// Payload params are stripped (they carry lead-routing content and don't
// affect the graph). Steps 40-47 are the appended duplicate of 32-39.
const V6 = [
  [1, 'custom_code'],
  [2, 'query_ai'],
  [3, 'evaluate_condition', {"then": 25, "else": 4}],
  [4, 'evaluate_condition', {"then": 5, "else": 6}],
  [5, 'set_var'],
  [6, 'intake_contact'],
  [7, 'evaluate_condition', {"else": 27, "branches": [{"then": 8}, {"then": 8}]}],
  [8, 'intake_case'],
  [9, 'custom_code'],
  [10, 'evaluate_condition', {"then": 39, "else": 11}],
  [11, 'business_deadline'],
  [12, 'request_decision', {"nextStep": 13}],
  [13, 'evaluate_condition', {"else": 31, "branches": [{"then": 14}, {"then": 16}, {"then": 19}, {"then": 22}, {"then": 23}, {"then": 29}]}],
  [14, 'advance_stage'],
  [15, 'set_next', {"value": "end"}],
  [16, 'advance_stage'],
  [17, 'set_var'],
  [18, 'set_next', {"value": 32}],
  [19, 'advance_stage'],
  [20, 'set_var'],
  [21, 'set_next', {"value": 32}],
  [22, 'wait_for', {"nextStep": 20, "duration": "1d"}],
  [23, 'advance_stage'],
  [24, 'set_next', {"value": "end"}],
  [25, 'send_email'],
  [26, 'set_next', {"value": "end"}],
  [27, 'create_task'],
  [28, 'set_next', {"value": "end"}],
  [29, 'create_task'],
  [30, 'set_next', {"value": "end"}],
  [31, 'set_var'],
  [32, 'get_appointments'],
  [33, 'get_appointments'],
  [34, 'query_db'],
  [35, 'evaluate_condition', {"branches": [{"then": 37}, {"then": 37}, {"then": 36}, {"then": 36}, {"then": 36}]}],
  [36, 'evaluate_condition', {"then": 39, "else": 9}],
  [37, 'advance_stage'],
  [38, 'set_next', {"value": "end"}],
  [39, 'create_task'],
  [40, 'get_appointments'],
  [41, 'get_appointments'],
  [42, 'query_db'],
  [43, 'evaluate_condition', {"branches": [{"then": 37}, {"then": 37}, {"then": 36}, {"then": 36}, {"then": 36}]}],
  [44, 'evaluate_condition', {"then": 39, "else": 9}],
  [45, 'advance_stage'],
  [46, 'set_next', {"value": "end"}],
  [47, 'create_task'],
];
function shapeSteps(rows) {
  return rows.map(([n, fn, params]) => fn === 'custom_code'
    ? step(n, { type: 'custom_code', config: JSON.stringify({ code: '({})' }) })
    : step(n, { config: JSON.stringify({ function_name: fn, params: params || {} }) }));
}
const cycleErrors = (v) => v.errors.filter((e) => /form a loop with no pause/.test(e));

describe('validateWorkflowDraft — pause-free cycle gate', () => {
  test('wf27 v6 (the incident) is blocked, naming the runaway steps and the jump back', () => {
    const errs = cycleErrors(validateWorkflowDraft(shapeSteps(V6), OPTS));
    expect(errs).toHaveLength(1);
    // 36 → 39 (create_task) → 40…43 → 36, plus 36 →else 9 → 10 →cap 39 → … → 36
    expect(errs[0]).toMatch(/^steps 9, 10, 36, 39, 40, 41, 42, 43 form a loop/);
    expect(errs[0]).toMatch(/43→36/);
  });

  test('wf27 v7 (v6 minus the duplicate block) passes', () => {
    expect(validateWorkflowDraft(shapeSteps(V6.slice(0, 39)), OPTS).errors).toEqual([]);
  });

  test('an SCC that contains a pause elsewhere is NOT enough — the inner pause-free cycle is still found', () => {
    // 1 → 2 (decision) → 3 ⇄ 4: {1..4} is one SCC containing request_decision,
    // but 3 → 4 → 3 never passes through it.
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'request_decision', params: { nextStep: 3 } }) }),
      step(3),
      step(4, { config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: '==', value: 1, then: 1, else: 3 } }) }),
    ];
    const errs = cycleErrors(validateWorkflowDraft(steps, OPTS));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^steps 3, 4 form a loop/);
  });

  test('fall-through into a set_next back-jump is blocked', () => {
    const steps = [step(1), step(2, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) })];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))[0]).toMatch(/^steps 1, 2 form a loop .*2→1/);
  });

  test('a set_next self-loop is blocked', () => {
    const steps = [step(1, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) })];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))[0]).toMatch(/^steps 1 form a loop .*1→1/);
  });

  test('evaluate_condition branches[].then back-edges count', () => {
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'evaluate_condition', params: { branches: [{ variable: 'x', operator: '==', value: 1, then: 3 }, { variable: 'x', operator: '==', value: 2, then: 1 }] } }) }),
      step(3),
    ];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))).toHaveLength(1);
  });

  test('a wait inside the loop makes it legitimate', () => {
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'wait_for', params: { duration: '1d', nextStep: 3 } }) }),
      step(3, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) }),
    ];
    expect(validateWorkflowDraft(steps, OPTS).errors).toEqual([]);
  });

  test('a foreach loop-back is legitimate (live wf39 shape)', () => {
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{items}}', item_var: 'it', end_step: 5 } }) }),
      step(3),
      step(4, { config: JSON.stringify({ function_name: 'set_next', params: { value: 2 } }) }),
      step(5),
    ];
    expect(validateWorkflowDraft(steps, OPTS).errors).toEqual([]);
  });

  test('an outer loop that runs through a foreach and jumps back above it is blocked', () => {
    // Each pass restarts the whole list — the foreach cursor bounds nothing here.
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{items}}', item_var: 'it', end_step: 5 } }) }),
      step(3),
      step(4, { config: JSON.stringify({ function_name: 'set_next', params: { value: 2 } }) }),
      step(5, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) }),
    ];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))[0]).toMatch(/^steps 1, 2, 5 form a loop .*5→1/);
  });

  test('a foreach body that jumps back to a setup step (not onto the foreach) is blocked', () => {
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{items}}', item_var: 'it', end_step: 5 } }) }),
      step(3),
      step(4, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) }),
      step(5),
    ];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))[0]).toMatch(/^steps 1, 2, 3, 4 form a loop/);
  });

  test('nested foreach loops pass', () => {
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{o}}', item_var: 'o', end_step: 6 } }) }),
      step(2, { config: JSON.stringify({ function_name: 'foreach', params: { list: '{{i}}', item_var: 'i', end_step: 5 } }) }),
      step(3),
      step(4, { config: JSON.stringify({ function_name: 'set_next', params: { value: 2 } }) }),
      step(5, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) }),
      step(6),
    ];
    expect(validateWorkflowDraft(steps, OPTS).errors).toEqual([]);
  });

  test('control steps never fall through — an evaluate_condition with no else does not reach the next step', () => {
    // 1 →then 3 (no else = end); 2 → 1 would only be a loop if 1 fell through to 2.
    const steps = [
      step(1, { config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: 'x', operator: '==', value: 1, then: 3 } }) }),
      step(2, { config: JSON.stringify({ function_name: 'set_next', params: { value: 1 } }) }),
      step(3),
    ];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))).toEqual([]);
  });

  test('branch mode ignores a leftover top-level then — no false edge', () => {
    // control.js: in branch mode only branches[].then / else are ever taken.
    const steps = [
      step(1),
      step(2, { config: JSON.stringify({ function_name: 'evaluate_condition', params: {
        then: 1,                                               // stale, never taken
        branches: [{ variable: 'x', operator: '==', value: 1, then: 3 }], else: 3,
      } }) }),
      step(3),
    ];
    expect(cycleErrors(validateWorkflowDraft(steps, OPTS))).toEqual([]);
  });

  test('non-literal targets add no edge (still just the existing warning)', () => {
    const steps = [step(1), step(2, { config: JSON.stringify({ function_name: 'set_next', params: { value: '{{jump_to}}' } }) })];
    const v = validateWorkflowDraft(steps, OPTS);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/non-literal/);
  });
});

describe('PAUSE_FUNCTIONS is exactly the set of functions that can return delayed_until', () => {
  const { PAUSE_FUNCTIONS } = require('../lib/versionDiff');
  const fnDir = path.join(__dirname, '..', 'lib', 'internal_functions');

  test('source scan: every fns.X that returns delayed_until is listed, and nothing else', () => {
    const found = new Set();
    for (const f of fs.readdirSync(fnDir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(fnDir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (not URLs)
      const parts = src.split(/^fns\.(\w+)\s*=/m);  // [pre, name1, body1, name2, body2, …]
      for (let i = 1; i < parts.length; i += 2) {
        if (/\bdelayed_until\s*:/.test(parts[i + 1])) found.add(parts[i]);
      }
    }
    expect([...found].sort()).toEqual([...PAUSE_FUNCTIONS].sort());
  });

  test('every listed name is a registered internal function', () => {
    const registry = require('../lib/internal_functions');
    for (const name of PAUSE_FUNCTIONS) expect(typeof registry[name]).toBe('function');
  });
});
