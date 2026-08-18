/**
 * tests/versionDiff.sequences.test.js
 *
 * Unit tests for the sequence classifier (lib/versionDiff.js
 * diffSequenceSteps + validateSequenceDraftShape) — automation versioning S4.
 *
 * The sequence whitelist is deliberately narrower than the workflow one:
 * content = action_config leaves for an UNCHANGED sms/email/task action_type,
 * and nothing else. Both directions are pinned — the message-typo cases must
 * classify content_only (or the migrate feature is uselessly disabled), and
 * every control-adjacent change must classify structural.
 *
 *   npx jest tests/versionDiff.sequences.test.js
 */

const { diffSequenceSteps, validateSequenceDraftShape } = require('../lib/versionDiff');

let nextId = 1;
function step(step_number, over = {}) {
  return {
    id: nextId++,
    step_number,
    action_type: 'sms',
    action_config: JSON.stringify({ to: '{{phone}}', message: 'hi' }),
    timing: JSON.stringify({ type: 'immediate' }),
    condition: null,
    fire_guard: null,
    error_policy: null,
    ...over,
  };
}
const clone = (steps) => steps.map((s) => ({ ...s }));
const NO_COND = { currentCondition: null, draftCondition: null };

describe('diffSequenceSteps — classification', () => {
  const base = [
    step(1),
    step(2, { action_type: 'email', action_config: JSON.stringify({ to: '{{email}}', subject: 'S', body: 'B' }) }),
    step(3, { action_type: 'webhook', action_config: JSON.stringify({ url: 'https://a.example/x', method: 'POST' }) }),
    step(4, { action_type: 'task', action_config: JSON.stringify({ title: 'call them' }) }),
  ];

  test('identical drafts classify identical', () => {
    expect(diffSequenceSteps(base, clone(base), NO_COND).classification).toBe('identical');
  });

  test('sms / email / task payload changes are content_only', () => {
    const d = clone(base);
    d[0] = { ...d[0], action_config: JSON.stringify({ to: '{{phone}}', message: 'hello (typo fixed)' }) };
    d[1] = { ...d[1], action_config: JSON.stringify({ to: '{{email}}', subject: 'S2', body: 'B' }) };
    d[3] = { ...d[3], action_config: JSON.stringify({ title: 'call them today' }) };
    const r = diffSequenceSteps(base, d, NO_COND);
    expect(r.classification).toBe('content_only');
    expect(r.changes.map(c => c.step_number).sort()).toEqual([1, 2, 4]);
  });

  test('webhook action_config change is structural (unlike workflows)', () => {
    const d = clone(base);
    d[2] = { ...d[2], action_config: JSON.stringify({ url: 'https://b.example/y', method: 'POST' }) };
    const r = diffSequenceSteps(base, d, NO_COND);
    expect(r.classification).toBe('structural');
    expect(r.structural_reasons.join(' ')).toMatch(/webhook action_config changed/);
  });

  test('start_workflow and internal_function config changes are structural', () => {
    const b = [
      step(1, { action_type: 'start_workflow', action_config: JSON.stringify({ workflow_id: 5 }) }),
      step(2, { action_type: 'internal_function', action_config: JSON.stringify({ function_name: 'f', params: {} }) }),
    ];
    let d = clone(b);
    d[0] = { ...d[0], action_config: JSON.stringify({ workflow_id: 6 }) };
    expect(diffSequenceSteps(b, d, NO_COND).classification).toBe('structural');
    d = clone(b);
    d[1] = { ...d[1], action_config: JSON.stringify({ function_name: 'f', params: { x: 1 } }) };
    expect(diffSequenceSteps(b, d, NO_COND).classification).toBe('structural');
  });

  test('timing, step condition, fire_guard, error_policy, action_type changes are each structural', () => {
    const cases = [
      { timing: JSON.stringify({ type: 'delay', delay_minutes: 5 }) },
      { condition: JSON.stringify({ field: 'x', op: 'eq', value: 'y' }) },
      { fire_guard: JSON.stringify({ max_per_day: 1 }) },
      { error_policy: JSON.stringify({ on_error: 'continue' }) },
      { action_type: 'email' },
    ];
    for (const over of cases) {
      const d = clone(base);
      d[0] = { ...d[0], ...over };
      expect(diffSequenceSteps(base, d, NO_COND).classification).toBe('structural');
    }
  });

  test('template_condition change is structural — even with identical steps', () => {
    const r = diffSequenceSteps(base, clone(base), {
      currentCondition: JSON.stringify({ field: 'case_status', op: 'eq', value: 'open' }),
      draftCondition: JSON.stringify({ field: 'case_status', op: 'eq', value: 'active' }),
    });
    expect(r.classification).toBe('structural');
    expect(r.structural_reasons).toContain('template condition changed');
  });

  test('template_condition key-order difference alone is identical (canonical compare)', () => {
    const r = diffSequenceSteps(base, clone(base), {
      currentCondition: JSON.stringify({ a: 1, b: 2 }),
      draftCondition: JSON.stringify({ b: 2, a: 1 }),
    });
    expect(r.classification).toBe('identical');
  });

  test('added / removed steps are structural', () => {
    expect(diffSequenceSteps(base, [...clone(base), step(5)], NO_COND).classification).toBe('structural');
    expect(diffSequenceSteps(base, clone(base).slice(0, 3), NO_COND).classification).toBe('structural');
  });

  test('a content change alongside any structural change classifies structural (fail-closed)', () => {
    const d = clone(base);
    d[0] = { ...d[0], action_config: JSON.stringify({ to: '{{phone}}', message: 'typo fix' }) };
    d[2] = { ...d[2], action_config: JSON.stringify({ url: 'https://b.example', method: 'POST' }) };
    expect(diffSequenceSteps(base, d, NO_COND).classification).toBe('structural');
  });
});

describe('validateSequenceDraftShape', () => {
  test('empty draft blocks', () => {
    expect(validateSequenceDraftShape([]).errors).toEqual(['draft has no steps']);
  });
  test('non-contiguous numbering blocks', () => {
    expect(validateSequenceDraftShape([step(1), step(3)]).errors.join(' ')).toMatch(/not contiguous/);
  });
  test('contiguous draft passes shape', () => {
    expect(validateSequenceDraftShape([step(1), step(2)]).errors).toEqual([]);
  });
});
