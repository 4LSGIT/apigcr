// tests/launcherS6c5editor.test.js
//
/**
 * ui-custom S6c-5 — the editors' side of pages: the Page kind, Arrange…, the
 * delete cascade, the drawer renamed "List", the firm mode's Firm pages pane
 * and firm.html's Page kind (S6c_DESIGN §4.5, §5 S6c-5).
 *
 *   1. THE CORE (ycLayoutEditor.session, pure, in a bare vm over the page's
 *      REAL ycLauncher): a page is two pseudo-surfaces (pageSf(id, 'tiles') /
 *      'icons') with the surface calls — view, candidates (never the page
 *      itself), move, remove, add, addBreak (tiles only), room, mode — and no
 *      hide / reset; the document round-trips and validates at BOTH scopes;
 *      a non-effective item is carried unseen; edited back to stored is
 *      stored; dropId cascades (the page's own entry, the id off every other
 *      page); retarget takes a new page set; dirtyParts splits the dots; a
 *      seeded fuzz over pages + surfaces validates every document, and the
 *      SHELL (jsdom, the real renderer) draws exactly what the editor showed.
 *   2. THE USER PANEL, for real (jsdom, the real uiConfigService on the
 *      in-memory store): kind Page in the form (no key / size / address /
 *      list fields; a hint), the row's Arrange… opens the page's two sections
 *      (Tiles, Small buttons: no Reset, no Hidden box), tiles added from the
 *      picker (two panels, the tab button, a List, a break), icons; Save →
 *      items then layout with `pages`, the shell builds the page tab; the
 *      word "drawer" is nowhere the user reads ("List"); deleting the page
 *      drops its entry (the prompt says so, the box closes); deleting a
 *      button on a page takes it off the page (the prompt names the page);
 *      the dots: a page's tiles light My buttons, not Home or Sidebar.
 *   3. THE FIRM MODE: the fourth tab, Firm pages — a note when the firm has
 *      none; one block per firm page with its two sections; open({ section:
 *      'pages', page }) lands on that block; an arrangement is ONE PUT whose
 *      `pages` the shell repaints into a page tab; a 400 naming
 *      pages.<id>.<part> lands under that section.
 *   4. FIRM.HTML (three frames): kind Page in a firm item's "Opens"; the row's
 *      "Arrange its tiles…" (disabled until saved) opens the top editor on the
 *      page's block; the saved action is exactly { type:'page' }; Who sees
 *      what lists the page; History's View names the page's rows.
 *
 * Mutation-checked (see local/ui-custom/S6c5_worker_report.md).
 *
 * Run:  npx jest tests/launcherS6c5editor.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { rawShellHtml } = require('./helpers/shellHtml');
const { makeStore } = require('./helpers/uiConfigStore');
const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');
const CCM_HTML = fs.readFileSync(path.join(ROOT, 'public/caseConfigManager.html'), 'utf8');
const FIRM_HTML = fs.readFileSync(path.join(ROOT, 'public/caseconfig/firm.html'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];

const J = (x) => JSON.parse(JSON.stringify(x));
function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS6c5editor: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const STYLES = [...RAW.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const EGG_CSS = (() => { const h = STYLES.filter((s) => s.includes('.home-egg-row')); if (h.length !== 1) throw new Error('egg css'); return h[0]; })();

const FIRM_SURFACES = ['home', 'sidebar', 'homeIcons', 'more', 'moreIcons', 'admin', 'adminIcons'];
const CLIO = { id: 'firm:clio-code', label: 'Get Clio Code', icon: 'key', action: { type: 'url', href: 'https://clio.example.com/code', present: 'window' } };
const OPS = { id: 'firm:ops', label: 'Operations', icon: 'layer-group', action: { type: 'page' } };
const RO = { items: [CLIO, OPS], hidden: [], locked: [], renames: {} };
const key = (r) => (r.kind === 'item' ? r.id : r.kind === 'label' ? '#' + r.text : '|');

// ── 1. the core, in a bare vm ──────────────────────────────────────────────
function core() {
  const ctx = vm.createContext({ URL, console: { error: (m) => { throw new Error(String(m)); }, warn() {} } });
  ctx.window = ctx;
  vm.runInContext(ICON_SRC, ctx, { filename: 'ycIcon.js' });
  vm.runInContext(REGISTRY_SRC, ctx, { filename: 'featureRegistry.js' });
  vm.runInContext(RENDERER_SRC, ctx, { filename: 'index.html#ycLauncher' });
  vm.runInContext(EDITOR_SRC, ctx, { filename: 'ycLayoutEditor.js' });
  return { L: ctx.window.ycLauncher, E: ctx.window.ycLayoutEditor, REG: ctx.window.FEATURE_REGISTRY, LAY: J(ctx.window.DEFAULT_LAYOUTS) };
}
const { L: VL, E: VE, REG, LAY } = core();
const P = VE.pageSf;
const MINE = { items: [
  { id: 'user:desk', label: 'My desk', icon: 'desktop', action: { type: 'page' } },
  { id: 'user:box', label: 'My box', icon: 'box-open', action: { type: 'drawer', items: ['cases'] } },
  { id: 'user:leads-tab', label: 'Leads tab', icon: 'table-list', action: { type: 'view', key: 'lead_followups', present: 'tab' } },
] };
const EFF = J(VL.computeEffective({ isAdmin: true, roles: ['su'], denied: [], ui: { firm: { registry_overrides: RO }, user: { items: MINE } } }));
const userSess = (stored, o = {}) => VE.session({ stored, effective: EFF, locked: [], base: LAY, registry: REG, groups: EFF.groups, pages: ['user:desk'], ...o });
const viewKeys = (s, sf) => J(s.view(sf)).map(key);
const okUser = (doc) => { const r = shape.validate('user', 'layout', J(doc)); return { ok: r.ok, errors: r.errors, same: r.ok && shape.canonical(r.value) === shape.canonical(J(doc)) }; };
const okFirm = (doc) => { const r = shape.validate('firm', 'layout', J(doc)); return { ok: r.ok, errors: r.errors, same: r.ok && shape.canonical(r.value) === shape.canonical(J(doc)) }; };

describe('1. the core: a page is two pseudo-surfaces', () => {
  const T = P('user:desk', 'tiles'), I = P('user:desk', 'icons');
  const STORED = { placed: {}, removed: {}, pages: { 'user:desk': { tiles: [{ item: 'moreAutomations' }, { break: true }, { item: 'adminUsers' }, { item: 'gone' }], icons: [{ item: 'casey' }] } } };

  test('pageSf / PAGE_PARTS; the stored page is the view (effective items, breaks on the tiles); no hide, no reset, nothing hidden', () => {
    expect(P('user:x', 'tiles')).toBe('page:user:x:tiles');
    expect(J(VE.PAGE_PARTS)).toEqual(J(shape.PAGE_PARTS));
    const s = userSess(STORED);
    expect(viewKeys(s, T)).toEqual(['moreAutomations', '|', 'adminUsers']);               // 'gone' is not effective: unseen, kept
    expect(viewKeys(s, I)).toEqual(['casey']);
    const v = J(s.view(T));
    expect(v[0]).toMatchObject({ kind: 'item', id: 'moreAutomations', label: 'Automations', base: false, locked: false, always: false, firm: false, act: 'remove' });
    expect(v[1]).toEqual({ kind: 'break', act: 'remove' });
    expect([s.mode(T), s.mode(I), s.isDirty(), J(s.hidden(T)), s.hide(T, 0), s.reset(T), s.setLabel(T, 0, 'x'), s.addBreak(I)]).toEqual(['stored', 'stored', false, [], false, false, false, false]);
    expect([s.room(T), s.room(I)]).toEqual([100 - 4, 12 - 1]);
    expect(J(s.doc())).toEqual(STORED);
    expect(J(s.pages())).toEqual(['user:desk']);
  });

  test('move / remove / add / addBreak write the page; a non-effective item rides along (carry); edited back to stored is stored; the document validates at scope user', () => {
    const s = userSess(STORED);
    expect(s.move(T, 0, 1)).toBe(true);
    expect([viewKeys(s, T), s.mode(T), s.isDirty()]).toEqual([['|', 'moreAutomations', 'adminUsers'], 'edited', true]);
    expect(J(s.doc()).pages['user:desk'].tiles).toEqual([{ break: true }, { item: 'moreAutomations' }, { item: 'adminUsers' }, { item: 'gone' }]);
    expect(J(s.dirtyParts())).toEqual({ surfaces: false, pages: true });
    expect(s.move(T, 1, -1)).toBe(true);
    expect([s.mode(T), s.isDirty()]).toEqual(['stored', false]);
    expect(s.remove(T, 1)).toBe(true);                                                   // the break
    expect(s.add(T, 'user:box')).toBe(true);
    expect(s.add(T, 'user:box')).toBe(false);                                            // once
    expect(s.add(T, 'user:desk')).toBe(false);                                           // never itself
    expect(s.add(T, 'nope')).toBe(false);                                                // not effective
    expect(s.addBreak(T)).toBe(true);
    expect(s.add(I, 'all')).toBe(true);
    expect(s.add(I, 'moreReports')).toBe(true);
    expect(viewKeys(s, T)).toEqual(['moreAutomations', 'adminUsers', 'user:box', '|']);
    expect(viewKeys(s, I)).toEqual(['casey', 'all', 'moreReports']);
    const doc = J(s.doc());
    expect(doc.pages['user:desk']).toEqual({ tiles: [{ item: 'moreAutomations' }, { item: 'adminUsers' }, { item: 'gone' }, { item: 'user:box' }, { break: true }], icons: [{ item: 'casey' }, { item: 'all' }, { item: 'moreReports' }] });
    expect(okUser(doc)).toEqual({ ok: true, errors: [], same: true });
    expect(J(s.pagesHolding('user:box'))).toEqual(['user:desk']);
    expect(J(s.pagesHolding('all'))).toEqual(['user:desk']);
    expect(J(s.pagesHolding('cases'))).toEqual([]);
    // the candidates never offer the page itself nor what is on the part
    const cand = J(s.candidates(T, '')).flatMap((g) => g.items).map((i) => i.id);
    expect(cand).not.toContain('user:desk');
    expect(cand).not.toContain('user:box');
    expect(cand).toContain('cases');
    expect(J(s.candidates(T, 'desk')).flatMap((g) => g.items).map((i) => i.id)).not.toContain('user:desk');
  });

  test('caps: a page\'s tiles hold 100, its icons 12 — room says so and add refuses past it', () => {
    const s = userSess({ placed: {}, removed: {} });
    const ids = EFF.map((e) => e.id).filter((id) => id !== 'user:desk');
    let n = 0;
    for (const id of ids) { if (n >= 12) break; expect(s.add(I, id)).toBe(true); n++; }
    expect([s.room(I), s.add(I, ids[12])]).toEqual([0, false]);
    expect(okUser(s.doc()).ok).toBe(true);
  });

  test('a page with nothing stored and nothing edited writes no entry; an edited one writes only the lists it has; stored pages: {} round-trips', () => {
    const s = userSess({ placed: {}, removed: {} });
    expect(J(s.doc())).toEqual({ placed: {}, removed: {} });
    expect(s.add(I, 'all')).toBe(true);
    expect(J(s.doc())).toEqual({ placed: {}, removed: {}, pages: { 'user:desk': { icons: [{ item: 'all' }] } } });
    expect(s.remove(I, 0)).toBe(true);
    expect(J(s.doc())).toEqual({ placed: {}, removed: {}, pages: { 'user:desk': { icons: [] } } });   // edited: an empty list is the page's
    expect(s.isDirty()).toBe(true);
    const e = userSess({ placed: {}, removed: {}, pages: {} });
    expect([J(e.doc()), e.isDirty()]).toEqual([{ placed: {}, removed: {}, pages: {} }, false]);
    // a stored page whose item is not one of the session's pages rides through as stored
    const o = userSess({ placed: {}, removed: {}, pages: { 'user:old': { tiles: [{ item: 'cases' }] } } });
    expect([J(o.doc()).pages, o.isDirty()]).toEqual([{ 'user:old': { tiles: [{ item: 'cases' }] } }, false]);
  });

  test('dropId cascades: the deleted page\'s entry goes; a deleted button leaves every page; retarget takes a new page set', () => {
    const stored = { placed: { home: [{ item: 'user:box' }] }, removed: {}, pages: {
      'user:desk': { tiles: [{ item: 'user:box' }, { item: 'cases' }], icons: [{ item: 'user:box' }] },
      'user:p2': { tiles: [{ item: 'user:box' }, { item: 'user:desk' }] },
    } };
    const s = userSess(stored, { pages: ['user:desk', 'user:p2'] });
    expect(s.dropId('user:box')).toBe(true);
    const d1 = J(s.doc());
    expect(d1.placed.home).toEqual([]);                                                 // S5a's dropId: the placed list, minus the id
    expect(d1.pages['user:desk']).toEqual({ tiles: [{ item: 'cases' }], icons: [] });
    expect(d1.pages['user:p2']).toEqual({ tiles: [{ item: 'user:desk' }] });
    expect([s.mode(P('user:desk', 'tiles')), s.mode(P('user:p2', 'tiles')), s.isDirty()]).toEqual(['edited', 'edited', true]);
    expect(s.dropId('user:desk')).toBe(true);
    const d2 = J(s.doc());
    expect(d2.pages).toEqual({ 'user:p2': { tiles: [] } });
    expect(J(s.pages())).toEqual(['user:p2']);
    expect(okUser(d2).ok).toBe(true);
    // a new page button before Save: retarget brings it in; its sections work; it writes once edited
    const eff2 = EFF.concat([{ id: 'user:new', group: 'Mine', label: 'New', labels: ['New'], icon: 'star', page: true }]);
    expect(s.retarget(eff2, EFF.groups, ['user:p2', 'user:new'])).toBe(true);
    expect(J(s.pages())).toEqual(['user:p2', 'user:new']);
    expect(s.add(P('user:new', 'tiles'), 'cases')).toBe(true);
    expect(J(s.doc()).pages['user:new']).toEqual({ tiles: [{ item: 'cases' }] });
    // the dropped page never comes back through retarget
    expect(s.retarget(eff2, EFF.groups, ['user:desk', 'user:p2', 'user:new'])).toBe(true);
    expect(J(s.pages())).toEqual(['user:p2', 'user:new']);
    expect(J(s.doc()).pages['user:desk']).toBeUndefined();
  });

  test('the firm tier: the same core over firm:… pages validates at scope firm; a firm page may hold a firm item but never a user button', () => {
    const cat = J(VE.firmCatalog({ firm: { registry_overrides: RO } }));
    expect(cat.pages).toEqual(['firm:ops']);
    expect(cat.entries.find((e) => e.id === 'firm:ops').page).toBe(true);
    expect(cat.entries.find((e) => e.id === 'firm:clio-code')).not.toHaveProperty('page');
    const s = VE.session({ stored: null, effective: cat.entries, locked: [], base: LAY, registry: REG, groups: cat.groups, surfaces: FIRM_SURFACES, pass: [], seed: { more: cat.seed }, pages: cat.pages });
    const T2 = P('firm:ops', 'tiles');
    expect(s.add(T2, 'moreManuals')).toBe(true);
    expect(s.add(T2, 'firm:clio-code')).toBe(true);
    expect(s.add(T2, 'user:box')).toBe(false);                                           // not in the firm's catalogue
    expect(s.addBreak(T2)).toBe(true);
    expect(s.add(P('firm:ops', 'icons'), 'casey')).toBe(true);
    const doc = J(s.doc());
    expect(doc.pages['firm:ops']).toEqual({ tiles: [{ item: 'moreManuals' }, { item: 'firm:clio-code' }, { break: true }], icons: [{ item: 'casey' }] });
    expect(okFirm(doc)).toEqual({ ok: true, errors: [], same: true });
    expect(J(s.dirtyParts())).toEqual({ surfaces: false, pages: true });
    expect(J(s.view(T2))[1].firm).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The shell skeleton (as launcherS6c3's), with #ycPages and the stage.
const ADMIN = { type: 'jwt', userId: 1, roles: ['admin'] };
function shellPage() {
  const placedIds = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
  const grid = (sf) => placedIds(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabAll', 'tabUserItem']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  return `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}<style>${EGG_CSS}</style></head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <div class="home-egg-row"><script>ycLauncher.mount('homeIcons')</script></div></div>
    ${ALL_TAB}
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
}
const PAGE = shellPage();

async function boot({ store = makeStore(), canEdit = true, auth = ADMIN, access = { isAdmin: true, roles: ['su'], denied: [] } } = {}) {
  const errors = [];
  const dom = new JSDOM(PAGE, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.test/' });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\nvar user = { user: 1 };\n' +
    'window.ycButtonTabs = { open() { openMainTab("tabUserItem"); return true; }, sync() {}, active() { return null; } };\n';
  const stubs = new Set();
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(/.exec(it.onclick || '');
    if (!m || stubs.has(m[1]) || m[1] === 'openMainTab') continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  const api = store.apiFor(auth, { canEdit });
  w.apiSend = api;
  const toasts = [];
  w.Toast = { fire: (o) => { toasts.push(o.title); return Promise.resolve(); } };
  let answer = true;
  const asked = [];
  w.confirm = (t) => { asked.push(t); return answer; };
  const first = await api('/api/ui-config', 'GET');
  w.firmData = { ui: { firm: first.firm, user: first.user } };
  w.ycLauncher.applyAccess({ ...access, ui: w.firmData.ui });
  w.eval(YCALL_SRC);
  w.eval(EDITOR_SRC);
  const d = w.document;
  const L = w.ycLauncher;
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const panel = () => d.getElementById('ycLayoutEditor');
  const sec = (sf) => panel().querySelector(`.yle-sec[data-sf="${sf}"]`);
  const rowsOf_ = (sf) => [...sec(sf).querySelectorAll('.yle-rows > .yle-row')];
  const names = (sf) => rowsOf_(sf).map((li) => (li.classList.contains('yle-row-break') ? '|' : li.querySelector('.yle-name').textContent));
  const rowNamed = (sf, name) => rowsOf_(sf).find((li) => (li.querySelector('.yle-name') || {}).textContent === name);
  const click = (el) => { if (!el) throw new Error('no element to click'); el.click(); };
  const tab = (id) => click(panel().querySelector(`.yle-tab[data-pane="${id}"]`));
  const save = async () => { click(panel().querySelector('.yle-save')); await flush(); };
  const mb = () => panel().querySelector('.ymb-sec');
  const mbRow = (label) => [...mb().querySelectorAll('.ymb-row')].find((li) => li.querySelector('.yle-name').textContent === label);
  const setVal = (id, v) => { const i = mb().querySelector('#ymb_' + id); i.value = v; i.dispatchEvent(new w.Event(i.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const pick = (sf, id) => { click(sec(sf).querySelector('[data-act="pick"]')); click(sec(sf).querySelector(`.yle-pick-item[data-id="${id}"]`)); };
  const pageTab = (id) => d.querySelector(`#ycPages > [data-yc-page="${id}"]`);
  const pageTiles = (id) => { const pg = pageTab(id); const out = []; let brs = 0;
    for (let n = pg.querySelector('h1').nextElementSibling; n && !n.classList.contains('page-egg-row'); n = n.nextElementSibling) {
      if (n.tagName === 'BR') { if (++brs === 2) { out.push('|'); brs = 0; } continue; } brs = 0; out.push(n.getAttribute('data-yc-shortcut'));
    } return out; };
  const dot = (pane) => !panel().querySelector(`.yle-tab[data-pane="${pane}"] .yle-tab-dot`).hidden;
  return { w, d, L, store, api, errors, toasts, asked, answer: (v) => { answer = v; }, flush, panel, sec, names, rowNamed, click, tab, save, mb, mbRow, setVal, pick, pageTab, pageTiles, dot, close: () => w.close() };
}
const open = async (t, o) => { const ok = await t.w.ycLayoutEditor.open(o); await t.flush(); return ok; };
const seedFirm = async (store, items = [CLIO, OPS]) => {
  await svc.write(store.db, { scope: 'firm', config_key: 'registry_overrides', config: { hidden: [], locked: [], renames: {}, items } }, ADMIN);
  return store;
};
const seedUser = async (store, items, layout) => {
  await svc.write(store.db, { scope: 'user', config_key: 'items', config: items }, ADMIN);
  if (layout) await svc.write(store.db, { scope: 'user', config_key: 'layout', config: layout }, ADMIN);
  return store;
};

describe('1b. FUZZ: random edits over pages and surfaces — every document validates, and the shell draws exactly what the editor showed', () => {
  let t;
  afterEach(() => t && t.close());
  test('20 runs, two user pages + the firm\'s, both tiers', async () => {
    t = await boot({ store: await seedFirm(makeStore()) });
    let seedN = 5;
    const rnd = (n) => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN % n; };
    const items = { items: [
      { id: 'user:a', label: 'A', icon: 'star', action: { type: 'page' } }, { id: 'user:b', label: 'B', icon: 'star', action: { type: 'page' } },
      { id: 'user:box', label: 'Box', icon: 'box', action: { type: 'drawer', items: ['cases'] } },
    ] };
    const eff = J(t.L.computeEffective({ isAdmin: true, roles: ['su'], denied: [], ui: { firm: { registry_overrides: RO }, user: { items } } }));
    const cat = J(t.w.ycLayoutEditor.firmCatalog({ firm: { registry_overrides: RO } }));
    const ops = ['move', 'remove', 'add', 'break', 'add', 'add'];
    for (let run = 0; run < 20; run++) {
      const us = t.w.ycLayoutEditor.session({ stored: null, effective: eff, locked: [], base: LAY, registry: REG, groups: eff.groups, pages: ['user:a', 'user:b'] });
      const fsess = t.w.ycLayoutEditor.session({ stored: null, effective: cat.entries, locked: [], base: LAY, registry: REG, groups: cat.groups, surfaces: FIRM_SURFACES, pass: [], seed: { more: cat.seed }, pages: cat.pages });
      const sfs = [P('user:a', 'tiles'), P('user:a', 'icons'), P('user:b', 'tiles'), 'home', 'sidebar'];
      const fsfs = [P('firm:ops', 'tiles'), P('firm:ops', 'icons'), 'more', 'homeIcons'];
      for (let step = 0; step < 30; step++) {
        for (const [s, list] of [[us, sfs], [fsess, fsfs]]) {
          const sf = list[rnd(list.length)], n = s.view(sf).length, op = ops[rnd(ops.length)];
          if (op === 'move') s.move(sf, rnd(n + 1), rnd(2) ? 1 : -1);
          else if (op === 'remove') s.remove(sf, rnd(n + 1));
          else if (op === 'break') s.addBreak(sf);
          else { const c = J(s.candidates(sf, '')).flatMap((g) => g.items); if (c.length) s.add(sf, c[rnd(c.length)].id); }
        }
      }
      const udoc = J(us.doc()), fdoc = J(fsess.doc());
      expect([run, okUser(udoc)]).toEqual([run, { ok: true, errors: [], same: true }]);
      expect([run, okFirm(fdoc)]).toEqual([run, { ok: true, errors: [], same: true }]);
      // the shell: what the editor showed is what the pages draw
      t.L.applyAccess({ ui: { firm: { registry_overrides: RO, layout: fdoc }, user: { items, layout: udoc } } });
      for (const id of ['user:a', 'user:b']) expect([run, id, t.pageTiles(id)]).toEqual([run, id, J(us.view(P(id, 'tiles'))).map((r) => (r.kind === 'item' ? r.id : '|'))]);
      expect([run, t.pageTiles('firm:ops')]).toEqual([run, J(fsess.view(P('firm:ops', 'tiles'))).map((r) => (r.kind === 'item' ? r.id : '|'))]);
      expect([run, [...t.pageTab('firm:ops').querySelectorAll('.page-egg-row > *')].map((b) => b.getAttribute('data-yc-shortcut'))])
        .toEqual([run, J(fsess.view(P('firm:ops', 'icons'))).map((r) => r.id)]);
    }
    expect(t.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('2. the user panel, for real', () => {
  let t;
  afterEach(() => t && t.close());

  test('kind Page: the form shows a hint and no key / size / address / list fields; Add → a row with Arrange…; the word "drawer" is nowhere the user reads', async () => {
    t = await boot();
    await open(t, { section: 'buttons' });
    const types = [...t.mb().querySelectorAll('#ymb_type option')].map((o) => [o.value, o.textContent]);
    expect(types).toEqual([['view', 'A saved view'], ['tool', 'A tool'], ['url', 'A link to a website'], ['drawer', 'A list (a menu of other items)'], ['page', 'A page (a tab of tiles, like More Features)']]);
    t.click(t.mb().querySelector('[data-act="mb-open"]'));
    t.setVal('type', 'page');
    const hidden = (f) => t.mb().querySelector(`.ymb-form [data-field="${f}"]`).hidden;
    expect(['key', 'size', 'href', 'refs', 'page'].map(hidden)).toEqual([true, true, true, true, false]);
    expect(t.mb().querySelector('.ymb-form [data-field="page"]').textContent).toMatch(/A tab of your own, like More Features/);
    t.setVal('label', 'My desk');
    t.setVal('icon', 'desktop');
    t.click(t.mb().querySelector('[data-act="mb-commit"]'));
    const row = t.mbRow('My desk');
    expect(row.querySelector('.ymb-sum').textContent).toBe('Page · a tab of tiles');
    expect(row.querySelector('[data-act="mb-arrange"]').textContent.trim()).toBe('Arrange…');
    expect(t.mbRow('My desk').querySelector('.yle-tag').textContent).toBe('New');
    // the List wording
    t.setVal('type', 'drawer');
    expect(t.panel().textContent).not.toMatch(/drawer/i);
    expect(t.mb().querySelector('[data-field="refs"] .yc-flabel').textContent).toBe('In the list');
    expect(t.mb().querySelector('[data-act="mb-ref-pick"]').textContent.trim()).toBe('Add to the list');
    expect(t.errors).toEqual([]);
  });

  test('Arrange…: two sections (Tiles, Small buttons; no Reset, no Hidden box); tiles from the picker (two panels, the tab button, a List, a break) and icons; the dots; each button saves itself (L2), Save → the layout with pages; the shell builds the page', async () => {
    t = await boot({ store: await seedFirm(makeStore()) });
    await open(t, { section: 'buttons' });
    t.click(t.mb().querySelector('[data-act="mb-open"]'));
    t.setVal('type', 'drawer'); t.setVal('label', 'My box'); t.setVal('icon', 'box-open');
    t.click(t.mb().querySelector('[data-act="mb-commit"]'));
    await t.flush();                                      // each Add saves itself (L2)
    t.click(t.mb().querySelector('[data-act="mb-open"]'));
    t.setVal('type', 'view'); t.setVal('label', 'Leads tab'); t.setVal('icon', 'table-list'); t.setVal('size', 'tab');
    t.mb().querySelector('#ymb_key').appendChild(Object.assign(t.d.createElement('option'), { value: 'lead_followups', textContent: 'Leads' }));
    t.setVal('key', 'lead_followups');
    t.click(t.mb().querySelector('[data-act="mb-commit"]'));
    await t.flush();
    t.click(t.mb().querySelector('[data-act="mb-open"]'));
    t.setVal('type', 'page'); t.setVal('label', 'My desk'); t.setVal('icon', 'desktop');
    t.click(t.mb().querySelector('[data-act="mb-commit"]'));
    await t.flush();
    expect([t.dot('home') || t.dot('sidebar'), t.dot('buttons')]).toEqual([false, false]);   // all three saved
    expect(t.api.calls.filter((c) => c.method === 'PUT').map((c) => c.body.config_key)).toEqual(['items', 'items', 'items']);
    t.click(t.mbRow('My desk').querySelector('[data-act="mb-arrange"]'));
    const box = t.mb().querySelector('.ymb-arrange');
    expect(box.hidden).toBe(false);
    expect(box.querySelector('.ymb-arrange-title').textContent).toBe('Arrange “My desk”');
    const TS = P('user:my-desk', 'tiles'), IS = P('user:my-desk', 'icons');
    expect([...box.querySelectorAll('.yle-sec')].map((s) => [s.getAttribute('data-sf'), s.querySelector('h3').textContent])).toEqual([[TS, 'Tiles'], [IS, 'Small buttons']]);
    expect([t.sec(TS).querySelector('[data-act="reset"]'), t.sec(TS).querySelector('.yle-hidden'), t.sec(IS).querySelector('[data-act="add-break"]')]).toEqual([null, null, null]);
    expect(t.sec(TS).querySelector('[data-act="pick"]').textContent.trim()).toBe('Add a tile');
    expect(t.mbRow('My desk').querySelector('[data-act="mb-arrange"]').disabled).toBe(true);
    // the picker never offers the page itself
    t.click(t.sec(TS).querySelector('[data-act="pick"]'));
    expect([...t.sec(TS).querySelectorAll('.yle-pick-item')].map((b) => b.getAttribute('data-id'))).not.toContain('user:my-desk');
    t.click(t.sec(TS).querySelector('[data-act="pick-close"]'));
    t.pick(TS, 'moreAutomations');
    t.pick(TS, 'adminUsers');
    t.click(t.sec(TS).querySelector('[data-act="add-break"]'));
    t.pick(TS, 'user:leads-tab');
    t.pick(TS, 'user:my-box');
    t.pick(IS, 'casey');
    expect(t.names(TS)).toEqual(['Automations', 'Users', '|', 'Leads tab', 'My box']);
    expect(t.names(IS)).toEqual(['Casey']);
    expect(t.names(TS)).toEqual(t.names(TS));
    expect([...t.sec(TS).querySelectorAll('.yle-rows .yle-tag')].map((x) => x.textContent)).toEqual(['Added', 'Added', 'Added', 'Added']);
    expect([t.dot('home') || t.dot('sidebar'), t.dot('buttons')]).toEqual([false, true]);
    expect([...t.mbRow('My box').querySelectorAll('.ymb-where .yle-tag')].map((x) => x.textContent)).toEqual(['On “My desk”']);
    // the page button's id is permanent: it was saved when it was added
    t.click(t.mbRow('My desk').querySelector('[data-act="mb-edit"]'));
    t.setVal('label', 'Desk renamed');
    expect(t.mb().querySelector('.ymb-id-line').textContent).toBe('Its id is user:my-desk (permanent).');
    t.click(t.mb().querySelector('[data-act="mb-commit"]'));
    await t.flush();                                      // the rename saves itself; the arranged tiles wait for Save
    expect(box.querySelector('.ymb-arrange-title').textContent).toBe('Arrange “Desk renamed”');
    expect([t.dot('home') || t.dot('sidebar'), t.dot('buttons')]).toEqual([false, true]);
    t.click(box.querySelector('[data-act="mb-arrange-done"]'));
    expect(box.hidden).toBe(true);
    await t.save();
    const puts = t.api.calls.filter((c) => c.method === 'PUT').map((c) => c.body.config_key);
    expect(puts).toEqual(['items', 'items', 'items', 'items', 'layout']);
    const lay = t.store.doc('user', 1, 'layout');
    expect(lay.pages).toEqual({ 'user:my-desk': { tiles: [{ item: 'moreAutomations' }, { item: 'adminUsers' }, { break: true }, { item: 'user:leads-tab' }, { item: 'user:my-box' }], icons: [{ item: 'casey' }] } });
    expect(t.store.doc('user', 1, 'items').items.find((i) => i.id === 'user:my-desk').action).toEqual({ type: 'page' });
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    // the shell built the page
    expect(t.pageTiles('user:my-desk')).toEqual(['moreAutomations', 'adminUsers', '|', 'user:leads-tab', 'user:my-box']);
    expect(t.pageTab('user:my-desk').querySelector('h1').textContent).toBe(' Desk renamed ');
    expect(t.L.exec('user:my-desk')).toBe(true);
    expect(t.w.currentMainTabId()).toBe(t.pageTab('user:my-desk').id);
    expect(t.errors).toEqual([]);
  });

  test('the cascade: deleting a button on a page takes it off the page (the prompt names the page); deleting the page drops its entry (the prompt says so, the box closes); each delete saves itself with its cascade (L2), writing neither', async () => {
    const items = { items: [
      { id: 'user:desk', label: 'My desk', icon: 'desktop', action: { type: 'page' } },
      { id: 'user:court', label: 'Court site', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/', present: 'window' } },
    ] };
    const layout = { placed: { home: [{ item: 'user:desk' }, { item: 'cases' }] }, removed: {}, pages: { 'user:desk': { tiles: [{ item: 'user:court' }, { item: 'cases' }], icons: [{ item: 'user:court' }] } } };
    t = await boot({ store: await seedUser(makeStore(), items, layout) });
    expect(t.pageTiles('user:desk')).toEqual(['user:court', 'cases']);
    await open(t, { section: 'buttons' });
    expect([...t.mbRow('Court site').querySelectorAll('.ymb-where .yle-tag')].map((x) => x.textContent)).toEqual(['On “My desk”']);
    t.click(t.mbRow('Court site').querySelector('[data-act="mb-del"]'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Delete “Court site”? Note: it’s on your page “My desk”. Deleting it takes it off there too. This can’t be undone.']);
    expect(t.dot('buttons')).toBe(false);                 // the layout had no unsaved edit: its cascade went with the delete
    expect(t.api.calls.filter((c) => c.method === 'PUT').map((c) => c.body.config_key)).toEqual(['items', 'layout']);
    t.click(t.mbRow('My desk').querySelector('[data-act="mb-arrange"]'));
    expect(t.names(P('user:desk', 'tiles'))).toEqual(['Cases']);
    expect(t.names(P('user:desk', 'icons'))).toEqual([]);
    expect(t.store.doc('user', 1, 'layout').pages).toEqual({ 'user:desk': { tiles: [{ item: 'cases' }], icons: [] } });
    expect(t.pageTiles('user:desk')).toEqual(['cases']);
    // the page itself
    await open(t, { section: 'buttons' });
    t.click(t.mbRow('My desk').querySelector('[data-act="mb-arrange"]'));
    expect(t.mb().querySelector('.ymb-arrange').hidden).toBe(false);
    t.click(t.mbRow('My desk').querySelector('[data-act="mb-del"]'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Delete “My desk”? Note: it’s on your Home. Deleting it takes it off there too. The page’s own tiles go with it. This can’t be undone.']);
    expect(t.mb().querySelector('.ymb-arrange').hidden).toBe(true);
    expect(t.api.calls.filter((c) => c.method === 'PUT').map((c) => c.body.config_key)).toEqual(['items', 'layout', 'items', 'layout']);
    const lay = t.store.doc('user', 1, 'layout');
    expect(lay.pages).toEqual({});
    expect(lay.placed.home).toEqual([{ item: 'cases' }]);
    expect(t.pageTab('user:desk')).toBe(null);
    expect(t.errors.filter((e) => !/not in this user's launcher/.test(e))).toEqual([]);
  });

  test('a refused layout save: a 400 naming pages.<id>.tiles lands under that page\'s section while its box is open; a partial save keeps the pages', async () => {
    const items = { items: [{ id: 'user:desk', label: 'My desk', icon: 'desktop', action: { type: 'page' } }] };
    t = await boot({ store: await seedUser(makeStore(), items) });
    await open(t, { section: 'buttons' });
    expect([t.dot('home') || t.dot('sidebar'), t.dot('buttons')]).toEqual([false, false]);
    t.click(t.mbRow('My desk').querySelector('[data-act="mb-arrange"]'));
    t.pick(P('user:desk', 'tiles'), 'cases');
    expect([t.dot('home') || t.dot('sidebar'), t.dot('buttons')]).toEqual([false, true]);   // a stored page's tiles alone light My buttons, not Home or Sidebar
    const real = t.w.apiSend;
    t.w.apiSend = (url, method, body) => (method === 'PUT' && body.config_key === 'layout'
      ? Promise.reject(Object.assign(new Error('refused'), { status: 400, body: { status: 'error', errors: ['pages.user:desk.tiles[0]: made up', 'pages.user:other.icons[1]: elsewhere'] } }))
      : real(url, method, body));
    await t.save();
    const errs = t.sec(P('user:desk', 'tiles')).querySelector('.yle-errs');
    expect([errs.hidden, errs.textContent]).toEqual([false, 'pages.user:desk.tiles[0]: made up']);
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('The server refused the save. pages.user:other.icons[1]: elsewhere Your changes are still here.');
    expect(t.w.ycLayoutEditor.isDirty()).toBe(true);
    t.w.apiSend = real;
    await t.save();
    expect(t.store.doc('user', 1, 'layout').pages).toEqual({ 'user:desk': { tiles: [{ item: 'cases' }] } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('3. the firm mode: the Firm pages pane', () => {
  let t;
  afterEach(() => t && t.close());

  test('no firm pages: the pane says how to make one; with pages: a block per page with its two sections; the arrangement is ONE PUT the shell repaints into a page tab', async () => {
    t = await boot({ store: await seedFirm(makeStore(), [CLIO]) });
    await open(t, { scope: 'firm', section: 'pages' });
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-no-pages').textContent).toMatch(/No firm pages yet/);
    expect(t.panel().querySelectorAll('.yle-page-block')).toHaveLength(0);
    t.click(t.panel().querySelector('.yle-cancel'));
    await t.flush();
    t.close();
    t = await boot({ store: await seedFirm(makeStore()) });
    expect(t.pageTab('firm:ops')).not.toBe(null);                                      // su sees the (empty) firm page
    expect(t.pageTiles('firm:ops')).toEqual([]);
    await open(t, { scope: 'firm', section: 'pages', page: 'firm:ops' });
    const blk = t.panel().querySelector('.yle-page-block[data-page="firm:ops"]');
    expect(blk.querySelector('.yle-page-title').textContent).toBe(' Operations');
    expect(blk.querySelector('.yle-page-title i').className).toBe('fa-solid fa-layer-group');
    expect([...blk.querySelectorAll('.yle-sec')].map((s) => s.getAttribute('data-sf'))).toEqual([P('firm:ops', 'tiles'), P('firm:ops', 'icons')]);
    expect(blk.contains(t.d.activeElement)).toBe(true);
    const TS = P('firm:ops', 'tiles');
    t.pick(TS, 'moreManuals');
    t.pick(TS, 'adminUsers');
    t.pick(TS, 'firm:clio-code');
    t.click(t.sec(TS).querySelector('[data-act="add-break"]'));
    t.pick(P('firm:ops', 'icons'), 'myTasks');
    expect(t.names(TS)).toEqual(['Manuals', 'Users', 'Get Clio Code', '|']);
    expect([t.dot('pages'), t.dot('more'), t.dot('home')]).toEqual([true, false, false]);
    await t.save();
    const puts = t.api.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect([puts[0].body.scope, puts[0].body.config_key, puts[0].body.base]).toEqual(['firm', 'layout', null]);
    expect(t.store.doc('firm', 0, 'layout').pages).toEqual({ 'firm:ops': { tiles: [{ item: 'moreManuals' }, { item: 'adminUsers' }, { item: 'firm:clio-code' }, { break: true }], icons: [{ item: 'myTasks' }] } });
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    expect(t.pageTiles('firm:ops')).toEqual(['moreManuals', 'adminUsers', 'firm:clio-code', '|']);
    expect([...t.pageTab('firm:ops').querySelectorAll('.page-egg-row > *')].map((b) => b.getAttribute('data-yc-shortcut'))).toEqual(['myTasks']);
    // a 400 under the page's section
    await open(t, { scope: 'firm', section: 'pages' });
    t.click(t.rowNamed(TS, 'Manuals').querySelector('[data-act="remove"]'));
    const real = t.w.apiSend;
    t.w.apiSend = (url, method, body) => (method === 'PUT'
      ? Promise.reject(Object.assign(new Error('refused'), { status: 400, body: { status: 'error', errors: ['pages.firm:ops.icons[0]: made up'] } }))
      : real(url, method, body));
    await t.save();
    const errs = t.sec(P('firm:ops', 'icons')).querySelector('.yle-errs');
    expect([errs.hidden, errs.textContent, t.panel().querySelector('#ylePane_pages').hidden]).toEqual([false, 'pages.firm:ops.icons[0]: made up', false]);
    expect(t.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
const strip = (html) => html.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
function writeFrame(iframe, html) {
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(strip(html)); doc.close();
  return iframe.contentWindow;
}
async function bootFirmPage(opts = {}) {
  const t = await boot(opts);
  const real = t.w.apiSend;
  t.w.apiSend = (url, method, body) => (String(url).split('?')[0] === '/api/entitlements' && (method || 'GET') === 'GET'
    ? Promise.resolve({ status: 'success', denies: [], undeniable: [] }) : real(url, method, body));
  t.w.apiSend.calls = real.calls;
  const f = t.d.createElement('iframe');
  t.d.body.appendChild(f);
  const mid = writeFrame(f, CCM_HTML);
  await t.flush();
  mid.switchSubPage('firm');
  const firm = writeFrame(mid.document.getElementById('subpage-firm'), FIRM_HTML);
  for (let i = 0; i < 4; i++) await t.flush();
  const $ = (sel) => firm.document.querySelector(sel);
  const $$ = (sel) => [...firm.document.querySelectorAll(sel)];
  const fire = (el, type = 'click') => el.dispatchEvent(new firm.Event(type, { bubbles: true }));
  return { ...t, mid, firm, $, $$, fire, F: firm.FirmPage };
}

describe('4. firm.html: the Page kind', () => {
  let t;
  afterEach(() => t && t.close());

  test('a firm item may be a Page: the kind in "Opens", Arrange disabled until saved, the saved action exactly { type:"page" }; Who sees what lists it; the saved row\'s Arrange opens the editor on its block', async () => {
    t = await bootFirmPage({ store: await seedFirm(makeStore(), [CLIO]) });
    t.fire(t.$('[data-act="add-item"]'));
    const i = t.$$('.fm-item').length - 1;
    expect([...t.$(`#fi${i}-type`).options].map((o) => [o.value, o.textContent])).toEqual([['url', 'Link'], ['tool', 'Tool'], ['view', 'Saved view'], ['page', 'Page']]);
    const sel = t.$(`#fi${i}-type`); sel.value = 'page'; t.fire(sel, 'change');
    const lab = t.$(`#fi${i}-label`); lab.value = 'Operations'; t.fire(lab, 'input');
    const ico = t.$(`#fi${i}-icon`); ico.value = 'layer-group'; t.fire(ico, 'input');
    const card = t.$$('.fm-item')[i];
    expect(card.textContent).toMatch(/A page of tiles/);
    expect(card.textContent).toMatch(/Save it first, then arrange its tiles/);
    expect(card.querySelector('[data-act="arrange-page"]').disabled).toBe(true);
    expect(card.querySelector('[data-f="key"], [data-f="href"], [data-f="size"]')).toBe(null);
    expect(t.F.LauncherSection.doc().items[1]).toEqual({ id: 'firm:operations', label: 'Operations', icon: 'layer-group', action: { type: 'page' } });
    t.fire(card.querySelector('[data-act="arrange-page"]'));                              // disabled: nothing opens
    await t.flush();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    await t.F.Page.save();
    await t.flush();
    const stored = t.store.doc('firm', 0, 'registry_overrides');
    expect(stored.items[1]).toEqual({ id: 'firm:operations', label: 'Operations', icon: 'layer-group', action: { type: 'page' } });
    // saved: the row's Arrange opens the top editor on the Firm pages pane, on this page's block
    const row = t.$$('.fm-item')[1];
    expect(row.textContent).toMatch(/Its tiles are arranged in the editor/);
    const b = row.querySelector('[data-act="arrange-page"]');
    expect(b.disabled).toBe(false);
    t.fire(b);
    await t.flush();
    expect([t.w.ycLayoutEditor.isOpen(), t.w.ycLayoutEditor.scope()]).toEqual([true, 'firm']);
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(false);
    const blk = t.panel().querySelector('.yle-page-block[data-page="firm:operations"]');
    expect(blk).not.toBe(null);
    expect(blk.contains(t.d.activeElement)).toBe(true);
    t.click(t.panel().querySelector('.yle-cancel'));
    await t.flush();
    // Who sees what lists the page (a firm item like any other)
    expect(t.$('.fm-who-row[data-who-id="firm:operations"]')).not.toBe(null);
    // the shell: the page is a tab (empty) for this su
    expect(t.pageTab('firm:operations')).not.toBe(null);
    // History's View names the page's rows
    await svc.write(t.store.db, { scope: 'firm', config_key: 'layout', config: { pages: { 'firm:operations': { tiles: [{ item: 'moreManuals' }, { break: true }, { item: 'adminUsers' }], icons: [{ item: 'casey' }] } } } }, ADMIN);
    expect(J(t.F.layoutParts({ pages: { 'firm:operations': { tiles: [{ item: 'a' }, { break: true }, { item: 'b' }], icons: [{ item: 'c' }] }, 'firm:x': {} } }, (id) => id.toUpperCase())))
      .toEqual([['Page “FIRM:OPERATIONS”', 'Row 1: A; Row 2: B · small buttons: C'], ['Page “FIRM:X”', 'nothing']]);
    t.fire(t.$('[data-act="history"]'));
    await t.flush();
    t.fire(t.$$('[data-hist-doc]')[1]);
    await t.flush();
    const rows = t.$$('.fm-ver');
    t.fire(rows[0].querySelector('[data-ver-act="view"]'));
    await t.flush();
    expect(rows[0].querySelector('.fm-ver-view').textContent).toBe('Page “Operations”Row 1: Manuals; Row 2: Users · small buttons: Casey');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher-nits L4b1 (Fred, 2026-10-28): each person arranges the FIRM's
// pages for themselves — ui.user.layout.overlays[<firm page id>] =
// { placed?: { tiles?, icons? }, removed?: { tiles?, icons? } }, the
// surfaces' merge rule over the firm's page lists, firm locks holding.
// The real validator, the real service on a store, the real shell and editor.
describe('7. L4b1 — your arrangement of a firm page', () => {
  let t;
  afterEach(() => t && t.close());
  const OT = 'over:firm:ops:tiles', OI = 'over:firm:ops:icons';
  const FIRM_OPS = { pages: { 'firm:ops': { tiles: [{ item: 'moreAutomations' }, { item: 'moreManuals' }, { break: true }, { item: 'adminUsers' }], icons: [{ item: 'casey' }] } } };
  const seedOps = async (store, locked = []) => {
    await svc.write(store.db, { scope: 'firm', config_key: 'registry_overrides', config: { hidden: [], locked, renames: {}, items: [OPS] } }, ADMIN);
    await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: FIRM_OPS }, ADMIN);
    return store;
  };
  const OV = { placed: {}, removed: {}, overlays: { 'firm:ops': { placed: { tiles: [{ item: 'adminUsers' }, { item: 'moreAutomations' }] }, removed: { tiles: ['moreManuals'], icons: ['casey'] } } } };

  test('the grammar: user scope only, firm page ids only, each part the page part\'s grammar; a document round-trips', () => {
    expect(okUser(OV)).toEqual({ ok: true, errors: [], same: true });
    expect(okFirm({ overlays: {} }).errors).toEqual(['layout: unknown field "overlays"']);
    expect(okUser({ overlays: { 'user:desk': {} } }).errors).toEqual(['overlays.user:desk: not a firm page id (firm:…)']);
    expect(okUser({ overlays: { 'firm:ops': { placed: { icons: [{ break: true }] } } } }).ok).toBe(false);
    expect(okUser({ overlays: { 'firm:ops': { placed: { tiles: [{ item: 'cases' }, { item: 'cases' }] } } } }).ok).toBe(false);
    expect(okUser({ overlays: { 'firm:ops': { removed: { tiles: 'cases' } } } }).ok).toBe(false);
    expect(okUser({ overlays: { 'firm:ops': { order: [] } } }).ok).toBe(false);
  });

  test('the shell draws the firm page under the user\'s overlay: their order, their removals; a firm-locked tile comes back', async () => {
    t = await boot({ store: await seedUser(await seedOps(makeStore()), { items: [] }, OV) });
    expect(t.pageTiles('firm:ops')).toEqual(['adminUsers', 'moreAutomations']);   // Manuals removed; the base break goes with a placed order
    expect(t.pageTab('firm:ops').querySelectorAll('.page-egg-row > *')).toHaveLength(0);   // Casey removed
    t.close();
    t = await boot({ store: await seedUser(await seedOps(makeStore(), ['moreManuals']), { items: [] }, OV) });
    expect(t.pageTiles('firm:ops')).toEqual(['adminUsers', 'moreAutomations', 'moreManuals']);   // locked: back beside its neighbour
    t.close();
    t = await boot({ store: await seedOps(makeStore()) });                          // no overlay: the firm's page as it is
    expect(t.pageTiles('firm:ops')).toEqual(['moreAutomations', 'moreManuals', '|', 'adminUsers']);
  });

  test('the editor\'s Firm pages tab: the firm\'s tiles as standard rows; hide, move, add; the tab\'s dot; Save writes overlays (validated) and the page follows; reopened, nothing is dirty; Reset puts the firm\'s back', async () => {
    const store = await seedOps(makeStore());
    t = await boot({ store });
    await open(t, { section: 'pages' });
    expect(t.panel().querySelector('.yle-tab[data-pane="pages"]').hidden).toBe(false);
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(false);
    expect([...t.panel().querySelectorAll('#ylePane_pages .yle-page-title')].map((h) => h.textContent.trim())).toEqual(['Operations']);
    expect([...t.panel().querySelectorAll('#ylePane_pages .yle-sec')].map((x) => [x.getAttribute('data-sf'), x.querySelector('h3').textContent])).toEqual([[OT, 'Tiles'], [OI, 'Small buttons']]);
    expect(t.names(OT)).toEqual(['Automations', 'Manuals', '|', 'Users']);
    expect(t.sec(OT).querySelector('.yle-reset').textContent).toBe('Reset to the firm’s');
    expect(t.rowNamed(OT, 'Manuals').querySelector('[data-act="hide"]')).not.toBe(null);   // a firm tile: hidden, not removed
    t.click(t.rowNamed(OT, 'Manuals').querySelector('[data-act="hide"]'));
    expect([...t.sec(OT).querySelectorAll('.yle-hidden li')].map((li) => li.textContent)).toEqual([expect.stringMatching(/Manuals/)]);
    t.click(t.rowNamed(OT, 'Users').querySelector('[data-act="up"]'));
    t.pick(OT, 'tasks');
    expect(t.names(OT)).toEqual(['Automations', 'Users', '|', 'Tasks']);
    expect([t.dot('pages'), t.dot('home'), t.dot('sidebar')]).toEqual([true, false, false]);
    await t.save();
    const lay = store.doc('user', 1, 'layout');
    expect(lay.overlays).toEqual({ 'firm:ops': { placed: { tiles: [{ item: 'moreAutomations' }, { item: 'adminUsers' }, { break: true }, { item: 'tasks' }] }, removed: { tiles: ['moreManuals'] } } });
    expect(okUser(lay).ok).toBe(true);
    expect(t.pageTiles('firm:ops')).toEqual(['moreAutomations', 'adminUsers', '|', 'tasks']);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    // reopened from what was saved: nothing to save
    await open(t, { section: 'pages' });
    expect([t.w.ycLayoutEditor.isDirty(), t.dot('pages')]).toEqual([false, false]);
    expect(t.names(OT)).toEqual(['Automations', 'Users', '|', 'Tasks']);
    t.click(t.sec(OT).querySelector('[data-act="reset"]'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Put “Operations” back the way your firm arranged it? Your arrangement of it is replaced when you Save.']);
    expect(t.names(OT)).toEqual(['Automations', 'Manuals', '|', 'Users']);
    await t.save();
    expect(store.doc('user', 1, 'layout').overlays).toEqual({});
    expect(t.pageTiles('firm:ops')).toEqual(['moreAutomations', 'moreManuals', '|', 'adminUsers']);
  });

  test('an overlay on a firm page this person no longer sees rides through a save untouched; a tab with no firm page is hidden', async () => {
    const ghost = { placed: { tiles: [{ item: 'cases' }] } };
    t = await boot({ store: await seedUser(makeStore(), { items: [] }, { placed: {}, removed: {}, overlays: { 'firm:gone': ghost } }) });
    await open(t, { section: 'home' });
    expect(t.panel().querySelector('.yle-tab[data-pane="pages"]').hidden).toBe(true);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
    t.click(t.rowNamed('home', 'Cases').querySelector('[data-act="down"]'));
    await t.save();
    expect(t.store.doc('user', 1, 'layout').overlays).toEqual({ 'firm:gone': ghost });
  });

  test('one of your buttons on a firm page: My buttons says where; deleting it takes it off the page, saved with the delete', async () => {
    const LEADS = { id: 'user:leads', label: 'Leads', icon: 'star', action: { type: 'url', href: 'https://x.example/', present: 'window' } };
    const store = await seedUser(await seedOps(makeStore()), { items: [LEADS] }, { placed: {}, removed: {}, overlays: { 'firm:ops': { placed: { tiles: [{ item: 'user:leads' }, { item: 'moreAutomations' }] } } } });
    t = await boot({ store });
    expect(t.pageTiles('firm:ops')[0]).toBe('user:leads');
    await open(t, { section: 'buttons' });
    expect([...t.mbRow('Leads').querySelectorAll('.ymb-where .yle-tag')].map((x) => x.textContent)).toEqual(['On firm page “Operations”']);
    t.click(t.mbRow('Leads').querySelector('[data-act="mb-del"]'));
    await t.flush();
    expect(t.asked.slice(-1)[0]).toMatch(/^Delete “Leads”\? Note: it’s on your firm page “Operations”\. /);
    const lay = store.doc('user', 1, 'layout');
    expect(JSON.stringify(lay)).not.toMatch(/user:leads/);
    expect(okUser(lay).ok).toBe(true);
    expect(t.pageTiles('firm:ops')).not.toContain('user:leads');
  });
});
