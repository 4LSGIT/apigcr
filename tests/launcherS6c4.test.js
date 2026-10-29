/**
 * ui-custom S6c-4 — the panel stage. No visible change; every panel div lives
 * in ONE container after the tabs (#ycPanels), the drill is page-scoped with
 * a per-page memory, and a panel item's neutral tile on a page opens the
 * panel IN PLACE. Pins:
 *
 *   1. THE MARKUP AND CSS (the raw and the expanded page): every registry
 *      panel div is a direct child of #ycPanels and none is inside a hub; the
 *      stage is not a .tab-main and starts hidden; the panel CSS targets the
 *      stage (#ycPanels > div …), no `#tabMore > div` / `#tabAdmin > div`
 *      rule survives; the stage reproduces the hubs' text-align.
 *   2. THE STAGE, RUN FOR REAL (the page's own drill, tab and launcher code
 *      over a skeleton shaped like the page): one panel at a time; each page
 *      remembers its own; another tab hides the stage and a return shows the
 *      remembered panel again — the SAME iframe element, its src untouched
 *      (the no-reload guarantee, as far as jsdom can see; real Chrome:
 *      scripts/mobile-survey/wsurl.js (s3)); the open panel's tile or pill
 *      goes back to the grid; re-opening the current page exits the drill;
 *      exitDrillMode on a page that is not on screen touches no other page's
 *      panel; the re-shown panel is pinged (ycBecameVisible).
 *   3. NEUTRAL PANEL TILES: a panel item the firm places on another page
 *      carries data-target (no group, no onclick, no exec listener), its pill
 *      drives the same handler, and it opens the panel in place; an ACTION
 *      item's neutral still calls exec.
 *   4. EXEC ROUTING: the active page when it shows the id, else the first
 *      page that does (More, then Admin), else the panel tab (C1);
 *      opts.page first (the URL restore); a panel already up is left up.
 *
 * Since launcher-nits C4 More and Admin are the FIRM'S PAGES (firm:more /
 * firm:admin, built in #ycPages from the firm's layout — tests/helpers/
 * hubPages.js, the shape production has had since C3): their tiles are all
 * neutrals, so "the default tile" is gone and a panel no page shows opens on
 * the panel tab.
 *
 * The Simple Forms → Form Builder hand-off through exec is pinned in
 * tests/formBuilderSimpleHandoff.test.js; the wsurl side (a neutral in the
 * URL, J6 over the stage, wsFrameOwner by page) in tests/wsurlS2.test.js.
 *
 * Mutation-checked (see local/ui-custom/S6c4_worker_report.md).
 *
 * Run:  npx jest tests/launcherS6c4.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml, expandedShellHtml, loadLauncher } = require('./helpers/shellHtml');
const { hubFirm, hubPages, stageHtml, HISTORIC_LAYOUTS: HL } = require('./helpers/hubPages');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { registry: REG } = loadLauncher(RAW);
const placed = (sf) => HL[sf].filter((e) => e.item).map((e) => e.item);   // the old More / Admin grids: the pages' tiles
const TARGETS = Object.values(REG).map((it) => it.target).filter(Boolean);

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS6c4: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const STYLES = [...RAW.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const DRILL_CSS = (() => { const h = STYLES.filter((s) => s.includes('/* Drill-in pill strip for big-button tabs */')); if (h.length !== 1) throw new Error('drill css'); return h[0]; })();

// the firm's documents: More and Admin as its pages, with `pages` overriding their contents
const ui = (pages) => ({ firm: hubFirm(pages ? { layout: { pages } } : {}), user: {} });
const tilesOf = (ids) => ids.map((item) => ({ item }));
const SU = { isAdmin: true, roles: ['su'], denied: [], ui: ui() };
// the firm puts Users (an Admin panel) on More, and Manuals (a More panel) and Settings (an action tile) on Admin
const CROSS = {
  'firm:more': { ...hubPages()['firm:more'], tiles: [...hubPages()['firm:more'].tiles, { break: true }, { item: 'adminUsers' }] },
  'firm:admin': { ...hubPages()['firm:admin'], tiles: [...hubPages()['firm:admin'].tiles, { break: true }, { item: 'moreManuals' }, { item: 'moreSettings' }] },
};

// ─────────────────────────────────────────────────────────────────────────
describe('1. the markup and the CSS', () => {
  test('the stage: one #ycPanels after the pages, hidden, not a .tab-main; every registry panel div is its direct child; no hub (launcher-nits C4)', () => {
    expect(RAW.match(/id="ycPanels"/g)).toHaveLength(1);
    const dom = new JSDOM(expandedShellHtml());
    const d = dom.window.document;
    try {
      const stage = d.getElementById('ycPanels');
      expect(stage.classList.contains('tab-main')).toBe(false);
      expect(stage.style.display).toBe('none');
      expect(stage.previousElementSibling.id).toBe('ycPages');                       // the pages' container (S6c-5), then the stage
      expect([d.getElementById('tabMore'), d.getElementById('tabAdmin')]).toEqual([null, null]);   // the hubs are gone (C4)
      expect([...stage.children].map((c) => c.id).sort()).toEqual([...TARGETS].sort());
      for (const id of TARGETS) {
        const p = d.getElementById(id);
        expect([id, p.parentElement.id, p.style.display]).toEqual([id, 'ycPanels', 'none']);
        expect([id, p.querySelectorAll(':scope > iframe[data-src]').length]).toEqual([id, 1]);   // lazy, loaded on first open
      }
      expect(d.querySelectorAll('#ycPages div[id$="Div"], .tab-main div[id$="Div"].tab-main')).toHaveLength(0);
      // every tile's target is a stage panel (the pages hold tiles only)
      for (const t of d.querySelectorAll('.tab-main [data-target]')) expect([t.dataset.target, d.getElementById(t.dataset.target).parentElement.id]).toEqual([t.dataset.target, 'ycPanels']);
    } finally { dom.window.close(); }
  });

  test('the panel CSS targets the stage; no hub-scoped panel rule survives; the stage centres like a .tab-main', () => {
    expect(DRILL_CSS).toMatch(/#ycPanels \{ text-align: center; \}/);
    expect(DRILL_CSS).toMatch(/#ycPanels > div > iframe \{ box-sizing: border-box; \}/);
    // --view-as-offset: the View-as banner (2026-10-18) shrinks the stage like the header does
    expect(DRILL_CSS).toMatch(/#ycPanels > div > iframe \{\s*height: calc\(100vh - var\(--header-h\) - var\(--view-as-offset, 0px\) - 46px\) !important;\s*height: calc\(100dvh - var\(--header-h\) - var\(--view-as-offset, 0px\) - 46px\) !important;\s*\}/);
    expect(DRILL_CSS).toMatch(/#ycPanels > div \{ margin-top: 0 !important; \}/);
    for (const css of STYLES) expect(css).not.toMatch(/#tab(More|Admin) > div/);
    // the grid rules still select the tiles in their pages (keyed on the hubs' shared class since S6c-5)
    expect(DRILL_CSS).toMatch(/\.yc-hub > \.big-button \{/);
    expect(DRILL_CSS).toMatch(/\.yc-hub > br \{ display: none; \}/);
    expect(DRILL_CSS).toMatch(/\.drill-active > \.big-button, \.drill-active > br \{ display:none; \}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A page skeleton shaped like the real one: the mounts, the hubs, the stage
// after them; the page's own drill, tab and launcher code; recording stubs.
function boot() {
  const tabs = new Set(['tabHome', 'tabAll', 'tabSettings']);   // tabSettings: the shell's own (it came via moreFeatures' tabAlso before C4)
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabAll'].includes(t))
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
    <div id="ycPages"></div>
    <div id="ycPanels" style="display:none">${stageHtml(REG)}</div>
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
    'function pingBecameVisible(t) { __calls.push(["ping", t && (t.id || t.className)]); }\n';
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
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const onStage = () => [...d.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id);
  const stage = () => d.getElementById('ycPanels').style.display;
  const drilled = (tab) => d.getElementById(tab).classList.contains('drill-active');
  const activePill = (tab) => { const p = $(`#${tab} > .feature-strip .pill-button.active`); return p ? p.dataset.target || p.textContent.trim() : null; };
  const tile = (tab, id) => $(`#${tab} > .big-button[data-yc-shortcut="${id}"]`);
  const since = (n) => calls.slice(n);
  // the page tabs (per-session ids) — read after applyAccess built them
  const pageTab = (id) => { const e = $(`#ycPages > [data-yc-page="${id}"]`); return e ? e.id : null; };
  return { w, d, L, $, calls, errors, shown, onStage, stage, drilled, activePill, tile, since, page: pageTab, close: () => w.close() };
}

describe('2. the stage, for real: one panel, per-page memory, hidden off the pages, the same iframe', () => {
  let t, M, A;   // the More Features and Admin page tabs
  beforeEach(() => { t = boot(); t.L.applyAccess(SU); M = t.page('firm:more'); A = t.page('firm:admin'); });
  afterEach(() => t.close());

  test('one panel at a time; switching panels on a page; the open tile or pill goes back to the grid', () => {
    t.w.openMainTab(M);
    expect([t.stage(), t.onStage(), t.drilled(M)]).toEqual(['none', [], false]);
    t.tile(M, 'moreAutomations').click();
    expect([t.stage(), t.onStage(), t.drilled(M), t.activePill(M)]).toEqual(['', ['automationsDiv'], true, 'automationsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe').getAttribute('src')).toBe('/automationsDiv.html');   // the lazy load, once
    expect(t.d.querySelector('#automationsDiv iframe').hasAttribute('data-src')).toBe(false);
    t.tile(M, 'moreManuals').click();
    expect([t.onStage(), t.activePill(M)]).toEqual([['manualsDiv'], 'manualsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe').getAttribute('src')).toBe('/automationsDiv.html');   // kept
    // the pill of the OPEN panel → the grid; a pill of another panel → that panel
    t.$(`#${M} > .feature-strip .pill-button[data-target="manualsDiv"]`).click();
    expect([t.stage(), t.onStage(), t.drilled(M), t.activePill(M)]).toEqual(['none', [], false, null]);
    t.$(`#${M} > .feature-strip .pill-button[data-target="automationsDiv"]`).click();
    expect([t.onStage(), t.drilled(M)]).toEqual([['automationsDiv'], true]);
    // the open panel's own tile → the grid
    t.tile(M, 'moreAutomations').click();
    expect([t.stage(), t.onStage(), t.drilled(M)]).toEqual(['none', [], false]);
    expect(t.errors).toEqual([]);
  });

  test('per-page memory: More and Admin each show what THEY last opened; another tab hides the stage; a return shows the SAME iframe, untouched, and pings it', () => {
    t.w.openMainTab(M);
    t.tile(M, 'moreAutomations').click();
    const frame = t.d.querySelector('#automationsDiv iframe');
    t.w.openMainTab(A);
    expect([t.stage(), t.onStage(), t.drilled(A)]).toEqual(['none', [], false]);   // Admin's own grid
    expect(t.drilled(M)).toBe(true);                                                  // More still drilled (hidden)
    t.tile(A, 'adminUsers').click();
    expect([t.onStage(), t.drilled(A), t.activePill(A)]).toEqual([['usersDiv'], true, 'usersDiv']);
    t.w.openMainTab('tabCases');
    expect([t.stage(), t.onStage(), t.w.currentMainTabId()]).toEqual(['none', [], 'tabCases']);
    for (const p of t.d.querySelectorAll('#ycPanels > div')) expect(p.style.display).toBe('none');
    const n = t.calls.length;
    t.w.openMainTab(M);
    expect([t.stage(), t.onStage(), t.drilled(M), t.activePill(M)]).toEqual(['', ['automationsDiv'], true, 'automationsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe')).toBe(frame);                          // the same element
    expect([frame.getAttribute('src'), frame.hasAttribute('data-src')]).toEqual(['/automationsDiv.html', false]);
    expect(t.since(n).filter((c) => c[0] === 'ping').map((c) => c[1])).toEqual(['automationsDiv', M]);   // the panel, then the tab
    t.w.openMainTab(A);
    expect([t.onStage(), t.activePill(A)]).toEqual([['usersDiv'], 'usersDiv']);
    expect(t.errors).toEqual([]);
  });

  test('re-opening the page you are on exits its drill (the menu); exitDrillMode on a page NOT on screen only forgets — the stage keeps the active page\'s panel', () => {
    t.w.openMainTab(M);
    t.tile(M, 'moreAutomations').click();
    t.w.openMainTab(A);
    t.tile(A, 'adminUsers').click();
    // More is not on screen: forgetting its panel must not touch Users on the stage
    t.w.exitDrillMode(t.d.getElementById(M));
    expect([t.onStage(), t.drilled(M), t.drilled(A)]).toEqual([['usersDiv'], false, true]);
    t.w.openMainTab(M);
    expect([t.stage(), t.onStage()]).toEqual(['none', []]);                                  // forgotten
    t.w.openMainTab(A);
    expect(t.onStage()).toEqual(['usersDiv']);
    t.w.openMainTab(A);                                                              // the tab you are on: back to the menu
    expect([t.stage(), t.onStage(), t.drilled(A), t.activePill(A)]).toEqual(['none', [], false, null]);
    expect(t.errors).toEqual([]);
  });
});

describe('3. neutral panel tiles open in place; 4. exec routes by page', () => {
  let t, M, A;
  beforeEach(() => { t = boot(); t.L.applyAccess({ ...SU, ui: ui(CROSS) }); M = t.page('firm:more'); A = t.page('firm:admin'); });
  afterEach(() => t.close());

  test('a panel item\'s neutral carries data-target only (no group, no onclick, not a launcher element); its pill drives the handler; the panel opens IN PLACE', () => {
    const n = t.$(`#${M} > .big-button[data-yc-shortcut="adminUsers"]`);
    expect([n.getAttribute('data-target'), n.hasAttribute('data-exclusive-group'), n.hasAttribute('onclick'), n.hasAttribute('id')]).toEqual(['usersDiv', false, false, false]);
    expect(Object.keys(t.L.elementsOf('adminUsers'))).toEqual([]);   // no hub: no default element (C4) — every page tile is a neutral
    const m = t.$(`#${A} > .big-button[data-yc-shortcut="moreManuals"]`);
    expect(m.getAttribute('data-target')).toBe('manualsDiv');
    t.w.openMainTab(M);
    const k = t.calls.length;
    n.click();
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(M), t.drilled(A), t.activePill(M)]).toEqual([M, ['usersDiv'], true, false, 'usersDiv']);
    expect(t.since(k).filter((c) => c[0] !== 'sync' && c[0] !== 'ping')).toEqual([]);         // no opener ran, no tab switch
    const pill = t.$(`#${M} > .feature-strip .pill-button[data-target="usersDiv"]`);
    expect([pill.hasAttribute('data-exclusive-group'), pill.textContent.trim()]).toEqual([false, REG.adminUsers.label]);
    t.$(`#${M} > .feature-strip .pill-button[data-target="automationsDiv"]`).click();
    expect(t.onStage()).toEqual(['automationsDiv']);
    pill.click();
    expect([t.onStage(), t.activePill(M)]).toEqual([['usersDiv'], 'usersDiv']);
    // the same panel from Admin's own tile: one element, opened there
    t.w.openMainTab(A);
    expect(t.onStage()).toEqual([]);
    t.tile(A, 'adminUsers').click();
    expect([t.onStage(), t.drilled(A), t.activePill(A)]).toEqual([['usersDiv'], true, 'usersDiv']);
    expect(t.d.querySelectorAll('#usersDiv').length).toBe(1);
    // an ACTION item's neutral still calls exec (Settings on Admin opens its tab)
    t.$(`#${A} > .big-button[data-yc-shortcut="moreSettings"]`).click();
    expect(t.w.currentMainTabId()).toBe('tabSettings');
    expect(t.errors).toEqual([]);
  });

  test('exec: the active page first, else the firm\'s pages in order (More, then Admin); opts.page first; an open panel is left up; an action item runs in place', () => {
    // from Cases: Users is placed on More (neutral) and Admin (default) — More wins
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(M)]).toEqual([M, ['usersDiv'], true]);
    // on Admin: Admin shows it — in place, no switch
    t.w.openMainTab(A);
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(A)]).toEqual([A, ['usersDiv'], true]);
    // already up here: left up (a tile toggles; exec never closes)
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual([A, ['usersDiv']]);
    // opts.page: the URL restore names the page
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers', { page: A })).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual([A, ['usersDiv']]);
    t.w.openMainTab('tabCases');
    expect(t.L.exec('moreManuals', { page: A })).toBe(true);                        // Manuals' neutral on Admin
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual([A, ['manualsDiv']]);
    // a More-only panel from Admin: its default page
    expect(t.L.exec('moreAutomations')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(M)]).toEqual([M, ['automationsDiv'], true]);
    // an action item has no element of its own now: exec runs its call in place, no tab switch (C1 NO_ELEMENT)
    expect(t.L.exec('adminEtch')).toBe(true);
    expect([t.w.currentMainTabId(), t.calls.filter((c) => c[0] === 'etchSwal').length]).toEqual([M, 1]);
    expect(t.errors).toEqual([]);
  });

  test('a panel the firm takes off one page: exec prefers a page that SHOWS it; with none, it opens on the panel tab (launcher-nits C1), its pill lit', () => {
    const onlyMore = { ...CROSS, 'firm:admin': { ...hubPages()['firm:admin'], tiles: tilesOf(placed('admin').filter((k) => k !== 'adminUsers')) } };
    t.L.applyAccess({ ...SU, ui: ui(onlyMore) });
    expect(t.tile(A, 'adminUsers')).toBe(null);
    t.w.openMainTab(A);
    expect(t.L.exec('adminUsers')).toBe(true);                                                // Admin doesn't show it → More does
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled(M)]).toEqual([M, ['usersDiv'], true]);
    // nowhere shown: the panel tab (C1)
    t.L.applyAccess({ ...SU, ui: ui({ 'firm:more': hubPages()['firm:more'], 'firm:admin': onlyMore['firm:admin'] }) });
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabPanel'), t.activePill('tabPanel'), t.drilled(A)]).toEqual(['tabPanel', ['usersDiv'], true, 'usersDiv', false]);
    expect(t.errors).toEqual([]);
  });
});
