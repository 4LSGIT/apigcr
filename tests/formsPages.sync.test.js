// tests/formsPages.sync.test.js
//
// The hand-built form pages on the sync bus (native slice, 2026-11-11).
//
// YCForm._setupSync() subscribes a form to `form:<link_type>:<link_id>` only
// when window.YC exists IN THE FORM'S OWN WINDOW. render.html loads
// /js/yc-sync.js itself for that reason; casedetails-bk.html,
// casedetails.html, issn.html and contact-form.html now carry a static
// <script src="/js/yc-sync.js"> before yc-forms.js, so init step 13d
// subscribes. Before it, a draft saved, discarded, adopted or submitted for
// the record from ANOTHER frame (an Ask Casey card, the record open in a
// second tab) left these pages blind: no banner, and their next autosave
// replaced the newer draft whole.
//
// Each page is booted FOR REAL in jsdom — the real yc-forms.js, yc-sync.js
// (loaded by the page's own tag; nothing evaluates it into the page) and
// yc-custom-fields.js — with the API mocked at apiSend. Two topologies:
//
//   · FLAT (the tests/contactFormRoles.sync.test.js shape): window.parent ===
//     window, so the page's P.apiSend is the stub. The SHELL is a second
//     jsdom window with its own yc-sync.js: the stub runs the shell's
//     YC._sniff a macrotask after answering, exactly as index.html's apiSend
//     does in the shell's realm, and the page hears it over BroadcastChannel
//     (tests/helpers/bcPolyfill.js — one registry across windows).
//   · NESTED (production): the page in a real <iframe> under a host window
//     that holds its own yc-sync.js and apiSend (case.html / contact.html).
//     The form's _api calls window.parent.apiSend — the HOST's — the sniff
//     runs in the host's realm, and the iframe's SECOND yc-sync instance
//     hears it over the channel; contact-form's Roles reader stays on the
//     host's bus (P.YC).
//
// Per page: its record's message → one GET /api/forms/latest + the draft
// banner; another record / another entity → nothing; its own draft POST and
// DELETE, announced back within SYNC_ECHO_MS → fenced (and the message DID
// arrive — the page's bus logged it); unsaved typing → never repopulated,
// banner up, autosave held (_draftConflict); a hidden page parks the message
// and runs it once when visible. contact-form's own save() clears the hold:
// it DELETEs the superseded draft, hides the banner, clears _draftConflict.
//
// OFF SCREEN (NESTED, the frame's getClientRects() empty — what a display:none
// iframe answers): the message is answered AT ONCE. It used to park until a
// `resize` that Chromium never fires in an already-laid-out iframe whose host
// flips display, and nothing else wakes a nested form frame, so the form sat
// stale until the user typed into it. Off screen and dirty: still never
// repopulated — the banner and the held autosave come regardless.
//
//   npx jest tests/formsPages.sync.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const SERVED = {
  '/js/yc-forms.js': read('public/js/yc-forms.js'),
  '/js/yc-custom-fields.js': read('public/js/yc-custom-fields.js'),
  '/js/yc-sync.js': read('public/js/yc-sync.js'),
};
const YCSYNC = SERVED['/js/yc-sync.js'].toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach((fn) => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const CASE_ID = 'CASEBUS1';
const PAGES = [
  { file: 'casedetails-bk.html', formKey: 'case_details',         linkType: 'case',    linkId: CASE_ID, query: `case_id=${CASE_ID}`, field: 'case_caption',  other: 'contact' },
  { file: 'casedetails.html',    formKey: 'case_details_general', linkType: 'case',    linkId: CASE_ID, query: `case_id=${CASE_ID}`, field: 'case_caption',  other: 'contact' },
  { file: 'issn.html',           formKey: 'issn',                 linkType: 'case',    linkId: CASE_ID, query: `case_id=${CASE_ID}`, field: 'intake_notes',  other: 'contact' },
  { file: 'contact-form.html',   formKey: 'contact_info',         linkType: 'contact', linkId: '5',     query: 'contact_id=5',       field: 'contact_notes', other: 'case' },
];
const CONTACT_FORM = PAGES[3];

const caseRow = () => ({
  case_id: CASE_ID, case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_number: '', case_number_full: '',
  case_caption: 'In re Pat', case_our_role: '', case_judge: '', case_trustee: '', case_341_link: '',
  case_notes: '', case_alerts: '', custom: {},
});
const contactRow = () => ({
  contact_id: 5, contact_kind: 'person', contact_fname: 'Pat', contact_lname: 'One', contact_mname: '', contact_pname: '',
  contact_org_name: '', contact_dob: null, contact_ssn: '', contact_tags: '', contact_notes: '', custom: {},
  phones: [], emails: [], addresses: [],
});
const caseyDraft = (cfg) => ({
  id: 99, schema_version: 1, data: { [cfg.field]: 'From Casey' },
  updated_at: new Date(Date.now() + 1000).toISOString(), submitted_by: 6, user_name: 'Fred',
});

/** Serves the three modules; everything else (CSS, CDN, themeSync) empty.
 *  `prepare(win)` runs for each window on its FIRST fetch — before any of its
 *  scripts execute — which is how the nested iframe gets its BroadcastChannel. */
class Loader extends ResourceLoader {
  constructor(fetched, prepare) { super(); this.fetched = fetched; this.prepare = prepare; }
  fetch(url, opts) {
    const p = new URL(url).pathname;
    this.fetched.push(p);
    if (this.prepare && opts && opts.element) {
      try { this.prepare(opts.element.ownerDocument.defaultView); } catch (_) { /* noop */ }
    }
    return Promise.resolve(SERVED[p] || Buffer.from(''));
  }
}

const PREPARED = new WeakSet();
function prepareWindow(win) {
  if (!win || PREPARED.has(win)) return;
  PREPARED.add(win);
  win.firmData = { settings: { trustees: [] }, users: [], firmTimezone: 'America/Detroit' };
  win.Swal = { mixin: () => ({ fire: () => {} }), stopTimer() {}, resumeTimer() {}, getHtmlContainer: () => null,
    fire: async () => ({ isConfirmed: false }) };
  win.confirm = () => true;
  if (!win.CSS) win.CSS = {};
  if (!win.CSS.escape) win.CSS.escape = (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, (c) => '\\' + c);
  win.console.warn = () => {};
  TEARDOWNS.push(bcPolyfill.install(win));
}

/** The API, answered as the routes do — including the { form_key, link_type,
 *  link_id } echo the draft routes carry for the yc-sync matcher — then the
 *  sniff, a macrotask later, in `sniffWin`'s realm (the shell's / the host's). */
function makeApi(cfg, state, calls, sniffWin) {
  return async (url, method, body) => {
    calls.push({ url, method, body });
    const echo = { form_key: cfg.formKey, link_type: cfg.linkType, link_id: cfg.linkId };
    let data = { status: 'success' };
    if (url.startsWith('/api/forms/latest')) data = state.latest;
    else if (url === '/api/forms/draft' && method === 'POST') data = { status: 'success', id: 88, updated_at: new Date().toISOString(), ...echo };
    else if (url.startsWith('/api/forms/draft?') && method === 'DELETE') data = { status: 'success', deleted: true, ...echo };
    else if (url === '/api/forms/submit') data = { status: 'success', id: 7, version: 2, updated_at: new Date().toISOString() };
    else if (url === '/api/field-defs') data = { status: 'success', defs: [] };
    else if (url.startsWith(`/api/cases/${CASE_ID}?include=clients`)) data = { case: caseRow(), clients: [] };
    else if (url === '/api/contacts/5' && method === 'GET') data = { status: 'success', contact: contactRow() };
    else if (url === '/api/contacts/5/phones') data = { status: 'success', phones: [] };
    else if (url === '/api/contacts/5/emails') data = { status: 'success', emails: [] };
    else if (url === '/api/contact-role-types') data = { status: 'success', types: [] };
    else if (url === '/api/contacts/5/roles' && method === 'GET') data = { status: 'success', roles: [] };
    setTimeout(() => { try { sniffWin().YC._sniff(method, url, data); } catch (_) { /* noop */ } }, 0);
    return data;
  };
}

/** Another frame of the app with the real bus and no page: the shell (FLAT),
 *  or the assistant pane announcing a Casey card. */
function busWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  DOMS.push(dom);
  prepareWindow(dom.window);
  dom.window.eval(YCSYNC);
  return dom.window;
}

async function ready(w, label) {
  for (let i = 0; i < 300; i++) {
    const f = w.ycForm;
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (f && f._initDone && f._syncOn && (!ov || ov.style.display === 'none')) return w;
    await sleep(10);
  }
  throw new Error(`${label}: the form never finished init / never subscribed`);
}

/** FLAT: the page is the top window; the shell is another window. */
async function boot(cfg, { latest } = {}) {
  const calls = []; const fetched = [];
  const state = { latest: latest || { submitted: null, draft: null } };
  const shell = busWindow();
  const apiSend = makeApi(cfg, state, calls, () => shell);
  const dom = new JSDOM(read(`public/forms/${cfg.file}`).toString('utf8'), {
    url: `https://app.4lsg.com/forms/${cfg.file}?${cfg.query}`,
    runScripts: 'dangerously', resources: new Loader(fetched), pretendToBeVisual: true,
    beforeParse(win) {
      prepareWindow(win);
      win.apiSend = apiSend;                 // window.parent === window: this IS P.apiSend
    },
  });
  DOMS.push(dom);
  const w = await ready(dom.window, cfg.file);
  w.ycForm.config.autosaveMs = 60000;        // the user's own autosave timer stays out of the way
  return { w, shell, calls, fetched, state };
}

/** NESTED: the page in a real <iframe> under a host page with its own bus. */
async function bootNested(cfg, { latest } = {}) {
  const calls = []; const fetched = [];
  const state = { latest: latest || { submitted: null, draft: null } };
  let hostWin = null;
  const hostSubs = [];                       // every address subscribed on the HOST's bus
  const apiSend = makeApi(cfg, state, calls, () => hostWin);
  const PAGE = read(`public/forms/${cfg.file}`);
  class NestedLoader extends Loader {
    fetch(url, opts) {
      const u = new URL(url);
      if (u.pathname === `/forms/${cfg.file}`) { this.fetched.push(u.pathname); return Promise.resolve(PAGE); }
      return super.fetch(url, opts);
    }
  }
  const dom = new JSDOM(`<!DOCTYPE html><html><body><iframe id="f" src="/forms/${cfg.file}?${cfg.query}"></iframe></body></html>`, {
    url: 'https://app.4lsg.com/host.html',
    runScripts: 'dangerously', resources: new NestedLoader(fetched, prepareWindow), pretendToBeVisual: true,
    beforeParse(win) {
      prepareWindow(win);
      win.apiSend = apiSend;
      win.eval(YCSYNC);                      // the HOST's bus (case.html / contact.html load it)
      const on = win.YC.on;
      win.YC.on = function (addr, field, fn) { hostSubs.push(String(addr)); return on.call(this, addr, field, fn); };
    },
  });
  DOMS.push(dom);
  hostWin = dom.window;
  const iframe = hostWin.document.getElementById('f');
  iframe.getClientRects = () => [{ width: 800, height: 600 }];   // jsdom lays out nothing: "shown" (the OFF SCREEN tests flip it)
  let fw = null;
  for (let i = 0; i < 300 && !(fw && fw.ycForm); i++) { fw = iframe.contentWindow; await sleep(10); }
  if (!fw || !fw.ycForm) throw new Error(`${cfg.file}: the iframe never booted a form`);
  await ready(fw, `${cfg.file} (nested)`);
  fw.ycForm.config.autosaveMs = 60000;
  return { host: hostWin, iframe, fw, calls, fetched, state, hostSubs };
}

const latestReads = (calls) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/forms/latest')).length;
const draftPosts = (calls) => calls.filter((c) => c.method === 'POST' && c.url === '/api/forms/draft').length;
const draftDeletes = (calls) => calls.filter((c) => c.method === 'DELETE' && c.url.startsWith('/api/forms/draft?')).length;
const addrOf = (cfg) => `form:${cfg.linkType}:${cfg.linkId}`;
/** A draft saved for `linkType:linkId` in another frame, through the real matcher. */
const announce = (busWin, cfg, linkType = cfg.linkType, linkId = cfg.linkId) => busWin.YC._sniff('POST', '/api/forms/draft',
  { status: 'success', id: 99, updated_at: new Date().toISOString(), form_key: cfg.formKey, link_type: linkType, link_id: linkId });
const banner = (w) => w.document.getElementById('draftBanner').style.display;
function type(w, name, value) {
  const el = w.document.querySelector(`[name="${name}"]`);
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  return el;
}
const lastLogged = (w) => { const l = w.YC._log; return l.length ? l[l.length - 1].addr : null; };

describe.each(PAGES)('$file — on the sync bus', (cfg) => {
  test('loads /js/yc-sync.js in its OWN window, before yc-forms.js, and init subscribes', async () => {
    const { w, fetched } = await boot(cfg);
    expect(fetched.indexOf('/js/yc-sync.js')).toBeGreaterThan(-1);
    expect(fetched.indexOf('/js/yc-sync.js')).toBeLessThan(fetched.indexOf('/js/yc-forms.js'));
    expect([typeof w.YC.on, w.ycForm._syncOn]).toEqual(['function', true]);
  });

  test('its record: one GET /api/forms/latest and the draft banner; another record or entity: nothing', async () => {
    const { w, shell, calls, state } = await boot(cfg);
    const before = latestReads(calls);
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    announce(shell, cfg, cfg.linkType, 'OTHER9');                 // another record, same type
    announce(shell, cfg, cfg.other, cfg.linkId);                  // another entity type, same id
    shell.YC.emit(`${cfg.linkType}:${cfg.linkId}`, { yc_refetch: 1 }, 'test');   // the record row itself
    await sleep(40);
    expect(latestReads(calls)).toBe(before);
    expect(banner(w)).toBe('none');
    announce(shell, cfg);
    await sleep(60);
    expect(latestReads(calls)).toBe(before + 1);
    expect(banner(w)).toBe('flex');
    expect(w.document.querySelector(`[name="${cfg.field}"]`).value).not.toBe('From Casey');   // offered, not applied
    expect(w.ycForm._draftConflict).toBe(false);                  // a clean form holds nothing
  });

  test('ITS OWN draft POST and DELETE, announced back within SYNC_ECHO_MS, are fenced', async () => {
    const { w, calls, state } = await boot(cfg);
    const before = latestReads(calls);
    type(w, cfg.field, 'Own typing');
    await w.ycForm.autosaveTick();
    expect(draftPosts(calls)).toBe(1);
    await sleep(40);
    expect(lastLogged(w)).toBe(addrOf(cfg));                      // the echo DID reach this frame
    expect(latestReads(calls)).toBe(before);                      // …and was not re-read
    // The banner's Discard: its DELETE is stamped too.
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    w.ycForm._showDraftBanner(caseyDraft(cfg), null);
    const logged = w.YC._log.length;
    w.document.getElementById('draftDiscard').click();
    for (let i = 0; i < 50 && !draftDeletes(calls); i++) await sleep(10);
    await sleep(40);
    expect(draftDeletes(calls)).toBe(1);
    expect(w.YC._log.length).toBe(logged + 1);                    // the DELETE's echo arrived
    expect(latestReads(calls)).toBe(before);                      // …and was not re-read
    expect(banner(w)).toBe('none');
  });

  test('UNSAVED TYPING: never repopulated; the newer draft\'s banner shows and autosave HOLDS', async () => {
    const { w, shell, calls, state } = await boot(cfg);
    const el = type(w, cfg.field, 'Half typed');
    if (w.document.activeElement && w.document.activeElement.blur) w.document.activeElement.blur();
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    announce(shell, cfg);
    await sleep(60);
    expect(el.value).toBe('Half typed');
    expect([banner(w), w.ycForm._draftConflict]).toEqual(['flex', true]);
    const posts = draftPosts(calls);
    await w.ycForm.autosaveTick();
    expect(draftPosts(calls)).toBe(posts);
  });

  test('PARKED: a hidden page holds the refetch, and runs it once when visible', async () => {
    const { w, shell, calls } = await boot(cfg);
    let vis = 'hidden';
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => vis });
    const before = latestReads(calls);
    announce(shell, cfg);
    announce(shell, cfg);
    await sleep(40);
    expect(latestReads(calls)).toBe(before);
    vis = 'visible';
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await sleep(40);
    expect(latestReads(calls)).toBe(before + 1);
    w.document.dispatchEvent(new w.Event('visibilitychange'));    // spent
    await sleep(40);
    expect(latestReads(calls)).toBe(before + 1);
  });
});

describe.each(PAGES)('$file — NESTED in a host frame (production topology)', (cfg) => {
  test('the iframe\'s own bus hears the HOST\'s; its own draft write, sniffed in the host, is fenced', async () => {
    const { host, fw, calls, state } = await bootNested(cfg);
    expect(fw.YC).not.toBe(host.YC);                              // a SECOND instance, in the iframe's window
    expect(fw.parent).toBe(host);
    const before = latestReads(calls);
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    announce(host, cfg);                                          // the sniff runs in the host's realm
    await sleep(60);
    expect(latestReads(calls)).toBe(before + 1);
    expect(banner(fw)).toBe('flex');
    // Its own autosave goes out through window.parent.apiSend (the host's),
    // is sniffed THERE, crosses the channel back — and is fenced.
    type(fw, cfg.field, 'Own typing');
    await fw.ycForm.autosaveTick();
    expect(draftPosts(calls)).toBe(1);
    await sleep(40);
    expect([lastLogged(host), lastLogged(fw)]).toEqual([addrOf(cfg), addrOf(cfg)]);
    expect(latestReads(calls)).toBe(before + 1);
  });

  test('OFF SCREEN (its host tab not showing): the message is answered at once, with no resize', async () => {
    const { host, iframe, fw, calls, state } = await bootNested(cfg);
    iframe.getClientRects = () => [];                             // display:none, as Chromium answers it
    expect(fw.frameElement).toBe(iframe);                         // the stub is what the form would read
    expect(fw.frameElement.getClientRects().length).toBe(0);
    const before = latestReads(calls);
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    announce(host, cfg);
    await sleep(60);
    expect(latestReads(calls)).toBe(before + 1);
    expect(banner(fw)).toBe('flex');
    expect(fw.ycForm._syncStale).toBe(false);                     // nothing left parked
  });

  test('OFF SCREEN with unsaved typing: still never repopulated; the banner shows and autosave HOLDS', async () => {
    const { host, iframe, fw, calls, state } = await bootNested(cfg);
    iframe.getClientRects = () => [];
    const el = type(fw, cfg.field, 'Half typed');
    if (fw.document.activeElement && fw.document.activeElement.blur) fw.document.activeElement.blur();
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    announce(host, cfg);
    await sleep(60);
    expect(el.value).toBe('Half typed');
    expect([banner(fw), fw.ycForm._draftConflict]).toEqual(['flex', true]);
    const posts = draftPosts(calls);
    await fw.ycForm.autosaveTick();
    expect(draftPosts(calls)).toBe(posts);
  });
});

describe('contact-form.html — its own save() clears a draft held over the bus', () => {
  test('save DELETEs the superseded draft, hides the banner, clears _draftConflict; autosave resumes', async () => {
    const cfg = CONTACT_FORM;
    const { w, shell, calls, state } = await boot(cfg);
    type(w, cfg.field, 'Half typed');
    state.latest = { submitted: null, draft: caseyDraft(cfg) };
    announce(shell, cfg);
    await sleep(60);
    expect([banner(w), w.ycForm._draftConflict]).toEqual(['flex', true]);
    await w.ycForm.save();
    expect(calls.filter((c) => c.method === 'PATCH' && c.url === '/api/contacts/5').length).toBe(1);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url))
      .toEqual(['/api/forms/draft?form_key=contact_info&link_type=contact&link_id=5']);
    expect([banner(w), w.ycForm._draftConflict, w.ycForm._draftData]).toEqual(['none', false, null]);
    // The hold is gone: the next change autosaves.
    const posts = draftPosts(calls);
    type(w, cfg.field, 'After save');
    await w.ycForm.autosaveTick();
    expect(draftPosts(calls)).toBe(posts + 1);
  });

  test('the Roles reader stays on the HOST\'s bus (P.YC); the form listens on the page\'s own', async () => {
    const { host, fw, calls, hostSubs } = await bootNested(CONTACT_FORM);
    expect(hostSubs).toContain('roles:contact:5');                // the Roles reader: P.YC
    expect(hostSubs).not.toContain('form:*');                     // YCForm: never the host's bus
    expect([fw.ycForm._syncOn, fw.YC !== host.YC]).toEqual([true, true]);
    // And it still hears a role write announced in the host's realm.
    const roleGets = () => calls.filter((c) => c.url === '/api/contacts/5/roles' && c.method === 'GET').length;
    for (let i = 0; i < 100 && !roleGets(); i++) await sleep(10);
    await sleep(1600);                                            // past the boot load's echo stamp
    const before = roleGets();
    host.YC._sniff('DELETE', '/api/contacts/5/roles/9', { status: 'success', removed: 1 });
    await sleep(40);
    expect(roleGets()).toBe(before + 1);
  });
});
