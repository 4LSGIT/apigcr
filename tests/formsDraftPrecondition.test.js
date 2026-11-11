// tests/formsDraftPrecondition.test.js
//
// The form page's half of the draft POST's precondition (POST /api/forms/draft
// { expected_draft_id, expected_updated_at } — services/formService.js
// upsertDraft; the route's real-engine twin is
// tests/formsDraftPrecondition.mysql.test.js). Two people with the same form
// open in two BROWSERS are invisible to each other's sync bus (one
// BroadcastChannel per browser): before this, each autosave replaced the
// other's draft whole.
//
// On the REAL render.html + yc-forms.js booted in jsdom, with an apiSend stub
// that models the draft row and answers the route's 409 exactly as the route
// does (an ApiError-shaped throw carrying status 409 and the body), this pins:
//   · the first autosave of a form that saw no draft sends null / null;
//   · a form that booted on a draft sends that row's id + updated_at;
//   · after a POST the next autosave sends the answered id + updated_at;
//   · after syncLatest, the row it read;
//   · a 409 (another browser saved since): the banner shows THAT draft, the
//     status line names who and when, autosave HOLDS (the next tick does not
//     POST), and nothing retries;
//   · Discard (a DELETE) then autosave: null / null, and it lands;
//   · Restore: adopts the newer row's id + updated_at, clears the hold, lands;
//   · a draft discarded in another browser: the next autosave saves a new
//     draft (the route replaces nothing unseen); a 409 whose row is already
//     gone again (draft null): no hold, the next change sends null and lands;
//   · save()'s cleanup DELETE leaves the form holding no draft;
//   · external serverDrafts autosave sends NO precondition (its route is
//     unchanged).
//
//   npx jest tests/formsDraftPrecondition.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const YC_SYNC_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const CASE_ID = 'CASEPRE1';

const DEF = {
  toggle: false,
  autosave: true,
  autosaveMs: 60000,          // ticks are driven by hand (autosaveTick)
  sections: [{ title: 'Notes', rows: [{ fields: [
    { name: 'trustee_name', label: 'Trustee', type: 'text' },
    { name: 'outcome', label: 'Outcome', type: 'select', options: ['Concluded', 'Continued'] },
  ] }] }],
};

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
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

let clock = Date.parse('2026-11-11T15:00:00.000Z');
const stamp = () => new Date(clock += 1234).toISOString();
const ms = (iso) => Date.parse(iso);

// The server's draft row, and the route's rule (formService.upsertDraft).
function boot({ draft = null } = {}) {
  const calls = [];
  const server = { row: draft, nextId: 500 };
  const conflict = (message) => {
    const err = new Error(message);
    err.name = 'ApiError'; err.status = 409;
    err.body = { status: 'conflict', message, draft: server.row };
    return err;
  };
  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/form-templates/render/')) return { status: 'success', title: '341 Notes', link_type: 'case', schema_version: 3, definition: DEF };
    if (u.startsWith('/api/forms/latest')) return { status: 'success', submitted: null, draft: server.row };
    if (u === '/api/forms/draft' && method === 'POST') {
      const has = Object.prototype.hasOwnProperty;
      if (has.call(body, 'expected_draft_id') || has.call(body, 'expected_updated_at')) {
        if (server.forceGone409) { server.forceGone409 = false; const e = conflict('The draft was saved again since it was read — nothing was written'); e.body.draft = null; throw e; }
        const same = server.row && body.expected_draft_id !== null && server.row.id === body.expected_draft_id && ms(server.row.updated_at) === ms(body.expected_updated_at);
        if (same) {
          server.row = { ...server.row, data: body.data, updated_at: stamp(), submitted_by: 6, user_name: 'Fred' };
        } else if (server.row) {
          throw conflict(body.expected_draft_id !== null ? 'The draft was saved again since it was read — nothing was written'
            : 'A draft of this form already exists for this record — nothing was written');
        } else {
          server.row = { id: server.nextId++, schema_version: 3, data: body.data, updated_at: stamp(), submitted_by: 6, user_name: 'Fred' };
        }
      } else {
        server.row = { id: server.row ? server.row.id : server.nextId++, schema_version: 3, data: body.data, updated_at: stamp(), submitted_by: 6, user_name: 'Fred' };
      }
      return { status: 'success', id: server.row.id, updated_at: server.row.updated_at, form_key: '341_notes', link_type: 'case', link_id: CASE_ID };
    }
    if (u.startsWith('/api/forms/draft') && method === 'DELETE') {
      const deleted = !!server.row; server.row = null;
      return { status: 'success', deleted, form_key: '341_notes', link_type: 'case', link_id: CASE_ID };
    }
    if (u === '/api/forms/submit' && method === 'POST') return { status: 'success', id: 900, version: 1, updated_at: stamp(), form_key: '341_notes', link_type: 'case', link_id: CASE_ID };
    if (u === '/api/log') return { status: 'success' };
    throw new Error(`unstubbed apiSend: ${method} ${u}`);
  };
  const dom = new JSDOM(RENDER_HTML, {
    url: `https://app.test/forms/render.html?form_key=341_notes&case_id=${CASE_ID}`,
    runScripts: 'dangerously', resources: new TestLoader(), pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, (ch) => `\\${ch}`) };
      window.apiSend = apiSend;
      window.console.warn = () => {};
      TEARDOWNS.push(bcPolyfill.install(window));
    },
  });
  DOMS.push(dom);
  return { w: dom.window, calls, server };
}

async function ready(page) {
  const w = page.w;
  for (let i = 0; i < 200; i++) {
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none' && w.ycForm._initDone) return w;
    await sleep(20);
  }
  throw new Error('form never finished init');
}

const posts = (calls) => calls.filter((c) => c.method === 'POST' && c.url === '/api/forms/draft');
const lastPost = (calls) => posts(calls)[posts(calls).length - 1];
const expectedOf = (call) => [call.body.expected_draft_id, call.body.expected_updated_at];
const status = (w) => w.document.getElementById('saveStatus').textContent;
const banner = (w) => w.document.getElementById('draftBanner').style.display;
function type(w, name, value) {
  const el = w.document.querySelector(`[name="${name}"]`);
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
}
// Another browser saves the draft (no bus reaches this page).
function elsewhere(page, data, who = 'Stuart') {
  page.server.row = { id: page.server.row ? page.server.row.id : page.server.nextId++, schema_version: 3, data, updated_at: stamp(), submitted_by: 1, user_name: who };
  return page.server.row;
}

describe('the autosave carries the draft row the form last saw', () => {
  test('first autosave with no draft sends null / null; the next sends the answered id + updated_at', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Tom');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([null, null]);
    expect(status(w)).toBe('Draft saved just now');
    const first = p.server.row;
    type(w, 'trustee_name', 'Tom T');
    await w.ycForm.autosaveTick();
    expect(posts(p.calls).length).toBe(2);
    expect(expectedOf(lastPost(p.calls))).toEqual([first.id, first.updated_at]);
    expect(status(w)).toBe('Draft saved just now');
  });

  test('a form that booted on a draft sends that row; after syncLatest, the row it read', async () => {
    const seen = { id: 41, schema_version: 3, data: { trustee_name: 'Old' }, updated_at: stamp(), submitted_by: 6, user_name: 'Fred' };
    const p = boot({ draft: seen });
    const w = await ready(p);
    type(w, 'outcome', 'Continued');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([41, seen.updated_at]);
    // A newer row, read by syncLatest (the bus path in one browser).
    const newer = elsewhere(p, { trustee_name: 'Newer' });
    await w.ycForm.syncLatest();
    w.ycForm._draftConflict = false;            // decided: keep typing over it
    type(w, 'outcome', 'Concluded');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([41, newer.updated_at]);
    expect(p.server.row.data.outcome).toBe('Concluded');
  });
});

describe('the route refuses (409): another browser saved since', () => {
  test('the banner shows THAT draft, the status names who and when, autosave HOLDS, nothing retries', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Mine');
    await w.ycForm.autosaveTick();
    const theirs = elsewhere(p, { trustee_name: 'Theirs' });
    type(w, 'trustee_name', 'Mine again');
    await w.ycForm.autosaveTick();
    expect(posts(p.calls).length).toBe(2);
    expect(p.server.row).toBe(theirs);                           // nothing written
    expect(banner(w)).toBe('flex');
    expect(w.ycForm._draftConflict).toBe(true);
    expect(w.ycForm._draftData).toEqual(theirs);
    expect(w.document.querySelector('#draftBanner span').textContent).toBe(`You have an unsaved draft from ${new Date(theirs.updated_at).toLocaleString()}`);
    expect(status(w)).toBe(`Draft not saved — Stuart saved a newer draft at ${new Date(theirs.updated_at).toLocaleString()}: Restore or Discard it first`);
    expect(w.document.querySelector('[name="trustee_name"]').value).toBe('Mine again');   // the typing stays
    await sleep(30);
    expect(posts(p.calls).length).toBe(2);                       // not retried
    type(w, 'trustee_name', 'Mine, a third time');
    await w.ycForm.autosaveTick();
    expect(posts(p.calls).length).toBe(2);                       // held
    expect(status(w)).toBe('Draft not saved — a newer draft is waiting: Restore or Discard it first');
  });

  test('Discard → the next autosave sends null / null and lands', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Mine');
    await w.ycForm.autosaveTick();
    elsewhere(p, { trustee_name: 'Theirs' });
    type(w, 'trustee_name', 'Mine again');
    await w.ycForm.autosaveTick();
    expect(w.ycForm._draftConflict).toBe(true);
    w.document.getElementById('draftDiscard').click();
    for (let i = 0; i < 50 && banner(w) !== 'none'; i++) await sleep(10);
    expect([banner(w), w.ycForm._draftConflict, p.server.row]).toEqual(['none', false, null]);
    type(w, 'trustee_name', 'Mine, after discard');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([null, null]);
    expect(p.server.row.data.trustee_name).toBe('Mine, after discard');
    expect(status(w)).toBe('Draft saved just now');
  });

  test('Restore adopts the newer row (its id + updated_at), clears the hold, and the next autosave lands', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Mine');
    await w.ycForm.autosaveTick();
    const theirs = elsewhere(p, { trustee_name: 'Theirs', outcome: 'Continued' });
    type(w, 'trustee_name', 'Mine again');
    await w.ycForm.autosaveTick();
    w.document.getElementById('draftRestore').click();
    expect([w.ycForm._draftConflict, banner(w), w.document.querySelector('[name="trustee_name"]').value]).toEqual([false, 'none', 'Theirs']);
    type(w, 'outcome', 'Concluded');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([theirs.id, theirs.updated_at]);
    expect(p.server.row.data).toEqual({ trustee_name: 'Theirs', outcome: 'Concluded' });
    expect(status(w)).toBe('Draft saved just now');
  });

  test('the draft discarded in another browser: the next autosave (still naming the old row) saves a new draft — no 409, no hold', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Mine');
    await w.ycForm.autosaveTick();
    const old = p.server.row;
    p.server.row = null;                                         // discarded in another browser
    type(w, 'trustee_name', 'Mine again');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([old.id, old.updated_at]);
    expect(p.server.row.id).not.toBe(old.id);
    expect([w.ycForm._draftConflict, banner(w), status(w)]).toEqual([false, 'none', 'Draft saved just now']);
    const fresh = p.server.row;
    type(w, 'trustee_name', 'Mine, once more');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([fresh.id, fresh.updated_at]);
  });

  test('a 409 whose row is already gone again (draft null): no hold; the next change sends null and lands', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Mine');
    await w.ycForm.autosaveTick();
    p.server.row = null;
    p.server.forceGone409 = true;
    type(w, 'trustee_name', 'Mine again');
    await w.ycForm.autosaveTick();
    expect(posts(p.calls).length).toBe(2);
    expect([w.ycForm._draftConflict, banner(w), p.server.row]).toEqual([false, 'none', null]);
    expect(status(w)).toBe('Draft not saved — the draft changed elsewhere; your next change saves it');
    type(w, 'trustee_name', 'Mine, once more');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([null, null]);
    expect(p.server.row.data.trustee_name).toBe('Mine, once more');
  });

  test('save()\'s cleanup DELETE leaves the form holding no draft: the next autosave sends null / null', async () => {
    const p = boot();
    const w = await ready(p);
    type(w, 'trustee_name', 'Mine');
    await w.ycForm.autosaveTick();
    expect(p.server.row).not.toBe(null);
    await w.ycForm.save();
    for (let i = 0; i < 50 && p.server.row; i++) await sleep(10);
    expect(p.calls.filter((c) => c.method === 'DELETE').length).toBe(1);
    type(w, 'trustee_name', 'After the save');
    await w.ycForm.autosaveTick();
    expect(expectedOf(lastPost(p.calls))).toEqual([null, null]);
    expect(status(w)).toBe('Draft saved just now');
  });
});

describe('external serverDrafts', () => {
  test('its autosave sends NO precondition (the external route is unchanged), even after a Restore of a server draft', async () => {
    const fetches = [];
    const EXT_DEF = { toggle: false, autosave: true, autosaveMs: 60000, external: { badLink: 'degrade', serverDrafts: true },
      sections: [{ title: 'S', rows: [{ fields: [{ name: 'reason', type: 'text' }] }] }] };
    const fetchStub = async (u, init) => {
      const method = (init && init.method) || 'GET';
      fetches.push({ url: u, method, body: init && init.body ? JSON.parse(init.body) : null });
      if (u.indexOf('/draft') !== -1) return { ok: true, status: 200, json: async () => ({ status: 'success', updated_at: '2026-11-11T12:00:00.000Z' }) };
      if (u.startsWith('/api/ext/forms/')) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', title: 'Q', link_type: 'case', schema_version: 3, definition: EXT_DEF,
          load: {}, linked: true, draft: { data: { reason: 'from my phone' }, updated_at: '2026-11-11T11:00:00.000Z', schema_version: 3 } }) };
      }
      throw new Error(`unstubbed fetch: ${method} ${u}`);
    };
    const dom = new JSDOM(RENDER_HTML, {
      url: 'https://app.test/forms/render.html?form_key=ext_pre&case_id=abc12345&ext=1',
      runScripts: 'dangerously', resources: new TestLoader(), pretendToBeVisual: true,
      beforeParse(window) {
        if (!window.CSS) window.CSS = { escape: (v) => String(v) };
        window.fetch = fetchStub;
        window.console.warn = () => {};
      },
    });
    DOMS.push(dom);
    const w = await ready({ w: dom.window });
    w.document.getElementById('draftRestore').click();
    type(w, 'reason', 'and from my laptop');
    await w.ycForm.autosaveTick();
    const post = fetches.find((f) => f.method === 'POST' && f.url.indexOf('/draft') !== -1);
    expect(post.url).toBe('/api/ext/forms/ext_pre/draft');
    expect(Object.keys(post.body).sort()).toEqual(['case_id', 'values']);
  });
});
