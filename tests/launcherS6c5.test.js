/**
 * ui-custom S6c-5 — pages: the firm's and the user's own page tabs, built by
 * the launcher on the panel stage S6c-4 left (S6c_DESIGN.md §4, §5 S6c-5;
 * Fred's rulings 1–4). Pins:
 *
 *   1. THE MARKUP AND CSS: the two hubs carry the shared class (yc-hub — not
 *      the design's yc-page, which /js/ycPager.js owns in this document), an
 *      EMPTY #ycPages sits between Admin and the stage (no whitespace: the
 *      default render is unchanged with no page defined), the phone grid and
 *      egg-row rules key on the class.
 *   2. THE PAGES, FOR REAL (the page's own launcher, drill and tab code over a
 *      skeleton shaped like the page): a user page with two panels from
 *      different hubs, a tab-presented button, a List and an icon row is built
 *      at applyAccess as a .tab-main.yc-hub with an opaque id; its tiles are
 *      neutrals (a panel item's with data-target), its strip shows only ITS
 *      pills, a panel opens IN PLACE on it (per-page memory, the SAME iframe
 *      as from More), exec(pageId) opens it, its sidebar neutral carries its
 *      tab and lights; a re-run with the same content changes nothing; a
 *      change rebuilds in place and drops the strip; a page deleted while open
 *      goes to Home; a page gone from the tiers is removed.
 *   3. ACCESS: a firm page restricted by visible_to vanishes for staff (tab,
 *      tile, sidebar, All, exec) and stays for su; a gated panel placed on a
 *      page is unreachable for a non-su by every path (a fuzz over pages).
 *   4. EXEC ROUTING: the pages join after Admin; a panel the firm took off
 *      More opens on the page that shows it.
 *   5. LIMITS: 50 page tabs per tier; the 51st is listed, openable nowhere,
 *      with a console error; labels are text; icons only through ycIcon.
 *
 * The URL side (never written, never a head) is tests/wsurlS1a.test.js; the
 * editors are tests/launcherS6c5editor.test.js; the validator
 * tests/uiConfigS6c5.test.js.
 *
 * Mutation-checked (see local/ui-custom/S6c5_worker_report.md).
 *
 * Run:  npx jest tests/launcherS6c5.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml, expandedShellHtml, loadLauncher } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { registry: REG, layouts: LAY } = loadLauncher(RAW);
const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS6c5: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const STYLES = [...RAW.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const DRILL_CSS = (() => { const h = STYLES.filter((s) => s.includes('/* Drill-in pill strip for big-button tabs */')); if (h.length !== 1) throw new Error('drill css'); return h[0]; })();

const J = (x) => JSON.parse(JSON.stringify(x));
const SU = { isAdmin: true, roles: ['su'], denied: [] };
const STAFF = { isAdmin: false, roles: ['staff'], denied: [] };
const IT = { isAdmin: false, roles: ['it'], denied: [] };

// The user's buttons: a page, a List (drawer), a tab-presented view, a link
const MINE = { items: [
  { id: 'user:desk', label: 'My desk', icon: 'desktop', action: { type: 'page' } },
  { id: 'user:box', label: 'My box', icon: 'box-open', action: { type: 'drawer', items: ['cases', 'moreAutomations'] } },
  { id: 'user:leads-tab', label: 'Leads tab', icon: 'table-list', action: { type: 'view', key: 'lead_followups', present: 'tab' } },
  { id: 'user:court', label: 'Court site', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/', present: 'window' } },
] };
// …and the page's contents: two panels from different hubs, the tab button, the List, a su tool, a break, the link; icons casey + all
const DESK = { tiles: [{ item: 'moreAutomations' }, { item: 'adminUsers' }, { break: true }, { item: 'user:leads-tab' }, { item: 'user:box' }, { item: 'adminDbConsole' }, { item: 'user:court' }], icons: [{ item: 'casey' }, { item: 'all' }] };
const USER_LAYOUT = (pages = { 'user:desk': DESK }, extra = {}) => ({
  placed: { sidebar: [{ label: 'Mine' }, { item: 'user:desk' }, { item: 'cases' }], home: [{ item: 'user:desk' }, { item: 'cases' }], ...extra },
  removed: {}, pages,
});
// The firm: a page restricted to `it`, with Manuals, Users and a firm link on it
const CLIO = { id: 'firm:clio-code', label: 'Get Clio Code', icon: 'key', action: { type: 'url', href: 'https://clio.example.com/', present: 'window' } };
const OPS = { id: 'firm:ops', label: 'Operations', icon: 'layer-group', action: { type: 'page' } };
const RO = { items: [CLIO, OPS], hidden: [], locked: [], renames: {}, visible_to: { 'firm:ops': ['it'], admin: ['it', 'admin'] } };
const FIRM_LAYOUT = { placed: {}, removed: {}, pages: { 'firm:ops': { tiles: [{ item: 'moreManuals' }, { item: 'adminUsers' }, { item: 'firm:clio-code' }], icons: [{ item: 'myTasks' }] } } };
const ui = ({ user = USER_LAYOUT(), items = MINE, ro = RO, firm = FIRM_LAYOUT } = {}) => ({ firm: { registry_overrides: ro, layout: firm }, user: { layout: user, items } });

// ─────────────────────────────────────────────────────────────────────────
describe('1. the markup and the CSS', () => {
  test('the hubs carry yc-hub (never yc-page: ycPager owns it here); an EMPTY #ycPages sits between Admin and the stage; the default render has no page', () => {
    expect(RAW).toMatch(/<div id="tabMore" class="tab-main yc-hub">/);
    expect(RAW).toMatch(/<div id="tabAdmin" class="tab-main yc-hub" data-all-icons=/);
    expect(RAW).toContain('<div id="ycPages"></div>');                      // no whitespace inside: it takes no space
    expect(RAW.match(/id="ycPages"/g)).toHaveLength(1);
    expect(RAW).not.toMatch(/class="[^"]*\btab-main[^"]*\byc-page\b/);
    expect(fs.readFileSync(path.join(ROOT, 'public/js/ycPager.js'), 'utf8')).toMatch(/'\.yc-page \{/);   // the collision this guards
    const dom = new JSDOM(expandedShellHtml());
    const d = dom.window.document;
    try {
      const pages = d.getElementById('ycPages');
      expect([pages.previousElementSibling.id, pages.nextElementSibling.id, pages.childNodes.length]).toEqual(['tabAdmin', 'ycPanels', 0]);
      expect([...d.querySelectorAll('.yc-hub')].map((e) => e.id)).toEqual(['tabMore', 'tabAdmin']);
      expect(d.querySelectorAll('[data-yc-page]')).toHaveLength(0);
    } finally { dom.window.close(); }
  });

  test('the phone grid rules and the egg-row rules key on the shared class / the pages container', () => {
    expect(DRILL_CSS).toMatch(/\.yc-hub > \.big-button \{\s*width: calc\(\(100% - 30px\) \/ 3\); height: 104px;/);
    expect(DRILL_CSS).toMatch(/\.yc-hub > br \{ display: none; \}/);
    // a custom page's tile label is DB text: it wraps inside the tile at every width (the 800px survey caught the right-column run-off)
    expect(DRILL_CSS).toMatch(/\.yc-hub > \.big-button \{ overflow-wrap: anywhere; \}/);
    expect(DRILL_CSS).not.toMatch(/#tab(More|Admin) > \.big-button/);
    expect(DRILL_CSS).not.toMatch(/#tab(More|Admin) > br/);
    expect(DRILL_CSS).toMatch(/\.more-egg-row, \.home-egg-row, \.admin-egg-row, \.page-egg-row \{ text-align:center; margin:14px 0 4px; \}/);
    expect(DRILL_CSS).toMatch(/\.page-egg-row:empty \{ display:none; \}/);
    expect(DRILL_CSS).toMatch(/#tabAdmin \.admin-egg, #ycPages \.page-egg \{ background:transparent;/);
    expect(DRILL_CSS).toMatch(/\.drill-active > \.page-egg-row \{ display:none; \}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A page skeleton shaped like the real one: the mounts, the hubs with the
// shared class, #ycPages, the stage; the page's own drill, tab and launcher
// code; recording stubs (openers, the button tab, Swal absent).
function boot() {
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabAll', 'tabUserItem']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}<style>${DRILL_CSS}</style></head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <div class="home-egg-row"><script>ycLauncher.mount('homeIcons')</script></div>
      <div class="home-search"></div></div>
    <div id="tabAll" class="tab-main"></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main yc-hub"><h1>More</h1>
  <script>ycLauncher.mount('more')</script>
  <div class="more-egg-row"><script>ycLauncher.mount('moreIcons')</script></div></div>
    <div id="tabAdmin" class="tab-main yc-hub"><h1>Admin</h1>
  <script>ycLauncher.mount('admin')</script>
  <div class="admin-egg-row"><script>ycLauncher.mount('adminIcons')</script></div></div>
    <div id="ycPages"></div>
    <div id="ycPanels" style="display:none">${grid('more')}${grid('admin')}</div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const calls = [];
  w.__calls = calls;
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() { __calls.push(["sync"]); }\n' +
    'function pingBecameVisible(t) { __calls.push(["ping", t && (t.id || t.className)]); }\n' +
    'var user = { user: 1 };\nfunction openTasksTab() { __calls.push(["openTasksTab"]); }\nfunction toggleMascot() { __calls.push(["toggleMascot"]); }\n' +
    'window.ycButtonTabs = { open(id, url) { __calls.push(["bt", id, url]); openMainTab("tabUserItem"); return true; }, sync() {}, active() { return null; } };\n';
  for (const it of Object.values(w.FEATURE_REGISTRY)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push(['${m[1]}']); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  const d = w.document;
  const L = w.ycLauncher;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => [...d.querySelectorAll(s)];
  const pageOf = (id) => $(`#ycPages > [data-yc-page="${id}"]`);
  const onStage = () => [...d.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id);
  const drilled = (el) => el.classList.contains('drill-active');
  const pills = (el) => [...el.querySelectorAll(':scope > .feature-strip .pill-button')].slice(1).map((p) => p.dataset.target || p.textContent.trim());
  const activePill = (el) => { const p = el.querySelector(':scope > .feature-strip .pill-button.active'); return p ? p.dataset.target || p.textContent.trim() : null; };
  // a page's direct children after the h1, up to the egg row: tiles as labels, '|' for a break
  const tiles = (el) => {
    const out = []; let brs = 0;
    for (let n = el.querySelector('h1').nextElementSibling; n && !n.classList.contains('page-egg-row'); n = n.nextElementSibling) {
      if (n.tagName === 'BR') { if (++brs === 2) { out.push('|'); brs = 0; } continue; }
      brs = 0;
      out.push(n.getAttribute('data-yc-shortcut'));
    }
    return out;
  };
  const icons = (el) => [...el.querySelectorAll(':scope > .page-egg-row > *')].map((b) => b.getAttribute('data-yc-shortcut'));
  const eff = () => L.effectiveRegistry().map((e) => e.id);
  return { w, d, L, $, $$, calls, errors, pageOf, onStage, drilled, pills, activePill, tiles, icons, eff, close: () => w.close() };
}

describe('2. the pages, for real', () => {
  let t;
  afterEach(() => t && t.close());

  test('a user page is built at applyAccess: a .tab-main.yc-hub in #ycPages with an opaque id, its heading as text + icons, its tiles neutrals (panel items with data-target), its icon row; the effective registry marks pages', () => {
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui() });
    const pg = t.pageOf('user:desk');
    expect(pg).not.toBe(null);
    expect([pg.className, /^ycPage-\d+$/.test(pg.id), pg.style.display, pg.parentElement.id]).toEqual(['tab-main yc-hub', true, 'none', 'ycPages']);
    const h1 = pg.querySelector(':scope > h1');
    expect(h1.textContent).toBe(' My desk ');
    expect([...h1.querySelectorAll('i')].map((i) => i.className)).toEqual(['fa-solid fa-desktop', 'fa-solid fa-desktop']);
    expect(h1.childNodes[1].nodeType).toBe(3);                                               // the label is a text node
    // the su tool is not drawn for anyone but su? su sees it; the rest are neutrals in order
    expect(t.tiles(pg)).toEqual(['moreAutomations', 'adminUsers', '|', 'user:leads-tab', 'user:box', 'adminDbConsole', 'user:court']);
    expect(t.icons(pg)).toEqual(['casey', 'all']);
    for (const b of pg.querySelectorAll(':scope > .big-button')) {
      expect([b.hasAttribute('id'), b.hasAttribute('onclick'), b.hasAttribute('data-exclusive-group')]).toEqual([false, false, false]);
    }
    expect(pg.querySelector('[data-yc-shortcut="moreAutomations"]').getAttribute('data-target')).toBe('automationsDiv');
    expect(pg.querySelector('[data-yc-shortcut="adminUsers"]').getAttribute('data-target')).toBe('usersDiv');
    expect(pg.querySelector('[data-yc-shortcut="user:box"]').hasAttribute('data-target')).toBe(false);
    expect(pg.querySelector('[data-yc-shortcut="user:box"]').lastChild.nodeValue).toBe('My box');     // a text node
    expect(pg.querySelector('.page-egg-row [data-yc-shortcut="casey"]').className).toBe('page-egg');
    expect(pg.querySelector('.page-egg-row [data-yc-shortcut="casey"]').getAttribute('aria-label')).toBe('Casey');   // a neutral icon: the entry's label (S6c-1+2)
    // the firm page too (su sees everything), firm pages first
    expect([...t.d.querySelectorAll('#ycPages > [data-yc-page]')].map((e) => e.getAttribute('data-yc-page'))).toEqual(['firm:ops', 'user:desk']);
    expect(t.tiles(t.pageOf('firm:ops'))).toEqual(['moreManuals', 'adminUsers', 'firm:clio-code']);
    expect(t.icons(t.pageOf('firm:ops'))).toEqual(['myTasks']);
    const reg = t.L.effectiveRegistry();
    expect(reg.find((e) => e.id === 'user:desk').page).toBe(true);
    expect(reg.find((e) => e.id === 'firm:ops').page).toBe(true);
    expect(reg.find((e) => e.id === 'user:box')).not.toHaveProperty('page');
    expect(reg.find((e) => e.id === 'cases')).not.toHaveProperty('page');
    expect(t.errors).toEqual([]);
  });

  test('exec(pageId) opens the tab; its sidebar neutral carries the tab and lights; its Home tile opens it too; the strip shows only ITS pills', () => {
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui() });
    const pg = t.pageOf('user:desk');
    expect(t.L.exec('user:desk')).toBe(true);
    expect(t.w.currentMainTabId()).toBe(pg.id);
    const row = t.$('#appSidebar .sb-item[data-yc-shortcut="user:desk"]');
    expect(row.getAttribute('data-tab')).toBe(pg.id);
    expect(row.classList.contains('active')).toBe(true);
    expect(t.L.elementsOf('cases').sidebar.getAttribute('data-tab')).toBe('tabCases');   // a default row keeps the registry's
    t.w.openMainTab('tabCases');
    expect(row.classList.contains('active')).toBe(false);
    t.$('#tabHome .home-btn[data-yc-shortcut="user:desk"]').click();
    expect(t.w.currentMainTabId()).toBe(pg.id);
    // the strip: built on the first drill, from this page's tiles only (the su tool included for su)
    pg.querySelector('[data-yc-shortcut="moreAutomations"]').click();
    expect(t.pills(pg)).toEqual(['automationsDiv', 'usersDiv', 'Leads tab', 'My box', 'dbConsoleDiv', 'Court site']);
    expect(t.errors).toEqual([]);
  });

  test('a panel opens IN PLACE on the page (per-page memory), the SAME iframe as from More; the List and the tab button work from their tiles', () => {
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui() });
    const pg = t.pageOf('user:desk');
    // Automations from More first: its iframe loads once
    t.w.openMainTab('tabMore');
    t.L.elementsOf('moreAutomations').more.click();
    const frame = t.d.querySelector('#automationsDiv iframe');
    expect(frame.getAttribute('src')).toBe('/automationsDiv.html');
    // on the page: the same panel opens here, More stays drilled behind
    t.L.exec('user:desk');
    expect([t.onStage(), t.drilled(pg)]).toEqual([[], false]);                           // the page's own memory: nothing yet
    pg.querySelector('[data-yc-shortcut="moreAutomations"]').click();
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(pg), t.activePill(pg)]).toEqual([pg.id, ['automationsDiv'], true, 'automationsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe')).toBe(frame);
    expect(t.d.querySelectorAll('#automationsDiv').length).toBe(1);
    expect(t.drilled(t.d.getElementById('tabMore'))).toBe(true);
    // Users (an Admin panel) opens in place too; the pill of the open panel goes back to the grid
    pg.querySelector('[data-yc-shortcut="adminUsers"]').click();
    expect([t.onStage(), t.activePill(pg), t.drilled(t.d.getElementById('tabAdmin'))]).toEqual([['usersDiv'], 'usersDiv', false]);
    pg.querySelector(':scope > .feature-strip .pill-button[data-target="usersDiv"]').click();
    expect([t.onStage(), t.drilled(pg)]).toEqual([[], false]);
    // back on More: Automations again (More's memory)
    t.w.openMainTab('tabMore');
    expect(t.onStage()).toEqual(['automationsDiv']);
    // the List tile opens the drawer; the tab button's tile opens the button tab
    t.L.exec('user:desk');
    pg.querySelector('[data-yc-shortcut="user:box"]').click();
    expect(t.d.getElementById('ycDrawer').hidden).toBe(false);
    expect([...t.d.querySelectorAll('#ycDrawer .yc-dr-item')].map((b) => b.getAttribute('data-yc-item'))).toEqual(['cases', 'moreAutomations']);
    pg.querySelector('[data-yc-shortcut="user:leads-tab"]').click();
    expect(t.calls.filter((c) => c[0] === 'bt').map((c) => c.slice(1))).toEqual([['user:leads-tab', '/customView.html?key=lead_followups']]);
    expect(t.w.currentMainTabId()).toBe('tabUserItem');
    // the icon row: Casey toggles in place, All opens the All tab
    pg.querySelector('.page-egg-row [data-yc-shortcut="casey"]').click();
    expect(t.calls.filter((c) => c[0] === 'toggleMascot')).toHaveLength(1);
    pg.querySelector('.page-egg-row [data-yc-shortcut="all"]').click();
    expect(t.w.currentMainTabId()).toBe('tabAll');
    expect(t.errors).toEqual([]);
  });

  test('re-run safely: the same content changes nothing; a rename and a changed tile set rebuild in place and drop the strip; a page gone from the tiers is removed — Home first when you were on it, its memory forgotten', () => {
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui() });
    const pg = t.pageOf('user:desk');
    t.L.exec('user:desk');
    pg.querySelector('[data-yc-shortcut="moreAutomations"]').click();
    const nodes = [...pg.childNodes];
    t.L.applyAccess({ ui: ui() });
    expect([...pg.childNodes]).toEqual(nodes);                                            // nothing moved
    expect(t.pageOf('user:desk')).toBe(pg);
    expect(pg.querySelector(':scope > .feature-strip')).not.toBe(null);
    // a rename: heading and tiles follow; the strip (it holds the labels) is dropped and, the page being drilled, rebuilt now
    const strip0 = pg.querySelector(':scope > .feature-strip');
    expect(strip0.textContent).toContain('My box');
    const items = J(MINE); items.items[0].label = 'Desk 2'; items.items[1].label = 'Box 2';
    t.L.applyAccess({ ui: ui({ items }) });
    expect(pg.querySelector(':scope > h1').textContent).toBe(' Desk 2 ');
    expect(pg.querySelector('[data-yc-shortcut="user:box"]').lastChild.nodeValue).toBe('Box 2');
    const strip1 = pg.querySelector(':scope > .feature-strip');
    expect([strip1 === strip0, strip0.isConnected, strip1.textContent.includes('Box 2'), strip1.textContent.includes('My box')]).toEqual([false, false, true, false]);
    expect([t.onStage(), t.drilled(pg), t.activePill(pg)]).toEqual([['automationsDiv'], true, 'automationsDiv']);
    // not drilled: the stale strip is dropped and NOT rebuilt until the next drill
    t.w.openMainTab(pg.id);                                                                 // the tab you are on: back to the grid
    expect(t.drilled(pg)).toBe(false);
    items.items[1].label = 'Box 3';
    t.L.applyAccess({ ui: ui({ items }) });
    expect(pg.querySelector(':scope > .feature-strip')).toBe(null);
    pg.querySelector('[data-yc-shortcut="moreAutomations"]').click();
    expect(t.pills(pg)).toContain('Box 3');
    // a changed tile set
    const desk = J(DESK); desk.tiles = desk.tiles.filter((e) => e.item !== 'adminUsers');
    t.L.applyAccess({ ui: ui({ user: USER_LAYOUT({ 'user:desk': desk }) }) });
    expect(t.tiles(pg)).toEqual(['moreAutomations', '|', 'user:leads-tab', 'user:box', 'adminDbConsole', 'user:court']);
    expect(pg.querySelector('[data-yc-shortcut="adminUsers"]')).toBe(null);
    // the page deleted while open → Home, the tab removed, its memory gone
    t.w.openMainTab('tabCases');
    t.w.openMainTab(pg.id);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual([pg.id, ['automationsDiv']]);
    const noPage = J(MINE); noPage.items.splice(0, 1);
    t.L.applyAccess({ ui: ui({ items: noPage }) });
    expect([t.w.currentMainTabId(), t.pageOf('user:desk'), pg.isConnected, t.onStage(), t.d.getElementById('ycPanels').style.display]).toEqual(['tabHome', null, false, [], 'none']);
    expect(t.L.exec('user:desk')).toBe(false);
    expect(t.$('#appSidebar .sb-item[data-yc-shortcut="user:desk"]')).toBe(null);
    // back as a page: the SAME tab id for the session — and NOT drilled: drillMemory is keyed by that tab id, so a
    // page that left while drilled must forget its panel, or it comes back with the panel on the stage under its tiles
    t.L.applyAccess({ ui: ui() });
    expect(t.pageOf('user:desk').id).toBe(pg.id);
    expect(t.L.exec('user:desk')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(t.pageOf('user:desk'))]).toEqual([pg.id, [], false]);
    expect(t.errors.filter((e) => !/not in this user's launcher/.test(e))).toEqual([]);
  });

  test('a page item whose kind changes (page → link) loses its tab; a page whose document is missing is an empty page', () => {
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui() });
    const pg = t.pageOf('user:desk');
    const items = J(MINE); items.items[0].action = { type: 'url', href: 'https://x.example/', present: 'window' };
    t.L.applyAccess({ ui: ui({ items }) });
    expect([t.pageOf('user:desk'), pg.isConnected]).toEqual([null, false]);
    t.L.applyAccess({ ui: ui({ user: USER_LAYOUT({}) }) });
    const empty = t.pageOf('user:desk');
    expect([t.tiles(empty), t.icons(empty), empty.querySelector(':scope > .page-egg-row').childNodes.length]).toEqual([[], [], 0]);
    expect(t.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('3. access', () => {
  let t;
  afterEach(() => t && t.close());

  test('a firm page restricted by visible_to vanishes for staff — no tab, no tile, no sidebar row, not in All / the palette, exec refuses — and stays for it and su', () => {
    const firm = J(FIRM_LAYOUT); firm.placed = { home: [{ item: 'cases' }, { item: 'firm:ops' }], sidebar: [{ item: 'firm:ops' }, { item: 'cases' }] };
    for (const [who, has] of [[STAFF, false], [IT, true], [SU, true]]) {
      t = boot();
      t.L.applyAccess({ ...who, ui: ui({ firm }) });
      expect([who.roles, !!t.pageOf('firm:ops')]).toEqual([who.roles, has]);
      expect([who.roles, t.eff().includes('firm:ops')]).toEqual([who.roles, has]);
      expect([who.roles, !!t.$('#tabHome .home-btn[data-yc-shortcut="firm:ops"]')]).toEqual([who.roles, has]);
      expect([who.roles, !!t.$('#appSidebar .sb-item[data-yc-shortcut="firm:ops"]')]).toEqual([who.roles, has]);
      expect([who.roles, t.L.exec('firm:ops')]).toEqual([who.roles, has]);
      if (has) expect(t.w.currentMainTabId()).toBe(t.pageOf('firm:ops').id);
      t.close(); t = null;
    }
  });

  test('a gated (su) panel placed on a page is unreachable for a non-su by every path: not drawn, no pill, exec refuses; the page itself shows what they may open', () => {
    t = boot();
    t.L.applyAccess({ ...IT, ui: ui() });
    const pg = t.pageOf('user:desk');
    expect(t.tiles(pg)).toEqual(['moreAutomations', 'adminUsers', '|', 'user:leads-tab', 'user:box', 'user:court'].filter((k) => k !== 'adminUsers'));
    expect(pg.querySelector('[data-yc-shortcut="adminDbConsole"]')).toBe(null);
    expect(pg.querySelector('[data-yc-shortcut="adminUsers"]')).toBe(null);
    pg.querySelector('[data-yc-shortcut="moreAutomations"]').click();
    expect(t.pills(pg)).not.toContain('dbConsoleDiv');
    expect(t.pills(pg)).not.toContain('usersDiv');
    expect(t.L.exec('adminDbConsole')).toBe(false);
    expect(t.L.exec('adminUsers', { page: pg.id })).toBe(false);
    expect(t.onStage()).toEqual(['automationsDiv']);
    expect(t.errors.filter((e) => !/not in this user's launcher/.test(e))).toEqual([]);
  });

  test('FUZZ: random firm and user pages heavy with su tiles — for it / admin / staff no su id is drawn on any page, no pill, exec refuses every one', () => {
    const SU_IDS = Object.keys(REG).filter((k) => REG[k].gate === 'su');
    const OPEN = Object.keys(REG).filter((k) => !REG[k].gate && k !== 'admin');
    let seed = 11;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const pick = (list) => list[rnd(list.length)];
    for (let run = 0; run < 24; run++) {
      const who = { isAdmin: false, roles: [pick(['it', 'admin', 'staff'])], denied: [] };
      const page = () => ({
        tiles: Array.from({ length: 2 + rnd(8) }, () => (rnd(4) ? { item: rnd(3) ? pick(SU_IDS) : pick(OPEN) } : { break: true })),
        icons: Array.from({ length: rnd(4) }, () => ({ item: rnd(2) ? pick(SU_IDS) : pick(OPEN) })),
      });
      const firmPages = {}, userPages = {}, firmItems = [], userItems = [];
      for (let i = 0; i < 1 + rnd(3); i++) { firmItems.push({ id: 'firm:p' + i, label: 'F' + i, icon: 'star', action: { type: 'page' } }); firmPages['firm:p' + i] = page(); }
      for (let i = 0; i < 1 + rnd(3); i++) { userItems.push({ id: 'user:p' + i, label: 'U' + i, icon: 'star', action: { type: 'page' } }); userPages['user:p' + i] = page(); }
      t = boot();
      t.L.applyAccess({ ...who, ui: {
        firm: { registry_overrides: { items: firmItems, visible_to: { admin: ['it', 'admin'] } }, layout: { placed: {}, removed: {}, pages: firmPages } },
        user: { items: { items: userItems }, layout: { placed: {}, removed: {}, pages: userPages } },
      } });
      const pages = [...t.d.querySelectorAll('#ycPages > [data-yc-page]')];
      expect([run, pages.length]).toEqual([run, firmItems.length + userItems.length]);
      for (const pg of pages) {
        for (const id of SU_IDS) expect([run, pg.getAttribute('data-yc-page'), id, pg.querySelector(`[data-yc-shortcut="${id}"]`)]).toEqual([run, pg.getAttribute('data-yc-page'), id, null]);
        t.w.openMainTab(pg.id);
        const first = pg.querySelector(':scope > .big-button[data-target]');
        if (first) {
          first.click();
          for (const id of SU_IDS) expect([run, t.pills(pg).includes(REG[id].target)]).toEqual([run, false]);
        }
      }
      for (const id of SU_IDS) expect([run, id, t.L.exec(id)]).toEqual([run, id, false]);
      t.close(); t = null;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('4. exec routing and 5. limits', () => {
  let t;
  afterEach(() => t && t.close());

  test('exec of a grid item tries the pages after More and Admin: the active page first; a panel the firm took off More opens on the page that shows it', () => {
    const firm = J(FIRM_LAYOUT);
    firm.placed = { more: placed('more').filter((k) => k !== 'moreAutomations').map((k) => ({ item: k })) };
    firm.removed = { more: ['moreAutomations'] };
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui({ firm }) });
    const pg = t.pageOf('user:desk');
    expect(t.L.elementsOf('moreAutomations').more.hasAttribute('data-yc-unplaced')).toBe(true);
    // from Cases: More hides it, Admin has no tile, the firm page has none → the user page shows it
    t.w.openMainTab('tabCases');
    expect(t.L.exec('moreAutomations')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(pg)]).toEqual([pg.id, ['automationsDiv'], true]);
    // Users sits on Admin (default), the firm page and the user page: the active page wins, else Admin
    t.L.exec('user:desk');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual([pg.id, ['usersDiv']]);
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual(['tabAdmin', ['usersDiv']]);
    // opts.page names a page tab too
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers', { page: t.pageOf('firm:ops').id })).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual([t.pageOf('firm:ops').id, ['usersDiv']]);
    expect(t.errors).toEqual([]);
  });

  test('50 page tabs per tier build (the items cap holds the tier at 50 buttons, so the page cap is the item cap); labels are text, icons via ycIcon', () => {
    const items = { items: Array.from({ length: 51 }, (_, i) => ({ id: 'user:p' + i, label: i === 49 ? '<b>forty</b> & nine' : 'P' + i, icon: 'star', action: { type: 'page' } })) };
    t = boot();
    t.L.applyAccess({ ...SU, ui: ui({ items, user: { placed: {}, removed: {}, pages: { 'user:p0': { tiles: [{ item: 'user:p49' }, { item: 'user:p50' }] } } } }) });
    expect(t.d.querySelectorAll('#ycPages > [data-yc-page]')).toHaveLength(50 + 1);            // 50 user pages + the firm's
    expect(t.pageOf('user:p49')).not.toBe(null);
    expect([t.pageOf('user:p50'), t.eff().includes('user:p50'), t.L.exec('user:p50')]).toEqual([null, false, false]);   // the 51st button is not read at all
    expect(t.pageOf('user:p0').querySelector('[data-yc-shortcut="user:p50"]')).toBe(null);
    // a tile's label is text
    const tile = t.pageOf('user:p0').querySelector('[data-yc-shortcut="user:p49"]');
    expect([tile.lastChild.nodeValue, tile.querySelector('b')]).toEqual(['<b>forty</b> & nine', null]);
    expect(t.pageOf('user:p49').querySelector(':scope > h1').textContent).toBe(' <b>forty</b> & nine ');
    expect(t.pageOf('user:p49').querySelector(':scope > h1 b')).toBe(null);
    // an icon that fails the grammar is never a class: circle-question
    const bad = { items: [{ id: 'user:desk', label: 'Desk', icon: 'star', action: { type: 'page' } }] };
    t.L.applyAccess({ ui: ui({ items: bad, user: USER_LAYOUT({ 'user:desk': { tiles: [{ item: 'firm:odd' }] } }),
      ro: { items: [{ id: 'firm:odd', label: 'Odd', icon: 'x" onload="alert(1)', action: CLIO.action }] } }) });
    expect(t.pageOf('user:desk').querySelector('[data-yc-shortcut="firm:odd"]')).toBe(null);   // the firm item itself is refused by the grammar
    expect(t.pageOf('user:desk').querySelector(':scope > h1 i').className).toBe('fa-solid fa-star');
    // the client grammar is the server's: a page action with any other key is not a button at all (dropped, never a page)
    const odd = { items: [{ id: 'user:p1', label: 'P', icon: 'star', action: { type: 'page', present: 'modal' } }, { id: 'user:p2', label: 'Q', icon: 'star', action: { type: 'page', items: [] } }] };
    t.L.applyAccess({ ui: ui({ items: odd, user: { placed: {}, removed: {} } }) });
    expect([t.eff().includes('user:p1'), t.eff().includes('user:p2'), t.pageOf('user:p1'), t.pageOf('user:p2')]).toEqual([false, false, null, null]);
    expect(t.L.cleanUserItem({ id: 'user:p3', label: 'R', icon: 'star', action: { type: 'page' } })).toEqual({ id: 'user:p3', label: 'R', icon: 'star', action: { type: 'page' } });
    expect(t.L.cleanFirmItem({ id: 'firm:p3', label: 'R', icon: 'star', action: { type: 'page', size: 'large' } })).toBe(null);
  });
});
