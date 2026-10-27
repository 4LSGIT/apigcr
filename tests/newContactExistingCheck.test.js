// tests/newContactExistingCheck.test.js
//
/**
 * newContact's existing-contact check (public/scripts.js), booted for real in
 * jsdom with a stub shell + stub Swal (same boot as
 * tests/unifiedEventsU2b.pickers.test.js).
 *
 * The bug it replaces: the dialog POSTed /api/intake/contact without the
 * duplicate flag, so a single phone/email match took intake's find-and-UPDATE
 * path and overwrote the matched contact's name (a spouse on a shared phone
 * got renamed).
 *
 * Asserts:
 *   - before creating, the phone/email go through GET /api/contact-lookup;
 *     every create sends duplicate=duplicate (never the update path);
 *   - a match stops the submit and lists the contact; submitting again
 *     without choosing still writes nothing;
 *   - "Use" → no contact write at all; the case attaches to the matched id;
 *   - "Create a separate new contact" → intake with duplicate=duplicate;
 *   - editing the phone after choosing asks again;
 *   - a failed lookup fails closed; force_create callers skip the check;
 *   - contactOnly renders no case controls and never creates a case.
 *
 * Run:  npx jest tests/newContactExistingCheck.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms = 20) => new Promise((r) => w.setTimeout(r, ms));

const JOHN = { contact_id: 41, contact_name: 'John Doe', matched_by_phone: { source: 'child_active' }, matched_by_email: null };

function boot({ matches = [], lookupFails = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/index.html', runScripts: 'dangerously' });
  DOMS.push(dom);
  const { window } = dom;
  const calls = [];
  window.apiSend = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.startsWith('/api/calendar-types/options')) return { status: 'success', data: [] };
    if (url.startsWith('/api/contact-lookup')) {
      if (lookupFails) throw new Error('lookup down');
      return { status: 'success', matches, summary: {} };
    }
    if (url === '/api/intake/contact') return { id: 77, status: 'success', name: 'Jane Doe', action: 'created' };
    if (url === '/api/intake/case') return { id: 'AB12', status: 'success', case_relate: 1 };
    return { status: 'success' };
  };
  window.firmData = {
    users: [{ user: 1, user_name: 'Stuart', does_appts: 1 }],
    settings: { case_types: { Bankruptcy: ['Chapter 7'] } },
    currentUser: { user: 1 },
  };
  const swal = {};
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    isLoading: () => false,
    showValidationMessage: (m) => { swal.validation = m; },
    resetValidationMessage: () => { swal.validation = null; },
    close: () => {},
    fire: (cfg) => {
      swal.last = cfg;
      window.document.body.innerHTML = `<div class="swal2-popup">${cfg.html || ''}</div>`;
      if (cfg.didOpen) cfg.didOpen();
      return new Promise(() => {});   // never resolves — the dialog stays open
    },
  };
  window.eval(SCRIPTS + '\n;window.E = E;');
  return { window, calls, swal };
}

const E = (w, id) => w.document.getElementById(id);
const posts = (calls, url) => calls.filter((c) => c.url === url && c.method === 'POST');
const lookups = (calls) => calls.filter((c) => c.url.startsWith('/api/contact-lookup'));

async function open(opts, prefill) {
  const t = boot(opts);
  t.window.newContact(prefill);
  await tick(t.window);
  E(t.window, 'NCName').value = 'Jane Doe';
  E(t.window, 'NCPhone').value = '(555) 555-1212';
  E(t.window, 'NCType').value = 'Bankruptcy';
  E(t.window, 'NCType').dispatchEvent(new t.window.Event('change'));
  return t;
}
const click = (w, sel) => w.document.querySelector(`#NCMatch ${sel}`).click();

describe('newContact existing-contact check', () => {
  test('nothing on file → lookup by phone, create with duplicate=duplicate', async () => {
    const { calls, swal } = await open();
    const out = await swal.last.preDeny();
    expect(out).not.toBe(false);
    expect(lookups(calls).map((c) => c.body)).toEqual([{ phone: '5555551212' }]);
    expect(posts(calls, '/api/intake/contact')[0].body).toMatchObject({ name: 'Jane Doe', phone: '5555551212', duplicate: 'duplicate' });
    expect(posts(calls, '/api/intake/case')[0].body).toMatchObject({ contact_id: 77, case_type: 'Bankruptcy' });
  });

  test('a match stops the submit, lists the contact, and writes nothing until a choice', async () => {
    const { window, calls, swal } = await open({ matches: [JOHN] });
    expect(await swal.last.preDeny()).toBe(false);
    expect(swal.validation).toMatch(/already on file/);
    const box = E(window, 'NCMatch');
    expect(box.style.display).toBe('');
    expect(box.textContent).toMatch(/John Doe/);
    expect(box.textContent).toMatch(/#41 · same phone/);
    expect(await swal.last.preConfirm()).toBe(false);          // again, no choice
    expect(posts(calls, '/api/intake/contact')).toHaveLength(0);
    expect(posts(calls, '/api/intake/case')).toHaveLength(0);
  });

  test('Use → no contact write; the case attaches to the matched contact', async () => {
    const { window, calls, swal } = await open({ matches: [JOHN] });
    await swal.last.preDeny();
    click(window, 'button[data-nc="use"][data-id="41"]');
    expect(E(window, 'NCMatch').textContent).toMatch(/Using John Doe as-is/);
    const out = await swal.last.preDeny();
    expect(posts(calls, '/api/intake/contact')).toHaveLength(0);
    expect(posts(calls, '/api/intake/case')[0].body).toMatchObject({ contact_id: 41 });
    expect(out.contactData).toMatchObject({ id: 41, name: 'John Doe', action: 'existing' });
  });

  test('Use on the client path hands back the existing contact to open', async () => {
    const { window, calls, swal } = await open({ matches: [JOHN] });
    E(window, 'NCType').value = '';
    await swal.last.preConfirm();
    click(window, 'button[data-nc="use"]');
    const out = await swal.last.preConfirm();
    expect(out).toMatchObject({ type: 'client', data: { id: 41, name: 'John Doe', status: 'success' } });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('Create separately → intake with duplicate=duplicate', async () => {
    const { window, calls, swal } = await open({ matches: [JOHN] });
    await swal.last.preDeny();
    click(window, 'button[data-nc="separate"]');
    await swal.last.preDeny();
    expect(posts(calls, '/api/intake/contact')[0].body).toMatchObject({ duplicate: 'duplicate' });
    expect(posts(calls, '/api/intake/case')[0].body).toMatchObject({ contact_id: 77 });
  });

  test('editing the phone after choosing asks again', async () => {
    const { window, calls, swal } = await open({ matches: [JOHN] });
    await swal.last.preDeny();
    click(window, 'button[data-nc="use"]');
    E(window, 'NCPhone').value = '(555) 555-0000';
    expect(await swal.last.preDeny()).toBe(false);
    expect(lookups(calls).map((c) => c.body)).toEqual([{ phone: '5555551212' }, { phone: '5555550000' }]);
    expect(E(window, 'NCMatch').textContent).not.toMatch(/Using/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('a failed lookup fails closed', async () => {
    const { calls, swal } = await open({ lookupFails: true });
    expect(await swal.last.preDeny()).toBe(false);
    expect(swal.validation).toMatch(/Couldn't check/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('contactOnly: no case rows, no Add & Open Case, never a case', async () => {
    const { window, calls, swal } = boot();
    window.newContact({ contactOnly: true, case_type: 'Bankruptcy' });
    await tick(window);
    expect(E(window, 'NCType')).toBeNull();
    expect(E(window, 'NCSubtypeRow')).toBeNull();
    expect(swal.last.showDenyButton).toBe(false);
    E(window, 'NCName').value = 'Jane Doe';
    E(window, 'NCPhone').value = '(555) 555-1212';
    const out = await swal.last.preConfirm();
    expect(out).toMatchObject({ type: 'client', data: { id: 77 } });
    expect(posts(calls, '/api/intake/case')).toHaveLength(0);
  });

  test('without contactOnly the case controls are there', async () => {
    const { window, swal } = boot();
    window.newContact();
    await tick(window);
    expect(E(window, 'NCType')).not.toBeNull();
    expect(swal.last.showDenyButton).toBe(true);
  });

  test('force_create callers skip the check', async () => {
    const { calls, swal } = await open({ matches: [JOHN] }, { force_create: true });
    expect(await swal.last.preDeny()).not.toBe(false);
    expect(lookups(calls)).toHaveLength(0);
    expect(posts(calls, '/api/intake/contact')[0].body).toMatchObject({ duplicate: 'duplicate' });
  });
});
