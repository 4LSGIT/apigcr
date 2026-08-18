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
