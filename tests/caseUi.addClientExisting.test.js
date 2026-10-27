/**
 * tests/caseUi.addClientExisting.test.js
 *
 * BOOTS public/case.html for real, in jsdom (harness from
 * tests/caseUi.detTab.test.js), and drives "Add Person to Case" → Create new
 * → newContact's existing-contact check → the case attach.
 *
 * WHY: the create-new branch used to pass force_create, which skipped the
 * check. Creating a contact with a phone/email another contact holds MOVES
 * it (contactService.createContact ends it on the holder), so adding a joint
 * filer whose spouse shares the phone silently took the phone off the spouse.
 * Now the check runs: "Use" attaches the existing contact as-is (no contact
 * write), "Create a separate new contact" creates (duplicate=duplicate) and
 * attaches the new one. And it opens contactOnly: no Case Type rows and no
 * "Add & Open Case" — that path handed the callback a CASE, which case.html
 * then attached as if it were a contact (plus a stray second case).
 *
 * ON LEXICAL SCOPE: scripts.js and case.html's inline blocks are concatenated
 * into ONE eval to match browser semantics (see caseUi.detTab.test.js).
 *
 *   npx jest tests/caseUi.addClientExisting.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/case.html'), 'utf8');
const YCSYNC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

const CASE_ID = 'AAAAAAAA';
const SPOUSE = { contact_id: 41, contact_name: 'John Doe', matched_by_phone: { source: 'child_active' }, matched_by_email: null };

async function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/case.html?caseID=${CASE_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });

  const payload = {
    case: {
      case_id: CASE_ID, case_stage: 'Open', case_status: 'New', case_rec: 'N/A',
      case_source: 'Referral', case_notes: '', case_alerts: '', case_caption: '',
      case_type: 'Bankruptcy', case_subtype: 'Ch. 7', case_number: '', case_number_full: '',
      case_detailed_form: null, case_detailed_link: null,
    },
    clients: [], appts: [], log: [],
  };
  const calls = [];
  window.apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    if (url === `/api/cases/${CASE_ID}/pipeline`) return { template: null, stages: [], history: [], current: null };
    if (/^\/api\/cases\/[^/]+$/.test(url) && method === 'GET') {
      return params && params.include === 'appts' ? { appts: [] } : payload;
    }
    if (url === '/api/log')    return { entries: [], total: 0 };
    if (url === '/api/events') return { data: [] };
    if (url.startsWith('/api/calendar-types/options')) return { status: 'success', data: [] };
    if (url.startsWith('/api/contact-lookup')) return { status: 'success', matches: [SPOUSE], summary: {} };
    if (url === '/api/intake/contact') return { id: 77, status: 'success', name: 'Jane Doe', action: 'created' };
    return { status: 'success' };
  };
  window.firmData = {
    users: [{ user: 1, user_name: 'Stuart', does_appts: 1 }], phoneLines: [], emailFrom: [],
    settings: { case_types: { Bankruptcy: ['Ch. 7', 'Ch. 13'] }, lead_sources: ['Referral'] },
    currentUser: { user: 6 }, firmTimezone: 'America/Detroit',
  };
  window.limit   = 100;
  window.addFile = () => {};

  // Swal: render each dialog into its own host (case.html's DOM stays), keep
  // the config, and let the test resolve the dialog's promise.
  const swal = { toasts: [] };
  window.Swal = {
    mixin: () => ({ fire: (o) => { swal.toasts.push(o); } }),
    fire: (cfg) => {
      swal.last = cfg;
      let host = window.document.getElementById('swal-host');
      if (!host) { host = window.document.createElement('div'); host.id = 'swal-host'; window.document.body.appendChild(host); }
      host.innerHTML = cfg.html || '';
      if (cfg.didOpen) cfg.didOpen();
      return new Promise((resolve) => { swal.resolve = resolve; });
    },
    close: () => {}, showLoading: () => {}, update: () => {},
    showValidationMessage: (m) => { swal.validation = m; },
    resetValidationMessage: () => { swal.validation = null; },
    getConfirmButton: () => null, isLoading: () => false,
    stopTimer: () => {}, resumeTimer: () => {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML = noComments.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(inline.length).toBe(7);   // same fence as caseUi.detTab / caseUi.sync

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  window.eval([SCRIPTS, ...inline, ';window.__addCaseClient = addCaseClient;'].join('\n;\n'));
  await tick(window, 60);
  return { window, calls, swal, errors };
}

const E = (w, id) => w.document.getElementById(id);

/** Add Person → relation Secondary → Create new → fill the New Client dialog → submit once (hits the match). */
async function toMatchBox(window, swal) {
  window.__addCaseClient();
  E(window, 'acc-relate').value = 'Secondary';
  E(window, 'acc-picker-mount').querySelector('input').value = 'Jane Doe';
  E(window, 'acc-create-new').click();
  await tick(window, 30);
  expect(swal.last.title).toBe('Add New Client:');
  expect(E(window, 'NCName').value).toBe('Jane Doe');
  // contactOnly: the callback attaches a CONTACT, so no way to make a case
  expect(E(window, 'NCType')).toBeNull();
  expect(swal.last.showDenyButton).toBe(false);
  E(window, 'NCPhone').value = '(555) 555-1212';
  expect(await swal.last.preConfirm()).toBe(false);
  expect(E(window, 'NCMatch').textContent).toMatch(/John Doe/);
}

async function submit(window, swal) {
  const value = await swal.last.preConfirm();
  expect(value).not.toBe(false);
  swal.resolve({ isConfirmed: true, value });
  await tick(window, 30);
}

const attaches = (calls) => calls.filter(c => c.url === `/api/cases/${CASE_ID}/contacts` && c.method === 'POST');

describe('case.html Add Person → Create new runs the existing-contact check', () => {
  test('Use → the existing contact is attached as-is; no contact write', async () => {
    const { window, calls, swal, errors } = await boot();
    await toMatchBox(window, swal);
    window.document.querySelector('#NCMatch button[data-nc="use"]').click();
    await submit(window, swal);
    expect(calls.filter(c => c.url === '/api/intake/contact')).toHaveLength(0);
    expect(attaches(calls).map(c => c.params)).toEqual([{ contact_id: 41, relate_type: 'Secondary' }]);
    expect(swal.toasts.map(t => t.title)).toContain('Added to case');
    expect(errors).toEqual([]);
  });

  test('Create separately → a new contact (duplicate=duplicate) is attached', async () => {
    const { window, calls, swal, errors } = await boot();
    await toMatchBox(window, swal);
    window.document.querySelector('#NCMatch button[data-nc="separate"]').click();
    await submit(window, swal);
    expect(calls.filter(c => c.url === '/api/intake/contact').map(c => c.params))
      .toEqual([expect.objectContaining({ name: 'Jane Doe', phone: '5555551212', duplicate: 'duplicate' })]);
    expect(attaches(calls).map(c => c.params)).toEqual([{ contact_id: 77, relate_type: 'Secondary' }]);
    expect(swal.toasts.map(t => t.title)).toContain('Created and added to case');
    expect(calls.filter(c => c.url === '/api/intake/case')).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});
