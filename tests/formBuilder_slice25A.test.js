/**
 * Slice 2.5A builder verification — public/formBuilder.html under jsdom (jest,
 * unlike the frameworkless phaseA/B/C scripts, so this stays committed).
 *
 * Covers (addendum A5–A8):
 *   A6 name-scoping parity: repeater fields dedupe within their repeater +
 *      top-level namespace (cross-repeater duplicates allowed), top-level
 *      names still checked form-wide; auto-name dedupe follows the same rule
 *   A8 requiredWhen editor (reuses the condition editor), AND arrays
 *      (add/remove/collapse), includes offered only for checkgroup targets,
 *      note textareas at form/section/row/field level, rename cascade into
 *      requiredWhen + AND-array members, delete cascade removes only the
 *      referencing condition
 *   A7 required-under-showWhen lint hint
 *   A5 checkgroup columns knob
 *
 *   npx jest tests/formBuilder_slice25A.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/formBuilder.html'), 'utf8');
const svc  = require(path.join(ROOT, 'services/formTemplateService.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

/** A draft exercising 2.5A builder features. */
function makeDraft() {
  return {
    sections: [
      { title: 'Main', rows: [
        { fields: [
          { name: 'outcome', type: 'select', options: ['Completed', 'Continued'] },
          { name: 'issues', type: 'checkgroup', options: ['Garnishment', 'Repossession'] },
          { name: 'notes_field', type: 'text' },
        ] },
      ] },
      { repeater: 'prior_bankruptcies', title: 'Prior BKs',
        fields: [ { name: 'note', type: 'text' }, { name: 'bk_year', type: 'number' } ] },
      { repeater: 'lawsuits', title: 'Lawsuits',
        fields: [ { name: 'note', type: 'text' } ] },
    ],
  };
}

function bootBuilder(draft) {
  const ROW = {
    id: 1, form_key: 'slice25a_builder', title: 'Builder 2.5A', link_type: 'case',
    schema_version: 1, published_at: null, definition: null,
    draft_definition: draft || makeDraft(),
  };
  const putBodies = [];
  const dom = new JSDOM(HTML, {
    url: 'https://app.4lsg.com/formBuilder.html?id=1',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.apiSend = async (url, method, body) => {
        if (method === 'GET' && url === '/api/form-templates/1') {
          return { status: 'success', template: JSON.parse(JSON.stringify(ROW)) };
        }
        if (method === 'PUT' && url === '/api/form-templates/1') {
          putBodies.push(JSON.parse(JSON.stringify(body)));
          const t = JSON.parse(JSON.stringify(ROW));
          if (body.title) t.title = body.title;
          if (body.draft_definition) t.draft_definition = body.draft_definition;
          return { status: 'success', template: t };
        }
        throw new Error('unexpected apiSend ' + method + ' ' + url);
      };
    },
  });
  DOMS.push(dom);
  return { dom, win: dom.window, doc: dom.window.document, putBodies };
}

async function ready(p) {
  for (let i = 0; i < 100; i++) {
    if (p.win.FB && p.win.FB.model) return p;
    await sleep(20);
  }
  throw new Error('builder never initialized');
}

function propByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#inspector .prop')]
    .find(pr => pr.querySelector('label') && pr.querySelector('label').textContent === labelText);
}
function propsByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#inspector .prop')]
    .filter(pr => pr.querySelector('label') && pr.querySelector('label').textContent === labelText);
}
function buttonByText(doc, text) {
  return [...doc.querySelectorAll('#inspector button')].find(b => b.textContent === text);
}
function fire(win, el, type) { el.dispatchEvent(new win.Event(type, { bubbles: true })); }

// ═════════════════════════════════════════════════════════════════════════════
// A6 — name scoping parity
// ═════════════════════════════════════════════════════════════════════════════

describe('A6 name scoping', () => {
  test('cross-repeater duplicate names accepted by the name validator; within-repeater + vs-top-level rejected; top-level unchanged', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    // Select lawsuits."note" (a name shared with prior_bankruptcies."note")
    win.select({ t: 'rfield', si: 2, fi: 0 });
    const nameInput = propByLabel(doc, 'Name').querySelector('input');
    expect(nameInput.value).toBe('note');

    // Typing the SAME name again (idempotent) and a cross-repeater dup are both fine:
    nameInput.value = 'bk_year';                       // exists only in the OTHER repeater
    fire(win, nameInput, 'input');
    expect(nameInput.classList.contains('bad')).toBe(false);
    expect(win.FB.model.sections[2].fields[0].name).toBe('bk_year');

    // vs top-level → rejected, model untouched
    nameInput.value = 'outcome';
    fire(win, nameInput, 'input');
    expect(nameInput.classList.contains('bad')).toBe(true);
    expect(win.FB.model.sections[2].fields[0].name).toBe('bk_year');

    // vs a repeater KEY → rejected (keys share the top-level namespace)
    nameInput.value = 'prior_bankruptcies';
    fire(win, nameInput, 'input');
    expect(nameInput.classList.contains('bad')).toBe(true);

    // within-repeater dup → rejected
    win.select({ t: 'rfield', si: 1, fi: 1 });         // prior_bankruptcies.bk_year
    const n2 = propByLabel(doc, 'Name').querySelector('input');
    n2.value = 'note';
    fire(win, n2, 'input');
    expect(n2.classList.contains('bad')).toBe(true);

    // TOP-LEVEL field renamed to a repeater field's name → still rejected
    // (the A4 collision is symmetric)
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });   // notes_field
    const n3 = propByLabel(doc, 'Name').querySelector('input');
    n3.value = 'note';
    fire(win, n3, 'input');
    expect(n3.classList.contains('bad')).toBe(true);
  });

  test('auto-name dedupe is scope-aware: a second repeater gets "new_text", not "new_text_2"', async () => {
    const p = await ready(bootBuilder());
    const { win } = p;
    // Seed a "new_text" auto-named field in repeater 1, then add one to repeater 2
    const f1 = win.FB.ops.addFieldAt('rfields:1', 'text', 2);
    expect(f1.name).toBe('new_text');
    const f2 = win.FB.ops.addFieldAt('rfields:2', 'text', 1);
    expect(f2.name).toBe('new_text');                  // cross-repeater — no suffix
    // …but a TOP-LEVEL add still dedupes against everything
    const f3 = win.FB.ops.addFieldAt('fields:0:0', 'text', 3);
    expect(f3.name).toBe('new_text_2');
    // and the result passes the real server validation
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A8 — condition editors
// ═════════════════════════════════════════════════════════════════════════════

describe('A8 requiredWhen editor + AND arrays + includes gating', () => {
  test('requiredWhen: add, AND-append (object→array), per-condition remove (array→object→gone)', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });   // notes_field

    // Add
    buttonByText(doc, '+ Add required-when condition').click();
    const f = win.FB.model.sections[0].rows[0].fields[2];
    expect(f.requiredWhen).toEqual({ field: 'outcome', op: 'eq', value: '' });
    expect(Array.isArray(f.requiredWhen)).toBe(false); // single stays an object

    // AND-append → converts to array (the requiredWhen group renders BEFORE
    // the visibility group, so its "+ AND condition" button is the first one)
    const andBtns = [...doc.querySelectorAll('#inspector button')].filter(b => b.textContent === '+ AND condition');
    expect(andBtns.length).toBe(1);                    // only requiredWhen has a condition yet
    andBtns[0].click();
    expect(Array.isArray(f.requiredWhen)).toBe(true);
    expect(f.requiredWhen.length).toBe(2);

    // requiredMessage input appears once a condition exists
    expect(propByLabel(doc, 'Required message')).toBeTruthy();

    // Remove one → collapses back to an object
    [...doc.querySelectorAll('#inspector button')].find(b => b.textContent === 'Remove this condition').click();
    expect(Array.isArray(f.requiredWhen)).toBe(false);
    expect(f.requiredWhen.field).toBe('outcome');

    // Remove the last → key gone
    [...doc.querySelectorAll('#inspector button')].find(b => b.textContent === 'Remove condition').click();
    expect(f.requiredWhen).toBeUndefined();
  });

  test('includes offered ONLY when the selected target is a checkgroup', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });   // notes_field
    buttonByText(doc, '+ Add condition').click();      // visibility condition (target defaults to 'outcome')

    let opSelect = propByLabel(doc, 'Operator').querySelector('select');
    expect([...opSelect.options].map(o => o.value)).not.toContain('includes');   // select target

    // Retarget to the checkgroup → includes appears
    const whenSelect = propByLabel(doc, 'When field').querySelector('select');
    whenSelect.value = 'issues';
    fire(win, whenSelect, 'change');
    opSelect = propByLabel(doc, 'Operator').querySelector('select');
    expect([...opSelect.options].map(o => o.value)).toContain('includes');

    // Selecting includes normalizes value to an array + comma editor writes it
    opSelect.value = 'includes';
    fire(win, opSelect, 'change');
    const valInput = propByLabel(doc, 'Values (comma-separated)').querySelector('input');
    valInput.value = 'Garnishment, Repossession';
    fire(win, valInput, 'input');
    const f = win.FB.model.sections[0].rows[0].fields[2];
    expect(f.showWhen).toEqual({ field: 'issues', op: 'includes', value: ['Garnishment', 'Repossession'] });
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });

  test('rename cascade follows requiredWhen and AND-array members; delete removes only the referencing condition', async () => {
    const draft = makeDraft();
    draft.sections[0].rows[0].fields[2].requiredWhen = { field: 'outcome', op: 'eq', value: 'Continued' };
    draft.sections[0].rows[0].fields[2].showWhen = [
      { field: 'outcome', op: 'eq', value: 'Continued' },
      { field: 'issues', op: 'includes', value: ['Garnishment'] },
    ];
    const p = await ready(bootBuilder(draft));
    const { win } = p;
    const f = () => win.FB.model.sections[0].rows[0].fields.find(x => x.name === 'notes_field');

    // Rename the target → BOTH the requiredWhen and the array member follow
    const outcome = win.FB.model.sections[0].rows[0].fields[0];
    win.FB.ops.renameField(outcome, 'outcome2');
    expect(f().requiredWhen.field).toBe('outcome2');
    expect(f().showWhen[0].field).toBe('outcome2');
    expect(f().showWhen[1].field).toBe('issues');      // untouched

    // Delete the target field → only ITS conditions are removed; the AND array
    // collapses to the surviving includes condition (object form)
    win.select({ t: 'field', si: 0, ri: 0, fi: 0 });
    win.confirm = () => true;                          // no Swal in jsdom → confirm fallback
    return win.FB.ops.deleteSelected().then(() => {
      expect(f().requiredWhen).toBeUndefined();        // whole key gone (was the only condition)
      expect(Array.isArray(f().showWhen)).toBe(false); // array collapsed
      expect(f().showWhen).toEqual({ field: 'issues', op: 'includes', value: ['Garnishment'] });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A7 — lint hint
// ═════════════════════════════════════════════════════════════════════════════

describe('A7 required-under-showWhen lint', () => {
  test('hint shows for required fields governed by own/row/section visibility; absent otherwise', async () => {
    const draft = makeDraft();
    draft.sections[0].rows[0].fields[2].required = true;
    draft.sections[0].showWhen = { field: 'outcome', op: 'eq', value: 'Continued' };
    const p = await ready(bootBuilder(draft));
    const { win, doc } = p;

    const hint = () => [...doc.querySelectorAll('#inspector .help')]
      .some(h => h.textContent.includes('⚠ This field can be hidden but is always required'));

    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });   // required + section-governed
    expect(hint()).toBe(true);

    // Remove the section condition → hint gone
    delete win.FB.model.sections[0].showWhen;
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });
    expect(hint()).toBe(false);

    // Field's own showWhen brings it back
    win.FB.model.sections[0].rows[0].fields[2].showWhen = { field: 'outcome', op: 'notEmpty' };
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });
    expect(hint()).toBe(true);

    // Not required → no hint even when governed
    delete win.FB.model.sections[0].rows[0].fields[2].required;
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });
    expect(hint()).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A8 — note textareas · A5 — columns knob
// ═════════════════════════════════════════════════════════════════════════════

describe('A8 note textareas + A5 columns knob', () => {
  test('note round-trips at form / section / repeater / row / field / rfield level', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;
    const noteInput = () => propByLabel(doc, 'Note (documentation only)').querySelector('textarea');
    const set = (v) => { const t = noteInput(); t.value = v; fire(win, t, 'input'); };

    win.select(null);                    set('form-level note');
    expect(win.FB.model.note).toBe('form-level note');

    win.select({ t: 'section', si: 0 }); set('section note');
    expect(win.FB.model.sections[0].note).toBe('section note');

    win.select({ t: 'section', si: 1 }); set('repeater note');
    expect(win.FB.model.sections[1].note).toBe('repeater note');

    win.select({ t: 'row', si: 0, ri: 0 }); set('row note');
    expect(win.FB.model.sections[0].rows[0].note).toBe('row note');

    win.select({ t: 'field', si: 0, ri: 0, fi: 0 }); set('field note');
    expect(win.FB.model.sections[0].rows[0].fields[0].note).toBe('field note');

    win.select({ t: 'rfield', si: 1, fi: 0 }); set('rfield note');
    expect(win.FB.model.sections[1].fields[0].note).toBe('rfield note');

    // clearing deletes the key (keeps JSON lean)
    set('');
    expect(win.FB.model.sections[1].fields[0].note).toBeUndefined();

    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });

  test('columns knob on checkgroups only; writes 1–3, default deletes', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    win.select({ t: 'field', si: 0, ri: 0, fi: 1 });   // issues (checkgroup)
    const colProp = propByLabel(doc, 'Columns');
    expect(colProp).toBeTruthy();
    const sel = colProp.querySelector('select');
    sel.value = '1'; fire(win, sel, 'change');
    expect(win.FB.model.sections[0].rows[0].fields[1].columns).toBe(1);
    win.select({ t: 'field', si: 0, ri: 0, fi: 1 });
    const sel2 = propByLabel(doc, 'Columns').querySelector('select');
    sel2.value = ''; fire(win, sel2, 'change');
    expect(win.FB.model.sections[0].rows[0].fields[1].columns).toBeUndefined();

    // absent on a non-options field
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });
    expect(propByLabel(doc, 'Columns')).toBeUndefined();

    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// End-to-end: the builder model round-trips through the real server validation
// with a cross-repeater duplicate (the A4 acceptance case)
// ═════════════════════════════════════════════════════════════════════════════

describe('acceptance: dup "note" across two repeaters validates end-to-end', () => {
  test('makeDraft (note in prior_bankruptcies AND lawsuits) passes validateDefinition', () => {
    expect(() => svc.validateDefinition(makeDraft())).not.toThrow();
  });
});