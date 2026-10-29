// tests/launcherC1.test.js
//
/**
 * launcher-nits C1 (Fred, 2026-10-28) — ycLauncher.exec no longer depends on
 * a hub tile. Run in the world L4b2 leaves: a shell with NO More / Admin
 * tabs (no #tabMore / #tabAdmin, no mounts for their grids), a firm page in
 * #ycPages, the panels on the stage — the REAL launcher, drill script and
 * openMainTab, sliced from public/index.html (as launcherS6c4).
 *
 *   1. a panel a page shows opens ON that page (drilled, its pill lit);
 *   2. a panel no page shows opens on the PANEL TAB — a plain page made on
 *      first use, headed <i> label <i>, holding one neutral tile for the
 *      panel it hosts; another panel swaps the tile and rebuilds the strip;
 *      exec of the open panel leaves it open (a tile toggles);
 *   3. the hubs' four action items (Settings, Etch, Casey's paw, Ask Casey)
 *      run their own call when they have no element;
 *   4. what isn't yours is refused: no panel tab, nothing opened.
 * With the hubs present nothing changes except a firm-unplaced panel, which
 * goes to the panel tab (tests/launcherS6c4.test.js).
 *
 * Run:  npx jest tests/launcherC1.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml, loadLauncher } = require('./helpers/shellHtml');
const { stageHtml } = require('./helpers/hubPages');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { registry: REG } = loadLauncher(RAW);

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherC1: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const STYLES = [...RAW.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const DRILL_CSS = STYLES.filter((s) => s.includes('/* Drill-in pill strip for big-button tabs */'))[0];

const OPS = { id: 'firm:ops', label: 'Operations', icon: 'layer-group', action: { type: 'page' } };
const UI = { firm: { registry_overrides: { hidden: [], locked: [], renames: {}, items: [OPS] }, layout: { pages: { 'firm:ops': { tiles: [{ item: 'moreAutomations' }] } } } }, user: {} };
const SU = { isAdmin: true, roles: ['su'], denied: [], ui: UI };
const STAFF = { isAdmin: false, roles: ['staff'], denied: [], ui: UI };

function boot() {
  // every hub panel on the stage, as in the shell — but no hub tab, no hub mount
  const panels = stageHtml(REG);
  const tabs = new Set(['tabHome', 'tabAll', 'tabSettings']);   // Settings: a tab no registry item names since C4 (moreFeatures' tabAlso)
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabAll', 'tabMore', 'tabAdmin'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}<style>${DRILL_CSS}</style></head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <div class="home-egg-row"><script>ycLauncher.mount('homeIcons')</script></div></div>
    <div id="tabAll" class="tab-main"></div>
    ${plainTabs}
    <div id="ycPages"></div>
    <div id="ycPanels" style="display:none">${panels}</div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const calls = [];
  w.__calls = calls;
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(w.FEATURE_REGISTRY)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push(['${m[1]}']); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  // after the slices: TABS_SRC carries the shell's own openCasey
  w.openCasey = (o) => { calls.push(['openCasey', JSON.stringify(o)]); return true; };
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  const onStage = () => [...d.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id);
  const drilled = (tab) => d.getElementById(tab).classList.contains('drill-active');
  const pills = (tab) => [...d.querySelectorAll(`#${tab} > .feature-strip .pill-button`)].map((p) => p.textContent.trim());
  const activePill = (tab) => { const p = $(`#${tab} > .feature-strip .pill-button.active`); return p ? p.dataset.target : null; };
  return { w, d, L: w.ycLauncher, $, calls, errors, onStage, drilled, pills, activePill, close: () => w.close() };
}

describe('launcher-nits C1 — exec with no hub tiles', () => {
  let t;
  afterEach(() => t && t.close());

  test('1. a panel a page shows opens ON that page — drilled, its pill lit, no panel tab made', () => {
    t = boot();
    t.L.applyAccess(SU);
    const ops = t.$('#ycPages > [data-yc-page="firm:ops"]');
    expect(t.L.elementsOf('moreAutomations').more).toBeUndefined();           // no hub: no default tile
    expect(t.L.exec('moreAutomations')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(ops.id), t.activePill(ops.id)]).toEqual([ops.id, ['automationsDiv'], true, 'automationsDiv']);
    expect(t.$('#tabPanel')).toBe(null);
    expect(t.errors).toEqual([]);
  });

  test('2. a panel no page shows opens on the panel tab: <i> label <i>, one neutral tile, drilled; another swaps it; exec of the open one keeps it open', () => {
    t = boot();
    t.L.applyAccess(SU);
    t.w.openMainTab('tabHome');
    expect(t.L.exec('adminUsers')).toBe(true);
    const host = t.$('#tabPanel');
    expect([host.classList.contains('tab-main'), host.classList.contains('yc-hub'), host.nextElementSibling.id]).toEqual([true, true, 'ycPages']);   // before the pages, the stage after
    const h1 = host.querySelector(':scope > h1');
    expect([...h1.childNodes].map((n) => (n.nodeType === 3 ? n.nodeValue : n.className))).toEqual([`fa-solid fa-${REG.adminUsers.icon}`, ' Users ', `fa-solid fa-${REG.adminUsers.icon}`]);
    const tiles = () => [...host.querySelectorAll(':scope > .big-button')].map((b) => [b.getAttribute('data-yc-shortcut'), b.getAttribute('data-target'), b.textContent.trim()]);
    expect(tiles()).toEqual([['adminUsers', 'usersDiv', 'Users']]);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabPanel'), t.activePill('tabPanel'), t.pills('tabPanel')]).toEqual(['tabPanel', ['usersDiv'], true, 'usersDiv', ['All', 'Users']]);
    expect(t.d.querySelector('#usersDiv iframe').getAttribute('src')).toBe('/usersDiv.html');
    // exec of the panel that is up: it stays up (a tile toggles; exec doesn't close it)
    expect(t.L.exec('adminUsers')).toBe(true);
    expect(t.onStage()).toEqual(['usersDiv']);
    // another panel no page shows: the tile and the strip follow it
    expect(t.L.exec('moreManuals')).toBe(true);
    expect([tiles(), t.onStage(), t.activePill('tabPanel'), t.pills('tabPanel')]).toEqual([[['moreManuals', 'manualsDiv', 'Manuals']], ['manualsDiv'], 'manualsDiv', ['All', 'Manuals']]);
    expect(h1.textContent).toBe(' Manuals ');
    expect(t.d.querySelectorAll('#tabPanel')).toHaveLength(1);
    // a page that does show a panel still wins over the panel tab
    expect(t.L.exec('moreAutomations')).toBe(true);
    expect(t.w.currentMainTabId()).toBe(t.$('#ycPages > [data-yc-page="firm:ops"]').id);
    expect(t.errors).toEqual([]);
  });

  test('3. the hubs\' action items with no element run their own call', () => {
    t = boot();
    t.L.applyAccess(SU);
    expect(t.L.exec('moreSettings')).toBe(true);
    expect(t.w.currentMainTabId()).toBe('tabSettings');
    for (const id of ['adminEtch', 'casey', 'moreAssistant']) expect([id, t.L.exec(id)]).toEqual([id, true]);
    expect(t.calls.filter((c) => c[0] !== 'sync')).toEqual(expect.arrayContaining([['etchSwal'], ['toggleMascot'], ['openCasey', '{"expanded":true}']]));
    expect(t.$('#tabPanel')).toBe(null);
    expect(t.errors).toEqual([]);
  });

  test('4. what isn\'t yours is refused: a su panel for staff — nothing opens, no panel tab', () => {
    t = boot();
    t.L.applyAccess(STAFF);
    t.w.openMainTab('tabHome');
    expect(t.L.exec('adminDbConsole')).toBe(false);
    expect([t.w.currentMainTabId(), t.onStage(), t.$('#tabPanel')]).toEqual(['tabHome', [], null]);
  });
});

// launcher-nits C2 guarded every write to the Admin hub's sidebar row
// (#sbAdmin); C4 removed the row and every write with it — an unguarded one
// left behind throws at login, before applyAccess.
describe('launcher-nits C4 — no write to #sbAdmin is left', () => {
  test('the shell names sbAdmin nowhere', () => {
    expect(RAW).not.toMatch(/sbAdmin/);
  });
});
