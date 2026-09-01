/**
 * tests/esignTplPanel.purpose.test.js
 *
 * public/automation/esignTplPanel.js driven by public/automation/workflows.html
 * for BOTH functions it now serves.
 *
 * WHY THIS EXISTS
 *
 * G3 gave workflows.html a SECOND instance of the template-fields panel, for
 * `document_generate_from_template`, and both instances address the SAME DOM
 * ids (`#e-etpl-panel`, `#e-pf-template_id`, `#e-pf-values`). That is safe
 * because of an invariant nothing in the codebase asserts: the editor renders
 * exactly ONE internal-function form at a time, so there is only ever one
 * panel on screen, and each instance's `fnName` guard makes the other inert.
 *
 * An invariant nothing asserts is an invariant waiting to be broken by someone
 * who has no way to know it exists. Concretely, the failure this suite is here
 * to catch is: the generate panel repainting over the esign panel (or vice
 * versa) and offering the wrong templates for the step being edited — which
 * would look like a working picker right up until the step ran and the service
 * refused the template with ESIGN_TEMPLATE_PURPOSE.
 *
 * It also pins the purpose filter itself. The two functions differ ONLY in
 * which templates they may offer (contract_templates.purpose; 'both' counts
 * for either), and each service refuses the other surface's templates
 * outright — so a panel offering the unfiltered list is a picker that can only
 * lead the author into a 409.
 *
 * MECHANICS
 * Same posture as tests/workflows.editor.roundtrip.test.js: extract the
 * functions under test from the shipped inline <script> by brace-matching, run
 * them against jsdom, and load the REAL panel module. Nothing here is a copy.
 *
 *   npx jest tests/esignTplPanel.purpose.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/automation/workflows.html'), 'utf8');
const SEQUENCES = fs.readFileSync(path.join(ROOT, 'public/automation/sequences.html'), 'utf8');
const SCRIPT = HTML.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const PANEL = fs.readFileSync(path.join(ROOT, 'public/automation/esignTplPanel.js'), 'utf8');
const PARAM_WIDGETS = fs.readFileSync(path.join(ROOT, 'public/automation/paramWidgets.js'), 'utf8');
const internalFunctions = require('../lib/internal_functions');

const ESIGN_FN = 'esign_send_from_template';
const GEN_FN = 'document_generate_from_template';

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(`workflows.html: function ${name} not found — did it get renamed?`);
  }
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`workflows.html: unbalanced braces in ${name}`);
}

const TEMPLATES = {
  esign: [{ id: 3, name: 'Fee Agreement', kind: 'retainer', prefill_schema: [] }],
  generate: [{ id: 8, name: 'Notice of Hearing', kind: 'notice', prefill_schema: [] }],
};

/**
 * Boot the real render + the real panel module against a jsdom editor.
 * @param {string} fnName which step the editor is showing
 */
function boot(fnName, params = { template_id: null }) {
  const dom = new JSDOM('<body><div id="host"></div></body>');
  const { window } = dom;
  const requested = [];

  const ctx = vm.createContext({
    document: window.document, window, console,
    P: {}, Swal: { fire() {} },
    Event: window.Event, CustomEvent: window.CustomEvent,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    FUNCTIONS: { meta: internalFunctions.__getAllMeta() },
    WF: { jsonMode: false, origConfig: {} },
    api: async (url) => {
      requested.push(url);
      if (url.includes('purpose=generate')) return { templates: TEMPLATES.generate };
      if (url.includes('purpose=esign')) return { templates: TEMPLATES.esign };
      if (/\/templates\/(\d+)$/.test(url)) {
        const id = Number(url.match(/\/templates\/(\d+)$/)[1]);
        const all = [...TEMPLATES.esign, ...TEMPLATES.generate];
        return { template: all.find(t => t.id === id) || { notFound: true } };
      }
      return { templates: [] };
    },
  });

  vm.runInContext(PARAM_WIDGETS, ctx);
  vm.runInContext([
    'const WF_PLACEHOLDER_RE = ' + (SCRIPT.match(/const WF_PLACEHOLDER_RE = (.+);/) || [])[1] + ';',
    extractFn(SCRIPT, 'esc'),
    extractFn(SCRIPT, 'wfRenderParamField'),
    extractFn(SCRIPT, '_wfDetectMode'),
    extractFn(SCRIPT, '_wfHumanizeMode'),
    extractFn(SCRIPT, 'wfRenderInternalFnBody'),
    extractFn(SCRIPT, 'wfWireEsignTplPanel'),
    extractFn(SCRIPT, 'wfWireDocTplPanel'),
    'let WF_ETPL = null; let WF_DTPL = null;',
  ].join('\n\n'), ctx);
  vm.runInContext(PANEL, ctx);

  ctx.__fn = fnName;
  ctx.__params = params;
  const body = vm.runInContext('wfRenderInternalFnBody(__fn, __params)', ctx);
  window.document.getElementById('host').innerHTML =
    `<select id="e-fn"><option value="${fnName}" selected>x</option></select>` + body;

  return {
    ctx, window, body, requested,
    panel: () => window.document.getElementById('e-etpl-panel'),
    setFn: (v) => {
      window.document.getElementById('e-fn').innerHTML =
        `<option value="${v}" selected>x</option>`;
    },
    settle: () => new Promise(r => window.setTimeout(r, 350)),
  };
}

describe('the editor mounts the panel for BOTH template-driven functions', () => {
  for (const fn of [ESIGN_FN, GEN_FN]) {
    test(`${fn} mounts #e-etpl-panel directly under template_id`, () => {
      const ed = boot(fn);
      expect(ed.body).toContain('id="e-etpl-panel"');
      expect(ed.body.indexOf('e-pf-template_id'))
        .toBeLessThan(ed.body.indexOf('id="e-etpl-panel"'));
    });

    test(`${fn} renders the values textarea the panel two-way syncs with`, () => {
      const ed = boot(fn);
      expect(ed.window.document.getElementById('e-pf-values')).toBeTruthy();
    });
  }

  test('a function with no template_id gets no panel', () => {
    const ed = boot('send_sms', { to: '{{phone}}', body: 'hi' });
    expect(ed.body).not.toContain('id="e-etpl-panel"');
  });
});

describe('each instance offers only the templates its own service accepts', () => {
  test('the generate step asks for ?purpose=generate and shows that list', async () => {
    const ed = boot(GEN_FN, { template_id: 8 });
    vm.runInContext('wfWireDocTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.requested).toContain('/api/esign/templates?purpose=generate');
    expect(ed.requested).not.toContain('/api/esign/templates?purpose=esign');
    expect(ed.panel().innerHTML).toContain('Notice of Hearing');
    expect(ed.panel().innerHTML).not.toContain('Fee Agreement');
  });

  test('the esign step asks for ?purpose=esign and shows that list', async () => {
    const ed = boot(ESIGN_FN, { template_id: 3 });
    vm.runInContext('wfWireEsignTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.requested).toContain('/api/esign/templates?purpose=esign');
    expect(ed.requested).not.toContain('/api/esign/templates?purpose=generate');
    expect(ed.panel().innerHTML).toContain('Fee Agreement');
    expect(ed.panel().innerHTML).not.toContain('Notice of Hearing');
  });

  test('neither ever requests the unfiltered list', async () => {
    for (const [fn, wire] of [[GEN_FN, 'wfWireDocTplPanel'], [ESIGN_FN, 'wfWireEsignTplPanel']]) {
      const ed = boot(fn, { template_id: null });
      vm.runInContext(`${wire}();`, ed.ctx);
      await ed.settle();
      expect(ed.requested).not.toContain('/api/esign/templates');
    }
  });
});

describe('THE SHARED-ID CONTRACT — the two instances must not fight', () => {
  // Both instances address #e-etpl-panel. The guard that keeps them apart is
  // each one's own fnName, checked against #e-fn on every render.
  test('the generate instance goes inert when the editor shows the esign step', async () => {
    const ed = boot(GEN_FN, { template_id: 8 });
    vm.runInContext('wfWireDocTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.panel().style.display).not.toBe('none');

    ed.setFn(ESIGN_FN);
    vm.runInContext('wfWireDocTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.panel().style.display).toBe('none');
  });

  test('the esign instance goes inert when the editor shows the generate step', async () => {
    const ed = boot(ESIGN_FN, { template_id: 3 });
    vm.runInContext('wfWireEsignTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.panel().style.display).not.toBe('none');

    ed.setFn(GEN_FN);
    vm.runInContext('wfWireEsignTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.panel().style.display).toBe('none');
  });

  test('an inert instance does not even fetch — it bails before the list load', async () => {
    // Cheapness is the point: the guard runs before loadList, so an editor
    // that never touches these steps pays nothing for either instance.
    const ed = boot(GEN_FN, { template_id: 8 });
    ed.setFn('send_sms');
    vm.runInContext('wfWireDocTplPanel(); wfWireEsignTplPanel();', ed.ctx);
    await ed.settle();
    expect(ed.requested).toEqual([]);
  });
});

describe('the invariant the shared ids rest on', () => {
  test('the editor emits exactly ONE #e-fn-body-inner per render', () => {
    // If a render could ever produce two internal-function forms, the shared
    // panel id would collide for real and the guard above would not save it.
    for (const fn of [ESIGN_FN, GEN_FN]) {
      const ed = boot(fn, { template_id: 1 });
      expect((ed.body.match(/id="e-fn-body-inner"/g) || []).length).toBe(1);
      expect((ed.body.match(/id="e-etpl-panel"/g) || []).length).toBe(1);
    }
  });

  test('the two wire calls are mutually exclusive branches on one fnName', () => {
    expect(SCRIPT).toContain(`if (fnName === '${ESIGN_FN}') setTimeout(wfWireEsignTplPanel, 0);`);
    expect(SCRIPT).toContain(`if (fnName === '${GEN_FN}') setTimeout(wfWireDocTplPanel, 0);`);
  });
});

describe('sequences.html deliberately has no counterpart', () => {
  test('document_generate_from_template is workflowOnly, so it is not sequence-eligible', () => {
    // The panel is absent from sequences.html because the FUNCTION is: chromium
    // renders serialize on the 1GiB container, so a sequence fanning this out
    // across a contact list would queue-stack them. routes/workflows.js filters
    // the sequence picker on this flag, so a panel there could never be reached.
    expect(internalFunctions.__getMeta(GEN_FN).workflowOnly).toBe(true);
    expect(SEQUENCES).not.toContain(GEN_FN);
  });

  test('but the esign panel IS still wired there', () => {
    expect(SEQUENCES).toContain('se-etpl-panel');
    expect(SEQUENCES).toContain(ESIGN_FN);
  });
});
