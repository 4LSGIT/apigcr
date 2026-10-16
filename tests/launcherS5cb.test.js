// tests/launcherS5cb.test.js
//
/**
 * ui-custom S5c-b — buttons that open as a TAB. The client side, run for real
 * in jsdom: the page's own ycLauncher, tool dialog, button tab
 * (ycButtonTabsJs), openMainTab / updateSidebarActive and the WORKSPACE URL serializer /
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
 *   3. The editor: "Opens in" writes present:'tab' (no size).
 *   4. The pure core: session.replace (the legacy custom tab's conversion
 *      used it; ui-custom S5e retired that tab and the conversion with it —
 *      scripts/uiCustomS5eCustomTabsToButtons.js still calls it).
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

function boot({ items = null, layout = null, withHost = true } = {}) {
  const REG = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return c.FEATURE_REGISTRY; })();
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabAll'].includes(t))
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
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC + WS_SRC);
  w.open = () => null;
  const userDoc = () => ({ ...(items ? { items: J({ items }) } : {}), ...(layout ? { layout: J(layout) } : {}) });
  w.firmData = { ui: { firm: { registry_overrides: J(RO) }, user: userDoc() }, currentUser: { user: 9 } };
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
    server.calls.push({ call: 'PUT ' + body.config_key, body: J(body) });
    const f = server.fail[body.config_key];
    if (f) return Promise.reject(Object.assign(new Error(f.message || 'refused'), f));
    return svc.write(db, J(body), { type: 'jwt', userId: 9, roles: ['staff'] }).then(
      (r) => ({ status: 'success', ...J(r) }),
      (e) => Promise.reject(Object.assign(new Error(e.message), { status: e.status || 500, body: { status: 'error', message: e.message, errors: e.errors } })));
  };
  w.confirm = () => true;
  w.ycLauncher.applyAccess({ isAdmin: false, denied: [], ui: w.firmData.ui, roles: ['staff'] });
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
  return { w, d, server, errors, toasts, urls, flush, tab, host, frames, shownFrame, lastOpen, sbActive, panel, mb, mbRows,
    openEditor, setVal, save, surface, close: () => w.close() };
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
describe('the pure cores', () => {
  let t, E;
  beforeAll(() => { t = boot(); E = t.w.ycLayoutEditor; });
  afterAll(() => t.close());

  test('session.replace: newId takes oldId\'s place where it shows; never twice; not for an id the editor can\'t show', () => {
    const W = t.w;
    // newClient stands in for the retired custom tab (ui-custom S5e): an item on Home AND the sidebar
    const eff = W.ycLauncher.effectiveRegistry().concat([{ id: 'user:new', label: 'New', icon: 'star', group: 'Mine' }]);
    expect(eff.some((e) => e.id === 'newClient')).toBe(true);
    const mk = (stored) => E.session({ stored, effective: eff, locked: [], base: W.DEFAULT_LAYOUTS, registry: W.FEATURE_REGISTRY, groups: W.ycLauncher.groups() });
    const s = mk(null);
    const ids = (sf) => s.view(sf).filter((r) => r.kind === 'item').map((r) => r.id);
    const homeBefore = ids('home'), sideBefore = ids('sidebar');
    expect(s.replace('newClient', 'user:new')).toEqual(['home', 'sidebar']);
    const placedIds = (sf) => s.doc().placed[sf].filter((e) => e.item).map((e) => e.item);
    expect(placedIds('home')).toEqual(homeBefore.map((id) => (id === 'newClient' ? 'user:new' : id)));
    expect(placedIds('sidebar')).toEqual(sideBefore.map((id) => (id === 'newClient' ? 'user:new' : id)));
    expect(s.replace('newClient', 'user:new')).toEqual([]);                  // user:new shows there already: never twice
    // once the old id is not effective, the view is the same list
    s.retarget(eff.filter((e) => e.id !== 'newClient'), W.ycLauncher.groups());
    expect(ids('home')).toEqual(homeBefore.map((id) => (id === 'newClient' ? 'user:new' : id)));
    // a stored placed list naming the old id loses it, and an edit never carries it back
    const s3 = mk({ placed: { home: [{ item: 'newClient' }, { item: 'cases' }] } });
    expect(s3.replace('newClient', 'user:new')).toEqual(['home', 'sidebar']);
    s3.retarget(eff.filter((e) => e.id !== 'newClient'), W.ycLauncher.groups());
    s3.move('home', 0, 1);
    expect(s3.doc().placed.home.some((e) => e.item === 'newClient')).toBe(false);
    const s2 = mk({ placed: { sidebar: [{ item: 'user:new' }] } });
    expect(s2.replace('newClient', 'user:new')).toEqual(['home']);         // already on the sidebar: left alone there
    expect(mk(null).replace('newClient', 'user:unknown')).toEqual([]);
    expect(mk({ removed: { home: ['newClient'], sidebar: ['newClient'] } }).replace('newClient', 'user:new')).toEqual([]);
  });
});
