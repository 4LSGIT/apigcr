/**
 * Slice 2.6 builder verification — public/formBuilder.html under jsdom
 * (jest, same harness as formBuilder_slice25B.test.js).
 *
 * Covers (SLICE_2_6_SPEC.md + addendum v2, mandated architecture: flat MODEL
 * + layout tags, serializeModel reassembly):
 *   L  load/serialize: tabbed defs roundtrip BYTE-STABLE unedited (the issn
 *      fixture), sections-mode defs are returned untouched (identity), saves
 *      send the serialized shape
 *   TC tab CRUD: add (seeds a section), rename, reorder (retags + canonical
 *      order), delete only when empty
 *   MV cross-container Move-to: retag + reinsert at target region end,
 *      canonical flat order preserved, ACTIVE_TAB follows
 *   TG layout toggle: sections → one-tab tabbed; disable blocked with >1 tab
 *      or sticky sections; single-tab-no-sticky disable returns to sections
 *   EB embed in the builder: palette type present, newField seeds a valid
 *      src, inspector src/height validate-blocked, changeType strips
 *   CD code editor: writes MODEL.code, empty deletes, syntax errors never
 *      reach the model, hooks ⇄ code mutual exclusion
 *   JS JSON tab: tabbed paste flattens + normalized print equals the
 *      serialized shape
 *
 *   npx jest tests/formBuilder_slice26.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/formBuilder.html'), 'utf8');
const svc  = require(path.join(ROOT, 'services/formTemplateService.js'));
const ISSN_DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'ref/2026-08-03_issn_tabs_definition.json'), 'utf8'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

function tabbedDraft() {
  return {
    stickyTop: [
      { rows: [{ fields: [{ name: 'head', type: 'text', label: 'Head' }] }] },
    ],
    tabs: [
      { label: 'Alpha', sections: [
        { title: 'A1', rows: [{ fields: [{ name: 'a1', type: 'text', label: 'A1' }] }] },
        { title: 'A2', rows: [{ fields: [{ name: 'a2', type: 'text', label: 'A2' }] }] },
      ] },
      { label: 'Beta', sections: [
        { title: 'B1', rows: [{ fields: [{ name: 'b1', type: 'text', label: 'B1' }] }] },
      ] },
    ],
    stickyBottom: [
      { rows: [{ fields: [{ name: 'foot', type: 'textarea', label: 'Foot' }] }] },
    ],
  };
}

function sectionsDraft() {
  return {
    sections: [
      { title: 'Only', rows: [{ fields: [
        { name: 'x1', type: 'text', label: 'X1' },
        { name: 'x2', type: 'text', label: 'X2' },
      ] }] },
    ],
  };
}

function bootBuilder(draft) {
  const ROW = {
    id: 1, form_key: 'slice26_builder', title: 'Builder 2.6', link_type: 'case',
    schema_version: 1, published_at: null, definition: null,
    draft_definition: draft,
  };
  const putBodies = [];
  const dom = new JSDOM(HTML, {
    url: 'https://app.4lsg.com/formBuilder.html?id=1',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.firmData = {};
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
// inspector. A PURE query — activating the tab (showTab('settings')) is what
// rebuilds the panel, and CD below depends on controlling exactly when that
// happens.
function settingsPropByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#settingsPane .prop')]
    .find(pr => pr.querySelector('label') && pr.querySelector('label').textContent === labelText);
}
function fire(win, el, type) { el.dispatchEvent(new win.Event(type, { bubbles: true })); }
const ser = (p) => p.win.FB.ops.serializeModel();
const titles = (p, region, ti) => p.win.FB.ops.regionMembers(region, ti)
  .map(i => p.win.FB.model.sections[i].title);

// ═════════════════════════════════════════════════════════════════════════════
// L — load / serialize
// ═════════════════════════════════════════════════════════════════════════════

describe('L load/serialize (flat model + layout tags)', () => {
  test('unedited tabbed load → serialize is byte-stable (issn fixture)', async () => {
    const p = await ready(bootBuilder(JSON.parse(JSON.stringify(ISSN_DEF))));
    expect(JSON.stringify(ser(p))).toBe(JSON.stringify(ISSN_DEF));
    // canvas is in tabbed mode
    expect(p.doc.querySelectorAll('.cv-tabstrip').length).toBe(1);
    expect(p.doc.querySelectorAll('.cv-tab').length).toBe(6);
  });

  test('sections-mode defs bypass serialization entirely (identity)', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    expect(ser(p)).toBe(p.win.FB.model);      // the MODEL object itself
    expect(p.doc.querySelectorAll('.cv-tabstrip').length).toBe(0);
  });

  test('empty sticky arrays are never emitted; key order preserved', async () => {
    const draft = tabbedDraft();
    const p = await ready(bootBuilder(draft));
    // move the only stickyTop section onto tab 0 → stickyTop empties
    const si = p.win.FB.ops.regionMembers('stickyTop', null)[0];
    p.win.FB.ops.moveSectionToRegion(si, { region: 'tab', tabIndex: 0 });
    const out = ser(p);
    expect('stickyTop' in out).toBe(false);
    expect('stickyBottom' in out).toBe(true);
    expect(Object.keys(out)).toEqual(['tabs', 'stickyBottom']);
    expect(out.tabs[0].sections.map(s => s.title)).toEqual(['A1', 'A2', undefined]);
  });

  test('saveDraft sends the SERIALIZED shape, never the flat model', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    p.win.FB.title = 'renamed';               // dirty it
    p.doc.getElementById('saveBtn').click();
    await sleep(60);
    expect(p.putBodies.length).toBe(1);
    const sent = p.putBodies[0].draft_definition;
    expect('sections' in sent).toBe(false);
    expect(Array.isArray(sent.tabs)).toBe(true);
    expect(sent.tabs.length).toBe(2);
    expect(sent.stickyTop.length).toBe(1);
    expect(JSON.stringify(sent)).toBe(JSON.stringify(tabbedDraft()));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TC — tab CRUD
// ═════════════════════════════════════════════════════════════════════════════

describe('TC tab CRUD', () => {
  test('addTab seeds one section on the new tab and activates it', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    p.win.FB.ops.addTab();
    expect(p.win.FB.tabsMeta.length).toBe(3);
    expect(p.win.FB.activeTab).toBe(2);
    const members = p.win.FB.ops.regionMembers('tab', 2);
    expect(members.length).toBe(1);           // seeded — never an invalid save
    const out = ser(p);
    expect(out.tabs[2].label).toBe('Tab 3');
    expect(out.tabs[2].sections.length).toBe(1);
  });

  test('moveTab swaps labels AND section membership, restores canonical order', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    p.win.FB.ops.moveTab(0, 1);               // Alpha ↔ Beta
    const out = ser(p);
    expect(out.tabs.map(t => t.label)).toEqual(['Beta', 'Alpha']);
    expect(out.tabs[0].sections.map(s => s.title)).toEqual(['B1']);
    expect(out.tabs[1].sections.map(s => s.title)).toEqual(['A1', 'A2']);
    // canonical flat order: sticky, tab0 (B1), tab1 (A1, A2), sticky
    expect(p.win.FB.model.sections.map(s => s.title))
      .toEqual([undefined, 'B1', 'A1', 'A2', undefined]);
    expect(p.win.FB.activeTab).toBe(1);
  });

  test('deleteTab refuses while the tab has sections, works once emptied, retags later tabs', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    p.win.FB.ops.deleteTab(0);                // Alpha has 2 sections → refused
    expect(p.win.FB.tabsMeta.length).toBe(2);
    // empty Alpha via Move-to
    let si = p.win.FB.ops.regionMembers('tab', 0)[0];
    p.win.FB.ops.moveSectionToRegion(si, { region: 'tab', tabIndex: 1 });
    si = p.win.FB.ops.regionMembers('tab', 0)[0];
    p.win.FB.ops.moveSectionToRegion(si, { region: 'tab', tabIndex: 1 });
    expect(p.win.FB.ops.regionMembers('tab', 0).length).toBe(0);
    p.win.FB.ops.deleteTab(0);
    expect(p.win.FB.tabsMeta.length).toBe(1);
    const out = ser(p);
    expect(out.tabs.length).toBe(1);
    expect(out.tabs[0].label).toBe('Beta');
    expect(out.tabs[0].sections.map(s => s.title)).toEqual(['B1', 'A1', 'A2']);
    svc.validateDefinition(out);              // still a valid definition
  });

  test('the last tab cannot be deleted', async () => {
    const p = await ready(bootBuilder({ tabs: [
      { label: 'Solo', sections: [{ rows: [{ fields: [{ name: 'f', type: 'text' }] }] }] },
    ] }));
    p.win.FB.ops.deleteTab(0);
    expect(p.win.FB.tabsMeta.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MV — cross-container Move-to
// ═════════════════════════════════════════════════════════════════════════════

describe('MV Move-to', () => {
  test('tab → sticky and back; always lands at the target region END in canonical order', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    // A1 → stickyBottom
    let si = p.win.FB.ops.regionMembers('tab', 0)[0];
    p.win.FB.ops.moveSectionToRegion(si, { region: 'stickyBottom' });
    expect(titles(p, 'stickyBottom', null)).toEqual([undefined, 'A1']);   // appended after foot
    expect(titles(p, 'tab', 0)).toEqual(['A2']);
    // B1 → tab 0 (lands after A2)
    si = p.win.FB.ops.regionMembers('tab', 1)[0];
    p.win.FB.ops.moveSectionToRegion(si, { region: 'tab', tabIndex: 0 });
    expect(titles(p, 'tab', 0)).toEqual(['A2', 'B1']);
    expect(p.win.FB.activeTab).toBe(0);       // followed the move
    // flat canonical order holds throughout
    expect(p.win.FB.model.sections.map(s => s.title))
      .toEqual([undefined, 'A2', 'B1', undefined, 'A1']);
    // serialize reflects it
    const out = ser(p);
    expect(out.tabs[0].sections.map(s => s.title)).toEqual(['A2', 'B1']);
    expect(out.tabs[1].sections.length).toBe(0);   // emptied Beta (transient)
    expect(out.stickyBottom.map(s => s.title)).toEqual([undefined, 'A1']);
  });

  test('within-region reorder maps region indices to flat indices exactly', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    p.win.FB.ops.moveSectionInRegion('tab', 0, 0, 1);   // A1 below A2
    expect(titles(p, 'tab', 0)).toEqual(['A2', 'A1']);
    expect(ser(p).tabs[0].sections.map(s => s.title)).toEqual(['A2', 'A1']);
  });

  test('field-level SEL/loc machinery keeps working on the flat indices after moves', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    const si = p.win.FB.ops.regionMembers('tab', 0)[1];   // A2 (Alpha keeps A1)
    p.win.FB.ops.moveSectionToRegion(si, { region: 'stickyTop' });
    const newSi = p.win.FB.model.sections.findIndex(s => s.title === 'A2');
    const f = p.win.FB.ops.addFieldAt('fields:' + newSi + ':0', 'text', 1);
    expect(f).toBeTruthy();
    expect(p.win.FB.model.sections[newSi].rows[0].fields.length).toBe(2);
    svc.validateDefinition(ser(p));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TG — layout toggle
// ═════════════════════════════════════════════════════════════════════════════

describe('TG tabbed-layout toggle (Form settings)', () => {
  // X3.5: Form settings render into the Settings TAB (#settingsPane), and
  // showTab('settings') is what rebuilds the panel — the equivalent of the
  // old "← Form settings" back button.
  function toggleEl(p) {
    p.win.showTab('settings');
    return [...p.doc.querySelectorAll('#settingsPane .prop.inline label')]
      .find(l => l.textContent.trim() === 'Tabbed layout')
      .querySelector('input');
  }

  test('sections → tabbed: one tab holding every section', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    const t = toggleEl(p);
    expect(t.checked).toBe(false);
    t.checked = true; fire(p.win, t, 'change');
    await sleep(10);
    expect(p.win.FB.tabsMeta.length).toBe(1);
    const out = ser(p);
    expect(out.tabs[0].label).toBe('Tab 1');
    expect(out.tabs[0].sections.map(s => s.title)).toEqual(['Only']);
    expect('sections' in out).toBe(false);
    svc.validateDefinition(out);
  });

  test('tabbed → sections blocked with >1 tab or sticky sections; allowed once reduced', async () => {
    const p = await ready(bootBuilder(tabbedDraft()));
    let t = toggleEl(p);
    t.checked = false; fire(p.win, t, 'change');
    await sleep(10);
    expect(p.win.FB.tabsMeta).not.toBeNull();     // blocked (2 tabs + stickies)

    // reduce: everything onto tab 0, delete tab 1
    const F = p.win.FB.ops;
    ['stickyTop', 'stickyBottom'].forEach(rg => {
      F.regionMembers(rg, null).slice().reverse().forEach(() => {
        const si = F.regionMembers(rg, null)[0];
        F.moveSectionToRegion(si, { region: 'tab', tabIndex: 0 });
      });
    });
    while (F.regionMembers('tab', 1).length) {
      F.moveSectionToRegion(F.regionMembers('tab', 1)[0], { region: 'tab', tabIndex: 0 });
    }
    F.deleteTab(1);
    expect(p.win.FB.tabsMeta.length).toBe(1);

    // toggleEl re-activates the Settings tab, which rebuilds the panel and so
    // refreshes the toggle's canDisable state; then disable.
    await sleep(10);
    t = toggleEl(p);
    t.checked = false; fire(p.win, t, 'change');
    await sleep(10);
    expect(p.win.FB.tabsMeta).toBeNull();
    const out = ser(p);
    expect(out).toBe(p.win.FB.model);             // back to identity serialization
    expect(Array.isArray(out.sections)).toBe(true);
    expect(out.sections.length).toBe(5);
    svc.validateDefinition(out);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CL — card layout (X6): checkbox writes/deletes MODEL.layout; mutual
//      exclusion with Tabbed layout, both directions, legible-flash not 400
// ═════════════════════════════════════════════════════════════════════════════

describe('CL card-layout toggle (Form settings, X6)', () => {
  function checkboxByLabel(p, labelText) {
    p.win.showTab('settings');
    return [...p.doc.querySelectorAll('#settingsPane .prop.inline label')]
      .find(l => l.textContent.trim() === labelText)
      .querySelector('input');
  }

  test('card on/off writes and deletes MODEL.layout; round-trips + validates', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    const c = checkboxByLabel(p, 'Card layout');
    expect(c.checked).toBe(false);
    c.checked = true; fire(p.win, c, 'change');
    await sleep(10);
    expect(p.win.FB.model.layout).toBe('card');
    let out = ser(p);
    expect(out.layout).toBe('card');
    svc.validateDefinition(out);

    const c2 = checkboxByLabel(p, 'Card layout');
    expect(c2.checked).toBe(true);
    c2.checked = false; fire(p.win, c2, 'change');
    await sleep(10);
    expect('layout' in p.win.FB.model).toBe(false);   // absent = flat, byte-identical
    out = ser(p);
    expect('layout' in out).toBe(false);
    svc.validateDefinition(out);
  });

  test('mutual exclusion both ways — flash + reset, never a server 400', async () => {
    // card on → tabbed blocked
    const p = await ready(bootBuilder(sectionsDraft()));
    let c = checkboxByLabel(p, 'Card layout');
    c.checked = true; fire(p.win, c, 'change');
    await sleep(10);
    let t = checkboxByLabel(p, 'Tabbed layout');
    t.checked = true; fire(p.win, t, 'change');
    await sleep(10);
    expect(p.win.FB.tabsMeta).toBeNull();             // blocked
    expect(p.win.FB.model.layout).toBe('card');
    expect(checkboxByLabel(p, 'Tabbed layout').checked).toBe(false);   // reset

    // tabbed on → card blocked
    const p2 = await ready(bootBuilder(tabbedDraft()));
    const c2 = checkboxByLabel(p2, 'Card layout');
    c2.checked = true; fire(p2.win, c2, 'change');
    await sleep(10);
    expect('layout' in p2.win.FB.model).toBe(false);  // blocked
    expect(p2.win.FB.tabsMeta).not.toBeNull();
    expect(checkboxByLabel(p2, 'Card layout').checked).toBe(false);    // reset
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EB — embed in the builder
// ═════════════════════════════════════════════════════════════════════════════

describe('EB embed inspector', () => {
  test('palette offers embed; newField seeds a valid https src (model never starts invalid)', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    expect(p.doc.querySelector('#palFields [data-pal="embed"]')).toBeTruthy();
    const f = p.win.FB.ops.addFieldAt('fields:0:0', 'embed', 2);
    expect(f.type).toBe('embed');
    expect(f.src).toBe('https://example.com/');
    svc.validateDefinition(ser(p));
  });

  test('src editor validate-blocks non-https / oversize; height accepts positive ints only', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    const f = p.win.FB.ops.addFieldAt('fields:0:0', 'embed', 2);
    await sleep(10);
    const srcProp = propByLabel(p.doc, 'URL (https)');
    const srcIn = srcProp.querySelector('input');
    srcIn.value = 'http://nope.example/'; fire(p.win, srcIn, 'input');
    expect(f.src).toBe('https://example.com/');       // model untouched
    expect(srcIn.classList.contains('bad')).toBe(true);
    srcIn.value = 'https://cal.example/book'; fire(p.win, srcIn, 'input');
    expect(f.src).toBe('https://cal.example/book');

    const hProp = propByLabel(p.doc, 'Height (px)');
    const hIn = hProp.querySelector('input');
    hIn.value = '0'; fire(p.win, hIn, 'input');
    expect(f.height).toBeUndefined();
    hIn.value = '720'; fire(p.win, hIn, 'input');
    expect(f.height).toBe(720);
    hIn.value = ''; fire(p.win, hIn, 'input');
    expect(f.height).toBeUndefined();
  });

  test('changeType to embed strips input-shaped keys and seeds src; away strips src/height', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    const f = p.win.FB.model.sections[0].rows[0].fields[0];
    Object.assign(f, { required: true, apiColumn: 'col', mask: 'phone', placeholder: 'x' });
    p.win.FB.ops.changeType(f, 'embed');
    expect(f.required).toBeUndefined();
    expect(f.apiColumn).toBeUndefined();
    expect(f.mask).toBeUndefined();
    expect(f.placeholder).toBeUndefined();
    expect(f.src).toBe('https://example.com/');
    f.height = 500;
    p.win.FB.ops.changeType(f, 'text');
    expect(f.src).toBeUndefined();
    expect(f.height).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CD — code editor
// ═════════════════════════════════════════════════════════════════════════════

describe('CD code editor + hooks exclusivity', () => {
  test('writes MODEL.code; empty deletes; syntax errors never reach the model', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    p.win.showTab('settings');
    const prop = settingsPropByLabel(p.doc, 'Custom code (advanced)');
    const ta = prop.querySelector('textarea');
    ta.value = 'window.ycHooks = {};'; fire(p.win, ta, 'input');
    expect(p.win.FB.model.code).toBe('window.ycHooks = {};');
    ta.value = 'function ({'; fire(p.win, ta, 'input');
    expect(p.win.FB.model.code).toBe('window.ycHooks = {};');   // blocked
    expect(ta.classList.contains('bad')).toBe(true);
    ta.value = ''; fire(p.win, ta, 'input');
    expect('code' in p.win.FB.model).toBe(false);
  });

  test('hooks ⇄ code mutual exclusion (input-time rejection + disabled state)', async () => {
    const p = await ready(bootBuilder(Object.assign(sectionsDraft(), { hooks: 'some_hook' })));
    p.win.showTab('settings');
    let codeTa = settingsPropByLabel(p.doc, 'Custom code (advanced)').querySelector('textarea');
    expect(codeTa.disabled).toBe(true);
    // clear hooks → code becomes editable on re-render (the hooks editor calls
    // renderSettings(), so the panel is rebuilt in place — no tab switch)
    const hooksIn = settingsPropByLabel(p.doc, 'Hooks file').querySelector('input');
    hooksIn.value = ''; fire(p.win, hooksIn, 'input');
    await sleep(10);
    expect('hooks' in p.win.FB.model).toBe(false);
    codeTa = settingsPropByLabel(p.doc, 'Custom code (advanced)').querySelector('textarea');
    expect(codeTa.disabled).toBe(false);
    codeTa.value = '1 + 1;'; fire(p.win, codeTa, 'input');
    expect(p.win.FB.model.code).toBe('1 + 1;');
    // typing code doesn't re-render (focus preservation) — the CURRENT hooks
    // input rejects at validate time instead:
    const hooksNow = settingsPropByLabel(p.doc, 'Hooks file').querySelector('input');
    hooksNow.value = 'other_hook'; fire(p.win, hooksNow, 'input');
    expect('hooks' in p.win.FB.model).toBe(false);          // blocked
    expect(hooksNow.classList.contains('bad')).toBe(true);
    // the disabled state applies on the NEXT settings render — which is what
    // re-activating the Settings tab does (X3.5)
    p.win.showTab('settings');
    await sleep(10);
    const hooksIn2 = settingsPropByLabel(p.doc, 'Hooks file').querySelector('input');
    expect(hooksIn2.disabled).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// JS — JSON tab
// ═════════════════════════════════════════════════════════════════════════════

describe('JS JSON tab with tabbed definitions', () => {
  test('pasting a tabbed def flattens into the model; normalized print = serialized shape', async () => {
    const p = await ready(bootBuilder(sectionsDraft()));
    p.win.showTab('json');
    await sleep(10);
    const ta = p.doc.getElementById('jsonTa');
    ta.value = JSON.stringify(tabbedDraft());
    fire(p.win, ta, 'input');
    p.win.applyJson();
    await sleep(10);
    expect(p.win.FB.tabsMeta.map(t => t.label)).toEqual(['Alpha', 'Beta']);
    expect(p.win.FB.model.sections.length).toBe(5);   // flat
    expect(JSON.parse(ta.value)).toEqual(tabbedDraft());   // normalized print, serialized shape
    svc.validateDefinition(ser(p));
  });
});
