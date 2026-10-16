// tests/launcherS5b.test.js
//
/**
 * ui-custom S5b — drawers, the client side.
 *
 *   1. The effective registry (the page's own ycLauncher block, in a vm): a
 *      drawer is a button of group Mine; its action rides as userAction (never
 *      in the More firm row, never in an effectiveRegistry() copy); the client
 *      re-validates it (≤ 30 ids of the three shapes, no duplicates, no other
 *      field) — a bad one is dropped.
 *   2. The drawer menu, for real in jsdom (the real launcher, tool dialog, All
 *      tab, ycAll.js and ycLayoutEditor.js): only EFFECTIVE entries are listed
 *      (firm-hidden, denied, role-restricted, admin-gated, unknown and nested
 *      drawers drop out silently), in the drawer's order; choosing one closes
 *      the drawer and runs exec(entry); Esc, the × and an outside press close
 *      it, focus goes back to the opener (Esc, ×, a choice); a press on its own
 *      opener is a toggle; arrows / Home / End / Tab; "Nothing here you can
 *      open"; labels and icons escaped; it stands down for the layout editor,
 *      a SweetAlert dialog and the palette; one drawer at a time; applyAccess
 *      re-draws or closes an open one; anchored below a Home tile, beside a
 *      sidebar row, under an All tile, centred with no opener (palette,
 *      shortcut); a sheet at phone width.
 *   3. The editor (My buttons): a drawer made / edited with its ordered
 *      contents; the picker offers the effective registry minus drawers and
 *      minus what the drawer holds (new buttons included); a button inside a
 *      drawer can't become one; its id freezes once a drawer holds it; delete
 *      cascades into drawers (the prompt names them); the open form follows
 *      its row; a drawer is placeable and bindable like any button.
 *   4. The round trip: a drawer created, placed on Home, saved, opened from
 *      its tile, an entry launched — no reload.
 *   5. The pure core: itemSession with drawers under random edit sequences
 *      always writes a document the real validator accepts.
 *
 * Mutation-checked (see the S5b worker report).
 *
 * Run:  npx jest tests/launcherS5b.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DIALOG_SRC = RAW.match(/<script id="ycToolDialogJs">([\s\S]*?)<\/script>/)[1];
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS5b: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CUSTOM_SRC = slice('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];

const J = (x) => JSON.parse(JSON.stringify(x));

// ── fixtures ──
const VIEW = { id: 'user:leads', label: 'My leads', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' } };
const LINK = { id: 'user:court', label: 'Court site', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/cases', present: 'window' } };
const FIRM_URL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const FIRM_TOOL = { id: 'firm:clio', label: 'Get Clio Code', icon: 'c', action: { type: 'tool', key: 'clio-code', present: 'modal', size: 'compact' } };
const FIRM_SECRET = { id: 'firm:secret', label: 'Secret', icon: 'lock', action: { type: 'url', href: 'https://secret.example.com/', present: 'window' } };
const RO = { items: [FIRM_URL, FIRM_TOOL, FIRM_SECRET], hidden: ['firm:secret', 'calendar'], locked: [], renames: {}, visible_to: { moreAutomations: ['attorney'] } };
const DRAWER = (items, over = {}) => ({ id: 'user:box', label: 'My box', icon: 'box-open', action: { type: 'drawer', items }, ...over });
// every way an entry can be ineffective for a non-admin staff user denied moreViews
const MIXED = ['tasks', 'moreAutomations', 'firm:payroll', 'calendar', 'moreViews', 'firm:secret', 'adminUsers', 'notARealItem', 'user:leads', 'user:gone', 'moreDocuments', 'firm:clio'];
const MIXED_SHOWN = ['tasks', 'firm:payroll', 'user:leads', 'moreDocuments', 'firm:clio'];
const ACCESS = { isAdmin: false, denied: ['moreViews'], customTab: null, roles: ['staff'] };
const PICKERS = { status: 'success', tools: [{ key: 'clio-code', title: 'Get Clio Code' }], views: [{ key: 'lead_followups', title: 'Leads follow ups' }] };

// ─────────────────────────────────────────────────────────────────────────
function vmLauncher() {
  const warnings = [];
  const ctx = vm.createContext({ console: { error: (m) => warnings.push(String(m)), warn: (m) => warnings.push(String(m)) }, URL,
    document: { getElementById: () => null } });
  ctx.window = ctx;
  vm.runInContext(REGISTRY_SRC, ctx);
  vm.runInContext(RENDERER_SRC, ctx);
  return { L: ctx.window.ycLauncher, warnings };
}
const uiOf = (items, ro = RO) => ({ firm: { registry_overrides: J(ro) }, user: items ? { items: { items: J(items) } } : {} });

describe('the effective registry: a drawer is a button', () => {
  test('group Mine, in array order; its action rides as userAction, never in a copy', () => {
    const { L } = vmLauncher();
    L.applyAccess({ ...ACCESS, ui: uiOf([VIEW, DRAWER(['tasks']), LINK]) });
    const mine = L.effectiveRegistry().filter((e) => e.group === 'Mine');
    expect(mine.map((e) => e.id)).toEqual(['user:leads', 'user:box', 'user:court']);
    expect(Object.keys(mine[1]).sort()).toEqual(['group', 'icon', 'id', 'label', 'labels']);
    const eff = L.computeEffective({ ...ACCESS, ui: uiOf([DRAWER(['tasks', 'firm:payroll'])]) });
    const box = eff.find((e) => e.id === 'user:box');
    expect([box.action, box.userAction]).toEqual([undefined, { type: 'drawer', items: ['tasks', 'firm:payroll'] }]);
  });

  test('re-validated by the client: ≤ 30 ids of the three shapes, no duplicates, no other field — a bad drawer is dropped', () => {
    const { L, warnings } = vmLauncher();
    const ids = (n) => Array.from({ length: n }, (_, i) => 'item' + i);
    const bad = [
      DRAWER(['tasks', 'tasks'], { id: 'user:dup' }), DRAWER(ids(31), { id: 'user:big' }), DRAWER(['a b'], { id: 'user:shape' }),
      DRAWER(['tasks'], { id: 'user:extra', action: { type: 'drawer', items: ['tasks'], present: 'modal' } }),
      DRAWER(null, { id: 'user:none', action: { type: 'drawer' } }),
      DRAWER(ids(30), { id: 'user:full' }),
    ];
    const eff = L.computeEffective({ ui: uiOf(bad) });
    expect(eff.filter((e) => e.group === 'Mine').map((e) => e.id)).toEqual(['user:full']);
    expect(warnings.filter((w) => /your button \d dropped/.test(w))).toHaveLength(5);
    // a FIRM drawer is never one: dropped by the firm grammar
    const fw = vmLauncher();
    const firmEff = fw.L.computeEffective({ ui: uiOf(null, { ...RO, items: [{ ...DRAWER(['tasks']), id: 'firm:box' }] }) });
    expect(firmEff.some((e) => e.id === 'firm:box')).toBe(false);
    expect(fw.L.cleanFirmItem({ ...DRAWER(['tasks']), id: 'firm:box' })).toBe(null);
    expect(fw.L.cleanUserItem(DRAWER(['tasks']))).toEqual(DRAWER(['tasks']));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The shell for real (the S5a harness, with the firm doc, the roles and a
// SweetAlert stand-in as parameters).
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

function boot({ items = null, layout = null, shortcuts = null, ro = RO, access = ACCESS, platform = 'MacIntel' } = {}) {
  const LAY = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return J(c.DEFAULT_LAYOUTS); })();
  const REG = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return c.FEATURE_REGISTRY; })();
  const placedIds = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
  const grid = (sf) => placedIds(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <script id="ycToolDialogJs">${DIALOG_SRC}</script>
    <input id="outsideInput">
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    ${ALL_TAB}
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script>${grid('admin')}</div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.example/' });
  const w = dom.window;
  if (platform) Object.defineProperty(w.navigator, 'platform', { get: () => platform, configurable: true });
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const calls = [];
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.__calls = calls;
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + CUSTOM_SRC + DRILL_SRC);
  const opened = [];
  w.open = (...a) => { opened.push(a); return null; };
  // a SweetAlert stand-in: swal.dialog() puts a modal dialog up, swal.toast() a toast
  const swal = { up: null };
  w.Swal = {
    isVisible: () => !!swal.up,
    getPopup: () => swal.up,
    fire: () => Promise.resolve({ isConfirmed: true }),
  };
  const putSwal = (kind) => {
    const p = w.document.createElement('div');
    p.className = kind === 'toast' ? 'swal2-popup swal2-toast' : 'swal2-popup';
    w.document.body.appendChild(p);
    swal.up = p;
  };
  const userDoc = () => ({
    ...(items ? { items: J({ items }) } : {}), ...(layout ? { layout: J(layout) } : {}), ...(shortcuts ? { shortcuts: J(shortcuts) } : {}),
  });
  w.firmData = { ui: { firm: { registry_overrides: J(ro) }, user: userDoc() } };
  const db = memDb();
  for (const [k, v] of Object.entries(userDoc())) db.rows.set(`user|9|${k}`, JSON.stringify(v));
  const server = { puts: [], gets: [], fail: {}, db };
  const userNow = () => { const u = {}; for (const [k, v] of db.rows) { const [, uid, key] = k.split('|'); if (uid === '9') u[key] = JSON.parse(v); } return u; };
  server.user = userNow;
  w.apiSend = (url, method, body) => {
    if (method === 'GET' || method == null) {
      server.gets.push(url);
      if (url === '/api/ui-config/pickers') return Promise.resolve(J(PICKERS));
      return Promise.resolve({ status: 'success', firm: { registry_overrides: J(ro) }, user: userNow(), can_edit_firm: false });
    }
    server.puts.push(J({ url, method, body }));
    const f = server.fail[body.config_key];
    if (f) return Promise.reject(Object.assign(new Error(f.message || 'refused'), f));
    return svc.write(db, J(body), { type: 'jwt', userId: 9, roles: ['staff'] }).then(
      (r) => ({ status: 'success', ...J(r) }),
      (e) => Promise.reject(Object.assign(new Error(e.message), { status: e.status || 500, body: { status: 'error', message: e.message, errors: e.errors } })));
  };
  w.confirm = () => true;
  w.ycLauncher.applyAccess({ ...access, ui: w.firmData.ui });
  w.eval(YCALL_SRC);
  w.eval(EDITOR_SRC);
  const d = w.document;
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const key = (el, init) => {
    const e = new (el.ownerDocument.defaultView.KeyboardEvent)('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  const down = (el) => el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  // a pointer press: mousedown, then a click with detail 1 (a keyboard
  // activation — el.click(), Enter / Space on a button — has detail 0)
  const press = (el) => { down(el); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); };
  const drawer = () => d.getElementById('ycDrawer');
  const isOpen = () => !!(drawer() && !drawer().hidden);
  const entries = () => [...drawer().querySelectorAll('.yc-dr-item')].map((b) => b.getAttribute('data-yc-item'));
  const entry = (id) => drawer().querySelector(`.yc-dr-item[data-yc-item="${id}"]`);
  const pop = () => drawer().querySelector('.yc-dr');
  const panel = () => d.getElementById('ycLayoutEditor');
  const mb = () => panel().querySelector('.ymb-sec');
  const rowOf = (name) => [...mb().querySelectorAll('.ymb-row')].find((li) => li.querySelector('.yle-name').textContent === name);
  const act = (name, a) => rowOf(name).querySelector(`[data-act="${a}"]`);
  const openEditor = async (section = 'buttons') => { const ok = await w.ycLayoutEditor.open({ section }); await flush(); return ok; };
  const setVal = (id, v) => {
    const n = mb().querySelector('#ymb_' + id);
    n.value = v;
    n.dispatchEvent(new w.Event(n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const fill = (f) => {
    if (f.type) setVal('type', f.type);
    for (const k of ['label', 'icon', 'key', 'href', 'size']) if (f[k] != null) setVal(k, f[k]);
  };
  const form = () => mb().querySelector('.ymb-form');
  const refsShown = () => [...form().querySelectorAll('.ymb-ref')].map((li) => li.getAttribute('data-id'));
  const picker = () => form().querySelector('[data-field="refs"] .yle-picker');
  const pickable = () => [...picker().querySelectorAll('.yle-pick-item')].map((b) => b.getAttribute('data-id'));
  const pickRef = (id) => {
    if (picker().hidden) form().querySelector('[data-act="mb-ref-pick"]').click();
    picker().querySelector(`.yle-pick-item[data-id="${id}"]`).click();
  };
  const commit = () => mb().querySelector('[data-act="mb-commit"]').click();
  const fieldErr = (k) => mb().querySelector(`[data-err="${k}"]`).textContent;
  const save = async () => { panel().querySelector('.yle-save').click(); await flush(); };
  const dlg = () => d.getElementById('ycToolDialog');
  const homeTile = (id) => d.querySelector(`#tabHome [data-yc-shortcut="${id}"]`);
  const sbRow = (id) => d.querySelector(`#appSidebar [data-yc-shortcut="${id}"]`);
  return {
    w, d, server, errors, calls, opened, flush, key, down, press, drawer, isOpen, entries, entry, pop, panel, mb, rowOf, act,
    openEditor, setVal, fill, form, refsShown, picker, pickable, pickRef, commit, fieldErr, save, dlg, homeTile, sbRow,
    swal: (kind) => putSwal(kind), unswal: () => { swal.up = null; },
    tab: () => w.currentMainTabId(), close: () => w.close(),
  };
}
const CMD_CTRL = (k) => ({ key: k, code: 'Key' + k.toUpperCase(), ctrlKey: true, metaKey: true });
const BOX_HOME = { placed: { home: [{ item: 'user:box' }, { item: 'cases' }], sidebar: [{ item: 'user:box' }, { item: 'cases' }] } };

// ─────────────────────────────────────────────────────────────────────────
describe('the drawer menu (for real)', () => {
  let t;
  afterEach(() => t && t.close());

  test('it lists only the EFFECTIVE entries, in the drawer\'s order — hidden, denied, role-restricted, admin-gated, unknown and nested drawers drop out', () => {
    const other = DRAWER(['tasks'], { id: 'user:other', label: 'Other' });
    t = boot({ items: [VIEW, DRAWER(MIXED.concat('user:other')), other], layout: BOX_HOME });
    expect(t.w.ycLauncher.exec('user:box')).toBe(true);
    expect(t.isOpen()).toBe(true);
    expect(t.entries()).toEqual(MIXED_SHOWN);
    expect([...t.drawer().querySelectorAll('.yc-dr-item span')].map((s) => s.textContent)).toEqual(['Tasks', 'Payroll', 'My leads', 'Documents', 'Get Clio Code']);
    expect(t.drawer().querySelector('#ycDrawerTitle').textContent).toBe('My box');
    expect(t.drawer().querySelector('.yc-dr-empty')).toBe(null);
    expect(t.errors).toEqual([]);
  });

  test('choosing an entry closes the drawer and runs exec(entry): a firm link, a tab, a More panel, a view button', () => {
    t = boot({ items: [VIEW, DRAWER(MIXED)], layout: BOX_HOME });
    t.homeTile('user:box').click();
    t.entry('firm:payroll').click();
    expect(t.isOpen()).toBe(false);
    expect(t.opened).toEqual([['https://payroll.example.com/', '_blank', 'noopener']]);
    t.homeTile('user:box').click();
    t.entry('tasks').click();
    expect([t.isOpen(), t.tab()]).toEqual([false, 'tabTasks']);
    t.homeTile('user:box').click();
    t.entry('moreDocuments').click();
    expect([t.isOpen(), t.tab(), t.d.getElementById('tabMore').classList.contains('drill-active'), t.w.getComputedStyle(t.d.getElementById('documentsDiv')).display !== 'none']).toEqual([false, 'tabMore', true, true]);
    t.homeTile('user:box').click();
    t.entry('user:leads').click();
    expect([t.isOpen(), t.dlg().hidden, t.dlg().querySelector('iframe').getAttribute('src')]).toEqual([false, false, '/customView.html?key=lead_followups']);
  });

  test('Esc closes it and gives focus back to the opener; so does the × button; the first entry has focus while open', () => {
    t = boot({ items: [DRAWER(MIXED)], layout: BOX_HOME });
    const tile = t.homeTile('user:box');
    tile.focus();
    tile.click();
    expect(t.d.activeElement).toBe(t.entry('tasks'));
    const e = t.key(t.d.activeElement, { key: 'Escape' });
    expect([t.isOpen(), e.defaultPrevented, t.d.activeElement]).toEqual([false, true, tile]);
    tile.click();
    t.drawer().querySelector('.yc-dr-close').click();
    expect([t.isOpen(), t.d.activeElement]).toEqual([false, tile]);
    // a choice gives focus back too, before the entry runs (a tab takes none)
    tile.click();
    t.entry('firm:payroll').click();
    expect(t.d.activeElement).toBe(tile);
  });

  test('an outside press closes it and leaves focus where the user went; focus moving outside closes it; a press inside does not', () => {
    t = boot({ items: [DRAWER(MIXED)], layout: BOX_HOME });
    t.homeTile('user:box').click();
    t.down(t.entry('tasks'));
    t.down(t.drawer().querySelector('#ycDrawerTitle'));
    expect(t.isOpen()).toBe(true);
    t.down(t.d.getElementById('tabHome'));
    expect(t.isOpen()).toBe(false);
    t.homeTile('user:box').click();
    t.d.getElementById('outsideInput').focus();          // a pane's iframe taking focus is the same event
    expect([t.isOpen(), t.d.activeElement.id]).toEqual([false, 'outsideInput']);
  });

  test('a press on its own opener is a toggle: open → closed (not re-opened)', () => {
    t = boot({ items: [DRAWER(MIXED)], layout: BOX_HOME });
    const tile = t.homeTile('user:box');
    t.press(tile);
    expect(t.isOpen()).toBe(true);
    t.press(tile);
    expect(t.isOpen()).toBe(false);
    t.press(tile);
    expect(t.isOpen()).toBe(true);
    // a press on ANOTHER drawer opener (the sidebar row of the same drawer) re-opens it there
    t.press(t.sbRow('user:box'));
    expect(t.isOpen()).toBe(true);
  });

  test('review N1: keyboard activation of the opener always opens — a press dragged off the tile (no click) leaves no toggle behind', () => {
    t = boot({ items: [DRAWER(MIXED)], layout: BOX_HOME });
    const tile = t.homeTile('user:box');
    t.press(tile);
    expect(t.isOpen()).toBe(true);
    t.down(tile);                                         // pressed, then dragged off: closes, no click follows
    expect(t.isOpen()).toBe(false);
    tile.click();                                         // Enter / Space on the focused tile: a click with detail 0
    expect(t.isOpen()).toBe(true);
    // keyboard activation while it is open (no press first) re-opens it, never toggles
    tile.click();
    expect(t.isOpen()).toBe(true);
    // the pointer path still toggles
    t.press(tile);
    expect(t.isOpen()).toBe(false);
  });

  test('review N2: focus goes back to an opener that can take it (a tile); a sidebar row can\'t, so focus goes back where it was', () => {
    t = boot({ items: [DRAWER(MIXED)], layout: BOX_HOME });
    const inp = t.d.getElementById('outsideInput');
    inp.focus();
    const row = t.sbRow('user:box');
    row.click();                                          // (jsdom leaves focus on the input, as a shortcut would)
    expect(t.d.activeElement).toBe(t.entry('tasks'));
    t.key(t.d.activeElement, { key: 'Escape' });
    expect([t.isOpen(), t.d.activeElement === inp, t.d.activeElement === row]).toEqual([false, true, false]);
    // a choice too
    row.click();
    t.entry('firm:payroll').click();
    expect(t.d.activeElement).toBe(inp);
    // the Home tile (a button) does take it back
    const tile = t.homeTile('user:box');
    tile.click();
    t.drawer().querySelector('.yc-dr-close').click();
    expect(t.d.activeElement).toBe(tile);
  });

  test('keyboard: ↓ / ↑ wrap, Home / End, Tab cycles inside (entries and ×)', () => {
    t = boot({ items: [DRAWER(['tasks', 'firm:payroll', 'moreDocuments'])], layout: BOX_HOME });
    t.homeTile('user:box').click();
    const at = () => t.d.activeElement.getAttribute('data-yc-item') || t.d.activeElement.className;
    t.key(t.d.activeElement, { key: 'ArrowDown' }); expect(at()).toBe('firm:payroll');
    t.key(t.d.activeElement, { key: 'ArrowDown' }); expect(at()).toBe('moreDocuments');
    t.key(t.d.activeElement, { key: 'ArrowDown' }); expect(at()).toBe('tasks');
    t.key(t.d.activeElement, { key: 'ArrowUp' }); expect(at()).toBe('moreDocuments');
    t.key(t.d.activeElement, { key: 'Home' }); expect(at()).toBe('tasks');
    t.key(t.d.activeElement, { key: 'End' }); expect(at()).toBe('moreDocuments');
    const tab = t.key(t.d.activeElement, { key: 'Tab' });
    expect([tab.defaultPrevented, at()]).toEqual([true, 'yc-dr-close']);
    t.key(t.d.activeElement, { key: 'Tab' }); expect(at()).toBe('tasks');
    t.key(t.d.activeElement, { key: 'Tab', shiftKey: true }); expect(at()).toBe('yc-dr-close');
    t.key(t.d.activeElement, { key: 'Enter' });          // a native button: Enter is its click
    expect(t.isOpen()).toBe(true);
  });

  test('"Nothing here you can open": an empty drawer, and one whose every entry is ineffective', () => {
    t = boot({ items: [DRAWER([]), DRAWER(['moreViews', 'calendar', 'firm:secret', 'nope'], { id: 'user:none', label: 'None' })] });
    t.w.ycLauncher.exec('user:box');
    expect([t.entries(), t.drawer().querySelector('.yc-dr-empty').textContent]).toEqual([[], 'Nothing here you can open']);
    expect(t.d.activeElement.className).toBe('yc-dr-close');
    t.w.ycLauncher.exec('user:none');
    expect([t.entries(), t.drawer().querySelector('.yc-dr-empty').textContent]).toEqual([[], 'Nothing here you can open']);
  });

  test('escaping: the drawer\'s and the entries\' labels are text; an icon only from a valid slug (the custom tab\'s too)', () => {
    const hostile = '<img src=x onerror="window.__pwn=1">';
    t = boot({ items: [DRAWER(['custom', 'firm:payroll'], { label: 'Box ' + hostile.slice(0, 30) })],
      ro: { ...RO, renames: { tasks: { label: hostile.slice(0, 40) } } },
      access: { ...ACCESS, customTab: { src: '/x.html', title: hostile, icon: 'x" onmouseover="window.__pwn=1' } } });
    t.w.ycLauncher.exec('user:box');
    expect(t.drawer().querySelector('#ycDrawerTitle').textContent).toBe('Box ' + hostile.slice(0, 30));
    expect(t.entry('custom').querySelector('span').textContent).toBe(hostile);
    expect(t.entry('custom').querySelector('i').className).toBe('fa-solid fa-circle-question');
    expect(t.drawer().querySelector('img')).toBe(null);
    expect(t.w.__pwn).toBeUndefined();
  });

  test('it stands down: not opened while the layout editor or a SweetAlert dialog is open (a toast does not count); while open it leaves keys to a dialog and to the palette', async () => {
    t = boot({ items: [DRAWER(MIXED)], layout: BOX_HOME });
    await t.openEditor('layout');
    expect(t.w.ycLauncher.exec('user:box')).toBe(false);
    expect(t.isOpen()).toBe(false);
    t.w.ycLayoutEditor.close();
    t.swal('dialog');
    expect(t.w.ycLauncher.exec('user:box')).toBe(false);
    expect(t.isOpen()).toBe(false);
    t.unswal();
    t.swal('toast');
    expect(t.w.ycLauncher.exec('user:box')).toBe(true);
    t.unswal();
    // open, then a dialog comes up: Esc and presses are the dialog's
    t.swal('dialog');
    const esc = t.key(t.d.activeElement, { key: 'Escape' });
    t.down(t.d.getElementById('tabHome'));
    expect([t.isOpen(), esc.defaultPrevented]).toEqual([true, false]);
    t.unswal();
    // the palette over it: its keys are the palette's
    t.w.ycAll.open(t.d);
    expect(t.w.ycAll.isOpen()).toBe(true);
    const e2 = t.key(t.d.body, { key: 'Escape' });
    expect([t.isOpen(), e2.defaultPrevented]).toEqual([true, false]);
    t.w.ycAll.close(false);
    expect(t.errors.filter((m) => !/not opened: a dialog or the layout editor is open/.test(m))).toEqual([]);
  });

  test('one drawer at a time; exec of anything else closes it first', () => {
    t = boot({ items: [DRAWER(['tasks']), DRAWER(['firm:payroll'], { id: 'user:two', label: 'Two' })] });
    t.w.ycLauncher.exec('user:box');
    t.w.ycLauncher.exec('user:two');
    expect(t.d.querySelectorAll('#ycDrawer').length).toBe(1);
    expect([t.drawer().querySelector('#ycDrawerTitle').textContent, t.entries()]).toEqual(['Two', ['firm:payroll']]);
    t.w.ycLauncher.exec('tasks');
    expect([t.isOpen(), t.tab()]).toEqual([false, 'tabTasks']);
  });

  test('applyAccess re-draws an open drawer from the new registry, and closes it when the drawer itself is gone', () => {
    t = boot({ items: [DRAWER(['tasks', 'firm:payroll'])] });
    t.w.ycLauncher.exec('user:box');
    t.w.ycLauncher.applyAccess({ denied: ['tasks'] });
    expect([t.isOpen(), t.entries()]).toEqual([true, ['firm:payroll']]);
    t.w.ycLauncher.applyAccess({ ui: { firm: { registry_overrides: J(RO) }, user: { items: { items: [] } } } });
    expect(t.isOpen()).toBe(false);
  });

  test('anchored: below a Home tile, beside a sidebar row, under the All tile clicked; centred with no opener (the palette, a shortcut)', () => {
    t = boot({ items: [DRAWER(['tasks'])], layout: BOX_HOME, shortcuts: { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'b' }, id: 'user:box' }] } });
    const rect = (el, r) => { el.getBoundingClientRect = () => ({ left: r.left, top: r.top, right: r.left + 100, bottom: r.top + 80, width: 100, height: 80 }); };
    const at = () => [t.pop().style.left, t.pop().style.top];
    rect(t.homeTile('user:box'), { left: 300, top: 120 });
    t.homeTile('user:box').click();
    expect(at()).toEqual(['300px', '206px']);             // under the tile (bottom 200 + 6)
    t.key(t.d.activeElement, { key: 'Escape' });
    rect(t.sbRow('user:box'), { left: 0, top: 150 });
    t.sbRow('user:box').click();
    expect(at()).toEqual(['106px', '150px']);             // to the right of the row (right 100 + 6)
    t.key(t.d.activeElement, { key: 'Escape' });
    t.w.openMainTab('tabAll');
    const tile = t.d.querySelector('#ycAllList .yc-all-item[data-yc-item="user:box"]');
    rect(tile, { left: 40, top: 300 });
    tile.click();
    expect(at()).toEqual(['40px', '386px']);
    t.key(t.d.activeElement, { key: 'Escape' });
    expect(t.d.activeElement).toBe(tile);
    // the palette: it closes before exec — no opener, centred near the top
    const centred = [Math.round((t.w.innerWidth - 0) / 2) + 'px', Math.round(t.w.innerHeight * 0.12) + 'px'];
    t.w.ycAll.open(t.d);
    const q = t.d.querySelector('#ycPalette .yc-pal-input');
    q.value = 'my box'; q.dispatchEvent(new t.w.Event('input'));
    t.key(q, { key: 'Enter' });
    expect([t.isOpen(), ...at()]).toEqual([true, ...centred]);
    t.key(t.d.activeElement, { key: 'Escape' });
    // a shortcut from a focused input: centred, and Esc gives the input its focus back
    const inp = t.d.getElementById('outsideInput');
    inp.focus();
    const e = t.key(inp, CMD_CTRL('b'));
    expect([e.defaultPrevented, t.isOpen(), ...at()]).toEqual([true, true, ...centred]);
    t.key(t.d.activeElement, { key: 'Escape' });
    expect(t.d.activeElement).toBe(inp);
  });

  test('at phone width it is a sheet: no inline position (the CSS pins it to the bottom over a backdrop)', () => {
    t = boot({ items: [DRAWER(['tasks'])], layout: BOX_HOME });
    t.w.matchMedia = (q) => ({ matches: q === '(max-width: 768px)', media: q });
    t.homeTile('user:box').click();
    expect([t.isOpen(), t.pop().style.left, t.pop().style.top]).toEqual([true, '', '']);
    // the shell's CSS: the sheet rules live in its drawer block
    const css = RAW.slice(RAW.indexOf('/* A drawer\'s menu (ui-custom S5b'), RAW.indexOf('</style>', RAW.indexOf('/* A drawer\'s menu (ui-custom S5b')));
    expect(css).toMatch(/@media \(max-width: 768px\) \{[\s\S]*#ycDrawer \.yc-dr-back \{ display: block;[\s\S]*bottom: 0;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the editor: drawers in My buttons (for real)', () => {
  let t;
  afterEach(() => t && t.close());

  test('make a drawer: kind Drawer, its contents added from the picker (minus drawers and what it holds), ordered, removed; Save writes it', async () => {
    const other = DRAWER(['tasks'], { id: 'user:other', label: 'Other' });
    t = boot({ items: [VIEW, other] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ type: 'drawer', label: 'Daily', icon: 'box-open' });
    expect([t.form().querySelector('[data-field="refs"]').hidden, t.form().querySelector('[data-field="key"]').hidden,
      t.form().querySelector('[data-field="href"]').hidden, t.form().querySelector('[data-field="size"]').hidden]).toEqual([false, true, true, true]);
    t.form().querySelector('[data-act="mb-ref-pick"]').click();
    expect(t.picker().hidden).toBe(false);
    expect(t.pickable()).toEqual(expect.arrayContaining(['tasks', 'firm:payroll', 'firm:clio', 'user:leads', 'moreDocuments']));
    expect(t.pickable()).not.toContain('user:other');                  // a drawer never goes in a drawer
    expect(t.pickable()).not.toContain('moreViews');                   // nor anything this user can't see
    t.pickRef('tasks'); t.pickRef('user:leads'); t.pickRef('firm:clio');
    expect(t.pickable()).not.toContain('tasks');                       // already in it
    expect(t.refsShown()).toEqual(['tasks', 'user:leads', 'firm:clio']);
    t.form().querySelector('.ymb-ref[data-id="firm:clio"] [data-act="mb-ref-up"]').click();
    t.form().querySelector('.ymb-ref[data-id="tasks"] [data-act="mb-ref-del"]').click();
    expect(t.refsShown()).toEqual(['firm:clio', 'user:leads']);
    t.commit();
    const row = t.rowOf('Daily');
    expect(row.querySelector('.ymb-sum').textContent).toBe('Drawer · 2 items');
    expect([...t.rowOf('My leads').querySelectorAll('.yle-tag')].map((x) => x.textContent)).toEqual(['In “Daily”']);
    await t.save();
    const doc = t.server.puts[0].body.config;
    expect(doc.items[2]).toEqual({ id: 'user:daily', label: 'Daily', icon: 'box-open', action: { type: 'drawer', items: ['firm:clio', 'user:leads'] } });
    expect(shape.validate('user', 'items', doc).ok).toBe(true);
    expect(t.w.ycLauncher.exec('user:daily')).toBe(true);
    expect(t.entries()).toEqual(['firm:clio', 'user:leads']);
  });

  test('edit a drawer: the form shows its contents; a new unsaved button can go in it; an Unavailable one is kept and removable', async () => {
    t = boot({ items: [DRAWER(['tasks', 'moreViews'])] });
    await t.openEditor();
    t.act('My box', 'mb-edit').click();
    expect(t.refsShown()).toEqual(['tasks', 'moreViews']);
    expect(t.form().querySelector('.ymb-ref[data-id="moreViews"] .yle-tag').textContent).toBe('Unavailable');
    t.mb().querySelector('[data-act="mb-cancel"]').click();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ type: 'url', label: 'Court site', icon: 'gavel', href: 'https://ecf.example.gov/' });
    t.commit();
    t.act('My box', 'mb-edit').click();
    t.pickRef('user:court-site');
    t.form().querySelector('.ymb-ref[data-id="moreViews"] [data-act="mb-ref-del"]').click();
    t.commit();
    await t.save();
    expect(t.server.puts[0].body.config.items[0].action).toEqual({ type: 'drawer', items: ['tasks', 'user:court-site'] });
  });

  test('one level deep in the form: a button a drawer holds can\'t become a drawer; a drawer can\'t take a drawer; 30 at most', async () => {
    t = boot({ items: [VIEW, DRAWER(['user:leads'])] });
    await t.openEditor();
    t.act('My leads', 'mb-edit').click();
    t.fill({ type: 'drawer' });
    t.commit();
    expect(t.fieldErr('type')).toMatch(/inside the drawer “My box”: a drawer can’t go inside a drawer/);
    // converting it would also never offer itself in the picker
    t.form().querySelector('[data-act="mb-ref-pick"]').click();
    expect(t.pickable()).not.toContain('user:leads');
    expect(t.pickable()).not.toContain('user:box');
    t.mb().querySelector('[data-act="mb-cancel"]').click();
    // the core refuses a drawer ref outright (the picker never offers one)
    const p = t.w.ycLayoutEditor.itemSession({ stored: { items: [DRAWER(['tasks']), DRAWER([], { id: 'user:b2' })] }, clean: t.w.ycLauncher.cleanUserItem });
    expect(p.update(1, { label: 'B2', icon: 'box', type: 'drawer', refs: ['user:box'] }).problems.refs).toBe('A drawer can’t hold another drawer');
    expect(p.update(1, { label: 'B2', icon: 'box', type: 'drawer', refs: ['user:b2'] }).problems.refs).toBe('A drawer can’t hold itself');
    expect(p.update(1, { label: 'B2', icon: 'box', type: 'drawer', refs: ['tasks', 'tasks'] }).problems.refs).toBe('Each item can be in the drawer once');
    const many = Array.from({ length: 31 }, (_, i) => 'item' + i);
    expect(p.update(1, { label: 'B2', icon: 'box', type: 'drawer', refs: many }).problems.refs).toBe('A drawer holds at most 30 items');
    expect(p.update(1, { label: 'B2', icon: 'box', type: 'drawer', refs: many.slice(0, 30) }).ok).toBe(true);
  });

  test('the drawer form\'s Add turns off at 30, and says so', async () => {
    const ids = ['cases', 'contacts', 'appts', 'events', 'tasks', 'comms', 'log', 'bills', 'pipeline', 'newClient', 'moreManuals', 'moreSettings',
      'moreTheme', 'moreFeatureRequests', 'moreSimpleForms', 'moreFormBuilder', 'moreFormInbox', 'morePortalManager', 'moreSignatures',
      'moreAssetManager', 'moreVideoManager', 'moreDocuments', 'moreCaseConfig', 'moreChecklists', 'moreAvailability', 'moreBooking',
      'moreCourtPreview', 'moreCampaigns', 'moreRedirects'];
    t = boot({ items: [DRAWER(ids)] });
    await t.openEditor();
    t.act('My box', 'mb-edit').click();
    expect(t.form().querySelector('[data-act="mb-ref-pick"]').disabled).toBe(false);
    t.pickRef('moreLandingPages');
    expect([t.refsShown().length, t.form().querySelector('[data-act="mb-ref-pick"]').disabled, t.picker().hidden,
      t.form().querySelector('.ymb-refs-room').textContent]).toEqual([30, true, true, 'The drawer is full (30 items).']);
  });

  test('a new button\'s id freezes once a drawer holds it; a new button never takes an id a drawer names', async () => {
    t = boot({ items: [DRAWER(['user:ghost'])] });
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ type: 'url', label: 'Ghost', icon: 'ghost', href: 'https://x.example/' });
    t.commit();
    expect(t.rowOf('Ghost').getAttribute('data-id')).toBe('user:ghost-2');    // user:ghost is named by the drawer
    t.act('My box', 'mb-edit').click();
    t.pickRef('user:ghost-2');
    t.commit();
    t.act('Ghost', 'mb-edit').click();
    t.fill({ label: 'Renamed' });
    t.commit();
    expect(t.rowOf('Renamed').getAttribute('data-id')).toBe('user:ghost-2');  // frozen: the drawer holds it
  });

  test('delete cascades into drawers: the prompt names the drawer, the drawer lets go, the saved document names it nowhere', async () => {
    t = boot({ items: [VIEW, LINK, DRAWER(['user:leads', 'tasks']), DRAWER(['user:leads'], { id: 'user:two', label: 'Two' })] });
    const asked = [];
    t.w.Swal.fire = (o) => { asked.push(o.text); return Promise.resolve({ isConfirmed: true }); };
    await t.openEditor();
    t.act('My leads', 'mb-del').click();
    await t.flush();
    expect(asked).toEqual(['Delete “My leads”? Note: it’s in your drawers “My box”, “Two”. Deleting it takes it off there too.']);
    expect(t.rowOf('My box').querySelector('.ymb-sum').textContent).toBe('Drawer · 1 item');
    expect(t.rowOf('Two').querySelector('.ymb-sum').textContent).toBe('Drawer · empty');
    await t.save();
    expect(JSON.stringify(t.server.puts[0].body.config)).not.toMatch(/user:leads/);
    expect(t.server.user().items.retired).toEqual(['user:leads']);
  });

  test('the open form follows its own row when another row is deleted or moved (and a drawer being edited lets go of a deleted button)', async () => {
    t = boot({ items: [LINK, VIEW, DRAWER(['user:court', 'user:leads'])] });
    await t.openEditor();
    t.act('My box', 'mb-edit').click();
    t.act('Court site', 'mb-del').click();                // in a drawer: asks (the stand-in says yes)
    await t.flush();
    expect(t.refsShown()).toEqual(['user:leads']);
    t.act('My leads', 'mb-down').click();                 // swaps with the drawer being edited
    t.fill({ label: 'Box renamed' });
    t.commit();
    expect(t.rowOf('Box renamed').getAttribute('data-id')).toBe('user:box');
    expect(t.rowOf('My leads').getAttribute('data-id')).toBe('user:leads');
  });

  test('review S1: the open form follows its OWN row when that row is moved (↑ / ↓), and when a row above it is deleted', async () => {
    t = boot({ items: [LINK, VIEW, DRAWER(['tasks'])] });
    await t.openEditor();
    const ids = () => [...t.mb().querySelectorAll('.ymb-row')].map((li) => [li.getAttribute('data-id'), li.querySelector('.yle-name').textContent]);
    t.act('My leads', 'mb-edit').click();                 // row 1
    t.act('My leads', 'mb-up').click();                   // its own row moves to 0
    t.fill({ label: 'Edited' });
    t.commit();
    expect(ids()).toEqual([['user:leads', 'Edited'], ['user:court', 'Court site'], ['user:box', 'My box']]);
    t.act('Edited', 'mb-edit').click();                   // row 0
    t.act('Edited', 'mb-down').click();                   // its own row moves to 1
    t.fill({ label: 'Edited twice' });
    t.commit();
    expect(ids()).toEqual([['user:court', 'Court site'], ['user:leads', 'Edited twice'], ['user:box', 'My box']]);
    // delete a row ABOVE the open form (not placed, bound or in a drawer: no question asked)
    t.act('My box', 'mb-edit').click();                   // row 2
    t.act('Court site', 'mb-del').click();                // row 0 goes; the form's row is now 1
    await t.flush();
    t.fill({ label: 'Box renamed' });
    t.commit();
    expect(ids()).toEqual([['user:leads', 'Edited twice'], ['user:box', 'Box renamed']]);
  });

  test('a drawer is placeable and bindable like any button: the Home picker and the shortcut picker offer it', async () => {
    t = boot({ items: [DRAWER(['tasks'])] });
    await t.openEditor('layout');
    t.panel().querySelector('.yle-sec[data-sf="home"] [data-act="pick"]').click();
    expect(t.panel().querySelector('.yle-sec[data-sf="home"] .yle-pick-item[data-id="user:box"]')).not.toBe(null);
    t.panel().querySelector('.yle-tab[data-pane="shortcuts"]').click();
    t.panel().querySelector('.ysc-sec [data-act="sc-open"]').click();
    expect(t.panel().querySelector('.ysc-sec .yle-pick-item[data-id="user:box"]')).not.toBe(null);
  });

  test('Esc in the drawer picker closes the picker, not the form; Enter in its search adds the top hit', async () => {
    t = boot({ items: [DRAWER([])] });
    await t.openEditor();
    t.act('My box', 'mb-edit').click();
    t.form().querySelector('[data-act="mb-ref-pick"]').click();
    const q = t.picker().querySelector('.yle-pick-q');
    q.value = 'tasks'; q.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    t.key(q, { key: 'Enter' });
    expect([t.refsShown(), t.form().hidden]).toEqual([['tasks'], false]);
    t.key(t.picker().querySelector('.yle-pick-q'), { key: 'Escape' });
    expect([t.picker().hidden, t.form().hidden, t.panel().hidden]).toEqual([true, false, false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the round trip', () => {
  let t;
  afterEach(() => t && t.close());

  test('a drawer created, placed on Home, saved — opened from its tile, an entry launched — no reload', async () => {
    t = boot({ items: [VIEW] });
    const marker = t.w.__noReload = {};
    await t.openEditor();
    t.mb().querySelector('[data-act="mb-open"]').click();
    t.fill({ type: 'drawer', label: 'Daily', icon: 'box-open' });
    t.pickRef('user:leads'); t.pickRef('firm:payroll'); t.pickRef('tasks');
    t.commit();
    t.act('Daily', 'mb-home').click();
    await t.save();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['items', 'layout']);
    for (const p of t.server.puts) expect(shape.validate('user', p.body.config_key, p.body.config).ok).toBe(true);
    expect(t.panel().hidden).toBe(true);
    const tile = t.homeTile('user:daily');
    expect([tile.textContent, tile.querySelector('i').className]).toEqual(['Daily', 'fa-solid fa-box-open fa-2xl']);
    t.w.openMainTab('tabHome');
    t.press(tile);
    expect(t.entries()).toEqual(['user:leads', 'firm:payroll', 'tasks']);
    t.entry('user:leads').click();
    expect([t.isOpen(), t.dlg().hidden, t.dlg().querySelector('iframe').getAttribute('src')]).toEqual([false, false, '/customView.html?key=lead_followups']);
    expect(t.w.__noReload).toBe(marker);
    expect(t.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the pure core', () => {
  test('itemSession with drawers: random edit sequences always write a document the real validator accepts', () => {
    const ctx = vm.createContext({ console: { error() {}, warn() {} }, URL });
    ctx.window = ctx;
    vm.runInContext(ICON_SRC, ctx);
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    vm.runInContext(YCALL_SRC, ctx);
    vm.runInContext(EDITOR_SRC, ctx);
    const L = ctx.window.ycLauncher, E = ctx.window.ycLayoutEditor;
    let seed = 0xD7A3E5;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    let accepted = 0;
    for (let run = 0; run < 200; run++) {
      const s = E.itemSession({ stored: { items: [VIEW, DRAWER(['tasks', 'user:leads'])] }, clean: L.cleanUserItem, refs: () => ({}), pickers: null });
      for (let step = 0; step < 25; step++) {
        const ids = s.ids();
        const refs = Array.from({ length: Math.floor(rnd() * 5) }, () => pick(ids.concat(['tasks', 'firm:payroll', 'cases', 'cases'])));
        const f = { label: pick(['Box', 'Leads', 'x', '']), icon: pick(['box', 'star', 'Bad']), type: pick(['drawer', 'drawer', 'view', 'url']),
          key: 'lead_followups', href: 'https://x.example/', size: 'large', refs };
        const op = pick(['add', 'update', 'update', 'remove', 'move', 'dropRef']);
        const n = ids.length;
        let r = null;
        if (op === 'add') r = s.add(f);
        else if (op === 'update' && n) r = s.update(Math.floor(rnd() * n), f);
        else if (op === 'remove' && n) { const id = s.remove(Math.floor(rnd() * n)); s.dropRef(id); }
        else if (op === 'move' && n) s.move(Math.floor(rnd() * n), pick([-1, 1]));
        else if (op === 'dropRef' && n) s.dropRef(pick(ids));
        if (r && r.ok) accepted++;
        const doc = J(s.doc());
        const v = shape.validate('user', 'items', doc);
        if (!v.ok) throw new Error('invalid at run ' + run + ' step ' + step + ' (' + op + '): ' + v.errors.join(' | '));
        expect(E.canonical(v.value.items)).toBe(E.canonical(doc.items));
      }
    }
    expect(accepted).toBeGreaterThan(200);
  });
});
