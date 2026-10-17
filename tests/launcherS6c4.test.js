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
 *      page that does (More, then Admin), else the hidden default tile;
 *      opts.page first (the URL restore); a panel already up is left up.
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

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { registry: REG, layouts: LAY } = loadLauncher(RAW);
const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
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

const ui = ({ layout, firm, ro } = {}) => ({ firm: { ...(ro ? { registry_overrides: ro } : {}), ...(firm ? { layout: firm } : {}) }, user: layout ? { layout } : {} });
const SU = { isAdmin: true, roles: ['su'], denied: [] };
// the firm puts Users (an Admin panel) and Settings (an action tile) on More, and Manuals (a More panel) on Admin
const CROSS = { placed: {
  more: [...placed('more').map((k) => ({ item: k })), { break: true }, { item: 'adminUsers' }],
  admin: [...placed('admin').map((k) => ({ item: k })), { break: true }, { item: 'moreManuals' }, { item: 'moreSettings' }],
} };

// ─────────────────────────────────────────────────────────────────────────
describe('1. the markup and the CSS', () => {
  test('the stage: one #ycPanels after the hubs, hidden, not a .tab-main; every registry panel div is its direct child and none is inside a hub', () => {
    expect(RAW.match(/id="ycPanels"/g)).toHaveLength(1);
    const dom = new JSDOM(expandedShellHtml());
    const d = dom.window.document;
    try {
      const stage = d.getElementById('ycPanels');
      expect(stage.classList.contains('tab-main')).toBe(false);
      expect(stage.style.display).toBe('none');
      expect(stage.previousElementSibling.id).toBe('ycPages');                       // the custom pages' container (S6c-5), then the stage
      expect(stage.previousElementSibling.previousElementSibling.id).toBe('tabAdmin');
      expect([...stage.children].map((c) => c.id).sort()).toEqual([...TARGETS].sort());
      for (const id of TARGETS) {
        const p = d.getElementById(id);
        expect([id, p.parentElement.id, p.style.display]).toEqual([id, 'ycPanels', 'none']);
        expect([id, p.querySelectorAll(':scope > iframe[data-src]').length]).toEqual([id, 1]);   // lazy, loaded on first open
      }
      expect(d.querySelectorAll('#tabMore div[id$="Div"], #tabAdmin div[id$="Div"]:not(#sequencesDiv)')).toHaveLength(0);
      // every tile's target is a stage panel (the pages hold tiles only)
      for (const t of d.querySelectorAll('.tab-main [data-target]')) expect([t.dataset.target, d.getElementById(t.dataset.target).parentElement.id]).toEqual([t.dataset.target, 'ycPanels']);
    } finally { dom.window.close(); }
  });

  test('the panel CSS targets the stage; no hub-scoped panel rule survives; the stage centres like a .tab-main', () => {
    expect(DRILL_CSS).toMatch(/#ycPanels \{ text-align: center; \}/);
    expect(DRILL_CSS).toMatch(/#ycPanels > div > iframe \{ box-sizing: border-box; \}/);
    expect(DRILL_CSS).toMatch(/#ycPanels > div > iframe \{\s*height: calc\(100vh - var\(--header-h\) - 46px\) !important;\s*height: calc\(100dvh - var\(--header-h\) - 46px\) !important;\s*\}/);
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
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabAll']);
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
    <div id="tabMore" class="tab-main"><h1>More</h1>
  <script>ycLauncher.mount('more')</script>
  <div class="more-egg-row"><script>ycLauncher.mount('moreIcons')</script></div></div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1>
  <script>ycLauncher.mount('admin')</script>
  <div class="admin-egg-row"><script>ycLauncher.mount('adminIcons')</script></div></div>
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
  const tile = (tab, id) => $(`#${tab} > .big-button[data-yc-shortcut="${id}"]`) || L.elementsOf(id)[tab === 'tabMore' ? 'more' : 'admin'];
  const since = (n) => calls.slice(n);
  return { w, d, L, $, calls, errors, shown, onStage, stage, drilled, activePill, tile, since, close: () => w.close() };
}

describe('2. the stage, for real: one panel, per-page memory, hidden off the pages, the same iframe', () => {
  let t;
  beforeEach(() => { t = boot(); t.L.applyAccess(SU); });
  afterEach(() => t.close());

  test('one panel at a time; switching panels on a page; the open tile or pill goes back to the grid', () => {
    t.w.openMainTab('tabMore');
    expect([t.stage(), t.onStage(), t.drilled('tabMore')]).toEqual(['none', [], false]);
    t.tile('tabMore', 'moreAutomations').click();
    expect([t.stage(), t.onStage(), t.drilled('tabMore'), t.activePill('tabMore')]).toEqual(['', ['automationsDiv'], true, 'automationsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe').getAttribute('src')).toBe('/automationsDiv.html');   // the lazy load, once
    expect(t.d.querySelector('#automationsDiv iframe').hasAttribute('data-src')).toBe(false);
    t.tile('tabMore', 'moreManuals').click();
    expect([t.onStage(), t.activePill('tabMore')]).toEqual([['manualsDiv'], 'manualsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe').getAttribute('src')).toBe('/automationsDiv.html');   // kept
    // the pill of the OPEN panel → the grid; a pill of another panel → that panel
    t.$('#tabMore > .feature-strip .pill-button[data-target="manualsDiv"]').click();
    expect([t.stage(), t.onStage(), t.drilled('tabMore'), t.activePill('tabMore')]).toEqual(['none', [], false, null]);
    t.$('#tabMore > .feature-strip .pill-button[data-target="automationsDiv"]').click();
    expect([t.onStage(), t.drilled('tabMore')]).toEqual([['automationsDiv'], true]);
    // the open panel's own tile → the grid
    t.tile('tabMore', 'moreAutomations').click();
    expect([t.stage(), t.onStage(), t.drilled('tabMore')]).toEqual(['none', [], false]);
    expect(t.errors).toEqual([]);
  });

  test('per-page memory: More and Admin each show what THEY last opened; another tab hides the stage; a return shows the SAME iframe, untouched, and pings it', () => {
    t.w.openMainTab('tabMore');
    t.tile('tabMore', 'moreAutomations').click();
    const frame = t.d.querySelector('#automationsDiv iframe');
    t.w.openMainTab('tabAdmin');
    expect([t.stage(), t.onStage(), t.drilled('tabAdmin')]).toEqual(['none', [], false]);   // Admin's own grid
    expect(t.drilled('tabMore')).toBe(true);                                                  // More still drilled (hidden)
    t.tile('tabAdmin', 'adminUsers').click();
    expect([t.onStage(), t.drilled('tabAdmin'), t.activePill('tabAdmin')]).toEqual([['usersDiv'], true, 'usersDiv']);
    t.w.openMainTab('tabCases');
    expect([t.stage(), t.onStage(), t.w.currentMainTabId()]).toEqual(['none', [], 'tabCases']);
    for (const p of t.d.querySelectorAll('#ycPanels > div')) expect(p.style.display).toBe('none');
    const n = t.calls.length;
    t.w.openMainTab('tabMore');
    expect([t.stage(), t.onStage(), t.drilled('tabMore'), t.activePill('tabMore')]).toEqual(['', ['automationsDiv'], true, 'automationsDiv']);
    expect(t.d.querySelector('#automationsDiv iframe')).toBe(frame);                          // the same element
    expect([frame.getAttribute('src'), frame.hasAttribute('data-src')]).toEqual(['/automationsDiv.html', false]);
    expect(t.since(n).filter((c) => c[0] === 'ping').map((c) => c[1])).toEqual(['automationsDiv', 'tabMore']);   // the panel, then the tab
    t.w.openMainTab('tabAdmin');
    expect([t.onStage(), t.activePill('tabAdmin')]).toEqual([['usersDiv'], 'usersDiv']);
    expect(t.errors).toEqual([]);
  });

  test('re-opening the page you are on exits its drill (the menu); exitDrillMode on a page NOT on screen only forgets — the stage keeps the active page\'s panel', () => {
    t.w.openMainTab('tabMore');
    t.tile('tabMore', 'moreAutomations').click();
    t.w.openMainTab('tabAdmin');
    t.tile('tabAdmin', 'adminUsers').click();
    // More is not on screen: forgetting its panel must not touch Users on the stage
    t.w.exitDrillMode(t.d.getElementById('tabMore'));
    expect([t.onStage(), t.drilled('tabMore'), t.drilled('tabAdmin')]).toEqual([['usersDiv'], false, true]);
    t.w.openMainTab('tabMore');
    expect([t.stage(), t.onStage()]).toEqual(['none', []]);                                  // forgotten
    t.w.openMainTab('tabAdmin');
    expect(t.onStage()).toEqual(['usersDiv']);
    t.w.openMainTab('tabAdmin');                                                              // the tab you are on: back to the menu
    expect([t.stage(), t.onStage(), t.drilled('tabAdmin'), t.activePill('tabAdmin')]).toEqual(['none', [], false, null]);
    expect(t.errors).toEqual([]);
  });
});

describe('3. neutral panel tiles open in place; 4. exec routes by page', () => {
  let t;
  beforeEach(() => { t = boot(); t.L.applyAccess({ ...SU, ui: ui({ firm: CROSS }) }); });
  afterEach(() => t.close());

  test('a panel item\'s neutral carries data-target only (no group, no onclick, not a launcher element); its pill drives the handler; the panel opens IN PLACE', () => {
    const n = t.$('#tabMore > .big-button[data-yc-shortcut="adminUsers"]');
    expect([n.getAttribute('data-target'), n.hasAttribute('data-exclusive-group'), n.hasAttribute('onclick'), n.hasAttribute('id')]).toEqual(['usersDiv', false, false, false]);
    expect(Object.keys(t.L.elementsOf('adminUsers'))).toEqual(['admin']);
    const m = t.$('#tabAdmin > .big-button[data-yc-shortcut="moreManuals"]');
    expect(m.getAttribute('data-target')).toBe('manualsDiv');
    t.w.openMainTab('tabMore');
    const k = t.calls.length;
    n.click();
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabMore'), t.drilled('tabAdmin'), t.activePill('tabMore')]).toEqual(['tabMore', ['usersDiv'], true, false, 'usersDiv']);
    expect(t.since(k).filter((c) => c[0] !== 'sync' && c[0] !== 'ping')).toEqual([]);         // no opener ran, no tab switch
    const pill = t.$('#tabMore > .feature-strip .pill-button[data-target="usersDiv"]');
    expect([pill.hasAttribute('data-exclusive-group'), pill.textContent.trim()]).toEqual([false, REG.adminUsers.label]);
    t.$('#tabMore > .feature-strip .pill-button[data-target="automationsDiv"]').click();
    expect(t.onStage()).toEqual(['automationsDiv']);
    pill.click();
    expect([t.onStage(), t.activePill('tabMore')]).toEqual([['usersDiv'], 'usersDiv']);
    // the same panel from Admin's default tile: one element, opened there
    t.w.openMainTab('tabAdmin');
    expect(t.onStage()).toEqual([]);
    t.L.elementsOf('adminUsers').admin.click();
    expect([t.onStage(), t.drilled('tabAdmin'), t.activePill('tabAdmin')]).toEqual([['usersDiv'], true, 'usersDiv']);
    expect(t.d.querySelectorAll('#usersDiv').length).toBe(1);
    // an ACTION item's neutral still calls exec (Settings on Admin opens its tab)
    t.$('#tabAdmin > .big-button[data-yc-shortcut="moreSettings"]').click();
    expect(t.w.currentMainTabId()).toBe('tabSettings');
    expect(t.errors).toEqual([]);
  });

  test('exec: the active page first, else More then Admin, else the hidden default; opts.page first; an open panel is left up', () => {
    // from Cases: Users is placed on More (neutral) and Admin (default) — More wins
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabMore')]).toEqual(['tabMore', ['usersDiv'], true]);
    // on Admin: Admin shows it — in place, no switch
    t.w.openMainTab('tabAdmin');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabAdmin')]).toEqual(['tabAdmin', ['usersDiv'], true]);
    // already up here: left up (a tile toggles; exec never closes)
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual(['tabAdmin', ['usersDiv']]);
    // opts.page: the URL restore names the page
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers', { page: 'tabAdmin' })).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual(['tabAdmin', ['usersDiv']]);
    t.w.openMainTab('tabCases');
    expect(t.L.exec('moreManuals', { page: 'tabAdmin' })).toBe(true);                        // Manuals' neutral on Admin
    expect([t.w.currentMainTabId(), t.onStage()]).toEqual(['tabAdmin', ['manualsDiv']]);
    // a More-only panel from Admin: its default page
    expect(t.L.exec('moreAutomations')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabMore')]).toEqual(['tabMore', ['automationsDiv'], true]);
    // an action tile: its default page, then its opener (as before)
    expect(t.L.exec('adminEtch')).toBe(true);
    expect([t.w.currentMainTabId(), t.calls.filter((c) => c[0] === 'etchSwal').length]).toEqual(['tabAdmin', 1]);
    expect(t.errors).toEqual([]);
  });

  test('a firm-unplaced default tile: exec prefers a page that SHOWS the item; with none, the hidden default still opens its panel (no pill lit)', () => {
    t.L.applyAccess({ ...SU, ui: ui({ firm: { placed: {
      more: [...placed('more').map((k) => ({ item: k })), { break: true }, { item: 'adminUsers' }],
      admin: placed('admin').filter((k) => k !== 'adminUsers').map((k) => ({ item: k })),
    }, removed: { admin: ['adminUsers'] } } }) });
    const def = t.L.elementsOf('adminUsers').admin;
    expect(def.hasAttribute('data-yc-unplaced')).toBe(true);
    t.w.openMainTab('tabAdmin');
    expect(t.L.exec('adminUsers')).toBe(true);                                                // Admin hides it → More shows it
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabMore')]).toEqual(['tabMore', ['usersDiv'], true]);
    // nowhere shown: the hidden default on its own page
    t.L.applyAccess({ ...SU, ui: ui({ firm: { placed: { admin: placed('admin').filter((k) => k !== 'adminUsers').map((k) => ({ item: k })) }, removed: { admin: ['adminUsers'] } } }) });
    t.w.openMainTab('tabCases');
    expect(t.L.exec('adminUsers')).toBe(true);
    expect([t.w.currentMainTabId(), t.onStage(), t.drilled('tabAdmin'), t.activePill('tabAdmin')]).toEqual(['tabAdmin', ['usersDiv'], true, null]);
    expect(t.errors).toEqual([]);
  });
});
