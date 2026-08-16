/**
 * Slice 2.5B builder verification — public/formBuilder.html under jsdom
 * (jest, same harness as formBuilder_slice25A.test.js).
 *
 * Covers:
 *   B0 firmData relay (window.firmData = P.firmData in init)
 *   B3 apiColumn split editor: object round-trips through the inspector
 *      WITHOUT destruction ("[object Object]" regression guard), split
 *      checkbox converts string ⇄ object, empty columns never reach the model
 *   B1 optionsFrom editor: toggle seeds a valid skeleton, fields write the
 *      model, changeType select→text strips optionsFrom, JSON tab round-trips
 *   B2 derive editor: rules write the model, incomplete rules never reach it,
 *      rename cascades into derive target/from, field delete removes rules
 *   B4 css textarea writes MODEL.css; empty deletes the key
 *
 *   npx jest tests/formBuilder_slice25B.test.js
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

const FIRM_DATA = {
  // Form-dev session (2026-08-16 gate): the CSS editor test below types
  // into a control that is locked for non-form-dev users.
  currentUser: { user_auth: 'authorized - SU' },
  settings: { trustees: [{ name: 'K. Jin Lim', case_type: 7 }] },
};

function makeDraft() {
  return {
    derive: [
      { target: 'case_180', from: 'case_file_date', op: 'addDays', n: 180 },
    ],
    sections: [
      { title: 'Main', rows: [
        { fields: [
          { name: 'case_trustee', type: 'select', options: ['Snapshot A'],
            optionsFrom: { source: 'firmData.settings.trustees', value: 'name', groupBy: 'case_type' } },
          { name: 'case_docket', type: 'text',
            apiColumn: { load: 'case_number_full', save: 'case_number' } },
          { name: 'case_file_date', type: 'date', apiColumn: 'case_file_date' },
          { name: 'case_180', type: 'date', apiColumn: 'case_180' },
        ] },
      ] },
    ],
  };
}

function bootBuilder(draft) {
  const ROW = {
    id: 1, form_key: 'slice25b_builder', title: 'Builder 2.5B', link_type: 'case',
    schema_version: 1, published_at: null, definition: null,
    draft_definition: draft || makeDraft(),
  };
  const putBodies = [];
  const dom = new JSDOM(HTML, {
    url: 'https://app.4lsg.com/formBuilder.html?id=1',
    runScripts: 'dangerously',
    beforeParse(window) {
      // window.parent === window in jsdom, so these ARE "P.apiSend"/"P.firmData"
      window.firmData = FIRM_DATA;
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
// X3.5: form settings live on the Settings tab (#settingsPane), not the
// inspector. Callers must showTab('settings') first — that is what rebuilds it.
function settingsPropByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#settingsPane .prop')]
    .find(pr => pr.querySelector('label') && pr.querySelector('label').textContent === labelText);
}
function checkByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#inspector .prop.inline label')]
    .find(l => l.textContent.trim() === labelText);
}
function fire(win, el, type) { el.dispatchEvent(new win.Event(type, { bubbles: true })); }

// ═════════════════════════════════════════════════════════════════════════════
// B0 — firmData relay
// ═════════════════════════════════════════════════════════════════════════════

describe('B0 firmData relay', () => {
  test('init relays P.firmData onto window for the preview/live iframes', async () => {
    const p = await ready(bootBuilder());
    // window.parent === window in jsdom; init() must have (re)assigned it —
    // assert identity so a forgotten relay (undefined) or a copy both fail.
    expect(p.win.firmData).toBe(FIRM_DATA);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B3 — apiColumn split editor
// ═════════════════════════════════════════════════════════════════════════════

describe('B3 apiColumn editor', () => {
  test('object apiColumn opens the split editor and ROUND-TRIPS (no "[object Object]" destruction)', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    win.select({ t: 'field', si: 0, ri: 0, fi: 1 });   // case_docket {load, save}
    const loadIn = propByLabel(doc, 'Load column').querySelector('input');
    const saveIn = propByLabel(doc, 'Save column').querySelector('input');
    expect(loadIn.value).toBe('case_number_full');
    expect(saveIn.value).toBe('case_number');
    // model untouched by merely opening the inspector
    expect(win.FB.model.sections[0].rows[0].fields[1].apiColumn)
      .toEqual({ load: 'case_number_full', save: 'case_number' });

    // edit one direction — the other survives
    saveIn.value = 'case_number_v2';
    fire(win, saveIn, 'input');
    expect(win.FB.model.sections[0].rows[0].fields[1].apiColumn)
      .toEqual({ load: 'case_number_full', save: 'case_number_v2' });
  });

  test('split checkbox: string → object, object → collapsed string; empty never reaches the model', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    // case_file_date has string apiColumn
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });
    const cb = checkByLabel(doc, 'Separate load/save columns').querySelector('input');
    expect(cb.checked).toBe(false);

    cb.checked = true; fire(win, cb, 'change');
    expect(win.FB.model.sections[0].rows[0].fields[2].apiColumn)
      .toEqual({ load: 'case_file_date', save: 'case_file_date' });

    // clear the load column → save-only object (no empty-string key)
    const loadIn = propByLabel(doc, 'Load column').querySelector('input');
    loadIn.value = ''; fire(win, loadIn, 'input');
    expect(win.FB.model.sections[0].rows[0].fields[2].apiColumn)
      .toEqual({ save: 'case_file_date' });

    // toggle off → collapses (prefers save)
    const cb2 = checkByLabel(doc, 'Separate load/save columns').querySelector('input');
    cb2.checked = false; fire(win, cb2, 'change');
    expect(win.FB.model.sections[0].rows[0].fields[2].apiColumn).toBe('case_file_date');

    // model always passes server validation at every step above
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });

  test('split editor open on a column-less field never writes an invalid shape', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    win.select({ t: 'field', si: 0, ri: 0, fi: 3 });   // case_180 — give it no column first
    const single = propByLabel(doc, 'Database column').querySelector('input');
    single.value = ''; fire(win, single, 'input');
    expect(win.FB.model.sections[0].rows[0].fields[3].apiColumn).toBeUndefined();

    const cb = checkByLabel(doc, 'Separate load/save columns').querySelector('input');
    cb.checked = true; fire(win, cb, 'change');
    // editor open, model clean — a draft save right now must validate
    expect(win.FB.model.sections[0].rows[0].fields[3].apiColumn).toBeUndefined();
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();

    // typing only a save column → save-only object
    const saveIn = propByLabel(doc, 'Save column').querySelector('input');
    saveIn.value = 'case_180'; fire(win, saveIn, 'input');
    expect(win.FB.model.sections[0].rows[0].fields[3].apiColumn).toEqual({ save: 'case_180' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B1 — optionsFrom editor
// ═════════════════════════════════════════════════════════════════════════════

describe('B1 optionsFrom editor', () => {
  test('existing optionsFrom renders; edits write the model; groupLabels appears with groupBy', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    win.select({ t: 'field', si: 0, ri: 0, fi: 0 });   // case_trustee
    const src = propByLabel(doc, 'Source').querySelector('input');
    expect(src.value).toBe('firmData.settings.trustees');

    // groupBy present → groupLabels textarea offered
    const gl = propByLabel(doc, 'Group labels (JSON object)');
    expect(gl).toBeTruthy();
    const ta = gl.querySelector('textarea');
    ta.value = '{ "7": "Chapter 7" }'; fire(win, ta, 'input');
    expect(win.FB.model.sections[0].rows[0].fields[0].optionsFrom.groupLabels)
      .toEqual({ '7': 'Chapter 7' });

    // invalid source rejected, model untouched
    src.value = 'window.evil'; fire(win, src, 'input');
    expect(src.classList.contains('bad')).toBe(true);
    expect(win.FB.model.sections[0].rows[0].fields[0].optionsFrom.source)
      .toBe('firmData.settings.trustees');

    // $load source accepted
    src.value = '$load.clients'; fire(win, src, 'input');
    expect(src.classList.contains('bad')).toBe(false);
    expect(win.FB.model.sections[0].rows[0].fields[0].optionsFrom.source).toBe('$load.clients');
  });

  test('toggle seeds a server-valid skeleton; changeType away from select strips optionsFrom', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    // add optionsFrom to a fresh select via the checkbox
    win.select({ t: 'field', si: 0, ri: 0, fi: 0 });
    const f0 = win.FB.model.sections[0].rows[0].fields[0];
    delete f0.optionsFrom;
    win.select({ t: 'field', si: 0, ri: 0, fi: 0 });   // re-render inspector
    const cb = checkByLabel(doc, 'Load options from data (optionsFrom)').querySelector('input');
    expect(cb.checked).toBe(false);
    cb.checked = true; fire(win, cb, 'change');
    expect(f0.optionsFrom).toEqual({ source: 'firmData.settings.trustees', value: 'name' });
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();

    // type change select → text strips it (server: optionsFrom is select-only)
    const typeSel = propByLabel(doc, 'Type').querySelector('select');
    typeSel.value = 'text'; fire(win, typeSel, 'change');
    expect(f0.optionsFrom).toBeUndefined();
    expect(f0.options).toBeUndefined();
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });

  test('JSON tab round-trips optionsFrom + derive + css untouched', async () => {
    const draft = makeDraft();
    draft.css = '.yc-label { color: red; }';
    const p = await ready(bootBuilder(draft));
    const { win, doc } = p;

    win.showTab('json');
    const ta = doc.getElementById('jsonTa');
    const parsed = JSON.parse(ta.value);
    expect(parsed.derive).toEqual(draft.derive);
    expect(parsed.css).toBe(draft.css);
    expect(parsed.sections[0].rows[0].fields[0].optionsFrom).toEqual(draft.sections[0].rows[0].fields[0].optionsFrom);

    // apply unchanged → model still carries everything
    win.applyJson();
    expect(win.FB.model.derive).toEqual(draft.derive);
    expect(win.FB.model.css).toBe(draft.css);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B2 — derive editor + cascades
// ═════════════════════════════════════════════════════════════════════════════

describe('B2 derive editor', () => {
  test('settings pane renders existing rules; a completed new rule writes the model; incomplete never does', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    win.showTab('settings');   // form settings (X3.5: own tab, not the inspector)
    const rulesProp = settingsPropByLabel(doc, 'Rules (target ← source)');
    expect(rulesProp).toBeTruthy();
    const list = rulesProp.querySelector('div');
    expect(list.children.length).toBe(1);              // the existing rule

    // existing rule reflected
    const row = list.children[0];
    expect(row._t.value).toBe('case_180');
    expect(row._f.value).toBe('case_file_date');
    expect(row._n.value).toBe('180');

    // add an incomplete rule → model unchanged
    const addBtn = [...doc.querySelectorAll('#settingsPane button')].find(b => b.textContent === '+ Add rule');
    addBtn.onclick();
    expect(win.FB.model.derive).toEqual([{ target: 'case_180', from: 'case_file_date', op: 'addDays', n: 180 }]);

    // complete it: target=case_file_date? no — target must differ from source;
    // use docket (text — server would allow? target/from just need to exist)
    const nrow = list.children[1];
    nrow._t.value = 'case_docket'; fire(win, nrow._t, 'change');
    expect(win.FB.model.derive.length).toBe(1);        // still incomplete (no source)
    nrow._f.value = 'case_file_date'; fire(win, nrow._f, 'change');
    expect(win.FB.model.derive.length).toBe(1);        // addDays without n — still incomplete
    nrow._n.value = '30'; fire(win, nrow._n, 'input');
    expect(win.FB.model.derive).toEqual([
      { target: 'case_180', from: 'case_file_date', op: 'addDays', n: 180 },
      { target: 'case_docket', from: 'case_file_date', op: 'addDays', n: 30 },
    ]);
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();

    // remove the new rule
    nrow.querySelector('button').onclick();
    expect(win.FB.model.derive).toEqual([{ target: 'case_180', from: 'case_file_date', op: 'addDays', n: 180 }]);
  });

  test('rename cascades into derive target/from; deleting a referenced field removes its rules', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    // rename the SOURCE field
    win.select({ t: 'field', si: 0, ri: 0, fi: 2 });   // case_file_date
    const nameIn = propByLabel(doc, 'Name').querySelector('input');
    nameIn.value = 'filed_on'; fire(win, nameIn, 'input');
    expect(win.FB.model.derive[0]).toEqual({ target: 'case_180', from: 'filed_on', op: 'addDays', n: 180 });

    // rename the TARGET field
    win.select({ t: 'field', si: 0, ri: 0, fi: 3 });   // case_180
    const nameIn2 = propByLabel(doc, 'Name').querySelector('input');
    nameIn2.value = 'one_eighty'; fire(win, nameIn2, 'input');
    expect(win.FB.model.derive[0]).toEqual({ target: 'one_eighty', from: 'filed_on', op: 'addDays', n: 180 });

    // deleting the target field removes the rule (and the empty derive key)
    win.ycConfirmOverride = true;
    // deleteSelected uses ycConfirm (Swal) — stub it
    const origConfirm = win.ycConfirm;
    win.eval('ycConfirm = async () => true;');
    await win.FB.ops.deleteSelected();
    expect(win.FB.model.derive).toBeUndefined();
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B4 — css textarea
// ═════════════════════════════════════════════════════════════════════════════

describe('B4 css editor', () => {
  test('settings CSS textarea writes MODEL.css; empty deletes the key', async () => {
    const p = await ready(bootBuilder());
    const { win, doc } = p;

    win.showTab('settings');
    const ta = settingsPropByLabel(doc, 'CSS (advanced)').querySelector('textarea');
    expect(ta.value).toBe('');

    ta.value = '.yc-row { gap: 2px; }'; fire(win, ta, 'input');
    expect(win.FB.model.css).toBe('.yc-row { gap: 2px; }');
    expect(() => svc.validateDefinition(win.FB.model)).not.toThrow();

    ta.value = ''; fire(win, ta, 'input');
    expect(win.FB.model.css).toBeUndefined();
  });
});
