// tests/firmTab.test.js
//
/**
 * ui-custom S3.2 — the Firm tab, run for real in jsdom, three frames deep as
 * in the app:
 *   top     the shell's own launcher (public/js/featureRegistry.js + the
 *           ycLauncher block cut out of public/index.html, surfaces mounted),
 *           window.firmData, and apiSend backed by an in-memory server that
 *           validates with the REAL lib/uiConfigShape (strict mode) — or
 *           stores whatever it is sent (lenient mode, for round-trip checks
 *           of fields today's validator would refuse).
 *   middle  public/caseConfigManager.html's own script (the Config shell).
 *   inner   public/caseconfig/firm.html's own script, written into the
 *           shell's #subpage-firm iframe.
 *
 * Locks: the Firm tab hidden unless can_edit_firm (and when the fetch fails);
 * the bridge getters; the form grouped like All (ycLauncher's own grouping,
 * and the shell's group record left as it was); untouched form = not dirty,
 * key-order-insensitively; round-trip of locked / unknown fields / items it
 * can't edit; save → firmData.ui + applyAccess (hide, rename, firm item live
 * in the shell without a reload); stable ids; 403 session message; the
 * server's errors[] inline; client checks block a save; history view +
 * restore; the icon class only from a valid slug; the dirty guards.
 *
 * Mutation-checked (see the S3.2 worker report).
 *
 * Run:  npx jest tests/firmTab.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { rawShellHtml } = require('./helpers/shellHtml');
const shape = require('../lib/uiConfigShape');
const entSvc = require('../services/entitlementService');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
// the shell's icon picker (ui-custom S6a) and its catalog, served by a fetch stub on the top window
const PICKER_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIconPicker.js'), 'utf8');
const CATALOG = fs.readFileSync(path.join(ROOT, 'public', PICKER_SRC.match(/var CATALOG_URL = '([^']+)';/)[1]), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DENIED_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const CCM_HTML = fs.readFileSync(path.join(ROOT, 'public/caseConfigManager.html'), 'utf8');
const FIRM_HTML = fs.readFileSync(path.join(ROOT, 'public/caseconfig/firm.html'), 'utf8');
// External scripts / sheets (CDN, themeSync) are not loaded in jsdom anyway; drop them.
const strip = (html) => html.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── the in-memory server ─────────────────────────────────────────────────
function makeBackend({ doc = null, canEdit = true, lenient = false, getFails = null, failWith = {}, toolTitle = 'Appt Form', denies = [] } = {}) {
  const st = { doc: doc ? clone(doc) : null, versions: [], nextId: 1, calls: [], denies: clone(denies), nextDeny: 100 };
  if (st.doc) st.versions.push({ id: st.nextId++, config: clone(st.doc), saved_by: 1, saved_by_name: 'Alex', saved_at: '2026-10-14T10:00:00Z' });
  const err = (status, message, errors) => {
    const e = new Error(message); e.name = 'ApiError'; e.status = status; e.body = { status: 'error', message, ...(errors ? { errors } : {}) }; return e;
  };
  // The firm row's newest version id (null: no row) — what GET hands out as
  // firm_versions and what a write's base must equal (uiConfigService.write).
  const head = () => (st.doc && st.versions.length ? st.versions[st.versions.length - 1].id : null);
  function write(config, base) {
    if (base !== undefined && base !== head()) throw err(409, 'The firm launcher was changed since you loaded it');
    let value = config;
    if (!lenient) {
      const r = shape.validateWrite({ scope: 'firm', config_key: 'registry_overrides', config });
      if (!r.ok) throw err(400, r.errors[0], r.errors);
      value = r.value.config;
    }
    if (st.doc && shape.canonical(st.doc) === shape.canonical(value)) return { changed: false, versioned: false, config: value, version_id: head() };
    st.doc = clone(value);
    st.versions.push({ id: st.nextId++, config: clone(value), saved_by: 1, saved_by_name: 'Alex', saved_at: '2026-10-15T10:00:00Z' });
    return { changed: true, versioned: true, config: value, version_id: head() };
  }
  st.otherAdminSaves = (config) => write(config);      // another session's save, behind this page's back
  async function api(endpoint, method = 'GET', payload = null) {
    payload = payload == null ? null : clone(payload);   // over the wire it is JSON (and out of the page's realm)
    st.calls.push({ endpoint, method, payload: payload == null ? null : clone(payload) });
    const key = `${method} ${endpoint.split('?')[0]}`;
    if (failWith[key]) throw err(failWith[key], failWith[key] === 403 ? 'Forbidden' : 'boom');
    if (key === 'GET /api/ui-config') {
      if (getFails) throw getFails;
      return { status: 'success', firm: st.doc ? { registry_overrides: clone(st.doc) } : {}, user: {}, can_edit_firm: canEdit,
        ...(canEdit ? { firm_versions: { registry_overrides: head() } } : {}) };
    }
    if (key === 'GET /api/ui-config/pickers') {
      return { status: 'success', tools: [{ key: 'appt-form', title: toolTitle }], views: [{ key: 'lead_followups', title: 'Leads' }] };
    }
    if (key === 'PUT /api/ui-config') {
      return { status: 'success', scope: 'firm', config_key: 'registry_overrides',
        ...write(payload.config, Object.prototype.hasOwnProperty.call(payload, 'base') ? payload.base : undefined) };
    }
    if (key === 'GET /api/ui-config/versions') {
      return { status: 'success', versions: st.versions.slice().reverse().map((v) => ({ id: v.id, saved_by: v.saved_by,
        saved_by_name: v.saved_by_name, saved_at: v.saved_at, size: 9, is_current: shape.canonical(v.config) === shape.canonical(st.doc) })) };
    }
    // /api/entitlements (S3.4: the Who sees what section's per-user hides),
    // validated by the REAL services/entitlementService.normalizeDeny.
    if (key === 'GET /api/entitlements') return { status: 'success', denies: clone(st.denies), undeniable: ['moreSettings', 'helpSupport'] };
    if (key === 'POST /api/entitlements') {
      let d;
      try { d = entSvc.normalizeDeny(payload); } catch (e) { throw err(e.status || 400, e.message); }
      if (st.denies.some((x) => x.scope === d.scope && x.scope_ref === d.scope_ref && x.item_key === d.item_key)) throw err(409, 'that deny already exists');
      const row = { id: st.nextDeny++, ...d, created_by: 1, created_at: '2026-10-16T10:00:00Z' };
      st.denies.push(row);
      return { status: 'success', deny: { id: row.id, ...d } };
    }
    let m;
    if ((m = /^DELETE \/api\/entitlements\/(\d+)$/.exec(key))) {
      const n = Number(m[1]);
      if (!st.denies.some((x) => x.id === n)) throw err(404, 'deny not found');
      st.denies = st.denies.filter((x) => x.id !== n);
      return { status: 'success', id: n };
    }
    if ((m = /^GET \/api\/ui-config\/versions\/(\d+)$/.exec(key))) {
      const v = st.versions.find((x) => x.id === Number(m[1]));
      if (!v) throw err(404, 'Version not found');
      return { status: 'success', version: { id: v.id, config_key: 'registry_overrides', config: clone(v.config), saved_by: 1, saved_by_name: 'Alex', saved_at: v.saved_at } };
    }
    if ((m = /^POST \/api\/ui-config\/versions\/(\d+)\/restore$/.exec(key))) {
      const v = st.versions.find((x) => x.id === Number(m[1]));
      if (!v) throw err(404, 'Version not found');
      const base = payload && Object.prototype.hasOwnProperty.call(payload, 'base') ? payload.base : undefined;
      return { status: 'success', scope: 'firm', config_key: 'registry_overrides', ...write(clone(v.config), base), restored_from: v.id };
    }
    throw new Error('unscripted ' + key);
  }
  return { api, st };
}

// ── the three frames ─────────────────────────────────────────────────────
function makeTop(backend, shellDoc, users) {
  const page = `<!DOCTYPE html><html><head>${DENIED_CSS}<script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script>${RENDERER_SRC}</script></head><body>
    <nav id="appSidebar"><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><script>ycLauncher.mount('home')</script></div>
    <div id="tabMore" class="tab-main"><script>ycLauncher.mount('more')</script></div>
    <div id="tabAdmin" class="tab-main"><script>ycLauncher.mount('admin')</script></div>
  </body></html>`;
  // Frames log into one quiet virtual console; warnings are kept for asserts.
  const vc = new VirtualConsole();
  const logs = [];
  ['warn', 'error'].forEach((k) => vc.on(k, (...a) => logs.push(k + ': ' + a.join(' '))));
  const dom = new JSDOM(page, { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.__logs = logs;
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(CATALOG)) });
  w.eval(PICKER_SRC);
  w.firmData = { ui: { firm: shellDoc ? { registry_overrides: clone(shellDoc) } : {}, user: {} } };
  if (users) w.firmData.users = clone(users);
  w.apiSend = backend.api;
  w.ycLauncher.applyAccess({ isAdmin: true, denied: [], ui: w.firmData.ui });
  return w;
}
function writeFrame(iframe, html) {
  const d = iframe.contentWindow.document;
  d.open(); d.write(strip(html)); d.close();
  return iframe.contentWindow;
}
async function makeConfigShell(top) {
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  const mid = writeFrame(f, CCM_HTML);
  await flush();
  return mid;
}
/** Everything: the shell, the Config shell, the Firm page booted on its tab. */
async function boot(opts = {}) {
  const backend = makeBackend(opts);
  const top = makeTop(backend, opts.shellDoc === undefined ? opts.doc : opts.shellDoc, opts.users);
  const mid = await makeConfigShell(top);
  mid.switchSubPage('firm');
  const firm = writeFrame(mid.document.getElementById('subpage-firm'), FIRM_HTML);
  await flush();
  const F = firm.FirmPage;
  const $ = (sel) => firm.document.querySelector(sel);
  const $$ = (sel) => [...firm.document.querySelectorAll(sel)];
  const fire = (el, type) => el.dispatchEvent(new firm.Event(type, { bubbles: true }));
  const setVal = (el, v) => { el.value = v; fire(el, el.tagName === 'SELECT' ? 'change' : 'input'); };
  const tick = (id, on) => { const c = $(`[data-hide="${id}"]`); c.checked = on; fire(c, 'change'); };
  const saveBtnShown = () => mid.document.getElementById('btn-save').style.display !== 'none';
  return { backend, top, mid, firm, F, $, $$, fire, setVal, tick, saveBtnShown, L: top.ycLauncher };
}
const puts = (b) => b.st.calls.filter((c) => c.method === 'PUT');

const SHELL_ITEM = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://p.example.com', present: 'window' } };

// ─────────────────────────────────────────────────────────────────────────
describe('Config shell: the Firm tab is shown only on can_edit_firm', () => {
  test('flag false → hidden, and switchSubPage refuses it; the other tabs are untouched', async () => {
    const backend = makeBackend({ canEdit: false });
    const mid = await makeConfigShell(makeTop(backend));
    const btn = mid.document.getElementById('tabnav-firm');
    expect(btn.hidden).toBe(true);
    mid.switchSubPage('firm');
    expect(mid.document.getElementById('subpage-panel-firm').classList.contains('active')).toBe(false);
    expect(mid.document.getElementById('tabnav-types').classList.contains('active')).toBe(true);
    expect([...mid.document.querySelectorAll('.tab-nav-btn')].filter((b) => !b.hidden).map((b) => b.id))
      .toEqual(['tabnav-types', 'tabnav-pipelines', 'tabnav-fields', 'tabnav-caltypes']);
    expect(backend.st.calls.map((c) => c.endpoint)).toEqual(['/api/ui-config']);
  });

  test('fetch fails → hidden; nothing else breaks', async () => {
    const backend = makeBackend({ getFails: Object.assign(new Error('offline'), { status: 500 }) });
    const top = makeTop(backend);
    const mid = await makeConfigShell(top);
    expect(mid.document.getElementById('tabnav-firm').hidden).toBe(true);
    expect(top.__logs.join('\n')).toMatch(/Firm tab stays hidden/);
    expect(mid.document.getElementById('subpage-panel-types').classList.contains('active')).toBe(true);
  });

  test('a truthy-but-not-true flag does not reveal it', async () => {
    const backend = makeBackend();
    const orig = backend.api;
    backend.api = async (...a) => ({ ...(await orig(...a)), can_edit_firm: 'true' });
    const mid = await makeConfigShell(makeTop(backend));
    expect(mid.document.getElementById('tabnav-firm').hidden).toBe(true);
  });

  test('flag true → shown; the bridge exposes the shell launcher live', async () => {
    const { mid, top } = await boot();
    expect(mid.document.getElementById('tabnav-firm').hidden).toBe(false);
    expect(mid.document.getElementById('subpage-panel-firm').classList.contains('active')).toBe(true);
    expect(mid.ycLauncher).toBe(top.ycLauncher);
    expect(mid.FEATURE_REGISTRY).toBe(top.FEATURE_REGISTRY);
    expect(mid.DEFAULT_LAYOUTS).toBe(top.DEFAULT_LAYOUTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('Launcher form: grouping and catalog', () => {
  test('grouped like All, from ycLauncher\'s own grouping; every item once, every one renameable; undeniables locked on; no custom tab row', async () => {
    const { $$, L, top } = await boot({ doc: { hidden: [], locked: [], renames: {}, items: [SHELL_ITEM] } });
    const titles = $$('#fm-sec-launcher .fm-group-title').map((e) => e.textContent);   // S3.4: the Launcher section's (Who sees what has its own)
    const groupsBefore = L.groups();
    expect(groupsBefore).toContain('Firm');                  // the shell has a firm item
    expect(titles).toEqual(groupsBefore.filter((g) => g !== 'Firm' && g !== 'Home'));
    expect(titles).toEqual(['Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);   // More actions: S6b
    // computeEffective's group record was left exactly as the shell's
    expect(L.groups()).toEqual(groupsBefore);
    const rowIds = $$('[data-row-id]').map((e) => e.dataset.rowId);
    const all = Object.keys(top.FEATURE_REGISTRY).filter((id) => !top.FEATURE_REGISTRY[id].placeholder);
    expect(rowIds.slice().sort()).toEqual(all.sort());
    for (const id of ['moreSettings', 'helpSupport']) {
      const c = $$(`[data-hide="${id}"]`)[0];
      expect([id, c.disabled, c.checked]).toEqual([id, true, false]);
    }
    // the custom tab is retired (ui-custom S5e): no row; every row has its rename box
    expect($$('[data-row-id="custom"]')).toEqual([]);
    expect($$('[data-rename]').map((e) => e.dataset.rename).sort()).toEqual(all.slice().sort());
    expect($$('[data-row-id^="firm:"]')).toEqual([]);           // firm items are edited below, not here
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('dirty tracking + round-trip', () => {
  test('an untouched form is not dirty even when the stored keys come back re-ordered; Save stays hidden', async () => {
    const reordered = { items: [{ action: { present: 'window', href: 'https://p.example.com', type: 'url' }, icon: 'money-check', label: 'Payroll', id: 'firm:payroll' }],
      // MySQL stores object keys shortest-first, so renames come back {log, cases} — not
      // the form's display order (cases is listed before log).
      renames: { log: { label: 'Journal' }, cases: { label: 'Matters' } }, locked: ['cases'], hidden: ['bills', 'log'] };
    const { F, saveBtnShown, tick, mid } = await boot({ doc: reordered });
    expect(F.LauncherSection.isDirty()).toBe(false);
    expect(saveBtnShown()).toBe(false);
    tick('tasks', true);
    expect(F.LauncherSection.isDirty()).toBe(true);
    expect(saveBtnShown()).toBe(true);
    expect(mid.document.querySelector('.tab-nav-btn.active').id).toBe('tabnav-firm');
    tick('tasks', false);
    tick('bills', false); tick('bills', true);            // un-tick, re-tick: stored order kept
    expect(F.LauncherSection.isDirty()).toBe(false);
    expect(saveBtnShown()).toBe(false);
  });

  test('client canonical() == server canonical()', async () => {
    const { F } = await boot();
    const docs = [{ b: 1, a: [{ z: 1, y: { q: 2, p: [3, { k: 'v', j: null }] } }] }, [], {}, 'x', null, { hidden: ['a', 'b'], items: [] }];
    for (const d of docs) expect(F.canonical(d)).toBe(shape.canonical(d));
    expect(F.canonical({ a: 1, b: 2 })).toBe(F.canonical({ b: 2, a: 1 }));
    expect(F.canonical(['a', 'b'])).not.toBe(F.canonical(['b', 'a']));
  });

  test('a save carries everything the form did not show: locked, unknown keys, foreign ids, item extras, items it cannot edit', async () => {
    const stored = {
      hidden: ['retiredItem', 'bills', 'firm:payroll'], locked: ['cases', 'firm:payroll'],
      renames: { custom: { label: 'Mine' }, 'firm:payroll': { label: 'P' }, retiredItem: { label: 'Old' }, cases: { label: 'Matters', tone: 'x' } },
      items: [{ ...SHELL_ITEM, note: 'kept' }, { id: 'firm:clio', label: 'Clio code', icon: 'c', action: { type: 'action', fetch: '/clio-code', present: 'modal' } }],
      futureKey: { a: 1 },
    };
    const { F, tick, mid, backend, setVal, $ } = await boot({ doc: stored, lenient: true });
    expect(F.LauncherSection.isDirty()).toBe(false);
    expect($('.fm-kept').textContent).toMatch(/can't change/);
    tick('log', true);
    setVal($('[data-rename="moreReports"]'), 'Numbers');
    await mid.onTopbarSave();
    await flush();
    const sent = puts(backend)[0].payload.config;
    const want = { ...clone(stored), hidden: ['retiredItem', 'bills', 'firm:payroll', 'log'],
      renames: { ...clone(stored.renames), moreReports: { label: 'Numbers' } } };
    expect(shape.canonical(sent)).toBe(shape.canonical(want));
    expect(F.LauncherSection.isDirty()).toBe(false);
  });

  test('clearing a rename drops it; a rename keeps the stored entry\'s other fields', async () => {
    const { F, setVal, $ } = await boot({ doc: { hidden: [], locked: [], renames: { cases: { label: 'Matters' } }, items: [] }, lenient: true });
    setVal($('[data-rename="cases"]'), '  ');
    expect(F.LauncherSection.doc().renames).toEqual({});
    setVal($('[data-rename="cases"]'), ' Files ');
    expect(F.LauncherSection.doc().renames).toEqual({ cases: { label: 'Files' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('save → the shell launcher follows at once (no reload)', () => {
  test('hide, rename and a new link item: firmData.ui updated, applyAccess re-run on every surface', async () => {
    const { F, top, L, mid, backend, tick, setVal, $, $$, fire } = await boot();
    const sbBills = L.elementsOf('bills').sidebar;
    expect(sbBills.hasAttribute('data-yc-denied')).toBe(false);
    tick('bills', true);
    setVal($('[data-rename="cases"]'), 'Matters');
    fire($('[data-act="add-item"]'), 'click');
    setVal($('#fi0-label'), 'Payroll');
    setVal($('#fi0-icon'), 'money-check');
    setVal($('#fi0-href'), 'https://p.example.com/x');
    expect($('#fi0-label').closest('.fm-item').querySelector('[data-id-line]').textContent).toMatch(/firm:payroll/);
    await mid.onTopbarSave();
    await flush();
    expect(puts(backend)).toHaveLength(1);
    const saved = backend.st.doc;
    expect(saved.items[0]).toEqual({ id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://p.example.com/x', present: 'window' } });
    expect(top.firmData.ui.firm.registry_overrides).toEqual(saved);
    expect(sbBills.hasAttribute('data-yc-denied')).toBe(true);
    expect(L.elementsOf('bills').home.hasAttribute('data-yc-denied')).toBe(true);
    expect(L.elementsOf('cases').sidebar.textContent).toMatch(/Matters/);
    expect(L.elementsOf('cases').home.textContent).toMatch(/Matters/);
    const eff = L.effectiveRegistry();
    expect(eff.find((e) => e.id === 'bills')).toBeUndefined();
    expect(eff.find((e) => e.id === 'firm:payroll')).toMatchObject({ group: 'Firm', label: 'Payroll' });
    expect(F.LauncherSection.isDirty()).toBe(false);
    expect($$('.fm-err').map((e) => e.textContent).join('')).toBe('');
  });

  test('tool and view items save with modal present and land in the shell\'s registry', async () => {
    const { L, mid, backend, setVal, $, fire } = await boot();
    for (const [i, type, key, label] of [[0, 'tool', 'appt-form', 'Appointments form'], [1, 'view', 'lead_followups', 'Follow ups']]) {
      fire($('[data-act="add-item"]'), 'click');
      setVal($(`#fi${i}-label`), label);
      setVal($(`#fi${i}-type`), type);
      setVal($(`#fi${i}-key`), key);
    }
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.doc.items.map((it) => [it.id, it.action])).toEqual([
      ['firm:appointments-form', { type: 'tool', key: 'appt-form', present: 'modal' }],
      ['firm:follow-ups', { type: 'view', key: 'lead_followups', present: 'modal' }]]);
    expect(L.effectiveRegistry().filter((e) => e.group === 'Firm').map((e) => e.id)).toEqual(['firm:appointments-form', 'firm:follow-ups']);
  });

  test('ids are stable: a saved item keeps its id across a label change; a new one never takes a used id', async () => {
    const { F, mid, backend, setVal, $, fire } = await boot({ doc: { hidden: [], locked: [], renames: {}, items: [SHELL_ITEM] } });
    setVal($('#fi0-label'), 'Payroll v2');
    expect(F.LauncherSection.st.form.items[0].id).toBe('firm:payroll');
    fire($('[data-act="add-item"]'), 'click');
    setVal($('#fi1-label'), 'Payroll');
    setVal($('#fi1-href'), '/reports');
    expect(F.LauncherSection.st.form.items[1].id).toBe('firm:payroll-2');
    setVal($('#fi1-label'), 'Payroll Archive');          // unsaved: follows the label
    expect(F.LauncherSection.st.form.items[1].id).toBe('firm:payroll-archive');
    // deleting the saved item does not free its id for the new one
    fire($('#fi0-label').closest('.fm-item').querySelector('[data-act="del"]'), 'click');
    setVal($('#fi0-label'), 'Payroll');
    expect(F.LauncherSection.st.form.items[0].id).toBe('firm:payroll-2');
    setVal($('#fi0-label'), 'Payroll Archive');
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.doc.items.map((i) => i.id)).toEqual(['firm:payroll-archive']);
    setVal($('#fi0-label'), 'Something else');            // saved now: frozen
    expect(F.LauncherSection.st.form.items[0].id).toBe('firm:payroll-archive');
  });

  test('move up / down and delete reorder the saved items', async () => {
    const items = ['a', 'b', 'c'].map((x) => ({ ...SHELL_ITEM, id: 'firm:' + x, label: x.toUpperCase() }));
    const { F, $$, fire } = await boot({ doc: { hidden: [], locked: [], renames: {}, items } });
    fire($$('.fm-item')[2].querySelector('[data-act="up"]'), 'click');
    expect(F.LauncherSection.doc().items.map((i) => i.id)).toEqual(['firm:a', 'firm:c', 'firm:b']);
    fire($$('.fm-item')[0].querySelector('[data-act="down"]'), 'click');
    fire($$('.fm-item')[0].querySelector('[data-act="del"]'), 'click');
    expect(F.LauncherSection.doc().items.map((i) => i.id)).toEqual(['firm:a', 'firm:b']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('errors', () => {
  test('a 403 on save shows the session message, never a generic error', async () => {
    const { F, mid, tick, $ } = await boot({ failWith: { 'PUT /api/ui-config': 403 } });
    tick('bills', true);
    await mid.onTopbarSave();
    await flush();
    expect($('#fm-banner').hidden).toBe(false);
    expect($('#fm-banner').textContent).toBe('Your session predates a permissions change — sign out and back in.');
    expect(F.SESSION_MSG).toBe($('#fm-banner').textContent);
    expect(F.LauncherSection.isDirty()).toBe(true);             // nothing lost
  });

  test('a 403 on load says the same', async () => {
    const { $ } = await boot({ failWith: { 'GET /api/ui-config': 403 } });
    expect($('.empty-state').textContent).toMatch(/session predates a permissions change/);
  });

  test('the server\'s errors[] land on their field', async () => {
    const { mid, backend, setVal, $, fire } = await boot();
    fire($('[data-act="add-item"]'), 'click');
    setVal($('#fi0-label'), 'Tool page');
    setVal($('#fi0-href'), '/tool/appt-form');               // passes the cheap client check; the server refuses it
    await mid.onTopbarSave();
    await flush();
    expect(puts(backend)).toHaveLength(1);
    expect(backend.st.doc).toBe(null);
    expect($('[data-err-row="0"]').textContent).toMatch(/shell-only page/);
    expect($('#fm-banner').textContent).toMatch(/^Launcher: the server refused the save/);
    setVal($('#fi0-href'), '/reports');                      // editing the row clears its server error
    expect($('[data-err-row="0"]').textContent).toBe('');
  });

  test('client checks give instant feedback and block the save', async () => {
    const { mid, backend, setVal, $, fire } = await boot();
    fire($('[data-act="add-item"]'), 'click');
    expect($('[data-err-row="0"]').textContent).toMatch(/label is required/);
    setVal($('#fi0-label'), 'X');
    setVal($('#fi0-href'), 'http://insecure.example.com');
    expect($('[data-err-row="0"]').textContent).toMatch(/https:\/\//);
    setVal($('#fi0-href'), '//evil.example.com');
    expect($('[data-err-row="0"]').textContent).toMatch(/https:\/\//);
    setVal($('[data-rename="cases"]'), 'x'.repeat(41));
    expect($('[data-err-rename="cases"]').textContent).toMatch(/40/);
    await mid.onTopbarSave();
    await flush();
    expect(puts(backend)).toHaveLength(0);
    expect($('#fm-banner').textContent).toMatch(/fix the 2 highlighted fields/);
  });

  test('the icon class is built only from a slug that passes the regex; DB text is never markup', async () => {
    const evil = { ...SHELL_ITEM, label: '"><img src=x id=pwn>' };
    const kept = { id: 'firm:k', label: '"><i id=pwn3></i>', icon: 'x', action: { type: 'action', fetch: '/x' } };
    const { $, setVal, firm } = await boot({ doc: { hidden: [], locked: [], renames: { cases: { label: '"><b id=pwn2>' } }, items: [evil, kept] },
      lenient: true, toolTitle: '</option><b id=pwn4>' });
    setVal($('#fi0-type'), 'tool');
    for (const id of ['pwn', 'pwn2', 'pwn3', 'pwn4']) expect([id, firm.document.getElementById(id)]).toEqual([id, null]);
    expect([...$('#fi0-key').options].map((o) => o.textContent)).toContain('</option><b id=pwn4>');
    setVal($('#fi0-type'), 'url');
    expect($('#fi0-label').value).toBe('"><img src=x id=pwn>');
    expect($('[data-rename="cases"]').value).toBe('"><b id=pwn2>');
    expect($('.fm-kept b').textContent).toBe('"><i id=pwn3></i>');
    const prev = () => $('#fi0-icon').closest('.fm-icon-in').querySelector('i');
    setVal($('#fi0-icon'), 'bad" onmouseover="x');
    expect(prev().className).toBe('fa-solid fa-circle-question bad');
    setVal($('#fi0-icon'), 'Bad-Caps');
    expect(prev().className).toBe('fa-solid fa-circle-question bad');
    setVal($('#fi0-icon'), 'calendar');
    expect(prev().className).toBe('fa-solid fa-calendar');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('history', () => {
  test('lists versions, views one read-only, restores an older one → form + shell follow', async () => {
    const { mid, backend, tick, $, $$, fire, firm, top, L, F } = await boot({ doc: { hidden: ['bills'], locked: [], renames: {}, items: [] } });
    tick('bills', false); tick('log', true);
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.versions).toHaveLength(2);
    expect(L.elementsOf('bills').sidebar.hasAttribute('data-yc-denied')).toBe(false);
    fire($('[data-act="history"]'), 'click');
    await flush();
    const rows = $$('.fm-ver');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.fm-badge').textContent).toBe('current');
    expect(rows[0].querySelector('[data-ver-act="restore"]')).toBe(null);
    fire(rows[1].querySelector('[data-ver-act="view"]'), 'click');
    await flush();
    expect(rows[1].querySelector('.fm-ver-view').textContent).toMatch(/Hidden\s*Bills/);
    firm.confirm = () => true;
    fire(rows[1].querySelector('[data-ver-act="restore"]'), 'click');
    await flush();
    expect(backend.st.calls.some((c) => c.method === 'POST' && /\/versions\/1\/restore$/.test(c.endpoint))).toBe(true);
    expect(backend.st.versions).toHaveLength(3);
    expect($('[data-hide="bills"]').checked).toBe(true);
    expect($('[data-hide="log"]').checked).toBe(false);
    expect(top.firmData.ui.firm.registry_overrides.hidden).toEqual(['bills']);
    expect(L.elementsOf('bills').sidebar.hasAttribute('data-yc-denied')).toBe(true);
    expect(L.elementsOf('log').sidebar.hasAttribute('data-yc-denied')).toBe(false);
    expect(F.LauncherSection.isDirty()).toBe(false);
  });

  test('a declined confirm restores nothing', async () => {
    const { backend, $, $$, fire, firm } = await boot({ doc: { hidden: ['bills'], locked: [], renames: {}, items: [] } });
    backend.st.versions.push({ id: 9, config: { hidden: [], locked: [], renames: {}, items: [] }, saved_by: 1, saved_by_name: 'A', saved_at: 'T' });
    fire($('[data-act="history"]'), 'click');
    await flush();
    firm.confirm = () => false;
    fire($$('.fm-ver')[0].querySelector('[data-ver-act="restore"]'), 'click');
    await flush();
    expect(backend.st.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the dirty guards', () => {
  test('Refresh asks before discarding; tab return never reloads over edits; a page unload is held', async () => {
    const { firm, mid, backend, tick, F } = await boot();
    const gets = () => backend.st.calls.filter((c) => c.endpoint === '/api/ui-config' && c.method === 'GET').length;
    tick('bills', true);
    const n = gets();
    let asked = 0;
    firm.confirm = () => { asked++; return false; };
    mid.onTopbarRefresh();
    await flush();
    expect([asked, gets(), F.LauncherSection.isDirty()]).toEqual([1, n, true]);
    mid.switchSubPage('types'); mid.switchSubPage('firm');
    await flush();
    expect([gets(), F.LauncherSection.isDirty()]).toEqual([n, true]);
    const ev = new firm.Event('beforeunload', { cancelable: true });
    firm.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    firm.confirm = () => { asked++; return true; };
    mid.onTopbarRefresh();
    await flush();
    expect([asked, gets() > n, F.LauncherSection.isDirty()]).toEqual([2, true, false]);
    const ev2 = new firm.Event('beforeunload', { cancelable: true });
    firm.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix round (review SF1 / SF2 / SF3)
describe('fix round: optimistic concurrency (SF1)', () => {
  const CONFLICT = 'Another admin saved changes since you opened this — reload to see them; your edits are kept until you reload';

  test('a save behind another admin\'s → the conflict message; nothing merged or overwritten; edits kept; reload then save works', async () => {
    const { F, mid, backend, tick, $, firm, saveBtnShown } = await boot({ doc: { hidden: ['bills'], locked: [], renames: {}, items: [] } });
    const loadedBase = backend.st.versions[0].id;
    expect(F.LauncherSection.st.base).toBe(loadedBase);
    backend.st.otherAdminSaves({ hidden: ['bills', 'log'], locked: [], renames: {}, items: [] });
    tick('tasks', true);
    await mid.onTopbarSave();
    await flush();
    const put = puts(backend)[0];
    expect(put.payload.base).toBe(loadedBase);
    expect($('#fm-banner').textContent).toBe(CONFLICT);
    expect(F.CONFLICT_MSG).toBe(CONFLICT);
    expect(backend.st.doc.hidden).toEqual(['bills', 'log']);           // the other admin's save stands
    expect(backend.st.versions).toHaveLength(2);
    expect([F.LauncherSection.isDirty(), $('[data-hide="tasks"]').checked, saveBtnShown()]).toEqual([true, true, true]);
    // reload (Refresh asks first, edits discarded on yes) → the new base → the save goes through
    firm.confirm = () => true;
    mid.onTopbarRefresh();
    await flush();
    expect([F.LauncherSection.st.base, $('[data-hide="log"]').checked, $('[data-hide="tasks"]').checked]).toEqual([2, true, false]);
    tick('tasks', true);
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.doc.hidden).toEqual(['bills', 'log', 'tasks']);
    expect(F.LauncherSection.st.base).toBe(3);                        // follows the save's version_id
    tick('appts', true);                                               // and a second save from the same page works
    await mid.onTopbarSave();
    await flush();
    expect([backend.st.versions.length, $('#fm-banner').hidden]).toEqual([4, true]);
  });

  test('no firm row yet: base null is sent; someone else creating the row first → conflict', async () => {
    const { F, mid, backend, tick, $ } = await boot();
    expect(F.LauncherSection.st.base).toBe(null);
    backend.st.otherAdminSaves({ hidden: ['log'], locked: [], renames: {}, items: [] });
    tick('bills', true);
    await mid.onTopbarSave();
    await flush();
    expect(puts(backend)[0].payload).toHaveProperty('base', null);
    expect($('#fm-banner').textContent).toBe(CONFLICT);
    expect(backend.st.doc.hidden).toEqual(['log']);
  });

  test('restore carries the base: behind another admin\'s save → the conflict message, nothing restored', async () => {
    const { backend, $, $$, fire, firm, F } = await boot({ doc: { hidden: ['bills'], locked: [], renames: {}, items: [] } });
    backend.st.otherAdminSaves({ hidden: [], locked: [], renames: {}, items: [] });
    fire($('[data-act="history"]'), 'click');
    await flush();
    firm.confirm = () => true;
    // the list now shows 2 versions; restore the older one (v1)
    const row = $$('.fm-ver').find((r) => r.dataset.ver === '1');
    fire(row.querySelector('[data-ver-act="restore"]'), 'click');
    await flush();
    const post = backend.st.calls.find((c) => c.method === 'POST');
    expect(post.payload).toEqual({ base: 1 });
    expect($('#fm-banner').textContent).toBe(CONFLICT);
    expect([backend.st.versions.length, backend.st.doc.hidden]).toEqual([2, []]);
    expect(F.LauncherSection.st.base).toBe(1);                        // unchanged: still the loaded one
  });
});

describe('fix round: a firm id still referenced in the stored document is never reused (SF2)', () => {
  test('delete Payroll, save, reload, add "Payroll" → firm:payroll-2 while firm:payroll is still referenced', async () => {
    const SHELL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://p.example.com', present: 'window' } };
    const { F, mid, backend, setVal, $, fire, firm } = await boot({ doc: { hidden: [], locked: ['firm:payroll'], renames: {}, items: [SHELL] } });
    fire($('#fi0-label').closest('.fm-item').querySelector('[data-act="del"]'), 'click');
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.doc).toEqual({ hidden: [], locked: ['firm:payroll'], renames: {}, items: [] });
    firm.confirm = () => true;
    mid.onTopbarRefresh();                                              // reload: a fresh page state
    await flush();
    fire($('[data-act="add-item"]'), 'click');
    setVal($('#fi0-label'), 'Payroll');
    expect(F.LauncherSection.st.form.items[0].id).toBe('firm:payroll-2');
  });

  test('every place an id can sit counts: hidden, locked, renames keys, nested round-tripped fields', async () => {
    const { F } = await boot();
    const ids = F.firmIdsIn({ hidden: ['firm:a', 'bills'], locked: ['firm:b'], renames: { 'firm:c': { label: 'x' } },
      items: [{ id: 'firm:d', action: { type: 'action', target: 'firm:e' } }], futureKey: { deep: [{ 'firm:f': 1 }] }, note: 'firm:NOT-AN-ID' }, new Set());
    expect([...ids].sort()).toEqual(['firm:a', 'firm:b', 'firm:c', 'firm:d', 'firm:e', 'firm:f']);
    const st = { stored: { hidden: ['firm:payroll'], locked: [], renames: {}, items: [] }, form: { items: [] } };
    const row = { saved: false, id: '' };
    st.form.items.push(row);
    F.relabelRow(st.stored, st.form, row, 'Payroll');
    expect(row.id).toBe('firm:payroll-2');
  });

  test('ui-custom S4a: the server\'s retired list counts too — a deleted item\'s id is never offered again', async () => {
    const { F } = await boot();
    const st = { stored: { hidden: [], locked: [], renames: {}, items: [], retired: ['firm:payroll', 'firm:payroll-2'] }, form: { items: [] } };
    const row = { saved: false, id: '' };
    st.form.items.push(row);
    F.relabelRow(st.stored, st.form, row, 'Payroll');
    expect(row.id).toBe('firm:payroll-3');
  });
});

describe('fix round: History renders DB text as text (SF3)', () => {
  test('markup in saved_by_name and inside a viewed version creates no element', async () => {
    const { backend, $, $$, fire, firm } = await boot({ doc: { hidden: [], locked: [], renames: {}, items: [] }, lenient: true });
    backend.st.versions[0].saved_by_name = '<img src=x id=xw1>"><b id=xw2>';
    backend.st.versions.unshift({ id: 0, saved_by: 2, saved_by_name: '<svg id=xw3 onload=1>', saved_at: '<i id=xw4>',
      config: { hidden: ['<b id=xw5>'], locked: ['<u id=xw6>'], renames: { cases: { label: '<i id=xw7>' } },
        items: [{ id: 'firm:x', label: '<img id=xw8 src=x>', icon: 'x', action: { type: 'url', href: 'https://e.example/"><b id=xw9>', present: 'window' } }] } });
    fire($('[data-act="history"]'), 'click');
    await flush();
    const rows = $$('.fm-ver');
    expect(rows).toHaveLength(2);
    for (const r of rows) fire(r.querySelector('[data-ver-act="view"]'), 'click');
    await flush();
    const bad = [...firm.document.querySelectorAll('[id^="xw"]')].map((e) => e.id);
    expect(bad).toEqual([]);
    const text = $('#fm-history').textContent;
    for (const s of ['<img src=x id=xw1>"><b id=xw2>', '<svg id=xw3 onload=1>', '<b id=xw5>', '<u id=xw6>', '<i id=xw7>', '<img id=xw8 src=x>', '"><b id=xw9>']) {
      expect([s, text.includes(s)]).toEqual([s, true]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ui-custom S3.3: the tool dialog's size on a tool / view item.
describe('S3.3: the dialog size select', () => {
  const TOOL_ITEM = { id: 'firm:appt', label: 'Appointments', icon: 'calendar', action: { type: 'tool', key: 'appt-form', present: 'modal' } };
  const docWith = (...items) => ({ hidden: [], locked: [], renames: {}, items });

  test('offered on tool and view rows only; Large unless the item says compact', async () => {
    const { $, $$, setVal, fire } = await boot({ doc: docWith(SHELL_ITEM, TOOL_ITEM,
      { id: 'firm:leads', label: 'Leads', icon: 'list', action: { type: 'view', key: 'lead_followups', present: 'modal', size: 'compact' } }) });
    expect($$('[data-f="size"]').map((s) => [s.id, s.value])).toEqual([['fi1-size', 'large'], ['fi2-size', 'compact']]);
    expect($('#fi0-size')).toBeNull();
    fire($('[data-act="add-item"]'), 'click');
    expect($('#fi3-size')).toBeNull();                       // a new row starts as a link
    setVal($('#fi3-type'), 'tool');
    expect($('#fi3-size').value).toBe('large');
  });

  test('compact saves as size "compact", passes the real validator, and the shell opens the item compact', async () => {
    const { $, setVal, mid, backend, L, fire } = await boot();
    fire($('[data-act="add-item"]'), 'click');
    setVal($('#fi0-label'), 'Get Clio Code');
    setVal($('#fi0-icon'), 'c');
    setVal($('#fi0-type'), 'tool');
    setVal($('#fi0-key'), 'appt-form');
    setVal($('#fi0-size'), 'compact');
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.doc.items[0].action).toEqual({ type: 'tool', key: 'appt-form', present: 'modal', size: 'compact' });
    expect(L.effectiveRegistry().filter((e) => e.group === 'Firm').map((e) => e.id)).toEqual(['firm:get-clio-code']);
  });

  test('round-trip: an item saved before sizes existed stays size-less (not dirty, no size written); explicit large is kept', async () => {
    const stored = docWith(TOOL_ITEM, { ...TOOL_ITEM, id: 'firm:big', label: 'Big', action: { ...TOOL_ITEM.action, size: 'large' } });
    const { F, $, setVal, mid, backend, tick } = await boot({ doc: stored });
    expect(F.LauncherSection.isDirty()).toBe(false);
    tick('log', true);
    await mid.onTopbarSave();
    await flush();
    expect(puts(backend)[0].payload.config.items.map((i) => i.action)).toEqual([TOOL_ITEM.action, { ...TOOL_ITEM.action, size: 'large' }]);
    setVal($('#fi0-size'), 'compact');
    setVal($('#fi1-size'), 'compact');
    expect(F.LauncherSection.doc().items.map((i) => i.action.size)).toEqual(['compact', 'compact']);
    setVal($('#fi0-size'), 'large');
    setVal($('#fi1-size'), 'large');
    expect(F.LauncherSection.doc().items.map((i) => i.action)).toEqual([TOOL_ITEM.action, { ...TOOL_ITEM.action, size: 'large' }]);
    expect(F.LauncherSection.isDirty()).toBe(false);
  });

  test('a stored compact item → compact selected; switching it to large writes size "large"; switching tool → view keeps the size', async () => {
    const stored = docWith({ ...TOOL_ITEM, action: { ...TOOL_ITEM.action, size: 'compact' } });
    const { F, $, setVal } = await boot({ doc: stored });
    expect($('#fi0-size').value).toBe('compact');
    setVal($('#fi0-type'), 'view');
    setVal($('#fi0-key'), 'lead_followups');
    expect(F.LauncherSection.doc().items[0].action).toEqual({ type: 'view', key: 'lead_followups', present: 'modal', size: 'compact' });
    setVal($('#fi0-type'), 'tool');
    setVal($('#fi0-key'), 'appt-form');
    setVal($('#fi0-size'), 'large');
    expect(F.LauncherSection.doc().items[0].action).toEqual({ ...TOOL_ITEM.action, size: 'large' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ui-custom S3.4: the "Who sees what" section — the firm's visible_to (role
// scoping, saved with the page Save in the SAME document as the Launcher
// section) and per-user hides (entitlement_denies at scope user, written at
// once through /api/entitlements).
describe('S3.4: Who sees what', () => {
  const USERS = [
    { user: 0, user_name: 'Automations', user_type: 0, active: true },
    { user: 1, user_name: 'Stuart', user_type: 1, active: true },
    { user: 3, user_name: 'Rivka', user_type: 1, active: true },
    { user: 5, user_name: 'Rena', user_type: 1, active: true },
    { user: 9, user_name: 'Former', user_type: 1, active: false },
  ];
  const DOC = { hidden: [], locked: [], renames: {}, items: [SHELL_ITEM] };
  const whoRow = (firm, id) => [...firm.document.querySelectorAll('[data-who-id]')].find((r) => r.dataset.whoId === id);
  const mode = (t, id, v) => t.setVal(whoRow(t.firm, id).querySelector('[data-mode]'), v);
  const role = (t, id, r, on) => { const c = whoRow(t.firm, id).querySelector(`[data-role="${r}"]`); c.checked = on; t.fire(c, 'change'); };
  const chips = (t, id) => [...whoRow(t.firm, id).querySelectorAll('.fm-chip')].map((c) => c.firstChild.textContent);
  const errOf = (t, id) => whoRow(t.firm, id).querySelector('[data-err-who]').textContent;
  const save = async (t) => { await t.mid.onTopbarSave(); await flush(); };
  const ids = (list) => list.map((e) => e.id);

  test('the role vocabulary is the server\'s: STORE_ROLES == uiConfigShape VISIBLE_ROLES (ROLE_MEMBERS minus su), every one labelled', async () => {
    const { F } = await boot({ doc: DOC });
    expect(F.STORE_ROLES).toEqual(shape.VISIBLE_ROLES.slice());
    expect(Object.keys(F.ROLE_LABELS).sort()).toEqual(shape.VISIBLE_ROLES.slice().sort());
    expect(Object.values(F.ROLE_LABELS)).toEqual(['Admin', 'Attorney', 'Staff', 'IT', 'Form dev', 'Automation']);
  });

  test('rows: every registry item plus the saved firm items, grouped like All; Settings and Help locked on Everyone; a second section in the TOC', async () => {
    const t = await boot({ doc: DOC });
    const titles = t.$$('#fm-sec-who .fm-group-title').map((e) => e.textContent);
    expect(titles).toEqual(['Records', 'Actions', 'Settings', 'More actions', 'More', 'Firm', 'Admin']);   // More actions: S6b
    const rowIds = t.$$('[data-who-id]').map((e) => e.dataset.whoId);
    const all = Object.keys(t.top.FEATURE_REGISTRY).filter((id) => !t.top.FEATURE_REGISTRY[id].placeholder);
    expect(rowIds.slice().sort()).toEqual([...all, 'firm:payroll'].sort());
    for (const id of ['moreSettings', 'helpSupport']) {
      const sel = whoRow(t.firm, id).querySelector('[data-mode]');
      expect([id, sel.disabled, sel.value, !!whoRow(t.firm, id).querySelector('[data-people]')]).toEqual([id, true, 'all', false]);
    }
    expect(t.$('#fm-toc').hidden).toBe(false);
    expect(t.$$('#fm-toc a').map((a) => a.textContent)).toEqual(['Launcher', 'Who sees what']);
    expect(t.F.WhoSection.isDirty()).toBe(false);
  });

  test('restrict → save → the shell follows; unrestrict → save → the entry is gone (absent = everyone)', async () => {
    const t = await boot({ doc: DOC, users: USERS });
    t.L.applyAccess({ roles: ['staff'] });                       // the admin's own shell, as a staff-role user here
    expect(ids(t.L.effectiveRegistry())).toContain('moreAutomations');
    mode(t, 'moreAutomations', 'except');
    expect(t.F.WhoSection.isDirty()).toBe(true);                 // [] = only su is a change
    role(t, 'moreAutomations', 'attorney', true);
    role(t, 'moreAutomations', 'admin', true);
    expect(t.saveBtnShown()).toBe(true);
    await save(t);
    expect(puts(t.backend)).toHaveLength(1);
    expect(puts(t.backend)[0].payload.base).toBe(1);
    expect(t.backend.st.doc.visible_to).toEqual({ moreAutomations: ['admin', 'attorney'] });   // the server's order
    expect(t.top.firmData.ui.firm.registry_overrides.visible_to).toEqual({ moreAutomations: ['admin', 'attorney'] });
    expect(ids(t.L.effectiveRegistry())).not.toContain('moreAutomations');
    expect(t.L.elementsOf('moreAutomations').more.hasAttribute('data-yc-denied')).toBe(true);
    expect([t.F.WhoSection.isDirty(), t.saveBtnShown()]).toEqual([false, false]);
    expect(whoRow(t.firm, 'moreAutomations').querySelector('[data-role="admin"]').checked).toBe(true);
    // unrestrict
    mode(t, 'moreAutomations', 'all');
    expect(whoRow(t.firm, 'moreAutomations').querySelector('.fm-who-roles')).toBeNull();
    await save(t);
    expect(Object.prototype.hasOwnProperty.call(t.backend.st.doc, 'visible_to')).toBe(false);
    expect(ids(t.L.effectiveRegistry())).toContain('moreAutomations');
    expect(t.F.WhoSection.isDirty()).toBe(false);
  });

  test('a firm item can be restricted too ([] = only su) — and an untouched stored list never reads as dirty, whatever its order', async () => {
    const t = await boot({ doc: { ...DOC, visible_to: { bills: ['attorney', 'admin'] } }, lenient: true });   // stored out of order
    expect(t.F.WhoSection.isDirty()).toBe(false);
    mode(t, 'firm:payroll', 'except');
    await save(t);
    expect(t.backend.st.doc.visible_to).toEqual({ bills: ['attorney', 'admin'], 'firm:payroll': [] });
  });

  test('SU is always ticked and locked, with its tooltip; un-ticking it changes nothing', async () => {
    const t = await boot({ doc: DOC });
    mode(t, 'moreAutomations', 'except');
    const su = whoRow(t.firm, 'moreAutomations').querySelector('[data-role="su"]');
    expect([su.checked, su.disabled, su.title, su.closest('label').title]).toEqual([true, true, t.F.SU_TIP, t.F.SU_TIP]);
    expect(t.F.SU_TIP).toBe('Superusers always see everything');
    su.checked = false; t.fire(su, 'change');
    expect([...t.F.WhoSection.st.form.vis.get('moreAutomations')]).toEqual([]);
    expect(t.F.WhoSection.apply(t.F.RegistryDoc.stored).visible_to).toEqual({ moreAutomations: [] });
  });

  test('un-ticking a role drops it; SU can never be ticked into a list; entries for ids the form does not list ride through', async () => {
    const t = await boot({ doc: { ...DOC, visible_to: { notInRegistry: ['staff'], 'firm:retired-one': [] } }, lenient: true });
    expect(t.F.WhoSection.isDirty()).toBe(false);
    mode(t, 'moreAutomations', 'except');
    role(t, 'moreAutomations', 'admin', true);
    role(t, 'moreAutomations', 'staff', true);
    role(t, 'moreAutomations', 'admin', false);
    const su = whoRow(t.firm, 'moreAutomations').querySelector('[data-role="su"]');
    su.checked = true; t.fire(su, 'change');                    // a forced tick on the locked box changes nothing
    await save(t);
    expect(t.backend.st.doc.visible_to).toEqual({ notInRegistry: ['staff'], 'firm:retired-one': [], moreAutomations: ['staff'] });
  });

  test('ONE document, two sections: Launcher and Who-sees-what edits pending together → ONE PUT carrying both; both clean after', async () => {
    const t = await boot({ doc: DOC });
    t.tick('bills', true);
    t.setVal(t.$('[data-rename="cases"]'), 'Matters');
    mode(t, 'moreAutomations', 'except');
    role(t, 'moreAutomations', 'admin', true);
    expect([t.F.LauncherSection.isDirty(), t.F.WhoSection.isDirty()]).toEqual([true, true]);
    await save(t);
    expect(puts(t.backend)).toHaveLength(1);
    expect(t.backend.st.doc).toEqual({ hidden: ['bills'], locked: [], renames: { cases: { label: 'Matters' } }, items: [SHELL_ITEM],
      visible_to: { moreAutomations: ['admin'] } });
    expect([t.F.LauncherSection.isDirty(), t.F.WhoSection.isDirty(), t.backend.st.versions.length]).toEqual([false, false, 2]);
    expect(t.F.RegistryDoc.base).toBe(2);
    // each section alone keeps the other's stored part
    mode(t, 'bills', 'except');
    await save(t);
    expect(t.backend.st.doc.hidden).toEqual(['bills']);
    expect(t.backend.st.doc.renames).toEqual({ cases: { label: 'Matters' } });
    t.tick('log', true);
    await save(t);
    expect(t.backend.st.doc.visible_to).toEqual({ moreAutomations: ['admin'], bills: [] });
    expect(puts(t.backend).map((p) => p.payload.base)).toEqual([1, 2, 3]);
  });

  test('a firm item deleted in the Launcher section takes its visible_to entry with it in the same save', async () => {
    const t = await boot({ doc: { ...DOC, visible_to: { 'firm:payroll': ['admin'], moreAutomations: ['staff'] } } });
    t.fire(t.$('.fm-item [data-act="del"]'), 'click');
    await save(t);
    expect(t.backend.st.doc.items).toEqual([]);
    expect(t.backend.st.doc.visible_to).toEqual({ moreAutomations: ['staff'] });
    expect(whoRow(t.firm, 'firm:payroll')).toBeUndefined();     // the row follows the stored items
  });

  test('409: another admin saved — the conflict message; nothing overwritten; both sections keep their edits', async () => {
    const t = await boot({ doc: DOC });
    t.backend.st.otherAdminSaves({ ...DOC, hidden: ['log'] });
    t.tick('bills', true);
    mode(t, 'moreAutomations', 'except');
    await save(t);
    expect(t.$('#fm-banner').textContent).toBe(t.F.CONFLICT_MSG);
    expect(t.backend.st.doc).toEqual({ ...DOC, hidden: ['log'] });
    expect([t.F.LauncherSection.isDirty(), t.F.WhoSection.isDirty(), t.saveBtnShown()]).toEqual([true, true, true]);
  });

  test('the server\'s visible_to errors land on their row; the rest on the banner', async () => {
    const t = await boot({ doc: DOC });
    mode(t, 'moreAutomations', 'except');
    t.F.WhoSection.st.form.vis.get('moreAutomations').add('su');      // what the UI can't do: a hand-made bad list
    t.F.WhoSection.changed();
    await save(t);
    expect(errOf(t, 'moreAutomations')).toMatch(/su always sees every item/);
    expect(t.$('#fm-banner').textContent).toMatch(/^Who sees what: the server refused the save/);   // not "Launcher:" (review N2)
    expect(t.backend.st.doc).toEqual(DOC);
  });

  test('per-user hides: listed by name; the picker offers ACTIVE users only; add and remove write at once through the CRUD, never the page Save', async () => {
    const denies = [{ id: 1, scope: 'user', scope_ref: '5', item_key: 'bills' }, { id: 2, scope: 'role', scope_ref: 'staff', item_key: 'bills' }];
    const t = await boot({ doc: DOC, users: USERS, denies });
    expect(chips(t, 'bills')).toEqual(['Rena']);                     // the role deny is not shown
    expect(chips(t, 'firm:payroll')).toEqual([]);
    const pick = whoRow(t.firm, 'firm:payroll').querySelector('[data-person-for]');
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Add a person…', 'Stuart', 'Rivka', 'Rena']);
    expect([...whoRow(t.firm, 'bills').querySelector('[data-person-for]').options].map((o) => o.value)).toEqual(['', '1', '3']);
    // add, on a FIRM item
    t.setVal(pick, '3');
    t.fire(whoRow(t.firm, 'firm:payroll').querySelector('[data-act="hide-person"]'), 'click');
    await flush();
    expect(t.backend.st.calls.filter((c) => c.method === 'POST').map((c) => c.payload)).toEqual([{ scope: 'user', scope_ref: 3, item_key: 'firm:payroll' }]);
    expect(chips(t, 'firm:payroll')).toEqual(['Rivka']);
    expect(t.backend.st.denies.map((d) => [d.scope, d.scope_ref, d.item_key])).toContainEqual(['user', '3', 'firm:payroll']);
    // remove
    t.fire(whoRow(t.firm, 'bills').querySelector('[data-act="unhide"]'), 'click');
    await flush();
    expect(t.backend.st.calls.filter((c) => c.method === 'DELETE').map((c) => c.endpoint)).toEqual(['/api/entitlements/1']);
    expect(chips(t, 'bills')).toEqual([]);
    expect(t.backend.st.denies.map((d) => d.id)).toEqual([2, 100]);
    // none of it is the page's business
    expect([puts(t.backend).length, t.F.RegistryDoc.dirty(), t.saveBtnShown()]).toEqual([0, false, false]);
    // nothing chosen → a nudge, no request
    t.fire(whoRow(t.firm, 'cases').querySelector('[data-act="hide-person"]'), 'click');
    await flush();
    expect(errOf(t, 'cases')).toBe('Choose a person first.');
    expect(t.backend.st.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  test('per-user hide errors are inline on the row: 403 session message, duplicate, already removed', async () => {
    const t = await boot({ doc: DOC, users: USERS, denies: [{ id: 7, scope: 'user', scope_ref: '5', item_key: 'bills' }] });
    // a duplicate made behind the page's back
    t.backend.st.denies.push({ id: 8, scope: 'user', scope_ref: '3', item_key: 'cases' });
    t.setVal(whoRow(t.firm, 'cases').querySelector('[data-person-for]'), '3');
    t.fire(whoRow(t.firm, 'cases').querySelector('[data-act="hide-person"]'), 'click');
    await flush();
    expect(errOf(t, 'cases')).toBe('Already hidden from them.');
    // …and the row catches up (review S1): the existing hide is a chip, and Rivka leaves the picker
    expect(chips(t, 'cases')).toEqual(['Rivka']);
    expect([...whoRow(t.firm, 'cases').querySelector('[data-person-for]').options].map((o) => o.value)).toEqual(['', '1', '5']);
    expect(t.backend.st.denies.filter((d) => d.item_key === 'cases')).toHaveLength(1);   // no duplicate written
    // removed behind the page's back → 404 → the chip goes, the message says so
    t.backend.st.denies = t.backend.st.denies.filter((d) => d.id !== 7);
    t.fire(whoRow(t.firm, 'bills').querySelector('[data-act="unhide"]'), 'click');
    await flush();
    expect([errOf(t, 'bills'), chips(t, 'bills')]).toEqual(['That hide was already removed.', []]);
    // a 403
    const t2 = await boot({ doc: DOC, users: USERS, failWith: { 'POST /api/entitlements': 403 } });
    t2.setVal(whoRow(t2.firm, 'log').querySelector('[data-person-for]'), '1');
    t2.fire(whoRow(t2.firm, 'log').querySelector('[data-act="hide-person"]'), 'click');
    await flush();
    expect(errOf(t2, 'log')).toBe(t2.F.SESSION_MSG);
    expect(chips(t2, 'log')).toEqual([]);
  });

  test('the denies list failing to load: said once, no people controls, visible_to still editable and saveable', async () => {
    const t = await boot({ doc: DOC, users: USERS, failWith: { 'GET /api/entitlements': 403 } });
    expect(t.$('#fm-who-denies-err').textContent).toBe(t.F.SESSION_MSG);
    expect(t.$$('[data-people] select')).toEqual([]);
    mode(t, 'moreAutomations', 'except');
    await save(t);
    expect(t.backend.st.doc.visible_to).toEqual({ moreAutomations: [] });
  });

  test('escaping: a user name and a firm item label with markup create no element', async () => {
    const users = [...USERS, { user: 4, user_name: '<img id=xu1 src=x>"><b id=xu2>', user_type: 1, active: true }];
    const item = { ...SHELL_ITEM, label: '<img id=xl1>"><b id=xl2>' };
    const t = await boot({ doc: { ...DOC, items: [item] }, users, denies: [{ id: 3, scope: 'user', scope_ref: '4', item_key: 'bills' }], lenient: true });
    for (const id of ['xu1', 'xu2', 'xl1', 'xl2']) expect(t.firm.document.getElementById(id)).toBeNull();
    expect(chips(t, 'bills')).toEqual(['<img id=xu1 src=x>"><b id=xu2>']);
    expect(whoRow(t.firm, 'firm:payroll').querySelector('.fm-name').textContent).toBe('<img id=xl1>"><b id=xl2>');
    expect([...whoRow(t.firm, 'cases').querySelector('[data-person-for]').options].map((o) => o.textContent)).toContain('<img id=xu1 src=x>"><b id=xu2>');
  });

  test('History shows a version\'s restrictions; a restore re-forms this section too', async () => {
    const t = await boot({ doc: { ...DOC, visible_to: { moreAutomations: ['admin'] } } });
    mode(t, 'moreAutomations', 'all');
    await save(t);                                               // v2: no restrictions
    t.fire(t.$('[data-act="history"]'), 'click');
    await flush();
    const rows = t.$$('.fm-ver');
    t.fire(rows[1].querySelector('[data-ver-act="view"]'), 'click');
    await flush();
    expect(rows[1].querySelector('.fm-ver-view').textContent).toMatch(/Who sees what\s*Automations: Admin, SU/);
    t.firm.Swal = undefined; t.firm.confirm = () => true;
    t.fire(rows[1].querySelector('[data-ver-act="restore"]'), 'click');
    await flush();
    expect(t.backend.st.doc.visible_to).toEqual({ moreAutomations: ['admin'] });
    expect([whoRow(t.firm, 'moreAutomations').querySelector('[data-mode]').value, t.F.WhoSection.isDirty()]).toEqual(['except', false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ui-custom S6a: a firm item's icon is CHOSEN in the shell's picker (drawn in
// the TOP document, opened from inside this nested frame), never typed.
describe('S6a: firm items choose their icon in the shell\'s picker', () => {
  const pick = async ({ top, firm }, { query, fam }) => {
    const pk = top.document.getElementById('ycIconPicker');
    const q = pk.querySelector('.yip-q');
    q.value = query; q.dispatchEvent(new top.Event('input', { bubbles: true }));
    pk.querySelector(`.yip-chip[data-fam="${fam}"]`).click();
    pk.querySelector('.yip-tile').click();
    await flush();
  };

  test('the card: a preview, the icon\'s name and Choose… — no box to type in', async () => {
    const { $ } = await boot({ doc: { hidden: [], locked: [], renames: {}, items: [{ ...SHELL_ITEM, icon: 'brands:dropbox' }] } });
    const box = $('#fi0-icon').closest('.fm-icon-in');
    expect($('#fi0-icon').type).toBe('hidden');
    expect(box.querySelectorAll('input[type="text"]')).toHaveLength(0);
    expect(box.querySelector('.fm-icon-prev i').className).toBe('fa-brands fa-dropbox');
    expect(box.querySelector('.fm-icon-name').textContent).toBe('dropbox · Brands');
    expect(box.querySelector('[data-act="icon"]').textContent).toBe('Choose…');
    expect($('label[for="fi0-iconpick"]').textContent).toBe('Icon');
  });

  test('a regular icon: chosen from inside the frame, drawn in the top document; saved; the shell draws it with fa-regular', async () => {
    const t = await boot({ doc: { hidden: [], locked: [], renames: {}, items: [SHELL_ITEM] } });
    const { $, firm, top, mid, backend, L } = t;
    const choose = $('[data-act="icon"]');
    choose.click();
    await flush();
    expect(top.ycIconPicker.isOpen()).toBe(true);
    expect(firm.document.getElementById('ycIconPicker')).toBe(null);
    expect(mid.document.getElementById('ycIconPicker')).toBe(null);
    const pk = top.document.getElementById('ycIconPicker');
    expect(pk.querySelector('#yipTitle').textContent).toBe('Icon for “Payroll”');
    expect(pk.querySelector('.is-current').getAttribute('data-v')).toBe('money-check');
    await pick(t, { query: 'star', fam: 'regular' });
    expect(top.ycIconPicker.isOpen()).toBe(false);
    expect(firm.document.activeElement).toBe(choose);
    expect($('#fi0-icon').value).toBe('regular:star');
    const box = $('#fi0-icon').closest('.fm-icon-in');
    expect(box.querySelector('.fm-icon-prev i').className).toBe('fa-regular fa-star');
    expect(box.querySelector('.fm-icon-name').textContent).toBe('star · Regular');
    expect(t.F.LauncherSection.isDirty()).toBe(true);
    await mid.onTopbarSave();
    await flush();
    expect(puts(backend)).toHaveLength(1);
    expect(backend.st.doc.items[0].icon).toBe('regular:star');
    // the shell: the More grid's firm row and All's registry
    const tile = top.document.querySelector('#tabMore [data-yc-firm-row="firm:payroll"] i');
    expect(tile.className).toBe('fa-regular fa-star fa-2xl');
    expect(L.effectiveRegistry().find((e) => e.id === 'firm:payroll').icon).toBe('regular:star');
    // Who sees what lists the firm item with its family too
    const who = [...firm.document.querySelectorAll('.fm-who-row')].find((r) => /Payroll/.test(r.textContent));
    expect(who.querySelector('.fm-ico i').className).toBe('fa-regular fa-star');
  });

  test('cancel keeps the icon and changes nothing; a brand can be picked for a new item', async () => {
    const t = await boot();
    const { $, top, fire, setVal, mid, backend } = t;
    fire($('[data-act="add-item"]'), 'click');
    setVal($('#fi0-label'), 'Code');
    setVal($('#fi0-href'), 'https://github.com/');
    expect($('#fi0-icon').value).toBe('link');                      // a new item starts on link
    $('[data-act="icon"]').click();
    await flush();
    top.document.getElementById('ycIconPicker').querySelector('.yip-cancel').click();
    await flush();
    expect($('#fi0-icon').value).toBe('link');
    $('[data-act="icon"]').click();
    await flush();
    await pick(t, { query: 'github', fam: 'brands' });
    expect($('#fi0-icon').value).toBe('brands:github');
    await mid.onTopbarSave();
    await flush();
    expect(backend.st.doc.items[0]).toEqual({ id: 'firm:code', label: 'Code', icon: 'brands:github', action: { type: 'url', href: 'https://github.com/', present: 'window' } });
  });
});
