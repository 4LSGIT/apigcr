// tests/formsSurfaces.sync.test.js
//
// The record's Forms tab (public/forms/submissionsWidget.html) and the Form
// Inbox (public/formInbox.html) on the sync bus (native slice, 2026-11-11;
// ref/plans.md "The record's Forms tab and the Form Inbox on the bus"). Both
// loaded /js/yc-sync.js and never subscribed, so a submission linked from the
// inbox, a draft submitted by an Ask Casey card, or a stock submit's draft
// cleanup showed in them only on reload.
//
// Each page is booted FOR REAL in jsdom, in the production topology: a real
// <iframe> under a host window (case.html for the widget, the shell for the
// inbox) that holds its own yc-sync.js and apiSend; the page's api() calls
// window.parent.apiSend — the HOST's — whose stub answers as the routes do and
// then runs the host's YC._sniff a macrotask later, as index.html's apiSend
// does. The page's OWN yc-sync.js (loaded by its own tag) hears it over
// BroadcastChannel (tests/helpers/bcPolyfill.js — one registry across
// windows). A third window with the real bus plays "another frame" (another
// tab's inbox, the Ask Casey pane) and announces through the REAL matchers
// (YC._sniff with route-shaped bodies), so every message carries the real
// address and origin. scripts.js / SweetAlert are not fetched: the helpers
// the pages reach for are stubbed, and Swal is a small stub that renders the
// dialog's html, runs didOpen / preConfirm / willClose and resolves fire()'s
// promise on close, as SweetAlert2 does. Every wait is bounded.
//
// Per page: a matching message → exactly one re-read; a draft SAVE (origin
// auto:POST /api/forms/draft) → none, a draft DELETE → one (a stock submit's
// only announcement); a burst coalesces; a load in flight is not doubled;
// parked while a dialog is open / the page is hidden, flushed on close /
// visibilitychange; an off-screen frame is NOT parked; the page's own writes:
// the inbox's link PATCH echo is fenced, POST …/pdf/file announces nothing;
// §3.6 — the handler emits nothing. Widget only: another record / entity →
// none. Inbox only: a filter select with the focus parks, focusout flushes;
// a message parked under the adopt dialog is answered by the link's own
// re-read (one read, not two).
//
//   npx jest tests/formsSurfaces.sync.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const SERVED = {
  '/js/yc-sync.js': read('public/js/yc-sync.js'),
  '/formInbox.html': read('public/formInbox.html'),
  '/forms/submissionsWidget.html': read('public/forms/submissionsWidget.html'),
};
const YCSYNC = SERVED['/js/yc-sync.js'].toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COALESCE = 400;            // > BUS_MS (250)

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach((fn) => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const CASE_ID = 'CASEBUS1';

class Loader extends ResourceLoader {
  constructor(prepare) { super(); this.prepare = prepare; }
  fetch(url, opts) {
    if (this.prepare && opts && opts.element) {
      try { this.prepare(opts.element.ownerDocument.defaultView); } catch (_) { /* noop */ }
    }
    return Promise.resolve(SERVED[new URL(url).pathname] || Buffer.from(''));
  }
}

/** A SweetAlert2 stand-in: renders html, runs the hooks, resolves on close. */
function swalStub(win) {
  const S = { current: null, opened: 0, validation: null };
  S.fire = (opts) => new Promise((resolve) => {
    if (S.current) S.current.close({ isDismissed: true });   // a new fire replaces the open one
    const box = win.document.createElement('div');
    box.className = 'swal-stub';
    box.innerHTML = opts.html || '';
    win.document.body.appendChild(box);
    const confirmBtn = win.document.createElement('button');
    const dlg = {
      opts, confirmBtn,
      close(value) {
        if (S.current !== dlg) return;
        S.current = null;
        if (opts.willClose) opts.willClose();
        box.remove();
        resolve(value);
      },
    };
    S.current = dlg;
    S.opened++;
    if (opts.didOpen) opts.didOpen();
  });
  S.isVisible = () => !!S.current;
  S.close = () => { if (S.current) S.current.close({ isDismissed: true }); };
  S.getConfirmButton = () => (S.current ? S.current.confirmBtn : null);
  S.showValidationMessage = (m) => { S.validation = m; };
  S.mixin = () => ({ fire: () => Promise.resolve({}) });
  return S;
}

const PREPARED = new WeakSet();
function prepareWindow(win) {
  if (!win || PREPARED.has(win)) return;
  PREPARED.add(win);
  win.E = (id) => win.document.getElementById(id);
  win.Swal = swalStub(win);
  win.Toast = { fire: () => Promise.resolve({}) };
  win.fmtPhone = (v) => String(v == null ? '' : v);
  win.escAttr = (v) => String(v == null ? '' : v);
  win.newContact = (opts, onSuccess) => { win.__newContact = onSuccess; };
  win.__picks = [];
  win.CasePicker = (mount, opts) => { win.__picks.push(opts); return { destroy() {}, focus() {} }; };
  win.console.warn = () => {};
  TEARDOWNS.push(bcPolyfill.install(win));
}

/** Another frame of the app with the real bus and no page. */
function busWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  DOMS.push(dom);
  prepareWindow(dom.window);
  dom.window.eval(YCSYNC);
  return dom.window;
}

/** The API, answered as the routes do; then the sniff in the host's realm. */
function makeApi(state, calls, hostWin) {
  return async (url, method, body) => {
    calls.push({ url, method, body });
    let data = { status: 'success' };
    if (url === '/api/form-templates') {
      data = { status: 'success', templates: [{ form_key: 'intake', title: 'Intake', link_type: 'case', visibility: 'public' }] };
    } else if (url.startsWith('/api/forms/submissions?')) {
      if (state.gate) await state.gate;
      data = { status: 'success', submissions: state.rows(url) };
    } else if (/^\/api\/forms\/submissions\/\d+\/link$/.test(url) && method === 'PATCH') {
      if (state.patchDelay) await sleep(state.patchDelay);
      data = { status: 'success', id: Number(url.split('/')[4]), link_type: body.link_type, link_id: body.link_id,
        version: 1, linked_by: 6, intake_stamped: false, logged: true };
    } else if (/^\/api\/forms\/submissions\/\d+\/pdf\/file$/.test(url) && method === 'POST') {
      data = { status: 'success', placement: 'case', path: '/Cases/x/Intake (#41).pdf', warnings: [] };
    }
    const delay = (method === 'PATCH' && state.echoDelay) || 0;
    setTimeout(() => { try { hostWin().YC._sniff(method, url, data); } catch (_) { /* noop */ } }, delay);
    return data;
  };
}

const unlinkedRow = (id) => ({ id, form_key: 'intake', link_type: '', link_id: '', status: 'submitted', version: 1,
  data: '{"name":"Pat One","phone":"5550100"}', created_at: '2026-11-11T10:00:00.000Z' });
const caseRow = (id) => ({ id, form_key: 'intake', link_type: 'case', link_id: CASE_ID, status: 'submitted', version: 1,
  submitted_by: 6, user_name: 'Fred', created_at: '2026-11-11T10:00:00.000Z' });

async function bootPage(src, rowsFor) {
  const calls = [];
  const state = { gate: null, echoDelay: 0, patchDelay: 0, rows: rowsFor };
  let hostWin = null;
  const apiSend = makeApi(state, calls, () => hostWin);
  const dom = new JSDOM(`<!DOCTYPE html><html><body><iframe id="f" src="${src}"></iframe></body></html>`, {
    url: 'https://app.4lsg.com/host.html',
    runScripts: 'dangerously', resources: new Loader(prepareWindow), pretendToBeVisual: true,
    beforeParse(win) {
      prepareWindow(win);
      win.apiSend = apiSend;
      win.eval(YCSYNC);                      // the HOST's bus (the shell / case.html load it)
    },
  });
  DOMS.push(dom);
  hostWin = dom.window;
  const iframe = hostWin.document.getElementById('f');
  let fw = null;
  for (let i = 0; i < 300 && !(fw && fw.YC && fw.document.readyState === 'complete'); i++) { fw = iframe.contentWindow; await sleep(10); }
  if (!fw || !fw.YC) throw new Error(`${src}: the iframe never booted its bus`);
  return { host: hostWin, fw, iframe, calls, state };
}

/** A message from another frame, through the REAL matchers. */
const sniffFrom = (w, method, url, body) => w.YC._sniff(method, url, body);
const linkMsg = (w, subId, linkType, linkId) => sniffFrom(w, 'PATCH', `/api/forms/submissions/${subId}/link`,
  { status: 'success', id: subId, link_type: linkType, link_id: linkId, version: 1, linked_by: 6 });
const draftSave = (w, linkType, linkId) => sniffFrom(w, 'POST', '/api/forms/draft',
  { status: 'success', id: 90, updated_at: new Date().toISOString(), form_key: 'intake', link_type: linkType, link_id: linkId });
const draftDelete = (w, linkType, linkId) => sniffFrom(w, 'DELETE',
  `/api/forms/draft?form_key=intake&link_type=${linkType}&link_id=${linkId}`,
  { status: 'success', deleted: true, form_key: 'intake', link_type: linkType, link_id: linkId });
const submitDraft = (w, linkType, linkId) => sniffFrom(w, 'POST', '/api/forms/submissions/submit-draft',
  { status: 'success', id: 77, version: 2, link_type: linkType, link_id: linkId });

function hide(w) {
  let vis = 'hidden';
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => vis });
  return () => { vis = 'visible'; w.document.dispatchEvent(new w.Event('visibilitychange')); };
}

/** Count every emit / sniff in a window from now on (§3.6). */
function countEmits(w) {
  const n = { emit: 0, sniff: 0 };
  const emit = w.YC.emit; const sniff = w.YC._sniff;
  w.YC.emit = function () { n.emit++; return emit.apply(this, arguments); };
  w.YC._sniff = function () { n.sniff++; return sniff.apply(this, arguments); };
  return n;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('submissionsWidget.html (the record\'s Forms tab) — on the sync bus', () => {
  const SRC = `/forms/submissionsWidget.html?link_type=case&link_id=${CASE_ID}`;
  const reads = (calls) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/forms/submissions?status=submitted&link_type=')).length;
  async function boot() {
    const b = await bootPage(SRC, () => [caseRow(41)]);
    for (let i = 0; i < 100 && reads(b.calls) === 0; i++) await sleep(10);
    expect(reads(b.calls)).toBe(1);
    await sleep(30);
    expect(b.fw.document.querySelectorAll('.sw-row').length).toBe(1);
    b.other = busWindow();
    return b;
  }

  test('its record: one re-read; another record, another entity type, or the case row itself: none', async () => {
    const b = await boot();
    linkMsg(b.other, 50, 'case', 'OTHER9');                      // another record
    linkMsg(b.other, 51, 'contact', CASE_ID);                    // another entity type, same id
    b.other.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test'); // the case row, not its forms
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    linkMsg(b.other, 52, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    linkMsg(b.other, 53, 'case', CASE_ID.toLowerCase());          // compared lowercase, as YCForm does
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(3);
  });

  test('a draft SAVE re-reads nothing; a draft DELETE (a stock submit\'s cleanup) and a submit-draft each re-read once', async () => {
    const b = await boot();
    draftSave(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(b.fw.YC._log.some((m) => /POST \/api\/forms\/draft$/.test(m.origin))).toBe(true);   // it DID arrive
    expect(reads(b.calls)).toBe(1);
    draftDelete(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(3);
  });

  test('a burst coalesces into one re-read; a load in flight is not doubled — one more read follows it', async () => {
    const b = await boot();
    submitDraft(b.other, 'case', CASE_ID); linkMsg(b.other, 52, 'case', CASE_ID); draftDelete(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    let release; b.state.gate = new Promise((r) => { release = r; });
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(3);                              // in flight, held by the gate
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(3);                              // not doubled
    b.state.gate = null; release();
    await sleep(60);
    expect(reads(b.calls)).toBe(4);                              // the mid-load message, honoured once
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(4);
  });

  test('PARKED while a submission\'s view dialog is open; flushed once when it closes', async () => {
    const b = await boot();
    b.fw.document.querySelector('.sw-row .sw-btn').click();       // View
    expect(b.fw.document.querySelector('.swal-stub iframe.sw-view-frame')).toBeTruthy();
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    b.fw.Swal.close();
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
  });

  test('PARKED while the page is hidden; visibilitychange flushes once', async () => {
    const b = await boot();
    const show = hide(b.fw);
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    show();
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
    b.fw.document.dispatchEvent(new b.fw.Event('visibilitychange'));   // spent
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
  });

  test('an OFF-SCREEN frame is not parked (nothing would flush it)', async () => {
    const b = await boot();
    b.iframe.getClientRects = () => [];
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
  });

  test('its own File (POST …/pdf/file) announces nothing and re-reads nothing', async () => {
    const b = await boot();
    const hostLog = b.host.YC._log.length; const pageLog = b.fw.YC._log.length;
    [...b.fw.document.querySelectorAll('.sw-row .sw-btn')].find((el) => el.textContent === 'File').click();
    for (let i = 0; i < 50 && !b.calls.some((c) => c.url.endsWith('/pdf/file')); i++) await sleep(10);
    await sleep(COALESCE);
    expect(b.calls.filter((c) => c.method === 'POST' && c.url === '/api/forms/submissions/41/pdf/file').length).toBe(1);
    expect([b.host.YC._log.length, b.fw.YC._log.length]).toEqual([hostLog, pageLog]);
    expect(reads(b.calls)).toBe(1);
  });

  test('§3.6: the bus-triggered re-read emits nothing, in the page or the host', async () => {
    const b = await boot();
    const page = countEmits(b.fw); const host = countEmits(b.host);
    const sniffsBefore = host.sniff;
    submitDraft(b.other, 'case', CASE_ID);
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    expect([page.emit, page.sniff, host.emit]).toEqual([0, 0, 0]);
    expect(host.sniff - sniffsBefore).toBe(2);                    // the two GETs, dropped by the gate
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('formInbox.html (the Form Inbox) — on the sync bus', () => {
  const SRC = '/formInbox.html';
  const reads = (calls) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/forms/submissions?status=submitted&with_data=1')).length;
  async function boot() {
    const b = await bootPage(SRC, () => [unlinkedRow(41)]);
    for (let i = 0; i < 100 && reads(b.calls) === 0; i++) await sleep(10);
    expect(reads(b.calls)).toBe(1);
    await sleep(30);
    expect(b.fw.document.querySelectorAll('.fx-row').length).toBe(1);
    b.other = busWindow();
    return b;
  }
  const linkBtn = (b) => [...b.fw.document.querySelectorAll('.fx-row .fx-btn')].find((el) => /^Link/.test(el.textContent));

  test('every record\'s marker re-reads once (a burst coalesces); a draft SAVE re-reads nothing, a draft DELETE does', async () => {
    const b = await boot();
    linkMsg(b.other, 50, 'case', 'AAAA0001'); submitDraft(b.other, 'contact', '5'); linkMsg(b.other, 51, 'appt', '9');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    draftSave(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(b.fw.YC._log.some((m) => /POST \/api\/forms\/draft$/.test(m.origin))).toBe(true);   // it DID arrive
    expect(reads(b.calls)).toBe(2);
    draftDelete(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(3);
  });

  test('a load in flight is not doubled — one more read follows it', async () => {
    const b = await boot();
    let release; b.state.gate = new Promise((r) => { release = r; });
    submitDraft(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    submitDraft(b.other, 'case', 'AAAA0002');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    b.state.gate = null; release();
    await sleep(60);
    expect(reads(b.calls)).toBe(3);
  });

  test('ITS OWN link PATCH: the echo arrives and is fenced — only the page\'s own re-read runs', async () => {
    const b = await boot();
    b.state.echoDelay = 120;                                     // the echo lands after the page's own re-read
    linkBtn(b).click();
    const dlg = b.fw.Swal.current;
    expect(dlg && /Link submission #41/.test(dlg.opts.title)).toBe(true);
    b.fw.__picks[0].onSelect(CASE_ID, { case_id: CASE_ID, primary_contact_name: 'Pat One' });
    const out = await dlg.opts.preConfirm();
    expect(out && out.link_id).toBe(CASE_ID);
    dlg.close({ isConfirmed: true, value: out });
    await sleep(120 + COALESCE);
    expect(b.calls.filter((c) => c.method === 'PATCH').length).toBe(1);
    expect(b.fw.YC._log.some((m) => m.addr === `form:case:${CASE_ID}`)).toBe(true);   // the echo DID arrive
    expect(reads(b.calls)).toBe(2);                              // the page's own load() only
  });

  test('a SLOW link PATCH (longer than BUS_ECHO_MS) is still fenced — stamped again when it settles', async () => {
    const b = await boot();
    b.state.patchDelay = 1700; b.state.echoDelay = 120;
    linkBtn(b).click();
    const dlg = b.fw.Swal.current;
    b.fw.__picks[0].onSelect(CASE_ID, { case_id: CASE_ID });
    const out = await dlg.opts.preConfirm();
    dlg.close({ isConfirmed: true, value: out });
    await sleep(120 + COALESCE);
    expect(b.fw.YC._log.some((m) => m.addr === `form:case:${CASE_ID}`)).toBe(true);
    expect(reads(b.calls)).toBe(2);
  }, 10000);

  test('the Create contact + case chain\'s link PATCH is fenced too — only its own re-read runs', async () => {
    const b = await boot();
    b.state.echoDelay = 120;
    linkBtn(b).click();
    b.fw.document.getElementById('fxCreateNew').click();       // closes the dialog, hands off to newContact
    expect(b.fw.Swal.current).toBe(null);
    await sleep(30);
    b.fw.__newContact({ id: CASE_ID, case_relate: { contact_id: 5 } });   // the /api/intake/case answer
    await sleep(120 + COALESCE);
    expect(b.calls.filter((c) => c.method === 'PATCH' && c.url === '/api/forms/submissions/41/link').length).toBe(1);
    expect(b.fw.YC._log.some((m) => m.addr === `form:case:${CASE_ID}`)).toBe(true);
    expect(reads(b.calls)).toBe(2);
  });

  test('PARKED under the adopt dialog; Cancel flushes once', async () => {
    const b = await boot();
    linkBtn(b).click();
    expect(b.fw.Swal.current).toBeTruthy();
    linkMsg(b.other, 60, 'case', 'AAAA0001');                    // another tab linked a different row
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    b.fw.Swal.current.close({ isConfirmed: false, isDismissed: true });
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
  });

  test('a message parked under the adopt dialog is answered by the link\'s own re-read — one read, not two', async () => {
    const b = await boot();
    linkBtn(b).click();
    const dlg = b.fw.Swal.current;
    linkMsg(b.other, 60, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    b.fw.__picks[0].onSelect(CASE_ID, { case_id: CASE_ID });
    const out = await dlg.opts.preConfirm();
    dlg.close({ isConfirmed: true, value: out });
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
  });

  test('PARKED while the view dialog is open; flushed once when it closes', async () => {
    const b = await boot();
    [...b.fw.document.querySelectorAll('.fx-row .fx-btn')].find((el) => el.textContent === 'View').click();
    expect(b.fw.document.querySelector('.swal-stub iframe.fx-view-frame')).toBeTruthy();
    submitDraft(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    b.fw.Swal.close();
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
  });

  test('PARKED while a filter select has the focus; focusout flushes once', async () => {
    const b = await boot();
    const sel = b.fw.document.getElementById('fxFilter');
    sel.focus();
    expect(b.fw.document.activeElement).toBe(sel);
    submitDraft(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    sel.blur();
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
  });

  test('PARKED while the page is hidden; visibilitychange flushes once', async () => {
    const b = await boot();
    const show = hide(b.fw);
    submitDraft(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(1);
    show();
    await sleep(60);
    expect(reads(b.calls)).toBe(2);
  });

  test('an OFF-SCREEN panel is not parked (nothing would flush it)', async () => {
    const b = await boot();
    b.iframe.getClientRects = () => [];
    submitDraft(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
  });

  test('its own File (POST …/pdf/file) announces nothing and re-reads nothing', async () => {
    const b = await boot();
    const hostLog = b.host.YC._log.length; const pageLog = b.fw.YC._log.length;
    [...b.fw.document.querySelectorAll('.fx-row .fx-btn')].find((el) => el.textContent === 'File').click();
    for (let i = 0; i < 50 && !b.calls.some((c) => c.url.endsWith('/pdf/file')); i++) await sleep(10);
    await sleep(COALESCE);
    expect(b.calls.filter((c) => c.method === 'POST' && c.url === '/api/forms/submissions/41/pdf/file').length).toBe(1);
    expect([b.host.YC._log.length, b.fw.YC._log.length]).toEqual([hostLog, pageLog]);
    expect(reads(b.calls)).toBe(1);
  });

  test('§3.6: the bus-triggered re-read emits nothing, in the page or the host', async () => {
    const b = await boot();
    const page = countEmits(b.fw); const host = countEmits(b.host);
    submitDraft(b.other, 'case', 'AAAA0001');
    await sleep(COALESCE);
    expect(reads(b.calls)).toBe(2);
    expect([page.emit, page.sniff, host.emit]).toEqual([0, 0, 0]);
    expect(host.sniff).toBe(2);                                  // the two GETs, dropped by the gate
  });
});
