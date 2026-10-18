/**
 * @jest-environment node
 *
 * tests/settingsToolHomes.test.js — settings arc W6: the two tool homes of
 * registered settings outside YisraCase Config.
 *
 *   public/portaladmin/portalSettings.html   home 'portal' (firm.settings)
 *   public/ctaManager.html → Link defaults   home 'cta'    (system.settings)
 *
 * BOOTS the real pages in jsdom (the ctaManager.pane.test.js harness: the
 * body, then the one inline block as a real classic script) against a fake
 * apiSend that speaks the settings API contract of the arc spec §2 — built on
 * the REAL lib/settingsRegistry (which keys exist, their home, type, label,
 * edit posture, capsOf, validate), so a registry change reaches these pages'
 * tests: GET /api/app-settings[?home=] with caps / exists / can_edit, PUT that
 * creates a missing registered row and refuses (403) without the home's write
 * capability, POST that refuses every registered key (409).
 *
 * WHAT IS LOCKED
 *   Portal Settings
 *     - the three keys it did not edit before (portal_email_from,
 *       portal_callback_task_to, portal_docs_notify_to) load and save;
 *     - every save is a PUT — never a POST — including on a missing row (the
 *       old create-on-first-use POST is gone);
 *     - the callback picker: active staff only; a stored inactive / unknown /
 *       unassignable id stays listed, selected and named (D3b keep-current),
 *       and an unchanged save keeps it;
 *     - client checks: blank sender refused, email shape, a non-sender asks;
 *     - exists:false → "not set"; can_edit:false → read-only (no Save, every
 *       control disabled, and no write reachable by dispatching on the
 *       rendered controls or calling the save functions).
 *   CTA Links → Link defaults
 *     - lazy load (no call at boot), GET ?home=cta, the registry's labels;
 *     - save sends only the changed key, by PUT; client duration check (the
 *       ms() mirror) blocks unusable values before any write;
 *     - read-only when can_edit is false; server refusals shown verbatim;
 *     - the mint form's hint opens the block.
 *
 * Mutation-checked — see the settings-arc W6 worker report.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ms = require('ms');
const reg = require('../lib/settingsRegistry');

const ROOT = path.join(__dirname, '..');
const PORTAL_HTML = fs.readFileSync(path.join(ROOT, 'public/portaladmin/portalSettings.html'), 'utf8');
const CTA_HTML = fs.readFileSync(path.join(ROOT, 'public/ctaManager.html'), 'utf8');

const DOMS = [];
afterEach(() => {
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
});
const tick = (w, n = 30) => new Promise((r) => w.setTimeout(r, n));
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

function apiError(status, message) {
  const e = new Error(message);
  e.name = 'ApiError'; e.status = status; e.body = { status: 'error', message };
  return e;
}

// ═════════════════════════════════════════════════════════════════════════
// The settings API of spec §2, over the real registry
// ═════════════════════════════════════════════════════════════════════════
const HOME_ORDER = Object.keys(reg.HOME_CAPS);
const sectionIndex = (home, id) => (reg.SECTIONS[home] || []).findIndex((s) => s.id === id);
const sectionTitle = (home, id) => { const s = (reg.SECTIONS[home] || []).find((x) => x.id === id); return s ? s.title : null; };

/**
 * @param {object} o
 * @param {object} o.rows     key → stored value (string) — registered keys only here
 * @param {object} o.caps     { firm, system } — what the caller holds
 * @param {object} o.failPut  key → [status, message] the PUT answers instead
 */
function makeSettingsApi({ rows = {}, caps = { firm: true, system: true }, failPut = {} } = {}) {
  const st = { rows: {}, calls: [], seq: 0 };
  for (const [k, v] of Object.entries(rows)) st.rows[k] = { value: v, updated_at: '2026-10-01T10:00:00.000Z' };
  const can = (cap) => cap === null || (cap === 'firm.settings' && !!caps.firm) || (cap === 'system.settings' && !!caps.system);

  function rowOut(key, e) {
    const c = reg.capsOf(e);
    const r = st.rows[key];
    return {
      key, value: r ? r.value : null, updated_at: r ? r.updated_at : null, exists: !!r,
      registered: true, kind: e.kind, home: e.home, section: e.section, type: e.type,
      options: e.options || null, label: e.label, description: e.desc, sort_order: e.sort == null ? null : e.sort,
      edit: reg.editOf(e), editor: e.editor || null, env: e.env || null,
      can_edit: reg.editOf(e) === 'ui' && c.write != null && can(c.write),
      category: sectionTitle(e.home, e.section),
    };
  }

  function list(homes) {
    const out = [];
    for (const [key, e] of Object.entries(reg.SETTINGS)) {
      if (reg.NEVER_SERVED.includes(e.kind)) continue;
      const c = reg.capsOf(e);
      if (c.read === false || (c.read !== null && !can(c.read))) continue;
      if (homes.length && !homes.includes(e.home)) continue;
      out.push(rowOut(key, e));
    }
    out.sort((a, b) => (HOME_ORDER.indexOf(a.home) - HOME_ORDER.indexOf(b.home))
      || (sectionIndex(a.home, a.section) - sectionIndex(b.home, b.section))
      || ((a.sort_order ?? 999) - (b.sort_order ?? 999)) || (a.key < b.key ? -1 : 1));
    const sections = {};
    for (const r of out) sections[r.home] = clone(reg.SECTIONS[r.home]);
    return { status: 'success', caps: { firm: !!caps.firm, system: !!caps.system }, sections, settings: out };
  }

  function put(key, body) {
    const value = body && body.value;
    if (typeof value !== 'string') throw apiError(400, 'value must be a string');
    if (value.length > 60000) throw apiError(400, 'value is too long');
    const e = reg.get(key);
    if (!e) throw apiError(404, `Setting "${key}" not found`);   // (no unregistered rows in these fixtures)
    if (['secret', 'access', 'retired', 'state'].includes(e.kind) || reg.editOf(e) === 'console') {
      throw apiError(403, `${e.label} is changed from the SU db console only`);
    }
    const cap = reg.capsOf(e).write;
    if (!can(cap)) throw apiError(403, `Changing ${e.label} needs the ${cap} permission`);
    if (failPut[key]) throw apiError(failPut[key][0], failPut[key][1]);
    const ok = reg.validate(key, value);
    if (ok !== true) throw apiError(400, `${e.label} ${ok}`);
    const r = st.rows[key];
    if (!(r && r.value === value)) {   // unchanged → no write
      st.rows[key] = { value, updated_at: `2026-10-17T12:00:${String(++st.seq).padStart(2, '0')}.000Z` };
    }
    return { status: 'success', setting: { key, value: st.rows[key].value, updated_at: st.rows[key].updated_at } };
  }

  async function api(endpoint, method = 'GET', payload = null) {
    st.calls.push({ endpoint, method, payload: clone(payload) });
    const [p, qs] = String(endpoint).split('?');
    if (method === 'GET' && p === '/api/app-settings') {
      const homes = (new URLSearchParams(qs || '').get('home') || '').split(',').map((h) => h.trim()).filter(Boolean);
      return list(homes);
    }
    let m;
    if (method === 'PUT' && (m = p.match(/^\/api\/app-settings\/([^/]+)$/))) return put(decodeURIComponent(m[1]), clone(payload));
    if (method === 'POST' && p === '/api/app-settings') {
      const key = payload && payload.key;
      const e = reg.get(key);
      if (e) throw apiError(409, `"${key}" is a registered setting — change it in ${e.home}`);
      throw apiError(400, 'unscripted create');
    }
    throw new Error(`unscripted ${method} ${endpoint}`);
  }
  return { api, st };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');

describe('the fake settings API speaks the contract it is meant to (spec §2)', () => {
  test('missing registered row → exists:false, value null; PUT creates it; POST refuses a registered key', async () => {
    const S = makeSettingsApi();
    const g = await S.api('/api/app-settings?home=portal');
    const row = g.settings.find((r) => r.key === 'portal_email_from');
    expect(row).toMatchObject({ exists: false, value: null, can_edit: true, home: 'portal', type: 'email' });
    await S.api('/api/app-settings/portal_email_from', 'PUT', { value: 'a@b.co' });
    expect(S.st.rows.portal_email_from.value).toBe('a@b.co');
    await expect(S.api('/api/app-settings', 'POST', { key: 'portal_email_from', value: 'x' })).rejects.toMatchObject({ status: 409 });
  });
  test('without the write cap: can_edit false and PUT 403; system-read keys hidden from a non-holder', async () => {
    const S = makeSettingsApi({ caps: { firm: false, system: false } });
    const g = await S.api('/api/app-settings');
    expect(g.settings.find((r) => r.key === 'portal_live').can_edit).toBe(false);
    expect(g.settings.find((r) => r.key === 'portal_sms_counter')).toBeUndefined();
    await expect(S.api('/api/app-settings/portal_live', 'PUT', { value: '0' })).rejects.toMatchObject({ status: 403 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Harness — body + the one inline block as a classic script (single window:
// in jsdom a top-level window is its own parent, so window.apiSend IS P.apiSend)
// ═════════════════════════════════════════════════════════════════════════
const USERS = [
  { user: 0, user_name: 'automations', user_type: 0, active: true },
  { user: 1, user_name: 'Alex Admin',  user_type: 1, active: true },
  { user: 2, user_name: 'Sam Staff',   user_type: 2, active: true },
  { user: 3, user_name: 'Former Staff', user_type: 2, active: false },
];
const SENDERS = [{ id: 1, email: 'portal@firm.test' }, { id: 2, email: 'office@firm.test' }];

async function bootPage(html, { api, firmData, url, swalConfirm = true }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url, runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.firmData = firmData;
  window.apiSend = api;
  const topbar = [];
  window.setTopbarButtons = (b) => topbar.push({ ...b });
  const toasts = []; const dialogs = [];
  const swal = { answer: swalConfirm };
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); return Promise.resolve({}); } }),
    fire: async (o) => { dialogs.push(o); return { isConfirmed: swal.answer }; },
  };
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1);   // fence: a second inline block means this harness is stale
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const sc = window.document.createElement('script');
  sc.textContent = inline[0];
  window.document.body.appendChild(sc);
  await tick(window, 60);
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return { w: window, doc: window.document, $, $$, fire, click, topbar, toasts, dialogs, swal, errors };
}

// ═════════════════════════════════════════════════════════════════════════
// Portal Settings
// ═════════════════════════════════════════════════════════════════════════
const PORTAL_ROWS = {
  portal_live: '1', portal_sms_monthly_cap: '300', portal_email_from: 'portal@firm.test',
  portal_callback_task_to: '2', portal_docs_notify_to: 'office@firm.test',
  portal_logo_url: '', portal_favicon_url: '', portal_logo_href: '',
  portal_sms_counter: '{"ym":"2026-10","count":4}',
};

async function bootPortal({ rows = PORTAL_ROWS, caps, failPut, users = USERS, senders = SENDERS, swalConfirm } = {}) {
  const S = makeSettingsApi({ rows, caps, failPut });
  const t = await bootPage(PORTAL_HTML, {
    api: S.api, url: 'https://app.4lsg.com/portaladmin/portalSettings.html', swalConfirm,
    firmData: { users: clone(users), emailFrom: clone(senders), settings: {}, currentUser: { user: 1 } },
  });
  const settle = () => tick(t.w, 40);
  const opts = (sel) => [...sel.options].map((o) => o.value);
  const setVal = (id, v) => { const el = t.$('#' + id); el.value = v; t.fire(el, el.tagName === 'SELECT' ? 'change' : 'input'); };
  /** The Save button of the row holding #id. */
  const saveOf = (id) => t.$('#' + id).closest('.brand-row').querySelector('button');
  return { ...t, S, calls: S.st.calls, settle, opts, setVal, saveOf };
}

describe('Portal Settings — the three new keys', () => {
  test('load: values shown; the callback picker offers active staff only, the stored one selected', async () => {
    const t = await bootPortal();
    expect(t.calls[0]).toEqual({ endpoint: '/api/app-settings', method: 'GET', payload: null });
    expect(t.topbar[0]).toEqual({ refresh: true });
    expect(t.$('#pf-email-from').value).toBe('portal@firm.test');
    expect(t.$('#pf-notify-to').value).toBe('office@firm.test');
    const sel = t.$('#pf-callback');
    expect(t.opts(sel)).toEqual(['1', '2']);   // not user 0, not the inactive user 3
    expect(sel.value).toBe('2');
    expect(t.$$('#pf-senders option').map((o) => o.value)).toEqual(['portal@firm.test', 'office@firm.test']);
    expect(t.$('.warn-note')).toBeNull();
    expect(t.$('.ro-note')).toBeNull();
    expect(t.$$('.not-set')).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  test('each saves with one PUT of its own key — never a POST', async () => {
    const t = await bootPortal();
    t.setVal('pf-email-from', ' office@firm.test ');
    t.click(t.saveOf('pf-email-from'));
    await t.settle();
    t.setVal('pf-callback', '1');
    t.click(t.saveOf('pf-callback'));
    await t.settle();
    t.setVal('pf-notify-to', 'intake@firm.test');
    t.click(t.saveOf('pf-notify-to'));
    await t.settle();
    expect(writesOf(t.calls)).toEqual([
      { endpoint: '/api/app-settings/portal_email_from', method: 'PUT', payload: { value: 'office@firm.test' } },
      { endpoint: '/api/app-settings/portal_callback_task_to', method: 'PUT', payload: { value: '1' } },
      { endpoint: '/api/app-settings/portal_docs_notify_to', method: 'PUT', payload: { value: 'intake@firm.test' } },
    ]);
    expect(t.S.st.rows.portal_callback_task_to.value).toBe('1');
    expect(t.dialogs).toEqual([]);   // a known sender asks nothing
    expect(t.toasts.map((x) => x.icon)).toEqual(['success', 'success', 'success']);
    expect(t.$('#pf-callback').value).toBe('1');   // reloaded from the server
  });

  test('missing rows: "not set", and the first save CREATES the row with PUT (no POST anywhere)', async () => {
    const t = await bootPortal({ rows: {} });
    expect(t.$$('.not-set').length).toBeGreaterThanOrEqual(8);
    expect(t.$('label[for="pf-email-from"] .not-set')).not.toBeNull();
    expect(t.$('label[for="pf-callback"] .not-set')).not.toBeNull();
    expect(t.$('label[for="pf-notify-to"] .not-set')).not.toBeNull();
    const sel = t.$('#pf-callback');
    expect(sel.value).toBe('');
    expect(sel.options[sel.selectedIndex].textContent).toBe('— not set —');

    t.setVal('pf-email-from', 'portal@firm.test'); t.click(t.saveOf('pf-email-from')); await t.settle();
    t.setVal('pf-callback', '2');                  t.click(t.saveOf('pf-callback'));   await t.settle();
    t.setVal('pf-notify-to', 'office@firm.test');  t.click(t.saveOf('pf-notify-to'));  await t.settle();
    // and the pre-existing fields, on missing rows too
    t.w.setLive(false); await t.settle();
    t.$('#sms-cap').value = '120'; t.w.saveCap(); await t.settle();
    t.$('#brand-logo').value = 'https://cdn.example/logo.png'; t.w.saveBrand('logo'); await t.settle();

    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(writesOf(t.calls).map((c) => c.endpoint)).toEqual([
      '/api/app-settings/portal_email_from', '/api/app-settings/portal_callback_task_to',
      '/api/app-settings/portal_docs_notify_to', '/api/app-settings/portal_live',
      '/api/app-settings/portal_sms_monthly_cap', '/api/app-settings/portal_logo_url',
    ]);
    expect(Object.fromEntries(Object.entries(t.S.st.rows).map(([k, r]) => [k, r.value]))).toEqual({
      portal_email_from: 'portal@firm.test', portal_callback_task_to: '2', portal_docs_notify_to: 'office@firm.test',
      portal_live: '0', portal_sms_monthly_cap: '120', portal_logo_url: 'https://cdn.example/logo.png',
    });
    expect(t.$$('.not-set').length).toBeGreaterThanOrEqual(2);   // the untouched ones still say so
    expect(t.$('label[for="pf-callback"] .not-set')).toBeNull();
    expect(t.errors).toEqual([]);
  });

  test('blank upload recipient is allowed (emails off) and saved as ""', async () => {
    const t = await bootPortal();
    t.setVal('pf-notify-to', '   ');
    t.click(t.saveOf('pf-notify-to'));
    await t.settle();
    expect(writesOf(t.calls)).toEqual([{ endpoint: '/api/app-settings/portal_docs_notify_to', method: 'PUT', payload: { value: '' } }]);
  });
});

describe('Portal Settings — client checks (no write when refused)', () => {
  test.each([
    ['a blank sender', 'pf-email-from', '', /cannot be blank/],
    ['a malformed sender', 'pf-email-from', 'portal@firm', /valid email/],
    ['a malformed recipient', 'pf-notify-to', 'office at firm', /valid email address — or blank/],
  ])('%s', async (_n, id, v, msg) => {
    const t = await bootPortal();
    t.setVal(id, v);
    t.click(t.saveOf(id));
    await t.settle();
    expect(writesOf(t.calls)).toEqual([]);
    expect(t.toasts.pop()).toMatchObject({ icon: 'error', title: expect.stringMatching(msg) });
  });

  test('a sender that is not one of the firm\'s sending addresses asks; Cancel writes nothing, Save anyway writes', async () => {
    const t = await bootPortal({ swalConfirm: false });
    t.setVal('pf-email-from', 'someone@else.test');
    t.click(t.saveOf('pf-email-from'));
    await t.settle();
    expect(t.dialogs).toHaveLength(1);
    expect(t.dialogs[0].html).toMatch(/someone@else\.test is not set up as a sending address/);
    expect(writesOf(t.calls)).toEqual([]);
    t.swal.answer = true;
    t.click(t.saveOf('pf-email-from'));
    await t.settle();
    expect(writesOf(t.calls)).toEqual([{ endpoint: '/api/app-settings/portal_email_from', method: 'PUT', payload: { value: 'someone@else.test' } }]);
  });

  test('no sending-address list (firmData without emailFrom) → no question asked', async () => {
    const t = await bootPortal({ senders: [] });
    t.setVal('pf-email-from', 'someone@else.test');
    t.click(t.saveOf('pf-email-from'));
    await t.settle();
    expect(t.dialogs).toEqual([]);
    expect(writesOf(t.calls)).toHaveLength(1);
  });

  test('callback assignee not set and nothing picked → refused', async () => {
    const t = await bootPortal({ rows: { ...PORTAL_ROWS, portal_callback_task_to: '' } });
    t.click(t.saveOf('pf-callback'));
    await t.settle();
    expect(writesOf(t.calls)).toEqual([]);
    expect(t.toasts.pop()).toMatchObject({ icon: 'error', title: expect.stringMatching(/Pick a staff member/) });
  });

  test('the server\'s refusal is shown verbatim, no success toast, no reload', async () => {
    const t = await bootPortal({ failPut: { portal_docs_notify_to: [400, 'Upload notification to must be a valid email address'] } });
    t.setVal('pf-notify-to', 'ok@firm.test');
    t.click(t.saveOf('pf-notify-to'));
    await t.settle();
    expect(t.toasts).toEqual([{ icon: 'error', title: 'Upload notification to must be a valid email address' }]);
    expect(t.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(t.errors).toEqual([]);
  });
});

describe('Portal Settings — callback picker keeps the current value (D3b)', () => {
  test.each([
    ['an inactive user', '3', 'Former Staff (inactive)', 'inactive'],
    ['an id not in the staff list', '88', 'user #88 (not in the staff list)', 'not in the staff list'],
    ['the automations user', '0', 'automations (not assignable)', 'not assignable'],
  ])('%s stays listed last, selected and named; a warning says so', async (_n, id, label, why) => {
    const t = await bootPortal({ rows: { ...PORTAL_ROWS, portal_callback_task_to: id } });
    const sel = t.$('#pf-callback');
    expect(t.opts(sel)).toEqual(['1', '2', id]);
    expect(sel.value).toBe(id);
    expect(sel.options[sel.selectedIndex].textContent).toBe(label);
    expect(t.$('.warn-note').textContent).toContain(`The current assignee is ${why}`);
    // An unchanged save keeps it — never silently re-pointed.
    t.click(t.saveOf('pf-callback'));
    await t.settle();
    expect(writesOf(t.calls)).toEqual([{ endpoint: '/api/app-settings/portal_callback_task_to', method: 'PUT', payload: { value: id } }]);
  });
});

describe('Portal Settings — read-only without firm.settings (can_edit false)', () => {
  test('no Save, no take-down button, every control disabled; nothing on the page reaches a write', async () => {
    const t = await bootPortal({ caps: { firm: false, system: false } });
    expect(t.$('.ro-note').textContent).toMatch(/Read-only — changing portal settings needs the admin permission/);
    expect(t.$$('#wrap button')).toEqual([]);
    expect(t.$$('#wrap input, #wrap select').every((el) => el.disabled)).toBe(true);
    // values still shown
    expect(t.$('#pf-email-from').value).toBe('portal@firm.test');
    expect(t.$('#pf-callback').value).toBe('2');

    for (const el of t.$$('#wrap input, #wrap select')) {
      if (el.tagName === 'SELECT') el.value = '1'; else el.value = el.type === 'number' ? '5' : 'x@y.co';
      t.fire(el, 'input'); t.fire(el, 'change');
    }
    for (const el of t.$$('#wrap *')) t.click(el);
    t.w.setLive(false); t.w.setLive(true); t.w.saveCap(); t.w.saveBrand('logo'); t.w.saveBrand('href');
    t.w.savePortalEmail('emailFrom'); t.w.savePortalEmail('notifyTo'); t.w.saveCallbackAssignee();
    await t.settle();
    expect(writesOf(t.calls)).toEqual([]);
    expect(t.dialogs).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  test('the SMS counter (system state) shows only to a system.settings holder', async () => {
    const withSys = await bootPortal({ caps: { firm: true, system: true } });
    expect(withSys.$('#wrap').textContent).toMatch(/Current SMS counter: \{"ym":"2026-10","count":4\}/);
    const admin = await bootPortal({ caps: { firm: true, system: false } });
    expect(admin.$('#wrap').textContent).not.toMatch(/Current SMS counter/);
    expect(admin.$('.ro-note')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// CTA Links → Link defaults
// ═════════════════════════════════════════════════════════════════════════
async function bootCta({ rows = { cta_default_timeout_once: '3d', cta_default_timeout_repeatable: '30d' }, caps, failPut } = {}) {
  const S = makeSettingsApi({ rows, caps, failPut });
  const calls = [];   // every call, recorded BEFORE it is answered (a refused write still counts)
  const api = async (url, method = 'GET', payload = null) => {
    calls.push({ endpoint: url, method, payload: clone(payload) });
    if (url === '/api/cta' && method === 'GET') return { ctas: [] };
    return S.api(url, method, payload);
  };
  const t = await bootPage(CTA_HTML, {
    api, url: 'https://app.4lsg.com/ctaManager.html',
    firmData: { firmTimezone: 'America/Detroit', users: clone(USERS), emailFrom: [], phoneLines: [] },
  });
  const settle = () => tick(t.w, 40);
  const open = async () => { const d = t.$('#cta-defaults'); d.open = true; t.fire(d, 'toggle'); await settle(); };
  const input = (k) => t.$(`#d-${k}`);
  const type = (k, v) => { const el = input(k); el.value = v; t.fire(el, 'input'); };
  const saveBtn = () => t.$('#defaults-region [data-act="save-defaults"]');
  const settingCalls = () => calls.filter((c) => String(c.endpoint).startsWith('/api/app-settings'));
  return { ...t, S, calls, settingCalls, settle, open, input, type, saveBtn };
}

describe('CTA Links — Link defaults', () => {
  test('nothing is fetched at boot; opening the block loads ?home=cta and shows the registry labels', async () => {
    const t = await bootCta();
    expect(t.settingCalls()).toEqual([]);
    await t.open();
    expect(t.settingCalls()).toEqual([{ endpoint: '/api/app-settings?home=cta', method: 'GET', payload: null }]);
    expect(t.input('cta_default_timeout_once').value).toBe('3d');
    expect(t.input('cta_default_timeout_repeatable').value).toBe('30d');
    expect(t.$('label[for="d-cta_default_timeout_once"]').textContent).toBe(reg.get('cta_default_timeout_once').label);
    expect(t.saveBtn().disabled).toBe(true);
    // closing and reopening does not fetch again
    t.$('#cta-defaults').open = false; await t.open();
    expect(t.settingCalls()).toHaveLength(1);
    expect(t.errors).toEqual([]);
  });

  test('save sends one PUT for the changed key only; the block shows what was stored', async () => {
    const t = await bootCta();
    await t.open();
    t.type('cta_default_timeout_once', ' 5d ');
    expect(t.saveBtn().disabled).toBe(false);
    t.click(t.saveBtn());
    await t.settle();
    expect(writesOf(t.settingCalls())).toEqual([{ endpoint: '/api/app-settings/cta_default_timeout_once', method: 'PUT', payload: { value: '5d' } }]);
    expect(t.S.st.rows.cta_default_timeout_once.value).toBe('5d');
    expect(t.input('cta_default_timeout_once').value).toBe('5d');
    expect(t.saveBtn().disabled).toBe(true);
    expect(t.$('#toast').textContent).toBe('Link defaults saved');
  });

  test('missing rows: "not set"; a save creates the row with PUT, never POST; blank is allowed', async () => {
    const t = await bootCta({ rows: {} });
    await t.open();
    expect(t.$$('#defaults-region .tag').map((e) => e.textContent)).toEqual(['not set', 'not set']);
    t.type('cta_default_timeout_repeatable', '26w');
    t.click(t.saveBtn());
    await t.settle();
    expect(writesOf(t.settingCalls())).toEqual([{ endpoint: '/api/app-settings/cta_default_timeout_repeatable', method: 'PUT', payload: { value: '26w' } }]);
    expect(t.$$('#defaults-region .tag')).toHaveLength(1);

    const u = await bootCta();
    await u.open();
    u.type('cta_default_timeout_once', '');
    u.click(u.saveBtn());
    await u.settle();
    expect(writesOf(u.settingCalls())).toEqual([{ endpoint: '/api/app-settings/cta_default_timeout_once', method: 'PUT', payload: { value: '' } }]);
  });

  test.each([
    ['no unit (ms would read milliseconds)', '3', /number and a unit/],
    ['not a duration', 'three days', /number and a unit/],
    ['a bare decimal point (ms reads it; the server refuses it)', '.5d', /number and a unit/],
    ['negative', '-3d', /number and a unit/],
    ['zero', '0d', /longer than zero/],
    ['over a year', '366d', /At most 365 days/],
    ['a year is 365.25 days to ms', '1y', /At most 365 days/],
  ])('refused before any write: %s', async (_n, v, msg) => {
    const t = await bootCta();
    await t.open();
    t.type('cta_default_timeout_once', '7d');
    t.type('cta_default_timeout_repeatable', v);
    t.click(t.saveBtn());
    await t.settle();
    expect(writesOf(t.settingCalls())).toEqual([]);   // not even the good one
    const err = t.$('[data-derr="cta_default_timeout_repeatable"]');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(msg);
    t.type('cta_default_timeout_repeatable', '30d');   // typing clears it
    expect(err.hidden).toBe(true);
  });

  test('the server\'s refusal is shown verbatim and the typed value stays', async () => {
    const t = await bootCta({ failPut: { cta_default_timeout_once: [400, 'Default expiry (single-use) is not allowed today'] } });
    await t.open();
    t.type('cta_default_timeout_once', '4d');
    t.click(t.saveBtn());
    await t.settle();
    expect(t.$('#defaults-status').textContent).toBe('Default expiry (single-use) is not allowed today');
    expect(t.input('cta_default_timeout_once').value).toBe('4d');
    expect(t.saveBtn().disabled).toBe(false);
  });

  test('read-only without system.settings: inputs disabled, no Save, and nothing reaches a write', async () => {
    const t = await bootCta({ caps: { firm: true, system: false } });
    await t.open();
    expect(t.saveBtn()).toBeNull();
    expect(t.$('#defaults-region').textContent).toMatch(/Read-only — changing the link defaults needs the system settings permission/);
    expect(t.$$('#defaults-region input').every((el) => el.disabled)).toBe(true);
    for (const el of t.$$('#defaults-region input')) { el.value = '9d'; t.fire(el, 'input'); }
    for (const el of t.$$('#defaults-region *')) t.click(el);
    await t.w.saveDefaults();
    await t.settle();
    expect(writesOf(t.settingCalls())).toEqual([]);
  });

  test('a failed load offers Retry', async () => {
    const t = await bootCta();
    const real = t.w.apiSend;
    t.w.apiSend = async () => { throw apiError(500, 'settings unavailable'); };
    await t.open();
    expect(t.$('#defaults-region .inline-error').textContent).toMatch(/settings unavailable/);
    t.w.apiSend = real;
    t.click(t.$('[data-act="retry-defaults"]'));
    await t.settle();
    expect(t.input('cta_default_timeout_once').value).toBe('3d');
  });

  test('the builder\'s expiry hint opens the block (and loads it)', async () => {
    const t = await bootCta();
    t.click(t.$('#new-btn'));
    await t.settle();
    const link = t.$('#mint-region [data-act="open-defaults"]');
    expect(link.textContent).toBe('Link defaults');
    expect(t.$('#mint-region').textContent).not.toMatch(/cta_default_timeout_once/);
    t.click(link);
    await t.settle();
    expect(t.$('#cta-defaults').open).toBe(true);
    expect(t.settingCalls()).toEqual([{ endpoint: '/api/app-settings?home=cta', method: 'GET', payload: null }]);
  });

  test('hidden with the instructions on the receipt (a shown-once secret has the page)', async () => {
    const t = await bootCta();
    t.w.eval("setView('receipt')");
    expect(t.$('#cta-defaults').hidden).toBe(true);
    t.w.eval("setView('list')");
    expect(t.$('#cta-defaults').hidden).toBe(false);
  });

  test('durationMs mirrors ms() wherever a unit is given; the pane is stricter only on a bare number', async () => {
    const t = await bootCta();
    const samples = ['30m', '12h', '3d', '2w', '1.5h', '.5d', '90 days', '2 weeks', '10s', '500ms', '1y', '7D', '1 Hour', '-1d'];
    for (const s of samples) expect([s, t.w.durationMs(s)]).toEqual([s, ms(s)]);
    expect(ms('3')).toBe(3);
    expect(Number.isNaN(t.w.durationMs('3'))).toBe(true);
    expect(t.w.durationProblem('365d')).toBeNull();
    // The server's constants are not exported: pin the pane's mirrors to its source.
    const SRC = fs.readFileSync(path.join(ROOT, 'services/ctaService.js'), 'utf8');
    const fb = SRC.match(/const FALLBACK_TIMEOUT = \{ once: '([^']+)', repeatable: '([^']+)' \};/);
    const mx = SRC.match(/const MAX_EXPIRY_MS = ms\('([^']+)'\);/);
    const keys = SRC.match(/const SETTING_TIMEOUT = \{\s*once: '([^']+)',\s*repeatable: '([^']+)',\s*\};/);
    expect(fb && mx && keys).toBeTruthy();
    expect(t.w.eval('MAX_DEFAULT_MS')).toBe(ms(mx[1]));
    expect(t.w.eval('DEFAULT_FALLBACK')).toEqual({ [keys[1]]: fb[1], [keys[2]]: fb[2] });
    expect(t.w.eval('DEFAULT_KEYS')).toEqual([keys[1], keys[2]]);
  });
});
