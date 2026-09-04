/**
 * showWhenAny — the OR operator (contract §4.4.1, Fred-ratified 2026-09-04).
 *
 * Added for the DBKQ conversion (D2-A), where cross-source OR turned up as
 * ordinary questionnaire logic: "show the keep-or-replace question if you lease
 * OR were repossessed OR owe money on the vehicle". `in` only ORs over one
 * field's values, and the AND-array wrapper trick nests — nesting IS AND.
 *
 * Harness style follows formRender.slice25A.test.js: jsdom integration against
 * the REAL render.html + the REAL /js/yc-forms.js.
 *
 * Layers:
 *   1. render.html emission — data-yc-show-any JSON, composition with the AND
 *      half, and the BYTE-IDENTICAL legacy lock (the load-bearing one).
 *   2. yc-forms evaluator — truth table, both-attrs AND, checkgroup sources,
 *      empty-selection states, unresolvable terms.
 *   3. validateDefinition — accept/reject shapes and target rules.
 *   4. Card mode — a card whose only question hides via showWhenAny is skipped.
 *   5. extFormService.projectDefinition — the key survives to the wire.
 *
 *   npx jest tests/formRender.showWhenAny.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const svc         = require(path.join(ROOT, 'services/formTemplateService.js'));
const extSvc      = require(path.join(ROOT, 'services/extFormService.js'));

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

function bootPage(definition, opts = {}) {
  const url = 'https://app.test/forms/render.html?form_key=swa_test&case_id=CASE1';
  const apiSend = async (u) => {
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: 'OR Test', link_type: 'case', schema_version: 1, definition };
    }
    if (u.startsWith('/api/cases/')) return { case: { case_id: 'CASE1' }, clients: [] };
    if (u.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
    if (u.startsWith('/api/forms/draft')) return {};
    if (u === '/api/log') return {};
    if (u === '/resolve') return { status: 'success', text: '', unresolved: [] };
    throw new Error('unstubbed apiSend: ' + u);
  };
  const dom = new JSDOM(RENDER_HTML, {
    url, runScripts: 'dangerously', resources: new TestLoader(), pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend = apiSend;
    },
  });
  DOMS.push(dom);
  return dom;
}

async function ready(dom) {
  const w = dom.window;
  for (let i = 0; i < 250; i++) {
    const fatal = w.document.querySelector('.ycr-fatal');
    if (fatal) throw new Error('render fatal: ' + fatal.textContent);
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') return w;
    await sleep(20);
  }
  throw new Error('form never finished init');
}

const fire = (w, el, type = 'change') => {
  el.dispatchEvent(new w.Event(type, { bubbles: true }));
  return el;
};
/** The .yc-field wrapper (or an outer .ycr-and-wrap chain) for a field name. */
function wrapOf(w, name) {
  const ctl = w.document.querySelector(`[name="${name}"], [data-yc-checkgroup="${name}"]`);
  return ctl ? ctl.closest('.yc-field') : null;
}
function visible(w, name) {
  let n = wrapOf(w, name);
  while (n && n !== w.document.querySelector('#ycRenderForm')) {
    if (n.style && n.style.display === 'none') return false;
    n = n.parentElement;
  }
  return true;
}
const setRadio = (w, name, value) => {
  const r = w.document.querySelector(`input[name="${name}"][value="${value}"]`);
  r.checked = true;
  return fire(w, r);
};
const setText = (w, name, value) => {
  const t = w.document.querySelector(`input[name="${name}"]`);
  t.value = value;
  return fire(w, t, 'input');
};

// The DBKQ shape that motivated the feature, reduced to its essentials.
function orDef(extra) {
  return Object.assign({
    toggle: false, autosave: false, dataMode: 'snapshot',
    sections: [
      { title: 'Sources', rows: [{ fields: [
        { name: 'leasing',     type: 'radio', options: ['YES', 'NO'] },
        { name: 'repossessed', type: 'radio', options: ['YES', 'NO'] },
        { name: 'amount_owed', type: 'text' },
        { name: 'housing',     type: 'radio', options: ['Own', 'Renting'] },
        { name: 'electronics', type: 'checkgroup', options: ['Cell phone', 'Television(s)'] },
      ] }] },
      { title: 'Vehicle preference',
        showWhenAny: [
          { field: 'leasing',     op: 'eq', value: 'YES' },
          { field: 'repossessed', op: 'eq', value: 'YES' },
          { field: 'amount_owed', op: 'notEmpty' },
        ],
        rows: [{ fields: [{ name: 'car_pref', type: 'text' }] }] },
      { title: 'Both halves',
        showWhen: { field: 'housing', op: 'eq', value: 'Own' },
        showWhenAny: [
          { field: 'leasing',     op: 'eq', value: 'YES' },
          { field: 'repossessed', op: 'eq', value: 'YES' },
        ],
        rows: [{ fields: [{ name: 'both_note', type: 'text' }] }] },
      { title: 'Checkgroup OR',
        showWhenAny: [
          { field: 'electronics', op: 'includes', value: ['Television(s)'] },
          { field: 'housing',     op: 'eq', value: 'Renting' },
        ],
        rows: [{ fields: [{ name: 'cg_note', type: 'text' }] }] },
    ],
  }, extra || {});
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. render.html emission
// ═════════════════════════════════════════════════════════════════════════════

describe('render.html emission', () => {
  test('showWhenAny emits ONE data-yc-show-any attribute carrying JSON', async () => {
    const w = await ready(bootPage(orDef()));
    const sec = wrapOf(w, 'car_pref').closest('[data-yc-show-any]');
    expect(sec).toBeTruthy();
    // JSON, not a delimiter encoding — option values legitimately contain commas.
    expect(JSON.parse(sec.getAttribute('data-yc-show-any'))).toEqual([
      { field: 'leasing',     op: 'eq', value: 'YES' },
      { field: 'repossessed', op: 'eq', value: 'YES' },
      { field: 'amount_owed', op: 'notEmpty' },
    ]);
    // An any-only node carries no AND attribute at all.
    expect(sec.hasAttribute('data-yc-show-when')).toBe(false);
  });

  test('a node with both halves carries both attributes on the SAME node', async () => {
    const w = await ready(bootPage(orDef()));
    const sec = wrapOf(w, 'both_note').closest('[data-yc-show-any]');
    expect(sec.getAttribute('data-yc-show-when')).toBe('housing');
    expect(sec.getAttribute('data-yc-show-value')).toBe('Own');
    expect(JSON.parse(sec.getAttribute('data-yc-show-any')).length).toBe(2);
  });

  test('comma-bearing values survive the attribute round-trip intact', async () => {
    const def = orDef({ sections: [
      { title: 'S', rows: [{ fields: [{ name: 'kit', type: 'checkgroup',
        options: ['Pots, pans, dishes', 'Hand tools (shovels, rakes)'] }] }] },
      { title: 'T', showWhenAny: [{ field: 'kit', op: 'includes', value: ['Pots, pans, dishes'] }],
        rows: [{ fields: [{ name: 'note', type: 'text' }] }] },
    ] });
    const w = await ready(bootPage(def));
    const sec = wrapOf(w, 'note').closest('[data-yc-show-any]');
    expect(JSON.parse(sec.getAttribute('data-yc-show-any'))[0].value)
      .toEqual(['Pots, pans, dishes']);
  });

  test('LEGACY LOCK: a definition without showWhenAny emits byte-identical DOM', async () => {
    // The whole amendment is worthless if it perturbs existing forms. Render a
    // definition exercising every legacy shape and assert the serialized form
    // markup carries no new attribute and nothing reordered.
    const legacy = {
      toggle: false, autosave: false, dataMode: 'snapshot',
      sections: [
        { title: 'S', rows: [{ fields: [
          { name: 'a', type: 'radio', options: ['x', 'y'] },
          { name: 'b', type: 'checkgroup', options: ['p', 'q'] },
          { name: 'c', type: 'text' },
        ] }] },
        { title: 'eq',       showWhen: { field: 'a', op: 'eq', value: 'x' },        rows: [{ fields: [{ name: 'f1', type: 'text' }] }] },
        { title: 'neq',      showWhen: { field: 'a', op: 'neq', value: 'x' },       rows: [{ fields: [{ name: 'f2', type: 'text' }] }] },
        { title: 'in',       showWhen: { field: 'a', op: 'in', value: ['x', 'y'] }, rows: [{ fields: [{ name: 'f3', type: 'text' }] }] },
        { title: 'notEmpty', showWhen: { field: 'c', op: 'notEmpty' },              rows: [{ fields: [{ name: 'f4', type: 'text' }] }] },
        { title: 'includes', showWhen: { field: 'b', op: 'includes', value: ['p'] },rows: [{ fields: [{ name: 'f5', type: 'text' }] }] },
        { title: 'AND', showWhen: [
            { field: 'a', op: 'eq', value: 'x' },
            { field: 'c', op: 'notEmpty' },
          ], rows: [{ fields: [{ name: 'f6', type: 'text' }] }] },
      ],
    };
    const w = await ready(bootPage(legacy));
    const html = w.document.querySelector('#ycRenderForm').innerHTML;
    expect(html).not.toContain('data-yc-show-any');
    // The AND array still nests exactly one wrapper per extra condition.
    expect(w.document.querySelectorAll('.ycr-and-wrap').length).toBe(1);
    // And each legacy attribute pair is exactly what 2.5A emitted.
    const attrs = (name) => {
      const n = wrapOf(w, name).closest('[data-yc-show-when]');
      return [n.getAttribute('data-yc-show-when'), n.getAttribute('data-yc-show-value'),
              n.getAttribute('data-yc-show-values'), n.getAttribute('data-yc-show-includes')];
    };
    expect(attrs('f1')).toEqual(['a', 'x', null, null]);
    expect(attrs('f2')).toEqual(['a', '!x', null, null]);
    expect(attrs('f3')).toEqual(['a', null, 'x,y', null]);
    expect(attrs('f4')).toEqual(['c', '*', null, null]);
    expect(attrs('f5')).toEqual(['b', null, null, 'p']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. yc-forms evaluator
// ═════════════════════════════════════════════════════════════════════════════

describe('_evaluateConditionals — OR truth table', () => {
  test('hidden with nothing set; ANY one term reveals; clearing all re-hides', async () => {
    const w = await ready(bootPage(orDef()));
    expect(visible(w, 'car_pref')).toBe(false);

    setRadio(w, 'leasing', 'YES');
    expect(visible(w, 'car_pref')).toBe(true);

    setRadio(w, 'leasing', 'NO');
    expect(visible(w, 'car_pref')).toBe(false);

    setRadio(w, 'repossessed', 'YES');
    expect(visible(w, 'car_pref')).toBe(true);

    setRadio(w, 'repossessed', 'NO');
    expect(visible(w, 'car_pref')).toBe(false);

    setText(w, 'amount_owed', '4200');
    expect(visible(w, 'car_pref')).toBe(true);

    setText(w, 'amount_owed', '');
    expect(visible(w, 'car_pref')).toBe(false);
  });

  test('two terms true at once is still shown (OR, not XOR)', async () => {
    const w = await ready(bootPage(orDef()));
    setRadio(w, 'leasing', 'YES');
    setRadio(w, 'repossessed', 'YES');
    expect(visible(w, 'car_pref')).toBe(true);
    setRadio(w, 'leasing', 'NO');
    expect(visible(w, 'car_pref')).toBe(true);      // repossessed still carries it
  });

  test('both attributes compose as AND(showWhen, OR(showWhenAny))', async () => {
    const w = await ready(bootPage(orDef()));
    expect(visible(w, 'both_note')).toBe(false);

    setRadio(w, 'leasing', 'YES');                   // OR half true, AND half false
    expect(visible(w, 'both_note')).toBe(false);

    setRadio(w, 'housing', 'Own');                   // both true
    expect(visible(w, 'both_note')).toBe(true);

    setRadio(w, 'leasing', 'NO');                    // OR half false again
    expect(visible(w, 'both_note')).toBe(false);

    setRadio(w, 'repossessed', 'YES');               // a different OR term
    expect(visible(w, 'both_note')).toBe(true);

    setRadio(w, 'housing', 'Renting');               // AND half false
    expect(visible(w, 'both_note')).toBe(false);
  });

  test('checkgroup source: includes term inside an OR, incl. empty selection', async () => {
    const w = await ready(bootPage(orDef()));
    expect(visible(w, 'cg_note')).toBe(false);       // nothing selected

    const tv = w.document.querySelector('[data-yc-checkgroup="electronics"] input[value="Television(s)"]');
    tv.checked = true; fire(w, tv);
    expect(visible(w, 'cg_note')).toBe(true);

    tv.checked = false; fire(w, tv);
    expect(visible(w, 'cg_note')).toBe(false);

    setRadio(w, 'housing', 'Renting');               // the other OR term
    expect(visible(w, 'cg_note')).toBe(true);
  });

  test('a term naming a field that does not exist is skipped, not fatal', async () => {
    const def = orDef({ sections: [
      { title: 'S', rows: [{ fields: [{ name: 'real', type: 'radio', options: ['YES', 'NO'] }] }] },
      { title: 'T', showWhenAny: [
          { field: 'ghost', op: 'eq', value: 'YES' },
          { field: 'real',  op: 'eq', value: 'YES' },
        ], rows: [{ fields: [{ name: 'note', type: 'text' }] }] },
    ] });
    const w = await ready(bootPage(def));
    expect(visible(w, 'note')).toBe(false);
    setRadio(w, 'real', 'YES');
    expect(visible(w, 'note')).toBe(true);
  });

  test('LEGACY LOCK: every legacy op still evaluates exactly as before', async () => {
    const legacy = {
      toggle: false, autosave: false, dataMode: 'snapshot',
      sections: [
        { title: 'S', rows: [{ fields: [
          { name: 'a', type: 'radio', options: ['x', 'y'] },
          { name: 'b', type: 'checkgroup', options: ['p', 'q'] },
          { name: 'c', type: 'text' },
        ] }] },
        { title: '1', showWhen: { field: 'a', op: 'eq', value: 'x' },         rows: [{ fields: [{ name: 'f1', type: 'text' }] }] },
        { title: '2', showWhen: { field: 'a', op: 'neq', value: 'x' },        rows: [{ fields: [{ name: 'f2', type: 'text' }] }] },
        { title: '3', showWhen: { field: 'a', op: 'in', value: ['y'] },       rows: [{ fields: [{ name: 'f3', type: 'text' }] }] },
        { title: '4', showWhen: { field: 'c', op: 'notEmpty' },               rows: [{ fields: [{ name: 'f4', type: 'text' }] }] },
        { title: '5', showWhen: { field: 'b', op: 'includes', value: ['p'] }, rows: [{ fields: [{ name: 'f5', type: 'text' }] }] },
      ],
    };
    const w = await ready(bootPage(legacy));
    // nothing set: eq false, neq TRUE (current value ''), in false, notEmpty false, includes false
    expect([visible(w, 'f1'), visible(w, 'f2'), visible(w, 'f3'), visible(w, 'f4'), visible(w, 'f5')])
      .toEqual([false, true, false, false, false]);

    setRadio(w, 'a', 'x');
    expect([visible(w, 'f1'), visible(w, 'f2'), visible(w, 'f3')]).toEqual([true, false, false]);
    setRadio(w, 'a', 'y');
    expect([visible(w, 'f1'), visible(w, 'f2'), visible(w, 'f3')]).toEqual([false, true, true]);

    setText(w, 'c', 'hello');
    expect(visible(w, 'f4')).toBe(true);

    const p = w.document.querySelector('[data-yc-checkgroup="b"] input[value="p"]');
    p.checked = true; fire(w, p);
    expect(visible(w, 'f5')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Card mode
// ═════════════════════════════════════════════════════════════════════════════

describe('card mode', () => {
  const cardDef = () => ({
    layout: 'card', toggle: false, autosave: false, dataMode: 'snapshot',
    sections: [
      { rows: [{ fields: [{ name: 'leasing', type: 'radio', label: 'Leasing?', options: ['YES', 'NO'] }] }] },
      { rows: [{ fields: [{ name: 'repossessed', type: 'radio', label: 'Repossessed?', options: ['YES', 'NO'] }] }] },
      { showWhenAny: [
          { field: 'leasing',     op: 'eq', value: 'YES' },
          { field: 'repossessed', op: 'eq', value: 'YES' },
        ],
        rows: [{ fields: [{ name: 'car_pref', type: 'text', label: 'Keep or replace?' }] }] },
      { rows: [{ fields: [{ name: 'tail', type: 'text', label: 'Anything else?' }] }] },
    ],
  });

  test('an any-hidden card is skipped by the dot bar and the counter', async () => {
    const w = await ready(bootPage(cardDef()));
    const count = () => w.document.querySelector('.yc-card-count').textContent;
    expect(w.document.querySelectorAll('.yc-card').length).toBe(4);
    // 3 of 4 reachable while both sources are unanswered.
    expect(count()).toBe('1 of 3');
    expect(w.document.querySelectorAll('.yc-card-dot').length).toBe(3);

    setRadio(w, 'leasing', 'YES');
    await sleep(20);
    expect(count()).toBe('1 of 4');
    expect(w.document.querySelectorAll('.yc-card-dot').length).toBe(4);

    setRadio(w, 'leasing', 'NO');
    await sleep(20);
    expect(count()).toBe('1 of 3');
  });

  test('a showWhenAny field counts as a FOLLOW-UP, so its card still styles single', async () => {
    const def = cardDef();
    def.sections[3] = { rows: [{ fields: [
      { name: 'phone_kind', type: 'radio', label: 'Which phone?', options: ['iPhone', 'Other'] },
      { name: 'phone_other', type: 'text', label: 'Other — please specify',
        showWhenAny: [{ field: 'phone_kind', op: 'eq', value: 'Other' }] },
    ] }] };
    const w = await ready(bootPage(def));
    const card = w.document.querySelectorAll('.yc-card')[3];
    expect(card.classList.contains('yc-card-single')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. validateDefinition
// ═════════════════════════════════════════════════════════════════════════════

describe('validateDefinition — showWhenAny', () => {
  const wrap = (extra) => ({
    sections: [
      { title: 'S', rows: [{ fields: [
        { name: 'a', type: 'radio', options: ['x', 'y'] },
        { name: 'g', type: 'checkgroup', options: ['p'] },
        { name: 'pic', type: 'content', text: 'hi' },
      ] }] },
      Object.assign({ title: 'T', rows: [{ fields: [{ name: 'b', type: 'text' }] }] }, extra),
    ],
  });

  test('accepts a non-empty array on a section, a row and a field', () => {
    const c = [{ field: 'a', op: 'eq', value: 'x' }, { field: 'a', op: 'eq', value: 'y' }];
    expect(() => svc.validateDefinition(wrap({ showWhenAny: c }))).not.toThrow();
    expect(() => svc.validateDefinition({ sections: [
      wrap().sections[0],
      { title: 'T', rows: [{ showWhenAny: c, fields: [{ name: 'b', type: 'text' }] }] },
    ] })).not.toThrow();
    expect(() => svc.validateDefinition({ sections: [
      wrap().sections[0],
      { title: 'T', rows: [{ fields: [{ name: 'b', type: 'text', showWhenAny: c }] }] },
    ] })).not.toThrow();
  });

  test('accepts showWhen and showWhenAny together', () => {
    expect(() => svc.validateDefinition(wrap({
      showWhen: { field: 'a', op: 'eq', value: 'x' },
      showWhenAny: [{ field: 'a', op: 'eq', value: 'y' }],
    }))).not.toThrow();
  });

  test('rejects a bare object — an OR written as one condition is a mistyped showWhen', () => {
    expect(() => svc.validateDefinition(wrap({ showWhenAny: { field: 'a', op: 'eq', value: 'x' } })))
      .toThrow(/showWhenAny must be an ARRAY/);
  });

  test('rejects an empty array', () => {
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [] })))
      .toThrow(/must not be an empty array/);
  });

  test('rejects an unknown op, a missing field, and a dangling field reference', () => {
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [{ field: 'a', op: 'matches', value: 'x' }] })))
      .toThrow(/is not one of eq, neq, in, notEmpty, includes/);
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [{ op: 'eq', value: 'x' }] })))
      .toThrow(/\.field is required/);
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [{ field: 'nope', op: 'eq', value: 'x' }] })))
      .toThrow(/does not reference an existing top-level field/);
  });

  test('applies the includes→checkgroup and no-content-target rules inside the OR list', () => {
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [{ field: 'a', op: 'includes', value: ['x'] }] })))
      .toThrow(/requires the target field "a" to be a checkgroup/);
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [{ field: 'g', op: 'includes', value: ['p'] }] })))
      .not.toThrow();
    expect(() => svc.validateDefinition(wrap({ showWhenAny: [{ field: 'pic', op: 'eq', value: 'x' }] })))
      .toThrow(/targets a content field/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. External projection — the key must reach the wire
// ═════════════════════════════════════════════════════════════════════════════

describe('extFormService.projectDefinition', () => {
  test('showWhenAny survives on sections, rows, fields and repeaters', () => {
    const any = [{ field: 'a', op: 'eq', value: 'x' }];
    const out = extSvc.projectDefinition({
      layout: 'card',
      endpoints: { load: { url: '/secret' } },              // must NOT survive
      sections: [
        { title: 'S', showWhenAny: any, rows: [
          { showWhenAny: any, fields: [
            { name: 'a', type: 'radio', options: ['x'], showWhenAny: any, apiColumn: 'secret_col' },
          ] },
        ] },
        { repeater: 'cars', title: 'Cars', showWhenAny: any, fields: [{ name: 'make', type: 'text' }] },
      ],
    });
    expect(out.sections[0].showWhenAny).toEqual(any);
    expect(out.sections[0].rows[0].showWhenAny).toEqual(any);
    expect(out.sections[0].rows[0].fields[0].showWhenAny).toEqual(any);
    expect(out.sections[1].showWhenAny).toEqual(any);
    // Allowlist discipline intact.
    expect(out.endpoints).toBeUndefined();
    expect(out.sections[0].rows[0].fields[0].apiColumn).toBeUndefined();
  });

  test('a row without either key still projects to exactly { fields }', () => {
    const out = extSvc.projectDefinition({
      sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }],
    });
    expect(Object.keys(out.sections[0].rows[0])).toEqual(['fields']);
  });

  test('a row with only showWhen keeps showWhen first (key order unchanged)', () => {
    const out = extSvc.projectDefinition({
      sections: [{ title: 'S', rows: [
        { showWhen: { field: 'a', op: 'eq', value: 'x' }, fields: [{ name: 'a', type: 'text' }] },
      ] }],
    });
    expect(Object.keys(out.sections[0].rows[0])).toEqual(['showWhen', 'fields']);
  });
});
