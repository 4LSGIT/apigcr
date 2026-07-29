/**
 * Slice 2.5A verification — render.html + the one approved yc-forms.js change
 * (checkgroup fallback / includes op in _evaluateConditionals) + the
 * formTemplateService validation additions.
 *
 * Same harness style as formRender.slice2.test.js: jsdom INTEGRATION tests
 * against the REAL files (render.html with runScripts:'dangerously', the real
 * /js/yc-forms.js via ResourceLoader, apiSend stubbed per test).
 *
 * Covers (SLICE_2_5_SPEC.md + addendum):
 *   A1 $load prefill: case path, filtered array path, miss-skip, object-skip,
 *      ifEmpty vs always, before-resolver ordering, preview-with-link_id runs,
 *      clean baseline
 *   A2 requiredWhen: single + AND array compiled to validation.custom; save
 *      blocked with a VISIBLE .yc-error only while the condition holds
 *   A3 includes op: attr emission, live visibility off a checkgroup (incl.
 *      Other free text); AND arrays: .ycr-and-wrap nesting + composed
 *      visibility; single-condition emission unchanged
 *   A4/A5/A1 validation: per-repeater name scoping, repeater-key namespace,
 *      includes-target checkgroup rule, condition arrays, $load grammar,
 *      columns 1–3 checkgroup-only
 *   A5 rendering: inline grid-template-columns (1 → "1fr", 2 → repeat)
 *
 *   npx jest tests/formRender.slice25A.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const svc         = require(path.join(ROOT, 'services/formTemplateService.js'));

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p.startsWith('/forms/hooks/')) return Promise.reject(new Error('404 ' + p));
    return Promise.resolve(Buffer.from(''));
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

/** A 2.5A-exercising definition (case-linked). */
function makeDef(overrides) {
  return Object.assign({
    dataMode: 'live',
    autosave: false,
    endpoints: { load: { method: 'GET', url: '/api/cases/{linkId}?include=clients,appts', path: 'case' } },
    onSubmit: {},
    sections: [
      { title: 'Main', rows: [
        { fields: [
          { name: 'debtor_name',   type: 'text', label: 'Client',
            prefill: '$load.clients[relate_type=Primary].contact_name', readonly: true },
          { name: 'codebtor_name', type: 'text', label: 'Secondary',
            prefill: '$load.clients[relate_type=Secondary].contact_name', readonly: true },
          { name: 'trustee',       type: 'text', label: 'Trustee',
            prefill: '$load.case.case_trustee' },
          { name: 'always_docket', type: 'text', label: 'Docket',
            prefill: '$load.case.case_number_full', prefillMode: 'always' },
          { name: 'miss_path',     type: 'text', label: 'Missing',
            prefill: '$load.case.not_a_column' },
          { name: 'object_path',   type: 'text', label: 'Object',
            prefill: '$load.case' },
        ] },
        { fields: [
          { name: 'outcome', type: 'select', options: ['Completed', 'Continued'] },
          { name: 'appearance_required', type: 'select', options: ['YES', 'NO'],
            requiredWhen: { field: 'outcome', op: 'eq', value: 'Continued' } },
          { name: 'new_control_datetime', type: 'text',
            requiredWhen: [
              { field: 'outcome', op: 'eq', value: 'Continued' },
              { field: 'appearance_required', op: 'eq', value: 'YES' },
            ],
            requiredMessage: 'Set the new control date' },
        ] },
        { fields: [
          { name: 'issues', type: 'checkgroup', columns: 1, allowOther: true,
            options: ['Garnishment', 'Repossession', 'Foreclosure'] },
          { name: 'two_col', type: 'checkgroup', columns: 2, options: ['A', 'B'] },
          { name: 'marital_status', type: 'select', options: ['Single', 'Married', 'Separated'] },
        ] },
      ] },
      { title: 'Garnishment Details',
        showWhen: { field: 'issues', op: 'includes', value: ['Garnishment', 'Repossession'] },
        rows: [ { fields: [ { name: 'garn_notes', type: 'text' } ] } ] },
      { title: 'Codebtor AND Demo', rows: [
        { fields: [
          { name: 'is_codebtor', type: 'select', options: ['Yes', 'No'] },
          { name: 'codebtor_ssn', type: 'text',
            showWhen: [
              { field: 'marital_status', op: 'in', value: ['Married', 'Separated'] },
              { field: 'is_codebtor', op: 'eq', value: 'Yes' },
            ] },
        ] },
      ] },
    ],
  }, overrides || {});
}

const CASE_ROW = {
  case_id: 'CASETEST1', case_trustee: 'Timothy Miller', case_number_full: '24-48734-mlo',
};
const CLIENTS = [
  { contact_id: 11, relate_type: 'Primary',   contact_name: 'Jane Debtor' },
  { contact_id: 12, relate_type: 'Secondary', contact_name: 'John Codebtor' },
];

function bootPage(opts = {}) {
  const def    = opts.definition || makeDef();
  const linkId = opts.linkId !== undefined ? opts.linkId : 'CASETEST1';
  const calls  = [];
  const order  = [];
  const url = opts.preview
    ? 'https://app.test/forms/render.html?template_id=9&preview=1' + (opts.previewLinkId ? '&link_id=' + opts.previewLinkId : '')
    : 'https://app.test/forms/render.html?form_key=slice25a_test&case_id=' + encodeURIComponent(linkId);

  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: '2.5A Test', link_type: 'case', schema_version: 1, definition: def };
    }
    if (u.startsWith('/api/form-templates/')) {   // preview fetch
      return { status: 'success', template: { form_key: 'slice25a_test', title: '2.5A Test',
               link_type: 'case', schema_version: 1, draft_definition: def } };
    }
    if (u.startsWith('/api/cases/')) {
      order.push('load');
      return { case: opts.caseRow || CASE_ROW, clients: opts.clients || CLIENTS, appts: [] };
    }
    if (u.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
    if (u === '/resolve') {
      order.push('resolve');
      return { status: 'success', text: opts.resolveText !== undefined ? opts.resolveText : '', unresolved: [] };
    }
    if (u === '/api/forms/submit') { order.push('submit'); return { id: 91, version: 1, updated_at: new Date().toISOString() }; }
    if (u.startsWith('/api/forms/draft')) return {};
    if (u === '/api/log') return {};
    throw new Error('unstubbed apiSend: ' + method + ' ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend  = apiSend;
      window.__order  = order;
    },
  });
  DOMS.push(dom);
  return { dom, calls, order, window: dom.window };
}

async function ready(dom) {
  const w = dom.window;
  for (let i = 0; i < 200; i++) {
    const fatal = w.document.querySelector('.ycr-fatal');
    if (fatal) throw new Error('render fatal: ' + fatal.textContent);
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') return w;
    await sleep(20);
  }
  throw new Error('form never finished init');
}

function fire(w, elOrSelector, type = 'change') {
  const el = typeof elOrSelector === 'string' ? w.document.querySelector(elOrSelector) : elOrSelector;
  el.dispatchEvent(new w.Event(type, { bubbles: true }));
  return el;
}

// ═════════════════════════════════════════════════════════════════════════════
// A1. $load prefill
// ═════════════════════════════════════════════════════════════════════════════

describe('A1 $load prefill', () => {
  test('dot path, filtered array path, miss-skip, object-skip, always-overwrite; clean baseline', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;

    // filtered array paths (the case_clients.js replacement)
    expect(d.querySelector('[name="debtor_name"]').value).toBe('Jane Debtor');
    expect(d.querySelector('[name="codebtor_name"]').value).toBe('John Codebtor');
    // dot path off the entity
    expect(d.querySelector('[name="trustee"]').value).toBe('Timothy Miller');
    expect(d.querySelector('[name="always_docket"]').value).toBe('24-48734-mlo');
    // missing key → skipped, never "undefined"
    expect(d.querySelector('[name="miss_path"]').value).toBe('');
    // object-valued path → skipped
    expect(d.querySelector('[name="object_path"]').value).toBe('');
    // $load never called /resolve (no resolver prefills in this def)
    expect(p.calls.filter(c => c.url === '/resolve').length).toBe(0);
    // writes ran inside onLoad → before 13c resetBaseline → CLEAN form
    expect(w.ycForm.isDirty()).toBe(false);
    expect(w.ycForm._original.debtor_name).toBe('Jane Debtor');
  });

  test('ifEmpty respects a populated value; no matching filter item skips', async () => {
    const def = makeDef();
    // trustee also declares apiColumn → populate fills it first, ifEmpty skips
    def.sections[0].rows[0].fields[2].apiColumn = 'case_trustee';
    const p = bootPage({
      definition: def,
      caseRow: Object.assign({}, CASE_ROW, { case_trustee: 'Populated Trustee' }),
      clients: [CLIENTS[0]],                        // no Secondary row
    });
    const w = await ready(p.dom);
    expect(w.document.querySelector('[name="trustee"]').value).toBe('Populated Trustee');
    expect(w.document.querySelector('[name="codebtor_name"]').value).toBe('');   // filter miss
  });

  test('$load runs BEFORE the resolver call when a form uses both', async () => {
    const def = makeDef();
    def.sections[0].rows[0].fields.push({ name: 'res_field', type: 'text', prefill: '{{cases.case_judge}}' });
    const p = bootPage({ definition: def, resolveText: 'Judge Value' });
    const w = await ready(p.dom);
    // $load result present AND resolver result present
    expect(w.document.querySelector('[name="trustee"]').value).toBe('Timothy Miller');
    expect(w.document.querySelector('[name="res_field"]').value).toBe('Judge Value');
    expect(p.calls.filter(c => c.url === '/resolve').length).toBe(1);
  });

  test('preview WITH link_id: $load prefill runs (resolver prefill stays skipped)', async () => {
    const def = makeDef();
    def.sections[0].rows[0].fields.push({ name: 'res_field', type: 'text', prefill: '{{cases.case_judge}}' });
    const p = bootPage({ definition: def, preview: true, previewLinkId: 'CASETEST1' });
    const w = await ready(p.dom);
    expect(w.document.querySelector('[name="debtor_name"]').value).toBe('Jane Debtor');
    expect(w.document.querySelector('[name="trustee"]').value).toBe('Timothy Miller');
    expect(p.calls.filter(c => c.url === '/resolve').length).toBe(0);   // resolver still never fires in preview
  });

  test('preview WITHOUT link_id: no load payload, $load prefill skipped, no fatal', async () => {
    const p = bootPage({ preview: true });
    const w = await ready(p.dom);
    expect(w.document.querySelector('[name="debtor_name"]').value).toBe('');
    expect(p.calls.filter(c => c.url.startsWith('/api/cases/')).length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A2. requiredWhen
// ═════════════════════════════════════════════════════════════════════════════

describe('A2 requiredWhen → validation.custom', () => {
  test('single condition: save blocked with VISIBLE error only while it holds', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;

    // Completed → not required → validate passes
    const outcome = d.querySelector('[name="outcome"]');
    outcome.value = 'Completed'; fire(w, outcome);
    expect(w.ycForm.validate()).toBe(true);

    // Continued + blank → blocked, and the error is VISIBLE in the field's .yc-error
    outcome.value = 'Continued'; fire(w, outcome);
    expect(w.ycForm.validate()).toBe(false);
    const errEl = d.querySelector('[name="appearance_required"]').closest('.yc-field').querySelector('.yc-error');
    expect(errEl.classList.contains('visible')).toBe(true);
    expect(errEl.textContent).toBe('This field is required');

    // filled → passes again
    const ar = d.querySelector('[name="appearance_required"]');
    ar.value = 'NO'; fire(w, ar);
    expect(w.ycForm.validate()).toBe(true);
  });

  test('array = AND, custom requiredMessage', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;
    const outcome = d.querySelector('[name="outcome"]');
    const ar = d.querySelector('[name="appearance_required"]');

    outcome.value = 'Continued'; fire(w, outcome);
    ar.value = 'NO'; fire(w, ar);
    expect(w.ycForm.validate()).toBe(true);            // second AND leg false → not required

    ar.value = 'YES'; fire(w, ar);
    expect(w.ycForm.validate()).toBe(false);           // both legs true, field empty
    const errEl = d.querySelector('[name="new_control_datetime"]').closest('.yc-field').querySelector('.yc-error');
    expect(errEl.textContent).toBe('Set the new control date');

    const nc = d.querySelector('[name="new_control_datetime"]');
    nc.value = '2026-08-01 10:00'; fire(w, nc, 'input');
    expect(w.ycForm.validate()).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A3. includes op + AND arrays
// ═════════════════════════════════════════════════════════════════════════════

describe('A3 showWhen: includes + AND arrays', () => {
  test('includes: attr emission + live visibility off a checkgroup incl. Other text', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;

    const sec = [...d.querySelectorAll('.yc-section')]
      .find(s => (s.querySelector('.yc-section-title') || {}).textContent === 'Garnishment Details');
    expect(sec.getAttribute('data-yc-show-when')).toBe('issues');
    expect(sec.getAttribute('data-yc-show-includes')).toBe('Garnishment,Repossession');
    expect(sec.style.display).toBe('none');            // nothing checked after 13b

    const grid = d.querySelector('[data-yc-checkgroup="issues"]');
    const garn = grid.querySelector('input[value="Garnishment"]');
    garn.checked = true; fire(w, garn);
    expect(sec.style.display).toBe('');

    garn.checked = false; fire(w, garn);
    expect(sec.style.display).toBe('none');

    // A non-listed value keeps it hidden; a listed one via populate shows it
    const fore = grid.querySelector('input[value="Foreclosure"]');
    fore.checked = true; fire(w, fore);
    expect(sec.style.display).toBe('none');

    // Other free text is part of the joined value — matches when it equals a wanted value
    const otherCb = grid.querySelector('input[data-yc-other]');
    const otherTx = grid.querySelector('[data-yc-other-text]');
    otherCb.checked = true; otherTx.value = 'Repossession'; fire(w, otherTx, 'input');
    expect(sec.style.display).toBe('');
  });

  test('AND array: .ycr-and-wrap nesting, composed visibility, single-condition markup unchanged', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;

    const field = d.querySelector('[name="codebtor_ssn"]').closest('.yc-field');
    // condition[0] on the .yc-field itself; condition[1] on ONE wrapper around it
    expect(field.getAttribute('data-yc-show-when')).toBe('marital_status');
    expect(field.getAttribute('data-yc-show-values')).toBe('Married,Separated');
    const wrap = field.parentElement;
    expect(wrap.classList.contains('ycr-and-wrap')).toBe(true);
    expect(wrap.getAttribute('data-yc-show-when')).toBe('is_codebtor');
    expect(wrap.getAttribute('data-yc-show-value')).toBe('Yes');
    expect(wrap.parentElement.classList.contains('yc-row')).toBe(true);   // exactly one wrapper for 2 conds

    // composed visibility: both legs must hold
    const ms = d.querySelector('[name="marital_status"]');
    const cb = d.querySelector('[name="is_codebtor"]');
    const visible = () => field.style.display !== 'none' && wrap.style.display !== 'none';

    expect(visible()).toBe(false);
    ms.value = 'Married'; fire(w, ms);
    expect(visible()).toBe(false);                     // inner leg true, outer false
    cb.value = 'Yes'; fire(w, cb);
    expect(visible()).toBe(true);
    ms.value = 'Single'; fire(w, ms);
    expect(visible()).toBe(false);                     // outer true, inner false

    // single-condition fields carry NO wrapper (byte-identical emission)
    const single = d.querySelector('[name="garn_notes"]').closest('.yc-field');
    expect(single.parentElement.classList.contains('yc-row')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A5. checkgroup columns rendering
// ═════════════════════════════════════════════════════════════════════════════

describe('A5 checkgroup columns', () => {
  test('inline grid override: 1 → "1fr", 2 → repeat(2,1fr); absent → no style attr', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;
    expect(d.querySelector('[data-yc-checkgroup="issues"]').getAttribute('style'))
      .toBe('grid-template-columns:1fr;');
    expect(d.querySelector('[data-yc-checkgroup="two_col"]').getAttribute('style'))
      .toBe('grid-template-columns:repeat(2,1fr);');

    // sanity vs the slice-2 fixture behavior: a columns-less checkgroup has no style
    const def = makeDef();
    delete def.sections[0].rows[2].fields[0].columns;
    const p2 = bootPage({ definition: def });
    const w2 = await ready(p2.dom);
    expect(w2.document.querySelector('[data-yc-checkgroup="issues"]').hasAttribute('style')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Service validation (A1/A2/A3/A4/A5)
// ═════════════════════════════════════════════════════════════════════════════

describe('validateDefinition — 2.5A rules', () => {
  const base = () => makeDef();   // the full 2.5A def must be valid as-is
  const expectReject = (def, re) => {
    expect(() => svc.validateDefinition(def)).toThrow(re);
  };

  test('the 2.5A exercise definition validates', () => {
    expect(() => svc.validateDefinition(base())).not.toThrow();
  });

  test('A4: two repeaters may share a field name; dup within one repeater rejected; repeater-field vs top-level rejected', () => {
    const def = base();
    def.sections.push(
      { repeater: 'prior_bankruptcies', fields: [ { name: 'note', type: 'text' }, { name: 'bk_year', type: 'number' } ] },
      { repeater: 'lawsuits',           fields: [ { name: 'note', type: 'text' } ] },
    );
    expect(() => svc.validateDefinition(def)).not.toThrow();   // cross-repeater "note" OK

    const dupWithin = base();
    dupWithin.sections.push({ repeater: 'r1', fields: [ { name: 'x', type: 'text' }, { name: 'x', type: 'text' } ] });
    expectReject(dupWithin, /unique within a repeater/);

    const vsTop = base();
    vsTop.sections.push({ repeater: 'r1', fields: [ { name: 'trustee', type: 'text' } ] });
    expectReject(vsTop, /collides with a top-level/);

    // order-independent: repeater BEFORE the standard section defining the name
    const vsTopFirst = base();
    vsTopFirst.sections.unshift({ repeater: 'r1', fields: [ { name: 'trustee', type: 'text' } ] });
    expectReject(vsTopFirst, /collides with a top-level/);
  });

  test('A4: repeater key joins the top-level namespace (both directions)', () => {
    const keyVsField = base();
    keyVsField.sections.push({ repeater: 'trustee', fields: [ { name: 'x', type: 'text' } ] });
    expectReject(keyVsField, /collides with a top-level/);

    const fieldVsKey = base();
    fieldVsKey.sections.push({ repeater: 'stuff', fields: [ { name: 'x', type: 'text' } ] });
    fieldVsKey.sections[0].rows[0].fields.push({ name: 'stuff', type: 'text' });
    // (the field is seen first, so the REPEATER KEY is what reports the collision)
    expectReject(fieldVsKey, /repeater "stuff" collides with a top-level/);

    // repeater key is NOT a valid condition target
    const keyTarget = base();
    keyTarget.sections.push({ repeater: 'stuff', fields: [ { name: 'x', type: 'text' } ] });
    keyTarget.sections[0].rows[0].fields[0].showWhen = { field: 'stuff', op: 'notEmpty' };
    expectReject(keyTarget, /does not reference an existing top-level field/);
  });

  test('top-level duplicates still rejected', () => {
    const def = base();
    def.sections[0].rows[0].fields.push({ name: 'trustee', type: 'text' });
    expectReject(def, /duplicate field name "trustee"/);
  });

  test('includes op requires a checkgroup target; valid on checkgroups; arrays validated per-condition', () => {
    const bad = base();
    bad.sections[1].showWhen = { field: 'marital_status', op: 'includes', value: ['x'] };
    expectReject(bad, /requires the target field .* to be a checkgroup/);

    const badInArray = base();
    badInArray.sections[2].rows[0].fields[1].showWhen.push({ field: 'trustee', op: 'includes', value: ['x'] });
    expectReject(badInArray, /requires the target field .* to be a checkgroup/);

    const emptyArr = base();
    emptyArr.sections[0].rows[1].fields[2].requiredWhen = [];
    expectReject(emptyArr, /must not be an empty array/);

    const badOp = base();
    badOp.sections[0].rows[1].fields[1].requiredWhen = { field: 'outcome', op: 'contains', value: 'x' };
    expectReject(badOp, /not one of eq, neq, in, notEmpty, includes/);

    const badTarget = base();
    badTarget.sections[0].rows[1].fields[1].requiredWhen = { field: 'ghost', op: 'eq', value: 'x' };
    expectReject(badTarget, /does not reference an existing top-level field/);
  });

  test('A1: $load grammar accepted/rejected', () => {
    const ok = base();
    ok.sections[0].rows[0].fields[0].prefill = '$load.appts[appt_id=123].appt_with';
    expect(() => svc.validateDefinition(ok)).not.toThrow();

    for (const badExpr of ['$load', '$load.', '$load.case.', '$load.clients[relate_type=]',
                           '$load.clients[relate_type=Primary', '$loadcase.x', '$load.ca se']) {
      const def = base();
      def.sections[0].rows[0].fields[0].prefill = badExpr;
      expectReject(def, /is not a valid \$load expression/);
    }

    // non-$load prefill stays free-form
    const res = base();
    res.sections[0].rows[0].fields[0].prefill = '{{cases.case_trustee|default:x}}';
    expect(() => svc.validateDefinition(res)).not.toThrow();
  });

  test('A5: columns 1–3, checkgroup only', () => {
    for (const bad of [0, 4, 1.5, '2']) {
      const def = base();
      def.sections[0].rows[2].fields[0].columns = bad;
      expectReject(def, /columns must be an integer between 1 and 3/);
    }
    const notCg = base();
    notCg.sections[0].rows[0].fields[2].columns = 2;
    expectReject(notCg, /columns is only allowed on type "checkgroup"/);
  });

  test('note key is ignored at every level', () => {
    const def = base();
    def.note = 'form note';
    def.sections[0].note = 'section note';
    def.sections[0].rows[0].note = 'row note';
    def.sections[0].rows[0].fields[0].note = 'field note';
    expect(() => svc.validateDefinition(def)).not.toThrow();
    // and it never affects the schema signature
    const plain = base();
    expect(svc.fieldSignature(def)).toBe(svc.fieldSignature(plain));
  });
});