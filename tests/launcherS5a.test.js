// tests/launcherS5a.test.js
//
/**
 * ui-custom S5a — users' own buttons ("My buttons"), the client side.
 *
 *   1. computeEffective (the page's own ycLauncher block, pure, in a vm): the
 *      user's buttons are group "Mine", after Firm and before Admin, in their
 *      array order; firm hidden / renames / visible_to and entitlement denies
 *      never touch them; a bad or duplicate one is dropped; purity (no input
 *      mutated, no group order written, the same answer twice).
 *   2. exec(id) for a button, run for real in jsdom with the real tool dialog:
 *      a link opens a new window ('_blank', 'noopener') and never a dialog; a
 *      tool / view opens the dialog at its size, titled with the label; a
 *      malformed button never navigates. Buttons never render in the More
 *      grid's firm row; placed on Home / the sidebar they are neutral
 *      shortcuts that run exec.
 *   3. The editor's My buttons tab (the real ycLayoutEditor.js), over a mock
 *      server whose PUT runs the REAL uiConfigService.write on an in-memory
 *      connection (so `retired` is derived for real): the list (what it opens,
 *      where it is placed / bound); add / edit / delete; validation; ids from
 *      the name, unique against buttons, refs and retired, a saved id stable;
 *      delete cascades placements and bindings (asking first); "Add to Home" /
 *      "Add to sidebar"; the three-document save (items first) and its partial
 *      failures (held parts); escaping; edits ignored while saving; the
 *      pickers read lazily, its failure said.
 *   4. The round trip: a new button added to Home and bound to a shortcut,
 *      saved in one go, renders on Home and fires on its combo, no reload.
 *   5. The pure cores: itemSession under random edit sequences always writes
 *      a document the real validator accepts; layout dropId never writes a
 *      dropped id back.
 *
 * Mutation-checked (see the S5a worker report).
 *
 * Run:  npx jest tests/launcherS5a.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');
const { rawShellHtml } = require('./helpers/shellHtml');
// More Features and Admin: the firm's pages since launcher-nits C4 (tests/helpers/hubPages.js)
const { hubFirm, stageHtml } = require('./helpers/hubPages');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DIALOG_SRC = RAW.match(/<script id="ycToolDialogJs">([\s\S]*?)<\/script>/)[1];
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');
// the icon picker (ui-custom S6a) and its catalog, served by a fetch stub
const PICKER_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIconPicker.js'), 'utf8');
const CATALOG = fs.readFileSync(path.join(ROOT, 'public', PICKER_SRC.match(/var CATALOG_URL = '([^']+)';/)[1]), 'utf8');

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS5a: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];

const J = (x) => JSON.parse(JSON.stringify(x));

// ── fixtures ──
const VIEW = { id: 'user:leads', label: 'My leads', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' } };
const TOOL = { id: 'user:intake', label: 'Intake', icon: 'clipboard-check', action: { type: 'tool', key: 'qa-intake-tool', present: 'modal', size: 'compact' } };
const LINK = { id: 'user:court', label: 'Court site', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/cases', present: 'window' } };
const FIRM_URL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const RO = { items: [FIRM_URL], hidden: [], locked: [], renames: {} };
// the firm's documents: RO, plus More Features and Admin as the firm's pages (launcher-nits C4)
const FIRM = (ro = RO) => hubFirm({ items: ro.items || [], ro, visibleTo: { 'firm:admin': ['it', 'admin'], ...(ro.visible_to || {}) } });
const PICKERS = { status: 'success',
  tools: [{ key: 'qa-intake-tool', title: 'Intake checklist' }, { key: 'clio-code', title: 'Get Clio Code' }],
  views: [{ key: 'lead_followups', title: 'Leads <b>follow ups</b>' }, { key: 'upcoming_hearings', title: 'Upcoming hearings' }] };

// ─────────────────────────────────────────────────────────────────────────
// 1. computeEffective, pure, in a vm
function vmLauncher() {
  const warnings = [];
  // a page with nothing mounted: applyAccess's DOM passes find no element
  const ctx = vm.createContext({ console: { error: (m) => warnings.push(String(m)), warn: (m) => warnings.push(String(m)) }, URL,
    document: { getElementById: () => null } });
  ctx.window = ctx;
  vm.runInContext(REGISTRY_SRC, ctx);
  vm.runInContext(RENDERER_SRC, ctx);
  return { L: ctx.window.ycLauncher, warnings };
}
const ui = (items, ro = RO, extra = {}) => ({ firm: FIRM(J(ro)), user: { ...(items ? { items: { items: J(items) } } : {}), ...extra } });

describe('computeEffective: the user\'s own buttons', () => {
  test('group "Mine": last — after the firm\'s pages and Firm (launcher-nits C4) —, in array order; the S2 group list is unchanged without buttons', () => {
    const { L } = vmLauncher();
    const eff = L.computeEffective({ isAdmin: true, ui: ui([LINK, VIEW, TOOL]) });
    expect(eff.groups.slice(-4)).toEqual(['More Features', 'Admin', 'Firm', 'Mine']);
    expect(eff.filter((e) => e.group === 'Mine').map((e) => [e.id, e.label, e.icon])).toEqual([
      ['user:court', 'Court site', 'gavel'], ['user:leads', 'My leads', 'star'], ['user:intake', 'Intake', 'clipboard-check']]);
    const ids = eff.map((e) => e.id);
    const lastAdmin = ids.length - 1 - [...eff].reverse().findIndex((e) => e.group === 'Admin');
    expect(ids.indexOf('firm:payroll')).toBeLessThan(ids.indexOf('user:court'));
    expect(ids.indexOf('user:court')).toBeGreaterThan(lastAdmin);
    expect(ids[ids.length - 1]).toBe('user:intake');
    // no firm items, no pages: Mine is still last
    const noFirm = L.computeEffective({ isAdmin: true, ui: { firm: { registry_overrides: {} }, user: { items: { items: [J(VIEW)] } } } });
    expect(noFirm.groups.slice(-1)).toEqual(['Mine']);
    expect(noFirm.groups).not.toContain('Firm');
    // no buttons: exactly the list without them
    const none = L.computeEffective({ isAdmin: true, ui: ui(null) });
    expect(none.groups).not.toContain('Mine');
    expect(none.groups).toEqual(eff.groups.filter((g) => g !== 'Mine'));
  });

  test('firm hidden / renames / visible_to and entitlement denies never touch a button (it is the user\'s)', () => {
    const { L } = vmLauncher();
    const ro = { ...RO, hidden: ['user:leads', 'tasks'], renames: { 'user:court': { label: 'Renamed' } }, visible_to: { 'user:intake': [], calendar: [] } };
    const eff = L.computeEffective({ isAdmin: false, roles: ['staff'], denied: ['user:court', 'contacts'], ui: ui([LINK, VIEW, TOOL], ro) });
    const mine = eff.filter((e) => e.group === 'Mine').map((e) => [e.id, e.label]);
    expect(mine).toEqual([['user:court', 'Court site'], ['user:leads', 'My leads'], ['user:intake', 'Intake']]);
    const ids = eff.map((e) => e.id);
    expect([ids.includes('tasks'), ids.includes('contacts'), ids.includes('calendar')]).toEqual([false, false, false]);   // the firm's rules still bite registry items
  });

  test('a bad or duplicate button is dropped with a warning (never listed); at most 50 are read', () => {
    const { L, warnings } = vmLauncher();
    const bad = [{ ...VIEW, id: 'user:Bad' }, { ...LINK, id: 'user:x', action: { type: 'url', href: '/tool/clio', present: 'window' } },
      { ...LINK, id: 'user:t', action: { ...LINK.action, present: 'tab' } }, { ...LINK, id: 'firm:z' }, VIEW, VIEW];   // a link never opens as a tab (S5c-b)
    const eff = L.computeEffective({ ui: ui(bad) });
    expect(eff.filter((e) => e.group === 'Mine').map((e) => e.id)).toEqual(['user:leads']);
    expect(warnings.filter((w) => /your button \d dropped/.test(w))).toHaveLength(5);
    const many = Array.from({ length: 55 }, (_, i) => ({ ...VIEW, id: 'user:b' + i }));
    expect(vmLauncher().L.computeEffective({ ui: ui(many) }).filter((e) => e.group === 'Mine')).toHaveLength(50);
  });

  test('pure: no input mutated, nothing written (groups() unchanged), the same answer twice; copies never expose the action', () => {
    const { L } = vmLauncher();
    L.applyAccess({ isAdmin: false, ui: ui(null) });
    const before = L.groups();
    const input = ui([LINK, VIEW]);
    const frozen = JSON.stringify(input);
    const a = L.computeEffective({ isAdmin: true, ui: input });
    const b = L.computeEffective({ isAdmin: true, ui: input });
    expect(JSON.stringify(input)).toBe(frozen);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(L.groups()).toEqual(before);
    L.applyAccess({ ui: input });
    const copies = L.effectiveRegistry().filter((e) => /^user:/.test(e.id));
    expect(copies.map((e) => Object.keys(e).sort())).toEqual([['group', 'icon', 'id', 'label', 'labels'], ['group', 'icon', 'id', 'label', 'labels']]);
    expect(L.groups()).toContain('Mine');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The shell for real: launcher blocks, the tool dialog, the All tab, ycAll.js
// and ycLayoutEditor.js, over a mock API. PUT /api/ui-config runs the REAL
// uiConfigService.write on an in-memory connection.
function memDb() {
  const rows = new Map();            // 'scope|user|key' → json string
  const conn = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
    query: async (sql, p = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) {
        const k = p.slice(0, 3).join('|');
        return [rows.has(k) ? [{ id: 1, config: rows.get(k) }] : []];
      }
      if (/^INSERT INTO ui_config /.test(s)) { rows.set(p.slice(0, 3).join('|'), p[3]); return [{ insertId: 1 }]; }
      throw new Error('memDb: unscripted ' + s);
    },
  };
  return { rows, getConnection: async () => conn, query: async () => { throw new Error('memDb: no pool queries'); } };
}

function boot({ items = null, layout = null, shortcuts = null, retired = null, platform = 'MacIntel', access = { isAdmin: false, denied: [] }, pickersFail = false } = {}) {
  const LAY = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return J(c.DEFAULT_LAYOUTS); })();
  const REG = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return c.FEATURE_REGISTRY; })();
  const tabs = new Set(['tabHome']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <script id="ycToolDialogJs">${DIALOG_SRC}</script>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    ${ALL_TAB}
    ${plainTabs}
    <div id="ycPages"></div>
    <div id="ycPanels" style="display:none">${stageHtml(REG)}</div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.example/' });
  const w = dom.window;
  if (platform) Object.defineProperty(w.navigator, 'platform', { get: () => platform, configurable: true });
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const calls = [];
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.__calls = calls;
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  const opened = [];
  w.open = (...a) => { opened.push(a); return null; };
  const userDoc = () => ({
    ...(items ? { items: J(retired ? { items, retired } : { items }) } : {}),
    ...(layout ? { layout: J(layout) } : {}), ...(shortcuts ? { shortcuts: J(shortcuts) } : {}),
  });
  w.firmData = { ui: { firm: FIRM(), user: userDoc() } };
  const db = memDb();
  for (const [k, v] of Object.entries(userDoc())) db.rows.set(`user|9|${k}`, JSON.stringify(v));
  const server = { puts: [], gets: [], fail: {}, hold: false, release: null, db, pickersFail };
  const userNow = () => { const u = {}; for (const [k, v] of db.rows) { const [, uid, key] = k.split('|'); if (uid === '9') u[key] = JSON.parse(v); } return u; };
  server.user = userNow;
  w.apiSend = (url, method, body) => {
    if (method === 'GET' || method == null) {
      server.gets.push(url);
      if (url === '/api/ui-config/pickers') {
        return server.pickersFail ? Promise.reject(Object.assign(new Error('down'), { status: 500 })) : Promise.resolve(J(PICKERS));
      }
      return Promise.resolve({ status: 'success', firm: FIRM(), user: userNow(), can_edit_firm: false });
    }
    server.puts.push(J({ url, method, body }));
    if (server.hold) return new Promise((resolve, reject) => { server.release = () => { server.hold = false; answerPut(body).then(resolve, reject); }; });
    return answerPut(body);
  };
  function answerPut(body) {
    const f = server.fail[body.config_key];
    if (f) return Promise.reject(Object.assign(new Error(f.message || 'refused'), f));
    return svc.write(db, J(body), { type: 'jwt', userId: 9, roles: ['staff'] }).then(
      (r) => ({ status: 'success', ...J(r) }),
      (e) => Promise.reject(Object.assign(new Error(e.message), { status: e.status || 500, body: { status: 'error', message: e.message, errors: e.errors } })));
  }
  const confirms = [];
  const toasts = [];
  w.Toast = { fire: (o) => { toasts.push(o.title); return Promise.resolve(); } };
  let answer = true;
  w.confirm = (text) => { confirms.push(text); return answer; };
  w.ycLauncher.applyAccess({ ...access, ui: w.firmData.ui });
  w.eval(YCALL_SRC);
  w.eval(EDITOR_SRC);
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(CATALOG)) });
  w.eval(PICKER_SRC);
  const d = w.document;
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const key = (el, init) => {
    const e = new (el.ownerDocument.defaultView.KeyboardEvent)('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  const panel = () => d.getElementById('ycLayoutEditor');
  const mb = () => panel().querySelector('.ymb-sec');
  const mbRows = () => [...mb().querySelectorAll('.ymb-row')].map((li) => ({
    id: li.getAttribute('data-id'), name: li.querySelector('.yle-name').textContent, sum: li.querySelector('.ymb-sum').textContent,
    tags: [...li.querySelectorAll('.yle-tag')].map((t) => t.textContent), kbd: [...li.querySelectorAll('kbd')].map((k) => k.textContent),
  }));
  const rowOf = (name) => [...mb().querySelectorAll('.ymb-row')].find((li) => li.querySelector('.yle-name').textContent === name);
  const act = (name, a) => rowOf(name).querySelector(`[data-act="${a}"]`);
  const openEditor = async (section = 'buttons') => { const ok = await w.ycLayoutEditor.open({ section }); await flush(); return ok; };
  const setVal = (id, v) => {
    const n = mb().querySelector('#ymb_' + id);
    n.value = v;
    n.dispatchEvent(new w.Event(n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  // the form: open (new, or edit row `edit`), fill, commit
  const fill = (f) => {
    if (f.type) setVal('type', f.type);
    for (const k of ['label', 'icon', 'key', 'href', 'size']) if (f[k] != null) setVal(k, f[k]);
  };
  // since launcher-nits L2 a committed button saves itself: wait for that PUT
  const addButton = async (f) => { mb().querySelector('[data-act="mb-open"]').click(); fill(f); mb().querySelector('[data-act="mb-commit"]').click(); await flush(); };
  const fieldErr = (k) => mb().querySelector(`[data-err="${k}"]`).textContent;
  const layoutRows = (sf) => [...panel().querySelectorAll(`.yle-sec[data-sf="${sf}"] .yle-rows > .yle-row`)].map((li) => (li.querySelector('.yle-name') || {}).textContent);
  const save = async () => { panel().querySelector('.yle-save').click(); await flush(); };
  const dlg = () => d.getElementById('ycToolDialog');
  return {
    w, d, server, errors, calls, opened, confirms, toasts, flush, key, panel, mb, mbRows, rowOf, act, openEditor, setVal, fill, addButton,
    fieldErr, layoutRows, save, dlg, answer: (v) => { answer = v; }, tab: () => w.currentMainTabId(), close: () => w.close(),
  };
}
const CMD_CTRL = (k) => ({ key: k, code: 'Key' + k.toUpperCase(), ctrlKey: true, metaKey: true });

// ─────────────────────────────────────────────────────────────────────────
describe('exec(id) for a button, for real (jsdom, the real tool dialog)', () => {
  let t;
  afterEach(() => t && t.close());

  test('a link opens a new window — "_blank", "noopener" — and never the dialog', () => {
    t = boot({ items: [LINK, VIEW, TOOL] });
    expect(t.w.ycLauncher.exec('user:court')).toBe(true);
    expect(t.opened).toEqual([['https://ecf.example.gov/cases', '_blank', 'noopener']]);
    expect(t.dlg() ? t.dlg().hidden : true).toBe(true);
  });

  test('a tool opens the dialog at its size (compact), a view large by default — titled with the label', () => {
    t = boot({ items: [LINK, VIEW, TOOL] });
    expect(t.w.ycLauncher.exec('user:intake')).toBe(true);
    expect([t.dlg().hidden, t.dlg().getAttribute('data-size'), t.dlg().querySelector('iframe').getAttribute('src'), t.d.getElementById('ycToolDialogTitle').textContent])
      .toEqual([false, 'compact', '/tool/qa-intake-tool', 'Intake']);
    expect(t.w.ycLauncher.exec('user:leads')).toBe(true);   // closes the open one first, then opens
    expect([t.dlg().getAttribute('data-size'), t.dlg().querySelector('iframe').getAttribute('src'), t.d.getElementById('ycToolDialogTitle').textContent])
      .toEqual(['large', '/customView.html?key=lead_followups', 'My leads']);
    expect(t.opened).toEqual([]);
  });

  test('a malformed button never navigates (dropped from the registry; exec refuses it)', () => {
    const bad = [{ ...LINK, id: 'user:shell', action: { type: 'url', href: '/%74ool/x', present: 'window' } },
      { ...LINK, id: 'user:http', action: { type: 'url', href: 'http://x.example/', present: 'window' } },
      { ...LINK, id: 'user:tab', action: { ...LINK.action, present: 'tab' } }];   // a link never opens as a tab (S5c-b)
    t = boot({ items: bad });
    for (const id of ['user:shell', 'user:http', 'user:tab']) expect([id, t.w.ycLauncher.exec(id)]).toEqual([id, false]);
    expect(t.opened).toEqual([]);
    expect(t.dlg() ? t.dlg().hidden : true).toBe(true);
  });

  test('buttons never render on the firm\'s pages (More Features, since launcher-nits C4: a firm page holds only what the firm placed)', () => {
    t = boot({ items: [LINK, VIEW] });
    const more = t.d.querySelector('#ycPages > [data-yc-page="firm:more"]');
    const tiles = [...more.querySelectorAll(':scope > .big-button')].map((n) => n.getAttribute('data-yc-shortcut'));
    expect(tiles.length).toBeGreaterThan(10);
    expect(tiles.filter((id) => /^(user|firm):/.test(id))).toEqual([]);      // neither a button nor the unplaced firm link
    expect(more.textContent).not.toMatch(/Court site|My leads|Payroll/);
  });

  test('placed on Home and the sidebar: a neutral shortcut that runs exec (label as text)', () => {
    const marked = { ...LINK, label: 'Court <img src=x onerror=alert(1)>' };
    t = boot({ items: [marked, VIEW], layout: { placed: { home: [{ item: 'user:court' }, { item: 'cases' }], sidebar: [{ item: 'user:leads' }] } } });
    const home = t.d.querySelector('#tabHome [data-yc-shortcut="user:court"]');
    expect(home.textContent).toBe('Court <img src=x onerror=alert(1)>');
    expect(home.querySelector('img')).toBe(null);
    expect(home.hasAttribute('data-target') || home.hasAttribute('id')).toBe(false);
    home.click();
    expect(t.opened).toEqual([['https://ecf.example.gov/cases', '_blank', 'noopener']]);
    t.d.querySelector('#appSidebar [data-yc-shortcut="user:leads"]').click();
    expect(t.dlg().querySelector('iframe').getAttribute('src')).toBe('/customView.html?key=lead_followups');
  });

  test('All lists them under Mine; the palette finds them', () => {
    t = boot({ items: [LINK, VIEW] });
    const groups = [...t.d.querySelectorAll('#ycAllList .yc-all-group h2')].map((h) => h.textContent);
    expect(groups.slice(-3)).toEqual(['Admin', 'Firm', 'Mine']);   // Admin: Etch is open to staff (S6c gates); Mine last (C4)
    expect([...t.d.querySelectorAll('#ycAllList .yc-all-group:last-child .yc-all-item span')].map((s) => s.textContent)).toEqual(['Court site', 'My leads']);
    expect(t.w.ycLauncher.rank('court site').map((e) => e.id)[0]).toBe('user:court');
    expect(t.w.ycLauncher.rank('my lea').map((e) => e.id)).toContain('user:leads');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the editor\'s My buttons tab (for real)', () => {
  let t;
  afterEach(() => t && t.close());

  test('a third tab; the list shows what each opens (pickers read lazily, once), where it is placed and bound', async () => {
    t = boot({ items: [VIEW, LINK], layout: { placed: { home: [{ item: 'user:leads' }, { item: 'cases' }] } },
      shortcuts: { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'l' }, id: 'user:leads' }] } });
    expect(await t.openEditor('layout')).toBe(true);
    expect(t.server.gets).toEqual(['/api/ui-config']);                       // the layout tab never reads the lists
    t.panel().querySelector('.yle-tab[data-pane="buttons"]').click();
    await t.flush();
    expect(t.server.gets).toEqual(['/api/ui-config', '/api/ui-config/pickers']);
    t.panel().querySelector('.yle-tab[data-pane="home"]').click();
    t.panel().querySelector('.yle-tab[data-pane="buttons"]').click();
    await t.flush();
    expect(t.server.gets).toHaveLength(2);                                   // once per opening
    expect(t.mbRows()).toEqual([
      { id: 'user:leads', name: 'My leads', sum: 'Saved view · Leads <b>follow ups</b>', tags: ['On Home'], kbd: ['⌃⌘L'] },
      { id: 'user:court', name: 'Court site', sum: 'Link · ecf.example.gov (new window)', tags: [], kbd: [] },
    ]);
    expect(t.mb().querySelector('.ymb-sum b')).toBe(null);                   // a title is text
    expect(t.mb().querySelector('.ymb-intro').textContent).toMatch(/A link always opens in a new window/);
  });

  test('add a view, a tool and a link: each saves itself at once (launcher-nits L2: no Save, the panel stays open), ids from the name, { items } validated', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    await t.addButton({ label: 'Leads', icon: 'star', type: 'view', key: 'lead_followups' });
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items']);
    expect(t.toasts).toEqual(['Added “Leads”']);
    expect(t.panel().hidden).toBe(false);
    await t.addButton({ label: 'Intake', icon: 'clipboard-check', type: 'tool', key: 'qa-intake-tool', size: 'compact' });
    await t.addButton({ label: 'Court site', icon: 'gavel', type: 'url', href: 'https://ecf.example.gov/' });
    expect(t.mbRows().map((r) => [r.id, r.name, r.tags, r.sum])).toEqual([
      ['user:leads', 'Leads', [], 'Saved view · Leads <b>follow ups</b>'],
      ['user:intake', 'Intake', [], 'Tool · Intake checklist (compact)'],
      ['user:court-site', 'Court site', [], 'Link · ecf.example.gov (new window)'],
    ]);
    expect(t.panel().querySelector('.yle-tab[data-pane="buttons"] .yle-tab-dot').hidden).toBe(true);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'items', 'items']);
    const doc = t.server.puts[2].body.config;
    expect(doc).toEqual({ items: [
      { id: 'user:leads', label: 'Leads', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' } },
      { id: 'user:intake', label: 'Intake', icon: 'clipboard-check', action: { type: 'tool', key: 'qa-intake-tool', present: 'modal', size: 'compact' } },
      { id: 'user:court-site', label: 'Court site', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/', present: 'window' } },
    ] });
    expect(shape.validate('user', 'items', doc).ok).toBe(true);
    expect(t.w.firmData.ui.user.items).toEqual(t.server.user().items);
    expect(t.w.ycLauncher.effectiveRegistry().filter((e) => e.group === 'Mine').map((e) => e.id)).toEqual(['user:leads', 'user:intake', 'user:court-site']);
    expect(t.panel().querySelector('.yle-save').disabled).toBe(true);           // nothing left to save
    t.panel().querySelector('.yle-cancel').click();
    await t.flush();
    expect([t.panel().hidden, t.confirms, t.server.puts.length]).toEqual([true, [], 3]);   // closes without asking
  });

  test('validation: name, icon, the address (https only, never a shell-only page), a chosen view / tool — nothing added', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    const commit = () => t.mb().querySelector('[data-act="mb-commit"]').click();
    t.fill({ label: '', icon: 'Bad Icon', type: 'view' });
    commit();
    expect([t.fieldErr('label'), t.fieldErr('icon'), t.fieldErr('key')]).toEqual(['Give it a name', 'Choose an icon', 'Choose a saved view']);   // the icon is chosen, not typed (S6a)
    t.fill({ label: 'x', icon: 'star', type: 'url', href: 'http://x.example/' });
    commit();
    expect(t.fieldErr('href')).toMatch(/Start it with https:\/\//);
    t.fill({ href: '//evil.example' }); commit();
    expect(t.fieldErr('href')).toMatch(/another website/);
    t.fill({ href: '/tool/clio-code' }); commit();
    expect(t.fieldErr('href')).toMatch(/only works inside YisraCase/);
    t.fill({ href: 'https://u:p@x.example/' }); commit();
    expect(t.fieldErr('href')).toMatch(/usable https/);
    t.fill({ type: 'tool' }); commit();
    expect(t.fieldErr('key')).toBe('Choose a tool');
    expect(t.mbRows()).toEqual([]);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
  });

  test('ids: unique against buttons, ids the layout / shortcuts name, and retired; an unsaved id follows its name until placed; a saved id never changes', async () => {
    t = boot({ items: [VIEW], retired: ['user:court', 'user:court-2'],
      layout: { placed: { home: [{ item: 'user:intake' }] } }, shortcuts: { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'g' }, id: 'user:gone' }] } });
    await t.openEditor();
    await t.addButton({ label: 'My leads', icon: 'star', type: 'view', key: 'lead_followups' });        // user:leads is taken, but the name is "my leads"
    await t.addButton({ label: 'Leads', icon: 'star', type: 'view', key: 'lead_followups' });           // stored user:leads → -2
    // the rest stay unsaved: their own saves are refused (since L2 an add saves itself)
    t.server.fail.items = { status: 503, message: 'down' };
    await t.addButton({ label: 'Court', icon: 'gavel', type: 'url', href: 'https://x.example/' });     // retired court, court-2 → -3
    await t.addButton({ label: 'Intake', icon: 'c', type: 'tool', key: 'clio-code' });                 // named by the layout → -2
    await t.addButton({ label: 'Gone', icon: 'c', type: 'tool', key: 'clio-code' });                   // named by a shortcut → -2
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:leads', 'user:my-leads', 'user:leads-2', 'user:court-3', 'user:intake-2', 'user:gone-2']);
    expect(t.mbRows().map((r) => r.tags.includes('New'))).toEqual([false, false, false, true, true, true]);
    // an unsaved button's id follows its name…
    t.act('Court', 'mb-edit').click();
    expect(t.mb().querySelector('.ymb-id-line').textContent).toBe('Its id will be user:court-3, set from the name.');
    t.fill({ label: 'Docket' });
    t.mb().querySelector('[data-act="mb-commit"]').click();
    await t.flush();
    expect(t.mbRows()[3].id).toBe('user:docket');
    // …until it is placed: then it is frozen
    t.act('Docket', 'mb-home').click();
    t.act('Docket', 'mb-edit').click();
    t.fill({ label: 'Docket sheet' });
    t.mb().querySelector('[data-act="mb-commit"]').click();
    await t.flush();
    expect(t.mbRows()[3]).toMatchObject({ id: 'user:docket', name: 'Docket sheet' });
    // a saved one never changes
    t.act('My leads', 'mb-edit').click();
    expect(t.mb().querySelector('.ymb-id-line').textContent).toBe('Its id is user:leads (permanent).');
    t.fill({ label: 'Hot leads' });
    t.mb().querySelector('[data-act="mb-commit"]').click();
    await t.flush();
    expect(t.mbRows()[0]).toMatchObject({ id: 'user:leads', name: 'Hot leads' });
    delete t.server.fail.items;
    const before = t.server.puts.length;
    await t.save();
    expect(t.server.puts.slice(before).map((p) => p.body.config_key)).toEqual(['items', 'layout']);
    expect(t.server.puts[before].body.config.items.map((i) => i.id)).toEqual(['user:leads', 'user:my-leads', 'user:leads-2', 'user:docket', 'user:intake-2', 'user:gone-2']);
  });

  test('a saved button deleted in this session keeps its id taken: a new one with the same name gets another id (no re-pointing)', async () => {
    t = boot({ items: [{ ...VIEW, label: 'Leads' }] });          // placed nowhere, bound to nothing: only its stored id guards it
    await t.openEditor();
    t.act('Leads', 'mb-del').click();
    await t.flush();
    await t.addButton({ label: 'Leads', icon: 'star', type: 'url', href: 'https://x.example/' });
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:leads-2']);
    await t.save();
    expect(t.server.user().items).toEqual({ items: [expect.objectContaining({ id: 'user:leads-2' })], retired: ['user:leads'] });
  });

  test('review N1: a stored reference to a button that is gone (retired) is not carried into a new layout or shortcuts document', async () => {
    const OLD = { combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'o' }, id: 'user:old' };
    t = boot({ items: [VIEW], retired: ['user:old'], layout: { placed: { home: [{ item: 'user:old' }, { item: 'cases' }, { item: 'user:leads' }] } }, shortcuts: { bindings: [OLD] } });
    await t.openEditor('layout');
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);                            // opening changes nothing
    expect([...t.panel().querySelectorAll('.ysc-row')]).toHaveLength(0);         // not listed as a binding
    const row = [...t.panel().querySelectorAll('.yle-sec[data-sf="home"] .yle-rows > .yle-row')].find((li) => li.querySelector('.yle-name').textContent === 'My leads');
    row.querySelector('[data-act="up"]').click();                                 // edit Home…
    t.panel().querySelector('.yle-tab[data-pane="shortcuts"]').click();          // …and the shortcuts
    t.panel().querySelector('.ysc-sec [data-act="sc-open"]').click();
    const q = t.panel().querySelector('.ysc-sec .yle-pick-q');
    q.value = 'tasks'; q.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    t.panel().querySelector('.ysc-sec .yle-pick-item[data-id="tasks"]').click();
    t.key(t.panel().querySelector('.ysc-capture'), CMD_CTRL('t'));
    t.panel().querySelector('.ysc-sec [data-act="sc-add"]').click();
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['layout', 'shortcuts']);
    expect(JSON.stringify(t.server.user().layout)).not.toMatch(/user:old/);
    expect(t.server.user().shortcuts.bindings.map((b) => b.id)).toEqual(['tasks']);
  });

  test('review N2: a stale retired id in the layout is not a new button — the layout is sent, not held, when the buttons fail', async () => {
    t = boot({ items: [VIEW], retired: ['user:old'], layout: { removed: { home: ['user:old'] } } });
    await t.openEditor('layout');
    const row = [...t.panel().querySelectorAll('.yle-sec[data-sf="home"] .yle-rows > .yle-row')].find((li) => li.querySelector('.yle-name').textContent === 'Contacts');
    row.querySelector('[data-act="hide"]').click();                              // layout dirty; it still names user:old in removed
    t.panel().querySelector('.yle-tab[data-pane="buttons"]').click();
    await t.flush();
    t.act('My leads', 'mb-up');                                                 // (no-op: first row)
    t.server.fail.items = { status: 503, message: 'down' };                      // the new button stays unsaved (L2: its own save refused)
    await t.addButton({ label: 'New one', icon: 'star', type: 'url', href: 'https://x.example/' });
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'items', 'layout']);   // sent, not held
    expect(t.panel().querySelector('.yle-banner').textContent).not.toMatch(/not sent/);
  });

  test('"Add to Home" / "Add to sidebar" append a new button to that surface in the same session; the layout tab shows it', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.server.fail.items = { status: 503, message: 'down' };                      // unsaved, as before L2: still placeable
    await t.addButton({ label: 'Leads', icon: 'star', type: 'view', key: 'lead_followups' });
    t.act('Leads', 'mb-home').click();
    expect(t.mbRows()[0].tags).toEqual(['New', 'On Home']);
    t.act('Leads', 'mb-sidebar').click();
    expect(t.mbRows()[0].tags).toEqual(['New', 'On Home', 'On sidebar']);
    expect(t.rowOf('Leads').querySelector('.ymb-place')).toBe(null);           // nowhere left to add it
    expect(t.layoutRows('home').slice(-1)).toEqual(['Leads']);
    expect(t.layoutRows('sidebar').slice(-1)).toEqual(['Leads']);
    expect(t.panel().querySelector('.yle-sec[data-sf="home"] .yle-row:last-child .yle-tag').textContent).toBe('Added');
    // the layout tab's own picker offers it too (it is in the editor's registry before it is saved)
    t.panel().querySelector('.yle-sec[data-sf="home"] .yle-row:last-child [data-act="remove"]').click();
    t.panel().querySelector('.yle-sec[data-sf="home"] [data-act="pick"]').click();
    expect(t.panel().querySelector('.yle-sec[data-sf="home"] .yle-pick-item[data-id="user:leads"]')).not.toBe(null);
  });

  test('delete a placed + bound button: it asks (naming where), then it is gone everywhere and saved at once (L2) — no dangling entry written', async () => {
    const SC = { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'l' }, id: 'user:leads' },
      { combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'e' }, id: 'calendar' }] };
    t = boot({ items: [VIEW, LINK], layout: { placed: { home: [{ item: 'user:leads' }, { item: 'cases' }], sidebar: [{ item: 'user:leads' }, { item: 'tasks' }] } }, shortcuts: SC });
    await t.openEditor();
    t.answer(false);
    t.act('My leads', 'mb-del').click();
    await t.flush();
    expect(t.confirms).toEqual(['Delete “My leads”? Note: it’s on your Home and sidebar and bound to ⌃⌘L. Deleting it takes it off there too. This can’t be undone.']);
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:leads', 'user:court']);   // kept: the user said no
    expect(t.server.puts).toEqual([]);
    t.answer(true);
    t.act('My leads', 'mb-del').click();
    await t.flush();
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:court']);
    expect(t.layoutRows('home')).not.toContain('My leads');
    expect(t.layoutRows('sidebar')).not.toContain('My leads');
    expect([...t.panel().querySelectorAll('.ysc-row .yle-name')].map((n) => n.textContent)).toEqual(['Calendar']);
    // the layout and shortcuts had no unsaved edit: the delete's own cascade is sent with it
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'layout', 'shortcuts']);
    expect(t.toasts).toEqual(['Deleted “My leads”']);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
    // a button nowhere placed or bound is asked about too (L2b: the delete is saved at once — no Cancel behind it)
    t.act('Court site', 'mb-del').click();
    await t.flush();
    expect(t.confirms.slice(2)).toEqual(['Delete “Court site”? This can’t be undone.']);
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'layout', 'shortcuts', 'items']);
    const [, lay, sc, items] = t.server.puts.map((p) => p.body.config);
    expect(items).toEqual({ items: [] });
    expect(JSON.stringify(lay)).not.toMatch(/user:/);
    expect(sc.bindings.map((b) => b.id)).toEqual(['calendar']);
    expect(t.server.user().items).toEqual({ items: [], retired: ['user:leads', 'user:court'] });   // retired by the server
    expect(t.panel().hidden).toBe(false);
    expect(t.panel().querySelector('.yle-save').disabled).toBe(true);           // nothing left to save
    t.panel().querySelector('.yle-cancel').click();
    await t.flush();
    expect([t.panel().hidden, t.confirms.length, t.server.puts.length]).toEqual([true, 3, 4]);   // closes without asking (3: the two deletes' questions)
  });

  test('L2: an add whose own save is refused says so, stays (tagged New, the tab dotted) and Save sends it again; nothing closes', async () => {
    t = boot({ items: [VIEW] });
    await t.openEditor();
    t.server.fail.items = { status: 503, message: 'Service Unavailable' };
    await t.addButton({ label: 'Court', icon: 'gavel', type: 'url', href: 'https://x.example/' });
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('Save failed: Service Unavailable. Your changes are still here.');
    expect([t.panel().hidden, t.panel().querySelector('#ylePane_buttons').hidden]).toEqual([false, false]);
    expect(t.mbRows().map((r) => [r.id, r.tags])).toEqual([['user:leads', []], ['user:court', ['New']]]);
    expect(t.panel().querySelector('.yle-tab[data-pane="buttons"] .yle-tab-dot').hidden).toBe(false);
    expect(t.toasts).toEqual([]);
    expect(t.server.user().items.items.map((i) => i.id)).toEqual(['user:leads']);
    delete t.server.fail.items;
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'items']);
    expect(t.server.user().items.items.map((i) => i.id)).toEqual(['user:leads', 'user:court']);
    expect(t.panel().hidden).toBe(true);
  });

  test('L2b: a list nobody placed is still asked about, naming what it holds; No keeps it and sends nothing', async () => {
    const BOX = { id: 'user:box', label: 'My box', icon: 'box-open', action: { type: 'drawer', items: ['tasks', 'user:leads'] } };
    t = boot({ items: [VIEW, BOX] });
    await t.openEditor();
    t.answer(false);
    t.act('My box', 'mb-del').click();
    await t.flush();
    expect(t.confirms).toEqual(['Delete “My box”? It is a list holding 2 items: they stay, only the list goes. This can’t be undone.']);
    expect([t.mbRows().map((r) => r.id), t.server.puts]).toEqual([['user:leads', 'user:box'], []]);
    t.answer(true);
    t.act('My box', 'mb-del').click();
    await t.flush();
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:leads']);
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items']);
  });

  test('L2: a delete never saves an edit the user did not ask to save — a layout with its own unsaved edit keeps the cascade for Save', async () => {
    const SC = { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'l' }, id: 'user:leads' }] };
    t = boot({ items: [VIEW, LINK], layout: { placed: { home: [{ item: 'user:leads' }, { item: 'cases' }] } }, shortcuts: SC });
    await t.openEditor('home');
    const row = [...t.panel().querySelectorAll('.yle-sec[data-sf="home"] .yle-rows > .yle-row')].find((li) => li.querySelector('.yle-name').textContent === 'Contacts');
    row.querySelector('[data-act="up"]').click();                                // an unsaved Home edit
    t.panel().querySelector('.yle-tab[data-pane="buttons"]').click();
    await t.flush();
    t.act('My leads', 'mb-del').click();
    await t.flush();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'shortcuts']);   // the layout waits
    expect(JSON.stringify(t.server.user().shortcuts)).not.toMatch(/user:leads/);
    expect(t.server.user().layout.placed.home[0]).toEqual({ item: 'user:leads' });          // stored as it was
    expect(t.panel().querySelector('.yle-tab[data-pane="home"] .yle-tab-dot').hidden).toBe(false);
    expect(t.layoutRows('home')).not.toContain('My leads');
    await t.save();
    expect(t.server.puts.slice(2).map((p) => p.body.config_key)).toEqual(['layout']);
    expect(JSON.stringify(t.server.user().layout)).not.toMatch(/user:leads/);
  });

  test('three documents, items FIRST; the items refused → a layout naming a new button is HELD (not sent); what saved is stored', async () => {
    t = boot({ items: [VIEW] });
    await t.openEditor();
    t.server.fail.items = { status: 400, message: 'Invalid', body: { status: 'error', errors: ['items[1]: <b>no</b>'] } };   // the add's own save (L2) refused too
    await t.addButton({ label: 'New one', icon: 'star', type: 'url', href: 'https://x.example/' });
    t.act('New one', 'mb-home').click();                                         // layout names the NEW button
    t.panel().querySelector('.yle-tab[data-pane="shortcuts"]').click();          // shortcuts: an edit naming nothing new
    t.panel().querySelector('.ysc-sec [data-act="sc-open"]').click();
    const q = t.panel().querySelector('.ysc-sec .yle-pick-q');
    q.value = 'tasks'; q.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    t.panel().querySelector('.ysc-sec .yle-pick-item[data-id="tasks"]').click();
    t.key(t.panel().querySelector('.ysc-capture'), CMD_CTRL('t'));
    t.panel().querySelector('.ysc-sec [data-act="sc-add"]').click();
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'items', 'shortcuts']);   // the add's, then Save's: layout held
    const banner = t.panel().querySelector('.yle-banner').textContent;
    expect(banner).toBe('The server refused your buttons. See the messages under My buttons. Your launcher layout was not sent: it uses a button that did not save. ' +
      'Your keyboard shortcuts were saved. Your changes are still here.');
    expect([...t.mb().querySelectorAll('.yle-errs li')].map((l) => l.textContent)).toEqual(['items[1]: <b>no</b>']);
    expect(t.mb().querySelector('.yle-errs b')).toBe(null);
    expect(t.panel().querySelector('#ylePane_buttons').hidden).toBe(false);       // a failed part on screen
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:leads', 'user:new-one']);  // every edit kept
    expect(t.layoutRows('home').slice(-1)).toEqual(['New one']);
    expect(t.server.user().shortcuts.bindings.map((b) => b.id)).toEqual(['tasks']);
    expect(t.w.firmData.ui.user.shortcuts).toEqual(t.server.user().shortcuts);
    expect(t.panel().querySelector('.yle-tab[data-pane="shortcuts"] .yle-tab-dot').hidden).toBe(true);   // stored now: clean
    // the retry sends what is still unsaved, items first
    delete t.server.fail.items;
    await t.save();
    expect(t.server.puts.slice(3).map((p) => p.body.config_key)).toEqual(['items', 'layout']);
    expect(t.panel().hidden).toBe(true);
    expect(t.d.querySelector('#tabHome [data-yc-shortcut="user:new-one"]').textContent).toBe('New one');
  });

  test('items saved, layout refused: the buttons are stored (tab clean), the layout keeps its edit and says so', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    await t.addButton({ label: 'Leads', icon: 'star', type: 'view', key: 'lead_followups' });
    t.act('Leads', 'mb-sidebar').click();
    t.server.fail.layout = { status: 503, message: 'Service Unavailable' };
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'layout']);
    expect(t.panel().querySelector('.yle-banner').textContent)                    // the buttons saved themselves (L2): Save sent the layout alone
      .toBe('Save failed: Service Unavailable. Your changes are still here.');
    expect(t.panel().querySelector('.yle-tab[data-pane="buttons"] .yle-tab-dot').hidden).toBe(true);
    expect(t.panel().querySelector('.yle-tab[data-pane="sidebar"] .yle-tab-dot').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-tab[data-pane="home"] .yle-tab-dot').hidden).toBe(true);
    expect(t.panel().querySelector('#ylePane_sidebar').hidden).toBe(false);   // the tab the failed edit is on
    expect(t.mbRows()[0]).toMatchObject({ id: 'user:leads', tags: ['On sidebar'] });   // saved: no "New"
    expect(t.layoutRows('sidebar').slice(-1)).toEqual(['Leads']);
    expect(t.w.ycLauncher.effectiveRegistry().some((e) => e.id === 'user:leads')).toBe(true);   // the shell took the buttons
    delete t.server.fail.layout;
    await t.save();
    expect(t.server.puts.slice(2).map((p) => p.body.config_key)).toEqual(['layout']);
  });

  test('escaping: a name with markup stays text — in the list, the layout tab, the shortcut list and the delete question', async () => {
    const evil = { ...VIEW, label: '<img src=x onerror=alert(1)>' };
    t = boot({ items: [evil], layout: { placed: { home: [{ item: 'user:leads' }] } },
      shortcuts: { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'l' }, id: 'user:leads' }] } });
    await t.openEditor();
    expect(t.mbRows()[0].name).toBe('<img src=x onerror=alert(1)>');
    expect(t.layoutRows('home')).toContain('<img src=x onerror=alert(1)>');
    expect([...t.panel().querySelectorAll('.ysc-row .yle-name')].map((n) => n.textContent)).toEqual(['<img src=x onerror=alert(1)>']);
    t.answer(false);
    t.act('<img src=x onerror=alert(1)>', 'mb-del').click();
    await t.flush();
    expect(t.confirms[0]).toMatch(/^Delete “<img src=x onerror=alert\(1\)>”\?/);
    await t.addButton({ label: '<b>bold</b>', icon: 'star', type: 'url', href: 'https://x.example/' });
    expect(t.mbRows()[1].name).toBe('<b>bold</b>');
    expect(t.panel().querySelector('img, b')).toBe(null);
  });

  test('while saving, edits are ignored (form, delete, move, add, Save); the selects and boxes are frozen', async () => {
    t = boot({ items: [VIEW, LINK] });
    await t.openEditor();
    t.server.hold = true;
    t.act('Court site', 'mb-up').click();                                        // a move saves itself (L2): held in flight
    await t.flush();
    expect(t.panel().querySelector('.yle-status').textContent).toBe('Saving…');
    t.act('My leads', 'mb-del').click();
    t.act('My leads', 'mb-up').click();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.panel().querySelector('.yle-save').click();
    expect(t.mb().querySelector('.ymb-form').hidden).toBe(true);
    expect([...t.mb().querySelectorAll('select')].every((s) => s.disabled)).toBe(true);
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:court', 'user:leads']);
    t.server.release();
    await t.flush();
    expect(t.server.puts).toHaveLength(1);
    expect(t.server.puts[0].body.config.items.map((i) => i.id)).toEqual(['user:court', 'user:leads']);
    expect(t.toasts).toEqual(['Order saved']);
    expect([t.panel().hidden, t.w.ycLayoutEditor.isDirty()]).toEqual([false, false]);
    expect([...t.mb().querySelectorAll('select')].some((s) => s.disabled)).toBe(false);   // unfrozen
  });

  test('the lists can\'t be read: the tab says so; a link button can still be added and saved', async () => {
    t = boot({ items: [VIEW], pickersFail: true });
    await t.openEditor();
    const note = t.mb().querySelector('.ymb-pickers-err');
    expect([note.hidden, note.textContent]).toEqual([false, expect.stringMatching(/Couldn’t load the lists of tools and saved views/)]);
    expect(t.mbRows()[0].sum).toBe('Saved view · lead_followups');
    await t.addButton({ label: 'Court', icon: 'gavel', type: 'url', href: 'https://x.example/' });
    await t.save();
    expect(t.server.puts[0].body.config.items.map((i) => i.id)).toEqual(['user:leads', 'user:court']);
  });

  test('an open form blocks Save (it says what to finish) and closing asks; Esc closes the form, not the editor', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ label: 'Half done' });
    expect(t.panel().querySelector('.yle-save').disabled).toBe(false);
    await t.save();
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('Finish the button you are editing first: press Add button, or Cancel.');
    expect(t.server.puts).toEqual([]);
    t.key(t.mb().querySelector('#ymb_label'), { key: 'Escape' });
    expect([t.mb().querySelector('.ymb-form').hidden, t.panel().hidden]).toEqual([true, false]);
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.answer(false);
    await t.w.ycLayoutEditor.close();
    expect(t.confirms).toEqual(['Discard your unsaved launcher changes?']);
    expect(t.panel().hidden).toBe(false);
    // Enter in a box adds
    t.fill({ label: 'Quick', icon: 'star', type: 'url', href: 'https://x.example/' });
    t.key(t.mb().querySelector('#ymb_href'), { key: 'Enter' });
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:quick']);
  });

  test('cap: 50 buttons — Add a button turns off and says so', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...LINK, id: 'user:b' + i, label: 'B' + i }));
    t = boot({ items: fifty });
    await t.openEditor();
    expect(t.mb().querySelector('[data-act="mb-open"]').disabled).toBe(true);
    expect(t.mb().querySelector('.yle-room').textContent).toMatch(/most buttons there can be \(50\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the round trip', () => {
  let t;
  afterEach(() => t && t.close());

  test('a new button added to Home and bound to a shortcut, saved in one go, renders on Home and fires on its combo — no reload', async () => {
    t = boot({ items: [] });
    const marker = t.w.__noReload = {};
    await t.openEditor();
    await t.addButton({ label: 'Leads', icon: 'star', type: 'view', key: 'lead_followups' });
    t.act('Leads', 'mb-home').click();
    t.panel().querySelector('.yle-tab[data-pane="shortcuts"]').click();
    t.panel().querySelector('.ysc-sec [data-act="sc-open"]').click();
    const q = t.panel().querySelector('.ysc-sec .yle-pick-q');
    q.value = 'leads'; q.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    t.panel().querySelector('.ysc-sec .yle-pick-item[data-id="user:leads"]').click();
    t.key(t.panel().querySelector('.ysc-capture'), CMD_CTRL('l'));
    t.panel().querySelector('.ysc-sec [data-act="sc-add"]').click();
    expect([...t.panel().querySelectorAll('.ysc-row')].map((li) => li.textContent)).toEqual([expect.stringMatching(/⌃⌘L.*Leads/)]);
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'layout', 'shortcuts']);
    for (const p of t.server.puts) expect([p.body.config_key, shape.validate('user', p.body.config_key, p.body.config).ok]).toEqual([p.body.config_key, true]);
    expect(t.panel().hidden).toBe(true);
    const tile = t.d.querySelector('#tabHome .home-grid [data-yc-shortcut="user:leads"]');
    expect(tile.textContent).toBe('Leads');
    expect(tile.querySelector('i').className).toBe('fa-solid fa-star fa-2xl');
    t.w.openMainTab('tabHome');
    const e = t.key(t.d.body, CMD_CTRL('l'));
    expect(e.defaultPrevented).toBe(true);
    expect([t.dlg().hidden, t.dlg().querySelector('iframe').getAttribute('src')]).toEqual([false, '/customView.html?key=lead_followups']);
    expect(t.w.__noReload).toBe(marker);
    expect(t.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the pure cores', () => {
  function bare() {
    const ctx = vm.createContext({ console: { error() {}, warn() {} }, URL });
    ctx.window = ctx;
    vm.runInContext(ICON_SRC, ctx);
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    vm.runInContext(YCALL_SRC, ctx);
    vm.runInContext(EDITOR_SRC, ctx);
    return { L: ctx.window.ycLauncher, E: ctx.window.ycLayoutEditor, LAY: ctx.window.DEFAULT_LAYOUTS };
  }

  test('itemSession: random edit sequences always write a document the real validator accepts; ids stay unique and never reuse retired / referenced ones', () => {
    const { L, E } = bare();
    let seed = 0xC0FFEE;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const LABELS = ['Leads', 'leads', 'Court', 'Court site', 'Old', '', ' x ', 'Ünïcödé', '<b>x</b>', 'y'.repeat(41), '!!!', 'Intake'];
    const field = () => ({
      label: pick(LABELS), icon: pick(['star', 'c', 'Bad', '']), type: pick(['view', 'tool', 'url', 'nope']),
      key: pick(['lead_followups', 'qa-intake-tool', '', 'X']), href: pick(['https://x.example/', '/manuals.html', '/tool/x', 'http://x', '']),
      size: pick(['compact', 'large']),
    });
    for (let run = 0; run < 300; run++) {
      const retired = ['user:old', 'user:leads-2'];   // never a stored button's id (the server never stores that)
      const refs = { 'user:intake': true };
      const stored = { items: [VIEW, LINK].slice(0, Math.floor(rnd() * 3)), retired };
      const s = E.itemSession({ stored, clean: L.cleanUserItem, refs: () => refs, pickers: null });
      const fresh = new Set();
      for (let step = 0; step < 25; step++) {
        const op = pick(['add', 'add', 'update', 'remove', 'move']);
        const n = s.list().length;
        if (op === 'add') { const r = s.add(field()); if (r.ok) fresh.add(r.id); }
        else if (op === 'update' && n) { const i = Math.floor(rnd() * n); const before = s.ids()[i]; const r = s.update(i, field()); if (r.ok && r.id !== before) { fresh.delete(before); fresh.add(r.id); } }
        else if (op === 'remove' && n) { const id = s.remove(Math.floor(rnd() * n)); fresh.delete(id); }
        else if (op === 'move' && n) s.move(Math.floor(rnd() * n), pick([-1, 1]));
        const doc = J(s.doc());                        // the PUT's JSON hop (the vm's objects are another realm's)
        const v = shape.validate('user', 'items', { ...doc, retired });
        if (!v.ok) throw new Error('invalid at run ' + run + ': ' + v.errors.join(' | '));
        expect(E.canonical(v.value.items)).toBe(E.canonical(doc.items));
        const ids = s.ids();
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of fresh) { expect(retired).not.toContain(id); expect(refs[id]).toBeUndefined(); }
        expect(s.isDirty()).toBe(E.canonical(doc.items) !== E.canonical(J(stored.items)));
      }
    }
  });

  test('layout dropId: removes the id from placed and removed on both surfaces, and never writes it back (even when it was not shown)', () => {
    const { L, E, LAY } = bare();
    const eff = L.computeEffective({ ui: { firm: {}, user: {} } });
    const stored = { placed: { home: [{ item: 'user:gone' }, { item: 'cases' }], sidebar: [{ item: 'tasks' }, { item: 'user:gone' }] }, removed: { home: ['user:gone'] } };
    const s = E.session({ stored, effective: eff, locked: [], base: LAY, registry: {}, groups: eff.groups });   // user:gone is not effective: not shown
    expect(s.isDirty()).toBe(false);
    expect(s.dropId('user:gone')).toBe(true);
    let doc = J(s.doc());
    expect(JSON.stringify(doc)).not.toMatch(/user:gone/);
    expect(s.isDirty()).toBe(true);
    // an edit and its undo would settle a surface back to stored — not one that named the dropped id
    s.move('home', 0, 1); s.move('home', 0, 1);
    doc = J(s.doc());
    expect(JSON.stringify(doc)).not.toMatch(/user:gone/);
    expect(shape.validate('user', 'layout', doc).ok).toBe(true);
    expect(s.dropId('user:none')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ui-custom S6a: the icon is CHOSEN in the shell's picker, never typed.
describe('S6a: My buttons choose their icon in the picker', () => {
  let t;
  afterEach(() => t && t.close());
  const pk = () => t.d.getElementById('ycIconPicker');
  const pkType = (s) => { const q = pk().querySelector('.yip-q'); q.value = s; q.dispatchEvent(new t.w.Event('input', { bubbles: true })); };

  test('no icon box to type in: a preview, its name and Choose…; the hidden value starts empty and says so', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    const f = t.mb().querySelector('[data-field="icon"]');
    expect(f.querySelector('#ymb_icon').type).toBe('hidden');
    expect(f.querySelectorAll('input[type="text"]')).toHaveLength(0);
    expect(f.querySelector('label').getAttribute('for')).toBe('ymb_icon_pick');
    expect(f.querySelector('.ymb-icon-name').textContent).toBe('None chosen yet');
    expect(f.querySelector('.ymb-icon-prev i').className).toBe('fa-solid fa-circle-question');
  });

  test('a brand icon (github): picked by search + Enter, previewed, saved, then drawn with fa-brands on Home, the sidebar, All and the palette', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ label: 'Code', type: 'url', href: 'https://github.com/' });
    const choose = t.mb().querySelector('[data-act="mb-icon-pick"]');
    choose.click();
    await t.flush();
    expect(t.w.ycIconPicker.isOpen()).toBe(true);
    expect(pk().querySelector('#yipTitle').textContent).toBe('Icon for “Code”');
    pkType('github');
    t.key(pk().querySelector('.yip-q'), { key: 'Enter' });
    await t.flush();
    expect(t.w.ycIconPicker.isOpen()).toBe(false);
    expect(t.d.activeElement).toBe(choose);
    expect(t.mb().querySelector('#ymb_icon').value).toBe('brands:github');
    expect(t.mb().querySelector('.ymb-icon-prev i').className).toBe('fa-brands fa-github');
    expect(t.mb().querySelector('.ymb-icon-name').textContent).toBe('github · Brands');
    t.mb().querySelector('[data-act="mb-commit"]').click();
    await t.flush();                                                             // its own save (L2)
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:code']);
    expect(t.rowOf('Code').querySelector('i').className).toBe('fa-brands fa-github yle-ic');
    t.act('Code', 'mb-home').click();
    t.act('Code', 'mb-sidebar').click();
    await t.save();
    const items = t.server.puts.find((p) => p.body.config_key === 'items').body.config;
    expect(items.items.map((i) => i.icon)).toEqual(['brands:github']);
    expect(shape.validate('user', 'items', items).ok).toBe(true);
    expect(t.server.user().items.items[0].icon).toBe('brands:github');
    expect(t.d.querySelector('#tabHome .home-grid [data-yc-shortcut="user:code"] i').className).toBe('fa-brands fa-github fa-2xl');
    expect(t.d.querySelector('#appSidebar [data-yc-shortcut="user:code"] i').className).toBe('fa-brands fa-github');
    expect(t.d.querySelector('#ycAllList .yc-all-item[data-yc-item="user:code"] i').className).toBe('fa-brands fa-github');
    t.w.ycAll.open(t.d);
    const pq = t.d.querySelector('#ycPalette .yc-pal-input');
    pq.value = 'code'; pq.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    // two rows read Code: this button and the registry's own Code item (terminal)
    const icons = [...t.d.querySelectorAll('#ycPalette .yc-pal-item')].filter((r) => r.querySelector('span').textContent === 'Code')
      .map((r) => r.querySelector('i').className).sort();
    expect(icons).toEqual(['fa-brands fa-github', 'fa-solid fa-terminal']);
    expect(t.errors).toEqual([]);
  });

  test('editing a saved button: its icon is highlighted; a regular icon replaces it; Esc in the picker keeps the form and the icon', async () => {
    t = boot({ items: [VIEW] });
    await t.openEditor();
    t.act('My leads', 'mb-edit').click();
    t.mb().querySelector('[data-act="mb-icon-pick"]').click();
    await t.flush();
    expect(pk().querySelector('.is-current').getAttribute('data-v')).toBe('star');
    t.key(pk().querySelector('.yip-q'), { key: 'Escape' });              // the picker's Esc, not the editor's
    await t.flush();
    expect([t.w.ycIconPicker.isOpen(), t.mb().querySelector('.ymb-form').hidden, t.panel().hidden]).toEqual([false, false, false]);
    expect(t.mb().querySelector('#ymb_icon').value).toBe('star');
    t.mb().querySelector('[data-act="mb-icon-pick"]').click();
    await t.flush();
    pkType('star');
    pk().querySelector('.yip-chip[data-fam="regular"]').click();
    pk().querySelector('.yip-tile').click();
    await t.flush();
    expect(t.mb().querySelector('#ymb_icon').value).toBe('regular:star');
    t.mb().querySelector('[data-act="mb-commit"]').click();
    await t.save();
    expect(t.server.user().items.items[0].icon).toBe('regular:star');
  });

  test('review N1: a drawer\'s own heading icon is drawn by family (brands:github)', () => {
    const DRAWER = { id: 'user:dr', label: 'Morning', icon: 'brands:github', action: { type: 'drawer', items: ['user:leads'] } };
    t = boot({ items: [VIEW, DRAWER] });
    t.w.ycLauncher.exec('user:dr');
    const d = t.d.getElementById('ycDrawer');
    expect(d.hidden).toBe(false);
    expect(d.querySelector('.yc-dr-head > i').className).toBe('fa-brands fa-github');
    expect(d.querySelector('.yc-dr-item[data-yc-item="user:leads"] i').className).toBe('fa-solid fa-star');
  });

  test('review N3: committing a button with no icon focuses its Choose… (the value itself is hidden)', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ label: 'No icon yet', type: 'url', href: 'https://x.example/' });
    t.mb().querySelector('[data-act="mb-commit"]').click();
    expect(t.fieldErr('icon')).toBe('Choose an icon');
    expect(t.d.activeElement).toBe(t.mb().querySelector('#ymb_icon_pick'));
  });

  test('a pick that lands after the form closed is dropped (the form moved on)', async () => {
    t = boot({ items: [] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.mb().querySelector('[data-act="mb-icon-pick"]').click();
    await t.flush();
    const tile = pk().querySelector('.yip-tile');
    t.mb().querySelector('[data-act="mb-cancel"]').click();          // (a script closing the form under the picker)
    tile.click();
    await t.flush();
    expect(t.mb().querySelector('#ymb_icon').value).toBe('');           // the pick went nowhere
    expect(t.mb().querySelector('.ymb-icon-name').textContent).toBe('None chosen yet');
    t.mb().querySelector('[data-act="mb-open"]').click();
    expect(t.mb().querySelector('#ymb_icon').value).toBe('');
  });
});
