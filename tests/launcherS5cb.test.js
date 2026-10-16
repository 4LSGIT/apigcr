// tests/launcherS5cb.test.js
//
/**
 * ui-custom S5c-b — buttons that open as a TAB, and the legacy custom tab
 * becoming a button. The client side, run for real in jsdom: the page's own
 * ycLauncher, tool dialog, button tab (ycButtonTabsJs), openMainTab /
 * updateSidebarActive, applyCustomTab and the WORKSPACE URL serializer /
 * restore validator, with the real ycAll.js and ycLayoutEditor.js over a mock
 * API whose PUT runs the REAL uiConfigService.write in memory.
 *
 *   1. The host: exec of a tab button opens #tabUserItem on its page (the
 *      dialog's URL), titled with the label (text) and its icon; switching
 *      keeps each page (same frame); a 4th evicts the least recently used
 *      (once-per-load notice); the sidebar shortcut of the shown button is
 *      lit, and other tabs' highlight still works; ycTool close / resize are
 *      no-ops from a tab page; sync drops a deleted / re-pointed button's page.
 *   2. The URL: the button tab is never written to ?open=, and a restore of
 *      it lands on Home.
 *   3. The editor: "Opens in" writes present:'tab' (no size); the legacy
 *      custom tab's conversion — creates the button where custom was, clears
 *      the old tab after the buttons and layout saved, refuses other srcs with
 *      a reason, is idempotent, and retries / holds the clear on failures.
 *   4. The pure cores: legacyTab and session.replace.
 *
 * Mutation-checked (see the S5c-b worker report).
 *
 * Run:  npx jest tests/launcherS5cb.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const svc = require('../services/uiConfigService');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DIALOG_SRC = RAW.match(/<script id="ycToolDialogJs">([\s\S]*?)<\/script>/)[1];
const BT_SRC = RAW.match(/<script id="ycButtonTabsJs">([\s\S]*?)<\/script>/)[1];
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS5cb: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
function fnSrc(name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(RAW);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = RAW.indexOf('{', RAW.indexOf(')', m.index)); j < RAW.length; j++) {
    if (RAW[j] === '{') depth++;
    else if (RAW[j] === '}' && --depth === 0) return RAW.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}
const pick = (re) => { const m = re.exec(RAW); if (!m) throw new Error('not found: ' + re); return m[0]; };
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const BT_TAB = slice('  <div id="tabUserItem" class="tab-main">', '\n\n');
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CUSTOM_SRC = slice('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = fnSrc('currentMainTabId');
const WS_SRC = [pick(/const YC_LABEL_KEY = "ycFileLabels";/), pick(/var wsMainRest = \{\};/), pick(/var wsPanelRest = \{\};/),
  pick(/var WS_DRILL_SURFACE = \{[^}]*\};/),
  ...['wsDrillPanels', 'wsOpenPanel', 'wsTabRest', 'wsSetFileRest', 'wsOpenTarget', 'wsMainTabAllowed', 'currentOpenFilesUrl'].map(fnSrc)].join('\n');
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];

const J = (x) => JSON.parse(JSON.stringify(x));

// ── fixtures ──
const TVIEW = { id: 'user:leads', label: 'My leads', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'tab' } };
const TTOOL = { id: 'user:intake', label: 'Intake', icon: 'brands:github', action: { type: 'tool', key: 'qa-intake-tool', present: 'tab' } };
const TOOL3 = { id: 'user:third', label: 'Third', icon: 'gavel', action: { type: 'tool', key: 'clio-code', present: 'tab' } };
const VIEW4 = { id: 'user:fourth', label: 'Fourth', icon: 'flag', action: { type: 'view', key: 'upcoming_hearings', present: 'tab' } };
const MODAL = { id: 'user:modal', label: 'Modal one', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' } };
const RO = { items: [], hidden: [], locked: [], renames: {} };
const PICKERS = { status: 'success',
  tools: [{ key: 'qa-intake-tool', title: 'Intake checklist' }, { key: 'clio-code', title: 'Get Clio Code' }, { key: 'call-review', title: 'Call Review' }],
  views: [{ key: 'lead_followups', title: 'Leads follow ups' }, { key: 'upcoming_hearings', title: 'Upcoming hearings' }] };
const CT_TOOL = { src: '/tool/call-review', icon: 'headset', title: 'Call Review', loadFunc: '' };

function memDb() {
  const rows = new Map();
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

function boot({ items = null, layout = null, customTab = null, withHost = true } = {}) {
  const REG = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return c.FEATURE_REGISTRY; })();
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <script id="ycToolDialogJs">${DIALOG_SRC}</script>
    ${withHost ? `<script id="ycButtonTabsJs">${BT_SRC}</script>` : ''}
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script><div class="sb-item" id="sbAll" data-tab="tabAll" onclick="openMainTab('tabAll')"></div></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    ${ALL_TAB}
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${BT_TAB}
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script></div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script></div>
  </body></html>`;
  const errors = [];
  // an exception thrown in a handler (a click) is a jsdomError, not a console call: collect those too
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.example/', virtualConsole });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'platform', { get: () => 'MacIntel', configurable: true });
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const urls = [];
  w.__urls = urls;
  const toasts = [];
  w.Toast = { fire: (o) => { toasts.push(o); } };
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() { __urls.push(currentOpenFilesUrl()); }\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + CUSTOM_SRC + DRILL_SRC + WS_SRC);
  w.open = () => null;
  const userDoc = () => ({ ...(items ? { items: J({ items }) } : {}), ...(layout ? { layout: J(layout) } : {}) });
  w.firmData = { ui: { firm: { registry_overrides: J(RO) }, user: userDoc() }, currentUser: { user: 9, user_custom_tab: customTab ? J(customTab) : null } };
  w.user = w.firmData.currentUser;
  const db = memDb();
  for (const [k, v] of Object.entries(userDoc())) db.rows.set(`user|9|${k}`, JSON.stringify(v));
  const server = { calls: [], fail: {}, db };
  const userNow = () => { const u = {}; for (const [k, v] of db.rows) { const [, uid, key] = k.split('|'); if (uid === '9') u[key] = JSON.parse(v); } return u; };
  server.user = userNow;
  w.apiSend = (url, method, body) => {
    if (method === 'GET' || method == null) {
      if (url === '/api/ui-config/pickers') return Promise.resolve(J(PICKERS));
      return Promise.resolve({ status: 'success', firm: { registry_overrides: J(RO) }, user: userNow(), can_edit_firm: false });
    }
    if (url === '/api/auth/update-custom-tab') {
      server.calls.push({ call: 'POST custom-tab', body: J(body) });
      const f = server.fail.customTab;
      if (f) return Promise.reject(Object.assign(new Error(f.message || 'refused'), f));
      return Promise.resolve({ status: 'success', user_custom_tab: null });
    }
    server.calls.push({ call: 'PUT ' + body.config_key, body: J(body) });
    const f = server.fail[body.config_key];
    if (f) return Promise.reject(Object.assign(new Error(f.message || 'refused'), f));
    return svc.write(db, J(body), { type: 'jwt', userId: 9, roles: ['staff'] }).then(
      (r) => ({ status: 'success', ...J(r) }),
      (e) => Promise.reject(Object.assign(new Error(e.message), { status: e.status || 500, body: { status: 'error', message: e.message, errors: e.errors } })));
  };
  w.confirm = () => true;
  // loadUserContext's order: the custom tab, then the launcher
  w.applyCustomTab(customTab ? J(customTab) : null);
  w.ycLauncher.applyAccess({ isAdmin: false, denied: [], customTab: customTab ? J(customTab) : null, ui: w.firmData.ui, roles: ['staff'] });
  w.eval(YCALL_SRC);
  w.eval(EDITOR_SRC);
  const d = w.document;
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const tab = () => w.currentMainTabId();
  const host = () => d.getElementById('tabUserItem');
  const frames = () => [...host().querySelectorAll('iframe')];
  const shownFrame = () => frames().filter((f) => !f.hidden);
  const lastOpen = () => new w.URL(urls[urls.length - 1]).searchParams.get('open');
  const sbActive = () => [...d.querySelectorAll('#appSidebar .sb-item.active')].map((e) => e.getAttribute('data-yc-shortcut') || e.getAttribute('data-tab') || e.id);
  const panel = () => d.getElementById('ycLayoutEditor');
  const mb = () => panel().querySelector('.ymb-sec');
  const legacyBox = () => mb().querySelector('.ymb-legacy');
  const mbRows = () => [...mb().querySelectorAll('.ymb-row')].map((li) => ({
    id: li.getAttribute('data-id'), name: li.querySelector('.yle-name').textContent, sum: li.querySelector('.ymb-sum').textContent,
    tags: [...li.querySelectorAll('.yle-tag')].map((t) => t.textContent) }));
  const openEditor = async (section = 'buttons') => { const ok = await w.ycLayoutEditor.open({ section }); await flush(); return ok; };
  const setVal = (id, v) => {
    const n = mb().querySelector('#ymb_' + id);
    n.value = v;
    n.dispatchEvent(new w.Event(n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const save = async () => { panel().querySelector('.yle-save').click(); await flush(); };
  const surface = (sf) => {
    // the rendered ids, in order: default elements by registry id, neutral shortcuts by data-yc-shortcut
    const L = w.ycLauncher;
    const byEl = new Map();
    for (const e of L.effectiveRegistry()) { const m = L.elementsOf(e.id) || {}; if (m[sf]) byEl.set(m[sf], e.id); }
    const root = sf === 'home' ? d.querySelector('#tabHome .home-grid') : d.getElementById('appSidebar');
    return [...root.querySelectorAll(sf === 'home' ? '.home-btn' : '.sb-item')]
      .filter((el) => !el.hasAttribute('data-yc-unplaced') && !el.hasAttribute('data-yc-denied') && el.style.display !== 'none')
      .map((el) => el.getAttribute('data-yc-shortcut') || byEl.get(el)).filter(Boolean);
  };
  return { w, d, server, errors, toasts, urls, flush, tab, host, frames, shownFrame, lastOpen, sbActive, panel, mb, legacyBox, mbRows,
    openEditor, setVal, save, surface, close: () => w.close() };
}

// The editor's Home & sidebar rows: name + what its button does (hide = a default item, remove = one the user added).
function editorRows(t, sf) {
  return [...t.panel().querySelectorAll(`.yle-sec[data-sf="${sf}"] .yle-rows > .yle-row`)].map((li) => ({
    name: (li.querySelector('.yle-name') || {}).textContent,
    act: li.querySelector('[data-act="hide"]') ? 'hide' : li.querySelector('[data-act="remove"]') ? 'remove' : null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
describe('the button tab (exec of a tab button, for real)', () => {
  let t;
  afterEach(() => t && t.close());

  test('opens #tabUserItem on the dialog\'s URL, titled with the label and drawn with its icon; no dialog, no window', () => {
    t = boot({ items: [TVIEW, TTOOL] });
    let opened = 0;
    t.w.open = () => { opened++; return null; };
    expect(t.w.ycLauncher.exec('user:leads')).toBe(true);
    expect(t.tab()).toBe('tabUserItem');
    expect(t.frames().map((f) => f.getAttribute('src'))).toEqual(['/customView.html?key=lead_followups']);
    expect(t.host().querySelector('.yc-bt-title').textContent).toBe('My leads');
    expect(t.frames()[0].title).toBe('My leads');
    expect(t.host().querySelector('.yc-bt-icon').className).toBe('yc-bt-icon fa-solid fa-star');
    expect(t.w.ycLauncher.exec('user:intake')).toBe(true);
    expect(t.frames().map((f) => f.getAttribute('src'))).toEqual(['/customView.html?key=lead_followups', '/tool/qa-intake-tool']);
    expect(t.host().querySelector('.yc-bt-icon').className).toBe('yc-bt-icon fa-brands fa-github');
    expect(t.host().querySelector('.yc-bt-title').textContent).toBe('Intake');
    const dlg = t.d.getElementById('ycToolDialog');
    expect(dlg ? dlg.hidden : true).toBe(true);
    expect(opened).toBe(0);
    // a modal button still opens the dialog, and leaves the tab's pages alone
    t = (t.close(), boot({ items: [TVIEW, MODAL] }));
    t.w.ycLauncher.exec('user:leads');
    expect(t.w.ycLauncher.exec('user:modal')).toBe(true);
    expect(t.d.getElementById('ycToolDialog').hidden).toBe(false);
    expect(t.frames()).toHaveLength(1);
  });

  test('switching keeps each page (the same frame element), showing only the active one', () => {
    t = boot({ items: [TVIEW, TTOOL] });
    t.w.ycLauncher.exec('user:leads');
    const leads = t.frames()[0];
    t.w.ycLauncher.exec('user:intake');
    const intake = t.frames()[1];
    expect(t.shownFrame()).toEqual([intake]);
    t.w.openMainTab('tabCases');
    expect(t.w.ycButtonTabs.active()).toBe(null);
    t.w.ycLauncher.exec('user:leads');
    expect(t.frames()).toEqual([leads, intake]);          // nothing reloaded
    expect(t.shownFrame()).toEqual([leads]);
    expect(t.w.ycButtonTabs.active()).toBe('user:leads');
    expect(t.host().querySelector('.yc-bt-title').textContent).toBe('My leads');
    expect(t.w.ycButtonTabs.alive()).toEqual(['user:intake', 'user:leads']);
  });

  test('at most 3 pages stay open: a 4th evicts the least recently used; the notice comes once; it reloads when opened again', () => {
    t = boot({ items: [TVIEW, TTOOL, TOOL3, VIEW4] });
    const L = t.w.ycLauncher;
    L.exec('user:leads'); L.exec('user:intake'); L.exec('user:third');
    const first = t.frames()[0];
    L.exec('user:intake');                                  // intake becomes the most recent: leads is now the LRU
    expect(t.toasts).toEqual([]);
    L.exec('user:fourth');
    expect(t.w.ycButtonTabs.alive()).toEqual(['user:third', 'user:intake', 'user:fourth']);
    expect(first.isConnected).toBe(false);                  // its page unloaded
    expect(t.frames().map((f) => f.getAttribute('src'))).toEqual(['/tool/qa-intake-tool', '/tool/clio-code', '/customView.html?key=upcoming_hearings']);
    expect(t.toasts.map((x) => x.titleText)).toEqual(['Up to 3 buttons stay open as tabs: “My leads” was closed, and loads again when you open it.']);
    expect(t.toasts[0].title).toBeUndefined();              // text, never markup
    L.exec('user:leads');                                   // back: a NEW frame; third is evicted now, silently
    expect(t.frames()).toHaveLength(3);
    expect(t.frames().includes(first)).toBe(false);
    expect(t.w.ycButtonTabs.alive()).toEqual(['user:intake', 'user:fourth', 'user:leads']);
    expect(t.toasts).toHaveLength(1);
  });

  test('the sidebar shortcut of the shown button is lit; switching moves it; other tabs light as before', () => {
    t = boot({ items: [TVIEW, TTOOL], layout: { placed: { sidebar: [{ item: 'user:leads' }, { item: 'user:intake' }, { item: 'cases' }] } } });
    t.w.ycLauncher.exec('user:leads');
    expect(t.sbActive()).toEqual(['user:leads']);
    t.w.ycLauncher.exec('user:intake');
    expect(t.sbActive()).toEqual(['user:intake']);
    t.w.openMainTab('tabCases');
    expect(t.sbActive()).toEqual(['tabCases']);
    t.w.openMainTab('tabHome');
    expect(t.sbActive()).toEqual(['tabHome']);
    // a button tab whose button is not on the sidebar lights nothing
    t.w.ycLauncher.exec('user:leads');
    t.w.ycButtonTabs.open('user:elsewhere', '/tool/x', { label: 'Elsewhere' });
    expect(t.sbActive()).toEqual([]);
  });

  test('escaping: a label with markup is text in the heading and the frame title; a junk icon draws circle-question', () => {
    const evil = '<img src=x onerror="window.__pwn=1">';
    t = boot({ items: [{ ...TVIEW, label: evil.slice(0, 40) }] });
    t.w.ycLauncher.exec('user:leads');
    expect(t.host().querySelector('.yc-bt-title').textContent).toBe(evil.slice(0, 40));
    expect(t.host().querySelector('img')).toBe(null);
    t.w.ycButtonTabs.open('user:x', '/tool/x', { label: evil, icon: 'x" onmouseover="alert(1)' });
    expect(t.host().querySelector('.yc-bt-title').textContent).toBe(evil);
    expect(t.host().querySelector('.yc-bt-icon').className).toBe('yc-bt-icon fa-solid fa-circle-question');
    expect(t.w.__pwn).toBeUndefined();
  });

  test('the host refuses anything but a same-origin /path; exec without a host refuses', () => {
    t = boot({ items: [TVIEW] });
    for (const url of ['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', '/\\evil', '/a b', '', null]) {
      expect([url, t.w.ycButtonTabs.open('user:x', url, { label: 'X' })]).toEqual([url, false]);
    }
    expect(t.frames()).toEqual([]);
    expect(t.tab()).not.toBe('tabUserItem');
    t.close();
    t = boot({ items: [TVIEW], withHost: false });
    expect(t.w.ycLauncher.exec('user:leads')).toBe(false);
    expect(t.errors.some((e) => /no button tab on this page/.test(e))).toBe(true);
  });

  test('ycTool from a page in a tab: close() and resize() are no-ops (false); exec still works', () => {
    t = boot({ items: [TVIEW, TTOOL] });
    t.w.ycLauncher.exec('user:intake');
    const win = t.shownFrame()[0].contentWindow;
    expect(t.w.ycTool.close(win)).toBe(false);
    expect(t.w.ycTool.resize('compact', win)).toBe(false);
    expect(t.tab()).toBe('tabUserItem');
    expect(t.shownFrame()).toHaveLength(1);
    expect(t.w.ycTool.exec('user:leads')).toBe(true);
    expect(t.w.ycButtonTabs.active()).toBe('user:leads');
  });

  test('review S2: applyAccess never moves the user when no button tab is on screen (none open, or one alive but not shown)', () => {
    t = boot({ items: [TVIEW, TTOOL] });
    const L = t.w.ycLauncher;
    t.w.openMainTab('tabCases');
    L.applyAccess({ ui: J(t.w.firmData.ui) });
    expect(t.tab()).toBe('tabCases');
    L.exec('user:leads');
    t.w.openMainTab('tabCases');
    L.applyAccess({ ui: J(t.w.firmData.ui) });
    expect([t.tab(), t.w.ycButtonTabs.alive()]).toEqual(['tabCases', ['user:leads']]);
    // ...even when that alive page's button is the one dropped
    const ui = J(t.w.firmData.ui);
    ui.user.items.items = [TTOOL];
    L.applyAccess({ ui });
    expect([t.tab(), t.w.ycButtonTabs.alive()]).toEqual(['tabCases', []]);
  });

  test('sync: a deleted button\'s page goes (on screen → Home); a re-pointed one reloads; a rename follows', () => {
    t = boot({ items: [TVIEW, TTOOL] });
    const L = t.w.ycLauncher;
    L.exec('user:leads'); L.exec('user:intake');
    const leadsFrame = t.frames()[0];
    // rename intake (on screen) and re-point leads (another view)
    const ui1 = J(t.w.firmData.ui);
    ui1.user.items.items = [{ ...TVIEW, action: { ...TVIEW.action, key: 'upcoming_hearings' } }, { ...TTOOL, label: 'Intake 2' }];
    L.applyAccess({ ui: ui1 });
    expect(t.w.ycButtonTabs.alive()).toEqual(['user:intake']);
    expect(leadsFrame.isConnected).toBe(false);
    expect(t.host().querySelector('.yc-bt-title').textContent).toBe('Intake 2');
    expect(t.tab()).toBe('tabUserItem');
    L.exec('user:leads');
    expect(t.shownFrame()[0].getAttribute('src')).toBe('/customView.html?key=upcoming_hearings');
    // a button turned modal / deleted while on screen: its page goes and Home opens
    const ui2 = J(ui1);
    ui2.user.items.items = [{ ...ui1.user.items.items[0], action: { type: 'view', key: 'upcoming_hearings', present: 'modal' } }];
    L.applyAccess({ ui: ui2 });
    expect(t.w.ycButtonTabs.alive()).toEqual([]);
    expect(t.frames()).toEqual([]);
    expect(t.tab()).toBe('tabHome');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the WORKSPACE URL skips the button tab', () => {
  let t;
  afterEach(() => t && t.close());

  test('never written to ?open= (a plain tab is — the harness bites)', () => {
    t = boot({ items: [TVIEW] });
    t.w.enableWorkspaceUrlSync && t.w.enableWorkspaceUrlSync();
    t.w.openMainTab('tabCases');
    expect(t.lastOpen()).toBe('tabCases');
    t.w.ycLauncher.exec('user:leads');
    expect(t.tab()).toBe('tabUserItem');
    expect(t.lastOpen()).toBe(null);
    expect(t.urls[t.urls.length - 1]).toBe('https://app.example/');
    expect(t.urls.join(' ')).not.toMatch(/user|leads|tabUserItem/);
  });

  test('a restore of it lands on Home — even if a sidebar element claimed the tab', () => {
    t = boot({ items: [TVIEW], layout: { placed: { sidebar: [{ item: 'user:leads' }] } } });
    expect(t.w.wsOpenTarget('tabUserItem')).toEqual({ tab: 'tabHome', rest: '' });
    expect(t.w.wsOpenTarget('tabUserItem~user:leads')).toEqual({ tab: 'tabHome', rest: '' });
    expect(t.w.wsMainTabAllowed('tabCases')).toBe(true);
    // belt and braces: a registry element pointing at it is still refused
    t.d.querySelector('#appSidebar .sb-item[data-tab="tabCases"]').setAttribute('data-tab', 'tabUserItem');
    expect(t.w.wsMainTabAllowed('tabUserItem')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the editor: "Opens in" a tab', () => {
  let t;
  afterEach(() => t && t.close());

  test('three choices; A tab writes present:"tab" with no size; editing shows it; back to compact writes the dialog again', async () => {
    t = boot();
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    const opts = [...t.mb().querySelectorAll('#ymb_size option')].map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([['large', 'A dialog, large'], ['compact', 'A dialog, compact'], ['tab', 'A tab']]);
    expect(t.mb().querySelector('[data-field="size"] label').textContent).toBe('Opens in');
    t.setVal('type', 'tool'); t.setVal('label', 'Intake'); t.setVal('icon', 'star'); t.setVal('key', 'qa-intake-tool'); t.setVal('size', 'tab');
    t.mb().querySelector('[data-act="mb-commit"]').click();
    expect(t.mbRows().map((r) => r.sum)).toEqual(['Tool · Intake checklist (opens as a tab)']);
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items']);
    expect(t.server.calls[0].body.config.items[0].action).toEqual({ type: 'tool', key: 'qa-intake-tool', present: 'tab' });
    // the shell opens it as a tab, no reload
    expect(t.w.ycLauncher.exec('user:intake')).toBe(true);
    expect(t.tab()).toBe('tabUserItem');
    // edit: the select shows A tab; compact turns it back into the dialog
    await t.openEditor();
    t.mb().querySelector('.ymb-row [data-act="mb-edit"]').click();
    expect(t.mb().querySelector('#ymb_size').value).toBe('tab');
    t.setVal('size', 'compact');
    t.mb().querySelector('[data-act="mb-commit"]').click();
    await t.save();
    expect(t.server.calls[1].body.config.items[0].action).toEqual({ type: 'tool', key: 'qa-intake-tool', present: 'modal', size: 'compact' });
    expect(t.w.ycButtonTabs.alive()).toEqual([]);           // its tab page went with the change
  });

  test('a link has no "Opens in" (it is always a new window)', async () => {
    t = boot();
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.setVal('type', 'url');
    expect(t.mb().querySelector('[data-field="size"]').hidden).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the editor: the legacy custom tab becomes a button', () => {
  let t;
  afterEach(() => t && t.close());

  test('tool src: one click adds a tab button where custom was (Home and sidebar); Save writes items, layout, then clears the old tab; custom is gone', async () => {
    t = boot({ customTab: CT_TOOL });
    const homeBefore = t.surface('home'), sideBefore = t.surface('sidebar');
    expect(homeBefore).toContain('custom');
    expect(sideBefore).toContain('custom');
    await t.openEditor();
    const rowsBefore = { home: editorRows(t, 'home'), sidebar: editorRows(t, 'sidebar') };
    const box = t.legacyBox();
    expect(box.hidden).toBe(false);
    expect(box.querySelector('.ymb-legacy-text').textContent).toBe('You have a custom tab, “Call Review” (Settings → My Custom Tab). ' +
      'Make it one of your buttons: it keeps opening as a tab, in the same places on your Home and sidebar. ' +
      'A keyboard shortcut or drawer entry that opened the custom tab stops working: point it at the new button.');
    box.querySelector('[data-act="mb-legacy"]').click();
    expect(t.mbRows()).toEqual([{ id: 'user:call-review', name: 'Call Review', sum: 'Tool · Call Review (opens as a tab)', tags: ['New', 'On Home', 'On sidebar'] }]);
    expect(box.querySelector('[data-act="mb-legacy"]').hidden).toBe(true);
    expect(box.querySelector('.ymb-legacy-text').textContent).toMatch(/^When you save, your custom tab “Call Review” becomes your button “Call Review”/);
    // the Home & sidebar tab shows what Save leaves: ONE "Call Review", the new button (removable, not hideable) in custom's slot
    for (const sf of ['home', 'sidebar']) {
      const now = editorRows(t, sf);
      expect([sf, now.map((r) => r.name)]).toEqual([sf, rowsBefore[sf].map((r) => r.name)]);
      const at = now.findIndex((r) => r.name === 'Call Review');
      expect([sf, rowsBefore[sf][at].act, now[at].act, now.filter((r) => r.name === 'Call Review').length]).toEqual([sf, 'hide', 'remove', 1]);
    }
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items', 'PUT layout', 'POST custom-tab']);
    expect(t.server.calls[0].body.config.items).toEqual([{ id: 'user:call-review', label: 'Call Review', icon: 'headset',
      action: { type: 'tool', key: 'call-review', present: 'tab' } }]);
    expect(t.server.calls[2].body).toEqual({ clear: true });
    expect(t.panel().hidden).toBe(true);
    // the shell: the old tab is cleared and gone; the button sits where custom was
    expect(t.w.firmData.currentUser.user_custom_tab).toBe(null);
    expect(t.w.ycLauncher.effectiveRegistry().some((e) => e.id === 'custom')).toBe(false);
    expect(t.d.getElementById('sbCustom').style.display).toBe('none');
    expect(t.surface('home')).toEqual(homeBefore.map((id) => (id === 'custom' ? 'user:call-review' : id)));
    expect(t.surface('sidebar')).toEqual(sideBefore.map((id) => (id === 'custom' ? 'user:call-review' : id)));
    // and it opens as a tab
    t.d.querySelector('#appSidebar [data-yc-shortcut="user:call-review"]').click();
    expect(t.tab()).toBe('tabUserItem');
    expect(t.shownFrame()[0].getAttribute('src')).toBe('/tool/call-review');
    expect(t.sbActive()).toEqual(['user:call-review']);
  });

  test('view src: the button is a saved view opening as a tab', async () => {
    t = boot({ customTab: { src: '/customView.html?key=lead_followups', icon: 'list-check', title: 'Follow Ups', loadFunc: '' } });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    await t.save();
    expect(t.server.calls[0].body.config.items).toEqual([{ id: 'user:follow-ups', label: 'Follow Ups', icon: 'list-check',
      action: { type: 'view', key: 'lead_followups', present: 'tab' } }]);
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items', 'PUT layout', 'POST custom-tab']);
  });

  test('a custom tab removed from Home (Fred\'s layout): only the sidebar gets the button', async () => {
    t = boot({ customTab: CT_TOOL, layout: { removed: { home: ['custom'] } } });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    expect(t.mbRows()[0].tags).toEqual(['New', 'On sidebar']);
    await t.save();
    const lay = t.server.calls.find((c) => c.call === 'PUT layout').body.config;
    expect(lay.removed).toEqual({ home: ['custom'] });
    expect(Object.keys(lay.placed)).toEqual(['sidebar']);
    expect(lay.placed.sidebar.some((e) => e.item === 'user:call-review')).toBe(true);
  });

  test('refused for other srcs, saying why — another website, another page, an IT loadFunc; nothing is written', async () => {
    const cases = [
      [{ src: 'https://intranet.example/', icon: 'globe', title: 'Intranet' }, 'It shows another website'],
      [{ src: '/manuals.html', icon: 'book-open', title: 'manuals', loadFunc: '' }, 'it shows a page that is not a tool or a saved view'],
      [{ src: '/tool/call-review?x=1', icon: 'phone', title: 'Odd' }, 'it shows a page that is not a tool or a saved view'],
      [{ src: '/tool/call-review', icon: 'award', title: 'winner', loadFunc: "Toast.fire({text:'prize'})" }, 'it runs an extra step when it opens, set up for you by IT'],
    ];
    for (const [ct, why] of cases) {
      t = boot({ customTab: ct });
      await t.openEditor();
      const box = t.legacyBox();
      expect([ct.src, box.hidden, box.querySelector('[data-act="mb-legacy"]').hidden]).toEqual([ct.src, false, true]);
      const text = box.querySelector('.ymb-legacy-text').textContent;
      expect(text.startsWith('Your custom tab, “' + ct.title + '”, stays as it is: ')).toBe(true);
      expect(text.toLowerCase()).toContain(why.toLowerCase());
      expect(text.endsWith('Settings → My Custom Tab still changes it.')).toBe(true);
      box.querySelector('[data-act="mb-legacy"]').click();     // hidden, but a click must do nothing either
      expect(t.mbRows()).toEqual([]);
      expect(t.errors.filter((e) => /jsdomError/.test(e))).toEqual([]);
      await t.save();
      expect(t.server.calls).toEqual([]);
      t.close();
    }
    t = boot();                                                // no custom tab: no box at all
    await t.openEditor();
    expect(t.legacyBox().hidden).toBe(true);
  });

  test('idempotent: a second click does nothing; a tab button an earlier conversion saved is reused (only the clear is sent)', async () => {
    t = boot({ customTab: CT_TOOL });
    await t.openEditor();
    const go = t.legacyBox().querySelector('[data-act="mb-legacy"]');
    go.click(); go.click();
    expect(t.mbRows()).toHaveLength(1);
    t.close();
    // an earlier save stored the button and placed it, but the clear failed
    const saved = { id: 'user:call-review', label: 'Call Review', icon: 'headset', action: { type: 'tool', key: 'call-review', present: 'tab' } };
    t = boot({ customTab: CT_TOOL, items: [MODAL, saved], layout: { placed: { sidebar: [{ item: 'user:call-review' }] } } });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:modal', 'user:call-review']);   // no second button
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT layout', 'POST custom-tab']);   // Home placement + the clear
    t.close();
    // ...and placed on both already: only the clear
    t = boot({ customTab: CT_TOOL, items: [saved], layout: { placed: { home: [{ item: 'user:call-review' }], sidebar: [{ item: 'user:call-review' }] } } });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['POST custom-tab']);
    // a MODAL button for the same tool is not reused (it opens differently)
    t.close();
    t = boot({ customTab: CT_TOOL, items: [{ ...saved, action: { type: 'tool', key: 'call-review', present: 'modal' } }] });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    expect(t.mbRows().map((r) => r.id)).toEqual(['user:call-review', 'user:call-review-2']);
  });

  test('the clear fails: the buttons and layout are stored, the editor stays open and says so; Save retries just the clear', async () => {
    t = boot({ customTab: CT_TOOL });
    t.server.fail.customTab = { message: 'Could not save the custom tab', status: 500 };
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items', 'PUT layout', 'POST custom-tab']);
    expect(t.panel().hidden).toBe(false);
    const banner = t.panel().querySelector('.yle-banner').textContent;
    expect(banner).toContain('Your buttons were saved.');
    expect(banner).toContain('Your old custom tab could not be removed (Could not save the custom tab): press Save to try again.');
    expect(t.w.firmData.currentUser.user_custom_tab).toEqual(CT_TOOL);   // not cleared in the shell either
    expect(t.panel().querySelector('.yle-save').disabled).toBe(false);
    delete t.server.fail.customTab;
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items', 'PUT layout', 'POST custom-tab', 'POST custom-tab']);
    expect(t.panel().hidden).toBe(true);
    expect(t.w.firmData.currentUser.user_custom_tab).toBe(null);
  });

  test('the buttons are refused: the clear is HELD (never sent), the old tab stays', async () => {
    t = boot({ customTab: CT_TOOL });
    t.server.fail.items = { message: 'refused', status: 500 };
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items']);   // the layout names the new button: held too
    expect(t.panel().querySelector('.yle-banner').textContent).toContain('Your old custom tab was not removed: the button that replaces it did not save.');
    expect(t.w.firmData.currentUser.user_custom_tab).toEqual(CT_TOOL);
    t.close();
    t = boot({ customTab: CT_TOOL });
    t.server.fail.layout = { message: 'refused', status: 500 };
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items', 'PUT layout']);
  });

  test('deleting the new button before Save cancels the conversion (no clear) and offers it again', async () => {
    t = boot({ customTab: CT_TOOL });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    t.mb().querySelector('.ymb-row [data-act="mb-del"]').click();
    await t.flush();
    expect(t.mbRows()).toEqual([]);
    expect(t.legacyBox().querySelector('[data-act="mb-legacy"]').hidden).toBe(false);
    // review N1: nothing is left to save — no layout write for a user who had none, no dot on the layout tab
    expect(t.panel().querySelector('.yle-tab[data-pane="layout"] .yle-tab-dot').hidden).toBe(true);
    expect(t.panel().querySelector('.yle-status').textContent).toBe('No changes');
    expect(t.panel().querySelector('.yle-save').disabled).toBe(true);   // nothing to save
    await t.save();
    expect(t.server.calls).toEqual([]);
  });

  test('review N2: the converted button edited to a dialog — the note says so (not "as a tab"); Save still clears the old tab', async () => {
    t = boot({ customTab: CT_TOOL });
    await t.openEditor();
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    const note = () => t.legacyBox().querySelector('.ymb-legacy-text').textContent;
    expect(note()).toContain('\u201d: it opens as a tab, where the custom tab was. A keyboard shortcut or drawer entry that opened the custom tab stops working: point it at the new button.');
    t.mb().querySelector('.ymb-row [data-act="mb-edit"]').click();
    t.setVal('size', 'compact');
    t.mb().querySelector('[data-act="mb-commit"]').click();
    expect(note()).toContain('\u201d: it opens in a dialog, where the custom tab was. A keyboard shortcut or drawer entry that opened the custom tab stops working: point it at the new button.');
    expect(note()).not.toContain('as a tab');
    await t.save();
    expect(t.server.calls.map((c) => c.call)).toEqual(['PUT items', 'PUT layout', 'POST custom-tab']);
    expect(t.server.calls[0].body.config.items[0].action).toEqual({ type: 'tool', key: 'call-review', present: 'modal', size: 'compact' });
  });

  test('escaping: a custom tab title with markup is text in the note and the new button', async () => {
    t = boot({ customTab: { ...CT_TOOL, title: '<b onmouseover=x>Bold</b>' } });
    await t.openEditor();
    expect(t.legacyBox().querySelector('b')).toBe(null);
    expect(t.legacyBox().querySelector('.ymb-legacy-text').textContent).toContain('“<b onmouseover=x>Bold</b>”');
    t.legacyBox().querySelector('[data-act="mb-legacy"]').click();
    expect(t.mbRows()[0].name).toBe('<b onmouseover=x>Bold</b>');
    expect(t.mb().querySelector('.ymb-rows b')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the pure cores', () => {
  let t, E;
  beforeAll(() => { t = boot(); E = t.w.ycLayoutEditor; });
  afterAll(() => t.close());

  test('legacyTab: what My buttons can do with a user_custom_tab value', () => {
    const lt = (v) => J(E.legacyTab(v));
    expect([null, undefined, {}, { src: '' }, { src: '   ' }, 'not json', [], 5].map(lt)).toEqual([null, null, null, null, null, null, null, null]);
    expect(lt(CT_TOOL)).toEqual({ ok: true, title: 'Call Review', button: { label: 'Call Review', icon: 'headset', type: 'tool', key: 'call-review', size: 'tab' } });
    expect(lt(JSON.stringify(CT_TOOL)).ok).toBe(true);                                    // a JSON string (mysql2 hazard)
    expect(lt({ src: '/customView.html?key=lead_followups' })).toEqual({ ok: true, title: 'Custom Tab',
      button: { label: 'Custom Tab', icon: 'bug', type: 'view', key: 'lead_followups', size: 'tab' } });
    expect(lt({ ...CT_TOOL, icon: 'Bad Icon', title: 'x'.repeat(41) }).button).toMatchObject({ label: 'Custom Tab', icon: 'bug' });
    expect(lt({ ...CT_TOOL, icon: 'brands:github', title: '  Spaced  ' }).button).toMatchObject({ label: 'Spaced', icon: 'brands:github' });
    for (const src of ['/tool/', '/tool/Bad', '/tool/x/y', '/tool/x?y=1', '/customView.html', '/customView.html?key=ab', '/customView.html?key=lead_followups&x=1',
      '/customView?key=lead_followups', '/manuals.html', '/etch.html', '//tool/x']) {
      expect([src, lt({ src }).ok, lt({ src }).why]).toEqual([src, false, 'It shows a page that is not a tool or a saved view, and only those can be a button that opens as a tab.']);
    }
    for (const src of ['https://x.example/', 'http://x.example/tool/x', 'javascript:alert(1)']) {
      expect([src, lt({ src }).why]).toEqual([src, 'It shows another website, and a button never shows another website inside YisraCase.']);
    }
    expect(lt({ ...CT_TOOL, loadFunc: 'x()' }).why).toBe('It runs an extra step when it opens, set up for you by IT, and a button can’t do that.');
    expect(lt({ ...CT_TOOL, loadFunc: '   ' }).ok).toBe(true);
    // review N3: applyCustomTab runs ANY truthy loadFunc (String(loadFunc)), so any truthy one is refused
    for (const lf of [1, true, {}, [], 'x()']) expect([lf, lt({ ...CT_TOOL, loadFunc: lf }).ok]).toEqual([lf, false]);
    for (const lf of [undefined, null, '', 0, false]) expect([lf, lt({ ...CT_TOOL, loadFunc: lf }).ok]).toEqual([lf, true]);
  });

  test('session.replace: newId takes oldId\'s place where it shows; never twice; not for an id the editor can\'t show', () => {
    const W = t.w;
    const eff = W.ycLauncher.effectiveRegistry().concat([{ id: 'user:new', label: 'New', icon: 'star', group: 'Mine' }])
      .concat([{ id: 'custom', label: 'Custom', icon: 'bug', group: 'Actions' }]);
    const mk = (stored) => E.session({ stored, effective: eff, locked: [], base: W.DEFAULT_LAYOUTS, registry: W.FEATURE_REGISTRY, groups: W.ycLauncher.groups() });
    const s = mk(null);
    const ids = (sf) => s.view(sf).filter((r) => r.kind === 'item').map((r) => r.id);
    const homeBefore = ids('home'), sideBefore = ids('sidebar');
    expect(s.replace('custom', 'user:new')).toEqual(['home', 'sidebar']);
    const placedIds = (sf) => s.doc().placed[sf].filter((e) => e.item).map((e) => e.item);
    expect(placedIds('home')).toEqual(homeBefore.map((id) => (id === 'custom' ? 'user:new' : id)));
    expect(placedIds('sidebar')).toEqual(sideBefore.map((id) => (id === 'custom' ? 'user:new' : id)));
    expect(s.replace('custom', 'user:new')).toEqual([]);                  // user:new shows there already: never twice
    // once custom is not effective (the old tab cleared), the view is the same list
    s.retarget(eff.filter((e) => e.id !== 'custom'), W.ycLauncher.groups());
    expect(ids('home')).toEqual(homeBefore.map((id) => (id === 'custom' ? 'user:new' : id)));
    // a stored placed list naming custom loses it, and an edit never carries it back
    const s3 = mk({ placed: { home: [{ item: 'custom' }, { item: 'cases' }] } });
    expect(s3.replace('custom', 'user:new')).toEqual(['home', 'sidebar']);
    s3.retarget(eff.filter((e) => e.id !== 'custom'), W.ycLauncher.groups());
    s3.move('home', 0, 1);
    expect(s3.doc().placed.home.some((e) => e.item === 'custom')).toBe(false);
    const s2 = mk({ placed: { sidebar: [{ item: 'user:new' }] } });
    expect(s2.replace('custom', 'user:new')).toEqual(['home']);         // already on the sidebar: left alone there
    expect(mk(null).replace('custom', 'user:unknown')).toEqual([]);
    expect(mk({ removed: { home: ['custom'], sidebar: ['custom'] } }).replace('custom', 'user:new')).toEqual([]);
  });
});
