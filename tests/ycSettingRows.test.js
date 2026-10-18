// tests/ycSettingRows.test.js
//
/**
 * public/js/ycSettingRows.js — the settings ROWS renderer of the Config
 * sub-pages (settings / config-split arc, 2026-10) — run for real in jsdom
 * against an in-memory apiSend that speaks the arc's settings API contract
 * (tests/helpers/settingsApiFake.js: GET / PUT / POST / history / restore,
 * metadata and validation from the REAL lib/settingsRegistry.js).
 *
 * Locks: every control type round-trips a value verbatim (leading / trailing
 * spaces intact; an untouched control hands back the stored string byte for
 * byte); dirty tracking; save sends only the dirty keys, in display order; a
 * refused PUT keeps its row dirty with the server's sentence; read-only rows
 * (can_edit false; edit 'console'); the exists:false and env hints; the
 * keep-current rule of the user / user_csv / enum / credential / sequence
 * pickers; json_array list editing; History + restore; DB text is never markup.
 *
 * Run:  npx jest tests/ycSettingRows.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const reg = require('../lib/settingsRegistry');
const { makeSettingsApi } = require('./helpers/settingsApiFake');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/ycSettingRows.js'), 'utf8');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const USERS = [
  { user: 0, user_name: 'Automations', user_type: 0, active: true },
  { user: 1, user_name: 'Stuart', user_type: 1, active: true },
  { user: 3, user_name: 'Rivka', user_type: 1, active: true },
  { user: 5, user_name: 'Rena', user_type: 1, active: true },
  { user: 9, user_name: 'Former', user_type: 1, active: false },
];

// One stored value per control type, most of them with load-bearing spaces.
const VALUES = {
  firm_name: '  Acme Law  ',                                                 // string
  'fe-firm_logo_url': ' https://acme.example/logo.png ',                     // url
  'fe-firm_phone': ' 313 555 1212 ',                                         // phone
  firm_email: ' office@acme.example ',                                       // email
  firm_address: '["123 Main St.",  "Detroit, MI 48201"]',                    // json_array (not JSON.stringify's spacing)
  email_domains: ' @acme.example, @acme.law ',                               // csv
  office_alerts_to: ' 1, 9 ',                                                // user_csv: an active and an inactive user
  billing_tasks_to: '9',                                                     // user: inactive
  default_task_assignee: '77',                                               // user: not in the staff list
  manage_cutoff_min: ' 120 ',                                                // number
  manage_cancel_template: '  Hi {{first}},\n  your visit is canceled.  ',    // template
  manage_fallback_url: ' {"url": "https://a.example", "button_text": "Book"} ', // json
  manage_allow_cancel: ' 1',                                                 // bool
  esign_reminder_seq_id: '5',                                                // sequence: inactive
  min_client_build: ' 2026-07-12 ',                                          // date (system)
  alert_email_min_severity: ' warn',                                         // enum: not exactly an option
  dropbox_credential_id: '3',                                                // credential
  esign_credential_id: '99',                                                 // credential: not in the list
};

function page() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>',
    { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true });
  dom.window.eval(SRC);
  return dom.window;
}

/** A view over the fake server's GET rows (or `rows`), in a fresh page. */
async function mount({ home = 'firm,system', values = VALUES, variables = [], caps = { firm: true, system: true }, user, rows,
  wrapApi, users = USERS, required, ...opts } = {}) {
  const fake = makeSettingsApi({ values, variables, caps, user, required });
  const w = page();
  const api = wrapApi ? wrapApi(fake.api) : fake.api;
  const got = await fake.api(`/api/app-settings?home=${home}`);
  fake.st.calls.length = 0;
  let dirtyCalls = 0;
  const view = w.ycSettingRows.create({ container: w.document.getElementById('host'), rows: rows || got.settings, api, users,
    onDirty: () => { dirtyCalls++; }, ...opts });
  await view.ready;
  await flush();
  const d = w.document;
  const row = (k) => d.querySelector(`.ycsr-row[data-key="${k}"]`);
  const ctl = (k, sel = 'input[type=text], textarea, select') => row(k).querySelector(`.ycsr-main ${sel}`);
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const type = (el, v) => { el.value = v; fire(el, el.tagName === 'SELECT' ? 'change' : 'input'); };
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const status = (k) => row(k).querySelector('.ycsr-status').textContent;
  const puts = () => fake.st.calls.filter((c) => c.method === 'PUT');
  return { fake, w, d, view, row, ctl, fire, type, click, status, puts, dirtyCalls: () => dirtyCalls, served: got.settings };
}

// ─────────────────────────────────────────────────────────────────────────
describe('controls: one per type, values verbatim', () => {
  test('the stored value is in each control exactly; untouched, every row reports it byte for byte and nothing is dirty', async () => {
    const t = await mount();
    for (const k of ['firm_name', 'fe-firm_logo_url', 'fe-firm_phone', 'firm_email', 'email_domains', 'manage_cutoff_min', 'min_client_build']) {
      const el = t.ctl(k);
      expect([k, el.tagName, el.type, el.value]).toEqual([k, 'INPUT', 'text', VALUES[k]]);
    }
    for (const k of ['manage_cancel_template', 'manage_fallback_url']) expect([k, t.ctl(k).tagName, t.ctl(k).value]).toEqual([k, 'TEXTAREA', VALUES[k]]);
    for (const k of Object.keys(VALUES)) expect([k, t.view.value(k)]).toEqual([k, VALUES[k]]);
    expect(t.view.isDirty()).toBe(false);
    expect(t.view.dirtyKeys()).toEqual([]);
    // monospace where settings.html had it; never for a plain string / email
    expect(['fe-firm_logo_url', 'fe-firm_phone', 'email_domains', 'manage_cutoff_min', 'min_client_build'].every((k) => t.ctl(k).classList.contains('ycsr-mono'))).toBe(true);
    expect([t.ctl('firm_name').classList.contains('ycsr-mono'), t.ctl('firm_email').classList.contains('ycsr-mono')]).toEqual([false, false]);
    // the whitespace badge (settings.html wsHint)
    expect(t.row('firm_name').querySelector('.ycsr-ws').textContent).toBe('⚠ 2 leading spaces, 2 trailing spaces — preserved on save');
    expect(t.row('fe-firm_logo_url').querySelector('.ycsr-ws').textContent).toBe('⚠ 1 leading space, 1 trailing space — preserved on save');
  });

  test('text and textarea types: an edit with leading / trailing spaces is sent, stored and redrawn exactly', async () => {
    const t = await mount();
    const next = {
      firm_name: '   Acme  Law   ', 'fe-firm_logo_url': '  https://acme.example/new.png', 'fe-firm_phone': '313 555 9999  ',
      firm_email: '  billing@acme.example', email_domains: '@acme.example,  @acme.law ', manage_cutoff_min: ' 90',
      manage_cancel_template: ' Line one  \n\n  line three ', manage_fallback_url: '\n{"url":"https://b.example"}\n',
      min_client_build: '2026-08-01  ',
    };
    for (const [k, v] of Object.entries(next)) t.type(t.ctl(k), v);
    expect(t.view.isDirty()).toBe(true);
    const order = t.served.map((r) => r.key).filter((k) => k in next);
    expect(t.view.dirtyKeys()).toEqual(order);
    const r = await t.view.save();
    expect(r).toEqual({ ok: true, saved: order, failed: [], errors: {} });
    expect(t.puts().map((c) => [decodeURIComponent(c.endpoint.split('/').pop()), c.payload])).toEqual(order.map((k) => [k, { value: next[k] }]));
    for (const k of order) {
      expect([k, t.fake.value(k)]).toEqual([k, next[k]]);
      expect([k, t.ctl(k).value, t.view.value(k), t.status(k)]).toEqual([k, next[k], next[k], 'Saved']);
    }
    expect(t.view.isDirty()).toBe(false);
  });

  test('a stored value with a line break gets a textarea, never an input (an input drops line breaks)', async () => {
    const t = await mount({ home: 'firm', variables: [{ key: 'two_lines', value: 'first\nsecond ', type: 'string' }, { key: 'odd', value: ' x ', type: 'text' }] });
    expect([t.ctl('two_lines').tagName, t.ctl('two_lines').value, t.view.value('two_lines')]).toEqual(['TEXTAREA', 'first\nsecond ', 'first\nsecond ']);
    // a type a migration wrote that the vocabulary does not know: a verbatim text input
    expect([t.ctl('odd').tagName, t.ctl('odd').value]).toEqual(['INPUT', ' x ']);
    expect(t.view.isDirty()).toBe(false);
  });

  test('bool: a checkbox → "1" / "0"; back where it started is the stored string again (not dirty)', async () => {
    const t = await mount();
    const cb = t.row('manage_allow_cancel').querySelector('input[type=checkbox]');
    const txt = () => t.row('manage_allow_cancel').querySelector('.ycsr-toggle-txt').textContent;
    expect([cb.checked, txt(), t.view.value('manage_allow_cancel')]).toEqual([true, 'On (1)', ' 1']);
    cb.checked = false; t.fire(cb, 'change');
    expect([t.view.value('manage_allow_cancel'), txt(), t.view.dirtyKeys()]).toEqual(['0', 'Off (0)', ['manage_allow_cancel']]);
    cb.checked = true; t.fire(cb, 'change');
    expect([t.view.value('manage_allow_cancel'), t.view.isDirty()]).toEqual([' 1', false]);
    // unset: unchecked, "Not set"; ticking it writes '1'
    const cb2 = t.row('manage_allow_reschedule').querySelector('input[type=checkbox]');
    expect([cb2.checked, t.row('manage_allow_reschedule').querySelector('.ycsr-toggle-txt').textContent]).toEqual([false, 'Not set']);
    cb2.checked = true; t.fire(cb2, 'change');
    await t.view.save();
    expect(t.puts().map((c) => c.payload)).toEqual([{ value: '1' }]);
    expect(t.fake.value('manage_allow_reschedule')).toBe('1');
  });

  test('enum: blank + the options; a stored value that is not exactly an option stays selected; blank saves ""', async () => {
    const t = await mount();
    const sel = t.ctl('alert_email_min_severity');
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', '— not set —'], [' warn', '“ warn” (as stored)'], ['error', 'error'], ['warn', 'warn'], ['info', 'info']]);
    expect(sel.value).toBe(' warn');
    t.type(sel, 'error');
    expect(t.view.value('alert_email_min_severity')).toBe('error');
    t.type(sel, '');
    expect(t.view.dirtyKeys()).toEqual(['alert_email_min_severity']);
    await t.view.save();
    expect(t.puts().map((c) => c.payload)).toEqual([{ value: '' }]);
    expect(t.fake.value('alert_email_min_severity')).toBe('');
    expect(t.ctl('alert_email_min_severity').value).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('pickers: active staff offered, the current value kept (D3b)', () => {
  test('user: active staff only (no user 0, no inactive); an inactive or unknown stored id stays selected and labelled', async () => {
    const t = await mount();
    const opts = (k) => [...t.ctl(k).options].map((o) => [o.value, o.textContent]);
    expect(opts('billing_tasks_to')).toEqual([['', '— none —'], ['9', 'Former (inactive)'], ['1', 'Stuart'], ['3', 'Rivka'], ['5', 'Rena']]);
    expect(t.ctl('billing_tasks_to').value).toBe('9');
    expect(opts('default_task_assignee')[1]).toEqual(['77', 'user #77 (not in the staff list)']);
    expect([t.view.value('billing_tasks_to'), t.view.value('default_task_assignee'), t.view.isDirty()]).toEqual(['9', '77', false]);
    t.type(t.ctl('billing_tasks_to'), '3');
    await t.view.save();
    expect(t.puts().map((c) => [c.endpoint, c.payload])).toEqual([['/api/app-settings/billing_tasks_to', { value: '3' }]]);
    // redrawn: the inactive user is no longer offered
    expect(opts('billing_tasks_to')).toEqual([['', '— none —'], ['1', 'Stuart'], ['3', 'Rivka'], ['5', 'Rena']]);
  });

  test('user_csv: chips (an inactive one labelled), add from active staff not already there, remove; untouched = stored verbatim', async () => {
    const t = await mount();
    const chips = () => [...t.row('office_alerts_to').querySelectorAll('.ycsr-chip')].map((c) => c.firstChild.textContent);
    const add = () => t.row('office_alerts_to').querySelector('select.ycsr-add');
    expect(chips()).toEqual(['Stuart', 'Former (inactive)']);
    expect([...add().options].map((o) => o.value)).toEqual(['', '3', '5']);
    expect(t.view.value('office_alerts_to')).toBe(' 1, 9 ');
    t.click(t.row('office_alerts_to').querySelectorAll('[data-ycsr-rm]')[1]);          // remove Former
    expect([chips(), t.view.value('office_alerts_to')]).toEqual([['Stuart'], '1']);
    t.type(add(), '5');
    expect([chips(), t.view.value('office_alerts_to')]).toEqual([['Stuart', 'Rena'], '1,5']);
    t.click(t.row('office_alerts_to').querySelectorAll('[data-ycsr-rm]')[1]);          // remove Rena
    t.type(add(), '9');                                                                // not offered: inactive
    expect([...add().options].map((o) => o.value)).toEqual(['', '3', '5']);
    expect(t.view.value('office_alerts_to')).toBe('1');
    await t.view.save();
    expect(t.fake.value('office_alerts_to')).toBe('1');
    // a value that is not a list of ids: free text, verbatim
    const t2 = await mount({ values: { ...VALUES, office_alerts_to: 'ops@acme.example' } });
    expect([t2.ctl('office_alerts_to').tagName, t2.ctl('office_alerts_to').value, t2.view.isDirty()]).toEqual(['INPUT', 'ops@acme.example', false]);
  });

  test('sequence / credential: a select from the list GET (one per list); inactive / unknown kept; a list that cannot load → an id input', async () => {
    const t = await mount();
    const opts = (k) => [...t.ctl(k).options].map((o) => [o.value, o.textContent]);
    expect(opts('esign_reminder_seq_id')).toEqual([['', '— none —'], ['5', 'Old reminders (#5, esign) (inactive)'],
      ['4', 'E-sign reminders (#4, esign)'], ['6', 'Intake follow-up (#6, lead)']]);
    expect(opts('esign_credential_id')[1]).toEqual(['99', '#99 (not found)']);
    expect(t.ctl('dropbox_credential_id').value).toBe('3');
    expect(t.view.isDirty()).toBe(false);
    t.type(t.ctl('dropbox_credential_id'), '7');
    t.type(t.ctl('esign_reminder_seq_id'), '4');
    expect(t.view.dirtyKeys()).toEqual(['esign_reminder_seq_id', 'dropbox_credential_id']);
    // one GET per list, though two rows read the credentials list; a list that fails → an id input
    const fakeCalls = [];
    const t3 = await mount({ wrapApi: (api) => (p, m, b) => { fakeCalls.push(p); return /^\/sequences/.test(p) ? Promise.reject(Object.assign(new Error('down'), { status: 500 })) : api(p, m, b); } });
    expect(fakeCalls.filter((p) => p === '/api/credentials')).toHaveLength(1);
    expect(fakeCalls.filter((p) => p === '/sequences/templates')).toHaveLength(1);
    const inp = t3.ctl('esign_reminder_seq_id');
    expect([inp.tagName, inp.value]).toEqual(['INPUT', '5']);
    expect(t3.row('esign_reminder_seq_id').textContent).toMatch(/list could not be loaded — enter the sequence template id/);
    t3.type(inp, '6');
    expect(t3.view.value('esign_reminder_seq_id')).toBe('6');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('json_array: a list editor', () => {
  test('entries edited verbatim, added, reordered, removed; back to the original list = the stored string; an empty entry blocks its save', async () => {
    const t = await mount();
    const box = () => t.row('firm_address');
    const entries = () => [...box().querySelectorAll('[data-ycsr-entry]')].map((i) => i.value);
    const btn = (act, i) => box().querySelector(`[data-ycsr-li="${act}"]${i == null ? '' : `[data-i="${i}"]`}`);
    expect(entries()).toEqual(['123 Main St.', 'Detroit, MI 48201']);
    expect(t.view.value('firm_address')).toBe(VALUES.firm_address);
    t.type(box().querySelector('[data-ycsr-entry="0"]'), '  123 Main St., #100');
    expect(t.view.value('firm_address')).toBe('["  123 Main St., #100","Detroit, MI 48201"]');
    expect(box().querySelector('.ycsr-li .ycsr-ws').textContent).toBe('⚠ 2 leading spaces — preserved on save');
    t.click(btn('add'));
    expect(entries()).toEqual(['  123 Main St., #100', 'Detroit, MI 48201', '']);
    expect(t.w.document.activeElement).toBe(box().querySelector('[data-ycsr-entry="2"]'));
    const r = await t.view.save();                                           // the empty entry: no PUT, the reason on the row
    expect([r.ok, r.failed, t.puts().length, t.status('firm_address')]).toEqual([false, ['firm_address'], 0, 'An entry is empty — fill it in or remove it.']);
    t.type(box().querySelector('[data-ycsr-entry="2"]'), 'USA');
    t.click(btn('up', 2));
    expect(entries()).toEqual(['  123 Main St., #100', 'USA', 'Detroit, MI 48201']);
    t.click(btn('down', 0));
    expect(entries()).toEqual(['USA', '  123 Main St., #100', 'Detroit, MI 48201']);
    expect(btn('up', 0).disabled).toBe(true);
    // undo it all → clean, the stored string again
    t.click(btn('del', 0));
    t.type(box().querySelector('[data-ycsr-entry="0"]'), '123 Main St.');
    expect([t.view.value('firm_address'), t.view.isDirty()]).toEqual([VALUES.firm_address, false]);
    t.click(btn('del', 1));
    await t.view.save();
    expect(t.puts().map((c) => c.payload)).toEqual([{ value: '["123 Main St."]' }]);
    expect(entries()).toEqual(['123 Main St.']);
  });

  test('blank stays blank until an entry is added; a value that is not a list of strings gets a textarea', async () => {
    const t = await mount({ values: { ...VALUES, firm_address: '' } });
    expect(t.row('firm_address').querySelector('.ycsr-none').textContent).toBe('No entries.');
    t.click(t.row('firm_address').querySelector('[data-ycsr-li="add"]'));
    t.type(t.row('firm_address').querySelector('[data-ycsr-entry="0"]'), 'One');
    expect(t.view.value('firm_address')).toBe('["One"]');
    t.click(t.row('firm_address').querySelector('[data-ycsr-li="del"]'));
    expect([t.view.value('firm_address'), t.view.isDirty()]).toEqual(['', false]);
    const t2 = await mount({ values: { ...VALUES, firm_address: '[1, "two"]' } });
    expect([t2.ctl('firm_address').tagName, t2.ctl('firm_address').value, t2.view.isDirty()]).toEqual(['TEXTAREA', '[1, "two"]', false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('dirty tracking and save', () => {
  test('an edit and its revert: dirty, then clean; onDirty is told; the row is marked', async () => {
    const t = await mount();
    const n = t.dirtyCalls();
    t.type(t.ctl('firm_name'), 'Other');
    expect([t.view.isDirty(), t.row('firm_name').classList.contains('is-dirty'), t.dirtyCalls() > n]).toEqual([true, true, true]);
    t.type(t.ctl('firm_name'), VALUES.firm_name);
    expect([t.view.isDirty(), t.row('firm_name').classList.contains('is-dirty')]).toEqual([false, false]);
    const r = await t.view.save();
    expect([r, t.puts()]).toEqual([{ ok: true, saved: [], failed: [], errors: {} }, []]);
  });

  test('a refused PUT keeps its row dirty with the server\'s sentence; the other rows still save', async () => {
    const t = await mount();
    t.type(t.ctl('firm_name'), 'Acme');
    t.type(t.ctl('firm_email'), 'nope');
    t.type(t.ctl('manage_cutoff_min'), '15');
    const r = await t.view.save();
    expect(r).toEqual({ ok: false, saved: ['firm_name', 'manage_cutoff_min'], failed: ['firm_email'],
      errors: { firm_email: { status: 400, message: 'must be a valid email address' } } });
    expect(t.puts().map((c) => c.endpoint)).toEqual(['/api/app-settings/firm_name', '/api/app-settings/firm_email', '/api/app-settings/manage_cutoff_min']);
    expect([t.status('firm_email'), t.row('firm_email').querySelector('.ycsr-status').className]).toEqual(['must be a valid email address', 'ycsr-status err']);
    expect([t.view.dirtyKeys(), t.ctl('firm_email').value, t.fake.value('firm_email')]).toEqual([['firm_email'], 'nope', VALUES.firm_email]);
    // editing the row clears its message
    t.type(t.ctl('firm_email'), 'ok@acme.example');
    expect(t.status('firm_email')).toBe('');
  });

  test('a 403 is the server\'s sentence too (a role revoked since load)', async () => {
    const t = await mount();
    t.type(t.ctl('firm_name'), 'Acme');
    t.fake.st.caps.firm = false;
    const r = await t.view.save();
    expect(r.errors).toEqual({ firm_name: { status: 403, message: 'Changing Firm name needs the firm.settings permission' } });
    expect(t.status('firm_name')).toBe('Changing Firm name needs the firm.settings permission');
    expect(t.view.isDirty()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('hints and read-only rows', () => {
  test('exists:false → "Not set — the code\'s default applies" (gone once saved); env → the fallback sentence; the description and key', async () => {
    const t = await mount();
    const site = t.row('fe-firm_site_url');
    expect(site.querySelector('.ycsr-unset').textContent).toBe('Not set — the code\'s default applies.');
    expect(site.querySelector('.ycsr-env').textContent).toBe('Blank falls back to the FIRM_URL environment variable.');
    expect(site.querySelector('.ycsr-key').textContent).toBe('fe-firm_site_url');
    expect(site.querySelector('.yc-flabel').textContent).toBe(reg.get('fe-firm_site_url').label);
    expect(site.querySelector('.ycsr-desc').textContent).toBe(reg.get('fe-firm_site_url').desc);
    expect(site.querySelector('label.yc-flabel').htmlFor).toBe(t.ctl('fe-firm_site_url').id);
    expect(t.row('firm_name').querySelector('.ycsr-unset')).toBeNull();
    expect(t.row('firm_name').querySelector('.ycsr-env')).toBeNull();
    expect(t.row('firm_name').querySelector('.ycsr-updated').textContent).toMatch(/^Updated Oct 17, 2026/);
    t.type(t.ctl('fe-firm_site_url'), 'https://acme.example');
    await t.view.save();
    expect(t.row('fe-firm_site_url').querySelector('.ycsr-unset')).toBeNull();
    expect(t.view.rows().find((r) => r.key === 'fe-firm_site_url')).toMatchObject({ exists: true, value: 'https://acme.example' });
  });

  test('can_edit false: the value as text, no control, no History; edit "console" says the SU db console', async () => {
    const t = await mount({ caps: { firm: false, system: true } });
    const ro = t.row('firm_name');
    expect(ro.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    expect([ro.querySelector('.ycsr-ro').textContent, ro.querySelector('.ycsr-ws').textContent]).toEqual(['  Acme Law  ', '⚠ 2 leading spaces, 2 trailing spaces — preserved on save']);
    expect(ro.querySelector('.ycsr-posture').textContent).toBe('Read-only — you can see it here but not change it.');
    expect(t.row('manage_allow_cancel').querySelector('.ycsr-ro').textContent).toBe('On (1)');
    expect(t.row('office_alerts_to').querySelector('.ycsr-ro').textContent).toBe('Stuart, Former (inactive)');
    expect(t.row('fe-firm_site_url').querySelector('.ycsr-ro').textContent).toBe('(blank)');
    // the system home's console rows (can_edit false even for system.settings holders)
    const app = t.row('app_url');
    expect(app.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    expect(app.querySelector('.ycsr-posture').textContent).toBe('Changed from the SU db console only.');
    expect(t.row('alert_cooldown_hours').querySelector('[data-ycsr="history"]')).not.toBeNull();   // an editable system row
    expect(t.view.isDirty()).toBe(false);
    expect((await t.view.save()).saved).toEqual([]);
    expect(t.fake.st.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  test('a row whose editor the page did not pass is read-only (never edited blind); an editor returning null falls back to the type\'s control', async () => {
    const t = await mount({ home: 'config', values: { 'fe-case_types': '{"BK":["7"]}', 'fe-lead_sources': '["Web"]' } });
    const ct = t.row('fe-case_types');
    expect(ct.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(ct.querySelector('.ycsr-posture').textContent).toBe('This setting has its own editor; it is not changed here.');
    const seen = [];
    const t2 = await mount({ home: 'config', values: { 'fe-case_types': '{"BK":["7"]}' }, editors: { caseTypes: (row, ctx) => { seen.push([row.key, typeof ctx.changed]); return null; } } });
    expect(seen).toEqual([['fe-case_types', 'function']]);
    expect([t2.ctl('fe-case_types').tagName, t2.ctl('fe-case_types').value]).toEqual(['TEXTAREA', '{"BK":["7"]}']);
  });

  test('an empty list shows the page\'s empty text; addRow draws a row and drops it', async () => {
    const t = await mount({ rows: [], empty: 'No automation variables yet.' });
    expect(t.d.querySelector('.ycsr-empty').textContent).toBe('No automation variables yet.');
    t.view.addRow({ key: 'v1', value: ' a ', type: 'string', label: 'V one', exists: true, registered: false, can_edit: true, edit: 'ui' });
    expect([t.d.querySelector('.ycsr-empty'), t.ctl('v1').value, t.view.isDirty()]).toEqual([null, ' a ', false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('History + restore', () => {
  test('lists the changes newest first; Restore puts back that entry\'s OLD value after a confirm; the row and the list follow', async () => {
    const t = await mount();
    t.type(t.ctl('firm_name'), 'Acme B');
    await t.view.save();
    t.type(t.ctl('firm_name'), 'Acme C');
    await t.view.save();
    t.click(t.row('firm_name').querySelector('[data-ycsr="history"]'));
    await flush();
    const vers = () => [...t.row('firm_name').querySelectorAll('.ycsr-ver')];
    expect(vers().map((v) => v.querySelector('.ycsr-ver-line').textContent.replace(/, Oct 17, 2026, [^,]+,/, ', <when>,'))).toEqual([
      'changed “Acme B” → “Acme C” by Alex, <when>, in the app',
      'changed “  Acme Law  ” → “Acme B” by Alex, <when>, in the app']);
    expect(t.fake.st.calls.filter((c) => c.method === 'GET' && /^\/api\/app-settings/.test(c.endpoint)).map((c) => c.endpoint))
      .toEqual(['/api/app-settings/firm_name/history?limit=50']);
    // a declined confirm restores nothing
    t.w.confirm = () => false;
    t.click(vers()[1].querySelector('[data-ycsr="restore"]'));
    await flush();
    expect(t.fake.st.calls.filter((c) => c.method === 'POST')).toEqual([]);
    // restore the oldest change's old value, with an unsaved edit pending (discarded)
    t.type(t.ctl('firm_name'), 'typed but not saved');
    const asked = [];
    t.w.confirm = (m) => { asked.push(m); return true; };
    t.click(vers()[1].querySelector('[data-ycsr="restore"]'));
    await flush();
    expect(asked[0]).toMatch(/^Restore this value\?\n\nFirm name goes back to “  Acme Law  ” — a new entry in History\. Your unsaved change to it is discarded\.$/);
    expect(t.fake.st.calls.filter((c) => c.method === 'POST')).toEqual([{ endpoint: '/api/app-settings/firm_name/restore', method: 'POST', payload: { version_id: 1 } }]);
    expect([t.fake.value('firm_name'), t.ctl('firm_name').value, t.view.isDirty(), t.status('firm_name')]).toEqual(['  Acme Law  ', '  Acme Law  ', false, 'Restored']);
    // the list is re-read: the restore is its newest entry; the entry whose old value is current has no button
    expect(vers()[0].querySelector('.ycsr-ver-line').textContent).toMatch(/^changed “Acme C” → “  Acme Law  ” by Alex, .*, by a restore$/);
    expect(vers()[2].querySelector('[data-ycsr="restore"]')).toBeNull();
    expect(vers()[2].querySelector('.ycsr-ver-cur').textContent).toBe('The value before this change is the current one.');
    // History closes and reopens
    t.click(t.row('firm_name').querySelector('[data-ycsr="history"]'));
    expect(t.row('firm_name').querySelector('.ycsr-hist').hidden).toBe(true);
  });

  test('a page\'s own confirm is used; a created row\'s first entry restores to blank; a refused restore shows the server\'s sentence', async () => {
    const asked = [];
    const t = await mount({ home: 'firm', variables: [], confirm: async (title, text) => { asked.push([title, text]); return true; } });
    // a version with a NULL old value (a create) restores to ''
    await t.fake.api('/api/app-settings', 'POST', { key: 'v_new', value: 'x', type: 'string' });
    t.view.addRow({ ...(await t.fake.api('/api/app-settings?home=firm')).settings.find((r) => r.key === 'v_new') });
    t.click(t.row('v_new').querySelector('[data-ycsr="history"]'));
    await flush();
    expect(t.row('v_new').querySelector('.ycsr-ver-line').textContent).toMatch(/^changed \(not set\) → “x” by Alex, .*, when it was created$/);
    t.click(t.row('v_new').querySelector('[data-ycsr="restore"]'));
    await flush();
    expect(asked).toEqual([['Restore this value?', 'v_new goes back to blank — a new entry in History.']]);
    expect([t.fake.value('v_new'), t.ctl('v_new').value]).toEqual(['', '']);
    // refused: the role was revoked meanwhile
    t.type(t.ctl('firm_name'), 'Acme B');
    await t.view.save();
    t.click(t.row('firm_name').querySelector('[data-ycsr="history"]'));
    await flush();
    t.fake.st.caps.firm = false;
    t.click(t.row('firm_name').querySelector('[data-ycsr="restore"]'));
    await flush();
    expect(t.status('firm_name')).toBe('Changing Firm name needs the firm.settings permission');
    expect(t.fake.value('firm_name')).toBe('Acme B');
    // and a History that cannot be read says why
    t.click(t.row('firm_email').querySelector('[data-ycsr="history"]'));
    await flush();
    expect(t.row('firm_email').querySelector('.ycsr-hist-msg').textContent).toBe('Changing Firm email needs the firm.settings permission');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('arc additions: duration, required, the shell\'s firmData', () => {
  const row = (key, type, value, extra = {}) => ({ key, value, type, label: key, exists: true, registered: true, can_edit: true, edit: 'ui', ...extra });

  test('duration: a single-line monospace input, verbatim; a type this file does not know: a plain single-line input, verbatim', async () => {
    const t = await mount({ rows: [row('cta_default_timeout_once', 'duration', ' 30d '), row('future_kind', 'brand_new_type', '  x  ')] });
    const d = t.ctl('cta_default_timeout_once');
    expect([d.tagName, d.type, d.value, d.classList.contains('ycsr-mono')]).toEqual(['INPUT', 'text', ' 30d ', true]);
    const u = t.ctl('future_kind');
    expect([u.tagName, u.type, u.value, u.classList.contains('ycsr-mono')]).toEqual(['INPUT', 'text', '  x  ', false]);
    expect(t.view.isDirty()).toBe(false);
    t.type(d, '12h ');
    expect(t.view.value('cta_default_timeout_once')).toBe('12h ');
  });

  test('required: a marker in the label; no blank choice in a user picker (nor in the other selects); a blank stored value → a disabled "Choose…"', async () => {
    const t = await mount({ home: 'portal', values: { portal_callback_task_to: '9', portal_email_from: 'portal@acme.example' },
      required: ['portal_callback_task_to', 'portal_email_from'] });
    for (const k of ['portal_callback_task_to', 'portal_email_from']) {
      expect([k, t.row(k).querySelector('label.yc-flabel .ycsr-req').textContent]).toEqual([k, 'required']);
    }
    expect(t.row('portal_logo_url').querySelector('.ycsr-req')).toBeNull();                 // not required
    const opts = (tt, k) => [...tt.ctl(k).options].map((o) => [o.value, o.textContent, o.disabled]);
    expect(opts(t, 'portal_callback_task_to')).toEqual([['9', 'Former (inactive)', false], ['1', 'Stuart', false], ['3', 'Rivka', false], ['5', 'Rena', false]]);
    expect([t.ctl('portal_callback_task_to').value, t.view.isDirty()]).toEqual(['9', false]);
    // stored blank (no row yet): a disabled placeholder holds the blank; nothing is dirty until a pick
    const t2 = await mount({ home: 'portal', values: {}, required: ['portal_callback_task_to'] });
    expect(opts(t2, 'portal_callback_task_to')).toEqual([['', 'Choose…', true], ['1', 'Stuart', false], ['3', 'Rivka', false], ['5', 'Rena', false]]);
    expect([t2.ctl('portal_callback_task_to').value, t2.view.isDirty()]).toEqual(['', false]);
    t2.type(t2.ctl('portal_callback_task_to'), '3');
    expect(t2.view.dirtyKeys()).toEqual(['portal_callback_task_to']);
    // an enum / sequence select of a required row has no blank either
    const t3 = await mount({ required: ['alert_email_min_severity', 'esign_reminder_seq_id'] });
    expect(opts(t3, 'alert_email_min_severity').map((o) => o[0])).toEqual([' warn', 'error', 'warn', 'info']);
    expect(opts(t3, 'esign_reminder_seq_id').map((o) => o[0])).toEqual(['5', '4', '6']);
  });

  test('a save batch or a restore that wrote an fe-* key → the shell\'s loadFirmData, once; nothing else calls it; a throwing one breaks nothing', async () => {
    const t = await mount();
    let n = 0;
    t.w.loadFirmData = () => { n++; return Promise.resolve(); };                            // the jsdom page is its own top
    t.type(t.ctl('fe-firm_phone'), '3135550000');
    t.type(t.ctl('fe-firm_site_url'), 'https://acme.example');
    t.type(t.ctl('firm_name'), 'Acme');
    await t.view.save();
    expect(n).toBe(1);
    t.type(t.ctl('firm_name'), 'Acme 2');
    await t.view.save();                                                                     // no fe-* key
    expect(n).toBe(1);
    t.type(t.ctl('fe-firm_phone'), 'not a phone');
    await t.view.save();                                                                     // refused: nothing written
    expect(n).toBe(1);
    t.type(t.ctl('fe-firm_phone'), VALUES['fe-firm_phone']);
    t.w.confirm = () => true;
    t.click(t.row('fe-firm_phone').querySelector('[data-ycsr="history"]'));
    await flush();
    t.click(t.row('fe-firm_phone').querySelector('[data-ycsr="restore"]'));                 // a restore of an fe-* key
    await flush();
    expect([n, t.fake.value('fe-firm_phone')]).toEqual([2, VALUES['fe-firm_phone']]);
    t.click(t.row('firm_name').querySelector('[data-ycsr="history"]'));
    await flush();
    t.click(t.row('firm_name').querySelector('[data-ycsr="restore"]'));                     // not fe-*
    await flush();
    expect(n).toBe(2);
    t.w.loadFirmData = () => { throw new Error('shell busy'); };
    t.type(t.ctl('fe-firm_phone'), '3135551111');
    const r = await t.view.save();
    expect([r.ok, t.fake.value('fe-firm_phone'), t.status('fe-firm_phone')]).toEqual([true, '3135551111', 'Saved']);
  });

  test('setRows while a save is out: the late answer draws no stale row back', async () => {
    let release = null;
    const t = await mount({ wrapApi: (api) => (p, m, b) => (m === 'PUT' ? new Promise((res) => { release = () => res(api(p, m, b)); }) : api(p, m, b)) });
    t.type(t.ctl('firm_name'), 'Late');
    const saving = t.view.save();
    await flush();
    t.view.setRows(t.served.filter((r) => r.key === 'firm_email'));
    release();
    await saving;
    expect([t.d.querySelectorAll('.ycsr-row').length, t.row('firm_name')]).toEqual([1, null]);
    expect(t.fake.value('firm_name')).toBe('Late');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('DB text is never markup', () => {
  test('values, a variable\'s label / description and a History name with markup create no element', async () => {
    const evil = '"><img id=xv1 src=x>';
    const t = await mount({ home: 'firm', user: { id: 2, name: '<b id=xh1>Mallory</b>' },
      values: { firm_name: evil, office_alerts_to: '1' },
      variables: [{ key: 'v_evil', value: '<i id=xv2></i>', type: 'string', label: '<img id=xl1>', description: '<u id=xd1>' }] });
    t.type(t.ctl('firm_name'), '<svg id=xv3 onload=1>');
    await t.view.save();
    t.click(t.row('firm_name').querySelector('[data-ycsr="history"]'));
    await flush();
    for (const id of ['xv1', 'xv2', 'xv3', 'xl1', 'xd1', 'xh1']) expect([id, t.d.getElementById(id)]).toEqual([id, null]);
    expect(t.ctl('v_evil').value).toBe('<i id=xv2></i>');
    expect(t.row('v_evil').querySelector('.yc-flabel').textContent).toBe('<img id=xl1>');
    expect(t.row('firm_name').querySelector('.ycsr-ver-line').textContent).toMatch(/by <b id=xh1>Mallory<\/b>,/);
    const t2 = await mount({ home: 'firm', caps: { firm: false, system: false }, values: { firm_name: evil } });
    expect([t2.d.getElementById('xv1'), t2.row('firm_name').querySelector('.ycsr-ro').textContent]).toEqual([null, evil]);
  });

  test('the module injects its styles once per document, scoped under .ycsr', async () => {
    const t = await mount();
    t.w.ycSettingRows.create({ container: t.d.body.appendChild(t.d.createElement('div')), rows: [], api: t.fake.api, users: [] });
    const css = t.d.querySelectorAll('#ycSettingRowsCss');
    expect(css).toHaveLength(1);
    const rules = css[0].textContent.split('\n').filter((l) => /^[.@]/.test(l));
    expect(rules.every((l) => l.startsWith('.ycsr') || l.startsWith('@media'))).toBe(true);
    expect(t.w.ycSettingRows.wsHint('   ')).toBe('⚠ only spaces (3) — preserved on save');
    expect(t.w.ycSettingRows.wsHint('a')).toBe('');
  });
});
