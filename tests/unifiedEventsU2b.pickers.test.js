// tests/unifiedEventsU2b.pickers.test.js
//
/**
 * Unified Events U2b — the two appointment-type pickers in public/scripts.js
 * (newContact's #NCApptTypeSel and newApptDialog's #naTypeSelect), booted
 * for real in jsdom with a stub shell + stub Swal.
 *
 * Asserts the slice's live-safety contract:
 *   - options come from GET /api/calendar-types/options?surface=…[&case_type=…]
 *     and render `text (N min)` with value = type_key + data-label/data-len;
 *   - a fetch FAILURE renders YC_APPT_TYPE_FALLBACK (the pre-U2b lists) — a
 *     registry outage never blanks a dialog;
 *   - picking writes label / length / key into the hidden fields, shows the
 *     length input, hides the free-text type; "Other" reverses that;
 *   - the submit body carries type_key AND appt_type (= type label);
 *   - the follow-up dialog passes the fixed case's case_type, and re-fetches
 *     when the case side changes;
 *   - per-(surface, case_type) 60s cache.
 *
 * Run:  npx jest tests/unifiedEventsU2b.pickers.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const OPTIONS = {
  new_client: [
    { option_id: 1, type_key: 'iss', label: 'Initial Strategy Session', type_label: 'Initial Strategy Session', length: 15, kind: 'meeting' },
    { option_id: 2, type_key: 'ss',  label: 'SS (quick)',               type_label: 'Strategy Session',         length: 15, kind: 'meeting' },
  ],
  follow_up: [
    { option_id: 2, type_key: 'ss',           label: 'Strategy Session',           type_label: 'Strategy Session',           length: 15, kind: 'meeting' },
    { option_id: 3, type_key: 'ss_follow_up', label: 'Strategy Session Follow Up', type_label: 'Strategy Session Follow Up', length: 30, kind: 'meeting' },
  ],
};

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms = 20) => new Promise((r) => w.setTimeout(r, ms));

/** Boots scripts.js; `apiSend` is scripted per URL prefix. Swal captures the last fire() config. */
function boot({ optionsFail = false, filterByCase = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/index.html', runScripts: 'dangerously' });
  DOMS.push(dom);
  const { window } = dom;
  const calls = [];
  window.apiSend = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.startsWith('/api/calendar-types/options')) {
      if (optionsFail) throw new Error('registry down');
      const u = new URL(url, 'https://x');
      const surface = u.searchParams.get('surface');
      const ct = u.searchParams.get('case_type');
      let rows = OPTIONS[surface] || [];
      if (filterByCase && ct === 'Civil Litigation') rows = rows.filter((r) => r.type_key === 'ss');
      return { status: 'success', data: rows };
    }
    if (url === '/api/intake/contact') return { id: 77, status: 'success' };
    if (url === '/api/appts') return { status: 'success', appt_id: 500, title: 'ok', message: 'ok' };
    if (url === '/api/availability') return { slots: {} };
    return { status: 'success' };
  };
  window.firmData = { users: [{ user: 1, user_name: 'Stuart', does_appts: 1 }], settings: {}, currentUser: { user: 1 } };
  const swal = { last: null };
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    isLoading: () => false,
    showValidationMessage: (m) => { swal.validation = m; },
    close: () => {},
    fire: (cfg) => {
      swal.last = cfg;
      window.document.body.innerHTML = `<div class="swal2-popup">${cfg.html || ''}</div>`;
      if (cfg.didOpen) cfg.didOpen();
      return new Promise(() => {});   // never resolves — the dialog stays open
    },
  };
  // scripts.js is a classic <script> in production, so its top-level `const E`
  // is global to inline handlers; indirect eval keeps it lexical. Mirror it.
  window.eval(SCRIPTS + '\n;window.E = E;');
  return { window, calls, swal };
}

const optionTexts = (sel) => [...sel.options].map((o) => o.textContent);
const E = (w, id) => w.document.getElementById(id);

describe('newContact picker (surface=new_client)', () => {
  test('renders registry options + Other; pick writes label/len/key; Other clears', async () => {
    const { window, calls } = boot();
    window.newContact();
    await tick(window);
    const sel = E(window, 'NCApptTypeSel');
    expect(calls.some((c) => c.url === '/api/calendar-types/options?surface=new_client')).toBe(true);
    expect(optionTexts(sel)).toEqual(['Appointment Type:', 'Initial Strategy Session (15 min)', 'SS (quick) (15 min)', 'Other']);

    sel.value = 'ss';
    sel.dispatchEvent(new window.Event('change'));
    expect(E(window, 'NCApptType').value).toBe('Strategy Session');     // TYPE label, not the override
    expect(E(window, 'NCApptLen').value).toBe('15');
    expect(E(window, 'NCApptKey').value).toBe('ss');
    expect(E(window, 'NCApptOtherSpan').style.display).toBe('');
    expect(E(window, 'NCApptType').style.display).toBe('none');

    sel.value = '';
    sel.dispatchEvent(new window.Event('change'));
    expect(E(window, 'NCApptType').value).toBe('');
    expect(E(window, 'NCApptKey').value).toBe('');
    expect(E(window, 'NCApptType').style.display).toBe('');
  });

  test('FALLBACK: options fetch fails → the pre-U2b list renders, byte for byte', async () => {
    const { window } = boot({ optionsFail: true });
    jest.spyOn(window.console, 'warn').mockImplementation(() => {});
    window.newContact();
    await tick(window);
    expect(optionTexts(E(window, 'NCApptTypeSel'))).toEqual([
      'Appointment Type:',
      'Initial Strategy Session (15 min)', 'Strategy Session (15 min)', 'Strategy Session Follow Up (15 min)',
      'Strategy Session Follow Up (30 min)', 'Pre-filing Meeting (30 min)', 'Schedules Completion Meeting (45 min)',
      'Documents Completion Meeting (30 min)', 'Matrix Completion Meeting (15 min)', 'Other',
    ]);
  });

  test('submit sends type_key + appt_type (type label) + edited length', async () => {
    const { window, calls, swal } = boot();
    window.newContact();
    await tick(window);
    E(window, 'NCName').value = 'Test Person';
    E(window, 'NCPhone').value = '(555) 555-1212';
    E(window, 'NCApptOn').checked = true;
    const sel = E(window, 'NCApptTypeSel');
    sel.value = 'iss'; sel.dispatchEvent(new window.Event('change'));
    E(window, 'NCApptLen').value = '20';                              // edited after the pick
    const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16);
    E(window, 'NCApptDate').value = future;
    const out = await swal.last.preConfirm();
    expect(out).not.toBe(false);
    const appt = calls.find((c) => c.url === '/api/appts');
    expect(appt.body).toMatchObject({ appt_type: 'Initial Strategy Session', type_key: 'iss', appt_length: '20', contact_id: 77 });
  });

  test('changing the case type re-fetches with case_type; the picker follows', async () => {
    const { window, calls } = boot({ filterByCase: true });
    window.newContact();
    await tick(window);
    E(window, 'NCType').value = 'Other';
    E(window, 'NCType').dispatchEvent(new window.Event('change'));
    E(window, 'NCOtherType').value = 'Civil Litigation';
    E(window, 'NCOtherType').dispatchEvent(new window.Event('change'));
    await tick(window);
    expect(calls.some((c) => c.url === '/api/calendar-types/options?surface=new_client&case_type=Civil%20Litigation')).toBe(true);
    expect(optionTexts(E(window, 'NCApptTypeSel'))).toEqual(['Appointment Type:', 'SS (quick) (15 min)', 'Other']);
  });
});

describe('newApptDialog picker (surface=follow_up)', () => {
  test('fixed case passes its case_type; options render; submit carries type_key', async () => {
    const { window, calls, swal } = boot();
    window.newApptDialog({ caseFixed: { id: 9, label: 'Case 9', case_type: 'Bankruptcy' }, contactFixed: { id: 3, label: 'Jane' } });
    await tick(window);
    expect(calls.some((c) => c.url === '/api/calendar-types/options?surface=follow_up&case_type=Bankruptcy')).toBe(true);
    const sel = E(window, 'naTypeSelect');
    expect(optionTexts(sel)).toEqual(['Appointment Type:', 'Strategy Session (15 min)', 'Strategy Session Follow Up (30 min)', 'Other']);
    sel.value = 'ss_follow_up'; sel.dispatchEvent(new window.Event('change'));
    expect(E(window, 'naLen').value).toBe('30');
    expect(E(window, 'naKey').value).toBe('ss_follow_up');
    const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16);
    E(window, 'naDate').value = future;
    const out = await swal.last.preConfirm();
    expect(out && out.data).toBeTruthy();
    const appt = calls.find((c) => c.url === '/api/appts');
    expect(appt.body).toMatchObject({ appt_type: 'Strategy Session Follow Up', type_key: 'ss_follow_up', appt_length: '30', case_id: 9 });
  });

  test('case list: picking a different case re-fetches with that case\u2019s type and keeps a still-offered pick', async () => {
    const { window, calls } = boot({ filterByCase: true });
    window.newApptDialog({
      contactFixed: { id: 3, label: 'Jane' },
      caseList: [{ case_id: 1, case_number: 'A', case_type: 'Bankruptcy' }, { case_id: 2, case_number: 'B', case_type: 'Civil Litigation' }],
    });
    await tick(window);
    const sel = E(window, 'naTypeSelect');
    sel.value = 'ss'; sel.dispatchEvent(new window.Event('change'));
    const caseSel = E(window, 'naCaseSel');
    caseSel.value = '2'; caseSel.dispatchEvent(new window.Event('change'));
    await tick(window);
    expect(calls.some((c) => c.url === '/api/calendar-types/options?surface=follow_up&case_type=Civil%20Litigation')).toBe(true);
    expect(optionTexts(sel)).toEqual(['Appointment Type:', 'Strategy Session (15 min)', 'Other']);
    expect(sel.value).toBe('ss');                       // the pick survived the re-render
    expect(E(window, 'naKey').value).toBe('ss');
  });

  test('fallback list for follow_up on fetch failure (no iss; schedules 20 last, as before)', async () => {
    const { window } = boot({ optionsFail: true });
    jest.spyOn(window.console, 'warn').mockImplementation(() => {});
    window.newApptDialog({ contactFixed: { id: 3, label: 'Jane' } });
    await tick(window);
    const texts = optionTexts(E(window, 'naTypeSelect'));
    expect(texts[1]).toBe('Strategy Session (15 min)');
    expect(texts[texts.length - 2]).toBe('Schedules Completion Meeting (20 min)');
    expect(texts).not.toContain('Initial Strategy Session (15 min)');
  });
});

describe('ycApptTypeOptions cache', () => {
  test('one fetch per (surface, case_type) inside the TTL', async () => {
    const { window, calls } = boot();
    await window.ycApptTypeOptions('follow_up');
    await window.ycApptTypeOptions('follow_up');
    await window.ycApptTypeOptions('follow_up', 'Bankruptcy');
    await window.ycApptTypeOptions('new_client');
    expect(calls.filter((c) => c.url.startsWith('/api/calendar-types/options')).map((c) => c.url)).toEqual([
      '/api/calendar-types/options?surface=follow_up',
      '/api/calendar-types/options?surface=follow_up&case_type=Bankruptcy',
      '/api/calendar-types/options?surface=new_client',
    ]);
  });
});
