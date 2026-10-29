// tests/launcherS6c.test.js
//
/**
 * ui-custom S6c-1+2 — icon rows, real Admin tile gates, and the firm default
 * layout (no visible change). S6c_DESIGN.md §4.2–§4.4, §4.7, §5 S6c-1 / S6c-2,
 * and Fred's rulings on §6. Since launcher-nits C4 the static More and Admin
 * hubs are gone: More Features and Admin are the firm's pages firm:more /
 * firm:admin (tests/helpers/hubPages.js builds them as production has them),
 * so what this file pinned on the hubs it now pins on those pages.
 *
 *   1. GATES: every Admin tile carries the gate its routes enforce (`gate:
 *      'su'` on the eleven superuserOnly tools, users.impersonate on Users,
 *      none on Etch — a static page),
 *      pinned as a set; the Admin PAGE (firm:admin) carries none (its
 *      visibility is the firm's visible_to). computeEffective applies a gate
 *      with the user's roles by lib/capabilities' rule — the shell's CAP_ROOT /
 *      ROLE_CAPS copies are pinned to the module, and the behaviour is checked
 *      on a synthetic registry (su, it, a role, a root capability, an unknown
 *      gate: closed); on the page a gated tile is not drawn.
 *   2. ICON ROWS: one mounted icon row (homeIcons) renders S6b's #homeAll
 *      markup BYTE FOR BYTE; More's paw is the More Features page's casey
 *      neutral; Admin's row is empty; casey and all are placed items (group
 *      More Features / Settings); exec(casey) runs in place (no tab switch);
 *      a firm-placed icon is a neutral `.page-egg` button that runs exec.
 *   3. ALL IS GUARANTEED in Home's icon row (ruling 3): a firm or user removal
 *      is ignored, a placed row without it gets it back; the sidebar's All is an
 *      ordinary item a user may remove, and exec(all) still works then.
 *   4. THE TWO-LEVEL RESOLVER: shipped → firm → user, one merge rule twice;
 *      a firm Home change only ADDS for a customized user (ruling 4); the
 *      firm's own step ignores `locked`; resolveLayout without `firm` is the
 *      S4a contract.
 *   5. THE RENDERER under a firm layout, for real (jsdom, the page's own
 *      mounts, drill-in, tabs): with no firm layout every mounted surface is
 *      the DOM byte for byte; a firm-removed Home tile stays in the DOM hidden
 *      by data-yc-unplaced, in its default place; the More Features page laid
 *      out by the firm (rows at its breaks, a firm item a neutral tile); a tile
 *      the firm takes off it is drawn nowhere, gets no pill and exec still opens
 *      its panel (the panel tab, C1); an Admin item on More opens in place
 *      there (S6c-4, the panel stage); no firm row anywhere; a user document
 *      naming the retired surfaces changes nothing; a FUZZ of random firm
 *      layouts never drops a mounted default element nor duplicates an id,
 *      and an empty firm layout restores the default DOM; a re-run changes
 *      nothing.
 *   6. THE USER EDITOR carries homeIcons through a save untouched.
 *
 * Mutation-checked (see local/ui-custom/S6c12_worker_report.md).
 *
 * Run:  npx jest tests/launcherS6c.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { rawShellHtml, expandedShellHtml, loadLauncher } = require('./helpers/shellHtml');
const CAPS_MOD = require('../lib/capabilities');
const { UNDENIABLE } = require('../services/entitlementService');
const shape = require('../lib/uiConfigShape');
const { hubFirm, hubPages, stageHtml, HUB_ADMIN, HISTORIC_LAYOUTS: HL } = require('./helpers/hubPages');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { launcher: VL, registry: REG, layouts: LAY } = loadLauncher(RAW);
const J = (x) => JSON.parse(JSON.stringify(x));
const ids = (list) => list.map((e) => e.id);
const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
// a hub page's tiles as production has them (the C3 data step's frozen copy of the pre-C4 lists)
const hubTiles = (pg) => hubPages()[pg].tiles.filter((e) => e.item).map((e) => e.item);

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS6c: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const STYLES = [...RAW.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const EGG_CSS = (() => { const h = STYLES.filter((s) => s.includes('.home-egg-row')); if (h.length !== 1) throw new Error('egg css'); return h[0]; })();

const HOME_ALL = '<div class="home-egg-row"><button type="button" id="homeAll" class="home-egg" onclick="openMainTab(\'tabAll\')" title="All features" aria-label="All features"><i class="fa-solid fa-table-cells" aria-hidden="true"></i></button></div>';
const SU_TILES = ['adminReadonlyKeys', 'adminApiKeys', 'adminCtaLinks', 'adminDbConsole', 'adminConnections', 'adminApiTester', 'adminTools',
  'adminScratch', 'adminSystemAlerts', 'adminSupportInbox', 'adminMailboxes'];
const CAP_TILES = ['adminUsers', 'adminSharedValues'];
const SURFACES = ['home', 'sidebar', 'homeIcons'];   // the mounted ones; More and Admin are pages (C4)
const FIRM_URL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const ui = ({ layout, firm, ro } = {}) => ({ firm: { ...(ro ? { registry_overrides: ro } : {}), ...(firm ? { layout: firm } : {}) }, user: layout ? { layout } : {} });
// the firm as production has it: its items + More Features and Admin as pages (Admin for it + admin); hubFirm's options
const hub = (o = {}, layout) => ({ firm: hubFirm(o), user: layout ? { layout } : {} });
const SU = { isAdmin: true, roles: ['su'], denied: [] };

// ─────────────────────────────────────────────────────────────────────────
describe('1. gates', () => {
  test('the Admin tiles: superuser tools use su, Users and Shared values use their capability, Etch and the Admin page (firm:admin) are open', () => {
    const gated = Object.keys(REG).filter((k) => REG[k].gate !== undefined);
    expect(gated.sort()).toEqual([...SU_TILES, ...CAP_TILES].sort());
    for (const k of SU_TILES) expect([k, REG[k].gate]).toEqual([k, 'su']);
    expect(REG.adminUsers.gate).toBe('users.impersonate');
    expect(REG.adminSharedValues.gate).toBe('firm.settings');   // visibility only: /api/shared is any staff
    expect(REG.adminEtch.gate).toBeUndefined();
    expect(REG.admin).toBeUndefined();                                                     // the hub item is gone (C4)
    expect(Object.keys(HUB_ADMIN).sort()).toEqual(['action', 'icon', 'id', 'label']);       // the page item: no gate (visible_to decides)
    // the classification covers every Admin page tile but Etch
    expect(hubTiles('firm:admin').filter((k) => k !== 'adminEtch').sort()).toEqual([...SU_TILES, ...CAP_TILES].sort());
  });

  test('the shell\'s CAP_ROOT / ROLE_CAPS are lib/capabilities, verbatim', () => {
    const grab = (name) => {
      const m = new RegExp(`var ${name} = (\\{[\\s\\S]*?\\});`).exec(RENDERER_SRC);
      if (!m) throw new Error(name + ' not found');
      return vm.runInNewContext('(' + m[1] + ')');
    };
    const root = Object.fromEntries(Object.entries(CAPS_MOD.CAPABILITIES).map(([k, v]) => [k, v.root]));
    expect(grab('CAP_ROOT')).toEqual(root);
    expect(grab('ROLE_CAPS')).toEqual(J(CAPS_MOD.ROLE_CAPS));
    // and the undeniable set
    expect(VL.UNDENIABLE).toEqual([...UNDENIABLE]);
  });

  test('a gate is applied with the roles by can()\'s rule: su everything, it every non-root capability, a role what it grants; unknown → hidden', () => {
    const reg = {
      open: { label: 'O', icon: 'x', onclick: 'o()' },
      suOnly: { label: 'S', icon: 'x', onclick: 's()', gate: 'su' },
      firmCap: { label: 'F', icon: 'x', onclick: 'f()', gate: 'firm.settings' },
      rootCap: { label: 'R', icon: 'x', onclick: 'r()', gate: 'users.manage' },
      bogus: { label: 'B', icon: 'x', onclick: 'b()', gate: 'nope.cap' },
    };
    const lay = { home: Object.keys(reg).map((k) => ({ item: k })), sidebar: [], more: [], admin: [] };
    const see = (roles, o = {}) => ids(VL.computeEffective({ isAdmin: false, roles, ...o }, reg, lay));
    expect(see(['staff'])).toEqual(['open']);
    expect(see(['admin'])).toEqual(['open', 'firmCap']);
    expect(see(['it'])).toEqual(['open', 'firmCap']);              // never a root capability
    expect(see(['su'])).toEqual(['open', 'suOnly', 'firmCap', 'rootCap']);   // the unknown gate stays closed even for su
    expect(see(['it', 'su'])).toEqual(['open', 'suOnly', 'firmCap', 'rootCap']);
    expect(see([], { isAdmin: true })).toEqual(['open', 'suOnly', 'firmCap', 'rootCap']);   // the su override (the Firm tab's catalog)
    expect(see(undefined)).toEqual(['open']);
    // lib/capabilities agrees on every (role, capability) pair the copies cover
    for (const role of CAPS_MOD.ROLE_MEMBERS) for (const cap of Object.keys(CAPS_MOD.CAPABILITIES)) {
      const r = { x: { label: 'X', icon: 'x', onclick: 'x()', gate: cap } };
      const got = ids(VL.computeEffective({ isAdmin: false, roles: [role] }, r, { home: [{ item: 'x' }], sidebar: [], more: [], admin: [] })).length === 1;
      expect([role, cap, got]).toEqual([role, cap, CAPS_MOD.can({ type: 'jwt', roles: [role] }, cap)]);
    }
  });

  test('for real: a non-su\'s su tiles are not drawn on the Admin page, Etch shows, the Admin row follows the page item; su sees all 14', () => {
    const t = boot();
    try {
      t.L.applyAccess({ isAdmin: false, roles: ['it'], denied: [], ui: hub() });
      const A = t.pageOf('firm:admin');
      const tiles = () => [...t.pageOf('firm:admin').querySelectorAll(':scope > .big-button')];
      expect(tiles().filter((b) => t.shown(b)).map((b) => b.textContent.trim())).toEqual(['Etch', 'Shared values', 'Users']);
      expect(tiles()).toHaveLength(3);                                                     // a gated tile is never drawn on a page
      for (const id of SU_TILES) expect([id, A.querySelector(`[data-yc-shortcut="${id}"]`)]).toEqual([id, null]);
      expect(t.d.querySelector('#appSidebar .sb-item[data-yc-shortcut="firm:admin"]')).not.toBe(null);   // the page item is theirs
      // drilled in, the strip has no su pill
      t.w.openMainTab(A.id);
      t.w.ensureStrip(A);
      expect([...A.querySelectorAll(':scope > .feature-strip .pill-button')].map((p) => p.textContent.trim())).toEqual(['All', 'Etch', 'Shared values', 'Users']);
      // staff with the live rule: the page and its row gone; su: every tile drawn, nothing hidden
      t.L.applyAccess({ roles: ['staff'] });
      expect([t.pageOf('firm:admin'), t.d.querySelector('#appSidebar .sb-item[data-yc-shortcut="firm:admin"]')]).toEqual([null, null]);
      t.L.applyAccess({ roles: ['su'] });
      expect(t.d.querySelectorAll('#ycPages [data-yc-denied], #appSidebar [data-yc-denied]')).toHaveLength(0);
      expect(tiles().filter((b) => t.shown(b)).map((b) => b.getAttribute('data-yc-shortcut'))).toEqual(hubTiles('firm:admin'));
      expect(tiles()).toHaveLength(14);
    } finally { t.close(); }
  });

  test('over the real registry: a non-su sees Etch and the Admin page (no visible_to), never a su tool; visible_to on `firm:admin` hides the page', () => {
    const staff = VL.computeEffective({ isAdmin: false, roles: ['staff'], ui: hub({ visibleTo: null }) });
    expect(ids(staff.filter((e) => e.group === 'Admin'))).toEqual(['adminEtch']);
    expect(ids(staff)).toContain('firm:admin');
    // the live firm's rule (hubFirm's default: it + admin)
    expect(ids(VL.computeEffective({ isAdmin: false, roles: ['staff'], ui: hub() }))).not.toContain('firm:admin');
    const it = VL.computeEffective({ isAdmin: false, roles: ['it'], ui: hub() });
    expect(ids(it)).toContain('firm:admin');
    expect(ids(it.filter((e) => e.group === 'Admin'))).toEqual(['adminEtch', 'adminSharedValues', 'adminUsers']);
    expect(ids(VL.computeEffective({ isAdmin: false, roles: ['su'], ui: hub() }).filter((e) => e.group === 'Admin'))).toEqual(hubTiles('firm:admin'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('2. icon rows: the surfaces and their markup', () => {
  test('the shipped icon row: all on Home; the hub pages (the C3 data step): casey on More Features, Admin empty; the hubs\' rows are no surface', () => {
    expect(Object.keys(LAY).sort()).toEqual(['home', 'homeIcons', 'sidebar']);
    expect(LAY.homeIcons).toEqual([{ item: 'all' }]);
    expect(hubPages()['firm:more'].icons).toEqual([{ item: 'casey' }]);
    expect(hubPages()['firm:admin'].icons).toEqual([]);
    expect(shape.ICON_SURFACES).toEqual(['homeIcons', 'moreIcons']);                        // 'moreIcons' = the grammar a page's small buttons borrow
  });

  test('the expanded page holds S6b\'s #homeAll markup byte for byte and no hub icon row; the sidebar All is the `all` item', () => {
    const html = expandedShellHtml();
    expect(html).toContain(HOME_ALL);
    expect(html).not.toMatch(/(more|admin)-egg/);                                         // the paw and Admin's row went with the hubs (C4)
    expect(() => VL.build('adminIcons')).toThrow(/unknown surface "adminIcons"/);
    expect(() => VL.build('moreIcons')).toThrow(/unknown surface "moreIcons"/);
    expect(html).toContain('<div class="sb-item" id="sbAll" data-tab="tabAll" onclick="openMainTab(\'tabAll\')" title="All features">\n      <i class="fa-solid fa-table-cells"></i><span>All</span>\n    </div>');
    expect((html.match(/id="sbAll"/g) || []).length).toBe(1);
    expect((html.match(/id="homeAll"/g) || []).length).toBe(1);
    // an empty icon row takes no space; a drilled-in page hides its row
    expect(EGG_CSS).toMatch(/\.home-egg-row:empty, \.page-egg-row:empty \{ display:none; \}/);
    expect(EGG_CSS).toMatch(/\.drill-active > \.page-egg-row \{ display:none; \}/);
  });

  test('an icon-row item: title (else the label) is also its aria-label; a renderer break or label there is skipped with a console error', () => {
    const reg = { a: { label: 'A thing', icon: 'star', onclick: 'a()' }, b: { label: 'B', title: 'Bee', icon: 'bug', onclick: 'b()', domIds: { homeIcons: 'bId' } } };
    const errors = [];
    const ctx = vm.createContext({ console: { error: (m) => errors.push(String(m)) } });
    ctx.window = ctx;
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    const html = ctx.window.ycLauncher.build('homeIcons', [{ item: 'a' }, { break: true }, { label: 'x' }, { item: 'b' }], reg);
    expect(html).toBe('<button type="button" class="home-egg" onclick="a()" title="A thing" aria-label="A thing"><i class="fa-solid fa-star" aria-hidden="true"></i></button>'
      + '<button type="button" id="bId" class="home-egg" onclick="b()" title="Bee" aria-label="Bee"><i class="fa-solid fa-bug" aria-hidden="true"></i></button>');
    expect(errors).toHaveLength(2);
  });

  test('the effective registry: casey is placed (group More Features, after its grid); all is placed (group Settings, the sidebar wins); the extras are myTasks, logout and code', () => {
    const eff = VL.computeEffective({ ...SU, ui: hub() });
    expect(ids(eff.filter((e) => e.group === 'More actions'))).toEqual(['myTasks', 'logout', 'code']);
    expect(ids(eff.filter((e) => e.group === 'More Features'))).toEqual([...hubTiles('firm:more'), 'casey']);
    expect(eff.find((e) => e.id === 'all').group).toBe('Settings');
    expect(eff.groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More actions', 'More Features', 'Admin', 'Firm']);
    // an item placed only in an icon row is placed by it: Admin's page → group Admin; the shipped Home row's → group Home (not an extra)
    const pages = hubPages();
    const lay = { ...J(LAY), homeIcons: [{ item: 'all' }, { item: 'logout' }] };
    const e2 = VL.computeEffective({ ...SU, ui: hub({ layout: { pages: { 'firm:admin': { ...pages['firm:admin'], icons: [{ item: 'myTasks' }] } } } }) }, REG, lay);
    expect(e2.find((e) => e.id === 'myTasks').group).toBe('Admin');
    expect(e2.find((e) => e.id === 'logout').group).toBe('Home');
    expect(ids(e2.filter((e) => e.group === 'More actions'))).toEqual(['code']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The page skeleton: every real mount (Home's icon row in its .home-egg-row
// div), #ycPages (More Features and Admin are built there, C4), the panel
// stage, the page's own tab / drill / icon-row CSS and the page functions the
// items call, as recording stubs.
function boot() {
  const tabs = new Set(['tabHome', 'tabAll', 'tabSettings']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}<style>${EGG_CSS}</style></head><body>
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
  w.open = (...a) => { calls.push(['open', ...a]); return null; };
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n' +
    'var user = { user: 7 };\nfunction openTasksTab(f) { __calls.push(["openTasksTab", JSON.parse(JSON.stringify(f))]); }\n';
  for (const it of Object.values(w.FEATURE_REGISTRY)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push(['${m[1]}']); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  const d = w.document;
  const L = w.ycLauncher;
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const tab = { home: d.querySelector('#tabHome > .home-grid'), homeIcons: d.querySelector('#tabHome > .home-egg-row') };
  // the region of a mounted surface as HTML: Home's grid / icon row = the div's; the sidebar's = after #tabOpenFiles
  const region = (sf) => {
    if (tab[sf]) return tab[sf].innerHTML;
    const out = [];
    for (let n = d.getElementById('tabOpenFiles').nextSibling; n; n = n.nextSibling) out.push(n);
    const tpl = d.createElement('div'); out.forEach((n) => tpl.appendChild(n.cloneNode(true))); return tpl.innerHTML;
  };
  const parsed = (sf) => { const t = d.createElement('template'); t.innerHTML = L.build(sf); return t.innerHTML; };
  const pageOf = (id) => d.querySelector(`#ycPages > [data-yc-page="${id}"]`);
  // what the user sees on a surface or a page, in order: id (default), +id (neutral), '|' (a break: two <br> on a grid), '#text' (a label)
  const idOf = (el, sf) => {
    if (el.hasAttribute('data-yc-shortcut')) return '+' + el.getAttribute('data-yc-shortcut');
    for (const id of Object.keys(w.FEATURE_REGISTRY)) if (L.elementsOf(id)[sf] === el) return id;
    return '?';
  };
  const nodesOf = (sf) => {
    if (tab[sf]) return [...tab[sf].children];
    const out = [];
    if (sf === 'sidebar') { for (let n = d.getElementById('tabOpenFiles').nextElementSibling; n; n = n.nextElementSibling) out.push(n); }
    else { const t = pageOf(sf); for (let n = t.querySelector('h1').nextElementSibling; n && !/-egg-row$/.test(n.className); n = n.nextElementSibling) out.push(n); }
    return out;
  };
  const seen = (sf) => {
    const out = [];
    let brs = 0;
    for (const el of nodesOf(sf)) {
      if (el.tagName === 'BR') { if (++brs === 2) { out.push('|'); brs = 0; } continue; }
      brs = 0;
      if (!shown(el)) continue;
      out.push(el.classList.contains('home-break') ? '|' : el.classList.contains('sb-section-label') ? '#' + el.textContent : idOf(el, sf));
    }
    return out;
  };
  const icons = (pg) => [...pageOf(pg).querySelectorAll(':scope > .page-egg-row > .page-egg')].map((b) => b.getAttribute('data-yc-shortcut'));
  const observe = () => {
    const mo = new w.MutationObserver(() => {});
    mo.observe(d.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => { const r = mo.takeRecords(); mo.disconnect(); return r; };
  };
  const defaults = () => { const m = {}; for (const id of Object.keys(w.FEATURE_REGISTRY)) m[id] = L.elementsOf(id); return m; };
  return { w, d, L, calls, errors, shown, region, parsed, pageOf, seen, icons, nodesOf, observe, defaults, close: () => w.close() };
}

// ─────────────────────────────────────────────────────────────────────────
describe('2b. icon rows, for real: exec, neutrals, the hidden paw', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('the mounted row is the markup the page expands with; #homeAll is all\'s element; More Features\' paw is a neutral (casey has no element), Admin\'s row is empty and takes no space', () => {
    expect(t.region('homeIcons')).toBe(HOME_ALL.slice('<div class="home-egg-row">'.length, -'</div>'.length));
    expect(t.L.elementsOf('all')).toEqual({ sidebar: t.d.getElementById('sbAll'), homeIcons: t.d.getElementById('homeAll') });
    t.L.applyAccess({ ...SU, ui: hub() });
    expect(t.icons('firm:more')).toEqual(['casey']);
    const paw = t.pageOf('firm:more').querySelector('.page-egg-row > .page-egg');
    expect([paw.getAttribute('aria-label'), paw.hasAttribute('onclick'), paw.hasAttribute('id')]).toEqual(['Casey', false, false]);
    expect(t.L.elementsOf('casey')).toEqual({});
    expect(t.icons('firm:admin')).toEqual([]);
    expect(t.shown(t.pageOf('firm:admin').querySelector(':scope > .page-egg-row'))).toBe(false);   // :empty
    expect(t.errors).toEqual([]);
  });

  test('exec(casey) runs in place — no tab switch; exec(all) opens All through the sidebar item', () => {
    t.L.applyAccess({ ...SU, ui: hub() });
    t.w.openMainTab('tabCases');
    expect(t.L.exec('casey')).toBe(true);
    expect(t.calls).toEqual([['toggleMascot']]);
    expect(t.w.currentMainTabId()).toBe('tabCases');          // the cat is summoned where you are
    expect(t.L.exec('all')).toBe(true);
    expect(t.w.currentMainTabId()).toBe('tabAll');
    // the rendered buttons do the same
    t.calls.length = 0;
    t.w.openMainTab(t.pageOf('firm:more').id);
    t.pageOf('firm:more').querySelector('.page-egg[data-yc-shortcut="casey"]').click();
    expect(t.calls).toEqual([['toggleMascot']]);
    expect(t.w.currentMainTabId()).toBe(t.pageOf('firm:more').id);
    t.w.openMainTab('tabCases');
    t.d.getElementById('homeAll').click();
    expect(t.w.currentMainTabId()).toBe('tabAll');
  });

  test('a firm-placed icon is a neutral .page-egg button (title = aria-label = label, aria-hidden icon, no text) that runs exec; Admin\'s row shows once it holds one', () => {
    const pages = hubPages();
    t.L.applyAccess({ ...SU, ui: hub({ layout: { pages: { 'firm:more': { ...pages['firm:more'], icons: [{ item: 'casey' }, { item: 'myTasks' }] }, 'firm:admin': { ...pages['firm:admin'], icons: [{ item: 'logout' }] } } } }) });
    const b = t.pageOf('firm:more').querySelector(':scope > .page-egg-row > .page-egg[data-yc-shortcut="myTasks"]');
    expect(b).not.toBeNull();
    expect([b.tagName, b.type, b.getAttribute('title'), b.getAttribute('aria-label'), b.textContent, b.hasAttribute('id'), b.hasAttribute('onclick')])
      .toEqual(['BUTTON', 'button', 'My Tasks', 'My Tasks', '', false, false]);
    expect([b.children.length, b.firstElementChild.className, b.firstElementChild.getAttribute('aria-hidden')]).toEqual([1, 'fa-solid fa-list', 'true']);
    expect(b.previousElementSibling.getAttribute('data-yc-shortcut')).toBe('casey');
    expect(t.pageOf('firm:more').querySelector(':scope > .page-egg-row').childNodes).toHaveLength(2);   // no whitespace between icon buttons
    b.click();
    expect(t.calls).toEqual([['openTasksTab', { assigned_to: 7, status: 'Incomplete', defer: 'active' }]]);
    const row = t.pageOf('firm:admin').querySelector(':scope > .page-egg-row');
    expect([row.children.length, row.firstElementChild.className, row.firstElementChild.getAttribute('data-yc-shortcut'), t.shown(row)])
      .toEqual([1, 'page-egg', 'logout', true]);
    // the same look as the paw (the shared rules)
    const look = (el) => ['opacity', 'font-size', 'padding-left', 'border-top-width'].map((p) => t.w.getComputedStyle(el).getPropertyValue(p));
    expect(look(row.firstElementChild)).toEqual(look(b.previousElementSibling));
    // a neutral is never a launcher element
    expect(t.L.elementsOf('myTasks')).toEqual({});
    expect(t.errors).toEqual([]);
  });

  test('the firm takes casey off More Features\' row: no paw on the page, exec still reaches it; the firm\'s row back restores it', () => {
    const pages = hubPages();
    t.L.applyAccess({ ...SU, ui: hub({ layout: { pages: { 'firm:more': { ...pages['firm:more'], icons: [] } } } }) });
    expect(t.icons('firm:more')).toEqual([]);
    expect(t.d.querySelectorAll('#ycPages [data-yc-shortcut="casey"], [data-yc-unplaced]')).toHaveLength(0);
    expect(t.L.exec('casey')).toBe(true);
    expect(t.calls).toEqual([['toggleMascot']]);
    t.L.applyAccess({ ui: hub() });
    expect(t.icons('firm:more')).toEqual(['casey']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('3. All is guaranteed in Home\'s icon row (ruling 3)', () => {
  const R = (o) => ids(VL.resolveLayout('homeIcons', { base: LAY.homeIcons, effective: Object.keys(REG), ...o }).filter((e) => e.kind === 'item'));

  test('resolver: a firm or user removal is ignored; a placed row without it gets it back; it is never doubled', () => {
    expect(R({ firm: { removed: { homeIcons: ['all'] } } })).toEqual(['all']);
    expect(R({ user: { removed: { homeIcons: ['all'] } } })).toEqual(['all']);
    expect(R({ firm: { placed: { homeIcons: [{ item: 'myTasks' }] } } })).toEqual(['all', 'myTasks']);
    expect(R({ user: { placed: { homeIcons: [{ item: 'logout' }, { item: 'myTasks' }] }, removed: { homeIcons: ['all'] } } })).toEqual(['all', 'logout', 'myTasks']);
    expect(R({ firm: { placed: { homeIcons: [{ item: 'myTasks' }, { item: 'all' }] } }, user: { placed: { homeIcons: [{ item: 'logout' }] } } })).toEqual(['myTasks', 'all', 'logout']);
    expect(R({ user: { placed: { homeIcons: [{ item: 'all' }, { item: 'all' }] } } })).toEqual(['all']);
    // the server refuses the removal outright, both scopes
    for (const scope of ['firm', 'user']) {
      expect(shape.validate(scope, 'layout', { removed: { homeIcons: ['all'] } }).errors).toEqual(["removed.homeIcons: all is always in this row (it can't be removed)"]);
    }
    expect(shape.GUARANTEED).toEqual({ homeIcons: ['all'] });
  });

  test('the sidebar All is an ordinary item: a user removes it there and keeps Home\'s; exec(all) still works; all is undeniable', () => {
    const t = boot();
    try {
      t.L.applyAccess({ ...SU, ui: ui({ layout: { removed: { sidebar: ['all'], homeIcons: ['all'] } } }) });
      const sb = t.d.getElementById('sbAll'), home = t.d.getElementById('homeAll');
      expect([t.shown(sb), sb.hasAttribute('data-yc-unplaced'), sb.isConnected]).toEqual([false, true, true]);
      expect([t.shown(home), home.hasAttribute('data-yc-unplaced')]).toEqual([true, false]);
      expect(t.L.exec('all')).toBe(true);
      expect(t.w.currentMainTabId()).toBe('tabAll');
      // a firm hide / deny / visible_to of `all` is ignored client-side (the server refuses them)
      t.L.applyAccess({ ...SU, roles: ['staff'], isAdmin: false, denied: ['all'], ui: ui({ ro: { hidden: ['all'], visible_to: { all: ['attorney'] } } }) });
      expect(ids(t.L.effectiveRegistry())).toContain('all');
      expect([t.shown(home), t.shown(t.d.getElementById('sbAll'))]).toEqual([true, true]);
    } finally { t.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('4. the two-level resolver: shipped → firm → user', () => {
  const eff = Object.keys(REG).concat('firm:payroll', 'firm:clio', 'firm:more');
  const R = (sf, o) => VL.resolveLayout(sf, { base: LAY[sf], effective: eff, ...o });
  const shape_ = (out) => out.map((e) => (e.kind === 'item' ? e.id : e.kind === 'label' ? '#' + e.text : '|'));

  test('without a firm document the S4a contract holds (base → user); an empty firm document changes nothing', () => {
    const user = { placed: { home: [{ item: 'comms' }, { item: 'cases' }, { break: true }, { item: 'moreAutomations' }] }, removed: { home: ['tasks'] } };
    const a = shape_(R('home', { user })), b = shape_(R('home', { user, firm: {} })), c = shape_(R('home', { user, firm: null }));
    expect(a).toEqual(['comms', 'cases', 'contacts', 'appts', 'bills', 'pipeline', 'events', 'newClient', 'log', 'calendar', '|', 'moreAutomations']);   // More's Home tile is the firm's (firm:more) since C4
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    for (const e of R('home', { user, firm: {} })) expect(Object.keys(e).sort()).toEqual(e.kind === 'item' ? ['id', 'kind', 'origin'] : ['kind', 'origin']);
  });

  test('the firm step is the base of the user step: a firm sidebar layout is what a user sees; firm placements read as default', () => {
    const firm = { placed: { sidebar: [{ label: 'Firm' }, { item: 'firm:clio' }, { item: 'cases' }] }, removed: { sidebar: ['log'] } };
    const out = R('sidebar', { firm });
    expect(shape_(out).slice(0, 3)).toEqual(['#Firm', 'firm:clio', 'cases']);
    expect(shape_(out)).not.toContain('log');
    expect(shape_(out).filter((x) => x[0] !== '#').sort()).toEqual([...placed('sidebar').filter((k) => k !== 'log'), 'firm:clio'].sort());
    expect(new Set(out.map((e) => e.origin))).toEqual(new Set(['default']));
    // the user step over it: the firm's order IS the base (a partial user list: the firm-base items slot in by the merge rule)
    const mine = shape_(R('sidebar', { firm, user: { placed: { sidebar: [{ item: 'contacts' }] } } }));
    expect(mine.filter((x) => ['firm:clio', 'cases', 'contacts'].includes(x))).toEqual(['firm:clio', 'cases', 'contacts']);
    expect(mine).not.toContain('log');
  });

  test('ruling 4: a firm Home change only ADDS for a user who already arranged Home; a fresh user gets the firm\'s order', () => {
    // a FULL firm list, as the firm editor writes one (a partial list pulls base items next to their neighbours, S4a JC3)
    const FIRM_HOME = ['tasks', 'cases', 'moreAutomations', '|', 'contacts', 'appts', 'bills', '|', 'pipeline', 'events', 'newClient', '|', 'calendar', 'firm:more', 'comms', 'firm:payroll'];
    const firm = { placed: { home: FIRM_HOME.map((x) => (x === '|' ? { break: true } : { item: x })) }, removed: { home: ['log'] } };
    // no user layout: the firm's Home exactly
    const fresh = shape_(R('home', { firm }));
    expect(fresh).toEqual(FIRM_HOME);
    expect(fresh).not.toContain('log');
    // a customized user: THEIR order; the firm's additions appear next to their firm-base neighbour, nothing of theirs moves or goes
    const user = { placed: { home: [{ item: 'comms' }, { item: 'cases' }, { break: true }, { item: 'contacts' }] } };
    const mine = shape_(R('home', { firm, user }));
    expect(mine.filter((x) => ['comms', 'cases', 'contacts'].includes(x))).toEqual(['comms', 'cases', 'contacts']);   // their order
    expect(mine.indexOf('cases')).toBeLessThan(mine.indexOf('|'));
    expect(mine.indexOf('|')).toBeLessThan(mine.indexOf('contacts'));
    expect(mine).toContain('moreAutomations');                 // the firm's additions, next to their firm-base neighbours
    expect(mine).toContain('firm:payroll');
    expect(mine.indexOf('firm:payroll')).toBe(mine.indexOf('comms') + 1);
    expect(mine.filter((x) => x !== '|').sort()).toEqual(FIRM_HOME.filter((x) => x !== '|').sort());
    expect(mine).not.toContain('log');                          // the firm removed it; the user did not re-place it
    expect(mine.filter((x) => x === 'cases')).toHaveLength(1);
    // the user re-places what the firm removed: explicit beats inherited
    expect(shape_(R('home', { firm, user: { placed: { home: [{ item: 'log' }] } } }))).toContain('log');
    // user origins are theirs, the rest default
    expect(R('home', { firm, user }).filter((e) => e.origin === 'user').map((e) => e.id || '|')).toEqual(['comms', 'cases', '|', 'contacts']);
  });

  test('locked: a user\'s removal of a firm-locked item is ignored; the firm\'s own removal is not (the firm is not locked against itself)', () => {
    const locked = ['bills'];
    expect(shape_(R('home', { user: { removed: { home: ['bills'] } }, locked }))).toContain('bills');
    expect(shape_(R('home', { firm: { removed: { home: ['bills'] } }, locked }))).not.toContain('bills');
    expect(shape_(R('home', { firm: { placed: { home: [{ item: 'cases' }] }, removed: { home: ['bills'] } }, user: { placed: { home: [{ item: 'bills' }] } }, locked }))).toContain('bills');   // explicit beats the firm's removal
  });

  test('junk never throws; ids missing from the effective registry drop at either tier', () => {
    for (const junk of [null, 1, 'x', [], { placed: 5 }, { placed: { home: 'x' }, removed: [] }, { removed: { home: 'x' } }]) {
      expect(() => R('home', { firm: junk, user: junk })).not.toThrow();
      expect(shape_(R('home', { firm: junk, user: junk }))).toEqual(shape_(R('home', {})));
    }
    expect(shape_(R('home', { firm: { placed: { home: [{ item: 'nope' }, { item: 'cases' }] } }, effective: ['cases'] }))).toEqual(['cases']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('5. the renderer under a firm layout, for real', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());
  // More Features rebalanced by the firm: rows of four, Payroll (a firm item) in row 5, Users (an Admin panel) last
  const MORE_TILES = [
    { item: 'moreManuals' }, { item: 'moreSettings' }, { item: 'moreTheme' }, { item: 'moreFeatureRequests' }, { break: true },
    { item: 'moreSimpleForms' }, { item: 'moreFormBuilder' }, { item: 'moreFormInbox' }, { item: 'morePortalManager' }, { break: true },
    { item: 'moreSignatures' }, { item: 'moreAssetManager' }, { item: 'moreVideoManager' }, { item: 'moreDocuments' }, { break: true },
    { item: 'moreCaseConfig' }, { item: 'moreChecklists' }, { item: 'moreAutomations' }, { item: 'moreViews' }, { break: true },
    { item: 'moreAvailability' }, { item: 'moreBooking' }, { item: 'moreCourtPreview' }, { item: 'firm:payroll' }, { break: true },
    { item: 'moreCampaigns' }, { item: 'moreRedirects' }, { item: 'moreLandingPages' }, { item: 'moreReports' }, { break: true },
    { item: 'moreAssistant' }, { break: true },
    { item: 'adminUsers' },
  ];
  const MORE = (o = {}) => hub({ items: [FIRM_URL], layout: { pages: { 'firm:more': { ...hubPages()['firm:more'], tiles: MORE_TILES } } }, ...o });

  test('no firm layout: every mounted surface is the DOM byte for byte, and applyAccess changes nothing; no firm row; the hub pages re-run changes nothing either', () => {
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
    t.L.applyAccess({ ...SU, ui: ui({ ro: { items: [FIRM_URL] } }) });
    const done = t.observe();
    t.L.applyAccess({ ...SU, ui: ui({ ro: { items: [FIRM_URL] } }) });
    expect(done().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
    expect([t.d.querySelectorAll('[data-yc-firm-row]').length, t.d.getElementById('ycPages').childNodes.length]).toEqual([0, 0]);   // the More firm row retired (C4)
    t.L.applyAccess({ ...SU, ui: hub({ items: [FIRM_URL] }) });
    const done2 = t.observe();
    t.L.applyAccess({ ...SU, ui: hub({ items: [FIRM_URL] }) });
    expect(done2().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    expect(t.d.querySelectorAll('[data-yc-firm-row], #ycPages [data-yc-shortcut="firm:payroll"]')).toHaveLength(0);
    expect(t.errors).toEqual([]);
  });

  test('More Features laid out by the firm: rows follow the breaks, the firm item is a neutral tile in row 5', () => {
    t.L.applyAccess({ ...SU, ui: MORE() });
    const rows = t.seen('firm:more').join(' ').split(' | ').map((r) => r.split(' '));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1, 1]);
    expect(rows[4]).toEqual(['+moreAvailability', '+moreBooking', '+moreCourtPreview', '+firm:payroll']);
    expect(rows[6]).toEqual(['+moreAssistant']);
    expect(rows[7]).toEqual(['+adminUsers']);
    // a firm break on a page is two <br> elements, never a .home-break
    expect(t.nodesOf('firm:more').filter((n) => n.tagName === 'BR')).toHaveLength(14);
    expect(t.d.querySelectorAll('#ycPages .home-break')).toHaveLength(0);
    const n = t.pageOf('firm:more').querySelector(':scope > .big-button[data-yc-shortcut="firm:payroll"]');
    expect([n.className, n.hasAttribute('data-target'), n.hasAttribute('data-exclusive-group'), n.hasAttribute('onclick'), n.hasAttribute('id')]).toEqual(['big-button', false, false, false, false]);
    expect([...n.childNodes].map((c) => c.nodeName)).toEqual(['I', 'BR', 'BR', '#text']);
    expect([n.querySelector('i').className, n.lastChild.nodeValue]).toEqual(['fa-solid fa-money-check fa-2xl', 'Payroll']);
    n.click();
    expect(t.calls.pop()).toEqual(['open', 'https://payroll.example.com/', '_blank', 'noopener']);
    expect(t.errors).toEqual([]);
  });

  test('Users placed on More Features opens in place there, and IT keeps its capability-gated tile', () => {
    t.L.applyAccess({ ...SU, ui: MORE() });
    const M = t.pageOf('firm:more'), A = t.pageOf('firm:admin');
    t.w.openMainTab(M.id);
    const n = M.querySelector(':scope > .big-button[data-yc-shortcut="adminUsers"]');
    expect([n.getAttribute('data-target'), n.hasAttribute('data-exclusive-group'), n.hasAttribute('onclick')]).toEqual(['usersDiv', false, false]);
    n.click();
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('usersDiv')), M.classList.contains('drill-active'), A.classList.contains('drill-active')]).toEqual([M.id, true, true, false]);
    expect(M.querySelector(':scope > .feature-strip .pill-button.active').dataset.target).toBe('usersDiv');
    // the tiles are neutrals: adminUsers has no launcher element at all
    expect(t.L.elementsOf('adminUsers')).toEqual({});
    t.L.applyAccess({ isAdmin: false, roles: ['it'] });
    expect(t.pageOf('firm:more').querySelector(':scope > .big-button[data-yc-shortcut="adminUsers"]')).not.toBeNull();
  });

  test('a tile the firm takes off More Features is drawn nowhere, gets no pill, and exec still opens its panel (on the panel tab: no page shows it)', () => {
    const tiles = hubPages()['firm:more'].tiles.filter((e) => e.item !== 'moreViews');
    t.L.applyAccess({ ...SU, ui: hub({ items: [FIRM_URL], layout: { pages: { 'firm:more': { ...hubPages()['firm:more'], tiles } } } }) });
    expect(t.seen('firm:more')).not.toContain('+moreViews');
    expect(t.d.querySelectorAll('#ycPages [data-yc-shortcut="moreViews"], #ycPages [data-yc-unplaced]')).toHaveLength(0);
    // drill in: the strip is the page's tiles
    const M = t.pageOf('firm:more');
    t.w.openMainTab(M.id);
    M.querySelector('[data-yc-shortcut="moreManuals"]').click();
    const pills = [...M.querySelectorAll(':scope > .feature-strip .pill-button')].map((p) => p.textContent.trim());
    expect(pills).toContain('Manuals');
    expect(pills).not.toContain('Views');
    // exec reaches it all the same (the URL restore refuses it — tests/wsurlS2.test.js)
    expect(t.L.exec('moreViews')).toBe(true);
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('viewsDiv'))]).toEqual(['tabPanel', true]);
  });

  test('a firm-removed Home tile that HEADS a row stays after its break, hidden by data-yc-unplaced (never style.display): the DOM order is the default\'s', () => {
    const bills = t.L.elementsOf('bills').home;
    t.L.applyAccess({ ...SU, ui: ui({ firm: { removed: { home: ['bills', 'tasks'] } } }) });
    expect([t.region('home').replace(/ data-yc-unplaced=""/g, ''), bills.style.display, t.shown(bills)]).toEqual([t.parsed('home'), '', false]);
    expect([...t.d.querySelectorAll('[data-yc-unplaced]')].map((e) => e.textContent.trim())).toEqual(['Billing', 'Tasks']);
    expect(bills.previousElementSibling.className).toBe('home-break');
    expect(t.L.exec('bills')).toBe(true);                                                  // exec still reaches the hidden tile
  });

  test('a USER document naming More / Admin / their icon rows is ignored by the renderer (retired surfaces: the pages and every mounted surface unchanged)', () => {
    t.L.applyAccess({ ...SU, ui: hub() });
    const before = [t.d.getElementById('ycPages').innerHTML, ...SURFACES.map((sf) => t.region(sf))];
    t.L.applyAccess({ ...SU, ui: hub({}, { placed: { more: [{ item: 'moreReports' }], moreIcons: [{ item: 'myTasks' }], admin: [], adminIcons: [{ item: 'logout' }] }, removed: { more: ['moreManuals'], moreIcons: ['casey'] } }) });
    expect([t.d.getElementById('ycPages').innerHTML, ...SURFACES.map((sf) => t.region(sf))]).toEqual(before);
    // and a firm document still carrying them (the live row until its next save) draws nothing from them either
    t.L.applyAccess({ ...SU, ui: hub({ layout: { placed: { more: [{ item: 'moreReports' }], adminIcons: [{ item: 'logout' }] }, removed: { admin: ['adminEtch'] } } }) });
    expect(t.d.getElementById('ycPages').innerHTML).toBe(before[0]);
  });

  test('Admin: the firm takes a tile off its page and places an icon; Home and the sidebar: the firm\'s defaults then the user\'s', () => {
    const rest = hubTiles('firm:admin').filter((k) => !['adminUsers', 'adminEtch', 'adminDbConsole'].includes(k));
    t.L.applyAccess({ ...SU, ui: hub({ layout: {
      placed: { home: [{ item: 'tasks' }, { item: 'cases' }], sidebar: [{ label: 'Firm' }, { item: 'cases' }] }, removed: { home: ['log'] },
      pages: { 'firm:admin': { tiles: [{ item: 'adminUsers' }, { item: 'adminEtch' }, { break: true }, { item: 'moreManuals' }, ...rest.map((k) => ({ item: k }))], icons: [{ item: 'myTasks' }] } },
    } }, { placed: { home: [{ item: 'comms' }, { item: 'tasks' }] } }) });
    const admin = t.seen('firm:admin');
    expect(admin).toEqual(['+adminUsers', '+adminEtch', '|', '+moreManuals', ...rest.map((k) => '+' + k)]);
    expect(admin).not.toContain('+adminDbConsole');
    expect(t.icons('firm:admin')).toEqual(['myTasks']);
    // Home: the user's order first, the firm's additions after their firm-base neighbours, the firm's removal honoured
    const home = t.seen('home');
    expect(home[0]).toBe('comms');
    expect(home.filter((x) => ['comms', 'tasks'].includes(x))).toEqual(['comms', 'tasks']);   // the user's order; firm-base items slot around them
    expect(home).not.toContain('log');
    expect(t.L.elementsOf('log').home.hasAttribute('data-yc-unplaced')).toBe(true);
    // the sidebar: the firm's label is a default node for the user (no user layout for it)
    expect(t.seen('sidebar')[0]).toBe('#Firm');
    expect(t.seen('sidebar')[1]).toBe('cases');
    // the More panel pinned on Admin opens in place on Admin (S6c-4)
    const A = t.pageOf('firm:admin');
    t.w.openMainTab(A.id);
    A.querySelector(':scope > .big-button[data-yc-shortcut="moreManuals"]').click();
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('manualsDiv')), A.classList.contains('drill-active')]).toEqual([A.id, true, true]);
    expect(t.errors).toEqual([]);
  });

  test('re-running the same state changes nothing; a different firm layout then an empty one restores every mounted surface byte for byte, same elements', () => {
    const before = t.defaults();
    const state = { ...SU, ui: MORE() };
    t.L.applyAccess(state);
    const snap = [t.d.getElementById('ycPages').innerHTML, ...SURFACES.map((sf) => t.region(sf))];
    const done = t.observe();
    t.L.applyAccess(state);
    t.L.applyAccess({ roles: state.roles });
    expect(done().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    expect([t.d.getElementById('ycPages').innerHTML, ...SURFACES.map((sf) => t.region(sf))]).toEqual(snap);
    for (const empty of [{}, { placed: {}, removed: {} }, null]) {
      t.L.applyAccess({ ...SU, ui: ui({ firm: empty, ro: hubFirm({ items: [FIRM_URL] }).registry_overrides }) });
      for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
      expect([t.seen('firm:more'), t.seen('firm:admin')]).toEqual([[], []]);              // the pages, with no document: empty
      t.L.applyAccess(state);
    }
    t.L.applyAccess({ ...SU, ui: ui({}) });
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
    for (const id of Object.keys(REG)) expect([id, t.L.elementsOf(id)]).toEqual([id, before[id]]);
    expect(t.d.querySelectorAll('[data-yc-shortcut], [data-yc-unplaced]')).toHaveLength(0);
    expect(t.d.getElementById('ycPages').childNodes).toHaveLength(0);
  });

  test('FUZZ: after any firm layout (pages and the retired surfaces included) every mounted default element is still in the DOM, in its surface, the same element — and no id repeats', () => {
    let seed = 20261016;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const pool = Object.keys(REG).concat('firm:payroll', 'firm:clio', 'nope', 'user:x');
    const before = t.defaults();
    const parent = (sf) => (sf === 'home' ? t.d.querySelector('#tabHome > .home-grid') : sf === 'sidebar' ? t.d.getElementById('appSidebar')
      : t.d.querySelector('#tabHome > .home-egg-row'));
    const idsIn = () => [...t.d.querySelectorAll('[id]')].map((e) => e.id);
    const ALL_SF = [...SURFACES, 'more', 'moreIcons', 'admin', 'adminIcons'];               // the retired four: junk the renderer must ignore
    for (let round = 0; round < 60; round++) {
      const firm = { placed: {}, removed: {}, pages: {} };
      const user = { placed: {}, removed: {} };
      const mk = (grid, icons, sidebar) => {
        const list = [];
        const n = Math.floor(rnd() * (icons ? 6 : 14));
        for (let i = 0; i < n; i++) {
          const r = rnd();
          if (!icons && grid && r < 0.15) list.push({ break: true });
          else if (!icons && sidebar && r < 0.15) list.push({ label: 'L' + i });
          else list.push({ item: pick(pool) });
        }
        return list;
      };
      for (const sf of ALL_SF) {
        const grid = ['home', 'more', 'admin'].includes(sf), icons = /Icons$/.test(sf);
        if (rnd() < 0.6) firm.placed[sf] = mk(grid, icons, sf === 'sidebar');
        if (rnd() < 0.5) firm.removed[sf] = Array.from({ length: Math.floor(rnd() * 5) }, () => pick(pool));
        if (SURFACES.includes(sf)) {
          if (rnd() < 0.5) user.placed[sf] = mk(grid, icons, sf === 'sidebar');
          if (rnd() < 0.4) user.removed[sf] = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(pool));
        }
      }
      for (const pg of ['firm:more', 'firm:admin']) if (rnd() < 0.7) firm.pages[pg] = { tiles: mk(true, false, false), icons: mk(false, true, false) };
      const f = hubFirm({ items: [FIRM_URL], ro: { locked: rnd() < 0.3 ? ['bills'] : [] } });
      t.L.applyAccess({ ...SU, ui: { firm: { registry_overrides: f.registry_overrides, layout: firm }, user: { layout: user } } });
      for (const id of Object.keys(REG)) {
        for (const sf of Object.keys(before[id])) {
          const el = before[id][sf];
          expect([round, id, sf, el.isConnected, el.parentElement === parent(sf), t.L.elementsOf(id)[sf] === el]).toEqual([round, id, sf, true, true, true]);
        }
      }
      const all = idsIn();
      expect([round, all.filter((x, i) => all.indexOf(x) !== i)]).toEqual([round, []]);
      expect([round, !!t.pageOf('firm:more'), !!t.pageOf('firm:admin')]).toEqual([round, true, true]);
      expect([round, t.shown(t.d.getElementById('homeAll'))]).toEqual([round, true]);   // guaranteed, whatever the layouts
      expect([round, t.errors]).toEqual([round, []]);
    }
    t.L.applyAccess({ ...SU, ui: ui({}) });
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
  });

  test('no firm row (retired with the hub, C4): a firm item is drawn only where placed, still listed in All and the palette, and exec dispatches it', () => {
    for (const firm of [undefined, { removed: { home: ['bills'] } }, { placed: { home: [] } }]) {
      t.L.applyAccess({ ...SU, ui: hub({ items: [FIRM_URL], ...(firm ? { layout: firm } : {}) }) });
      expect(t.d.querySelectorAll('[data-yc-firm-row], [data-yc-shortcut="firm:payroll"]')).toHaveLength(0);
    }
    expect(ids(t.L.effectiveRegistry())).toContain('firm:payroll');
    expect(t.L.exec('firm:payroll')).toBe(true);
    expect(t.calls.pop()).toEqual(['open', 'https://payroll.example.com/', '_blank', 'noopener']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('6. the user editor carries homeIcons through a save', () => {
  test('a stored homeIcons list is written back as stored, is not dirty, and survives an edit elsewhere', () => {
    const ctx = vm.createContext({ URL, console: { error: (m) => { throw new Error(String(m)); }, warn() {} } });
    ctx.window = ctx;
    vm.runInContext(ICON_SRC, ctx);
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    vm.runInContext(EDITOR_SRC, ctx);
    const L = ctx.window.ycLauncher, E = ctx.window.ycLayoutEditor;
    const list = L.computeEffective(SU);
    const stored = { placed: { home: [{ item: 'cases' }], homeIcons: [{ item: 'myTasks' }, { item: 'all' }] }, removed: { home: ['log'], homeIcons: ['logout'] } };
    const s = E.session({ stored, effective: J(list), locked: [], base: J(ctx.window.DEFAULT_LAYOUTS), registry: ctx.window.FEATURE_REGISTRY, groups: J(list.groups) });
    expect(s.isDirty()).toBe(false);
    expect(J(s.doc())).toEqual(stored);
    expect(s.hide('sidebar', 2)).toBe(true);
    const doc = J(s.doc());
    expect(doc.placed.homeIcons).toEqual([{ item: 'myTasks' }, { item: 'all' }]);
    expect(doc.removed.homeIcons).toEqual(['logout']);
    expect(shape.validate('user', 'layout', doc).ok).toBe(true);
    // a reset of Home leaves the icon row alone
    expect(s.reset('home')).toBe(true);
    expect(J(s.doc()).placed.homeIcons).toEqual([{ item: 'myTasks' }, { item: 'all' }]);
  });
});
