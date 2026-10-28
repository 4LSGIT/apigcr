// tests/configSystemTab.test.js
//
/**
 * Settings arc (W7) — Config → System (public/caseconfig/system.html), run for
 * REAL in jsdom: the page's own markup and whole inline script, the REAL
 * public/js/ycSettingRows.js inlined where the page loads it, and a parent
 * window playing the Config shell's part (apiSend, setTopbarButtons,
 * firmData) whose apiSend is tests/helpers/settingsApiFake.js — the settings
 * API contract, metadata / posture / validation from the REAL
 * lib/settingsRegistry.js. The gate tests run the REAL Config shell
 * (public/caseConfigManager.html) in the middle frame.
 *
 * Locks: ONE GET /api/app-settings?home=system,comms per load; the sections
 * (the system sections, comms, runtime state last) with the registry's
 * titles, every served row in its own section; console-posture rows
 * read-only with the SU-console note; the credential rows pick from ONE GET
 * /api/credentials; runtime state read-only by construction (no control),
 * JSON pretty-printed, DB text never markup; Save sends only the dirty keys,
 * in page order; a 400 verbatim on its row, the banner naming the section;
 * the session message for a 403 GET, a GET answering caps.system false, and a
 * 403 PUT; Refresh / tab-return / unload guards; the tab under the real shell
 * (revealed by can_edit_system alone, never read-only).
 *
 * Mutation-checked (see the W7 worker report).
 *
 * Run:  npx jest tests/configSystemTab.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const reg = require('../lib/settingsRegistry');
const { makeSettingsApi, apiError } = require('./helpers/settingsApiFake');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SYSTEM_HTML = read('public/caseconfig/system.html');
const CCM_HTML = read('public/caseConfigManager.html');
const ROWS_SRC = read('public/js/ycSettingRows.js');
const ROWS_TAG = '<script src="/js/ycSettingRows.js"></script>';
// The rows module inlined where the page loads it; CDN / theme tags dropped.
const strip = (html) => html.replace(ROWS_TAG, () => `<script>${ROWS_SRC}</script>`)
  .replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const SESSION_MSG = 'Your session predates a permissions change — sign out and back in.';
const USERS = [{ user: 1, user_name: 'Stuart', user_type: 1, active: true }];
const ERROR_SWEEP = '{"system_alerts":12,"email_log":{"id":40,"at":"2026-10-17"}}';
const VALUES = {
  app_url: 'https://app.acme.example', gcs_bucket: 'acme-uploads', landing_hosts: 'acme.example',
  cloud_tasks_enabled: '1', mail_send_daily_budget: '{"gmail": 1500, "smtp": 300}',
  documents_sync_enabled: '1', court_ingest_live: '0',
  alert_email_min_severity: 'error', alert_cooldown_hours: '6',
  dropbox_credential_id: '3', esign_credential_id: '7', gcal_calendar_id: 'firm@group.calendar.google.com',
  gcontacts_credential_id: '12',
  comms_archive_enabled: '1', comms_transcribe_mode: 'sample', comms_stt_credential_id: '12', comms_summary_model: 'model-x',
  error_sweep_state: ERROR_SWEEP, alert_last_sweep_at: '2026-10-17T09:00:00Z', esign_credit_alert_sent: '',
  gcontacts_group: '<b>contacts</b><img src=x onerror="window.__xss=1">', clio_login_code: '123456',
  firm_name: 'Acme Law',                             // a firm key: never served here
};

/** The page in a frame under a parent that plays the Config shell. */
async function boot({ values = VALUES, caps = { firm: false, system: true }, wrap } = {}) {
  const fake = makeSettingsApi({ values, caps });
  const vc = new VirtualConsole();
  const logs = [];
  vc.on('warn', (...a) => logs.push(a.join(' ')));
  const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: vc }).window;
  let topbar = {};
  let firmLoads = 0;
  top.apiSend = wrap ? wrap(fake.api) : fake.api;
  top.setTopbarButtons = (b) => { topbar = { ...topbar, ...b }; };
  top.firmData = { users: USERS };
  top.loadFirmData = () => { firmLoads++; return Promise.resolve(); };
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  await flush(5);
  const w = f.contentWindow;
  w.document.open(); w.document.write(strip(SYSTEM_HTML)); w.document.close();
  await flush();
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const t = {
    top, w, fake, logs, $, $$, fire,
    topbar: () => topbar,
    firmLoads: () => firmLoads,
    row: (k) => $(`.ycsr-row[data-key="${k}"]`),
    ctl: (k) => $(`.ycsr-row[data-key="${k}"] .ycsr-main`).querySelector('input, select, textarea'),
    status: (k) => $(`.ycsr-row[data-key="${k}"] .ycsr-status`).textContent,
    setVal: (el, v) => { el.value = v; fire(el, el.tagName === 'SELECT' ? 'change' : 'input'); },
    gets: () => fake.st.calls.filter((c) => c.method === 'GET' && c.endpoint.startsWith('/api/app-settings')).map((c) => c.endpoint),
    puts: () => fake.st.calls.filter((c) => c.method === 'PUT').map((c) => [c.endpoint.replace('/api/app-settings/', ''), c.payload.value]),
    save: async () => { await w.onSave(); await flush(); },
    banner: () => ($('#sy-banner').hidden ? null : $('#sy-banner').textContent),
  };
  return t;
}

const PAGE_ORDER = ['platform', 'switches', 'alerts', 'integrations', 'casey', 'comms', 'state'];
const titleOf = (id) => [...reg.SECTIONS.system, ...reg.SECTIONS.comms].find((s) => s.id === id).title;

// ─────────────────────────────────────────────────────────────────────────
describe('the sections: one GET, the registry\'s sections, every row in its own', () => {
  test('one GET (home=system,comms); the system sections, then comms, runtime state last, with the registry\'s titles; every served row drawn once in its section', async () => {
    const t = await boot();
    expect(t.gets()).toEqual(['/api/app-settings?home=system,comms']);
    // the page's order covers exactly the registry's sections of both homes
    expect([...PAGE_ORDER].sort()).toEqual([...reg.SECTIONS.system, ...reg.SECTIONS.comms].map((s) => s.id).sort());
    expect(t.$$('#sy-sections > .sy-section').map((s) => [s.id, s.dataset.home, s.querySelector('h2').textContent.trim()]))
      .toEqual(PAGE_ORDER.map((id) => [`sy-sec-${id}`, id === 'comms' ? 'comms' : 'system', titleOf(id)]));
    expect(t.$$('#sy-toc a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(PAGE_ORDER.map((id) => [titleOf(id), `#sy-sec-${id}`]));
    const served = t.fake.served().filter((r) => r.home === 'system' || r.home === 'comms');
    for (const id of PAGE_ORDER) {
      const drawn = t.$$(`#sy-sec-${id} [data-key]`).map((r) => r.dataset.key);
      expect([id, drawn]).toEqual([id, served.filter((r) => r.section === id).map((r) => r.key)]);
    }
    expect(t.$$('[data-key]')).toHaveLength(served.length);
    expect(t.$('[data-key="firm_name"]')).toBeNull();
    // every registered system / comms key the registry serves, nothing else
    expect(served.map((r) => r.key).sort()).toEqual(Object.keys(reg.SETTINGS)
      .filter((k) => ['system', 'comms'].includes(reg.SETTINGS[k].home) && !reg.NEVER_SERVED.includes(reg.SETTINGS[k].kind)).sort());
    expect([t.w.SystemPage.Page.dirty(), t.topbar()]).toEqual([false, { refresh: true, save: false }]);
    expect(t.$('.sy-intro').textContent).toMatch(/A firm\s+admin's settings — identity, senders, routing, booking, Dropbox, e-sign — are on the Firm tab/);
  });

  test('console-posture rows are read-only with the SU-console note; ui rows get their control and History; the credential pickers share ONE /api/credentials', async () => {
    const t = await boot();
    for (const k of ['app_url', 'gcs_bucket', 'landing_hosts', 'gcontacts_credential_id', 'comms_stt_credential_id', 'comms_summary_model']) {
      const r = t.row(k);
      expect([k, r.querySelectorAll('input, select, textarea, button').length, r.querySelector('.ycsr-posture').textContent])
        .toEqual([k, 0, 'Changed from the SU db console only.']);
    }
    expect(t.row('app_url').querySelector('.ycsr-ro').textContent).toBe('https://app.acme.example');
    expect([t.ctl('cloud_tasks_enabled').type, t.ctl('cloud_tasks_enabled').checked]).toEqual(['checkbox', true]);
    expect([...t.ctl('alert_email_min_severity').options].map((o) => o.value)).toEqual(['', 'error', 'warn', 'info']);
    expect([...t.ctl('dropbox_credential_id').options].map((o) => o.textContent))
      .toEqual(['— none —', 'Dropbox (#3, oauth2)', 'Zoho Sign (#7, oauth2)', 'Google (#12, oauth2)']);
    expect([t.ctl('dropbox_credential_id').value, t.ctl('esign_credential_id').value]).toEqual(['3', '7']);
    expect(t.fake.st.calls.filter((c) => c.endpoint === '/api/credentials')).toHaveLength(1);
    for (const k of ['cloud_tasks_enabled', 'alert_cooldown_hours', 'gcal_calendar_id', 'comms_transcribe_mode']) {
      expect([k, !!t.row(k).querySelector('[data-ycsr="history"]')]).toEqual([k, true]);
    }
    expect(t.$('#sy-sec-comms .sy-sec-body > .yc-hint').textContent).toBe(t.w.SystemPage.SECTION_HINTS.comms);
  });

  test('runtime state: read-only by construction (no control, no History); a JSON object pretty-printed, anything else as stored; unset and blank said; DB text never markup', async () => {
    const t = await boot();
    const sec = t.$('#sy-sec-state');
    expect(sec.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    expect(sec.querySelector('.sy-sec-status').textContent).toBe('Read-only');
    expect(sec.querySelector('.sy-sec-body > .yc-hint').textContent).toBe(t.w.SystemPage.SECTION_HINTS.state);
    const val = (k) => sec.querySelector(`[data-key="${k}"] .sy-val`);
    expect(val('error_sweep_state').textContent).toBe(JSON.stringify(JSON.parse(ERROR_SWEEP), null, 2));
    expect(val('error_sweep_state').textContent.split('\n').length).toBeGreaterThan(3);
    expect(val('alert_last_sweep_at').textContent).toBe('2026-10-17T09:00:00Z');
    expect(val('clio_login_code').textContent).toBe('123456');                       // a number is shown as stored
    expect([val('esign_credit_alert_sent').textContent, val('esign_credit_alert_sent').className]).toEqual(['(blank)', 'sy-val blank']);
    expect(val('process_jobs_last_heartbeat_at').textContent).toBe('Not set — nothing has written it yet.');
    expect(val('gcontacts_group').textContent).toBe(VALUES.gcontacts_group);
    expect([sec.querySelector('img'), sec.querySelector('b'), t.w.__xss]).toEqual([null, null, undefined]);
    const r = sec.querySelector('[data-key="error_sweep_state"]');
    expect([r.querySelector('.yc-flabel').textContent, r.querySelector('.sy-key').textContent])
      .toEqual([reg.SETTINGS.error_sweep_state.label, 'error_sweep_state']);
    expect(r.querySelector('.yc-hint').textContent).toBe(reg.SETTINGS.error_sweep_state.desc);
    // the page's helper: objects / arrays pretty, the rest verbatim
    expect([t.w.SystemPage.stateText('[1,2]'), t.w.SystemPage.stateText(' 42 '), t.w.SystemPage.stateText('"x"'), t.w.SystemPage.stateText('{oops')])
      .toEqual(['[\n  1,\n  2\n]', ' 42 ', '"x"', '{oops']);
  });

  test('the source: the rows module loaded by its tag; every call through api(); no inline handler; no style.css', () => {
    expect(SYSTEM_HTML.split(ROWS_TAG)).toHaveLength(2);
    expect(SYSTEM_HTML.match(/P\.apiSend\(/g)).toHaveLength(1);
    expect(SYSTEM_HTML).not.toMatch(/\son[a-z]+="/);
    expect(SYSTEM_HTML).not.toMatch(/href="[^"]*style\.css"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('Save', () => {
  test('only the dirty keys, in page order across sections; the topbar Save follows dirty; clean after; no firmData reload (no fe-* key)', async () => {
    const t = await boot();
    t.setVal(t.ctl('comms_transcribe_mode'), 'on');
    t.setVal(t.ctl('alert_cooldown_hours'), ' 12 ');
    const cb = t.ctl('court_ingest_live');
    cb.checked = true; t.fire(cb, 'change');
    expect(t.topbar().save).toBe(true);
    expect(['switches', 'alerts', 'comms', 'platform'].map((id) => t.$(`#sy-sec-${id} .sy-sec-status`).textContent))
      .toEqual(['Unsaved changes', 'Unsaved changes', 'Unsaved changes', 'All changes saved']);
    await t.save();
    expect(t.puts()).toEqual([['court_ingest_live', '1'], ['alert_cooldown_hours', ' 12 '], ['comms_transcribe_mode', 'on']]);
    expect(['court_ingest_live', 'alert_cooldown_hours', 'comms_transcribe_mode'].map((k) => t.fake.value(k))).toEqual(['1', ' 12 ', 'on']);
    expect([t.w.SystemPage.Page.dirty(), t.topbar().save, t.banner(), t.status('alert_cooldown_hours')]).toEqual([false, false, null, 'Saved']);
    expect(t.$$('.sy-sec-status').map((s) => s.textContent)).toEqual([...Array(6).fill('All changes saved'), 'Read-only']);
    expect(t.firmLoads()).toBe(0);
    await t.save();                                         // nothing dirty → nothing sent
    expect(t.puts()).toHaveLength(3);
  });

  test('a 400: the server\'s sentence verbatim on its row, the banner names the sections; the other rows still save; the edits are kept', async () => {
    const t = await boot();
    t.setVal(t.ctl('alert_cooldown_hours'), 'soon');
    t.setVal(t.ctl('mail_send_daily_budget'), '{"gmail": 10,');
    t.setVal(t.ctl('gcal_calendar_id'), 'other@group.calendar.google.com');
    await t.save();
    expect(t.status('alert_cooldown_hours')).toBe('must be a number');
    expect(t.status('mail_send_daily_budget')).toBe(reg.validate('mail_send_daily_budget', '{"gmail": 10,'));
    expect(t.status('mail_send_daily_budget')).toMatch(/^must be valid JSON — /);
    expect(t.banner()).toBe('Platform and Alert thresholds: 2 settings were not saved — the reason is on each.');
    expect([t.fake.value('gcal_calendar_id'), t.status('gcal_calendar_id')]).toEqual(['other@group.calendar.google.com', 'Saved']);
    expect([t.fake.value('alert_cooldown_hours'), t.ctl('alert_cooldown_hours').value, t.w.SystemPage.Page.dirty(), t.topbar().save])
      .toEqual(['6', 'soon', true, true]);
    t.setVal(t.ctl('alert_cooldown_hours'), '8');
    t.setVal(t.ctl('mail_send_daily_budget'), '{"gmail": 10}');
    await t.save();
    expect([t.banner(), t.w.SystemPage.Page.dirty(), t.fake.value('alert_cooldown_hours')]).toEqual([null, false, '8']);
  });

  test('History + restore through the page: the confirm is the page\'s; the row follows', async () => {
    const t = await boot();
    t.setVal(t.ctl('alert_cooldown_hours'), '24');
    await t.save();
    t.fire(t.row('alert_cooldown_hours').querySelector('[data-ycsr="history"]'), 'click');
    await flush();
    expect(t.row('alert_cooldown_hours').querySelector('.ycsr-ver-line').textContent).toMatch(/^changed “6” → “24” by Alex, .+, in the app$/);
    const asked = [];
    t.w.confirm = (m) => { asked.push(m); return true; };
    t.fire(t.row('alert_cooldown_hours').querySelector('[data-ycsr="restore"]'), 'click');
    await flush();
    expect(asked).toEqual(['Restore this value?\n\nAlert cooldown (hours) goes back to “6” — a new entry in History.']);
    expect([t.fake.value('alert_cooldown_hours'), t.ctl('alert_cooldown_hours').value, t.w.SystemPage.Page.dirty()]).toEqual(['6', '6', false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a caller without system.settings: the session message', () => {
  test('the GET refused (403): the session message, no sections, no Save', async () => {
    const t = await boot({ wrap: (api) => async (url, method, body) => {
      if (String(url).startsWith('/api/app-settings') && (method || 'GET') === 'GET') throw apiError(403, 'Forbidden');
      return api(url, method, body);
    } });
    expect([t.banner(), t.$$('.sy-section').length, t.$('#sy-sections .empty-state').textContent, t.$('#sy-toc').hidden])
      .toEqual([SESSION_MSG, 0, SESSION_MSG, true]);
    expect(t.topbar()).toEqual({ refresh: true, save: false });
  });

  test('the GET answering caps.system false (the real route serves a non-holder no system rows): the session message, not empty sections', async () => {
    const t = await boot({ caps: { firm: true, system: false } });
    expect(t.gets()).toEqual(['/api/app-settings?home=system,comms']);
    expect([t.banner(), t.$$('.sy-section').length, t.$$('[data-key]').length]).toEqual([SESSION_MSG, 0, 0]);
  });

  test('another GET failure: said with its reason (not the session message)', async () => {
    const t = await boot({ wrap: (api) => async (url, method, body) => {
      if (String(url).startsWith('/api/app-settings')) throw apiError(500, 'Settings request failed');
      return api(url, method, body);
    } });
    expect(t.banner()).toBe('Could not load the system settings: Settings request failed');
  });

  test('a PUT refused (403 — the permission gone since the page loaded): the server\'s sentence on the row, the session message on the banner, the edit kept', async () => {
    const t = await boot();
    t.fake.st.caps.system = false;
    const cb = t.ctl('cloud_tasks_enabled');
    cb.checked = false; t.fire(cb, 'change');
    await t.save();
    expect(t.status('cloud_tasks_enabled')).toBe('Changing Cloud Tasks accelerator needs the system.settings permission');
    expect(t.banner()).toBe(`Platform: a setting was not saved — the reason is on it. ${SESSION_MSG}`);
    expect([t.fake.value('cloud_tasks_enabled'), t.w.SystemPage.Page.dirty()]).toEqual(['1', true]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the dirty guards', () => {
  test('Refresh asks first (No: nothing re-read, the edit kept; Yes: one more GET, clean); a clean Refresh asks nothing; a tab return never reloads over an edit; an unload is held', async () => {
    const t = await boot();
    let asked = 0;
    t.w.confirm = () => { throw new Error('asked'); };
    await t.w.onRefresh();
    await flush();
    expect(t.gets()).toHaveLength(2);                       // clean: no question
    t.setVal(t.ctl('gcal_calendar_id'), 'x@example.com');
    t.w.confirm = () => { asked++; return false; };
    await t.w.onRefresh();
    await flush();
    expect([asked, t.gets().length, t.ctl('gcal_calendar_id').value]).toEqual([1, 2, 'x@example.com']);
    t.w.onShow();
    await flush();
    expect([t.gets().length, t.ctl('gcal_calendar_id').value]).toEqual([2, 'x@example.com']);
    const ev = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    t.w.confirm = () => { asked++; return true; };
    await t.w.onRefresh();
    await flush();
    expect([asked, t.gets().length, t.ctl('gcal_calendar_id').value, t.w.SystemPage.Page.dirty()])
      .toEqual([2, 3, VALUES.gcal_calendar_id, false]);
    const ev2 = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    t.w.onShow();                                            // clean: a tab return re-reads
    await flush();
    expect(t.gets()).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('under the real Config shell', () => {
  async function shell(answer) {
    const fake = makeSettingsApi({ values: VALUES, caps: { firm: !!answer.can_edit_firm, system: !!answer.can_edit_system } });
    const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() }).window;
    const calls = [];
    top.apiSend = async (url, method = 'GET', body) => {
      calls.push(`${method} ${url}`);
      if (url === '/api/ui-config') return answer;
      return fake.api(url, method, body);
    };
    top.firmData = { users: USERS };
    const f = top.document.createElement('iframe');
    top.document.body.appendChild(f);
    await flush(5);
    const mid = f.contentWindow;
    mid.document.open(); mid.document.write(strip(CCM_HTML)); mid.document.close();
    await flush();
    return { top, mid, fake, calls, $: (id) => mid.document.getElementById(id) };
  }
  const load = async (s) => {
    s.mid.switchSubPage('system');
    const fr = s.$('subpage-system');
    fr.contentWindow.document.open(); fr.contentWindow.document.write(strip(SYSTEM_HTML)); fr.contentWindow.document.close();
    await flush();
    fr.dispatchEvent(new s.mid.Event('load'));               // the shell delivers onAccess on the frame's load
    await flush();
    return fr.contentWindow;
  };

  test('revealed by can_edit_system alone; never read-only (can_edit_firm false): no banner, rows editable, Save shown once dirty and it saves', async () => {
    const s = await shell({ can_edit_firm: false, can_edit_system: true });
    expect(s.$('tabnav-system').hidden).toBe(false);
    expect(s.$('tabnav-firm').hidden).toBe(true);
    const w = await load(s);
    expect(s.$('tabnav-system').classList.contains('active')).toBe(true);
    expect(s.$('ro-banner').hidden).toBe(true);
    expect(s.$('btn-save').style.display).toBe('none');
    expect(s.$('btn-refresh').style.display).toBe('');
    const inp = w.document.querySelector('.ycsr-row[data-key="gcal_calendar_id"] input');
    inp.value = 'new@group.calendar.google.com';
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(s.$('btn-save').style.display).toBe('');
    s.mid.onTopbarSave();
    await flush();
    expect(s.fake.value('gcal_calendar_id')).toBe('new@group.calendar.google.com');
    expect(s.calls.filter((c) => !c.startsWith('GET '))).toEqual(['PUT /api/app-settings/gcal_calendar_id']);
    expect(s.$('btn-save').style.display).toBe('none');
  });

  test('hidden without can_edit_system (a firm admin): the shell refuses the tab', async () => {
    const s = await shell({ can_edit_firm: true, can_edit_system: false });
    expect(s.$('tabnav-system').hidden).toBe(true);
    s.mid.switchSubPage('system');
    expect(s.$('subpage-system').getAttribute('src')).toBeNull();
    expect(s.calls).toEqual(['GET /api/ui-config']);
  });
});
