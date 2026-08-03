/**
 * Slice 2.6 verification — render.html (tabs / sticky regions, type:"embed",
 * per-form `code`) + formTemplateService validation additions + the tpl5/tpl6
 * hook-file → code migration equivalence proofs.
 *
 * Same harness style as formRender.slice25B.test.js: jsdom INTEGRATION tests
 * against the REAL files (render.html with runScripts:'dangerously', the real
 * /js/yc-forms.js and /forms/hooks/_yc_hook_util.js via ResourceLoader,
 * apiSend + firmData stubbed per test). ZERO yc-forms.js / yc-forms.css
 * changes in this slice — tabs ride entirely on renderer markup + the
 * existing setupTabs.
 *
 * Covers (SLICE_2_6_SPEC.md + addendum v2):
 *   T  tabs: §4.5 markup (bar/panels/sticky, first active, index-matched,
 *      inside the form), setupTabs click routing, cross-tab conditions,
 *      sections-mode emits ZERO tab artifacts (structural byte-identity
 *      proxy — the full pristine-vs-2.6 sweep is a session verification)
 *   R  tab-reveal on validation failure: switch to the erroring panel,
 *      sticky errors don't switch, valid saves don't switch
 *   E  embed: markup contract (iframe attrs, data-yc-embed, no .yc-error),
 *      default/custom height, collect()/validate() exclusion, showWhen,
 *      non-https degrade
 *   C  code: executes on live render (ycHooks.onLoad applied + clean
 *      baseline, onSave called), NEVER in preview (both preview modes),
 *      broken code degrades
 *   V  validator: container rules, tab shape, embed rules, code rules,
 *      signature across containers with embeds excluded, the committed issn
 *      fixture validates
 *   Q  migration equivalence: tpl5 (341_notes) and tpl6 (case_details)
 *      rendered under hooks-file path (legacy fixtures) vs code path
 *      (fixtures staged into the DB) — collect() and behaviours identical
 *
 *   npx jest tests/formRender.slice26.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const HOOK_UTIL   = fs.readFileSync(path.join(ROOT, 'public/forms/hooks/_yc_hook_util.js'), 'utf8');
const svc         = require(path.join(ROOT, 'services/formTemplateService.js'));

const FX = (f) => path.join(__dirname, 'fixtures/slice26', f);
const LEGACY_NOTES_341 = fs.readFileSync(FX('legacy_notes_341.js'), 'utf8');
const LEGACY_CD_BK2    = fs.readFileSync(FX('legacy_case_details_bk2.js'), 'utf8');
const TPL5_CODE        = fs.readFileSync(FX('tpl5_code.js'), 'utf8');
const TPL6_CODE        = fs.readFileSync(FX('tpl6_code.js'), 'utf8');
const TPL5_DEF         = JSON.parse(fs.readFileSync(FX('tpl5_draft_definition.json'), 'utf8'));
const TPL6_DEF         = JSON.parse(fs.readFileSync(FX('tpl6_draft_definition.json'), 'utf8'));
const ISSN_DEF         = JSON.parse(fs.readFileSync(path.join(ROOT, 'ref/2026-08-03_issn_tabs_definition.json'), 'utf8'));

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p === '/forms/hooks/_yc_hook_util.js') return Promise.resolve(Buffer.from(HOOK_UTIL));
    if (p === '/forms/hooks/notes_341.js') return Promise.resolve(Buffer.from(LEGACY_NOTES_341));
    if (p === '/forms/hooks/case_details_bk2.js') return Promise.resolve(Buffer.from(LEGACY_CD_BK2));
    if (p.startsWith('/forms/hooks/')) return Promise.reject(new Error('404 ' + p));
    return Promise.resolve(Buffer.from(''));
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

const TRUSTEES = [
  { name: 'K. Jin Lim',     case_type: 7,  link: 'https://zoom.example/lim' },
  { name: 'Tammy L. Terry', case_type: 13, link: 'https://zoom.example/terry' },
];
const FIRM_DATA = { settings: { trustees: TRUSTEES } };

// ── A tabbed exercising definition ─────────────────────────────────────────
function tabbedDef(overrides) {
  return Object.assign({
    dataMode: 'live',
    autosave: false,
    stickyTop: [
      { rows: [{ fields: [
        { name: 'sticky_head', type: 'text', label: 'Header' },
      ] }] },
    ],
    tabs: [
      { label: 'One', sections: [
        { title: 'First', rows: [
          { fields: [
            { name: 'a1', type: 'text', label: 'A1' },
            { name: 'controller', type: 'radio', label: 'Ctl', options: ['Yes', 'No'] },
          ] },
        ] },
      ] },
      { label: 'Two', sections: [
        { title: 'Second', rows: [
          { fields: [{ name: 'b1', type: 'text', label: 'B1', required: true }] },
          { showWhen: { field: 'controller', op: 'eq', value: 'Yes' },
            fields: [{ name: 'b2', type: 'text', label: 'B2' }] },
        ] },
        { repeater: 'items', title: 'Items', addLabel: '+ Add',
          fields: [{ name: 'it_name', type: 'text', label: 'Name' }] },
      ] },
    ],
    stickyBottom: [
      { rows: [{ fields: [
        { name: 'sticky_notes', type: 'textarea', label: 'Notes', rows: 2 },
      ] }] },
    ],
  }, overrides || {});
}

function sectionsDef(overrides) {
  return Object.assign({
    dataMode: 'live',
    autosave: false,
    sections: [
      { title: 'Only', rows: [
        { fields: [{ name: 'x1', type: 'text', label: 'X1' }] },
      ] },
    ],
  }, overrides || {});
}

const CASE_ROW = {
  case_id: 'CASE26', case_number: '25-40001', case_number_full: '25-40001-mlo',
  case_trustee: 'Tammy L. Terry', case_chapter: '', case_subtype: '',
  case_341_current: '2026-03-01T10:30', '341_appt_id': 88,
};

function bootPage(opts = {}) {
  const def    = opts.definition || tabbedDef();
  const linkId = opts.linkId !== undefined ? opts.linkId : 'CASE26';
  const calls  = [];
  const url = opts.preview
    ? 'https://app.test/forms/render.html?template_id=9&preview=1' + (opts.previewLinkId ? '&link_id=' + opts.previewLinkId : '')
    : 'https://app.test/forms/render.html?form_key=slice26_test&case_id=' + encodeURIComponent(linkId);

  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: '2.6 Test', link_type: 'case', schema_version: 1, definition: def };
    }
    if (u.startsWith('/api/form-templates/')) {   // preview fetch
      return { status: 'success', template: { form_key: 'slice26_test', title: '2.6 Test',
               link_type: 'case', schema_version: 1, draft_definition: def } };
    }
    if (u.startsWith('/api/cases/') && method === 'GET') {
      return { case: opts.caseRow || CASE_ROW, clients: opts.clients || [], appts: opts.appts || [] };
    }
    if (u.startsWith('/api/cases/') && method === 'PATCH') return { status: 'success' };
    if (u.startsWith('/api/forms/latest')) return { submitted: opts.submitted || null, draft: null };
    if (u === '/resolve') {
      if (opts.resolve) return opts.resolve(body);
      return { status: 'success', text: (body && body.text) || '', unresolved: [] };
    }
    if (u === '/api/forms/submit') return { id: 91, version: 1, updated_at: new Date().toISOString() };
    if (u.startsWith('/api/forms/draft')) return {};
    if (u.startsWith('/api/contacts/')) return { status: 'success' };
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
      window.apiSend = apiSend;
      if (opts.firmData !== null) window.firmData = opts.firmData !== undefined ? opts.firmData : FIRM_DATA;
    },
  });
  DOMS.push(dom);
  return { dom, win: dom.window, doc: dom.window.document, calls };
}

async function ready(p, opts = {}) {
  for (let i = 0; i < 400; i++) {
    const fatal = p.doc.querySelector('.ycr-fatal');
    if (fatal && !opts.allowFatal) throw new Error('fatal: ' + fatal.textContent);
    if (fatal) return p;
    const ov = p.doc.querySelector('.yc-loading-overlay');
    if (p.win.ycForm && ov && ov.style.display === 'none') break;
    await sleep(10);
  }
  if (!p.win.ycForm && !opts.allowFatal) throw new Error('never initialized');
  await sleep(60);   // afterInit (setupTabs + tab-reveal) + code onLoad settle
  return p;
}
const q  = (p, sel) => p.doc.querySelector(sel);
const qa = (p, sel) => [...p.doc.querySelectorAll(sel)];
const fld = (p, n) => q(p, '[name="' + n + '"]');

// ═════════════════════════════════════════════════════════════════════════════
// T — tabs rendering & routing
// ═════════════════════════════════════════════════════════════════════════════

describe('T tabs markup & routing (§4.5)', () => {
  test('bar + index-matched panels + sticky regions, all inside the form, first active', async () => {
    const p = await ready(bootPage());
    const form = q(p, '#dynamicForm') || q(p, 'form');
    const bar = form.querySelectorAll('.yc-tab-bar button');
    const panels = form.querySelectorAll('.yc-tab-panel');
    const sticky = form.querySelectorAll('.yc-tab-sticky');
    expect(bar.length).toBe(2);
    expect(panels.length).toBe(2);
    expect(sticky.length).toBe(2);
    expect(bar[0].textContent).toBe('One');
    expect(bar[1].textContent).toBe('Two');
    expect(bar[0].classList.contains('active')).toBe(true);
    expect(bar[1].classList.contains('active')).toBe(false);
    expect(panels[0].classList.contains('active')).toBe(true);
    expect(panels[1].classList.contains('active')).toBe(false);
    // structure order: stickyTop, .yc-tabs, stickyBottom, saveBtn last
    const kids = [...form.children].map(n => n.className || n.id);
    expect(kids[0]).toContain('yc-tab-sticky');
    expect(kids[1]).toContain('yc-tabs');
    expect(kids[2]).toContain('yc-tab-sticky');
    // fields routed into their containers
    expect(sticky[0].querySelector('[name="sticky_head"]')).toBeTruthy();
    expect(panels[0].querySelector('[name="a1"]')).toBeTruthy();
    expect(panels[1].querySelector('[name="b1"]')).toBeTruthy();
    expect(panels[1].querySelector('#ycRep_items')).toBeTruthy();   // repeater in its panel
    expect(sticky[1].querySelector('[name="sticky_notes"]')).toBeTruthy();
  });

  test('setupTabs wired after init: clicking a bar button switches panels', async () => {
    const p = await ready(bootPage());
    const bar = qa(p, '.yc-tab-bar button');
    const panels = qa(p, '.yc-tab-panel');
    bar[1].click();
    expect(panels[1].classList.contains('active')).toBe(true);
    expect(panels[0].classList.contains('active')).toBe(false);
    expect(bar[1].classList.contains('active')).toBe(true);
    bar[0].click();
    expect(panels[0].classList.contains('active')).toBe(true);
  });

  test('conditions reach across tabs (controller on tab 1 governs a row on tab 2)', async () => {
    const p = await ready(bootPage());
    const wrap = fld(p, 'b2').closest('[data-yc-show-when]');
    expect(wrap.style.display).toBe('none');
    const yes = q(p, '[name="controller"][value="Yes"]');
    yes.checked = true;
    yes.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await sleep(10);
    expect(wrap.style.display).not.toBe('none');
  });

  test('sections-mode definitions emit ZERO tab artifacts (byte-identity proxy)', async () => {
    const p = await ready(bootPage({ definition: sectionsDef() }));
    expect(qa(p, '.yc-tabs').length).toBe(0);
    expect(qa(p, '.yc-tab-bar').length).toBe(0);
    expect(qa(p, '.yc-tab-panel').length).toBe(0);
    expect(qa(p, '.yc-tab-sticky').length).toBe(0);
    expect(fld(p, 'x1')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R — tab-reveal on validation failure
// ═════════════════════════════════════════════════════════════════════════════

describe('R tab-reveal on validation failure', () => {
  test('save with the error on an INACTIVE tab activates that tab and shows the error', async () => {
    const p = await ready(bootPage());   // b1 required, lives on tab 2; tab 1 active
    expect(qa(p, '.yc-tab-panel')[1].classList.contains('active')).toBe(false);
    q(p, '#saveBtn').click();
    await sleep(30);
    const panels = qa(p, '.yc-tab-panel');
    expect(panels[1].classList.contains('active')).toBe(true);
    expect(panels[0].classList.contains('active')).toBe(false);
    const err = fld(p, 'b1').closest('.yc-field').querySelector('.yc-error');
    expect(err.classList.contains('visible')).toBe(true);
  });

  test('sticky-region errors never switch tabs (always visible — scroll only)', async () => {
    const def = tabbedDef();
    def.stickyTop[0].rows[0].fields[0].required = true;   // sticky_head required
    delete def.tabs[1].sections[0].rows[0].fields[0].required;   // b1 no longer required
    const p = await ready(bootPage({ definition: def }));
    qa(p, '.yc-tab-bar button')[1].click();   // move to tab 2
    q(p, '#saveBtn').click();
    await sleep(30);
    const panels = qa(p, '.yc-tab-panel');
    expect(panels[1].classList.contains('active')).toBe(true);   // unchanged
    const err = fld(p, 'sticky_head').closest('.yc-field').querySelector('.yc-error');
    expect(err.classList.contains('visible')).toBe(true);
  });

  test('a valid save does not switch tabs', async () => {
    const p = await ready(bootPage());
    fld(p, 'b1').value = 'filled';   // satisfy the requirement (hidden fields still validate)
    q(p, '#saveBtn').click();
    await sleep(50);
    expect(qa(p, '.yc-tab-panel')[0].classList.contains('active')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E — embed
// ═════════════════════════════════════════════════════════════════════════════

function embedDef(field) {
  return sectionsDef({
    sections: [{ title: 'S', rows: [
      { fields: [
        { name: 'plain', type: 'text', label: 'Plain' },
        Object.assign({ name: 'cal', type: 'embed', src: 'https://calendly.example/x', label: 'Booking' }, field || {}),
      ] },
    ] }],
  });
}

describe('E embed (§4.3, internal-only)', () => {
  test('markup contract: .yc-field without .yc-error, iframe attrs, default height 600', async () => {
    const p = await ready(bootPage({ definition: embedDef() }));
    const frame = q(p, '[data-yc-embed="cal"]');
    expect(frame).toBeTruthy();
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('https://calendly.example/x');
    expect(frame.getAttribute('loading')).toBe('lazy');
    expect(frame.getAttribute('title')).toBe('Booking');   // label wins
    expect(frame.getAttribute('style')).toContain('height:600px');
    const wrap = frame.closest('.yc-field');
    expect(wrap.querySelector('.yc-error')).toBeNull();
    expect(wrap.querySelector('label').textContent).toBe('Booking');
  });

  test('custom height honored; title falls back to name without a label', async () => {
    const p = await ready(bootPage({ definition: embedDef({ height: 850, label: undefined }) }));
    const frame = q(p, '[data-yc-embed="cal"]');
    expect(frame.getAttribute('style')).toContain('height:850px');
    expect(frame.getAttribute('title')).toBe('cal');
  });

  test('excluded from collect() and from validation/save', async () => {
    const p = await ready(bootPage({ definition: embedDef() }));
    const c = p.win.ycForm.collect();
    expect('cal' in c).toBe(false);
    expect('plain' in c).toBe(true);
    const el = fld(p, 'plain');
    el.value = 'dirty';
    el.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    q(p, '#saveBtn').click();   // must not trip validation on the embed
    await sleep(80);
    expect(p.calls.some(x => x.url === '/api/forms/submit')).toBe(true);
  });

  test('showWhen on an embed hides its wrapper like any field', async () => {
    const p = await ready(bootPage({ definition: embedDef({
      showWhen: { field: 'plain', op: 'notEmpty' } }) }));
    const wrap = q(p, '[data-yc-embed="cal"]').closest('[data-yc-show-when]');
    expect(wrap.style.display).toBe('none');
    const el = fld(p, 'plain');
    el.value = 'x';
    el.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await sleep(10);
    expect(wrap.style.display).not.toBe('none');
  });

  test('non-https src degrades: no iframe, field wrapper still renders (belt-and-braces)', async () => {
    const p = await ready(bootPage({ definition: embedDef({ src: 'http://insecure.example/x' }) }));
    expect(q(p, '[data-yc-embed="cal"]')).toBeNull();
    expect(qa(p, 'iframe').length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C — per-form code
// ═════════════════════════════════════════════════════════════════════════════

const PROBE_CODE = [
  "window.__probe = { onLoadRan: false, onSaveRan: false };",
  "window.ycHooks = {",
  "  async onLoad(form) {",
  "    window.__probe.onLoadRan = true;",
  "    var el = form.el.querySelector('[name=\"x1\"]');",
  "    if (el && !el.value) el.value = 'from-code';",
  "  },",
  "  async onSave(form, result) { window.__probe.onSaveRan = true; },",
  "};",
].join('\n');

describe('C per-form code (addendum A1)', () => {
  test('live render: code runs before init, onLoad applies, value is part of the clean baseline', async () => {
    const p = await ready(bootPage({ definition: sectionsDef({ code: PROBE_CODE }) }));
    expect(p.win.__probe.onLoadRan).toBe(true);
    expect(fld(p, 'x1').value).toBe('from-code');
    // written inside the generated onLoad → before resetBaseline → not dirty
    expect(Object.keys(p.win.ycForm.getDiff()).length).toBe(0);
  });

  test('onSave fires on save', async () => {
    const p = await ready(bootPage({ definition: sectionsDef({ code: PROBE_CODE }) }));
    const el = fld(p, 'x1');
    el.value = 'edited';
    el.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    q(p, '#saveBtn').click();
    await sleep(100);
    expect(p.win.__probe.onSaveRan).toBe(true);
  });

  test('preview (layout mode): code NEVER executes', async () => {
    const p = await ready(bootPage({ definition: sectionsDef({ code: PROBE_CODE }), preview: true }));
    expect(p.win.__probe).toBeUndefined();
    expect(p.win.ycHooks).toBeUndefined();
    expect(fld(p, 'x1').value).toBe('');
  });

  test('preview with link_id: code still NEVER executes', async () => {
    const p = await ready(bootPage({ definition: sectionsDef({ code: PROBE_CODE }),
      preview: true, previewLinkId: 'CASE26' }));
    expect(p.win.__probe).toBeUndefined();
    expect(fld(p, 'x1').value).toBe('');
  });

  test('broken code degrades — init completes, form renders', async () => {
    const p = await ready(bootPage({ definition: sectionsDef({
      code: "throw new Error('deliberate top-level failure');" }) }));
    expect(p.win.ycForm).toBeTruthy();
    expect(fld(p, 'x1')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// V — validator (§7 additions)
// ═════════════════════════════════════════════════════════════════════════════

describe('V validateDefinition (2.6)', () => {
  const base = () => ({ sections: [{ rows: [{ fields: [{ name: 'x', type: 'text' }] }] }] });
  const tb = () => ({ tabs: [{ label: 'A', sections: [{ rows: [{ fields: [{ name: 'x', type: 'text' }] }] }] }] });
  const bad = (def, re) => expect(() => svc.validateDefinition(def)).toThrow(re);
  const ok  = (def) => expect(() => svc.validateDefinition(def)).not.toThrow();

  test('exactly one of sections | tabs', () => {
    bad(Object.assign(base(), tb()), /exactly one of/);
    bad({}, /sections/);
    ok(base());
    ok(tb());
  });

  test('sticky regions only with tabs; tab shape rules', () => {
    bad(Object.assign(base(), { stickyTop: [] }), /only allowed together with "tabs"/);
    bad({ tabs: [] }, /non-empty/);
    bad({ tabs: [{ label: 'A', sections: [{ rows: [{ fields: [{ name: 'x', type: 'text' }] }] }], showWhen: {} }] }, /unknown key/);
    bad({ tabs: [{ label: '', sections: [{ rows: [{ fields: [{ name: 'x', type: 'text' }] }] }] }] }, /label/);
    bad({ tabs: [{ label: 'x'.repeat(61), sections: [{ rows: [{ fields: [{ name: 'x', type: 'text' }] }] }] }] }, /60/);
    bad({ tabs: [{ label: 'A', sections: [] }] }, /non-empty/);
    const d = tb();
    d.stickyTop = [{ rows: [{ fields: [{ name: 'h', type: 'hidden' }] }] }];
    ok(d);
  });

  test('name scoping and condition targets span all containers', () => {
    // duplicate name across two tabs → rejected
    bad({ tabs: [
      { label: 'A', sections: [{ rows: [{ fields: [{ name: 'dup', type: 'text' }] }] }] },
      { label: 'B', sections: [{ rows: [{ fields: [{ name: 'dup', type: 'text' }] }] }] },
    ] }, /dup/);
    // condition on tab B targeting a field on tab A → legal
    ok({ tabs: [
      { label: 'A', sections: [{ rows: [{ fields: [{ name: 'src', type: 'text' }] }] }] },
      { label: 'B', sections: [{ rows: [{ fields: [{ name: 'dst', type: 'text',
          showWhen: { field: 'src', op: 'notEmpty' } }] }] }] },
    ] });
  });

  test('embed rules', () => {
    const emb = (f) => ({ sections: [{ rows: [{ fields: [
      { name: 'x', type: 'text' },
      Object.assign({ name: 'e', type: 'embed', src: 'https://x.example/' }, f || {}),
    ] }] }] });
    ok(emb());
    ok(emb({ height: 720, showWhen: { field: 'x', op: 'notEmpty' } }));
    bad(emb({ src: undefined }), /src is required/);
    bad(emb({ src: 'http://x.example/' }), /https/);
    bad(emb({ src: 'not a url' }), /valid URL/);
    bad(emb({ src: 'https://x.example/' + 'a'.repeat(2000) }), /2000/);
    bad(emb({ height: 0 }), /positive integer/);
    bad(emb({ height: 1.5 }), /positive integer/);
    for (const k of ['required', 'apiColumn', 'prefill', 'mask', 'readonly']) {
      bad(emb({ [k]: k === 'required' || k === 'readonly' ? true : 'v' }), /not allowed on type "embed"/);
    }
    bad(emb({ requiredWhen: { field: 'x', op: 'notEmpty' } }), /not allowed on type "embed"/);
    // in a repeater
    bad({ sections: [{ repeater: 'r', fields: [{ name: 'e', type: 'embed', src: 'https://x.example/' }] }] },
        /not allowed inside repeaters/);
    // conditions targeting an embed
    bad({ sections: [{ rows: [{ fields: [
      { name: 'e', type: 'embed', src: 'https://x.example/' },
      { name: 't', type: 'text', showWhen: { field: 'e', op: 'notEmpty' } },
    ] }] }] }, /targets an embed/);
    // derive touching an embed
    bad({ derive: [{ target: 'e', from: 'd1', op: 'addDays', n: 1 }],
      sections: [{ rows: [{ fields: [
        { name: 'e', type: 'embed', src: 'https://x.example/' },
        { name: 'd1', type: 'date' },
      ] }] }] }, /derive cannot reference an embed/);
  });

  test('code rules', () => {
    ok(Object.assign(base(), { code: "window.ycHooks = {};" }));
    bad(Object.assign(base(), { code: 42 }), /string/);
    bad(Object.assign(base(), { code: 'x'.repeat(32769) }), /32768/);
    bad(Object.assign(base(), { code: 'function ({' }), /syntax error/);
    bad(Object.assign(base(), { code: '1+1', hooks: 'a' }), /mutually exclusive/);
  });

  test('fieldSignature spans containers and excludes embeds', () => {
    const tabbed = {
      stickyTop: [{ rows: [{ fields: [{ name: 'h', type: 'hidden' }] }] }],
      tabs: [
        { label: 'A', sections: [{ rows: [{ fields: [
          { name: 'a', type: 'text' },
          { name: 'e', type: 'embed', src: 'https://x.example/' },
        ] }] }] },
        { label: 'B', sections: [{ repeater: 'r', fields: [{ name: 'rf', type: 'text' }] }] },
      ],
      stickyBottom: [{ rows: [{ fields: [{ name: 'z', type: 'textarea' }] }] }],
    };
    const flat = { sections: [
      { rows: [{ fields: [{ name: 'h', type: 'hidden' }, { name: 'a', type: 'text' },
                          { name: 'z', type: 'textarea' }] }] },
      { repeater: 'r', fields: [{ name: 'rf', type: 'text' }] },
    ] };
    expect(svc.fieldSignature(tabbed)).toBe(svc.fieldSignature(flat));
    expect(svc.fieldSignature(tabbed)).not.toContain('embed');
  });

  test('the committed issn tabbed definition validates', () => {
    ok(ISSN_DEF);
    expect(Array.isArray(ISSN_DEF.tabs)).toBe(true);
    expect(ISSN_DEF.tabs.length).toBe(6);
    expect(typeof ISSN_DEF.code).toBe('string');
    expect(ISSN_DEF.hooks).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Q — migration equivalence: hook-file path vs code path
// ═════════════════════════════════════════════════════════════════════════════

describe('Q tpl5 (341_notes): hooks file ≡ code', () => {
  const CLIENTS = [
    { contact_id: 501, relate_type: 'Primary',   contact_fname: 'Pat', contact_mname: 'Q', contact_lname: 'Tester' },
    { contact_id: 502, relate_type: 'Secondary', contact_fname: 'Sam', contact_mname: '',  contact_lname: 'Tester' },
  ];
  const APPTS = [{ appt_id: 88, appt_with: 9 }];
  const resolve = (body) => {
    if (body && body.text === '{{users.email}}|||{{users.user_name}}') {
      return { status: 'success', text: 'att@x.test|||Atty Test' };
    }
    return { status: 'success', text: (body && body.text) || '', unresolved: [] };
  };

  async function renderBoth() {
    expect(TPL5_DEF.hooks).toBe('notes_341');
    const codeDef = JSON.parse(JSON.stringify(TPL5_DEF));
    delete codeDef.hooks;
    codeDef.code = TPL5_CODE;
    svc.validateDefinition(codeDef);   // the staged draft must validate

    const a = await ready(bootPage({ definition: TPL5_DEF, clients: CLIENTS, appts: APPTS, resolve }));
    const b = await ready(bootPage({ definition: codeDef, clients: CLIENTS, appts: APPTS, resolve }));
    await sleep(120);   // attorney resolve round-trip
    return [a, b];
  }

  test('collect() identical; header, parties, and attorney behaviours match', async () => {
    const [a, b] = await renderBoth();
    const ca = a.win.ycForm.collect();
    const cb = b.win.ycForm.collect();
    expect(cb).toEqual(ca);
    // absolute assertions so the test still means something on its own
    expect(cb.case_number).toBe('25-40001-mlo');          // full||short fallback
    expect(cb.debtor_fname).toBe('Pat');
    expect(cb.codebtor_fname).toBe('Sam');
    expect(cb.trustee).toBe('Tammy L. Terry');
    expect(String(cb.attorney_user_id)).toBe('9');        // 341_appt_id → appt_with
    expect(cb.attorney_email).toBe('att@x.test');
    expect(cb.attorney_name).toBe('Atty Test');
  }, 30000);
});

describe('Q tpl6 (case_details): hooks file ≡ code', () => {
  async function renderBoth() {
    expect(TPL6_DEF.hooks).toBe('case_details_bk2');
    const codeDef = JSON.parse(JSON.stringify(TPL6_DEF));
    delete codeDef.hooks;
    codeDef.code = TPL6_CODE;
    svc.validateDefinition(codeDef);

    const a = await ready(bootPage({ definition: TPL6_DEF }));
    const b = await ready(bootPage({ definition: codeDef }));
    return [a, b];
  }

  function driveAndBuild(p) {
    const w = p.win, d = p.doc;
    // B: trustee change rewrites the hidden 341 link from firmData
    const sel = d.querySelector('[name="case_trustee"]');
    sel.value = 'K. Jin Lim';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    // D + E: docket split + chapter mirror ride _buildPatchPayload
    const docket = d.querySelector('[name="case_number"]');
    docket.value = '25-40002-mar';
    docket.dispatchEvent(new w.Event('change', { bubbles: true }));
    const ch = d.querySelector('[name="case_chapter"]');
    if (ch) {
      ch.value = '7';
      ch.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    return {
      link: d.querySelector('[name="case_341_link"]') ? d.querySelector('[name="case_341_link"]').value : null,
      payload: w.ycForm._buildPatchPayload(),
    };
  }

  test('trustee→341-link, docket split, chapter mirror identical', async () => {
    const [a, b] = await renderBoth();
    const ra = driveAndBuild(a);
    const rb = driveAndBuild(b);
    expect(rb.link).toBe(ra.link);
    expect(rb.payload).toEqual(ra.payload);
    expect(rb.link).toBe('https://zoom.example/lim');
    expect(rb.payload.case_number).toBe('25-40002');
    expect(rb.payload.case_number_full).toBe('25-40002-mar');
    if ('case_chapter' in rb.payload) {
      expect(rb.payload.case_subtype).toBe('Chapter 7');
    }
  }, 30000);
});
