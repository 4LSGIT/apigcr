// tests/launcherS2.test.js
//
/**
 * ui-custom S2 — the launcher's effective registry, the entitlement hide pass,
 * exec(id), the All tab and the Ctrl-K palette.
 *
 *   1. THE MATH (ycLauncher.computeEffective / matchTier / rank, run in a bare
 *      vm over the real registry): admin-gated items out unless the admin
 *      signal holds; denied ids out, except the undeniable set, which the
 *      client strips again rather than trust its input; the custom tab only
 *      while the user has one; every placed item exactly once, grouped by
 *      origin in the shipped group order. The matcher's three tiers and the
 *      All-order tie-break.
 *   2. THE MECHANISM, RUN FOR REAL in jsdom: the page's own renderer mounts the
 *      four surfaces (recording the id → element map), and the page's own
 *      drill-in script, openMainTab / updateSidebarActive and applyCustomTab
 *      run over them — extracted from public/index.html, not re-typed. The
 *      hide pass reaches both renderings of a shared item, keeps a denied tile
 *      out of the pill strip (and rebuilds a stale one), and survives
 *      applyCustomTab writing style.display. exec() lands where a click on the
 *      real element lands, and refuses what the user may not see.
 *   3. public/js/ycAll.js in the same page: All lists every effective item
 *      once, by group, with no drill attributes; its search and the palette
 *      share the matcher and run through exec(); the palette opens on Ctrl/⌘-K
 *      from a focused input only once signed in and never over a Swal, and
 *      Esc gives focus back.
 *
 * Mutation-checked (each made a test here fail): ensureStrip without the
 * [data-yc-denied] filter; the undeniable strip removed; the admin gate
 * dropped; exec() without its already-open-panel check; the hide pass by
 * style.display instead of the attribute; word-start ranked above substring;
 * All entries given data-target; the palette's pre-login guard removed; the
 * palette's Swal guard removed; applyCustomTab no longer telling the launcher;
 * the palette listening in the capture phase (an editor's own Ctrl-K lost); a
 * toast counted as a dialog; iframes not hooked; the top window's Swal check
 * dropped; loadUserContext not calling applyAccess; isAdmin not passed;
 * loadFirmData not copying denied; placeholders not dropped.
 *
 * Run:  npx jest tests/launcherS2.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml, loadLauncher } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { launcher: L, registry: REG, layouts: LAY } = loadLauncher(RAW);

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS2: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
// The page's own code, cut out of public/index.html.
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CUSTOM_SRC = slice('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const DENIED_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const FIRMDATA_INIT = slice('    window.firmData = { phoneLines', ';\n') + ';\n';
const LOAD_FIRMDATA = slice('async function loadFirmData() {', '\n}\n') + '\n}\n';
// loadUserContext up to the badge refreshes: the admin signal, the custom tab
// and the launcher's applyAccess — closed off into a callable function.
const LUC_HEAD = slice('    async function loadUserContext() {', '      tasksBadgeRefresh();') + '\n    }\n';
const LUC_FULL = slice('    async function loadUserContext() {', '    async function ') ;

const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
const ALL_PLACED = [...new Set(['sidebar', 'home', 'homeIcons', 'more', 'moreIcons', 'admin', 'adminIcons'].flatMap(placed))];   // the icon rows place too (S6c)
// ui-custom S6b: registry items in no default layout are listed too, group
// "More actions" (the set itself is pinned by featureRegistry.test.js).
const EXTRAS = Object.keys(REG).filter((k) => !ALL_PLACED.includes(k));
const ALL_LISTED = [...ALL_PLACED, ...EXTRAS];
// ui-custom S6c: a gate is the registry's own (`gate`), no longer derived from
// the Admin grid; the Admin PAGE (`admin`) is visibility (the firm's visible_to).
const GATED = new Set(Object.keys(REG).filter((k) => REG[k].gate));
const ids = (eff) => eff.map((e) => e.id);

// ─────────────────────────────────────────────────────────────────────────
describe('the effective registry (pure)', () => {
  test('non-admin: every placed item (and every S6b extra) once, minus gated and the absent custom tab', () => {
    const eff = L.computeEffective({ isAdmin: false });
    expect(EXTRAS).toEqual(['myTasks', 'logout']);
    const want = ALL_LISTED.filter((k) => !GATED.has(k) && k !== 'custom');
    expect(ids(eff).sort()).toEqual(want.sort());
    expect(new Set(ids(eff)).size).toBe(eff.length);
    expect(ids(eff)).not.toContain('adminDbConsole');
    // the Admin page item is not gated: the firm's visible_to decides (S6c)
    expect(ids(eff)).toContain('admin');
    const ro = { visible_to: { admin: ['it', 'admin'] } };
    expect(ids(L.computeEffective({ isAdmin: false, roles: ['staff'], ui: { firm: { registry_overrides: ro } } }))).not.toContain('admin');
    expect(ids(L.computeEffective({ isAdmin: false, roles: ['admin'], ui: { firm: { registry_overrides: ro } } }))).toContain('admin');
  });

  test('admin: the Admin grid and the Admin item come back', () => {
    const eff = L.computeEffective({ isAdmin: true, customTab: { src: '/x.html' } });
    expect(ids(eff).sort()).toEqual([...ALL_LISTED].sort());
    for (const k of GATED) expect(ids(eff)).toContain(k);
  });

  test('denied ids go; the undeniable set and junk entries are ignored; a non-array is ignored', () => {
    const eff = L.computeEffective({ denied: ['moreAutomations', 'cases', 'moreSettings', 'helpSupport', 'nope', 42, null] });
    expect(ids(eff)).not.toContain('moreAutomations');
    expect(ids(eff)).not.toContain('cases');
    expect(ids(eff)).toContain('moreSettings');
    expect(ids(eff)).toContain('helpSupport');
    expect([...L.UNDENIABLE].sort()).toEqual(['all', 'helpSupport', 'moreSettings']);
    expect(ids(L.computeEffective({ denied: 'cases' }))).toContain('cases');
    expect(ids(L.computeEffective({ denied: { cases: true } }))).toContain('cases');
  });

  test('the custom tab: listed only while the user has one, under its own title and icon', () => {
    expect(ids(L.computeEffective({ customTab: { title: 'x' } }))).not.toContain('custom');
    const c = L.computeEffective({ customTab: { src: '/forms.html', title: 'My Forms', icon: 'book' } }).find((e) => e.id === 'custom');
    expect([c.label, c.icon]).toEqual(['My Forms', 'book']);
    expect(L.computeEffective({ customTab: { src: '/forms.html' } }).find((e) => e.id === 'custom').label).toBe(REG.custom.label);
  });

  test('groups: by origin — sidebar section, else Home, else the grid, else More actions — in the shipped order', () => {
    const eff = L.computeEffective({ isAdmin: true, customTab: { src: '/x' } });
    // the order rides on the list (computeEffective is pure since S4a)
    expect(eff.groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);
    // S6b: the items no default layout places, in registry order
    expect(ids(eff.filter((e) => e.group === 'More actions'))).toEqual(EXTRAS);
    const g = Object.fromEntries(eff.map((e) => [e.id, e.group]));
    expect([g.cases, g.calendar, g.pipeline, g.newClient, g.admin, g.helpSupport, g.moreManuals, g.adminMailboxes])
      .toEqual(['Records', 'Records', 'Actions', 'Actions', 'Settings', 'Settings', 'More', 'Admin']);
    // ordered by group, then by layout order within it
    const order = eff.groups;
    for (let i = 1; i < eff.length; i++) expect(order.indexOf(eff[i - 1].group)).toBeLessThanOrEqual(order.indexOf(eff[i].group));
    expect(ids(eff.filter((e) => e.group === 'More'))).toEqual([...placed('more'), ...placed('moreIcons')]);   // the icon row is the grid's group (S6c)
    // surfaceLabels feed the matcher
    expect(eff.find((e) => e.id === 'bills').labels).toEqual(['Bills', 'Billing']);
  });
});

describe('the matcher (pure)', () => {
  test('tiers: substring 3 > word-start 2 > in-order subsequence 1 > none 0', () => {
    expect(L.matchTier('form b', 'Form Builder')).toBe(3);
    expect(L.matchTier('BUILD', 'Form Builder')).toBe(3);
    expect(L.matchTier('fb', 'Form Builder')).toBe(2);
    expect(L.matchTier('simform', 'Simple Forms')).toBe(2);
    expect(L.matchTier('dbc', 'DB Console (SU)')).toBe(2);
    expect(L.matchTier('atmns', 'Automations')).toBe(1);
    expect(L.matchTier('xyz', 'Cases')).toBe(0);
    expect(L.matchTier('   ', 'Cases')).toBe(0);
  });

  test('rank: tier first, then the given (All) order; blank returns everything in order', () => {
    const E = (label) => ({ id: label, label, labels: [label] });
    const D = E('Arb'), B = E('Alpha Beta'), A = E('Grab bag'), C = E('Cab'), N = E('Nothing');
    expect(L.rank('ab', [D, B, A, N, C]).map((e) => e.id)).toEqual(['Grab bag', 'Cab', 'Alpha Beta', 'Arb']);
    expect(L.rank(' ', [D, B]).map((e) => e.id)).toEqual(['Arb', 'Alpha Beta']);
  });

  test('over the real registry: a surface label finds its item; a non-admin never finds an admin tile', () => {
    expect(L.rank('billing', L.computeEffective({}))[0].id).toBe('bills');
    expect(L.rank('DB Console', L.computeEffective({ isAdmin: false }))).toEqual([]);
    expect(L.rank('DB Console', L.computeEffective({ isAdmin: true }))[0].id).toBe('adminDbConsole');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A page skeleton with the real mounts, panels and tab divs; the page's own
// drill-in, tab and custom-tab code evaluated into it.
function boot({ withAll = false } = {}) {
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${DENIED_CSS}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div>
      <script>ycLauncher.mount('sidebar')</script>
      </nav>
    <div id="tabHome" class="tab-main"><script>ycLauncher.mount('home')</script></div>
    ${withAll ? ALL_TAB : '<div id="tabAll" class="tab-main"></div>'}
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script>${grid('admin')}</div>
    <textarea id="elsewhere"></textarea><b id="myNameIs"></b><div id="hdrUserArea"></div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  const calls = [];
  w.__calls = calls;
  // Openers: an item's bare `fn()` onclick records itself and, when the item
  // names a tab, opens it the way the real opener does.
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\n' +
    'function syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + CUSTOM_SRC + DRILL_SRC);
  if (withAll) w.eval(YCALL_SRC);
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const active = () => [...d.querySelectorAll('#appSidebar .sb-item.active')].map((e) => e.dataset.tab || e.id);
  const pills = (tab) => [...d.querySelectorAll(`#${tab} > .feature-strip .pill-button`)].slice(1).map((p) => p.dataset.target || p.textContent.trim());
  return { w, d, $, L: w.ycLauncher, calls, errors, shown, active, pills, close: () => w.close() };
}

describe('the id → element map (mount, for real)', () => {
  let t;
  beforeAll(() => { t = boot(); });
  afterAll(() => t.close());

  test('every laid-out item maps to its element on every surface it is on — no strays, no repeats', () => {
    expect(t.errors).toEqual([]);
    const seen = new Set();
    for (const sf of ['sidebar', 'home', 'more', 'admin']) for (const id of placed(sf)) {
      const el = t.L.elementsOf(id)[sf];
      expect([id, sf, !!el]).toEqual([id, sf, true]);
      expect(seen.has(el)).toBe(false);
      seen.add(el);
    }
    const cases = t.L.elementsOf('cases');
    expect(Object.keys(cases).sort()).toEqual(['home', 'sidebar']);
    expect(cases.sidebar.dataset.tab).toBe('tabCases');
    expect(cases.home.className).toBe('home-btn');
    expect(t.L.elementsOf('moreAutomations').more.dataset.target).toBe('automationsDiv');
    expect(t.L.elementsOf('nope')).toEqual({});
  });
});

describe('the hide pass (for real)', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('a denied shared item is hidden on BOTH surfaces; a denied tile is hidden and gets no pill', () => {
    t.L.applyAccess({ isAdmin: false, denied: ['cases', 'moreAutomations'], customTab: null });
    const c = t.L.elementsOf('cases');
    expect([t.shown(c.sidebar), t.shown(c.home)]).toEqual([false, false]);
    expect(t.shown(t.L.elementsOf('moreAutomations').more)).toBe(false);
    expect(t.shown(t.L.elementsOf('contacts').sidebar)).toBe(true);
    t.L.elementsOf('moreManuals').more.click();          // drill in: builds the strip
    expect(t.d.getElementById('tabMore').classList.contains('drill-active')).toBe(true);
    expect(t.pills('tabMore')).not.toContain('automationsDiv');
    expect(t.pills('tabMore')).toHaveLength(placed('more').length - 1);
  });

  test('the undeniable set stays shown whatever denied[] says', () => {
    t.L.applyAccess({ denied: ['moreSettings', 'helpSupport'] });
    expect(t.shown(t.L.elementsOf('moreSettings').more)).toBe(true);
    expect(t.shown(t.L.elementsOf('helpSupport').sidebar)).toBe(true);
    expect(t.d.querySelectorAll('[data-yc-denied]:not(#tabAdmin *)')).toHaveLength(0);   // (#tabAdmin: the su tiles, hidden for this non-su since S6c)
  });

  test('idempotent: re-running neither double-hides nor sticks; applyCustomTab cannot resurrect a denied item', () => {
    t.L.applyAccess({ denied: ['custom', 'cases'] });
    const n = t.d.querySelectorAll('[data-yc-denied]:not(#tabAdmin *)').length;   // (the su tiles carry it too for a non-su, S6c)
    expect(n).toBe(4);                                     // custom ×2 + cases ×2
    t.L.applyAccess({ denied: ['custom', 'cases'] });
    expect(t.d.querySelectorAll('[data-yc-denied]:not(#tabAdmin *)')).toHaveLength(n);
    t.w.applyCustomTab({ src: '/x.html', title: 'X' });    // writes style.display = '' on both
    const c = t.L.elementsOf('custom');
    expect([c.sidebar.style.display, c.home.style.display]).toEqual(['', '']);
    expect([t.shown(c.sidebar), t.shown(c.home)]).toEqual([false, false]);
    expect(t.L.effectiveRegistry().map((e) => e.id)).not.toContain('custom');
    t.L.applyAccess({ denied: [] });                      // lifted → back
    expect(t.d.querySelectorAll('[data-yc-denied]:not(#tabAdmin *)')).toHaveLength(0);
    expect([t.shown(c.sidebar), t.shown(c.home)]).toEqual([true, true]);
    expect(t.L.effectiveRegistry().find((e) => e.id === 'custom').label).toBe('X');   // applyCustomTab told it
  });

  test('a strip built under another denied set is rebuilt, drilled-in state and active pill kept', () => {
    t.L.applyAccess({ denied: [] });
    t.L.elementsOf('moreManuals').more.click();
    expect(t.pills('tabMore')).toContain('themeCustomDiv');
    t.L.applyAccess({ denied: ['moreTheme'] });
    expect(t.pills('tabMore')).not.toContain('themeCustomDiv');
    expect(t.d.querySelectorAll('#tabMore > .feature-strip')).toHaveLength(1);
    expect(t.d.querySelector('#tabMore > .feature-strip .pill-button.active').dataset.target).toBe('manualsDiv');
  });
});

describe('exec(id) (for real)', () => {
  let t;
  beforeEach(() => { t = boot(); t.L.applyAccess({ isAdmin: false, denied: ['moreViews'], customTab: { src: '/c.html', title: 'C' } }); t.w.applyCustomTab({ src: '/c.html', title: 'C' }); t.w.openMainTab('tabHome'); });
  afterEach(() => t.close());

  test('before login it refuses', () => {
    const fresh = boot();
    expect(fresh.L.exec('cases')).toBe(false);
    expect(fresh.calls).toEqual([]);
    expect(fresh.errors.join('\n')).toMatch(/before login/);
    fresh.close();
  });

  test('cases: lands exactly where a click on the sidebar item lands, highlight included', () => {
    expect(t.L.exec('cases')).toBe(true);
    const got = [t.calls.slice(), t.w.currentMainTabId(), t.active()];
    const ref = boot(); ref.L.applyAccess({});
    ref.w.openMainTab('tabHome');
    ref.L.elementsOf('cases').sidebar.click();
    expect(got).toEqual([ref.calls.slice(), ref.w.currentMainTabId(), ref.active()]);
    expect(got[1]).toBe('tabCases');
    expect(got[2]).toEqual(['tabCases']);
    ref.close();
  });

  test('a More panel: tabMore drilled into it, lazy iframe promoted, its pill lit, More Features lit', () => {
    t.L.exec('moreAutomations');
    const panel = t.d.getElementById('automationsDiv');
    expect(t.w.currentMainTabId()).toBe('tabMore');
    expect(t.shown(panel)).toBe(true);
    expect(panel.querySelector('iframe').getAttribute('src')).toBe('/automationsDiv.html');
    expect(t.d.getElementById('tabMore').classList.contains('drill-active')).toBe(true);
    expect(t.d.querySelector('#tabMore > .feature-strip .pill-button.active').dataset.target).toBe('automationsDiv');
    expect(t.active()).toEqual(['tabMore']);
  });

  test('a panel already open is not toggled shut — arriving from another tab, or from tabMore itself', () => {
    t.L.exec('moreAutomations');
    t.L.exec('cases');
    t.L.exec('moreAutomations');                           // drill-in kept by openMainTab: already up
    expect(t.shown(t.d.getElementById('automationsDiv'))).toBe(true);
    t.L.exec('moreAutomations');                           // on tabMore: openMainTab backs out, click reopens
    expect(t.shown(t.d.getElementById('automationsDiv'))).toBe(true);
    t.L.exec('moreReports');                               // switching panels within the group
    expect([t.shown(t.d.getElementById('automationsDiv')), t.shown(t.d.getElementById('reportsDiv'))]).toEqual([false, true]);
  });

  test('dialogs (New Client, Help & Support) open without stealing the highlight', () => {
    t.L.exec('contacts');
    t.L.exec('newClient');
    t.L.exec('helpSupport');
    expect(t.calls.slice(-2)).toEqual(['newContact', 'reportIssue']);
    expect(t.active()).toEqual(['tabContacts']);
    expect(t.w.currentMainTabId()).toBe('tabContacts');
  });

  test('grid actions and the custom tab click their real element', () => {
    t.L.exec('moreSettings');
    expect([t.w.currentMainTabId(), t.active()]).toEqual(['tabSettings', ['tabMore']]);
    t.L.applyAccess({ isAdmin: true });            // the one dialog tile left on a grid is Admin's
    t.L.exec('adminEtch');
    expect(t.calls).toContain('etchSwal');
    t.L.exec('custom');
    expect(t.w.currentMainTabId()).toBe('tabCustom');
  });

  test('refuses denied and admin-gated ids, and unknown ones — and does nothing', () => {
    const before = [t.w.currentMainTabId(), t.calls.length];
    for (const id of ['moreViews', 'adminDbConsole', 'nope']) expect(t.L.exec(id)).toBe(false);
    expect([t.w.currentMainTabId(), t.calls.length]).toEqual(before);
    expect(t.shown(t.d.getElementById('viewsDiv'))).toBe(false);
    // the Admin page: refused when the firm's visible_to leaves this user out (S6c)
    t.L.applyAccess({ roles: ['staff'], ui: { firm: { registry_overrides: { visible_to: { admin: ['it', 'admin'] } } } } });
    expect(t.L.exec('admin')).toBe(false);
    expect([t.w.currentMainTabId(), t.calls.length]).toEqual(before);
    t.L.applyAccess({ isAdmin: true, roles: ['su'], ui: null });
    expect(t.L.exec('adminDbConsole')).toBe(true);
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('dbConsoleDiv'))]).toEqual(['tabAdmin', true]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the All tab (public/js/ycAll.js, for real)', () => {
  let t;
  beforeEach(() => { t = boot({ withAll: true }); });
  afterEach(() => t.close());
  const entries = () => [...t.d.querySelectorAll('#ycAllList .yc-all-item')].map((b) => b.dataset.ycItem);
  const groups = () => [...t.d.querySelectorAll('#ycAllList .yc-all-group > h2')].map((h) => h.textContent);

  test('empty before login; then every effective item once, grouped, in order; Admin only for admins', () => {
    expect(entries()).toEqual([]);
    t.L.applyAccess({ isAdmin: false, denied: ['moreAutomations'], customTab: null });
    // Admin holds what this user can use: Etch is open to staff (S6c gates), the su tools are not
    expect(groups()).toEqual(['Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);
    expect(t.L.effectiveRegistry().filter((e) => e.group === 'Admin').map((e) => e.id)).toEqual(['adminEtch']);
    // every effective item but All itself (S6c ruling: the All tab doesn't list All; Ctrl-K does)
    expect(t.L.effectiveRegistry().map((e) => e.id)).toContain('all');
    expect(entries()).toEqual(t.L.effectiveRegistry().map((e) => e.id).filter((id) => id !== 'all'));
    expect(entries()).not.toContain('moreAutomations');
    t.L.applyAccess({ isAdmin: true });
    expect(groups()).toEqual(['Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);
    expect(new Set(entries()).size).toBe(entries().length);
  });

  test('no drill attributes anywhere in the All tab (the drill machinery queries them page-wide)', () => {
    t.L.applyAccess({ isAdmin: true });
    expect(t.d.querySelectorAll('#tabAll [data-target], #tabAll [data-exclusive-group]')).toHaveLength(0);
  });

  test('an entry runs exec(): a click opens the real panel', () => {
    t.L.applyAccess({});
    t.d.querySelector('#ycAllList [data-yc-item="moreDocuments"]').click();
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('documentsDiv'))]).toEqual(['tabMore', true]);
  });

  test('search ranks with the palette matcher; Enter runs the top hit; Esc clears', () => {
    t.L.applyAccess({});
    const s = t.d.getElementById('ycAllSearch');
    s.value = 'fb';
    s.dispatchEvent(new t.w.Event('input'));
    expect(entries()).toEqual(t.L.rank('fb', t.L.effectiveRegistry()).map((e) => e.id));
    expect(entries()[0]).toBe('moreFormBuilder');
    s.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(t.shown(t.d.getElementById('formBuilderDiv'))).toBe(true);
    s.value = 'zzzz'; s.dispatchEvent(new t.w.Event('input'));
    expect(t.d.querySelector('#ycAllList .yc-all-empty').textContent).toMatch(/zzzz/);
    s.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect([s.value, groups().length > 0]).toEqual(['', true]);
  });
});

describe('the palette (public/js/ycAll.js, for real)', () => {
  let t;
  beforeEach(() => { t = boot({ withAll: true }); });
  afterEach(() => t.close());
  const key = (el, init) => {
    const e = new t.w.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
    el.dispatchEvent(e);
    return e;
  };
  const pal = () => t.d.getElementById('ycPalette');
  const open = () => !!pal() && !pal().hidden;
  const items = () => [...t.d.querySelectorAll('#ycPalette .yc-pal-item span:first-of-type')].map((s) => s.textContent);

  test('never before login: Ctrl-K is left to the browser', () => {
    const ta = t.d.getElementById('elsewhere'); ta.focus();
    const e = key(ta, { key: 'k', ctrlKey: true });
    expect([e.defaultPrevented, open(), pal()]).toEqual([false, false, null]);
  });

  test('Ctrl-K from a focused input opens it; type, arrows, Enter runs; ⌘-K too', () => {
    t.L.applyAccess({});
    const ta = t.d.getElementById('elsewhere'); ta.focus();
    const e = key(ta, { key: 'k', ctrlKey: true });
    expect([e.defaultPrevented, open()]).toEqual([true, true]);
    const input = t.d.querySelector('#ycPalette .yc-pal-input');
    expect(t.d.activeElement).toBe(input);
    expect(items()).toEqual(t.L.effectiveRegistry().map((x) => x.label));   // blank = everything, All order
    input.value = 'con'; input.dispatchEvent(new t.w.Event('input'));
    expect(items()[0]).toBe('Contacts');
    expect(items().length).toBeGreaterThan(1);
    key(input, { key: 'ArrowDown' });
    expect(t.d.querySelector('#ycPalette .yc-pal-item.active span').textContent).toBe(items()[1]);
    key(input, { key: 'ArrowUp' });
    key(input, { key: 'Enter' });
    expect([open(), t.w.currentMainTabId(), t.calls]).toEqual([false, 'tabContacts', ['openContactsTab']]);
    key(t.d.body, { key: 'k', metaKey: true });
    expect(open()).toBe(true);
  });

  test('Esc closes and gives focus back; a click outside closes; Ctrl-K again toggles it shut', () => {
    t.L.applyAccess({});
    const ta = t.d.getElementById('elsewhere'); ta.focus();
    key(ta, { key: 'k', ctrlKey: true });
    key(t.d.querySelector('#ycPalette .yc-pal-input'), { key: 'Escape' });
    expect([open(), t.d.activeElement]).toEqual([false, ta]);
    key(ta, { key: 'k', ctrlKey: true });
    pal().dispatchEvent(new t.w.MouseEvent('mousedown', { bubbles: true }));
    expect(open()).toBe(false);
    key(ta, { key: 'k', ctrlKey: true });
    key(t.d.querySelector('#ycPalette .yc-pal-input'), { key: 'k', ctrlKey: true });
    expect([open(), t.d.activeElement]).toEqual([false, ta]);
  });

  test('stands down while a SweetAlert is open; a non-admin finds no admin tile', () => {
    t.L.applyAccess({ isAdmin: false });
    t.w.Swal = { isVisible: () => true };
    const e = key(t.d.body, { key: 'k', ctrlKey: true });
    expect([e.defaultPrevented, open()]).toEqual([false, false]);
    t.w.Swal.isVisible = () => false;
    key(t.d.body, { key: 'k', ctrlKey: true });
    const input = t.d.querySelector('#ycPalette .yc-pal-input');
    input.value = 'DB Console'; input.dispatchEvent(new t.w.Event('input'));
    expect([items(), t.d.querySelector('#ycPalette .yc-pal-empty').textContent]).toEqual([[], 'No match']);
    key(input, { key: 'Enter' });                          // nothing to run: stays open, nothing called
    expect([open(), t.calls]).toEqual([true, []]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the palette and other key owners (review fixes)', () => {
  let t;
  beforeEach(() => { t = boot({ withAll: true }); t.L.applyAccess({}); });
  afterEach(() => t.close());
  const key = (el, init) => {
    const e = new t.w.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
    el.dispatchEvent(e);
    return e;
  };
  const open = () => !!t.d.getElementById('ycPalette') && !t.d.getElementById('ycPalette').hidden;

  test('an editor that binds Ctrl-K itself (Quill insert-link) keeps it; a plain one opens the palette', () => {
    const ed = t.d.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    let seen = 0;
    ed.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'k') { seen++; e.preventDefault(); } });
    t.d.body.appendChild(ed);
    key(ed, { key: 'k', ctrlKey: true });
    expect([seen, open()]).toEqual([1, false]);
    const plain = t.d.createElement('div');
    plain.setAttribute('contenteditable', 'true');
    t.d.body.appendChild(plain);
    key(plain, { key: 'k', ctrlKey: true });
    expect(open()).toBe(true);
  });

  test('a toast is not a dialog: Ctrl-K opens over one; a modal still blocks', () => {
    const popup = t.d.createElement('div');
    t.w.Swal = { isVisible: () => true, getPopup: () => popup };
    popup.className = 'swal2-popup swal2-toast';
    const e = key(t.d.body, { key: 'k', ctrlKey: true });
    expect([e.defaultPrevented, open()]).toEqual([true, true]);
    key(t.d.querySelector('#ycPalette .yc-pal-input'), { key: 'Escape' });
    popup.className = 'swal2-popup swal2-modal';
    expect([key(t.d.body, { key: 'k', ctrlKey: true }).defaultPrevented, open()]).toEqual([false, false]);
  });

  test('inside a same-origin pane iframe: Ctrl-K opens it, Esc gives focus back inside; a top-window dialog blocks it', async () => {
    const f = t.d.createElement('iframe');
    t.d.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 50));            // its load event hooks the frame
    const fd = f.contentDocument;
    const inp = fd.createElement('input');
    fd.body.appendChild(inp);
    inp.focus();
    const e = new f.contentWindow.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    inp.dispatchEvent(e);
    expect([e.defaultPrevented, open()]).toEqual([true, true]);
    key(t.d.querySelector('#ycPalette .yc-pal-input'), { key: 'Escape' });
    expect([open(), fd.activeElement]).toEqual([false, inp]);
    const popup = t.d.createElement('div'); popup.className = 'swal2-popup';
    t.w.Swal = { isVisible: () => true, getPopup: () => popup };
    inp.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(open()).toBe(false);
  });
});

describe('the boot wiring (review fixes): loadFirmData + loadUserContext, extracted and run', () => {
  test('loadFirmData copies denied[] into firmData (and [] when absent or not an array)', async () => {
    const run = async (denied) => {
      const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
      const w = dom.window;
      w.apiSend = async () => ({ currentUser: { user: 1 }, denied });
      w.eval(FIRMDATA_INIT + LOAD_FIRMDATA + 'window.loadFirmData = loadFirmData;');
      const initial = w.firmData.denied;
      await w.loadFirmData();
      const out = [initial, w.firmData.denied];
      w.close();
      return JSON.parse(JSON.stringify(out));
    };
    expect(await run(['moreAutomations', 'cases'])).toEqual([[], ['moreAutomations', 'cases']]);
    expect(await run(undefined)).toEqual([[], []]);
    expect(await run('cases')).toEqual([[], []]);
  });

  const luc = async (roles, denied, ui = null) => {
    const t = boot();
    t.w.eval('var Toast = { fire() {} }; function startFirmClock() {}\n' + LUC_HEAD);
    t.w.eval(`var user = { user: 1, user_name: 'x', roles: ${JSON.stringify(roles)}, user_custom_tab: null };
      window.firmData = { denied: ${JSON.stringify(denied)}, ui: ${JSON.stringify(ui)} };`);
    await t.w.eval('loadUserContext()');
    return t;
  };

  test('non-SU: the effective registry has no su-gated item; denied items hidden on both surfaces; #sbAdmin follows the Admin item (S6c)', async () => {
    const ro = { visible_to: { admin: ['it', 'admin'] } };   // the live firm's rule
    const t = await luc('admin,it', ['cases', 'moreAutomations'], { firm: { registry_overrides: ro } });
    const eff = t.L.effectiveRegistry().map((e) => e.id);
    expect(t.L.isReady()).toBe(true);
    expect(eff.filter((id) => GATED.has(id))).toEqual([]);
    expect(eff).not.toContain('cases');
    const c = t.L.elementsOf('cases');
    expect([t.shown(c.sidebar), t.shown(c.home), t.shown(t.L.elementsOf('moreAutomations').more)]).toEqual([false, false, false]);
    // it/admin: the Admin page is theirs (visible_to), with the one tile they can use
    expect(t.shown(t.d.getElementById('sbAdmin'))).toBe(true);
    expect(eff.filter((id) => id.startsWith('admin'))).toEqual(['admin', 'adminEtch']);
    t.close();
    // staff: the firm's visible_to leaves them out — no Admin row, no Admin page item
    const s = await luc('staff', [], { firm: { registry_overrides: ro } });
    expect(s.shown(s.d.getElementById('sbAdmin'))).toBe(false);
    expect(s.L.effectiveRegistry().map((e) => e.id)).not.toContain('admin');
    s.close();
  });

  test('SU: #sbAdmin shown and every Admin item effective', async () => {
    const t = await luc('it,su', []);
    expect(t.shown(t.d.getElementById('sbAdmin'))).toBe(true);
    expect(t.L.effectiveRegistry().filter((e) => e.group === 'Admin')).toHaveLength(placed('admin').length);
    t.close();
  });

  test('order inside loadUserContext: applyCustomTab, then applyAccess, then the ?open= restore', () => {
    const at = (needle) => { const i = LUC_FULL.indexOf(needle); expect([needle, i >= 0]).toEqual([needle, true]); return i; };
    const custom = at('applyCustomTab(user.user_custom_tab || null);');
    const access = at('const eff = ycLauncher.applyAccess({ isAdmin, denied: window.firmData.denied');
    const restore = at('else openMainTabOnBoot(openTab, openAt.rest);');
    expect(custom < access && access < restore).toBe(true);
  });
});

describe('placeholders (review fix)', () => {
  test('a placed placeholder square is not an effective item', () => {
    const reg = { a: { label: 'A', icon: 'x', target: 'aDiv', group: 'more' }, p: { label: 'P', icon: 'x', placeholder: true } };
    const lay = { sidebar: [], home: [], more: [{ item: 'a' }, { item: 'p' }], admin: [] };
    expect(L.computeEffective({}, reg, lay).map((e) => e.id)).toEqual(['a']);
  });
});
