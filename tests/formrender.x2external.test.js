// X2 — external renderer mode (EXTERNAL_FORMS_DESIGN §5.1/§5.2/§6/§8-of-doc).
// jsdom integration against the REAL render.html + yc-forms.js, mirroring the
// slice2 harness — but with window.fetch stubbed instead of parent.apiSend:
// external mode must never touch the parent chain or any authed route.
//
// Locks:
//   - ext=1 boots WITHOUT waitForParent (no apiSend anywhere in the page)
//   - one GET /api/ext/forms/:key?case_id=…; $load prefill from the served
//     load object; urlParam prefill (LAST duplicate wins; ifEmpty vs always;
//     unlisted select value doesn't stick)
//   - submit: POST {case_id, values} to /api/ext/forms/:key/submit — and the
//     authed staff endpoints (/api/log, /api/forms/*, /workflows/*) are never
//     called (§9.3 grep-equivalent, enforced live)
//   - degrade-anonymous boot: linkId '' → submit body carries NO case_id
//   - error states: badLink → the standing Unauthorized-Link copy; generic
//     404 → a copy that confirms nothing (§9.8)
//   - localStorage drafts: autosave writes, seeded draft shows the banner,
//     submit clears
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

// The PROJECTED definition shape — what /api/ext/forms actually serves.
const EXT_DEF = {
  toggle: false,
  autosave: true,
  autosaveMs: 40,
  sections: [{ title: 'Contact', rows: [{ fields: [
    { name: 'client_name', type: 'text', prefill: '$load.contact_name' },
    { name: 'client_email', type: 'text', prefill: '$load.contact_email', prefillMode: 'always' },
    { name: 'reason', type: 'text', required: true },
    { name: 'src', type: 'hidden', urlParam: 'src' },
    { name: 'promo', type: 'text', urlParam: 'promo', prefillMode: 'always' },
    { name: 'pref', type: 'select', options: ['Phone', 'Email'], urlParam: 'pref' },
  ] }] }],
};

const LOAD = { contact_name: 'Ada L', contact_phone: '555', contact_email: 'ada@x.test' };

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    return Promise.resolve(Buffer.from(''));   // CDN etc.
  }
}

const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build an external-mode page.
 * opts: { query, getBody, getStatus, submitBody, submitStatus, seedDraft }
 */
function makePage(opts = {}) {
  const fetches = [];
  const url = 'https://app.test/forms/render.html?' +
    (opts.query || 'form_key=intake_test&case_id=abc12345&ext=1');

  const fetchStub = async (u, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    fetches.push({ url: u, method, body });
    if (u.startsWith('/api/ext/forms/') && u.endsWith('/submit')) {
      const status = opts.submitStatus || 200;
      const resBody = opts.submitBody || { status: 'success' };
      return { ok: status < 400, status, json: async () => resBody };
    }
    if (u.startsWith('/api/ext/forms/')) {
      const status = opts.getStatus || 200;
      const resBody = opts.getBody !== undefined ? opts.getBody : {
        status: 'success', title: 'Intake', link_type: 'case', schema_version: 3,
        definition: EXT_DEF, load: LOAD, linked: true,
      };
      return { ok: status < 400, status, json: async () => resBody };
    }
    throw new Error('unstubbed fetch: ' + method + ' ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.fetch = fetchStub;
      // NO window.apiSend — external mode must never want it.
      if (opts.seedDraft) {
        window.localStorage.setItem(opts.seedDraft.key, JSON.stringify(opts.seedDraft.value));
      }
      if (opts.seedLocal) {   // deliberately the WRONG store for the anonymous branch
        window.localStorage.setItem(opts.seedLocal.key, JSON.stringify(opts.seedLocal.value));
      }
    },
  });
  DOMS.push(dom);
  return { dom, fetches, window: dom.window };
}

async function ready(page) {
  const w = page.window;
  for (let i = 0; i < 200; i++) {
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') return w;
    await sleep(20);
  }
  const fatal = w.document.querySelector('.ycr-fatal');
  throw new Error(fatal ? 'render fatal: ' + fatal.textContent : 'form never finished init');
}

async function fatalText(page) {
  const w = page.window;
  for (let i = 0; i < 100; i++) {
    const f = w.document.querySelector('.ycr-fatal');
    if (f) return f.textContent;
    await sleep(20);
  }
  throw new Error('no fatal rendered');
}

function type(w, name, value) {
  const el = w.document.querySelector(`[name="${name}"]`);
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
}

// ── Boot + prefill ──────────────────────────────────────────────────────────

describe('external boot + prefill', () => {
  test('boots parentless from the one /api/ext payload; $load prefill applies', async () => {
    const page = makePage();
    const w = await ready(page);

    expect(page.fetches.length).toBe(1);
    expect(page.fetches[0].url).toBe('/api/ext/forms/intake_test?case_id=abc12345');

    expect(w.document.querySelector('[name="client_name"]').value).toBe('Ada L');
    expect(w.document.querySelector('[name="client_email"]').value).toBe('ada@x.test');
    // form is clean after prefill (prefill runs before resetBaseline)
    expect(w.ycForm.isDirty()).toBe(false);
  });

  test('urlParam prefill: applies, LAST duplicate wins, "always" beats $load, unlisted select ignored', async () => {
    const page = makePage({
      query: 'form_key=intake_test&case_id=abc12345&ext=1'
        + '&src=facebook&src=web'          // duplicates → last wins
        + '&promo=SUMMER'
        + '&pref=Fax'                       // not a listed option → must not stick
        + '&reason=ignored_param',          // reason declares NO urlParam → untouched
    });
    const w = await ready(page);
    expect(w.document.querySelector('[name="src"]').value).toBe('web');
    expect(w.document.querySelector('[name="promo"]').value).toBe('SUMMER');
    expect(w.document.querySelector('[name="pref"]').value).toBe('');
    expect(w.document.querySelector('[name="reason"]').value).toBe('');
  });
});

// ── Submit ──────────────────────────────────────────────────────────────────

describe('external submit', () => {
  test('POSTs { case_id, values } to the ext route; no authed endpoint is ever touched', async () => {
    const page = makePage();
    const w = await ready(page);

    type(w, 'reason', 'need chapter 7 help');
    w.document.getElementById('saveBtn').click();
    await sleep(120);

    const submit = page.fetches.find((f) => f.method === 'POST');
    expect(submit.url).toBe('/api/ext/forms/intake_test/submit');
    expect(submit.body.case_id).toBe('abc12345');
    expect(submit.body.values.reason).toBe('need chapter 7 help');
    expect(submit.body.values.client_name).toBe('Ada L');
    // the body carries values + case_id and NOTHING else (§2 inversion)
    expect(Object.keys(submit.body).sort()).toEqual(['case_id', 'values']);

    // §9.3: no staff endpoint, ever
    for (const f of page.fetches) {
      expect(f.url).toMatch(/^\/api\/ext\/forms\//);
    }
  });

  test('X3 postSubmit: successful submit swaps in the terminal panel; Edit restores the filled form', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: LOAD, linked: true,
                 postSubmit: { message: 'Thanks — we got it.', edit: true, new: true } },
    });
    const w = await ready(page);
    type(w, 'reason', 'done');
    w.document.getElementById('saveBtn').click();
    await sleep(150);

    const panel = w.document.querySelector('.ycr-post-submit');
    expect(panel).not.toBeNull();
    expect(panel.querySelector('.ycr-post-submit-msg').textContent).toBe('Thanks — we got it.');
    // form + header hidden, not destroyed
    expect(w.document.getElementById('ycRenderForm').style.display).toBe('none');
    const btns = [...panel.querySelectorAll('button')].map((b) => b.textContent);
    expect(btns).toEqual(['Edit response', 'Submit another response']);

    // Edit restores the same nodes with values intact
    panel.querySelectorAll('button')[0].click();
    expect(w.document.querySelector('.ycr-post-submit')).toBeNull();
    expect(w.document.getElementById('ycRenderForm').style.display).toBe('');
    expect(w.document.querySelector('[name="reason"]').value).toBe('done');
  });

  test('X3 postSubmit absent → pre-X3 behavior: no panel, form stays', async () => {
    const page = makePage();
    const w = await ready(page);
    type(w, 'reason', 'x');
    w.document.getElementById('saveBtn').click();
    await sleep(150);
    expect(w.document.querySelector('.ycr-post-submit')).toBeNull();
    expect(w.document.getElementById('ycRenderForm').style.display).not.toBe('none');
  });

  test('X3.3 redirect: navigates instead of the panel and SUPERSEDES message/edit/new; no ?b= without redirectBack', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: LOAD, linked: true,
                 postSubmit: { message: 'ignored', edit: true, new: true,
                               redirect: '/p/thanks' } },
    });
    const w = await ready(page);
    const navs = [];
    w.ycrNavigate = (url) => navs.push(url);   // seam: looked up at call time
    type(w, 'reason', 'done');
    w.document.getElementById('saveBtn').click();
    await sleep(150);

    expect(navs).toEqual(['/p/thanks']);                          // no b param
    expect(w.document.querySelector('.ycr-post-submit')).toBeNull();  // panel superseded
  });

  test('X3.3 redirectBack: appends ?b=<current URL> (top when readable) to a path redirect, & when a query exists', async () => {
    const page = makePage({
      query: 'form_key=intake_test&case_id=abc12345&ext=1&src=fb',
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: LOAD, linked: true,
                 postSubmit: { redirect: '/p/thanks?v=1', redirectBack: true } },
    });
    const w = await ready(page);
    const navs = [];
    w.ycrNavigate = (url) => navs.push(url);
    type(w, 'reason', 'done');
    w.document.getElementById('saveBtn').click();
    await sleep(150);

    expect(navs.length).toBe(1);
    // top === window in the harness, so back = the page's own URL, credential
    // and urlParams intact; existing query on the target → '&' joiner.
    const expectedBack = encodeURIComponent(
      'https://app.test/forms/render.html?form_key=intake_test&case_id=abc12345&ext=1&src=fb');
    expect(navs[0]).toBe('/p/thanks?v=1&b=' + expectedBack);
  });

  test('X3.3 renderer guard: redirectBack on a NON-path redirect never appends the credential (defense in depth)', async () => {
    // A payload that should be impossible (validateDefinition + projection
    // both block it) — the renderer still refuses to append b= off-origin.
    const page = makePage({
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: LOAD, linked: true,
                 postSubmit: { redirect: 'https://evil.test/x', redirectBack: true } },
    });
    const w = await ready(page);
    const navs = [];
    w.ycrNavigate = (url) => navs.push(url);
    type(w, 'reason', 'done');
    w.document.getElementById('saveBtn').click();
    await sleep(150);

    expect(navs).toEqual(['https://evil.test/x']);   // navigated, but no b=
  });

  test('degrade-anonymous boot: linked:false → submit body has NO case_id', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: null, linked: false },
    });
    const w = await ready(page);
    type(w, 'reason', 'anon');
    w.document.getElementById('saveBtn').click();
    await sleep(120);

    const submit = page.fetches.find((f) => f.method === 'POST');
    expect(submit.body).toEqual({ values: submit.body.values });
    expect('case_id' in submit.body).toBe(false);
  });
});

// ── Error states (§6 / §9.8) ────────────────────────────────────────────────

describe('external error states', () => {
  test('badLink reject → the standing Unauthorized-Link copy', async () => {
    const page = makePage({
      getStatus: 404,
      getBody: { status: 'error', message: 'Not found', badLink: true },
    });
    const text = await fatalText(page);
    expect(text).toContain('Unauthorized Link or Client ID');
    expect(text).toContain('the client ID is invalid');
  });

  test('generic 404 → a copy that confirms nothing (no form_key echo, no reason)', async () => {
    const page = makePage({
      getStatus: 404,
      getBody: { status: 'error', message: 'Not found' },
    });
    const text = await fatalText(page);
    expect(text).toBe('Sorry, this form is not available.');
    expect(text).not.toContain('intake_test');
  });
});

// ── localStorage drafts (§5.3.8) ────────────────────────────────────────────

describe('external localStorage drafts', () => {
  test('autosave writes localStorage; submit clears it', async () => {
    const page = makePage();
    const w = await ready(page);
    const key = 'ycExtDraft:intake_test:abc12345';

    type(w, 'reason', 'draft in progress');
    await sleep(150);                                   // autosaveMs 40 + debounce
    const draft = JSON.parse(w.localStorage.getItem(key));
    expect(draft.data.reason).toBe('draft in progress');
    expect(draft.schema_version).toBe(3);

    w.document.getElementById('saveBtn').click();
    await sleep(150);
    expect(w.localStorage.getItem(key)).toBeNull();
  });

  test('F4: the ANONYMOUS draft lives in sessionStorage, not the shared localStorage slot', async () => {
    const page = makePage({
      query: 'form_key=intake_test&ext=1',                    // no case_id → degrade
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: null, linked: false },
    });
    const w = await ready(page);
    const key = 'ycExtDraft:intake_test:anon';

    type(w, 'reason', 'private answers');
    await sleep(150);
    // The shared cross-visitor slot must stay empty; the per-tab store holds it.
    expect(w.localStorage.getItem(key)).toBeNull();
    expect(JSON.parse(w.sessionStorage.getItem(key)).data.reason).toBe('private answers');
  });

  test('F4: a stale ANONYMOUS localStorage draft from a previous visitor is NOT offered', async () => {
    const page = makePage({
      query: 'form_key=intake_test&ext=1',
      getBody: { status: 'success', title: 'Intake', link_type: 'case',
                 schema_version: 3, definition: EXT_DEF, load: null, linked: false },
      seedLocal: {
        key: 'ycExtDraft:intake_test:anon',
        value: { data: { reason: 'visitor ones private answers' },
                 updated_at: '2026-08-10T12:00:00Z', schema_version: 3 },
      },
    });
    const w = await ready(page);
    const banner = w.document.getElementById('draftBanner');
    expect(banner.style.display).toBe('none');
    expect(w.document.querySelector('[name="reason"]').value).toBe('');
  });

  test('a seeded draft shows the recovery banner; restore fills the form', async () => {
    const page = makePage({
      seedDraft: {
        key: 'ycExtDraft:intake_test:abc12345',
        value: { data: { reason: 'from yesterday' },
                 updated_at: '2026-08-10T12:00:00Z', schema_version: 3 },
      },
    });
    const w = await ready(page);

    const banner = w.document.getElementById('draftBanner');
    expect(banner.style.display).not.toBe('none');

    w.document.getElementById('draftRestore').click();
    await sleep(50);
    expect(w.document.querySelector('[name="reason"]').value).toBe('from yesterday');
    expect(w.ycForm.isDirty()).toBe(true);              // restored draft is honestly dirty
  });
});