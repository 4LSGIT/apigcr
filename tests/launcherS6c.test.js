// tests/launcherS6c.test.js
//
/**
 * ui-custom S6c-1+2 — icon rows, real Admin tile gates, and the firm default
 * layout (no visible change). S6c_DESIGN.md §4.2–§4.4, §4.7, §5 S6c-1 / S6c-2,
 * and Fred's rulings on §6.
 *
 *   1. GATES: every Admin tile carries the gate its routes enforce (`gate:
 *      'su'` on the twelve superuserOnly tools, none on Etch — a static page),
 *      pinned as a set; the Admin PAGE item carries none (its visibility is the
 *      firm's visible_to). computeEffective applies a gate with the user's
 *      roles by lib/capabilities' rule — the shell's CAP_ROOT / ROLE_CAPS copies
 *      are pinned to the module, and the behaviour is checked on a synthetic
 *      registry (su, it, a role, a root capability, an unknown gate: closed).
 *   2. ICON ROWS: three new surfaces (homeIcons / moreIcons / adminIcons) render
 *      S6b's hand-written paw and #homeAll markup BYTE FOR BYTE (the expanded
 *      page), Admin's row an empty div; casey and all are placed items (group
 *      More / Settings); exec(casey) clicks the paw in place (no tab switch);
 *      a firm-placed icon is a neutral `.<page>-egg` button that runs exec.
 *   3. ALL IS GUARANTEED in Home's icon row (ruling 3): a firm or user removal
 *      is ignored, a placed row without it gets it back; the sidebar's All is an
 *      ordinary item a user may remove, and exec(all) still works then.
 *   4. THE TWO-LEVEL RESOLVER: shipped → firm → user, one merge rule twice;
 *      a firm Home change only ADDS for a customized user (ruling 4); the
 *      firm's own step ignores `locked`; resolveLayout without `firm` is the
 *      S4a contract.
 *   5. THE RENDERER under a firm layout, for real (jsdom, the page's own
 *      mounts, drill-in, tabs): with no firm row every surface is the mounted
 *      DOM byte for byte; More rebalanced moves the SAME tiles (found by id,
 *      never by position); a firm-removed tile stays in the DOM hidden by
 *      data-yc-unplaced, out of the pill strip, still reached by exec; a firm
 *      item placed on the grid is a neutral tile and the firm row is gone; an
 *      Admin item on More opens in place there (S6c-4, the panel stage); a FUZZ of random firm
 *      layouts never drops a mounted default element nor duplicates an id, and
 *      an empty firm layout restores the default DOM; a re-run changes nothing.
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

const PAW = '<div class="more-egg-row"><button type="button" class="more-egg" onclick="toggleMascot()" title="Casey the YisraCat" aria-label="Casey the YisraCat"><i class="fa-solid fa-paw" aria-hidden="true"></i></button></div>';
const HOME_ALL = '<div class="home-egg-row"><button type="button" id="homeAll" class="home-egg" onclick="openMainTab(\'tabAll\')" title="All features" aria-label="All features"><i class="fa-solid fa-table-cells" aria-hidden="true"></i></button></div>';
const SU_TILES = ['adminReadonlyKeys', 'adminApiKeys', 'adminCtaLinks', 'adminDbConsole', 'adminConnections', 'adminApiTester', 'adminTools',
  'adminScratch', 'adminUsers', 'adminSystemAlerts', 'adminSupportInbox', 'adminMailboxes'];
const SURFACES = ['home', 'sidebar', 'homeIcons', 'more', 'moreIcons', 'admin', 'adminIcons'];
const FIRM_URL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const ui = ({ layout, firm, ro } = {}) => ({ firm: { ...(ro ? { registry_overrides: ro } : {}), ...(firm ? { layout: firm } : {}) }, user: layout ? { layout } : {} });
const SU = { isAdmin: true, roles: ['su'], denied: [] };

// ─────────────────────────────────────────────────────────────────────────
describe('1. gates', () => {
  test('the Admin tiles: gate su on the twelve superuserOnly tools, none on Etch; the Admin page item has none; nothing else is gated', () => {
    const gated = Object.keys(REG).filter((k) => REG[k].gate !== undefined);
    expect(gated.sort()).toEqual([...SU_TILES].sort());
    for (const k of gated) expect([k, REG[k].gate]).toEqual([k, 'su']);
    expect(REG.adminEtch.gate).toBeUndefined();
    expect(REG.admin.gate).toBeUndefined();
    // the classification covers every Admin grid tile but Etch
    expect(placed('admin').filter((k) => k !== 'adminEtch').sort()).toEqual([...SU_TILES].sort());
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

  test('for real: a non-su\'s su tiles are HIDDEN on the Admin grid (data-yc-denied), Etch shows, the Admin row follows the page item; su sees all 13', () => {
    const t = boot();
    try {
      t.L.applyAccess({ isAdmin: false, roles: ['it'], denied: [], ui: ui({ ro: { visible_to: { admin: ['it', 'admin'] } } }) });
      const tiles = [...t.d.querySelectorAll('#tabAdmin > .big-button')];
      expect(tiles).toHaveLength(13);
      expect(tiles.filter((b) => t.shown(b)).map((b) => b.textContent.trim())).toEqual(['Etch']);
      for (const id of SU_TILES) expect([id, t.L.elementsOf(id).admin.hasAttribute('data-yc-denied'), t.L.elementsOf(id).admin.style.display]).toEqual([id, true, '']);
      expect(t.d.getElementById('sbAdmin').hasAttribute('data-yc-denied')).toBe(false);   // the page item is theirs
      // drilled in, the strip has no su pill
      t.w.openMainTab('tabAdmin');
      t.L.elementsOf('adminEtch').admin.click();   // a dialog tile: no drill; build the strip through a panel-less path instead
      t.w.ensureStrip(t.d.getElementById('tabAdmin'));
      expect([...t.d.querySelectorAll('#tabAdmin > .feature-strip .pill-button')].map((p) => p.textContent.trim())).toEqual(['All', 'Etch']);
      // staff with the live rule: the page item hidden too; su: nothing hidden
      t.L.applyAccess({ roles: ['staff'] });
      expect(t.d.getElementById('sbAdmin').hasAttribute('data-yc-denied')).toBe(true);
      t.L.applyAccess({ roles: ['su'] });
      expect(t.d.querySelectorAll('#tabAdmin [data-yc-denied], #appSidebar [data-yc-denied]')).toHaveLength(0);
      expect(tiles.filter((b) => t.shown(b))).toHaveLength(13);
    } finally { t.close(); }
  });

  test('over the real registry: a non-su sees Etch and the Admin page (no visible_to), never a su tool; visible_to on `admin` hides the page', () => {
    const staff = VL.computeEffective({ isAdmin: false, roles: ['staff'] });
    expect(ids(staff.filter((e) => e.group === 'Admin'))).toEqual(['adminEtch']);
    expect(ids(staff)).toContain('admin');
    const ro = { visible_to: { admin: ['it', 'admin'] } };   // the live firm's rule
    expect(ids(VL.computeEffective({ isAdmin: false, roles: ['staff'], ui: ui({ ro }) }))).not.toContain('admin');
    const it = VL.computeEffective({ isAdmin: false, roles: ['it'], ui: ui({ ro }) });
    expect(ids(it)).toContain('admin');
    expect(ids(it.filter((e) => e.group === 'Admin'))).toEqual(['adminEtch']);
    expect(ids(VL.computeEffective({ isAdmin: false, roles: ['su'], ui: ui({ ro }) }).filter((e) => e.group === 'Admin'))).toEqual(placed('admin'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('2. icon rows: the surfaces and their markup', () => {
  test('the shipped icon rows: all on Home, casey on More, Admin empty', () => {
    expect(LAY.homeIcons).toEqual([{ item: 'all' }]);
    expect(LAY.moreIcons).toEqual([{ item: 'casey' }]);
    expect(LAY.adminIcons).toEqual([]);
    expect(shape.ICON_SURFACES).toEqual(['homeIcons', 'moreIcons', 'adminIcons']);
  });

  test('the expanded page holds S6b\'s paw and #homeAll markup byte for byte; Admin\'s row is an empty div; the sidebar All is the `all` item', () => {
    const html = expandedShellHtml();
    expect(html).toContain(PAW);
    expect(html).toContain(HOME_ALL);
    expect(html).toContain('<div class="admin-egg-row"></div>');
    expect(VL.build('adminIcons')).toBe('');
    expect(html).toContain('<div class="sb-item" id="sbAll" data-tab="tabAll" onclick="openMainTab(\'tabAll\')" title="All features">\n      <i class="fa-solid fa-table-cells"></i><span>All</span>\n    </div>');
    expect((html.match(/id="sbAll"/g) || []).length).toBe(1);
    expect((html.match(/id="homeAll"/g) || []).length).toBe(1);
    // an empty icon row takes no space; a drilled-in Admin hides its row like More's
    expect(EGG_CSS).toMatch(/\.more-egg-row:empty, \.home-egg-row:empty, \.admin-egg-row:empty \{ display:none; \}/);
    expect(EGG_CSS).toMatch(/\.drill-active > \.admin-egg-row \{ display:none; \}/);
  });

  test('an icon-row item: title (else the label) is also its aria-label; a renderer break or label there is skipped with a console error', () => {
    const reg = { a: { label: 'A thing', icon: 'star', onclick: 'a()' }, b: { label: 'B', title: 'Bee', icon: 'bug', onclick: 'b()', domIds: { moreIcons: 'bId' } } };
    const errors = [];
    const ctx = vm.createContext({ console: { error: (m) => errors.push(String(m)) } });
    ctx.window = ctx;
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    const html = ctx.window.ycLauncher.build('moreIcons', [{ item: 'a' }, { break: true }, { label: 'x' }, { item: 'b' }], reg);
    expect(html).toBe('<button type="button" class="more-egg" onclick="a()" title="A thing" aria-label="A thing"><i class="fa-solid fa-star" aria-hidden="true"></i></button>'
      + '<button type="button" id="bId" class="more-egg" onclick="b()" title="Bee" aria-label="Bee"><i class="fa-solid fa-bug" aria-hidden="true"></i></button>');
    expect(errors).toHaveLength(2);
  });

  test('the effective registry: casey is placed (group More, after the grid); all is placed (group Settings, the sidebar wins); the extras are myTasks and logout', () => {
    const eff = VL.computeEffective(SU);
    expect(ids(eff.filter((e) => e.group === 'More actions'))).toEqual(['myTasks', 'logout']);
    expect(ids(eff.filter((e) => e.group === 'More'))).toEqual([...placed('more'), 'casey']);
    expect(eff.find((e) => e.id === 'all').group).toBe('Settings');
    expect(eff.groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);
    // an item placed only in an icon row is placed by it: Admin's → group Admin; Home's → group Home (not an extra)
    const lay = { ...J(LAY), adminIcons: [{ item: 'myTasks' }], homeIcons: [{ item: 'all' }, { item: 'logout' }] };
    const e2 = VL.computeEffective(SU, REG, lay);
    expect(e2.find((e) => e.id === 'myTasks').group).toBe('Admin');
    expect(e2.find((e) => e.id === 'logout').group).toBe('Home');
    expect(ids(e2.filter((e) => e.group === 'More actions'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The page skeleton: every real mount (the icon rows in their .<page>-egg-row
// divs), the grids' panels, the page's own tab / drill / icon-row CSS and the
// page functions the items call, as recording stubs.
function boot() {
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabAll']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabAll'].includes(t))
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
  const tab = { home: d.querySelector('#tabHome > .home-grid'), homeIcons: d.querySelector('#tabHome > .home-egg-row'),
    moreIcons: d.querySelector('#tabMore > .more-egg-row'), adminIcons: d.querySelector('#tabAdmin > .admin-egg-row') };
  // the region of a surface as HTML: a grid's = the nodes between its h1 and its egg row; the sidebar's = after #tabOpenFiles
  const ws = (n) => n && n.nodeType === 3 && !/\S/.test(n.nodeValue);
  const region = (sf) => {
    if (tab[sf]) return tab[sf].innerHTML;
    const out = [];
    if (sf === 'sidebar') { for (let n = d.getElementById('tabOpenFiles').nextSibling; n; n = n.nextSibling) out.push(n); }
    else {
      const t = d.getElementById(sf === 'more' ? 'tabMore' : 'tabAdmin');
      for (let n = t.querySelector('h1').nextSibling; n && !(n.nodeType === 1 && /-egg-row$/.test(n.className)); n = n.nextSibling) out.push(n);
      if (ws(out[0])) out.splice(0, 1);                  // the skeleton's own whitespace around the mount
      if (ws(out[out.length - 1])) out.pop();
    }
    const tpl = d.createElement('div'); out.forEach((n) => tpl.appendChild(n.cloneNode(true))); return tpl.innerHTML;
  };
  const parsed = (sf) => { const t = d.createElement('template'); t.innerHTML = L.build(sf); return t.innerHTML; };
  // what the user sees on a surface, in order: id (default), +id (neutral), '|' (a break: two <br> on a grid), '#text' (a label)
  const idOf = (el, sf) => {
    if (el.hasAttribute('data-yc-shortcut')) return '+' + el.getAttribute('data-yc-shortcut');
    for (const id of Object.keys(w.FEATURE_REGISTRY)) if (L.elementsOf(id)[sf] === el) return id;
    return '?';
  };
  const nodesOf = (sf) => {
    if (tab[sf]) return [...tab[sf].children];
    const out = [];
    if (sf === 'sidebar') { for (let n = d.getElementById('tabOpenFiles').nextElementSibling; n; n = n.nextElementSibling) out.push(n); }
    else { const t = d.getElementById(sf === 'more' ? 'tabMore' : 'tabAdmin'); for (let n = t.querySelector('h1').nextElementSibling; n && !/-egg-row$/.test(n.className); n = n.nextElementSibling) out.push(n); }
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
  const observe = () => {
    const mo = new w.MutationObserver(() => {});
    mo.observe(d.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => { const r = mo.takeRecords(); mo.disconnect(); return r; };
  };
  const defaults = () => { const m = {}; for (const id of Object.keys(w.FEATURE_REGISTRY)) m[id] = L.elementsOf(id); return m; };
  return { w, d, L, calls, errors, shown, region, parsed, seen, nodesOf, observe, defaults, close: () => w.close() };
}

// ─────────────────────────────────────────────────────────────────────────
describe('2b. icon rows, for real: exec, neutrals, the hidden paw', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('the mounted rows are the markup the page expands with; the paw and #homeAll are the items\' elements', () => {
    expect(t.region('moreIcons')).toBe(PAW.slice('<div class="more-egg-row">'.length, -'</div>'.length));
    expect(t.region('homeIcons')).toBe(HOME_ALL.slice('<div class="home-egg-row">'.length, -'</div>'.length));
    expect(t.region('adminIcons')).toBe('');
    expect(t.L.elementsOf('casey').moreIcons).toBe(t.d.querySelector('#tabMore .more-egg'));
    expect(t.L.elementsOf('all')).toEqual({ sidebar: t.d.getElementById('sbAll'), homeIcons: t.d.getElementById('homeAll') });
    expect(t.shown(t.d.querySelector('#tabAdmin > .admin-egg-row'))).toBe(false);   // :empty
    expect(t.errors).toEqual([]);
  });

  test('exec(casey) clicks the paw in place — no tab switch; exec(all) opens All through the sidebar item', () => {
    t.L.applyAccess(SU);
    t.w.openMainTab('tabCases');
    expect(t.L.exec('casey')).toBe(true);
    expect(t.calls).toEqual([['toggleMascot']]);
    expect(t.w.currentMainTabId()).toBe('tabCases');          // the cat is summoned where you are
    expect(t.L.exec('all')).toBe(true);
    expect(t.w.currentMainTabId()).toBe('tabAll');
    // the rendered buttons do the same
    t.calls.length = 0;
    t.d.querySelector('#tabMore .more-egg').click();
    expect(t.calls).toEqual([['toggleMascot']]);
    t.w.openMainTab('tabCases');
    t.d.getElementById('homeAll').click();
    expect(t.w.currentMainTabId()).toBe('tabAll');
  });

  test('a firm-placed icon is a neutral .<page>-egg button (title = aria-label = label, aria-hidden icon, no text) that runs exec; Admin\'s row shows once it holds one', () => {
    t.L.applyAccess({ ...SU, ui: ui({ firm: { placed: { moreIcons: [{ item: 'casey' }, { item: 'myTasks' }], adminIcons: [{ item: 'logout' }] } } }) });
    const b = t.d.querySelector('#tabMore > .more-egg-row > .more-egg[data-yc-shortcut="myTasks"]');
    expect(b).not.toBeNull();
    expect([b.tagName, b.type, b.getAttribute('title'), b.getAttribute('aria-label'), b.textContent, b.hasAttribute('id'), b.hasAttribute('onclick')])
      .toEqual(['BUTTON', 'button', 'My Tasks', 'My Tasks', '', false, false]);
    expect([b.children.length, b.firstElementChild.className, b.firstElementChild.getAttribute('aria-hidden')]).toEqual([1, 'fa-solid fa-list', 'true']);
    expect(b.previousElementSibling).toBe(t.L.elementsOf('casey').moreIcons);
    expect(t.d.querySelector('#tabMore > .more-egg-row').childNodes).toHaveLength(2);   // no whitespace between icon buttons
    b.click();
    expect(t.calls).toEqual([['openTasksTab', { assigned_to: 7, status: 'Incomplete', defer: 'active' }]]);
    const row = t.d.querySelector('#tabAdmin > .admin-egg-row');
    expect([row.children.length, row.firstElementChild.className, row.firstElementChild.getAttribute('data-yc-shortcut'), t.shown(row)])
      .toEqual([1, 'admin-egg', 'logout', true]);
    // the same look as the paw (the shared rules)
    const look = (el) => ['opacity', 'font-size', 'padding-left', 'border-top-width'].map((p) => t.w.getComputedStyle(el).getPropertyValue(p));
    expect(look(row.firstElementChild)).toEqual(look(t.L.elementsOf('casey').moreIcons));
    // a neutral is never a launcher element
    expect(t.L.elementsOf('myTasks')).toEqual({});
    expect(t.errors).toEqual([]);
  });

  test('a firm removal of casey from More\'s row hides the paw in place (data-yc-unplaced), exec still reaches it; an empty firm layout restores the row byte for byte', () => {
    const paw = t.L.elementsOf('casey').moreIcons;
    t.L.applyAccess({ ...SU, ui: ui({ firm: { removed: { moreIcons: ['casey'] } } }) });
    expect([paw.isConnected, paw.hasAttribute('data-yc-unplaced'), t.shown(paw), paw.style.display]).toEqual([true, true, false, '']);
    expect(t.region('moreIcons')).not.toBe(PAW.slice('<div class="more-egg-row">'.length, -'</div>'.length));
    expect(t.L.exec('casey')).toBe(true);
    expect(t.calls).toEqual([['toggleMascot']]);
    t.L.applyAccess({ ui: ui({ firm: {} }) });
    expect(t.region('moreIcons')).toBe(PAW.slice('<div class="more-egg-row">'.length, -'</div>'.length));
    expect(t.L.elementsOf('casey').moreIcons).toBe(paw);
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
  const eff = Object.keys(REG).concat('firm:payroll', 'firm:clio');
  const R = (sf, o) => VL.resolveLayout(sf, { base: LAY[sf], effective: eff, ...o });
  const shape_ = (out) => out.map((e) => (e.kind === 'item' ? e.id : e.kind === 'label' ? '#' + e.text : '|'));

  test('without a firm document the S4a contract holds (base → user); an empty firm document changes nothing', () => {
    const user = { placed: { home: [{ item: 'comms' }, { item: 'cases' }, { break: true }, { item: 'moreAutomations' }] }, removed: { home: ['tasks'] } };
    const a = shape_(R('home', { user })), b = shape_(R('home', { user, firm: {} })), c = shape_(R('home', { user, firm: null }));
    expect(a).toEqual(['comms', 'cases', 'contacts', 'appts', 'bills', 'pipeline', 'events', 'newClient', 'log', 'calendar', 'moreFeatures', '|', 'moreAutomations']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    for (const e of R('home', { user, firm: {} })) expect(Object.keys(e).sort()).toEqual(e.kind === 'item' ? ['id', 'kind', 'origin'] : ['kind', 'origin']);
  });

  test('the firm step is the base of the user step: a firm More layout is what a user sees (More is firm-only); firm placements read as default', () => {
    const firm = { placed: { more: [{ item: 'moreReports' }, { item: 'firm:clio' }, { break: true }, { item: 'moreManuals' }] }, removed: { more: ['moreViews'] } };
    const out = R('more', { firm });
    expect(shape_(out).slice(0, 4)).toEqual(['moreReports', 'firm:clio', '|', 'moreManuals']);
    expect(shape_(out)).not.toContain('moreViews');
    expect(shape_(out).filter((x) => x !== '|').sort()).toEqual([...placed('more').filter((k) => k !== 'moreViews'), 'firm:clio'].sort());
    expect(new Set(out.map((e) => e.origin))).toEqual(new Set(['default']));
    // the user step over it: a user document naming More is ignored by the renderer (firm-only), but the resolver is one rule — a caller
    // passing one gets the merge; what matters here is that the firm's order IS the base
    // (a partial user list: the firm-base items neither placed nor removed slot in by the merge rule, moreReports first)
    expect(shape_(R('more', { firm, user: { placed: { more: [{ item: 'moreManuals' }] } } })).slice(0, 3)).toEqual(['moreReports', 'firm:clio', 'moreManuals']);
  });

  test('ruling 4: a firm Home change only ADDS for a user who already arranged Home; a fresh user gets the firm\'s order', () => {
    // a FULL firm list, as the firm editor writes one (a partial list pulls base items next to their neighbours, S4a JC3)
    const FIRM_HOME = ['tasks', 'cases', 'moreAutomations', '|', 'contacts', 'appts', 'bills', '|', 'pipeline', 'events', 'newClient', '|', 'calendar', 'moreFeatures', 'comms', 'firm:payroll'];
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

  test('junk never throws; ids missing from the effective registry drop at either tier; a user doc may not name More through the renderer path (firm-only)', () => {
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
  const MORE = { placed: { more: [
    { item: 'moreManuals' }, { item: 'moreSettings' }, { item: 'moreTheme' }, { item: 'moreFeatureRequests' }, { break: true },
    { item: 'moreSimpleForms' }, { item: 'moreFormBuilder' }, { item: 'moreFormInbox' }, { item: 'morePortalManager' }, { break: true },
    { item: 'moreSignatures' }, { item: 'moreAssetManager' }, { item: 'moreVideoManager' }, { item: 'moreDocuments' }, { break: true },
    { item: 'moreCaseConfig' }, { item: 'moreChecklists' }, { item: 'moreAutomations' }, { item: 'moreViews' }, { break: true },
    { item: 'moreAvailability' }, { item: 'moreBooking' }, { item: 'moreCourtPreview' }, { item: 'firm:payroll' }, { break: true },
    { item: 'moreCampaigns' }, { item: 'moreRedirects' }, { item: 'moreLandingPages' }, { item: 'moreReports' }, { break: true },
    { item: 'adminUsers' },
  ] } };

  test('no firm layout: every surface is the mounted DOM byte for byte, and applyAccess changes nothing', () => {
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
    t.L.applyAccess({ ...SU, ui: ui({ ro: { items: [FIRM_URL] } }) });
    const done = t.observe();
    t.L.applyAccess({ ...SU, ui: ui({ ro: { items: [FIRM_URL] } }) });
    expect(done().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    for (const sf of SURFACES.filter((s) => s !== 'more')) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
    // More: the grid plus the firm row (S3.3) after it — the only addition
    expect(t.region('more').startsWith(t.parsed('more'))).toBe(true);
    expect(t.d.querySelectorAll('#tabMore > [data-yc-firm-row]')).toHaveLength(3);
    expect(t.errors).toEqual([]);
  });

  test('More rebalanced by the firm: the SAME tiles move (by id), rows follow the breaks, the firm item is a neutral tile in row 5, the firm row is gone', () => {
    const before = t.defaults();
    t.L.applyAccess({ ...SU, ui: ui({ firm: MORE, ro: { items: [FIRM_URL] } }) });
    const rows = t.seen('more').join(' ').split(' | ').map((r) => r.split(' '));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(rows[4]).toEqual(['moreAvailability', 'moreBooking', 'moreCourtPreview', '+firm:payroll']);
    expect(rows[6]).toEqual(['+adminUsers']);
    // a firm break on a grid is two <br> elements, never a .home-break
    expect(t.nodesOf('more').filter((n) => n.tagName === 'BR')).toHaveLength(12);
    expect(t.d.querySelectorAll('#tabMore .home-break, #tabAdmin .home-break')).toHaveLength(0);
    for (const id of placed('more')) expect(t.L.elementsOf(id).more).toBe(before[id].more);
    expect(t.d.querySelectorAll('#tabMore > [data-yc-firm-row]')).toHaveLength(0);   // §4.3 step 4: placed.more replaces the firm row
    const n = t.d.querySelector('#tabMore > .big-button[data-yc-shortcut="firm:payroll"]');
    expect([n.className, n.hasAttribute('data-target'), n.hasAttribute('data-exclusive-group'), n.hasAttribute('onclick'), n.hasAttribute('id')]).toEqual(['big-button', false, false, false, false]);
    expect([...n.childNodes].map((c) => c.nodeName)).toEqual(['I', 'BR', 'BR', '#text']);
    expect([n.querySelector('i').className, n.lastChild.nodeValue]).toEqual(['fa-solid fa-money-check fa-2xl', 'Payroll']);
    n.click();
    expect(t.calls.pop()).toEqual(['open', 'https://payroll.example.com/', '_blank', 'noopener']);
    // the grid's whitespace grammar is kept: every direct child is preceded by the mount's indent
    for (const el of t.d.querySelectorAll('#tabMore > .big-button')) expect(el.previousSibling.nodeValue).toBe('\n  ');
    expect(t.errors).toEqual([]);
  });

  test('an Admin item placed on More opens its panel IN PLACE on More (S6c-4: the neutral carries data-target, no group); a non-su never gets the tile', () => {
    t.L.applyAccess({ ...SU, ui: ui({ firm: MORE }) });
    t.w.openMainTab('tabMore');
    const n = t.d.querySelector('#tabMore > .big-button[data-yc-shortcut="adminUsers"]');
    expect([n.getAttribute('data-target'), n.hasAttribute('data-exclusive-group'), n.hasAttribute('onclick')]).toEqual(['usersDiv', false, false]);
    n.click();
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('usersDiv')), t.d.getElementById('tabMore').classList.contains('drill-active'), t.d.getElementById('tabAdmin').classList.contains('drill-active')]).toEqual(['tabMore', true, true, false]);
    expect(t.d.querySelector('#tabMore > .feature-strip .pill-button.active').dataset.target).toBe('usersDiv');
    // the Admin tile is still the one element of adminUsers; More's neutral is not in elementsOf
    expect(Object.keys(t.L.elementsOf('adminUsers'))).toEqual(['admin']);
    t.L.applyAccess({ isAdmin: false, roles: ['it'] });
    expect(t.d.querySelector('#tabMore > .big-button[data-yc-shortcut="adminUsers"]')).toBeNull();
    expect(t.seen('more')).not.toContain('+adminUsers');
  });

  test('a firm-removed tile stays in the DOM hidden by data-yc-unplaced (never style.display), gets no pill, and exec still opens its panel', () => {
    const views = t.L.elementsOf('moreViews').more;
    t.L.applyAccess({ ...SU, ui: ui({ firm: { removed: { more: ['moreViews'] } }, ro: { items: [FIRM_URL] } }) });
    expect([views.isConnected, views.parentElement.id, views.hasAttribute('data-yc-unplaced'), views.style.display, t.shown(views)]).toEqual([true, 'tabMore', true, '', false]);
    expect(t.seen('more')).not.toContain('moreViews');
    // a removal alone keeps the firm row (only placed.more replaces it)
    expect(t.d.querySelectorAll('#tabMore > [data-yc-firm-row]')).toHaveLength(3);
    // drill in: the strip skips the unplaced tile (and a denied one)
    t.w.openMainTab('tabMore');
    t.L.elementsOf('moreManuals').more.click();
    const pills = [...t.d.querySelectorAll('#tabMore > .feature-strip .pill-button')].map((p) => p.textContent.trim());
    expect(pills).toContain('Manuals');
    expect(pills).not.toContain('Views');
    expect(pills).toContain('Payroll');
    // exec reaches the hidden tile: the panel opens all the same (the URL restore refuses it — tests/wsurlS2.test.js)
    expect(t.L.exec('moreViews')).toBe(true);
    expect(t.shown(t.d.getElementById('viewsDiv'))).toBe(true);
    // hidden where its default neighbour is: the DOM order is the default's
    t.L.applyAccess({ ...SU, ui: ui({ firm: { removed: { more: ['moreViews'] } } }) });
    expect(t.region('more').replace(' data-yc-unplaced=""', '')).toBe(t.parsed('more'));
    expect((t.region('more').match(/data-yc-unplaced/g) || []).length).toBe(1);
  });

  test('a firm-removed tile that HEADS a row stays after its break: the DOM order is the default\'s (anchored by the structure too)', () => {
    t.L.applyAccess({ ...SU, ui: ui({ firm: { removed: { more: ['moreSimpleForms', 'moreCampaigns'], home: ['bills', 'tasks'], admin: ['adminDbConsole'] } } }) });
    for (const sf of ['more', 'home', 'admin']) {
      expect([sf, t.region(sf).replace(/ data-yc-unplaced=""/g, '')]).toEqual([sf, t.parsed(sf)]);
    }
    expect([...t.d.querySelectorAll('[data-yc-unplaced]')].map((e) => e.textContent.trim())).toEqual(['Billing', 'Tasks', 'Simple Forms', 'Campaigns', 'DB Console (SU)']);
    const sf = t.L.elementsOf('moreSimpleForms').more;
    expect([sf.previousElementSibling.tagName, sf.previousElementSibling.previousElementSibling.tagName]).toEqual(['BR', 'BR']);
  });

  test('a USER document naming More / Admin / their icon rows is ignored by the renderer (firm-only surfaces)', () => {
    const before = SURFACES.map((sf) => t.region(sf));
    t.L.applyAccess({ ...SU, ui: ui({ layout: { placed: { more: [{ item: 'moreReports' }], moreIcons: [{ item: 'myTasks' }], admin: [], adminIcons: [{ item: 'logout' }] }, removed: { more: ['moreManuals'], moreIcons: ['casey'] } } }) });
    for (const sf of ['more', 'moreIcons', 'admin', 'adminIcons']) expect([sf, t.region(sf)]).toEqual([sf, before[SURFACES.indexOf(sf)]]);
    expect(t.d.querySelectorAll('#tabMore [data-yc-shortcut], #tabAdmin [data-yc-shortcut], #tabMore [data-yc-unplaced]')).toHaveLength(0);
  });

  test('Admin: the firm removes a tile and places an icon; Home and the sidebar: the firm\'s defaults then the user\'s', () => {
    t.L.applyAccess({ ...SU, ui: ui({
      firm: { placed: { admin: [{ item: 'adminUsers' }, { item: 'adminEtch' }, { break: true }, { item: 'moreManuals' },
        ...placed('admin').filter((k) => !['adminUsers', 'adminEtch', 'adminDbConsole'].includes(k)).map((k) => ({ item: k }))], adminIcons: [{ item: 'myTasks' }],
        home: [{ item: 'tasks' }, { item: 'cases' }], sidebar: [{ label: 'Firm' }, { item: 'cases' }] }, removed: { admin: ['adminDbConsole'], home: ['log'] } },
      layout: { placed: { home: [{ item: 'comms' }, { item: 'tasks' }] } },
    }) });
    const admin = t.seen('admin');
    expect(admin).toEqual(['adminUsers', 'adminEtch', '|', '+moreManuals', ...placed('admin').filter((k) => !['adminUsers', 'adminEtch', 'adminDbConsole'].includes(k))]);
    expect(admin).not.toContain('adminDbConsole');
    expect(t.L.elementsOf('adminDbConsole').admin.hasAttribute('data-yc-unplaced')).toBe(true);
    expect([...t.d.querySelectorAll('#tabAdmin > .admin-egg-row > .admin-egg')].map((b) => b.getAttribute('data-yc-shortcut'))).toEqual(['myTasks']);
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
    t.w.openMainTab('tabAdmin');
    t.d.querySelector('#tabAdmin > .big-button[data-yc-shortcut="moreManuals"]').click();
    expect([t.w.currentMainTabId(), t.shown(t.d.getElementById('manualsDiv')), t.d.getElementById('tabAdmin').classList.contains('drill-active')]).toEqual(['tabAdmin', true, true]);
    expect(t.errors).toEqual([]);
  });

  test('re-running the same state changes nothing; a different firm layout then an empty one restores every surface byte for byte, same elements', () => {
    const before = t.defaults();
    const state = { ...SU, ui: ui({ firm: MORE, ro: { items: [FIRM_URL] } }) };
    t.L.applyAccess(state);
    const snap = SURFACES.map((sf) => t.region(sf));
    const done = t.observe();
    t.L.applyAccess(state);
    t.L.applyAccess({ roles: state.roles });
    expect(done().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    expect(SURFACES.map((sf) => t.region(sf))).toEqual(snap);
    for (const empty of [{}, { placed: {}, removed: {} }, null]) {
      t.L.applyAccess({ ...SU, ui: ui({ firm: empty, ro: { items: [FIRM_URL] } }) });
      for (const sf of SURFACES.filter((s) => s !== 'more')) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
      expect(t.region('more').startsWith(t.parsed('more'))).toBe(true);
      expect(t.d.querySelectorAll('#tabMore > [data-yc-firm-row]')).toHaveLength(3);   // the firm row is back
      t.L.applyAccess(state);
    }
    t.L.applyAccess({ ...SU, ui: ui({}) });
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
    for (const id of Object.keys(REG)) expect([id, t.L.elementsOf(id)]).toEqual([id, before[id]]);
    expect(t.d.querySelectorAll('[data-yc-shortcut], [data-yc-unplaced]')).toHaveLength(0);
  });

  test('FUZZ: after any firm layout every mounted default element is still in the DOM, in its surface, the same element — and no id repeats', () => {
    let seed = 20261016;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const pool = Object.keys(REG).concat('firm:payroll', 'firm:clio', 'nope', 'user:x');
    const before = t.defaults();
    const parent = (sf) => (sf === 'home' ? t.d.querySelector('#tabHome > .home-grid') : sf === 'sidebar' ? t.d.getElementById('appSidebar')
      : sf === 'homeIcons' ? t.d.querySelector('#tabHome > .home-egg-row') : sf === 'moreIcons' ? t.d.querySelector('#tabMore > .more-egg-row')
      : sf === 'adminIcons' ? t.d.querySelector('#tabAdmin > .admin-egg-row') : t.d.getElementById(sf === 'more' ? 'tabMore' : 'tabAdmin'));
    const idsIn = () => [...t.d.querySelectorAll('[id]')].map((e) => e.id);
    for (let round = 0; round < 60; round++) {
      const firm = { placed: {}, removed: {} };
      const user = { placed: {}, removed: {} };
      for (const sf of SURFACES) {
        const grid = ['home', 'more', 'admin'].includes(sf), icons = /Icons$/.test(sf);
        const mk = () => {
          const list = [];
          const n = Math.floor(rnd() * (icons ? 6 : 14));
          for (let i = 0; i < n; i++) {
            const r = rnd();
            if (!icons && grid && r < 0.15) list.push({ break: true });
            else if (!icons && sf === 'sidebar' && r < 0.15) list.push({ label: 'L' + i });
            else list.push({ item: pick(pool) });
          }
          return list;
        };
        if (rnd() < 0.6) firm.placed[sf] = mk();
        if (rnd() < 0.5) firm.removed[sf] = Array.from({ length: Math.floor(rnd() * 5) }, () => pick(pool));
        if (['home', 'sidebar', 'homeIcons'].includes(sf)) {
          if (rnd() < 0.5) user.placed[sf] = mk();
          if (rnd() < 0.4) user.removed[sf] = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(pool));
        }
      }
      t.L.applyAccess({ ...SU, ui: ui({ firm, layout: user, ro: { items: [FIRM_URL], locked: rnd() < 0.3 ? ['bills'] : [] } }) });
      for (const id of Object.keys(REG)) {
        for (const sf of Object.keys(before[id])) {
          const el = before[id][sf];
          expect([round, id, sf, el.isConnected, el.parentElement === parent(sf), t.L.elementsOf(id)[sf] === el]).toEqual([round, id, sf, true, true, true]);
        }
      }
      const all = idsIn();
      expect([round, all.filter((x, i) => all.indexOf(x) !== i)]).toEqual([round, []]);
      expect([round, t.shown(t.d.getElementById('homeAll'))]).toEqual([round, true]);   // guaranteed, whatever the layouts
      expect([round, t.errors]).toEqual([round, []]);
    }
    t.L.applyAccess({ ...SU, ui: ui({}) });
    for (const sf of SURFACES) expect([sf, t.region(sf)]).toEqual([sf, t.parsed(sf)]);
  });

  test('the firm row rule: no placed.more → the row; placed.more (even []) → no row, firm items only where placed', () => {
    t.L.applyAccess({ ...SU, ui: ui({ ro: { items: [FIRM_URL] }, firm: { removed: { more: ['moreReports'] } } }) });
    expect(t.d.querySelectorAll('#tabMore > [data-yc-firm-row]')).toHaveLength(3);
    t.L.applyAccess({ ...SU, ui: ui({ ro: { items: [FIRM_URL] }, firm: { placed: { more: [] } } }) });
    expect(t.d.querySelectorAll('#tabMore > [data-yc-firm-row]')).toHaveLength(0);
    expect(t.seen('more')).not.toContain('+firm:payroll');
    expect(ids(t.L.effectiveRegistry())).toContain('firm:payroll');   // still listed in All and the palette; exec dispatches it
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
