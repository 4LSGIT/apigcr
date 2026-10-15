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

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DENIED_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const CCM_HTML = fs.readFileSync(path.join(ROOT, 'public/caseConfigManager.html'), 'utf8');
const FIRM_HTML = fs.readFileSync(path.join(ROOT, 'public/caseconfig/firm.html'), 'utf8');
// External scripts / sheets (CDN, themeSync) are not loaded in jsdom anyway; drop them.
const strip = (html) => html.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── the in-memory server ─────────────────────────────────────────────────
function makeBackend({ doc = null, canEdit = true, lenient = false, getFails = null, failWith = {}, toolTitle = 'Appt Form' } = {}) {
  const st = { doc: doc ? clone(doc) : null, versions: [], nextId: 1, calls: [] };
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
    let m;
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
function makeTop(backend, shellDoc) {
  const page = `<!DOCTYPE html><html><head>${DENIED_CSS}<script>${REGISTRY_SRC}</script><script>${RENDERER_SRC}</script></head><body>
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
  w.firmData = { ui: { firm: shellDoc ? { registry_overrides: clone(shellDoc) } : {}, user: {} } };
  w.apiSend = backend.api;
  w.ycLauncher.applyAccess({ isAdmin: true, denied: [], ui: w.firmData.ui, customTab: null });
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
  const top = makeTop(backend, opts.shellDoc === undefined ? opts.doc : opts.shellDoc);
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
  test('grouped like All, from ycLauncher\'s own grouping; every item once; undeniables locked on; custom not renameable', async () => {
    const { $$, L, top } = await boot({ doc: { hidden: [], locked: [], renames: {}, items: [SHELL_ITEM] } });
    const titles = $$('.fm-group-title').map((e) => e.textContent);
    const groupsBefore = L.groups();
    expect(groupsBefore).toContain('Firm');                  // the shell has a firm item
    expect(titles).toEqual(groupsBefore.filter((g) => g !== 'Firm' && g !== 'Home'));
    expect(titles).toEqual(['Records', 'Actions', 'Settings', 'More', 'Admin']);
    // computeEffective's group record was left exactly as the shell's
    expect(L.groups()).toEqual(groupsBefore);
    const rowIds = $$('[data-row-id]').map((e) => e.dataset.rowId);
    const all = Object.keys(top.FEATURE_REGISTRY).filter((id) => !top.FEATURE_REGISTRY[id].placeholder);
    expect(rowIds.slice().sort()).toEqual(all.sort());
    for (const id of ['moreSettings', 'helpSupport']) {
      const c = $$(`[data-hide="${id}"]`)[0];
      expect([id, c.disabled, c.checked]).toEqual([id, true, false]);
    }
    expect($$('[data-rename="custom"]')).toEqual([]);
    expect($$('[data-hide="custom"]')).toHaveLength(1);
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
    expect($('#fm-banner').textContent).toMatch(/refused/);
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
