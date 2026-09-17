/**
 * tests/workflows.flowgraph.test.js
 *
 * The step canvas in workflows.html is a flat vertical list, and it used to
 * draw a ↓ between every pair of cards. That arrow is a claim about control
 * flow, and for a control step it is usually FALSE — evaluate_condition,
 * set_next, foreach and the waits redirect the engine, so the card below them
 * may never run. wfStepEdges() is the one place that reads a step's real
 * outgoing targets; the connector, the "goes to" chips and the target
 * highlight all derive from it.
 *
 * What this pins:
 *   1. Each control function's edges, including the three cases the UI used to
 *      get wrong: an omitted `else` ENDS the workflow (control steps never
 *      advance sequentially), an omitted set_next `value` does NOT (the engine
 *      reads next_step:undefined as a fall-through), and a {{placeholder}}
 *      target is 'var' — unknown until run time, never a drawn edge.
 *   2. wfEdgesFallThrough — the connector's truth condition.
 *   3. Registry sync: every internal function carrying __meta.controlFlow has
 *      a case in wfStepEdges. That pairing is exactly the drift that kept
 *      wait_for's skip path broken in the engine for months (see
 *      isControlStep's comment in lib/workflow_engine.js).
 *   4. A real render: selecting a branch step marks its targets and cuts the
 *      connector under it.
 *
 * MECHANICS
 * Same approach as workflows.reorder.state.test.js — brace-match the functions
 * out of the shipped <script> and run THOSE against a jsdom document, so the
 * suite exercises the real source and fails loudly on a rename.
 *
 *   npx jest tests/workflows.flowgraph.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'public', 'automation', 'workflows.html');

// Brace-match a function out of the inline <script>. The sibling suites count
// raw brace characters, which is fine until a function holds a `{{ }}`
// placeholder in a string literal — which is precisely wfStepEdges' subject.
// So this one skips strings, template literals, comments and regex literals
// while it counts. (Regex-vs-division uses the usual heuristic: a `/` right
// after a character that cannot end an expression starts a regex.)
const _OPERAND_BEFORE = '(,=:[!&|?{};+-*%~^<>';
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`workflows.html: function ${name} not found — did it get renamed?`);
  let i = src.indexOf('{', start);
  let prev = '';
  const stack = [{ tmpl: false, depth: 0 }];   // `${ … }` inside a template pushes a code frame
  for (; i < src.length; i++) {
    const top = stack[stack.length - 1];
    const c = src[i], n = src[i + 1];
    if (top.tmpl) {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && n === '{') { stack.push({ tmpl: false, depth: 1 }); i++; continue; }
      continue;
    }
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '/' && _OPERAND_BEFORE.includes(prev)) {          // regex literal
      i++;
      while (i < src.length && src[i] !== '/') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
        i++;
      }
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      prev = q;
      continue;
    }
    if (c === '`') { stack.push({ tmpl: true, depth: 0 }); continue; }
    if (c === '{') { top.depth++; }
    else if (c === '}') {
      top.depth--;
      if (top.depth === 0) {
        if (stack.length === 1) return src.slice(start, i + 1);
        stack.pop();                                            // closed a `${ … }`
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error(`workflows.html: unbalanced braces in ${name}`);
}

const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const SCRIPT = HTML.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

const FN_NAMES = [
  'esc', 'trimUrl',
  '_wfHasKey', '_wfClassifyTarget', '_wfCondText',
  'wfStepEdges', 'wfEdgesFallThrough', '_wfEdgeChip',
  'renderWfCanvas', 'wfStepCardHTML',
];
const SOURCES = FN_NAMES.map(n => extractFn(SCRIPT, n)).join('\n\n');

function mkStep(n, fnName, params, extra) {
  return Object.assign({
    id: 100 + n,
    step_number: n,
    type: 'internal_function',
    config: { function_name: fnName, params: params || {} },
  }, extra || {});
}

function makeHarness(steps) {
  const dom = new JSDOM('<body><div id="wf-canvas-body"></div></body>');
  const WF = { steps, activeStepIdx: null, activeStepId: null, pendingMove: null, moveCommit: null };
  const ctx = vm.createContext({ document: dom.window.document, window: dom.window, WF, console });
  vm.runInContext(SOURCES, ctx);
  return {
    WF,
    document: dom.window.document,
    call: (name, ...args) => vm.runInContext(name, ctx)(...args),
  };
}

const H = makeHarness([]);
const edges = step => H.call('wfStepEdges', step);
const kinds = step => edges(step).map(e => `${e.label}:${e.kind}${e.step != null ? e.step : ''}`);

describe('wfStepEdges — outgoing targets per control function', () => {
  test('set_next: a step number, and the sentinels', () => {
    expect(kinds(mkStep(3, 'set_next', { value: 7 }))).toEqual(['jump to:step7']);
    expect(kinds(mkStep(3, 'set_next', { value: '7' }))).toEqual(['jump to:step7']);
    expect(kinds(mkStep(3, 'set_next', { value: 'end' }))).toEqual(['jump to:end']);
    expect(kinds(mkStep(3, 'set_next', { value: null }))).toEqual(['jump to:end']);
    expect(kinds(mkStep(3, 'set_next', { value: '' }))).toEqual(['jump to:end']);
    expect(kinds(mkStep(3, 'set_next', { value: 'cancel' }))).toEqual(['jump to:cancel']);
    expect(kinds(mkStep(3, 'set_next', { value: 'fail' }))).toEqual(['jump to:fail']);
  });

  test('set_next with NO value key is a fall-through, not an end', () => {
    // The engine guards on `next_step !== undefined`; an absent value means
    // the step silently advances. Drawing an "end" chip there would be a lie.
    expect(edges(mkStep(3, 'set_next', {}))).toEqual([]);
  });

  test('a {{placeholder}} target is computed, not an edge', () => {
    const [e] = edges(mkStep(3, 'set_next', { value: '{{jump_to}}' }));
    expect(e.kind).toBe('var');
    expect(e.raw).toBe('{{jump_to}}');
    expect(e.step).toBeUndefined();
  });

  test('evaluate_condition: then/else, and an omitted else ENDS', () => {
    expect(kinds(mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 5, else: 8 })))
      .toEqual(['if yes:step5', 'if no:step8']);
    // Control steps never fall through, so a missing else is an end — not a
    // hand-off to step 3.
    expect(kinds(mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 5 })))
      .toEqual(['if yes:step5', 'if no:end']);
    expect(kinds(mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 5, else: null })))
      .toEqual(['if yes:step5', 'if no:end']);
  });

  test('evaluate_condition branch mode: one edge per branch plus no-match', () => {
    const step = mkStep(4, 'evaluate_condition', {
      branches: [
        { variable: 'k', operator: '==', value: 'a', then: 6 },
        { conditions: [{ variable: 'k', operator: '==', value: 'b' }], match: 'all', then: 9 },
        { variable: 'k', operator: '==', value: 'c' },   // no `then` — runtime throws
      ],
      else: 12,
    });
    expect(kinds(step)).toEqual(['branch 1:step6', 'branch 2:step9', 'branch 3:bad', 'no match:step12']);
    expect(edges(step)[0].hint).toBe('k == "a"');
  });

  test('foreach: falls into the body, jumps out at end_step', () => {
    expect(kinds(mkStep(5, 'foreach', { list: '{{m}}', item_var: 'm', end_step: 12 })))
      .toEqual(['each item:step6', 'when done:step12']);
    expect(kinds(mkStep(5, 'foreach', { list: '{{m}}', item_var: 'm', end_step: null })))
      .toEqual(['each item:step6', 'when done:end']);
  });

  test('wait_for / schedule_resume expose both the resume and the skip target', () => {
    expect(kinds(mkStep(2, 'wait_for', { duration: '2h', nextStep: 5 }))).toEqual(['then:step5']);
    expect(kinds(mkStep(2, 'wait_for', { at: '{{t}}', nextStep: 5, skipToStep: 7 })))
      .toEqual(['then:step5', 'if skipped:step7']);
    expect(kinds(mkStep(2, 'schedule_resume', { resumeAt: '2h', nextStep: 4 }))).toEqual(['then:step4']);
    expect(kinds(mkStep(2, 'wait_until_time', { time: '09:00', nextStep: 6 }))).toEqual(['then:step6']);
  });

  test('request_decision: only an explicit nextStep is an edge', () => {
    expect(kinds(mkStep(3, 'request_decision', { nextStep: 9 }))).toEqual(['after answer:step9']);
    expect(edges(mkStep(3, 'request_decision', { question: 'q' }))).toEqual([]);
  });

  test('non-control steps have no edges', () => {
    expect(edges(mkStep(1, 'send_sms', { to: '1', message: 'hi' }))).toEqual([]);
    expect(edges({ id: 1, step_number: 1, type: 'webhook', config: { url: 'https://x' } })).toEqual([]);
    expect(edges({ id: 1, step_number: 1, type: 'custom_code', config: { code: 'return 1' } })).toEqual([]);
  });
});

describe('wfEdgesFallThrough — the connector’s truth condition', () => {
  const falls = step => H.call('wfEdgesFallThrough', edges(step), step);

  test('an ordinary step reaches the card below it', () => {
    expect(falls(mkStep(2, 'send_sms', { to: '1', message: 'hi' }))).toBe(true);
  });

  test('a branch that can land on step+1 still falls through', () => {
    expect(falls(mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 3, else: 9 }))).toBe(true);
    expect(falls(mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 9, else: 3 }))).toBe(true);
  });

  test('a branch that never lands on step+1 does not', () => {
    expect(falls(mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 5, else: 9 }))).toBe(false);
    expect(falls(mkStep(2, 'set_next', { value: 7 }))).toBe(false);
    expect(falls(mkStep(2, 'wait_for', { duration: '2h', nextStep: 5 }))).toBe(false);
  });

  test('a computed target is a jump, not a fall-through', () => {
    expect(falls(mkStep(2, 'set_next', { value: '{{jump_to}}' }))).toBe(false);
  });

  test('foreach falls into its body', () => {
    expect(falls(mkStep(5, 'foreach', { list: '{{m}}', item_var: 'm', end_step: 12 }))).toBe(true);
  });
});

describe('_wfEdgeChip', () => {
  const known = new Set([1, 2, 3]);
  const chip = (label, val) => H.call('_wfEdgeChip', Object.assign({ label }, H.call('_wfClassifyTarget', val)), known);

  test('a live step is clickable, a dead one is flagged', () => {
    expect(chip('if yes', 2)).toContain('wfGotoStepNum(2)');
    expect(chip('if yes', 2)).toContain('tg-step');
    expect(chip('if yes', 99)).toContain('tg-bad');
    expect(chip('if yes', 99)).not.toContain('wfGotoStepNum');
  });

  test('a variable target is marked as computed', () => {
    const html = chip('jump to', '{{jump_to}}');
    expect(html).toContain('tg-var');
    expect(html).toContain('computed at run time');
    expect(html).toContain('{{jump_to}}');
  });

  test('sentinels render as terminal, not as steps', () => {
    expect(chip('if no', 'end')).toContain('tg-end');
    expect(chip('if no', 'cancel')).toContain('tg-cancel');
    expect(chip('if no', 'fail')).toContain('tg-fail');
  });
});

describe('registry sync — controlFlow functions all have a wfStepEdges case', () => {
  test('every __meta.controlFlow function is handled by the canvas', () => {
    const fns = require('../lib/internal_functions');
    const control = Object.keys(fns)
      .filter(n => fns[n] && fns[n].__meta && fns[n].__meta.controlFlow === true);
    expect(control.length).toBeGreaterThan(0);
    const srcOfEdges = extractFn(SCRIPT, 'wfStepEdges');
    const missing = control.filter(n => !srcOfEdges.includes(`case '${n}':`));
    expect(missing).toEqual([]);
  });
});

describe('renderWfCanvas', () => {
  // 1 send_sms → 2 evaluate_condition(then 4, else 5) → 3 send_sms → 4 → 5
  const steps = () => [
    mkStep(1, 'send_sms', { to: '1', message: 'hi' }),
    mkStep(2, 'evaluate_condition', { variable: 'x', operator: '==', value: 1, then: 4, else: 5 }),
    mkStep(3, 'send_sms', { to: '1', message: 'skipped' }),
    mkStep(4, 'send_sms', { to: '1', message: 'yes' }),
    mkStep(5, 'set_next', { value: 2 }),
  ];

  test('the connector under a branch step is cut, the others are arrows', () => {
    const h = makeHarness(steps());
    h.call('renderWfCanvas');
    const conns = [...h.document.querySelectorAll('.step-connector')];
    // 4 between-card connectors + the trailing stub before "Add Step".
    expect(conns.length).toBe(5);
    expect(conns.map(c => c.classList.contains('is-cut')))
      .toEqual([false, true, false, false, true]);
    expect(conns[1].getAttribute('title')).toMatch(/never continues to step 3/);
  });

  test('a branch step lists its targets as chips even when unselected', () => {
    const h = makeHarness(steps());
    h.call('renderWfCanvas');
    const card = h.document.querySelectorAll('.step-card')[1];
    const chips = [...card.querySelectorAll('.step-targets .tg-chip')].map(c => c.textContent.trim());
    expect(chips).toEqual(['if yes 4', 'if no 5']);
  });

  test('selecting a step marks the cards it jumps to', () => {
    const h = makeHarness(steps());
    h.WF.activeStepIdx = 1;
    h.WF.activeStepId = h.WF.steps[1].id;
    h.call('renderWfCanvas');
    const cards = [...h.document.querySelectorAll('.step-card')];
    expect(cards.map(c => c.classList.contains('is-target')))
      .toEqual([false, false, false, true, true]);
    expect(cards[3].querySelector('.badge-in').textContent.trim()).toBe('if yes');
    expect(cards[4].querySelector('.badge-in').textContent.trim()).toBe('if no');
  });

  test('the selected step lists the jumps that land on it', () => {
    const h = makeHarness(steps());
    h.WF.activeStepIdx = 1;           // step 2 — jumped to by step 5's set_next
    h.WF.activeStepId = h.WF.steps[1].id;
    h.call('renderWfCanvas');
    const rows = [...h.document.querySelectorAll('.step-card')[1].querySelectorAll('.step-targets')];
    expect(rows.length).toBe(2);
    expect(rows[1].querySelector('.tg-lead').textContent).toBe('jumped to from');
    expect(rows[1].querySelector('.tg-chip').textContent.replace(/\s+/g, ' ').trim()).toBe('5 jump to');
  });

  test('nothing is marked when no step is selected', () => {
    const h = makeHarness(steps());
    h.call('renderWfCanvas');
    expect(h.document.querySelectorAll('.step-card.is-target').length).toBe(0);
    expect(h.document.querySelectorAll('.badge-in').length).toBe(0);
  });
});
