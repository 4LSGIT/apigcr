// tests/launcherS34.test.js
//
/**
 * ui-custom S3.4 — role scoping in the shell's launcher (public/index.html
 * ycLauncher): the firm's visible_to { id: [role…] } hides an item unless the
 * user holds one of its roles or is su.
 *   1. computeEffective (pure, a bare vm + URL): a single-role and a
 *      multi-role user; su sees everything ([] lists included); a role nobody
 *      listed (a new one) sees nothing restricted, and nor does a user with no
 *      roles; registry and firm items alike; the undeniables can't be
 *      restricted and a malformed entry is ignored; composition with per-user
 *      denies, firm hides and renames; purity (inputs untouched, no state).
 *   2. applyAccess on a real-mount page (jsdom): every surface follows — the
 *      hide pass on Home / sidebar / grids, the More firm row, the effective
 *      registry (All + the palette's rank + the S4b picker read it), exec's
 *      refusal — and a restricted item stays hidden although the user PINNED
 *      it in their S4a layout; roles keep their last value like the other
 *      fields, and a role change re-shows (reversible).
 *   3. The boot wiring: loadUserContext hands the user's users.roles to
 *      applyAccess (extracted and run).
 *
 * Mutation-checked (see the S3.4 worker report).
 *
 * Run:  npx jest tests/launcherS34.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { rawShellHtml } = require('./helpers/shellHtml');
// More Features and Admin: the firm's pages since launcher-nits C4 (tests/helpers/hubPages.js)
const { hubFirm, hubPages, stageHtml, HISTORIC_LAYOUTS } = require('./helpers/hubPages');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS34: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const LUC_HEAD = slice('    async function loadUserContext() {', '      tasksBadgeRefresh();') + '\n    }\n';

function vmLauncher() {
  const warnings = [];
  const ctx = vm.createContext({ console: { error: (m) => warnings.push(String(m)), warn: (m) => warnings.push(String(m)) }, URL });
  ctx.window = ctx;
  vm.runInContext(ICON_SRC, ctx);
  vm.runInContext(REGISTRY_SRC, ctx);
  vm.runInContext(RENDERER_SRC, ctx);
  vm.runInContext(EDITOR_SRC, ctx);    // ui-custom S4b's editor: no document → it hands out its pure core
  return { L: ctx.window.ycLauncher, E: ctx.window.ycLayoutEditor, REG: ctx.window.FEATURE_REGISTRY, LAY: ctx.window.DEFAULT_LAYOUTS, warnings };
}
const { L: VL, E: VE, REG, LAY } = vmLauncher();
const placed = (sf) => (LAY[sf] || HISTORIC_LAYOUTS[sf]).filter((e) => e.item).map((e) => e.item);

const PAY = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const TOOL = { id: 'firm:clio', label: 'Clio Code', icon: 'copyright', action: { type: 'tool', key: 'clio-code', present: 'modal' } };
// the firm's documents: ro, plus More Features and Admin as the firm's pages (launcher-nits C4), the
// firm items placed at the end of More Features (no firm row since C4: a firm item shows where the firm puts it)
const MORE = hubPages()['firm:more'];
const FIRM_LAYOUT = { pages: { 'firm:more': { tiles: [...MORE.tiles, { item: PAY.id }, { item: TOOL.id }], icons: MORE.icons } } };
const ui = (ro, layout) => ({
  firm: hubFirm({ items: ro.items || [], ro, layout: FIRM_LAYOUT, visibleTo: { 'firm:admin': ['it', 'admin'], ...(ro.visible_to || {}) } }),
  user: layout ? { layout } : {},
});
// The arc's QA case: Automations for Admin + Attorney; Payroll only for su;
// Tasks (a sidebar + Home default) for staff.
const VT = { moreAutomations: ['admin', 'attorney'], 'firm:payroll': [], tasks: ['staff'] };
const RO = { hidden: [], locked: [], renames: {}, items: [PAY, TOOL], visible_to: VT };
const ids = (list) => list.map((e) => e.id);
const sees = (roles, o = {}) => ids(VL.computeEffective({ isAdmin: false, denied: [], ui: ui(RO), roles, ...o }));

// ─────────────────────────────────────────────────────────────────────────
describe('computeEffective with roles (pure)', () => {
  test('a staff-only user: no Automations, no su-only Payroll; Tasks (staff) and the unrestricted firm item stay', () => {
    const e = sees(['staff']);
    expect(e).not.toContain('moreAutomations');
    expect(e).not.toContain('firm:payroll');
    expect(e).toContain('tasks');
    expect(e).toContain('firm:clio');
  });

  test('single roles: admin sees Automations; attorney sees it; neither sees staff-only Tasks', () => {
    for (const r of ['admin', 'attorney']) {
      expect(sees([r])).toContain('moreAutomations');
      expect(sees([r])).not.toContain('tasks');
    }
  });

  test('a multi-role user sees what ANY of their roles sees', () => {
    const e = sees(['admin', 'staff']);
    expect(e).toContain('moreAutomations');
    expect(e).toContain('tasks');
    expect(e).not.toContain('firm:payroll');
  });

  test('su sees everything — [] (only-su) lists included — exactly as with no restrictions', () => {
    const e = sees(['su']);
    expect(e).toEqual(ids(VL.computeEffective({ isAdmin: false, denied: [], ui: ui({ ...RO, visible_to: undefined }), roles: ['su'] })));
    expect(e).toEqual(expect.arrayContaining(['moreAutomations', 'firm:payroll', 'tasks']));
    expect(sees(['it', 'admin', 'form_dev', 'su'])).toEqual(e);              // Fred's roles: su wins
  });

  test('a role nobody listed (a new role) sees nothing restricted; nor does a user with no roles', () => {
    for (const roles of [['paralegal'], [], undefined, 'admin,attorney', [null, 3]]) {
      const e = sees(roles);
      expect([roles, e.includes('moreAutomations'), e.includes('tasks'), e.includes('firm:payroll')]).toEqual([roles, false, false, false]);
    }
  });

  test('an unrestricted item is for everyone; the undeniables cannot be restricted; a malformed entry is ignored', () => {
    const e = ids(VL.computeEffective({ ui: ui({ visible_to: { moreSettings: [], helpSupport: [], bills: 'admin', cases: null } }), roles: ['staff'] }));
    expect(e).toEqual(expect.arrayContaining(['moreSettings', 'helpSupport', 'bills', 'cases', 'contacts']));
  });

  test('composition: a per-user deny still hides an allowed item; a firm hide beats su; a rename shows on an allowed item', () => {
    const o = { denied: ['moreAutomations'] };
    expect(sees(['admin'], o)).not.toContain('moreAutomations');
    expect(sees(['su'], o)).not.toContain('moreAutomations');               // denies hit su too (A5)
    const hid = ids(VL.computeEffective({ ui: ui({ ...RO, hidden: ['moreAutomations', 'firm:clio'] }), roles: ['su'] }));
    expect(hid).not.toContain('moreAutomations');
    expect(hid).not.toContain('firm:clio');
    const ren = VL.computeEffective({ ui: ui({ ...RO, renames: { moreAutomations: { label: 'Robots' } } }), roles: ['attorney'] });
    expect(ren.find((x) => x.id === 'moreAutomations').label).toBe('Robots');
    expect(ids(VL.computeEffective({ ui: ui({ ...RO, renames: { moreAutomations: { label: 'Robots' } } }), roles: ['staff'] }))).not.toContain('moreAutomations');
  });

  test('pure: frozen inputs untouched, the same answer twice, no launcher state written', () => {
    const deep = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deep(v)); return Object.freeze(o); };
    const opts = deep({ isAdmin: false, denied: ['bills'], ui: JSON.parse(JSON.stringify(ui(RO))), roles: ['admin'] });
    const before = JSON.stringify(opts);
    const g0 = VL.groups(), r0 = VL.effectiveRegistry();
    const a = VL.computeEffective(opts), b = VL.computeEffective(opts);
    expect(JSON.stringify(opts)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect([VL.groups(), VL.effectiveRegistry(), VL.isReady()]).toEqual([g0, r0, false]);
  });
});

// The S4b layout editor builds its "Add a shortcut" picker from the effective
// registry it is handed (ycLauncher.effectiveRegistry()), so a role-restricted
// item never reaches it.
describe('the S4b layout editor\'s picker (its pure core)', () => {
  const pick = (roles) => {
    const effective = VL.computeEffective({ isAdmin: false, denied: [], ui: ui(RO), roles });
    const s = VE.session({ stored: null, effective, base: LAY, registry: REG, groups: effective.groups, locked: [] });
    return ['home', 'sidebar'].map((sf) => s.candidates(sf).flatMap((g) => g.items.map((v) => v.id)));
  };
  test('staff-only: no Automations, no su-only firm item on either surface; admin sees Automations; su sees both', () => {
    for (const ids of pick(['staff'])) {
      expect(ids).not.toContain('moreAutomations');
      expect(ids).not.toContain('firm:payroll');
      expect(ids).toContain('firm:clio');
    }
    for (const ids of pick(['admin'])) expect(ids).toContain('moreAutomations');
    for (const ids of pick(['su'])) expect(ids).toEqual(expect.arrayContaining(['moreAutomations', 'firm:payroll']));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A page skeleton with the real mounts (Home inside its .home-grid), the
// panels and tab divs; the page's own drill-in and tab code.
function boot() {
  const tabs = new Set(['tabHome']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    <div id="tabAll" class="tab-main"></div>
    ${plainTabs}
    <div id="ycPages"></div>
    <div id="ycPanels" style="display:none">${stageHtml(REG)}</div>
    <b id="myNameIs"></b><div id="hdrUserArea"></div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const opened = [];
  w.__calls = [];
  w.open = (...a) => { opened.push(a); return null; };
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(w.FEATURE_REGISTRY)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  const d = w.document;
  const L = w.ycLauncher;
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const homeGrid = d.querySelector('#tabHome > .home-grid');
  // the shortcut a user layout pinned where the item has no default element
  const neutral = (sf, id) => (sf === 'home' ? homeGrid : d.getElementById('appSidebar')).querySelector(`[data-yc-shortcut="${id}"]`);
  // a tile on the firm's More Features page (registry items and firm items alike)
  const tile = (id) => d.querySelector(`#ycPages > [data-yc-page="firm:more"] > [data-yc-shortcut="${id}"]`);
  const firmTile = tile;
  return { w, d, L, opened, errors, shown, neutral, tile, firmTile, close: () => w.close() };
}

// Automations pinned to Home AND the sidebar (neutral shortcuts — it has no
// default element there); Payroll pinned to Home; Tasks (a default) moved first.
const PINS = {
  placed: {
    home: [{ item: 'tasks' }, { item: 'moreAutomations' }, { item: 'firm:payroll' }],
    sidebar: [{ item: 'tasks' }, { item: 'moreAutomations' }],
  },
};
const STATE = (roles, extra = {}) => ({ isAdmin: false, denied: [], ui: ui(RO, PINS), roles, ...extra });

describe('applyAccess with roles: every surface follows (real mounts)', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('staff-only: Automations gone from its grid tile, the pinned shortcuts, All / the palette, and exec refuses', () => {
    t.L.applyAccess(STATE(['staff']));
    expect(t.tile('moreTheme')).not.toBeNull();                             // (the page is there…)
    expect(t.tile('moreAutomations')).toBeNull();                           // …its tile is not: a page lays out only what the user may use
    expect(t.neutral('home', 'moreAutomations')).toBeNull();              // pinned, still hidden
    expect(t.neutral('sidebar', 'moreAutomations')).toBeNull();
    expect(ids(t.L.effectiveRegistry())).not.toContain('moreAutomations');
    expect(ids(t.L.rank('autom'))).toEqual([]);
    expect(t.L.exec('moreAutomations')).toBe(false);
    // su-only Payroll: no tile where the firm put it (More Features), no pinned Home shortcut, exec refuses (no window)
    expect(t.firmTile('firm:payroll')).toBeNull();
    expect(t.neutral('home', 'firm:payroll')).toBeNull();
    expect(t.L.exec('firm:payroll')).toBe(false);
    expect(t.opened).toEqual([]);
    // the allowed ones are there: staff's Tasks (default elements, shown), the open firm item's tile
    expect([t.shown(t.L.elementsOf('tasks').sidebar), t.shown(t.L.elementsOf('tasks').home)]).toEqual([true, true]);
    expect(t.firmTile('firm:clio')).not.toBeNull();
  });

  test('a restricted DEFAULT element the user pinned (moved first) stays hidden for a role that is not listed', () => {
    t.L.applyAccess(STATE(['admin']));
    const el = t.L.elementsOf('tasks');
    expect([el.home.hasAttribute('data-yc-denied'), t.shown(el.home), t.shown(el.sidebar)]).toEqual([true, false, false]);
    expect(t.neutral('home', 'tasks')).toBeNull();
  });

  test('admin + staff: Automations shows everywhere it is pinned or placed, and exec runs it', () => {
    t.L.applyAccess(STATE(['admin', 'staff']));
    expect(t.shown(t.tile('moreAutomations'))).toBe(true);
    expect(t.neutral('home', 'moreAutomations')).not.toBeNull();
    expect(t.neutral('sidebar', 'moreAutomations')).not.toBeNull();
    expect(ids(t.L.rank('autom'))).toEqual(['moreAutomations']);
    expect(t.L.exec('moreAutomations')).toBe(true);
    expect(t.neutral('home', 'firm:payroll')).toBeNull();
  });

  test('su: everything — the su-only firm item has its tile and its pinned shortcut, and opens', () => {
    t.L.applyAccess(STATE(['it', 'admin', 'form_dev', 'su']));
    for (const id of ['moreAutomations', 'tasks', 'firm:payroll', 'firm:clio']) expect(ids(t.L.effectiveRegistry())).toContain(id);
    expect(t.firmTile('firm:payroll')).not.toBeNull();
    expect(t.neutral('home', 'firm:payroll')).not.toBeNull();
    expect(t.L.exec('firm:payroll')).toBe(true);
    expect(t.opened[0][0]).toBe('https://payroll.example.com/');
    expect(t.d.querySelectorAll('[data-yc-denied]')).toHaveLength(0);
  });

  test('roles keep their last value (a partial applyAccess({ denied }) does not drop them); a role change re-shows', () => {
    t.L.applyAccess(STATE(['staff']));
    t.L.applyAccess({ denied: [] });
    expect(ids(t.L.effectiveRegistry())).not.toContain('moreAutomations');
    t.L.applyAccess({ roles: ['attorney'] });
    expect(t.shown(t.tile('moreAutomations'))).toBe(true);
    expect(t.tile('moreAutomations').hasAttribute('data-yc-denied')).toBe(false);
    expect(t.shown(t.L.elementsOf('tasks').sidebar)).toBe(false);
    t.L.applyAccess({ ui: ui({ ...RO, visible_to: undefined }, PINS) });  // restrictions removed → all back
    expect(t.d.querySelectorAll('[data-yc-denied]')).toHaveLength(0);
    expect(t.errors).toEqual([]);
  });
});

describe('boot wiring: loadUserContext hands users.roles to applyAccess (extracted and run)', () => {
  const run = async (roles) => {
    const t = boot();
    t.w.eval('var Toast = { fire() {} }; function startFirmClock() {}\n' + LUC_HEAD);
    t.w.eval(`var user = { user: 2, user_name: 'x', roles: ${JSON.stringify(roles)} };
      window.firmData = { denied: [], ui: ${JSON.stringify(ui(RO))} };`);
    await t.w.eval('loadUserContext()');
    const out = ids(t.L.effectiveRegistry());
    t.close();
    return out;
  };
  test('the SET string is split: "admin,staff" sees Automations and Tasks; "staff" sees Tasks only; su sees Payroll', async () => {
    const both = await run('admin,staff');
    expect([both.includes('moreAutomations'), both.includes('tasks'), both.includes('firm:payroll')]).toEqual([true, true, false]);
    const staff = await run('staff');
    expect([staff.includes('moreAutomations'), staff.includes('tasks')]).toEqual([false, true]);
    expect(await run('it,admin,form_dev,su')).toContain('firm:payroll');
    expect((await run('')).includes('tasks')).toBe(false);
  });
});
