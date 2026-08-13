/**
 * X4 — render.html submission-view mode (?view_submission=N).
 *
 * jsdom INTEGRATION against the REAL files (formRender.slice2 harness): the
 * actual render.html runs with runScripts:'dangerously', the actual
 * /js/yc-forms.js is served by a ResourceLoader, window.apiSend (parent ===
 * window in a frameless jsdom page) is stubbed per test.
 *
 * Locks:
 *   - boot is fed by GET /api/forms/submissions/:id/render and populates the
 *     stored answers (text / radio / checkgroup CSV), with showWhen states
 *     matching the answers in both directions
 *   - the form is FORCE-LOCKED: .yc-readonly, no visible toggle, saveBtn
 *     disabled + hidden
 *   - no-write discipline: the only network traffic is the render fetch plus
 *     yc-forms' unconditional /api/forms/latest probe, which FAILS (linkId is
 *     '' by design → the real route 400s) and init survives; no draft, no
 *     /resolve, no /api/log, no submit — before or after user input
 *   - banner content: id/title/schema/linkage; schema_matched:false adds the
 *     .ycr-view-warn line
 *   - preview-grade discipline: template `code` is NOT executed in view mode
 *
 *   npx jest tests/formrender.x4view.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p.startsWith('/forms/hooks/')) return Promise.reject(new Error('404 ' + p));
    return Promise.resolve(Buffer.from('')); // CDN css/js
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

// Small definition exercising the populate paths that matter for a view:
// text, radio, checkgroup (CSV round-trip), showWhen in both directions.
const VIEW_DEF = {
  toggle: true,               // definition ASKS for a toggle — view must override
  saveLabel: 'Submit',
  sections: [{
    title: 'S',
    rows: [
      { fields: [
        { name: 'name',    type: 'text',  label: 'Name' },
        { name: 'housing', type: 'radio', label: 'Housing', options: ['Own', 'Rent'] },
      ] },
      { fields: [
        { name: 'extras', type: 'checkgroup', label: 'Extras', options: ['A', 'B', 'C'] },
        { name: 'followup', type: 'text', label: 'Follow up',
          showWhen: { field: 'housing', op: 'eq', value: 'Rent' } },
        { name: 'ownOnly', type: 'text', label: 'Own only',
          showWhen: { field: 'housing', op: 'eq', value: 'Own' } },
      ] },
    ],
  }],
};

const SUB_DATA = { name: 'Not Test Tester', housing: 'Rent', extras: 'A,C', followup: 'call me' };

/**
 * Boot render.html in view mode.
 * opts: { id, payloadOver } — payloadOver deep-merges over the default
 * /render response (submission fields via payloadOver.submission).
 */
function bootView(opts = {}) {
  const id = opts.id || 286;
  const calls = [];

  const payload = Object.assign({
    status: 'success',
    submission: Object.assign({
      id, form_key: 'intake', link_type: '', link_id: '', status: 'submitted',
      version: 1, schema_version: 1, data: SUB_DATA,
      submitted_by: null, user_name: null, linked_by: null, linked_at: null,
      created_at: '2026-08-12T15:56:22.000Z', updated_at: '2026-08-12T15:56:22.000Z',
    }, (opts.payloadOver && opts.payloadOver.submission) || {}),
    title: 'Bankruptcy Intake',
    link_type: 'case',
    definition: VIEW_DEF,
    definition_schema_version: 1,
    schema_matched: true,
  }, opts.payloadOver ? Object.fromEntries(
    Object.entries(opts.payloadOver).filter(([k]) => k !== 'submission')) : {});

  const apiSend = async (u, method) => {
    calls.push({ url: u, method });
    if (u === '/api/forms/submissions/' + id + '/render') return payload;
    // yc-forms init step 8 probes latest unconditionally; with linkId '' the
    // real route 400s — the stub throws to mirror it. init must survive.
    if (u.startsWith('/api/forms/latest')) {
      throw new Error('400 Missing required query params: form_key, link_type, link_id');
    }
    throw new Error('unstubbed apiSend in view mode: ' + method + ' ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url: 'https://app.test/forms/render.html?view_submission=' + id,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend = apiSend;
    },
  });

  DOMS.push(dom);
  return { dom, calls, window: dom.window };
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


describe('view mode — boot, populate, lock', () => {
  let w, calls;
  beforeAll(async () => {
    const p = bootView();
    calls = p.calls;
    w = await ready(p.dom);
  });

  test('answers populate: text, radio, checkgroup CSV', () => {
    const d = w.document;
    expect(d.querySelector('[name="name"]').value).toBe('Not Test Tester');
    expect(d.querySelector('input[name="housing"][value="Rent"]').checked).toBe(true);
    expect(d.querySelector('input[name="housing"][value="Own"]').checked).toBe(false);
    // checkgroup CSV round-trip through _setCheckgroup
    const grid = d.querySelector('[data-yc-checkgroup="extras"]');
    const checked = Array.from(grid.querySelectorAll('input:checked')).map(i => i.value).sort();
    expect(checked).toEqual(['A', 'C']);
    expect(d.querySelector('[name="followup"]').value).toBe('call me');
  });

  test('showWhen states match the answers in both directions', () => {
    const d = w.document;
    const followWrap = d.querySelector('[name="followup"]').closest('[data-yc-show-when]');
    const ownWrap    = d.querySelector('[name="ownOnly"]').closest('[data-yc-show-when]');
    expect(followWrap.style.display).not.toBe('none');   // housing=Rent → shown
    expect(ownWrap.style.display).toBe('none');          // Own-only branch hidden
  });

  test('force-locked: .yc-readonly despite toggle:true, no visible toggle, saveBtn dead', () => {
    const d = w.document;
    expect(d.getElementById('ycRenderForm').classList.contains('yc-readonly')).toBe(true);
    // buildSkeleton's VIEW override renders the hidden toggle variant
    const toggleWrap = d.querySelector('.yc-toggle');
    expect(toggleWrap.style.display).toBe('none');
    const save = d.getElementById('saveBtn');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.style.display).toBe('none');
  });

  test('banner carries id, title, schema, unlinked state; no draft banner exists', () => {
    const d = w.document;
    const note = d.querySelector('.ycr-view-note');
    expect(note).toBeTruthy();
    expect(note.textContent).toContain('Submission #286');
    expect(note.textContent).toContain('Bankruptcy Intake');
    expect(note.textContent).toContain('schema v1');
    expect(note.textContent).toContain('unlinked');
    expect(d.querySelector('.ycr-view-warn')).toBeNull();       // matched schema → no warn
    expect(d.getElementById('draftBanner')).toBeNull();
    expect(d.querySelector('.ycr-preview-note')).toBeNull();
  });

  test('no-write discipline: only the render fetch + the failed latest probe, even after input', async () => {
    const urls = calls.map(c => c.url);
    expect(urls[0]).toBe('/api/forms/submissions/286/render');
    expect(urls.filter(u => u.startsWith('/api/forms/latest')).length).toBe(1);
    expect(urls.length).toBe(2);

    // Programmatic input then a wait past any plausible autosave window —
    // autosave is off, save is unreachable, nothing may fire.
    const nameEl = w.document.querySelector('[name="name"]');
    nameEl.value = 'tampered';
    nameEl.dispatchEvent(new w.Event('input', { bubbles: true }));
    nameEl.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(150);
    expect(calls.length).toBe(2);
  });
});


describe('view mode — variants', () => {

  test('linked submission: banner names the target', async () => {
    const p = bootView({
      id: 287,
      payloadOver: { submission: { id: 287, link_type: 'case', link_id: 'RLaJw5es', linked_by: 6 } },
    });
    const w = await ready(p.dom);
    expect(w.document.querySelector('.ycr-view-note').textContent)
      .toContain('linked to case RLaJw5es');
  });

  test('schema_matched:false renders the .ycr-view-warn line', async () => {
    const p = bootView({
      payloadOver: {
        schema_matched: false, definition_schema_version: 3,
        submission: { schema_version: 1 },
      },
    });
    const w = await ready(p.dom);
    const warn = w.document.querySelector('.ycr-view-warn');
    expect(warn).toBeTruthy();
    expect(warn.textContent).toContain('schema v1');
    expect(warn.textContent).toContain('current v3');
  });

  test('template code is NOT executed in view mode (preview-grade discipline)', async () => {
    const def = JSON.parse(JSON.stringify(VIEW_DEF));
    def.code = 'window.__pwned = true;';
    const p = bootView({ payloadOver: { definition: def } });
    const w = await ready(p.dom);
    expect(w.__pwned).toBeUndefined();
    // and the form still booted read-only with the data in place
    expect(w.document.querySelector('[name="name"]').value).toBe('Not Test Tester');
    expect(w.document.getElementById('ycRenderForm').classList.contains('yc-readonly')).toBe(true);
  });
});
