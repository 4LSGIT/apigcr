/**
 * tests/workflows.reorder.state.test.js
 *
 * Pins the two pieces of workflows.html state that must survive a step
 * RENUMBERING (reorder / insert-at / delete), because both used to be keyed by
 * array index and both silently pointed at the wrong step afterwards:
 *
 *   1. WF.testerState — per-step tester variable rows. Index-keyed, so every
 *      steps refresh had to wipe the whole map. That made a plain step Save
 *      (which reloads) throw away variables the user had just typed, and a
 *      reorder would otherwise have handed step A's rows to step B.
 *
 *   2. wfSyncActiveStep — re-derives WF.activeStepIdx from the anchored
 *      WF.activeStepId after a reload. Before the anchor existed, a reorder
 *      left activeStepIdx pointing at whatever slid into the old slot while
 *      the editor pane still showed the moved step; Save then PUT the open
 *      editor's config onto the WRONG step_number. That is the corruption
 *      this anchor exists to prevent, so it gets a test.
 *
 * MECHANICS
 * Same approach as workflows.editor.roundtrip.test.js: workflows.html is one
 * huge inline <script> whose top level does boot work, so instead of evaluating
 * the file we brace-match out just the functions under test and run THOSE
 * against a jsdom document. That keeps the suite honest — it exercises the
 * shipped source, not a copy — and fails loudly (extractFn throws) if anything
 * is renamed out from under it.
 *
 *   npx jest tests/workflows.reorder.state.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'public', 'automation', 'workflows.html');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`workflows.html: function ${name} not found — did it get renamed?`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`workflows.html: unbalanced braces in ${name}`);
}

const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const SCRIPT = HTML.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

const SOURCES = [
  extractFn(SCRIPT, 'esc'),
  extractFn(SCRIPT, 'parseJson'),
  extractFn(SCRIPT, 'wfVarRowHTML'),
  extractFn(SCRIPT, 'wfRenderTester'),
  extractFn(SCRIPT, 'wfSaveTesterState'),
  extractFn(SCRIPT, 'wfAddVarRow'),
  extractFn(SCRIPT, 'wfRemoveVarRow'),
  extractFn(SCRIPT, 'wfSyncActiveStep'),
  extractFn(SCRIPT, 'wfStepIdxById'),
].join('\n\n');

function mkStep(id, n, cfg) {
  return { id, step_number: n, type: 'internal_function', config: cfg || { function_name: 'noop', params: {} } };
}

/** Sandbox holding the real functions wired to a fake editor DOM. */
function makeHarness(steps) {
  const dom = new JSDOM(
    '<body><div id="wf-editor-body"></div><div id="wf-editor-foot"></div></body>'
  );
  const { window } = dom;
  const clearEditorCalls = [];

  const WF = {
    steps,
    activeWf: { test_input: null },
    activeStepIdx: null,
    activeStepId: null,
    editingNew: false,
    testerState: {},
  };

  const ctx = vm.createContext({
    document: window.document,
    window,
    WF,
    // wfSyncActiveStep calls this when the anchored step is gone.
    wfClearEditor: () => { clearEditorCalls.push(1); },
    console,
  });
  vm.runInContext(SOURCES, ctx);

  return {
    WF,
    window,
    clearEditorCalls,
    call: (name, ...args) => vm.runInContext(name, ctx)(...args),
    // Read the tester rows straight out of the DOM.
    domRows: () => [...window.document.querySelectorAll('#wf-editor-body .var-row')]
      .map(r => {
        const [k, v] = r.querySelectorAll('input');
        return { key: k.value, value: v.value };
      }),
    // Type into a tester row exactly as a user would, then fire the same
    // 'input' event the page's delegated listener is bound to.
    typeInto: (rowIdx, key, value) => {
      const row = window.document.querySelectorAll('#wf-editor-body .var-row')[rowIdx];
      const [k, v] = row.querySelectorAll('input');
      k.value = key; v.value = value;
      row.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    // Reorder WF.steps the way wfMoveStep does: splice + renumber 1..N.
    reorder: (fromIdx, toIdx) => {
      const [s] = WF.steps.splice(fromIdx, 1);
      WF.steps.splice(toIdx, 0, s);
      WF.steps.forEach((x, i) => { x.step_number = i + 1; });
    },
  };
}

// ────────────────────────────────────────────────────────────────
describe('WF.testerState is keyed by step id, not array index', () => {

  test('typed rows follow the step through a reorder', () => {
    const steps = [mkStep(101, 1), mkStep(102, 2), mkStep(103, 3)];
    const h = makeHarness(steps);

    // Open the tester on step id 102 (position 2) and type a variable.
    h.WF.activeStepIdx = 1;
    h.WF.activeStepId = 102;
    h.call('wfRenderTester', steps[1]);
    h.typeInto(0, 'contact_id', '4242');

    expect(h.WF.testerState[102]).toBeDefined();
    expect(h.WF.testerState[102].touched).toBe(true);
    expect(h.WF.testerState[102].rows).toEqual([{ key: 'contact_id', value: '4242' }]);
    // Nothing was stored against an index.
    expect(h.WF.testerState[1]).toBeUndefined();

    // Move step 102 to the top — it is now index 0 / step_number 1.
    h.reorder(1, 0);
    h.WF.activeStepIdx = 0;
    expect(h.WF.steps[0].id).toBe(102);
    expect(h.WF.steps[0].step_number).toBe(1);

    // Re-render the tester for the SAME step at its new position.
    h.call('wfRenderTester', h.WF.steps[0]);
    expect(h.domRows()).toEqual([{ key: 'contact_id', value: '4242' }]);
  });

  test('a reorder does not hand one step\'s rows to another', () => {
    const steps = [mkStep(101, 1), mkStep(102, 2), mkStep(103, 3)];
    const h = makeHarness(steps);

    h.WF.activeStepIdx = 1; h.WF.activeStepId = 102;
    h.call('wfRenderTester', steps[1]);
    h.typeInto(0, 'mine', 'step-102');

    // 102 moves to the top; 101 slides into index 1 — the slot 102 vacated.
    h.reorder(1, 0);
    const slid = h.WF.steps[1];
    expect(slid.id).toBe(101);

    h.WF.activeStepIdx = 1; h.WF.activeStepId = 101;
    h.call('wfRenderTester', slid);

    // Under index keying this rendered 102's typed row. It must not.
    expect(h.domRows()).not.toEqual([{ key: 'mine', value: 'step-102' }]);
    expect(h.WF.testerState[102].rows).toEqual([{ key: 'mine', value: 'step-102' }]);
  });

  test('untouched state re-seeds from config placeholders + test_input', () => {
    const steps = [mkStep(101, 1, { function_name: 'send_sms', params: { to: '{{phone}}' } })];
    const h = makeHarness(steps);
    h.WF.activeWf.test_input = { phone: '5551234', extra: 7 };

    h.WF.activeStepIdx = 0; h.WF.activeStepId = 101;
    h.call('wfRenderTester', steps[0]);

    const rows = h.domRows();
    expect(h.WF.testerState[101].touched).toBe(false);
    // Detected placeholder seeded, test_input value overriding, non-strings coerced.
    expect(rows).toEqual(expect.arrayContaining([
      { key: 'phone', value: '5551234' },
      { key: 'extra', value: '7' },
    ]));
  });

  test('add/remove row snapshot against the id anchor, not the index', () => {
    const steps = [mkStep(101, 1), mkStep(102, 2)];
    const h = makeHarness(steps);

    h.WF.activeStepIdx = 1; h.WF.activeStepId = 102;
    h.call('wfRenderTester', steps[1]);

    h.call('wfAddVarRow');
    expect(h.WF.testerState[102].rows.length).toBe(2);
    expect(h.WF.testerState[102].touched).toBe(true);

    const lastRow = h.window.document.querySelectorAll('#wf-editor-body .var-row')[1];
    h.call('wfRemoveVarRow', lastRow.querySelector('button'));
    expect(h.WF.testerState[102].rows.length).toBe(1);

    // activeStepIdx was 1 the whole time — nothing may be keyed there.
    expect(h.WF.testerState[1]).toBeUndefined();
  });

  test('wfSaveTesterState is a no-op on a null key rather than writing "null"', () => {
    const steps = [mkStep(101, 1)];
    const h = makeHarness(steps);
    h.WF.activeStepIdx = 0; h.WF.activeStepId = 101;
    h.call('wfRenderTester', steps[0]);

    h.call('wfSaveTesterState', null, true);
    expect(Object.keys(h.WF.testerState)).toEqual(['101']);
  });
});

// ────────────────────────────────────────────────────────────────
describe('wfSyncActiveStep re-derives the index from the id anchor', () => {

  test('follows the moved step to its new index', () => {
    const steps = [mkStep(101, 1), mkStep(102, 2), mkStep(103, 3)];
    const h = makeHarness(steps);
    h.WF.activeStepIdx = 2; h.WF.activeStepId = 103;

    h.reorder(2, 0);                       // 103 → top
    h.call('wfSyncActiveStep');

    expect(h.WF.activeStepIdx).toBe(0);
    expect(h.WF.steps[h.WF.activeStepIdx].id).toBe(103);
    expect(h.clearEditorCalls.length).toBe(0);
  });

  test('a stale index alone would select the wrong step — the anchor is what prevents it', () => {
    const steps = [mkStep(101, 1), mkStep(102, 2), mkStep(103, 3)];
    const h = makeHarness(steps);
    h.WF.activeStepIdx = 2; h.WF.activeStepId = 103;

    h.reorder(2, 0);
    // Pre-anchor behaviour: index 2 now holds step 102, NOT the moved 103.
    expect(h.WF.steps[2].id).toBe(102);

    h.call('wfSyncActiveStep');
    expect(h.WF.steps[h.WF.activeStepIdx].id).toBe(103);
  });

  test('drops the selection and clears the editor when the anchored step is gone', () => {
    const steps = [mkStep(101, 1), mkStep(102, 2)];
    const h = makeHarness(steps);
    h.WF.activeStepIdx = 1; h.WF.activeStepId = 102;

    h.WF.steps = [mkStep(101, 1)];         // 102 deleted elsewhere
    h.call('wfSyncActiveStep');

    expect(h.WF.activeStepId).toBeNull();
    expect(h.WF.activeStepIdx).toBeNull();
    expect(h.clearEditorCalls.length).toBe(1);
  });

  test('no anchor set → leaves the index alone', () => {
    const h = makeHarness([mkStep(101, 1)]);
    h.WF.activeStepIdx = 0; h.WF.activeStepId = null;
    h.call('wfSyncActiveStep');
    expect(h.WF.activeStepIdx).toBe(0);
    expect(h.clearEditorCalls.length).toBe(0);
  });

  test('wfStepIdxById resolves live ids and reports -1 for unknown ones', () => {
    const h = makeHarness([mkStep(101, 1), mkStep(102, 2)]);
    expect(h.call('wfStepIdxById', 102)).toBe(1);
    expect(h.call('wfStepIdxById', 999)).toBe(-1);
  });
});

// ────────────────────────────────────────────────────────────────
describe('the reload prune matches the shipped source', () => {
  // The prune lives inline in _loadWfSteps rather than in a named function, so
  // assert on its source text: it must compare STRING ids (object keys are
  // strings, step.id is a number — a Set of raw numbers would silently prune
  // every live entry on the next reload).
  test('prunes by String(id)', () => {
    expect(SCRIPT).toMatch(/const liveStepIds = new Set\(WF\.steps\.map\(s => String\(s\.id\)\)\);/);
    expect(SCRIPT).toMatch(/if \(!liveStepIds\.has\(k\)\) delete WF\.testerState\[k\];/);
  });

  test('the wholesale wipe on every steps reload is gone', () => {
    const loadFn = extractFn(SCRIPT, '_loadWfSteps');
    expect(loadFn).not.toMatch(/WF\.testerState = \{\}/);
  });
});
