// tests/formRender.sync.test.js
//
// A12: an open form hears a draft saved (or a submission adopted) for its
// record in ANOTHER frame.
//
// public/js/yc-sync.js announces POST /api/forms/draft and PATCH
// /api/forms/submissions/:id/link as `form:<link_type>:<link_id>`. Before A12
// no form host loaded the bus and no matcher existed: an Ask Casey draft card
// applied from the assistant pane left an open form tab blind until reload —
// and its next autosave silently erased the new draft (the route replaces a
// draft WHOLE). What this file pins, on the REAL render.html booted in jsdom
// with the REAL yc-forms.js and yc-sync.js:
//
//   · render.html loads yc-sync.js in normal internal mode only (never in
//     preview — and the external branch is gated the same way: its landing
//     host has no /js/yc-sync.js);
//   · a draft announced for THIS record re-reads GET /api/forms/latest and
//     raises the draft banner without touching the fields; another record's
//     announcement does nothing;
//   · the form's OWN autosave, echoed back, does nothing (_api stamps it);
//   · a form with unsaved typing is never repopulated: it shows the newer
//     draft's banner and HOLDS its autosave until Restore / Discard;
//   · the caret in a field, or a hidden page, PARKS the message and the
//     refetch runs when the focus leaves / the page is visible again.
//
//   npx jest tests/formRender.sync.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const YC_SYNC_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const CASE_ID = 'CASESYNC1';

const DEF = {
  toggle: false,
  autosave: true,
  autosaveMs: 60,
  sections: [{ title: 'Notes', rows: [{ fields: [
    { name: 'trustee_name', label: 'Trustee', type: 'text' },
    { name: 'outcome', label: 'Outcome', type: 'select', options: ['Concluded', 'Continued'] },
  ] }] }],
};

class TestLoader extends ResourceLoader {
  constructor(fetched) { super(); this.fetched = fetched; }
  fetch(url) {
    const p = new URL(url).pathname;
    this.fetched.push(p);
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p === '/js/yc-sync.js') return Promise.resolve(Buffer.from(YC_SYNC_JS));
    return Promise.resolve(Buffer.from(''));
  }
}

const DOMS = []; const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach((fn) => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) {} });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Another frame of the same app (the assistant pane): the real bus, no page.
function otherWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.test/', runScripts: 'dangerously' });
  DOMS.push(dom);
  TEARDOWNS.push(bcPolyfill.install(dom.window));
  dom.window.console.warn = () => {};
  dom.window.eval(YC_SYNC_JS);
  return dom.window;
}

function boot({ preview = false, latest } = {}) {
  const calls = []; const fetched = [];
  const state = { latest: latest || { status: 'success', submitted: null, draft: null } };
  const url = preview
    ? 'https://app.test/forms/render.html?template_id=1&preview=1'
    : `https://app.test/forms/render.html?form_key=341_notes&case_id=${CASE_ID}`;
  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/form-templates/render/')) return { status: 'success', title: '341 Notes', link_type: 'case', schema_version: 3, definition: DEF };
    if (u.startsWith('/api/form-templates/')) return { status: 'success', template: { form_key: '341_notes', title: '341 Notes', link_type: 'case', schema_version: 3, draft_definition: DEF } };
    if (u.startsWith('/api/forms/latest')) return state.latest;
    if (u === '/api/forms/draft' && method === 'POST') return { status: 'success', id: 88, updated_at: new Date().toISOString(), form_key: '341_notes', link_type: 'case', link_id: CASE_ID };
    if (u.startsWith('/api/forms/draft')) return { status: 'success' };
    throw new Error(`unstubbed apiSend: ${method} ${u}`);
  };
  const dom = new JSDOM(RENDER_HTML, {
    url, runScripts: 'dangerously', resources: new TestLoader(fetched), pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, (ch) => `\\${ch}`) };
      window.apiSend = apiSend;
      window.console.warn = () => {};
      TEARDOWNS.push(bcPolyfill.install(window));
    },
  });
  DOMS.push(dom);
  return { dom, w: dom.window, calls, fetched, state };
}

async function ready(page) {
  const w = page.w;
  for (let i = 0; i < 200; i++) {
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none' && w.YC && w.ycForm._syncOn) return w;
    await sleep(20);
  }
  throw new Error('form never finished init / never subscribed');
}

const latestReads = (calls) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/forms/latest')).length;
const draftPosts = (calls) => calls.filter((c) => c.method === 'POST' && c.url === '/api/forms/draft').length;
const announce = (other, linkId = CASE_ID) => other.YC._sniff('POST', '/api/forms/draft',
  { status: 'success', id: 99, updated_at: new Date().toISOString(), form_key: '341_notes', link_type: 'case', link_id: linkId });
const caseyDraft = () => ({ id: 99, schema_version: 3, data: { trustee_name: 'Jane Trustee' }, updated_at: new Date().toISOString(), submitted_by: 6, user_name: 'Fred' });
function type(w, name, value) {
  const el = w.document.querySelector(`[name="${name}"]`);
  el.value = value;
  // A trusted-looking user edit: yc-forms counts isTrusted events only for
  // _userEditSeq, but dirtiness is collect() vs the baseline.
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  return el;
}

describe('render.html loads the bus in normal internal mode only', () => {
  test('normal mode loads /js/yc-sync.js and subscribes; preview mode never requests it', async () => {
    const p = boot();
    await ready(p);
    expect(p.fetched).toContain('/js/yc-sync.js');
    const pv = boot({ preview: true });
    for (let i = 0; i < 100 && !(pv.w.ycForm && pv.w.document.querySelector('.yc-loading-overlay') && pv.w.document.querySelector('.yc-loading-overlay').style.display === 'none'); i++) await sleep(20);
    expect([pv.fetched.includes('/js/yc-sync.js'), !!pv.w.YC, !!(pv.w.ycForm && pv.w.ycForm._syncOn)]).toEqual([false, false, false]);
    // The external branch is gated by the same condition (its landing host serves no /js/yc-sync.js).
    expect(RENDER_HTML).toContain("if (!EXT && !preview && !VIEW && !window.YC) {");
  });
});

describe('a draft announced from another frame', () => {
  test('THIS record: re-reads latest and raises the banner, fields untouched; another record: nothing', async () => {
    const p = boot();
    const w = await ready(p);
    const other = otherWindow();
    const before = latestReads(p.calls);
    p.state.latest = { status: 'success', submitted: null, draft: caseyDraft() };
    announce(other, 'OTHERCASE');
    await sleep(30);
    expect(latestReads(p.calls)).toBe(before);
    announce(other);
    await sleep(60);
    expect(latestReads(p.calls)).toBe(before + 1);
    expect(w.document.getElementById('draftBanner').style.display).toBe('flex');
    expect(w.document.querySelector('[name="trustee_name"]').value).toBe('');
    expect(w.ycForm._draftConflict).toBe(false);
    // The draft gone (discarded elsewhere): the banner comes down.
    p.state.latest = { status: 'success', submitted: null, draft: null };
    announce(other);
    await sleep(60);
    expect(w.document.getElementById('draftBanner').style.display).toBe('none');
  });

  test('the form\'s OWN autosave, echoed back, is not taken for someone else\'s draft', async () => {
    const p = boot();
    const w = await ready(p);
    const other = otherWindow();
    type(w, 'outcome', 'Continued');
    for (let i = 0; i < 50 && !draftPosts(p.calls); i++) await sleep(20);
    expect(draftPosts(p.calls)).toBe(1);
    const before = latestReads(p.calls);
    announce(other);   // the echo of that autosave, landing right after it
    await sleep(60);
    expect(latestReads(p.calls)).toBe(before);
  });

  test('UNSAVED TYPING: never repopulated; the newer draft\'s banner shows and autosave HOLDS until Restore', async () => {
    const p = boot();
    const w = await ready(p);
    const other = otherWindow();
    w.ycForm.config.autosaveMs = 60000;          // keep the user's own autosave out of the way
    type(w, 'outcome', 'Continued');
    w.document.activeElement && w.document.activeElement.blur && w.document.activeElement.blur();
    p.state.latest = { status: 'success', submitted: null, draft: caseyDraft() };
    w.ycForm._lastDraftWrite = 0;
    announce(other);
    await sleep(60);
    expect(w.document.querySelector('[name="outcome"]').value).toBe('Continued');
    expect([w.document.getElementById('draftBanner').style.display, w.ycForm._draftConflict]).toEqual(['flex', true]);
    const posts = draftPosts(p.calls);
    await w.ycForm.autosaveTick();
    expect(draftPosts(p.calls)).toBe(posts);
    expect(w.document.getElementById('saveStatus').textContent).toContain('Draft not saved — a newer draft is waiting');
    w.document.getElementById('draftRestore').click();
    expect([w.ycForm._draftConflict, w.document.querySelector('[name="trustee_name"]').value]).toEqual([false, 'Jane Trustee']);
    await w.ycForm.autosaveTick();
    expect(draftPosts(p.calls)).toBe(posts + 1);
  });

  test('PARKED: the caret in a field holds the refetch until the focus leaves; a hidden page until it is visible', async () => {
    const p = boot();
    const w = await ready(p);
    const other = otherWindow();
    const field = w.document.querySelector('[name="trustee_name"]');
    field.focus();
    const before = latestReads(p.calls);
    announce(other);
    await sleep(40);
    expect(latestReads(p.calls)).toBe(before);
    field.blur();
    w.document.dispatchEvent(new w.Event('focusout'));
    await sleep(40);
    expect(latestReads(p.calls)).toBe(before + 1);
    let state = 'hidden';
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => state });
    announce(other);
    await sleep(40);
    expect(latestReads(p.calls)).toBe(before + 1);
    state = 'visible';
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await sleep(40);
    expect(latestReads(p.calls)).toBe(before + 2);
  });
});
