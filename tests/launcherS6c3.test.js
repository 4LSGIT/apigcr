// tests/launcherS6c3.test.js
//
/**
 * ui-custom S6c-3 — the firm mode of the layout editor: the firm arranges
 * the default Home and sidebar and Home's icon row, and its pages — More
 * Features and Admin among them since launcher-nits C4 retired the static
 * hubs (firm:more / firm:admin; S6c_DESIGN §4.5, §5 S6c-3, Fred's rulings on §6).
 *
 *   1. THE CORE (ycLayoutEditor.session — pure) in a bare vm with the page's
 *      REAL ycLauncher over the real registry, every document checked by the
 *      REAL server validator (lib/uiConfigShape.js, scope firm): the grammar
 *      (the hubs' four surfaces retired — dropped from a firm document, any
 *      other unknown surface refused); the catalogue (computeEffective as su
 *      under the firm overlay; firm items in, user buttons out, the retired
 *      custom tab and hub items nowhere; the hub pages its pages; no seed);
 *      Fred's scenario on the More Features page (rows of four, Get Clio Code
 *      in row 5); breaks only on Home and a page's tiles, icon rows ≤12 and
 *      items only; All always in Home's icon row; reset per surface (a page
 *      has none); a seeded fuzz over the surfaces and both hub pages — every
 *      document validates unchanged and the renderer's own resolve draws
 *      exactly what the editor showed.
 *   2. THE USER EDITOR STARTS FROM THE FIRM'S (01/15): its lists are the user
 *      step over the firm step — what the renderer draws; an item the firm
 *      placed is a standard one (hidden, never removed); reset follows the firm.
 *   3. THE PANEL, FIRM MODE, for real (jsdom: the shell's launcher with every
 *      mount, the All tab, ycAll.js, ycLayoutEditor.js) over an API whose
 *      every call runs the REAL services/uiConfigService on an in-memory store
 *      (tests/helpers/uiConfigStore.js): no can_edit_firm → nothing opens;
 *      three tabs (Home, Sidebar, Firm pages); Fred's scenario by clicks → ONE PUT
 *      { scope:'firm', config_key:'layout', base } → the shell repaints with no
 *      reload (the More Features page in its new order); a second
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
const { hubFirm, stageHtml } = require('./helpers/hubPages');

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

const FIRM_SURFACES = ['home', 'sidebar', 'homeIcons'];   // More and Admin are the firm's pages since launcher-nits C4, not surfaces
const CLIO = { id: 'firm:clio-code', label: 'Get Clio Code', icon: 'key', action: { type: 'url', href: 'https://clio.example.com/code', present: 'window' } };
const PAYROLL = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const GONE = { id: 'firm:gone', label: 'Gone for now', icon: 'ghost', action: { type: 'url', href: 'https://gone.example.com/', present: 'window' } };
// the firm's documents as production has them: its items + More Features and Admin as pages (hubFirm, launcher-nits C4)
const HF = hubFirm({ items: [CLIO, PAYROLL, GONE], ro: { hidden: ['firm:gone'], locked: ['bills'], renames: { moreViews: { label: 'Saved views' } } } });
const RO = HF.registry_overrides;
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
const P = VE.pageSf;
const MT = P('firm:more', 'tiles'), MI = P('firm:more', 'icons'), AT = P('firm:admin', 'tiles'), AI = P('firm:admin', 'icons');
const PAGE_SFS = [MT, MI, AT, AI];
const CAT = J(VE.firmCatalog({ firm: { registry_overrides: RO } }));
const firmSess = (stored, o = {}) => VE.session({
  stored, effective: CAT.entries, locked: [], lockedForUsers: RO.locked, base: LAY, registry: REG, groups: CAT.groups,
  surfaces: FIRM_SURFACES, pass: [], pages: CAT.pages, ...o,
});
const viewKeys = (s, sf) => J(s.view(sf)).map(key);
// the renderer's own merge over a stored firm document, for this catalogue
const drawn = (sf, firm) => J(VL.resolveLayout(sf, { base: LAY[sf], firm, user: null, effective: CAT.entries, locked: [] })).map(key);
// a page part as the document stores it (every id here is in the catalogue: the view IS the list)
const listed = (doc, sf) => { const m = /^page:(.+):(tiles|icons)$/.exec(sf); return ((doc.pages && doc.pages[m[1]] && doc.pages[m[1]][m[2]]) || []).map((e) => (e.break ? '|' : e.item)); };
// rows of a grid's keys, split at the breaks
const rowsOf = (keys) => keys.reduce((out, k) => { if (k === '|') out.push([]); else out[out.length - 1].push(k); return out; }, [[]]);

describe('1. the firm mode\'s core (pure)', () => {
  test('the editor\'s copies of the server\'s grammar match lib/uiConfigShape.js; the hubs\' four surfaces are retired (dropped from a firm document, refused anywhere else)', () => {
    expect(J(VE.FIRM_SURFACES)).toEqual(J(shape.FIRM_LAYOUT_SURFACES));
    expect(J(VE.GUARANTEED)).toEqual(J(shape.GUARANTEED));
    expect(J(shape.BREAK_SURFACES)).toEqual(['home', 'more']);                             // 'more' = the grammar a page's tiles borrow
    expect(shape.CAPS.icons).toBe(12);
    expect(FIRM_SURFACES).toEqual(J(shape.FIRM_LAYOUT_SURFACES));
    expect(J(shape.RETIRED_FIRM_SURFACES)).toEqual(['more', 'moreIcons', 'admin', 'adminIcons']);
    // a pre-C4 firm document (the live row until its next save, older History versions): accepted, the four DROPPED
    const old = { placed: { home: [{ item: 'cases' }], more: [{ item: 'moreReports' }], moreIcons: [{ item: 'casey' }], admin: [{ item: 'adminEtch' }], adminIcons: [] },
      removed: { sidebar: ['log'], more: ['moreDocuments'], moreIcons: [], admin: ['adminScratch'], adminIcons: ['x'] } };
    const r = shape.validate('firm', 'layout', J(old));
    expect([r.ok, r.errors]).toEqual([true, []]);
    expect(J(r.value)).toEqual({ placed: { home: [{ item: 'cases' }] }, removed: { sidebar: ['log'] } });
    // any other unknown surface is still refused, at both tiers; the user tier never had the four
    expect(shape.validate('firm', 'layout', { placed: { bogus: [] } }).ok).toBe(false);
    expect(shape.validate('firm', 'layout', { removed: { tabMore: [] } }).ok).toBe(false);
    for (const sf of ['more', 'admin', 'bogus']) expect([sf, shape.validate('user', 'layout', { placed: { [sf]: [] } }).ok]).toEqual([sf, false]);
  });

  test('the catalogue: every feature a superuser has under the firm overlay, firm items in, user buttons / hidden items out (the retired custom tab nowhere); More Features and Admin are its pages; no seed', () => {
    const ids = CAT.entries.map((e) => e.id);
    const hid = J(VE.firmCatalog({ firm: { registry_overrides: { ...RO, hidden: ['firm:gone', 'moreVideoManager'] } } })).entries.map((e) => e.id);
    expect(hid).toEqual(ids.filter((id) => id !== 'moreVideoManager'));
    for (const id of ['moreAutomations', 'adminDbConsole', 'adminEtch', 'firm:more', 'firm:admin', 'all', 'casey', 'myTasks', 'firm:clio-code', 'firm:payroll']) expect([id, ids.includes(id)]).toEqual([id, true]);
    for (const id of ['custom', 'firm:gone', 'moreFeatures', 'admin']) expect([id, ids.includes(id)]).toEqual([id, false]);   // the hub items are gone (C4)
    expect(ids.some((id) => /^user:/.test(id))).toBe(false);
    expect(CAT.entries.find((e) => e.id === 'moreViews').label).toBe('Saved views');       // the firm's rename
    expect(CAT.pages).toEqual(['firm:more', 'firm:admin']);
    expect(CAT).not.toHaveProperty('seed');                                                // the More firm row is retired with the hub
    expect(CAT.groups).toContain('Firm');
    expect(CAT.groups.every((g) => CAT.entries.some((e) => e.group === g))).toBe(true);
    // a user's buttons in the ui never reach it
    const withUser = J(VE.firmCatalog({ firm: { registry_overrides: RO }, user: { items: { items: [{ id: 'user:x', label: 'X', icon: 'star', action: { type: 'url', href: 'https://x.example/', present: 'window' } }] } } }));
    expect(withUser.entries.map((e) => e.id)).toEqual(ids);
  });

  test('no firm layout: every surface is the shipped one, and no firm item is placed anywhere; nothing is dirty and the document is empty', () => {
    const s = firmSess(null);
    for (const sf of FIRM_SURFACES) {
      expect([sf, viewKeys(s, sf)]).toEqual([sf, J(VL.resolveLayout(sf, { base: LAY[sf], user: null, effective: CAT.entries, locked: [] })).map(key)]);
    }
    for (const sf of [...FIRM_SURFACES, ...PAGE_SFS]) expect([sf, viewKeys(s, sf).filter((k) => /^firm:(clio|payroll)/.test(k))]).toEqual([sf, []]);
    expect(s.isDirty()).toBe(false);
    expect(J(s.doc())).toEqual({ placed: {}, removed: {} });
    // Firm admins get a warning, not a disabled control: the lock constrains
    // users' personal layouts, not the firm's own default.
    const bills = J(s.view('home')).find((r) => r.id === 'bills');
    expect([bills.locked, bills.lockedForUsers, bills.act]).toEqual([false, true, 'hide']);
  });

  test('Fred\'s scenario on the More Features page: Get Clio Code added and moved up into row 5 → rows of four plus YisrAI; valid; the other lists written exactly as stored', () => {
    const s = firmSess(J(HF.layout));
    expect(rowsOf(viewKeys(s, MT)).map((r) => r.length)).toEqual([4, 4, 4, 4, 3, 4, 1]);   // the historic More grid
    expect(s.add(MT, 'firm:clio-code')).toBe(true);
    let at = viewKeys(s, MT).indexOf('firm:clio-code');
    expect(at).toBe(viewKeys(s, MT).length - 1);                                           // added at the end, beside YisrAI
    // up past YisrAI, its break, row 6 (four tiles), and the break above it → the end of row 5
    for (let n = 0; n < 7; n++) { expect(s.move(MT, at, -1)).toBe(true); at--; }
    const doc = J(s.doc());
    const rows = rowsOf(listed(doc, MT));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(rows[4]).toEqual(['moreAvailability', 'moreBooking', 'moreCourtPreview', 'firm:clio-code']);
    expect(rows[6]).toEqual(['moreAssistant']);
    expect(listed(doc, MT)).toEqual(viewKeys(s, MT));
    expect([doc.placed, doc.removed, doc.pages['firm:more'].icons, doc.pages['firm:admin']]).toEqual([HF.layout.placed, HF.layout.removed, HF.layout.pages['firm:more'].icons, HF.layout.pages['firm:admin']]);
    expect(firmValid(doc)).toEqual({ ok: true, errors: [], same: true });
    expect(s.isDirty()).toBe(true);
  });

  test('a feature the firm hid is not offered, and a placement of it on a page is carried through an edit (it comes back where it was)', () => {
    const cat = J(VE.firmCatalog({ firm: { registry_overrides: { ...RO, hidden: ['moreVideoManager'] } } }));
    const s = VE.session({ stored: J(HF.layout), effective: cat.entries, locked: [], base: LAY, registry: REG, groups: cat.groups, surfaces: FIRM_SURFACES, pass: [], pages: cat.pages });
    expect(viewKeys(s, MT)).not.toContain('moreVideoManager');
    expect(J(s.candidates(MT, '')).flatMap((g) => g.items).map((c) => c.id)).not.toContain('moreVideoManager');
    expect(s.move(MT, 0, 1)).toBe(true);
    const placed = listed(J(s.doc()), MT);
    expect(placed.indexOf('moreVideoManager')).toBe(placed.indexOf('moreAssetManager') + 1);
  });

  test('breaks on Home and a page\'s tiles only; icon rows hold items, at most 12; labels on the sidebar only', () => {
    const s = firmSess(J(HF.layout));
    for (const sf of ['home', MT, AT]) expect([sf, s.addBreak(sf)]).toEqual([sf, true]);
    for (const sf of ['sidebar', 'homeIcons', MI, AI]) expect([sf, s.addBreak(sf)]).toEqual([sf, false]);
    expect(s.addBreak()).toBe(true);                                                       // no surface = Home (the personal editor's call)
    expect(s.addLabel('Billing')).toBe(true);
    // fill More Features' icon row to the cap
    const free = CAT.entries.map((e) => e.id).filter((id) => !viewKeys(s, MI).includes(id) && !CAT.pages.includes(id));
    let n = viewKeys(s, MI).length;
    for (const id of free) { if (n >= 12) break; expect(s.add(MI, id)).toBe(true); n++; }
    expect([viewKeys(s, MI).length, s.room(MI)]).toEqual([12, 0]);
    expect(s.add(MI, free[free.length - 1])).toBe(false);
    expect(s.room(MT)).toBeGreaterThan(50);
    const doc = J(s.doc());
    expect(doc.pages['firm:more'].icons.every((e) => Object.keys(e).join() === 'item')).toBe(true);
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

  test('hide / show / reset per surface; the other surfaces and the pages are written exactly as stored', () => {
    const stored = { placed: { home: [{ item: 'comms' }, { break: true }, { item: 'cases' }] }, removed: { sidebar: ['log'] }, pages: { 'firm:more': { icons: [{ item: 'myTasks' }, { item: 'casey' }] } } };
    const s = firmSess(stored);
    expect(s.isDirty()).toBe(false);
    const i = viewKeys(s, 'sidebar').indexOf('cases');
    expect(s.hide('sidebar', i)).toBe(true);
    expect(J(s.hidden('sidebar')).map((h) => h.id).sort()).toEqual(['cases', 'log']);
    expect(s.reset('home')).toBe(true);
    const doc = J(s.doc());
    expect(doc.removed.sidebar.sort()).toEqual(['cases', 'log']);
    expect(doc.placed.home).toBeUndefined();                                               // reset: both keys gone
    expect(doc.pages).toEqual(stored.pages);                                               // untouched: as stored
    expect(firmValid(doc).ok).toBe(true);
    expect(s.show('sidebar', 'cases')).toBe(true);
    expect(J(s.doc()).removed.sidebar).toEqual(['log']);
    // a page has no hide and no reset (S6c-5): the firm takes a tile off with remove
    expect([s.hide(MT, 0), s.reset(MT)]).toEqual([false, false]);
  });

  test('FUZZ: random edits over the three surfaces and both hub pages — every document validates unchanged (scope firm), and the renderer draws what the editor showed', () => {
    let seedN = 7;
    const rnd = (n) => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN % n; };
    const ops = ['move', 'hide', 'remove', 'add', 'break', 'label', 'reset', 'show'];
    const SFS = [...FIRM_SURFACES, ...PAGE_SFS];
    for (let run = 0; run < 60; run++) {
      const s = firmSess(run % 3 === 0 ? J(HF.layout) : run % 3 === 1 ? { placed: { home: [{ item: 'moreReports' }] }, removed: { sidebar: ['log'] } } : null);
      for (let step = 0; step < 25; step++) {
        const sf = SFS[rnd(SFS.length)];
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
      for (const sf of FIRM_SURFACES) expect([run, sf, viewKeys(s, sf)]).toEqual([run, sf, drawn(sf, doc)]);
      for (const sf of PAGE_SFS) expect([run, sf, viewKeys(s, sf)]).toEqual([run, sf, listed(doc, sf)]);
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
  const tabs = new Set(['tabHome', 'tabAll', 'tabSettings']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabAll'].includes(t))
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
    <div id="ycPages"></div>
    <div id="ycPanels" style="display:none">${stageHtml(REG)}</div>
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
  // what a firm page's grid shows, in order: tile labels / '|' — visible tiles only (More Features = firm:more, C4)
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const pageOf = (id) => d.querySelector(`#ycPages > [data-yc-page="${id}"]`);
  const grid = (pageId) => {
    const out = [];
    let brs = 0;
    const t = pageOf(pageId);
    for (let n = t.querySelector('h1').nextElementSibling; n && !/-egg-row$/.test(n.className); n = n.nextElementSibling) {
      if (n.tagName === 'BR') { if (++brs === 2) { out.push('|'); brs = 0; } continue; }
      brs = 0;
      if (n.classList.contains('big-button') && shown(n)) out.push(n.textContent.trim());
    }
    return out;
  };
  return { w, d, L, store, api, errors, toasts, asked, answer: (v) => { answer = v; }, flush, panel, sec, names, rowNamed, click, tab, save, grid, pageOf, close: () => w.close() };
}
const firmOpen = async (t, o = {}) => { const ok = await t.w.ycLayoutEditor.open({ scope: 'firm', ...o }); await t.flush(); return ok; };
// the firm's documents, saved through the real service: its items + More Features and Admin as pages (hubFirm, C4);
// layout:false leaves the layout document unwritten (History builds its own versions)
const seedClio = async (store, { layout = true } = {}) => {
  const svc = require('../services/uiConfigService');
  const f = hubFirm({ items: [CLIO, PAYROLL], ro: { locked: ['bills'] } });
  await svc.write(store.db, { scope: 'firm', config_key: 'registry_overrides', config: f.registry_overrides }, ADMIN);
  if (layout) await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: f.layout }, ADMIN);
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

  test('opens on three tabs (Home, Sidebar, Firm pages — the More and Admin panes retired in launcher-nits C4); Home\'s and the sidebar\'s sections, then each hub page\'s two; More Features lists its grid, no firm row; All is "Always here"; nothing to save', async () => {
    t = await boot({ store: await seedClio(makeStore()) });
    expect(await firmOpen(t)).toBe(true);
    expect(t.panel().getAttribute('data-scope')).toBe('firm');
    expect(t.d.getElementById('yleTitle').textContent.trim()).toBe('Arrange pages and defaults for everyone');
    expect([...t.panel().querySelectorAll('.yle-tab')].map((b) => b.getAttribute('data-pane'))).toEqual(['home', 'sidebar', 'pages']);
    expect([...t.panel().querySelectorAll('.yle-sec')].map((s) => s.getAttribute('data-sf'))).toEqual(['home', 'homeIcons', 'sidebar', MT, MI, AT, AI]);
    expect([...t.panel().querySelectorAll('#ylePane_pages .yle-page-title')].map((h) => h.textContent.trim())).toEqual(['More Features', 'Admin']);
    expect(t.panel().querySelector('#ylePane_home').hidden).toBe(false);
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(true);
    const bills = t.rowNamed('home', 'Billing');
    expect(bills.querySelector('.yle-tag').textContent.trim()).toBe('Locked for users');
    expect(bills.querySelector('[data-act="hide"]').disabled).toBe(false);
    const more = t.names(MT);
    expect(rowsOf(more).map((r) => r.length)).toEqual([4, 4, 4, 4, 3, 4, 1]);           // the More grid as it was
    expect(more).not.toContain('Get Clio Code');                                          // no seeded firm row (C4)
    expect(more).not.toContain('Payroll');
    expect(t.names(MI)).toEqual(['Casey']);
    expect(t.names(AI)).toEqual([]);
    const all = t.rowNamed('homeIcons', 'All');
    expect(all.querySelector('.yle-tag').textContent).toBe('Always here');
    expect(all.querySelector('[data-act="hide"]').disabled).toBe(true);
    expect(t.sec('homeIcons').querySelector('[data-act="add-break"]')).toBe(null);
    expect(t.sec(MT).querySelector('[data-act="add-break"]')).not.toBe(null);
    expect(t.sec(MI).querySelector('[data-act="add-break"]')).toBe(null);
    expect(t.sec('sidebar').querySelector('[data-act="label-open"]')).not.toBe(null);
    expect(t.panel().querySelector('.yle-save').disabled).toBe(true);
    // the personal editor's own tabs are not in this panel
    expect(t.panel().querySelector('.ysc-sec, .ymb-sec')).toBe(null);
  });

  test('Fred\'s scenario by clicks on the More Features page: Get Clio Code added, moved into row 5, YisrAI alone → ONE PUT with the base → stored, versioned, and the shell repaints with no reload', async () => {
    const store = await seedClio(makeStore());
    t = await boot({ store });
    expect(t.grid('firm:more')).not.toContain('Get Clio Code');
    await firmOpen(t, { section: 'pages', page: 'firm:more' });
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(false);
    t.click(t.sec(MT).querySelector('[data-act="pick"]'));
    t.click(t.sec(MT).querySelector('.yle-pick-item[data-id="firm:clio-code"]'));
    expect(t.names(MT).slice(-2)).toEqual(['Ask Casey', 'Get Clio Code']);
    for (let n = 0; n < 7; n++) t.click(t.rowNamed(MT, 'Get Clio Code').querySelector('[data-act="up"]'));
    expect(t.panel().querySelector('.yle-tab[data-pane="pages"] .yle-tab-dot').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-tab[data-pane="home"] .yle-tab-dot').hidden).toBe(true);
    const other = store.apiFor(ADMIN);
    const head = (await other('/api/ui-config', 'GET')).firm_versions.layout;
    const seeded = J(store.doc('firm', 0, 'layout'));
    await t.save();
    const puts = t.api.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect([puts[0].body.scope, puts[0].body.config_key, puts[0].body.base]).toEqual(['firm', 'layout', head]);
    const stored = t.store.doc('firm', 0, 'layout');
    expect([stored.placed, stored.removed, stored.pages['firm:admin'], stored.pages['firm:more'].icons]).toEqual([seeded.placed, seeded.removed, seeded.pages['firm:admin'], seeded.pages['firm:more'].icons]);
    expect(rowsOfGrid(stored.pages['firm:more'].tiles.map((e) => (e.break ? '|' : e.item)))).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(t.store.versions.filter((v) => v.config_key === 'layout')).toHaveLength(2);
    expect(t.w.firmData.ui.firm.layout).toEqual(stored);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    const g = t.grid('firm:more');
    expect(rowsOf(g).map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
    expect(rowsOf(g)[4][3]).toBe('Get Clio Code');
    expect(rowsOf(g)[6]).toEqual(['Ask Casey']);
    expect(g).not.toContain('Payroll');
    expect(t.toasts.slice(-1)).toEqual(['Saved — everyone gets the new arrangement as they load YisraCase']);
    // a second save sends the version it now holds as its base
    const head2 = (await other('/api/ui-config', 'GET')).firm_versions.layout;
    expect(head2).not.toBe(head);
    await firmOpen(t, { section: 'pages', page: 'firm:more' });
    t.click(t.rowNamed(MT, 'Get Clio Code').querySelector('[data-act="up"]'));
    await t.save();
    const put2 = t.api.calls.filter((c) => c.method === 'PUT')[1];
    expect(put2.body.base).toBe(head2);
    expect(t.store.versions.filter((v) => v.config_key === 'layout')).toHaveLength(3);
  });

  test('a second session saved first → 409: nothing saved, every edit kept, Reload discards them for the firm\'s arrangement', async () => {
    const store = await seedClio(makeStore());
    t = await boot({ store });
    await firmOpen(t, { section: 'pages', page: 'firm:admin' });
    t.click(t.rowNamed(AT, 'Etch').querySelector('[data-act="up"]'));
    // another admin, another tab: saves the firm's layout behind this panel's back (More Features' small buttons)
    const other = store.apiFor(ADMIN);
    const got = await other('/api/ui-config', 'GET');
    const theirs = J(got.firm.layout);
    theirs.pages['firm:more'].icons = [{ item: 'myTasks' }, { item: 'casey' }];
    await other('/api/ui-config', 'PUT', { scope: 'firm', config_key: 'layout', config: theirs, base: got.firm_versions.layout });
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
    expect(t.names(MI)).toEqual(['My Tasks', 'Casey']);
    expect(t.panel().querySelector('.yle-conflict').hidden).toBe(true);
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(false);                 // the tab it was on
    expect(t.w.firmData.ui.firm.layout).toEqual(store.doc('firm', 0, 'layout'));          // the shell caught up
    // and a save now goes through with the new base
    t.click(t.rowNamed(AT, 'Etch').querySelector('[data-act="up"]'));
    await t.save();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    const admin = store.doc('firm', 0, 'layout').pages['firm:admin'].tiles.map((e) => e.item);
    expect(admin.indexOf('adminEtch')).toBe(admin.indexOf('adminTools') - 1);              // Etch moved up past Tools
    expect(store.doc('firm', 0, 'layout').pages['firm:more'].icons).toEqual([{ item: 'myTasks' }, { item: 'casey' }]);   // theirs kept
  });

  test('a refusal: 400 errors under their section (its tab shown); 403 the session message; edits kept either way', async () => {
    t = await boot({ store: await seedClio(makeStore()) });
    await firmOpen(t);
    t.click(t.rowNamed(AT, 'Etch').querySelector('[data-act="up"]'));
    const real = t.w.apiSend;
    t.w.apiSend = (url, method, body) => (method === 'PUT'
      ? Promise.reject(Object.assign(new Error('refused'), { status: 400, body: { status: 'error', errors: ['pages.firm:admin.icons: at most 12 entries', 'something general'] } }))
      : real(url, method, body));
    await t.save();
    const errs = t.sec(AI).querySelector('.yle-errs');
    expect([errs.hidden, errs.textContent]).toEqual([false, 'pages.firm:admin.icons: at most 12 entries']);
    expect(t.panel().querySelector('#ylePane_pages').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('The server refused the save. something general Your changes are still here.');
    t.w.apiSend = (url, method, body) => (method === 'PUT' ? Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 })) : real(url, method, body));
    await t.save();
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('Your session predates a permissions change — sign out and back in.');
    expect(t.w.ycLayoutEditor.isDirty()).toBe(true);
  });

  test('reset per surface asks, then deletes that surface\'s keys only; leaving with changes asks', async () => {
    const store = makeStore();
    await require('../services/uiConfigService').write(store.db, { scope: 'firm', config_key: 'layout', config: { placed: { home: [{ item: 'comms' }, { item: 'cases' }] }, removed: { sidebar: ['log'] } } }, ADMIN);
    t = await boot({ store });
    await firmOpen(t, { section: 'home' });
    t.click(t.sec('home').querySelector('[data-act="reset"]'));
    await t.flush();
    expect(t.asked.slice(-1)).toEqual(['Reset Home to the app’s standard layout? The firm’s arrangement of it is replaced when you Save.']);
    await t.save();
    expect(store.doc('firm', 0, 'layout')).toEqual({ placed: {}, removed: { sidebar: ['log'] } });
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
// two firm layouts over the firm's pages (C4): A puts Reports | Get Clio Code on More Features and hides Log from the
// sidebar; B gives More Features only small buttons
const LAYOUT_A = { placed: {}, removed: { sidebar: ['log'] }, pages: { 'firm:more': { tiles: [{ item: 'moreReports' }, { break: true }, { item: 'firm:clio-code' }] } } };
const LAYOUT_B = { placed: {}, removed: {}, pages: { 'firm:more': { icons: [{ item: 'myTasks' }, { item: 'casey' }] } } };

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
    const store = await seedClio(makeStore(), { layout: false });
    const svc = require('../services/uiConfigService');
    const v1 = await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: LAYOUT_A }, ADMIN);
    await svc.write(store.db, { scope: 'firm', config_key: 'layout', config: LAYOUT_B, base: v1.version_id }, ADMIN);
    t = await bootFirmPage({ store });
    expect(t.grid('firm:more')).toEqual([]);                                                 // B gives More Features no tiles
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
      .toBe('Sidebarhidden: LogPage “More Features”Row 1: Reports; Row 2: Get Clio Code');
    t.firm.confirm = () => true;
    t.fire(rows[1].querySelector('[data-ver-act="restore"]'));
    await t.flush(); await t.flush();
    const restore = t.api.calls.filter((c) => c.method === 'POST');
    expect(restore.map((c) => [c.url, c.body])).toEqual([[`/api/ui-config/versions/${v1.version_id}/restore`, { base: v1.version_id + 1 }]]);
    expect(store.doc('firm', 0, 'layout')).toEqual(LAYOUT_A);
    expect(t.w.firmData.ui.firm.layout).toEqual(LAYOUT_A);
    // the shell repainted: A's More Features page (Get Clio Code a tile there, Payroll not)
    expect(t.grid('firm:more')).toEqual(['Reports', '|', 'Get Clio Code']);
    expect(t.grid('firm:more')).not.toContain('Payroll');
    const after = t.$$('.fm-ver');
    expect(after).toHaveLength(3);
    expect(after[0].querySelector('.fm-badge').textContent).toBe('current');
  });

  test('a layout restore after someone saved since the list loaded → 409, nothing written', async () => {
    const store = await seedClio(makeStore(), { layout: false });
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

  test('layoutParts: one line per arranged surface and page — rows at the breaks, the sidebar under its headings, what it hides; a pre-C4 version\'s hub lists still read; nothing arranged says so', async () => {
    t = await bootFirmPage();
    const lp = (doc) => J(t.F.layoutParts(doc, (id) => id.toUpperCase()));
    expect(lp({ placed: { sidebar: [{ item: 'a' }, { label: 'Records' }, { item: 'b' }, { item: 'c' }, { label: 'Empty' }], home: [{ item: 'x' }, { item: 'y' }],
      moreIcons: [{ item: 'casey' }] }, removed: { home: ['z'], adminIcons: ['q'] } }))
      .toEqual([['Home', 'X, Y · hidden: Z'], ['Sidebar', 'A; Records: B, C; Empty: —'], ['More Features’ small buttons', 'CASEY'], ['Admin’s small buttons', 'hidden: Q']]);
    // a version saved before launcher-nits C4 still holds the hubs' lists: History names them
    expect(lp({ placed: { more: [] }, removed: {} })).toEqual([['More Features', 'nothing']]);
    expect(lp({ pages: { 'firm:more': { tiles: [{ item: 'a' }, { break: true }, { item: 'b' }], icons: [{ item: 'c' }] } } })).toEqual([['Page “FIRM:MORE”', 'Row 1: A; Row 2: B · small buttons: C']]);
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
