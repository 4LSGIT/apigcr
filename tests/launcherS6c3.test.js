// tests/launcherS6c3.test.js
//
/**
 * ui-custom S6c-3 — the firm mode of the layout editor: the firm arranges
 * More Features, Admin, the default Home and sidebar and their icon rows
 * (S6c_DESIGN §4.5, §5 S6c-3, Fred's rulings on §6).
 *
 *   1. THE CORE (ycLayoutEditor.session — pure) in a bare vm with the page's
 *      REAL ycLauncher over the real registry, every document checked by the
 *      REAL server validator (lib/uiConfigShape.js, scope firm): the catalogue
 *      (computeEffective as su under the firm overlay; firm items in, user
 *      buttons out, the retired custom tab nowhere); the More list closes with the firm row
 *      while nothing is placed there (the seed), and an edit writes it as
 *      placed entries; Fred's scenario (rows of four, Get Clio Code in row 5);
 *      breaks only on the grids, icon rows ≤12 and items only; All always in
 *      Home's icon row; reset per surface; a seeded fuzz over all seven
 *      surfaces — every document validates unchanged and the renderer's own
 *      resolve draws exactly what the editor showed.
 *   2. THE USER EDITOR STARTS FROM THE FIRM'S (01/15): its lists are the user
 *      step over the firm step — what the renderer draws; an item the firm
 *      placed is a standard one (hidden, never removed); reset follows the firm.
 *   3. THE PANEL, FIRM MODE, for real (jsdom: the shell's launcher with every
 *      mount, the All tab, ycAll.js, ycLayoutEditor.js) over an API whose
 *      every call runs the REAL services/uiConfigService on an in-memory store
 *      (tests/helpers/uiConfigStore.js): no can_edit_firm → nothing opens;
 *      four tabs (the fourth, Firm pages, is S6c-5's), seven sections; Fred's scenario by clicks → ONE PUT
 *      { scope:'firm', config_key:'layout', base } → the shell repaints with no
 *      reload (the More grid in its new order, the firm row gone); a second
 *      session saving first → 409, edits kept, Reload discards them for the
 *      firm's; 400 errors under their sections; 403 the session message; the
 *      personal editor still opens afterwards (the panel is rebuilt).
 *   4. FIRM.HTML (three frames, as in the app): "Arrange pages and defaults…"
 *      opens the top document's editor in firm mode; History lists the layout
 *      document's versions, views one as text, restores an older one (base =
 *      the newest id listed; a save since → 409) and the shell follows.
 *   5. THE ALL TAB never lists All itself; Ctrl-K and exec('all') keep it.
 *
 * Mutation-checked (see local/ui-custom/S6c3_worker_report.md).
 *
 * Run:  npx jest tests/launcherS6c3.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { rawShellHtml } = require('./helpers/shellHtml');
const { makeStore } = require('./helpers/uiConfigStore');
const shape = require('../lib/uiConfigShape');

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
  if (a < 0 || b < 0) throw new Error('launcherS6c3: anchor not found: ' + (a < 0 ? from : to));
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
const PAYROLL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const GONE = { id: 'firm:gone', label: 'Gone for now', icon: 'ghost', action: { type: 'url', href: 'https://gone.example.com/', present: 'window' } };
const RO = { items: [CLIO, PAYROLL, GONE], hidden: ['firm:gone'], locked: ['bills'], renames: { moreViews: { label: 'Saved views' } } };
const firmValid = (doc) => {
  const r = shape.validate('firm', 'layout', J(doc));
  return { ok: r.ok, errors: r.errors, same: r.ok && shape.canonical(r.value) === shape.canonical(J(doc)) };
};
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
const CAT = J(VE.firmCatalog({ firm: { registry_overrides: RO } }));
const firmSess = (stored, o = {}) => VE.session({
  stored, effective: CAT.entries, locked: [], lockedForUsers: RO.locked, base: LAY, registry: REG, groups: CAT.groups,
  surfaces: FIRM_SURFACES, pass: [], seed: { more: CAT.seed }, ...o,
});
const viewKeys = (s, sf) => J(s.view(sf)).map(key);
const items = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
// the renderer's own merge over a stored firm document, for this catalogue
const drawn = (sf, firm) => J(VL.resolveLayout(sf, { base: LAY[sf], firm, user: null, effective: CAT.entries, locked: [] })).map(key);
// rows of a grid's keys, split at the breaks
const rowsOf = (keys) => keys.reduce((out, k) => { if (k === '|') out.push([]); else out[out.length - 1].push(k); return out; }, [[]]);

describe('1. the firm mode\'s core (pure)', () => {
  test('the editor\'s copies of the server\'s grammar match lib/uiConfigShape.js', () => {
    expect(J(VE.FIRM_SURFACES)).toEqual(J(shape.FIRM_LAYOUT_SURFACES));
    expect(J(VE.GUARANTEED)).toEqual(J(shape.GUARANTEED));
    expect(J(shape.BREAK_SURFACES)).toEqual(['home', 'more', 'admin']);
    expect(shape.CAPS.icons).toBe(12);
    expect(FIRM_SURFACES).toEqual(J(shape.FIRM_LAYOUT_SURFACES));
  });

  test('the catalogue: every feature a superuser has under the firm overlay, firm items in, user buttons / hidden items out (the retired custom tab nowhere); seed = the firm row', () => {
    const ids = CAT.entries.map((e) => e.id);
    const hid = J(VE.firmCatalog({ firm: { registry_overrides: { ...RO, hidden: ['firm:gone', 'moreVideoManager'] } } })).entries.map((e) => e.id);
    expect(hid).toEqual(ids.filter((id) => id !== 'moreVideoManager'));
    for (const id of ['moreAutomations', 'adminDbConsole', 'adminEtch', 'admin', 'all', 'casey', 'myTasks', 'firm:clio-code', 'firm:payroll']) expect([id, ids.includes(id)]).toEqual([id, true]);
    for (const id of ['custom', 'firm:gone']) expect([id, ids.includes(id)]).toEqual([id, false]);
    expect(ids.some((id) => /^user:/.test(id))).toBe(false);
    expect(CAT.entries.find((e) => e.id === 'moreViews').label).toBe('Saved views');       // the firm's rename
    expect(CAT.seed).toEqual(['firm:clio-code', 'firm:payroll']);                          // effective firm items, in order
    expect(CAT.groups).toContain('Firm');
    expect(CAT.groups.every((g) => CAT.entries.some((e) => e.group === g))).toBe(true);
    // a user's buttons in the ui never reach it
    const withUser = J(VE.firmCatalog({ firm: { registry_overrides: RO }, user: { items: { items: [{ id: 'user:x', label: 'X', icon: 'star', action: { type: 'url', href: 'https://x.example/', present: 'window' } }] } } }));
    expect(withUser.entries.map((e) => e.id)).toEqual(ids);
  });

  test('no firm layout: every surface is the shipped one; More closes with a break and the firm row; nothing is dirty and the document is empty', () => {
    const s = firmSess(null);
    for (const sf of FIRM_SURFACES) {
      const want = J(VL.resolveLayout(sf, { base: LAY[sf], user: null, effective: CAT.entries, locked: [] })).map(key);
      expect([sf, viewKeys(s, sf)]).toEqual([sf, sf === 'more' ? [...want, '|', 'firm:clio-code', 'firm:payroll'] : want]);
    }
    expect(s.isDirty()).toBe(false);
    expect(J(s.doc())).toEqual({ placed: {}, removed: {} });
    // Firm admins get a warning, not a disabled control: the lock constrains
    // users' personal layouts, not the firm's own default.
    const bills = J(s.view('home')).find((r) => r.id === 'bills');
    expect([bills.locked, bills.lockedForUsers, bills.act]).toEqual([false, true, 'hide']);
    // the seeded rows are the firm's own (tag Firm, removable)
    const v = J(s.view('more'));
    expect(v.slice(-2).map((r) => [r.id, r.firm, r.act])).toEqual([['firm:clio-code', true, 'remove'], ['firm:payroll', true, 'remove']]);
    expect(v[v.length - 3]).toEqual({ kind: 'break', act: 'remove' });
  });

  test('Fred\'s scenario: Get Clio Code moved up into row 5, the trailing firm break removed → rows of four plus YisrAI; valid; the renderer draws exactly that', () => {
    const s = firmSess(null);
    let at = viewKeys(s, 'more').indexOf('firm:clio-code');
    // up past YisrAI, its break, row 6 (four tiles), and the break above it
    // → the end of row 5
    for (let n = 0; n < 8; n++) { expect(s.move('more', at, -1)).toBe(true); at--; }
    expect(rowsOf(viewKeys(s, 'more')).map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1, 1]);
    // the break the seed added now sits before Payroll: take Payroll off More, then the trailing break
    const keys = viewKeys(s, 'more');
    expect(s.remove('more', keys.indexOf('firm:payroll'))).toBe(true);
    expect(viewKeys(s, 'more').slice(-1)).toEqual(['|']);
    expect(s.remove('more', viewKeys(s, 'more').length - 1)).toBe(true);
    const doc = J(s.doc());
    expect(Object.keys(doc.placed)).toEqual(['more']);
    expect(doc.removed).toEqual({});
    const rows = rowsOf(doc.placed.more.map((e) => (e.break ? '|' : e.item)));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(rows[4]).toEqual(['moreAvailability', 'moreBooking', 'moreCourtPreview', 'firm:clio-code']);
    expect(rows[6]).toEqual(['moreAssistant']);
    expect(firmValid(doc)).toEqual({ ok: true, errors: [], same: true });
    expect(drawn('more', doc)).toEqual(viewKeys(s, 'more'));
    expect(s.isDirty()).toBe(true);
  });

  test('a feature the firm hid is not offered, and a placement of it is carried through an edit (it comes back where it was)', () => {
    const cat = J(VE.firmCatalog({ firm: { registry_overrides: { ...RO, hidden: ['moreVideoManager'] } } }));
    const stored = { placed: { more: items('more').map((id) => ({ item: id })) }, removed: {} };
    const s = VE.session({ stored, effective: cat.entries, locked: [], base: LAY, registry: REG, groups: cat.groups, surfaces: FIRM_SURFACES, pass: [], seed: { more: cat.seed } });
    expect(viewKeys(s, 'more')).not.toContain('moreVideoManager');
    expect(s.move('more', 0, 1)).toBe(true);
    const placed = J(s.doc()).placed.more.map((e) => e.item);
    expect(placed.indexOf('moreVideoManager')).toBe(placed.indexOf('moreAssetManager') + 1);
  });

  test('the seed stops once More is placed: a stored placed.more (even []) shows only what it places; reset brings the firm row back', () => {
    const placed = { placed: { more: [{ item: 'moreReports' }, { break: true }, { item: 'firm:payroll' }] }, removed: {} };
    const s = firmSess(placed);
    expect(viewKeys(s, 'more')).toEqual(drawn('more', placed));                            // what the renderer draws, no seed
    expect(viewKeys(s, 'more')).toContain('firm:payroll');
    expect(viewKeys(s, 'more')).not.toContain('firm:clio-code');                           // not placed: not on More
    expect(firmSess({ placed: { more: [] }, removed: {} }).view('more').some((r) => r.firm)).toBe(false);
    expect(s.reset('more')).toBe(true);
    expect(viewKeys(s, 'more').slice(-3)).toEqual(['|', 'firm:clio-code', 'firm:payroll']);
    expect(J(s.doc())).toEqual({ placed: {}, removed: {} });
    // a reset of a surface with nothing stored is no change at all
    const fresh = firmSess(null);
    expect(fresh.reset('more')).toBe(true);
    expect([fresh.mode('more'), fresh.isDirty()]).toEqual(['stored', false]);
  });

  test('breaks on the grids only; icon rows hold items, at most 12; labels on the sidebar only', () => {
    const s = firmSess(null);
    for (const sf of ['home', 'more', 'admin']) expect([sf, s.addBreak(sf)]).toEqual([sf, true]);
    for (const sf of ['sidebar', 'homeIcons', 'moreIcons', 'adminIcons']) expect([sf, s.addBreak(sf)]).toEqual([sf, false]);
    expect(s.addBreak()).toBe(true);                                                       // no surface = Home (the personal editor's call)
    expect(s.addLabel('Billing')).toBe(true);
    // fill More's icon row to the cap
    const free = CAT.entries.map((e) => e.id).filter((id) => !viewKeys(s, 'moreIcons').includes(id));
    let n = viewKeys(s, 'moreIcons').length;
    for (const id of free) { if (n >= 12) break; expect(s.add('moreIcons', id)).toBe(true); n++; }
    expect([viewKeys(s, 'moreIcons').length, s.room('moreIcons')]).toEqual([12, 0]);
    expect(s.add('moreIcons', free[free.length - 1])).toBe(false);
    expect(s.room('more')).toBeGreaterThan(50);
    const doc = J(s.doc());
    expect(doc.placed.moreIcons.every((e) => Object.keys(e).join() === 'item')).toBe(true);
    expect(firmValid(doc)).toEqual({ ok: true, errors: [], same: true });
  });

  test('All always stays in Home\'s icon row: shown as always, never hidden or removed, but it moves', () => {
    const s = firmSess(null);
    s.add('homeIcons', 'casey');
    const v = J(s.view('homeIcons'));
    expect(v.map((r) => [r.id, r.always, r.act])).toEqual([['all', true, 'locked'], ['casey', false, 'remove']]);
    expect(s.hide('homeIcons', 0)).toBe(false);
    expect(s.remove('homeIcons', 0)).toBe(false);
    expect(s.move('homeIcons', 0, 1)).toBe(true);
    expect(viewKeys(s, 'homeIcons')).toEqual(['casey', 'all']);
    const doc = J(s.doc());
    expect(doc.placed.homeIcons).toEqual([{ item: 'casey' }, { item: 'all' }]);
    expect(doc.removed.homeIcons).toBeUndefined();
    expect(firmValid(doc).ok).toBe(true);
    // the sidebar's All is an ordinary item there (ruling 3)
    const sb = J(s.view('sidebar')).find((r) => r.id === 'all');
    expect([sb.always, sb.act]).toEqual([false, 'hide']);
  });

  test('hide / show / reset per surface; the other surfaces are written exactly as stored', () => {
    const stored = { placed: { admin: [{ item: 'adminEtch' }, { break: true }, { item: 'adminUsers' }], moreIcons: [{ item: 'myTasks' }, { item: 'casey' }] }, removed: { sidebar: ['log'] } };
    const s = firmSess(stored);
    expect(s.isDirty()).toBe(false);
    const i = viewKeys(s, 'more').indexOf('moreDocuments');
    expect(s.hide('more', i)).toBe(true);
    expect(J(s.hidden('more')).map((h) => h.id)).toEqual(['moreDocuments']);
    expect(s.reset('admin')).toBe(true);
    const doc = J(s.doc());
    expect(doc.removed.more).toEqual(['moreDocuments']);
    expect(doc.placed.admin).toBeUndefined();                                              // reset: both keys gone
    expect(doc.placed.moreIcons).toEqual(stored.placed.moreIcons);                         // untouched: as stored
    expect(doc.removed.sidebar).toEqual(['log']);
    expect(firmValid(doc).ok).toBe(true);
    expect(s.show('more', 'moreDocuments')).toBe(true);
    expect(J(s.doc()).removed.more).toBeUndefined();
  });

  test('FUZZ: random edits over all seven surfaces — every document validates unchanged (scope firm), and the renderer draws what the editor showed', () => {
    let seedN = 7;
    const rnd = (n) => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN % n; };
    const ops = ['move', 'hide', 'remove', 'add', 'break', 'label', 'reset', 'show'];
    for (let run = 0; run < 60; run++) {
      const s = firmSess(run % 3 === 0 ? { placed: { more: [{ item: 'moreReports' }] }, removed: { admin: ['adminScratch'] } } : null);
      for (let step = 0; step < 25; step++) {
        const sf = FIRM_SURFACES[rnd(FIRM_SURFACES.length)];
        const n = s.view(sf).length;
        const op = ops[rnd(ops.length)];
        if (op === 'move') s.move(sf, rnd(n + 1), rnd(2) ? 1 : -1);
        else if (op === 'hide') s.hide(sf, rnd(n + 1));
        else if (op === 'remove') s.remove(sf, rnd(n + 1));
        else if (op === 'add') { const c = J(s.candidates(sf, '')).flatMap((g) => g.items); if (c.length) s.add(sf, c[rnd(c.length)].id); }
        else if (op === 'break') s.addBreak(sf);
        else if (op === 'label') s.addLabel('Group ' + rnd(9));
        else if (op === 'reset') s.reset(sf);
        else { const h = J(s.hidden(sf)); if (h.length) s.show(sf, h[0].id); }
      }
      const doc = J(s.doc());
      expect([run, firmValid(doc)]).toEqual([run, { ok: true, errors: [], same: true }]);
      for (const sf of FIRM_SURFACES) {
        const seeded = sf === 'more' && !(doc.placed && doc.placed.more);
        const want = drawn(sf, doc);
        expect([run, sf, viewKeys(s, sf)]).toEqual([run, sf, seeded && want.length !== viewKeys(s, sf).length
          ? [...want, '|', ...CAT.seed.filter((id) => !want.includes(id))] : want]);
      }
    }
  });
});

// ── 2. the personal editor starts from the firm's ──────────────────────────
describe('2. the personal editor starts from the firm\'s default', () => {
  const ACCESS = { isAdmin: false, roles: ['staff'], denied: [] };
  const FIRM = { placed: { home: [{ item: 'comms' }, { item: 'cases' }, { break: true }, { item: 'moreAutomations' }] }, removed: { sidebar: ['log'] } };
  const eff = J(VL.computeEffective({ ...ACCESS, ui: { firm: { registry_overrides: RO } } }));
  const userSess = (stored, firm = FIRM) => VE.session({ stored, effective: eff, locked: RO.locked, base: LAY, registry: REG, groups: J(eff.groups || []), firm });
  const userDrawn = (sf, user, firm = FIRM) => J(VL.resolveLayout(sf, { base: LAY[sf], firm, user, effective: eff, locked: RO.locked })).map(key);

  test('every list is the user step over the firm step — what the renderer draws', () => {
    const s = userSess(null);
    for (const sf of ['home', 'sidebar']) expect([sf, viewKeys(s, sf)]).toEqual([sf, userDrawn(sf, null)]);
    expect(viewKeys(s, 'home').slice(0, 2)).toEqual(['comms', 'cases']);
    expect(viewKeys(s, 'home')).toContain('moreAutomations');                              // not a Home tile by default
    expect(viewKeys(s, 'sidebar')).not.toContain('log');                                  // the firm's removal
    expect(s.isDirty()).toBe(false);
  });

  test('an item the firm placed is a standard one: hidden (into removed), listed under Hidden, shown again; reset follows the firm', () => {
    const s = userSess(null);
    const v = J(s.view('home'));
    const auto = v.findIndex((r) => r.id === 'moreAutomations');
    expect([v[auto].base, v[auto].act]).toEqual([true, 'hide']);
    expect(s.hide('home', auto)).toBe(true);
    expect(J(s.hidden('home')).map((h) => h.id)).toEqual(['moreAutomations']);
    const doc = J(s.doc());
    expect(doc.removed.home).toEqual(['moreAutomations']);
    expect(shape.validate('user', 'layout', doc).ok).toBe(true);
    expect(userDrawn('home', doc)).toEqual(viewKeys(s, 'home'));
    // the firm's removal of Log from the sidebar is not the user's to show (not in their removed list)
    expect(J(s.hidden('sidebar'))).toEqual([]);
    expect(s.reset('home')).toBe(true);
    expect(viewKeys(s, 'home')).toEqual(userDrawn('home', null));
  });

  test('a surface label shows only on the default element (Bills reads Billing on Home), wherever the firm moved it', () => {
    const s = userSess(null, { placed: { home: [{ item: 'bills' }, { item: 'cases' }] }, removed: {} });
    expect(J(s.view('home')).find((r) => r.id === 'bills').label).toBe('Billing');
    const t = userSess(null, { placed: { sidebar: [{ item: 'bills' }] }, removed: {} });
    expect(J(t.view('sidebar')).find((r) => r.id === 'bills').label).toBe('Bills');
    // the firm took Billing off Home and a user puts it back: still the Home tile, so still "Billing"
    const u = userSess(null, { placed: {}, removed: { home: ['bills'] } });
    expect(viewKeys(u, 'home')).not.toContain('bills');
    expect(u.add('home', 'bills')).toBe(true);
    expect(J(u.view('home')).find((r) => r.id === 'bills').label).toBe('Billing');
  });

  test('without a firm layout the personal editor is exactly as before (S4b\'s base)', () => {
    const s = userSess({ placed: { home: [{ item: 'log' }] }, removed: { sidebar: ['cases'] } }, null);
    for (const sf of ['home', 'sidebar']) {
      expect(viewKeys(s, sf)).toEqual(J(VL.resolveLayout(sf, { base: LAY[sf], user: { placed: { home: [{ item: 'log' }] }, removed: { sidebar: ['cases'] } }, effective: eff, locked: RO.locked })).map(key));
    }
  });
});

// ── 3. the panel, firm mode, for real ──────────────────────────────────────
const ADMIN = { type: 'jwt', userId: 1, roles: ['admin'] };
const REG_KEYS = Object.keys(REG);
function shellPage() {
  const placedIds = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
  const grid = (sf) => placedIds(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabAll']);
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
    <div id="tabMore" class="tab-main"><h1>More</h1>
  <script>ycLauncher.mount('more')</script>
  <div class="more-egg-row"><script>ycLauncher.mount('moreIcons')</script></div>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1>
  <script>ycLauncher.mount('admin')</script>
  <div class="admin-egg-row"><script>ycLauncher.mount('adminIcons')</script></div>${grid('admin')}</div>
  </body></html>`;
}
const PAGE = shellPage();

/** The shell over a store: firmData.ui read through the store's GET (as login does). */
async function boot({ store = makeStore(), canEdit = true, auth = ADMIN, access = { isAdmin: true, roles: ['su'], denied: [] }, vc = null } = {}) {
  const errors = [];
  const dom = new JSDOM(PAGE, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.test/', ...(vc ? { virtualConsole: vc } : {}) });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\nvar user = { user: 1 };\n';
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
  // what the shell's More grid shows, in order: tile labels / '|' — visible tiles only
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const grid = (tabId) => {
    const out = [];
    let brs = 0;
    const t = d.getElementById(tabId);
    for (let n = t.querySelector('h1').nextElementSibling; n && !/-egg-row$/.test(n.className); n = n.nextElementSibling) {
      if (n.tagName === 'BR') { if (++brs === 2) { out.push('|'); brs = 0; } continue; }
      brs = 0;
      if (n.classList.contains('big-button') && shown(n)) out.push(n.textContent.trim());
    }
    return out;
  };
  return { w, d, L, store, api, errors, toasts, asked, answer: (v) => { answer = v; }, flush, panel, sec, names, rowNamed, click, tab, save, grid, close: () => w.close() };
}
const firmOpen = async (t, o = {}) => { const ok = await t.w.ycLayoutEditor.open({ scope: 'firm', ...o }); await t.flush(); return ok; };
const seedClio = async (store) => {   // the firm's items, saved through the real service (registry_overrides)
  await require('../services/uiConfigService').write(store.db, { scope: 'firm', config_key: 'registry_overrides', config: { hidden: [], locked: ['bills'], renames: {}, items: [CLIO, PAYROLL] } }, ADMIN);
  return store;
};
const rowsOfGrid = (keys) => rowsOf(keys).map((r) => r.length);

describe('3. the panel, firm mode, for real', () => {
  let t;
  afterEach(() => t && t.close());

  test('without can_edit_firm nothing opens and nothing is sent; a failed read opens nothing either', async () => {
    t = await boot({ canEdit: false });
    expect(await firmOpen(t)).toBe(false);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    expect(t.toasts).toEqual(['Arranging the firm’s pages needs the firm-settings permission.']);
    expect(t.api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    t.close();
    t = await boot();
    t.w.apiSend = () => Promise.reject(Object.assign(new Error('down'), { status: 500 }));
    expect(await firmOpen(t)).toBe(false);
    expect(t.toasts).toEqual(['Couldn’t load the firm’s arrangement; try again.']);
  });

  test('opens on five tabs (Firm pages joined in S6c-5, Home / Sidebar split in launcher-nits L1) and seven surface sections; More lists the grid then the firm row (tagged Firm); All is "Always here"; nothing to save', async () => {
    t = await boot({ store: await seedClio(makeStore()) });
    expect(await firmOpen(t)).toBe(true);
    expect(t.panel().getAttribute('data-scope')).toBe('firm');
    expect(t.d.getElementById('yleTitle').textContent.trim()).toBe('Arrange pages and defaults for everyone');
    expect([...t.panel().querySelectorAll('.yle-tab')].map((b) => b.getAttribute('data-pane'))).toEqual(['home', 'sidebar', 'more', 'admin', 'pages']);
    expect([...t.panel().querySelectorAll('.yle-sec')].map((s) => s.getAttribute('data-sf'))).toEqual(['home', 'homeIcons', 'sidebar', 'more', 'moreIcons', 'admin', 'adminIcons']);
    expect(t.panel().querySelector('#ylePane_home').hidden).toBe(false);
    expect(t.panel().querySelector('#ylePane_more').hidden).toBe(true);
    const bills = t.rowNamed('home', 'Billing');
    expect(bills.querySelector('.yle-tag').textContent.trim()).toBe('Locked for users');
    expect(bills.querySelector('[data-act="hide"]').disabled).toBe(false);
    const more = t.names('more');
    expect(more.slice(-3)).toEqual(['|', 'Get Clio Code', 'Payroll']);
    expect(t.rowNamed('more', 'Get Clio Code').querySelector('.yle-tag').textContent).toBe('Firm');
    expect(t.names('moreIcons')).toEqual(['Casey']);
    expect(t.names('adminIcons')).toEqual([]);
    const all = t.rowNamed('homeIcons', 'All');
    expect(all.querySelector('.yle-tag').textContent).toBe('Always here');
    expect(all.querySelector('[data-act="hide"]').disabled).toBe(true);
    expect(t.sec('homeIcons').querySelector('[data-act="add-break"]')).toBe(null);
    expect(t.sec('more').querySelector('[data-act="add-break"]')).not.toBe(null);
    expect(t.sec('sidebar').querySelector('[data-act="label-open"]')).not.toBe(null);
    expect(t.panel().querySelector('.yle-save').disabled).toBe(true);
    // the personal editor's own tabs are not in this panel
    expect(t.panel().querySelector('.ysc-sec, .ymb-sec')).toBe(null);
  });

  test('Fred\'s scenario by clicks: rows of four with Get Clio Code in row 5 and YisrAI alone → ONE PUT with the base → stored, versioned, and the shell repaints with no reload (firm row gone)', async () => {
    t = await boot({ store: await seedClio(makeStore()) });
    expect(t.grid('tabMore').slice(-3)).toEqual(['|', 'Get Clio Code', 'Payroll']);       // today: the firm row
    await firmOpen(t, { section: 'more' });
    expect(t.panel().querySelector('#ylePane_more').hidden).toBe(false);
    for (let n = 0; n < 8; n++) t.click(t.rowNamed('more', 'Get Clio Code').querySelector('[data-act="up"]'));
    t.click(t.rowNamed('more', 'Payroll').querySelector('[data-act="remove"]'));
    const rows = [...t.sec('more').querySelectorAll('.yle-rows > .yle-row')];
    t.click(rows[rows.length - 1].querySelector('[data-act="remove"]'));                  // the trailing break
    expect(t.panel().querySelector('.yle-tab[data-pane="more"] .yle-tab-dot').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-tab[data-pane="home"] .yle-tab-dot').hidden).toBe(true);
    await t.save();
    const puts = t.api.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect([puts[0].body.scope, puts[0].body.config_key, puts[0].body.base]).toEqual(['firm', 'layout', null]);   // no layout row yet: base null
    const stored = t.store.doc('firm', 0, 'layout');
    expect(Object.keys(stored.placed)).toEqual(['more']);
    expect(rowsOfGrid(stored.placed.more.map((e) => (e.break ? '|' : e.item)))).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(t.store.versions.filter((v) => v.config_key === 'layout')).toHaveLength(1);
    expect(t.w.firmData.ui.firm.layout).toEqual(stored);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    const g = t.grid('tabMore');
    expect(rowsOf(g).map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(rowsOf(g)[4][3]).toBe('Get Clio Code');
    expect(rowsOf(g)[6]).toEqual(['Ask Casey']);
    expect(g).not.toContain('Payroll');
    expect(t.d.querySelectorAll('#tabMore [data-yc-firm-row]')).toHaveLength(0);
    expect(t.toasts.slice(-1)).toEqual(['Saved — everyone gets the new arrangement as they load YisraCase']);
    // a second save sends the version it now holds as its base
    await firmOpen(t, { section: 'more' });
    t.click(t.rowNamed('more', 'Get Clio Code').querySelector('[data-act="up"]'));
    await t.save();
    const put2 = t.api.calls.filter((c) => c.method === 'PUT')[1];
    expect(put2.body.base).toBe(t.store.versions.filter((v) => v.config_key === 'layout')[0].id);
    expect(t.store.versions.filter((v) => v.config_key === 'layout')).toHaveLength(2);
  });

  test('a second session saved first → 409: nothing saved, every edit kept, Reload discards them for the firm\'s arrangement', async () => {
    const store = await seedClio(makeStore());
    t = await boot({ store });
    await firmOpen(t, { section: 'admin' });
    t.click(t.rowNamed('admin', 'Etch').querySelector('[data-act="up"]'));
    // another admin, another tab: saves the firm's layout behind this panel's back
    const other = store.apiFor(ADMIN);
    const head = (await other('/api/ui-config', 'GET')).firm_versions.layout;
    await other('/api/ui-config', 'PUT', { scope: 'firm', config_key: 'layout', config: { placed: { moreIcons: [{ item: 'myTasks' }, { item: 'casey' }] }, removed: {} }, base: head });
    const before = J(store.doc('firm', 0, 'layout'));
    await t.save();
    expect(t.store.doc('firm', 0, 'layout')).toEqual(before);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(true);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(true);
    const banner = t.panel().querySelector('.yle-banner');
    expect([banner.hidden, banner.textContent]).toEqual([false, 'Someone else saved the firm’s arrangement since you opened this, so nothing was saved. Reload to see theirs: your changes here are discarded.']);
    const reload = t.panel().querySelector('.yle-conflict');
    expect(reload.hidden).toBe(false);
    t.click(reload.querySelector('[data-act="reload"]'));
    await t.flush();
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
    expect(t.names('moreIcons')).toEqual(['My Tasks', 'Casey']);
    expect(t.panel().querySelector('.yle-conflict').hidden).toBe(true);
    expect(t.panel().querySelector('#ylePane_admin').hidden).toBe(false);                 // the tab it was on
    expect(t.w.firmData.ui.firm.layout).toEqual(store.doc('firm', 0, 'layout'));          // the shell caught up
    // and a save now goes through with the new base
    t.click(t.rowNamed('admin', 'Etch').querySelector('[data-act="up"]'));
    await t.save();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    expect(store.doc('firm', 0, 'layout').placed.admin).toBeDefined();
  });

  test('a refusal: 400 errors under their section (its tab shown); 403 the session message; edits kept either way', async () => {
    t = await boot();
    await firmOpen(t);
    t.click(t.rowNamed('admin', 'Etch').querySelector('[data-act="up"]'));
    const real = t.w.apiSend;
    t.w.apiSend = (url, method, body) => (method === 'PUT'
      ? Promise.reject(Object.assign(new Error('refused'), { status: 400, body: { status: 'error', errors: ['placed.adminIcons: at most 12 entries', 'something general'] } }))
      : real(url, method, body));
    await t.save();
    const errs = t.sec('adminIcons').querySelector('.yle-errs');
    expect([errs.hidden, errs.textContent]).toEqual([false, 'placed.adminIcons: at most 12 entries']);
    expect(t.panel().querySelector('#ylePane_admin').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('The server refused the save. something general Your changes are still here.');
    t.w.apiSend = (url, method, body) => (method === 'PUT' ? Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 })) : real(url, method, body));
    await t.save();
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('Your session predates a permissions change — sign out and back in.');
    expect(t.w.ycLayoutEditor.isDirty()).toBe(true);
  });

  test('reset per surface asks, then deletes that surface\'s keys only; leaving with changes asks', async () => {
    const store = makeStore();
    await require('../services/uiConfigService').write(store.db, { scope: 'firm', config_key: 'layout', config: { placed: { admin: [{ item: 'adminEtch' }] }, removed: { more: ['moreReports'] } } }, ADMIN);
    t = await boot({ store });
    await firmOpen(t, { section: 'admin' });
    t.click(t.sec('admin').querySelector('[data-act="reset"]'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Reset Admin to the app’s standard layout? The firm’s arrangement of it is replaced when you Save.']);
    await t.save();
    expect(store.doc('firm', 0, 'layout')).toEqual({ placed: {}, removed: { more: ['moreReports'] } });
    await firmOpen(t);
    t.click(t.rowNamed('home', 'Cases').querySelector('[data-act="down"]'));
    t.answer(false);
    t.click(t.panel().querySelector('.yle-cancel'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Discard your unsaved changes to the firm’s arrangement?']);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(true);
  });

  test('the personal editor still opens after the firm mode (the panel is rebuilt for it), and starts from the firm\'s Home', async () => {
    const store = makeStore();
    await require('../services/uiConfigService').write(store.db, { scope: 'firm', config_key: 'layout', config: { placed: { home: [{ item: 'comms' }, { item: 'cases' }] }, removed: {} } }, ADMIN);
    t = await boot({ store });
    await firmOpen(t);
    t.click(t.panel().querySelector('.yle-cancel'));
    await t.flush();
    expect(await t.w.ycLayoutEditor.open()).toBe(true);
    await t.flush();
    expect(t.panel().getAttribute('data-scope')).toBe('user');
    expect([...t.panel().querySelectorAll('.yle-tab')].map((b) => b.getAttribute('data-pane'))).toEqual(['home', 'sidebar', 'pages', 'shortcuts', 'buttons']);
    expect(t.d.querySelectorAll('#ycLayoutEditor')).toHaveLength(1);
    expect(t.names('home').slice(0, 2)).toEqual(['Comms', 'Cases']);
    // while the personal editor is open, the firm mode does not open over it
    expect(await firmOpen(t)).toBe(false);
    expect(t.panel().getAttribute('data-scope')).toBe('user');
  });
});

// ── 4. firm.html: the entry point and History over the layout document ──────
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
const LAYOUT_A = { placed: { more: [{ item: 'moreReports' }, { break: true }, { item: 'firm:clio-code' }] }, removed: { admin: ['adminScratch'] } };
const LAYOUT_B = { placed: { moreIcons: [{ item: 'myTasks' }, { item: 'casey' }] }, removed: {} };

describe('4. firm.html: Arrange pages and defaults…, and History of the layout', () => {
  let t;
  afterEach(() => t && t.close());

  test('the Launcher section\'s button opens the top document\'s editor in firm mode; with unsaved edits on the page it asks first', async () => {
    t = await bootFirmPage({ store: await seedClio(makeStore()) });
    const b = t.$('[data-act="arrange"]');
    expect(b.textContent.trim()).toBe('Arrange pages and defaults…');
    t.fire(b);
    await t.flush();
    expect([t.w.ycLayoutEditor.isOpen(), t.w.ycLayoutEditor.scope()]).toEqual([true, 'firm']);
    expect(t.panel().ownerDocument).toBe(t.d);                                               // drawn in the top document
    t.click(t.panel().querySelector('.yle-cancel'));
    await t.flush();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    // an unsaved hide on the page: asked, declined → not opened
    const c = t.$('[data-hide="log"]'); c.checked = true; t.fire(c, 'change');
    let asked = 0;
    t.firm.confirm = () => { asked++; return false; };
    t.fire(t.$('[data-act="arrange"]'));
    await t.flush();
    expect([asked, t.w.ycLayoutEditor.isOpen()]).toEqual([1, false]);
  });

  test('History switches to the layout document: lists its versions, views one as text, restores an older one (base = the newest listed) and the shell follows', async () => {
    const store = await seedClio(makeStore());
    const svc = require('../services/uiConfigService');
    const v1 = await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: LAYOUT_A }, ADMIN);
    await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: LAYOUT_B, base: v1.version_id }, ADMIN);
    t = await bootFirmPage({ store });
    expect(t.d.querySelectorAll('#tabMore [data-yc-firm-row]').length).toBeGreaterThan(0);   // B places no More: the firm row
    t.fire(t.$('[data-act="history"]'));
    await t.flush();
    const docs = t.$$('[data-hist-doc]');
    expect(docs.map((b) => [b.dataset.histDoc, b.getAttribute('aria-pressed')])).toEqual([['registry_overrides', 'true'], ['layout', 'false']]);
    expect(t.$$('.fm-ver')).toHaveLength(1);                                                 // registry_overrides: one save
    t.fire(docs[1]);
    await t.flush();
    const rows = t.$$('.fm-ver');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.fm-badge').textContent).toBe('current');
    expect(rows[0].querySelector('[data-ver-act="restore"]')).toBe(null);
    t.fire(rows[1].querySelector('[data-ver-act="view"]'));
    await t.flush();
    expect(rows[1].querySelector('.fm-ver-view').textContent)
      .toBe('More FeaturesRow 1: Reports; Row 2: Get Clio CodeAdminhidden: Scratch (SU)');
    t.firm.confirm = () => true;
    t.fire(rows[1].querySelector('[data-ver-act="restore"]'));
    await t.flush(); await t.flush();
    const restore = t.api.calls.filter((c) => c.method === 'POST');
    expect(restore.map((c) => [c.url, c.body])).toEqual([[`/api/ui-config/versions/${v1.version_id}/restore`, { base: v1.version_id + 1 }]]);
    expect(store.doc('firm', 0, 'layout')).toEqual(LAYOUT_A);
    expect(t.w.firmData.ui.firm.layout).toEqual(LAYOUT_A);
    // the shell repainted: A places More (Get Clio Code a tile there, Payroll not), so no firm row
    expect(t.d.querySelectorAll('#tabMore [data-yc-firm-row]')).toHaveLength(0);
    expect(t.grid('tabMore')).toContain('Get Clio Code');
    expect(t.grid('tabMore')).not.toContain('Payroll');
    const after = t.$$('.fm-ver');
    expect(after).toHaveLength(3);
    expect(after[0].querySelector('.fm-badge').textContent).toBe('current');
  });

  test('a layout restore after someone saved since the list loaded → 409, nothing written', async () => {
    const store = await seedClio(makeStore());
    const svc = require('../services/uiConfigService');
    const v1 = await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: LAYOUT_A }, ADMIN);
    await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: LAYOUT_B }, ADMIN);
    t = await bootFirmPage({ store });
    t.fire(t.$('[data-act="history"]'));
    await t.flush();
    t.fire(t.$$('[data-hist-doc]')[1]);
    await t.flush();
    await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: { placed: {}, removed: {} } }, ADMIN);   // behind the list's back
    t.firm.confirm = () => true;
    t.fire(t.$$('.fm-ver')[1].querySelector('[data-ver-act="restore"]'));
    await t.flush();
    expect(t.$('#fm-banner').textContent).toBe(t.F.CONFLICT_MSG);
    expect(store.doc('firm', 0, 'layout')).toEqual({ placed: {}, removed: {} });
    expect(store.versions.filter((v) => v.config_key === 'layout')).toHaveLength(3);
    void v1;
  });

  test('layoutParts: one line per arranged surface — rows at the breaks, the sidebar under its headings, what it hides; nothing arranged says so', async () => {
    t = await bootFirmPage();
    const lp = (doc) => J(t.F.layoutParts(doc, (id) => id.toUpperCase()));
    expect(lp({ placed: { sidebar: [{ item: 'a' }, { label: 'Records' }, { item: 'b' }, { item: 'c' }, { label: 'Empty' }], home: [{ item: 'x' }, { item: 'y' }],
      moreIcons: [{ item: 'casey' }] }, removed: { home: ['z'], adminIcons: ['q'] } }))
      .toEqual([['Home', 'X, Y · hidden: Z'], ['Sidebar', 'A; Records: B, C; Empty: —'], ['More Features’ small buttons', 'CASEY'], ['Admin’s small buttons', 'hidden: Q']]);
    expect(lp({ placed: { more: [] }, removed: {} })).toEqual([['More Features', 'nothing']]);
    expect(lp({ placed: { admin: [{ item: 'a' }, { break: true }, { break: true }, { item: 'b' }] } })).toEqual([['Admin', 'Row 1: A; Row 2: B']]);
    for (const empty of [null, {}, { placed: {}, removed: {} }]) expect(lp(empty)).toEqual([['Arrangement', 'The app’s standard layout everywhere']]);
  });
});

// ── 5. the All tab never lists All ────────────────────────────────────────
describe('5. the All tab does not list All itself; Ctrl-K and exec keep it', () => {
  let t;
  afterEach(() => t && t.close());
  test('grouped and searched, the All tab has no All entry; the palette finds it; exec(all) opens the All tab', async () => {
    t = await boot();
    const listed = () => [...t.d.querySelectorAll('#ycAllList [data-yc-item]')].map((b) => b.getAttribute('data-yc-item'));
    expect(t.L.effectiveRegistry().map((e) => e.id)).toContain('all');
    expect(listed().length).toBeGreaterThan(20);
    expect(listed()).not.toContain('all');
    const q = t.d.getElementById('ycAllSearch');
    q.value = 'All';
    q.dispatchEvent(new t.w.Event('input'));
    expect(listed().length).toBeGreaterThan(0);
    expect(listed()).not.toContain('all');
    expect(t.w.ycAll.open(t.d)).toBe(true);
    const pin = t.d.querySelector('#ycPalette input');
    pin.value = 'All';
    pin.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    expect([...t.d.querySelectorAll('#ycPalette .yc-pal-item > span:first-of-type')].map((s) => s.textContent)).toContain('All');
    t.w.ycAll.close(false);
    t.w.openMainTab('tabHome');
    expect(t.L.exec('all')).toBe(true);
    expect(t.w.currentMainTabId()).toBe('tabAll');
  });
});

// ── 6. the personal editor's Home and Sidebar tabs (launcher-nits L1) ─────
// Home and Sidebar are two tabs, and Home's tab holds the user's own icon row
// (homeIcons — the server took it since S6c; the editor passed it through
// unseen). Real service + store, the real shell's mounts.
describe('6. the personal editor: Home and Sidebar tabs, Home\'s small buttons (launcher-nits L1)', () => {
  let t;
  afterEach(() => t && t.close());
  const userOpen = async (t, o) => { const ok = await t.w.ycLayoutEditor.open(o); await t.flush(); return ok; };
  const dot = (id) => !t.panel().querySelector(`.yle-tab[data-pane="${id}"] .yle-tab-dot`).hidden;
  const secsIn = (pane) => [...t.panel().querySelectorAll(`#ylePane_${pane} .yle-sec`)].map((s) => s.getAttribute('data-sf'));
  const eggs = () => [...t.d.querySelectorAll('#tabHome .home-egg-row .home-egg')].map((b) => b.getAttribute('aria-label'));

  test('the tabs (Firm pages hidden while the firm has none); Home holds the tiles and the small buttons, Sidebar the sidebar; All is "Always here" and can\'t be hidden; Reset per section', async () => {
    t = await boot();
    expect(await userOpen(t)).toBe(true);
    expect([...t.panel().querySelectorAll('.yle-tab')].map((b) => b.textContent.replace('•', '').trim())).toEqual(['Home', 'Sidebar', 'Firm pages', 'Keyboard shortcuts', 'My buttons']);
    expect(t.panel().querySelector('.yle-tab[data-pane="pages"]').hidden).toBe(true);   // the firm has no page (L4b1)
    expect(secsIn('home')).toEqual(['home', 'homeIcons']);
    expect(secsIn('sidebar')).toEqual(['sidebar']);
    expect(t.panel().querySelector('#ylePane_home').hidden).toBe(false);
    expect(t.panel().querySelector('#ylePane_sidebar').hidden).toBe(true);
    expect(t.sec('homeIcons').querySelector('h3').textContent).toBe('Home’s small buttons');
    expect(t.sec('homeIcons').querySelector('.yle-sec-hint').textContent).toMatch(/up to 12\)\. All always stays here/);
    expect(t.sec('homeIcons').querySelector('[data-act="pick"]').textContent).toBe('Add a small button');
    expect(t.sec('homeIcons').querySelector('[data-act="add-break"]')).toBe(null);
    expect(t.sec('homeIcons').querySelector('.yle-reset').textContent).toBe('Reset small buttons to default');
    expect(t.names('homeIcons')).toEqual(['All']);
    const all = t.rowNamed('homeIcons', 'All');
    expect(all.querySelector('.yle-tag').textContent).toBe('Always here');
    expect(all.querySelector('[data-act="hide"]').disabled).toBe(true);
    expect(await userOpen(t, { section: 'sidebar' })).toBe(true);           // already open: switches tab
    expect(t.panel().querySelector('#ylePane_sidebar').hidden).toBe(false);
    t.click(t.panel().querySelector('.yle-cancel'));
    await t.flush();
    expect(await userOpen(t, { section: 'layout' })).toBe(true);            // the old tab name: Home
    expect(t.panel().querySelector('#ylePane_home').hidden).toBe(false);
  });

  test('a small button added on Home lights Home only; Save stores placed.homeIcons (the real validator) and the shell\'s icon row draws it with no reload; Reset clears that section only', async () => {
    const store = makeStore();
    t = await boot({ store });
    await userOpen(t);
    t.click(t.sec('homeIcons').querySelector('[data-act="pick"]'));
    t.click(t.sec('homeIcons').querySelector('.yle-pick-item[data-id="casey"]'));
    expect(t.names('homeIcons')).toEqual(['All', 'Casey']);
    t.click(t.rowNamed('homeIcons', 'Casey').querySelector('[data-act="up"]'));
    expect([dot('home'), dot('sidebar')]).toEqual([true, false]);
    t.click(t.rowNamed('sidebar', 'Cases').querySelector('[data-act="down"]'));
    expect([dot('home'), dot('sidebar')]).toEqual([true, true]);
    await t.save();
    const puts = t.api.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((p) => [p.body.scope, p.body.config_key])).toEqual([['user', 'layout']]);
    const stored = store.doc('user', 1, 'layout');
    expect(stored.placed.homeIcons).toEqual([{ item: 'casey' }, { item: 'all' }]);
    expect(Object.keys(stored.placed).sort()).toEqual(['homeIcons', 'sidebar']);
    expect(shape.validate('user', 'layout', stored).ok).toBe(true);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    expect(eggs()).toEqual(['Casey', 'All features']);
    // Reset small buttons: asks, then deletes homeIcons only — the sidebar keeps the user's order
    await userOpen(t);
    t.click(t.sec('homeIcons').querySelector('[data-act="reset"]'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Reset Home’s small buttons to the standard ones? Your arrangement of them is replaced when you Save.']);
    expect([dot('home'), dot('sidebar')]).toEqual([true, false]);
    await t.save();
    const after = store.doc('user', 1, 'layout');
    expect(after.placed.homeIcons).toBeUndefined();
    expect(after.removed.homeIcons).toBeUndefined();
    expect(after.placed.sidebar).toEqual(stored.placed.sidebar);
    expect(eggs()).toEqual(['All features']);
  });

  test('a button among Home\'s small buttons is tagged so in My buttons, and its delete prompt names that row (not "sidebar")', async () => {
    const store = makeStore();
    const svc = require('../services/uiConfigService');
    const USER = { type: 'jwt', userId: 1, roles: ['admin'] };
    await svc.write(store.db, { scope: 'user', config_key: 'items', config: { items: [{ id: 'user:leads', label: 'Leads', icon: 'star', action: { type: 'url', href: 'https://example.com/', present: 'window' } }] } }, USER);
    await svc.write(store.db, { scope: 'user', config_key: 'layout', config: { placed: { homeIcons: [{ item: 'user:leads' }, { item: 'all' }] } } }, USER);
    t = await boot({ store });
    expect(eggs()).toEqual(['Leads', 'All features']);
    await userOpen(t, { section: 'buttons' });
    const row = t.panel().querySelector('.ymb-row');
    expect([...row.querySelectorAll('.yle-tag')].map((x) => x.textContent)).toContain('On Home’s small buttons');
    t.answer(false);
    t.click(row.querySelector('[data-act="mb-del"]'));
    await t.flush();
    expect(t.asked.slice(-1)[0]).toMatch(/^Delete “Leads”\? Note: it’s on your Home’s small buttons\. Deleting it takes it off there too\./);
  });

  test('a refused layout save opens the tab its message is under', async () => {
    t = await boot();
    await userOpen(t);
    t.click(t.rowNamed('sidebar', 'Cases').querySelector('[data-act="down"]'));
    t.tab('buttons');
    const realApi = t.w.apiSend;
    t.w.apiSend = (url, method, body) => (method === 'PUT'
      ? Promise.reject(Object.assign(new Error('Invalid ui config'), { status: 400, body: { status: 'error', errors: ['placed.sidebar[0]: refused'] } }))
      : realApi(url, method, body));
    await t.save();
    expect(t.panel().querySelector('#ylePane_sidebar').hidden).toBe(false);
    expect([...t.sec('sidebar').querySelectorAll('.yle-errs li')].map((l) => l.textContent)).toEqual(['placed.sidebar[0]: refused']);
  });
});
