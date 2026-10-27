// tests/newCaseNewClient.test.js
//
/**
 * NewCaseForm's "+ New client" hand-off (public/scripts.js), booted for real
 * in jsdom with a stub shell + stub Swal (same boot as
 * tests/unifiedEventsU2b.pickers.test.js).
 *
 * Asserts:
 *   - the plain shell call (no prefill, no callback) shows the button;
 *     a prefilled contact, a docket, or an onSuccess hides it — those
 *     callers would lose the docket / the case-shaped callback across the
 *     hand-off;
 *   - clicking closes NewCaseForm and opens newContact with the picker's
 *     search term (name / phone / email) and the chosen case type, subtype
 *     and 'Other' free text pre-selected;
 *   - "Add & Open Case" there creates contact + case with that type/subtype.
 *
 * Run:  npx jest tests/newCaseNewClient.test.js
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

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/index.html', runScripts: 'dangerously' });
  DOMS.push(dom);
  const { window } = dom;
  const calls = [];
  window.apiSend = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.startsWith('/api/calendar-types/options')) return { status: 'success', data: [] };
    if (url === '/api/intake/contact') return { id: 77, status: 'success', name: 'Jane Doe' };
    if (url === '/api/intake/case') return { id: 'AB12', status: 'success' };
    return { status: 'success' };
  };
  window.firmData = {
    users: [{ user: 1, user_name: 'Stuart', does_appts: 1 }],
    settings: { case_types: { Bankruptcy: ['Chapter 7', 'Chapter 13'], Other: [] } },
    currentUser: { user: 1 },
  };
  const swal = { fired: [], closed: 0 };
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    isLoading: () => false,
    showValidationMessage: (m) => { swal.validation = m; },
    resetValidationMessage: () => { swal.validation = null; },
    getConfirmButton: () => null,
    close: () => { swal.closed++; if (swal.last && swal.last.willClose) swal.last.willClose(); },
    fire: (cfg) => {
      swal.last = cfg;
      swal.fired.push(cfg.title);
      window.document.body.innerHTML = `<div class="swal2-popup">${cfg.html || ''}</div>`;
      if (cfg.didOpen) cfg.didOpen();
      return new Promise(() => {});   // never resolves — the dialog stays open
    },
  };
  window.eval(SCRIPTS + '\n;window.E = E;');
  return { window, calls, swal };
}

const E = (w, id) => w.document.getElementById(id);

function pick(window, { term, type, subtype, other }) {
  E(window, 'ncf-picker-mount').querySelector('.cp-input').value = term;
  E(window, 'ncf-type').value = type;
  E(window, 'ncf-type').dispatchEvent(new window.Event('change'));
  if (subtype != null) E(window, 'ncf-subtype').value = subtype;
  if (other != null) E(window, 'ncf-other-type').value = other;
}

describe('NewCaseForm "+ New client"', () => {
  test('shown on the plain shell call only', () => {
    const cases = [
      [[], true],
      [[{ primary_contact_id: 5, primary_contact_name: 'Ann Lee' }], false],
      [[{ case_number: '26-12345' }], false],
      [[{ case_number_full: '2:26-bk-12345' }], false],
      [[{}, () => {}], false],
    ];
    for (const [args, shown] of cases) {
      const { window } = boot();
      window.NewCaseForm(...args);
      expect([args.length, !!E(window, 'ncf-new-client')]).toEqual([args.length, shown]);
    }
  });

  test('hands off name + type/subtype; Add & Open Case creates both', async () => {
    const { window, calls, swal } = boot();
    window.NewCaseForm();
    pick(window, { term: 'Jane Doe', type: 'Bankruptcy', subtype: 'Chapter 13' });
    E(window, 'ncf-new-client').click();
    await tick(window);

    expect(swal.closed).toBe(1);
    expect(swal.fired).toEqual(['Create new case', 'Add New Client:']);
    expect(E(window, 'NCName').value).toBe('Jane Doe');
    expect(E(window, 'NCType').value).toBe('Bankruptcy');
    expect(E(window, 'NCSubtype').value).toBe('Chapter 13');
    expect(E(window, 'NCSubtypeRow').style.display).toBe('');

    E(window, 'NCPhone').value = '(555) 555-1212';
    const out = await swal.last.preDeny();
    expect(out).not.toBe(false);
    expect(calls.find((c) => c.url === '/api/intake/contact').body).toMatchObject({ name: 'Jane Doe', phone: '5555551212' });
    expect(calls.find((c) => c.url === '/api/intake/case').body)
      .toEqual({ contact_id: 77, case_type: 'Bankruptcy', case_subtype: 'Chapter 13' });
  });

  test('phone / email search terms land in their own fields; Other text carries', async () => {
    let { window } = boot();
    window.NewCaseForm();
    pick(window, { term: '555-555-1212', type: 'Other', other: 'Civil Litigation' });
    E(window, 'ncf-new-client').click();
    expect(E(window, 'NCPhone').value).toBe('(555) 555-1212');
    expect(E(window, 'NCName').value).toBe('');
    expect(E(window, 'NCType').value).toBe('Other');
    expect(E(window, 'NCOtherType').value).toBe('Civil Litigation');
    expect(E(window, 'NCOtherType').style.display).toBe('');

    ({ window } = boot());
    window.NewCaseForm();
    pick(window, { term: 'jane@example.com', type: 'Bankruptcy' });
    E(window, 'ncf-new-client').click();
    expect(E(window, 'NCEmail').value).toBe('jane@example.com');
    expect(E(window, 'NCSubtype').value).toBe('');
  });
});
