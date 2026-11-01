// tests/checklistView.sync.test.js
//
// A10: the Notes & Lists board hears a checklist write made in ANOTHER frame.
//
// public/js/yc-sync.js announces POST /checklists, POST /checklists/:id/items
// and PATCH /checkitems/:id as `checklist:<link_type>:<link>`. Before A10 the
// board (checklistView.html, in case.html's / contact.html's Notes & Lists tab)
// heard none of them: a Casey card applied from the assistant pane left an
// open board stale until its tab was re-entered. What this file pins, on the
// REAL page booted in jsdom with the REAL yc-sync (the autoGrow harness):
//
//   · a write announced from another window reloads the board — for its own
//     record and, on a case board, for each related contact's group;
//   · another record's write does not;
//   · the board's OWN write, echoed back, does not (api() stamps writes);
//   · a board being typed in, or hidden, PARKS the message and reloads when
//     the focus leaves / the page is visible again.
//
//   npx jest tests/checklistView.sync.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/checklistView.html'), 'utf8');
const YCSYNC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');
const CASE_ID = 'AAAAAAAA';

const DOMS = [], TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) {} });
});
const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

const LIST = { id: 412, kind: 'checklist', title: 'Pre-filing', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null,
  items: [{ id: 5120, checklist_id: 412, name: 'Pull credit report', status: 'incomplete', position: 1 }] };

// Another frame of the same app (the shell, or the assistant pane): the real
// bus, no page.
function otherWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  DOMS.push(dom);
  TEARDOWNS.push(bcPolyfill.install(dom.window));
  dom.window.eval(YCSYNC);
  return dom.window;
}

async function boot({ query = `link_type=case&link=${CASE_ID}` } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/checklistView.html?${query}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  let visibility = 'visible';
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });

  const listGets = [];
  window.apiSend = async (url, method, payload) => {
    let data = { status: 'success' };
    if (url === `/api/cases/${CASE_ID}` && method === 'GET') {
      data = { case: { case_id: CASE_ID, case_notes: '' } };
    } else if (url === '/api/contacts/77' && method === 'GET') {
      data = { contact: { contact_id: 77, contact_notes: '' }, cases: [] };
    } else if (url === '/checklists' && method === 'GET') {
      listGets.push(payload && payload.link);
      data = { checklists: payload && payload.link === CASE_ID ? [JSON.parse(JSON.stringify(LIST))] : [] };
    } else if (url === `/api/cases/${CASE_ID}/contacts`) {
      data = { contacts: [{ contact_id: 77, contact_name: 'Dana Client', relate_type: 'Primary' }] };
    } else if (url === '/checkitems/5120' && method === 'PATCH') {
      data = { ...LIST.items[0], ...payload, checklist: { id: 412, link_type: 'case', link: CASE_ID } };
    }
    // The shell's sniff runs at the success-return point of apiSend (here the
    // page IS the top window, so the echo is dispatched locally).
    window.setTimeout(() => { try { window.YC && window.YC._sniff(method, url, data); } catch (_) {} }, 0);
    return data;
  };
  window.Swal = {
    mixin: () => ({ fire: () => {} }), fire: async () => ({ isConfirmed: false }),
    close() {}, stopTimer() {}, resumeTimer() {},
  };
  window.firmData = { currentUser: { user: 6, roles: 'staff' } };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = noComments.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  window.eval([SCRIPTS, ...inline].join('\n;\n'));
  await tick(window, 150);
  // Count board reloads by the case's own /checklists GET.
  const reloads = () => listGets.filter((l) => l === CASE_ID).length;
  return { window, errors, reloads, setVisibility: (v) => { visibility = v; } };
}

describe('the Notes & Lists board hears checklist writes from other frames', () => {
  test('a write to THIS record, announced from another window, reloads the board', async () => {
    const { window, errors, reloads } = await boot();
    expect(errors).toEqual([]);
    expect(reloads()).toBe(1);   // the boot load
    const other = otherWindow();
    other.YC._sniff('POST', '/checklists/412/items', { ...LIST, items: [] });
    await tick(window, 100);
    expect(reloads()).toBe(2);
    other.YC._sniff('PATCH', '/checkitems/5120', { id: 5120, checklist: { id: 412, link_type: 'case', link: CASE_ID } });
    await tick(window, 100);
    expect(reloads()).toBe(3);
  });

  test('a write to a related CONTACT\'s list reloads the case board (its contact groups); another record\'s does not', async () => {
    const { window, reloads } = await boot();
    const other = otherWindow();
    other.YC._sniff('POST', '/checklists', { id: 9, link_type: 'contact', link: '77' });
    await tick(window, 100);
    expect(reloads()).toBe(2);
    other.YC._sniff('POST', '/checklists', { id: 10, link_type: 'case', link: 'BBBBBBBB' });
    other.YC._sniff('POST', '/checklists', { id: 11, link_type: 'contact', link: '78' });
    other.YC._sniff('POST', '/checklists', { id: 12, link_type: 'user', link: '6' });
    await tick(window, 100);
    expect(reloads()).toBe(2);
  });

  test('a personal board (link=me) hears the signed-in user\'s own lists', async () => {
    const { window } = await boot({ query: 'link_type=user&link=me' });
    let gets = 0;
    const real = window.apiSend;
    window.apiSend = async (url, method, payload) => { if (url === '/checklists' && method === 'GET') gets += 1; return real(url, method, payload); };
    otherWindow().YC._sniff('POST', '/checklists', { id: 12, link_type: 'user', link: '6' });
    await tick(window, 100);
    expect(gets).toBe(1);
  });

  test('the board\'s OWN write is not reloaded on its echo — locally or from another frame', async () => {
    const { window, reloads } = await boot();
    await window.api('/checkitems/5120', 'PATCH', { status: 'complete' });
    await tick(window, 50);
    // The same announcement arriving over the channel (the real shell is another context).
    otherWindow().YC._sniff('PATCH', '/checkitems/5120', { id: 5120, checklist: { id: 412, link_type: 'case', link: CASE_ID } });
    await tick(window, 100);
    expect(reloads()).toBe(1);
  });

  test('typing in the board PARKS the message; it reloads when the focus leaves the field', async () => {
    const { window, reloads } = await boot();
    const input = window.document.querySelector('.ck-add input[type=text]');
    expect(input).not.toBeNull();
    input.focus();
    expect(window.document.activeElement).toBe(input);
    otherWindow().YC._sniff('POST', '/checklists/412/items', { ...LIST, items: [] });
    await tick(window, 100);
    expect(reloads()).toBe(1);
    input.blur();
    await tick(window, 100);
    expect(reloads()).toBe(2);
  });

  test('a hidden page PARKS the message; it reloads when the page is visible again', async () => {
    const { window, reloads, setVisibility } = await boot();
    setVisibility('hidden');
    otherWindow().YC._sniff('POST', '/checklists/412/items', { ...LIST, items: [] });
    await tick(window, 100);
    expect(reloads()).toBe(1);
    setVisibility('visible');
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 100);
    expect(reloads()).toBe(2);
    // Nothing parked: a second visibility flip does not reload again.
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 100);
    expect(reloads()).toBe(2);
  });

  test('re-entering the tab (reloadChecklists) answers a parked message — it is not replayed later', async () => {
    const { window, reloads, setVisibility } = await boot();
    setVisibility('hidden');
    otherWindow().YC._sniff('POST', '/checklists/412/items', { ...LIST, items: [] });
    await tick(window, 100);
    setVisibility('visible');
    window.reloadChecklists();
    await tick(window, 100);
    expect(reloads()).toBe(2);
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 100);
    expect(reloads()).toBe(2);
  });
});
