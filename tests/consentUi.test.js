// tests/consentUi.test.js
//
// YisraMail P4 — the staff consent UI, booted in jsdom:
//   contact-form.html  badges per scope from the list routes' consent.scopes;
//                      nothing for a destination with no state row; the history
//                      popover fetched on click; the optional note revealed on a
//                      changed opt-out and sent as *_optout_note for THAT row only
//   campaign.html      the "N will be skipped" line from POST /api/consent/preview
// (the contact-form boot is tests/consentCore.test.js's: the real yc-forms.js,
// window.parent === window so apiSend / Swal stubs on the window ARE `P`).
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PAT = '3135550001';
const SAM = '3135550002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });

// ─────────────────────────────────────────────────────────────────────────────
describe('contact-form.html consent strip, history and note', () => {
  const SERVED = {
    '/js/yc-forms.js': fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js')),
    '/js/yc-custom-fields.js': fs.readFileSync(path.join(ROOT, 'public/js/yc-custom-fields.js')),
  };
  class Loader extends ResourceLoader {
    fetch(url) { return Promise.resolve(SERVED[new URL(url).pathname] || Buffer.from('')); }
  }
  const contactRow = () => ({
    contact_id: 5, contact_kind: 'person', contact_fname: 'Pat', contact_lname: 'One', contact_mname: '', contact_pname: '',
    contact_org_name: '', contact_dob: null, contact_ssn: '', contact_tags: '', contact_notes: '', custom: {},
    phones: [
      { id: 11, phone: PAT, label: 'Mobile', is_primary: 1, sms_optout: 1, mms_capable: 1, verified: 0, notes: '' },
      { id: 12, phone: SAM, label: 'Work', is_primary: 0, sms_optout: 0, mms_capable: 1, verified: 0, notes: '' },
    ],
    emails: [{ id: 21, email: 'pat@example.com', label: 'Personal', is_primary: 1, email_optout: 1, verified: 0, notes: '' }],
    addresses: [],
  });
  const AT = '2026-10-30T12:00:00.000Z';
  const LISTS = {
    phones: [
      { id: 11, phone: PAT, end_date: null, consent: { opted_out: true, version: '2', scopes: { all: { opted_out: true, state: 'opted_out', occurred_at: AT, source: 'staff' } } } },
      { id: 12, phone: SAM, end_date: null, consent: { opted_out: false, version: '0', scopes: {} } },
    ],
    emails: [
      { id: 21, email: 'pat@example.com', end_date: null, consent: { opted_out: false, version: '4', scopes: {
        newsletter: { opted_out: true, state: 'opted_out', occurred_at: AT, source: 'one_click', label: 'Newsletter <b>', active: true, consent_model: 'opt_out' },
        marketing: { opted_out: true, state: 'opted_out', occurred_at: AT, source: 'unsub_page' },
      } } },
    ],
  };
  const HISTORY = { status: 'success', channel: 'sms', destination: PAT, events: [
    { id: 2, scope: 'all', action: 'opt_out', source: 'staff', occurred_at: AT, actor_user_id: 6, actor: 'Fred', contact_id: 5, evidence: { note: 'asked <script>' } },
    { id: 1, scope: 'all', action: 'opt_out', source: 'sms_keyword', occurred_at: '2026-10-29T08:00:00.000Z', actor_user_id: null, actor: null, contact_id: 5, evidence: { keyword: 'STOP' } },
  ] };

  async function boot({ lists = LISTS, history = HISTORY } = {}) {
    const calls = [];
    const swal = [];
    const apiSend = async (url, method, body) => {
      calls.push({ url, method, body: body && JSON.parse(JSON.stringify(body)) });
      if (method === 'PATCH' && url.startsWith('/api/contacts/5')) return { status: 'success', data: {} };
      if (url === '/api/contacts/5/phones') return { status: 'success', phones: lists.phones };
      if (url === '/api/contacts/5/emails') return { status: 'success', emails: lists.emails };
      if (url.startsWith('/api/consent/history')) return history;
      if (url.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
      if (url === '/api/field-defs') return { status: 'success', defs: [] };
      if (url === '/api/contact-role-types') return { status: 'success', role_types: [] };
      if (url === '/api/contacts/5/roles') return { status: 'success', roles: [] };
      return { status: 'success' };
    };
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/forms/contact-form.html'), 'utf8'), {
      url: 'https://app.4lsg.com/forms/contact-form.html?contact_id=5',
      runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true,
      beforeParse(w) {
        w.apiSend = apiSend;
        w.entityData = { contact: contactRow() };
        w.firmData = { settings: {}, users: [], firmTimezone: 'America/Detroit' };
        w.Swal = { mixin: () => ({ fire: () => {} }), stopTimer() {}, resumeTimer() {}, getHtmlContainer: () => null,
          fire: async (o) => { swal.push(o); return { isConfirmed: true }; } };
        if (!w.CSS) w.CSS = {};
        if (!w.CSS.escape) w.CSS.escape = (v) => String(v);
      },
    });
    DOMS.push(dom);
    const w = dom.window;
    for (let i = 0; i < 300 && !(w.ycForm && w.ycForm._original && w.ycForm._original.phones); i++) await sleep(10);
    if (!w.ycForm) throw new Error('contact-form: YCForm never booted');
    for (let i = 0; i < 100 && !w.document.querySelector('.ycp-consent.ycp-show') && lists === LISTS; i++) await sleep(10);
    await sleep(20);
    return { w, calls, swal, patches: () => calls.filter((c) => c.method === 'PATCH').map((c) => c.body) };
  }
  const item = (w, kind, i) => w.document.querySelectorAll(`#${kind}Repeater .yc-repeater-item`)[i];
  const chips = (el) => [...el.querySelectorAll('.ycp-consent .ycr-badge')].map((c) => c.textContent);

  test('badges per scope from consent.scopes (cache scope first, labels as text); nothing for a destination with no state row', async () => {
    const { w, calls } = await boot();
    expect(calls.filter((c) => c.url === '/api/contacts/5/phones' || c.url === '/api/contacts/5/emails').length).toBeGreaterThanOrEqual(2);
    const p11 = item(w, 'phones', 0);
    expect(chips(p11)).toEqual(['SMS: stopped']);
    expect(p11.querySelector('.ycp-consent').classList.contains('ycp-show')).toBe(true);
    expect(p11.querySelector('.ycp-consent-history').textContent).toBe('history');
    const p12 = item(w, 'phones', 1);
    expect(p12.querySelector('.ycp-consent').classList.contains('ycp-show')).toBe(false);
    expect(p12.querySelector('.ycp-consent').children).toHaveLength(0);
    const e21 = item(w, 'emails', 0);
    expect(chips(e21)).toEqual(['No marketing email', 'Newsletter <b>: off']);
    expect(e21.querySelector('.ycp-consent').innerHTML).not.toContain('<b>');
    // No history request until a click.
    expect(calls.some((c) => c.url.startsWith('/api/consent/history'))).toBe(false);
  });

  test('an empty scopes map (and a list read that fails) shows no strip at all', async () => {
    const lists = { phones: LISTS.phones.map((r) => ({ ...r, consent: { opted_out: false, version: '0', scopes: {} } })),
      emails: LISTS.emails.map((r) => ({ ...r, consent: { opted_out: false, version: '0', scopes: {} } })) };
    const { w } = await boot({ lists });
    expect(w.document.querySelectorAll('.ycp-consent.ycp-show')).toHaveLength(0);
    expect(w.document.querySelectorAll('.ycp-consent .ycr-badge')).toHaveLength(0);
  });

  test('history: fetched on click with channel + destination; rendered escaped, firm-local, with an export control', async () => {
    const { w, calls, swal } = await boot();
    item(w, 'phones', 0).querySelector('.ycp-consent-history').click();
    for (let i = 0; i < 50 && !swal.length; i++) await sleep(10);
    const h = calls.filter((c) => c.url.startsWith('/api/consent/history'));
    expect(h).toHaveLength(1);
    expect(Object.fromEntries(new URL(h[0].url, 'https://x').searchParams)).toEqual({ channel: 'sms', destination: PAT });
    expect(swal[0].title).toBe('Consent history — (313) 555-0001');
    expect(swal[0].html).toContain('<table class="ycp-hist-table">');
    expect(swal[0].html).toContain('asked &lt;script&gt;');
    expect(swal[0].html).not.toContain('<script>');
    expect(swal[0].html).toContain('Oct 30, 2026, 8:00 AM');   // 12:00Z in America/Detroit (EDT)
    expect(swal[0].html).toMatch(/<td>Fred<\/td>/);
    expect(swal[0].html).toContain('Text keyword');
    expect(swal[0].html).toContain('class="ycp-consent-export"');
    expect(swal[0].html).not.toContain('Showing the latest');   // 2 rows: the whole history
  });

  test('history: a full page (50 rows, the route default) says it shows the latest 50 and points at the CSV', async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ id: 60 - i, scope: 'all', action: i % 2 ? 'opt_in' : 'opt_out', source: 'staff',
      occurred_at: AT, actor_user_id: 6, actor: 'Fred', contact_id: 5, evidence: {} }));
    const { w, swal } = await boot({ history: { status: 'success', events } });
    item(w, 'phones', 0).querySelector('.ycp-consent-history').click();
    for (let i = 0; i < 50 && !swal.length; i++) await sleep(10);
    expect(swal[0].html).toContain('<p class="ycp-consent-hist-more">Showing the latest 50 — export the CSV for all of them.</p>');
  });

  test('the note: revealed when a loaded row\'s opt-out changes; sent as *_optout_note for THAT row only', async () => {
    const { w, patches } = await boot();
    w.ycForm.setReadonly(false);
    const p11 = item(w, 'phones', 0);
    const p12 = item(w, 'phones', 1);
    const cb = p11.querySelector('[name="sms_optout"]');
    cb.checked = false;                                             // un-tick: an opt-in decision
    cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    expect(p11.querySelector('.ycp-consent-note').classList.contains('ycp-show')).toBe(true);
    expect(p12.querySelector('.ycp-consent-note').classList.contains('ycp-show')).toBe(false);
    p11.querySelector('.ycp-consent-note-input').value = '  client called to resume texts  ';
    // A note typed into an UNCHANGED row (forced — its box is hidden) is never sent.
    p12.querySelector('.ycp-consent-note-input').value = 'stray';
    // An unchanged email flag with a note (the row rides the save via a label edit): not sent either.
    item(w, 'emails', 0).querySelector('.ycp-consent-note-input').value = 'stray too';
    const el = item(w, 'emails', 0).querySelector('[name="label"]');
    el.value = 'Work'; el.dispatchEvent(new w.Event('change', { bubbles: true }));
    await w.ycForm.save();
    const [body] = patches();
    expect(body.phones.find((r) => r.id === '11')).toMatchObject({ sms_optout: false, sms_optout_base: 1, sms_optout_note: 'client called to resume texts' });
    expect('sms_optout_note' in body.phones.find((r) => r.id === '12')).toBe(false);
    expect(body.emails[0]).toMatchObject({ id: '21', label: 'Work', email_optout_base: 1 });
    expect('email_optout_note' in body.emails[0]).toBe(false);
  });

  test('toggling back to the loaded value hides the note again and sends nothing', async () => {
    const { w, patches } = await boot();
    w.ycForm.setReadonly(false);
    const p12 = item(w, 'phones', 1);
    const cb = p12.querySelector('[name="sms_optout"]');
    cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    expect(p12.querySelector('.ycp-consent-note').classList.contains('ycp-show')).toBe(true);
    p12.querySelector('.ycp-consent-note-input').value = 'changed my mind';
    cb.checked = false; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    expect(p12.querySelector('.ycp-consent-note').classList.contains('ycp-show')).toBe(false);
    const label = p12.querySelector('[name="label"]');
    label.value = 'Home'; label.dispatchEvent(new w.Event('change', { bubbles: true }));
    await w.ycForm.save();
    const [body] = patches();
    expect(body.phones.find((r) => r.id === '12')).toMatchObject({ label: 'Home', sms_optout: false });
    expect(body.phones.some((r) => 'sms_optout_note' in r)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('campaign.html consent skip line', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'public/campaign.html'), 'utf8');

  function boot(answer) {
    const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
    DOMS.push(dom);
    const w = dom.window;
    const calls = [];
    const parent = { apiSend: async (url, method, body) => { calls.push({ url, method, body }); return answer(body); },
      Swal: { mixin: () => ({ fire() {} }), fire: async () => ({}) } };
    Object.defineProperty(w, 'parent', { value: parent, configurable: true });
    w.Quill = function () { return { on() {}, root: { innerHTML: '' } }; };
    w.Quill.import = () => class { static create() { return {}; } static value() { return {}; } };
    w.Quill.register = () => {};
    w.Swal = { mixin: () => ({ fire() {} }) };
    const m = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
    const body = m[1].replace(/\(function waitForParent\(\)[\s\S]*$/, '');
    w.eval(`${body}\n;window.__t = { renderContacts, updateSelectedCount, runConsentPreview, consentSkipText, clearFilters };`);
    return { w, calls };
  }
  const contacts = [{ contact_id: 1, contact_name: 'Pat' }, { contact_id: 2, contact_name: 'Sam' }, { contact_id: 3, contact_name: 'Ann' }];

  test('after the selection changes it posts the checked ids + channel, and shows the server\'s skipped count', async () => {
    const { w, calls } = boot(() => ({ status: 'success', skipped_optout: 2 }));
    w.document.getElementById('f-channel').value = 'sms';
    w.__t.renderContacts({ contacts, total: 3, excluded: 0 });
    await sleep(500);                                                          // the 400 ms debounce
    const pv = calls.filter((c) => c.url === '/api/consent/preview');
    expect(pv).toHaveLength(1);
    expect(pv[0]).toMatchObject({ method: 'POST', body: { channel: 'sms', contact_ids: [1, 2, 3] } });
    expect(w.document.getElementById('consent-skip').textContent).toBe('2 will be skipped (texts stopped)');
    w.document.querySelector('.contact-cb[data-id="2"]').checked = false;
    w.__t.updateSelectedCount();
    await sleep(500);
    expect(calls.filter((c) => c.url === '/api/consent/preview').pop().body.contact_ids).toEqual([1, 3]);
    w.__t.clearFilters();
    expect(w.document.getElementById('consent-skip').textContent).toBe('');
  });

  test('email wording; zero and a failed read show nothing', async () => {
    const { w } = boot(() => ({ status: 'success', skipped_optout: 0 }));
    expect(w.__t.consentSkipText('email', 3)).toBe('3 will be skipped (opted out of marketing email)');
    expect(w.__t.consentSkipText('sms', 0)).toBe('');
    w.__t.renderContacts({ contacts, total: 3, excluded: 0 });
    await w.__t.runConsentPreview();
    expect(w.document.getElementById('consent-skip').textContent).toBe('');
    const f = boot(() => { throw new Error('down'); });
    f.w.__t.renderContacts({ contacts, total: 3, excluded: 0 });
    await f.w.__t.runConsentPreview();
    expect(f.w.document.getElementById('consent-skip').textContent).toBe('');
  });
});
