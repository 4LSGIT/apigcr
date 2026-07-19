/**
 * tests/workflows.editor.roundtrip.test.js
 *
 * Render → gather round-trip for the metadata-driven internal_function editor
 * in public/automation/workflows.html.
 *
 * WHY THIS EXISTS
 * The save-time edit-lock slice made three value shapes legal at save that the
 * validator used to 400: a {{placeholder}} on a numeric param, an object on a
 * string param, and a non-string scalar (number / boolean / explicit null) on a
 * string param. Every one of those shapes is CARRIED BY A LIVE WORKFLOW STEP —
 * and unlocking the server is only half the job, because the editor's own
 * render→gather cycle silently rewrote several of them. Those clobbers were
 * unreachable while the steps were unsaveable; unlocking save is exactly what
 * makes them reachable. So this suite pins the round-trip.
 *
 * The four clobbers it guards (each fails against the pre-slice HTML):
 *   1. <input type="number"> runs the HTML value-sanitization algorithm and
 *      BLANKS a non-numeric value, so "{{attorney_user_id}}" rendered as an
 *      empty field and gather's empty-field rule then DELETED the key.
 *      (wf7 s3 — create_appointment.appt_with.)
 *   2. A number on a string param round-tripped through String() as "5".
 *      Harmless for set_next itself, but it rewrites every stored step target.
 *      (wf1/2/15/16 — set_next.value.)
 *   3. A boolean on a string param round-tripped as "true" — which INVERTS the
 *      branch, since evaluateSingle compares with `==` and `true == "true"` is
 *      false in JS. (wf15 s1 / wf16 s1 — evaluate_condition.value.)
 *   4. An explicit null on a nullishSkipsBlock param rendered as an empty field
 *      and gather DELETED the key — turning set_next's "end the workflow"
 *      into a silent fall-through to the next step. (wf28 s6 — set_next.value.)
 *
 * MECHANICS
 * workflows.html is a single 2,900-line inline <script> whose top level does
 * boot work (P = window.parent, api(), init fetches). Evaluating the whole file
 * in jsdom would need the entire shell stubbed, so instead we extract just the
 * functions under test by brace-matching on their source text and evaluate THOSE
 * against a jsdom document. That keeps the test honest — it runs the shipped
 * code, not a copy — while depending on nothing but the two function bodies.
 *
 * jsdom implements input value-sanitization faithfully (verified: a number input
 * with value="{{x}}" reports .value === ''), which is what makes clobber #1
 * actually reproducible here rather than vacuously passing.
 *
 *   npx jest tests/workflows.editor.roundtrip.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'public', 'automation', 'workflows.html');
const internalFunctions = require('../lib/internal_functions');

// ── Extract named function sources from the inline <script> ─────────────
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`workflows.html: function ${name} not found — did it get renamed?`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
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

// Pulled verbatim from the shipped file. If any of these are renamed or their
// braces stop balancing, extractFn throws and this suite fails loudly rather
// than silently testing nothing.
const SOURCES = [
  'const WF_PLACEHOLDER_RE = ' + (SCRIPT.match(/const WF_PLACEHOLDER_RE = (.+);/) || [])[1] + ';',
  extractFn(SCRIPT, 'esc'),
  extractFn(SCRIPT, 'wfRenderParamField'),
  extractFn(SCRIPT, 'wfGatherConfig'),
].join('\n\n');

/**
 * Build a jsdom sandbox holding the real render + gather, wired to a fake
 * editor DOM. Returns a harness that mimics one open-edit-save cycle.
 */
function makeEditor(fnName, storedParams) {
  const meta = internalFunctions.__getMeta(fnName);
  if (!meta) throw new Error(`no __meta for ${fnName}`);

  const dom = new JSDOM('<body><div id="host"></div></body>');
  const { window } = dom;
  const swalCalls = [];

  const ctx = vm.createContext({
    document: window.document,
    window,
    P: {},                                   // parent shell helpers — no widget specs in play
    Swal: { fire: (...a) => swalCalls.push(a) },
    FUNCTIONS: { meta: { [fnName]: meta } },
    WF: {
      jsonMode: false,
      // Deep clone: gather seeds from this (keep-then-overwrite), and we want
      // to prove the ROUND-TRIP, not that gather handed our own object back.
      origConfig: JSON.parse(JSON.stringify({ function_name: fnName, params: storedParams })),
    },
  });
  vm.runInContext(SOURCES, ctx);

  // Render every param field the way wfRenderInternalFnBody does, inside the
  // #e-fn-body-inner wrapper gather reads the active mode from.
  const mode = firstPopulatedMode(meta, storedParams);
  const fields = meta.params
    .map(spec => ctx.wfRenderParamField(spec, storedParams[spec.name], !spec.modeGroup || spec.modeGroup === mode))
    .join('');
  window.document.getElementById('host').innerHTML =
    `<input id="e-fn" value="${fnName}">` +
    `<div id="e-fn-body-inner" data-mode="${mode || ''}">${fields}</div>`;

  return {
    ctx,
    window,
    swalCalls,
    field: (name) => window.document.getElementById(`e-pf-${name}`),
    gather: () => ctx.wfGatherConfig('internal_function'),
  };
}

// Mirrors _wfDetectMode's contract closely enough for the specs under test.
function firstPopulatedMode(meta, params) {
  const modes = [...new Set(meta.params.filter(p => p.modeGroup).map(p => p.modeGroup))];
  if (!modes.length) return null;
  for (const m of modes) {
    const inMode = meta.params.filter(p => p.modeGroup === m);
    const populated = inMode.some(p => (p.nullishSkipsBlock ? p.name in params
      : params[p.name] !== undefined && params[p.name] !== null && params[p.name] !== ''));
    if (populated) return m;
  }
  return modes[0];
}

// The live configs this slice unlocked, verbatim from the readonly SQL sweep.
const WF7_S3 = {
  contact_id: '{{primary_contact_id}}',
  case_id: '{{link_id}}',
  appt_date: '{{new_control_datetime}}',
  appt_type: '341 Meeting',
  appt_length: 15,
  appt_platform: 'Telephone',
  appt_with: '{{attorney_user_id}}',
};
const WF15_S1 = { variable: 'needs_fetch', operator: '==', value: true, then: 2, else: 4 };
const WF15_S5 = { variable: 'matchCount', operator: '==', value: 1, then: 6, else: 7 };
const WF17_S1_DATA = { direction: 'incoming', attachments: '{{attachments}}' };

describe('workflows.html editor — the render step itself', () => {
  test('a {{placeholder}} on an integer param is NOT rendered into a number input', () => {
    // The bug, stated precisely: <input type="number" value="{{attorney_user_id}}">
    // reports .value === '' because of HTML value sanitization. Assert both that
    // we avoided the number input AND that the value actually survives read-back
    // — the second assertion is the one that would have caught the original.
    const ed = makeEditor('create_appointment', WF7_S3);
    const el = ed.field('appt_with');
    expect(el.getAttribute('type')).not.toBe('number');
    expect(el.value).toBe('{{attorney_user_id}}');
  });

  test('jsdom really does sanitize number inputs (guards against a vacuous test)', () => {
    // If this ever starts passing "{{x}}" through, the test above proves nothing
    // and this row tells us why.
    const { window } = new JSDOM('<body></body>');
    window.document.body.innerHTML = '<input id="n" type="number" value="{{x}}">';
    expect(window.document.getElementById('n').value).toBe('');
  });

  test('a genuinely numeric integer param still gets a number input', () => {
    const ed = makeEditor('create_appointment', WF7_S3);
    const el = ed.field('appt_length');
    expect(el.getAttribute('type')).toBe('number');
    expect(el.value).toBe('15');
  });
});

describe('workflows.html editor — render → gather round-trip (untouched form)', () => {
  // The core contract: opening a step and hitting Save without typing anything
  // must return the config BYTE-IDENTICAL. Anything else is a silent clobber.
  const cases = [
    ['wf7 s3   create_appointment {{placeholder}} on integer appt_with', 'create_appointment', WF7_S3],
    ['wf15 s1  evaluate_condition boolean operand',                      'evaluate_condition', WF15_S1],
    ['wf15 s5  evaluate_condition numeric operand',                      'evaluate_condition', WF15_S5],
    ['wf1 s1   set_next numeric target',                                 'set_next', { value: 3 }],
    ['wf28 s6  set_next explicit null (= end workflow)',                 'set_next', { value: null }],
    ['         set_next cancel',                                         'set_next', { value: 'cancel' }],
    ['wf17 s1  phone_log object data + object extra',                    'phone_log', {
      type: 'sms', link_type: 'phone', link_id: '{{their_number}}', by: 0,
      direction: 'incoming', from: '{{from}}', to: '{{to}}', message: '{{body}}',
      data: WF17_S1_DATA, extra: { provider: 'quo', message_id: '{{message_id}}' },
    }],
    ['wf15 s8  create_log {{placeholder}} enums + object data',          'create_log', {
      type: 'sms', link_type: '{{link_type}}', link_id: '{{link_id}}', by: 0,
      direction: '{{direction}}', data: { direction: '{{direction}}', attachments: '{{attachments}}' },
    }],
  ];

  test.each(cases)('%s', (_label, fnName, stored) => {
    const ed = makeEditor(fnName, stored);
    const cfg = ed.gather();

    expect(ed.swalCalls).toEqual([]);          // no error toast
    expect(cfg).not.toBeNull();
    expect(cfg.params).toEqual(stored);        // deep equality, types included

    // toEqual would let a number through where a boolean is expected? No — but
    // it WOULD let `5` pass for `"5"`? Also no. Belt-and-braces anyway: assert
    // the JSON serialization matches, which is what actually lands in the DB.
    expect(JSON.stringify(cfg.params)).toBe(JSON.stringify(stored));

    // And the whole thing must still SAVE — the round-trip is worthless if the
    // gathered config then 400s at the route.
    expect(internalFunctions.__validateFunctionParams(fnName, cfg.params)).toBeNull();
  });
});

describe('workflows.html editor — gather still coerces and still rejects', () => {
  test('editing a numeric field yields a number, not a string', () => {
    const ed = makeEditor('create_appointment', WF7_S3);
    ed.field('appt_length').value = '30';
    expect(ed.gather().params.appt_length).toBe(30);
  });

  test('typing garbage into an integer field still errors', () => {
    const ed = makeEditor('create_appointment', WF7_S3);
    ed.field('appt_with').value = 'rena';
    expect(ed.gather()).toBeNull();
    expect(ed.swalCalls[0][1]).toContain('must be an integer');
  });

  test('typing a NEW placeholder into an integer field passes through verbatim', () => {
    const ed = makeEditor('create_appointment', WF7_S3);
    ed.field('appt_with').value = '{{other_user_id}}';
    expect(ed.gather().params.appt_with).toBe('{{other_user_id}}');
  });

  test('editing a boolean operand to real text yields a string', () => {
    // The type-preserving path is "user did not touch the field". Once they do,
    // the normal string path applies — `true` becomes `"confirmed"`, not a
    // boolean, and that is correct.
    const ed = makeEditor('evaluate_condition', WF15_S1);
    ed.field('value').value = 'confirmed';
    expect(ed.gather().params.value).toBe('confirmed');
  });

  test('clearing a normal field still deletes the key', () => {
    const ed = makeEditor('create_appointment', WF7_S3);
    ed.field('note').value = '';
    ed.field('case_id').value = '';
    const cfg = ed.gather();
    expect('case_id' in cfg.params).toBe(false);
  });

  test('out-of-schema keys survive a form save (extra, _comment)', () => {
    // Regression gate for the keep-then-overwrite seeding — `extra` is rendered
    // (it is in meta) but `_comment` is a top-level config key the form never
    // sees, and wf15 s1 / wf16 s1 both carry one.
    const ed = makeEditor('evaluate_condition', WF15_S1);
    ed.ctx.WF.origConfig._comment = 'Phase 2 gate: RC outbound events set needs_fetch=true.';
    const cfg = ed.gather();
    expect(cfg._comment).toBe('Phase 2 gate: RC outbound events set needs_fetch=true.');
  });
});
