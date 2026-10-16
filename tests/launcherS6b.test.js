// tests/launcherS6b.test.js
//
/**
 * ui-custom S6b — Home rows not capped at 3, Home pinned at the top of the
 * sidebar, All on Home as an icon-only button, and the launcher items in no
 * default layout (myTasks, logout, casey).
 *
 *   1. HOME ROWS (jsdom, the page's own CSS): the .home-grid is a wrapping,
 *      centred flex row with NO max-width, so rows end at the screen edge or
 *      at a break only. The real-Chrome measurement (more than three across
 *      when there is no break; the default layout still 3 / 3 / 3 / …) is
 *      tests/launcherS6b.browser.test.js.
 *   2. THE DEFAULT LAYOUT IS UNCHANGED: the page the S1 helper expands
 *      (tests/helpers/shellHtml.js) has the shipped Home tiles and breaks in
 *      order inside .home-grid, nothing else, and no surface draws an S6b item.
 *   3. #homeAll: icon-only, an accessible name and a title, in the Home icon
 *      row right under the grid, sharing the More egg row's CSS (one rule per
 *      look, not a copy), and a click on the RENDERED control opens All.
 *   4. THE STICKY HOME ENTRY: its CSS hooks (sticky, top 0, opaque, over the
 *      items, no overflow on the flex child, the hover / active tints layered
 *      and winning, the scroll-driven edge), not scoped away from skinny or
 *      the phone drawer.
 *   5. THE S6b ITEMS: in the effective registry (group More actions, after the
 *      sidebar sections, before More), denied / hidden / renamed / restricted
 *      like any item, offered by the layout editor and the shortcut picker;
 *      exec runs each through the CLOSED dispatch with no placement and when
 *      placed (a neutral shortcut, no loop), doing exactly what the fixed
 *      chrome does (header My Tasks / Log Out, More's paw — dispatched on the
 *      rendered controls); never an eval of the registry string.
 *
 * Mutation-checked (see the S6b worker report).
 *
 * Run:  npx jest tests/launcherS6b.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { rawShellHtml, expandedShellHtml, loadLauncher } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { launcher: VL, registry: REG, layouts: LAY } = loadLauncher(RAW);
const EXTRAS = ['myTasks', 'logout', 'casey'];

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS6b: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
// The page's own <style> blocks that carry the rules under test.
const STYLES = [...RAW.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const styleWith = (needle) => {
  const hits = STYLES.filter((s) => s.includes(needle));
  if (hits.length !== 1) throw new Error('launcherS6b: ' + hits.length + ' style blocks hold ' + needle);
  return hits[0];
};
const SHELL_CSS = styleWith('#tabHome .home-grid {');
const EGG_CSS = styleWith('.home-egg-row');
// Real markup, cut out of the page.
const NAV = slice('<nav id="appSidebar" style="display:none">', '</nav>') + '</nav>';
const HOME = slice('  <div id="tabHome" class="tab-main">', '    <!-- Quick search') + '</div>';
const PAW_ROW = RAW.match(/<div class="more-egg-row">[\s\S]*?<\/div>/)[0];
const HDR_TASKS = RAW.match(/<button class="hdr-btn" onclick="[^"]*" title="My Tasks">[\s\S]*?<\/button>/)[0];
const HDR_LOGOUT = RAW.match(/<button class="hdr-logout" onclick="[^"]*" title="Log Out">[\s\S]*?<\/button>/)[0];
const J = (x) => JSON.parse(JSON.stringify(x));
const ids = (list) => list.map((e) => e.id);

// ─────────────────────────────────────────────────────────────────────────
// A page with the real sidebar, Home and More egg markup, the page's CSS, its
// launcher and its openMainTab. Page functions the S6b items call are stubs
// that record their arguments.
function boot() {
  const tabs = new Set(['tabAll', 'tabMore', 'tabAdmin', 'tabCustom', 'tabSettings']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plain = [...tabs].filter((t) => !['tabMore', 'tabAdmin'].includes(t)).map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}
    <style>${SHELL_CSS}</style></head><body>
    <div id="hdr">${HDR_TASKS}${HDR_LOGOUT}</div>
    ${NAV}
    ${HOME}
    ${plain}
    <div id="tabMore" class="tab-main"><script>ycLauncher.mount('more')</script>${PAW_ROW}</div>
    <div id="tabAdmin" class="tab-main"><script>ycLauncher.mount('admin')</script></div>
    <style>${EGG_CSS}</style>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const calls = [];
  w.__calls = calls;
  w.eval('var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n' +
    'function openTasksTab(f) { __calls.push(["openTasksTab", JSON.parse(JSON.stringify(f))]); }\n' +
    'function confirmLogout() { __calls.push(["confirmLogout"]); }\n' +
    'function toggleMascot() { __calls.push(["toggleMascot"]); }\n' +
    'function toggleOpenFilesList() {}\nvar user = { user: 7 };\n' +
    CURRENT_SRC + TABS_SRC);
  // every other registry onclick (openCasesTab(), newContact(), …): a recording stub
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (m && typeof w[m[1]] !== 'function') w.eval(`function ${m[1]}() { __calls.push(["${m[1]}"]); }`);
  }
  const d = w.document;
  return { w, d, L: w.ycLauncher, calls, errors, close: () => w.close() };
}
const ACCESS = { isAdmin: true, denied: [], customTab: { src: '/c.html', title: 'C' } };
const ui = ({ layout, ro } = {}) => ({ firm: ro ? { registry_overrides: ro } : {}, user: layout ? { layout } : {} });

/** A CSSOM style rule of the page's sheets whose selector list is exactly sel. */
function rule(d, sel) {
  const out = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText != null && r.selectorText.split(',').map((s) => s.trim()).join(', ') === sel) out.push(r);
      else if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sh of d.styleSheets) walk(sh.cssRules);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
describe('1. Home rows are not capped at 3 (the CSS hooks)', () => {
  let t;
  beforeAll(() => { t = boot(); });
  afterAll(() => t.close());

  test('the grid is a wrapping, centred flex row with no max-width; a break is a full-width sentinel', () => {
    const grid = t.d.querySelector('#tabHome > .home-grid');
    const cs = t.w.getComputedStyle(grid);
    expect([cs.display, cs.flexWrap, cs.justifyContent]).toEqual(['flex', 'wrap', 'center']);
    expect(['', 'none']).toContain(cs.maxWidth);   // jsdom: '' when nothing sets it
    const [r] = rule(t.d, '#tabHome .home-grid');
    expect(r.style.getPropertyValue('max-width')).toBe('');
    expect(r.style.getPropertyValue('width')).toBe('');
    // no other rule narrows it either
    expect(SHELL_CSS.match(/\.home-grid[^{]*\{[^}]*\b(max-)?width\s*:/g)).toBe(null);
    const brk = t.d.querySelector('#tabHome .home-grid > .home-break');
    expect(t.w.getComputedStyle(brk).flexBasis || t.w.getComputedStyle(brk).flex).toMatch(/100%/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('2. the default layout is unchanged (the S1 expanded page)', () => {
  const doc = new JSDOM(expandedShellHtml()).window.document;   // parsed, no scripts run

  test('Home: the shipped tiles and breaks, in order, and nothing else inside .home-grid', () => {
    const kids = [...doc.querySelector('#tabHome > .home-grid').children];
    const want = LAY.home.map((e) => (e.break ? '|' : REG[e.item].surfaceLabels && REG[e.item].surfaceLabels.home ? REG[e.item].surfaceLabels.home : REG[e.item].label));
    expect(kids.map((k) => (k.classList.contains('home-break') ? '|' : k.textContent.trim()))).toEqual(want);
    expect(want).toEqual(['Cases', 'Contacts', 'Appointments', '|', 'Billing', 'Pipeline Board', 'Events', '|',
      'Tasks', 'New Client', 'Log', '|', 'Custom Tab', 'More Features', 'Comms']);
    expect(kids.every((k) => k.className === 'home-btn' || k.className === 'home-break')).toBe(true);
    const tpl = doc.createElement('template');
    tpl.innerHTML = VL.build('home');
    expect(doc.querySelector('#tabHome > .home-grid').innerHTML).toBe(tpl.innerHTML);
  });

  test('no surface draws an S6b item (they are in no default layout)', () => {
    for (const sf of ['home', 'sidebar', 'more', 'admin']) {
      const html = VL.build(sf);
      for (const id of EXTRAS) {
        expect([sf, id, LAY[sf].some((e) => e.item === id)]).toEqual([sf, id, false]);
        expect([sf, id, html.includes(REG[id].onclick)]).toEqual([sf, id, false]);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('3. #homeAll: an icon-only button in the Home icon row', () => {
  test('icon only, with an accessible name and a title, right under the grid, before the quick search', () => {
    const doc = new JSDOM(expandedShellHtml()).window.document;
    const b = doc.getElementById('homeAll');
    expect(doc.querySelectorAll('#homeAll')).toHaveLength(1);
    expect([b.tagName, b.type, b.className]).toEqual(['BUTTON', 'button', 'home-egg']);
    expect(b.textContent.trim()).toBe('');
    expect([b.getAttribute('aria-label'), b.getAttribute('title')]).toEqual(['All features', 'All features']);
    expect(b.children).toHaveLength(1);
    expect([b.firstElementChild.tagName, b.firstElementChild.className, b.firstElementChild.getAttribute('aria-hidden')])
      .toEqual(['I', 'fa-solid fa-table-cells', 'true']);
    const row = b.parentElement;
    expect([row.className, row.parentElement.id, row.children.length]).toEqual(['home-egg-row', 'tabHome', 1]);
    expect(row.previousElementSibling.className).toBe('home-grid');
    expect(row.nextElementSibling.className).toBe('home-search');
    expect(doc.querySelectorAll('#tabHome .home-btn#homeAll, #tabHome > .home-btn')).toHaveLength(0);
  });

  test('a click on the RENDERED button opens All; the sidebar All is unchanged chrome', () => {
    const t = boot();
    try {
      t.L.applyAccess(ACCESS);
      t.w.openMainTab('tabCases');
      t.d.getElementById('homeAll').click();
      expect(t.w.currentMainTabId()).toBe('tabAll');
      const sb = t.d.getElementById('sbAll');
      expect([sb.classList.contains('sb-item'), sb.dataset.tab, sb.getAttribute('onclick'), sb.title]).toEqual([true, 'tabAll', "openMainTab('tabAll')", 'All features']);
      expect(sb.classList.contains('active')).toBe(true);   // the sidebar's All is lit, as for any way into All
      // fixed chrome: no registry id, no launcher element
      for (const id of Object.keys(REG)) expect(Object.values(t.L.elementsOf(id))).not.toContain(t.d.getElementById('homeAll'));
    } finally { t.close(); }
  });

  test('one look with More\'s paw: the egg-row rules are SHARED selector lists, not a copy', () => {
    const t = boot();
    try {
      // the Home row and button ride on the More rules
      expect(rule(t.d, '.more-egg-row, .home-egg-row')).toHaveLength(1);
      expect(rule(t.d, '#tabMore .more-egg, #tabHome .home-egg')).toHaveLength(1);
      expect(rule(t.d, '#tabMore .more-egg:hover, #tabMore .more-egg:focus-visible, #tabHome .home-egg:hover, #tabHome .home-egg:focus-visible')).toHaveLength(1);
      // and nothing styles a Home one without its More twin in the same rule
      const lone = [];
      for (const sh of t.d.styleSheets) for (const r of sh.cssRules) {
        if (r.selectorText && /home-egg/.test(r.selectorText) && !/more-egg/.test(r.selectorText)) lone.push(r.selectorText);
      }
      expect(lone).toEqual([]);
      const paw = t.d.querySelector('#tabMore .more-egg'), all = t.d.getElementById('homeAll');
      const PROPS = ['opacity', 'font-size', 'color', 'padding-top', 'padding-left', 'border-top-width', 'cursor', 'background-color'];
      const look = (el) => PROPS.map((p) => t.w.getComputedStyle(el).getPropertyValue(p));
      expect(look(all)).toEqual(look(paw));
      expect(t.w.getComputedStyle(all).opacity).toBe('0.45');
      const rowLook = (el) => ['text-align', 'margin-top', 'margin-bottom'].map((p) => t.w.getComputedStyle(el).getPropertyValue(p));
      expect(rowLook(all.parentElement)).toEqual(rowLook(paw.parentElement));
      // the paw itself is exactly as it was
      expect(PAW_ROW).toBe('<div class="more-egg-row"><button type="button" class="more-egg" onclick="toggleMascot()" title="Casey the YisraCat" aria-label="Casey the YisraCat"><i class="fa-solid fa-paw" aria-hidden="true"></i></button></div>');
    } finally { t.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('4. the sticky Home entry (CSS hooks)', () => {
  const HOME_SEL = '#appSidebar > .sb-item[data-tab="tabHome"]';
  let t;
  beforeAll(() => { t = boot(); });
  afterAll(() => t.close());

  test('the sidebar Home entry is the first item, pinned: sticky, top 0, above the items, opaque', () => {
    const home = t.d.querySelector('#appSidebar > .sb-item');
    expect(home.dataset.tab).toBe('tabHome');
    expect(home).toBe(t.d.querySelector(HOME_SEL));
    const cs = t.w.getComputedStyle(home);
    expect([cs.position, cs.top, cs.zIndex]).toEqual(['sticky', '0px', '1']);
    const [r] = rule(t.d, HOME_SEL);
    expect(r.style.getPropertyValue('background-color')).toBe('var(--sidebar-bg)');
    // the flex-column pitfall: no overflow on this direct child of #appSidebar
    expect(r.style.getPropertyValue('overflow') + r.style.getPropertyValue('overflow-y')).toBe('');
    for (const h of rule(t.d, HOME_SEL + ':not(.active):hover')) expect(h.style.getPropertyValue('overflow')).toBe('');
  });

  test('hover and active tints are a ::before layer over the opaque colour (no gradient: it dithers), and win', () => {
    const [layer] = rule(t.d, `${HOME_SEL}:hover::before, ${HOME_SEL}.active::before`);
    const p = (r, k) => r.style.getPropertyValue(k);
    expect(['content', 'position', 'z-index', 'pointer-events', 'background'].map((k) => p(layer, k)))
      .toEqual(["''", 'absolute', '-1', 'none', 'var(--hover)']);
    expect(layer.cssText).toMatch(/inset: 0;/);   // the padding box, under the content
    const [ac] = rule(t.d, `${HOME_SEL}.active::before`);
    expect(p(ac, 'background')).toBe('var(--accent-soft)');
    // hover (not active): the transparent left border showed the item's own tint
    const [bd] = rule(t.d, `${HOME_SEL}:not(.active):hover`);
    expect(p(bd, 'border-left-color')).toBe('var(--hover)');
    // order: the base rule ties #appSidebar .sb-item:hover / .active on specificity, so it comes after them;
    // the active layer after the shared one
    const at = (x) => SHELL_CSS.indexOf(x);
    expect(at(HOME_SEL + ' {')).toBeGreaterThan(at('#appSidebar .sb-item.active {'));
    expect(at(HOME_SEL + ' {')).toBeGreaterThan(at('#appSidebar .sb-item:hover {'));
    expect(at(HOME_SEL + '.active::before {')).toBeGreaterThan(at(HOME_SEL + ':hover::before,'));
    // no gradient anywhere on the Home entry (Chrome dithers it: the at-rest pixels changed)
    const block = SHELL_CSS.slice(at('/* Home stays at the top'), at('@keyframes sbHomeEdge'));
    expect(block).not.toMatch(/gradient\(/);
  });

  test('the edge: a scroll-driven fade on the sidebar\'s own scroll, only where scroll timelines exist', () => {
    expect(SHELL_CSS).toMatch(/@keyframes sbHomeEdge \{ from \{ box-shadow: 0 1px 0 transparent; \} to \{ box-shadow: 0 1px 0 var\(--border\); \} \}/);
    const sup = SHELL_CSS.slice(SHELL_CSS.indexOf('@supports (animation-timeline: scroll())'));
    const block = sup.slice(0, sup.indexOf('}\n    }') + 7);
    expect(block).toContain(HOME_SEL + ' {');
    expect(block).toMatch(/animation: sbHomeEdge auto linear both;\s*animation-timeline: scroll\(nearest block\);\s*animation-range: 0px 8px;/);
  });

  test('pinned in every sidebar mode: no media query, skinny or hidden class scopes the rule', () => {
    const at = SHELL_CSS.indexOf(HOME_SEL + ' {');
    const before = SHELL_CSS.slice(0, at);
    const opened = (before.match(/@media[^{]*\{/g) || []).length;
    // every @media block opened before the rule is closed again before it
    const depth = (src) => { let n = 0; for (const ch of src) { if (ch === '{') n++; else if (ch === '}') n--; } return n; };
    expect(depth(before)).toBe(0);
    expect(opened).toBeGreaterThan(0);   // (there are earlier media blocks — the check means something)
    for (const r of rule(t.d, HOME_SEL)) expect(r.parentRule == null || r.parentRule.constructor.name !== 'CSSMediaRule').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('5. the S6b items: myTasks, logout, casey', () => {
  test('in the registry with the spec\'s labels and icons; their onclick is the fixed chrome\'s, verbatim', () => {
    expect(EXTRAS.map((id) => [id, REG[id].label, REG[id].icon])).toEqual([
      ['myTasks', 'My Tasks', 'list'], ['logout', 'Log out', 'right-from-bracket'], ['casey', 'Casey', 'paw']]);
    expect(REG.myTasks.onclick).toBe(HDR_TASKS.match(/onclick="([^"]*)"/)[1]);
    expect(REG.logout.onclick).toBe(HDR_LOGOUT.match(/onclick="([^"]*)"/)[1]);
    expect(REG.casey.onclick).toBe(PAW_ROW.match(/onclick="([^"]*)"/)[1]);
    for (const id of EXTRAS) expect([id, REG[id].tab, REG[id].target, REG[id].group]).toEqual([id, undefined, undefined, undefined]);
  });

  test('the effective registry: group More actions, after the sidebar sections, before More, in registry order', () => {
    const eff = VL.computeEffective(ACCESS);
    expect(eff.groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);
    expect(ids(eff.filter((e) => e.group === 'More actions'))).toEqual(EXTRAS);
    const nonAdmin = VL.computeEffective({ isAdmin: false });
    expect(ids(nonAdmin.filter((e) => e.group === 'More actions'))).toEqual(EXTRAS);   // not admin-gated
    const e = eff.find((x) => x.id === 'logout');
    expect(J(e)).toEqual({ id: 'logout', group: 'More actions', label: 'Log out', labels: ['Log out'], icon: 'right-from-bracket' });
    // ordered: More actions entries sit between Settings' and More's
    const g = eff.map((x) => x.group);
    expect(g.lastIndexOf('Settings') < g.indexOf('More actions') && g.lastIndexOf('More actions') < g.indexOf('More')).toBe(true);
  });

  test('denied / firm-hidden / renamed / role-restricted like any registry item', () => {
    const eff = (o) => VL.computeEffective({ ...ACCESS, ...o });
    expect(ids(eff({ denied: ['logout'] }))).not.toContain('logout');
    expect(ids(eff({ ui: ui({ ro: { hidden: ['casey'] } }) }))).not.toContain('casey');
    expect(eff({ ui: ui({ ro: { renames: { myTasks: { label: 'Mine to do' } } } }) }).find((x) => x.id === 'myTasks').label).toBe('Mine to do');
    expect(ids(eff({ roles: ['staff'], isAdmin: false, ui: ui({ ro: { visible_to: { casey: ['attorney'] } } }) }))).not.toContain('casey');
    expect(ids(eff({ roles: ['attorney'], isAdmin: false, ui: ui({ ro: { visible_to: { casey: ['attorney'] } } }) }))).toContain('casey');
    // all three gone: the group has no entries (All draws no heading for it)
    const none = eff({ denied: EXTRAS });
    expect(none.filter((x) => x.group === 'More actions')).toEqual([]);
  });

  test('the layout editor offers them as shortcuts; the shortcut picker lists them; both as More actions', () => {
    const ctx = vm.createContext({ URL, console: { error: (m) => { throw new Error(String(m)); }, warn() {} } });
    ctx.window = ctx;
    vm.runInContext(ICON_SRC, ctx);
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    vm.runInContext(EDITOR_SRC, ctx);
    const L = ctx.window.ycLauncher, E = ctx.window.ycLayoutEditor;
    const list = L.computeEffective(ACCESS);
    const eff = J(list), groups = J(list.groups);
    const s = E.session({ stored: null, effective: eff, locked: [], base: J(ctx.window.DEFAULT_LAYOUTS), registry: ctx.window.FEATURE_REGISTRY, groups });
    for (const sf of ['home', 'sidebar']) {
      const g = J(s.candidates(sf)).find((x) => x.group === 'More actions');
      expect([sf, g && g.items.map((i) => i.id)]).toEqual([sf, EXTRAS]);
    }
    expect(s.add('home', 'logout')).toBe(true);
    const row = J(s.view('home')).find((r) => r.id === 'logout');
    expect(row && row.kind).toBe('item');
    const sc = E.shortcutSession({ stored: null, effective: eff, registry: ctx.window.FEATURE_REGISTRY, groups, keys: {}, mac: true });
    expect(J(sc.candidates('')).find((x) => x.group === 'More actions').items.map((i) => i.id)).toEqual(EXTRAS);
  });

  describe('exec', () => {
    let t;
    beforeEach(() => { t = boot(); });
    afterEach(() => t.close());

    test('with NO placement: no element, and exec runs each through the closed dispatch', () => {
      t.L.applyAccess(ACCESS);
      for (const id of EXTRAS) expect([id, J(t.L.elementsOf(id))]).toEqual([id, {}]);
      expect(t.d.querySelectorAll('[data-yc-shortcut]')).toHaveLength(0);
      expect(t.L.exec('myTasks')).toBe(true);
      expect(t.L.exec('logout')).toBe(true);
      expect(t.L.exec('casey')).toBe(true);
      expect(t.calls).toEqual([
        ['openTasksTab', { assigned_to: 7, status: 'Incomplete', defer: 'active' }], ['confirmLogout'], ['toggleMascot']]);
      expect(t.errors).toEqual([]);
    });

    test('exactly what the fixed chrome does: the header\'s My Tasks / Log Out and More\'s paw, clicked as rendered', () => {
      t.L.applyAccess(ACCESS);
      t.d.querySelector('#hdr [title="My Tasks"]').click();
      t.d.querySelector('#hdr [title="Log Out"]').click();
      t.d.querySelector('#tabMore .more-egg').click();
      const chrome = t.calls.splice(0);
      EXTRAS.forEach((id) => t.L.exec(id));
      expect(t.calls).toEqual(chrome);
      expect(chrome).toHaveLength(3);
    });

    test('PLACED: a neutral shortcut on Home and the sidebar runs the same dispatch once (no loop), and closes the phone drawer', () => {
      const layout = { placed: { home: [...LAY.home, { item: 'logout' }], sidebar: [{ item: 'casey' }, { item: 'myTasks' }] } };
      t.L.applyAccess({ ...ACCESS, ui: ui({ layout }) });
      const tile = t.d.querySelector('#tabHome .home-grid > .home-btn[data-yc-shortcut="logout"]');
      expect(tile).not.toBe(null);
      expect([tile.firstElementChild.className, tile.textContent.trim(), tile.id]).toEqual(['fa-solid fa-right-from-bracket fa-2xl', 'Log out', '']);
      const row = t.d.querySelector('#appSidebar > .sb-item[data-yc-shortcut="casey"]');
      expect([row.firstElementChild.className, row.textContent.trim(), row.getAttribute('title'), row.hasAttribute('data-tab')])
        .toEqual(['fa-solid fa-paw', 'Casey', 'Casey', false]);
      // still no launcher element: a neutral is never in elementsOf
      expect(J(t.L.elementsOf('logout'))).toEqual({});
      tile.click();
      t.d.body.classList.add('sidebar-mobile-open');
      row.click();
      t.d.querySelector('#appSidebar > .sb-item[data-yc-shortcut="myTasks"]').click();
      expect(t.calls).toEqual([['confirmLogout'], ['toggleMascot'], ['openTasksTab', { assigned_to: 7, status: 'Incomplete', defer: 'active' }]]);
      expect(t.d.body.classList.contains('sidebar-mobile-open')).toBe(false);
      // and exec of a placed one is the same single call
      t.calls.length = 0;
      expect(t.L.exec('logout')).toBe(true);
      expect(t.calls).toEqual([['confirmLogout']]);
      expect(t.errors).toEqual([]);
    });

    test('refused when not effective; a missing page function is a loud false, never a throw', () => {
      t.L.applyAccess({ ...ACCESS, denied: ['casey'] });
      expect(t.L.exec('casey')).toBe(false);
      expect(t.calls).toEqual([]);
      expect(t.errors.join('\n')).toMatch(/exec\("casey"\): not in this user's launcher/);
      t.errors.length = 0;
      t.w.confirmLogout = undefined;
      expect(t.L.exec('logout')).toBe(false);
      expect(t.errors.join('\n')).toMatch(/confirmLogout\(\) is not on this page/);
      // an unknown id still refuses
      expect(t.L.exec('nope')).toBe(false);
    });

    test('the dispatch is closed: exactly the three ids, named functions, no eval of the registry string', () => {
      const src = RENDERER_SRC.slice(RENDERER_SRC.indexOf('var NO_ELEMENT = {'), RENDERER_SRC.indexOf('function exec(id, opts) {'));
      expect(src.length).toBeGreaterThan(100);
      expect([...src.matchAll(/^ {8}(\w+): function/gm)].map((m) => m[1])).toEqual(EXTRAS);
      expect(src).not.toMatch(/\beval\b|new Function|\.onclick|setTimeout\(\s*['"`]/);
      expect(src).toMatch(/pageCall\('openTasksTab'/);
      expect(src).toMatch(/pageCall\('confirmLogout'/);
      expect(src).toMatch(/pageCall\('toggleMascot'/);
      // a registry item with an onclick of its own but no element is not run from it
      t.w.eval('FEATURE_REGISTRY.qaOrphan = { label: "QA", icon: "bug", onclick: "__calls.push([\\"orphan\\"])" };');
      t.L.applyAccess(ACCESS);
      expect(t.L.effectiveRegistry().some((e) => e.id === 'qaOrphan')).toBe(true);
      expect(t.L.exec('qaOrphan')).toBe(false);
      expect(t.calls).toEqual([]);
      expect(t.errors.join('\n')).toMatch(/exec\("qaOrphan"\): no rendered element/);
    });

    test('All and the palette list them; a search finds them', () => {
      t.L.applyAccess(ACCESS);
      const eff = t.L.effectiveRegistry();
      expect(t.L.groups()).toContain('More actions');
      expect(t.L.rank('log out', eff)[0].id).toBe('logout');
      expect(t.L.rank('casey', eff)[0].id).toBe('casey');
      expect(t.L.rank('my tasks', eff)[0].id).toBe('myTasks');
    });
  });
});
