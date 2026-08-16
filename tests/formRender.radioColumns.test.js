/**
 * Radio "columns" — the checkgroup A5 knob extended to radio groups.
 *
 * Same jsdom-integration harness as formRender.slice25A.test.js: the REAL
 * render.html with runScripts:'dangerously', the REAL /js/yc-forms.js via
 * ResourceLoader, apiSend stubbed.
 *
 * Covers:
 *   - render: columns 1 → "1fr", 2/3 → repeat(N,1fr), PLUS the .yc-radio-grid
 *     class (without it the inline grid-template-columns is inert, because
 *     .yc-radio-group is display:flex)
 *   - render: absent columns → plain .yc-radio-group, no style attr (the
 *     pre-existing flex row is untouched)
 *   - validation: radio accepts 1–3, rejects 0/4/1.5/"2", and columns on any
 *     other type is still rejected
 *
 *   npx jest tests/formRender.radioColumns.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const YC_CSS      = fs.readFileSync(path.join(ROOT, 'public/css/yc-forms.css'), 'utf8');
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

function makeDef(overrides) {
  return Object.assign({
    dataMode: 'live',
    autosave: false,
    endpoints: { load: { method: 'GET', url: '/api/cases/{linkId}', path: 'case' } },
    onSubmit: {},
    sections: [
      { title: 'Main', rows: [
        { fields: [
          { name: 'one_col',   type: 'radio', columns: 1, options: ['A', 'B'] },
          { name: 'two_col',   type: 'radio', columns: 2, options: ['A', 'B', 'C'] },
          { name: 'three_col', type: 'radio', columns: 3, options: ['A', 'B', 'C'] },
          { name: 'plain',     type: 'radio', options: ['A', 'B'] },
          { name: 'notes',     type: 'text' },
        ] },
      ] },
    ],
  }, overrides || {});
}

function bootPage(opts = {}) {
  const def = opts.definition || makeDef();
  const apiSend = async (u) => {
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: 'Radio cols', link_type: 'case', schema_version: 1, definition: def };
    }
    if (u.startsWith('/api/cases/')) return { case: { case_id: 'CASETEST1' } };
    if (u.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
    if (u === '/resolve') return { status: 'success', text: '', unresolved: [] };
    if (u.startsWith('/api/forms/draft')) return {};
    if (u === '/api/log') return {};
    throw new Error('unstubbed apiSend: ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url: 'https://app.test/forms/render.html?form_key=radio_cols_test&case_id=CASETEST1',
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend = apiSend;
    },
  });
  DOMS.push(dom);
  return { dom };
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

const groupOf = (d, name) => d.querySelector('input[name="' + name + '"]').closest('.yc-radio-group');

// ═════════════════════════════════════════════════════════════════════════════
// Rendering
// ═════════════════════════════════════════════════════════════════════════════

describe('radio columns rendering', () => {
  test('1 → 1fr, 2/3 → repeat(N,1fr), each with .yc-radio-grid; absent → plain flex group', async () => {
    const p = bootPage();
    const w = await ready(p.dom);
    const d = w.document;

    const one = groupOf(d, 'one_col');
    expect(one.getAttribute('style')).toBe('grid-template-columns:1fr;');
    expect(one.classList.contains('yc-radio-grid')).toBe(true);

    const two = groupOf(d, 'two_col');
    expect(two.getAttribute('style')).toBe('grid-template-columns:repeat(2,1fr);');
    expect(two.classList.contains('yc-radio-grid')).toBe(true);

    const three = groupOf(d, 'three_col');
    expect(three.getAttribute('style')).toBe('grid-template-columns:repeat(3,1fr);');
    expect(three.classList.contains('yc-radio-grid')).toBe(true);

    // untouched default: flex row, no inline style, no modifier class
    const plain = groupOf(d, 'plain');
    expect(plain.hasAttribute('style')).toBe(false);
    expect(plain.classList.contains('yc-radio-grid')).toBe(false);

    // options still render normally under the grid
    expect(d.querySelectorAll('input[name="two_col"]').length).toBe(3);
  });

  test('the modifier class actually exists in the stylesheet as a grid', () => {
    // Without display:grid on .yc-radio-grid the inline grid-template-columns
    // is a no-op on the flex .yc-radio-group — guard that regression.
    expect(YC_CSS).toMatch(/\.yc-radio-group\.yc-radio-grid\s*\{[^}]*display:\s*grid/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Validation
// ═════════════════════════════════════════════════════════════════════════════

describe('radio columns validation', () => {
  const expectReject = (def, re) => expect(() => svc.validateDefinition(def)).toThrow(re);

  test('radio accepts 1–3', () => {
    for (const n of [1, 2, 3]) {
      const def = makeDef();
      def.sections[0].rows[0].fields[0].columns = n;
      expect(() => svc.validateDefinition(def)).not.toThrow();
    }
  });

  test('radio rejects out-of-range / non-integer', () => {
    for (const bad of [0, 4, 1.5, '2']) {
      const def = makeDef();
      def.sections[0].rows[0].fields[0].columns = bad;
      expectReject(def, /columns must be an integer between 1 and 3/);
    }
  });

  test('columns still rejected on other types', () => {
    const def = makeDef();
    def.sections[0].rows[0].fields[4].columns = 2;      // text
    expectReject(def, /columns is only allowed on type "checkgroup" or "radio"/);

    const sel = makeDef();
    sel.sections[0].rows[0].fields[4] = { name: 'notes', type: 'select', options: ['A'], columns: 2 };
    expectReject(sel, /columns is only allowed on type "checkgroup" or "radio"/);
  });
});
