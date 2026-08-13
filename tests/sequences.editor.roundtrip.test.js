/**
 * tests/sequences.editor.roundtrip.test.js
 *
 * Render → gather round-trip for the metadata-driven internal_function editor
 * in public/automation/sequences.html.
 *
 * WHY THIS EXISTS
 * sequences.html carries a near-copy of workflows.html's param editor, and it
 * has demonstrably DRIFTED from it before. The sequence renderer's own comment
 * records the last time:
 *
 *   "workflows.html's renderer fixed this ('open wf7 s3, save, and
 *    {{attorney_user_id}} is gone'); this is the same fix, which the sequence
 *    editor had never inherited — found when the seeded esign_remind step's
 *    {{trigger_data.signing_request_id}} rendered as a blank id field."
 *
 * That bug lived only because workflows.html had a round-trip suite and this
 * page had none. The {{placeholder}}-toggle slice (paramWidgets.js) touches the
 * same three functions in both files, so this suite exists to make the next
 * divergence fail in CI rather than in production.
 *
 * MECHANICS
 * Identical to tests/workflows.editor.roundtrip.test.js: sequences.html is one
 * huge inline <script> whose top level does boot work, so the functions under
 * test are extracted by brace-matching on their source text and evaluated
 * against a jsdom document. The shipped code runs, not a copy.
 *
 *   npx jest tests/sequences.editor.roundtrip.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'public', 'automation', 'sequences.html');
const internalFunctions = require('../lib/internal_functions');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`sequences.html: function ${name} not found — did it get renamed?`);
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
  throw new Error(`sequences.html: unbalanced braces in ${name}`);
}

function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*(.+);`));
  if (!m) throw new Error(`sequences.html: const ${name} not found`);
  return `const ${name} = ${m[1]};`;
}

const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const SCRIPT = HTML.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

// The {{placeholder}}-toggle module the page loads via <script src>. Read from
// disk so the suite exercises the SHIPPED widget — seqRenderParamField guards
// on `typeof window.pwHandles === 'function'`, so omitting it here would fall
// back to the old type-driven switch and the toggle tests would pass vacuously.
const PARAM_WIDGETS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'automation', 'paramWidgets.js'), 'utf8');

const SOURCES = [
  extractConst(SCRIPT, 'SEQ_PLACEHOLDER_RE'),
  extractConst(SCRIPT, 'SEQ_HIDDEN_PARAMS'),
  extractConst(SCRIPT, 'SEQ_HIDE_SETVARS_FIELD'),
  extractFn(SCRIPT, 'esc'),
  extractFn(SCRIPT, 'seqRenderParamField'),
  extractFn(SCRIPT, 'seqGatherActionConfig'),
].join('\n\n');

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
    SEQ: {
      jsonMode: false,
      origConfig: JSON.parse(JSON.stringify({ function_name: fnName, params: storedParams })),
    },
    // pwToggle dispatches synthetic input/change events and a pw:swap CustomEvent.
    Event: window.Event,
    CustomEvent: window.CustomEvent,
  });
  vm.runInContext(PARAM_WIDGETS, ctx);
  vm.runInContext(SOURCES, ctx);

  const fields = meta.params
    .map(spec => ctx.seqRenderParamField(spec, storedParams[spec.name], true))
    .join('');
  window.document.getElementById('host').innerHTML =
    `<select id="se-fn"><option selected>${fnName}</option></select>` +
    `<div id="se-fn-body-inner" data-mode="">${fields}</div>`;

  return {
    ctx,
    window,
    swalCalls,
    field:  (name) => window.document.getElementById(`se-pf-${name}`),
    tog:    (name) => window.document.querySelector(`.pw-tog[data-pw-for="se-pf-${name}"]`),
    toggle: (name) => ctx.window.pwToggle(`se-pf-${name}`),
    gather: () => ctx.seqGatherActionConfig('internal_function'),
  };
}

const APPT = {
  contact_id: '{{contactId}}', appt_date: '{{apptDate}}', appt_type: '341 Meeting',
  appt_length: 15, appt_platform: 'Telephone', appt_with: '{{attorney_user_id}}',
};

describe('sequences.html editor — render', () => {
  test('a stored {{placeholder}} on an integer param survives read-back', () => {
    // The drift this page suffered once already: <input type="number"
    // value="{{attorney_user_id}}"> reports .value === '' and gather's
    // empty-field rule then DELETES the key.
    const ed = makeEditor('create_appointment', APPT);
    const el = ed.field('appt_with');
    expect(el.getAttribute('type')).not.toBe('number');
    expect(el.value).toBe('{{attorney_user_id}}');
  });

  test('a genuinely numeric integer param still gets a number input', () => {
    const ed = makeEditor('create_appointment', APPT);
    expect(ed.field('appt_length').getAttribute('type')).toBe('number');
    expect(ed.field('appt_length').value).toBe('15');
  });
});

describe('sequences.html editor — round-trip (untouched form)', () => {
  const cases = [
    ['create_appointment {{placeholder}} on integer appt_with', 'create_appointment', APPT],
    ['create_task integer + enum tokens', 'create_task', {
      title: 'Signed doc received: {{agreementName}}', source: 'adobe_sign',
      link_id: '{{linkId}}', link_type: '{{linkType}}', contact_id: '{{contactId}}',
      assigned_by: 0, assigned_to: '{{alertUserId}}', send_assignment_email: false,
    }],
    ['create_log {{placeholder}} enums + object data', 'create_log', {
      type: 'sms', link_type: '{{link_type}}', link_id: '{{link_id}}', by: 0,
      direction: '{{direction}}', data: { direction: '{{direction}}' },
    }],
  ];

  test.each(cases)('%s', (_label, fnName, stored) => {
    const ed = makeEditor(fnName, stored);
    const cfg = ed.gather();
    expect(ed.swalCalls).toEqual([]);
    expect(cfg).not.toBeNull();
    expect(JSON.stringify(cfg.params)).toBe(JSON.stringify(stored));
    expect(internalFunctions.__validateFunctionParams(fnName, cfg.params)).toBeNull();
  });
});

describe('sequences.html editor — {{placeholder}} toggle (paramWidgets.js)', () => {
  test('placeholderAllowed integer gets a toggle; unflagged integer does not', () => {
    const ed = makeEditor('create_task', { title: 't', assigned_to: 6 });
    expect(ed.tog('assigned_to')).not.toBeNull();
    expect(ed.field('assigned_to').getAttribute('type')).toBe('number');

    const ed2 = makeEditor('query_db', { from: 'contacts', limit: 10 });
    expect(ed2.tog('limit')).toBeNull();
  });

  test('integer: number box → toggle → {{token}} → gathers and validates', () => {
    const ed = makeEditor('create_task', { title: 't', assigned_to: 6 });
    ed.toggle('assigned_to');
    expect(ed.field('assigned_to').getAttribute('type')).not.toBe('number');
    ed.field('assigned_to').value = '{{alertUserId}}';

    const cfg = ed.gather();
    expect(ed.swalCalls).toEqual([]);
    expect(cfg.params.assigned_to).toBe('{{alertUserId}}');
    expect(internalFunctions.__validateFunctionParams('create_task', cfg.params)).toBeNull();
  });

  test('enum: select → toggle → {{token}} → gathers and validates', () => {
    const ed = makeEditor('create_task', { title: 't', assigned_to: 6, link_type: 'case' });
    expect(ed.field('link_type').tagName).toBe('SELECT');
    ed.toggle('link_type');
    expect(ed.field('link_type').tagName).toBe('INPUT');
    ed.field('link_type').value = '{{linkType}}';

    const cfg = ed.gather();
    expect(ed.swalCalls).toEqual([]);
    expect(cfg.params.link_type).toBe('{{linkType}}');
    expect(internalFunctions.__validateFunctionParams('create_task', cfg.params)).toBeNull();
  });

  test('numeric toggle keeps the SAME node — esignTplPanel binds to #se-pf-template_id', () => {
    const ed = makeEditor('esign_send_from_template', {
      template_id: 3, linkable_type: 'case', linkable_id: '{{caseId}}',
    });
    const before = ed.field('template_id');
    let fired = 0;
    before.addEventListener('input', () => { fired++; });
    ed.toggle('template_id');
    expect(ed.field('template_id')).toBe(before);
    expect(fired).toBe(1);
  });

  test('toggling out of placeholder mode stashes the token; toggling back restores it', () => {
    const ed = makeEditor('create_appointment', APPT);
    ed.toggle('appt_with');
    expect(ed.field('appt_with').getAttribute('type')).toBe('number');
    expect(ed.field('appt_with').value).toBe('');
    ed.toggle('appt_with');
    expect(ed.field('appt_with').value).toBe('{{attorney_user_id}}');
  });
});

describe('sequences.html editor — gather still coerces and still rejects', () => {
  test('editing a numeric field yields a number, not a string', () => {
    const ed = makeEditor('create_appointment', APPT);
    ed.field('appt_length').value = '30';
    expect(ed.gather().params.appt_length).toBe(30);
  });

  test('typing garbage into an integer field still errors', () => {
    const ed = makeEditor('create_appointment', APPT);
    ed.field('appt_with').value = 'rena';
    expect(ed.gather()).toBeNull();
    expect(ed.swalCalls[0][1]).toContain('must be an integer');
  });

  test('unparseable non-placeholder text on a structured param still errors', () => {
    const ed = makeEditor('create_log', { type: 'note', extra: {} });
    ed.field('extra').value = 'not json at all';
    expect(ed.gather()).toBeNull();
    expect(ed.swalCalls[0][1]).toContain('is not valid JSON');
  });
});
