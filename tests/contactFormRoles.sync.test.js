// tests/contactFormRoles.sync.test.js
//
// The contact form's Roles section answering `roles:contact:<id>` (the
// yc-sync matchers slice). Boots public/forms/contact-form.html for real in
// jsdom — the real yc-forms.js and yc-custom-fields.js — with the REAL
// public/js/yc-sync.js evaluated in the window, which is the HOST's bus: in
// jsdom window.parent === window, so the page's `P.YC` is that bus, exactly
// as contact.html's is in production (tests/consentUi.test.js's boot,
// tests/contactUi.sync.test.js's sniff-over-a-macrotask transport).
//
// What can go wrong, all run-time only:
//   · DEAF — another frame's role write leaves the section stale;
//   · ITS OWN ECHO — a role write here is announced back and the section
//     re-reads what it just painted;
//   · EATING TYPING — a re-read rebuilds every card; a card typed in and not
//     saved, an unsaved "+ Role" card or the caret in a role field must park
//     the message until that is done;
//   · OFF SCREEN — the section, the frame or the browser tab not showing parks
//     it too, and it runs once when shown again;
//   · §3.6 — the re-read is GETs only; nothing is announced.
//
//   npx jest tests/contactFormRoles.sync.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT = path.join(__dirname, '..');
const YCSYNC = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach((fn) => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const SERVED = {
  '/js/yc-forms.js': fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js')),
  '/js/yc-custom-fields.js': fs.readFileSync(path.join(ROOT, 'public/js/yc-custom-fields.js')),
};
class Loader extends ResourceLoader {
  fetch(url) { return Promise.resolve(SERVED[new URL(url).pathname] || Buffer.from('')); }
}

const ADDR = 'roles:contact:5';
const contactRow = () => ({
  contact_id: 5, contact_kind: 'person', contact_fname: 'Pat', contact_lname: 'One', contact_mname: '', contact_pname: '',
  contact_org_name: '', contact_dob: null, contact_ssn: '', contact_tags: '', contact_notes: '', custom: {},
  phones: [], emails: [], addresses: [],
});
const JUDGE = { role_code: 'judge', label: 'Judge', active: 1, sort_order: 0,
  attrs_schema: [{ key: 'judge_3', type: 'text', label: 'Docket suffix', required: true }] };
const CLERK = { role_code: 'clerk', label: 'Clerk', active: 1, sort_order: 1, attrs_schema: null };

async function boot() {
  const calls = [];
  let w;
  const apiSend = async (url, method, body) => {
    calls.push({ url, method });
    let data = { status: 'success' };
    if (method === 'GET' && url === '/api/contacts/5') data = { status: 'success', contact: contactRow() };
    else if (url === '/api/contacts/5/phones') data = { status: 'success', phones: [] };
    else if (url === '/api/contacts/5/emails') data = { status: 'success', emails: [] };
    else if (url.startsWith('/api/forms/latest')) data = { submitted: null, draft: null };
    else if (url === '/api/field-defs') data = { status: 'success', defs: [] };
    else if (url === '/api/contact-role-types') data = { status: 'success', types: [JUDGE, CLERK] };
    else if (url === '/api/contacts/5/roles' && method === 'GET') {
      data = { status: 'success', roles: [{ id: 9, contact_id: 5, role: 'judge', label: 'Judge', active: 1, attrs: { judge_3: 'lsg' } }] };
    } else if (/^\/api\/contacts\/5\/roles\/\d+$/.test(url) && method === 'PATCH') data = { status: 'success', id: Number(url.split('/').pop()) };
    else if (/^\/api\/contacts\/5\/roles\/\d+$/.test(url) && method === 'DELETE') data = { status: 'success', removed: 1 };
    else if (url === '/api/contacts/5/roles' && method === 'POST') data = { status: 'success', id: 10 };
    // The shell's sync-bus hook, a macrotask later — in production the sniff
    // runs in the SHELL's realm and reaches this frame over BroadcastChannel.
    setTimeout(() => { try { w.YC._sniff(method, url, data); } catch (_) { /* noop */ } }, 0);
    void body;
    return data;
  };
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/forms/contact-form.html'), 'utf8'), {
    url: 'https://app.4lsg.com/forms/contact-form.html?contact_id=5',
    runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true,
    beforeParse(win) {
      win.apiSend = apiSend;
      win.entityData = { contact: contactRow() };
      win.firmData = { settings: {}, users: [], firmTimezone: 'America/Detroit' };
      win.Swal = { mixin: () => ({ fire: () => {} }), stopTimer() {}, resumeTimer() {}, getHtmlContainer: () => null,
        fire: async () => ({ isConfirmed: true, value: 'clerk' }) };
      win.confirm = () => true;
      if (!win.CSS) win.CSS = {};
      if (!win.CSS.escape) win.CSS.escape = (v) => String(v);
      TEARDOWNS.push(bcPolyfill.install(win));
      win.eval(YCSYNC);                      // the host's bus (P.YC)
    },
  });
  DOMS.push(dom);
  w = dom.window;
  for (let i = 0; i < 300 && !(w.document.querySelector('[data-role-card="9"]')); i++) await sleep(10);
  if (!w.document.querySelector('[data-role-card="9"]')) throw new Error('contact-form: the Roles section never rendered');
  await sleep(1600);                         // past the boot load's echo stamp
  return { w, calls };
}

const roleGets = (calls) => calls.filter((c) => c.url === '/api/contacts/5/roles' && c.method === 'GET').length;
function setHidden(w, hidden) {
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}

describe('contact-form.html — Roles reader (roles:contact:<id>)', () => {
  test('a remote role change re-reads the section; another contact\'s does not', async () => {
    const { w, calls } = await boot();
    expect(roleGets(calls)).toBe(1);
    w.YC.emit('roles:contact:6', { yc_refetch: 1 }, 'test');
    await sleep(30);
    expect(roleGets(calls)).toBe(1);
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });

  test('a write from ANOTHER window, through the real matcher, reaches it', async () => {
    const { w, calls } = await boot();
    const other = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    DOMS.push(other);
    TEARDOWNS.push(bcPolyfill.install(other.window));
    other.window.eval(YCSYNC);
    other.window.YC._sniff('DELETE', '/api/contacts/5/roles/9', { status: 'success', removed: 1 });
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });

  test('ITS OWN ECHO: a role write here (deactivate, reactivate, delete) is announced back and swallowed', async () => {
    const { w, calls } = await boot();
    const before = w.YC._log.length;
    w.document.querySelector('[data-role-remove="9"]').click();
    await sleep(50);
    expect(w.YC._log.length).toBe(before + 1);                     // the bus DID announce it
    expect(w.YC._log[w.YC._log.length - 1].addr).toBe(ADDR);
    w.document.querySelector('[data-role-reactivate="9"]').click();
    await sleep(50);
    expect(roleGets(calls)).toBe(1);                               // and nothing re-read
  });

  test('EATING TYPING: a card typed in and not saved parks the message; its Save runs it once', async () => {
    const { w, calls } = await boot();
    const input = w.document.querySelector('[data-role-card="9"] [data-rkey="judge_3"]');
    input.value = 'abc';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    w.document.dispatchEvent(new w.Event('focusout'));
    await sleep(30);
    expect(roleGets(calls)).toBe(1);
    expect(input.value).toBe('abc');                              // the typing survives
    w.document.querySelector('[data-role-save="9"]').click();     // PATCH, then the parked re-read
    await sleep(50);
    expect(calls.filter((c) => c.method === 'PATCH').length).toBe(1);
    expect(roleGets(calls)).toBe(2);
  });

  test('EATING TYPING: the caret in a role field parks it; leaving the field runs it', async () => {
    const { w, calls } = await boot();
    const input = w.document.querySelector('[data-role-card="9"] [data-rkey="judge_3"]');
    input.focus();
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    await sleep(30);
    expect(roleGets(calls)).toBe(1);
    input.blur();                                                 // fires focusout
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });

  test('EATING TYPING: an unsaved "+ Role" card parks it; Cancel runs it', async () => {
    const { w, calls } = await boot();
    w.document.getElementById('roleAddBtn').click();              // Swal answers 'clerk'
    for (let i = 0; i < 50 && !w.document.querySelector('[data-role-card="new"]'); i++) await sleep(10);
    expect(w.document.querySelector('[data-role-card="new"]')).not.toBeNull();
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    await sleep(30);
    expect(roleGets(calls)).toBe(1);
    expect(w.document.querySelector('[data-role-card="new"]')).not.toBeNull();
    w.document.querySelector('[data-role-cancel="1"]').click();
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });

  test('OFF SCREEN: a hidden page parks it, and coming back runs exactly one re-read', async () => {
    const { w, calls } = await boot();
    setHidden(w, true);
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test2');
    w.document.dispatchEvent(new w.Event('visibilitychange'));   // still hidden
    await sleep(30);
    expect(roleGets(calls)).toBe(0 + 1);
    setHidden(w, false);
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
    w.document.dispatchEvent(new w.Event('visibilitychange'));   // spent
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });

  test('NOT SHOWING: the section hidden parks it; shown again (a resize), it runs', async () => {
    const { w, calls } = await boot();
    const sec = w.document.getElementById('rolesSection');
    sec.style.display = 'none';
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    await sleep(30);
    expect(roleGets(calls)).toBe(1);
    sec.style.display = '';
    w.dispatchEvent(new w.Event('resize'));
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });

  test('§3.6 — the re-read announces nothing; pagehide leaves no handler in the host bus', async () => {
    const { w, calls } = await boot();
    const before = w.YC._log.length;
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    await sleep(50);
    expect(roleGets(calls)).toBe(2);
    expect(w.YC._log.length).toBe(before + 1);                     // only the test's own emit
    await sleep(1600);                                             // past that re-read's echo stamp
    w.dispatchEvent(new w.Event('pagehide'));
    w.YC.emit(ADDR, { yc_refetch: 1 }, 'test');
    await sleep(30);
    expect(roleGets(calls)).toBe(2);
  });
});
