/**
 * Slice 2 verification for public/forms/render.html + the one approved
 * yc-forms.js change (init step-7 wrong-entity guard).
 *
 * These are jsdom INTEGRATION tests against the REAL files: the actual
 * render.html is parsed with runScripts:'dangerously', the actual
 * /js/yc-forms.js is served by a custom ResourceLoader, and window.apiSend
 * (parent === window in a frameless jsdom page) is stubbed per test. The
 * definition under test is fixture_slice2_draft_definition.json — the exact
 * JSON published to form_templates id=1 — so what passes here is what runs.
 *
 * Covers (Slice 2 handoff):
 *   - repeater DOM derivation + add/remove/collect/populate round-trip
 *   - showWhen attr emission (eq/neq/in/notEmpty) + live visibility on change
 *   - checkgroup allowOther markup, collect/populate round-trip, user toggle
 *   - resolver prefill: one batched /resolve, ||| split, ifEmpty vs always,
 *     unresolved-literal guard, skipped in preview
 *   - hooks: load + onLoad-after-prefill order + onSave-after-submit order,
 *     missing-file resilience
 *   - yc-forms entityData wrong-entity guard: match → fast-path, mismatch →
 *     API fetch, no-PK-property → old behavior, loose string/number equality
 *
 *   npx jest tests/formRender.slice2.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const FIXTURE_DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixture_slice2_draft_definition.json'), 'utf8'));

// Serve the real yc-forms.js; serve a per-test hook script; empty out CDN
// assets; 404 (reject) anything else under /forms/hooks/ so the <script>
// onerror path is exercised.
class TestLoader extends ResourceLoader {
  constructor(hookScript) { super(); this.hookScript = hookScript; }
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p.startsWith('/forms/hooks/')) {
      if (this.hookScript && p === '/forms/hooks/testhook.js') {
        return Promise.resolve(Buffer.from(this.hookScript));
      }
      return Promise.reject(new Error('404 ' + p));
    }
    return Promise.resolve(Buffer.from('')); // bootstrap css / sweetalert CDN
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Track every JSDOM so afterAll can close them — closes jsdom-side timers
// (autosave debounce, the hooks-loader 10s safety timeout) so jest exits clean.
const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

/**
 * Boot the real render.html in jsdom.
 * @param {object} opts
 *   definition  — template definition (default: the Slice 2 fixture)
 *   linkId      — case id in the URL (default CASETEST1)
 *   preview     — boot in preview mode (?template_id=1&preview=1)
 *   caseRow     — the entity object GET /api/cases returns (merged under {case})
 *   resolveText — canned /resolve response text (default resolves both fixture exprs)
 *   entityData  — window.entityData for the fast-path tests
 *   hookScript  — JS source served as /forms/hooks/testhook.js
 */
function bootPage(opts = {}) {
  const def     = opts.definition || FIXTURE_DEF;
  const linkId  = opts.linkId !== undefined ? opts.linkId : 'CASETEST1';
  const calls   = [];
  const order   = [];
  const url = opts.preview
    ? 'https://app.test/forms/render.html?template_id=1&preview=1' + (opts.previewLinkId ? '&link_id=' + opts.previewLinkId : '')
    : 'https://app.test/forms/render.html?form_key=test_quick_notes&case_id=' + encodeURIComponent(linkId);

  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method: method, body: body });
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: 'Test Quick Notes', link_type: 'case',
               schema_version: 2, definition: def };
    }
    if (u.startsWith('/api/form-templates/')) {           // preview fetch
      return { status: 'success', template: { form_key: 'test_quick_notes', title: 'Test Quick Notes',
               link_type: 'case', schema_version: 2, draft_definition: def } };
    }
    if (u.startsWith('/api/cases/')) {
      return { case: opts.caseRow || { case_id: linkId } };
    }
    if (u.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
    if (u === '/resolve') {
      order.push('resolve');
      return { status: 'success', text: opts.resolveText !== undefined
        ? opts.resolveText : 'Test Trustee|||24-12345-abc', unresolved: [] };
    }
    if (u === '/api/forms/submit') {
      order.push('submit');
      return { id: 77, version: 1, updated_at: new Date().toISOString() };
    }
    if (u.startsWith('/api/forms/draft')) return {};
    if (u === '/api/log') return {};
    if (u.startsWith('/workflows/')) return {};
    throw new Error('unstubbed apiSend: ' + method + ' ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(opts.hookScript),
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom doesn't implement CSS.escape (browsers do — _setCheckgroup uses it)
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend  = apiSend;   // window.parent === window → parent.apiSend resolves
      window.__order  = order;
      if (opts.entityData) window.entityData = opts.entityData;
    },
  });

  DOMS.push(dom);
  return { dom, calls, order, window: dom.window };
}

/** Wait until YCForm init finished (loading overlay hidden) or fatal error shown. */
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
// A. DOM derivations
// ═════════════════════════════════════════════════════════════════════════════

describe('DOM derivation', () => {
  let w;
  beforeAll(async () => { const p = bootPage(); w = await ready(p.dom); });

  test('repeater section emits container, add button, and a populated <template>', () => {
    const d = w.document;
    const container = d.getElementById('ycRep_vehicles');
    expect(container).toBeTruthy();
    expect(container.classList.contains('yc-repeater')).toBe(true);

    const addBtn = d.querySelector('.yc-repeater-add[data-repeater="vehicles"]');
    expect(addBtn).toBeTruthy();
    expect(d.getElementById('ycRenderForm').contains(addBtn)).toBe(true); // _setupRepeaters scans this.el

    const tpl = d.getElementById('ycRepTpl_vehicles');
    expect(tpl).toBeTruthy();
    // Children MUST live in template.content or _addRepeaterItemWithData clones nothing.
    const item = tpl.content.querySelector('.yc-repeater-item');
    expect(item).toBeTruthy();
    for (const name of ['veh_desc', 'veh_year', 'veh_acquired', 'veh_status', 'veh_insured']) {
      expect(item.querySelector(`[name="${name}"]`)).toBeTruthy();
    }
    expect(item.querySelector('.yc-repeater-remove')).toBeTruthy();
    // YCForm got the derived repeaters config
    expect(w.ycForm.config.repeaters.vehicles).toEqual({
      container: '#ycRep_vehicles',
      template:  '#ycRepTpl_vehicles',
      fields: {
        veh_desc:     { type: 'text' },
        veh_year:     { type: 'number' },
        veh_acquired: { type: 'date' },
        veh_status:   { type: 'select' },
        veh_insured:  { type: 'checkbox' },
      },
    });
  });

  test('showWhen translates to the exact runtime attrs (eq/neq/in/notEmpty)', () => {
    const d = w.document;
    // section-level eq
    const sections = [...d.querySelectorAll('.yc-section')];
    const condSec = sections.find(s => (s.querySelector('.yc-section-title') || {}).textContent === 'Conditional Demo');
    expect(condSec.getAttribute('data-yc-show-when')).toBe('sample_checkbox');
    expect(condSec.getAttribute('data-yc-show-value')).toBe('true');
    // row-level in
    const row = condSec.querySelector('.yc-row[data-yc-show-when="sample_select"]');
    expect(row.getAttribute('data-yc-show-values')).toBe('Red,g');
    // field-level neq + notEmpty
    const neqField = d.querySelector('[name="cond_field_neq"]').closest('.yc-field');
    expect(neqField.getAttribute('data-yc-show-when')).toBe('sample_select');
    expect(neqField.getAttribute('data-yc-show-value')).toBe('!Blue');
    const neField = d.querySelector('[name="cond_field_notempty"]').closest('.yc-field');
    expect(neField.getAttribute('data-yc-show-when')).toBe('primary_reason');
    expect(neField.getAttribute('data-yc-show-value')).toBe('*');
  });

  test('checkbox fields sit inside .yc-check (view-mode CSS lock contract)', () => {
    // Regression (found in manual test 2026-07-27): view-mode locking is
    // CSS-only — .yc-readonly .yc-check input/label { pointer-events:none }.
    // A checkbox emitted without the .yc-check wrapper misses those selectors
    // and stays toggleable in view mode (label-activation bypasses
    // pointer-events on the input). jsdom doesn't simulate pointer-events, so
    // the enforceable invariant is the markup: every checkbox-type input,
    // standard AND repeater-template, must be inside .yc-check with its label.
    const doc = w.document;   // shared DOM-derivation boot (beforeAll)

    // Standard checkbox field
    const std = doc.querySelector('input[name="sample_checkbox"]');
    expect(std).toBeTruthy();
    expect(std.closest('.yc-check')).toBeTruthy();
    expect(std.closest('label')).toBeTruthy();
    expect(std.closest('label').closest('.yc-check')).toBeTruthy();

    // Repeater-template checkbox
    const tpl = doc.querySelector('#ycRepTpl_vehicles');
    const rep = tpl.content.querySelector('input[name="veh_insured"]');
    expect(rep).toBeTruthy();
    expect(rep.closest('.yc-check')).toBeTruthy();
    expect(rep.closest('label')).toBeTruthy();
  });

  test('allowOther emits the runtime checkgroup markup', () => {
    const grid = w.document.querySelector('[data-yc-checkgroup="sample_checkgroup"]');
    const otherCb = grid.querySelector('input[type="checkbox"][data-yc-other]');
    expect(otherCb).toBeTruthy();
    expect(otherCb.value).toBe('Other');
    const wrap = grid.querySelector('.yc-other-text');
    expect(wrap).toBeTruthy();
    expect(wrap.style.display).toBe('none');
    expect(wrap.querySelector('input[data-yc-other-text]')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Behavior against the REAL yc-forms.js
// ═════════════════════════════════════════════════════════════════════════════

describe('repeater round-trip', () => {
  test('add → fill → collect → populate → remove → collect', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;
    const form = w.ycForm;

    // Add one item via the add button (real _setupRepeaters binding)
    d.querySelector('.yc-repeater-add[data-repeater="vehicles"]').click();
    let items = d.querySelectorAll('#ycRep_vehicles .yc-repeater-item');
    expect(items.length).toBe(1);

    items[0].querySelector('[name="veh_desc"]').value = '2019 Honda Accord';
    items[0].querySelector('[name="veh_year"]').value = '2019';
    items[0].querySelector('[name="veh_acquired"]').value = '2023-05-01';
    items[0].querySelector('[name="veh_status"]').value = 'Financed';
    items[0].querySelector('[name="veh_insured"]').checked = true;

    expect(form.collect().vehicles).toEqual([{
      veh_desc: '2019 Honda Accord', veh_year: '2019', veh_acquired: '2023-05-01',
      veh_status: 'Financed', veh_insured: true,
    }]);

    // populate() rebuilds items from data
    form.populate(Object.assign({}, form.collect(), {
      vehicles: [
        { veh_desc: 'Truck', veh_year: '2001', veh_acquired: '', veh_status: 'Owned', veh_insured: false },
        { veh_desc: 'Sedan', veh_year: '2015', veh_acquired: '2020-01-02', veh_status: 'Leased', veh_insured: true },
      ],
    }));
    items = d.querySelectorAll('#ycRep_vehicles .yc-repeater-item');
    expect(items.length).toBe(2);
    expect(items[1].querySelector('[name="veh_desc"]').value).toBe('Sedan');

    // remove button (bound per-item by _addRepeaterItemWithData)
    items[0].querySelector('.yc-repeater-remove').click();
    expect(d.querySelectorAll('#ycRep_vehicles .yc-repeater-item').length).toBe(1);
    expect(form.collect().vehicles.map(v => v.veh_desc)).toEqual(['Sedan']);
  });
});

describe('showWhen visibility (real _evaluateConditionals)', () => {
  test('section / row / field react to value changes', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;
    const condSec = [...d.querySelectorAll('.yc-section')]
      .find(s => (s.querySelector('.yc-section-title') || {}).textContent === 'Conditional Demo');

    // checkbox unchecked → 'false' ≠ 'true' → section hidden after init 13b
    expect(condSec.style.display).toBe('none');

    // Check the driver checkbox → section shows
    const cb = d.querySelector('[name="sample_checkbox"]');
    cb.checked = true; fire(w, cb);
    expect(condSec.style.display).toBe('');

    // in-op row: select '' → hidden; 'g' → shown; 'Blue' → hidden again
    const row = condSec.querySelector('.yc-row[data-yc-show-when="sample_select"]');
    expect(row.style.display).toBe('none');
    const sel = d.querySelector('[name="sample_select"]');
    sel.value = 'g'; fire(w, sel);
    expect(row.style.display).toBe('');
    sel.value = 'Blue'; fire(w, sel);
    expect(row.style.display).toBe('none');

    // neq field: value 'Blue' → hidden; 'Red' → shown
    const neqField = d.querySelector('[name="cond_field_neq"]').closest('.yc-field');
    expect(neqField.style.display).toBe('none');
    sel.value = 'Red'; fire(w, sel);
    expect(neqField.style.display).toBe('');

    // eq field on radio
    const yesField = d.querySelector('[name="cond_field_yes"]').closest('.yc-field');
    expect(yesField.style.display).toBe('none');
    const radioYes = d.querySelector('input[name="sample_radio"][value="YES"]');
    radioYes.checked = true; fire(w, radioYes);
    expect(yesField.style.display).toBe('');

    // notEmpty field on primary_reason
    const neField = d.querySelector('[name="cond_field_notempty"]').closest('.yc-field');
    expect(neField.style.display).toBe('none');
    const pr = d.querySelector('[name="primary_reason"]');
    pr.value = 'Medical debt'; fire(w, pr, 'input');
    expect(neField.style.display).toBe('');
  });
});

describe('allowOther checkgroup', () => {
  test('populate/collect round-trip through the Other value + user toggle', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;
    const form = w.ycForm;
    const grid = d.querySelector('[data-yc-checkgroup="sample_checkgroup"]');
    const wrap = grid.querySelector('.yc-other-text');

    // populate with a value no option matches → Other checked + text filled + wrapper shown
    form.populate(Object.assign({}, form.collect(), { sample_checkgroup: 'Alpha,Custom Thing' }));
    expect(grid.querySelector('input[value="Alpha"]').checked).toBe(true);
    const otherCb = grid.querySelector('input[data-yc-other]');
    expect(otherCb.checked).toBe(true);
    expect(grid.querySelector('[data-yc-other-text]').value).toBe('Custom Thing');
    expect(wrap.style.display).toBe('');

    // collect round-trips the Other text as a value
    expect(form.collect().sample_checkgroup).toBe('Alpha,Custom Thing');

    // user unchecks Other → wrapper hides (render.html's toggle wiring),
    // and collect drops the Other value
    otherCb.checked = false; fire(w, otherCb);
    expect(wrap.style.display).toBe('none');
    expect(form.collect().sample_checkgroup).toBe('Alpha');

    // user re-checks → wrapper shows again
    otherCb.checked = true; fire(w, otherCb);
    expect(wrap.style.display).toBe('');
  });
});

describe('resolver prefill', () => {
  test('one batched /resolve; ifEmpty respects existing value; always overwrites', async () => {
    const p = bootPage({
      caseRow: { case_id: 'CASETEST1', prefill_trustee: 'Existing Person', prefill_docket: 'OLD-DOCKET' },
      resolveText: 'Resolved Trustee|||24-12345-abc',
    });
    const w = await ready(p.dom);
    const d = w.document;

    const resolveCalls = p.calls.filter(c => c.url === '/resolve');
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0].method).toBe('POST');
    expect(resolveCalls[0].body).toEqual({
      text: '{{cases.case_trustee}}|||{{cases.case_number_full|default:no docket on file}}',
      refs: { cases: { case_id: 'CASETEST1' } },
    });

    // ifEmpty: field was populated from the entity → untouched
    expect(d.querySelector('[name="prefill_trustee"]').value).toBe('Existing Person');
    // always: overwritten with the resolved value
    expect(d.querySelector('[name="prefill_docket"]').value).toBe('24-12345-abc');

    // prefill ran inside onLoad → before 13c resetBaseline → form is CLEAN
    expect(w.ycForm.isDirty()).toBe(false);
    expect(w.ycForm._original.prefill_docket).toBe('24-12345-abc');
  });

  test('ifEmpty fills an empty field; unresolved literal is never written', async () => {
    const p = bootPage({
      caseRow: { case_id: 'CASETEST1' },
      // first expr unresolved (empty column → literal back), second resolves
      resolveText: '{{cases.case_trustee}}|||no docket on file',
    });
    const w = await ready(p.dom);
    const d = w.document;
    expect(d.querySelector('[name="prefill_trustee"]').value).toBe('');       // literal blocked
    expect(d.querySelector('[name="prefill_docket"]').value).toBe('no docket on file');
  });

  test('part-count mismatch aborts the whole prefill write', async () => {
    const p = bootPage({ caseRow: { case_id: 'CASETEST1' }, resolveText: 'only-one-part' });
    const w = await ready(p.dom);
    expect(w.document.querySelector('[name="prefill_trustee"]').value).toBe('');
    expect(w.document.querySelector('[name="prefill_docket"]').value).toBe('');
  });

  test('preview never calls /resolve', async () => {
    const p = bootPage({ preview: true, previewLinkId: 'CASETEST1' });
    await ready(p.dom);
    expect(p.calls.filter(c => c.url === '/resolve').length).toBe(0);
  });
});

describe('hooks', () => {
  const HOOK = `
    window.__order.push('hook_script_loaded');
    window.ycHooks = {
      onLoad: function (form, data) {
        window.__order.push('hook_onLoad');
        window.__hookOnLoadArgs = { isForm: form === window.ycForm, hasData: !!data };
      },
      onSave: function (form, result) {
        window.__order.push('hook_onSave');
        window.__hookOnSaveResult = result;
      },
    };
  `;

  test('loaded before init; onLoad runs AFTER prefill; onSave runs after submit', async () => {
    const def = JSON.parse(JSON.stringify(FIXTURE_DEF));
    def.hooks = 'testhook';
    const p = bootPage({ definition: def, hookScript: HOOK, caseRow: { case_id: 'CASETEST1' } });
    const w = await ready(p.dom);

    // Load + call order: script before form init completes, resolve before hook onLoad
    expect(p.order.indexOf('hook_script_loaded')).toBeGreaterThanOrEqual(0);
    expect(p.order.indexOf('resolve')).toBeGreaterThan(p.order.indexOf('hook_script_loaded'));
    expect(p.order.indexOf('hook_onLoad')).toBeGreaterThan(p.order.indexOf('resolve'));
    expect(w.__hookOnLoadArgs).toEqual({ isForm: true, hasData: true });

    // Save round-trip → ycHooks.onSave(form, result) after /api/forms/submit
    const d = w.document;
    const pr = d.querySelector('[name="primary_reason"]');
    pr.value = 'Medical debt'; fire(w, pr, 'input');
    await w.ycForm.save();
    expect(p.order.indexOf('hook_onSave')).toBeGreaterThan(p.order.indexOf('submit'));
    expect(w.__hookOnSaveResult && w.__hookOnSaveResult.id).toBe(77);
  });

  test('missing hooks file: warn + form renders anyway', async () => {
    const def = JSON.parse(JSON.stringify(FIXTURE_DEF));
    def.hooks = 'missinghook';                       // loader rejects → script onerror
    const p = bootPage({ definition: def, caseRow: { case_id: 'CASETEST1' } });
    const w = await ready(p.dom);
    expect(w.ycForm).toBeTruthy();
    expect(w.document.querySelector('[name="src_ref"]')).toBeTruthy();
    expect(w.ycHooks).toBeUndefined();
  });
});

describe('yc-forms entityData wrong-entity guard (approved step-7 change)', () => {
  const caseApiCalled = (calls) => calls.some(c => c.url.startsWith('/api/cases/'));

  test('matching PK → fast-path (no API fetch), parent data populates', async () => {
    const p = bootPage({
      entityData: { case: { case_id: 'CASETEST1', case_source_ref: 'FROMPARENT' } },
    });
    const w = await ready(p.dom);
    expect(caseApiCalled(p.calls)).toBe(false);
    expect(w.document.querySelector('[name="src_ref"]').value).toBe('FROMPARENT');
  });

  test('mismatched PK → fast-path skipped, falls through to API fetch', async () => {
    const p = bootPage({
      entityData: { case: { case_id: 'SOMEOTHERCASE', case_source_ref: 'WRONGDATA' } },
      caseRow:    { case_id: 'CASETEST1', case_source_ref: 'FROMAPI' },
    });
    const w = await ready(p.dom);
    expect(caseApiCalled(p.calls)).toBe(true);
    expect(w.document.querySelector('[name="src_ref"]').value).toBe('FROMAPI');
  });

  test('entity without the PK property → old behavior (fast-path kept)', async () => {
    const p = bootPage({
      entityData: { case: { case_source_ref: 'NOPK-PARENT' } },
    });
    const w = await ready(p.dom);
    expect(caseApiCalled(p.calls)).toBe(false);
    expect(w.document.querySelector('[name="src_ref"]').value).toBe('NOPK-PARENT');
  });

  test('loose equality: numeric PK vs string linkId still fast-paths', async () => {
    const p = bootPage({
      linkId: '5',
      entityData: { case: { case_id: 5, case_source_ref: 'NUMERIC-MATCH' } },
    });
    const w = await ready(p.dom);
    expect(caseApiCalled(p.calls)).toBe(false);
    expect(w.document.querySelector('[name="src_ref"]').value).toBe('NUMERIC-MATCH');
  });
});